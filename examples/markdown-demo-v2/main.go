package main

import (
	_ "embed"
	"fmt"
	"os"

	"charm.land/glamour/v2"
	"charm.land/glamour/v2/styles"
	"github.com/alecthomas/chroma/v2/formatters"
)

//go:embed example.md
var markdown string

func main() {
	formatters.Register("numbered-demo", numberedCode(99))
	style := styles.DarkStyleConfig
	style.H2.Prefix = ""
	style.H3.Prefix = ""
	renderer, err := glamour.NewTermRenderer(
		glamour.WithStyles(style),
		glamour.WithChromaFormatter("numbered-demo"),
	)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	rendered, err := renderer.Render(markdown)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Print(rendered)
}
