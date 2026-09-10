package lint

import "strings"

// Task is an actual task/block/handler in an Ansible-owned sequence. Module
// names normalize only ansible.builtin; arbitrary payload mappings never enter
// this view. Arguments retain the YAML node and Vars belongs to this exact task.
type Task struct {
	Node, Arguments, Vars *Node
	Module                string
	ModuleSpan            Span
	FreeForm              string
}

// TasksIn follows only task-list roots and play task lists, then block/rescue/
// always. It does not infer tasks by recursively searching for module names.
func TasksIn(s *Source) []Task {
	if s == nil || len(s.parseDiagnostics) > 0 {
		return nil
	}
	var result []Task
	var list func(*Node)
	list = func(n *Node) {
		if n == nil || n.Kind != "sequence" {
			return
		}
		for _, item := range n.Items {
			if item.Kind != "mapping" {
				continue
			}
			result = append(result, normalizeTask(s, item))
			for _, key := range []string{"block", "rescue", "always"} {
				list(item.Get(key))
			}
		}
	}
	for _, doc := range s.Documents {
		switch s.Kind {
		case Tasks, Handlers:
			list(doc)
		case Playbook:
			if doc.Kind == "sequence" {
				for _, play := range doc.Items {
					for _, key := range []string{"pre_tasks", "tasks", "post_tasks", "handlers"} {
						list(play.Get(key))
					}
				}
			}
		}
	}
	return result
}
func normalizeTask(s *Source, n *Node) Task {
	task := Task{Node: n, Vars: n.Get("vars")}
	for _, entry := range n.Entries {
		key := entry.Key.Value
		if key == "action" || key == "local_action" {
			task.Arguments = entry.Value
			module := entry.Value
			if module.Kind == "mapping" {
				module = module.Get("module")
			}
			if module != nil && module.Kind == "string" {
				text := strings.TrimSpace(module.Value)
				name, tail, _ := strings.Cut(text, " ")
				// Folded action strings may contain any YAML-decoded whitespace.
				if fields := strings.Fields(text); len(fields) > 0 {
					name = fields[0]
					tail = strings.TrimSpace(text[len(name):])
				}
				task.Module = strings.TrimPrefix(name, "ansible.builtin.")
				task.FreeForm = tail
				task.ModuleSpan = scalarTextSpan(s, module, strings.Index(module.Value, name), len(name))
			}
			return task
		}
		if taskKeyword(key) {
			continue
		}
		task.Module = strings.TrimPrefix(key, "ansible.builtin.")
		task.ModuleSpan = entry.Key.Span
		task.Arguments = entry.Value
		if entry.Value.Kind == "string" {
			task.FreeForm = entry.Value.Value
		}
		return task
	}
	return task
}

// taskKeyword mirrors the Base/Task/Handler fields and ModuleArgsParser's
// metadata exclusions. Actions and local_action are normalized separately;
// legacy aliases/private loop metadata still must not masquerade as modules.
func taskKeyword(key string) bool {
	switch key {
	case "name", "vars", "connection", "port", "remote_user", "module_defaults",
		"environment", "no_log", "run_once", "ignore_errors", "ignore_unreachable",
		"check_mode", "diff", "any_errors_fatal", "throttle", "timeout", "debugger",
		"become", "become_method", "become_user", "become_flags", "become_exe":
		return true
	case "args", "async", "async_val", "changed_when", "delay", "failed_when",
		"loop", "loop_control", "loop_with", "poll", "register", "retries", "until",
		"when", "tags", "collections", "notify", "delegate_to", "delegate_facts",
		"listen", "static", "block", "rescue", "always":
		return true
	default:
		return strings.HasPrefix(key, "with_")
	}
}

func scalarTextSpan(s *Source, n *Node, start, length int) Span {
	if start < 0 || length == 0 {
		return n.Span
	}
	positions, ok := scalarPositions(s, n)
	if !ok {
		return n.Span
	}
	return mapSpan(positions, Span{start, start + length})
}
func (t Task) argument(key string) *Node {
	if v := t.Arguments.Get(key); v != nil {
		return v
	}
	return t.Node.Get("args").Get(key)
}
func (t Task) includeFile() string {
	if t.Module != "include_tasks" {
		return ""
	}
	if file := t.argument("file"); file != nil && file.Kind == "string" {
		return file.Value
	}
	value := strings.TrimSpace(t.FreeForm)
	value = strings.TrimPrefix(value, "file=")
	if len(value) >= 2 && ((value[0] == '\'' && value[len(value)-1] == '\'') || (value[0] == '"' && value[len(value)-1] == '"')) {
		value = value[1 : len(value)-1]
	}
	return value
}

// RuntimeExpressions adds recognized implicit Ansible conditions to ordinary
// tagged expressions, including conditions applied by include_tasks/include_role.
// It reuses the existing Jinja lexer and YAML scalar source mapping; no second
// quote parser or runtime evaluator is involved.
func RuntimeExpressions(s *Source) []Expression {
	result := Expressions(s)
	tagged := map[*Node]bool{}
	for _, e := range result {
		tagged[e.node] = true
	}
	var add func(*Node)
	add = func(n *Node) {
		if n == nil || n.Tag == "!unsafe" {
			return
		}
		if n.Kind == "sequence" {
			for _, item := range n.Items {
				add(item)
			}
			return
		}
		if n.Kind != "string" || tagged[n] || strings.Contains(n.Value, "{{") || strings.Contains(n.Value, "{%") || strings.Contains(n.Value, "{#") {
			return
		}
		positions, ok := scalarPositions(s, n)
		if !ok {
			return
		}
		expressions := scanExpressions("{{ " + n.Value + " }}")
		if len(expressions) != 1 || !expressions[0].Complete {
			return
		}
		e := expressions[0]
		e.Kind = "implicit"
		e.node = n
		e.Span = n.Span
		e.mapped = true
		e.text = n.Value
		for i := range e.Tokens {
			span := e.Tokens[i].Span
			span.Start -= 3
			span.End -= 3
			e.Tokens[i].Span = mapSpan(positions, span)
		}
		result = append(result, e)
	}
	conditions := func(n *Node) {
		for _, key := range []string{"when", "changed_when", "failed_when", "until"} {
			add(n.Get(key))
		}
	}
	for _, task := range TasksIn(s) {
		conditions(task.Node)
		if task.Module == "include_tasks" || task.Module == "include_role" {
			conditions(task.argument("apply"))
		}
		if task.Module == "assert" {
			add(task.argument("that"))
		}
	}
	if s != nil && s.Kind == Playbook {
		for _, doc := range s.Documents {
			for _, play := range doc.Items {
				conditions(play)
				if roles := play.Get("roles"); roles != nil {
					for _, role := range roles.Items {
						conditions(role)
					}
				}
			}
		}
	}
	return result
}
