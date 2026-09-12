package report

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"testing"

	charmansi "github.com/charmbracelet/x/ansi"
	"github.com/saltyorg/saltbox-lint/lint"
)

type sectionWriter struct {
	writes     [][]byte
	afterWrite func(int)
	failAt     int
	failure    error
}

func (w *sectionWriter) Write(p []byte) (int, error) {
	w.writes = append(w.writes, bytes.Clone(p))
	call := len(w.writes)
	if w.afterWrite != nil {
		w.afterWrite(call)
	}
	if call == w.failAt {
		return len(p), w.failure
	}
	return len(p), nil
}

func (w *sectionWriter) bytes() []byte {
	return bytes.Join(w.writes, nil)
}

func humanStreamingFixture(t *testing.T) (*lint.Project, []lint.Diagnostic) {
	t.Helper()
	tasks, taskDiagnostics := lint.Parse(
		"roles/demo/tasks/main.yml",
		[]byte("before: true\nvalue: wrong\nafter: true\n"),
	)
	if len(taskDiagnostics) != 0 {
		t.Fatalf("parse tasks fixture: %+v", taskDiagnostics)
	}
	defaults, defaultDiagnostics := lint.Parse(
		"roles/demo/defaults/main.yml",
		[]byte("enabled: false\n"),
	)
	if len(defaultDiagnostics) != 0 {
		t.Fatalf("parse defaults fixture: %+v", defaultDiagnostics)
	}
	project := &lint.Project{Sources: map[string]*lint.Source{
		tasks.Path:    tasks,
		defaults.Path: defaults,
	}}
	edit := lint.Edit{Span: lint.Span{Start: 20, End: 25}, Text: "right"}
	return project, []lint.Diagnostic{
		{
			Path:     tasks.Path,
			RuleID:   "first",
			Severity: "error",
			Message:  "replace the task value",
			Span:     edit.Span,
			Preview:  &lint.Preview{Edits: []lint.Edit{edit}},
			Related: []lint.RelatedLocation{{
				Path: defaults.Path, Message: "default declared here", Span: lint.Span{Start: 9, End: 14},
			}},
		},
		{
			Path:     tasks.Path,
			RuleID:   "second",
			Severity: "warning",
			Message:  "use the same task proposal",
			Span:     edit.Span,
			Preview:  &lint.Preview{Edits: []lint.Edit{edit}},
		},
		{
			Path:     defaults.Path,
			RuleID:   "third",
			Severity: "notice",
			Message:  "enable the default",
			Expected: "Use true.",
			Span:     lint.Span{Start: 9, End: 14},
		},
	}
}

// Colored byte goldens reflect adjacent ANSI run coalescing. Wrapped RGB/font
// tests and the corpus terminal-cell comparison separately guard style meaning.
var humanStreamingOutputs = []struct {
	name    string
	profile ColorProfile
	bytes   int
	sha256  string
}{
	{name: "none", profile: ColorNone, bytes: 2554, sha256: "b1e40e50f39ec786ba92cae76f214bc94ee6fef0af2a99e2e8db3e99f80d1984"},
	{name: "ansi", profile: ColorANSI, bytes: 3068, sha256: "40614e97506a3f072fbec2c79909879edc9bda95c7538f4a747ae4a85bb49cb4"},
	{name: "ansi256", profile: ColorANSI256, bytes: 3312, sha256: "11529349e6bfca37949ef9df0a6b3c9ca74625678be64ef6277a5636cddbaa26"},
	{name: "truecolor", profile: ColorTrueColor, bytes: 3590, sha256: "fe506a61b8d04dd7da1e506bd7b83892a074e2ebdc1caa38151e22a903c6f889"},
}

func TestHumanReportStreamingCompatibility(t *testing.T) {
	for _, tt := range humanStreamingOutputs {
		t.Run(tt.name, func(t *testing.T) {
			project, diagnostics := humanStreamingFixture(t)
			var out bytes.Buffer
			err := Render(&out, project, diagnostics, Options{
				Format: "human",
				Human:  HumanOptions{Width: 80, Theme: ThemeDark, ColorProfile: tt.profile, Context: t.Context()},
			})
			if err != nil {
				t.Fatal(err)
			}
			digest := fmt.Sprintf("%x", sha256.Sum256(out.Bytes()))
			if out.Len() != tt.bytes || digest != tt.sha256 {
				t.Fatalf("output = %d bytes sha256 %s, want %d bytes sha256 %s", out.Len(), digest, tt.bytes, tt.sha256)
			}
		})
	}
}

func TestHumanReportStreamsRenderedSections(t *testing.T) {
	for _, tt := range humanStreamingOutputs {
		t.Run(tt.name, func(t *testing.T) {
			project, diagnostics := humanStreamingFixture(t)
			out := new(sectionWriter)
			err := Render(out, project, diagnostics, Options{
				Format: "human",
				Human:  HumanOptions{Width: 80, Theme: ThemeDark, ColorProfile: tt.profile, Context: t.Context()},
			})
			if err != nil {
				t.Fatal(err)
			}
			digest := fmt.Sprintf("%x", sha256.Sum256(out.bytes()))
			if len(out.bytes()) != tt.bytes || digest != tt.sha256 {
				t.Fatalf("joined output = %d bytes sha256 %s, want %d bytes sha256 %s", len(out.bytes()), digest, tt.bytes, tt.sha256)
			}
			markers := []string{"Saltbox Lint", "first", "second", "third", "Summary:"}
			indexes := make([]int, len(markers))
			for i, marker := range markers {
				indexes[i] = sectionContaining(out.writes, marker)
				if indexes[i] < 0 {
					t.Fatalf("marker %q missing from writes", marker)
				}
			}
			if indexes[0] != 0 {
				t.Fatalf("section indexes for %v = %v, want strictly increasing after title", markers, indexes)
			}
			for i := 1; i < len(indexes); i++ {
				if indexes[i] <= indexes[i-1] {
					t.Fatalf("section indexes for %v = %v, want strictly increasing after title", markers, indexes)
				}
			}
			firstWrite := charmansi.Strip(string(out.writes[0]))
			for _, forbidden := range markers[1:] {
				if strings.Contains(firstWrite, forbidden) {
					t.Fatalf("first write contains later section %q: %q", forbidden, firstWrite)
				}
			}
			if !strings.Contains(string(out.writes[indexes[2]]), "Suggestion shown above") {
				t.Fatalf("second finding lost shared-proposal reference: %q", out.writes[indexes[2]])
			}
			if !strings.Contains(string(out.writes[indexes[3]]), "roles/demo/defaults/main.yml") {
				t.Fatalf("third finding lost changed-path heading: %q", out.writes[indexes[3]])
			}
		})
	}
}

func TestHumanReportStopsBetweenSectionsOnCancellation(t *testing.T) {
	tests := []struct {
		name        string
		cancelAfter int
		wantPresent string
		wantAbsent  []string
	}{
		{name: "after title", cancelAfter: 1, wantPresent: "Saltbox Lint", wantAbsent: []string{"first", "second", "third", "Summary:"}},
		{name: "after first finding", cancelAfter: 2, wantPresent: "first", wantAbsent: []string{"second", "third", "Summary:"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			project, diagnostics := humanStreamingFixture(t)
			out := &sectionWriter{afterWrite: func(call int) {
				if call == tt.cancelAfter {
					cancel()
				}
			}}
			err := Render(out, project, diagnostics, Options{
				Format: "human",
				Human:  HumanOptions{Width: 80, Theme: ThemeDark, ColorProfile: ColorTrueColor, Context: ctx},
			})
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("Render() error = %v, want context.Canceled", err)
			}
			if len(out.writes) != tt.cancelAfter {
				t.Fatalf("writes = %d, want %d", len(out.writes), tt.cancelAfter)
			}
			got := charmansi.Strip(string(out.bytes()))
			if !strings.Contains(got, tt.wantPresent) {
				t.Fatalf("retained output missing %q: %q", tt.wantPresent, got)
			}
			for _, absent := range tt.wantAbsent {
				if strings.Contains(got, absent) {
					t.Fatalf("retained output contains later section %q: %q", absent, got)
				}
			}
		})
	}
}

func TestHumanReportStopsBetweenSectionsOnWriteError(t *testing.T) {
	failure := errors.New("section output failed")
	tests := []struct {
		name        string
		failAt      int
		wantPresent string
		wantAbsent  []string
	}{
		{name: "title", failAt: 1, wantPresent: "Saltbox Lint", wantAbsent: []string{"first", "second", "third", "Summary:"}},
		{name: "first finding", failAt: 2, wantPresent: "first", wantAbsent: []string{"second", "third", "Summary:"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			project, diagnostics := humanStreamingFixture(t)
			out := &sectionWriter{failAt: tt.failAt, failure: failure}
			err := Render(out, project, diagnostics, Options{
				Format: "human",
				Human:  HumanOptions{Width: 80, Theme: ThemeDark, ColorProfile: ColorTrueColor, Context: t.Context()},
			})
			if !errors.Is(err, failure) {
				t.Fatalf("Render() error = %v, want %v", err, failure)
			}
			if len(out.writes) != tt.failAt {
				t.Fatalf("writes = %d, want %d", len(out.writes), tt.failAt)
			}
			got := charmansi.Strip(string(out.bytes()))
			if !strings.Contains(got, tt.wantPresent) {
				t.Fatalf("retained output missing %q: %q", tt.wantPresent, got)
			}
			for _, absent := range tt.wantAbsent {
				if strings.Contains(got, absent) {
					t.Fatalf("retained output contains later section %q: %q", absent, got)
				}
			}
		})
	}
}

func TestHumanReportZeroFindingsStopsBeforeFirstWriteOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	var out bytes.Buffer
	err := Render(&out, &lint.Project{}, nil, Options{Format: "human", Human: HumanOptions{Context: ctx}})
	if !errors.Is(err, context.Canceled) || out.Len() != 0 {
		t.Fatalf("Render() = %v with output %q, want context.Canceled and no output", err, &out)
	}
}

func sectionContaining(writes [][]byte, marker string) int {
	for i, write := range writes {
		if strings.Contains(charmansi.Strip(string(write)), marker) {
			return i
		}
	}
	return -1
}
