#!/usr/bin/env python3
"""Считает устойчивость severity по корпусу style-review.

    python3 fixtures/style-review/severity-stability.py A.json D.json [...]

Для каждого кейса и каждой руки: сколько прогонов нашли ожидаемую находку,
какие у неё severity и сколько разных severity она получила. Разные
severity у одной и той же находки — это и есть #45: читатель получает
другой тред на следующем пуше.

Ожидаемая категория взята из cases/expected.md — оттуда же, где её видит
человек, а не модель.
"""
import json
import sys
from collections import Counter

EXPECTED = {
    'config-number': None,
    'missing-types': 'types',
    'unused-export': 'exports',
    'abbreviation': 'naming',
    'lying-comment': 'comments',
    'magic-literal': 'magic_numbers',
}


def load(path):
    with open(path) as f:
        return json.load(f)


def label(arm):
    ver = arm.get('spec_version', '?')
    if arm.get('category_thresholds'):
        return f"{ver} + `{arm['category_thresholds']}`"
    return ver


def main():
    paths = sys.argv[1:]
    if not paths:
        print('nothing to read')
        return 1
    arms = [load(p) for p in paths]
    print(f'прочитано файлов: {len(arms)}')

    labels = [label(a) for a in arms]
    print('\n| кейс | ожидание | ' + ' | '.join(labels) + ' |')
    print('|---|---|' + '---|' * len(arms))
    for cid in sorted({c['id'] for a in arms for c in a['cases']}):
        cells = []
        for arm in arms:
            case = next((c for c in arm['cases'] if c['id'] == cid), None)
            if case is None:
                cells.append('—')
                continue
            exp = EXPECTED.get(cid)
            runs = case['runs']
            if exp is None:
                sevs = [f.get('severity') for r in runs for f in r.get('findings', [])
                        if f.get('category') == 'magic_numbers']
                cells.append(
                    f"находок {sum(len(r.get('findings', [])) for r in runs)}"
                    + (f', magic_numbers {len(sevs)}' if sevs else '')
                )
                continue
            found = []
            for r in runs:
                for f in r.get('findings', []):
                    if f.get('category') == exp:
                        found.append(f.get('severity'))
                        break
            distinct = len(set(found))
            cells.append(
                f"{len(found)}/{len(runs)} прогонов, severity {sorted(set(found)) or '—'}"
                + (' — **плавает**' if distinct > 1 else '')
            )
        print(f'| `{cid}` | {EXPECTED.get(cid) or "—"} | ' + ' | '.join(cells) + ' |')

    print('\nсводка по всем находкам (проверка калибровки — не накрыло ли что-то):')
    for arm in arms:
        sev = Counter(f.get('severity') for c in arm['cases'] for r in c['runs']
                      for f in r.get('findings', []))
        runs_n = sum(len(c['runs']) for c in arm['cases'])
        findings = sum(sev.values())
        cost = sum(r.get('cost_usdc', 0) for c in arm['cases'] for r in c['runs'])
        print(f"  {label(arm):28} прогонов {runs_n:3}  находок {findings:3}  "
              f"severity {dict(sev)}  $ {cost:.5f}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
