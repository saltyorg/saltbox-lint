// Package semantics classifies Ansible YAML mapping keys for semantic highlighting.
package semantics

import (
	"github.com/saltyorg/saltbox-lint/highlight/catalog"
	"github.com/saltyorg/saltbox-lint/yamlindex"
)

type TokenType string

const (
	Method   TokenType = "method"
	Class    TokenType = "class"
	Keyword  TokenType = "keyword"
	Property TokenType = "property"
)

type Modifier string

const Definition Modifier = "definition"

type Token struct {
	Start     int
	End       int
	Type      TokenType
	Modifiers []Modifier
}

// Options supplies the frozen module catalog and document metadata collections.
type Options struct {
	Catalog     *catalog.Catalog
	Collections []string
	// SourceIndex optionally reuses validation lexing; mismatched source bytes are ignored.
	SourceIndex *yamlindex.Index
}

// Classify returns semantic tokens with half-open byte ranges in source.
func Classify(source string, options Options) ([]Token, error) {
	return classify(source, options)
}
