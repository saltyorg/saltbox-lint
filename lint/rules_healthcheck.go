package lint

import "strings"

const shellAllowance = "# saltbox-lint allow cmd-shell"
const healthcheckShapeHint = "Use a block list: NONE alone, CMD with a nonempty executable and optional argv, or CMD-SHELL with exactly one nonempty command. Null and collection elements are invalid."

type dockerHealthcheck struct {
	declaration defaultDeclaration
	tests       []Entry
}

func dockerHealthchecks(source *Source) []dockerHealthcheck {
	if source.Kind != Defaults {
		return nil
	}
	var checks []dockerHealthcheck
	for _, declaration := range topLevelDeclarations(source) {
		if !strings.HasSuffix(declaration.Name, "_docker_healthcheck") {
			continue
		}
		check := dockerHealthcheck{declaration: declaration}
		if declaration.Value != nil && declaration.Value.Kind == "mapping" {
			for _, entry := range declaration.Value.Entries {
				if entry.Key != nil && entry.Key.Kind == "string" && entry.Key.Value == "test" {
					check.tests = append(check.tests, entry)
				}
			}
		}
		checks = append(checks, check)
	}
	return checks
}

func healthcheckMarker(test *Node) string {
	if test == nil || test.Kind != "sequence" || len(test.Items) == 0 || test.Items[0] == nil {
		return ""
	}
	kind, value := EffectiveScalar(test.Items[0])
	if kind != "string" {
		return ""
	}
	return value
}

func healthcheckShape(test *Node) bool {
	if test == nil || test.Kind != "sequence" || test.Style != "block" {
		return false
	}
	switch healthcheckMarker(test) {
	case "NONE":
		return len(test.Items) == 1
	case "CMD":
		if len(test.Items) < 2 || !healthcheckCommandValue(test.Items[1], true) {
			return false
		}
		for _, argument := range test.Items[2:] {
			if !healthcheckCommandValue(argument, false) {
				return false
			}
		}
		return true
	case "CMD-SHELL":
		return len(test.Items) == 2 && healthcheckCommandValue(test.Items[1], true)
	default:
		return false
	}
}

func healthcheckCommandValue(node *Node, nonempty bool) bool {
	if node == nil {
		return false
	}
	kind, value := EffectiveScalar(node)
	switch kind {
	case "string":
		return !nonempty || strings.TrimSpace(value) != ""
	// The Ansible Docker consumer normalizes numeric/bool list elements with str().
	// Null and collections remain explicitly forbidden by Saltbox command policy.
	case "number", "bool":
		return true
	default:
		return false
	}
}

func checkDockerHealthcheckShape(_ *Project, source *Source) []Diagnostic {
	var diagnostics []Diagnostic
	for _, check := range dockerHealthchecks(source) {
		if len(check.tests) != 1 {
			diagnostics = append(diagnostics, dockerDiagnostic(source, "docker-healthcheck-shape", check.declaration.Key.Span, "Docker healthcheck must define exactly one test block list", "Define exactly one test key in the healthcheck mapping. "+healthcheckShapeHint))
			continue
		}
		test := check.tests[0]
		if !healthcheckShape(test.Value) {
			diagnostics = append(diagnostics, dockerDiagnostic(source, "docker-healthcheck-shape", test.Key.Span, "Docker healthcheck test has an invalid list shape", healthcheckShapeHint))
		}
	}
	return diagnostics
}

func checkDockerHealthcheckMode(_ *Project, source *Source) []Diagnostic {
	var diagnostics []Diagnostic
	for _, check := range dockerHealthchecks(source) {
		for _, test := range check.tests {
			if healthcheckMarker(test.Value) != "CMD-SHELL" || hasShellAllowance(source, test.Key) {
				continue
			}
			diagnostics = append(diagnostics, dockerDiagnostic(source, "docker-healthcheck-mode", test.Key.Span, "Docker healthcheck uses shell execution without an allowance", "Use CMD, or place "+shellAllowance+" on this test key when shell execution is required."))
		}
	}
	return diagnostics
}

func hasShellAllowance(source *Source, key *Node) bool {
	for _, span := range source.YAMLComments() {
		if source.Position(span.Start).Line == source.Position(key.Span.Start).Line && span.Start > key.Span.End && strings.TrimRight(string(source.Data[span.Start:span.End]), " \t\r") == shellAllowance {
			return true
		}
	}
	return false
}

func checkLintDirectives(_ *Project, source *Source) []Diagnostic {
	var diagnostics []Diagnostic
	testsByLine := make(map[int]Entry)
	for _, check := range dockerHealthchecks(source) {
		for _, test := range check.tests {
			testsByLine[source.Position(test.Key.Span.Start).Line] = test
		}
	}
	for _, span := range source.YAMLComments() {
		comment := strings.TrimRight(string(source.Data[span.Start:span.End]), " \t\r")
		if !strings.HasPrefix(strings.TrimSpace(strings.TrimPrefix(comment, "#")), "saltbox-lint") && !strings.Contains(comment, "# saltbox-lint") {
			continue
		}
		message := ""
		expected := "Use the exact directive " + shellAllowance + "."
		switch {
		case comment != shellAllowance:
			fields := strings.Fields(comment)
			if len(fields) == 4 && fields[0] == "#" && fields[1] == "saltbox-lint" && fields[2] == "allow" && fields[3] != "cmd-shell" {
				message = "Unknown Saltbox lint allowance " + fields[3]
			} else {
				message = "Malformed Saltbox lint directive"
			}
		default:
			test, found := testsByLine[source.Position(span.Start).Line]
			if !found || span.Start <= test.Key.Span.End {
				message = "The cmd-shell allowance is misplaced"
				expected = "Place " + shellAllowance + " on a Docker healthcheck test key."
			} else if healthcheckShape(test.Value) && healthcheckMarker(test.Value) != "CMD-SHELL" {
				message = "The cmd-shell allowance is unnecessary for a " + healthcheckMarker(test.Value) + " healthcheck"
				expected = "Remove the cmd-shell allowance from this " + healthcheckMarker(test.Value) + " test."
			}
			// A recognized test with an invalid shape owns its allowance: reporting it
			// as misplaced would obscure the shape error the user actually needs to fix.
		}
		if message != "" {
			diagnostics = append(diagnostics, dockerDiagnostic(source, "lint-directive", span, message, expected))
		}
	}
	return diagnostics
}
