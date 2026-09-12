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
