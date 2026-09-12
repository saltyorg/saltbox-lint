package compare

import (
	"errors"
	"testing"
)

func TestResolveThemeAutoBackground(t *testing.T) {
	for _, test := range []struct {
		name      string
		dark      bool
		queryErr  error
		wantTheme themeChoice
	}{
		{"dark", true, nil, darkTheme},
		{"light", false, nil, lightTheme},
		{"unsupported", false, errors.New("unsupported"), darkTheme},
	} {
		t.Run(test.name, func(t *testing.T) {
			queries := 0
			detections := 0
			got, err := resolveTheme("auto", func() bool {
				detections++
				return true
			}, func() (bool, error) {
				queries++
				return test.dark, test.queryErr
			})
			if err != nil {
				t.Fatal(err)
			}
			if got != test.wantTheme {
				t.Fatalf("resolveTheme() = %q, want %q", got, test.wantTheme)
			}
			if queries != 1 {
				t.Fatalf("background queries = %d, want 1", queries)
			}
			if detections != 1 {
				t.Fatalf("output terminal detections = %d, want 1", detections)
			}
		})
	}
}

func TestParseBackgroundResponse(t *testing.T) {
	for _, test := range []struct {
		name, response string
		wantDark       bool
		wantErr        bool
	}{
		{"dark_bel", "noise\x1b]11;rgb:2828/2c2c/3434\x07", true, false},
		{"light_st", "\x1b]11;rgb:fafa/fafa/fafa\x1b\\", false, false},
		{"malformed", "\x1b]11;not-a-color\x07", false, true},
		{"missing", "\x1b[?1;2c", false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseBackgroundResponse([]byte(test.response))
			if (err != nil) != test.wantErr {
				t.Fatalf("parseBackgroundResponse() error = %v, wantErr %v", err, test.wantErr)
			}
			if got != test.wantDark {
				t.Fatalf("parseBackgroundResponse() = %v, want %v", got, test.wantDark)
			}
		})
	}
}

func TestResolveThemeExplicitAndRedirectedSkipQuery(t *testing.T) {
	for _, test := range []struct {
		name      string
		requested string
		terminal  bool
		wantTheme themeChoice
		wantErr   bool
	}{
		{"explicit_dark", "dark", true, darkTheme, false},
		{"explicit_light", "light", true, lightTheme, false},
		{"redirected_auto", "auto", false, darkTheme, false},
		{"unknown", "sepia", true, "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			queries := 0
			detections := 0
			got, err := resolveTheme(test.requested, func() bool {
				detections++
				return test.terminal
			}, func() (bool, error) {
				queries++
				return false, nil
			})
			if (err != nil) != test.wantErr {
				t.Fatalf("resolveTheme() error = %v, wantErr %v", err, test.wantErr)
			}
			if got != test.wantTheme {
				t.Fatalf("resolveTheme() = %q, want %q", got, test.wantTheme)
			}
			if queries != 0 {
				t.Fatalf("background queries = %d, want 0", queries)
			}
			wantDetections := 0
			if test.requested == "auto" {
				wantDetections = 1
			}
			if detections != wantDetections {
				t.Fatalf("output terminal detections = %d, want %d", detections, wantDetections)
			}
		})
	}
}
