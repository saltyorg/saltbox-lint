package lint

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestWriteChangesRejectsChangedSelectedOwners(t *testing.T) {
	for _, mutation := range []string{"template parent", "same inode template parent", "foreign identical file", "same inode new parent", "same inode replaced parent", "leaf alias", "missing", "escape", "directory", "source bytes", "root owner", "root alias", "administrative alias"} {
		for _, order := range []string{"first", "last", "unchanged"} {
			t.Run(mutation+"/"+order, func(t *testing.T) {
				root := t.TempDir()
				input := "v: \"{{ a\n | f }}\"\n"
				selected := "roles/demo/defaults/main.yaml"
				if order == "unchanged" {
					input = "v: true\n"
				}
				filename := putFile(t, root, selected, input)
				other := putFile(t, root, "other.yml", "v: \"{{ a\n | f }}\"\n")
				p, err := Load(t.Context(), Options{Root: root, Paths: []string{filename, other}})
				if err != nil {
					t.Fatal(err)
				}
				changes, err := PlanFixes(p, Analyze(p, jinjaRules()))
				if err != nil || len(changes) != map[bool]int{true: 1, false: 2}[order == "unchanged"] {
					t.Fatalf("plan: %+v %v", changes, err)
				}
				if order == "first" {
					slices.Reverse(changes)
				}
				var protected string
				parent := filepath.Dir(filename)
				switch mutation {
				case "same inode replaced parent":
					if err := os.Rename(parent, parent+".original"); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(parent, 0700); err != nil {
						t.Fatal(err)
					}
					if err := os.Rename(filepath.Join(parent+".original", "main.yaml"), filename); err != nil {
						t.Fatal(err)
					}
					protected = filename
				case "template parent", "same inode template parent", "same inode new parent":
					destination := filepath.Join(root, "roles/demo/templates")
					if mutation == "same inode new parent" {
						destination = filepath.Join(root, "replacement")
					}
					if mutation == "template parent" {
						putFile(t, root, "roles/demo/templates/main.yaml", input)
						if err := os.Rename(parent, parent+".original"); err != nil {
							t.Fatal(err)
						}
					} else if err := os.Rename(parent, destination); err != nil {
						t.Fatal(err)
					}
					alias, err := filepath.Rel(filepath.Dir(parent), destination)
					if err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(alias, parent); err != nil {
						t.Fatal(err)
					}
					protected = filepath.Join(destination, "main.yaml")
				case "foreign identical file", "leaf alias", "escape", "administrative alias":
					if err := os.Rename(filename, filename+".original"); err != nil {
						t.Fatal(err)
					}
					if mutation == "foreign identical file" {
						if err := os.WriteFile(filename, []byte(input), 0600); err != nil {
							t.Fatal(err)
						}
						protected = filename
					} else {
						protected = putFile(t, root, "target.yaml", input)
						if mutation == "escape" {
							protected = putFile(t, t.TempDir(), "target.yaml", input)
						}
						if mutation == "administrative alias" {
							protected = putFile(t, root, ".git/admin.yaml", input)
						}
						if err := os.Symlink(protected, filename); err != nil {
							t.Fatal(err)
						}
					}
				case "missing", "directory":
					if err := os.Remove(filename); err != nil {
						t.Fatal(err)
					}
					if mutation == "directory" {
						if err := os.Mkdir(filename, 0700); err != nil {
							t.Fatal(err)
						}
					}
				case "source bytes":
					if err := os.WriteFile(filename, []byte("v: changed\n"), 0600); err != nil {
						t.Fatal(err)
					}
				case "root owner", "root alias":
					moved := root + ".moved"
					if err := os.Rename(root, moved); err != nil {
						t.Fatal(err)
					}
					defer func() {
						if err := os.Rename(moved, root); err != nil {
							t.Error(err)
						}
					}()
					if mutation == "root alias" {
						if err := os.Symlink(moved, root); err != nil {
							t.Fatal(err)
						}
						defer func() {
							if err := os.Remove(root); err != nil {
								t.Error(err)
							}
						}()
						break
					}
					if err := os.Mkdir(root, 0700); err != nil {
						t.Fatal(err)
					}
					defer func() {
						if err := os.RemoveAll(root); err != nil {
							t.Error(err)
						}
					}()
					putFile(t, root, selected, input)
					putFile(t, root, "other.yml", "v: \"{{ a\n | f }}\"\n")
				}
				// A no-change source is still a selected owner. Its retargeting must
				// prevent writing the other batch member as well.
				if err := WriteChanges(p, changes); err == nil {
					t.Fatal("changed selected owner authorized a write")
				} else {
					t.Logf("refused batch: %v", err)
				}
				actual, err := os.ReadFile(other)
				if err != nil || !bytes.Equal(actual, []byte("v: \"{{ a\n | f }}\"\n")) {
					t.Fatalf("batch member changed: %q %v", actual, err)
				}
				if protected != "" {
					actual, err := os.ReadFile(protected)
					if err != nil || string(actual) != input {
						t.Fatalf("retargeted bytes changed: %q %v", actual, err)
					}
				}
			})
		}
	}
}

func TestWriteChangesRequiresOpenedReadIdentity(t *testing.T) {
	root := t.TempDir()
	input := "v: \"{{ a\n | f }}\"\n"
	filename := putFile(t, root, "values.yml", input)
	p := layoutProject(t, input)
	p.Root = root
	changes, err := PlanFixes(p, Analyze(p, jinjaRules()))
	if err != nil || len(changes) != 1 {
		t.Fatalf("plan: %+v %v", changes, err)
	}
	if err := WriteChanges(p, changes); err == nil {
		t.Fatal("parsed bytes authorized a physical write")
	}
	actual, err := os.ReadFile(filename)
	if err != nil || string(actual) != input {
		t.Fatal("unadmitted source changed")
	}
	admitWriteTestSources(t, p)
	if err := WriteChanges(p, changes); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(t.Context(), Options{Root: root, Paths: []string{filename}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := PlanFixes(loaded, Analyze(loaded, jinjaRules()))
	if err != nil || len(second) != 0 {
		t.Fatalf("stable admitted correction not idempotent: %+v %v", second, err)
	}
}

func TestReplacementRechecksAdmittedOwner(t *testing.T) {
	root := t.TempDir()
	input := "v: \"{{ a\n | f }}\"\n"
	filename := putFile(t, root, "roles/demo/defaults/main.yaml", input)
	p, err := Load(t.Context(), Options{Root: root, Paths: []string{filename}})
	if err != nil {
		t.Fatal(err)
	}
	changes, err := PlanFixes(p, Analyze(p, jinjaRules()))
	if err != nil || len(changes) != 1 {
		t.Fatalf("plan: %+v %v", changes, err)
	}
	if err := RequireWritableSelection(p); err != nil {
		t.Fatal(err)
	}
	files, err := os.OpenRoot(p.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	}()
	parent := filepath.Dir(filename)
	if err := os.Rename(parent, filepath.Join(filepath.Dir(parent), "templates")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("templates", parent); err != nil {
		t.Fatal(err)
	}
	if err := replaceFile(p.Root, files, changes[0].Path, changes[0], p.Sources[changes[0].Path].diskIdentity); err == nil {
		t.Fatal("late replacement retarget wrote a template")
	}
	actual, err := os.ReadFile(filename)
	if err != nil || string(actual) != input {
		t.Fatal("late replacement changed template bytes")
	}
}

func TestWriteChangesStableDirectoryAliasAtAdmission(t *testing.T) {
	root := t.TempDir()
	input := "v: \"{{ a\n | f }}\"\n"
	filename := putFile(t, root, "roles/demo/defaults/main.yaml", input)
	if err := os.Symlink(filepath.Join("roles", "demo", "defaults"), filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	p, err := Load(t.Context(), Options{Root: root, Paths: []string{filepath.Join(root, "alias/main.yaml")}})
	if err != nil {
		t.Fatal(err)
	}
	changes, err := PlanFixes(p, Analyze(p, jinjaRules()))
	if err != nil || len(changes) != 1 || changes[0].Path != "roles/demo/defaults/main.yaml" {
		t.Fatalf("admitted path lost: %+v %v", changes, err)
	}
	if err := WriteChanges(p, changes); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(filename)
	if err != nil || !bytes.Equal(actual, changes[0].After) {
		t.Fatalf("stable alias correction lost: %q %v", actual, err)
	}
}
