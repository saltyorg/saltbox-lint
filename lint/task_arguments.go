package lint

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// scalarActionArguments projects Ansible's legacy k=v syntax without changing
// the original YAML tree or consuming FreeForm. The installed Ansible splitter
// treats spaces/newlines, quotes and all three Jinja delimiters specially; this
// is deliberately not shell syntax. Unbalanced tails have no reliable arguments.
func scalarActionArguments(s *Source, n *Node, start int, module string) map[string]*Node {
	if n == nil || n.Kind != "string" || start < 0 || start > len(n.Value) {
		return nil
	}
	positions, ok := scalarPositions(s, n)
	if !ok {
		return nil
	}
	tokens, ok := actionArgumentTokens(n.Value[start:])
	if !ok {
		return nil
	}
	arguments := make(map[string]*Node)
	for _, token := range tokens {
		token.Start += start
		token.End += start
		decoded, mapped, ok := decodeActionToken(n.Value[token.Start:token.End], positions[token.Start:token.End])
		if !ok {
			// An unsupported escape may affect the key or separator too. No
			// lower-priority value can reliably stand in for this unknown token.
			return nil
		}
		equal := -1
		for i := 1; i < len(decoded); i++ {
			if decoded[i] == '=' && decoded[i-1] != '\\' {
				equal = i
				break
			}
		}
		if equal <= 0 {
			continue
		}
		key := strings.TrimSpace(decoded[:equal])
		// A literal payload or template containing '=' is not a named argument.
		if !actionArgumentKey(key) || !actionAcceptsArgument(module, decoded[:equal]) {
			continue
		}
		value := strings.TrimLeftFunc(decoded[equal+1:], unicode.IsSpace)
		valueStart := len(decoded) - len(value)
		value = strings.TrimRightFunc(value, unicode.IsSpace)
		valueEnd := valueStart + len(value)
		span := mapSpan(mapped, Span{valueStart, valueEnd})
		if valueStart == valueEnd {
			span = Span{mapped[valueStart-1].End, mapped[valueStart-1].End}
		}
		mapped = mapped[valueStart:valueEnd]
		if len(value) > 1 && (value[0] == '\'' || value[0] == '"') && value[len(value)-1] == value[0] && value[len(value)-2] != '\\' {
			value = value[1 : len(value)-1]
			mapped = mapped[1 : len(mapped)-1]
		}
		arguments[key] = &Node{Kind: "string", Value: value, Style: "plain", Tag: n.Tag, Span: span, scalarOrigin: n, scalarMap: mapped}
	}
	return arguments
}

func actionArgumentKey(key string) bool {
	for _, c := range key {
		if c != '_' && (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') {
			return false
		}
	}
	return key != ""
}

func actionAcceptsArgument(module, key string) bool {
	switch module {
	case "command", "shell", "raw", "script", "win_command", "win_shell", "ansible.windows.win_command", "ansible.windows.win_shell":
		switch key {
		case "creates", "removes", "chdir", "executable", "warn", "stdin", "stdin_add_newline", "strip_empty_ends":
			return true
		}
		return false
	}
	return true
}

func mergeActionArguments(arguments map[string]*Node, nested *Node, source *Source) map[string]*Node {
	if arguments == nil {
		arguments = make(map[string]*Node)
	}
	switch nested.Kind {
	case "string":
		projected := scalarActionArguments(source, nested, 0, "")
		if projected == nil {
			return nil
		}
		for key, value := range projected {
			arguments[key] = value
		}
	case "mapping":
		for _, entry := range nested.Entries {
			arguments[entry.Key.Value] = entry.Value
		}
	}
	return arguments
}

func actionArgumentTokens(text string) ([]Span, bool) {
	var tokens []Span
	var quote byte
	var depths [3]int
	start := -1
	for i := 0; i < len(text); i++ {
		c := text[i]
		if (c == ' ' || c == '\n') && quote == 0 && depths == [3]int{} {
			if start >= 0 {
				tokens = append(tokens, Span{start, i})
				start = -1
			}
			continue
		}
		if start < 0 {
			start = i
		}
		if (c == '\'' || c == '"') && (i == 0 || text[i-1] != '\\') {
			switch quote {
			case 0:
				quote = c
			case c:
				quote = 0
			}
		}
		if i+1 < len(text) {
			pair := text[i : i+2]
			for kind, delimiters := range [][2]string{{"{{", "}}"}, {"{%", "%}"}, {"{#", "#}"}} {
				if pair == delimiters[0] {
					depths[kind]++
					i++
					break
				}
				if pair == delimiters[1] {
					depths[kind] = max(0, depths[kind]-1)
					i++
					break
				}
			}
		}
	}
	if quote != 0 || depths != [3]int{} || strings.HasSuffix(text, "\\") {
		return nil, false
	}
	if start >= 0 {
		tokens = append(tokens, Span{start, len(text)})
	}
	return tokens, true
}

// Ansible decodes recognized Python escapes across each complete token before
// finding the separator, trimming, and removing one matching pair of quotes.
// Keep every decoded byte mapped to its complete original escape.
// Named Unicode escapes are declined rather than guessed or shell-decoded.
func decodeActionToken(raw string, positions []Span) (string, []Span, bool) {
	var decoded strings.Builder
	var mapped []Span
	for i := 0; i < len(raw); {
		end := i + 1
		value := raw[i:end]
		if raw[i] == '\\' && end < len(raw) {
			c := raw[end]
			escapes := map[byte]string{'\\': "\\", '\'': "'", '"': "\"", 'a': "\a", 'b': "\b", 'f': "\f", 'n': "\n", 'r': "\r", 't': "\t", 'v': "\v"}
			if replacement, found := escapes[c]; found {
				end++
				value = replacement
			} else if c == 'x' || c == 'u' || c == 'U' {
				count := 2
				switch c {
				case 'u':
					count = 4
				case 'U':
					count = 8
				}
				end += count + 1
				if end > len(raw) {
					return "", nil, false
				}
				code, err := strconv.ParseUint(raw[i+2:end], 16, 32)
				if err != nil || !utf8.ValidRune(rune(code)) {
					return "", nil, false
				}
				value = string(rune(code))
			} else if c == 'N' {
				return "", nil, false
			}
		}
		decoded.WriteString(value)
		span := mapSpan(positions, Span{i, end})
		for range len(value) {
			mapped = append(mapped, span)
		}
		i = end
	}
	return decoded.String(), mapped, true
}

// Membership and source occurrence order come from the original scalar's
// index, including unsafe-ancestor exclusion. Re-scan only this argument's
// decoded value, so sibling arguments and action escapes cannot alter its reads.
func projectedArgumentExpressions(node *Node, orders []int) []indexedExpression {
	if node.Tag == "!unsafe" || len(node.scalarMap) != len(node.Value) || len(orders) == 0 {
		return nil
	}
	var result []indexedExpression
	for within, expression := range scalarExpressions(nil, node) {
		for _, order := range orders {
			result = append(result, indexedExpression{order: order, within: within, expression: expression})
		}
	}
	return result
}
