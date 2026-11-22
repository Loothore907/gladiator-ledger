# Disclosure statement

## Before and during the contest
The contest opened on 2026-11-11.

| When | What | Where |
|---|---|---|
| October 2026 | The idea for Gladiator: head-to-head tests of two models on the same task. No code. | Not in any repository |
| Nov 18–20 | Gladiator's first code: a pilot runner and ten fixed test cases. Its first commit is dated 2026-11-18. Ledger does not use this version or its tests. | The author's private repository |
| Nov 20–22 | The Gladiator engine as Ledger's data uses it: the rebuilt match engine, the tool-workflow test type, the four workflow tests, automatic validation and validation records, the small-tier and mid-tier suites, and every match in `data/`. | Public since 2026-11-22 as [gladiator-core](https://github.com/Loothore907/gladiator-core), with a fresh history; the earlier history is in the author's private repository |
| Nov 21 onward | All of Gladiator Ledger: the bridges and loader, the graph schema, the Cypher questions, the commands, the MCP server, the browser demo page, the tests, the documentation and the shipped store. | This repository |

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
- the public release of the engine as gladiator-core.

## The data
`data/` holds 33 sealed public match records (12 models: Anthropic, OpenAI and Google models through their APIs,
and open-weights models through OpenRouter) and 20 validation records. The matches were played on Nov 22, 2026 and
cost $18.44 in API usage in total (the sum of the records' own cost figures), paid from the author's provider
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

**Third-party data.** `data/epoch/eci_scores.csv` is an unmodified copy of the Capabilities Index file from Epoch
AI's Benchmarking Hub (https://epoch.ai/benchmarks), retrieved 2026-11-22 and used under the Creative Commons
Attribution 4.0 licence. Ledger uses it only to suggest which models are close enough on paper to be worth
matching; it makes no claim from it.

**Third-party code.** `site/vendor/relate-wasm/` is a copy of the `@relate/relate-wasm` package (version in
`VERSION.txt` there), Relate's own WebAssembly build, used unmodified by the browser demo.

## Relate capabilities used
- **Embedded Python library** `relate-db` 1.2.0, imported as `relate`, with no server.
- **Single-file store** (`data/ledger.rl`), opened read-only for every question.
- **Schema:** uniqueness constraints on every node key (`CREATE CONSTRAINT ... IF NOT EXISTS`).
- **Writes:** `UNWIND` batch loads with `MERGE` on stable keys (safe re-loading), `SET +=` property maps, and
  `FOREACH` with `CASE` for conditional relationships.
- **Reads:** multi-hop `MATCH` patterns, `OPTIONAL MATCH`, aggregation (`count`, `sum`, `avg`, `collect`),
  `EXISTS { MATCH ... }` subqueries, list construction and indexing, and parameters on every query.
- **Full-text index** (`CREATE FULLTEXT INDEX`, `SEARCH ... IN (FULLTEXT INDEX ...) SCORE AS`) over each workflow's
  title, brief and rules, for "describe your flow".
- **WebAssembly build** (`@relate/relate-wasm`), in-memory, in a browser worker: the demo page in `site/` builds the
  whole graph client-side with the same Cypher as the command line.
- **Read-only access for agents:** `ledger mcp` opens the single-file store read-only and serves it to AI
  assistants over the Model Context Protocol, including a tool for free-form read-only Cypher.
- **Python API:** `relate.connect`, the cursor `stats` counters (used in tests to prove re-loading creates nothing),
  and dict-style result rows.

## Third-party tools
- Python 3.12+, [uv](https://github.com/astral-sh/uv) (environment and lock file), pytest, ruff.
- The [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) (`mcp`), for the assistant server.
- Node.js and Playwright, only to check the browser demo page in CI.
- GitHub Actions for CI (Linux and Windows).
- The match data was produced by calling commercial and open-weights model APIs (Anthropic, OpenAI, Google, and
  OpenRouter) from the Gladiator engine.

## Independence
Gladiator Ledger is an independent project. It is not affiliated with, sponsored by or endorsed by Anthropic,
OpenAI, Google, OpenRouter, Epoch AI or any model maker. Model names are used only to identify what was tested. The
match transcripts in `data/records/` are AI-generated: they are the models' own tool calls and text during the tests.

## AI tools
The code, tests and documentation in this repository were written by **Claude** (Anthropic), working as a coding
agent under the author's direction. The author set the goals and made the product, budget and publishing decisions.
Claude ran the calibration matches within budgets the author set, and the author reviewed the results.
