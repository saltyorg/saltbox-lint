package compare

import "github.com/frostybee/nuri"

// decorate overlays background only, after complete-source composition.
// Token slices and source bytes remain owned by the highlighter; split pieces
// retain foregrounds, font styles, and scopes without mutating the input.
func decorate(tokens []nuri.ThemedToken, emphasis Emphasis, background string) []nuri.ThemedToken {
	var result []nuri.ThemedToken
	position := 0
	for _, token := range tokens {
		end := position + len(token.Content)
		for start := position; start < end; {
			next, active := end, emphasis.WholeLine
			for _, span := range emphasis.Spans {
				if span.Start > start {
					next = min(next, span.Start)
				}
				if span.Start <= start && start < span.End {
					active = true
					next = min(next, span.End)
				}
			}
			piece := token
			piece.Content = token.Content[start-position : next-position]
			if active {
				piece.BgColor = background
			}
			result = append(result, piece)
			start = next
		}
		if token.Content == "" {
			result = append(result, token)
		}
		position = end
	}
	return result
}
