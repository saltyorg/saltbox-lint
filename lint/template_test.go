package lint

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestTemplateScanner(t *testing.T) {
	cases := []struct{ name, input, errorText, partial string }{
		{"literal layout", " \t  literal }} %} #}\r\n\r\n  no final newline", "", ""},
		{"for unpacked target", "{% for a, b in items %}{{ a }}{% endfor %}", "", ""},
		{"for trailing target comma", "{% for a, in items %}{{ a }}{% endfor %}", "", ""},
		{"for grouped target", "{% for (a) in items %}{{ a }}{% endfor %}", "", ""},
		{"for nested target tuple", "{% for (a, (b, c)), d in items %}{{ a }}{% endfor %}", "", ""},
		{"for tuple iterable", "{% for x in first, second, %}{{ x }}{% endfor %}", "", ""},
		{"for filtered tuple iterable", "{% for x in first, second, if ready %}{{ x }}{% endfor %}", "", ""},
		{"for filtered iterable", "{% for x in items if ready %}{{ x }}{% endfor %}", "", ""},
		{"for recursive iterable", "{% for x in items recursive %}{{ x }}{% endfor %}", "", ""},
		{"for filtered recursive iterable", "{% for x in items if ready recursive %}{{ x }}{% endfor %}", "", ""},
		{"for nested conditional iterable", "{% for x in (items if ready else backup) %}{{ x }}{% endfor %}", "", ""},
		{"for conditional filter", "{% for x in items if ready if flag else backup %}{{ x }}{% endfor %}", "", ""},
		{"for quoted keywords", "{% for x in choose('if', 'recursive', 'else', 'in') %}{{ x }}{% endfor %}", "", ""},
		{"for custom trim whitespace", "#jinja2:block_start_string:'<%',block_end_string:'%>'\n<%- for\u00a0a, b\u2003in items if ready recursive +%> {{ a }} <% endfor -%>", "", ""},
		{"for ignored raw grammar", "{% raw %}{% for , in items if ready else backup %}{% endraw %}", "", ""},
		{"for literal target", "{% for true in items %}literal{% endfor %}", "", "statement argument grammar"},
		{"for double target comma", "{% for a,, b in items %}literal{% endfor %}", "", "statement argument grammar"},
		{"for missing iterable", "{% for x in %}literal{% endfor %}", "", "statement argument grammar"},
		{"for missing filter", "{% for x in items if %}literal{% endfor %}", "", "statement argument grammar"},
		{"for repeated recursive", "{% for x in items recursive recursive %}literal{% endfor %}", "", "statement argument grammar"},
		{"for adjacent targets", "{% for a b in items %}{{ a }}{% endfor %}", "", "statement argument grammar"},
		{"for empty comma target", "{% for , in items %}literal{% endfor %}", "", "statement argument grammar"},
		{"for conditional iterable", "{% for x in items if ready else backup %}{{ x }}{% endfor %}", "", "statement argument grammar"},
		{"nested branches", "{% if a %}{% for item in items %}{{ item }}{% else %}empty{% endfor %}{% elif b %}b{% else %}c{% endif %}", "", ""},
		{"quoted delimiters", `{{ '}} {{ {% #}' }}{% if value == '%}' %}yes{% endif %}`, "", ""},
		{"comments", "{# {{ {% unmatched \" #}\n{{ value }}", "", ""},
		{"raw", "{% raw -%}{{ {# {% nonsense %}\n{% if \" {{\n{%- endraw %}{{ value }}", "", ""},
		{"overlapping raw start occurrences", "#jinja2:block_start_string:'aaa'\naaaraw%}aaaaendraw%}", "", ""},
		{"trim-like custom ending", "#jinja2:block_end_string:'-}}'\n{% raw-}}{{ literal{% endraw-}}", "", ""},
		{"Unicode raw ending", "{% raw %}{{ literal{%\u00a0endraw\u00a0%}", "", ""},
		{"trim", "{%- if a +%}\t{{- value -}}{#- ignore -#}{%+ endif -%}", "", ""},
		{"output plus before bare end", "{{ value +}}", "", "expression grammar"},
		{"output minus before trim end", "{{ value --}}", "", "expression grammar"},
		{"custom", "#jinja2:variable_start_string:'[[',variable_end_string:']]',block_start_string:'<%',block_end_string:'%>',comment_start_string:'<#',comment_end_string:'#>',trim_blocks:False\r\n<% if yes %>[[ ']]' ]]<# ignored <% #><% endif %>", "", ""},
		{"missing end", "{% if a %}literal", "missing endif", ""},
		{"mismatched block", "{% if a %}{% endfor %}", "unexpected endfor", ""},
		{"duplicate else", "{% if a %}{% else %}{% else %}{% endif %}", "follows an else", ""},
		{"elif after else", "{% if a %}{% else %}{% elif b %}{% endif %}", "follows an else", ""},
		{"orphan elif", "{% elif a %}", "no matching", ""},
		{"for elif", "{% for x in xs %}{% elif a %}{% endfor %}", "no matching", ""},
		{"empty", "{{ }}", "empty", ""},
		{"empty condition", "{% if %}{% endif %}", "requires arguments", "statement argument grammar"},
		{"unclosed output", "{{ value", "unterminated Jinja tag", ""},
		{"unclosed comment", "{# text", "unterminated Jinja comment", ""},
		{"unclosed string", "{{ 'text }}", "unterminated quoted", ""},
		{"mismatched bracket", "{{ f(] }}", "mismatched bracket", ""},
		{"unclosed raw", "{% raw %}literal {{", "missing endraw", ""},
		{"raw args", "{% raw extra %}literal{% endraw %}", "does not accept", ""},
		{"wrong end label", "{% block title %}x{% endblock wrong %}", "mismatched", ""},
		{"end arguments", "{% if a %}{% endif junk %}", "invalid", ""},
		{"macro and call bounds", "{% macro render(x) %}{{ x }}{% endmacro %}{% call render(a) %}text{% endcall %}", "", ""},
		{"with", "{% with %}literal{% endwith %}", "", ""},
		{"capture filter keyword", "{% set value | default(x=1) %}literal{% endset %}", "", "statement argument grammar"},
		{"extension", "{% custom thing %}{% endif %}{{ value }}", "", "unsupported template statement"},
		{"extension literal grammar", "{% custom_raw %}{{ unterminated{% endcustom_raw %}", "", "unsupported template statement"},
		{"unsupported Unicode identifier", "{{ lookup\u0301('role_var', '_port', role='beta') }}", "", "Unicode source boundaries"},
		{"unsupported expression", "{{ [x for x in values] }}", "", "expression grammar"},
		{"unknown config", "#jinja2:unknown:True\n{{ value", "", "option: unknown"},
		{"long delimiter", "#jinja2:variable_start_string:'" + strings.Repeat("a", 33) + "'\n{{ unclosed", "", "size or whitespace"},
		{"custom self-overlap end", "#jinja2:variable_end_string:'aaa'\n{{ value +aaaa", "", "may split"},
		{"overlapping config", "#jinja2:variable_start_string:'{'\n{{ value", "", "overlapping"},
		{"invalid config", "#jinja2:variable_start_string:False\n{{ value", "", "plain quoted"},
		{"config escapes", "#jinja2:variable_start_string:'\\x7b'\n{{ value", "", "plain quoted"},
		{"line prefixes", "#jinja2:line_statement_prefix:'#'\n{{ value", "", "line statements"},
		{"config missing newline", "#jinja2:trim_blocks:True", "", "missing header newline"},
		{"config boolean", "#jinja2:trim_blocks:true\n{{ value", "", "Python boolean"},
		{"invalid UTF8", string([]byte{0xff}), "", "not valid UTF-8"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := []byte(tc.input)
			s, _ := Parse("roles/demo/templates/config", before)
			scan := scanTemplate(s)
			if tc.errorText == "" && len(scan.diagnostics) > 0 {
				t.Fatalf("fabricated syntax errors: %+v", scan.diagnostics)
			}
			if tc.errorText != "" && !slices.ContainsFunc(scan.diagnostics, func(d Diagnostic) bool { return strings.Contains(d.Message, tc.errorText) }) {
				t.Fatalf("missing %q: %+v", tc.errorText, scan.diagnostics)
			}
			reasons := strings.Join(scan.reasons, ";")
			if tc.partial == "" && reasons != "" || tc.partial != "" && !strings.Contains(reasons, tc.partial) {
				t.Fatalf("partial %q wanted %q", reasons, tc.partial)
			}
			if !bytes.Equal(before, s.Data) {
				t.Fatal("scanner changed template")
			}
			for _, e := range scan.expressions {
				for _, token := range e.Tokens {
					if token.Span.Start < e.Span.Start || token.Span.End > e.Span.End || string(s.Data[token.Span.Start:token.Span.End]) != token.Text {
						t.Fatalf("original token mapping: %+v", token)
					}
				}
			}
		})
	}
}

func TestTemplateBodyTokensPreserveEndAdjacentArithmetic(t *testing.T) {
	for _, tc := range []struct {
		name, input, last, partial string
	}{
		{"bare end", "é\r\n{{ value}}", "value", ""},
		{"actual trim", "é\r\n{{- value-}}", "value", ""},
		{"plus", "é\r\n{{ value +}}", "+", "expression grammar"},
		{"minus before trim", "é\r\n{{ value --}}", "-", "expression grammar"},
		{"leading plus", "{{+value}}", "value", "expression grammar"},
		{"custom bare end", "#jinja2:variable_end_string:']]'\n{{ value]]", "value", ""},
		{"custom trim-like end", "#jinja2:variable_end_string:'-}}'\n{{ value-}}", "value", ""},
		{"custom plus end", "#jinja2:variable_end_string:'+}}'\n{{ value +}}", "value", ""},
		{"custom plus before end", "#jinja2:variable_end_string:'+}}'\n{{ value ++}}", "+", "expression grammar"},
		{"custom minus before trim", "#jinja2:variable_end_string:'-}}'\n{{ value ---}}", "-", "expression grammar"},
		{"default ending inside custom body", "#jinja2:variable_end_string:']]'\n{{ value +}}]]", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := []byte(tc.input)
			source, _ := Parse("value.j2", data)
			scan := scanTemplate(source)
			if tc.last == "" {
				if len(scan.diagnostics) == 0 {
					t.Fatal("custom tag body silently accepted an unmatched default ending")
				}
				return
			}
			if len(scan.diagnostics) != 0 || len(scan.expressions) != 1 {
				t.Fatalf("expressions=%+v diagnostics=%+v", scan.expressions, scan.diagnostics)
			}
			tokens := scan.expressions[0].Tokens
			if len(tokens) == 0 || tokens[len(tokens)-1].Text != tc.last {
				t.Fatalf("lost end-adjacent token %q: %+v", tc.last, tokens)
			}
			if tc.name == "leading plus" && tokens[0].Text != "+" {
				t.Fatal("lost first body token as a synthetic opening control")
			}
			for _, token := range tokens {
				if string(source.Data[token.Span.Start:token.Span.End]) != token.Text {
					t.Fatalf("token source bytes differ: %+v", token)
				}
			}
			reasons := strings.Join(scan.reasons, ";")
			if tc.partial == "" && reasons != "" || tc.partial != "" && !strings.Contains(reasons, tc.partial) {
				t.Fatalf("partial=%q want=%q", reasons, tc.partial)
			}
			state := "static-template"
			if tc.partial != "" {
				state = "partial-template"
			}
			if observedSource(source).ParseState != state || !bytes.Equal(data, source.Data) {
				t.Fatal("coverage state or original bytes changed")
			}
		})
	}
}

func TestTemplateSelectionReferencesAndPreservation(t *testing.T) {
	root := t.TempDir()
	name := "roles/alpha/templates/config"
	text := "\t \r\n{% if enabled -%}\r\n{{ lookup('role_var', '_port', role='beta') }}\r\n{% endif %}  "
	filename := putFile(t, root, name, text)
	putFile(t, root, "roles/alpha/defaults/main.yml", "alpha_role_value: true\n")
	putFile(t, root, "roles/beta/defaults/main.yml", "beta_role_port: 1234\n")
	for _, op := range []string{"definition", "hover", "references", "completion"} {
		q, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, Source: []byte(text), Operation: op, Offset: strings.Index(text, "_port")})
		if err != nil {
			t.Fatal(err)
		}
		if op == "completion" {
			if len(q.Completions) != 0 || q.State != "unavailable" {
				t.Fatalf("template completion: %+v", q)
			}
			continue
		}
		if q.State != "resolved" || len(q.Declarations) != 1 || q.Origin.Line != 3 {
			t.Fatalf("template static read: %+v", q)
		}
	}
	refs, err := References(t.Context(), Options{Root: root, Paths: []string{filename}})
	if err != nil || len(refs.References) != 1 || refs.References[0].State != "resolved" {
		t.Fatalf("template references: %+v %v", refs, err)
	}
	for _, input := range []string{`{% set lookup = local %}{{ lookup('role_var', '_port', role='beta') }}`, `{% macro lookup(x) %}x{% endmacro %}{{ lookup('role_var', '_port', role='beta') }}`, `{% extension %}{{ lookup('role_var', '_port', role='beta') }}`} {
		s, _ := Parse(name, []byte(input))
		reads := sourceRoleReferences(s)
		if strings.Contains(input, "extension") {
			if len(reads) != 0 {
				t.Fatal("unknown extension produced static reads")
			}
		} else if len(reads) != 1 || reads[0].State != "dynamic" {
			t.Fatalf("local binding claimed resolved: %+v", reads)
		}
	}
	p, err := Load(t.Context(), Options{Root: root, Paths: []string{filename}})
	if err != nil {
		t.Fatal(err)
	}
	ds := Analyze(p, Rules())
	changes, err := PlanFixes(p, ds)
	if err != nil || len(changes) != 0 {
		t.Fatalf("template edit plan: %+v %v", changes, err)
	}
	for _, d := range ds {
		if d.Fix != nil {
			t.Fatal("template diagnostic has fix")
		}
	}
	if err := RequireWritableSelection(p); err == nil {
		t.Fatal("template was writable")
	}
	bytesAfter, err := os.ReadFile(filename)
	if err != nil || string(bytesAfter) != text {
		t.Fatal("template bytes changed")
	}
	directory, err := Load(t.Context(), Options{Root: root, Paths: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	if directory.Selected[name] {
		t.Fatal("template entered default discovery")
	}
}

func TestTemplateRendererOwnership(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: "- template: {src: router.yml.j2, dest: /router.yml}\n", traefikTemplatePath: traefikFixture(t, "renderer.bad.j2")}
	for name, value := range files {
		putFile(t, root, name, value)
	}
	ruleOnly := []Rule{}
	for _, rule := range Rules() {
		if rule.ID == "traefik-renderer-contract" || rule.ID == "template-renderer-contract" {
			ruleOnly = append(ruleOnly, rule)
		}
	}
	for _, selection := range [][]string{{traefikTasksPath}, {traefikTemplatePath}, {traefikTasksPath, traefikTemplatePath}, {".", traefikTemplatePath}} {
		paths := []string{}
		for _, name := range selection {
			paths = append(paths, filepath.Join(root, filepath.FromSlash(name)))
		}
		p, err := Load(t.Context(), Options{Root: root, Paths: paths})
		if err != nil {
			t.Fatal(err)
		}
		ds := Analyze(p, ruleOnly)
		want := traefikTasksPath
		if slices.Contains(selection, traefikTemplatePath) {
			want = traefikTemplatePath
		}
		if len(ds) != 1 || ds[0].Path != want || ds[0].Fix != nil {
			t.Fatalf("ownership %v: %+v", selection, ds)
		}
	}
}

func TestTemplateRendererMultipleOutputOwnership(t *testing.T) {
	const a = "roles/example/templates/a.j2"
	const b = "roles/example/templates/b.j2"
	const otherTask = "roles/example/tasks/z.yml"
	for _, separateTasks := range []bool{false, true} {
		t.Run(fmt.Sprintf("separate tasks=%v", separateTasks), func(t *testing.T) {
			root := t.TempDir()
			taskA := "- template: {src: a.j2, dest: /a}\n"
			taskB := "- template: {src: b.j2, dest: /b}\n"
			putFile(t, root, traefikDefaultsPath, traefikFixture(t, "api.good.yml"))
			putFile(t, root, a, "{% if example_role_traefik_api_enabled %}{{ traefik_middleware_api }}{% endif %}\n")
			putFile(t, root, b, "{{ example_role_traefik_api_endpoint }}\n")
			bOwner := traefikTasksPath
			if separateTasks {
				putFile(t, root, traefikTasksPath, taskA)
				putFile(t, root, otherTask, taskB+taskB)
				bOwner = otherTask
			} else {
				putFile(t, root, traefikTasksPath, taskA+taskB+taskB)
			}
			rules := traefikRules("traefik-renderer-contract")
			analyze := func(selection []string) []Diagnostic {
				t.Helper()
				paths := make([]string, len(selection))
				for i, name := range selection {
					paths[i] = filepath.Join(root, filepath.FromSlash(name))
				}
				p, err := Load(t.Context(), Options{Root: root, Paths: paths})
				if err != nil {
					t.Fatal(err)
				}
				return Analyze(p, rules)
			}
			allSelection := []string{traefikTasksPath, a, b}
			if separateTasks {
				allSelection = append(allSelection, otherTask)
			}
			all := analyze(allSelection)
			for _, tc := range []struct {
				name              string
				selection, owners []string
			}{
				{"A only", []string{a}, []string{a}},
				{"B only", []string{b}, []string{b}},
				{"YAML only", []string{traefikTasksPath}, []string{traefikTasksPath}},
				{"YAML plus A", []string{traefikTasksPath, a}, []string{a}},
				{"YAML plus B", []string{traefikTasksPath, b}, []string{traefikTasksPath, b}},
				{"all", allSelection, []string{a, b}},
			} {
				t.Run(tc.name, func(t *testing.T) {
					ds := analyze(tc.selection)
					var owners []string
					for _, d := range ds {
						owners = append(owners, d.Path)
						if d.Fix != nil {
							t.Fatal("template contract offered fix")
						}
						if d.Path != a && d.Path != b {
							continue
						}
						wantMissing, owner := "_traefik_api_endpoint", traefikTasksPath
						if d.Path == b {
							wantMissing, owner = "traefik_middleware_api, _traefik_api_enabled", bOwner
						}
						if !strings.Contains(d.Expected, "Render "+wantMissing+" using") {
							t.Fatalf("wrong renderer evidence: %+v", d)
						}
						if !slices.ContainsFunc(d.Related, func(r RelatedLocation) bool {
							return r.Path == owner && r.Message == "template referenced by this task"
						}) {
							t.Fatalf("wrong task owner: %+v", d)
						}
						if !slices.ContainsFunc(all, func(full Diagnostic) bool { return reflect.DeepEqual(full, d) }) {
							t.Fatalf("selected/full template mismatch: %+v %+v", ds, all)
						}
					}
					if !reflect.DeepEqual(owners, tc.owners) {
						t.Fatalf("owners=%v want=%v: %+v", owners, tc.owners, ds)
					}
				})
			}
			putFile(t, root, b, traefikFixture(t, "renderer.good.j2"))
			for _, selection := range [][]string{{a}, {b}, {traefikTasksPath}, {traefikTasksPath, a, b}} {
				if ds := analyze(selection); len(ds) != 0 {
					t.Fatalf("complete role output regressed: %+v", ds)
				}
			}
		})
	}
}

func TestTemplateRendererUnavailableFacts(t *testing.T) {
	good := traefikFixture(t, "renderer.good.j2")
	for _, tc := range []struct {
		name, text, reason string
		missing            bool
	}{
		{"unsupported config", "#jinja2:line_statement_prefix:'#'\n" + good, "line statements", false},
		{"unsupported extension", "{% unknown_extension %}\n" + good, "unsupported template statement", false},
		{"unsupported expression", "{{ [x for x in values] }}\n", "expression grammar", false},
		{"unsupported statement", "{% with value=source %}literal{% endwith %}\n", "statement argument grammar", false},
		{"default supported good", good, "", false},
		{"default supported bad", traefikFixture(t, "renderer.bad.j2"), "", true},
		{"custom supported good", "#jinja2:variable_start_string:'[[',variable_end_string:']]'\n" + strings.ReplaceAll(strings.ReplaceAll(good, "{{", "[["), "}}", "]]"), "", false},
		{"identifier ending", "#jinja2:variable_end_string:'api'\n" + strings.ReplaceAll(good, "}}", "api"), "may split", false},
		{"filtered capture", "{% set ignored | default(value=true) %}\n" + good + "{% endset %}\n", "statement argument grammar", true},
		{"discarded list assignment", "{% set ignored = [traefik_middleware_api, example_role_traefik_api_enabled, example_role_traefik_api_endpoint] %}\n", "statement argument grammar", true},
		{"list guard", "{% if [traefik_middleware_api, example_role_traefik_api_enabled, example_role_traefik_api_endpoint] %}literal{% endif %}\n", "statement argument grammar", true},
		{"unsupported assignment comprehension", "{% set ignored = [x for x in values] %}\n", "statement argument grammar", false},
		{"unsupported guard comprehension", "{% if [x for x in values] %}literal{% endif %}\n", "statement argument grammar", false},
		{"unsupported capture argument", "{% set ignored | default([x for x in values]) %}literal{% endset %}\n", "statement argument grammar", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			putFile(t, root, traefikDefaultsPath, traefikFixture(t, "api.good.yml"))
			putFile(t, root, traefikTasksPath, "- template: {src: router.yml.j2, dest: /router.yml}\n")
			putFile(t, root, traefikTemplatePath, tc.text)
			for _, selection := range [][]string{{traefikTasksPath}, {traefikTemplatePath}, {traefikTasksPath, traefikTemplatePath}} {
				paths := make([]string, len(selection))
				for i, name := range selection {
					paths[i] = filepath.Join(root, filepath.FromSlash(name))
				}
				p, err := Load(t.Context(), Options{Root: root, Paths: paths})
				if err != nil {
					t.Fatal(err)
				}
				rules := append(traefikRules("traefik-renderer-contract"), traefikRules("template-partial-coverage")...)
				ds := Analyze(p, rules)
				selectedTemplate := slices.Contains(selection, traefikTemplatePath)
				want := 0
				if tc.reason != "" && selectedTemplate {
					want++
				}
				if tc.missing {
					want++
				}
				if len(ds) != want {
					t.Fatalf("%v diagnostics=%+v want=%d", selection, ds, want)
				}
				for _, d := range ds {
					if d.RuleID == "template-partial-coverage" {
						if d.Path != traefikTemplatePath || !strings.Contains(d.Message, tc.reason) {
							t.Fatalf("lost partial reason: %+v", d)
						}
					} else {
						owner := traefikTasksPath
						if selectedTemplate {
							owner = traefikTemplatePath
						}
						if !tc.missing || d.Path != owner || d.RuleID != "traefik-renderer-contract" {
							t.Fatalf("unavailable facts became missing policy: %+v", d)
						}
					}
				}
				if string(p.Sources[traefikTemplatePath].Data) != tc.text {
					t.Fatal("renderer inspection changed bytes")
				}
				facts := analyzeTraefikRole(p, p.Sources[traefikTemplatePath])
				if len(facts.renderers) != 1 {
					t.Fatalf("renderer facts unavailable: %+v", facts)
				}
				if (len(facts.renderers[0].Unavailable) > 0) != (tc.reason != "" && !tc.missing) {
					t.Fatalf("lost fact availability: %+v", facts.renderers[0])
				}
			}
		})
	}
}

func TestTemplateRendererInvalidContextOwnership(t *testing.T) {
	for _, broken := range []string{traefikDefaultsPath, "roles/example/tasks/broken.yml"} {
		root := t.TempDir()
		putFile(t, root, traefikDefaultsPath, traefikFixture(t, "api.good.yml"))
		putFile(t, root, traefikTasksPath, "- template: {src: router.yml.j2, dest: /router.yml}\n")
		putFile(t, root, traefikTemplatePath, traefikFixture(t, "renderer.bad.j2"))
		putFile(t, root, broken, "broken: [\n")
		for _, selection := range [][]string{{traefikTasksPath}, {traefikTemplatePath}, {traefikTasksPath, traefikTemplatePath}} {
			paths := make([]string, len(selection))
			for i, name := range selection {
				paths[i] = filepath.Join(root, filepath.FromSlash(name))
			}
			p, err := Load(t.Context(), Options{Root: root, Paths: paths})
			if err != nil {
				t.Fatal(err)
			}
			ds := Analyze(p, traefikRules("traefik-renderer-contract"))
			owner := traefikTasksPath
			if slices.Contains(selection, traefikTemplatePath) {
				owner = traefikTemplatePath
			}
			if len(ds) != 1 || ds[0].Path != owner || !strings.Contains(ds[0].Message, "invalid") || !slices.ContainsFunc(ds[0].Related, func(r RelatedLocation) bool { return r.Path == broken }) {
				t.Fatalf("%s %v contextual ownership: %+v", broken, selection, ds)
			}
		}
	}
}

func TestTemplateScannerBounds(t *testing.T) {
	for _, input := range []string{strings.Repeat("x", 16*1024*1024+1), "{{ " + strings.Repeat("(", 129) + "value", strings.Repeat("{% if enabled %}", 129) + strings.Repeat("{% endif %}", 129), "{{ " + strings.Repeat("a ", 513) + "}}"} {
		source, _ := Parse("bounded.j2", []byte(input))
		scan := scanTemplate(source)
		if len(scan.reasons) == 0 || len(scan.diagnostics) > 0 {
			t.Fatalf("scanner bound fabricated full validation: %+v", scan)
		}
	}
}

func TestTemplateCommittedFixtures(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		diagnostics, partial bool
	}{{"valid.j2", false, false}, {"invalid.j2", true, false}, {"partial.j2", false, true}, {"custom.j2", false, false}, {"whitespace-valid.j2", false, false}, {"whitespace-invalid.j2", true, false}, {"for-valid.j2", false, false}, {"for-partial.j2", false, true}} {
		t.Run(tc.name, func(t *testing.T) {
			data, err := os.ReadFile("testdata/templates/" + tc.name)
			if err != nil {
				t.Fatal(err)
			}
			source, _ := Parse("roles/demo/templates/"+tc.name, data)
			scan := scanTemplate(source)
			if (len(scan.diagnostics) > 0) != tc.diagnostics || (len(scan.reasons) > 0) != tc.partial {
				t.Fatalf("fixture coverage: %+v", scan)
			}
			if !bytes.Equal(data, source.Data) {
				t.Fatal("fixture bytes changed")
			}
		})
	}
}

func TestTemplateUnavailableQueriesKeepPrimaryDependencies(t *testing.T) {
	root := t.TempDir()
	filename := filepath.Join(root, "value.j2")
	for _, tc := range []struct{ operation, source string }{{"completion", "{{ value }}"}, {"definition", "{% if value %}"}} {
		result, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, Operation: tc.operation, Source: []byte(tc.source), Offset: 0})
		if err != nil || result.State != "unavailable" || result.Dependencies == nil || len(result.Dependencies.Sources) != 1 || result.Dependencies.Sources[0].Path != "value.j2" {
			t.Fatalf("unavailable protocol %s: %+v %v", tc.operation, result, err)
		}
	}
	source, _ := Parse("value.j2", []byte("{{ value }}"))
	project := &Project{Sources: map[string]*Source{"value.j2": source}, Selected: map[string]bool{"value.j2": false}}
	if err := RequireWritableSelection(project); err != nil {
		t.Fatalf("unselected template blocked write preflight: %v", err)
	}
	project.Selected["value.j2"] = true
	if err := RequireWritableSelection(project); err == nil {
		t.Fatal("selected template entered writable selection")
	}
}

func TestTemplateLargeRawLiteralDoesNotRescanTagEndings(t *testing.T) {
	input := "{% raw %}" + strings.Repeat("{%", 512*1024) + "{% endraw %}{{ value }}"
	source, _ := Parse("literal.j2", []byte(input))
	scan := scanTemplate(source)
	if len(scan.diagnostics) > 0 || len(scan.reasons) > 0 || len(scan.expressions) != 1 || scan.expressions[0].Tokens[0].Text != "value" {
		t.Fatalf("raw literal interpreted or ending lost: %+v", scan)
	}
	if string(source.Data) != input {
		t.Fatal("raw source bytes changed")
	}
}

func TestTemplateStoredOutputBounds(t *testing.T) {
	for _, tc := range []struct {
		name, input, reason string
		diagnostics         int
	}{
		{"configuration whitespace", "#jinja2:trim_blocks:" + strings.Repeat(" ", 4096) + "True\n{{ unclosed", "4 KiB", 0},
		{"tags", strings.Repeat("{{ a }}", 4097), "4096 tag", 0},
		{"aggregate tokens", strings.Repeat("{{ f("+strings.Repeat("a,", 63)+"a) }}", 260), "32768 token", 0},
		{"lexing bytes", "{{ '" + strings.Repeat("a", 64*1024) + "' }}", "64 KiB", 0},
		{"long raw opening whitespace", "{% " + strings.Repeat(" ", 64*1024) + "raw %}{{ literal{% endraw %}", "64 KiB", 0},
		{"diagnostics", strings.Repeat("{{ }}", 129), "128 finding", 128},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source, _ := Parse("bounded.j2", []byte(tc.input))
			scan := scanTemplate(source)
			if len(scan.diagnostics) != tc.diagnostics || !strings.Contains(strings.Join(scan.reasons, ";"), tc.reason) {
				t.Fatalf("stored output not bounded or explanation omitted: %+v", scan)
			}
			if string(source.Data) != tc.input {
				t.Fatal("bounded check changed source bytes")
			}
		})
	}
	input := "{% raw %}" + strings.Repeat("{% "+strings.Repeat(" ", 128)+"literal", 4096) + "{%- endraw %}"
	source, _ := Parse("whitespace.j2", []byte(input))
	scan := scanTemplate(source)
	if len(scan.diagnostics) > 0 || len(scan.reasons) > 0 || len(scan.expressions) > 0 {
		t.Fatal("long raw whitespace candidates were interpreted")
	}
}

func TestTemplatePhysicalClassificationPreservesRootAndUnknownOwner(t *testing.T) {
	root := t.TempDir()
	narrow := filepath.Join(root, "roles/demo/templates")
	filename := putFile(t, root, "roles/demo/templates/config.yaml", "---\nv: [1,2]\n")
	putFile(t, root, "roles/demo/defaults/main.yml", "demo_role_value: true\n")
	canonicalNarrow := canonicalTestPath(t, narrow)
	for _, name := range []string{"config.yaml", "extensionless"} {
		if name == "extensionless" {
			putFile(t, root, "roles/demo/templates/extensionless", "{{ value }}")
		}
		p, err := Load(t.Context(), Options{Root: narrow, Paths: []string{filepath.Join(narrow, name)}, IncludeAnalysis: true})
		if err != nil {
			t.Fatal(err)
		}
		if p.Root != canonicalNarrow {
			t.Fatalf("physical template root = %q, want %q", p.Root, canonicalNarrow)
		}
		source := p.Sources[name]
		if source == nil || source.Path != name || source.Kind != Template || source.Role != "" || source.RolePath != "" || len(p.Sources) != 1 {
			t.Fatalf("physical classification invented outside-root context: %+v %+v", source, p)
		}
		if err := RequireWritableSelection(p); err == nil {
			t.Fatal("physical template became writable")
		}
	}
	// A tasks-looking suffix beneath the physical template root also stays raw.
	putFile(t, root, "roles/demo/templates/tasks/main.yml", "{{ value }}")
	if p, err := Load(t.Context(), Options{Root: narrow, Paths: []string{narrow}}); err == nil {
		t.Fatalf("narrow directory selected templates: %+v", p)
	}
	alias := putFile(t, root, "unrelated.yml", "x: true\n")
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filename, alias); err != nil {
		t.Fatal(err)
	}
	canonicalRoot := canonicalTestPath(t, root)
	p, err := Load(t.Context(), Options{Root: root, Paths: []string{alias}})
	if err != nil {
		t.Fatal(err)
	}
	if p.Root != canonicalRoot {
		t.Fatalf("alias template root = %q, want %q", p.Root, canonicalRoot)
	}
	source := p.Sources["unrelated.yml"]
	if source == nil || source.Kind != Template || source.Path != "unrelated.yml" || source.Role != "demo" || source.RolePath != "roles/demo" || p.Sources["roles/demo/defaults/main.yml"] == nil {
		t.Fatal("alias template identity or admitted canonical context lost")
	}
	if err := RequireWritableSelection(p); err == nil {
		t.Fatal("alias template became writable")
	}
	identity, err := ResolveSourceIdentity(root, alias)
	if err != nil || !identity.IsTemplate() || identity.Root != canonicalRoot || identity.Path != "unrelated.yml" {
		t.Fatalf("alias identity: %+v %v", identity, err)
	}
}

func TestTemplateForGrammarExplanation(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"for-valid.j2", "for-partial.j2"} {
		data, err := os.ReadFile("testdata/templates/" + name)
		if err != nil {
			t.Fatal(err)
		}
		filename := putFile(t, root, name, string(data))
		p, err := Load(t.Context(), Options{Root: root, Paths: []string{filename}})
		if err != nil {
			t.Fatal(err)
		}
		ds := Analyze(p, Rules())
		if name == "for-partial.j2" {
			if len(ds) != 1 || ds[0].RuleID != "template-partial-coverage" || ds[0].Fix != nil {
				t.Fatalf("partial coverage finding missing: %+v", ds)
			}
		} else if len(ds) != 0 {
			t.Fatalf("unexpected valid-loop findings: %+v", ds)
		}
		explanation, err := Explain(t.Context(), Options{Root: root, Paths: []string{filename}})
		if err != nil {
			t.Fatal(err)
		}
		state := "static-template"
		if name == "for-partial.j2" {
			state = "partial-template"
			if !slices.ContainsFunc(explanation.Source.CoverageReasons, func(reason string) bool { return strings.Contains(reason, "statement argument grammar") }) {
				t.Fatalf("partial reason missing: %+v", explanation.Source)
			}
		} else if len(explanation.Source.CoverageReasons) != 0 {
			t.Fatalf("valid loop lost coverage: %+v", explanation.Source)
		}
		if explanation.Source.ParseState != state {
			t.Fatalf("coverage=%s want=%s", explanation.Source.ParseState, state)
		}
		after, err := os.ReadFile(filename)
		if err != nil || !bytes.Equal(data, after) {
			t.Fatal("checking or explanation changed template bytes")
		}
	}
}
