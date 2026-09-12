//go:build !windows

package main

// POSIX editor process groups are owned by the invoking extension.
func setupEditorProcess() error { return nil }
