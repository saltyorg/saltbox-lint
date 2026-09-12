package highlight

import (
	"github.com/frostybee/nuri"
	"slices"
	"testing"
)

// This gate isolates external-injection repository ownership from Ansible/YAML.
func TestNuriExternalInjectionOwnRepository(t *testing.T) {
	for _, adapted := range []bool{false, true} {
		t.Run(map[bool]string{false: "unadapted_defect", true: "manifest_bridge"}[adapted], func(t *testing.T) {
			injection := []byte(`{"scopeName":"injection.test","injectTo":["source.host"],"injectionSelector":"L:string","patterns":[{"include":"#word"}],"repository":{"word":{"match":"item","name":"variable.other.injected"}}}`)
			host, err := bindInjections([]byte(`{"scopeName":"source.host","patterns":[{"begin":"\"","end":"\"","name":"string.quoted.host"}]}`), [][]byte{injection})
			if err != nil {
				t.Fatal(err)
			}
			if !adapted {
				host = []byte(`{"scopeName":"source.host","patterns":[{"begin":"\"","end":"\"","name":"string.quoted.host"}]}`)
			}
			h, err := nuri.New(t.Context(), nuri.WithMinContrast(0), nuri.WithPoolSize(1),
				nuri.WithGrammar("host", host),
				nuri.WithGrammar("inject", injection),
				nuri.WithTheme("test", []byte(`{"name":"test","colors":{"editor.foreground":"#FFFFFF","editor.background":"#000000"},"tokenColors":[]}`)),
			)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := h.Close(t.Context()); err != nil {
					t.Errorf("close highlighter: %v", err)
				}
			}()
			out, err := h.CodeToTokens(t.Context(), `"item"`, nuri.CodeToTokensOptions{Lang: "host", Theme: "test"})
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, tok := range out.Tokens[0] {
				if tok.Content == "item" && slices.Contains(tok.Scopes, "variable.other.injected") {
					found = true
				}
			}
			if found != adapted {
				t.Fatalf("adapted=%v: injection found=%v; tokens=%+v diagnostics=%+v", adapted, found, out.Tokens, out.Diagnostics)
			}
		})
	}
}
