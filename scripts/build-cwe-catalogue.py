#!/usr/bin/env python3
"""Build the CWE catalogue our pipelines are allowed to use.

Source: the official MITRE catalogue, https://cwe.mitre.org/data/csv/1000.csv
(it is a zip; the CSV inside has 944 records). The output is a dated snapshot:
`cwe_id,name,short_name,status`.

Selection, in this order:
  1. Status must be Stable, Draft or Incomplete. Deprecated and Obsolete are
     dropped. Incomplete stays: MITRE marks a weakness as Incomplete while it
     is being worked on, not because it is wrong — CWE-1427 (prompt
     injection) is one, and it is the code we want a reviewer to be able to
     cite.
  2. Keep the weaknesses the pipeline can actually find — the OWASP-mapped
     ones — plus the classic ones our prompt names (secrets, crypto, access
     control, traversal, deserialization, SSRF, XXE).

Why a subset and not all 944: the catalogue goes into the prompt, so every
consumer pays for it on every run. 200 entries with names cost ~2k tokens;
944 would cost ~10k and make the choices worse, not better.

Usage:
  python3 scripts/build-cwe-catalogue.py [--csv path] [--out path]
"""
import argparse
import csv
import pathlib
import re
import sys
import urllib.request
import zipfile
import io

MITRE_URL = "https://cwe.mitre.org/data/csv/1000.csv"
KEEP_STATUS = {"Stable", "Draft", "Incomplete"}

# Scope keywords: weaknesses the audit prompt asks about by name. Matched
# against the official name, case-insensitively.
SCOPE = re.compile(
    r"injection|sql|command|ldap|xpath|template|code injection|"
    r"xss|cross-site|cross site|"
    r"secret|credential|password|hard-coded|hardcoded|"
    r"cryptograph|random number|hash|"
    r"access control|authorization|authorisation|"
    r"path traversal|directory traversal|file inclusion|"
    r"deserializ|unmarshal|xml external|xxe|entity expansion|"
    r"ssrf|server-side request|cross-domain|cors|csrf|"
    r"session|cookie|csrf token|"
    r"memory buffer|buffer overflow|integer overflow|format string|"
    r"race condition|toctou|"
    r"improper.*check|improper.*validation|improper.*neutralization|"
    r"cleartext|plaintext|unencrypted|"
    r"log injection|log forging|"
    r"missing.*authorization|improper authentication|"
    r"prototype pollution|"
    r"zip bomb|decompression|"
    r"http response splitting|header injection|"
    r"open redirect|redirect",
    re.I,
)


# Things a source-code reviewer will never point at in a diff. OWASP mapping
# is coarse: it lists "Compiler Removal of Code to Clear Buffers" and
# "Improper Access Control in Fabric Bridge" next to "SQL Injection".
BLOCK = re.compile(
    r"compiler|hardware|fabric|j2ee|\bjava\b|middleware|operating system|"
    r"firmware|hypervisor|virtual machine|bytecode|assembly language|"
    r"webassembly|cloud|azure|\baws\b|character encoding|unicode|"
    r"deprecation|end of life|update|patch management|"
    r"cipher suite|protocol version|tls|ssl certificate|certificate|"
    r"dns|ip address|ipv6|proxy|load balanc|"
    r"boot code|volatile memory|register interface|control and data agents|"
    r"lock bit|address regions|write-once|register lock|attribute|"
    r"device|driver|router|switch|chip|bus interface",
    re.I,
)

# The weaknesses the audit prompt names outright, so they are always in the
# catalogue even when the filters would not have picked them.
MUST = {
    "CWE-20", "CWE-22", "CWE-77", "CWE-78", "CWE-79", "CWE-88", "CWE-89",
    "CWE-90", "CWE-91", "CWE-93", "CWE-94", "CWE-95", "CWE-116", "CWE-117",
    "CWE-134", "CWE-200", "CWE-209", "CWE-269", "CWE-276", "CWE-287", "CWE-295",
    "CWE-306", "CWE-311", "CWE-312", "CWE-319", "CWE-321", "CWE-326", "CWE-327",
    "CWE-328", "CWE-330", "CWE-338", "CWE-346", "CWE-347", "CWE-352", "CWE-362",
    "CWE-377", "CWE-400", "CWE-409", "CWE-415", "CWE-416", "CWE-426", "CWE-434",
    "CWE-470", "CWE-476", "CWE-502", "CWE-522", "CWE-532", "CWE-601", "CWE-611",
    "CWE-613", "CWE-614", "CWE-639", "CWE-643", "CWE-668", "CWE-670", "CWE-676",
    "CWE-693", "CWE-732", "CWE-749", "CWE-770", "CWE-772", "CWE-776", "CWE-778",
    "CWE-787", "CWE-798", "CWE-829", "CWE-838", "CWE-862", "CWE-915", "CWE-918",
    "CWE-1004", "CWE-1104", "CWE-1236", "CWE-1275", "CWE-1333", "CWE-1426",
    "CWE-1427", "CWE-1608",
}


def read_mitre(csv_path: str | None) -> list[dict]:
    if csv_path:
        text = pathlib.Path(csv_path).read_text(encoding="utf-8", errors="replace")
    else:
        with urllib.request.urlopen(MITRE_URL, timeout=60) as r:
            blob = r.read()
        if blob[:2] == b"PK":
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                name = [n for n in z.namelist() if n.endswith(".csv")][0]
                text = z.read(name).decode("utf-8", errors="replace")
        else:
            text = blob.decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def short_name(name: str) -> str:
    """MITRE's name is 'Formal Name (\\'Common Name\\')'. The common name is the
    one a reviewer recognises, and half the length."""
    m = re.search(r"\('(.+)'\)", name)
    return m.group(1) if m else name


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv")
    ap.add_argument("--out", default="pipelines/code-review-security-audit/cwe-catalogue.csv")
    ap.add_argument("--limit", type=int, default=200)
    args = ap.parse_args()

    rows = read_mitre(args.csv)
    picked = []
    for r in rows:
        status = (r.get("Status") or "").strip()
        if status not in KEEP_STATUS:
            continue
        name = (r.get("Name") or "").strip()
        taxonomy = (r.get("Taxonomy Mappings") or "") + (r.get("External Mappings") or "")
        oid = (r.get("CWE-ID") or "").strip()
        # The catalogue stores bare numbers ("89"), not "CWE-89".
        if not oid.isdigit():
            continue
        oid = f"CWE-{oid}"
        owasp = "OWASP" in taxonomy.upper()
        must = oid in MUST
        if not (owasp or SCOPE.search(name) or must):
            continue
        if not must and BLOCK.search(name):
            continue
        picked.append((oid, name, short_name(name), status,
                       "must" if must else ("owasp" if owasp else "scope")))

    # The named ones are never cut: a limit that drops CWE-89 because it
    # sorts late is worse than a catalogue that is 5 entries longer.
    named = [p for p in picked if p[4] == "must"]
    rest = [p for p in picked if p[4] != "must"]
    # OWASP-mapped first, then by id, so the cut is stable across runs.
    rest.sort(key=lambda t: (t[4] != "owasp", int(t[0].split("-")[1])))
    picked = sorted(named, key=lambda t: int(t[0].split("-")[1])) + rest[: args.limit]

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["cwe_id", "name", "short_name", "status", "selected_by"])
        for oid, name, sn, status, why in picked:
            w.writerow([oid, name, sn, status, why])

    ow = sum(1 for p in picked if p[4] == "owasp")
    print(f"  {len(picked)} записей ({ow} по OWASP), файл {out}")
    # The prompt block: id + short name, one per line.
    print()
    for oid, name, sn, status, why in picked:
        print(f"{oid} — {sn}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
