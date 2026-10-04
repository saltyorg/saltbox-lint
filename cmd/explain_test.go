package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestMetadataAndExplainCommands(t *testing.T) {
	root := t.TempDir()
	filename := filepath.Join(root, "main.yml")
	const input = "v: '{{ a; b }}'\n"
	if err := os.WriteFile(filename, []byte(input), 0644); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		args    []string
		code    int
		machine bool
	}{
		{[]string{"rules", "--format", "json", "--color", "always"}, 0, true},
		{[]string{"rules", "jinja-layout", "--format", "json"}, 0, true},
		{[]string{"rules", "unknown", "--format", "json"}, 2, false},
		{[]string{"rules", "--format", "bad"}, 2, false},
		{[]string{"explain", filename, "--root", root, "--format", "json", "--color", "always"}, 0, true},
		{[]string{"explain", "-", "--stdin-filename", filename, "--root", root, "--format", "json"}, 0, true},
		{[]string{"explain", filename, "--root", root}, 0, false},
		{[]string{"explain", filename, "--format", "bad"}, 2, false},
		{[]string{"explain", "-"}, 2, false},
		{[]string{"explain", filename, filename}, 2, false},
		{[]string{"explain", filepath.Join(root, "missing.yml")}, 2, false},
	} {
		var out, stderr bytes.Buffer
		code := Run(t.Context(), tt.args, Streams{In: strings.NewReader(input), Out: &out, Err: &stderr}, "test")
		if code != tt.code || (code == 0 && stderr.Len() > 0) {
			t.Fatalf("%v: code %d, stderr %q", tt.args, code, stderr.String())
		}
		if tt.machine && (!json.Valid(out.Bytes()) || bytes.Contains(out.Bytes(), []byte("\x1b"))) {
			t.Fatalf("invalid machine output: %q", out.String())
		}
	}
	var out bytes.Buffer
	if Run(t.Context(), []string{"rules", "jinja-layout", "--format", "json"}, Streams{Out: &out}, "test") != 0 {
		t.Fatal("registry command")
	}
	var registry lint.RuleRegistry
	if err := json.Unmarshal(out.Bytes(), &registry); err != nil || len(registry.Rules) != 1 || registry.Rules[0].ID != "jinja-layout" {
		t.Fatalf("single rule: %#v %v", registry, err)
	}
	actual, err := os.ReadFile(filename)
	if err != nil || string(actual) != input {
		t.Fatal("help changed input")
	}
}

func TestDiscoveryControlsRejectExternalSymlinks(t *testing.T) {
	for _, control := range []string{".gitignore", ".git/info/exclude", ".git/info"} {
		t.Run(control, func(t *testing.T) {
			root := t.TempDir()
			if output, err := exec.Command("git", "init", "-q", root).CombinedOutput(); err != nil {
				t.Fatalf("git init: %v: %s", err, output)
			}
			filename := filepath.Join(root, "source.yml")
			if err := os.WriteFile(filename, []byte("value: ok\n"), 0644); err != nil {
				t.Fatal(err)
			}
			external := t.TempDir()
			canary := []byte("external discovery bytes must remain unread\n")
			target := filepath.Join(external, "exclude")
			if err := os.WriteFile(target, canary, 0644); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(root, filepath.FromSlash(control))
			if err := os.RemoveAll(link); err != nil {
				t.Fatal(err)
			}
			if control == ".git/info" {
				target = external
			}
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			for _, args := range [][]string{
				{"explain", filename, "--root", root, "--format", "json"},
				{"check", filename, "--root", root, "--format", "json", "--include-analysis"},
				{"check", filename, "--root", root, "--format", "json"},
			} {
				var out, stderr bytes.Buffer
				code := Run(t.Context(), args, Streams{Out: &out, Err: &stderr}, "test")
				if code != 2 || out.Len() != 0 || !strings.Contains(stderr.String(), "outside root") {
					t.Fatalf("%v: code=%d stdout=%q stderr=%q", args, code, out.String(), stderr.String())
				}
			}
		})
	}
}

func TestNestedRootRejectsEscapedGitAdminControls(t *testing.T) {
	for _, parent := range []bool{false, true} {
		for _, linked := range []bool{false, true} {
			t.Run(fmt.Sprintf("parent=%v/linked=%v", parent, linked), func(t *testing.T) {
				repo := t.TempDir()
				git := func(args ...string) {
					t.Helper()
					if output, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
						t.Fatalf("git %v: %v: %s", args, err, output)
					}
				}
				git("init", "-q")
				worktree := repo
				if linked {
					git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "chore: initialize fixture")
					worktree = filepath.Join(t.TempDir(), "worktree")
					git("worktree", "add", "-q", "-b", "fixture", worktree)
				}
				root := filepath.Join(worktree, "subdir")
				if err := os.Mkdir(root, 0755); err != nil {
					t.Fatal(err)
				}
				filename := filepath.Join(root, "source.yml")
				if err := os.WriteFile(filename, []byte("value: ok\n"), 0644); err != nil {
					t.Fatal(err)
				}
				external := t.TempDir()
				target := filepath.Join(external, "exclude")
				if err := os.WriteFile(target, []byte("source.yml\n"), 0644); err != nil {
					t.Fatal(err)
				}
				link := filepath.Join(repo, ".git/info/exclude")
				if parent {
					link, target = filepath.Dir(link), external
				}
				if err := os.RemoveAll(link); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, link); err != nil {
					t.Fatal(err)
				}
				for _, args := range [][]string{
					{"explain", filename, "--root", root, "--format", "json"},
					{"check", filename, "--root", root, "--format", "json", "--include-analysis"},
					{"check", filename, "--root", root, "--format", "json"},
				} {
					var out, stderr bytes.Buffer
					if code := Run(t.Context(), args, Streams{Out: &out, Err: &stderr}, "test"); code != 2 || out.Len() != 0 || !strings.Contains(stderr.String(), "outside root") {
						t.Fatalf("%v: code=%d stdout=%q stderr=%q", args, code, out.String(), stderr.String())
					}
				}
			})
		}
	}
}
