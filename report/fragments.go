package report

import (
	"context"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

const maximumRenderFragment = 64 * 1024

// textWriter is the common output surface for source rows and prose. Production
// uses fragmentWriter; strings.Builder remains useful for focused render tests.
type textWriter interface {
	io.Writer
	io.StringWriter
	WriteByte(byte) error
}

// fragmentWriter retains at most one fragment and the first output error.
// Each call receives complete renderer-generated ANSI sequences. Flushes split
// text only at UTF-8 boundaries and never split an escape sequence.
type fragmentWriter struct {
	ctx    context.Context
	emit   func(string) error
	buffer strings.Builder
	err    error
}

func (w *fragmentWriter) Write(p []byte) (int, error) { return w.WriteString(string(p)) }
func (w *fragmentWriter) WriteByte(b byte) error {
	_, err := w.WriteString(string([]byte{b}))
	return err
}
func (w *fragmentWriter) WriteString(s string) (int, error) {
	size := len(s)
	for len(s) > 0 {
		if err := w.check(); err != nil {
			return size - len(s), err
		}
		room := maximumRenderFragment - w.buffer.Len()
		n := fragmentPrefix(s, room)
		if n == 0 {
			if w.buffer.Len() == 0 {
				w.err = errors.New("render escape sequence exceeds fragment limit")
				return size - len(s), w.err
			}
			if err := w.flush(); err != nil {
				return size - len(s), err
			}
			continue
		}
		w.buffer.WriteString(s[:n])
		s = s[n:]
		if w.buffer.Len() == maximumRenderFragment {
			if err := w.flush(); err != nil {
				return size - len(s), err
			}
		}
	}
	return size, w.check()
}

func fragmentPrefix(s string, limit int) int {
	end := min(len(s), limit)
	for end > 0 && end < len(s) && !utf8.RuneStart(s[end]) {
		end--
	}
	// Output controls are exclusively renderer-generated CSI/OSC sequences;
	// source controls have already been escaped by visibleText.
	for i := 0; i < end; i++ {
		if s[i] != 0x1b {
			continue
		}
		start := i
		i++
		if i >= end {
			return start
		}
		switch s[i] {
		case '[':
			i++
			for i < len(s) && (s[i] < 0x40 || s[i] > 0x7e) {
				i++
			}
		case ']':
			i++
			for i < len(s) && s[i] != 7 && (s[i] != 0x1b || i+1 >= len(s) || s[i+1] != '\\') {
				i++
			}
			if i < len(s) && s[i] == 0x1b {
				i++
			}
		}
		if i >= end {
			return start
		}
	}
	return end
}
func (w *fragmentWriter) check() error {
	if w.err == nil {
		w.err = w.ctx.Err()
	}
	return w.err
}
func (w *fragmentWriter) flush() error {
	if err := w.check(); err != nil {
		return err
	}
	if w.buffer.Len() > 0 {
		w.err = w.emit(w.buffer.String())
		w.buffer.Reset()
	}
	return w.check()
}
func outputError(w textWriter) error {
	if f, ok := w.(*fragmentWriter); ok {
		return f.check()
	}
	return nil
}

// checkedWriter detects short writes before colorprofile translates byte counts.
type checkedWriter struct{ io.Writer }

func (w checkedWriter) Write(p []byte) (int, error) {
	n, err := w.Writer.Write(p)
	if err == nil && n != len(p) {
		err = io.ErrShortWrite
	}
	return n, err
}
