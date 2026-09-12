// Package compare provides the shared source and change model for the v5 and
// v6 Markdown presentation demos.
package compare

import (
	"context"

	v4highlight "saltbox-lint-markdown-demo-v4/highlight"
)

// Document is a complete source file and the explicit metadata used to
// classify it. SourcePath is a logical path; it is never used for discovery.
type Document struct {
	Source      string
	SourcePath  string
	Collections []string
}

// Highlight tokenizes and semantically classifies the complete document with
// the v4 highlighter. Callers select excerpt lines from the returned result.
func (d Document) Highlight(ctx context.Context, highlighter *v4highlight.Highlighter, theme string) (*v4highlight.DocumentResult, error) {
	return highlighter.HighlightDocument(ctx, d.Source, theme, v4highlight.DocumentOptions{
		SourcePath:  d.SourcePath,
		Collections: d.Collections,
	})
}

// LineRange is an inclusive, 1-based source range.
type LineRange struct {
	First int
	Last  int
}

// Excerpt pairs a complete document with the lines selected for presentation.
type Excerpt struct {
	Document Document
	Lines    LineRange
}

// Location identifies a finding in the current source.
type Location struct {
	Path   string
	Line   int
	Column int
}

// Fix describes whether and how a finding can be fixed.
type Fix struct {
	Description string
	Automatic   bool
}

// Finding contains all content shared by the two presentation styles. Diff is
// computed from the complete documents, so its line numbers are full-document
// coordinates rather than excerpt-relative coordinates.
type Finding struct {
	Ordinal     int
	Total       int
	Rule        string
	Location    Location
	Explanation string
	Fix         Fix
	Current     Excerpt
	Suggested   Excerpt
	Diff        []DiffRow
}

// Summary contains the aggregate counts shown after the findings.
type Summary struct {
	Errors         int
	Files          int
	AutomaticFixes int
}

// Report is the complete presentation-neutral demo model.
type Report struct {
	Title    string
	Findings []Finding
	Summary  Summary
}

// FileGroup contains findings for one logical source path.
type FileGroup struct {
	SourcePath string
	Findings   []Finding
}

// FileGroups groups findings by first path appearance while preserving their
// report order.
func (r Report) FileGroups() []FileGroup {
	groups := make([]FileGroup, 0)
	indexes := make(map[string]int)
	for _, finding := range r.Findings {
		index, ok := indexes[finding.Location.Path]
		if !ok {
			index = len(groups)
			indexes[finding.Location.Path] = index
			groups = append(groups, FileGroup{SourcePath: finding.Location.Path})
		}
		groups[index].Findings = append(groups[index].Findings, finding)
	}
	return groups
}
