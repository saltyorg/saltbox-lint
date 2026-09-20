package cmd

import (
	"bytes"
	"fmt"
	"io"
	"regexp"
	"time"

	"github.com/charmbracelet/x/ansi"
)

const backgroundQueryTimeout = 250 * time.Millisecond

func backgroundQueryWriteResult(written int, writeErr error) error {
	if writeErr == nil && written == len(ansi.RequestBackgroundColor) {
		return nil
	}
	if writeErr == nil {
		writeErr = io.ErrShortWrite
	}
	return fmt.Errorf("request terminal background: wrote %d bytes: %w", written, writeErr)
}

var backgroundColorPattern = regexp.MustCompile(`^(?:#[[:xdigit:]]{3}|#[[:xdigit:]]{6}|rgb:[[:xdigit:]]{1,4}/[[:xdigit:]]{1,4}/[[:xdigit:]]{1,4})$`)

func backgroundResponseComplete(response []byte) bool {
	start := bytes.Index(response, []byte("\x1b]11;"))
	if start < 0 {
		return false
	}
	payload := response[start+len("\x1b]11;"):]
	return bytes.IndexByte(payload, '\a') >= 0 || bytes.Contains(payload, []byte("\x1b\\"))
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
