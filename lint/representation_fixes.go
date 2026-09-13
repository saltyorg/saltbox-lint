package lint

import (
	"bytes"
	"strings"
)

// Representation proposals change delimiters and comments only. Scalar bytes
// remain owned by their existing expression proposals and exact node verifier.
func representationStructuralFixes(s *Source) []structuralFix {
	newline, ok := representationNewline(s.Data)
	if !ok || len(s.Documents) != 1 {
		return nil
	}
	fixes := healthcheckStructuralFixes(s, newline)
	if s.Kind == Defaults && s.Documents[0].Kind == "mapping" && s.Documents[0].Style == "block" {
		for _, d := range checkComputedDefaultDocumentation(nil, s) {
			start := d.Span.Start
			if start > 0 && s.Data[start-1] != '\n' {
				continue
			}
			if d.Span.End >= len(s.Data) || s.Data[d.Span.End] != ':' {
				continue
			}
			fixes = append(fixes, structuralFix{rule: d.RuleID, span: d.Span, edits: []Edit{{Span: Span{start, start}, Text: "# Skip docs" + newline}}})
		}
	}
	if fix, ok := sourceHeaderFix(s, newline); ok {
		fixes = append(fixes, fix)
	}
	return fixes
}

func representationNewline(data []byte) (string, bool) {
	newline := "\n"
	if bytes.Contains(data, []byte("\r\n")) {
		newline = "\r\n"
	}
	for i, b := range data {
		if b == '\r' && (i+1 == len(data) || data[i+1] != '\n') {
			return "", false
		}
		if b == '\n' && newline == "\r\n" && (i == 0 || data[i-1] != '\r') {
			return "", false
		}
	}
	return newline, true
}

func healthcheckStructuralFixes(s *Source, newline string) []structuralFix {
	var fixes []structuralFix
	for _, check := range dockerHealthchecks(s) {
		if check.declaration.Value.Style != "block" || check.declaration.Value.Anchor != "" || check.declaration.Value.Tag != "" || len(check.tests) != 1 {
			continue
		}
		entry := check.tests[0]
		n := entry.Value
		if n == nil || n.Kind != "sequence" || n.Style != "flow" || n.Tag != "" || n.Anchor != "" {
			continue
		}
		block := *n
		block.Style = "block"
		if !healthcheckShape(&block) {
			continue
		}
		if fix, ok := healthcheckFlowFix(s, entry, newline); ok {
			fixes = append(fixes, fix)
		}
	}
	return fixes
}

func healthcheckFlowFix(s *Source, entry Entry, newline string) (structuralFix, bool) {
	key, n := entry.Key, entry.Value
	start := bytes.LastIndexByte(s.Data[:key.Span.Start], '\n') + 1
	indent := string(s.Data[start:key.Span.Start])
	if strings.Trim(indent, " ") != "" || !undecoratedScalar(s, key) || key.Style != "plain" || string(s.Data[key.Span.Start:key.Span.End]) != "test" {
		return structuralFix{}, false
	}
	if strings.TrimSpace(string(s.Data[key.Span.End:n.Span.Start])) != ":" || s.Position(key.Span.Start).Line != s.Position(n.Span.Start).Line {
		return structuralFix{}, false
	}
	if n.Span.End <= n.Span.Start || s.Data[n.Span.Start] != '[' || s.Data[n.Span.End-1] != ']' {
		return structuralFix{}, false
	}
	for _, item := range n.Items {
		if bytes.ContainsAny(s.Data[item.Span.Start:item.Span.End], "\r\n") || item.Tag != "" || item.Anchor != "" || item.Kind == "alias" || (item.Style != "plain" && item.Style != "single-quoted" && item.Style != "double-quoted") {
			return structuralFix{}, false
		}
	}
	end := n.Span.End
	for end < len(s.Data) && s.Data[end] != '\r' && s.Data[end] != '\n' {
		end++
	}
	tail := string(s.Data[n.Span.End:end])
	if strings.TrimSpace(tail) != "" && !strings.HasPrefix(strings.TrimLeft(tail, " \t"), "#") {
		return structuralFix{}, false
	}
	if strings.TrimSpace(tail) == "" {
		tail = ""
	}
	if strings.TrimSpace(tail) == shellAllowance && !hasShellAllowance(s, key) {
		return structuralFix{}, false
	}
	itemIndent := indent + "  "
	opening := string(s.Data[n.Span.Start+1 : n.Items[0].Span.Start])
	if hasShellAllowance(s, key) && strings.TrimSpace(tail) != shellAllowance {
		first, rest, found := strings.Cut(opening, newline)
		if tail != "" || !found || strings.TrimSpace(first) != shellAllowance {
			return structuralFix{}, false
		}
		tail, opening = first, rest
	}
	firstGap, ok := healthcheckGap(opening, 0, 0, itemIndent, newline, false)
	if !ok {
		return structuralFix{}, false
	}
	prefix := ":" + tail + newline + firstGap + itemIndent + "- "
	edits := []Edit{{Span: Span{key.Span.End, n.Items[0].Span.Start}, Text: prefix}}
	for i := 1; i < len(n.Items); i++ {
		gap := Span{n.Items[i-1].Span.End, n.Items[i].Span.Start}
		text, ok := healthcheckGap(string(s.Data[gap.Start:gap.End]), 1, 1, itemIndent, newline, true)
		if !ok {
			return structuralFix{}, false
		}
		edits = append(edits, Edit{Span: gap, Text: text + itemIndent + "- "})
	}
	gap := Span{n.Items[len(n.Items)-1].Span.End, n.Span.End - 1}
	text, ok := healthcheckGap(string(s.Data[gap.Start:gap.End]), 0, 1, itemIndent, newline, true)
	if !ok {
		return structuralFix{}, false
	}
	edits = append(edits, Edit{Span: Span{gap.Start, end}, Text: strings.TrimSuffix(text, newline)})
	return structuralFix{rule: "docker-healthcheck-shape", span: key.Span, node: n, sequenceStyle: "block", edits: edits}, true
}

// Only whitespace, separator commas and complete comment lines may live
// between item spans. Comments keep their text and their preceding/following
// item association while list punctuation changes around them.
func healthcheckGap(gap string, minCommas, maxCommas int, indent, newline string, afterItem bool) (string, bool) {
	var result strings.Builder
	commas := 0
	lines := sourceLines([]byte(gap))
	for i, line := range lines {
		before, comment, hasComment := strings.Cut(line.Text, "#")
		for _, r := range before {
			switch r {
			case ' ', '\t':
			case ',':
				commas++
			default:
				return "", false
			}
		}
		if afterItem && i == 0 {
			if hasComment {
				result.WriteString(" #" + comment)
			}
			result.WriteString(newline)
			continue
		}
		if hasComment {
			result.WriteString(indent + "#" + comment + newline)
		}
	}
	return result.String(), commas >= minCommas && commas <= maxCommas
}

// Metadata blocks move with all following continuation/unknown comments. No
// metadata values are fabricated or rewritten. Ambiguous envelopes fail closed.
func sourceHeaderFix(s *Source, newline string) (structuralFix, bool) {
	diagnostics := checkAnsibleSourceHeader(nil, s)
	if len(diagnostics) == 0 || bytes.HasPrefix(s.Data, []byte("\xef\xbb\xbf")) {
		return structuralFix{}, false
	}
	lines := sourceLines(s.Data)
	var groups [4][]string
	var preamble []string
	group := -1
	marker := -1
	payload := -1
	border := "####################"
	for i, line := range lines {
		if line.Text == "---" {
			if marker >= 0 || payload >= 0 {
				return structuralFix{}, false
			}
			marker = i
			if completeHeaderGroups(groups) {
				payload = i + 1
			}
			continue
		}
		if line.Text == "..." || strings.HasPrefix(line.Text, "%") {
			return structuralFix{}, false
		}
		if payload >= 0 {
			continue
		}
		if line.Text != "" && !strings.HasPrefix(line.Text, "#") {
			payload = i
			continue
		}
		if i == 0 && line.Text != "" && strings.Trim(line.Text, "#") == "" {
			if headerBorder.MatchString(line.Text) {
				border = line.Text
			}
			continue
		}
		if (line.Text == "# Skip docs" || line.Text == "# Do not edit or override using the inventory") && completeHeaderGroups(groups) {
			payload = i
			continue
		}
		field := -1
		for j, pattern := range headerFields {
			if pattern.MatchString(line.Text) {
				field = j
				break
			}
		}
		if field >= 0 {
			if len(groups[field]) != 0 {
				return structuralFix{}, false
			}
			group = field
		}
		if group >= 0 {
			groups[group] = append(groups[group], line.Text)
		} else {
			preamble = append(preamble, line.Text)
		}
	}
	if payload < 0 || payload >= len(lines) {
		return structuralFix{}, false
	}
	result := []string{border}
	result = append(result, preamble...)
	for _, block := range groups {
		if len(block) == 0 {
			return structuralFix{}, false
		}
		result = append(result, block...)
	}
	result = append(result, "---")
	if len(result) > 20 {
		return structuralFix{}, false
	}
	text := strings.Join(result, newline) + newline
	return structuralFix{rule: diagnostics[0].RuleID, span: diagnostics[0].Span, edits: []Edit{{Span: Span{0, lines[payload].Span.Start}, Text: text}}}, true
}

func completeHeaderGroups(groups [4][]string) bool {
	for _, group := range groups {
		if len(group) == 0 {
			return false
		}
	}
	return true
}
