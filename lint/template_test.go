package lint

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestTemplateScanner(t *testing.T) {
	cases := []struct{ name, input, errorText, partial string }{
		{"literal layout", " \t  literal }} %} #}\r\n\r\n  no final newline", "", ""},
		{"nested branches", "{% if a %}{% for item in items %}{{ item }}{% else %}empty{% endfor %}{% elif b %}b{% else %}c{% endif %}", "", ""},
		{"quoted delimiters", `{{ '}} {{ {% #}' }}{% if value == '%}' %}yes{% endif %}`, "", ""},
		{"comments", "{# {{ {% unmatched \" #}\n{{ value }}", "", ""},
		{"raw", "{% raw -%}{{ {# {% nonsense %}\n{% if \" {{\n{%- endraw %}{{ value }}", "", ""},
		{"trim", "{%- if a +%}\t{{- value -}}{#- ignore -#}{%+ endif -%}", "", ""},
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
	}{{"valid.j2", false, false}, {"invalid.j2", true, false}, {"partial.j2", false, true}, {"custom.j2", false, false}} {
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
