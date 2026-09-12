package format

import (
	"context"
	"fmt"
	"slices"
	"sort"

	"github.com/saltyorg/saltbox-lint/lint"
)

// Each sibling set stores source starts and prefix-maximum ends. A lookup finds
// the first containing child with two binary searches instead of revisiting all
// preceding siblings. Paths are allocated once and remain stable across edits.
type ownerIndex struct {
	span        lint.Span
	path        string
	children    []*ownerIndex
	maximumEnds []int
}

func newOwnerIndex(ctx context.Context, source *lint.Source) (*ownerIndex, error) {
	root := &ownerIndex{span: lint.Span{End: len(source.Data)}, path: "document"}
	for i, n := range source.Documents {
		child, err := indexOwnerNode(ctx, n, fmt.Sprintf("d%d", i))
		if err != nil {
			return nil, err
		}
		root.children = append(root.children, child)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	root.indexChildren()
	return root, nil
}

func indexOwnerNode(ctx context.Context, n *lint.Node, path string) (*ownerIndex, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	current := &ownerIndex{span: n.Span, path: path}
	for i, e := range n.Entries {
		key, err := indexOwnerNode(ctx, e.Key, fmt.Sprintf("%s/k%d", path, i))
		if err != nil {
			return nil, err
		}
		value, err := indexOwnerNode(ctx, e.Value, fmt.Sprintf("%s/v%d", path, i))
		if err != nil {
			return nil, err
		}
		current.children = append(current.children, key, value)
	}
	for i, n := range n.Items {
		child, err := indexOwnerNode(ctx, n, fmt.Sprintf("%s/i%d", path, i))
		if err != nil {
			return nil, err
		}
		current.children = append(current.children, child)
	}
	current.indexChildren()
	return current, nil
}

func (index *ownerIndex) indexChildren() {
	slices.SortStableFunc(index.children, func(a, b *ownerIndex) int { return a.span.Start - b.span.Start })
	end := 0
	for _, child := range index.children {
		end = max(end, child.span.End)
		index.maximumEnds = append(index.maximumEnds, end)
	}
}

func (index *ownerIndex) owner(ctx context.Context, span lint.Span) (string, error) {
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		limit := sort.Search(len(index.children), func(i int) bool { return index.children[i].span.Start > span.Start })
		child := sort.Search(limit, func(i int) bool { return index.maximumEnds[i] >= span.End })
		if child == limit {
			return index.path, nil
		}
		index = index.children[child]
	}
}
