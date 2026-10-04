package cmd

import (
	"fmt"

	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/saltyorg/saltbox-lint/report"
	"github.com/spf13/cobra"
)

func newExplainCommand() *cobra.Command {
	opts := checkOptions{format: "json"}
	var format string
	command := &cobra.Command{
		Use: "explain [PATH]", Short: "Explain source selection, context and verified fix decisions",
		Long: "Explain one source, or affected selection with --changed-since REF, without writing or executing Ansible/Jinja. Use '-' with --stdin-filename for a buffer.\nExit status: 0 explanation generated, 2 usage, loading or reporting failure.",
		Args: func(command *cobra.Command, args []string) error {
			if command.Flags().Changed("changed-since") {
				return cobra.NoArgs(command, args)
			}
			return cobra.ExactArgs(1)(command, args)
		},
		RunE: func(command *cobra.Command, args []string) error {
			if format != "human" && format != "json" {
				return fmt.Errorf("unknown explanation format %q", format)
			}
			if command.Flags().Changed("changed-since") && opts.changedSince == "" {
				return fmt.Errorf("--changed-since requires a nonempty revision")
			}
			load, err := opts.loadOptions(args, command.InOrStdin())
			if err != nil {
				return err
			}
			if opts.changedSince != "" {
				explanation, err := lint.ExplainChanged(command.Context(), load)
				if err != nil {
					return err
				}
				return report.RenderChangedExplanation(command.OutOrStdout(), explanation, format)
			}
			explanation, err := lint.Explain(command.Context(), load)
			if err != nil {
				return err
			}
			return report.RenderExplanation(command.OutOrStdout(), explanation, format)
		},
	}
	command.Flags().StringVar(&opts.changedSince, "changed-since", "", "Explain current worktree changes from an exact commit and affected primary sources")
	command.Flags().StringVar(&opts.root, "root", "", "Source root for identities and context")
	command.Flags().StringVar(&opts.stdinFilename, "stdin-filename", "", "Working-directory-relative filename for '-' input")
	command.Flags().StringVar(&format, "format", "human", "Output format: human, json")
	return command
}
