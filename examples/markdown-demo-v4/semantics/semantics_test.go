package semantics_test

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"

	"saltbox-lint-markdown-demo-v4/catalog"
	"saltbox-lint-markdown-demo-v4/semantics"
)

type oracleCase struct {
	Name   string        `json:"name"`
	Source string        `json:"source"`
	Tokens []oracleToken `json:"tokens"`
}

type oracleToken struct {
	Line      int      `json:"line"`
	Column    int      `json:"column"`
	Length    int      `json:"length"`
	Text      string   `json:"text"`
	Type      string   `json:"type"`
	Modifiers []string `json:"modifiers"`
}

type oracleResult struct {
	Tokens []oracleToken `json:"tokens"`
}

func TestClassifyMatchesUpstreamOracle(t *testing.T) {
	registry, err := catalog.Load()
	if err != nil {
		t.Fatalf("load catalog: %v", err)
	}

	data, err := os.ReadFile("testdata/upstream-semantic-cases.json")
	if err != nil {
		t.Fatalf("read oracle: %v", err)
	}
	var cases []oracleCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("decode oracle: %v", err)
	}
	if len(cases) != 26 {
		t.Fatalf("oracle has %d cases, want 26", len(cases))
	}

	for _, test := range cases {
		t.Run(test.Name, func(t *testing.T) {
			got, err := semantics.Classify(test.Source, semantics.Options{Catalog: registry})
			if test.Name == "malformed_yaml" {
				if err == nil {
					t.Fatalf("Classify() error = nil, want parser recovery limitation")
				}
				if !strings.Contains(err.Error(), "parse YAML for semantic classification") {
					t.Fatalf("Classify() error lacks parser context: %v", err)
				}
				if len(got) != 0 {
					t.Fatalf("Classify() returned untrustworthy partial tokens: %#v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("Classify() error = %v", err)
			}
			validateTokenRanges(t, test.Source, got)
			want := oracleTokens(t, test.Source, test.Tokens)
			if !slices.EqualFunc(got, want, equalToken) {
				t.Fatalf("Classify() mismatch\n got: %#v\nwant: %#v", got, want)
			}
		})
	}
}

func TestClassifyUsesExplicitMetadataCollectionsBeforeInlineCollections(t *testing.T) {
	registry, err := catalog.Load()
	if err != nil {
		t.Fatalf("load catalog: %v", err)
	}
	const source = "- collections: [community.general]\n  docker_container:\n    name: demo\n"
	want := []semantics.Token{
		{Start: 2, End: 13, Type: semantics.Keyword},
		{Start: 37, End: 53, Type: semantics.Class},
		{Start: 59, End: 63, Type: semantics.Method},
	}
	got, err := semantics.Classify(source, semantics.Options{
		Catalog:     registry,
		Collections: []string{"community.docker"},
	})
	if err != nil {
		t.Fatalf("Classify() error = %v", err)
	}
	if !slices.EqualFunc(got, want, equalToken) {
		t.Fatalf("Classify() mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestClassifyRequiresCatalogOnlyForModuleResolution(t *testing.T) {
	const source = "debug:\n  msg: hello\n"
	want := []semantics.Token{
		{Start: 0, End: 5, Type: semantics.Property, Modifiers: []semantics.Modifier{semantics.Definition}},
		{Start: 9, End: 12, Type: semantics.Property, Modifiers: []semantics.Modifier{semantics.Definition}},
	}
	got, err := semantics.Classify(source, semantics.Options{})
	if err != nil {
		t.Fatalf("Classify() error = %v", err)
	}
	if !slices.EqualFunc(got, want, equalToken) {
		t.Fatalf("Classify() mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestClassifyMatchesFullDemoOracles(t *testing.T) {
	registry, err := catalog.Load()
	if err != nil {
		t.Fatalf("load catalog: %v", err)
	}
	tests := []struct {
		name   string
		source string
		oracle string
	}{
		{"tasks", "testdata/demo-tasks.yml", "testdata/demo-tasks-semantic-oracle.json"},
		{"defaults", "testdata/demo-defaults.yml", "testdata/demo-defaults-semantic-oracle.json"},
		{"decorated scalar keys", "testdata/decorated-scalar-keys.yml", "testdata/decorated-scalar-keys-oracle.json"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			source, err := os.ReadFile(test.source)
			if err != nil {
				t.Fatalf("read source: %v", err)
			}
			data, err := os.ReadFile(test.oracle)
			if err != nil {
				t.Fatalf("read oracle: %v", err)
			}
			var oracle oracleResult
			if err := json.Unmarshal(data, &oracle); err != nil {
				t.Fatalf("decode oracle: %v", err)
			}
			got, err := semantics.Classify(string(source), semantics.Options{Catalog: registry})
			if err != nil {
				t.Fatalf("Classify() error = %v", err)
			}
			validateTokenRanges(t, string(source), got)
			want := oracleTokens(t, string(source), oracle.Tokens)
			if !slices.EqualFunc(got, want, equalToken) {
				t.Fatalf("Classify() mismatch\n got: %#v\nwant: %#v", got, want)
			}
		})
	}
}

func TestClassifyUsesCompleteUpstreamKeywordTables(t *testing.T) {
	play := []string{
		"any_errors_fatal", "become", "become_exe", "become_flags", "become_method", "become_user",
		"check_mode", "collections", "connection", "debugger", "diff", "environment", "fact_path",
		"force_handlers", "gather_facts", "gather_subset", "gather_timeout", "handlers", "hosts",
		"ignore_errors", "ignore_unreachable", "max_fail_percentage", "module_defaults", "name", "no_log",
		"order", "port", "post_tasks", "pre_tasks", "remote_user", "roles", "run_once", "serial",
		"strategy", "tags", "tasks", "throttle", "timeout", "vars", "vars_files", "vars_prompt",
	}
	block := []string{
		"always", "any_errors_fatal", "become", "become_exe", "become_flags", "become_method", "become_user",
		"block", "check_mode", "collections", "connection", "debugger", "delegate_facts", "delegate_to",
		"diff", "environment", "ignore_errors", "ignore_unreachable", "module_defaults", "name", "no_log",
		"notify", "port", "remote_user", "rescue", "run_once", "tags", "throttle", "timeout", "vars", "when",
	}
	role := []string{
		"any_errors_fatal", "become", "become_exe", "become_flags", "become_method", "become_user",
		"check_mode", "collections", "connection", "debugger", "delegate_facts", "delegate_to", "diff",
		"environment", "ignore_errors", "ignore_unreachable", "module_defaults", "name", "no_log", "port",
		"remote_user", "run_once", "tags", "throttle", "timeout", "vars", "when",
	}
	task := []string{
		"action", "any_errors_fatal", "args", "async", "become", "become_exe", "become_flags",
		"become_method", "become_user", "changed_when", "check_mode", "collections", "connection", "debugger",
		"delay", "delegate_facts", "delegate_to", "diff", "environment", "failed_when", "ignore_errors",
		"ignore_unreachable", "local_action", "loop", "loop_control", "module_defaults", "name", "no_log",
		"notify", "poll", "port", "register", "remote_user", "retries", "run_once", "tags", "throttle",
		"timeout", "until", "vars", "when", "listen", "with_unavailable_lookup",
	}

	tests := []struct {
		name   string
		keys   []string
		source string
		skip   int
	}{
		{"play", play, keywordMapping(play, "hosts", "- ", "  "), 0},
		{"block", block, keywordMapping(block, "block", "- ", "  "), 0},
		{"role", role, "- hosts: all\n  roles:\n    - role: sample\n" + indentedKeys(role, "      "), 3},
		{"task", task, keywordMapping(task, "action", "- ", "  "), 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := semantics.Classify(test.source, semantics.Options{})
			if err != nil {
				t.Fatalf("Classify() error = %v", err)
			}
			if len(got) != len(test.keys)+test.skip {
				t.Fatalf("got %d tokens, want %d: %#v", len(got), len(test.keys)+test.skip, got)
			}
			for _, token := range got[test.skip:] {
				if token.Type != semantics.Keyword {
					t.Fatalf("key %q type = %q, want keyword", test.source[token.Start:token.End], token.Type)
				}
			}
		})
	}
}

func keywordMapping(keys []string, required, firstIndent, restIndent string) string {
	var source strings.Builder
	fmt.Fprintf(&source, "%s%s: null\n", firstIndent, required)
	for _, key := range keys {
		if key != required {
			fmt.Fprintf(&source, "%s%s: null\n", restIndent, key)
		}
	}
	return source.String()
}

func indentedKeys(keys []string, indent string) string {
	var source strings.Builder
	for _, key := range keys {
		fmt.Fprintf(&source, "%s%s: null\n", indent, key)
	}
	return source.String()
}

func oracleTokens(t *testing.T, source string, tokens []oracleToken) []semantics.Token {
	t.Helper()
	want := make([]semantics.Token, 0, len(tokens))
	for _, token := range tokens {
		start := utf16PositionToByte(t, source, token.Line, token.Column)
		end := utf16PositionToByte(t, source, token.Line, token.Column+token.Length)
		if source[start:end] != token.Text {
			t.Fatalf("oracle range [%d:%d] contains %q, want %q", start, end, source[start:end], token.Text)
		}
		modifiers := make([]semantics.Modifier, len(token.Modifiers))
		for i, modifier := range token.Modifiers {
			modifiers[i] = semantics.Modifier(modifier)
		}
		want = append(want, semantics.Token{
			Start:     start,
			End:       end,
			Type:      semantics.TokenType(token.Type),
			Modifiers: modifiers,
		})
	}
	return want
}

func utf16PositionToByte(t *testing.T, source string, line, column int) int {
	t.Helper()
	if line < 1 || column < 1 {
		t.Fatalf("invalid UTF-16 position %d:%d", line, column)
	}
	lineStart := 0
	for range line - 1 {
		next := strings.IndexByte(source[lineStart:], '\n')
		if next < 0 {
			t.Fatalf("line %d is outside source", line)
		}
		lineStart += next + 1
	}
	wantUnits := column - 1
	units := 0
	for offset := lineStart; offset < len(source); {
		if units == wantUnits {
			return offset
		}
		r, size := utf8.DecodeRuneInString(source[offset:])
		if r == '\n' {
			break
		}
		units += len(utf16.Encode([]rune{r}))
		offset += size
	}
	if units == wantUnits {
		return lineStart + len(strings.SplitN(source[lineStart:], "\n", 2)[0])
	}
	t.Fatalf("UTF-16 column %d is outside line %d", column, line)
	return 0
}

func equalToken(a, b semantics.Token) bool {
	return a.Start == b.Start && a.End == b.End && a.Type == b.Type && slices.Equal(a.Modifiers, b.Modifiers)
}

func validateTokenRanges(t *testing.T, source string, tokens []semantics.Token) {
	t.Helper()
	seen := make(map[[2]int]struct{}, len(tokens))
	previousEnd := 0
	for _, token := range tokens {
		if token.Start < previousEnd || token.Start < 0 || token.End <= token.Start || token.End > len(source) {
			t.Fatalf("invalid or unordered token range [%d:%d] after byte %d", token.Start, token.End, previousEnd)
		}
		rangeKey := [2]int{token.Start, token.End}
		if _, duplicate := seen[rangeKey]; duplicate {
			t.Fatalf("duplicate token range [%d:%d]", token.Start, token.End)
		}
		seen[rangeKey] = struct{}{}
		previousEnd = token.End
	}
}
