# Demo video outline (target 1:50, hard limit 2:00)

Screen recording of the browser page, a terminal and one assistant session. No music, no third-party images, no
login needed to view. Everything shown runs from a clean clone with no API keys.

The rules also accept a link to a working demo in place of a video. If the page in `site/` is hosted, submit both.

| Time | On screen | Say (roughly) |
|---|---|---|
| 0:00–0:15 | README, "The idea in one table" | "Two models that look the same on a leaderboard can be very different on your task. Same two models, four workflows: MiniMax does refunds as well as Haiku at a fifth of the cost, and fails incident triage. Ledger tells you which, per task, with proof." |
| 0:15–0:30 | The page, step 1: type "an agent that handles refund requests for damaged orders" | "Describe what your agent has to do. A full-text search over the graph finds the closest tested workflow, and what stands behind it: twelve models, eighty-four judged pairs." |
| 0:30–0:50 | Step 2: pick Claude Haiku 5.5, then MiniMax | "Pick the model you use. Opponents that have actually played it come first, closest on paper first. A published score only picks a fair opponent. It never decides." |
| 0:50–1:15 | Step 3: the verdict, the graph picture, the guardrail table; click Download spec | "Fifteen pairs on the same generated worlds: MiniMax won twelve. That is a settled result, and both are good enough. The spec is the build plan: the job and rules as tested, the settings, and one guardrail to build, because MiniMax acted before reading in two of fifteen attempts." |
| 1:15–1:30 | Same two models on incident triage (page or `ledger verdict incident-triage ...`) | "Ask about a different task and it says *leaning* Haiku: eleven to four, which could still be chance. It won't make up a winner." |
| 1:30–1:45 | An assistant with the `ledger` tools: ask the refund question in plain words | "The same graph is an MCP server, so your own assistant can walk the loop, read-only, with the same rules." |
| 1:45–2:00 | `uv run ledger verify`, then README "Disclosure" | "Every match is sealed, both halves are published, and anyone can check them. Built during the contest, on my Gladiator engine, written by Claude under my direction. Apache-2.0." |

## Before recording
- Serve the page (`python3 -m http.server --directory site 8000`) and load it once so the graph is built.
- Run each command once so uv is warm and output appears instantly. Terminal about 120 columns, large font.
- Re-check every number against the current store: `uv run ledger verdict refund-queue --a "haiku 5.5" --b minimax-m3.1`
  and the same for `incident-triage`.
- If no assistant session is ready, replace 1:30–1:45 with `uv run ledger spec refund-queue --a "haiku 5.5" --b minimax-m3.1`.

## Checklist (from the official rules)
- [ ] 2:00 or less, viewable without a login or payment
- [ ] Your own recording; no unlicensed music or images
- [ ] Shows Relate in use (the page builds the graph in the browser; the commands open `data/ledger.rl`)
- [ ] Link in the Devpost submission, with the hosted page's link if there is one
