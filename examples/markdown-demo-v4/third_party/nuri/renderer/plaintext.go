package renderer

import (
	"io"

	"github.com/frostybee/nuri/ast"
)

// RenderPlainText writes token content to w with no formatting.
func RenderPlainText(w io.Writer, result *ast.TokensResult) error {
	for i, line := range result.Tokens {
		if i > 0 {
			if _, err := io.WriteString(w, "\n"); err != nil {
				return err
			}
		}
		for _, tok := range line {
			if _, err := io.WriteString(w, tok.Content); err != nil {
				return err
			}
		}
	}
	return nil
}
