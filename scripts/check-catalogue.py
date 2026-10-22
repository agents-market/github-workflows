#!/usr/bin/env python3
"""Check that the catalogue in the pipeline prompts and the catalogue the
workflow verifies against are the same catalogue.

Two files, one list. The prompt tells the model which ids it may use; the
snapshot is what the review workflow checks the produced ids against. If they
drift, the workflow reports ids the pipeline itself was told to use as
"not in the official catalogue" — a false alarm on every run, and a reader who
has learned to ignore the warning.

Every copy of the list is checked. The audit carries two prompts that ask for
a `cwe_id`, and a second copy that drifts is a second copy of the defect: the
model would be told one list and checked against another.

Usage:
  python3 scripts/check-catalogue.py pipelines/<slug>/pipeline.yaml pipelines/<slug>/cwe-catalogue.csv
"""
import csv
import pathlib
import re
import sys

HEADER = re.compile(r"^CWE catalogue — .*snapshot (\d{4}-\d{2}-\d{2}), (\d+) entries\.")
ID = re.compile(r"^(CWE-\d+) — ")


def catalogue_blocks(text: str) -> list[tuple[str, int, list[str]]]:
    """Every catalogue block in the file: (snapshot, declared count, ids)."""
    blocks: list[tuple[str, int, list[str]]] = []
    lines = text.split("\n")
    i, n = 0, len(lines)
    while i < n:
        h = HEADER.match(lines[i].strip())
        if not h:
            i += 1
            continue
        ids: list[str] = []
        j = i + 1
        while j < n:
            m = ID.match(lines[j].strip())
            if m:
                ids.append(m.group(1))
            elif ids:
                break  # the block ends where the catalogue ends
            j += 1
        blocks.append((h.group(1), int(h.group(2)), ids))
        i = j
    return blocks


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check-catalogue.py <pipeline.yaml> <cwe-catalogue.csv>", file=sys.stderr)
        return 2

    pipeline = pathlib.Path(sys.argv[1])
    catalogue = pathlib.Path(sys.argv[2])
    text = pipeline.read_text(encoding="utf-8")

    blocks = catalogue_blocks(text)
    if not blocks:
        print(f"::error::{pipeline}: no CWE catalogue block in the prompt", file=sys.stderr)
        return 1

    with catalogue.open(encoding="utf-8") as f:
        csv_ids = [row["cwe_id"] for row in csv.DictReader(f)]

    problems = []
    for index, (snapshot, declared, prompt_ids) in enumerate(blocks, start=1):
        where = "the prompt" if len(blocks) == 1 else f"prompt #{index}"
        if prompt_ids != csv_ids:
            only_prompt = sorted(set(prompt_ids) - set(csv_ids))
            only_csv = sorted(set(csv_ids) - set(prompt_ids))
            problems.append(
                f"{where} lists {len(prompt_ids)} ids, the snapshot {len(csv_ids)}; "
                f"only in the prompt: {only_prompt or '—'}; only in the snapshot: {only_csv or '—'}"
            )
        if declared != len(prompt_ids):
            problems.append(f"{where} header says {declared} entries, the block has {len(prompt_ids)}")
        if snapshot != blocks[0][0]:
            problems.append(f"{where} is snapshot {snapshot}, the first block is {blocks[0][0]}")

    if problems:
        for p in problems:
            print(f"::error::{pipeline}: {p}", file=sys.stderr)
        print(
            "::error::the catalogue in the prompt and the catalogue in the snapshot must be "
            "one list. Rebuild it: python3 scripts/build-cwe-catalogue.py && python3 scripts/apply-cwe-catalogue.py",
            file=sys.stderr,
        )
        return 1

    print(
        f"  {pipeline.name}: catalogue in sync — {len(csv_ids)} ids, snapshot {blocks[0][0]}, "
        f"{len(blocks)} block(s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
