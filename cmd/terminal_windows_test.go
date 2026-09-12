package cmd

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/saltyorg/saltbox-lint/nativeio"
	"golang.org/x/sys/windows"
)

func TestConsoleBackgroundTimeoutRestoresModes(t *testing.T) {
	if os.Getenv("SALTBOX_LINT_CONSOLE_HELPER") != "1" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		child := exec.CommandContext(ctx, executable, "-test.run=^TestConsoleBackgroundTimeoutRestoresModes$")
		child.Env = append(os.Environ(), "SALTBOX_LINT_CONSOLE_HELPER=1")
		if output, err := child.CombinedOutput(); err != nil {
			t.Fatalf("console helper: %v\n%s", err, output)
		}
		return
	}
	kernel := windows.NewLazySystemDLL("kernel32.dll")
	// Detach only the helper; never change the test runner's console.
	_, _, _ = kernel.NewProc("FreeConsole").Call()
	if ok, _, err := kernel.NewProc("AllocConsole").Call(); ok == 0 {
		t.Fatal(err)
	}
	defer func() { _, _, _ = kernel.NewProc("FreeConsole").Call() }()
	input, err := os.OpenFile("CONIN$", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = input.Close() }()
	output, err := os.OpenFile("CONOUT$", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = output.Close() }()
	var inMode, outMode uint32
	if err := windows.GetConsoleMode(windows.Handle(input.Fd()), &inMode); err != nil {
		t.Fatal(err)
	}
	if err := windows.GetConsoleMode(windows.Handle(output.Fd()), &outMode); err != nil {
		t.Fatal(err)
	}
	readCtx, cancelRead := context.WithTimeout(t.Context(), 25*time.Millisecond)
	_, readErr := nativeio.Read(readCtx, input, make([]byte, 1))
	cancelRead()
	if !errors.Is(readErr, context.DeadlineExceeded) {
		t.Fatalf("idle console read: %v", readErr)
	}
	start := time.Now()
	_, err = queryConsoleBackground(t.Context(), input, output, 25*time.Millisecond)
	if err != nil && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("query: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("console query exceeded cancellation bound")
	}
	var afterIn, afterOut uint32
	if err := windows.GetConsoleMode(windows.Handle(input.Fd()), &afterIn); err != nil {
		t.Fatal(err)
	}
	if err := windows.GetConsoleMode(windows.Handle(output.Fd()), &afterOut); err != nil {
		t.Fatal(err)
	}
	if afterIn != inMode || afterOut != outMode {
		t.Fatalf("modes changed: in %x -> %x, out %x -> %x", inMode, afterIn, outMode, afterOut)
	}
}
