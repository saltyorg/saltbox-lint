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
