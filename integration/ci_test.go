package integration_test

import (
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// These are delivery contracts: adding a release target must also add native
// testing, and a Linux failure must not suppress other platforms' source tests.
func TestCICoversReleaseTargets(t *testing.T) {
	type target struct {
		Runner string
		Target string
		Alpine string
		Race   bool
	}
	// needs accepts either a scalar or a list in Actions. Only decode the matrix
	// here; the dependency contract below inspects the generic representation.
	var ci struct {
		Jobs map[string]struct {
			Strategy struct {
				FailFast *bool `yaml:"fail-fast"`
				Matrix   struct{ Include []target }
			}
		}
	}
	readYAML(t, "../.github/workflows/ci.yml", &ci)
	var release struct {
		Builds []struct{ Goos, Goarch []string }
	}
	readYAML(t, "../.goreleaser.yaml", &release)
	want := map[string]bool{}
	for _, build := range release.Builds {
		for _, goos := range build.Goos {
			for _, arch := range build.Goarch {
				want[goos+"/"+arch] = true
			}
		}
	}
	native := ci.Jobs["native"]
	acceptance := ci.Jobs["acceptance"]
	if native.Strategy.FailFast == nil || *native.Strategy.FailFast ||
		acceptance.Strategy.FailFast == nil || *acceptance.Strategy.FailFast {
		t.Fatal("all platforms must finish even when another platform fails")
	}
	if !reflect.DeepEqual(native.Strategy.Matrix, acceptance.Strategy.Matrix) {
		t.Fatal("source and packaged acceptance matrices must match")
	}
	got := map[string]bool{}
	for _, target := range native.Strategy.Matrix.Include {
		platform, arch, ok := strings.Cut(target.Target, "-")
		if !ok || target.Runner == "" {
			t.Fatalf("invalid native target: %+v", target)
		}
		if platform == "win32" {
			platform = "windows"
		}
		if arch == "x64" {
			arch = "amd64"
		}
		pair := platform + "/" + arch
		if got[pair] {
			t.Fatalf("duplicate native target %s", pair)
		}
		got[pair] = true
		if target.Race != (pair != "windows/arm64") {
			t.Errorf("unexpected race coverage for %s", pair)
		}
		if platform == "linux" && target.Alpine != strings.Replace(target.Target, "linux-", "alpine-", 1) {
			t.Errorf("missing matching musl acceptance for %s", pair)
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("CI targets %v differ from release targets %v", got, want)
	}
}

func TestCIRequiresAllPlatforms(t *testing.T) {
	var ci struct{ Jobs map[string]map[string]any }
	readYAML(t, "../.github/workflows/ci.yml", &ci)
	if needs := ci.Jobs["native"]["needs"]; needs != nil {
		t.Fatalf("native source checks must run independently of packaging: needs=%v", needs)
	}
	required := ci.Jobs["required"]
	if required["if"] != "always()" {
		t.Fatal("required result must run even when dependencies fail or skip")
	}
	needs, ok := required["needs"].([]any)
	if !ok {
		t.Fatal("required result must list its dependencies")
	}
	for name := range ci.Jobs {
		if name != "required" && !slices.Contains(needs, any(name)) {
			t.Errorf("required result omits job %s", name)
		}
	}
	// Keep the native tool version aligned with the local quality gate.
	makefile, err := os.ReadFile("../Makefile")
	if err != nil {
		t.Fatal(err)
	}
	workflow, err := os.ReadFile("../.github/workflows/ci.yml")
	if err != nil {
		t.Fatal(err)
	}
	for line := range strings.SplitSeq(string(makefile), "\n") {
		if version, ok := strings.CutPrefix(line, "GOLANGCI_VERSION := "); ok {
			if !strings.Contains(string(workflow), "cmd/golangci-lint@"+version+" run") {
				t.Fatal("native CI and make check must use the same golangci-lint version")
			}
			return
		}
	}
	t.Fatal("Makefile golangci-lint pin missing")
}

func TestNativeExtensionPhasesHaveFailingDeadlines(t *testing.T) {
	type step struct {
		Name            string
		Run             string
		TimeoutMinutes  int  `yaml:"timeout-minutes"`
		ContinueOnError bool `yaml:"continue-on-error"`
	}
	var ci struct {
		Jobs map[string]struct{ Steps []step }
	}
	readYAML(t, "../.github/workflows/ci.yml", &ci)
	makefile, err := os.ReadFile("../Makefile")
	if err != nil {
		t.Fatal(err)
	}
	_, remaining, ok := strings.Cut(string(makefile), "extension-check:\n")
	if !ok {
		t.Fatal("Makefile extension-check target missing")
	}
	commands, _, _ := strings.Cut(remaining, "\n\n")
	var got []string
	for _, step := range ci.Jobs["native"].Steps {
		if !strings.HasPrefix(step.Run, "npm --prefix extension ") {
			continue
		}
		if step.Name == "" || step.TimeoutMinutes < 1 || step.TimeoutMinutes > 10 || step.ContinueOnError {
			t.Errorf("native extension phase requires a named failing deadline: %+v", step)
		}
		got = append(got, step.Run)
	}
	want := strings.Split(strings.TrimSpace(commands), "\n")
	for i := range want {
		want[i] = strings.TrimSpace(want[i])
	}
	if !slices.Equal(got, want) {
		t.Fatalf("native extension phases %q differ from make check %q", got, want)
	}
}

func readYAML(t *testing.T, path string, value any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal(data, value); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}
