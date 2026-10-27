package editorprocess

import (
	"context"
	"errors"
	"io"
	"os"
)

const (
	// lifetimeEnvironment names the inherited descriptor that the editor keeps
	// open, and never writes to, until it has joined this process.
	lifetimeEnvironment = "SALTBOX_LINT_EDITOR_LIFETIME"
	// lifetimeDescriptor is the only supported value: Node's fourth stdio entry.
	lifetimeDescriptor = "3"
	// OwnerLostExitCode is the status used when the editor owner disappears and
	// this process cannot terminate through its own process-group signal.
	// Ordinary CLI statuses are 0, 1 and 2.
	OwnerLostExitCode = 3
)

// ErrOwnerLost is the cancellation cause after the editor lifetime pipe closes.
var ErrOwnerLost = errors.New("editor process owner exited")

// WatchLifetime returns parent unchanged unless this is an editor invocation
// with an inherited lifetime pipe. Otherwise the returned context is cancelled
// with ErrOwnerLost when that pipe reaches EOF or fails, and the process then
// terminates its owned descendants and exits. Normal completion is unaffected:
// the editor never closes its end before it has joined this process.
func WatchLifetime(parent context.Context) context.Context {
	if os.Getenv(editorEnvironment) != "1" || os.Getenv(lifetimeEnvironment) != lifetimeDescriptor {
		return parent
	}
	source := openLifetime()
	if source == nil {
		return parent
	}
	// Descendants such as Git must not interpret or retain the protocol.
	_ = os.Unsetenv(lifetimeEnvironment)
	return watch(parent, source, terminateLostOwner)
}

// ExitIfOwnerLost terminates the process when ctx came from WatchLifetime and
// the owner was lost. A command that returns because of that cancellation must
// not exit normally before its descendants have been terminated.
func ExitIfOwnerLost(ctx context.Context) {
	if errors.Is(context.Cause(ctx), ErrOwnerLost) {
		terminateLostOwner()
	}
}

// watch drains source until EOF or a read error. The owner never writes, so any
// data is ignored rather than treated as a control message. lost runs after the
// context is cancelled and is not expected to return in production.
func watch(parent context.Context, source io.Reader, lost func()) context.Context {
	ctx, cancel := context.WithCancelCause(parent)
	go func() {
		buffer := make([]byte, 512)
		for {
			if _, err := source.Read(buffer); err != nil {
				break
			}
		}
		cancel(ErrOwnerLost)
		lost()
	}()
	return ctx
}
