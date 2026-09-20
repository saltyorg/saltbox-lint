package catalog

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Catches loss of discovered module existence and typed option/alias metadata
// at the real ansible-doc file-list and static source import boundary.
func TestImportAnsibleOutput(t *testing.T) {
	files, err := os.ReadFile("testdata/ansible-files.txt")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	separator := string(filepath.Separator)
	nativeFiles := strings.ReplaceAll(string(files), "/", separator)
	nativeFiles = strings.ReplaceAll(nativeFiles, separator+"srv"+separator, filepath.Join(root, "srv")+separator)
	c, err := importFiles([]byte(nativeFiles), []string{filepath.Join(root, "srv", "git", "saltbox", "library")})
	if err != nil {
		t.Fatal(err)
	}
	for name, module := range c.Modules {
		source, err := os.ReadFile(filepath.Join("testdata", filepath.Base(module.Source.Path)))
		if err != nil {
			t.Fatal(err)
		}
		raw, err := parseAssignments(source)
		if err != nil {
			t.Fatal(err)
		}
		module.Options, module.DocumentationAvailable, _ = semanticOptions(raw, nil)
		c.Modules[name] = module
	}
	for _, name := range []string{"debug", "ansible.builtin.debug", "port_assignment", "tld_parse"} {
		m, ok := c.Resolve(name, ResolveContext{})
		if !ok || !m.DocumentationAvailable {
			t.Errorf("%s: module/docs unavailable: %+v", name, m)
		}
	}
	if _, ok := c.Resolve("ansible.legacy.port_assignment", ResolveContext{}); ok {
		t.Fatal("CLI legacy alias is not an ALS lookup alias")
	}
	m, ok := c.Resolve("community.docker.docker_container", ResolveContext{})
	if !ok {
		t.Fatal("docker_container unavailable")
	}
	for _, tt := range []struct{ name, kind, child string }{{"networks", "list", "name"}, {"healthcheck", "dict", "test"}} {
		opt := m.Options[tt.name]
		if opt.Type != tt.kind || opt.Suboptions[tt.child].Type == "" {
			t.Errorf("lost nested option %s: %+v", tt.name, opt)
		}
	}
	if _, ok := FindOption(m.Options, "ports"); !ok {
		t.Error("ports alias not imported")
	}
	if _, ok := FindOption(m.Options, "PORTS"); ok {
		t.Error("option aliases are case sensitive")
	}
}

func TestResolverPrecedenceAndRoutes(t *testing.T) {
	c := &Catalog{Modules: map[string]Module{}, Routes: map[string]Route{}}
	for _, name := range []string{"ansible.builtin.copy", "first.example.copy", "first.example.unique", "second.example.unique", "second.example.target", "second.example.undocumented", "second.example.deep.module"} {
		c.Modules[name] = Module{CanonicalName: name}
	}
	ctx := ResolveContext{Collections: []string{"first.example", "second.example"}}
	for _, tt := range []struct{ name, want string }{{"copy", "ansible.builtin.copy"}, {"unique", "first.example.unique"}, {"second.example.deep.module", "second.example.deep.module"}, {"undocumented", "second.example.undocumented"}, {"missing", ""}} {
		m, ok := c.Resolve(tt.name, ctx)
		if ok != (tt.want != "") || m.CanonicalName != tt.want {
			t.Errorf("Resolve(%s)=(%s,%v), want %s", tt.name, m.CanonicalName, ok, tt.want)
		}
	}
	// ALS searches every candidate for routing before direct module lookup.
	c.Routes["first.example.copy"] = Route{Redirect: "second.example.target"}
	if m, _ := c.Resolve("copy", ctx); m.CanonicalName != "second.example.target" {
		t.Fatalf("route must precede direct builtin: %+v", m)
	}
	c.Routes["ansible.builtin.copy"] = Route{Redirect: "absent.example.target"}
	if _, ok := c.Resolve("copy", ctx); ok {
		t.Fatal("broken first route must not fall back")
	}
	c.Routes["first.example.alias"] = Route{Redirect: "second.example.undocumented", Tombstone: true}
	if m, ok := c.Resolve("alias", ctx); !ok || m.DocumentationAvailable {
		t.Fatalf("module existence differs from docs: %+v, %v", m, ok)
	}
	c.Routes["first.example.chain"] = Route{Redirect: "first.example.alias"}
	if _, ok := c.Resolve("chain", ctx); ok {
		t.Fatal("ALS does not follow redirect chains")
	}
}

func TestFileDiscoveryDoesNotInventNamespace(t *testing.T) {
	library := filepath.Join(t.TempDir(), "library")
	c, err := importFiles([]byte(fmt.Sprintf("odd.custom.name %s\n", filepath.Join(library, "odd.custom.name.py"))), []string{library})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Modules["ansible.builtin.odd.custom.name"]; !ok {
		t.Fatal("library basename must retain actual source name")
	}
	if _, ok := c.Modules["odd.custom.name"]; ok {
		t.Fatal("dotted CLI name must not invent a collection")
	}
	if _, err := importFiles([]byte("bad record without source\n"), nil); err == nil {
		t.Fatal("malformed file list accepted")
	}
}
