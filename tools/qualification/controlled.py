"""Controlled Jinja render evidence; no consumer expressions are evaluated."""
import json
import pathlib
import sys

import jinja2
import yaml
from ansible.parsing.yaml.loader import AnsibleLoader
from semantics import digest, equivalent, format_source, tokens

binary, destination = sys.argv[1:]
fixture = pathlib.Path(__file__).parent / "fixtures/controlled.yml"
source = fixture.read_bytes()
report, after = format_source(binary, fixture.parent.resolve(), fixture.name, source)
assert report["status"] == "ready"
again, same = format_source(binary, fixture.parent.resolve(), fixture.name, after)
assert again["status"] == "unchanged" and same == after
before = yaml.load(source, Loader=AnsibleLoader)
formatted = yaml.load(after, Loader=AnsibleLoader)
changes = []
equivalent(before, formatted, changes)
environment = jinja2.Environment(undefined=jinja2.StrictUndefined)
rendered = []
for key in ("expr", "trim"):
    assert tokens(before[key]) == tokens(formatted[key])
    for value in ("hello", " spaced ", "😀"):
        expected = environment.from_string(before[key]).render(value=value)
        actual = environment.from_string(formatted[key]).render(value=value)
        assert actual == expected
        rendered.append({"key": key, "value": value, "rendered": actual})
assert before["unsafe"] == formatted["unsafe"] == "{{ untouched }}"
assert before["literal"] == formatted["literal"]
pathlib.Path(destination).write_text(json.dumps({"source_sha256": digest(source),
    "after_sha256": digest(after), "jinja_changes": changes, "renders": rendered,
    "status": "passed"}, indent=2) + "\n")
print("PASS controlled loader/tag/token/6-render comparisons and idempotence")
