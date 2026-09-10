package lint

import (
	"bytes"
	"regexp"
	"strings"
)

func ansibleDiagnostic(s *Source, id string, span Span, message, expected string) Diagnostic {
	return Diagnostic{Path: s.Path, RuleID: id, Severity: "error", Span: span, Message: message, Expected: expected}
}

var ansibleTagName = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
var ansibleRoleName = regexp.MustCompile(`^[a-z0-9]+(?:_[a-z0-9]+)*$`)
var yamlDateTag = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

func checkAnsibleTags(_ *Project, s *Source) []Diagnostic {
	var tags []*Node
	add := func(n *Node) {
		if tag := n.Get("tags"); tag != nil {
			tags = append(tags, tag)
		}
	}
	for _, task := range TasksIn(s) {
		add(task.Node)
		if task.Module == "include_tasks" || task.Module == "include_role" {
			add(task.argument("apply"))
		}
	}
	if s.Kind == Playbook {
		for _, doc := range s.Documents {
			for _, play := range doc.Items {
				add(play)
				if roles := play.Get("roles"); roles != nil {
					for _, role := range roles.Items {
						add(role)
					}
				}
			}
		}
	}
	var ds []Diagnostic
	for _, tag := range tags {
		values := []*Node{tag}
		if tag.Kind == "sequence" {
			values = tag.Items
		}
		for _, value := range values {
			kind, text := EffectiveScalar(value)
			valid := kind == "string" && ansibleTagName.MatchString(text) && value.Anchor == "" && value.Tag != "!unsafe"
			if value.Style == "plain" && value.Tag == "" {
				switch strings.ToLower(value.Value) {
				case "true", "false", "yes", "no", "on", "off", "null", "~":
					valid = false
				}
				if yamlDateTag.MatchString(value.Value) {
					valid = false
				}
			}
			if !valid {
				ds = append(ds, ansibleDiagnostic(s, "ansible-tag-name", value.Span, "Ansible tags must be literal lowercase strings", "Use literal kebab-case tags matching [a-z0-9]+(?:-[a-z0-9]+)*; quote string spellings of YAML typed values."))
			}
		}
	}
	return ds
}
func checkAnsibleStaticImports(_ *Project, s *Source) []Diagnostic {
	var ds []Diagnostic
	for _, task := range TasksIn(s) {
		if task.Module != "import_tasks" && task.Module != "import_role" {
			continue
		}
		replacement := strings.Replace(task.Module, "import_", "include_", 1)
		ds = append(ds, ansibleDiagnostic(s, "ansible-static-import", task.ModuleSpan, "static Ansible imports are not allowed", "Use ansible.builtin."+replacement+" instead of "+task.Module+"."))
	}
	return ds
}
func checkRoleDirectoryName(_ *Project, s *Source) []Diagnostic {
	if s.Role == "" || ansibleRoleName.MatchString(s.Role) {
		return nil
	}
	return []Diagnostic{ansibleDiagnostic(s, "role-directory-name", sourceFirstSpan(s), "role directory "+s.Role+" has an invalid name", "Use snake_case role directory names matching [a-z0-9]+(?:_[a-z0-9]+)*.")}
}
func sourceFirstSpan(s *Source) Span {
	end := bytes.IndexByte(s.Data, '\n')
	if end < 0 {
		end = len(s.Data)
	}
	return Span{0, end}
}

var headerBorder = regexp.MustCompile(`^#{20,}$`)
var headerFields = []*regexp.Regexp{regexp.MustCompile(`^# Title:\s+\S`), regexp.MustCompile(`^# Author\(s\):\s+\S`), regexp.MustCompile(`^# URL:\s+https?://\S+`), regexp.MustCompile(`^#\s+GNU General Public License v3\.0`)}

func checkAnsibleSourceHeader(_ *Project, s *Source) []Diagnostic {
	if s.Role == "" {
		return nil
	}
	lines := strings.Split(string(s.Data), "\n")
	valid := len(lines) > 0 && headerBorder.MatchString(strings.TrimSuffix(lines[0], "\r"))
	comments := map[int]bool{}
	for _, span := range s.YAMLComments() {
		if s.Position(span.Start).Column == 1 {
			comments[s.Position(span.Start).Line-1] = true
		}
	}
	field, document := 0, false
	for i, line := range lines[:min(len(lines), 20)] {
		line = strings.TrimSuffix(line, "\r")
		if line == "---" {
			document = true
			break
		}
		if comments[i] && field < len(headerFields) && headerFields[field].MatchString(line) {
			field++
		}
	}
	if valid && document && field == len(headerFields) {
		return nil
	}
	return []Diagnostic{ansibleDiagnostic(s, "ansible-source-header", sourceFirstSpan(s), "role source YAML is missing its ordered standard header", "Start with at least 20 hashes, then nonempty Title, Author(s), HTTP URL and GNU General Public License v3.0 comment fields in order, followed by --- within the first 20 lines.")}
}
