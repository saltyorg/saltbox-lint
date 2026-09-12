package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunThemeSelectionAndRedirectedOutput(t *testing.T) {
	for _, test := range []struct {
		name, requested string
		terminal        bool
		wantColor       string
	}{
		{"redirected_auto", "auto", false, "\x1b[38;2;198;120;221mwhen"},
		{"explicit_light", "light", true, "\x1b[38;2;64;120;242mwhen"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			queries := 0
			detections := 0
			exitCode := run(t.Context(), []string{"--theme", test.requested}, &stdout, &stderr, func() bool {
				detections++
				return test.terminal
			}, func() (bool, error) {
				queries++
				return true, nil
			})
			if exitCode != 0 {
				t.Fatalf("run() = %d, stderr=%q", exitCode, stderr.String())
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
			if !strings.Contains(stripANSI(stdout.String()), "3 errors in 2 files") {
				t.Fatalf("output lacks summary: %q", stdout.String())
			}
			if !strings.Contains(stdout.String(), test.wantColor) {
				t.Fatalf("output lacks runtime theme color %q", test.wantColor)
			}
		})
	}
}

func TestRunRejectsUnknownTheme(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exitCode := run(t.Context(), []string{"--theme=sepia"}, &stdout, &stderr, func() bool {
		t.Fatal("unknown explicit theme detected the terminal")
		return true
	}, func() (bool, error) {
		t.Fatal("unknown explicit theme queried the terminal")
		return false, nil
	})
	if exitCode != 2 {
		t.Fatalf("run() = %d, want 2", exitCode)
	}
	if !strings.Contains(stderr.String(), `unknown theme "sepia": use auto, dark, or light`) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}
