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
for (const o of schema.objects) byName[o.name] = { name: o.name, columns: o.columns.map(c => c[0]), types: Object.fromEntries(o.columns.map(c => [c[0], c[1]])), rbacFn: null, baseView: o.baseView };
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
const C = (view, column, as) => ({ view, column, as });

// ---- Readable values ----
test('readable: memory KB -> GB, header gets the unit',
  [C('v_R_System', 'Name0'), C('v_GS_X86_PC_MEMORY', 'TotalPhysicalMemory0')], { readable: true },
  (p, sql) => assert.match(sql, /CAST\(ROUND\(mem\.TotalPhysicalMemory0 \/ 1048576\.0, 1\) AS decimal\(10,1\)\) AS \[Total Physical Memory \(GB\)\]/));

test('readable: a renamed column keeps its name',
  [C('v_GS_X86_PC_MEMORY', 'TotalPhysicalMemory0', 'RAM')], { readable: true },
  (p, sql) => assert.match(sql, /AS decimal\(10,1\)\) AS \[RAM\]/));

test('readable: BitLocker status codes -> On/Off, unknown codes pass through',
  [C('v_GS_BITLOCKER_DETAILS', 'ProtectionStatus0')], { readable: true },
  (p, sql) => assert.match(sql, /CASE bl\.ProtectionStatus0 WHEN 0 THEN 'Off' WHEN 1 THEN 'On' WHEN 2 THEN 'Unknown' ELSE CAST\(bl\.ProtectionStatus0 AS varchar\(20\)\) END AS \[Protection Status\]/));

test('readable: text-typed code column compares to quoted values (ChassisTypes0 is nvarchar)',
  [C('v_GS_SYSTEM_ENCLOSURE', 'ChassisTypes0')], { readable: true },
  (p, sql) => { assert.match(sql, /CASE enc\.ChassisTypes0 WHEN '1' THEN 'Other'/); assert.match(sql, /WHEN '3' THEN 'Desktop'/); assert.match(sql, /WHEN '10' THEN 'Notebook'/); assert.match(sql, /ELSE enc\.ChassisTypes0 END/); });

test('readable: client flag NULL means No; firmware yes/no keeps blanks',
  [C('v_R_System', 'Client0'), C('v_GS_FIRMWARE', 'SecureBoot0')], { readable: true },
  (p, sql) => {
    assert.match(sql, /CASE WHEN sys\.Client0 = 1 THEN 'Yes' ELSE 'No' END AS \[Client\]/);
    assert.match(sql, /CASE f\.SecureBoot0 WHEN 1 THEN 'Yes' WHEN 0 THEN 'No' END AS \[Secure Boot\]/);
  });

test('readable off: raw columns, no unit in the header',
  [C('v_GS_X86_PC_MEMORY', 'TotalPhysicalMemory0')], { readable: false },
  (p, sql) => assert.match(sql, /mem\.TotalPhysicalMemory0 AS \[Total Physical Memory\]/));

test('headers report the new output type for the .rdl',
  [C('v_GS_X86_PC_MEMORY', 'TotalPhysicalMemory0'), C('v_GS_BITLOCKER_DETAILS', 'ProtectionStatus0'), C('v_R_System', 'Name0')], { readable: true },
  (p) => assert.deepStrictEqual(J.headers(p, [C('v_GS_X86_PC_MEMORY', 'TotalPhysicalMemory0'), C('v_GS_BITLOCKER_DETAILS', 'ProtectionStatus0'), C('v_R_System', 'Name0')], { readable: true }).map(h => h.outType), ['decimal', 'varchar', null]));

test('every format points at a column that exists in the schema',
  [C('v_R_System', 'Name0')], {},
  () => {
    for (const key of Object.keys(J.FORMATS)) {
      const [view, col] = key.split('.');
      assert.ok(byName[view] && byName[view].columns.includes(col), `${key} not in schema`);
    }
  });

// ---- Unknown Computer placeholders ----
test('skipUnknown adds the WHERE on the hub',
  [C('v_R_System', 'Name0')], { skipUnknown: true, collection: true },
  (p, sql) => assert.match(sql, /^WHERE ISNULL\(sys\.Unknown0, 0\) = 0/m));

test('skipUnknown does nothing on a user-only report',
  [C('v_R_User', 'Mail0')], { skipUnknown: true },
  (p, sql) => assert.doesNotMatch(sql, /Unknown0/));

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

// ---- Plain-English explanation of the connections ----
const said = (p) => J.explain(p).map(e => e.text);
test('explain: one sentence per table, in query order, plus the Unknown Computer filter',
  [C('v_R_System', 'Name0'), C('v_GS_OPERATING_SYSTEM', 'LastBootUpTime0'), C('v_R_User', 'Unique_User_Name0')], { collection: true, skipUnknown: true },
  (p) => {
    const e = J.explain(p);
    assert.deepStrictEqual(e.map(x => x.view), ['v_R_System', 'v_FullCollectionMembership', 'v_GS_OPERATING_SYSTEM', 'v_UsersPrimaryMachines', 'v_R_User', null]);
    assert.match(e[0].text, /^Starts from Devices \(v_R_System\): one row per device\./);
    assert.match(e[1].text, /keeps only the devices in the collection/);
    assert.match(e[2].text, /^Operating System \(v_GS_OPERATING_SYSTEM\) is matched to each device by its ID \(ResourceID\)\.$/);
    assert.match(e[3].text, /added for you as a link table: it connects users to devices\. A device with more than one primary user/);
    assert.match(e[4].text, /^Users \(v_R_User\) is matched through Primary users\.$/);
    assert.match(e[5].text, /Unknown Computer/);
  });

test('explain: multi-row views say so; a kept "one row" fix is described instead',
  [C('v_GS_LOGICAL_DISK', 'FreeSpace0')], {},
  (p) => assert.match(said(p)[1], /can have more than one row per device/));
test('explain: kept fix',
  [C('v_GS_LOGICAL_DISK', 'FreeSpace0')], { keepOne: ['v_GS_LOGICAL_DISK'] },
  (p) => assert.match(said(p)[1], /Only one row per device is kept \(DeviceID0 = 'C:'\)\./));

test('explain: update details go through the update status link table',
  [C('v_R_System', 'Name0'), C('v_UpdateInfo', 'ArticleID')], {},
  (p) => {
    assert.match(said(p)[1], /^Update status per device \(v_UpdateComplianceStatus\) was added for you as a link table: it connects updates to devices\./);
    assert.match(said(p)[2], /^Update details \(v_UpdateInfo\) is matched through Update status per device\.$/);
  });

test('explain: a user-only report starts from users',
  [C('v_R_User', 'Unique_User_Name0'), C('v_R_User', 'Mail0')], {},
  (p) => assert.match(said(p)[0], /^Starts from Users \(v_R_User\): one row per user\./));

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
