#!/usr/bin/env python3
"""Сводит прогоны корпуса style-review в одну таблицу.

    python3 fixtures/style-review/summarize.py a.json b.json c.json

Каждый файл — результат `run-cases.mjs`. Таблица: по кейсу и по рукам, плюс
сводка — сколько находок исчезло, что переехало в другую категорию и что
осталось на месте.

Печатает число прочитанных файлов: молчаливый сканер хуже, чем сканер,
который ничего не нашёл.
"""
import json
import sys
from collections import Counter

# Что ожидается по кейсу: (категория, которую ждём) либо None, если находок
# ждать не надо. Совпадает с cases/expected.md.
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


def cats(run):
    return [f.get('category') for f in run.get('findings', [])]


def label(arm):
    bits = [arm.get('spec_version', '?')]
    if arm.get('category_thresholds'):
        bits.append(arm['category_thresholds'])
    return ' · '.join(bits)


def main():
    paths = sys.argv[1:]
    if not paths:
        print('nothing to read')
        return 1
    arms = [load(p) for p in paths]
    print(f'прочитано файлов: {len(arms)}')

    per_case = {}
    for arm in arms:
        for case in arm['cases']:
            per_case.setdefault(case['id'], {})[label(arm)] = case

    head = ' | '.join(label(a) for a in arms)
    print(f"\n{'кейс':16} {'ожидание':14} {head}")
    totals = Counter()
    for cid in sorted(per_case):
        row = []
        for a in arms:
            runs = per_case[cid][label(a)]['runs']
            row.append(' | '.join(','.join(cats(r)) or '—' for r in runs))
            all_cats = Counter(c for r in runs for c in cats(r))
            totals['findings'] += sum(all_cats.values())
            totals['magic'] += all_cats.get('magic_numbers', 0)
            if 'error' in [k for r in runs for k in r]:
                totals['errors'] += 1
        print(f'{cid:16} {str(EXPECTED.get(cid)):14} ' + ' | '.join(row))

    print()
    for a in arms:
        cost = sum(r.get('cost_usdc', 0) for c in a['cases'] for r in c['runs'])
        runs_n = sum(len(c['runs']) for c in a['cases'])
        errors = sum(1 for c in a['cases'] for r in c['runs'] if 'error' in r)
        print(f"{label(a):28} прогонов {runs_n:2}  ошибок {errors}  $ {cost:.5f}")
    print(f'\nнаходок всего: {totals["findings"]}, из них magic_numbers: {totals["magic"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
