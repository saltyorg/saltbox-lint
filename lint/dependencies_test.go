package lint

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestDependencyRecordsCoverCleanAndInvalidSources(t *testing.T) {
	root := t.TempDir()
	clean := putFile(t, root, "clean.yml", "value: 1\n")
	broken := putFile(t, root, "broken.yml", "value: [\n")
	p, err := Load(t.Context(), Options{Root: root, Paths: []string{clean, broken}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Dependencies.Sources) != 2 || !p.Dependencies.Complete {
		t.Fatalf("records: %+v", p.Dependencies)
	}
	for _, record := range p.Dependencies.Sources {
		if record.SourceSHA256 != fmt.Sprintf("%x", sha256.Sum256(p.Sources[record.Path].Data)) {
			t.Fatal("hash differs from original bytes")
		}
	}
	if len(Analyze(p, Rules())) != 1 {
		t.Fatal("clean and parse findings changed")
	}
}

func TestDependencyContextAndNegativeObservations(t *testing.T) {
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	putFile(t, root, ".gitignore", "roles/demo/templates/ignored.conf\n")
	source := putFile(t, root, "roles/demo/tasks/main.yml", "- template: {src: missing.conf, dest: /tmp/out}\n- template: {src: ignored.conf, dest: /tmp/out}\n- template: {src: '{{ dynamic }}', dest: /tmp/out}\n")
	putFile(t, root, "roles/demo/defaults/main.yml", "demo_role_enabled: true\n")
	putFile(t, root, "roles/demo/templates/ignored.conf", "ignored\n")
	putFile(t, root, "roles/other/defaults/main.yml", "other_role_enabled: true\n")
	load := func() *Project {
		p, err := Load(t.Context(), Options{Root: root, Paths: []string{source}, IncludeAnalysis: true})
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	p := load()
	record := p.Dependencies.Sources[0]
	states := map[string]string{}
	for _, file := range append(record.Files, record.Identity...) {
		states[file.Path] = file.State
		if strings.Contains(file.Path, "dynamic") {
			t.Fatal("dynamic template became dependency")
		}
	}
	if states["roles/demo/templates/missing.conf"] != "missing" || states["roles/demo/templates/ignored.conf"] != "unavailable" || states["saltbox.yml"] != "missing" {
		t.Fatalf("states: %v", states)
	}
	if len(record.Directories) != 5 {
		t.Fatalf("directories: %v", record.Directories)
	}
	if p.Sources["roles/other/defaults/main.yml"] != nil {
		t.Fatal("unrelated role read")
	}
	before := p.Dependencies.Generation
	template := putFile(t, root, "roles/demo/templates/missing.conf", "{{ demo_role_traefik_api_enabled }}\n")
	p = load()
	if before == p.Dependencies.Generation || p.Sources["roles/demo/templates/missing.conf"] == nil {
		t.Fatal("non-j2 template creation not observed")
	}
	bytes, err := os.ReadFile(template)
	if err != nil {
		t.Fatal(err)
	}
	if string(bytes) != "{{ demo_role_traefik_api_enabled }}\n" {
		t.Fatal("template changed")
	}
	before = p.Dependencies.Generation
	putFile(t, root, "saltbox.yml", "[]\n")
	if load().Dependencies.Generation == before {
		t.Fatal("project marker creation not observed")
	}
}

func TestDependencySharedDockerAndSelectedParity(t *testing.T) {
	root := t.TempDir()
	source := putFile(t, root, "resources/tasks/docker/main.yml", "- debug: {msg: '{{ _docker_vars._docker_memory | default(0) }}'}\n")
	putFile(t, root, "resources/tasks/docker/policy.yml", "value: [\n")
	selected, err := Load(t.Context(), Options{Root: root, Paths: []string{source}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	full, err := Load(t.Context(), Options{Root: root, Paths: []string{root}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	got := Analyze(selected, Rules())
	all := Analyze(full, Rules())
	var want []Diagnostic
	for _, d := range all {
		if d.Path == "resources/tasks/docker/main.yml" {
			want = append(want, d)
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("selected/full mismatch: %v %v", got, want)
	}
	dirs := selected.Dependencies.Sources[0].Directories
	if len(dirs) != 1 || dirs[0].Path != "resources/tasks/docker" || len(dirs[0].Members) != 2 {
		t.Fatalf("shared: %+v", dirs)
	}
	before := selected.Dependencies.Generation
	if err := os.Rename(filepath.Join(root, "resources/tasks/docker/policy.yml"), filepath.Join(root, "resources/tasks/docker/replaced.yaml")); err != nil {
		t.Fatal(err)
	}
	next, err := Load(t.Context(), Options{Root: root, Paths: []string{source}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	if before == next.Dependencies.Generation {
		t.Fatal("rename not observed")
	}
}

func TestGitStatusMetadataDoesNotInvalidatePolicyGeneration(t *testing.T) {
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	source := putFile(t, root, "roles/demo/tasks/main.yml", "[]\n")
	gitTest(t, root, "add", ".")
	load := func() *Project {
		p, err := Load(t.Context(), Options{Root: root, Paths: []string{source}, IncludeAnalysis: true})
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	before := load().Dependencies.Generation
	gitTest(t, root, "status", "--short")
	if after := load().Dependencies.Generation; after != before {
		t.Fatalf("status metadata changed generation: %s %s", before, after)
	}
	for _, source := range load().Dependencies.Sources {
		for _, file := range source.Discovery {
			if file.Path == ".git/index" {
				t.Fatal("index cache bytes became policy input")
			}
		}
	}
}

func TestEscapedNegativeDependencyIsUnavailable(t *testing.T) {
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	putFile(t, root, ".gitignore", "roles/demo/templates/nested\n")
	source := putFile(t, root, "roles/demo/tasks/main.yml", "- template: {src: nested/missing.conf, dest: /tmp/out}\n")
	putFile(t, root, "roles/demo/templates/owned.conf", "owned\n")
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "roles/demo/templates/nested")); err != nil {
		t.Fatal(err)
	}
	p, err := Load(t.Context(), Options{Root: root, Paths: []string{source}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range p.Dependencies.Sources[0].Files {
		if file.Path == "roles/demo/templates/nested/missing.conf" {
			if file.State != "unavailable" || file.SHA256 != "" {
				t.Fatalf("escaped negative lookup: %#v", file)
			}
			return
		}
	}
	t.Fatal("missing negative dependency")
}
