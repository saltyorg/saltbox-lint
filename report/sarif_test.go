package report

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type offlineSARIFLoader struct{}

func (offlineSARIFLoader) Load(uri string) (any, error) {
	return nil, fmt.Errorf("unexpected schema load: %s", uri)
}

func sarifValidator(t *testing.T) *jsonschema.Schema {
	t.Helper()
	data, err := os.ReadFile("testdata/sarif-schema-2.1.0.json")
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprintf("%x", sha256.Sum256(data)) != "c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e" {
		t.Fatal("pinned SARIF schema changed")
	}
	resource, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	c := jsonschema.NewCompiler()
	c.UseLoader(offlineSARIFLoader{})
	if err := c.AddResource(sarifSchema, resource); err != nil {
		t.Fatal(err)
	}
	schema, err := c.Compile(sarifSchema)
	if err != nil {
		t.Fatal(err)
	}
	return schema
}

func renderSARIF(t *testing.T, p *lint.Project, ds []lint.Diagnostic) (sarifLog, []byte) {
	t.Helper()
	var out bytes.Buffer
	if err := Render(&out, p, ds, Options{Format: "sarif", Version: "1.2.3"}); err != nil {
		t.Fatal(err)
	}
	var result sarifLog
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(out.Bytes(), []byte(`"fixes"`)) || bytes.Contains(out.Bytes(), []byte("\x1b")) {
		t.Fatal("SARIF must omit optional fixes and terminal styling")
	}
	return result, slices.Clone(out.Bytes())
}

func sarifGoldenCases(t *testing.T) map[string]struct {
	p  *lint.Project
	ds []lint.Diagnostic
} {
	t.Helper()
	p, ds := sample()
	ds[0].RuleID = "jinja-layout"
	source, parse := lint.Parse("broken.yml", []byte("v: [\n"))
	parseProject := &lint.Project{Root: p.Root, Sources: map[string]*lint.Source{source.Path: source}}
	shared, sharedDiagnostics, expected := malformedExpressions(t, 2)
	shared.Root = p.Root
	changes, err := lint.PlanFixes(shared, sharedDiagnostics)
	if err != nil || len(changes) != 1 || string(changes[0].After) != expected {
		t.Fatalf("shared golden fix must pass the verifier: changes=%d err=%v", len(changes), err)
	}
	// Two findings share one verified source fix. A manual preview has no Fix.
	manual := sharedDiagnostics[0]
	manual.Fix = nil
	manual.Preview = &lint.Preview{Edits: []lint.Edit{{Span: manual.Span, Text: "manual"}}}
	sharedDiagnostics = append(sharedDiagnostics, manual)
	unusual := "folder #?/colon:%, 😀\\name.yml"
	unicode, _ := lint.Parse(unusual, []byte("v: '😀x'\r\nnext: true\r\n"))
	unicodeProject := &lint.Project{Root: p.Root, Sources: map[string]*lint.Source{unusual: unicode, "broken.yml": source}}
	unicodeDiagnostics := []lint.Diagnostic{{Path: unusual, RuleID: "jinja-layout", Severity: "warning", Message: "multiline finding", Expected: "Use the expected layout.", Span: lint.Span{Start: 8, End: 16}, Related: []lint.RelatedLocation{{Path: "broken.yml", Span: lint.Span{Start: 0, End: 1}, Message: "related source"}}}, {Path: unusual, RuleID: "yaml-syntax", Severity: "error", Message: "second rule", Span: lint.Span{Start: 8, End: 8}}}
	return map[string]struct {
		p  *lint.Project
		ds []lint.Diagnostic
	}{"clean": {p, nil}, "primary-related": {p, ds}, "parse": {parseProject, parse}, "shared-fix-preview": {shared, sharedDiagnostics}, "unicode-crlf-paths": {unicodeProject, unicodeDiagnostics}}
}

func TestSARIFGoldensAndSchema(t *testing.T) {
	schema := sarifValidator(t)
	for name, test := range sarifGoldenCases(t) {
		t.Run(name, func(t *testing.T) {
			result, wire := renderSARIF(t, test.p, test.ds)
			value, err := jsonschema.UnmarshalJSON(bytes.NewReader(wire))
			if err != nil {
				t.Fatal(err)
			}
			if err := schema.Validate(value); err != nil {
				t.Fatal(err)
			}
			_, repeat := renderSARIF(t, test.p, test.ds)
			if !bytes.Equal(wire, repeat) {
				t.Fatal("repeated SARIF bytes differ")
			}
			run := &result.Runs[0]
			if result.Version != "2.1.0" || run.ColumnKind != "utf16CodeUnits" || run.Tool.Driver.Version != "1.2.3" {
				t.Fatal("SARIF envelope changed")
			}
			// Normalize only the absolute machine-specific checkout base.
			base := sarifArtifact{URI: "file:///work/nested/"}
			run.OriginalURIBaseIDs[sarifSourceRoot] = base
			run.Invocations[0].WorkingDirectory = base
			golden, err := json.MarshalIndent(result, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			golden = append(golden, '\n')
			path := filepath.Join("testdata", "sarif-"+name+".golden.json")
			if os.Getenv("SALTBOX_UPDATE_SARIF_GOLDENS") == "1" {
				if err := os.WriteFile(path, golden, 0600); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(golden, want) {
				t.Fatalf("SARIF golden changed: %s", path)
			}
			jsonReport := renderJSONV2(t, test.p, test.ds)
			if len(run.Results) != len(jsonReport.Diagnostics) {
				t.Fatal("JSON/SARIF primary counts differ")
			}
			for i, result := range run.Results {
				d := jsonReport.Diagnostics[i]
				uri, err := url.PathUnescape(result.Locations[0].PhysicalLocation.ArtifactLocation.URI)
				if err != nil || strings.TrimPrefix(uri, "./") != d.Path || result.RuleID != d.RuleID || result.Level != d.Severity || !strings.HasPrefix(result.Message.Text, d.Message) {
					t.Fatal("JSON/SARIF primary diagnostics differ")
				}
				if run.Tool.Driver.Rules[result.RuleIndex].ID != result.RuleID {
					t.Fatal("invalid rule descriptor reference")
				}
			}
		})
	}
	// Prove the validator is actually enforcing the schema.
	if err := schema.Validate(map[string]any{"version": "bad", "runs": []any{}}); err == nil {
		t.Fatal("schema accepted an invalid log")
	}
}

func TestSARIFUTF16HalfOpenLocations(t *testing.T) {
	s, _ := lint.Parse("a.yml", []byte("v: '😀x'\r\nnext: true\r\n"))
	tests := []struct {
		span Span
		want Range
	}{
		{Span{8, 9}, Range{Position{1, 7}, Position{1, 8}}},
		{Span{8, 8}, Range{Position{1, 7}, Position{1, 7}}},
		{Span{8, 16}, Range{Position{1, 7}, Position{2, 5}}},
		{Span{len(s.Data), len(s.Data)}, Range{Position{3, 1}, Position{3, 1}}},
	}
	for _, test := range tests {
		if got := utf16Range(s, test.span); got != test.want {
			t.Errorf("%+v: got %+v want %+v", test.span, got, test.want)
		}
	}
	p, ds := sample()
	result, _ := renderSARIF(t, p, ds)
	related := result.Runs[0].Results[0].RelatedLocations[0]
	if related.ID != 1 || related.Message.Text != "context" || related.PhysicalLocation.Region != (sarifRegion{2, 1, 2, 5}) {
		t.Fatalf("related location: %+v", related)
	}
}

func TestSARIFFingerprints(t *testing.T) {
	makeCase := func(data, path string) (*lint.Project, []lint.Diagnostic) {
		s, _ := lint.Parse(path, []byte(data))
		p := &lint.Project{Root: t.TempDir(), Sources: map[string]*lint.Source{path: s}}
		ds := []lint.Diagnostic{}
		for offset := 0; offset < len(data); offset++ {
			if data[offset] == 'x' {
				ds = append(ds, lint.Diagnostic{Path: path, RuleID: "jinja-layout", Severity: "error", Message: "finding", Span: lint.Span{Start: offset, End: offset + 1}})
			}
		}
		return p, ds
	}
	p, ds := makeCase("v: [x, x]\nv: [x, x]\n", "a.yml")
	base, _ := renderSARIF(t, p, ds)
	seen := map[string]bool{}
	for _, result := range base.Runs[0].Results {
		id := result.PartialFingerprints[sarifFingerprintVersion]
		if seen[id] {
			t.Fatal("same-line or identical nearby finding identity collided")
		}
		seen[id] = true
	}
	moved, movedDiagnostics := makeCase("\n \n\nv: [x, x]\n\n\nv: [x, x]\n", "a.yml")
	movement, _ := renderSARIF(t, moved, movedDiagnostics)
	for i, result := range movement.Runs[0].Results {
		if result.PartialFingerprints[sarifFingerprintVersion] != base.Runs[0].Results[i].PartialFingerprints[sarifFingerprintVersion] {
			t.Fatal("blank-line insertion or checkout root changed fingerprint")
		}
	}
	// A selected subset must use the occurrence in source, not report order.
	subset, _ := renderSARIF(t, p, ds[2:])
	if subset.Runs[0].Results[0].PartialFingerprints[sarifFingerprintVersion] != base.Runs[0].Results[2].PartialFingerprints[sarifFingerprintVersion] {
		t.Fatal("fingerprint depends on diagnostic selection")
	}
	renamed, renamedDiagnostics := makeCase("v: [x, x]\nv: [x, x]\n", "renamed.yml")
	rename, _ := renderSARIF(t, renamed, renamedDiagnostics)
	if rename.Runs[0].Results[0].PartialFingerprints[sarifFingerprintVersion] == base.Runs[0].Results[0].PartialFingerprints[sarifFingerprintVersion] {
		t.Fatal("path rename must change source identity")
	}
}

func TestSARIFTraefikRelatedContext(t *testing.T) {
	adapter, err := os.ReadFile("../lint/testdata/traefik/adapter.good.yml")
	if err != nil {
		t.Fatal(err)
	}
	const defaultsPath = "roles/example/defaults/main.yml"
	const tasksPath = "roles/example/tasks/main.yml"
	var rules []lint.Rule
	for _, rule := range lint.Rules() {
		if rule.ID == "traefik-adapter-contract" {
			rules = append(rules, rule)
		}
	}
	makeCase := func(taskPath, tasks string) (*lint.Project, []lint.Diagnostic) {
		t.Helper()
		p := &lint.Project{Root: t.TempDir(), Sources: map[string]*lint.Source{}, Selected: map[string]bool{}}
		for path, text := range map[string]string{defaultsPath: "example_role_nginx_web_subdomain: nginx\n", taskPath: tasks} {
			source, parse := lint.Parse(path, []byte(text))
			if len(parse) != 0 {
				t.Fatalf("invalid real-rule fixture: %+v", parse)
			}
			p.Sources[path] = source
			p.Selected[path] = true
		}
		ds := lint.Analyze(p, rules)
		if len(ds) != 2 || ds[0].Path != defaultsPath || ds[1].Path != defaultsPath || ds[0].Span != ds[1].Span || ds[0].Message != ds[1].Message || ds[0].Expected != ds[1].Expected || len(ds[0].Related) != 1 || len(ds[1].Related) != 1 || ds[0].Related[0].Span == ds[1].Related[0].Span {
			t.Fatalf("expected equal primary findings with distinct related includes: %+v", ds)
		}
		return p, ds
	}
	identity := func(result sarifResult) string {
		return result.PartialFingerprints[sarifFingerprintVersion]
	}
	tasks := string(adapter) + string(adapter)
	p, ds := makeCase(tasksPath, tasks)
	base, _ := renderSARIF(t, p, ds)
	first, second := identity(base.Runs[0].Results[0]), identity(base.Runs[0].Results[1])
	if first == second {
		t.Fatal("related source occurrences collided")
	}
	reversed := slices.Clone(ds)
	slices.Reverse(reversed)
	order, _ := renderSARIF(t, p, reversed)
	if identity(order.Runs[0].Results[0]) != second || identity(order.Runs[0].Results[1]) != first {
		t.Fatal("fingerprint depends on report ordering")
	}
	subset, _ := renderSARIF(t, p, ds[1:])
	if identity(subset.Runs[0].Results[0]) != second {
		t.Fatal("related duplicate identity depends on diagnostic subset")
	}
	p.Selected[tasksPath] = false
	selected, _ := renderSARIF(t, p, lint.Analyze(p, rules))
	if len(selected.Runs[0].Results) != 2 || identity(selected.Runs[0].Results[0]) != first || identity(selected.Runs[0].Results[1]) != second {
		t.Fatal("related identity depends on contextual source selection")
	}
	for _, test := range []struct {
		name, path, tasks string
		stable            bool
	}{
		{"related blank lines and root move", tasksPath, "\n\n" + string(adapter) + "\n\n" + string(adapter), true},
		{"related source rename", "roles/example/tasks/other.yml", tasks, false},
		{"related syntax edit", tasksPath, strings.ReplaceAll(tasks, "'_nginx_web_subdomain', role", "'_nginx_web_subdomain',  role"), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			other, findings := makeCase(test.path, test.tasks)
			result, _ := renderSARIF(t, other, findings)
			for i, original := range base.Runs[0].Results {
				if equal := identity(result.Runs[0].Results[i]) == identity(original); equal != test.stable {
					t.Fatalf("related identity stability = %v, want %v", equal, test.stable)
				}
			}
		})
	}
}

func TestSARIFArtifactURIsAndNestedRoots(t *testing.T) {
	for _, path := range []string{"a #?%😀\\.yml", "a:b.yml", "a:b/file.yml", "folder/a:b.yml"} {
		p, ds := sample()
		p.Sources[path] = p.Sources[ds[0].Path]
		ds[0].Path = path
		p.Root = filepath.Join(t.TempDir(), "nested # checkout")
		result, _ := renderSARIF(t, p, ds)
		run := result.Runs[0]
		artifact := run.Results[0].Locations[0].PhysicalLocation.ArtifactLocation
		u, err := url.Parse(artifact.URI)
		if err != nil || u.IsAbs() || u.Fragment != "" || u.RawQuery != "" || strings.TrimPrefix(u.Path, "./") != path || artifact.URIBaseID != sarifSourceRoot {
			t.Fatalf("invalid artifact URI: %+v %v", artifact, err)
		}
		base, err := url.Parse(run.OriginalURIBaseIDs[sarifSourceRoot].URI)
		if err != nil || base.Scheme != "file" || !strings.HasSuffix(base.Path, "/") || !strings.HasSuffix(base.Path, "nested # checkout/") {
			t.Fatalf("nested root: %v %v", base, err)
		}
	}
}

func TestSARIFParserFingerprintMovement(t *testing.T) {
	var ids []string
	for _, text := range []string{"v: [\n", "\n\n\nv: [\n"} {
		source, ds := lint.Parse("broken.yml", []byte(text))
		if len(ds) != 1 {
			t.Fatalf("expected parser finding: %+v", ds)
		}
		p := &lint.Project{Root: t.TempDir(), Sources: map[string]*lint.Source{source.Path: source}}
		result, _ := renderSARIF(t, p, ds)
		ids = append(ids, result.Runs[0].Results[0].PartialFingerprints[sarifFingerprintVersion])
	}
	if ids[0] != ids[1] {
		t.Fatal("parser line numbers changed finding identity")
	}
}
