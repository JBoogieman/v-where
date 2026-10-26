/* v_Where search
 *
 * Plain-word search over the schema export: which views and columns hold "last boot", "ram", "bitlocker".
 *
 *   prepare(data)          schema.json -> { header, objects, byName, colIndex } with search fields precomputed
 *   run(db, { q, fn })     -> { words, variants, all }: every matching view (and fn_rbac_ function when fn),
 *                            best first, each with the columns that matched
 *   alsoSearching(variants) the synonym searches added to what was typed, for the "Also searching" line
 *   highlight(text, hl)    HTML-escaped text with the matched words wrapped in <mark>
 *
 * Plain script, no dependencies. In the page it sets window.VWhereSearch; in Node, require() returns the
 * same object (tools/test_search.js uses that).
 */
(function (root) {
  'use strict';

  // ---------- Categories: first matching rule wins ----------
  const CATEGORIES = [
    ['Discovery',               /^v_(R|RA)_/i],
    ['Hardware inventory',      /^v_GS_/i],
    ['Inventory history',       /^v_HS_/i],
    ['Software updates',        /update/i],
    ['Collections',             /^v_(Collection|FullCollection|ClientCollection|CollectionRule)/i],
    ['Apps & deployments',      /^v_(Advertisement|ClientAdvertisement|Package|Program|Deployment|Application|App|CIAssignment|Content|DeploymentType)/i],
    ['OS deployment',           /^v_(TaskSequence|TaskExecution|BootImage|OSImage|ImagePackage|Driver|OSD|TS)/i],
    ['Compliance settings',     /^v_(CI|ConfigurationItem|Baseline|LocalizedCI)/i],
    ['Software inventory',      /^v_(Software|MeteredSoftware|MonthlyUsage|Add_Remove|SMS_Software|Product)/i],
    ['Client health & status',  /^v_(CH_|ClientHealth|ClientOperation|StateMessage|StatusMessage|Status|ClientDeploymentState|Client)/i],
    ['Site & infrastructure',   /^v_(Site|Boundary|DistributionPoint|SystemResourceList|SC_|Component|DP|Server)/i],
    ['Security & RBAC',         /^v_(Secured|Admin|Role|Scope|Security|RBAC)/i],
    ['Endpoint protection',     /^v_(EP|AM_|Malware|Threat|Defender)/i],
  ];
  const OTHER = 'Other';
  function categoryOf(name) {
    const n = name.startsWith('fn_rbac_') ? 'v_' + name.slice(8) : name;
    for (const [label, re] of CATEGORIES) if (re.test(n)) return label;
    return OTHER;
  }
  // Categories people usually report from get a small ranking nudge
  const CAT_WEIGHT = { 'Discovery': 12, 'Hardware inventory': 10, 'Software inventory': 8, 'Collections': 6, 'Software updates': 4, 'Apps & deployments': 4, 'Inventory history': -40 };

  // ---------- Synonyms: what people type -> what ConfigMgr calls it ----------
  // The typed words are always searched too; these add extra searches, ranked a little lower.
  // Keys can be up to 3 words. Values are plain words matched like a typed query.
  const SYNONYMS = {
    // Hardware and OS
    'bitlocker': ['encryptable volume', 'mbam'],
    'encryption': ['encryptable volume', 'bitlocker'],
    'ram': ['physical memory', 'memory'],
    'cpu': ['processor'],
    'cores': ['number of cores'],
    'hard drive': ['logical disk', 'disk'],
    'hard disk': ['logical disk', 'disk'],
    'hdd': ['logical disk', 'disk'],
    'ssd': ['disk', 'media type'],
    'disk space': ['free space'],
    'drive space': ['free space'],
    'os': ['operating system'],
    'windows version': ['operating system version', 'build number'],
    'windows build': ['build number'],
    'make': ['computer system manufacturer'],
    'vendor': ['computer system manufacturer', 'publisher'],
    'oem': ['computer system manufacturer'],
    'service tag': ['bios serial number', 'enclosure serial number'],
    'firmware': ['bios', 'uefi'],
    'uptime': ['last boot up time'],
    'last boot': ['last boot up time'],
    'last reboot': ['last boot up time'],
    'last restart': ['last boot up time'],
    'reboot': ['restart'],
    'laptop': ['chassis types', 'battery'],
    'form factor': ['chassis types'],
    'chassis': ['chassis types'],
    'vm': ['virtual machine'],
    'monitor': ['desktop monitor'],
    'screen': ['desktop monitor'],
    'hostname': ['netbios name', 'dns host name'],
    'computer name': ['netbios name'],
    'device name': ['netbios name'],
    'machine name': ['netbios name'],
    'pc name': ['netbios name'],
    // Users
    'username': ['user name'],
    'logged on user': ['current logon user', 'computer system user name'],
    'logged in user': ['current logon user', 'computer system user name'],
    'current user': ['current logon user', 'computer system user name'],
    'login': ['logon'],
    'sign in': ['logon'],
    'signin': ['logon'],
    'primary user': ['user machine relationship', 'users primary machines', 'top console user'],
    'main user': ['top console user', 'users primary machines'],
    'uda': ['user machine relationship'],
    'user device affinity': ['user machine relationship'],
    'email': ['mail'],
    'ad group': ['group name'],
    'security group': ['group name'],
    'organizational unit': ['ou name'],
    // Software and updates
    'programs': ['add remove programs'],
    'installed apps': ['add remove programs', 'installed software'],
    'installed programs': ['add remove programs', 'installed software'],
    'arp': ['add remove programs'],
    'patch': ['update'],
    'patches': ['update'],
    'patching': ['update'],
    'hotfix': ['hot fix', 'quick fix engineering'],
    'kb': ['article id', 'hot fix id'],
    'wsus': ['software update', 'update'],
    'o365': ['office365'],
    'm365': ['office365'],
    'activation': ['license status', 'software licensing'],
    'kms': ['software licensing'],
    // Client and site
    'heartbeat': ['last ddr'],
    'last seen': ['last active time', 'last ddr', 'last online'],
    'last contact': ['last active time', 'last policy request'],
    'last inventory': ['last hw scan', 'last hw'],
    'hinv': ['hw scan', 'workstation status'],
    'sinv': ['last software scan', 'software scan'],
    'client health': ['ch client summary'],
    'maintenance window': ['service window'],
    'mw': ['service window'],
    'dp': ['distribution point'],
    'mp': ['management point'],
    'ts': ['task sequence', 'task execution'],
    'osd': ['task sequence', 'boot image'],
    'dcm': ['configuration item', 'baseline'],
    'antivirus': ['antimalware', 'malware'],
    'av': ['antimalware'],
    'defender': ['antimalware', 'malware', 'endpoint protection'],
    'scep': ['antimalware', 'endpoint protection'],
    'virus': ['malware', 'threat'],
    'comanagement': ['co management'],
    'intune': ['co management', 'mdm'],
  };
  // Words that describe the search rather than the data ("sccm view for last logon")
  const STOP = new Set(['sccm', 'mecm', 'memcm', 'configmgr', 'view', 'views', 'table', 'tables', 'column', 'columns', 'sql',
    'the', 'a', 'an', 'of', 'for', 'in', 'on', 'where', 'which', 'what', 'is', 'are', 'find', 'show', 'me', 'with', 'and']);
  const SYNONYM_PENALTY = 12;
  // Views most reports start from: a small ranking nudge so SerialNumber0 in v_GS_PC_BIOS
  // beats the same column in v_GS_PHYSICAL_DISK.
  const POPULAR = new Set(['v_R_System', 'v_R_User', 'v_GS_COMPUTER_SYSTEM', 'v_GS_PC_BIOS', 'v_GS_SYSTEM_ENCLOSURE',
    'v_GS_OPERATING_SYSTEM', 'v_GS_PROCESSOR', 'v_GS_X86_PC_MEMORY', 'v_GS_LOGICAL_DISK', 'v_GS_DISK',
    'v_GS_NETWORK_ADAPTER_CONFIGURATION', 'v_GS_ADD_REMOVE_PROGRAMS', 'v_GS_ADD_REMOVE_PROGRAMS_64', 'v_Add_Remove_Programs',
    'v_GS_INSTALLED_SOFTWARE', 'v_GS_SYSTEM_CONSOLE_USAGE', 'v_GS_WORKSTATION_STATUS', 'v_GS_ENCRYPTABLE_VOLUME', 'v_GS_TPM',
    'v_GS_QUICK_FIX_ENGINEERING', 'v_RA_System_SystemOUName', 'v_RA_System_IPAddresses', 'v_RA_System_MACAddresses',
    'v_FullCollectionMembership', 'v_Collection', 'v_CH_ClientSummary', 'v_UpdateInfo', 'v_UpdateComplianceStatus',
    'v_Update_ComplianceStatusAll', 'v_ClientAdvertisementStatus', 'v_Advertisement', 'v_DeploymentSummary',
    'v_AppDeploymentSummary', 'v_TaskExecutionStatus', 'v_UsersPrimaryMachines', 'v_UserMachineRelationship',
    'v_CombinedDeviceResources']);
  const POPULAR_BOOST = 15;
  const MAX_VARIANTS = 16;

  // "Last_Logon_Timestamp0" -> " last logon timestamp0", "ADLastLogonTime" -> " ad last logon time"
  // Lets search tell a word-start match ("date" in InstallDate0) from a mid-word one ("date" in Update).
  const spaced = (s) => ' ' + s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();

  // ---------- Prepare the schema export for searching ----------
  function prepare(data) {
    const objects = data.objects.map(o => ({
      name: o.name,
      kind: o.kind,
      lname: o.name.toLowerCase(),
      nname: o.name.toLowerCase().replace(/_/g, ''),
      sname: spaced(o.name),
      columns: o.columns.map(c => ({ name: c[0], type: c[1], nullable: c[2], l: c[0].toLowerCase(), s: spaced(c[0]), n: c[0].toLowerCase().replace(/_/g, '') })),
      params: o.params || [],
      baseView: o.baseView || null,
      aliases: o.aliases || [],
      hinv: o.hinv || null,                         // hardware inventory class behind a v_GS_/v_HS_ view
      offColumns: new Set(o.offColumns || []),      // columns Default Client Settings doesn't collect
      rbacFn: null,
      cat: categoryOf(o.name),
    }));
    const byName = {};
    objects.forEach(o => byName[o.name] = o);
    objects.forEach(o => {
      const base = o.baseView && byName[o.baseView];
      if (!base) return;
      base.rbacFn = o.name;
      if (!o.hinv && base.hinv) { o.hinv = base.hinv; o.offColumns = base.offColumns; }   // fn_rbac_GS_X inherits from v_GS_X
    });
    // "Also known as" text searched like the name: synonyms, inventory display name, WMI class
    objects.forEach(o => {
      const aka = [...o.aliases, o.hinv && o.hinv.display, o.hinv && o.hinv.class].filter(Boolean);
      o.laka = aka.join(' ').toLowerCase();
      o.naka = o.laka.replace(/_/g, '');
      o.saka = aka.map(spaced).join('');
      o.laliases = o.aliases.map(a => a.toLowerCase());
    });
    // Column -> views that contain it (views only), for related-view hints
    const colIndex = {};
    objects.filter(o => o.kind === 'view').forEach(o => o.columns.forEach(c => (colIndex[c.name] ||= []).push(o.name)));
    return { header: data, objects, byName, colIndex };
  }

  // ---------- Queries ----------
  // Query -> words. Hyphens split words ("co-management"); underscores stay (view names).
  const tokenize = (q) => q.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);

  // Swap in synonyms (longest phrase first) to build alternative searches, then drop
  // filler words outside synonym phrases. The first variant is always what was typed.
  function expand(words) {
    let segs = [];
    for (let i = 0; i < words.length;) {
      let k = Math.min(3, words.length - i);
      for (; k > 0; k--) if (SYNONYMS[words.slice(i, i + k).join(' ')]) break;
      if (k) { const key = words.slice(i, i + k).join(' '); segs.push([key, ...SYNONYMS[key]]); i += k; }
      else { segs.push([words[i]]); i++; }
    }
    const kept = segs.filter(s => s.length > 1 || !STOP.has(s[0]));
    if (kept.length) segs = kept;
    let combos = [{ parts: [], via: [] }];
    for (const opts of segs) {
      const next = [];
      for (const c of combos) opts.forEach((opt, j) => next.push({ parts: c.parts.concat(opt), via: j ? c.via.concat(opt) : c.via }));
      combos = next.slice(0, MAX_VARIANTS);
    }
    return combos.map(c => makeQuery(c.parts.join(' ').split(' '), c.via.length ? c.via.join(' + ') : null));
  }

  // Each word also matches its singular ("updates" finds Update...).
  // Short words (ram, ddr) only match at a word start, so "ram" doesn't hit "Programs";
  // one- or two-letter words (av, mp, ip) must be a whole word, so "av" doesn't hit "Average".
  function makeQuery(words, via) {
    const terms = words.map(t => ({
      t, short: t.length <= 3,
      whole: t.length <= 2 ? new RegExp('(?:^| )' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[ 0-9])') : null,
      forms: (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) ? [t, t.slice(0, -1)] : [t],
    }));
    const joined = words.join('');
    return { terms, joined, jn: joined.replace(/_/g, ''), via, hl: [...new Set(terms.flatMap(x => x.forms))] };
  }
  const wordIn = (s, term) => term.whole ? term.whole.test(s) : term.forms.some(f => s.includes(' ' + f));
  const subIn = (s, term) => !term.short && term.forms.some(f => s.includes(f));
  // Strong enough to say "this column is about that word": a word-start hit, or a mid-word hit on a long word
  // ("hostname" in DNSHostName0). "boot" inside "Reboot" doesn't count.
  const LONG = 6;
  const coversIn = (c, term) => wordIn(c.s, term) || (term.t.length >= LONG && (subIn(c.l, term) || subIn(c.n, term)));

  function scoreObject(o, Q) {
    const { terms, joined, jn } = Q;
    let score = 0;
    const anyCols = new Set();                          // columns matching at least one term (for scoring)
    const nameHas = new Set();                          // terms the view name already covers
    let nameTermsWS = 0;
    // 1) Every term must appear somewhere: in the name (or aliases/inventory class) or in at least one column
    for (const term of terms) {
      const nameWS = wordIn(o.sname, term) || wordIn(o.saka, term);
      const nameSub = subIn(o.lname, term) || subIn(o.nname, term) || subIn(o.laka, term) || subIn(o.naka, term);
      let any = nameWS || nameSub;
      for (const c of o.columns) if (wordIn(c.s, term) || subIn(c.l, term) || subIn(c.n, term)) { anyCols.add(c.name); any = true; }
      if (!any) return null;
      if (nameWS) { nameTermsWS++; nameHas.add(term); }
      else if (nameSub) { score += 4; if (term.t.length >= LONG) nameHas.add(term); }   // mid-word name hit: weak
    }
    // Matched columns: the ones that cover every word the name doesn't. If none does, the words are
    // scattered across unrelated columns ("last" in one, "boot" in another): a weak, "unfocused" match.
    const needed = terms.filter(t => !nameHas.has(t));
    const hitCols = new Set();
    if (needed.length) {
      for (const c of o.columns) if (needed.every(t => coversIn(c, t))) hitCols.add(c.name);
    } else {
      for (const c of o.columns) if (terms.some(t => wordIn(c.s, t))) hitCols.add(c.name);   // name says it all: show related columns
    }
    const focused = !needed.length || hitCols.size > 0;
    if (!focused) for (const c of anyCols) hitCols.add(c);
    // 2) Name quality: all terms as words in the name beats a partial hit
    const phrase = ' ' + terms.map(x => x.t).join(' ');
    if (nameTermsWS === terms.length) score += 80 + (terms.length > 1 && (o.sname.includes(phrase) || o.saka.includes(phrase)) ? 40 : 0);
    else score += nameTermsWS * 15;
    // 3) Best single column: does one column hold the whole idea (or what the name leaves out:
    //    "operating system version" -> Version0 in v_GS_OPERATING_SYSTEM)?
    const colTerms = needed.length ? needed : terms;
    let bestCol = 0;
    for (const c of o.columns) {
      const joinedHit = jn.length > 3 && c.n.includes(jn);
      if (!anyCols.has(c.name) && !joinedHit) continue;
      let q = colTerms.every(t => wordIn(c.s, t)) ? 40 : colTerms.every(t => wordIn(c.s, t) || subIn(c.l, t) || subIn(c.n, t)) ? 15 : 4;
      if (terms.length > 1 && c.s.includes(phrase)) q += 25;                   // phrase, in order
      if (jn.length > 3) {
        if (c.n === jn || c.n === jn + '0') q += 60;                            // "installdate" == InstallDate0
        else if (terms.length > 1 && c.n.startsWith(jn)) q += 30;               // "last logon" -> LastLogonTimestamp0
        else if (joinedHit) q += 10;
        if (joinedHit && (focused || terms.length > 1)) hitCols.add(c.name);
      }
      if (q > bestCol) bestCol = q;
    }
    score += bestCol + Math.min(hitCols.size, 4) * 2;   // a few focused matching columns help; scattered ones don't
    if (joined.length > 2 && (o.lname === joined || o.lname === 'v_' + joined || o.laliases.includes(joined))) score += 1000;
    score += CAT_WEIGHT[o.cat] || 0;
    if (POPULAR.has(o.kind === 'function' ? o.baseView : o.name)) score += POPULAR_BOOST;
    if (o.kind === 'function') score -= 5;
    score -= o.name.length * 0.05;                      // gentle preference for shorter names
    return { o, score, hitCols, hl: Q.hl, via: Q.via, nameMatch: nameTermsWS === terms.length, focused };
  }

  // Best score across the typed query and its synonym variants. A focused match beats an unfocused one.
  function bestMatch(o, variants) {
    let best = null;
    for (const Q of variants) {
      const r = scoreObject(o, Q);
      if (!r) continue;
      if (Q.via) r.score -= SYNONYM_PENALTY;
      if (!best || (r.focused && !best.focused) || (r.focused === best.focused && r.score > best.score)) best = r;
    }
    if (best && best.via) { const typed = scoreObject(o, variants[0]); if (typed && typed.focused === best.focused) best.via = null; }   // also matched as typed
    return best;
  }

  function run(db, opts = {}) {
    const words = tokenize((opts.q || '').trim());
    const variants = words.length ? expand(words) : [];
    const pool = db.objects.filter(o => (opts.fn || o.kind === 'view'));
    let all;
    if (!words.length) {
      all = pool.map(o => ({ o, score: 0, hitCols: new Set(), hl: [], via: null })).sort((a, b) => a.o.name.localeCompare(b.o.name));
    } else {
      all = [];
      for (const o of pool) { const r = bestMatch(o, variants); if (r) all.push(r); }
      // Words scattered across unrelated columns only make the list when nothing better exists
      if (all.some(r => r.focused)) all = all.filter(r => r.focused);
      all.sort((a, b) => b.score - a.score || a.o.name.localeCompare(b.o.name));
    }
    return { words, variants, all };
  }

  const alsoSearching = (variants) => [...new Set(variants.filter(v => v.via).map(v => v.terms.map(x => x.t).join(' ')))];

  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Where words start in a name: "LastBootUpTime0" -> 0 (Last), 4 (Boot), 8 (Up), 10 (Time), 14 (0);
  // "DNSHostName" -> 0, 3 (Host), 7; "Last_Logon" -> 0, 5
  function wordStarts(text) {
    const s = new Set([0]);
    for (let i = 1; i < text.length; i++) {
      const p = text[i - 1], c = text[i], n = text[i + 1] || '';
      if (p === '_' || p === ' ' || p === '.' ||
          (/[a-z]/.test(p) && /[A-Z0-9]/.test(c)) || (/[0-9]/.test(p) && /[A-Za-z]/.test(c)) ||
          (/[A-Z]/.test(p) && /[A-Z]/.test(c) && /[a-z]/.test(n))) s.add(i);
    }
    return s;
  }
  // Marks matched words where they start a word in the name, so "up" lights up in LastBootUpTime0 but not in
  // GroupID. Long words (6+ letters) may also match mid-word ("hostname" in DNSHostName0) when there's no
  // word-start match.
  function highlight(text, hl) {
    if (!hl || !hl.length) return esc(text);
    const lower = String(text).toLowerCase(), starts = wordStarts(String(text));
    const marked = new Array(lower.length).fill(false);
    for (const t of [...hl].sort((a, b) => b.length - a.length)) {
      if (!t) continue;
      let found = false;
      for (const i of starts) if (lower.startsWith(t, i)) { for (let k = i; k < i + t.length; k++) marked[k] = true; found = true; }
      if (!found && t.length >= LONG) for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) for (let k = i; k < i + t.length; k++) marked[k] = true;
    }
    let out = '', open = false;
    for (let i = 0; i < lower.length; i++) {
      if (marked[i] && !open) { out += '<mark>'; open = true; }
      if (!marked[i] && open) { out += '</mark>'; open = false; }
      out += esc(String(text)[i]);
    }
    return out + (open ? '</mark>' : '');
  }

  const api = { CATEGORIES, OTHER, SYNONYMS, categoryOf, spaced, prepare, run, alsoSearching, highlight, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VWhereSearch = api;
})(this);
