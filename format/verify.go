package format

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/goccy/go-yaml/lexer"
	"github.com/goccy/go-yaml/token"
	"github.com/saltyorg/saltbox-lint/lint"
	"gopkg.in/yaml.v3"
)

func parseIndependent(ctx context.Context, data []byte) ([]*yaml.Node, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	var docs []*yaml.Node
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var n yaml.Node
		err := decoder.Decode(&n)
		if err == io.EOF {
			return docs, nil
		}
		if err != nil {
			return nil, fmt.Errorf("independent YAML parser: %w", err)
		}
		if err = validateKeys(ctx, &n); err != nil {
			return nil, err
		}
		docs = append(docs, &n)
	}
}

func validateKeys(ctx context.Context, n *yaml.Node) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if n.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i < len(n.Content); i += 2 {
			k := n.Content[i]
			if k.Kind != yaml.ScalarNode {
				return fmt.Errorf("complex mapping keys are unsupported")
			}
			key := k.Tag + "\x00" + k.Value
			if seen[key] {
				return fmt.Errorf("duplicate mapping keys are unsupported")
			}
			seen[key] = true
		}
	}
	for _, child := range n.Content {
		if err := validateKeys(ctx, child); err != nil {
			return err
		}
	}
	return nil
}

func verify(ctx context.Context, before, after *lint.Source, jinja bool) error {
	if bytes.HasSuffix(before.Data, []byte("\n")) != bytes.HasSuffix(after.Data, []byte("\n")) {
		return fmt.Errorf("final newline state changed")
	}
	if jinja {
		allowed, err := lint.FormattingEdits(before)
		if err != nil {
			return err
		}
		if !bytes.Equal(applyEdits(before.Data, allowed), after.Data) {
			return fmt.Errorf("candidate differs from verified Jinja and section corrections")
		}
	}

	if !slices.Equal(documentSyntax(before.Data), documentSyntax(after.Data)) {
		return fmt.Errorf("document markers or directives changed")
	}
	a, err := parseIndependent(ctx, before.Data)
	if err != nil {
		return err
	}
	b, err := parseIndependent(ctx, after.Data)
	if err != nil {
		return err
	}
	if len(a) != len(b) || len(before.Documents) != len(after.Documents) {
		return fmt.Errorf("document structure changed")
	}
	comments := a
	if jinja {
		if sections := lint.FormattingSectionEdits(before); len(sections) > 0 {
			comments, err = parseIndependent(ctx, applyEdits(before.Data, sections))
			if err != nil {
				return err
			}
		}
	}
	for i := range a {
		if err := equivalentYAML(ctx, a[i], b[i], comments[i], jinja); err != nil {
			return err
		}
	}
	for i := range before.Documents {
		if err := equivalentSource(ctx, before.Documents[i], after.Documents[i], jinja); err != nil {
			return err
		}
	}
	if !jinja {
		return verifyScalarSyntax(ctx, before, after)
	}
	return nil
}

func valueEqual(a, b string, jinja bool) bool {
	return a == b || jinja && lint.FormattingScalarEqual(a, b)
}

func equivalentYAML(ctx context.Context, a, b, comments *yaml.Node, jinja bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.Kind != b.Kind || a.Tag != b.Tag || a.Anchor != b.Anchor || len(a.Content) != len(b.Content) {
		return fmt.Errorf("independent typed YAML structure changed")
	}
	if comments.HeadComment != b.HeadComment || comments.LineComment != b.LineComment || comments.FootComment != b.FootComment {
		return fmt.Errorf("YAML comment attachment changed")
	}
	if !valueEqual(a.Value, b.Value, jinja && a.Tag == "!!str") {
		return fmt.Errorf("independent scalar value changed")
	}
	protected := yaml.LiteralStyle | yaml.FoldedStyle | yaml.TaggedStyle
	if a.Style&protected != b.Style&protected {
		return fmt.Errorf("protected YAML style changed")
	}
	if a.Alias != nil || b.Alias != nil {
		if a.Alias == nil || b.Alias == nil || a.Alias.Anchor != b.Alias.Anchor {
			return fmt.Errorf("alias relationship changed")
		}
	}
	for i := range a.Content {
		if err := equivalentYAML(ctx, a.Content[i], b.Content[i], comments.Content[i], jinja); err != nil {
			return err
		}
	}
	return nil
}

func equivalentSource(ctx context.Context, a, b *lint.Node, jinja bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.Kind != b.Kind || a.Tag != b.Tag || a.Anchor != b.Anchor || len(a.Entries) != len(b.Entries) || len(a.Items) != len(b.Items) {
		return fmt.Errorf("source parser YAML structure changed")
	}
	if !valueEqual(a.Value, b.Value, jinja && a.Kind == "string" && a.Tag != "!unsafe") {
		return fmt.Errorf("source parser scalar value changed")
	}
	for i, e := range a.Entries {
		if err := equivalentSource(ctx, e.Key, b.Entries[i].Key, jinja); err != nil {
			return err
		}
		if err := equivalentSource(ctx, e.Value, b.Entries[i].Value, jinja); err != nil {
			return err
		}
	}
	for i, n := range a.Items {
		if err := equivalentSource(ctx, n, b.Items[i], jinja); err != nil {
			return err
		}
	}
	return nil
}

func verifyDiagnostics(ctx context.Context, before, after *lint.Source) error {
	old, err := lint.SourceLocalDiagnostics(ctx, before)
	if err != nil {
		return err
	}
	current, err := lint.SourceLocalDiagnostics(ctx, after)
	if err != nil {
		return err
	}
	type identity struct{ rule, message, owner string }
	counts := map[identity]int{}
	for _, d := range old {
		counts[identity{d.RuleID, d.Message, diagnosticOwner(before, d.Span)}]++
	}
	for _, d := range current {
		if d.RuleID == "jinja-layout" || d.RuleID == "section-spacing" {
			continue
		}
		key := identity{d.RuleID, d.Message, diagnosticOwner(after, d.Span)}
		if counts[key] == 0 {
			return fmt.Errorf("formatting introduces %s: %s", d.RuleID, d.Message)
		}
		counts[key]--
	}
	return nil
}

// Markers and directives are syntax-level contracts that YAML value trees omit.
func documentSyntax(data []byte) []string {
	var result []string
	for _, t := range lexer.Tokenize(string(data)) {
		switch t.Type {
		case token.DocumentHeaderType, token.DocumentEndType:
			result = append(result, t.Value)
		case token.DirectiveType:
			start := t.Position.Line - 1
			lines := strings.Split(string(data), "\n")
			if start >= 0 && start < len(lines) {
				result = append(result, strings.TrimSuffix(lines[start], "\r"))
			}
		}
	}
	return result
}

// Source positions move under formatting; syntax paths identify the same owner.
// A removed finding must never cancel a new finding on another scalar.
func diagnosticOwner(source *lint.Source, span lint.Span) string {
	var visit func(*lint.Node, string) string
	visit = func(n *lint.Node, path string) string {
		if n == nil || span.Start < n.Span.Start || span.End > n.Span.End {
			return ""
		}
		for i, e := range n.Entries {
			if owner := visit(e.Key, fmt.Sprintf("%s/k%d", path, i)); owner != "" {
				return owner
			}
			if owner := visit(e.Value, fmt.Sprintf("%s/v%d", path, i)); owner != "" {
				return owner
			}
		}
		for i, item := range n.Items {
			if owner := visit(item, fmt.Sprintf("%s/i%d", path, i)); owner != "" {
				return owner
			}
		}
		return path
	}
	for i, n := range source.Documents {
		if owner := visit(n, fmt.Sprintf("d%d", i)); owner != "" {
			return owner
		}
	}
	return "document"
}
