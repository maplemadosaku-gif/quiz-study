#!/usr/bin/env python3
"""data/*.json を検証して data/index.json を作り直す。 使い方: python3 tools/build_index.py"""
import json, pathlib, sys

DATA = pathlib.Path(__file__).resolve().parent.parent / 'data'
ORDER = ['地理', '日本史', '中国史', '世界史', '文学賞', '映画賞', '音楽賞']

decks, errors = [], []
for f in sorted(DATA.glob('*.json')):
    if f.name == 'index.json':
        continue
    try:
        d = json.loads(f.read_text(encoding='utf-8'))
    except Exception as e:
        errors.append(f'{f.name}: JSON エラー {e}'); continue
    keys = {c['key'] for c in d.get('columns', [])}
    if d.get('id') != f.stem:
        errors.append(f'{f.name}: id が "{d.get("id")}"（ファイル名と不一致）')
    for q in d.get('quizzes', []):
        if q['q'] not in keys or q['a'] not in keys:
            errors.append(f'{f.name}: quizzes の列 {q} が columns にない')
    for i, r in enumerate(d.get('rows', [])):
        extra = set(r) - keys
        if extra:
            errors.append(f'{f.name}: rows[{i}] に未定義の列 {extra}')
        if any(not isinstance(v, str) for v in r.values()):
            errors.append(f'{f.name}: rows[{i}] に文字列でない値')
    cat = d.get('category', '')
    decks.append((ORDER.index(cat) if cat in ORDER else 99, cat, f.name, len(d.get('rows', []))))

decks.sort()
(DATA / 'index.json').write_text(json.dumps({'decks': [d[2] for d in decks]}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
for _, cat, name, n in decks:
    print(f'{cat:6} {name:36} {n:4}件')
print(f'合計 {len(decks)} デッキ / {sum(d[3] for d in decks)} 件')
if errors:
    print('\n'.join(['⚠ 問題:'] + errors)); sys.exit(1)
