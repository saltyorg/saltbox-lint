package format

import (
	"bytes"
	"fmt"
	"sort"
	"strings"

	"github.com/saltyorg/saltbox-lint/lint"
)

// Boundary gaps travel with their collection until a surrounding separator can
// retain them. Keeping them separate avoids turning indentation into blank data
// or losing nested trailing gaps when the closing delimiters disappear.
type flowRendering struct{ leading, body, trailing string }

func (b *candidateBuilder) flowEdit(n *lint.Node, depth, prefixStart int, prefix string) error {
	rendered, err := b.flow(n, depth)
	if err != nil {
		return err
	}
	indent := strings.Repeat(" ", depth)
	if line := strings.LastIndexByte(prefix, '\n'); line >= 0 {
		prefix = prefix[:line+1] + rendered.leading + indent
	} else if rendered.leading != "" {
		lineStart := bytes.LastIndexByte(b.source.Data[:prefixStart], '\n') + 1
		inline := strings.Trim(string(b.source.Data[lineStart:prefixStart]), " \t") != ""
		if prefix != "" || inline {
			prefix = b.newline
		}
		prefix += rendered.leading + indent
	}
	end := n.Span.End
	text := rendered.body
	if rendered.trailing != "" {
		suffixEnd := bytes.IndexByte(b.source.Data[end:], '\n')
		if suffixEnd < 0 {
			return fmt.Errorf("preserving trailing blank gap at EOF would change final-newline state")
		}
		suffixEnd += end + 1
		text += string(b.source.Data[end:suffixEnd]) + rendered.trailing
		end = suffixEnd
	}
	b.change(prefixStart, n.Span.Start, prefix)
	b.change(n.Span.Start, end, text)
	return nil
}

func (b *candidateBuilder) flow(n *lint.Node, depth int) (flowRendering, error) {
	if err := b.ctx.Err(); err != nil {
		return flowRendering{}, err
	}
	// YAMLComments is in source order. Only the first possible contained comment
	// matters; unrelated comments never need rescanning for each flow collection.
	comment := sort.Search(len(b.comments), func(i int) bool { return b.comments[i].Start >= n.Span.Start })
	if comment < len(b.comments) && b.comments[comment].Start < n.Span.End {
		return flowRendering{}, fmt.Errorf("interior flow comments have ambiguous block attachment")
	}
	raw := string(b.source.Data[n.Span.Start:n.Span.End])
	opening := strings.IndexAny(raw, "[{")
	if opening < 0 {
		return flowRendering{}, fmt.Errorf("cannot locate flow collection")
	}
	start, end := n.Span.Start+opening+1, n.Span.End-1
	prefix := strings.TrimRight(raw[:opening], " \t\r\n")
	prefixBlanks := b.blankLines(n.Span.Start+len(prefix), start-1)
	if !nonempty(n) {
		text := string(raw[opening]) + string(raw[len(raw)-1])
		if blanks := b.blankLines(start, end); blanks != "" {
			text = string(raw[opening]) + b.newline + blanks + strings.Repeat(" ", depth) + string(raw[len(raw)-1])
		}
		if prefix != "" {
			gap := " "
			if prefixBlanks != "" {
				gap = b.newline + prefixBlanks + strings.Repeat(" ", depth)
			}
			text = prefix + gap + text
		}
		if err := b.ctx.Err(); err != nil {
			return flowRendering{}, err
		}
		return flowRendering{body: text}, nil
	}
	var result flowRendering
	var body strings.Builder
	cursor := start
	pending := ""
	appendEntry := func(span lint.Span, entry flowRendering) {
		blanks := b.blankLines(cursor, span.Start)
		if cursor == start {
			result.leading = blanks
		} else {
			body.WriteString(b.newline)
			body.WriteString(pending)
			body.WriteString(blanks)
			body.WriteString(strings.Repeat(" ", depth))
		}
		body.WriteString(entry.body)
		pending = entry.trailing
		cursor = span.End
	}
	if n.Kind == "mapping" {
		for _, e := range n.Entries {
			if e.Key.Kind == "mapping" || e.Key.Kind == "sequence" {
				return flowRendering{}, fmt.Errorf("complex mapping keys are unsupported")
			}
			key, err := b.flowScalar(e.Key)
			if err != nil {
				return flowRendering{}, err
			}
			value, err := b.flowValue(e.Value, depth+2)
			if err != nil {
				return flowRendering{}, err
			}
			blank := b.blankLines(e.Key.Span.End, e.Value.Span.Start)
			gap := " "
			if blank != "" || value.leading != "" || nonempty(e.Value) && e.Value.Anchor == "" && e.Value.Tag == "" {
				gap = b.newline + blank + value.leading + strings.Repeat(" ", depth+2)
			}
			appendEntry(lint.Span{Start: e.Key.Span.Start, End: e.Value.Span.End}, flowRendering{body: key + ":" + gap + value.body, trailing: value.trailing})
		}
	} else {
		for _, item := range n.Items {
			value, err := b.flowValue(item, depth+2)
			if err != nil {
				return flowRendering{}, err
			}
			marker := "- "
			if value.leading != "" {
				marker = "-" + b.newline + value.leading + strings.Repeat(" ", depth+2)
			}
			appendEntry(item.Span, flowRendering{body: marker + value.body, trailing: value.trailing})
		}
	}
	result.body = body.String()
	result.trailing = pending + b.blankLines(cursor, end)
	if prefix != "" {
		result.body = prefix + b.newline + prefixBlanks + result.leading + strings.Repeat(" ", depth) + result.body
		result.leading = ""
	}
	if err := b.ctx.Err(); err != nil {
		return flowRendering{}, err
	}
	return result, nil
}

func (b *candidateBuilder) flowValue(n *lint.Node, depth int) (flowRendering, error) {
	if n.Kind == "mapping" || n.Kind == "sequence" {
		return b.flow(n, depth)
	}
	value, err := b.flowScalar(n)
	return flowRendering{body: value}, err
}

func (b *candidateBuilder) flowScalar(n *lint.Node) (string, error) {
	if err := b.ctx.Err(); err != nil {
		return "", err
	}
	raw := string(b.source.Data[n.Span.Start:n.Span.End])
	if strings.ContainsAny(raw, "\r\n") {
		return "", fmt.Errorf("multiline scalars in flow collections are unsupported")
	}
	return canonicalScalar(n, raw), nil
}

// Only complete source lines in a syntax gap are blank-line owners. The partial
// first and last lines contain delimiters/values and are structural whitespace.
func (b *candidateBuilder) blankLines(start, end int) string {
	var blanks strings.Builder
	first := bytes.IndexByte(b.source.Data[start:end], '\n')
	if first < 0 {
		return ""
	}
	for line := start + first + 1; line < end; {
		if b.ctx.Err() != nil {
			return ""
		}
		next := bytes.IndexByte(b.source.Data[line:end], '\n')
		if next < 0 {
			break
		}
		next += line + 1
		if strings.Trim(string(b.source.Data[line:next]), " \t\r\n") == "" {
			blanks.Write(b.source.Data[line:next])
		}
		line = next
	}
	return blanks.String()
}
