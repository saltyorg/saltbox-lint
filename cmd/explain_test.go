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

func TestMetadataAndExplainCommands(t *testing.T) {
	root := t.TempDir()
	filename := filepath.Join(root, "main.yml")
	const input = "v: '{{ a; b }}'\n"
	if err := os.WriteFile(filename, []byte(input), 0644); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		args    []string
		code    int
		machine bool
	}{
		{[]string{"rules", "--format", "json", "--color", "always"}, 0, true},
		{[]string{"rules", "jinja-layout", "--format", "json"}, 0, true},
		{[]string{"rules", "unknown", "--format", "json"}, 2, false},
		{[]string{"rules", "--format", "bad"}, 2, false},
		{[]string{"explain", filename, "--root", root, "--format", "json", "--color", "always"}, 0, true},
		{[]string{"explain", "-", "--stdin-filename", filename, "--root", root, "--format", "json"}, 0, true},
		{[]string{"explain", filename, "--root", root}, 0, false},
		{[]string{"explain", filename, "--format", "bad"}, 2, false},
		{[]string{"explain", "-"}, 2, false},
		{[]string{"explain", filename, filename}, 2, false},
		{[]string{"explain", filepath.Join(root, "missing.yml")}, 2, false},
	} {
		var out, stderr bytes.Buffer
		code := Run(t.Context(), tt.args, Streams{In: strings.NewReader(input), Out: &out, Err: &stderr}, "test")
		if code != tt.code || (code == 0 && stderr.Len() > 0) {
			t.Fatalf("%v: code %d, stderr %q", tt.args, code, stderr.String())
		}
		if tt.machine && (!json.Valid(out.Bytes()) || bytes.Contains(out.Bytes(), []byte("\x1b"))) {
			t.Fatalf("invalid machine output: %q", out.String())
		}
	}
	var out bytes.Buffer
	if Run(t.Context(), []string{"rules", "jinja-layout", "--format", "json"}, Streams{Out: &out}, "test") != 0 {
		t.Fatal("registry command")
	}
	var registry lint.RuleRegistry
	if err := json.Unmarshal(out.Bytes(), &registry); err != nil || len(registry.Rules) != 1 || registry.Rules[0].ID != "jinja-layout" {
		t.Fatalf("single rule: %#v %v", registry, err)
	}
	actual, err := os.ReadFile(filename)
	if err != nil || string(actual) != input {
		t.Fatal("help changed input")
	}
}
