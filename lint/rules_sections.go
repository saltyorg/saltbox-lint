package lint

import (
	"fmt"
	"strings"
)

type sectionBanner struct {
	Name    string
	Title   sourceLine
	EndLine int
}

// Section banners must be actual YAML comments, not scalar contents that look
// like comments. Ordering and whitespace policy share this source fact.
func sectionBanners(source *Source, lines []sourceLine) []sectionBanner {
	comments := make(map[Span]bool)
	for _, span := range source.YAMLComments() {
		comments[span] = true
	}
	var banners []sectionBanner
	for i := 1; i+1 < len(lines); i++ {
		if !comments[lines[i-1].Span] || !comments[lines[i].Span] || !comments[lines[i+1].Span] || lines[i-1].Text != "################################" || lines[i+1].Text != "################################" || !strings.HasPrefix(lines[i].Text, "# ") {
			continue
		}
		name := strings.TrimPrefix(lines[i].Text, "# ")
		if strings.Trim(name, "# \t") != "" {
			banners = append(banners, sectionBanner{Name: name, Title: lines[i], EndLine: i + 1})
		}
	}
	return banners
}

type sectionGap struct {
	Name     string
	Variable Span
	Edit     Edit
}

// Only the exact missing separator before a variable (and its documentation)
// can be edited. This also defines the fix verifier's allowed whitespace gaps.
func sectionGaps(source *Source) []sectionGap {
	if source == nil || len(source.parseDiagnostics) != 0 {
		return nil
	}
	switch source.Kind {
	case Generic, Defaults, Vars, Inventory:
	default:
		return nil
	}
	declarations := make(map[int]Span)
	for _, declaration := range topLevelDeclarations(source) {
		declarations[source.Position(declaration.Key.Span.Start).Line-1] = declaration.Key.Span
	}
	lines := sourceLines(source.Data)
	banners := sectionBanners(source, lines)
	comments := make(map[int]bool)
	for _, span := range source.YAMLComments() {
		line := source.Position(span.Start).Line - 1
		if strings.TrimSpace(string(source.Data[lines[line].Span.Start:span.Start])) == "" {
			comments[line] = true
		}
	}
	var gaps []sectionGap
	for index, banner := range banners {
		next := banner.EndLine + 1
		limit := len(lines)
		if index+1 < len(banners) {
			// A later banner can share this banner's closing border. Its
			// title is never variable documentation for the earlier section.
			limit = banners[index+1].EndLine - 2
		}
		for i := next; i < limit; i++ {
			text := lines[i].Text
			documentStart := strings.HasPrefix(text, "---") && (len(text) == 3 || space(text[3]))
			if strings.TrimSpace(text) == "" || documentStart {
				break
			}
			if variable, ok := declarations[i]; ok {
				start := lines[next].Span.Start
				newline := "\n"
				if start >= 2 && string(source.Data[start-2:start]) == "\r\n" {
					newline = "\r\n"
				}
				gaps = append(gaps, sectionGap{Name: banner.Name, Variable: variable, Edit: Edit{Span: Span{start, start}, Text: newline}})
				break
			}
			if !comments[i] {
				break
			}
		}
	}
	return gaps
}

func checkSectionSpacing(_ *Project, source *Source) []Diagnostic {
	gaps := sectionGaps(source)
	if len(gaps) == 0 {
		return nil
	}
	edits := make([]Edit, 0, len(gaps))
	for _, gap := range gaps {
		edits = append(edits, gap.Edit)
	}
	var fix *Fix
	if verifiedCandidate(source, applyEdits(source.Data, edits)) {
		fix = &Fix{Message: "Insert missing blank lines after section banners", Edits: edits}
	}
	diagnostics := make([]Diagnostic, 0, len(gaps))
	for _, gap := range gaps {
		diagnostics = append(diagnostics, Diagnostic{
			Path: source.Path, RuleID: "section-spacing", Severity: "error", Span: gap.Variable,
			Message:  fmt.Sprintf("variables follow section %q without a blank line", gap.Name),
			Expected: "Leave at least one blank line between the section banner and its variables; keep documentation comments attached to their variable.",
			Fix:      fix,
		})
	}
	return diagnostics
}
