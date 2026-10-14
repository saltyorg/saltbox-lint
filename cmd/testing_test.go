package cmd

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	// Command fixtures must not publish into the runner's job summary. Tests of
	// summary behavior set their own private destination with t.Setenv.
	if err := os.Unsetenv("GITHUB_STEP_SUMMARY"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func TestCommandTestsLeaveRunnerSummaryUntouched(t *testing.T) {
	summary := filepath.Join(t.TempDir(), "runner-summary.md")
	want := []byte("Existing runner summary\n")
	if err := os.WriteFile(summary, want, 0600); err != nil {
		t.Fatal(err)
	}
	tests := []string{
		"TestTemplateCommandReadOnlyBoundaries",
		"TestThemeFlagPreservesMachineOutput",
		"TestColorPolicyIsIndependentFromFormat",
		"TestCheckStatisticsPresentationAndFixRecheck",
		"TestGitHubCheckAppendsSummary",
		"TestParseFailuresAreFindingsAndSummaryFailuresAreOperational",
		"TestCheckSARIFExitSelectionAndPlainOutput",
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.CommandContext(t.Context(), executable, "-test.run=^("+strings.Join(tests, "|")+")$", "-test.count=1", "-test.timeout=1m", "-test.v")
	child.Env = append(os.Environ(), "GITHUB_STEP_SUMMARY="+summary)
	out, err := child.CombinedOutput()
	if err != nil {
		t.Fatalf("command tests with a runner summary: %v\n%s", err, out)
	}
	for _, name := range tests {
		if !bytes.Contains(out, []byte("--- PASS: "+name+" ")) {
			t.Fatalf("child did not pass %s:\n%s", name, out)
		}
	}
	got, err := os.ReadFile(summary)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("command tests changed the runner summary:\n%s", got)
	}
}
