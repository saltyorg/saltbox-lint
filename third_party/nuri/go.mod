module github.com/frostybee/nuri

go 1.25.0

// Fixture submodules contain non-buildable .go test files; keep them out of ./... package patterns.
ignore (
	./grammars-themes
	./vscode-textmate
)

require (
	github.com/tetratelabs/wazero v1.12.0
	golang.org/x/term v0.44.0
)

require golang.org/x/sys v0.46.0 // indirect
