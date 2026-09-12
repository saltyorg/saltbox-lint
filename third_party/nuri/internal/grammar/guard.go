package grammar

import "errors"

var (
	ErrGrammarCycle = errors.New("nuri: cyclic grammar include")
	ErrGrammarDepth = errors.New("nuri: grammar include depth exceeded")
)
