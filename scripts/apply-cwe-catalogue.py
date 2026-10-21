"""Wire the dated CWE catalogue into the flagship pipeline.

  pattern_scan  — stops emitting `cwe_id`. The scanner is a cheap pre-filter;
                  it should not decide a weakness class, and every id it
                  guessed was a code nobody had checked.
  deep_review   — decides the weakness class, from a closed list: the official
                  MITRE catalogue, snapshot 2026-10-21, 268 entries. If nothing
                  in the list describes the issue, `cwe_id` is null. Inventing
                  an id is no longer possible by construction.

Run from the repo root:  python3 scripts/apply-cwe-catalogue.py
"""
import csv
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
PIPE = ROOT / "pipelines/code-review-security-audit/pipeline.yaml"
CATALOGUE = ROOT / "pipelines/code-review-security-audit/cwe-catalogue.csv"

SNAPSHOT = "2026-10-21"


def catalogue_block() -> str:
    rows = list(csv.DictReader(CATALOGUE.open(encoding="utf-8")))
    lines = [f"{r['cwe_id']} — {r['short_name']}" for r in rows]
    head = [
        "CWE catalogue — the official MITRE list, snapshot "
        f"{SNAPSHOT}, {len(lines)} entries. It is the complete set you may use.",
        "",
        "Pick the id that names the weakness, not the vulnerability. If the list",
        "has nothing that fits, set cwe_id to null. Do not invent an id, do not",
        "guess the number, do not reuse an id from the scan stage — an id that is",
        "not in this list is a defect in the report, not a detail.",
        "",
    ]
    # The prompt lives in a YAML block scalar indented by six spaces; every
    # line we add has to carry that indent or the file stops parsing.
    return "\n".join("      " + l if l else "" for l in head + lines)


def sub(text: str, old: str, new: str, count: int = 1) -> str:
    assert text.count(old) == count, f"ожидалось {count}, найдено {text.count(old)}: {old[:70]!r}"
    return text.replace(old, new)


def sub_first(text: str, old: str, new: str) -> str:
    """Replace the first occurrence only. The two stages carry the same example
    JSON, and only the scanner's copy loses the id."""
    assert old in text, f"не найдено: {old[:70]!r}"
    return text.replace(old, new, 1)


def main() -> None:
    t = PIPE.read_text()

    # --- pattern_scan: cwe_id goes away ---
    t = sub(
        t,
        "        - `cwe_id` (string CWE id e.g. \"CWE-89\", or null)\n",
        "",
    )
    t = sub_first(
        t,
        '            "fix_suggestion": "Replace exec() with execFile() and pass arguments as an array",\n'
        '            "cwe_id": "CWE-78",\n'
        '            "confidence": 0.9\n',
        '            "fix_suggestion": "Replace exec() with execFile() and pass arguments as an array",\n'
        '            "confidence": 0.9\n',
    )

    # --- deep_review: the closed list ---
    t = sub(
        t,
        "      Every finding carries the `file` it is in. A finding without a file never\n"
        "      reaches the reader.\n",
        "      Every finding carries the `file` it is in. A finding without a file never\n"
        "      reaches the reader.\n\n"
        "      Every finding also carries a `cwe_id` from the catalogue below. Choose the\n"
        "      entry whose name describes the weakness; `null` when the list has nothing\n"
        "      that fits. The scanner's candidates carry no id — you assign it, and only\n"
        "      you know what the issue actually is.\n\n"
        + catalogue_block()
        + "\n",
    )

    PIPE.write_text(t)
    print(f"  каталог встроен: {len(list(csv.DictReader(CATALOGUE.open())))} записей")


if __name__ == "__main__":
    main()
