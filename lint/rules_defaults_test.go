package lint

import (
	"os"
	"slices"
	"strings"
	"testing"
)

var defaultsRuleIDs = []string{
	"role-variable-prefix",
	"defaults-sections",
	"computed-default-documentation",
	"role-docker-state",
	"docker-image-contract",
	"role-lookup-target",
	"role-web-contract",
	"role-var-empty-default",
}

func defaultsProject(t *testing.T, path, input string) *Project {
	t.Helper()
	source, diagnostics := Parse(path, []byte(input))
	if len(diagnostics) != 0 {
		t.Fatalf("parse diagnostics: %+v", diagnostics)
	}
	if source.Kind != Defaults || source.Role == "" {
		t.Fatalf("source identity: kind=%q role=%q role_path=%q", source.Kind, source.Role, source.RolePath)
	}
	return &Project{
		Root:     "/project",
		Name:     "project",
		Sources:  map[string]*Source{source.Path: source},
		Selected: map[string]bool{source.Path: true},
	}
}

func defaultsRules() []Rule {
	var rules []Rule
	for _, rule := range Rules() {
		if slices.Contains(defaultsRuleIDs, rule.ID) {
			rules = append(rules, rule)
		}
	}
	return rules
}

func defaultsDiagnostics(t *testing.T, path, input string, ids ...string) []Diagnostic {
	t.Helper()
	rules := defaultsRules()
	if len(ids) > 0 {
		rules = slices.DeleteFunc(rules, func(rule Rule) bool { return !slices.Contains(ids, rule.ID) })
	}
	return Analyze(defaultsProject(t, path, input), rules)
}

func assertSingleDefaultsDiagnostic(t *testing.T, path, input, id, spanText string, expectedParts ...string) Diagnostic {
	t.Helper()
	project := defaultsProject(t, path, input)
	diagnostics := Analyze(project, defaultsRules())
	var matches []Diagnostic
	for _, diagnostic := range diagnostics {
		if diagnostic.RuleID == id {
			matches = append(matches, diagnostic)
		}
	}
	if len(matches) != 1 {
		t.Fatalf("%s diagnostics=%+v", id, diagnostics)
	}
	diagnostic := matches[0]
	source := project.Sources[path]
	if got := string(source.Data[diagnostic.Span.Start:diagnostic.Span.End]); got != spanText {
		t.Fatalf("%s span=%q want %q (%+v)", id, got, spanText, diagnostic.Span)
	}
	for _, part := range expectedParts {
		if !strings.Contains(diagnostic.Expected, part) {
			t.Errorf("%s expected hint %q in %q", id, part, diagnostic.Expected)
		}
	}
	if diagnostic.Fix != nil {
		t.Fatalf("%s offered semantic fix: %+v", id, diagnostic.Fix)
	}
	return diagnostic
}

func TestDefaultsRuleFixtures(t *testing.T) {
	valid, err := os.ReadFile("testdata/defaults/canonical.good.yml")
	if err != nil {
		t.Fatal(err)
	}
	if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/nested/main.yml", string(valid)); len(diagnostics) != 0 {
		t.Fatalf("valid fixture diagnostics: %+v", diagnostics)
	}

	invalid, err := os.ReadFile("testdata/defaults/violations.bad.yml")
	if err != nil {
		t.Fatal(err)
	}
	diagnostics := defaultsDiagnostics(t, "roles/example/defaults/nested/main.yml", string(invalid))
	got := make([]string, 0, len(diagnostics))
	for _, diagnostic := range diagnostics {
		got = append(got, diagnostic.RuleID)
		if diagnostic.Expected == "" || diagnostic.Fix != nil {
			t.Errorf("incomplete semantic diagnostic: %+v", diagnostic)
		}
	}
	slices.Sort(got)
	want := slices.Clone(defaultsRuleIDs)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("rule IDs=%v want %v; diagnostics=%+v", got, want, diagnostics)
	}
}

func TestRoleVariablePrefixUsesExactRoleIdentity(t *testing.T) {
	for _, test := range []struct {
		path, input, span, wantPrefix string
	}{
		{"roles/example/defaults/nested/main.yml", "other_role_enabled: true\n", "other_role_enabled", "example_"},
		{"resources/roles/shared_helper/defaults/private/options.yml", "wrong_role_enabled: true\n", "wrong_role_enabled", "shared_helper_"},
	} {
		assertSingleDefaultsDiagnostic(t, test.path, test.input, "role-variable-prefix", test.span, test.wantPrefix)
	}

	input := "example_role_enabled: true\nexample_child_role_enabled: true\nnested:\n  other_role_value: allowed\nUpper_role_value: ignored\n"
	if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", input, "role-variable-prefix"); len(diagnostics) != 0 {
		t.Fatalf("valid prefixes diagnosed: %+v", diagnostics)
	}
}

func TestDefaultsSectionsRequireOnlyCanonicalUniqueOrder(t *testing.T) {
	valid := "description: |-\n  ################################\n  # Docker\n  ################################\nquoted: '# Basics'\n################################\n# Basics\n################################\n################################\n# Unknown\n################################\n################################\n# Docker\n################################\nvalue: true\n"
	if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", valid, "defaults-sections"); len(diagnostics) != 0 {
		t.Fatalf("valid optional sections diagnosed: %+v", diagnostics)
	}

	outOfOrder := "################################\n# Web\n################################\n################################\n# Paths\n################################\nvalue: true\n"
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", outOfOrder, "defaults-sections", "# Paths", "Paths", "before", "Web")

	duplicate := "################################\n# Basics\n################################\nvalue: true\n################################\n# Basics\n################################\n"
	diagnostic := assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", duplicate, "defaults-sections", "# Basics", "Declare", "once")
	if len(diagnostic.Related) != 1 || diagnostic.Related[0].Message == "" {
		t.Fatalf("duplicate lacks first declaration: %+v", diagnostic)
	}
}

func TestDefaultsSectionsIgnoreExactBannersInsideMultilineQuotedScalars(t *testing.T) {
	quoted := `description: "start
################################
# Docker
################################
################################
# Basics
################################
################################
# Basics
################################
end"
flow: ["################################", "# Web", "################################"]
`
	if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", quoted, "defaults-sections"); len(diagnostics) != 0 {
		t.Fatalf("quoted banner content diagnosed: %+v", diagnostics)
	}

	realComments := `description: "# Web"
################################
# Docker
################################
################################
# Basics
################################
value: true
`
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", realComments, "defaults-sections", "# Basics", "before", "Docker")
}

func TestComputedDefaultsRequireExactImmediateDirective(t *testing.T) {
	for _, directive := range []string{"# Skip docs", "# Do not edit or override using the inventory"} {
		input := directive + "\nexample_role_secret_lookup: value\n"
		if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", input, "computed-default-documentation"); len(diagnostics) != 0 {
			t.Fatalf("supported directive %q diagnosed: %+v", directive, diagnostics)
		}
	}

	for _, input := range []string{
		"example_role_secret_lookup: value\n",
		"# Skip docs\n\nexample_role_secret_lookup: value\n",
		"  # Skip docs\nexample_role_secret_lookup: value\n",
	} {
		assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", input, "computed-default-documentation", "example_role_secret_lookup", "# Skip docs", "immediately")
	}

	valid := "# Title: example_role_fake_lookup: value\nother_role_secret_lookup: value\nnested:\n  example_role_nested_lookup: value\n"
	if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", valid, "computed-default-documentation"); len(diagnostics) != 0 {
		t.Fatalf("non-owner or nested declarations diagnosed: %+v", diagnostics)
	}

	multiple := "example_role_first_lookup: value\nexample_role_second_lookup: value\n"
	if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", multiple, "computed-default-documentation"); len(diagnostics) != 2 {
		t.Fatalf("all undocumented computed defaults must be reported: %+v", diagnostics)
	}
}

func TestDockerImageContractRequiresCompanionsAndExplicitReads(t *testing.T) {
	missingDefaults := "example_role_docker_image: example/app:latest\n"
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", missingDefaults, "docker-image-contract", "example_role_docker_image", "example_role_docker_image_repo", "example_role_docker_image_tag")

	missingRead := "example_role_docker_image_repo: example/app\nexample_role_docker_image_tag: latest\nexample_role_docker_image: \"{{ lookup('role_var', '_docker_image_repo', role='example') }}:latest\"\n"
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", missingRead, "docker-image-contract", "example_role_docker_image", "_docker_image_tag", "role='example'")

	wrongTarget := "example_role_docker_image_repo: example/app\nexample_role_docker_image_tag: latest\nexample_role_docker_image: \"{{ lookup('role_var', '_docker_image_repo', role='other') }}:{{ lookup('role_var', '_docker_image_tag', role='other') }}\"\n"
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", wrongTarget, "docker-image-contract", "example_role_docker_image", "_docker_image_repo", "_docker_image_tag", "role='example'")

	validResource := "shared_role_docker_image_repo: example/app\nshared_role_docker_image_tag: latest\nshared_role_docker_image: \"{{ lookup('role_var', '_docker_image_repo', role='shared') }}:{{ lookup('role_var', '_docker_image_tag', role='shared') }}\"\n"
	if diagnostics := defaultsDiagnostics(t, "resources/roles/shared/defaults/sub/main.yml", validResource, "docker-image-contract"); len(diagnostics) != 0 {
		t.Fatalf("resource image diagnosed: %+v", diagnostics)
	}
}

func TestRoleDockerStateRejectsOnlyTopLevelDeclarations(t *testing.T) {
	input := "nested:\n  example_role_docker_state: started\nmessage: 'example_role_docker_state: started'\n"
	if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", input, "role-docker-state"); len(diagnostics) != 0 {
		t.Fatalf("non-declarations diagnosed: %+v", diagnostics)
	}
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", input+"example_role_docker_state: started\n", "role-docker-state", "example_role_docker_state", "shared Docker helper", "state")
}

func TestDefaultsRuleExamplesDemonstratePolicy(t *testing.T) {
	for _, rule := range defaultsRules() {
		for _, test := range []struct {
			input   string
			invalid bool
		}{{rule.GoodExample, false}, {rule.BadExample, true}} {
			diagnostics := Analyze(defaultsProject(t, "roles/example/defaults/main.yml", test.input), []Rule{rule})
			if (len(diagnostics) > 0) != test.invalid {
				t.Errorf("%s example invalid=%v diagnostics=%+v", rule.ID, test.invalid, diagnostics)
			}
		}
	}
}
