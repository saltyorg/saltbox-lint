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
		Use: "explain PATH", Short: "Explain source selection, context and verified fix decisions",
		Long: "Explain one source without writing it or executing Ansible/Jinja. Use '-' with --stdin-filename for a buffer.\nExit status: 0 explanation generated, 2 usage, loading or reporting failure.",
		Args: cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if format != "human" && format != "json" {
				return fmt.Errorf("unknown explanation format %q", format)
			}
			load, err := opts.loadOptions(args, command.InOrStdin())
			if err != nil {
				return err
			}
			explanation, err := lint.Explain(command.Context(), load)
			if err != nil {
				return err
			}
			return report.RenderExplanation(command.OutOrStdout(), explanation, format)
		},
	}
	command.Flags().StringVar(&opts.root, "root", "", "Source root for identities and context")
	command.Flags().StringVar(&opts.stdinFilename, "stdin-filename", "", "Working-directory-relative filename for '-' input")
	command.Flags().StringVar(&format, "format", "human", "Output format: human, json")
	return command
}
