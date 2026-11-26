"""A verdict is read under one set of conditions (the same settings, difficulty and scoring), and a model's fitness
for a task counts every attempt it made under them, whoever the opponent was.

Two things this guards. A live race can be started at an easier level or with another scoring profile: it is on
file and said so, and it never moves the verdict of the record it was not played to test. And fitness is about the
model and the task, so the same model on the same task reads the same in every verdict under those conditions."""

import copy
import json
import shutil
from pathlib import Path

import pytest

from ledger import cli, load
from ledger.bridges.gladiator import canonical_sha256

DATA = Path(__file__).resolve().parent.parent / "data"
SHIPPED = str(DATA / "ledger.rl")
RACE = "20261124-062051-979e58"  # a live race: GPT-6 Luna against Claude Haiku 5.5 on access-review, standard level
HAIKU = "anthropic:claude-haiku-5-5"
LUNA = "openai:gpt-6-luna"
DEEPSEEK = "openrouter:deepseek/deepseek-v4.1-flash-1017"
MINIMAX = "openrouter:minimax/minimax-m3.1-flash"
NEWCOMER = "example:met-live-at-both-levels"  # has met Haiku only in live races: one standard, two easy
BEGINNER = "example:met-live-at-easy-only"  # has met Haiku only in live races, all easy

STANDARD = (
    "attempt_budget_usd=0.12; difficulty=standard; effort=low; max_output_tokens=4096; profile=budget; timeout_s=180"
)
EASY = STANDARD.replace("difficulty=standard", "difficulty=easy")
LATENCY = STANDARD.replace("profile=budget", "profile=latency")


def variant(
    body: dict, run_id: str, difficulty: str | None = None, profile: str | None = None, other: str | None = None
):
    """The live race again as its own record: at another level, under another scoring profile, or with Haiku's
    opponent replaced by a model that has never played a suite match."""
    body = copy.deepcopy(body)
    body["run_id"] = run_id
    if difficulty:
        body["settings"]["defaults"]["difficulty"] = difficulty
        for side in body["contestants"].values():
            for result in side["results"]:
                result["instance"]["difficulty"] = difficulty
    if profile:
        body["suite"]["success"]["profile"] = profile
    if other:
        body["contestants"]["A"]["id"] = other
    return body


@pytest.fixture(scope="module")
def store(tmp_path_factory):
    """The shipped records plus seven made-up live races, all copies of one real one."""
    source = DATA / "records" / RACE / "record.json"
    if not source.exists():
        pytest.skip("the live race these tests are built from is not in this checkout")
    root = tmp_path_factory.mktemp("conditions")
    shutil.copytree(DATA / "records", root / "records")
    race = json.loads(source.read_text(encoding="utf-8"))["body"]
    assert {race["contestants"]["A"]["id"], race["contestants"]["B"]["id"]} == {LUNA, HAIKU}
    extra = [
        variant(race, "20261126-000000-ea5e01", difficulty="easy"),
        variant(race, "20261126-000000-1a7e01", profile="latency"),
        variant(race, "20261126-000000-0e5701", other=NEWCOMER),
        variant(race, "20261126-000000-0e5702", other=NEWCOMER, difficulty="easy"),
        variant(race, "20261126-000000-0e5703", other=NEWCOMER, difficulty="easy"),
        variant(race, "20261126-000000-be6101", other=BEGINNER, difficulty="easy"),
        variant(race, "20261126-000000-be6102", other=BEGINNER, difficulty="easy"),
    ]
    for body in extra:
        folder = root / "records" / body["run_id"]
        folder.mkdir()
        sealed = {"sha256": canonical_sha256(body), "body": body}
        (folder / "record.json").write_text(json.dumps(sealed), encoding="utf-8")
    path = str(root / "with-races.rl")
    summary = load.load(root / "records", path)
    assert summary["skipped_bad_seal"] == []
    return path


def attempts_under(store: str, model: str, version: str, conditions: str) -> tuple[int, int]:
    """Counted straight from the graph: a model's attempts, and passes, on a version under one set of conditions.
    Its attempts against itself (a self run) are attempts at the task like any other, as they are in fitness."""
    counted = (
        "MATCH (:TestVersion {{key: $version}})<-[:USED]-(mt:{world})<-[:IN]-(x:{attempt})-[:BY]->(:Model {{name: $model}}) "
        "WHERE NOT mt.excluded AND mt.conditions = $conditions "
        "RETURN count(x) AS attempts, sum(CASE WHEN x.passed THEN 1 ELSE 0 END) AS passed"
    )
    asked = {"version": version, "model": model, "conditions": conditions}
    (played,) = cli.rows(store, counted.format(world="Match", attempt="Attempt"), asked)
    (alone,) = cli.rows(store, counted.format(world="SelfCheck", attempt="SelfAttempt"), asked)
    return played["attempts"] + alone["attempts"], (played["passed"] or 0) + (alone["passed"] or 0)


def test_every_pair_carries_the_conditions_it_was_played_under(store):
    found = cli.rows(store, "MATCH (mt:Match) RETURN mt.conditions AS conditions, count(mt) AS pairs")
    by = {r["conditions"]: r["pairs"] for r in found}
    assert None not in by
    assert by[EASY] == 5 and by[LATENCY] == 1
    # the shipped suites: small-tier and the live races share one set, mid-tier has its own budget per attempt
    assert by[STANDARD.replace("attempt_budget_usd=0.12", "attempt_budget_usd=0.4")] > 0


def test_a_race_under_other_conditions_never_moves_the_verdict(store):
    before = cli.verdict(SHIPPED, "access-review", HAIKU, LUNA, profile="personal")
    after = cli.verdict(store, "access-review", HAIKU, LUNA, profile="personal")
    assert before["conditions"] == after["conditions"] == STANDARD
    assert before["not_counted"] == []
    # the head to head and the hazards are the ones of the record: same pairs, same wins, same rounds
    for key in ("pairs", "wins", "ties", "p_value", "rounds", "verdict", "better", "hazards", "evidence"):
        assert after[key] == before[key], key
    # Luna's fitness is untouched; Haiku made one more attempt under these conditions, against the newcomer
    assert after["fit"][LUNA] == before["fit"][LUNA]
    assert after["fit"][HAIKU]["attempts"] == before["fit"][HAIKU]["attempts"] + 1
    # and the two races played under other conditions are on file and said so
    assert after["not_counted"] == [
        {"conditions": EASY, "pairs": 1, "what": "easy difficulty"},
        {"conditions": LATENCY, "pairs": 1, "what": "latency scoring"},
    ]
    note = (
        "Not counted here: 2 judged pairs these two played under other conditions "
        "(easy difficulty: 1; latency scoring: 1). A result holds for the conditions it was played under."
    )
    assert note in after["notes"] and not any("Not counted" in n for n in before["notes"])


def test_two_models_that_only_met_live_are_read_under_the_tasks_own_conditions(store):
    v = cli.verdict(store, "access-review", HAIKU, NEWCOMER, profile="personal")
    # two easy races to one standard one, and still the standard level decides: it is what the task's record holds
    assert v["conditions"] == STANDARD and v["pairs"] == 1
    assert v["not_counted"] == [{"conditions": EASY, "pairs": 2, "what": "easy difficulty"}]
    assert v["verdict"] == "not enough evidence"


def test_with_nothing_else_on_file_a_verdict_says_which_conditions_it_holds_for(store):
    v = cli.verdict(store, "access-review", HAIKU, BEGINNER, profile="personal")
    assert v["conditions"] == EASY and v["pairs"] == 2 and v["not_counted"] == []
    # fitness is counted under those conditions too: every easy attempt, and nothing from the standard level
    for model in (HAIKU, BEGINNER):
        attempts, passed = attempts_under(store, model, v["version"], EASY)
        assert (v["fit"][model]["attempts"], v["fit"][model]["passed"]) == (attempts, passed), model
    assert v["fit"][HAIKU]["attempts"] == 5


@pytest.mark.parametrize("task", ["refund-queue", "access-review", "incident-triage", "inventory-transfer"])
def test_a_models_fitness_is_the_same_whoever_it_is_compared_with(task):
    """On the shipped record: Haiku has met some opponents in live races and others only in suite matches. Its
    fitness for the task must not depend on which of them it is being compared with."""
    seen = {}
    for other in (MINIMAX, DEEPSEEK, LUNA):
        v = cli.verdict(SHIPPED, task, HAIKU, other, profile="personal")
        assert v["conditions"] == STANDARD
        seen[other] = (v["fit"][HAIKU]["attempts"], v["fit"][HAIKU]["passed"])
        # and it is every attempt under those conditions, live races included
        assert seen[other] == attempts_under(SHIPPED, HAIKU, v["version"], STANDARD), other
    assert len(set(seen.values())) == 1, seen


def test_one_suite_is_a_fixed_set_that_live_races_never_join(store):
    for other in (LUNA, DEEPSEEK):
        shipped = cli.verdict(SHIPPED, "access-review", HAIKU, other, suite="small-tier", profile="personal")
        grown = cli.verdict(store, "access-review", HAIKU, other, suite="small-tier", profile="personal")
        for key in ("pairs", "wins", "rounds", "fit", "headline", "conditions", "not_counted", "notes"):
            assert grown[key] == shipped[key], key
        assert {e["suite"] for e in grown["evidence"]} == {"small-tier"}


def test_which_conditions_a_verdict_is_read_under():
    def met(conditions, pairs, suite_pairs):
        return {"conditions": conditions, "pairs": pairs, "suite_pairs": suite_pairs}

    record = {STANDARD: 200}
    # the suite matches between the two decide, however many live races were run at another level
    assert cli.reference_conditions([met(STANDARD, 16, 16), met(EASY, 25, 0)], record) == STANDARD
    # never met in a suite: the conditions the task's own suite record was played under
    assert cli.reference_conditions([met(STANDARD, 2, 0), met(EASY, 25, 0)], record) == STANDARD
    # no pair under those either: where they met most, and a full tie goes to the first in order
    assert cli.reference_conditions([met(LATENCY, 3, 0), met(EASY, 4, 0)], record) == EASY
    assert cli.reference_conditions([met(LATENCY, 3, 0), met(EASY, 3, 0)], record) == EASY
    assert cli.reference_conditions([met(EASY, 1, 0)], {}) == EASY


def test_how_other_conditions_are_described():
    assert cli.conditions_apart(STANDARD, EASY) == "easy difficulty"
    assert cli.conditions_apart(STANDARD, LATENCY) == "latency scoring"
    both = EASY.replace("profile=budget", "profile=latency")
    assert cli.conditions_apart(STANDARD, both) == "easy difficulty, latency scoring"
    dearer = STANDARD.replace("attempt_budget_usd=0.12", "attempt_budget_usd=0.4")
    assert cli.conditions_apart(STANDARD, dearer) == "a $0.4 limit per attempt"
    assert cli.conditions_apart(STANDARD, STANDARD + "; new_setting=7") == "new_setting 7"
    assert cli.conditions_apart(STANDARD + "; new_setting=7", STANDARD) == "no new_setting set"
