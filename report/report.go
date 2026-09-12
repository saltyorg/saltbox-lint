// Package report presents shared diagnostics without evaluating policy.
package report

import (
	"fmt"
	"io"
	"strconv"

	"github.com/saltyorg/saltbox-lint/lint"
)

// Options selects a renderer. Summary is optional and used only by github.
type Options struct {
	Format  string
	Summary io.Writer
	GitHub  GitHub
	Human   HumanOptions
}

// Render writes diagnostics to w; it never reads or changes source files.
func Render(w io.Writer, p *lint.Project, ds []lint.Diagnostic, opts Options) error {
	records := diagnostics(p, ds)
	switch opts.Format {
	case "", "human":
		return human(w, p, records, opts.Human)
	case "concise":
		return concise(w, p, records)
	case "json":
		return jsonReport(w, records)
	case "github":
		return githubReport(w, p, records, opts)
	default:
		return fmt.Errorf("unknown output format %q", opts.Format)
	}
}

// Position is one-based and counts Unicode code points in JSON.
type Position struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

// Range is half-open, including for insertions and multiline edits.
type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}

// Span retains the engine's original half-open UTF-8 byte offsets.
type Span struct {
	Start int `json:"start"`
	End   int `json:"end"`
}
type Location struct {
	Path  string `json:"path"`
	Range Range  `json:"range"`
	Span  Span   `json:"span"`
}
type Related struct {
	Location
	Message string `json:"message"`
}
type Edit struct {
	Range Range  `json:"range"`
	Span  Span   `json:"span"`
	Text  string `json:"text"`
}
type Fix struct {
	Message string `json:"message"`
	Edits   []Edit `json:"edits"`
}
type Diagnostic struct {
	Location
	RuleID   string    `json:"rule_id"`
	Severity string    `json:"severity"`
	Message  string    `json:"message"`
	Expected string    `json:"expected,omitempty"`
	Related  []Related `json:"related,omitempty"`
	Fix      *Fix      `json:"fix,omitempty"`
	preview  *lint.Preview
}

func location(p *lint.Project, path string, span lint.Span) Location {
	s := p.Sources[path]
	start, end := s.Position(span.Start), s.Position(span.End)
	return Location{Path: path, Span: Span{span.Start, span.End}, Range: Range{Position{start.Line, start.Column}, Position{end.Line, end.Column}}}
}
func diagnostics(p *lint.Project, ds []lint.Diagnostic) []Diagnostic {
	records := make([]Diagnostic, 0, len(ds))
	type identity struct {
		path string
		fix  *lint.Fix
	}
	shared := map[identity]*Fix{}
	type content struct{ path, message, edits string }
	equivalent := map[content]*Fix{}
	for _, d := range ds {
		record := Diagnostic{Location: location(p, d.Path, d.Span), RuleID: d.RuleID, Severity: d.Severity, Message: d.Message, Expected: d.Expected, preview: d.Preview}
		for _, related := range d.Related {
			record.Related = append(record.Related, Related{Location: location(p, related.Path, related.Span), Message: related.Message})
		}
		if d.Fix != nil {
			id := identity{d.Path, d.Fix}
			record.Fix = shared[id]
			if record.Fix == nil {
				key := content{d.Path, d.Fix.Message, fixEditsKey(d.Fix.Edits)}
				record.Fix = equivalent[key]
				if record.Fix == nil {
					record.Fix = &Fix{Message: d.Fix.Message, Edits: make([]Edit, 0, len(d.Fix.Edits))}
					for _, edit := range d.Fix.Edits {
						loc := location(p, d.Path, edit.Span)
						record.Fix.Edits = append(record.Fix.Edits, Edit{Range: loc.Range, Span: loc.Span, Text: edit.Text})
					}
					equivalent[key] = record.Fix
				}
				shared[id] = record.Fix
			}
		}
		records = append(records, record)
	}
	return records
}

// Encode exact ordered source edits before allocating their display positions.
func fixEditsKey(edits []lint.Edit) string {
	var key []byte
	for _, edit := range edits {
		key = strconv.AppendInt(key, int64(edit.Span.Start), 10)
		key = append(key, ':')
		key = strconv.AppendInt(key, int64(edit.Span.End), 10)
		key = append(key, ':')
		key = strconv.AppendQuote(key, edit.Text)
		key = append(key, ';')
	}
	return string(key)
}
