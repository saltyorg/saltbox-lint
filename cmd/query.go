package cmd

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/spf13/cobra"
)

func newQueryCommand() *cobra.Command {
	var request lint.QueryRequest
	command := &cobra.Command{
		Use:   "query --root ROOT --stdin-filename PATH --operation OP --offset BYTE -",
		Short: "Inspect definitions, completions, hover or static references for an editor snapshot",
		Long:  "Read one exact YAML or template snapshot from stdin and emit query schema 1. Operations are definition, completion, hover and references. Templates support read-only inspection and never completion edits. Locations describe source declarations, never runtime values. Coverage remains explicitly incomplete for runtime template behavior, dynamic reads and runtime providers. No sources are written.\nExit status: 0 query generated, including unresolved results; 2 usage, loading or reporting failure.",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if args[0] != "-" || request.Filename == "" {
				return fmt.Errorf("query requires '-' and --stdin-filename")
			}
			data, err := io.ReadAll(io.LimitReader(command.InOrStdin(), 16*1024*1024+1))
			if err != nil {
				return fmt.Errorf("read query stdin: %w", err)
			}
			if len(data) > 16*1024*1024 {
				return fmt.Errorf("query snapshot exceeds 16 MiB")
			}
			request.Source = data
			result, err := lint.Query(command.Context(), request)
			if err != nil {
				return err
			}
			return json.NewEncoder(command.OutOrStdout()).Encode(result)
		},
	}
	command.Flags().StringVar(&request.Root, "root", "", "Source root for identities and context")
	command.Flags().StringVar(&request.Filename, "stdin-filename", "", "Working-directory-relative filename for the snapshot")
	command.Flags().StringVar(&request.Operation, "operation", "definition", "Query: definition, completion, hover, references")
	command.Flags().IntVar(&request.Offset, "offset", -1, "Validated UTF-8 byte offset in the snapshot")
	return command
}
