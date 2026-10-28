package cmd

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

const badJinja = "v: \"{{ a\n | combine(b) }}\"\n"

func TestCheckFormatDefaultsByDestination(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.yml")
	if err := os.WriteFile(path, []byte(badJinja), 0600); err != nil {
		t.Fatal(err)
	}

	t.Run("redirected output is concise", func(t *testing.T) {
		code, out, stderr := invoke(t, "", "check", path)
		if code != 1 || stderr != "1 finding (1 error) in 1 checked file.\n" || !strings.Contains(out, "error [jinja-layout]") {
			t.Fatalf("code=%d stdout=%q stderr=%q", code, out, stderr)
		}
		if strings.Contains(out, "Fix available:") {
			t.Fatalf("redirected auto output used human layout: %q", out)
		}
	})

	t.Run("explicit human remains annotated when redirected", func(t *testing.T) {
		code, out, stderr := invoke(t, "", "check", "--format", "human", path)
		if code != 1 || stderr != "" || !strings.Contains(out, "Fix available:") {
			t.Fatalf("code=%d stdout=%q stderr=%q", code, out, stderr)
		}
	})

	t.Run("auto is accepted explicitly", func(t *testing.T) {
		code, out, stderr := invoke(t, "", "check", "--format", "auto", path)
		if code != 1 || stderr != "1 finding (1 error) in 1 checked file.\n" || !strings.Contains(out, "error [jinja-layout]") {
			t.Fatalf("code=%d stdout=%q stderr=%q", code, out, stderr)
		}
	})
}

func TestColorPolicyIsIndependentFromFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.yml")
	if err := os.WriteFile(path, []byte(badJinja), 0600); err != nil {
		t.Fatal(err)
	}
	ordinaryCode, ordinaryJSON, ordinaryStderr := invoke(t, "", "check", "--format", "json", path)
	if ordinaryCode != 1 || ordinaryStderr != "" {
		t.Fatalf("ordinary JSON: code=%d stdout=%q stderr=%q", ordinaryCode, ordinaryJSON, ordinaryStderr)
	}

	t.Setenv("NO_COLOR", "any nonempty value")
	code, human, stderr := invoke(t, "", "--color", "always", "check", "--format", "human", path)
	if code != 1 || stderr != "" || !strings.Contains(human, "\x1b[") {
		t.Fatalf("forced human color: code=%d stdout=%q stderr=%q", code, human, stderr)
	}
	for _, format := range []string{"auto", "concise", "json", "github"} {
		t.Run(format+" stays plain", func(t *testing.T) {
			code, out, stderr := invoke(t, "", "--color", "always", "check", "--format", format, path)
			// Only automatic concise output summarizes on stderr.
			summary := ""
			if format == "auto" {
				summary = "1 finding (1 error) in 1 checked file.\n"
			}
			if code != 1 || stderr != summary || strings.Contains(stderr, "\x1b[") {
				t.Fatalf("code=%d stdout=%q stderr=%q", code, out, stderr)
			}
			if format == "json" {
				if out != ordinaryJSON {
					t.Fatalf("forced color changed JSON bytes:\nordinary: %q\n  forced: %q", ordinaryJSON, out)
				}
				return
			}
			if strings.Contains(out, "\x1b[") {
				t.Fatalf("%s output contained styling: %q", format, out)
			}
		})
	}

	code, plain, stderr := invoke(t, "", "--color", "never", "check", "--format", "human", path)
	if code != 1 || stderr != "" || strings.Contains(plain, "\x1b[") {
		t.Fatalf("disabled human color: code=%d stdout=%q stderr=%q", code, plain, stderr)
	}
}

func TestDetailedRuleUsesHumanRendererAndColorPolicy(t *testing.T) {
	code, plain, stderr := invoke(t, "", "rules", "jinja-layout")
	if code != 0 || stderr != "" || !strings.Contains(plain, "Good example:") || strings.Contains(plain, "\x1b[") {
		t.Fatalf("plain rule details: code=%d stdout=%q stderr=%q", code, plain, stderr)
	}

	t.Setenv("NO_COLOR", "1")
	code, styled, stderr := invoke(t, "", "--color", "always", "rules", "jinja-layout")
	if code != 0 || stderr != "" || !strings.Contains(styled, "\x1b[") {
		t.Fatalf("styled rule details: code=%d stdout=%q stderr=%q", code, styled, stderr)
	}

	code, list, stderr := invoke(t, "", "--color", "always", "rules")
	if code != 0 || stderr != "" || strings.Contains(list, "\x1b[") {
		t.Fatalf("compact rule list: code=%d stdout=%q stderr=%q", code, list, stderr)
	}
}

func TestDiffAutoUsesDiagnosticDestination(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.yml")
	if err := os.WriteFile(path, []byte(badJinja), 0600); err != nil {
		t.Fatal(err)
	}
	code, patch, diagnostics := invoke(t, "", "check", "--diff", path)
	if code != 1 || !strings.HasPrefix(patch, "--- a/bad.yml\n") || !strings.Contains(diagnostics, "error [jinja-layout]") {
		t.Fatalf("code=%d stdout=%q stderr=%q", code, patch, diagnostics)
	}
	if strings.Contains(patch, "\x1b[") || strings.Contains(diagnostics, "\x1b[") {
		t.Fatalf("redirected diff output contained styles: stdout=%q stderr=%q", patch, diagnostics)
	}
}

type panicReader struct{}

func (panicReader) Read([]byte) (int, error) { panic("terminal detection read stdin") }

func TestTerminalDetectionDoesNotReadStdin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clean.yml")
	if err := os.WriteFile(path, []byte("v: true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	code := Run(t.Context(), []string{"check", path}, Streams{In: panicReader{}, Out: &out, Err: &stderr}, "test")
	if code != 0 || out.String() != "" || stderr.String() != "No findings in 1 checked file.\n" {
		t.Fatalf("code=%d stdout=%q stderr=%q", code, &out, &stderr)
	}
}

func TestInvalidColorPreventsFixMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.yml")
	if err := os.WriteFile(path, []byte(badJinja), 0600); err != nil {
		t.Fatal(err)
	}
	code, out, stderr := invoke(t, "", "--color", "sometimes", "check", "--fix", path)
	if code != 2 || out != "" || !strings.Contains(stderr, "unknown color mode") {
		t.Fatalf("code=%d stdout=%q stderr=%q", code, out, stderr)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != badJinja {
		t.Fatalf("invalid color mutated source: %q", got)
	}
}

func TestAutomaticConciseSummary(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a.yml", "b.yml"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(badJinja), 0600); err != nil {
			t.Fatal(err)
		}
	}
	a, b := filepath.Join(root, "a.yml"), filepath.Join(root, "b.yml")
	for _, tt := range []struct {
		name   string
		args   []string
		code   int
		stderr string
	}{
		{"findings", []string{"check", a, b}, 1, "2 findings (2 errors) in 2 checked files.\n"},
		{"diff", []string{"check", "--diff", a}, 1, "a.yml:2:2: error [jinja-layout] align continuation operator with its expression content\n1 file has formatting changes. 1 finding (1 error) in 1 checked file.\n"},
		{"explicit concise diff", []string{"check", "--diff", "--format", "concise", a}, 1, "a.yml:2:2: error [jinja-layout] align continuation operator with its expression content\n"},
		{"fix", []string{"check", "--fix", a, b}, 0, "2 files fixed. No findings in 2 checked files.\n"},
		{"clean fix", []string{"check", "--fix", a}, 0, "No files needed fixes. No findings in 1 checked file.\n"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			code, _, stderr := invoke(t, "", append([]string{"--root", root}, tt.args...)...)
			if code != tt.code || stderr != tt.stderr {
				t.Fatalf("code=%d stderr=%q, want %d %q", code, stderr, tt.code, tt.stderr)
			}
		})
	}
}

func TestConciseSummaryCountsEachSeverity(t *testing.T) {
	project := &lint.Project{Sources: map[string]*lint.Source{"a.yml": {}, "context.yml": {}}, Selected: map[string]bool{"a.yml": true}}
	var out bytes.Buffer
	if err := writeConciseSummary(&out, "", project, []lint.Diagnostic{{Severity: "warning"}, {Severity: "error"}, {Severity: "warning"}}); err != nil {
		t.Fatal(err)
	}
	if want := "3 findings (1 error, 2 warnings) in 1 checked file.\n"; out.String() != want {
		t.Fatalf("summary %q, want %q", &out, want)
	}
}
