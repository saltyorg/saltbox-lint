package lint

import (
	"bytes"
	"context"
	"fmt"
	"io"

	"gopkg.in/yaml.v3"
)

// ParseIndependentYAML decodes every document with yaml.v3, which defines
// semantic acceptance independently of the patched source parser. Canonical
// formatting and automatic fixes share this decoder and its key policy.
func ParseIndependentYAML(ctx context.Context, data []byte) ([]*yaml.Node, error) {
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
		if err = validateIndependentKeys(ctx, &n); err != nil {
			return nil, err
		}
		docs = append(docs, &n)
	}
}

func validateIndependentKeys(ctx context.Context, n *yaml.Node) error {
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
		if err := validateIndependentKeys(ctx, child); err != nil {
			return err
		}
	}
	return nil
}

// independentlyEquivalent requires yaml.v3 to accept the original and to read
// the same typed tree after a fix. Only live Jinja whitespace may differ in
// unauthorized string scalars; structural value and list replacements must
// match their proposals exactly. Representation styles and comments are not
// semantic and remain owned by the source verifier.
func independentlyEquivalent(before *Source, after []byte, changes map[*Node]structuralFix) bool {
	ctx := context.Background()
	a, err := ParseIndependentYAML(ctx, before.Data)
	if err != nil {
		return false
	}
	b, err := ParseIndependentYAML(ctx, after)
	if err != nil || len(a) != len(b) {
		return false
	}
	authorized := map[[2]int]structuralFix{}
	for n, fix := range changes {
		if n == nil || fix.sequenceStyle != "" {
			continue
		}
		position := before.Position(n.Span.Start)
		authorized[[2]int{position.Line, position.Column}] = fix
	}
	for i := range a {
		if !independentNodesEqual(a[i], b[i], authorized) {
			return false
		}
	}
	return true
}

func independentNodesEqual(a, b *yaml.Node, authorized map[[2]int]structuralFix) bool {
	if a == nil || b == nil {
		return a == b
	}
	if fix, ok := authorized[[2]int{a.Line, a.Column}]; ok && a.Kind == yaml.ScalarNode {
		if a.Tag != "!!str" || a.Anchor != "" || scalarSignature(a.Value) != scalarSignature(fix.node.Value) {
			return false
		}
		if fix.items != nil {
			if b.Kind != yaml.SequenceNode || b.Tag != "!!seq" || b.Anchor != "" || len(b.Content) != len(fix.items) {
				return false
			}
			for i, item := range b.Content {
				if item.Kind != yaml.ScalarNode || item.Tag != "!!str" || item.Anchor != "" || item.Value != fix.items[i] {
					return false
				}
			}
			return true
		}
		return b.Kind == yaml.ScalarNode && b.Tag == a.Tag && b.Anchor == "" && scalarSignature(b.Value) == scalarSignature(fix.value)
	}
	if a.Kind != b.Kind || a.Tag != b.Tag || a.Anchor != b.Anchor || len(a.Content) != len(b.Content) {
		return false
	}
	if (a.Alias == nil) != (b.Alias == nil) || a.Alias != nil && a.Alias.Anchor != b.Alias.Anchor {
		return false
	}
	if a.Kind == yaml.ScalarNode || a.Kind == yaml.AliasNode {
		if a.Tag == "!!str" {
			if scalarSignature(a.Value) != scalarSignature(b.Value) {
				return false
			}
		} else if a.Value != b.Value {
			return false
		}
	}
	for i := range a.Content {
		if !independentNodesEqual(a.Content[i], b.Content[i], authorized) {
			return false
		}
	}
	return true
}
