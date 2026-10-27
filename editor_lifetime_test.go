package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	lifetimeRoleEnvironment    = "SALTBOX_LIFETIME_TEST_ROLE"
	lifetimeProjectEnvironment = "SALTBOX_LIFETIME_TEST_PROJECT"
	// The fake Git is this test binary under the name git. It reports to the
	// test's loopback listener and then hangs like Git on a stalled filesystem.
	fakeGitEnvironment = "SALTBOX_LIFETIME_FAKE_GIT"
	// lifetimeBound covers group signal delivery plus Windows Job teardown.
	lifetimeBound = 15 * time.Second
)

// init runs before test flag parsing, which would reject Git's arguments.
func init() {
	address := os.Getenv(fakeGitEnvironment)
	if address == "" || strings.TrimSuffix(strings.ToLower(filepath.Base(os.Args[0])), ".exe") != "git" {
		return
	}
	connection, err := net.Dial("tcp4", address)
	if err != nil {
		os.Exit(97)
	}
	if _, err := fmt.Fprintf(connection, "git %d\n", os.Getpid()); err != nil {
		os.Exit(97)
	}
	// Hang without output until terminated. Test cleanup closes the connection
	// so a survivor after a failed assertion still exits without signals.
	_, _ = io.Copy(io.Discard, connection)
	os.Exit(98)
}

// TestEditorLifetimeHelperProcess runs the real CLI entry point in a child
// started by an editor-like owner with an inherited lifetime pipe.
func TestEditorLifetimeHelperProcess(t *testing.T) {
	if os.Getenv(lifetimeRoleEnvironment) != "cli" {
		return
	}
	if project := os.Getenv(lifetimeProjectEnvironment); project != "" {
		os.Args = []string{"saltbox-lint", "check", "--format", "json", project}
	} else {
		os.Args = []string{"saltbox-lint", "--version"}
	}
	main()
}

// lifetimeEnvironment is the editor environment without inherited supervision
// or protocol variables from the test runner.
func lifetimeEnvironment(extra ...string) []string {
	env := slices.DeleteFunc(os.Environ(), func(value string) bool {
		name, _, _ := strings.Cut(value, "=")
		return slices.Contains([]string{"SALTBOX_LINT_EDITOR_PROCESS", "SALTBOX_LINT_EDITOR_LIFETIME", "SALTBOX_LINT_EDITOR_SUPERVISOR", lifetimeRoleEnvironment, lifetimeProjectEnvironment, fakeGitEnvironment, "GITHUB_STEP_SUMMARY"}, strings.ToUpper(name)) || strings.EqualFold(name, "PATH")
	})
	return append(env, append([]string{"SALTBOX_LINT_EDITOR_PROCESS=1", "SALTBOX_LINT_EDITOR_LIFETIME=3", lifetimeRoleEnvironment + "=cli"}, extra...)...)
}

func lifetimeArguments() []string {
	return []string{os.Args[0], "-test.run=^TestEditorLifetimeHelperProcess$"}
}

// installFakeGit places a copy of this test binary first in PATH as git.
func installFakeGit(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	name := "git"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	target := filepath.Join(directory, name)
	if err := os.Link(os.Args[0], target); err != nil {
		source, err := os.Open(os.Args[0])
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = source.Close() }()
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
		if err != nil {
			t.Fatal(err)
		}
		_, copyErr := io.Copy(output, source)
		if err := errors.Join(copyErr, output.Close()); err != nil {
			t.Fatal(err)
		}
	}
	return directory
}

func TestEditorLifetimeNormalCompletion(t *testing.T) {
	child := startLifetimeCLI(t, lifetimeArguments(), append(lifetimeEnvironment(), "PATH="+os.Getenv("PATH")))
	result := child.wait(t, lifetimeBound)
	if result.ownerLoss || result.code != 0 || !strings.HasPrefix(result.output, "saltbox-lint version") {
		t.Fatalf("normal editor invocation changed: %+v", result)
	}
}

func TestEditorLifetimeOwnerLossStopsHungGit(t *testing.T) {
	project := t.TempDir()
	if err := os.Mkdir(filepath.Join(project, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	path := installFakeGit(t) + string(os.PathListSeparator) + os.Getenv("PATH")
	child := startLifetimeCLI(t, lifetimeArguments(), lifetimeEnvironment(
		"PATH="+path,
		lifetimeProjectEnvironment+"="+project,
		fakeGitEnvironment+"="+listener.Addr().String(),
	))

	// Readiness: the CLI started a Git descendant that is now hung.
	if err := listener.(*net.TCPListener).SetDeadline(time.Now().Add(lifetimeBound)); err != nil {
		t.Fatal(err)
	}
	connection, err := listener.Accept()
	if err != nil {
		t.Fatalf("CLI did not start its Git descendant: %v", err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	reader := bufio.NewReader(connection)
	if err := connection.SetReadDeadline(time.Now().Add(lifetimeBound)); err != nil {
		t.Fatal(err)
	}
	line, err := reader.ReadString('\n')
	fields := strings.Fields(line)
	if err != nil || len(fields) != 2 || fields[0] != "git" {
		t.Fatalf("invalid Git readiness %q: %v", line, err)
	}
	if pid, err := strconv.Atoi(fields[1]); err != nil || pid == child.pid() {
		t.Fatalf("Git readiness does not identify a descendant: %q", line)
	}
	if child.exited() {
		t.Fatal("CLI exited before its owner was lost")
	}

	child.loseOwner(t)
	lost := time.Now()
	if err := connection.SetReadDeadline(lost.Add(lifetimeBound)); err != nil {
		t.Fatal(err)
	}
	// The fake Git never closes or writes while the test holds the connection;
	// EOF or reset means it terminated.
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("hung Git wrote after readiness")
	} else if errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("hung Git survived owner loss for %v", lifetimeBound)
	}
	result := child.wait(t, lifetimeBound)
	if !result.ownerLoss {
		t.Fatalf("CLI did not terminate through owner loss: %+v", result)
	}
	t.Logf("owner loss to Git and CLI termination: %v", time.Since(lost))
}

type lifetimeResult struct {
	code      int
	ownerLoss bool
	output    string
}
