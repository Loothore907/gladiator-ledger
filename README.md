# Gladiator Ledger

**Which model should run this workflow, within my budget, and what's the evidence?**

Ledger loads the sealed run records of [Gladiator](https://github.com/Loothore907/gladiator-core), a head-to-head AI
model evaluation engine, into a [Relate](https://relatedb.ai) graph, and answers that question with Cypher. Every
answer comes with the matches behind it. When the evidence is thin, or the top models are level, it says so and
names no winner.

> Entry for the Relate hackathon (Nov–Dec 2026). The repository ships a Relate store built from **25 real matches
> between 12 models** (closed and open-weights), so every answer below reproduces from a clean clone with **no API
> keys and no cost**.

## Try it in the browser
The `site/` folder is a static page that builds the same graph in your browser with Relate's WebAssembly build and
walks the whole loop: describe a flow, pick two models, read the verdict and download the spec. No server, no keys,
nothing leaves the tab. Serve the folder with any static file server:

```bash
python3 -m http.server --directory site 8000    # then open http://localhost:8000
```
A check (`node site/check.cjs`, run in CI) proves the page gives the same answers as the command line.

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
Leaning: openrouter:deepseek/deepseek-v4.1-flash-1017

  model                                        pairs  won  ties  passed  $/attempt  $/clean  mistakes
  openrouter:deepseek/deepseek-v4.1-flash-1017    72   52     1      59    $0.0065  $0.0079       0.5
  openrouter:minimax/minimax-m3.1-flash          108   61     0      69    $0.0075  $0.0117       1.7
  anthropic:claude-haiku-5-5                     132   70     0     118    $0.0185  $0.0207       0.4
  ...
Head to head vs openrouter:minimax/minimax-m3.1-flash: 14-10 (sign test p = 0.5413)
Caveats:
  - deepseek leads minimax 14-10, but a split like that happens by chance 54% of the time between equal
    models: a lean, not a settled result.
  - Beat cycles (2): claude-haiku-5-5 > gemini-3.1-flash-lite > gpt-6-luna > claude-haiku-5-5 (4-0, 2-1, 3-2); ...
```
Two open-weights models lead Claude Haiku on these four workflows at well under half the cost per attempt. Haiku
passes most often (118 of 132) and makes the fewest mistakes; it loses pairs on what each success costs. Between the
two leaders, DeepSeek is ahead of MiniMax 14-10 head to head, which is too close to call, so Ledger says
**leaning**, names no settled winner, and shows why. (DeepSeek against Haiku directly is 20-4, a clear result:
`uv run ledger ask head_to_head --param suite=small-tier --param a=... --param b=...`.)

Change the budget or the scope and the answer changes:
```bash
uv run ledger recommend --suite small-tier --budget 0.005   # Pick: gpt-6-luna, the only model that fits
uv run ledger recommend --suite mid-tier --budget 0.1       # Leaning: claude-haiku-5-5 (7-5 against Terra: a lean)
uv run ledger recommend refund-queue --budget 0.05          # one workflow: a lean only (the top two never met)
```
The first is a **pick** because only one model fits the budget; the other two are leans, because the lead is small
or the top two never played each other.

### The loop: describe a flow, pick a pair, get a verdict and a spec
```bash
uv run ledger flows "an agent that handles refund requests for damaged orders"   # finds the closest tested workflow
uv run ledger opponents "haiku 5.5" --open-only                                  # suggests a fair opponent
uv run ledger verdict refund-queue --a "haiku 5.5" --b minimax-m3.1              # which does this task better
uv run ledger spec refund-queue --a "haiku 5.5" --b minimax-m3.1 --out spec.md   # the build plan
```
`flows` is a keyword search (a Relate full-text index over each workflow's title, brief and rules) that then walks
the graph to what is known about each match. `spec` writes one document in three layers: the **decision** (who did
the task better, how sure, good enough or not), the **blueprint** (the job and rules as tested, the tools, the
settings the result holds for, and a guardrail for every hazard the chosen model tripped on) and the **evidence**
(the sealed records behind it). Sections 2 and 3 below show the middle two steps.

### 2. "Who is a fair opponent?" (published scores, only to pick the pair)
```bash
uv run ledger opponents "haiku 5.5" --open-only
```
```text
anthropic:claude-haiku-5-5  (Claude Haiku 5.5)
Epoch Capabilities Index: 160.3  (range 158.2 to 162.7)

Closest on paper, open weights only:
  model                                         score     gap  ranges overlap  weights  in Ledger
  epoch:Kimi K3.1 Pro                           161.2   +0.87  yes             open     no matches yet
  openrouter:deepseek/deepseek-v4.1-flash-1017  159.4   -0.92  yes             open     24 pairs already played against it
  ...
```
Ledger never ranks models by a published score. It uses one, [Epoch AI's](https://epoch.ai/benchmarks)
Capabilities Index, to answer a narrower question: which models are close enough on paper that a head-to-head is
worth running? Haiku and DeepSeek are less than one point apart, with overlapping ranges. On these four workflows
DeepSeek won 20 of their 24 pairs. Close on paper, clearly different on the task: that gap is what Ledger is for.

### 3. "Which of these two does this task better?" (the verdict)
```bash
uv run ledger verdict refund-queue --a anthropic:claude-haiku-5-5 --b openrouter:minimax/minimax-m3.1-flash
```
```text
Verdict: openrouter:minimax/minimax-m3.1-flash does this task better      (output wrapped here to fit)
  15 judged pairs on the same generated worlds: anthropic:claude-haiku-5-5 won 3,
  openrouter:minimax/minimax-m3.1-flash won 12, 0 tied (sign test p = 0.0352)
  decided: 12 on efficiency, 3 on success

  model                                  passed   $/attempt  sec/attempt  mistakes  good enough (bar 80%)
  anthropic:claude-haiku-5-5             15/15     $0.0174           33       0.0  yes
  openrouter:minimax/minimax-m3.1-flash  12/15     $0.0032           29       0.3  yes
```
A task claim, not a ranking: only the pairs where these two met count. Both are good enough at refunds, and
MiniMax does them at a fifth of the cost. Ask the same two about `incident-triage` and the answer turns round:
MiniMax passes 3 of 15 there, Haiku 13. The verdict also lists where each one tripped and the sealed records
behind it.

### 4. "Where do models fail?" (hazard profile)
```bash
uv run ledger ask hazard_profile
```
For each model and each hazard a test can generate: how many attempts met the hazard, and how many fell for it.
The commonest slip is **acting without reading**: deciding a request before looking up the records it depends on
(DeepSeek in 12 of 72 attempts, Gemini 3.1 Flash-Lite in 7 of 40; only one model never did it). By contrast, after
an **ambiguous timeout** (an action's result is unknown and must be checked before retrying) ten of the twelve
models never retried blindly. This pools matches across the two suites, so read it as a pattern, not a
head-to-head result.

### 5. "Is the ranking even a ladder?" (beat cycles)
```bash
uv run ledger ask beat_cycles
```
On the same test version, A beat B, B beat C, and C beat A. Ledger finds these 3-cycles in the graph and reports
each edge's score, so a cycle made of 2-1 wins reads as possible noise rather than a crisis.

### 6. "Can this test be trusted?" (promotion evidence)
```bash
uv run ledger ask promotion
```
For each test version: did it pass Gladiator's automatic validation (the reference player passes and every
corner-cutting player is caught), how many distinct models played it, and how often a pair had a clear winner. The
four current workflow versions each have 12 models, 84 pairs and 99–100% decisive pairs.

### 7. "Which results are out of date?" (stale results)
```bash
uv run ledger ask stale_results
```
Matches played on a test version that has since been replaced. `recommend` uses current versions by default. The
shipped store holds current versions only, so this returns no rows today; it fills as tests get new versions.

All questions: `best_under_budget`, `head_to_head`, `hazard_profile`, `beat_cycles`, `beats`, `promotion`,
`stale_results`, `sources`, `close_to`, `pair_on_task`, `pair_hazards`, `find_flow`, `flows`, `flow_as_tested` (`uv run ledger ask <name> --json` for machine-readable output).

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

- **Bridges:** evidence reaches the graph through a bridge (`ledger/bridges/`): a source reads its own files and
  hands back rows in one shared shape, and the loader links everything to its `Source`. Two bridges ship:
  `gladiator` (matches and test validation) and `epoch` (published scores, used only to suggest opponents). Another
  source of the same kinds of evidence plugs in the same way (`uv run ledger ask sources`).

Graph: 10 kinds of node (Source, Run, Match, Attempt, Model, Test, TestVersion, Hazard, ValidationRun, Benchmark)
and 13 relationships.
See [docs/SCHEMA.md](docs/SCHEMA.md).

## What's in the data
`data/records/` holds the sealed public run records (`record.json`) of every match: two models, the same generated
worlds, every action, grade and cost. `data/validations/` holds the sealed validation records of each test version.
Beside each record sits its **private half** (`operator.json`): the answer key of every generated world, published
now that the match is over. Each public record carries a fingerprint of its private half, so anyone can check that
the two belong together and re-grade a match themselves:

```bash
uv run ledger verify     # 25 match records, every seal checked; 25 private halves checked against their fingerprint
```
A private half is published only for tests that generate a fresh world on every attempt, so the answers cannot help
anyone on a later match. A test fails if the store and the records ever disagree. To rebuild the store yourself and check it gives the same answers:

```bash
uv run ledger build --records data/records --validations data/validations --scores data/epoch --store rebuilt.rl
uv run ledger recommend --suite small-tier --budget 0.05 --store rebuilt.rl
```

Known limits: most pairings have 8–24 judged pairs across four workflows (2–15 per workflow), so suite-level answers
can be picks while single-workflow answers are mostly leans; that is the honest reading. A single-workflow answer pools every suite that played that workflow version (suites can differ in
per-attempt budget); `--suite` answers keep suites apart.

`data/epoch/` holds one file from Epoch AI's Benchmarking Hub (the Capabilities Index), used under the Creative
Commons Attribution licence; see [data/epoch/README.md](data/epoch/README.md) for the credit.

## Disclosure
Ledger was started during the contest. It reads output from Gladiator, the owner's earlier engine, and copies one
small piece of its scoring code (marked in `ledger/scoring.py`). Code was written by Claude (Anthropic) under the
owner's direction. Full statement: [docs/DISCLOSURE.md](docs/DISCLOSURE.md).

## License
Apache-2.0.
