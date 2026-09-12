package format

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/goccy/go-yaml/lexer"
	"github.com/goccy/go-yaml/token"
	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/saltyorg/saltbox-lint/yamlindex"
)

type candidateBuilder struct {
	ctx       context.Context
	source    *lint.Source
	newline   string
	edits     []lint.Edit
	sequences []int
	comments  []lint.Span
}

func canonicalCandidate(ctx context.Context, s *lint.Source) ([]byte, []lint.Edit, error) {
	b := candidateBuilder{ctx: ctx, source: s, newline: "\n"}
	if bytes.Contains(s.Data, []byte("\r\n")) {
		b.newline = "\r\n"
	}
	tokens := lexer.Tokenize(string(s.Data))
	locations, err := yamlindex.LocateTokens(string(s.Data), tokens)
	if err != nil {
		return nil, nil, err
	}
	for i, t := range tokens {
		if t.Type == token.SequenceEntryType {
			b.sequences = append(b.sequences, locations[i].Start)
		}
	}
	b.comments = s.YAMLComments()
	for _, n := range s.Documents {
		if err = b.node(n, 0); err != nil {
			return nil, nil, err
		}
	}
	edits, err := orderEdits(s.Data, b.edits)
	if err != nil {
		return nil, nil, err
	}
	return applyEdits(s.Data, edits), edits, nil
}

func (b *candidateBuilder) change(start, end int, text string) {
	if string(b.source.Data[start:end]) != text {
		b.edits = append(b.edits, lint.Edit{Span: lint.Span{Start: start, End: end}, Text: text})
	}
}

func (b *candidateBuilder) indent(offset, depth int) {
	start := bytes.LastIndexByte(b.source.Data[:offset], '\n') + 1
	if strings.Trim(string(b.source.Data[start:offset]), " \t") == "" {
		b.change(start, offset, strings.Repeat(" ", depth))
	}
}

func nonempty(n *lint.Node) bool { return len(n.Entries) > 0 || len(n.Items) > 0 }

func (b *candidateBuilder) node(n *lint.Node, depth int) error {
	if err := b.ctx.Err(); err != nil {
		return err
	}
	if n == nil {
		return fmt.Errorf("missing YAML node")
	}
	if n.Style == "flow" {
		text, err := b.flow(n, depth)
		if err != nil {
			return err
		}
		b.indent(n.Span.Start, depth)
		b.change(n.Span.Start, n.Span.End, text)
		return nil
	}
	switch n.Kind {
	case "mapping":
		for _, e := range n.Entries {
			if e.Key.Kind != "string" && e.Key.Kind != "number" && e.Key.Kind != "bool" && e.Key.Kind != "null" {
				return fmt.Errorf("complex mapping keys are unsupported")
			}
			b.indent(e.Key.Span.Start, depth)
			if err := b.scalar(e.Key, depth); err != nil {
				return err
			}
			colon := e.Key.Span.End
			for colon < len(b.source.Data) && (b.source.Data[colon] == ' ' || b.source.Data[colon] == '\t') {
				colon++
			}
			if colon >= len(b.source.Data) || b.source.Data[colon] != ':' {
				return fmt.Errorf("explicit or ambiguous mapping key syntax")
			}
			b.change(e.Key.Span.End, colon, "")
			value := e.Value
			gap := string(b.source.Data[colon+1 : value.Span.Start])
			childDepth := depth
			if nonempty(value) {
				childDepth += 2
			}
			if !strings.ContainsAny(gap, "\r\n#") {
				want := " "
				if nonempty(value) && value.Anchor == "" && value.Tag == "" {
					want = b.newline + strings.Repeat(" ", childDepth)
				}
				if value.Span.Start == value.Span.End {
					want = ""
				}
				b.change(colon+1, value.Span.Start, want)
			}
			if err := b.node(value, childDepth); err != nil {
				return err
			}
		}
	case "sequence":
		for _, item := range n.Items {
			index := sort.SearchInts(b.sequences, item.Span.Start) - 1
			if index < 0 {
				return fmt.Errorf("cannot locate sequence entry")
			}
			dash := b.sequences[index]
			b.indent(dash, depth)
			gap := string(b.source.Data[dash+1 : item.Span.Start])
			if strings.Trim(gap, " \t") == "" {
				want := " "
				if item.Span.Start == item.Span.End {
					want = ""
				}
				b.change(dash+1, item.Span.Start, want)
			}
			if err := b.node(item, depth+2); err != nil {
				return err
			}
		}
	default:
		return b.scalar(n, depth)
	}
	return nil
}

func (b *candidateBuilder) scalar(n *lint.Node, depth int) error {
	raw := string(b.source.Data[n.Span.Start:n.Span.End])
	if n.Style == "literal" || n.Style == "folded" {
		lineStart := bytes.LastIndexByte(b.source.Data[:n.Span.Start], '\n') + 1
		oldDepth := 0
		for lineStart+oldDepth < len(b.source.Data) && b.source.Data[lineStart+oldDepth] == ' ' {
			oldDepth++
		}
		if bytes.HasPrefix(b.source.Data[lineStart+oldDepth:], []byte("- ")) {
			oldDepth += 2
		}
		delta := depth - oldDepth
		cursor := n.Span.Start
		for {
			if err := b.ctx.Err(); err != nil {
				return err
			}
			next := bytes.IndexByte(b.source.Data[cursor:n.Span.End], '\n')
			if next < 0 {
				break
			}
			cursor += next + 1
			end := cursor
			for end < n.Span.End && b.source.Data[end] == ' ' {
				end++
			}
			if end >= n.Span.End {
				break
			}
			if b.source.Data[end] == '\n' || b.source.Data[end] == '\r' {
				continue
			}
			if end-cursor+delta < 0 {
				return fmt.Errorf("unsupported block scalar indentation")
			}
			b.change(cursor, end, strings.Repeat(" ", end-cursor+delta))
		}
		return nil
	}
	// Quoted multiline scalars and protected inner quotes/escapes stay exact.
	b.change(n.Span.Start, n.Span.End, canonicalScalar(n, raw))
	return nil
}

func simpleQuote(raw string) bool {
	return len(raw) >= 2 && raw[0] == '\'' && raw[len(raw)-1] == '\'' && !strings.ContainsAny(raw[1:len(raw)-1], "'\"\\\r\n") && !strings.Contains(raw, "{{") && !strings.Contains(raw, "{%")
}

func (b *candidateBuilder) flow(n *lint.Node, depth int) (string, error) {
	if err := b.ctx.Err(); err != nil {
		return "", err
	}
	for _, span := range b.comments {
		if span.Start >= n.Span.Start && span.Start < n.Span.End {
			return "", fmt.Errorf("interior flow comments have ambiguous block attachment")
		}
	}
	raw := string(b.source.Data[n.Span.Start:n.Span.End])
	prefix := ""
	if n.Anchor != "" || n.Tag != "" {
		start := strings.IndexAny(raw, "[{")
		if start < 0 {
			return "", fmt.Errorf("cannot locate prefixed flow collection")
		}
		prefix = strings.TrimSpace(raw[:start]) + b.newline + strings.Repeat(" ", depth)
	}
	if !nonempty(n) {
		empty := "{}"
		if n.Kind == "sequence" {
			empty = "[]"
		}
		if prefix != "" {
			prefix = strings.TrimSpace(strings.TrimSuffix(prefix, strings.Repeat(" ", depth))) + " "
		}
		return prefix + empty, nil
	}
	var lines []string
	if n.Kind == "mapping" {
		for _, e := range n.Entries {
			if e.Key.Kind == "mapping" || e.Key.Kind == "sequence" {
				return "", fmt.Errorf("complex mapping keys are unsupported")
			}
			key, err := b.flowScalar(e.Key)
			if err != nil {
				return "", err
			}
			value, err := b.flowValue(e.Value, depth+2)
			if err != nil {
				return "", err
			}
			gap := " "
			if nonempty(e.Value) && e.Value.Anchor == "" && e.Value.Tag == "" {
				gap = b.newline + strings.Repeat(" ", depth+2)
			}
			lines = append(lines, key+":"+gap+value)
		}
	} else {
		for _, item := range n.Items {
			value, err := b.flowValue(item, depth+2)
			if err != nil {
				return "", err
			}
			lines = append(lines, "- "+value)
		}
	}
	return prefix + strings.Join(lines, b.newline+strings.Repeat(" ", depth)), nil
}

func (b *candidateBuilder) flowValue(n *lint.Node, depth int) (string, error) {
	if n.Kind == "mapping" || n.Kind == "sequence" {
		return b.flow(n, depth)
	}
	return b.flowScalar(n)
}

func (b *candidateBuilder) flowScalar(n *lint.Node) (string, error) {
	raw := string(b.source.Data[n.Span.Start:n.Span.End])
	if strings.ContainsAny(raw, "\r\n") {
		return "", fmt.Errorf("multiline scalars in flow collections are unsupported")
	}
	return canonicalScalar(n, raw), nil
}

func canonicalScalar(n *lint.Node, raw string) string {
	if n.Style != "single-quoted" || n.Tag == "!unsafe" {
		return raw
	}
	start := strings.IndexByte(raw, '\'')
	if start < 0 || !simpleQuote(raw[start:]) {
		return raw
	}
	return raw[:start] + "\"" + raw[start+1:len(raw)-1] + "\""
}
