package ast

// Transformer customizes the HTML rendering pipeline via lifecycle hooks.
// Embed BaseTransformer to get no-op defaults for all hooks.
type Transformer interface {
	Name() string
	Preprocess(code string, opts *CodeToHTMLOptions) string
	Tokens(tokens [][]ThemedToken) [][]ThemedToken
	Span(el *Element, line, col int, lineEl *Element, tok ThemedToken) *Element
	Line(el *Element, line int) *Element
	Code(el *Element) *Element
	Pre(el *Element) *Element
	Root(el *Element) *Element
	Postprocess(html string, opts *CodeToHTMLOptions) string
}

// BaseTransformer provides no-op defaults for all Transformer hooks.
// Embed it in custom transformers to only override the hooks you need.
type BaseTransformer struct{}

func (BaseTransformer) Name() string                                           { return "" }
func (BaseTransformer) Preprocess(code string, opts *CodeToHTMLOptions) string { return "" }
func (BaseTransformer) Tokens(tokens [][]ThemedToken) [][]ThemedToken          { return nil }
func (BaseTransformer) Span(el *Element, line, col int, lineEl *Element, tok ThemedToken) *Element {
	return nil
}
func (BaseTransformer) Line(el *Element, line int) *Element                     { return nil }
func (BaseTransformer) Code(el *Element) *Element                               { return nil }
func (BaseTransformer) Pre(el *Element) *Element                                { return nil }
func (BaseTransformer) Root(el *Element) *Element                               { return nil }
func (BaseTransformer) Postprocess(html string, opts *CodeToHTMLOptions) string { return "" }
