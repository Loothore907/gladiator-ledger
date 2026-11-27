import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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


def test_an_import_from_a_runner_brings_each_answer_key_the_runner_hands_out(tmp_path):
    """A live race's answer key is published once the race is over (owner, 2026-11-27): the runner hands it out for
    fresh worlds only, and the import applies its own two rules to it like to any other private half."""
    filed = tmp_path / "runner"
    with_private(filed, "fresh")  # the runner hands its key out
    with_private(filed, "kept")  # ... and this one's not (a runner from before that day, or a fixed test)
    with_private(filed, "swapped")  # ... and for this one hands out a key that is not the one sealed
    served = {"fresh": "fresh", "swapped": "fresh"}  # run id -> whose operator.json is sent
    asked = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            return

        def do_GET(self):
            asked.append(self.path)
            name = self.path[len("/records/") :] if self.path.startswith("/records/") else ""
            if self.path == "/races":
                body = json.dumps(
                    {"races": [{"run_id": "fresh"}, {"run_id": "kept"}], "batches": [{"run_id": "swapped"}]}
                )
            elif name.endswith("/operator") and name[: -len("/operator")] in served:
                body = (filed / served[name[: -len("/operator")]] / "operator.json").read_text()
            elif (filed / name / "record.json").is_file() and "/" not in name:
                body = (filed / name / "record.json").read_text()
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body.encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        # the swapped key is a different private half: give it different content, so its fingerprint differs
        (filed / "fresh" / "operator.json").write_text(json.dumps({"A": ["another world"], "B": []}))
        reseal(
            filed / "fresh" / "record.json",
            lambda body: body.update(operator_sha256=canonical_sha256({"A": ["another world"], "B": []})),
        )
        into = tmp_path / "fetched"
        got = publish.fetch_live(f"http://127.0.0.1:{server.server_address[1]}", into)
    finally:
        server.shutdown()
        server.server_close()
    assert got == {"fetched": ["fresh", "kept", "swapped"], "answer_keys": ["fresh", "swapped"]}
    assert "/records/kept/operator" in asked  # asked for, and not handed out: the record stands alone
    assert files(into) == [
        "fresh/operator.json",
        "fresh/record.json",
        "kept/record.json",
        "swapped/operator.json",
        "swapped/record.json",
    ]
    dest = tmp_path / "data" / "records"
    out = publish.import_records(into, dest)
    # the key that is not the one its record was sealed with is refused together with that record
    assert out["private_copied"] == ["fresh"] and out["copied"] == ["fresh", "kept"] and len(out["refused"]) == 1
    assert files(dest) == ["fresh/operator.json", "fresh/record.json", "kept/record.json"]
    assert publish.verify(dest) == {"records": 2, "private_halves": 1, "problems": []}
    # and the graph is told which record a reader can re-grade
    from ledger.bridges import gladiator

    keyed = {run["run_id"]: run["props"]["answer_key"] for run in gladiator.read_records(dest).runs}
    assert keyed == {"fresh": True, "kept": False}
