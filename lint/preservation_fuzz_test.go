package lint

import (
	"bytes"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/internal/fuzztest"
	"gopkg.in/yaml.v3"
)

func FuzzParseSource(f *testing.F) {
	for _, seed := range fuzztest.Seeds(f, "testdata/preservation") {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if !fuzztest.Bounded(data) {
			return
		}
		original := bytes.Clone(data)
		source, diagnostics := Parse("vars.yml", data)
		fuzztest.Unchanged(t, original, data)
		fuzztest.Unchanged(t, original, source.Data)
		checkFuzzDiagnostics(t, source, diagnostics)
		var walk func(*Node)
		walk = func(n *Node) {
			if n == nil {
				t.Fatal("nil parsed node")
			}
			fuzztest.Span(t, data, n.Span.Start, n.Span.End)
			for _, entry := range n.Entries {
				walk(entry.Key)
				walk(entry.Value)
			}
			for _, item := range n.Items {
				walk(item)
			}
		}
		for _, document := range source.Documents {
			walk(document)
		}
		for _, comment := range source.YAMLComments() {
			fuzztest.Span(t, data, comment.Start, comment.End)
		}
		// Templates deliberately accept arbitrary bytes as uninterpreted text.
		template, ds := Parse("roles/demo/templates/raw.j2", data)
		if template.Kind != Template || len(template.Documents)+len(ds) != 0 {
			t.Fatal("raw template was interpreted")
		}
		fuzztest.Unchanged(t, original, template.Data)
		if len(data) > 0 {
			data[0] ^= 0xff
			fuzztest.Unchanged(t, original, source.Data)
			fuzztest.Unchanged(t, original, template.Data)
		}
	})
}

func FuzzExpressionSpans(f *testing.F) {
	for _, seed := range fuzztest.Seeds(f, "testdata/preservation") {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if !fuzztest.Bounded(data) {
			return
		}
		original := bytes.Clone(data)
		source, _ := Parse("tasks/main.yml", data)
		for _, expression := range append(Expressions(source), RuntimeExpressions(source)...) {
			fuzztest.Span(t, data, expression.Span.Start, expression.Span.End)
			last := expression.Span.Start
			for _, tok := range expression.Tokens {
				fuzztest.Span(t, data, tok.Span.Start, tok.Span.End)
				if tok.Span.Start < last || tok.Span.End > expression.Span.End {
					t.Fatalf("token outside expression or unordered: %+v in %+v", tok, expression)
				}
				last = tok.Span.Start // Decoded escape bytes may share a source unit.
			}
			if expression.Complete && expression.Kind != "implicit" {
				fuzztest.Span(t, data, expression.opening.Start, expression.opening.End)
				fuzztest.Span(t, data, expression.closing.Start, expression.closing.End)
				opening := data[expression.opening.Start:expression.opening.End]
				closing := data[expression.closing.Start:expression.closing.End]
				// YAML escapes can spell delimiters without literal brace bytes.
				// Decode those source units with the independent YAML parser.
				if expression.node.Style == "double-quoted" {
					decode := func(raw []byte) []byte {
						var value string
						if err := yaml.Unmarshal(append(append([]byte{'"'}, raw...), '"'), &value); err != nil {
							t.Fatal(err)
						}
						return []byte(value)
					}
					opening, closing = decode(opening), decode(closing)
				}
				if !bytes.HasPrefix(opening, []byte("{{")) && !bytes.HasPrefix(opening, []byte("{%")) {
					t.Fatalf("opening delimiter not at source span: %q", opening)
				}
				if !bytes.HasSuffix(closing, []byte("}}")) && !bytes.HasSuffix(closing, []byte("%}")) {
					t.Fatalf("closing delimiter not at source span: %q", closing)
				}
			}
			for _, call := range Calls(expression, "lookup") {
				fuzztest.Span(t, data, call.Span.Start, call.Span.End)
			}
		}
		diagnostics, err := SourceLocalDiagnostics(t.Context(), source)
		if err != nil {
			t.Fatal(err)
		}
		checkFuzzDiagnostics(t, source, diagnostics)
		fuzztest.Unchanged(t, original, source.Data)
	})
}

func checkFuzzDiagnostics(t *testing.T, source *Source, diagnostics []Diagnostic) {
	t.Helper()
	for _, d := range diagnostics {
		if d.Path != source.Path || d.RuleID == "" || d.Message == "" {
			t.Fatalf("incomplete diagnostic: %+v", d)
		}
		fuzztest.Span(t, source.Data, d.Span.Start, d.Span.End)
		if d.Fix != nil {
			for _, edit := range d.Fix.Edits {
				fuzztest.Span(t, source.Data, edit.Span.Start, edit.Span.End)
			}
		}
		if d.Preview != nil {
			for _, edit := range d.Preview.Edits {
				fuzztest.Span(t, source.Data, edit.Span.Start, edit.Span.End)
			}
		}
	}
}

// This target generates a narrow, independently specified transformation. Its
// expected bytes are composed before calling any provider or verifier. Arbitrary
// payload bytes exercise quotes/Unicode in a protected neighboring YAML scalar.
func FuzzStructuralFixes(f *testing.F) {
	for _, seed := range fuzztest.Seeds(f, "testdata/preservation") {
		// Small payloads keep every generated expression below the wrap limit.
		for mode := range uint8(8) {
			f.Add(seed[:min(len(seed), 16)], mode)
		}
	}
	f.Fuzz(func(t *testing.T, payload []byte, mode uint8) {
		if len(payload) > 16 {
			return
		}
		name := "v_" + hex.EncodeToString(payload)
		prefix := "- name: Keep 😀\n  debug: {msg: " + strconv.Quote(string(payload)) + "}\n"
		condition := name + " is defined"
		input := prefix + "  when: " + condition + "\n"
		want := prefix + "  when: (" + condition + ")\n"
		switch mode % 8 {
		case 1:
			input = prefix + "  when: " + condition + " and other is defined\n"
			want = prefix + "  when:\n    - (" + condition + ")\n    - (other is defined)\n"
		case 2:
			input = prefix + "  when: (" + condition + ")\n"
			want = input
		case 3:
			input = prefix + "  when: " + name + " is\n"
			want = input
		case 4:
			input = prefix + "  when: " + name + " is custom_test and true\n"
			want = input
		case 5:
			input = prefix + "  when: !unsafe " + condition + "\n"
			want = input
		case 6:
			input = prefix + "  when: " + condition + " and other is defined # keep\n"
			want = input
		case 7:
			input = prefix + "  vars:\n    value: '{{ (" + name + " if flag else other) }}' # keep\n"
			want = prefix + "  vars:\n    value: '{{ " + name + " if flag else other }}' # keep\n"
		}
		if mode&0x80 != 0 {
			input = strings.ReplaceAll(input, "\n", "\r\n")
			want = strings.ReplaceAll(want, "\n", "\r\n")
		}
		if mode&0x40 != 0 {
			input = strings.TrimSuffix(strings.TrimSuffix(input, "\n"), "\r")
			want = strings.TrimSuffix(strings.TrimSuffix(want, "\n"), "\r")
		}
		source, ds := Parse("tasks/main.yml", []byte(input))
		project := &Project{Sources: map[string]*Source{source.Path: source}, Selected: map[string]bool{source.Path: true}}
		rules := dockerRules("ansible-when-parentheses", "ansible-when-list", "jinja-redundant-conditional-parentheses")
		diagnostics := Analyze(project, rules)
		checkFuzzDiagnostics(t, source, diagnostics)
		changes, err := PlanFixes(project, diagnostics)
		if err != nil {
			t.Fatal(err)
		}
		if len(ds) > 0 { // Arbitrary bytes can create unsupported YAML escapes.
			if len(changes) != 0 {
				t.Fatal("invalid YAML produced a structural plan")
			}
			return
		}
		got := source.Data
		if len(changes) > 0 {
			if len(changes) != 1 || !bytes.Equal(changes[0].Before, []byte(input)) {
				t.Fatal("plan lost the original source snapshot")
			}
			edits, err := PlannedFixEdits(changes[0])
			if err != nil {
				t.Fatal(err)
			}
			for _, edit := range edits {
				fuzztest.Span(t, source.Data, edit.Span.Start, edit.Span.End)
				if !fuzztest.Boundary(source.Data, edit.Span.Start) || !fuzztest.Boundary(source.Data, edit.Span.End) {
					t.Fatal("structural edit split Unicode or CRLF")
				}
			}
			got = applyEdits(source.Data, edits)
			if !bytes.Equal(got, changes[0].After) {
				t.Fatal("projected edits differ from accepted plan")
			}
		}
		if string(got) != want {
			t.Fatalf("authorized transformation mismatch\ninput: %q\ngot: %q\nwant: %q", input, got, want)
		}
		fuzztest.Unchanged(t, []byte(input), source.Data)
		project.Selected[source.Path] = false
		if unselected, err := PlanFixes(project, diagnostics); err != nil || len(unselected) != 0 {
			t.Fatalf("unselected source received fixes: %v %v", unselected, err)
		}
		next, nextDS := Parse(source.Path, got)
		if len(nextDS) != 0 {
			t.Fatal(nextDS)
		}
		project.Sources[source.Path], project.Selected[source.Path] = next, true
		if again, err := PlanFixes(project, Analyze(project, rules)); err != nil || len(again) != 0 {
			t.Fatalf("complete structural plan is not idempotent: %v %v", again, err)
		}
	})
}
