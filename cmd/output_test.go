package cmd

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const badJinja = "v: \"{{ a\n | combine(b) }}\"\n"

func TestCheckFormatDefaultsByDestination(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.yml")
	if err := os.WriteFile(path, []byte(badJinja), 0600); err != nil {
		t.Fatal(err)
	}

	t.Run("redirected output is concise", func(t *testing.T) {
		code, out, stderr := invoke(t, "", "check", path)
		if code != 1 || stderr != "" || !strings.Contains(out, "error [jinja-layout]") {
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
		if code != 1 || stderr != "" || !strings.Contains(out, "error [jinja-layout]") {
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
			if code != 1 || stderr != "" {
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
	if code != 0 || out.String() != "" || stderr.String() != "" {
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

func TestAutoFormatUsesTerminalAndHonorsDumbTerm(t *testing.T) {
	if _, err := exec.LookPath("script"); err != nil {
		t.Skip("script is required for PTY coverage")
	}
	root := t.TempDir()
	binary := filepath.Join(root, "saltbox-lint")
	build := exec.CommandContext(t.Context(), "go", "build", "-o", binary, "..")
	build.Dir = "."
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	path := filepath.Join(root, "bad.yml")
	if err := os.WriteFile(path, []byte(badJinja), 0600); err != nil {
		t.Fatal(err)
	}

	for _, tt := range []struct {
		name, term, color, noColor, want, reject string
		wantANSI                                 bool
	}{
		{"capable terminal", "xterm-256color", "auto", "", "Fix available:", "error [jinja-layout]", true},
		{"nonempty NO_COLOR", "xterm-256color", "auto", "arbitrary", "Fix available:", "error [jinja-layout]", false},
		{"always overrides NO_COLOR", "xterm-256color", "always", "arbitrary", "Fix available:", "error [jinja-layout]", true},
		{"never disables color", "xterm-256color", "never", "", "Fix available:", "error [jinja-layout]", false},
		{"dumb terminal", "dumb", "auto", "", "error [jinja-layout]", "Fix available:", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			command := binary + " --color " + tt.color + " check " + path
			pty := exec.CommandContext(t.Context(), "script", "-qec", command, "/dev/null")
			pty.Env = terminalTestEnvironment(tt.term, tt.noColor)
			output, err := pty.CombinedOutput()
			if exitErr, ok := err.(*exec.ExitError); !ok || exitErr.ExitCode() != 1 {
				t.Fatalf("want findings exit 1, got %v: %q", err, output)
			}
			got := string(output)
			if !strings.Contains(got, tt.want) || strings.Contains(got, tt.reject) {
				t.Fatalf("PTY output=%q, want %q without %q", got, tt.want, tt.reject)
			}
			if strings.Contains(got, "\x1b[") != tt.wantANSI {
				t.Fatalf("PTY styling=%t, want %t: %q", strings.Contains(got, "\x1b["), tt.wantANSI, got)
			}
		})
	}

	t.Run("terminal width", func(t *testing.T) {
		command := "stty cols 40 && exec " + binary + " --color never check --format human " + path
		pty := exec.CommandContext(t.Context(), "script", "-qec", command, "/dev/null")
		pty.Env = terminalTestEnvironment("xterm-256color", "")
		output, err := pty.CombinedOutput()
		if exitErr, ok := err.(*exec.ExitError); !ok || exitErr.ExitCode() != 1 {
			t.Fatalf("want findings exit 1, got %v: %q", err, output)
		}
		lines := strings.Split(string(output), "\r\n")
		for i := range lines {
			lines[i] = strings.TrimRight(lines[i], " ")
		}
		if !strings.Contains(strings.Join(lines, "\n"), "align continuation operator with its\nexpression content") {
			t.Fatalf("human prose did not use 40-column terminal width: %q", output)
		}
	})

	t.Run("diff diagnostics use terminal stderr", func(t *testing.T) {
		patch := filepath.Join(root, "fix.patch")
		command := "stty cols 160 && " + binary + " --color never check --diff " + path + " >" + patch
		pty := exec.CommandContext(t.Context(), "script", "-qec", command, "/dev/null")
		pty.Env = terminalTestEnvironment("xterm-256color", "")
		output, err := pty.CombinedOutput()
		if exitErr, ok := err.(*exec.ExitError); !ok || exitErr.ExitCode() != 1 {
			t.Fatalf("want findings exit 1, got %v: %q", err, output)
		}
		if !bytes.Contains(output, []byte("Fix available:")) {
			t.Fatalf("stderr terminal did not receive human diagnostics: %q", output)
		}
		if !bytes.Contains(output, []byte(strings.Repeat("━", 160))) {
			t.Fatalf("stderr terminal width was capped: %q", output)
		}

		patchData, err := os.ReadFile(patch)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.HasPrefix(patchData, []byte("--- a/bad.yml\n")) || bytes.Contains(patchData, []byte("\x1b[")) {
			t.Fatalf("stdout patch=%q", patchData)
		}
	})
}

func terminalTestEnvironment(term, noColor string) []string {
	environ := make([]string, 0, len(os.Environ())+2)
	for _, value := range os.Environ() {
		if strings.HasPrefix(value, "TERM=") || strings.HasPrefix(value, "NO_COLOR=") {
			continue
		}
		environ = append(environ, value)
	}
	environ = append(environ, "TERM="+term)
	if noColor != "" {
		environ = append(environ, "NO_COLOR="+noColor)
	}
	return environ
}
