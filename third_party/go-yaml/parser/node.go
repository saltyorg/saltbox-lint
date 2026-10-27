package parser

import (
	"fmt"

	"github.com/goccy/go-yaml/ast"
	"github.com/goccy/go-yaml/internal/errors"
	"github.com/goccy/go-yaml/token"
)

func newMappingNode(ctx *context, tk *Token, isFlow bool, values ...*ast.MappingValueNode) (*ast.MappingNode, error) {
	node := ast.Mapping(tk.RawToken(), isFlow, values...)
	node.SetPathRef(ctx.path)
	return node, nil
}

func newMappingValueNode(ctx *context, colonTk, entryTk *Token, key ast.MapKeyNode, value ast.Node) (*ast.MappingValueNode, error) {
	node := ast.MappingValue(colonTk.RawToken(), key, value)
	node.SetPathRef(ctx.path)
	node.CollectEntry = entryTk.RawToken()
	if key.GetToken().Position.Line == value.GetToken().Position.Line {
		// originally key was commented, but now that null value has been added, value must be commented.
		if err := setLineComment(ctx, value, colonTk); err != nil {
			return nil, err
		}
		// set line comment by colonTk or entryTk.
		if err := setLineComment(ctx, value, entryTk); err != nil {
			return nil, err
		}
	} else {
		if err := setLineComment(ctx, key, colonTk); err != nil {
			return nil, err
		}
		// set line comment by colonTk or entryTk.
		if err := setLineComment(ctx, key, entryTk); err != nil {
			return nil, err
		}
	}
	return node, nil
}

func newMappingKeyNode(ctx *context, tk *Token) (*ast.MappingKeyNode, error) {
	node := ast.MappingKey(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newAnchorNode(ctx *context, tk *Token) (*ast.AnchorNode, error) {
	node := ast.Anchor(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newAliasNode(ctx *context, tk *Token) (*ast.AliasNode, error) {
	node := ast.Alias(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newDirectiveNode(ctx *context, tk *Token) (*ast.DirectiveNode, error) {
	node := ast.Directive(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newMergeKeyNode(ctx *context, tk *Token) (*ast.MergeKeyNode, error) {
	node := ast.MergeKey(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newNullNode(ctx *context, tk *Token) (*ast.NullNode, error) {
	node := ast.Null(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newBoolNode(ctx *context, tk *Token) (*ast.BoolNode, error) {
	node := ast.Bool(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newIntegerNode(ctx *context, tk *Token) (*ast.IntegerNode, error) {
	node := ast.Integer(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newFloatNode(ctx *context, tk *Token) (*ast.FloatNode, error) {
	node := ast.Float(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newInfinityNode(ctx *context, tk *Token) (*ast.InfinityNode, error) {
	node := ast.Infinity(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newNanNode(ctx *context, tk *Token) (*ast.NanNode, error) {
	node := ast.Nan(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newStringNode(ctx *context, tk *Token) (*ast.StringNode, error) {
	node := ast.String(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newLiteralNode(ctx *context, tk *Token) (*ast.LiteralNode, error) {
	node := ast.Literal(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newTagNode(ctx *context, tk *Token) (*ast.TagNode, error) {
	node := ast.Tag(tk.RawToken())
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newSequenceNode(ctx *context, tk *Token, isFlow bool) (*ast.SequenceNode, error) {
	node := ast.Sequence(tk.RawToken(), isFlow)
	node.SetPathRef(ctx.path)
	if err := setLineComment(ctx, node, tk); err != nil {
		return nil, err
	}
	return node, nil
}

func newTagDefaultScalarValueNode(ctx *context, tag *token.Token) (ast.ScalarNode, error) {
	pos := *(tag.Position)
	pos.Column++

	var (
		tk   *Token
		node ast.ScalarNode
	)
	switch token.ReservedTagKeyword(tag.Value) {
	case token.IntegerTag:
		tk = &Token{Token: token.New("0", "0", &pos)}
		n, err := newIntegerNode(ctx, tk)
		if err != nil {
			return nil, err
		}
		node = n
	case token.FloatTag:
		tk = &Token{Token: token.New("0", "0", &pos)}
		n, err := newFloatNode(ctx, tk)
		if err != nil {
			return nil, err
		}
		node = n
	case token.StringTag, token.BinaryTag, token.TimestampTag:
		tk = &Token{Token: token.New("", "", &pos)}
		n, err := newStringNode(ctx, tk)
		if err != nil {
			return nil, err
		}
		node = n
	case token.BooleanTag:
		tk = &Token{Token: token.New("false", "false", &pos)}
		n, err := newBoolNode(ctx, tk)
		if err != nil {
			return nil, err
		}
		node = n
	case token.NullTag:
		tk = &Token{Token: token.New("null", "null", &pos)}
		n, err := newNullNode(ctx, tk)
		if err != nil {
			return nil, err
		}
		node = n
	default:
		return nil, errors.ErrSyntax(fmt.Sprintf("cannot assign default value for %q tag", tag.Value), tag)
	}
	ctx.insertToken(tk)
	ctx.goNext()
	return node, nil
}

func setLineComment(ctx *context, node ast.Node, tk *Token) error {
	if tk == nil || tk.LineComment == nil {
		return nil
	}
	comment := ast.CommentGroup([]*token.Token{tk.LineComment})
	comment.SetPathRef(ctx.path)
	if err := node.SetComment(comment); err != nil {
		return err
	}
	return nil
}

func setHeadComment(cm *ast.CommentGroupNode, value ast.Node) error {
	if cm == nil {
		return nil
	}
	switch n := value.(type) {
	case *ast.MappingNode:
		if len(n.Values) != 0 && value.GetComment() == nil {
			copyPath(cm, n.Values[0])
			return n.Values[0].SetComment(cm)
		}
	case *ast.MappingValueNode:
		copyPath(cm, n)
		return n.SetComment(cm)
	}
	copyPath(cm, value)
	return value.SetComment(cm)
}

type pathRefNode interface {
	GetPathRef() *ast.PathRef
	SetPathRef(*ast.PathRef)
}

// setPathRef stores a lazily rendered path on nodes that support it.
func setPathRef(dst ast.Node, ref *ast.PathRef) {
	if d, ok := dst.(pathRefNode); ok {
		d.SetPathRef(ref)
		return
	}
	dst.SetPath(ref.String())
}

// copyPath shares src's lazily rendered path with dst instead of rendering it.
func copyPath(dst, src ast.Node) {
	if s, ok := src.(pathRefNode); ok {
		if ref := s.GetPathRef(); ref != nil {
			setPathRef(dst, ref)
			return
		}
	}
	dst.SetPath(src.GetPath())
}

// pathKey identifies a mapping key path by its shared parent and final segment
// without rendering the complete path.
type pathKey struct {
	parent  *ast.PathRef
	segment string
}

func pathKeyOf(ref *ast.PathRef) pathKey {
	return pathKey{parent: ref.Parent(), segment: ref.Segment()}
}
