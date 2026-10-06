package cmd

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func scaffoldRoot(t *testing.T, project string) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "root 🌨")
	if err := os.MkdirAll(filepath.Join(root, "roles"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, project+".yml"), []byte("[]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestScaffoldCLI(t *testing.T) {
	for _, project := range []string{"saltbox", "sandbox"} {
		t.Run(project, func(t *testing.T) {
			root := scaffoldRoot(t, project)
			args := []string{"scaffold", "role", "example", "--root", root, "--title", "Project 🌨", "--url", "https://example.com"}
			if project == "saltbox" {
				args = append(args, "--author", "contributor")
			}
			code, preview, stderr := invoke(t, "", args...)
			if code != 0 || stderr != "" || !strings.Contains(preview, "Preview only.") || !strings.Contains(preview, "=== roles/example/defaults/main.yml ===") || !strings.Contains(preview, "=== roles/example/tasks/main.yml ===") {
				t.Fatalf("preview: %d %q %q", code, preview, stderr)
			}
			if _, again, _ := invoke(t, "", args...); again != preview {
				t.Fatal("preview is nondeterministic")
			}
			if _, err := os.Lstat(filepath.Join(root, "roles", "example")); !os.IsNotExist(err) {
				t.Fatalf("preview created a role: %v", err)
			}
			code, written, stderr := invoke(t, "", append(args, "--write")...)
			if code != 0 || !strings.Contains(written, "# Title: Project 🌨") || strings.Contains(written, "Preview only.") || strings.Count(stderr, "Created:") != 5 {
				t.Fatalf("write: %d %q %q", code, written, stderr)
			}
			code, output, stderr := invoke(t, "", "check", "--root", root, "--format", "json", filepath.Join(root, "roles", "example"))
			if code != 0 || stderr != "" || output != "{\"schema_version\":2,\"diagnostics\":[],\"fixes\":[]}\n" {
				t.Fatalf("actual CLI check: %d %q %q", code, output, stderr)
			}
			code, output, stderr = invoke(t, "", append(args, "--write")...)
			if code != 2 || output != "" || !strings.Contains(stderr, "refuse existing") || strings.Contains(stderr, "Created:") {
				t.Fatalf("overwrite refusal: %d %q %q", code, output, stderr)
			}
		})
	}
}

func TestScaffoldCLIUsageAndHelp(t *testing.T) {
	root := scaffoldRoot(t, "saltbox")
	base := []string{"scaffold", "role", "example", "--root", root, "--title", "Project", "--author", "someone", "--url", "https://example.com"}
	for _, args := range [][]string{
		{"scaffold", "role"}, {"scaffold", "role", "example", "other"},
		{"scaffold", "role", "example"}, {"scaffold", "role", "example", "--root", root},
		append(append([]string{}, base...), "--fix"),
		append(append([]string{}, base...), "--format", "json"),
	} {
		code, out, stderr := invoke(t, "", args...)
		if code != 2 || out != "" || stderr == "" {
			t.Fatalf("usage %v: %d %q %q", args, code, out, stderr)
		}
	}
	code, help, stderr := invoke(t, "", "scaffold", "role", "--help")
	if code != 0 || stderr != "" || !strings.Contains(help, "--write") || !strings.Contains(help, "Partial failures retain and report") || !strings.Contains(help, "never executed") {
		t.Fatalf("help: %d %q %q", code, help, stderr)
	}
}

type scaffoldBrokenOutput struct{}

func (scaffoldBrokenOutput) Write([]byte) (int, error) { return 0, errors.New("broken preview output") }

func TestScaffoldOutputFailurePreventsCreation(t *testing.T) {
	root := scaffoldRoot(t, "saltbox")
	var stderr bytes.Buffer
	code := Run(t.Context(), []string{"scaffold", "role", "example", "--root", root, "--title", "Project", "--author", "someone", "--url", "https://example.com", "--write"}, Streams{Out: scaffoldBrokenOutput{}, Err: &stderr}, "test")
	if code != 2 || !strings.Contains(stderr.String(), "broken preview output") {
		t.Fatalf("output failure: %d %q", code, stderr.String())
	}
	if _, err := os.Lstat(filepath.Join(root, "roles", "example")); !os.IsNotExist(err) {
		t.Fatalf("created files despite failed preview: %v", err)
	}
}
