package catalog

import "strings"

func (c *Catalog) recordWarning(stderr string) {
	if warning := strings.TrimSpace(stderr); warning != "" {
		c.Problems = append(c.Problems, Problem{Kind: "command_warning", Message: warning})
	}
}
