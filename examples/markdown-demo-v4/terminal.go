package main

import (
	"bytes"
	"fmt"
	"os"
	"regexp"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/term"
	"golang.org/x/sys/unix"
)

const backgroundQueryTimeout = 250 * time.Millisecond

type backgroundQuery func() (dark bool, err error)

func resolveTheme(requested string, outputIsTerminal func() bool, query backgroundQuery) (themeChoice, error) {
	switch requested {
	case string(darkTheme):
		return darkTheme, nil
	case string(lightTheme):
		return lightTheme, nil
	case "auto":
	default:
		return "", fmt.Errorf("unknown theme %q: use auto, dark, or light", requested)
	}
	if !outputIsTerminal() {
		return darkTheme, nil
	}
	dark, err := query()
	if err != nil || dark {
		return darkTheme, nil
	}
	return lightTheme, nil
}

func queryControllingTerminal() (bool, error) {
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return false, fmt.Errorf("open controlling terminal: %w", err)
	}
	defer tty.Close()
	return queryBackground(tty, backgroundQueryTimeout)
}

func queryBackground(tty *os.File, timeout time.Duration) (bool, error) {
	state, err := term.MakeRaw(tty.Fd())
	if err != nil {
		return false, fmt.Errorf("set controlling terminal raw mode: %w", err)
	}
	defer term.Restore(tty.Fd(), state) //nolint:errcheck

	if err := unix.SetNonblock(int(tty.Fd()), true); err != nil {
		return false, fmt.Errorf("set controlling terminal nonblocking: %w", err)
	}
	defer unix.SetNonblock(int(tty.Fd()), false) //nolint:errcheck

	if _, err := tty.WriteString(ansi.RequestBackgroundColor); err != nil {
		return false, fmt.Errorf("request terminal background: %w", err)
	}

	deadline := time.Now().Add(timeout)
	var response []byte
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false, fmt.Errorf("terminal background query timed out")
		}
		milliseconds := int((remaining + time.Millisecond - 1) / time.Millisecond)
		fds := []unix.PollFd{{Fd: int32(tty.Fd()), Events: unix.POLLIN}}
		ready, err := unix.Poll(fds, milliseconds)
		if err != nil {
			return false, fmt.Errorf("wait for terminal background: %w", err)
		}
		if ready == 0 {
			return false, fmt.Errorf("terminal background query timed out")
		}
		var chunk [256]byte
		n, err := tty.Read(chunk[:])
		if err != nil {
			return false, fmt.Errorf("read terminal background: %w", err)
		}
		response = append(response, chunk[:n]...)
		if backgroundResponseComplete(response) {
			return parseBackgroundResponse(response)
		}
	}
}

var backgroundColorPattern = regexp.MustCompile(`^(?:#[[:xdigit:]]{3}|#[[:xdigit:]]{6}|rgb:[[:xdigit:]]{1,4}/[[:xdigit:]]{1,4}/[[:xdigit:]]{1,4})$`)

func backgroundResponseComplete(response []byte) bool {
	start := bytes.Index(response, []byte("\x1b]11;"))
	if start < 0 {
		return false
	}
	payload := response[start+len("\x1b]11;"):]
	return bytes.IndexByte(payload, '\a') >= 0 || bytes.Index(payload, []byte("\x1b\\")) >= 0
}

func parseBackgroundResponse(response []byte) (bool, error) {
	start := bytes.Index(response, []byte("\x1b]11;"))
	if start < 0 {
		return false, fmt.Errorf("terminal response does not contain an OSC 11 color")
	}
	payload := response[start+len("\x1b]11;"):]
	end := bytes.IndexByte(payload, '\a')
	if stringTerminator := bytes.Index(payload, []byte("\x1b\\")); end < 0 || stringTerminator >= 0 && stringTerminator < end {
		end = stringTerminator
	}
	if end < 0 {
		return false, fmt.Errorf("terminal OSC 11 response is incomplete")
	}
	value := string(payload[:end])
	if !backgroundColorPattern.MatchString(value) {
		return false, fmt.Errorf("terminal OSC 11 response has invalid color %q", value)
	}
	color := ansi.XParseColor(value)
	if color == nil {
		return false, fmt.Errorf("terminal OSC 11 response has unsupported color %q", value)
	}
	r, g, b, _ := color.RGBA()
	lightnessTwice := max(r, g, b) + min(r, g, b)
	return lightnessTwice < 0xffff, nil
}
