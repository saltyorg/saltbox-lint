package grammar

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// rawCaptures is the JSON shape: {"0": {...}, "1": {...}, ...}
// Some grammars use an array instead of a map (e.g., jinja.json).
// The custom unmarshaler handles both forms.
type rawCaptures map[string]rawRule

func (rc *rawCaptures) UnmarshalJSON(data []byte) error {
	// Try map of string key → value (the common case).
	// Values can be rawRule objects or plain strings (just a scope name).
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err == nil {
		result := make(map[string]rawRule, len(m))
		for k, v := range m {
			var r rawRule
			if err := json.Unmarshal(v, &r); err != nil {
				// Try as a plain string (scope name shorthand)
				var s string
				if err2 := json.Unmarshal(v, &s); err2 == nil {
					r = rawRule{Name: s}
				}
				// Skip values that can't be parsed
			}
			result[k] = r
		}
		*rc = result
		return nil
	}
	// Fall back to array: convert index to string key
	var arr []json.RawMessage
	if err := json.Unmarshal(data, &arr); err != nil {
		return err
	}
	result := make(map[string]rawRule, len(arr))
	for i, v := range arr {
		var r rawRule
		if err := json.Unmarshal(v, &r); err != nil {
			var s string
			if err2 := json.Unmarshal(v, &s); err2 == nil {
				r = rawRule{Name: s}
			}
		}
		result[strconv.Itoa(i)] = r
	}
	*rc = result
	return nil
}

func parseCaptures(raw rawCaptures, ids *idCounter) (Captures, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	caps := make(Captures, len(raw))
	for key, rc := range raw {
		if _, err := strconv.Atoi(key); err != nil {
			continue // skip non-numeric keys (some grammars have "end" etc.)
		}
		cr := &CaptureRule{
			ID:   ids.nextID(),
			Name: rc.Name,
		}
		if len(rc.Patterns) > 0 {
			children, err := parseRules(rc.Patterns, ids)
			if err != nil {
				return nil, fmt.Errorf("capture %s patterns: %w", key, err)
			}
			cr.Patterns = children
		}
		caps[key] = cr
	}
	return caps, nil
}

// rawRule is the intermediate JSON representation before we determine the rule type.
type rawRule struct {
	Name                string             `json:"name"`
	ContentName         string             `json:"contentName"`
	Match               string             `json:"match"`
	Begin               string             `json:"begin"`
	End                 string             `json:"end"`
	While               string             `json:"while"`
	Include             string             `json:"include"`
	Captures            rawCaptures        `json:"captures"`
	BeginCaptures       rawCaptures        `json:"beginCaptures"`
	EndCaptures         rawCaptures        `json:"endCaptures"`
	WhileCaptures       rawCaptures        `json:"whileCaptures"`
	Patterns            []rawRule          `json:"patterns"`
	Repository          map[string]rawRule `json:"repository"`
	ApplyEndPatternLast boolOrInt          `json:"applyEndPatternLast"`
	Injections          map[string]rawRule `json:"injections"`
}

// boolOrInt handles the applyEndPatternLast field which can be true/false or 1/0.
type boolOrInt bool

func (b *boolOrInt) UnmarshalJSON(data []byte) error {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	switch val := v.(type) {
	case bool:
		*b = boolOrInt(val)
	case float64:
		*b = boolOrInt(val != 0)
	default:
		*b = false
	}
	return nil
}
