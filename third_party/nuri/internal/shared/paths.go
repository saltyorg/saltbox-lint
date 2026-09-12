package shared

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Submodule paths (relative to repo root).
const (
	SubmoduleGrammarsDir = "grammars-themes/packages/tm-grammars/raw"
	SubmoduleThemesDir   = "grammars-themes/packages/tm-themes/themes"
	SubmoduleSamplesDir  = "grammars-themes/samples"
	BundleCoreGrammars   = "bundle/core/grammars"
	BundleCoreThemes     = "bundle/core/themes"
)

// Fixture testdata directories (relative to internal/fidelity package).
const (
	FixtureGoldenDir            = "testdata/golden"
	FixtureGoldenFullDir        = "testdata/golden-full"
	FixtureGoldenThemeStressDir = "testdata/golden-theme-stress"
	FixtureGoldenAllDir         = "testdata/golden-all"
)

// Fixture testdata directories (relative to repo root, for CI/tooling).
const (
	FixtureGoldenRepoPath            = "internal/fidelity/testdata/golden"
	FixtureGoldenFullRepoPath        = "internal/fidelity/testdata/golden-full"
	FixtureGoldenThemeStressRepoPath = "internal/fidelity/testdata/golden-theme-stress"
	FixtureGoldenAllRepoPath         = "internal/fidelity/testdata/golden-all"
)

var (
	repoRoot     string
	repoRootOnce sync.Once
)

// RepoRoot returns the absolute path to the repository root.
// It walks up from the current directory looking for go.mod.
func RepoRoot() string {
	repoRootOnce.Do(func() {
		dir, _ := os.Getwd()
		for {
			if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
				repoRoot = dir
				return
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				repoRoot = "."
				return
			}
			dir = parent
		}
	})
	return repoRoot
}

// GrammarsDir returns the absolute path to the submodule raw grammars.
// Calls t.Skip if the submodule isn't initialized.
func GrammarsDir(t testing.TB) string {
	t.Helper()
	dir := filepath.Join(RepoRoot(), SubmoduleGrammarsDir)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		t.Skip("grammars-themes submodule not initialized — run: git submodule update --init")
	}
	return dir
}

// ThemesDir returns the absolute path to the submodule themes.
// Calls t.Skip if the submodule isn't initialized.
func ThemesDir(t testing.TB) string {
	t.Helper()
	dir := filepath.Join(RepoRoot(), SubmoduleThemesDir)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		t.Skip("grammars-themes submodule not initialized — run: git submodule update --init")
	}
	return dir
}

// SamplesDir returns the absolute path to the submodule sample files.
// Calls t.Skip if the submodule isn't initialized.
func SamplesDir(t testing.TB) string {
	t.Helper()
	dir := filepath.Join(RepoRoot(), SubmoduleSamplesDir)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		t.Skip("grammars-themes submodule not initialized — run: git submodule update --init")
	}
	return dir
}
