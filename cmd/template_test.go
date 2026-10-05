package cmd

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTemplateCommandReadOnlyBoundaries(t *testing.T) {
	root := t.TempDir()
	yaml := filepath.Join(root, "input.yml")
	template := filepath.Join(root, "literal.j2")
	yamlText := "v: \"{{ a\n | combine(b) }}\"\n"
	templateText := " \t{% if enabled -%}\r\n  {{ value\r\n }}\r\n{% endif %}  "
	for name, text := range map[string]string{yaml: yamlText, template: templateText} {
		if err := os.WriteFile(name, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, order := range [][]string{{yaml, template}, {template, yaml}} {
		args := append([]string{"check", "--root", root, "--fix"}, order...)
		code, _, stderr := invoke(t, "", args...)
		if code != 2 || !strings.Contains(stderr, "read-only") {
			t.Fatalf("mixed --fix: %d %s", code, stderr)
		}
		after, err := os.ReadFile(yaml)
		if err != nil || string(after) != yamlText {
			t.Fatal("mixed selection wrote YAML before preflight")
		}
	}
	for _, mode := range []string{"canonical", "lint-fixes"} {
		wire, stderr, code := invokeFormat(t, templateText, "format", "--root", root, "--mode", mode, "--stdin-filename", template, "-")
		if code != 0 || wire.Path != "literal.j2" || wire.SourceSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(templateText))) || wire.Status != "skipped" || len(wire.Edits) != 0 || !strings.Contains(wire.Reason, "read-only") {
			t.Fatalf("direct template format %s: %+v %s %d", mode, wire, stderr, code)
		}
	}
	for _, format := range []string{"json", "human", "concise", "github"} {
		code, out, stderr := invoke(t, "{% if a %}", "check", "--root", root, "--stdin-filename", template, "--format", format, "-")
		if code != 1 || !strings.Contains(out, "template-syntax") || strings.Contains(out, "fix_id") {
			t.Fatalf("template %s renderer: %d %s %s", format, code, out, stderr)
		}
	}
	code, out, stderr := invoke(t, "", "check", "--root", root, "--diff", yaml, template)
	if code != 1 || !strings.Contains(out, "input.yml") || strings.Contains(out, "literal.j2") {
		t.Fatalf("mixed diff: %d %s %s", code, out, stderr)
	}
	after, err := os.ReadFile(template)
	if err != nil || string(after) != templateText {
		t.Fatal("template changed")
	}
	code, out, stderr = invoke(t, templateText, "check", "--root", root, "--stdin-filename", template, "--format", "json", "-")
	if code != 0 || strings.Contains(out, "jinja-layout") {
		t.Fatalf("template layout policy: %d %s %s", code, out, stderr)
	}
}

func TestTemplateNarrowRootAndAliasRemainReadOnly(t *testing.T) {
	projectRoot := t.TempDir()
	narrow := filepath.Join(projectRoot, "roles/demo/templates")
	if err := os.MkdirAll(narrow, 0755); err != nil {
		t.Fatal(err)
	}
	template := filepath.Join(narrow, "config.yaml")
	input := "---\nv: [1,2]\n"
	if err := os.WriteFile(template, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(narrow, "alias.yaml")
	if err := os.Symlink("config.yaml", alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	for _, filename := range []string{template, alias} {
		for _, mode := range []string{"canonical", "lint-fixes"} {
			wire, stderr, code := invokeFormat(t, input, "format", "--root", narrow, "--mode", mode, "--stdin-filename", filename, "-")
			if code != 0 || wire.Status != "skipped" || len(wire.Edits) != 0 || !strings.Contains(wire.Reason, "read-only") {
				t.Fatalf("narrow template format: %+v %s %d", wire, stderr, code)
			}
		}
		code, out, stderr := invoke(t, "", "check", "--root", narrow, "--fix", filename)
		if code != 2 || !strings.Contains(stderr, "read-only") {
			t.Fatalf("narrow template fix: %d %s %s", code, out, stderr)
		}
	}
	yaml := filepath.Join(narrow, "input.yml")
	if err := os.WriteFile(yaml, []byte("value: \"{{ value\n }}\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := invoke(t, "", "check", "--root", narrow, "--fix", yaml, template)
	if code != 2 || !strings.Contains(stderr, "read-only") {
		t.Fatalf("narrow mixed preflight: %d %s", code, stderr)
	}
	after, err := os.ReadFile(template)
	if err != nil || string(after) != input {
		t.Fatal("physical template changed")
	}
}

func TestTemplateCanonicalAliasFormatterAndMixedPreflight(t *testing.T) {
	root := t.TempDir()
	templates := filepath.Join(root, "roles/demo/templates")
	if err := os.MkdirAll(templates, 0755); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(templates, "config.yaml")
	input := "{% if enabled %}{{ value }}{% endif %}  "
	if err := os.WriteFile(original, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias.yaml")
	if err := os.Symlink(original, alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	for _, mode := range []string{"canonical", "lint-fixes"} {
		wire, stderr, code := invokeFormat(t, input, "format", "--root", root, "--mode", mode, "--stdin-filename", alias, "-")
		if code != 0 || wire.Path != "alias.yaml" || wire.SourceSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(input))) || wire.Status != "skipped" || len(wire.Edits) != 0 {
			t.Fatalf("canonical alias format: %+v %s %d", wire, stderr, code)
		}
	}
	yaml := filepath.Join(root, "input.yml")
	yamlInput := "v: \"{{ value\n }}\"\n"
	if err := os.WriteFile(yaml, []byte(yamlInput), 0600); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := invoke(t, "", "check", "--root", root, "--fix", yaml, alias)
	if code != 2 || !strings.Contains(stderr, "read-only") {
		t.Fatalf("alias mixed fix: %d %s", code, stderr)
	}
	after, err := os.ReadFile(yaml)
	if err != nil || string(after) != yamlInput {
		t.Fatal("alias mixed preflight wrote YAML")
	}
	after, err = os.ReadFile(original)
	if err != nil || string(after) != input {
		t.Fatal("alias template bytes changed")
	}
}
