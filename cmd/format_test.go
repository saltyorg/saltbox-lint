package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

type formatWireResponse struct {
	SchemaVersion int              `json:"schema_version"`
	Path          string           `json:"path"`
	SourceSHA256  string           `json:"source_sha256"`
	Status        string           `json:"status"`
	Edits         []formatWireEdit `json:"edits"`
	Reason        string           `json:"reason,omitempty"`
}

type formatWireEdit struct {
	Range struct {
		Start struct {
			Line, Column int
		} `json:"start"`
		End struct {
			Line, Column int
		} `json:"end"`
	} `json:"range"`
	Span struct {
		Start, End int
	} `json:"span"`
	Text string `json:"text"`
}

func invokeFormat(t *testing.T, input string, args ...string) (formatWireResponse, string, int) {
	t.Helper()
	code, out, stderr := invoke(t, input, args...)
	var response formatWireResponse
	if out != "" {
		if err := json.Unmarshal([]byte(out), &response); err != nil {
			t.Fatalf("decode stdout %q: %v", out, err)
		}
	}
	return response, stderr, code
}

func applyWireEdits(t *testing.T, input string, edits []formatWireEdit) string {
	t.Helper()
	data := []byte(input)
	last := 0
	for _, edit := range edits {
		if edit.Span.Start < last || edit.Span.End < edit.Span.Start || edit.Span.End > len(data) {
			t.Fatalf("invalid or conflicting edit: %+v", edit)
		}
		last = edit.Span.End
	}
	for i := len(edits) - 1; i >= 0; i-- {
		edit := edits[i]
		data = append(append(append([]byte{}, data[:edit.Span.Start]...), edit.Text...), data[edit.Span.End:]...)
	}
	return string(data)
}

func wirePosition(data []byte, offset int) (line, column int) {
	line, column = 1, 1
	for pos := 0; pos < offset; {
		r, size := utf8.DecodeRune(data[pos:])
		pos += size
		if r == '\n' {
			line, column = line+1, 1
		} else {
			column++
		}
	}
	return line, column
}

func TestFormatCanonicalResponseStatusesAndCoordinates(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: /missing/format-test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "roles", "demo", "defaults", "main.yml")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	disk := "disk: unchanged\n"
	if err := os.WriteFile(path, []byte(disk), 0600); err != nil {
		t.Fatal(err)
	}

	input := "emoji: ['🌨']\r\nlast: yes"
	response, stderr, code := invokeFormat(t, input, "--color", "always", "format", "--root", root, "--stdin-filename", path, "-")
	if code != 0 || stderr != "" {
		t.Fatalf("code=%d stderr=%q response=%+v", code, stderr, response)
	}
	if response.SchemaVersion != 1 || response.Path != "roles/demo/defaults/main.yml" || response.SourceSHA256 != "02801f61d65789f351d78c439fca1fa917157e0f3022a6a752bbe7a67a867bd2" || response.Status != "ready" || response.Reason != "" || len(response.Edits) == 0 {
		t.Fatalf("response=%+v", response)
	}
	if got, want := applyWireEdits(t, input, response.Edits), "emoji:\r\n  - \"🌨\"\r\nlast: yes"; got != want {
		t.Fatalf("formatted=%q want=%q edits=%+v", got, want, response.Edits)
	}
	for _, edit := range response.Edits {
		startLine, startColumn := wirePosition([]byte(input), edit.Span.Start)
		endLine, endColumn := wirePosition([]byte(input), edit.Span.End)
		if edit.Range.Start.Line != startLine || edit.Range.Start.Column != startColumn || edit.Range.End.Line != endLine || edit.Range.End.Column != endColumn {
			t.Fatalf("range does not describe original Unicode snapshot: %+v", edit)
		}
	}
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != disk {
		t.Fatalf("format wrote source: %q %v", actual, err)
	}

	for _, test := range []struct {
		name, input, status, reason string
	}{
		{"protected mixed quotes", "message: 'He said \"hello\"'\n", "unchanged", ""},
		{"invalid yaml", "value: [\n", "skipped", "invalid YAML"},
		{"trailing flow gap at eof", "value: [one,\n\n]", "skipped", "preserving trailing blank gap at EOF would change final-newline state"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, stderr, code := invokeFormat(t, test.input, "format", "--root", root, "--stdin-filename", path, "-")
			if code != 0 || stderr != "" || got.SchemaVersion != 1 || got.Path != "roles/demo/defaults/main.yml" || len(got.SourceSHA256) != 64 || got.Status != test.status || got.Edits == nil || len(got.Edits) != 0 || (test.reason != "" && !strings.Contains(got.Reason, test.reason)) || (test.reason == "" && got.Reason != "") {
				t.Fatalf("code=%d stderr=%q response=%+v", code, stderr, got)
			}
		})
	}
}

func TestFormatLintFixesUsesSnapshotAndRemainsConservative(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "roles", "demo", "defaults", "main.yml")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	disk := "value: disk\n"
	if err := os.WriteFile(path, []byte(disk), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "saltbox.yml"), []byte("- hosts: all\n"), 0600); err != nil {
		t.Fatal(err)
	}

	input := "v: \"{{ a\n | combine(b) }}\"\n"
	response, stderr, code := invokeFormat(t, input, "format", "--mode", "lint-fixes", "--root", root, "--stdin-filename", path, "-")
	if code != 0 || stderr != "" || response.Status != "ready" || response.Path != "roles/demo/defaults/main.yml" || response.SourceSHA256 != "b763a98d390ddd84e68a0e80ebd8b77bfde05227cf893e6b8589b0ecc2e2c8a4" {
		t.Fatalf("code=%d stderr=%q response=%+v", code, stderr, response)
	}
	if got, want := applyWireEdits(t, input, response.Edits), "v: \"{{ a\n       | combine(b) }}\"\n"; got != want {
		t.Fatalf("fixed=%q want=%q", got, want)
	}
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != disk {
		t.Fatalf("lint-fixes wrote source: %q %v", actual, err)
	}

	quoteOnly := "value: 'hello'\n"
	canonical, canonicalErr, canonicalCode := invokeFormat(t, quoteOnly, "format", "--root", root, "--stdin-filename", path, "-")
	lintFixes, lintErr, lintCode := invokeFormat(t, quoteOnly, "format", "--mode", "lint-fixes", "--root", root, "--stdin-filename", path, "-")
	if canonicalCode != 0 || canonicalErr != "" || canonical.Status != "ready" || lintCode != 0 || lintErr != "" || lintFixes.Status != "unchanged" || len(lintFixes.Edits) != 0 {
		t.Fatalf("canonical=%+v/%d/%q lint-fixes=%+v/%d/%q", canonical, canonicalCode, canonicalErr, lintFixes, lintCode, lintErr)
	}

	combined := "################################\n# Settings\n################################\nv: \"{{ a\n | combine(b) }}\"\n"
	combinedPlan, combinedErr, combinedCode := invokeFormat(t, combined, "format", "--mode", "lint-fixes", "--root", root, "--stdin-filename", path, "-")
	if combinedCode != 0 || combinedErr != "" || combinedPlan.Status != "ready" || len(combinedPlan.Edits) < 2 {
		t.Fatalf("combined plan=%+v/%d/%q", combinedPlan, combinedCode, combinedErr)
	}
	if got, want := applyWireEdits(t, combined, combinedPlan.Edits), "################################\n# Settings\n################################\n\nv: \"{{ a\n       | combine(b) }}\"\n"; got != want {
		t.Fatalf("combined fixed=%q want=%q", got, want)
	}
}

type readTrap struct{ read bool }

func (r *readTrap) Read([]byte) (int, error) {
	r.read = true
	return 0, errors.New("stdin was read")
}

func TestFormatValidatesArgumentsModeRootAndCancellationBeforeStdin(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "inside.yml")
	outside := filepath.Join(t.TempDir(), "outside.yml")
	for _, test := range []struct {
		name string
		args []string
	}{
		{"missing selection", []string{"format", "--root", root, "--stdin-filename", inside}},
		{"wrong selection", []string{"format", "--root", root, "--stdin-filename", inside, inside}},
		{"duplicate selection", []string{"format", "--root", root, "--stdin-filename", inside, "-", "-"}},
		{"missing filename", []string{"format", "--root", root, "-"}},
		{"unknown mode", []string{"format", "--mode", "future", "--root", root, "--stdin-filename", inside, "-"}},
		{"missing root", []string{"format", "--root", filepath.Join(root, "missing"), "--stdin-filename", inside, "-"}},
		{"outside root", []string{"format", "--root", root, "--stdin-filename", outside, "-"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			in := &readTrap{}
			var out, stderr bytes.Buffer
			code := Run(t.Context(), test.args, Streams{In: in, Out: &out, Err: &stderr}, "test")
			if code != 2 || out.Len() != 0 || stderr.Len() == 0 || in.read {
				t.Fatalf("code=%d stdout=%q stderr=%q read=%v", code, &out, &stderr, in.read)
			}
		})
	}

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	in := &readTrap{}
	var out, stderr bytes.Buffer
	code := Run(ctx, []string{"format", "--root", root, "--stdin-filename", inside, "-"}, Streams{In: in, Out: &out, Err: &stderr}, "test")
	if code != 2 || out.Len() != 0 || !strings.Contains(stderr.String(), context.Canceled.Error()) || in.read {
		t.Fatalf("cancellation code=%d stdout=%q stderr=%q read=%v", code, &out, &stderr, in.read)
	}
}

func TestFormatReportsReadAndWriteFailuresOnErrorChannel(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "input.yml")
	code, out, stderr := func() (int, string, string) {
		var stdout, errorOutput bytes.Buffer
		code := Run(t.Context(), []string{"format", "--root", root, "--stdin-filename", path, "-"}, Streams{In: errReader{}, Out: &stdout, Err: &errorOutput}, "test")
		return code, stdout.String(), errorOutput.String()
	}()
	if code != 2 || out != "" || !strings.Contains(stderr, "read stdin") {
		t.Fatalf("read failure code=%d stdout=%q stderr=%q", code, out, stderr)
	}

	rootCommand := NewRootCommand(Streams{In: strings.NewReader("value: ok\n"), Out: failWriter{}, Err: io.Discard}, "test")
	rootCommand.SetArgs([]string{"format", "--root", root, "--stdin-filename", path, "-"})
	if err := rootCommand.ExecuteContext(t.Context()); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("write failure=%v", err)
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestFormatLintStructuralFixMatchesCheck(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "tasks", "main.yml")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	input := "- name: Example\r\n  ansible.builtin.debug: {msg: ok}\r\n  when: \"café == '🌨'\" # keep\r\n"
	want := "- name: Example\r\n  ansible.builtin.debug: {msg: ok}\r\n  when: \"(café == '🌨')\" # keep\r\n"
	if err := os.WriteFile(path, []byte(input), 0640); err != nil {
		t.Fatal(err)
	}
	response, stderr, code := invokeFormat(t, input, "format", "--mode", "lint-fixes", "--root", root, "--stdin-filename", path, "-")
	if code != 0 || stderr != "" || response.Status != "ready" || applyWireEdits(t, input, response.Edits) != want {
		t.Fatalf("format: %+v %s %d", response, stderr, code)
	}
	disk, err := os.ReadFile(path)
	if err != nil || string(disk) != input {
		t.Fatal("format wrote its source")
	}
	for _, edit := range response.Edits {
		line, column := wirePosition([]byte(input), edit.Span.Start)
		if edit.Range.Start.Line != line || edit.Range.Start.Column != column {
			t.Fatalf("start coordinate: %+v", edit)
		}
		line, column = wirePosition([]byte(input), edit.Span.End)
		if edit.Range.End.Line != line || edit.Range.End.Column != column {
			t.Fatalf("end coordinate: %+v", edit)
		}
	}
	code, _, stderr = invoke(t, "", "check", "--fix", "--root", root, "--", path)
	if code != 0 || stderr != "" {
		t.Fatalf("check fix: %d %q", code, stderr)
	}
	disk, err = os.ReadFile(path)
	if err != nil || string(disk) != want {
		t.Fatalf("check diverged: %q %v", disk, err)
	}
}

func TestFormatLintKeepsInlineNestedElseConditional(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "values.yml")
	input := "v: \"{{ a\n    if flag\n    else fn(b if z else c) }}\"\n"
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	response, stderr, code := invokeFormat(t, input, "format", "--mode", "lint-fixes", "--root", root, "--stdin-filename", path, "-")
	if code != 0 || stderr != "" || response.Status != "unchanged" || len(response.Edits) != 0 {
		t.Fatalf("valid layout changed: %+v %s %d", response, stderr, code)
	}
}

func TestFormatLintRefusesUnboundedHeaderComments(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "roles", "demo", "defaults", "main.yml")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	input := "# Author(s): salty\n# GNU General Public License v3.0\n# URL: https://example.com\n# Title: Demo\n\n# User-facing documentation for demo_role_enabled\ndemo_role_enabled: true\n"
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	response, stderr, code := invokeFormat(t, input, "format", "--mode", "lint-fixes", "--root", root, "--stdin-filename", path, "-")
	if code != 0 || stderr != "" || response.Status != "unchanged" || len(response.Edits) != 0 {
		t.Fatalf("ambiguous comments moved: %+v %s %d", response, stderr, code)
	}
	disk, err := os.ReadFile(path)
	if err != nil || string(disk) != input {
		t.Fatalf("source written: %q %v", disk, err)
	}
}
