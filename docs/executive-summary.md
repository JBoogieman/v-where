# v_Where: Executive Summary

*Status as of October 2026 · Work in progress · MIT license*

## The problem

Microsoft Configuration Manager (MECM/SCCM) stores everything it knows about devices in **841 SQL views and 22,457 columns**. The names don't say what they hold. Writing a report starts with hunting for which view has the data, how to join it, and whether it's even collected. Built-in reports answer narrow questions; custom reports need SQL most admins don't have time to learn.

## What v_Where is

A free, open-source reference and report starter for ConfigMgr's SQL views:

1. **Search** in plain words (`ram`, `last logon`, `bitlocker`) and see which views and columns hold it.
2. **Click +** on the columns you want, from any views. v_Where connects the views for you and explains each connection in plain English.
3. **Download a ConfigMgr-ready SSRS report** (.rdl) that respects console permissions, or copy the SQL.

It runs as a static web page or a single offline HTML file. No server, no database connection, no install. It never touches device or user data.

## How it works

```mermaid
flowchart LR
    A[ConfigMgr site database] -->|read-only schema export| B[Extractor<br/>PowerShell]
    B --> C[schema.json<br/>names, columns, types,<br/>inventory classes]
    C --> D[Search page<br/>HTML + JavaScript]
    D --> E[Join planner]
    E --> F[SQL query]
    E --> G[SSRS report .rdl]
```

| Component | What it does | Size |
| --- | --- | --- |
| Extractor (`extractor/`) | Reads view and function names, columns, types and hardware inventory class definitions. Schema only: never reads device or user data. | ~230 lines PowerShell |
| Schema data (`data/`) | Export from the lab site: 841 views, 625 permission-filtered `fn_rbac_` functions, 311 inventory views (140 not collected by default) | ~1 MB JSON |
| Search page (`web/index.html`) | Plain-word synonyms, ranked results, category filters, "not collected by default" flags, links to `fn_rbac_` versions, shareable links, hover help and a How it works panel | ~1,100 lines |
| Join planner (`web/joinplan.js`) | Builds one query around the device list, adds link tables for users, updates and collections, warns when a view repeats devices, converts codes and units to readable values, and explains each connection in plain English | ~400 lines, 32 tests |
| Report builder (`web/rdl.js`) | Turns a draft into an RDL 2008/01 report: shared data source, permission parameters, collection picker, sortable table | ~225 lines, 10 tests |
| Delivery | GitHub Pages site and a single-file offline build (`tools/build_offline.py`) | ~1 MB HTML |

More detail: [How the connections work](how-connections-work.md) · [User guide](user-guide.md) · [Lab build](lab-build.md)

## Where it stands

| Area | Status |
| --- | --- |
| Lab | Built: Proxmox host, domain controller, ConfigMgr current branch on SQL Server 2022, Windows 11 client |
| Search | Working against the lab export |
| Join planner | Working; unit tested |
| .rdl output | Working; checked against Microsoft's RDL schema |
| In-page help | Hover explanations, How it works panel, plain-English connections in the Report draft |
| Hosting | Live on GitHub Pages; offline build available |

**Data policy:** all schema data comes from a lab site. No production data, hostnames or organization details are in the repo.

## Known limits

- **Search noise.** Multi-word synonyms can highlight loosely related columns.
- **No column descriptions.** Results show names and types, not what a column means.
- **History views** (`v_HS_`) appear alongside current views (`v_GS_`) without guidance on which to use.
- **Join planner shape.** It joins everything around the device list and can't follow longer chains (deployment to assignment to collection). It infers keys from column names because ConfigMgr views declare no relationships.
- **Locked-down PowerShell.** The extractor uses .NET SQL classes, which Constrained Language Mode blocks; those environments need a signed copy or another export path.
- **One schema.** The bundled data reflects one lab site and version. Custom inventory classes need your own export.

## Roadmap

Work is tracked as [milestones](https://github.com/JBoogieman/v-where/milestones) and [issues](https://github.com/JBoogieman/v-where/issues):

| Phase | Goal |
| --- | --- |
| 1. Explain the page | Hover help, How it works panel, plain-English connections |
| 2. Docs and README | A README that leads with the tool, a user guide, how the connections work, this summary |
| 3. Search quality | Exact matches first, less synonym noise, history views labeled, column descriptions, phone layout |
| 4. Project hygiene | Tests on every push, tagged releases with a changelog, issue templates and contributing notes |
| 5. Reach | Export that works in locked-down PowerShell, longer join chains, feedback from other ConfigMgr admins |

---

*v_Where is an independent project and is not affiliated with or endorsed by Microsoft.*
