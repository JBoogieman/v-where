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

// ---- Rows that multiply ----
const multiply = (p) => p.warnings.find(w => w.multiply);
test('multiply: two multi-row views warn that rows multiply (drives x programs)',
  [C('v_R_System', 'Name0'), C('v_GS_LOGICAL_DISK', 'FreeSpace0'), C('v_GS_ADD_REMOVE_PROGRAMS', 'DisplayName0')], {},
  (p, sql) => {
    const m = multiply(p);
    assert.ok(m, 'no multiply warning');
    assert.deepStrictEqual(m.views, ['v_GS_LOGICAL_DISK', 'v_GS_ADD_REMOVE_PROGRAMS']);
    assert.match(m.text, /together they multiply/);
    assert.match(sql, /^-- WARNING: rows multiply\. v_GS_LOGICAL_DISK and v_GS_ADD_REMOVE_PROGRAMS/);
  });

test('multiply: keeping one row on one of them leaves nothing to multiply',
  [C('v_GS_LOGICAL_DISK', 'FreeSpace0'), C('v_GS_ADD_REMOVE_PROGRAMS', 'DisplayName0')], { keepOne: ['v_GS_LOGICAL_DISK'] },
  (p, sql) => { assert.ok(!multiply(p)); assert.doesNotMatch(sql, /rows multiply/); });

test('multiply: one multi-row view on its own is a plain warning, not a multiply',
  [C('v_R_System', 'Name0'), C('v_GS_ADD_REMOVE_PROGRAMS', 'DisplayName0'), C('v_GS_OPERATING_SYSTEM', 'Caption0')], {},
  (p) => assert.ok(!multiply(p)));

test('multiply: a link table counts (primary users x installed programs)',
  [C('v_R_User', 'Unique_User_Name0'), C('v_GS_ADD_REMOVE_PROGRAMS', 'DisplayName0')], {},
  (p) => assert.deepStrictEqual(multiply(p).views, ['v_GS_ADD_REMOVE_PROGRAMS', 'v_UsersPrimaryMachines']));

test('multiply: the collection filter is not a repeat',
  [C('v_GS_LOGICAL_DISK', 'FreeSpace0')], { collection: true },
  (p) => assert.ok(!multiply(p)));

test('multiply: explain() says so in plain English',
  [C('v_GS_LOGICAL_DISK', 'FreeSpace0'), C('v_GS_ADD_REMOVE_PROGRAMS', 'DisplayName0')], {},
  (p) => assert.ok(J.explain(p).some(e => e.role === 'multiply' && /once for every combination/.test(e.text))));

// ---- Obsolete and decommissioned records ----
test('skipObsolete leaves out obsolete and decommissioned records',
  [C('v_R_System', 'Name0')], { skipUnknown: true, skipObsolete: true },
  (p, sql) => {
    assert.match(sql, /^WHERE ISNULL\(sys\.Unknown0, 0\) = 0\n  AND ISNULL\(sys\.Obsolete0, 0\) = 0\n  AND ISNULL\(sys\.Decommissioned0, 0\) = 0   -- skip Unknown Computer placeholders, obsolete and decommissioned records$/m);
    assert.ok(J.explain(p).some(e => e.role === 'where' && /reinstalled device shows once/.test(e.text)));
  });

test('skipObsolete does nothing on a user-only report',
  [C('v_R_User', 'Mail0')], { skipObsolete: true },
  (p, sql) => assert.doesNotMatch(sql, /Obsolete0/));

// ---- Filters and report parameters ----
const F = (view, column, op, value, ask) => ({ view, column, op, value, ask });
test('filter: a column already in the report is filtered in place',
  [C('v_R_System', 'Name0'), C('v_GS_OPERATING_SYSTEM', 'LastBootUpTime0')], { filters: [F('v_GS_OPERATING_SYSTEM', 'LastBootUpTime0', 'olderdays', '30')] },
  (p, sql) => { assert.match(sql, /^WHERE os\.LastBootUpTime0 < DATEADD\(day, -30, GETDATE\(\)\)$/m); assert.doesNotMatch(sql, /EXISTS/); });

test('filter: a view not in the report is checked with EXISTS, so it never repeats a device',
  [C('v_R_System', 'Name0')], { filters: [F('v_GS_ADD_REMOVE_PROGRAMS', 'DisplayName0', 'contains', 'Office')] },
  (p, sql) => {
    assert.match(sql, /^WHERE EXISTS \(SELECT 1 FROM v_GS_ADD_REMOVE_PROGRAMS flt1 WHERE flt1\.ResourceID = sys\.ResourceID AND flt1\.DisplayName0 LIKE N'%' \+ N'Office' \+ N'%'\)$/m);
    assert.ok(!p.joins.some(j => j.view === 'v_GS_ADD_REMOVE_PROGRAMS'), 'filter view was joined');
    assert.ok(!p.warnings.some(w => w.multiply));
  });

test('filter: EXISTS uses the fn_rbac_ version in the SSRS query',
  [C('v_R_System', 'Name0')], { rbac: true, filters: [F('v_GS_COMPUTER_SYSTEM', 'Model0', 'starts', 'Latitude')] },
  (p, sql) => assert.match(sql, /EXISTS \(SELECT 1 FROM fn_rbac_GS_COMPUTER_SYSTEM\(@UserSIDs\) flt1 WHERE/));

test('filter: "ask" makes a report parameter, with a DECLARE hint for SSMS',
  [C('v_R_System', 'Name0')], { collection: true, filters: [F('v_GS_COMPUTER_SYSTEM', 'Model0', 'contains', 'Latitude', true), F('v_GS_OPERATING_SYSTEM', 'LastBootUpTime0', 'olderdays', '30', true)] },
  (p, sql) => {
    assert.deepStrictEqual(p.params.map(q => [q.name, q.rdl, q.default]), [['Model', 'String', 'Latitude'], ['LastBootUpTimeDays', 'Integer', '30']]);
    assert.match(sql, /LIKE N'%' \+ @Model \+ N'%'/);
    assert.match(sql, /DATEADD\(day, -@LastBootUpTimeDays, GETDATE\(\)\)/);
    assert.match(sql, /^-- DECLARE @CollectionID nvarchar\(8\) = 'SMS00001';$/m);
    assert.match(sql, /^-- DECLARE @Model nvarchar\(4000\) = N'Latitude';$/m);
    assert.match(sql, /^-- DECLARE @LastBootUpTimeDays int = 30;$/m);
  });

test('filter: values are quoted safely; bad numbers and dates are left out with a reason',
  [C('v_R_System', 'Name0')], { filters: [F('v_R_System', 'Name0', 'eq', "O'Brien-PC"), F('v_GS_X86_PC_MEMORY', 'TotalPhysicalMemory0', 'lt', '8GB; DROP TABLE x'), F('v_GS_OPERATING_SYSTEM', 'InstallDate0', 'before', 'yesterday')] },
  (p, sql) => {
    assert.match(sql, /sys\.Name0 = N'O''Brien-PC'/);
    assert.doesNotMatch(sql, /DROP|yesterday/);
    assert.deepStrictEqual(p.filters.filter(f => f.problem).map(f => f.problem), ['Needs a number.', 'Needs a date.']);
  });

test('filter: every op for every kind of column gives SQL',
  [C('v_R_System', 'Name0')], {},
  () => {
    const cases = { text: ['v_R_System', 'Name0', 'x'], number: ['v_GS_X86_PC_MEMORY', 'TotalPhysicalMemory0', '8'],
      date: ['v_GS_OPERATING_SYSTEM', 'LastBootUpTime0', null], bit: ['v_FullCollectionMembership', 'IsDirect', ''] };
    for (const [kind, [view, column, value]] of Object.entries(cases)) {
      assert.strictEqual(J.valueKind(byName[view].types[column]), kind, `${view}.${column} is ${kind}`);
      for (const op of J.OPS[kind]) {
        const v = op.value === 'date' ? '2026-01-01' : op.value === 'days' ? '30' : value;
        const p = J.plan(['v_R_System'], lookup, { filters: [F(view, column, op.id, v)] });
        assert.ok(p.filters[0].cond, `${kind} ${op.id}: ${p.filters[0].problem}`);
      }
    }
  });

test('filter: explain() says what each filter does',
  [C('v_R_System', 'Name0')], { filters: [F('v_GS_ADD_REMOVE_PROGRAMS', 'DisplayName0', 'contains', 'Office'), F('v_GS_OPERATING_SYSTEM', 'LastBootUpTime0', 'olderdays', '30', true)] },
  (p) => {
    const t = J.explain(p).filter(e => e.role === 'filter-where').map(e => e.text);
    assert.match(t[0], /^Only devices where Display Name contains "Office", checked in Installed programs \(32-bit\) without adding its rows/);
    assert.match(t[1], /^Only devices where Last Boot Up Time is more than N \(asked when the report runs, default 30\) days ago, checked in Operating System/);
  });

test('filter: a view with no device key explains how to filter on it instead',
  [C('v_R_System', 'Name0')], { filters: [F('v_UpdateInfo', 'ArticleID', 'eq', '5031354')] },
  (p, sql) => { assert.match(p.filters[0].problem, /isn't linked to devices directly/); assert.doesNotMatch(sql, /ArticleID/); });

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
