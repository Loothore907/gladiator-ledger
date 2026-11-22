"""The browser demo's data (site/data/) must be what `ledger site` writes from the shipped store and records.
The page's own answers are checked against expected.json by site/check.cjs (run in CI)."""

import json
from pathlib import Path

import pytest

from ledger import site

ROOT = Path(__file__).resolve().parent.parent
SHIPPED = ROOT / "site" / "data"


@pytest.mark.skipif(not SHIPPED.exists(), reason="no demo data in this checkout")
def test_demo_data_is_up_to_date_with_the_shipped_store(tmp_path):
    site.export(ROOT / "data", str(ROOT / "data" / "ledger.rl"), tmp_path)
    for name in ("graph.json", "questions.json", "rules.json", "expected.json"):
        fresh = json.loads((tmp_path / name).read_text(encoding="utf-8"))
        shipped = json.loads((SHIPPED / name).read_text(encoding="utf-8"))
        assert fresh == shipped, f"site/data/{name} is stale: run `uv run ledger site`"


def test_export_carries_what_the_page_needs(tmp_path):
    site.export(ROOT / "data", str(ROOT / "data" / "ledger.rl"), tmp_path)
    graph = json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))
    assert set(graph["writes"]) == set(graph["rows"]) == {"runs", "checks", "scores"}
    assert graph["rows"]["runs"] and graph["rows"]["checks"] and graph["rows"]["scores"]
    expected = json.loads((tmp_path / "expected.json").read_text(encoding="utf-8"))
    assert len(expected["verdicts"]) == len(expected["specs"]) == len(site.CHECKED)
    assert {v["verdict"] for v in expected["verdicts"]} >= {"better"}  # at least one settled answer is checked
