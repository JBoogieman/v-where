#!/usr/bin/env node
// Tests for web/joinplan.js against the real lab schema.
// Run from the repo root:  node tools/test_joinplan.js        (add --show to print each query)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const J = require('../web/joinplan.js');

const ROOT = path.resolve(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'schema.json'), 'utf8'));
const byName = {};
for (const o of schema.objects) byName[o.name] = { name: o.name, columns: o.columns.map(c => c[0]), rbacFn: null, baseView: o.baseView };
for (const o of Object.values(byName)) if (o.baseView && byName[o.baseView]) byName[o.baseView].rbacFn = o.name;
const lookup = (n) => byName[n] || null;
const SHOW = process.argv.includes('--show');

let passed = 0;
function test(title, cols, opts, check) {
  const p = J.plan(cols.map(c => c.view), lookup, opts);
  const sql = J.toSQL(p, cols, lookup, opts);
  try { check(p, sql); passed++; console.log(`ok   ${title}`); }
  catch (e) { console.log(`FAIL ${title}\n     ${e.message}\n${sql}\n`); process.exitCode = 1; return; }
  if (SHOW) console.log('\n' + sql + '\n');
}
const on = (p, view) => (p.joins.find(j => j.view === view) || {}).on;
const C = (view, column) => ({ view, column });

test('device report: everything joins to v_R_System on ResourceID',
  [C('v_R_System', 'Name0'), C('v_GS_OPERATING_SYSTEM', 'LastBootUpTime0'), C('v_GS_X86_PC_MEMORY', 'TotalPhysicalMemory0')], {},
  (p) => {
    assert.strictEqual(p.from.view, 'v_R_System');
    assert.strictEqual(on(p, 'v_GS_OPERATING_SYSTEM'), 'os.ResourceID = sys.ResourceID');
    assert.strictEqual(on(p, 'v_GS_X86_PC_MEMORY'), 'mem.ResourceID = sys.ResourceID');
    assert.strictEqual(p.warnings.length, 0, 'one-row views should not warn');
  });

test('hub is added even when not picked',
  [C('v_GS_PC_BIOS', 'SerialNumber0')], {},
  (p) => { assert.strictEqual(p.from.view, 'v_R_System'); assert.strictEqual(on(p, 'v_GS_PC_BIOS'), 'bios.ResourceID = sys.ResourceID'); });

test('collection filter joins v_FullCollectionMembership with @CollectionID',
  [C('v_R_System', 'Name0')], { collection: true },
  (p, sql) => {
    assert.match(on(p, 'v_FullCollectionMembership'), /fcm\.CollectionID = @CollectionID/);
    assert.strictEqual(p.joins[0].type, 'JOIN', 'filter must be an inner join');
    assert.match(sql, /^JOIN v_FullCollectionMembership fcm ON/m);
  });

test('multi-row view warns and suggests the filter',
  [C('v_R_System', 'Name0'), C('v_GS_BITLOCKER_DETAILS', 'ProtectionStatus0')], {},
  (p, sql) => {
    const w = p.warnings.find(x => x.view === 'v_GS_BITLOCKER_DETAILS');
    assert.ok(w && w.fix === "AND bl.DriveLetter0 = 'C:'", 'expected a C: drive fix');
    assert.match(sql, /-- .*one row per drive.*DriveLetter0/);
  });

test('keepOne applies the fix inside the join',
  [C('v_R_System', 'Name0'), C('v_GS_BITLOCKER_DETAILS', 'ProtectionStatus0')], { keepOne: ['v_GS_BITLOCKER_DETAILS'] },
  (p, sql) => {
    assert.strictEqual(on(p, 'v_GS_BITLOCKER_DETAILS'), "bl.ResourceID = sys.ResourceID AND bl.DriveLetter0 = 'C:'");
    assert.ok(p.warnings.some(w => w.view === 'v_GS_BITLOCKER_DETAILS' && w.kept && !w.fix));
    assert.doesNotMatch(sql, /To keep one/);
  });

test('unknown multi-row view gets a generic warning',
  [C('v_GS_SYSTEM_CONSOLE_USER', 'SystemConsoleUser0')], {},
  (p) => assert.ok(p.warnings.some(w => w.view === 'v_GS_SYSTEM_CONSOLE_USER' && !w.fix)));

test('MachineID views join on MachineID',
  [C('v_R_System', 'Name0'), C('v_CH_ClientHealth', 'LastOnline')], {},
  (p) => assert.strictEqual(on(p, 'v_CH_ClientHealth'), 'cch.MachineID = sys.ResourceID'));

test('user view on a device report goes through v_UsersPrimaryMachines',
  [C('v_R_System', 'Name0'), C('v_R_User', 'Unique_User_Name0')], {},
  (p) => {
    assert.strictEqual(on(p, 'v_UsersPrimaryMachines'), 'upm.MachineID = sys.ResourceID');
    assert.strictEqual(on(p, 'v_R_User'), 'usr.ResourceID = upm.UserResourceID');
    assert.ok(p.warnings.some(w => w.view === 'v_UsersPrimaryMachines'), 'bridge should explain itself');
    assert.ok(!p.warnings.some(w => w.view === 'v_R_User'), 'v_R_User is one row per user: the bridge note covers repeats');
  });

test('picked v_UsersPrimaryMachines is reused as the bridge, not added twice',
  [C('v_UsersPrimaryMachines', 'UserResourceID'), C('v_R_User', 'Mail0')], {},
  (p) => assert.strictEqual(p.joins.filter(j => j.view === 'v_UsersPrimaryMachines').length, 1));

test('user-only report anchors on v_R_User',
  [C('v_R_User', 'Unique_User_Name0'), C('v_RA_User_UserGroupName', 'User_Group_Name0')], {},
  (p) => {
    assert.strictEqual(p.from.view, 'v_R_User');
    assert.strictEqual(on(p, 'v_RA_User_UserGroupName'), 'uugn.ResourceID = usr.ResourceID');
  });

test('update info goes through v_UpdateComplianceStatus',
  [C('v_R_System', 'Name0'), C('v_UpdateInfo', 'ArticleID')], {},
  (p) => {
    assert.strictEqual(on(p, 'v_UpdateComplianceStatus'), 'ucs.ResourceID = sys.ResourceID');
    assert.strictEqual(on(p, 'v_UpdateInfo'), 'ui.CI_ID = ucs.CI_ID');
  });

test('picked compliance view is reused as the CI bridge',
  [C('v_UpdateComplianceStatus', 'Status'), C('v_UpdateInfo', 'ArticleID')], {},
  (p) => {
    assert.strictEqual(p.joins.filter(j => j.role === 'bridge').length, 0);
    assert.strictEqual(on(p, 'v_UpdateInfo'), 'ui.CI_ID = ucs.CI_ID');
  });

test('v_Collection joins through the collection filter',
  [C('v_R_System', 'Name0'), C('v_Collection', 'Name')], { collection: true },
  (p) => assert.strictEqual(on(p, 'v_Collection'), 'coll.CollectionID = fcm.CollectionID'));

test('view with no usable key is left out with a reason',
  [C('v_R_System', 'Name0'), C('v_Site', 'SiteName')], {},
  (p, sql) => { assert.ok(p.unplaced.some(u => u.view === 'v_Site')); assert.match(sql, /-- left out: v_Site/); });

test('rbac mode uses fn_rbac_ functions with @UserSIDs',
  [C('v_R_System', 'Name0'), C('v_GS_OPERATING_SYSTEM', 'Caption0')], { rbac: true, collection: true },
  (p, sql) => {
    assert.match(sql, /FROM fn_rbac_R_System\(@UserSIDs\) sys/);
    assert.match(sql, /LEFT JOIN fn_rbac_GS_OPERATING_SYSTEM\(@UserSIDs\) os/);
    assert.match(sql, /JOIN fn_rbac_FullCollectionMembership\(@UserSIDs\) fcm/);
  });

test('column labels are readable and unique',
  [C('v_R_System', 'Name0'), C('v_GS_OPERATING_SYSTEM', 'Name0'), C('v_GS_OPERATING_SYSTEM', 'LastBootUpTime0')], {},
  (p, sql) => {
    assert.match(sql, /sys\.Name0 AS \[Name\]/);
    assert.match(sql, /os\.Name0 AS \[Operating System Name\]/);
    assert.match(sql, /os\.LastBootUpTime0 AS \[Last Boot Up Time\]/);
  });

test('every alias is unique and not a SQL keyword (all 443 device views at once)',
  Object.values(byName).filter(o => !o.name.startsWith('fn_') && o.columns.includes('ResourceID')).map(o => C(o.name, o.columns[0])), {},
  (p) => {
    const all = [p.from.alias, ...p.joins.map(j => j.alias)];
    assert.strictEqual(new Set(all).size, all.length, 'duplicate alias');
    assert.ok(!all.some(a => /^(as|on|in|or|is|by|to|of|if|and|end|for|key|not|set|top|use)$/i.test(a)), 'reserved alias');
  });

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
