# Changelog

What changed in each version of v_Where. Newest first. Version numbers follow [semantic versioning](https://semver.org/).

## Unreleased

- **Filters and report parameters.** Filter on any column: text (contains, starts with, is...), numbers, dates (more than N days ago, in the last N days, before, on or after), yes/no, blank. Use the funnel next to any column, or the filter picker in Report draft. Tick **Ask** and the downloaded .rdl asks for the value when it runs, with yours as the default; the query lists `DECLARE` lines for SSMS. A filter on a view that isn't in the report uses `EXISTS`, so it narrows the devices without repeating any. Values are quoted safely, and a bad number or date is left out with a reason.
- **Explain SQL.** Paste any ConfigMgr query and get each view and column explained, checks for rows that multiply, history views, columns that don't exist, views not collected by default, unfiltered obsolete records, plain views in an SSRS report and `SELECT *`, plus the query converted to its SSRS (`fn_rbac_`) or plain version. Only view names change; the rest stays as pasted. Runs in the browser; nothing is sent or saved.
- **Duplicate-row guardrails.** When two tables in a report each repeat a device (drives and installed programs, say), their rows multiply: 3 × 150 = 450 rows for one device. The Report draft now says so in red right under the columns, with the fixes that apply; the Report draft button's count turns red; adding the column that causes it shows a heads-up; and the query starts with a warning comment.
- **Skip stale records** (on by default, replaces "Skip Unknown Computer rows"): also leaves out obsolete and decommissioned records, so a reinstalled device shows once.
- Colors: buttons and selected chips are readable in dark mode (dark text on the light blue), and the light-mode blue is a shade darker so links pass contrast checks on highlighted rows.
- Schema export in plain T-SQL (`extractor/Export-VWhereSchema.sql`), run with sqlcmd. No PowerShell, so it works where PowerShell is locked down to Constrained Language Mode.
- `tools/compare_schema.py`: compare two schema exports, for example your site against the bundled lab schema, or two ConfigMgr versions.
- The page, the offline build and the compare tool read schema files the way sqlcmd writes them: a byte order mark, and a line break every 2,000 or so characters.
- `lab/cm01/check-sql-export.ps1`: runs the T-SQL and PowerShell exports on a site server and compares them. On the lab site they match exactly.
- Tests for the offline build and compare tool (`tools/test_schema_tools.py`), run with the others on every push.

## 0.1.0 (2026-10-25)

First tagged version.

### Search

- Search 841 views, 625 permission-filtered `fn_rbac_` functions and 22,457 columns from a ConfigMgr current branch lab site.
- Everyday words are translated into ConfigMgr's names: `ram`, `uptime`, `kb`, `primary user`, `bitlocker`.
- A view's matched columns are the ones that hold the whole search, listed first and highlighted by whole word.
- Category filters, shareable links and keyboard shortcuts.
- Flags for hardware inventory classes and columns that aren't collected by default, and a history tag on `v_HS_` views.
- Plain-English descriptions for about 160 of the most-used columns.

### Reports

- Report draft: pick columns from any views. v_Where joins them one row per device and explains each join in plain English.
- Link tables for users, updates, configuration items and collections. Warnings, and one-click "keep one row" fixes, for views with several rows per device.
- Readable values: memory in GB, status codes as words, 1/0 as Yes/No.
- Copy the SQL, or download a ConfigMgr-ready SSRS report (`.rdl`) with permission filtering and a collection picker.

### Help and docs

- Hover help on the page, a How it works panel and first-visit steps.
- README, user guide, how the connections work, executive summary.
- Contributing notes, plus issue and pull request templates.

### Running it

- Hosted on GitHub Pages, or as a single offline HTML file (`tools/build_offline.py`).
- A PowerShell exporter for your own site's schema (`extractor/`).
- Works on a phone.
- 72 tests (search, join planner, `.rdl`) run on every push and pull request; the site only deploys if they pass.
