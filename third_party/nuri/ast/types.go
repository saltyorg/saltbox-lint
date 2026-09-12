package ast

import (
	"fmt"
	"hash/fnv"
	"slices"
	"strings"

	"github.com/frostybee/nuri/theme"
)

// CodeToTokensOptions configures a CodeToTokens call.
type CodeToTokensOptions struct {
	Lang  string // language name (e.g. "go", "javascript")
	Theme string // theme name (e.g. "github-dark")

	// Themes enables multi-theme mode: key → theme name
	// (e.g. {"light": "github-light", "dark": "github-dark"}).
	// The code is tokenized once and every theme's style is resolved from
	// the same token stream. The lexicographically first key is the default
	// theme (its style fills ThemedToken.Color/BgColor/FontStyle); the other
	// keys populate ThemedToken.ThemeStyles and TokensResult.ThemeFG/ThemeBG/
	// ThemeNames. When non-empty, Theme is ignored.
	// Mirrors CodeToHTMLOptions.Themes.
	Themes map[string]string

	MaxLineLength *int // nil = use highlighter default; per-line byte-length pre-filter
	TimeoutMs     *int // nil = use highlighter default; per-line soft timeout in ms
}

// TokenStyle holds resolved style for a single theme.
type TokenStyle struct {
	Color     string          `json:"color,omitempty"`
	BgColor   string          `json:"bgColor,omitempty"`
	FontStyle theme.FontStyle `json:"fontStyle"`
}

// ThemedToken represents a single token with resolved style information.
type ThemedToken struct {
	Content   string          `json:"content"`
	Color     string          `json:"color,omitempty"`
	BgColor   string          `json:"bgColor,omitempty"`
	FontStyle theme.FontStyle `json:"fontStyle"`
	Scopes    []string        `json:"scopes,omitempty"`

	// ThemeStyles holds per-theme styles in multi-theme mode.
	// Keys are theme keys from CodeToHTMLOptions.Themes (e.g. "dark").
	// nil in single-theme mode.
	ThemeStyles map[string]TokenStyle `json:"themeStyles,omitempty"`
}

// TokensResult is the output of CodeToTokens.
type TokensResult struct {
	Tokens      [][]ThemedToken `json:"tokens"`
	FG          string          `json:"fg"`
	BG          string          `json:"bg"`
	ThemeName   string          `json:"themeName"`
	Diagnostics []Diagnostic    `json:"diagnostics,omitempty"`

	// Multi-theme: per-theme default colors. nil in single-theme mode.
	ThemeFG    map[string]string `json:"themeFG,omitempty"`
	ThemeBG    map[string]string `json:"themeBG,omitempty"`
	ThemeNames []string          `json:"themeNames,omitempty"`
}

// Diagnostic records a non-fatal degradation during tokenization.
type Diagnostic struct {
	Line int    `json:"line"`
	Kind string `json:"kind"`
}

// ColorDepth specifies the ANSI color mode for terminal output.
type ColorDepth int

const (
	ColorDepthTruecolor ColorDepth = 0   // 24-bit RGB (default)
	ColorDepth256       ColorDepth = 256 // 256-color indexed
	ColorDepth16        ColorDepth = 16  // 16-color (standard + bright)
	ColorDepth8         ColorDepth = 8   // 8-color (standard only)
)

// CodeToANSIOptions configures a CodeToANSI call.
type CodeToANSIOptions struct {
	Lang  string // language name (e.g. "go", "javascript")
	Theme string // theme name (e.g. "github-dark")

	// ColorDepth sets the ANSI color mode.
	// Zero value (ColorDepthTruecolor) uses 24-bit RGB.
	ColorDepth ColorDepth

	MaxLineLength *int // nil = use highlighter default; per-line byte-length pre-filter
	TimeoutMs     *int // nil = use highlighter default; per-line soft timeout in ms
}

// CodeToPlainTextOptions configures a CodeToPlainText call.
type CodeToPlainTextOptions struct {
	Lang          string
	Theme         string
	MaxLineLength *int
	TimeoutMs     *int
}

// CodeToJSONOptions configures a CodeToJSON call.
type CodeToJSONOptions struct {
	Lang          string
	Theme         string
	Themes        map[string]string
	MaxLineLength *int
	TimeoutMs     *int
	Indent        bool
}

// CodeToSVGOptions configures a CodeToSVG call.
type CodeToSVGOptions struct {
	Lang           string
	Theme          string
	MaxLineLength  *int
	TimeoutMs      *int
	FontFamily     string  // default: "Consolas, Monaco, Lucida Console, Liberation Mono, DejaVu Sans Mono, monospace"
	FontSize       float64 // default: 14 (px)
	LineHeight     float64 // default: 1.2 (em multiplier)
	PadX           float64 // default: 16 (px)
	PadY           float64 // default: 16 (px)
	TabWidth       int     // default: 4
	CornerRadius   float64 // default: 8 (px)
	ShowBackground *bool   // nil or *true = show background rect; *false = no background
}

// CodeToHTMLOptions configures a CodeToHTML call.
type CodeToHTMLOptions struct {
	Lang  string
	Theme string // single-theme mode

	// Multi-theme: key → theme name (e.g. {"light":"github-light","dark":"github-dark"}).
	// The lexicographically first key is the default theme (inline styles);
	// others produce CSS variables (--nuri-{key}-{prop}).
	// When non-nil, Theme is ignored.
	Themes map[string]string

	// DefaultColor controls inline color emission in multi-theme mode.
	// nil or *true = emit inline color: for the default theme.
	// *false = emit only CSS variables, no inline styles on tokens.
	DefaultColor *bool

	Transformers   []Transformer
	HighlightLines []LineRange
	FocusLines     []LineRange
	InsertedLines  []LineRange
	DeletedLines   []LineRange
	PreClass       string
	CodeClass      string
	PreAttrs       map[string]string
	CodeAttrs      map[string]string

	// ClassMap replaces inline styles with hashed class names when non-nil.
	// The map accumulates across multiple CodeToHTML calls; call CSS() for the stylesheet.
	ClassMap *StyleClassMap

	MaxLineLength *int // nil = use highlighter default; per-line byte-length pre-filter
	TimeoutMs     *int // nil = use highlighter default; per-line soft timeout in ms
}

// ThemeColors exposes a theme's UI colors for consumers building code block
// chrome (title bars, copy buttons, terminal frames, etc.).
type ThemeColors struct {
	Type                string            // "light" or "dark"
	Background          string            // editor.background
	Foreground          string            // editor.foreground
	SelectionBackground string            // editor.selectionBackground
	LineHighlightBg     string            // editor.lineHighlightBackground
	Colors              map[string]string // full color map (editor.*, terminal.*, etc.)
}

// StyleClassMap collects unique style combinations and assigns deterministic
// class names. Pass a shared instance across multiple CodeToHTML calls to
// deduplicate styles across code blocks, then call CSS() for the stylesheet.
type StyleClassMap struct {
	byCanon map[string]string
	rules   map[string]string
}

// NewStyleClassMap creates an empty StyleClassMap.
func NewStyleClassMap() *StyleClassMap {
	return &StyleClassMap{
		byCanon: make(map[string]string),
		rules:   make(map[string]string),
	}
}

// Get returns the class name for the given style map, creating one if needed.
func (m *StyleClassMap) Get(styles map[string]string) string {
	canon := CanonicalStyles(styles)
	if cls, ok := m.byCanon[canon]; ok {
		return cls
	}
	cls := StyleHash(canon)
	m.byCanon[canon] = cls
	m.rules[cls] = StylestoCSS(styles)
	return cls
}

// CSS returns the complete stylesheet with rules sorted by class name.
func (m *StyleClassMap) CSS() string {
	names := make([]string, 0, len(m.rules))
	for name := range m.rules {
		names = append(names, name)
	}
	slices.Sort(names)

	var sb strings.Builder
	for _, name := range names {
		fmt.Fprintf(&sb, ".%s { %s }\n", name, m.rules[name])
	}
	return sb.String()
}

// CanonicalStyles produces a deterministic string key from a style map.
func CanonicalStyles(styles map[string]string) string {
	keys := make([]string, 0, len(styles))
	for k := range styles {
		keys = append(keys, k)
	}
	slices.Sort(keys)

	var sb strings.Builder
	for i, k := range keys {
		if i > 0 {
			sb.WriteByte(';')
		}
		sb.WriteString(k)
		sb.WriteByte(':')
		sb.WriteString(styles[k])
	}
	return sb.String()
}

// StyleHash computes a deterministic short hash from a canonical style string.
func StyleHash(canon string) string {
	h := fnv.New64a()
	h.Write([]byte(canon))
	return fmt.Sprintf("_s_%x", h.Sum64())
}

// StylestoCSS converts a style map to a CSS rule body string.
func StylestoCSS(styles map[string]string) string {
	keys := make([]string, 0, len(styles))
	for k := range styles {
		keys = append(keys, k)
	}
	slices.Sort(keys)

	var sb strings.Builder
	for i, k := range keys {
		if i > 0 {
			sb.WriteString("; ")
		}
		sb.WriteString(k)
		sb.WriteString(": ")
		sb.WriteString(styles[k])
	}
	return sb.String()
}
