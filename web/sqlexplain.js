/* v_Where query explainer
 *
 * Paste a query (an inherited report's, or one written in SSMS) and get:
 *   analyze(sql, db)  -> { objects[], columns[], checks[], star } : the views and functions it uses, the columns it
 *                        reads (alias.column), and what could go wrong (history views, rows that multiply, columns
 *                        that don't exist, plain views in an SSRS report, obsolete records...)
 *   toRbac(sql, db)   -> { sql, converted[], noRbac[] } : v_X -> fn_rbac_X(@UserSIDs), for SSRS
 *   toPlain(sql, db)  -> { sql, converted[] }          : fn_rbac_X(...) -> v_X, for running in SSMS
 *
 * Not a SQL parser: it finds names it knows from the schema, skipping comments and string literals, and
 * reads aliases from "FROM v_X os" / "JOIN v_X AS os". Rewrites only touch view names, so the rest of the
 * query (formatting, comments, everything else) stays exactly as pasted. Runs in the browser; nothing is sent.
 *
 * db is what VWhereSearch.prepare() returns. Uses VWhereJoin (rows per device) and VWhereColumns (descriptions)
 * when they're loaded. Plain script, no dependencies; window.VWhereSQL in the page, require() in Node.
 */
(function (root) {
  'use strict';

  const J = (typeof module !== 'undefined' && module.exports) ? require('./joinplan.js') : root.VWhereJoin;
  const Col = (typeof module !== 'undefined' && module.exports) ? require('./columns.js') : root.VWhereColumns;

  // Comments and string literals become spaces (same length, newlines kept), so positions still line up
  // with the original and names inside them are never matched.
  function mask(sql) {
    let out = '', i = 0;
    while (i < sql.length) {
      const c = sql[i], n = sql[i + 1];
      if (c === '-' && n === '-') {
        const j = sql.indexOf('\n', i), end = j < 0 ? sql.length : j;
        out += ' '.repeat(end - i); i = end;
      } else if (c === '/' && n === '*') {
        const j = sql.indexOf('*/', i + 2), end = j < 0 ? sql.length : j + 2;
        out += sql.slice(i, end).replace(/[^\n]/g, ' '); i = end;
      } else if (c === "'") {
        let j = i + 1;
        while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
        const end = Math.min(sql.length, j + 1);
        out += "'" + sql.slice(i + 1, end - 1).replace(/[^\n]/g, ' ') + (end - i > 1 ? "'" : ''); i = end;
      } else { out += c; i++; }
    }
    return out;
  }

  // Words that can follow a table name but aren't an alias
  const KEYWORDS = new Set(['where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'group', 'order', 'union',
    'with', 'having', 'select', 'set', 'go', 'and', 'or', 'apply', 'pivot', 'unpivot', 'option', 'except', 'intersect', 'for',
    'when', 'then', 'else', 'end', 'as', 'into', 'from', 'tablesample', 'nolock']);
  const ident = /\[([^\]]+)\]|([A-Za-z_@#][\w@#$]*)/g;

  const lowerIndex = new WeakMap();
  function byLower(db) {
    let m = lowerIndex.get(db);
    if (!m) { m = {}; for (const o of db.objects) m[o.name.toLowerCase()] = o; lowerIndex.set(db, m); }
    return m;
  }

  // Every identifier with its span in the original text: { text, lower, start, end, bracketed }
  function tokens(masked) {
    const out = [];
    ident.lastIndex = 0;
    let m;
    while ((m = ident.exec(masked))) out.push({ text: m[1] || m[2], lower: (m[1] || m[2]).toLowerCase(), start: m.index, end: m.index + m[0].length, bracketed: !!m[1] });
    return out;
  }

  // References to views/functions: tokens naming a known (or v_/fn_rbac_-looking) object that aren't a column
  // (alias.v_something) and aren't inside a schema-qualified name other than dbo.
  function references(sql, db) {
    const masked = mask(sql);
    const idx = byLower(db);
    const toks = tokens(masked);
    const refs = [];
    toks.forEach((t, k) => {
      if (!/^(v|fn_rbac)_/i.test(t.text)) return;
      const before = masked.slice(0, t.start).replace(/\s+$/, '');
      if (before.endsWith('.')) {
        const prev = toks[k - 1];
        if (!prev || prev.lower !== 'dbo') return;           // alias.v_column -> a column, not a view
      }
      const after = masked.slice(t.end);
      if (/^\s*\./.test(after)) return;                       // v_X.Column written with the full name: handled as a column prefix
      const o = idx[t.lower] || null;
      // Arguments of a function call: fn_rbac_X(@UserSIDs)
      let callEnd = t.end;
      const call = after.match(/^\s*\(([^()]*)\)/);
      if (call) callEnd = t.end + call[0].length;
      // Alias: "v_X os", "v_X AS os", "fn_rbac_X(@UserSIDs) AS os"
      let alias = null;
      const rest = masked.slice(callEnd).match(/^\s+(?:as\s+)?(\[[^\]]+\]|[A-Za-z_][\w]*)/i);
      if (rest) {
        const a = rest[1].replace(/^\[|\]$/g, '');
        if (!KEYWORDS.has(a.toLowerCase())) alias = a;
      }
      refs.push({ name: o ? o.name : t.text, known: !!o, o, start: t.start, end: t.end, callEnd, hasCall: !!call, alias });
    });
    return { masked, refs, toks };
  }

  function analyze(sql, db) {
    const { masked, refs } = references(sql, db);
    // One entry per object, with every alias it goes by
    const objects = [];
    const byName = {};
    for (const r of refs) {
      let e = byName[r.name.toLowerCase()];
      if (!e) { e = byName[r.name.toLowerCase()] = { name: r.name, known: r.known, o: r.o, aliases: [] }; objects.push(e); }
      if (r.alias && !e.aliases.includes(r.alias)) e.aliases.push(r.alias);
    }
    // alias.column (and full_name.column) references
    const aliasTo = {};
    for (const e of objects) { aliasTo[e.name.toLowerCase()] = e; for (const a of e.aliases) aliasTo[a.toLowerCase()] = e; }
    const columns = [];
    const seen = new Set();
    const colRe = /(\[[^\]]+\]|[A-Za-z_][\w]*)\s*\.\s*(\[[^\]]+\]|[A-Za-z_][\w]*|\*)/g;
    let m;
    while ((m = colRe.exec(masked))) {
      const a = m[1].replace(/^\[|\]$/g, ''), c = m[2].replace(/^\[|\]$/g, '');
      const e = aliasTo[a.toLowerCase()];
      if (!e || c === '*' || a.toLowerCase() === 'dbo') continue;
      const key = (e.name + '.' + c).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const col = e.o ? e.o.columns.find(x => x.name.toLowerCase() === c.toLowerCase()) : null;
      const view = e.o ? (e.o.kind === 'function' && e.o.baseView ? e.o.baseView : e.o.name) : e.name;
      columns.push({ alias: a, object: e.name, column: col ? col.name : c, known: !e.known ? null : !!col, type: col ? col.type : null,
        about: col && Col ? Col.describe(view, col.name) : '' });
    }
    const star = /\bselect\s+(top\s*\(?\s*\d+\s*\)?\s*)?(distinct\s+)?\*/i.test(masked) || /\.\s*\*/.test(masked);
    return { objects, columns, star, checks: checks(objects, columns, masked, star, db) };
  }

  // What could go wrong, most serious first: { level: 'stop' | 'warn' | 'info', text, views? }
  function checks(objects, columns, masked, star, db) {
    const out = [];
    const known = objects.filter(e => e.known);
    const unknown = objects.filter(e => !e.known);
    const plainName = (e) => (e.o.kind === 'function' && e.o.baseView) ? e.o.baseView : e.o.name;
    // Rows that repeat a device: device-keyed views not known to be one row per device
    const repeaters = known.filter(e => {
      const v = plainName(e);
      if (!J || v === J.HUB || J.ONE_ROW.has(v)) return false;
      const keys = J.classify(v, new Set(e.o.columns.map(c => c.name)));
      return !!keys.device;
    });
    if (repeaters.length >= 2) {
      out.push({ level: 'stop', views: repeaters.map(e => e.name),
        text: `Devices can repeat, and the repeats multiply: ${repeaters.map(e => e.name).join(', ')} can each have several rows per device. Joined together, a device shows once per combination (3 drives and 150 programs make 450 rows). Check the row count against the device count, or filter each to one row.` });
    } else if (repeaters.length === 1) {
      out.push({ level: 'warn', views: [repeaters[0].name], text: `${repeaters[0].name} can have several rows per device, so devices can repeat.` });
    }
    const badCols = columns.filter(c => c.known === false);
    if (badCols.length) out.push({ level: 'stop', text: `Not in this schema: ${badCols.map(c => `${c.object}.${c.column}`).join(', ')}. A typo, a custom inventory property, or a different ConfigMgr version.` });
    if (unknown.length) out.push({ level: 'warn', text: `Not in this schema: ${unknown.map(e => e.name).join(', ')}. A custom view, a newer ConfigMgr version, or a typo. Load your own site's schema to check.` });
    for (const e of known.filter(x => /^(v|fn_rbac)_HS_/i.test(x.name))) {
      const cur = byLower(db)[e.name.replace(/_HS_/i, '_GS_').toLowerCase()];
      out.push({ level: 'warn', views: [e.name], text: `${e.name} is inventory history: one row per change, so devices repeat and old values show. ${cur ? `For current values use ${cur.name}.` : ''}`.trim() });
    }
    for (const e of known.filter(x => x.o.hinv && x.o.hinv.collected === false)) {
      out.push({ level: 'warn', views: [e.name], text: `${e.name} isn't collected by default (Client Settings, Hardware Inventory). Unless your site turned it on, it's empty.` });
    }
    const usesSys = known.some(e => /^(v|fn_rbac)_R_System$/i.test(e.name));
    if (usesSys && !/obsolete0/i.test(masked)) {
      out.push({ level: 'info', text: 'Obsolete records aren\'t filtered out, so a reinstalled device can show twice. Add WHERE ISNULL(sys.Obsolete0, 0) = 0 (with your v_R_System alias).' });
    }
    const plain = known.filter(e => e.o.kind === 'view' && e.o.rbacFn);
    const fns = known.filter(e => e.o.kind === 'function');
    if (plain.length && fns.length) out.push({ level: 'warn', text: `Mixes plain views (${plain.map(e => e.name).join(', ')}) with fn_rbac_ functions. In SSRS, the plain ones ignore console permissions. Convert below.` });
    else if (plain.length) out.push({ level: 'info', text: 'Uses plain views: fine in SSMS, but as an SSRS report everyone would see every device. The SSRS version below uses the fn_rbac_ functions.' });
    if (star) out.push({ level: 'info', text: 'Uses SELECT *: list the columns you need. Reports break or slow down when a view gains columns.' });
    return out;
  }

  // v_X -> fn_rbac_X(@UserSIDs). Leaves functions, views with no fn_rbac_ version and everything else alone.
  function toRbac(sql, db) {
    const { refs } = references(sql, db);
    const converted = [], noRbac = [];
    let out = '', at = 0;
    for (const r of refs) {
      if (!r.known || r.o.kind !== 'view' || r.hasCall) continue;
      if (!r.o.rbacFn) { if (!noRbac.includes(r.name)) noRbac.push(r.name); continue; }
      out += sql.slice(at, r.start) + `${r.o.rbacFn}(@UserSIDs)`;
      at = r.end;
      if (!converted.includes(r.name)) converted.push(r.name);
    }
    return { sql: out + sql.slice(at), converted, noRbac };
  }

  // fn_rbac_X(...) -> v_X, to run in SSMS without @UserSIDs
  function toPlain(sql, db) {
    const { refs } = references(sql, db);
    const converted = [];
    let out = '', at = 0;
    for (const r of refs) {
      if (!r.known || r.o.kind !== 'function' || !r.o.baseView) continue;
      out += sql.slice(at, r.start) + r.o.baseView;
      at = r.hasCall ? r.callEnd : r.end;
      if (!converted.includes(r.name)) converted.push(r.name);
    }
    return { sql: out + sql.slice(at), converted };
  }

  const api = { analyze, toRbac, toPlain, mask };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VWhereSQL = api;
})(this);
