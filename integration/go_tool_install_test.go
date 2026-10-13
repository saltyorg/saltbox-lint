//go:build linux

package integration_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPinnedToolMakeRecipesForwardPinsAndDestinations(t *testing.T) {
	source, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp("", "saltbox-tool-make-")
	if err != nil {
		t.Fatal(err)
	}
	released := true // No native work is admitted during fixture setup.
	t.Cleanup(func() {
		if !released {
			t.Logf("retained unverified native tool inputs: %s", root)
			return
		}
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("remove joined native tool inputs %s: %v", root, err)
		}
	})
	for _, name := range []string{
		"Makefile", "tools/install-go-tool.mjs", "tools/report-go-tool-output.mjs",
		"extension/test/support/host-failure.ts", "extension/scripts/owned-command.mjs",
		"extension/scripts/owned-command-posix.mjs", "extension/scripts/owned-group.mjs",
		"extension/src/native-group.ts",
	} {
		data, err := os.ReadFile(filepath.Join(source, name))
		if err != nil {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(root, name), data)
	}
	fixture := filepath.Join(source, "extension/test/testdata/go-tool-fixture.mjs")
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }
	goPath := filepath.Join(root, "fixture-bin", "go")
	writeFile(t, goPath, []byte("#!/bin/sh\nexec "+quote(node)+" "+quote(fixture)+" \"$@\"\n"))
	if err := os.Chmod(goPath, 0o755); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(root, "attempts.jsonl")
	command := exec.CommandContext(t.Context(), node, "--input-type=module", "-e", `
import { ownedCommand } from "./extension/scripts/owned-command.mjs";
import { writeFile } from "node:fs/promises";
let released=false, failed=false, original;
try {
  await ownedCommand("make", ["tools"], {phase:"copied Makefile tool recipes",stdio:"inherit",timeoutMs:300000});
  released=true;
} catch(error) {
  failed=true;original=error;
  released=error instanceof Error && error.ownershipReleased===true;
}
try {await writeFile("native-ownership.json",JSON.stringify({ownershipReleased:released}),{mode:0o600});}
catch(error) {throw failed ? new AggregateError([original,error],"Command and ownership recording failed",{cause:original}) : error;}
if(failed)throw original;
`)
	command.Dir = root
	command.Env = append(os.Environ(), "PATH="+filepath.Dir(goPath)+string(os.PathListSeparator)+os.Getenv("PATH"), "SALTBOX_TOOL_FIXTURE_STATE="+state, `SALTBOX_TOOL_FIXTURE_PLAN=["transient","success"]`)
	released = false
	output, commandErr := command.CombinedOutput()
	receiptBytes, receiptErr := os.ReadFile(filepath.Join(root, "native-ownership.json"))
	var ownership struct {
		Released *bool `json:"ownershipReleased"`
	}
	if receiptErr == nil {
		receiptErr = json.Unmarshal(receiptBytes, &ownership)
		if receiptErr == nil && ownership.Released == nil {
			receiptErr = os.ErrInvalid
		}
	}
	if receiptErr == nil {
		released = *ownership.Released
	}
	if commandErr != nil || receiptErr != nil || !released {
		t.Fatalf("actual Makefile tools: command=%v; ownership receipt=%v; released=%v; inputs=%s\n%s", commandErr, receiptErr, released, root, output)
	}
	data, err := os.ReadFile(state)
	if err != nil {
		t.Fatal(err)
	}
	type receipt struct {
		Target  string
		Attempt int
		Args    []string
		Gobin   string
	}
	var records []receipt
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var record receipt
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	want := []struct{ target, directory, binary string }{
		{"github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0", "golangci-lint-v2.14.0", "golangci-lint"},
		{"github.com/rhysd/actionlint/cmd/actionlint@v1.7.12", "actionlint-v1.7.12", "actionlint"},
		{"github.com/goreleaser/goreleaser/v2@v2.18.1", "goreleaser-v2.18.1", "goreleaser"},
		{"golang.org/x/vuln/cmd/govulncheck@v1.8.0", "govulncheck-v1.8.0", "govulncheck"},
	}
	if len(records) != 8 {
		t.Fatalf("got %d invocations, want two owned invocations for each of four tools", len(records))
	}
	for _, tool := range want {
		destination := filepath.Join(root, "bin", "tools", tool.directory)
		var matching []receipt
		for _, record := range records {
			if record.Target == tool.target {
				matching = append(matching, record)
			}
		}
		if len(matching) != 2 {
			t.Fatalf("tool %s has %d invocations, want two", tool.target, len(matching))
		}
		for attempt, record := range matching {
			if record.Target != tool.target || record.Attempt != attempt+1 || len(record.Args) != 2 || record.Args[0] != "install" || record.Args[1] != tool.target || filepath.Clean(record.Gobin) != destination {
				t.Fatalf("tool %s attempt %d: %+v", tool.target, attempt+1, record)
			}
		}
		if contents, err := os.ReadFile(filepath.Join(destination, tool.binary)); err != nil || string(contents) != "installed fixture\n" {
			t.Fatalf("tool %s installed bytes=%q error=%v", tool.target, contents, err)
		}
	}
}
