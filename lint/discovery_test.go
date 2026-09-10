package lint

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

func putFile(t *testing.T, root, name, data string) string {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(data), 0644); err != nil {
		t.Fatal(err)
	}
	return p
}
func gitTest(t *testing.T, root string, args ...string) {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), "git", append([]string{"-C", root}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}
func selectedPaths(p *Project) []string {
	var paths []string
	for name, selected := range p.Selected {
		if selected {
			paths = append(paths, name)
		}
	}
	slices.Sort(paths)
	return paths
}

// A directory check must honor Git ignores without losing tracked modifications
// or ordinary untracked YAML. Explicit files intentionally override ignore rules.
func TestLoadGitSelection(t *testing.T) {
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	putFile(t, root, ".gitignore", "tasks/ignored.yml\ntasks/tracked.yml\n")
	putFile(t, root, "tasks/tracked.yml", "value: old\n")
	gitTest(t, root, "add", "-f", "tasks/tracked.yml")
	putFile(t, root, "tasks/tracked.yml", "value: modified\n")
	putFile(t, root, "tasks/new.yaml", "value: new\n")
	ignored := putFile(t, root, "tasks/ignored.yml", "value: private\n")
	putFile(t, root, "notes.txt", "not YAML")
	p, err := Load(t.Context(), Options{Paths: []string{root, root}})
	if err != nil {
		t.Fatal(err)
	}
	if got := selectedPaths(p); !slices.Equal(got, []string{"tasks/new.yaml", "tasks/tracked.yml"}) {
		t.Fatalf("selected=%v", got)
	}
	if p.Sources["tasks/tracked.yml"].Documents[0].Get("value").Value != "modified" {
		t.Fatal("read index instead of worktree")
	}
	p, err = Load(t.Context(), Options{Paths: []string{ignored}})
	if err != nil || !p.Selected["tasks/ignored.yml"] {
		t.Fatalf("explicit ignore override: %v %#v", err, p)
	}
}

func TestLoadSelectedRoleContext(t *testing.T) {
	root := t.TempDir()
	putFile(t, root, "saltbox.yml", "- hosts: all\n")
	selected := putFile(t, root, "roles/demo/tasks/main.yml", "- debug: msg=hello\n")
	for _, name := range []string{"roles/demo/defaults/sub/main.yaml", "roles/demo/tasks/helper.yml", "roles/demo/vars/main.yml", "roles/demo/handlers/main.yml"} {
		putFile(t, root, name, "value: ok\n")
	}
	putFile(t, root, "roles/demo/templates/config.conf", "{% if enabled %}\nvalue\n{% endif %}")
	putFile(t, root, "roles/unrelated/defaults/main.yml", "value: [broken\n")
	p, err := Load(t.Context(), Options{Paths: []string{selected}})
	if err != nil {
		t.Fatal(err)
	}
	if p.Root != root || p.Name != "saltbox" {
		t.Errorf("identity: root=%q name=%q", p.Root, p.Name)
	}
	if got := selectedPaths(p); !slices.Equal(got, []string{"roles/demo/tasks/main.yml"}) {
		t.Errorf("selection: %v", got)
	}
	if len(p.Sources) != 6 || p.Sources["roles/demo/templates/config.conf"].Kind != Template {
		t.Errorf("context: %v", p.Sources)
	}
	p, err = Load(t.Context(), Options{Paths: []string{root}})
	if err != nil || len(p.Selected) != 7 || len(p.Sources) != 8 || len(p.Diagnostics) != 1 {
		t.Fatalf("whole project: %v %#v", err, p)
	}
}

func TestLoadDockerResourceContext(t *testing.T) {
	root := t.TempDir()
	putFile(t, root, "sandbox.yml", "- hosts: all\n")
	selected := putFile(t, root, "resources/tasks/docker/main.yml", "- debug: msg=hello\n")
	putFile(t, root, "resources/tasks/docker/port.yml", "- debug: msg=port\n")
	putFile(t, root, "resources/tasks/unrelated/main.yml", "invalid: [\n")
	p, err := Load(t.Context(), Options{Paths: []string{selected}})
	if err != nil || p.Name != "sandbox" || len(p.Sources) != 2 || len(p.Selected) != 1 {
		t.Fatalf("resource context: %v %#v", err, p)
	}
}

func TestLoadStandaloneAndStdin(t *testing.T) {
	root := t.TempDir()
	file := putFile(t, root, "input.yaml", "value: disk\n")
	p, err := Load(t.Context(), Options{Paths: []string{file, file}, StdinFilename: file, Stdin: []byte("value: buffer\n")})
	if err != nil {
		t.Fatal(err)
	}
	if p.Root != root || len(p.Selected) != 1 || p.Sources["input.yaml"].Documents[0].Get("value").Value != "buffer" {
		t.Fatalf("override: %#v", p)
	}
	missing := filepath.Join(root, "new.yml")
	p, err = Load(t.Context(), Options{Root: root, StdinFilename: missing, Stdin: []byte{}})
	if err != nil || len(p.Selected) != 1 || len(p.Sources["new.yml"].Data) != 0 {
		t.Fatalf("unsaved empty buffer: %v %#v", err, p)
	}
}

func TestLoadRejectsInvalidTargets(t *testing.T) {
	root := t.TempDir()
	bad := putFile(t, root, "readme.txt", "hello")
	outside := putFile(t, t.TempDir(), "input.yml", "a: b\n")
	for _, opts := range []Options{
		{}, {Paths: []string{root}}, {Paths: []string{filepath.Join(root, "missing.yml")}},
		{Paths: []string{bad}}, {Root: root, Paths: []string{outside}}, {Root: bad, Paths: []string{outside}},
		{Root: root, Stdin: []byte("a: b")}, {Root: root, StdinFilename: "bad.txt", Stdin: []byte("a: b")},
	} {
		if p, err := Load(t.Context(), opts); err == nil {
			t.Errorf("Load(%+v) accepted: %#v", opts, p)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := Load(ctx, Options{Paths: []string{root}}); !errors.Is(err, context.Canceled) {
		t.Errorf("cancellation=%v", err)
	}
}

func TestLoadExplicitRootControlsRelativeIdentity(t *testing.T) {
	root := t.TempDir()
	putFile(t, root, "roles/demo/defaults/main.yml", "value: ok\n")
	t.Chdir(root)
	p, err := Load(t.Context(), Options{Root: ".", Paths: []string{"roles/demo/defaults/main.yml"}})
	if err != nil || !p.Selected["roles/demo/defaults/main.yml"] {
		t.Fatalf("relative identity: %v %#v", err, p)
	}
}

func TestLoadTemplatesAreContextOnly(t *testing.T) {
	root := t.TempDir()
	template := putFile(t, root, "roles/demo/templates/config.j2", "{% if enabled %}\n{% endif %}")
	for _, opts := range []Options{{Paths: []string{root}}, {Paths: []string{template}}} {
		if p, err := Load(t.Context(), opts); err == nil {
			t.Errorf("template selection accepted: %#v", p)
		}
	}
}

func TestLoadBrokenGitMetadataIsAnError(t *testing.T) {
	root := t.TempDir()
	putFile(t, root, ".git", "gitdir: /missing/saltbox-lint-test-git-dir\n")
	putFile(t, root, "input.yml", "value: ok\n")
	if p, err := Load(t.Context(), Options{Paths: []string{root}}); err == nil {
		t.Fatalf("broken repository silently accepted: %#v", p)
	}
}

func TestLoadExplicitNestedRootUsesRelativeGitPaths(t *testing.T) {
	repository := t.TempDir()
	gitTest(t, repository, "init", "-q")
	putFile(t, repository, "outside.yml", "value: outside\n")
	root := filepath.Join(repository, "project")
	putFile(t, root, "tasks/input.yml", "value: inside\n")
	p, err := Load(t.Context(), Options{Root: root, Paths: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	if got := selectedPaths(p); !slices.Equal(got, []string{"tasks/input.yml"}) {
		t.Fatalf("nested root selection=%v", got)
	}
}

func TestLoadDirectoryExcludesNonAnsibleYAML(t *testing.T) {
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	putFile(t, root, "saltbox.yml", "- hosts: all\n")
	putFile(t, root, "roles/demo/tasks/main.yml", "- debug: msg=hello\n")
	for _, name := range []string{".github/workflows/check.yml", ".github/workflows/saltbox.yml", "roles/demo/files/payload.yml", "schemas/config.yaml", "requirements.yml", "generic.yml"} {
		putFile(t, root, name, "value: ok\n")
	}
	gitTest(t, root, "add", ".")
	p, err := Load(t.Context(), Options{Paths: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	if got := selectedPaths(p); !slices.Equal(got, []string{"roles/demo/tasks/main.yml", "saltbox.yml"}) {
		t.Fatalf("selected=%v", got)
	}
	p, err = Load(t.Context(), Options{Paths: []string{filepath.Join(root, "generic.yml")}})
	if err != nil || !p.Selected["generic.yml"] {
		t.Fatalf("explicit generic rejected: %v %#v", err, p)
	}
}

func TestLoadResourceRoleContext(t *testing.T) {
	root := t.TempDir()
	putFile(t, root, "saltbox.yml", "- hosts: all\n")
	selected := putFile(t, root, "resources/roles/dns/tasks/main.yml", "- debug: msg=hello\n")
	for _, name := range []string{"defaults", "handlers", "vars"} {
		putFile(t, root, "resources/roles/dns/"+name+"/main.yml", "value: ok\n")
	}
	putFile(t, root, "resources/roles/dns/templates/config.conf", "{% if enabled %}\n{% endif %}")
	p, err := Load(t.Context(), Options{Paths: []string{selected}})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Sources) != 5 || len(p.Selected) != 1 {
		t.Fatalf("resource role context=%#v", p)
	}
	for _, s := range p.Sources {
		if s.Role != "dns" || s.RolePath != "resources/roles/dns" || s.Kind == Generic {
			t.Errorf("resource role=%#v", s)
		}
	}
}

func TestLoadRootPlaybooksByStructure(t *testing.T) {
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	putFile(t, root, "backup.yml", "- hosts: localhost\n  vars_files:\n    - vars.yml\n  roles:\n    - backup\n")
	putFile(t, root, "maintenance.yaml", "- name: maintenance\n  hosts: all\n  roles: [cleanup]\n")
	putFile(t, root, "requirements.yml", "roles:\n  - name: third_party\n")
	putFile(t, root, "config.yml", "settings:\n  hosts: localhost\n")
	gitTest(t, root, "add", ".")
	p, err := Load(t.Context(), Options{Paths: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	if got := selectedPaths(p); !slices.Equal(got, []string{"backup.yml", "maintenance.yaml"}) {
		t.Fatalf("root playbooks=%v", got)
	}
	for _, s := range p.Sources {
		if s.Kind != Playbook {
			t.Errorf("playbook kind=%s", s.Kind)
		}
	}
}

func TestLoadInventoryDirectoryExcludesUnrelatedYAML(t *testing.T) {
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	for _, name := range []string{"inventories/production/group_vars/all.yml", "inventories/production/host_vars/server.yml", "inventories/production/requirements.yml", "inventories/notes/config.yml"} {
		putFile(t, root, name, "value: ok\n")
	}
	gitTest(t, root, "add", ".")
	p, err := Load(t.Context(), Options{Paths: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	if got := selectedPaths(p); !slices.Equal(got, []string{"inventories/production/group_vars/all.yml", "inventories/production/host_vars/server.yml"}) {
		t.Fatalf("inventory selection=%v", got)
	}
}

func TestLoadSymlinkedProjectPaths(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "project")
	putFile(t, root, "saltbox.yml", "- hosts: all\n")
	putFile(t, root, "roles/demo/tasks/main.yml", "- debug: msg=hello\n")
	link := filepath.Join(base, "project-link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(link, "roles/demo/tasks/main.yml")
	cases := []struct {
		name string
		opts Options
	}{
		{"inferred file", Options{Paths: []string{file}}},
		{"explicit root", Options{Root: link, Paths: []string{file}}},
		{"inferred directory", Options{Paths: []string{link}}},
		{"explicit directory", Options{Root: link, Paths: []string{link}}},
		{"duplicate lexical paths", Options{Paths: []string{file, filepath.Join(root, "roles/demo/tasks/main.yml")}}},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			p, err := Load(t.Context(), tt.opts)
			if err != nil {
				t.Fatal(err)
			}
			if p.Root != root || !p.Selected["roles/demo/tasks/main.yml"] {
				t.Fatalf("project identity=%#v", p)
			}
		})
	}
	for _, explicit := range []bool{false, true} {
		opts := Options{StdinFilename: filepath.Join(link, "roles/demo/tasks/unsaved/new.yml"), Stdin: []byte("- debug: msg=buffer\n")}
		if explicit {
			opts.Root = link
		}
		p, err := Load(t.Context(), opts)
		if err != nil {
			t.Fatal(err)
		}
		if p.Root != root || !p.Selected["roles/demo/tasks/unsaved/new.yml"] || string(p.Sources["roles/demo/tasks/unsaved/new.yml"].Data) != "- debug: msg=buffer\n" {
			t.Fatalf("stdin identity=%#v", p)
		}
	}
}

func TestLoadPreservesSymlinkFileProvenance(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "project")
	putFile(t, root, "saltbox.yml", "- hosts: all\n")
	actual := putFile(t, root, "roles/demo/tasks/main.yml", "- debug: msg=hello\n")
	alias := filepath.Join(root, "roles/demo/tasks/alias.yml")
	if err := os.Symlink(actual, alias); err != nil {
		t.Fatal(err)
	}
	rootLink := filepath.Join(base, "project-link")
	if err := os.Symlink(root, rootLink); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(rootLink, "roles/demo/tasks/alias.yml")
	for _, stdin := range []bool{false, true} {
		opts := Options{Paths: []string{target}}
		if stdin {
			opts.StdinFilename = target
			opts.Stdin = []byte("- debug: msg=buffer\n")
		}
		p, err := Load(t.Context(), opts)
		if err != nil {
			t.Fatal(err)
		}
		if !p.Selected["roles/demo/tasks/alias.yml"] || p.Selected["roles/demo/tasks/main.yml"] {
			t.Fatalf("symlink identity erased: %#v", p.Selected)
		}
		info, err := os.Lstat(filepath.Join(p.Root, filepath.FromSlash(p.Sources["roles/demo/tasks/alias.yml"].Path)))
		if err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("fix layer cannot detect original symlink: %v %v", info, err)
		}
	}
}
