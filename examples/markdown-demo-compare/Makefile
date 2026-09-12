SHELL := /bin/bash
.DEFAULT_GOAL := build
export GOWORK := off

.PHONY: check build
check:
	@files="$$(gofmt -l .)"; if [[ -n "$$files" ]]; then printf 'Run gofmt on:\n%s\n' "$$files"; exit 1; fi
	go mod tidy -diff
	go vet ./...
	go test ./...

# v4 owns and embeds the frozen grammars, themes, catalog and Wasm engine.
# Importing its packages embeds those assets; no generation step is required.
build: check
	CGO_ENABLED=0 go build -trimpath -o ../../bin/markdown-demo-v5 ./cmd/v5
	CGO_ENABLED=0 go build -trimpath -o ../../bin/markdown-demo-v6 ./cmd/v6
