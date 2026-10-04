package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/saltyorg/saltbox-lint/report"
)

func changedCommandGit(t *testing.T, root string, args ...string) string {
	t.Helper()
	output, err := exec.CommandContext(t.Context(), "git", append([]string{"-C", root}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}
func changedCommandFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	changedCommandGit(t, root, "init", "-q")
	if err := os.Mkdir(filepath.Join(root, "tasks"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "tasks/main.yml"), []byte("[]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	changedCommandGit(t, root, "add", "--all")
	changedCommandGit(t, root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "chore: initialize fixture")
	return root
}
func TestChangedCommandCleanRenderers(t *testing.T) {
	root := changedCommandFixture(t)
	t.Setenv("GITHUB_STEP_SUMMARY", "")
	for _, format := range []string{"auto", "human", "concise", "json", "github"} {
		t.Run(format, func(t *testing.T) {
			code, out, stderr := invoke(t, "", "check", "--root", root, "--changed-since", "HEAD", "--format", format, "--color", "never")
			if code != 0 || stderr != "" {
				t.Fatalf("%d %q %q", code, out, stderr)
			}
			var want bytes.Buffer
			renderFormat := format
			if renderFormat == "auto" {
				renderFormat = "concise"
			}
			if err := report.Render(&want, &lint.Project{Root: root, Sources: map[string]*lint.Source{}, Selected: map[string]bool{}}, nil, report.Options{Format: renderFormat}); err != nil {
				t.Fatal(err)
			}
			if out != want.String() {
				t.Fatalf("empty renderer output=%q want=%q", out, want.String())
			}
		})
	}
	code, out, stderr := invoke(t, "", "check", "--root", root, "--changed-since", "HEAD", "--diff")
	if code != 0 || out != "" || stderr != "" {
		t.Fatalf("empty diff: %d %q %q", code, out, stderr)
	}
	// An empty source repository also produces each normal clean result.
	if err := os.Remove(filepath.Join(root, "tasks/main.yml")); err != nil {
		t.Fatal(err)
	}
	code, out, stderr = invoke(t, "", "check", "--root", root, "--changed-since", "HEAD", "--format", "json")
	if code != 0 || out != "{\"schema_version\":2,\"diagnostics\":[],\"fixes\":[]}\n" || stderr != "" {
		t.Fatalf("deleted last source: %d %q %q", code, out, stderr)
	}
}
func TestChangedCommandUsageAndExplanation(t *testing.T) {
	root := changedCommandFixture(t)
	for _, args := range [][]string{
		{"check", "--changed-since", "HEAD", "tasks/main.yml"},
		{"check", "--changed-since", "HEAD", "--fix"},
		{"check", "--changed-since", "HEAD", "-", "--stdin-filename", "tasks/main.yml"},
		{"check", "--changed-since", "HEAD", "--stdin-filename", "tasks/main.yml"},
		{"check", "--changed-since="},
		{"check", "--changed-since", "missing"},
		{"check", "--changed-since=--all"},
		{"check", "--changed-since", "HEAD", "--diff", "--format", "json"},
		{"check", "--changed-since", "HEAD", "--diff", "--format", "github"},
		{"check", "--changed-since", "HEAD", "--include-analysis"},
		{"explain", "--changed-since="},
		{"explain", "--changed-since", "HEAD", "tasks/main.yml"},
		{"explain", "--changed-since", "HEAD", "--stdin-filename", "tasks/main.yml"},
	} {
		args = append(args, "--root", root)
		code, out, stderr := invoke(t, "value: buffer\n", args...)
		if code != 2 || out != "" || stderr == "" {
			t.Fatalf("%v: %d %q %q", args, code, out, stderr)
		}
	}
	input := []byte("value: '{{ a\n | combine(b) }}'\n")
	filename := filepath.Join(root, "tasks/main.yml")
	if err := os.WriteFile(filename, input, 0644); err != nil {
		t.Fatal(err)
	}
	commit := changedCommandGit(t, root, "rev-parse", "HEAD")
	code, out, stderr := invoke(t, "", "check", "--root", root, "--changed-since", "HEAD", "--include-analysis", "--format", "json", "--color", "always")
	var check struct {
		SchemaVersion int                  `json:"schema_version"`
		Analysis      *lint.AnalysisRecord `json:"analysis"`
	}
	if err := json.Unmarshal([]byte(out), &check); err != nil || code != 1 || stderr != "" || check.SchemaVersion != 2 || check.Analysis == nil || check.Analysis.Selection == nil || check.Analysis.Selection.Commit != commit || len(check.Analysis.Selection.Sources) != 1 || strings.Contains(out, "\x1b") {
		t.Fatalf("changed analysis: %d %q %q %v", code, out, stderr, err)
	}
	code, out, stderr = invoke(t, "", "explain", "--root", root, "--changed-since", "HEAD", "--format", "json", "--color", "always")
	var explanation lint.ChangedExplanation
	if err := json.Unmarshal([]byte(out), &explanation); err != nil || code != 0 || stderr != "" || explanation.SchemaVersion != 1 || explanation.Selection == nil || explanation.Selection.Commit != commit || len(explanation.FixDecisions) == 0 || strings.Contains(out, "\x1b") {
		t.Fatalf("changed explanation: %d %q %q %v", code, out, stderr, err)
	}
	if explanation.Selection.Sources[0].Reasons[0].Kind != "changed-primary" {
		t.Fatalf("reason: %+v", explanation.Selection)
	}
	code, out, stderr = invoke(t, "", "explain", "--root", root, "--changed-since", "HEAD")
	if code != 0 || stderr != "" || !strings.Contains(out, "Resolved commit: "+commit) || !strings.Contains(out, "changed-primary") {
		t.Fatalf("human explanation: %d %q %q", code, out, stderr)
	}
	code, out, stderr = invoke(t, "", "check", "--root", root, "--changed-since", "HEAD", "--diff", "--format", "concise")
	if code != 1 || !strings.Contains(out, "--- a/tasks/main.yml") || !strings.Contains(stderr, "jinja") {
		t.Fatalf("diff: %d %q %q", code, out, stderr)
	}
	actual, err := os.ReadFile(filename)
	if err != nil || !bytes.Equal(actual, input) {
		t.Fatal("read-only commands changed source bytes")
	}
}
