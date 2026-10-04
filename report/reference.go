package report

import (
	"fmt"
	"io"
	"strings"

	"github.com/saltyorg/saltbox-lint/lint"
)

// RuleReference renders the same data used by the JSON registry and editor help.
func RuleReference(out io.Writer, registry lint.RuleRegistry) error {
	var b strings.Builder
	b.WriteString("# Rule reference\n\nGenerated from the rule registry. Run `make rules-update` to refresh it.\n\nThis reference describes source-built, unreleased functionality. The published v0.1.0 CLI does not export registry JSON or source explanations.\n\n")
	for _, rule := range registry.Rules {
		fmt.Fprintf(&b, "- [%s](#%s)\n", rule.ID, rule.ID)
	}
	for _, rule := range registry.Rules {
		kinds := make([]string, len(rule.Kinds))
		for i, kind := range rule.Kinds {
			kinds[i] = string(kind)
		}
		fmt.Fprintf(&b, "\n## %s\n\n%s\n\n%s\n\nSource kinds: %s. Scope: %s. Automatic fix: %t.\n\nExpected example:\n\n", rule.ID, rule.Summary, rule.Explanation, strings.Join(kinds, ", "), rule.Scope, rule.Fixable)
		referenceExample(&b, rule.GoodExample)
		b.WriteString("\nViolation example:\n\n")
		referenceExample(&b, rule.BadExample)
	}
	_, err := io.WriteString(out, b.String())
	return err
}
func referenceExample(out *strings.Builder, example string) {
	// A registry example may itself contain backticks. Choose a safe fence.
	fence := "```"
	for strings.Contains(example, fence) {
		fence += "`"
	}
	fmt.Fprintf(out, "%syaml\n%s\n%s\n", fence, strings.TrimSuffix(example, "\n"), fence)
}
