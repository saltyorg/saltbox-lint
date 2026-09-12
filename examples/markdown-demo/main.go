package main

import (
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"regexp"
	"strings"

	"charm.land/glamour/v2"
	"charm.land/glamour/v2/styles"
	"github.com/alecthomas/chroma/v2/formatters"
)

//go:embed example.md
var markdown string

//go:embed snippets.json
var snippetData []byte

func main() {
	requested := flag.String("theme", "auto", "Background theme: auto, dark, light")
	flag.Parse()
	theme, err := demoTheme(*requested)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	var snippets []snippet
	if err := json.Unmarshal(snippetData, &snippets); err != nil {
		panic(err)
	}
	blocks := regexp.MustCompile("(?ms)^```yaml\n(.*?)^```").FindAllStringSubmatch(markdown, -1)
	if len(blocks) != len(snippets) {
		panic("snippet metadata must match the YAML blocks")
	}
	for i, block := range blocks {
		snippets[i].Source = block[1]
	}
	palette, foreground, heading, failure, gutter := demoPalette(theme)
	formatters.Register("numbered-demo", numberedCode(snippets, palette, gutter))
	style := styles.DarkStyleConfig
	if theme == "light" {
		style = styles.LightStyleConfig
	}
	style.Document.Color = &foreground
	style.Heading.Color = &heading
	style.H1.BackgroundColor = nil
	style.H1.Color = &heading
	style.H2.Prefix = ""
	style.H3.Prefix = ""
	style.H3.Color = &failure
	style.H4.Prefix = ""
	style.H4.Color = &foreground
	style.HorizontalRule.Color = &gutter
	style.HorizontalRule.Format = "\n" + strings.Repeat("─", 72) + "\n"
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
