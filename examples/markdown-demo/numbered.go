package main

import (
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/formatters"
)

type snippet struct {
	FirstLine int `json:"firstLine"`
	Source    string
}

// Number highlighted YAML, reserving the same gutter across all findings.
func numberedCode(snippets []snippet, palette *chroma.Style, gutter string) chroma.Formatter {
	lastLine := 1
	for _, snippet := range snippets {
		lastLine = max(lastLine, snippet.FirstLine+strings.Count(snippet.Source, "\n")-1)
	}
	width := len(strconv.Itoa(lastLine))
	return chroma.FormatterFunc(func(w io.Writer, _ *chroma.Style, iterator chroma.Iterator) error {
		tokens := iterator.Tokens()
		var source strings.Builder
		for _, token := range tokens {
			source.WriteString(token.Value)
		}
		firstLine := 0
		for _, snippet := range snippets {
			if strings.TrimSuffix(snippet.Source, "\n") == strings.TrimSuffix(source.String(), "\n") {
				firstLine = snippet.FirstLine
				break
			}
		}
		if firstLine == 0 {
			return fmt.Errorf("missing source-line metadata for code block")
		}
		lines := chroma.SplitTokensIntoLines(tokens)
		highlighter := formatters.Get("terminal16m")
		gutterColor, err := strconv.ParseUint(strings.TrimPrefix(gutter, "#"), 16, 24)
		if err != nil {
			return err
		}
		for i, tokens := range lines {
			if _, err := fmt.Fprintf(w, "\x1b[38;2;%d;%d;%dm%*d │\x1b[0m ", gutterColor>>16, (gutterColor>>8)&255, gutterColor&255, width, firstLine+i); err != nil {
				return err
			}
			if err := highlighter.Format(w, palette, chroma.Literator(tokens...)); err != nil {
				return err
			}
		}
		return nil
	})
}
