# Gladiator Ledger

**Which model should run this workflow, within my budget, and what's the evidence?**

Ledger loads the sealed run records of [Gladiator](https://github.com/Loothore907/gladiator), a head-to-head AI
model evaluation engine, into a [Relate](https://relatedb.ai) graph, and answers that question with Cypher. Every
answer comes with the matches behind it. When the evidence is thin or the top models are level, it says so and
names no winner.

> Work in progress for the Relate hackathon (Nov 2026). Setup, the shipped store and the demo are coming.

## Try it
```bash
uv sync
uv run ledger build --records path/to/runs --validations path/to/gladiator/validations
uv run ledger recommend refund-queue --budget 0.05
uv run ledger ask hazard_profile
```

## How Relate is used
Relate is the store and the query engine. The loader writes runs, matches (one per paired attempt), attempts,
models, test versions, hazards and validation evidence into a single-file store (`data/ledger.rl`), and every
question is a Cypher query over it: best model under a budget, hazard profiles, beat cycles, promotion evidence and
stale results. See [docs/SCHEMA.md](docs/SCHEMA.md).

## License
Apache-2.0. Ledger reuses a small part of Gladiator's scoring code, marked in `ledger/scoring.py`.
