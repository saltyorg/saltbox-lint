package report

import (
	"charm.land/glamour/v2/ansi"
	"charm.land/glamour/v2/styles"
	"charm.land/lipgloss/v2"
)

type humanStyles struct {
	error, warning, notice, info lipgloss.Style
	rule, label, fix             lipgloss.Style
}

func newHumanStyles() humanStyles {
	return humanStyles{
		error:   lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("1")),
		warning: lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("3")),
		notice:  lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("6")),
		info:    lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("4")),
		rule:    lipgloss.NewStyle().Bold(true),
		label:   lipgloss.NewStyle().Bold(true),
		fix:     lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("2")),
	}
}

func (s humanStyles) severity(severity string) lipgloss.Style {
	switch severity {
	case "error":
		return s.error
	case "warning":
		return s.warning
	case "notice":
		return s.notice
	default:
		return s.info
	}
}

func markdownStyles() ansi.StyleConfig {
	bold := true
	italic := true
	cyan := "#00aaaa"
	green := "#00aa00"
	yellow := "#aa5500"
	blue := "#0000aa"
	magenta := "#aa00aa"
	faint := true
	zero := uint(0)
	return ansi.StyleConfig{
		Document:  ansi.StyleBlock{},
		Paragraph: ansi.StyleBlock{},
		Strong:    ansi.StylePrimitive{Bold: &bold},
		Emph:      ansi.StylePrimitive{Italic: &italic},
		Code:      ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Color: &cyan}},
		CodeBlock: ansi.StyleCodeBlock{
			StyleBlock: ansi.StyleBlock{Margin: &zero},
			Chroma: &ansi.Chroma{
				Comment:       ansi.StylePrimitive{Color: &blue, Faint: &faint},
				Keyword:       ansi.StylePrimitive{Color: &magenta},
				NameTag:       ansi.StylePrimitive{Color: &cyan},
				NameAttribute: ansi.StylePrimitive{Color: &cyan},
				LiteralNumber: ansi.StylePrimitive{Color: &yellow},
				LiteralString: ansi.StylePrimitive{Color: &green},
			},
		},
	}
}

// Preserve Glamour's native banner foreground and background as a pair.
func humanMarkdownStyles(theme Theme) ansi.StyleConfig {
	config := markdownStyles()
	native := styles.DarkStyleConfig
	if theme == ThemeLight {
		native = styles.LightStyleConfig
	}
	config.H1 = native.H1
	config.H2 = native.H2
	config.Heading = native.Heading
	config.H2.Prefix = ""
	return config
}
