#!/usr/bin/env python3
"""Check the CWE ids a review produced against the official MITRE catalogue.

The model is told to pick from a dated snapshot of the official list, but a
model can still drift from it. This is the other half of the check: every id
that reaches the reader is looked up in the catalogue, and the official name
and link are attached to it.

The live catalogue is preferred — the snapshot in the repo is dated, and MITRE
adds weaknesses. If the network is unavailable, the snapshot answers instead,
and the report says which one it used. Either way the answer is the official
catalogue, not anyone's recollection.

Usage:
  python3 scripts/verify-cwe.py findings.json [--catalogue path] [--offline]

Reads findings JSON (array of findings with a `cwe`/`cwe_id` field), writes a
JSON report to stdout:

  {
    "source": "live" | "snapshot",
    "snapshot_date": "2026-10-21",
    "used": ["CWE-89"],
    "verified": {"CWE-89": {"name": "...", "short": "...", "status": "Stable",
                            "url": "https://cwe.mitre.org/data/definitions/89.html"}},
    "unknown": ["CWE-1404"],
    "without_id": 2
  }
"""
import argparse
import csv
import io
import json
import pathlib
import re
import sys
import urllib.request
import zipfile

MITRE_URL = "https://cwe.mitre.org/data/csv/1000.csv"
SNAPSHOT_DATE = "2026-10-21"
DEFAULT_SNAPSHOT = (
    pathlib.Path(__file__).resolve().parent.parent
    / "pipelines/code-review-security-audit/cwe-catalogue.csv"
)
CWE_RE = re.compile(r"^CWE-(\d+)$", re.I)


def short_of(name: str) -> str:
    """MITRE writes \"Formal Name ('Common Name')\". The common name is the one
    a reader recognises and half the length; fall back to the formal one."""
    m = re.search(r"\('(.+)'\)", name)
    return m.group(1) if m else name


def official_names(csv_text: str) -> dict[str, tuple[str, str]]:
    """id -> (name, status) from the official catalogue CSV."""
    out: dict[str, tuple[str, str]] = {}
    for row in csv.DictReader(io.StringIO(csv_text)):
        oid = (row.get("CWE-ID") or "").strip()
        if not oid.isdigit():
            continue
        out[f"CWE-{oid}"] = (
            (row.get("Name") or "").strip(),
            (row.get("Status") or "").strip(),
        )
    return out


def snapshot_names(path: pathlib.Path) -> dict[str, tuple[str, str, str]]:
    """id -> (name, short_name, status) from our dated snapshot."""
    out: dict[str, tuple[str, str, str]] = {}
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            out[row["cwe_id"]] = (row["name"], row["short_name"], row["status"])
    return out


def fetch_live() -> dict[str, tuple[str, str]] | None:
    try:
        with urllib.request.urlopen(MITRE_URL, timeout=30) as r:
            blob = r.read()
    except Exception:
        return None
    try:
        if blob[:2] == b"PK":
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                name = next(n for n in z.namelist() if n.endswith(".csv"))
                blob = z.read(name)
        return official_names(blob.decode("utf-8", errors="replace"))
    except Exception:
        return None


def load_findings(raw: str) -> list[dict]:
    data = json.loads(raw or "[]")
    if isinstance(data, dict):
        data = data.get("findings") or []
    return [f for f in data if isinstance(f, dict)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("findings", help="findings JSON file, or - for stdin")
    ap.add_argument("--catalogue", default=str(DEFAULT_SNAPSHOT))
    ap.add_argument("--offline", action="store_true", help="never touch the network")
    args = ap.parse_args()

    raw = sys.stdin.read() if args.findings == "-" else pathlib.Path(args.findings).read_text()
    findings = load_findings(raw)

    live = None if args.offline else fetch_live()
    if live is not None:
        source = "live"
        names = live
    else:
        source = "snapshot"
        snap = snapshot_names(pathlib.Path(args.catalogue))
        names = {k: (v[0], v[2]) for k, v in snap.items()}

    used: list[str] = []
    without_id = 0
    for f in findings:
        cid = f.get("cwe") or f.get("cwe_id")
        if not cid:
            without_id += 1
            continue
        m = CWE_RE.match(str(cid).strip())
        cid = f"CWE-{m.group(1)}" if m else str(cid).strip()
        if cid not in used:
            used.append(cid)

    verified, unknown = {}, []
    for cid in used:
        if cid in names:
            name, status = names[cid]
            verified[cid] = {
                "name": name,
                "short": short_of(name),
                "status": status,
                "url": f"https://cwe.mitre.org/data/definitions/{cid.split('-')[1]}.html",
            }
        else:
            unknown.append(cid)

    # The snapshot keeps its own short name; MITRE's formal names are long and
    # the live catalogue has no separate short column.
    if source == "snapshot":
        snap = snapshot_names(pathlib.Path(args.catalogue))
        for cid, entry in verified.items():
            if cid in snap:
                entry["short"] = snap[cid][1]

    report = {
        "source": source,
        "snapshot_date": SNAPSHOT_DATE,
        "used": used,
        "verified": verified,
        "unknown": unknown,
        "without_id": without_id,
    }
    json.dump(report, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
