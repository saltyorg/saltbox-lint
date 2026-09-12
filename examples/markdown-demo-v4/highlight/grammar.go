package highlight

import (
	"encoding/json"
	"fmt"
	"slices"
)

// bindInjections bridges Nuri v1.0.1's missing public-registry injection
// forwarding. Self-injections use cross-scope includes so each external grammar
// retains its own repository. Only the in-memory host registration is augmented;
// the embedded grammar assets and all external grammar registrations stay intact.
func bindInjections(host []byte, grammars [][]byte) ([]byte, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(host, &raw); err != nil {
		return nil, err
	}
	var hostScope string
	if err := json.Unmarshal(raw["scopeName"], &hostScope); err != nil {
		return nil, err
	}
	injections := map[string]json.RawMessage{}
	if existing, ok := raw["injections"]; ok {
		if err := json.Unmarshal(existing, &injections); err != nil {
			return nil, err
		}
	}
	for _, data := range grammars {
		var grammar struct {
			ScopeName string   `json:"scopeName"`
			Selector  string   `json:"injectionSelector"`
			InjectTo  []string `json:"injectTo"`
		}
		if err := json.Unmarshal(data, &grammar); err != nil {
			return nil, err
		}
		if grammar.Selector == "" || !slices.Contains(grammar.InjectTo, hostScope) {
			continue
		}
		if _, exists := injections[grammar.Selector]; exists {
			return nil, fmt.Errorf("conflicting injection selector %q in %s", grammar.Selector, hostScope)
		}
		encoded, err := json.Marshal(map[string]string{"include": grammar.ScopeName})
		if err != nil {
			return nil, err
		}
		injections[grammar.Selector] = encoded
	}
	encoded, err := json.Marshal(injections)
	if err != nil {
		return nil, err
	}
	raw["injections"] = encoded
	return json.Marshal(raw)
}
