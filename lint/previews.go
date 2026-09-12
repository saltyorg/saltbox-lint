package lint

import (
	"bytes"
	"unicode/utf8"

	"github.com/saltyorg/saltbox-lint/yamlindex"
)

// PreviewChange reconstructs a display-only proposal against the complete source.
// An explicit Preview takes precedence over Fix.Edits. Invalid, conflicting,
// empty or unchanged proposals return false so callers can retain source and
// Expected guidance. Returned documents and ordered, deduplicated edits do not
// alias the inputs. This function never authorizes writes or invokes a fixer.
func PreviewChange(source *Source, diagnostic Diagnostic) (Change, []Edit, bool) {
	prepared, ok := preparePreview(source, diagnostic, false)
	return prepared.Change, prepared.Edits, ok
}

// PreparedPreview retains immutable lexical analysis from validation for
// presentation. Change and Edits still own their bytes; this never authorizes fixes.
type PreparedPreview struct {
	Change      Change
	Edits       []Edit
	SourceIndex *yamlindex.Index
}

// PreparePreview validates the same proposal as PreviewChange and retains only
// its source index, allowing semantic rendering to reuse the lexical pass.
func PreparePreview(source *Source, diagnostic Diagnostic) (PreparedPreview, bool) {
	return preparePreview(source, diagnostic, true)
}

func preparePreview(source *Source, diagnostic Diagnostic, retainIndex bool) (PreparedPreview, bool) {
	if source == nil || source.Path != diagnostic.Path {
		return PreparedPreview{}, false
	}
	var edits []Edit
	switch {
	case diagnostic.Preview != nil:
		edits = diagnostic.Preview.Edits
	case diagnostic.Fix != nil:
		edits = diagnostic.Fix.Edits
	}
	// Validate before sorting: malformed integer spans must not reach the shared
	// ordering helper's offset comparisons or any source slice.
	for _, edit := range edits {
		span := edit.Span
		if span.Start < 0 || span.End < span.Start || span.End > len(source.Data) || !utf8.ValidString(edit.Text) ||
			span.Start < len(source.Data) && !utf8.RuneStart(source.Data[span.Start]) ||
			span.End < len(source.Data) && !utf8.RuneStart(source.Data[span.End]) {
			return PreparedPreview{}, false
		}
	}
	normalized, err := orderedEdits(edits)
	if err != nil || len(normalized) == 0 {
		return PreparedPreview{}, false
	}
	after := applyEdits(source.Data, normalized)
	if bytes.Equal(after, source.Data) {
		return PreparedPreview{}, false
	}
	var index *yamlindex.Index
	if len(source.parseDiagnostics) == 0 {
		parsed, diagnostics := parseSource(source.Path, after, retainIndex)
		index = parsed.sourceIndex
		if len(diagnostics) > 0 {
			return PreparedPreview{}, false
		}
	}
	return PreparedPreview{Change: Change{Path: source.Path, Before: bytes.Clone(source.Data), After: after}, Edits: normalized, SourceIndex: index}, true
}

func editPreview(span Span, text string) *Preview {
	return &Preview{Edits: []Edit{{Span: span, Text: text}}}
}

// undecoratedScalar confines text edits to styles with literal, single-line
// boundaries. Tags and anchors can change interpretation or affect aliases.
func undecoratedScalar(s *Source, n *Node) bool {
	if n == nil || n.Tag != "" || n.Anchor != "" || n.Span.Start < 0 || n.Span.End < n.Span.Start || n.Span.End > len(s.Data) {
		return false
	}
	switch n.Style {
	case "plain", "single-quoted", "double-quoted":
	default:
		return false
	}
	return !bytes.ContainsAny(s.Data[n.Span.Start:n.Span.End], "\r\n")
}

func parenthesesPreview(s *Source, n *Node, span Span) *Preview {
	if !undecoratedScalar(s, n) || span.Start >= span.End || span.Start < n.Span.Start || span.End > n.Span.End {
		return nil
	}
	return &Preview{Edits: []Edit{{Span: Span{span.Start, span.Start}, Text: "("}, {Span: Span{span.End, span.End}, Text: ")"}}}
}
