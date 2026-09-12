package compare

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestCompareReconstructsSourcesAndTracksPositions(t *testing.T) {
	tests := []struct {
		name, before, after string
		wantKinds           []RowKind
	}{
		{"unchanged", "alpha\nbeta\n", "alpha\nbeta\n", []RowKind{Context, Context}},
		{"pure insert", "alpha\n", "alpha\nbeta\n", []RowKind{Context, Addition}},
		{"pure delete", "alpha\nbeta\n", "alpha\n", []RowKind{Context, Removal}},
		{"indentation", "\tkey: value\n", "  key: value\n", []RowKind{Removal, Addition}},
		{"trailing newline", "alpha", "alpha\n", []RowKind{Removal, Addition}},
		{"unicode", "label: café\n", "label: καφές\n", []RowKind{Removal, Addition}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rows := Compare(tt.before, tt.after)
			if len(rows) != len(tt.wantKinds) {
				t.Fatalf("rows = %#v, want %d", rows, len(tt.wantKinds))
			}
			for i, want := range tt.wantKinds {
				if rows[i].Kind != want {
					t.Errorf("row %d kind = %q, want %q", i, rows[i].Kind, want)
				}
			}
			assertReconstruction(t, tt.before, tt.after, rows)
			assertSequentialPositions(t, rows)
			assertRuneBoundaries(t, rows)
			if tt.name == "unchanged" {
				for _, row := range rows {
					if row.Emphasis.WholeLine || len(row.Emphasis.Spans) != 0 {
						t.Fatalf("unchanged row has emphasis: %#v", row)
					}
				}
			}
		})
	}
}

func TestCompareMarksGuidedEmphasis(t *testing.T) {
	tests := []struct {
		name, before, after  string
		wantKind             RowKind
		wantText             string
		wantSpan             string
		wantWhole, wantBlank bool
	}{
		{"identifier replacement", "    - restart_web\n", "    - restart-web\n", Addition, "    - restart-web\n", "restart-web", false, false},
		{"unicode replacement", "name: café\n", "name: 茶店\n", Addition, "name: 茶店\n", "茶店", false, false},
		{"removed word", "mode: fast safe\n", "mode: safe\n", Removal, "mode: fast safe\n", "fast ", false, false},
		{"whitespace only", "\tkey: value\n", "  key: value\n", Addition, "  key: value\n", "", true, false},
		{"blank insertion", "first\nsecond\n", "first\n\nsecond\n", Addition, "\n", "", true, true},
		{"pure line deletion", "first\nsecond\n", "second\n", Removal, "first\n", "", true, false},
		{"structural replacement", "one\ntwo\n", "first\nsecond\nthird\n", Addition, "first\n", "", true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rows := Compare(tt.before, tt.after)
			row := findRow(t, rows, tt.wantKind, tt.wantText)
			if row.Emphasis.WholeLine != tt.wantWhole || row.BlankLine != tt.wantBlank {
				t.Fatalf("emphasis = %#v, blank = %v", row.Emphasis, row.BlankLine)
			}
			if tt.wantSpan != "" {
				if got := emphasizedText(row); got != tt.wantSpan {
					t.Fatalf("emphasized text = %q, want %q", got, tt.wantSpan)
				}
			}
			if tt.name == "identifier replacement" {
				removed := findRow(t, rows, Removal, tt.before)
				if removed.Emphasis.WholeLine || len(removed.Emphasis.Spans) != 0 {
					t.Fatalf("ordinary replacement emphasizes removal: %#v", removed)
				}
			}
			assertRuneBoundaries(t, rows)
		})
	}
}

func TestCompareActualDemoChanges(t *testing.T) {
	report, err := Demo()
	if err != nil {
		t.Fatal(err)
	}
	wants := []struct {
		kind                  RowKind
		text                  string
		beforeLine, afterLine int
		span                  string
		whole, blank          bool
	}{
		{Addition, "  when:\n", 0, 102, "", true, false},
		{Addition, "    - restart-web\n", 0, 148, "restart-web", false, false},
		{Addition, "\n", 0, 10, "", true, true},
	}
	for i, want := range wants {
		row := findRow(t, report.Findings[i].Diff, want.kind, want.text)
		if row.BeforeLine != want.beforeLine || row.AfterLine != want.afterLine || row.Emphasis.WholeLine != want.whole || row.BlankLine != want.blank {
			t.Errorf("finding %d row = %#v", i, row)
		}
		if want.span != "" && emphasizedText(row) != want.span {
			t.Errorf("finding %d emphasis = %q, want %q", i, emphasizedText(row), want.span)
		}
	}
}

func TestCompareTracksSourcePositionsAcrossDecimalBoundaries(t *testing.T) {
	for _, boundary := range []int{10, 100, 1000} {
		beforeLines := make([]string, boundary+1)
		for i := range beforeLines {
			beforeLines[i] = "same\n"
		}
		afterLines := append([]string(nil), beforeLines...)
		afterLines[boundary-1] = "changed\n"
		rows := Compare(strings.Join(beforeLines, ""), strings.Join(afterLines, ""))
		removed := findRow(t, rows, Removal, "same\n")
		added := findRow(t, rows, Addition, "changed\n")
		if removed.BeforeLine != boundary || added.AfterLine != boundary {
			t.Errorf("boundary %d positions = before %d, after %d", boundary, removed.BeforeLine, added.AfterLine)
		}
		assertSequentialPositions(t, rows)
	}
}

func assertReconstruction(t *testing.T, before, after string, rows []DiffRow) {
	t.Helper()
	var gotBefore, gotAfter strings.Builder
	for _, row := range rows {
		if row.Kind != Addition {
			gotBefore.WriteString(row.Text)
		}
		if row.Kind != Removal {
			gotAfter.WriteString(row.Text)
		}
	}
	if gotBefore.String() != before || gotAfter.String() != after {
		t.Fatalf("reconstruction = %q / %q, want %q / %q", gotBefore.String(), gotAfter.String(), before, after)
	}
}

func assertSequentialPositions(t *testing.T, rows []DiffRow) {
	t.Helper()
	before, after := 0, 0
	for _, row := range rows {
		if row.Kind != Addition {
			before++
			if row.BeforeLine != before {
				t.Fatalf("before position = %d, want %d", row.BeforeLine, before)
			}
		} else if row.BeforeLine != 0 {
			t.Fatalf("addition before position = %d, want 0", row.BeforeLine)
		}
		if row.Kind != Removal {
			after++
			if row.AfterLine != after {
				t.Fatalf("after position = %d, want %d", row.AfterLine, after)
			}
		} else if row.AfterLine != 0 {
			t.Fatalf("removal after position = %d, want 0", row.AfterLine)
		}
	}
}

func assertRuneBoundaries(t *testing.T, rows []DiffRow) {
	t.Helper()
	for _, row := range rows {
		for _, span := range row.Emphasis.Spans {
			if span.Start < 0 || span.End < span.Start || span.End > len(row.Text) || !utf8.ValidString(row.Text[:span.Start]) || !utf8.ValidString(row.Text[:span.End]) {
				t.Fatalf("span %#v splits rune in %q", span, row.Text)
			}
		}
	}
}

func findRow(t *testing.T, rows []DiffRow, kind RowKind, text string) DiffRow {
	t.Helper()
	for _, row := range rows {
		if row.Kind == kind && row.Text == text {
			return row
		}
	}
	t.Fatalf("missing %q row %q in %#v", kind, text, rows)
	return DiffRow{}
}

func emphasizedText(row DiffRow) string {
	var value strings.Builder
	for _, span := range row.Emphasis.Spans {
		value.WriteString(row.Text[span.Start:span.End])
	}
	return value.String()
}
