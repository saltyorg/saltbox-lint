package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestGoChecksUseCurrentProjectPackages(t *testing.T) {
	f := newGoScopeFixture(t)
	f.write(".gitignore", "dependency/\nignored-module/go.mod\n")
	f.write("tracked/source.go", "package tracked\nconst Value = 1\n")
	f.runOK("git", "add", ".")
	// Use current bytes and discover new packages before staging them.
	f.write("new/source with spaces.go", "package added\nconst Value = 2\n")
	f.write("new/unicode-é source.go", "package added\nconst Literal = 4\n")
	if runtime.GOOS != "windows" {
		f.write("new/source\nwith newline.go", "package added\nconst Other = 3\n")
		f.write("new/source\twith tab.go", "package added\nconst Tab = 5\n")
	}
	f.write("dependency/tool/source.go", "package tool\n")
	for _, dir := range []string{"_hidden", ".hidden", "testdata/fixture", "vendor/fixture"} {
		f.write(dir+"/source.go", "package excluded\n")
	}
	f.write("nested/go.mod", "module example.test/nested\n\ngo 1.27.1\n")
	f.write("nested/source.go", "package nested\n")
	f.write("ignored-module/go.mod", "module example.test/ignored-module\n\ngo 1.27.1\n")
	f.write("ignored-module/source.go", "package ignored\nimport _ \"example.invalid/nested\"\n")
	f.write("conditional/source.go", "//go:build scopefixture\n\npackage conditional\n")
	f.write("foreign/source.go", "//go:build "+otherGOOS()+"\n\npackage foreign\n")
	f.write("tracked/deleted.go", "package tracked\n")
	f.runOK("git", "add", "tracked/deleted.go")
	if err := os.Remove(filepath.Join(f.root, "tracked/deleted.go")); err != nil {
		t.Fatal(err)
	}
	// An accidental stale inventory in a checkout cannot hide current sources.
	f.write("SOURCE-PROVENANCE.json", `{"inputs":{"go.mod":""}}`)
	before := f.state()
	// This is the original scope defect, witnessed using Go's own discovery.
	original := f.runOK("go", "list", "./...")
	if !strings.Contains(string(original), "example.test/scope/dependency/tool") {
		t.Fatalf("original recursive check did not expose the dependency package: %s", original)
	}
	want := []string{"example.test/scope", "example.test/scope/new", "example.test/scope/tracked"}
	if got := strings.Fields(string(f.checkOK("go", "list"))); !slices.Equal(got, want) {
		t.Fatalf("current source packages=%q want=%q", got, want)
	}
	t.Setenv("GOFLAGS", "-tags=scopefixture")
	withTag := append(slices.Clone(want), "example.test/scope/conditional")
	slices.Sort(withTag)
	got := strings.Fields(string(f.checkOK("go", "list")))
	slices.Sort(got)
	if !slices.Equal(got, withTag) {
		t.Fatalf("tagged source packages=%q want=%q", got, withTag)
	}
	f.checkOK("go", "vet")
	f.checkOK("go", "test")
	if after := f.state(); !reflect.DeepEqual(before, after) {
		t.Fatal("scope check changed current source, index or refs")
	}
	// A new unstaged package must fail real checks, rather than only appear in
	// a selector's expected list. Keep the invalid bytes intact on failure.
	f.write("new/broken.go", "package added\nvar Broken int = \"wrong type\"\n")
	before = f.state()
	for _, command := range []string{"vet", "test"} {
		out, err := f.check("go", command)
		if err == nil || !strings.Contains(string(out), "wrong type") {
			t.Fatalf("new package %s must fail: %v\n%s", command, err, out)
		}
	}
	if after := f.state(); !reflect.DeepEqual(before, after) {
		t.Fatal("failed check changed current source, index or refs")
	}
	// Go rejects a leading hyphen in a source filename. Keep that error visible.
	f.write("new/-source.go", "package added\n")
	out, err := f.check("go", "test")
	if err == nil || !strings.Contains(string(out), "invalid input file name") {
		t.Fatalf("Go filename rejection must remain visible: %v\n%s", err, out)
	}
}

func TestGoTidinessUsesCurrentSourceWithoutInstalledDependencies(t *testing.T) {
	f := newGoScopeFixture(t)
	f.write(".gitignore", "dependency/\nignored-module/go.mod\n")
	f.write("go.mod", "module example.test/scope\n\ngo 1.27.1\n\nrequire example.test/local v0.0.0\n\nreplace example.test/local => ./local\n")
	f.write("local/go.mod", "module example.test/local\n\ngo 1.27.1\n")
	f.write("local/source.go", "package local\n")
	f.write("source.go", "package scope\nimport _ \"example.test/local\"\n")
	f.write("embedded.go", "package scope\nimport _ \"embed\"\n//go:embed \"asset with spaces.txt\"\nvar Asset string\n")
	f.write("asset with spaces.txt", "current embedded contents\n")
	f.runOK("git", "add", ".")
	f.write("dependency/tool/source.go", "package tool\nimport _ \"example.invalid/missing\"\n")
	f.write("ignored-module/go.mod", "module example.test/ignored-module\n\ngo 1.27.1\n")
	f.write("ignored-module/source.go", "package ignored\nimport _ \"example.invalid/nested\"\n")
	before := f.state()
	original, err := f.run("go", "mod", "tidy", "-diff")
	if err == nil || !strings.Contains(string(original), "example.invalid/missing") {
		t.Fatalf("original tidy must discover ignored dependency import: %v\n%s", err, original)
	}
	f.checkOK("tidy")
	f.checkOK("go", "test")
	if after := f.state(); !reflect.DeepEqual(before, after) {
		t.Fatal("tidy changed source, module bytes, index or refs")
	}
	// Removing a current import must produce the genuine module diff.
	f.write("source.go", "package scope\n")
	out, err := f.check("tidy")
	if err == nil || !strings.Contains(string(out), "-require example.test/local v0.0.0") {
		t.Fatalf("unused real dependency must fail with its diff: %v\n%s", err, out)
	}
	// A nonignored new source must make missing requirements visible too.
	f.write("new/import.go", "package added\nimport _ \"example.invalid/project\"\n")
	before = f.state()
	out, err = f.check("tidy")
	if err == nil || !strings.Contains(string(out), "example.invalid/project") || strings.Contains(string(out), "example.invalid/missing") {
		t.Fatalf("current project import must fail independently: %v\n%s", err, out)
	}
	if after := f.state(); !reflect.DeepEqual(before, after) {
		t.Fatal("failed tidy changed source, module bytes, index or refs")
	}
}

func TestGoSourceArchiveScope(t *testing.T) {
	f := newGoScopeFixture(t)
	// Release source can be unpacked under an ignored parent checkout too.
	f.write(".gitignore", "published/\n")
	f.root = filepath.Join(f.root, "published")
	f.write("go.mod", "module example.test/scope\n\ngo 1.27.1\n")
	f.write("source.go", "package scope\n")
	f.write("new/source.go", "package added\n")
	f.write("dependency/tool/source.go", "package tool\nimport _ \"example.invalid/missing\"\n")
	inputs := map[string]string{}
	for _, path := range []string{"go.mod", "source.go", "new/source.go"} {
		data, err := os.ReadFile(filepath.Join(f.root, path))
		if err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256(data)
		inputs[path] = hex.EncodeToString(hash[:])
	}
	provenance := map[string]any{"inputs": inputs}
	data, err := json.Marshal(provenance)
	if err != nil {
		t.Fatal(err)
	}
	f.write("SOURCE-PROVENANCE.json", string(data))
	if err := os.RemoveAll(filepath.Join(f.root, ".git")); err != nil {
		t.Fatal(err)
	}
	f.checkOK("go", "test")
	f.checkOK("tidy")
	if err := os.RemoveAll(filepath.Join(filepath.Dir(f.root), ".git")); err != nil {
		t.Fatal(err)
	}
	f.checkOK("go", "test")
	f.checkOK("tidy")
	// A client error must not masquerade as an absent repository and silently
	// fall back to the archive inventory.
	config := os.Getenv("GIT_CONFIG_GLOBAL")
	writeFile(t, config, []byte("[\n"))
	out, err := f.check("go", "test")
	if err == nil || !strings.Contains(string(out), "bad config") {
		t.Fatalf("Git client failure must remain visible: %v\n%s", err, out)
	}
	writeFile(t, config, nil)
	// Provenance paths must not escape the source tree.
	f.write("SOURCE-PROVENANCE.json", `{"inputs":{"../outside.go":"`+strings.Repeat("0", 64)+`"}}`)
	out, err = f.check("tidy")
	if err == nil || !strings.Contains(string(out), "escapes the module") {
		t.Fatalf("source archive escape must fail: %v\n%s", err, out)
	}
	f.write("SOURCE-PROVENANCE.json", `{"inputs":[]}`)
	out, err = f.check("tidy")
	if err == nil || !strings.Contains(string(out), "inputs object") {
		t.Fatalf("invalid archive inventory must fail: %v\n%s", err, out)
	}
}

type goScopeFixture struct {
	t        *testing.T
	root     string
	helper   string
	tidyTemp string
}

func newGoScopeFixture(t *testing.T) goScopeFixture {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Fatal("Go source gates require the pinned Node toolchain:", err)
	}
	helper, err := filepath.Abs("../tools/go-check.mjs")
	if err != nil {
		t.Fatal(err)
	}
	f := goScopeFixture{t: t, root: t.TempDir(), helper: helper, tidyTemp: t.TempDir()}
	for _, name := range []string{"TMPDIR", "TEMP", "TMP"} {
		t.Setenv(name, f.tidyTemp)
	}
	f.write(".fixture-gitconfig", "")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(f.root, ".fixture-gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GOWORK", "off")
	t.Setenv("GOPROXY", "off")
	t.Setenv("GOSUMDB", "off")
	f.write("go.mod", "module example.test/scope\n\ngo 1.27.1\n")
	f.write("source.go", "package scope\n")
	f.runOK("git", "init", "-q")
	return f
}

func (f goScopeFixture) write(path, contents string) {
	f.t.Helper()
	writeFile(f.t, filepath.Join(f.root, path), []byte(contents))
}

func (f goScopeFixture) run(args ...string) ([]byte, error) {
	c := exec.CommandContext(f.t.Context(), args[0], args[1:]...)
	c.Dir = f.root
	return c.CombinedOutput()
}

func (f goScopeFixture) runOK(args ...string) []byte {
	f.t.Helper()
	out, err := f.run(args...)
	if err != nil {
		f.t.Fatalf("%q: %v\n%s", args, err, out)
	}
	return out
}

func (f goScopeFixture) check(args ...string) ([]byte, error) {
	out, err := f.run(append([]string{"node", f.helper}, args...)...)
	entries, readErr := os.ReadDir(f.tidyTemp)
	if readErr != nil || len(entries) != 0 {
		f.t.Fatalf("check left temporary files: %v %v", entries, readErr)
	}
	return out, err
}

func (f goScopeFixture) checkOK(args ...string) []byte {
	f.t.Helper()
	out, err := f.check(args...)
	if err != nil {
		f.t.Fatalf("scope check %q: %v\n%s", args, err, out)
	}
	return out
}

func (f goScopeFixture) state() map[string][32]byte {
	f.t.Helper()
	state := map[string][32]byte{}
	err := filepath.WalkDir(f.root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		state[path] = sha256.Sum256(data)
		return nil
	})
	if err != nil {
		f.t.Fatal(err)
	}
	state["git index"] = sha256.Sum256(f.runOK("git", "ls-files", "--stage", "-z"))
	state["git refs"] = sha256.Sum256(bytes.TrimSpace(f.runOK("git", "for-each-ref")))
	return state
}

func otherGOOS() string {
	if runtime.GOOS == "windows" {
		return "linux"
	}
	return "windows"
}
