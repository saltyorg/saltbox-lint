package lint

import (
	"strings"
	"testing"
)

func TestParseTaggedBlockCollectionsPreservesRepeatedScalarLocations(t *testing.T) {
	for _, newline := range []string{"\n", "\r\n"} {
		data := strings.ReplaceAll("v: !!map\n  same: same\nseq: !!seq\n  - same\n", "\n", newline)
		source, diagnostics := Parse("vars.yml", []byte(data))
		if len(diagnostics) > 0 {
			t.Fatalf("parse: %v", diagnostics)
		}
		mapping := source.Documents[0].Get("v")
		if mapping.Tag != "!!map" || mapping.Kind != "mapping" {
			t.Fatalf("tagged mapping: %+v", mapping)
		}
		key, value := mapping.Entries[0].Key, mapping.Entries[0].Value
		if string(source.Data[key.Span.Start:key.Span.End]) != "same" || string(source.Data[value.Span.Start:value.Span.End]) != "same" || key.Span.End >= value.Span.Start {
			t.Fatalf("repeated scalar locations: %+v %+v", key, value)
		}
		sequence := source.Documents[0].Get("seq")
		if sequence.Tag != "!!seq" || sequence.Kind != "sequence" || sequence.Items[0].Value != "same" {
			t.Fatalf("tagged sequence: %+v", sequence)
		}
	}
}
