"""Describe a flow, find the closest tested one, and export a spec from one task and two models."""

import hashlib
import json

from ledger import cli, load, spec


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
            "turns": [{"tool_name": t} for t in tools],
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
    assert (retry["tripped"], retry["exposed"], retry["autonomy"]) == (2, 10, "needs a guard")
    assert "check whether the action took effect" in retry["guardrail"]
    clean = by_hazard["duplicate effect"]
    assert clean["autonomy"] == "can run alone" and clean["guardrail"] is None and clean["unforgivable"]
    assert {h["model"] for h in bp["hazards"]} == {"p:a"}  # guardrails are for the chosen model

    assert [e["run"] for e in built["evidence"]] == ["r1"] and built["test_fingerprint"] == "cd" * 32
    text = spec.markdown(built)
    for part in ("## 1. Decision", "## 2. Blueprint", "## 3. Evidence", "Use `p:a` for this task", "`r1`"):
        assert part in text
    assert json.loads(text.split("```json\n")[1].split("\n```")[0])["chosen"] == "p:a"


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
