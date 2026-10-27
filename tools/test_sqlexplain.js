#!/usr/bin/env node
// Tests for web/sqlexplain.js (the "Explain a query" panel) against the real lab schema.
// Run from the repo root:  node tools/test_sqlexplain.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../web/search.js');
const X = require('../web/sqlexplain.js');

const ROOT = path.resolve(__dirname, '..');
const db = S.prepare(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'schema.json'), 'utf8')));

let passed = 0;
function test(title, fn) {
  try { fn(); passed++; console.log(`ok   ${title}`); }
  catch (e) { console.log(`FAIL ${title}\n     ${e.message}\n`); process.exitCode = 1; }
}
const names = (a) => a.objects.map(o => o.name);
const levels = (a) => a.checks.map(c => c.level + ': ' + c.text.slice(0, 40));

const Q1 = `-- Old report: last boot per device
SELECT sys.Name0, os.LastBootUpTime0, os.Caption0
FROM v_R_System sys
JOIN v_GS_OPERATING_SYSTEM AS os ON os.ResourceID = sys.ResourceID
WHERE sys.Client0 = 1 /* v_GS_ADD_REMOVE_PROGRAMS in a comment */ AND os.Caption0 LIKE '%v_GS_DISK%'`;

test('finds views and their aliases; ignores comments and strings', () => {
  const a = X.analyze(Q1, db);
  assert.deepStrictEqual(names(a), ['v_R_System', 'v_GS_OPERATING_SYSTEM']);
  assert.deepStrictEqual(a.objects.map(o => o.aliases), [['sys'], ['os']]);
});

test('reads alias.column references, with descriptions', () => {
  const a = X.analyze(Q1, db);
  assert.deepStrictEqual(a.columns.map(c => `${c.object}.${c.column}`), ['v_R_System.Name0', 'v_GS_OPERATING_SYSTEM.LastBootUpTime0', 'v_GS_OPERATING_SYSTEM.Caption0', 'v_GS_OPERATING_SYSTEM.ResourceID', 'v_R_System.ResourceID', 'v_R_System.Client0']);
  assert.match(a.columns[1].about, /When Windows last started/);
  assert.ok(a.columns.every(c => c.known));
});

test('flags a column that isn\'t in the view', () => {
  const a = X.analyze('SELECT os.LastBootTime0 FROM v_GS_OPERATING_SYSTEM os', db);
  assert.strictEqual(a.columns[0].known, false);
  assert.ok(a.checks.some(c => c.level === 'stop' && /v_GS_OPERATING_SYSTEM\.LastBootTime0/.test(c.text)));
});

test('rows that multiply: two multi-row views is a stop; one is a warning', () => {
  const two = X.analyze('SELECT * FROM v_R_System s JOIN v_GS_LOGICAL_DISK d ON d.ResourceID = s.ResourceID JOIN v_GS_ADD_REMOVE_PROGRAMS p ON p.ResourceID = s.ResourceID', db);
  assert.ok(two.checks.some(c => c.level === 'stop' && /repeats multiply/.test(c.text)), levels(two).join(' | '));
  const one = X.analyze('SELECT d.FreeSpace0 FROM v_R_System s JOIN v_GS_LOGICAL_DISK d ON d.ResourceID = s.ResourceID', db);
  assert.ok(one.checks.some(c => c.level === 'warn' && /v_GS_LOGICAL_DISK can have several rows/.test(c.text)));
  assert.ok(!one.checks.some(c => c.level === 'stop'));
});

test('history views, not-collected views, unknown views, SELECT * and obsolete records are called out', () => {
  const a = X.analyze('SELECT * FROM v_R_System s JOIN v_HS_OPERATING_SYSTEM h ON h.ResourceID = s.ResourceID JOIN v_GS_BOOT_CONFIGURATION b ON b.ResourceID = s.ResourceID JOIN v_Custom_Thing c ON c.ResourceID = s.ResourceID', db);
  const t = a.checks.map(c => c.text).join('\n');
  assert.match(t, /v_HS_OPERATING_SYSTEM is inventory history.*use v_GS_OPERATING_SYSTEM/);
  assert.match(t, /v_GS_BOOT_CONFIGURATION isn't collected by default/);
  assert.match(t, /Not in this schema: v_Custom_Thing/);
  assert.match(t, /SELECT \*/);
  assert.match(t, /Obsolete records aren't filtered out/);
  assert.ok(!/Obsolete records/.test(X.analyze('SELECT s.Name0 FROM v_R_System s WHERE ISNULL(s.Obsolete0,0)=0', db).checks.map(c => c.text).join()));
});

test('to SSRS: v_X becomes fn_rbac_X(@UserSIDs); comments, strings and formatting stay as pasted', () => {
  const r = X.toRbac(Q1, db);
  assert.deepStrictEqual(r.converted, ['v_R_System', 'v_GS_OPERATING_SYSTEM']);
  assert.strictEqual(r.sql, Q1.replace('FROM v_R_System sys', 'FROM fn_rbac_R_System(@UserSIDs) sys').replace('JOIN v_GS_OPERATING_SYSTEM AS os', 'JOIN fn_rbac_GS_OPERATING_SYSTEM(@UserSIDs) AS os'));
});

test('to SSRS: dbo. and [bracketed] names, and views with no fn_rbac_ version are listed', () => {
  const r = X.toRbac('SELECT 1 FROM dbo.[v_R_System] s JOIN [dbo].v_GS_PC_BIOS b ON b.ResourceID = s.ResourceID', db);
  assert.strictEqual(r.sql, 'SELECT 1 FROM dbo.fn_rbac_R_System(@UserSIDs) s JOIN [dbo].fn_rbac_GS_PC_BIOS(@UserSIDs) b ON b.ResourceID = s.ResourceID');
  const none = db.objects.find(o => o.kind === 'view' && !o.rbacFn);
  assert.ok(none, 'need a view without fn_rbac_ for this test');
  assert.deepStrictEqual(X.toRbac(`SELECT * FROM ${none.name}`, db).noRbac, [none.name]);
});

test('to plain: fn_rbac_X(@UserSIDs) becomes v_X, and the round trip gives back the original', () => {
  const ssrs = X.toRbac(Q1, db).sql;
  const back = X.toPlain(ssrs, db);
  assert.deepStrictEqual(back.converted, ['fn_rbac_R_System', 'fn_rbac_GS_OPERATING_SYSTEM']);
  assert.strictEqual(back.sql, Q1);
  assert.strictEqual(X.toPlain('select * from fn_rbac_R_System( @UserSIDs ) s', db).sql, 'select * from v_R_System s');
});

test('aliases after functions, and keywords are never aliases', () => {
  const a = X.analyze('SELECT s.Name0 FROM fn_rbac_R_System(@UserSIDs) AS s LEFT JOIN v_GS_PC_BIOS\nWHERE 1=1', db);
  assert.deepStrictEqual(a.objects.map(o => o.aliases), [['s'], []]);
});

test('alias.v_something is a column, not a view; strings with quotes don\'t confuse it', () => {
  const a = X.analyze(`SELECT x.v_Thing, 'it''s v_R_System' FROM v_GS_PC_BIOS x`, db);
  assert.deepStrictEqual(names(a), ['v_GS_PC_BIOS']);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
