package grammar

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// GrammarResolver resolves foreign grammars by scope name.
// Used by CompilePatterns to resolve cross-grammar includes.
type GrammarResolver interface {
	GetGrammarByScope(scope string) (*Grammar, error)
}

// InjectionProvider extends GrammarResolver with the ability to discover
// grammars that inject into a given target scope via injectTo.
type InjectionProvider interface {
	GrammarResolver
	GetInjectors(targetScope string) ([]*Grammar, error)
}

// CompiledRule pairs a regex pattern (ready for the scanner) with the
// rule that produced it, so the tokenizer knows how to dispatch a match.
type CompiledRule struct {
	Pattern []byte
	Rule    Rule
	Grammar *Grammar
}

// CompileResult holds the flattened pattern list for a set of rules.
type CompileResult struct {
	Rules []CompiledRule
}

type resolveResult struct {
	rules   []Rule
	grammar *Grammar
	repo    map[string]Rule
}

// CompilePatterns flattens a set of rules into a list of compiled patterns,
// resolving includes along the way. The grammar and repository are needed
// for include resolution ($self, $base, #key). The resolver is optional
// (nil skips cross-grammar includes).
func CompilePatterns(rules []Rule, grammar *Grammar, repo map[string]Rule, visited map[RuleID]bool, resolver GrammarResolver) (*CompileResult, error) {
	if visited == nil {
		visited = make(map[RuleID]bool)
	}
	result := &CompileResult{}
	for _, rule := range rules {
		if err := compileRule(rule, grammar, repo, visited, resolver, result); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func compileRule(rule Rule, g *Grammar, repo map[string]Rule, visited map[RuleID]bool, resolver GrammarResolver, result *CompileResult) error {
	switch r := rule.(type) {
	case *MatchRule:
		if r.Match != "" {
			result.Rules = append(result.Rules, CompiledRule{
				Pattern: []byte(r.Match),
				Rule:    r,
				Grammar: g,
			})
		}

	case *BeginEndRule:
		if r.Begin != "" && !allPatternsUnresolvable(r.Patterns, g, repo, visited, resolver) {
			result.Rules = append(result.Rules, CompiledRule{
				Pattern: []byte(r.Begin),
				Rule:    r,
				Grammar: g,
			})
		}

	case *BeginWhileRule:
		if r.Begin != "" && !allPatternsUnresolvable(r.Patterns, g, repo, visited, resolver) {
			result.Rules = append(result.Rules, CompiledRule{
				Pattern: []byte(r.Begin),
				Rule:    r,
				Grammar: g,
			})
		}

	case *IncludeRule:
		res, err := resolveInclude(r.Include, g, repo, visited, resolver)
		if err != nil {
			return err
		}
		childG, childRepo := g, repo
		if res.grammar != nil {
			childG = res.grammar
			childRepo = res.repo
		} else if res.repo != nil {
			childRepo = res.repo
		}
		for _, child := range res.rules {
			if err := compileRule(child, childG, childRepo, visited, resolver, result); err != nil {
				return err
			}
		}

	case *CollectionRule:
		for _, child := range r.Patterns {
			if err := compileRule(child, g, repo, visited, resolver, result); err != nil {
				return err
			}
		}

	case *CaptureRule:
		// CaptureRules don't produce top-level patterns

	default:
		// Unknown rule type — skip
	}
	return nil
}

// allPatternsUnresolvable returns true when a rule's sub-patterns consist
// entirely of includes that fail to resolve. vscode-textmate skips such
// rules from the scanner (hasMissingPatterns && patterns.length === 0).
func allPatternsUnresolvable(patterns []Rule, g *Grammar, repo map[string]Rule, visited map[RuleID]bool, resolver GrammarResolver) bool {
	if len(patterns) == 0 {
		return false
	}
	for _, p := range patterns {
		inc, ok := p.(*IncludeRule)
		if !ok {
			return false
		}
		res, err := resolveInclude(inc.Include, g, repo, visited, resolver)
		if err == nil && len(res.rules) > 0 {
			return false
		}
	}
	return true
}

const maxIncludeDepth = 256

func resolveInclude(include string, g *Grammar, repo map[string]Rule, visited map[RuleID]bool, resolver GrammarResolver) (resolveResult, error) {
	if len(visited) > maxIncludeDepth {
		return resolveResult{}, fmt.Errorf("%w: depth exceeded %d", ErrGrammarDepth, maxIncludeDepth)
	}

	switch {
	case include == "$self":
		return resolveResult{rules: g.Patterns}, nil

	case include == "$base":
		return resolveResult{rules: g.Patterns}, nil

	case strings.HasPrefix(include, "#"):
		key := include[1:]
		r, ok := repo[key]
		if !ok {
			return resolveResult{}, nil
		}
		id := r.GetID()
		if visited[id] {
			return resolveResult{}, fmt.Errorf("%w: %s", ErrGrammarCycle, include)
		}
		visited[id] = true
		defer delete(visited, id)

		switch v := r.(type) {
		case *CollectionRule:
			var childRepo map[string]Rule
			if len(v.Repository) > 0 {
				childRepo = make(map[string]Rule, len(repo)+len(v.Repository))
				for k, val := range repo {
					childRepo[k] = val
				}
				for k, val := range v.Repository {
					childRepo[k] = val
				}
			}
			return resolveResult{repo: childRepo, rules: v.Patterns}, nil
		default:
			return resolveResult{rules: []Rule{r}}, nil
		}

	default:
		if resolver == nil {
			return resolveResult{}, nil
		}
		return resolveCrossGrammar(include, resolver)
	}
}

func resolveCrossGrammar(include string, resolver GrammarResolver) (resolveResult, error) {
	scope, key, _ := strings.Cut(include, "#")

	foreign, err := resolver.GetGrammarByScope(scope)
	if err != nil {
		return resolveResult{}, nil
	}

	var rules []Rule
	if key == "" {
		rules = foreign.Patterns
	} else {
		r, ok := foreign.Repository[key]
		if !ok {
			return resolveResult{}, nil
		}
		switch v := r.(type) {
		case *CollectionRule:
			rules = v.Patterns
		default:
			rules = []Rule{r}
		}
	}

	return resolveResult{
		rules:   rules,
		grammar: foreign,
		repo:    foreign.Repository,
	}, nil
}

var backrefRegexp = regexp.MustCompile(`\\(\d)`)

// hasBackrefMarker reports whether ResolveBackrefs would do anything to
// pattern. Computed once at parse time so the tokenizer can skip capture
// text extraction for the common no-backref case.
func hasBackrefMarker(pattern string) bool {
	return backrefRegexp.MatchString(pattern)
}

// hasScopeBackrefMarker reports whether ResolveScopeBackrefs could do
// anything to name. ContainsRune is conservative (a bare $ never resolves)
// but errs only toward extracting texts that turn out unused.
func hasScopeBackrefMarker(name string) bool {
	return strings.ContainsRune(name, '$')
}

// ResolveBackrefs substitutes backreferences (\1, \2, ...) in an end/while
// pattern with the text captured by the begin match. The captured text is
// escaped to be used as a literal in a regex.
func ResolveBackrefs(pattern string, captures []string) string {
	return backrefRegexp.ReplaceAllStringFunc(pattern, func(match string) string {
		idx := int(match[1] - '0')
		if idx >= 0 && idx < len(captures) && captures[idx] != "" {
			return escapeRegex(captures[idx])
		}
		return ""
	})
}

var scopeBackrefRegexp = regexp.MustCompile(`\$(\d+)|\$\{(\d+):/(downcase|upcase)\}`)

// ResolveScopeBackrefs substitutes $1, $2, ${1:/downcase}, ${1:/upcase} in a
// scope name with text from capture groups. Matches vscode-textmate's
// RegexSource.replaceCaptures (src/utils.ts:69-90).
func ResolveScopeBackrefs(name string, captureTexts []string) string {
	if !strings.ContainsRune(name, '$') {
		return name
	}
	return scopeBackrefRegexp.ReplaceAllStringFunc(name, func(match string) string {
		subs := scopeBackrefRegexp.FindStringSubmatch(match)
		indexStr := subs[1]
		if indexStr == "" {
			indexStr = subs[2]
		}
		idx, _ := strconv.Atoi(indexStr)
		if idx >= len(captureTexts) || captureTexts[idx] == "" {
			return match
		}
		result := strings.TrimLeft(captureTexts[idx], ".")
		switch subs[3] {
		case "downcase":
			return strings.ToLower(result)
		case "upcase":
			return strings.ToUpper(result)
		default:
			return result
		}
	})
}

func escapeRegex(s string) string {
	var b strings.Builder
	for _, ch := range s {
		switch ch {
		case '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '-', ',', '#':
			b.WriteByte('\\')
		default:
			// Captured whitespace and # must stay literal in (?x) end/while
			// patterns, matching vscode-textmate escapeRegExpCharacters.
			if unicode.IsSpace(ch) || ch == '\uFEFF' {
				b.WriteByte('\\')
			}
		}
		b.WriteRune(ch)
	}
	return b.String()
}
