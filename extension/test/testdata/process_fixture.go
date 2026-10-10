// Test-only operational failure executable; never packaged in a VSIX.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"slices"
	"strings"
	"syscall"
	"time"
)

type processInstance struct {
	PID   int      `json:"pid"`
	Port  int      `json:"port"`
	Token string   `json:"token"`
	Args  []string `json:"args"`
}

// Report only fixed stages and error classes. Filesystem errors otherwise
// include private paths, and gate records contain nonces and instance tokens.
func reportFailure(stage string, err error) {
	record := struct {
		Stage      string  `json:"stage"`
		ErrorClass string  `json:"error_class"`
		Errno      *uint64 `json:"errno,omitempty"`
		PID        int     `json:"pid"`
		Operation  string  `json:"operation"`
	}{Stage: stage, ErrorClass: "other", PID: os.Getpid(), Operation: "other"}
	if len(os.Args) > 1 && (os.Args[1] == "format" || os.Args[1] == "check") {
		record.Operation = os.Args[1]
	}
	var errno syscall.Errno
	var syntax *json.SyntaxError
	var value *json.UnmarshalTypeError
	switch {
	case errors.As(err, &errno):
		record.ErrorClass = "errno"
		code := uint64(errno)
		record.Errno = &code
	case err == nil:
		record.ErrorClass = "invalid-input"
	case errors.As(err, &syntax), errors.As(err, &value):
		record.ErrorClass = "json"
	}
	data, marshalErr := json.Marshal(record)
	if marshalErr != nil {
		return
	}
	data = append(data, '\n')
	fmt.Fprintf(os.Stderr, "SALTBOX_TEST_FIXTURE_FAILURE %s", data)
	if filename := os.Getenv("SALTBOX_TEST_PROCESS_FAILURE_LOG"); filename != "" {
		file, openErr := os.OpenFile(filename, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if openErr != nil {
			return
		}
		// Diagnostic logging cannot replace the original process failure.
		_, _ = file.Write(data)
		_ = file.Close()
	}
}

func main() {
	var instance *processInstance
	if filename := os.Getenv("SALTBOX_TEST_PROCESS_INSTANCES"); filename != "" {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			reportFailure("instance-listen", err)
			os.Exit(2)
		}
		var nonce [32]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			reportFailure("instance-random", err)
			os.Exit(2)
		}
		token := hex.EncodeToString(nonce[:])
		instance = &processInstance{os.Getpid(), listener.Addr().(*net.TCPAddr).Port, token, os.Args[1:]}
		file, err := os.OpenFile(filename, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			reportFailure("instance-open", err)
			os.Exit(2)
		}
		writeErr := json.NewEncoder(file).Encode(instance)
		closeErr := file.Close()
		if writeErr != nil {
			reportFailure("instance-write", writeErr)
			os.Exit(2)
		}
		if closeErr != nil {
			reportFailure("instance-close", closeErr)
			os.Exit(2)
		}
		// The OS owns this endpoint for this process's lifetime. An exited
		// process, zombie, or reused PID cannot answer with this instance token.
		go func() {
			for {
				connection, err := listener.Accept()
				if err != nil {
					reportFailure("instance-accept", err)
					os.Exit(2)
				}
				_ = connection.SetWriteDeadline(time.Now().Add(time.Second))
				_, _ = io.WriteString(connection, token+"\n")
				_ = connection.Close()
			}
		}()
	}
	if filename := os.Getenv("SALTBOX_TEST_PROCESS_LOG"); filename != "" {
		file, err := os.OpenFile(filename, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			reportFailure("process-log-open", err)
			os.Exit(2)
		}
		_, err = fmt.Fprintln(file, os.Getpid(), strings.Join(os.Args[1:], " "))
		closeErr := file.Close()
		if err != nil {
			reportFailure("process-log-write", err)
			os.Exit(2)
		}
		if closeErr != nil {
			reportFailure("process-log-close", closeErr)
			os.Exit(2)
		}
	}
	source, err := io.ReadAll(os.Stdin)
	if err != nil {
		reportFailure("stdin-read", err)
		os.Exit(2)
	}
	if executable := os.Getenv("SALTBOX_TEST_REAL_CLI"); executable != "" {
		command := exec.Command(executable, os.Args[1:]...)
		command.Stdin = strings.NewReader(string(source))
		var output bytes.Buffer
		command.Stdout = &output
		command.Stderr = os.Stderr
		if os.Getenv("SALTBOX_TEST_PROCESS_FAIL") == "1" {
			fmt.Fprintln(os.Stderr, "test operational failure")
			os.Exit(2)
		}
		err := command.Run()
		gate := os.Getenv("SALTBOX_TEST_PROCESS_GATE")
		if prefix := os.Getenv("SALTBOX_TEST_PROCESS_GATE_PREFIX"); prefix != "" {
			matched := false
			for _, argument := range os.Args[1:] {
				if strings.HasPrefix(argument, prefix) {
					matched = true
					break
				}
			}
			if !matched {
				gate = ""
			}
		}
		if selection := os.Getenv("SALTBOX_TEST_PROCESS_GATE_PATHS"); selection != "" {
			var expected []string
			if err := json.Unmarshal([]byte(selection), &expected); err != nil {
				reportFailure("gate-selection-decode", err)
				os.Exit(2)
			}
			if len(expected) == 0 {
				reportFailure("gate-selection-empty", nil)
				os.Exit(2)
			}
			separator := slices.Index(os.Args[1:], "--")
			// A prefix also admits later chunks. Only the exact ordered selected
			// paths may publish this gate's readiness and hold their output.
			if separator < 0 || !slices.Equal(os.Args[separator+2:], expected) {
				gate = ""
			}
		}
		if gate != "" {
			ready := struct {
				PID      int              `json:"pid"`
				Args     []string         `json:"args"`
				Nonce    string           `json:"nonce"`
				Instance *processInstance `json:"instance"`
			}{os.Getpid(), os.Args[1:], os.Getenv("SALTBOX_TEST_PROCESS_GATE_NONCE"), instance}
			data, marshalErr := json.Marshal(ready)
			temporary := fmt.Sprintf("%s.ready.%d.tmp", gate, os.Getpid())
			if marshalErr != nil {
				reportFailure("readiness-marshal", marshalErr)
				os.Exit(2)
			}
			if err := os.WriteFile(temporary, data, 0o600); err != nil {
				reportFailure("readiness-write", err)
				os.Exit(2)
			}
			if err := os.Rename(temporary, gate+".ready"); err != nil {
				reportFailure("readiness-rename", err)
				os.Exit(2)
			}
			for {
				if _, err := os.Stat(gate); os.IsNotExist(err) {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
		if _, writeErr := os.Stdout.Write(output.Bytes()); writeErr != nil {
			reportFailure("stdout-write", writeErr)
			os.Exit(2)
		}
		if err != nil {
			if exit, ok := err.(*exec.ExitError); ok {
				os.Exit(exit.ExitCode())
			}
			reportFailure("child-start", err)
			os.Exit(2)
		}
		return
	}
	if strings.Contains(string(source), "# hang") {
		time.Sleep(time.Minute)
		return
	}
	fmt.Print(`{"schema_version":1,"path":"roles/example/defaults/main.yml","status":"ready","source_sha256":"bad","edits":[]}`)
}
