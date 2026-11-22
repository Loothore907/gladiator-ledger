# Disclosure statement

## What was built during the contest
Gladiator Ledger was started on **2026-11-21**, after the contest opened on Nov 11. Everything in this repository
was written during the contest period: the loader, the graph schema, the Cypher questions, the `recommend`, `ask`,
`build` and `import` commands, the tests, the documentation, and the shipped store with its data.

## Earlier work this project uses
**Gladiator**, the author's head-to-head AI model evaluation engine (Apache-2.0), started on 2026-10-21, before the
contest. Ledger does not include or run the engine. It reads the engine's output files:

- **Run records** (`record.json`): sealed, versioned results of matches between two models.
- **Validation records**: sealed evidence that each test version passed automatic validation.

**Copied code.** One small piece of Gladiator code is copied into Ledger and marked in its file header:
`ledger/scoring.py`, the per-pair judging rule (from Gladiator's `scorers/efficiency.py` and `scorers/outcome.py`,
commit `c3dac6f`). It is copied so Ledger judges every pair exactly as Gladiator does. Everything else in Ledger is
new.

**Gladiator changes made during the contest** (in the Gladiator repository, for Ledger's data):
- validation records (`gladiator validate --write`), so test trust can be loaded into the graph;
- a mid-tier test suite (`suites/mid_tier.yaml`);
- calibration matches run for the data: small-tier, mid-tier and open-weights round-robins with fill-in repeats,
  direct link matches, and replacing one open-weights model that the API provider rate-limited.

## The data
`data/` holds 60 sealed public match records (18 models: Anthropic, OpenAI and Google models through their APIs,
and open-weights models through OpenRouter) and 20 validation records. The matches were played between Nov 20 and
Nov 22, 2026 and cost $51.49 in API usage in total (the sum of the records' own cost figures), paid from the
author's provider accounts and plan credits. Each record includes its exact model ids,
prices and costs. Gladiator's private simulator records (`operator.json`) are never included.

## Relate capabilities used
- **Embedded Python library** `relate-db` 1.2.0, imported as `relate`, with no server.
- **Single-file store** (`data/ledger.rl`), opened read-only for every question.
- **Schema:** uniqueness constraints on every node key (`CREATE CONSTRAINT ... IF NOT EXISTS`).
- **Writes:** `UNWIND` batch loads with `MERGE` on stable keys (safe re-loading), `SET +=` property maps, and
  `FOREACH` with `CASE` for conditional relationships.
- **Reads:** multi-hop `MATCH` patterns, `OPTIONAL MATCH`, aggregation (`count`, `sum`, `avg`, `collect`),
  `EXISTS { MATCH ... }` subqueries, list construction and indexing, and parameters on every query.
- **Python API:** `relate.connect`, the cursor `stats` counters (used in tests to prove re-loading creates nothing),
  and dict-style result rows.

## Third-party tools
- Python 3.12+, [uv](https://github.com/astral-sh/uv) (environment and lock file), pytest, ruff.
- GitHub Actions for CI (Linux and Windows).
- The match data was produced by calling commercial and open-weights model APIs (Anthropic, OpenAI, Google, and
  OpenRouter) from the Gladiator engine.

## AI tools
The code, tests and documentation in this repository were written by **Claude** (Anthropic), working as a coding
agent under the author's direction. The author set the goals and made the product, budget and publishing decisions.
Claude ran the calibration matches within budgets the author set, and the author reviewed the results.
