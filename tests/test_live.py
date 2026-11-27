"""Ledger live (ledger/live.py): the record kept in one Relate store that is written to as races end.

What has to hold for a live record to be the record: adding sealed records one at a time, in any order, leaves
exactly the graph that building from all of them leaves, which is exactly the graph the command line builds. A
record whose seal does not match never gets in. And what the service hands a page (the rows of one record) is
enough for the page's own graph to become that same graph.
"""

import json
import shutil
import threading
import time
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


def key_of(run: str) -> dict | None:
    """The answer key published beside a shipped record, when there is one (a live race's is, once the runner has
    handed it out and the import has kept it). These tests hold either way."""
    path = DATA / "records" / run / "operator.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


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
    # a live record that starts from the two suite matches and takes the rest in newest first. The runner it
    # was started with answers for each race's answer key, where the record shipped here has one beside it
    said = []
    runner = Runner()
    rec = live.LiveRecord(tmp_path / "state", data_folder(tmp_path / "data", SUITE), runner.url, say=said.append)
    try:
        assert [r["run_id"] for r in rec.runs()] == sorted(SUITE)
        for run in reversed(LIVE):
            assert rec.take_in(runner.file(run, listed=False)) is True
        # each race it took in has its answer key beside it exactly where the shipped record has one
        kept = sorted(p.parent.name for p in (tmp_path / "state" / "records").rglob("operator.json"))
        assert kept == sorted(run for run in LIVE if key_of(run) is not None)
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
        runner.close()
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
    """A stand-in race runner: the routes of the real one that Ledger reads (/races, /records/<run_id> and, for
    a record whose answer key it hands out, /records/<run_id>/operator)."""

    def __init__(self):
        self.filed: dict[str, dict] = {}
        self.keys: dict[str, dict] = {}  # run id -> the answer key handed out for it
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
                elif self.path.endswith("/operator") and self.path[len("/records/") : -len("/operator")] in runner.keys:
                    body = json.dumps(runner.keys[self.path[len("/records/") : -len("/operator")]]).encode()
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

    def file(self, run: str, listed: bool = True) -> dict:
        """A race has ended on this runner: its sealed record is on file and, as on the real runner, so is its
        answer key where one is published for it. `listed=False` keeps the record out of /races (a test that hands
        the record over itself still needs the runner to answer for its key)."""
        if listed:
            self.filed[run] = record(run)
        if key_of(run) is not None:
            self.keys[run] = key_of(run)
        return record(run)

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
        runner.file(new)
        status, synced, _ = get(f"{at}/sync", method="POST")
        assert status == 200 and synced == {"took_in": [new], "problem": None}
        listed = get(f"{at}/runs")[1]["runs"]
        assert [r["run_id"] for r in listed] == sorted([*SUITE, new]) and listed[-1]["seal"] == record(new)["sha256"]
        assert get(f"{at}/sync", method="POST")[1]["took_in"] == []  # taken in once
        # only the runner it was started with is ever asked, and only for the list, for sealed records and,
        # once, for the answer key of a record it took in. The store says the race can be re-graded exactly when
        # the runner handed its key out (which it does where the record shipped here has one beside it)
        keyed = key_of(new) is not None
        assert set(runner.asked) == {"/races", f"/records/{new}", f"/records/{new}/operator"}
        assert runner.asked.count(f"/records/{new}/operator") == 1
        assert get(f"{at}/health")[1]["answer_keys"] == 2 + int(keyed)
        assert get(f"{at}/rows/{new}")[1]["run"]["props"]["answer_key"] is keyed

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


def test_the_service_keeps_the_answer_key_a_runner_hands_out_and_only_the_one_that_was_sealed(tmp_path, monkeypatch):
    """A live race's answer key is published once the race is over (owner, 2026-11-27). The service asks the runner
    for the key of each record it takes in, keeps it beside the record when it is the one the record was sealed
    with, and its graph then says the record can be re-graded: the same graph the command line builds from a
    data folder that holds the record and its key. (A suite match stands in for the race: its key is on file.)"""
    monkeypatch.setattr(live, "FRESH_AFTER_S", 0)
    first, second = SUITE
    key = json.loads((DATA / "records" / second / "operator.json").read_text(encoding="utf-8"))
    runner = Runner()
    state, data = tmp_path / "state", data_folder(tmp_path / "data", [first])
    held = state / "records" / second / "operator.json"

    def started():
        return live.LiveRecord(state, data, runner.url, say=quiet)

    def says(rec):
        return rec.rows_for(second)["run"]["props"]["answer_key"], rec.health()["answer_keys"]

    try:
        # a runner that hands out no key: the record is taken in and stands alone, and is asked about once
        runner.filed[second] = record(second)
        rec = started()
        assert rec.sync(fresh=True)["took_in"] == [second] and says(rec) == (False, 1)
        rec.sync(fresh=True)
        assert runner.asked.count(f"/records/{second}/operator") == 1 and not held.exists()
        rec.close()

        # the runner now hands out a key that is not the one this record was sealed with: never kept
        runner.keys[second] = {"A": [], "B": []}
        rec = started()
        rec.sync(fresh=True)
        assert says(rec) == (False, 1) and not held.exists()
        rec.close()

        # and then the real one: kept beside the record, and said in the store that was already open
        runner.keys[second] = key
        rec = started()
        assert says(rec) == (False, 1)
        rec.sync(fresh=True)
        assert (
            says(rec) == (True, 2)
            and gladiator.canonical_sha256(json.loads(held.read_text())) == (record(second)["body"]["operator_sha256"])
        )
        # what the store now says of each record's answer key is what the command line says, building from a data
        # folder that holds both records with their keys (the costs differ here only because the suite match
        # standing in for a race has billed costs beside it in that folder, which a race does not)
        whole = str(tmp_path / "whole.rl")
        routes.build(whole, data_folder(tmp_path / "whole", [first, second]))
        keyed = "MATCH (r:Run) RETURN r.run_id AS run, r.answer_key AS key ORDER BY run"
        assert rec.rows(keyed) == cli.rows(whole, keyed) == [{"run": r, "key": True} for r in sorted(SUITE)]
        rec.close()

        # started again, with no runner to ask: the key is on file, and the store says so
        runner.close()
        rec = live.LiveRecord(state, data, None, say=quiet)
        assert says(rec) == (True, 2)
        rec.close()
    finally:
        runner.close()


def test_one_command_serves_the_page_beside_the_record_and_prints_the_address_that_joins_them(tmp_path):
    """`ledger serve --runner <address> --page` is the second of the two commands for a live race on a person's own
    machine: the record service, the page beside it, and one address to open. Run here as that person runs it."""
    import os
    import subprocess
    import sys

    site = DATA.parent / "site"
    data = data_folder(tmp_path / "data", SUITE)
    runner = Runner()
    asked = [
        *(sys.executable, "-m", "ledger.cli", "serve", "--runner", runner.url),
        *("--state", str(tmp_path / "state"), "--data", str(data), "--site", str(site)),
        *("--port", "0", "--page", "0"),
    ]
    service = subprocess.Popen(
        asked,
        cwd=DATA.parent,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        said = []
        for line in service.stdout:
            said.append(line)
            if line.strip().startswith("http://localhost:"):
                break
        address = said[-1].strip() if said else ""
        assert address.startswith("http://localhost:"), "no address to open was printed:\n" + "".join(said)
        page_at, _, query = address.partition("/?")
        named = dict(part.split("=", 1) for part in query.split("&"))
        # the address names this runner and this record, so the page a clone serves reaches no hosted one
        assert named["runner"] == runner.url and named["record"].startswith("http://127.0.0.1:")
        # the page itself, and what it cannot do without: its script and Relate's WebAssembly build
        with urllib.request.urlopen(f"{page_at}/", timeout=20) as response:
            assert response.status == 200 and "Gladiator Ledger" in response.read().decode()
        wasm = next(p for p in sorted((site / "vendor").rglob("*.wasm")))
        with urllib.request.urlopen(f"{page_at}/{wasm.relative_to(site).as_posix()}", timeout=20) as response:
            assert response.headers["Content-Type"] == "application/wasm"
        # nothing outside the page's folder is served
        with pytest.raises(urllib.error.HTTPError) as outside:
            urllib.request.urlopen(f"{page_at}/../pyproject.toml", timeout=20)
        assert outside.value.code == 404
        # the record lets that page read it, by either name this machine goes by, and no other page
        for origin in (page_at, page_at.replace("localhost", "127.0.0.1")):
            status, health, headers = get(f"{named['record']}/health", origin=origin)
            assert status == 200 and health["records"] == 2 and health["runner"] == runner.url
            assert headers.get("Access-Control-Allow-Origin") == origin
        assert "Access-Control-Allow-Origin" not in get(f"{named['record']}/health", origin="https://other.example")[2]
        # a race filed by the runner is taken in, as on a hosted record (the service looks at its runner again
        # a couple of seconds after its last look, not sooner)
        runner.file(LIVE[-1])
        took, tries = [], 0
        while not took and tries < 30:
            took = get(f"{named['record']}/sync", method="POST")[1]["took_in"]
            tries += 1
            if not took:
                time.sleep(0.5)
        assert took == [LIVE[-1]]
        assert LIVE[-1] in [r["run_id"] for r in get(f"{named['record']}/runs")[1]["runs"]]
    finally:
        service.terminate()
        service.wait(timeout=30)
        runner.close()


def test_the_page_is_not_served_from_a_folder_that_has_none(tmp_path):
    with pytest.raises(SystemExit) as stopped:
        live.page_server(tmp_path, 0)
    assert "index.html" in str(stopped.value)


def test_a_port_that_is_taken_is_said_in_plain_words_with_what_to_do(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<title>a page</title>", encoding="utf-8")

    def taken(*_):  # what the system says when something else already listens on the port
        raise OSError(98, "Address already in use")

    monkeypatch.setattr(live, "ThreadingHTTPServer", taken)
    with pytest.raises(SystemExit) as stopped:
        live.page_server(tmp_path, 8000)
    said = str(stopped.value)
    assert "port 8000" in said and "Address already in use" in said and "--page 8001" in said
