# v_Where

**Where is that data in ConfigMgr?** v_Where is a searchable reference for Microsoft Configuration Manager (MECM/SCCM) SQL views. Type a word or phrase (e.g. `bitlocker`, `last logon`, `install date`) and see which views and columns hold it, so writing SSRS reports and SQL queries starts with an answer instead of a guess.

> **Status:** work in progress. Lab is built; the app is next.

## How it works (planned)

- **Front end:** one static HTML/JS page. No server, no database, no install. Open it from a file share or any web server.
- **Data:** a JSON file describing ConfigMgr views and their columns.
- **Builder:** a Python script that reads a ConfigMgr site database and generates that JSON.

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

Lab machines live on an isolated, NATed network segment.

## Contributing / working on this repo

Enable the repo's guardrail hooks after cloning:

```sh
git config core.hooksPath .githooks
```

The hooks block a commit if it contains secrets (via [gitleaks](https://github.com/gitleaks/gitleaks)), terms from a local private blocklist, or an author email that isn't a GitHub noreply address.
