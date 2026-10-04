package lint

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

func TestExplainSelectionAndContext(t *testing.T) {
	root := t.TempDir()
	write := func(name, value string) string {
		t.Helper()
		destination := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(destination, []byte(value), 0644); err != nil {
			t.Fatal(err)
		}
		return destination
	}
	if wire, err := exec.Command("git", "init", root).CombinedOutput(); err != nil {
		t.Fatalf("git: %s: %v", wire, err)
	}
	write(".gitignore", "ignored.yml\n")
	ignored := write("ignored.yml", "value: fine\n")
	generic := write("misc/generic.yaml", "value: fine\n")
	tasks := write("roles/example/tasks/main.yml", "- debug: {msg: ok}\n")
	write("roles/example/defaults/main.yml", "value: [\n")
	template := write("roles/example/templates/config.yaml", "{{ raw invalid YAML }}\n")
	for _, tt := range []struct {
		name, filename string
		selected       bool
		kind           Kind
	}{
		{"ignored explicit", ignored, false, Generic}, {"nested generic", generic, false, Generic}, {"tasks", tasks, true, Tasks}, {"template", template, false, Template},
	} {
		t.Run(tt.name, func(t *testing.T) {
			before, err := os.ReadFile(tt.filename)
			if err != nil {
				t.Fatal(err)
			}
			result, err := Explain(t.Context(), Options{Root: root, Paths: []string{tt.filename}})
			if err != nil {
				t.Fatal(err)
			}
			if result.Source.Kind != tt.kind || result.DirectoryWouldSelect != tt.selected || !result.Dependencies.Complete {
				t.Fatalf("selection: %#v", result)
			}
			if tt.kind == Tasks && !slices.ContainsFunc(result.LoadedContext, func(s ObservedSource) bool {
				return s.Path == "roles/example/defaults/main.yml" && s.ParseState == "parse-error"
			}) {
				t.Fatal("context parse state omitted")
			}
			if tt.kind == Template && (len(result.ApplicablePolicies) != 0 || len(result.FixDecisions) != 0 || len(result.Unsupported) == 0) {
				t.Fatal("template promoted into checked source")
			}
			after, err := os.ReadFile(tt.filename)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("explain changed source")
			}
		})
	}
	result, err := Explain(t.Context(), Options{Root: root, StdinFilename: filepath.Join(root, "new.yml"), Stdin: []byte("value: [\n")})
	if err != nil || result.Input != "stdin" || result.DirectoryWouldSelect || result.Source.ParseState != "parse-error" {
		t.Fatalf("stdin explanation: %#v %v", result, err)
	}
	if _, err := Explain(t.Context(), Options{Root: root, Paths: []string{root}}); err == nil {
		t.Fatal("directory accepted as single source")
	}
}
func TestExplainParsedDirectoryAdmission(t *testing.T) {
	for _, git := range []bool{false, true} {
		t.Run(map[bool]string{false: "walk", true: "git"}[git], func(t *testing.T) {
			root := t.TempDir()
			if git {
				if wire, err := exec.Command("git", "init", root).CombinedOutput(); err != nil {
					t.Fatalf("git: %s: %v", wire, err)
				}
			}
			inputs := []struct {
				name, text string
				selected   bool
			}{
				{"main.yml", "value: fine\n", false},
				{"arbitrary.yaml", "- hosts: all\n  tasks: []\n", true},
				{"malformed.yml", "value: [\n", false},
				{"nested/generic.yml", "value: fine\n", false},
			}
			for _, input := range inputs {
				filename := filepath.Join(root, filepath.FromSlash(input.name))
				if err := os.MkdirAll(filepath.Dir(filename), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filename, []byte(input.text), 0644); err != nil {
					t.Fatal(err)
				}
			}
			project, err := Load(t.Context(), Options{Root: root, Paths: []string{root}})
			if err != nil {
				t.Fatal(err)
			}
			for _, input := range inputs {
				filename := filepath.Join(root, filepath.FromSlash(input.name))
				for _, stdin := range []bool{false, true} {
					opts := Options{Root: root, Paths: []string{filename}}
					if stdin {
						opts.Paths = nil
						opts.StdinFilename = filename
						opts.Stdin = []byte(input.text)
					}
					result, err := Explain(t.Context(), opts)
					if err != nil {
						t.Fatal(err)
					}
					if project.Selected[input.name] != input.selected || result.DirectoryWouldSelect != project.Selected[input.name] {
						t.Errorf("%s stdin=%v: explanation selected=%v directory selected=%v want=%v", input.name, stdin, result.DirectoryWouldSelect, project.Selected[input.name], input.selected)
					}
				}
			}
		})
	}
}

func TestFixDecisionAuthority(t *testing.T) {
	source, _ := Parse("main.yml", []byte("value: \"{{ a\n | f }}\"\n"))
	project := &Project{Sources: map[string]*Source{source.Path: source}, Selected: map[string]bool{source.Path: true}}
	diagnostics := Analyze(project, Rules())
	normal, err := PlanFixes(project, diagnostics)
	if err != nil {
		t.Fatal(err)
	}
	decisions := []FixDecision{}
	explained, err := planFixes(project, diagnostics, &decisions)
	if err != nil || len(normal) != 1 || len(explained) != 1 || !bytes.Equal(normal[0].After, explained[0].After) || !slices.ContainsFunc(decisions, func(d FixDecision) bool { return d.State == "available" }) {
		t.Fatalf("planner diverged: %#v %v", decisions, err)
	}
	conflict := []Diagnostic{{Path: source.Path, RuleID: "test", Fix: &Fix{Edits: []Edit{{Span: Span{0, 2}, Text: "a"}, {Span: Span{1, 3}, Text: "b"}}}}}
	decisions = nil
	if _, err := planFixes(project, conflict, &decisions); err != nil || len(decisions) != 1 || decisions[0].State != "conflicting-edits" {
		t.Fatalf("conflict explanation: %#v %v", decisions, err)
	}
	if _, err := PlanFixes(project, conflict); err == nil {
		t.Fatal("check conflict behavior changed")
	}
	declined := []Diagnostic{{Path: source.Path, RuleID: "test", Fix: &Fix{Edits: []Edit{{Span: Span{0, 1}, Text: "z"}}}}}
	decisions = nil
	if _, err := planFixes(project, declined, &decisions); err != nil || decisions[0].State != "preservation-verification-declined" {
		t.Fatalf("decline: %#v %v", decisions, err)
	}
	source, _ = Parse("main.yml", []byte("v: '{{ a; b }}'\n"))
	project.Sources[source.Path] = source
	decisions = nil
	if _, err := planFixes(project, Analyze(project, Rules()), &decisions); err != nil || !slices.ContainsFunc(decisions, func(d FixDecision) bool { return d.State == "unsupported-syntax" }) {
		t.Fatalf("unsupported syntax: %#v %v", decisions, err)
	}
}
