package fuzztest

import (
	"bytes"
	"strings"
	"testing"
)

func TestBoundedRejectsCompactNestingAndUnaryChains(t *testing.T) {
	for _, tc := range []struct{ name, input string }{
		{"compact sequence", strings.Repeat("- ", 65) + "value"},
		{"unary expression", strings.Repeat("not ", 65) + "value"},
		{"compact mapping", strings.Repeat("key: ", 65) + "value"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if Bounded([]byte(tc.input)) {
				t.Fatal("recursive input bypassed the conservative lexical bound")
			}
		})
	}
}

func TestBoundedRetainsSizeAndIndicatorLimits(t *testing.T) {
	if !Bounded(bytes.Repeat([]byte{'x'}, MaxBytes)) || Bounded(bytes.Repeat([]byte{'x'}, MaxBytes+1)) {
		t.Fatal("input size limit changed")
	}
	if !Bounded(bytes.Repeat([]byte{'-'}, 63)) || Bounded(bytes.Repeat([]byte{'-'}, 64)) {
		t.Fatal("lexical indicator limit changed")
	}
}
