# Devpost submission text (draft for the owner to paste and edit)

The form asks for a title, a description of what it does and why it is useful, the repository link, setup
instructions, a demo, and a statement of the Product capabilities, third-party tools and AI tools used.

## Title
Gladiator Ledger: which model does *this* task better?

(52 characters. Devpost's title and tagline fields are short: check each against the form's own counter.)

## Tagline
Two models, one task: head-to-head evidence in a Relate graph down to every step, a verdict you can check, and
a live race that joins the graph as it ends.

(155 characters.)

## What it does
Two AI models that sit side by side on a leaderboard can behave very differently on your workflow. Ledger answers
one question in two parts: is each model **fit for this task** under your tolerance for mistakes, and which one
**did it better** head to head?

Its evidence is head-to-head matches from the open Gladiator engine. Two models play the same freshly generated
worlds of a tool-using workflow (a refund queue, an access review, incident triage, inventory transfers), and each
pair of attempts is judged: success first, then efficiency. Ledger loads the sealed records into a Relate graph
and walks it:

1. **Pick the workflow closest to yours.** Every tested workflow is shown with what its test catches. Describing
   yours only puts the closest first, and says so when nothing matches.
2. **Pick two models.** Opponents with the most head-to-head evidence come first. A published index is used only
   to find models close on paper.
3. **Read the verdict.** Fit first, in two parts: did the model get the right result often enough, and how
   serious are the faults it made on the way. Every fault is counted, with a level you can change (unforgivable,
   serious, minor) under two ready-made tolerances, one for a business running it unattended and one for a single
   person. Then the head to head, scenario by scenario.
4. **Watch the race.** Any recorded scenario replays step by step: both models on the same world, at the pace
   they really ran, with the faults where they happened.
5. **Race them live.** The graph states what the record expects, a runner plays one brand-new scenario (or a
   batch of 10 or 25), and the page says whether the result was in line with the record or against it. The sealed
   result joins the record as the race ends: seconds later it is one more cell in the evidence graph, its world is
   drawn under the rows, and the verdict has been read again with it. (This is the one part that calls a paid
   model API, so your own API key pays for it: pasted on the hosted page, which uses it for that race and stores
   it nowhere, or kept on your own machine with the two commands under "Setup" below. The video shows one.)
6. **Get the spec.** The job and rules as tested, the settings the result holds for, a guardrail for every fault
   the model made (how often, and what to build against it) and for every hazard the test plants,
   and the sealed records behind it.

The recorded loop runs three ways over the same graph: a static page that builds the graph in your browser, an MCP
server for your own AI assistant, and a command line.

## Why it is useful
Choosing a model is usually done by reading rankings or by feel. Ledger replaces that with a claim about the task.
Claude Haiku 5.5 and DeepSeek V4.1 Flash score 0.9 points apart on a published capability index, a tie on paper,
and cost about the same. Over 166 head-to-head scenarios on four workflows (the record at 05:00 UTC on Nov 26,
2026) the answer changes with the task and with who is asking. Haiku is the settled choice on two workflows.
DeepSeek gets the right result more often on all four, and on access reviews it is the only one of the two a
business could run unattended: Haiku made one wrong access decision in 81 attempts. On a refund queue both got
every refund right in all 43 scenarios they shared (over all its 81 refund attempts, whoever the opponent, Haiku
has one wrong decision), and Haiku wins on process: in 65 of its 95 attempts DeepSeek decided a request without
ever looking up a record it was told to read. Ledger does not decide whether that matters. It counts it, gives it a
level you can change, and shows the answer for one person (minor: both are fit) and for a business (serious:
neither is). When a lead could still be chance it says "leaning"; when the evidence is thin or the split is one
two equal models would produce most of the time (20 to 19), it names no winner. It calls a model fit or
not fit only when its attempts settle that, and until then says what they show so far. When neither model is fit
it says so and lists the tested models that are.

## How Relate is used
- **Embedded Python library, single-file store**, opened read-only for every question.
- **Every answer is a Cypher query over connected facts.** A verdict is the set of matches where two models'
  attempts share a world. Fitness follows each model through every attempt it made on a task, whoever the
  opponent, to the faults it made there. A task's own mix-ups ("should close, did escalate") are linked as kinds
  of a wrong decision, so a rule set on the general fault reaches the specific ones.
- **The graph goes down to the step.** Every attempt is a path of steps through a small world of connected records
  (a refund request, its order, the order's customer), and both models of a match walk the same records. A
  question about how a model works is then a pattern: "decided a refund before it had seen the customer" is three
  hops and an ordering; "repeated a timed-out action without checking" is a walk along the route
  (`(first)-[:NEXT]->+(again)`). Two such patterns ask what Gladiator's grader counted during the matches, and
  the graph agrees with it on all 1,874 attempts. A sharper one, asked in order, finds 18 attempts the grader
  passed, and shows that on the refund queue the skipped lookup never cost a wrong decision. A reader gives any
  of them a level and the verdict follows. No new match is played for any of it. The page does the same in the
  browser: it loads the steps of a scenario, or of a whole task, into its own graph, runs the same patterns, and
  draws a scenario as a graph of its records with both models' routes on it, filling in as the race plays.
- **One live store, written to as races end.** A small service of Ledger's own (`ledger serve`) keeps the whole
  record, every step included, in one Relate store that stays open. It takes in each sealed record the race
  runner files, checked against its seal, and hands the page what the page's own copy lacks. Relate lets one
  process write a store and ties a connection to the thread that opened it, so the store is in Relate's
  directory format and one thread owns the connection. Adding a race takes a tenth of a second. Records added
  one at a time, in any order, must leave exactly the graph that building from all of them leaves, and a test
  holds it node for node.
- **Full-text index** over each workflow's text for step 1.
- **The WebAssembly build, in memory, in a browser worker.** The demo page builds the whole graph client-side
  with the same statements as the command line, and a CI check compares more than 20,000 values between the
  two, including the downloadable spec character for character. A second check runs the real live service
  beside a real browser: a page published before four races, reading the live store, must end up as the page
  published after them, the same graph node by node and link by link.
- **Read-only access for agents over MCP**, including free-form read-only Cypher.
- **Idempotent loading** (`MERGE` on stable keys behind uniqueness constraints) through two bridges: match records
  and a published benchmark index. 13 kinds of node and 16 kinds of relationship in the shipped store; with the
  steps (62,374 of them at the date above, loaded locally from the same records on first use), 15 and 23.
- **A store a judge can open.** `data/ledger.rl` is committed. `uv run ledger cypher "MATCH ..."` runs any
  read-only statement over it from the command line, the assistant server takes the same through `read_graph`,
  and the page shows the statement behind each answer with what came back.

## Setup
```
git clone https://github.com/Loothore907/gladiator-ledger
cd gladiator-ledger
uv sync
uv run ledger verdict refund-queue --a "haiku 5.5" --b deepseek-v4.1
uv run ledger process refund-queue --a "haiku 5.5" --b deepseek-v4.1   # how each got there, from the steps
uv run ledger cypher "MATCH (m:Model)<-[:BY]-(a:Attempt) RETURN m.name AS model, count(a) AS attempts ORDER BY attempts DESC"   # the store itself, read-only
python3 -m http.server --directory site 8000     # the browser page
```
No API keys and no cost. Linux, macOS and Windows. The record grows as live races are run; add
`--until 2026-11-26T05:00` to a command to get the figures quoted here and in the README exactly. A page served
from a clone shows the record as it ships and says so.

**The live race, with your own API key** (the only part that needs one; README, "Race two models live, with your
own API key"). Two ways, the same engine and tests.

*On the hosted page.* Open https://ledger.gladiatorbench.com/, pick a workflow and two models, press "Race them
here with my own API key", paste the key of each model's provider and press "Race them live". 23 models of four
providers (OpenRouter, Anthropic, OpenAI, Google). The key goes to the race runner with that race and to its
provider; it is checked first for nothing, used for the one race and kept in no file, log or record; the page
holds it in that tab only. A race costs at most $0.40 between small models and $1.00 with a mid-tier one, shown
before you press.

*On your own machine,* where the key never leaves it. The race runner is Gladiator, the open engine the matches were played on. It reads the key from
`.env` in its folder, or from an environment variable of the same name:
```
git clone https://github.com/Loothore907/gladiator-core && cd gladiator-core && uv sync
cp .env.example .env        # fill in ONE line: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY
uv run gladiator serve --track suites/mid_tier.yaml=1.00   # this machine only; says which models it can offer
```
and in a second terminal, in gladiator-ledger:
```
uv run ledger serve --runner http://127.0.0.1:8787 --page     # prints the address to open
```
| Key | Provider | Models it can race |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter | DeepSeek V4.1 Flash, MiniMax M3.1 Flash, Qwen 3.8 27B, GLM-5.3 |
| `ANTHROPIC_API_KEY` | Anthropic | Claude Haiku 5.5, Claude Sonnet 5.5 |
| `OPENAI_API_KEY` | OpenAI | GPT-6 Luna, GPT-6.1 Terra |
| `GEMINI_API_KEY` | Google | Gemini 3.1 Flash-Lite, Gemini 3.5 Flash-Lite |

Any one key is enough. An OpenRouter key shows the most: the record already holds a verdict for every pair of its
four models, so the race joins one (the README says what the record holds for each key's pairs).

On the page: pick a workflow, two models marked "can race live", and press "Race them live". A race between two
small models has cost about one cent; the runner will not spend more than $0.25 on a race or $5.00 in all. The key
stays on your machine and goes only to its own provider.

## Before and during the contest (the contest opened Nov 11, 2026)
| When | What |
|---|---|
| October 2026 | The idea for Gladiator, a head-to-head model evaluation engine. No code. |
| Nov 18–20 | Gladiator's first code: a pilot runner and ten fixed test cases. Ledger does not use them. |
| Nov 20–22 | The Gladiator engine as Ledger's data uses it (match engine, tool-workflow tests, validation, suites, all matches), public as github.com/Loothore907/gladiator-core. |
| Nov 21 onward | All of Ledger: bridges and loader, graph schema, Cypher questions, the fit policy, commands, MCP server, browser demo page with its race view, the steps in the graph and the questions asked of them, the live record service and its container, tests and the shipped store. Also, in Gladiator, for this entry: live step reporting and the race runner. |

No code in either project predates the contest. Ledger imports no Gladiator code; it reads Gladiator's output files
and copies one small scoring file, marked in the source. The full statement is `docs/DISCLOSURE.md`.

## Capabilities, tools and AI use
- Product capabilities used: listed under "How Relate is used" above.
- Third-party tools and data: Python, uv, pytest, ruff, the MCP Python SDK, Node.js and Playwright (to check the
  page), GitHub Actions and GitHub Pages, Docker and GitHub's container registry (the live record's image) and
  Fly.io (hosting for the race runner and the live record); Epoch AI's Capabilities Index (CC BY 4.0); model
  APIs from Anthropic, OpenAI, Google and OpenRouter to play the matches.
- AI tools: the code, tests and documentation were written by Claude (Anthropic) working as a coding agent under
  the author's direction. The author set the goals and made the product, budget and publishing decisions.
- Ledger is independent: not affiliated with, sponsored by or endorsed by Neo4j or any model provider. Relate is
  named only to say what the project is built on.

## Links to fill in
- Repository: https://github.com/Loothore907/gladiator-ledger
- Working demo: https://ledger.gladiatorbench.com/
- Live races: **no access code for judges** (the hackathon manager's answer on the contest forum, 2026-11-27:
  "Please don't use a shared access code. Judges will supply their own API keys for any feature that calls a
  paid model"). The live race is paid for with the key of whoever runs it: pasted on the hosted page for one
  visit, or read from `.env` on their own machine, both as under "Setup" above. The README says which providers
  and models and where the key goes. Nothing private goes on the form.
- Screenshots for the gallery: `docs/img/` (taken from the page; retake them on the day the video is recorded).
- Video: **needed, and it must show a live race working** (the same answer: "Your demo video or demo link, plus
  the README, is what judges will rely on, so make sure the video shows the live run working"). Shots to get:
  the two commands being started, with the key's line in `.env` never on screen; the page saying which runner it
  is using; a pair picked and what the record expects of it; the race itself, both lanes; the result beside the
  record; the new cell in the evidence graph and the verdict read again.
