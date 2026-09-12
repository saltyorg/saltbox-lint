// Command import-grammars imports the installed, pinned Ansible grammars.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/saltyorg/saltbox-lint/highlight/importer"
	"os"
	"path/filepath"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	const extension = "/root/.vscode-server/extensions/redhat.ansible-26.8.2"
	const out = "highlight/assets"
	data, err := os.ReadFile(filepath.Join(extension, "package.json"))
	if err != nil {
		return err
	}
	var manifest struct {
		Version     string `json:"version"`
		Contributes struct {
			Grammars []struct {
				Path      string   `json:"path"`
				ScopeName string   `json:"scopeName"`
				InjectTo  []string `json:"injectTo"`
			} `json:"grammars"`
		} `json:"contributes"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return err
	}
	if manifest.Version != "26.8.2" || len(manifest.Contributes.Grammars) != 8 {
		return fmt.Errorf("unexpected Ansible manifest")
	}
	hashes := map[string]string{}
	for _, g := range manifest.Contributes.Grammars {
		raw, err := os.ReadFile(filepath.Join(extension, g.Path))
		if err != nil {
			return err
		}
		converted, err := importer.Grammar(raw, g.InjectTo)
		if err != nil {
			return fmt.Errorf("%s: %w", g.Path, err)
		}
		path := "grammars/" + g.ScopeName + ".json"
		if err := os.WriteFile(filepath.Join(out, path), converted, 0644); err != nil {
			return err
		}
		hashes[g.Path] = fmt.Sprintf("%x", sha256.Sum256(raw))
		hashes[path] = fmt.Sprintf("%x", sha256.Sum256(converted))
	}
	hashes["package.json"] = fmt.Sprintf("%x", sha256.Sum256(data))
	if err := os.WriteFile(filepath.Join(out, "ansible-package.json"), data, 0644); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(hashes, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(out, "ansible-sha256.json"), encoded, 0644)
}
