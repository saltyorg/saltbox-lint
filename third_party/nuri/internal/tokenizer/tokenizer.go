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
	LineCache     *LineCache
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
	return tokenize(ctx, code, g, onigLib, opts, nil, resolver...)
}

func tokenize(ctx context.Context, code []byte, g *grammar.Grammar, onigLib oniguruma.OnigLib, opts TokenizeOptions, document *documentScan, resolver ...grammar.GrammarResolver) (*TokenizeResult, error) {
	if len(code) == 0 {
		return &TokenizeResult{}, nil
	}

	var res grammar.GrammarResolver
	if len(resolver) > 0 {
		res = resolver[0]
	}

	var lines [][]byte
	if document != nil {
		lines = document.lines[:document.limit]
	} else {
		lines = splitLines(code)
	}
	result := &TokenizeResult{
		Lines: make([][]Token, 0, len(lines)),
	}

	memo := newCompileMemo(onigLib, res)
	injections := collectInjections(g, res, memo)

	state := newStateStack(nil, g.ScopeName)

	start := 0
	if document != nil && memo.cacheSafe() {
		start, state = document.reusePrefix(result, state)
	}
	for i := start; i < len(lines); i++ {
		line := lines[i]
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		state.resetForNewLine()
		if document != nil {
			if memo.cacheSafe() && document.reuseSuffix(i, state, result) {
				break
			}
			document.stats.Visited++
		}

		// MaxLineLength pre-filter: skip tokenization for oversized lines.
		if opts.MaxLineLength > 0 && len(line) > opts.MaxLineLength {
			memo.taintCache()
			tok := Token{Scopes: state.scopeSlice(), Start: 0, End: len(line)}
			result.Lines = append(result.Lines, []Token{tok})
			result.Diagnostics = append(result.Diagnostics, Diagnostic{Line: i, Kind: "too_long"})
			continue
		}

		incomingState := state.clone()
		if memo.cacheSafe() {
			if tokens, cachedState, ok := opts.LineCache.lookup(line, g, res, opts, i == 0, incomingState); ok {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				result.Lines = append(result.Lines, tokens)
				state = cachedState
				if document != nil {
					document.record(tokens, state)
				}
				continue
			}
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
			memo.taintCache()
			tokens = []Token{{Scopes: state.scopeSlice(), Start: 0, End: len(line)}}
			newState = state
			result.Diagnostics = append(result.Diagnostics, Diagnostic{Line: i, Kind: "panic"})
		} else if lineErr != nil {
			memo.taintCache()
			return nil, lineErr
		} else if stoppedEarly {
			memo.taintCache()
			result.Diagnostics = append(result.Diagnostics, Diagnostic{Line: i, Kind: "timeout"})
		}
		if err := ctx.Err(); err != nil {
			memo.taintCache()
			return nil, err
		}

		result.Lines = append(result.Lines, tokens)
		state = newState
		if !completeLineTokens(line, tokens) {
			memo.taintCache()
		}
		if document != nil {
			document.record(tokens, state)
		}
		if memo.cacheSafe() {
			opts.LineCache.store(line, g, res, opts, i == 0, incomingState, tokens, state)
		}
	}

	if document != nil {
		document.safe = memo.cacheSafe() && ctx.Err() == nil
	}
	return result, ctx.Err()
}

func completeLineTokens(line []byte, tokens []Token) bool {
	if len(line) == 0 {
		return len(tokens) == 0
	}
	position := 0
	for _, token := range tokens {
		if token.Start != position || token.End <= token.Start || token.End > len(line) {
			return false
		}
		position = token.End
	}
	return position == len(line)
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
