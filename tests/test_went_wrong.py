"""A count of failed attempts says that something went wrong; the reports must also say what, and how often.

The owner ran a live batch (2026-11-27) in which each model failed two scenarios of ten. The guardrail table under
it listed the hazards the test plants, every one "not seen", and nothing said what the four failures were: one model
had stopped without acting, the other had made a wrong decision. These tests hold the three places that now say it:
the question over the graph, the scenario-by-scenario lines of a verdict and its evidence report, and the guardrail
section of a spec, which lists every fault a model made beside the hazards."""

from pathlib import Path

import pytest

from ledger import cli, questions, reports, spec

DATA = Path(__file__).resolve().parent.parent / "data"
STORE = str(DATA / "ledger.rl")
HAIKU, DEEPSEEK = "anthropic:claude-haiku-5-5", "openrouter:deepseek/deepseek-v4.1-flash-1017"
UNTIL = cli.parse_until("2026-11-26T05:00")  # the README's moment: later races never move these counts
shipped = pytest.mark.skipif(not Path(STORE).exists(), reason="no shipped store in this checkout")


def ask(query, params):
    """How the command line hands the store to the spec builder."""
    return cli.rows(STORE, query, params)


def test_one_attempt_in_words():
    said = reports.fault_words
    wrong = {"fault": "wrong decision", "kind": "decision", "count": 1}
    mixup = {"fault": "should ship, did backorder", "kind": "mix-up", "count": 1}
    # a wrong decision says on how many items, and which mix-up it was
    assert said(18, [wrong, mixup]) == "wrong decision: 1 of 18 items (should ship, did backorder)"
    twice = [{**wrong, "count": 2}, {**mixup, "count": 2}]
    assert said(18, twice) == "wrong decision: 2 of 18 items (should ship, did backorder, 2 times)"
    # how it stopped comes first, then what it left; a hazard it fell for comes last, with how often
    stopped = [
        {"fault": "left undone", "kind": "decision", "count": 18},
        {"fault": "stopped before finishing", "kind": "ending", "count": 1},
        {"fault": "acted without reading", "kind": "trap", "count": 3},
    ]
    assert said(18, stopped) == "stopped before finishing; left undone: 18 of 18 items; acted without reading (3 times)"
    assert said(None, [wrong]) == "wrong decision: 1"
    assert said(18, []) == "no fault recorded"


def test_rows_are_gathered_attempt_by_attempt_in_the_verdicts_order():
    row = {"side": "A", "model": "p:a", "right": False, "ended": "session_ended", "items": 4}
    found = [
        {**row, "match": "r/t/7", "fault": "wrong decision", "kind": "decision", "count": 1},
        {**row, "match": "r/t/7", "fault": "should close, did route", "kind": "mix-up", "count": 1},
        {
            **row,
            "match": "r/t/2",
            "side": "B",
            "model": "p:b",
            "right": True,
            "fault": None,
            "kind": None,
            "count": None,
        },
    ]
    went = reports.what_went_wrong(found, ["r/t/7", "r/t/2"])
    assert [(w["scenario"], w["model"], w["right"]) for w in went] == [(1, "p:a", False), (2, "p:b", True)]
    assert went[0]["what"] == "wrong decision: 1 of 4 items (should close, did route)"
    assert went[1]["what"] == "no fault recorded" and went[1]["faults"] == []
    # without a verdict's order (one sealed record, a live batch) the scenario is the record's own number
    assert [w["scenario"] for w in reports.what_went_wrong(found)] == [2, 7]
    lines = reports.went_wrong_lines(went)
    assert "- Scenario 1, `p:a`: wrong decision: 1 of 4 items (should close, did route)." in lines
    assert "The right result with a step skipped: 1 attempt." in lines


@shipped
@pytest.mark.parametrize("task", ["refund-queue", "access-review", "incident-triage", "inventory-transfer"])
def test_every_attempt_that_was_not_a_clean_run_is_explained(task):
    """In a verdict, each scenario says how each attempt ended. Every one that was not a clean run must have its
    line under them, saying what went wrong, and the two must agree on whether the result was right."""
    v = cli.verdict(STORE, task, HAIKU, DEEPSEEK, profile="personal", until=UNTIL)
    side = {"A": "a", "B": "b"}
    model_of = {"a": HAIKU, "b": DEEPSEEK}
    expected = {}
    for number, r in enumerate(v["rounds"], 1):
        for s in ("a", "b"):
            if not r[f"{s}_passed"]:
                expected[(number, model_of[s])] = r[f"{s}_right"]
    said = {(w["scenario"], w["model"]): w["right"] for w in v["went_wrong"]}
    assert said == expected
    assert all(w["what"] and w["side"] in side for w in v["went_wrong"])
    # a wrong result always names a fault: "something went wrong" with nothing behind it is what this replaces
    assert all(w["faults"] for w in v["went_wrong"] if not w["right"])
    text = reports.evidence_markdown(v, task)
    for w in v["went_wrong"]:
        if not w["right"]:
            assert f"- Scenario {w['scenario']}, `{w['model']}`: {w['what']}." in text
    if any(w["right"] for w in v["went_wrong"]):
        assert "The right result with a step skipped: " in text


@shipped
def test_the_guardrail_section_lists_what_went_wrong_beside_the_planted_hazards():
    """Inventory transfer, the two demo models: no planted hazard was tripped, and both models had attempts without
    the right result. A guardrail section of zeros would say nothing was wrong."""
    v = cli.verdict(STORE, "inventory-transfer", HAIKU, DEEPSEEK, profile="enterprise", until=UNTIL)
    s = spec.build(ask, v)
    bp = s["blueprint"]
    assert all(g["tripped"] == 0 for g in bp["hazards"]), "the case this test is about: every hazard reads zero"
    assert set(bp["fault_attempts"]) == {HAIKU, DEEPSEEK}  # no model is named to use: both are listed
    for model in (HAIKU, DEEPSEEK):
        fit = v["fit"][model]
        assert fit["right"] < fit["attempts"], "the case this test is about: the model had wrong results"
        listed = {f["fault"]: f for f in bp["faults"] if f["model"] == model}
        made = {x["fault"]: x for x in fit["faults"] if x["kind"] in spec.FAULT_KINDS and x["attempts_with"]}
        assert set(listed) == set(made) and listed, "every fault of a decision or an ending it made is a row"
        for name, row in listed.items():
            assert (row["attempts_with"], row["attempts"], row["level"]) == (
                made[name]["attempts_with"],
                fit["attempts"],
                made[name]["level"],
            )
            assert row["guardrail"], f"{name} has no guard to build"
    haiku_wrong = next(f for f in bp["faults"] if f["model"] == HAIKU and f["fault"] == "wrong decision")
    assert [k["fault"] for k in haiku_wrong["kinds"]] == ["should ship, did backorder"]
    text = spec.markdown(s)
    section = text[text.index("### Guardrails") : text.index("## 3. Cost")]
    assert section.index("| Model | What went wrong |") < section.index(
        "| Model | Hazard |"
    )  # what happened comes first
    assert f"| `{HAIKU}` | wrong decision (should ship, did backorder in " in section
    assert f"| `{DEEPSEEK}` | stopped before finishing | " in section
    # read without a tolerance there is no fitness and no level: the section is the hazards alone, as before
    plain = spec.markdown(spec.build(ask, cli.verdict(STORE, "inventory-transfer", HAIKU, DEEPSEEK, until=UNTIL)))
    assert "What went wrong when" not in plain and "| Model | Hazard |" in plain


@shipped
def test_a_model_with_nothing_wrong_says_so_with_its_count():
    v = cli.verdict(STORE, "refund-queue", HAIKU, DEEPSEEK, profile="personal", until=UNTIL)
    s = spec.build(ask, v)
    assert s["chosen"] == HAIKU and list(s["blueprint"]["fault_attempts"]) == [HAIKU]
    rows = [f for f in s["blueprint"]["faults"]]
    assert (
        [f["fault"] for f in rows] == ["wrong decision"] and rows[0]["attempts_with"] == 1 and rows[0]["attempts"] == 81
    )
    assert "| wrong decision | 1 of 81 (1%) | serious |" in spec.markdown(s).replace(f"`{HAIKU}` | ", "", 1)


@shipped
def test_the_question_can_be_asked_of_one_sealed_record(capsys):
    """`ledger ask what_went_wrong --param run=<id>`: the attempts of one record that were not clean runs."""
    found = cli.rows(STORE, questions.WENT_WRONG, {"run": "20261122-210842-14f765", "matches": None})
    went = reports.what_went_wrong(found)
    stopped = [w for w in went if "stopped before finishing" in w["what"]]
    assert stopped and all(not w["right"] for w in stopped)
    assert cli.main(["ask", "what_went_wrong", "--param", "run=20261122-210842-14f765", "--store", STORE]) == 0
    assert "stopped before finishing" in capsys.readouterr().out
    # a model run against itself has its own attempts: the same question, asked of them
    own = cli.rows(STORE, questions.WENT_WRONG_SELF, {"run": None})
    assert all(set(r) == set(found[0]) for r in own)
