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
"""

import argparse
import json
import math
import sys
from pathlib import Path

import relate

from ledger import load, policy, publish, questions, reports, spec
from ledger.bridges import epoch

DEFAULT_STORE = "data/ledger.rl"
GOOD_ENOUGH = 0.8  # default bar for "good enough for this task": share of attempts passed
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


SCOPE_DEFAULTS = {"test_id": None, "suite": None, "version_key": None, "current_only": False, "open_only": False}


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


def fitness(store: str, test: str, version: str, suites: list[str], profile: str, overrides=None, bar=None) -> dict:
    """Every model's fitness for one task version, by model id, under a profile (ledger/policy.py). Counts every
    attempt the model made on the task under those suites' settings, whoever the opponent was."""
    scope = {"version_key": version, "suites": suites}
    faults: dict[str, list[dict]] = {}
    for f in rows(store, questions.TASK_FAULTS, scope):
        faults.setdefault(f.pop("model"), []).append(f)
    return {
        r["model"]: policy.assess(test, r, faults.get(r["model"], []), profile, overrides, bar)
        for r in rows(store, questions.TASK_ATTEMPTS, scope)
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
    spent = sum(p[f"{side}_cost"] or 0 for p in pairs)
    return {
        "attempts": n,
        "passed": passed,
        "pass_rate": passed / n,
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
) -> dict:
    """A task claim: which of two models did THIS task better when they played the same worlds, how sure that is,
    and whether either is good enough. Only the pairs where these two met count. Never a claim about a model in
    general, and no winner is named on thin evidence or a level score."""
    test = test_id(workflow)
    version = None if all_versions else current_version(store, test)
    params = {"test_id": test, "a": a, "b": b, "suite": suite, "version_key": version}
    pairs = rows(store, questions.PAIR_ON_TASK, params)
    out = {"task": test, "version": version or "all versions", "suite": suite, "a": a, "b": b, "bar": bar}
    if not pairs:
        return dict(out, verdict="no data", better=None, pairs=0, notes=[f"{a} and {b} never met on {test}."])
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
        s["good_enough"] = s["pass_rate"] >= bar
    if better and not stats[better]["good_enough"]:
        notes.append(
            f"{better} did better here, but passed only {stats[better]['pass_rate']:.0%} of attempts "
            f"(bar {bar:.0%}): better than the other one is not the same as good enough."
        )
    if not any(s["good_enough"] for s in stats.values()):
        notes.append(f"Neither model reaches the bar of {bar:.0%} passed on this task.")
    efforts = {tuple(s["effort"]) for s in stats.values()}
    if len(efforts) > 1 or any(len(e) > 1 for e in efforts):
        notes.append("The two models did not play under one identical effort setting in every pair.")
    hazards = rows(store, questions.PAIR_HAZARDS, params)
    runs = {}
    for p in pairs:
        runs[p["run"]] = {"run": p["run"], "seal_sha256": p["seal"], "engine_commit": p["engine"], "suite": p["suite"]}
    if profile:
        # Fit first: is each model fit for the task at all, under the reader's tolerance? Then the head to head.
        suites = sorted({p["suite"] for p in pairs})
        version_key = max(p["version"] for p in pairs)
        everyone = fitness(store, test, version_key, suites, profile, overrides)
        out["profile"] = profile
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
                "a_cost": p["a_cost"],
                "b_cost": p["b_cost"],
                "run": p["run"],
                "match": p["match"],  # run/workflow/attempt: where the page finds this scenario's replay
            }
            for p in pairs
        ]
        # who else is fit on this task, cheapest first: where to look when neither of these two is
        out["fit_on_task"] = [
            {
                "model": m,
                "pass_rate": f["pass_rate"],
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
        notes=notes,
    )


def print_verdict(v: dict) -> None:
    a, b = v["a"], v["b"]
    scope = f"  suite {v['suite']}" if v.get("suite") else ""
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
            print(
                f"  {name}: {word}. Passed {f['passed']} of {f['attempts']} ({f['pass_rate']:.0%}; bar {f['bar']:.0%})."
            )
            for reason in f["reasons"]:
                print(f"      because: {reason}")
            for x in f["faults"]:
                if x["attempts_with"] and not x["breaks"] and x.get("kind_of") is None:
                    print(f"      tolerated: {x['fault']} ({x['level']}) in {x['attempts_with']} of {f['attempts']}")
        if v["outcome"] == "neither fit":
            others = [o for o in v["fit_on_task"] if o["model"] not in (a, b)]
            print("  Fit on this task among the models tested, cheapest first:")
            for o in others:
                print(
                    f"      {o['model']}: passed {o['pass_rate']:.0%} of {o['attempts']}, {money(o['cost_per_attempt'])} an attempt"
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
    print(f"\n  {'model':{width}}  passed   $/attempt  sec/attempt  mistakes  good enough (bar {v['bar']:.0%})")
    for name in (a, b):
        s = v["models"][name]
        print(
            f"  {name:{width}}  {s['passed']:>2}/{s['attempts']:<3}  {money(s['cost_per_attempt']):>9}  "
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
    i = sub.add_parser(
        "import",
        parents=[common],
        help="copy Gladiator's sealed records into data/ (both halves of a finished match on fresh-world tests)",
    )
    i.add_argument("--records", type=Path, help="folder holding runs/<run_id>/record.json")
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
    v.add_argument("--all-versions", action="store_true", help="also count pairs on older versions of the test")
    v.add_argument("--bar", type=float, default=GOOD_ENOUGH, help="share of attempts passed that counts as good enough")
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
    v.add_argument("--json", action="store_true")
    st = sub.add_parser("site", parents=[common], help="export the data the browser demo loads (site/data/)")
    st.add_argument("--data", type=Path, default=Path("data"), help="data folder (default data/)")
    st.add_argument("--out", type=Path, default=Path("site/data"), help="where to write (default site/data/)")
    sub.add_parser(
        "mcp", parents=[common], help="serve the store to an AI assistant over MCP (stdio): flows, verdict, spec"
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
    sp.add_argument("--bar", type=float, default=GOOD_ENOUGH, help="share of attempts passed that is good enough")
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
        print(json.dumps({k: {x: v[x] for x in v if x != "stats"} for k, v in out.items()}, indent=1))
    elif args.cmd == "import":
        out = {}
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
        result = rows(args.store, questions.ALL[args.question], params)
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
        found = verdict(args.store, args.workflow, a, b, args.suite, bar=args.bar, profile=profile)
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
        result = verdict(
            args.store, args.workflow, a, b, args.suite, args.all_versions, args.bar, args.min_pairs, profile, overrides
        )
        if args.json:
            print(json.dumps(result, indent=1, default=str))
        else:
            print_verdict(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
