package lint

import (
	"os"
	"strings"
	"testing"
)

func layoutProject(t *testing.T, input string) *Project {
	t.Helper()
	s := jinjaSource(t, input)
	return &Project{Sources: map[string]*Source{s.Path: s}, Selected: map[string]bool{s.Path: true}}
}
func TestLayoutFirstIfCorrection(t *testing.T) {
	input, err := os.ReadFile("testdata/jinja/first-if.bad.yaml")
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/jinja/first-if.good.yaml")
	if err != nil {
		t.Fatal(err)
	}
	assertLayoutFix(t, string(input), string(want))
}
func assertLayoutFix(t *testing.T, input, want string) {
	t.Helper()
	p := layoutProject(t, input)
	ds := Analyze(p, jinjaRules())
	if len(ds) == 0 {
		t.Fatal("missing layout diagnostic")
	}
	changes, err := PlanFixes(p, ds)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || string(changes[0].After) != want {
		t.Fatalf("changes: %+v\nwant:\n%s", changes, want)
	}
	fixed := layoutProject(t, want)
	if ds := Analyze(fixed, jinjaRules()); len(ds) > 0 {
		t.Fatalf("fixed diagnostics: %+v", ds)
	}
	again, err := PlanFixes(fixed, Analyze(fixed, jinjaRules()))
	if err != nil || len(again) != 0 {
		t.Fatalf("not idempotent: %+v %v", again, err)
	}
}
func TestLayoutExactCorrections(t *testing.T) {
	cases := []struct{ name, input, want string }{
		{"operator", "v: \"{{ a\n | combine(b) }}\"\n", "v: \"{{ a\n       | combine(b) }}\"\n"},
		{"arguments", "v: \"{{ f(a,\n b) }}\"\n", "v: \"{{ f(a,\n         b) }}\"\n"},
		{"dictionary", "v: \"{{ {'a': a,\n 'b': b} }}\"\n", "v: \"{{ {'a': a,\n        'b': b} }}\"\n"},
		{"lookup", "v: \"{{ lookup(\n 'a', 'b',\n\n role='x') }}\"\n", "v: \"{{ lookup('a',\n              'b',\n              role='x') }}\"\n"},
		{"nested_else", "v: \"{{ a if x\n    else b if y else c }}\"\n", "v: \"{{ a\n    if x\n    else b\n         if y\n         else c }}\"\n"},
		{"group", "v: \"{{ f((a\n if x\n else b),\n c) }}\"\n", "v: \"{{ f((a\n          if x\n          else b),\n         c) }}\"\n"},
		{"closers_and_segments", "v: \"https://{{ user\n }}:{{ password\n }}/db\"\n", "v: \"https://{{ user }}:{{ password }}/db\"\n"},
		{"CRLF", "v: \"{{ a\r\n | f }}\"\r\n", "v: \"{{ a\r\n       | f }}\"\r\n"},
		{"block", "v: |-\n    {{\n       a\n      | f(\n      b\n      )\n      }}\n", "v: |-\n  {{\n    a\n    | f(\n        b\n    )\n  }}\n"},
		{"literal_tokens", "v: &value '{{ ''if else }} a  b''\n | f(''it\\''s fine'') }}' # keep\n", "v: &value '{{ ''if else }} a  b''\n              | f(''it\\''s fine'') }}' # keep\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) { assertLayoutFix(t, tc.input, tc.want) })
	}
}
func TestLayoutPreservesValidAlternatives(t *testing.T) {
	for _, input := range []string{
		"v: \"{{ a if b else c }}\"\n",
		"v: \"{{ f(a, b,\n         c, d) }}\"\n",
		"v: \"{{ f(a if x else b,\n         c) }}\"\n",
		"v: \"{{ {\n      'a': a,\n      'b': b} }}\"\n",
		"v: |-\n  {{ a\n  | f }}\n",
		"v: |-\n  {{\n    a\n  }}\n",
		"v: >-\n  {{ a\n  | f }}\n",
		"v: !unsafe '{{ a\n | f }}'\n",
		"v: '{% raw %}{{ a\n | f }}{% endraw %}'\n",
		"v: \"{# {{ a | f }} #}{{ 'if else' }}\" # {{ ignored }}\n",
	} {
		p := layoutProject(t, input)
		if ds := Analyze(p, jinjaRules()); len(ds) != 0 {
			t.Errorf("valid input %q: %+v", input, ds)
		}
		cs, err := PlanFixes(p, Analyze(p, jinjaRules()))
		if err != nil || len(cs) > 0 {
			t.Errorf("valid input changed: %+v %v", cs, err)
		}
	}
}
func TestConditionalPoliciesAndRuleMetadata(t *testing.T) {
	for _, r := range Rules() {
		if r.ID == "" || r.Explanation == "" || r.GoodExample == "" || r.BadExample == "" || r.Scope == "" || len(r.Kinds) == 0 || r.Check == nil {
			t.Fatalf("incomplete metadata: %+v", r)
		}
	}
	for _, tc := range []struct {
		input, id string
		count     int
	}{
		{"v: \"{{ lookup('x', default='a' if b else 'c') }}\"", "lookup-conditional-argument", 1},
		{"v: \"{{ lookup('x', lookup('y', default='a' if b else 'c')) }}\"", "lookup-conditional-argument", 1},
		{"v: \"{{ lookup('x') if b else lookup('y') }}\"", "lookup-conditional-argument", 0},
		{"v: \"{{ lookup('if else') }}\"", "lookup-conditional-argument", 0},
		{"v: \"{{ '" + strings.Repeat("a", 150) + "' if b else c }}\"", "jinja-conditional-length", 1},
		{"v: \"{{ '" + strings.Repeat("a", 150) + " if else' }}\"", "jinja-conditional-length", 0},
		{"v: '{{ broken('", "jinja-layout", 1},
	} {
		ds := Analyze(layoutProject(t, tc.input), jinjaRules())
		n := 0
		for _, d := range ds {
			if d.RuleID == tc.id {
				n++
				if d.Expected == "" {
					t.Error("missing hint")
				}
				if tc.id == "lookup-conditional-argument" && d.Fix != nil {
					t.Error("semantic rule offered fix")
				}
			}
		}
		if n != tc.count {
			t.Errorf("%s: got %d want %d: %+v", tc.input, n, tc.count, ds)
		}
	}
}

func TestBlockBooleanGroupingIsNotAFunctionCall(t *testing.T) {
	input := "v: >-\n  {{\n    (\n     flag\n    )\n    or\n    (\n     other_flag\n    )\n  }}\n"
	if ds := Analyze(layoutProject(t, input), jinjaRules()); len(ds) > 0 {
		t.Fatalf("valid boolean grouping diagnosed: %+v", ds)
	}
}
func TestUnsupportedLayoutHasHintWithoutFix(t *testing.T) {
	for _, input := range []string{"v: \"{{ a $ b\n | f }}\"", "v: \"{{ 'unfinished\n | f }}\""} {
		p := layoutProject(t, input)
		ds := Analyze(p, jinjaRules())
		if len(ds) == 0 {
			t.Fatal("missing unsupported diagnostic")
		}
		for _, d := range ds {
			if d.RuleID == "jinja-layout" && (d.Fix != nil || d.Expected == "") {
				t.Fatalf("speculative fix: %+v", d)
			}
		}
		changes, err := PlanFixes(p, ds)
		if err != nil || len(changes) > 0 {
			t.Fatalf("unsupported changes: %+v %v", changes, err)
		}
	}
}
func TestConditionalLengthCountsPhysicalUnicodeLine(t *testing.T) {
	// 160 Unicode code points pass; 161 fail even though the expression is short.
	for _, tc := range []struct {
		input string
		want  int
	}{
		{"v: \"{{ a if b else c }}\" # " + strings.Repeat("é", 133), 0},
		{"v: \"{{ a if b else c }}\" # " + strings.Repeat("é", 134), 1},
	} {
		ds := Analyze(layoutProject(t, tc.input), jinjaRules())
		n := 0
		for _, d := range ds {
			if d.RuleID == "jinja-conditional-length" {
				n++
			}
		}
		if n != tc.want {
			t.Fatalf("count=%d want=%d line=%q", n, tc.want, tc.input)
		}
	}
}
func TestLayoutNestedLookupAndGroupingRestoresOuterOperator(t *testing.T) {
	assertLayoutFix(t, "v: \"{{ a\n | combine((b\n if x\n else c))\n | f }}\"\n", "v: \"{{ a\n       | combine((b\n                  if x\n                  else c))\n       | f }}\"\n")
	assertLayoutFix(t, "v: \"{{ lookup('a', nested(1, 2),\n role='x') }}\"\n", "v: \"{{ lookup('a',\n              nested(1, 2),\n              role='x') }}\"\n")
}
func TestExplicitBlockIndentationIndicator(t *testing.T) {
	valid := "v: |4-\n    {{\n      a\n      | f\n    }}\n"
	if ds := Analyze(layoutProject(t, valid), jinjaRules()); len(ds) > 0 {
		t.Fatalf("explicit indentation: %+v", ds)
	}
	assertLayoutFix(t, "v: |4-\n    {{\n      a\n       | f\n    }}\n", valid)
	folded := "v: >4-\n    {{ a\n    | f }}\n"
	if ds := Analyze(layoutProject(t, folded), jinjaRules()); len(ds) > 0 {
		t.Fatalf("explicit folded indentation: %+v", ds)
	}
	assertLayoutFix(t, "v: >4-\n    {{ a\n     | f }}\n", folded)
}

func TestRuleExamplesDemonstrateTheirPolicy(t *testing.T) {
	for _, r := range jinjaRules() {
		for _, tc := range []struct {
			input   string
			invalid bool
		}{{r.GoodExample, false}, {r.BadExample, true}} {
			p := layoutProject(t, tc.input)
			ds := Analyze(p, []Rule{r})
			if (len(ds) > 0) != tc.invalid {
				t.Errorf("%s example invalid=%v diagnostics=%+v", r.ID, tc.invalid, ds)
			}
		}
	}
}
func TestQuotedScalarFixesPreserveEscapedLiterals(t *testing.T) {
	assertLayoutFix(t, "v: \"{{ \\\"if else }} a  b\\\"\n | f(\\\"a\\\\\\\"b\\\") }}\" # unchanged\n", "v: \"{{ \\\"if else }} a  b\\\"\n       | f(\\\"a\\\\\\\"b\\\") }}\" # unchanged\n")
	assertLayoutFix(t, "v: !!str &anchor >-\n  {{ 'a  b'\n   | f }}\n", "v: !!str &anchor >-\n  {{ 'a  b'\n  | f }}\n")
	assertLayoutFix(t, "v: \"{{ 'a\n  b'\n | f }}\"\n", "v: \"{{ 'a\n  b'\n       | f }}\"\n")
}
func TestDiagnosticFixesAreIndependentlySafeAndStable(t *testing.T) {
	p := layoutProject(t, "v: \"{{ a if b\n    else c }}\"\n")
	ds := Analyze(p, jinjaRules())
	if len(ds) == 0 {
		t.Fatal("missing finding")
	}
	for _, d := range ds {
		if d.Fix == nil {
			t.Fatal("missing verified payload")
		}
		changes, err := PlanFixes(p, []Diagnostic{d})
		if err != nil || len(changes) != 1 {
			t.Fatalf("payload not independently usable: %+v %v", changes, err)
		}
		after := string(changes[0].After)
		want := "v: \"{{ a\n    if b\n    else c }}\"\n"
		if after != want {
			t.Fatalf("after %q want %q", after, want)
		}
	}
}

func jinjaRules() []Rule {
	var rules []Rule
	for _, r := range Rules() {
		switch r.ID {
		case "jinja-layout", "jinja-conditional-length", "lookup-conditional-argument":
			rules = append(rules, r)
		}
	}
	return rules
}
func TestLayoutPreservesWhitespaceControlDelimiters(t *testing.T) {
	assertLayoutFix(t, "v: \"{{- a\n | f\n -}}\"\n", "v: \"{{- a\n        | f -}}\"\n")
}

func TestConditionalValuesOwnTheirAlignment(t *testing.T) {
	assertLayoutFix(t, "v: \"{{ {'key': a\n        if flag\n        else b} }}\"\n", "v: \"{{ {'key': a\n               if flag\n               else b} }}\"\n")
	assertLayoutFix(t, "v: \"{{ f(option=a\n         if flag\n         else b) }}\"\n", "v: \"{{ f(option=a\n                if flag\n                else b) }}\"\n")
	valid := "v: \"{{ f(option=(a\n                 if flag\n                 else b)) }}\"\n"
	if ds := Analyze(layoutProject(t, valid), jinjaRules()); len(ds) > 0 {
		t.Fatalf("parenthesized value: %+v", ds)
	}
}
func TestEscapedDelimitersRetainOriginalBoundsDuringFixes(t *testing.T) {
	assertLayoutFix(t, "v: \"\\u007b\\u007b a\n | f\n \\u007d\\u007d\"\n", "v: \"\\u007b\\u007b a\n                 | f \\u007d\\u007d\"\n")
}
func TestExplicitBlockIndicatorAfterVerbatimTag(t *testing.T) {
	valid := "v: !<tag:yaml.org,2002:str> &anchor |4-\n    {{\n      a\n    }}\n"
	if ds := Analyze(layoutProject(t, valid), jinjaRules()); len(ds) > 0 {
		t.Fatalf("tagged indicator: %+v", ds)
	}
}

func TestKeywordNamesAreNotConditionalOperators(t *testing.T) {
	inputs := []string{
		"v: \"{{ data.if\n       + data.else }}\"\n",
		"v: \"{{ data.if(a,\n               b)\n       + data.else }}\"\n",
		"v: \"{{ f(if=a, else=b,\n         other=c) }}\"\n",
		"v: \"{{ {if: a,\n        else: b} }}\"\n",
		"v: \"{{ value | if\n       + value | else }}\"\n",
		"v: \"{{ value is if\n       + value is not else }}\"\n",
		"v: \"{{ lookup('vars', data.if + data.else) }}\"\n",
		"v: \"{{ lookup('vars', f(if=a, else=b), {if: a, else: b}) }}\"\n",
		"v: \"{{ data.if + data.else }}\" # " + strings.Repeat("x", 170) + "\n",
	}
	for _, input := range inputs {
		t.Run(input, func(t *testing.T) {
			p := layoutProject(t, input)
			ds := Analyze(p, jinjaRules())
			if len(ds) > 0 {
				t.Fatalf("valid name positions: %+v", ds)
			}
			changes, err := PlanFixes(p, ds)
			if err != nil || len(changes) > 0 {
				t.Fatalf("valid formatting changed: %+v %v", changes, err)
			}
		})
	}
}
func TestOmittedElseConditionalPolicies(t *testing.T) {
	for _, tc := range []struct {
		input, id string
		want      int
	}{
		{"v: \"{{ lookup('vars', field if enabled) }}\"", "lookup-conditional-argument", 1},
		{"v: \"{{ lookup('vars', f(field if enabled)) }}\"", "lookup-conditional-argument", 1},
		{"v: \"{{ lookup('vars', lookup('vars', field if enabled)) }}\"", "lookup-conditional-argument", 1},
		{"v: \"{{ lookup('vars', data.if if enabled else data.else) }}\"", "lookup-conditional-argument", 1},
		{"v: \"{{ lookup('vars', field) if enabled }}\"", "lookup-conditional-argument", 0},
		{"v: \"{{ field if enabled }}\" # " + strings.Repeat("x", 170), "jinja-conditional-length", 1},
		{"v: \"{{ field if enabled }}\"", "jinja-conditional-length", 0},
	} {
		p := layoutProject(t, tc.input)
		ds := Analyze(p, jinjaRules())
		n := 0
		for _, d := range ds {
			if d.RuleID == tc.id {
				n++
				if tc.id == "lookup-conditional-argument" && d.Fix != nil {
					t.Fatalf("semantic correction: %+v", d)
				}
				if strings.Contains(d.Expected, "if and else") {
					t.Fatalf("omitted-else hint invents branch: %+v", d)
				}
			}
		}
		if n != tc.want {
			t.Fatalf("%s: got%d want%d diagnostics=%+v", tc.input, n, tc.want, ds)
		}
	}
}
func TestOmittedElseLayoutPreservesConditionalOwnership(t *testing.T) {
	assertLayoutFix(t, "v: \"{{ field\n if enabled }}\"\n", "v: \"{{ field\n    if enabled }}\"\n")
	assertLayoutFix(t, "v: \"{{ f((field\n if enabled)) }}\"\n", "v: \"{{ f((field\n          if enabled)) }}\"\n")
	assertLayoutFix(t, "v: \"{{ a if first\n    else field if enabled }}\"\n", "v: \"{{ a\n    if first\n    else field\n         if enabled }}\"\n")
	assertLayoutFix(t, "v: \"{{ data.if if enabled\n    else data.else }}\"\n", "v: \"{{ data.if\n    if enabled\n    else data.else }}\"\n")
}

func TestKeywordNamedAttributeCallUsesWholeCalleeAnchor(t *testing.T) {
	valid := "v: >-\n  {{\n    data.if(\n      a,\n      b\n    )\n  }}\n"
	p := layoutProject(t, valid)
	if ds := Analyze(p, jinjaRules()); len(ds) > 0 {
		t.Fatalf("valid attribute call: %+v", ds)
	}
	changes, err := PlanFixes(p, Analyze(p, jinjaRules()))
	if err != nil || len(changes) > 0 {
		t.Fatalf("valid attribute call changed: %+v %v", changes, err)
	}
}
func TestLookupDiagnosticOwnsTheActualConditionalToken(t *testing.T) {
	input := "v: \"{{ lookup('vars', data.if if enabled else data.else) }}\""
	ds := Analyze(layoutProject(t, input), jinjaRules())
	if len(ds) != 1 || ds[0].RuleID != "lookup-conditional-argument" || ds[0].Span != (Span{Start: 30, End: 32}) {
		t.Fatalf("wrong conditional location: %+v", ds)
	}
	for _, input := range []string{
		"v: \"{{ lookup('vars', {if: field if enabled, else: data.else}) }}\"",
		"v: \"{{ lookup('vars', data.if(field if enabled)) }}\"",
	} {
		ds := Analyze(layoutProject(t, input), jinjaRules())
		if len(ds) != 1 || ds[0].RuleID != "lookup-conditional-argument" {
			t.Fatalf("nested real conditional: %+v", ds)
		}
	}
}

func TestLayoutKeepsInlineNestedElseConditional(t *testing.T) {
	input := "v: \"{{ a\n    if flag\n    else fn(b if z else c) }}\"\n"
	p := layoutProject(t, input)
	ds := Analyze(p, jinjaRules())
	if len(ds) != 0 {
		t.Fatalf("already-valid layout diagnosed: %+v", ds)
	}
	changes, err := PlanFixes(p, ds)
	if err != nil || len(changes) != 0 {
		t.Fatalf("already-valid layout changed: %+v %v", changes, err)
	}
}
