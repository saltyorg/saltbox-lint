package cmd

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/report"
)

func TestThemeFlagPreservesMachineOutput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.yml")
	if err := os.WriteFile(path, []byte(badJinja), 0600); err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"json", "concise", "github"} {
		_, baseline, _ := invoke(t, "", "check", "--format", format, path)
		for _, theme := range []string{"auto", "dark", "light"} {
			code, out, stderr := invoke(t, "", "check", "--theme", theme, "--format", format, path)
			if code != 1 || out != baseline || stderr != "" {
				t.Fatalf("%s/%s: code=%d stderr=%q changed=%t", format, theme, code, stderr, out != baseline)
			}
		}
	}
	code, out, stderr := invoke(t, "", "--theme", "sepia", "check", "--fix", path)
	if code != 2 || out != "" || !strings.Contains(stderr, "unknown theme") {
		t.Fatalf("invalid theme: %d %q %q", code, out, stderr)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != badJinja {
		t.Fatalf("invalid theme changed source: %q %v", got, err)
	}
}

func TestResolveTheme(t *testing.T) {
	for _, tt := range []struct {
		name, requested string
		eligible, dark  bool
		queryErr        error
		want            report.Theme
		calls           int
	}{
		{"dark response", "auto", true, true, nil, report.ThemeDark, 1},
		{"light response", "auto", true, false, nil, report.ThemeLight, 1},
		{"unsupported", "auto", true, false, errors.New("unsupported"), report.ThemeDark, 1},
		{"ineligible", "auto", false, false, nil, report.ThemeDark, 0},
		{"explicit dark", "dark", true, false, nil, report.ThemeDark, 0},
		{"explicit light", "light", true, true, nil, report.ThemeLight, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			got := resolveTheme(t.Context(), tt.requested, tt.eligible, func(context.Context) (bool, error) { calls++; return tt.dark, tt.queryErr })
			if got != tt.want || calls != tt.calls {
				t.Fatalf("theme=%v calls=%d, want %v/%d", got, calls, tt.want, tt.calls)
			}
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	got := resolveTheme(ctx, "auto", true, func(context.Context) (bool, error) { t.Fatal("queried canceled context"); return false, nil })
	if got != report.ThemeDark {
		t.Fatal(got)
	}
}

func TestThemeQueryEligibility(t *testing.T) {
	for _, tt := range []struct {
		format   string
		terminal bool
		profile  report.ColorProfile
		noColor  string
		want     bool
	}{
		{"human", true, report.ColorTrueColor, "", true},
		{"human", false, report.ColorTrueColor, "", false},
		{"human", true, report.ColorNone, "", false},
		{"human", true, report.ColorTrueColor, "1", false},
		{"concise", true, report.ColorTrueColor, "", false},
		{"json", true, report.ColorTrueColor, "", false},
		{"github", true, report.ColorTrueColor, "", false},
	} {
		if got := themeQueryEligible(tt.format, tt.terminal, tt.profile, tt.noColor); got != tt.want {
			t.Fatalf("%+v: %t", tt, got)
		}
	}
}

func TestParseBackgroundResponse(t *testing.T) {
	for _, tt := range []struct {
		response    string
		dark, valid bool
	}{
		{"noise\x1b]11;rgb:2828/2c2c/3434\a", true, true},
		{"\x1b]11;rgb:fafa/fafa/fafa\x1b\\", false, true},
		{"\x1b]11;#fff\a", false, true},
		{"\x1b]11;#000000\a", true, true},
		{"\x1b]11;not-a-color\a", false, false},
		{"\x1b]11;#fff", false, false},
		{"\x1b[?1;2c", false, false},
	} {
		dark, err := parseBackgroundResponse([]byte(tt.response))
		if (err == nil) != tt.valid || dark != tt.dark {
			t.Fatalf("%q: %t %v", tt.response, dark, err)
		}
	}
}

func TestHumanPresentationCarriesResolvedThemeAndContext(t *testing.T) {
	for _, mode := range []string{"dark", "light", "auto"} {
		format, opts := resolveCheckPresentation(t.Context(), &strings.Builder{}, "human", "never", mode)
		want := report.ThemeDark
		if mode == "light" {
			want = report.ThemeLight
		}
		if format != "human" || opts.Theme != want || opts.Context != t.Context() || opts.ColorProfile != report.ColorNone {
			t.Fatalf("%s: %s %+v", mode, format, opts)
		}
	}
	for _, format := range []string{"auto", "concise", "json", "github"} {
		resolved, opts := resolveCheckPresentation(t.Context(), &strings.Builder{}, format, "always", "light")
		if resolved == "human" || opts != (report.HumanOptions{}) {
			t.Fatalf("%s unexpectedly resolved human options: %+v", format, opts)
		}
	}
}

func TestBackgroundQueryStopsBeforeOpeningOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := queryControllingTerminal(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
}

func TestCanceledRuleCommandDoesNotRender(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	var out, stderr strings.Builder
	code := Run(ctx, []string{"rules", "jinja-layout", "--theme", "auto"}, Streams{Out: &out, Err: &stderr}, "test")
	if code != 2 || out.Len() != 0 || !strings.Contains(stderr.String(), "context canceled") {
		t.Fatalf("code=%d out=%q err=%q", code, out.String(), stderr.String())
	}
}
