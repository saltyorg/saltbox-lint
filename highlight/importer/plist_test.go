package importer

import (
	"encoding/json"
	"strings"
	"testing"
)

// Losing XML escaping, captures, or manifest injections breaks real grammar loading.
func TestGrammarPreservesRulesAndInjectionTargets(t *testing.T) {
	input := `<plist><dict><key>scopeName</key><string>injection.test</string><key>patterns</key><array><dict><key>match</key><string>(?&lt;=x)\w+&amp;</string><key>captures</key><dict><key>1</key><dict><key>name</key><string>variable.other</string></dict></dict></dict></array></dict></plist>`
	out, err := Grammar([]byte(input), []string{"source.ansible"})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"source.ansible"`) {
		t.Fatalf("missing manifest injection: %s", out)
	}
	p := got["patterns"].([]any)[0].(map[string]any)
	if p["match"] != `(?<=x)\w+&` {
		t.Fatalf("regex changed: %v", p["match"])
	}
	if p["captures"].(map[string]any)["1"].(map[string]any)["name"] != "variable.other" {
		t.Fatal("capture lost")
	}
}
