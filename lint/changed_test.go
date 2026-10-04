package lint

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func changedFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	gitTest(t, root, "config", "user.name", "fixture")
	gitTest(t, root, "config", "user.email", "fixture@example.invalid")
	putFile(t, root, "roles/demo/tasks/main.yml", "- template: {src: config.conf, dest: /tmp/out}\n")
	putFile(t, root, "roles/demo/defaults/main.yml", "demo_role_enabled: true\n")
	putFile(t, root, "roles/demo/templates/config.conf", "{{ demo_role_enabled }}\n")
	putFile(t, root, "roles/unrelated/defaults/main.yml", "value: [broken\n")
	putFile(t, root, "resources/tasks/docker/main.yml", "- debug: {msg: '{{ _docker_vars._docker_memory | default(0) }}'}\n")
	putFile(t, root, "resources/tasks/docker/policy.yml", "[]\n")
	putFile(t, root, ".gitignore", "ignored/\nroles/demo/templates/ignored.conf\n")
	commitChangedFixture(t, root)
	return root
}
func commitChangedFixture(t *testing.T, root string) {
	t.Helper()
	gitTest(t, root, "add", "--all")
	gitTest(t, root, "commit", "-q", "-m", "chore: update fixture")
}
func gitReadTest(t *testing.T, root string, args ...string) []byte {
	t.Helper()
	output, err := exec.CommandContext(t.Context(), "git", append([]string{"--no-optional-locks", "-C", root}, args...)...).Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return output
}
func loadChangedTest(t *testing.T, root, ref string) *Project {
	t.Helper()
	p, err := Load(t.Context(), Options{Root: root, ChangedSince: ref, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	if p.Selection.Commit != strings.TrimSpace(string(gitReadTest(t, root, "rev-parse", ref+"^{commit}"))) || p.Dependencies.Selection != p.Selection {
		t.Fatal("missing resolved selection identity")
	}
	assertChangedParity(t, p)
	return p
}
func assertChangedParity(t *testing.T, p *Project) {
	t.Helper()
	full, err := Load(t.Context(), Options{Root: p.Root, Paths: []string{p.Root}})
	if err != nil {
		if len(p.Selected) == 0 && strings.Contains(err.Error(), "no supported sources") {
			return
		}
		t.Fatal(err)
	}
	all := Analyze(full, Rules())
	want := make([]Diagnostic, 0)
	for _, d := range all {
		if p.Selected[d.Path] {
			want = append(want, d)
		}
	}
	got := Analyze(p, Rules())
	// Include original spans, related locations and exact edit text. Preview
	// pointers are display caches; JSON exposes the diagnostic contract.
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Fatalf("selected/full diagnostics differ:\n%s\n%s", gotJSON, wantJSON)
	}
	gotFixes, err := PlanFixes(p, got)
	if err != nil {
		t.Fatal(err)
	}
	full.Selected = p.Selected
	wantFixes, err := PlanFixes(full, want)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotFixes, wantFixes) {
		t.Fatalf("selected/full fixes differ: %#v %#v", gotFixes, wantFixes)
	}
}
func assertSelection(t *testing.T, p *Project, want ...string) {
	t.Helper()
	slices.Sort(want)
	if got := selectedPaths(p); !slices.Equal(got, want) {
		t.Fatalf("selected=%q want=%q selection=%+v", got, want, p.Selection)
	}
}

func TestChangedCurrentWorktreeAndExactCommit(t *testing.T) {
	root := changedFixture(t)
	baseline := strings.TrimSpace(string(gitReadTest(t, root, "rev-parse", "HEAD")))
	assertSelection(t, loadChangedTest(t, root, baseline))
	name := "roles/demo/defaults/main.yml"
	putFile(t, root, name, "value: staged\n")
	gitTest(t, root, "add", "--", name)
	putFile(t, root, name, "value: '{{ a\n | combine(b) }}'\n")
	index, err := os.ReadFile(filepath.Join(root, ".git/index"))
	if err != nil {
		t.Fatal(err)
	}
	refs := gitReadTest(t, root, "show-ref")
	before := snapshotChangedFiles(t, root)
	p := loadChangedTest(t, root, baseline)
	assertSelection(t, p, name, "roles/demo/tasks/main.yml")
	if !bytes.Equal(p.Sources[name].Data, before[name]) {
		t.Fatal("read staged bytes instead of current worktree")
	}
	if !reflect.DeepEqual(before, snapshotChangedFiles(t, root)) {
		t.Fatal("source bytes changed")
	}
	afterIndex, err := os.ReadFile(filepath.Join(root, ".git/index"))
	if err != nil || !bytes.Equal(index, afterIndex) || !bytes.Equal(refs, gitReadTest(t, root, "show-ref")) {
		t.Fatal("Git index or refs changed")
	}
	// Partial staging that has been reverted in the worktree produces no source
	// change even though the index still differs from the resolved tree.
	putFile(t, root, name, "demo_role_enabled: true\n")
	assertSelection(t, loadChangedTest(t, root, baseline))
	putFile(t, root, name, "demo_role_enabled: false\n")
	commitChangedFixture(t, root)
	assertSelection(t, loadChangedTest(t, root, baseline), name, "roles/demo/tasks/main.yml")
	assertSelection(t, loadChangedTest(t, root, "HEAD"))
}
func snapshotChangedFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	result := map[string][]byte{}
	err := filepath.WalkDir(root, func(name string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(name)
		result[filepath.ToSlash(rel)] = data
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func TestChangedTemplatesSharedResourcesAndIgnores(t *testing.T) {
	for _, tc := range []struct {
		name string
		want []string
	}{
		{"roles/demo/templates/config.conf", []string{"roles/demo/defaults/main.yml", "roles/demo/tasks/main.yml"}},
		{"roles/demo/templates/new.yaml", []string{"roles/demo/defaults/main.yml", "roles/demo/tasks/main.yml"}},
		{"resources/tasks/docker/policy.yml", []string{"resources/tasks/docker/main.yml", "resources/tasks/docker/policy.yml"}},
		{"roles/new/tasks/created.yaml", []string{"roles/new/tasks/created.yaml"}},
		{"ignored/tasks/private.yml", nil},
		{"roles/demo/templates/ignored.conf", nil},
		{"notes.txt", nil},
		{".gitignore", []string{"roles/demo/defaults/main.yml", "roles/demo/tasks/main.yml", "roles/unrelated/defaults/main.yml", "resources/tasks/docker/main.yml", "resources/tasks/docker/policy.yml"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := changedFixture(t)
			putFile(t, root, tc.name, "value: '{{ a\n | combine(b) }}'\n")
			p := loadChangedTest(t, root, "HEAD")
			assertSelection(t, p, tc.want...)
			for _, selected := range p.Selection.Sources {
				if isTemplate(selected.Path) {
					t.Fatal("template selected as primary")
				}
			}
			if strings.Contains(tc.name, "templates/") && p.Sources[tc.name] != nil && p.Sources[tc.name].Kind != Template {
				t.Fatal("YAML template parsed as primary")
			}
		})
	}
}
func TestChangedDeletionRenameAndEmptyRepository(t *testing.T) {
	for _, rename := range []bool{false, true} {
		t.Run(map[bool]string{false: "delete", true: "rename"}[rename], func(t *testing.T) {
			root := changedFixture(t)
			old := "roles/demo/templates/config.conf"
			newName := "roles/new/templates/renamed.conf"
			if rename {
				putFile(t, root, newName, "{{ demo_role_enabled }}\n")
			}
			if err := os.Remove(filepath.Join(root, filepath.FromSlash(old))); err != nil {
				t.Fatal(err)
			}
			if rename {
				gitTest(t, root, "add", "--all")
			}
			p := loadChangedTest(t, root, "HEAD")
			if p.Selection.Fallback == "" || !slices.Contains(p.Selection.Changed, old) || (rename && !slices.Contains(p.Selection.Changed, newName)) {
				t.Fatalf("missing removed identity/fallback: %+v", p.Selection)
			}
			if p.Sources[old] != nil || p.Selected[old] {
				t.Fatal("deleted file loaded")
			}
			assertSelection(t, p, "roles/demo/defaults/main.yml", "roles/demo/tasks/main.yml", "roles/unrelated/defaults/main.yml", "resources/tasks/docker/main.yml", "resources/tasks/docker/policy.yml")
		})
	}
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	gitTest(t, root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "chore: initialize fixture")
	assertSelection(t, loadChangedTest(t, root, "HEAD"))
	putFile(t, root, "tasks/main.yml", "[]\n")
	commitChangedFixture(t, root)
	if err := os.Remove(filepath.Join(root, "tasks/main.yml")); err != nil {
		t.Fatal(err)
	}
	p := loadChangedTest(t, root, "HEAD")
	assertSelection(t, p)
	if p.Selection.Fallback == "" {
		t.Fatal("removed last primary did not explain fallback")
	}
}
func TestChangedSubrootAndMergeHistory(t *testing.T) {
	root := changedFixture(t)
	putFile(t, root, "sub/tasks/main.yml", "[]\n")
	commitChangedFixture(t, root)
	gitTest(t, root, "branch", "side")
	putFile(t, root, "roles/demo/defaults/main.yml", "demo_role_enabled: false\n")
	commitChangedFixture(t, root)
	gitTest(t, root, "checkout", "-q", "side")
	putFile(t, root, "sub/tasks/main.yml", "- debug: msg=side\n")
	commitChangedFixture(t, root)
	side := strings.TrimSpace(string(gitReadTest(t, root, "rev-parse", "HEAD")))
	gitTest(t, root, "checkout", "-q", "-")
	gitTest(t, root, "merge", "-q", "--no-edit", "side")
	p := loadChangedTest(t, root, side)
	assertSelection(t, p, "roles/demo/defaults/main.yml", "roles/demo/tasks/main.yml")
	putFile(t, root, "sub/tasks/main.yml", "- debug: msg=worktree\n")
	sub := filepath.Join(root, "sub")
	p = loadChangedTest(t, sub, "HEAD")
	assertSelection(t, p, "tasks/main.yml")
	if !slices.Equal(p.Selection.Changed, []string{"tasks/main.yml"}) {
		t.Fatalf("escaped subroot: %q", p.Selection.Changed)
	}
}
func TestChangedLiteralNamesAndRevisionErrors(t *testing.T) {
	root := changedFixture(t)
	names := []string{"tasks/file name.yml", "tasks/-leading.yml", "tasks/ユニコード.yml"}
	// Windows cannot create tab or newline filenames. NUL parsing is exercised
	// for those byte sequences on every target below.
	if runtime.GOOS != "windows" {
		names = append(names, "tasks/tab\tname.yml", "tasks/newline\nname.yml")
	}
	for _, name := range names {
		putFile(t, root, name, "[]\n")
	}
	p := loadChangedTest(t, root, "HEAD")
	assertSelection(t, p, names...)
	if got := nulNames([]byte("tasks/a\tb.yml\x00tasks/a\nb.yml\x00tasks/-x.yml\x00")); !slices.Equal(got, []string{"tasks/a\tb.yml", "tasks/a\nb.yml", "tasks/-x.yml"}) {
		t.Fatalf("NUL parser changed names: %q", got)
	}
	for _, ref := range []string{"missing-ref", "--all", "--output=/tmp/escaped", "HEAD:path", "HEAD\nHEAD"} {
		if _, err := Load(t.Context(), Options{Root: root, ChangedSince: ref}); err == nil {
			t.Fatalf("invalid revision accepted: %q", ref)
		}
	}
	for _, opts := range []Options{{Root: t.TempDir(), ChangedSince: "HEAD"}, {Root: root, ChangedSince: "HEAD", Paths: []string{root}}, {Root: root, ChangedSince: "HEAD", StdinFilename: "x.yml", Stdin: []byte("[]")}} {
		if _, err := Load(t.Context(), opts); err == nil {
			t.Fatal("invalid selection accepted")
		}
	}
}
func TestChangedDisabledExternalDiffAndTextconv(t *testing.T) {
	root := changedFixture(t)
	putFile(t, root, ".gitattributes", "*.yml diff=must-not-run\n")
	gitTest(t, root, "config", "diff.must-not-run.command", "saltbox-lint-nonexistent-diff")
	gitTest(t, root, "config", "diff.must-not-run.textconv", "saltbox-lint-nonexistent-textconv")
	t.Setenv("GIT_EXTERNAL_DIFF", "saltbox-lint-nonexistent-external-diff")
	putFile(t, root, "roles/demo/defaults/main.yml", "demo_role_enabled: false\n")
	assertSelection(t, loadChangedTest(t, root, "HEAD"), "roles/demo/defaults/main.yml", "roles/demo/tasks/main.yml")
}
func TestChangedOwnershipAndOpaqueAdministration(t *testing.T) {
	for _, separate := range []bool{false, true} {
		t.Run(map[bool]string{false: "regular", true: "separate"}[separate], func(t *testing.T) {
			root := changedFixture(t)
			if separate {
				admin := filepath.Join(t.TempDir(), "admin")
				gitTest(t, root, "init", "-q", "--separate-git-dir", admin)
			}
			putFile(t, root, "roles/demo/defaults/main.yml", "demo_role_enabled: false\n")
			p := loadChangedTest(t, root, "HEAD")
			assertSelection(t, p, "roles/demo/defaults/main.yml", "roles/demo/tasks/main.yml")
			for _, source := range p.Dependencies.Sources {
				for _, file := range append(source.Files, source.Discovery...) {
					if strings.HasPrefix(file.Path, "../") {
						t.Fatal("administration exported as source")
					}
				}
			}
		})
	}
	root := changedFixture(t)
	outside := t.TempDir()
	link := filepath.Join(root, ".git/info/exclude")
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(putFile(t, outside, "exclude", "*\n"), link); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(t.Context(), Options{Root: root, ChangedSince: "HEAD"}); !errors.Is(err, errOutsideRoot) {
		t.Fatalf("escaped control admitted: %v", err)
	}
}

func TestChangedRelatedLocationsAndVerifiedFixParity(t *testing.T) {
	root := changedFixture(t)
	putFile(t, root, traefikDefaultsPath, "example_role_nginx_web_subdomain: nginx\n")
	putFile(t, root, traefikTasksPath, traefikFixture(t, "adapter.bad.yml")+"- debug: {msg: '{{ a\n | combine(b) }}'}\n")
	commitChangedFixture(t, root)
	putFile(t, root, "roles/example/templates/new.j2", "{{ example_role_enabled }}\n")
	p := loadChangedTest(t, root, "HEAD")
	assertSelection(t, p, traefikDefaultsPath, traefikTasksPath)
	ds := Analyze(p, Rules())
	if !slices.ContainsFunc(ds, func(d Diagnostic) bool { return len(d.Related) > 0 }) || !slices.ContainsFunc(ds, func(d Diagnostic) bool { return d.Fix != nil }) {
		t.Fatalf("fixture did not exercise related locations and edits: %+v", ds)
	}
	changes, err := PlanFixes(p, ds)
	if err != nil || len(changes) == 0 {
		t.Fatalf("missing verified fix: %v %v", changes, err)
	}
	explanation, err := ExplainChanged(t.Context(), Options{Root: root, ChangedSince: "HEAD"})
	if err != nil || !reflect.DeepEqual(explanation.Selection, p.Selection) || !slices.ContainsFunc(explanation.FixDecisions, func(d FixDecision) bool { return d.State == "available" }) {
		t.Fatalf("explanation differs: %+v %v", explanation, err)
	}
}

func TestChangedFlaggedWorktreeInputs(t *testing.T) {
	for _, flag := range []string{"--assume-unchanged", "--skip-worktree"} {
		for _, name := range []string{"roles/demo/defaults/main.yml", "roles/demo/templates/config.conf", "notes.txt", ".gitignore"} {
			t.Run(flag+"/"+name, func(t *testing.T) {
				root := changedFixture(t)
				if name == "notes.txt" {
					putFile(t, root, name, "original\n")
					commitChangedFixture(t, root)
				}
				gitTest(t, root, "update-index", flag, "--", name)
				putFile(t, root, name, "value: '{{ a\n | combine(b) }}'\n")
				// Establish that ordinary Git diff actually hides this physical edit.
				diff := nulNames(gitReadTest(t, root, "diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."))
				if slices.Contains(diff, name) {
					t.Fatalf("fixture did not hide flagged worktree edit: %q", diff)
				}
				before := snapshotChangedFiles(t, root)
				index, err := os.ReadFile(filepath.Join(root, ".git/index"))
				if err != nil {
					t.Fatal(err)
				}
				refs := gitReadTest(t, root, "show-ref")
				p := loadChangedTest(t, root, "HEAD")
				want := []string{"roles/demo/defaults/main.yml", "roles/demo/tasks/main.yml"}
				if name == "notes.txt" {
					want = nil
				}
				if name == ".gitignore" {
					want = []string{"roles/demo/defaults/main.yml", "roles/demo/tasks/main.yml", "roles/unrelated/defaults/main.yml", "resources/tasks/docker/main.yml", "resources/tasks/docker/policy.yml"}
				}
				assertSelection(t, p, want...)
				if !slices.Equal(p.Selection.Uncertain, []string{name}) || slices.Contains(p.Selection.Changed, name) {
					t.Fatalf("uncertainty invented a changed path: %+v", p.Selection)
				}
				for _, selected := range p.Selection.Sources {
					if !slices.ContainsFunc(selected.Reasons, func(reason SelectionReason) bool { return reason.Kind == "git-index-flag" && reason.Path == name }) {
						t.Fatalf("missing honest reason: %+v", selected)
					}
				}
				if source := p.Sources[name]; source != nil && !bytes.Equal(source.Data, before[name]) {
					t.Fatal("hidden source did not use current bytes")
				}
				afterIndex, err := os.ReadFile(filepath.Join(root, ".git/index"))
				if err != nil || !bytes.Equal(index, afterIndex) || !bytes.Equal(refs, gitReadTest(t, root, "show-ref")) || !reflect.DeepEqual(before, snapshotChangedFiles(t, root)) {
					t.Fatal("flag inspection mutated index, refs or sources")
				}
			})
		}
	}
}
func TestChangedFlaggedMissingContextAndSubroot(t *testing.T) {
	root := changedFixture(t)
	name := "roles/demo/templates/config.conf"
	gitTest(t, root, "update-index", "--skip-worktree", "--", name)
	if err := os.Remove(filepath.Join(root, filepath.FromSlash(name))); err != nil {
		t.Fatal(err)
	}
	p := loadChangedTest(t, root, "HEAD")
	if p.Selection.Fallback == "" || p.Selected[name] || p.Sources[name] != nil {
		t.Fatalf("missing flagged context underselected or loaded: %+v", p.Selection)
	}
	assertSelection(t, p, "roles/demo/defaults/main.yml", "roles/demo/tasks/main.yml", "roles/unrelated/defaults/main.yml", "resources/tasks/docker/main.yml", "resources/tasks/docker/policy.yml")

	root = changedFixture(t)
	putFile(t, root, "sub/tasks/main.yml", "[]\n")
	putFile(t, root, "sub/roles/unrelated/defaults/main.yml", "value: [broken\n")
	commitChangedFixture(t, root)
	gitTest(t, root, "update-index", "--assume-unchanged", "--", "roles/demo/defaults/main.yml", "sub/tasks/main.yml")
	putFile(t, root, "roles/demo/defaults/main.yml", "changed: true\n")
	putFile(t, root, "sub/tasks/main.yml", "- debug: msg=hidden\n")
	p = loadChangedTest(t, filepath.Join(root, "sub"), "HEAD")
	assertSelection(t, p, "tasks/main.yml")
	if !slices.Equal(p.Selection.Uncertain, []string{"tasks/main.yml"}) {
		t.Fatalf("flagged name crossed source root: %+v", p.Selection)
	}
}
func TestFlaggedGitNamesKeepNULIdentities(t *testing.T) {
	output := []byte("S tasks/a\tb.yml\x00h tasks/a\nb.yml\x00H tasks/normal.yml\x00s tasks/-leading.yml\x00H broken\x00")
	want := []string{"tasks/-leading.yml", "tasks/a\tb.yml", "tasks/a\nb.yml"}
	slices.Sort(want)
	if got := flaggedGitNames(output); !slices.Equal(got, want) {
		t.Fatalf("flagged names=%q want=%q", got, want)
	}
}
