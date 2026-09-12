package main

import (
	"fmt"
	"io"
	"strconv"

	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/formatters"
)

// Number the highlighted lines, keeping the gutter out of the YAML lexer.
func numberedCode(firstLine int) chroma.Formatter {
	return chroma.FormatterFunc(func(w io.Writer, style *chroma.Style, iterator chroma.Iterator) error {
		lines := chroma.SplitTokensIntoLines(iterator.Tokens())
		width := len(strconv.Itoa(firstLine + len(lines) - 1))
		highlighter := formatters.Get("terminal256")
		for i, tokens := range lines {
			if _, err := fmt.Fprintf(w, "\x1b[38;5;244m%*d │\x1b[0m ", width, firstLine+i); err != nil {
				return err
			}
			if err := highlighter.Format(w, style, chroma.Literator(tokens...)); err != nil {
				return err
			}
		}
		return nil
	})
}
