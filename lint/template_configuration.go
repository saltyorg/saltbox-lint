package lint

import (
	"errors"
	"io/fs"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

// Task overrides are outside this milestone's configuration grammar. Decline
// before scanning, even when a header supplies the same option: admitting the
// effective combination would require validating every owner configuration.
// An unknown task source can select any template in its owning role. No runtime
// variable, condition, module default or include is evaluated here. Defaults
// ancestry is retained only to decline configuration that could change grammar.
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
			// Legacy action resolution may select a template plugin. Keep this
			// conservative admission local; other policies still require builtin
			// module identity and must not acquire legacy module contracts.
			if task.Module != "template" && task.Module != "ansible.legacy.template" {
				continue
			}
			if reason := templateTaskSourceReason(task); reason != "" {
				reasons = append(reasons, reason)
				continue
			}
			owns, reason := templateTaskOwnsSource(p, owner, s, task.argument("src").Value)
			if reason != "" {
				reasons = append(reasons, reason)
				continue
			}
			if !owns {
				continue
			}
			if templateModuleDefaultsUnknown(task) {
				reasons = append(reasons, "unsupported template configuration: applicable module defaults are not statically validated")
				continue
			}
			for _, key := range templateDelimiterArguments {
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

// Only conventional role-relative sources are resolved here. Absolute paths,
// home expansion and dot traversal involve Ansible search behavior outside this
// milestone. Existing aliases use the same root admission as source loading,
// without reading another file or inferring ownership from equal file contents.
func templateTaskOwnsSource(p *Project, owner, selected *Source, src string) (bool, string) {
	unknown := "template configuration is unavailable: unsupported template task source resolution"
	target := path.Join(owner.RolePath, "templates", src)
	if target == selected.Path {
		return true, ""
	}
	resolved, err := ownedSourcePath(p.Root, filepath.Join(p.Root, filepath.FromSlash(target)))
	if errors.Is(err, fs.ErrNotExist) {
		return false, ""
	}
	if err != nil || !strings.HasPrefix(resolved, owner.RolePath+"/templates/") {
		return false, unknown
	}
	selectedPath, err := ownedSourcePath(p.Root, filepath.Join(p.Root, filepath.FromSlash(selected.Path)))
	if err != nil {
		return false, unknown
	}
	return resolved == selectedPath, ""
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
	if strings.HasPrefix(src.Value, "/") || strings.HasPrefix(src.Value, "~") || strings.HasPrefix(src.Value, "templates/") || strings.Contains(src.Value, ":") || slices.ContainsFunc(strings.Split(src.Value, "/"), func(part string) bool { return part == "." || part == ".." || part == "" }) {
		return "template configuration is unavailable: unsupported template task source resolution"
	}
	return ""
}

var templateDelimiterArguments = []string{"variable_start_string", "variable_end_string", "block_start_string", "block_end_string", "comment_start_string", "comment_end_string"}

// Defaults may be inherited from a block and may name an action group whose
// membership requires a plugin loader. Do not resolve groups or template their
// values. Known unrelated actions and literal non-delimiter defaults stay clean.
func templateModuleDefaultsUnknown(task Task) bool {
	var unknown func(*Node) bool
	unknown = func(defaults *Node) bool {
		if defaults == nil || defaults.Kind == "null" {
			return false
		}
		if defaults.Kind == "sequence" {
			return slices.ContainsFunc(defaults.Items, unknown)
		}
		if defaults.Kind != "mapping" || defaults.Tag == "!unsafe" {
			return true
		}
		for _, entry := range defaults.Entries {
			key := entry.Key.Value
			if entry.Key.Kind != "string" || entry.Key.Tag == "!unsafe" || strings.ContainsAny(key, "{}") || strings.HasPrefix(key, "group/") {
				return true
			}
			if key != "template" && key != "ansible.builtin.template" && key != "ansible.legacy.template" {
				continue
			}
			if entry.Value.Kind != "mapping" || entry.Value.Tag == "!unsafe" {
				return true
			}
			for _, arg := range entry.Value.Entries {
				if arg.Key.Kind != "string" || arg.Key.Tag == "!unsafe" || strings.ContainsAny(arg.Key.Value, "{}") || slices.Contains(templateDelimiterArguments, arg.Key.Value) {
					return true
				}
			}
		}
		return false
	}
	return slices.ContainsFunc(task.moduleDefaults, unknown)
}
