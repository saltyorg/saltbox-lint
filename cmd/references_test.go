package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
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

func TestReferencesCommandUnsafeExpressionAncestry(t *testing.T) {
	for _, callee := range []string{"lookup", "query", "q"} {
		call := callee + "('role_var', '_port', role='b')"
		for _, tc := range []struct {
			name, input string
			playbook    bool
		}{
			{"when-leaf", "- debug: {msg: ignored}\n  when: !unsafe %s", false},
			{"when-sequence", "- debug: {msg: ignored}\n  when: !unsafe\n    - %s", false},
			{"when-sequence-leaf", "- debug: {msg: ignored}\n  when:\n    - !unsafe %s", false},
			{"when-task", "- !unsafe\n  debug: {msg: ignored}\n  when: %s", false},
			{"when-block-sequence", "- block: !unsafe\n    - debug: {msg: ignored}\n      when: %s", false},
			{"when-block-task", "- !unsafe\n  block:\n    - debug: {msg: ignored}\n      when: %s", false},
			{"when-document", "!unsafe\n- debug: {msg: ignored}\n  when: %s\n---", false},
			{"changed-when-task", "- !unsafe\n  debug: {msg: ignored}\n  changed_when: %s", false},
			{"failed-when-task", "- !unsafe\n  debug: {msg: ignored}\n  failed_when: %s", false},
			{"until-task", "- !unsafe\n  debug: {msg: ignored}\n  until: %s", false},
			{"assert-leaf", "- assert:\n    that: !unsafe %s", false},
			{"assert-sequence", "- assert:\n    that: !unsafe\n      - %s", false},
			{"assert-sequence-leaf", "- assert:\n    that:\n      - !unsafe %s", false},
			{"assert-mapping", "- assert: !unsafe\n    that: %s", false},
			{"assert-task", "- !unsafe\n  assert:\n    that: %s", false},
			{"assert-block", "- block: !unsafe\n    - assert:\n        that: %s", false},
			{"assert-document", "!unsafe\n- assert:\n    that: %s\n---", false},
			{"assert-action-mapping", "- action: !unsafe\n    module: assert\n    args:\n      that: %s", false},
			{"assert-action-args", "- action:\n    module: assert\n    args: !unsafe\n      that: %s", false},
			{"assert-action-scalar", "- action: !unsafe \"assert that=\\\"%s\\\"\"", false},
			{"assert-action-args-scalar", "- action:\n    module: assert\n    args: !unsafe \"that=\\\"%s\\\"\"", false},
			{"include-task-apply", "- include_tasks:\n    file: child.yml\n    apply: !unsafe\n      when: %s", false},
			{"include-role-apply", "- include_role: !unsafe\n    name: b\n    apply:\n      when: %s", false},
			{"explicit-leaf", "- debug:\n    msg: !unsafe \"{{ %s }}\"", false},
			{"explicit-mapping", "- debug: !unsafe\n    msg: \"{{ %s }}\"", false},
			{"explicit-task", "- !unsafe\n  debug:\n    msg: \"{{ %s }}\"", false},
			{"explicit-block", "- block: !unsafe\n    - debug:\n        msg: \"{{ %s }}\"", false},
			{"explicit-document", "!unsafe\n- debug:\n    msg: \"{{ %s }}\"\n---", false},
			{"projected-leaf", "- action: !unsafe \"debug msg={{ %s }}\"", false},
			{"projected-task", "- !unsafe\n  action: \"debug msg={{ %s }}\"", false},
			{"projected-block", "- block: !unsafe\n    - action: \"debug msg={{ %s }}\"", false},
			{"projected-document", "!unsafe\n- action: \"debug msg={{ %s }}\"\n---", false},
			{"play-when", "- !unsafe\n  hosts: all\n  when: %s", true},
			{"play-roles", "- hosts: all\n  roles: !unsafe\n    - role: b\n      when: %s", true},
			{"play-document", "!unsafe\n- hosts: all\n  when: %s\n---", true},
		} {
			t.Run(callee+"/"+tc.name, func(t *testing.T) {
				root := t.TempDir()
				name, role, rolePath := "roles/a/tasks/main.yml", "a", "roles/a"
				if tc.playbook {
					name, role, rolePath = "playbook.yml", "", ""
				}
				primary := filepath.Join(root, name)
				declaration := filepath.Join(root, "roles/b/defaults/main.yml")
				unsafe := fmt.Sprintf(tc.input, call)
				safe := strings.ReplaceAll(unsafe, "!unsafe", "")
				input := unsafe + "\n" + safe + "\n"
				for filename, data := range map[string]string{primary: input, declaration: "b_role_port: 42\n"} {
					if err := os.MkdirAll(filepath.Dir(filename), 0755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filename, []byte(data), 0644); err != nil {
						t.Fatal(err)
					}
				}
				query := func(selection string) lint.ReferenceReport {
					t.Helper()
					var out, stderr bytes.Buffer
					code := Run(t.Context(), []string{"references", selection, "--root", root, "--format", "json"}, Streams{Out: &out, Err: &stderr}, "test")
					var result lint.ReferenceReport
					if err := json.Unmarshal(out.Bytes(), &result); err != nil || code != 0 || stderr.Len() != 0 || result.SchemaVersion != 1 {
						t.Fatalf("query failed: code %d, stderr %q, JSON %s, error %v", code, stderr.String(), out.String(), err)
					}
					return result
				}
				selected, full := query(primary), query(root)
				if !reflect.DeepEqual(selected.References, full.References) || len(selected.References) != 1 {
					t.Fatalf("unsafe ancestry admitted or selected/full differ: %#v / %#v", selected.References, full.References)
				}
				read := selected.References[0]
				start := strings.LastIndex(input, call)
				line := strings.Count(input[:start], "\n") + 1
				column := start - strings.LastIndex(input[:start], "\n")
				if read.State != "resolved" || len(read.Candidates) != 1 || read.OwningRole != role || read.OwningRolePath != rolePath || read.Location.Path != name || read.Location.Span != (lint.DecisionSpan{Start: start, End: start + len(call)}) || read.Location.Text != call || read.Location.Line != line || read.Location.Column != column {
					t.Fatalf("safe counterpart lost ownership, resolution or original position: %#v", read)
				}
				key := read.Candidates[0].Declaration.Key
				if key.Path != "roles/b/defaults/main.yml" || key.Span != (lint.DecisionSpan{Start: 0, End: 11}) || key.Text != "b_role_port" {
					t.Fatalf("declaration span lost: %#v", key)
				}
				if !selected.Dependencies.Complete || len(selected.Dependencies.Sources) != 1 || selected.Dependencies.Sources[0].Path != name {
					t.Fatalf("source dependency lost: %#v", selected.Dependencies)
				}
				found := false
				for _, directory := range selected.Dependencies.Sources[0].Directories {
					if directory.Path == "roles/b/defaults" && directory.State == "directory" {
						found = true
					}
				}
				if !found || len(selected.Sources) != 1 || selected.Sources[0].ParseState != "parsed" {
					t.Fatal("target dependency or parsed source lost")
				}
				for filename, want := range map[string]string{primary: input, declaration: "b_role_port: 42\n"} {
					data, err := os.ReadFile(filename)
					if err != nil || string(data) != want {
						t.Fatalf("query changed source %s: %v", filename, err)
					}
				}
				// An excluded read must not request its target context. The clean
				// query still records the selected source for later invalidation.
				if err := os.WriteFile(primary, []byte(unsafe+"\n"), 0644); err != nil {
					t.Fatal(err)
				}
				clean := query(primary)
				if len(clean.References) != 0 || !clean.Dependencies.Complete || len(clean.Dependencies.Sources) != 1 || clean.Dependencies.Sources[0].Path != name {
					t.Fatalf("excluded read or clean source dependency lost: %#v", clean)
				}
				for _, directory := range clean.Dependencies.Sources[0].Directories {
					if strings.HasPrefix(directory.Path, "roles/b/") {
						t.Fatalf("excluded read requested target context: %#v", directory)
					}
				}
				if data, err := os.ReadFile(primary); err != nil || string(data) != unsafe+"\n" {
					t.Fatalf("clean query changed source: %v", err)
				}
			})
		}
	}
}
