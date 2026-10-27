package lint

import (
	"slices"
	"strings"
)

const ignoreDirectivePrefix = "# saltbox-lint ignore "

func inlineIgnoreRule(source *Source, comment Span) string {
	text := strings.TrimRight(string(source.Data[comment.Start:comment.End]), " \t\r")
	id, ok := strings.CutPrefix(text, ignoreDirectivePrefix)
	if !ok || id == "lint-directive" {
		return ""
	}
	line := source.Position(comment.Start).Line - 1
	if strings.TrimSpace(string(source.Data[source.lineStarts[line]:comment.Start])) == "" {
		return ""
	}
	for _, rule := range Rules() {
		if rule.ID == id {
			return id
		}
	}
	return ""
}

// inlineIgnore is one valid ignore directive. It covers its own line and, when
// it follows a multi-line flow scalar or flow collection, every line of that
// node, because a comment cannot be placed on the node's earlier lines.
type inlineIgnore struct {
	rule        string
	comment     Span
	first, last int
	used        bool
}

func inlineIgnores(source *Source) []inlineIgnore {
	var ignores []inlineIgnore
	for _, comment := range source.YAMLComments() {
		rule := inlineIgnoreRule(source, comment)
		if rule == "" {
			continue
		}
		line := source.Position(comment.Start).Line
		ignore := inlineIgnore{rule: rule, comment: comment, first: line, last: line}
		var walk func(*Node)
		walk = func(n *Node) {
			if n == nil {
				return
			}
			switch n.Style {
			case "plain", "single-quoted", "double-quoted", "flow":
				if n.Span.End <= comment.Start && source.Position(n.Span.End).Line == line {
					ignore.first = min(ignore.first, source.Position(n.Span.Start).Line)
				}
			}
			for _, e := range n.Entries {
				walk(e.Key)
				walk(e.Value)
			}
			for _, item := range n.Items {
				walk(item)
			}
		}
		for _, document := range source.Documents {
			walk(document)
		}
		ignores = append(ignores, ignore)
	}
	return ignores
}

// suppressLineFindings removes findings named by inline ignores. When
// lint-directive ran, it reports each ignore of an evaluated rule that
// suppressed nothing, so stale and misplaced ignores do not fail silently.
func suppressLineFindings(source *Source, diagnostics []Diagnostic, evaluated []string) []Diagnostic {
	ignores := inlineIgnores(source)
	if len(ignores) == 0 {
		return diagnostics
	}
	result := diagnostics[:0]
	for _, diagnostic := range diagnostics {
		line := source.Position(diagnostic.Span.Start).Line
		suppressed := false
		for i := range ignores {
			if ignores[i].rule == diagnostic.RuleID && ignores[i].first <= line && line <= ignores[i].last {
				ignores[i].used, suppressed = true, true
			}
		}
		if !suppressed {
			result = append(result, diagnostic)
		}
	}
	if !slices.Contains(evaluated, "lint-directive") {
		return result
	}
	for _, ignore := range ignores {
		if !ignore.used && slices.Contains(evaluated, ignore.rule) {
			result = append(result, dockerDiagnostic(source, "lint-directive", ignore.comment,
				"Inline Saltbox lint ignore for "+ignore.rule+" suppresses no finding",
				"Remove the ignore, or place it after YAML code on the line where the "+ignore.rule+" finding starts, or after the multi-line scalar containing it."))
		}
	}
	return result
}

// A combined formatting proposal may cover findings beyond its primary span.
// Decline that proposal if it touches any line covered by an explicit ignore.
func fixesPreserveIgnoredLines(source *Source, edits []Edit) bool {
	for _, ignore := range inlineIgnores(source) {
		start, end := source.lineStarts[ignore.first-1], len(source.Data)
		if ignore.last < len(source.lineStarts) {
			end = source.lineStarts[ignore.last]
		}
		for _, edit := range edits {
			if edit.Span.Start < end && (edit.Span.End > start || edit.Span.Start == edit.Span.End && edit.Span.Start >= start) {
				return false
			}
		}
	}
	return true
}
