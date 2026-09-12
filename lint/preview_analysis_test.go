package lint

import "testing"

func TestPreparedPreviewOwnsValidatedSourceIndex(t *testing.T) {
	source, ds := Parse("vars.yml", []byte("value: old\n"))
	if len(ds) != 0 {
		t.Fatal(ds)
	}
	diagnostic := Diagnostic{Path: source.Path, Preview: &Preview{Edits: []Edit{{Span: Span{7, 10}, Text: "new"}}}}
	prepared, ok := PreparePreview(source, diagnostic)
	if !ok || prepared.SourceIndex == nil {
		t.Fatal("missing validated preview analysis")
	}
	if prepared.SourceIndex.Source() != "value: new\n" {
		t.Fatalf("indexed %q", prepared.SourceIndex.Source())
	}
	source.Data[0] = 'X'
	prepared.Change.Before[0] = 'Y'
	prepared.Change.After[0] = 'Z'
	if prepared.SourceIndex.Source() != "value: new\n" {
		t.Fatal("preview byte mutation changed shared analysis")
	}
	if diagnostic.Fix != nil {
		t.Fatal("preview gained fix authority")
	}
}

func TestPreparedPreviewRejectsInvalidCandidate(t *testing.T) {
	source, _ := Parse("vars.yml", []byte("value: old\n"))
	candidate, ok := PreparePreview(source, Diagnostic{Path: source.Path, Preview: &Preview{Edits: []Edit{{Span: Span{7, 10}, Text: "["}}}})
	if ok || candidate.SourceIndex != nil {
		t.Fatal("invalid candidate supplied reusable validation")
	}
}

func TestPreparedPreviewRetainsMalformedSourceDisplayAuthority(t *testing.T) {
	source, diagnostics := Parse("vars.yml", []byte("value: [\n"))
	if len(diagnostics) == 0 {
		t.Fatal("fixture must be invalid")
	}
	diagnostic := Diagnostic{Path: source.Path, Preview: &Preview{Edits: []Edit{{Span: Span{7, 8}, Text: "[fixed]"}}}}
	prepared, ok := PreparePreview(source, diagnostic)
	if !ok || prepared.SourceIndex != nil || string(prepared.Change.After) != "value: [fixed]\n" {
		t.Fatalf("preview=%+v ok=%v", prepared, ok)
	}
	if diagnostic.Fix != nil {
		t.Fatal("display-only proposal acquired a fixer")
	}
}
