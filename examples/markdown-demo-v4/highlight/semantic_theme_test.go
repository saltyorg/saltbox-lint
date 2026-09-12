package highlight

import (
	"encoding/json"
	"os"
	"reflect"
	"saltbox-lint-markdown-demo-v4/semantics"
	"testing"
)

// Losing selector order, resetting an unspecified property, or taking the wrong
// alternate fallback changes these independently executed VS Code results.
func TestSemanticStylesMatchVSCodeOracle(t *testing.T) {
	data, err := os.ReadFile("testdata/upstream-semantic-style-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name      string
		Theme     json.RawMessage
		Type      semantics.TokenType
		Modifiers []semantics.Modifier
		Language  string
		Expected  semanticStyle
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, test := range cases {
		t.Run(test.Name, func(t *testing.T) {
			theme, err := parseSemanticTheme(test.Theme)
			if err != nil {
				t.Fatal(err)
			}
			got := theme.resolve(test.Type, test.Modifiers, test.Language)
			if !reflect.DeepEqual(got, test.Expected) {
				t.Errorf("style = %+v, want %+v", got, test.Expected)
			}
		})
	}
}
func TestActualThemeSemanticDefaults(t *testing.T) {
	data, err := os.ReadFile("testdata/semantic-fallback-colors.json")
	if err != nil {
		t.Fatal(err)
	}
	var oracle map[string]json.RawMessage
	if err = json.Unmarshal(data, &oracle); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"one-dark-pro", "one-light"} {
		t.Run(name, func(t *testing.T) {
			var want struct {
				SemanticHighlighting bool
				Styles               map[semantics.TokenType]semanticStyle
			}
			if err := json.Unmarshal(oracle[name], &want); err != nil {
				t.Fatal(err)
			}
			data, err := assets.ReadFile("assets/themes/" + name + ".json")
			if err != nil {
				t.Fatal(err)
			}
			theme, err := parseSemanticTheme(data)
			if err != nil {
				t.Fatal(err)
			}
			if theme.enabled != want.SemanticHighlighting {
				t.Errorf("enabled=%v, want %v", theme.enabled, want.SemanticHighlighting)
			}
			for typ, style := range want.Styles {
				if got := theme.resolve(typ, nil, "ansible"); !reflect.DeepEqual(got, style) {
					t.Errorf("%s = %+v, want %+v", typ, got, style)
				}
			}
		})
	}
}
