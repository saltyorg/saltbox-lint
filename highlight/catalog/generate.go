package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

// GenerateOptions selects a build-time Ansible environment. Zero values use
// Saltbox's managed wrappers and checkout. These are never runtime settings.
type GenerateOptions struct {
	AnsibleDoc    string
	AnsibleGalaxy string
	ConfigPath    string
	PlaybookDir   string
	ModulePaths   []string
}

// Generate discovers installed module sources and statically imports the
// language server's documentation shape. It is read-only; the caller decides
// whether to publish the snapshot.
func Generate(ctx context.Context, options GenerateOptions) (*Catalog, error) {
	options = defaultOptions(options)
	run := commandRunner(options)
	version, stderr, err := run(ctx, options.AnsibleDoc, "--version")
	if err != nil {
		return nil, fmt.Errorf("read Ansible version: %w: %s", err, stderr)
	}
	ansibleRoot := versionValue(string(version), "ansible python module location")
	if ansibleRoot == "" {
		return nil, fmt.Errorf("ansible-doc version omitted its module location")
	}
	args := []string{"-t", "module", "-M", strings.Join(options.ModulePaths, string(os.PathListSeparator)), "--playbook-dir", options.PlaybookDir}
	docRun := func(ctx context.Context, tail ...string) ([]byte, string, error) {
		return run(ctx, options.AnsibleDoc, append(slices.Clone(args), tail...)...)
	}
	files, stderr, err := docRun(ctx, "-F")
	if err != nil {
		return nil, fmt.Errorf("discover module files: %w: %s", err, stderr)
	}
	c, err := importFiles(files, options.ModulePaths)
	if err != nil {
		return nil, err
	}
	c.SchemaVersion = 1
	c.Provenance = Provenance{AnsibleVersion: strings.TrimSpace(string(version)), ConfigPath: options.ConfigPath, PlaybookDir: options.PlaybookDir, ModulePaths: append(slices.Clone(options.ModulePaths), filepath.Join(ansibleRoot, "modules")), Inputs: map[string]string{}}
	c.Provenance.SemanticModel = "Ansible language server 26.8.2: docsFinder, docsParser and DocsLibrary static module semantics"
	c.recordWarning(stderr)
	c.Problems = append(c.Problems, Problem{Kind: "adapter", Message: "File inventory uses ansible-doc -F text because core 2.21.2 -F -j fails to JSON-serialize byte-valued paths; semantic options follow the ALS 26.8.2 static DOCUMENTATION and visible-fragment parser."})
	c.Problems = append(c.Problems, Problem{Kind: "parser_compatibility", Message: "Go YAML decoding does not reproduce the ALS JavaScript YAML parser's partial-document error recovery, alias expansion limit, or shared-regexp state after exceptions. Malformed or unusually alias-rich documentation can therefore have different option coverage."})
	collections, stderr, err := run(ctx, options.AnsibleGalaxy, "collection", "list", "--format", "json")
	if err != nil {
		return nil, fmt.Errorf("list installed collections: %w: %s", err, stderr)
	}
	c.recordWarning(stderr)
	if err := c.importCollections(collections, versionValue(string(version), "ansible collection location")); err != nil {
		return nil, err
	}
	if err := c.discoverSources(c.Provenance.ModulePaths, c.Provenance.CollectionPaths); err != nil {
		return nil, err
	}
	if err := c.collectInputs(options, ansibleRoot); err != nil {
		return nil, err
	}
	if err := c.loadStaticOptions(); err != nil {
		return nil, err
	}
	return c, nil
}

func defaultOptions(options GenerateOptions) GenerateOptions {
	if options.AnsibleDoc == "" {
		options.AnsibleDoc = "/usr/local/bin/ansible-doc"
	}
	if options.AnsibleGalaxy == "" {
		options.AnsibleGalaxy = "/usr/local/bin/ansible-galaxy"
	}
	if options.ConfigPath == "" {
		options.ConfigPath = "/srv/git/saltbox/ansible.cfg"
	}
	if options.PlaybookDir == "" {
		options.PlaybookDir = "/srv/git/saltbox"
	}
	if len(options.ModulePaths) == 0 {
		options.ModulePaths = []string{"/srv/git/saltbox/library"}
	}
	return options
}

func commandRunner(options GenerateOptions) func(context.Context, string, ...string) ([]byte, string, error) {
	return func(ctx context.Context, path string, args ...string) ([]byte, string, error) {
		command := exec.CommandContext(ctx, path, args...)
		command.Dir = options.PlaybookDir
		command.Env = append(os.Environ(), "ANSIBLE_CONFIG="+options.ConfigPath, "ANSIBLE_LOG_PATH=/dev/null", "ANSIBLE_FORCE_COLOR=false", "ANSIBLE_NOCOLOR=true", "PYTHONDONTWRITEBYTECODE=1")
		var stderr bytes.Buffer
		command.Stderr = &stderr
		stdout, err := command.Output()
		return stdout, stderr.String(), err
	}
}

func versionValue(version, key string) string {
	for line := range strings.SplitSeq(version, "\n") {
		left, right, found := strings.Cut(strings.TrimSpace(line), " = ")
		if found && left == key {
			return strings.TrimSpace(right)
		}
	}
	return ""
}

func (c *Catalog) importCollections(data []byte, configured string) error {
	var installed map[string]map[string]struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &installed); err != nil {
		return fmt.Errorf("decode installed collections: %w", err)
	}
	for _, root := range filepath.SplitList(configured) {
		if root != "" {
			c.Provenance.CollectionPaths = append(c.Provenance.CollectionPaths, root)
		}
	}
	for _, root := range slices.Sorted(maps.Keys(installed)) {
		// ansible-galaxy lists the ansible_collections directory itself. The
		// language server searches its parent, including Python's site-packages.
		parent := filepath.Dir(root)
		if !slices.Contains(c.Provenance.CollectionPaths, parent) {
			c.Provenance.CollectionPaths = append(c.Provenance.CollectionPaths, parent)
		}
		for _, name := range slices.Sorted(maps.Keys(installed[root])) {
			c.Provenance.Collections = append(c.Provenance.Collections, InstalledCollection{Name: name, Version: installed[root][name].Version, Path: filepath.Join(root, strings.ReplaceAll(name, ".", string(filepath.Separator)))})
		}
	}
	return nil
}

func (c *Catalog) collectInputs(options GenerateOptions, ansibleRoot string) error {
	for _, path := range []string{options.ConfigPath, options.AnsibleDoc, options.AnsibleGalaxy} {
		if err := c.recordInput(path); err != nil {
			return err
		}
	}
	for name, module := range c.Modules {
		if err := c.recordInput(module.Source.Path); err != nil {
			return err
		}
		module.Source.SHA256 = c.Provenance.Inputs[module.Source.Path]
		c.Modules[name] = module
	}
	if err := c.collectRouting(filepath.Join(ansibleRoot, "config", "ansible_builtin_runtime.yml"), "ansible.builtin"); err != nil {
		return err
	}
	for _, root := range c.Provenance.ModulePaths {
		if err := walkPython(filepath.Join(filepath.Dir(root), "plugins", "doc_fragments"), false, c.recordInput); err != nil {
			return err
		}
	}
	for _, collection := range c.Provenance.Collections {
		if err := c.collectRouting(filepath.Join(collection.Path, "meta", "runtime.yml"), collection.Name); err != nil {
			return err
		}
		if err := walkPython(filepath.Join(collection.Path, "plugins", "doc_fragments"), false, c.recordInput); err != nil {
			return err
		}
		for _, name := range []string{"MANIFEST.json", "galaxy.yml"} {
			path := filepath.Join(collection.Path, name)
			if _, err := os.Stat(path); os.IsNotExist(err) {
				continue
			} else if err != nil {
				return err
			}
			if err := c.recordInput(path); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c *Catalog) collectRouting(path, collection string) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read module routing %s: %w", path, err)
	}
	if err := c.importRoutes(data, collection); err != nil {
		return err
	}
	return c.recordInput(path)
}
