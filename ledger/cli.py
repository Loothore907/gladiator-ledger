"""ledger: build the graph from Gladiator records, ask it questions, get a recommendation.

ledger build --records runs/ --validations validations/ [--store data/ledger.rl]
ledger ask hazard_profile
ledger ask best_under_budget --param test_id=gladiator/refund-queue --param budget=0.05
ledger recommend refund-queue --budget 0.05
ledger verify
ledger flows "refunds with policy exceptions"
ledger opponents "haiku 5.5" --open-only
ledger spec refund-queue --a "haiku 5.5" --b minimax-m3.1 --out spec.md
ledger verdict refund-queue --a anthropic:claude-haiku-5-5 --b openrouter:minimax/minimax-m3.1-flash
ledger process refund-queue --a "haiku 5.5" --b deepseek-v4.1      how they worked, asked of every step on file
ledger route refund-queue --a "haiku 5.5" --b deepseek-v4.1 --scenario 3     the same world, two routes
"""

import argparse
import json
import math
import sys
from datetime import UTC, datetime
from pathlib import Path

import relate

from ledger import load, policy, publish, questions, reports, routes, spec
from ledger.bridges import epoch

DEFAULT_STORE = "data/ledger.rl"
GOOD_ENOUGH = 0.8  # default bar for "good enough for this task": share of attempts with the right result
MIN_PAIRS = 8  # fewer judged pairs than this for a model on a workflow is "not enough evidence"
CLEAR_P = 0.05  # sign-test p-value below which a head-to-head lead counts as clear


def rows(store: str, query: str, params: dict | None = None) -> list[dict]:
    with relate.connect(store, read_only=True) as conn:
        return [dict(r) for r in conn.execute(query, params or {})]


def sign_test_p(wins: int, losses: int) -> float:
    """Two-sided sign test: how likely a split this lopsided is if the two models were equally good."""
    n = wins + losses
    if n == 0:
        return 1.0
    k = min(wins, losses)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * tail)


def test_id(name: str) -> str:
    return name if "/" in name else f"gladiator/{name}"


def current_version(store: str, test: str) -> str | None:
    """The newest version of a test that has judged matches."""
    found = rows(
        store,
        """MATCH (t:Test {id: $t})<-[:VERSION_OF]-(tv:TestVersion)<-[:USED]-(mt:Match) WHERE NOT mt.excluded
           RETURN tv.key AS key, tv.version_rank AS rank ORDER BY rank DESC LIMIT 1""",
        {"t": test},
    )
    return found[0]["key"] if found else None


UNTIL_HELP = (
    "read the record as it stood then: only matches started at or before this moment, a date (2026-11-26, the whole "
    "day) or a date and time in UTC (2026-11-26T05:00). A figure quoted with it stays the same as the record grows"
)
NEEDS_HELP = (
    "for a question about the records an item depends on, only this kind of record, e.g. customer (repeatable; "
    "the kinds a task has are printed by `ledger process <task>`)"
)
SCOPE_DEFAULTS = {
    "test_id": None,
    "suite": None,
    "version_key": None,
    "conditions": None,
    "until": None,
    "current_only": False,
    "open_only": False,
    "kinds": None,
}
# Questions that need the steps (ledger/routes.py): asked of the store that holds them.
STEP_QUESTIONS = {"what_decisions_need", "same_world", *(q for q in questions.ALL if q.startswith("steps:"))}
# How a setting reads in a sentence, when a note says which conditions some pairs were played under ("{}" is the
# value). The page reads the same words from rules.json.
CONDITION_WORDS = {
    "difficulty": "{} difficulty",
    "profile": "{} scoring",
    "effort": "{} effort",
    "attempt_budget_usd": "a ${} limit per attempt",
    "max_output_tokens": "an output limit of {} tokens",
    "timeout_s": "a {}-second limit per call",
    "per_model": "different settings for each model",
}


def recommend(
    store: str,
    workflow: str | None,
    budget: float,
    all_versions: bool = False,
    min_pairs: int = MIN_PAIRS,
    suite: str | None = None,
):
    """A pick, the evidence behind it and its caveats. Names no winner on thin evidence or a tie.
    Scope: one workflow (its newest version with data, or all versions), or a whole suite (current versions)."""
    if suite:
        test, version, label = None, None, "current versions" if not all_versions else "all versions"
        params = dict(SCOPE_DEFAULTS, suite=suite, current_only=not all_versions, budget=budget)
        scope = {"suite": suite}
    else:
        test = test_id(workflow)
        version = None if all_versions else current_version(store, test)
        if not all_versions and version is None:
            return {"workflow": test, "pick": None, "verdict": "no data", "caveats": [f"No judged matches on {test}."]}
        label = version or "all versions"
        params = dict(SCOPE_DEFAULTS, test_id=test, version_key=version, budget=budget)
        scope = {"workflow": test}
    table = rows(store, questions.BEST_UNDER_BUDGET, params)
    caveats = []
    fits = [r for r in table if r["within_budget"]]
    over = [r["model"] for r in table if not r["within_budget"]]
    if over:
        caveats.append(f"Over budget (${budget:.4f}/attempt): {', '.join(over)}.")
    result = dict(scope, version=label, budget=budget, models=table)
    if not table:
        return dict(result, pick=None, verdict="no data", caveats=caveats + ["No judged matches in this scope."])
    if not fits:
        return dict(result, pick=None, verdict="nothing fits the budget", caveats=caveats)
    thin = [r["model"] for r in fits if r["attempts"] < min_pairs]
    if thin:
        caveats.append(f"Fewer than {min_pairs} judged pairs: {', '.join(thin)}.")
    ranked = [r for r in fits if r["attempts"] >= min_pairs]
    if not ranked:
        return dict(result, pick=None, verdict="not enough evidence", caveats=caveats)
    top = ranked[0]
    if len(ranked) == 1:
        caveats.append(f"{top['model']} is the only model with enough evidence within this budget: nothing to beat.")
    evidence, verdict, pick = [], "pick", top["model"]
    if len(ranked) > 1:
        second = ranked[1]
        h2h = rows(store, questions.HEAD_TO_HEAD, dict(params, a=top["model"], b=second["model"]))
        wins = sum(1 for r in h2h if r["winner"] == top["model"])
        losses = sum(1 for r in h2h if r["winner"] == second["model"])
        evidence = h2h
        if not h2h:
            verdict = "leaning"
            caveats.append(
                f"{top['model']} and {second['model']} never played each other: the order is indirect, so it is a "
                "lean, not a pick."
            )
        elif wins <= losses:
            pick, verdict = None, "tie"
            caveats.append(
                f"{top['model']} ranks first overall but went {wins}-{losses} against {second['model']}: "
                "no clear winner, so none is named."
            )
        else:
            p = sign_test_p(wins, losses)
            result["head_to_head"] = {"vs": second["model"], "wins": wins, "losses": losses, "p_value": round(p, 4)}
            if p >= CLEAR_P:
                verdict = "leaning"
                caveats.append(
                    f"{top['model']} leads {second['model']} {wins}-{losses}, but a split like that happens by chance "
                    f"{p:.0%} of the time between equal models: a lean, not a settled result."
                )
    in_scope = {v for r in table for v in r["versions"]}
    cycles = [c for c in rows(store, questions.BEAT_CYCLES, {"suite": suite}) if c["version"] in in_scope]
    if cycles:
        narrow = all(max(c["leads"]) <= 1 for c in cycles)
        detail = "; ".join(
            f"{c['a'].split(':')[-1]} > {c['b'].split(':')[-1]} > {c['c'].split(':')[-1]} > "
            f"{c['a'].split(':')[-1]} ({', '.join(c['margins'])})"
            for c in cycles
        )
        caveats.append(
            f"Beat cycles ({len(cycles)}): {detail}. "
            + (
                "Every edge is a one-pair lead, so this may be noise."
                if narrow
                else "The ranking is not a simple ladder."
            )
        )
    unvalidated = [
        r["version"] for r in rows(store, questions.PROMOTION) if r["version"] in in_scope and not r["validated"]
    ]
    if unvalidated:
        caveats.append(f"No passing validation record in the graph for: {', '.join(sorted(unvalidated))}.")
    if all_versions and test:
        stale = rows(store, questions.STALE_RESULTS)
        if any(s["version"].startswith(test + "@") for s in stale):
            caveats.append("Includes results from older versions of this test.")
    return dict(result, pick=pick, verdict=verdict, evidence=evidence, caveats=caveats)


# Words that say nothing about a flow: dropped before a keyword search so they cannot match by accident.
FILLER = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "can",
    "do",
    "for",
    "from",
    "have",
    "how",
    "i",
    "in",
    "into",
    "is",
    "it",
    "its",
    "me",
    "my",
    "of",
    "on",
    "or",
    "our",
    "so",
    "that",
    "the",
    "their",
    "then",
    "this",
    "to",
    "up",
    "we",
    "what",
    "when",
    "which",
    "who",
    "will",
    "with",
    "you",
    "your",
    "need",
    "needs",
    "want",
    "wants",
    "flow",
    "workflow",
    "task",
    "agent",
    "model",
    "models",
    "handle",
    "handles",
    "handling",
    "process",
}


def search_words(text: str) -> str:
    """The words worth searching for in a described flow (lower case, letters and digits only, filler removed)."""
    words = [w for w in "".join(c.lower() if c.isalnum() else " " for c in text).split() if w not in FILLER]
    # The index matches whole words, so add the singular of a plural ("refunds" also searches "refund").
    words += [w[:-1] for w in words if len(w) > 3 and w.endswith("s") and not w.endswith("ss")]
    return " ".join(dict.fromkeys(words))


def find_flows(store: str, described: str | None) -> dict:
    """Describe your flow: the tested workflows whose title, brief and policy match your words best. With nothing
    to search for (or nothing found), every tested workflow is listed and the result says so."""
    words = search_words(described or "")
    found = rows(store, questions.FIND_FLOW, {"q": words}) if words else []
    if found:
        return {"described": described, "searched_for": words, "matched": True, "flows": found}
    return {"described": described, "searched_for": words, "matched": False, "flows": rows(store, questions.FLOWS)}


def print_flows(f: dict) -> None:
    if f["described"] and f["matched"]:
        print(f"Closest tested workflows to: {f['described']!r}  (searched for: {f['searched_for']})")
    elif f["described"]:
        print(f"Nothing tested matches {f['described']!r}. Every tested workflow:")
    else:
        print("Every tested workflow:")
    for flow in f["flows"]:
        score = f"  match {flow['score']:.2f}" if flow.get("score") is not None else ""
        print(f"\n  {flow['test']}  ({flow['title']}, version {flow['version']}){score}")
        print(f"    {flow['models']} models, {flow['pairs']} judged pairs; modelled on {flow.get('emulates') or '-'}")
        print(f"    {(flow.get('brief') or '')[:160]}...")
    print("\nNext: ledger opponents <model>, then ledger verdict <task> --a <model> --b <model>")


def resolve_model(store: str, name: str) -> str | None:
    """A model's key in the graph from what a person typed: its exact id, its display name, or an unambiguous
    part of either (case-insensitive)."""
    models = rows(store, "MATCH (m:Model) RETURN m.name AS name, m.display_name AS display_name")
    want = name.strip().lower()
    for m in models:
        if want in (m["name"].lower(), (m["display_name"] or "").lower()):
            return m["name"]
    partial = [m["name"] for m in models if want in m["name"].lower() or want in (m["display_name"] or "").lower()]
    return partial[0] if len(partial) == 1 else None


def opponents(store: str, model: str, open_only: bool = False, limit: int = 5) -> dict:
    """Models that score close to this one on a published index: candidates for a fair head-to-head. The score only
    suggests the opponent; which one does a task better is what the match is for."""
    key = resolve_model(store, model)
    out = {"asked": model, "model": key, "benchmark": epoch.BENCHMARK, "open_only": open_only, "candidates": []}
    if key is None:
        return dict(out, note=f"No single model matches '{model}'. Use an exact id or a fuller name.")
    mine = rows(
        store,
        "MATCH (m:Model {name: $m})-[s:SCORED]->(:Benchmark {name: $b}) RETURN s.score AS score, s.low AS low, "
        "s.high AS high, m.display_name AS display_name",
        {"m": key, "b": epoch.BENCHMARK},
    )
    if not mine:
        return dict(out, note=f"{key} has no published score on the {epoch.BENCHMARK}, so no opponent is suggested.")
    close = rows(store, questions.CLOSE_TO, {"model": key, "benchmark": epoch.BENCHMARK, "open_only": open_only})
    return dict(out, score=mine[0], candidates=close[:limit])


def print_opponents(o: dict) -> None:
    if o.get("note"):
        print(o["note"])
        return
    s = o["score"]
    print(f"{o['model']}  ({s['display_name']})")
    print(f"{o['benchmark']}: {s['score']:.1f}  (range {s['low']:.1f} to {s['high']:.1f})")
    print("\nClosest on paper" + (", open weights only" if o["open_only"] else "") + ":")
    width = max(len(c["model"]) for c in o["candidates"]) if o["candidates"] else 5
    print(f"  {'model':{width}}  score     gap  ranges overlap  weights  in Ledger")
    for c in o["candidates"]:
        if c["pairs_played"]:
            known = f"{c['pairs_played']} pairs already played against it"
        elif c["has_matches"]:
            known = "has matches, none against it"
        else:
            known = "no matches yet"
        print(
            f"  {c['model']:{width}}  {c['score']:5.1f}  {c['gap']:+6.2f}  {'yes' if c['ranges_overlap'] else 'no':14}  "
            f"{c['weights']:7}  {known}"
        )
    print(
        "\nA close score only makes the head-to-head fair. Which one does your task better is what the match shows:"
        "\n  ledger verdict <task> --a <model> --b <model>"
    )
    print("Scores: Epoch AI, 'Capabilities & benchmarking', epoch.ai/benchmarks (CC BY 4.0). See data/epoch/README.md.")


def parse_until(text: str | None) -> float | None:
    """`--until`: a date (the whole of that day counts) or a date and time, in UTC, as unix seconds."""
    if not text:
        return None
    moment = datetime.fromisoformat(text)
    if "T" not in text and " " not in text:
        moment = moment.replace(hour=23, minute=59, second=59)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.timestamp()


def reference_conditions(found: list[dict], record: dict[str, int]) -> str:
    """The one set of conditions a verdict between two models is read under. In order: the conditions of the suite
    matches between the two (most pairs); if they never met in a suite, those most of the task's own suite record
    was played under; if they have no pair under those either, the conditions they met under most. So a live race
    joins the record it was played to test, and one played under other conditions (an easier level, another
    scoring profile) never moves that record's verdict. `found` is PAIR_CONDITIONS, `record` TASK_CONDITIONS."""
    best = None
    for c in sorted(found, key=lambda c: c["conditions"]):  # a full tie goes to the first in code-point order
        rank = (c["suite_pairs"], record.get(c["conditions"], 0), c["pairs"])
        if best is None or rank > best[0]:
            best = (rank, c["conditions"])
    return best[1]


def conditions_apart(reference: str, other: str) -> str:
    """How one set of conditions differs from the reference, in words: only the settings that differ."""

    def read(text: str) -> dict:
        return dict(part.split("=", 1) for part in text.split("; ") if "=" in part)

    ref, oth = read(reference), read(other)
    words = []
    for key in sorted(set(ref) | set(oth)):
        if ref.get(key) == oth.get(key):
            continue
        if key not in oth:
            words.append(f"no {key} set")
        else:
            words.append(CONDITION_WORDS.get(key, key + " {}").replace("{}", oth[key]))
    return ", ".join(words) or "other conditions"


def not_counted_note(not_counted: list[dict]) -> str:
    """The sentence a verdict carries when the two models also met under conditions it does not count."""
    left_out = sum(c["pairs"] for c in not_counted)
    return (
        f"Not counted here: {left_out} judged {'pair' if left_out == 1 else 'pairs'} these two played under other "
        f"conditions ({'; '.join(c['what'] + ': ' + str(c['pairs']) for c in not_counted)}). "
        "A result holds for the conditions it was played under."
    )


def fitness(
    store: str,
    test: str,
    version: str,
    conditions: str,
    suite: str | None,
    profile: str,
    overrides=None,
    bar=None,
    until: float | None = None,
    checks: dict | None = None,
) -> dict:
    """Every model's fitness for one task version, by model id, under a profile (ledger/policy.py). Counts every
    attempt the model made on the task under one set of conditions, whoever the opponent was and whether the match
    was a suite match or a live race, so a model's fitness for a task is the same number in every verdict read
    under those conditions. `suite` keeps it to one suite's matches (a fixed set). `checks` adds the reader's own
    process questions as faults at the levels the reader gave them: {"store": a store that holds the steps,
    "levels": {check: level}, "kinds": kinds of record or None} (ledger/routes.py)."""
    scope = {"version_key": version, "conditions": conditions, "suite": suite, "until": until}
    faults: dict[str, list[dict]] = {}
    for f in rows(store, questions.TASK_FAULTS, scope):
        faults.setdefault(f.pop("model"), []).append(f)
    attempts = {r["model"]: r for r in rows(store, questions.TASK_ATTEMPTS, scope)}
    # self runs (one model on both sides) are attempts at the task too: added to that model's own count
    for extra in rows(store, questions.SELF_ATTEMPTS, scope):
        r = attempts.get(extra["model"])
        if r is None:
            continue  # a model with no match on this task has no row to add to
        spent = (r["cost_per_attempt"] or 0) * r["attempts"] + (extra["spent"] or 0)
        r["attempts"] += extra["attempts"]
        r["passed"] += extra["passed"]
        r["right"] += extra["right"]
        r["cost_per_attempt"] = spent / r["attempts"]
    for f in rows(store, questions.SELF_FAULTS, scope):
        mine = {x["fault"]: x for x in faults.get(f["model"], [])}
        if f["fault"] in mine:
            mine[f["fault"]]["attempts_with"] += f["attempts_with"]
            mine[f["fault"]]["times"] += f["times"]
    if checks and checks.get("levels"):
        with routes.opened(checks["store"]) as ask:
            own = routes.as_faults(ask, scope, checks["levels"], checks.get("kinds"))
        for model, added in own["faults"].items():
            faults.setdefault(model, []).extend(added)
        overrides = {**(overrides or {}), **own["levels"]}
    return {
        model: policy.assess(test, r, faults.get(model, []), profile, overrides, bar) for model, r in attempts.items()
    }


def outcome(v: dict, fit: dict) -> tuple[str, str, str | None]:
    """The answer a reader acts on: the head-to-head result read through fitness. Returns (code, sentence, the
    model to use or None)."""
    a, b = v["a"], v["b"]
    fa, fb = fit[a]["fit"], fit[b]["fit"]
    ahead, settled = v["better"], v["verdict"] == "better"
    if fa is None or fb is None:
        thin = [m for m in (a, b) if fit[m]["fit"] is None]
        return "too few attempts", f"Too few attempts to say whether {' or '.join(thin)} is fit for this task.", None
    if not fa and not fb:
        more = f" {ahead} did it better of the two, which is not the same as fit." if ahead else ""
        return "neither fit", "Neither is fit for this task." + more, None
    if fa != fb:
        fit_one, other = (a, b) if fa else (b, a)
        if ahead == other:
            lead = "did it better" if settled else "is ahead"
            return "only one fit", f"{other} {lead} head to head, but only {fit_one} is fit for this task.", fit_one
        if ahead == fit_one:
            lead = "did it better" if settled else "is ahead, not settled"
            line = f"Use {fit_one}: it is the only one of the two fit for this task, and it {lead}."
            return "only one fit", line, fit_one
        return "only one fit", f"Use {fit_one}: it is the only one of the two fit for this task.", fit_one
    if settled:
        return "use", f"Use {ahead}: both are fit for this task and it did it better.", ahead
    if ahead:
        line = f"Both are fit for this task. {ahead} is ahead head to head, but that is not settled."
        return "both fit", line, None
    return "both fit", "Both are fit for this task, and the matches show no winner between them.", None


def _side(pairs: list[dict], side: str) -> dict:
    n = len(pairs)
    passed = sum(1 for p in pairs if p[f"{side}_passed"])
    right = sum(1 for p in pairs if p[f"{side}_right"])  # the result alone, whatever the process was
    spent = sum(p[f"{side}_cost"] or 0 for p in pairs)
    return {
        "attempts": n,
        "passed": passed,
        "pass_rate": passed / n,
        "right": right,
        "right_rate": right / n,
        "cost_per_attempt": spent / n,
        # what a successful result really costs, failures included (None when nothing passed)
        "cost_per_pass": spent / passed if passed else None,
        "spent": spent,
        "cost_basis": sorted({str(p[f"{side}_basis"]) for p in pairs}),
        "calls_per_attempt": sum(p[f"{side}_calls"] or 0 for p in pairs) / n,
        "tokens_in": sum(p[f"{side}_in"] or 0 for p in pairs) / n,
        "tokens_cached": sum(p[f"{side}_cached"] or 0 for p in pairs) / n,
        "tokens_out": sum(p[f"{side}_out"] or 0 for p in pairs) / n,
        "seconds_per_attempt": sum(p[f"{side}_time"] or 0 for p in pairs) / n,
        "mistakes": sum(p[f"{side}_mistakes"] or 0 for p in pairs) / n,
        "effort": sorted({str(p[f"{side}_effort"]) for p in pairs}),
    }


def verdict(
    store: str,
    workflow: str,
    a: str,
    b: str,
    suite: str | None = None,
    all_versions: bool = False,
    bar: float = GOOD_ENOUGH,
    min_pairs: int = MIN_PAIRS,
    profile: str | None = None,
    overrides: dict | None = None,
    until: float | None = None,
    checks: dict | None = None,
) -> dict:
    """A task claim: which of two models did THIS task better when they played the same worlds, how sure that is,
    and whether either is good enough. Only the pairs where these two met count. Never a claim about a model in
    general, and no winner is named on thin evidence or a level score. `checks`: the reader's own process
    questions, counted from the steps and judged at the reader's levels (see fitness)."""
    test = test_id(workflow)
    version = None if all_versions else current_version(store, test)
    params = {"test_id": test, "a": a, "b": b, "suite": suite, "version_key": version, "until": until}
    out = {"task": test, "version": version or "all versions", "suite": suite, "until": until, "a": a, "b": b}
    out["bar"] = bar
    met_under = rows(store, questions.PAIR_CONDITIONS, params)
    if not met_under:
        return dict(out, verdict="no data", better=None, pairs=0, notes=[f"{a} and {b} never met on {test}."])
    # One verdict, one set of conditions: pairs played under any other are on file and said so, never pooled.
    task_scope = {"test_id": test, "suite": suite, "version_key": version, "until": until}
    record = {r["conditions"]: r["pairs"] for r in rows(store, questions.TASK_CONDITIONS, task_scope)}
    conditions = reference_conditions(met_under, record)
    params["conditions"] = conditions
    not_counted = [
        {"conditions": c["conditions"], "pairs": c["pairs"], "what": conditions_apart(conditions, c["conditions"])}
        for c in sorted(met_under, key=lambda c: c["conditions"])
        if c["conditions"] != conditions
    ]
    pairs = rows(store, questions.PAIR_ON_TASK, params)
    wins_a = sum(1 for p in pairs if p["winner"] == a)
    wins_b = sum(1 for p in pairs if p["winner"] == b)
    ties = len(pairs) - wins_a - wins_b
    decided_by = {}
    for p in pairs:
        decided_by[p["rule"]] = decided_by.get(p["rule"], 0) + 1
    stats = {a: _side(pairs, "a"), b: _side(pairs, "b")}
    p_value = sign_test_p(wins_a, wins_b)
    notes, better = [], None
    if len(pairs) < min_pairs:
        kind = "not enough evidence"
        notes.append(f"Only {len(pairs)} judged pairs (fewer than {min_pairs}): too few to call.")
    elif wins_a == wins_b:
        kind = "no real difference shown"
        notes.append(f"The pairs split {wins_a}-{wins_b}: neither did this task better.")
    else:
        better, lead, trail = (a, wins_a, wins_b) if wins_a > wins_b else (b, wins_b, wins_a)
        if p_value < CLEAR_P:
            kind = "better"
        else:
            kind = "leaning"
            notes.append(
                f"A {lead}-{trail} split happens by chance {p_value:.0%} of the time between equal models: "
                "a lean, not a settled result."
            )
    for s in stats.values():
        s["good_enough"] = s["right_rate"] >= bar
    if better and not stats[better]["good_enough"]:
        notes.append(
            f"{better} did better here, but got the right result in only {stats[better]['right_rate']:.0%} of "
            f"attempts (bar {bar:.0%}): better than the other one is not the same as good enough."
        )
    if not any(s["good_enough"] for s in stats.values()):
        notes.append(f"Neither model reaches the bar of {bar:.0%} right results on this task.")
    # a scenario won by passing where the other did not, although both got the right result, was won on process
    for model, side, other in ((a, "a", "b"), (b, "b", "a")):
        on_process = sum(1 for p in pairs if p["winner"] == model and p["rule"] == "success" and p[f"{other}_right"])
        won = wins_a if side == "a" else wins_b
        if on_process:
            notes.append(
                f"In {on_process} of the {won} scenarios {model} won, both got the right result: it won them on "
                "process, by following the steps the test asks for where the other did not."
            )
    efforts = {tuple(s["effort"]) for s in stats.values()}
    if len(efforts) > 1 or any(len(e) > 1 for e in efforts):
        notes.append("The two models did not play under one identical effort setting in every pair.")
    if not_counted:
        notes.append(not_counted_note(not_counted))
    hazards = rows(store, questions.PAIR_HAZARDS, params)
    runs = {}
    for p in pairs:
        runs[p["run"]] = {"run": p["run"], "seal_sha256": p["seal"], "engine_commit": p["engine"], "suite": p["suite"]}
    if profile:
        # Fit first: is each model fit for the task at all, under the reader's tolerance? Then the head to head.
        version_key = max(p["version"] for p in pairs)
        everyone = fitness(store, test, version_key, conditions, suite, profile, overrides, until=until, checks=checks)
        out["profile"] = profile
        if checks and checks.get("levels"):
            out["own_checks"] = {"levels": checks["levels"], "needs": checks.get("kinds")}
        out["fit"] = {m: everyone[m] for m in (a, b)}
        head = {"a": a, "b": b, "better": better, "verdict": kind}
        out["outcome"], out["headline"], out["use"] = outcome(head, out["fit"])
        # every pair in order: who won it and how (the page draws one square per world)
        out["rounds"] = [
            {
                "winner": p["winner"],
                "rule": p["rule"],
                "a_passed": p["a_passed"],
                "b_passed": p["b_passed"],
                # the right result (every decision right, nothing left undone), whether or not the test's own
                # pass, which also asks for its process, was earned: a clean run is both
                "a_right": bool(p["a_right"]),
                "b_right": bool(p["b_right"]),
                "a_cost": p["a_cost"],
                "b_cost": p["b_cost"],
                "run": p["run"],
                "match": p["match"],  # run/workflow/attempt: where the page finds this scenario's replay
            }
            for p in pairs
        ]
        # consistency: what each of the two did when given the same scenario twice (self runs), if it was
        own = {"version_key": version_key, "models": [a, b], "conditions": conditions, "suite": suite, "until": until}
        out["consistency"] = rows(store, questions.SELF_CONSISTENCY, own)
        # who else is fit on this task, cheapest first: where to look when neither of these two is
        out["fit_on_task"] = [
            {
                "model": m,
                "pass_rate": f["pass_rate"],
                "right_rate": f["right_rate"],
                "attempts": f["attempts"],
                "cost_per_attempt": f["cost_per_attempt"],
            }
            for m, f in everyone.items()
            if f["fit"]
        ]
    return dict(
        out,
        verdict=kind,
        better=better,
        pairs=len(pairs),
        wins={a: wins_a, b: wins_b},
        ties=ties,
        p_value=round(p_value, 4),
        decided_by=decided_by,
        models=stats,
        hazards=[h for h in hazards if h["tripped"]],
        evidence=sorted(runs.values(), key=lambda r: r["run"]),
        conditions=conditions,
        not_counted=not_counted,
        notes=notes,
    )


def print_verdict(v: dict) -> None:
    a, b = v["a"], v["b"]
    scope = f"  suite {v['suite']}" if v.get("suite") else ""
    if v.get("until"):
        scope += f"  the record up to {datetime.fromtimestamp(v['until'], UTC):%Y-%m-%d %H:%M} UTC"
    print(f"Task: {v['task']}  ({v['version']}){scope}")
    print(f"{a}  vs  {b}")
    if v["verdict"] == "no data":
        print(f"\nNo verdict: {v['notes'][0]}")
        return
    line = {
        "better": f"{v['better']} does this task better",
        "leaning": f"Leaning {v['better']}",
        "no real difference shown": "No real difference shown",
        "not enough evidence": "Not enough evidence",
    }[v["verdict"]]
    if v.get("headline"):
        print(f"\n{v['headline']}")
        print(f"\nFit for this task ({v['profile']} tolerance):")
        for name in (a, b):
            f = v["fit"][name]
            word = {True: "fit", False: "NOT fit", None: "too few attempts"}[f["fit"]]
            print(f"  {name}: {word}. {policy.result_line(f)}")
            for reason in f["reasons"]:
                print(f"      because: {reason}")
            for x in f["faults"]:
                if x["attempts_with"] and not x["breaks"] and x.get("kind_of") is None:
                    print(f"      tolerated: {x['fault']} ({x['level']}) in {x['attempts_with']} of {f['attempts']}")
        for x in v.get("consistency") or []:
            print(
                f"  Consistency, {x['model']} against itself: the same ending in {x['same']} of {x['scenarios']} "
                f"scenarios played twice (passed {x['passed']} of {x['attempts']}; counted in its fit above, never head to head)."
            )
        if v["outcome"] == "neither fit":
            others = [o for o in v["fit_on_task"] if o["model"] not in (a, b)]
            print("  Fit on this task among the models tested, cheapest first:")
            for o in others:
                print(
                    f"      {o['model']}: right result in {o['right_rate']:.0%} of {o['attempts']} attempts, "
                    f"{money(o['cost_per_attempt'])} an attempt"
                )
            if not others:
                print("      none: no tested model is fit for this task under this tolerance")
    print(f"\n{'Head to head' if v.get('headline') else 'Verdict'}: {line}")
    print(
        f"  {v['pairs']} judged pairs on the same generated worlds: {a} won {v['wins'][a]}, {b} won {v['wins'][b]}, "
        f"{v['ties']} tied (sign test p = {v['p_value']})"
    )
    how = ", ".join(f"{n} on {rule}" for rule, n in sorted(v["decided_by"].items(), key=lambda kv: -kv[1]))
    print(f"  decided: {how}")
    width = max(len(a), len(b), 5)
    print(f"\n  {'model':{width}}  right   passed   $/attempt  sec/attempt  mistakes  good enough (bar {v['bar']:.0%})")
    for name in (a, b):
        s = v["models"][name]
        print(
            f"  {name:{width}}  {s['right']:>2}/{s['attempts']:<3}  {s['passed']:>2}/{s['attempts']:<3}  "
            f"{money(s['cost_per_attempt']):>9}  "
            f"{s['seconds_per_attempt']:11.0f}  {s['mistakes']:8.1f}  {'yes' if s['good_enough'] else 'no'}"
        )
    if v["hazards"]:
        print("\nWhere they tripped on this task:")
        for h in v["hazards"]:
            print(f"  - {h['model']}: {h['hazard']} in {h['tripped']} of {h['exposed']} attempts")
    if v["notes"]:
        print("\nNotes:")
        for n in v["notes"]:
            print(f"  - {n}")
    print("\nEvidence (sealed match records):")
    for e in v["evidence"]:
        print(f"  - {e['run']}  seal {str(e['seal_sha256'])[:12]}  engine {str(e['engine_commit'])[:7]}")


def step_scope(store: str, workflow: str, a=None, b=None, suite=None, until=None) -> dict | None:
    """The scope a process question is asked in: the task's current version under one set of conditions, which
    is the scope of fitness. For two models, the conditions their verdict is read under; for a task alone, the
    conditions most of its suite record was played under. None when the task has no judged match (or the two
    never met on it)."""
    test = test_id(workflow)
    version = current_version(store, test)
    if version is None:
        return None
    task = {"test_id": test, "suite": suite, "version_key": version, "until": until}
    record = {r["conditions"]: r["pairs"] for r in rows(store, questions.TASK_CONDITIONS, task)}
    if a and b:
        met = rows(store, questions.PAIR_CONDITIONS, {**task, "a": a, "b": b})
        if not met:
            return None
        conditions = reference_conditions(met, record)
    elif record:
        conditions = max(sorted(record), key=lambda c: record[c])
    else:
        conditions = None
    return {"version_key": version, "conditions": conditions, "suite": suite, "until": until}


def process(store: str, steps: str, workflow: str, a=None, b=None, names=None, kinds=None, suite=None, until=None):
    """How the models worked on one task: every process question counted from the steps (ledger/routes.py), for
    every model on the task or for the two named. `store` is the shipped store, `steps` the one with the steps."""
    scope = step_scope(store, workflow, a, b, suite, until)
    if scope is None:
        return {"task": test_id(workflow), "checks": [], "note": "No judged match on file for this."}
    with routes.opened(steps) as ask:
        out = routes.process(ask, test_id(workflow), scope, names, kinds)
    if a or b:
        for c in out["checks"]:
            c["models"] = [m for m in c["models"] if m["model"] in (a, b)]
    return out


def route(store: str, steps: str, workflow: str, a: str, b: str, scenario: int | None = None, suite=None, until=None):
    """The same world, two routes: for the scenarios two models both played (the pairs their verdict counts),
    where they decided differently and what each had seen when it decided. One scenario in full with `scenario`
    (1 is the first), a line per scenario without it."""
    test = test_id(workflow)
    scope = step_scope(store, workflow, a, b, suite, until)
    out = {"task": test, "a": a, "b": b, "scenarios": []}
    if scope is None:
        return dict(out, note=f"{a} and {b} never met on {test}.")
    pairs = rows(store, questions.PAIR_ON_TASK, {"test_id": test, "a": a, "b": b, **scope})
    out.update(version=scope["version_key"], conditions=scope["conditions"], pairs=len(pairs))
    chosen = pairs if scenario is None else pairs[scenario - 1 : scenario]
    if scenario is not None and not chosen:
        return dict(out, note=f"There are {len(pairs)} scenarios; --scenario takes 1 to {len(pairs)}.")
    numbers = {p["match"]: n for n, p in enumerate(pairs, 1)}
    winners = {p["match"]: p["winner"] for p in pairs}
    with routes.opened(steps) as ask:
        out["decisions_need"] = routes.what_decisions_need(ask, scope["version_key"])
        worlds = routes.same_world(ask, [p["match"] for p in chosen])
    for w in worlds:
        # sides as the verdict names them: a is the first model asked for, whichever side it played
        side_of = {model: side for side, model in w["models"].items()}
        w.update(scenario=numbers[w["match"]], winner=winners[w["match"]], side={a: side_of.get(a), b: side_of.get(b)})
        if scenario is None:
            for detail in ("items", "records", "seen"):
                w.pop(detail)
    out["scenarios"] = worlds
    return out


def _models_table(models: list[dict], grader: bool) -> None:
    width = max([len(m["model"]) for m in models] + [5])
    head = f"  {'model':{width}}  attempts  with it  times  right anyway  passed anyway"
    print(head + ("  the grader counted" if grader else ""))
    for m in models:
        line = (
            f"  {m['model']:{width}}  {m['attempts']:8}  {m['attempts_with']:7}  {m['times']:5}  "
            f"{m['right_with']:12}  {m['passed_with']:13}"
        )
        if grader:
            line += f"  {m['grader_attempts_with'] or 0:18}"
        print(line)


def needs_line(needs: list[dict]) -> str:
    """What a decision depends on, in words: "each refund request refers to its order (order_id); ..."."""
    return "; ".join(f"each {n['decided']} refers to its {n['needs']} ({' > '.join(n['via'])})" for n in needs)


def print_process(p: dict, show_cypher: bool = False) -> None:
    print(f"Task: {p['task']}" + (f"  ({p['version']})" if p.get("version") else ""))
    if p.get("note"):
        print(p["note"])
        return
    if p.get("until"):
        print(f"The record up to {datetime.fromtimestamp(p['until'], UTC):%Y-%m-%d %H:%M} UTC")
    print(f"Conditions: {p['conditions']}")
    if p["decisions_need"]:
        print(f"What a decision needs here, as the worlds on file show it: {needs_line(p['decisions_need'])}.")
    print(
        "\nEach question is one pattern over the steps in the graph, counted per model: the attempts with it, how often "
        "in all, and of the attempts with it how many still got every decision right and how many the test passed."
    )
    for c in p["checks"]:
        kept = f"  (only: {', '.join(c['needs'])})" if c.get("needs") else ""
        print(f"\n{c['check']}: {c['asks']}{kept}")
        if c["note"]:
            print(f"  {c['note']}")
        if c["models"]:
            _models_table(c["models"], bool(c["grader_counts"]))
        else:
            print("  no attempts in this scope")
        if c["grader_counts"]:
            print(f"  (the grader's own count of '{c['grader_counts']}', in attempts, is the last column)")
        if show_cypher:
            print("\n  The question, as asked of the graph:")
            print("\n".join("    " + line for line in c["cypher"].splitlines()))
    print("\nGive a question a level in a verdict: ledger verdict <task> --a .. --b .. --check <question>=serious")


def print_route(r: dict) -> None:
    a, b = r["a"], r["b"]
    print(f"Task: {r['task']}" + (f"  ({r['version']})" if r.get("version") else ""))
    print(f"A  {a}\nB  {b}")
    if r.get("note"):
        print(f"\n{r['note']}")
        return
    if r.get("decisions_need"):
        print(f"What a decision needs here: {needs_line(r['decisions_need'])}.")
    if len(r["scenarios"]) == 1 and "items" in r["scenarios"][0]:
        w = r["scenarios"][0]
        won = "a tie" if w["winner"] == "tie" else f"won by {'A' if w['winner'] == a else 'B'}"
        print(f"\nScenario {w['scenario']} of {r['pairs']}: the same world, two routes  ({w['match']}, {won})")

        def cell(side: dict | None) -> str:
            if not side or not side.get("decision"):
                return "left undone"
            seen = [n["kind"] for n in side["needs"] if n["seen"]]
            unseen = [f"{n['kind']} {n['record']}" for n in side["needs"] if n["seen"] is False]
            text = f"{side['decision']} at step {side['step']}"
            text += f", had seen {' and '.join(seen)}" if seen else ""
            return text + (f", NOT {' or '.join(unseen)}" if unseen else "")

        for item in w["items"]:
            mark = "  <- decided differently" if item["differ"] else ""
            print(f"\n  {item['item']}{mark}")
            print(f"    A  {cell(item['sides'].get(w['side'][a]))}")
            print(f"    B  {cell(item['sides'].get(w['side'][b]))}")
        unseen = w["decided_unseen"]
        print(
            f"\n  Decided differently: {len(w['decided_differently'])} of {len(w['items'])} items. "
            f"Decided before seeing a record the item depends on: A {unseen.get(w['side'][a], 0)}, "
            f"B {unseen.get(w['side'][b], 0)}."
        )
        return
    print(f"\n{r['pairs']} scenarios, both models on the same world each time ({r['conditions']})")
    print("\n  scenario  won by  decided differently  A decided unseen  B decided unseen")
    for w in r["scenarios"]:
        won = "tie" if w["winner"] == "tie" else "A" if w["winner"] == a else "B"
        unseen = w["decided_unseen"]
        print(
            f"  {w['scenario']:8}  {won:6}  {len(w['decided_differently']):19}  "
            f"{unseen.get(w['side'][a], 0):16}  {unseen.get(w['side'][b], 0):16}"
        )
    print("\nOne scenario item by item: add --scenario N")


def money(x):
    return "-" if x is None else f"${x:.4f}"


def print_recommendation(r: dict) -> None:
    what = r.get("workflow") or f"suite {r.get('suite')}"
    print(f"Scope: {what}  ({r.get('version')})  budget {money(r.get('budget'))} per attempt")
    if r.get("pick"):
        label = {"pick": "Pick", "leaning": "Leaning"}.get(r["verdict"], r["verdict"])
        print(f"{label}: {r['pick']}")
    else:
        print(f"No winner named: {r['verdict']}")
    if r.get("models"):
        width = max(38, *(len(m["model"]) for m in r["models"]))
        print(f"\n  {'model':{width}} pairs  won  ties  passed  $/attempt  $/clean  mistakes")
        for m in r["models"]:
            flag = "" if m["within_budget"] else "  (over budget)"
            print(
                f"  {m['model']:{width}} {m['attempts']:5} {m['pair_wins']:4} {m['ties']:5} {m['passed']:7}  "
                f"{money(m['cost_per_attempt']):>9} {money(m['cost_per_clean']):>8} {m['mistakes']:9.1f}{flag}"
            )
    if r.get("head_to_head"):
        h = r["head_to_head"]
        print(f"\nHead to head vs {h['vs']}: {h['wins']}-{h['losses']} (sign test p = {h['p_value']})")
    if r.get("caveats"):
        print("\nCaveats:")
        for c in r["caveats"]:
            print(f"  - {c}")


def cell(value) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.4f}".rstrip("0").rstrip(".") if abs(value) < 1000 else f"{value:.0f}"
    if isinstance(value, list):
        return ", ".join(cell(v) for v in value)
    return str(value)


def print_table(rows: list[dict]) -> None:
    """Rows as aligned columns (use --json for machine-readable output)."""
    if not rows:
        print("(no rows)")
        return
    cols = list(rows[0])
    text = [[cell(r.get(c)) for c in cols] for r in rows]
    widths = [max(len(c), *(len(t[i]) for t in text)) for i, c in enumerate(cols)]
    print("  ".join(c.ljust(w) for c, w in zip(cols, widths, strict=True)).rstrip())
    for t in text:
        print("  ".join(v.ljust(w) for v, w in zip(t, widths, strict=True)).rstrip())


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ledger", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--store", default=DEFAULT_STORE, help=f"Relate store (default {DEFAULT_STORE})")
    # --store also works after the subcommand (ledger build --store x.rl ...).
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--store", default=argparse.SUPPRESS, help=f"Relate store (default {DEFAULT_STORE})")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser(
        "build", parents=[common], help="load Gladiator run records and validation records (safe to re-run)"
    )
    b.add_argument("--records", type=Path, required=True, help="folder holding runs/<run_id>/record.json")
    b.add_argument("--validations", type=Path, help="Gladiator validations/ folder")
    b.add_argument("--scores", type=Path, help="folder holding Epoch's eci_scores.csv (data/epoch)")
    b.add_argument(
        "--steps",
        action="store_true",
        help="also load every step of every attempt (about seven times larger; the process and route commands "
        "build such a store beside the shipped one by themselves)",
    )
    i = sub.add_parser(
        "import",
        parents=[common],
        help="copy Gladiator's sealed records into data/ (both halves of a finished match on fresh-world tests)",
    )
    i.add_argument("--records", type=Path, help="folder holding runs/<run_id>/record.json")
    i.add_argument(
        "--runner",
        help="address of a Gladiator race runner: import the sealed public records of its live races and batches",
    )
    i.add_argument("--validations", type=Path, help="Gladiator validations/ folder")
    i.add_argument("--data", type=Path, default=Path("data"), help="destination (default data/)")
    i.add_argument("--public-only", action="store_true", help="copy record.json only, never the private half")
    vf = sub.add_parser(
        "verify", parents=[common], help="check every shipped match: its seal, and its private half's fingerprint"
    )
    vf.add_argument("--data", type=Path, default=Path("data"), help="data folder (default data/)")
    a = sub.add_parser("ask", parents=[common], help="run one of the fixed questions")
    a.add_argument("question", choices=sorted(questions.ALL))
    a.add_argument("--param", action="append", default=[], help="name=value (numbers are parsed)")
    a.add_argument("--json", action="store_true")
    r = sub.add_parser(
        "recommend", parents=[common], help="which model for this workflow under this budget, with evidence"
    )
    r.add_argument("workflow", nargs="?", help="test id, e.g. refund-queue or gladiator/refund-queue")
    r.add_argument("--suite", help="recommend across every workflow in a Gladiator suite, e.g. small-tier")
    r.add_argument("--budget", type=float, required=True, help="USD you can pay per attempt")
    r.add_argument("--all-versions", action="store_true", help="also count results from older test versions")
    r.add_argument("--min-pairs", type=int, default=MIN_PAIRS)
    r.add_argument("--json", action="store_true")
    v = sub.add_parser(
        "verdict", parents=[common], help="one task, two models: which did it better, how sure, and is it good enough"
    )
    v.add_argument("workflow", help="test id, e.g. refund-queue or gladiator/refund-queue")
    v.add_argument("--a", required=True, help="first model, e.g. anthropic:claude-haiku-5-5")
    v.add_argument("--b", required=True, help="second model")
    v.add_argument("--suite", help="only pairs played in this suite (suites can set different budgets)")
    v.add_argument("--until", help=UNTIL_HELP)
    v.add_argument("--all-versions", action="store_true", help="also count pairs on older versions of the test")
    v.add_argument(
        "--bar", type=float, default=GOOD_ENOUGH, help="share of attempts with the right result that is good enough"
    )
    v.add_argument("--min-pairs", type=int, default=MIN_PAIRS)
    v.add_argument(
        "--profile",
        choices=[*policy.PROFILES, "none"],
        default=policy.DEFAULT_PROFILE,
        help="whose tolerance decides whether a model is fit for the task (enterprise is stricter; "
        "none = the head to head only)",
    )
    for level in policy.LEVELS:
        v.add_argument(
            f"--{level}",
            action="append",
            default=[],
            metavar="FAULT",
            help=f"treat this fault as {level} (repeatable), whatever the profile says",
        )
    v.add_argument(
        "--check",
        action="append",
        default=[],
        metavar="QUESTION=LEVEL",
        help="add a process question of your own as a fault at a level you choose, counted from the steps "
        f"(repeatable; questions: {', '.join(routes.CHECKS)}; levels: {', '.join(policy.LEVELS)})",
    )
    v.add_argument("--needs", action="append", default=[], metavar="KIND", help=NEEDS_HELP)
    v.add_argument("--data", type=Path, default=Path("data"), help="data folder, for the steps (default data/)")
    v.add_argument("--json", action="store_true")
    pr = sub.add_parser(
        "process",
        parents=[common],
        help="how the models worked on a task: process questions asked of every step on file",
    )
    pr.add_argument("workflow", help="test id, e.g. refund-queue")
    pr.add_argument("--a", help="only this model (with --b: these two, under the conditions of their verdict)")
    pr.add_argument("--b", help="second model")
    pr.add_argument("--check", action="append", default=[], choices=sorted(routes.CHECKS), help="only this question")
    pr.add_argument("--needs", action="append", default=[], metavar="KIND", help=NEEDS_HELP)
    pr.add_argument("--suite", help="only attempts played in this suite")
    pr.add_argument("--until", help=UNTIL_HELP)
    pr.add_argument("--cypher", action="store_true", help="print each question as it is asked of the graph")
    pr.add_argument("--data", type=Path, default=Path("data"), help="data folder (default data/)")
    pr.add_argument("--json", action="store_true")
    ro = sub.add_parser(
        "route", parents=[common], help="the same world, two routes: where two models parted ways, item by item"
    )
    ro.add_argument("workflow", help="test id, e.g. refund-queue")
    ro.add_argument("--a", required=True, help="first model")
    ro.add_argument("--b", required=True, help="second model")
    ro.add_argument("--scenario", type=int, help="one scenario in full (1 is the first); without it, a line each")
    ro.add_argument("--suite", help="only pairs played in this suite")
    ro.add_argument("--until", help=UNTIL_HELP)
    ro.add_argument("--data", type=Path, default=Path("data"), help="data folder (default data/)")
    ro.add_argument("--json", action="store_true")
    st = sub.add_parser("site", parents=[common], help="export the data the browser demo loads (site/data/)")
    st.add_argument("--data", type=Path, default=Path("data"), help="data folder (default data/)")
    st.add_argument("--out", type=Path, default=Path("site/data"), help="where to write (default site/data/)")
    sub.add_parser(
        "mcp", parents=[common], help="serve the store to an AI assistant over MCP (stdio): flows, verdict, spec"
    )
    sv = sub.add_parser(
        "serve",
        help="Ledger live: keep the record in one Relate store, take in each race as the runner files it, and "
        "hand the page what its own copy does not hold yet",
    )
    sv.add_argument("--runner", help="address of the Gladiator race runner to take sealed records in from")
    sv.add_argument(
        "--state", type=Path, default=Path("live-state"), help="where the store and the records taken in are kept"
    )
    sv.add_argument(
        "--data", type=Path, default=Path("data"), help="Ledger's data folder to start from (default data/)"
    )
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8790)
    sv.add_argument(
        "--origin", action="append", default=[], help="a page address allowed to read it from a browser (repeatable)"
    )
    fl = sub.add_parser("flows", parents=[common], help="describe your flow: find the closest tested workflows")
    fl.add_argument("described", nargs="?", help="what the flow does, in your own words")
    fl.add_argument("--json", action="store_true")
    sp = sub.add_parser(
        "spec", parents=[common], help="the build plan from one task and two models: decision, blueprint, evidence"
    )
    sp.add_argument("workflow", help="test id, e.g. refund-queue")
    sp.add_argument("--a", required=True, help="first model")
    sp.add_argument("--b", required=True, help="second model")
    sp.add_argument(
        "--profile",
        choices=[*policy.PROFILES, "none"],
        default=policy.DEFAULT_PROFILE,
        help="whose tolerance decides whether a model is fit for the task (none = the head to head only)",
    )
    sp.add_argument("--suite", help="only pairs played in this suite")
    sp.add_argument("--until", help=UNTIL_HELP)
    sp.add_argument(
        "--bar", type=float, default=GOOD_ENOUGH, help="share of attempts with the right result that is good enough"
    )
    sp.add_argument("--out", type=Path, help="write the spec to this file (Markdown) instead of printing it")
    sp.add_argument("--json", action="store_true", help="print the spec as JSON only")
    sp.add_argument(
        "--report",
        choices=["spec", "cost", "evidence", "all"],
        default="spec",
        help="which document: the spec (build plan), the cost breakdown, the evidence report, or all three",
    )
    o = sub.add_parser(
        "opponents", parents=[common], help="models that score close to one you name: candidates for a fair match"
    )
    o.add_argument("model", help="a model id or name, e.g. anthropic:claude-haiku-5-5 or 'haiku 5.5'")
    o.add_argument("--open-only", action="store_true", help="only models with open weights")
    o.add_argument("-n", type=int, default=5, help="how many to show (default 5)")
    o.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if args.cmd == "build":
        Path(args.store).parent.mkdir(parents=True, exist_ok=True)
        out = {"records": load.load(args.records, args.store)}
        load.link_forks(args.store)
        if args.validations:
            out["validations"] = load.load_validations(args.validations, args.store)
        if args.scores:
            out["scores"] = load.load_scores(args.scores, args.store)
        if args.steps:
            out["steps"] = load.load_steps(args.records, args.store)
        print(json.dumps({k: {x: v[x] for x in v if x != "stats"} for k, v in out.items()}, indent=1))
    elif args.cmd == "import":
        out = {}
        if args.runner:  # live races: public halves only, each checked against its seal like any other record
            import tempfile

            with tempfile.TemporaryDirectory() as folder:
                out["live"] = publish.fetch_live(args.runner, Path(folder))
                out["live_records"] = publish.import_records(Path(folder), args.data / "records", private=False)
        if args.records:
            out["records"] = publish.import_records(args.records, args.data / "records", not args.public_only)
        if args.validations:
            out["validations"] = publish.import_validations(args.validations, args.data / "validations")
        short = {k: {x: (len(y) if x.endswith("copied") else y) for x, y in v.items()} for k, v in out.items()}
        print(json.dumps(short, indent=1))
    elif args.cmd == "verify":
        result = publish.verify(args.data / "records")
        print(
            f"{result['records']} match records, every seal checked; "
            f"{result['private_halves']} private halves checked against their record's fingerprint."
        )
        for problem in result["problems"]:
            print(f"PROBLEM  {problem}")
        if result["problems"]:
            return 1
        print("All match.")
    elif args.cmd == "ask":
        params = {}
        for kv in args.param:
            k, _, v = kv.partition("=")
            if v.lower() in ("true", "false"):
                params[k] = v.lower() == "true"
                continue
            try:
                params[k] = float(v) if "." in v else int(v)
            except ValueError:
                params[k] = v
        for k, v in SCOPE_DEFAULTS.items():
            params.setdefault(k, v)
        asked = routes.ensure(args.store) if args.question in STEP_QUESTIONS else args.store
        result = rows(asked, questions.ALL[args.question], params)
        if args.json:
            print(json.dumps(result, indent=1, default=str))
        else:
            print_table(result)
    elif args.cmd == "recommend":
        if not (args.workflow or args.suite):
            ap.error("recommend needs a workflow or --suite")
        result = recommend(args.store, args.workflow, args.budget, args.all_versions, args.min_pairs, args.suite)
        if args.json:
            print(json.dumps(result, indent=1, default=str))
        else:
            print_recommendation(result)
    elif args.cmd == "site":
        from ledger import site

        sizes = site.export(args.data, args.store, args.out)
        for name, size in sizes.items():
            print(f"{args.out / name}: {size / 1024:.0f} KB")
    elif args.cmd == "mcp":
        from ledger import assistant

        assistant.serve(args.store)
    elif args.cmd == "serve":
        from ledger import live

        live.serve(args.state, args.data, args.runner, args.host, args.port, args.origin)
    elif args.cmd == "flows":
        result = find_flows(args.store, args.described)
        if args.json:
            print(json.dumps(result, indent=1, default=str))
        else:
            print_flows(result)
    elif args.cmd == "spec":
        a = resolve_model(args.store, args.a) or args.a
        b = resolve_model(args.store, args.b) or args.b
        profile = None if args.profile == "none" else args.profile
        until = parse_until(args.until)
        found = verdict(args.store, args.workflow, a, b, args.suite, bar=args.bar, profile=profile, until=until)
        found["suite"] = args.suite
        built = spec.build(lambda q, p: rows(args.store, q, p), found)
        title = (built.get("blueprint") or {}).get("title") or built["task"]
        docs = {
            "spec": lambda: json.dumps(built, indent=1, default=str) if args.json else spec.markdown(built),
            "cost": lambda: reports.cost_markdown(found, title),
            "evidence": lambda: reports.evidence_markdown(found, title),
        }
        wanted = list(docs) if args.report == "all" else [args.report]
        if args.report == "all" and args.out:
            # three files side by side: spec.md, spec.cost.md, spec.evidence.md
            for name in wanted:
                path = args.out if name == "spec" else args.out.with_suffix(f".{name}{args.out.suffix}")
                path.write_text(docs[name](), encoding="utf-8")
                print(f"{name.capitalize()} written to {path}")
        elif args.out:
            args.out.write_text(docs[wanted[0]](), encoding="utf-8")
            print(f"{wanted[0].capitalize()} written to {args.out}")
        else:
            print("\n\n".join(docs[name]() for name in wanted))
    elif args.cmd == "opponents":
        result = opponents(args.store, args.model, args.open_only, args.n)
        if args.json:
            print(json.dumps(result, indent=1, default=str))
        else:
            print_opponents(result)
    elif args.cmd == "verdict":
        a = resolve_model(args.store, args.a) or args.a
        b = resolve_model(args.store, args.b) or args.b
        overrides = {fault: level for level in policy.LEVELS for fault in getattr(args, level)}
        profile = None if args.profile == "none" else args.profile
        checks = None
        if args.check:
            levels = dict(text.partition("=")[::2] for text in args.check)
            for name, level in levels.items():
                if name not in routes.CHECKS or level not in policy.LEVELS:
                    ap.error(
                        f"--check takes QUESTION=LEVEL: one of {', '.join(routes.CHECKS)}, "
                        f"at one of {', '.join(policy.LEVELS)}"
                    )
            checks = {"store": routes.ensure(args.store, args.data), "levels": levels, "kinds": args.needs or None}
        result = verdict(
            args.store,
            args.workflow,
            a,
            b,
            args.suite,
            args.all_versions,
            args.bar,
            args.min_pairs,
            profile,
            overrides,
            parse_until(args.until),
            checks,
        )
        if args.json:
            print(json.dumps(result, indent=1, default=str))
        else:
            print_verdict(result)
    elif args.cmd in ("process", "route"):
        a = (resolve_model(args.store, args.a) or args.a) if args.a else None
        b = (resolve_model(args.store, args.b) or args.b) if args.b else None
        steps = routes.ensure(args.store, args.data)
        until = parse_until(args.until)
        if args.cmd == "process":
            result = process(
                args.store, steps, args.workflow, a, b, args.check or None, args.needs or None, args.suite, until
            )
        else:
            result = route(args.store, steps, args.workflow, a, b, args.scenario, args.suite, until)
        if args.json:
            print(json.dumps(result, indent=1, default=str))
        elif args.cmd == "process":
            print_process(result, args.cypher)
        else:
            print_route(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
