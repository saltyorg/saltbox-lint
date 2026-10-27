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
		"Native vet and lint":                                 "node tools/go-check.mjs go vet\nnode tools/go-check.mjs go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run",
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

func TestCIJobSummariesObserveEveryPhaseAfterFailure(t *testing.T) {
	type step struct {
		ID              string
		Name            string
		Uses            string
		Run             string
		If              string
		Shell           string
		TimeoutMinutes  int  `yaml:"timeout-minutes"`
		ContinueOnError bool `yaml:"continue-on-error"`
		Env             map[string]string
	}
	var ci struct {
		Permissions map[string]string
		Jobs        map[string]struct {
			Permissions map[string]string
			Steps       []step
		}
	}
	readYAML(t, "../.github/workflows/ci.yml", &ci)
	if !reflect.DeepEqual(ci.Permissions, map[string]string{"contents": "read"}) {
		t.Fatalf("summaries must not expand workflow permissions: %v", ci.Permissions)
	}
	for _, name := range []string{"check", "native", "acceptance", "required"} {
		t.Run(name, func(t *testing.T) {
			job, ok := ci.Jobs[name]
			if !ok || len(job.Steps) == 0 {
				t.Fatal("required job has no reportable phases")
			}
			if len(job.Permissions) != 0 {
				t.Fatalf("summaries must not expand job permissions: %v", job.Permissions)
			}
			ids := map[string]bool{}
			summaries := 0
			for index, phase := range job.Steps {
				if phase.ID == "" || ids[phase.ID] {
					t.Errorf("phase %q requires a unique ID for observed outcomes: %q", phase.Name, phase.ID)
				}
				ids[phase.ID] = true
				if strings.HasPrefix(phase.Uses, "actions/checkout@") || strings.HasPrefix(phase.Uses, "actions/setup-node@") {
					if phase.If != "" {
						t.Errorf("source and runtime setup must retain normal failure conditions: %+v", phase)
					}
				}
				if phase.ID != "summary" && phase.Name != "Write job summary" {
					continue
				}
				summaries++
				if index != len(job.Steps)-1 || phase.ID != "summary" || phase.Name != "Write job summary" {
					t.Error("the job must have exactly one terminal summary")
				}
				if phase.If != "always()" || phase.Shell != "bash" || phase.TimeoutMinutes != 1 || phase.ContinueOnError {
					t.Errorf("summary requires bounded reporting after failed or cancelled phases: %+v", phase)
				}
				if phase.Env["CI_SUMMARY_STEPS"] != "${{ toJSON(steps) }}" || phase.Env["CI_SUMMARY_KIND"] != name {
					t.Errorf("summary must receive this job's actual step outcomes and kind: %v", phase.Env)
				}
				if phase.Env["CI_SUMMARY_JOB_STATUS"] != "${{ job.status }}" {
					t.Error("summary must preserve the job's current failed or cancelled status")
				}
				if (name == "native" || name == "acceptance") && phase.Env["CI_SUMMARY_TARGET"] != "${{ matrix.target }}" {
					t.Error("matrix summary must identify the actual target")
				}
				for _, required := range []string{"command -v node", "tools/ci-summary.mjs", "GITHUB_STEP_SUMMARY", "else", "unavailable"} {
					if !strings.Contains(strings.ToLower(phase.Run), strings.ToLower(required)) {
						t.Errorf("summary lacks a renderer prerequisite or truthful fallback: %q", required)
					}
				}
				if !strings.Contains(phase.Run, "-f tools/ci-summary.mjs") {
					t.Error("summary must handle an unavailable checkout before invoking the renderer")
				}
			}
			if summaries != 1 {
				t.Fatalf("want one terminal summary, got %d", summaries)
			}
		})
	}
}

func TestCISummaryInputsMatchRequiredChecks(t *testing.T) {
	type step struct {
		ID              string
		Name            string
		Uses            string
		Run             string
		If              string
		ContinueOnError bool `yaml:"continue-on-error"`
		Env             map[string]string
	}
	var ci struct {
		Jobs map[string]struct {
			Steps []step
		}
	}
	readYAML(t, "../.github/workflows/ci.yml", &ci)
	reported := map[string]map[string]string{
		"check": {
			"Check, build and package local artifacts":                            "build_package",
			"Rebuild from the matching source with dependency downloads disabled": "source_rebuild",
			"Retain required vulnerability scan evidence":                         "vulnerability_upload",
		},
		"native": {
			"Verify native runner architecture":                   "architecture",
			"Verify Windows development process launcher":         "windows_launcher",
			"Native Go tests":                                     "go_tests",
			"Native patched Nuri tests":                           "nuri_tests",
			"Native Go race tests on supported targets":           "go_race",
			"Native patched Nuri race tests on supported targets": "nuri_race",
			"Native vet and lint":                                 "vet_lint",
			"Install native extension dependencies":               "dependencies",
			"Build native extension":                              "build",
			"Native extension unit tests":                         "unit_tests",
			"Native extension release tests":                      "release_tests",
			"Check native extension formatting":                   "format",
		},
		"acceptance": {
			"Packaged CLI tests and editor fixtures":           "package_tests",
			"Install editor host dependencies":                 "editor_dependencies",
			"Installed VSIX minimum/current editor acceptance": "editor_tests",
			"Native musl packaged binary acceptance":           "alpine",
		},
	}
	for name, phases := range reported {
		t.Run(name, func(t *testing.T) {
			for _, phase := range ci.Jobs[name].Steps {
				want, ok := phases[phase.Name]
				if !ok {
					continue
				}
				if phase.ID != want {
					t.Errorf("summary input for %q requires ID %q, got %q", phase.Name, want, phase.ID)
				}
				delete(phases, phase.Name)
			}
			if len(phases) != 0 {
				t.Fatalf("summary inputs omit required phases: %v", phases)
			}
		})
	}
	for _, name := range []string{"check", "native", "acceptance", "required"} {
		checkout, node := false, false
		gate := false
		for _, phase := range ci.Jobs[name].Steps {
			if strings.HasPrefix(phase.Uses, "actions/checkout@") {
				checkout = phase.ID == "checkout" && phase.If == ""
			}
			if strings.HasPrefix(phase.Uses, "actions/setup-node@") {
				node = phase.ID == "node_setup" && phase.If == ""
			}
			for prefix, id := range map[string]string{
				"actions/setup-go@":          "go_setup",
				"actions/download-artifact@": "download_artifacts",
			} {
				if strings.HasPrefix(phase.Uses, prefix) && phase.ID != id {
					t.Errorf("%s summary input for %s requires ID %q, got %q", name, prefix, id, phase.ID)
				}
			}
			if strings.HasPrefix(phase.Run, "npm install --global ") && phase.ID != "npm_setup" {
				t.Errorf("%s summary must observe npm setup", name)
			}
			if name == "required" && phase.Name == "Require every build and acceptance job to succeed" {
				gate = true
				if !checkout || !node || phase.ContinueOnError || phase.If != "" {
					t.Error("the required gate must retain normal failing execution after reporter prerequisites")
				}
				if !reflect.DeepEqual(phase.Env, map[string]string{
					"CHECK_RESULT":      "${{ needs.check.result }}",
					"NATIVE_RESULT":     "${{ needs.native.result }}",
					"ACCEPTANCE_RESULT": "${{ needs.acceptance.result }}",
				}) || strings.TrimSpace(phase.Run) != `[[ "$CHECK_RESULT" == success && "$NATIVE_RESULT" == success && "$ACCEPTANCE_RESULT" == success ]]` {
					t.Error("reporting must preserve the exact required result check")
				}
			}
			if name == "required" && phase.ID == "summary" && phase.Env["CI_SUMMARY_NEEDS"] != "${{ toJSON(needs) }}" {
				t.Error("required summary must use actual dependency results")
			}
		}
		if !checkout || !node {
			t.Errorf("%s summary requires normal checkout and Node setup", name)
		}
		if name == "required" && !gate {
			t.Error("reporting must not remove the required result check")
		}
	}
	acceptance := ci.Jobs["acceptance"]
	var results, observed string
	for _, phase := range acceptance.Steps {
		switch phase.ID {
		case "editor_tests":
			results = phase.Env["SALTBOX_TEST_HOST_RESULTS_FILE"]
		case "summary":
			observed = phase.Env["CI_SUMMARY_HOST_RESULTS"]
		}
	}
	if !strings.HasPrefix(results, "${{ runner.temp }}/") || !strings.HasSuffix(results, ".json") {
		t.Fatalf("host step checkpoint must have a runner temporary path: %q", results)
	}
	if observed != results {
		t.Errorf("acceptance summary checkpoint %q differs from host step checkpoint %q", observed, results)
	}
}

// GoReleaser is pinned once in the Makefile. Packaging receives the installed
// path from make, so the release script cannot drift to a different version.
func TestReleasePackagingUsesMakefileGoReleaserPin(t *testing.T) {
	makefile, err := os.ReadFile("../Makefile")
	if err != nil {
		t.Fatal(err)
	}
	text := string(makefile)
	if !strings.Contains(text, "\nGORELEASER := $(TOOLS)/goreleaser-$(GORELEASER_VERSION)/goreleaser\n") {
		t.Fatal("Makefile GoReleaser path must derive from GORELEASER_VERSION")
	}
	for _, target := range []string{"snapshot", "release-artifacts"} {
		_, recipe, ok := strings.Cut(text, "\n"+target+": check\n")
		if !ok {
			t.Fatalf("Makefile %s target missing", target)
		}
		recipe, _, _ = strings.Cut(recipe, "\n\n")
		if !strings.HasPrefix(recipe, "\tSALTBOX_GORELEASER='$(GORELEASER)' npm --prefix extension run package") {
			t.Errorf("%s must pass the Makefile-pinned GoReleaser to packaging: %q", target, recipe)
		}
	}
	script, err := os.ReadFile("../extension/scripts/release.mjs")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(script), "goreleaser-v") {
		t.Error("release.mjs must not pin its own GoReleaser version")
	}
	if !strings.Contains(string(script), "process.env.SALTBOX_GORELEASER") {
		t.Error("release.mjs must run the GoReleaser path supplied by make")
	}
}

// The GitHub release is public; it must not precede the identity, checksum and
// package verification that the Marketplace upload already requires.
func TestReleaseVerifiesIdentityBeforePublishing(t *testing.T) {
	type step struct {
		Name string
		Run  string
		Env  map[string]string
	}
	var release struct {
		Jobs map[string]struct{ Steps []step }
	}
	readYAML(t, "../.github/workflows/release.yml", &release)
	identity := map[string]string{"RELEASE_TAG": "${{ github.ref_name }}", "RELEASE_COMMIT": "${{ github.sha }}"}
	for job, publisher := range map[string]string{
		"release":     "gh release create ",
		"marketplace": "node extension/scripts/publish-marketplace.mjs dist",
	} {
		// The marketplace publisher runs the same shared verification itself.
		verified, published := job == "marketplace", false
		for _, phase := range release.Jobs[job].Steps {
			if strings.TrimSpace(phase.Run) == "node extension/scripts/verify-release.mjs dist" {
				verified = reflect.DeepEqual(phase.Env, identity)
			}
			if strings.Contains(phase.Run, publisher) {
				published = true
				if !verified {
					t.Errorf("%s job publishes before verifying the tag, source identity and checksums", job)
				}
				if job == "marketplace" && !reflect.DeepEqual(phase.Env, identity) {
					t.Error("marketplace publisher must verify the triggering tag and commit")
				}
			}
		}
		if !published {
			t.Errorf("%s job publisher missing", job)
		}
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
