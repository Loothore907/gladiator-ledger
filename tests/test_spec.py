"""Describe a flow, find the closest tested one, and export a spec from one task and two models."""

import hashlib
import json

from ledger import cli, load, reports, spec


def flow_run(folder, run_id, node, title, brief, policy, a, b, results, tools, budget=0.12):
    """One sealed record on test t/<node>; results is a list of (a_passed, b_passed, a_retries)."""

    def side(passed, cost, i, retries=0):
        return {
            "node": node,
            "name": title,
            "attempt": i,
            "challenge": {
                "id": f"t/{node}",
                "version": "1.0.0",
                "content_sha256": "cd" * 32,
                "tags": ["stateful-workflow"],
                "emulates": "tau-bench (style)",
            },
            "instance": {"seed": i, "difficulty": "standard"},
            "public_packet": {"brief": brief, "policy": policy, "action_budget": 40},
            # a record from the fixed engine: each call carries its cost of record and its token counts
            "turns": [
                {
                    "tool_name": t,
                    "cost_usd": cost / len(tools),
                    "list_cost_usd": cost / len(tools),
                    "usage": {"input_tokens": 20, "cached_input_tokens": 15, "output_tokens": 2},
                }
                for t in tools
            ],
            "passed": passed,
            "termination": "session_ended",
            "cost_usd": cost,
            "input_tokens": 100,
            "output_tokens": 10,
            "wall_s": 10.0,
            "grade_details": {
                "items": 3,
                "correct": 3 if passed else 1,
                "missing": 0,
                "error_severity": 0,
                "wording": 0,
                "blind_retries_after_unknown_outcome": retries,
                "duplicate_effects": 0,
            },
        }

    body = {
        "record_version": 2,
        "run_id": run_id,
        "engine_commit": "abc1234",
        "suite": {"name": "s", "success": {"profile": "balanced"}},
        "settings": {"defaults": {"effort": "low", "max_output_tokens": 4096, "attempt_budget_usd": budget}},
        "contestants": {
            "A": {"id": a, "results": [side(pa, 0.01, i, r) for i, (pa, _, r) in enumerate(results, 1)]},
            "B": {"id": b, "results": [side(pb, 0.03, i) for i, (_, pb, _) in enumerate(results, 1)]},
        },
    }
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    d = folder / run_id
    d.mkdir(parents=True)
    (d / "record.json").write_text(json.dumps({"sha256": hashlib.sha256(canonical).hexdigest(), "body": body}))


def build(tmp_path):
    runs = tmp_path / "runs"
    refund_tools = ["list_requests", "get_order", "issue_refund", "check_refund", "finish"]
    flow_run(
        runs,
        "r1",
        "refunds",
        "Refund queue",
        "You run the refund queue for a shop. Decide every refund request by the policy.",
        "Approve a refund only when the order was delivered.",
        "p:a",
        "p:b",
        [(True, False, 1)] * 2 + [(True, False, 0)] * 8,
        refund_tools,
    )
    flow_run(
        runs,
        "r2",
        "access",
        "Access review",
        "You run the access review. Revoke the accounts of people who left.",
        "Revoke an account when its owner has left the company.",
        "p:a",
        "p:b",
        [(True, True, 0)] * 3,
        ["list_accounts", "revoke_access", "finish"],
        budget=0.4,
    )
    store = str(tmp_path / "s.rl")
    load.load(runs, store)
    return store


def test_describing_a_flow_finds_the_closest_tested_one(tmp_path, capsys):
    store = build(tmp_path)
    found = cli.find_flows(store, "I need an agent to handle refunds for my shop")
    assert found["matched"] and found["flows"][0]["test"] == "t/refunds"
    assert found["flows"][0]["models"] == 2 and found["flows"][0]["pairs"] == 10
    assert cli.find_flows(store, "who still has access after they left")["flows"][0]["test"] == "t/access"

    nothing = cli.find_flows(store, "zebra unicorns")  # no made-up match: say so and list what exists
    assert not nothing["matched"] and [f["test"] for f in nothing["flows"]] == ["t/access", "t/refunds"]
    assert cli.search_words("How do I handle the refunds?") == "refunds refund"
    assert cli.main(["flows", "refund requests", "--store", store]) == 0
    assert "t/refunds" in capsys.readouterr().out


def test_spec_has_a_decision_a_blueprint_and_evidence_from_the_matches_it_rests_on(tmp_path):
    store = build(tmp_path)
    found = cli.verdict(store, "t/refunds", "p:a", "p:b")
    built = spec.build(lambda q, p: cli.rows(store, q, p), found)
    assert built["chosen"] == "p:a" and built["decision"]["verdict"] == "better"

    bp = built["blueprint"]
    assert bp["title"] == "Refund queue" and "refund queue" in bp["brief"]
    kinds = {t["name"]: t["kind"] for t in bp["tools"]}
    assert kinds["issue_refund"] == "changes something" and kinds["check_refund"] == "reads"
    assert kinds["finish"] == "ends the task"
    # settings come from this pair's matches only (0.12), not from the other workflow's run (0.4)
    assert bp["settings"]["attempt_budget_usd"] == [0.12] and bp["settings"]["effort"] == ["low"]

    by_hazard = {h["hazard"]: h for h in bp["hazards"]}
    retry = by_hazard["ambiguous timeout (retried without checking)"]
    assert (retry["tripped"], retry["exposed"], retry["seen"]) == (2, 10, "needs a guard")
    assert "check whether the action took effect" in retry["guardrail"]
    clean = by_hazard["duplicate effect"]
    # no trips is reported as a count, never as a clearance
    assert clean["seen"] == "not seen" and clean["guardrail"] is None and clean["unforgivable"]
    assert "autonomy" not in clean
    assert {h["model"] for h in bp["hazards"]} == {"p:a"}  # guardrails are for the chosen model

    assert [e["run"] for e in built["evidence"]] == ["r1"] and built["test_fingerprint"] == "cd" * 32
    text = spec.markdown(built)
    for part in (
        "## 1. Decision",
        "## 2. Blueprint",
        "## 3. Cost",
        "## 4. Evidence",
        "Use `p:a` for this task",
        "`r1`",
    ):
        assert part in text
    assert json.loads(text.split("```json\n")[1].split("\n```")[0])["chosen"] == "p:a"
    # what the spec may not say: a clearance from a count, a chance printed as "p = 0.0", a missing fact as "None",
    # or an answer key promised for every record
    said = text.split("## Machine-readable")[0]
    for never in ("can run alone", "sign test p", "`None`", "private answer key both published", "Passed ("):
        assert never not in said
    assert "Not seen is a count, not a clearance: none in 10 rules out a rate above about 26%" in said
    assert reports.ANSWER_KEYS in said and "Mistake points are" in said


def test_spec_names_no_model_when_the_match_does_not_settle_it(tmp_path, capsys):
    store = build(tmp_path)
    found = cli.verdict(store, "t/access", "p:a", "p:b")  # only 3 pairs
    built = spec.build(lambda q, p: cli.rows(store, q, p), found)
    assert built["chosen"] is None
    text = spec.markdown(built)
    assert "No winner yet" in text and "Model: none chosen" in text

    never = spec.markdown(spec.build(lambda q, p: cli.rows(store, q, p), cli.verdict(store, "t/access", "p:a", "p:z")))
    assert "No decision" in never and "## 2. Blueprint" not in never

    out = tmp_path / "spec.md"
    assert cli.main(["spec", "t/refunds", "--a", "p:a", "--b", "p:b", "--out", str(out), "--store", store]) == 0
    assert "## 2. Blueprint" in out.read_text()


def test_cost_and_evidence_reports_are_written_from_the_same_verdict_as_the_spec(tmp_path, capsys):
    store = build(tmp_path)
    found = cli.verdict(store, "t/refunds", "p:a", "p:b", profile="personal")
    for name in ("p:a", "p:b"):
        s = found["models"][name]
        assert s["spent"] > 0 and abs(s["cost_per_attempt"] * s["attempts"] - s["spent"]) < 1e-12
        assert s["cost_per_pass"] is None or abs(s["cost_per_pass"] * s["passed"] - s["spent"]) < 1e-12
        assert s["cost_basis"] and s["tokens_in"] >= s["tokens_cached"] >= 0

    cost = reports.cost_markdown(found, "Refund queue")
    a = found["models"]["p:a"]
    assert cost.startswith("# Cost breakdown: Refund queue")
    assert f"${a['cost_per_attempt']:.4f}" in cost and f"${a['cost_per_attempt'] * 1000:.2f}" in cost
    assert f"${a['spent']:.4f} over {a['attempts']} attempts: {a['right']} ended in the right result" in cost
    # an attempt is never "failed" for a skipped step: each row says how it ended, in the page's three words
    assert "(failed)" not in cost and "(passed)" not in cost and "Cost per right result" in cost
    assert a["cost_per_right"] is None or abs(a["cost_per_right"] * a["right"] - a["spent"]) < 1e-12
    # one row per judged pair, each naming its sealed record
    assert cost.count("| `r1` |") == found["pairs"]

    evidence = reports.evidence_markdown(found, "Refund queue")
    assert evidence.startswith("# Evidence report: Refund queue") and found["headline"] in evidence
    assert evidence.count("| `r1` |") == found["pairs"] and "## Sealed records" in evidence
    assert reports.ANSWER_KEYS in evidence and "sign test p" not in evidence
    assert {r["on"] for r in found["rounds"]} <= {"result", "process", "efficiency", "no result", "tie"}
    for name in ("p:a", "p:b"):
        for fault in found["fit"][name]["faults"]:
            assert f"| {fault['fault']} | {fault['level']} | {fault['attempts_with']} of" in evidence

    # the command prints one document or all three, and writes three files side by side
    args = ["spec", "t/refunds", "--a", "p:a", "--b", "p:b", "--store", store]
    assert cli.main([*args, "--report", "cost"]) == 0
    assert capsys.readouterr().out.strip() == cost.strip()
    out = tmp_path / "plan.md"
    assert cli.main([*args, "--report", "all", "--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8").startswith("# Spec:")
    assert (tmp_path / "plan.cost.md").read_text(encoding="utf-8") == cost
    assert (tmp_path / "plan.evidence.md").read_text(encoding="utf-8") == evidence


def test_report_wording_says_only_what_the_record_shows():
    # how often chance gives a split is said in words, never as "p = 0.0"
    assert reports.chance(0.0) == "less than 0.1%" and reports.chance(0.0312) == "about 3.1%"
    assert reports.chance(0.34) == "about 34%"
    # a record that names no engine build says so, and a live race is never said to have its answer key published
    live = {"run": "r9", "suite": "live-race", "seal_sha256": "ab" * 32, "engine_commit": None}
    said = "`r9`, live race, seal `abababababababab`, engine commit not recorded, no answer key published"
    assert reports.record_line(live) == said
    assert reports.record_line(dict(live, answer_key=True)).endswith(", answer key published")
    assert reports.record_kind("small-tier") == "suite match" and reports.record_kind("live-batch") == "live batch"
    # the sentence under a list promises nothing for all records: each line says it for its own
    assert (
        "Where a record's answer key" in reports.ANSWER_KEYS and "Every record's answer key" not in reports.ANSWER_KEYS
    )

    # what a scenario was decided on, for a reader: the engine's "success" is a wrong result or a skipped step
    def row(winner, a_right, a_clean, b_right, b_clean):
        return {"winner": winner, "a_right": a_right, "a_passed": a_clean, "b_right": b_right, "b_passed": b_clean}

    assert reports.decided_on(row("p:a", True, True, True, False), "p:a") == "process"
    assert reports.decided_on(row("p:a", True, True, False, False), "p:a") == "result"
    assert reports.decided_on(row("p:b", True, True, True, True), "p:a") == "efficiency"
    assert reports.decided_on(row("p:b", True, False, True, False), "p:a") == "efficiency"
    assert reports.decided_on(row("p:a", True, False, False, False), "p:a") == "result"
    assert reports.decided_on(row("p:a", False, False, True, False), "p:a") == "no result"
    assert reports.decided_on(row("tie", True, True, True, True), "p:a") == "tie"
    assert reports.decided_text({"efficiency": 2, "process": 5}).startswith("5 on process (")

    # no trips in N attempts is a count: what it rules out shrinks as N grows and is never nothing
    assert round(spec.ruled_out(72), 3) == 0.041 and round(spec.ruled_out(9), 2) == 0.28
    assert spec.ruled_out(1000) > 0
