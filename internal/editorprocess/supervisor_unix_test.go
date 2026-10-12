//go:build !windows

package editorprocess

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const helperEnvironment = "SALTBOX_EDITORPROCESS_TEST_HELPER"

// This helper always runs in a separately owned process group. Tests never
// activate the fatal lifetime guard in the test runner's own group.
func TestSupervisorHelperProcess(t *testing.T) {
	mode := os.Getenv(helperEnvironment)
	if mode == "" {
		return
	}
	if mode == "owner" {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			os.Exit(43)
		}
		fmt.Println(listener.Addr().String())
		connection, err := listener.Accept()
		if err != nil {
			os.Exit(43)
		}
		var registration registrationRecord
		if json.NewDecoder(connection).Decode(&registration) != nil || registration.Token != strings.Repeat("a", 64) || registration.Type != "bind" || registration.Nonce != strings.Repeat("b", 64) {
			os.Exit(43)
		}
		if _, err := io.WriteString(connection, "{\"accepted\":true}\n"); err != nil {
			os.Exit(43)
		}
		fmt.Println("owner accepted")
		<-time.NewTimer(time.Hour).C
		os.Exit(0)
	}
	if err := StartFromEnvironment(); err != nil {
		fmt.Println("admission failed:", err)
		os.Exit(42)
	}
	if mode == "descendant" {
		fmt.Printf("descendant %d %d\n", os.Getpid(), syscall.Getpgrp())
		<-time.NewTimer(time.Hour).C
		os.Exit(0)
	}
	fmt.Println("admitted")
	if mode == "natural" {
		os.Exit(0)
	}
	descendant := exec.Command(os.Args[0], "-test.run=^TestSupervisorHelperProcess$")
	descendant.Env = helperEnv(os.Environ(), "descendant")
	descendant.Stdout, descendant.Stderr = os.Stdout, os.Stderr
	if err := descendant.Start(); err != nil {
		os.Exit(44)
	}
	// EOF from the test's explicit input owner ends ordinary payload work. The
	// guardian is not canceled by a defer while that work remains admitted.
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(0)
}

type registrationRecord struct {
	Token string `json:"token"`
	Type  string `json:"type"`
	Nonce string `json:"nonce"`
	PID   int    `json:"pid"`
	Group int    `json:"group"`
}

type helperChild struct {
	command *exec.Cmd
	input   *os.File
	reader  *os.File
	lines   chan string
	closed  chan struct{}
	output  []string
	readErr error
	waited  bool
}

func helperEnv(env []string, mode string) []string {
	return append(slices.DeleteFunc(slices.Clone(env), func(value string) bool {
		return strings.HasPrefix(value, helperEnvironment+"=")
	}), helperEnvironment+"="+mode)
}

func startHelper(t *testing.T, mode, address string) *helperChild {
	t.Helper()
	outputReader, outputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = outputReader.Close() })
	t.Cleanup(func() { _ = outputWriter.Close() })
	inputReader, inputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = inputReader.Close() })
	t.Cleanup(func() { _ = inputWriter.Close() })
	command := exec.Command(os.Args[0], "-test.run=^TestSupervisorHelperProcess$")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Env = helperEnv(slices.DeleteFunc(os.Environ(), func(value string) bool {
		return strings.HasPrefix(value, supervisorEnvironment+"=") || strings.HasPrefix(value, editorEnvironment+"=")
	}), mode)
	if address != "" {
		config, err := json.Marshal(configuration{Address: address, Token: strings.Repeat("a", 64), Nonce: strings.Repeat("b", 64)})
		if err != nil {
			t.Fatal(err)
		}
		command.Env = append(command.Env, editorEnvironment+"=1", supervisorEnvironment+"="+string(config))
	}
	command.Stdin, command.Stdout, command.Stderr = inputReader, outputWriter, outputWriter
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	_ = inputReader.Close()
	_ = outputWriter.Close()
	child := &helperChild{command: command, input: inputWriter, reader: outputReader, lines: make(chan string, 16), closed: make(chan struct{})}
	go func() {
		defer close(child.closed)
		scanner := bufio.NewScanner(outputReader)
		for scanner.Scan() {
			line := scanner.Text()
			child.output = append(child.output, line)
			child.lines <- line
		}
		child.readErr = scanner.Err()
	}()
	t.Cleanup(func() {
		_ = child.input.Close()
		if !child.waited {
			// This direct child is unreaped, so its group leader PID cannot have
			// been reused. Cleanup never signals an ID after Wait releases it.
			_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
			_ = command.Wait()
			child.waited = true
		}
		select {
		case <-child.closed:
		case <-time.After(5 * time.Second):
			t.Error("helper cleanup failed to join all inherited output writers")
			_ = child.reader.Close()
			<-child.closed
		}
	})
	return child
}

func (child *helperChild) nextLine(t *testing.T) string {
	t.Helper()
	select {
	case line := <-child.lines:
		return line
	case <-time.After(10 * time.Second):
		t.Fatal("helper readiness event did not arrive")
		return ""
	}
}

func (child *helperChild) wait(t *testing.T) error {
	t.Helper()
	select {
	case <-child.closed:
	case <-time.After(10 * time.Second):
		t.Fatal("helper and descendant output pipes did not close")
	}
	if child.readErr != nil {
		t.Fatal(child.readErr)
	}
	err := child.command.Wait()
	child.waited = true
	return err
}

func registrationListener(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}

func acceptRegistration(t *testing.T, listener net.Listener, child *helperChild) net.Conn {
	t.Helper()
	if err := listener.(*net.TCPListener).SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	connection, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	if err := connection.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var registration registrationRecord
	if err := json.NewDecoder(connection).Decode(&registration); err != nil {
		t.Fatal(err)
	}
	if registration.PID != child.command.Process.Pid || registration.Group != registration.PID || registration.Token != strings.Repeat("a", 64) || registration.Type != "bind" || registration.Nonce != strings.Repeat("b", 64) {
		t.Fatal("registration does not identify the authenticated live group leader")
	}
	return connection
}

func writeControl(t *testing.T, connection net.Conn, value string) {
	t.Helper()
	if _, err := io.WriteString(connection, value); err != nil {
		t.Fatal(err)
	}
}

func expectKilled(t *testing.T, err error) {
	t.Helper()
	status, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("expected killed group leader, got %v", err)
	}
	state, ok := status.Sys().(syscall.WaitStatus)
	if !ok || !state.Signaled() || state.Signal() != syscall.SIGKILL {
		t.Fatalf("unexpected guardian termination: %v", err)
	}
}

func TestSupervisorAdmissionAndNaturalExit(t *testing.T) {
	listener := registrationListener(t)
	child := startHelper(t, "natural", listener.Addr().String())
	connection := acceptRegistration(t, listener, child)
	writeControl(t, connection, "{\"accepted\":true}\n")
	if line := child.nextLine(t); line != "admitted" {
		t.Fatalf("payload did not run after acknowledged admission: %q", line)
	}
	if err := child.wait(t); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("normal process exit did not close its lifetime connection: %v", err)
	}
}

func TestSupervisorRejectsBeforePayload(t *testing.T) {
	for name, acknowledgement := range map[string]string{
		"rejected":  "{\"accepted\":false}\n",
		"invalid":   "not JSON\n",
		"unknown":   "{\"accepted\":true,\"extra\":true}\n",
		"oversized": strings.Repeat("x", maximumLineBytes+1) + "\n",
		"EOF":       "",
	} {
		t.Run(name, func(t *testing.T) {
			listener := registrationListener(t)
			child := startHelper(t, "natural", listener.Addr().String())
			connection := acceptRegistration(t, listener, child)
			if acknowledgement == "" {
				_ = connection.Close()
			} else {
				writeControl(t, connection, acknowledgement)
			}
			err := child.wait(t)
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 42 {
				t.Fatalf("expected admission rejection, got %v", err)
			}
			for _, line := range child.output {
				if line == "admitted" || strings.Contains(line, strings.Repeat("a", 32)) {
					t.Fatalf("rejected guard performed work or exposed its credential: %q", line)
				}
			}
		})
	}
}

func TestSupervisorConnectionFailureDeclinesPayload(t *testing.T) {
	listener := registrationListener(t)
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	child := startHelper(t, "natural", address)
	err := child.wait(t)
	if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 42 {
		t.Fatalf("expected connection failure before work, got %v", err)
	}
	for _, line := range child.output {
		if line == "admitted" || strings.Contains(line, strings.Repeat("a", 32)) {
			t.Fatal("failed connection admitted payload or exposed credential")
		}
	}
}

func TestSupervisorStopsDescendants(t *testing.T) {
	for name, control := range map[string]string{"stop": "{\"stop\":true}\n", "invalid control": "{\"stop\":false}\n", "owner EOF": ""} {
		t.Run(name, func(t *testing.T) {
			listener := registrationListener(t)
			child := startHelper(t, "leader", listener.Addr().String())
			connection := acceptRegistration(t, listener, child)
			writeControl(t, connection, "{\"accepted\":true}\n")
			if line := child.nextLine(t); line != "admitted" {
				t.Fatalf("payload admission failed: %q", line)
			}
			fields := strings.Fields(child.nextLine(t))
			if len(fields) != 3 || fields[0] != "descendant" || fields[2] != strconv.Itoa(child.command.Process.Pid) || fields[1] == fields[2] {
				t.Fatalf("descendant did not inherit its acknowledged group: %v", fields)
			}
			// Readiness is emitted after the nonleader calls StartFromEnvironment.
			// It cannot wait for a second registration or acquire a sibling owner.
			if control == "" {
				_ = connection.Close()
			} else {
				writeControl(t, connection, control)
			}
			expectKilled(t, child.wait(t))
		})
	}
}

func TestSupervisorActualOwnerLoss(t *testing.T) {
	owner := startHelper(t, "owner", "")
	child := startHelper(t, "leader", owner.nextLine(t))
	if line := owner.nextLine(t); line != "owner accepted" {
		t.Fatalf("owner failed to acknowledge registration: %q", line)
	}
	if line := child.nextLine(t); line != "admitted" {
		t.Fatalf("payload failed to start: %q", line)
	}
	if line := child.nextLine(t); !strings.HasPrefix(line, "descendant ") {
		t.Fatalf("descendant failed to start: %q", line)
	}
	if err := owner.command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	expectKilled(t, owner.wait(t))
	expectKilled(t, child.wait(t))
}
