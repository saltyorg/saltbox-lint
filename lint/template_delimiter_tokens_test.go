package lint

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTemplateConflictingClosingDelimitersArePartial(t *testing.T) {
	// These endings can occur inside whole name, number or operator tokens.
	// Unsupported configuration must stop every consumer before tag scanning.
	for _, end := range []string{"api", "_api", "12", ".", "=", "*", "/", "é", "+", "-", "+12", "-12"} {
		for _, key := range []string{"variable_end_string", "block_end_string"} {
			t.Run(key+"/"+end, func(t *testing.T) {
				text := "#jinja2:" + key + ":'" + end + "'\n{{ traefik_middleware_api " + end + " {{ example_role_traefik_api_enabled " + end + " {{ example_role_traefik_api_endpoint " + end + " {% if count12 == 1.12 ** 2 // 1 %}"
				source, _ := Parse("roles/example/templates/router.j2", []byte(text))
				scan := scanTemplate(source)
				if !scan.configurationUnavailable || !strings.Contains(strings.Join(scan.reasonMessages(), ";"), "may split") || len(scan.diagnostics) != 0 || len(scan.expressions) != 0 || len(Expressions(source)) != 0 || len(sourceRoleReferences(source)) != 0 {
					t.Fatalf("conflicting config leaked static grammar: %+v", scan)
				}
				if observedSource(source).ParseState != "partial-template" || string(source.Data) != text {
					t.Fatal("partial state or bytes lost")
				}
				root := t.TempDir()
				filename := putFile(t, root, source.Path, text)
				result, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, Operation: "definition", Source: []byte(text), Offset: strings.Index(text, "example_role")})
				if err != nil || result.State != "unavailable" || len(result.Locations) != 0 {
					t.Fatalf("partial query produced authority: %+v %v", result, err)
				}
			})
		}
	}
}

func TestTemplateTokenDelimiterFixtures(t *testing.T) {
	for _, name := range []string{"custom-token-valid.j2", "custom-token-partial.j2"} {
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata/templates", name))
			if err != nil {
				t.Fatal(err)
			}
			source, _ := Parse("roles/example/templates/router.j2", data)
			scan := scanTemplate(source)
			if len(scan.diagnostics) != 0 {
				t.Fatalf("fabricated delimiter error: %+v", scan)
			}
			if name == "custom-token-partial.j2" {
				if !scan.configurationUnavailable || len(scan.expressions) != 0 || !strings.Contains(strings.Join(scan.reasonMessages(), ";"), "may split") {
					t.Fatalf("lost partial reason: %+v", scan)
				}
			} else {
				if len(scan.reasons) != 0 || len(scan.expressions) != 3 {
					t.Fatalf("ordinary punctuation grammar lost: %+v", scan)
				}
				for i, expression := range scan.expressions {
					if len(expression.Tokens) != 1 || expression.Tokens[0].Kind != "name" || !strings.Contains(expression.Tokens[0].Text, "api") || string(data[expression.Tokens[0].Span.Start:expression.Tokens[0].Span.End]) != expression.Tokens[0].Text {
						t.Fatalf("identifier %d split or spans changed: %+v", i, expression)
					}
				}
			}
			if !bytes.Equal(data, source.Data) {
				t.Fatal("delimiter fixture changed")
			}
		})
	}
	// Comments have no identifier/number/operator lexer. Word endings remain
	// literal there, and quoted delimiter-like content stays inside the string.
	text := "#jinja2:comment_end_string:'api',variable_end_string:']]'\n{# traefik_middleware_api {{ 'api ]]' ]]"
	source, _ := Parse("comment.j2", []byte(text))
	if scan := scanTemplate(source); len(scan.diagnostics) != 0 || len(scan.reasons) != 0 || len(scan.expressions) != 1 {
		t.Fatalf("comment or quote precedence changed: %+v", scan)
	}
}
