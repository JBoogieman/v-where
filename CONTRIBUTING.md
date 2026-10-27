# Contributing to v_Where

Thanks for helping. v_Where is small on purpose: a static page, a few plain JavaScript modules, a schema exporter (T-SQL or PowerShell) and tests. No frameworks, no build step, nothing to install.

## Ways to help

- **Report a search miss.** Searched for something and the right view didn't come up, or came up low? Open a [Search didn't find it](https://github.com/JBoogieman/v-where/issues/new?template=search-miss.yml) issue. These are the most useful reports: each one can become a synonym and a test.
- **Report a bug** in the page, the SQL or a downloaded report: [Bug](https://github.com/JBoogieman/v-where/issues/new?template=bug.yml).
- **Suggest an idea:** [Idea](https://github.com/JBoogieman/v-where/issues/new?template=idea.yml). Describe the report you were trying to build, not just the feature.
- **Send a change** as a pull request (below).

## No production data

Everything in this repo comes from a lab ConfigMgr site. Don't put real device names, hostnames, usernames, IP addresses, custom inventory class names or anything that identifies an organization into code, issues, screenshots or schema exports. Swap them for placeholders.

## Run it locally

From the repo root:

```
python3 -m http.server 8000
```

Then browse to `http://localhost:8000/web/`. Edit, save, refresh.

You'll need Node.js (any current LTS) for the tests and Python 3 for the offline build.

## Tests

```
node tools/test_search.js
node tools/test_joinplan.js      # add --show to print each generated query
node tools/test_rdl.js
node tools/test_sqlexplain.js
python3 tools/test_schema_tools.py   # the offline build and compare tool, including sqlcmd-style files
```

They also run on every push and pull request, and the site only deploys when they pass. A change in behavior comes with a test.

## Where things live

| To change | Edit | Tested by |
| --- | --- | --- |
| What everyday words mean (`ram` → physical memory) | `SYNONYMS` in `web/search.js` | `tools/test_search.js` |
| How results are ranked | `scoreObject()` in `web/search.js` | `tools/test_search.js` |
| Column descriptions | `BY_VIEW` and `ANY` in `web/columns.js` | `tools/test_search.js` checks every described column exists |
| How views are joined, link tables, one-row views | `BRIDGES`, `ONE_ROW`, `PICK_ONE` in `web/joinplan.js` | `tools/test_joinplan.js` |
| Readable values | `FORMATS` in `web/joinplan.js` | `tools/test_joinplan.js` |
| Filters and report parameters | `OPS` and `filterCond()` in `web/joinplan.js` | `tools/test_joinplan.js`, `tools/test_rdl.js` |
| Explain SQL (checks, SSRS and plain conversion) | `web/sqlexplain.js` | `tools/test_sqlexplain.js` |
| The `.rdl` report | `web/rdl.js` | `tools/test_rdl.js` |
| The schema export | `extractor/Export-VWhereSchema.sql` and `.ps1` | `lab/cm01/check-sql-export.ps1` on a site server: runs both and compares them |
| The page, help text and hover tips | `web/index.html` | Open the page and try it |

[How the connections work](docs/how-connections-work.md) explains the join planner in detail.

## Pull requests

- One change per pull request. Say what changed and why.
- Run the tests, and update the docs and `CHANGELOG.md` (under Unreleased) if anything people see changed.
- Keep it dependency-free: plain JavaScript, no packages, no build step.
- Column descriptions say what a column means in plain words, and only what's certain. Where units or codes vary between versions, say so instead of guessing.

## License

By contributing, you agree your contribution is licensed under the [MIT license](LICENSE).
