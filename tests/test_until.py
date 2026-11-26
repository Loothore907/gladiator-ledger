"""`--until`: a verdict read from the record as it stood at a moment.

The record grows as live races are imported, so a figure printed in a document would drift. Reading the record as
it stood at a stated moment keeps such a figure exact for good: a race run later never joins that set."""

from datetime import UTC, datetime
from pathlib import Path

from ledger import cli

STORE = str(Path(__file__).resolve().parent.parent / "data" / "ledger.rl")
HAIKU = "anthropic:claude-haiku-5-5"
DEEPSEEK = "openrouter:deepseek/deepseek-v4.1-flash-1017"


def test_a_date_means_the_whole_of_that_day_and_times_are_utc():
    def at(text):
        return datetime.fromtimestamp(cli.parse_until(text), UTC).isoformat()

    assert at("2026-11-26") == "2026-11-26T23:59:59+00:00"
    assert at("2026-11-26T05:00") == "2026-11-26T05:00:00+00:00"
    assert at("2026-11-26T05:00Z") == "2026-11-26T05:00:00+00:00"
    assert at("2026-11-26T07:00+02:00") == "2026-11-26T05:00:00+00:00"
    assert cli.parse_until(None) is None and cli.parse_until("") is None


def test_the_record_as_it_stood_before_and_after_a_batch_of_25():
    ask = (STORE, "refund-queue", HAIKU, DEEPSEEK)
    # the evening before: the suite matches and two live races. Then a live batch of 25 at 04:57 UTC on Nov 26.
    before = cli.verdict(*ask, profile="personal", until=cli.parse_until("2026-11-25"))
    after = cli.verdict(*ask, profile="personal", until=cli.parse_until("2026-11-26T05:00"))
    assert (before["pairs"], after["pairs"]) == (18, 43)
    assert (before["wins"][HAIKU], after["wins"][HAIKU]) == (13, 37)
    # fitness is read from the same moment: every attempt up to it, and none after
    assert (before["fit"][HAIKU]["attempts"], after["fit"][HAIKU]["attempts"]) == (56, 81)
    assert (before["fit"][DEEPSEEK]["attempts"], after["fit"][DEEPSEEK]["attempts"]) == (70, 95)
    assert all(e["run"] < "20261126" for e in before["evidence"])
    assert "20261126-045746-d5a065" in {e["run"] for e in after["evidence"]}
    # nothing is ever taken out of a dated reading: the whole record holds at least as much
    whole = cli.verdict(*ask, profile="personal")
    assert whole["pairs"] >= after["pairs"] and whole["until"] is None
    assert whole["fit"][HAIKU]["attempts"] >= after["fit"][HAIKU]["attempts"]


def test_before_two_models_ever_met_there_is_nothing_to_read():
    v = cli.verdict(STORE, "refund-queue", HAIKU, DEEPSEEK, profile="personal", until=cli.parse_until("2026-11-01"))
    assert v["verdict"] == "no data" and v["pairs"] == 0
