// Package nativeio provides cancellable synchronous Windows file and console I/O.
package nativeio

import (
	"context"
	"errors"
	"os"
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ErrOverlappedHandle rejects custom asynchronous handles, which cannot be
// canceled with the synchronous thread boundary used for inherited stdin.
var ErrOverlappedHandle = errors.New("overlapped handles are not supported by synchronous native I/O")

var cancelSynchronousIO = windows.NewLazySystemDLL("kernel32.dll").NewProc("CancelSynchronousIo")

// Read supports inherited synchronous pipes, redirected files and consoles.
// It retains os.File's Unicode console decoding and the inherited file offset.
func Read(ctx context.Context, file *os.File, p []byte) (int, error) {
	if err := synchronousHandle(ctx, file); err != nil {
		return 0, err
	}
	return run(ctx, func() (int, error) { return file.Read(p) })
}

// Write bounds console writes without changing the caller's handle or mode.
func Write(ctx context.Context, file *os.File, p []byte) (int, error) {
	if err := synchronousHandle(ctx, file); err != nil {
		return 0, err
	}
	return run(ctx, func() (int, error) { return file.Write(p) })
}

func run(ctx context.Context, operation func() (int, error)) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	thread, err := windows.OpenThread(windows.THREAD_TERMINATE, false, windows.GetCurrentThreadId())
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(thread) //nolint:errcheck
	done := make(chan struct{})
	joined := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		defer close(joined)
		// Cancellation can arrive between the context check and the syscall. Retry
		// ERROR_NOT_FOUND as well as successful cancellation until the I/O joins.
		// The thread remains locked until this callback stops, so it can never
		// cancel another goroutine's I/O after runtime thread reuse.
		timer := time.NewTicker(time.Millisecond)
		defer timer.Stop()
		for {
			select {
			case <-done:
				return
			default:
			}
			_, _, _ = cancelSynchronousIO.Call(uintptr(thread))
			select {
			case <-done:
				return
			case <-timer.C:
			}
		}
	})
	var n int
	if err = ctx.Err(); err == nil {
		n, err = operation()
	}
	close(done)
	if !stop() {
		<-joined
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return n, ctxErr
	}
	return n, err
}

// The FileModeInformation query matches Go's own Windows IsNonblock check.
// Console handles are always synchronous and do not support this file query.
func synchronousHandle(ctx context.Context, file *os.File) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	handle := windows.Handle(file.Fd())
	var mode uint32
	if windows.GetConsoleMode(handle, &mode) == nil {
		return nil
	}
	const fileModeInformation = 16
	var status windows.IO_STATUS_BLOCK
	if err := windows.NtQueryInformationFile(handle, &status, (*byte)(unsafe.Pointer(&mode)), uint32(unsafe.Sizeof(mode)), fileModeInformation); err != nil {
		return err
	}
	if mode&(windows.FILE_SYNCHRONOUS_IO_ALERT|windows.FILE_SYNCHRONOUS_IO_NONALERT) == 0 {
		return ErrOverlappedHandle
	}
	return nil
}
