#!/usr/bin/env python3
"""Tests for the schema file tools: build_offline.py and compare_schema.py.

The main case is a schema file the way sqlcmd writes it (Export-VWhereSchema.sql):
a byte order mark, and a line break every 2,033 characters, even mid-word.

Run from the repo root:  python3 tools/test_schema_tools.py
"""
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCHEMA = ROOT / 'data' / 'schema.json'
passed = failed = 0


def run(*args):
    return subprocess.run([sys.executable, *map(str, args)], cwd=ROOT, capture_output=True, text=True)


def test(title, ok, detail=''):
    global passed, failed
    if ok:
        passed += 1
        print(f'ok   {title}')
    else:
        failed += 1
        print(f'FAIL {title}\n     {detail}')


with tempfile.TemporaryDirectory() as tmp:
    tmp = pathlib.Path(tmp)
    text = SCHEMA.read_text(encoding='utf-8').replace('\n', '')
    chunked = tmp / 'sqlcmd.json'
    chunked.write_text('\r\n'.join(text[i:i + 2033] for i in range(0, len(text), 2033)) + '\r\n', encoding='utf-8-sig')

    r = run('tools/compare_schema.py', SCHEMA, SCHEMA)
    test('compare: a schema matches itself', r.returncode == 0 and 'Same schema.' in r.stdout, r.stdout[-300:] + r.stderr)

    r = run('tools/compare_schema.py', SCHEMA, chunked)
    test('compare: sqlcmd-style file (BOM, mid-word line breaks) reads as the same schema',
         r.returncode == 0 and 'Same schema.' in r.stdout, r.stdout[-300:] + r.stderr)

    data = json.loads(text)
    view = next(o for o in data['objects'] if o['name'] == 'v_GS_PC_BIOS')
    view['columns'].pop()
    data['objects'] = [o for o in data['objects'] if o['name'] != 'v_R_User']
    changed = tmp / 'changed.json'
    changed.write_text(json.dumps(data), encoding='utf-8')
    r = run('tools/compare_schema.py', SCHEMA, changed)
    test('compare: reports a missing view and a missing column, exit code 1',
         r.returncode == 1 and 'Only in A (1): v_R_User' in r.stdout and 'v_GS_PC_BIOS: columns' in r.stdout,
         r.stdout[-400:] + r.stderr)

    out = tmp / 'offline.html'
    r = run('tools/build_offline.py', '--schema', chunked, '--out', out)
    html = out.read_text(encoding='utf-8') if out.exists() else ''
    test('offline build: accepts the sqlcmd-style file and embeds clean JSON',
         r.returncode == 0 and '"schemaVersion":2' in html and '<script src=' not in html, r.stdout + r.stderr)

print(f'\n{passed} passed{", some FAILED" if failed else ""}')
sys.exit(1 if failed else 0)
