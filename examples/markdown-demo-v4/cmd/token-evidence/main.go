// Command token-evidence emits complete-source token scopes and theme styles.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"saltbox-lint-markdown-demo-v4/highlight"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 3 && len(os.Args) != 4 {
		return fmt.Errorf("usage: token-evidence SOURCE THEME [lexical|combined]")
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	ctx := context.Background()
	h, err := highlight.New(ctx)
	if err != nil {
		return err
	}
	defer h.Close(ctx)
	mode := "lexical"
	if len(os.Args) == 4 {
		mode = os.Args[3]
	}
	var result any
	switch mode {
	case "lexical":
		result, err = h.Highlight(ctx, string(data), os.Args[2])
	case "combined":
		result, err = h.HighlightDocument(ctx, string(data), os.Args[2], highlight.DocumentOptions{SourcePath: os.Args[1]})
	default:
		return fmt.Errorf("unsupported evidence mode %q", mode)
	}
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}
