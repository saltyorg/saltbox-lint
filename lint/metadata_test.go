package lint

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestRegistryProjection(t *testing.T) {
	registry := Registry()
	rules := Rules()
	if registry.SchemaVersion != 1 || len(registry.Rules) != len(rules) {
		t.Fatalf("registry coverage: %#v", registry)
	}
	ids := map[string]Rule{}
	for _, rule := range rules {
		ids[rule.ID] = rule
	}
	var previous string
	for _, metadata := range registry.Rules {
		rule, exists := ids[metadata.ID]
		if !exists || metadata.ID <= previous || metadata.Summary != rule.Summary || metadata.Explanation != rule.Explanation || metadata.Scope != rule.Scope || metadata.GoodExample != rule.GoodExample || metadata.BadExample != rule.BadExample || metadata.Fixable != rule.Fixable || !slices.IsSorted(metadata.Kinds) {
			t.Fatalf("incomplete or unordered metadata: %#v", metadata)
		}
		previous = metadata.ID
		if metadata.GoodExample == "" || metadata.BadExample == "" || len(metadata.Kinds) == 0 {
			t.Fatal("empty metadata")
		}
	}
	wire, err := json.Marshal(registry)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{`"Check":`, `"structural":`, `"Context":`, `"fixRules":`} {
		if strings.Contains(string(wire), private) {
			t.Fatalf("private implementation exposed: %s", private)
		}
	}
	registry.Rules[0].Kinds[0] = Template
	if Registry().Rules[0].Kinds[0] == Template {
		t.Fatal("registry aliases private source kinds")
	}
}
