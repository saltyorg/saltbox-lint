// Package scaffold plans and explicitly creates minimal policy-validated roles.
package scaffold

import (
	"context"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/saltyorg/saltbox-lint/lint"
)

// Options contains user-supplied role identity and attribution.
type Options struct {
	Root, Name, Title, Author, URL string
}

// File is one exact proposed root-relative path and its complete contents.
type File struct {
	Path, Content string
}

// Plan retains immutable proposed sources and the physical owners admitted at
// planning time. Previewing a plan does not create files or directories.
type Plan struct {
	root, spelling, name, marker string
	files                        []File
	owners                       map[string]os.FileInfo
}

// Files returns a caller-owned copy in deterministic creation/preview order.
func (p *Plan) Files() []File { return append([]File(nil), p.files...) }

// Root returns the canonical source root that owns every proposed path.
func (p *Plan) Root() string { return p.root }

// Role constructs all sources in memory and checks the complete rule registry
// under the source loader's actual Saltbox or Sandbox identity.
func Role(ctx context.Context, options Options) (*Plan, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if options.Root == "" {
		return nil, fmt.Errorf("--root is required")
	}
	if !safeName(options.Name) {
		return nil, fmt.Errorf("role name must be a portable lowercase ASCII name using letters, digits and underscores")
	}
	spelling, err := filepath.Abs(options.Root)
	if err != nil {
		return nil, err
	}
	if administrativePath(spelling) {
		return nil, fmt.Errorf("refuse scaffold inside Git administration")
	}
	marker, err := projectMarker(spelling)
	if err != nil {
		return nil, err
	}
	project, err := lint.Load(ctx, lint.Options{Root: spelling, Paths: []string{filepath.Join(spelling, marker)}})
	if err != nil {
		return nil, err
	}
	if administrativePath(project.Root) {
		return nil, fmt.Errorf("refuse scaffold inside Git administration")
	}
	if project.Name == "sandbox" {
		if options.Author != "" && options.Author != "salty" {
			return nil, fmt.Errorf("sandbox roles require --author salty")
		}
		options.Author = "salty"
	}
	for _, field := range []struct{ name, value string }{{"title", options.Title}, {"author", options.Author}, {"url", options.URL}} {
		if !metadataLine(field.value) {
			return nil, fmt.Errorf("--%s requires a nonempty single line without control characters or surrounding whitespace", field.name)
		}
	}
	address, err := url.Parse(options.URL)
	if err != nil || address == nil || (address.Scheme != "https" && address.Scheme != "http") || address.Hostname() == "" || strings.ContainsAny(options.URL, " \t") {
		return nil, fmt.Errorf("--url requires an absolute HTTP or HTTPS project URL")
	}
	p := &Plan{root: project.Root, spelling: spelling, name: options.Name, marker: marker, owners: map[string]os.FileInfo{}}
	for _, path := range []string{".", "roles"} {
		info, err := physicalDirectory(filepath.Join(p.root, path))
		if err != nil {
			return nil, err
		}
		p.owners[path] = info
	}
	p.owners[marker], err = os.Lstat(filepath.Join(p.root, marker))
	if err != nil {
		return nil, err
	}
	header := fmt.Sprintf("################################\n# Title: %s\n# Author(s): %s\n# URL: %s\n# GNU General Public License v3.0\n################################\n---\n", options.Title, options.Author, options.URL)
	p.files = []File{
		{Path: "roles/" + p.name + "/defaults/main.yml", Content: header + "{}\n"},
		{Path: "roles/" + p.name + "/tasks/main.yml", Content: header + "[]\n"},
	}
	project.Sources = map[string]*lint.Source{}
	project.Selected = map[string]bool{}
	project.Diagnostics = nil
	for _, file := range p.files {
		source, _ := lint.Parse(file.Path, []byte(file.Content))
		project.Sources[file.Path] = source
		project.Selected[file.Path] = true
	}
	if findings := lint.Analyze(project, lint.Rules()); len(findings) > 0 {
		finding := findings[0]
		return nil, fmt.Errorf("generated role failed registry validation at %s [%s]: %s; %s", finding.Path, finding.RuleID, finding.Message, finding.Expected)
	}
	if err := p.preflight(ctx); err != nil {
		return nil, err
	}
	return p, nil
}

func safeName(name string) bool {
	if name == "" || len(name) > 128 || !filepath.IsLocal(name) {
		return false
	}
	for _, character := range name {
		if character != '_' && (character < 'a' || character > 'z') && (character < '0' || character > '9') {
			return false
		}
	}
	// Windows device names are reserved even on a non-Windows planning host.
	upper := strings.ToUpper(name)
	if upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL" || (len(upper) == 4 && (strings.HasPrefix(upper, "COM") || strings.HasPrefix(upper, "LPT")) && upper[3] >= '1' && upper[3] <= '9') {
		return false
	}
	return true
}

func metadataLine(value string) bool {
	if !utf8.ValidString(value) || strings.TrimSpace(value) != value || value == "" {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || unicode.Is(unicode.Cf, character) || character == '\u2028' || character == '\u2029' {
			return false
		}
	}
	return true
}

func administrativePath(path string) bool {
	for _, segment := range strings.Split(filepath.ToSlash(path), "/") {
		if strings.EqualFold(segment, ".git") {
			return true
		}
	}
	return false
}

func projectMarker(root string) (string, error) {
	marker := ""
	for _, candidate := range []string{"saltbox.yml", "saltbox.yaml", "sandbox.yml", "sandbox.yaml"} {
		info, err := os.Lstat(filepath.Join(root, candidate))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		if !info.Mode().IsRegular() {
			return "", fmt.Errorf("project marker must be a physical regular file: %s", candidate)
		}
		if marker != "" {
			return "", fmt.Errorf("ambiguous source root: multiple Saltbox/Sandbox markers")
		}
		marker = candidate
	}
	if marker == "" {
		return "", fmt.Errorf("--root must contain an existing Saltbox or Sandbox project marker")
	}
	return marker, nil
}

func physicalDirectory(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect required directory %s: %w", path, err)
	}
	// Use the loader's handle-based Windows resolver as well as its POSIX path
	// resolver. EvalSymlinks alone does not resolve terminal Windows junctions.
	identity, err := lint.ResolveSourceIdentity(path, filepath.Join(path, "main.yml"))
	if err != nil || !info.IsDir() || identity.Root != filepath.Clean(path) {
		return nil, fmt.Errorf("required directory must have its original physical owner: %s", path)
	}
	return info, nil
}

func (p *Plan) validateOwners(ctx context.Context, owners map[string]os.FileInfo) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	identity, err := lint.ResolveSourceIdentity(p.spelling, filepath.Join(p.spelling, p.marker))
	if err != nil || identity.Root != p.root {
		return fmt.Errorf("source root owner changed since planning")
	}
	marker, err := projectMarker(p.root)
	if err != nil || marker != p.marker {
		return fmt.Errorf("source root identity changed since planning")
	}
	for path, original := range owners {
		current, err := os.Lstat(filepath.Join(p.root, filepath.FromSlash(path)))
		if err != nil || !os.SameFile(original, current) || original.Mode() != current.Mode() {
			return fmt.Errorf("source owner changed since planning: %s", path)
		}
		if original.IsDir() {
			if _, err := physicalDirectory(filepath.Join(p.root, filepath.FromSlash(path))); err != nil {
				return err
			}
		}
	}
	return nil
}

func (p *Plan) preflight(ctx context.Context) error {
	if err := p.validateOwners(ctx, p.owners); err != nil {
		return err
	}
	// Recheck inherited Git administrative controls before granting creation.
	if _, err := lint.Load(ctx, lint.Options{Root: p.root, Paths: []string{filepath.Join(p.root, p.marker)}}); err != nil {
		return err
	}
	for _, path := range append([]string{"roles/" + p.name}, p.files[0].Path, p.files[1].Path) {
		if _, err := os.Lstat(filepath.Join(p.root, filepath.FromSlash(path))); !os.IsNotExist(err) {
			return fmt.Errorf("refuse existing or inaccessible scaffold target %s: %w", path, existingError(err))
		}
	}
	return nil
}

func existingError(err error) error {
	if err == nil {
		return fs.ErrExist
	}
	return err
}

// Write preflights the entire plan before creating anything. It returns every
// created directory (with trailing slash) and file, including on failure.
// Partial creations are deliberately retained; there is no automatic rollback.
// Anchored operations and owner checks do not promise a filesystem transaction.
func (p *Plan) Write(ctx context.Context) ([]string, error) { return p.write(ctx, nil) }

func (p *Plan) write(ctx context.Context, before func(string) error) ([]string, error) {
	if err := p.preflight(ctx); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(p.root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	roles, err := root.OpenRoot("roles")
	if err != nil {
		return nil, err
	}
	defer func() { _ = roles.Close() }()
	owners := make(map[string]os.FileInfo, len(p.owners)+3)
	for path, info := range p.owners {
		owners[path] = info
	}
	var created []string
	check := func(path string) error {
		if before != nil {
			if err := before(path); err != nil {
				return err
			}
		}
		if err := p.validateOwners(ctx, owners); err != nil {
			return err
		}
		opened, err := root.Stat(".")
		if err != nil || !os.SameFile(p.owners["."], opened) {
			return fmt.Errorf("opened root owner changed since planning")
		}
		openedRoles, err := roles.Stat(".")
		if err != nil || !os.SameFile(p.owners["roles"], openedRoles) {
			return fmt.Errorf("opened roles directory owner changed since planning")
		}
		return nil
	}
	rolePath := "roles/" + p.name
	if err := check(rolePath); err != nil {
		return created, err
	}
	if err := roles.Mkdir(p.name, 0o755); err != nil {
		return created, err
	}
	created = append(created, rolePath+"/")
	owners[rolePath], err = roles.Lstat(p.name)
	if err != nil {
		return created, err
	}
	role, err := roles.OpenRoot(p.name)
	if err != nil {
		return created, err
	}
	defer func() { _ = role.Close() }()
	openedRole, err := role.Stat(".")
	if err != nil || !os.SameFile(owners[rolePath], openedRole) {
		return created, fmt.Errorf("opened role directory owner changed during creation")
	}
	for _, file := range p.files {
		directory := filepath.Dir(filepath.FromSlash(file.Path))
		if err := check(filepath.ToSlash(directory)); err != nil {
			return created, err
		}
		leafDirectory := filepath.Base(directory)
		if err := role.Mkdir(leafDirectory, 0o755); err != nil {
			return created, err
		}
		created = append(created, filepath.ToSlash(directory)+"/")
		owners[filepath.ToSlash(directory)], err = role.Lstat(leafDirectory)
		if err != nil {
			return created, err
		}
		if err := check(file.Path); err != nil {
			return created, err
		}
		output, err := role.OpenFile(filepath.Join(leafDirectory, "main.yml"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return created, err
		}
		created = append(created, file.Path)
		_, writeErr := output.WriteString(file.Content)
		closeErr := output.Close()
		if writeErr != nil {
			return created, writeErr
		}
		if closeErr != nil {
			return created, closeErr
		}
	}
	return created, p.validateOwners(ctx, owners)
}
