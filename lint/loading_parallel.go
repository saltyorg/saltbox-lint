package lint

import (
	"runtime"
	"sync"
)

type sourceReadResult struct {
	source *Source
	err    error
}

// Readers own disjoint result slots. The caller publishes only after every
// reader joins, so scheduling cannot reorder sources or operational errors.
func readSourceBatch(paths []string, read func(string) (*Source, error)) []sourceReadResult {
	results := make([]sourceReadResult, len(paths))
	workers := min(runtime.GOMAXPROCS(0), 8, len(paths))
	if workers <= 1 {
		for i, path := range paths {
			results[i].source, results[i].err = read(path)
		}
		return results
	}
	jobs := make(chan int)
	var group sync.WaitGroup
	for range workers {
		group.Go(func() {
			for i := range jobs {
				results[i].source, results[i].err = read(paths[i])
			}
		})
	}
	for i := range paths {
		jobs <- i
	}
	close(jobs)
	group.Wait()
	return results
}
