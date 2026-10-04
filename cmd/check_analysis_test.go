package cmd

import (
	"encoding/json"
	"github.com/saltyorg/saltbox-lint/lint"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckAnalysisIsOptInAndComplete(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "clean.yml")
	if err := os.WriteFile(file, []byte("v: true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	code, wire, stderr := invoke(t, "", "check", file, "--format", "json")
	if code != 0 || stderr != "" || wire != "{\"schema_version\":2,\"diagnostics\":[],\"fixes\":[]}\n" {
		t.Fatalf("default response changed: %d %s %s", code, wire, stderr)
	}
	code, wire, stderr = invoke(t, "", "check", file, "--format", "json", "--include-analysis")
	var response struct {
		SchemaVersion int                  `json:"schema_version"`
		Analysis      *lint.AnalysisRecord `json:"analysis"`
	}
	if err := json.Unmarshal([]byte(wire), &response); err != nil {
		t.Fatal(err)
	}
	if code != 0 || stderr != "" || response.SchemaVersion != 2 || response.Analysis == nil || response.Analysis.SchemaVersion != 1 || len(response.Analysis.Sources) != 1 || response.Analysis.Sources[0].Path != "clean.yml" {
		t.Fatalf("response: %s %s", wire, stderr)
	}
	code, _, stderr = invoke(t, "", "check", file, "--include-analysis")
	if code != 2 || !strings.Contains(stderr, "requires --format json") {
		t.Fatal("non-JSON analysis accepted")
	}
}
