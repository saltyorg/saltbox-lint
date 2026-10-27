package lint

import (
	"os"

	"golang.org/x/sys/windows"
)

// sourceLinkCount reports the number of directory entries naming the file.
// Windows FileInfo omits link counts, so the opened handle supplies them.
func sourceLinkCount(root *os.Root, name string) (uint64, error) {
	file, err := root.Open(name)
	if err != nil {
		return 0, err
	}
	defer func() { _ = file.Close() }()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return 0, &os.PathError{Op: "inspect links", Path: name, Err: err}
	}
	return uint64(info.NumberOfLinks), nil
}
