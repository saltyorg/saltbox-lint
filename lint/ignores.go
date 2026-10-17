package lint

import "strings"

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

func suppressLineFindings(source *Source, diagnostics []Diagnostic) []Diagnostic {
	ignored := map[int]string{}
	for _, comment := range source.YAMLComments() {
		if rule := inlineIgnoreRule(source, comment); rule != "" {
			ignored[source.Position(comment.Start).Line] = rule
		}
	}
	if len(ignored) == 0 {
		return diagnostics
	}
	result := diagnostics[:0]
	for _, diagnostic := range diagnostics {
		if ignored[source.Position(diagnostic.Span.Start).Line] != diagnostic.RuleID {
			result = append(result, diagnostic)
		}
	}
	return result
}

// A combined formatting proposal may cover findings beyond its primary span.
// Decline that proposal if it touches any line carrying an explicit ignore.
func fixesPreserveIgnoredLines(source *Source, edits []Edit) bool {
	for _, comment := range source.YAMLComments() {
		if inlineIgnoreRule(source, comment) == "" {
			continue
		}
		line := source.Position(comment.Start).Line - 1
		start, end := source.lineStarts[line], len(source.Data)
		if line+1 < len(source.lineStarts) {
			end = source.lineStarts[line+1]
		}
		for _, edit := range edits {
			if edit.Span.Start < end && (edit.Span.End > start || edit.Span.Start == edit.Span.End && edit.Span.Start >= start) {
				return false
			}
		}
	}
	return true
}
