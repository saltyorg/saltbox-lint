package lint

import (
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
)

// A checker may retain its evaluation view; it must not install invocation
// state on the caller or carry that state into another Analyze call.
func TestAnalyzeOwnsEvaluationProject(t *testing.T) {
	p := traefikProject(map[string]string{"input.yml": "value: true\n"})
	p.Name = "caller"
	var views []*Project
	rule := Rule{Check: func(view *Project, _ *Source) []Diagnostic {
		if view == p {
			t.Error("Analyze passed the caller Project to a checker")
		}
		views = append(views, view)
		view.Name = "evaluation"
		return nil
	}}
	Analyze(p, []Rule{rule})
	Analyze(p, []Rule{rule})
	if p.Name != "caller" || p.analysis != nil || views[0] == views[1] || views[0].analysis == views[1].analysis {
		t.Fatal("evaluation state escaped its invocation")
	}
}

func TestAnalyzeSharedFactsSelectionAndDirectChecks(t *testing.T) {
	for _, fixture := range []struct {
		name  string
		files map[string]string
		rules []Rule
		want  int
	}{
		{"distinct roles", map[string]string{
			traefikDefaultsPath:             "example_role_traefik_enabled: true\n",
			traefikTasksPath:                "- copy:\n    content: '{{ unrelated }}'\n",
			"roles/other/defaults/main.yml": "other_role_traefik_enabled: true\n",
			"roles/other/tasks/main.yml":    "- include_tasks: create_docker_container.yml\n",
		}, traefikRules("traefik-renderer-contract"), 1},
		{"invalid role context", map[string]string{
			traefikDefaultsPath:              "example_role_traefik_enabled: true\n",
			traefikTasksPath:                 "- copy:\n    content: '{{ unrelated }}'\n",
			"roles/example/tasks/broken.yml": "- [\n",
		}, traefikRules("traefik-renderer-contract"), 3},
		{"invalid Docker context", map[string]string{
			"resources/tasks/docker/read.yml":   "- debug:\n    msg: \"{{ _docker_vars._docker_value | default('none') }}\"\n",
			"resources/tasks/docker/broken.yml": "- [\n",
		}, []Rule{{ID: "docker-vars-policy", Check: checkDockerVarsPolicy}}, 2},
		{"conflicting Docker policies", map[string]string{
			"resources/tasks/docker/a.yml": "- set_fact:\n    value: \"{{ lookup('docker_vars', specs={'_docker_value': {'omit': true}}) }}\"\n",
			"resources/tasks/docker/b.yml": "- set_fact:\n    value: \"{{ lookup('docker_vars', specs={'_docker_value': {'default': ''}}) }}\"\n",
		}, []Rule{{ID: "docker-vars-policy", Check: checkDockerVarsPolicy}}, 2},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			p := traefikProject(fixture.files)
			p.Sources["nil-context.yml"] = nil
			full := Analyze(p, fixture.rules)
			if len(full) != fixture.want {
				t.Fatalf("diagnostics=%+v want %d", full, fixture.want)
			}
			for _, d := range full {
				if len(d.Related) == 0 {
					if d.RuleID != "yaml-syntax" {
						t.Fatalf("missing related ownership: %+v", d)
					}
				}
			}
			// Wrapping a rule with the original Project exercises its uncached public
			// Check contract while preserving the engine's ordering/filtering boundary.
			directRules := make([]Rule, len(fixture.rules))
			for i, rule := range fixture.rules {
				directRules[i] = rule
				directRules[i].Check = func(_ *Project, s *Source) []Diagnostic { return rule.Check(p, s) }
			}
			if direct := Analyze(p, directRules); !reflect.DeepEqual(direct, full) {
				t.Fatalf("direct=%+v shared=%+v", direct, full)
			}
			for name := range p.Sources {
				p.Selected = map[string]bool{name: true}
				want := slices.DeleteFunc(slices.Clone(full), func(d Diagnostic) bool { return d.Path != name })
				if got := Analyze(p, fixture.rules); !reflect.DeepEqual(got, want) {
					t.Fatalf("selection %s: got=%+v want=%+v", name, got, want)
				}
			}
		})
	}
}

func TestAnalyzeSharedFactsRefreshAfterMutation(t *testing.T) {
	t.Run("renderer node and source", func(t *testing.T) {
		p := traefikProject(map[string]string{traefikDefaultsPath: "example_role_traefik_enabled: true\n", traefikTasksPath: "- copy:\n    content: '{{ unrelated }}'\n"})
		rules := traefikRules("traefik-renderer-contract")
		if got := Analyze(p, rules); len(got) != 1 {
			t.Fatalf("before=%+v", got)
		}
		task := p.Sources[traefikTasksPath]
		replacement, _ := Parse(task.Path, []byte("- include_tasks: create_docker_container.yml\n"))
		task.Documents = replacement.Documents
		task.Data = replacement.Data
		if got := Analyze(p, rules); len(got) != 0 {
			t.Fatalf("after=%+v", got)
		}
		task.RolePath = "roles/elsewhere"
		if got := Analyze(p, rules); len(got) != 1 || got[0].Path != traefikDefaultsPath {
			t.Fatalf("role mutation=%+v", got)
		}
	})
	t.Run("template data", func(t *testing.T) {
		p := traefikProject(map[string]string{
			traefikDefaultsPath: "example_role_traefik_enabled: true\n",
			traefikTasksPath:    "- template: src=router.yml.j2 dest=/tmp/router\n",
			traefikTemplatePath: "{{ unrelated }}\n",
		})
		rules := traefikRules("traefik-renderer-contract")
		if got := Analyze(p, rules); len(got) != 1 || len(got[0].Related) != 2 || got[0].Related[0].Path != traefikTemplatePath {
			t.Fatalf("before=%+v", got)
		}
		p.Sources[traefikTemplatePath].Data = []byte(traefikFixture(t, "renderer.good.j2"))
		if got := Analyze(p, rules); len(got) != 0 {
			t.Fatalf("after=%+v", got)
		}
	})
	t.Run("Docker policy node", func(t *testing.T) {
		name := "resources/tasks/docker/main.yml"
		p := traefikProject(map[string]string{name: "- set_fact:\n    value: \"{{ lookup('docker_vars', specs=specs) }}\"\n  vars:\n    specs:\n      _docker_value:\n        omit: true\n- debug:\n    msg: \"{{ _docker_vars._docker_value | default('none') }}\"\n"})
		rules := []Rule{{ID: "docker-vars-policy", Check: checkDockerVarsPolicy}}
		if got := Analyze(p, rules); len(got) != 0 {
			t.Fatalf("before=%+v", got)
		}
		TasksIn(p.Sources[name])[0].Vars.Get("specs").Get("_docker_value").Get("omit").Value = "false"
		if got := Analyze(p, rules); len(got) != 1 || !strings.Contains(got[0].Message, "not literal true") {
			t.Fatalf("after=%+v", got)
		}
	})
}

func TestAnalyzeSharedFactsDuplicateSourcesAndNodes(t *testing.T) {
	p := traefikProject(map[string]string{traefikDefaultsPath: "example_role_traefik_enabled: true\n", traefikTasksPath: "- copy:\n    content: '{{ unrelated }}'\n"})
	source := p.Sources[traefikTasksPath]
	source.Documents[0].Items = append(source.Documents[0].Items, source.Documents[0].Items[0])
	p.Sources["roles/example/tasks/duplicate.yml"] = source
	other := *source
	other.Path = "roles/other/tasks/main.yml"
	other.Role = "other"
	other.RolePath = "roles/other"
	p.Sources[other.Path] = &other
	p.Selected[other.Path] = true
	rules := traefikRules("traefik-renderer-contract")
	got := Analyze(p, rules)
	if len(got) != 1 || got[0].Path != source.Path || len(got[0].Related) != 1 || got[0].Related[0].Path != traefikDefaultsPath {
		t.Fatalf("shared ownership=%+v", got)
	}
}

func TestAnalyzeSharedFactsConcurrentInvocations(t *testing.T) {
	p := traefikProject(map[string]string{traefikDefaultsPath: "example_role_traefik_enabled: true\n", traefikTasksPath: "- copy:\n    content: '{{ unrelated }}'\n", "resources/tasks/docker/main.yml": "- debug:\n    msg: \"{{ _docker_vars._docker_value | default('none') }}\"\n"})
	rules := append(traefikRules("traefik-renderer-contract"), Rule{ID: "docker-vars-policy", Check: checkDockerVarsPolicy})
	want := Analyze(p, rules)
	if len(want) != 2 {
		t.Fatalf("baseline=%+v", want)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 5 {
				if got := Analyze(p, rules); !reflect.DeepEqual(got, want) {
					t.Errorf("concurrent diagnostics=%+v want=%+v", got, want)
				}
			}
		})
	}
	wg.Wait()
}

func TestAnalyzeSharedFactsDiagnosticsOwnRelatedLocations(t *testing.T) {
	p := traefikProject(map[string]string{
		traefikDefaultsPath:              "example_role_traefik_enabled: true\n",
		traefikTasksPath:                 "- copy:\n    content: '{{ unrelated }}'\n",
		"roles/example/tasks/broken.yml": "- [\n",
	})
	diagnostics := Analyze(p, traefikRules("traefik-renderer-contract"))
	diagnostics = slices.DeleteFunc(diagnostics, func(d Diagnostic) bool { return d.RuleID == "yaml-syntax" })
	if len(diagnostics) != 2 || len(diagnostics[0].Related) != 1 || len(diagnostics[1].Related) != 1 {
		t.Fatalf("diagnostics=%+v", diagnostics)
	}
	diagnostics[0].Related[0].Message = "caller annotation"
	if diagnostics[1].Related[0].Message == "caller annotation" {
		t.Fatal("annotating one diagnostic changed another diagnostic's related locations")
	}
}
