"""Frozen Linux paired CLI/PTY measurement. Prepare once, then run once.

prepare BASELINE CANDIDATE CORPUS_MANIFEST OUTDIR; run OUTDIR.
Every pair, output destination and input identity exists before the first sample.
"""
import hashlib
import json
import os
import pathlib
import platform
import subprocess
import sys
import time

from process_measurement import measure


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare(baseline, candidate, manifest, output, existing_only=False):
    out = pathlib.Path(output).resolve()
    out.mkdir(parents=True, exist_ok=False)
    corpora = json.loads(pathlib.Path(manifest).read_text())
    workloads = []
    for corpus in corpora:
        root = pathlib.Path(corpus["snapshot"])
        for entry in corpus["entries"]:
            source = root / entry["path"]
            data = os.readlink(source).encode() if entry["symlink"] else source.read_bytes()
            assert digest(data) == entry["sha256"]
        for theme in ("dark", "light"):
            workloads.append({"name": root.name + "-" + theme, "pty": True,
                              "args": ["--color", "always", "--theme", theme,
                                       "check", "--format", "human", str(root)]})
        workloads.append({"name": root.name + "-json", "pty": False,
                          "args": ["check", "--format", "json", str(root)]})
        selected = "roles/plex/defaults/main.yml" if root.name == "saltbox" else "roles/sonarr/defaults/main.yml"
        if not (root / selected).exists():
            selected = next(e["path"] for e in corpus["entries"] if e["path"].endswith("/defaults/main.yml"))
        workloads.append({"name": root.name + "-stdin", "pty": False,
                          "stdin": str(root / selected), "stdin_sha256": digest((root / selected).read_bytes()),
                          "args": ["check", "--root", str(root), "--format", "json",
                                   "--stdin-filename", str(root / selected), "-"]})
    fixtures = out / "fixtures"
    fixtures.mkdir()
    values = {"diagnostic-heavy.yml": "".join(f'item_{i}: "{{{{ value\n }}}}"\n' for i in range(3000)),
              "flow-heavy.yml": "".join(f"item_{i}: [1,2,3]\n" for i in range(3000)),
              "unicode.yml": 'value: ["😀", "𝄞", \'hello\']\n',
              "canonical.yml": "value:\n  - one\n  - two\n",
              "skipped.yml": "value: [1,\n\n]"}
    formatting = []
    for name, content in values.items():
        file = fixtures / name
        file.write_text(content)
        assert file.stat().st_size <= 100 * 1024
        formatting.append({"name": name, "pty": False, "stdin": str(file),
                           "stdin_sha256": digest(file.read_bytes()),
                           "args": ["format", "--root", str(fixtures), "--stdin-filename", str(file), "-"]})
    identities = {label: {"path": str(pathlib.Path(file).resolve()), "sha256": digest(pathlib.Path(file).read_bytes())}
                  for label, file in (("A", baseline), ("B", candidate))}
    schedule = [{"pair": pair, "order": "AB" if pair % 2 == 0 else "BA",
                 "workload": work["name"]} for work in workloads for pair in range(10)]
    env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor", "COLUMNS": "160", "LINES": "48", "LC_ALL": "C.UTF-8"}
    declaration = {"created": time.time(), "code_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
                   "code_status": subprocess.check_output(["git", "status", "--porcelain"], text=True), "binaries": identities, "manifest": str(pathlib.Path(manifest).resolve()),
                   "manifest_sha256": digest(pathlib.Path(manifest).read_bytes()), "workloads": workloads,
                   "baseline_source_sha256": digest((pathlib.Path(manifest).parent / "baseline-source.tar").read_bytes()),
                   "formatting": formatting, "schedule": schedule, "formatting_samples": 20,
                   "cwd": str(pathlib.Path.cwd()), "host": platform.uname()._asdict(), "cpus": os.cpu_count(),
                   "affinity": sorted(os.sched_getaffinity(0)), "pty_geometry": [48, 160],
                   "cache_policy": "No cache flush or discarded warmups. First sample identified; subsequent warm context. No outcome-filtered reruns.",
                   "environment": {key: env.get(key) for key in ("PATH", "TERM", "COLORTERM", "COLUMNS", "LINES", "LC_ALL", "LANG", "GOMAXPROCS", "GOMEMLIMIT", "NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE")},
                   "output_pattern": "NAME-pPAIR-A|B.stdout|stderr; format-NAME-SAMPLE.stdout|stderr",
                   "harness_sha256": digest(pathlib.Path(__file__).read_bytes()),
                   "measurement_modules": {name: digest(pathlib.Path(__file__).with_name(name).read_bytes())
                                           for name in ("process_measurement.py", "process_supervisor.py")},
                   "measurement_boundary": "Fresh supervisor ready before child timestamp; actual child wait4 RSS/CPU; output observed by controller; supervisor startup and overhead recorded separately",
                   "existing_only": existing_only}
    micro = pathlib.Path(manifest).resolve().parent / "task-6-micro"
    declaration["microbenchmarks"] = [
        {"name": package, "pattern": pattern,
         "binaries": {label: {"path": str(micro / f"{label}-{package}.test"),
                               "sha256": digest((micro / f"{label}-{package}.test").read_bytes())}
                      for label in "AB"}}
        for package, pattern in (("lint", "BenchmarkAnalyzeSharedFacts/role/sources=32$"),
                                 ("report", "BenchmarkSharedFixProcessing/(plan|records)/40$"))
    ] if micro.exists() and (micro / "B-report.test").exists() else []
    declaration["microbench_schedule"] = ["AB" if i % 2 == 0 else "BA" for i in range(10)]
    declaration["microbench_args"] = ["-test.run=^$", "-test.benchmem", "-test.benchtime=100ms", "-test.count=1"]
    if existing_only:
        declaration["formatting"] = []
        declaration["formatting_samples"] = 0
        declaration["microbenchmarks"] = []
    (out / "declaration.json").write_text(json.dumps(declaration, indent=2) + "\n")
    print(out / "declaration.json")


def run(output):
    out = pathlib.Path(output).resolve()
    declaration = json.loads((out / "declaration.json").read_text())
    assert digest(pathlib.Path(__file__).read_bytes()) == declaration["harness_sha256"]
    assert digest(pathlib.Path(declaration["manifest"]).read_bytes()) == declaration["manifest_sha256"]
    for name, expected in declaration["measurement_modules"].items():
        assert digest(pathlib.Path(__file__).with_name(name).read_bytes()) == expected
    for identity in declaration["binaries"].values():
        assert digest(pathlib.Path(identity["path"]).read_bytes()) == identity["sha256"]
    for work in declaration["workloads"] + declaration["formatting"]:
        if "stdin" in work:
            assert digest(pathlib.Path(work["stdin"]).read_bytes()) == work["stdin_sha256"]
    env = dict(os.environ)
    for key, value in declaration["environment"].items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    failures = []
    with (out / "samples.jsonl").open("x") as records:
        for item in declaration["schedule"]:
            work = next(w for w in declaration["workloads"] if w["name"] == item["workload"])
            pair = {}
            for label in item["order"]:
                prefix = out / f'{work["name"]}-p{item["pair"]}-{label}'
                result = measure(declaration["binaries"][label]["path"], work, env, declaration["cwd"], prefix)
                if result["exit"] not in (0, 1) or not result["rss_exceeds_supervisor_hwm"]:
                    failures.append({"workload": work["name"], "pair": item["pair"], "binary": label,
                                     "reason": "invalid check exit or child RSS does not exceed supervisor floor"})
                row = {**item, "binary": label, **result}
                records.write(json.dumps(row) + "\n")
                records.flush()
                pair[label] = result
            parity = not any(pair[label].get("measurement_error") for label in "AB") and all(
                pair["A"][key] == pair["B"][key] for key in ("exit", "outputs"))
            if not parity:
                failures.append({"workload": work["name"], "pair": item["pair"], "reason": "output parity"})
            print(work["name"], item["pair"], "parity", parity, flush=True)
        for micro in declaration["microbenchmarks"]:
            for pair, order in enumerate(declaration["microbench_schedule"]):
                for label in order:
                    identity = micro["binaries"][label]
                    assert digest(pathlib.Path(identity["path"]).read_bytes()) == identity["sha256"]
                    work = {"pty": False, "args": [*declaration["microbench_args"], "-test.bench=" + micro["pattern"]]}
                    prefix = out / f'micro-{micro["name"]}-p{pair}-{label}'
                    result = measure(identity["path"], work, env, declaration["cwd"], prefix)
                    if result.get("measurement_error") or result["exit"] != 0:
                        failures.append({"workload": micro["name"], "pair": pair, "binary": label, "reason": "benchmark exit"})
                    records.write(json.dumps({"workload": "micro-" + micro["name"], "pair": pair,
                                              "binary": label, **result}) + "\n")
                    records.flush()
            print("micro", micro["name"], "finished", flush=True)
        for work in declaration["formatting"]:
            for sample in range(declaration["formatting_samples"]):
                prefix = out / f'format-{work["name"]}-{sample}'
                result = measure(declaration["binaries"]["B"]["path"], work, env, declaration["cwd"], prefix)
                if result.get("measurement_error") or result["exit"] != 0:
                    failures.append({"workload": work["name"], "sample": sample, "reason": "formatter exit"})
                records.write(json.dumps({"workload": "format-" + work["name"], "sample": sample,
                                          "binary": "B", **result}) + "\n")
                records.flush()
            print("format", work["name"], "finished", flush=True)

    (out / "failures.json").write_text(json.dumps(failures, indent=2) + "\n")
    assert not failures, "formal measurement failures; all samples retained"


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        args = sys.argv[2:]
        existing_only = args[-1] == "--existing-only"
        prepare(*(args[:-1] if existing_only else args), existing_only=existing_only)
    elif sys.argv[1] == "run":
        run(*sys.argv[2:])
    else:
        raise SystemExit("expected prepare or run")
