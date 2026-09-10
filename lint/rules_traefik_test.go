package lint

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const traefikDefaultsPath = "roles/example/defaults/main.yml"
const traefikTasksPath = "roles/example/tasks/main.yml"
const traefikTemplatePath = "roles/example/templates/router.yml.j2"

func traefikFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/traefik/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
func traefikRules(id string) []Rule {
	var rules []Rule
	for _, r := range Rules() {
		if r.ID == id || (id == "" && strings.HasPrefix(r.ID, "traefik-")) {
			rules = append(rules, r)
		}
	}
	return rules
}
func traefikProject(files map[string]string) *Project {
	p := &Project{Sources: map[string]*Source{}, Selected: map[string]bool{}}
	for path, text := range files {
		s, _ := Parse(path, []byte(text))
		p.Sources[path] = s
		p.Selected[path] = true
	}
	return p
}
func TestTraefikAPIDeclarations(t *testing.T) {
	good := traefikFixture(t, "api.good.yml")
	cases := []struct {
		name, input string
		want        int
		span        string
	}{
		{"complete even disabled", good, 0, ""},
		{"missing and both legacy names", traefikFixture(t, "api.bad.yml"), 3, "example_role_traefik_enabled"},
		{"legacy without trigger", "example_role_traefik_middleware_api: []\n", 1, "example_role_traefik_middleware_api"},
		{"custom before default", strings.Replace(good, "example_role_traefik_middleware_default_api: default\nexample_role_traefik_middleware_custom_api: custom", "example_role_traefik_middleware_custom_api: custom\nexample_role_traefik_middleware_default_api: default", 1), 1, "example_role_traefik_middleware_custom_api"},
		{"nested is not declaration", "nested:\n  example_role_traefik_enabled: true\n", 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := traefikProject(map[string]string{traefikDefaultsPath: tc.input})
			ds := Analyze(p, traefikRules("traefik-api-contract"))
			if len(ds) != tc.want {
				t.Fatalf("diagnostics=%+v want %d", ds, tc.want)
			}
			if tc.want > 0 {
				assertTraefikDiagnostic(t, p, ds[0], traefikDefaultsPath, tc.span)
			}
		})
	}
}
func assertTraefikDiagnostic(t *testing.T, p *Project, d Diagnostic, path, span string) {
	t.Helper()
	if d.Path != path || d.Expected == "" || d.Fix != nil {
		t.Fatalf("diagnostic=%+v", d)
	}
	if got := string(p.Sources[path].Data[d.Span.Start:d.Span.End]); span != "" && got != span {
		t.Errorf("span=%q want %q", got, span)
	}
}
func TestTraefikAdaptersRequireMatchingIncludeForwarding(t *testing.T) {
	good := traefikFixture(t, "adapter.good.yml")
	defaults := traefikFixture(t, "adapter.defaults.yml")
	cases := []struct {
		name, tasks string
		want        int
	}{
		{"complete", good, 0},
		{"comments cannot forward", traefikFixture(t, "adapter.bad.yml"), 1},
		{"wrong role target", strings.Replace(good, "'_nginx_traefik_api_endpoint', role='example'", "'_nginx_traefik_api_endpoint', role='other'", 1), 1},
		{"wrong suffix", strings.Replace(good, "'_nginx_traefik_api_endpoint'", "'_nginx_traefik_api_enabled'", 1), 1},
		{"arbitrary debug vars", strings.Replace(good, "ansible.builtin.include_role:", "ansible.builtin.debug:", 1), 0},
		{"other included role", strings.Replace(good, "name: nginx", "name: other", 1), 0},
		{"two includes cannot share forwarding", good + traefikFixture(t, "adapter.bad.yml"), 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := traefikProject(map[string]string{traefikDefaultsPath: defaults, traefikTasksPath: tc.tasks})
			ds := Analyze(p, traefikRules("traefik-adapter-contract"))
			if len(ds) != tc.want {
				t.Fatalf("diagnostics=%+v want %d", ds, tc.want)
			}
			if tc.want > 0 {
				assertTraefikDiagnostic(t, p, ds[0], traefikTasksPath, "nginx_role_web_subdomain")
				if len(ds[0].Related) == 0 {
					t.Fatal("missing defaults reference")
				}
			}
		})
	}
}
func TestTraefikAdapterDefaultOwnershipAndSelection(t *testing.T) {
	p := traefikProject(map[string]string{traefikDefaultsPath: "example_role_nginx_web_subdomain: nginx\n", traefikTasksPath: traefikFixture(t, "adapter.bad.yml")})
	full := Analyze(p, traefikRules("traefik-adapter-contract"))
	if len(full) != 2 {
		t.Fatalf("diagnostics=%+v", full)
	}
	for _, selected := range []string{traefikDefaultsPath, traefikTasksPath} {
		p.Selected = map[string]bool{selected: true}
		ds := Analyze(p, traefikRules("traefik-adapter-contract"))
		want := slices.DeleteFunc(slices.Clone(full), func(d Diagnostic) bool { return d.Path != selected })
		if !slices.EqualFunc(ds, want, func(a, b Diagnostic) bool { return a.Path == b.Path && a.Message == b.Message && a.Span == b.Span }) || len(ds) != 1 || len(ds[0].Related) == 0 {
			t.Fatalf("selected=%s got=%+v want=%+v", selected, ds, want)
		}
	}
}
func TestTraefikRenderersNeedLiveOutputConsumption(t *testing.T) {
	defaults := traefikFixture(t, "api.good.yml")
	good := traefikFixture(t, "renderer.good.j2")
	templateTask := "- template: {src: router.yml.j2, dest: /traefik/router.yml}\n"
	cases := []struct {
		name, tasks, template string
		want                  int
		primary               string
	}{
		{"template renderer", templateTask, good, 0, ""},
		{"missing template contract", templateTask, traefikFixture(t, "renderer.bad.j2"), 1, traefikTasksPath},
		{"wrong lookup target", templateTask, strings.ReplaceAll(good, "role='example'", "role='other'"), 1, traefikTasksPath},
		{"unreferenced template cannot render", "- debug: {msg: ok}\n", good, 1, traefikDefaultsPath},
		{"incidental helper text", "- debug: {msg: 'create_docker_container.yml deprecated docker_labels_common'}\n", "", 1, traefikDefaultsPath},
		{"actual Docker helper", "- include_tasks: '{{ resources_tasks_path }}/docker/create_docker_container.yml'\n", "", 0, ""},
		{"Docker Compose renderer", templateTask, "labels:\n{% for key, value in docker_labels_common | dictsort %}\n  {{ key }}: {{ value }}\n{% endfor %}\n", 0, ""},
		{"Docker labels literal", templateTask, "labels: docker_labels_common\n", 1, traefikTasksPath},
		{"retired role fail", "- fail: {msg: \"The 'example' role is deprecated in favor of another role.\"}\n  when: not continuous_integration\n", "", 0, ""},
		{"deprecation comment", "# deprecated\n- debug: {msg: ok}\n", "", 1, traefikDefaultsPath},
		{"direct container labels", "- community.docker.docker_container:\n    name: example\n    labels: '{{ docker_labels_common }}'\n", "", 0, ""},
		{"debug cannot consume", "- debug:\n    msg: \"{{ traefik_middleware_api }} {{ lookup('role_var', '_traefik_api_enabled', role='example') }} {{ lookup('role_var', '_traefik_api_endpoint', role='example') }}\"\n", "", 1, traefikDefaultsPath},
		{"copy inline renderer", "- copy:\n    dest: /traefik/router.yml\n    content: |\n" + indentFixture(good, "      "), "", 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string]string{traefikDefaultsPath: defaults, traefikTasksPath: tc.tasks}
			if tc.template != "" {
				files[traefikTemplatePath] = tc.template
			}
			p := traefikProject(files)
			ds := Analyze(p, traefikRules("traefik-renderer-contract"))
			if len(ds) != tc.want {
				t.Fatalf("diagnostics=%+v want %d", ds, tc.want)
			}
			if tc.want > 0 {
				assertTraefikDiagnostic(t, p, ds[0], tc.primary, "")
				if tc.primary != traefikDefaultsPath && len(ds[0].Related) == 0 {
					t.Fatal("missing declaration reference")
				}
			}
		})
	}
}
func indentFixture(text, prefix string) string {
	return prefix + strings.ReplaceAll(strings.TrimSuffix(text, "\n"), "\n", "\n"+prefix) + "\n"
}
func TestTraefikMalformedRequiredContextAndLoaderSelection(t *testing.T) {
	for _, broken := range []string{traefikTasksPath, traefikDefaultsPath} {
		t.Run(broken, func(t *testing.T) {
			files := map[string]string{traefikDefaultsPath: traefikFixture(t, "adapter.defaults.yml"), traefikTasksPath: traefikFixture(t, "adapter.good.yml")}
			selected := traefikTasksPath
			if broken == traefikTasksPath {
				selected = traefikDefaultsPath
			}
			files[broken] = "broken: [\n"
			p := traefikProject(files)
			p.Selected = map[string]bool{selected: true}
			ds := Analyze(p, traefikRules("traefik-adapter-contract"))
			if len(ds) != 1 || ds[0].Path != selected || len(ds[0].Related) == 0 || !strings.Contains(ds[0].Message, "invalid") {
				t.Fatalf("diagnostics=%+v", ds)
			}
		})
	}
	root := t.TempDir()
	for path, text := range map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: "- template: {src: router.yml.j2, dest: /router.yml}\n", traefikTemplatePath: traefikFixture(t, "renderer.bad.j2")} {
		file := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	for _, selected := range []string{traefikDefaultsPath, traefikTasksPath} {
		p, err := Load(context.Background(), Options{Root: root, Paths: []string{filepath.Join(root, selected)}})
		if err != nil {
			t.Fatal(err)
		}
		ds := Analyze(p, traefikRules("traefik-renderer-contract"))
		want := 0
		if selected == traefikTasksPath {
			want = 1
		}
		if len(ds) != want {
			t.Fatalf("selected=%s diagnostics=%+v", selected, ds)
		}
	}
}

func TestTraefikForwardingMustBeTheAssignedValue(t *testing.T) {
	good := traefikFixture(t, "adapter.good.yml")
	for _, replacement := range []string{
		"false if lookup('role_var', '_nginx_traefik_api_endpoint', role='example') else false",
		"{'ignored': lookup('role_var', '_nginx_traefik_api_endpoint', role='example')}",
		"'lookup( role_var _nginx_traefik_api_endpoint example )'",
	} {
		tasks := strings.Replace(good, "lookup('role_var', '_nginx_traefik_api_endpoint', role='example')", replacement, 1)
		p := traefikProject(map[string]string{traefikDefaultsPath: traefikFixture(t, "adapter.defaults.yml"), traefikTasksPath: tasks})
		ds := Analyze(p, traefikRules("traefik-adapter-contract"))
		if len(ds) != 1 || !strings.Contains(ds[0].Expected, "nginx_role_traefik_api_endpoint") {
			t.Errorf("replacement=%s diagnostics=%+v", replacement, ds)
		}
	}
}
func TestTraefikRendererCannotUseCommentsOrUnrelatedRetirement(t *testing.T) {
	good := traefikFixture(t, "renderer.good.j2")
	cases := []struct{ name, tasks, template string }{
		{"commented template expressions", "- template: {src: router.yml.j2, dest: /router.yml}\n", indentFixture(good, "# ")},
		{"API literal strings", "- template: {src: router.yml.j2, dest: /router.yml}\n", "{{ 'traefik_middleware_api' }} {{ '_traefik_api_enabled' }} {{ '_traefik_api_endpoint' }}\n"},
		{"unrelated conditional fail", "- fail: {msg: \"The 'example' role is deprecated in favor of another role.\"}\n  when: old_version\n", ""},
		{"installation plus retirement warning", "- fail: {msg: \"The 'example' role is deprecated in favor of another role.\"}\n  when: not continuous_integration\n- command: install-example\n", ""},
		{"wrong role retirement", "- fail: {msg: \"The 'other' role is deprecated in favor of another role.\"}\n", ""},
		{"missing referenced template", "- template: {src: router.yml.j2, dest: /router.yml}\n", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: tc.tasks}
			if tc.template != "" {
				files[traefikTemplatePath] = tc.template
			}
			p := traefikProject(files)
			ds := Analyze(p, traefikRules("traefik-renderer-contract"))
			if len(ds) != 1 {
				t.Fatalf("diagnostics=%+v", ds)
			}
			if tc.name == "missing referenced template" && ds[0].Path != traefikTasksPath {
				t.Errorf("missing template must report on referencing task: %+v", ds)
			}
		})
	}
}
func TestTraefikMalformedUnrelatedContextDoesNotBlockAdapters(t *testing.T) {
	p := traefikProject(map[string]string{traefikDefaultsPath: "example_role_web_subdomain: example\n", traefikTasksPath: "broken: [\n"})
	p.Selected = map[string]bool{traefikDefaultsPath: true}
	if ds := Analyze(p, traefikRules("traefik-adapter-contract")); len(ds) != 0 {
		t.Fatalf("unrelated malformed task implies no known adapter: %+v", ds)
	}
}
func TestTraefikRetiredMigrationAndDirectCopyContract(t *testing.T) {
	migration := "- include_tasks: migration.yml\n  when: (not continuous_integration) and ('example-migration' in ansible_run_tags)\n- fail:\n    msg: \"The 'example' role is deprecated in favor of a replacement role.\"\n  when: (not continuous_integration) and ('example-migration' not in ansible_run_tags)\n"
	direct := "- copy:\n    content: |\n      {% if example_role_traefik_api_enabled %}\n      {{ traefik_middleware_api }} {{ example_role_traefik_api_endpoint }}\n      {% endif %}\n    dest: /traefik/router.yml\n"
	for _, tasks := range []string{migration, direct} {
		p := traefikProject(map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: tasks})
		if ds := Analyze(p, traefikRules("traefik-renderer-contract")); len(ds) != 0 {
			t.Fatalf("diagnostics=%+v", ds)
		}
	}
}

func TestTraefikMissingAdapterNamespaceUsesExistingDefaults(t *testing.T) {
	for _, hasDefaults := range []bool{false, true} {
		files := map[string]string{traefikTasksPath: traefikFixture(t, "adapter.good.yml")}
		primary := traefikTasksPath
		if hasDefaults {
			files[traefikDefaultsPath] = "example_role_enabled: true\n"
			primary = traefikDefaultsPath
		}
		p := traefikProject(files)
		ds := Analyze(p, traefikRules("traefik-adapter-contract"))
		if len(ds) != 1 || ds[0].Path != primary || !strings.Contains(ds[0].Expected, "example_role_nginx_web_subdomain") {
			t.Fatalf("hasDefaults=%v diagnostics=%+v", hasDefaults, ds)
		}
		for selected := range p.Sources {
			p.Selected = map[string]bool{selected: true}
			actual := Analyze(p, traefikRules("traefik-adapter-contract"))
			want := 0
			if selected == primary {
				want = 1
			}
			if len(actual) != want {
				t.Fatalf("selection=%s diagnostics=%+v", selected, actual)
			}
		}
	}
}
func TestTraefikEachAdapterSuffixIsRequired(t *testing.T) {
	for _, suffix := range []string{"traefik_sso_middleware", "traefik_middleware_default", "traefik_middleware_custom", "traefik_middleware_default_api", "traefik_middleware_custom_api", "traefik_certresolver", "traefik_enabled", "traefik_api_enabled", "traefik_api_endpoint"} {
		t.Run(suffix, func(t *testing.T) {
			defaults := traefikFixture(t, "adapter.defaults.yml")
			tasks := traefikFixture(t, "adapter.good.yml")
			removeLine := func(input, prefix string) string {
				var b strings.Builder
				for line := range strings.SplitSeq(input, "\n") {
					if line != "" && !strings.HasPrefix(strings.TrimSpace(line), prefix) {
						b.WriteString(line + "\n")
					}
				}
				return b.String()
			}
			files := map[string]string{traefikDefaultsPath: removeLine(defaults, "example_role_nginx_"+suffix+":"), traefikTasksPath: removeLine(tasks, "nginx_role_"+suffix+":")}
			p := traefikProject(files)
			ds := Analyze(p, traefikRules("traefik-adapter-contract"))
			if len(ds) != 2 {
				t.Fatalf("diagnostics=%+v", ds)
			}
			for _, d := range ds {
				if !strings.Contains(d.Expected, suffix) {
					t.Errorf("missing suffix hint: %+v", d)
				}
			}
		})
	}
}
func TestTraefikRendererMalformedContextReportsOnDependentOutput(t *testing.T) {
	for _, broken := range []string{traefikDefaultsPath, "roles/example/tasks/broken.yml"} {
		files := map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: "- template: {src: router.yml.j2, dest: /router.yml}\n", traefikTemplatePath: traefikFixture(t, "renderer.bad.j2"), broken: "broken: [\n"}
		p := traefikProject(files)
		p.Selected = map[string]bool{traefikTasksPath: true}
		ds := Analyze(p, traefikRules("traefik-renderer-contract"))
		if len(ds) != 1 || ds[0].Path != traefikTasksPath || !strings.Contains(ds[0].Message, "invalid") || len(ds[0].Related) == 0 {
			t.Fatalf("broken=%s diagnostics=%+v", broken, ds)
		}
	}
}

func TestTraefikMalformedTemplateCannotProveConsumption(t *testing.T) {
	template := traefikFixture(t, "renderer.good.j2") + "{{ broken(\n"
	p := traefikProject(map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: "- template: {src: router.yml.j2, dest: /router.yml}\n", traefikTemplatePath: template})
	p.Selected = map[string]bool{traefikTasksPath: true}
	ds := Analyze(p, traefikRules("traefik-renderer-contract"))
	if len(ds) != 1 || !strings.Contains(ds[0].Message, "invalid") || len(ds[0].Related) == 0 {
		t.Fatalf("diagnostics=%+v", ds)
	}
}
func TestTraefikAPIRequiresEachDeclarationAndRelatedOrder(t *testing.T) {
	good := traefikFixture(t, "api.good.yml")
	for _, name := range []string{"example_role_traefik_middleware_default_api", "example_role_traefik_middleware_custom_api", "example_role_traefik_api_enabled", "example_role_traefik_api_endpoint"} {
		var input strings.Builder
		for line := range strings.SplitSeq(good, "\n") {
			if line != "" && !strings.HasPrefix(line, name+":") {
				input.WriteString(line + "\n")
			}
		}
		ds := Analyze(traefikProject(map[string]string{traefikDefaultsPath: input.String()}), traefikRules("traefik-api-contract"))
		if len(ds) != 1 || !strings.Contains(ds[0].Expected, name) {
			t.Fatalf("missing=%s diagnostics=%+v", name, ds)
		}
	}
}
func TestTraefikNormalizedIncludesAndNestedRoleIdentity(t *testing.T) {
	for _, action := range []string{"ansible.builtin.include_role:\n    name: nginx", "action:\n    module: ansible.builtin.include_role\n    name: nginx", "action: ansible.builtin.include_role\n  args:\n    name: nginx"} {
		tasks := strings.Replace(traefikFixture(t, "adapter.good.yml"), "ansible.builtin.include_role:\n    name: nginx", action, 1)
		p := traefikProject(map[string]string{"resources/roles/example/defaults/extra/main.yaml": traefikFixture(t, "adapter.defaults.yml"), "resources/roles/example/tasks/extra/main.yaml": tasks})
		if ds := Analyze(p, traefikRules("traefik-adapter-contract")); len(ds) != 0 {
			t.Fatalf("action=%s diagnostics=%+v", action, ds)
		}
	}
}

func TestTraefikRendererOwnConditionCanGuardAPIOutput(t *testing.T) {
	content := "- copy:\n    dest: /traefik/router.yml\n    content: \"{{ traefik_middleware_api }} {{ example_role_traefik_api_endpoint }}\"\n"
	for _, tc := range []struct {
		condition string
		want      int
	}{
		{"  when: lookup('role_var', '_traefik_api_enabled', role='example')\n", 0},
		{"  when: lookup('role_var', '_traefik_api_enabled', role='other')\n", 1},
		{"- debug: {msg: ok}\n  when: example_role_traefik_api_enabled\n", 1},
	} {
		p := traefikProject(map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: content + tc.condition})
		if ds := Analyze(p, traefikRules("traefik-renderer-contract")); len(ds) != tc.want {
			t.Fatalf("condition=%s diagnostics=%+v", tc.condition, ds)
		}
	}
}

func TestTraefikRetirementKeepsConditionalGrouping(t *testing.T) {
	tasks := "- include_tasks: migration.yml\n  when: (not continuous_integration) and ('example-migration' in ansible_run_tags)\n- fail:\n    msg: \"The 'example' role is deprecated in favor of a replacement role.\"\n  when: not (continuous_integration and ('example-migration' not in ansible_run_tags))\n"
	p := traefikProject(map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: tasks})
	if ds := Analyze(p, traefikRules("traefik-renderer-contract")); len(ds) != 1 {
		t.Fatalf("unrelated fail condition proves no retirement path: %+v", ds)
	}
}

func TestTraefikDockerLabelsRequireActualOutput(t *testing.T) {
	compose := "services:\n  example:\n    labels:\n{% for key, value in docker_labels_common | dictsort %}\n      {{ key }}: {{ value | string | to_json }}\n{% endfor %}\n"
	cases := []struct {
		name, output string
		want         int
	}{
		{"compose labels", compose, 0},
		{"discarded assignment", "{% set ignored = docker_labels_common %}\n", 1},
		{"captured labels loop", "{% set ignored %}\n" + compose + "{% endset %}\n", 1},
		{"scalar count", "label_count: {{ docker_labels_common | length }}\n", 1},
		{"empty labels loop", "labels:\n{% for key, value in docker_labels_common | dictsort %}\n{% endfor %}\n", 1},
		{"unrelated mapping", strings.Replace(compose, "    labels:", "    environment:", 1), 1},
		{"overwritten key binding", strings.ReplaceAll(compose, "key", "value"), 1},
		{"discarded loop value", strings.Replace(compose, "{{ value | string | to_json }}", "{{ value | length }}", 1), 1},
	}
	for _, tc := range cases {
		for _, kind := range []string{"template", "copy"} {
			t.Run(tc.name+"/"+kind, func(t *testing.T) {
				files := map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml")}
				if kind == "template" {
					files[traefikTasksPath] = "- template: {src: router.yml.j2, dest: /docker-compose.yml}\n"
					files[traefikTemplatePath] = tc.output
				} else {
					files[traefikTasksPath] = "- copy:\n    dest: /docker-compose.yml\n    content: |\n" + indentFixture(tc.output, "      ")
				}
				p := traefikProject(files)
				ds := Analyze(p, traefikRules("traefik-renderer-contract"))
				if len(ds) != tc.want {
					t.Fatalf("diagnostics=%+v want %d", ds, tc.want)
				}
			})
		}
	}
	for _, action := range []string{"community.docker.docker_container:\n    labels: '{{ docker_labels_common }}'", "action:\n    module: community.docker.docker_container\n    labels: '{{ docker_labels_common }}'", "action: community.docker.docker_container\n  args:\n    labels: '{{ docker_labels_common }}'"} {
		p := traefikProject(map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: "- " + action + "\n"})
		if ds := Analyze(p, traefikRules("traefik-renderer-contract")); len(ds) != 0 {
			t.Fatalf("normalized direct-container diagnostics=%+v", ds)
		}
	}
	for _, labels := range []string{"'{{ docker_labels_common | length }}'", "{count: '{{ docker_labels_common | length }}'}"} {
		p := traefikProject(map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: "- community.docker.docker_container:\n    labels: " + labels + "\n"})
		if ds := Analyze(p, traefikRules("traefik-renderer-contract")); len(ds) != 1 {
			t.Fatalf("discarded container labels diagnostics=%+v", ds)
		}
	}
}

func TestTraefikRetirementRejectsExecutionModifiers(t *testing.T) {
	base := "- fail:\n    msg: \"The 'example' role is deprecated in favor of another role.\"\n"
	for _, modifier := range []string{
		"failed_when: false", "ignore_errors: true", "ignore_errors: false",
		"loop: []", "with_items: []", "loop_with: items", "run_once: true",
		"until: false", "retries: 0", "tags: never", "check_mode: true",
		"delegate_to: another_host", "vars: {continuous_integration: true}",
	} {
		for _, guard := range []string{"", "  when: not continuous_integration\n"} {
			t.Run(modifier+guard, func(t *testing.T) {
				p := traefikProject(map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: base + "  " + modifier + "\n" + guard})
				ds := Analyze(p, traefikRules("traefik-renderer-contract"))
				if len(ds) != 1 {
					t.Fatalf("modified fail cannot establish retirement: %+v", ds)
				}
			})
		}
	}
	for _, action := range []string{"ansible.builtin.fail:\n    msg: \"The 'example' role is deprecated in favor of another role.\"", "action:\n    module: ansible.builtin.fail\n    msg: \"The 'example' role is deprecated in favor of another role.\"", "action: ansible.builtin.fail\n  args:\n    msg: \"The 'example' role is deprecated in favor of another role.\""} {
		p := traefikProject(map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: "- " + action + "\n"})
		if ds := Analyze(p, traefikRules("traefik-renderer-contract")); len(ds) != 0 {
			t.Fatalf("normalized simple fail diagnostics=%+v", ds)
		}
	}
	migration := "- include_tasks: migration.yml\n  when: (not continuous_integration) and ('example-migration' in ansible_run_tags)\n" + base + "  when: (not continuous_integration) and ('example-migration' not in ansible_run_tags)\n  failed_when: false\n"
	p := traefikProject(map[string]string{traefikDefaultsPath: traefikFixture(t, "api.good.yml"), traefikTasksPath: migration})
	if ds := Analyze(p, traefikRules("traefik-renderer-contract")); len(ds) != 1 {
		t.Fatalf("suppressed migration retirement diagnostics=%+v", ds)
	}
}
