package lint

import (
	"bytes"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestWhenParenthesesConditions(t *testing.T) {
	for _, condition := range []string{"value is defined", "not enabled", "value | bool", "items | length > 0", "a == b", "a or b", "(a) or (b)", "not (a or b)", "values[index + 1]", "values[lookup('vars', 'key')]", "values[key | lower]"} {
		t.Run(condition, func(t *testing.T) {
			for _, prefix := range []string{"  when: ", "  when:\n    - "} {
				input := "- name: Example\n  ansible.builtin.debug: {msg: ok}\n" + prefix + condition + "\n"
				assertAnsible(t, "tasks/main.yml", input, "ansible-when-parentheses", condition, "("+condition+")")
				grouped := strings.Replace(input, prefix+condition, prefix+"("+condition+")", 1)
				if ds := ansibleDiagnostics(t, "tasks/main.yml", grouped, "ansible-when-parentheses"); len(ds) != 0 {
					t.Fatal(ds)
				}
			}
		})
	}
	for _, condition := range []string{"enabled", "result.changed", "result['changed']", "results[0].changed", "values[key]", "values[item.key]", "(enabled)", "((a and (b or c)))", "23", "null", "!unsafe 'a and b'", "'{{ a and b }}'", "'{% if a %}true{% endif %}'", "'(a and b'", "[]", "{a: b}"} {
		t.Run("accepted/"+condition, func(t *testing.T) {
			input := "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when: " + condition + "\n"
			if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-when-parentheses"); len(ds) != 0 {
				t.Fatal(ds)
			}
		})
	}
}

func TestWhenParenthesesStructuralScope(t *testing.T) {
	task := "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when: a or b\n"
	for _, path := range []string{"tasks/main.yml", "roles/example/handlers/nested/main.yml", "resources/tasks/example.yml"} {
		assertAnsible(t, path, task, "ansible-when-parentheses", "a or b", "(a or b)")
		for _, branch := range []string{"block", "rescue", "always"} {
			input := "- name: Parent\n  " + branch + ":\n" + indentText(task, 4)
			assertAnsible(t, path, input, "ansible-when-parentheses", "a or b", "(a or b)")
		}
	}
	for _, key := range []string{"pre_tasks", "tasks", "post_tasks", "handlers"} {
		assertAnsible(t, "saltbox.yml", "- hosts: all\n  "+key+":\n"+indentText(task, 4), "ansible-when-parentheses", "a or b", "(a or b)")
	}
	for _, input := range []string{
		"- name: Parent\n  block: []\n  when: a or b\n",
		"- name: Include\n  ansible.builtin.include_role:\n    name: example\n    apply:\n      when: a or b\n",
		"- name: Include\n  ansible.builtin.include_tasks: other.yml\n  args:\n    apply:\n      when: a or b\n",
	} {
		assertAnsible(t, "tasks/main.yml", input, "ansible-when-parentheses", "a or b", "(a or b)")
	}
	assertAnsible(t, "saltbox.yml", "- hosts: all\n  roles:\n    - role: example\n      when: a or b\n", "ansible-when-parentheses", "a or b", "(a or b)")
	for _, input := range []string{
		"- name: Example\n  ansible.builtin.assert:\n    that: [a or b]\n  changed_when: a or b\n  failed_when: a or b\n  until: a or b\n",
		"- name: Example\n  ansible.builtin.set_fact:\n    payload: {when: a or b, apply: {when: a or b}}\n  vars:\n    when: a or b\n",
		"- name: Example\n  ansible.builtin.debug:\n    msg: '{{ a or b }} {{ a if b and c else d }} {% if a or b %}yes{% endif %}'\n",
	} {
		if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-when-parentheses"); len(ds) != 0 {
			t.Fatal(ds)
		}
	}
	for _, path := range []string{"vars.yml", "roles/example/defaults/main.yml", "roles/example/files/settings.yml"} {
		if ds := ansibleDiagnostics(t, path, "payload: {when: a or b}\n", "ansible-when-parentheses"); len(ds) != 0 {
			t.Fatal(ds)
		}
	}
}

func TestConditionalResultParentheses(t *testing.T) {
	for _, expression := range []string{"(a if condition else b)", "((a if condition else b))", "(a if b and (c or d) else e)", "(a if condition else (b if other else c))", "(obj.if if condition else obj.else)", "(a | if if condition else b | else)"} {
		t.Run(expression, func(t *testing.T) {
			input := "value: \"{{ " + expression + " }}\"\n"
			ds := ansibleDiagnostics(t, "vars.yml", input, "jinja-redundant-conditional-parentheses")
			if len(ds) != 1 {
				t.Fatalf("diagnostics=%+v", ds)
			}
			if got := input[ds[0].Span.Start:ds[0].Span.End]; got != "(" {
				t.Errorf("span=%q", got)
			}
			hint := "{{ " + strings.TrimSuffix(strings.TrimPrefix(expression, "("), ")") + " }}"
			if expression == "((a if condition else b))" {
				hint = "{{ a if condition else b }}"
			}
			if ds[0].Fix != nil || !strings.Contains(ds[0].Expected, hint) {
				t.Fatal(ds[0])
			}
		})
	}
	for _, expression := range []string{"a if condition else b", "(a if condition else b) + suffix", "prefix + (a if condition else b)", "(a if condition else b) | filter", "fn((a if condition else b))", "[(a if condition else b)]", "{'key': (a if condition else b)}", "(a and (b or c))", "(obj.if)", "(a | if)", "(a is if)", "('if else')", "(a if condition else b", "(a if condition)", "(a if c else b,)", "((a if c else b), other)", "(a if c else b)[0]", "(a if c else b).field"} {
		t.Run("accepted/"+expression, func(t *testing.T) {
			if ds := ansibleDiagnostics(t, "vars.yml", "value: \"{{ "+expression+" }}\"\n", "jinja-redundant-conditional-parentheses"); len(ds) != 0 {
				t.Fatal(ds)
			}
		})
	}
	for _, input := range []string{"value: !unsafe '{{ (a if c else b) }}'\n", "# {{ (a if c else b) }}\nvalue: literal\n", "value: '{# {{ (a if c else b) }} #}'\n", "value: '{% raw %}{{ (a if c else b) }}{% endraw %}'\n", "value: '{% if (a if c else b) %}yes{% endif %}'\n", "value: '(a if c else b)'\n"} {
		if ds := ansibleDiagnostics(t, "vars.yml", input, "jinja-redundant-conditional-parentheses"); len(ds) != 0 {
			t.Fatal(ds)
		}
	}
	if ds := ansibleDiagnostics(t, "tasks/main.yml", "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when: (a if c else b)\n", "jinja-redundant-conditional-parentheses"); len(ds) != 0 {
		t.Fatal(ds)
	}
}

func TestParenthesesSourcePositionsAndSelection(t *testing.T) {
	for _, tc := range []struct {
		path, input, id, span string
		line, column          int
	}{
		{"tasks/main.yml", "- name: Éxample\r\n  ansible.builtin.debug: {msg: ok}\r\n  when: >-\r\n    café or\r\n    enabled\r\n", "ansible-when-parentheses", "café or\r\n    enabled", 4, 5},
		{"tasks/main.yml", "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when: 'café == ''oui'''\n", "ansible-when-parentheses", "café == ''oui''", 3, 10},
		{"vars.yml", "value: >-\r\n  {{ (café\r\n      if enabled\r\n      else other) }}\r\n", "jinja-redundant-conditional-parentheses", "(", 2, 6},
	} {
		p := ansibleProject(t, "saltbox", map[string]string{tc.path: tc.input, "roles/other/tasks/main.yml": "- name: Example\n  ansible.builtin.debug: {msg: '{{ (a if c else b) }}'}\n  when: a or b\n"})
		rules := dockerRules("ansible-when-parentheses", "jinja-redundant-conditional-parentheses")
		full := Analyze(p, rules)
		p.Selected = map[string]bool{tc.path: true}
		selected := Analyze(p, rules)
		if len(selected) != 1 {
			t.Fatalf("%s: %+v", tc.id, selected)
		}
		d := selected[0]
		if d.RuleID != tc.id || tc.input[d.Span.Start:d.Span.End] != tc.span || p.Sources[tc.path].Position(d.Span.Start) != (Position{tc.line, tc.column}) {
			t.Fatalf("diagnostic=%+v position=%+v", d, p.Sources[tc.path].Position(d.Span.Start))
		}
		if !slices.ContainsFunc(full, func(other Diagnostic) bool {
			return other.Path == d.Path && other.Span == d.Span && other.Expected == d.Expected
		}) {
			t.Fatal("selected diagnostic differs from full analysis")
		}
		changes, err := PlanFixes(p, selected)
		if err != nil || len(changes) != 0 || !bytes.Equal(p.Sources[tc.path].Data, []byte(tc.input)) {
			t.Fatalf("no-fix preservation: %v %v", changes, err)
		}
	}
}

func TestParenthesesFixtures(t *testing.T) {
	for _, tc := range []struct{ fixture, path, id string }{
		{"ansible/when-parentheses", "tasks/main.yml", "ansible-when-parentheses"},
		{"jinja/conditional-parentheses", "vars.yml", "jinja-redundant-conditional-parentheses"},
	} {
		for _, kind := range []string{"good", "bad"} {
			input, err := os.ReadFile("testdata/" + tc.fixture + "." + kind + ".yml")
			if err != nil {
				t.Fatal(err)
			}
			ds := ansibleDiagnostics(t, tc.path, string(input), tc.id)
			if (len(ds) > 0) != (kind == "bad") {
				t.Fatalf("%s/%s: %+v", tc.fixture, kind, ds)
			}
			for _, d := range ds {
				if d.Fix != nil || d.Expected == "" {
					t.Fatal(d)
				}
			}
		}
	}
}

func TestWhenParenthesesNativeBooleans(t *testing.T) {
	for _, tc := range []struct{ input, span, hint string }{
		{"true", "true", "(true)"}, {"false", "false", "(false)"},
		{"!!bool 'true'", "true", "(true)"}, {"!!bool 'FALSE'", "FALSE", "(false)"},
	} {
		for _, prefix := range []string{"  when: ", "  when:\n    - "} {
			input := "- name: Example\n  ansible.builtin.debug: {msg: ok}\n" + prefix + tc.input + "\n"
			assertAnsible(t, "tasks/main.yml", input, "ansible-when-parentheses", tc.span, tc.hint)
		}
	}
	for _, value := range []string{"!unsafe true", "!unsafe 'false'", "(true)", "(false)"} {
		input := "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when: " + value + "\n"
		if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-when-parentheses"); len(ds) != 0 {
			t.Fatal(ds)
		}
	}
}

func TestWhenParenthesesConstantItemKeys(t *testing.T) {
	for _, key := range []string{"true", "false", "none", "True", "False", "None"} {
		for _, condition := range []string{"values[" + key + "]", "values[" + key + "].enabled", "values[keys[" + key + "]]"} {
			t.Run(condition, func(t *testing.T) {
				for _, prefix := range []string{"  when: ", "  when:\n    - "} {
					input := "- name: Example\n  ansible.builtin.debug: {msg: ok}\n" + prefix + condition + "\n"
					if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-when-parentheses"); len(ds) != 0 {
						t.Fatal(ds)
					}
				}
			})
		}
		for _, condition := range []string{"values[" + key + " or fallback]", "values[keys[" + key + "] + 1]"} {
			input := "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when: " + condition + "\n"
			assertAnsible(t, "tasks/main.yml", input, "ansible-when-parentheses", condition, "("+condition+")")
		}
	}
}

func TestWhenParenthesesDirectLookupReads(t *testing.T) {
	for _, condition := range []string{
		"lookup('role_var', '_metrics_enabled', role='traefik')",
		"lookup('vars', 'flag')",
		"lookup('ansible.builtin.vars', 'flag')",
		"query('vars', flag_name)",
		"q('vars', flag_name)",
		"lookup('vars', prefix + suffix, default=fallback)",
		"lookup('vars', query('vars', flag_name))",
	} {
		t.Run(condition, func(t *testing.T) {
			for _, prefix := range []string{"  when: ", "  when:\n    - "} {
				for _, value := range []string{condition, "(" + condition + ")"} {
					input := "- name: Read metrics flag\n  ansible.builtin.debug: {msg: ok}\n" + prefix + value + "\n"
					if ds := ansibleDiagnostics(t, "roles/traefik/tasks/main.yml", input, "ansible-when-parentheses"); len(ds) != 0 {
						t.Fatal(ds)
					}
				}
			}
		})
	}
	for _, condition := range []string{
		"not lookup('vars', 'flag')", "lookup('vars', 'flag') | bool",
		"lookup('vars', 'flag') is defined", "lookup('vars', 'flag') == expected",
		"lookup('vars', 'flag') or enabled", "enabled or query('vars', 'flag')",
		"q('vars', 'flag') | length > 0", "lookup('vars', 'flag') or lookup('vars', 'other')",
		"lookup('vars', 'flag')[0]", "obj.lookup('vars', 'flag')",
		"ansible.builtin.lookup('vars', 'flag')", "dict(value=lookup('vars', 'flag'))",
		"'lookup' == value", "value | lookup('vars', 'flag')", "value is lookup('vars', 'flag')",
	} {
		t.Run("computed/"+condition, func(t *testing.T) {
			input := "- name: Check flag\n  ansible.builtin.debug: {msg: ok}\n  when: \"" + condition + "\"\n"
			assertAnsible(t, "tasks/main.yml", input, "ansible-when-parentheses", condition, "("+condition+")")
		})
	}
}
