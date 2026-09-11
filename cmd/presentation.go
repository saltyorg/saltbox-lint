package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/colorprofile"
	"github.com/charmbracelet/x/term"
	"github.com/saltyorg/saltbox-lint/report"
)

const (
	defaultOutputWidth = 80
	maximumOutputWidth = 100
)

type descriptorWriter interface {
	Fd() uintptr
}

func validateColorMode(mode string) error {
	switch mode {
	case "auto", "always", "never":
		return nil
	default:
		return fmt.Errorf("unknown color mode %q", mode)
	}
}

func resolveCheckPresentation(w io.Writer, requestedFormat, colorMode string) (string, report.HumanOptions) {
	if requestedFormat != "auto" {
		if requestedFormat == "human" {
			return requestedFormat, resolveHumanOptions(w, colorMode)
		}
		return requestedFormat, report.HumanOptions{}
	}
	if !isCapableTerminal(w) {
		return "concise", report.HumanOptions{}
	}
	return "human", resolveHumanOptions(w, colorMode)
}

func resolveHumanOptions(w io.Writer, colorMode string) report.HumanOptions {
	fd, terminal := terminalDescriptor(w)
	width := defaultOutputWidth
	if terminal {
		if detected, _, err := term.GetSize(fd); err == nil && detected > 0 {
			width = min(detected, maximumOutputWidth)
		}
	}
	return report.HumanOptions{Width: width, ColorProfile: resolveColorProfile(terminal, colorMode, os.Environ())}
}

func isCapableTerminal(w io.Writer) bool {
	_, terminal := terminalDescriptor(w)
	return terminal && os.Getenv("TERM") != "dumb"
}

func terminalDescriptor(w io.Writer) (uintptr, bool) {
	file, ok := w.(descriptorWriter)
	if !ok {
		return 0, false
	}
	fd := file.Fd()
	return fd, term.IsTerminal(fd)
}

func resolveColorProfile(terminal bool, mode string, environ []string) report.ColorProfile {
	if mode == "never" || (mode == "auto" && (!terminal || environmentValue(environ, "NO_COLOR") != "")) {
		return report.ColorNone
	}
	if mode == "auto" && environmentValue(environ, "TERM") == "dumb" {
		return report.ColorNone
	}
	profile := colorprofile.Env(withoutEnvironment(environ, "NO_COLOR"))
	switch profile {
	case colorprofile.TrueColor:
		return report.ColorTrueColor
	case colorprofile.ANSI256:
		return report.ColorANSI256
	case colorprofile.ANSI:
		return report.ColorANSI
	default:
		if mode == "always" {
			return report.ColorANSI
		}
		return report.ColorNone
	}
}

func environmentValue(environ []string, name string) string {
	prefix := name + "="
	for i := len(environ) - 1; i >= 0; i-- {
		if strings.HasPrefix(environ[i], prefix) {
			return strings.TrimPrefix(environ[i], prefix)
		}
	}
	return ""
}

func withoutEnvironment(environ []string, name string) []string {
	prefix := name + "="
	filtered := make([]string, 0, len(environ))
	for _, value := range environ {
		if !strings.HasPrefix(value, prefix) {
			filtered = append(filtered, value)
		}
	}
	return filtered
}
