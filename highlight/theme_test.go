package highlight

import (
	"github.com/frostybee/nuri/theme"
	"testing"
)

func TestThemeLastPropertyAndInheritance(t *testing.T) {
	raw := []byte(`{"name":"fixture","colors":{"editor.foreground":"#111111","editor.background":"#222222"},"tokenColors":[{"scope":"keyword","settings":{"foreground":"#AAAAAA","fontStyle":"italic bold"}},{"scope":["keyword.other","variable.other"],"settings":{"foreground":"#BBBBBB"}},{"scope":"keyword.other","settings":{"foreground":"#CCCCCC","fontStyle":""}},{"scope":"source.ansible keyword.other","settings":{"background":"#DDDDDD"}}]}`)
	data, err := normalizeTheme(raw)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := theme.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	got := parsed.Match([]string{"source.ansible", "keyword.other.special-method.ansible"})
	if got.Foreground != "#CCCCCC" || got.Background != "#DDDDDD" || got.FontStyle != theme.FontStyleNone {
		t.Fatalf("property precedence/style reset: %+v", got)
	}
	inherited := parsed.Match([]string{"source.ansible", "keyword.control"})
	if inherited.Foreground != "#AAAAAA" || inherited.FontStyle != theme.FontStyleItalic|theme.FontStyleBold {
		t.Fatalf("inheritance: %+v", inherited)
	}
}
