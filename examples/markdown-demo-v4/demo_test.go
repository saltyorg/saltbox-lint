package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDemoDocumentUsesCompleteFixturesAtReportedLocations(t *testing.T) {
	markdown, blocks, err := loadDemoDocument()
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 6 {
		t.Fatalf("code blocks = %d, want 6", len(blocks))
	}
	for _, want := range []string{
		"## roles/web/tasks/main.yml",
		"## roles/web/defaults/main.yml",
		"roles/web/tasks/main.yml:102:9",
		"roles/web/tasks/main.yml:148:7",
		"roles/web/defaults/main.yml:10:1",
		"**3 errors in 2 files.** An automatic fix is available for **1 finding**.",
	} {
		if !strings.Contains(markdown, want) {
			t.Errorf("demo Markdown missing %q", want)
		}
	}
	if got := strings.Count(markdown, "```saltbox-ansible\n"); got != 6 {
		t.Fatalf("fenced blocks = %d, want 6", got)
	}

	assertSourcePosition(t, blocks[0].Source, 102, 9, "(")
	assertSourcePosition(t, blocks[2].Source, 148, 7, "restart_web")
	assertSourcePosition(t, blocks[4].Source, 10, 1, "web_role_enabled")
	for i, block := range blocks {
		if lineCount(block.Source) <= block.LastLine {
			t.Errorf("block %d source has %d lines; displayed excerpt ends at %d", i+1, lineCount(block.Source), block.LastLine)
		}
		excerpt, err := sourceLines(block.Source, block.FirstLine, block.LastLine)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(markdown, "```saltbox-ansible\n"+excerpt+"```") {
			t.Errorf("block %d excerpt is not sourced byte-for-byte from its complete fixture", i+1)
		}
	}
}

func assertSourcePosition(t *testing.T, source string, line, column int, want string) {
	t.Helper()
	lines := strings.Split(source, "\n")
	if line > len(lines) {
		t.Fatalf("source has %d lines, want line %d", len(lines), line)
	}
	runes := []rune(lines[line-1])
	if column < 1 || column > len(runes) {
		t.Fatalf("line %d has %d columns, want column %d", line, utf8.RuneCountInString(lines[line-1]), column)
	}
	if !strings.HasPrefix(string(runes[column-1:]), want) {
		t.Fatalf("source %d:%d = %q, want prefix %q", line, column, string(runes[column-1:]), want)
	}
}

func lineCount(source string) int {
	return len(strings.Split(strings.TrimSuffix(source, "\n"), "\n"))
}
