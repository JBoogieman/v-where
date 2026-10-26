#!/usr/bin/env node
// Tests for web/search.js and web/columns.js against the real lab schema.
// Run from the repo root:  node tools/test_search.js        (add --show to print the top results)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../web/search.js');
const C = require('../web/columns.js');

const ROOT = path.resolve(__dirname, '..');
const db = S.prepare(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'schema.json'), 'utf8')));
const SHOW = process.argv.includes('--show');

let passed = 0;
function test(title, fn) {
  try { fn(); passed++; console.log(`ok   ${title}`); }
  catch (e) { console.log(`FAIL ${title}\n     ${e.message}\n`); process.exitCode = 1; }
}
// Search and return the results, printing the top few with --show
function find(q, opts = {}) {
  const res = S.run(db, { q, ...opts });
  if (SHOW) console.log(`     "${q}": ` + res.all.slice(0, 5).map(r => `${r.o.name} [${[...r.hitCols].slice(0, 3).join(', ')}]`).join(' · '));
  return res;
}
const names = (res) => res.all.map(r => r.o.name);
const rankOf = (res, name) => names(res).indexOf(name);
const hitsOf = (res, name) => { const r = res.all.find(x => x.o.name === name); assert(r, `${name} not in results`); return [...r.hitCols]; };
const inTop = (res, name, n) => { const i = rankOf(res, name); assert(i >= 0 && i < n, `${name} is #${i + 1}, expected top ${n}: ${names(res).slice(0, n).join(', ')}`); };

// ---- Ranking: the view people want comes first ----
test('last boot: Operating System first, with only LastBootUpTime0 matched', () => {
  const res = find('last boot');
  assert.strictEqual(names(res)[0], 'v_GS_OPERATING_SYSTEM');
  assert.deepStrictEqual(hitsOf(res, 'v_GS_OPERATING_SYSTEM'), ['LastBootUpTime0']);
});

test('last boot: words scattered across unrelated columns don\'t make the list', () => {
  // v_GS_COMPUTER_SYSTEM has LastLoadInfo0 and BootupState0, but no column about the last boot
  const res = find('last boot');
  assert(res.all.length <= 8, `${res.all.length} results`);
  assert.strictEqual(rankOf(res, 'v_GS_COMPUTER_SYSTEM'), -1);
});

test('uptime -> last boot up time', () => {
  const res = find('uptime');
  assert.strictEqual(names(res)[0], 'v_GS_OPERATING_SYSTEM');
  assert(hitsOf(res, 'v_GS_OPERATING_SYSTEM').includes('LastBootUpTime0'));
});

test('ram: memory view first, with TotalPhysicalMemory0', () => {
  const res = find('ram');
  assert.strictEqual(names(res)[0], 'v_GS_X86_PC_MEMORY');
  assert(hitsOf(res, 'v_GS_X86_PC_MEMORY').includes('TotalPhysicalMemory0'));
});

test('ram does not match "Programs"', () => {
  const res = find('ram');
  assert.strictEqual(rankOf(res, 'v_GS_ADD_REMOVE_PROGRAMS'), -1);
});

test('serial number: device list and BIOS near the top', () => {
  const res = find('serial number');
  inTop(res, 'v_R_System', 3);
  inTop(res, 'v_GS_PC_BIOS', 3);
  assert.deepStrictEqual(hitsOf(res, 'v_GS_PC_BIOS'), ['SerialNumber0']);
});

test('install date: exact column name ranks well', () => {
  const res = find('install date');
  inTop(res, 'v_GS_INSTALLED_SOFTWARE', 3);
  assert.deepStrictEqual(hitsOf(res, 'v_GS_OPERATING_SYSTEM'), ['InstallDate0']);
});

test('installdate (one word) finds InstallDate0', () => {
  const res = find('installdate');
  assert(hitsOf(res, 'v_GS_OPERATING_SYSTEM').includes('InstallDate0'));
});

test('primary user: user device affinity views first', () => {
  const res = find('primary user');
  inTop(res, 'v_UsersPrimaryMachines', 2);
  inTop(res, 'v_UserMachineRelationship', 2);
});

test('kb: hotfix and update views, KB columns only', () => {
  const res = find('kb');
  inTop(res, 'v_GS_QUICK_FIX_ENGINEERING', 2);
  inTop(res, 'v_UpdateInfo', 3);
  assert.deepStrictEqual(hitsOf(res, 'v_GS_QUICK_FIX_ENGINEERING'), ['HotFixID0']);
  assert.deepStrictEqual(hitsOf(res, 'v_UpdateInfo'), ['ArticleID']);
});

test('last logon: AD logon timestamp in the device list is found', () => {
  const res = find('last logon');
  inTop(res, 'v_R_System', 3);
  assert(hitsOf(res, 'v_R_System').includes('Last_Logon_Timestamp0'));
});

test('chassis: enclosure first', () => {
  const res = find('chassis');
  assert.strictEqual(names(res)[0], 'v_GS_SYSTEM_ENCLOSURE');
  assert(hitsOf(res, 'v_GS_SYSTEM_ENCLOSURE').includes('ChassisTypes0'));
});

test('bitlocker: BitLocker and encryptable volume views', () => {
  const res = find('bitlocker');
  inTop(res, 'v_GS_BITLOCKER_DETAILS', 3);
  inTop(res, 'v_GS_ENCRYPTABLE_VOLUME', 3);
});

test('an exact view name goes straight to the top', () => {
  assert.strictEqual(names(find('v_R_System'))[0], 'v_R_System');
  assert.strictEqual(names(find('R_System'))[0], 'v_R_System');
});

test('nonsense finds nothing', () => {
  assert.strictEqual(find('zzqx').all.length, 0);
});

test('filler words are ignored: "sccm view for last boot"', () => {
  assert.strictEqual(names(find('sccm view for last boot'))[0], 'v_GS_OPERATING_SYSTEM');
});

test('history views rank below their current views', () => {
  for (const q of ['last boot', 'ram', 'serial number', 'chassis', 'kb']) {
    const res = find(q);
    for (const r of res.all) {
      if (!r.o.name.startsWith('v_HS_')) continue;
      const cur = 'v_GS_' + r.o.name.slice(5);
      const i = rankOf(res, cur);
      if (i >= 0) assert(i < rankOf(res, r.o.name), `"${q}": ${cur} should rank above ${r.o.name}`);
    }
  }
});

test('fn_rbac_ functions only when asked', () => {
  assert(!names(find('last boot')).some(n => n.startsWith('fn_rbac_')));
  assert(names(find('last boot', { fn: true })).includes('fn_rbac_GS_OPERATING_SYSTEM'));
});

test('also searching lists the synonym searches', () => {
  const res = find('kb');
  assert.deepStrictEqual(S.alsoSearching(res.variants), ['article id', 'hot fix id']);
});

test('empty search lists every view, A to Z', () => {
  const res = find('');
  assert.strictEqual(res.all.length, db.objects.filter(o => o.kind === 'view').length);
  assert(res.all[0].o.name.localeCompare(res.all[1].o.name) <= 0);
});

// ---- Highlighting: whole word starts only ----
test('highlight: marks word starts', () => {
  assert.strictEqual(S.highlight('LastBootUpTime0', ['last', 'boot', 'up', 'time']), '<mark>LastBootUpTime</mark>0');
});

test('highlight: no mid-word marks for short words', () => {
  assert.strictEqual(S.highlight('GroupID', ['up']), 'GroupID');
  assert.strictEqual(S.highlight('Programs', ['ram']), 'Programs');
});

test('highlight: long words may match mid-word', () => {
  assert.strictEqual(S.highlight('DNSHostName0', ['hostname']), 'DNS<mark>HostName</mark>0');
});

test('highlight: underscores and acronyms are word breaks', () => {
  assert.strictEqual(S.highlight('Last_Logon_Timestamp0', ['logon']), 'Last_<mark>Logon</mark>_Timestamp0');
  assert.strictEqual(S.highlight('ADLastLogonTime', ['last']), 'AD<mark>Last</mark>LogonTime');
});

test('highlight: escapes HTML', () => {
  assert.strictEqual(S.highlight('<b>x', []), '&lt;b&gt;x');
});

// ---- Categories ----
test('categories', () => {
  assert.strictEqual(S.categoryOf('v_GS_PC_BIOS'), 'Hardware inventory');
  assert.strictEqual(S.categoryOf('v_HS_PC_BIOS'), 'Inventory history');
  assert.strictEqual(S.categoryOf('fn_rbac_R_System'), 'Discovery');
});

// ---- Column descriptions ----
test('columns: view-specific description', () => {
  assert.match(C.describe('v_GS_X86_PC_MEMORY', 'TotalPhysicalMemory0'), /KB/);
});

test('columns: fn_rbac_ and v_HS_ use the current view\'s descriptions', () => {
  const d = C.describe('v_GS_OPERATING_SYSTEM', 'LastBootUpTime0');
  assert(d);
  assert.strictEqual(C.describe('fn_rbac_GS_OPERATING_SYSTEM', 'LastBootUpTime0'), d);
  assert.strictEqual(C.describe('v_HS_OPERATING_SYSTEM', 'LastBootUpTime0'), d);
});

test('columns: generic columns described in any view', () => {
  assert(C.describe('v_GS_DISK', 'ResourceID'));
  assert.strictEqual(C.describe('v_GS_DISK', 'NoSuchColumn'), '');
});

test('columns: every described column exists in the schema', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'columns.js'), 'utf8');
  const keys = [...src.matchAll(/'(v_[A-Za-z0-9_]+)\.([A-Za-z0-9_]+)'/g)].map(m => [m[1], m[2]]);
  assert(keys.length > 100, `${keys.length} keys`);
  const missing = keys.filter(([v, c]) => !db.byName[v] || !db.byName[v].columns.some(x => x.name === c)).map(k => k.join('.'));
  assert.deepStrictEqual(missing, []);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
