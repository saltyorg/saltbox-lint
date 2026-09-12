package nuri

import (
	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/internal/registry"
)

var (
	ErrLanguageNotFound = registry.ErrLanguageNotFound
	ErrThemeNotFound    = registry.ErrThemeNotFound
	ErrGrammarCycle     = grammar.ErrGrammarCycle
	ErrGrammarDepth     = grammar.ErrGrammarDepth
)
