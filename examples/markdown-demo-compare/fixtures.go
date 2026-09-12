package compare

import (
	_ "embed"
	"fmt"
	"strings"
)

// These small fixtures are copied byte-for-byte from markdown-demo-v4. The v4
// catalog, grammars, and themes remain owned and embedded by its packages.

//go:embed testdata/roles/web/tasks/main.yml
var tasksSource string

//go:embed testdata/roles/web/defaults/main.yml
var defaultsSource string

// Demo constructs the three findings and computes their changes at runtime.
func Demo() (Report, error) {
	whenExpected, err := replaceOnce(tasksSource,
		"  when: (web_config is defined) and web_enabled\n",
		"  when:\n    - (web_config is defined)\n    - web_enabled\n")
	if err != nil {
		return Report{}, err
	}
	tagExpected, err := replaceOnce(tasksSource, "    - restart_web\n", "    - restart-web\n")
	if err != nil {
		return Report{}, err
	}
	spacingExpected, err := replaceOnce(defaultsSource,
		"################################\nweb_role_enabled: true\n",
		"################################\n\nweb_role_enabled: true\n")
	if err != nil {
		return Report{}, err
	}

	findings := []Finding{
		newFinding(1, "ansible-when-list", Location{"roles/web/tasks/main.yml", 102, 9},
			"Split this conjunction into separate `when` items.",
			Fix{"This rule requires a manual change.", false},
			tasksSource, whenExpected, LineRange{99, 102}, LineRange{99, 104}),
		newFinding(2, "ansible-tag-name", Location{"roles/web/tasks/main.yml", 148, 7},
			"Use a kebab-case tag: replace `restart_web` with `restart-web`.",
			Fix{"This rule requires a manual change.", false},
			tasksSource, tagExpected, LineRange{144, 149}, LineRange{144, 149}),
		newFinding(3, "section-spacing", Location{"roles/web/defaults/main.yml", 10, 1},
			"Add a blank line between the section banner and its variables.",
			Fix{"An automatic formatting fix is available with `check --fix`.", true},
			defaultsSource, spacingExpected, LineRange{7, 13}, LineRange{7, 14}),
	}
	return Report{
		Title:    "Saltbox Lint",
		Findings: findings,
		Summary:  Summary{Errors: 3, Files: 2, AutomaticFixes: 1},
	}, nil
}

func newFinding(ordinal int, rule string, location Location, explanation string, fix Fix, current, suggested string, currentLines, suggestedLines LineRange) Finding {
	currentDocument := Document{Source: current, SourcePath: location.Path, Collections: []string{}}
	suggestedDocument := Document{Source: suggested, SourcePath: location.Path, Collections: []string{}}
	return Finding{
		Ordinal:     ordinal,
		Total:       3,
		Rule:        rule,
		Location:    location,
		Explanation: explanation,
		Fix:         fix,
		Current:     Excerpt{Document: currentDocument, Lines: currentLines},
		Suggested:   Excerpt{Document: suggestedDocument, Lines: suggestedLines},
		Diff:        Compare(current, suggested),
	}
}

func replaceOnce(source, old, replacement string) (string, error) {
	if strings.Count(source, old) != 1 {
		return "", fmt.Errorf("fixture must contain %q exactly once", strings.TrimSpace(old))
	}
	return strings.Replace(source, old, replacement, 1), nil
}
