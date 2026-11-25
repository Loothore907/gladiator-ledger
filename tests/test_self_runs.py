"""A run of one model on both sides is a consistency check, never a match: it adds to that model's own fitness for
the task and says how often the model ended the same way given the same scenario twice. Nothing about pairs, wins
or opponents may change because of it."""

import json
import shutil
from pathlib import Path

import pytest

from ledger import cli, load, questions
from ledger.bridges.gladiator import canonical_sha256

DATA = Path(__file__).resolve().parent.parent / "data"
BATCH = "20261124-172417-d0e5b3"  # a live batch: DeepSeek V4.1 Flash against Gemini 3.5 Flash-Lite on access-review
DEEPSEEK = "openrouter:deepseek/deepseek-v4.1-flash-1017"
LUNA = "openai:gpt-6-luna"


@pytest.fixture(scope="module")
def stores(tmp_path_factory):
    """Two stores from the shipped records: as shipped, and with one more record in which DeepSeek plays both
    sides (made from the live batch: side B is given side A's model and DeepSeek's own results)."""
    if not (DATA / "records" / BATCH / "record.json").exists():
        pytest.skip("the live batch this test is built from is not in this checkout")
    root = tmp_path_factory.mktemp("self")
    shutil.copytree(DATA / "records", root / "records")
    plain = str(root / "plain.rl")
    load.load(root / "records", plain)
    body = json.loads((DATA / "records" / BATCH / "record.json").read_text(encoding="utf-8"))["body"]
    body["run_id"] = "20261125-000000-5e1f00"
    a = body["contestants"]["A"]
    results = json.loads(json.dumps(a["results"]))
    results[0]["passed"] = not results[0]["passed"]  # the second time, the first scenario ended the other way
    body["contestants"]["B"] = dict(a, results=results)
    folder = root / "records" / body["run_id"]
    folder.mkdir()
    (folder / "record.json").write_text(json.dumps({"sha256": canonical_sha256(body), "body": body}), encoding="utf-8")
    with_self = str(root / "self.rl")
    load.load(root / "records", with_self)
    return plain, with_self, len(results)


def test_a_self_run_is_kept_apart_from_every_question_about_pairs(stores):
    plain, with_self, scenarios = stores
    for name in ("beats", "beat_cycles", "flows", "promotion", "hazard_profile"):
        scope = {"suite": None}
        assert cli.rows(with_self, questions.ALL[name], scope) == cli.rows(plain, questions.ALL[name], scope), name
    count = "MATCH (n:{}) RETURN count(n) AS n"
    assert cli.rows(with_self, count.format("Match")) == cli.rows(plain, count.format("Match"))
    assert cli.rows(with_self, count.format("Attempt")) == cli.rows(plain, count.format("Attempt"))
    assert cli.rows(with_self, count.format("SelfCheck"))[0]["n"] == scenarios
    assert cli.rows(with_self, count.format("SelfAttempt"))[0]["n"] == 2 * scenarios
    # loading again creates nothing
    before = cli.rows(with_self, "MATCH (n) RETURN count(n) AS n")
    load.load(Path(with_self).parent / "records", with_self)
    assert cli.rows(with_self, "MATCH (n) RETURN count(n) AS n") == before


def test_it_counts_in_the_models_own_fitness_and_never_head_to_head(stores):
    plain, with_self, scenarios = stores
    before = cli.verdict(plain, "access-review", DEEPSEEK, LUNA, profile="personal")
    after = cli.verdict(with_self, "access-review", DEEPSEEK, LUNA, profile="personal")
    # the head-to-head is untouched: same pairs, same wins, same rounds
    for key in ("pairs", "wins", "ties", "p_value", "rounds", "verdict"):
        assert after[key] == before[key], key
    # the model's own count on the task grew by the attempts it made against itself; the other model's did not
    assert "live-race" in {r["suite"] for r in after["evidence"]}  # the live evidence that brings live batches in
    played = sum(
        1 for x in cli.rows(with_self, "MATCH (a:SelfAttempt)-[:IN]->(sc:SelfCheck) WHERE NOT sc.excluded RETURN a")
    )
    assert after["fit"][DEEPSEEK]["attempts"] == before["fit"][DEEPSEEK]["attempts"] + played
    assert after["fit"][LUNA] == before["fit"][LUNA]
    # consistency: the same scenario twice, the same ending in all but the one that was flipped
    assert before["consistency"] == []
    (row,) = after["consistency"]
    assert (row["model"], row["scenarios"], row["same"]) == (DEEPSEEK, scenarios, scenarios - 1)
    assert row["attempts"] == 2 * scenarios
