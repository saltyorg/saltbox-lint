package lint

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const settingsBanner = "################################\n# Settings\n################################\n"

func sectionDiagnostics(t *testing.T, path, input string) (*Project, []Diagnostic) {
	t.Helper()
	s, parseDiagnostics := Parse(path, []byte(input))
	if len(parseDiagnostics) != 0 {
		t.Fatalf("invalid fixture: %+v", parseDiagnostics)
	}
	p := &Project{Root: "/project", Sources: map[string]*Source{path: s}, Selected: map[string]bool{path: true}}
	var rules []Rule
	for _, rule := range Rules() {
		if rule.ID == "section-spacing" {
			rules = append(rules, rule)
		}
	}
	return p, Analyze(p, rules)
}

func TestSectionSpacingBeforeVariables(t *testing.T) {
	input, err := os.ReadFile("testdata/sections/arr_db.bad.yaml")
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/sections/arr_db.good.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"roles/arr_db/defaults/main.yml", "roles/example/vars/main.yaml", "inventories/group_vars/all.yml", "examples.yaml"} {
		t.Run(path, func(t *testing.T) {
			p, ds := sectionDiagnostics(t, path, string(input))
			if len(ds) != 1 {
				t.Fatalf("want missing separator finding, got %+v", ds)
			}
			if p.Sources[path].Position(ds[0].Span.Start).Line != 4 || !strings.Contains(ds[0].Expected, "blank line") || ds[0].Fix == nil {
				t.Fatalf("want variable location, actionable hint and fix: %+v", ds[0])
			}
			changes, err := PlanFixes(p, ds)
			if err != nil || len(changes) != 1 {
				t.Fatalf("want one file correction, got %d: %v", len(changes), err)
			}
			if !bytes.Equal(changes[0].After, want) {
				t.Fatalf("correction = %q, want %q", changes[0].After, want)
			}
		})
	}
}

func TestSectionSpacingRespectsCommentsAndEmptySections(t *testing.T) {
	custom := "################################\n# Variables\n################################\n"
	for _, tc := range []struct {
		name, input string
		want        int
	}{
		{"one blank", settingsBanner + "\nvalue: true\n", 0},
		{"extra blanks", settingsBanner + "\n\nvalue: true\n", 0},
		{"whitespace blank", settingsBanner + " \t\nvalue: true\n", 0},
		{"custom title", custom + "value: true\n", 1},
		{"variable documentation", settingsBanner + "# Skip docs\nexample_role_value_lookup: value\n", 1},
		{"indented documentation", settingsBanner + "  # Explanation\nvalue: true\n", 1},
		{"indented mapping", settingsBanner + "  value: true\n", 1},
		{"separated documentation", settingsBanner + "\n# Skip docs\nexample_role_value_lookup: value\n", 0},
		{"section explanation then blank", settingsBanner + "# Explanation\n\nvalue: true\n", 0},
		{"empty section", settingsBanner, 0},
		{"comment only section", settingsBanner + "# No variables yet\n", 0},
		{"successive banners", settingsBanner + custom + "\nvalue: true\n", 0},
		{"document boundary", settingsBanner + "---\nvalue: true\n", 0},
		{"ordinary comment", "# Settings\nvalue: true\n", 0},
		{"quoted content", "value: \"start\n" + settingsBanner + "end\"\n", 0},
		{"literal content", "value: |\n  ################################\n  # Settings\n  ################################\n  text\n", 0},
		{"task sequence", settingsBanner + "- debug:\n    msg: hello\n", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, ds := sectionDiagnostics(t, "examples.yaml", tc.input)
			if len(ds) != tc.want {
				t.Fatalf("want %d findings, got %+v", tc.want, ds)
			}
			if tc.want == 0 {
				changes, err := PlanFixes(p, ds)
				if err != nil || len(changes) != 0 {
					t.Fatalf("valid source should stay unchanged: %+v, %v", changes, err)
				}
			}
		})
	}
}

func TestSectionSpacingFixPreservesSourceAndIsIdempotent(t *testing.T) {
	for _, newline := range []string{"\n", "\r\n"} {
		t.Run(strings.ReplaceAll(newline, "\n", "LF"), func(t *testing.T) {
			input := settingsBanner + "# Skip docs\nexample_role_value_lookup: &value \"{{ 'literal  spacing' }}\"\ncopy: *value\n" +
				"################################\n# Variables\n################################\nother: !!str café\n"
			want := settingsBanner + "\n# Skip docs\nexample_role_value_lookup: &value \"{{ 'literal  spacing' }}\"\ncopy: *value\n" +
				"################################\n# Variables\n################################\n\nother: !!str café\n"
			input = strings.ReplaceAll(input, "\n", newline)
			want = strings.ReplaceAll(want, "\n", newline)
			p, ds := sectionDiagnostics(t, "roles/example/defaults/main.yml", input)
			if len(ds) != 2 {
				t.Fatalf("want two missing separators, got %+v", ds)
			}
			changes, err := PlanFixes(p, ds)
			if err != nil || len(changes) != 1 {
				t.Fatalf("want one corrected file, got %d: %v", len(changes), err)
			}
			if string(changes[0].After) != want {
				t.Fatalf("correction = %q, want %q", changes[0].After, want)
			}
			p.Root = t.TempDir()
			target := filepath.Join(p.Root, filepath.FromSlash(changes[0].Path))
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, []byte(input), 0640); err != nil {
				t.Fatal(err)
			}
			if err := WriteChanges(p, changes); err != nil {
				t.Fatal(err)
			}
			actual, err := os.ReadFile(target)
			if err != nil || string(actual) != want {
				t.Fatalf("written bytes=%q error=%v", actual, err)
			}
			info, err := os.Stat(target)
			if err != nil || info.Mode().Perm() != 0640 {
				t.Fatalf("mode changed: %v, %v", info, err)
			}
			fixed, remaining := sectionDiagnostics(t, changes[0].Path, want)
			second, err := PlanFixes(fixed, remaining)
			if err != nil || len(remaining) != 0 || len(second) != 0 {
				t.Fatalf("fix is not idempotent: %+v %+v %v", remaining, second, err)
			}
		})
	}
}

func TestSectionSpacingCombinesWithJinjaFixes(t *testing.T) {
	before, err := os.ReadFile("testdata/jinja/first-if.bad.yaml")
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile("testdata/jinja/first-if.good.yaml")
	if err != nil {
		t.Fatal(err)
	}
	p, _ := sectionDiagnostics(t, "examples.yaml", settingsBanner+string(before))
	changes, err := PlanFixes(p, Analyze(p, Rules()))
	want := append([]byte(settingsBanner+"\n"), after...)
	if err != nil || len(changes) != 1 {
		t.Fatalf("want one combined correction, got %d: %v", len(changes), err)
	}
	if !bytes.Equal(changes[0].After, want) {
		t.Fatalf("combined correction = %q, want %q", changes[0].After, want)
	}
}

func TestSectionSpacingDoesNotAuthorizeOtherCommentEdits(t *testing.T) {
	for _, input := range []string{"# ordinary comment\nvalue: true\n", settingsBanner + "\nvalue: true\n", "value: \"start\n" + settingsBanner + "end\"\n"} {
		p, _ := sectionDiagnostics(t, "examples.yaml", input)
		offset := strings.Index(input, "\n")
		ds := []Diagnostic{{Path: "examples.yaml", Fix: &Fix{Edits: []Edit{{Span: Span{offset, offset + 1}, Text: "\n\n"}}}}}
		changes, err := PlanFixes(p, ds)
		if err != nil || len(changes) != 0 {
			t.Fatalf("unrelated comment whitespace was authorized: %+v, %v", changes, err)
		}
	}
	p, _ := sectionDiagnostics(t, "examples.yaml", settingsBanner+"value: true\n")
	for _, text := range []string{"\n\n", "\n "} {
		ds := []Diagnostic{{Path: "examples.yaml", Fix: &Fix{Edits: []Edit{{Span: Span{len(settingsBanner), len(settingsBanner)}, Text: text}}}}}
		changes, err := PlanFixes(p, ds)
		if err != nil || len(changes) != 0 {
			t.Fatalf("noncanonical separator edit %q was authorized: %d changes, %v", text, len(changes), err)
		}
	}
}
