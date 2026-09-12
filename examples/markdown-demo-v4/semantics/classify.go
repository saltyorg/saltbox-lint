package semantics

import (
	"bytes"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/goccy/go-yaml/lexer"
	"gopkg.in/yaml.v3"
	"saltbox-lint-markdown-demo-v4/catalog"
)

type classifier struct {
	options Options
	index   *sourceIndex
	tokens  []Token
	seen    map[byteRange]struct{}
	err     error
}

type mapContext struct {
	node         *yaml.Node
	parent       *mapContext
	inSequence   bool
	sequenceKey  string
	rootSequence bool
}

type mappingKind uint8

const (
	ordinaryMapping mappingKind = iota
	playMapping
	blockMapping
	roleMapping
	taskMapping
)

func classify(source string, options Options) ([]Token, error) {
	rawTokens := lexer.Tokenize(source)
	index, err := indexSource(source, rawTokens)
	if err != nil {
		return nil, fmt.Errorf("index YAML source for semantic classification: %w", err)
	}

	var document yaml.Node
	err = yaml.NewDecoder(bytes.NewBufferString(source)).Decode(&document)
	if err != nil {
		if err == io.EOF {
			return []Token{}, nil
		}
		return nil, fmt.Errorf("parse YAML for semantic classification: %w", err)
	}
	if len(document.Content) == 0 {
		return []Token{}, nil
	}

	c := &classifier{options: options, index: index, seen: make(map[byteRange]struct{})}
	c.walk(document.Content[0], nil, "", true)
	if c.err != nil {
		return nil, c.err
	}
	slices.SortStableFunc(c.tokens, func(a, b Token) int {
		if a.Start != b.Start {
			return a.Start - b.Start
		}
		return a.End - b.End
	})
	return c.tokens, nil
}

func (c *classifier) walk(node *yaml.Node, parent *mapContext, sequenceKey string, root bool) {
	if node == nil || node.Kind == yaml.AliasNode {
		return
	}
	switch node.Kind {
	case yaml.MappingNode:
		c.walkMapping(&mapContext{node: node, parent: parent})
	case yaml.SequenceNode:
		for _, item := range node.Content {
			if item.Kind == yaml.MappingNode {
				c.walkMapping(&mapContext{
					node:         item,
					parent:       parent,
					inSequence:   true,
					sequenceKey:  sequenceKey,
					rootSequence: root,
				})
				continue
			}
			c.walk(item, parent, sequenceKey, false)
		}
	}
}

func (c *classifier) walkMapping(context *mapContext) {
	switch c.mappingKind(context) {
	case playMapping:
		c.walkContextMapping(context, playKeywords)
	case blockMapping:
		c.walkContextMapping(context, blockKeywords)
	case roleMapping:
		c.walkContextMapping(context, roleKeywords)
	case taskMapping:
		c.walkTask(context)
	default:
		c.walkMappingFallback(context.node)
	}
}

func (c *classifier) mappingKind(context *mapContext) mappingKind {
	if !context.inSequence {
		return ordinaryMapping
	}
	if context.rootSequence && mappingHasAnyKey(context.node, playExclusiveKeywords) {
		return playMapping
	}
	if mappingHasKey(context.node, "block") {
		return blockMapping
	}
	if context.sequenceKey == "roles" {
		return roleMapping
	}
	if context.rootSequence || isTaskSequenceKey(context.sequenceKey) {
		return taskMapping
	}
	return ordinaryMapping
}

func (c *classifier) walkContextMapping(context *mapContext, keywords map[string]struct{}) {
	forEachPair(context.node, func(key, value *yaml.Node) {
		name, ok := scalarString(key)
		if ok {
			if containsKeyword(keywords, name) {
				c.emit(key, Keyword)
			} else {
				c.emit(key, Property, Definition)
			}
		}
		c.walkValue(value, context, name)
	})
}

func (c *classifier) walkTask(context *mapContext) {
	forEachPair(context.node, func(key, value *yaml.Node) {
		name, ok := scalarString(key)
		if !ok {
			c.walkValue(value, context, "")
			return
		}
		if isTaskKeyword(name) {
			c.emit(key, Keyword)
			if name == "args" {
				if module, found := c.findProvidedModule(context); found && value.Kind == yaml.MappingNode {
					c.walkOptions(value, module.Options)
				}
			}
			return
		}

		module, found := c.resolveModule(name, context)
		if !found {
			c.walkPairFallback(key, value)
			return
		}
		c.emit(key, Class)
		if value.Kind == yaml.MappingNode {
			c.walkOptions(value, module.Options)
		}
	})
}

func (c *classifier) walkOptions(mapping *yaml.Node, options map[string]catalog.Option) {
	forEachPair(mapping, func(key, value *yaml.Node) {
		name, ok := scalarString(key)
		if !ok {
			c.walkFallback(value)
			return
		}
		option, found := catalog.FindOption(options, name)
		if !found {
			c.walkFallback(value)
			return
		}
		c.emit(key, Method)
		switch {
		case option.Type == "dict" && value.Kind == yaml.MappingNode:
			c.walkOptions(value, option.Suboptions)
		case option.Type == "list" && value.Kind == yaml.SequenceNode:
			for _, item := range value.Content {
				if item.Kind == yaml.MappingNode {
					c.walkOptions(item, option.Suboptions)
				} else {
					c.walkFallback(item)
				}
			}
		default:
			c.walkFallback(value)
		}
	})
}

func (c *classifier) walkMappingFallback(mapping *yaml.Node) {
	forEachPair(mapping, c.walkPairFallback)
}

func (c *classifier) walkPairFallback(key, value *yaml.Node) {
	if _, ok := scalarString(key); ok {
		c.emit(key, Property, Definition)
	}
	c.walkFallback(value)
}

func (c *classifier) walkFallback(node *yaml.Node) {
	if node == nil || node.Kind == yaml.AliasNode {
		return
	}
	switch node.Kind {
	case yaml.MappingNode:
		c.walkMappingFallback(node)
	case yaml.SequenceNode:
		for _, item := range node.Content {
			c.walkFallback(item)
		}
	}
}

func (c *classifier) walkValue(node *yaml.Node, parent *mapContext, key string) {
	if node == nil || node.Kind == yaml.AliasNode {
		return
	}
	switch node.Kind {
	case yaml.MappingNode:
		c.walkMapping(&mapContext{node: node, parent: parent})
	case yaml.SequenceNode:
		c.walk(node, parent, key, false)
	}
}

func (c *classifier) findProvidedModule(context *mapContext) (catalog.Module, bool) {
	seen := make(map[string]struct{})
	var found catalog.Module
	forEachPair(context.node, func(key, _ *yaml.Node) {
		if found.CanonicalName != "" {
			return
		}
		name, ok := scalarString(key)
		if !ok || name == "" || isTaskKeyword(name) {
			return
		}
		if _, duplicate := seen[name]; duplicate {
			return
		}
		seen[name] = struct{}{}
		if module, ok := c.resolveModule(name, context); ok {
			found = module
		}
	})
	return found, found.CanonicalName != ""
}

func (c *classifier) resolveModule(name string, context *mapContext) (catalog.Module, bool) {
	if c.options.Catalog == nil {
		return catalog.Module{}, false
	}
	return c.options.Catalog.Resolve(name, catalog.ResolveContext{Collections: c.declaredCollections(context)})
}

func (c *classifier) declaredCollections(context *mapContext) []string {
	collections := append([]string(nil), c.options.Collections...)
	collections = append(collections, mappingCollections(context.node)...)
	current := context
	for current.parent != nil && isBlockSequenceKey(current.sequenceKey) {
		current = current.parent
		collections = append(collections, mappingCollections(current.node)...)
	}
	if current.parent != nil {
		collections = append(collections, mappingCollections(current.parent.node)...)
	}
	return deduplicate(collections)
}

func mappingCollections(mapping *yaml.Node) []string {
	var collections []string
	forEachPair(mapping, func(key, value *yaml.Node) {
		name, ok := scalarString(key)
		if !ok || name != "collections" || value.Kind != yaml.SequenceNode || collections != nil {
			return
		}
		for _, item := range value.Content {
			if collection, ok := scalarString(item); ok {
				collections = append(collections, collection)
			}
		}
	})
	return collections
}

func (c *classifier) emit(node *yaml.Node, tokenType TokenType, modifiers ...Modifier) {
	if c.err != nil {
		return
	}
	span, ok := c.index.scalarRange(node.Line, node.Column, node.Value)
	if !ok {
		c.err = fmt.Errorf("locate semantic YAML key at %d:%d", node.Line, node.Column)
		return
	}
	if span.start < 0 || span.end <= span.start || span.end > len(c.index.data) {
		c.err = fmt.Errorf("invalid semantic YAML range [%d:%d] at %d:%d", span.start, span.end, node.Line, node.Column)
		return
	}
	if _, duplicate := c.seen[span]; duplicate {
		return
	}
	c.seen[span] = struct{}{}
	c.tokens = append(c.tokens, Token{Start: span.start, End: span.end, Type: tokenType, Modifiers: modifiers})
}

func forEachPair(mapping *yaml.Node, visit func(key, value *yaml.Node)) {
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		visit(mapping.Content[index], mapping.Content[index+1])
	}
}

func scalarString(node *yaml.Node) (string, bool) {
	if node == nil || node.Kind != yaml.ScalarNode {
		return "", false
	}
	return node.Value, true
}

func mappingHasKey(mapping *yaml.Node, wanted string) bool {
	found := false
	forEachPair(mapping, func(key, _ *yaml.Node) {
		if value, ok := scalarString(key); ok && value == wanted {
			found = true
		}
	})
	return found
}

func mappingHasAnyKey(mapping *yaml.Node, keys map[string]struct{}) bool {
	found := false
	forEachPair(mapping, func(key, _ *yaml.Node) {
		if value, ok := scalarString(key); ok && containsKeyword(keys, value) {
			found = true
		}
	})
	return found
}

func isTaskKeyword(key string) bool {
	return containsKeyword(taskKeywords, key) || strings.HasPrefix(key, "with_")
}

func isTaskSequenceKey(key string) bool {
	switch key {
	case "tasks", "pre_tasks", "post_tasks", "block", "rescue", "always", "handlers":
		return true
	default:
		return false
	}
}

func isBlockSequenceKey(key string) bool {
	switch key {
	case "block", "rescue", "always":
		return true
	default:
		return false
	}
}

func deduplicate(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	unique := values[:0]
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		unique = append(unique, value)
	}
	return unique
}
