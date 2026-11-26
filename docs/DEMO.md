# Demo video outline (target 1:50, hard limit 2:00)

Screen recording of the browser page, with one terminal moment. No music, no third-party images, no login needed
to view. Everything except the live race runs from the public page with no API keys.

The rules also accept a link to a working demo in place of a video. Submit both.

The story: **a prediction put at risk.** Two models that tie on paper, what the record says about one task, a race
you can watch, and a fresh race that could prove the record wrong.

| Time | On screen | Say (roughly) |
|---|---|---|
| 0:00–0:15 | README, "The idea in one table" | "Claude Haiku and DeepSeek are a tie on a published leaderboard. They even cost the same. On four real workflows the right choice depends on the task and on who is asking. Ledger tells you which, with proof." |
| 0:15–0:25 | The page, step 1: the four workflow cards; click Refund queue | "Pick the workflow closest to yours. Four are tested, each with what its test catches. If yours is not here, it says so." |
| 0:25–0:40 | Step 2: Claude Haiku 5.5, then DeepSeek | "Pick two models. The ones with the most head-to-head evidence come first. A published score only finds a fair opponent. It never decides." |
| 0:40–1:00 | Step 3: the two models side by side, the scenario squares, the verdict band; set "acted without reading" to unforgivable and back; flip the tolerance to Enterprise | "Forty-three scenarios, the same generated world for both each time. Both models get every refund right. Haiku took 37, most of them on process: DeepSeek keeps deciding before it has looked a record up. Does that matter? That is my call, not the tool's. For one person it is minor, and both are fit. I make it unforgivable, and neither is. For a business running it unattended, neither is." |
| 1:00–1:20 | Click a scenario square: the race replays at 8× | "Every square is a real race I can replay. Each mark is a step: looking something up, acting, a timeout, a check. This is the sealed record played back, not a re-run." |
| 1:20–1:45 | The live panel: "…the record favours Haiku"; press Race them live; lanes fill; the result line | "Now the prediction is at risk. One brand-new scenario, generated this minute. The record favours Haiku. Watch." (pause for the finish) "In line with the record. The new result is sealed, and it is already in the graph: one more dot, its world drawn underneath, and the verdict read again with it." (scroll up to the ringed dot) |
| 1:45–2:00 | Download the spec; then `uv run ledger verify` in a terminal | "Then the build plan: the job as tested, the settings, a guardrail for each hazard. Every match is sealed and both halves are published, so anyone can check it. Relate holds it all: the graph in your browser, the same graph on the command line and for your own assistant." |

## If the live race is not available when recording
Replace 1:20–1:45 with a second replay on a task where the answer differs (Access review, same two models: no
settled lead, and for a business only DeepSeek is fit) and say: "Same two models, a different task, a different
answer." Do not present a replay as live.

## Before recording
- Load the page once so the graph is built. For a live race, start the runner first (README, "Live races").
- Re-check every number against the page on the day: the scenario counts and which model the record favours.
  Live races join the record as they end, so the page's counts move as races are run and the figures in this
  outline (the record on Nov 26) will be a little behind. Say what the page shows.
- After the live race, wait for "It is in the record now" under the result before scrolling up: that line is
  the moment the race joined, and the ringed dot in the "Relate graph" box is the race just run.
- Run one live race beforehand to see how long it takes (about half a minute to a minute), and decide whether to
  cut the wait in the edit. If you cut it, keep the start and the finish in one take and say that time was cut.
- Terminal about 120 columns, large font.

## Checklist (from the official rules)
- [ ] 2:00 or less, viewable without a login or payment
- [ ] Your own recording; no unlicensed music or images
- [ ] Shows Relate in use (the page builds the graph in the browser; `ledger verify` opens `data/ledger.rl`)
- [ ] Link in the Devpost submission, with the page's link
