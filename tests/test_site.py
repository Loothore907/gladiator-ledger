"""The browser demo's data (site/data/) must be what `ledger site` writes from the shipped store and records.
The page's own answers are checked against expected.json by site/check.cjs (run in CI)."""

import json
from pathlib import Path

import pytest

from ledger import site

ROOT = Path(__file__).resolve().parent.parent
SHIPPED = ROOT / "site" / "data"


@pytest.fixture(scope="module")
def fresh(tmp_path_factory):
    """One export from the shipped store and records, shared by the tests below (it reads every record and, the
    first time, loads every step into the local store beside the shipped one)."""
    out = tmp_path_factory.mktemp("site")
    site.export(ROOT / "data", str(ROOT / "data" / "ledger.rl"), out)
    return out


@pytest.mark.skipif(not SHIPPED.exists(), reason="no demo data in this checkout")
def test_demo_data_is_up_to_date_with_the_shipped_store(fresh):
    for name in ("graph.json", "questions.json", "rules.json", "expected.json"):
        made = json.loads((fresh / name).read_text(encoding="utf-8"))
        shipped = json.loads((SHIPPED / name).read_text(encoding="utf-8"))
        assert made == shipped, f"site/data/{name} is stale: run `uv run ledger site`"
    # one step file per record, each exactly what the export writes
    names = sorted(p.name for p in (fresh / "steps").glob("*.json"))
    assert names == sorted(p.name for p in (SHIPPED / "steps").glob("*.json")) and names
    for name in names:
        assert (fresh / "steps" / name).read_bytes() == (SHIPPED / "steps" / name).read_bytes(), (
            f"site/data/steps/{name} is stale: run `uv run ledger site`"
        )


def test_export_carries_what_the_page_needs(fresh):
    graph = json.loads((fresh / "graph.json").read_text(encoding="utf-8"))
    assert set(graph["rows"]) == {"runs", "checks", "scores"}
    # faults and the faults each attempt made are written from the run rows, after the runs themselves
    assert set(graph["writes"]) == {"runs", "includes", "faults", "made", "checks", "scores"}
    assert any(r["made"] for r in graph["rows"]["runs"]) and all(r["can_show"] for r in graph["rows"]["runs"])
    assert graph["rows"]["runs"] and graph["rows"]["checks"] and graph["rows"]["scores"]
    expected = json.loads((fresh / "expected.json").read_text(encoding="utf-8"))
    assert len(expected["verdicts"]) == len(expected["specs"]) == len(site.CHECKED)
    # every checked pair is also read through fitness: both profiles, and once with a reader's own rule
    assert len(expected["judged"]) == len(expected["judged_specs"]) == 3 * len(site.CHECKED)
    assert {j["verdict"]["outcome"] for j in expected["judged"]} >= {"neither fit", "only one fit"}
    assert {v["verdict"] for v in expected["verdicts"]} >= {"better"}  # at least one settled answer is checked


def test_export_carries_the_steps_and_what_they_answer(fresh):
    graph = json.loads((fresh / "graph.json").read_text(encoding="utf-8"))
    assert set(graph["steps"]["writes"]) == {"items", "refers", "steps", "next"} and graph["steps"]["schema"]
    assert ":SelfAttempt" in graph["steps"]["self_writes"]["steps"]
    rules = json.loads((fresh / "rules.json").read_text(encoding="utf-8"))
    questions = json.loads((fresh / "questions.json").read_text(encoding="utf-8"))
    assert all(f"steps:{name}" in questions for name in rules["step_checks"]) and rules["step_checks"]
    expected = json.loads((fresh / "expected.json").read_text(encoding="utf-8"))
    assert len(expected["process"]) == len(expected["routes"]) == len(expected["checked"]) == len(site.CHECKED)
    # the checks have something to find, a route has both sides, and a reader's check moves at least one answer
    asked = [c for p in expected["process"] for c in p["found"]["checks"]]
    assert any(m["attempts_with"] for c in asked for m in c["models"]) and all(len(c["models"]) == 2 for c in asked)
    for r in expected["routes"]:
        (one,) = r["one"]["scenarios"]
        assert one["scenario"] == site.ROUTE_SCENARIO and one["items"] and set(one["models"]) == {"A", "B"}
        assert len(r["every"]["scenarios"]) == r["every"]["pairs"] > 1
    plain = {
        (j["verdict"]["task"], j["verdict"]["a"], j["verdict"]["b"]): j["verdict"]["outcome"]
        for j in expected["judged"]
        if j["overrides"] is None and j["verdict"]["profile"] == "personal"
    }
    moved = [
        c
        for c in expected["checked"]
        if c["verdict"]["outcome"] != plain[(c["verdict"]["task"], c["verdict"]["a"], c["verdict"]["b"])]
    ]
    assert moved and all(c["verdict"]["own_checks"]["levels"] == site.OWN_CHECK for c in expected["checked"])
    # a step file expands to exactly the rows the command line loads
    from ledger.bridges import steps

    run = next(steps.read_steps(ROOT / "data" / "records"))
    packed = json.loads((fresh / "steps" / f"{run['run_id']}.json").read_text(encoding="utf-8"))
    assert steps.expand(packed)["routes"][0] == steps.expand(steps.compact(run))["routes"][0]
