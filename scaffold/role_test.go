package scaffold

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func repository(t *testing.T, project string) Options {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Unicode root 🌨")
	if err := os.MkdirAll(filepath.Join(root, "roles"), 0o755); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.CommandContext(t.Context(), "git", "init", "--quiet", root).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	if err := os.WriteFile(filepath.Join(root, project+".yml"), []byte("---\n[]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return Options{Root: root, Name: "my_role", Title: "My project 🌨", Author: "someone", URL: "https://example.com/project"}
}

func TestRolePreviewAndWriteRegistry(t *testing.T) {
	for _, project := range []string{"saltbox", "sandbox"} {
		t.Run(project, func(t *testing.T) {
			options := repository(t, project)
			if project == "sandbox" {
				options.Author = ""
			}
			plan, err := Role(t.Context(), options)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Lstat(filepath.Join(options.Root, "roles", options.Name)); !os.IsNotExist(err) {
				t.Fatalf("preview changed filesystem: %v", err)
			}
			files := plan.Files()
			if len(files) != 2 || files[0].Path != "roles/my_role/defaults/main.yml" || files[1].Path != "roles/my_role/tasks/main.yml" {
				t.Fatalf("proposed paths: %+v", files)
			}
			if project == "sandbox" && !strings.Contains(files[0].Content, "# Author(s): salty\n") {
				t.Fatal("missing Sandbox attribution")
			}
			// The public copy cannot replace the authoritative proposed content.
			files[0].Content = "invalid: [\n"
			created, err := plan.Write(t.Context())
			if err != nil {
				t.Fatalf("write: %v; created %v", err, created)
			}
			wantPaths := []string{"roles/my_role/", "roles/my_role/defaults/", "roles/my_role/defaults/main.yml", "roles/my_role/tasks/", "roles/my_role/tasks/main.yml"}
			if !reflect.DeepEqual(created, wantPaths) {
				t.Fatalf("created: %v", created)
			}
			for _, file := range plan.Files() {
				data, err := os.ReadFile(filepath.Join(plan.Root(), filepath.FromSlash(file.Path)))
				if err != nil || string(data) != file.Content {
					t.Fatalf("created content %s: %q, %v", file.Path, data, err)
				}
			}
			loaded, err := lint.Load(t.Context(), lint.Options{Root: plan.Root(), Paths: []string{filepath.Join(plan.Root(), "roles", options.Name)}})
			if err != nil {
				t.Fatal(err)
			}
			if loaded.Name != project || len(loaded.Sources) != 2 || len(lint.Analyze(loaded, lint.Rules())) != 0 {
				t.Fatalf("complete actual registry: %+v", lint.Analyze(loaded, lint.Rules()))
			}
			if again, err := plan.Write(t.Context()); err == nil || len(again) != 0 {
				t.Fatalf("repeated write: %v %v", again, err)
			}
		})
	}
}

func TestRoleRejectsNamesAndMetadata(t *testing.T) {
	options := repository(t, "saltbox")
	for _, name := range []string{"", "..", "../escape", "a/b", `a\b`, "/outside", "UPPER", "snow🌨", "a-b", "con", "lpt1", "_invalid", "a__b", strings.Repeat("a", 129)} {
		t.Run("name_"+name, func(t *testing.T) {
			changed := options
			changed.Name = name
			if _, err := Role(t.Context(), changed); err == nil {
				t.Fatalf("accepted name %q", name)
			} else if name == "a__b" && !strings.Contains(err.Error(), "[role-directory-name]") {
				t.Fatalf("name policy bypassed registry: %v", err)
			}
		})
	}
	for _, test := range []struct{ field, value string }{
		{"Title", ""}, {"Author", ""}, {"URL", ""}, {"Root", ""}, {"Title", "injected\n# Author(s): fake"},
		{"Author", "a\rfoo"}, {"Title", " leading"}, {"Title", "a\u2028b"}, {"Title", "\xff"}, {"Author", "a\u202eb"},
		{"URL", "ftp://example.com"}, {"URL", "https://"}, {"URL", "https://example.com/a b"},
	} {
		t.Run(test.field+test.value, func(t *testing.T) {
			changed := options
			reflect.ValueOf(&changed).Elem().FieldByName(test.field).SetString(test.value)
			if _, err := Role(t.Context(), changed); err == nil {
				t.Fatalf("accepted %s=%q", test.field, test.value)
			}
		})
	}
	if entries, err := os.ReadDir(filepath.Join(options.Root, "roles")); err != nil || len(entries) != 0 {
		t.Fatalf("invalid inputs created roles: %v %v", entries, err)
	}
	sandbox := repository(t, "sandbox")
	if _, err := Role(t.Context(), sandbox); err == nil {
		t.Fatal("accepted conflicting Sandbox attribution")
	}
}

func TestRoleRejectsAmbiguousAbsentAndExistingTargets(t *testing.T) {
	for _, mode := range []string{"ambiguous", "missing_marker", "missing_roles", "existing_role", "existing_defaults", "nonregular_marker"} {
		t.Run(mode, func(t *testing.T) {
			options := repository(t, "saltbox")
			var err error
			switch mode {
			case "ambiguous":
				err = os.WriteFile(filepath.Join(options.Root, "sandbox.yml"), []byte("[]\n"), 0o644)
			case "missing_marker":
				err = os.Remove(filepath.Join(options.Root, "saltbox.yml"))
			case "missing_roles":
				err = os.Remove(filepath.Join(options.Root, "roles"))
			case "existing_role":
				err = os.WriteFile(filepath.Join(options.Root, "roles", options.Name), []byte("keep"), 0o644)
			case "existing_defaults":
				err = os.MkdirAll(filepath.Join(options.Root, "roles", options.Name, "defaults"), 0o755)
			case "nonregular_marker":
				if err = os.Remove(filepath.Join(options.Root, "saltbox.yml")); err == nil {
					err = os.Mkdir(filepath.Join(options.Root, "saltbox.yml"), 0o755)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Role(t.Context(), options); err == nil {
				t.Fatalf("accepted %s", mode)
			}
		})
	}
}

func TestRoleWritePreflightAndChangedOwners(t *testing.T) {
	for _, change := range []string{"target", "marker", "roles", "root", "cancel"} {
		t.Run(change, func(t *testing.T) {
			options := repository(t, "saltbox")
			plan, err := Role(t.Context(), options)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch change {
			case "target":
				err = os.MkdirAll(filepath.Join(options.Root, "roles", options.Name, "tasks"), 0o755)
			case "marker":
				err = os.WriteFile(filepath.Join(options.Root, "sandbox.yml"), []byte("[]\n"), 0o644)
			case "roles", "root":
				path := options.Root
				if change == "roles" {
					path = filepath.Join(path, "roles")
				}
				if err = os.Rename(path, path+"-old"); err == nil {
					err = os.Mkdir(path, 0o755)
				}
			case "cancel":
				cancel()
			}
			if err != nil {
				t.Fatal(err)
			}
			if created, err := plan.Write(ctx); err == nil || len(created) != 0 {
				t.Fatalf("write did not fully preflight %s: %v %v", change, created, err)
			}
		})
	}
}

func TestRolePartialFailureRetainsChangedAndConcurrentData(t *testing.T) {
	for _, mode := range []string{"interruption", "concurrent_target", "parent_replaced"} {
		t.Run(mode, func(t *testing.T) {
			options := repository(t, "saltbox")
			plan, err := Role(t.Context(), options)
			if err != nil {
				t.Fatal(err)
			}
			defaults := filepath.Join(options.Root, "roles", options.Name, "defaults", "main.yml")
			created, err := plan.write(t.Context(), func(path string) error {
				if path != "roles/my_role/tasks" {
					return nil
				}
				if err := os.WriteFile(defaults, []byte("user changed data\n"), 0o644); err != nil {
					return err
				}
				switch mode {
				case "concurrent_target":
					return os.Mkdir(filepath.Join(options.Root, "roles", options.Name, "tasks"), 0o755)
				case "parent_replaced":
					parent := filepath.Dir(defaults)
					if err := os.Rename(parent, parent+"-old"); err != nil {
						return err
					}
					return os.Mkdir(parent, 0o755)
				default:
					return context.Canceled
				}
			})
			if err == nil || len(created) != 3 || created[2] != "roles/my_role/defaults/main.yml" {
				t.Fatalf("inexact partial result: %v, %v", created, err)
			}
			if mode == "parent_replaced" {
				defaults = filepath.Join(filepath.Dir(defaults)+"-old", "main.yml")
			}
			if data, err := os.ReadFile(defaults); err != nil || string(data) != "user changed data\n" {
				t.Fatalf("failure deleted or changed user data: %q %v", data, err)
			}
			if mode == "concurrent_target" {
				if _, err := os.Stat(filepath.Join(options.Root, "roles", options.Name, "tasks")); err != nil {
					t.Fatalf("failure deleted concurrent directory: %v", err)
				}
			}
		})
	}
}

func TestRoleExclusiveFileCreation(t *testing.T) {
	options := repository(t, "saltbox")
	plan, err := Role(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	created, err := plan.write(t.Context(), func(path string) error {
		if path == plan.files[0].Path {
			return os.WriteFile(filepath.Join(options.Root, filepath.FromSlash(path)), []byte("concurrent file\n"), 0o644)
		}
		return nil
	})
	if !errors.Is(err, os.ErrExist) || len(created) != 2 {
		t.Fatalf("exclusive creation: %v %v", created, err)
	}
	if data, err := os.ReadFile(filepath.Join(options.Root, filepath.FromSlash(plan.files[0].Path))); err != nil || string(data) != "concurrent file\n" {
		t.Fatalf("overwrote concurrent file: %q %v", data, err)
	}
}

func TestRoleSymlinkBoundaries(t *testing.T) {
	for _, mode := range []string{"roles", "marker", "existing_role", "administration", "git_control", "root_retarget", "created_parent"} {
		t.Run(mode, func(t *testing.T) {
			options := repository(t, "saltbox")
			outside := t.TempDir()
			link := func(target, name string) {
				t.Helper()
				if err := os.Symlink(target, name); err != nil {
					t.Skipf("symlink unavailable on this host: %v", err)
				}
			}
			var plan *Plan
			var err error
			switch mode {
			case "roles":
				if err := os.Remove(filepath.Join(options.Root, "roles")); err != nil {
					t.Fatal(err)
				}
				link(outside, filepath.Join(options.Root, "roles"))
			case "marker":
				if err := os.Rename(filepath.Join(options.Root, "saltbox.yml"), filepath.Join(outside, "saltbox.yml")); err != nil {
					t.Fatal(err)
				}
				link(filepath.Join(outside, "saltbox.yml"), filepath.Join(options.Root, "saltbox.yml"))
			case "existing_role":
				link(outside, filepath.Join(options.Root, "roles", options.Name))
			case "administration":
				options.Root = filepath.Join(options.Root, ".git")
			case "git_control":
				if err := os.WriteFile(filepath.Join(outside, "saltbox.yml"), []byte("[]\n"), 0o644); err != nil {
					t.Fatal(err)
				}
				link(filepath.Join(outside, "saltbox.yml"), filepath.Join(options.Root, ".gitignore"))
			case "root_retarget":
				alias := filepath.Join(t.TempDir(), "alias")
				link(options.Root, alias)
				options.Root = alias
				plan, err = Role(t.Context(), options)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(alias); err != nil {
					t.Fatal(err)
				}
				link(outside, alias)
				if created, err := plan.Write(t.Context()); err == nil || len(created) != 0 {
					t.Fatalf("retargeted root write: %v %v", created, err)
				}
			case "created_parent":
				plan, err = Role(t.Context(), options)
				if err != nil {
					t.Fatal(err)
				}
				created, err := plan.write(t.Context(), func(path string) error {
					if path == plan.files[0].Path {
						directory := filepath.Join(options.Root, "roles", options.Name, "defaults")
						if err := os.Remove(directory); err != nil {
							return err
						}
						link(outside, directory)
					}
					return nil
				})
				if err == nil || len(created) != 2 {
					t.Fatalf("escaped parent write: %v %v", created, err)
				}
			}
			if plan == nil {
				if _, err := Role(t.Context(), options); err == nil {
					t.Fatalf("accepted symlink/admin mode %s", mode)
				}
			}
			if entries, err := os.ReadDir(outside); err != nil || len(entries) > 1 || len(entries) == 1 && entries[0].Name() != "saltbox.yml" {
				t.Fatalf("escaped writes: %v %v", entries, err)
			}
		})
	}
}
