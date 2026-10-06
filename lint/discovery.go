package lint

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"iter"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Load reads worktree bytes for selected files and their conventional context.
// Explicit files override Git ignores; directory selections use Git's tracked
// and nonignored untracked files. No repository or source files are changed.
func Load(ctx context.Context, opts Options) (*Project, error) {
	if opts.ChangedSince != "" {
		return loadChanged(ctx, opts)
	}
	return load(ctx, opts)
}

func load(ctx context.Context, opts Options) (*Project, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(opts.Paths) == 0 && opts.StdinFilename == "" {
		return nil, fmt.Errorf("no source targets selected")
	}
	if (opts.Stdin != nil || opts.StdinSourceFilename != "") && opts.StdinFilename == "" {
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
	l := sourceLoader{ctx: ctx, project: p, files: files, statistics: opts.Statistics, templateSpellings: map[string][]string{}}
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
		l.stdinCanonicalPath, err = l.stdinIdentity()
		if err != nil {
			return nil, err
		}
		l.stdinTemplate = isTemplateFile(opts.StdinFilename) || isTemplateFile(l.stdinPath)
		if l.stdinTemplate {
			l.rememberTemplateSpelling(opts.StdinFilename, l.stdinPath)
		}
		if opts.StdinSourceFilename != "" {
			l.stdinSourcePath, err = filepath.Abs(opts.StdinSourceFilename)
			if err != nil {
				return nil, err
			}
			if err := l.validateStdinSource(); err != nil {
				return nil, err
			}
			l.stdinTemplate = l.stdinTemplate || isTemplateFile(l.stdinSourcePath)
			if l.stdinTemplate {
				l.rememberTemplateSpelling(opts.StdinSourceFilename, l.stdinPath)
			}
		}
	}
	targets := slices.Clone(opts.Paths)
	if opts.StdinFilename != "" {
		targets = append(targets, opts.StdinFilename)
	}
	// Capture explicit file capability before directory discovery can admit the
	// same canonical path as YAML. Canonical identity never grants write rights
	// that were absent from the caller's original template spelling.
	for _, target := range opts.Paths {
		absolute, err := absoluteTarget(target)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(absolute)
		if err == nil && !info.IsDir() && isTemplateFile(target) {
			if _, err := ownedSourcePath(root, absolute); err != nil {
				return nil, err
			}
			l.rememberTemplateSpelling(target, absolute)
		}
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
		spelling, err := admitSelectionSpelling(root, target)
		if err != nil {
			return nil, err
		}
		owner, err := ownedSourcePath(root, absolute)
		if err != nil {
			return nil, err
		}
		if owner != spelling.owner {
			return nil, fmt.Errorf("selected spelling owner changed during admission: %s", target)
		}
		if info.IsDir() {
			// A conventional template directory remains excluded from primary
			// discovery even when its parent spelling aliases a YAML directory.
			if !isTemplate(filepath.Join(target, "source")) {
				p.selectionSpellings = append(p.selectionSpellings, spelling)
				err = l.directory(absolute, true)
			}
		} else {
			p.selectionSpellings = append(p.selectionSpellings, spelling)
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
	// Owning task configuration must be admitted before template text can
	// identify cross-role reference context. Literal default tags under a task
	// override cannot authorize extra role reads.
	if err := l.contextDirectories(contextDirs); err != nil {
		return nil, err
	}
	if opts.referenceContext {
		p.referenceDirectories = referenceContextDirectories(p)
		p.referenceFiles = []string{"inventory.yaml", "inventory.yml", "vars.yaml", "vars.yml"}
		for _, name := range p.referenceFiles {
			absolute := filepath.Join(root, name)
			if _, err := l.stat(absolute); errors.Is(err, fs.ErrNotExist) {
				continue
			} else if err != nil {
				return nil, fmt.Errorf("inspect reference context %s: %w", name, err)
			}
			if err := l.add(absolute, false); err != nil {
				return nil, err
			}
		}
		for _, dirs := range p.referenceDirectories {
			for _, dir := range dirs {
				contextDirs[filepath.Join(root, filepath.FromSlash(dir))] = true
			}
		}
	}
	if err := l.contextDirectories(contextDirs); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if opts.IncludeAnalysis {
		p.Dependencies = dependencyRecord(p, rules)
	}
	return p, nil
}

func (l *sourceLoader) contextDirectories(contextDirs map[string]bool) error {
	p, root := l.project, l.project.Root
	for _, dir := range sortedKeys(contextDirs) {
		relative, err := relativeSource(root, dir)
		if err != nil {
			return err
		}
		if _, observed := p.directories[relative]; observed {
			continue
		}
		info, err := l.stat(dir)
		if errors.Is(err, fs.ErrNotExist) {
			p.directories[relative] = "missing"
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect context %s: %w", dir, err)
		}
		p.directories[relative] = "directory"
		if !info.IsDir() {
			p.directories[relative] = "non-directory"
		}
		if err := l.directory(dir, false); err != nil {
			return err
		}
	}
	return l.ctx.Err()
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
	statistics         *LoadStatistics
	files              *os.Root
	ctx                context.Context
	project            *Project
	gitFiles           []string
	stdinPath          string
	stdinSourcePath    string
	stdin              []byte
	stdinCanonicalPath string
	stdinTemplate      bool
	templateSpellings  map[string][]string
}

func (l *sourceLoader) rememberTemplateSpelling(filename, absolute string) {
	// Only lexical owners inside the admitted root can contribute context.
	// An outside spelling may prove read-only capability, never outside reads.
	spelling, _ := filepath.Abs(filename)
	name, err := relativeSource(l.project.Root, spelling)
	if err != nil {
		name = ""
		// The caller may name the admitted root through a directory alias
		// (including /tmp on Darwin). Resolve only the root ancestor, keeping
		// every spelling below it: a leaf alias can have a different role owner.
		for ancestor := filepath.Dir(spelling); ; ancestor = filepath.Dir(ancestor) {
			if resolved, resolveErr := resolveSourcePath(ancestor); resolveErr == nil && resolved == l.project.Root {
				name, _ = relativeSource(ancestor, spelling)
				break
			}
			if filepath.Dir(ancestor) == ancestor {
				break
			}
		}
	}
	l.templateSpellings[absolute] = append(l.templateSpellings[absolute], name)
}

// validateStdinSource admits an original spelling solely for classification.
// Its resolved owner must equal the snapshot owner; missing or escaped aliases
// never supply a fallback source kind or authorize a read outside the root.
func (l *sourceLoader) validateStdinSource() error {
	canonical, err := ownedSourcePath(l.project.Root, l.stdinSourcePath)
	if err != nil {
		return err
	}
	if canonical != l.stdinCanonicalPath {
		return fmt.Errorf("stdin source spelling changed owner")
	}
	return nil
}

func (l *sourceLoader) stdinIdentity() (string, error) {
	canonical, err := ownedSourcePath(l.project.Root, l.stdinPath)
	if !errors.Is(err, fs.ErrNotExist) {
		return canonical, err
	}
	// New unsaved files have a logical identity. An existing dangling alias
	// has no admitted target and cannot supply canonical ownership.
	relative, relativeErr := relativeSource(l.project.Root, l.stdinPath)
	if relativeErr != nil {
		return "", relativeErr
	}
	if _, statErr := l.files.Lstat(filepath.FromSlash(relative)); statErr == nil {
		// Only an absent leaf can supply a new logical buffer identity. On
		// Windows a dangling junction is ModeIrregular, not ModeSymlink.
		return "", err
	} else if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return "", statErr
	}
	return relative, nil
}

func (l *sourceLoader) add(absolute string, selected bool) error {
	if err := l.ctx.Err(); err != nil {
		return err
	}
	relative, err := relativeSource(l.project.Root, absolute)
	if err != nil {
		return err
	}
	if !supportedSource(relative) && !isTemplateFile(absolute) && len(l.templateSpellings[absolute]) == 0 {
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
	var canonical string
	var diskIdentity *sourceDiskIdentity
	var err error
	if absolute == l.stdinPath {
		data = bytes.Clone(l.stdin)
		canonical, err = l.stdinIdentity()
		if err == nil && canonical != l.stdinCanonicalPath {
			err = fmt.Errorf("source identity changed for %s", absolute)
		}
	} else {
		data, canonical, diskIdentity, err = l.readFileSnapshot(absolute)
	}
	if err != nil {
		return nil, err
	}
	if absolute != l.stdinPath && l.stdinTemplate && canonical == l.stdinCanonicalPath && (l.stdinSourcePath != "" || isTemplate(relative) || isTemplate(canonical) || isTemplateFile(absolute)) {
		// One template buffer supplies all admitted spellings of that output.
		// This is invocation-local and never overlays unrelated equal contents.
		data = bytes.Clone(l.stdin)
		diskIdentity = nil
	}
	parseName := relative
	spellings := l.templateSpellings[absolute]
	if canonical == l.stdinCanonicalPath && l.stdinTemplate && l.stdinSourcePath != "" {
		spellings = append(slices.Clone(spellings), l.templateSpellings[l.stdinPath]...)
	}
	if len(spellings) > 0 {
		parseName = "source.j2"
	}
	if l.stdinSourcePath != "" && canonical == l.stdinCanonicalPath {
		if err := l.validateStdinSource(); err != nil {
			return nil, err
		}
		if l.stdinTemplate {
			parseName = "source.j2"
		}
	}
	if isTemplate(canonical) {
		parseName = canonical
	} else if !isTemplate(relative) && isTemplateFile(absolute) {
		// A narrowed root must not recover role context from outside the root.
		parseName = "source.j2"
	}
	var source *Source
	if l.statistics == nil {
		source, _ = parseOwnedSource(parseName, data)
	} else {
		start := time.Now()
		source, _ = parseOwnedSource(parseName, data)
		l.statistics.nanos.Add(int64(time.Since(start)))
		l.statistics.attempts.Add(1)
	}
	source.Path = relative
	source.diskIdentity = diskIdentity
	if source.Kind == Template {
		source.templateProject = l.project
		source.templatePath = canonical
		slices.Sort(spellings)
		source.templateSpellings = slices.Compact(spellings)
		_, source.Role, source.RolePath = classify(canonical)
	}
	return source, nil
}

func isTemplateFile(filename string) bool {
	if isTemplate(filename) {
		return true
	}
	resolved, err := resolveSourcePath(filename)
	return err == nil && isTemplate(resolved)
}

// IsTemplate retains read-only classification when the root is narrowed or
// an existing leaf aliases a conventional template. It never reads contents
// or widens the root and cannot establish outside-root role context.
func (identity SourceIdentity) IsTemplate() bool {
	return identity.template || isTemplate(identity.Path) || isTemplateFile(filepath.Join(identity.Root, filepath.FromSlash(identity.Path)))
}

var errOutsideRoot = errors.New("outside root")

// ownedSourcePath admits the resolved identity before any content read. Keep
// the original lexical identity in Source.Path for fix and dependency callers.
func ownedSourcePath(root, absolute string) (string, error) {
	resolved, err := resolveSourcePath(absolute)
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
	data, _, err := l.readFileIdentity(absolute)
	return data, err
}

func (l *sourceLoader) readFileIdentity(absolute string) ([]byte, string, error) {
	data, name, _, err := l.readFileSnapshot(absolute)
	return data, name, err
}

func (l *sourceLoader) readFileSnapshot(absolute string) ([]byte, string, *sourceDiskIdentity, error) {
	name, err := ownedSourcePath(l.project.Root, absolute)
	if err != nil {
		return nil, "", nil, err
	}
	dir, err := l.files.OpenRoot(filepath.Dir(filepath.FromSlash(name)))
	if err != nil {
		return nil, "", nil, fmt.Errorf("open source parent %s: %w", absolute, err)
	}
	defer func() { _ = dir.Close() }()
	entry, err := dir.Lstat(filepath.Base(name))
	if err != nil {
		return nil, "", nil, fmt.Errorf("inspect source %s: %w", absolute, err)
	}
	if !entry.Mode().IsRegular() {
		return nil, "", nil, fmt.Errorf("source is not a regular file: %s", absolute)
	}
	file, err := dir.Open(filepath.Base(name))
	if err != nil {
		return nil, "", nil, fmt.Errorf("open source %s: %w", absolute, err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, "", nil, fmt.Errorf("inspect source %s: %w", absolute, err)
	}
	if !info.Mode().IsRegular() || !os.SameFile(entry, info) {
		return nil, "", nil, fmt.Errorf("source is not a regular file: %s", absolute)
	}
	rootInfo, err := l.files.Stat(".")
	if err != nil {
		return nil, "", nil, err
	}
	parentInfo, err := dir.Stat(".")
	if err != nil {
		return nil, "", nil, err
	}
	// The bytes and identity come from the same opened file. These bounded
	// observations do not claim an atomic filesystem snapshot.
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, "", nil, fmt.Errorf("read source %s: %w", absolute, err)
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(info, after) || info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return nil, "", nil, fmt.Errorf("source changed while reading: %s", absolute)
	}
	identity := &sourceDiskIdentity{path: name, root: rootInfo, parent: parentInfo, file: info}
	if err := identity.validate(l.project.Root, l.files, name, false); err != nil {
		return nil, "", nil, err
	}
	return data, name, identity, nil
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
			if selected && source.Kind == Template {
				return nil, nil
			}
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
// explicitly named checkable source. Resolving identity may inspect path ancestors
// and project markers, but never scans source files or invokes Git.
type SourceIdentity struct {
	Root     string
	Path     string
	template bool
}

// ResolveSourceIdentity applies the same root, path, source-kind and symlink
// boundaries as Load without reading the named source or discovering context.
func ResolveSourceIdentity(root, filename string) (SourceIdentity, error) {
	return resolveSourceIdentity(root, filename, "")
}

func resolveSourceIdentity(root, filename, sourceFilename string) (SourceIdentity, error) {
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
	template := isTemplateFile(filename) || isTemplateFile(absolute)
	if sourceFilename != "" {
		original, err := filepath.Abs(sourceFilename)
		if err != nil {
			return SourceIdentity{}, err
		}
		owner, err := ownedSourcePath(resolvedRoot, original)
		if err != nil {
			return SourceIdentity{}, err
		}
		canonical, err := ownedSourcePath(resolvedRoot, absolute)
		if err != nil {
			return SourceIdentity{}, err
		}
		if owner != canonical {
			return SourceIdentity{}, fmt.Errorf("stdin source spelling changed owner")
		}
		template = template || isTemplateFile(original)
	}
	if !supportedSource(relative) && !template {
		return SourceIdentity{}, fmt.Errorf("unsupported source target %s", absolute)
	}
	return SourceIdentity{Root: resolvedRoot, Path: relative, template: template}, nil
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
		return resolveSourcePath(absolute)
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
	resolved, err := resolveSourcePath(dir)
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
		return resolveSourcePath(root)
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
			return resolveSourcePath(current)
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	return resolveSourcePath(dir)
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
	if selected && source.Kind == Template {
		return false
	}
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
