package lint

import "testing"

func TestEffectiveScalarPreservesExplicitTypes(t *testing.T) {
	for _, tc := range []struct{ yaml, kind, value string }{
		{"!!str null", "string", "null"}, {"!!str Null", "string", "Null"}, {"!!str NULL", "string", "NULL"}, {"!!str", "string", ""}, {"", "null", ""}, {"!!str ~", "string", "~"}, {"!!str 23", "string", "23"}, {"!!str true", "string", "true"},
		{"!<tag:yaml.org,2002:str> null", "string", "null"}, {"!<tag:yaml.org,2002:bool> 'true'", "bool", "true"},
		{"!!null 'null'", "null", "null"}, {"!<tag:yaml.org,2002:null> 'null'", "null", "null"}, {"!!int '23'", "number", "23"}, {"!<tag:yaml.org,2002:int> '23'", "number", "23"},
		{"!!bool 'True'", "bool", "true"}, {"!!bool yes", "bool", "true"}, {"!!bool 'false'", "bool", "false"},
		{"'null'", "string", "null"}, {"null", "null", "null"}, {"!!str ''", "string", ""},
	} {
		t.Run(tc.yaml, func(t *testing.T) {
			s, ds := Parse("vars.yml", []byte("value: "+tc.yaml+"\n"))
			if len(ds) > 0 {
				t.Fatal(ds)
			}
			n := s.Documents[0].Get("value")
			before := *n
			kind, value := EffectiveScalar(n)
			if kind != tc.kind || value != tc.value {
				t.Errorf("(%q,%q) want (%q,%q)", kind, value, tc.kind, tc.value)
			}
			if n.Kind != before.Kind || n.Tag != before.Tag || n.Span != before.Span || n.Style != before.Style {
				t.Fatal("source metadata changed")
			}
		})
	}
}
func TestEffectiveScalarTagConsumers(t *testing.T) {
	for _, value := range []string{"!!str null", "!<tag:yaml.org,2002:str> null", "!!str 23", "!<tag:yaml.org,2002:str> true"} {
		input := "- debug: {}\n  tags: " + value + "\n"
		if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-tag-name"); len(ds) > 0 {
			t.Errorf("%s: %+v", value, ds)
		}
	}
	for _, value := range []string{"!!null 'null'", "!<tag:yaml.org,2002:int> '23'"} {
		input := "- debug: {}\n  tags: " + value + "\n"
		if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-tag-name"); len(ds) != 1 {
			t.Errorf("%s: %+v", value, ds)
		}
	}
	for _, value := range []string{"!!str null", "!<tag:yaml.org,2002:str> null", "!!str true"} {
		input := "example_role_docker_healthcheck:\n  test:\n    - CMD\n    - " + value + "\n"
		if ds := dockerDiagnostics(t, input, "docker-healthcheck-shape"); len(ds) > 0 {
			t.Errorf("%s: %+v", value, ds)
		}
	}
	for _, value := range []string{"!!null 'null'", "!<tag:yaml.org,2002:null> 'null'"} {
		input := "example_role_docker_healthcheck:\n  test:\n    - CMD\n    - " + value + "\n"
		if ds := dockerDiagnostics(t, input, "docker-healthcheck-shape"); len(ds) != 1 {
			t.Errorf("%s: %+v", value, ds)
		}
	}
}
