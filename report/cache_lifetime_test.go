package report

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"testing/synctest"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestSequentialRendererReleasesDisplayDataAtPrimaryFileTransitions(t *testing.T) {
	project, records := displayLifetimeFixture(t, 12)
	out := new(sectionWriter)
	r, err := newHumanRenderer(out, project, HumanOptions{ColorProfile: ColorTrueColor, Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()

	maxLines, maxTokens := 0, 0
	out.afterWrite = func(int) {
		maxLines = max(maxLines, len(r.lines))
		maxTokens = max(maxTokens, len(r.tokens))
		if len(r.lines) > 2 || len(r.tokens) > 2 {
			t.Errorf("completed primary files remain cached: %d line maps, %d token maps", len(r.lines), len(r.tokens))
		}
		if r.prepared.document == nil {
			t.Error("active primary file has no prepared display document")
		}
	}
	if err := r.renderSequentialFindings(records); err != nil {
		t.Fatal(err)
	}
	if len(out.writes) != len(records) {
		t.Fatalf("rendered sections = %d, want %d", len(out.writes), len(records))
	}
	if maxLines != 2 || maxTokens != 2 {
		t.Fatalf("active display caches = %d line maps, %d token maps, want primary plus related", maxLines, maxTokens)
	}
	assertDisplayDataReleased(t, r)
}

func TestSequentialRendererReleasesDisplayDataButRetainsNoncontiguousProposalReference(t *testing.T) {
	project, records := displayLifetimeFixture(t, 2)
	first := records[0]
	edit := lint.Edit{Span: lint.Span{Start: first.Span.Start, End: first.Span.End}, Text: "right"}
	first.preview = &lint.Preview{Edits: []lint.Edit{edit}}
	repeated := first
	repeated.RuleID = "repeated"
	repeated.Message = "same proposal after another primary file"
	records = []Diagnostic{first, records[1], repeated}

	var out bytes.Buffer
	r, err := newHumanRenderer(&out, project, HumanOptions{ColorProfile: ColorTrueColor, Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()
	if err := r.renderSequentialFindings(records); err != nil {
		t.Fatal(err)
	}
	if strings.Count(out.String(), "--- current/"+first.Path) != 1 || !strings.Contains(out.String(), "Suggestion shown above") {
		t.Fatalf("noncontiguous proposal identity was lost:\n%s", &out)
	}
	assertDisplayDataReleased(t, r)
}

func TestParallelRendererReleasesDisplayDataBetweenReusedJobs(t *testing.T) {
	project, records := displayLifetimeFixture(t, 12)
	r, err := newHumanRenderer(&bytes.Buffer{}, project, HumanOptions{ColorProfile: ColorTrueColor, Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()

	for i, record := range records {
		job := &fileRenderJob{
			group:  diagnosticGroup{start: i, diagnostics: []Diagnostic{record}},
			chunks: make(chan string, fileRenderChunkCapacity),
		}
		if !r.renderFileJob(job, func(err error) { t.Errorf("job %d failed: %v", i, err) }) {
			t.Fatalf("job %d did not complete", i)
		}
		for range job.chunks {
		}
		assertDisplayDataReleased(t, r)
	}
}

func TestSequentialRendererReleasesDisplayDataAfterWriterFailure(t *testing.T) {
	project, records := displayLifetimeFixture(t, 1)
	failure := errors.New("lifetime writer failed")
	out := &sectionWriter{failAt: 1, failure: failure}
	r, err := newHumanRenderer(out, project, HumanOptions{ColorProfile: ColorTrueColor, Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()

	if err := r.renderSequentialFindings(records); !errors.Is(err, failure) {
		t.Fatalf("renderSequentialFindings() error = %v, want %v", err, failure)
	}
	assertDisplayDataReleased(t, r)
}

func TestParallelRendererReleasesDisplayDataAfterCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		project, records := displayLifetimeFixture(t, 1)
		r, err := newHumanRenderer(&bytes.Buffer{}, project, HumanOptions{ColorProfile: ColorTrueColor, Context: ctx})
		if err != nil {
			t.Fatal(err)
		}
		defer r.close()
		job := &fileRenderJob{
			group:  diagnosticGroup{diagnostics: records},
			chunks: make(chan string),
		}
		done := make(chan bool, 1)
		go func() {
			done <- r.renderFileJob(job, func(error) {})
		}()
		synctest.Wait()
		if len(r.lines) != 2 || len(r.tokens) != 2 || r.prepared.document == nil {
			t.Fatalf("blocked active job payload = %d line maps, %d token maps, prepared %v", len(r.lines), len(r.tokens), r.prepared.document != nil)
		}
		cancel()
		synctest.Wait()
		if <-done {
			t.Fatal("canceled file job reported success")
		}
		for range job.chunks {
		}
		assertDisplayDataReleased(t, r)
	})
}

func displayLifetimeFixture(t *testing.T, count int) (*lint.Project, []Diagnostic) {
	t.Helper()
	project := &lint.Project{Sources: make(map[string]*lint.Source, count*2)}
	raw := make([]lint.Diagnostic, 0, count)
	for i := range count {
		primaryPath := fmt.Sprintf("roles/demo/tasks/lifetime-%02d.yml", i)
		primaryData := []byte(fmt.Sprintf("value: wrong-%02d\n", i))
		primary, parseDiagnostics := lint.Parse(primaryPath, primaryData)
		if len(parseDiagnostics) != 0 {
			t.Fatalf("parse %s: %+v", primaryPath, parseDiagnostics)
		}
		relatedPath := fmt.Sprintf("roles/demo/defaults/lifetime-%02d.yml", i)
		relatedData := []byte(fmt.Sprintf("value: default-%02d\n", i))
		related, relatedDiagnostics := lint.Parse(relatedPath, relatedData)
		if len(relatedDiagnostics) != 0 {
			t.Fatalf("parse %s: %+v", relatedPath, relatedDiagnostics)
		}
		project.Sources[primary.Path] = primary
		project.Sources[related.Path] = related
		primaryStart := bytes.Index(primaryData, []byte("wrong"))
		relatedStart := bytes.Index(relatedData, []byte("default"))
		raw = append(raw, lint.Diagnostic{
			Path:     primary.Path,
			RuleID:   fmt.Sprintf("lifetime-%02d", i),
			Severity: "warning",
			Message:  "release completed display data",
			Span:     lint.Span{Start: primaryStart, End: primaryStart + len("wrong")},
			Related: []lint.RelatedLocation{{
				Path:    related.Path,
				Message: "related source",
				Span:    lint.Span{Start: relatedStart, End: relatedStart + len("default")},
			}},
		})
	}
	return project, diagnostics(project, raw)
}

func assertDisplayDataReleased(t *testing.T, r *humanRenderer) {
	t.Helper()
	if len(r.lines) != 0 || len(r.tokens) != 0 || r.prepared.document != nil {
		t.Fatalf("released display data = %d line maps, %d token maps, prepared %v", len(r.lines), len(r.tokens), r.prepared.document != nil)
	}
}
