package lint

import (
	"context"
	"crypto/sha256"
	"errors"
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
	if opts.ChangedSince != "" {
		return loadChanged(ctx, opts)
	}
	return load(ctx, opts, false)
}

func load(ctx context.Context, opts Options, explain bool) (*Project, error) {
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
	name, identity, err := inspectProjectIdentity(root)
	if err != nil {
		return nil, err
	}
	p := &Project{discoverable: map[string]bool{}, Root: root, Name: name, Sources: map[string]*Source{}, Selected: map[string]bool{}, identity: identity, directories: map[string]string{}, discovery: []DependencyFile{}}
	files, err := os.OpenRoot(root)
	if err != nil {
		return nil, fmt.Errorf("open source root %s: %w", root, err)
	}
	defer func() { _ = files.Close() }()
	l := sourceLoader{ctx: ctx, project: p, explain: explain, files: files}
	gitRoot, err := enclosingGitRoot(root)
	if err != nil {
		return nil, err
	}
	if gitRoot != "" {
		for _, name := range []string{".gitignore", ".git/info/exclude"} {
			absolute := filepath.Join(root, filepath.FromSlash(name))
			// Refuse escaped controls before Git can read them as well. Other
			// failed observations retain the existing missing/unavailable states.
			if _, err := ownedSourcePath(root, absolute); errors.Is(err, errOutsideRoot) {
				return nil, err
			}
			if opts.IncludeAnalysis {
				observation := DependencyFile{Path: name, State: "missing"}
				if data, err := l.readFile(absolute); err == nil {
					observation.State = "read"
					observation.SHA256 = fmt.Sprintf("%x", sha256.Sum256(data))
				} else if !errors.Is(err, fs.ErrNotExist) {
					observation.State = "unavailable"
				}
				p.discovery = append(p.discovery, observation)
			}
		}
		// Nested source roots still inherit repository discovery policy. Its
		// administrative controls are opaque Git inputs, not source facts.
		if err := preflightGitControls(ctx, root, gitRoot); err != nil {
			return nil, err
		}
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
	if len(p.Selected) == 0 && !opts.allowEmpty {
		return nil, fmt.Errorf("no supported sources selected")
	}
	rules := Rules()
	contextDirs := map[string]bool{}
	for selected := range p.Selected {
		for _, dir := range contextDirectories(p.Sources[selected], rules) {
			contextDirs[filepath.Join(root, filepath.FromSlash(dir))] = true
		}
	}
	for _, dir := range sortedKeys(contextDirs) {
		relative, err := relativeSource(root, dir)
		if err != nil {
			return nil, err
		}
		info, err := l.stat(dir)
		if errors.Is(err, fs.ErrNotExist) {
			p.directories[relative] = "missing"
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("inspect context %s: %w", dir, err)
		}
		p.directories[relative] = "directory"
		if !info.IsDir() {
			p.directories[relative] = "non-directory"
		}
		if err := l.directory(dir, false); err != nil {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if opts.IncludeAnalysis {
		p.Dependencies = dependencyRecord(p, rules)
	}
	return p, nil
}

// preflightGitControls checks the actual common administrative directory, which
// may belong to the enclosing repository or a linked worktree's main repository.
// No administrative content or hash is exported as a SourceRoot dependency.
func preflightGitControls(ctx context.Context, root, gitRoot string) error {
	if _, err := ownedSourcePath(gitRoot, filepath.Join(gitRoot, ".git")); errors.Is(err, errOutsideRoot) {
		return err
	}
	marker := filepath.Join(gitRoot, ".git")
	if info, err := os.Stat(marker); err == nil && info.Mode().IsRegular() {
		// Git canonicalizes gitdir pointers before reporting --git-common-dir.
		// Admit the declared pointer first, retaining its original owner.
		name, err := ownedSourcePath(gitRoot, marker)
		if err != nil {
			return err
		}
		files, err := os.OpenRoot(gitRoot)
		if err != nil {
			return err
		}
		data, readErr := files.ReadFile(filepath.FromSlash(name))
		closeErr := files.Close()
		if err := errors.Join(readErr, closeErr); err != nil {
			return fmt.Errorf("read Git administrative pointer: %w", err)
		}
		if pointer, ok := strings.CutPrefix(strings.TrimRight(string(data), "\r\n"), "gitdir: "); ok {
			pointer = filepath.FromSlash(pointer)
			if !filepath.IsAbs(pointer) {
				pointer = filepath.Join(gitRoot, pointer)
			}
			owner, err := gitAdministrativeOwner(gitRoot, filepath.Clean(pointer))
			if err != nil {
				return err
			}
			if _, err := ownedSourcePath(owner, pointer); err != nil {
				return fmt.Errorf("admit Git administrative pointer: %w", err)
			}
		}
	}
	cmd := exec.CommandContext(ctx, "git", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	output, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("locate Git discovery controls in %s: %w", root, err)
	}
	common := filepath.Clean(strings.TrimSuffix(string(output), "\n"))
	owner, err := gitAdministrativeOwner(gitRoot, common)
	if err != nil {
		return err
	}
	if _, err := ownedSourcePath(owner, common); err != nil {
		return fmt.Errorf("admit Git administrative directory: %w", err)
	}
	if _, err := ownedSourcePath(owner, filepath.Join(common, "info", "exclude")); errors.Is(err, errOutsideRoot) {
		return err
	}
	return nil
}

// gitAdministrativeOwner binds lexical administration to an independent owner.
// Conventional .git paths belong to their enclosing repository. A separately
// declared administrative root owns only itself, without resolving its aliases.
func gitAdministrativeOwner(gitRoot, administrative string) (string, error) {
	if _, err := relativeSource(gitRoot, administrative); err == nil {
		return gitRoot, nil
	}
	for current := administrative; ; current = filepath.Dir(current) {
		if filepath.Base(current) == ".git" {
			return canonicalDirectory(filepath.Dir(current))
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	// Normalize only the shared ancestor, which is independent of the separate
	// administration path. Resolving its parent could already cross an escaped
	// root alias in a linked worktree's declared gitdir path.
	ancestor := gitRoot
	for {
		if _, err := relativeSource(ancestor, administrative); err == nil {
			break
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			// Different volumes have no shared ancestor. Retain the declared
			// lexical root rather than granting its resolved target authority.
			return administrative, nil
		}
		ancestor = parent
	}
	canonical, err := canonicalDirectory(ancestor)
	if err != nil {
		return "", fmt.Errorf("resolve Git administrative owner: %w", err)
	}
	relative, err := filepath.Rel(ancestor, administrative)
	if err != nil {
		return "", err
	}
	return filepath.Join(canonical, relative), nil
}

type sourceLoader struct {
	files     *os.Root
	explain   bool
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
	if !supportedSource(relative) || (selected && isTemplate(relative) && !l.explain) {
		return fmt.Errorf("unsupported source target %s", absolute)
	}
	s := l.project.Sources[relative]
	if s == nil {
		s, err = l.readSource(absolute, relative)
		if err != nil {
			return err
		}
		l.project.Sources[relative] = s
		l.project.Diagnostics = append(l.project.Diagnostics, s.parseDiagnostics...)
	}
	if selected {
		l.project.discoverable[relative] = l.directoryWouldSelect(absolute, s)
		l.project.Selected[relative] = true
	}
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
		var err error
		data, err = l.readFile(absolute)
		if err != nil {
			return nil, err
		}
	}
	s, _ := parseOwnedSource(relative, data)
	return s, nil
}

var errOutsideRoot = errors.New("outside root")

// ownedSourcePath admits the resolved identity before any content read. Keep
// the original lexical identity in Source.Path for fix and dependency callers.
func ownedSourcePath(root, absolute string) (string, error) {
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		// A missing leaf still needs its existing parent checked. This prevents
		// an escaped directory from masquerading as an owned negative lookup.
		parent, parentErr := canonicalDirectory(filepath.Dir(absolute))
		if parentErr == nil {
			if _, boundaryErr := relativeSource(root, parent); boundaryErr != nil {
				return "", boundaryErr
			}
		}
		return "", fmt.Errorf("resolve source %s: %w", absolute, err)
	}
	return relativeSource(root, resolved)
}

func (l *sourceLoader) stat(absolute string) (os.FileInfo, error) {
	name, err := ownedSourcePath(l.project.Root, absolute)
	if err != nil {
		return nil, err
	}
	return l.files.Stat(filepath.FromSlash(name))
}

func (l *sourceLoader) readFile(absolute string) ([]byte, error) {
	name, err := ownedSourcePath(l.project.Root, absolute)
	if err != nil {
		return nil, err
	}
	name = filepath.FromSlash(name)
	info, err := l.files.Stat(name)
	if err != nil {
		return nil, fmt.Errorf("inspect source %s: %w", absolute, err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("source is not a regular file: %s", absolute)
	}
	// Root confines the actual read even if a resolved parent is replaced
	// after admission. This is an observation, not atomic result acceptance.
	data, err := l.files.ReadFile(name)
	if err != nil {
		return nil, fmt.Errorf("read source %s: %w", absolute, err)
	}
	return data, nil
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
			if _, err := l.stat(absolute); errors.Is(err, fs.ErrNotExist) {
				return nil, nil
			} else if err != nil {
				if errors.Is(err, errOutsideRoot) {
					return nil, err
				}
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
		if !directoryAdmitsSource(source, selected) {
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

// SourceIdentity is the canonical root and root-relative slash path for one
// explicitly named YAML source. Resolving identity may inspect path ancestors
// and project markers, but never scans source files or invokes Git.
type SourceIdentity struct {
	Root string
	Path string
}

// ResolveSourceIdentity applies the same root, path, source-kind and symlink
// boundaries as Load without reading the named source or discovering context.
func ResolveSourceIdentity(root, filename string) (SourceIdentity, error) {
	resolvedRoot, err := sourceRoot(Options{Root: root, StdinFilename: filename})
	if err != nil {
		return SourceIdentity{}, err
	}
	absolute, err := absoluteTarget(filename)
	if err != nil {
		return SourceIdentity{}, err
	}
	relative, err := relativeSource(resolvedRoot, absolute)
	if err != nil {
		return SourceIdentity{}, err
	}
	if !supportedSource(relative) || isTemplate(relative) {
		return SourceIdentity{}, fmt.Errorf("unsupported source target %s", absolute)
	}
	return SourceIdentity{Root: resolvedRoot, Path: relative}, nil
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
		return "", fmt.Errorf("source %s is %w %s", absolute, errOutsideRoot, root)
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
	name, _, err := inspectProjectIdentity(root)
	return name, err
}

// Capture marker type and priority in the same observation used for identity.
// Extra candidates are conservative dependencies; later errors cannot override
// an earlier valid marker or the original discovery error precedence.
func inspectProjectIdentity(root string) (string, []DependencyFile, error) {
	var name string
	var firstErr error
	observations := []DependencyFile{}
	for _, project := range []string{"saltbox", "sandbox"} {
		for _, ext := range []string{".yml", ".yaml"} {
			marker := project + ext
			state := "missing"
			info, err := os.Stat(filepath.Join(root, marker))
			if err == nil {
				state = "nonregular"
				if info.Mode().IsRegular() {
					state = "regular"
					if name == "" && firstErr == nil {
						name = project
					}
				}
			} else if !os.IsNotExist(err) {
				state = "unavailable"
				if name == "" && firstErr == nil {
					firstErr = fmt.Errorf("inspect project identity: %w", err)
				}
			}
			observations = append(observations, DependencyFile{Path: marker, State: state})
		}
	}
	return name, observations, firstErr
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

// directoryAdmitsSource completes candidate admission using parsed structure.
// Arbitrarily named root playbooks are admitted only when parsing identifies
// them as playbooks. Explicit selection does not apply this directory policy.
func directoryAdmitsSource(source *Source, selected bool) bool {
	if !directorySource(source.Path, selected) {
		return false
	}
	kind, _, _ := classify(source.Path)
	return !selected || kind != Generic || source.Kind == Playbook
}

// directoryWouldSelect combines shared parsed admission with the loader's Git
// snapshot and the file's existence, without reading another source/project.
func (l *sourceLoader) directoryWouldSelect(absolute string, source *Source) bool {
	if !directoryAdmitsSource(source, true) {
		return false
	}
	if l.gitFiles != nil {
		if _, exists := slices.BinarySearch(l.gitFiles, filepath.FromSlash(source.Path)); !exists {
			return false
		}
	}
	info, err := os.Stat(absolute)
	return err == nil && info.Mode().IsRegular()
}
