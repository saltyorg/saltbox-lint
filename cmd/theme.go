package cmd

import (
	"context"
	"fmt"

	"github.com/saltyorg/saltbox-lint/report"
)

func validateThemeMode(mode string) error {
	switch mode {
	case "auto", "dark", "light":
		return nil
	default:
		return fmt.Errorf("unknown theme %q: use auto, dark, or light", mode)
	}
}

func themeQueryEligible(format string, terminal bool, profile report.ColorProfile, noColor string) bool {
	return format == "human" && terminal && profile != report.ColorNone && noColor == ""
}

func resolveTheme(ctx context.Context, requested string, eligible bool, query func(context.Context) (bool, error)) report.Theme {
	if requested == "light" {
		return report.ThemeLight
	}
	if requested != "auto" || !eligible || ctx.Err() != nil {
		return report.ThemeDark
	}
	dark, err := query(ctx)
	if err != nil || dark {
		return report.ThemeDark
	}
	return report.ThemeLight
}
