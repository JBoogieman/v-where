#!/usr/bin/env python3
"""Build dist/v_where.html: the search page with schema.json baked in.

The result is one self-contained file. Double-click it from any folder, USB
stick, or synced drive: no web server, no network, no install.

Usage (from the repo root):
    python3 tools/build_offline.py
    python3 tools/build_offline.py --schema path/to/other-schema.json --out dist/other.html
"""
import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLACEHOLDER = '<script id="embedded-schema" type="application/json"></script>'


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--page', default=ROOT / 'web' / 'index.html', type=pathlib.Path)
    ap.add_argument('--schema', default=ROOT / 'data' / 'schema.json', type=pathlib.Path)
    ap.add_argument('--out', default=ROOT / 'dist' / 'v_where.html', type=pathlib.Path)
    args = ap.parse_args()

    page = args.page.read_text(encoding='utf-8')
    # Inline local scripts (<script src="joinplan.js"></script>) so the output stays one file.
    def inline(m):
        js = (args.page.parent / m.group(1)).read_text(encoding='utf-8')
        if '</script' in js.lower():
            raise SystemExit(f'error: {m.group(1)} contains "</script", which would end the inline tag early')
        return '<script>\n' + js + '</script>'
    page = re.sub(r'<script src="([\w.-]+\.js)"></script>', inline, page)
    if page.count(PLACEHOLDER) != 1:
        print(f'error: {args.page} must contain the empty embedded-schema tag exactly once', file=sys.stderr)
        return 1

    raw = args.schema.read_text(encoding='utf-8-sig')   # utf-8-sig: sqlcmd may write a byte order mark
    data = json.loads(raw)                      # fail fast on a broken export
    # Re-serialize compactly; escape "</" so nothing in the data can end the <script> tag early.
    payload = json.dumps(data, separators=(',', ':'), ensure_ascii=False).replace('</', '<\\/')

    filled = PLACEHOLDER.replace('></script>', '>' + payload + '</script>')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(page.replace(PLACEHOLDER, filled), encoding='utf-8')

    counts = data.get('counts', {})
    size_kb = args.out.stat().st_size // 1024
    print(f"Built {args.out.relative_to(ROOT) if args.out.is_relative_to(ROOT) else args.out}: "
          f"{counts.get('views', '?')} views, {counts.get('functions', '?')} functions, {size_kb} KB")
    return 0


if __name__ == '__main__':
    sys.exit(main())
