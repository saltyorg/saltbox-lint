package lint

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"net"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Validate the HTTP rule language from Traefik v3.7.0 pkg/rules/parser.go and
// pkg/muxer/http/matcher.go. Like vulcand/predicate v1.3.0, use Go's expression
// parser, then restrict the AST to supported operators, calls and literals.
// This checks configuration validity, not whether a rule matches a request.
func validateTraefikEndpoint(value string) error {
	expr, err := parser.ParseExpr(value)
	if err != nil {
		return fmt.Errorf("invalid rule syntax: %w", err)
	}
	return validateTraefikRuleExpr(expr)
}

func validateTraefikRuleExpr(expr ast.Expr) error {
	switch expr := expr.(type) {
	case *ast.ParenExpr:
		return validateTraefikRuleExpr(expr.X)
	case *ast.UnaryExpr:
		if expr.Op != token.NOT {
			return fmt.Errorf("unsupported rule operator %s", expr.Op)
		}
		return validateTraefikRuleExpr(expr.X)
	case *ast.BinaryExpr:
		if expr.Op != token.LAND && expr.Op != token.LOR {
			return fmt.Errorf("unsupported rule operator %s", expr.Op)
		}
		if err := validateTraefikRuleExpr(expr.X); err != nil {
			return err
		}
		return validateTraefikRuleExpr(expr.Y)
	case *ast.CallExpr:
		return validateTraefikMatcher(expr)
	default:
		return fmt.Errorf("expected a Traefik HTTP matcher call")
	}
}

func validateTraefikMatcher(call *ast.CallExpr) error {
	ident, ok := call.Fun.(*ast.Ident)
	if !ok {
		return fmt.Errorf("expected a Traefik HTTP matcher name")
	}
	name := ""
	for _, canonical := range []string{"ClientIP", "Method", "Host", "HostRegexp", "Path", "PathRegexp", "PathPrefix", "Header", "HeaderRegexp", "Query", "QueryRegexp"} {
		lower := strings.ToLower(canonical)
		if ident.Name == canonical || ident.Name == lower || ident.Name == strings.ToUpper(canonical) || ident.Name == canonical[:1]+lower[1:] {
			name = canonical
			break
		}
	}
	if name == "" {
		return fmt.Errorf("unsupported Traefik HTTP matcher %s", ident.Name)
	}
	minArgs, maxArgs := 1, 1
	switch name {
	case "Header", "HeaderRegexp":
		minArgs, maxArgs = 2, 2
	case "Query", "QueryRegexp":
		maxArgs = 2
	}
	if len(call.Args) < minArgs || len(call.Args) > maxArgs {
		return fmt.Errorf("%s requires %d to %d nonempty string arguments", name, minArgs, maxArgs)
	}
	args := make([]string, len(call.Args))
	for i, arg := range call.Args {
		literal, ok := arg.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return fmt.Errorf("%s arguments must be backtick or double-quoted string literals", name)
		}
		value, err := strconv.Unquote(literal.Value)
		if err != nil {
			return fmt.Errorf("invalid %s string argument: %w", name, err)
		}
		if value == "" {
			return fmt.Errorf("%s arguments must not be empty", name)
		}
		args[i] = value
	}
	return validateTraefikMatcherArgs(name, args)
}

func validateTraefikMatcherArgs(name string, args []string) error {
	switch name {
	case "Path", "PathPrefix":
		if !strings.HasPrefix(args[0], "/") {
			return fmt.Errorf("%s argument must start with /", name)
		}
	case "Host", "HostRegexp":
		for _, b := range []byte(args[0]) {
			if b >= 128 {
				return fmt.Errorf("%s argument must contain only ASCII characters", name)
			}
		}
	case "ClientIP":
		if net.ParseIP(args[0]) == nil {
			if _, _, err := net.ParseCIDR(args[0]); err != nil {
				return fmt.Errorf("ClientIP requires an IP address or CIDR: %w", err)
			}
		}
	}
	regexArg := -1
	switch name {
	case "HostRegexp", "PathRegexp":
		regexArg = 0
	case "HeaderRegexp":
		regexArg = 1
	case "QueryRegexp":
		if len(args) == 2 {
			regexArg = 1
		}
	}
	if regexArg >= 0 {
		if _, err := regexp.Compile(args[regexArg]); err != nil {
			return fmt.Errorf("invalid %s regular expression: %w", name, err)
		}
	}
	return nil
}

func checkTraefikEndpointDefaults(s *Source) []Diagnostic {
	var ds []Diagnostic
	prefix := s.Role + "_role_"
	for _, declaration := range topLevelDeclarations(s) {
		name := strings.TrimPrefix(declaration.Name, prefix)
		if name == declaration.Name || (name != "traefik_api_endpoint" && !strings.HasSuffix(name, "_traefik_api_endpoint")) {
			continue
		}
		value := declaration.Value
		kind, text := EffectiveScalar(value)
		// Aliases and unknown tags cannot establish a static type/value. Collections
		// and known non-string scalar types, however, cannot be rule strings.
		if value == nil || value.Kind == "alias" || (kind == "" && value.Kind != "mapping" && value.Kind != "sequence") {
			continue
		}
		var err error
		if kind != "string" {
			err = fmt.Errorf("endpoint must be a string")
		} else {
			if value.Tag != "!unsafe" {
				var static bool
				text, static = traefikEndpointLiteral(text)
				if !static {
					continue
				}
			}
			if text == "" {
				continue
			}
			err = validateTraefikEndpoint(text)
		}
		if err != nil {
			ds = append(ds, ansibleDiagnostic(s, "traefik-api-contract", value.Span,
				"invalid Traefik API endpoint: "+err.Error(),
				"Use an empty string or a Traefik v3 HTTP rule such as PathPrefix(`/api`); a bare /api path is not a rule."))
		}
	}
	return ds
}

// traefikEndpointLiteral applies only Jinja comment elision. Like scanExpressions,
// it recognizes template delimiters before interpreting their contents, so text
// inside comments cannot introduce output or statements. Unlike Expressions it
// retains the distinction between literal text and raw statement wrappers, which
// this rule defers along with every other template statement/output. It never
// rescans elided text or evaluates an expression.
func traefikEndpointLiteral(text string) (string, bool) {
	var literal []byte
	for {
		start := strings.IndexByte(text, '{')
		if start < 0 {
			return string(append(literal, text...)), true
		}
		segmentStart := len(literal)
		literal = append(literal, text[:start]...)
		text = text[start:]
		if strings.HasPrefix(text, "{{") || strings.HasPrefix(text, "{%") {
			return "", false
		}
		if !strings.HasPrefix(text, "{#") {
			literal = append(literal, '{')
			text = text[1:]
			continue
		}
		end := strings.Index(text[2:], "#}")
		if end < 0 {
			return "", false // An incomplete template is not a known literal.
		}
		end += 2
		if strings.HasPrefix(text, "{#-") {
			// Jinja trims only the immediately preceding literal segment,
			// never whitespace across an earlier comment delimiter.
			segment := bytes.TrimRightFunc(literal[segmentStart:], unicode.IsSpace)
			literal = literal[:segmentStart+len(segment)]
		}
		trimRight := text[end-1] == '-'
		text = text[end+2:]
		if trimRight {
			text = strings.TrimLeftFunc(text, unicode.IsSpace)
		}
	}
}
