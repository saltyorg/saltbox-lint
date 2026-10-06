package report

import (
	"bytes"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

func TestStatisticsCountUniqueFixContent(t *testing.T) {
	source, _ := lint.Parse("input.yml", []byte("v: true\n"))
	project := &lint.Project{Sources: map[string]*lint.Source{"input.yml": source}, Selected: map[string]bool{"input.yml": true}}
	fix := &lint.Fix{Message: "shared", Edits: []lint.Edit{{Span: lint.Span{Start: 3, End: 7}, Text: "false"}}}
	copyFix := &lint.Fix{Message: fix.Message, Edits: append([]lint.Edit(nil), fix.Edits...)}
	ds := []lint.Diagnostic{{Path: "input.yml", RuleID: "one", Fix: fix}, {Path: "input.yml", RuleID: "two", Fix: fix}, {Path: "input.yml", RuleID: "two", Fix: copyFix}}
	counts := CountStatistics(project, ds)
	if counts.Fixes != 1 || counts.Findings != 3 || len(counts.Rules) != 2 || counts.Rules[1].Count != 2 {
		t.Fatalf("shared fixes counted as references: %+v", counts)
	}
}

func TestStatisticsPreserveSARIFSchemaAndBytes(t *testing.T) {
	project, ds := sample()
	_, baseline := renderSARIF(t, project, ds)
	var out bytes.Buffer
	statistics := &Statistics{SchemaVersion: 1, Status: "complete", DurationUnit: "milliseconds"}
	if err := Render(&out, project, ds, Options{Format: "sarif", Version: "1.2.3", Statistics: statistics}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out.Bytes(), baseline) {
		t.Fatal("statistics changed SARIF bytes")
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(out.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if err := sarifValidator(t).Validate(value); err != nil {
		t.Fatal(err)
	}
}
