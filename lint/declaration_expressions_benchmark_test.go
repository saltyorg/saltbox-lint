package lint

import (
	"fmt"
	"strings"
	"testing"
)

func BenchmarkDeclarationExpressionRules(b *testing.B) {
	for _, n := range []int{100, 200, 400, 800} {
		b.Run(fmt.Sprintf("declarations=%d", n), func(b *testing.B) {
			var text strings.Builder
			for i := range n {
				fmt.Fprintf(&text, "example_role_value_%d: literal\n", i)
			}
			source, ds := Parse("roles/example/defaults/main.yml", []byte(text.String()))
			if len(ds) != 0 {
				b.Fatal(ds)
			}
			project := &Project{Sources: map[string]*Source{source.Path: source}, Selected: map[string]bool{source.Path: true}}
			var rules []Rule
			for _, rule := range Rules() {
				if rule.ID == "docker-aggregate-contract" || rule.ID == "role-web-contract" {
					rules = append(rules, rule)
				}
			}
			b.ReportAllocs()
			for b.Loop() {
				Analyze(project, rules)
			}
		})
	}
}

func BenchmarkDeclarationExpressionQuery(b *testing.B) {
	for _, n := range []int{100, 200, 400, 800} {
		b.Run(fmt.Sprintf("declarations=%d", n), func(b *testing.B) {
			var text strings.Builder
			for i := range n {
				fmt.Fprintf(&text, "example_role_value_%d: '{{ value_%d }}'\n", i, i)
			}
			source, ds := Parse("roles/example/defaults/main.yml", []byte(text.String()))
			if len(ds) != 0 {
				b.Fatal(ds)
			}
			declarations := topLevelDeclarations(source)
			b.ReportAllocs()
			for b.Loop() {
				query := newDeclarationExpressionQuery(source)
				for _, declaration := range declarations {
					if got := query.expressions(declaration); len(got) != 1 {
						b.Fatalf("declaration %q expressions = %+v", declaration.Name, got)
					}
				}
			}
		})
	}
}
