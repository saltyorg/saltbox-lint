package cmd

import (
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/spf13/cobra"
)

func newRulesCommand() *cobra.Command {
	return &cobra.Command{Use: "rules [id]", Short: "List policies or explain a rule with examples", Args: cobra.MaximumNArgs(1), RunE: func(command *cobra.Command, args []string) error {
		rules := lint.Rules()
		slices.SortFunc(rules, func(a, b lint.Rule) int { return strings.Compare(a.ID, b.ID) })
		var b strings.Builder
		for _, rule := range rules {
			if len(args) == 1 && args[0] != rule.ID {
				continue
			}
			if len(args) == 0 {
				fmt.Fprintf(&b, "%s: %s (fixable: %t)\n", rule.ID, rule.Summary, rule.Fixable)
				continue
			}
			kinds := make([]string, len(rule.Kinds))
			for i, kind := range rule.Kinds {
				kinds[i] = string(kind)
			}
			fmt.Fprintf(&b, "%s: %s\n\n%s\n\nSource kinds: %s\nScope: %s\nFixable: %t\n\nGood example:\n%s\nBad example:\n%s\n", rule.ID, rule.Summary, rule.Explanation, strings.Join(kinds, ", "), rule.Scope, rule.Fixable, rule.GoodExample, rule.BadExample)
		}
		if b.Len() == 0 && len(args) == 1 {
			return fmt.Errorf("unknown rule %q", args[0])
		}
		_, err := io.WriteString(command.OutOrStdout(), b.String())
		return err
	}}
}
