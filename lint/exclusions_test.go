package lint

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestConfigurationExcludesFoldersAndFilesFromEverySelection(t *testing.T) {
	for _, git := range []bool{false, true} {
		t.Run(fmt.Sprintf("git=%v", git), func(t *testing.T) {
			root := t.TempDir()
			if git {
				gitTest(t, root, "init", "-q")
			}
			putFile(t, root, ".saltbox-lint", "exclude_paths: [roles/backup/, tasks/generated.yml]\n")
			const bad = "broken: [\n"
			ignored := putFile(t, root, "roles/backup/defaults/main.yml", bad)
			putFile(t, root, "tasks/generated.yml", bad)
			putFile(t, root, "roles/backup_extra/defaults/main.yml", "backup_extra_name: visible\n")
			for _, mode := range []string{"root", "folder", "file", "stdin"} {
				t.Run(mode, func(t *testing.T) {
					options := Options{Root: root, IncludeAnalysis: true}
					switch mode {
					case "root":
						options.Paths = []string{root}
					case "folder":
						options.Paths = []string{filepath.Join(root, "roles/backup")}
					case "file":
						options.Paths = []string{ignored}
					case "stdin":
						options.StdinFilename, options.Stdin = ignored, []byte(bad)
					}
					project, err := Load(t.Context(), options)
					if err != nil {
						t.Fatal(err)
					}
					if mode == "root" {
						if got := selectedPaths(project); !slices.Equal(got, []string{"roles/backup_extra/defaults/main.yml"}) {
							t.Fatalf("folder exclusion crossed a path boundary: %v", got)
						}
						if _, present := project.Sources["roles/backup/defaults/main.yml"]; present {
							t.Fatal("excluded directory source was loaded")
						}
					} else if mode == "file" || mode == "stdin" {
						source := project.Sources["roles/backup/defaults/main.yml"]
						if source == nil || source.ExclusionReason == "" || len(source.Documents) != 0 || len(project.Diagnostics) != 0 {
							t.Fatal("explicit excluded bytes were parsed")
						}
						if len(Analyze(project, Rules())) != 0 || len(project.Sources) != 1 || len(project.Dependencies.Sources) != 1 {
							t.Fatal("excluded snapshot was linted or admitted context")
						}
						if err := RequireWritableSelection(project); mode == "file" && err != nil {
							t.Fatal(err)
						}
						changes, err := PlanFixes(project, Analyze(project, Rules()))
						if err != nil || len(changes) != 0 {
							t.Fatalf("excluded source received edits: %v %v", changes, err)
						}
					} else if len(project.Selected) != 0 {
						t.Fatal("explicit excluded directory was scanned")
					}
					actual, err := os.ReadFile(ignored)
					if err != nil || !bytes.Equal(actual, []byte(bad)) {
						t.Fatal("excluded source bytes changed")
					}
				})
			}
		})
	}
}

func TestExclusionsCannotBeBypassedByFileAliases(t *testing.T) {
	root := t.TempDir()
	putFile(t, root, ".saltbox-lint", "exclude_paths: [roles/hidden]\n")
	owner := putFile(t, root, "roles/hidden/defaults/main.yml", "broken: [\n")
	alias := filepath.Join(root, "alias.yml")
	if err := os.Symlink(owner, alias); err != nil {
		t.Fatal(err)
	}
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{alias}})
	if err != nil || len(Analyze(project, Rules())) != 0 || project.Sources["alias.yml"].ExclusionReason == "" {
		t.Fatalf("alias bypassed exclusion: %v", err)
	}
	identity, err := ResolveSourceIdentity(root, alias)
	if err != nil {
		t.Fatal(err)
	}
	if reason, err := SourceExclusion(t.Context(), identity); err != nil || reason == "" {
		t.Fatalf("format policy lost owner exclusion: %q %v", reason, err)
	}
}

func TestGitIgnoredAliasDoesNotReadAnOutsideOwner(t *testing.T) {
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	putFile(t, root, ".gitignore", "tasks/hidden.yml\n")
	putFile(t, root, "tasks/visible.yml", "[]\n")
	owner := putFile(t, t.TempDir(), "outside.yml", "value: [\n")
	if err := os.Symlink(owner, filepath.Join(root, "tasks/hidden.yml")); err != nil {
		t.Fatal(err)
	}
	gitTest(t, root, "add", "-f", "tasks/hidden.yml")
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{root}})
	if err != nil || project.Sources["tasks/hidden.yml"] != nil {
		t.Fatalf("ignored alias was admitted: %v", err)
	}
	putFile(t, root, ".gitignore", "")
	if _, err := Load(t.Context(), Options{Root: root, Paths: []string{root}}); !errors.Is(err, errOutsideRoot) {
		t.Fatalf("an unignored alias escaped source ownership: %v", err)
	}
}

func TestExcludedDeclarationsDoNotParticipateInDuplicates(t *testing.T) {
	root := t.TempDir()
	putFile(t, root, ".saltbox-lint", "exclude_paths: [roles/hidden, vars.yml]\n")
	primary := putFile(t, root, "roles/active/defaults/main.yml", "active_shared: yes\n")
	putFile(t, root, "roles/hidden/defaults/main.yml", "active_shared: yes\n")
	putFile(t, root, "vars.yml", "active_shared: yes\n")
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{primary}, IncludeAnalysis: true})
	if err != nil || len(Analyze(project, duplicateRules())) != 0 {
		t.Fatalf("excluded context established a duplicate: %v", err)
	}
	if project.Sources["roles/hidden/defaults/main.yml"] != nil || project.Sources["vars.yml"] != nil {
		t.Fatal("excluded context was read")
	}
	putFile(t, root, "roles/visible/defaults/main.yml", "active_shared: yes\n")
	project, err = Load(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil || len(Analyze(project, duplicateRules())) != 1 {
		t.Fatalf("exclusions suppressed a visible duplicate: %v", err)
	}
}

func TestExcludedContextDoesNotInspectForeignAliases(t *testing.T) {
	root := t.TempDir()
	putFile(t, root, ".saltbox-lint", "exclude_paths: [group_vars, vars.yml]\n")
	primary := putFile(t, root, "roles/active/defaults/main.yml", "active_name: active\n")
	outside := t.TempDir()
	owner := putFile(t, outside, "vars.yml", "foreign: [\n")
	if err := os.Symlink(owner, filepath.Join(root, "vars.yml")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "group_vars")); err != nil {
		t.Fatal(err)
	}
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{primary}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range project.Dependencies.Sources {
		for _, file := range source.Files {
			if file.Path == "vars.yml" {
				t.Fatal("excluded context retained a file dependency")
			}
		}
		for _, directory := range source.Directories {
			if directory.Path == "group_vars" {
				t.Fatal("excluded context retained a directory dependency")
			}
		}
	}
}

func TestGitIgnoresTrackedFilesNestedRulesAndExplicitBuffers(t *testing.T) {
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	putFile(t, root, ".saltbox-lint", "")
	putFile(t, root, ".gitignore", "tasks/hidden/\ntasks/*.yml\n!tasks/visible.yml\n")
	const input = "value: [\n"
	ignored := putFile(t, root, "tasks/hidden/main.yml", input)
	putFile(t, root, "tasks/tracked.yml", input)
	putFile(t, root, "tasks/space name.yml", input)
	putFile(t, root, "tasks/visible.yml", "[]\n")
	putFile(t, root, "tasks/nested/.gitignore", "*.yml\n!keep.yml\n")
	putFile(t, root, "tasks/nested/drop.yml", input)
	putFile(t, root, "tasks/nested/keep.yml", "[]\n")
	gitTest(t, root, "add", "-f", "tasks")
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	if got := selectedPaths(project); !slices.Equal(got, []string{"tasks/nested/keep.yml", "tasks/visible.yml"}) {
		t.Fatalf("Git policy or negation mismatch: %v", got)
	}
	for _, stdin := range []bool{false, true} {
		options := Options{Root: root, IncludeAnalysis: true}
		if stdin {
			options.StdinFilename, options.Stdin = ignored, []byte(input)
		} else {
			options.Paths = []string{ignored}
		}
		project, err := Load(t.Context(), options)
		if err != nil || len(Analyze(project, Rules())) != 0 || project.Sources["tasks/hidden/main.yml"].ExclusionReason == "" {
			t.Fatalf("explicit selection bypassed Git ignores: %v", err)
		}
	}
}

func TestGitIgnoreNulRecordsDoNotRequireWorktreeFiles(t *testing.T) {
	root, err := canonicalDirectory(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gitTest(t, root, "init", "-q")
	putFile(t, root, ".gitignore", "tasks/*.yml\n")
	if err := os.Mkdir(filepath.Join(root, "tasks"), 0755); err != nil {
		t.Fatal(err)
	}
	// Git can match these names without opening a worktree file. This tests
	// NUL-delimited transport on Windows too, where newline filenames cannot
	// be created through the filesystem API.
	paths := []string{
		filepath.Join(root, "tasks/space name.yml"),
		filepath.Join(root, "tasks/line\nname.yml"),
	}
	loader := sourceLoader{ctx: t.Context(), project: &Project{Root: root}, gitRoot: root}
	reasons, err := loader.exclusionReasons(paths)
	if err != nil {
		t.Fatal(err)
	}
	if len(reasons) != len(paths) {
		t.Fatalf("Git ignore records were split or lost: %v", reasons)
	}
	for _, path := range paths {
		if reasons[path] != "excluded by Git ignore rules" {
			t.Fatalf("missing exact Git ignore record for %q", path)
		}
	}
}

func TestExclusionChangesRefreshSelectedAndChangedChecks(t *testing.T) {
	root := changedFixture(t)
	name := "roles/demo/defaults/main.yml"
	file := putFile(t, root, name, "demo_role_value: '{{ value\n }}'\n")
	putFile(t, root, ".saltbox-lint", "{}\n")
	commitChangedFixture(t, root)
	var generation string
	for _, excluded := range []bool{false, true, false} {
		configuration := "{}\n"
		if excluded {
			configuration = "exclude_paths: [roles/demo]\n"
		}
		putFile(t, root, ".saltbox-lint", configuration)
		project, err := Load(t.Context(), Options{Root: root, Paths: []string{file}, IncludeAnalysis: true})
		if err != nil {
			t.Fatal(err)
		}
		if (project.Sources[name].ExclusionReason != "") != excluded || project.Dependencies.Generation == generation {
			t.Fatal("saved exclusion did not change source admission and generation")
		}
		generation = project.Dependencies.Generation
		changed := loadChangedTest(t, root, "HEAD")
		if excluded && changed.Selected[name] {
			t.Fatal("changed-file selection admitted an excluded source")
		}
	}
}

func TestExcludedSourceQueriesAndExplanations(t *testing.T) {
	root := t.TempDir()
	putFile(t, root, ".saltbox-lint", "exclude_paths: [roles/hidden]\n")
	const input = "hidden_port: '{{ lookup(\"role_var\", \"_port\", role=\"visible\") }}'\n"
	file := putFile(t, root, "roles/hidden/defaults/main.yml", input)
	putFile(t, root, "roles/visible/defaults/main.yml", "visible_role_port: 1234\n")
	putFile(t, root, "inventory.yml", "broken: [\n")
	for _, operation := range []string{"definition", "completion", "hover", "references"} {
		result, err := Query(t.Context(), QueryRequest{Root: root, Filename: file, Source: []byte(input), Operation: operation})
		if err != nil || result.State != "unavailable" || !slices.Contains(result.Reasons, "source-excluded") || len(result.Locations) != 0 || len(result.Dependencies.Sources) != 1 {
			t.Fatalf("excluded %s query: %+v %v", operation, result, err)
		}
	}
	references, err := References(t.Context(), Options{Root: root, Paths: []string{file}})
	if err != nil || len(references.References) != 0 || len(references.LoadedContext) != 0 || references.Sources[0].ParseState != "excluded" {
		t.Fatalf("excluded references loaded context: %+v %v", references, err)
	}
	explanation, err := Explain(t.Context(), Options{Root: root, Paths: []string{file}})
	if err != nil || explanation.Source.ParseState != "excluded" || len(explanation.ApplicablePolicies) != 0 || explanation.DirectoryWouldSelect {
		t.Fatalf("exclusion explanation: %+v %v", explanation, err)
	}
}

func TestExcludedTemplatesAreNotScanned(t *testing.T) {
	root := t.TempDir()
	putFile(t, root, ".saltbox-lint", "exclude_paths: [roles/hidden/templates]\n")
	file := putFile(t, root, "roles/hidden/templates/config.j2", "{{ lookup('role_var', '_port', role='visible') }}\n")
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{file}})
	if err != nil {
		t.Fatal(err)
	}
	source := project.Sources["roles/hidden/templates/config.j2"]
	if source == nil || source.ExclusionReason == "" {
		t.Fatal("template exclusion was not admitted")
	}
	if len(Expressions(source)) != 0 || len(RuntimeExpressions(source)) != 0 || len(scanTemplate(source).expressions) != 0 {
		t.Fatal("excluded template bytes reached the raw expression scanner")
	}
	result, err := References(t.Context(), Options{Root: root, Paths: []string{file}})
	if err != nil || len(result.References) != 0 || len(result.LoadedContext) != 0 {
		t.Fatalf("excluded template exposed static references: %+v %v", result, err)
	}
}
