package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestCheckSARIFTraefikRelatedIdentity(t *testing.T) {
	adapter, err := os.ReadFile("../lint/testdata/traefik/adapter.good.yml")
	if err != nil {
		t.Fatal(err)
	}
	defaults := "example_role_nginx_web_subdomain: nginx\n"
	tasks := string(adapter) + string(adapter)
	var baseline []string
	for _, test := range []struct {
		name, defaults, tasks, selection string
	}{
		{"two identical includes", defaults, tasks, "."},
		{"selected defaults", defaults, tasks, "roles/example/defaults/main.yml"},
		{"moving related includes", defaults, "\n\n" + string(adapter) + "\n\n" + string(adapter), "roles/example/defaults/main.yml"},
		{"moving primary", "\n\n" + defaults, tasks, "."},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			for path, data := range map[string]string{"roles/example/defaults/main.yml": test.defaults, "roles/example/tasks/main.yml": test.tasks} {
				full := filepath.Join(root, path)
				if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(full, []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			code, wire, stderr := invoke(t, "", "check", "--root", root, "--format", "sarif", filepath.Join(root, test.selection))
			if code != 1 || stderr != "" {
				t.Fatalf("real-rule SARIF response: %d %s", code, stderr)
			}
			var log struct {
				Runs []struct {
					Results []struct {
						RuleID       string                `json:"ruleId"`
						Message      struct{ Text string } `json:"message"`
						Fingerprints map[string]string     `json:"partialFingerprints"`
					} `json:"results"`
				} `json:"runs"`
			}
			if err := json.Unmarshal([]byte(wire), &log); err != nil {
				t.Fatal(err)
			}
			var ids []string
			for _, result := range log.Runs[0].Results {
				if result.RuleID == "traefik-adapter-contract" && strings.HasPrefix(result.Message.Text, "namespaced web adapter nginx is missing defaults") {
					ids = append(ids, result.Fingerprints["saltboxLintContext/v1"])
				}
			}
			if len(ids) != 2 || ids[0] == "" || ids[0] == ids[1] {
				t.Fatalf("distinct real adapter includes must have distinct identities: %v", ids)
			}
			if baseline == nil {
				baseline = ids
			} else if !slices.Equal(ids, baseline) {
				t.Fatalf("selection, related/primary movement or checkout root changed identities: got %v want %v", ids, baseline)
			}
		})
	}
}

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
