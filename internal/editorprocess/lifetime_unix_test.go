//go:build !windows

package editorprocess

import (
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

// duplicate gives openDescriptor its own descriptor, as inheritance would.
func duplicate(t *testing.T, file *os.File) int {
	t.Helper()
	fd, err := unix.Dup(int(file.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	return fd
}

func TestLifetimeDescriptorRejectsNonPipes(t *testing.T) {
	regular, err := os.Create(filepath.Join(t.TempDir(), "regular"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = regular.Close() })
	fd := duplicate(t, regular)
	t.Cleanup(func() { _ = unix.Close(fd) })
	if openDescriptor(fd) != nil {
		t.Fatal("regular file accepted as a lifetime pipe")
	}
	closed := duplicate(t, regular)
	if err := unix.Close(closed); err != nil {
		t.Fatal(err)
	}
	if openDescriptor(closed) != nil {
		t.Fatal("closed descriptor accepted as a lifetime pipe")
	}
}

func TestLifetimeDescriptorAcceptsSocketAndFIFO(t *testing.T) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	owner := os.NewFile(uintptr(fds[1]), "owner")
	t.Cleanup(func() { _ = owner.Close() })
	pipeReader, pipeWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pipeReader.Close(); _ = pipeWriter.Close() })
	for name, test := range map[string]struct {
		fd    int
		owner io.Closer
	}{
		"socket pair": {fds[0], owner},
		"FIFO":        {duplicate(t, pipeReader), pipeWriter},
	} {
		t.Run(name, func(t *testing.T) {
			// Inherited descriptors lack close-on-exec.
			if _, err := unix.FcntlInt(uintptr(test.fd), unix.F_SETFD, 0); err != nil {
				t.Fatal(err)
			}
			source := openDescriptor(test.fd)
			if source == nil {
				t.Fatal("pipe rejected")
			}
			t.Cleanup(func() { _ = source.(io.Closer).Close() })
			flags, err := unix.FcntlInt(uintptr(test.fd), unix.F_GETFD, 0)
			if err != nil || flags&unix.FD_CLOEXEC == 0 {
				t.Fatalf("lifetime descriptor remains inheritable: flags=%d err=%v", flags, err)
			}
			onLost, lost := lostRecorder()
			ctx := watch(t.Context(), source, onLost)
			if err := test.owner.Close(); err != nil {
				t.Fatal(err)
			}
			awaitLost(t, lost)
			if ctx.Err() == nil {
				t.Fatal("owner close did not cancel")
			}
		})
	}
}
