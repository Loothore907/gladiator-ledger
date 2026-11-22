# Gladiator Ledger

**Which model should run this workflow, within my budget, and what's the evidence?**

Ledger loads the sealed run records of [Gladiator](https://github.com/Loothore907/gladiator), a head-to-head AI
model evaluation engine, into a [Relate](https://relatedb.ai) graph, and answers that question with Cypher. Every
answer comes with the matches behind it. When the evidence is thin or the top models are level, it says so and
names no winner.

> Entry for the Relate hackathon (Nov–Dec 2026).

## Try it (no API keys, no cost)
The repository ships a Relate store built from real Gladiator match records (`data/ledger.rl`), so every answer
reproduces from a clean clone.

```bash
uv sync
uv run ledger recommend --suite small-tier --budget 0.05
uv run ledger recommend refund-queue --budget 0.05
uv run ledger ask hazard_profile
uv run ledger ask beat_cycles
```

`ledger ask` takes any of: `best_under_budget`, `head_to_head`, `hazard_profile`, `beat_cycles`, `beats`,
`promotion`, `stale_results`.

## What's in the data
`data/records/` holds the sealed public run records (`record.json`) of every match: two models, the same generated
worlds, every action, grade and cost. `data/validations/` holds the sealed validation records of each test version.
Gladiator's private `operator.json` files (hidden simulator state) are never included. To rebuild the store from
these files:

```bash
uv run ledger build --records data/records --validations data/validations
```

## How Relate is used
Relate is the store and the query engine. The loader writes runs, matches (one per paired attempt), attempts,
models, test versions, hazards and validation evidence into a single-file store (`data/ledger.rl`), and every
question is a Cypher query over it: best model under a budget, hazard profiles, beat cycles, promotion evidence and
stale results. See [docs/SCHEMA.md](docs/SCHEMA.md).

## License
Apache-2.0. Ledger reuses a small part of Gladiator's scoring code, marked in `ledger/scoring.py`.
