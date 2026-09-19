package lint

import (
	"os"
	"strings"
	"testing"
)

func TestRoleLookupTargetUsesLiveStructuralCalls(t *testing.T) {
	input := `example_role_missing_var: "{{ lookup('role_var', '_value') }}"
example_role_missing_web: "{{ lookup('role_web', scheme='https') }}"
example_role_cross_var: "{{ lookup('role_var', '_value', role='other') }}"
example_role_cross_web: "{{ lookup('role_web', role='other') }}"
example_role_literal: '{{ "lookup(''role_var'', ''_ignored'')" }}'
# example_role_comment: "{{ lookup('role_web') }}"
`
	diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", input, "role-lookup-target")
	if len(diagnostics) != 2 {
		t.Fatalf("diagnostics=%+v", diagnostics)
	}
	for i, want := range []string{"lookup('role_var', '_value')", "lookup('role_web', scheme='https')"} {
		diagnostic := diagnostics[i]
		project := defaultsProject(t, "roles/example/defaults/main.yml", input)
		if got := string(project.Sources[diagnostic.Path].Data[diagnostic.Span.Start:diagnostic.Span.End]); got != want {
			t.Errorf("span=%q want %q", got, want)
		}
		if !strings.Contains(diagnostic.Expected, "role='example'") || diagnostic.Fix != nil {
			t.Errorf("diagnostic=%+v", diagnostic)
		}
	}

	assertSingleDefaultsDiagnostic(t, "resources/roles/shared_helper/defaults/private/main.yml", "shared_helper_role_value: \"{{ lookup('role_var', '_value') }}\"\n", "role-lookup-target", "lookup('role_var', '_value')", "role='shared_helper'")
}

func TestRoleWebContractRecognizesEndpointFamiliesAndFallback(t *testing.T) {
	valid := `example_role_web_subdomain: example
example_role_web_domain: example.com
example_role_web_host: "{{ lookup('role_web', role='example') }}"
example_role_web_url: "https://{{ lookup('role_var', '_web_host', role='example') }}"
example_role_web_insecure_url: "{{ lookup('role_web', role='example', scheme='http') }}"
example_role_api_subdomain: api
example_role_api_domain: example.com
example_role_api_host: "{{ lookup('role_web', endpoint='api', role='example') }}"
example_role_api_url: "{{ lookup('role_web', scheme='https', role='example', endpoint='api') }}"
example_role_api_insecure_url: "{{ lookup('role_web', role='example', endpoint='api', scheme='http') }}"
example_role_optional_url: ""
example_role_external: "{{ lookup('role_web', role='other') }}"
`
	if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", valid, "role-web-contract"); len(diagnostics) != 0 {
		t.Fatalf("valid endpoint families diagnosed: %+v", diagnostics)
	}

	wrongScheme := `example_role_api_subdomain: api
example_role_api_domain: example.com
example_role_api_url: "{{ lookup('role_web', role='example', endpoint='api', scheme='http') }}"
`
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", wrongScheme, "role-web-contract", "example_role_api_url", "role='example'", "endpoint='api'", "scheme='https'")

	incompleteDirect := "example_role_api_subdomain: api\nexample_role_api_url: \"{{ lookup('role_web', role='example', endpoint='api', scheme='https') }}\"\n"
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", incompleteDirect, "role-web-contract", "example_role_api_url", "matching", "subdomain", "domain")

	incompleteEmpty := "example_role_api_subdomain: api\nexample_role_api_url: \"\"\n"
	if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", incompleteEmpty, "role-web-contract"); len(diagnostics) != 0 {
		t.Fatalf("empty optional endpoint diagnosed: %+v", diagnostics)
	}

	nestedRoleWeb := "example_role_api_subdomain: api\nexample_role_api_url: \"{{ default('https://example.com', lookup('role_web', role='example', endpoint='api', scheme='https')) }}\"\n"
	if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", nestedRoleWeb, "role-web-contract"); len(diagnostics) != 0 {
		t.Fatalf("non-direct role_web call diagnosed as an incomplete family: %+v", diagnostics)
	}
}

func TestRoleWebContractParsesRoleNamedEndpointsAfterExactOwnerPrefix(t *testing.T) {
	for _, test := range []struct {
		name, path, owner string
	}{
		{"ordinary owner", "roles/example/defaults/main.yml", "example"},
		{"owner containing role marker", "roles/media_role_admin/defaults/nested/main.yml", "media_role_admin"},
	} {
		t.Run(test.name, func(t *testing.T) {
			prefix := test.owner + "_role_admin_role_api"
			valid := prefix + "_subdomain: admin\n" +
				prefix + "_domain: example.com\n" +
				prefix + "_url: \"{{ lookup('role_web', role='" + test.owner + "', endpoint='admin_role_api', scheme='https') }}\"\n"
			if diagnostics := defaultsDiagnostics(t, test.path, valid, "role-web-contract"); len(diagnostics) != 0 {
				t.Fatalf("valid role-named endpoint diagnosed: %+v", diagnostics)
			}

			invalid := prefix + "_subdomain: admin\n" +
				prefix + "_domain: example.com\n" +
				prefix + "_url: https://wrong.example\n"
			assertSingleDefaultsDiagnostic(t, test.path, invalid, "role-web-contract", prefix+"_url", "role='"+test.owner+"'", "endpoint='admin_role_api'", "scheme='https'")
		})
	}
}

func TestRoleWebContractReplacesDirectComponentCompositionOnce(t *testing.T) {
	input := `example_role_web_subdomain: example
example_role_web_domain: example.com
example_role_web_url: "{{ lookup('role_var', '_web_subdomain', role='example') }}.{{ lookup('role_var', '_web_domain', role='example') }}"
`
	diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", input, "role-web-contract")
	if len(diagnostics) != 1 {
		t.Fatalf("duplicate endpoint diagnostics: %+v", diagnostics)
	}
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", input, "role-web-contract", "example_role_web_url", "lookup('role_web'", "role='example'", "scheme='https'")

	crossRole := "example_role_external_host: \"{{ lookup('role_var', '_api_subdomain', role='other') }}.{{ lookup('role_var', '_api_domain', role='other') }}\"\n"
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", crossRole, "role-web-contract", "example_role_external_host", "role='other'", "endpoint='api'")

	mixedTargets := "example_role_external_host: \"{{ lookup('role_var', '_api_subdomain', role='one') }}.{{ lookup('role_var', '_api_domain', role='two') }}\"\n"
	if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", mixedTargets, "role-web-contract"); len(diagnostics) != 0 {
		t.Fatalf("unmatched component targets diagnosed: %+v", diagnostics)
	}

	ordered := "example_role_external_host: \"{{ lookup('role_var', '_first_subdomain', role='one') }}.{{ lookup('role_var', '_first_domain', role='one') }}.{{ lookup('role_var', '_second_subdomain', role='two') }}.{{ lookup('role_var', '_second_domain', role='two') }}\"\n"
	for range 20 {
		diagnostic := assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", ordered, "role-web-contract", "example_role_external_host", "role='one'", "endpoint='first'")
		if strings.Contains(diagnostic.Expected, "second") {
			t.Fatalf("later endpoint selected: %+v", diagnostic)
		}
	}
}

func TestRoleWebCompositionFixtures(t *testing.T) {
	for _, test := range []struct {
		file string
		want []string
	}{
		{"web-composition.good.yml", nil},
		{"web-composition.bad.yml", []string{"example_role_external_host", "example_role_joined_url", "example_role_grouped_host", "example_role_multiple_host"}},
	} {
		t.Run(test.file, func(t *testing.T) {
			data, err := os.ReadFile("testdata/defaults/" + test.file)
			if err != nil {
				t.Fatal(err)
			}
			input := string(data)
			project := defaultsProject(t, "roles/example/defaults/main.yml", input)
			diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", input, "role-web-contract")
			if len(diagnostics) != len(test.want) {
				t.Fatalf("diagnostics=%+v; want keys %q", diagnostics, test.want)
			}
			for i, d := range diagnostics {
				if got := string(project.Sources[d.Path].Data[d.Span.Start:d.Span.End]); got != test.want[i] {
					t.Errorf("diagnostic %d on %q; want %q", i, got, test.want[i])
				}
				if d.Fix != nil || !strings.Contains(d.Expected, "lookup('role_web'") {
					t.Errorf("diagnostic %d has invalid fix or hint: %+v", i, d)
				}
			}
			if test.file == "web-composition.bad.yml" && !strings.Contains(diagnostics[0].Expected, "role='other', endpoint='api'") {
				t.Errorf("cross-role hint: %+v", diagnostics[0])
			}
			if test.file == "web-composition.bad.yml" && !strings.Contains(diagnostics[3].Expected, "role='first', endpoint='api'") {
				t.Errorf("first-match hint: %+v", diagnostics[3])
			}
		})
	}
}

func TestRoleVarEmptyDefaultRecognizesOnlyRepeatedFallbackPattern(t *testing.T) {
	bad := "example_role_optional: \"{{ lookup('role_var', '_optional', role='example') if (lookup('role_var', '_optional', role='example') | length > 0) else omit }}\"\n"
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", bad, "role-var-empty-default", "if", "default=omit", "default_if_empty=true")

	badLookupFallback := "example_role_optional: \"{{ lookup('role_var', '_optional', role='example') if (lookup('role_var', '_optional', role='example') | length > 0) else lookup('role_var', '_fallback', role='other') }}\"\n"
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", badLookupFallback, "role-var-empty-default", "if", "default=lookup", "default_if_empty=true")

	valid := []string{
		"example_role_optional: \"{{ lookup('role_var', '_optional', role='example', default=omit, default_if_empty=true) }}\"\n",
		"example_role_optional: \"{{ lookup('role_var', '_optional', role='example') if (lookup('role_var', '_different', role='example') | length > 0) else omit }}\"\n",
		"example_role_optional: \"{{ lookup('role_var', '_optional', role='example') if (lookup('role_var', '_optional', role='other') | length > 0) else omit }}\"\n",
		"example_role_optional: \"\"\n",
		"example_role_literal: \"lookup('role_var', '_optional', role='example') if lookup(...) else omit\"\n",
	}
	for _, input := range valid {
		if diagnostics := defaultsDiagnostics(t, "roles/example/defaults/main.yml", input, "role-var-empty-default"); len(diagnostics) != 0 {
			t.Errorf("valid fallback %q diagnosed: %+v", input, diagnostics)
		}
	}
}

func TestLookupRulesRejectTestFilterAndBindingProvenance(t *testing.T) {
	for _, expression := range []string{
		"{{ data is lookup('role_var', '_value') }}",
		"{{ data is not lookup('role_var', '_value') }}",
		"{{ data | lookup('role_var', '_value') }}",
		"{% filter lookup('role_var', '_value') %}",
		"{% macro lookup(plugin='role_var', suffix='_value') %}",
	} {
		input := "example_role_value: >-\n  " + expression + "\n"
		if ds := defaultsDiagnostics(t, "roles/example/defaults/main.yml", input, "role-lookup-target"); len(ds) > 0 {
			t.Fatalf("%s: %+v", expression, ds)
		}
	}
	input := "example_role_value: >-\n  {{ data is other(lookup('role_var', '_value')) }}\n"
	assertSingleDefaultsDiagnostic(t, "roles/example/defaults/main.yml", input, "role-lookup-target", "lookup('role_var', '_value')", "role='example'")
	for _, expression := range []string{"{{ data is lookup('vars', value if enabled else other) }}", "{{ data | lookup('vars', value if enabled else other) }}"} {
		input := "example_role_value: >-\n  " + expression + "\n"
		if ds := Analyze(defaultsProject(t, "roles/example/defaults/main.yml", input), dockerRules("lookup-conditional-argument")); len(ds) > 0 {
			t.Fatalf("%s: %+v", expression, ds)
		}
	}
}
