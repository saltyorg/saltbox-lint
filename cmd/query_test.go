package cmd

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestQueryCommandNameSuffixCompletion(t *testing.T) {
	root, err := filepath.Abs("../lint/testdata/references")
	if err != nil {
		t.Fatal(err)
	}
	primary := filepath.Join(root, "roles/alpha/tasks/main.yml")
	before, err := os.ReadFile(primary)
	if err != nil {
		t.Fatal(err)
	}
	for _, callee := range []string{"lookup", "query", "q"} {
		for _, explicit := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/explicit=%t", callee, explicit), func(t *testing.T) {
				role := ""
				if explicit {
					role = ", role='alpha'"
				}
				source := "# 😀é\r\n- debug: {msg: \"{{ " + callee + "('role_var', '_na'" + role + ") }}\"}\r\n"
				start := strings.Index(source, "_na")
				var out, errors bytes.Buffer
				code := Run(t.Context(), []string{"query", "--root", root, "--stdin-filename", primary, "--operation", "completion", "--offset", strconv.Itoa(start + 2), "-"}, Streams{In: strings.NewReader(source), Out: &out, Err: &errors}, "test")
				var result lint.QueryReport
				if code != 0 || errors.Len() != 0 || json.Unmarshal(out.Bytes(), &result) != nil {
					t.Fatalf("query: %d %s %s", code, out.String(), errors.String())
				}
				if result.SourceSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(source))) {
					t.Fatal("unsaved completion source identity changed")
				}
				for _, completion := range result.Completions {
					if completion.Label == "_name" {
						if completion.Location.Span != (lint.DecisionSpan{Start: start, End: start + 3}) || completion.Text != "_name" || completion.Location.Text != "_na" {
							t.Fatalf("incorrect literal replacement: %#v", completion)
						}
						return
					}
				}
				t.Fatalf("missing _name completion: %#v", result.Completions)
			})
		}
	}
	after, err := os.ReadFile(primary)
	if err != nil || !bytes.Equal(after, before) {
		t.Fatal("query changed original source")
	}
}

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

func TestQueryCommandNestedLiteralLookup(t *testing.T) {
	root, err := filepath.Abs("../lint/testdata/references")
	if err != nil {
		t.Fatal(err)
	}
	primary := filepath.Join(root, "roles/alpha/tasks/main.yml")
	for _, callee := range []string{"lookup", "query", "q"} {
		for _, operation := range []string{"definition", "hover", "references", "completion"} {
			t.Run(callee+"/"+operation, func(t *testing.T) {
				source := "# 😀é\r\n- debug:\r\n    msg: |\r\n      {{ " + callee + "('role_var', '_outer', role=" + callee + "('role_var', '_name', role='alpha')) }}\r\n"
				var out, errors bytes.Buffer
				code := Run(t.Context(), []string{"query", "--root", root, "--stdin-filename", primary, "--operation", operation, "--offset", strconv.Itoa(strings.Index(source, "_name") + 2), "-"}, Streams{In: strings.NewReader(source), Out: &out, Err: &errors}, "test")
				var result lint.QueryReport
				if code != 0 || errors.Len() != 0 || json.Unmarshal(out.Bytes(), &result) != nil || result.State != "resolved" || len(result.Declarations) != 1 || result.Declarations[0].Name != "alpha_name" {
					t.Fatalf("nested query CLI: %d %s %s", code, out.String(), errors.String())
				}
				if result.SourceSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(source))) {
					t.Fatal("nested CLI source hash changed")
				}
				if operation == "completion" && len(result.Completions) == 0 {
					t.Fatal("nested CLI completion missing")
				}
			})
		}
	}
}
