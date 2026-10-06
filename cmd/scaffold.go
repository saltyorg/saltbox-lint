package cmd

import (
	"fmt"

	"github.com/saltyorg/saltbox-lint/scaffold"
	"github.com/spf13/cobra"
)

func newScaffoldCommand() *cobra.Command {
	var options scaffold.Options
	var write bool
	command := &cobra.Command{Use: "scaffold", Short: "Preview or explicitly create new validated sources", Args: cobra.NoArgs}
	role := &cobra.Command{
		Use: "role NAME", Short: "Preview a minimal validated defaults/tasks role",
		Long: "Preview every proposed path and its complete contents without creating files. Supply an existing unambiguous Saltbox/Sandbox root with a physical roles directory and honest project metadata. Sandbox authors default to salty.\n\nUse --write to exclusively create a new role. Existing targets are refused. Partial failures retain and report created paths. No inventory, project marker, template or application profile is generated; role contents are never executed.\nExit status: 0 previewed or created, 2 usage, validation, output or creation failure.",
		Args: cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			options.Name = args[0]
			plan, err := scaffold.Role(command.Context(), options)
			if err != nil {
				return err
			}
			if _, err := fmt.Fprintf(command.OutOrStdout(), "Root: %s\n", plan.Root()); err != nil {
				return err
			}
			for _, file := range plan.Files() {
				if _, err := fmt.Fprintf(command.OutOrStdout(), "\n=== %s ===\n%s", file.Path, file.Content); err != nil {
					return err
				}
			}
			if !write {
				_, err := fmt.Fprintln(command.OutOrStdout(), "\nPreview only. Use --write to create these new files.")
				return err
			}
			created, writeErr := plan.Write(command.Context())
			for _, path := range created {
				if _, err := fmt.Fprintf(command.ErrOrStderr(), "Created: %s\n", path); err != nil && writeErr == nil {
					writeErr = err
				}
			}
			return writeErr
		},
	}
	role.Flags().StringVar(&options.Root, "root", "", "Existing Saltbox or Sandbox project root (required)")
	role.Flags().StringVar(&options.Title, "title", "", "Honest project title for both source headers (required)")
	role.Flags().StringVar(&options.Author, "author", "", "Source author attribution (required for Saltbox; salty for Sandbox)")
	role.Flags().StringVar(&options.URL, "url", "", "HTTP or HTTPS project URL for both source headers (required)")
	role.Flags().BoolVar(&write, "write", false, "Explicitly create the advertised new role; never overwrite")
	command.AddCommand(role)
	return command
}
