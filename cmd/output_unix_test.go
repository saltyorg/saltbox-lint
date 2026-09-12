//go:build linux || darwin

package cmd

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestAutoFormatUsesTerminalAndHonorsDumbTerm(t *testing.T) {
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
			command := exec.CommandContext(t.Context(), binary, "--color", tt.color, "check", path)
			command.Env = terminalTestEnvironment(tt.term, tt.noColor)
			output, err := runTestPTY(t, command, 80, "")
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
		command := exec.CommandContext(t.Context(), binary, "--color", "never", "check", "--format", "human", path)
		command.Env = terminalTestEnvironment("xterm-256color", "")
		output, err := runTestPTY(t, command, 40, "")
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
		command := exec.CommandContext(t.Context(), binary, "--color", "never", "check", "--diff", path)
		command.Env = terminalTestEnvironment("xterm-256color", "")
		output, err := runTestPTY(t, command, 160, patch)
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
