package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/charmbracelet/x/term"
)

func main() {
	os.Exit(run(
		context.Background(),
		os.Args[1:],
		os.Stdout,
		os.Stderr,
		func() bool { return term.IsTerminal(os.Stdout.Fd()) },
		queryControllingTerminal,
	))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer, outputIsTerminal func() bool, query backgroundQuery) int {
	flags := flag.NewFlagSet("markdown-demo-v4", flag.ContinueOnError)
	flags.SetOutput(stderr)
	requestedTheme := flags.String("theme", "auto", "background theme: auto, dark, light")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	theme, err := resolveTheme(*requestedTheme, outputIsTerminal, query)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}

	markdown, blocks, err := loadDemoDocument()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	highlighter, err := newRuntimeHighlighter(ctx)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer highlighter.Close(ctx) //nolint:errcheck

	rendered, err := renderMarkdown(ctx, markdown, highlighter, blocks, theme)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if _, err := io.WriteString(stdout, rendered); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}
