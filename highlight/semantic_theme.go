package highlight

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/saltyorg/saltbox-lint/highlight/semantics"
)

// Pointer flags distinguish an unspecified property from an explicit reset.
// These are the terminal-renderable properties in VS Code's TokenStyle.
type semanticStyle struct {
	Foreground    string `json:"foreground,omitempty"`
	Bold          *bool  `json:"bold,omitempty"`
	Underline     *bool  `json:"underline,omitempty"`
	Strikethrough *bool  `json:"strikethrough,omitempty"`
	Italic        *bool  `json:"italic,omitempty"`
}
type semanticRule struct {
	selector string
	style    semanticStyle
}
type scopeRule struct {
	matchers   []scopeMatcher
	foreground string
	fontStyle  *string
}
type semanticTheme struct {
	enabled bool
	rules   []semanticRule
	scopes  []scopeRule
}

func parseSemanticTheme(data []byte) (*semanticTheme, error) {
	var raw struct {
		SemanticHighlighting bool
		SemanticTokenColors  json.RawMessage
		TokenColors          []struct {
			Scope    json.RawMessage
			Settings struct {
				Foreground string
				FontStyle  *string
			}
		}
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	theme := &semanticTheme{enabled: raw.SemanticHighlighting}
	for _, rule := range raw.TokenColors {
		if len(rule.Scope) == 0 {
			continue
		}
		var scopes []string
		var single string
		if json.Unmarshal(rule.Scope, &single) == nil {
			scopes = []string{single}
		} else if err := json.Unmarshal(rule.Scope, &scopes); err != nil {
			return nil, err
		}
		r := scopeRule{foreground: strings.ToUpper(rule.Settings.Foreground), fontStyle: rule.Settings.FontStyle}
		for _, scope := range scopes {
			r.matchers = append(r.matchers, parseScopeMatchers(scope)...)
		}
		theme.scopes = append(theme.scopes, r)
	}
	// Decode the object as a stream: Go map iteration would destroy equal-score
	// precedence, which VS Code derives from the original theme JSON rule order.
	if len(raw.SemanticTokenColors) > 0 && string(raw.SemanticTokenColors) != "null" {
		decoder := json.NewDecoder(bytes.NewReader(raw.SemanticTokenColors))
		if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
			return nil, fmt.Errorf("semanticTokenColors must be an object")
		}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			var value json.RawMessage
			if err := decoder.Decode(&value); err != nil {
				return nil, err
			}
			style, err := parseSemanticStyle(value)
			if err != nil {
				return nil, err
			}
			theme.rules = append(theme.rules, semanticRule{key.(string), style})
		}
	}
	return theme, nil
}
func parseSemanticStyle(data []byte) (semanticStyle, error) {
	var color string
	if json.Unmarshal(data, &color) == nil {
		return semanticStyle{Foreground: strings.ToUpper(color)}, nil
	}
	// VS Code ignores boolean/non-style settings.
	if len(data) == 0 || data[0] != '{' {
		return semanticStyle{}, nil
	}
	var raw struct {
		semanticStyle
		FontStyle *string
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return semanticStyle{}, err
	}
	raw.Foreground = strings.ToUpper(raw.Foreground)
	if raw.FontStyle != nil {
		raw.setFontStyle(*raw.FontStyle)
	}
	return raw.semanticStyle, nil
}
func (s *semanticStyle) setFontStyle(value string) {
	words := strings.Fields(value)
	s.Bold = new(slices.Contains(words, "bold"))
	s.Italic = new(slices.Contains(words, "italic"))
	s.Underline = new(slices.Contains(words, "underline"))
	s.Strikethrough = new(slices.Contains(words, "strikethrough"))
}
func (s *semanticStyle) flags() []**bool {
	return []**bool{&s.Bold, &s.Underline, &s.Strikethrough, &s.Italic}
}

func (t *semanticTheme) resolve(typ semantics.TokenType, modifiers []semantics.Modifier, language string) semanticStyle {
	var result semanticStyle
	scores := [5]int{-1, -1, -1, -1, -1}
	for _, rule := range t.rules {
		score := semanticScore(rule.selector, typ, modifiers, language)
		if score < 0 {
			continue
		}
		if rule.style.Foreground != "" && score >= scores[0] {
			result.Foreground = rule.style.Foreground
			scores[0] = score
		}
		for i, p := range rule.style.flags() {
			if *p != nil && score >= scores[i+1] {
				*result.flags()[i] = *p
				scores[i+1] = score
			}
		}
	}
	fallback := t.fallback(typ)
	if result.Foreground == "" {
		result.Foreground = fallback.Foreground
	}
	for i, p := range fallback.flags() {
		if *result.flags()[i] == nil {
			*result.flags()[i] = *p
		}
	}
	return result
}
func semanticScore(selector string, typ semantics.TokenType, modifiers []semantics.Modifier, language string) int {
	classifier, lang, hasLanguage := strings.Cut(selector, ":")
	score := 0
	if hasLanguage {
		if lang != language {
			return -1
		}
		score += 10
	}
	parts := strings.Split(classifier, ".")
	if parts[0] != "*" {
		if parts[0] != string(typ) {
			return -1
		}
		score += 100
	}
	for _, modifier := range parts[1:] {
		if !slices.Contains(modifiers, semantics.Modifier(modifier)) {
			return -1
		}
		score += 100
	}
	return score
}
func (t *semanticTheme) fallback(typ semantics.TokenType) semanticStyle {
	// Standard registry probes are alternatives, each a one-element scope stack.
	// They classify token categories, never words from the document.
	var probes []string
	switch typ {
	case semantics.Class:
		probes = []string{"entity.name.type.class", "support.class"}
	case semantics.Method:
		probes = []string{"entity.name.function.member", "support.function"}
	case semantics.Keyword:
		probes = []string{"keyword.control"}
	case semantics.Property:
		probes = []string{"variable.other.property"}
	}
	for _, probe := range probes {
		var style semanticStyle
		var fontStyle *string
		foregroundScore, fontScore := -1, -1
		for _, rule := range t.scopes {
			score := -1
			for _, match := range rule.matchers {
				score = max(score, match(probe))
			}
			if score < 0 {
				continue
			}
			if rule.foreground != "" && score >= foregroundScore {
				style.Foreground = rule.foreground
				foregroundScore = score
			}
			if rule.fontStyle != nil && score >= fontScore {
				fontStyle = rule.fontStyle
				fontScore = score
			}
		}
		if fontStyle != nil {
			style.setFontStyle(*fontStyle)
		}
		if style.Foreground != "" || fontStyle != nil {
			return style
		}
	}
	return semanticStyle{}
}
