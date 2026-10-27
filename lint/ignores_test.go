package lint

import (
	"bytes"
	"os"
	"path/filepath"
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
		{"unused", "unionfs_branch: value # saltbox-lint ignore role-variable-prefix\n", []string{"lint-directive"}},
		{"wrong line", "custom_mount_branch: value\nunionfs_branch: value # saltbox-lint ignore role-variable-prefix\n", []string{"lint-directive", "role-variable-prefix"}},
		{"rule not evaluated", "unionfs_branch: value # saltbox-lint ignore variable-duplicate\n", nil},
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

// Fixes on both sides of an ignored line are verified against their minimal
// edits, so a change shown by --diff is also accepted by --fix.
func TestInlineIgnoreAllowsFixesAroundIgnoredLine(t *testing.T) {
	const ignored = "demo_x: 1 # saltbox-lint ignore role-docker-state\n"
	for _, tc := range []struct{ name, input, want string }{
		{"whitespace", "demo_v: \"{{ a\n | f }}\"\n" + ignored + "demo_w: \"{{ b\n | g }}\"\n", "demo_v: \"{{ a\n            | f }}\"\n" + ignored + "demo_w: \"{{ b\n            | g }}\"\n"},
		{"structural", "demo_role_docker_healthcheck:\n  test: [CMD, curl]\n" + ignored + "demo_w: \"{{ b\n | g }}\"\n", "demo_role_docker_healthcheck:\n  test:\n    - CMD\n    - curl\n" + ignored + "demo_w: \"{{ b\n            | g }}\"\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := expressionFixProject(t, "roles/demo/defaults/main.yml", tc.input)
			p.Root = t.TempDir()
			path := filepath.Join(p.Root, "roles/demo/defaults/main.yml")
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(tc.input), 0600); err != nil {
				t.Fatal(err)
			}
			admitWriteTestSources(t, p)
			changes, err := PlanFixes(p, Analyze(p, Rules()))
			if err != nil || len(changes) != 1 || string(changes[0].After) != tc.want {
				t.Fatalf("plan %+v %v", changes, err)
			}
			if !verifiedChange(p.Sources[changes[0].Path], changes[0]) {
				t.Fatal("writer refused the planned change")
			}
			if err := WriteChanges(p, changes); err != nil {
				t.Fatal(err)
			}
			if got, err := os.ReadFile(path); err != nil || string(got) != tc.want {
				t.Fatalf("wrote %q %v", got, err)
			}
		})
	}
}

// A comment cannot follow the first line of a multi-line flow scalar, so an
// ignore after the scalar's last line covers findings that start inside it.
func TestInlineIgnoreCoversMultilineFlowScalars(t *testing.T) {
	const rule = "jinja-redundant-conditional-parentheses"
	for _, test := range []struct {
		name, input string
		want        []string
	}{
		{"double quoted", "example_x: \"{{ (a if b\n             else c) }}\" # saltbox-lint ignore " + rule + "\n", nil},
		{"flow sequence", "example_x: [\"{{ (a if b\n  else c) }}\",\n  other] # saltbox-lint ignore " + rule + "\n", nil},
		{"single line still covered", "example_x: \"{{ (a if b else c) }}\" # saltbox-lint ignore " + rule + "\n", nil},
		{"next entry not covered", "example_x: \"{{ (a if b else c) }}\"\nexample_y: \"{{ (a if b else c) }}\" # saltbox-lint ignore " + rule + "\n", []string{rule}},
		{"key line not covered", "example_x: # saltbox-lint ignore " + rule + "\n  \"{{ (a if b else c) }}\"\n", []string{rule, "lint-directive"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			project := prefixProject(t, map[string]string{"roles/example/defaults/main.yml": test.input})
			rules := slices.DeleteFunc(Rules(), func(r Rule) bool { return r.ID != rule && r.ID != "lint-directive" })
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

func TestInlineIgnoreProtectsWholeMultilineScalarFromFixes(t *testing.T) {
	const input = "example_x: \"{{ (a if b\n             else c) }}\" # saltbox-lint ignore jinja-redundant-conditional-parentheses\n"
	project := prefixProject(t, map[string]string{"roles/example/defaults/main.yml": input})
	source := project.Sources["roles/example/defaults/main.yml"]
	firstLine := strings.Index(input, "(")
	if fixesPreserveIgnoredLines(source, []Edit{{Span: Span{firstLine, firstLine + 1}}}) {
		t.Fatal("an edit on the covered scalar's first line was admitted")
	}
	if !fixesPreserveIgnoredLines(source, []Edit{{Span: Span{len(input), len(input)}, Text: "example_y: 1\n"}}) {
		t.Fatal("an insertion after the covered scalar was refused")
	}
}
