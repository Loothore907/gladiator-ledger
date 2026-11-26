"""Replays: what each model did, step by step, in every recorded scenario.

A sealed match record keeps every step of every attempt: the tool the model called, on which item, how long the
call took, what it cost and whether the simulated world answered or timed out. This module turns a record into a
compact timeline per scenario, so the page can replay a scenario as a race at its true pace.

Everything here comes from the public record. A step is marked only with what the record itself shows:
  timeout   the world did not answer (the action may or may not have taken effect)
  refused   the world refused the call (for example, not enough stock)
  repeat    the model acted on an item it had already acted on
  wrong     the grader names this item as decided wrongly (records that list mistakes per item only)
The grade at the end (passed or not, and each fault with its count) is the grader's, copied unchanged.
"""

import json
from pathlib import Path

from ledger import costs
from ledger.bridges import gladiator

READ, CHECK, ACT, END, TALK = "read", "check", "act", "end", "talk"
OK, TIMEOUT, REFUSED = 0, 1, 2


def step_kind(tool: str | None) -> str:
    if not tool:
        return TALK  # the model answered without calling a tool
    if tool == "finish":
        return END
    if tool.startswith("check_"):
        return CHECK
    return READ if tool.startswith(("list_", "get_", "stock_for_", "find_", "lookup_", "search_")) else ACT


def item_of(args) -> str | None:
    """The item a step is about: the first argument that names one (an id, or the page of a list)."""
    if not isinstance(args, dict):
        return None
    for key, value in args.items():
        if key.endswith("id") or key in ("sku", "page"):
            return f"page {value}" if key == "page" else str(value)
    return None


def attempt_timeline(res: dict, tools: list[str]) -> dict:
    """One attempt as a timeline. Steps are [seconds since the start, tool, item, kind, state, mark, cost, tokens]."""
    details = res.get("grade_details") or {}
    mistakes = details.get("mistakes") or {}  # item -> "expected->chosen"
    acted, marked, steps, clock = set(), set(), [], 0.0
    for turn in res.get("turns") or []:
        tool = turn.get("tool_name")
        clock += float(turn.get("call_s") or 0)
        kind = step_kind(tool)
        item = item_of(turn.get("tool_args"))
        observed = turn.get("observation")
        error = observed.get("error") if isinstance(observed, dict) else None
        state = TIMEOUT if error == "timeout" else REFUSED if error else OK
        mark = None
        if kind == ACT and item:
            chosen = (mistakes.get(item) or "").partition("->")[2]
            if chosen and chosen in tool and item not in marked:
                mark = "wrong"
                marked.add(item)
            elif item in acted:
                mark = "repeat"
            acted.add(item)
        if tool not in tools:
            tools.append(tool)
        usage = turn.get("usage") or {}
        tokens = int((usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0))
        steps.append(
            [
                round(clock, 2),
                tools.index(tool),
                item,
                kind,
                state,
                mark,
                round(float(turn.get("cost_usd") or 0), 6),
                tokens,
            ]
        )
    faults = {name: int(details[counter]) for counter, name in gladiator.HAZARDS.items() if details.get(counter)}
    faults.update(
        {name: int(details[counter]) for counter, name in gladiator.DECISION_FAULTS.items() if details.get(counter)}
    )
    ending = gladiator.ENDING_FAULTS.get(res.get("termination"))
    if ending:
        faults[ending] = 1
    right = res.get("task_correct")
    return {
        "passed": bool(res.get("passed")),
        # every decision right and nothing left undone, as the grader says it; a pass (a clean run) also asks
        # for the process, so an attempt can be right and still not pass
        "right": bool(res.get("passed") if right is None else right),
        "seconds": round(float(res.get("wall_s") or clock), 2),
        "cost_usd": round(float(res.get("cost_usd") or 0), 6),
        "items": details.get("items"),
        "correct": details.get("correct"),
        "faults": faults,
        "steps": steps,
    }


def run_replays(body: dict) -> dict:
    """Every scenario of one match record: {"tools": [...], "matches": {"<run>/<workflow>/<attempt>": {model: timeline}}}."""
    tools: list[str | None] = []
    matches: dict[str, dict] = {}
    for side in ("A", "B"):
        model = body["contestants"][side]["id"]
        for res in body["contestants"][side]["results"]:
            key = f"{body['run_id']}/{res['node']}/{res.get('attempt', 1)}"
            matches.setdefault(key, {})[model] = attempt_timeline(res, tools)
    return {"run": body["run_id"], "tools": tools, "matches": matches}


def export(records: Path, out: Path) -> dict:
    """One replay file per sealed match record under `records`, as out/<run_id>.json. Returns their sizes."""
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.json"):
        stale.unlink()
    sizes = {}
    for path in gladiator.find_records(records):
        record = json.loads(path.read_text(encoding="utf-8"))
        if not gladiator.seal_ok(record):
            continue
        replays = run_replays(costs.corrected(record["body"], costs.read_billed(path, record["sha256"])))
        target = out / f"{replays['run']}.json"
        target.write_text(json.dumps(replays, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        sizes[target.name] = target.stat().st_size
    return sizes
