package report

import (
	"github.com/charmbracelet/glamour/ansi"
	"github.com/charmbracelet/lipgloss"
)

type humanStyles struct {
	error, warning, notice, info lipgloss.Style
	rule, label, fix             lipgloss.Style
}

func newHumanStyles(renderer *lipgloss.Renderer) humanStyles {
	return humanStyles{
		error:   renderer.NewStyle().Bold(true).Foreground(lipgloss.Color("1")),
		warning: renderer.NewStyle().Bold(true).Foreground(lipgloss.Color("3")),
		notice:  renderer.NewStyle().Bold(true).Foreground(lipgloss.Color("6")),
		info:    renderer.NewStyle().Bold(true).Foreground(lipgloss.Color("4")),
		rule:    renderer.NewStyle().Bold(true),
		label:   renderer.NewStyle().Bold(true),
		fix:     renderer.NewStyle().Bold(true).Foreground(lipgloss.Color("2")),
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
