package lint

import "strings"

// whenNodes restricts the shared runtime expressions to the structural owners
// of when. Payload mappings and the other implicit condition fields stay out.
func whenNodes(s *Source) map[*Node]bool {
	nodes := map[*Node]bool{}
	var add func(*Node)
	add = func(n *Node) {
		if n == nil || n.Tag == "!unsafe" {
			return
		}
		if n.Kind == "sequence" {
			for _, item := range n.Items {
				add(item)
			}
			return
		}
		kind, _ := EffectiveScalar(n)
		if kind == "string" || kind == "bool" {
			nodes[n] = true
		}
	}
	for _, task := range TasksIn(s) {
		add(task.Node.Get("when"))
		if task.Module == "include_tasks" || task.Module == "include_role" {
			add(task.argument("apply").Get("when"))
		}
	}
	if s.Kind == Playbook {
		for _, doc := range s.Documents {
			for _, play := range doc.Items {
				add(play.Get("when"))
				if roles := play.Get("roles"); roles != nil {
					for _, role := range roles.Items {
						add(role.Get("when"))
					}
				}
			}
		}
	}
	return nodes
}

func checkWhenParentheses(_ *Project, s *Source) []Diagnostic {
	nodes := whenNodes(s)
	var ds []Diagnostic
	for n := range nodes {
		if kind, value := EffectiveScalar(n); kind == "bool" {
			ds = append(ds, ansibleDiagnostic(s, "ansible-when-parentheses", scalarTextSpan(s, n, 0, len(n.Value)), "literal when condition needs enclosing parentheses", "Use ("+value+") around the complete when condition."))
		}
	}
	for _, e := range RuntimeExpressions(s) {
		kind, _ := EffectiveScalar(e.node)
		if e.Kind != "implicit" || !e.Complete || !nodes[e.node] || kind != "string" || len(e.Tokens) == 0 {
			continue
		}
		if len(rootConjunction(e.Tokens)) > 0 || whenConditionGroupedOrRead(e) {
			continue
		}
		span := Span{e.Tokens[0].Span.Start, e.Tokens[len(e.Tokens)-1].Span.End}
		ds = append(ds, ansibleDiagnostic(s, "ansible-when-parentheses", span, "nontrivial when condition needs enclosing parentheses", "Use ("+strings.TrimSpace(e.text)+") around the complete when condition."))
	}
	return ds
}

func whenConditionGroupedOrRead(e Expression) bool {
	return len(stripGrouping(e.Tokens)) != len(e.Tokens) || directVariableReference(e.Tokens) || standaloneWhenLookup(e)
}

// A standalone lookup result is one value read regardless of its arguments.
// Use actual call spans so a surrounding operation cannot inherit this exemption.
func standaloneWhenLookup(e Expression) bool {
	if !e.Complete || len(e.Tokens) == 0 {
		return false
	}
	name := e.Tokens[0].Text
	switch name {
	case "lookup", "query", "q":
	default:
		return false
	}
	span := Span{e.Tokens[0].Span.Start, e.Tokens[len(e.Tokens)-1].Span.End}
	for _, call := range Calls(e, name) {
		if call.Span == span {
			return true
		}
	}
	return false
}

// Direct field/item access is still a variable reference. Keys can themselves
// be references or literals; calls, operators, slices and computed keys are not.
func directVariableReference(tokens []Token) bool {
	if len(tokens) == 0 || tokens[0].Kind != "name" || jinjaReadKeyword(tokens[0].Text) {
		return false
	}
	for i := 1; i < len(tokens); {
		switch tokens[i].Text {
		case ".":
			if i+1 >= len(tokens) || (tokens[i+1].Kind != "name" && tokens[i+1].Kind != "number") {
				return false
			}
			i += 2
		case "[":
			end := balancedEnd(tokens, i, len(tokens))
			if end < 0 {
				return false
			}
			key := tokens[i+1 : end]
			literal := len(key) == 1 && (key[0].Kind == "string" || key[0].Kind == "number")
			if len(key) == 1 && key[0].Kind == "name" {
				switch key[0].Text {
				case "true", "false", "none", "True", "False", "None":
					literal = true
				}
			}
			if !literal && !directVariableReference(key) {
				return false
			}
			i = end + 1
		default:
			return false
		}
	}
	return true
}

func checkConditionalResultParentheses(_ *Project, s *Source) []Diagnostic {
	var ds []Diagnostic
	for _, e := range Expressions(s) {
		if e.Kind != "output" || !e.Complete {
			continue
		}
		tokens := stripGrouping(e.Tokens)
		if len(tokens) == len(e.Tokens) {
			continue
		}
		// A parenthesized comma-separated value is a tuple, even if its first item
		// is a conditional. Its enclosing pair is not a conditional result wrapper.
		if conditionalResultTuple(tokens) {
			continue
		}
		syntax := inspectRegion(tokens, 0, len(tokens))
		if syntax.If <= 0 || syntax.Else <= syntax.If+1 || syntax.Else >= len(tokens)-1 {
			continue
		}
		expected := e.text
		for range (len(e.Tokens) - len(tokens)) / 2 {
			opening, closing := strings.Index(expected, "("), strings.LastIndex(expected, ")")
			expected = expected[:opening] + expected[opening+1:closing] + expected[closing+1:]
		}
		ds = append(ds, ansibleDiagnostic(s, "jinja-redundant-conditional-parentheses", e.Tokens[0].Span, "standalone conditional result has unnecessary enclosing parentheses", "Use "+expected+"; preserve condition and branch grouping."))
	}
	return ds
}

func conditionalResultTuple(tokens []Token) bool {
	for i := 0; i < len(tokens); i++ {
		switch tokens[i].Text {
		case ",":
			return true
		case "(", "[", "{":
			end := balancedEnd(tokens, i, len(tokens))
			if end < 0 {
				return true
			}
			i = end
		}
	}
	return false
}
