# Working on Gladiator Ledger (instructions for Claude sessions)

Ledger is the owner's entry for the Relate hackathon (deadline **Dec 11, 2026, 6:00 PM PST**; target submission
Dec 10). It loads Gladiator's run records into a Relate graph and answers "of these two models, which does this
task better, how sure is that, and what should I build", with the matches behind the answer. It makes task claims,
never general rankings. The same loop (flows, opponents, verdict, spec) runs from the command line, a static
browser page (`site/`) and an MCP server (`ledger mcp`). The owner directs and approves; Claude does the hands-on work.
The owner prefers plain-English summaries.

## Standing permissions (owner, 2026-11-21)
Same as the Gladiator repo: Claude may open PRs into `main` from a feature branch and **merge its own PRs once CI
is green** on the current head (squash merge), without asking. Fix red CI first; never skip or disable a test to
get green. Ask first before merging a PR Claude did not open, or changing repo settings or secrets.

## Rules
- **Ledger is new work, started 2026-11-21.** Gladiator (the engine, Apache-2.0) is disclosed separate work: the
  idea dates from October 2026, its first code was committed on 2026-11-18 (owner, 2026-11-22; never write that
  Gladiator code predates the contest, which opened Nov 11), and the engine Ledger's data uses was built Nov 20-22. Never copy Gladiator code into Ledger without marking it as reused in the file header and in the
  disclosure statement. `ledger/scoring.py` is the one copied file so far.
- **Ledger reads Gladiator's output and never runs a match itself.** It may *request* one from a Gladiator runner
  (owner, 2026-11-23, for the live demo): the runner is Gladiator's, holds the keys and enforces the caps; Ledger
  shows the race and files the sealed record it gets back. Live runs are open to the hackathon judges only for now
  (signed in once: the page's "Judge sign-in" button and an access code, or an invitation link that carries it;
  owner, 2026-11-24: nobody should have to build an address by hand. No code per run, and no run button for
  anyone else) and the public page says so ("coming soon" for everyone else). A live result is labelled live
  and shown beside the record at once. **Live races are real evidence (owner, 2026-11-25: a report that never
  moves however many races are run is a static report):** they are sealed by the same engine on the same locked
  tests, so they join the record through `ledger import --runner <address>` (public halves only), and from then
  on verdicts, costs and reports count them like any other match. **One verdict, one set of conditions (owner,
  2026-11-26):** a race counts in a verdict only when it was played under that record's conditions (the same
  settings, difficulty and scoring); one played under others stays on file, and the verdict says so and leaves it
  out. A model's fitness for a task counts every attempt it made under those conditions, whoever the opponent was,
  so it reads the same in every verdict. A batch of one model against itself is imported too (owner,
  2026-11-25), as a consistency check kept apart from matches (`SelfCheck`, `SelfAttempt`): its attempts count in
  that model's own fitness for the task and it reports how often the model ended the same way given the same
  scenario twice. It is never part of a head-to-head. Budgets live in the operations repo
  (`CLAUDE.md` there). The public page still costs nothing to use and needs no API keys.
- **Private halves (owner, 2026-11-22):** a match's `operator.json` (the answer key of its generated worlds) is
  published beside its record once the match is over, so anyone can re-grade it. Only for tests that generate a
  fresh world per attempt (`instances: generator`), only through `ledger import` (which checks it against the
  fingerprint in the record), and **never for a holdout or fixed test**. The graph is still built from `record.json`
  and Gladiator's `validations/*.json` only.
- **A record informs a choice; it never limits one (owner, 2026-11-24).** Any model the platform can run can be
  chosen, with or without a history, and the page shows whatever record exists. The only limit is availability
  (the runner has the model's key and price). There is one place to choose the two models, and the verdict, the
  graph and the live race are all about that pair. Honesty comes from the same world, settings and judge for
  both, and from saying how much evidence there is. The hosted live list stays to small models for the demo and
  grows as capability does.
- **Published scores only pick opponents.** The `epoch` bridge loads Epoch AI's Capabilities Index (CC BY 4.0,
  credited in `data/epoch/README.md`). Never rank or recommend by a published score, and join an Epoch name to a
  Gladiator model id only when it is an exact match (`MODEL_IDS` in `ledger/bridges/epoch.py`).
- **Relate is the store and the query engine, not an export target.** Questions are Cypher over the graph.
- **No made-up winners.** Thin evidence or a level head-to-head means no pick is named, the same as in Gladiator.
- **A report says only what the count shows** (a review of every output on 2026-11-27, after the owner asked that
  claims and evidence be handled correctly). The wording rules live in one place (`ledger/reports.py`, mirrored in
  `site/ledger.js`) and every document and screen uses them. An attempt ended as a clean run, the right result
  with a step skipped, or a wrong result: never "passed" or "failed". A scenario was decided on the result, on
  process, on efficiency, or on a tie-break taken without the right result: never on the engine's "success",
  which is two different things to a reader. Chance is said in words, never as "p = 0.0". A hazard with no trips
  is "not seen", with what that count can rule out: never "can run alone". A record is listed with its kind, and
  an answer key is promised only for the kind that has one published (a live race's stays with the runner). A
  fact the record does not hold is "not recorded", never "None". Read through a tolerance a verdict has one bar,
  the tolerance's own, and no second "good enough" beside it. Cost is given per right result and per clean run.
  Still the owner's to decide: whether a fit or not-fit call should wait for more than the 8 attempts it needs
  today.
- **Fitness is decided by the fault levels (owner, 2026-11-26).** The bar asks for the right result (every
  decision right, nothing left undone), not for the test's own pass, which also asks for its process. How a model
  got there is judged only by its faults, each at the level the reader gives it, so a fault the reader calls minor
  never makes a model unfit. The head to head still judges a pair as Gladiator does, and a verdict says how many
  scenarios were won on process alone.
- **The graph goes down to the step (owner, 2026-11-26, to make Relate carry the main use case).** Every step of
  every attempt is loaded from `record.json` (never from the answer key), with the records of each generated world
  and how they refer to each other; both attempts of a match share those records. A question about how a model
  works is a Cypher pattern over them (`STEP_PATTERNS` in `ledger/questions.py`), asked of every attempt on file.
  A reader may give one a level in a verdict (`--check`); it is then judged like any other fault and labelled as
  the reader's own, and it never touches the head to head or any verdict it was not asked for. Where the grader
  counts the same thing, the pattern must agree with it on every attempt (`tests/test_steps.py`). The steps are
  too big to ship: they live in `data/ledger-steps.rl`, built locally on first use and never committed.
- **Ledger live: the record kept in one Relate store, written to as races end (owner, 2026-11-26).** A fifteen
  minute import that could refuse itself in silence was the only way a race reached the record. `ledger serve`
  (`ledger/live.py`) is a small service of Ledger's own that keeps the whole record, steps included, in one Relate
  directory store: it takes in each sealed record the runner files (checked against its seal, kept as a file),
  and hands a page the rows of what its own copy lacks. It runs no match, holds no key, and only ever reads the
  one runner it was started with. A record added to the store must leave exactly the graph that building from
  all records leaves, which is the graph the command line builds (`tests/test_live.py`). The sealed records stay
  the master copy and the git import stays, as the archive. **The page reads it** where one is published (`record`
  in `site/data/live.json`, or `?record=`): what its own copy lacks is loaded into the graph in the tab on load,
  and a race run from the page joins as it ends and the verdict is read again. A page published before some
  records, reading a live record that holds them, must be exactly the page published after them
  (`site/check-live.cjs`, with the real service); with no live record the page is its shipped copy and says so.
  Host: a second small one (owner, 2026-11-26), deployed that day (1 GB, kept on through the judging days);
  `live.json` names it, so the hosted page reads it. Who may deploy it, and what is asked first, is in the
  operations repo's `CLAUDE.md` ("Who deploys"). The service ships as a
  container (`Dockerfile`; it carries the sealed records it starts from and no secret): CI builds and runs it,
  and publishes the image of every green commit on `main`, which is the only thing the deploy workflow in the
  operations repo will deploy.
- **A workflow has one account, whatever order its records came in.** Its text, tools and package facts are made
  from every record on file (`Flows` in `ledger/bridges/gladiator.py`), never from whichever was loaded last.
- **Quoted figures carry their date.** A figure printed in the README or the submission is the record as it stood
  at a stated moment, reproducible with `--until`; CI checks them that way. The page always reads the whole record.
- The graph is a view: records stay the master copy, and the loader must stay safe to re-run.
- **Publishing approved (owner, 2026-11-22):** real match results and costs for named models are committed in
  `data/` (the shipped store). Add records only with `ledger import` (copies sealed records, their private halves
  under the rule above, and validation records), then rebuild `data/ledger.rl` with `ledger build`; `tests/test_shipped_store.py`
  fails if the store and the records disagree.

## How work lands
- Feature branch, PR into `main`, CI green (lint and tests on Linux and Windows), squash merge.
- One exception: the `Import live races` workflow commits to `main` by itself, hourly, and only ever adds the
  runner's sealed records and the files rebuilt from them (owner, 2026-11-25: every run builds the dataset).
- Fast checks before pushing:
```bash
uv run ruff check . && uv run ruff format --check . && uv run pytest -q
```
- Schema: `docs/SCHEMA.md`. Keep it in step with `ledger/load.py` and `ledger/questions.py`.
