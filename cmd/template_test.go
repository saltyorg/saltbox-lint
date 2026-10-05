package cmd

import (
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
		if code != 0 || wire.Status != "skipped" || len(wire.Edits) != 0 || !strings.Contains(wire.Reason, "read-only") {
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
