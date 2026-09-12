package lint

import (
	"slices"
	"strings"
	"testing"
)

// These source spans are hand-counted and include the argument's own quotes
// and escapes, so a projected value cannot point at an identical earlier token.
func TestTaskScalarActionArguments(t *testing.T) {
	cases := []struct {
		name, input, key, value string
		span                    Span
	}{
		{"scalar", "- action: include_role name=nginx\n", "name", "nginx", Span{28, 33}},
		{"local builtin", "- local_action: ansible.builtin.include_role name=nginx\n", "name", "nginx", Span{50, 55}},
		{"quoted spaces", "- action: include_role name='nginx proxy'\n", "name", "nginx proxy", Span{28, 41}},
		{"escaped quote", "- action: include_role name=\"nginx\\\"proxy\"\n", "name", "nginx\"proxy", Span{28, 42}},
		{"jinja", "- action: include_role name={{ role_name | default('nginx proxy') }}\n", "name", "{{ role_name | default('nginx proxy') }}", Span{28, 68}},
		{"folded", "- action: >-\n    include_role\n    name=nginx\n", "name", "nginx", Span{39, 44}},
		{"YAML escape", "- action: \"include_role name=ng\\u0069nx\"\n", "name", "nginx", Span{29, 39}},
		{"inline module tail", "- action: {module: include_role name=nginx}\n", "name", "nginx", Span{37, 42}},
		{"empty value", "- action: include_role name=\n", "name", "", Span{28, 28}},
		{"last duplicate wins", "- action: include_role name=other name=nginx\n", "name", "nginx", Span{39, 44}},
		{"action hex escape", "- action: include_role name=ng\\x69nx\n", "name", "nginx", Span{28, 36}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, ds := Parse("tasks/main.yml", []byte(tc.input))
			if len(ds) != 0 {
				t.Fatal(ds)
			}
			tasks := TasksIn(s)
			if len(tasks) != 1 || tasks[0].Module != "include_role" {
				t.Fatalf("tasks=%+v", tasks)
			}
			arg := tasks[0].argument(tc.key)
			if arg == nil || arg.Kind != "string" || arg.Value != tc.value || arg.Span != tc.span {
				t.Fatalf("argument=%+v, want value=%q span=%+v", arg, tc.value, tc.span)
			}
		})
	}
}

func TestTaskActionArgumentPrecedence(t *testing.T) {
	for _, action := range []string{
		"include_role: {name: nginx}",
		"include_role: name=nginx",
		"action: include_role name=nginx",
		"local_action: include_role name=nginx",
		"action: {module: include_role name=nginx, name: other}",
		"action: {module: include_role name=other, name: other, args: {name: nginx}}",
		"action: {module: include_role name=other, args: 'name=nginx'}",
	} {
		t.Run(action, func(t *testing.T) {
			input := "- " + action + "\n  args: {name: fallback, public: false}\n"
			s, ds := Parse("tasks/main.yml", []byte(input))
			if len(ds) != 0 {
				t.Fatal(ds)
			}
			task := TasksIn(s)[0]
			if name := task.argument("name"); name == nil || name.Value != "nginx" {
				t.Fatalf("name=%+v", name)
			}
			if public := task.argument("public"); public == nil || public.Value != "false" {
				t.Fatalf("fallback public=%+v", public)
			}
		})
	}
}

func TestTaskScalarArgumentsDecodeBeforeAssignment(t *testing.T) {
	for _, tc := range []struct {
		tail, value string
		span        Span
	}{
		{`name\x3dother`, "other", Span{31, 36}},
		{`na\x6de=other`, "other", Span{31, 36}},
		{`name=nginx\t`, "nginx", Span{28, 33}},
		{`name=\tnginx\t`, "nginx", Span{30, 35}},
		{`\tname\t=other`, "other", Span{32, 37}},
		{`name=\vnginx\f`, "nginx", Span{30, 35}},
		{`name=\t'other'\t`, "other", Span{30, 37}},
		{`name\=literal name\x3dother`, "other", Span{45, 50}},
	} {
		t.Run(tc.tail, func(t *testing.T) {
			s, ds := Parse("tasks/main.yml", []byte("- action: include_role "+tc.tail+"\n  args: {name: nginx}\n"))
			if len(ds) != 0 {
				t.Fatal(ds)
			}
			arg := TasksIn(s)[0].argument("name")
			if arg == nil || arg.Value != tc.value || arg.Span != tc.span {
				t.Fatalf("value=%+v, want %q at %+v", arg, tc.value, tc.span)
			}
		})
	}
}

func TestTaskScalarArgumentsUsePythonBoundaryWhitespace(t *testing.T) {
	for _, tc := range []struct {
		name, tail, value string
		span              Span
	}{
		{"U+001C key", `name\x1c=other`, "other", Span{32, 37}},
		{"U+001C leading value", `name=\x1cnginx`, "nginx", Span{32, 37}},
		{"U+001C trailing value", `name=nginx\x1c`, "nginx", Span{28, 33}},
		{"U+001D key", `name\x1d=other`, "other", Span{32, 37}},
		{"U+001D leading value", `name=\x1dnginx`, "nginx", Span{32, 37}},
		{"U+001D trailing value", `name=nginx\x1d`, "nginx", Span{28, 33}},
		{"U+001E key", `name\x1e=other`, "other", Span{32, 37}},
		{"U+001E leading value", `name=\x1enginx`, "nginx", Span{32, 37}},
		{"U+001E trailing value", `name=nginx\x1e`, "nginx", Span{28, 33}},
		{"U+001F key", `name\x1f=other`, "other", Span{32, 37}},
		{"U+001F leading value", `name=\x1fnginx`, "nginx", Span{32, 37}},
		{"U+001F trailing value", `name=nginx\x1f`, "nginx", Span{28, 33}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, ds := Parse("tasks/main.yml", []byte("- action: include_role "+tc.tail+"\n  args: {name: fallback}\n"))
			if len(ds) != 0 {
				t.Fatal(ds)
			}
			arg := TasksIn(s)[0].argument("name")
			if arg == nil || arg.Value != tc.value || arg.Span != tc.span {
				t.Fatalf("argument=%+v, want value=%q span=%+v", arg, tc.value, tc.span)
			}
		})
	}
}

func TestTaskScalarArgumentsPreserveQuotedPythonWhitespace(t *testing.T) {
	s, ds := Parse("tasks/main.yml", []byte("- action: include_role name='\\x1cnginx\\x1f'\n"))
	if len(ds) != 0 {
		t.Fatal(ds)
	}
	arg := TasksIn(s)[0].argument("name")
	if arg == nil || arg.Value != "\x1cnginx\x1f" || arg.Span != (Span{28, 43}) {
		t.Fatalf("argument=%+v", arg)
	}
}

func TestTaskScalarArgumentsDoNotExtendCommandOptions(t *testing.T) {
	for _, tail := range []string{`echo chdir\x1c=/tmp`, `echo \x1cchdir=/tmp`} {
		t.Run(tail, func(t *testing.T) {
			s, ds := Parse("tasks/main.yml", []byte("- action: command "+tail+"\n  args: {chdir: /fallback}\n"))
			if len(ds) != 0 {
				t.Fatal(ds)
			}
			task := TasksIn(s)[0]
			if task.FreeForm != tail {
				t.Fatalf("free form=%q, want %q", task.FreeForm, tail)
			}
			if arg := task.argument("chdir"); arg == nil || arg.Value != "/fallback" {
				t.Fatalf("chdir=%+v", arg)
			}
		})
	}
}

func TestTaskPythonWhitespacePreservesExpressionSpans(t *testing.T) {
	input := "- action: copy con\\x74ent\\x1c=\\x1d'{{ target }}'\\x1e other='{{ sibling }}'\n"
	s, ds := Parse("tasks/main.yml", []byte(input))
	if len(ds) != 0 {
		t.Fatal(ds)
	}
	value := TasksIn(s)[0].argument("content")
	if value == nil || value.Value != "{{ target }}" || value.Span != (Span{34, 48}) {
		t.Fatalf("content=%+v", value)
	}
	declaration := defaultDeclaration{Value: value}
	for _, expressions := range [][]Expression{expressionsForDeclaration(s, declaration), newDeclarationExpressionQuery(s).expressions(declaration)} {
		assertExpressionTokens(t, expressions, "target")
		if got := expressions[0].Tokens[0].Span; got != (Span{38, 44}) {
			t.Fatalf("token span=%+v", got)
		}
	}
}

func TestTaskDecodedArgumentPreservesExpressionSpans(t *testing.T) {
	input := "- action: copy con\\x74ent\\x3d\\t'{{ target }}'\\t other='{{ sibling }}'\n"
	s, ds := Parse("tasks/main.yml", []byte(input))
	if len(ds) != 0 {
		t.Fatal(ds)
	}
	value := TasksIn(s)[0].argument("content")
	if value == nil || value.Value != "{{ target }}" || value.Span != (Span{31, 45}) {
		t.Fatalf("content=%+v", value)
	}
	declaration := defaultDeclaration{Value: value}
	for _, expressions := range [][]Expression{expressionsForDeclaration(s, declaration), newDeclarationExpressionQuery(s).expressions(declaration)} {
		assertExpressionTokens(t, expressions, "target")
		if got := expressions[0].Tokens[0].Span; got != (Span{35, 41}) {
			t.Fatalf("token span=%+v", got)
		}
	}
}

func TestTaskScalarArgumentsPreserveCommandAndIncludeData(t *testing.T) {
	input := "- action: command printf name=nginx chdir=/tmp\n- action: include_tasks file='setup tasks.yml' apply=unused\n- set_fact:\n    payload:\n      - action: include_role name=nginx\n"
	s, ds := Parse("tasks/main.yml", []byte(input))
	if len(ds) != 0 {
		t.Fatal(ds)
	}
	tasks := TasksIn(s)
	if len(tasks) != 3 {
		t.Fatalf("tasks=%+v", tasks)
	}
	if tasks[0].FreeForm != "printf name=nginx chdir=/tmp" || tasks[0].argument("name") != nil {
		t.Fatalf("command payload reinterpreted: %+v", tasks[0])
	}
	if dir := tasks[0].argument("chdir"); dir == nil || dir.Value != "/tmp" {
		t.Fatalf("command chdir=%+v", dir)
	}
	if file := tasks[1].includeFile(); file != "setup tasks.yml" {
		t.Fatalf("include file=%q", file)
	}
}

func TestTaskScalarArgumentsDeclineAmbiguousTails(t *testing.T) {
	for _, tail := range []string{
		"name='nginx", "name={{ nginx", "name=nginx other='broken", "name=nginx\\N{SPACE}",
		"{{ name=nginx }}", "'name=nginx'", "name\\=nginx", "name=nginx\\",
	} {
		t.Run(tail, func(t *testing.T) {
			s, ds := Parse("tasks/main.yml", []byte("- action: include_role "+tail+"\n"))
			if len(ds) != 0 {
				t.Fatal(ds)
			}
			if arg := TasksIn(s)[0].argument("name"); arg != nil {
				t.Fatalf("ambiguous argument fabricated: %+v", arg)
			}
		})
	}
}

func TestTaskMalformedScalarArgumentsCannotExposeFallbackValues(t *testing.T) {
	for _, action := range []string{
		"action: include_role name=nginx other='broken",
		"action: {module: \"include_role name='broken\", name: fallback}",
		"action: {module: include_role, args: \"name='broken\"}",
	} {
		t.Run(action, func(t *testing.T) {
			s, ds := Parse("tasks/main.yml", []byte("- "+action+"\n  args: {name: fallback}\n"))
			if len(ds) != 0 {
				t.Fatal(ds)
			}
			if arg := TasksIn(s)[0].argument("name"); arg != nil {
				t.Fatalf("malformed scalar produced fallback: %+v", arg)
			}
		})
	}
}

func TestTaskProjectedExpressionMembership(t *testing.T) {
	input := "- action: copy content='{{ target }}' other='{{ sibling }}'\n"
	s, ds := Parse("tasks/main.yml", []byte(input))
	if len(ds) != 0 {
		t.Fatal(ds)
	}
	value := TasksIn(s)[0].argument("content")
	if value == nil {
		t.Fatal("missing projected content")
	}
	declaration := defaultDeclaration{Value: value}
	for _, expressions := range [][]Expression{expressionsForDeclaration(s, declaration), newDeclarationExpressionQuery(s).expressions(declaration)} {
		assertExpressionTokens(t, expressions, "target")
		if got := expressions[0].Tokens[0].Span; got != (Span{27, 33}) {
			t.Fatalf("token span=%+v", got)
		}
	}
	foreign, _ := Parse("tasks/foreign.yml", []byte(input))
	assertExpressionTokens(t, newDeclarationExpressionQuery(foreign).expressions(declaration))
	// A shared source scalar still contributes both occurrences, without exposing
	// the neighboring argument at either occurrence.
	s.Documents[0].Items = append(s.Documents[0].Items, s.Documents[0].Items[0])
	assertExpressionTokens(t, newDeclarationExpressionQuery(s).expressions(declaration), "target", "target")
	s.Documents[0].Tag = "!unsafe"
	assertExpressionTokens(t, newDeclarationExpressionQuery(s).expressions(declaration))
}

func TestTaskScalarArgumentsObserveSourceChanges(t *testing.T) {
	s, ds := Parse("tasks/main.yml", []byte("- action: include_role name=nginx\n"))
	if len(ds) != 0 {
		t.Fatal(ds)
	}
	_ = TasksIn(s)
	s.Data = []byte(strings.ReplaceAll(string(s.Data), "nginx", "other"))
	s.Documents[0].Items[0].Get("action").Value = "include_role name=other"
	if arg := TasksIn(s)[0].argument("name"); arg == nil || arg.Value != "other" {
		t.Fatalf("stale scalar projection: %+v", arg)
	}
}

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
