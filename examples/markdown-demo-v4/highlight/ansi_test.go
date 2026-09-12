package highlight

import (
	"github.com/frostybee/nuri"
	"github.com/frostybee/nuri/theme"
	"strings"
	"testing"
)

func TestANSIUsesExactRGBAndStyles(t *testing.T) {
	got, err := ANSI([]nuri.ThemedToken{{Content: "when", Color: "#61AFEF", BgColor: "#282C34", FontStyle: theme.FontStyleItalic | theme.FontStyleBold | theme.FontStyleUnderline | theme.FontStyleStrikethrough}})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"38;2;97;175;239", "48;2;40;44;52", "1;3;4;9", "when\x1b[0m"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
}
