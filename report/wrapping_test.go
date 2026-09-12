package report

import (
	"bytes"
	"fmt"
	charmansi "github.com/charmbracelet/x/ansi"
	"github.com/frostybee/nuri"
	"github.com/frostybee/nuri/theme"
	"github.com/saltyorg/saltbox-lint/lint"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

// Catches clipping, width caps, and dropped source in the user's real condition.
func TestHumanYYQWrapsWithoutLosingSource(t *testing.T) {
	data, err := os.ReadFile("../lint/testdata/presentation/yyq.yml")
	if err != nil {
		t.Fatal(err)
	}
	source, _ := lint.Parse("roles/yyq/tasks/main.yml", data)
	p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	original := strings.Split(string(data), "\n")[34]
	start := strings.Index(string(data), original) + 8
	d := lint.Diagnostic{Path: source.Path, RuleID: "condition", Severity: "error", Message: "condition", Span: lint.Span{Start: start, End: start + len(original) - 8}}
	for _, width := range []int{40, 80, 100, 160, 240} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			var out bytes.Buffer
			if err := Render(&out, p, []lint.Diagnostic{d}, Options{Human: HumanOptions{Width: width}}); err != nil {
				t.Fatal(err)
			}
			rows := strings.Split(out.String(), "\n")
			var recovered strings.Builder
			active := false
			count := 0
			for _, row := range rows {
				if strings.HasPrefix(row, "35 | ") {
					active = true
					recovered.WriteString(strings.TrimPrefix(row, "35 | "))
					count++
					continue
				}
				if active && strings.HasPrefix(row, "   ↪ ") {
					recovered.WriteString(strings.TrimPrefix(row, "   ↪ "))
					count++
					continue
				}
				if active && strings.Contains(row, " | ") && !strings.HasPrefix(row, "   | ") {
					active = false
				}
			}
			if recovered.String() != original {
				t.Fatalf("source lost: got %q want %q\n%s", recovered.String(), original, &out)
			}
			if width >= 160 && count != 1 {
				t.Fatalf("wide condition wrapped into %d rows", count)
			}
			if width <= 100 && count < 2 {
				t.Fatal("narrow condition did not wrap")
			}
			if !strings.Contains(out.String(), strings.Repeat("━", width)) {
				t.Fatal("file frame does not use full width")
			}
		})
	}
}

func TestHumanIncludesEveryChangedAndMarkedLine(t *testing.T) {
	var before, after strings.Builder
	for i := 1; i <= 70; i++ {
		fmt.Fprintf(&before, "key%d: old%d\n", i, i)
		fmt.Fprintf(&after, "key%d: new%d\n", i, i)
	}
	source, _ := lint.Parse("a.yml", []byte(before.String()))
	p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	for _, proposal := range []bool{false, true} {
		t.Run(fmt.Sprint(proposal), func(t *testing.T) {
			d := lint.Diagnostic{Path: source.Path, RuleID: "all", Message: "all", Span: lint.Span{End: before.Len() - 1}}
			if proposal {
				d.Preview = &lint.Preview{Edits: []lint.Edit{{Span: lint.Span{End: before.Len()}, Text: after.String()}}}
			}
			var out bytes.Buffer
			if err := Render(&out, p, []lint.Diagnostic{d}, Options{}); err != nil {
				t.Fatal(err)
			}
			for i := 1; i <= 70; i++ {
				if !strings.Contains(out.String(), fmt.Sprintf("key%d: old%d", i, i)) {
					t.Fatalf("missing changed/marked line %d", i)
				}
				if proposal && !strings.Contains(out.String(), fmt.Sprintf("key%d: new%d", i, i)) {
					t.Fatalf("missing addition %d", i)
				}
			}
			if strings.Contains(out.String(), "lines omitted") {
				t.Fatal("marked/changed rows omitted")
			}
		})
	}
}

func TestHumanLargeFindingStreamsBoundedFragments(t *testing.T) {
	data := strings.Repeat("# "+strings.Repeat("界", 40)+"\n", 2000)
	source, _ := lint.Parse("a.yml", []byte(data))
	p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	for _, profile := range []ColorProfile{ColorNone, ColorANSI, ColorANSI256, ColorTrueColor} {
		t.Run(fmt.Sprint(profile), func(t *testing.T) {
			out := new(sectionWriter)
			if err := Render(out, p, []lint.Diagnostic{{Path: source.Path, RuleID: "large", Message: "large", Span: lint.Span{End: len(data) - 1}}}, Options{Human: HumanOptions{ColorProfile: profile}}); err != nil {
				t.Fatal(err)
			}
			if len(out.writes) < 5 {
				t.Fatalf("large finding did not stream: %d writes", len(out.writes))
			}
			for _, p := range out.writes {
				if len(p) > 64*1024 {
					t.Fatalf("fragment = %d bytes", len(p))
				}
				if !utf8.Valid(p) {
					t.Fatal("split UTF8")
				}
			}
			plain := charmansi.Strip(string(out.bytes()))
			if strings.Count(plain, "# ") != 2000 {
				t.Fatalf("source rows missing: %d", strings.Count(plain, "# "))
			}
		})
	}
}

func TestVisualRowsPreserveWhitespaceGraphemesAndCaretIntersections(t *testing.T) {
	for _, test := range []struct {
		text, want string
		width      int
	}{
		{"  alpha beta  gamma ", "  alpha beta  gamma ", 9},
		{"\tX\tY", "    X   Y", 5},
		{"e\u0301👩‍💻界e\u0301", "e\u0301👩‍💻界e\u0301", 3},
		{"x\x1b[2Jy", "x\\x1b[2Jy", 7},
		{strings.Repeat("a", 300), strings.Repeat("a", 300), 2},
		{"", "", 2},
		{"\t", "    ", 2},
		{"\x1b", "\\x1b", 2},
	} {
		var recovered strings.Builder
		count := 0
		for row := range visualRows(sourceLine{text: test.text}, test.width) {
			if row.continuation != (count > 0) {
				t.Fatal("wrong continuation flag")
			}
			count++
			s := joinClusters(row.clusters)
			if charmansi.StringWidth(s) > test.width {
				t.Fatalf("source row too wide: %q at %d", s, test.width)
			}
			recovered.WriteString(s)
			if strings.HasPrefix(s, "\u0301") || strings.Contains(s, "👩") && !strings.Contains(s, "👩‍💻") {
				t.Fatal("split grapheme")
			}
		}
		if recovered.String() != test.want {
			t.Fatalf("reconstructed %q want %q", recovered.String(), test.want)
		}
	}
	line := sourceLine{text: "prefix 👩‍💻 end", end: len("prefix 👩‍💻 end")}
	marked, start, end := markerForLine(line, Span{Start: 8, End: 9})
	if !marked || start != 7 || end != 9 {
		t.Fatalf("partial emoji byte span marker = %t %d..%d, want 7..9", marked, start, end)
	}
}

func TestHumanVeryNarrowGuttersAndNumberTransitions(t *testing.T) {
	for _, number := range []int{9, 10, 99, 100, 999, 1000} {
		for _, width := range []int{2, 3, 4, 8, 16} {
			r, err := newHumanRenderer(&bytes.Buffer{}, nil, HumanOptions{Width: width, Context: t.Context()})
			if err != nil {
				t.Fatal(err)
			}
			var out strings.Builder
			r.comparisonLine(&out, sourceLine{text: "abcdef ghijkl", ending: "\r\n"}, nil, comparisonRow{old: number, kind: '-'}, len(fmt.Sprint(number)))
			r.close()
			for _, row := range strings.Split(out.String(), "\n") {
				if strings.HasSuffix(row, ":") {
					continue
				}
				if charmansi.StringWidth(row) > width {
					t.Fatalf("width %d, line %d: row too wide %q", width, number, row)
				}
			}
			if !strings.Contains(out.String(), "↪-") && !strings.Contains(out.String(), "↪ -") {
				t.Fatalf("continuation lost marker: %s", &out)
			}
		}
	}
}

func TestHumanYYQRealProposalWrapsWithoutLosingSource(t *testing.T) {
	data, err := os.ReadFile("../lint/testdata/presentation/yyq.yml")
	if err != nil {
		t.Fatal(err)
	}
	source, _ := lint.Parse("roles/yyq/tasks/main.yml", data)
	p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}, Selected: map[string]bool{source.Path: true}}
	var selected []lint.Diagnostic
	for _, rule := range lint.Rules() {
		if rule.ID == "ansible-when-parentheses" {
			for _, d := range lint.Analyze(p, []lint.Rule{rule}) {
				if location(p, d.Path, d.Span).Range.Start.Line == 35 {
					selected = append(selected, d)
				}
			}
		}
	}
	if len(selected) != 1 {
		t.Fatalf("wanted real yyq35 finding, got %v", selected)
	}
	original := "  when: (yyq_current_version is version(yyq_install_version, 'lt', version_type='semver')) or (not yyq_binary.stat.exists)"
	suggested := "  when: ((yyq_current_version is version(yyq_install_version, 'lt', version_type='semver')) or (not yyq_binary.stat.exists))"
	for _, width := range []int{40, 80, 100, 160, 240} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			var out bytes.Buffer
			if err := Render(&out, p, selected, Options{Human: HumanOptions{Width: width}}); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "roles/yyq/tasks/main.yml:35:9") {
				t.Fatal("real diagnostic location changed")
			}
			for _, test := range []struct{ kind, want string }{{"-", original}, {"+", suggested}} {
				var recovered strings.Builder
				active := false
				count := 0
				for _, row := range strings.Split(out.String(), "\n") {
					if strings.Contains(row, "│ "+test.kind+" ") {
						active = true
						_, text, _ := strings.Cut(row, "│ "+test.kind+" ")
						recovered.WriteString(text)
						count++
						continue
					}
					if active && strings.Contains(row, "↪ "+test.kind+" ") {
						gutter, text, _ := strings.Cut(row, "↪ "+test.kind+" ")
						if strings.TrimSpace(gutter) != "" {
							t.Fatalf("continuation repeats source number: %q", row)
						}
						recovered.WriteString(text)
						count++
						continue
					}
					if active && strings.Contains(row, "│") {
						active = false
					}
				}
				if recovered.String() != test.want {
					t.Fatalf("%s source lost: %q want %q\n%s", test.kind, recovered.String(), test.want, &out)
				}
				if width >= 160 && count != 1 {
					t.Fatalf("wide %s line wrapped", test.kind)
				}
			}
		})
	}
}

func TestWrappedRowsRetainTokenRGBAndFonts(t *testing.T) {
	text := "    e\u0301👩‍💻 abcdef ghijkl"
	tokens := &nuri.TokensResult{Tokens: [][]nuri.ThemedToken{{{Content: text, Color: "#123456", BgColor: "#654321", FontStyle: theme.FontStyleBold | theme.FontStyleItalic | theme.FontStyleUnderline | theme.FontStyleStrikethrough}}}}
	r, err := newHumanRenderer(&bytes.Buffer{}, nil, HumanOptions{ColorProfile: ColorTrueColor, Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()
	for row := range visualRows(sourceLine{text: text}, 7) {
		got := r.codeRow(row, tokens, 1, ' ', 7)
		for _, want := range []string{"38;2;18;52;86", "48;2;101;67;33", "1;3;4;9"} {
			if !strings.Contains(got, want) {
				t.Fatalf("wrapped row lost %s: %q", want, got)
			}
		}
		if charmansi.Strip(got) != joinClusters(row.clusters) {
			t.Fatal("styling changed source text")
		}
	}
}

func TestHumanFramesFilesAndSeparatesRelatedExcerpts(t *testing.T) {
	p, ds := humanStreamingFixture(t)
	ds[0].Related = append(ds[0].Related, ds[0].Related[0])
	var out bytes.Buffer
	if err := Render(&out, p, ds, Options{Human: HumanOptions{Width: 80}}); err != nil {
		t.Fatal(err)
	}
	text := out.String()
	if strings.Count(text, strings.Repeat("━", 80)) != 4 || strings.Count(text, strings.Repeat("─", 80)) != 1 {
		t.Fatalf("file and within-file boundaries not distinct:\n%s", text)
	}
	relatedCount := 0
	rows := strings.Split(text, "\n")
	for i, row := range rows {
		if strings.HasPrefix(row, "Fix:") || strings.HasPrefix(row, "Fix available:") {
			if i == 0 || rows[i-1] != "" {
				t.Fatalf("fix guidance lacks blank separation: %q", row)
			}
		}
		if strings.HasPrefix(row, "  roles/demo/defaults/main.yml:") {
			relatedCount++
			if relatedCount > 1 && rows[i-1] != "" {
				t.Fatal("following related explanation lacks blank after code")
			}
		}
	}
}

func TestHumanComparisonLabelsUnchangedGap(t *testing.T) {
	data := "value: old\n" + strings.Repeat("# unchanged\n", 19) + "final: old\n"
	source, _ := lint.Parse("a.yml", []byte(data))
	p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	first, last := strings.Index(data, "old"), strings.LastIndex(data, "old")
	d := lint.Diagnostic{Path: source.Path, RuleID: "gap", Message: "gap", Span: lint.Span{Start: first, End: first + 3}, Preview: &lint.Preview{Edits: []lint.Edit{{Span: lint.Span{Start: first, End: first + 3}, Text: "new"}, {Span: lint.Span{Start: last, End: last + 3}, Text: "new"}}}}
	var out bytes.Buffer
	if err := Render(&out, p, []lint.Diagnostic{d}, Options{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "… 15 unchanged lines omitted …") || strings.Count(out.String(), "# unchanged") != 4 {
		t.Fatalf("wrong context gap:\n%s", &out)
	}
}
