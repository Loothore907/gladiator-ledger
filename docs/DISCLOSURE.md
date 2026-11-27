# Disclosure statement

## Before and during the contest
The contest opened on 2026-11-11.

| When | What | Where |
|---|---|---|
| October 2026 | The idea for Gladiator: head-to-head tests of two models on the same task. No code. | Not in any repository |
| Nov 18–20 | Gladiator's first code: a pilot runner and ten fixed test cases. Its first commit is dated 2026-11-18. Ledger does not use this version or its tests. | The author's private repository |
| Nov 20–22 | The Gladiator engine as Ledger's data uses it: the rebuilt match engine, the tool-workflow test type, the four workflow tests, automatic validation and validation records, the small-tier and mid-tier suites, and every match in `data/`. | Public since 2026-11-22 as [gladiator-core](https://github.com/Loothore907/gladiator-core), with a fresh history; the earlier history is in the author's private repository |
| Nov 21 onward | All of Gladiator Ledger: the bridges and loader, the graph schema, the Cypher questions, the commands, the MCP server, the browser demo page, the steps in the graph and the questions asked of them, the live record service (`ledger serve`) and its container, the tests, the documentation and the shipped store. | This repository |

So no code in either project predates the contest; only the idea does. Gladiator is still disclosed here as
separate, earlier work, because Ledger was started after it and builds on its output.

## What Ledger takes from Gladiator
- **Its output files.** Run records (`record.json`, with the private half `operator.json`): sealed, versioned
  results of matches between two models. Validation records: sealed evidence that each test version passed
  automatic validation.
- **No imported code.** Ledger does not include, import or run the engine.
- **One copied file**, marked in its header: `ledger/scoring.py`, the per-pair judging rule (from Gladiator's
  `scorers/efficiency.py` and `scorers/outcome.py`, commit `c3dac6f` in the private history). It is copied so
  Ledger judges every pair exactly as Gladiator does.

## Gladiator changes made for Ledger
In the Gladiator repositories, during the contest:
- validation records (`gladiator validate --write`), so test trust can be loaded into the graph;
- a mid-tier test suite (`suites/mid_tier.yaml`);
- the matches themselves: small-tier and mid-tier sets on the fixed engine, and repeats for the demo pair;
- a fix to the engine's workflow tools (the check tool's missing argument, described under "The data"), found
  while preparing this entry;
- a fix so each record names the engine's own commit;
- the race runner (`gladiator serve`), for the live races on the page: one brand-new scenario, or a batch,
  played on request and reported step by step, with a cap per race, a budget per provider, invitations and one
  race at a time. It files the sealed record that Ledger then takes in;
- the public release of the engine as gladiator-core.

## The data
`data/` holds 37 sealed public match records from the Nov 22 suite matches, plus the live races and batches run
since on the hosted race runner (12 as of 05:00 UTC on Nov 26, $1.35 in API usage; public halves only, and counted
in verdicts like any other match played under the same conditions; more join as they are run: the page reads each
one from Ledger's live record as it ends, and `ledger import --runner` archives it in this repository). The 37 cover 12 models ( Anthropic, OpenAI and Google models through their APIs,
and open-weights models through OpenRouter) and come with 20 validation records. Those suite matches were played on Nov 22, 2026 and
cost $24.90 in API usage in total (corrected figures, see below), paid from the author's provider
accounts and plan credits. Each record includes its exact model ids, prices and costs, and the commit of the public Gladiator engine
that played it. Each match's private half (`operator.json`, the answer key of its generated worlds) is published
beside the record now that the match is over; `ledger verify` checks it against the fingerprint in the record.

**How fitness is judged changed on 2026-11-26.** A Gladiator test passes an attempt only when the result is right
and the process it sets was followed. Ledger's bar for "fit" used that pass rate. Four live batches of 25 between
Claude Haiku 5.5 and DeepSeek V4.1 Flash showed what it hid: on the refund queue DeepSeek got every decision right
in all 95 of its attempts, and passed 30, because in the other 65 it decided a request before looking up a record
the brief tells it to read. Across the twelve models, 153 of the 185 refund-queue attempts that did not pass had
every decision right. Ledger already recorded that as a fault whose level the reader sets ("minor" for one person
by default), and then let the pass rate overrule the reader. Since this date the bar asks for the right result,
and the process is judged only by the fault levels. No record, count or head-to-head result changed. Verdicts that
said "not fit" for process alone did, and so did the claim this entry led with: "on the refund queue only Haiku is
fit" became "both get the refunds right; Haiku follows the stated process and DeepSeek often does not".

**A weaker obstacle in two workflows, found on 2026-11-24.** A Gladiator test can change a record while the model
works and say so in a tool result; the model must then decide by the new facts. In refund-queue 2.2.0 and
incident-triage 1.2.0, the versions every match here was played on, each such change was planned for a fixed number
of tool calls. Often the model had not read the record yet, or had already decided everything that depended on it,
so ignoring the notice cost nothing. Gladiator's own validation had missed this, because it judged each
corner-cutting player on 20 generated worlds: its player that ignores the notices got through 2 of 20 for
refund-queue and 1 of 20 for incident-triage, with 3 allowed. Played on 100 worlds at the standard level, the level
of every match here, it gets through 25 and 24, against 15% allowed. Access review and inventory transfer are not
affected.

What changed in Gladiator: validation now plays such a player on more worlds until the answer is clear
([gladiator-core#13](https://github.com/Loothore907/gladiator-core/pull/13)); a change can be announced when the
model first looks the record up, on a record where it overturns a decision that is still ahead
([gladiator-core#12](https://github.com/Loothore907/gladiator-core/pull/12)); and refund-queue 2.3.0 and
incident-triage 1.3.0 are built that way
([gladiator-core#16](https://github.com/Loothore907/gladiator-core/pull/16)). There the same player gets through 0
of 100 worlds.

What it means here. Nothing was re-run and no record changed.
- **No result changes.** No match, pass, fault count, cost, fitness call or verdict is different. Both models played
  the same world, and every decision was graded on the facts at the time it was made.
- **What those results were earned on.** On these two workflows, ignoring a change notice often went unpunished. A
  model that ignores such notices will have looked better here than it would on the fixed versions. Ledger does not
  count this obstacle as a hazard of its own (where ignoring a notice did matter, it shows as a wrong decision), so
  no guardrail row in a spec rests on it.
- **The validation question.** `ledger ask promotion` still reports both versions as validated with no failed
  checks. It reads the validation records as sealed, and those were made under the earlier rule. By the rule
  Gladiator uses now, the two versions are not valid at the standard level.
- **The fixed versions.** Ledger holds no match played on them, and a result on one version of a test says nothing
  about another. Live races use the same versions as the records, so a live result and the record stay comparable.

**Costs corrected on 2026-11-23.** The author checked the recorded costs against the providers' real balances and
found the Gladiator engine had priced two kinds of call wrongly: Claude Haiku 5.5's cache reads were charged as
plain input (recorded about four times too high), and models run through OpenRouter were priced from the list
price instead of the cost OpenRouter reports for each call (recorded about 40% too low overall, and by a different
factor for each model). The engine was fixed ([gladiator-core#6](https://github.com/Loothore907/gladiator-core/pull/6)).
For the matches already played, nothing was re-run: the real cost of each of the 36,929 OpenRouter calls was looked
up from OpenRouter by its call id and filed beside the record as `billed.json` (tied to the record by its seal),
and Haiku's calls were re-priced from the token counts in the record with the published cache-read price. The
sealed records are unchanged; Ledger applies the correction when it reads them (`ledger/costs.py`) and marks every
attempt's cost as `billed`, `repriced` or `list` (OpenAI and Google, whose recorded costs agreed with the bills
within 1% and 15%). Of the $24.90, $16.36 is billed, $1.14 re-priced and $7.40 list. No pass, fail, fault count or
fitness call changed. Scenarios where both models passed are decided on efficiency, which includes cost, so those
were re-judged: for example Claude Haiku against DeepSeek moved from 12 pairs to 52 to 30 to 34.

**Data replaced on 2026-11-22.** The store first shipped with 60 matches played on Nov 20 to 22 ($51.49). A bug in
the Gladiator engine was then found: the tool a model uses to check an action after a timeout was offered without
a way to say which request to check, so models that checked were graded as retrying blindly and pass rates came
out far too low. The bug was fixed
([gladiator-core#2](https://github.com/Loothore907/gladiator-core/pull/2)), the small-tier and mid-tier matches
were played again on the fixed engine, and only those matches are shipped. The earlier frontier-model matches were
not re-run and are no longer included.

**Third-party data.** `data/epoch/eci_scores.csv` is an unmodified copy of the Capabilities Index file from Epoch
AI's Benchmarking Hub (https://epoch.ai/benchmarks), retrieved 2026-11-22 and used under the Creative Commons
Attribution 4.0 licence. Ledger uses it only to suggest which models are close enough on paper to be worth
matching; it makes no claim from it.

**Third-party code.** `site/vendor/relate-wasm/` is a copy of the `@relate/relate-wasm` package (version in
`VERSION.txt` there), Relate's own WebAssembly build, used unmodified by the browser demo.

## Relate capabilities used
- **Embedded Python library** `relate-db` 1.2.0, imported as `relate`, with no server.
- **Single-file store** (`data/ledger.rl`), opened read-only for every question, and a second one built locally
  for the steps (`data/ledger-steps.rl`).
- **Directory store, kept open by one writer:** `ledger serve` holds the whole record, steps included, in Relate's
  directory format and writes each new sealed record into it as a race ends. One thread owns the connection (a
  connection belongs to the thread that opened it), and the store is rebuilt from the sealed records whenever
  it was built by other code.
- **Schema:** uniqueness constraints on every node key (`CREATE CONSTRAINT ... IF NOT EXISTS`).
- **Writes:** `UNWIND` batch loads with `MERGE` on stable keys (safe re-loading), `SET +=` property maps, and
  `FOREACH` with `CASE` for conditional relationships.
- **Reads:** multi-hop `MATCH` patterns, `OPTIONAL MATCH`, aggregation (`count`, `sum`, `avg`, `collect`),
  `EXISTS { MATCH ... }` subqueries, list construction and indexing, and parameters on every query.
- **Paths:** quantified path patterns over the steps of an attempt (`(first)-[:NEXT]->+(again)`), in the Python
  library and the WebAssembly build alike.
- **Full-text index** (`CREATE FULLTEXT INDEX`, `SEARCH ... IN (FULLTEXT INDEX ...) SCORE AS`) over each workflow's
  title, brief and rules, for "describe your flow".
- **WebAssembly build** (`@relate/relate-wasm`), in-memory, in a browser worker: the demo page in `site/` builds the
  whole graph client-side with the same Cypher as the command line, loads the steps of the scenarios it is asked
  about, and adds the records the live store holds that it was published without.
- **Read-only access for agents:** `ledger mcp` opens the single-file store read-only and serves it to AI
  assistants over the Model Context Protocol, including a tool for free-form read-only Cypher.
- **Python API:** `relate.connect`, the cursor `stats` counters (used in tests to prove re-loading creates nothing),
  and dict-style result rows.

## Third-party tools
- Python 3.12+, [uv](https://github.com/astral-sh/uv) (environment and lock file), pytest, ruff.
- The [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) (`mcp`), for the assistant server.
- Node.js and Playwright, only to check the browser demo page in CI.
- GitHub Actions for CI (Linux and Windows), and GitHub Pages for the demo page.
- Docker, for the live record's container image (built in CI and published to GitHub's container registry), and
  Fly.io, which hosts the race runner and the live record.
- The match data was produced by calling commercial and open-weights model APIs (Anthropic, OpenAI, Google, and
  OpenRouter) from the Gladiator engine.

## Independence
Gladiator Ledger is an independent project. It is not affiliated with, sponsored by or endorsed by Anthropic,
OpenAI, Google, OpenRouter, Epoch AI or any model maker. Model names are used only to identify what was tested. The
match transcripts in `data/records/` are AI-generated: they are the models' own tool calls and text during the tests.

## AI tools
The code, tests and documentation in this repository were written by **Claude** (Anthropic), working as a coding
agent under the author's direction. The author set the goals and made the product, budget and publishing decisions.
Claude ran the calibration matches within budgets the author set, and the author reviewed the results. Claude
also deployed the live record, to a host and at a cost the author approved.
