# The known answer for each case

Seven cases, each a diff that contains exactly one weakness, and a near-miss
next to it that must not be reported. The pipeline sees the diff and nothing
else — no file list, no repository, no expectation file — so this table is
the answer the runs are measured against.

`expected.json` is the same table in a form a program can read; this file is
the form a human reads.

## The three answers

| case | what the diff contains | the near-miss (must not be reported) | the expected finding |
|---|---|---|---|
| `race-ownership` | the ownership check of a wallet and the movement of the money are separated by an audit write | `CWE-89` in `src/wallet/balance.ts` — a parameterized template tag | one finding in `src/wallet/transfer.ts`, class `CWE-362` (a race on the owner of the wallet) |
| `oauth-state` | the Google callback stores the `state` it was given and never compares it with the session | `CWE-89` in `src/auth/session.ts` and `CWE-798` in `src/auth/oauth-client.ts` | one finding in `src/auth/google-callback.ts`, class `CWE-352` (the callback accepts a state it did not issue) |
| `workflow-shell` | one step interpolates the pull request title straight into a shell line | `CWE-78` on the step that passes the title through `env:` — the shell never expands its content a second time | one finding in `.github/workflows/notify.yml`, class `CWE-78` (a pull request title runs commands) |
| `sql-concat` | the report lookup pastes the `id` parameter into the SQL text | `CWE-89` on the handler next to it, and `CWE-89` in `src/reports/list.ts` | one finding in `src/reports/by-id.ts`, class `CWE-89` |
| `path-traversal` | two download handlers join a request parameter onto the files directory | `CWE-22` on the third handler, which resolves the path and checks that it stays inside | one finding in `src/files/download.ts`, class `CWE-22` |
| `token-log` | the caller writes the whole bearer token into the log | `CWE-532` on the function next to it, which does not log the token at all, and `CWE-798` in `src/http/keys.ts` | one finding in `src/http/client.ts`, class `CWE-532` |
| `missing-authorization` | the route that deactivates a user checks nobody's role | `CWE-862` on the two routes next to it, which call `requireRole`, and `CWE-89` in `src/admin/guard.ts` | one finding in `src/admin/users.ts`, class `CWE-862` |

## The rules the runs are checked against

- **The expected finding may be absent.** The pipeline may not find it — that
  is what the measurement is for.
- **A class name is not a verdict.** The pipeline does not use one class per
  weakness: it named the OAuth weakness `CWE-352` in one run and `CWE-287` in
  another, for the same two lines of code. So `expected.json` lists every
  class that names the same weakness, and a finding under any of them counts
  as found. A class outside that list is not the expected finding — it is
  counted separately, not called wrong.
- **A finding on a near-miss is a false positive.** The near-misses are safe
  code: a parameterized query, a secret from the environment, a title that
  reaches the shell through `env:`. The corpus says which place it is, so a
  false positive can be pointed at a line.
- **Everything else is not adjudicated.** The pipeline also reports things
  about the code around the weakness — how a session is bound, whether a
  destination wallet is checked. Some of those are opinions, some are real.
  The corpus counts them and does not rule on them: `expected.json` says what
  must be found and what must not, and everything else is a third bucket.
- **The severity of the expected finding is not part of the answer.** The
  corpus measures whether the weakness is found, not how the pipeline rates
  it; severity has its own open question (#45).
