# Disclosure statement

## What was built during the contest
Gladiator Ledger was started on **2026-11-21**, after the contest opened on Nov 11. Everything in this repository
was written during the contest period: the loader, the graph schema, the Cypher questions, the `recommend`, `ask`,
`build` and `import` commands, the tests, the documentation, and the shipped store with its data.

## Earlier work this project uses
**[Gladiator](https://github.com/Loothore907/gladiator-core)**, the author's head-to-head AI model evaluation engine
(Apache-2.0), started on 2026-10-21, before the contest. Its code was published on 2026-11-22 as a new repository
with a fresh history; the earlier development history, and the commit ids cited below, are in the author's private
repository. Ledger does not include or run the engine. It reads the engine's output files:

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
- a fix to the engine's workflow tools (the check tool's missing argument, above), found while preparing this
  entry, and a fix so each record names the engine's own commit.

## The data
`data/` holds 25 sealed public match records (12 models: Anthropic, OpenAI and Google models through their APIs,
and open-weights models through OpenRouter) and 20 validation records. The matches were played on Nov 22, 2026 and
cost $12.72 in API usage in total (the sum of the records' own cost figures), paid from the author's provider
accounts and plan credits. Each record includes its exact model ids, prices and costs, and the commit of the public Gladiator engine
that played it. Each match's private half (`operator.json`, the answer key of its generated worlds) is published
beside the record now that the match is over; `ledger verify` checks it against the fingerprint in the record.

**Data replaced on 2026-11-22.** The store first shipped with 60 matches played on Nov 20 to 22 ($51.49). A bug in
the Gladiator engine was then found: the tool a model uses to check an action after a timeout was offered without
a way to say which request to check, so models that checked were graded as retrying blindly and pass rates came
out far too low. The bug was fixed
([gladiator-core#2](https://github.com/Loothore907/gladiator-core/pull/2)), the small-tier and mid-tier matches
were played again on the fixed engine, and only those matches are shipped. The earlier frontier-model matches were
not re-run and are no longer included.

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
