package grammar

// RuleID is a monotonically increasing identifier assigned during parsing.
type RuleID int32

const InvalidRuleID RuleID = 0

// Rule is the interface all grammar rule types implement.
type Rule interface {
	GetID() RuleID
}

// CaptureRule represents a numbered capture group with a scope name
// and optional sub-patterns for recursive re-tokenization.
type CaptureRule struct {
	ID       RuleID
	Name     string
	Patterns []Rule
}

func (r *CaptureRule) GetID() RuleID { return r.ID }

// Captures maps capture group numbers (as strings: "0", "1", ...)
// to their CaptureRule definitions.
type Captures map[string]*CaptureRule

// MatchRule represents a single match pattern.
type MatchRule struct {
	ID       RuleID
	Name     string
	Match    string
	Captures Captures
}

func (r *MatchRule) GetID() RuleID { return r.ID }

// BeginEndRule represents a paired begin/end pattern.
// The end pattern may contain backreferences (\1, \2, ...) to the begin
// match's capture groups, resolved at match time by creating an EndRule.
//
// NeedsBeginCaptureTexts is computed at parse time: it is true when End
// contains a \N backref or Name/ContentName contains a $ scope backref.
// When false, ResolveBackrefs/ResolveScopeBackrefs are pure no-ops, so the
// tokenizer skips extracting capture texts on every begin match.
type BeginEndRule struct {
	ID                     RuleID
	Name                   string
	ContentName            string
	Begin                  string
	End                    string
	BeginCaptures          Captures
	EndCaptures            Captures
	Patterns               []Rule
	ApplyEndPatternLast    bool
	NeedsBeginCaptureTexts bool
}

func (r *BeginEndRule) GetID() RuleID { return r.ID }

// EndRule is created at match time from a BeginEndRule's end pattern.
// Backreferences from the begin match are substituted into the pattern.
type EndRule struct {
	ID          RuleID
	Parent      *BeginEndRule
	EndPattern  string // after backref substitution
	EndCaptures Captures
}

func (r *EndRule) GetID() RuleID { return r.ID }

// BeginWhileRule represents a begin/while pattern pair.
// The while pattern is tested at the start of each subsequent line;
// the rule pops when the while condition fails.
//
// NeedsBeginCaptureTexts mirrors BeginEndRule: true when While contains a
// \N backref or Name/ContentName contains a $ scope backref.
type BeginWhileRule struct {
	ID                     RuleID
	Name                   string
	ContentName            string
	Begin                  string
	While                  string
	BeginCaptures          Captures
	WhileCaptures          Captures
	Patterns               []Rule
	NeedsBeginCaptureTexts bool
}

func (r *BeginWhileRule) GetID() RuleID { return r.ID }

// WhileRule is created at match time from a BeginWhileRule.
// It holds the resolved while pattern for per-line checking.
type WhileRule struct {
	ID            RuleID
	Parent        *BeginWhileRule
	WhilePattern  string // after backref substitution
	WhileCaptures Captures
}

func (r *WhileRule) GetID() RuleID { return r.ID }

// IncludeRule references another rule set. The include string determines
// the resolution strategy:
//
//	"$self"          → current grammar's top-level patterns
//	"$base"          → root grammar (matters for embedded grammars)
//	"#key"           → grammar.Repository["key"]
//	"source.js"      → foreign grammar by scope name
//	"source.js#key"  → foreign grammar's repository entry
type IncludeRule struct {
	ID      RuleID
	Include string
}

func (r *IncludeRule) GetID() RuleID { return r.ID }

// CollectionRule is a container that holds child patterns.
// It flattens its children during compilation.
// Repository holds local definitions that shadow the parent repository
// when resolving includes within this collection's patterns.
type CollectionRule struct {
	ID         RuleID
	Patterns   []Rule
	Repository map[string]Rule
}

func (r *CollectionRule) GetID() RuleID { return r.ID }

// idCounter assigns monotonically increasing rule IDs during parsing.
type idCounter struct {
	next RuleID
}

func newIDCounter() *idCounter {
	return &idCounter{next: 1}
}

func (c *idCounter) nextID() RuleID {
	id := c.next
	c.next++
	return id
}
