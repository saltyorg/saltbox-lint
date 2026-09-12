package theme

import (
	"encoding/json"
	"fmt"
	"strings"
)

// FontStyle is a bitmask representing text decoration styles.
type FontStyle int8

const (
	FontStyleNotSet        FontStyle = -1
	FontStyleNone          FontStyle = 0
	FontStyleItalic        FontStyle = 1
	FontStyleBold          FontStyle = 2
	FontStyleUnderline     FontStyle = 4
	FontStyleStrikethrough FontStyle = 8
)

func (fs FontStyle) Has(flag FontStyle) bool {
	return fs&flag != 0
}

func (fs FontStyle) String() string {
	if fs == FontStyleNotSet {
		return "notset"
	}
	if fs == FontStyleNone {
		return "none"
	}
	var parts []string
	if fs.Has(FontStyleItalic) {
		parts = append(parts, "italic")
	}
	if fs.Has(FontStyleBold) {
		parts = append(parts, "bold")
	}
	if fs.Has(FontStyleUnderline) {
		parts = append(parts, "underline")
	}
	if fs.Has(FontStyleStrikethrough) {
		parts = append(parts, "strikethrough")
	}
	return strings.Join(parts, " ")
}

// TokenSettings holds style properties for a scope match.
type TokenSettings struct {
	Foreground string
	Background string
	FontStyle  FontStyle
}

// TokenColor is a single rule mapping scope selectors to style settings.
type TokenColor struct {
	Scopes   []string
	Settings TokenSettings

	// compiled holds the pre-split form of Scopes, populated by Parse.
	// Hand-built TokenColor values leave it nil and Match falls back to
	// per-call selector parsing; a per-selector source check in the matcher
	// keeps post-Parse edits to Scopes correct.
	compiled []compiledSelector
}

// Theme represents a parsed VS Code color theme.
type Theme struct {
	Name              string
	DisplayName       string
	Type              string // "dark" or "light"
	Colors            map[string]string
	TokenColors       []TokenColor
	DefaultForeground string
	DefaultBackground string
}

// Base returns the default foreground/background as a TokenSettings.
func (t *Theme) Base() TokenSettings {
	return TokenSettings{
		Foreground: t.DefaultForeground,
		Background: t.DefaultBackground,
		FontStyle:  FontStyleNone,
	}
}

// Parse parses a VS Code theme JSON file.
func Parse(data []byte) (*Theme, error) {
	var raw rawTheme
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("theme: %w", err)
	}

	t := &Theme{
		Name:        raw.Name,
		DisplayName: raw.DisplayName,
		Type:        raw.Type,
		Colors:      raw.Colors(),
	}

	for i, rtc := range raw.TokenColors {
		scopes, err := parseScopes(rtc.Scope)
		if err != nil {
			return nil, fmt.Errorf("theme: tokenColors[%d]: %w", i, err)
		}
		if len(scopes) == 0 {
			continue
		}
		t.TokenColors = append(t.TokenColors, TokenColor{
			Scopes:   scopes,
			compiled: compileSelectors(scopes),
			Settings: TokenSettings{
				Foreground: rtc.Settings.Foreground,
				Background: rtc.Settings.Background,
				FontStyle:  parseFontStyle(rtc.Settings.FontStyle),
			},
		})
	}

	normalize(t)
	return t, nil
}

func parseScopes(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}

	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		s = strings.TrimSpace(s)
		if s == "" {
			return nil, nil
		}
		parts := strings.Split(s, ",")
		scopes := make([]string, 0, len(parts))
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p != "" {
				scopes = append(scopes, p)
			}
		}
		return scopes, nil
	}

	var arr []string
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, fmt.Errorf("scope must be string or []string")
	}
	scopes := make([]string, 0, len(arr))
	for _, s := range arr {
		s = strings.TrimSpace(s)
		if s != "" {
			scopes = append(scopes, s)
		}
	}
	return scopes, nil
}

func parseFontStyle(s *string) FontStyle {
	if s == nil {
		return FontStyleNotSet
	}
	if *s == "" {
		return FontStyleNone
	}
	var fs FontStyle
	for _, part := range strings.Fields(*s) {
		switch strings.ToLower(part) {
		case "italic":
			fs |= FontStyleItalic
		case "bold":
			fs |= FontStyleBold
		case "underline":
			fs |= FontStyleUnderline
		case "strikethrough":
			fs |= FontStyleStrikethrough
		}
	}
	return fs
}

type rawTheme struct {
	Name        string                     `json:"name"`
	DisplayName string                     `json:"displayName"`
	Type        string                     `json:"type"`
	RawColors   map[string]json.RawMessage `json:"colors"`
	TokenColors []rawTokenColor            `json:"tokenColors"`
}

func (r *rawTheme) Colors() map[string]string {
	m := make(map[string]string, len(r.RawColors))
	for k, v := range r.RawColors {
		var s string
		if json.Unmarshal(v, &s) == nil {
			m[k] = s
		}
	}
	return m
}

type rawTokenColor struct {
	Scope    json.RawMessage `json:"scope"`
	Settings rawSettings     `json:"settings"`
}

type rawSettings struct {
	Foreground string  `json:"foreground"`
	Background string  `json:"background"`
	FontStyle  *string `json:"fontStyle"`
}
