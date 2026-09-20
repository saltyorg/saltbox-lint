package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestBackgroundQueryWriteResult(t *testing.T) {
	requestSize := len(ansi.RequestBackgroundColor)
	writeErr := errors.New("write failed")
	tests := []struct {
		name     string
		written  int
		writeErr error
		wantErr  error
	}{
		{"deadline", 0, context.DeadlineExceeded, context.DeadlineExceeded},
		{"canceled", 0, context.Canceled, context.Canceled},
		{"other error", 0, writeErr, writeErr},
		{"short write", requestSize - 1, nil, io.ErrShortWrite},
		{"partial write with error", 1, writeErr, writeErr},
		{"complete write", requestSize, nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := backgroundQueryWriteResult(tt.written, tt.writeErr)
			if tt.wantErr == nil {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("errors.Is(%v, %v) = false", err, tt.wantErr)
			}
			if !strings.Contains(err.Error(), fmt.Sprintf("wrote %d bytes", tt.written)) {
				t.Fatalf("missing written-byte context: %v", err)
			}
			if tt.writeErr != nil && errors.Is(err, io.ErrShortWrite) {
				t.Fatalf("real write error replaced by short-write error: %v", err)
			}
		})
	}
}
