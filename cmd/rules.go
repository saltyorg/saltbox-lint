package cmd

import (
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/saltyorg/saltbox-lint/report"
	"github.com/spf13/cobra"
)

func newRulesCommand(rootOpts *rootOptions) *cobra.Command {
	return &cobra.Command{Use: "rules [id]", Short: "List policies or explain a rule with examples", Args: cobra.MaximumNArgs(1), RunE: func(command *cobra.Command, args []string) error {
		rules := lint.Rules()
		slices.SortFunc(rules, func(a, b lint.Rule) int { return strings.Compare(a.ID, b.ID) })
		if len(args) == 1 {
			for _, rule := range rules {
				if args[0] == rule.ID {
					human := resolveHumanOptions(command.Context(), command.OutOrStdout(), rootOpts.color, rootOpts.theme)
					if err := command.Context().Err(); err != nil {
						return err
					}
					return report.RenderRule(command.OutOrStdout(), rule, human)
				}
			}
			return fmt.Errorf("unknown rule %q", args[0])
		}
		var b strings.Builder
		for _, rule := range rules {
			fmt.Fprintf(&b, "%s: %s (fixable: %t)\n", rule.ID, rule.Summary, rule.Fixable)
		}
		_, err := io.WriteString(command.OutOrStdout(), b.String())
		return err
	}}
}
