package cmd

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestExcludedCLIInputsRemainCleanAndUnmodified(t *testing.T) {
	for _, policy := range []string{"configuration", "git"} {
		t.Run(policy, func(t *testing.T) {
			root := t.TempDir()
			file := filepath.Join(root, "tasks", "hidden.yml")
			if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
				t.Fatal(err)
			}
			if policy == "git" {
				if out, err := exec.CommandContext(t.Context(), "git", "init", "-q", root).CombinedOutput(); err != nil {
					t.Fatalf("git: %s %v", out, err)
				}
				if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("tasks/hidden.yml\n"), 0600); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(filepath.Join(root, ".saltbox-lint"), []byte("exclude_paths: [tasks]\n"), 0600); err != nil {
				t.Fatal(err)
			}
			const input = "value: [\n"
			if err := os.WriteFile(file, []byte(input), 0600); err != nil {
				t.Fatal(err)
			}
			for _, mode := range []string{"canonical", "lint-fixes"} {
				result, stderr, code := invokeFormat(t, input, "format", "--root", root, "--stdin-filename", file, "--mode", mode, "-")
				if code != 0 || stderr != "" || result.Status != "skipped" || len(result.Edits) != 0 || !strings.Contains(result.Reason, "excluded") {
					t.Fatalf("excluded %s formatter: %+v %s %d", mode, result, stderr, code)
				}
			}
			for _, args := range [][]string{
				{"check", "--root", root, "--format", "json", "--include-analysis", file},
				{"check", "--root", root, "--format", "json", "--fix", file},
				{"check", "--root", root, "--format", "json", "--include-analysis", "--stdin-filename", file, "-"},
				{"check", "--root", root, "--format", "json", "--include-analysis", root},
			} {
				code, stdout, stderr := invoke(t, input, args...)
				var result struct {
					Diagnostics []any `json:"diagnostics"`
					Fixes       []any `json:"fixes"`
				}
				if code != 0 || stderr != "" || json.Unmarshal([]byte(stdout), &result) != nil || len(result.Diagnostics) != 0 || len(result.Fixes) != 0 {
					t.Fatalf("excluded check: %v %d %s %s", args, code, stdout, stderr)
				}
			}
			data, err := os.ReadFile(file)
			if err != nil || string(data) != input {
				t.Fatal("excluded CLI operation modified source bytes")
			}
		})
	}
}

func TestCanonicalFormatDeclinesBrokenGitPolicy(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: /missing/format-test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := invokeFormat(t, "value: yes\n", "format", "--root", root, "--stdin-filename", filepath.Join(root, "main.yml"), "-")
	if code != 2 || !strings.Contains(stderr, "Git") {
		t.Fatalf("invalid Git policy authorized formatting: %d %q", code, stderr)
	}
}
