"""ledger: build the graph from Gladiator records, ask it questions, get a recommendation.

ledger build --records runs/ --validations validations/ [--store data/ledger.rl]
ledger ask hazard_profile
ledger ask best_under_budget --param test_id=gladiator/refund-queue --param budget=0.05
ledger recommend refund-queue --budget 0.05
"""

import argparse
import json
import math
import sys
from pathlib import Path

import relate

from ledger import load, questions

DEFAULT_STORE = "data/ledger.rl"
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


def recommend(store: str, workflow: str, budget: float, all_versions: bool = False, min_pairs: int = MIN_PAIRS):
    """A pick, the evidence behind it and its caveats. Names no winner on thin evidence or a tie."""
    test = test_id(workflow)
    version = None if all_versions else current_version(store, test)
    if not all_versions and version is None:
        return {"workflow": test, "pick": None, "verdict": "no data", "caveats": [f"No judged matches on {test}."]}
    params = {"test_id": test, "budget": budget, "version_key": version}
    table = rows(store, questions.BEST_UNDER_BUDGET, params)
    caveats = []
    fits = [r for r in table if r["within_budget"]]
    over = [r["model"] for r in table if not r["within_budget"]]
    if over:
        caveats.append(f"Over budget (${budget:.4f}/attempt): {', '.join(over)}.")
    result = {"workflow": test, "version": version or "all versions", "budget": budget, "models": table}
    if not fits:
        return dict(result, pick=None, verdict="nothing fits the budget", caveats=caveats)
    thin = [r["model"] for r in fits if r["attempts"] < min_pairs]
    if thin:
        caveats.append(f"Fewer than {min_pairs} judged pairs: {', '.join(thin)}.")
    ranked = [r for r in fits if r["attempts"] >= min_pairs]
    if not ranked:
        return dict(result, pick=None, verdict="not enough evidence", caveats=caveats)
    top = ranked[0]
    evidence, verdict, pick = [], "pick", top["model"]
    if len(ranked) > 1:
        second = ranked[1]
        h2h = rows(store, questions.HEAD_TO_HEAD, dict(params, a=top["model"], b=second["model"]))
        wins = sum(1 for r in h2h if r["winner"] == top["model"])
        losses = sum(1 for r in h2h if r["winner"] == second["model"])
        evidence = h2h
        if not h2h:
            caveats.append(f"{top['model']} and {second['model']} never played each other: the order is indirect.")
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
    cycles = [c for c in rows(store, questions.BEAT_CYCLES) if version is None or c["version"] == version]
    if cycles:
        caveats.append(f"Beat cycles on this test ({len(cycles)}): the ranking is not a simple ladder.")
    if version:
        promo = [r for r in rows(store, questions.PROMOTION) if r["version"] == version]
        if promo and not promo[0]["validated"]:
            caveats.append("This test version has no passing validation record in the graph.")
    else:
        stale = rows(store, questions.STALE_RESULTS)
        if any(s["version"].startswith(test + "@") for s in stale):
            caveats.append("Includes results from older versions of this test.")
    return dict(result, pick=pick, verdict=verdict, evidence=evidence, caveats=caveats)


def money(x):
    return "-" if x is None else f"${x:.4f}"


def print_recommendation(r: dict) -> None:
    print(f"Workflow: {r['workflow']}  ({r.get('version')})  budget {money(r.get('budget'))} per attempt")
    if r.get("pick"):
        label = {"pick": "Pick", "leaning": "Leaning"}.get(r["verdict"], r["verdict"])
        print(f"{label}: {r['pick']}")
    else:
        print(f"No winner named: {r['verdict']}")
    if r.get("models"):
        print("\n  model                                   pairs  won  ties  passed  $/attempt  $/clean  mistakes")
        for m in r["models"]:
            flag = "" if m["within_budget"] else "  (over budget)"
            print(
                f"  {m['model']:38} {m['attempts']:5} {m['pair_wins']:4} {m['ties']:5} {m['passed']:7}  "
                f"{money(m['cost_per_attempt']):>9} {money(m['cost_per_clean']):>8} {m['mistakes']:9.1f}{flag}"
            )
    if r.get("head_to_head"):
        h = r["head_to_head"]
        print(f"\nHead to head vs {h['vs']}: {h['wins']}-{h['losses']} (sign test p = {h['p_value']})")
    if r.get("caveats"):
        print("\nCaveats:")
        for c in r["caveats"]:
            print(f"  - {c}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ledger", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--store", default=DEFAULT_STORE, help=f"Relate store (default {DEFAULT_STORE})")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="load Gladiator run records and validation records (safe to re-run)")
    b.add_argument("--records", type=Path, required=True, help="folder holding runs/<run_id>/record.json")
    b.add_argument("--validations", type=Path, help="Gladiator validations/ folder")
    a = sub.add_parser("ask", help="run one of the fixed questions")
    a.add_argument("question", choices=sorted(questions.ALL))
    a.add_argument("--param", action="append", default=[], help="name=value (numbers are parsed)")
    a.add_argument("--json", action="store_true")
    r = sub.add_parser("recommend", help="which model for this workflow under this budget, with evidence")
    r.add_argument("workflow", help="test id, e.g. refund-queue or gladiator/refund-queue")
    r.add_argument("--budget", type=float, required=True, help="USD you can pay per attempt")
    r.add_argument("--all-versions", action="store_true", help="also count results from older test versions")
    r.add_argument("--min-pairs", type=int, default=MIN_PAIRS)
    r.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if args.cmd == "build":
        Path(args.store).parent.mkdir(parents=True, exist_ok=True)
        out = {"records": load.load(args.records, args.store)}
        load.link_forks(args.store)
        if args.validations:
            out["validations"] = load.load_validations(args.validations, args.store)
        print(json.dumps({k: {x: v[x] for x in v if x != "stats"} for k, v in out.items()}, indent=1))
    elif args.cmd == "ask":
        params = {}
        for kv in args.param:
            k, _, v = kv.partition("=")
            try:
                params[k] = float(v) if "." in v else int(v)
            except ValueError:
                params[k] = v
        params.setdefault("version_key", None)
        result = rows(args.store, questions.ALL[args.question], params)
        if args.json:
            print(json.dumps(result, indent=1, default=str))
        else:
            for row in result:
                print(row)
    elif args.cmd == "recommend":
        result = recommend(args.store, args.workflow, args.budget, args.all_versions, args.min_pairs)
        if args.json:
            print(json.dumps(result, indent=1, default=str))
        else:
            print_recommendation(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
