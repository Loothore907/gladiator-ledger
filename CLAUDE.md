# Working on Gladiator Ledger (instructions for Claude sessions)

Ledger is the owner's entry for the Relate hackathon (deadline **Dec 11, 2026, 6:00 PM PST**; target submission
Dec 10). It loads Gladiator's run records into a Relate graph and answers "which model for this workflow, under
this budget", with the matches behind the answer. The owner directs and approves; Claude does the hands-on work.
The owner prefers plain-English summaries.

## Standing permissions (owner, 2026-11-21)
Same as the Gladiator repo: Claude may open PRs into `main` from a feature branch and **merge its own PRs once CI
is green** on the current head (squash merge), without asking. Fix red CI first; never skip or disable a test to
get green. Ask first before merging a PR Claude did not open, or changing repo settings or secrets.

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
- **Publishing approved (owner, 2026-11-22):** real match results and costs for named models are committed in
  `data/` (the shipped store). Add records only with `ledger import` (copies sealed `record.json` and validation
  records, never `operator.json`), then rebuild `data/ledger.rl` with `ledger build`; `tests/test_shipped_store.py`
  fails if the store and the records disagree.

## How work lands
- Feature branch, PR into `main`, CI green (lint and tests on Linux and Windows), squash merge.
- Fast checks before pushing:
```bash
uv run ruff check . && uv run ruff format --check . && uv run pytest -q
```
- Schema: `docs/SCHEMA.md`. Keep it in step with `ledger/load.py` and `ledger/questions.py`.
