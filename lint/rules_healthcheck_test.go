package lint

import (
	"slices"
	"strings"
	"testing"
)

func TestDockerHealthcheckShapes(t *testing.T) {
	for _, tc := range []struct {
		name, test string
		bad        bool
	}{
		{"cmd", "test:\n    - CMD\n    - curl\n    - --fail\n", false},
		{"commented marker", "test:\n    - 'CMD' # execute\n    - curl\n", false},
		{"none", "test:\n    - NONE\n", false},
		{"flow", "test: [CMD, curl]\n", true},
		{"scalar", "test: curl --fail\n", true},
		{"empty list", "test: []\n", true},
		{"no executable", "test:\n    - CMD\n", true},
		{"empty executable", "test:\n    - CMD\n    - ' '\n", true},
		{"null executable", "test:\n    - CMD\n    - null\n", true},
		{"null tilde", "test:\n    - CMD\n    - ~\n", true},
		{"quoted null", "test:\n    - CMD\n    - 'null'\n", false},
		{"typed executable", "test:\n    - CMD\n    - 123\n", false},
		{"typed arguments", "test:\n    - CMD\n    - printf\n    - 123\n    - false\n    - ''\n", false},
		{"collection executable", "test:\n    - CMD\n    - {}\n", true},
		{"collection argv", "test:\n    - CMD\n    - printf\n    - []\n", true},
		{"null argv", "test:\n    - CMD\n    - printf\n    - null\n", true},
		{"none extra", "test:\n    - NONE\n    - extra\n", true},
		{"wrong marker", "test:\n    - cmd\n    - curl\n", true},
		{"typed marker", "test:\n    - true\n    - curl\n", true},
		{"shell", "test: # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - curl --fail || exit 1\n", false},
		{"shell numeric", "test: # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - 123\n", false},
		{"shell bool", "test: # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - false\n", false},
		{"shell tokenized", "test: # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - curl\n    - --fail\n", true},
		{"folded shell", "test: # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - >-\n      curl --fail\n      || exit 1\n", false},
		{"folded empty", "test: # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - >-\n\n", true},
		{"literal fake test key", "test: # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - |\n      test: [NONE]\n      # saltbox-lint allow unknown\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := "example_role_docker_healthcheck:\n  " + tc.test
			if tc.bad {
				assertDockerDiagnostic(t, input, "docker-healthcheck-shape", "test", "block list", "CMD", "NONE")
			} else if ds := dockerDiagnostics(t, input); len(ds) != 0 {
				t.Fatal(ds)
			}
		})
	}
	for _, test := range []string{"{}\n", "\n  interval: 10s\n", "|\n  test: [NONE]\n"} {
		assertDockerDiagnostic(t, "example_role_docker_healthcheck: "+test, "docker-healthcheck-shape", "example_role_docker_healthcheck", "exactly one")
	}
}

func TestDockerHealthcheckModeAndDirectivesRemainIndependent(t *testing.T) {
	for _, tc := range []struct {
		name, comment, marker, command string
		want                           []string
	}{
		{"shell unallowed", "", "CMD-SHELL", "curl", []string{"docker-healthcheck-mode"}},
		{"shell allowed", "# saltbox-lint allow cmd-shell", "CMD-SHELL", "curl", nil},
		{"invalid shape allowed", "# saltbox-lint allow cmd-shell", "CMD-SHELL", "null", []string{"docker-healthcheck-shape"}},
		{"invalid shape unallowed", "", "CMD-SHELL", "null", []string{"docker-healthcheck-mode", "docker-healthcheck-shape"}},
		{"unknown allowance", "# saltbox-lint allow other", "CMD-SHELL", "curl", []string{"docker-healthcheck-mode", "lint-directive"}},
		{"malformed allowance", "# saltbox-lint cmd-shell", "CMD-SHELL", "curl", []string{"docker-healthcheck-mode", "lint-directive"}},
		{"noncanonical spaces", "# saltbox-lint  allow cmd-shell", "CMD-SHELL", "curl", []string{"docker-healthcheck-mode", "lint-directive"}},
		{"unnecessary", "# saltbox-lint allow cmd-shell", "CMD", "curl", []string{"lint-directive"}},
		{"invalid shape recognized allowance", "# saltbox-lint allow cmd-shell", "unknown", "null", []string{"docker-healthcheck-shape"}},
		{"directive command data", "# saltbox-lint allow cmd-shell", "CMD-SHELL", "\"printf '# saltbox-lint allow other'\"", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := "example_role_docker_healthcheck:\n  test: " + tc.comment + "\n    - " + tc.marker + "\n    - " + tc.command + "\n"
			ds := dockerDiagnostics(t, input)
			var got []string
			for _, d := range ds {
				got = append(got, d.RuleID)
				if d.Fix != nil || d.Expected == "" {
					t.Errorf("invalid diagnostic %+v", d)
				}
			}
			slices.Sort(got)
			if !slices.Equal(got, tc.want) {
				t.Fatalf("IDs=%v want=%v diagnostics=%+v", got, tc.want, ds)
			}
			for _, d := range ds {
				wantSpan := "test"
				if d.RuleID == "lint-directive" {
					wantSpan = tc.comment
				}
				if gotSpan := input[d.Span.Start:d.Span.End]; gotSpan != wantSpan {
					t.Errorf("span=%q want=%q", gotSpan, wantSpan)
				}
			}
		})
	}
	input := "example_role_docker_healthcheck:\n  test:\n    - CMD-SHELL\n    - curl\n"
	assertDockerDiagnostic(t, input, "docker-healthcheck-mode", "test", "# saltbox-lint allow cmd-shell")
	input = "example_role_docker_healthcheck:\n  test: [CMD-SHELL, null] # saltbox-lint allow cmd-shell\n"
	if ds := dockerDiagnostics(t, input); len(ds) != 1 || ds[0].RuleID != "docker-healthcheck-shape" {
		t.Fatal(ds)
	}
}

func TestDockerLintDirectivesUseRealCommentOwnership(t *testing.T) {
	for _, tc := range []struct{ name, input, hint string }{
		{"standalone", "# saltbox-lint allow cmd-shell\nv: true\n", "test"},
		{"wrong key", "example_role_docker_healthcheck: # saltbox-lint allow cmd-shell\n  test:\n    - NONE\n", "test"},
		{"wrong list item", "example_role_docker_healthcheck:\n  test:\n    - NONE # saltbox-lint allow cmd-shell\n", "test"},
		{"ordinary test key", "other:\n  test: # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - curl\n", "test"},
		{"unknown", "# saltbox-lint allow other\nv: true\n", "cmd-shell"},
		{"embedded malformed", "# note # saltbox-lint allow cmd-shell\nv: true\n", "# saltbox-lint allow cmd-shell"},
		{"extra suffix", "# saltbox-lint allow cmd-shell because necessary\nv: true\n", "# saltbox-lint allow cmd-shell"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ds := dockerDiagnostics(t, tc.input, "lint-directive")
			if len(ds) != 1 {
				t.Fatalf("diagnostics=%+v", ds)
			}
			if !strings.Contains(ds[0].Expected, tc.hint) {
				t.Errorf("expected %q in %q", tc.hint, ds[0].Expected)
			}
			if tc.input[ds[0].Span.Start] != '#' {
				t.Errorf("not comment span %+v", ds[0])
			}
		})
	}
	input := "v: \"quoted\n# saltbox-lint allow unknown\nend\"\nblock: |\n  # saltbox-lint allow unknown\nflow: ['# saltbox-lint allow unknown']\n"
	if ds := dockerDiagnostics(t, input); len(ds) != 0 {
		t.Fatal(ds)
	}
	// Real directives preserve original byte spans through CRLF and Unicode.
	input = "example_role_docker_healthcheck:\r\n  test: # saltbox-lint allow unknown\r\n    - CMD-SHELL\r\n    - 'é😀'\r\n"
	assertDockerDiagnostic(t, input, "lint-directive", "# saltbox-lint allow unknown", "cmd-shell")
}

func TestDockerHealthcheckAllowanceDoesNotHideJinjaDiagnostics(t *testing.T) {
	input := "example_role_docker_healthcheck:\n  test: # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - \"{{ lookup('x', default='a' if flag else 'b') }}\"\n"
	rules := append(dockerRules(), jinjaRules()...)
	ds := Analyze(defaultsProject(t, "roles/example/defaults/main.yml", input), rules)
	if len(ds) != 1 || ds[0].RuleID != "lookup-conditional-argument" {
		t.Fatalf("diagnostics=%+v", ds)
	}
}

func TestDockerHealthcheckDuplicateTestKeyRejectedByParser(t *testing.T) {
	input := "example_role_docker_healthcheck:\n  test:\n    - NONE\n  test:\n    - NONE\n"
	source, ds := Parse("roles/example/defaults/main.yml", []byte(input))
	if len(ds) != 1 || ds[0].RuleID != "yaml-syntax" || !strings.Contains(ds[0].Message, "already defined") {
		t.Fatalf("duplicate key diagnostics=%+v", ds)
	}
	project := &Project{Sources: map[string]*Source{source.Path: source}, Selected: map[string]bool{source.Path: true}}
	if got := Analyze(project, dockerRules()); len(got) != 1 || got[0].RuleID != "yaml-syntax" {
		t.Fatalf("analysis=%+v", got)
	}
}

func TestDockerLintDirectiveMentionsAreNotInstructions(t *testing.T) {
	input := "# Generated by saltbox-lint\n# See https://github.com/saltyorg/saltbox-lint\nvalue: true\n"
	if ds := dockerDiagnostics(t, input, "lint-directive"); len(ds) != 0 {
		t.Fatalf("ordinary comment prose became a directive: %+v", ds)
	}
}

func TestDockerHealthcheckNoneAllowanceAndAliases(t *testing.T) {
	input := "example_role_docker_healthcheck:\n  test: # saltbox-lint allow cmd-shell\n    - NONE\n"
	assertDockerDiagnostic(t, input, "lint-directive", "# saltbox-lint allow cmd-shell", "Remove", "NONE")
	input = "command: &command curl\nexample_role_docker_healthcheck:\n  test:\n    - CMD\n    - *command\n"
	assertDockerDiagnostic(t, input, "docker-healthcheck-shape", "test", "block list")
}

func TestDockerLintDirectivesRejectPlacementOutsideDefaults(t *testing.T) {
	input := "- name: Demonstrate misplaced directive\n  ansible.builtin.debug:\n    msg: hello # saltbox-lint allow cmd-shell\n"
	source, ds := Parse("roles/example/tasks/main.yml", []byte(input))
	if len(ds) > 0 {
		t.Fatal(ds)
	}
	project := &Project{Sources: map[string]*Source{source.Path: source}, Selected: map[string]bool{source.Path: true}}
	got := Analyze(project, dockerRules())
	if len(got) != 1 || got[0].RuleID != "lint-directive" || input[got[0].Span.Start:got[0].Span.End] != "# saltbox-lint allow cmd-shell" {
		t.Fatalf("misplaced task directive: %+v", got)
	}
}
