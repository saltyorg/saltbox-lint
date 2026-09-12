package grammar

import (
	"encoding/json"
	"fmt"
)

// rawGrammar is the top-level JSON structure of a TextMate grammar file.
type rawGrammar struct {
	ScopeName         string             `json:"scopeName"`
	Name              string             `json:"name"`
	Patterns          []rawRule          `json:"patterns"`
	Repository        json.RawMessage    `json:"repository"`
	Injections        map[string]rawRule `json:"injections"`
	InjectTo          []string           `json:"injectTo"`
	InjectionSelector string             `json:"injectionSelector"`
}

// ParseGrammar parses a TextMate grammar JSON file into a Grammar.
// Unknown fields are silently ignored.
func ParseGrammar(data []byte) (*Grammar, error) {
	var raw rawGrammar
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("grammar json: %w", err)
	}

	if raw.ScopeName == "" {
		return nil, fmt.Errorf("grammar missing scopeName")
	}

	ids := newIDCounter()

	patterns, err := parseRules(raw.Patterns, ids)
	if err != nil {
		return nil, fmt.Errorf("grammar patterns: %w", err)
	}

	repo, err := parseRepository(raw.Repository, ids)
	if err != nil {
		return nil, fmt.Errorf("grammar repository: %w", err)
	}

	injections, err := parseInjections(raw.Injections, ids)
	if err != nil {
		return nil, fmt.Errorf("grammar injections: %w", err)
	}

	g := &Grammar{
		ScopeName:  raw.ScopeName,
		Name:       raw.Name,
		Patterns:   patterns,
		Repository: repo,
		Injections: injections,
		InjectTo:   raw.InjectTo,
	}

	if raw.InjectionSelector != "" {
		sel, err := ParseSelector(raw.InjectionSelector)
		if err != nil {
			return nil, fmt.Errorf("grammar injectionSelector: %w", err)
		}
		g.InjectionSelector = sel
	}

	return g, nil
}

func parseRules(raws []rawRule, ids *idCounter) ([]Rule, error) {
	rules := make([]Rule, 0, len(raws))
	for i, raw := range raws {
		r, err := parseRule(raw, ids)
		if err != nil {
			return nil, fmt.Errorf("rule[%d]: %w", i, err)
		}
		if r != nil {
			rules = append(rules, r)
		}
	}
	return rules, nil
}

func parseRule(raw rawRule, ids *idCounter) (Rule, error) {
	switch {
	case raw.Include != "":
		return &IncludeRule{
			ID:      ids.nextID(),
			Include: raw.Include,
		}, nil

	case raw.Match != "":
		caps, err := parseCaptures(raw.Captures, ids)
		if err != nil {
			return nil, fmt.Errorf("match captures: %w", err)
		}
		return &MatchRule{
			ID:       ids.nextID(),
			Name:     raw.Name,
			Match:    raw.Match,
			Captures: caps,
		}, nil

	case raw.Begin != "" && raw.While != "":
		beginCaps, err := parseCaptures(mergeCaptures(raw.BeginCaptures, raw.Captures), ids)
		if err != nil {
			return nil, fmt.Errorf("begin/while beginCaptures: %w", err)
		}
		whileCaps, err := parseCaptures(mergeCaptures(raw.WhileCaptures, raw.Captures), ids)
		if err != nil {
			return nil, fmt.Errorf("begin/while whileCaptures: %w", err)
		}
		children, err := parseRules(raw.Patterns, ids)
		if err != nil {
			return nil, fmt.Errorf("begin/while patterns: %w", err)
		}
		return &BeginWhileRule{
			ID:            ids.nextID(),
			Name:          raw.Name,
			ContentName:   raw.ContentName,
			Begin:         raw.Begin,
			While:         raw.While,
			BeginCaptures: beginCaps,
			WhileCaptures: whileCaps,
			Patterns:      children,
			NeedsBeginCaptureTexts: hasBackrefMarker(raw.While) ||
				hasScopeBackrefMarker(raw.Name) || hasScopeBackrefMarker(raw.ContentName),
		}, nil

	case raw.Begin != "":
		beginCaps, err := parseCaptures(mergeCaptures(raw.BeginCaptures, raw.Captures), ids)
		if err != nil {
			return nil, fmt.Errorf("begin/end beginCaptures: %w", err)
		}
		endCaps, err := parseCaptures(mergeCaptures(raw.EndCaptures, raw.Captures), ids)
		if err != nil {
			return nil, fmt.Errorf("begin/end endCaptures: %w", err)
		}
		children, err := parseRules(raw.Patterns, ids)
		if err != nil {
			return nil, fmt.Errorf("begin/end patterns: %w", err)
		}
		return &BeginEndRule{
			ID:                  ids.nextID(),
			Name:                raw.Name,
			ContentName:         raw.ContentName,
			Begin:               raw.Begin,
			End:                 raw.End,
			BeginCaptures:       beginCaps,
			EndCaptures:         endCaps,
			Patterns:            children,
			ApplyEndPatternLast: bool(raw.ApplyEndPatternLast),
			NeedsBeginCaptureTexts: hasBackrefMarker(raw.End) ||
				hasScopeBackrefMarker(raw.Name) || hasScopeBackrefMarker(raw.ContentName),
		}, nil

	case len(raw.Patterns) > 0:
		children, err := parseRules(raw.Patterns, ids)
		if err != nil {
			return nil, fmt.Errorf("collection patterns: %w", err)
		}
		var localRepo map[string]Rule
		if len(raw.Repository) > 0 {
			rawRepo, _ := json.Marshal(raw.Repository)
			localRepo, err = parseRepository(rawRepo, ids)
			if err != nil {
				return nil, fmt.Errorf("collection repository: %w", err)
			}
		}
		return &CollectionRule{
			ID:         ids.nextID(),
			Patterns:   children,
			Repository: localRepo,
		}, nil

	default:
		// Rules with only a name and no patterns/match/begin are valid
		// (e.g., repository entries that are just scope containers).
		if raw.Name != "" {
			return &MatchRule{
				ID:   ids.nextID(),
				Name: raw.Name,
			}, nil
		}
		return nil, nil
	}
}

func parseRepository(rawRepo json.RawMessage, ids *idCounter) (map[string]Rule, error) {
	if len(rawRepo) == 0 {
		return nil, nil
	}

	var entries map[string]json.RawMessage
	if err := json.Unmarshal(rawRepo, &entries); err != nil {
		return nil, err
	}

	repo := make(map[string]Rule, len(entries))
	for key, rawVal := range entries {
		// Repository values can be a single rule object or an array of rules
		var rr rawRule
		if err := json.Unmarshal(rawVal, &rr); err == nil {
			r, err := parseRule(rr, ids)
			if err != nil {
				return nil, fmt.Errorf("repository[%s]: %w", key, err)
			}
			if r != nil {
				repo[key] = r
			}
			continue
		}

		var arr []rawRule
		if err := json.Unmarshal(rawVal, &arr); err == nil {
			children, err := parseRules(arr, ids)
			if err != nil {
				return nil, fmt.Errorf("repository[%s]: %w", key, err)
			}
			if len(children) > 0 {
				repo[key] = &CollectionRule{ID: ids.nextID(), Patterns: children}
			}
			continue
		}
	}
	return repo, nil
}

func parseInjections(raw map[string]rawRule, ids *idCounter) ([]Injection, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	injections := make([]Injection, 0, len(raw))
	for selectorStr, rr := range raw {
		r, err := parseRule(rr, ids)
		if err != nil {
			return nil, fmt.Errorf("injection[%s]: %w", selectorStr, err)
		}
		if r == nil {
			continue
		}
		sel, err := ParseSelector(selectorStr)
		if err != nil {
			return nil, fmt.Errorf("injection selector %q: %w", selectorStr, err)
		}
		injections = append(injections, Injection{
			RawSelector: selectorStr,
			Selector:    sel,
			Rule:        r,
		})
	}
	return injections, nil
}

// mergeCaptures returns beginCaptures/endCaptures if present,
// falling back to the shared captures field (vscode-textmate behavior:
// if beginCaptures is absent, captures applies to begin).
func mergeCaptures(specific, shared rawCaptures) rawCaptures {
	if len(specific) > 0 {
		return specific
	}
	return shared
}
