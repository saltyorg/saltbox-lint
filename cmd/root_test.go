package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func invoke(t *testing.T, input string, args ...string) (int, string, string) {
	t.Helper()
	var out, stderr bytes.Buffer
	code := Run(t.Context(), args, Streams{In: strings.NewReader(input), Out: &out, Err: &stderr}, "test-version")
	return code, out.String(), stderr.String()
}

func TestCheckInvocations(t *testing.T) {
	root := t.TempDir()
	clean := filepath.Join(root, "clean.yml")
	bad := filepath.Join(root, "bad.yml")
	for path, data := range map[string]string{clean: "v: true\n", bad: "v: \"{{ a\n | combine(b) }}\"\n"} {
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Directory discovery intentionally selects conventional sources only.
	if err := os.WriteFile(filepath.Join(root, "inventory.yml"), []byte("v: \"{{ a\n | combine(b) }}\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	cases := []struct {
		name     string
		args     []string
		code     int
		contains string
	}{
		{"clean", []string{"check", clean}, 0, ""},
		{"default dot", []string{"check"}, 1, "jinja"},
		{"finding", []string{"check", bad}, 1, "Fix available:"},
		{"concise", []string{"check", "--format", "concise", bad}, 1, "error [jinja"},
		{"root", []string{"check", "--root", root, bad}, 1, "bad.yml:"},
		{"missing", []string{"check", "missing.yml"}, 2, ""},
		{"unknown flag", []string{"check", "--bogus"}, 2, ""},
		{"bad format", []string{"check", "--format", "bogus", clean}, 2, ""},
		{"conflicting fix", []string{"check", "--fix", "--diff", bad}, 2, ""},
		{"diff json", []string{"check", "--diff", "--format", "json", bad}, 2, ""},
		{"diff github", []string{"check", "--diff", "--format", "github", bad}, 2, ""},
		{"stdin missing filename", []string{"check", "-"}, 2, ""},
		{"filename missing stdin", []string{"check", "--stdin-filename", "virtual.yml"}, 2, ""},
		{"stdin fix", []string{"check", "-", "--stdin-filename", "virtual.yml", "--fix"}, 2, ""},
		{"stdin diff", []string{"check", "-", "--stdin-filename", "virtual.yml", "--diff"}, 2, ""},
		{"duplicate stdin", []string{"check", "-", "-", "--stdin-filename", "virtual.yml"}, 2, ""},
		{"version", []string{"--version"}, 0, "test-version"},
		{"help", []string{"--help"}, 0, "check"},
		{"rules", []string{"rules"}, 0, "jinja-layout"},
		{"rule explain", []string{"rules", "jinja-layout"}, 0, "Good example:"},
		{"unknown rule", []string{"rules", "missing"}, 2, ""},
		{"unknown command", []string{"missing"}, 2, ""},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			code, out, stderr := invoke(t, "v: true\n", tt.args...)
			if code != tt.code || !strings.Contains(out, tt.contains) {
				t.Fatalf("code=%d stdout=%q stderr=%q", code, out, stderr)
			}
			if code == 2 {
				if out != "" || stderr == "" {
					t.Fatalf("operational error streams: %q %q", out, stderr)
				}
			} else if stderr != "" {
				t.Fatalf("unexpected stderr %q", stderr)
			}
		})
	}
}

func TestStdinAndDuplicateTargets(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	for _, input := range []string{"", "v: true\n"} {
		code, out, stderr := invoke(t, input, "check", "-", "--stdin-filename", "unsaved.yml", "--format", "json")
		if code != 0 || stderr != "" || strings.TrimSpace(out) != "{\"diagnostics\":[]}" {
			t.Fatalf("%d %q %q", code, out, stderr)
		}
	}
	bad := filepath.Join(root, "bad.yml")
	input := "v: \"{{ a\n | combine(b) }}\"\n"
	if err := os.WriteFile(bad, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	code, out, stderr := invoke(t, "", "check", bad, bad, "--format", "json")
	var result struct {
		Diagnostics []json.RawMessage `json:"diagnostics"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if code != 1 || stderr != "" || len(result.Diagnostics) != 1 {
		t.Fatalf("%d %q %q", code, out, stderr)
	}
	code, out, stderr = invoke(t, "v: true\n", "check", bad, "-", "--stdin-filename", bad, "--format", "json")
	if code != 0 || stderr != "" || strings.TrimSpace(out) != "{\"diagnostics\":[]}" {
		t.Fatalf("%d %q %q", code, out, stderr)
	}
}

func TestDiffAndFixRecheck(t *testing.T) {
	for _, remaining := range []bool{false, true} {
		t.Run(map[bool]string{false: "fixed clean", true: "remaining error"}[remaining], func(t *testing.T) {
			root := t.TempDir()
			bad := filepath.Join(root, "bad.yml")
			input := "v: \"{{ a\n | combine(b) }}\"\n"
			if remaining {
				input += "x: \"{{ lookup('env', 'a' if x else 'b') }}\"\n"
			}
			if err := os.WriteFile(bad, []byte(input), 0600); err != nil {
				t.Fatal(err)
			}
			code, out, stderr := invoke(t, "", "check", bad, "--diff")
			if code != 1 || !strings.Contains(stderr, "jinja-layout") || !strings.Contains(out, "--- a/bad.yml\n+++ b/bad.yml\n@@") || !strings.Contains(out, "+       | combine(b)") {
				t.Fatalf("%d %q %q", code, out, stderr)
			}
			data, err := os.ReadFile(bad)
			if err != nil {
				t.Fatal(err)
			}
			if string(data) != input {
				t.Fatal("diff changed source")
			}
			code, out, stderr = invoke(t, "", "check", bad, "--fix", "--format", "json")
			wantCode := 0
			if remaining {
				wantCode = 1
			}
			if code != wantCode || stderr != "" || !json.Valid([]byte(out)) || strings.Contains(out, "jinja-layout") {
				t.Fatalf("%d %q %q", code, out, stderr)
			}
			data, err = os.ReadFile(bad)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(data), "\n       | combine(b)") {
				t.Fatalf("not fixed: %s", data)
			}
			code, out, stderr = invoke(t, "", "check", bad, "--fix", "--format", "json")
			again, err := os.ReadFile(bad)
			if err != nil {
				t.Fatal(err)
			}
			if code != wantCode || stderr != "" || !bytes.Equal(data, again) {
				t.Fatalf("not idempotent: %d %q %q", code, out, stderr)
			}
		})
	}
}

func TestGitHubCheckAppendsSummary(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	summary := filepath.Join(root, "summary.md")
	t.Setenv("GITHUB_STEP_SUMMARY", summary)
	t.Setenv("GITHUB_WORKSPACE", root)
	for _, input := range []string{"v: true\n", "v: \"{{ a\n | combine(b) }}\"\n"} {
		code, out, stderr := invoke(t, input, "check", "-", "--stdin-filename", "virtual.yml", "--format", "github")
		if code == 2 || stderr != "" {
			t.Fatalf("%d %q %q", code, out, stderr)
		}
	}
	data, err := os.ReadFile(summary)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "No findings") || !strings.Contains(string(data), "jinja-layout") {
		t.Fatalf("summary: %s", data)
	}
}

func TestParseFailuresAreFindingsAndSummaryFailuresAreOperational(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	code, out, stderr := invoke(t, "v: [\n", "check", "-", "--stdin-filename", "bad.yml", "--format", "json")
	if code != 1 || stderr != "" || !json.Valid([]byte(out)) || !strings.Contains(out, "yaml-syntax") {
		t.Fatalf("%d %q %q", code, out, stderr)
	}
	t.Setenv("GITHUB_STEP_SUMMARY", filepath.Join(root, "missing", "summary.md"))
	code, out, stderr = invoke(t, "v: true\n", "check", "-", "--stdin-filename", "good.yml", "--format", "github")
	if code != 2 || out != "" || !strings.Contains(stderr, "summary") {
		t.Fatalf("%d %q %q", code, out, stderr)
	}
}

func TestDiffReportsOriginalDiagnosticsOnStderr(t *testing.T) {
	fixable := "v: \"{{ a\n | combine(b) }}\"\n"
	unfixable := "x: \"{{ lookup('env', 'a' if x else 'b') }}\"\n"
	for _, format := range []string{"human", "concise"} {
		for _, tt := range []struct {
			name, input string
			rules       []string
			patch       bool
		}{
			{"fixable only", fixable, []string{"jinja-layout"}, true},
			{"unfixable only", unfixable, []string{"lookup-conditional-argument"}, false},
			{"mixed", fixable + unfixable, []string{"jinja-layout", "lookup-conditional-argument"}, true},
		} {
			t.Run(format+"/"+tt.name, func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "input.yml")
				if err := os.WriteFile(path, []byte(tt.input), 0600); err != nil {
					t.Fatal(err)
				}
				code, out, stderr := invoke(t, "", "check", path, "--diff", "--format", format)
				if code != 1 {
					t.Fatalf("code=%d out=%q err=%q", code, out, stderr)
				}
				if strings.HasPrefix(out, "--- a/input.yml\n") != tt.patch {
					t.Fatalf("patch output: %q", out)
				}
				if !tt.patch && out != "" {
					t.Fatalf("stdout must be empty without fixes: %q", out)
				}
				for _, rule := range tt.rules {
					needle := "[" + rule + "]"
					if format == "human" {
						needle = "ERROR  " + rule
					}
					if !strings.Contains(stderr, needle) {
						t.Errorf("stderr missing %s: %q", rule, stderr)
					}
				}
				if format == "human" && !tt.patch && !strings.Contains(stderr, "Expected:") {
					t.Errorf("missing human hint: %q", stderr)
				}
				if format == "human" && tt.patch && !strings.Contains(stderr, "Fix available:") {
					t.Errorf("missing human fix availability: %q", stderr)
				}
				if format == "concise" && strings.Contains(stderr, "Expected:") {
					t.Errorf("concise format ignored: %q", stderr)
				}
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if string(data) != tt.input {
					t.Fatal("diff changed source")
				}
			})
		}
	}
}

type failWriter struct{}

func (failWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestDiffPropagatesPatchAndDiagnosticWriteFailures(t *testing.T) {
	path := filepath.Join(t.TempDir(), "input.yml")
	if err := os.WriteFile(path, []byte("v: \"{{ a\n | combine(b) }}\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name        string
		out, stderr io.Writer
	}{
		{"patch", failWriter{}, &bytes.Buffer{}},
		{"diagnostics", &bytes.Buffer{}, failWriter{}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			root := NewRootCommand(Streams{Out: tt.out, Err: tt.stderr}, "test")
			root.SetArgs([]string{"check", path, "--diff"})
			if err := root.ExecuteContext(t.Context()); !errors.Is(err, io.ErrClosedPipe) {
				t.Fatalf("want renderer error, got %v", err)
			}
		})
	}
}
