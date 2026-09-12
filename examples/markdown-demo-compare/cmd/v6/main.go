package main

import (
	"os"
	compare "saltbox-lint-markdown-compare"
)

func main() { os.Exit(compare.Main(compare.Guided)) }
