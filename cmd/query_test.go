package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestQueryCommandExactSnapshot(t *testing.T) {
	root, err := filepath.Abs("../lint/testdata/references")
	if err != nil {
		t.Fatal(err)
	}
	source := "# 😀\r\n- debug: {msg: \"{{ lookup('role_var', '_port', role='beta') }}\"}\r\n"
	var out, errors bytes.Buffer
	code := Run(t.Context(), []string{"query", "--root", root, "--stdin-filename", filepath.Join(root, "roles/alpha/tasks/main.yml"), "--operation", "definition", "--offset", strconv.Itoa(strings.Index(source, "_port")), "-"}, Streams{In: strings.NewReader(source), Out: &out, Err: &errors}, "test")
	var result lint.QueryReport
	if code != 0 || errors.Len() != 0 || json.Unmarshal(out.Bytes(), &result) != nil || len(result.Declarations) != 1 {
		t.Fatalf("query: %d %s %s", code, out.String(), errors.String())
	}
	before, err := os.ReadFile(filepath.Join(root, "roles/alpha/tasks/main.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(before), "😀") {
		t.Fatal("wrote unsaved snapshot")
	}
	for _, args := range [][]string{{"query"}, {"query", "-"}, {"query", "--stdin-filename", "x.yml", "--offset", "-1", "-"}, {"query", "--stdin-filename", "x.yml", "--operation", "rename", "--offset", "0", "-"}} {
		if Run(t.Context(), args, Streams{In: strings.NewReader("value: x\n")}, "test") != 2 {
			t.Fatalf("accepted %v", args)
		}
	}
}
