from ledger import replay


def turn(tool, args, call_s=1.0, error=None, cost=0.001):
    seen = {"error": error} if error else {"ok": True}
    return {
        "tool_name": tool,
        "tool_args": args,
        "call_s": call_s,
        "cost_usd": cost,
        "observation": seen,
        "usage": {"input_tokens": 100, "output_tokens": 10},
    }


def test_a_timeline_places_each_step_when_it_happened_and_marks_only_what_the_record_shows():
    res = {
        "passed": False,
        "wall_s": 6.0,
        "cost_usd": 0.006,
        "termination": "no_action",
        "grade_details": {
            "items": 2,
            "correct": 1,
            "wrong": 1,
            "missing": 0,
            "duplicate_effects": 0,
            "mistakes": {"ALR-2": "close->escalate"},
        },
        "turns": [
            turn("list_alerts", {"page": 1}),
            turn("get_service", {"id": "SVC-1"}),
            turn("close_alert", {"alert_id": "ALR-1", "reason": "x"}, error="timeout"),
            turn("check_page", {"alert_id": "ALR-1"}),
            turn("close_alert", {"alert_id": "ALR-1", "reason": "x"}),
            turn("escalate_alert", {"alert_id": "ALR-2"}),
            turn(None, None),
        ],
    }
    tools: list = []
    line = replay.attempt_timeline(res, tools)
    steps = [(s[0], tools[s[1]], s[2], s[3], s[4], s[5]) for s in line["steps"]]
    assert steps == [
        (1.0, "list_alerts", "page 1", "read", replay.OK, None),
        (2.0, "get_service", "SVC-1", "read", replay.OK, None),
        (3.0, "close_alert", "ALR-1", "act", replay.TIMEOUT, None),  # the world did not answer
        (4.0, "check_page", "ALR-1", "check", replay.OK, None),
        (5.0, "close_alert", "ALR-1", "act", replay.OK, "repeat"),  # acted on the same item again
        (6.0, "escalate_alert", "ALR-2", "act", replay.OK, "wrong"),  # the grader names this item
        (7.0, None, None, "talk", replay.OK, None),  # answered without calling a tool
    ]
    # the grade is the grader's own, and how the attempt ended is a fault like any other
    assert (line["passed"], line["items"], line["correct"]) == (False, 2, 1)
    assert line["faults"] == {"wrong decision": 1, "stopped before finishing": 1}
    assert line["steps"][0][6:] == [0.001, 110]


def test_every_shipped_scenario_has_a_replay_for_both_models(tmp_path):
    from pathlib import Path

    from ledger import cli

    sizes = replay.export(Path("data/records"), tmp_path)
    assert len(sizes) == cli.rows("data/ledger.rl", "MATCH (r:Run) RETURN count(r) AS n")[0]["n"]
    import json

    keys = {}
    for name in sizes:
        for key, sides in json.loads((tmp_path / name).read_text(encoding="utf-8"))["matches"].items():
            keys[key] = set(sides)
    for row in cli.rows(
        "data/ledger.rl",
        "MATCH (mt:Match)<-[:IN]-(:Attempt)-[:BY]->(m:Model) WHERE NOT mt.excluded "
        "RETURN mt.key AS key, collect(m.name) AS models",
    ):
        assert keys.get(row["key"]) == set(row["models"]), row["key"]
