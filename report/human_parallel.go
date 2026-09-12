package report

import (
	"context"
	"crypto/sha256"
	"io"
	"runtime"
	"sync"

	"github.com/saltyorg/saltbox-lint/highlight"
	"github.com/saltyorg/saltbox-lint/lint"
)

const (
	maximumHumanWorkers     = 8
	fileLookaheadPerWorker  = 4
	fileRenderChunkCapacity = 4
)

type diagnosticGroup struct {
	start       int
	diagnostics []Diagnostic
}

type fileRenderJob struct {
	group  diagnosticGroup
	chunks chan string
}

func defaultHumanWorkerLimit() int {
	return min(runtime.GOMAXPROCS(0), maximumHumanWorkers)
}

func humanFileLookahead(workers, files int) int {
	return min(files, workers*fileLookaheadPerWorker)
}

func contiguousDiagnosticGroups(ds []Diagnostic) ([]diagnosticGroup, bool) {
	if len(ds) == 0 {
		return nil, true
	}
	seen := make(map[string]struct{})
	groups := make([]diagnosticGroup, 0, len(ds))
	for start := 0; start < len(ds); {
		path := ds[start].Path
		if _, exists := seen[path]; exists {
			return nil, false
		}
		seen[path] = struct{}{}
		end := start + 1
		for end < len(ds) && ds[end].Path == path {
			end++
		}
		groups = append(groups, diagnosticGroup{start: start, diagnostics: ds[start:end]})
		start = end
	}
	return groups, true
}

func originalPrefixLine(project *lint.Project, group diagnosticGroup) int {
	if project == nil || len(group.diagnostics) == 0 {
		return 0
	}
	source := project.Sources[group.diagnostics[0].Path]
	if source == nil {
		return 0
	}
	lines := splitSourceLines(source.Data)
	throughLine := 0
	include := func(start, end int) {
		offset := start
		if end > start {
			offset = end - 1
		}
		throughLine = max(throughLine, min(len(lines), lineForOffset(lines, offset)+3))
	}
	for _, d := range group.diagnostics {
		include(d.Span.Start, d.Span.End)
		if d.preview != nil {
			for _, edit := range d.preview.Edits {
				include(edit.Span.Start, edit.Span.End)
			}
		}
		if d.Fix != nil {
			for _, edit := range d.Fix.Edits {
				include(edit.Span.Start, edit.Span.End)
			}
		}
	}
	return throughLine
}

func (r *humanRenderer) renderParallelFiles(groups []diagnosticGroup, opts HumanOptions, workers int, cancel context.CancelFunc) error {
	renderers := make([]*humanRenderer, workers)
	for i := range renderers {
		worker, err := newHumanRendererWithSession(io.Discard, r.project, opts, r.highlights)
		if err != nil {
			return err
		}
		renderers[i] = worker
	}

	jobs := make([]*fileRenderJob, len(groups))
	for i, group := range groups {
		job := &fileRenderJob{group: group, chunks: make(chan string, fileRenderChunkCapacity)}
		jobs[i] = job
	}
	queue := make(chan *fileRenderJob, humanFileLookahead(workers, len(jobs)))

	failures := make(chan error, 1)
	fail := func(err error) {
		select {
		case failures <- err:
		default:
		}
		cancel()
	}

	var wg sync.WaitGroup
	for i := range renderers {
		worker := renderers[i]
		wg.Go(func() {
			for {
				select {
				case <-r.ctx.Done():
					return
				case job, ok := <-queue:
					if !ok {
						return
					}
					if !worker.renderFileJob(job, fail) {
						return
					}
				}
			}
		})
	}
	next := 0
	queueClosed := false
	schedule := func() bool {
		if next == len(jobs) {
			if !queueClosed {
				close(queue)
				queueClosed = true
			}
			return true
		}
		select {
		case <-r.ctx.Done():
			return false
		case queue <- jobs[next]:
			next++
			if next == len(jobs) {
				close(queue)
				queueClosed = true
			}
			return true
		}
	}
	for range humanFileLookahead(workers, len(jobs)) {
		if !schedule() {
			cancel()
			wg.Wait()
			return parallelFailure(failures, r.ctx.Err())
		}
	}

	wait := func() {
		cancel()
		wg.Wait()
	}
	for _, job := range jobs {
		for {
			select {
			case <-r.ctx.Done():
				wait()
				return parallelFailure(failures, r.ctx.Err())
			case chunk, ok := <-job.chunks:
				if !ok {
					goto nextJob
				}
				if err := r.write(chunk); err != nil {
					wasCanceled := r.ctx.Err() != nil
					cancel()
					wg.Wait()
					if wasCanceled {
						return parallelFailure(failures, err)
					}
					return err
				}
			}
		}

	nextJob:
		if !schedule() {
			wait()
			return parallelFailure(failures, r.ctx.Err())
		}
	}
	wg.Wait()
	return parallelFailure(failures, nil)
}

func (r *humanRenderer) renderFileJob(job *fileRenderJob, fail func(error)) bool {
	defer close(job.chunks)
	defer r.releaseDisplayData()
	r.prewarmOriginal(job.group)
	emit := func(fragment string) error {
		select {
		case <-r.ctx.Done():
			return r.ctx.Err()
		case job.chunks <- fragment:
			return nil
		}
	}
	for i, d := range job.group.diagnostics {
		if err := r.renderFindingSection(d, job.group.start+i, i == 0, emit); err != nil {
			if r.ctx.Err() == nil {
				fail(err)
			}
			return false
		}
	}

	return true
}

func (r *humanRenderer) prewarmOriginal(group diagnosticGroup) {
	if !r.color || r.ctx.Err() != nil || r.project == nil || len(group.diagnostics) == 0 {
		return
	}
	path := group.diagnostics[0].Path
	source := r.project.Sources[path]
	throughLine := originalPrefixLine(r.project, group)
	if source == nil || throughLine == 0 {
		return
	}
	if h := r.highlights.get(); h != nil {
		text := string(source.Data)
		key := documentKey{path, sha256.Sum256(source.Data)}
		document := r.prepareOriginalDocument(h, key, text, highlight.DocumentOptions{SourcePath: path, Collections: r.roleCollections(path)})
		_ = h.WarmPreparedDisplayThroughLine(r.ctx, document, r.themeName, throughLine)
	}
}

func parallelFailure(failures <-chan error, fallback error) error {
	select {
	case err := <-failures:
		return err
	default:
		return fallback
	}
}
