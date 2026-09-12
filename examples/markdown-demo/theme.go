package main

import (
	"fmt"
	"os"

	"charm.land/lipgloss/v2"
	"github.com/alecthomas/chroma/v2"
	"github.com/charmbracelet/x/term"
)

func demoTheme(requested string) (string, error) {
	switch requested {
	case "dark", "light":
		return requested, nil
	case "auto":
	default:
		return "", fmt.Errorf("unknown theme %q: use auto, dark, or light", requested)
	}
	if !term.IsTerminal(os.Stdout.Fd()) {
		return "dark", nil
	}
	// Query the controlling terminal rather than a potentially piped input.
	// Lip Gloss bounds the query and defaults to dark when unsupported.
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return "dark", nil
	}
	defer tty.Close()
	if !lipgloss.HasDarkBackground(tty, tty) {
		return "light", nil
	}
	return "dark", nil
}

// One Dark Pro's palette, with a One Light companion for white backgrounds.
// Chroma's YAML token classifications are not VS Code's Ansible/Jinja grammar.
func demoPalette(theme string) (*chroma.Style, string, string, string, string) {
	foreground, comment := "#abb2bf", "#5c6370"
	red, green, yellow := "#e06c75", "#98c379", "#e5c07b"
	blue, purple, cyan, number := "#61afef", "#c678dd", "#56b6c2", "#d19a66"
	gutter := "#636d83"
	if theme == "light" {
		foreground, comment = "#383a42", "#696c77"
		red, green, yellow = "#e45649", "#50a14f", "#c18401"
		blue, purple, cyan, number = "#4078f2", "#a626a4", "#0184bc", "#986801"
		gutter = "#696c77"
	}
	palette := chroma.MustNewStyle("demo-one-"+theme, chroma.StyleEntries{
		chroma.Text: foreground, chroma.Punctuation: foreground,
		chroma.Comment: "italic " + comment,
		chroma.NameTag: red, chroma.NameAttribute: red, chroma.NameVariable: red,
		chroma.NameFunction: blue, chroma.NameClass: yellow,
		chroma.Keyword: purple, chroma.KeywordConstant: number,
		chroma.LiteralString: green, chroma.LiteralNumber: number,
		chroma.Operator: cyan,
	})
	return palette, foreground, blue, red, gutter
}
