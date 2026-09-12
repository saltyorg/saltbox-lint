package catalog

import (
	"crypto/sha256"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/goccy/go-yaml"
)

// discoverSources follows DocsLibrary's source rules: module locations use
// Python basenames; collection paths retain nested module directories. Later
// roots replace earlier roots. Collection symlinks and private files are absent.
func (c *Catalog) discoverSources(modulePaths, collectionPaths []string) error {
	discovered := c.Modules
	c.Modules = map[string]Module{}
	for i, root := range modulePaths {
		kind := "library"
		if i == len(modulePaths)-1 {
			kind = "builtin"
		}
		err := walkPython(root, false, func(path string) error {
			name := "ansible.builtin." + strings.TrimSuffix(filepath.Base(path), ".py")
			c.addSource(name, path, kind, discovered)
			return nil
		})
		if err != nil {
			return err
		}
	}
	for _, root := range collectionPaths {
		roots, err := filepath.Glob(filepath.Join(root, "ansible_collections", "*", "*", "plugins", "modules"))
		if err != nil {
			return err
		}
		for _, modules := range roots {
			collectionRoot := filepath.Dir(filepath.Dir(modules))
			namespace := filepath.Base(filepath.Dir(collectionRoot)) + "." + filepath.Base(collectionRoot)
			if err := walkPython(modules, true, func(path string) error {
				relative, err := filepath.Rel(modules, path)
				if err != nil {
					return err
				}
				name := namespace + "." + strings.ReplaceAll(strings.TrimSuffix(relative, ".py"), string(filepath.Separator), ".")
				c.addSource(name, path, "collection", discovered)
				return nil
			}); err != nil {
				return err
			}
		}
	}
	for name, module := range discovered {
		if _, ok := c.Modules[name]; !ok {
			c.Problems = append(c.Problems, Problem{Kind: "discovery_difference", Module: name, Message: "ansible-doc source excluded by language-server Python discovery: " + module.Source.Path})
		}
	}
	return nil
}

func (c *Catalog) addSource(name, path, kind string, discovered map[string]Module) {
	aliases := []string{name}
	if kind == "library" {
		aliases = []string{strings.TrimSuffix(filepath.Base(path), ".py")}
	}
	if previous, ok := discovered[name]; ok && previous.Source.Path == path {
		aliases = previous.DiscoveryNames
	}
	c.Modules[name] = Module{CanonicalName: name, Source: Source{Path: path, Kind: kind}, DiscoveryNames: aliases}
}

func walkPython(root string, excludeSymlinks bool, visit func(string) error) error {
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect source root %s: %w", root, err)
	}
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return fmt.Errorf("scan source %s: %w", path, err)
		}
		if entry.IsDir() || filepath.Ext(path) != ".py" || strings.HasPrefix(entry.Name(), "_") {
			return nil
		}
		if excludeSymlinks && entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		return visit(path)
	})
}

func (c *Catalog) importRoutes(data []byte, collection string) error {
	var runtime struct {
		PluginRouting struct {
			Modules map[string]struct {
				Redirect  string         `yaml:"redirect"`
				Tombstone map[string]any `yaml:"tombstone"`
			} `yaml:"modules"`
		} `yaml:"plugin_routing"`
	}
	if err := yaml.Unmarshal(data, &runtime); err != nil {
		return fmt.Errorf("parse %s module routing: %w", collection, err)
	}
	for name, route := range runtime.PluginRouting.Modules {
		c.Routes[collection+"."+name] = Route{Redirect: route.Redirect, Tombstone: route.Tombstone != nil}
	}
	return nil
}

func (c *Catalog) recordInput(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read catalog input %s: %w", path, err)
	}
	if c.Provenance.Inputs == nil {
		c.Provenance.Inputs = map[string]string{}
	}
	c.Provenance.Inputs[path] = fmt.Sprintf("%x", sha256.Sum256(data))
	return nil
}
