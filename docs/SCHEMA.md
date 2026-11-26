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
| `Match` | `run_id/node/attempt` | difficulty, seed, profile, **conditions** (below), **rule** (`success`, `progress`, `efficiency`, `tie`, `excluded`), excluded | one *pair*: both models on the same generated world |
| `SelfCheck` | `run_id/node/attempt` | difficulty, seed, conditions, excluded, **same** (did the model end the same way both times), model | one scenario played twice by ONE model (a self run). Never a `Match`: nothing about pairs or wins sees it |
| `SelfAttempt` | `run_id/node/attempt/side` | the same facts as `Attempt` | one of the two times. `(SelfAttempt)-[:IN]->(SelfCheck)`, `-[:BY]->(Model)`, `-[:MADE]->(Fault)`; `(SelfCheck)-[:USED]->(TestVersion)`, `-[:PART_OF]->(Run)`, `-[:BY]->(Model)`. Counted in the model's fitness for the task |
| `Attempt` | `match/side` | side, effort, passed (the test's own verdict: right result and right process), **task_correct** (the result alone: every decision right, nothing left undone), first_pass, mistakes, model_errors, progress, cost_usd, tokens_in, tokens_cached (the part of the input the provider served from its cache), tokens_out, **cost_basis** (`billed`, `repriced`, `list`, `mixed`: where the cost came from, `ledger/costs.py`), tokens, wall_s, calls, termination, items, efficiency | one side of a match |
| `Model` | `name` (exact model id, e.g. `anthropic:claude-haiku-5-5`) | provider | contestants |
| `Test` | `id` (e.g. `gladiator/refund-queue`) | | challenge provenance |
| `TestVersion` | `id@version:sha12` | test_id, version, version_rank, content_sha256, status (at run time), forked_from, title, brief, policy (the text the models were given), wording (which of the test's wordings that text is), tools (every tool a model used), tags, emulates, test_type, action_budget | challenge provenance (the exact sealed package). One account from every record on file: every tool any model used on the version, and the text of its lowest-numbered wording, so importing a race never changes what a workflow is said to be (`settle_flows`) |
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

## The live record

`ledger serve` (`ledger/live.py`) keeps this same graph, steps included, in one Relate store that stays open and
is written to as races end: each sealed record a runner files is checked against its seal, kept as a file, and
added with the statements above. Relate lets one process write a store, so the store is in Relate's directory
format (a single `.rl` file can be opened by nobody else while it is held), and one thread owns the connection.
It adds one node of its own, `LiveStore {key: 'store', loader}`, which names the code that built the store: a
store built by other code is rebuilt from the records at start-up. Adding records one at a time, in any order,
leaves exactly the graph that building from all of them leaves (`tests/test_live.py`). That rests on one rule:
what a `TestVersion` says of its workflow (text, tools, package facts) is one account made from every record on
file (`Flows` in `ledger/bridges/gladiator.py`), not what the last record happened to say.

What it answers, all of it read-only: `GET /health`; `GET /runs` (every record it holds, by id and seal, after a
look at the runner when one is due; `?fresh=1` when a race has just ended); `GET /rows/<run_id>` (one record as
the rows of this schema: the run, and its steps in the small form of `ledger/bridges/steps.py`);
`GET /replay/<run_id>` (the same record as the page replays it); and `POST /sync` (look at the runner now). For a
given set of records these are the very rows, step file and replay file `ledger site` ships to the page.

**The page reads it.** A page that knows of a live record (`record` in `site/data/live.json`, or `?record=` in
its address) asks for `/runs` when it loads and loads every record its own copy lacks into the graph in the tab,
with the statements the shipped ones were written with (`addRun` in `site/worker.js`, the order of `write_to`).
Steps of such a record come from the same answer, loaded for the scenarios a question is about, as for a shipped
one. When a race started from the page ends, the page asks again (`?fresh=1`) until the record is there, loads
it and reads the verdict again. A page published before some records, reading a live record that holds them, is
then the page published after them: the same graph, node for node and link for link, and the command line's
answers (`site/check-live.cjs`, with the real service). With no live record, or one that does not answer, the page
is its shipped copy and says so.

## Steps: how an attempt got to its result

A run record also keeps every step of every attempt (`turns`: the tool called, its arguments, what the simulated
world answered). The steps bridge (`ledger/bridges/steps.py`) reads them, and `load_steps` writes them. They are
seven times the size of everything above together (62,374 steps on Nov 26, 2026), so the shipped store does not
carry them: the first question that needs them builds a second, local store from the same records
(`data/ledger-steps.rl`, `ledger/routes.py`; or `ledger build --steps` into any store). The browser page loads
them into its own graph the same way, a scenario or a task at a time, from `site/data/steps/`. Everything in it
comes from the public record. Nothing is read from the answer key, and nothing knows any one test.

| Node | Key | Properties | From |
|---|---|---|---|
| `Step` | `attempt/n` | n (its place in the attempt, from 1), tool, **kind** (`read`, `check`, `act`, `end`, `talk`), **state** (`ok`, `timeout`: the outcome is unknown, `refused`: the world answered with an error), at_s (seconds since the attempt began), item (the id the step named) | one turn of an attempt |
| `Item` | `match/id` | id (as the world names it, e.g. `REQ-0004`), **kind** (`refund request`, `order`, `customer`, ...) | one record of a generated world that some step saw, decided or checked, or a notice named |

An item's kind is read from the tools: the tool that looks a record up names it (`get_order`), then the list that
shows it (`list_refund_requests`), then the field that refers to it (`customer_id`). One kind per family of ids in
a test, so a customer nobody looked up in one world is still a customer there.

| Relationship | Meaning |
|---|---|
| `(Attempt)-[:TOOK]->(Step)` | the attempt's steps (also `(SelfAttempt)-[:TOOK]->(Step)` for a self run) |
| `(Step)-[:NEXT]->(Step)` | the order of the route, each step to the one after it |
| `(Step)-[:SAW]->(Item)` | the step's answer showed this record: a lookup, or a row of a list. Not for a call that failed |
| `(Step)-[:DECIDED]->(Item)` | the step acted on the item; `Step.tool` is the decision. A model's last action on an item is its decision |
| `(Step)-[:CHECKED]->(Item)` | the step checked whether an action on the item had taken effect |
| `(Step)-[:TOLD_OF {notice}]->(Item)` | the step's answer carried a notice naming the record (the world announced a change to it) |
| `(Item)-[:REFERS_TO {field}]->(Item)` | one record names another, as the world's answers show it (a request's `order_id`, an order's `customer_id`). A field refers to a record when its name ends in `_id`, or when a lookup tool takes an argument of that name (`stock_for_sku(sku)`) |
| `(Item)-[:IN]->(Match)` | the world the record belongs to. **Both attempts of a match share its items**, which is what lets two routes be compared item by item (`(Item)-[:IN]->(SelfCheck)` for a self run) |

`Run.steps` holds the number of steps loaded for a run; a store holds the steps when every run has it.

**Process questions** (`STEP_PATTERNS` in `ledger/questions.py`) are patterns over these, counted per model in the
scope of fitness (one test version, one set of conditions). Each returns the attempts with the pattern, how often,
and of those attempts how many still had the right result and how many the test passed:

| Question | The pattern |
|---|---|
| `decided-before-seeing` | a step `DECIDED` an item that `REFERS_TO` a record (up to three hops), and no earlier step of the attempt `SAW` that record |
| `decided-never-saw` | the same with no step at all that saw it. What the grader's "acted without reading" counts |
| `decided-unknown-record` | a step `DECIDED` an item that no step of either attempt ever `SAW`: an id that names no record |
| `retried-without-checking` | from an action that timed out, a walk along `NEXT` to the next action on the same item with no `CHECKED` on the way. What the grader's "ambiguous timeout" counts |
| `told-then-decided` | a step was `TOLD_OF` a record, and a later step `DECIDED` an item that refers to it with no step between that saw it again |

For the two the grader also counts, the graph and the grader agree on every attempt on file
(`tests/test_steps.py`): over the records each test's own package requires (`task.joins`), and counting an action
on an unknown record as the grader does. `same_world` lays the two attempts of a match side by side, item by item;
`world_records` and `world_seen` return the world itself (every record with the records it refers to) and the
step at which each model first saw each record, which is what the page draws a scenario from.
A reader can give any of these a level in a verdict (`--check decided-before-seeing=serious`); it is then judged
like a fault the grader counted, under the name "... (your check)", and the head to head is untouched.

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

## Live results
A live race is evidence once it is imported. The hosted runner's sealed public records are brought in with
`ledger import --runner <address>` (the `Import live races` workflow does it after a race and on a schedule), and
from then on a live race between two models is a `Run` with `Match` and `Attempt` nodes like any other, counted
in verdicts, costs and reports that are read under the conditions it was played under (above). A batch of one model against itself is loaded as `SelfCheck` and `SelfAttempt`
(above) and is never a `Match`.

Where the page reads a live record (above), a race is a `Run` in the page's graph as soon as it ends. Where it
does not, then until the import, in the browser session that ran it: the result joins the in-browser graph as its own kind of node,
so it can be drawn beside the recorded matches at once without being counted twice later:
`(LiveMatch {run_id, winner, seal})-[:RAN_ON]->(TestVersion)` and `-[:PLAYED_BY]->(Model)`. No question that
answers a verdict matches `LiveMatch`, and it is never in the shipped store.

## Conditions: what a verdict counts
Every `Match` and `SelfCheck` carries `conditions`: one string that is equal exactly when two pairs are comparable.
It is built by the bridge from the record (`conditions_of` in `ledger/bridges/gladiator.py`): every setting the
engine applied to the test, the difficulty of the generated world and the scoring profile the pair was judged with,
for example `attempt_budget_usd=0.12; difficulty=standard; effort=low; max_output_tokens=4096; profile=budget;
timeout_s=180`.

A verdict is read under one set of conditions (`reference_conditions` in `ledger/cli.py`), chosen in this order:
the conditions of the suite matches between the two models; if they never met in a suite, those most of the
task's own suite record was played under; if they have no pair under those either, the conditions they met under
most. Pairs the two played under any other conditions stay on file, are listed in the verdict (`not_counted`,
and a note) and are never pooled. So a live race counts when it was played under the record's conditions, and a
race at an easier level or under another scoring profile never moves that record's verdict. `--suite` narrows a
verdict further to one suite's matches, a fixed set that live races never join.

## Fit for the task (`ledger/policy.py`)
Whether a model is fit for a task is read from the graph by `task_attempts` and `task_faults` (every attempt the
model made on the test version under the verdict's conditions, whoever the opponent was and whether the match was
a suite match or a live race, so a model's fitness for a task is the same in every verdict read under those
conditions) and judged by a policy in two parts that are kept apart (owner, 2026-11-26: the fault levels
decide). The result: the bar is the share of attempts with the right result (`task_correct`), not the share the
test passed, which also asks for the process. The process: each fault has a level
(`unforgivable`, `serious`, `minor`), set per fault with per-task exceptions, under a profile (`enterprise`,
`personal`) that sets the pass bar and how often a serious fault may show. A mix-up takes the level of the fault
it is a `KIND_OF`. The reader's own levels overrule all of it. The verdict leads with fitness and then gives the
head to head.

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
