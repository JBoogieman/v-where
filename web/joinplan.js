/* v_Where join planner
 *
 * Given the views a report needs, work out how to join them into one query.
 *
 * Most ConfigMgr reports are "one row per device". v_R_System is the device list,
 * so it sits in the middle (the hub) and every other view joins to it. Each view
 * is sorted by the key column it carries:
 *
 *   device key   ResourceID, MachineID, MachineResourceID   joins straight to the hub
 *   user key     ResourceID in user discovery views,        needs a bridge
 *                UserResourceID
 *   CI key       CI_ID only (updates, configuration items)  needs a bridge
 *   collection   CollectionID only                          needs a bridge
 *
 * A bridge is a view that holds a device key AND the other key, so it connects the
 * two. v_UsersPrimaryMachines has MachineID (device) and UserResourceID (user), so
 * it connects users to devices.
 *
 * The planner also warns when a view can return more than one row per device
 * (a device has several disks, drives, network adapters...), because joining it
 * repeats that device once per row.
 *
 * Plain script, no dependencies. In the page it sets window.VWhereJoin; in Node,
 * require() returns the same object (tools/test_joinplan.js uses that).
 */
(function (root) {
  'use strict';

  const HUB = 'v_R_System';
  const DEVICE_KEYS = ['ResourceID', 'MachineID', 'MachineResourceID'];

  // Discovery views where ResourceID means a user or group, not a device
  const USER_VIEW = /^v_(R_User|RA_User|R_UserGroup|RA_UserGroup|SMS_G_User_|UserAndGroupsDiscovered)/i;

  // Bridges: a view with a device key and another key. `device` and `other` are its column names.
  const BRIDGES = {
    user:       { view: 'v_UsersPrimaryMachines',      device: 'MachineID',  other: 'UserResourceID',
                  note: 'A device with more than one primary user shows once per user.' },
    update:     { view: 'v_UpdateComplianceStatus',    device: 'ResourceID', other: 'CI_ID',
                  note: 'One row per device per update.' },
    ci:         { view: 'v_CICurrentComplianceStatus', device: 'ResourceID', other: 'CI_ID',
                  note: 'One row per device per configuration item.' },
    collection: { view: 'v_FullCollectionMembership',  device: 'ResourceID', other: 'CollectionID',
                  note: 'One row per device per collection it belongs to. Use the collection filter to keep one.' },
  };

  // Views known to hold one row per device. Anything else gets a "more than one row" warning.
  // Kept short and conservative on purpose: a false warning costs a glance, a missing one costs a wrong report.
  const ONE_ROW = new Set([
    'v_R_System', 'v_GS_OPERATING_SYSTEM', 'v_GS_COMPUTER_SYSTEM', 'v_GS_COMPUTER_SYSTEM_PRODUCT', 'v_GS_PC_BIOS',
    'v_GS_X86_PC_MEMORY', 'v_GS_SYSTEM_CONSOLE_USAGE', 'v_GS_WORKSTATION_STATUS', 'v_GS_TPM', 'v_GS_FIRMWARE',
    'v_CH_ClientSummary',
  ]);

  // One row per user / update / collection. Joined through a bridge they add no repeats of their own
  // (the bridge's note already covers it), so they don't get a warning.
  const ONE_PER_KEY = new Set(['v_R_User', 'v_UpdateInfo', 'v_Collection']);

  // For common multi-row views: what to add to the join to keep one row per device
  const PICK_ONE = {
    v_GS_BITLOCKER_DETAILS:             ['DriveLetter0', "= 'C:'", 'one row per drive'],
    v_GS_ENCRYPTABLE_VOLUME:            ['DriveLetter0', "= 'C:'", 'one row per drive'],
    v_GS_LOGICAL_DISK:                  ['DeviceID0', "= 'C:'", 'one row per drive'],
    v_GS_DISK:                          ['Index0', '= 0', 'one row per physical disk'],
    v_GS_PROCESSOR:                     ['DeviceID0', "= 'CPU0'", 'one row per CPU socket'],
    v_GS_NETWORK_ADAPTER_CONFIGURATION: ['IPEnabled0', '= 1', 'one row per network adapter'],
  };

  // Readable values: raw inventory numbers and codes -> what someone reading a report expects.
  // Only units and codes that Windows/ConfigMgr fix in place. Disk sizes are left raw on purpose:
  // ConfigMgr has stored them in MB or GB depending on version, so a fixed conversion could be off by 1000x.
  //   size  divide and round, header gets the unit      flag   1 = Yes, anything else = No (NULL means no)
  //   code  value -> label, unknown values pass through yesno  1 = Yes, 0 = No, NULL stays blank (no data)
  const KB_TO_GB = { kind: 'size', div: 1048576, unit: 'GB', from: 'KB' };
  const ON_OFF = { kind: 'code', map: { 0: 'Off', 1: 'On', 2: 'Unknown' } };
  const COMPLIANCE = { kind: 'code', map: { 0: 'Unknown', 1: 'Not required', 2: 'Required', 3: 'Installed' } };
  const CHASSIS = { kind: 'code', map: {
    1: 'Other', 2: 'Unknown', 3: 'Desktop', 4: 'Low Profile Desktop', 5: 'Pizza Box', 6: 'Mini Tower', 7: 'Tower',
    8: 'Portable', 9: 'Laptop', 10: 'Notebook', 11: 'Hand Held', 12: 'Docking Station', 13: 'All in One',
    14: 'Sub Notebook', 15: 'Space-Saving', 16: 'Lunch Box', 17: 'Main System Chassis', 18: 'Expansion Chassis',
    19: 'SubChassis', 20: 'Bus Expansion Chassis', 21: 'Peripheral Chassis', 22: 'Storage Chassis',
    23: 'Rack Mount Chassis', 24: 'Sealed-Case PC', 25: 'Multi-system Chassis', 26: 'Compact PCI', 27: 'Advanced TCA',
    28: 'Blade', 29: 'Blade Enclosure', 30: 'Tablet', 31: 'Convertible', 32: 'Detachable', 33: 'IoT Gateway',
    34: 'Embedded PC', 35: 'Mini PC', 36: 'Stick PC' } };
  const FORMATS = {
    'v_GS_X86_PC_MEMORY.TotalPhysicalMemory0': KB_TO_GB,
    'v_GS_OPERATING_SYSTEM.TotalVisibleMemorySize0': KB_TO_GB,
    'v_GS_OPERATING_SYSTEM.FreePhysicalMemory0': KB_TO_GB,
    'v_GS_OPERATING_SYSTEM.TotalVirtualMemorySize0': KB_TO_GB,
    'v_GS_OPERATING_SYSTEM.FreeVirtualMemory0': KB_TO_GB,
    'v_GS_OPERATING_SYSTEM.ProductType0': { kind: 'code', map: { 1: 'Workstation', 2: 'Domain Controller', 3: 'Server' } },
    'v_GS_COMPUTER_SYSTEM.DomainRole0': { kind: 'code', map: { 0: 'Standalone Workstation', 1: 'Member Workstation',
      2: 'Standalone Server', 3: 'Member Server', 4: 'Backup Domain Controller', 5: 'Primary Domain Controller' } },
    'v_GS_SYSTEM_ENCLOSURE.ChassisTypes0': CHASSIS,
    'v_GS_BITLOCKER_DETAILS.ProtectionStatus0': ON_OFF,
    'v_GS_ENCRYPTABLE_VOLUME.ProtectionStatus0': ON_OFF,
    'v_UpdateComplianceStatus.Status': COMPLIANCE,
    'v_Update_ComplianceStatusAll.Status': COMPLIANCE,
    'v_CH_ClientSummary.ClientActiveStatus': { kind: 'code', map: { 0: 'Inactive', 1: 'Active' } },
    'v_R_System.Client0': { kind: 'flag' },
    'v_R_System.Active0': { kind: 'flag' },
    'v_R_System.Obsolete0': { kind: 'flag' },
    'v_R_System.Decommissioned0': { kind: 'flag' },
    'v_GS_FIRMWARE.UEFI0': { kind: 'yesno' },
    'v_GS_FIRMWARE.SecureBoot0': { kind: 'yesno' },
    'v_GS_TPM.IsActivated_InitialValue0': { kind: 'yesno' },
    'v_GS_TPM.IsEnabled_InitialValue0': { kind: 'yesno' },
    'v_GS_TPM.IsOwned_InitialValue0': { kind: 'yesno' },
  };
  const formatOf = (view, column) => FORMATS[`${view}.${column}`] || null;
  // Short note for the UI: what the readable version changes
  function describe(f) {
    if (!f) return '';
    if (f.kind === 'size') return `${f.from} → ${f.unit}`;
    if (f.kind === 'flag' || f.kind === 'yesno') return '1/0 → Yes/No';
    const m = Object.entries(f.map);
    return m.length <= 3 ? `${m.map(([k]) => k).join('/')} → ${m.map(([, v]) => v).join('/')}` : 'code → name';
  }
  const isText = (sqlType) => /char|text/i.test(sqlType || '');
  const lit = (v, text) => text ? `'${String(v).replace(/'/g, "''")}'` : String(v);
  // The SELECT expression for a column, readable or raw
  function selectExpr(ref, f, sqlType) {
    if (!f) return ref;
    if (f.kind === 'size') return `CAST(ROUND(${ref} / ${f.div}.0, 1) AS decimal(10,1))`;
    if (f.kind === 'flag') return `CASE WHEN ${ref} = 1 THEN 'Yes' ELSE 'No' END`;
    if (f.kind === 'yesno') return `CASE ${ref} WHEN 1 THEN 'Yes' WHEN 0 THEN 'No' END`;
    const text = isText(sqlType);
    const whens = Object.entries(f.map).map(([k, v]) => `WHEN ${lit(k, text)} THEN ${lit(v, true)}`).join(' ');
    return `CASE ${ref} ${whens} ELSE ${text ? ref : `CAST(${ref} AS varchar(20))`} END`;
  }

  // Short, readable table aliases for views people use a lot. Others get initials.
  const ALIAS = {
    v_R_System: 'sys', v_R_User: 'usr', v_GS_OPERATING_SYSTEM: 'os', v_GS_COMPUTER_SYSTEM: 'cs',
    v_GS_X86_PC_MEMORY: 'mem', v_GS_PC_BIOS: 'bios', v_GS_PROCESSOR: 'cpu', v_GS_LOGICAL_DISK: 'ld',
    v_GS_SYSTEM_ENCLOSURE: 'enc', v_GS_BITLOCKER_DETAILS: 'bl', v_GS_ENCRYPTABLE_VOLUME: 'ev',
    v_FullCollectionMembership: 'fcm', v_Collection: 'coll', v_UsersPrimaryMachines: 'upm',
    v_UpdateComplianceStatus: 'ucs', v_UpdateInfo: 'ui', v_CH_ClientSummary: 'ch',
    v_CICurrentComplianceStatus: 'cis', v_Add_Remove_Programs: 'arp', v_GS_ADD_REMOVE_PROGRAMS: 'arp',
  };
  // Aliases that would collide with SQL keywords
  const RESERVED = new Set(['as', 'at', 'by', 'if', 'in', 'is', 'of', 'on', 'or', 'to', 'add', 'all', 'and', 'any',
    'asc', 'end', 'for', 'key', 'not', 'set', 'top', 'use', 'desc', 'from', 'into', 'join', 'left', 'null', 'over', 'with']);

  // v_GS_SYSTEM_CONSOLE_USER -> "scu", v_RA_System_SystemOUName -> "ssou"
  function initials(name) {
    const core = name.replace(/^(v|fn_rbac)_((GS|HS|RA?)_)?/i, '');
    const words = core.split('_').flatMap(p => p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' '));
    const a = words.filter(Boolean).map(w => w[0]).join('').toLowerCase().slice(0, 4);
    return a || 't';
  }
  function makeAlias(name, used) {
    let base = ALIAS[name] || initials(name);
    if (RESERVED.has(base)) base += '_';
    let a = base, i = 2;
    while (used.has(a)) a = base + i++;
    used.add(a);
    return a;
  }

  // What keys does a view carry? `cols` is a Set of column names.
  function classify(name, cols) {
    const isUser = USER_VIEW.test(name);
    return {
      device: isUser ? null : DEVICE_KEYS.find(k => cols.has(k)) || null,
      user: isUser && cols.has('ResourceID') ? 'ResourceID' : cols.has('UserResourceID') ? 'UserResourceID' : null,
      ci: cols.has('CI_ID') ? 'CI_ID' : null,
      coll: cols.has('CollectionID') ? 'CollectionID' : null,
    };
  }

  /**
   * plan(viewNames, lookup, opts) -> join plan
   *   viewNames  views the report pulls columns from, in the order picked
   *   lookup     name -> { name, columns: [column names], rbacFn: 'fn_rbac_...' | null } or null
   *   opts.collection  true: keep only members of one collection (@CollectionID)
   *   opts.keepOne     views whose "keep one row per device" fix (PICK_ONE) goes into the join
   *   opts.skipUnknown leave out the Unknown Computer placeholder records (device reports)
   * lookup may also return types: { column: sqlType }, used for readable values (opts.readable in toSQL)
   * Returns { anchor, from, joins[], alias{}, warnings[], unplaced[] }
   *   from / joins[i]: { view, alias, type: 'JOIN' | 'LEFT JOIN', on, role: 'hub'|'filter'|'bridge'|'data' }
   */
  function plan(viewNames, lookup, opts = {}) {
    const names = [...new Set(viewNames)];
    const info = {};
    const unplaced = [];
    for (const n of names) {
      const v = lookup(n);
      if (!v) { unplaced.push({ view: n, why: 'Not in this schema.' }); continue; }
      const cols = new Set(v.columns);
      info[n] = { v, cols, keys: classify(n, cols) };
    }
    const known = names.filter(n => info[n]);

    // A user-only report (every view is user-keyed) is anchored on v_R_User instead of devices
    const userOnly = known.length && known.every(n => !info[n].keys.device && info[n].keys.user);
    const anchor = userOnly ? (known.find(n => n === 'v_R_User') || known[0]) : HUB;
    const anchorKey = 'ResourceID';

    const used = new Set();
    const alias = {};
    const joins = [];
    const warnings = [];
    const place = (view, type, on, role) => {
      alias[view] = alias[view] || makeAlias(view, used);
      const j = { view, alias: alias[view], type, on: on && on.replace(/\{(\w+)\}/g, (_, v) => alias[v] || v), role };
      joins.push(j);
      return j;
    };
    const has = (view) => joins.some(j => j.view === view);

    // 1) Hub
    alias[anchor] = makeAlias(anchor, used);
    const from = { view: anchor, alias: alias[anchor], type: 'FROM', on: null, role: 'hub' };
    const A = alias[anchor];

    // 2) Collection filter (device reports only)
    if (opts.collection && !userOnly) {
      place('v_FullCollectionMembership', 'JOIN', `{v_FullCollectionMembership}.ResourceID = ${A}.ResourceID AND {v_FullCollectionMembership}.CollectionID = @CollectionID`, 'filter');
    }

    // Add a bridge once, the first time something needs it
    const bridge = (kind) => {
      const b = BRIDGES[kind];
      if (!has(b.view)) {
        place(b.view, 'LEFT JOIN', `{${b.view}}.${b.device} = ${A}.ResourceID`, 'bridge');
        warnings.push({ view: b.view, text: `Added ${b.view} to connect the other views. ${b.note}` });
      }
      return b;
    };

    // 3) Views that join straight to the anchor. Do these first so a picked view can double as a bridge.
    const later = [];
    for (const n of known) {
      if (n === anchor) continue;
      const k = info[n].keys;
      const key = userOnly ? k.user : k.device;
      if (key) {
        if (has(n)) continue;   // e.g. v_FullCollectionMembership already placed as the filter
        place(n, 'LEFT JOIN', `{${n}}.${key} = ${A}.${anchorKey}`, 'data');
      } else later.push(n);
    }

    // 4) Views that need a bridge. Reuse a picked view that already carries both keys when there is one.
    const placedWith = (col) => joins.find(j => j.role !== 'hub' && info[j.view] && info[j.view].cols.has(col) && (info[j.view].keys.device || j.view === BRIDGES.collection.view));
    for (const n of later) {
      const k = info[n].keys;
      if (k.user) {
        const b = bridge('user');
        place(n, 'LEFT JOIN', `{${n}}.${k.user} = {${b.view}}.${b.other}`, 'data').viaBridge = b.view;
      } else if (k.ci) {
        const via = placedWith('CI_ID') || null;
        const viaView = via ? via.view : bridge(/update/i.test(n) ? 'update' : 'ci').view;
        place(n, 'LEFT JOIN', `{${n}}.CI_ID = {${viaView}}.CI_ID`, 'data').viaBridge = viaView;
      } else if (k.coll) {
        const viaView = has(BRIDGES.collection.view) ? BRIDGES.collection.view : bridge('collection').view;
        place(n, 'LEFT JOIN', `{${n}}.CollectionID = {${viaView}}.CollectionID`, 'data').viaBridge = viaView;
      } else {
        unplaced.push({ view: n, why: 'No key column that links it to devices (ResourceID, MachineID, CI_ID, CollectionID). Query it on its own.' });
      }
    }

    // 5) Row warnings for data views. opts.keepOne lists views whose suggested fix should be applied.
    const keep = new Set(opts.keepOne || []);
    for (const j of joins) {
      if (j.role !== 'data' || ONE_ROW.has(j.view) || (j.viaBridge && ONE_PER_KEY.has(j.view))) continue;
      const p = PICK_ONE[j.view];
      if (p && keep.has(j.view)) {
        j.on += ` AND ${j.alias}.${p[0]} ${p[1]}`;
        warnings.push({ view: j.view, text: `${j.view} has ${p[2]}; keeping ${p[0]} ${p[1]}.`, kept: true });
      } else {
        warnings.push(p
          ? { view: j.view, text: `${j.view} has ${p[2]}.`, fix: `AND ${j.alias}.${p[0]} ${p[1]}` }
          : { view: j.view, text: `${j.view} can return more than one row per device. Check the results for repeats.` });
      }
    }

    // 6) All Systems (and v_R_System) include two "Unknown Computer" placeholder records for OS deployment.
    //    opts.skipUnknown leaves them out of device reports.
    const where = [];
    if (opts.skipUnknown && anchor === HUB) where.push(`ISNULL(${A}.Unknown0, 0) = 0`);

    return { anchor, from, joins, alias, warnings, unplaced, where };
  }

  // "LastBootUpTime0" -> "Last Boot Up Time", "Name0" on v_R_System -> "Name"
  function label(col) {
    return col.replace(/0$/, '').replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  }
  // "v_GS_OPERATING_SYSTEM" -> "Operating System", "v_Collection" -> "Collection"
  function viewLabel(view) {
    return label(view.replace(/^(v|fn_rbac)_((GS|HS|RA?)_)?/i, ''))
      .split(' ').map(w => w === w.toUpperCase() && w.length > 3 ? w[0] + w.slice(1).toLowerCase() : w).join(' ');
  }

  /**
   * toSQL(plan, columns, lookup, opts) -> query text
   *   columns    [{ view, column, as? }] in display order
   *   opts.rbac  true: use fn_rbac_ functions with @UserSIDs (what SSRS reports should use)
   */
  /**
   * headers(plan, columns, opts) -> [{ view, column, name, format, outType }] : output columns, unique names.
   *   opts.readable  apply FORMATS (format is null otherwise). A size column's default name gets its unit.
   *   outType        the SQL type the column comes out as ('decimal', 'varchar', or null = unchanged)
   * toSQL uses the names as AS [...] aliases; the .rdl builder uses them as field names.
   */
  function headers(p, columns, opts = {}) {
    const seen = new Set();
    return columns.filter(c => p.alias[c.view]).map(c => {
      const format = opts.readable ? formatOf(c.view, c.column) : null;
      let as = (c.as || (label(c.column) + (format && format.kind === 'size' ? ` (${format.unit})` : ''))).replace(/[\[\]]/g, '');
      if (seen.has(as.toLowerCase())) as = `${viewLabel(c.view)} ${as}`;   // two "Name" columns -> "Operating System Name"
      let n = as, i = 2;
      while (seen.has(n.toLowerCase())) n = `${as} ${i++}`;
      seen.add(n.toLowerCase());
      const outType = !format ? null : format.kind === 'size' ? 'decimal' : 'varchar';
      return { view: c.view, column: c.column, name: n, format, outType };
    });
  }

  function toSQL(p, columns, lookup, opts = {}) {
    const src = (view) => {
      if (!opts.rbac) return view;
      const v = lookup(view);
      return v && v.rbacFn ? `${v.rbacFn}(@UserSIDs)` : view;
    };
    const typeOf = (view, col) => { const v = lookup(view); return v && v.types ? v.types[col] : null; };
    const sel = headers(p, columns, opts).map(h =>
      `${selectExpr(`${p.alias[h.view]}.${h.column}`, h.format, typeOf(h.view, h.column))} AS [${h.name}]`);
    const lines = ['SELECT', '  ' + (sel.length ? sel.join(',\n  ') : `${p.from.alias}.Name0`), `FROM ${src(p.from.view)} ${p.from.alias}`];
    for (const j of p.joins) {
      lines.push(`${j.type} ${src(j.view)} ${j.alias} ON ${j.on}`);
      const w = p.warnings.find(x => x.view === j.view && x.fix);
      if (w) lines.push(`  -- ${w.text} To keep one: ${w.fix}`);
    }
    if (p.where && p.where.length) lines.push(`WHERE ${p.where.join(' AND ')}   -- skip Unknown Computer placeholders`);
    if (opts.rbac) {
      const plain = [p.from, ...p.joins].filter(j => !(lookup(j.view) || {}).rbacFn).map(j => j.view);
      if (plain.length) lines.push(`-- no fn_rbac_ version (not permission-filtered): ${plain.join(', ')}`);
    }
    if (p.unplaced.length) lines.push(`-- left out: ${p.unplaced.map(u => u.view).join(', ')}`);
    return lines.join('\n');
  }

  const api = { plan, toSQL, headers, label, classify, formatOf, describe, HUB, BRIDGES, ONE_ROW, PICK_ONE, FORMATS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VWhereJoin = api;
})(this);
