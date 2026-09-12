package lint

import (
	"context"
	"fmt"
	"slices"
)

// FormattingEdits returns only the existing verified Jinja layout and section
// spacing fixes. It does not discover files or promote manual previews to edits.
func FormattingEdits(source *Source) ([]Edit, error) {
	diagnostics, edits := layoutFindings(source)
	edits = append(edits, FormattingSectionEdits(source)...)
	edits, err := orderedEdits(edits)
	if err != nil {
		return nil, err
	}
	if len(edits) == 0 {
		if len(diagnostics) > 0 {
			return nil, fmt.Errorf("unsupported Jinja formatting: %s", diagnostics[0].Message)
		}
		return nil, nil
	}
	if !verifiedCandidate(source, applyEdits(source.Data, edits)) {
		return nil, fmt.Errorf("existing formatting corrections cannot be verified")
	}
	candidate, _ := Parse(source.Path, applyEdits(source.Data, edits))
	if remaining, _ := layoutFindings(candidate); len(remaining) > 0 {
		return nil, fmt.Errorf("unsupported Jinja formatting: %s", remaining[0].Message)
	}
	return edits, nil
}

// FormattingScalarEqual compares exact literal segments and Jinja tokens while
// permitting expression whitespace. Callers must separately verify that every
// changed gap is authorized by FormattingEdits; this is not write authorization.
func FormattingScalarEqual(a, b string) bool { return scalarSignature(a) == scalarSignature(b) }

// SourceLocalDiagnostics evaluates registry policies whose complete context is
// one source. It never loads files, discovers repositories or executes roles.
func SourceLocalDiagnostics(ctx context.Context, source *Source) ([]Diagnostic, error) {
	project := &Project{Sources: map[string]*Source{source.Path: source}, Selected: map[string]bool{source.Path: true}}
	project.analysis = newAnalysis(project, []string{source.Path})
	var diagnostics []Diagnostic
	for _, rule := range Rules() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		switch rule.Scope {
		case "file", "file path", "structural when fields", "standalone YAML Jinja outputs":
		default:
			continue
		}
		if rule.Check == nil || len(rule.Kinds) > 0 && !slices.Contains(rule.Kinds, source.Kind) {
			continue
		}
		diagnostics = append(diagnostics, rule.Check(project, source)...)
	}
	return diagnostics, nil
}

// FormattingSectionEdits identifies the exact shared section-spacing corrections.
// Independent format verification uses this projection as its expected comment
// attachment tree: adding a banner separator may move parser-owned head comments.
func FormattingSectionEdits(source *Source) []Edit {
	var edits []Edit
	for _, gap := range sectionGaps(source) {
		edits = append(edits, gap.Edit)
	}
	return edits
}
