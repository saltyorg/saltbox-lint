package lint

import (
	"context"
	"fmt"
	"io/fs"
	"iter"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

// Load reads worktree bytes for selected files and their conventional context.
// Explicit files override Git ignores; directory selections use Git's tracked
// and nonignored untracked files. No repository or source files are changed.
func Load(ctx context.Context, opts Options) (*Project, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(opts.Paths) == 0 && opts.StdinFilename == "" {
		return nil, fmt.Errorf("no source targets selected")
	}
	if opts.Stdin != nil && opts.StdinFilename == "" {
		return nil, fmt.Errorf("stdin requires a filename")
	}
	root, err := sourceRoot(opts)
	if err != nil {
		return nil, err
	}
	name, err := projectName(root)
	if err != nil {
		return nil, err
	}
	p := &Project{Root: root, Name: name, Sources: map[string]*Source{}, Selected: map[string]bool{}}
	l := sourceLoader{ctx: ctx, project: p}
	gitRoot, err := enclosingGitRoot(root)
	if err != nil {
		return nil, err
	}
	if gitRoot != "" {
		// Git handles nested ignores, tracked-but-ignored files, and worktree metadata.
		cmd := exec.CommandContext(ctx, "git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
		output, err := cmd.Output()
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, fmt.Errorf("discover Git sources in %s: %w", root, err)
		}
		l.gitFiles = []string{}
		for item := range strings.SplitSeq(string(output), "\x00") {
			if item != "" {
				l.gitFiles = append(l.gitFiles, filepath.Clean(filepath.FromSlash(item)))
			}
		}
		slices.Sort(l.gitFiles)
		l.gitFiles = slices.Compact(l.gitFiles)
	}
	if opts.StdinFilename != "" {
		l.stdinPath, err = absoluteTarget(opts.StdinFilename)
		if err != nil {
			return nil, err
		}
		l.stdin = opts.Stdin
	}
	targets := slices.Clone(opts.Paths)
	if opts.StdinFilename != "" {
		targets = append(targets, opts.StdinFilename)
	}
	for _, target := range targets {
		absolute, err := absoluteTarget(target)
		if err != nil {
			return nil, err
		}
		if absolute == l.stdinPath {
			if err := l.add(absolute, true); err != nil {
				return nil, err
			}
			continue
		}
		info, err := os.Stat(absolute)
		if err != nil {
			return nil, fmt.Errorf("inspect target %s: %w", target, err)
		}
		if info.IsDir() {
			err = l.directory(absolute, true)
		} else {
			err = l.add(absolute, true)
		}
		if err != nil {
			return nil, err
		}
	}
	if len(p.Selected) == 0 {
		return nil, fmt.Errorf("no supported sources selected")
	}
	contextDirs := map[string]bool{}
	for selected := range p.Selected {
		s := p.Sources[selected]
		if s.RolePath != "" {
			for _, kind := range []string{"defaults", "tasks", "handlers", "vars", "templates"} {
				contextDirs[filepath.Join(root, filepath.FromSlash(s.RolePath), kind)] = true
			}
		}
		if strings.HasPrefix(selected, "resources/tasks/docker/") {
			contextDirs[filepath.Join(root, "resources", "tasks", "docker")] = true
		}
	}
	for _, dir := range sortedKeys(contextDirs) {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return nil, fmt.Errorf("inspect context %s: %w", dir, err)
		}
		if err := l.directory(dir, false); err != nil {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return p, nil
}

type sourceLoader struct {
	ctx       context.Context
	project   *Project
	gitFiles  []string
	stdinPath string
	stdin     []byte
}

func (l *sourceLoader) add(absolute string, selected bool) error {
	if err := l.ctx.Err(); err != nil {
		return err
	}
	relative, err := relativeSource(l.project.Root, absolute)
	if err != nil {
		return err
	}
	if !supportedSource(relative) || (selected && isTemplate(relative)) {
		return fmt.Errorf("unsupported source target %s", absolute)
	}
	if selected {
		l.project.Selected[relative] = true
	}
	if _, exists := l.project.Sources[relative]; exists {
		return nil
	}
	s, err := l.readSource(absolute, relative)
	if err != nil {
		return err
	}
	l.project.Sources[relative] = s
	l.project.Diagnostics = append(l.project.Diagnostics, s.parseDiagnostics...)
	return nil
}

func (l *sourceLoader) readSource(absolute, relative string) (*Source, error) {
	if err := l.ctx.Err(); err != nil {
		return nil, err
	}
	var data []byte
	if absolute == l.stdinPath {
		data = l.stdin
		s, _ := Parse(relative, data)
		return s, nil
	} else {
		resolved, err := filepath.EvalSymlinks(absolute)
		if err != nil {
			return nil, fmt.Errorf("resolve source %s: %w", absolute, err)
		}
		if _, err := relativeSource(l.project.Root, resolved); err != nil {
			return nil, err
		}
		info, err := os.Stat(absolute)
		if err != nil {
			return nil, fmt.Errorf("inspect source %s: %w", absolute, err)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("source is not a regular file: %s", absolute)
		}
		data, err = os.ReadFile(absolute)
		if err != nil {
			return nil, fmt.Errorf("read source %s: %w", absolute, err)
		}
	}
	s, _ := parseOwnedSource(relative, data)
	return s, nil
}

func (l *sourceLoader) directory(dir string, selected bool) error {
	relative, err := relativeSource(l.project.Root, dir)
	if err != nil {
		return err
	}
	var paths []string
	var discoveryErr error
	if l.gitFiles != nil {
		for name := range gitDirectoryCandidates(l.gitFiles, filepath.FromSlash(relative)) {
			if directorySource(filepath.ToSlash(name), selected) {
				paths = append(paths, filepath.Join(l.project.Root, name))
			}
		}
	} else {
		paths, discoveryErr = l.walkDirectory(dir, selected)
	}
	if err := l.directorySources(paths, selected); err != nil {
		return err
	}
	// A walk error follows all candidates discovered before it, including any
	// earlier read error. Read completion order must not change that precedence.
	return discoveryErr
}

func (l *sourceLoader) walkDirectory(dir string, selected bool) ([]string, error) {
	var paths []string
	err := filepath.WalkDir(dir, func(absolute string, entry fs.DirEntry, err error) error {
		if err != nil {
			return fmt.Errorf("discover sources in %s: %w", dir, err)
		}
		if err := l.ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := relativeSource(l.project.Root, absolute)
		if err != nil {
			return err
		}
		if !directorySource(relative, selected) {
			return nil
		}
		paths = append(paths, absolute)
		return nil
	})
	return paths, err
}

func (l *sourceLoader) directorySources(paths []string, selected bool) error {
	results := readSourceBatch(paths, func(absolute string) (*Source, error) {
		// Tracked files deleted from the worktree are not source inputs.
		if l.gitFiles != nil {
			if _, err := os.Stat(absolute); os.IsNotExist(err) {
				return nil, nil
			} else if err != nil {
				return nil, fmt.Errorf("inspect source %s: %w", absolute, err)
			}
		}
		relative, err := relativeSource(l.project.Root, absolute)
		if err != nil {
			return nil, err
		}
		if err := l.ctx.Err(); err != nil {
			return nil, err
		}
		kind, _, _ := classify(relative)
		if source := l.project.Sources[relative]; source != nil && (!selected || kind != Generic) {
			return source, nil
		}
		source, err := l.readSource(absolute, relative)
		if err != nil {
			return nil, err
		}
		// Arbitrarily named root playbooks are admitted by parsed structure.
		if selected && kind == Generic && source.Kind != Playbook {
			return nil, nil
		}
		return source, nil
	})
	for _, result := range results {
		if result.err != nil {
			return result.err
		}
		source := result.source
		if source == nil {
			continue
		}
		if selected {
			l.project.Selected[source.Path] = true
		}
		if _, exists := l.project.Sources[source.Path]; !exists {
			l.project.Diagnostics = append(l.project.Diagnostics, source.parseDiagnostics...)
		}
		l.project.Sources[source.Path] = source
	}
	return l.ctx.Err()
}

// Git paths are sorted once. A directory visits only its own prefix range,
// retaining an exact indexed path when a tracked file became a directory.
func gitDirectoryCandidates(files []string, dir string) iter.Seq[string] {
	return func(yield func(string) bool) {
		if dir == "." {
			for _, name := range files {
				if !yield(name) {
					return
				}
			}
			return
		}
		if index, found := slices.BinarySearch(files, dir); found && !yield(files[index]) {
			return
		}
		prefix := dir + string(filepath.Separator)
		start, _ := slices.BinarySearch(files, prefix)
		for _, name := range files[start:] {
			if !strings.HasPrefix(name, prefix) || !yield(name) {
				return
			}
		}
	}
}

func supportedSource(name string) bool {
	if isTemplate(name) {
		return true
	}
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".yaml" || ext == ".yml"
}

func directorySource(name string, selected bool) bool {
	if !supportedSource(name) {
		return false
	}
	kind, _, _ := classify(filepath.ToSlash(name))
	if selected {
		return kind != Template && (kind != Generic || !strings.Contains(filepath.ToSlash(name), "/"))
	}
	return kind != Generic
}

func isTemplate(name string) bool {
	kind, _, _ := classify(filepath.ToSlash(name))
	return kind == Template
}

func absoluteTarget(name string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("empty source target")
	}
	absolute, err := filepath.Abs(name)
	if err != nil {
		return "", fmt.Errorf("resolve target %s: %w", name, err)
	}
	info, err := os.Stat(absolute)
	if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect target %s: %w", name, err)
	}
	if err == nil && info.IsDir() {
		return filepath.EvalSymlinks(absolute)
	}
	// Resolve directory aliases, but retain a file's own basename. The fix
	// layer must still be able to Lstat Root/Source.Path and reject file links.
	parent, err := canonicalDirectory(filepath.Dir(absolute))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(absolute)), nil
}

// An editor buffer may name a file in a directory that does not exist yet.
// Resolve its nearest existing ancestor without concealing dangling links.
func canonicalDirectory(dir string) (string, error) {
	resolved, err := filepath.EvalSymlinks(dir)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) {
		return "", fmt.Errorf("resolve directory %s: %w", dir, err)
	}
	if _, statErr := os.Lstat(dir); statErr == nil || !os.IsNotExist(statErr) {
		return "", fmt.Errorf("resolve directory %s: %w", dir, err)
	}
	parent, err := canonicalDirectory(filepath.Dir(dir))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(dir)), nil
}
func relativeSource(root, absolute string) (string, error) {
	relative, err := filepath.Rel(root, absolute)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("source %s is outside root %s", absolute, root)
	}
	return filepath.ToSlash(relative), nil
}
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

func sourceRoot(opts Options) (string, error) {
	if opts.Root != "" {
		root, err := filepath.Abs(opts.Root)
		if err != nil {
			return "", err
		}
		info, err := os.Stat(root)
		if err != nil {
			return "", fmt.Errorf("inspect root %s: %w", root, err)
		}
		if !info.IsDir() {
			return "", fmt.Errorf("source root is not a directory: %s", root)
		}
		return filepath.EvalSymlinks(root)
	}
	target := opts.StdinFilename
	if len(opts.Paths) > 0 {
		target = opts.Paths[0]
	}
	absolute, err := absoluteTarget(target)
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(absolute)
	if info, err := os.Stat(absolute); err == nil && info.IsDir() {
		dir = absolute
	} else if err != nil && (!os.IsNotExist(err) || target != opts.StdinFilename) {
		return "", fmt.Errorf("inspect target %s: %w", target, err)
	}
	for current := dir; ; current = filepath.Dir(current) {
		name, err := projectName(current)
		if err != nil {
			return "", err
		}
		marker, err := hasGitMarker(current)
		if err != nil {
			return "", err
		}
		if name != "" || marker {
			return filepath.EvalSymlinks(current)
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	return filepath.EvalSymlinks(dir)
}
func projectName(root string) (string, error) {
	for _, name := range []string{"saltbox", "sandbox"} {
		for _, ext := range []string{".yml", ".yaml"} {
			info, err := os.Stat(filepath.Join(root, name+ext))
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return "", fmt.Errorf("inspect project identity: %w", err)
			}
			if info.Mode().IsRegular() {
				return name, nil
			}
		}
	}
	return "", nil
}
func hasGitMarker(dir string) (bool, error) {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect Git root: %w", err)
	}
	return true, nil
}
func enclosingGitRoot(dir string) (string, error) {
	for {
		found, err := hasGitMarker(dir)
		if err != nil {
			return "", err
		}
		if found {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", nil
		}
		dir = parent
	}
}
