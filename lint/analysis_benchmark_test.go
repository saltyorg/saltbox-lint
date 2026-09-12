package lint

import (
	"fmt"
	"strings"
	"testing"
)

// Parsing is deliberately outside the measured Analyze invocation. Each case
// increases contextual source count while preserving per-source work.
func BenchmarkAnalyzeSharedFacts(b *testing.B) {
	for _, count := range []int{1, 8, 32} {
		b.Run(fmt.Sprintf("role/sources=%d", count), func(b *testing.B) {
			files := map[string]string{traefikDefaultsPath: "example_role_traefik_enabled: true\n"}
			for i := range count {
				files[fmt.Sprintf("roles/example/tasks/render-%03d.yml", i)] = strings.Repeat("- copy:\n    content: '{{ unrelated }}'\n  when: example_enabled\n", 8)
			}
			p := traefikProject(files)
			rules := traefikRules("traefik-renderer-contract")
			b.ReportAllocs()
			for b.Loop() {
				Analyze(p, rules)
			}
		})
		b.Run(fmt.Sprintf("docker/sources=%d", count), func(b *testing.B) {
			files := map[string]string{}
			for i := range count {
				files[fmt.Sprintf("resources/tasks/docker/resource-%03d.yml", i)] = fmt.Sprintf("- set_fact:\n    resolved: \"{{ lookup('docker_vars', specs=specs) }}\"\n  vars:\n    specs:\n      _docker_value_%d:\n        omit: true\n- debug:\n    msg: \"{{ _docker_vars._docker_value_%d | default('none') }}\"\n", i, i)
			}
			p := traefikProject(files)
			rules := []Rule{{ID: "docker-vars-policy", Check: checkDockerVarsPolicy}}
			b.ReportAllocs()
			for b.Loop() {
				Analyze(p, rules)
			}
		})
	}
}
