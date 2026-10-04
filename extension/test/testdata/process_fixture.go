// Test-only operational failure executable; never packaged in a VSIX.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"time"
)

func main() {
	if filename := os.Getenv("SALTBOX_TEST_PROCESS_INSTANCES"); filename != "" {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			os.Exit(2)
		}
		var nonce [32]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			os.Exit(2)
		}
		token := hex.EncodeToString(nonce[:])
		instance := struct {
			PID   int    `json:"pid"`
			Port  int    `json:"port"`
			Token string `json:"token"`
		}{os.Getpid(), listener.Addr().(*net.TCPAddr).Port, token}
		file, err := os.OpenFile(filename, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			os.Exit(2)
		}
		writeErr := json.NewEncoder(file).Encode(instance)
		closeErr := file.Close()
		if writeErr != nil || closeErr != nil {
			os.Exit(2)
		}
		// The OS owns this endpoint for this process's lifetime. An exited
		// process, zombie, or reused PID cannot answer with this instance token.
		go func() {
			for {
				connection, err := listener.Accept()
				if err != nil {
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
			os.Exit(2)
		}
		_, err = fmt.Fprintln(file, os.Getpid(), strings.Join(os.Args[1:], " "))
		closeErr := file.Close()
		if err != nil || closeErr != nil {
			os.Exit(2)
		}
	}
	source, err := io.ReadAll(os.Stdin)
	if err != nil {
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
		if gate := os.Getenv("SALTBOX_TEST_PROCESS_GATE"); gate != "" {
			if err := os.WriteFile(gate+".ready", nil, 0o600); err != nil {
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
			os.Exit(2)
		}
		if err != nil {
			if exit, ok := err.(*exec.ExitError); ok {
				os.Exit(exit.ExitCode())
			}
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
