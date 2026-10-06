package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckSARIFExitSelectionAndPlainOutput(t *testing.T) {
	root := t.TempDir()
	selected := filepath.Join(root, "selected 😀.yml")
	unselected := filepath.Join(root, "other.yml")
	for _, path := range []string{selected, unselected} {
		if err := os.WriteFile(path, []byte("v: \"{{ a\n | f }}\"\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	summary := filepath.Join(root, "summary.txt")
	if err := os.WriteFile(summary, []byte("existing summary"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GITHUB_STEP_SUMMARY", summary)
	code, wire, stderr := invoke(t, "", "check", "--root", root, "--color", "always", "--format", "sarif", selected)
	var sarif struct {
		Version string `json:"version"`
		Runs    []struct {
			Tool struct {
				Driver struct {
					Version string `json:"version"`
				} `json:"driver"`
			} `json:"tool"`
			Results []struct {
				RuleID  string `json:"ruleId"`
				Message struct {
					Text string `json:"text"`
				} `json:"message"`
				Locations []struct {
					Physical struct {
						Artifact struct {
							URI string `json:"uri"`
						} `json:"artifactLocation"`
					} `json:"physicalLocation"`
				} `json:"locations"`
			} `json:"results"`
		} `json:"runs"`
	}
	if err := json.Unmarshal([]byte(wire), &sarif); err != nil {
		t.Fatal(err)
	}
	if code != 1 || stderr != "" || sarif.Version != "2.1.0" || len(sarif.Runs) != 1 || sarif.Runs[0].Tool.Driver.Version != "test-version" || strings.Contains(wire, "\x1b") {
		t.Fatalf("SARIF response: %d %s %s", code, wire, stderr)
	}
	jsonCode, jsonWire, jsonStderr := invoke(t, "", "check", "--root", root, "--format", "json", selected)
	var original struct {
		Diagnostics []struct {
			RuleID  string `json:"rule_id"`
			Message string `json:"message"`
		} `json:"diagnostics"`
	}
	if err := json.Unmarshal([]byte(jsonWire), &original); err != nil {
		t.Fatal(err)
	}
	if jsonCode != code || jsonStderr != "" || len(original.Diagnostics) == 0 || len(original.Diagnostics) != len(sarif.Runs[0].Results) {
		t.Fatal("selected JSON/SARIF counts differ")
	}
	for i, d := range original.Diagnostics {
		result := sarif.Runs[0].Results[i]
		if result.RuleID != d.RuleID || !strings.HasPrefix(result.Message.Text, d.Message) || strings.Contains(result.Locations[0].Physical.Artifact.URI, "other.yml") {
			t.Fatal("selected primary finding differs")
		}
	}
	before, err := os.ReadFile(summary)
	if err != nil || string(before) != "existing summary" {
		t.Fatal("SARIF appended a GitHub summary")
	}
	code, wire, stderr = invoke(t, "v: true\r\n", "check", "--root", root, "--format", "sarif", "--stdin-filename", selected, "-")
	if code != 0 || stderr != "" || !strings.Contains(wire, `"results":[]`) {
		t.Fatalf("clean SARIF: %d %s %s", code, wire, stderr)
	}
	code, wire, stderr = invoke(t, "v: [\n", "check", "--root", root, "--format", "sarif", "--stdin-filename", selected, "-")
	if code != 1 || stderr != "" || !strings.Contains(wire, `"ruleId":"yaml-syntax"`) {
		t.Fatalf("parser SARIF: %d %s %s", code, wire, stderr)
	}
	for _, args := range [][]string{{"--diff"}, {"--include-analysis"}, {filepath.Join(root, "missing.yml")}} {
		code, wire, stderr = invoke(t, "", append([]string{"check", "--root", root, "--format", "sarif"}, args...)...)
		if code != 2 || wire != "" || stderr == "" {
			t.Fatalf("usage/operation SARIF: %d %s %s", code, wire, stderr)
		}
	}
	// SARIF selection does not change the verifier or already-valid bytes.
	code, wire, stderr = invoke(t, "", "check", "--root", root, "--fix", "--format", "sarif", selected)
	if code != 0 || stderr != "" || !strings.Contains(wire, `"results":[]`) {
		t.Fatalf("SARIF fix/recheck: %d %s %s", code, wire, stderr)
	}
	fixed, err := os.ReadFile(selected)
	if err != nil {
		t.Fatal(err)
	}
	code, _, stderr = invoke(t, "", "check", "--root", root, "--fix", "--format", "sarif", selected)
	again, err := os.ReadFile(selected)
	if err != nil || code != 0 || stderr != "" || !bytes.Equal(fixed, again) {
		t.Fatal("SARIF fix is not idempotent")
	}
}
