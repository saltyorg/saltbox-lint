package tokenizer

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/internal/oniguruma"
)

// captureContext holds the dependencies needed for capture re-tokenization.
// When a CaptureRule has Patterns, the captured substring must be recursively
// tokenized — which requires the full tokenization context.
type captureContext struct {
	ctx        context.Context
	line       []byte
	g          *grammar.Grammar
	onigLib    oniguruma.OnigLib
	resolver   grammar.GrammarResolver
	injections []grammar.Injection
	memo       *compileMemo
	deadline   time.Time
}

// handleCaptures processes capture groups from a match, emitting a flat,
// non-overlapping token sequence. Wider captures (e.g. capture 0 = full match)
// are split around narrower sub-captures, mirroring vscode-textmate's approach.
//
// When a capture rule has Patterns, the captured substring is recursively
// tokenized using those patterns, and the results are merged into the builder.
func handleCaptures(
	captures []oniguruma.Capture,
	captureRules grammar.Captures,
	scopes []string,
	builder *lineTokenBuilder,
	cc *captureContext,
) {
	if len(captureRules) == 0 || len(captures) == 0 {
		return
	}

	maxEnd := captures[0].End
	captureStart := captures[0].Start
	if captureStart < 0 {
		return
	}

	builder.produce(captureStart, scopes)

	type localFrame struct {
		scopes []string
		endPos int
	}
	var localStack []localFrame

	// Capture texts are extracted at most once per handleCaptures call,
	// and only when some capture name actually contains a $ backref.
	var captureTexts []string

	for i := 0; i < len(captures); i++ {
		key := strconv.Itoa(i)
		cr, ok := captureRules[key]
		if !ok || cr == nil {
			continue
		}

		c := captures[i]
		if c.Start < 0 || c.Start >= c.End {
			continue
		}
		if c.Start > maxEnd {
			break
		}

		// Pop frames whose range has ended before this capture starts.
		for len(localStack) > 0 && localStack[len(localStack)-1].endPos <= c.Start {
			top := localStack[len(localStack)-1]
			builder.produce(top.endPos, top.scopes)
			localStack = localStack[:len(localStack)-1]
		}

		// Emit gap from current position up to this capture's start.
		if c.Start > builder.lastEndPos {
			parentScopes := scopes
			if len(localStack) > 0 {
				parentScopes = localStack[len(localStack)-1].scopes
			}
			builder.produce(c.Start, parentScopes)
		}

		// Build scopes for this capture.
		captureScopes := scopes
		if len(localStack) > 0 {
			captureScopes = localStack[len(localStack)-1].scopes
		}
		resolvedCRName := cr.Name
		if resolvedCRName != "" && cc != nil && strings.ContainsRune(resolvedCRName, '$') {
			if captureTexts == nil {
				captureTexts = extractCaptureTexts(captures, cc.line)
			}
			resolvedCRName = grammar.ResolveScopeBackrefs(resolvedCRName, captureTexts)
		}
		if resolvedCRName != "" {
			captureScopes = appendScopes(append([]string{}, captureScopes...), resolvedCRName)
		}

		// Capture re-tokenization: if this capture rule has nested patterns,
		// recursively tokenize the captured substring.
		// vscode-textmate retokenizes captures independently of surrounding
		// capture scopes — parent capture names do not nest into children.
		if len(cr.Patterns) > 0 && cc != nil {
			retokScopes := append([]string{}, scopes...)
			if resolvedCRName != "" {
				retokScopes = appendScopes(retokScopes, resolvedCRName)
			}
			retokenizeCapture(cc, cr, retokScopes, c.Start, c.End, builder)
			continue
		}

		if cr.Name != "" {
			localStack = append(localStack, localFrame{
				scopes: captureScopes,
				endPos: c.End,
			})
		}
	}

	// Pop remaining frames.
	for len(localStack) > 0 {
		top := localStack[len(localStack)-1]
		builder.produce(top.endPos, top.scopes)
		localStack = localStack[:len(localStack)-1]
	}

	// Emit trailing gap between last capture and the full match end.
	if builder.lastEndPos < maxEnd {
		builder.produce(maxEnd, scopes)
	}
}

// retokenizeCapture recursively tokenizes a captured range using the capture
// rule's nested patterns. Matches vscode-textmate's retokenizeCapturedWithRuleId
// (tokenizeString.ts:626-637): truncates the line to captureEnd (preserving
// absolute offsets) and calls tokenizeLine starting at captureStart.
func retokenizeCapture(
	cc *captureContext,
	cr *grammar.CaptureRule,
	scopes []string,
	captureStart, captureEnd int,
	builder *lineTokenBuilder,
) {
	if captureStart >= captureEnd {
		return
	}

	// Truncate line to captureEnd — NOT a substring extraction.
	// This preserves absolute offsets so no adjustment is needed.
	truncatedLine := cc.line[:captureEnd]

	// Use a CollectionRule as the root so getActivePatterns returns
	// the capture's patterns, while cc.g provides repository resolution.
	// The root comes from the memo so its pointer is stable across calls —
	// otherwise every retokenization would miss the compile memo.
	captureRoot := cc.memo.captureRoot(cr)
	scopeName := strings.Join(scopes, " ")
	tempState := newStateStack(captureRoot, scopeName)

	tokens, _, _, err := tokenizeLine(
		cc.ctx, truncatedLine, cc.g, cc.onigLib,
		tempState, cc.resolver, nil, cc.memo, captureStart, false, time.Time{},
	)
	if err != nil || len(tokens) == 0 {
		builder.produce(captureEnd, scopes)
		return
	}

	for _, tok := range tokens {
		builder.produce(tok.End, tok.Scopes)
	}
}
