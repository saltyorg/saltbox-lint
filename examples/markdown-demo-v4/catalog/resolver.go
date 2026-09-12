package catalog

import "strings"

// ResolveContext contains document metadata collections, followed by inline
// task/block/play declarations in the upstream collector's order.
type ResolveContext struct{ Collections []string }

// Resolve matches the language server's candidate and single-hop route order.
// It consults only the frozen catalog, never the host or Ansible at runtime.
func (c *Catalog) Resolve(name string, context ResolveContext) (Module, bool) {
	if c == nil {
		return Module{}, false
	}
	candidates := []string{name}
	if len(strings.Split(name, ".")) < 3 {
		candidates = []string{"ansible.builtin." + name}
		for _, collection := range context.Collections {
			candidates = append(candidates, collection+"."+name)
		}
	}
	for _, candidate := range candidates {
		if route, ok := c.Routes[candidate]; ok {
			if route.Redirect != "" {
				module, found := c.Modules[route.Redirect]
				return module, found
			}
			// Even an empty route stops the route search, then tries direct modules.
			break
		}
	}
	for _, candidate := range candidates {
		if module, ok := c.Modules[candidate]; ok {
			return module, true
		}
	}
	return Module{}, false
}
