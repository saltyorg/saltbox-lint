package tokenizer

import (
	"bytes"
	"context"
	"time"

	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/internal/oniguruma"
)

// panicOnLineHook is a test-only hook for panic recovery testing.
// When >= 0, Tokenize panics before tokenizing that line index.
var panicOnLineHook = -1

// TokenizeOptions carries per-call safety configuration.
type TokenizeOptions struct {
	MaxLineLength int // 0 = no limit; lines exceeding this are emitted unstyled
	TimeoutMs     int // 0 = no timeout; per-line soft timeout in milliseconds
}

// Tokenize tokenizes source code using the given grammar. The resolver is
// optional (nil skips cross-grammar includes and external injections).
func Tokenize(
	ctx context.Context,
	code []byte,
	g *grammar.Grammar,
	onigLib oniguruma.OnigLib,
	opts TokenizeOptions,
	resolver ...grammar.GrammarResolver,
) (*TokenizeResult, error) {
	if len(code) == 0 {
		return &TokenizeResult{}, nil
	}

	var res grammar.GrammarResolver
	if len(resolver) > 0 {
		res = resolver[0]
	}

	injections := collectInjections(g, res)

	lines := splitLines(code)
	result := &TokenizeResult{
		Lines: make([][]Token, 0, len(lines)),
	}

	memo := newCompileMemo(onigLib, res)

	state := newStateStack(nil, g.ScopeName)

	for i, line := range lines {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		state.resetForNewLine()

		// MaxLineLength pre-filter: skip tokenization for oversized lines.
		if opts.MaxLineLength > 0 && len(line) > opts.MaxLineLength {
			tok := Token{Scopes: state.scopeSlice(), Start: 0, End: len(line)}
			result.Lines = append(result.Lines, []Token{tok})
			result.Diagnostics = append(result.Diagnostics, Diagnostic{Line: i, Kind: "too_long"})
			continue
		}

		// Compute per-line deadline for soft timeout.
		var deadline time.Time
		if opts.TimeoutMs > 0 {
			deadline = time.Now().Add(time.Duration(opts.TimeoutMs) * time.Millisecond)
		}

		var (
			tokens       []Token
			newState     *StateStack
			stoppedEarly bool
			lineErr      error
			panicked     bool
		)
		func() {
			defer func() {
				if r := recover(); r != nil {
					panicked = true
				}
			}()
			if panicOnLineHook == i {
				panic("test panic on line")
			}
			tokens, newState, stoppedEarly, lineErr = tokenizeLine(
				ctx, line, g, onigLib, state, res, injections, memo, 0, i == 0, deadline,
			)
		}()

		if panicked {
			tokens = []Token{{Scopes: state.scopeSlice(), Start: 0, End: len(line)}}
			newState = state
			result.Diagnostics = append(result.Diagnostics, Diagnostic{Line: i, Kind: "panic"})
		} else if lineErr != nil {
			return nil, lineErr
		} else if stoppedEarly {
			result.Diagnostics = append(result.Diagnostics, Diagnostic{Line: i, Kind: "timeout"})
		}

		result.Lines = append(result.Lines, tokens)
		state = newState
	}

	return result, nil
}

// splitLines splits code into bare lines with terminators stripped: the
// trailing \n and a directly preceding \r are excluded. This matches how
// Shiki feeds lines to vscode-textmate, which appends its own newline
// before scanning. Lines are views into code, zero copies; callers never
// mutate line bytes.
func splitLines(code []byte) [][]byte {
	n := bytes.Count(code, []byte{'\n'})
	if len(code) > 0 && code[len(code)-1] != '\n' {
		n++
	}
	lines := make([][]byte, 0, n)
	start := 0
	for i, b := range code {
		if b == '\n' {
			end := i
			if end > start && code[end-1] == '\r' {
				end--
			}
			lines = append(lines, code[start:end])
			start = i + 1
		}
	}
	if start < len(code) {
		lines = append(lines, code[start:])
	}
	return lines
}
