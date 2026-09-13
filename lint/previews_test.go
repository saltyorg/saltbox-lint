package lint

import (
	"bytes"
	"slices"
	"strings"
	"testing"
)

func TestPreviewChangeValidation(t *testing.T) {
	s, _ := Parse("vars.yml", []byte("v: café\r\n"))
	original := bytes.Clone(s.Data)
	cases := []struct {
		name  string
		edits []Edit
		want  string
	}{
		{"ordered duplicates", []Edit{{Span{7, 8}, "s"}, {Span{3, 7}, "tea"}, {Span{3, 7}, "tea"}}, ""}, // split UTF-8
		{"ordered distinct", []Edit{{Span{10, 10}, "next: true\n"}, {Span{3, 8}, "茶"}}, "v: 茶\r\nnext: true\n"},
		{"replace unicode", []Edit{{Span{3, 8}, "茶"}, {Span{3, 8}, "茶"}}, "v: 茶\r\n"},
		{"insertion eof", []Edit{{Span{10, 10}, "next: true\n"}}, "v: café\r\nnext: true\n"},
		{"no edits", nil, ""},
		{"no op", []Edit{{Span{3, 8}, "café"}}, ""},
		{"negative", []Edit{{Span{-1, 1}, "x"}}, ""},
		{"reversed", []Edit{{Span{5, 2}, "x"}}, ""},
		{"past eof", []Edit{{Span{0, 11}, "x"}}, ""},
		{"overlap", []Edit{{Span{3, 8}, "x"}, {Span{4, 5}, "y"}}, ""},
		{"same insertion", []Edit{{Span{3, 3}, "x"}, {Span{3, 3}, "y"}}, ""},
		{"invalid yaml", []Edit{{Span{3, 8}, "["}}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := Diagnostic{Path: s.Path, Preview: &Preview{Edits: tc.edits}}
			edits := slices.Clone(tc.edits)
			change, normalized, ok := PreviewChange(s, d)
			if ok != (tc.want != "") || ok && string(change.After) != tc.want {
				t.Fatalf("ok=%v after=%q", ok, change.After)
			}
			if !bytes.Equal(original, s.Data) || !slices.Equal(edits, tc.edits) {
				t.Fatal("mutated inputs")
			}
			if ok {
				if len(normalized) == 0 || !bytes.Equal(change.Before, original) {
					t.Fatal(change)
				}
				change.Before[0] = 'X'
				change.After[0] = 'Y'
				if !bytes.Equal(original, s.Data) {
					t.Fatal("aliased source")
				}
			}
		})
	}
	d := Diagnostic{Path: "other.yml", Preview: &Preview{Edits: []Edit{{Span{3, 8}, "tea"}}}}
	if _, _, ok := PreviewChange(s, d); ok {
		t.Fatal("accepted another path")
	}
	if _, _, ok := PreviewChange(nil, d); ok {
		t.Fatal("accepted missing source")
	}
	d.Path = s.Path
	d.Fix = &Fix{Edits: []Edit{{Span{3, 8}, "tea"}}}
	d.Preview = nil
	if _, _, ok := PreviewChange(s, d); !ok {
		t.Fatal("missing fix-derived preview")
	}
	d.Preview = &Preview{}
	if _, _, ok := PreviewChange(s, d); ok {
		t.Fatal("invalid explicit proposal fell through to fix")
	}
}

func TestManualPreviewProducers(t *testing.T) {
	task := "- name: Éxample\n  ansible.builtin.debug: {msg: ok}\n"
	cases := []struct{ name, path, input, want, id string }{
		{"tag", "tasks/main.yml", task + "  tags: restart_web\n", task + "  tags: restart-web\n", "ansible-tag-name"},
		{"quoted tag", "tasks/main.yml", task + "  tags: 'restart_web'\n", task + "  tags: 'restart-web'\n", "ansible-tag-name"},
		{"static", "tasks/main.yml", "- ansible.builtin.import_tasks: other.yml\n", "- ansible.builtin.include_tasks: other.yml\n", "ansible-static-import"},
		{"quoted static", "tasks/main.yml", "- 'import_role': {name: other}\n", "- 'ansible.builtin.include_role': {name: other}\n", "ansible-static-import"},
		{"cloudflare", "vars.yml", "key: '{{ cloudflare.api }}'\n", "key: '{{ cloudflare_api_key }}'\n", "cloudflare-auth-contract"},
		{"cloudflare bracket", "vars.yml", "key: \"{{ cloudflare['email'] }}\"\n", "key: \"{{ cloudflare_email }}\"\n", "cloudflare-auth-contract"},
		{"parentheses", "tasks/main.yml", task + "  when: café is defined\n", task + "  when: (café is defined)\n", "ansible-when-parentheses"},
		{"uppercase boolean", "tasks/main.yml", task + "  when: TRUE\n", task + "  when: (true)\n", "ansible-when-parentheses"},
		{"quoted parentheses", "tasks/main.yml", task + "  when: 'café == ''oui'''\n", task + "  when: '(café == ''oui'')'\n", "ansible-when-parentheses"},
		{"boolean", "tasks/main.yml", task + "  when: false\n", task + "  when: (false)\n", "ansible-when-parentheses"},
		{"conditional", "vars.yml", "key: '{{ ((a if enabled else b)) }}'\n", "key: '{{ a if enabled else b }}'\n", "jinja-redundant-conditional-parentheses"},
		{"when list", "tasks/main.yml", task + "  when: enabled and café is defined\n", task + "  when:\n    - enabled\n    - (café is defined)\n", "ansible-when-list"},
		{"when grouped operand", "tasks/main.yml", task + "  when: a and (b and c)\n", task + "  when:\n    - a\n    - (b and c)\n", "ansible-when-list"},
		{"when crlf eof", "tasks/main.yml", strings.ReplaceAll(task, "\n", "\r\n") + "  when: enabled and (b or c)", strings.ReplaceAll(task, "\n", "\r\n") + "  when:\r\n    - enabled\r\n    - (b or c)", "ansible-when-list"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := ansibleProject(t, "saltbox", map[string]string{tc.path: tc.input})
			ds := Analyze(p, dockerRules(tc.id))
			safe := tc.name == "parentheses" || tc.name == "quoted parentheses" || tc.name == "conditional"
			if len(ds) != 1 || ds[0].Preview == nil || (ds[0].Fix != nil) != safe {
				t.Fatalf("diagnostics=%+v", ds)
			}
			change, _, ok := PreviewChange(p.Sources[tc.path], ds[0])
			if !ok || string(change.After) != tc.want {
				t.Fatalf("ok=%v after=%q want=%q", ok, change.After, tc.want)
			}
			if remaining := ansibleDiagnostics(t, tc.path, string(change.After), tc.id); len(remaining) != 0 {
				t.Fatalf("target remains: %+v", remaining)
			}
			changes, err := PlanFixes(p, ds)
			if err != nil || (len(changes) != 0) != safe {
				t.Fatalf("preview/fix eligibility: %v %v", changes, err)
			}
			if string(p.Sources[tc.path].Data) != tc.input {
				t.Fatal("source modified")
			}
		})
	}
}

func TestManualPreviewGuards(t *testing.T) {
	task := "- ansible.builtin.debug: {msg: ok}\n"
	for _, tc := range []struct{ id, field string }{
		{"ansible-tag-name", "tags: &tag restart_web"}, {"ansible-tag-name", "tags: !!str restart_web"}, {"ansible-tag-name", "tags: Restart_web"}, {"ansible-tag-name", "tags: '{{ restart_web }}'"},
		{"ansible-when-list", "when: 'a and b'"}, {"ansible-when-list", "when: &condition a and b"}, {"ansible-when-list", "when: !!str a and b"}, {"ansible-when-list", "when: a and b # reason"}, {"ansible-when-list", "when:\n    - a and b"}, {"ansible-when-list", "when: >-\n    a and b"},
		{"ansible-when-parentheses", "when: !!bool true"}, {"ansible-when-parentheses", "when: &condition a or b"}, {"ansible-when-parentheses", "when: >-\n    a or b"},
	} {
		t.Run(tc.field, func(t *testing.T) {
			ds := ansibleDiagnostics(t, "tasks/main.yml", task+"  "+tc.field+"\n", tc.id)
			if len(ds) != 1 || ds[0].Preview != nil || ds[0].Expected == "" {
				t.Fatalf("%+v", ds)
			}
		})
	}
}

func TestPreviewDoesNotChangeDiagnosticIdentity(t *testing.T) {
	s, _ := Parse("a.yml", []byte("a: b\n"))
	base := Diagnostic{Path: s.Path, RuleID: "example", Message: "same"}
	p := &Project{Sources: map[string]*Source{s.Path: s}, Selected: map[string]bool{s.Path: true}}
	a, b := base, base
	a.Preview = &Preview{Edits: []Edit{{Span{3, 4}, "c"}}}
	b.Preview = &Preview{Edits: []Edit{{Span{3, 4}, "d"}}}
	p.Diagnostics = []Diagnostic{base, a, b, a}
	if got := Analyze(p, nil); len(got) != 1 {
		t.Fatalf("preview metadata duplicated findings: %+v", got)
	}
}

func TestPreviewsPreserveExistingFixPlans(t *testing.T) {
	input := "- ansible.builtin.debug:\n    msg: '{{value}} {{other}}'\n  tags: restart_web\n  when: true\n"
	p := ansibleProject(t, "saltbox", map[string]string{"tasks/main.yml": input, "vars.yml": "one: \"{{ a\n | f }}\"\ntwo: \"{{ b\n | g }}\"\n"})
	ds := Analyze(p, dockerRules("jinja-layout", "ansible-tag-name", "ansible-when-parentheses"))
	before := slices.Clone(ds)
	for i := range before {
		before[i].Preview = nil
	}
	expected, err := PlanFixes(p, before)
	if err != nil || len(expected) != 1 {
		t.Fatalf("baseline plan: %v %v", expected, err)
	}
	got, err := PlanFixes(p, ds)
	if err != nil || len(got) != 1 || !bytes.Equal(got[0].After, expected[0].After) {
		t.Fatalf("preview changed plan: %v %v", got, err)
	}
	var shared []byte
	count := 0
	for _, d := range ds {
		if d.Fix == nil {
			continue
		}
		if d.Preview != nil {
			t.Fatal("duplicated fix edits into Preview")
		}
		proposal, _, ok := PreviewChange(p.Sources[d.Path], d)
		if !ok {
			t.Fatal("fix proposal unavailable")
		}
		if shared != nil && !bytes.Equal(proposal.After, shared) {
			t.Fatal("shared fix proposals disagree")
		}
		shared = proposal.After
		count++
	}
	if count < 2 {
		t.Fatalf("expected shared fix proposals, got %d", count)
	}
}
