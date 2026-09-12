package catalog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStaticAssignmentsAndFragmentMerging(t *testing.T) {
	// Catch using CLI-expanded metadata instead of source documentation, losing
	// subsection fragments, or replacing whole nested dictionaries while merging.
	source := []byte("DOCUMENTATION = r\"\"\"\nmodule: sample\nextends_documentation_fragment:\n  - test.demo.visible.EXTRA\n  - test.demo._hidden\noptions:\n  settings:\n    type: dict\n    aliases: [config]\n    suboptions:\n      own: {type: str}\n\"\"\"\nEXAMPLES = '''ignored text'''\n")
	fragment := []byte("class ModuleDocFragment:\n    DOCUMENTATION = '''options: {unused: {type: str}}'''\n    EXTRA = r'''\noptions:\n  settings:\n    suboptions:\n      inherited: {type: list, aliases: [items], suboptions: {name: {type: str}}}\n  visible: {type: bool}\n'''\n")
	raw, err := parseAssignments(source)
	if err != nil {
		t.Fatal(err)
	}
	visible, err := parseAssignments(fragment)
	if err != nil {
		t.Fatal(err)
	}
	fragments := map[string]map[string]any{"test.demo.visible": visible}
	options, available, gaps := semanticOptions(raw, fragments)
	if !available {
		t.Fatal("module documentation unavailable")
	}
	if len(gaps) != 1 || gaps[0] != "test.demo._hidden" {
		t.Fatalf("missing fragment gaps=%v", gaps)
	}
	if len(options) != 2 {
		t.Fatalf("options=%+v", options)
	}
	settings, ok := FindOption(options, "config")
	if !ok || settings.Type != "dict" {
		t.Fatal("own option type/alias lost")
	}
	inherited, ok := FindOption(settings.Suboptions, "items")
	if !ok || inherited.Type != "list" || inherited.Suboptions["name"].Type != "str" {
		t.Fatal("nested fragment list/alias lost")
	}
	if settings.Suboptions["own"].Type != "str" {
		t.Fatal("local suboption lost during fragment merge")
	}
}

func TestStaticDocumentationNeedsStringModule(t *testing.T) {
	for _, source := range []string{"DOCUMENTATION = '''options: {x: {type: str}}'''", "DOCUMENTATION = '''module: 10\noptions: {x: {type: str}}'''", "DOCUMENTATION = build_docs()"} {
		raw, err := parseAssignments([]byte(source))
		if err != nil {
			t.Fatal(err)
		}
		_, available, _ := semanticOptions(raw, nil)
		if available {
			t.Fatalf("nonstatic module documentation accepted: %s", source)
		}
	}
}

func TestStaticMergeArraysUsesLodashIndexOrder(t *testing.T) {
	raw, err := parseAssignments([]byte("DOCUMENTATION = '''module: sample\nextends_documentation_fragment: visible\noptions:\n  value: {type: str, aliases: [own]}\n'''"))
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := parseAssignments([]byte("DOCUMENTATION = '''options:\n  value: {aliases: [first, second]}\n'''"))
	if err != nil {
		t.Fatal(err)
	}
	options, _, _ := semanticOptions(raw, map[string]map[string]any{"ansible.builtin.visible": fragment})
	if len(options["value"].Aliases) != 2 || options["value"].Aliases[0] != "own" || options["value"].Aliases[1] != "second" {
		t.Fatalf("alias array merge=%v", options["value"].Aliases)
	}
}

func TestInvalidUnrelatedAssignmentDoesNotHideModuleDocumentation(t *testing.T) {
	raw, err := parseAssignments([]byte("DOCUMENTATION = '''module: sample\noptions: {value: {type: str}}'''\nPATTERN = r'''@ invalid yaml'''"))
	if err != nil {
		t.Fatal(err)
	}
	options, available, _ := semanticOptions(raw, nil)
	if !available || options["value"].Type != "str" {
		t.Fatal("unrelated Python assignment suppressed docs")
	}
}

func TestMalformedModuleDocumentationIsAParseError(t *testing.T) {
	if _, err := parseAssignments([]byte("DOCUMENTATION = '''module: [unterminated'''")); err == nil {
		t.Fatal("malformed module docs accepted")
	}
}

func TestUnterminatedStaticAssignmentIsAParseError(t *testing.T) {
	for _, source := range []string{
		"DOCUMENTATION = '''module: sample",
		"DOCUMENTATION = r\"\"\"module: sample",
		"EXTRA = r'''options: {value: {type: str}}",
	} {
		if _, err := parseAssignments([]byte(source)); err == nil {
			t.Errorf("unterminated assignment accepted: %s", source)
		}
	}
}

func TestUnterminatedDocumentationRetainsParseProblemKind(t *testing.T) {
	for _, fragment := range []bool{false, true} {
		name := "module"
		if fragment {
			name = "fragment"
		}
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			modulePath := filepath.Join(root, "sample.py")
			moduleSource := "DOCUMENTATION = '''module: sample"
			wantKind := "documentation_parse_error"
			if fragment {
				moduleSource = "DOCUMENTATION = '''module: sample\nextends_documentation_fragment: visible'''"
				wantKind = "fragment_parse_error"
				fragmentDir := filepath.Join(root, "plugins", "doc_fragments")
				if err := os.MkdirAll(fragmentDir, 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(fragmentDir, "visible.py"), []byte("DOCUMENTATION = r'''options: {value: {type: str}}"), 0644); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(modulePath, []byte(moduleSource), 0644); err != nil {
				t.Fatal(err)
			}
			c := &Catalog{
				Modules:    map[string]Module{"ansible.builtin.sample": {CanonicalName: "ansible.builtin.sample", Source: Source{Path: modulePath}}},
				Provenance: Provenance{ModulePaths: []string{filepath.Join(root, "modules")}},
			}
			if err := c.loadStaticOptions(); err != nil {
				t.Fatal(err)
			}
			found := false
			for _, problem := range c.Problems {
				if problem.Kind == wantKind && strings.Contains(problem.Message, "DOCUMENTATION") {
					found = true
				}
				if problem.Kind == "documentation_unavailable" {
					t.Errorf("malformed source reported as absent docs: %+v", problem)
				}
			}
			if !found {
				t.Errorf("missing %s problem: %+v", wantKind, c.Problems)
			}
			if _, ok := c.Resolve("sample", ResolveContext{}); !ok {
				t.Error("documentation failure removed discovered module")
			}
		})
	}
}
