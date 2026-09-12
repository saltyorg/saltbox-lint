// Command import-grammars imports the pinned Ansible grammars from an explicit source.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"

	"github.com/saltyorg/saltbox-lint/highlight/importer"
)

// Pins the complete extension manifest, including all eight contribution paths,
// scopes and injection targets. Source grammar hashes are recorded after parsing.
const manifestSHA256 = "8aeee07bb22518b5ad939a8bb740b80695a91bae36b0246b1fc974a25d6d77cd"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("import-grammars", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	extension := flags.String("extension", "", "directory containing the pinned Ansible 26.8.2 extension")
	out := flags.String("out", "", "asset output directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *extension == "" || *out == "" || flags.NArg() != 0 {
		return errors.New("usage: import-grammars -extension DIR -out DIR")
	}
	files, err := readGrammars(*extension)
	if err != nil {
		return err
	}
	aggregate := map[string]string{}
	manifestPath := filepath.Join(*out, "SHA256SUMS.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if err := json.Unmarshal(data, &aggregate); err != nil {
			return fmt.Errorf("%s: %w", manifestPath, err)
		}
		if aggregate == nil {
			return fmt.Errorf("%s: expected hash object", manifestPath)
		}
	}
	for path, data := range files {
		aggregate[path] = digest(data)
	}
	files["SHA256SUMS.json"], err = json.MarshalIndent(aggregate, "", "  ")
	if err != nil {
		return err
	}
	files["SHA256SUMS.json"] = append(files["SHA256SUMS.json"], '\n')
	// All source parsing and manifest validation must succeed before output changes.
	// Publication can still be interrupted by an I/O failure; rerunning is idempotent.
	for _, path := range slices.Sorted(maps.Keys(files)) {
		dest := filepath.Join(*out, path)
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(dest, files[path], 0644); err != nil {
			return err
		}
	}
	return nil
}

func readGrammars(extension string) (map[string][]byte, error) {
	data, err := os.ReadFile(filepath.Join(extension, "package.json"))
	if err != nil {
		return nil, err
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
		return nil, fmt.Errorf("package.json: %w", err)
	}
	if manifest.Version != "26.8.2" {
		return nil, fmt.Errorf("package.json: Ansible version %q, require 26.8.2", manifest.Version)
	}
	if digest(data) != manifestSHA256 {
		return nil, errors.New("package.json: unexpected pinned Ansible manifest SHA256")
	}
	files := map[string][]byte{"ansible-package.json": data}
	hashes := map[string]string{"package.json": digest(data)}
	for _, g := range manifest.Contributes.Grammars {
		raw, err := os.ReadFile(filepath.Join(extension, g.Path))
		if err != nil {
			return nil, err
		}
		converted, err := importer.Grammar(raw, g.InjectTo)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", g.Path, err)
		}
		path := "grammars/" + g.ScopeName + ".json"
		files[path] = converted
		hashes[g.Path] = digest(raw)
		hashes[path] = digest(converted)
	}
	files["ansible-sha256.json"], err = json.MarshalIndent(hashes, "", "  ")
	if err != nil {
		return nil, err
	}
	return files, nil
}

func digest(data []byte) string { return fmt.Sprintf("%x", sha256.Sum256(data)) }
