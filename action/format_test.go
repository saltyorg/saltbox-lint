package action_test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestFormatCheckUsesExistingWorktreeFiles(t *testing.T) {
	makefile, err := os.ReadFile("../Makefile")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"deleted", "modified", "untracked", "newline path", "formatted newline path", "syntax error", "unreadable path"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			run := func(args ...string) ([]byte, error) {
				c := exec.CommandContext(t.Context(), args[0], args[1:]...)
				c.Dir = root
				return c.CombinedOutput()
			}
			mustRun := func(args ...string) []byte {
				t.Helper()
				out, err := run(args...)
				if err != nil {
					t.Fatalf("%v: %v\n%s", args, err, out)
				}
				return out
			}
			writeFile(t, filepath.Join(root, "Makefile"), makefile)
			path := "source with spaces.go"
			if name == "newline path" || name == "formatted newline path" {
				path = "source\nwith newline.go"
			}
			file := filepath.Join(root, path)
			writeFile(t, file, []byte("package fixture\n"))
			mustRun("git", "init", "-q")
			mustRun("git", "add", "--", path)
			wantFailure := name != "deleted" && name != "formatted newline path"
			switch name {
			case "formatted newline path":
				writeFile(t, file, []byte("package fixture\n\nvar x = 1\n"))
			case "deleted":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
			case "untracked":
				file = filepath.Join(root, "untracked.go")
				writeFile(t, file, []byte("package fixture\nvar x=1\n"))
			case "syntax error":
				writeFile(t, file, []byte("package {\n"))
			case "unreadable path":
				// ELOOP is a genuine open error even when the suite runs as root.
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(path, file); err != nil {
					t.Fatal(err)
				}
			default:
				writeFile(t, file, []byte("package fixture\nvar x=1\n"))
			}
			before, _ := os.ReadFile(file)
			index := mustRun("git", "ls-files", "--stage", "-z")
			out, err := run("make", "format-check")
			if (err != nil) != wantFailure {
				t.Fatalf("make format-check error=%v wantFailure=%v\n%s", err, wantFailure, out)
			}
			after, _ := os.ReadFile(file)
			if !bytes.Equal(before, after) || !bytes.Equal(index, mustRun("git", "ls-files", "--stage", "-z")) {
				t.Fatal("format check changed source or index")
			}
			if name == "deleted" {
				if _, err := os.Lstat(file); !os.IsNotExist(err) {
					t.Fatalf("deleted file was recreated: %v", err)
				}
			}
		})
	}
}
