package report

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestDiffPathsUseGitByteQuoting(t *testing.T) {
	cases := []struct {
		name string
		path string
		want string
	}{
		{"ordinary", "plain.yml", "a/plain.yml"},
		{"space", "has space.yml", `"a/has space.yml"`},
		{"nonbreaking space", "has\u00a0space.yml", `"a/has\302\240space.yml"`},
		{"unicode", "caf\u00e9-\U0001f600.yml", `"a/caf\303\251-\360\237\230\200.yml"`},
		{"quote and backslash", `a"b\c.yml`, `"a/a\"b\\c.yml"`},
		{"tab", "a\tb.yml", `"a/a\011b.yml"`},
		{"newline", "a\nb.yml", `"a/a\012b.yml"`},
		{"carriage return", "a\rb.yml", `"a/a\015b.yml"`},
		{"control byte", "a\x01b.yml", `"a/a\001b.yml"`},
		{"delete byte", "a\x7fb.yml", `"a/a\177b.yml"`},
		{"invalid UTF-8 byte", "a\xffb.yml", `"a/a\377b.yml"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			if err := Diff(&out, []lint.Change{{Path: tc.path, Before: []byte("old\n"), After: []byte("new\n")}}); err != nil {
				t.Fatal(err)
			}
			want := "--- " + tc.want + "\n+++ " + strings.Replace(tc.want, "a/", "b/", 1) + "\n@@ -1,1 +1,1 @@\n-old\n+new\n"
			if out.String() != want {
				t.Fatalf("patch mismatch:\n got %q\nwant %q", out.String(), want)
			}
		})
	}
}

func TestDiffPatchAppliesToExactFilenameAndContent(t *testing.T) {
	cases := []struct {
		name           string
		path           string
		before         string
		after          string
		invalidWindows bool
	}{
		{"ordinary LF", "plain.yml", "old\n", "new\n", false},
		{"space", "has space.yml", "old\n", "new\n", false},
		{"nonbreaking space", "has\u00a0space.yml", "old\n", "new\n", false},
		{"unicode and non BMP", "caf\u00e9-\U0001f600.yml", "old\n", "new\n", false},
		{"quote and backslash", `a"b\c.yml`, "old\n", "new\n", true},
		{"tab", "a\tb.yml", "old\n", "new\n", true},
		{"newline", "a\nb.yml", "old\n", "new\n", true},
		{"carriage return", "a\rb.yml", "old\n", "new\n", true},
		{"control byte", "a\x01b.yml", "old\n", "new\n", true},
		{"empty before", "empty-before.yml", "", "new\n", false},
		{"empty after", "empty-after.yml", "old\n", "", false},
		{"missing final newline", "no-final.yml", "old", "new", false},
		{"CRLF", "crlf.yml", "old\r\n", "new\r\n", false},
		{"CRLF without final newline", "crlf-final.yml", "old\r\nlast", "new\r\nlast", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if runtime.GOOS == "windows" && tc.invalidWindows {
				t.Skip("Windows cannot create this filename")
			}
			root := t.TempDir()
			git := func(args ...string) {
				t.Helper()
				cmd := exec.Command("git", args...)
				cmd.Dir = root
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("git %v: %v: %s", args, err, output)
				}
			}
			git("init", "-q")
			path := filepath.Join(root, tc.path)
			if err := os.WriteFile(path, []byte(tc.before), 0o600); err != nil {
				t.Fatal(err)
			}
			var patch bytes.Buffer
			if err := Diff(&patch, []lint.Change{{Path: tc.path, Before: []byte(tc.before), After: []byte(tc.after)}}); err != nil {
				t.Fatal(err)
			}
			for _, args := range [][]string{{"apply", "--check"}, {"apply"}} {
				cmd := exec.Command("git", args...)
				cmd.Dir = root
				cmd.Stdin = bytes.NewReader(patch.Bytes())
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("git %v: %v: %s\npatch: %q", args, err, output, patch.Bytes())
				}
			}
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, []byte(tc.after)) {
				t.Fatalf("applied content = %q, want %q", got, tc.after)
			}
		})
	}
}
