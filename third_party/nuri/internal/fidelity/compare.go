package fidelity

import (
	"fmt"
	"strings"
)

// DiffKind classifies a token mismatch between Shiki and nuri.
type DiffKind int

const (
	BoundaryMismatch DiffKind = iota // different start/end offsets
	ScopeMismatch                    // same span, different scopes
	StyleMismatch                    // same span+scopes, different color/fontStyle
	MissingToken                     // token present in expected, absent in actual
	ExtraToken                       // token present in actual, absent in expected
	HTMLMismatch                     // HTML output differs
)

func (k DiffKind) String() string {
	switch k {
	case BoundaryMismatch:
		return "BoundaryMismatch"
	case ScopeMismatch:
		return "ScopeMismatch"
	case StyleMismatch:
		return "StyleMismatch"
	case MissingToken:
		return "MissingToken"
	case ExtraToken:
		return "ExtraToken"
	case HTMLMismatch:
		return "HTMLMismatch"
	default:
		return "Unknown"
	}
}

// TokenDiff describes one difference between expected and actual tokens.
type TokenDiff struct {
	Line   int
	Kind   DiffKind
	Want   *FixtureToken
	Got    *FixtureToken
	Detail string
}

func (d TokenDiff) String() string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "line %d: %s", d.Line, d.Kind)
	if d.Detail != "" {
		fmt.Fprintf(&sb, " — %s", d.Detail)
	}
	if d.Want != nil {
		fmt.Fprintf(&sb, "\n  want: [%d:%d] %q color=%s scopes=%v", d.Want.Start, d.Want.End, d.Want.Text, d.Want.Color, d.Want.Scopes)
	}
	if d.Got != nil {
		fmt.Fprintf(&sb, "\n  got:  [%d:%d] %q color=%s scopes=%v", d.Got.Start, d.Got.End, d.Got.Text, d.Got.Color, d.Got.Scopes)
	}
	return sb.String()
}

// CompareThemeTokens walks expected and actual token lists in lockstep,
// classifying the first divergence per token. Returns nil if identical.
func CompareThemeTokens(want, got [][]FixtureToken) []TokenDiff {
	var diffs []TokenDiff
	maxLines := len(want)
	if len(got) > maxLines {
		maxLines = len(got)
	}

	for line := 0; line < maxLines; line++ {
		if line >= len(want) {
			diffs = append(diffs, TokenDiff{
				Line:   line,
				Kind:   ExtraToken,
				Detail: fmt.Sprintf("extra line %d in actual output", line),
			})
			continue
		}
		if line >= len(got) {
			diffs = append(diffs, TokenDiff{
				Line:   line,
				Kind:   MissingToken,
				Detail: fmt.Sprintf("missing line %d in actual output", line),
			})
			continue
		}

		lineDiffs := compareFixtureLine(line, want[line], got[line])
		diffs = append(diffs, lineDiffs...)
	}

	return diffs
}

func compareFixtureLine(line int, want, got []FixtureToken) []TokenDiff {
	var diffs []TokenDiff
	wi, gi := 0, 0

	for wi < len(want) && gi < len(got) {
		w, g := want[wi], got[gi]

		if w.Start != g.Start || w.End != g.End {
			diffs = append(diffs, TokenDiff{
				Line:   line,
				Kind:   BoundaryMismatch,
				Want:   &w,
				Got:    &g,
				Detail: fmt.Sprintf("token %d: boundary [%d:%d] vs [%d:%d]", wi, w.Start, w.End, g.Start, g.End),
			})
			return diffs
		}

		if !scopesEqual(w.Scopes, g.Scopes) {
			diffs = append(diffs, TokenDiff{
				Line:   line,
				Kind:   ScopeMismatch,
				Want:   &w,
				Got:    &g,
				Detail: fmt.Sprintf("token %d: scopes differ", wi),
			})
			wi++
			gi++
			continue
		}

		if normalizeColor(w.Color) != normalizeColor(g.Color) || w.FontStyle != g.FontStyle {
			diffs = append(diffs, TokenDiff{
				Line:   line,
				Kind:   StyleMismatch,
				Want:   &w,
				Got:    &g,
				Detail: fmt.Sprintf("token %d: style differs (color %s vs %s, fontStyle %d vs %d)", wi, w.Color, g.Color, w.FontStyle, g.FontStyle),
			})
		}

		wi++
		gi++
	}

	for ; wi < len(want); wi++ {
		w := want[wi]
		diffs = append(diffs, TokenDiff{
			Line:   line,
			Kind:   MissingToken,
			Want:   &w,
			Detail: fmt.Sprintf("missing token %d", wi),
		})
	}
	for ; gi < len(got); gi++ {
		g := got[gi]
		diffs = append(diffs, TokenDiff{
			Line:   line,
			Kind:   ExtraToken,
			Got:    &g,
			Detail: fmt.Sprintf("extra token %d", gi),
		})
	}

	return diffs
}

// CompareHTML performs exact string comparison on HTML output.
// Returns nil if identical, otherwise an HTMLMismatch diff with context.
func CompareHTML(want, got string) *TokenDiff {
	if want == got {
		return nil
	}

	pos := 0
	for pos < len(want) && pos < len(got) && want[pos] == got[pos] {
		pos++
	}

	contextStart := pos - 30
	if contextStart < 0 {
		contextStart = 0
	}
	contextEnd := pos + 30

	wantSnippet := want[contextStart:]
	if len(wantSnippet) > contextEnd-contextStart {
		wantSnippet = wantSnippet[:contextEnd-contextStart]
	}
	gotSnippet := got[contextStart:]
	if len(gotSnippet) > contextEnd-contextStart {
		gotSnippet = gotSnippet[:contextEnd-contextStart]
	}

	return &TokenDiff{
		Kind:   HTMLMismatch,
		Detail: fmt.Sprintf("first divergence at byte %d:\n  want: ...%s...\n  got:  ...%s...", pos, wantSnippet, gotSnippet),
	}
}

// normalizeColor lowercases and expands 3-digit hex shorthand to 6-digit.
func normalizeColor(hex string) string {
	hex = strings.ToLower(strings.TrimSpace(hex))
	if len(hex) == 4 && hex[0] == '#' {
		return "#" + string(hex[1]) + string(hex[1]) + string(hex[2]) + string(hex[2]) + string(hex[3]) + string(hex[3])
	}
	return hex
}

func scopesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
