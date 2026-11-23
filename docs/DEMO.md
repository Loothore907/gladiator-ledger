# Demo video outline (target 1:50, hard limit 2:00)

Screen recording of the browser page, with one terminal moment. No music, no third-party images, no login needed
to view. Everything except the live race runs from the public page with no API keys.

The rules also accept a link to a working demo in place of a video. Submit both.

The story: **a prediction put at risk.** Two models that tie on paper, what the record says about one task, a race
you can watch, and a fresh race that could prove the record wrong.

| Time | On screen | Say (roughly) |
|---|---|---|
| 0:00–0:15 | README, "The idea in one table" | "Claude Haiku and DeepSeek are a tie on a published leaderboard. They even cost the same. On four real workflows the right choice depends on the task and on who is asking. Ledger tells you which, with proof." |
| 0:15–0:25 | The page, step 1: the four workflow cards; click Access review | "Pick the workflow closest to yours. Four are tested, each with what its test catches. If yours is not here, it says so." |
| 0:25–0:40 | Step 2: Claude Haiku 5.5, then DeepSeek | "Pick two models. The ones with the most head-to-head evidence come first. A published score only finds a fair opponent. It never decides." |
| 0:40–1:00 | Step 3: the two models side by side, the scenario squares, the comparison, the verdict band; flip the tolerance to Enterprise | "Sixteen scenarios, the same generated world for both each time. DeepSeek took eleven, which is a lead, not yet proof, and it says so. Every fault is counted, and I decide how serious each one is. For one person both are fit. For a business running it unattended only DeepSeek is: Haiku made one wrong decision in 54 attempts." |
| 1:00–1:20 | Click a scenario square: the race replays at 8× | "Every square is a real race I can replay. Each mark is a step: looking something up, acting, a timeout, a check. This is the sealed record played back, not a re-run." |
| 1:20–1:45 | The live panel: "…the record leans to DeepSeek"; press Race them live; lanes fill; the result line | "Now the prediction is at risk. One brand-new scenario, generated this minute. The record leans DeepSeek. Watch." (pause for the finish) "In line with the record, and the new result is sealed and on file." |
| 1:45–2:00 | Download the spec; then `uv run ledger verify` in a terminal | "Then the build plan: the job as tested, the settings, a guardrail for each hazard. Every match is sealed and both halves are published, so anyone can check it. Relate holds it all: the graph in your browser, the same graph on the command line and for your own assistant." |

## If the live race is not available when recording
Replace 1:20–1:45 with a second replay on a task where the result flips (Refund queue, same two models: Haiku is
fit, DeepSeek is not) and say: "Same two models, a different task, the opposite answer." Do not present a replay
as live.

## Before recording
- Load the page once so the graph is built. For a live race, start the runner first (README, "Live races").
- Re-check every number against the page on the day: the scenario counts and which model the record favours.
- Run one live race beforehand to see how long it takes (about half a minute to a minute), and decide whether to
  cut the wait in the edit. If you cut it, keep the start and the finish in one take and say that time was cut.
- Terminal about 120 columns, large font.

## Checklist (from the official rules)
- [ ] 2:00 or less, viewable without a login or payment
- [ ] Your own recording; no unlicensed music or images
- [ ] Shows Relate in use (the page builds the graph in the browser; `ledger verify` opens `data/ledger.rl`)
- [ ] Link in the Devpost submission, with the page's link
