"""The spec: what a head-to-head on one task tells you to build.

A spec is one readable document in four layers, each a path through the graph (and the same content as data,
`as_json`, for a program: it is no longer printed at the end of the document a person reads):
  1. Decision   which of the two models did this task better, how sure that is, and whether it is good enough.
  2. Blueprint  the task as it was tested (brief, rules, tools), the settings the result was earned under, what a
                run costs, and a guardrail for every hazard the chosen model tripped on. A hazard it did not
                trip on is reported as not seen, with what that count can and cannot rule out: never as safe.
  3. Cost       what the head-to-head attempts cost: per attempt, per right result, per clean run, and where
                the figure comes from (ledger/reports.py, which also writes the full cost and evidence reports).
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

# Where the same content is to be had as data: the last line of the document a person reads.
DATA_LINE = (
    'The same content as data, for a program to read: `ledger spec` with `--json`, or "Spec as data" on the page.'
)


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
            for k in (
                "verdict",
                "better",
                "a",
                "b",
                "pairs",
                "wins",
                "ties",
                "p_value",
                "decided_by",
                "decided_on",
                "bar",
                "notes",
            )
        },
        "models": verdict.get("models") or {},
        "chosen": chosen,
        "evidence": verdict.get("evidence") or [],
    }
    if judged:
        out["decision"].update({k: verdict[k] for k in ("outcome", "headline", "profile")})
        keep = ("fit", "so_far", "attempts", "passed", "pass_rate", "right", "right_rate", "bar", "reasons")
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
                    # never "can run alone": no trips in N attempts is a count, not a clearance
                    "seen": "needs a guard" if h["tripped"] else "not seen",
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


def ruled_out(attempts: int) -> float:
    """What no trips in `attempts` attempts can rule out: the rate above which seeing none would be unlikely (under
    5%). None in 72 rules out rates above about 4%; none in 9 only rates above about 28%."""
    return 1 - 0.05 ** (1 / attempts) if attempts else 1.0


def _one(values) -> str:
    values = [v for v in (values or []) if v is not None]
    return ", ".join(str(v) for v in values) if values else "not recorded"


def guard_notes(spec: dict) -> list[str]:
    """What the guardrail table does not say by itself, as Markdown lines: what "not seen" is worth, and the faults
    that count against a model's fitness, which is judged over every attempt it made and not only these scenarios."""
    hazards = spec["blueprint"]["hazards"]
    lines = []
    unseen = sorted({g["exposed"] for g in hazards if not g["tripped"] and g["exposed"]})
    if unseen:
        said = "; ".join(f"none in {n} rules out a rate above about {ruled_out(n):.0%}" for n in unseen)
        lines.append(
            f"- Not seen is a count, not a clearance: {said}. A hazard that must never happen still needs its "
            "guard in the real flow."
        )
    for model in dict.fromkeys(g["model"] for g in hazards):
        f = (spec.get("fit") or {}).get(model)
        if f and f["reasons"]:
            lines.append(
                f"- Fitness is judged over every attempt `{model}` made on this task ({f['attempts']}), and counts "
                f"faults that are not hazards of the world too. Against it at this tolerance"
                f"{'' if f['fit'] is False else ', so far'}: {'; '.join(f['reasons'])}."
            )
    return lines


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
            why = "; ".join(f["reasons"])
            lead = "Because" if f["fit"] is False else "So far"
            lines.append(
                f"- `{name}`: **{policy.standing(f)}**. {policy.result_line(f)}" + (f" {lead}: {why}." if why else "")
            )
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
        f"- {reports.head_to_head(d, a, b)}",
        *([f"- Decided: {reports.decided_text(d['decided_on'])}."] if d["decided_on"] else []),
        "",
    ]
    # Read through a tolerance, fitness is said above, over every attempt each model made: a second "good enough"
    # here, over the pair's scenarios only, could contradict it.
    judged = bool(d.get("headline"))
    lines += [
        (
            "| Model | Right result | Clean runs (result and process) | Cost per attempt | Seconds per attempt | "
            "Mistake points per attempt |" + ("" if judged else f" Good enough (bar {d['bar']:.0%}) |")
        ),
        "|---|---|---|---|---|---|" + ("" if judged else "---|"),
    ]
    for name in (a, b):
        s = models[name]
        lines.append(
            f"| `{name}` | {s['right']} of {s['attempts']} | {s['passed']} of {s['attempts']} | "
            f"${s['cost_per_attempt']:.4f} | "
            f"{s['seconds_per_attempt']:.0f} | {s['mistakes']:.1f} |"
            + ("" if judged else f" {'yes' if s['good_enough'] else 'no'} |")
        )
    lines.append("")
    lines += [f"- {n}" for n in d["notes"]] + [f"- {reports.MISTAKE_POINTS}", ""]

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
        "### Guardrails",
        "",
        (
            f"Each hazard this task can raise, how {who} handled it in the {d['pairs']} head-to-head scenarios, and "
            "what to build where it tripped."
        ),
        "",
        "| Model | Hazard | Tripped | Reading | Build this |",
        "|---|---|---|---|---|",
    ]
    for g in bp["hazards"]:
        flag = " (unforgivable)" if g["unforgivable"] else ""
        lines.append(
            f"| `{g['model']}` | {g['hazard']}{flag} | {g['tripped']} of {g['exposed']} | {g['seen']} | "
            f"{g['guardrail'] or '-'} |"
        )
    guarded = guard_notes(spec)
    lines += ["", *guarded, *([""] if guarded else [])]
    lines += [
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
        "- Sealed match records:",
    ]
    lines += [f"  - {reports.record_line(e)}" for e in spec["evidence"]]
    lines += [
        "",
        reports.ANSWER_KEYS,
        "",
        (
            "This spec claims only what was measured: this task, in a simulated world, under these settings. Treat it as "
            "the starting point for the real flow, and test again once it is built."
        ),
        "",
        DATA_LINE,
        "",
    ]
    return "\n".join(lines)


def as_json(spec: dict) -> str:
    """The spec as data: everything the document says, for a program to read."""
    return json.dumps(spec, indent=1, default=str) + "\n"
