import hashlib
import json

import relate

from ledger import questions
from ledger.load import load


def attempt(node, passed, cost, retries=0, correct=3, wrong=0, confusions=None, termination="session_ended"):
    return {
        "node": node,
        "attempt": 1,
        "challenge": {"id": f"t/{node}", "version": "1.0.0", "content_sha256": "ab" * 32, "status": "community"},
        "instance": {"seed": 1, "difficulty": "standard"},
        "passed": passed,
        "termination": termination,
        "cost_usd": cost,
        "input_tokens": 100,
        "output_tokens": 10,
        "wall_s": 10.0,
        "grade_details": {
            "items": 3,
            "correct": correct,
            "wrong": wrong,
            "confusions": confusions or {},
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
    assert first["fault_stats"]["nodes_created"] > 0
    assert second["fault_stats"]["nodes_created"] == 0 and second["fault_stats"]["relationships_created"] == 0

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


def test_faults_cover_wrong_decisions_mix_ups_and_how_an_attempt_ended(tmp_path):
    write_record(
        tmp_path / "runs",
        "r1",
        [attempt("x", False, 0.01, correct=1, wrong=2, confusions={"close->escalate": 2})],
        [attempt("x", False, 0.01, correct=3, termination="no_action")],
    )
    store = str(tmp_path / "s.rl")
    load(tmp_path / "runs", store)
    with relate.connect(store, read_only=True) as conn:
        made = {
            (r["model"], r["fault"]): (r["kind"], r["n"])
            for r in conn.execute(
                "MATCH (a:Attempt)-[x:MADE]->(f:Fault), (a)-[:BY]->(m:Model) "
                "RETURN m.name AS model, f.name AS fault, f.kind AS kind, x.count AS n"
            )
        }
        assert made == {
            ("p:alpha", "wrong decision"): ("decision", 2),
            ("p:alpha", "should close, did escalate"): ("mix-up", 2),
            ("q:beta", "stopped before finishing"): ("ending", 1),
        }
        # a mix-up belongs to its test and is a kind of wrong decision
        mix = conn.execute(
            "MATCH (f:Fault {kind: 'mix-up'})-[:KIND_OF]->(p:Fault) RETURN f.test_id AS test, p.name AS parent"
        ).single()
        assert (mix["test"], mix["parent"]) == ("t/x", "wrong decision")
        # the version can show faults nobody made (count 0), so a clean sheet can be told from "not measured"
        can = {r["f"] for r in conn.execute("MATCH (:TestVersion)-[:CAN_SHOW]->(f:Fault) RETURN f.name AS f")}
        assert {"left undone", "ran out of allowed actions", "ambiguous timeout (retried without checking)"} <= can
        # the fault of falling for a hazard points at that hazard
        falls = conn.execute("MATCH (f:Fault)-[:FALLS_FOR]->(h:Hazard) RETURN f.name AS f, h.name AS h").fetchall()
        timeout = "ambiguous timeout (retried without checking)"
        assert [(r["f"], r["h"]) for r in falls] == [(timeout, timeout)]
        profile = conn.execute(questions.FAULT_PROFILE, {"test_id": "t/x", "version_key": None}).fetchall()
        row = next(r for r in profile if r["model"] == "p:alpha" and r["fault"] == "wrong decision")
        assert (row["attempts"], row["attempts_with"], row["times"]) == (1, 1, 2)


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


def test_a_workflows_text_and_tools_do_not_depend_on_which_record_was_loaded_last(tmp_path):
    """One record shows only part of a workflow: the tools its two models happened to use and one wording of the
    brief. The graph must hold one account of it, made from every record, so importing another race cannot
    change what a workflow is said to be."""

    def played(wording, tools):
        res = attempt("x", True, 0.01)
        res["grade_details"]["wording"] = wording
        res["public_packet"] = {"brief": f"brief, wording {wording}", "policy": f"policy, wording {wording}"}
        res["turns"] = [{"tool_name": tool, "tool_args": {}, "observation": {"ok": True}} for tool in tools]
        return res

    def account(store):
        with relate.connect(store, read_only=True) as conn:
            (row,) = conn.execute(
                "MATCH (tv:TestVersion) RETURN tv.brief AS brief, tv.policy AS policy, tv.tools AS tools"
            )
            return dict(row)

    write_record(tmp_path / "runs", "r1", [played(1, ["list_x", "act_x"])], [played(1, ["list_x"])])
    write_record(tmp_path / "runs", "r2", [played(0, ["list_x", "check_x"])], [played(0, ["finish"])])
    two = str(tmp_path / "two.rl")
    load(tmp_path / "runs", two)
    want = {
        "brief": "brief, wording 0",
        "policy": "policy, wording 0",
        "tools": ["act_x", "check_x", "finish", "list_x"],
    }
    assert account(two) == want
    # a later race that used fewer tools and another wording changes nothing
    write_record(tmp_path / "runs", "r3", [played(2, ["list_x"])], [played(2, ["list_x"])])
    three = str(tmp_path / "three.rl")
    load(tmp_path / "runs", three)
    assert account(three) == want
    # and loading the new record into the store that was already built gives the same account
    load(tmp_path / "runs", two)
    assert account(two) == want
