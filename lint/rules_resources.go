package lint

import (
	"path"
	"regexp"
	"slices"
	"strings"
)

const githubAPIResource = "resources/tasks/git/github_api_request.yml"
const gitCloneResource = "resources/tasks/git/clone_git_repo.yml"
const networkHealthResource = "resources/tasks/docker/network_container_health_status.yml"

func canonicalResource(p *Project, s *Source, resource string) bool {
	return p != nil && p.Name == "saltbox" && s.Path == resource
}
func checkGitCloneResource(p *Project, s *Source) []Diagnostic {
	if canonicalResource(p, s, gitCloneResource) {
		return nil
	}
	var ds []Diagnostic
	for _, task := range TasksIn(s) {
		if task.Module == "git" {
			ds = append(ds, ansibleDiagnostic(s, "git-clone-resource", task.ModuleSpan, "direct Git actions bypass the shared clone resource", "Use "+gitCloneResource+" for Git checkouts and HTTP/1.1 fallback."))
		}
	}
	return ds
}
func checkSVMResource(p *Project, s *Source) []Diagnostic {
	if canonicalResource(p, s, githubAPIResource) {
		return nil
	}
	var ds []Diagnostic
	for _, e := range RuntimeExpressions(s) {
		for _, read := range VariableReads(e) {
			if read.Text == "svm" {
				ds = append(ds, ansibleDiagnostic(s, "svm-github-api-resource", read.Span, "direct SVM access bypasses the GitHub fallback resource", "Use "+githubAPIResource+" so direct GitHub fallback remains available."))
			}
		}
	}
	return ds
}

var lifecycleInclude = regexp.MustCompile(`/docker/(?:create|remove|restart|start|stop)_docker_container\.yml$`)

func checkDockerHelperArguments(_ *Project, s *Source) []Diagnostic {
	var ds []Diagnostic
	for _, task := range TasksIn(s) {
		if !lifecycleInclude.MatchString(task.includeFile()) {
			continue
		}
		if task.Vars == nil {
			continue
		}
		for _, entry := range task.Vars.Entries {
			if entry.Key.Value == "_var_prefix" {
				ds = append(ds, ansibleDiagnostic(s, "docker-helper-arguments", entry.Key.Span, "Docker lifecycle helpers do not accept private _var_prefix", "Pass var_prefix in this include task's vars; omit it to use the helper's role_name default."))
			}
		}
	}
	return ds
}
func checkNetworkHealthContract(_ *Project, s *Source) []Diagnostic {
	var ds []Diagnostic
	for _, task := range TasksIn(s) {
		if path.Base(task.includeFile()) != "network_container_health_status.yml" {
			continue
		}
		var missing []string
		for _, input := range []string{"network_container_source", "network_container_target"} {
			if task.Vars.Get(input) == nil {
				missing = append(missing, input)
			}
		}
		if len(missing) > 0 {
			ds = append(ds, ansibleDiagnostic(s, "network-health-contract", task.ModuleSpan, "network health include lacks explicit inputs", "Pass explicit "+strings.Join(missing, ", ")+" in this include task's vars."))
		}
	}
	if s.Path == networkHealthResource {
		for _, e := range RuntimeExpressions(s) {
			for _, read := range VariableReads(e) {
				if slices.Contains([]string{"_docker_vars", "_instance_name", "_var_prefix"}, read.Text) {
					ds = append(ds, ansibleDiagnostic(s, "network-health-contract", read.Span, "shared health resource reads caller-local "+read.Text, "Use explicit network_container_source and network_container_target inputs."))
				}
			}
		}
	}
	return ds
}

// variableAccess identifies only an immediate literal member on a real lexical
// variable read. It does not resolve dynamic subscripts or follow object aliases.
type variableAccess struct {
	Name   string
	Span   Span
	End    int
	Method bool
}

func memberAccesses(e Expression, variable string) []variableAccess {
	reads := map[Span]bool{}
	for _, read := range VariableReads(e) {
		if read.Text == variable {
			reads[read.Span] = true
		}
	}
	var result []variableAccess
	ts := e.Tokens
	for i, t := range ts {
		if !reads[t.Span] {
			continue
		}
		a := variableAccess{Span: t.Span}
		switch {
		case i+2 < len(ts) && ts[i+1].Text == "." && ts[i+2].Kind == "name":
			a.Name = ts[i+2].Text
			a.End = i + 3
			a.Span.End = ts[i+2].Span.End
			if a.Name == "get" && i+5 < len(ts) && ts[i+3].Text == "(" && ts[i+4].Kind == "string" && (ts[i+5].Text == "," || ts[i+5].Text == ")") {
				if name, ok := jinjaStringLiteral(ts[i+4 : i+5]); ok {
					a.Name = name
					a.Method = true
					a.End = balancedEnd(ts, i+3, len(ts)) + 1
					if a.End > 0 {
						a.Span.End = ts[a.End-1].Span.End
					}
				}
			}
		case i+3 < len(ts) && ts[i+1].Text == "[" && ts[i+2].Kind == "string" && ts[i+3].Text == "]":
			name, ok := jinjaStringLiteral(ts[i+2 : i+3])
			if !ok {
				continue
			}
			a.Name = name
			a.End = i + 4
			a.Span.End = ts[i+3].Span.End
		default:
			continue
		}
		result = append(result, a)
	}
	return result
}
func checkCloudflareAuth(_ *Project, s *Source) []Diagnostic {
	var ds []Diagnostic
	for _, e := range RuntimeExpressions(s) {
		for _, access := range memberAccesses(e, "cloudflare") {
			if slices.Contains([]string{"api", "email", "scoped_token"}, access.Name) {
				ds = append(ds, ansibleDiagnostic(s, "cloudflare-auth-contract", access.Span, "runtime source reads raw Cloudflare account fields", "Use normalized cloudflare_api_key, cloudflare_email or cloudflare_scoped_token authentication variables."))
			}
		}
	}
	return ds
}
