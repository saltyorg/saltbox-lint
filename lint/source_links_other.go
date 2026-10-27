//go:build !windows

package lint

import (
	"fmt"
	"os"
	"syscall"
)

// sourceLinkCount reports the number of directory entries naming the file.
func sourceLinkCount(root *os.Root, name string) (uint64, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return 0, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("link count unavailable for %s", name)
	}
	return uint64(stat.Nlink), nil
}
