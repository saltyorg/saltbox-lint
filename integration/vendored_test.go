package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// Local module replacements carry offline provenance records. These checks
// verify the record scheme without network access:
//
//   - UPSTREAM-SHA256.json lists every copied upstream file and its original hash;
//   - upstream-module-ziphash.txt holds one Go module h1 checksum;
//   - every listed file that no longer has its upstream bytes is declared by a
//     FORMAT-CHANGES.json or COMPATIBILITY-CHANGES.json before/after record, or a
//     *.patch file;
//   - before/after records name the upstream and current bytes; and
//   - reverse-applying every patch for a file (in reverse lexical patch-name
//     order) to the vendored copy reproduces the recorded upstream bytes.
//
// A local provenance.lock.json with originalInputs (go-yaml) must also agree
// with those records and with the root go.mod requirement.
func TestVendoredReplacementRecords(t *testing.T) {
	replacements := localReplacements(t, "../go.mod")
	if len(replacements) == 0 {
		t.Fatal("go.mod has no local third_party replacements")
	}
	for _, r := range replacements {
		t.Run(r.dir, func(t *testing.T) {
			for _, err := range checkVendoredRecords(filepath.Join("..", filepath.FromSlash(r.dir)), r.module, r.version) {
				t.Error(err)
			}
		})
	}
}

func TestVendoredRecordCheckRejectsUnrecordedChanges(t *testing.T) {
	original := "package p\n\nfunc A() int { return 1 }\n\nfunc B() int { return 2 }\n"
	patched := "package p\n\nfunc A() int { return 10 }\n\nfunc B() int { return 2 }\n"
	formatted := "package p\n\nfunc A() int  { return 1 }\n\nfunc B() int { return 2 }\n"
	patch := "--- a/a.go\n+++ b/a.go\n@@ -1,3 +1,3 @@\n package p\n \n-func A() int { return 1 }\n+func A() int { return 10 }\n"
	hash := func(s string) string { return hexHash([]byte(s)) }
	type fixture struct {
		files map[string]string
	}
	base := func() fixture {
		upstream, _ := json.Marshal(map[string]string{"a.go": hash(original), "b.go": hash(original)})
		return fixture{files: map[string]string{
			"UPSTREAM-SHA256.json":        string(upstream),
			"upstream-module-ziphash.txt": "h1:" + base64.StdEncoding.EncodeToString(make([]byte, 32)) + "\n",
			"FORMAT-CHANGES.json":         "{}\n",
			"a.go":                        patched,
			"b.go":                        original,
			"local.patch":                 patch,
		}}
	}
	formatRecord := func(before, after string) string {
		return fmt.Sprintf(`{"tool":"gofmt","changes":"formatting only","files":{"b.go":{"before_sha256":%q,"after_sha256":%q}}}`, before, after)
	}
	corrected := strings.Replace(patched, "10", "20", 1)
	layer := func(f fixture, before, after, named string) {
		f.files["a.go"] = corrected
		f.files["z.patch"] = "--- a/a.go\n+++ b/a.go\n@@ -1,3 +1,3 @@\n package p\n \n-func A() int { return 10 }\n+func A() int { return 20 }\n"
		f.files["LOCAL-CORRECTIONS.json"] = fmt.Sprintf(`{"a.go":{"before":%q,"after":%q,"patch":%q,"reason":"layered fix"}}`, before, after, named)
	}
	cases := []struct {
		name   string
		mutate func(f fixture)
		want   string
	}{
		{"valid", func(fixture) {}, ""},
		{"unrecorded change", func(f fixture) { f.files["b.go"] = formatted }, "b.go differs from upstream without a change record"},
		{"recorded format change", func(f fixture) {
			f.files["b.go"] = formatted
			f.files["FORMAT-CHANGES.json"] = formatRecord(hash(original), hash(formatted))
		}, ""},
		{"stale format after hash", func(f fixture) {
			f.files["b.go"] = formatted
			f.files["FORMAT-CHANGES.json"] = formatRecord(hash(original), hash(original+" "))
		}, "after hash"},
		{"wrong format before hash", func(f fixture) {
			f.files["b.go"] = formatted
			f.files["FORMAT-CHANGES.json"] = formatRecord(hash(patched), hash(formatted))
		}, "before hash"},
		{"unknown format field", func(f fixture) { f.files["FORMAT-CHANGES.json"] = `{"other":1}` }, "unknown field"},
		{"patch no longer reverses", func(f fixture) {
			f.files["a.go"] = strings.Replace(patched, "10", "11", 1)
		}, "a.go: local.patch"},
		{"patch reverses to different bytes", func(f fixture) {
			f.files["UPSTREAM-SHA256.json"] = strings.Replace(f.files["UPSTREAM-SHA256.json"], hash(original), hash(patched), 1)
		}, "do not reproduce the upstream hash"},
		{"patch outside inventory", func(f fixture) {
			f.files["local.patch"] = strings.ReplaceAll(patch, "a.go", "c.go")
		}, "c.go is not an upstream file"},
		{"missing upstream file", func(f fixture) { delete(f.files, "b.go") }, "b.go"},
		{"malformed module checksum", func(f fixture) { f.files["upstream-module-ziphash.txt"] = "h1:abc=\n" }, "upstream-module-ziphash.txt"},
		{"layered local correction", func(f fixture) { layer(f, hash(patched), hash(corrected), "z.patch") }, ""},
		{"local correction before hash from upstream", func(f fixture) { layer(f, hash(original), hash(corrected), "z.patch") }, "differ from z.patch's"},
		{"local correction names another patch", func(f fixture) { layer(f, hash(patched), hash(corrected), "local.patch") }, "differ from local.patch's"},
		{"local correction names unknown patch", func(f fixture) { layer(f, hash(patched), hash(corrected), "y.patch") }, "a.go is not changed by y.patch"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := base()
			c.mutate(f)
			dir := t.TempDir()
			for name, content := range f.files {
				writeFile(t, filepath.Join(dir, name), []byte(content))
			}
			errs := checkVendoredRecords(dir, "", "")
			if c.want == "" {
				for _, err := range errs {
					t.Error(err)
				}
				return
			}
			if !strings.Contains(errors.Join(errs...).Error(), c.want) {
				t.Fatalf("want error containing %q, got %v", c.want, errs)
			}
		})
	}
}

func TestReversePatchHandlesInsertionsDeletionsAndMissingFinalNewline(t *testing.T) {
	original := "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\nlast"
	current := "zero\none\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\nlast\n"
	patch := strings.Join([]string{
		"--- a/f",
		"+++ b/f",
		"@@ -1,3 +1,3 @@",
		"+zero",
		" one",
		"-two",
		" three",
		"@@ -10,2 +10,2 @@",
		" ten",
		"-last",
		"\\ No newline at end of file",
		"+last",
		"",
	}, "\n")
	files, err := parsePatch([]byte(patch))
	if err != nil {
		t.Fatal(err)
	}
	got, err := reversePatch([]byte(current), files[0].hunks)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != original {
		t.Fatalf("reverse patch = %q, want %q", got, original)
	}
}

type replacement struct{ module, version, dir string }

func localReplacements(t *testing.T, path string) []replacement {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	required := map[string]string{}
	var out []replacement
	for line := range strings.SplitSeq(string(data), "\n") {
		fields := strings.Fields(strings.TrimPrefix(strings.TrimSpace(line), "require "))
		if len(fields) >= 2 && strings.HasPrefix(fields[1], "v") {
			required[fields[0]] = fields[1]
		}
		fields = strings.Fields(strings.TrimSpace(line))
		if len(fields) == 4 && fields[0] == "replace" && fields[2] == "=>" && strings.HasPrefix(fields[3], "./third_party/") {
			out = append(out, replacement{module: fields[1], dir: strings.TrimPrefix(fields[3], "./")})
		}
	}
	for i := range out {
		out[i].version = required[out[i].module]
		if out[i].version == "" {
			t.Fatalf("go.mod replaces %s without requiring a version", out[i].module)
		}
	}
	return out
}

var (
	sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	h1Pattern     = regexp.MustCompile(`^h1:[A-Za-z0-9+/]{43}=$`)
)

type changeRecord struct{ before, after string }

// checkVendoredRecords returns every record inconsistency in dir. module and
// version are the replaced module identity, or empty for synthetic fixtures.
func checkVendoredRecords(dir, module, version string) []error {
	var errs []error
	fail := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	upstream := map[string]string{}
	if err := decodeStrict(filepath.Join(dir, "UPSTREAM-SHA256.json"), &upstream); err != nil {
		return append(errs, err)
	}
	if len(upstream) == 0 {
		fail("UPSTREAM-SHA256.json lists no upstream files")
	}
	current := map[string]string{}
	for _, name := range slices.Sorted(maps.Keys(upstream)) {
		if !fs.ValidPath(name) || strings.Contains(name, `\`) {
			fail("UPSTREAM-SHA256.json: invalid path %q", name)
			continue
		}
		if !sha256Pattern.MatchString(upstream[name]) {
			fail("UPSTREAM-SHA256.json: %s has malformed hash %q", name, upstream[name])
		}
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			fail("UPSTREAM-SHA256.json lists %s: %v", name, err)
			continue
		}
		current[name] = hexHash(data)
	}

	ziphash := ""
	if data, err := os.ReadFile(filepath.Join(dir, "upstream-module-ziphash.txt")); err != nil {
		fail("%v", err)
	} else {
		ziphash = strings.TrimSuffix(string(data), "\n")
		raw, decodeErr := base64.StdEncoding.DecodeString(strings.TrimPrefix(ziphash, "h1:"))
		if !h1Pattern.MatchString(ziphash) || decodeErr != nil || len(raw) != sha256.Size {
			fail("upstream-module-ziphash.txt must hold one Go module h1 checksum, got %q", ziphash)
		}
	}

	declared := map[string]bool{}
	checkChange := func(record, name string, change changeRecord) {
		want, listed := upstream[name]
		switch {
		case !listed:
			fail("%s: %s is not an upstream file", record, name)
		case change.before != want:
			fail("%s: %s before hash %s differs from upstream %s", record, name, change.before, want)
		case change.after != current[name]:
			fail("%s: %s after hash %s differs from current %s", record, name, change.after, current[name])
		case change.before == change.after:
			fail("%s: %s records no change", record, name)
		}
		declared[name] = true
	}

	var format struct {
		Tool    string `json:"tool"`
		Changes string `json:"changes"`
		Files   map[string]struct {
			Before string `json:"before_sha256"`
			After  string `json:"after_sha256"`
		} `json:"files"`
	}
	if err := decodeStrict(filepath.Join(dir, "FORMAT-CHANGES.json"), &format); err != nil {
		errs = append(errs, err)
	} else if len(format.Files) > 0 && (format.Tool == "" || format.Changes == "") {
		fail("FORMAT-CHANGES.json must name the formatter and change kind")
	}
	for _, name := range slices.Sorted(maps.Keys(format.Files)) {
		entry := format.Files[name]
		checkChange("FORMAT-CHANGES.json", name, changeRecord{entry.Before, entry.After})
	}

	compatibility := map[string]struct {
		Before string `json:"before"`
		After  string `json:"after"`
		Reason string `json:"reason"`
	}{}
	compatibilityPath := filepath.Join(dir, "COMPATIBILITY-CHANGES.json")
	if _, err := os.Stat(compatibilityPath); err == nil {
		if err := decodeStrict(compatibilityPath, &compatibility); err != nil {
			errs = append(errs, err)
		}
	}
	for _, name := range slices.Sorted(maps.Keys(compatibility)) {
		entry := compatibility[name]
		if strings.TrimSpace(entry.Reason) == "" {
			fail("COMPATIBILITY-CHANGES.json: %s has no reason", name)
		}
		checkChange("COMPATIBILITY-CHANGES.json", name, changeRecord{entry.Before, entry.After})
	}

	patchNames, err := filepath.Glob(filepath.Join(dir, "*.patch"))
	if err != nil {
		return append(errs, err)
	}
	slices.Sort(patchNames)
	type patchFile struct {
		patch string
		hunks []hunk
	}
	patchesByFile := map[string][]patchFile{}
	patchTargets := map[string][]string{}
	// patchStates[file][patch] records the file hashes on either side of each
	// patch, recovered while reverse-applying the cumulative stack.
	patchStates := map[string]map[string]changeRecord{}
	for _, path := range patchNames {
		name := filepath.Base(path)
		data, err := os.ReadFile(path)
		if err != nil {
			fail("%v", err)
			continue
		}
		files, err := parsePatch(data)
		if err != nil {
			fail("%s: %v", name, err)
			continue
		}
		if len(files) == 0 {
			fail("%s changes no files", name)
		}
		for _, file := range files {
			if _, ok := upstream[file.path]; !ok {
				fail("%s: %s is not an upstream file", name, file.path)
				continue
			}
			if slices.Contains(patchTargets[name], file.path) {
				fail("%s: %s appears more than once", name, file.path)
				continue
			}
			patchTargets[name] = append(patchTargets[name], file.path)
			patchesByFile[file.path] = append(patchesByFile[file.path], patchFile{name, file.hunks})
			declared[file.path] = true
		}
	}
	for _, name := range slices.Sorted(maps.Keys(patchesByFile)) {
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			continue // already reported against UPSTREAM-SHA256.json
		}
		patches := patchesByFile[name]
		patchStates[name] = map[string]changeRecord{}
		for i := len(patches) - 1; i >= 0; i-- {
			after := hexHash(data)
			if data, err = reversePatch(data, patches[i].hunks); err != nil {
				fail("%s: %s does not reverse-apply to the vendored copy: %v", name, patches[i].patch, err)
				break
			}
			patchStates[name][patches[i].patch] = changeRecord{hexHash(data), after}
		}
		if err == nil && hexHash(data) != upstream[name] {
			fail("%s: reversed patches do not reproduce the upstream hash %s", name, upstream[name])
		}
	}

	for _, name := range slices.Sorted(maps.Keys(current)) {
		if current[name] != upstream[name] && !declared[name] {
			fail("%s differs from upstream without a change record or patch", name)
		}
	}

	corrections := map[string]struct {
		Before string `json:"before"`
		After  string `json:"after"`
		Patch  string `json:"patch"`
		Reason string `json:"reason"`
	}{}
	correctionsPath := filepath.Join(dir, "LOCAL-CORRECTIONS.json")
	if _, err := os.Stat(correctionsPath); err == nil {
		if err := decodeStrict(correctionsPath, &corrections); err != nil {
			errs = append(errs, err)
		}
	}
	for _, name := range slices.Sorted(maps.Keys(corrections)) {
		entry := corrections[name]
		if strings.TrimSpace(entry.Reason) == "" {
			fail("LOCAL-CORRECTIONS.json: %s has no reason", name)
		}
		state, ok := patchStates[name][entry.Patch]
		switch {
		case !ok:
			fail("LOCAL-CORRECTIONS.json: %s is not changed by %s", name, entry.Patch)
		case entry.Before != state.before || entry.After != state.after:
			fail("LOCAL-CORRECTIONS.json: %s hashes %s -> %s differ from %s's %s -> %s", name, entry.Before, entry.After, entry.Patch, state.before, state.after)
		}
	}

	errs = append(errs, checkLocalLock(dir, module, version, ziphash, upstream, current, compatibility, slices.Sorted(maps.Keys(corrections)), patchTargets)...)
	return errs
}

// checkLocalLock verifies a repository-authored provenance.lock.json. An
// upstream-owned lock without originalInputs (Nuri's) is left to that project.
func checkLocalLock[C any](dir, module, version, ziphash string, upstream, current map[string]string, compatibility map[string]C, corrections []string, patchTargets map[string][]string) []error {
	data, err := os.ReadFile(filepath.Join(dir, "provenance.lock.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return []error{err}
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return []error{fmt.Errorf("provenance.lock.json: %w", err)}
	}
	if _, local := probe["originalInputs"]; !local {
		return nil
	}
	var lock struct {
		Module                 string `json:"module"`
		Version                string `json:"version"`
		TagCommit              string `json:"tagCommit"`
		ModuleSum              string `json:"moduleSum"`
		License                string `json:"license"`
		LicenseSHA256          string `json:"licenseSHA256"`
		UpstreamParserSHA256   string `json:"upstreamParserSHA256"`
		OriginalInputs         string `json:"originalInputs"`
		FormatChanges          string `json:"formatChanges"`
		IntentionalPatch       string `json:"intentionalPatch"`
		Scope                  string `json:"scope"`
		Maintenance            string `json:"maintenance"`
		CompatibilityChanges   string `json:"compatibilityChanges"`
		IntentionalPatchDiff   string `json:"intentionalPatchDiff"`
		CompatibilityPatchDiff string `json:"compatibilityPatchDiff"`
		// LocalCorrections names LOCAL-CORRECTIONS.json when repository-authored
		// fixes are layered on the intentional and compatibility patches.
		LocalCorrections          string   `json:"localCorrections"`
		LocalCorrectionPatchDiffs []string `json:"localCorrectionPatchDiffs"`
	}
	if err := decodeStrict(filepath.Join(dir, "provenance.lock.json"), &lock); err != nil {
		return []error{err}
	}
	var errs []error
	fail := func(format string, args ...any) {
		errs = append(errs, fmt.Errorf("provenance.lock.json: "+format, args...))
	}
	if module != "" && lock.Module != module {
		fail("module %q differs from go.mod replacement %q", lock.Module, module)
	}
	if version != "" && lock.Version != version {
		fail("version %q differs from go.mod requirement %q", lock.Version, version)
	}
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(lock.TagCommit) {
		fail("tagCommit %q is not a commit hash", lock.TagCommit)
	}
	if lock.ModuleSum != ziphash {
		fail("moduleSum %q differs from upstream-module-ziphash.txt %q", lock.ModuleSum, ziphash)
	}
	if lock.LicenseSHA256 != upstream["LICENSE"] || lock.LicenseSHA256 != current["LICENSE"] {
		fail("licenseSHA256 must match the upstream and vendored LICENSE")
	}
	for field, want := range map[string]string{
		lock.OriginalInputs:       "UPSTREAM-SHA256.json",
		lock.FormatChanges:        "FORMAT-CHANGES.json",
		lock.CompatibilityChanges: "COMPATIBILITY-CHANGES.json",
	} {
		if field != want {
			fail("references %q, want %q", field, want)
		}
	}
	if lock.UpstreamParserSHA256 != upstream[lock.IntentionalPatch] {
		fail("upstreamParserSHA256 differs from the upstream %s", lock.IntentionalPatch)
	}
	if !slices.Contains(patchTargets[lock.IntentionalPatchDiff], lock.IntentionalPatch) {
		fail("%s must patch %s", lock.IntentionalPatchDiff, lock.IntentionalPatch)
	}
	targets := slices.Sorted(slices.Values(patchTargets[lock.CompatibilityPatchDiff]))
	if want := slices.Sorted(maps.Keys(compatibility)); !slices.Equal(targets, want) {
		fail("%s patches %v, but COMPATIBILITY-CHANGES.json records %v", lock.CompatibilityPatchDiff, targets, want)
	}
	if len(corrections) > 0 || lock.LocalCorrections != "" || len(lock.LocalCorrectionPatchDiffs) > 0 {
		if lock.LocalCorrections != "LOCAL-CORRECTIONS.json" {
			fail("references %q, want %q", lock.LocalCorrections, "LOCAL-CORRECTIONS.json")
		}
		var targets []string
		for _, patch := range lock.LocalCorrectionPatchDiffs {
			if len(patchTargets[patch]) == 0 {
				fail("local correction patch %s changes no upstream files", patch)
			}
			for _, target := range patchTargets[patch] {
				if !slices.Contains(targets, target) {
					targets = append(targets, target)
				}
			}
		}
		slices.Sort(targets)
		if !slices.Equal(targets, corrections) {
			fail("%v patch %v, but LOCAL-CORRECTIONS.json records %v", lock.LocalCorrectionPatchDiffs, targets, corrections)
		}
	}
	return errs
}

func decodeStrict(path string, value any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	if decoder.More() {
		return fmt.Errorf("%s: trailing data", filepath.Base(path))
	}
	return nil
}

func hexHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type hunk struct {
	newStart, newLines int
	oldText, newText   []string // lines including their terminators
}

type filePatch struct {
	path  string
	hunks []hunk
}

var hunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

// parsePatch reads a strict unified diff with a/ and b/ paths and no fuzz.
func parsePatch(data []byte) ([]filePatch, error) {
	lines := strings.SplitAfter(string(data), "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	var files []filePatch
	for i := 0; i < len(lines); {
		line := strings.TrimSuffix(lines[i], "\n")
		if !strings.HasPrefix(line, "--- ") {
			if strings.HasPrefix(line, "@@") || strings.HasPrefix(line, "+++ ") {
				return nil, fmt.Errorf("line %d: hunk outside a file header", i+1)
			}
			i++ // free-form preamble
			continue
		}
		if i+1 >= len(lines) {
			return nil, fmt.Errorf("line %d: missing +++ header", i+1)
		}
		oldPath, newPath := strings.TrimPrefix(line, "--- "), strings.TrimSuffix(strings.TrimPrefix(lines[i+1], "+++ "), "\n")
		oldPath, _, _ = strings.Cut(oldPath, "\t")
		newPath, _, _ = strings.Cut(newPath, "\t")
		if !strings.HasPrefix(oldPath, "a/") || newPath != "b/"+strings.TrimPrefix(oldPath, "a/") {
			return nil, fmt.Errorf("line %d: headers must name the same a/ and b/ file, got %q and %q", i+1, oldPath, newPath)
		}
		file := filePatch{path: strings.TrimPrefix(oldPath, "a/")}
		i += 2
		for i < len(lines) && strings.HasPrefix(lines[i], "@@") {
			m := hunkHeader.FindStringSubmatch(lines[i])
			if m == nil {
				return nil, fmt.Errorf("line %d: malformed hunk header", i+1)
			}
			count := func(s string) int {
				if s == "" {
					return 1
				}
				n, _ := strconv.Atoi(s)
				return n
			}
			oldLines, newStart, newLines := count(m[2]), count(m[3]), count(m[4])
			h := hunk{newStart: newStart, newLines: newLines}
			i++
			var last *[]string
			for (len(h.oldText) < oldLines || len(h.newText) < newLines) && i < len(lines) || i < len(lines) && strings.HasPrefix(lines[i], `\`) {
				text := lines[i]
				switch text[0] {
				case ' ':
					h.oldText = append(h.oldText, text[1:])
					h.newText = append(h.newText, text[1:])
					last = nil
				case '-':
					h.oldText = append(h.oldText, text[1:])
					last = &h.oldText
				case '+':
					h.newText = append(h.newText, text[1:])
					last = &h.newText
				case '\\':
					// "\ No newline at end of file" applies to the preceding line.
					if last == nil && len(h.oldText) > 0 && len(h.newText) > 0 {
						h.oldText[len(h.oldText)-1] = strings.TrimSuffix(h.oldText[len(h.oldText)-1], "\n")
						h.newText[len(h.newText)-1] = strings.TrimSuffix(h.newText[len(h.newText)-1], "\n")
					} else if last != nil && len(*last) > 0 {
						(*last)[len(*last)-1] = strings.TrimSuffix((*last)[len(*last)-1], "\n")
					} else {
						return nil, fmt.Errorf("line %d: misplaced no-newline marker", i+1)
					}
				default:
					return nil, fmt.Errorf("line %d: unexpected hunk line %q", i+1, text)
				}
				i++
			}
			if len(h.oldText) != oldLines || len(h.newText) != newLines {
				return nil, fmt.Errorf("%s: hunk line counts do not match its header", file.path)
			}
			file.hunks = append(file.hunks, h)
		}
		if len(file.hunks) == 0 {
			return nil, fmt.Errorf("%s: file header without hunks", file.path)
		}
		files = append(files, file)
	}
	return files, nil
}

// reversePatch replaces each hunk's new text at its exact recorded position with
// its old text. Hunks must be ordered and non-overlapping; no offset or fuzz is
// accepted, so a record that only approximately matches fails.
func reversePatch(data []byte, hunks []hunk) ([]byte, error) {
	lines := strings.SplitAfter(string(data), "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	var out strings.Builder
	next := 0
	for _, h := range hunks {
		at := h.newStart - 1
		if h.newLines == 0 {
			at = h.newStart
		}
		if at < next || at+len(h.newText) > len(lines) {
			return nil, fmt.Errorf("hunk at line %d is out of range or order", h.newStart)
		}
		if !slices.Equal(lines[at:at+len(h.newText)], h.newText) {
			return nil, fmt.Errorf("hunk at line %d does not match", h.newStart)
		}
		for _, line := range lines[next:at] {
			out.WriteString(line)
		}
		for _, line := range h.oldText {
			out.WriteString(line)
		}
		next = at + len(h.newText)
	}
	for _, line := range lines[next:] {
		out.WriteString(line)
	}
	return []byte(out.String()), nil
}
