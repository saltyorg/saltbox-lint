package editorprocess

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

// lostRecorder joins the watcher goroutine through its terminal callback.
func lostRecorder() (func(), <-chan struct{}) {
	lost := make(chan struct{})
	return func() { close(lost) }, lost
}

func awaitLost(t *testing.T, lost <-chan struct{}) {
	t.Helper()
	select {
	case <-lost:
	case <-time.After(10 * time.Second):
		t.Fatal("lifetime watcher did not report owner loss")
	}
}

func TestLifetimeEOFCancelsWithOwnerLoss(t *testing.T) {
	reader, writer := io.Pipe()
	onLost, lost := lostRecorder()
	ctx := watch(t.Context(), reader, onLost)
	if ctx.Err() != nil {
		t.Fatal("open lifetime pipe cancelled the context")
	}
	// Data is not a control message; only EOF or failure ends the lifetime.
	if _, err := writer.Write([]byte("unexpected")); err != nil {
		t.Fatal(err)
	}
	if ctx.Err() != nil {
		t.Fatal("lifetime data cancelled the context")
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	awaitLost(t, lost)
	if !errors.Is(context.Cause(ctx), ErrOwnerLost) || !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatalf("unexpected cancellation: err=%v cause=%v", ctx.Err(), context.Cause(ctx))
	}
}

func TestLifetimeReadFailureCancelsWithOwnerLoss(t *testing.T) {
	reader, writer := io.Pipe()
	onLost, lost := lostRecorder()
	ctx := watch(t.Context(), reader, onLost)
	writer.CloseWithError(errors.New("broken lifetime pipe"))
	awaitLost(t, lost)
	if !errors.Is(context.Cause(ctx), ErrOwnerLost) {
		t.Fatalf("read failure was not owner loss: %v", context.Cause(ctx))
	}
}

func TestLifetimeParentCancellationIsNotOwnerLoss(t *testing.T) {
	reader, writer := io.Pipe()
	parent, cancel := context.WithCancel(t.Context())
	onLost, lost := lostRecorder()
	ctx := watch(parent, reader, onLost)
	cancel()
	<-ctx.Done()
	if errors.Is(context.Cause(ctx), ErrOwnerLost) {
		t.Fatal("ordinary cancellation reported owner loss")
	}
	select {
	case <-lost:
		t.Fatal("ordinary cancellation terminated the owner")
	default:
	}
	// Join the watcher before returning.
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	awaitLost(t, lost)
}

func TestLifetimeRequiresEditorProtocol(t *testing.T) {
	for name, values := range map[string][2]string{
		"no editor":              {"", ""},
		"editor without pipe":    {"1", ""},
		"pipe without editor":    {"", lifetimeDescriptor},
		"disabled editor":        {"0", lifetimeDescriptor},
		"unsupported descriptor": {"1", "4"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(editorEnvironment, values[0])
			t.Setenv(lifetimeEnvironment, values[1])
			parent := t.Context()
			if ctx := WatchLifetime(parent); ctx != parent {
				t.Fatal("lifetime watcher started without the editor protocol")
			}
			ExitIfOwnerLost(parent)
		})
	}
}
