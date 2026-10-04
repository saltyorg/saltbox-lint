package yamlindex_test

import (
	"bytes"
	"testing"
	"unicode/utf8"

	"github.com/goccy/go-yaml/lexer"
	"github.com/goccy/go-yaml/token"
	"github.com/saltyorg/saltbox-lint/internal/fuzztest"
	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/saltyorg/saltbox-lint/yamlindex"
)

func FuzzSourceCoordinates(f *testing.F) {
	for _, seed := range fuzztest.Seeds(f, "../lint/testdata/preservation") {
		f.Add(seed, 0)
	}
	f.Fuzz(func(t *testing.T, data []byte, offset int) {
		if !fuzztest.Bounded(data) {
			return
		}
		// Raw parsing avoids tying coordinate acceptance to YAML syntax.
		source, _ := lint.Parse("raw.j2", data)
		starts := []int{0}
		for i, b := range data {
			if b == '\n' {
				starts = append(starts, i+1)
			}
		}
		position := source.Position(offset)
		if position.Line < 1 || position.Column < 1 {
			t.Fatalf("invalid position: %+v", position)
		}
		// Invalid bytes deliberately use code-point counting of RuneError units;
		// there is no claim that an arbitrary byte offset is a Unicode boundary.
		clamped := min(max(offset, 0), len(data))
		start := bytes.LastIndexByte(data[:clamped], '\n') + 1
		if position.Line != bytes.Count(data[:clamped], []byte{'\n'})+1 || position.Column != utf8.RuneCount(data[start:clamped])+1 {
			t.Fatal("position does not honor the documented clamping/counting contract")
		}
		if utf8.Valid(data) {
			// Check every supported boundary, rather than hoping mutation selects
			// an astral rune or the end of a CRLF line as the sampled offset.
			for i := 0; i <= len(data); i++ {
				if !fuzztest.Boundary(data, i) {
					continue
				}
				p := source.Position(i)
				got := yamlindex.RuneOffset(string(data), starts, &token.Position{Line: p.Line, Column: p.Column})
				if got != i {
					t.Fatalf("byte %d -> %+v -> byte %d", i, p, got)
				}
			}
		}
		locations, err := yamlindex.LocateTokens(string(data), lexer.Tokenize(string(data)))
		if err == nil {
			for _, location := range locations {
				fuzztest.Span(t, data, location.Start, location.End)
				if location.OriginEnd != 0 && (location.OriginEnd < location.End || location.OriginEnd > len(data)) {
					t.Fatalf("invalid origin extent: %+v", location)
				}
			}
		}
	})
}
