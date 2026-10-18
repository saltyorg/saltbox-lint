package lint

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

// SourceExclusion observes the saved configuration and Git policy for one
// source without parsing it or reading its role context. A nonempty reason
// declines all checking, navigation and edit planning for that source.
func SourceExclusion(ctx context.Context, identity SourceIdentity) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	files, err := os.OpenRoot(identity.Root)
	if err != nil {
		return "", err
	}
	defer func() { _ = files.Close() }()
	project := &Project{Root: identity.Root}
	loader := sourceLoader{ctx: ctx, files: files, project: project}
	project.configuration, err = loader.loadConfiguration()
	if err != nil {
		return "", err
	}
	loader.gitRoot, err = enclosingGitRoot(identity.Root)
	if err != nil {
		return "", err
	}
	if loader.gitRoot != "" {
		for _, name := range []string{".gitignore", ".git/info/exclude"} {
			if _, err := ownedSourcePath(identity.Root, filepath.Join(identity.Root, filepath.FromSlash(name))); errors.Is(err, errOutsideRoot) {
				return "", err
			}
		}
		if err := preflightGitControls(ctx, identity.Root, loader.gitRoot); err != nil {
			return "", err
		}
	}
	absolute := filepath.Join(identity.Root, filepath.FromSlash(identity.Path))
	reasons, err := loader.exclusionReasons([]string{absolute})
	return reasons[absolute], err
}

// Exclusion matching is batched before parallel reads. Git owns ignore syntax,
// nested negations and administrative policy; --no-index applies it to tracked
// files too. NUL records preserve spaces, newlines and option-like filenames.
func (l *sourceLoader) exclusionReasons(paths []string) (map[string]string, error) {
	reasons := map[string]string{}
	defer func() {
		for absolute := range reasons {
			if l.project.excluded == nil {
				l.project.excluded = map[string]bool{}
			}
			name, _ := relativeSource(l.project.Root, absolute)
			l.project.excluded[name] = true
		}
	}()
	names := map[string][]string{}
	for _, absolute := range paths {
		if err := l.ctx.Err(); err != nil {
			return nil, err
		}
		relative, err := relativeSource(l.project.Root, absolute)
		if err != nil {
			return nil, err
		}
		if l.project.configuration.excludes(relative) {
			reasons[absolute] = "excluded by .saltbox-lint exclude_paths"
			continue
		}
		owner, err := ownedSourcePath(l.project.Root, absolute)
		// Only the lexical alias is eligible for Git matching when its owner
		// escapes the root. An unignored alias still fails ordinary admission;
		// an ignored directory candidate never reads that foreign owner.
		if err == nil && l.project.configuration.excludes(owner) {
			reasons[absolute] = "excluded by .saltbox-lint exclude_paths"
			continue
		}
		// Git refuses paths beyond a directory symlink. Evaluate the physical
		// owner in that case; file aliases can still test both leaf names.
		parent, parentErr := canonicalDirectory(filepath.Dir(absolute))
		if parentErr != nil || parent == filepath.Dir(absolute) {
			names[relative] = append(names[relative], absolute)
		}
		if err == nil && (owner != relative || parent != filepath.Dir(absolute)) {
			names[owner] = append(names[owner], absolute)
		}
	}
	if l.gitRoot == "" || len(names) == 0 {
		return reasons, nil
	}
	var pending []string
	for _, name := range sortedKeys(names) {
		if _, checked := l.gitIgnores[name]; !checked {
			pending = append(pending, name)
		}
	}
	if len(pending) > 0 {
		cmd := exec.CommandContext(l.ctx, "git", "--no-optional-locks", "-C", l.project.Root, "check-ignore", "--no-index", "-z", "--stdin")
		cmd.Stdin = strings.NewReader(strings.Join(pending, "\x00") + "\x00")
		output, err := cmd.Output()
		if l.ctx.Err() != nil {
			return nil, l.ctx.Err()
		}
		var exit *exec.ExitError
		if err != nil && (!errors.As(err, &exit) || exit.ExitCode() != 1) {
			return nil, fmt.Errorf("read Git ignore policy in %s: %w", l.project.Root, err)
		}
		if l.gitIgnores == nil {
			l.gitIgnores = map[string]bool{}
		}
		for _, name := range pending {
			l.gitIgnores[name] = false
		}
		for name := range strings.SplitSeq(string(output), "\x00") {
			if name == "" {
				continue
			}
			if _, requested := slices.BinarySearch(pending, name); !requested {
				return nil, fmt.Errorf("git ignore policy returned an unrequested source")
			}
			l.gitIgnores[name] = true
		}
	}
	for name, paths := range names {
		if l.gitIgnores[name] {
			for _, absolute := range paths {
				reasons[absolute] = "excluded by Git ignore rules"
			}
		}
	}
	return reasons, nil
}
