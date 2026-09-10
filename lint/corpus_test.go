package lint_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/saltyorg/saltbox-lint/lint"
)

// TestCorpus is optional: ordinary tests never require consumer checkouts.
// It deliberately accepts current policy findings; it verifies consistent source
// selection, identity and conservative fix planning against real source bytes.
func TestCorpus(t *testing.T) {
	for _, name := range []string{"SALTBOX_LINT_SALTBOX_CORPUS", "SALTBOX_LINT_SANDBOX_CORPUS"} {
		t.Run(name, func(t *testing.T) {
			root := os.Getenv(name)
			if root == "" {
				t.Skip("set " + name + " to an explicit read-only corpus root")
			}
			root, err := filepath.Abs(root)
			if err != nil {
				t.Fatal(err)
			}
			started := time.Now()
			full := loadCorpus(t, lint.Options{Root: root, Paths: []string{root}})
			rules := lint.Rules()
			findings := lint.Analyze(full, rules)
			byPath := map[string][]lint.Diagnostic{}
			for _, d := range findings {
				byPath[d.Path] = append(byPath[d.Path], d)
			}
			paths := make([]string, 0, len(full.Selected))
			for path := range full.Selected {
				paths = append(paths, path)
			}
			slices.Sort(paths)
			kinds := map[lint.Kind]int{}
			stdinKinds := map[lint.Kind]bool{}
			manifest := sha256.New()
			stdinCount, validCount := 0, 0
			for _, path := range paths {
				source := full.Sources[path]
				kinds[source.Kind]++
				// Length delimiters keep the ordered path/content manifest unambiguous.
				_, _ = fmt.Fprintf(manifest, "%d:%s%d:", len(path), path, len(source.Data))
				_, _ = manifest.Write(source.Data)
				absolute := filepath.Join(root, filepath.FromSlash(path))
				selected := loadCorpus(t, lint.Options{Root: root, Paths: []string{absolute}})
				if len(selected.Selected) != 1 || !selected.Selected[path] {
					t.Fatalf("%s: single-file selection = %v", path, selected.Selected)
				}
				got := lint.Analyze(selected, rules)
				assertCorpusDiagnostics(t, path, got, byPath[path])
				if !stdinKinds[source.Kind] || len(got) > 0 {
					stdin := loadCorpus(t, lint.Options{Root: root, StdinFilename: absolute, Stdin: bytes.Clone(source.Data)})
					if stdin.Sources[path] == nil || stdin.Sources[path].Kind != source.Kind || !bytes.Equal(stdin.Sources[path].Data, source.Data) {
						t.Fatalf("%s: stdin lost source identity or bytes", path)
					}
					assertCorpusDiagnostics(t, path+" (stdin)", lint.Analyze(stdin, rules), got)
					stdinKinds[source.Kind] = true
					stdinCount++
				}
				if len(got) == 0 {
					changes, err := lint.PlanFixes(selected, got)
					if err != nil || len(changes) != 0 {
						t.Fatalf("%s: valid-source fix plan = %v, %v", path, changes, err)
					}
					validCount++
				}
			}
			// This test never calls WriteFixes; still verify every selected disk byte.
			for _, path := range paths {
				data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
				if err != nil || !bytes.Equal(data, full.Sources[path].Data) {
					t.Fatalf("%s: corpus changed during acceptance: %v", path, err)
				}
			}
			t.Logf("root=%s selected=%d findings=%d selected-equivalence=%d stdin-equivalence=%d valid-no-op=%d kinds=%v manifest-sha256=%x elapsed=%s", root, len(paths), len(findings), len(paths), stdinCount, validCount, kinds, manifest.Sum(nil), time.Since(started))
		})
	}
}

func loadCorpus(t *testing.T, options lint.Options) *lint.Project {
	t.Helper()
	project, err := lint.Load(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	return project
}

func assertCorpusDiagnostics(t *testing.T, path string, got, want []lint.Diagnostic) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: selected diagnostics differ from full-run primary locations: got=%+v want=%+v", path, got, want)
	}
	for i := range got {
		actual, err := json.Marshal(got[i])
		if err != nil {
			t.Fatal(err)
		}
		expected, err := json.Marshal(want[i])
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(actual, expected) {
			t.Fatalf("%s: diagnostic %d differs, including spans, related locations or fixes:\ngot %s\nwant %s", path, i, actual, expected)
		}
	}
}
