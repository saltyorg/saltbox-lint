package lint

import (
	"slices"
	"testing"
)

func TestTasksInOwnsOnlyActualAnsibleLists(t *testing.T) {
	input := "- hosts: all\n  pre_tasks:\n    - debug: {msg: before}\n  tasks:\n    - block:\n        - git: {repo: example}\n      rescue:\n        - local_action: {module: import_role, name: example}\n      always:\n        - include_tasks: cleanup.yml\n    - set_fact:\n        payload:\n          - git: {}\n          - import_role: {}\n  post_tasks:\n    - debug: {msg: after}\n  handlers:\n    - command: echo done\n"
	s, ds := Parse("saltbox.yml", []byte(input))
	if len(ds) > 0 {
		t.Fatal(ds)
	}
	var modules []string
	for _, task := range TasksIn(s) {
		modules = append(modules, task.Module)
	}
	if want := []string{"debug", "", "git", "import_role", "include_tasks", "set_fact", "debug", "command"}; !slices.Equal(modules, want) {
		t.Fatalf("modules=%v", modules)
	}
}
func TestRuntimeExpressionsPreservesMappedConditionTokens(t *testing.T) {
	input := "- debug: {msg: '{{ explicit }}'}\n  when: >-\n    cloudflare.api != 'cloudflare.api'\n  failed_when:\n    - \"_docker_vars.\\u005fdocker_memory is defined\"\n  vars:\n    payload: {when: literal}\n"
	s, ds := Parse("tasks/main.yml", []byte(input))
	if len(ds) > 0 {
		t.Fatal(ds)
	}
	expressions := RuntimeExpressions(s)
	if len(expressions) != 3 {
		t.Fatal(expressions)
	}
	want := []string{"explicit", "cloudflare", "_docker_vars"}
	for i, e := range expressions {
		reads := VariableReads(e)
		if len(reads) != 1 || reads[0].Text != want[i] {
			t.Fatal(reads)
		}
		if got := input[reads[0].Span.Start:reads[0].Span.End]; got != want[i] {
			t.Fatal(got)
		}
		if i > 0 && e.Kind != "implicit" {
			t.Fatal(e)
		}
	}
}
