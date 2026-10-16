# v_Where

**Where is that data in ConfigMgr?** v_Where is a searchable reference for Microsoft Configuration Manager (MECM/SCCM) SQL views. Type a word or phrase (e.g. `bitlocker`, `last logon`, `install date`) and see which views and columns hold it, so writing SSRS reports and SQL queries starts with an answer instead of a guess.

> **Status:** work in progress. Lab is built; the app is next.

## How it works

- **Extractor** ([`extractor/Export-VWhereSchema.ps1`](extractor/Export-VWhereSchema.ps1)): a PowerShell script that reads a ConfigMgr site database's *schema* (view and `fn_rbac_` function names, columns, data types) and writes it to JSON. Windows authentication, read-only, never reads rows.
- **Data** ([`data/schema.json`](data/schema.json)): the export from the lab site.
- **Front end** (planned): one static HTML/JS page that searches that JSON. No server, no database, no install. Open it from a file share or any web server.

Run the extractor against your own site to include your custom hardware inventory classes:

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

## Contributing / working on this repo

Enable the repo's guardrail hooks after cloning:

```sh
git config core.hooksPath .githooks
```

The hooks block a commit if it contains secrets (via [gitleaks](https://github.com/gitleaks/gitleaks)), terms from a local private blocklist, or an author email that isn't a GitHub noreply address.
