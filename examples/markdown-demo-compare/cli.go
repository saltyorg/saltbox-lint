package compare

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/charmbracelet/x/term"
	v4 "saltbox-lint-markdown-demo-v4/highlight"
)

// Main is the shared process boundary for the two thin demonstration commands.
func Main(mode Mode) int {
	return run(context.Background(), mode, os.Args[1:], os.Stdout, os.Stderr, func() bool { return term.IsTerminal(os.Stdout.Fd()) }, queryControllingTerminal)
}

func run(ctx context.Context, mode Mode, args []string, stdout, stderr io.Writer, outputIsTerminal func() bool, query backgroundQuery) int {
	flags := flag.NewFlagSet("markdown-demo-"+string(mode), flag.ContinueOnError)
	flags.SetOutput(stderr)
	requested := flags.String("theme", "auto", "background theme: auto, dark, light")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(stderr, "unexpected positional arguments")
		return 2
	}
	theme, err := resolveTheme(*requested, outputIsTerminal, query)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	report, err := Demo()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	h, err := v4.New(ctx)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer h.Close(ctx) //nolint:errcheck
	rendered, err := Render(ctx, report, mode, theme, h)
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
