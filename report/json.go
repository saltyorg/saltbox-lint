package report

import (
	"encoding/json"
	"io"
	"strconv"
)

// Private wire records preserve the exported Go diagnostic and fix types.
// Shadowing Fix suppresses its legacy inline JSON field without duplicating
// every diagnostic field in the wire representation.
type jsonDiagnostic struct {
	Diagnostic
	Fix   *Fix   `json:"fix,omitempty"`
	FixID string `json:"fix_id,omitempty"`
}
type jsonFix struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	*Fix
}

func jsonReport(w io.Writer, ds []Diagnostic) error {
	result := struct {
		SchemaVersion int              `json:"schema_version"`
		Diagnostics   []jsonDiagnostic `json:"diagnostics"`
		Fixes         []jsonFix        `json:"fixes"`
	}{SchemaVersion: 2, Diagnostics: make([]jsonDiagnostic, 0, len(ds)), Fixes: make([]jsonFix, 0)}
	// diagnostics has already interned exact path/message/ordered-edit content.
	ids := map[*Fix]string{}
	for _, d := range ds {
		record := jsonDiagnostic{Diagnostic: d}
		if d.Fix != nil {
			id := ids[d.Fix]
			if id == "" {
				id = "fix-" + strconv.Itoa(len(result.Fixes)+1)
				ids[d.Fix] = id
				result.Fixes = append(result.Fixes, jsonFix{ID: id, Path: d.Path, Fix: d.Fix})
			}
			record.FixID = id
		}
		result.Diagnostics = append(result.Diagnostics, record)
	}
	return json.NewEncoder(w).Encode(result)
}
