#!/usr/bin/env python3
"""Static checks on this repository's workflow files.

ai-review.yml is the most consequential file here and the least exercised: it
triggers on workflow_call, pull_request and workflow_dispatch, and a push to main
produces a run with zero jobs. So a broken ai-review.yml sits on main until
somebody opens a pull request — which happened three times in two days, every
time to me.

Each of those three was statically decidable, and none needed a model, a key or
a network call:

  1. `env:` with nothing under it parses as env: null, which is not a mapping.
     Deleting a key from `env:` leaves the key behind.
  2. The `env` context is not available in a `uses:` step's `with:`. Reaching for
     it fails workflow validation with zero jobs.
  3. `uses: owner/repo@<ref>` with a comment welded onto the ref silently stops
     being a ref.

This reads YAML, so it reports the job and step rather than a line number —
which is also the unit that has to change.

Exits non-zero on the first failure with the file named.
"""
from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import tempfile

import yaml

# `env` is unavailable in `with:` for `uses:` steps. Matched on the context only,
# not the whole expression, so `format('{0}', inputs.env)` is not a false hit.
FORBIDDEN_IN_WITH = ("env.",)

KNOWN_LOCAL_PREFIXES = "./", ".github/"

# `${{ ... }}` is not bash: the runner replaces it before the shell sees it.
# A syntax check has to do the same, or every expression reads as a broken
# brace.
EXPRESSION = re.compile(r"\$\{\{[^}]*\}\}")


def check(path: pathlib.Path, spec: dict) -> list[str]:
    problems: list[str] = []

    # 1. a top-level `env:` must be a mapping, not null and not a scalar
    env = spec.get("env")
    if "env" in spec and not isinstance(env, dict):
        problems.append(
            f"top-level `env:` is {type(env).__name__}, not a mapping — deleting the "
            f"last key leaves the key behind and Actions rejects the whole file"
        )

    for job_id, job in (spec.get("jobs") or {}).items():
        for index, step in enumerate(job.get("steps") or [], start=1):
            where = f"{job_id} / step {index} ({step.get('name') or step.get('uses') or 'unnamed'})"

            # 3. the ref in `uses:` must be a ref
            uses = step.get("uses")
            if isinstance(uses, str) and "@" in uses and not uses.startswith(KNOWN_LOCAL_PREFIXES):
                ref = uses.split("@", 1)[1]
                if not ref:
                    problems.append(f"{where}: `uses:` has no ref — `{uses}`")
                elif any(c.isspace() for c in ref):
                    problems.append(
                        f"{where}: `uses:` ref is `{ref!r}` — something is welded onto "
                        f"the ref (a comment?). GitHub cannot resolve it and every "
                        f"job in the file fails."
                    )

            # 2. `env` context inside a `uses:` step's `with:`
            if uses and isinstance(step.get("with"), dict):
                for key, value in step["with"].items():
                    text = str(value)
                    if "${{" not in text:
                        continue
                    for context in FORBIDDEN_IN_WITH:
                        if context in text:
                            problems.append(
                                f"{where}: `with: {key}` uses the `{context}` context, "
                                f"which is not available in a `uses:` step — pass it as "
                                f"a step output instead"
                            )

            # an id is required before another step can reference its outputs
            if step.get("id") and not isinstance(step["id"], str):
                problems.append(f"{where}: `id:` must be a string")

            # 4. the `run:` block has to be a shell script the runner can
            #    start. A syntax error in it is not caught by anything else
            #    here, and it fails the job it is in — for a scheduled job,
            #    once a day, quietly.
            run = step.get("run")
            if isinstance(run, str):
                problem = shell_problem(EXPRESSION.sub("EXPR", run))
                if problem:
                    problems.append(f"{where}: the `run:` block is not valid bash — {problem}")

    return problems


def shell_problem(script: str) -> str:
    """The shell's own complaint about a script, or an empty string."""
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as handle:
        handle.write(script)
        path = handle.name
    try:
        # LC_ALL=C: the shell's complaints are part of the output, and a
        # message in the runner's language is a message nobody can search for.
        done = subprocess.run(
            ["bash", "-n", path], capture_output=True, text=True, env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"}
        )
        if done.returncode == 0:
            return ""
        message = done.stderr.strip().splitlines()[-1] if done.stderr.strip() else "syntax error"
        return message.replace(path, "the script").replace("line ", "line ")
    finally:
        pathlib.Path(path).unlink(missing_ok=True)


def main() -> int:
    failures = 0
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".github/workflows")
    files = sorted(root.glob("*.yml")) + sorted(root.glob("*.yaml"))
    if not files:
        print(f"no workflow files found in {root}", file=sys.stderr)
        return 1

    for path in files:
        try:
            spec = yaml.safe_load(path.read_text())
        except yaml.YAMLError as exc:
            print(f"FAIL {path}: not valid YAML — {exc}")
            failures += 1
            continue
        if not isinstance(spec, dict):
            print(f"FAIL {path}: top level is {type(spec).__name__}, not a mapping")
            failures += 1
            continue
        problems = check(path, spec)
        if problems:
            failures += 1
            print(f"FAIL {path}")
            for p in problems:
                print(f"  - {p}")
        else:
            print(f"ok   {path}")

    print(f"\n{len(files)} files, {failures} with problems")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())