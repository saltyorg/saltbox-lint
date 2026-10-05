package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestReferencesCommand(t *testing.T) {
	root, err := filepath.Abs("../lint/testdata/references")
	if err != nil {
		t.Fatal(err)
	}
	primary := filepath.Join(root, "roles/alpha/tasks/main.yml")
	input, err := os.ReadFile(primary)
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		args    []string
		code    int
		machine bool
	}{
		{[]string{"references", primary, "--root", root, "--format", "json", "--color", "always"}, 0, true},
		{[]string{"references", primary, "--root", root}, 0, false},
		{[]string{"references", "-", "--stdin-filename", primary, "--root", root, "--format", "json"}, 0, true},
		{[]string{"references", primary, "--format", "bad"}, 2, false},
		{[]string{"references", "-"}, 2, false},
		{[]string{"references", primary, "--fix"}, 2, false},
		{[]string{"references", primary, "--changed-since", "HEAD"}, 2, false},
		{[]string{"references", filepath.Join(root, "missing.yml")}, 2, false},
		{[]string{"references", "--help"}, 0, false},
	} {
		var out, stderr bytes.Buffer
		code := Run(t.Context(), tt.args, Streams{In: bytes.NewReader(input), Out: &out, Err: &stderr}, "test")
		if code != tt.code || (code == 0 && stderr.Len() > 0) {
			t.Fatalf("%v: code %d stderr %q", tt.args, code, stderr.String())
		}
		if tt.machine {
			var report lint.ReferenceReport
			if err := json.Unmarshal(out.Bytes(), &report); err != nil || report.SchemaVersion != 1 || len(report.References) != 14 || bytes.Contains(out.Bytes(), []byte("\x1b")) {
				t.Fatalf("query protocol: %s %v", out.String(), err)
			}
		} else if code == 0 && len(tt.args) > 2 && !strings.Contains(out.String(), "runtime values and precedence") {
			t.Fatal("missing resolution contract")
		}
	}
	for _, format := range []string{"human", "json"} {
		if code := Run(t.Context(), []string{"references", primary, "--root", root, "--format", format}, Streams{Out: failWriter{}}, "test"); code != 2 {
			t.Fatal("report output error ignored")
		}
	}
	after, err := os.ReadFile(primary)
	if err != nil || !bytes.Equal(after, input) {
		t.Fatal("query mutated source")
	}
}
