package action_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// These tasks must pass literal argv, anchor paths to the workspace, and map
// real concise diagnostics to editor locations. Execute the shipped task args.
func TestVSCodeTasksAndProblemMatcher(t *testing.T) {
	data, err := os.ReadFile("../examples/vscode/tasks.json")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Version string
		Tasks   []struct {
			Label, Type, Command string
			Args                 []string
			Options              struct{ Cwd string }
			ProblemMatcher       struct {
				Owner        string
				FileLocation []string
				Pattern      struct {
					Regexp                                      string
					File, Line, Column, Severity, Code, Message int
				}
			}
		}
	}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if config.Version != "2.0.0" || len(config.Tasks) != 3 {
		t.Fatalf("unexpected task config: %s", data)
	}
	binary := buildBinary(t)
	original, err := os.ReadFile("../lint/testdata/jinja/first-if.bad.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range config.Tasks {
		t.Run(task.Label, func(t *testing.T) {
			root := t.TempDir()
			file := filepath.Join(root, "nested", "file with spaces.yml")
			writeFile(t, file, original)
			writeFile(t, filepath.Join(root, "inventory.yml"), original)
			if task.Type != "process" || task.Command != "saltbox-lint" {
				t.Fatal("tasks must execute saltbox-lint as a process")
			}
			expand := strings.NewReplacer("${workspaceFolder}", root, "${file}", file)
			args := make([]string, len(task.Args))
			for i, arg := range task.Args {
				args[i] = expand.Replace(arg)
			}
			for i, arg := range args {
				if arg == "--" {
					args = slices.Insert(args, i, "--color", "always")
					break
				}
			}
			c := exec.CommandContext(t.Context(), binary, args...)
			c.Dir = expand.Replace(task.Options.Cwd)
			out, runErr := c.CombinedOutput()
			if bytes.Contains(out, []byte("\x1b[")) {
				t.Fatalf("concise editor output contains ANSI styling: %q", out)
			}
			fixing := strings.Contains(task.Label, "fix")
			if fixing {
				if runErr != nil {
					t.Fatalf("fix: %v %s", runErr, out)
				}
				after, err := os.ReadFile(file)
				if err != nil {
					t.Fatal(err)
				}
				if bytes.Equal(after, original) {
					t.Fatal("fix task did not fix the current file")
				}
				other, err := os.ReadFile(filepath.Join(root, "inventory.yml"))
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(other, original) {
					t.Fatal("current-file fix touched another source")
				}
				return
			}
			if ee, ok := runErr.(*exec.ExitError); !ok || ee.ExitCode() != 1 {
				t.Fatalf("expected findings: %v %s", runErr, out)
			}
			matcher := task.ProblemMatcher
			if len(matcher.FileLocation) != 2 || matcher.FileLocation[0] != "relative" || expand.Replace(matcher.FileLocation[1]) != root {
				t.Fatal("matcher root does not agree with source root")
			}
			re, err := regexp.Compile(matcher.Pattern.Regexp)
			if err != nil {
				t.Fatal(err)
			}
			for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
				m := re.FindStringSubmatch(line)
				if m == nil {
					t.Fatalf("unmatched diagnostic: %s", line)
				}
				p := matcher.Pattern
				if m[p.Code] != "jinja-layout" || m[p.Severity] != "error" || m[p.Message] == "" {
					t.Fatalf("wrong diagnostic groups: %q", m)
				}
				lineNumber, e1 := strconv.Atoi(m[p.Line])
				column, e2 := strconv.Atoi(m[p.Column])
				if e1 != nil || e2 != nil || lineNumber < 1 || column < 1 {
					t.Fatalf("wrong position: %q", m)
				}
				path := filepath.Join(root, m[p.File])
				if _, err := os.Stat(path); err != nil {
					t.Fatal(err)
				}
				if strings.Contains(task.Label, "current") && path != file {
					t.Fatalf("current-file task reported %s", path)
				}
			}
		})
	}
}
