package ast

import (
	"io"
	"slices"
	"strings"
)

// Node is an HTML node that can serialize itself.
type Node interface {
	WriteTo(w io.Writer) (int64, error)
}

// Element is an HTML element with tag, classes, styles, attributes, and children.
type Element struct {
	Tag      string
	Classes  []string
	Styles   map[string]string
	Attrs    map[string]string
	Children []Node
}

// Text is a text node. Content is HTML-escaped on write.
type Text struct {
	Content string
}

// AddClass appends a CSS class if not already present.
func (e *Element) AddClass(class string) {
	for _, c := range e.Classes {
		if c == class {
			return
		}
	}
	e.Classes = append(e.Classes, class)
}

// SetAttr sets an HTML attribute on the element.
func (e *Element) SetAttr(key, val string) {
	if e.Attrs == nil {
		e.Attrs = make(map[string]string)
	}
	e.Attrs[key] = val
}

func (e *Element) WriteTo(w io.Writer) (int64, error) {
	cw := &countWriter{w: w}

	cw.writeString("<")
	cw.writeString(e.Tag)

	if len(e.Classes) > 0 {
		cw.writeString(` class="`)
		cw.writeString(escapeAttr(strings.Join(e.Classes, " ")))
		cw.writeString(`"`)
	}

	if len(e.Styles) > 0 {
		keys := make([]string, 0, len(e.Styles))
		for k := range e.Styles {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		cw.writeString(` style="`)
		for i, k := range keys {
			if i > 0 {
				cw.writeString(";")
			}
			cw.writeString(k)
			cw.writeString(":")
			cw.writeString(escapeAttr(e.Styles[k]))
		}
		cw.writeString(`"`)
	}

	if len(e.Attrs) > 0 {
		keys := make([]string, 0, len(e.Attrs))
		for k := range e.Attrs {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			cw.writeString(" ")
			cw.writeString(k)
			cw.writeString(`="`)
			cw.writeString(escapeAttr(e.Attrs[k]))
			cw.writeString(`"`)
		}
	}

	cw.writeString(">")

	for _, child := range e.Children {
		if cw.err != nil {
			break
		}
		cn, cerr := child.WriteTo(cw.w)
		cw.n += cn
		if cerr != nil {
			cw.err = cerr
		}
	}

	cw.writeString("</")
	cw.writeString(e.Tag)
	cw.writeString(">")

	return cw.n, cw.err
}

func (t *Text) WriteTo(w io.Writer) (int64, error) {
	cw := &countWriter{w: w}
	cw.writeString(escapeText(t.Content))
	return cw.n, cw.err
}

type countWriter struct {
	w   io.Writer
	n   int64
	err error
}

func (cw *countWriter) writeString(s string) {
	if cw.err != nil {
		return
	}
	n, err := io.WriteString(cw.w, s)
	cw.n += int64(n)
	cw.err = err
}

var textReplacer = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
var attrReplacer = strings.NewReplacer("&", "&amp;", `"`, "&quot;")

func escapeText(s string) string { return textReplacer.Replace(s) }
func escapeAttr(s string) string { return attrReplacer.Replace(s) }
