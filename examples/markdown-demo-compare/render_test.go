package compare

import (
	"fmt"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/frostybee/nuri"
	v4 "saltbox-lint-markdown-demo-v4/highlight"
)

// These assertions catch lost source coordinates, wrong diff sides, missing
// blank changes, and patch markers leaking into the guided comparison.
func TestRenderComparison(t *testing.T) {
	h, err := v4.New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
	report, err := Demo()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []Mode{Unified, Guided} {
		for _, theme := range []themeChoice{darkTheme, lightTheme} {
			t.Run(string(mode)+"/"+string(theme), func(t *testing.T) {
				got, err := Render(t.Context(), report, mode, theme, h)
				if err != nil {
					t.Fatal(err)
				}
				plain := ansi.Strip(got)
				for _, text := range []string{"Saltbox Lint", "Error 1 of 3", "Location:", "Fix:", "ansible-when-list", "102:9", "148:7", "10:1", "3 errors in 2 files", "check --fix"} {
					if !strings.Contains(plain, text) {
						t.Errorf("missing %q", text)
					}
				}
				if strings.Count(plain, strings.Repeat("─", 72)) != 3 {
					t.Error("missing finding separators")
				}
				if mode == Unified {
					for _, text := range []string{"--- current/roles/web/tasks/main.yml", "+++ suggested/roles/web/tasks/main.yml", "@@ -99,4 +99,6 @@", "102     │ -   when: (web_config is defined) and web_enabled", "    102 │ +   when:", "148     │ -     - restart_web", "    148 │ +     - restart-web", "     10 │ + "} {
						if !strings.Contains(plain, text) {
							t.Errorf("missing diff text %q", text)
						}
					}
					if strings.Count(plain, "@@ -") != 3 {
						t.Error("want one hunk per finding")
					}
				} else {
					for _, text := range []string{"Current", "Suggested", "Put each condition on its own line", "Change restart_web to restart-web", "Add a blank line above web_role_enabled", "Suggested line 10 is the new blank line.", " 10 │ ", " 11 │ web_role_enabled: true"} {
						if !strings.Contains(plain, text) {
							t.Errorf("missing guided text %q", text)
						}
					}
					if strings.Contains(plain, "conjunction") || strings.Contains(plain, "kebab-case") {
						t.Error("guided explanation duplicated technical wording")
					}
					if strings.Contains(plain, "@@") || strings.Contains(plain, "│ +") || strings.Contains(plain, "│ -   when:") {
						t.Error("guided output contains patch markers")
					}
				}
				header := strings.SplitN(got, "Saltbox Lint", 2)[0]
				if !strings.Contains(header, "48;") {
					t.Error("H1 banner has no background")
				}
			})
		}
	}
}

// This catches token recoloring, changed source bytes, and accidental mutation
// when a meaningful span cuts across an existing token.
func TestDecoratePreservesSourceAndForeground(t *testing.T) {
	input := []nuri.ThemedToken{{Content: "  - café_value", Color: "#C678DD", BgColor: "#282C34", Scopes: []string{"source.ansible"}}}
	got := decorate(input, Emphasis{Spans: []Span{{Start: 4, End: 15}}}, "#343840")
	var source strings.Builder
	for _, token := range got {
		source.WriteString(token.Content)
		if token.Color != "#C678DD" || len(token.Scopes) != 1 || token.Scopes[0] != "source.ansible" {
			t.Error("decoration changed syntax foreground or scopes")
		}
	}
	if source.String() != "  - café_value" {
		t.Errorf("source changed: %q", source.String())
	}
	if input[0].BgColor != "#282C34" {
		t.Error("mutated input")
	}
	if len(got) != 2 || got[0].BgColor != "#282C34" || got[1].BgColor != "#343840" {
		t.Errorf("incorrect span background: %+v", got)
	}
}

// A four-space swatch looks like inserted indentation. A blank changed row
// must instead show a full code-area band, without adding any YAML characters.
func TestBlankRowHasPresentationBand(t *testing.T) {
	r := reportRenderer{gutter: "#636D83"}
	if err := r.codeLine(" 10 │ ", nil, Emphasis{WholeLine: true}, "#35383E"); err != nil {
		t.Fatal(err)
	}
	got := r.out.String()
	if !strings.Contains(got, "\x1b[48;2;53;56;62m"+strings.Repeat(" ", 64)+"\x1b[0m") {
		t.Fatalf("blank row lacks full background band: %q", got)
	}
	if strings.TrimSpace(strings.SplitN(ansi.Strip(got), "│ ", 2)[1]) != "" {
		t.Error("explanatory text leaked into YAML")
	}
}

func TestActualTokenDecorationPreservesComposedStyles(t *testing.T) {
	h, err := v4.New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
	report, err := Demo()
	if err != nil {
		t.Fatal(err)
	}
	for _, theme := range []string{"one-dark-pro", "one-light"} {
		for _, f := range report.Findings {
			for _, side := range []Excerpt{f.Current, f.Suggested} {
				doc, err := side.Document.Highlight(t.Context(), h, theme)
				if err != nil {
					t.Fatal(err)
				}
				for _, row := range f.Diff {
					if row.Kind == Context {
						continue
					}
					line := row.BeforeLine
					if side.Document.Source == f.Suggested.Document.Source {
						line = row.AfterLine
					}
					if line == 0 {
						continue
					}
					original := doc.Combined.Tokens[line-1]
					for _, emphasis := range []Emphasis{row.Emphasis, {WholeLine: true}} {
						decorated := decorate(original, emphasis, "#35383E")
						want := tokenStyleBytes(original)
						got := tokenStyleBytes(decorated)
						if want != got {
							t.Fatalf("%s %s line %d changed source/foreground/font/scopes", theme, f.Rule, line)
						}
					}
				}
			}
		}
	}
}

// Background is intentionally excluded; every source byte retains its composed
// foreground, font flags, and original scope stack, even across split tokens.
func tokenStyleBytes(tokens []nuri.ThemedToken) string {
	var out strings.Builder
	for _, token := range tokens {
		for _, b := range []byte(token.Content) {
			fmt.Fprintf(&out, "%02x:%s:%d:%q\n", b, token.Color, token.FontStyle, token.Scopes)
		}
	}
	return out.String()
}

func TestRenderUsesFullSourceMultilineState(t *testing.T) {
	before := "- name: Example\n  ansible.builtin.debug:\n    msg: |\n      when: alpha\n      old text\n"
	after := strings.Replace(before, "old text", "new text", 1)
	f := Finding{Rule: "example", Ordinal: 1, Total: 1, Location: Location{Path: "roles/web/tasks/main.yml", Line: 5, Column: 7}, Current: Excerpt{Document: Document{Source: before, SourcePath: "roles/web/tasks/main.yml"}, Lines: LineRange{4, 5}}, Suggested: Excerpt{Document: Document{Source: after, SourcePath: "roles/web/tasks/main.yml"}, Lines: LineRange{4, 5}}, Diff: Compare(before, after)}
	h, err := v4.New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
	for _, theme := range []themeChoice{darkTheme, lightTheme} {
		syntaxTheme := "one-dark-pro"
		if theme == lightTheme {
			syntaxTheme = "one-light"
		}
		full, err := f.Current.Document.Highlight(t.Context(), h, syntaxTheme)
		if err != nil {
			t.Fatal(err)
		}
		want, err := v4.ANSI(full.Combined.Tokens[3])
		if err != nil {
			t.Fatal(err)
		}
		fragment, err := h.Highlight(t.Context(), "      when: alpha\n", syntaxTheme)
		if err != nil {
			t.Fatal(err)
		}
		wrong, err := v4.ANSI(fragment.Tokens[0])
		if err != nil {
			t.Fatal(err)
		}
		if want == wrong {
			t.Fatal("fixture does not distinguish full-source and fragment highlighting")
		}
		for _, mode := range []Mode{Unified, Guided} {
			got, err := Render(t.Context(), Report{Title: "Multiline", Findings: []Finding{f}}, mode, theme, h)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(got, want) {
				t.Fatalf("%s %s lost multiline scalar highlighting", mode, theme)
			}
			if strings.Contains(got, wrong) {
				t.Fatalf("%s %s used fragment highlighting", mode, theme)
			}
		}
	}
}

func TestGuidedRemovalAndLiteralBytes(t *testing.T) {
	before := "# header\n# café\told\n\nvalue: true\n"
	after := "# header\nvalue: true\n"
	f := Finding{Rule: "example", Ordinal: 1, Total: 1, Location: Location{Path: "roles/web/defaults/main.yml", Line: 2, Column: 1}, Current: Excerpt{Document: Document{Source: before, SourcePath: "roles/web/defaults/main.yml"}, Lines: LineRange{1, 4}}, Suggested: Excerpt{Document: Document{Source: after, SourcePath: "roles/web/defaults/main.yml"}, Lines: LineRange{1, 2}}, Diff: Compare(before, after)}
	h, err := v4.New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
	for _, mode := range []Mode{Unified, Guided} {
		got, err := Render(t.Context(), Report{Title: "Removal", Findings: []Finding{f}}, mode, darkTheme, h)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(ansi.Strip(got), "# café\told") {
			t.Error("tabs or Unicode changed")
		}
		for _, row := range strings.Split(got, "\n") {
			plain := ansi.Strip(row)
			if strings.Contains(plain, "│") && strings.Contains(plain, "café") && !strings.Contains(row, "48;2;") {
				t.Error("pure removal lost background")
			}
		}
		if mode == Unified && !strings.Contains(ansi.Strip(got), "3   │ - ") {
			t.Error("deleted blank row lost number or marker")
		}
		if mode == Guided {
			parts := strings.Split(got, "Suggested")
			if len(parts) != 2 {
				t.Fatalf("missing suggested excerpt")
			}
			for _, row := range strings.Split(parts[1], "\n") {
				if strings.Contains(row, "│") && strings.Contains(row, "48;2;") {
					t.Error("unchanged suggested row emphasized")
				}
			}
		}
	}
}
