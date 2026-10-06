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

func TestNativeGoChecksShareLocalSourceScope(t *testing.T) {
	type step struct {
		Name  string
		Uses  string
		Run   string
		If    string
		Shell string
	}
	var ci struct {
		Jobs map[string]struct{ Steps []step }
	}
	readYAML(t, "../.github/workflows/ci.yml", &ci)
	makefile, err := os.ReadFile("../Makefile")
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{
		"node tools/go-check.mjs tidy",
		"node tools/go-check.mjs go vet",
		"node tools/go-check.mjs '$(GOLANGCI)' run",
		"node tools/go-check.mjs go test -race",
		"go -C third_party/nuri test -race . ./internal/grammar ./internal/tokenizer",
	} {
		if !strings.Contains(string(makefile), "\t"+command+"\n") {
			t.Errorf("local gate omits %q", command)
		}
	}
	want := map[string]string{
		"Native Go tests": "node tools/go-check.mjs go test",
		"Native Go race tests on supported targets":           "node tools/go-check.mjs go test -race",
		"Native vet and lint":                                 "node tools/go-check.mjs go vet\nnode tools/go-check.mjs go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run",
		"Native patched Nuri tests":                           "go -C third_party/nuri test . ./internal/grammar ./internal/tokenizer",
		"Native patched Nuri race tests on supported targets": "go -C third_party/nuri test -race . ./internal/grammar ./internal/tokenizer",
	}
	nodeReady := false
	windowsLauncherReady := false
	for _, step := range ci.Jobs["native"].Steps {
		if strings.HasPrefix(step.Uses, "actions/setup-node@") {
			nodeReady = true
		}
		if step.Name == "Verify Windows development process launcher" {
			windowsLauncherReady = step.If == "runner.os == 'Windows'" && step.Shell == "pwsh" && strings.Contains(step.Run, "$PSVersionTable.PSVersion.Major -lt 7")
		}
		command, ok := want[step.Name]
		if !ok {
			continue
		}
		if !nodeReady || !windowsLauncherReady || strings.TrimSpace(step.Run) != command {
			t.Errorf("native Go phase requires Node and shared scope: %+v", step)
		}
		if strings.Contains(step.Name, "race") && step.If != "matrix.race" {
			t.Errorf("native race exception changed: %+v", step)
		}
		delete(want, step.Name)
	}
	if len(want) != 0 {
		t.Fatalf("missing native Go phases: %v", want)
	}
}

func TestVulnerabilityGateUsesCanonicalCheckAndRetainsEvidence(t *testing.T) {
	makefile, err := os.ReadFile("../Makefile")
	if err != nil {
		t.Fatal(err)
	}
	scanner, err := os.ReadFile("../tools/vulnerability.mjs")
	if err != nil {
		t.Fatal(err)
	}
	_, pinLine, ok := strings.Cut(string(makefile), "GOVULNCHECK_VERSION := ")
	if !ok {
		t.Fatal("scanner pin missing")
	}
	pin, _, _ := strings.Cut(pinLine, "\n")
	if !strings.Contains(string(scanner), `export const scannerVersion = "`+pin+`";`) {
		t.Fatal("installed and validated scanner pins differ")
	}
	for _, line := range []string{
		"check: tools format-check extension-check docs-check vulnerability-check",
		"vulnerability-check: $(GOVULNCHECK)",
		"\tnode --test tools/vulnerability.test.mjs",
		"\tnode tools/vulnerability.mjs '$(GOVULNCHECK)' bin/vulnerability",
	} {
		if !strings.Contains(string(makefile), line+"\n") {
			t.Errorf("canonical vulnerability gate omits %q", line)
		}
	}
	var ci struct {
		Jobs map[string]struct {
			Steps []struct {
				Name            string
				Uses            string
				Run             string
				If              string
				ContinueOnError bool `yaml:"continue-on-error"`
				With            map[string]string
			}
		}
	}
	readYAML(t, "../.github/workflows/ci.yml", &ci)
	gate, artifact := false, false
	for name, job := range ci.Jobs {
		for _, step := range job.Steps {
			if step.Name == "Check, build and package local artifacts" {
				gate = name == "check" && !step.ContinueOnError && step.If == "" &&
					strings.Contains(step.Run, "make build release-artifacts") && strings.Contains(step.Run, "make build snapshot")
			}
			if step.With["name"] == "vulnerability-evidence" {
				artifact = name == "check" && !step.ContinueOnError && step.If == "always()" &&
					strings.HasPrefix(step.Uses, "actions/upload-artifact@") && step.With["path"] == "bin/vulnerability/*" &&
					step.With["if-no-files-found"] == "error"
			}
			if name != "check" && strings.Contains(step.Run, "vulnerability") {
				t.Fatal("centralized scan unexpectedly repeats outside the canonical check job")
			}
		}
	}
	if !gate || !artifact {
		t.Fatalf("required vulnerability check or failure evidence missing: gate=%v artifact=%v", gate, artifact)
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
