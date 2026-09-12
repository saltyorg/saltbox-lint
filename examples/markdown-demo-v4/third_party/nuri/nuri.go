package nuri

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"

	"github.com/frostybee/nuri/ast"
	"github.com/frostybee/nuri/internal/ansi"
	"github.com/frostybee/nuri/internal/oniguruma"
	"github.com/frostybee/nuri/internal/registry"
	"github.com/frostybee/nuri/internal/tokenizer"
	"github.com/frostybee/nuri/renderer"
	"github.com/frostybee/nuri/theme"
)

// Re-export ast types so consumers can write nuri.Element, etc.
type (
	Element                = ast.Element
	Text                   = ast.Text
	Node                   = ast.Node
	Transformer            = ast.Transformer
	BaseTransformer        = ast.BaseTransformer
	ThemedToken            = ast.ThemedToken
	TokenStyle             = ast.TokenStyle
	TokensResult           = ast.TokensResult
	Diagnostic             = ast.Diagnostic
	CodeToTokensOptions    = ast.CodeToTokensOptions
	CodeToHTMLOptions      = ast.CodeToHTMLOptions
	CodeToANSIOptions      = ast.CodeToANSIOptions
	CodeToPlainTextOptions = ast.CodeToPlainTextOptions
	CodeToJSONOptions      = ast.CodeToJSONOptions
	CodeToSVGOptions       = ast.CodeToSVGOptions
	ColorDepth             = ast.ColorDepth
	LineRange              = ast.LineRange
	StyleClassMap          = ast.StyleClassMap
	ThemeColors            = ast.ThemeColors
)

// Re-export ast functions.
var (
	Range            = ast.Range
	Lines            = ast.Lines
	NewStyleClassMap = ast.NewStyleClassMap
)

// Re-export ANSI color depth constants.
const (
	ColorDepthTruecolor = ast.ColorDepthTruecolor
	ColorDepth256       = ast.ColorDepth256
	ColorDepth16        = ast.ColorDepth16
	ColorDepth8         = ast.ColorDepth8
)

// Highlighter is the main entry point for syntax highlighting.
// It owns WASM resources and must be closed when no longer needed.
type Highlighter struct {
	eng           *oniguruma.Engine
	pool          *oniguruma.Pool
	reg           *registry.Registry
	maxLineLength int
	timeoutMs     int
	minContrast   float64
	defaults      *ast.CodeToHTMLOptions
	closeOnce     sync.Once

	adjustedMu sync.RWMutex
	adjusted   map[string]*theme.Theme
}

// New compiles the WASM engine, instantiates a pool of WASM instances,
// and builds the grammar/theme registry. It does real work and may fail.
func New(ctx context.Context, opts ...Option) (*Highlighter, error) {
	cfg := defaultOptions()
	for _, o := range opts {
		o(&cfg)
	}
	if cfg.poolSize < 1 {
		cfg.poolSize = 1
	}

	engOpts := []oniguruma.EngineOption{
		oniguruma.WithEngineCloseOnContextDone(cfg.regexInterruption),
	}
	if cfg.compilationCacheDir != "" {
		engOpts = append(engOpts, oniguruma.WithEngineCompilationCacheDir(cfg.compilationCacheDir))
	}
	eng, err := oniguruma.NewEngine(ctx, engOpts...)
	if err != nil {
		return nil, err
	}

	pool, err := oniguruma.NewPool(ctx, eng, cfg.poolSize)
	if err != nil {
		eng.Close(ctx)
		return nil, err
	}

	reg, err := registry.New(cfg.grammarFS, cfg.themeFS)
	if err != nil {
		pool.Close(ctx)
		eng.Close(ctx)
		return nil, err
	}

	for alias, target := range defaultAliases {
		reg.RegisterAlias(alias, target)
	}
	for ext, lang := range defaultExtensions {
		reg.RegisterExtension(ext, lang)
	}
	for filename, lang := range defaultFilenames {
		reg.RegisterFilename(filename, lang)
	}
	for _, e := range cfg.extensions {
		reg.RegisterExtension(e.ext, e.lang)
	}
	for _, g := range cfg.grammars {
		if err := reg.RegisterGrammar(g.name, g.data); err != nil {
			pool.Close(ctx)
			eng.Close(ctx)
			return nil, err
		}
	}
	for _, t := range cfg.themes {
		if err := reg.RegisterTheme(t.name, t.data); err != nil {
			pool.Close(ctx)
			eng.Close(ctx)
			return nil, err
		}
	}
	for _, a := range cfg.aliases {
		reg.RegisterAlias(a.alias, a.target)
	}

	return &Highlighter{
		eng:           eng,
		pool:          pool,
		reg:           reg,
		maxLineLength: cfg.maxLineLength,
		timeoutMs:     cfg.timeoutMs,
		minContrast:   cfg.minContrast,
		defaults:      cfg.defaults,
		adjusted:      make(map[string]*theme.Theme),
	}, nil
}

func (h *Highlighter) resolveTokenizeOpts(maxLine, timeout *int) tokenizer.TokenizeOptions {
	opts := tokenizer.TokenizeOptions{
		MaxLineLength: h.maxLineLength,
		TimeoutMs:     h.timeoutMs,
	}
	if maxLine != nil {
		opts.MaxLineLength = *maxLine
	}
	if timeout != nil {
		opts.TimeoutMs = *timeout
	}
	return opts
}

// getTheme retrieves a theme by name and applies contrast adjustment if
// minContrast > 0. Adjusted themes are cached per name so each theme is
// processed exactly once regardless of how many blocks are rendered.
func (h *Highlighter) getTheme(name string) (*theme.Theme, error) {
	if h.minContrast <= 0 {
		return h.reg.GetTheme(name)
	}

	h.adjustedMu.RLock()
	if t, ok := h.adjusted[name]; ok {
		h.adjustedMu.RUnlock()
		return t, nil
	}
	h.adjustedMu.RUnlock()

	thm, err := h.reg.GetTheme(name)
	if err != nil {
		return nil, err
	}

	t := adjustThemeContrast(thm, h.minContrast)

	h.adjustedMu.Lock()
	h.adjusted[name] = t
	h.adjustedMu.Unlock()
	return t, nil
}

// adjustThemeContrast returns a shallow copy of the theme with all token
// foreground colors adjusted to meet the minimum contrast ratio against
// the theme's background.
func adjustThemeContrast(thm *theme.Theme, minContrast float64) *theme.Theme {
	bg := thm.DefaultBackground

	cp := *thm
	cp.DefaultForeground = adjustForeground(cp.DefaultForeground, bg, minContrast)

	cp.TokenColors = make([]theme.TokenColor, len(thm.TokenColors))
	copy(cp.TokenColors, thm.TokenColors)
	for i := range cp.TokenColors {
		fg := cp.TokenColors[i].Settings.Foreground
		if fg != "" {
			cp.TokenColors[i].Settings.Foreground = adjustForeground(fg, bg, minContrast)
		}
	}
	return &cp
}

// Close releases all WASM resources. Safe to call multiple times.
func (h *Highlighter) Close(ctx context.Context) error {
	var closeErr error
	h.closeOnce.Do(func() {
		poolErr := h.pool.Close(ctx)
		engErr := h.eng.Close(ctx)
		closeErr = errors.Join(poolErr, engErr)
	})
	return closeErr
}

// CodeToTokens tokenizes source code and resolves each token's color
// from the specified theme. When opts.Themes is non-empty the code is
// tokenized once and every theme is resolved from the same token stream
// (opts.Theme is ignored); see CodeToTokensOptions.Themes.
func (h *Highlighter) CodeToTokens(
	ctx context.Context,
	code string,
	opts ast.CodeToTokensOptions,
) (*ast.TokensResult, error) {
	if len(opts.Themes) > 0 {
		return h.codeToTokensMulti(ctx, code, opts.Lang, opts.Themes, opts.MaxLineLength, opts.TimeoutMs)
	}

	thm, err := h.getTheme(opts.Theme)
	if err != nil {
		return nil, err
	}

	if opts.Lang == "ansi" {
		return h.ansiHighlight(code, thm), nil
	}

	g, langErr := h.reg.GetGrammar(opts.Lang)
	if langErr != nil && !errors.Is(langErr, ErrLanguageNotFound) {
		return nil, langErr
	}

	if g == nil {
		return h.plaintextFallback(code, thm), nil
	}

	tokOpts := h.resolveTokenizeOpts(opts.MaxLineLength, opts.TimeoutMs)
	var tokResult *tokenizer.TokenizeResult
	doErr := h.pool.Do(ctx, func(lib oniguruma.OnigLib) error {
		var tokenizeErr error
		tokResult, tokenizeErr = tokenizer.Tokenize(ctx, []byte(code), g, lib, tokOpts, h.reg)
		return tokenizeErr
	})
	if doErr != nil {
		return nil, doErr
	}

	return h.buildResult(code, tokResult, thm), nil
}

// CodeToHighlightedTokens tokenizes source code and resolves each token's
// color from the specified theme, returning colored tokens without HTML.
// This is equivalent to CodeToTokens (which already resolves colors).
func (h *Highlighter) CodeToHighlightedTokens(
	ctx context.Context,
	code string,
	opts ast.CodeToTokensOptions,
) (*ast.TokensResult, error) {
	return h.CodeToTokens(ctx, code, opts)
}

// GetThemeColors returns the UI colors for a loaded theme. Consumers building
// code block chrome (title bars, copy buttons, terminal frames) use these to
// style their wrappers consistently with the highlighted code.
func (h *Highlighter) GetThemeColors(themeName string) (ThemeColors, error) {
	thm, err := h.getTheme(themeName)
	if err != nil {
		return ThemeColors{}, err
	}
	return ThemeColors{
		Type:                thm.Type,
		Background:          thm.DefaultBackground,
		Foreground:          thm.DefaultForeground,
		SelectionBackground: thm.Colors["editor.selectionBackground"],
		LineHighlightBg:     thm.Colors["editor.lineHighlightBackground"],
		Colors:              thm.Colors,
	}, nil
}

// DetectLanguage resolves a language name from a filename or path.
// It checks exact filenames first (e.g. "Makefile"), then file extensions.
// Returns the language name usable with CodeToHTML/CodeToANSI/CodeToTokens,
// and true if a match was found.
func (h *Highlighter) DetectLanguage(filename string) (string, bool) {
	return h.reg.DetectByFilename(filename)
}

// DetectLanguageByContent resolves a language from the first line of content.
// Useful for shebang detection (e.g. "#!/usr/bin/env python3").
func (h *Highlighter) DetectLanguageByContent(firstLine string) (string, bool) {
	return h.reg.DetectByFirstLine(firstLine)
}

// RegisterExtension maps a file extension (without dot) to a language name,
// overriding any existing mapping for that extension.
func (h *Highlighter) RegisterExtension(ext, lang string) {
	h.reg.RegisterExtension(ext, lang)
}

func (h *Highlighter) applyDefaults(opts ast.CodeToHTMLOptions) ast.CodeToHTMLOptions {
	if h.defaults == nil {
		return opts
	}
	d := *h.defaults
	if opts.Lang != "" {
		d.Lang = opts.Lang
	}
	if opts.Theme != "" {
		d.Theme = opts.Theme
	}
	if opts.Themes != nil {
		d.Themes = opts.Themes
	}
	if opts.DefaultColor != nil {
		d.DefaultColor = opts.DefaultColor
	}
	if opts.Transformers != nil {
		d.Transformers = opts.Transformers
	}
	if opts.HighlightLines != nil {
		d.HighlightLines = opts.HighlightLines
	}
	if opts.FocusLines != nil {
		d.FocusLines = opts.FocusLines
	}
	if opts.InsertedLines != nil {
		d.InsertedLines = opts.InsertedLines
	}
	if opts.DeletedLines != nil {
		d.DeletedLines = opts.DeletedLines
	}
	if opts.PreClass != "" {
		d.PreClass = opts.PreClass
	}
	if opts.CodeClass != "" {
		d.CodeClass = opts.CodeClass
	}
	if opts.PreAttrs != nil {
		d.PreAttrs = opts.PreAttrs
	}
	if opts.CodeAttrs != nil {
		d.CodeAttrs = opts.CodeAttrs
	}
	if opts.ClassMap != nil {
		d.ClassMap = opts.ClassMap
	}
	if opts.MaxLineLength != nil {
		d.MaxLineLength = opts.MaxLineLength
	}
	if opts.TimeoutMs != nil {
		d.TimeoutMs = opts.TimeoutMs
	}

	// The merged struct shares slice backing arrays with h.defaults or
	// with the caller's options. Transformers append to the line range
	// slices through the merged options (e.g. Meta.Preprocess), so an
	// append into spare capacity would write into the shared array and
	// leak ranges across calls. Exact length copies force any later
	// append to reallocate.
	d.HighlightLines = cloneRanges(d.HighlightLines)
	d.FocusLines = cloneRanges(d.FocusLines)
	d.InsertedLines = cloneRanges(d.InsertedLines)
	d.DeletedLines = cloneRanges(d.DeletedLines)
	return d
}

// cloneRanges returns an exact length copy of rs, or nil for empty input.
func cloneRanges(rs []ast.LineRange) []ast.LineRange {
	if len(rs) == 0 {
		return nil
	}
	out := make([]ast.LineRange, len(rs))
	copy(out, rs)
	return out
}

// CodeToHTML tokenizes source code, resolves colors from the theme,
// and renders the result as an HTML string.
func (h *Highlighter) CodeToHTML(
	ctx context.Context,
	code string,
	opts ast.CodeToHTMLOptions,
) (string, error) {
	opts = h.applyDefaults(opts)
	for _, tr := range opts.Transformers {
		if s := tr.Preprocess(code, &opts); s != "" {
			code = s
		}
	}

	var result *ast.TokensResult
	var err error
	if len(opts.Themes) > 0 { // len, not nil: an empty map must not enter the multi path
		result, err = h.codeToTokensMulti(ctx, code, opts.Lang, opts.Themes, opts.MaxLineLength, opts.TimeoutMs)
	} else {
		result, err = h.CodeToTokens(ctx, code, ast.CodeToTokensOptions{
			Lang:          opts.Lang,
			Theme:         opts.Theme,
			MaxLineLength: opts.MaxLineLength,
			TimeoutMs:     opts.TimeoutMs,
		})
	}
	if err != nil {
		return "", err
	}

	tokens := result.Tokens
	for _, tr := range opts.Transformers {
		if t := tr.Tokens(tokens); t != nil {
			tokens = t
		}
	}
	result.Tokens = tokens

	tree := renderer.BuildTree(result, &opts)

	var buf strings.Builder
	tree.WriteTo(&buf)
	html := buf.String()

	for _, tr := range opts.Transformers {
		if s := tr.Postprocess(html, &opts); s != "" {
			html = s
		}
	}

	return html, nil
}

// CodeToANSI tokenizes source code, resolves colors from the theme,
// and renders the result as ANSI escape sequences for terminal display.
func (h *Highlighter) CodeToANSI(
	ctx context.Context,
	code string,
	opts ast.CodeToANSIOptions,
) (string, error) {
	result, err := h.CodeToTokens(ctx, code, ast.CodeToTokensOptions{
		Lang:          opts.Lang,
		Theme:         opts.Theme,
		MaxLineLength: opts.MaxLineLength,
		TimeoutMs:     opts.TimeoutMs,
	})
	if err != nil {
		return "", err
	}

	var buf strings.Builder
	if err := renderer.RenderANSI(&buf, result, &opts); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// CodeToPlainText tokenizes source code and returns the concatenated
// token content with no formatting.
func (h *Highlighter) CodeToPlainText(
	ctx context.Context,
	code string,
	opts ast.CodeToPlainTextOptions,
) (string, error) {
	result, err := h.CodeToTokens(ctx, code, ast.CodeToTokensOptions{
		Lang:          opts.Lang,
		Theme:         opts.Theme,
		MaxLineLength: opts.MaxLineLength,
		TimeoutMs:     opts.TimeoutMs,
	})
	if err != nil {
		return "", err
	}

	var buf strings.Builder
	if err := renderer.RenderPlainText(&buf, result); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// CodeToJSON tokenizes source code, resolves colors from the theme,
// and returns the result as JSON bytes.
func (h *Highlighter) CodeToJSON(
	ctx context.Context,
	code string,
	opts ast.CodeToJSONOptions,
) ([]byte, error) {
	var result *ast.TokensResult
	var err error
	if len(opts.Themes) > 0 {
		result, err = h.codeToTokensMulti(ctx, code, opts.Lang, opts.Themes, opts.MaxLineLength, opts.TimeoutMs)
	} else {
		result, err = h.CodeToTokens(ctx, code, ast.CodeToTokensOptions{
			Lang:          opts.Lang,
			Theme:         opts.Theme,
			MaxLineLength: opts.MaxLineLength,
			TimeoutMs:     opts.TimeoutMs,
		})
	}
	if err != nil {
		return nil, err
	}

	if opts.Indent {
		return json.MarshalIndent(result, "", "  ")
	}
	return json.Marshal(result)
}

// CodeToSVG tokenizes source code, resolves colors from the theme,
// and renders the result as a self-contained SVG document.
func (h *Highlighter) CodeToSVG(
	ctx context.Context,
	code string,
	opts ast.CodeToSVGOptions,
) (string, error) {
	result, err := h.CodeToTokens(ctx, code, ast.CodeToTokensOptions{
		Lang:          opts.Lang,
		Theme:         opts.Theme,
		MaxLineLength: opts.MaxLineLength,
		TimeoutMs:     opts.TimeoutMs,
	})
	if err != nil {
		return "", err
	}

	var buf strings.Builder
	if err := renderer.RenderSVG(&buf, result, &opts); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// resolveStyle resolves a token's style against one theme, applying the
// default-foreground and font-style-none fallbacks.
func resolveStyle(thm *theme.Theme, scopes []string) ast.TokenStyle {
	ts := thm.Match(scopes)
	color := ts.Foreground
	if color == "" {
		color = thm.DefaultForeground
	}
	fontStyle := ts.FontStyle
	if fontStyle == theme.FontStyleNotSet {
		fontStyle = theme.FontStyleNone
	}
	return ast.TokenStyle{
		Color:     color,
		BgColor:   ts.Background,
		FontStyle: fontStyle,
	}
}

func (h *Highlighter) buildResult(
	code string,
	tokResult *tokenizer.TokenizeResult,
	thm *theme.Theme,
) *ast.TokensResult {
	lines := splitLines([]byte(code))
	result := &ast.TokensResult{
		Tokens:    make([][]ast.ThemedToken, len(tokResult.Lines)),
		FG:        thm.DefaultForeground,
		BG:        thm.DefaultBackground,
		ThemeName: thm.Name,
	}

	for i, tokLine := range tokResult.Lines {
		themed := make([]ast.ThemedToken, 0, len(tokLine))
		var line []byte
		if i < len(lines) {
			line = lines[i]
		}
		for _, tok := range tokLine {
			var content string
			if line != nil && tok.Start >= 0 && tok.End <= len(line) {
				content = string(line[tok.Start:tok.End])
			}
			if content == "" {
				continue
			}
			ts := resolveStyle(thm, tok.Scopes)
			themed = append(themed, ast.ThemedToken{
				Content:   content,
				Color:     ts.Color,
				BgColor:   ts.BgColor,
				FontStyle: ts.FontStyle,
				Scopes:    tok.Scopes,
			})
		}
		result.Tokens[i] = themed
	}

	for _, d := range tokResult.Diagnostics {
		result.Diagnostics = append(result.Diagnostics, ast.Diagnostic{
			Line: d.Line,
			Kind: d.Kind,
		})
	}

	return result
}

// buildResultMulti is buildResult's multi-theme sibling: it resolves the
// default theme AND every non-default theme for each token in the same pass.
// Building ThemeStyles here — under the same empty-content skip that decides
// which tokens exist at all — is what keeps styles aligned with tokens; a
// separate indexed pass over the raw tokenizer lines desyncs as soon as a
// token is skipped.
func (h *Highlighter) buildResultMulti(
	code string,
	tokResult *tokenizer.TokenizeResult,
	thms map[string]*theme.Theme,
	keys []string,
	defaultKey string,
) *ast.TokensResult {
	defaultThm := thms[defaultKey]
	lines := splitLines([]byte(code))
	result := &ast.TokensResult{
		Tokens:    make([][]ast.ThemedToken, len(tokResult.Lines)),
		FG:        defaultThm.DefaultForeground,
		BG:        defaultThm.DefaultBackground,
		ThemeName: defaultThm.Name,
	}

	for i, tokLine := range tokResult.Lines {
		themed := make([]ast.ThemedToken, 0, len(tokLine))
		var line []byte
		if i < len(lines) {
			line = lines[i]
		}
		for _, tok := range tokLine {
			var content string
			if line != nil && tok.Start >= 0 && tok.End <= len(line) {
				content = string(line[tok.Start:tok.End])
			}
			if content == "" {
				continue
			}
			def := resolveStyle(defaultThm, tok.Scopes)
			styles := make(map[string]ast.TokenStyle, len(keys)-1)
			for _, k := range keys {
				if k == defaultKey {
					continue
				}
				styles[k] = resolveStyle(thms[k], tok.Scopes)
			}
			themed = append(themed, ast.ThemedToken{
				Content:     content,
				Color:       def.Color,
				BgColor:     def.BgColor,
				FontStyle:   def.FontStyle,
				Scopes:      tok.Scopes,
				ThemeStyles: styles,
			})
		}
		result.Tokens[i] = themed
	}

	for _, d := range tokResult.Diagnostics {
		result.Diagnostics = append(result.Diagnostics, ast.Diagnostic{
			Line: d.Line,
			Kind: d.Kind,
		})
	}

	return result
}

func (h *Highlighter) codeToTokensMulti(
	ctx context.Context,
	code string,
	lang string,
	themes map[string]string,
	maxLineLength, timeoutMs *int,
) (*ast.TokensResult, error) {
	keys := make([]string, 0, len(themes))
	for k := range themes {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	thms := make(map[string]*theme.Theme, len(keys))
	for _, k := range keys {
		thm, err := h.getTheme(themes[k])
		if err != nil {
			return nil, err
		}
		thms[k] = thm
	}

	defaultKey := keys[0]

	if lang == "ansi" {
		result := h.ansiHighlightMulti(code, thms, keys, defaultKey)
		h.addMultiThemeInfo(result, keys, thms, defaultKey)
		return result, nil
	}

	g, langErr := h.reg.GetGrammar(lang)
	if langErr != nil && !errors.Is(langErr, ErrLanguageNotFound) {
		return nil, langErr
	}

	if g == nil {
		result := h.plaintextFallbackMulti(code, thms, keys, defaultKey)
		h.addMultiThemeInfo(result, keys, thms, defaultKey)
		return result, nil
	}

	tokOpts := h.resolveTokenizeOpts(maxLineLength, timeoutMs)
	var tokResult *tokenizer.TokenizeResult
	doErr := h.pool.Do(ctx, func(lib oniguruma.OnigLib) error {
		var tokenizeErr error
		tokResult, tokenizeErr = tokenizer.Tokenize(ctx, []byte(code), g, lib, tokOpts, h.reg)
		return tokenizeErr
	})
	if doErr != nil {
		return nil, doErr
	}

	result := h.buildResultMulti(code, tokResult, thms, keys, defaultKey)
	h.addMultiThemeInfo(result, keys, thms, defaultKey)
	return result, nil
}

func (h *Highlighter) addMultiThemeInfo(
	result *ast.TokensResult,
	keys []string,
	thms map[string]*theme.Theme,
	defaultKey string,
) {
	result.ThemeNames = keys
	result.ThemeFG = make(map[string]string, len(keys))
	result.ThemeBG = make(map[string]string, len(keys))
	for _, k := range keys {
		if k == defaultKey {
			continue
		}
		result.ThemeFG[k] = thms[k].DefaultForeground
		result.ThemeBG[k] = thms[k].DefaultBackground
	}
}

func (h *Highlighter) ansiHighlight(code string, thm *theme.Theme) *ast.TokensResult {
	lines := ansi.Tokenize(code)
	themed := make([][]ast.ThemedToken, len(lines))
	for i, tokLine := range lines {
		row := make([]ast.ThemedToken, len(tokLine))
		for j, tok := range tokLine {
			color := tok.Style.FG
			if color == "" {
				color = thm.DefaultForeground
			}
			row[j] = ast.ThemedToken{
				Content:   tok.Content,
				Color:     color,
				BgColor:   tok.Style.BG,
				FontStyle: tok.Style.FontStyle,
			}
		}
		themed[i] = row
	}
	return &ast.TokensResult{
		Tokens:    themed,
		FG:        thm.DefaultForeground,
		BG:        thm.DefaultBackground,
		ThemeName: thm.Name,
	}
}

// ansiHighlightMulti is ansiHighlight's multi-theme sibling. ANSI colors are
// theme-independent; only tokens without an explicit ANSI foreground take a
// theme's default foreground, so that is the only per-theme difference.
func (h *Highlighter) ansiHighlightMulti(
	code string,
	thms map[string]*theme.Theme,
	keys []string,
	defaultKey string,
) *ast.TokensResult {
	defaultThm := thms[defaultKey]
	lines := ansi.Tokenize(code)
	themed := make([][]ast.ThemedToken, len(lines))
	for i, tokLine := range lines {
		row := make([]ast.ThemedToken, len(tokLine))
		for j, tok := range tokLine {
			color := tok.Style.FG
			if color == "" {
				color = defaultThm.DefaultForeground
			}
			styles := make(map[string]ast.TokenStyle, len(keys)-1)
			for _, k := range keys {
				if k == defaultKey {
					continue
				}
				themeColor := tok.Style.FG
				if themeColor == "" {
					themeColor = thms[k].DefaultForeground
				}
				styles[k] = ast.TokenStyle{
					Color:     themeColor,
					BgColor:   tok.Style.BG,
					FontStyle: tok.Style.FontStyle,
				}
			}
			row[j] = ast.ThemedToken{
				Content:     tok.Content,
				Color:       color,
				BgColor:     tok.Style.BG,
				FontStyle:   tok.Style.FontStyle,
				ThemeStyles: styles,
			}
		}
		themed[i] = row
	}
	return &ast.TokensResult{
		Tokens:    themed,
		FG:        defaultThm.DefaultForeground,
		BG:        defaultThm.DefaultBackground,
		ThemeName: defaultThm.Name,
	}
}

func (h *Highlighter) plaintextFallback(code string, thm *theme.Theme) *ast.TokensResult {
	raw := splitLines([]byte(code))
	themed := make([][]ast.ThemedToken, len(raw))
	for i, line := range raw {
		text := string(line)
		if text == "" && i == len(raw)-1 {
			continue
		}
		themed[i] = []ast.ThemedToken{{
			Content:   text,
			Color:     thm.DefaultForeground,
			FontStyle: theme.FontStyleNone,
		}}
	}
	return &ast.TokensResult{
		Tokens:    themed,
		FG:        thm.DefaultForeground,
		BG:        thm.DefaultBackground,
		ThemeName: thm.Name,
		Diagnostics: []ast.Diagnostic{{
			Line: 0,
			Kind: "unknown_lang",
		}},
	}
}

// plaintextFallbackMulti wraps plaintextFallback for multi-theme mode: every
// plaintext token carries a theme's default foreground, so each non-default
// theme's style is uniform.
func (h *Highlighter) plaintextFallbackMulti(
	code string,
	thms map[string]*theme.Theme,
	keys []string,
	defaultKey string,
) *ast.TokensResult {
	result := h.plaintextFallback(code, thms[defaultKey])
	for i, line := range result.Tokens {
		for j := range line {
			styles := make(map[string]ast.TokenStyle, len(keys)-1)
			for _, k := range keys {
				if k == defaultKey {
					continue
				}
				styles[k] = ast.TokenStyle{
					Color:     thms[k].DefaultForeground,
					FontStyle: theme.FontStyleNone,
				}
			}
			result.Tokens[i][j].ThemeStyles = styles
		}
	}
	return result
}

// LoadLanguage registers a grammar from raw JSON bytes.
func (h *Highlighter) LoadLanguage(name string, data []byte) error {
	return h.reg.RegisterGrammar(name, data)
}

// LoadTheme registers a theme from raw JSON bytes.
func (h *Highlighter) LoadTheme(name string, data []byte) error {
	return h.reg.RegisterTheme(name, data)
}

// RegisterAlias maps a language alias to a canonical name.
func (h *Highlighter) RegisterAlias(alias, target string) {
	h.reg.RegisterAlias(alias, target)
}

// LoadedLanguages returns the names of all currently cached grammars.
func (h *Highlighter) LoadedLanguages() []string {
	return h.reg.LoadedLanguages()
}

// LoadedThemes returns the names of all currently cached themes.
func (h *Highlighter) LoadedThemes() []string {
	return h.reg.LoadedThemes()
}

// splitLines splits code into bare lines with terminators stripped: the
// trailing \n and a directly preceding \r are excluded, mirroring the
// tokenizer's line convention. Lines are views into code, zero copies;
// callers never mutate line bytes.
func splitLines(code []byte) [][]byte {
	n := bytes.Count(code, []byte{'\n'})
	if len(code) > 0 && code[len(code)-1] != '\n' {
		n++
	}
	lines := make([][]byte, 0, n)
	start := 0
	for i, b := range code {
		if b == '\n' {
			end := i
			if end > start && code[end-1] == '\r' {
				end--
			}
			lines = append(lines, code[start:end])
			start = i + 1
		}
	}
	if start < len(code) {
		lines = append(lines, code[start:])
	}
	return lines
}
