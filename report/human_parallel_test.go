package report

import (
	"bytes"
	"reflect"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestHumanReportParallelFilesPreserveSequentialBytesAndChunks(t *testing.T) {
	for _, profile := range []ColorProfile{ColorNone, ColorTrueColor} {
		t.Run(profileName(profile), func(t *testing.T) {
			project, raw := humanStreamingFixture(t)
			records := diagnostics(project, raw)
			sequential := new(sectionWriter)
			if err := humanWithWorkerLimit(sequential, project, records, HumanOptions{Width: 80, Theme: ThemeDark, ColorProfile: profile, Context: t.Context()}, 1); err != nil {
				t.Fatal(err)
			}
			parallel := new(sectionWriter)
			if err := humanWithWorkerLimit(parallel, project, records, HumanOptions{Width: 80, Theme: ThemeDark, ColorProfile: profile, Context: t.Context()}, 2); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(parallel.bytes(), sequential.bytes()) {
				t.Fatal("parallel report bytes differ from sequential report")
			}
			if !reflect.DeepEqual(parallel.writes, sequential.writes) {
				t.Fatal("parallel report changed complete finding chunk boundaries")
			}
		})
	}
}

func TestOriginalPrefixLineIncludesDistantPreviewAndFixEdits(t *testing.T) {
	data := []byte(strings.Repeat("# context\n", 60))
	source := &lint.Source{Path: "a.yml", Data: data}
	lines := splitSourceLines(data)
	previewStart := lines[49].start
	fixStart := lines[39].start
	group := diagnosticGroup{diagnostics: []Diagnostic{
		{
			Location: Location{Path: source.Path, Span: Span{Start: lines[0].start, End: lines[0].end}},
			preview:  &lint.Preview{Edits: []lint.Edit{{Span: lint.Span{Start: previewStart, End: previewStart}}}},
		},
		{
			Location: Location{Path: source.Path, Span: Span{Start: lines[1].start, End: lines[1].end}},
			Fix:      &Fix{Edits: []Edit{{Span: Span{Start: fixStart, End: fixStart}}}},
		},
	}}
	project := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	if got := originalPrefixLine(project, group); got != 53 {
		t.Fatalf("original prefix line = %d, want edit line 50 plus three context lines", got)
	}
}

func TestContiguousDiagnosticGroupsRejectRepeatedPath(t *testing.T) {
	records := []Diagnostic{{Location: Location{Path: "a.yml"}}, {Location: Location{Path: "b.yml"}}, {Location: Location{Path: "a.yml"}}}
	if groups, ok := contiguousDiagnosticGroups(records); ok || groups != nil {
		t.Fatalf("noncontiguous path grouped for parallel rendering: %+v", groups)
	}

	groups, ok := contiguousDiagnosticGroups([]Diagnostic{{Location: Location{Path: "b.yml"}}, {Location: Location{Path: "b.yml"}}, {Location: Location{Path: "a.yml"}}})
	if !ok || len(groups) != 2 || groups[0].start != 0 || len(groups[0].diagnostics) != 2 || groups[1].start != 2 {
		t.Fatalf("contiguous groups = %+v, ok %v", groups, ok)
	}
}

func TestParallelRenderLookaheadHasAnExplicitChunkBound(t *testing.T) {
	lookahead := humanFileLookahead(8, 100)
	if lookahead <= 8 {
		t.Fatalf("file lookahead = %d, want more than one active file per worker", lookahead)
	}
	if queued := lookahead * fileRenderChunkCapacity; queued > 128 {
		t.Fatalf("queued finding bound = %d, want at most 128", queued)
	}
	if got := humanFileLookahead(8, 12); got != 12 {
		t.Fatalf("lookahead for 12 files = %d, want 12", got)
	}
}

func profileName(profile ColorProfile) string {
	switch profile {
	case ColorTrueColor:
		return "truecolor"
	default:
		return "none"
	}
}
