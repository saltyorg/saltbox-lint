package lint

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

// SelectionRecord describes a current-worktree observation, not an atomic Git
// or filesystem snapshot. Its version is independent of check JSON schema 2.
type SelectionRecord struct {
	SchemaVersion int              `json:"schema_version"`
	Commit        string           `json:"commit"`
	Changed       []string         `json:"changed"`
	Uncertain     []string         `json:"uncertain,omitempty"`
	Fallback      string           `json:"fallback,omitempty"`
	Sources       []SelectedSource `json:"sources"`
}
type SelectedSource struct {
	Path    string            `json:"path"`
	Reasons []SelectionReason `json:"reasons"`
}
type SelectionReason struct {
	Kind string `json:"kind"`
	Path string `json:"path"`
}

func changedGit(ctx context.Context, root string, args ...string) ([]byte, error) {
	argv := append([]string{"--no-optional-locks", "-C", root}, args...)
	output, err := exec.CommandContext(ctx, "git", argv...).Output()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, fmt.Errorf("read changed-worktree Git metadata: %w", err)
	}
	return output, nil
}

func loadChanged(ctx context.Context, opts Options) (*Project, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(opts.Paths) != 0 || opts.StdinFilename != "" || opts.StdinSourceFilename != "" || opts.Stdin != nil {
		return nil, fmt.Errorf("--changed-since cannot be combined with paths or stdin")
	}
	rootOpts := opts
	rootOpts.Paths = []string{"."}
	root, err := sourceRoot(rootOpts)
	if err != nil {
		return nil, err
	}
	gitRoot, err := enclosingGitRoot(root)
	if err != nil {
		return nil, err
	}
	if gitRoot == "" {
		return nil, fmt.Errorf("--changed-since requires a Git worktree")
	}
	// Preserve discovery's ownership admission before any Git metadata read.
	for _, name := range []string{".gitignore", ".git/info/exclude"} {
		if _, err := ownedSourcePath(root, filepath.Join(root, filepath.FromSlash(name))); errors.Is(err, errOutsideRoot) {
			return nil, err
		}
	}
	if err := preflightGitControls(ctx, root, gitRoot); err != nil {
		return nil, err
	}
	output, err := changedGit(ctx, root, "rev-parse", "--verify", "--end-of-options", opts.ChangedSince+"^{commit}")
	if err != nil {
		return nil, fmt.Errorf("resolve revision %q: %w", opts.ChangedSince, err)
	}
	commit := strings.TrimSuffix(string(output), "\n")
	if !validCommitID(commit) {
		return nil, fmt.Errorf("invalid resolved commit identity")
	}
	output, err = changedGit(ctx, root, "diff", "--relative", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", commit, "--", ".")
	if err != nil {
		return nil, err
	}
	changed := nulNames(output)
	output, err = changedGit(ctx, root, "ls-files", "-z", "--others", "--exclude-standard", "--", ".")
	if err != nil {
		return nil, err
	}
	changed = append(changed, nulNames(output)...)
	slices.Sort(changed)
	changed = slices.Compact(changed)
	output, err = changedGit(ctx, root, "ls-files", "-v", "-z", "--cached", "--", ".")
	if err != nil {
		return nil, err
	}
	uncertain := flaggedGitNames(output)
	// Read current bytes and the full current graph once. Deleted names are only
	// impact inputs; directory discovery never tries to load them as primaries.
	fullOpts := Options{Root: root, Paths: []string{root}, IncludeAnalysis: true, Statistics: opts.Statistics, allowEmpty: true}
	project, err := load(ctx, fullOpts)
	if err != nil {
		return nil, err
	}
	selection := affectedSelection(project, commit, changed, uncertain)
	project.Selected = map[string]bool{}
	for _, source := range selection.Sources {
		project.Selected[source.Path] = true
	}
	project.Selection = selection
	if opts.IncludeAnalysis {
		project.Dependencies = dependencyRecord(project, Rules())
		project.Dependencies.Selection = selection
	} else {
		project.Dependencies = nil
	}
	return project, nil
}

func validCommitID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, c := range value {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
func nulNames(output []byte) []string {
	names := []string{}
	for name := range strings.SplitSeq(string(output), "\x00") {
		if name != "" {
			names = append(names, filepath.ToSlash(filepath.Clean(filepath.FromSlash(name))))
		}
	}
	return names
}

// flaggedGitNames observes flags without clearing them or refreshing the index.
// Lowercase status letters mean assume-unchanged; S means skip-worktree. Diff
// cannot prove that these paths still have their committed worktree bytes.
func flaggedGitNames(output []byte) []string {
	names := []string{}
	for item := range strings.SplitSeq(string(output), "\x00") {
		if len(item) < 3 || item[1] != ' ' {
			continue
		}
		status := item[0]
		if status == 'S' || (status >= 'a' && status <= 'z') {
			names = append(names, filepath.ToSlash(filepath.Clean(filepath.FromSlash(item[2:]))))
		}
	}
	slices.Sort(names)
	return slices.Compact(names)
}

func affectedSelection(project *Project, commit string, changed, uncertain []string) *SelectionRecord {
	result := &SelectionRecord{SchemaVersion: 1, Commit: commit, Changed: changed, Uncertain: uncertain, Sources: []SelectedSource{}}
	candidates := append(slices.Clone(changed), uncertain...)
	slices.Sort(candidates)
	candidates = slices.Compact(candidates)
	// A disappeared context can have erased its earlier edges. A full current
	// selection is conservative without reading historical source bytes.
	for _, name := range candidates {
		if !directorySource(name, false) && !discoveryControl(name) && !projectMarker(name) {
			continue
		}
		if _, err := ownedSourcePath(project.Root, filepath.Join(project.Root, filepath.FromSlash(name))); errors.Is(err, fs.ErrNotExist) {
			result.Fallback = "missing context may have erased earlier dependencies; select all current primary sources"
		}
	}
	for _, source := range project.Dependencies.Sources {
		selected := SelectedSource{Path: source.Path, Reasons: []SelectionReason{}}
		for _, name := range candidates {
			kind := ""
			switch {
			case source.Path == name:
				kind = "changed-primary"
			case discoveryControl(name):
				kind = "discovery-policy"
			case slices.ContainsFunc(source.Files, func(file DependencyFile) bool { return file.Path == name }):
				kind = "dependency-file"
			case slices.ContainsFunc(source.Identity, func(file DependencyFile) bool { return file.Path == name }):
				kind = "project-identity"
			case slices.ContainsFunc(source.Directories, func(dir DependencyDirectory) bool { return name == dir.Path || strings.HasPrefix(name, dir.Path+"/") }):
				kind = "dependency-scope"
			}
			if kind != "" {
				if !slices.Contains(changed, name) {
					kind = "git-index-flag"
				}
				selected.Reasons = append(selected.Reasons, SelectionReason{Kind: kind, Path: name})
			}
		}
		if result.Fallback != "" {
			selected.Reasons = append(selected.Reasons, SelectionReason{Kind: "conservative-fallback"})
		}
		if len(selected.Reasons) != 0 {
			result.Sources = append(result.Sources, selected)
		}
	}
	return result
}
func discoveryControl(name string) bool {
	return path.Base(name) == ".gitignore" || name == ".git/info/exclude"
}
func projectMarker(name string) bool {
	return slices.Contains([]string{"saltbox.yml", "saltbox.yaml", "sandbox.yml", "sandbox.yaml"}, name)
}
