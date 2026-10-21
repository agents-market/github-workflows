#!/usr/bin/env python3
"""Check that the catalogue in the pipeline prompt and the catalogue the
workflow verifies against are the same catalogue.

Two files, one list. The prompt tells the model which ids it may use; the
snapshot is what `verify-cwe.py` checks the produced ids against. If they
drift, the workflow reports ids the pipeline itself was told to use as
"not in the official catalogue" — a false alarm on every run, and a reader who
has learned to ignore the warning.

Usage:
  python3 scripts/check-catalogue.py pipelines/<slug>/pipeline.yaml pipelines/<slug>/cwe-catalogue.csv
"""
import csv
import pathlib
import re
import sys

HEADER = re.compile(r"^CWE catalogue — .*snapshot (\d{4}-\d{2}-\d{2}), (\d+) entries\.")
ID = re.compile(r"^(CWE-\d+) — ")


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check-catalogue.py <pipeline.yaml> <cwe-catalogue.csv>", file=sys.stderr)
        return 2

    pipeline = pathlib.Path(sys.argv[1])
    catalogue = pathlib.Path(sys.argv[2])
    text = pipeline.read_text(encoding="utf-8")

    header = None
    prompt_ids: list[str] = []
    for line in text.split("\n"):
        h = HEADER.match(line.strip())
        if h and header is None:
            header = (h.group(1), int(h.group(2)))
            continue
        if header is None:
            continue
        m = ID.match(line.strip())
        if m:
            prompt_ids.append(m.group(1))
        elif prompt_ids:
            break  # the block ends where the catalogue ends

    if header is None:
        print(f"::error::{pipeline}: no CWE catalogue block in the prompt", file=sys.stderr)
        return 1

    with catalogue.open(encoding="utf-8") as f:
        csv_ids = [row["cwe_id"] for row in csv.DictReader(f)]

    problems = []
    if prompt_ids != csv_ids:
        only_prompt = sorted(set(prompt_ids) - set(csv_ids))
        only_csv = sorted(set(csv_ids) - set(prompt_ids))
        problems.append(
            f"the prompt lists {len(prompt_ids)} ids, the snapshot {len(csv_ids)}; "
            f"only in the prompt: {only_prompt or '—'}; only in the snapshot: {only_csv or '—'}"
        )
    if header[1] != len(prompt_ids):
        problems.append(f"the prompt header says {header[1]} entries, the block has {len(prompt_ids)}")

    if problems:
        for p in problems:
            print(f"::error::{pipeline}: {p}", file=sys.stderr)
        print(
            "::error::the catalogue in the prompt and the catalogue in the snapshot must be "
            "one list. Rebuild it: python3 scripts/build-cwe-catalogue.py && python3 scripts/apply-cwe-catalogue.py",
            file=sys.stderr,
        )
        return 1

    print(f"  {pipeline.name}: catalogue in sync — {len(prompt_ids)} ids, snapshot {header[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
