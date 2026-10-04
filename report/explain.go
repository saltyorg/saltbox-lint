package report

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/saltyorg/saltbox-lint/lint"
)

func RenderExplanation(out io.Writer, explanation lint.Explanation, format string) error {
	if format == "json" {
		return json.NewEncoder(out).Encode(explanation)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Source: %s (%s, %s)\nRoot: %s\nInput: %s\nDirectory discovery would select: %t\nExplicit selection: %s\nParse state: %s\nApplicable policies: %s\nDependency observations complete: %t\n", explanation.Source.Path, explanation.Source.Kind, explanation.Source.ParseState, explanation.Root, explanation.Input, explanation.DirectoryWouldSelect, explanation.ExplicitSelection, explanation.Source.ParseState, strings.Join(explanation.ApplicablePolicies, ", "), explanation.Dependencies.Complete)
	for _, message := range explanation.Source.ParseDiagnostics {
		fmt.Fprintf(&b, "Parse: %s\n", message)
	}
	for _, source := range explanation.LoadedContext {
		fmt.Fprintf(&b, "Context: %s (%s, %s)\n", source.Path, source.Kind, source.ParseState)
		for _, message := range source.ParseDiagnostics {
			fmt.Fprintf(&b, "  Parse: %s\n", message)
		}
	}
	for _, source := range explanation.Dependencies.Sources {
		for _, file := range source.Files {
			fmt.Fprintf(&b, "Dependency: %s (%s)\n", file.Path, file.State)
		}
		for _, dir := range source.Directories {
			fmt.Fprintf(&b, "Directory: %s (%s)\n", dir.Path, dir.State)
		}
	}
	for _, decision := range explanation.FixDecisions {
		fmt.Fprintf(&b, "Fix %s: %s. %s\n", decision.RuleID, decision.State, decision.Reason)
	}
	for _, message := range explanation.Unsupported {
		fmt.Fprintf(&b, "Unsupported: %s\n", message)
	}
	_, err := io.WriteString(out, b.String())
	return err
}
