package lint

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/goccy/go-yaml/ast"
	"github.com/goccy/go-yaml/lexer"
	"github.com/goccy/go-yaml/parser"
	"github.com/goccy/go-yaml/token"
	"github.com/saltyorg/saltbox-lint/yamlindex"
)

// This frozen contract was captured from the published v1.19.2 parser before
// the local sibling-accumulation patch. It covers raw syntax and original-byte
// adaptation independently, including recursive footer ownership.
func TestParserPublishedContract(t *testing.T) {
	data, err := os.ReadFile("testdata/parser-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Source    string
		AllowDuplicates bool
		Expected        json.RawMessage
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			got, err := json.Marshal(parserContract(t, tc.Source, tc.AllowDuplicates))
			if err != nil {
				t.Fatal(err)
			}
			var expected bytes.Buffer
			if err := json.Compact(&expected, tc.Expected); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, expected.Bytes()) {
				t.Fatalf("published parser contract changed\ngot: %s\nwant: %s", got, expected.Bytes())
			}
		})
	}
}

type contractVisitor struct{ nodes *[]map[string]any }

func (v contractVisitor) Visit(n ast.Node) ast.Visitor {
	if n == nil {
		return nil
	}
	r := map[string]any{"type": n.Type().String(), "path": n.GetPath(), "token": contractToken(n.GetToken())}
	if c := n.GetComment(); c != nil {
		r["comment"] = c.String()
		r["comment_path"] = c.GetPath()
	}
	var foot *ast.CommentGroupNode
	switch n := n.(type) {
	case *ast.MappingNode:
		foot = n.FootComment
	case *ast.MappingValueNode:
		foot = n.FootComment
	case *ast.SequenceNode:
		foot = n.FootComment
	}
	if foot != nil {
		r["foot"] = foot.String()
		r["foot_path"] = foot.GetPath()
	}
	*v.nodes = append(*v.nodes, r)
	return v
}
func contractToken(t *token.Token) any {
	if t == nil {
		return nil
	}
	return map[string]any{"type": t.Type.String(), "value": t.Value, "origin": t.Origin, "position": t.Position}
}
func parserContract(t *testing.T, text string, duplicates bool) map[string]any {
	t.Helper()
	tokens := lexer.Tokenize(text)
	index, indexErr := yamlindex.FromTokens(text, tokens)
	indexed := []any{}
	if indexErr == nil {
		if index.Source() != text {
			t.Fatal("index changed original source")
		}
		for _, tk := range tokens {
			start, end, ok := index.ScalarRange(tk.Position.Line, tk.Position.Column, tk.Value)
			indexed = append(indexed, map[string]any{"start": start, "end": end, "ok": ok})
		}
	}
	options := []parser.Option{}
	if duplicates {
		options = append(options, parser.AllowDuplicateMapKey())
	}
	file, err := parser.Parse(tokens, parser.ParseComments, options...)
	r := map[string]any{"indexed": indexed, "tokens": []any{}}
	if indexErr != nil {
		r["index_error"] = indexErr.Error()
	}
	for _, tk := range tokens {
		r["tokens"] = append(r["tokens"].([]any), contractToken(tk))
	}
	if err != nil {
		r["error"] = err.Error()
	} else {
		nodes := []map[string]any{}
		for _, doc := range file.Docs {
			ast.Walk(contractVisitor{&nodes}, doc)
		}
		r["nodes"] = nodes
		r["rendered"] = file.String()
	}
	source, diagnostics := Parse("vars.yml", []byte(text))
	if string(source.Data) != text {
		t.Fatal("Parse changed original bytes")
	}
	r["documents"] = source.Documents
	r["diagnostics"] = diagnostics
	r["comments"] = source.YAMLComments()
	positions := []Position{}
	for offset := range len(text) + 1 {
		positions = append(positions, source.Position(offset))
	}
	r["positions"] = positions
	if len(diagnostics) == 0 {
		edits, err := FormattingEdits(source)
		if err != nil {
			t.Fatal(err)
		}
		after := applyEdits(source.Data, edits)
		if !verifiedCandidate(source, after) {
			t.Fatal("formatting changed semantics or tokens")
		}
		fixed, ds := Parse("vars.yml", after)
		if len(ds) != 0 {
			t.Fatal(ds)
		}
		again, err := FormattingEdits(fixed)
		if err != nil || len(again) != 0 {
			t.Fatalf("formatting is not idempotent: %v %v", again, err)
		}
		r["formatted"] = string(after)
	}
	return r
}

func TestWideMapAllocationBound(t *testing.T) {
	// Measure the real lint entry point. A linear byte budget catches the
	// published parser's quadratic suffix copies without timing assertions.
	const entries = 4096
	var text strings.Builder
	for i := range entries {
		fmt.Fprintf(&text, "entry_%d: [1, 2, 3, 4, 5]\n", i)
	}
	data := []byte(text.String())
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	source, ds := Parse("vars.yml", data)
	runtime.ReadMemStats(&after)
	if len(ds) != 0 || len(source.Documents) != 1 || len(source.Documents[0].Entries) != entries {
		t.Fatalf("wide mapping contract: %v", ds)
	}
	runtime.KeepAlive(source)
	const bytesPerEntry = 18000
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > entries*bytesPerEntry {
		t.Fatalf("wide mapping allocated %d bytes, exceeds linear budget %d", allocated, entries*bytesPerEntry)
	}
}
