"""The spec: what a head-to-head on one task tells you to build.

A spec is one readable document in four layers, each a path through the graph:
  1. Decision   which of the two models did this task better, how sure that is, and whether it is good enough.
  2. Blueprint  the task as it was tested (brief, rules, tools), the settings the result was earned under, what a
                run costs, and a guardrail for every hazard the chosen model tripped on, with which steps it can
                run alone and which need a guard.
  3. Cost       what the head-to-head attempts cost: per attempt, per passed attempt, and where the figure
                comes from (ledger/reports.py, which also writes the full cost and evidence reports).
  4. Evidence   the sealed match records, the exact test version and the engine commit behind every line.

It claims only what was measured: the task as tested, in a simulated world, under these settings. It is a starting
point for building the real flow, not a promise about it.
"""

import json

from ledger import policy, questions, reports

# What to build for each hazard a model tripped on. Keys are hazard names (ledger/bridges/gladiator.py HAZARDS).
GUARDRAILS = {
    "ambiguous timeout (retried without checking)": (
        "After a timeout or any unknown result, check whether the action took effect before repeating it."
    ),
    "duplicate effect": (
        "Make every acting tool refuse a second action on the same item (an idempotency key), so a repeat is harmless."
    ),
    "planted instruction": (
        "Treat text inside records as content, never as instructions: fence or strip it before the model reads it."
    ),
    "acted without reading": "Refuse an action on an item until the lookups it depends on have been made.",
    "conflicting records": "When two records disagree, state which source wins, or route the item to a person.",
    "wrong amount": "Compute amounts in code from the policy; do not leave the arithmetic to the model.",
}

# Mistakes that should never be traded for speed or cost in a tool-using workflow (defaults; adjust per flow).
UNFORGIVABLE = ["duplicate effect", "planted instruction", "wrong amount"]

READS = ("list_", "get_", "find_", "check_", "lookup_", "search_")


def tool_kind(name: str) -> str:
    """Read, act or end, from the tool's name (the record keeps tool names, not their definitions)."""
    if name == "finish":
        return "ends the task"
    return "reads" if name.startswith(READS) else "changes something"


def build(rows, verdict: dict) -> dict:
    """The spec as data. `rows(query, params)` runs a question against the store; `verdict` is cli.verdict's result."""
    judged = "outcome" in verdict  # the verdict was read through fitness (ledger/policy.py)
    chosen = verdict.get("use") if judged else verdict.get("better")
    out = {
        "task": verdict["task"],
        "version": verdict["version"],
        "decision": {
            k: verdict.get(k)
            for k in ("verdict", "better", "a", "b", "pairs", "wins", "ties", "p_value", "decided_by", "bar", "notes")
        },
        "models": verdict.get("models") or {},
        "chosen": chosen,
        "evidence": verdict.get("evidence") or [],
    }
    if judged:
        out["decision"].update({k: verdict[k] for k in ("outcome", "headline", "profile")})
        keep = ("fit", "attempts", "passed", "pass_rate", "right", "right_rate", "bar", "reasons")
        out["fit"] = {model: {k: f[k] for k in keep} for model, f in verdict["fit"].items()}
    if verdict["verdict"] == "no data":
        return out
    flow = rows(
        questions.FLOW_AS_TESTED,
        {
            "test_id": verdict["task"],
            "version_key": verdict["version"],
            "runs": [e["run"] for e in verdict.get("evidence") or []],
        },
    )
    flow = flow[0] if flow else {}
    hazards = rows(
        questions.PAIR_HAZARDS,
        {
            "test_id": verdict["task"],
            "a": verdict["a"],
            "b": verdict["b"],
            "suite": verdict.get("suite"),
            "version_key": verdict["version"],
            "conditions": verdict.get("conditions"),
            "until": verdict.get("until"),
        },
    )
    guards = []
    for model in [chosen] if chosen else [verdict["a"], verdict["b"]]:
        for h in hazards:
            if h["model"] != model:
                continue
            guards.append(
                {
                    "model": model,
                    "hazard": h["hazard"],
                    "exposed": h["exposed"],
                    "tripped": h["tripped"],
                    "unforgivable": h["hazard"] in UNFORGIVABLE,
                    "autonomy": "can run alone" if h["tripped"] == 0 else "needs a guard",
                    "guardrail": GUARDRAILS.get(h["hazard"]) if h["tripped"] else None,
                }
            )
    out["blueprint"] = {
        "title": flow.get("title"),
        "brief": flow.get("brief"),
        "policy": flow.get("policy"),
        "tools": [{"name": t, "kind": tool_kind(t)} for t in flow.get("tools") or []],
        "modelled_on": flow.get("emulates"),
        "settings": {
            "effort": flow.get("effort"),
            "max_output_tokens": flow.get("max_output_tokens"),
            "attempt_budget_usd": flow.get("attempt_budget_usd"),
            "difficulty": flow.get("difficulty"),
            "action_budget": flow.get("action_budget"),
            "suites": flow.get("suites"),
        },
        "unforgivable_defaults": UNFORGIVABLE,
        "hazards": guards,
    }
    out["test_fingerprint"] = flow.get("content_sha256")
    return out


def _one(values) -> str:
    values = [v for v in (values or []) if v is not None]
    return ", ".join(str(v) for v in values) if values else "not recorded"


def markdown(spec: dict) -> str:
    d, models = spec["decision"], spec["models"]
    a, b = d["a"], d["b"]
    title = (spec.get("blueprint") or {}).get("title") or spec["task"]
    lines = [
        f"# Spec: {title}",
        "",
        f"Task `{spec['task']}`, version `{spec['version']}`. Compared: `{a}` and `{b}`.",
        "",
    ]
    lines += ["## 1. Decision", ""]
    if d["verdict"] == "no data":
        lines += [f"**No decision.** {d['notes'][0]} Run a match between them on this task first.", ""]
        return "\n".join(lines)
    headline = {
        "better": f"**Use `{d['better']}` for this task.** It did the task better than the other model.",
        "leaning": f"**Leaning `{d['better']}`, not settled.** It is ahead, but the lead could still be chance.",
        "no real difference shown": "**No winner.** The two models split the pairs evenly on this task.",
        "not enough evidence": "**No winner yet.** There are too few head-to-head pairs to call it.",
    }[d["verdict"]]
    if d.get("headline"):
        # fit for the task comes first; the head to head follows as the evidence between the two
        lines += [f"**{d['headline']}**", "", f"Fit for this task, at {d['profile']} tolerance:", ""]
        for name in (a, b):
            f = spec["fit"][name]
            word = {True: "fit", False: "not fit", None: "too few attempts to say"}[f["fit"]]
            why = "; ".join(f["reasons"])
            lines.append(f"- `{name}`: **{word}**. {policy.result_line(f)}" + (f" Because: {why}." if why else ""))
        versus = {
            "better": f"`{d['better']}` did this task better than the other model.",
            "leaning": f"`{d['better']}` is ahead, but the lead could still be chance.",
            "no real difference shown": "the two models split the pairs evenly.",
            "not enough evidence": "too few head-to-head pairs to call it.",
        }[d["verdict"]]
        lines += ["", f"Head to head: {versus}", ""]
    else:
        lines += [headline, ""]
    lines += [
        (
            f"- {d['pairs']} judged pairs on the same generated worlds: `{a}` won {d['wins'][a]}, `{b}` won "
            f"{d['wins'][b]}, {d['ties']} tied (sign test p = {d['p_value']})."
        ),
        "- Decided by: "
        + ", ".join(f"{n} on {rule}" for rule, n in sorted(d["decided_by"].items(), key=lambda x: -x[1]))
        + ".",
        "",
        (
            "| Model | Right result | Passed (result and process) | Cost per attempt | Seconds per attempt | "
            f"Mistakes per attempt | Good enough (bar {d['bar']:.0%}) |"
        ),
        "|---|---|---|---|---|---|---|",
    ]
    for name in (a, b):
        s = models[name]
        lines.append(
            f"| `{name}` | {s['right']} of {s['attempts']} | {s['passed']} of {s['attempts']} | "
            f"${s['cost_per_attempt']:.4f} | "
            f"{s['seconds_per_attempt']:.0f} | {s['mistakes']:.1f} | {'yes' if s['good_enough'] else 'no'} |"
        )
    lines.append("")
    lines += [f"- {n}" for n in d["notes"]] + ([""] if d["notes"] else [])

    bp = spec["blueprint"]
    st = bp["settings"]
    lines += [
        "## 2. Blueprint",
        "",
        "What the result was earned on. Build the real flow to match it, then re-test.",
        "",
    ]
    lines += ["### The job, as tested", "", f"> {bp['brief']}", ""]
    if bp.get("policy"):
        lines += ["### The rules, as tested", "", f"> {bp['policy']}", ""]
    lines += ["### Tools the flow needs", "", "| Tool | What it does |", "|---|---|"]
    lines += [f"| `{t['name']}` | {t['kind']} |" for t in bp["tools"]] + [""]
    lines += [
        "### Settings the result holds for",
        "",
        f"- Model: `{spec['chosen']}`" if spec["chosen"] else "- Model: none chosen (see the decision).",
        f"- Reasoning effort: {_one(st['effort'])}",
        f"- Output limit per call: {_one(st['max_output_tokens'])} tokens",
        f"- Hard budget per attempt: ${_one(st['attempt_budget_usd'])}",
        f"- Difficulty level: {_one(st['difficulty'])}; action budget {st.get('action_budget') or 'not recorded'}",
        "",
    ]
    if bp.get("modelled_on"):
        lines += [f"The test is modelled on: {bp['modelled_on']}.", ""]
    who = f"`{spec['chosen']}`" if spec["chosen"] else "each model"
    lines += [
        "### Guardrails and autonomy",
        "",
        f"Each hazard this task can raise, how {who} handled it, and what to build where it tripped.",
        "",
        "| Model | Hazard | Tripped | Autonomy | Build this |",
        "|---|---|---|---|---|",
    ]
    for g in bp["hazards"]:
        flag = " (unforgivable)" if g["unforgivable"] else ""
        lines.append(
            f"| `{g['model']}` | {g['hazard']}{flag} | {g['tripped']} of {g['exposed']} | {g['autonomy']} | "
            f"{g['guardrail'] or '-'} |"
        )
    lines += [
        "",
        "Unforgivable by default for a tool-using workflow: " + ", ".join(bp["unforgivable_defaults"]) + ". "
        "Change the list to fit your flow.",
        "",
        "## 3. Cost",
        "",
        f"What these {d['pairs']} head-to-head pairs cost. The cost breakdown report has the scenario-by-scenario detail.",
        "",
        *reports.cost_lines(models, a, b),
        "## 4. Evidence",
        "",
        f"- Test version: `{spec['version']}` (package fingerprint `{spec.get('test_fingerprint')}`).",
        "- Sealed match records (public half and private answer key both published; check with `ledger verify`):",
    ]
    lines += [
        f"  - `{e['run']}`, seal `{str(e['seal_sha256'])[:16]}`, engine commit `{str(e['engine_commit'])[:7]}`"
        for e in spec["evidence"]
    ]
    lines += [
        "",
        (
            "This spec claims only what was measured: this task, in a simulated world, under these settings. Treat it as "
            "the starting point for the real flow, and test again once it is built."
        ),
        "",
        "## Machine-readable",
        "",
        "```json",
        json.dumps(spec, indent=1, default=str),
        "```",
        "",
    ]
    return "\n".join(lines)
