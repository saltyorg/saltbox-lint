package lint

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func templateAlias(t *testing.T, root, name, target string) string {
	t.Helper()
	filename := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(filename), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filename); err != nil {
		t.Fatal(err)
	}
	return filename
}

func TestTemplateLeafAliasConfigurationConsumers(t *testing.T) {
	for _, name := range []string{"config.yaml", "config"} {
		for _, aliasName := range []string{"alias.yaml", "alias.j2", "roles/demo/templates/alias.j2"} {
			t.Run(name+"/"+aliasName, func(t *testing.T) {
				root := t.TempDir()
				text := "literal {{ lookup('role_var', '_value', role='foreign') }}\r\n  {{ unfinished"
				canonical := "roles/demo/templates/" + name
				filename := putFile(t, root, canonical, text)
				alias := templateAlias(t, root, aliasName, filename)
				task := putFile(t, root, "roles/demo/tasks/main.yml", "- template: {src: "+name+", variable_start_string: '[[', dest: /config}\n")
				putFile(t, root, "roles/foreign/defaults/main.yml", "foreign_role_value: present\n")
				for _, selection := range [][]string{{alias}, {task, alias}, {alias, filename}, {root, alias}} {
					p, err := Load(t.Context(), Options{Root: root, Paths: selection, IncludeAnalysis: true, referenceContext: true})
					if err != nil {
						t.Fatal(err)
					}
					source := p.Sources[aliasName]
					if source == nil || source.Path != aliasName || source.RolePath != "roles/demo" || string(source.Data) != text {
						t.Fatalf("lost logical identity or canonical owner: %+v", source)
					}
					scan := scanTemplate(source)
					if len(scan.diagnostics) != 0 || len(scan.expressions) != 0 || !strings.Contains(strings.Join(scan.reasons, ";"), "task delimiter overrides") || len(Expressions(source)) != 0 || len(sourceRoleReferences(source)) != 0 {
						t.Fatalf("alias fabricated default grammar facts: %+v", scan)
					}
					if _, read := p.Sources["roles/foreign/defaults/main.yml"]; read && !slices.Contains(selection, root) {
						t.Fatal("unsupported configuration authorized a foreign-role read")
					}
					if err := RequireWritableSelection(p); err == nil {
						t.Fatal("template alias became writable")
					}
				}
				opts := Options{Root: root, Paths: []string{alias}}
				explanation, err := Explain(t.Context(), opts)
				if err != nil || explanation.Source.Path != aliasName || explanation.Source.ParseState != "partial-template" || !strings.Contains(strings.Join(explanation.Source.CoverageReasons, ";"), "task delimiter overrides") {
					t.Fatalf("alias explanation: %+v %v", explanation, err)
				}
				references, err := References(t.Context(), opts)
				if err != nil || len(references.References) != 0 || len(references.Sources) != 1 || references.Sources[0].ParseState != "partial-template" {
					t.Fatalf("alias references: %+v %v", references, err)
				}
				for _, operation := range []string{"definition", "hover", "references", "completion"} {
					query, err := Query(t.Context(), QueryRequest{Root: root, Filename: alias, Source: []byte(text), Operation: operation, Offset: strings.Index(text, "_value") + 2})
					if err != nil || query.Path != aliasName || query.State != "unavailable" || len(query.Locations) != 0 || len(query.Completions) != 0 {
						t.Fatalf("alias %s query: %+v %v", operation, query, err)
					}
				}
				if after, err := os.ReadFile(filename); err != nil || string(after) != text {
					t.Fatal("template bytes changed")
				}
			})
		}
	}
}

func TestTemplateRendererCanonicalAliasOwnership(t *testing.T) {
	root := t.TempDir()
	putFile(t, root, traefikDefaultsPath, traefikFixture(t, "api.good.yml"))
	text := traefikFixture(t, "renderer.bad.j2")
	filename := putFile(t, root, traefikTemplatePath, text)
	aliasName := "roles/example/templates/alias.j2"
	alias := templateAlias(t, root, aliasName, filename)
	outerName := "alias.yaml"
	outer := templateAlias(t, root, outerName, filename)
	task := putFile(t, root, traefikTasksPath, "- template: {src: alias.j2, dest: /router}\n- template: {src: router.yml.j2, dest: /router}\n")
	for _, tc := range []struct {
		name, owner string
		paths       []string
	}{
		{"canonical", traefikTemplatePath, []string{filename}},
		{"task alias", aliasName, []string{alias}},
		{"outer alias", outerName, []string{outer}},
		{"YAML", traefikTasksPath, []string{task}},
		{"canonical with YAML", traefikTemplatePath, []string{task, filename}},
		{"both spellings", aliasName, []string{alias, filename}},
		{"all spellings", outerName, []string{task, filename, alias, outer}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := Load(t.Context(), Options{Root: root, Paths: tc.paths})
			if err != nil {
				t.Fatal(err)
			}
			diagnostics := Analyze(p, traefikRules("traefik-renderer-contract"))
			if len(diagnostics) != 1 || diagnostics[0].Path != tc.owner || diagnostics[0].Fix != nil {
				t.Fatalf("canonical renderer ownership/deduplication: %+v, want %s", diagnostics, tc.owner)
			}
			if tc.owner != traefikTasksPath && !slices.ContainsFunc(diagnostics[0].Related, func(location RelatedLocation) bool {
				return location.Path == traefikTasksPath && location.Message == "template referenced by this task"
			}) {
				t.Fatalf("lost owning task: %+v", diagnostics)
			}
			if after, err := os.ReadFile(filename); err != nil || string(after) != text {
				t.Fatal("renderer check changed bytes")
			}
		})
	}
	// A task naming only the alias still belongs to the canonical output.
	putFile(t, root, traefikTasksPath, "- template: {src: alias.j2, dest: /router}\n")
	p, err := Load(t.Context(), Options{Root: root, Paths: []string{filename}})
	if err != nil {
		t.Fatal(err)
	}
	if diagnostics := Analyze(p, traefikRules("traefik-renderer-contract")); len(diagnostics) != 1 || diagnostics[0].Path != traefikTemplatePath {
		t.Fatalf("single lexical task lost canonical template: %+v", diagnostics)
	}
	// The selected buffer, rather than the old disk bytes, supplies every
	// admitted spelling of this output. Equivalent contents in another file
	// never acquire that identity or absorb its diagnostic.
	putFile(t, root, traefikTemplatePath, traefikFixture(t, "renderer.good.j2"))
	p, err = Load(t.Context(), Options{Root: root, StdinFilename: outer, Stdin: []byte(text)})
	if err != nil {
		t.Fatal(err)
	}
	if diagnostics := Analyze(p, traefikRules("traefik-renderer-contract")); len(diagnostics) != 1 || diagnostics[0].Path != outerName {
		t.Fatalf("alias buffer did not own its renderer snapshot: %+v", diagnostics)
	}
	other, _ := Parse("roles/example/templates/unrelated.j2", []byte(text))
	if sameTemplateSource(p.Sources[outerName], other) {
		t.Fatal("equal contents fabricated canonical identity")
	}
	changed, _ := Parse(traefikTemplatePath, []byte(text+"different"))
	if sameTemplateSource(p.Sources[outerName], changed) {
		t.Fatal("unequal buffers transferred source-owned diagnostics")
	}
}

func TestTemplateAliasBoundariesAndFreshIdentity(t *testing.T) {
	root := t.TempDir()
	first := putFile(t, root, "roles/demo/templates/config", "{{ lookup('role_var', '_value') }}")
	second := putFile(t, root, "roles/other/templates/config", "literal {{ unfinished")
	putFile(t, root, "roles/demo/defaults/main.yml", "demo_role_value: present\n")
	putFile(t, root, "roles/other/tasks/main.yml", "- template: {src: config, variable_start_string: '[[', dest: /config}\n")
	alias := templateAlias(t, root, "alias.yaml", first)
	report, err := References(t.Context(), Options{Root: root, Paths: []string{alias}})
	if err != nil || len(report.References) != 1 || report.References[0].Location.Path != "alias.yaml" || report.References[0].State != "resolved" {
		t.Fatalf("supported alias reference: %+v %v", report, err)
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(second, alias); err != nil {
		t.Fatal(err)
	}
	explanation, err := Explain(t.Context(), Options{Root: root, Paths: []string{alias}})
	if err != nil || explanation.Source.ParseState != "partial-template" || !strings.Contains(strings.Join(explanation.Source.CoverageReasons, ";"), "task delimiter overrides") {
		t.Fatalf("retarget reused old source identity: %+v %v", explanation, err)
	}
	if err := os.Remove(second); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(t.Context(), Options{Root: root, Paths: []string{alias}}); err == nil {
		t.Fatal("missing template alias admitted disk contents")
	}
	if _, err := Load(t.Context(), Options{Root: root, StdinFilename: alias, Stdin: []byte("{{ value }}")}); err == nil {
		t.Fatal("dangling template alias fabricated a buffer owner")
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	outside := putFile(t, t.TempDir(), "config.j2", "{{ value }}")
	if err := os.Symlink(outside, alias); err != nil {
		t.Fatal(err)
	}
	for _, opts := range []Options{{Root: root, Paths: []string{alias}}, {Root: root, StdinFilename: alias, Stdin: []byte("{{ value }}")}} {
		if _, err := Load(t.Context(), opts); err == nil || !strings.Contains(err.Error(), "outside root") {
			t.Fatalf("escaped alias admitted: %v", err)
		}
	}
}

func TestTemplateDirectoryAliasUsesAdmittedCanonicalOwner(t *testing.T) {
	root := t.TempDir()
	filename := putFile(t, root, "roles/demo/templates/config", "literal {{ unfinished")
	putFile(t, root, "roles/demo/tasks/main.yml", "- template: {src: config, variable_start_string: '[[', dest: /config}\n")
	directory := templateAlias(t, root, "alias", filepath.Dir(filename))
	logical := filepath.Join(directory, "config")
	p, err := Load(t.Context(), Options{Root: root, Paths: []string{logical}})
	if err != nil {
		t.Fatal(err)
	}
	source := p.Sources["roles/demo/templates/config"]
	if source == nil || source.RolePath != "roles/demo" || len(p.Selected) != 1 {
		t.Fatalf("directory alias changed shared source identity: %+v", p)
	}
	if scan := scanTemplate(source); len(scan.diagnostics) != 0 || !strings.Contains(strings.Join(scan.reasons, ";"), "task delimiter overrides") {
		t.Fatalf("directory alias bypassed task configuration: %+v", scan)
	}
}

func TestTemplateDirectorySpellingSurvivesCanonicalParent(t *testing.T) {
	for _, basename := range []string{"main.yml", "config", "literal.j2"} {
		t.Run(basename, func(t *testing.T) {
			root := t.TempDir()
			text := "v: \"{{ value\n }}\"\n"
			filename := putFile(t, root, "roles/demo/tasks/"+basename, text)
			directory := templateAlias(t, root, "roles/demo/templates", filepath.Dir(filename))
			alias := filepath.Join(directory, basename)
			name := "roles/demo/tasks/" + basename
			for _, opts := range []Options{
				{Root: root, Paths: []string{alias}},
				{Root: root, StdinFilename: alias, Stdin: []byte(text)},
				{Root: root, StdinFilename: filename, StdinSourceFilename: alias, Stdin: []byte(text)},
			} {
				p, err := Load(t.Context(), opts)
				if err != nil {
					t.Fatal(err)
				}
				if s := p.Sources[name]; s == nil || s.Kind != Template || !p.Selected[name] || string(s.Data) != text || RequireWritableSelection(p) == nil {
					t.Fatalf("original directory spelling lost template protection: %+v", s)
				}
				for _, d := range Analyze(p, Rules()) {
					if d.Fix != nil || d.RuleID == "jinja-layout" {
						t.Fatalf("template received writable policy: %+v", d)
					}
				}
			}
			identity, err := ResolveSourceIdentity(root, alias)
			if err != nil || identity.Path != name || !identity.IsTemplate() {
				t.Fatalf("identity lost template kind: %+v %v", identity, err)
			}
			query, err := Query(t.Context(), QueryRequest{Root: root, Filename: alias, Source: []byte(text), Operation: "completion", Offset: 5})
			if err != nil || query.State != "unavailable" || !slices.Contains(query.Reasons, "templates-are-read-only") {
				t.Fatalf("query lost template kind: %+v %v", query, err)
			}
			query, err = Query(t.Context(), QueryRequest{Root: root, Filename: filename, SourceFilename: alias, Source: []byte(text), Operation: "completion", Offset: 5})
			if err != nil || query.Path != name || query.State != "unavailable" || !slices.Contains(query.Reasons, "templates-are-read-only") {
				t.Fatalf("canonical query lost extensionless template spelling: %+v %v", query, err)
			}
			narrow, err := Load(t.Context(), Options{Root: directory, Paths: []string{alias}})
			if err != nil || narrow.Sources[basename].Kind != Template || narrow.Sources[basename].RolePath != "" || len(narrow.Sources) != 1 {
				t.Fatalf("narrow alias widened context or lost template kind: %+v %v", narrow, err)
			}
			if basename == "main.yml" {
				ordinary, err := Load(t.Context(), Options{Root: root, Paths: []string{root}})
				if err != nil || ordinary.Sources[name].Kind != Tasks || !ordinary.Selected[name] {
					t.Fatalf("default YAML discovery changed: %+v %v", ordinary, err)
				}
				if _, err := Load(t.Context(), Options{Root: root, Paths: []string{directory}}); err == nil || !strings.Contains(err.Error(), "no supported sources") {
					t.Fatalf("template directory alias admitted YAML primaries: %v", err)
				}
			}
		})
	}
}

func TestTemplateSnapshotCrossRoleSpellingRetainsOwnerContext(t *testing.T) {
	for _, aliasRoot := range []bool{false, true} {
		t.Run(map[bool]string{false: "ordinary root", true: "aliased root"}[aliasRoot], func(t *testing.T) {
			root := t.TempDir()
			if aliasRoot {
				root = templateAlias(t, t.TempDir(), "root", root)
			}
			text := "literal {{ unfinished"
			filename := putFile(t, root, "roles/b/templates/config", text)
			alias := templateAlias(t, root, "roles/a/templates/alias.j2", filename)
			taskText := "- template: {src: alias.j2, variable_start_string: '[[', dest: /config}\n"
			putFile(t, root, "roles/a/tasks/main.yml", taskText)
			opts := Options{Root: root, StdinFilename: filename, StdinSourceFilename: alias, Stdin: []byte(text), IncludeAnalysis: true}
			p, err := Load(t.Context(), opts)
			if err != nil {
				t.Fatal(err)
			}
			s := p.Sources["roles/b/templates/config"]
			if s == nil || s.templatePath != "roles/b/templates/config" || !slices.Contains(s.templateSpellings, "roles/a/templates/alias.j2") {
				t.Fatalf("snapshot lost canonical or lexical identity: %+v", s)
			}
			if p.Sources["roles/a/tasks/main.yml"] == nil {
				t.Fatal("original role task context was omitted")
			}
			if scan := scanTemplate(s); len(scan.diagnostics) != 0 || !scan.configurationUnavailable {
				t.Fatalf("cross-role alias fabricated default grammar: %+v", scan)
			}
			var owns bool
			for _, d := range p.Dependencies.Sources[0].Files {
				owns = owns || d.Path == "roles/a/tasks/main.yml" && d.State == "read" && d.SHA256 == fmt.Sprintf("%x", sha256.Sum256([]byte(taskText)))
			}
			if !owns {
				t.Fatal("original role configuration missing from dependencies")
			}
			query, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, SourceFilename: alias, Source: []byte(text), Operation: "definition", Offset: 10})
			if err != nil || query.State != "unavailable" || !slices.Contains(query.Reasons, "template-configuration-unavailable") {
				t.Fatalf("query fabricated grammar: %+v %v", query, err)
			}
			explanation, err := Explain(t.Context(), opts)
			if err != nil || explanation.Source.Path != "roles/b/templates/config" || explanation.Source.ParseState != "partial-template" {
				t.Fatalf("explanation lost original configuration: %+v %v", explanation, err)
			}
			references, err := References(t.Context(), opts)
			if err != nil || len(references.References) != 0 || references.Sources[0].ParseState != "partial-template" {
				t.Fatalf("references fabricated grammar: %+v %v", references, err)
			}
			// Re-admit fresh task bytes without changing the canonical template snapshot.
			putFile(t, root, "roles/a/tasks/main.yml", "[]\n")
			fresh, err := Load(t.Context(), opts)
			if err != nil {
				t.Fatal(err)
			}
			if scan := scanTemplate(fresh.Sources[s.Path]); len(scan.diagnostics) != 1 || scan.configurationUnavailable {
				t.Fatalf("fresh task configuration was not observed: %+v", scan)
			}
			if fresh.Dependencies.Generation == p.Dependencies.Generation {
				t.Fatal("original task change did not change dependency generation")
			}
			if after, err := os.ReadFile(filename); err != nil || string(after) != text {
				t.Fatal("configuration checking changed template bytes")
			}
		})
	}
}

func TestTemplateAliasBufferDoesNotReplaceYAMLContext(t *testing.T) {
	root := t.TempDir()
	disk := "demo_role_value: present\n"
	filename := putFile(t, root, "roles/demo/defaults/main.yml", disk)
	alias := templateAlias(t, root, "alias.j2", filename)
	p, err := Load(t.Context(), Options{Root: root, StdinFilename: alias, Stdin: []byte("{{ lookup('role_var', '_value') }}")})
	if err != nil {
		t.Fatal(err)
	}
	context := p.Sources["roles/demo/defaults/main.yml"]
	if context == nil || context.Kind != Defaults || string(context.Data) != disk || len(context.parseDiagnostics) != 0 {
		t.Fatalf("read-only alias buffer replaced YAML context: %+v", context)
	}
	if p.Sources["alias.j2"].Kind != Template || RequireWritableSelection(p) == nil {
		t.Fatal("template alias became writable")
	}
}

func TestTemplateTaskAliasRetargetAfterAdmissionIsPartial(t *testing.T) {
	root := t.TempDir()
	first := putFile(t, root, "roles/demo/templates/config", "literal {{ unfinished")
	second := putFile(t, root, "roles/demo/templates/other", "literal {{ unfinished")
	alias := templateAlias(t, root, "roles/demo/templates/alias.j2", first)
	putFile(t, root, "roles/demo/tasks/main.yml", "- template: {src: alias.j2, variable_start_string: '[[', dest: /config}\n")
	p, err := Load(t.Context(), Options{Root: root, Paths: []string{first}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(second, alias); err != nil {
		t.Fatal(err)
	}
	scan := scanTemplate(p.Sources["roles/demo/templates/config"])
	if len(scan.diagnostics) != 0 || len(scan.expressions) != 0 || !strings.Contains(strings.Join(scan.reasons, ";"), "identity changed") {
		t.Fatalf("retarget after admission fabricated default syntax: %+v", scan)
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	scan = scanTemplate(p.Sources["roles/demo/templates/config"])
	if len(scan.diagnostics) != 0 || len(scan.expressions) != 0 || !strings.Contains(strings.Join(scan.reasons, ";"), "now missing") {
		t.Fatalf("missing admitted alias fabricated default syntax: %+v", scan)
	}
}

func TestTemplateCrossRoleAliasDeclinesConfiguration(t *testing.T) {
	root := t.TempDir()
	text := "literal {{ lookup('role_var', '_value', role='foreign') }}\n{{ unfinished"
	filename := putFile(t, root, "roles/other/templates/config", text)
	alias := templateAlias(t, root, "roles/demo/templates/alias.j2", filename)
	task := putFile(t, root, "roles/demo/tasks/main.yml", "- template: {src: alias.j2, variable_start_string: '[[', dest: /config}\n")
	for _, paths := range [][]string{{alias}, {alias, task}, {root, filename}} {
		p, err := Load(t.Context(), Options{Root: root, Paths: paths})
		if err != nil {
			t.Fatal(err)
		}
		name := "roles/demo/templates/alias.j2"
		if slices.Contains(paths, filename) {
			name = "roles/other/templates/config"
		}
		scan := scanTemplate(p.Sources[name])
		if len(scan.diagnostics) != 0 || len(scan.expressions) != 0 || !strings.Contains(strings.Join(scan.reasons, ";"), "source resolution") {
			t.Fatalf("cross-role alias guessed supported configuration: %+v", scan)
		}
	}
}

func TestTemplateSnapshotSpellingKeepsCanonicalOwner(t *testing.T) {
	root := t.TempDir()
	name := "roles/demo/defaults/main.yml"
	text := "demo_role_value: \"{{ value\n }}\"\n{{ lookup('role_var', '_port', role='foreign') }}"
	filename := putFile(t, root, name, text)
	putFile(t, root, "roles/foreign/defaults/main.yml", "foreign_role_port: 1234\n")
	for _, spelling := range []string{"alias.j2", "roles/demo/templates/config.yaml"} {
		alias := templateAlias(t, root, spelling, filename)
		opts := Options{Root: root, StdinFilename: filename, StdinSourceFilename: alias, Stdin: []byte(text), IncludeAnalysis: true}
		p, err := Load(t.Context(), opts)
		if err != nil {
			t.Fatal(err)
		}
		if p.Sources[name].Kind != Template || !p.Selected[name] || p.Selected[spelling] {
			t.Fatal("snapshot spelling replaced canonical ownership or lost template kind")
		}
		for _, finding := range Analyze(p, Rules()) {
			if finding.RuleID == "jinja-layout" || finding.Fix != nil {
				t.Fatalf("template emitted a layout policy or fix: %+v", finding)
			}
		}
		explanation, err := Explain(t.Context(), opts)
		if err != nil || explanation.Source.Path != name || explanation.Source.Kind != Template {
			t.Fatalf("explanation lost template snapshot kind: %+v %v", explanation, err)
		}
		for _, operation := range []string{"definition", "hover", "references", "completion"} {
			result, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, SourceFilename: alias, Source: []byte(text), Operation: operation, Offset: strings.Index(text, "_port") + 2})
			if err != nil || result.Path != name {
				t.Fatalf("canonical snapshot query: %+v %v", result, err)
			}
			if operation == "completion" {
				if result.State != "unavailable" || !slices.Contains(result.Reasons, "templates-are-read-only") || len(result.Completions) != 0 {
					t.Fatalf("template became writable: %+v", result)
				}
			} else if result.State != "resolved" || len(result.Declarations) != 1 {
				t.Fatalf("read-only template navigation lost: %+v", result)
			}
		}
		raw := []byte{0xff, 0, '\r', '\n'}
		opts.Stdin = raw
		rawProject, err := Load(t.Context(), opts)
		if err != nil || rawProject.Sources[name].Kind != Template || !slices.Equal(rawProject.Sources[name].Data, raw) {
			t.Fatalf("raw template snapshot lost kind or bytes: %+v %v", rawProject, err)
		}
		if after, err := os.ReadFile(filename); err != nil || string(after) != text {
			t.Fatal("snapshot check changed source")
		}
	}
	for _, mode := range []string{"missing", "retargeted", "escaping"} {
		t.Run(mode, func(t *testing.T) {
			alias := filepath.Join(root, mode+".j2")
			if mode != "missing" {
				target := putFile(t, root, "other.yml", "other: true\n")
				if mode == "escaping" {
					target = putFile(t, t.TempDir(), "external.yml", "external: true\n")
				}
				templateAlias(t, root, mode+".j2", target)
			}
			opts := Options{Root: root, StdinFilename: filename, StdinSourceFilename: alias, Stdin: []byte(text)}
			if _, err := Load(t.Context(), opts); err == nil {
				t.Fatal("invalid source spelling fell back to YAML")
			}
			if _, err := Explain(t.Context(), opts); err == nil {
				t.Fatal("invalid source spelling produced explanation claims")
			}
			if _, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, SourceFilename: alias, Source: []byte(text), Operation: "definition", Offset: 0}); err == nil {
				t.Fatal("invalid source spelling produced navigation claims")
			}
		})
	}
}

func TestTemplateSnapshotSpellingOverlaysOnlyMatchingAliases(t *testing.T) {
	root := t.TempDir()
	name := "roles/demo/defaults/main.yml"
	disk := "demo_role_value: \"{{ value\n }}\"\n"
	filename := putFile(t, root, name, disk)
	alias := templateAlias(t, root, "source.j2", filename)
	alternate := templateAlias(t, root, "alternate.yml", filename)
	unrelated := putFile(t, root, "unrelated.yml", disk)
	buffer := []byte("{% if snapshot %}{{ value }}{% endif %}  ")
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{root, alternate, unrelated}, StdinFilename: filename, StdinSourceFilename: alias, Stdin: buffer})
	if err != nil {
		t.Fatal(err)
	}
	for _, sourceName := range []string{name, "alternate.yml"} {
		source := project.Sources[sourceName]
		if source == nil || source.Kind != Template || !slices.Equal(source.Data, buffer) {
			t.Fatalf("matching alias did not share snapshot bytes and kind: %+v", source)
		}
	}
	if source := project.Sources["unrelated.yml"]; source == nil || source.Kind == Template || string(source.Data) != disk {
		t.Fatalf("equal unrelated contents were reclassified or overlaid: %+v", source)
	}
}
