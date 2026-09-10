package lint

import (
	"slices"
	"testing"
)

func TestVariableReadsDistinguishesBindingsFromDefaultExpressions(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  []string
	}{
		{"{{ value + value.attr + obj.value + value['key'] }}", []string{"value", "value", "obj", "value"}},
		{"{{ thing | value(arg=value) is not value }}", []string{"thing", "value"}},
		{"{% set value, other = source %}", []string{"source"}},
		{"{% set value %}", nil},
		{"{% set value | trim %}", nil},
		{"{% set value | default(source) %}", []string{"source"}},
		{"{% set value | default(source, flag=other) | replace(old, new) %}", []string{"source", "other", "old", "new"}},
		{"{% for value, other in source %}", []string{"source"}},
		{"{% import source as value %}", []string{"source"}},
		{"{% from source import value as alias, other %}", []string{"source"}},
		{"{% macro value(arg, second=source, third=fn(value, [other])) %}", []string{"source", "value", "other"}},
		{"{% call(value, other) fn(source) %}", []string{"source"}},
		{"{% filter value(arg=source) %}", []string{"source"}},
		{"{{ fn(arg=source) }}", []string{"source"}},
	} {
		t.Run(tc.input, func(t *testing.T) {
			source, ds := Parse("example.yml", []byte("v: |\n  "+tc.input+"\n"))
			if len(ds) > 0 {
				t.Fatal(ds)
			}
			expressions := Expressions(source)
			if len(expressions) != 1 {
				t.Fatalf("expressions=%+v", expressions)
			}
			var got []string
			for _, token := range VariableReads(expressions[0]) {
				got = append(got, token.Text)
				if string(source.Data[token.Span.Start:token.Span.End]) != token.Text {
					t.Fatalf("read span=%+v", token)
				}
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("reads=%v want=%v", got, tc.want)
			}
		})
	}
}
