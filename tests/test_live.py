"""Ledger live (ledger/live.py): the record kept in one Relate store that is written to as races end.

What has to hold for a live record to be the record: adding sealed records one at a time, in any order, leaves
exactly the graph that building from all of them leaves, which is exactly the graph the command line builds. A
record whose seal does not match never gets in. And what the service hands a page (the rows of one record) is
enough for the page's own graph to become that same graph.
"""

import json
import shutil
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import relate

from ledger import cli, live, load, replay, routes
from ledger.bridges import Evidence, gladiator, steps

DATA = Path(__file__).resolve().parent.parent / "data"
# Two suite matches (four workflows each, with corrected costs), then what a runner files: live races on three
# workflows in three wordings, a live batch, and a batch of one model against itself.
SUITE = ["20261122-105138-442050", "20261122-100556-a99b02"]
LIVE = [
    "20261124-062644-ef2cfd",
    "20261124-152144-f6114a",
    "20261124-172417-d0e5b3",
    "20261126-115557-050b61",
    "20261126-115812-3d1417",
    "20261126-121057-018a06",
]
NODES = "MATCH (n) WHERE NOT n:LiveStore RETURN labels(n) AS labels, properties(n) AS props"
LINKS = (
    "MATCH (a)-[r]->(b) RETURN type(r) AS kind, coalesce(a.key, a.run_id, a.name, a.id) AS a, "
    "coalesce(b.key, b.run_id, b.name, b.id) AS b, properties(r) AS props"
)

pytestmark = pytest.mark.skipif(
    not all((DATA / "records" / run / "record.json").exists() for run in SUITE + LIVE),
    reason="the shipped records these tests are built from are not in this checkout",
)


def graph(ask) -> tuple[list[str], list[str]]:
    """Everything in a store, in an order that does not depend on how it got there. `ask(query) -> rows`."""
    nodes = sorted(json.dumps([sorted(r["labels"]), r["props"]], sort_keys=True, default=str) for r in ask(NODES))
    links = sorted(json.dumps([r["kind"], r["a"], r["b"], r["props"]], sort_keys=True, default=str) for r in ask(LINKS))
    return nodes, links


def record(run: str) -> dict:
    return json.loads((DATA / "records" / run / "record.json").read_text(encoding="utf-8"))


def data_folder(root: Path, runs: list[str]) -> Path:
    """A data folder like Ledger's own, holding only these records (with whatever is shipped beside each)."""
    for run in runs:
        shutil.copytree(DATA / "records" / run, root / "records" / run)
    for beside in ("validations", "epoch"):
        shutil.copytree(DATA / beside, root / beside)
    return root


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """The whole set as the command line builds it, results and steps, in a store of its own."""
    root = tmp_path_factory.mktemp("built")
    data = data_folder(root / "data", SUITE + LIVE)
    store = str(root / "all.rl")
    routes.build(store, data)
    return graph(lambda q: cli.rows(store, q))


def quiet(_):
    return None


def test_records_added_one_at_a_time_in_any_order_leave_the_graph_the_command_line_builds(tmp_path, built):
    # a live record that starts from the two suite matches and takes the rest in newest first
    said = []
    rec = live.LiveRecord(tmp_path / "state", data_folder(tmp_path / "data", SUITE), None, say=said.append)
    try:
        assert [r["run_id"] for r in rec.runs()] == sorted(SUITE)
        for run in reversed(LIVE):
            assert rec.take_in(record(run)) is True
        assert [r["run_id"] for r in rec.runs()] == sorted(SUITE + LIVE)
        nodes, links = graph(rec.rows)
        assert len(nodes) > 4000 and len(links) > 10000  # results, steps and world records
        assert nodes == built[0] and links == built[1]
        # the same record again changes nothing, and says so
        assert rec.take_in(record(LIVE[0])) is False
        assert graph(rec.rows) == built
        # a self run came in as its own kind of node, with its steps
        alone = rec.rows(
            "MATCH (a:SelfAttempt)-[:TOOK]->(s:Step) RETURN count(DISTINCT a) AS attempts, count(s) AS steps"
        )
        assert alone[0]["attempts"] == 20 and alone[0]["steps"] > 100
    finally:
        rec.close()
    # started again, it reopens the store it left (no rebuild) with every record it took in
    rec = live.LiveRecord(tmp_path / "state", tmp_path / "data", None, say=said.append)
    try:
        assert any("store reopened" in line for line in said) and graph(rec.rows) == built
    finally:
        rec.close()
    # a store written by other code than this is not trusted: it is built again from the records
    with relate.connect(str(tmp_path / "state" / live.STORE)) as conn:
        conn.execute("MATCH (l:LiveStore) SET l.loader = 'an older loader'")
    said.clear()
    rec = live.LiveRecord(tmp_path / "state", tmp_path / "data", None, say=said.append)
    try:
        assert any("building the store" in line for line in said) and graph(rec.rows) == built
    finally:
        rec.close()


def test_a_record_whose_seal_does_not_match_never_gets_in(tmp_path):
    rec = live.LiveRecord(tmp_path / "state", data_folder(tmp_path / "data", SUITE[:1]), None, say=quiet)
    try:
        before = graph(rec.rows)
        forged = record(LIVE[0])
        forged["body"]["contestants"]["A"]["results"][0]["passed"] = not forged["body"]["contestants"]["A"]["results"][
            0
        ]["passed"]
        assert rec.take_in(forged) is False
        assert rec.take_in({"sha256": "0" * 64, "body": {"run_id": "../../escape"}}) is False
        assert rec.take_in({}) is False
        assert graph(rec.rows) == before and [r["run_id"] for r in rec.runs()] == SUITE[:1]
        assert not (tmp_path / "state" / "records").exists() or not any((tmp_path / "state" / "records").iterdir())
    finally:
        rec.close()


class Runner:
    """A stand-in race runner: the two routes of the real one that Ledger reads (/races and /records/<run_id>)."""

    def __init__(self):
        self.filed: dict[str, dict] = {}
        self.asked: list[str] = []
        runner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                return

            def do_GET(self):
                runner.asked.append(self.path)
                if self.path == "/races":
                    listed = {"races": [{"run_id": r} for r in runner.filed], "batches": [{"run_id": "not-a-run-id"}]}
                    body = json.dumps(listed).encode()
                elif self.path.startswith("/records/") and self.path[len("/records/") :] in runner.filed:
                    body = json.dumps(runner.filed[self.path[len("/records/") :]]).encode()
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def get(url: str, origin: str | None = None, method: str = "GET"):
    request = urllib.request.Request(url, method=method, headers={"Origin": origin} if origin else {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode() or "null"), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode() or "null"), dict(error.headers)


def test_the_service_takes_in_what_the_runner_files_and_hands_a_page_what_it_lacks(tmp_path, monkeypatch):
    monkeypatch.setattr(live, "FRESH_AFTER_S", 0)
    runner = Runner()
    page = "https://ledger.example"
    rec = live.LiveRecord(tmp_path / "state", data_folder(tmp_path / "data", SUITE), runner.url, say=quiet)
    server = ThreadingHTTPServer(("127.0.0.1", 0), live.handler_for(rec, {page}))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    at = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        status, health, _ = get(f"{at}/health")
        assert (
            status == 200
            and health["ok"]
            and health["records"] == 2
            and health["steps"] > 0
            and health["runner"] == runner.url
        )
        # nothing filed yet: the store is what it started from
        assert [r["run_id"] for r in get(f"{at}/runs?fresh=1")[1]["runs"]] == sorted(SUITE)
        # a race ends on the runner; the page says so, and the record is in the store at once
        new = LIVE[-1]
        runner.filed[new] = record(new)
        status, synced, _ = get(f"{at}/sync", method="POST")
        assert status == 200 and synced == {"took_in": [new], "problem": None}
        listed = get(f"{at}/runs")[1]["runs"]
        assert [r["run_id"] for r in listed] == sorted([*SUITE, new]) and listed[-1]["seal"] == record(new)["sha256"]
        assert get(f"{at}/sync", method="POST")[1]["took_in"] == []  # taken in once
        # only the runner it was started with is ever asked, and only for the list and for sealed records
        assert set(runner.asked) == {"/races", f"/records/{new}"}

        # what a page needs to catch up: the rows of that record. Loaded into a store that holds only what the
        # page shipped with, through the statements the page has, they leave the graph the command line builds
        # from all three records.
        status, rows, headers = get(f"{at}/rows/{new}", origin=page)
        assert (
            status == 200 and headers["Access-Control-Allow-Origin"] == page and rows["seal"] == record(new)["sha256"]
        )
        shipped = str(tmp_path / "page.rl")
        routes.build(shipped, tmp_path / "data")
        with relate.connect(shipped) as conn:
            load.write_to(conn, Evidence(source=gladiator.NAME, description=gladiator.DESCRIPTION, runs=[rows["run"]]))
            load.write_steps(conn, steps.expand(rows["steps"]))
        whole = str(tmp_path / "whole.rl")
        routes.build(whole, data_folder(tmp_path / "whole", [*SUITE, new]))
        assert graph(lambda q: cli.rows(shipped, q)) == graph(lambda q: cli.rows(whole, q)) == graph(rec.rows)

        # and they are the very rows, step file and replay file that `ledger site` would ship for that record with
        # a page published after it: the page loads one or the other and cannot tell which
        def plain(value):
            return json.loads(json.dumps(value, default=str))

        records = tmp_path / "whole" / "records"
        assert rows["run"] == plain(next(r for r in gladiator.read_records(records).runs if r["run_id"] == new))
        steps.export(records, tmp_path / "steps")
        assert rows["steps"] == json.loads((tmp_path / "steps" / f"{new}.json").read_text(encoding="utf-8"))
        replay.export(records, tmp_path / "replays")
        status, played, headers = get(f"{at}/replay/{new}", origin=page)
        assert status == 200 and headers["Access-Control-Allow-Origin"] == page
        assert played == json.loads((tmp_path / "replays" / f"{new}.json").read_text(encoding="utf-8"))
        assert get(f"{at}/replay/20990101-000000-abcdef")[0] == 404

        # the rest of the surface: an address that is not allowed gets no permission to read it from a browser,
        # and nothing but a run id is looked up
        assert "Access-Control-Allow-Origin" not in get(f"{at}/rows/{new}", origin="https://elsewhere.example")[2]
        assert get(f"{at}/rows/20990101-000000-abcdef")[0] == 404 and get(f"{at}/rows/..%2F..%2Fsecrets")[0] == 404
        assert get(f"{at}/anything-else")[0] == 404 and get(f"{at}/rows/{new}", method="POST")[0] == 404
        # many readers at once are answered in turn by the one thread that owns the store
        answers = []
        readers = [threading.Thread(target=lambda: answers.append(get(f"{at}/rows/{new}")[0])) for _ in range(12)]
        for t in readers:
            t.start()
        for t in readers:
            t.join()
        assert answers == [200] * 12

        # a record the runner files that does not match its seal is refused, said, and not asked for again
        bad = "20990101-000000-abcdef"
        forged = record(LIVE[0])
        forged["body"]["run_id"] = bad
        runner.filed[bad] = forged
        assert get(f"{at}/sync", method="POST")[1] == {"took_in": [], "problem": None}
        assert get(f"{at}/sync", method="POST")[1]["took_in"] == []
        assert get(f"{at}/health")[1]["refused"] == [bad] and runner.asked.count(f"/records/{bad}") == 1
        assert len(get(f"{at}/runs")[1]["runs"]) == 3 and get(f"{at}/rows/{bad}")[0] == 404

        # a runner that cannot be reached is said, not hidden, and the store answers as before
        runner.close()
        status, synced, _ = get(f"{at}/sync", method="POST")
        assert status == 200 and synced["took_in"] == [] and synced["problem"]
        assert get(f"{at}/health")[1]["problem"] and len(get(f"{at}/runs")[1]["runs"]) == 3
    finally:
        server.shutdown()
        server.server_close()
        rec.close()
