package lint

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const safeHeader = "####################\n# Title: Demo 🌨\n# Author(s): salty\n# URL: https://example.com\n# GNU General Public License v3.0\n---\n"

func TestRepresentationFixes(t *testing.T) {
	for _, tc := range []struct{ name, input, want string }{
		{"healthcheck", "demo_role_docker_healthcheck:\n  test: [CMD, 'curl', 42, true, \"null\", '🌨'] # keep\n", "demo_role_docker_healthcheck:\n  test: # keep\n    - CMD\n    - 'curl'\n    - 42\n    - true\n    - \"null\"\n    - '🌨'\n"},
		{"shell allowance", "demo_role_docker_healthcheck:\n  test: [CMD-SHELL, 'curl || exit 1']  # saltbox-lint allow cmd-shell\n", "demo_role_docker_healthcheck:\n  test:  # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - 'curl || exit 1'\n"},
		{"none", "demo_role_docker_healthcheck:\n  test: [NONE]", "demo_role_docker_healthcheck:\n  test:\n    - NONE"},
		{"computed", "# Owner comment\ndemo_role_secret_lookup: '{{ value }}'", "# Owner comment\n# Skip docs\ndemo_role_secret_lookup: '{{ value }}'"},
		{"mixed", "demo_role_secret_lookup: \"{{ (a if flag else b) }}\"\ndemo_role_docker_healthcheck:\n  test: [CMD, curl, \"{{ (path if flag else fallback) }}\"]\nv: \"{{ x\n | f }}\"\n", "# Skip docs\ndemo_role_secret_lookup: \"{{ a if flag else b }}\"\ndemo_role_docker_healthcheck:\n  test:\n    - CMD\n    - curl\n    - \"{{ path if flag else fallback }}\"\nv: \"{{ x\n       | f }}\"\n"},
		{"header missing marker", strings.TrimSuffix(safeHeader, "---\n") + "v: true\n", safeHeader + "v: true\n"},
		{"header wrong order", "---\n# Author(s): salty\n#   coauthor continuation\n# Title: Demo 🌨\n# URL: https://example.com\n# unknown: retained\n# GNU General Public License v3.0\nv: true\n", "####################\n# Title: Demo 🌨\n# Author(s): salty\n#   coauthor continuation\n# URL: https://example.com\n# unknown: retained\n# GNU General Public License v3.0\n---\nv: true\n"},
	} {
		for _, newline := range []string{"\n", "\r\n"} {
			t.Run(tc.name+newline, func(t *testing.T) {
				input, want := strings.ReplaceAll(tc.input, "\n", newline), strings.ReplaceAll(tc.want, "\n", newline)
				p := expressionFixProject(t, "roles/demo/defaults/main.yml", input)
				cs, err := PlanFixes(p, Analyze(p, Rules()))
				if err != nil || len(cs) != 1 {
					t.Fatalf("changes=%+v err=%v", cs, err)
				}
				if string(cs[0].After) != want {
					t.Fatalf("got %q want %q", cs[0].After, want)
				}
				edits, err := PlannedFixEdits(cs[0])
				if err != nil || !bytes.Equal(applyEdits([]byte(input), edits), []byte(want)) {
					t.Fatalf("projection %+v %v", edits, err)
				}
				next := expressionFixProject(t, cs[0].Path, want)
				again, err := PlanFixes(next, Analyze(next, Rules()))
				if err != nil || len(again) != 0 {
					t.Fatalf("not idempotent %+v %v", again, err)
				}
			})
		}
	}
}

func TestRepresentationRefusals(t *testing.T) {
	for _, input := range []string{
		"demo_role_docker_healthcheck:\n  test: []\n", "demo_role_docker_healthcheck:\n  test: [CMD]\n", "demo_role_docker_healthcheck:\n  test: [NONE, extra]\n", "demo_role_docker_healthcheck:\n  test: [CMD-SHELL, curl, extra]\n", "demo_role_docker_healthcheck:\n  test: [CMD, '']\n", "demo_role_docker_healthcheck:\n  test: [CMD, null]\n", "demo_role_docker_healthcheck:\n  test: [CMD, {}]\n", "demo_role_docker_healthcheck:\n  test: &test [CMD, curl]\n", "demo_role_docker_healthcheck:\n  test: [CMD, !unsafe curl]\n", "demo_role_docker_healthcheck: {test: [CMD, curl]}\n", "anchor: &command curl\ndemo_role_docker_healthcheck:\n  test: [CMD, *command]\n", "{demo_role_secret_lookup: value}\n", "demo_role_secret_lookup: value\n---\nother: 2\n",
		"# Title: Incomplete\nv: true\n", "---\n" + safeHeader + "v: true\n", "\ufeff" + safeHeader + "v: true\n", "%YAML 1.2\n" + safeHeader + "v: true\n", safeHeader + "v: true\n---\nw: true\n",
	} {
		t.Run(input, func(t *testing.T) {
			source, _ := Parse("roles/demo/defaults/main.yml", []byte(input))
			p := &Project{Sources: map[string]*Source{source.Path: source}, Selected: map[string]bool{source.Path: true}}
			cs, err := PlanFixes(p, Analyze(p, Rules()))
			if err != nil || len(cs) != 0 {
				t.Fatalf("unsafe change %+v %v", cs, err)
			}
		})
	}
}

func TestRepresentationExistingDirectives(t *testing.T) {
	for _, directive := range []string{"# Skip docs", "# Do not edit or override using the inventory"} {
		input := safeHeader + directive + "\ndemo_role_secret_lookup: value\ndemo_role_docker_healthcheck:\n  test:\n    - CMD\n    - curl\n"
		p := expressionFixProject(t, "roles/demo/defaults/main.yml", input)
		cs, err := PlanFixes(p, Analyze(p, Rules()))
		if err != nil || len(cs) != 0 {
			t.Fatalf("valid source changed %+v %v", cs, err)
		}
	}
}

func TestRepresentationWriteAuthority(t *testing.T) {
	input := "demo_role_docker_healthcheck:\n  test: [CMD, curl]\n"
	p := expressionFixProject(t, "roles/demo/defaults/main.yml", input)
	p.Root = t.TempDir()
	path := filepath.Join(p.Root, "roles/demo/defaults/main.yml")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	cs, err := PlanFixes(p, Analyze(p, Rules()))
	if err != nil || len(cs) != 1 {
		t.Fatalf("plan %+v %v", cs, err)
	}
	forged := Change{Path: cs[0].Path, Before: cs[0].Before, After: cs[0].After}
	if err := WriteChanges(p, []Change{forged}); err == nil {
		t.Fatal("forged change accepted")
	}
	mutated := cs[0]
	mutated.After = bytes.ReplaceAll(mutated.After, []byte("curl"), []byte("evil"))
	if err := WriteChanges(p, []Change{mutated}); err == nil {
		t.Fatal("mutated change accepted")
	}
	if err := WriteChanges(p, cs); err != nil {
		t.Fatal(err)
	}
	if err := WriteChanges(p, cs); err == nil {
		t.Fatal("stale change accepted")
	}
}

func TestRepresentationFixtures(t *testing.T) {
	for _, name := range []string{"comments", "header"} {
		t.Run(name, func(t *testing.T) {
			input, err := os.ReadFile("testdata/safe-representation/" + name + ".invalid.yml")
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile("testdata/safe-representation/" + name + ".valid.yml")
			if err != nil {
				t.Fatal(err)
			}
			p := expressionFixProject(t, "roles/demo/defaults/main.yml", string(input))
			cs, err := PlanFixes(p, Analyze(p, Rules()))
			if err != nil || len(cs) != 1 {
				t.Fatalf("plan %+v %v", cs, err)
			}
			if !bytes.Equal(cs[0].After, want) {
				t.Fatalf("got %s want %s", cs[0].After, want)
			}
			again := expressionFixProject(t, cs[0].Path, string(want))
			next, err := PlanFixes(again, Analyze(again, Rules()))
			if err != nil || len(next) != 0 {
				t.Fatalf("not idempotent %+v %v", next, err)
			}
		})
	}
}

func TestRepresentationAllowanceOnOpeningLine(t *testing.T) {
	input := "demo_role_docker_healthcheck:\n  test: [  # saltbox-lint allow cmd-shell\n    CMD-SHELL, 'curl || exit 1'\n  ]\n"
	want := "demo_role_docker_healthcheck:\n  test:  # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - 'curl || exit 1'\n"
	p := expressionFixProject(t, "roles/demo/defaults/main.yml", input)
	cs, err := PlanFixes(p, Analyze(p, Rules()))
	if err != nil || len(cs) != 1 || string(cs[0].After) != want {
		t.Fatalf("plan %+v %v", cs, err)
	}
	next := expressionFixProject(t, cs[0].Path, want)
	for _, d := range Analyze(next, Rules()) {
		if d.RuleID == "docker-healthcheck-mode" || d.RuleID == "lint-directive" {
			t.Fatalf("allowance changed: %+v", d)
		}
	}
}

func TestRepresentationHeaderKeepsDeclarationComments(t *testing.T) {
	input := strings.TrimSuffix(safeHeader, "---\n") + "# Do not edit or override using the inventory\ndemo_role_secret_lookup: value\n"
	want := safeHeader + "# Do not edit or override using the inventory\ndemo_role_secret_lookup: value\n"
	p := expressionFixProject(t, "roles/demo/defaults/main.yml", input)
	cs, err := PlanFixes(p, Analyze(p, Rules()))
	if err != nil || len(cs) != 1 || string(cs[0].After) != want {
		t.Fatalf("got %+v err=%v want %s", cs, err, want)
	}
	next := expressionFixProject(t, cs[0].Path, want)
	again, err := PlanFixes(next, Analyze(next, Rules()))
	if err != nil || len(again) != 0 {
		t.Fatalf("not idempotent %+v %v", again, err)
	}
}

func TestRepresentationDoesNotGrantMisplacedAllowance(t *testing.T) {
	input := "demo_role_docker_healthcheck:\n  test: [\n    CMD-SHELL, curl\n  ] # saltbox-lint allow cmd-shell\n"
	p := expressionFixProject(t, "roles/demo/defaults/main.yml", input)
	cs, err := PlanFixes(p, Analyze(p, Rules()))
	if err != nil || len(cs) != 0 {
		t.Fatalf("misplaced allowance promoted: %+v %v", cs, err)
	}
}

func TestRepresentationCommentAuthority(t *testing.T) {
	for _, input := range []string{"demo_role_secret_lookup: value\n", strings.TrimSuffix(safeHeader, "---\n") + "v: true"} {
		p := expressionFixProject(t, "roles/demo/defaults/main.yml", input)
		p.Root = t.TempDir()
		path := filepath.Join(p.Root, "roles/demo/defaults/main.yml")
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(input), 0600); err != nil {
			t.Fatal(err)
		}
		ds := Analyze(p, Rules())
		cs, err := PlanFixes(p, ds)
		if err != nil || len(cs) != 1 {
			t.Fatalf("plan %+v %v", cs, err)
		}
		forged := Change{Path: cs[0].Path, Before: cs[0].Before, After: cs[0].After}
		if _, err := PlannedFixEdits(forged); err == nil {
			t.Fatal("unproven comment projection accepted")
		}
		if err := WriteChanges(p, []Change{forged}); err == nil {
			t.Fatal("unproven comment write accepted")
		}
		delete(p.Selected, cs[0].Path)
		if err := WriteChanges(p, cs); err == nil {
			t.Fatal("unselected comment write accepted")
		}
		p.Selected[cs[0].Path] = true
		if err := WriteChanges(p, cs); err != nil {
			t.Fatal(err)
		}
		if bytes.HasSuffix(cs[0].Before, []byte("\n")) != bytes.HasSuffix(cs[0].After, []byte("\n")) {
			t.Fatal("final newline changed")
		}
	}
}

func TestRepresentationHeaderRefusesAmbiguousMetadata(t *testing.T) {
	for _, input := range []string{
		"# Title: Duplicate\n" + safeHeader + "v: true\n",
		strings.Replace(safeHeader, "# URL: https://example.com\n", "", 1) + "v: true\n",
		strings.Replace(safeHeader, "# GNU General Public License v3.0\n", "", 1) + "v: true\n",
		strings.Repeat("# extra\n", 20) + safeHeader + "v: true\n",
		strings.Replace(safeHeader, "# Title: Demo 🌨\n", "# Title: Demo 🌨\r\n", 1) + "v: true\n",
	} {
		p := expressionFixProject(t, "roles/demo/defaults/main.yml", input)
		cs, err := PlanFixes(p, Analyze(p, Rules()))
		if err != nil || len(cs) != 0 {
			t.Fatalf("ambiguous header changed %+v %v", cs, err)
		}
	}
}

func TestRepresentationHeaderAndComputedCompose(t *testing.T) {
	input := strings.TrimSuffix(safeHeader, "---\n") + "demo_role_secret_lookup: '{{ (a if flag else b) }}'\n"
	want := safeHeader + "# Skip docs\ndemo_role_secret_lookup: '{{ a if flag else b }}'\n"
	p := expressionFixProject(t, "roles/demo/defaults/main.yml", input)
	cs, err := PlanFixes(p, Analyze(p, Rules()))
	if err != nil || len(cs) != 1 || string(cs[0].After) != want {
		t.Fatalf("plan %+v %v", cs, err)
	}
}

func TestRepresentationHeaderRefusesUnboundedCommentSuffix(t *testing.T) {
	const metadata = "# Author(s): salty\n# GNU General Public License v3.0\n# URL: https://example.com\n# Title: Demo\n"
	for _, marker := range []string{"", "---\n"} {
		for _, suffix := range []string{"\n# User-facing documentation for demo_role_enabled\n", "# User-facing documentation for demo_role_enabled\n", "#   Ambiguous title continuation\n", "\n# Notes\n# Skip docs\n"} {
			for _, newline := range []string{"\n", "\r\n"} {
				input := strings.ReplaceAll(marker+metadata+suffix+"demo_role_enabled: true\n", "\n", newline)
				p := expressionFixProject(t, "roles/demo/defaults/main.yml", input)
				ds := Analyze(p, Rules())
				found := false
				for _, d := range ds {
					if d.RuleID == "ansible-source-header" {
						found = true
						if d.Fix != nil {
							t.Errorf("ambiguous header offered fix: %q", input)
						}
					}
				}
				if !found {
					t.Fatal("header diagnostic disappeared")
				}
				changes, err := PlanFixes(p, ds)
				if err != nil || len(changes) != 0 {
					t.Fatalf("ambiguous comments moved: input=%q changes=%+v err=%v", input, changes, err)
				}
			}
		}
	}
}

func TestRepresentationHeaderMarkerBoundsContinuations(t *testing.T) {
	input := "# Author(s): salty\n#   Coauthor continuation\n# GNU General Public License v3.0\n# URL: https://example.com\n# Title: Demo\n#   Title continuation\n\n---\n# User-facing documentation for demo_role_enabled\ndemo_role_enabled: true\n"
	want := "####################\n# Title: Demo\n#   Title continuation\n\n# Author(s): salty\n#   Coauthor continuation\n# URL: https://example.com\n# GNU General Public License v3.0\n---\n# User-facing documentation for demo_role_enabled\ndemo_role_enabled: true\n"
	p := expressionFixProject(t, "roles/demo/defaults/main.yml", input)
	changes, err := PlanFixes(p, Analyze(p, Rules()))
	if err != nil || len(changes) != 1 || string(changes[0].After) != want {
		t.Fatalf("marker-bounded comments: %+v %v", changes, err)
	}
	next := expressionFixProject(t, changes[0].Path, want)
	again, err := PlanFixes(next, Analyze(next, Rules()))
	if err != nil || len(again) != 0 {
		t.Fatalf("not idempotent: %+v %v", again, err)
	}
}
