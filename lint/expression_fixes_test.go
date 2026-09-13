package lint

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func expressionFixProject(t *testing.T, path, input string) *Project {
	t.Helper()
	s, ds := Parse(path, []byte(input))
	if len(ds) != 0 {
		t.Fatalf("parse: %+v", ds)
	}
	return &Project{Sources: map[string]*Source{path: s}, Selected: map[string]bool{path: true}}
}

func TestExpressionFixes(t *testing.T) {
	const task = "- name: Example\n  ansible.builtin.debug: {msg: ok}\n"
	for _, tc := range []struct{ name, path, input, want string }{
		{"when plain", "roles/demo/tasks/main.yml", task + "  when: value is defined # keep 🌨\n", task + "  when: (value is defined) # keep 🌨\n"},
		{"when quoted", "roles/demo/tasks/main.yml", task + "  when: \"value == 'a'\"\n", task + "  when: \"(value == 'a')\"\n"},
		{"when escaped", "roles/demo/tasks/main.yml", task + `  when: "value == \"a\""` + "\n", task + `  when: "(value == \"a\")"` + "\n"},
		{"result", "values.yml", "v: \"{{ (a if flag else b) }}\" # keep\n", "v: \"{{ a if flag else b }}\" # keep\n"},
		{"nested result", "values.yml", "v: \"{{- ((a if (x and y) else (b if z else c))) -}}\"\n", "v: \"{{- a if (x and y) else (b if z else c) -}}\"\n"},
		{"when list", "roles/demo/tasks/main.yml", task + "  when: value is defined and value | length > 0\n", task + "  when:\n    - (value is defined)\n    - (value | length > 0)\n"},
		{"when grouped operand", "roles/demo/tasks/main.yml", task + "  when: (value is defined and value | length > 0) and other is defined\n", task + "  when:\n    - (value is defined and value | length > 0)\n    - (other is defined)\n"},
		{"crlf unicode", "values.yml", "v: \"🌨 {{ (a if flag else b) }}\"\r\n", "v: \"🌨 {{ a if flag else b }}\"\r\n"},
		{"combined layout", "values.yml", "v: \"{{ (a if flag else b) }}\"\nw: \"{{ x\n | f }}\"\n", "v: \"{{ a if flag else b }}\"\nw: \"{{ x\n       | f }}\"\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := expressionFixProject(t, tc.path, tc.input)
			ds := Analyze(p, Rules())
			cs, err := PlanFixes(p, append(ds, ds...))
			if err != nil || len(cs) != 1 {
				t.Fatalf("changes=%+v err=%v diagnostics=%+v", cs, err, ds)
			}
			if string(cs[0].After) != tc.want {
				t.Fatalf("got %q want %q", cs[0].After, tc.want)
			}
			edits, err := PlannedFixEdits(cs[0])
			if err != nil || !bytes.Equal(applyEdits([]byte(tc.input), edits), cs[0].After) {
				t.Fatalf("projection: %+v %v", edits, err)
			}
			p2 := expressionFixProject(t, tc.path, tc.want)
			again, err := PlanFixes(p2, Analyze(p2, Rules()))
			if err != nil || len(again) != 0 {
				t.Fatalf("not idempotent: %+v %v", again, err)
			}
		})
	}
}

func TestExpressionFixRefusals(t *testing.T) {
	const task = "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when: "
	for _, value := range []string{"\"'nonempty' and true\"", "('nonempty') and true", "(unknown) and true", "unknown and true", "lookup('test') and true", "true and unknown", "value is defined | string and true", "value is custom_test and true", "value is", "value === 1", "value is defined garbage", "value is defined and", "true", "!unsafe value is defined", "&condition value is defined", "(value is defined and value | length > 0)"} {
		t.Run(value, func(t *testing.T) {
			p := expressionFixProject(t, "roles/demo/tasks/main.yml", task+value+"\n")
			cs, err := PlanFixes(p, Analyze(p, Rules()))
			if err != nil || len(cs) != 0 {
				t.Fatalf("unsafe change: %+v %v", cs, err)
			}
		})
	}
	for _, value := range []string{"{{ (a if flag else b,) }}", "{{ (a if flag else b) | string }}", "{{ f(a if flag else b) }}", "{{ (a if flag else) }}", "{{ (a if flag else b garbage) }}"} {
		p := expressionFixProject(t, "values.yml", "v: \""+value+"\"\n")
		cs, err := PlanFixes(p, Analyze(p, Rules()))
		if err != nil || len(cs) != 0 {
			t.Fatalf("unsafe result %q: %+v %v", value, cs, err)
		}
	}
}

func TestLongConditionalFix(t *testing.T) {
	for _, suffix := range []string{"", " else fallback"} {
		input := "v: \"{{ '" + strings.Repeat("a", 150) + "' if flag" + suffix + " }}\"\n"
		p := expressionFixProject(t, "values.yml", input)
		cs, err := PlanFixes(p, Analyze(p, Rules()))
		if err != nil || len(cs) != 1 {
			t.Fatalf("wrap: %+v %v", cs, err)
		}
		want := strings.Replace(input, " if flag", "\n    if flag", 1)
		want = strings.Replace(want, " else fallback", "\n    else fallback", 1)
		if string(cs[0].After) != want {
			t.Fatalf("got %q want %q", cs[0].After, want)
		}
	}
}

func TestStructuralFixAuthority(t *testing.T) {
	input := "v: \"{{ (a if flag else b) }}\"\n"
	p := expressionFixProject(t, "values.yml", input)
	p.Root = t.TempDir()
	path := filepath.Join(p.Root, "values.yml")
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	ds := Analyze(p, Rules())
	cs, err := PlanFixes(p, ds)
	if err != nil || len(cs) != 1 {
		t.Fatalf("plan: %+v %v", cs, err)
	}
	forged := Change{Path: cs[0].Path, Before: cs[0].Before, After: cs[0].After}
	if _, err := PlannedFixEdits(forged); err == nil {
		t.Fatal("unproven structural projection accepted")
	}
	if err := WriteChanges(p, []Change{forged}); err == nil {
		t.Fatal("forged change accepted")
	}
	mutated := cs[0]
	mutated.After = bytes.Replace(mutated.After, []byte("flag"), []byte("evil"), 1)
	if err := WriteChanges(p, []Change{mutated}); err == nil {
		t.Fatal("mutated change accepted")
	}
	for i := range ds {
		if ds[i].Fix != nil {
			ds[i].Fix.Edits[0].Text += "evil"
		}
	}
	bad, err := PlanFixes(p, ds)
	if err == nil && len(bad) > 0 {
		t.Fatal("mutated fix accepted")
	}
	if err := WriteChanges(p, cs); err != nil {
		t.Fatal(err)
	}
	if err := WriteChanges(p, cs); err == nil {
		t.Fatal("stale structural write accepted")
	}
}

func TestStructuralFixRejectsInvalidCallAndTestGrammar(t *testing.T) {
	for _, condition := range []string{"fn(arg=true, other) == true", "value is defined is defined", "fn(arg=true, arg=false) == true"} {
		input := "- debug: {msg: ok}\n  when: " + condition + "\n"
		p := expressionFixProject(t, "tasks/main.yml", input)
		cs, err := PlanFixes(p, Analyze(p, Rules()))
		if err != nil || len(cs) > 0 {
			t.Fatalf("invalid grammar %q offered fixes: %+v %v", condition, cs, err)
		}
	}
}

func TestMultipleConditionalResultsInOneScalar(t *testing.T) {
	input := "v: \"{{ (a if flag else b) }} / {{ (c if flag else d) }}\"\n"
	want := "v: \"{{ a if flag else b }} / {{ c if flag else d }}\"\n"
	p := expressionFixProject(t, "values.yml", input)
	cs, err := PlanFixes(p, Analyze(p, Rules()))
	if err != nil || len(cs) != 1 || string(cs[0].After) != want {
		t.Fatalf("multiple results: %+v %v", cs, err)
	}
}

func TestNestedLongConditionalFix(t *testing.T) {
	input := "v: \"{{ fn('" + strings.Repeat("a", 150) + "' if flag else fallback) }}\"\n"
	p := expressionFixProject(t, "values.yml", input)
	cs, err := PlanFixes(p, Analyze(p, Rules()))
	if err != nil || len(cs) != 1 {
		t.Fatalf("nested wrap: %+v %v", cs, err)
	}
	next := expressionFixProject(t, "values.yml", string(cs[0].After))
	ds := Analyze(next, jinjaRules())
	for _, d := range ds {
		if d.RuleID == "jinja-conditional-length" || d.RuleID == "jinja-layout" {
			t.Fatalf("correction remains: %+v", ds)
		}
	}
}

func TestExpressionFixFixture(t *testing.T) {
	before, err := os.ReadFile("testdata/fixes/expressions.before.yml")
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile("testdata/fixes/expressions.after.yml")
	if err != nil {
		t.Fatal(err)
	}
	p := expressionFixProject(t, "tasks/main.yml", string(before))
	ds := Analyze(p, Rules())
	cs, err := PlanFixes(p, ds)
	if err != nil || len(cs) != 1 || !bytes.Equal(cs[0].After, after) {
		t.Fatalf("fixture: %+v %v", cs, err)
	}
	var shared *Fix
	for _, d := range ds {
		if d.Fix == nil {
			continue
		}
		if shared != nil && d.Fix != shared {
			t.Fatal("structural fix was not shared")
		}
		shared = d.Fix
	}
	p.Selected["tasks/main.yml"] = false
	if cs, err := PlanFixes(p, ds); err != nil || len(cs) > 0 {
		t.Fatalf("unselected: %+v %v", cs, err)
	}
}

func TestUnsupportedLongExpressionDoesNotBorrowAnotherFix(t *testing.T) {
	input := "- debug:\n    msg: \"{{ a $ b if " + strings.Repeat("x", 170) + " else c }}\"\n  when: value is defined\n"
	p := expressionFixProject(t, "tasks/main.yml", input)
	ds := Analyze(p, Rules())
	for _, d := range ds {
		if d.RuleID == "jinja-conditional-length" && d.Fix != nil {
			t.Fatal("unsupported long expression borrowed a fix from another condition")
		}
	}
}

func TestStructuralFixRejectsExternalPreviewPromotion(t *testing.T) {
	p := expressionFixProject(t, "values.yml", "v: \"{{ (a if flag else b) }}\"\n")
	ds := Analyze(p, Rules())
	for _, d := range ds {
		if d.Fix == nil {
			continue
		}
		d.Fix = &Fix{Message: d.Fix.Message, Edits: append([]Edit(nil), d.Fix.Edits...)}
		cs, err := PlanFixes(p, []Diagnostic{d})
		if err != nil || len(cs) > 0 {
			t.Fatalf("external structural edit promoted: %+v %v", cs, err)
		}
	}
}

func TestStructuralFixPreservesValidNestedElseLayout(t *testing.T) {
	input := "v: \"{{ a\n    if flag\n    else fn(b if z else c) }}\"\nw: \"{{ (a if flag else b) }}\"\n"
	want := "v: \"{{ a\n    if flag\n    else fn(b if z else c) }}\"\nw: \"{{ a if flag else b }}\"\n"
	p := expressionFixProject(t, "values.yml", input)
	changes, err := PlanFixes(p, Analyze(p, Rules()))
	if err != nil || len(changes) != 1 || string(changes[0].After) != want {
		t.Fatalf("unrelated layout changed: %+v %v", changes, err)
	}
}
