package lint

import (
	"bytes"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestWhenListConjunctions(t *testing.T) {
	for _, tc := range []struct {
		condition string
		items     []string
	}{
		{"(remote_docker_controller_service_running is defined) and remote_docker_controller_service_running", []string{"(remote_docker_controller_service_running is defined)", "remote_docker_controller_service_running"}},
		{"a and b and c", []string{"a", "b", "c"}},
		{"((a and (b and c)))", []string{"a", "b", "c"}},
		{"(a) and ((b))", []string{"(a)", "((b))"}},
		{"a and (b or c)", []string{"a", "(b or c)"}},
		{"a is defined and a | bool and not b and c == d", []string{"(a is defined)", "(a | bool)", "(not b)", "(c == d)"}},
		{"result.changed and values[item.key] and values[0]", []string{"result.changed", "values[item.key]", "values[0]"}},
		{"lookup('vars', a and b) and query('vars', key) and q('vars', key)", []string{"lookup('vars', a and b)", "query('vars', key)", "q('vars', key)"}},
		{"lookup('vars', key) | bool and values[index + 1]", []string{"(lookup('vars', key) | bool)", "(values[index + 1])"}},
		{"a and (b and c) | bool and ((d and e) == f)", []string{"a", "((b and c) | bool)", "((d and e) == f)"}},
		{"a and (b and c if d else e and f)", []string{"a", "(b and c if d else e and f)"}},
		{"obj.and and obj.or and value | and and value is or", []string{"obj.and", "obj.or", "(value | and)", "(value is or)"}},
		{"a == 'and or' and b is not and", []string{"(a == 'and or')", "(b is not and)"}},
		{"true and false", []string{"(true)", "(false)"}},
	} {
		t.Run(tc.condition, func(t *testing.T) {
			for _, prefix := range []string{"  when: ", "  when:\n    - "} {
				input := "- name: Check readiness\n  ansible.builtin.debug: {msg: ok}\n" + prefix + tc.condition + "\n"
				ds := Analyze(ansibleProject(t, "saltbox", map[string]string{"tasks/main.yml": input}), dockerRules("ansible-when-list", "ansible-when-parentheses"))
				if len(ds) != 1 || ds[0].RuleID != "ansible-when-list" {
					t.Fatalf("diagnostics=%+v", ds)
				}
				if got := input[ds[0].Span.Start:ds[0].Span.End]; got != tc.condition {
					t.Errorf("span=%q", got)
				}
				assertWhenListHint(t, ds[0], tc.items)
			}
		})
	}
}

// Decode and re-lint the actual advertised YAML, with hand-derived operand values.
func assertWhenListHint(t *testing.T, d Diagnostic, want []string) {
	t.Helper()
	if d.Fix != nil {
		t.Fatal("list rule must not offer a fix")
	}
	_, hint, ok := strings.Cut(d.Expected, "\n")
	if !ok {
		t.Fatalf("missing YAML hint: %q", d.Expected)
	}
	s, ds := Parse("hint.yml", []byte(hint))
	if len(ds) > 0 || len(s.Documents) != 1 {
		t.Fatalf("invalid hint: %q, %+v", hint, ds)
	}
	when := s.Documents[0].Get("when")
	if when == nil || when.Kind != "sequence" || when.Style != "block" {
		t.Fatalf("not a block when list: %q", hint)
	}
	var got []string
	for _, item := range when.Items {
		if kind, _ := EffectiveScalar(item); kind != "string" {
			t.Fatalf("non-string suggested item: %+v", item)
		}
		got = append(got, item.Value)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("items=%q want=%q", got, want)
	}
	input := "- name: Check readiness\n  ansible.builtin.debug: {msg: ok}\n" + indentText(hint, 2)
	if ds := Analyze(ansibleProject(t, "saltbox", map[string]string{"tasks/main.yml": input}), dockerRules("ansible-when-list", "ansible-when-parentheses")); len(ds) != 0 {
		t.Fatalf("hint fails when policies: %+v\n%s", ds, hint)
	}
}

func TestWhenListIndivisibleAndExcludedConditions(t *testing.T) {
	for _, condition := range []string{
		"(a and b) or c", "a and b or c", "a or b and c", "not (a and b)", "(a and b) | bool", "(a and b) == c", "a == (b and c)", "lookup('vars', a and b)",
		"a and b if c else d", "a if b and c else d", "a if b else c and d", "a and b if c", "(a and b, c)",
		"obj.and", "obj.or", "a | and", "a is and", "a is not or", "'and or'", "lookup('vars', 'and or')", "a | and(b)",
		"a and", "(a and b", "a and 'unterminated", "23", "null", "true", "[]", "{}", "!unsafe 'a and b'", "!custom 'a and b'", "*missing",
		"'{{ a and b }}'", "'{% if a and b %}yes{% endif %}'", "'{# a and b #}'",
	} {
		t.Run(condition, func(t *testing.T) {
			input := "- name: Check readiness\n  ansible.builtin.debug: {msg: ok}\n  when: " + condition + "\n"
			if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-when-list"); len(ds) != 0 {
				t.Fatal(ds)
			}
		})
	}
	for _, input := range []string{
		"- name: Check\n  ansible.builtin.assert:\n    that: [a and b]\n  changed_when: a and b\n  failed_when: a and b\n  until: a and b\n",
		"- name: Check\n  ansible.builtin.set_fact:\n    payload: {when: a and b, apply: {when: a and b}}\n  vars:\n    when: a and b\n",
		"- name: Check\n  ansible.builtin.debug:\n    msg: '{{ a and b }} {{ a if b and c else d }} {% if a and b %}yes{% endif %}'\n",
	} {
		if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-when-list"); len(ds) != 0 {
			t.Fatal(ds)
		}
	}
	for _, path := range []string{"vars.yml", "roles/example/defaults/main.yml", "roles/example/files/settings.yml", "roles/example/templates/test.j2"} {
		if ds := ansibleDiagnostics(t, path, "payload: {when: a and b}\n", "ansible-when-list"); len(ds) != 0 {
			t.Fatal(ds)
		}
	}
}

func TestWhenListStructuralOwners(t *testing.T) {
	task := "- name: Check readiness\n  ansible.builtin.debug: {msg: ok}\n  when: a and b\n"
	for _, path := range []string{"tasks/main.yml", "roles/example/handlers/nested/main.yml", "resources/tasks/example.yml"} {
		assertAnsible(t, path, task, "ansible-when-list", "a and b", "when:\n  - a\n  - b")
		for _, branch := range []string{"block", "rescue", "always"} {
			assertAnsible(t, path, "- name: Parent\n  "+branch+":\n"+indentText(task, 4), "ansible-when-list", "a and b", "when:\n  - a\n  - b")
		}
	}
	for _, key := range []string{"pre_tasks", "tasks", "post_tasks", "handlers"} {
		assertAnsible(t, "saltbox.yml", "- hosts: all\n  "+key+":\n"+indentText(task, 4), "ansible-when-list", "a and b", "when:\n  - a\n  - b")
	}
	for _, input := range []string{
		"- name: Parent\n  block: []\n  when: a and b\n",
		"- name: Include\n  ansible.builtin.include_role:\n    name: example\n    apply:\n      when: a and b\n",
		"- name: Include\n  ansible.builtin.include_tasks: other.yml\n  args:\n    apply:\n      when: a and b\n",
	} {
		assertAnsible(t, "tasks/main.yml", input, "ansible-when-list", "a and b", "when:\n  - a\n  - b")
	}
	for _, input := range []string{"- hosts: all\n  when: a and b\n", "- hosts: all\n  roles:\n    - role: example\n      when: a and b\n"} {
		assertAnsible(t, "saltbox.yml", input, "ansible-when-list", "a and b", "when:\n  - a\n  - b")
	}
}

func TestWhenListDecodedHintsPositionsAndSelection(t *testing.T) {
	for _, tc := range []struct {
		scalar, span string
		line, column int
		items        []string
	}{
		{">-\r\n    café and\r\n    enabled", "café and\r\n    enabled", 4, 5, []string{"café", "enabled"}},
		{"'café == ''oui'' and enabled'", "café == ''oui'' and enabled", 3, 10, []string{"(café == 'oui')", "enabled"}},
		{`"caf\u00e9 == \"a: # b\" and enabled"`, `caf\u00e9 == \"a: # b\" and enabled`, 3, 10, []string{`(café == "a: # b")`, "enabled"}},
		{"|-\n    value == 'line\n    break' and enabled", "value == 'line\n    break' and enabled", 4, 5, []string{"(value == 'line\nbreak')", "enabled"}},
		{">-\n    lookup('vars',\n           'flag') and enabled", "lookup('vars',\n           'flag') and enabled", 4, 5, []string{"lookup('vars',\n       'flag')", "enabled"}},
	} {
		t.Run(tc.scalar, func(t *testing.T) {
			input := "- name: Éxample\r\n  ansible.builtin.debug: {msg: ok}\r\n  when: " + tc.scalar + "\n"
			for _, name := range []string{"saltbox", "sandbox"} {
				p := ansibleProject(t, name, map[string]string{"tasks/main.yml": input, "roles/other/tasks/main.yml": "- name: Other\n  ansible.builtin.debug: {msg: ok}\n  when: other and flag\n"})
				rules := dockerRules("ansible-when-list", "ansible-when-parentheses")
				full := Analyze(p, rules)
				p.Selected = map[string]bool{"tasks/main.yml": true}
				ds := Analyze(p, rules)
				if len(ds) != 1 {
					t.Fatalf("diagnostics=%+v", ds)
				}
				d := ds[0]
				if d.RuleID != "ansible-when-list" || input[d.Span.Start:d.Span.End] != tc.span || p.Sources[d.Path].Position(d.Span.Start) != (Position{tc.line, tc.column}) {
					t.Fatalf("diagnostic=%+v position=%+v", d, p.Sources[d.Path].Position(d.Span.Start))
				}
				if !slices.ContainsFunc(full, func(other Diagnostic) bool {
					return other.Path == d.Path && other.Span == d.Span && other.Expected == d.Expected
				}) {
					t.Fatal("selected differs from full")
				}
				assertWhenListHint(t, d, tc.items)
				changes, err := PlanFixes(p, ds)
				if err != nil || len(changes) != 0 || !bytes.Equal(p.Sources[d.Path].Data, []byte(input)) {
					t.Fatalf("source modified: %v %v", changes, err)
				}
			}
		})
	}
}

func TestWhenListMultipleItemsAndFixtures(t *testing.T) {
	input := "- name: Check readiness\n  ansible.builtin.debug: {msg: ok}\n  when:\n    - a and b\n    - (c and d)\n    - value is defined\n    - enabled\n"
	ds := Analyze(ansibleProject(t, "saltbox", map[string]string{"tasks/main.yml": input}), dockerRules("ansible-when-list", "ansible-when-parentheses"))
	if len(ds) != 3 || ds[0].RuleID != "ansible-when-list" || ds[1].RuleID != "ansible-when-list" || ds[2].RuleID != "ansible-when-parentheses" {
		t.Fatalf("diagnostics=%+v", ds)
	}
	for _, kind := range []string{"good", "bad"} {
		data, err := os.ReadFile("testdata/ansible/when-list." + kind + ".yml")
		if err != nil {
			t.Fatal(err)
		}
		ds := Analyze(ansibleProject(t, "saltbox", map[string]string{"tasks/main.yml": string(data)}), dockerRules("ansible-when-list", "ansible-when-parentheses"))
		if (len(ds) > 0) != (kind == "bad") {
			t.Fatalf("%s: %+v", kind, ds)
		}
		for _, d := range ds {
			if d.RuleID != "ansible-when-list" || d.Fix != nil || d.Expected == "" {
				t.Fatal(d)
			}
		}
	}
}

func TestWhenListAcceptsParenthesesGoodFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/ansible/when-parentheses.good.yml")
	if err != nil {
		t.Fatal(err)
	}
	ds := Analyze(ansibleProject(t, "saltbox", map[string]string{"tasks/main.yml": string(data)}), dockerRules("ansible-when-list", "ansible-when-parentheses"))
	if len(ds) != 0 {
		t.Fatal(ds)
	}
}
