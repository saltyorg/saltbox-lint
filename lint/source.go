package lint

import (
	"bytes"
	"errors"
	"fmt"
	"path"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/goccy/go-yaml/ast"
	"github.com/goccy/go-yaml/lexer"
	"github.com/goccy/go-yaml/parser"
	"github.com/goccy/go-yaml/token"
)

// Parse preserves the supplied bytes and reports invalid YAML as a located
// diagnostic. Templates are raw text and are never interpreted as YAML.
func Parse(filename string, data []byte) (*Source, []Diagnostic) {
	s := &Source{Path: path.Clean(filename), Data: bytes.Clone(data), lineStarts: []int{0}}
	s.Kind, s.Role, s.RolePath = classify(s.Path)
	for i, b := range s.Data {
		if b == '\n' {
			s.lineStarts = append(s.lineStarts, i+1)
		}
	}
	if s.Kind == Template {
		return s, nil
	}
	tokens := lexer.Tokenize(string(s.Data))
	a := sourceAdapter{Source: s, spans: make(map[*token.Token]Span), originEnds: make(map[*token.Token]int)}
	err := a.locateTokens(tokens)
	var file *ast.File
	if err == nil {
		file, err = parser.Parse(tokens, parser.ParseComments)
	}
	if err == nil {
		for _, doc := range file.Docs {
			if doc.Body == nil {
				continue
			}
			if _, commentOnly := doc.Body.(*ast.CommentGroupNode); commentOnly {
				continue
			}
			var n *Node
			n, err = a.adapt(doc.Body)
			if err != nil {
				break
			}
			s.Documents = append(s.Documents, n)
		}
	}
	if err != nil {
		span := Span{}
		var located interface{ GetToken() *token.Token }
		if errors.As(err, &located) {
			span = a.tokenSpan(located.GetToken())
		}
		s.Documents = nil
		s.parseDiagnostics = []Diagnostic{{Path: s.Path, RuleID: "yaml-syntax", Severity: "error", Message: err.Error(), Span: span}}
	}
	return s, slices.Clone(s.parseDiagnostics)
}

func classify(filename string) (Kind, string, string) {
	parts := strings.Split(filename, "/")
	roleStart := 0
	if len(parts) >= 5 && parts[0] == "resources" && parts[1] == "roles" {
		roleStart = 1
	}
	if len(parts) >= roleStart+4 && parts[roleStart] == "roles" {
		kind := Generic
		switch parts[roleStart+2] {
		case "defaults":
			kind = Defaults
		case "tasks":
			kind = Tasks
		case "handlers":
			kind = Handlers
		case "vars":
			kind = Vars
		case "templates":
			kind = Template
		}
		return kind, parts[roleStart+1], strings.Join(parts[:roleStart+2], "/")
	}
	if strings.HasSuffix(filename, ".j2") {
		return Template, "", ""
	}
	if len(parts) >= 3 && parts[0] == "resources" {
		switch parts[1] {
		case "tasks":
			return Tasks, "", ""
		case "templates":
			return Template, "", ""
		}
	}
	if len(parts) >= 2 {
		switch parts[0] {
		case "tasks":
			return Tasks, "", ""
		case "handlers":
			return Handlers, "", ""
		case "playbooks":
			return Playbook, "", ""
		}
	}
	if parts[0] == "group_vars" || parts[0] == "host_vars" || parts[0] == "inventory" || parts[0] == "inventories" {
		return Inventory, "", ""
	}
	switch filename {
	case "inventory.yml", "inventory.yaml":
		return Inventory, "", ""
	case "saltbox.yml", "saltbox.yaml", "sandbox.yml", "sandbox.yaml":
		return Playbook, "", ""
	case "vars.yml", "vars.yaml":
		return Vars, "", ""
	}
	return Generic, "", ""
}

// Position clamps out-of-range offsets and counts code points, not bytes.
func (s *Source) Position(offset int) Position {
	if s == nil {
		return Position{1, 1}
	}
	offset = min(max(offset, 0), len(s.Data))
	start := bytes.LastIndexByte(s.Data[:offset], '\n') + 1
	return Position{bytes.Count(s.Data[:offset], []byte{'\n'}) + 1, utf8.RuneCount(s.Data[start:offset]) + 1}
}

func (s *Source) offset(pos *token.Position) int {
	if pos == nil || pos.Line < 1 {
		return 0
	}
	if pos.Line > len(s.lineStarts) {
		return len(s.Data)
	}
	offset := s.lineStarts[pos.Line-1]
	for col := 1; col < pos.Column && offset < len(s.Data) && s.Data[offset] != '\n'; col++ {
		_, size := utf8.DecodeRune(s.Data[offset:])
		offset += size
	}
	return offset
}

// sourceAdapter keeps parser-library objects out of the shared source model.
type sourceAdapter struct {
	*Source
	spans      map[*token.Token]Span
	originEnds map[*token.Token]int
}

// The lexer reports rune coordinates, and tags/block folding can also shift
// those coordinates. Its ordered original token text is the authoritative
// bridge to bytes. Only whitespace may occur between those original fragments.
func (s *sourceAdapter) locateTokens(tokens token.Tokens) error {
	cursor := 0
	for _, t := range tokens {
		if t.Origin == "" {
			continue
		}
		origin := []byte(t.Origin)
		gap := bytes.Index(s.Data[cursor:], origin)
		if gap < 0 || len(bytes.TrimSpace(s.Data[cursor:cursor+gap])) != 0 {
			return fmt.Errorf("cannot locate original YAML token at %v", t.Position)
		}
		start := cursor + gap
		left := len(origin) - len(bytes.TrimLeft(origin, " \t\r\n"))
		right := len(bytes.TrimRight(origin, " \t\r\n"))
		s.spans[t] = Span{start + left, start + max(left, right)}
		cursor = start + len(origin)
		s.originEnds[t] = cursor
	}
	return nil
}

func (s *sourceAdapter) tokenSpan(t *token.Token) Span {
	if t == nil {
		return Span{}
	}
	if span, ok := s.spans[t]; ok {
		return span
	}
	start := s.offset(t.Position)
	if t.Type == token.ImplicitNullType {
		return Span{start, start}
	}
	raw := strings.Trim(t.Origin, " \t\r\n")
	return Span{start, min(start+len(raw), len(s.Data))}
}

func (s *sourceAdapter) adapt(input ast.Node) (*Node, error) {
	if input == nil {
		return nil, nil
	}
	n := &Node{Span: s.tokenSpan(input.GetToken()), Style: "plain"}
	switch a := input.(type) {
	case *ast.MappingNode:
		n.Kind, n.Style = "mapping", "block"
		for _, e := range a.Values {
			key, err := s.adapt(e.Key)
			if err != nil {
				return nil, err
			}
			value, err := s.adapt(e.Value)
			if err != nil {
				return nil, err
			}
			n.Entries = append(n.Entries, Entry{key, value})
			if len(n.Entries) == 1 && !a.IsFlowStyle {
				n.Span.Start = key.Span.Start
			}
			n.Span.End = max(n.Span.End, value.Span.End)
		}
		if a.IsFlowStyle {
			n.Style = "flow"
			n.Span.End = s.tokenSpan(a.End).End
		}
	case *ast.MappingValueNode:
		key, err := s.adapt(a.Key)
		if err != nil {
			return nil, err
		}
		value, err := s.adapt(a.Value)
		if err != nil {
			return nil, err
		}
		n.Kind, n.Style, n.Span = "mapping", "block", Span{key.Span.Start, value.Span.End}
		n.Entries = []Entry{{key, value}}
	case *ast.MappingKeyNode:
		return s.adapt(a.Value)
	case *ast.SequenceNode:
		n.Kind, n.Style = "sequence", "block"
		for _, item := range a.Values {
			child, err := s.adapt(item)
			if err != nil {
				return nil, err
			}
			n.Items = append(n.Items, child)
			n.Span.End = max(n.Span.End, child.Span.End)
		}
		if a.IsFlowStyle {
			n.Style = "flow"
			n.Span.End = s.tokenSpan(a.End).End
		}
	case *ast.StringNode:
		n.Kind, n.Value = "string", a.Value
		switch a.Token.Type {
		case token.SingleQuoteType:
			n.Style = "single-quoted"
		case token.DoubleQuoteType:
			n.Style = "double-quoted"
		}
	case *ast.LiteralNode:
		n.Kind, n.Style = "string", "literal"
		if a.Start.Type == token.FoldedType {
			n.Style = "folded"
		}
		if a.Value != nil {
			n.Value = a.Value.Value
			n.Span.End = max(n.Span.End, s.originEnds[a.Value.Token])
		}
	case *ast.BoolNode:
		n.Kind, n.Value = "bool", a.Token.Value
	case *ast.IntegerNode:
		n.Kind, n.Value = "number", a.Token.Value
	case *ast.FloatNode:
		n.Kind, n.Value = "number", a.Token.Value
	case *ast.InfinityNode:
		n.Kind, n.Value = "number", a.Token.Value
	case *ast.NanNode:
		n.Kind, n.Value = "number", a.Token.Value
	case *ast.NullNode:
		n.Kind = "null"
	case *ast.MergeKeyNode:
		n.Kind, n.Value = "string", "<<"
	case *ast.AnchorNode:
		child, err := s.adapt(a.Value)
		if err != nil {
			return nil, err
		}
		child.Anchor, child.Span.Start = a.Name.GetToken().Value, n.Span.Start
		return child, nil
	case *ast.AliasNode:
		n.Kind, n.Value = "alias", a.Value.GetToken().Value
		n.Span.End = s.tokenSpan(a.Value.GetToken()).End
	case *ast.TagNode:
		child, err := s.adapt(a.Value)
		if err != nil {
			return nil, err
		}
		child.Tag, child.Span.Start = a.Start.Value, n.Span.Start
		return child, nil
	default:
		return nil, fmt.Errorf("unsupported YAML syntax %T", input)
	}
	return n, nil
}
