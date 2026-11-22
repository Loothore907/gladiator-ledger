# Demo video outline (target 1:50, hard limit 2:00)

Screen share of a terminal plus the README. No music, no third-party images, no login needed to view.
Everything shown runs from a clean clone with no API keys. Record at a large terminal font (about 18 pt).

| Time | On screen | Say (roughly) |
|---|---|---|
| 0:00–0:12 | README title | "Which model should run my workflow, on my budget, and what's the proof? Ledger answers that from real head-to-head matches, using a Relate graph." |
| 0:12–0:25 | `git clone`, `uv sync` (pre-warmed) | "Clone it, sync, done. It ships a Relate store built from 25 real matches between 12 models, so there are no keys and no cost." |
| 0:25–0:50 | `uv run ledger recommend --suite small-tier --budget 0.05` | "For these four workflows under five cents an attempt, two open-weights models lead Claude Haiku at under half the cost. Between them it says *leaning* DeepSeek: 14 to 10 against MiniMax, which happens by chance half the time. It won't make up a winner." |
| 0:50–1:02 | `uv run ledger ask head_to_head` for DeepSeek and Haiku | "Ask about two models directly and the evidence can be clear: DeepSeek beat Haiku 20 to 4 on the same generated worlds." |
| 1:02–1:20 | `uv run ledger ask hazard_profile`, highlight the "acted without reading" rows | "Where do models fail? The commonest slip is deciding before reading the records: DeepSeek in 12 of 72 attempts. After a timeout, though, ten of twelve models always checked before retrying." |
| 1:20–1:35 | `uv run ledger ask beat_cycles` | "And the ranking isn't always a ladder: on refunds, Haiku beat Gemini Flash-Lite, which beat Luna, which beat Haiku. That's a cycle in the graph, which a leaderboard would hide." |
| 1:35–1:50 | `docs/SCHEMA.md` diagram/table, then `ledger/questions.py` | "Every answer is one Cypher query over the graph: runs, matches, models, test versions, hazards and validation evidence. Records stay sealed; the store rebuilds from them." |
| 1:50–2:00 | README "Disclosure" | "Built during the contest on my earlier Gladiator engine, written by Claude under my direction. Apache-2.0." |

## Before recording
- Run each command once so uv is warm and output appears instantly.
- Set the terminal width to about 120 columns so the tables don't wrap.
- Re-check the numbers against the current `data/ledger.rl`, in case new matches were added after this outline.

## Checklist (from the submission rules)
- [ ] 2:00 or less, viewable without a login (YouTube unlisted or Vimeo)
- [ ] No unlicensed music or images
- [ ] Shows Relate running (the commands above open `data/ledger.rl`)
- [ ] Link in the Devpost submission
