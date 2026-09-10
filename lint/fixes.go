package lint

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// PlanFixes combines selected, nonconflicting edits and independently verifies
// their YAML and Jinja preservation. Uncertain candidates are declined; the
// caller retains the original diagnostics and hints.
func PlanFixes(project *Project, diagnostics []Diagnostic) ([]Change, error) {
	if project == nil {
		return nil, nil
	}
	grouped := map[string][]Edit{}
	for _, d := range diagnostics {
		if project.Selected[d.Path] && d.Fix != nil {
			grouped[d.Path] = append(grouped[d.Path], d.Fix.Edits...)
		}
	}
	paths := make([]string, 0, len(grouped))
	for path := range grouped {
		paths = append(paths, path)
	}
	slices.Sort(paths)
	var changes []Change
	for _, path := range paths {
		source := project.Sources[path]
		if source == nil {
			return nil, fmt.Errorf("fix source %q is unavailable", path)
		}
		edits, err := orderedEdits(grouped[path])
		if err != nil {
			return nil, fmt.Errorf("plan fixes for %s: %w", path, err)
		}
		valid := true
		for _, e := range edits {
			if e.Span.Start < 0 || e.Span.End < e.Span.Start || e.Span.End > len(source.Data) || !allowedWhitespace(source, e) {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		after := applyEdits(source.Data, edits)
		if bytes.Equal(source.Data, after) || !verifiedCandidate(source, after) {
			continue
		}
		candidate, _ := Parse(path, after)
		_, remaining := layoutFindings(candidate)
		if len(remaining) > 0 {
			continue
		}
		changes = append(changes, Change{Path: path, Before: bytes.Clone(source.Data), After: after})
	}
	return changes, nil
}
func allowedWhitespace(s *Source, e Edit) bool {
	for _, v := range []string{string(s.Data[e.Span.Start:e.Span.End]), e.Text} {
		for i := range len(v) {
			if !space(v[i]) {
				return false
			}
		}
	}
	for _, gap := range sectionGaps(s) {
		if e == gap.Edit {
			return true
		}
	}
	for _, expr := range Expressions(s) {
		if !expr.Complete || !expr.mapped || expr.Kind != "output" || !layoutSupported(expr) {
			continue
		}
		if e.Span.Start >= expr.opening.End && e.Span.End <= expr.closing.Start {
			intersects := false
			for _, t := range expr.Tokens {
				if e.Span.Start < t.Span.End && e.Span.End > t.Span.Start || e.Span.Start == e.Span.End && e.Span.Start > t.Span.Start && e.Span.Start < t.Span.End {
					intersects = true
					break
				}
			}
			if !intersects {
				return true
			}
		}
		if block, _ := pureBlock(s, expr); block && e.Span.End <= expr.Span.Start {
			start := bytes.LastIndexByte(s.Data[:expr.Span.Start], '\n') + 1
			if e.Span.Start >= start {
				return true
			}
		}
	}
	return false
}
func verifiedCandidate(before *Source, after []byte) bool {
	candidate, ds := Parse(before.Path, after)
	if len(ds) > 0 || len(before.parseDiagnostics) > 0 || len(candidate.Documents) != len(before.Documents) {
		return false
	}
	edits, ok := whitespaceChanges(before.Data, after)
	if !ok {
		return false
	}
	for _, e := range edits {
		if !allowedWhitespace(before, e) {
			return false
		}
	}
	for i, n := range before.Documents {
		if !equivalentNode(n, candidate.Documents[i]) {
			return false
		}
	}
	return true
}
func equivalentNode(a, b *Node) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.Kind != b.Kind || a.Style != b.Style || a.Tag != b.Tag || a.Anchor != b.Anchor || len(a.Entries) != len(b.Entries) || len(a.Items) != len(b.Items) {
		return false
	}
	if a.Kind == "string" && a.Tag != "!unsafe" {
		if scalarSignature(a.Value) != scalarSignature(b.Value) {
			return false
		}
	} else if a.Value != b.Value {
		return false
	}
	for i, e := range a.Entries {
		if !equivalentNode(e.Key, b.Entries[i].Key) || !equivalentNode(e.Value, b.Entries[i].Value) {
			return false
		}
	}
	for i, n := range a.Items {
		if !equivalentNode(n, b.Items[i]) {
			return false
		}
	}
	return true
}

// Signatures preserve exact decoded string tokens, control delimiters and all
// literal segments, including comments/raw text. Only live expression whitespace
// outside tokens is omitted.
func scalarSignature(value string) string {
	var out strings.Builder
	pos := 0
	for _, e := range scanExpressions(value) {
		if !e.Complete {
			continue
		}
		out.WriteString(strconv.Quote(value[pos:e.Span.Start]))
		out.WriteByte('|')
		opening := value[e.opening.Start:e.opening.End]
		closing := value[e.closing.Start:e.closing.End]
		out.WriteString(opening)
		for _, t := range e.Tokens {
			out.WriteString(t.Kind)
			out.WriteByte(':')
			out.WriteString(strconv.Quote(t.Text))
			out.WriteByte('|')
		}
		out.WriteString(closing)
		pos = e.Span.End
	}
	out.WriteString(strconv.Quote(value[pos:]))
	return out.String()
}

// WriteChanges verifies original contents and safe candidates again, rejects file
// symlinks, preserves modes and replaces each file atomically. A batch is fully
// preflighted, but replacement atomicity is per file rather than transactional.
func WriteChanges(project *Project, changes []Change) error {
	if len(changes) == 0 {
		return nil
	}
	if project == nil {
		return fmt.Errorf("write changes: project is required")
	}
	type pending struct {
		path   string
		change Change
		info   os.FileInfo
	}
	var files []pending
	seen := map[string]bool{}
	root, err := os.OpenRoot(project.Root)
	if err != nil {
		return fmt.Errorf("open project root: %w", err)
	}
	defer func() { _ = root.Close() }()
	for _, change := range changes {
		clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(change.Path)))
		if clean != change.Path || filepath.IsAbs(change.Path) || clean == ".." || strings.HasPrefix(clean, "../") || !project.Selected[change.Path] || seen[change.Path] {
			return fmt.Errorf("refuse unselected or invalid fix path %q", change.Path)
		}
		seen[change.Path] = true
		s := project.Sources[change.Path]
		if s == nil || !bytes.Equal(change.Before, s.Data) || !verifiedCandidate(s, change.After) {
			return fmt.Errorf("refuse unverified changes for %s", change.Path)
		}
		candidate, _ := Parse(change.Path, change.After)
		if _, edits := layoutFindings(candidate); len(edits) > 0 {
			return fmt.Errorf("incomplete layout correction for %s", change.Path)
		}
		info, err := root.Lstat(change.Path)
		if err != nil {
			return fmt.Errorf("inspect %s: %w", change.Path, err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("refuse non-regular or symlink file %s", change.Path)
		}
		actual, err := root.ReadFile(change.Path)
		if err != nil {
			return fmt.Errorf("read %s: %w", change.Path, err)
		}
		if !bytes.Equal(actual, change.Before) {
			return fmt.Errorf("file changed since analysis: %s", change.Path)
		}
		files = append(files, pending{change.Path, change, info})
	}
	for _, f := range files {
		if err := replaceFile(root, f.path, f.change, f.info); err != nil {
			return err
		}
	}
	return nil
}
func replaceFile(root *os.Root, path string, change Change, info os.FileInfo) error {
	// CreateTemp is rooted in the canonical parent directory; Root operations fence
	// destination traversal even if a parent symlink changes after discovery.
	parent := filepath.Dir(path)
	dir, err := root.OpenRoot(parent)
	if err != nil {
		return fmt.Errorf("open parent of %s: %w", path, err)
	}
	defer func() { _ = dir.Close() }()
	base := filepath.Base(path)
	current, err := dir.Lstat(base)
	if err != nil || !os.SameFile(info, current) || !current.Mode().IsRegular() {
		return fmt.Errorf("file identity changed before write: %s", path)
	}
	actual, err := dir.ReadFile(base)
	if err != nil || !bytes.Equal(actual, change.Before) {
		return fmt.Errorf("file contents changed before write: %s", path)
	}
	// OpenFile with O_EXCL creates a private sibling without following symlinks.
	var temp *os.File
	var name string
	for range 100 {
		name = ".saltbox-lint-" + rand.Text()
		temp, err = dir.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			break
		}
		if !os.IsExist(err) {
			return fmt.Errorf("create replacement for %s: %w", path, err)
		}
	}
	if temp == nil {
		return fmt.Errorf("create replacement for %s: %w", path, err)
	}
	// Best-effort cleanup: a successful rename already removed this name.
	defer func() { _ = dir.Remove(name) }()
	if _, err = temp.Write(change.After); err == nil {
		err = temp.Chmod(info.Mode())
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("prepare replacement for %s: %w", path, err)
	}
	current, err = dir.Lstat(base)
	if err != nil || !os.SameFile(info, current) || !current.Mode().IsRegular() {
		return fmt.Errorf("file identity changed before replacement: %s", path)
	}
	actual, err = dir.ReadFile(base)
	if err != nil || !bytes.Equal(actual, change.Before) {
		return fmt.Errorf("file contents changed before replacement: %s", path)
	}
	if err = dir.Rename(name, base); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return nil
}
