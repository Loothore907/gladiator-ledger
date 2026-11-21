# Disclosure statement (draft)

> Draft for the hackathon submission. To be finalised before Dec 10, 2026.

## What was built during the contest
Gladiator Ledger was started on **2026-11-21**, after the contest opened (Nov 11). Everything in this
repository was written during the contest period: the loader, the graph schema, the Cypher questions, the
`recommend` command, the tests, the documentation and the shipped store.

## Earlier work this project uses
**Gladiator**, the owner's head-to-head AI model evaluation engine (Apache-2.0), started on 2026-10-21, before
the contest. Ledger does not include or run the engine. It reads the engine's output files:

- **Run records** (`record.json`): sealed, versioned results of matches between two models.
- **Validation records**: sealed evidence that each test version passed automatic validation.

One small piece of Gladiator code is copied into Ledger and marked in its file header: `ledger/scoring.py`, the
per-pair judging rule (from Gladiator's `scorers/efficiency.py` and `scorers/outcome.py`, commit `c3dac6f`). It
is copied so Ledger judges every pair exactly as Gladiator does.

Two small additions were made to Gladiator during the contest so Ledger has the data it needs: validation
records (`gladiator validate --write`) and a mid-tier test suite. They live in the Gladiator repository.

## Relate capabilities used
- Embedded Python library (`relate-db` 1.2.0), single-file store (`.rl`).
- Cypher: `MERGE` with uniqueness constraints (safe re-loading), `UNWIND` batch writes, `FOREACH`
  for conditional relationships, `OPTIONAL MATCH`, aggregation, `EXISTS { }` subqueries, list operations, and
  read-only connections for every question.

## Third-party tools
- Python 3.12+, [uv](https://github.com/astral-sh/uv) for environments and the lock file, pytest, ruff.
- GitHub Actions for CI.
- The match data itself was produced by calling commercial and open-weights model APIs (Anthropic, OpenAI,
  Google, and open-weights models through OpenRouter) from the Gladiator engine.

## AI tools
The code, tests and documentation were written by **Claude** (Anthropic), working as a coding agent under the
owner's direction. The owner set the goals, made the product and budget decisions, and reviewed the results.
