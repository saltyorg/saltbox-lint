package lint

import "strings"

// EffectiveScalar returns a scalar's kind and lexical value after explicit core
// YAML type tags. It leaves Node's original kind, style, tag and spans intact.
// Boolean spellings are normalized for literal-true policy checks; numeric tags
// identify scalar type without evaluating numbers. Unknown tags, aliases and
// collections have no effective scalar kind. !unsafe preserves its scalar kind.
func EffectiveScalar(n *Node) (kind, value string) {
	if n == nil {
		return "", ""
	}
	switch n.Kind {
	case "string", "bool", "number", "null":
	default:
		return "", ""
	}
	kind, value = n.Kind, n.Value
	tag := n.Tag
	if strings.HasPrefix(tag, "!<tag:yaml.org,2002:") && strings.HasSuffix(tag, ">") {
		tag = "!!" + strings.TrimSuffix(strings.TrimPrefix(tag, "!<tag:yaml.org,2002:"), ">")
	}
	switch tag {
	case "", "!unsafe":
	case "!!str":
		kind = "string"
	case "!!bool":
		kind = "bool"
	case "!!int", "!!float":
		kind = "number"
	case "!!null":
		kind = "null"
	default:
		return "", ""
	}
	if kind == "bool" {
		switch strings.ToLower(value) {
		case "true", "yes", "on":
			value = "true"
		case "false", "no", "off":
			value = "false"
		default:
			return "", ""
		}
	}
	return kind, value
}
