package lint

import (
	"path"
	"slices"
	"strings"
)

// Task overrides are outside this milestone's configuration grammar. Decline
// before scanning, even when a header supplies the same option: admitting the
// effective combination would require validating every owner configuration.
// An unknown task source can select any template in its owning role. No runtime
// variable, condition, module default or include is evaluated here.
func templateTaskConfigurationReasons(p *Project, s *Source) []string {
	if p == nil || s.RolePath == "" {
		return nil
	}
	var reasons []string
	for _, name := range sortedKeys(p.Sources) {
		owner := p.Sources[name]
		if owner.RolePath != s.RolePath || owner.Kind != Tasks && owner.Kind != Handlers {
			continue
		}
		if len(owner.parseDiagnostics) > 0 {
			reasons = append(reasons, "template configuration is unavailable: invalid owning task context")
			continue
		}
		for _, task := range TasksIn(owner) {
			if task.Module != "template" {
				continue
			}
			if reason := templateTaskSourceReason(task); reason != "" {
				reasons = append(reasons, reason)
				continue
			}
			src := task.argument("src")
			if path.Join(owner.RolePath, "templates", src.Value) != s.Path {
				continue
			}
			for _, key := range []string{"variable_start_string", "variable_end_string", "block_start_string", "block_end_string", "comment_start_string", "comment_end_string"} {
				if task.argument(key) != nil {
					reasons = append(reasons, "unsupported template configuration: owning task delimiter overrides are not statically validated")
					break
				}
			}
		}
	}
	slices.Sort(reasons)
	return slices.Compact(reasons)
}

func templateTaskSourceReason(task Task) string {
	args := task.Node.Get("args")
	if task.unknownArguments || args != nil && args.Kind != "mapping" {
		return "template configuration is unavailable: unknown template task arguments"
	}
	src := task.argument("src")
	if src == nil || src.Kind != "string" || src.Value == "" || src.Tag == "!unsafe" || strings.ContainsAny(src.Value, "{}\\") {
		return "template configuration is unavailable: dynamic template task source"
	}
	return ""
}
