package yamlindex

import (
	"github.com/goccy/go-yaml/lexer"
	"strings"
	"testing"
)

func TestIndexPreservesDecoratedScalarRangesAndOwnsTokenState(t *testing.T) {
	source := "😀: hello\r\n? !unsafe &key \"\\u0061\"\r\n: value\r\n"
	tokens := lexer.Tokenize(source)
	index, err := FromTokens(source, tokens)
	if err != nil {
		t.Fatal(err)
	}
	for _, check := range []struct {
		line, column int
		value, raw   string
	}{{1, 1, "😀", "😀"}, {2, 3, "a", `"\u0061"`}} {
		start, end, ok := index.ScalarRange(check.line, check.column, check.value)
		if !ok || source[start:end] != check.raw {
			t.Fatalf("range = [%d:%d] %v, want %q", start, end, ok, check.raw)
		}
	}
	for _, tok := range tokens {
		tok.Value = "changed"
		tok.Origin = "changed"
		if tok.Position != nil {
			tok.Position.Line = 999
		}
	}
	start, end, ok := index.ScalarRange(1, 1, "😀")
	if !ok || source[start:end] != "😀" {
		t.Fatal("mutable lexer tokens changed published index")
	}
	if index.Source() != source {
		t.Fatal("source changed")
	}
	if _, _, ok := index.ScalarRange(1, 1, "wrong"); ok {
		t.Fatal("value mismatch accepted")
	}
}

func TestIndexRejectsUnlocatableOrigins(t *testing.T) {
	tokens := lexer.Tokenize("a: x\n")
	_, err := FromTokens("b: x\n", tokens)
	if err == nil || !strings.Contains(err.Error(), "cannot locate original YAML token") {
		t.Fatalf("error=%v", err)
	}
}

func TestIndexRetainsScalarProjectionOfLexicalLocations(t *testing.T) {
	for _, tt := range []struct {
		source       string
		line, column int
		value        string
		start, end   int
		ok           bool
	}{
		{"x: \"\\u0061\\\"b\"\r\ny: \"\\x61\"\r\n", 1, 4, "a\"b", 3, 14, true},
		{"x: \"\\u0061\\\"b\"\r\ny: \"\\x61\"\r\n", 2, 4, "a", 19, 25, true},
		{"x: !unsafe &a 'same'\ny: 'same'\n", 1, 4, "same", 14, 20, true},
		{"x: !unsafe &a 'same'\ny: 'same'\n", 2, 4, "same", 24, 30, true},
		{"x: >-\r\n  same\r\n  same\r\ny: |\n  hi\n\n", 3, 0, "same same", 9, 21, true},
		{"x: >-\r\n  same\r\n  same\r\ny: |\n  hi\n\n", 6, 1, "hi\n", 30, 32, true},
		{"x: |\n\ny:\n", 3, 1, "", 6, 6, false},
		{"x: |\n\ny:\n", 3, 1, "y", 6, 6, false}, // first token at a coordinate wins
		{"x: \"\"\ny: ''\n", 1, 4, "", 3, 5, true},
	} {
		index, err := Scan(tt.source)
		if err != nil {
			t.Fatal(err)
		}
		start, end, ok := index.ScalarRange(tt.line, tt.column, tt.value)
		if start != tt.start || end != tt.end || ok != tt.ok {
			t.Errorf("%q at %d:%d: %d:%d %v, want %d:%d %v", tt.source, tt.line, tt.column, start, end, ok, tt.start, tt.end, tt.ok)
		}
	}
}
