package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImportExplicitPathsAndHashes(t *testing.T) {
	extension, out, paths := importFixture(t)
	writeFixture(t, filepath.Join(out, "themes/keep.json"), []byte("untouched"))
	writeFixture(t, filepath.Join(out, "SHA256SUMS.json"), []byte(`{"themes/keep.json":"`+fmt.Sprintf("%x", sha256.Sum256([]byte("untouched")))+`"}`))
	t.Chdir(t.TempDir())
	if err := run([]string{"-extension", extension, "-out", out}); err != nil {
		t.Fatal(err)
	}
	var aggregate, imported map[string]string
	readJSON(t, filepath.Join(out, "SHA256SUMS.json"), &aggregate)
	readJSON(t, filepath.Join(out, "ansible-sha256.json"), &imported)
	if len(aggregate) != 11 {
		t.Fatalf("aggregate has %d entries, want 11", len(aggregate))
	}
	for name, hash := range aggregate {
		data, err := os.ReadFile(filepath.Join(out, name))
		if err != nil {
			t.Fatal(err)
		}
		if got := fmt.Sprintf("%x", sha256.Sum256(data)); got != hash {
			t.Errorf("%s: hash %s, want %s", name, hash, got)
		}
	}
	for _, path := range paths {
		data, err := os.ReadFile(filepath.Join(extension, path))
		if err != nil {
			t.Fatal(err)
		}
		if imported[path] != fmt.Sprintf("%x", sha256.Sum256(data)) {
			t.Errorf("source hash missing for %s", path)
		}
	}
	for name, hash := range imported {
		if strings.HasPrefix(name, "grammars/") && aggregate[name] != hash {
			t.Errorf("inconsistent %s", name)
		}
	}
	data, err := os.ReadFile(filepath.Join(out, "grammars/source.ansible.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte(`"scopeName": "source.ansible"`)) {
		t.Fatalf("missing converted grammar: %s", data)
	}
	if got, err := os.ReadFile(filepath.Join(out, "themes/keep.json")); err != nil || string(got) != "untouched" {
		t.Fatalf("unrelated asset changed: %q, %v", got, err)
	}
}

func TestImportRejectsInputsBeforePublishing(t *testing.T) {
	for _, test := range []struct {
		name   string
		damage func(*testing.T, string, string, []string)
		want   string
	}{
		{"version", func(t *testing.T, extension, out string, paths []string) {
			data, err := os.ReadFile(filepath.Join(extension, "package.json"))
			if err != nil {
				t.Fatal(err)
			}
			writeFixture(t, filepath.Join(extension, "package.json"), bytes.ReplaceAll(data, []byte(`"26.8.2"`), []byte(`"0.0.0"`)))
		}, "26.8.2"},
		{"manifest", func(t *testing.T, extension, out string, paths []string) {
			data, err := os.ReadFile(filepath.Join(extension, "package.json"))
			if err != nil {
				t.Fatal(err)
			}
			writeFixture(t, filepath.Join(extension, "package.json"), bytes.ReplaceAll(data, []byte(`source.ansible-jinja`), []byte(`source.other`)))
		}, "manifest"},
		{"later grammar", func(t *testing.T, extension, out string, paths []string) {
			writeFixture(t, filepath.Join(extension, paths[len(paths)-1]), []byte("malformed grammar"))
		}, "jinja"},
		{"aggregate", func(t *testing.T, extension, out string, paths []string) {
			writeFixture(t, filepath.Join(out, "SHA256SUMS.json"), []byte("malformed manifest"))
		}, "SHA256SUMS.json"},
	} {
		t.Run(test.name, func(t *testing.T) {
			extension, out, paths := importFixture(t)
			writeFixture(t, filepath.Join(out, "grammars/source.ansible.json"), []byte("previous grammar"))
			writeFixture(t, filepath.Join(out, "ansible-sha256.json"), []byte("previous hashes"))
			test.damage(t, extension, out, paths)
			before := snapshot(t, out)
			t.Chdir(t.TempDir())
			err := run([]string{"-extension", extension, "-out", out})
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error %v, want %q", err, test.want)
			}
			after := snapshot(t, out)
			if !bytes.Equal(before, after) {
				t.Fatalf("invalid input changed output\nbefore %s\nafter %s", before, after)
			}
		})
	}
}

func importFixture(t *testing.T) (string, string, []string) {
	t.Helper()
	extension, out := t.TempDir(), t.TempDir()
	data, err := os.ReadFile("../../highlight/assets/ansible-package.json")
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, filepath.Join(extension, "package.json"), data)
	var manifest struct {
		Contributes struct {
			Grammars []struct{ Path, ScopeName string }
		}
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, grammar := range manifest.Contributes.Grammars {
		paths = append(paths, grammar.Path)
		writeFixture(t, filepath.Join(extension, grammar.Path), []byte(`{"scopeName":"`+grammar.ScopeName+`","patterns":[]}`))
	}
	return extension, out, paths
}
func writeFixture(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
}
func readJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, value); err != nil {
		t.Fatal(err)
	}
}
func snapshot(t *testing.T, root string) []byte {
	t.Helper()
	files := map[string]string{}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		files[path] = string(data)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(files)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
