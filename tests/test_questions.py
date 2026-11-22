import hashlib
import json

from ledger import cli, load, questions
from tests.test_load import attempt


def seal(body):
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return {"sha256": hashlib.sha256(canonical).hexdigest(), "body": body}


def run(folder, run_id, a, b, results, version="1.0.0"):
    """results: list of (a_passed, b_passed, a_cost, b_cost) per pair, all on test t/x."""
    ar, br = [], []
    for i, (pa, pb, ca, cb) in enumerate(results, start=1):
        for side, passed, cost in ((ar, pa, ca), (br, pb, cb)):
            r = attempt("x", passed, cost)
            r["attempt"] = i
            r["challenge"]["version"] = version
            side.append(r)
    body = {
        "record_version": 2,
        "run_id": run_id,
        "suite": {"name": "s", "success": {"profile": "balanced"}},
        "settings": {"defaults": {"effort": "low"}},
        "contestants": {"A": {"id": a, "results": ar}, "B": {"id": b, "results": br}},
    }
    d = folder / run_id
    d.mkdir(parents=True)
    (d / "record.json").write_text(json.dumps(seal(body)))


def build(tmp_path):
    runs = tmp_path / "runs"
    # A beats B, B beats C, C beats A (a cycle), all on t/x 1.0.0; A is the cheapest.
    run(runs, "r1", "p:a", "p:b", [(True, False, 0.01, 0.02)] * 5)
    run(runs, "r2", "p:b", "p:c", [(True, False, 0.02, 0.03)] * 5)
    run(runs, "r3", "p:c", "p:a", [(True, False, 0.03, 0.01)] * 5)
    store = str(tmp_path / "s.rl")
    load.load(runs, store)
    return store, runs


def test_beat_cycle_is_found_and_reported(tmp_path):
    store, _ = build(tmp_path)
    cycles = cli.rows(store, questions.BEAT_CYCLES, {"suite": None})
    assert len(cycles) == 1 and {cycles[0]["a"], cycles[0]["b"], cycles[0]["c"]} == {"p:a", "p:b", "p:c"}
    rec = cli.recommend(store, "t/x", budget=1.0, min_pairs=5)
    assert any("cycle" in c for c in rec["caveats"])


def test_recommend_names_no_winner_on_thin_evidence_or_a_tie(tmp_path):
    store, _ = build(tmp_path)
    thin = cli.recommend(store, "t/x", budget=1.0)  # 10 pairs each, default minimum 8 -> enough
    assert thin["verdict"] != "not enough evidence"
    assert cli.recommend(store, "t/x", budget=1.0, min_pairs=20)["pick"] is None
    # Every model won 5 of 10: the top two went 0-5 or 5-0 head to head, so a pick or a tie, never a made-up one.
    rec = cli.recommend(store, "t/x", budget=1.0, min_pairs=5)
    h2h = rec.get("head_to_head")
    assert rec["pick"] is None or (h2h and h2h["wins"] > h2h["losses"])


def test_budget_filters_models_and_says_what_it_rules_out(tmp_path):
    store, _ = build(tmp_path)
    rec = cli.recommend(store, "t/x", budget=0.015, min_pairs=5)
    fits = [m["model"] for m in rec["models"] if m["within_budget"]]
    assert fits == ["p:a"] and any("Over budget" in c for c in rec["caveats"])


def test_clear_lead_is_a_pick_and_a_small_lead_is_a_lean(tmp_path):
    runs = tmp_path / "runs"
    run(runs, "r1", "p:a", "p:b", [(True, False, 0.01, 0.01)] * 9)
    store = str(tmp_path / "s.rl")
    load.load(runs, store)
    rec = cli.recommend(store, "t/x", budget=1.0)
    assert rec["pick"] == "p:a" and rec["verdict"] == "pick" and rec["head_to_head"]["p_value"] < 0.05

    runs2 = tmp_path / "runs2"
    run(runs2, "r1", "p:a", "p:b", [(True, False, 0.01, 0.01)] * 5 + [(False, True, 0.01, 0.01)] * 4)
    store2 = str(tmp_path / "s2.rl")
    load.load(runs2, store2)
    lean = cli.recommend(store2, "t/x", budget=1.0)
    assert lean["pick"] == "p:a" and lean["verdict"] == "leaning"


def test_stale_results_and_validation_evidence(tmp_path):
    runs = tmp_path / "runs"
    run(runs, "old", "p:a", "p:b", [(True, False, 0.01, 0.01)], version="1.0.0")
    run(runs, "new", "p:a", "p:b", [(True, False, 0.01, 0.01)], version="1.1.0")
    store = str(tmp_path / "s.rl")
    load.load(runs, store)
    stale = cli.rows(store, questions.STALE_RESULTS)
    assert [s["version"].split(":")[0] for s in stale] == ["t/x@1.0.0"] and stale[0]["newer_versions"] == ["1.1.0"]

    vdir = tmp_path / "validations"
    vdir.mkdir()
    body = {
        "kind": "validation",
        "record_version": 1,
        "challenge": {"id": "t/x", "version": "1.1.0", "content_sha256": "ab" * 32},
        "valid": True,
        "problems": [],
        "levels": {
            "standard": {
                "seeds": 20,
                "oracle_passed": 20,
                "players": {
                    "blind_retry": {"must_fail": True, "passed_seeds": 1, "ok": True},
                    "stale": {"must_fail": False, "passed_seeds": 0, "ok": True},
                },
            }
        },
    }
    (vdir / "x.json").write_text(json.dumps(seal(body)))
    out = load.load_validations(vdir, store)
    assert out["loaded"] == 1 and out["checks"] == 2  # reference + blind_retry; stale did not apply
    promo = {r["version"].split(":")[0]: r for r in cli.rows(store, questions.PROMOTION)}
    assert promo["t/x@1.1.0"]["validated"] and not promo["t/x@1.0.0"]["validated"]
    guards = cli.rows(store, "MATCH (:ValidationRun)-[:GUARDS]->(h:Hazard) RETURN h.name AS h")
    assert [g["h"] for g in guards] == ["ambiguous timeout (retried without checking)"]


def test_sign_test():
    assert cli.sign_test_p(9, 0) < 0.01
    assert cli.sign_test_p(5, 3) > 0.5
    assert cli.sign_test_p(0, 0) == 1.0


def test_suite_scope_counts_every_workflow_and_skips_old_versions(tmp_path):
    runs = tmp_path / "runs"
    run(runs, "old", "p:a", "p:b", [(False, True, 0.01, 0.01)] * 9, version="1.0.0")  # b won on the old version
    run(runs, "new", "p:a", "p:b", [(True, False, 0.01, 0.01)] * 9, version="1.1.0")  # a wins on the current one
    store = str(tmp_path / "s.rl")
    load.load(runs, store)
    rec = cli.recommend(store, None, budget=1.0, suite="s")
    assert rec["pick"] == "p:a" and all(m["attempts"] == 9 for m in rec["models"])
    every = cli.recommend(store, None, budget=1.0, suite="s", all_versions=True)
    assert all(m["attempts"] == 18 for m in every["models"]) and every["pick"] is None  # 9-9: a tie


def test_only_model_in_budget_says_so(tmp_path):
    runs = tmp_path / "runs"
    run(runs, "r1", "p:a", "p:b", [(True, False, 0.01, 0.5)] * 9)
    store = str(tmp_path / "s.rl")
    load.load(runs, store)
    rec = cli.recommend(store, "t/x", budget=0.1)
    assert rec["pick"] == "p:a" and any("only model" in c for c in rec["caveats"])


def test_cycles_are_limited_to_the_suite_in_scope(tmp_path):
    store, _runs = build(tmp_path)  # the a > b > c > a cycle is in suite "s"
    assert len(cli.rows(store, questions.BEAT_CYCLES, {"suite": "s"})) == 1
    assert cli.rows(store, questions.BEAT_CYCLES, {"suite": "other"}) == []
