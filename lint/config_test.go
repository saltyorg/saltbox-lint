package lint

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestNamespaceSharingIsDirectional(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		".saltbox-lint":                  "namespace_sharing:\n  remote: [rclone]\n",
		"roles/remote/defaults/main.yml": "remote_name: remote\nrclone_config_path: supplied\nrclone_role_enabled: true\n",
		"roles/rclone/defaults/main.yml": "rclone_name: rclone\nremote_extra: forbidden\n",
		"roles/other/defaults/main.yml":  "rclone_extra: forbidden\n",
	}
	for name, input := range files {
		writeTestSource(t, filepath.Join(root, name), input)
	}
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{root}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	diagnostics := Analyze(project, prefixRules())
	if len(diagnostics) != 2 || diagnostics[0].Path != "roles/other/defaults/main.yml" || diagnostics[1].Path != "roles/rclone/defaults/main.yml" {
		t.Fatalf("sharing widened beyond the configured direction: %+v", diagnostics)
	}
	writeTestSource(t, filepath.Join(root, "vars.yml"), "rclone_config_path: duplicate\n")
	project, err = Load(t.Context(), Options{Paths: []string{filepath.Join(root, "roles/remote/defaults/main.yml")}})
	if err != nil {
		t.Fatal(err)
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if project.Root != canonicalRoot {
		t.Fatalf("config marker did not establish source root: %s", project.Root)
	}
	if diagnostics := Analyze(project, duplicateRules()); len(diagnostics) != 1 {
		t.Fatalf("sharing suppressed an actual duplicate: %+v", diagnostics)
	}
}

func TestProjectConfigurationValidation(t *testing.T) {
	for _, test := range []struct {
		name, input string
		valid       bool
	}{
		{"empty marker", "", true},
		{"comments", "# Enable extension\n", true},
		{"empty mapping", "{}\n", true},
		{"sharing", "namespace_sharing:\n  remote: [rclone, user]\n", true},
		{"unknown key", "namespace_sharng: {}\n", false},
		{"malformed YAML", "namespace_sharing: [\n", false},
		{"sequence root", "- remote\n", false},
		{"scalar root", "remote\n", false},
		{"multiple documents", "{}\n---\n{}\n", false},
		{"wrong sharing shape", "namespace_sharing: []\n", false},
		{"wrong permission shape", "namespace_sharing: {remote: rclone}\n", false},
		{"invalid role", "namespace_sharing: {../remote: [rclone]}\n", false},
		{"invalid namespace", "namespace_sharing: {remote: ['rclone*']}\n", false},
		{"nonstring namespace", "namespace_sharing: {remote: [true]}\n", false},
		{"duplicate root key", "namespace_sharing: {}\nnamespace_sharing: {}\n", false},
		{"duplicate role", "namespace_sharing: {remote: [rclone], remote: [user]}\n", false},
		{"duplicate permission", "namespace_sharing: {remote: [rclone, rclone]}\n", false},
		{"alias", "namespace_sharing: {remote: &shared [rclone], other: *shared}\n", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			writeTestSource(t, filepath.Join(root, ".saltbox-lint"), test.input)
			writeTestSource(t, filepath.Join(root, "roles/example/defaults/main.yml"), "example_name: example\n")
			_, err := Load(t.Context(), Options{Root: root, Paths: []string{root}})
			if (err == nil) != test.valid {
				t.Fatalf("config valid=%v, error=%v", test.valid, err)
			}
			if err != nil && !strings.Contains(err.Error(), ".saltbox-lint") {
				t.Fatalf("configuration error lacks its filename: %v", err)
			}
		})
	}
}

func TestConfigurationDependencyLifecycle(t *testing.T) {
	root := changedFixture(t)
	const source = "roles/remote/defaults/main.yml"
	putFile(t, root, source, "rclone_config_path: value\n")
	putFile(t, root, "roles/rclone/defaults/main.yml", "rclone_name: rclone\n")
	commitChangedFixture(t, root)
	options := Options{Root: root, Paths: []string{filepath.Join(root, source)}, IncludeAnalysis: true}
	var previous string
	for _, contents := range []string{"missing", "namespace_sharing: {remote: [rclone]}\n", "{}\n", "missing"} {
		if contents == "missing" {
			if err := os.Remove(filepath.Join(root, ".saltbox-lint")); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
		} else {
			putFile(t, root, ".saltbox-lint", contents)
		}
		project, err := Load(t.Context(), options)
		if err != nil {
			t.Fatal(err)
		}
		files := project.Dependencies.Sources[0].Files
		if !slices.ContainsFunc(files, func(file DependencyFile) bool {
			return file.Path == ".saltbox-lint" && ((contents == "missing" && file.State == "missing") || (contents != "missing" && file.State == "read" && file.SHA256 != ""))
		}) {
			t.Fatalf("configuration is absent from dependencies: %+v", files)
		}
		if project.Dependencies.Generation == previous {
			t.Fatal("configuration edit retained stale dependency generation")
		}
		previous = project.Dependencies.Generation
		want := 1
		if strings.Contains(contents, "remote") {
			want = 0
		}
		if diagnostics := Analyze(project, prefixRules()); len(diagnostics) != want {
			t.Fatalf("configuration change did not refresh findings: %+v", diagnostics)
		}
		if contents != "missing" {
			changed := loadChangedTest(t, root, "HEAD")
			if !changed.Selected[source] {
				t.Fatalf("configuration change did not select dependent defaults: %+v", changed.Selection)
			}
		}
	}
}

func TestProjectConfigurationRequiresBoundedRegularFile(t *testing.T) {
	for _, kind := range []string{"directory", "oversized"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			filename := filepath.Join(root, ".saltbox-lint")
			if kind == "directory" {
				if err := os.Mkdir(filename, 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				writeTestSource(t, filename, "#"+strings.Repeat("x", 1<<20))
			}
			writeTestSource(t, filepath.Join(root, "inventory.yml"), "shared: value\n")
			if _, err := Load(t.Context(), Options{Root: root, Paths: []string{root}}); err == nil || !strings.Contains(err.Error(), ".saltbox-lint") {
				t.Fatalf("invalid configuration control was admitted: %v", err)
			}
		})
	}
}
