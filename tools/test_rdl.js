#!/usr/bin/env node
// Tests for web/rdl.js: builds reports from real schema columns and checks their structure.
// Run from the repo root:  node tools/test_rdl.js        (add --write to save the samples to dist/)
// For a full check against Microsoft's RDL 2008 schema (ReportDefinition.xsd), validate the
// --write output with any XSD validator, e.g. Python: lxml.etree.XMLSchema(...).validate(...)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const J = require('../web/joinplan.js');
const R = require('../web/rdl.js');

const ROOT = path.resolve(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'schema.json'), 'utf8'));
const byName = {};
for (const o of schema.objects) byName[o.name] = { name: o.name, columns: o.columns.map(c => c[0]), types: Object.fromEntries(o.columns.map(c => [c[0], c[1]])), rbacFn: null, baseView: o.baseView };
for (const o of Object.values(byName)) if (o.baseView && byName[o.baseView]) byName[o.baseView].rbacFn = o.name;
const lookup = (n) => byName[n] || null;
const WRITE = process.argv.includes('--write');

// Same steps the page takes: plan -> SSRS query -> headers + types -> .rdl
function makeReport(cols, opts, title) {
  const o = { ...opts, rbac: true };
  const p = J.plan(cols.map(c => c.view), lookup, o);
  const sql = J.toSQL(p, cols, lookup, o);
  const columns = J.headers(p, cols, o).map(h => ({ name: h.name, type: h.outType || byName[h.view].types[h.column] }));
  return R.build({ title, siteCode: 'lab', sql, columns, collection: o.collection, params: p.params });
}

// Minimal XML check: tags balance and nest, no raw & or < in text. Enough to catch builder slips.
function wellFormed(xml) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[5] !== undefined) { assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(m[5]), `bare & in text: ${m[5].slice(0, 60)}`); continue; }
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) assert.strictEqual(stack.pop(), name, `mismatched </${name}>`);
    else stack.push(name);
  }
  assert.strictEqual(stack.length, 0, `unclosed: ${stack.join(' > ')}`);
}
const count = (xml, s) => xml.split(s).length - 1;

let passed = 0;
function test(title, fn) {
  try { fn(); passed++; console.log(`ok   ${title}`); }
  catch (e) { console.log(`FAIL ${title}\n     ${e.message}`); process.exitCode = 1; }
}
const C = (view, column, as) => ({ view, column, as });

const full = makeReport([C('v_R_System', 'Name0', 'Device'), C('v_GS_OPERATING_SYSTEM', 'LastBootUpTime0'),
  C('v_GS_X86_PC_MEMORY', 'TotalPhysicalMemory0', 'RAM (KB)'), C('v_GS_BITLOCKER_DETAILS', 'ProtectionStatus0'), C('v_R_User', 'Mail0')],
  { collection: true, keepOne: ['v_GS_BITLOCKER_DETAILS'] }, 'Device overview');
const plain = makeReport([C('v_GS_PC_BIOS', 'SerialNumber0')], { collection: false }, 'Serials');
const weird = makeReport([C('v_R_System', 'Name0', 'Name <&> "quoted"'), C('v_R_System', 'ResourceID', '123 start')], { collection: true }, 'A & B: <test>');

test('reports are well-formed XML', () => { wellFormed(full); wellFormed(plain); wellFormed(weird); });

test('uses the ConfigMgr shared data source for the site', () => {
  assert.ok(full.includes('<DataSourceReference>/ConfigMgr_LAB/{5C6358F2-4BB6-4a1b-A16E-8D96795D8602}</DataSourceReference>'));
});

test('RBAC: UserTokenSIDs -> UserSIDs -> fn_rbac_ functions, with the SrsResources module', () => {
  assert.ok(full.includes('=SrsResources.UserIdentity.GetUserSIDs(User!UserID)'));
  assert.ok(full.includes('fn_rbac_GetAdminIDsfromUserSIDs(@UserTokenSIDs)'));
  assert.ok(full.includes('<CodeModule>SrsResources, culture=neutral</CodeModule>'));
  assert.ok(full.indexOf('<ReportParameter Name="UserTokenSIDs">') < full.indexOf('<ReportParameter Name="UserSIDs">'), 'UserTokenSIDs must come first');
  assert.ok(full.includes('FROM fn_rbac_R_System(@UserSIDs) sys'));
});

test('collection picker: parameter, device-collection list, default All Systems', () => {
  assert.ok(full.includes('<ReportParameter Name="CollectionID">'));
  assert.ok(full.includes('FROM fn_rbac_Collection(@UserSIDs) WHERE CollectionType = 2'));
  assert.ok(full.includes('<Value>SMS00001</Value>'));
  assert.ok(full.includes('<QueryParameter Name="@CollectionID">'));
});

test('no collection filter: no CollectionID parameter or dataset', () => {
  assert.ok(!plain.includes('CollectionID'));
  assert.ok(plain.includes('<ReportParameter Name="UserSIDs">'), 'still RBAC');
});

test('one field, header and cell per column; field names are identifiers mapped to the SQL aliases', () => {
  assert.strictEqual(count(full, '<TablixColumn>'), 5);
  assert.ok(full.includes('<Field Name="RAM_KB"><DataField>RAM (KB)</DataField>'), 'RAM field');
  assert.ok(full.includes('AS [RAM (KB)]'));
  assert.ok(full.includes('<Value>=Fields!Last_Boot_Up_Time.Value</Value>'));
  assert.ok(full.includes('<Field Name="Last_Boot_Up_Time"><DataField>Last Boot Up Time</DataField><rd:TypeName>System.DateTime</rd:TypeName></Field>'));
});

test('special characters are escaped and field names stay valid', () => {
  assert.ok(weird.includes('<DataField>Name &lt;&amp;&gt; &quot;quoted&quot;</DataField>'));
  assert.ok(/<Field Name="F_123_start">/.test(weird), 'leading digit gets a prefix');
  assert.ok(weird.includes('A &amp; B: &lt;test&gt;'));
  assert.strictEqual(R.fileName('A & B: <test>'), 'A & B test.rdl');
});

test('headers sort and repeat on each page', () => {
  assert.strictEqual(count(full, '<UserSort>'), 5);
  assert.ok(full.includes('<RepeatOnNewPage>true</RepeatOnNewPage>'));
});

const readable = makeReport([C('v_R_System', 'Name0', 'Device'), C('v_GS_X86_PC_MEMORY', 'TotalPhysicalMemory0'),
  C('v_GS_BITLOCKER_DETAILS', 'ProtectionStatus0'), C('v_GS_SYSTEM_ENCLOSURE', 'ChassisTypes0')],
  { collection: true, readable: true, skipUnknown: true }, 'Readable');

test('readable values: converted columns get their new types and unit headers', () => {
  wellFormed(readable);
  assert.ok(readable.includes('<Field Name="Total_Physical_Memory_GB"><DataField>Total Physical Memory (GB)</DataField><rd:TypeName>System.Decimal</rd:TypeName></Field>'));
  assert.ok(readable.includes('<Field Name="Protection_Status"><DataField>Protection Status</DataField><rd:TypeName>System.String</rd:TypeName></Field>'));
  assert.ok(readable.includes("WHEN 1 THEN &apos;On&apos;") || readable.includes("WHEN 1 THEN 'On'"), 'CASE in the query');
  assert.ok(readable.includes('WHERE ISNULL(sys.Unknown0, 0) = 0'));
});

test('type mapping', () => {
  assert.strictEqual(R.netType('nvarchar(255)'), 'System.String');
  assert.strictEqual(R.netType('datetime'), 'System.DateTime');
  assert.strictEqual(R.netType('bigint'), 'System.Int64');
  assert.strictEqual(R.netType(undefined), 'System.String');
});

// Filters with "ask" become report parameters
const asked = (() => {
  const cols = [C('v_R_System', 'Name0', 'Device'), C('v_GS_OPERATING_SYSTEM', 'LastBootUpTime0')];
  const filters = [{ view: 'v_GS_COMPUTER_SYSTEM', column: 'Model0', op: 'contains', value: 'Latitude', ask: true },
    { view: 'v_GS_OPERATING_SYSTEM', column: 'LastBootUpTime0', op: 'olderdays', value: '30', ask: true },
    { view: 'v_GS_OPERATING_SYSTEM', column: 'InstallDate0', op: 'before', value: '', ask: true }];
  return makeReport(cols, { collection: true, filters }, 'Old boots');
})();
test('filter parameters: declared, defaulted, bound to the query and shown in the subtitle', () => {
  wellFormed(asked);
  assert.match(asked, /<ReportParameter Name="Model">\s*<DataType>String<\/DataType>\s*<DefaultValue><Values><Value>Latitude<\/Value><\/Values><\/DefaultValue>\s*<AllowBlank>true<\/AllowBlank>\s*<Prompt>Model<\/Prompt>/);
  assert.match(asked, /<ReportParameter Name="LastBootUpTimeDays">\s*<DataType>Integer<\/DataType>\s*<DefaultValue><Values><Value>30<\/Value>/);
  assert.match(asked, /<ReportParameter Name="InstallDate">\s*<DataType>DateTime<\/DataType>\s*<Nullable>true<\/Nullable>/);
  assert.match(asked, /<QueryParameter Name="@Model"><Value>=Parameters!Model\.Value<\/Value><\/QueryParameter>/);
  assert.match(asked, /<QueryParameter Name="@LastBootUpTimeDays"><Value>=Parameters!LastBootUpTimeDays\.Value<\/Value><\/QueryParameter>/);
  assert.match(asked, /&quot;Model: &quot; &amp; Parameters!Model\.Value/);
  assert.ok(asked.indexOf('<ReportParameter Name="CollectionID">') < asked.indexOf('<ReportParameter Name="Model">'), 'collection first');
});

if (WRITE) {
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  for (const [n, x] of Object.entries({ full, plain, weird, readable, asked })) fs.writeFileSync(path.join(ROOT, 'dist', `sample_${n}.rdl`), x);
  console.log('wrote dist/sample_*.rdl');
}
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
