package lint

import (
	"bytes"
	"strings"
	"testing"
)

// Every advertised fixer must survive the public analysis/planning path, not
// just a direct provider call. Unsafe bad examples may need a safe fixture.
func TestAdvertisedFixesExecute(t *testing.T) {
	overrides := map[string]string{
		"ansible-when-list":              "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when: value is defined and other is defined\n",
		"ansible-source-header":          strings.TrimSuffix(safeHeader, "---\n") + "v: true\n",
		"computed-default-documentation": "demo_role_secret_lookup: '{{ value }}'\n",
		"jinja-conditional-length":       "value: \"{{ '" + strings.Repeat("x", 170) + "' if flag else 'fallback' }}\"\n",
	}
	for _, rule := range Rules() {
		if !rule.Fixable {
			continue
		}
		t.Run(rule.ID, func(t *testing.T) {
			input := rule.BadExample
			if override, ok := overrides[rule.ID]; ok {
				input = override
			}
			path := "roles/demo/defaults/main.yml"
			if rule.ID == "ansible-when-list" || rule.ID == "ansible-when-parentheses" {
				path = "roles/demo/tasks/main.yml"
			}
			project := expressionFixProject(t, path, input)
			diagnostics := Analyze(project, []Rule{rule})
			if len(diagnostics) == 0 {
				t.Fatal("fixture does not exercise advertised policy")
			}
			for _, diagnostic := range diagnostics {
				if diagnostic.Fix == nil {
					t.Fatalf("advertised safe fixture has no fix: %+v", diagnostic)
				}
			}
			changes, err := PlanFixes(project, diagnostics)
			if err != nil || len(changes) != 1 {
				t.Fatalf("changes=%+v err=%v", changes, err)
			}
			edits, err := PlannedFixEdits(changes[0])
			if err != nil || !bytes.Equal(applyEdits(changes[0].Before, edits), changes[0].After) {
				t.Fatalf("invalid edit projection: %v", err)
			}
			fixed := expressionFixProject(t, path, string(changes[0].After))
			remaining := Analyze(fixed, []Rule{rule})
			if len(remaining) != 0 {
				t.Fatalf("fix leaves diagnostics: %+v", remaining)
			}
			again, err := PlanFixes(fixed, remaining)
			if err != nil || len(again) != 0 {
				t.Fatalf("not idempotent: %+v %v", again, err)
			}
		})
	}
}
