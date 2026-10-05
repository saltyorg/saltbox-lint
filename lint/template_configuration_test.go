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
		{"legacy mapping", "- ansible.legacy.template: {src: config.j2, variable_start_string: '[['}\n", "literal {{", "task delimiter overrides"},
		{"legacy scalar arguments", "- ansible.legacy.template: src=config.j2 variable_start_string='[['\n", "literal {{", "task delimiter overrides"},
		{"legacy action mapping", "- action: {module: ansible.legacy.template, src: config.j2, variable_start_string: '[['}\n", "literal {{", "task delimiter overrides"},
		{"legacy action scalar", "- action: ansible.legacy.template src=config.j2 variable_start_string='[['\n", "literal {{", "task delimiter overrides"},
		{"legacy local action mapping", "- local_action: {module: ansible.legacy.template, args: {src: config.j2, variable_start_string: '[['}}\n", "literal {{", "task delimiter overrides"},
		{"legacy local action scalar", "- local_action: ansible.legacy.template src=config.j2 variable_start_string='[['\n", "literal {{", "task delimiter overrides"},
		{"legacy outer args", "- ansible.legacy.template: {src: config.j2}\n  args: {variable_start_string: '[['}\n", "literal {{", "task delimiter overrides"},
		{"legacy defaults", "- ansible.legacy.template: {src: config.j2}\n  module_defaults: {ansible.legacy.template: {variable_start_string: '[['}}\n", "literal {{", "module defaults"},
		{"legacy inherited defaults", "- module_defaults: {ansible.builtin.template: {variable_start_string: '[['}}\n  block: []\n  rescue:\n    - block: []\n      always:\n        - local_action: ansible.legacy.template src=config.j2\n", "literal {{", "module defaults"},
		{"legacy unrelated source", "- ansible.legacy.template: {src: other.j2, variable_start_string: '[['}\n", "{{ value }}", ""},
		{"legacy unrelated module", "- ansible.legacy.copy: {src: config.j2, variable_start_string: '[['}\n", "{{ value }}", ""},
		{"legacy ordinary grammar", "- ansible.legacy.template: {src: config.j2}\n", "{{ value }}", ""},
		{"legacy header grammar", "- ansible.legacy.template: {src: config.j2}\n", "#jinja2:variable_start_string:'[[',variable_end_string:']]'\n[[ value ]]", ""},
		{"unsafe source", "- template: {src: !unsafe config.j2}\n", "literal {{", "dynamic template task source"},
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

func TestTemplateSourceSpellingAdmission(t *testing.T) {
	for _, tc := range []struct {
		name, source, reason string
		alias                bool
	}{
		{"absolute owner", "absolute", "source resolution", false},
		{"home expansion", "~/config.j2", "source resolution", false},
		{"dot spelling", "./config.j2", "source resolution", false},
		{"template directory prefix", "templates/config.j2", "source resolution", false},
		{"repeated slash", "nested//config.j2", "source resolution", false},
		{"in role traversal", "../templates/config.j2", "source resolution", false},
		{"root escape", "../../../../outside.j2", "source resolution", false},
		{"alias owner", "alias.j2", "task delimiter overrides", true},
		{"nested alias owner", "aliases/config.j2", "task delimiter overrides", true},
		{"unrelated source", "other.j2", "", false},
		{"dynamic source", "{{ choice }}.j2", "dynamic template task source", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			text := "literal {{ lookup('role_var', '_value', role='foreign') }}\n[[ value ]]"
			if tc.reason == "" {
				text = "{{ value }}"
			}
			filename := putFile(t, root, "roles/demo/templates/config.j2", text)
			src := tc.source
			if src == "absolute" {
				src = filepath.ToSlash(filename)
			}
			if tc.alias {
				alias := filepath.Join(root, "roles/demo/templates", filepath.FromSlash(src))
				if err := os.MkdirAll(filepath.Dir(alias), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filename, alias); err != nil {
					t.Fatal(err)
				}
			}
			putFile(t, root, "roles/foreign/defaults/main.yml", "foreign_role_value: present\n")
			task := putFile(t, root, "roles/demo/tasks/main.yml", "- ansible.builtin.template:\n    src: '"+src+"'\n    variable_start_string: '[[ '\n")
			for _, paths := range [][]string{{filename}, {task}, {task, filename}, {root, filename}} {
				p, err := Load(t.Context(), Options{Root: root, Paths: paths})
				if err != nil {
					t.Fatal(err)
				}
				s := p.Sources["roles/demo/templates/config.j2"]
				scan := scanTemplate(s)
				if got := strings.Join(scan.reasons, "; "); tc.reason != "" && !strings.Contains(got, tc.reason) || tc.reason == "" && got != "" {
					t.Fatalf("coverage=%q want=%q", got, tc.reason)
				}
				if len(scan.diagnostics) != 0 || tc.reason != "" && (len(Expressions(s)) != 0 || !scan.configurationUnavailable) {
					t.Fatalf("unsupported ownership produced grammar facts: %+v", scan)
				}
			}
			if tc.reason != "" {
				refs, err := References(t.Context(), Options{Root: root, Paths: []string{filename}})
				if err != nil || len(refs.References) != 0 || len(refs.Sources) != 1 || refs.Sources[0].ParseState != "partial-template" || slices.ContainsFunc(refs.LoadedContext, func(s ObservedSource) bool { return strings.HasPrefix(s.Path, "roles/foreign/") }) {
					t.Fatalf("unsupported ownership authorized reference context: %+v %v", refs, err)
				}
				for _, source := range refs.Dependencies.Sources {
					if slices.ContainsFunc(source.Directories, func(d DependencyDirectory) bool { return strings.Contains(d.Path, "foreign") }) {
						t.Fatal("unsupported ownership authorized cross-role directory discovery")
					}
				}
				for _, operation := range []string{"definition", "hover", "references"} {
					q, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, Source: []byte(text), Operation: operation, Offset: strings.Index(text, "_value")})
					if err != nil || q.State != "unavailable" || len(q.Declarations) != 0 || len(q.Locations) != 0 || !strings.Contains(strings.Join(q.Coverage.Reasons, "; "), tc.reason) {
						t.Fatalf("unsupported ownership produced query answer: %+v %v", q, err)
					}
				}
				e, err := Explain(t.Context(), Options{Root: root, Paths: []string{filename}})
				if err != nil || e.Source.ParseState != "partial-template" || !strings.Contains(strings.Join(e.Unsupported, "; "), tc.reason) {
					t.Fatalf("unsupported ownership presented validated explanation: %+v %v", e, err)
				}
			}
			if after, err := os.ReadFile(filename); err != nil || string(after) != text {
				t.Fatalf("template bytes changed: %q %v", after, err)
			}
		})
	}
}

func TestTemplateAliasWithoutOverridesKeepsGrammar(t *testing.T) {
	root := t.TempDir()
	text := "#jinja2:variable_start_string:'[[',variable_end_string:']]'\n[[ value ]]"
	filename := putFile(t, root, "roles/demo/templates/config.j2", text)
	alias := filepath.Join(filepath.Dir(filename), "alias.j2")
	if err := os.Symlink(filename, alias); err != nil {
		t.Fatal(err)
	}
	putFile(t, root, "roles/demo/tasks/main.yml", "- ansible.legacy.template: {src: alias.j2}\n")
	for _, selected := range []string{filename, alias} {
		p, err := Load(t.Context(), Options{Root: root, Paths: []string{selected}})
		if err != nil {
			t.Fatal(err)
		}
		for name := range p.Selected {
			scan := scanTemplate(p.Sources[name])
			if len(scan.diagnostics) != 0 || len(scan.reasons) != 0 || len(scan.expressions) != 1 {
				t.Fatalf("ordinary alias lost header grammar: %+v", scan)
			}
		}
	}
}

func TestTemplateTaskSourceAliasBoundaries(t *testing.T) {
	root := t.TempDir()
	filename := putFile(t, root, "roles/demo/templates/config.j2", "{{ value }}")
	other := putFile(t, root, "roles/demo/templates/other.j2", "{{ value }}")
	foreign := putFile(t, root, "roles/foreign/templates/config.j2", "{{ value }}")
	escaped := putFile(t, t.TempDir(), "config.j2", "{{ value }}")
	owner, _ := Parse("roles/demo/tasks/main.yml", []byte("- template: {src: config.j2}\n"))
	selected, _ := Parse("roles/demo/templates/config.j2", []byte("{{ value }}"))
	// This helper consumes the canonical root established by Load.
	p := &Project{Root: canonicalTestPath(t, root)}
	for _, tc := range []struct {
		name, target  string
		owns, partial bool
	}{
		{"alias.j2", filename, true, false},
		{"unrelated.j2", other, false, false},
		{"foreign.j2", foreign, false, true},
		{"escaped.j2", escaped, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			alias := filepath.Join(filepath.Dir(filename), tc.name)
			if err := os.Symlink(tc.target, alias); err != nil {
				t.Fatal(err)
			}
			owns, reason := templateTaskOwnsSource(p, owner, selected, tc.name)
			if owns != tc.owns || (reason != "") != tc.partial {
				t.Fatalf("owns=%v reason=%q want owns=%v partial=%v", owns, reason, tc.owns, tc.partial)
			}
			if tc.owns {
				selectedAlias, _ := Parse("roles/demo/templates/"+tc.name, selected.Data)
				owns, reason = templateTaskOwnsSource(p, owner, selectedAlias, "config.j2")
				if !owns || reason != "" {
					t.Fatalf("selected alias lost canonical ownership: %v %q", owns, reason)
				}
			}
		})
	}
}

func TestTemplateTaskOverridesCannotSelectReferenceContext(t *testing.T) {
	for _, owner := range []string{"tasks", "handlers"} {
		for _, action := range []string{"template", "ansible.legacy.template"} {
			t.Run(owner+"/"+action, func(t *testing.T) {
				root := t.TempDir()
				putFile(t, root, "roles/foreign/defaults/main.yml", "foreign_role_value: present\n")
				putFile(t, root, "roles/demo/"+owner+"/main.yml", "- "+action+": {src: config.j2, variable_start_string: '[['}\n")
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
}

func TestTemplateTaskConfigurationConsumers(t *testing.T) {
	for _, tc := range []struct {
		name, task, reason string
		renderers          int
	}{
		{"direct", "- template: {src: router.yml.j2, variable_start_string: '[[', variable_end_string: ']]'}\n", "task delimiter overrides", 1},
		{"task defaults", "- template: {src: router.yml.j2}\n  module_defaults: {ansible.builtin.template: {variable_start_string: '[['}}\n", "module defaults", 1},
		{"block defaults", "- module_defaults: {template: {block_start_string: '<%'}}\n  block:\n    - template: {src: router.yml.j2}\n", "module defaults", 1},
		{"legacy direct", "- ansible.legacy.template: {src: router.yml.j2, variable_start_string: '[['}\n", "task delimiter overrides", 0},
		{"legacy defaults", "- ansible.legacy.template: {src: router.yml.j2}\n  module_defaults: {ansible.builtin.template: {variable_start_string: '[['}}\n", "module defaults", 0},
		{"absolute source", "- template: {src: '$SOURCE', variable_start_string: '[['}\n", "source resolution", 1},
		{"dot source", "- template: {src: ./router.yml.j2, variable_start_string: '[['}\n", "source resolution", 1},
		{"prefixed source", "- template: {src: templates/router.yml.j2, variable_start_string: '[['}\n", "source resolution", 1},
		{"alias source", "- template: {src: alias.j2, variable_start_string: '[['}\n", "task delimiter overrides", 1},
		{"alias defaults", "- template: {src: alias.j2}\n  module_defaults: {ansible.legacy.template: {variable_start_string: '[['}}\n", "module defaults", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			putFile(t, root, traefikDefaultsPath, traefikFixture(t, "api.good.yml"))
			text := "{{ lookup('role_var', '_traefik_api_endpoint', role='example') }}\n"
			filename := putFile(t, root, traefikTemplatePath, text)
			putFile(t, root, traefikTasksPath, strings.ReplaceAll(tc.task, "$SOURCE", filepath.ToSlash(filename)))
			if strings.HasPrefix(tc.name, "alias") {
				if err := os.Symlink(filename, filepath.Join(filepath.Dir(filename), "alias.j2")); err != nil {
					t.Fatal(err)
				}
			}
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
				if len(facts.renderers) != tc.renderers || tc.renderers > 0 && len(facts.renderers[0].Unavailable) == 0 || facts.complete {
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
