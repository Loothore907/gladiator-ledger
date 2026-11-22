import json

from ledger import publish
from tests.test_load import attempt, write_record


def test_import_copies_only_sealed_record_json(tmp_path):
    src = tmp_path / "runs"
    write_record(src, "r1", [attempt("x", True, 0.01)], [attempt("x", False, 0.01)])
    (src / "r1" / "operator.json").write_text('{"secret": "hidden faults"}')
    write_record(src, "r2", [attempt("x", True, 0.01)], [attempt("x", False, 0.01)])
    bad = src / "r2" / "record.json"
    rec = json.loads(bad.read_text())
    rec["body"]["run_id"] = "tampered"
    bad.write_text(json.dumps(rec))

    dest = tmp_path / "data" / "records"
    out = publish.import_records(src, dest)
    assert out["copied"] == ["r1"] and len(out["refused"]) == 1
    copied = sorted(p.relative_to(dest).as_posix() for p in dest.rglob("*") if p.is_file())
    assert copied == ["r1/record.json"]  # no operator.json, nothing tampered
    again = publish.import_records(src, dest)
    assert again["copied"] == [] and again["unchanged"] == 1
