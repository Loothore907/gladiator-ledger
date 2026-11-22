"""The shipped store must match the records shipped beside it: a judge's clean clone gives the same answers."""

from pathlib import Path

import pytest
import relate

from ledger import cli, publish

DATA = Path(__file__).resolve().parent.parent / "data"
STORE = DATA / "ledger.rl"


@pytest.mark.skipif(not STORE.exists(), reason="no shipped store in this checkout")
def test_shipped_store_matches_shipped_records(tmp_path):
    records = sorted(p.parent.name for p in (DATA / "records").rglob("record.json"))
    # Private halves are shipped only for finished matches on fresh-world tests, and each must match the
    # fingerprint its public record carries.
    checked = publish.verify(DATA / "records")
    assert checked["problems"] == [] and checked["records"] == len(records)
    with relate.connect(str(STORE), read_only=True) as conn:
        runs = sorted(r["id"] for r in conn.execute("MATCH (r:Run) RETURN r.run_id AS id"))
    assert runs == records, "data/ledger.rl is stale: rebuild it with `ledger build` (see README)"

    rebuilt = str(tmp_path / "rebuilt.rl")
    cli.main(
        [
            "--store",
            rebuilt,
            "build",
            "--records",
            str(DATA / "records"),
            "--validations",
            str(DATA / "validations"),
            "--scores",
            str(DATA / "epoch"),
        ]
    )
    count = "MATCH (n) RETURN labels(n)[0] AS kind, count(*) AS n ORDER BY kind"
    assert cli.rows(rebuilt, count) == cli.rows(str(STORE), count)


@pytest.mark.skipif(not STORE.exists(), reason="no shipped store in this checkout")
def test_recommend_runs_on_the_shipped_store():
    rec = cli.recommend(str(STORE), None, budget=0.05, suite="small-tier")
    assert rec["models"] and rec["verdict"] in {"pick", "leaning", "tie", "not enough evidence"}
