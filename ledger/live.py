"""Ledger live: the record kept in one Relate database that is written to as races end.

The shipped store (data/ledger.rl) is rebuilt from the sealed records in a batch and published with the page. This
is the same graph kept alive: one long-running process owns a Relate store, takes in each new sealed record from a
Gladiator race runner as soon as the runner has filed it, and hands the page the rows of whatever the page's own
copy does not hold yet. A race then counts in the verdict seconds after it ends.

What Relate asks of such a process, and how this answers it (all tried on relate-db 1.2.0):
  - One process may write a store, and a single `.rl` file can be opened by nobody else while it is held. So the
    store here is Relate's directory format, and this process is its one writer.
  - A connection belongs to the thread that opened it. So one thread owns the connection, and every read and
    write is handed to it and answered in turn (`LiveRecord._ask`).
  - Opening a store takes about a second once it holds every step, and the whole graph is held in memory. So the
    store is opened once and kept open.

The sealed records stay the master copy. Every record taken in is first checked against its seal and kept as a
file (`<state>/records/<run_id>/record.json`), and the store can be rebuilt from the records at any time: it is
rebuilt at start-up whenever it was built by other code than this (ledger/load.py, loader_stamp). Adding a record
to a store that is already built leaves the same graph as building it again from all of them
(tests/test_live.py). Nothing here runs a match, holds a key or writes anywhere but its own state folder; the
only thing a request can make it do is look at the runner it was started with.

    ledger serve --runner https://race.gladiatorbench.com --state live-state --origin https://ledger.gladiatorbench.com
"""

import json
import re
import shutil
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import relate

from ledger import costs, load, replay
from ledger.bridges import Evidence, epoch, gladiator, steps

RUN_ID = re.compile(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{6}")  # the runner's own form for a run id
STORE = "store"  # a folder, not a file: Relate's directory format, which one process writes and others may read
SYNC_EVERY_S = 15  # a request for the list of runs looks at the runner again when the last look is older than this
FRESH_AFTER_S = 2  # ... or this, when the page says a race has just ended
MAX_NEW_PER_SYNC = 40  # records taken in during one look at the runner (the rest wait for the next)
AGENT = "gladiator-ledger-live"


class LiveRecord:
    """The live store and everything that touches it. `data` is Ledger's data folder, which the service starts
    from (the shipped records under records/, and the validation records and published scores beside them);
    `state` is where it keeps the store and the records it takes in itself; `runner` is the one address it will
    ever fetch records from (None: it takes in nothing)."""

    def __init__(self, state: Path, data: Path | None = None, runner: str | None = None, say=print):
        self.state = Path(state)
        self.data = Path(data) if data else None
        self.runner = runner.rstrip("/") if runner else None
        self.say = say
        self.records = self.state / "records"
        self.records.mkdir(parents=True, exist_ok=True)
        self.store = str(self.state / STORE)
        self.flows = gladiator.Flows()
        self.paths: dict[str, Path] = {}  # run id -> its sealed record on disk
        self.seals: dict[str, str] = {}  # run id -> its seal, for every run in the store
        self.refused: set[str] = set()  # run ids the runner listed whose record was refused: not asked for again
        self.no_key: set[str] = set()  # run ids whose answer key the runner did not hand out: asked once per start
        self.synced = 0.0  # when the runner was last looked at
        self.problem = ""  # why the last look at the runner failed, if it did
        self._syncing = threading.Lock()
        self._facts = threading.Lock()  # guards flows, paths and seals: requests read them while a sync writes
        self._owner = ThreadPoolExecutor(max_workers=1, thread_name_prefix="relate")  # the thread that owns the store
        self._conn = None
        self._open()

    # ---- the one thread that owns the connection ----

    def _ask(self, work):
        """Run `work(conn)` on the thread that owns the connection, and wait for its answer."""
        return self._owner.submit(lambda: work(self._conn)).result()

    def rows(self, query: str, params: dict | None = None) -> list[dict]:
        return self._ask(lambda conn: [dict(r) for r in conn.execute(query, params or {})])

    def close(self) -> None:
        def shut(conn):
            if conn is not None:
                conn.close()

        self._ask(shut)
        self._conn = None
        self._owner.shutdown()

    # ---- start-up: the store as it is, or built again from the records ----

    def _on_file(self) -> dict[str, Path]:
        """Every sealed record this service has, by run id: the ones it took in itself, and the baseline. Where a
        record is in both, the baseline's copy is the one read: it is the published one, with whatever is
        published beside it (its answer key, its billed costs)."""
        found = {}
        for root in (self.records, self.data / "records" if self.data else None):
            if root and root.exists():
                for path in gladiator.find_records(root):
                    found[path.parent.name] = path
        return dict(sorted(found.items()))

    def _open(self) -> None:
        self.paths = self._on_file()
        stamp = load.loader_stamp()

        def reuse():
            if not Path(self.store).exists():
                return None
            try:
                conn = relate.connect(self.store)
                held = {
                    r["id"]: r["seal"]
                    for r in conn.execute("MATCH (r:Run) RETURN r.run_id AS id, r.seal_sha256 AS seal")
                }
                built = [r["by"] for r in conn.execute("MATCH (l:LiveStore) RETURN l.loader AS by")]
            except relate.Error:
                return None
            # a store built by this code, holding nothing but records that are still on file, is the store
            if built == [stamp] and set(held) <= set(self.paths):
                return conn, held
            conn.close()
            return None

        kept = self._owner.submit(reuse).result()
        if kept:
            self._conn, self.seals = kept
            self.say(f"[live] store reopened: {len(self.seals)} records")
        else:
            shutil.rmtree(self.store, ignore_errors=True)

            def create():
                conn = relate.connect(self.store)
                conn.execute("CREATE CONSTRAINT live_store IF NOT EXISTS FOR (n:LiveStore) REQUIRE n.key IS UNIQUE")
                conn.execute("MERGE (l:LiveStore {key: 'store'}) SET l.loader = $by", {"by": stamp})
                for statement in load.STEP_SCHEMA:
                    conn.execute(statement)
                return conn

            self._conn = self._owner.submit(create).result()
            self.seals = {}
            self.say(f"[live] building the store from {len(self.paths)} records on file")
        # what every record on file says of its workflow is learnt first, so that each one is written with the
        # one account of it (the same graph, whether the records come all at once or one at a time)
        read = {run_id: self._read(path, with_steps=False) for run_id, path in self.paths.items()}
        for run in read.values():
            if run:
                self.flows.absorb(run)
        keys = [{"id": i, "key": run["props"]["answer_key"]} for i, run in read.items() if run and i in self.seals]
        for run_id, run in read.items():
            if run and run_id not in self.seals:
                self._write(run, self._read(self.paths[run_id])[1])
        if keys:  # records the reopened store already held: whether each one's answer key is on file now
            self._ask(
                lambda conn: conn.execute(
                    "UNWIND $rows AS x MATCH (r:Run {run_id: x.id}) SET r.answer_key = x.key", {"rows": keys}
                )
            )
        self._beside()
        self.say(f"[live] ready: {len(self.seals)} records in the store")

    def _beside(self) -> None:
        """What stands beside the matches in Ledger's data folder: the validation records of the tests, the
        published scores used to suggest opponents, and fork lineage. Written on every start; all of it is
        MERGE on stable keys, so a second time changes nothing."""
        if not self.data:
            return
        found = []
        if (self.data / "validations").exists():
            found.append(gladiator.read_validations(self.data / "validations"))
        if (self.data / "epoch").exists():
            found.append(epoch.read_scores(self.data / "epoch"))

        def work(conn):
            for evidence in found:
                load.write_to(conn, evidence)
            conn.execute(load.LINK_FORKS)

        self._ask(work)

    # ---- one record: read, check, write ----

    def _read(self, path: Path, with_steps: bool = True):
        """A sealed record as rows for the graph: its results and, unless only the results are wanted, its steps
        (a pair). None when its seal does not match. Costs are corrected as the record is read, exactly as the
        command line does."""
        record = json.loads(Path(path).read_text(encoding="utf-8"))
        if not gladiator.seal_ok(record):
            self.say(f"[live] refused (the seal does not match): {Path(path).parent.name}")
            return None
        body = costs.corrected(record["body"], costs.read_billed(Path(path), record["sha256"]))
        run = gladiator.run_rows(body, record["sha256"], gladiator.answer_key_beside(Path(path), record))
        return (run, steps.run_steps(record["body"])) if with_steps else run

    def _write(self, run: dict, run_steps: dict) -> None:
        """One record into the store, with the account of its workflow as it now stands."""
        with self._facts:
            self.flows.apply(run)
        evidence = Evidence(source=gladiator.NAME, description=gladiator.DESCRIPTION, runs=[run])

        def work(conn):
            load.write_to(conn, evidence)
            load.write_steps(conn, run_steps)

        self._ask(work)
        with self._facts:
            self.seals[run["run_id"]] = run["props"]["seal_sha256"]

    def take_in(self, record: dict) -> bool:
        """A sealed record, as the runner serves it: checked against its seal, kept as a file, written to the
        store. False when it is refused or already held. Taking the same record in twice changes nothing."""
        run_id = str((record.get("body") or {}).get("run_id") or "")
        if not RUN_ID.fullmatch(run_id) or not gladiator.seal_ok(record):
            self.say(f"[live] refused (not a sealed record, or the seal does not match): {run_id[:40] or 'no id'}")
            return False
        if self.seals.get(run_id) == record["sha256"]:
            return False
        path = self.records / run_id / "record.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        self._take_key(path, record)  # before the record is read, so its rows say whether the key is on file
        run, run_steps = self._read(path)
        with self._facts:
            self.paths[run_id] = path
            self.flows.absorb(run)
        self._write(run, run_steps)
        self.say(f"[live] took in {run_id}")
        return True

    def _take_key(self, path: Path, record: dict) -> bool:
        """Ask the runner for the answer key of one record this service took in, and keep it beside the record
        when it is the one the record was sealed with (owner, 2026-11-27: a live race's answer key is published
        once the race is over). True when the key is on file afterwards. A runner that hands none out (a fixed
        test, or a runner from before that day) leaves the record as it is. Never fails a record."""
        if gladiator.answer_key_beside(path, record):
            return True
        run_id = record["body"]["run_id"]
        if not self.runner or not gladiator.fresh_worlds_only(record) or run_id in self.no_key:
            return False
        private = path.with_name("operator.json")
        try:
            key = self._fetch(f"/records/{run_id}/operator")
            private.write_text(json.dumps(key, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        except (urllib.error.URLError, OSError, ValueError):
            self.no_key.add(run_id)  # asked once per start: a runner that hands it out later is asked again then
            return False
        if gladiator.answer_key_beside(path, record):
            self.say(f"[live] kept the answer key of {run_id}")
            return True
        private.unlink(missing_ok=True)  # not the key this record was sealed with: never kept
        self.no_key.add(run_id)
        self.say(f"[live] refused an answer key (not the one sealed): {run_id}")
        return False

    def _late_keys(self) -> list[str]:
        """Records this service took in before their answer key was handed out: ask for a few of them again,
        and mark in the store the ones that now have it."""
        with self._facts:
            mine = [
                (i, path) for i, path in self.paths.items() if self.records in path.parents and i not in self.no_key
            ]
        got, asked = [], 0
        for run_id, path in mine:
            if asked >= MAX_NEW_PER_SYNC:
                break  # the rest wait for the next look
            if path.with_name("operator.json").is_file():
                continue
            asked += 1
            record = json.loads(path.read_text(encoding="utf-8"))
            if self._take_key(path, record):
                got.append(run_id)
        if got:
            self._ask(
                lambda conn: conn.execute("MATCH (r:Run) WHERE r.run_id IN $ids SET r.answer_key = true", {"ids": got})
            )
        return got

    # ---- the runner ----

    def _fetch(self, path: str):
        request = urllib.request.Request(f"{self.runner}{path}", headers={"User-Agent": AGENT})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))

    def sync(self, fresh: bool = False) -> dict:
        """Look at the runner and take in the sealed records this store does not hold yet. At most one look at
        a time, and not more often than every few seconds, however many requests ask for it."""
        if not self.runner:
            return {"runner": None, "took_in": []}
        wait = FRESH_AFTER_S if fresh else SYNC_EVERY_S
        if time.time() - self.synced < wait or not self._syncing.acquire(blocking=fresh):
            return {"runner": self.runner, "took_in": [], "skipped": True}
        took = []
        if time.time() - self.synced < wait:  # someone else looked while this request waited its turn
            self._syncing.release()
            return {"runner": self.runner, "took_in": [], "skipped": True}
        try:
            listed = self._fetch("/races")
            ids = sorted({str(x.get("run_id")) for x in [*(listed.get("races") or []), *(listed.get("batches") or [])]})
            new = [i for i in ids if RUN_ID.fullmatch(i) and i not in self.seals and i not in self.refused]
            for run_id in new[:MAX_NEW_PER_SYNC]:
                if self.take_in(self._fetch(f"/records/{run_id}")):
                    took.append(run_id)
                else:
                    # refused once is refused until this service is started again: a sealed record does not
                    # change, so asking the runner for it on every look would only repeat the refusal
                    self.refused.add(run_id)
            self._late_keys()
            self.problem = ""
        except (urllib.error.URLError, OSError, ValueError, KeyError) as error:
            self.problem = f"{type(error).__name__}: {str(error)[:200]}"
            self.say(f"[live] the runner could not be read: {self.problem}")
        finally:
            self.synced = time.time()
            self._syncing.release()
        return {"runner": self.runner, "took_in": took, "problem": self.problem or None}

    # ---- what the page asks for ----

    def runs(self) -> list[dict]:
        """Every record in the store, oldest first: its id and its seal."""
        with self._facts:
            return [{"run_id": run_id, "seal": seal} for run_id, seal in sorted(self.seals.items())]

    def rows_for(self, run_id: str) -> dict | None:
        """One record as the rows the page loads into its own graph with the statements it already has: the run
        (with the account of its workflow as the store now holds it) and its steps in the small form."""
        with self._facts:
            path, seal = self.paths.get(run_id), self.seals.get(run_id)
        if path is None or seal is None:
            return None
        both = self._read(path)
        if both is None:
            return None
        run, run_steps = both
        with self._facts:
            self.flows.apply(run)
        return {"run": run, "steps": steps.compact(run_steps), "seal": seal}

    def replay_for(self, run_id: str) -> dict | None:
        """One record as the page replays it: every scenario as a timeline per model, the same file `ledger site`
        writes for a shipped record (ledger/replay.py), so a race that joined after the page was published can
        be watched like any other."""
        with self._facts:
            path, seal = self.paths.get(run_id), self.seals.get(run_id)
        if path is None or seal is None:
            return None
        record = json.loads(Path(path).read_text(encoding="utf-8"))
        if not gladiator.seal_ok(record):
            return None
        return replay.run_replays(costs.corrected(record["body"], costs.read_billed(Path(path), record["sha256"])))

    def health(self) -> dict:
        counted = self.rows("MATCH (s:Step) RETURN count(s) AS steps")[0]["steps"]
        return {
            "ok": True,
            "records": len(self.runs()),
            "answer_keys": self.rows("MATCH (r:Run) WHERE r.answer_key RETURN count(r) AS n")[0]["n"],
            "steps": counted,
            "runner": self.runner,
            "refused": sorted(self.refused),
            "synced_unix": round(self.synced),
            "problem": self.problem or None,
            "loader": load.loader_stamp(),
        }


def handler_for(live: LiveRecord, origins: set[str]):
    """The HTTP face of a live record: five read-only answers and one nudge.

    GET /health            is it up, how much it holds, when it last looked at the runner
    GET /runs[?fresh=1]    every record in the store (id and seal), after a look at the runner if one is due
                           (fresh=1: the page says a race has just ended, so look now)
    GET /rows/<run_id>     one record as rows for the page's own graph
    GET /replay/<run_id>   one record as the page replays it, scenario by scenario
    POST /sync             look at the runner now
    Nothing in a request is ever fetched, run or written: a request can only make the service look at the runner
    it was started with. Only a body's size is read, and nothing a request carries is logged."""

    class Handler(BaseHTTPRequestHandler):
        server_version = "LedgerLive"
        # A caller that connects and then sends nothing, or stops reading, is dropped: the host lets only so many
        # requests in at a time, and a few silent ones must not fill every place.
        timeout = 30

        def log_message(self, *_):  # never a path, a query or a body
            return

        def _cors(self):
            origin = self.headers.get("Origin")
            if origin and (origin in origins or "*" in origins):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _json(self, status: int, value, cache: str = "no-store"):
            body = json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            path, _, query = self.path.partition("?")
            try:
                if path == "/health":
                    return self._json(200, live.health())
                if path == "/runs":
                    looked = live.sync(fresh="fresh=1" in query.split("&"))
                    return self._json(200, {"runs": live.runs(), "problem": looked.get("problem")})
                if path.startswith("/rows/"):
                    run_id = path[len("/rows/") :]
                    found = live.rows_for(run_id) if RUN_ID.fullmatch(run_id) else None
                    if found is None:
                        return self._json(404, {"error": "No such record."})
                    # a sealed record never changes, but the account of its workflow can grow: a short life
                    return self._json(200, found, cache="public, max-age=60")
                if path.startswith("/replay/"):
                    run_id = path[len("/replay/") :]
                    found = live.replay_for(run_id) if RUN_ID.fullmatch(run_id) else None
                    if found is None:
                        return self._json(404, {"error": "No such record."})
                    return self._json(200, found, cache="public, max-age=3600")
                return self._json(404, {"error": "Nothing here."})
            except Exception as error:  # noqa: BLE001  an answer, never a dropped connection
                return self._json(500, {"error": f"{type(error).__name__}"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(min(length, 1024))  # nothing in a body is used
            if self.path.partition("?")[0] != "/sync":
                return self._json(404, {"error": "Nothing here."})
            looked = live.sync(fresh=True)
            return self._json(200, {"took_in": looked.get("took_in", []), "problem": looked.get("problem")})

    return Handler


def page_server(site: Path, port: int) -> ThreadingHTTPServer:
    """The page's own folder, served to this machine only: the static files of `site/`, exactly what
    `python -m http.server --directory site` would serve. It reads nothing else and takes nothing in."""
    if not (site / "index.html").is_file():
        raise SystemExit(f"No page to serve: {site / 'index.html'} is not there (run this from a clone of Ledger).")

    class Page(SimpleHTTPRequestHandler):
        def log_message(self, *_):  # the page's own files, hundreds of them: nothing worth a line each
            return

    try:
        return ThreadingHTTPServer(("127.0.0.1", port), partial(Page, directory=str(site)))
    except OSError as error:  # most often: something else on this machine already listens there
        raise SystemExit(
            f"The page cannot be served on port {port} of this machine ({error.strerror or error}). "
            f"Give another one: --page {port + 1}"
        ) from None


def page_address(page_port: int, record_port: int, runner: str | None) -> str:
    """The address that opens the page reading this record, and racing on this runner when there is one. Each is
    named in the address itself, so the page a clone serves never reaches a hosted record or runner."""
    asks = ([("runner", runner.rstrip("/"))] if runner else []) + [("record", f"http://127.0.0.1:{record_port}")]
    return f"http://localhost:{page_port}/?" + "&".join(f"{name}={value}" for name, value in asks)


def serve(
    state: Path,
    data: Path | None,
    runner: str | None,
    host: str,
    port: int,
    origins: list[str],
    page_port: int | None = None,
    site: Path = Path("site"),
) -> None:
    """Run the service until it is stopped. With `page_port`, the page is served beside it (this machine only)
    and may read it, and the address to open is printed."""
    page = page_server(site, page_port) if page_port is not None else None
    allowed = set(origins)
    if page:
        at = page.server_address[1]
        allowed |= {f"http://localhost:{at}", f"http://127.0.0.1:{at}"}
        print("[live] loading the record with every step (the first start takes about a minute)", flush=True)
    live = LiveRecord(state, data, runner)
    looked = live.sync(fresh=True)
    server = ThreadingHTTPServer((host, port), handler_for(live, allowed))
    print(f"[live] listening on {host}:{server.server_address[1]}; runner: {runner or 'none'}", flush=True)
    if page:
        threading.Thread(target=page.serve_forever, daemon=True).start()
        if runner and looked.get("problem"):
            print(
                f"[live] the runner at {runner} is not answering yet ({looked['problem']}). Start it, then reload "
                "the page: the record is asked for again each time.",
                flush=True,
            )
        print(
            f"\nOpen this in your browser:\n\n    {page_address(page.server_address[1], server.server_address[1], runner)}\n",
            flush=True,
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if page:
            page.shutdown()
            page.server_close()
        live.close()
