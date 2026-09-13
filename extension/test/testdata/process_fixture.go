// Test-only operational failure executable; never packaged in a VSIX.
package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

func main() {
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
