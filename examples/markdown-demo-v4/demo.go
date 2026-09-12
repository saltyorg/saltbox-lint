package main

import (
	_ "embed"
	"fmt"
	"strings"
)

//go:embed example.md
var demoTemplate string

//go:embed testdata/roles/web/tasks/main.yml
var tasksSource string

//go:embed testdata/roles/web/defaults/main.yml
var defaultsSource string

func loadDemoDocument() (string, []codeBlock, error) {
	whenExpected, err := replaceOnce(tasksSource,
		"  when: (web_config is defined) and web_enabled\n",
		"  when:\n    - (web_config is defined)\n    - web_enabled\n")
	if err != nil {
		return "", nil, err
	}
	tagExpected, err := replaceOnce(tasksSource, "    - restart_web\n", "    - restart-web\n")
	if err != nil {
		return "", nil, err
	}
	spacingExpected, err := replaceOnce(defaultsSource,
		"################################\nweb_role_enabled: true\n",
		"################################\n\nweb_role_enabled: true\n")
	if err != nil {
		return "", nil, err
	}

	blocks := []codeBlock{
		{Source: tasksSource, SourcePath: "roles/web/tasks/main.yml", Collections: []string{}, FirstLine: 99, LastLine: 102},
		{Source: whenExpected, SourcePath: "roles/web/tasks/main.yml", Collections: []string{}, FirstLine: 99, LastLine: 104},
		{Source: tasksSource, SourcePath: "roles/web/tasks/main.yml", Collections: []string{}, FirstLine: 144, LastLine: 149},
		{Source: tagExpected, SourcePath: "roles/web/tasks/main.yml", Collections: []string{}, FirstLine: 144, LastLine: 149},
		{Source: defaultsSource, SourcePath: "roles/web/defaults/main.yml", Collections: []string{}, FirstLine: 7, LastLine: 13},
		{Source: spacingExpected, SourcePath: "roles/web/defaults/main.yml", Collections: []string{}, FirstLine: 7, LastLine: 14},
	}
	placeholders := []string{
		"{{CURRENT_WHEN}}",
		"{{EXPECTED_WHEN}}",
		"{{CURRENT_TAG}}",
		"{{EXPECTED_TAG}}",
		"{{CURRENT_SPACING}}",
		"{{EXPECTED_SPACING}}",
	}
	markdown := demoTemplate
	for i, placeholder := range placeholders {
		excerpt, err := sourceLines(blocks[i].Source, blocks[i].FirstLine, blocks[i].LastLine)
		if err != nil {
			return "", nil, fmt.Errorf("prepare %s: %w", placeholder, err)
		}
		if strings.Count(markdown, placeholder) != 1 {
			return "", nil, fmt.Errorf("demo template must contain %s exactly once", placeholder)
		}
		markdown = strings.Replace(markdown, placeholder+"\n", excerpt, 1)
	}
	return markdown, blocks, nil
}

func replaceOnce(source, old, replacement string) (string, error) {
	if strings.Count(source, old) != 1 {
		return "", fmt.Errorf("fixture must contain %q exactly once", strings.TrimSpace(old))
	}
	return strings.Replace(source, old, replacement, 1), nil
}
