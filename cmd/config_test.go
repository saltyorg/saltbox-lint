package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInvalidProjectConfigurationRefusesFixes(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "example.yml")
	const original = "value: \"{{ value\n }}\"\n"
	if err := os.WriteFile(source, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".saltbox-lint"), []byte("namespace_sharng: {}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := invoke(t, "", "check", "--root", root, "--fix", source)
	if code != 2 || !strings.Contains(stderr, ".saltbox-lint") {
		t.Fatalf("invalid config status=%d stderr=%s", code, stderr)
	}
	after, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != original {
		t.Fatal("invalid configuration allowed source edits")
	}
}
