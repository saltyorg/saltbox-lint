package lint

import (
	"bytes"
	"slices"
	"strings"
	"testing"
)

func TestInlineRuleIgnores(t *testing.T) {
	for _, test := range []struct {
		name, input string
		want        []string
	}{
		{"one finding", "custom_mount_branch: value # saltbox-lint ignore role-variable-prefix\n", nil},
		{"only that line", "custom_mount_branch: value # saltbox-lint ignore role-variable-prefix\ncustom_other: value\n", []string{"role-variable-prefix"}},
		{"unicode CRLF", "custom_mount_branch: 'é😀' # saltbox-lint ignore role-variable-prefix\r\n", nil},
		{"unknown rule", "custom_mount_branch: value # saltbox-lint ignore invented-rule\n", []string{"lint-directive", "role-variable-prefix"}},
		{"malformed", "custom_mount_branch: value # saltbox-lint  ignore role-variable-prefix\n", []string{"lint-directive", "role-variable-prefix"}},
		{"standalone", "# saltbox-lint ignore role-variable-prefix\ncustom_mount_branch: value\n", []string{"lint-directive", "role-variable-prefix"}},
		{"cannot ignore directive validation", "custom_mount_branch: value # saltbox-lint ignore lint-directive\n", []string{"lint-directive", "role-variable-prefix"}},
		{"quoted text", "custom_mount_branch: '# saltbox-lint ignore role-variable-prefix'\n", []string{"role-variable-prefix"}},
		{"block contents", "custom_mount_branch: |\n  # saltbox-lint ignore role-variable-prefix\n", []string{"role-variable-prefix"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			project := prefixProject(t, map[string]string{
				"roles/unionfs/defaults/main.yml": test.input,
				"roles/custom/defaults/main.yml":  "custom_name: custom\n",
			})
			rules := slices.DeleteFunc(Rules(), func(rule Rule) bool {
				return rule.ID != "role-variable-prefix" && rule.ID != "lint-directive"
			})
			var ids []string
			for _, diagnostic := range Analyze(project, rules) {
				ids = append(ids, diagnostic.RuleID)
			}
			slices.Sort(ids)
			if !slices.Equal(ids, test.want) {
				t.Fatalf("diagnosed rules = %v, want %v", ids, test.want)
			}
		})
	}
}

func TestInlineIgnoreDoesNotSuppressOtherRules(t *testing.T) {
	project := prefixProject(t, map[string]string{
		"roles/unionfs/defaults/main.yml": "custom_mount_branch: value # saltbox-lint ignore role-variable-prefix\n",
		"roles/custom/defaults/main.yml":  "custom_name: custom\n",
		"vars.yml":                        "custom_mount_branch: duplicate\n",
	})
	rules := slices.DeleteFunc(Rules(), func(rule Rule) bool {
		return rule.ID != "role-variable-prefix" && rule.ID != "lint-directive" && rule.ID != "variable-duplicate"
	})
	diagnostics := Analyze(project, rules)
	if len(diagnostics) != 2 || diagnostics[0].RuleID != "variable-duplicate" || diagnostics[1].RuleID != "variable-duplicate" {
		t.Fatalf("line ignore hid unrelated rules: %+v", diagnostics)
	}
}

func TestInlineIgnoreProtectsAgainstCombinedFixes(t *testing.T) {
	const input = "- ansible.builtin.debug:\n    msg: first\n  when: first or enabled # saltbox-lint ignore ansible-when-parentheses\n- ansible.builtin.debug:\n    msg: second\n  when: second or enabled\n"
	project := prefixProject(t, map[string]string{"roles/example/tasks/main.yml": input})
	rules := slices.DeleteFunc(Rules(), func(rule Rule) bool { return rule.ID != "ansible-when-parentheses" && rule.ID != "lint-directive" })
	diagnostics := Analyze(project, rules)
	if len(diagnostics) != 1 || diagnostics[0].RuleID != "ansible-when-parentheses" {
		t.Fatalf("wrong unsuppressed findings: %+v", diagnostics)
	}
	changes, err := PlanFixes(project, diagnostics)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range changes {
		if !bytes.Contains(change.After, []byte("  when: first or enabled # saltbox-lint ignore ansible-when-parentheses\n")) {
			t.Fatalf("combined fix rewrote an ignored finding: %s", change.After)
		}
	}
	source := project.Sources["roles/example/tasks/main.yml"]
	forged := Change{Before: source.Data, After: []byte(strings.Replace(input, "when: first or enabled", "when: (first or enabled)", 1))}
	if verifiedChange(source, forged) {
		t.Fatal("writer verification admitted an edit to an ignored line")
	}
}
