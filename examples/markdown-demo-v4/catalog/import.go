package catalog

import (
	"bufio"
	"bytes"
	"fmt"
	"path/filepath"
	"strings"
	"unicode"
)

// Ansible core 2.21.2 cannot serialize -F -j (its source paths are bytes).
// The -F text format is a name, whitespace padding, then an absolute filename.
// Split only once so spaces in filenames survive; reject ambiguous records.
func importFiles(data []byte, libraryPaths []string) (*Catalog, error) {
	c := &Catalog{Modules: map[string]Module{}, Routes: map[string]Route{}}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		index := strings.IndexFunc(line, unicode.IsSpace)
		if index < 1 {
			return nil, fmt.Errorf("invalid ansible-doc file record %q", line)
		}
		discovered, path := line[:index], strings.TrimSpace(line[index:])
		if !filepath.IsAbs(path) || (filepath.Ext(path) != ".py" && filepath.Ext(path) != ".ps1") {
			return nil, fmt.Errorf("invalid ansible-doc module path %q", path)
		}
		name, kind := discovered, "collection"
		aliases := []string{discovered}
		if strings.HasPrefix(name, "ansible.builtin.") {
			kind = "builtin"
		}
		for _, root := range libraryPaths {
			relative, err := filepath.Rel(root, path)
			if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
				continue
			}
			base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
			name, kind = "ansible.builtin."+base, "library"
			aliases = append(aliases, base)
			break
		}
		c.Modules[name] = Module{CanonicalName: name, Source: Source{Path: path, Kind: kind}, DiscoveryNames: aliases}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan ansible-doc files: %w", err)
	}
	return c, nil
}
