package lint

import (
	"bytes"
	"strings"
	"testing"
)

// These cases catch normalized source replacing original bytes, wrong rune/byte
// coordinates, and extracting comments as expression-bearing scalar nodes.
func TestParsePreservesScalars(t *testing.T) {
	cases := []struct{ name, data, key, value, raw, style string }{
		{"quoted multiline", "value: \"{{ foo\n  | default('bar') }}\"\n", "value", "{{ foo | default('bar') }}", "\"{{ foo\n  | default('bar') }}\"", "double-quoted"},
		{"crlf unicode", "😀: before\r\nvalue: 'hé😀' # comment\r\n", "value", "hé😀", "'hé😀'", "single-quoted"},
		{"unicode same line", "{😀: x, value: token}\r\n", "value", "token", "token", "plain"},
		{"literal", "# {{ not_a_scalar }}\nvalue: |\n  # literal content\n  {{ foo }}\nnext: yes\n", "value", "# literal content\n{{ foo }}\n", "|\n  # literal content\n  {{ foo }}\n", "literal"},
		{"folded", "value: >-\n  hello\n  world\nnext: yes\n", "value", "hello world", ">-\n  hello\n  world\n", "folded"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			s, ds := Parse("roles/example/defaults/sub/main.yaml", []byte(tt.data))
			if len(ds) != 0 {
				t.Fatalf("parse: %v", ds)
			}
			if !bytes.Equal(s.Data, []byte(tt.data)) {
				t.Fatal("original bytes changed")
			}
			if s.Kind != Defaults || s.Role != "example" || s.RolePath != "roles/example" {
				t.Fatalf("classification: %#v", s)
			}
			if len(s.Documents) != 1 {
				t.Fatalf("documents: %d", len(s.Documents))
			}
			n := s.Documents[0].Get(tt.key)
			if n == nil {
				t.Fatal("missing scalar")
			}
			if n.Kind != "string" || n.Value != tt.value || n.Style != tt.style {
				t.Errorf("scalar = %#v", n)
			}
			if got := string(s.Data[n.Span.Start:n.Span.End]); got != tt.raw {
				t.Errorf("span text = %q, want %q (%+v)", got, tt.raw, n.Span)
			}
			if n.Span.Start != strings.Index(tt.data, tt.raw) {
				t.Errorf("start = %d", n.Span.Start)
			}
		})
	}
}

func TestParseAnchorsTagsAndCollections(t *testing.T) {
	data := "base: &base {enabled: true, count: 42, absent: null}\ncopy: *base\nunsafe: !unsafe '{{ value }}'\nvault: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  abcdef\nitems: [one, two]\n"
	s, ds := Parse("vars.yml", []byte(data))
	if len(ds) != 0 {
		t.Fatalf("parse: %v", ds)
	}
	root := s.Documents[0]
	base := root.Get("base")
	if base.Kind != "mapping" || base.Anchor != "base" || base.Style != "flow" {
		t.Fatalf("base: %#v", base)
	}
	if base.Get("enabled").Kind != "bool" || base.Get("count").Kind != "number" || base.Get("absent").Kind != "null" {
		t.Fatal("lost scalar types")
	}
	alias := root.Get("copy")
	if alias.Kind != "alias" || alias.Value != "base" || string(s.Data[alias.Span.Start:alias.Span.End]) != "*base" {
		t.Fatalf("alias: %#v", alias)
	}
	if n := root.Get("unsafe"); n.Tag != "!unsafe" || n.Value != "{{ value }}" {
		t.Errorf("unsafe: %#v", n)
	}
	if n := root.Get("vault"); n.Tag != "!vault" || n.Style != "literal" || !strings.HasPrefix(n.Value, "$ANSIBLE_VAULT;") {
		t.Errorf("vault: %#v", n)
	}
	if n := root.Get("items"); n.Kind != "sequence" || len(n.Items) != 2 || n.Style != "flow" {
		t.Errorf("items: %#v", n)
	}
}

func TestParseErrorsAreLocated(t *testing.T) {
	for _, data := range []string{"first: ok\nvalue: one\nvalue: two\n", "first: ok\nvalue: \"unfinished\n"} {
		s, ds := Parse("bad.yaml", []byte(data))
		if len(ds) != 1 {
			t.Fatalf("diagnostics: %#v", ds)
		}
		d := ds[0]
		if d.Path != "bad.yaml" || d.RuleID == "" || d.Severity != "error" || d.Message == "" || d.Span.Start <= 0 || d.Span.End > len(data) {
			t.Errorf("diagnostic: %#v", d)
		}
		if len(s.Documents) != 0 {
			t.Fatal("invalid input exposed as parsed documents")
		}
	}
}

func TestSourceClassification(t *testing.T) {
	for _, tt := range []struct {
		path string
		kind Kind
		role string
	}{
		{"roles/demo/tasks/sub/main.yml", Tasks, "demo"}, {"roles/demo/handlers/main.yml", Handlers, "demo"},
		{"roles/demo/vars/main.yml", Vars, "demo"}, {"roles/demo/templates/config.ini.j2", Template, "demo"},
		{"group_vars/all.yml", Inventory, ""}, {"host_vars/server/main.yaml", Inventory, ""},
		{"saltbox.yml", Playbook, ""}, {"sandbox.yml", Playbook, ""}, {"random.yml", Generic, ""},
	} {
		t.Run(tt.path, func(t *testing.T) {
			s, ds := Parse(tt.path, []byte("value: ok\n"))
			if len(ds) != 0 || s.Kind != tt.kind || s.Role != tt.role {
				t.Errorf("source=%#v diagnostics=%v", s, ds)
			}
		})
	}
	s, ds := Parse("roles/demo/templates/config.j2", []byte("{% if enabled %}\n[config]\n{% endif %}"))
	if len(ds) != 0 || len(s.Documents) != 0 {
		t.Fatalf("template parsed as YAML: %#v %v", s, ds)
	}
}

func TestPositionAndGetBounds(t *testing.T) {
	s, _ := Parse("x.yml", []byte("😀: x\r\ny: z\n"))
	for _, tt := range []struct {
		offset int
		want   Position
	}{{-1, Position{1, 1}}, {4, Position{1, 2}}, {9, Position{2, 1}}, {100, Position{3, 1}}} {
		if got := s.Position(tt.offset); got != tt.want {
			t.Errorf("Position(%d)=%+v want %+v", tt.offset, got, tt.want)
		}
	}
	var n *Node
	if n.Get("x") != nil || s.Documents[0].Get("missing") != nil {
		t.Fatal("missing lookup should be nil")
	}
	var empty *Source
	if empty.Position(7) != (Position{1, 1}) {
		t.Fatal("nil source position")
	}
}

func TestConventionalResourcesAndInventory(t *testing.T) {
	for _, tt := range []struct {
		path string
		kind Kind
	}{
		{"resources/tasks/docker/create.yml", Tasks},
		{"resources/templates/config.conf", Template},
		{"inventory.yml", Inventory}, {"inventory.yaml", Inventory},
	} {
		s, _ := Parse(tt.path, []byte("value: ok\n"))
		if s.Kind != tt.kind {
			t.Errorf("%s kind=%s want %s", tt.path, s.Kind, tt.kind)
		}
	}
}

func TestBlockScalarDoesNotShiftFollowingToken(t *testing.T) {
	for _, data := range []string{
		"value: >-\n  hello\n  world\nnext: '😀'\n",
		"value: |\r\n  # literal content\r\n  😀\r\nnext: '😀'\r\n",
	} {
		s, ds := Parse("input.yml", []byte(data))
		if len(ds) > 0 {
			t.Fatal(ds)
		}
		next := s.Documents[0].Get("next")
		if next.Span.Start != strings.Index(data, "'😀'") || string(s.Data[next.Span.Start:next.Span.End]) != "'😀'" {
			t.Fatalf("following span=%+v", next.Span)
		}
		literal := s.Documents[0].Get("value")
		if literal.Span.End != strings.Index(data, "next:") {
			t.Errorf("block end=%d", literal.Span.End)
		}
	}
}

func TestTaggedSpanAndEmptyValues(t *testing.T) {
	data := "tagged: !unsafe &label 'value'\nempty:\nflow: {}\nlist: []\n"
	s, ds := Parse("input.yml", []byte(data))
	if len(ds) > 0 {
		t.Fatal(ds)
	}
	tagged := s.Documents[0].Get("tagged")
	if tagged.Tag != "!unsafe" || tagged.Anchor != "label" || string(s.Data[tagged.Span.Start:tagged.Span.End]) != "!unsafe &label 'value'" {
		t.Errorf("tagged=%#v", tagged)
	}
	empty := s.Documents[0].Get("empty")
	if empty.Kind != "null" || empty.Span.Start != empty.Span.End {
		t.Errorf("implicit null=%#v", empty)
	}
	for key, raw := range map[string]string{"flow": "{}", "list": "[]"} {
		n := s.Documents[0].Get(key)
		if string(s.Data[n.Span.Start:n.Span.End]) != raw {
			t.Errorf("%s span=%+v", key, n.Span)
		}
	}
}

func TestRootConventionalSources(t *testing.T) {
	for _, tt := range []struct {
		path string
		kind Kind
	}{
		{"inventories/production/group_vars/all.yml", Inventory},
		{"inventories/production/host_vars/server.yml", Inventory},
		{"tasks/main.yml", Tasks}, {"handlers/main.yml", Handlers}, {"playbooks/maintenance.yml", Playbook},
	} {
		s, _ := Parse(tt.path, []byte("value: ok\n"))
		if s.Kind != tt.kind {
			t.Errorf("%s kind=%s want %s", tt.path, s.Kind, tt.kind)
		}
	}
}

func TestRepeatedScalarSpansAcrossTagsAndBlocks(t *testing.T) {
	data := "before: 'same'\ntagged: !unsafe &name 'same'\nblock: |\n  same\nafter: 'same'\n"
	s, ds := Parse("input.yml", []byte(data))
	if len(ds) > 0 {
		t.Fatal(ds)
	}
	for _, tt := range []struct {
		key, raw   string
		start, end int
	}{
		{"before", "'same'", 8, 14},
		{"tagged", "!unsafe &name 'same'", 23, 43},
		{"block", "|\n  same\n", 51, 60},
		{"after", "'same'", 67, 73},
	} {
		n := s.Documents[0].Get(tt.key)
		if n.Span != (Span{tt.start, tt.end}) {
			t.Errorf("%s span=%+v want %d:%d", tt.key, n.Span, tt.start, tt.end)
		}
		if string(s.Data[n.Span.Start:n.Span.End]) != tt.raw {
			t.Errorf("%s span text=%q", tt.key, s.Data[n.Span.Start:n.Span.End])
		}
	}
}

func TestDocumentHeadersAreNotScalarDocuments(t *testing.T) {
	data := "# Title\n# {{ comment_only }}\n---\nvalue: ok\n...\n# between documents\n---\nother: fine\n"
	s, ds := Parse("input.yml", []byte(data))
	if len(ds) > 0 {
		t.Fatal(ds)
	}
	if len(s.Documents) != 2 || s.Documents[0].Get("value").Value != "ok" || s.Documents[1].Get("other").Value != "fine" {
		t.Fatalf("documents=%#v", s.Documents)
	}
	comments, ds := Parse("comments.yml", []byte("# comments only\n"))
	if len(ds) > 0 || len(comments.Documents) > 0 {
		t.Fatalf("comment documents=%#v diagnostics=%v", comments.Documents, ds)
	}
}

func TestYAMLDirectivesPreserveRealDocument(t *testing.T) {
	for _, data := range []string{
		"%YAML 1.2\n---\nvalue: 'kept'\n",
		"%TAG !e! tag:example.com,2000:app/\n---\nvalue: !e!name 'kept'\n",
	} {
		s, ds := Parse("input.yml", []byte(data))
		if len(ds) != 0 {
			t.Fatalf("valid directive: %v", ds)
		}
		if len(s.Documents) != 1 || s.Documents[0].Get("value").Value != "kept" {
			t.Fatalf("documents=%#v", s.Documents)
		}
		if string(s.Data) != data {
			t.Fatal("directive bytes changed")
		}
		n := s.Documents[0].Get("value")
		if !strings.HasSuffix(string(s.Data[n.Span.Start:n.Span.End]), "'kept'") {
			t.Fatalf("scalar span=%+v", n.Span)
		}
	}
}

func TestInventoryClassificationUsesConventionalVariablePaths(t *testing.T) {
	for _, tt := range []struct {
		path string
		kind Kind
	}{
		{"inventory", Generic},
		{"inventory/group_vars/all.yml", Inventory},
		{"inventories/production/group_vars/all.yml", Inventory},
		{"inventories/production/host_vars/server/main.yml", Inventory},
		{"inventory/production/group_vars/all/nested.yml", Inventory},
		{"inventories/production/requirements.yml", Generic},
		{"inventories/notes/config.yml", Generic},
		{"inventory/production/hosts.yml", Generic},
	} {
		s, _ := Parse(tt.path, []byte("value: ok\n"))
		if s.Kind != tt.kind {
			t.Errorf("%s kind=%s want %s", tt.path, s.Kind, tt.kind)
		}
	}
}

func TestDoubleQuotedUnicodeEscapesPreserveRawSpans(t *testing.T) {
	cases := []struct{ name, raw, value string }{
		{"hex", `"\x61"`, "a"},
		{"unicode", `"\u0061"`, "a"},
		{"long unicode", `"\U0001F600"`, "😀"},
		{"unicode before escapes", `"é😀 \x61\u0062\U0001F600"`, "é😀 ab😀"},
		{"escaped quote", `"\u0061\"tail"`, "a\"tail"},
		{"escaped backslash", `"\u0061\\tail"`, "a\\tail"},
		{"encoded quote", `"\x22"`, "\""},
		{"line continuation", "\"\\u0061\\\n  b\"", "ab"},
		{"folded newline", "\"\\u0061\n  b\"", "a b"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			data := "value: " + tt.raw + "\nafter: 'kept'\n"
			s, ds := Parse("input.yml", []byte(data))
			if len(ds) != 0 {
				t.Fatalf("valid escape rejected: %v", ds)
			}
			n := s.Documents[0].Get("value")
			if n.Kind != "string" || n.Style != "double-quoted" || n.Value != tt.value {
				t.Fatalf("scalar=%#v", n)
			}
			if n.Span.Start != 7 || n.Span.End != 7+len(tt.raw) || string(s.Data[n.Span.Start:n.Span.End]) != tt.raw {
				t.Fatalf("span=%+v raw=%q", n.Span, s.Data[n.Span.Start:n.Span.End])
			}
			after := s.Documents[0].Get("after")
			if string(s.Data[after.Span.Start:after.Span.End]) != "'kept'" || after.Span.Start != len(tt.raw)+15 {
				t.Errorf("following token=%#v", after)
			}
			if string(s.Data) != data {
				t.Fatal("original bytes changed")
			}
		})
	}
}

func TestRepeatedEscapedAndDecodedQuotedValuesKeepDistinctSpans(t *testing.T) {
	data := "values: [\"\\x61\", \"a\", \"\\u0061\", \"\\U00000061\", \"a\"]\n"
	s, ds := Parse("input.yml", []byte(data))
	if len(ds) != 0 {
		t.Fatalf("valid repeated values rejected: %v", ds)
	}
	items := s.Documents[0].Get("values").Items
	if len(items) != 5 {
		t.Fatalf("items=%d", len(items))
	}
	for i, tt := range []struct {
		span Span
		raw  string
	}{
		{Span{9, 15}, `"\x61"`}, {Span{17, 20}, `"a"`}, {Span{22, 30}, `"\u0061"`}, {Span{32, 44}, `"\U00000061"`}, {Span{46, 49}, `"a"`},
	} {
		n := items[i]
		if n.Value != "a" || n.Span != tt.span || string(s.Data[n.Span.Start:n.Span.End]) != tt.raw {
			t.Errorf("item %d=%#v raw=%q", i, n, s.Data[n.Span.Start:n.Span.End])
		}
	}
}

func TestDoubleQuotedBoundsRejectMissingBoundaries(t *testing.T) {
	for _, data := range []string{`other "later"`, `"unfinished`, `"escaped\"`, " \t\n"} {
		if span, ok := doubleQuotedSpan([]byte(data), 0); ok || span != (Span{}) {
			t.Errorf("unverified boundary accepted for %q: %+v", data, span)
		}
	}
}
