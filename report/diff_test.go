package report

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
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
		{"distant hunks", "distant.yml", strings.Join(numberedLines(40, "\n"), ""), replaceLines(numberedLines(40, "\n"), map[int]string{2: "two\n", 30: "thirty\n"}), false},
		{"merged CRLF hunk", "merged-crlf.yml", strings.Join(numberedLines(20, "\r\n"), ""), replaceLines(numberedLines(20, "\r\n"), map[int]string{8: "eight\r\n", 13: "thirteen\r\n"}), false},
		{"middle change before missing final newline", "middle-final.yml", strings.Join(numberedLines(10, "\n"), "") + "last", replaceLines(numberedLines(10, "\n"), map[int]string{9: "nine\n"}) + "last", false},
		{"edit limit fallback", "limit.yml", strings.Join(numberedLines(diffEditLimit+20, "\n"), ""), "head\n" + strings.Repeat("x\n", diffEditLimit) + "tail\n", false},
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
			git("config", "core.autocrlf", "false")
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

func numberedLines(n int, ending string) []string {
	lines := make([]string, n)
	for i := range lines {
		lines[i] = "line " + strconv.Itoa(i+1) + ending
	}
	return lines
}

func replaceLines(lines []string, replacements map[int]string) string {
	out := slices.Clone(lines)
	for index, line := range replacements {
		out[index-1] = line
	}
	return strings.Join(out, "")
}

func TestDiffEmitsMinimalHunksWithContext(t *testing.T) {
	lf := numberedLines(20, "\n")
	crlf := numberedLines(8, "\r\n")
	cases := []struct {
		name   string
		before string
		after  string
		want   string
	}{
		{
			name:   "middle change",
			before: strings.Join(lf[:9], ""),
			after:  replaceLines(lf[:9], map[int]string{5: "changed 5\n"}),
			want:   "@@ -2,7 +2,7 @@\n line 2\n line 3\n line 4\n-line 5\n+changed 5\n line 6\n line 7\n line 8\n",
		},
		{
			name:   "distant changes",
			before: strings.Join(lf, ""),
			after:  replaceLines(lf, map[int]string{2: "changed 2\n", 18: "changed 18\n"}),
			want: "@@ -1,5 +1,5 @@\n line 1\n-line 2\n+changed 2\n line 3\n line 4\n line 5\n" +
				"@@ -15,6 +15,6 @@\n line 15\n line 16\n line 17\n-line 18\n+changed 18\n line 19\n line 20\n",
		},
		{
			name:   "nearby changes merge",
			before: strings.Join(lf[:16], ""),
			after:  replaceLines(lf[:16], map[int]string{4: "changed 4\n", 11: "changed 11\n"}),
			want: "@@ -1,14 +1,14 @@\n line 1\n line 2\n line 3\n-line 4\n+changed 4\n line 5\n line 6\n line 7\n line 8\n" +
				" line 9\n line 10\n-line 11\n+changed 11\n line 12\n line 13\n line 14\n",
		},
		{
			name:   "insertion and deletion",
			before: strings.Join(lf[:8], ""),
			after:  strings.Join(lf[:2], "") + "inserted\n" + strings.Join(lf[2:5], "") + strings.Join(lf[6:8], ""),
			want:   "@@ -1,8 +1,8 @@\n line 1\n line 2\n+inserted\n line 3\n line 4\n line 5\n-line 6\n line 7\n line 8\n",
		},
		{
			name:   "CRLF",
			before: strings.Join(crlf, ""),
			after:  replaceLines(crlf, map[int]string{5: "changed 5\r\n"}),
			want:   "@@ -2,7 +2,7 @@\n line 2\r\n line 3\r\n line 4\r\n-line 5\r\n+changed 5\r\n line 6\r\n line 7\r\n line 8\r\n",
		},
		{
			name:   "unchanged final line without newline",
			before: strings.Join(lf[:6], "") + "last",
			after:  replaceLines(lf[:6], map[int]string{5: "changed 5\n"}) + "last",
			want:   "@@ -2,6 +2,6 @@\n line 2\n line 3\n line 4\n-line 5\n+changed 5\n line 6\n last\n\\ No newline at end of file\n",
		},
		{
			name:   "added final newline",
			before: strings.Join(lf[:5], "") + "last",
			after:  strings.Join(lf[:5], "") + "last\n",
			want:   "@@ -3,4 +3,4 @@\n line 3\n line 4\n line 5\n-last\n\\ No newline at end of file\n+last\n",
		},
		{
			name:   "empty before",
			before: "",
			after:  "a\nb\n",
			want:   "@@ -0,0 +1,2 @@\n+a\n+b\n",
		},
		{
			name:   "empty after",
			before: "a\nb\n",
			after:  "",
			want:   "@@ -1,2 +0,0 @@\n-a\n-b\n",
		},
		{
			name:   "insert at start",
			before: strings.Join(lf[:5], ""),
			after:  "new\n" + strings.Join(lf[:5], ""),
			want:   "@@ -1,3 +1,4 @@\n+new\n line 1\n line 2\n line 3\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			if err := Diff(&out, []lint.Change{{Path: "f.yml", Before: []byte(tc.before), After: []byte(tc.after)}}); err != nil {
				t.Fatal(err)
			}
			want := "--- a/f.yml\n+++ b/f.yml\n" + tc.want
			if out.String() != want {
				t.Fatalf("patch mismatch:\n got %q\nwant %q", out.String(), want)
			}
		})
	}
}
