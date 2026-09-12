//go:build linux || darwin

package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/charmbracelet/x/ansi"
	"golang.org/x/sys/unix"
)

// Query a separate descriptor so source input remains caller-owned. All I/O is
// nonblocking, with short poll windows for cancellation and no reader goroutine.
func queryControllingTerminal(ctx context.Context) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR|unix.O_NONBLOCK, 0)
	if err != nil {
		return false, err
	}
	defer func() { _ = tty.Close() }()
	return queryBackground(ctx, tty, backgroundQueryTimeout)
}

func queryBackground(ctx context.Context, tty *os.File, timeout time.Duration) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	fd := tty.Fd()
	state, err := unix.IoctlGetTermios(int(fd), terminalGetState)
	if err != nil {
		return false, err
	}
	// Preserve ISIG and the caller's signal characters: Ctrl+C must cancel the
	// command while we await OSC, rather than being consumed as response noise.
	mode := *state
	mode.Lflag &^= unix.ECHO | unix.ICANON
	mode.Cc[unix.VMIN] = 1
	mode.Cc[unix.VTIME] = 0
	if err := unix.IoctlSetTermios(int(fd), terminalSetState, &mode); err != nil {
		return false, err
	}
	defer unix.IoctlSetTermios(int(fd), terminalSetState, state) //nolint:errcheck
	if err := unix.SetNonblock(int(fd), true); err != nil {
		return false, err
	}
	defer unix.SetNonblock(int(fd), false) //nolint:errcheck
	// Use unix I/O: os.File.Read/Write may wait in the Go poller despite O_NONBLOCK.
	if n, err := unix.Write(int(fd), []byte(ansi.RequestBackgroundColor)); err != nil || n != len(ansi.RequestBackgroundColor) {
		return false, fmt.Errorf("request terminal background: wrote %d bytes: %v", n, err)
	}
	deadline := time.Now().Add(timeout)
	var response []byte
	for {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false, fmt.Errorf("terminal background query timed out")
		}
		milliseconds := int((min(remaining, 20*time.Millisecond) + time.Millisecond - 1) / time.Millisecond)
		fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		ready, err := unix.Poll(fds, milliseconds)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return false, err
		}
		if ready == 0 {
			continue
		}
		var chunk [256]byte
		n, err := unix.Read(int(fd), chunk[:])
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return false, err
		}
		if n == 0 {
			return false, fmt.Errorf("terminal closed during background query")
		}
		response = append(response, chunk[:n]...)
		if len(response) > 4096 {
			return false, fmt.Errorf("terminal background response too large")
		}
		if backgroundResponseComplete(response) {
			return parseBackgroundResponse(response)
		}
	}
}
