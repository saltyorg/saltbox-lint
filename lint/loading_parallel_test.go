package lint

import (
	"errors"
	"fmt"
	"runtime"
	"testing"
	"testing/synctest"
)

func TestReadSourceBatchBoundsWorkAndKeepsInputOrder(t *testing.T) {
	previous := runtime.GOMAXPROCS(4)
	t.Cleanup(func() { runtime.GOMAXPROCS(previous) })
	synctest.Test(t, func(t *testing.T) {
		paths := make([]string, 12)
		for i := range paths {
			paths[i] = fmt.Sprintf("source-%d", i)
		}
		entered := make(chan string, len(paths))
		release := make(chan struct{})
		finished := make(chan []sourceReadResult, 1)
		go func() {
			finished <- readSourceBatch(paths, func(path string) (*Source, error) {
				entered <- path
				<-release
				return &Source{Path: path}, errors.New(path)
			})
		}()
		synctest.Wait()
		if count := len(entered); count != 4 {
			t.Errorf("active reads = %d, want 4", count)
		}
		close(release)
		synctest.Wait()
		results := <-finished
		if len(results) != len(paths) {
			t.Fatalf("read %d sources, want %d", len(results), len(paths))
		}
		for i, result := range results {
			if result.source.Path != paths[i] || result.err.Error() != paths[i] {
				t.Fatalf("result %d = %+v, want %s", i, result, paths[i])
			}
		}
	})
}

func TestReadSourceBatchReturnsOnlyAfterReadersFinish(t *testing.T) {
	for _, paths := range [][]string{nil, {"only"}} {
		calls := 0
		got := readSourceBatch(paths, func(path string) (*Source, error) {
			calls++
			return &Source{Path: path}, nil
		})
		if calls != len(paths) || len(got) != len(paths) {
			t.Fatalf("calls=%d results=%d, want %d", calls, len(got), len(paths))
		}
	}
}
