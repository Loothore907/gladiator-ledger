import hashlib
import json

import relate

from ledger.load import load


def attempt(node, passed, cost, retries=0, correct=3):
    return {
        "node": node,
        "attempt": 1,
        "challenge": {"id": f"t/{node}", "version": "1.0.0", "content_sha256": "ab" * 32, "status": "community"},
        "instance": {"seed": 1, "difficulty": "standard"},
        "passed": passed,
        "termination": "session_ended",
        "cost_usd": cost,
        "input_tokens": 100,
        "output_tokens": 10,
        "wall_s": 10.0,
        "grade_details": {
            "items": 3,
            "correct": correct,
            "missing": 0,
            "error_severity": 0,
            "blind_retries_after_unknown_outcome": retries,
        },
    }


def write_record(folder, run_id, a_results, b_results):
    body = {
        "record_version": 2,
        "run_id": run_id,
        "suite": {"name": "s", "success": {"profile": "balanced"}},
        "settings": {"defaults": {"effort": "low"}},
        "contestants": {"A": {"id": "p:alpha", "results": a_results}, "B": {"id": "q:beta", "results": b_results}},
    }
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    d = folder / run_id
    d.mkdir(parents=True)
    (d / "record.json").write_text(json.dumps({"sha256": hashlib.sha256(canonical).hexdigest(), "body": body}))


def test_load_judges_pairs_links_hazards_and_is_idempotent(tmp_path):
    write_record(
        tmp_path / "runs",
        "r1",
        [attempt("x", True, 0.01), attempt("y", False, 0.01, retries=2, correct=1)],
        [attempt("x", False, 0.01), attempt("y", False, 0.01, correct=2)],
    )
    store = str(tmp_path / "s.rl")
    first = load(tmp_path / "runs", store)
    second = load(tmp_path / "runs", store)
    assert first["loaded"] == 1 and first["stats"]["nodes_created"] > 0
    assert second["stats"]["nodes_created"] == 0 and second["stats"]["relationships_created"] == 0

    with relate.connect(store, read_only=True) as conn:
        wins = {
            (r["node"], r["rule"]): r["winner"]
            for r in conn.execute(
                "MATCH (m:Match)-[:WON_BY]->(w:Model) RETURN m.node AS node, m.rule AS rule, w.name AS winner"
            )
        }
        assert wins == {("x", "success"): "p:alpha", ("y", "progress"): "q:beta"}
        tripped = conn.execute(
            "MATCH (:Attempt)-[t:TRIPPED_ON]->(h:Hazard) RETURN h.name AS h, t.count AS n"
        ).fetchall()
        assert [(r["h"], r["n"]) for r in tripped] == [("ambiguous timeout (retried without checking)", 2)]
        includes = conn.execute("MATCH (tv:TestVersion)-[:INCLUDES]->(:Hazard) RETURN count(tv) AS n").single()
        assert includes["n"] == 2  # both test versions can generate the hazard
        # every run is linked to the bridge it came from, and loading twice made one source, not two
        sources = conn.execute("MATCH (r:Run)-[:FROM]->(s:Source) RETURN s.name AS s, count(r) AS n").fetchall()
        assert [(r["s"], r["n"]) for r in sources] == [("gladiator", 1)]
        assert conn.execute("MATCH (s:Source) RETURN count(s) AS n").single()["n"] == 1


def test_any_bridge_that_hands_back_the_shared_shape_can_be_written(tmp_path):
    """The loader knows nothing about Gladiator's files: rows in the shared shape from another source load too,
    and the graph keeps the two sources apart."""
    from ledger.bridges import gladiator
    from ledger.load import write

    write_record(tmp_path / "runs", "r1", [attempt("x", True, 0.01)], [attempt("x", False, 0.01)])
    store = str(tmp_path / "s.rl")
    load(tmp_path / "runs", store)
    other = gladiator.read_records(tmp_path / "runs")
    other.source, other.description = "another-harness", "a second source in the same shape"
    other.runs[0]["run_id"] = "other-1"
    for m in other.runs[0]["matches"]:
        m["key"] = "other-1/" + m["key"].split("/", 1)[1]
        m["props"]["run_id"] = "other-1"
        for a in m["attempts"]:
            a["key"] = "other-1/" + a["key"].split("/", 1)[1]
    write(other, store)
    with relate.connect(store, read_only=True) as conn:
        got = conn.execute("MATCH (r:Run)-[:FROM]->(s:Source) RETURN s.name AS s, r.run_id AS r ORDER BY s").fetchall()
        assert [(r["s"], r["r"]) for r in got] == [("another-harness", "other-1"), ("gladiator", "r1")]


def test_tampered_record_is_skipped(tmp_path):
    write_record(tmp_path / "runs", "r1", [attempt("x", True, 0.01)], [attempt("x", False, 0.01)])
    path = tmp_path / "runs" / "r1" / "record.json"
    rec = json.loads(path.read_text())
    rec["body"]["contestants"]["B"]["results"][0]["passed"] = True
    path.write_text(json.dumps(rec))
    result = load(tmp_path / "runs", str(tmp_path / "s.rl"))
    assert result["loaded"] == 0 and len(result["skipped_bad_seal"]) == 1
