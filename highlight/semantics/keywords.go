package semantics

// Generated from Red Hat Ansible 26.8.2
// packages/ansible-language-server/dist/utils/ansible.js on 2026-09-11.
// Source SHA256: 41868a5b1cb23754e76ac5413b9787b81dc57d5563d968f212af8f16b5be9792.
var playKeywords = keywordSet(
	"any_errors_fatal", "become", "become_exe", "become_flags", "become_method", "become_user",
	"check_mode", "collections", "connection", "debugger", "diff", "environment", "fact_path",
	"force_handlers", "gather_facts", "gather_subset", "gather_timeout", "handlers", "hosts",
	"ignore_errors", "ignore_unreachable", "max_fail_percentage", "module_defaults", "name", "no_log",
	"order", "port", "post_tasks", "pre_tasks", "remote_user", "roles", "run_once", "serial",
	"strategy", "tags", "tasks", "throttle", "timeout", "vars", "vars_files", "vars_prompt",
)

var blockKeywords = keywordSet(
	"always", "any_errors_fatal", "become", "become_exe", "become_flags", "become_method", "become_user",
	"block", "check_mode", "collections", "connection", "debugger", "delegate_facts", "delegate_to",
	"diff", "environment", "ignore_errors", "ignore_unreachable", "module_defaults", "name", "no_log",
	"notify", "port", "remote_user", "rescue", "run_once", "tags", "throttle", "timeout", "vars", "when",
)

var roleKeywords = keywordSet(
	"any_errors_fatal", "become", "become_exe", "become_flags", "become_method", "become_user",
	"check_mode", "collections", "connection", "debugger", "delegate_facts", "delegate_to", "diff",
	"environment", "ignore_errors", "ignore_unreachable", "module_defaults", "name", "no_log", "port",
	"remote_user", "run_once", "tags", "throttle", "timeout", "vars", "when",
)

var taskKeywords = keywordSet(
	"action", "any_errors_fatal", "args", "async", "become", "become_exe", "become_flags",
	"become_method", "become_user", "changed_when", "check_mode", "collections", "connection", "debugger",
	"delay", "delegate_facts", "delegate_to", "diff", "environment", "failed_when", "ignore_errors",
	"ignore_unreachable", "local_action", "loop", "loop_control", "module_defaults", "name", "no_log",
	"notify", "poll", "port", "register", "remote_user", "retries", "run_once", "tags", "throttle",
	"timeout", "until", "vars", "when", "listen",
)

var playExclusiveKeywords = keywordSet(
	"fact_path", "force_handlers", "gather_facts", "gather_subset", "gather_timeout", "handlers", "hosts",
	"max_fail_percentage", "order", "post_tasks", "pre_tasks", "roles", "serial", "strategy", "tasks",
	"vars_files", "vars_prompt",
)

func keywordSet(words ...string) map[string]struct{} {
	set := make(map[string]struct{}, len(words))
	for _, word := range words {
		set[word] = struct{}{}
	}
	return set
}

func containsKeyword(set map[string]struct{}, word string) bool {
	_, ok := set[word]
	return ok
}
