"""Gladiator's pair-judging rules, copied so Ledger judges every pair exactly as Gladiator does.

REUSED CODE (disclosed): taken verbatim from the Gladiator engine (Apache-2.0, written before this project),
scorers/efficiency.py and scorers/outcome.py at commit c3dac6f. Only the per-pair functions are kept.

A pair is judged in this order: one side succeeded -> it wins ("success"); neither succeeded -> the one that got
further wins ("progress"); otherwise the more efficient wins ("efficiency"); no real difference -> "tie".
"""

PROFILES = {
    # Mistakes dominate; cost, tokens and time break the rest.
    "balanced": {"mistakes": 0.50, "cost": 0.20, "tokens": 0.15, "time": 0.15},
    # Limited compute and a hard budget: money first (the sweet spot for small and mid-tier models).
    "budget": {"mistakes": 0.35, "cost": 0.45, "tokens": 0.10, "time": 0.10},
    # Speed first (interactive flows).
    "latency": {"mistakes": 0.35, "cost": 0.10, "tokens": 0.10, "time": 0.45},
}
DNF_PENALTY = 1.0
DNF = {"over_budget", "time_limit"}  # the model didn't reach the finish line (counts against it)
TIME_FLOOR_S = 1.0  # added to every time, so millisecond noise can't look like "twice as slow"
TIME_NOISE_S = 2.0  # times this close count as equal: network and machine jitter must never pick a winner
FAILED_UNGRADED = 10  # mistake points for a failed attempt whose grader gives no severity (e.g. v1 cases)


def mistake_points(result: dict) -> float:
    details = result.get("grade_details") or {}
    if details.get("error_severity") is not None:
        points = float(details["error_severity"])
        # Workflow mistakes without severity (blind retries, unread records, no finish) still count.
        points += 2 * (details.get("blind_retries_after_unknown_outcome") or 0)
        points += details.get("acted_without_reading") or 0
        points += 0 if details.get("explicit_finish", True) else 3
        return points
    return 0.0 if result.get("passed") else float(FAILED_UNGRADED)


def unfinished_share(result: dict) -> float:
    """How far short of the finish line: 1.0 if cut off by its own budget or time, else the share of items
    left undecided (0.0 = every item decided)."""
    if result.get("termination") in DNF:
        return 1.0
    details = result.get("grade_details") or {}
    missing = details.get("missing") or 0
    if not missing:
        return 0.0
    items = details.get("items") or 0
    return min(1.0, missing / items) if items else 1.0


def finished(result: dict) -> bool:
    return unfinished_share(result) == 0.0


def components(result: dict) -> dict:
    return {
        "mistakes": 1 + mistake_points(result),
        "cost": float(result.get("cost_usd") or 0),
        "tokens": float((result.get("input_tokens") or 0) + (result.get("output_tokens") or 0)),
        "time": float(result.get("wall_s") or 0) + TIME_FLOOR_S,
    }


def pair_scores(result_a: dict, result_b: dict, profile: str = "balanced") -> tuple[float, float]:
    """Efficiency scores (A, B) for one paired attempt: lower is better, 1.00 each when identical."""
    weights = PROFILES[profile]
    ca, cb = components(result_a), components(result_b)
    sa = sb = 0.0
    for name, w in weights.items():
        mean = (ca[name] + cb[name]) / 2
        ra, rb = (ca[name] / mean, cb[name] / mean) if mean > 0 else (1.0, 1.0)
        if name == "time" and abs(ca[name] - cb[name]) <= TIME_NOISE_S:
            ra = rb = 1.0
        sa += w * ra
        sb += w * rb
    sa += DNF_PENALTY * unfinished_share(result_a)
    sb += DNF_PENALTY * unfinished_share(result_b)
    return round(sa, 4), round(sb, 4)


TIE_MARGIN = 0.01  # efficiency scores this close are "no real difference" (timing noise must not pick a winner)


def success(result: dict) -> bool:
    return bool(result.get("passed"))


def progress(result: dict) -> float:
    """How far the attempt got: the share of items decided correctly (1.0 = all), or for cases without
    items, whether the end result was right."""
    details = result.get("grade_details") or {}
    items = details.get("items")
    if items:
        return (details.get("correct") or 0) / items
    return 1.0 if result.get("task_correct") else 0.0


def pair_outcome(a: dict, b: dict, profile: str = "balanced") -> dict:
    """{'winner': 'A' | 'B' | 'tie', 'by': 'success' | 'progress' | 'efficiency' | None, 'efficiency': (A, B)}."""
    eff = pair_scores(a, b, profile)
    sa, sb = success(a), success(b)
    if sa != sb:
        return {"winner": "A" if sa else "B", "by": "success", "efficiency": eff}
    if not sa:
        pa, pb = progress(a), progress(b)
        if abs(pa - pb) > 1e-9:
            return {"winner": "A" if pa > pb else "B", "by": "progress", "efficiency": eff}
    if abs(eff[0] - eff[1]) > TIE_MARGIN:
        return {"winner": "A" if eff[0] < eff[1] else "B", "by": "efficiency", "efficiency": eff}
    return {"winner": "tie", "by": None, "efficiency": eff}
