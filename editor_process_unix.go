//go:build !windows

package main

import "github.com/saltyorg/saltbox-lint/internal/editorprocess"

// The extension owns ordinary POSIX groups. Test launchers additionally own
// detached CLI groups through an acknowledged lifetime connection.
func setupEditorProcess() error { return editorprocess.StartFromEnvironment() }
