# Devpost submission text (draft for the owner to paste and edit)

The form asks for a title, a description of what it does and why it is useful, the repository link, setup
instructions, a demo, and a statement of the Product capabilities, third-party tools and AI tools used.

## Title
Gladiator Ledger: which of these two models does *this* task better?

## Tagline
Two models, one task, a prediction put at risk: head-to-head evidence in a Relate graph, a verdict you can check,
a race you can watch, and a spec you can build from.

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
   result then joins the record, so the verdict moves as races are run. (Open to judges: "Judge sign-in" on the
   page, with the access code.)
6. **Get the spec.** The job and rules as tested, the settings the result holds for, a guardrail for every hazard,
   and the sealed records behind it.

The recorded loop runs three ways over the same graph: a static page that builds the graph in your browser, an MCP
server for your own AI assistant, and a command line.

## Why it is useful
Choosing a model is usually done by reading rankings or by feel. Ledger replaces that with a claim about the task.
Claude Haiku 5.5 and DeepSeek V4.1 Flash score 0.9 points apart on a published capability index, a tie on paper,
and cost about the same. Over 166 head-to-head scenarios on four workflows (the record at 05:00 UTC on Nov 26,
2026) the answer changes with the task and with who is asking. Haiku is the settled choice on two workflows.
DeepSeek gets the right result more often on all four, and on access reviews it is the only one of the two a
business could run unattended: Haiku made one wrong access decision in 81 attempts. On a refund queue both decide
every refund correctly, and Haiku wins on process: in two attempts of three DeepSeek decides a request before
looking up a record it was told to read. Ledger does not decide whether that matters. It counts it, gives it a
level you can change, and shows the answer for one person (minor: both are fit) and for a business (serious:
neither is). When the evidence is thin or level it says "leaning" or names no winner, and when neither model is
fit it says so and lists the tested models that are.

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
  browser: it loads the steps of a scenario, or of a whole task, into its own graph and runs the same patterns.
- **Full-text index** over each workflow's text for step 1.
- **The WebAssembly build, in memory, in a browser worker.** The demo page builds the whole graph client-side
  with the same statements as the command line, and a CI check compares more than 8,000 values between the two,
  including the downloadable spec character for character.
- **Read-only access for agents over MCP**, including free-form read-only Cypher.
- **Idempotent loading** (`MERGE` on stable keys behind uniqueness constraints) through two bridges: match records
  and a published benchmark index. 11 kinds of node and 17 relationships in the shipped store; with the steps
  (62,374 of them, loaded locally from the same records on first use), 13 and 24.

## Setup
```
git clone https://github.com/Loothore907/gladiator-ledger
cd gladiator-ledger
uv sync
uv run ledger verdict refund-queue --a "haiku 5.5" --b deepseek-v4.1
python3 -m http.server --directory site 8000     # the browser page
```
No API keys and no cost. Linux, macOS and Windows. The record grows as live races are run; add
`--until 2026-11-26T05:00` to a command to get the figures quoted here and in the README exactly.

## Before and during the contest (the contest opened Nov 11, 2026)
| When | What |
|---|---|
| October 2026 | The idea for Gladiator, a head-to-head model evaluation engine. No code. |
| Nov 18–20 | Gladiator's first code: a pilot runner and ten fixed test cases. Ledger does not use them. |
| Nov 20–22 | The Gladiator engine as Ledger's data uses it (match engine, tool-workflow tests, validation, suites, all matches), public as github.com/Loothore907/gladiator-core. |
| Nov 21 onward | All of Ledger: bridges and loader, graph schema, Cypher questions, the fit policy, commands, MCP server, browser demo page with its race view, tests and the shipped store. Also, in Gladiator, for this entry: live step reporting and the race runner. |

No code in either project predates the contest. Ledger imports no Gladiator code; it reads Gladiator's output files
and copies one small scoring file, marked in the source. The full statement is `docs/DISCLOSURE.md`.

## Capabilities, tools and AI use
- Product capabilities used: listed under "How Relate is used" above.
- Third-party tools and data: Python, uv, pytest, ruff, the MCP Python SDK, Node.js and Playwright (to check the
  page), GitHub Actions and GitHub Pages; Epoch AI's Capabilities Index (CC BY 4.0); model APIs from Anthropic,
  OpenAI, Google and OpenRouter to play the matches.
- AI tools: the code, tests and documentation were written by Claude (Anthropic) working as a coding agent under
  the author's direction. The author set the goals and made the product, budget and publishing decisions.
- Ledger is independent: not affiliated with or endorsed by any model provider.

## Links to fill in
- Repository: https://github.com/Loothore907/gladiator-ledger
- Working demo: https://ledger.gladiatorbench.com/
- Live races for judges: (the page's address and the access code for its "Judge sign-in" button; they go in the private testing instructions)
- Video: (if recorded)
