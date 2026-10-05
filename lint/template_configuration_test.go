package lint

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestTemplateOwningTaskConfiguration(t *testing.T) {
	for _, tc := range []struct{ name, task, template, reason string }{
		{"variable start", "- template: {src: config.j2, variable_start_string: '[['}\n", "literal {{", "task delimiter overrides"},
		{"variable end", "- template: {src: config.j2, variable_end_string: ']]'}\n", "{{ value ]]", "task delimiter overrides"},
		{"block start", "- template: {src: config.j2, block_start_string: '<%'}\n", "literal {%", "task delimiter overrides"},
		{"block end", "- template: {src: config.j2, block_end_string: '%>'}\n", "{% if value %>", "task delimiter overrides"},
		{"comment start", "- template: {src: config.j2, comment_start_string: '<#'}\n", "literal {#", "task delimiter overrides"},
		{"comment end", "- template: {src: config.j2, comment_end_string: '#>'}\n", "{# comment #>", "task delimiter overrides"},
		{"header with task override", "- template: {src: config.j2, variable_start_string: '[['}\n", "#jinja2:variable_start_string:'{{'\nliteral {{", "task delimiter overrides"},
		{"dynamic delimiter", "- template: {src: config.j2, variable_start_string: '{{ marker }}'}\n", "{{ value }}", "task delimiter overrides"},
		{"conflicting owners", "- template: {src: config.j2}\n- template: {src: config.j2, variable_start_string: '[['}\n", "{{ value }}", "task delimiter overrides"},
		{"dynamic source", "- template: {src: '{{ choice }}.j2'}\n", "{{ value }}", "dynamic template task source"},
		{"invalid context", "broken: [\n", "{{ value }}", "invalid owning task context"},
		{"unknown arguments", "- template: \"src='unfinished\"\n", "{{ value }}", "unknown template task arguments"},
		{"dynamic args override", "- template: {src: config.j2}\n  args: '{{ args }}'\n", "{{ value }}", "unknown template task arguments"},
		{"dynamic argument mapping", "- template: '{{ args }}'\n", "{{ value }}", "dynamic template task source"},
		{"module defaults variable_start_string", "- template: {src: config.j2}\n  module_defaults: {ansible.legacy.template: {variable_start_string: custom}}\n", "literal {{", "module defaults"},
		{"module defaults variable_end_string", "- template: {src: config.j2}\n  module_defaults: {ansible.legacy.template: {variable_end_string: custom}}\n", "literal {{", "module defaults"},
		{"module defaults block_start_string", "- template: {src: config.j2}\n  module_defaults: {ansible.legacy.template: {block_start_string: custom}}\n", "literal {{", "module defaults"},
		{"module defaults block_end_string", "- template: {src: config.j2}\n  module_defaults: {ansible.legacy.template: {block_end_string: custom}}\n", "literal {{", "module defaults"},
		{"module defaults comment_start_string", "- template: {src: config.j2}\n  module_defaults: {ansible.legacy.template: {comment_start_string: custom}}\n", "literal {{", "module defaults"},
		{"module defaults comment_end_string", "- template: {src: config.j2}\n  module_defaults: {ansible.legacy.template: {comment_end_string: custom}}\n", "literal {{", "module defaults"},
		{"sequence module defaults", "- template: {src: config.j2}\n  module_defaults:\n    - template: {variable_start_string: '[['}\n", "literal {{", "module defaults"},
		{"dynamic template defaults", "- template: {src: config.j2}\n  module_defaults: {template: '{{ args }}'}\n", "literal {{", "module defaults"},
		{"rescue inherited defaults", "- module_defaults: {template: {variable_end_string: ']]'}}\n  block: []\n  rescue:\n    - block: []\n      always:\n        - template: {src: config.j2}\n", "literal {{", "module defaults"},
		{"unrelated sibling block defaults", "- module_defaults: {template: {variable_start_string: '[['}}\n  block:\n    - template: {src: other.j2}\n- template: {src: config.j2}\n", "{{ value }}", ""},
		{"task module defaults", "- template: {src: config.j2}\n  module_defaults: {ansible.builtin.template: {variable_start_string: '[['}}\n", "literal {{", "module defaults"},
		{"block module defaults", "- module_defaults: {template: {variable_end_string: ']]'}}\n  block:\n    - template: {src: config.j2}\n", "literal {{", "module defaults"},
		{"dynamic module defaults", "- template: {src: config.j2}\n  module_defaults: '{{ defaults }}'\n", "literal {{", "module defaults"},
		{"unknown default group", "- template: {src: config.j2}\n  module_defaults: {group/custom: {variable_start_string: '[['}}\n", "literal {{", "module defaults"},
		{"unrelated module defaults", "- template: {src: config.j2}\n  module_defaults: {ansible.builtin.copy: {variable_start_string: '[['}}\n", "{{ value }}", ""},
		{"unrelated template defaults", "- template: {src: other.j2}\n  module_defaults: {template: {variable_start_string: '[['}}\n", "{{ value }}", ""},
		{"null defaults", "- template: {src: config.j2}\n  module_defaults: null\n", "{{ value }}", ""},
		{"non delimiter defaults", "- template: {src: config.j2}\n  module_defaults: {template: {mode: '0644'}}\n", "{{ value }}", ""},
		{"default", "- template: {src: config.j2}\n", "{{ value }}", ""},
		{"header", "- template: {src: config.j2}\n", "#jinja2:variable_start_string:'[[',variable_end_string:']]'\n[[ value ]]", ""},
		{"unrelated override", "- template: {src: other.j2, variable_start_string: '[['}\n", "{{ value }}", ""},
		{"payload is not task metadata", "- debug: {msg: {template: {src: config.j2, variable_start_string: '[['}}}\n", "{{ value }}", ""},
		{"task vars are not arguments", "- template: {src: config.j2}\n  vars: {variable_start_string: '[['}\n", "{{ value }}", ""},
		{"explicit default variable start", "- template: {src: config.j2, variable_start_string: '{{'}\n", "{{ value }}", "task delimiter overrides"},
		{"explicit default variable end", "- template: {src: config.j2, variable_end_string: '}}'}\n", "{{ value }}", "task delimiter overrides"},
		{"explicit default block start", "- template: {src: config.j2, block_start_string: '{%'}\n", "{% if value %}text{% endif %}", "task delimiter overrides"},
		{"explicit default block end", "- template: {src: config.j2, block_end_string: '%}'}\n", "{% if value %}text{% endif %}", "task delimiter overrides"},
		{"explicit default comment start", "- template: {src: config.j2, comment_start_string: '{#'}\n", "{# comment #}", "task delimiter overrides"},
		{"explicit default comment end", "- template: {src: config.j2, comment_end_string: '#}'}\n", "{# comment #}", "task delimiter overrides"},
		{"args delimiter", "- ansible.builtin.template: {src: config.j2}\n  args: {variable_start_string: '[['}\n", "literal {{", "task delimiter overrides"},
		{"scalar action delimiter", "- action: template src=config.j2 variable_start_string='[['\n", "literal {{", "task delimiter overrides"},
		{"local action delimiter", "- local_action: {module: template, src: config.j2, block_end_string: '%>'}\n", "{% if value %>", "task delimiter overrides"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			putFile(t, root, "roles/demo/tasks/main.yml", tc.task)
			filename := putFile(t, root, "roles/demo/templates/config.j2", tc.template)
			task := filepath.Join(root, "roles/demo/tasks/main.yml")
			var first templateScan
			for i, paths := range [][]string{{filename}, {task}, {task, filename}, {root, filename}} {
				p, err := Load(t.Context(), Options{Root: root, Paths: paths})
				if err != nil {
					t.Fatal(err)
				}
				source := p.Sources["roles/demo/templates/config.j2"]
				scan := scanTemplate(source)
				if len(scan.diagnostics) != 0 {
					t.Fatalf("invented syntax: %+v", scan.diagnostics)
				}
				if got := strings.Join(scan.reasons, "; "); tc.reason == "" && got != "" || tc.reason != "" && !strings.Contains(got, tc.reason) {
					t.Fatalf("coverage=%q want=%q", got, tc.reason)
				}
				if tc.reason != "" && (len(scan.expressions) != 0 || len(Expressions(source)) != 0 || observedSource(source).ParseState != "partial-template") {
					t.Fatal("unknown configuration produced facts or validated state")
				}
				if i == 0 {
					first = scan
				} else if !reflect.DeepEqual(first.reasons, scan.reasons) || len(first.expressions) != len(scan.expressions) {
					t.Fatal("selection changed configuration admission")
				}
				if string(source.Data) != tc.template {
					t.Fatal("template bytes changed")
				}
			}
			if after, err := os.ReadFile(filename); err != nil || string(after) != tc.template {
				t.Fatalf("template disk bytes changed: %q %v", after, err)
			}
		})
	}
}

func TestTemplateTaskOverridesCannotSelectReferenceContext(t *testing.T) {
	for _, owner := range []string{"tasks", "handlers"} {
		t.Run(owner, func(t *testing.T) {
			root := t.TempDir()
			putFile(t, root, "roles/foreign/defaults/main.yml", "foreign_role_value: present\n")
			putFile(t, root, "roles/demo/"+owner+"/main.yml", "- template: {src: config.j2, variable_start_string: '[['}\n")
			text := "literal {{ lookup('role_var', '_value', role='foreign') }}"
			filename := putFile(t, root, "roles/demo/templates/config.j2", text)
			refs, err := References(t.Context(), Options{Root: root, Paths: []string{filename}})
			if err != nil {
				t.Fatal(err)
			}
			if len(refs.References) != 0 || len(refs.Sources) != 1 || refs.Sources[0].ParseState != "partial-template" || !strings.Contains(strings.Join(refs.Sources[0].CoverageReasons, "; "), "task delimiter overrides") {
				t.Fatalf("literal output produced reference facts: %+v", refs)
			}
			if slices.ContainsFunc(refs.LoadedContext, func(s ObservedSource) bool { return strings.HasPrefix(s.Path, "roles/foreign/") }) {
				t.Fatal("literal output authorized cross-role source reads")
			}
			for _, source := range refs.Dependencies.Sources {
				if slices.ContainsFunc(source.Directories, func(d DependencyDirectory) bool { return strings.Contains(d.Path, "foreign") }) {
					t.Fatal("literal output authorized cross-role context discovery")
				}
			}
		})
	}
}

func TestTemplateTaskConfigurationConsumers(t *testing.T) {
	for _, tc := range []struct{ name, task, reason string }{
		{"direct", "- template: {src: router.yml.j2, variable_start_string: '[[', variable_end_string: ']]'}\n", "task delimiter overrides"},
		{"task defaults", "- template: {src: router.yml.j2}\n  module_defaults: {ansible.builtin.template: {variable_start_string: '[['}}\n", "module defaults"},
		{"block defaults", "- module_defaults: {template: {block_start_string: '<%'}}\n  block:\n    - template: {src: router.yml.j2}\n", "module defaults"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			putFile(t, root, traefikDefaultsPath, traefikFixture(t, "api.good.yml"))
			putFile(t, root, traefikTasksPath, tc.task)
			text := "{{ lookup('role_var', '_traefik_api_endpoint', role='example') }}\n"
			filename := putFile(t, root, traefikTemplatePath, text)
			for _, selection := range [][]string{{traefikTasksPath}, {traefikTemplatePath}, {traefikTasksPath, traefikTemplatePath}} {
				paths := make([]string, len(selection))
				for i, name := range selection {
					paths[i] = filepath.Join(root, name)
				}
				p, err := Load(t.Context(), Options{Root: root, Paths: paths})
				if err != nil {
					t.Fatal(err)
				}
				facts := analyzeTraefikRole(p, p.Sources[traefikTemplatePath])
				if len(facts.renderers) != 1 || len(facts.renderers[0].Unavailable) == 0 || facts.complete {
					t.Fatalf("unknown renderer treated as known: %+v", facts)
				}
				for _, d := range Analyze(p, append(traefikRules("traefik-renderer-contract"), traefikRules("template-syntax")...)) {
					t.Fatalf("unknown configuration proved violation: %+v", d)
				}
			}
			refs, err := References(t.Context(), Options{Root: root, Paths: []string{filename}})
			if err != nil || len(refs.References) != 0 || len(refs.Sources) != 1 || refs.Sources[0].ParseState != "partial-template" {
				t.Fatalf("reference facts=%+v err=%v", refs, err)
			}
			for _, operation := range []string{"definition", "hover", "references"} {
				q, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, Source: []byte(text), Operation: operation, Offset: strings.Index(text, "_traefik_api_endpoint")})
				if err != nil || q.State != "unavailable" || len(q.Declarations) != 0 || len(q.Locations) != 0 || !strings.Contains(strings.Join(q.Coverage.Reasons, "; "), tc.reason) {
					t.Fatalf("query=%+v err=%v", q, err)
				}
			}
			e, err := Explain(t.Context(), Options{Root: root, Paths: []string{filename}})
			if err != nil || e.Source.ParseState != "partial-template" || !strings.Contains(strings.Join(e.Unsupported, "; "), tc.reason) {
				t.Fatalf("explain=%+v err=%v", e, err)
			}
		})
	}
}
