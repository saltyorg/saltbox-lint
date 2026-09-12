package catalog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceDiscoveryMatchesLanguageServer(t *testing.T) {
	root := t.TempDir()
	library := filepath.Join(root, "library")
	builtin := filepath.Join(root, "ansible", "modules")
	collections := filepath.Join(root, "collections")
	paths := []string{filepath.Join(library, "custom.py"), filepath.Join(library, "copy.py"), filepath.Join(builtin, "copy.py"), filepath.Join(collections, "ansible_collections", "test", "demo", "plugins", "modules", "deep", "thing.py"), filepath.Join(collections, "ansible_collections", "test", "demo", "plugins", "modules", "_hidden.py")}
	for _, path := range paths {
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("DOCUMENTATION = ''"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(paths[3], filepath.Join(filepath.Dir(paths[4]), "alias.py")); err != nil {
		t.Fatal(err)
	}
	c := &Catalog{Modules: map[string]Module{
		"ansible.builtin.copy": {CanonicalName: "ansible.builtin.copy", Source: Source{Path: paths[1]}, DiscoveryNames: []string{"ansible.legacy.copy", "copy"}},
	}, Routes: map[string]Route{}}
	if err := c.discoverSources([]string{library, builtin}, []string{collections}); err != nil {
		t.Fatal(err)
	}
	if len(c.Modules) != 3 {
		t.Fatalf("modules=%v", c.Modules)
	}
	if c.Modules["ansible.builtin.copy"].Source.Path != paths[2] {
		t.Fatal("later builtin path must replace custom collision")
	}
	if c.Modules["ansible.builtin.copy"].DiscoveryNames[0] != "ansible.builtin.copy" {
		t.Fatal("builtin source must not import a shadowing custom module's documentation")
	}
	if c.Modules["test.demo.deep.thing"].Source.Path != paths[3] {
		t.Fatal("nested collection path lost")
	}
}

func TestRuntimeModuleRouting(t *testing.T) {
	c := &Catalog{Routes: map[string]Route{}}
	if err := c.importRoutes([]byte("plugin_routing:\n  modules:\n    old:\n      redirect: test.demo.current\n      tombstone:\n        removal_version: '2'\n    empty: {}\n  lookup:\n    ignored:\n      redirect: test.demo.current\n"), "test.demo"); err != nil {
		t.Fatal(err)
	}
	if route, ok := c.Routes["test.demo.old"]; !ok || route.Redirect != "test.demo.current" || !route.Tombstone {
		t.Fatalf("route=%+v", route)
	}
	if len(c.Routes) != 2 {
		t.Fatalf("nonmodule routes imported: %v", c.Routes)
	}
	if err := c.importRoutes([]byte("[malformed:"), "bad.test"); err == nil {
		t.Fatal("invalid routing accepted")
	}
}

func TestSnapshotDeterministicAndLoadable(t *testing.T) {
	c := &Catalog{SchemaVersion: 1, Modules: map[string]Module{"ansible.builtin.example": {CanonicalName: "ansible.builtin.example"}}, Routes: map[string]Route{}, Problems: []Problem{{Kind: "warning", Message: "z"}, {Kind: "warning", Message: "a"}, {Kind: "warning", Message: "z"}}}
	first, err := c.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatal("serialization not deterministic")
	}
	loaded, err := decode(first)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Problems) != 2 {
		t.Fatal("warnings not deduplicated")
	}
	if _, err := decode([]byte(strings.Replace(string(first), `"schema_version": 1`, `"schema_version": 99`, 1))); err == nil {
		t.Fatal("unsupported schema accepted")
	}
}
