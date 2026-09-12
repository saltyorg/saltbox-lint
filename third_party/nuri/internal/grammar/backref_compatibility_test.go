package grammar

import "testing"

func TestCapturedBackrefsPreserveExtendedRegexLiterals(t *testing.T) {
	got := ResolveBackrefs(`(?x)^\1\2\3$`, []string{"", "  \t", "#", "-,"})
	want := "(?x)^\\ \\ \\\t\\#\\-\\,$"
	if got != want {
		t.Fatalf("backref literal = %q; want %q", got, want)
	}
}
