package highlight

import (
	"encoding/json"
	"fmt"
	"strings"
)

// normalizeTheme merges duplicate selectors by last defined property, including
// empty fontStyle. Nuri's matcher otherwise keeps the first equally ranked rule.
func normalizeTheme(data []byte) ([]byte, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	var rules []struct {
		Scope    json.RawMessage            `json:"scope"`
		Settings map[string]json.RawMessage `json:"settings"`
	}
	if err := json.Unmarshal(raw["tokenColors"], &rules); err != nil {
		return nil, err
	}
	order := []string{}
	settings := map[string]map[string]json.RawMessage{}
	for _, rule := range rules {
		var scopes []string
		var single string
		if len(rule.Scope) == 0 {
			continue
		}
		if json.Unmarshal(rule.Scope, &single) == nil {
			scopes = []string{single}
		} else if err := json.Unmarshal(rule.Scope, &scopes); err != nil {
			return nil, fmt.Errorf("theme scope: %w", err)
		}
		for _, group := range scopes {
			for _, selector := range strings.Split(group, ",") {
				selector = strings.Join(strings.Fields(selector), " ")
				if selector == "" {
					continue
				}
				if settings[selector] == nil {
					settings[selector] = map[string]json.RawMessage{}
					order = append(order, selector)
				}
				for key, value := range rule.Settings {
					settings[selector][key] = value
				}
			}
		}
	}
	normalized := []map[string]any{}
	// Later selectors win any remaining equal-specificity ties in Nuri.
	for i := len(order) - 1; i >= 0; i-- {
		selector := order[i]
		normalized = append(normalized, map[string]any{"scope": selector, "settings": settings[selector]})
	}
	colors, err := json.Marshal(normalized)
	if err != nil {
		return nil, err
	}
	raw["tokenColors"] = colors
	return json.Marshal(raw)
}
