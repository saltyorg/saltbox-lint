package grammar

// Grammar is the parsed representation of a TextMate grammar JSON file.
type Grammar struct {
	ScopeName         string
	Name              string
	Patterns          []Rule
	Repository        map[string]Rule
	Injections        []Injection
	InjectTo          []string  // target scopes this grammar injects into
	InjectionSelector *Selector // parsed selector for cross-grammar injection
}

// Injection pairs an injection selector with the rule to inject.
type Injection struct {
	RawSelector string
	Selector    *Selector
	Rule        Rule
}
