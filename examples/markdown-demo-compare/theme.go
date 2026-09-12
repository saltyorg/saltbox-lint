package compare

import (
	"fmt"
	"strings"

	"charm.land/glamour/v2/ansi"
	"charm.land/glamour/v2/styles"
)

type themeChoice string

const (
	darkTheme  themeChoice = "dark"
	lightTheme themeChoice = "light"
)

type changePalette struct{ removed, added, guided string }

func changeColors(theme themeChoice) changePalette {
	if theme == lightTheme {
		return changePalette{"#F3E6E6", "#E6EFE7", "#E6E7E9"}
	}
	return changePalette{"#3A2C32", "#2C3A32", "#35383E"}
}

// The prose styles and terminal policy are a frozen, small v4 reference.
// Preserve Glamour's H1 foreground and background together as its banner.
func presentationStyle(theme themeChoice) (styleConfig ansi.StyleConfig, themeName string, gutter [3]uint8, err error) {
	foreground, heading, failure := "#ABB2BF", "#61AFEF", "#E06C75"
	styleConfig = styles.DarkStyleConfig
	switch theme {
	case darkTheme:
		gutter = [3]uint8{99, 109, 131}
	case lightTheme:
		foreground, heading, failure = "#383A42", "#4078F2", "#E45649"
		styleConfig = styles.LightStyleConfig
		themeName = "one-light"
		gutter = [3]uint8{105, 108, 119}
	default:
		return ansi.StyleConfig{}, "", [3]uint8{}, fmt.Errorf("unsupported presentation theme %q", theme)
	}
	if themeName == "" {
		themeName = "one-dark-pro"
	}
	styleConfig.Document.Color = &foreground
	styleConfig.Heading.Color = &heading
	styleConfig.H2.Prefix = ""
	styleConfig.H3.Prefix = ""
	styleConfig.H3.Color = &failure
	styleConfig.H4.Prefix = ""
	styleConfig.H4.Color = &foreground
	styleConfig.HorizontalRule.Color = stringPointer(fmt.Sprintf("#%02X%02X%02X", gutter[0], gutter[1], gutter[2]))
	styleConfig.HorizontalRule.Format = "\n" + strings.Repeat("─", 72) + "\n"
	return styleConfig, themeName, gutter, nil
}

func stringPointer(value string) *string { return &value }
