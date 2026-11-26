"""Fitness is decided by the fault levels (owner, 2026-11-26).

The bar asks for the right result: every decision right and nothing left undone. How a model got there is judged by
the faults, each at the level the reader gives it. So an attempt that got everything right but decided before
looking a record up no longer fails the bar by itself: it has the right result and one fault, and whether that
fault matters is the reader's call.

The refund queue is the case that showed it. In the shipped record DeepSeek gets every refund decision right in
every attempt, and in two attempts of three it skips a lookup the brief asks for."""

from pathlib import Path

from ledger import cli, policy

STORE = str(Path(__file__).resolve().parent.parent / "data" / "ledger.rl")
HAIKU = "anthropic:claude-haiku-5-5"
DEEPSEEK = "openrouter:deepseek/deepseek-v4.1-flash-1017"
SKIPPED = "acted without reading"


def fault(name, attempts_with, kind="trap"):
    return {"fault": name, "kind": kind, "kind_of": None, "attempts_with": attempts_with, "times": attempts_with}


def test_the_bar_asks_for_the_right_result_and_the_levels_judge_the_process():
    # 30 of 95 attempts passed the engine's own check; all 95 got the result right, and 65 skipped a lookup
    row = {"attempts": 95, "passed": 30, "right": 95}
    one_person = policy.assess("gladiator/refund-queue", row, [fault(SKIPPED, 65)], "personal")
    assert one_person["fit"] is True and one_person["reasons"] == []  # minor for one person: it never decides
    assert (one_person["right"], one_person["right_rate"], one_person["passed"]) == (95, 1.0, 30)
    assert policy.result_line(one_person) == (
        "Right result in 95 of 95 attempts (100%; bar 80%); 30 of them also followed the process the test asks for."
    )
    business = policy.assess("gladiator/refund-queue", row, [fault(SKIPPED, 65)], "enterprise")
    assert business["fit"] is False  # serious for a business, and far over the 2% allowed
    assert business["reasons"] == [f"{SKIPPED} (serious) in 65 of 95 attempts, over the 2% allowed"]
    strict = policy.assess("gladiator/refund-queue", row, [fault(SKIPPED, 65)], "personal", {SKIPPED: "unforgivable"})
    assert strict["fit"] is False and strict["reasons"] == [f"{SKIPPED} (unforgivable) in 65 of 95 attempts"]


def test_a_wrong_result_still_costs_the_bar_whatever_the_levels_say():
    row = {"attempts": 10, "passed": 7, "right": 7}
    got = policy.assess("t/x", row, [fault("left undone", 3, kind="decision")], "personal")  # minor for one person
    assert got["fit"] is False
    assert got["reasons"] == ["right result in 7 of 10 attempts (70%), under the 80% bar"]
    # with no count of right results (an older row), the engine's passes stand in
    assert policy.assess("t/x", {"attempts": 10, "passed": 7}, [], "personal")["right"] == 7


def test_on_the_refund_queue_the_readers_level_for_one_fault_decides():
    ask = ("refund-queue", HAIKU, DEEPSEEK)
    v = cli.verdict(STORE, *ask, profile="personal")
    deepseek, haiku = v["fit"][DEEPSEEK], v["fit"][HAIKU]
    # every refund decision right in every attempt, and most of them with a lookup skipped
    assert deepseek["right"] == deepseek["attempts"] and deepseek["passed"] < 0.5 * deepseek["attempts"]
    skipped = next(f for f in deepseek["faults"] if f["fault"] == SKIPPED)
    assert skipped["attempts_with"] == deepseek["attempts"] - deepseek["passed"] and skipped["level"] == "minor"
    assert deepseek["fit"] is True and haiku["fit"] is True
    assert v["outcome"] == "use" and v["use"] == HAIKU  # both fit, and head to head Haiku did it better
    # most of those wins were on process, and the verdict says so
    won_on_process = [n for n in v["notes"] if "it won them on process" in n and n.startswith("In ")]
    assert len(won_on_process) == 1 and HAIKU in won_on_process[0]
    # a reader who will not accept a skipped lookup gets the opposite answer, for both
    strict = cli.verdict(STORE, *ask, profile="personal", overrides={SKIPPED: "unforgivable"})
    assert strict["fit"][DEEPSEEK]["fit"] is False and strict["fit"][HAIKU]["fit"] is False
    assert strict["outcome"] == "neither fit"
    # and for a business it is serious by default: allowed in 2% of attempts, found in far more
    business = cli.verdict(STORE, *ask, profile="enterprise")
    assert business["fit"][DEEPSEEK]["fit"] is False
    assert any(r.startswith(f"{SKIPPED} (serious)") for r in business["fit"][DEEPSEEK]["reasons"])


def test_right_results_are_counted_from_the_attempts_themselves():
    for task in ("refund-queue", "access-review", "incident-triage", "inventory-transfer"):
        v = cli.verdict(STORE, task, HAIKU, DEEPSEEK, profile="personal")
        for model in (HAIKU, DEEPSEEK):
            f = v["fit"][model]
            (row,) = cli.rows(
                STORE,
                "MATCH (:TestVersion {key: $version})<-[:USED]-(mt:Match)<-[:IN]-(x:Attempt)-[:BY]->(:Model {name: $m}) "
                "WHERE NOT mt.excluded AND mt.conditions = $conditions "
                "RETURN count(x) AS attempts, sum(CASE WHEN x.task_correct THEN 1 ELSE 0 END) AS right, "
                "sum(CASE WHEN x.passed THEN 1 ELSE 0 END) AS passed",
                {"version": v["version"], "m": model, "conditions": v["conditions"]},
            )
            assert (f["attempts"], f["right"], f["passed"]) == (row["attempts"], row["right"], row["passed"]), task
            assert f["right"] >= f["passed"]  # a pass is a right result that also followed the process
            # the head to head keeps the same two counts for the pairs these two played
            side = v["models"][model]
            assert side["right"] >= side["passed"] and side["good_enough"] == (side["right_rate"] >= v["bar"])
