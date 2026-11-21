# Ledger graph schema

Ledger turns Gladiator's sealed records into one Relate graph. Every node and relationship comes from a field in
those records. Nothing is typed in by hand. The loader writes with `MERGE` on stable keys, so loading the same
records again changes nothing, and the store can be rebuilt from the records at any time. **The records stay the
master copy and the graph is a view of them.**

Two kinds of source record are read:

- **Run records** (`runs/<run_id>/record.json`, Gladiator's `docs/RUN_RECORD.md`): one match between two models on
  a suite. Only this public file is read. The private `operator.json` beside it is never opened.
- **Validation records** (`validations/<namespace>/<name>@<version>.json`): the automatic validation of one test
  version, with a reference player and corner-cutting players.

A record whose SHA-256 seal doesn't match its body is skipped and reported.

## Nodes

| Node | Key | Properties | From |
|---|---|---|---|
| `Run` | `run_id` | suite, started_unix, record_version, engine_commit, cap_usd, spent_usd, repeats, model_a, model_b, recorded_winner, seal_sha256 | one run record |
| `Match` | `run_id/node/attempt` | difficulty, seed, profile, **rule** (`success`, `progress`, `efficiency`, `tie`, `excluded`), excluded | one *pair*: both models on the same generated world |
| `Attempt` | `match/side` | side, effort, passed, first_pass, mistakes, model_errors, progress, cost_usd, tokens, wall_s, calls, termination, items, efficiency | one side of a match |
| `Model` | `name` (exact model id, e.g. `anthropic:claude-haiku-5-5`) | provider | contestants |
| `Test` | `id` (e.g. `gladiator/refund-queue`) | | challenge provenance |
| `TestVersion` | `id@version:sha12` | test_id, version, version_rank, content_sha256, status (at run time), forked_from | challenge provenance (the exact sealed package) |
| `Hazard` | `name` | | grader counters, validation players |
| `ValidationRun` | `version/seal/level/player` | level, player, role (`reference`, `corner-cutting`), seeds, passed_seeds, ok, record_valid, engine_commit, validated_at | one check in a validation record |

## Relationships

| Relationship | Meaning |
|---|---|
| `(Match)-[:PART_OF]->(Run)` | the record a pair came from |
| `(Match)-[:USED]->(TestVersion)` | the exact sealed package played |
| `(TestVersion)-[:VERSION_OF]->(Test)` | which workflow a version belongs to |
| `(TestVersion)-[:FORKED_FROM]->(TestVersion)` | fork lineage, when the parent is loaded |
| `(Attempt)-[:IN]->(Match)` | the two sides of a pair |
| `(Attempt)-[:BY]->(Model)` | who played |
| `(Match)-[:WON_BY]->(Model)` | the pair's winner. **Absent for a tie or an excluded pair** |
| `(TestVersion)-[:INCLUDES]->(Hazard)` | the version can generate this hazard (its grader counts it) |
| `(Attempt)-[:TRIPPED_ON {count}]->(Hazard)` | the model fell for it, `count` times |
| `(TestVersion)-[:VALIDATED_BY]->(ValidationRun)` | evidence that the test itself is sound |
| `(ValidationRun)-[:GUARDS]->(Hazard)` | the corner-cutting player that stands for this hazard was caught (or not) |

## How a pair is judged

Ledger judges every pair itself, with Gladiator's own rule, copied into `ledger/scoring.py` and disclosed as
reused code:

1. One side succeeded and the other didn't: `success`.
2. Neither succeeded: the one that decided more items correctly wins, `progress`.
3. Otherwise the more efficient wins: fewer mistakes, less money, fewer tokens and less time, weighted by the suite's
   profile. That's `efficiency`.
4. No real difference: `tie`, and no `WON_BY` edge.

Pairs where either side ended for reasons outside the models' control (an outage, the run cap, out of credit) are
`excluded` and never judged. Re-judging matters: some older records chose their match winner by an earlier rule,
and Ledger applies the current rule to all of them alike. The record's own verdict is kept as `Run.recorded_winner`.

## Hazards

| Hazard | Grader counter | Validation player |
|---|---|---|
| ambiguous timeout (retried without checking) | `blind_retries_after_unknown_outcome` | `blind_retry` |
| duplicate effect | `duplicate_effects` | |
| planted instruction | `injections_obeyed` | `obeys_injections` |
| acted without reading | `acted_without_reading` | `no_reading` |
| conflicting records | `conflicting` | |
| wrong amount | `wrong_amounts` | |

## The questions (`ledger/questions.py`)

| | Question | What it follows |
|---|---|---|
| Q1 | **Best under budget**: for workflow W and a budget per attempt, which model wins most pairs among those that fit? | Test → versions → matches → attempts → models, with costs |
| Q2 | **Hazard profile**: which hazards trip which models, out of the attempts where the hazard could happen? | Attempt → Match → TestVersion → Hazard, against Attempt → Hazard |
| Q3 | **Beat cycles**: A beat B, B beat C, C beat A on the same version. Then the ranking isn't a ladder. | pair majorities per test version, then 3-cycles |
| Q4 | **Promotion evidence**: validated, played by enough distinct models, pairs with a clear winner | TestVersion → ValidationRun, and TestVersion → Match → Model |
| Q5 | **Stale results**: matches played on a version that has a newer version or a fork | TestVersion → Test ← newer TestVersion, and FORKED_FROM |

`ledger recommend` builds on Q1: it takes the newest version of the workflow with data, ranks the models that fit
the budget, checks the top two head to head (sign test), and adds caveats for thin evidence, cycles, missing
validation and older versions. **It names no winner when the evidence is thin or the top two are level**, the same
rule Gladiator applies to matches.
