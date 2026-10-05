package cmd

import (
	"fmt"

	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/saltyorg/saltbox-lint/report"
	"github.com/spf13/cobra"
)

func newReferencesCommand() *cobra.Command {
	opts := checkOptions{format: "json"}
	var format string
	command := &cobra.Command{
		Use:   "references [paths...]",
		Short: "Inspect static role lookup declaration candidates",
		Long:  "Inspect role_var and role_web reads without executing Ansible/Jinja or writing sources. Resolution describes declaration candidates, never runtime values or variable precedence. Templates remain context-only. With no paths, inspect the current directory.\nExit status: 0 query generated, including unresolved reads; 2 usage, loading or reporting failure.",
		RunE: func(command *cobra.Command, args []string) error {
			if format != "human" && format != "json" {
				return fmt.Errorf("unknown reference format %q", format)
			}
			load, err := opts.loadOptions(args, command.InOrStdin())
			if err != nil {
				return err
			}
			references, err := lint.References(command.Context(), load)
			if err != nil {
				return err
			}
			return report.RenderReferences(command.OutOrStdout(), references, format)
		},
	}
	command.Flags().StringVar(&opts.root, "root", "", "Source root for identities and context")
	command.Flags().StringVar(&opts.stdinFilename, "stdin-filename", "", "Working-directory-relative filename for '-' input")
	command.Flags().StringVar(&format, "format", "human", "Output format: human, json")
	return command
}
