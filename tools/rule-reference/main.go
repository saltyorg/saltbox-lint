// Command rule-reference explicitly refreshes or non-mutatingly checks the
// public registry reference. It never loads or evaluates project sources.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"

	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/saltyorg/saltbox-lint/report"
)

func main() {
	write := flag.Bool("write", false, "Write the generated reference")
	flag.Parse()
	var expected bytes.Buffer
	if err := report.RuleReference(&expected, lint.Registry()); err != nil {
		fail(err)
	}
	const destination = "docs/rules.md"
	if *write {
		if err := os.WriteFile(destination, expected.Bytes(), 0644); err != nil {
			fail(err)
		}
		return
	}
	actual, err := os.ReadFile(destination)
	if err != nil {
		fail(err)
	}
	if !bytes.Equal(actual, expected.Bytes()) {
		fail(fmt.Errorf("%s is stale; run make rules-update", destination))
	}
}
func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
