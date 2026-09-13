// Test-only operational failure executable; never packaged in a VSIX.
package main

import (
	"fmt"
	"io"
	"os"
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
	if strings.Contains(string(source), "# hang") {
		time.Sleep(time.Minute)
		return
	}
	fmt.Print(`{"schema_version":1,"path":"roles/example/defaults/main.yml","status":"ready","source_sha256":"bad","edits":[]}`)
}
