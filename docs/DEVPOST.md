# Devpost submission text (draft for the owner to paste and edit)

The form asks for a title, a description of what it does and why it is useful, the repository link, setup
instructions, a demo, and a statement of the Product capabilities, third-party tools and AI tools used.

## Title
Gladiator Ledger: which of these two models does *this* task better?

## Tagline
Head-to-head evidence in a Relate graph. A task claim, a verdict you can check, and a spec you can build from.

## What it does
Two AI models that sit side by side on a leaderboard can behave very differently on your workflow. Ledger answers
one question: of these two models, which does this task better, how sure is that, and what should I build?

Its evidence is head-to-head matches. Two models play the same freshly generated worlds of a tool-using workflow
(a refund queue, an access review, incident triage, inventory transfers), and each pair of attempts is judged:
success first, then efficiency. Ledger loads those sealed match records into a Relate graph and walks it:

1. **Describe your flow.** A full-text search finds the closest tested workflow.
2. **Pick a fair opponent.** A published index is used only to find models close on paper.
3. **Get the verdict.** Who did this task better, how sure, and whether either is good enough.
4. **Get the spec.** The job and rules as tested, the settings the result holds for, a guardrail for every hazard
   the chosen model tripped on, and the sealed records behind it.

The same loop runs three ways over the same graph: a static page that builds the graph in your browser, an MCP
server for your own AI assistant, and a command line.

## Why it is useful
Choosing a model is usually done by reading rankings or by feel. Ledger replaces that with a claim about the task:
Claude Haiku 5.5 and MiniMax M3.1 Flash are compared on four workflows, and the answer changes with the task.
MiniMax handles refunds as well as needed at a fifth of the cost; on incident triage it passes 3 attempts in 15.
When the evidence is thin or level, Ledger says "leaning" or names no winner. It never makes one up.

## How Relate is used
- Embedded Python library with a single-file store, opened read-only for every question.
- Every answer is a Cypher query over connected facts: a verdict is the set of matches where two models' attempts
  share a world; a fair opponent is a neighbour over a benchmark joined to pairs already played; a guardrail is the
  gap between where a hazard could occur and where a model fell for it.
- A full-text index over workflow text for "describe your flow".
- The WebAssembly build, in memory, in a browser worker: the demo page builds the whole graph client-side with the
  same statements as the command line, and a CI check proves it gives the same answers.
- Read-only access for agents over MCP, including free-form read-only Cypher.
- Idempotent loading (`MERGE` on stable keys behind uniqueness constraints) through two "bridges": match records
  and a published benchmark index.

## Setup
```
git clone https://github.com/Loothore907/gladiator-ledger
cd gladiator-ledger
uv sync
uv run ledger verdict refund-queue --a "haiku 5.5" --b minimax-m3.1
python3 -m http.server --directory site 8000     # the browser page
```
No API keys and no cost. Linux, macOS and Windows.

## Disclosure (short form; the full statement is docs/DISCLOSURE.md)
- Ledger was started on 2026-11-21, inside the contest period. It reads the output of Gladiator, the author's
  earlier evaluation engine (Apache-2.0, public at github.com/Loothore907/gladiator-core), and reuses one small
  scoring file from it, marked in the source.
- Product capabilities used: listed under "How Relate is used" above.
- Third-party tools and data: Python, uv, pytest, ruff, the MCP Python SDK, Node.js and Playwright (to check the
  page), GitHub Actions; Epoch AI's Capabilities Index (CC BY 4.0); model APIs from Anthropic, OpenAI, Google and
  OpenRouter to play the matches.
- AI tools: the code, tests and documentation were written by Claude (Anthropic) working as a coding agent under
  the author's direction. The author set the goals and made the product, budget and publishing decisions.

## Links to fill in
- Repository: https://github.com/Loothore907/gladiator-ledger
- Working demo: (the hosted page's address, once it is live)
- Video: (if recorded)
