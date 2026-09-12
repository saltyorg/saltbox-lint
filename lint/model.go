// Package lint analyzes Saltbox and Sandbox sources without executing them.
package lint

import "github.com/saltyorg/saltbox-lint/yamlindex"

// Span is a half-open range of UTF-8 byte offsets in the original source.
type Span struct{ Start, End int }

// Position uses one-based lines and Unicode code point columns.
type Position struct{ Line, Column int }

// Node is a source-preserving view of YAML syntax. Aliases remain references;
// they are not expanded into copied mappings. Styles are plain, single-quoted,
// double-quoted, literal, folded, block, or flow. Spans include tag/anchor prefixes.
type Node struct {
	Kind, Value, Style, Tag, Anchor string
	Span                            Span
	Entries                         []Entry
	Items                           []*Node
	// Scalar action arguments retain their original scalar's membership and a
	// byte map after Ansible unquoting/escape decoding. These views are rebuilt
	// by TasksIn; they never replace or cache entries in the public source tree.
	scalarOrigin *Node
	scalarMap    []Span
}
type Entry struct{ Key, Value *Node }

// Get returns the first mapping value with the given scalar key.
func (n *Node) Get(key string) *Node {
	if n == nil {
		return nil
	}
	for _, e := range n.Entries {
		if e.Key != nil && e.Key.Value == key {
			return e.Value
		}
	}
	return nil
}

type Kind string

const (
	Generic   Kind = "generic"
	Defaults  Kind = "defaults"
	Tasks     Kind = "tasks"
	Handlers  Kind = "handlers"
	Vars      Kind = "vars"
	Inventory Kind = "inventory"
	Playbook  Kind = "playbook"
	Template  Kind = "template"
)

type Source struct {
	Path             string
	Data             []byte
	Kind             Kind
	Role, RolePath   string
	Documents        []*Node
	parseDiagnostics []Diagnostic
	lineStarts       []int
	yamlComments     []Span
	sourceIndex      *yamlindex.Index
}

// YAMLComments returns exact source spans for comments recognized by the YAML
// lexer. Quoted and block-scalar hash text is not a YAML comment.
func (s *Source) YAMLComments() []Span {
	if s == nil {
		return nil
	}
	return append([]Span(nil), s.yamlComments...)
}

type RelatedLocation struct {
	Path, Message string
	Span          Span
}
type Edit struct {
	Span Span
	Text string
}
type Fix struct {
	Message string
	Edits   []Edit
}

// Preview is a display-only suggestion. It never authorizes automatic edits.
// Every edit targets the diagnostic primary source, using its original bytes.
type Preview struct {
	Edits []Edit
}
type Diagnostic struct {
	Path, RuleID, Severity, Message, Expected string
	Span                                      Span
	Related                                   []RelatedLocation
	Preview                                   *Preview
	Fix                                       *Fix
}
type Rule struct {
	ID, Summary, Explanation, GoodExample, BadExample string
	Kinds                                             []Kind
	Scope                                             string
	Fixable                                           bool
	Check                                             func(*Project, *Source) []Diagnostic
}
type Project struct {
	analysis    *analysis
	Root, Name  string
	Sources     map[string]*Source
	Selected    map[string]bool
	Diagnostics []Diagnostic
}
type Options struct {
	Root          string
	Paths         []string
	StdinFilename string
	Stdin         []byte
}
type Change struct {
	Path          string
	Before, After []byte
}
