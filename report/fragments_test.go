package report

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/synctest"
	"unicode/utf8"

	charmansi "github.com/charmbracelet/x/ansi"
	"github.com/saltyorg/saltbox-lint/lint"
)

func TestFragmentsPreserveUTF8ANSIAndFindingFlush(t *testing.T) {
	for _, unit := range []string{"界", "e\u0301", "👩‍💻", "\x1b[38;2;120;80;255m界\x1b[0m", "\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\"} {
		var chunks []string
		w := &fragmentWriter{ctx: t.Context(), emit: func(s string) error { chunks = append(chunks, s); return nil }}
		input := strings.Repeat(unit, 30000)
		if _, err := w.WriteString(input); err != nil {
			t.Fatal(err)
		}
		if len(chunks) == 0 {
			t.Fatal("no early output before finding flush")
		}
		if err := w.flush(); err != nil {
			t.Fatal(err)
		}
		var plain strings.Builder
		for _, s := range chunks {
			if len(s) > 65536 || !utf8.ValidString(s) {
				t.Fatalf("invalid fragment: %d bytes", len(s))
			}
			plain.WriteString(charmansi.Strip(s))
		}
		if strings.Join(chunks, "") != input || plain.String() != charmansi.Strip(input) {
			t.Fatal("fragment boundaries changed UTF8/ANSI text")
		}
		before := len(chunks)
		_, _ = w.WriteString("small finding")
		if err := w.flush(); err != nil {
			t.Fatal(err)
		}
		if len(chunks) != before+1 || chunks[len(chunks)-1] != "small finding" {
			t.Fatal("small finding not flushed")
		}
	}
}

func TestFragmentFailureStopsFurtherOutput(t *testing.T) {
	failure := errors.New("writer failed")
	calls := 0
	w := &fragmentWriter{ctx: t.Context(), emit: func(string) error { calls++; return failure }}
	if _, err := w.WriteString(strings.Repeat("x", 200000)); !errors.Is(err, failure) {
		t.Fatalf("error %v", err)
	}
	_, _ = w.WriteString("later")
	_ = w.flush()
	if calls != 1 {
		t.Fatalf("continued after writer failure: %d", calls)
	}
}

func TestFileFragmentCancellationUnblocksFullQueue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		source := &lint.Source{Path: "a.yml", Data: []byte(strings.Repeat("# "+strings.Repeat("x", 70)+"\n", 10000))}
		p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
		r, err := newHumanRenderer(nil, p, HumanOptions{Context: ctx})
		if err != nil {
			t.Fatal(err)
		}
		defer r.close()
		job := &fileRenderJob{group: diagnosticGroup{diagnostics: diagnostics(p, []lint.Diagnostic{{Path: source.Path, RuleID: "large", Message: "large", Span: lint.Span{End: len(source.Data) - 1}}})}, chunks: make(chan string, 4)}
		done := make(chan bool, 1)
		go func() { done <- r.renderFileJob(job, func(error) {}) }()
		synctest.Wait()
		if len(job.chunks) != 4 {
			t.Fatalf("expected saturated four-fragment queue, got %d", len(job.chunks))
		}
		for range 4 {
			s := <-job.chunks
			if len(s) > 65536 {
				t.Fatalf("queued fragment %d", len(s))
			}
		}
		synctest.Wait()
		cancel()
		synctest.Wait()
		if <-done {
			t.Fatal("canceled job reported success")
		}
		for range job.chunks {
		} // Worker owns and closes its stream before returning.
	})
}

type shortHumanWriter struct{}

func (shortHumanWriter) Write(p []byte) (int, error) { return len(p) - 1, nil }
func TestHumanRejectsShortWrites(t *testing.T) {
	p, raw := humanStreamingFixture(t)
	if err := Render(shortHumanWriter{}, p, raw, Options{}); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short write error = %v", err)
	}
}
