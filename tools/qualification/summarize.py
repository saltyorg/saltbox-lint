"""Summarize every frozen sample without removing outliers or failures."""
import collections
import json
import math
import pathlib
import re
import statistics
import sys

root = pathlib.Path(sys.argv[1])
rows = [json.loads(line) for line in (root / "samples.jsonl").read_text().splitlines()]
result = {}
for name in dict.fromkeys(row["workload"] for row in rows):
    selected = [row for row in rows if row["workload"] == name]
    series = {}
    for label in dict.fromkeys(row["binary"] for row in selected):
        records = [row for row in selected if row["binary"] == label]
        entry = {"samples": len(records), "measurement_failures": sum(bool(row.get("measurement_error")) for row in records), "exits": dict(collections.Counter(row["exit"] for row in records))}
        for metric in ("wall_seconds", "first_output_seconds", "cpu_user_seconds", "cpu_system_seconds", "peak_rss_kib"):
            values = sorted(row[metric] for row in records if row.get(metric) is not None)
            if not values:
                entry[metric] = None
                continue
            entry[metric] = {"median": statistics.median(values), "p95": values[math.ceil(len(values) * .95) - 1],
                             "min": min(values), "max": max(values), "stdev": statistics.stdev(values) if len(values) > 1 else None}
        if "format_status" in records[0]:
            entry["status_counts"] = dict(collections.Counter(row.get("format_status", "error") for row in records))
        series[label] = entry
    if name.startswith("micro-"):
        micro = collections.defaultdict(lambda: collections.defaultdict(list))
        for row in selected:
            output = (root / f'{name}-p{row["pair"]}-{row["binary"]}.stdout').read_text()
            for match in re.finditer(r'^(Benchmark\S+)\s+\d+\s+([\d.]+) ns/op\s+([\d.]+) B/op\s+([\d.]+) allocs/op', output, re.M):
                micro[match[1]][row["binary"]].append([float(value) for value in match.groups()[1:]])
        series["benchmarks"] = {bench: {label: {"samples": len(values),
            "median_ns_op": statistics.median(v[0] for v in values),
            "median_bytes_op": statistics.median(v[1] for v in values),
            "median_allocs_op": statistics.median(v[2] for v in values)} for label, values in labels.items()}
            for bench, labels in micro.items()}
    elif not name.startswith("format-"):
        pairs = []
        for pair in range(10):
            a = next(row for row in selected if row["pair"] == pair and row["binary"] == "A")
            b = next(row for row in selected if row["pair"] == pair and row["binary"] == "B")
            pairs.append({"pair": pair, "parity": not (a.get("measurement_error") or b.get("measurement_error")) and a["exit"] == b["exit"] and a["outputs"] == b["outputs"],
                          "wall_ratio": b["wall_seconds"] / a["wall_seconds"] if a["wall_seconds"] and b["wall_seconds"] is not None else None})
        series["pairs"] = pairs
        series["all_bytes_equal"] = all(pair["parity"] for pair in pairs)
        ratios = [pair["wall_ratio"] for pair in pairs if pair["wall_ratio"] is not None]
        series["valid_paired_wall_samples"] = len(ratios)
        series["median_paired_wall_ratio"] = statistics.median(ratios) if ratios else None
    result[name] = series
(root / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
