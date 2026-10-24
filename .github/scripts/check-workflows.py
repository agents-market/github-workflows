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

# A `gh` call needs a repository. In a job that never checks the repository
# out, `gh` has none to work in — and the call fails before it does anything.
# This was found by a real run: `gh label create` without `--repo` failed, the
# label was never created, and the pull request that followed could not carry
# it.
GH_NEEDS_REPO = re.compile(r"\bgh\s+(pr|issue|label|release)\b")
REPO_FLAG = re.compile(r"(--repo|-R)(\s|=)")


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

        # 5. a `gh` call needs a repository, and a job that never checks the
        #    repository out has none to work in.
        steps = job.get("steps") or []
        checked_out = any(
            str(step.get("uses", "")).startswith("actions/checkout") for step in steps
        )
        if not checked_out:
            for index, step in enumerate(steps, start=1):
                run = step.get("run")
                if not isinstance(run, str):
                    continue
                where = f"{job_id} / step {index} ({step.get('name') or 'unnamed'})"
                for line in logical_lines(run):
                    found = GH_NEEDS_REPO.search(line)
                    if found and not REPO_FLAG.search(line):
                        problems.append(
                            f"{where}: `gh {found.group(1)}` without --repo, in a job that "
                            f"never checks the repository out — gh has no repository to work in"
                        )

    return problems


def logical_lines(script: str) -> list[str]:
    """The script's commands, with the line continuations joined."""
    joined: list[str] = []
    current = ""
    for line in script.splitlines():
        current = f"{current} {line.strip()}".strip() if current else line.strip()
        if current.endswith("\\"):
            current = current[:-1].rstrip()
            continue
        joined.append(current)
        current = ""
    if current:
        joined.append(current)
    return joined


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
    args = list(sys.argv[1:])
    # A reference workflow has to stay short enough to read. The rule lives in
    # CONTRIBUTING.md, and a rule nobody checks is a rule that stops being
    # true: this file was 408 lines before anything measured it.
    max_lines = None
    if "--max-lines" in args:
        index = args.index("--max-lines")
        max_lines = int(args[index + 1])
        del args[index : index + 2]
    root = pathlib.Path(args[0] if args else ".github/workflows")
    files = sorted(root.glob("*.yml")) + sorted(root.glob("*.yaml"))
    if not files:
        print(f"no workflow files found in {root}", file=sys.stderr)
        return 1

    failures = 0
    for path in files:
        text = path.read_text()
        if max_lines is not None:
            count = len(text.splitlines())
            if count > max_lines:
                failures += 1
                print(f"FAIL {path}")
                print(f"  - {count} lines; a reference workflow must be {max_lines} or fewer")
                continue
        try:
            spec = yaml.safe_load(text)
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