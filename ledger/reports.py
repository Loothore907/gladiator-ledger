"""The reports that go with a spec: what it costs, and the evidence behind the answer.

Both are written from the same verdict the spec is built from (`cli.verdict`), so the three documents cannot
disagree. The cost section also appears inside the spec; the reports carry the full detail.
"""

BASIS = {
    "billed": "billed: what the provider charged for each call",
    "repriced": "repriced: recomputed from the record's token counts at the provider's published price",
    "list": "list: tokens times the provider's list price",
    "mixed": "mixed: some calls billed and some at list price within one attempt",
}


def _usd(x, places=4) -> str:
    return "none passed" if x is None else f"${x:.{places}f}"


def cost_lines(models: dict, a: str, b: str) -> list[str]:
    """The cost tables and their notes, as Markdown lines. `models` is the verdict's per-model figures."""
    lines = [
        "| Model | Cost per attempt | Cost per passed attempt | Per 1,000 runs | Per 1,000 passed runs | Source of the cost |",
        "|---|---|---|---|---|---|",
    ]
    for name in (a, b):
        s = models[name]
        per_pass = s["cost_per_pass"]
        lines.append(
            f"| `{name}` | {_usd(s['cost_per_attempt'])} | {_usd(per_pass)} | {_usd(s['cost_per_attempt'] * 1000, 2)} | "
            f"{_usd(None if per_pass is None else per_pass * 1000, 2)} | {', '.join(s['cost_basis'])} |"
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
            f"| `{name}` | {s['calls_per_attempt']:.1f} | {s['tokens_in']:.0f} | {s['tokens_cached']:.0f} ({share:.0%}) | "
            f"{s['tokens_out']:.0f} | {s['seconds_per_attempt']:.0f} |"
        )
    used = sorted({basis for name in (a, b) for basis in models[name]["cost_basis"]})
    lines += [
        "",
        (
            "- Cost per passed attempt is everything spent divided by the attempts that passed: what one successful "
            "result costs, failures included."
        ),
        (
            "- Token counts are averages per attempt. Re-read tokens are the part of the input a provider served from its "
            "cache, which it bills at a fraction of the normal price."
        ),
        (
            "- The 1,000-run figures are straight multiples of these attempts, not a quote: your prompts, tools and "
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
        lines.append(f"- `{name}`: ${s['spent']:.4f} over {s['attempts']} attempts, {s['passed']} passed.")
    if v.get("rounds"):
        lines += ["", "## Scenario by scenario", "", f"| # | `{a}` | `{b}` | Sealed record |", "|---|---|---|---|"]
        for i, r in enumerate(v["rounds"], 1):
            cells = [
                f"${r[f'{side}_cost'] or 0:.4f} ({'passed' if r[f'{side}_passed'] else 'failed'})"
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
        lines += ["Every attempt each model made on this task counts here, whoever the opponent was.", ""]
        for name in (a, b):
            f = v["fit"][name]
            word = {True: "fit", False: "not fit", None: "too few attempts to say"}[f["fit"]]
            lines += [
                f"### `{name}`: {word}",
                "",
                f"Passed {f['passed']} of {f['attempts']} attempts ({f['pass_rate']:.0%}; bar {f['bar']:.0%}).",
                "",
            ]
            if f["faults"]:
                lines += ["| Fault | Level | Attempts with it | Counts against fitness |", "|---|---|---|---|"]
                lines += [
                    f"| {x['fault']} | {x['level']} | {x['attempts_with']} of {f['attempts']} | "
                    f"{'yes' if x['breaks'] else 'no'} |"
                    for x in f["faults"]
                ]
            else:
                lines.append("No fault recorded.")
            lines.append("")
    lines += [
        "## Head to head",
        "",
        (
            f"{v['pairs']} judged pairs on the same generated worlds: `{a}` won {v['wins'][a]}, `{b}` won "
            f"{v['wins'][b]}, {v['ties']} tied (sign test p = {v['p_value']})."
        ),
        "",
    ]
    lines += [f"- {n}" for n in v["notes"]] + ([""] if v["notes"] else [])
    if v.get("rounds"):
        lines += [f"| # | Winner | Decided on | `{a}` | `{b}` | Sealed record |", "|---|---|---|---|---|---|"]
        for i, r in enumerate(v["rounds"], 1):
            winner = "tie" if r["winner"] == "tie" else f"`{r['winner']}`"
            lines.append(
                f"| {i} | {winner} | {r['rule']} | {'passed' if r['a_passed'] else 'failed'} | "
                f"{'passed' if r['b_passed'] else 'failed'} | `{r['run']}` |"
            )
        lines.append("")
    lines += ["## Sealed records", ""]
    lines += [
        f"- `{e['run']}`, seal `{str(e['seal_sha256'])[:16]}`, engine commit `{str(e['engine_commit'])[:7]}`"
        for e in v["evidence"]
    ]
    lines += [
        "",
        (
            "Each record's public half and private answer key are published; `ledger verify` checks every seal, and "
            "anyone can re-grade a match from them."
        ),
        "",
    ]
    return "\n".join(lines)
