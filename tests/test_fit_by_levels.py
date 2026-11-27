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
# What the record said at one moment (the moment the README's figures are read at). The record grows with every
# live race, so a claim about what it holds is made of the record as it stood then.
UNTIL = cli.parse_until("2026-11-26T05:00")


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
    row = {"attempts": 40, "passed": 26, "right": 26}
    got = policy.assess("t/x", row, [fault("left undone", 14, kind="decision")], "personal")  # minor for one person
    assert got["fit"] is False
    assert got["reasons"] == ["right result in 26 of 40 attempts (65%), under the 80% bar"]
    # on ten attempts the same shortfall is said, as what the count shows so far: too few to call it
    few = policy.assess("t/x", {"attempts": 10, "passed": 7, "right": 7}, [fault("left undone", 3)], "personal")
    assert few["fit"] is None and few["so_far"] == "short"
    assert few["reasons"] == ["right result in 7 of 10 attempts (70%), under the 80% bar"]
    # with no count of right results (an older row), the engine's passes stand in
    assert policy.assess("t/x", {"attempts": 10, "passed": 7}, [], "personal")["right"] == 7


def test_on_the_refund_queue_the_readers_level_for_one_fault_decides():
    ask = ("refund-queue", HAIKU, DEEPSEEK)
    v = cli.verdict(STORE, *ask, profile="personal", until=UNTIL)
    deepseek, haiku = v["fit"][DEEPSEEK], v["fit"][HAIKU]
    # at that moment: every refund decision right in every attempt, and most of them with a lookup skipped
    assert deepseek["right"] == deepseek["attempts"] and deepseek["passed"] < 0.5 * deepseek["attempts"]
    skipped = next(f for f in deepseek["faults"] if f["fault"] == SKIPPED)
    assert skipped["attempts_with"] == deepseek["attempts"] - deepseek["passed"] and skipped["level"] == "minor"
    assert deepseek["fit"] is True and haiku["fit"] is True
    assert v["outcome"] == "use" and v["use"] == HAIKU  # both fit, and head to head Haiku did it better
    # every scenario had both results right, most of Haiku's wins were on process, and the verdict says so
    assert any(n.startswith("Both got the right result in all") for n in v["notes"])
    won = next(n for n in v["notes"] if n.startswith(f"{HAIKU} won "))
    assert "on process (both got the right result, only it ran clean)" in won
    assert v["decided_on"]["process"] > v["decided_on"]["efficiency"] and "result" not in v["decided_on"]
    assert sum(v["decided_on"].values()) == v["pairs"]
    # read through a tolerance there is one bar, the tolerance's own, and no second "good enough" note beside it
    assert v["bar"] == v["fit"][HAIKU]["bar"] and not any("bar of" in n or "good enough" in n for n in v["notes"])
    # a reader who will not accept a skipped lookup gets the opposite answer, for both
    strict = cli.verdict(STORE, *ask, profile="personal", overrides={SKIPPED: "unforgivable"}, until=UNTIL)
    assert strict["fit"][DEEPSEEK]["fit"] is False and strict["fit"][HAIKU]["fit"] is False
    assert strict["outcome"] == "neither fit"
    # and for a business it is serious by default: allowed in 2% of attempts, found in far more
    business = cli.verdict(STORE, *ask, profile="enterprise", until=UNTIL)
    assert business["fit"][DEEPSEEK]["fit"] is False
    assert any(r.startswith(f"{SKIPPED} (serious)") for r in business["fit"][DEEPSEEK]["reasons"])


def test_right_results_are_counted_from_the_attempts_themselves():
    for task in ("refund-queue", "access-review", "incident-triage", "inventory-transfer"):
        v = cli.verdict(STORE, task, HAIKU, DEEPSEEK, profile="personal")
        for model in (HAIKU, DEEPSEEK):
            f = v["fit"][model]
            # every attempt it made at the task under those conditions: against an opponent, and against itself
            counted = (
                "MATCH (:TestVersion {{key: $version}})<-[:USED]-(mt:{world})<-[:IN]-(x:{attempt})-[:BY]->(:Model {{name: $m}}) "
                "WHERE NOT mt.excluded AND mt.conditions = $conditions "
                "RETURN count(x) AS attempts, sum(CASE WHEN x.task_correct THEN 1 ELSE 0 END) AS right, "
                "sum(CASE WHEN x.passed THEN 1 ELSE 0 END) AS passed"
            )
            asked = {"version": v["version"], "m": model, "conditions": v["conditions"]}
            row = {"attempts": 0, "right": 0, "passed": 0}
            for world, attempt in (("Match", "Attempt"), ("SelfCheck", "SelfAttempt")):
                (part,) = cli.rows(STORE, counted.format(world=world, attempt=attempt), asked)
                for key in row:
                    row[key] += part[key] or 0
            assert (f["attempts"], f["right"], f["passed"]) == (row["attempts"], row["right"], row["passed"]), task
            assert f["right"] >= f["passed"]  # a pass is a right result that also followed the process
            # the head to head keeps the same two counts for the pairs these two played
            side = v["models"][model]
            assert side["right"] >= side["passed"] and side["good_enough"] == (side["right_rate"] >= v["bar"])


def test_no_verdict_on_file_names_a_model_whose_fit_is_not_settled():
    """A fit call waits for the count to settle it (owner, 2026-11-27): held on every pair that met on the refund
    queue, at both tolerances, as the record stands. The record holds models with nine attempts, so the rule is
    exercised; were it ever not, the test says so instead of passing on nothing."""
    met = cli.rows(
        STORE,
        """
        MATCH (:Test {id: 'gladiator/refund-queue'})<-[:VERSION_OF]-(:TestVersion)<-[:USED]-(mt:Match),
              (mt)<-[:IN]-(:Attempt)-[:BY]->(a:Model), (mt)<-[:IN]-(:Attempt)-[:BY]->(b:Model)
        WHERE a.name < b.name AND NOT mt.excluded
        RETURN DISTINCT a.name AS a, b.name AS b ORDER BY a, b
        """,
    )
    assert len(met) > 10
    waiting = named = 0
    for pair in met:
        for profile in policy.PROFILES:
            v = cli.verdict(STORE, "refund-queue", pair["a"], pair["b"], profile=profile)
            fits = [v["fit"][m] for m in (pair["a"], pair["b"])]
            for f in fits:
                # the three answers, and nothing between them
                assert (f["fit"] is None) == (policy.standing(f) not in ("fit", "not fit"))
                assert f["so_far"] in (None, "meets", "short") and (f["so_far"] is None or f["fit"] is None)
                if f["fit"] is True:
                    assert policy.clears(f["right"], f["attempts"], f["bar"]) and not f["reasons"]
                if f["so_far"] == "meets":
                    assert not f["reasons"] and not policy.clears(f["right"], f["attempts"], f["bar"])
            if any(f["fit"] is None for f in fits):
                waiting += 1
                assert v["outcome"] in ("not settled", "one settled")
            else:
                assert v["outcome"] in ("use", "both fit", "only one fit", "neither fit")
            if v["use"]:
                named += 1
                assert v["fit"][v["use"]]["fit"] is True  # never a model that only meets the bar so far
            assert all(o["model"] and v["fit"].get(o["model"], {"fit": True})["fit"] for o in v["fit_on_task"])
    assert waiting and named, "the record no longer exercises the rule: no verdict waits, or none names a model"
