# Working on Gladiator Ledger (instructions for Claude sessions)

Ledger is the owner's entry for the Relate hackathon (deadline **Dec 11, 2026, 6:00 PM PST**; target submission
Dec 10). It loads Gladiator's run records into a Relate graph and answers "of these two models, which does this
task better, how sure is that, and what should I build", with the matches behind the answer. It makes task claims,
never general rankings. The same loop (flows, opponents, verdict, spec) runs from the command line, a static
browser page (`site/`) and an MCP server (`ledger mcp`). The owner directs and approves; Claude does the hands-on work.
The owner prefers plain-English summaries.

## Standing permissions (owner, 2026-11-21)
Same as the Gladiator repo: Claude may open PRs into `main` from a feature branch and **merge its own PRs once CI
is green** on the current head (squash merge), without asking. Fix red CI first; never skip or disable a test to
get green. Ask first before merging a PR Claude did not open, or changing repo settings or secrets.

## Rules
- **Ledger is new work, started 2026-11-21.** Gladiator (the engine, Apache-2.0) is disclosed separate work: the
  idea dates from October 2026, its first code was committed on 2026-11-18 (owner, 2026-11-22; never write that
  Gladiator code predates the contest, which opened Nov 11), and the engine Ledger's data uses was built Nov 20-22. Never copy Gladiator code into Ledger without marking it as reused in the file header and in the
  disclosure statement. `ledger/scoring.py` is the one copied file so far.
- **Ledger reads Gladiator's output and never runs a match itself.** It may *request* one from a Gladiator runner
  (owner, 2026-11-23, for the live demo): the runner is Gladiator's, holds the keys and enforces the caps; Ledger
  shows the race and files the sealed record it gets back. Live runs are open to the hackathon judges only for now
  (signed in once: the page's "Judge sign-in" button and an access code, or an invitation link that carries it;
  owner, 2026-11-24: nobody should have to build an address by hand. No code per run, and no run button for
  anyone else) and the public page says so ("coming soon" for everyone else). A live result is labelled live
  and kept apart from the recorded evidence that public verdicts rest on. Budgets live in the operations repo
  (`CLAUDE.md` there). The public page still costs nothing to use and needs no API keys.
- **Private halves (owner, 2026-11-22):** a match's `operator.json` (the answer key of its generated worlds) is
  published beside its record once the match is over, so anyone can re-grade it. Only for tests that generate a
  fresh world per attempt (`instances: generator`), only through `ledger import` (which checks it against the
  fingerprint in the record), and **never for a holdout or fixed test**. The graph is still built from `record.json`
  and Gladiator's `validations/*.json` only.
- **A record informs a choice; it never limits one (owner, 2026-11-24).** Any model the platform can run can be
  chosen, with or without a history, and the page shows whatever record exists. The only limit is availability
  (the runner has the model's key and price). There is one place to choose the two models, and the verdict, the
  graph and the live race are all about that pair. Honesty comes from the same world, settings and judge for
  both, and from saying how much evidence there is. The hosted live list stays to small models for the demo and
  grows as capability does.
- **Published scores only pick opponents.** The `epoch` bridge loads Epoch AI's Capabilities Index (CC BY 4.0,
  credited in `data/epoch/README.md`). Never rank or recommend by a published score, and join an Epoch name to a
  Gladiator model id only when it is an exact match (`MODEL_IDS` in `ledger/bridges/epoch.py`).
- **Relate is the store and the query engine, not an export target.** Questions are Cypher over the graph.
- **No made-up winners.** Thin evidence or a level head-to-head means no pick is named, the same as in Gladiator.
- The graph is a view: records stay the master copy, and the loader must stay safe to re-run.
- **Publishing approved (owner, 2026-11-22):** real match results and costs for named models are committed in
  `data/` (the shipped store). Add records only with `ledger import` (copies sealed records, their private halves
  under the rule above, and validation records), then rebuild `data/ledger.rl` with `ledger build`; `tests/test_shipped_store.py`
  fails if the store and the records disagree.

## How work lands
- Feature branch, PR into `main`, CI green (lint and tests on Linux and Windows), squash merge.
- Fast checks before pushing:
```bash
uv run ruff check . && uv run ruff format --check . && uv run pytest -q
```
- Schema: `docs/SCHEMA.md`. Keep it in step with `ledger/load.py` and `ledger/questions.py`.
