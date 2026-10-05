package lint

import (
	"fmt"
	"os"
	"path/filepath"
)

// validate compares current ownership with the actual opened read. A matching
// inode alone is insufficient: a moved YAML file may now belong to templates.
func (identity *sourceDiskIdentity) validate(rootPath string, root *os.Root, name string, writable bool) error {
	if identity == nil {
		return fmt.Errorf("source has no admitted disk identity: %s", name)
	}
	canonicalRoot, err := filepath.EvalSymlinks(rootPath)
	if err != nil || canonicalRoot != filepath.Clean(rootPath) {
		return fmt.Errorf("source root owner changed since analysis: %s", name)
	}
	absolute := filepath.Join(rootPath, filepath.FromSlash(name))
	owner, err := ownedSourcePath(rootPath, absolute)
	if err != nil {
		return err
	}
	if owner != identity.path {
		return fmt.Errorf("source owner changed since analysis: %s", name)
	}
	if writable && (isTemplate(absolute) || isTemplate(filepath.Join(rootPath, filepath.FromSlash(owner)))) {
		return fmt.Errorf("refuse source writes: selected template %s is read-only", name)
	}
	currentRoot, err := os.Stat(rootPath)
	if err != nil || !os.SameFile(identity.root, currentRoot) {
		return fmt.Errorf("source root changed since analysis: %s", name)
	}
	openedRoot, err := root.Stat(".")
	if err != nil || !os.SameFile(identity.root, openedRoot) {
		return fmt.Errorf("opened source root changed since analysis: %s", name)
	}
	parent, err := root.Stat(filepath.Dir(filepath.FromSlash(owner)))
	if err != nil || !os.SameFile(identity.parent, parent) {
		return fmt.Errorf("source parent changed since analysis: %s", name)
	}
	info, err := root.Lstat(filepath.FromSlash(name))
	if err != nil || writable && !info.Mode().IsRegular() {
		return fmt.Errorf("refuse non-regular or symlink file %s", name)
	}
	current, err := root.Stat(filepath.FromSlash(owner))
	if err != nil || !current.Mode().IsRegular() || !os.SameFile(identity.file, current) {
		return fmt.Errorf("file identity changed since analysis: %s", name)
	}
	if writable && current.Mode() != identity.file.Mode() {
		return fmt.Errorf("file mode changed since analysis: %s", name)
	}
	return nil
}
