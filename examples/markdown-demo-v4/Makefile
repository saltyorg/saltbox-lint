.PHONY: check catalog build

catalog:
	go run ./cmd/generate-catalog

check:
	@files="$$(find . -name '*.go' -print)"; test -z "$$(gofmt -l $$files)"
	go mod tidy -diff
	go vet ./...
	go test ./...
	go -C third_party/nuri test ./internal/grammar

build: catalog
	$(MAKE) check
	CGO_ENABLED=0 go build -o ../../bin/markdown-demo-v4 .
