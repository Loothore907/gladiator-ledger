# Ledger graph schema

Ledger turns Gladiator's sealed records into one Relate graph. Every node and relationship comes from a field in
those records. Nothing is typed in by hand. The loader writes with `MERGE` on stable keys, so loading the same
records again changes nothing, and the store can be rebuilt from the records at any time. **The records stay the
master copy and the graph is a view of them.**

## Bridges: where evidence comes from

Ledger's subject is fixed: evidence about which model does a given task better. A **bridge** is one source of that
evidence (`ledger/bridges/`). It reads its own files and hands back plain rows in a shared shape: head-to-head
runs (matches, attempts, who won and why) and validation checks. The loader (`ledger/load.py`) is the only code
that writes to the graph, and it links every run and check to its `Source`, so an answer can always be traced to
where its proof lives. A bridge never touches the graph, and the loader never parses a source's files, so another
source of the same kind of evidence plugs in by handing back the same shape.

Two bridges ship. `epoch` reads one file of published scores (`data/epoch/eci_scores.csv`, Epoch AI's Capabilities
Index, CC BY 4.0) and adds `display_name`, `organization`, `weights` (`open`, `closed`, `other`) and `released` to
each `Model` it names. A model is joined to a Gladiator model id only when the names match exactly
(`ledger/bridges/epoch.py`); every other Epoch model gets the key `epoch:<name>` and has no matches yet.

`gladiator` reads two kinds of record:

- **Run records** (`runs/<run_id>/record.json`, Gladiator's `docs/RUN_RECORD.md`): one match between two models on
  a suite. The graph is built from this public file only. The private half beside it (`operator.json`, the
  answer key) is published for checking but is not loaded into the graph.
- **Validation records** (`validations/<namespace>/<name>@<version>.json`): the automatic validation of one test
  version, with a reference player and corner-cutting players.

A record whose SHA-256 seal doesn't match its body is skipped and reported.

## Nodes

| Node | Key | Properties | From |
|---|---|---|---|
| `Run` | `run_id` | suite, started_unix, record_version, engine_commit, cap_usd, spent_usd, repeats, effort, max_output_tokens, attempt_budget_usd, timeout_s, model_a, model_b, recorded_winner, seal_sha256 | one run record |
| `Match` | `run_id/node/attempt` | difficulty, seed, profile, **rule** (`success`, `progress`, `efficiency`, `tie`, `excluded`), excluded | one *pair*: both models on the same generated world |
| `Attempt` | `match/side` | side, effort, passed, first_pass, mistakes, model_errors, progress, cost_usd, tokens, wall_s, calls, termination, items, efficiency | one side of a match |
| `Model` | `name` (exact model id, e.g. `anthropic:claude-haiku-5-5`) | provider | contestants |
| `Test` | `id` (e.g. `gladiator/refund-queue`) | | challenge provenance |
| `TestVersion` | `id@version:sha12` | test_id, version, version_rank, content_sha256, status (at run time), forked_from, title, brief, policy (the text the models were given), tools (every tool a model used), tags, emulates, test_type, action_budget | challenge provenance (the exact sealed package) |
| `Hazard` | `name` | | grader counters, validation players |
| `Fault` | `key` (the name; a mix-up's key also carries its test id) | name, **kind** (`trap`, `decision`, `mix-up`, `ending`), test_id (mix-ups only) | grader counters, mix-ups and how each attempt ended |
| `Source` | `name` (the bridge, e.g. `gladiator`) | description | the bridge that read the evidence |
| `Benchmark` | `name` (e.g. `Epoch Capabilities Index`) | publisher, url | the epoch bridge |
| `ValidationRun` | `version/seal/level/player` | level, player, role (`reference`, `corner-cutting`), seeds, passed_seeds, ok, record_valid, engine_commit, validated_at | one check in a validation record |

A full-text index, `flow_text`, covers `TestVersion.title`, `brief` and `policy`. `find_flow` searches it for the
words of a described flow and then follows the graph to the models and pairs behind each workflow it finds.

## Relationships

| Relationship | Meaning |
|---|---|
| `(Run)-[:FROM]->(Source)`, `(ValidationRun)-[:FROM]->(Source)` | which bridge the evidence came from |
| `(Benchmark)-[:FROM]->(Source)` | which bridge a benchmark's scores came from |
| `(Model)-[:SCORED {score, low, high}]->(Benchmark)` | a published score and its range. Used only to find models that score close to each other (`close_to`), never to rank |
| `(Match)-[:PART_OF]->(Run)` | the record a pair came from |
| `(Match)-[:USED]->(TestVersion)` | the exact sealed package played |
| `(TestVersion)-[:VERSION_OF]->(Test)` | which workflow a version belongs to |
| `(TestVersion)-[:FORKED_FROM]->(TestVersion)` | fork lineage, when the parent is loaded |
| `(Attempt)-[:IN]->(Match)` | the two sides of a pair |
| `(Attempt)-[:BY]->(Model)` | who played |
| `(Match)-[:WON_BY]->(Model)` | the pair's winner. **Absent for a tie or an excluded pair** |
| `(TestVersion)-[:INCLUDES]->(Hazard)` | the version can generate this hazard (its grader counts it) |
| `(Attempt)-[:TRIPPED_ON {count}]->(Hazard)` | the model fell for it, `count` times |
| `(TestVersion)-[:CAN_SHOW]->(Fault)` | the version's grader can report this fault |
| `(Attempt)-[:MADE {count}]->(Fault)` | the model made it, `count` times. Absent where it could have and did not |
| `(Fault)-[:KIND_OF]->(Fault)` | a test's specific mix-up (should close, did escalate) is a kind of "wrong decision" |
| `(Fault)-[:FALLS_FOR]->(Hazard)` | the fault of falling for that hazard |
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

## Faults
A fault is anything a grader says a model did wrong on an attempt. Hazards are what a test plants; faults are what
a model did. Which faults are unforgivable is the reader's call and depends on the workflow, so the graph records
every kind and judges none.

| Kind | Faults | From |
|---|---|---|
| `trap` | one per hazard above (falling for it) | the hazard counters |
| `decision` | wrong decision; right decision, wrong details; left undone | `wrong`, `wrong_args`, `missing` |
| `mix-up` | one per test and pair of outcomes, e.g. "should close, did escalate" | `confusions` (expected->chosen) |
| `ending` | stopped before finishing; ran out of allowed actions | `termination` (`no_action`, `action_limit`) |

`uv run ledger ask fault_profile --param test_id=gladiator/incident-triage` lists, per model,
each fault it could show and in how many attempts it showed it.

## The questions (`ledger/questions.py`)

| | Question | What it follows |
|---|---|---|
| Q1 | **Best under budget**: for workflow W and a budget per attempt, which model wins most pairs among those that fit? | Test → versions → matches → attempts → models, with costs |
| Q2 | **Hazard profile**: which hazards trip which models, out of the attempts where the hazard could happen? | Attempt → Match → TestVersion → Hazard, against Attempt → Hazard |
| Q3 | **Beat cycles**: A beat B, B beat C, C beat A on the same version. Then the ranking isn't a ladder. | pair majorities per test version, then 3-cycles |
| Q4 | **Promotion evidence**: validated, played by enough distinct models, pairs with a clear winner | TestVersion → ValidationRun, and TestVersion → Match → Model |
| Q5 | **Stale results**: matches played on a version that has a newer version or a fork | TestVersion → Test ← newer TestVersion, and FORKED_FROM |

`ledger recommend` builds on Q1, for one workflow (its newest version with data) or, with `--suite`, for every
workflow in a Gladiator suite (current versions only, where the evidence is deepest). It ranks the models that fit
the budget, checks the top two head to head (sign test), and adds caveats for thin evidence, cycles, missing
validation and older versions. **It names no winner when the evidence is thin or the top two are level**, the same
rule Gladiator applies to matches.
