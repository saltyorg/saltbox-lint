package report

import (
	"encoding/json"
	"io"
)

func jsonReport(w io.Writer, ds []Diagnostic) error {
	return json.NewEncoder(w).Encode(struct {
		Diagnostics []Diagnostic `json:"diagnostics"`
	}{ds})
}
