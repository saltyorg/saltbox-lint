// Command generate-catalog refreshes the embedded snapshot at build time.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"saltbox-lint-markdown-demo-v4/catalog"
)

func main() {
	output := flag.String("output", "catalog/data/catalog.json", "snapshot destination")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx, *output); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, path string) error {
	snapshot, err := catalog.Generate(ctx, catalog.GenerateOptions{})
	if err != nil {
		return err
	}
	data, err := snapshot.Marshal()
	if err != nil {
		return err
	}
	// Do not truncate the previous snapshot if generation or writing fails.
	temp, err := os.CreateTemp(filepath.Dir(path), ".catalog-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(temp.Name(), 0644); err != nil {
		return err
	}
	if err := os.Rename(temp.Name(), path); err != nil {
		return err
	}
	documented := 0
	for _, module := range snapshot.Modules {
		if module.DocumentationAvailable {
			documented++
		}
	}
	fmt.Fprintf(os.Stderr, "catalog: %d modules, %d documented, %d routes; %s (%d bytes)\n", len(snapshot.Modules), documented, len(snapshot.Routes), path, len(data))
	return nil
}
