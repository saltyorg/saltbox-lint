package format

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestOwnerIndexPreservesStableSyntaxPaths(t *testing.T) {
	data := "- name: first\n  when: a and b\n- name: second\n  when: c and d\n"
	source, ds := lint.Parse("roles/example/tasks/main.yml", []byte(data))
	if len(ds) > 0 {
		t.Fatal(ds)
	}
	index, err := newOwnerIndex(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct{ text, want string }{{"first", "d0/i0/v0"}, {"a and b", "d0/i0/v1"}, {"second", "d0/i1/v0"}, {"c and d", "d0/i1/v1"}, {"name: first\n  when: a and b", "d0/i0"}} {
		start := strings.Index(data, tt.text)
		got, err := index.owner(t.Context(), lint.Span{Start: start, End: start + len(tt.text)})
		if err != nil || got != tt.want {
			t.Fatalf("%q owner=%q, %v; want %q", tt.text, got, err, tt.want)
		}
	}
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := newOwnerIndex(canceled, source); !errors.Is(err, context.Canceled) {
		t.Fatalf("index cancellation: %v", err)
	}
	if _, err := index.owner(canceled, lint.Span{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("lookup cancellation: %v", err)
	}
}

func BenchmarkDiagnosticHeavyFormatting(b *testing.B) {
	for _, n := range []int{100, 1000, 2000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			data := []byte(strings.Repeat("- debug: {msg: x}\n  when: a and b\n", n))
			b.ReportAllocs()
			b.SetBytes(int64(len(data)))
			for b.Loop() {
				result, err := Plan(b.Context(), "roles/example/tasks/main.yml", data)
				if err != nil || result.Status != "ready" {
					b.Fatalf("plan: %+v %v", result, err)
				}
			}
		})
	}
}

func BenchmarkCommentedFlowFormatting(b *testing.B) {
	for _, n := range []int{100, 1000, 2000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			data := []byte(strings.Repeat("# Keep the task comment.\n- debug: {msg: x}\n", n))
			b.ReportAllocs()
			b.SetBytes(int64(len(data)))
			for b.Loop() {
				result, err := Plan(b.Context(), "roles/example/tasks/main.yml", data)
				if err != nil || result.Status != "ready" {
					b.Fatalf("plan: %+v %v", result, err)
				}
			}
		})
	}
}
