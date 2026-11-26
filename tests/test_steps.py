"""The steps in the graph: how a model got to its result, and the questions asked of it (ledger/routes.py).

The first tests build a two-request world by hand. The rest read the shipped records, where the point is that a
pattern over the steps finds exactly what Gladiator's grader counted when the matches were played: if the graph and
the grader ever disagreed about a count both of them make, neither a new question nor its answer could be trusted.
"""

from pathlib import Path

import pytest
import relate

from ledger import assistant, cli, load, questions, routes
from ledger.bridges import steps
from tests.test_assistant import call
from tests.test_load import attempt, write_record

DATA = Path(__file__).resolve().parent.parent / "data"
STORE = DATA / "ledger.rl"
VERSION = "t/x@1.0.0:abababababab"
EVERYTHING = {"version_key": VERSION, "conditions": None, "suite": None, "until": None}


def turn(tool, args=None, observation=None):
    return {"tool_name": tool, "tool_args": args or {}, "observation": observation or {"ok": True}, "call_s": 1.0}


LISTED = {
    "page": 1,
    "pages": 1,
    "items": [{"id": "REQ-1", "order_id": "ORD-1", "note": "late"}, {"id": "REQ-2", "order_id": "ORD-2"}],
}
ORDER_1 = {"id": "ORD-1", "customer_id": "CUS-1", "amount": 10}
ORDER_2 = {"id": "ORD-2", "customer_id": "CUS-1", "amount": 20}
CUSTOMER = {"id": "CUS-1", "tier": "gold"}
TIMEOUT = {"error": "timeout", "outcome": "unknown"}

# A reads everything a request depends on before deciding it, and checks after a timeout.
CAREFUL = [
    turn("list_refund_requests", {"page": 1}, LISTED),
    turn("get_order", {"id": "ORD-1"}, ORDER_1),
    turn("get_customer", {"id": "CUS-1"}, CUSTOMER),
    turn("deny_request", {"request_id": "REQ-1", "reason": "late"}),
    turn("get_order", {"id": "ORD-2"}, ORDER_2),
    turn("issue_refund", {"request_id": "REQ-2", "amount": 20}, TIMEOUT),
    turn("check_refund", {"request_id": "REQ-2"}, {"found": False, "record": None}),
    turn("issue_refund", {"request_id": "REQ-2", "amount": 20}),
    turn("finish"),
]
# B decides REQ-1 before it has seen the customer (and looks the customer up afterwards, for REQ-2), is told the
# customer changed and decides REQ-2 without reading it again, and repeats a timed-out refund without checking.
HASTY = [
    turn("list_refund_requests", {"page": 1}, LISTED),
    turn("get_order", {"id": "ORD-1"}, ORDER_1),
    turn("deny_request", {"request_id": "REQ-1", "reason": "late"}),
    turn("get_order", {"id": "ORD-2"}, ORDER_2),
    turn("get_customer", {"id": "CUS-1"}, {**CUSTOMER, "notices": ["CORRECTION: customer CUS-1 is now standard."]}),
    turn("issue_refund", {"request_id": "REQ-2", "amount": 20}, TIMEOUT),
    turn("issue_refund", {"request_id": "REQ-2", "amount": 20}),
    turn("finish"),
]


def with_turns(turns, passed=True):
    return dict(attempt("x", passed, 0.01), turns=turns)


@pytest.fixture(scope="module")
def small(tmp_path_factory):
    folder = tmp_path_factory.mktemp("small")
    write_record(folder / "runs", "r1", [with_turns(CAREFUL)], [with_turns(HASTY)])
    store = str(folder / "s.rl")
    load.load(folder / "runs", store)
    first = load.load_steps(folder / "runs", store)
    return folder, store, first


def test_the_bridge_reads_steps_items_and_how_the_items_refer_to_each_other(small):
    folder, _, _ = small
    run = next(steps.read_steps(folder / "runs"))
    kinds = {i["id"]: i["kind"] for i in run["items"]}
    # the kind comes from the tool that shows the record: the list for a request, the lookup for the rest
    assert kinds == {"REQ-1": "refund request", "REQ-2": "refund request"} | {
        "ORD-1": "order",
        "ORD-2": "order",
        "CUS-1": "customer",
    }
    refers = {(r["a"].split("/")[-1], r["b"].split("/")[-1], r["field"]) for r in run["refers"]}
    assert refers == {
        ("REQ-1", "ORD-1", "order_id"),
        ("REQ-2", "ORD-2", "order_id"),
        ("ORD-1", "CUS-1", "customer_id"),
        ("ORD-2", "CUS-1", "customer_id"),
    }
    hasty = next(r for r in run["routes"] if r["attempt"] == "r1/x/1/B")["steps"]
    assert [s["kind"] for s in hasty] == ["read", "read", "act", "read", "read", "act", "act", "end"]
    assert [s["state"] for s in hasty][5:7] == ["timeout", "ok"]
    assert hasty[0]["saw"] == ["r1/x/1/REQ-1", "r1/x/1/REQ-2"] and hasty[0]["item"] is None
    assert hasty[2]["decided"] == ["r1/x/1/REQ-1"] and hasty[2]["item"] == "REQ-1"
    # a notice names the record it is about
    assert hasty[4]["told"] == [{"item": "r1/x/1/CUS-1", "notice": "CORRECTION: customer CUS-1 is now standard."}]
    # both attempts played the same world: one set of items, not two
    assert len(run["items"]) == 5 and not run["self"]


def test_the_small_form_for_the_page_gives_back_the_same_rows(small):
    folder, _, _ = small
    run = next(steps.read_steps(folder / "runs"))
    packed = steps.compact(run)
    assert packed["tools"][0] == "list_refund_requests" and list(packed["worlds"]) == ["x/1"]
    world = packed["worlds"]["x/1"]
    # a plain lookup carries no list of what it saw; the list and the step with a notice do
    assert world["routes"]["B"][0][5] == ["REQ-1", "REQ-2"] and len(world["routes"]["B"][1]) == 5
    assert world["routes"]["B"][4][6] == [["CUS-1", "CORRECTION: customer CUS-1 is now standard."]]
    back = steps.expand(packed)

    def by(rows, *keys):
        return sorted(rows, key=lambda r: [r[k] for k in keys])

    assert by(back["items"], "key") == by(run["items"], "key")
    assert by(back["refers"], "a", "b") == by(run["refers"], "a", "b")
    assert by(back["routes"], "attempt") == by(run["routes"], "attempt")
    assert steps.expand(packed, only=set()) == {"run_id": "r1", "self": False, "items": [], "refers": [], "routes": []}


def test_loading_steps_twice_changes_nothing_and_marks_the_run(small):
    folder, store, first = small
    count = "MATCH (n) RETURN labels(n)[0] AS kind, count(*) AS n ORDER BY kind"
    links = "MATCH ()-[r]->() RETURN type(r) AS kind, count(*) AS n ORDER BY kind"
    before = cli.rows(store, count), cli.rows(store, links)
    again = load.load_steps(folder / "runs", store)
    assert (cli.rows(store, count), cli.rows(store, links)) == before
    assert first == again == {"runs": 1, "steps": 17, "items": 5}
    made = {r["kind"]: r["n"] for r in before[1]}
    assert made["TOOK"] == 17 and made["NEXT"] == 15 and made["REFERS_TO"] == 4 and made["TOLD_OF"] == 1
    assert routes.holds_steps(store) and routes.ensure(store) == store
    # steps loaded by other code than this checkout's are not "the steps": the store is rebuilt, never trusted
    with relate.connect(store) as conn:
        conn.execute("MATCH (r:Run) SET r.steps_loader = 'an older loader'")
    assert not routes.holds_steps(store)
    load.load_steps(folder / "runs", store)
    assert routes.holds_steps(store)


def test_each_pattern_finds_what_the_model_did(small):
    _, store, _ = small
    with routes.opened(store) as ask:
        found = {name: {m["model"]: m for m in routes.check(ask, name, EVERYTHING)} for name in routes.CHECKS}
        needs = routes.what_decisions_need(ask, VERSION)
    assert needs == [
        {"decided": "refund request", "needs": "order", "via": ["order_id"]},
        {"decided": "refund request", "needs": "customer", "via": ["order_id", "customer_id"]},
    ]
    careful = {name: found[name]["p:alpha"]["times"] for name in found}
    hasty = {name: found[name]["q:beta"]["times"] for name in found}
    assert set(careful.values()) == {0}
    assert hasty == {
        "decided-before-seeing": 1,  # REQ-1, decided at step 3; the customer was first seen at step 5
        "decided-never-saw": 0,  # ... which is why a count of records never seen misses it
        "decided-unknown-record": 0,
        "retried-without-checking": 1,
        "told-then-decided": 1,
    }
    row = found["decided-before-seeing"]["q:beta"]
    assert (row["attempts"], row["attempts_with"], row["right_with"], row["passed_with"]) == (1, 1, 1, 1)
    # kept to one kind of record: the order was seen in time, the customer was not
    with routes.opened(store) as ask:
        by_kind = {
            kind: {m["model"]: m["times"] for m in routes.check(ask, "decided-before-seeing", EVERYTHING, [kind])}
            for kind in ("order", "customer")
        }
    assert by_kind == {"order": {"p:alpha": 0, "q:beta": 0}, "customer": {"p:alpha": 0, "q:beta": 1}}


def test_the_same_world_item_by_item(small):
    _, store, _ = small
    with routes.opened(store) as ask:
        (world,) = routes.same_world(ask, ["r1/x/1"])
    assert world["models"] == {"A": "p:alpha", "B": "q:beta"}
    assert world["decided_differently"] == [] and world["decided_unseen"] == {"A": 0, "B": 1}
    first = world["items"][0]
    assert first["item"] == "REQ-1" and first["sides"]["B"]["unseen"] == ["CUS-1"]
    assert first["sides"]["A"]["decision"] == "deny_request" and first["sides"]["A"]["step"] == 4
    # the last action on an item is its decision: REQ-2 was refunded at step 8 after a timeout at step 6
    assert world["items"][1]["sides"]["A"]["step"] == 8


def test_a_readers_own_check_is_judged_at_the_level_the_reader_gives_it(small):
    _, store, _ = small

    def fit(level):
        checks = {"store": store, "levels": {"decided-before-seeing": level}, "kinds": None}
        return cli.fitness(store, "t/x", VERSION, None, None, "personal", checks=checks)["q:beta"]

    name = "decided before seeing a record it depends on (your check)"
    minor, unforgivable = fit("minor"), fit("unforgivable")
    assert [(f["fault"], f["level"], f["breaks"]) for f in minor["faults"]] == [(name, "minor", False)]
    assert [(f["fault"], f["level"], f["breaks"]) for f in unforgivable["faults"]] == [(name, "unforgivable", True)]
    assert unforgivable["reasons"] == [f"{name} (unforgivable) in 1 of 1 attempts"]
    # without the check nothing about the model's faults changes
    assert cli.fitness(store, "t/x", VERSION, None, None, "personal")["q:beta"]["faults"] == []


def test_an_assistant_can_ask_how_they_worked(small):
    """The MCP tools give the command line's answers, and free Cypher can walk a route when `steps` is set."""
    _, store, _ = small
    server = assistant.build(store)
    worked = call(server, "how_they_worked", {"task": "t/x", "question": "decided-before-seeing"}).structured_content
    (found,) = worked["checks"]
    assert {m["model"]: m["times"] for m in found["models"]} == {"p:alpha": 0, "q:beta": 1}
    assert "REFERS_TO" in found["cypher"] and worked["decisions_need"][0]["needs"] == "order"
    assert "error" in call(server, "how_they_worked", {"task": "t/x", "question": "no-such"}).structured_content

    side_by_side = {"task": "t/x", "model_a": "p:alpha", "model_b": "q:beta", "scenario": 1}
    world = call(server, "same_world", side_by_side).structured_content["scenarios"][0]
    assert world["decided_unseen"] == {"A": 0, "B": 1} and world["side"] == {"p:alpha": "A", "q:beta": "B"}

    judged = {
        "task": "t/x",
        "model_a": "p:alpha",
        "model_b": "q:beta",
        "own_checks": {"decided-before-seeing": "unforgivable"},
    }
    fit = call(server, "verdict", judged).structured_content["fit"]
    assert fit["q:beta"]["faults"][0]["breaks"] and fit["p:alpha"]["faults"][0]["attempts_with"] == 0

    # its own pattern over the route: what did the hasty model do between the timeout and the end?
    walk = (
        "MATCH (:Attempt {key: 'r1/x/1/B'})-[:TOOK]->(s:Step {state: 'timeout'}) "
        "MATCH (s)-[:NEXT]->+(later:Step) RETURN later.tool AS tool ORDER BY later.n"
    )
    asked = call(server, "read_graph", {"cypher": walk, "steps": True}).structured_content
    assert [r["tool"] for r in asked["rows"]] == ["issue_refund", "finish"]
    named = {"named_question": "what_decisions_need", "parameters": {"version_key": VERSION}}
    assert len(call(server, "read_graph", named).structured_content["rows"]) == 2
    assert "steps:decided-before-seeing" in call(server, "describe_graph", {}).structured_content["step_questions"]


def test_a_store_without_steps_says_so(tmp_path):
    write_record(tmp_path / "runs", "r1", [with_turns(CAREFUL)], [with_turns(HASTY)])
    store = str(tmp_path / "s.rl")
    load.load(tmp_path / "runs", store)
    assert not routes.holds_steps(store) and not routes.holds_steps(str(tmp_path / "missing.rl"))


# ---- the shipped records ---------------------------------------------------------------------------------------

# The moment the README's figures are read at (--until 2026-11-26T05:00): fixed, however many races are imported.
UNTIL = cli.parse_until("2026-11-26T05:00")
# What a decision must have read, per test, as each test's own public package states it (`task.joins` in its
# workflow.yaml in gladiator-core). The grader's "acted without reading" asks for exactly these.
GRADER_NEEDS = {
    "gladiator/refund-queue": ["order", "customer"],
    "gladiator/access-review": ["employee"],
    "gladiator/incident-triage": ["service"],
    "gladiator/inventory-transfer": ["customer"],
}
PER_ATTEMPT = """
MATCH (tv:TestVersion {{test_id: $test}})<-[:USED]-(mt:Match)-[:PART_OF]->(r:Run), (mt)<-[:IN]-(a:Attempt)
WHERE r.started_unix <= $until
{found}
WITH a, count(DISTINCT x) AS found
OPTIONAL MATCH (a)-[made:MADE]->(:Fault {{name: $fault}})
RETURN a.key AS attempt, found, coalesce(made.count, 0) AS graded
"""


@pytest.fixture(scope="module")
def shipped():
    if not STORE.exists():
        pytest.skip("no shipped store in this checkout")
    # the local store beside the shipped one, built from the records when it is missing, behind the records on
    # file, or was loaded by other code than this checkout's (the same store the commands and the page export use)
    store = routes.ensure(str(STORE), DATA)
    assert store != str(STORE) and routes.holds_steps(store, DATA)
    loaded = cli.rows(store, "MATCH (r:Run) RETURN count(r) AS runs, sum(r.steps) AS steps")[0]
    assert loaded["runs"] == len(routes.record_ids(DATA)) and loaded["steps"] > 60000
    return store


def per_attempt(conn, pattern, test, fault, kinds=None):
    query = PER_ATTEMPT.format(found=questions.STEP_PATTERNS[pattern])
    params = {"test": test, "until": UNTIL, "fault": fault, "kinds": kinds}
    return {r["attempt"]: (r["found"], r["graded"]) for r in conn.execute(query, params)}


def test_the_graph_counts_what_the_grader_counted_attempt_by_attempt(shipped):
    """Two things both the grader and the graph can count. The grader counted them while the match was played, from
    inside the simulated world; the graph counts them afterwards from the steps in the public record alone."""
    attempts = with_fault = 0
    with relate.connect(shipped, read_only=True) as conn:
        for test, kinds in GRADER_NEEDS.items():
            # "acted without reading": a decided item with a needed record never seen, or one that names no record
            never = per_attempt(conn, "decided-never-saw", test, "acted without reading", kinds)
            unknown = per_attempt(conn, "decided-unknown-record", test, "acted without reading")
            assert set(never) == set(unknown) and never
            differ = {a: (never[a][0] + unknown[a][0], never[a][1]) for a in never}
            assert {a: v for a, v in differ.items() if v[0] != v[1]} == {}
            attempts += len(never)
            with_fault += sum(1 for found, graded in differ.values() if graded)
            # "retried without checking", walked forward along the route from the action that timed out
            retried = per_attempt(
                conn, "retried-without-checking", test, "ambiguous timeout (retried without checking)"
            )
            assert {a: v for a, v in retried.items() if v[0] != v[1]} == {}
    # every attempt of the four workflows on file at that moment, and the fault is common enough to be a real test
    assert attempts == 1874 and with_fault == 182


def test_the_sharper_question_finds_what_the_grader_passed(shipped):
    """Decided before seeing is asked in order; the grader's rule is not. On the refund queue the figures the
    README prints, read at the moment it names."""
    scope = cli.step_scope(str(STORE), "refund-queue", HAIKU, DEEPSEEK, until=UNTIL)
    with routes.opened(shipped) as ask:
        found = routes.process(ask, "gladiator/refund-queue", scope, ["decided-before-seeing", "decided-never-saw"])
    before, never = ({m["model"]: m for m in c["models"]} for c in found["checks"])
    # every model: whatever was never seen was, before the decision, not seen
    assert all(before[m]["attempts_with"] >= never[m]["attempts_with"] for m in before) and len(before) >= 2
    assert all(never[m]["attempts_with"] == (never[m]["grader_attempts_with"] or 0) for m in never)
    assert all(never[m]["passed_with"] == 0 for m in never)  # the test never passes what its grader counted
    haiku, deepseek = before[HAIKU], before[DEEPSEEK]
    assert (haiku["attempts"], haiku["attempts_with"], haiku["right_with"], haiku["passed_with"]) == (81, 18, 18, 6)
    assert (deepseek["attempts"], deepseek["attempts_with"], deepseek["right_with"]) == (95, 77, 77)
    assert (deepseek["times"], deepseek["passed_with"]) == (241, 12)
    assert (never[HAIKU]["attempts_with"], never[DEEPSEEK]["attempts_with"]) == (12, 65)
    assert found["decisions_need"] == [
        {"decided": "refund request", "needs": "order", "via": ["order_id"]},
        {"decided": "refund request", "needs": "customer", "via": ["order_id", "customer_id"]},
    ]


HAIKU, DEEPSEEK = "anthropic:claude-haiku-5-5", "openrouter:deepseek/deepseek-v4.1-flash-1017"


def test_a_readers_check_can_change_who_is_fit_and_only_when_asked(shipped):
    plain = cli.verdict(str(STORE), "refund-queue", HAIKU, DEEPSEEK, profile="personal", until=UNTIL)
    assert plain["outcome"] == "use" and plain["use"] == HAIKU and "own_checks" not in plain

    def with_check(level):
        checks = {"store": shipped, "levels": {"decided-before-seeing": level}, "kinds": None}
        return cli.verdict(str(STORE), "refund-queue", HAIKU, DEEPSEEK, profile="personal", until=UNTIL, checks=checks)

    serious, minor = with_check("serious"), with_check("minor")
    assert serious["outcome"] == "neither fit" and minor["outcome"] == "use"
    reason = "decided before seeing a record it depends on (your check) (serious) in 77 of 95 attempts"
    assert serious["fit"][DEEPSEEK]["reasons"] == [reason + ", over the 10% allowed"]
    # the head to head is the same pairs judged the same way, whatever the reader asks about the process
    for v in (serious, minor):
        assert (v["wins"], v["pairs"], v["verdict"]) == (plain["wins"], plain["pairs"], plain["verdict"])


def test_two_routes_through_one_world(shipped):
    found = cli.route(str(STORE), shipped, "refund-queue", HAIKU, DEEPSEEK, scenario=2, until=UNTIL)
    (world,) = found["scenarios"]
    assert found["pairs"] == 43 and world["scenario"] == 2 and world["winner"] == HAIKU
    side = world["side"]
    assert len(world["items"]) == 12 and world["decided_differently"] == ["REQ-0002"]
    assert (world["decided_unseen"][side[HAIKU]], world["decided_unseen"][side[DEEPSEEK]]) == (0, 4)
    # every scenario in a line: the same pairs the verdict counts, in the same order
    every = cli.route(str(STORE), shipped, "refund-queue", HAIKU, DEEPSEEK, until=UNTIL)
    assert [w["scenario"] for w in every["scenarios"]] == list(range(1, 44))
    assert all("items" not in w for w in every["scenarios"])
    assert cli.route(str(STORE), shipped, "refund-queue", HAIKU, DEEPSEEK, scenario=99, until=UNTIL)["note"]
