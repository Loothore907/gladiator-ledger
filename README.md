# Gladiator Ledger

**Which model should run this workflow, within my budget, and what's the evidence?**

Ledger loads the sealed run records of [Gladiator](https://github.com/Loothore907/gladiator), a head-to-head AI
model evaluation engine, into a [Relate](https://relatedb.ai) graph, and answers that question with Cypher. Every
answer comes with the matches behind it. When the evidence is thin, or the top models are level, it says so and
names no winner.

> Entry for the Relate hackathon (Nov–Dec 2026). The repository ships a Relate store built from **60 real matches
> between 18 models** (closed and open-weights), so every answer below reproduces from a clean clone with **no API
> keys and no cost**.

## Setup (under five minutes)
Needs Python 3.12+ and [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/Loothore907/gladiator-ledger
cd gladiator-ledger
uv sync
uv run ledger recommend --suite small-tier --budget 0.05
```

Works the same on Linux, macOS and Windows. CI checks Linux and Windows on every change.

## Walkthrough
The data: Gladiator plays two models through the same freshly generated multi-step tool workflows (refund queue,
access review, incident triage, inventory transfer). Each pair of attempts is judged in order: success beats
failure; if neither succeeds, getting further wins; if both succeed, the more efficient wins; and no real
difference is a tie. Ledger re-judges every pair with that rule.

### 1. "Which model, under this budget?"
```bash
uv run ledger recommend --suite small-tier --budget 0.05
```
```text
Leaning: openrouter:minimax/minimax-m3.1-flash

  model                                        pairs  won  passed  $/attempt  $/clean  mistakes
  openrouter:minimax/minimax-m3.1-flash           40   33       5    $0.0065  $0.0517       5.1
  openrouter:deepseek/deepseek-v4.1-flash-1017    40   33       9    $0.0066  $0.0292       4.4
  anthropic:claude-haiku-5-5                      52   33       3    $0.0187  $0.3233       3.8
  ...
Head to head vs deepseek: 6-2 (sign test p = 0.29)
Caveats:
  - minimax leads deepseek 6-2, but a split like that happens by chance 29% of the time between equal models:
    a lean, not a settled result.
  - Beat cycles (3): claude-haiku-5-5 > minimax > deepseek > claude-haiku-5-5 (2-0, 2-0, 2-0); ...
```
Two open-weights models win as often as Claude Haiku at about a third of the cost. DeepSeek has the cheapest clean
result ($0.03 per pass). Haiku still makes the fewest mistakes. Ledger calls this **a lean, not a pick**, and shows
why.

Change the budget and the answer changes:
```bash
uv run ledger recommend --suite small-tier --budget 0.005   # Pick: gpt-6-luna, the only model that fits
uv run ledger recommend --suite mid-tier --budget 0.1       # Leaning: claude-haiku-5-5, ahead of Sonnet, Terra, Gemini
uv run ledger recommend refund-queue --budget 0.05          # one workflow: no winner named (top two went 1-1)
```

### 2. "Where do models fail?" (hazard profile)
```bash
uv run ledger ask hazard_profile
```
The hazard "ambiguous timeout": an action's result is unknown and the model must check before retrying. Small and
mid-tier models retry blindly on **62–100% of the attempts** where it can happen. Frontier models (gpt-6.2 sol and
astra) do so on about **23%**, even though they mostly played harder, expert-level worlds. That is the single
biggest gap between tiers in the data (it pools different matches and difficulty levels, so read it as a pattern,
not a head-to-head result).

### 3. "Is the ranking even a ladder?" (beat cycles)
```bash
uv run ledger ask beat_cycles
```
On the same test version, A beat B, B beat C, and C beat A. Ledger finds these 3-cycles in the graph and reports
each edge's score, so a cycle made of 2-1 wins reads as possible noise rather than a crisis.

### 4. "Can this test be trusted?" (promotion evidence)
```bash
uv run ledger ask promotion
```
For each test version: did it pass Gladiator's automatic validation (the reference player passes and every
corner-cutting player is caught), how many distinct models played it, and how often a pair had a clear winner. The
four current workflow versions each have 12 models, 60 pairs and 97–100% decisive pairs.

### 5. "Which results are out of date?" (stale results)
```bash
uv run ledger ask stale_results
```
Matches played on a test version that has since been replaced. `recommend` uses current versions by default.

All questions: `best_under_budget`, `head_to_head`, `hazard_profile`, `beat_cycles`, `beats`, `promotion`,
`stale_results` (`uv run ledger ask <name> --json` for machine-readable output).

## How and why Relate is used
Relate is the store and the query engine, not an export target.

- **Storage mode:** embedded Python library (`relate-db`), single-file store `data/ledger.rl`. It's opened read-only
  for every question.
- **Why a graph:** the questions follow connections across matches. A beat cycle is a path through
  model-beat-model edges. Promotion evidence joins a test version to its validation runs and to every model that
  played it. A stale result is a match whose test version has a newer sibling. A hazard profile compares where a
  hazard *could* occur (test version → hazard) with where a model *fell* for it (attempt → hazard). In a flat
  report each of these is a custom script; here each is one Cypher query (`ledger/questions.py`).
- **Safe to rebuild:** the loader `MERGE`s on stable keys behind uniqueness constraints, so loading the same records
  again changes nothing. The records stay the master copy, and the store is a view of them.

Graph: 8 kinds of node (Run, Match, Attempt, Model, Test, TestVersion, Hazard, ValidationRun) and 11 relationships.
See [docs/SCHEMA.md](docs/SCHEMA.md).

## What's in the data
`data/records/` holds the sealed public run records (`record.json`) of every match: two models, the same generated
worlds, every action, grade and cost. `data/validations/` holds the sealed validation records of each test version.
Gladiator's private `operator.json` files (hidden simulator state) are never included. A test fails if the store and
the records ever disagree. To rebuild the store yourself:

```bash
uv run ledger build --records data/records --validations data/validations
```

Known limits: most pairings have 8–12 judged pairs, so many answers are leans rather than picks; that is the honest
reading. A single-workflow answer pools every suite that played that workflow version (suites can differ in
per-attempt budget); `--suite` answers keep suites apart.

## Disclosure
Ledger was started during the contest. It reads output from Gladiator, the owner's earlier engine, and copies one
small piece of its scoring code (marked in `ledger/scoring.py`). Code was written by Claude (Anthropic) under the
owner's direction. Full statement: [docs/DISCLOSURE.md](docs/DISCLOSURE.md).

## License
Apache-2.0.
