# Changelog

What changed in each version of v_Where. Newest first. Version numbers follow [semantic versioning](https://semver.org/).

## Unreleased

Nothing yet.

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
