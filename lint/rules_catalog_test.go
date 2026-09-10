package lint

import (
	"slices"
	"strings"
	"testing"
)

// The count is an acceptance check for this catalog, not an engine limit.
// Executable metadata makes every advertised policy earn a pass and a failure.
func TestPolicyCatalogCompleteAndExamplesExecute(t *testing.T) {
	rules := Rules()
	if len(rules) != 29 {
		t.Fatalf("catalog has %d rules, want the accepted 29 policies", len(rules))
	}
	seen := map[string]bool{}
	for _, r := range rules {
		t.Run(r.ID, func(t *testing.T) {
			if seen[r.ID] {
				t.Fatalf("duplicate ID %s", r.ID)
			}
			seen[r.ID] = true
			if r.ID == "" || r.Summary == "" || r.Explanation == "" || r.Scope == "" || r.GoodExample == "" || r.BadExample == "" || len(r.Kinds) == 0 || r.Check == nil {
				t.Fatalf("incomplete metadata: %+v", r)
			}
			for _, bad := range []bool{false, true} {
				input := r.GoodExample
				if bad {
					input = r.BadExample
				}
				path := "roles/example/tasks/main.yml"
				if slices.Contains(r.Kinds, Defaults) {
					path = "roles/example/defaults/main.yml"
				}
				switch r.ID {
				case "docker-vars-policy":
					path = "resources/tasks/docker/main.yml"
				case "role-directory-name":
					path = "roles/good_role/tasks/main.yml"
					if bad {
						path = "roles/bad-role/tasks/main.yml"
					}
				case "traefik-adapter-contract":
					path = "roles/example/tasks/main.yml"
				}
				p := traefikProject(map[string]string{path: input})
				if len(p.Sources[path].parseDiagnostics) > 0 {
					t.Fatalf("metadata is invalid YAML: %+v", p.Sources[path].parseDiagnostics)
				}
				ds := Analyze(p, []Rule{r})
				if (len(ds) > 0) != bad {
					t.Fatalf("bad=%v diagnostics=%+v", bad, ds)
				}
				for _, d := range ds {
					if d.RuleID != r.ID || strings.TrimSpace(d.Expected) == "" {
						t.Errorf("unhelpful advertised diagnostic: %+v", d)
					}
				}
			}
		})
	}
}
func TestEngineAcceptsAdditionalPoliciesWithoutCatalogCeiling(t *testing.T) {
	p := traefikProject(map[string]string{"example.yml": "{}\n"})
	rules := append(Rules(), Rule{ID: "additional-policy", Kinds: []Kind{Generic}, Check: func(_ *Project, s *Source) []Diagnostic {
		return []Diagnostic{{Path: s.Path, RuleID: "additional-policy", Message: "additional check"}}
	}})
	ds := Analyze(p, rules)
	if !slices.ContainsFunc(ds, func(d Diagnostic) bool { return d.RuleID == "additional-policy" }) {
		t.Fatal("engine did not execute the additional rule")
	}
}
