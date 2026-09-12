"""Read-only corpus qualification; run with the pinned managed Ansible Python.

Arguments: CLI corpus-manifest.json output-directory. Never executes templates,
lookups, tasks, or playbooks. Changed YAML lives only in the evidence directory.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import time

import ansible.release
import jinja2
import yaml
from ansible.parsing.yaml.loader import AnsibleLoader
from ansible.module_utils._internal._datatag import AnsibleTagHelper
from ansible._internal._datatag._tags import Origin


def digest(data):
    return hashlib.sha256(data).hexdigest()


def tokens(value):
    return [(kind, text) for _, kind, text in jinja2.Environment().lex(value)
            if kind != "whitespace"]


def equivalent(a, b, changes):
    assert AnsibleTagHelper.base_type(a) == AnsibleTagHelper.base_type(b), "loader type changed"
    assert {tag for tag in AnsibleTagHelper.tags(a) if not isinstance(tag, Origin)} == {
        tag for tag in AnsibleTagHelper.tags(b) if not isinstance(tag, Origin)}, "loader tag changed"
    if isinstance(a, dict):
        assert len(a) == len(b), "mapping length changed"
        for (ka, va), (kb, vb) in zip(a.items(), b.items()):
            equivalent(ka, kb, changes)
            equivalent(va, vb, changes)
    elif isinstance(a, (list, tuple)):
        assert len(a) == len(b), "sequence length changed"
        for va, vb in zip(a, b):
            equivalent(va, vb, changes)
    elif isinstance(a, str) and a != b and "{{" in a:
        assert tokens(a) == tokens(b), "Jinja tokens or literal data changed"
        changes.append({"before": a, "after": b})
    elif isinstance(a, float) and a != a:
        assert b != b, "NaN changed"
    else:
        assert a == b, "loader scalar changed"


def format_source(binary, root, path, source):
    result = subprocess.run([binary, "format", "--root", str(root), "--stdin-filename",
                             str(root / path), "-"], input=source, capture_output=True, timeout=60)
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    report = json.loads(result.stdout)
    assert report["source_sha256"] == digest(source)
    output = source
    for edit in reversed(report["edits"]):
        output = output[:edit["span"]["start"]] + edit["text"].encode() + output[edit["span"]["end"]:]
    return report, output


def main():
    binary, manifest_path, destination = sys.argv[1:]
    destination = pathlib.Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    manifest = json.loads(pathlib.Path(manifest_path).read_text())
    metadata = {"python": sys.version, "ansible": ansible.release.__version__,
                "jinja": jinja2.__version__, "pyyaml": yaml.__version__,
                "binary_sha256": digest(pathlib.Path(binary).read_bytes()),
                "manifest_sha256": digest(pathlib.Path(manifest_path).read_bytes())}
    (destination / "environment.json").write_text(json.dumps(metadata, indent=2) + "\n")
    failures = []
    counts = {}
    with (destination / "files.jsonl").open("x") as records:
        for corpus in manifest:
            root = pathlib.Path(corpus["snapshot"])
            for entry in corpus["entries"]:
                path = entry["path"]
                if entry["symlink"] or pathlib.Path(path).suffix.lower() not in (".yml", ".yaml"):
                    continue
                source = (root / path).read_bytes()
                assert digest(source) == entry["sha256"], f"frozen input changed: {root / path}"
                row = {"corpus": root.name, "path": path, "bytes": len(source), "sha256": digest(source)}
                started = time.monotonic()
                try:
                    report, after = format_source(binary, root, path, source)
                    row.update(status=report["status"], reason=report.get("reason"), output_sha256=digest(after))
                    if report["status"] != "skipped":
                        again, same = format_source(binary, root, path, after)
                        assert again["status"] == "unchanged" and same == after, "not idempotent"
                        try:
                            before_values = list(yaml.load_all(source, Loader=AnsibleLoader))
                        except Exception as error:
                            row["loader"] = "unsupported"
                            row["loader_reason"] = str(error)
                        else:
                            after_values = list(yaml.load_all(after, Loader=AnsibleLoader))
                            changes = []
                            equivalent(before_values, after_values, changes)
                            row.update(loader="equal", jinja_changes=changes)
                        if after != source:
                            target = destination / "formatted" / root.name / path
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(after)
                    else:
                        assert not report["edits"] and after == source, "skipped plan edits source"
                    counts[row["status"]] = counts.get(row["status"], 0) + 1
                except Exception as error:
                    row.update(status="failed", error=str(error))
                    failures.append(row)
                row["wall_seconds"] = time.monotonic() - started
                records.write(json.dumps(row) + "\n")
                records.flush()
    summary = {"counts": counts, "failures": failures}
    (destination / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary), flush=True)
    assert not failures, "corpus qualification failed"


if __name__ == "__main__":
    main()
