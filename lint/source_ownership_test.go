package lint

import (
	"bytes"
	"path/filepath"
	"testing"
)

func TestLoadCopiesEditorBuffer(t *testing.T) {
	root := t.TempDir()
	data := []byte("value: original\n")
	project, err := Load(t.Context(), Options{Root: root, StdinFilename: filepath.Join(root, "values.yml"), Stdin: data})
	if err != nil {
		t.Fatal(err)
	}
	data[0] = 'X'
	if got := string(project.Sources["values.yml"].Data); got != "value: original\n" {
		t.Fatalf("caller mutation changed editor source: %q", got)
	}
}

func TestParseOwnsACopyOfCallerBytes(t *testing.T) {
	for _, name := range []string{"values.yml", "roles/demo/templates/config.j2"} {
		data := []byte("value: original\n")
		source, diagnostics := Parse(name, data)
		if len(diagnostics) != 0 {
			t.Fatal(diagnostics)
		}
		data[0] = 'X'
		if string(source.Data) != "value: original\n" {
			t.Fatalf("caller mutation changed source: %q", source.Data)
		}
		source.Data[1] = 'Y'
		if string(data) != "Xalue: original\n" {
			t.Fatalf("source mutation changed caller: %q", data)
		}
	}
}

func TestOwnedParseEliminatesOnlyTheInputCopyAllocation(t *testing.T) {
	data := bytes.Repeat([]byte("value\n"), 1024)
	name := "roles/demo/templates/config.j2"
	public := testing.AllocsPerRun(10, func() {
		source, _ := Parse(name, data)
		if !bytes.Equal(source.Data, data) {
			t.Fatal("public parse changed bytes")
		}
	})
	owned := testing.AllocsPerRun(10, func() {
		source, _ := parseOwnedSource(name, data)
		if !bytes.Equal(source.Data, data) {
			t.Fatal("owned parse changed bytes")
		}
	})
	if public-owned != 1 {
		t.Fatalf("public=%.0f owned=%.0f allocations, want exactly one input-copy difference", public, owned)
	}
}
