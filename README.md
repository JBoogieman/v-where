# v_Where

**Where is that data in ConfigMgr?** v_Where is a searchable reference for Microsoft Configuration Manager (MECM/SCCM) SQL views. Type a word or phrase (e.g. `bitlocker`, `last logon`, `install date`) and see which views and columns hold it, so writing SSRS reports and SQL queries starts with an answer instead of a guess.

> **Status:** work in progress. Lab is built; the search page works against the lab export (841 views, 625 `fn_rbac_` functions).

**Live:** https://jboogieman.github.io/v-where/

## How it works

- **Extractor** ([`extractor/Export-VWhereSchema.ps1`](extractor/Export-VWhereSchema.ps1)): a PowerShell script that reads a ConfigMgr site database's *schema* (view and `fn_rbac_` function names, columns, data types) plus its hardware inventory class definitions, and writes them to JSON. Windows authentication, read-only, never reads device or user data. `-SchemaOnly` skips the class definitions.
- **Data** ([`data/schema.json`](data/schema.json)): the export from the lab site.
- **Search page** ([`web/index.html`](web/index.html)): one static HTML/JS file that searches that JSON. No server-side code, no database, no install.
- **Join planner** ([`web/joinplan.js`](web/joinplan.js)): turns a set of picked columns into one query. `v_R_System` sits in the middle; device views join on `ResourceID`/`MachineID`, and users, updates and collections join through a bridge view (`v_UsersPrimaryMachines`, `v_UpdateComplianceStatus`, `v_FullCollectionMembership`). Tests: `node tools/test_joinplan.js` (add `--show` to print the queries).

### Try it

From the repo root, serve the folder with any static web server and open `/web/`:

```sh
python3 -m http.server 8000
# then browse to http://localhost:8000/web/
```

Opening `web/index.html` straight from disk also works: browsers block it from loading the JSON on their own, so the page asks you to pick or drop a `schema.json`. To point it at a different export, add `?data=<url>`.

### Offline copy

Build one self-contained file with the schema baked in:

```sh
python3 tools/build_offline.py
# -> dist/v_where.html (about 1 MB)
```

Copy `dist/v_where.html` anywhere and double-click it. No server, network, or install needed. Rebuild after the page or the schema changes. Use `--schema` and `--out` to bake in a different export.

- Type words or a phrase (`last logon`, `install date`); results rank views whose names or columns match at word boundaries highest.
- Everyday words are translated into ConfigMgr's names: `ram` → physical memory, `uptime` → LastBootUpTime, `primary user` → user machine relationship, `kb` → ArticleID. The list lives in `SYNONYMS` at the top of the page's script.
- Hardware inventory views show the WMI class behind them, and flag classes and columns that Default Client Settings doesn't collect (the view exists but stays empty until you enable them).
- Category chips filter by area (Discovery, Hardware inventory, Software updates...).
- Each view links to its `fn_rbac_` twin for RBAC-filtered SSRS reports, and **Copy SELECT** builds a query from the columns you matched.
- **Report draft:** click **+** next to columns in any views, then open **Report draft**. v_Where writes the joins, warns when a view repeats devices (one row per drive, per adapter...) with a one-click fix, filters to one collection with `@CollectionID`, and can switch everything to `fn_rbac_` functions with `@UserSIDs` for SSRS. Rename columns to set report headers. The draft stays in your browser between visits.
- The URL updates as you search, so a link takes someone straight to the same result.

### Use your own site's schema

Run the extractor against your site to include your custom hardware inventory classes:

```powershell
.\Export-VWhereSchema.ps1 -SqlServer <sql-server> -Database CM_<sitecode> -OutFile .\schema.json
```

## Data policy

All schema data comes from a **lab** ConfigMgr site built for this project. No production data, hostnames, or organization-specific details belong in this repo.

## The lab

Built on a single Proxmox VE host:

| Machine | Role |
|---|---|
| DC01 | Windows Server 2025: AD DS, DNS, DHCP |
| CM01 | Windows Server 2025: SQL Server 2022 Developer + ConfigMgr current branch (evaluation) |
| WIN11-01 | Windows 11 Enterprise test client |
| vwhere-dev | Debian 13 container: development box |

Lab machines live on an isolated, NATed network segment. The full build, scripts, and every gotcha hit along the way are in [docs/lab-build.md](docs/lab-build.md).
