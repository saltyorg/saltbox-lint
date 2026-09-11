package lint

import (
	"strings"
	"testing"
)

func TestTraefikAPIEndpointLiterals(t *testing.T) {
	cases := []struct {
		name, value string
		invalid     bool
	}{
		{"empty", `""`, false},
		{"prefix", "'PathPrefix(`/api`)'", false},
		{"boolean rule", "'!(Path(`/private`) || Method(`POST`)) && Host(`example.com`)'", false},
		{"quoted and escaped", `'Header("X-Value", "a\"b")'`, false},
		{"lowercase", "'pathprefix(`/api`)'", false},
		{"uppercase", "'PATHPREFIX(`/api`)'", false},
		{"title lowercase", "'Pathprefix(`/api`)'", false},
		{"arbitrary method", "'Method(`CUSTOM`)'", false},
		{"host regex", "'HostRegexp(`^[a-z]+[.]example[.]com$`)'", false},
		{"path regex need not start slash", "'PathRegexp(`api$`)'", false},
		{"header regex", "'HeaderRegexp(`X-Value`, `^a+$`)'", false},
		{"query key", "'Query(`flag`)'", false},
		{"query value", "'Query(`flag`, `yes`)'", false},
		{"query regex key is not regex", "'QueryRegexp(`[`)'", false},
		{"query regex value", "'QueryRegexp(`flag`, `^yes$`)'", false},
		{"ipv4", "'ClientIP(`192.0.2.1`)'", false},
		{"ipv6", "'ClientIP(`2001:db8::1`)'", false},
		{"cidr", "'ClientIP(`192.0.2.0/24`)'", false},
		{"bare path", `"/api"`, true},
		{"whitespace", `" "`, true},
		{"missing close", "'PathPrefix(`/api`'", true},
		{"trailing input", "'Path(`/api`) garbage'", true},
		{"unknown matcher", "'Unknown(`/api`)'", true},
		{"v2 headers", "'Headers(`X-Key`, `value`)'", true},
		{"mixed case", "'pAtHpReFiX(`/api`)'", true},
		{"zero args", "'PathPrefix()'", true},
		{"many args", "'Path(`/a`, `/b`)'", true},
		{"header missing value", "'Header(`X-Key`)'", true},
		{"query too many", "'Query(`a`, `b`, `c`)'", true},
		{"empty argument", "'PathPrefix(``)'", true},
		{"empty query value", "'Query(`flag`, ``)'", true},
		{"non-string argument", "'Method(42)'", true},
		{"rune argument", `"Method('G')"`, true},
		{"variable argument", "'PathPrefix(endpoint)'", true},
		{"computed argument", "'PathPrefix(`/` + `api`)'", true},
		{"parenthesized argument", "'PathPrefix((`/api`))'", true},
		{"nested call", "'PathPrefix(Path(`/api`))'", true},
		{"comparison", "'Path(`/api`) == Path(`/api`)'", true},
		{"binary bitwise", "'Path(`/api`) | Path(`/other`)'", true},
		{"invalid unary", "'-Path(`/api`)'", true},
		{"literal boolean", "'true'", true},
		{"path lacks slash", "'Path(`api`)'", true},
		{"prefix lacks slash", "'PathPrefix(`api`)'", true},
		{"invalid path regex", "'PathRegexp(`[`)'", true},
		{"invalid host regex", "'HostRegexp(`[`)'", true},
		{"invalid header regex", "'HeaderRegexp(`X-Key`, `[`)'", true},
		{"invalid query regex", "'QueryRegexp(`key`, `[`)'", true},
		{"unicode host", "'Host(`é.example`)'", true},
		{"unicode host regex", "'HostRegexp(`é[.]example`)'", true},
		{"invalid ip", "'ClientIP(`example.com`)'", true},
		{"invalid cidr", "'ClientIP(`192.0.2.0/33`)'", true},
		{"boolean", "false", true},
		{"number", "42", true},
		{"null", "null", true},
		{"sequence", "[]", true},
		{"mapping", "{}", true},
		{"explicit boolean", "!!bool 'false'", true},
		{"explicit number", "!!int '42'", true},
		{"explicit string", "!!str 'Path(`/api`)'", false},
		{"explicit string number", "!!str 42", true},
		{"unsafe valid", "!unsafe 'Path(`/api`)'", false},
		{"unsafe lookup", `!unsafe "{{ lookup('vars', 'endpoint') }}"`, true},
		{"lookup expression", `"{{ lookup('vars', 'endpoint') }}"`, false},
		{"role lookup", `"{{ lookup('role_var', '_traefik_api_endpoint', role='example') }}"`, false},
		{"runtime variable", `"{{ endpoint }}"`, false},
		{"runtime rule interpolation", "'PathPrefix(`{{ endpoint }}`)'", false},
		{"literal lookup mention", `"lookup('vars', 'endpoint')"`, true},
		{"valid trailing comment", "'PathPrefix(`/api`) {# lookup example #}'", false},
		{"valid leading comment", "'{# lookup example #}PathPrefix(`/api`)'", false},
		{"comment only empty default", "'{# lookup example #}'", false},
		{"comment removed inside argument", "'PathPrefix(`{# note #}/api`)'", false},
		{"comment left whitespace control", "'PathPrefix(`  {#- note #}/api`)'", false},
		{"comment right whitespace control", "'PathPrefix(`{# note -#}  /api`)'", false},
		{"comment plus preserves whitespace", "'PathPrefix(` {#+ note +#}/api`)'", true},
		{"comment does not trim by default", "'PathPrefix(` {# note #}/api`)'", true},
		{"left trim stops at previous comment valid query", "'Query(` {# first #}{#- second #}`)'", false},
		{"left trim stops at previous comment invalid path", "'PathPrefix(` {# first #}{#- second #}/api`)'", true},
		{"left trim removes only intervening whitespace", "'PathPrefix(` {# first #}  {#- second #}/api`)'", true},
		{"adjacent left controls each trim own segment", "'PathPrefix(` {#- first #}  {#- second #}/api`)'", false},
		{"right then left control preserves earlier whitespace", "'PathPrefix(` {# first -#}  {#- second #}/api`)'", true},
		{"right then left control removes following whitespace", "'PathPrefix(`{# first -#}  {#- second -#}  /api`)'", false},
		{"multiple comments", "'{# first #}PathPrefix(`{# second #}/api`){# third #}'", false},
		{"raw wrapper", "'{% raw %}PathPrefix(`/api`){% endraw %}'", false},
		{"raw invalid rule deferred", "'{%- raw -%}/api{%- endraw -%}'", false},
		{"comment raw mention no bypass", "'/api {# {% raw %} lookup example #}'", true},
		{"comment runtime mention no bypass", "'/api {# {{ lookup(unknown) }} #}'", true},
		{"comment raw mention valid rule", "'Path(`/api`) {# {% raw %} #}'", false},
		{"unsafe trailing comment", "!unsafe 'PathPrefix(`/api`) {# lookup example #}'", true},
		{"unsafe raw wrapper", "!unsafe '{% raw %}PathPrefix(`/api`){% endraw %}'", true},
		{"unsafe comment is argument data", "!unsafe 'PathPrefix(`/api{# note #}`)'", false},
		{"comment lookup mention", `"/api {# lookup('vars', 'endpoint') #}"`, true},
		{"valid literal lookup argument", "'Header(`X-Lookup`, `lookup(vars)`)'", false},
		{"literal lookup argument", "'PathPrefix(`lookup(vars)`)'", true},
		{"alias unresolved", "*endpoint", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, name := range []string{"example_role_traefik_api_endpoint", "example_role_nginx_traefik_api_endpoint"} {
				input := "endpoint: &endpoint /api\n" + name + ": " + tc.value + "\n"
				p := traefikProject(map[string]string{traefikDefaultsPath: input})
				if ds := p.Sources[traefikDefaultsPath].parseDiagnostics; len(ds) != 0 {
					t.Fatalf("invalid test YAML: %+v", ds)
				}
				ds := Analyze(p, traefikRules("traefik-api-contract"))
				want := 0
				if tc.invalid {
					want = 1
				}
				if len(ds) != want {
					t.Fatalf("%s: diagnostics=%+v want %d", name, ds, want)
				}
				if want != 0 {
					assertTraefikDiagnostic(t, p, ds[0], traefikDefaultsPath, tc.value)
					if !strings.Contains(ds[0].Expected, "PathPrefix(`/api`)") {
						t.Fatalf("missing useful rule hint: %+v", ds[0])
					}
				}
				if string(p.Sources[traefikDefaultsPath].Data) != input {
					t.Fatal("source bytes changed")
				}
			}
		})
	}
}

func TestTraefikAPIEndpointScope(t *testing.T) {
	input := "other_role_traefik_api_endpoint: /api\nexample_role_endpoint: /api\nnested:\n  example_role_traefik_api_endpoint: /api\nexample_role_traefik_api_endpoint_suffix: /api\n"
	p := traefikProject(map[string]string{traefikDefaultsPath: input, traefikTasksPath: "example_role_traefik_api_endpoint: /api\n"})
	if ds := Analyze(p, traefikRules("traefik-api-contract")); len(ds) != 0 {
		t.Fatalf("unrelated fields diagnosed: %+v", ds)
	}
	for _, selected := range []string{traefikDefaultsPath, traefikTasksPath} {
		p = traefikProject(map[string]string{traefikDefaultsPath: "example_role_traefik_api_endpoint: /api\n", traefikTasksPath: "[]\n"})
		p.Selected = map[string]bool{selected: true}
		ds := Analyze(p, traefikRules("traefik-api-contract"))
		want := 0
		if selected == traefikDefaultsPath {
			want = 1
		}
		if len(ds) != want {
			t.Fatalf("selected %s: %+v", selected, ds)
		}
	}
}

func TestTraefikAPIEndpointFixtures(t *testing.T) {
	for _, tc := range []struct {
		name string
		want int
	}{{"endpoint.good.yml", 0}, {"endpoint.bad.yml", 3}} {
		t.Run(tc.name, func(t *testing.T) {
			p := traefikProject(map[string]string{traefikDefaultsPath: traefikFixture(t, tc.name)})
			ds := Analyze(p, traefikRules("traefik-api-contract"))
			if len(ds) != tc.want {
				t.Fatalf("diagnostics=%+v want %d", ds, tc.want)
			}
		})
	}
}
