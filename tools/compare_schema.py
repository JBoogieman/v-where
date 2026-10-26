#!/usr/bin/env python3
"""Compare two schema exports: what views, columns and inventory info differ.

Use it to check the T-SQL export against the PowerShell one from the same site
(they should match), or to see what changed between two ConfigMgr versions.

Usage (from the repo root):
    python3 tools/compare_schema.py data/schema.json path/to/other-schema.json

Exit code 0 when the two describe the same schema, 1 when they differ.
"""
import json
import pathlib
import sys


def load(path):
    text = pathlib.Path(path).read_text(encoding='utf-8-sig')
    data = json.loads(text.replace('\r', '').replace('\n', ''))   # sqlcmd breaks long output into lines
    return data, {o['name']: o for o in data['objects']}


def norm(o):
    """The parts of an object worth comparing, in an order-insensitive form where order doesn't matter."""
    h = o.get('hinv') or {}
    return {
        'kind': o['kind'],
        'columns': [tuple(c) for c in o['columns']],
        'params': [tuple(p) for p in o.get('params', [])],
        'aliases': sorted(o.get('aliases', [])),
        'baseView': o.get('baseView'),
        'hinv': {k: h.get(k) for k in ('display', 'class', 'namespace', 'collected')} if h else None,
        'offColumns': sorted(o.get('offColumns', [])),
    }


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[0] + '\n\nUsage: compare_schema.py A.json B.json')
        return 2
    (ha, a), (hb, b) = load(sys.argv[1]), load(sys.argv[2])
    diffs = 0

    print(f"A: {sys.argv[1]}  ({ha.get('generatedUtc')}, SQL {ha.get('sqlVersion')})")
    print(f"B: {sys.argv[2]}  ({hb.get('generatedUtc')}, SQL {hb.get('sqlVersion')})\n")
    for k in sorted(set(ha.get('counts', {})) | set(hb.get('counts', {}))):
        va, vb = ha['counts'].get(k), hb['counts'].get(k)
        print(f"  {k:15} {va!s:>7} {vb!s:>7}{'' if va == vb else '   <- differs'}")
        diffs += va != vb

    only_a, only_b = sorted(set(a) - set(b)), sorted(set(b) - set(a))
    for label, names in (('Only in A', only_a), ('Only in B', only_b)):
        if names:
            diffs += len(names)
            print(f"\n{label} ({len(names)}): " + ', '.join(names[:40]) + (' ...' if len(names) > 40 else ''))

    changed = []
    for name in sorted(set(a) & set(b)):
        na, nb = norm(a[name]), norm(b[name])
        parts = [k for k in na if na[k] != nb[k]]
        if parts:
            changed.append((name, parts, na, nb))
    if changed:
        diffs += len(changed)
        print(f"\nChanged ({len(changed)}):")
        for name, parts, na, nb in changed[:60]:
            print(f"  {name}: {', '.join(parts)}")
            if 'columns' in parts:
                ca, cb = {c[0]: c for c in na['columns']}, {c[0]: c for c in nb['columns']}
                gone, new = sorted(set(ca) - set(cb)), sorted(set(cb) - set(ca))
                typed = [c for c in sorted(set(ca) & set(cb)) if ca[c] != cb[c]]
                if gone: print(f"      columns only in A: {', '.join(gone)}")
                if new: print(f"      columns only in B: {', '.join(new)}")
                if typed: print(f"      type or nullability differs: {', '.join(typed)}")
                if not (gone or new or typed): print("      same columns, different order")
            for k in ('hinv', 'baseView', 'aliases', 'params', 'offColumns'):
                if k in parts:
                    print(f"      {k}: {na[k]}  vs  {nb[k]}")
        if len(changed) > 60:
            print(f"  ... and {len(changed) - 60} more")

    print('\nSame schema.' if not diffs else f'\n{diffs} difference(s).')
    return 0 if not diffs else 1


if __name__ == '__main__':
    sys.exit(main())
