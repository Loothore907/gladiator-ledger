"""The reports that go with a spec: what it costs, and the evidence behind the answer.

Both are written from the same verdict the spec is built from (`cli.verdict`), so the three documents cannot
disagree. The cost section also appears inside the spec; the reports carry the full detail.

The wording rules every document shares live here too (how an attempt ended, what a scenario was decided on, how
often chance gives a split, what kind of sealed record a run is), so a report never says more than the page does
or in other words. `site/ledger.js` carries the same rules for the page, and `site/check.cjs` holds the two to
the same text.
"""

from ledger import policy

BASIS = {
    "billed": "billed: what the provider charged for each call",
    "repriced": "repriced: recomputed from the record's token counts at the provider's published price",
    "list": "list: tokens times the provider's list price",
    "mixed": "mixed: some calls billed and some at list price within one attempt",
}

# What kind of sealed record a run is, from its suite. It decides what is published with it (ANSWER_KEYS).
KINDS = {"live-race": "live race", "live-batch": "live batch"}

# What a reader can check. Said once per document, in these words, wherever sealed records are listed. Each
# record in the list says whether its own answer key is published (record_line): a report must not promise one
# for a record that was published without it.
ANSWER_KEYS = (
    "Every record is sealed, and `ledger verify` checks each seal. Where a record's answer key (its private half) "
    "is published beside it, `ledger verify` checks it against the fingerprint the record carries, and anyone "
    "can re-grade that match from it. An answer key is published only once a match is over, and only for tests "
    "that generate a fresh world for every attempt."
)

# What a scenario was decided on, in the order a reader cares about. The engine's own rule names stay in the data
# (`decided_by`): its "success" means one side passed and the other did not, which is two different things to a
# reader (a wrong result, or a right result with a step skipped), so it is never printed.
ON = ("result", "process", "efficiency", "no result")
DECIDED_ON = {
    "result": "on the result (only the winner got it right)",
    "process": "on process (both got the right result, only the winner ran clean)",
    "efficiency": "on efficiency (level on result and process: mistakes, cost, tokens and time decided)",
    "no result": "on a tie-break the winner took without the right result",
}
WON_ON = {
    "result": "on the result (only it got the right result)",
    "process": "on process (both got the right result, only it ran clean)",
    "efficiency": "on efficiency (level on result and process)",
    "no result": "on a tie-break, without the right result",
}
MISTAKE_POINTS = (
    "Mistake points are the engine's count of what went wrong in an attempt: the grader's severity for each wrong "
    "or missing decision, 2 for each blind retry after a timeout, 1 for each action taken before reading a record "
    "it depends on, 3 for stopping without calling finish. They feed the efficiency tie-break."
)


def ended(right, clean) -> str:
    """How an attempt ended, in the three words the page uses. A clean run is what the test itself calls a pass:
    the right result and every step it asks for."""
    return "clean run" if clean else "right, a step skipped" if right else "wrong result"


def record_kind(suite) -> str:
    """A suite match, a live race or a live batch."""
    return KINDS.get(suite, "suite match")


def engine_of(commit) -> str:
    """The engine build a record names, or that it names none (the hosted runner does not record one)."""
    return f"engine commit `{str(commit)[:7]}`" if commit else "engine commit not recorded"


def record_line(e: dict) -> str:
    """One sealed record in a list: what kind it is, its seal, the engine build it names, and whether its answer
    key is published beside it."""
    key = "answer key published" if e.get("answer_key") else "no answer key published"
    return (
        f"`{e['run']}`, {record_kind(e.get('suite'))}, seal `{str(e['seal_sha256'])[:16]}`, "
        f"{engine_of(e['engine_commit'])}, {key}"
    )


def chance(p: float) -> str:
    """How often chance alone gives a split, in words: never "p = 0.0"."""
    if p < 0.001:
        return "less than 0.1%"
    return f"about {p:.1%}" if p < 0.1 else f"about {p:.0%}"


def head_to_head(d: dict, a: str, b: str, tick: str = "`") -> str:
    """The head to head in a sentence: the count, and how often two equal models would split like that."""
    line = (
        f"{d['pairs']} judged pairs on the same generated worlds: {tick}{a}{tick} won {d['wins'][a]}, "
        f"{tick}{b}{tick} won {d['wins'][b]}, {d['ties']} tied."
    )
    if d["wins"][a] != d["wins"][b] and d["p_value"] < 1:
        line += (
            f" Between two equally good models a split this lopsided would happen {chance(d['p_value'])} of the time."
        )
    return line


def decided_on(r: dict, a: str) -> str:
    """What one scenario was decided on, for a reader: the result, the process, efficiency, or a tie-break taken
    without the right result. `r` has the winner and each side's right result and clean run (`a_right`,
    `a_passed`, ...); `a` is the model on side a."""
    if r["winner"] == "tie" or not r["winner"]:
        return "tie"
    w, other = ("a", "b") if r["winner"] == a else ("b", "a")
    w_right, w_clean = bool(r[f"{w}_right"]), bool(r[f"{w}_passed"])
    l_right, l_clean = bool(r[f"{other}_right"]), bool(r[f"{other}_passed"])
    if w_clean:
        return "efficiency" if l_clean else "process" if l_right else "result"
    if w_right:
        return "efficiency" if l_right else "result"
    return "no result"


def decided_text(counts: dict, words: dict = DECIDED_ON) -> str:
    """ "45 on process (...), 27 on efficiency (...)": what the scenarios were decided on, in a fixed order."""
    return ", ".join(f"{counts[k]} {words[k]}" for k in ON if counts.get(k))


def _usd(x, places=4, none="none") -> str:
    return none if x is None else f"${x:.{places}f}"


def cost_lines(models: dict, a: str, b: str) -> list[str]:
    """The cost tables and their notes, as Markdown lines. `models` is the verdict's per-model figures."""
    lines = [
        "| Model | Cost per attempt | Cost per right result | Cost per clean run | Per 1,000 runs | Source of the cost |",
        "|---|---|---|---|---|---|",
    ]
    for name in (a, b):
        s = models[name]
        lines.append(
            f"| `{name}` | {_usd(s['cost_per_attempt'])} | {_usd(s['cost_per_right'], none='none right')} | "
            f"{_usd(s['cost_per_pass'], none='none clean')} | {_usd(s['cost_per_attempt'] * 1000, 2)} | "
            f"{', '.join(s['cost_basis'])} |"
        )
    lines += [
        "",
        "| Model | Calls per attempt | Tokens read | of which re-read from cache | Tokens written | Seconds per attempt |",
        "|---|---|---|---|---|---|",
    ]
    for name in (a, b):
        s = models[name]
        share = s["tokens_cached"] / s["tokens_in"] if s["tokens_in"] else 0.0
        lines.append(
            f"| `{name}` | {s['calls_per_attempt']:.1f} | {s['tokens_in']:,.0f} | {s['tokens_cached']:,.0f} ({share:.0%}) | "
            f"{s['tokens_out']:,.0f} | {s['seconds_per_attempt']:.0f} |"
        )
    used = sorted({basis for name in (a, b) for basis in models[name]["cost_basis"]})
    lines += [
        "",
        (
            "- Cost per right result is everything spent divided by the attempts that ended in the right result: "
            "what one right result costs, wrong ones included. Cost per clean run divides by the attempts that also "
            "followed every step the test asks for."
        ),
        (
            "- Token counts are averages per attempt. Re-read tokens are the part of the input a provider served from its "
            "cache, which it bills at a fraction of the normal price."
        ),
        (
            "- The 1,000-run figure is a straight multiple of these attempts, not a quote: your prompts, tools and "
            "volume will differ."
        ),
        "- Source of the cost: " + "; ".join(BASIS.get(x, x) for x in used) + ".",
        "",
    ]
    return lines


def _head(kind: str, title: str, v: dict) -> list[str]:
    return [
        f"# {kind}: {title}",
        "",
        f"Task `{v['task']}`, version `{v['version']}`. Compared: `{v['a']}` and `{v['b']}`.",
        "",
    ]


def cost_markdown(v: dict, title: str) -> str:
    a, b = v["a"], v["b"]
    lines = _head("Cost breakdown", title, v)
    if v["verdict"] == "no data":
        return "\n".join([*lines, f"**No costs.** {v['notes'][0]}", ""])
    lines += [f"Measured over the {v['pairs']} head-to-head pairs these two models played on this task.", ""]
    lines += cost_lines(v["models"], a, b)
    lines += ["## Total spent in these matches", ""]
    for name in (a, b):
        s = v["models"][name]
        lines.append(
            f"- `{name}`: ${s['spent']:.4f} over {s['attempts']} attempts: {s['right']} ended in the right result, "
            f"{s['passed']} of them clean runs."
        )
    if v.get("rounds"):
        lines += [
            "",
            "## Scenario by scenario",
            "",
            (
                "What each attempt cost and how it ended: a clean run (the right result and every step the test asks "
                "for), the right result with a step skipped, or a wrong result."
            ),
            "",
            f"| # | `{a}` | `{b}` | Sealed record |",
            "|---|---|---|---|",
        ]
        for i, r in enumerate(v["rounds"], 1):
            cells = [
                f"${r[f'{side}_cost'] or 0:.4f} ({ended(r[f'{side}_right'], r[f'{side}_passed'])})"
                for side in ("a", "b")
            ]
            lines.append(f"| {i} | {cells[0]} | {cells[1]} | `{r['run']}` |")
    lines += ["", "Costs are for a simulated world under the settings in the spec. Measure again on the real flow.", ""]
    return "\n".join(lines)


def evidence_markdown(v: dict, title: str) -> str:
    a, b = v["a"], v["b"]
    lines = _head("Evidence report", title, v)
    if v["verdict"] == "no data":
        return "\n".join([*lines, f"**No evidence.** {v['notes'][0]}", ""])
    if v.get("headline"):
        lines += [f"**{v['headline']}**", "", f"## Fit for this task, at {v['profile']} tolerance", ""]
        lines += [
            (
                "Every attempt each model made on this task counts here, whoever the opponent was. A model is called "
                "fit or not fit only when its attempts settle it; until then the report says what they show so far."
            ),
            "",
        ]
        for name in (a, b):
            f = v["fit"][name]
            lines += [
                f"### `{name}`: {policy.standing(f)}",
                "",
                policy.result_line(f),
                "",
            ]
            if f["faults"]:
                lines += ["| Fault | Level | Attempts with it | Counts against fitness |", "|---|---|---|---|"]
                lines += [
                    f"| {x['fault']} | {x['level']} | {x['attempts_with']} of {f['attempts']} | "
                    f"{('yes' if x['settled'] else 'so far: too few attempts to be sure') if x['breaks'] else 'no'} |"
                    for x in f["faults"]
                ]
            else:
                lines.append("No fault recorded.")
            lines.append("")
    lines += ["## Head to head", "", head_to_head(v, a, b), ""]
    lines += [f"- {n}" for n in v["notes"]] + ([""] if v["notes"] else [])
    if v.get("rounds"):
        lines += [
            (
                "Each attempt ended one of three ways: a clean run (the right result and every step the test asks "
                "for, which is what the test itself calls a pass), the right result with a step skipped, or a wrong "
                "result."
            ),
            "",
            f"| # | Winner | Decided on | `{a}` | `{b}` | Sealed record |",
            "|---|---|---|---|---|---|",
        ]
        for i, r in enumerate(v["rounds"], 1):
            winner = "tie" if r["winner"] == "tie" else f"`{r['winner']}`"
            lines.append(
                f"| {i} | {winner} | {r['on']} | {ended(r['a_right'], r['a_passed'])} | "
                f"{ended(r['b_right'], r['b_passed'])} | `{r['run']}` |"
            )
        lines.append("")
    lines += ["## Sealed records", ""]
    lines += [f"- {record_line(e)}" for e in v["evidence"]]
    lines += ["", ANSWER_KEYS, ""]
    return "\n".join(lines)
