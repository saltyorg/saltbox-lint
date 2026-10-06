package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/report"
)

func statisticsResponse(t *testing.T, wire string) report.Statistics {
	t.Helper()
	var response struct {
		SchemaVersion int                `json:"schema_version"`
		Statistics    *report.Statistics `json:"statistics"`
		Diagnostics   []json.RawMessage  `json:"diagnostics"`
		Fixes         []json.RawMessage  `json:"fixes"`
	}
	if err := json.Unmarshal([]byte(wire), &response); err != nil {
		t.Fatal(err)
	}
	if response.SchemaVersion != 2 || response.Statistics == nil || response.Statistics.SchemaVersion != 1 || response.Statistics.DurationUnit != "milliseconds" || response.Statistics.Status != "complete" {
		t.Fatalf("statistics envelope: %s", wire)
	}
	counts := response.Statistics.Initial
	if response.Statistics.Rechecked != nil {
		counts = response.Statistics.Rechecked
	}
	if counts == nil || counts.Findings != len(response.Diagnostics) || counts.Fixes != len(response.Fixes) || counts.Selected+counts.Context != counts.Sources {
		t.Fatalf("counts disagree with report: %s", wire)
	}
	total := 0
	previous := ""
	for _, rule := range counts.Rules {
		if rule.RuleID <= previous || rule.Count <= 0 {
			t.Fatalf("rule order/count: %+v", counts.Rules)
		}
		total += rule.Count
		previous = rule.RuleID
	}
	if total != counts.Findings {
		t.Fatal("per-rule totals differ")
	}
	unavailable := false
	for _, phase := range response.Statistics.Phases {
		if phase.Duration != nil && (math.IsInf(*phase.Duration, 0) || math.IsNaN(*phase.Duration) || *phase.Duration < 0) {
			t.Fatalf("invalid timing: %+v", phase)
		}
		if phase.Name == "encoding_writing" {
			unavailable = phase.Status == "unavailable" && phase.Duration == nil
		} else if phase.Status != "complete" || phase.Duration == nil {
			t.Fatalf("unexpected phase: %+v", phase)
		}
	}
	if !unavailable {
		t.Fatal("JSON must not claim its own final encoding/write time")
	}
	return *response.Statistics
}

func TestCheckStatisticsJSONFixtures(t *testing.T) {
	heavy, err := os.ReadFile("../lint/testdata/statistics/diagnostic-heavy.yml")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, input string
		findings    int
		parseFailed int
	}{
		{"clean", "v: true\n", 0, 0},
		{"diagnostic-heavy", string(heavy), 9, 0},
		{"multiple findings", "v: \"{{ a\n | f }}\"\nx: \"{{ lookup('env', 'a' if x else 'b') }}\"\n", 2, 0},
		{"parse failure", "v: [\n", 1, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			t.Chdir(root)
			code, wire, stderr := invoke(t, test.input, "check", "-", "--stdin-filename", "unsaved.yml", "--format", "json", "--stats", "--include-analysis")
			if code == 2 || stderr != "" {
				t.Fatalf("stats invocation: %d %s", code, stderr)
			}
			statistics := statisticsResponse(t, wire)
			c := statistics.Initial
			if c.Sources != 1 || c.Selected != 1 || c.Context != 0 || c.Findings != test.findings || c.ParseFailedSources != test.parseFailed {
				t.Fatalf("counts: %+v", c)
			}
			plainCode, plain, plainErr := invoke(t, test.input, "check", "-", "--stdin-filename", "unsaved.yml", "--format", "json", "--include-analysis")
			var object map[string]json.RawMessage
			if err := json.Unmarshal([]byte(wire), &object); err != nil {
				t.Fatal(err)
			}
			delete(object, "statistics")
			var baseline map[string]json.RawMessage
			if err := json.Unmarshal([]byte(plain), &baseline); err != nil {
				t.Fatal(err)
			}
			candidate, _ := json.Marshal(object)
			expected, _ := json.Marshal(baseline)
			if plainCode != code || plainErr != "" || !bytes.Equal(candidate, expected) {
				t.Fatal("statistics changed diagnostics, fixes or dependencies")
			}
		})
	}
}

func TestCheckStatisticsSelectedContextAndTemplate(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{"roles/example/tasks/main.yml": "- name: Example\n  ansible.builtin.debug:\n    msg: true\n", "roles/example/defaults/main.yml": "v: [\n", "roles/example/templates/test.j2": "{{ missing }}\n"}
	for name, data := range files {
		file := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, selected := range []string{"roles/example/tasks/main.yml", "roles/example/templates/test.j2"} {
		code, wire, stderr := invoke(t, "", "check", "--root", root, filepath.Join(root, selected), "--format", "json", "--stats")
		if code == 2 || stderr != "" {
			t.Fatalf("%d %s", code, stderr)
		}
		c := statisticsResponse(t, wire).Initial
		if c.Selected != 1 || c.Context < 1 || c.ParseFailedSources != 1 || c.ParseFindings != 1 {
			t.Fatalf("context counts: %+v", c)
		}
		for _, rule := range c.Rules {
			if rule.RuleID == "yaml-syntax" {
				t.Fatal("context parse error counted as a selected finding")
			}
		}
	}
}

func TestCheckStatisticsPresentationAndFixRecheck(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "bad.yml")
	input := []byte("v: \"{{ a\n | f }}\"\n")
	if err := os.WriteFile(file, input, 0600); err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"human", "concise", "github", "sarif"} {
		args := []string{"check", file, "--format", format}
		code, plain, plainErr := invoke(t, "", args...)
		statsCode, wire, stderr := invoke(t, "", append(args, "--stats")...)
		if code != 1 || statsCode != code || wire != plain || plainErr != "" || !strings.HasPrefix(stderr, "Statistics v1 (complete;") || !strings.Contains(stderr, "rendering: complete") {
			t.Fatalf("presentation %s changed: %d %d %s", format, code, statsCode, stderr)
		}
	}
	for _, format := range []string{"human", "concise"} {
		args := []string{"check", file, "--diff", "--format", format}
		code, patch, plainErr := invoke(t, "", args...)
		statsCode, wire, stderr := invoke(t, "", append(args, "--stats")...)
		if code != 1 || statsCode != code || wire != patch || !strings.HasPrefix(stderr, plainErr+"Statistics v1") {
			t.Fatal("statistics changed diff or diagnostic bytes/order")
		}
	}
	code, wire, stderr := invoke(t, "", "check", file, "--fix", "--format", "json", "--stats")
	if code != 0 || stderr != "" {
		t.Fatalf("fix: %d %s", code, stderr)
	}
	s := statisticsResponse(t, wire)
	if s.Initial.Findings != 1 || s.Initial.Fixes != 1 || s.Rechecked == nil || s.Rechecked.Findings != 0 || s.PlannedFiles == nil || *s.PlannedFiles != 1 || s.AppliedFiles == nil || *s.AppliedFiles != 1 {
		t.Fatalf("fix counts: %+v", s)
	}
	fixed, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	code, wire, stderr = invoke(t, "", "check", file, "--fix", "--format", "json", "--stats")
	again, err := os.ReadFile(file)
	if err != nil || code != 0 || stderr != "" || !bytes.Equal(fixed, again) || *statisticsResponse(t, wire).AppliedFiles != 0 {
		t.Fatal("stats fix is not idempotent")
	}
}

func TestCheckStatisticsFailuresAndCancellation(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	for _, args := range [][]string{
		{"check", "missing.yml", "--stats", "--format", "json"},
		{"check", "--stats", "--format", "invalid"},
	} {
		code, wire, stderr := invoke(t, "", args...)
		if code != 2 || wire != "" || !strings.Contains(stderr, "Statistics v1 (") || !strings.Contains(stderr, "failed") || !strings.Contains(stderr, "saltbox-lint:") {
			t.Fatalf("failure changed: %d %s %s", code, wire, stderr)
		}
	}
	file := filepath.Join(root, "clean.yml")
	if err := os.WriteFile(file, []byte("v: true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"json", "human"} {
		var stderr bytes.Buffer
		command := NewRootCommand(Streams{Out: failWriter{}, Err: &stderr}, "test")
		command.SetArgs([]string{"check", file, "--format", format, "--stats"})
		// Human clean output has no diagnostic write; use a finding for this case.
		if format == "human" {
			if err := os.WriteFile(file, []byte("v: \"{{ a\n | f }}\"\n"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if err := command.ExecuteContext(t.Context()); !errors.Is(err, io.ErrClosedPipe) || !strings.Contains(stderr.String(), "failed") {
			t.Fatalf("output error lost: %v %s", err, stderr.String())
		}
	}
	command := NewRootCommand(Streams{Out: &bytes.Buffer{}, Err: failWriter{}}, "test")
	command.SetArgs([]string{"check", file, "--format", "concise", "--stats"})
	if err := command.ExecuteContext(t.Context()); !errors.Is(err, io.ErrClosedPipe) || errors.Is(err, errFindings) {
		t.Fatalf("statistics output error must be operational: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	var stderr bytes.Buffer
	command = NewRootCommand(Streams{Err: &stderr}, "test")
	command.SetArgs([]string{"check", file, "--stats"})
	if err := command.ExecuteContext(ctx); !errors.Is(err, context.Canceled) || !strings.Contains(stderr.String(), "input: failed") {
		t.Fatalf("cancellation lost: %v %s", err, stderr.String())
	}
}
