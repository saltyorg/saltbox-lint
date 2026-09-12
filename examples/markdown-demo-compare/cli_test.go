package compare

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestRunThemesAndCLI(t *testing.T) {
	for _, mode := range []Mode{Unified, Guided} {
		for _, tc := range []struct {
			name, theme    string
			terminal, dark bool
			queryErr       error
			queries        int
			want           string
		}{
			{name: "redirected", theme: "auto", want: "38;2;198;120;221"},
			{name: "dark", theme: "dark", terminal: true, want: "38;2;198;120;221"},
			{name: "light", theme: "light", terminal: true, want: "38;2;64;120;242"},
			{name: "auto_light", theme: "auto", terminal: true, queries: 1, want: "38;2;64;120;242"},
			{name: "auto_dark", theme: "auto", terminal: true, dark: true, queries: 1, want: "38;2;198;120;221"},
			{name: "auto_error", theme: "auto", terminal: true, queryErr: errors.New("timeout"), queries: 1, want: "38;2;198;120;221"},
		} {
			t.Run(string(mode)+"/"+tc.name, func(t *testing.T) {
				var out, errOut bytes.Buffer
				calls := 0
				code := run(t.Context(), mode, []string{"--theme", tc.theme}, &out, &errOut, func() bool { return tc.terminal }, func() (bool, error) { calls++; return tc.dark, tc.queryErr })
				if code != 0 || errOut.Len() != 0 {
					t.Fatalf("exit %d: %s", code, errOut.String())
				}
				if calls != tc.queries {
					t.Errorf("queries %d, want %d", calls, tc.queries)
				}
				if !strings.Contains(out.String(), tc.want) {
					t.Errorf("missing syntax color %s", tc.want)
				}
				if strings.Contains(out.String(), "\x1b]11;") {
					t.Error("query leaked to output")
				}
			})
		}
	}
	for _, args := range [][]string{{"--theme=sepia"}, {"extra"}, {"--unknown"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			var out, errOut bytes.Buffer
			code := run(t.Context(), Unified, args, &out, &errOut, func() bool { t.Fatal("invalid CLI detected terminal"); return true }, func() (bool, error) { t.Fatal("invalid CLI queried terminal"); return false, nil })
			if code != 2 || out.Len() != 0 || errOut.Len() == 0 {
				t.Fatalf("invalid args exit=%d stdout=%q stderr=%q", code, out.String(), errOut.String())
			}
		})
	}
}
