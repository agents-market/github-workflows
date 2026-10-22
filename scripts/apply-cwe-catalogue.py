"""Wire the dated CWE catalogue into the flagship pipeline.

  pattern_scan  — stops emitting `cwe_id`. The scanner is a cheap pre-filter;
                  it should not decide a weakness class, and every id it
                  guessed was a code nobody had checked.
  deep_review   — decides the weakness class, from a closed list: the official
                  MITRE catalogue, snapshot 2026-10-21, 268 entries. If nothing
                  in the list describes the issue, `cwe_id` is null. Inventing
                  an id is no longer possible by construction.
  gap_review    — the same closed list. The second pass names classes too, and
                  a second copy of the list that drifts is a second copy of the
                  defect.

Every prompt that asks for a `cwe_id` gets the list. The script strips the
previous copy first, so running it twice changes nothing.

Run from the repo root:  python3 scripts/apply-cwe-catalogue.py
"""
import csv
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PIPE = ROOT / "pipelines/code-review-security-audit/pipeline.yaml"
CATALOGUE = ROOT / "pipelines/code-review-security-audit/cwe-catalogue.csv"

SNAPSHOT = "2026-10-21"

# The paragraph that says "every finding carries a cwe_id". The catalogue goes
# right after it, in every prompt that contains it.
ANCHOR = (
    "      Every finding also carries a `cwe_id` from the catalogue below. Choose the\n"
    "      entry whose name describes the weakness; `null` when the list has nothing\n"
    "      that fits.\n"
)


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


def strip_catalogue(text: str) -> str:
    """Remove every catalogue block, wherever it sits."""
    lines = text.split("\n")
    out: list[str] = []
    i, n = 0, len(lines)
    while i < n:
        if lines[i].strip().startswith("CWE catalogue — "):
            i += 1
            # the header is followed by the "Pick the id" paragraph and a blank
            while i < n and not lines[i].strip().startswith("CWE-"):
                i += 1
            # then the id lines, one per weakness class
            while i < n and lines[i].strip().startswith("CWE-"):
                i += 1
            # and one blank line that separated the block from what follows
            if i < n and not lines[i].strip():
                i += 1
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def main() -> None:
    t = strip_catalogue(PIPE.read_text())

    assert t.count(ANCHOR) >= 1, "в промптах нет строки про cwe_id"
    t = t.replace(ANCHOR, ANCHOR + "\n" + catalogue_block() + "\n")

    PIPE.write_text(t)
    count = len(list(csv.DictReader(CATALOGUE.open(encoding="utf-8"))))
    print(f"  каталог встроен: {count} записей × {t.count(ANCHOR)} промпт(ов)")


if __name__ == "__main__":
    main()
