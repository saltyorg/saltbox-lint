package report

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func sample() (*lint.Project, []lint.Diagnostic) {
	s, _ := lint.Parse("a.yml", []byte("v: '😀x'\nnext: true\n"))
	return &lint.Project{Root: "/work/nested", Sources: map[string]*lint.Source{"a.yml": s}}, []lint.Diagnostic{{Path: "a.yml", RuleID: "example-rule", Severity: "error", Message: "bad value", Expected: "Use true.", Span: lint.Span{Start: 8, End: 9}, Related: []lint.RelatedLocation{{Path: "a.yml", Message: "context", Span: lint.Span{Start: 11, End: 15}}}, Fix: &lint.Fix{Message: "replace", Edits: []lint.Edit{{Span: lint.Span{Start: 8, End: 9}, Text: "y"}}}}}
}

func TestRenderersShareFindings(t *testing.T) {
	p, ds := sample()
	for _, format := range []string{"human", "concise", "json", "github"} {
		t.Run(format, func(t *testing.T) {
			var out bytes.Buffer
			if err := Render(&out, p, ds, Options{Format: format}); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "example-rule") || !strings.Contains(out.String(), "bad value") {
				t.Fatalf("%s", &out)
			}
			switch format {
			case "human":
				if !strings.Contains(out.String(), "😀x") || !strings.Contains(out.String(), "Expected: Use true.") || !strings.Contains(out.String(), "context") {
					t.Fatal(out.String())
				}
			case "concise":
				if out.String() != "a.yml:1:7: error [example-rule] bad value\n" {
					t.Fatal(out.String())
				}
			case "json":
				var got map[string]json.RawMessage
				if err := json.Unmarshal(out.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				var records []map[string]json.RawMessage
				if err := json.Unmarshal(got["diagnostics"], &records); err != nil {
					t.Fatal(err)
				}
				if len(records) != 1 || string(records[0]["range"]) != "{\"start\":{\"line\":1,\"column\":6},\"end\":{\"line\":1,\"column\":7}}" || string(records[0]["span"]) != "{\"start\":8,\"end\":9}" || records[0]["fix"] == nil || records[0]["related"] == nil {
					t.Fatal(out.String())
				}
			case "github":
				if !strings.Contains(out.String(), "line=1,col=6,endLine=1,endColumn=6") {
					t.Fatal(out.String())
				}
			}
		})
	}
}

func TestGitHubEscapesPathsMessagesAndSummary(t *testing.T) {
	p, ds := sample()
	s := p.Sources["a.yml"]
	ds[0].Path = "a%,:\r\n😀.yml"
	s.Path = ds[0].Path
	p.Sources = map[string]*lint.Source{s.Path: s}
	ds[0].Message = "bad %\r\n::warning:: <script>|[link](x)"
	ds[0].Expected = "<b>fix</b>"
	var out, summary bytes.Buffer
	err := Render(&out, p, ds, Options{Format: "github", Summary: &summary, GitHub: GitHub{Workspace: "/work", Repository: "org/repo", Commit: "abc123", ServerURL: "https://github.example"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "file=nested/a%25%2C%3A%0D%0A😀.yml") || !strings.Contains(out.String(), "bad %25%0D%0A::warning::") {
		t.Fatal(out.String())
	}
	if strings.Count(out.String(), "\n") != 1 {
		t.Fatalf("command injection: %q", out.String())
	}
	if strings.Contains(summary.String(), "<script>") || strings.Contains(summary.String(), "[link](x)") || !strings.Contains(summary.String(), "https://github.example/org/repo/blob/abc123/a%25%2C:%0D%0A%F0%9F%98%80.yml#L1") {
		t.Fatal(summary.String())
	}
}

func TestGitHubSummaryBoundedAndClean(t *testing.T) {
	p, ds := sample()
	var out, summary bytes.Buffer
	if err := Render(&out, p, nil, Options{Format: "github", Summary: &summary}); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 || !strings.Contains(summary.String(), "No findings") {
		t.Fatalf("%q %q", &out, &summary)
	}
	ds[0].Message = strings.Repeat("<huge>", 20000)
	for range 200 {
		ds = append(ds, ds[0])
	}
	summary.Reset()
	if err := Render(&out, p, ds, Options{Format: "github", Summary: &summary}); err != nil {
		t.Fatal(err)
	}
	if summary.Len() > 65536 || !strings.Contains(summary.String(), "omitted") {
		t.Fatalf("summary bytes=%d", summary.Len())
	}
}

type brokenWriter struct{}

func (brokenWriter) Write([]byte) (int, error) { return 0, errors.New("broken output") }
func TestOutputErrorsPropagate(t *testing.T) {
	p, ds := sample()
	for _, format := range []string{"human", "concise", "json", "github"} {
		if err := Render(brokenWriter{}, p, ds, Options{Format: format}); err == nil {
			t.Errorf("%s ignored error", format)
		}
	}
	if err := Render(&bytes.Buffer{}, p, nil, Options{Format: "github", Summary: brokenWriter{}}); err == nil {
		t.Fatal("summary failure ignored")
	}
}

func TestUnifiedDiffPreservesMissingNewline(t *testing.T) {
	var out bytes.Buffer
	if err := Diff(&out, []lint.Change{{Path: "a.yml", Before: []byte("v: old"), After: []byte("v: new\n")}}); err != nil {
		t.Fatal(err)
	}
	want := "--- a/a.yml\n+++ b/a.yml\n@@ -1,1 +1,1 @@\n-v: old\n\\ No newline at end of file\n+v: new\n"
	if out.String() != want {
		t.Fatalf("%q", out.String())
	}
}

func TestRangesKeepHalfOpenOffsetsAndInclusiveGitHubEnds(t *testing.T) {
	p, ds := sample()
	cases := []struct {
		name       string
		span       lint.Span
		annotation string
		jsonRange  string
	}{
		{"non BMP token", lint.Span{Start: 4, End: 8}, "line=1,col=5,endLine=1,endColumn=5", `"range":{"start":{"line":1,"column":5},"end":{"line":1,"column":6}}`},
		{"multiline", lint.Span{Start: 8, End: 15}, "line=1,col=6,endLine=2,endColumn=4", `"range":{"start":{"line":1,"column":6},"end":{"line":2,"column":5}}`},
		{"insertion", lint.Span{Start: 8, End: 8}, "line=1,col=6,endLine=1,endColumn=6", `"range":{"start":{"line":1,"column":6},"end":{"line":1,"column":6}}`},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			ds[0].Span = tt.span
			var out bytes.Buffer
			if err := Render(&out, p, ds, Options{Format: "github"}); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), tt.annotation) {
				t.Fatal(out.String())
			}
			out.Reset()
			if err := Render(&out, p, ds, Options{Format: "json"}); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), tt.jsonRange) {
				t.Fatal(out.String())
			}
		})
	}
}

func TestGitHubSubdirectoryRootLinksToCheckoutPath(t *testing.T) {
	p, ds := sample()
	p.Root = "/work/nested/roles/demo"
	var out, summary bytes.Buffer
	err := Render(&out, p, ds, Options{Format: "github", Summary: &summary, GitHub: GitHub{Workspace: "/work", RepositoryRoot: "/work/nested", Repository: "org/repo", Commit: "a1b2c3"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "file=nested/roles/demo/a.yml,") || !strings.Contains(summary.String(), "https://github.com/org/repo/blob/a1b2c3/roles/demo/a.yml#L1") {
		t.Fatalf("%s\n%s", &out, &summary)
	}
}
