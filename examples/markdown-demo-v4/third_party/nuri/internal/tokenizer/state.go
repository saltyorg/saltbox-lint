package tokenizer

import (
	"strings"

	"github.com/frostybee/nuri/internal/grammar"
)

// StackFrame represents one level of the grammar state machine.
type StackFrame struct {
	Rule             grammar.Rule
	ContentGrammar   *grammar.Grammar // owning grammar for cross-grammar contexts
	NameScope        string
	ContentScope     string
	EndRule          *grammar.EndRule
	WhileRule        *grammar.WhileRule
	BeginCapturedEOL bool
	AnchorPosition   int // byte offset where \G should match (-1 = none)
	EnterPosition    int // byte offset when frame was entered (-1 = none)
}

// StateStack is a slice-based stack of grammar state frames.
// The root frame (index 0) is never popped.
type StateStack struct {
	frames []StackFrame
}

func newStateStack(rule grammar.Rule, rootScope string) *StateStack {
	return &StateStack{
		frames: []StackFrame{{
			Rule:           rule,
			NameScope:      rootScope,
			AnchorPosition: -1,
			EnterPosition:  -1,
		}},
	}
}

func (s *StateStack) push(frame StackFrame) {
	s.frames = append(s.frames, frame)
}

func (s *StateStack) pushBeginEnd(rule *grammar.BeginEndRule, endRule *grammar.EndRule, anchorPos, enterPos int, resolvedName, resolvedContentName string, contentGrammar *grammar.Grammar) {
	s.frames = append(s.frames, StackFrame{
		Rule:           rule,
		ContentGrammar: contentGrammar,
		NameScope:      resolvedName,
		ContentScope:   resolvedContentName,
		EndRule:        endRule,
		AnchorPosition: anchorPos,
		EnterPosition:  enterPos,
	})
}

func (s *StateStack) pushBeginWhile(rule *grammar.BeginWhileRule, whileRule *grammar.WhileRule, anchorPos, enterPos int, resolvedName, resolvedContentName string, contentGrammar *grammar.Grammar) {
	s.frames = append(s.frames, StackFrame{
		Rule:           rule,
		ContentGrammar: contentGrammar,
		NameScope:      resolvedName,
		ContentScope:   resolvedContentName,
		WhileRule:      whileRule,
		AnchorPosition: anchorPos,
		EnterPosition:  enterPos,
	})
}

func (s *StateStack) pop() StackFrame {
	if len(s.frames) <= 1 {
		return s.frames[0]
	}
	top := s.frames[len(s.frames)-1]
	s.frames = s.frames[:len(s.frames)-1]
	return top
}

func (s *StateStack) safePop() {
	if len(s.frames) > 1 {
		s.frames = s.frames[:len(s.frames)-1]
	}
}

func (s *StateStack) top() *StackFrame {
	return &s.frames[len(s.frames)-1]
}

func (s *StateStack) depth() int {
	return len(s.frames)
}

// topHasSameRuleBelow checks whether the top frame's rule already exists
// lower in the stack at the same EnterPosition. Used for infinite-loop
// detection: if a begin rule pushed without advancing and the same rule
// is already below at the same position, it's an infinite push loop.
// Matches vscode-textmate's beforePush.hasSameRuleAs(stack) (grammar.ts:857-866).
func (s *StateStack) topHasSameRuleBelow() bool {
	if len(s.frames) < 2 {
		return false
	}
	top := s.frames[len(s.frames)-1]
	for i := len(s.frames) - 2; i >= 0; i-- {
		if s.frames[i].EnterPosition != top.EnterPosition {
			break
		}
		if s.frames[i].Rule != nil && top.Rule != nil &&
			s.frames[i].Rule.GetID() == top.Rule.GetID() {
			return true
		}
	}
	return false
}

// clone creates an independent copy of the state stack.
func (s *StateStack) clone() *StateStack {
	copied := make([]StackFrame, len(s.frames))
	copy(copied, s.frames)
	return &StateStack{frames: copied}
}

// resetForNewLine clears per-line transient state on all frames.
func (s *StateStack) resetForNewLine() {
	for i := range s.frames {
		s.frames[i].EnterPosition = -1
		s.frames[i].AnchorPosition = -1
	}
}

// scopeSlice builds the full scope path by walking all frames
// and concatenating each frame's NameScope and ContentScope.
// Space-separated names (e.g., "string.json support.type.property-name.json")
// are split into individual scopes, matching vscode-textmate behavior.
func (s *StateStack) scopeSlice() []string {
	n := 0
	for i := range s.frames {
		if s.frames[i].NameScope != "" {
			n += countScopes(s.frames[i].NameScope)
		}
		if s.frames[i].ContentScope != "" {
			n += countScopes(s.frames[i].ContentScope)
		}
	}
	result := make([]string, 0, n)
	for i := range s.frames {
		if s.frames[i].NameScope != "" {
			result = appendScopes(result, s.frames[i].NameScope)
		}
		if s.frames[i].ContentScope != "" {
			result = appendScopes(result, s.frames[i].ContentScope)
		}
	}
	return result
}

func (s *StateStack) scopeSliceTo(frameIndex int) []string {
	n := 0
	for i := 0; i <= frameIndex && i < len(s.frames); i++ {
		if s.frames[i].NameScope != "" {
			n += countScopes(s.frames[i].NameScope)
		}
		if s.frames[i].ContentScope != "" {
			n += countScopes(s.frames[i].ContentScope)
		}
	}
	result := make([]string, 0, n)
	for i := 0; i <= frameIndex && i < len(s.frames); i++ {
		if s.frames[i].NameScope != "" {
			result = appendScopes(result, s.frames[i].NameScope)
		}
		if s.frames[i].ContentScope != "" {
			result = appendScopes(result, s.frames[i].ContentScope)
		}
	}
	return result
}

func appendScopes(dst []string, name string) []string {
	if !strings.Contains(name, " ") {
		return append(dst, name)
	}
	for _, s := range strings.Fields(name) {
		dst = append(dst, s)
	}
	return dst
}

func countScopes(name string) int {
	if !strings.Contains(name, " ") {
		return 1
	}
	return len(strings.Fields(name))
}
