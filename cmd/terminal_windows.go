package cmd

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/saltyorg/saltbox-lint/nativeio"
	"golang.org/x/sys/windows"
)

func queryControllingTerminal(ctx context.Context) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	input, err := os.OpenFile("CONIN$", os.O_RDWR, 0)
	if err != nil {
		return false, err
	}
	defer func() { _ = input.Close() }()
	output, err := os.OpenFile("CONOUT$", os.O_RDWR, 0)
	if err != nil {
		return false, err
	}
	defer func() { _ = output.Close() }()
	return queryConsoleBackground(ctx, input, output, backgroundQueryTimeout)
}

func queryConsoleBackground(ctx context.Context, input, output *os.File, timeout time.Duration) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	inHandle, outHandle := windows.Handle(input.Fd()), windows.Handle(output.Fd())
	var inMode, outMode uint32
	if err := windows.GetConsoleMode(inHandle, &inMode); err != nil {
		return false, err
	}
	if err := windows.GetConsoleMode(outHandle, &outMode); err != nil {
		return false, err
	}
	// Retain processed input so Ctrl+C still cancels. Do not flush queued user
	// input; disabling line/echo plus VT input lets OSC responses reach Read.
	mode := (inMode &^ (windows.ENABLE_LINE_INPUT | windows.ENABLE_ECHO_INPUT)) | windows.ENABLE_VIRTUAL_TERMINAL_INPUT
	if err := windows.SetConsoleMode(inHandle, mode); err != nil {
		return false, err
	}
	defer windows.SetConsoleMode(inHandle, inMode) //nolint:errcheck
	if err := windows.SetConsoleMode(outHandle, outMode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING); err != nil {
		return false, err
	}
	defer windows.SetConsoleMode(outHandle, outMode) //nolint:errcheck
	n, writeErr := nativeio.Write(ctx, output, []byte(ansi.RequestBackgroundColor))
	if err := backgroundQueryWriteResult(n, writeErr); err != nil {
		return false, err
	}
	var response []byte
	for {
		var chunk [256]byte
		n, err := nativeio.Read(ctx, input, chunk[:])
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
