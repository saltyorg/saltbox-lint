package lint

import (
	"os"
	"slices"
	"strings"
	"testing"
)

var dockerRuleIDs = []string{"docker-aggregate-contract", "docker-empty-layers", "docker-healthcheck-shape", "docker-healthcheck-mode", "lint-directive"}

func dockerRules(ids ...string) []Rule {
	if len(ids) == 0 {
		ids = dockerRuleIDs
	}
	var rules []Rule
	for _, rule := range Rules() {
		if slices.Contains(ids, rule.ID) {
			rules = append(rules, rule)
		}
	}
	return rules
}
func dockerDiagnostics(t *testing.T, input string, ids ...string) []Diagnostic {
	t.Helper()
	return Analyze(defaultsProject(t, "roles/example/defaults/nested/main.yaml", input), dockerRules(ids...))
}
func assertDockerDiagnostic(t *testing.T, input, id, span string, hints ...string) {
	t.Helper()
	ds := dockerDiagnostics(t, input, id)
	if len(ds) != 1 {
		t.Fatalf("%s diagnostics=%+v", id, ds)
	}
	d := ds[0]
	if got := input[d.Span.Start:d.Span.End]; got != span {
		t.Errorf("span=%q want=%q", got, span)
	}
	for _, hint := range hints {
		if !strings.Contains(d.Expected, hint) {
			t.Errorf("hint %q missing from %q", hint, d.Expected)
		}
	}
	if d.Fix != nil {
		t.Errorf("semantic fix=%+v", d.Fix)
	}
}
func TestDockerAggregateLayers(t *testing.T) {
	const prefix = "example_role_docker_ports_default: [8080]\nexample_role_docker_ports_custom: []\nexample_role_docker_ports: "
	for _, tc := range []struct{ name, expression, hint string }{
		{"direct", "example_role_docker_ports_default + example_role_docker_ports_custom", "role='example'"},
		{"missing", "lookup('role_var', '_docker_ports_default', role='example')", "_custom"},
		{"wrong role", "lookup('role_var', '_docker_ports_default', role='other') + lookup('role_var', '_docker_ports_custom', role='example')", "role='example'"},
		{"extra arguments", "lookup('role_var', '_docker_ports_default', role='example', default=[]) + lookup('role_var', '_docker_ports_custom', role='example')", "role='example'"},
		{"reversed", "lookup('role_var', '_docker_ports_custom', role='example') + lookup('role_var', '_docker_ports_default', role='example')", "before"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertDockerDiagnostic(t, prefix+"\"{{ "+tc.expression+" }}\"\n", "docker-aggregate-contract", "example_role_docker_ports", tc.hint)
		})
	}
	input := prefix + "\"{{ common_ports + lookup('role_var', '_docker_ports_default', role='example') + lookup('role_var', '_docker_ports_custom', role='example') }}\"\n"
	if ds := dockerDiagnostics(t, input); len(ds) != 0 {
		t.Fatal(ds)
	}
	// Missing pairs and quoted call text do not invent aggregate contracts.
	input = "example_role_docker_ports_default: []\nexample_role_docker_ports: literal\nother: \"lookup('role_var', '_docker_envs_custom', role='example')\"\n"
	if ds := dockerDiagnostics(t, input); len(ds) != 0 {
		t.Fatal(ds)
	}
}

func TestDockerNetworkFormula(t *testing.T) {
	const layers = " + lookup('role_var', '_docker_networks_default', role='example') + lookup('role_var', '_docker_networks_custom', role='example')"
	const pinned = "(docker_networks_common | map('combine', {'driver_opts': {'com.docker.network.endpoint.ifname': 'eth1'}}) | list)"
	for _, tc := range []struct {
		name, prefix, tail, defaults string
		bad                          bool
		hint                         string
	}{
		{"standard", "docker_networks_common", "", "[]", false, ""},
		{"pinned", pinned, "", "[{name: app, driver_opts: {com.docker.network.endpoint.ifname: eth0}}]", false, ""},
		{"common collision", pinned, "", "[{driver_opts: {com.docker.network.endpoint.ifname: eth1}}]", true, "distinct"},
		{"no application pin", pinned, "", "[]", true, "pin"},
		{"extra source", "docker_networks_common", " + extra", "[]", true, "docker_networks_common"},
		{"extra conditional", "docker_networks_common", " if enabled else []", "[]", true, "docker_networks_common"},
		{"wrong common", "docker_networks_other", "", "[]", true, "docker_networks_common"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := "example_role_docker_networks_default: " + tc.defaults + "\nexample_role_docker_networks_custom: []\nexample_role_docker_networks: \"{{ " + tc.prefix + layers + tc.tail + " }}\"\n"
			if tc.bad {
				assertDockerDiagnostic(t, input, "docker-aggregate-contract", "example_role_docker_networks", tc.hint)
			} else if ds := dockerDiagnostics(t, input); len(ds) != 0 {
				t.Fatal(ds)
			}
		})
	}
	assertDockerDiagnostic(t, "example_role_docker_networks: []\n", "docker-aggregate-contract", "example_role_docker_networks", "_default", "_custom")
}

func TestDockerHostsFormula(t *testing.T) {
	const base = "example_role_docker_hosts_default: {local: 127.0.0.1}\nexample_role_docker_hosts_custom: {}\nexample_role_docker_hosts: "
	const formula = "lookup('role_var', '_docker_hosts_default', role='example') | combine(lookup('role_var', '_docker_hosts_custom', role='example'))"
	if ds := dockerDiagnostics(t, base+"\"{{ "+formula+" }}\"\n"); len(ds) != 0 {
		t.Fatal(ds)
	}
	for _, expr := range []string{"docker_hosts_common | combine(" + formula + ")", formula + " | combine(extra)", "lookup('role_var', '_docker_hosts_custom', role='example') | combine(lookup('role_var', '_docker_hosts_default', role='example'))"} {
		assertDockerDiagnostic(t, base+"\"{{ "+expr+" }}\"\n", "docker-aggregate-contract", "example_role_docker_hosts", "role-local")
	}
	assertDockerDiagnostic(t, "example_role_docker_hosts: {}\n", "docker-aggregate-contract", "example_role_docker_hosts", "_default", "_custom")
}

func TestDockerEnvironmentCustomFinalLayer(t *testing.T) {
	const lookup = "lookup('role_var', '_docker_envs_custom', role='example')"
	const base = "example_role_docker_envs_default: {A: B}\nexample_role_docker_envs_custom: {}\n"
	valid := base + "example_role_docker_envs: \"{{ docker_envs_common | combine(lookup('role_var', '_docker_envs_default', role='example')) | combine(extra) | combine(" + lookup + ") }}\"\n"
	if ds := dockerDiagnostics(t, valid); len(ds) != 0 {
		t.Fatal(ds)
	}
	for _, tc := range []struct{ name, expr, span, hint string }{
		{"other aggregate", "other: \"{{ " + lookup + " }}\"\n", lookup, "example_role_docker_envs"},
		{"wrong role", "example_role_docker_envs: \"{{ common | combine(lookup('role_var', '_docker_envs_custom', role='other')) }}\"\n", "example_role_docker_envs", "other_role_docker_envs"},
		{"dynamic role", "other: \"{{ lookup('role_var', '_docker_envs_custom', role=owner) }}\"\n", "lookup('role_var', '_docker_envs_custom', role=owner)", "literal"},
		{"direct", "other: \"{{ example_role_docker_envs_custom }}\"\n", "example_role_docker_envs_custom", "role_var"},
		{"nonfinal", "example_role_docker_envs: \"{{ lookup('role_var', '_docker_envs_default', role='example') | combine(" + lookup + ") | combine(extra) }}\"\n", "example_role_docker_envs", "final"},
		{"direct argument", "example_role_docker_envs: \"{{ lookup('role_var', '_docker_envs_default', role='example') + " + lookup + " }}\"\n", "example_role_docker_envs", "final"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertDockerDiagnostic(t, base+tc.expr, "docker-aggregate-contract", tc.span, tc.hint)
		})
	}
	// Names occurring as attribute/filter/keyword or string data are not global reads.
	input := "v: \"{{ thing.example_role_docker_envs_custom | example_role_docker_envs_custom(example_role_docker_envs_custom='text') }}\"\nq: \"{{ 'example_role_docker_envs_custom' }}\"\n"
	if ds := dockerDiagnostics(t, input); len(ds) != 0 {
		t.Fatal(ds)
	}
}

func TestDockerEmptyLayerExceptions(t *testing.T) {
	for _, tc := range []struct {
		name, kind, expression string
		bad                    bool
	}{
		{"missing aggregate", "[]", "", true},
		{"list pair", "[]", "lookup('role_var', '_docker_ports_default', role='example') + lookup('role_var', '_docker_ports_custom', role='example')", true},
		{"map pair", "{}", "lookup('role_var', '_docker_ports_default', role='example') | combine(lookup('role_var', '_docker_ports_custom', role='example'))", true},
		{"meaningful source", "[]", "common + lookup('role_var', '_docker_ports_default', role='example') + lookup('role_var', '_docker_ports_custom', role='example')", false},
		{"meaningful map", "{}", "lookup('role_var', '_docker_ports_default', role='example') | combine(extra) | combine(lookup('role_var', '_docker_ports_custom', role='example'))", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := "example_role_docker_ports_default: " + tc.kind + " # empty\nexample_role_docker_ports_custom: " + tc.kind + "\n"
			span := "example_role_docker_ports_default"
			if tc.expression != "" {
				input += "example_role_docker_ports: \"{{ " + tc.expression + " }}\"\n"
				span = "example_role_docker_ports"
			}
			if tc.bad {
				assertDockerDiagnostic(t, input, "docker-empty-layers", span, "omit")
			} else if ds := dockerDiagnostics(t, input, "docker-empty-layers"); len(ds) != 0 {
				t.Fatal(ds)
			}
		})
	}
	for _, input := range []string{"example_role_docker_networks_default: []\nexample_role_docker_networks_custom: []\n", "example_role_docker_ports_default: []\nexample_role_docker_ports_custom: {}\n", "example_role_docker_ports_default: [80]\nexample_role_docker_ports_custom: []\n"} {
		if ds := dockerDiagnostics(t, input, "docker-empty-layers"); len(ds) != 0 {
			t.Fatal(ds)
		}
	}
}

func TestDockerRuleFixturesAndMetadata(t *testing.T) {
	for _, name := range []string{"canonical.good.yml", "violations.bad.yml"} {
		input, err := os.ReadFile("testdata/docker/" + name)
		if err != nil {
			t.Fatal(err)
		}
		ds := dockerDiagnostics(t, string(input))
		var got []string
		for _, d := range ds {
			got = append(got, d.RuleID)
			if d.Expected == "" || d.Fix != nil {
				t.Errorf("incomplete diagnostic %+v", d)
			}
		}
		slices.Sort(got)
		var want []string
		if name == "violations.bad.yml" {
			want = slices.Clone(dockerRuleIDs)
			slices.Sort(want)
		}
		if !slices.Equal(got, want) {
			t.Errorf("%s got=%v want=%v", name, got, want)
		}
	}
	rules := dockerRules()
	if len(rules) != 5 {
		t.Fatalf("registered=%d want 5", len(rules))
	}
	for _, rule := range rules {
		t.Run(rule.ID, func(t *testing.T) {
			if rule.Fixable || rule.Scope != "file" || rule.Explanation == "" || rule.Summary == "" {
				t.Errorf("incomplete metadata %+v", rule)
			}
			if ds := dockerDiagnostics(t, rule.GoodExample, rule.ID); len(ds) != 0 {
				t.Errorf("good example: %+v", ds)
			}
			if ds := dockerDiagnostics(t, rule.BadExample, rule.ID); len(ds) == 0 {
				t.Error("bad example produced no diagnostic")
			}
		})
	}
}

func TestDockerEnvironmentCustomBindingsAndTestNamesAreNotReads(t *testing.T) {
	input := "v: |\n  {% for example_role_docker_envs_custom in values %}\n  {% endfor %}\n  {% macro show(example_role_docker_envs_custom) %}\n  {% endmacro %}\n  {{ value is not example_role_docker_envs_custom }}\n"
	if ds := dockerDiagnostics(t, input, "docker-aggregate-contract"); len(ds) != 0 {
		t.Fatalf("binding/test positions diagnosed: %+v", ds)
	}
	input = "v: |\n  {% macro show(arg=example_role_docker_envs_custom) %}\n  {% endmacro %}\n"
	assertDockerDiagnostic(t, input, "docker-aggregate-contract", "example_role_docker_envs_custom", "role_var")
}

func TestDockerNetworkPinsStayWithinSupportedOwnership(t *testing.T) {
	const formula = "example_role_docker_networks: \"{{ (docker_networks_common | map('combine', {'driver_opts': {'com.docker.network.endpoint.ifname': 'eth1'}}) | list) + lookup('role_var', '_docker_networks_default', role='example') + lookup('role_var', '_docker_networks_custom', role='example') }}\"\n"
	// The retained contract requires at least one application pin and no collision
	// with common. It does not require every app entry pinned or pairwise unique.
	input := "example_role_docker_networks_default: [{driver_opts: {com.docker.network.endpoint.ifname: eth0}}, {name: unpinned}, {driver_opts: {com.docker.network.endpoint.ifname: eth0}}]\nexample_role_docker_networks_custom: []\n" + formula
	if ds := dockerDiagnostics(t, input); len(ds) != 0 {
		t.Fatal(ds)
	}
	// An unrelated dictionary containing the spelling is not an application pin.
	input = "example_role_docker_networks_default: [{payload: {com.docker.network.endpoint.ifname: eth0}}]\nexample_role_docker_networks_custom: []\n" + formula
	assertDockerDiagnostic(t, input, "docker-aggregate-contract", "example_role_docker_networks", "Pin")
}

func TestDockerAggregateCompanionsRemainFileLocal(t *testing.T) {
	selected, ds := Parse("resources/roles/example/defaults/nested/main.yaml", []byte("example_role_docker_networks: []\n"))
	if len(ds) > 0 {
		t.Fatal(ds)
	}
	sibling, ds := Parse("resources/roles/example/defaults/other.yml", []byte("example_role_docker_networks_default: []\nexample_role_docker_networks_custom: []\n"))
	if len(ds) > 0 {
		t.Fatal(ds)
	}
	project := &Project{Sources: map[string]*Source{selected.Path: selected, sibling.Path: sibling}, Selected: map[string]bool{selected.Path: true}}
	got := Analyze(project, dockerRules())
	if len(got) != 1 || got[0].Path != selected.Path || got[0].RuleID != "docker-aggregate-contract" || !strings.Contains(got[0].Expected, "companion") {
		t.Fatalf("cross-file defaults changed contract: %+v", got)
	}
}

func TestDockerEnvironmentBlockSetFilterReads(t *testing.T) {
	input := "v: |\n  {% set example_role_docker_envs_custom | trim %}body{% endset %}\n"
	if ds := dockerDiagnostics(t, input, "docker-aggregate-contract"); len(ds) != 0 {
		t.Fatalf("block set binding diagnosed: %+v", ds)
	}
	input = "v: |\n  {% set captured | default(example_role_docker_envs_custom) %}body{% endset %}\n"
	assertDockerDiagnostic(t, input, "docker-aggregate-contract", "example_role_docker_envs_custom", "role_var")
}

func TestDockerEnvironmentCustomFollowsCompleteConditionalBase(t *testing.T) {
	for _, name := range []string{"conditional-env.good.yml", "conditional-env.bad.yml"} {
		input, err := os.ReadFile("testdata/docker/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(name, ".bad.") {
			assertDockerDiagnostic(t, string(input), "docker-aggregate-contract", "example_role_docker_envs", "final", "(base if enabled else {}) | combine(")
		} else if ds := dockerDiagnostics(t, string(input)); len(ds) != 0 {
			t.Fatalf("grouped complete base diagnosed: %+v", ds)
		}
	}
	const header = "example_role_docker_envs_default: {BASE: value}\nexample_role_docker_envs_custom: {}\nexample_role_docker_envs: "
	const def = "lookup('role_var', '_docker_envs_default', role='example')"
	const custom = "lookup('role_var', '_docker_envs_custom', role='example')"
	for _, base := range []string{def, "(" + def + " if enabled else ({} if other else {}))", def + " | combine({'key': a if enabled else b})", def + " | combine({'if': 'else'})"} {
		input := header + "\"{{ " + base + " | combine(" + custom + ") }}\"\n"
		if ds := dockerDiagnostics(t, input); len(ds) != 0 {
			t.Fatalf("complete base %s diagnosed: %+v", base, ds)
		}
	}
	for _, base := range []string{def + " if enabled else {}", def + " if enabled else {} if other else {}"} {
		input := header + "\"{{ " + base + " | combine(" + custom + ") }}\"\n"
		assertDockerDiagnostic(t, input, "docker-aggregate-contract", "example_role_docker_envs", "(base if enabled else {}) | combine(")
	}
}
