# Working on Gladiator Ledger (instructions for Claude sessions)

Ledger is the owner's entry for the Relate hackathon (deadline **Dec 11, 2026, 6:00 PM PST**; target submission
Dec 10). It loads Gladiator's run records into a Relate graph and answers "which model for this workflow, under
this budget", with the matches behind the answer. The owner directs and approves; Claude does the hands-on work.
The owner prefers plain-English summaries.

## Rules
- **Ledger is new work, started 2026-11-21.** Gladiator (the engine, Apache-2.0, started Oct 21 2026) is disclosed
  earlier code. Never copy Gladiator code into Ledger without marking it as reused in the file header and in the
  disclosure statement. `ledger/scoring.py` is the one copied file so far.
- **Ledger reads Gladiator's output; it never runs matches.** Matches and their budgets live in the Gladiator repo
  (`CLAUDE.md` there). Ledger itself costs nothing to run, and judges need no API keys.
- **Never commit `operator.json`** (private simulator state) or anything from it. Only `record.json` and Gladiator's
  `validations/*.json` are inputs.
- **Relate is the store and the query engine, not an export target.** Questions are Cypher over the graph.
- **No made-up winners.** Thin evidence or a level head-to-head means no pick is named, the same as in Gladiator.
- The graph is a view: records stay the master copy, and the loader must stay safe to re-run.
- Match data for named commercial models gets committed (the shipped store) only once the owner approves publishing
  it.

## How work lands
- Feature branch, PR into `main`, CI green (lint and tests on Linux and Windows), squash merge.
- Fast checks before pushing:
```bash
uv run ruff check . && uv run ruff format --check . && uv run pytest -q
```
- Schema: `docs/SCHEMA.md`. Keep it in step with `ledger/load.py` and `ledger/questions.py`.
