import json

from ledger import cli, publish
from ledger.bridges.gladiator import canonical_sha256
from tests.test_load import attempt, write_record


def reseal(path, change):
    rec = json.loads(path.read_text())
    change(rec["body"])
    rec["sha256"] = canonical_sha256(rec["body"])
    path.write_text(json.dumps(rec))


def with_private(folder, run_id, instances="generator", private=None):
    """A sealed match record whose tests are all `instances`, plus a private half its record fingerprints."""
    write_record(folder, run_id, [attempt("x", True, 0.01)], [attempt("x", False, 0.01)])
    private = private or {"A": [{"expected": {"REQ-1": "approve"}}], "B": [{"expected": {"REQ-1": "approve"}}]}

    def change(body):
        body["operator_sha256"] = canonical_sha256(private)
        for side in body["contestants"].values():
            for res in side["results"]:
                res["challenge"]["instances"] = instances

    reseal(folder / run_id / "record.json", change)
    (folder / run_id / "operator.json").write_text(json.dumps(private))


def files(dest):
    return sorted(p.relative_to(dest).as_posix() for p in dest.rglob("*") if p.is_file())


def test_import_refuses_a_tampered_record_and_can_copy_public_halves_only(tmp_path):
    src = tmp_path / "runs"
    with_private(src, "r1")
    write_record(src, "r2", [attempt("x", True, 0.01)], [attempt("x", False, 0.01)])
    bad = src / "r2" / "record.json"
    rec = json.loads(bad.read_text())
    rec["body"]["run_id"] = "tampered"
    bad.write_text(json.dumps(rec))

    dest = tmp_path / "data" / "records"
    out = publish.import_records(src, dest, private=False)
    assert out["copied"] == ["r1"] and len(out["refused"]) == 1
    assert files(dest) == ["r1/record.json"]  # no private half, nothing tampered
    again = publish.import_records(src, dest, private=False)
    assert again["copied"] == [] and again["unchanged"] == 1


def test_private_half_is_published_only_for_fresh_world_tests_and_only_when_it_matches(tmp_path):
    src = tmp_path / "runs"
    with_private(src, "fresh")  # every test generates a fresh world: answers are spent, publish both halves
    with_private(src, "fixed", instances="fixed")  # a fixed test: its answers stay private
    with_private(src, "swapped")  # the private half was replaced after the match
    (src / "swapped" / "operator.json").write_text(json.dumps({"A": [], "B": []}))

    dest = tmp_path / "data" / "records"
    out = publish.import_records(src, dest)
    assert out["private_copied"] == ["fresh"] and out["private_withheld"] == ["fixed"]
    assert len(out["refused"]) == 1 and "swapped" in out["refused"][0]
    assert files(dest) == ["fixed/record.json", "fresh/operator.json", "fresh/record.json"]
    assert publish.import_records(src, dest)["private_copied"] == []  # copying again changes nothing


def test_verify_checks_seals_and_private_halves(tmp_path, capsys):
    src = tmp_path / "runs"
    with_private(src, "r1")
    with_private(src, "r2")
    data = tmp_path / "data"
    publish.import_records(src, data / "records")
    assert publish.verify(data / "records") == {"records": 2, "private_halves": 2, "problems": []}
    assert cli.main(["verify", "--data", str(data)]) == 0
    assert "All match." in capsys.readouterr().out

    (data / "records" / "r2" / "operator.json").write_text(json.dumps({"A": ["edited"], "B": []}))
    result = publish.verify(data / "records")
    assert len(result["problems"]) == 1 and "r2" in result["problems"][0]
    assert cli.main(["verify", "--data", str(data)]) == 1
