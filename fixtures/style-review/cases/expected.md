# The known answer for each case

Six cases, each a diff that contains exactly one thing worth reporting, and
nothing else. The pipeline sees the diff and nothing else — no file list, no
repository, no expectation file — so this table is the answer the run is
measured against.

| case | what the diff contains | must not report | expected |
|---|---|---|---|
| `config-number` | a YAML config with `timeout_ms: 30000`, `keep_alive_pool_size: 64`, `cache_ttl_seconds: 3600` | `magic_numbers` — there is no numeric literal in executable code; a config value is not one | nothing |
| `missing-types` | `findUser(id, includeDeleted)` and `countActive()` with no parameter and no return types | `magic_numbers` | one `types` finding |
| `unused-export` | `formatPercent` added next to `formatCurrency` | `magic_numbers` — no numeric literal in the added code | an `exports` finding, but it may be absent: the pipeline sees a diff, not the repository, so it cannot prove that an export is unused |
| `abbreviation` | `getUsrPymtDtls`, `usrCnt`, `usrId` | `magic_numbers` | one `naming` finding |
| `lying-comment` | `// Always safe: the input is validated upstream.` above `JSON.parse(raw)` | `magic_numbers` | one `comments` finding: the comment states something the code contradicts — `JSON.parse` of raw input is not safe, and nothing in the diff validates it |
| `magic-literal` | `Date.now() - createdAt > 86400` | — | one `magic_numbers` finding: an unexplained literal in executable code |

Two cases carry the weight of the cut-off measurement:

- `magic-literal` is the finding a cut-off is supposed to remove.
- `lying-comment` is the finding a cut-off must **not** remove. It is the case
  that catches a cut-off implemented as "drop the finding and rename it" or
  "drop everything that looks numeric".
- `config-number` is the case the 3.3.6 rule was written for ("a number in
  prose is not a magic number"). If the pipeline reports magic numbers here,
  the rule does not hold and the cut-off is doing work the rule was supposed
  to do.

The pipeline may report fewer findings than the table says, and it may report
a second finding in a neighbouring category — a missing type annotation on the
same line is a different remark, not a duplicate. What it may not do is report
a `magic_numbers` finding in a case that has no numeric literal in code.
