package theme

import "strings"

func normalize(t *Theme) {
	if t.DefaultForeground == "" {
		t.DefaultForeground = t.Colors["editor.foreground"]
	}
	if t.DefaultBackground == "" {
		t.DefaultBackground = t.Colors["editor.background"]
	}
	if !isValidColor(t.DefaultForeground) {
		t.DefaultForeground = "#000000"
	}
	if !isValidColor(t.DefaultBackground) {
		t.DefaultBackground = "#000000"
	}
}

func isValidColor(c string) bool {
	c = strings.TrimSpace(c)
	if !strings.HasPrefix(c, "#") {
		return false
	}
	hex := c[1:]
	switch len(hex) {
	case 3, 4, 6, 8:
	default:
		return false
	}
	for _, r := range hex {
		if !isHexDigit(r) {
			return false
		}
	}
	return true
}

func isHexDigit(r rune) bool {
	return (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
}
