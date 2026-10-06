//go:build !windows

package lint

import "path/filepath"

func resolveSourcePath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
