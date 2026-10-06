package lint

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// resolveSourcePath follows both symbolic links and directory junctions.
// EvalSymlinks leaves a terminal junction unresolved because Windows Lstat
// reports mount-point reparse tags as ModeIrregular rather than ModeSymlink.
// The final handle name establishes physical ownership only; callers still
// check containment and use os.Root for subsequent source reads and writes.
func resolveSourcePath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	// Extended paths preserve long names when opening the identity handle.
	if !strings.HasPrefix(absolute, `\\?\`) {
		if strings.HasPrefix(absolute, `\\`) {
			absolute = `\\?\UNC\` + absolute[2:]
		} else {
			absolute = `\\?\` + absolute
		}
	}
	name, err := windows.UTF16PtrFromString(absolute)
	if err != nil {
		return "", &os.PathError{Op: "resolve", Path: path, Err: err}
	}
	handle, err := windows.CreateFile(name, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", &os.PathError{Op: "resolve", Path: path, Err: err}
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	buffer := make([]uint16, 512)
	for {
		n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
		if err != nil {
			return "", &os.PathError{Op: "resolve", Path: path, Err: err}
		}
		if n >= uint32(len(buffer)) {
			if n >= 32768 {
				return "", &os.PathError{Op: "resolve", Path: path, Err: windows.ERROR_FILENAME_EXCED_RANGE}
			}
			buffer = make([]uint16, n+1)
			continue
		}
		resolved := windows.UTF16ToString(buffer[:n])
		if strings.HasPrefix(resolved, `\\?\UNC\`) {
			resolved = `\\` + resolved[len(`\\?\UNC\`):]
		} else {
			resolved = strings.TrimPrefix(resolved, `\\?\`)
		}
		return filepath.Clean(resolved), nil
	}
}
