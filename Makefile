SHELL := /bin/bash
.DEFAULT_GOAL := build

GOLANGCI_VERSION := v2.13.2
ACTIONLINT_VERSION := v1.7.12
GORELEASER_VERSION := v2.18.1
TOOLS := $(CURDIR)/bin/tools
GOLANGCI := $(TOOLS)/golangci-lint-$(GOLANGCI_VERSION)/golangci-lint
ACTIONLINT := $(TOOLS)/actionlint-$(ACTIONLINT_VERSION)/actionlint
GORELEASER := $(TOOLS)/goreleaser-$(GORELEASER_VERSION)/goreleaser
VERSION ?= dev

.PHONY: tools check format-check build snapshot

tools: $(GOLANGCI) $(ACTIONLINT) $(GORELEASER)

$(GOLANGCI):
	GOBIN='$(dir $(GOLANGCI))' go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_VERSION)

$(ACTIONLINT):
	GOBIN='$(dir $(ACTIONLINT))' go install github.com/rhysd/actionlint/cmd/actionlint@$(ACTIONLINT_VERSION)

$(GORELEASER):
	GOBIN='$(dir $(GORELEASER))' go install github.com/goreleaser/goreleaser/v2@$(GORELEASER_VERSION)

format-check:
	@set -o pipefail; files="$$(git ls-files --cached --others --exclude-standard -z -- '*.go' | xargs -0 -r gofmt -l)" || exit $$?; if [[ -n "$$files" ]]; then printf 'Run gofmt on:\n%s\n' "$$files"; exit 1; fi

# Gate commands never rewrite sources or module files. Bootstrap tools and Go
# caches may be populated; build/release artifacts live in ignored directories.
check: tools format-check
	go mod tidy -diff
	go vet ./...
	$(GOLANGCI) run
	go test -race ./...
	bash -n action/install.sh action/run.sh
	$(ACTIONLINT) -shellcheck= -pyflakes= .github/workflows/*.yml examples/github/*.yml
	$(GORELEASER) check

build: check
	CGO_ENABLED=0 go build -trimpath -ldflags '-s -w -X main.version=$(VERSION)' -o bin/saltbox-lint .

snapshot: check
	$(GORELEASER) release --snapshot --clean
