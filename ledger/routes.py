"""Routes: how a model got to its result, asked of the steps in the graph.

A verdict says how an attempt ended. The steps say how it got there, and with them in the graph a question about
how a model works is a pattern (ledger/questions.py, STEP_PATTERNS) that can be asked of every attempt on file,
at no cost and without playing a match:

  - Did it decide a refund before it had seen the customer the order belongs to?
  - After an action timed out, did it act again without checking whether the first had gone through?
  - On the same world, where did the two models part ways?

Two of the patterns ask what Gladiator's own grader counts, and the graph agrees with the grader attempt by attempt
(tests/test_steps.py). The others ask what no grader counted when the matches were played.

The steps are seven times the size of everything else, so the shipped store (data/ledger.rl) does not carry them.
They are loaded from the same sealed records into a second, local store beside it (data/ledger-steps.rl, about
75 MB, never committed) the first time a question needs them, which takes about a minute.
"""

import sys
from contextlib import contextmanager
from pathlib import Path

import relate

from ledger import load, questions

STEPS_STORE = "ledger-steps.rl"

# What each pattern asks, in words. `fault` is the name it goes by when a reader gives it a level in a verdict.
# `grader` names the fault Gladiator's grader counts for the same thing, where it counts one. `kinds` says the
# question can be kept to some kinds of record (--needs customer).
CHECKS = {
    "decided-before-seeing": {
        "asks": "Decided an item before it had seen a record that item depends on.",
        "fault": "decided before seeing a record it depends on",
        "grader": None,
        "kinds": True,
        "note": "The grader's 'acted without reading' counts only records never seen in the whole attempt, so a "
        "record looked up after the decision (for another item, say) passes there and is counted here.",
    },
    "decided-never-saw": {
        "asks": "Decided an item without seeing, at any point, a record that item depends on.",
        "fault": "decided without ever seeing a record it depends on",
        "grader": "acted without reading",
        "kinds": True,
        "note": "",
    },
    "decided-unknown-record": {
        "asks": "Acted on an id that names no record the world ever showed.",
        "fault": "acted on a record that does not exist",
        "grader": None,
        "kinds": False,
        "note": "",
    },
    "retried-without-checking": {
        "asks": "After an action timed out, acted on the same item again without checking whether it had gone through.",
        "fault": "retried without checking",
        "grader": "ambiguous timeout (retried without checking)",
        "kinds": False,
        "note": "",
    },
    "told-then-decided": {
        "asks": "Was told a record had changed, then decided an item that depends on it without reading it again.",
        "fault": "decided on a changed record without reading it again",
        "grader": None,
        "kinds": True,
        "note": "Not a fault in itself: the notice says what changed. Whether to trust a notice is the reader's call.",
    },
}


def _rows(store: str, query: str, params: dict | None = None) -> list[dict]:
    with relate.connect(store, read_only=True) as conn:
        return [dict(r) for r in conn.execute(query, params or {})]


@contextmanager
def opened(store: str):
    """A store opened once, read-only, for several questions (a store with steps takes about a second to open).
    Yields `ask(query, params) -> rows`, which is what the functions below take."""
    with relate.connect(store, read_only=True) as conn:
        yield lambda query, params=None: [dict(r) for r in conn.execute(query, params or {})]


def record_ids(data: Path) -> list[str]:
    return sorted(p.parent.name for p in (Path(data) / "records").rglob("record.json"))


def holds_steps(store: str, data: Path | None = None) -> bool:
    """Does this store hold the steps of every run it knows (and, given the data folder, of every record on
    file)? A run's steps are complete when the loader has marked it (Run.steps)."""
    if not Path(store).exists():
        return False
    try:
        runs = _rows(store, "MATCH (r:Run) RETURN r.run_id AS id, r.steps IS NOT NULL AS loaded")
    except relate.Error:
        return False
    if not runs or not all(r["loaded"] for r in runs):
        return False
    return data is None or sorted(r["id"] for r in runs) == record_ids(data)


def ensure(store: str, data: Path | None = None, say=None) -> str:
    """The store to ask about steps. `store` itself when it already holds them; otherwise the local store beside
    it, built from the sealed records under `data` (the folder the store is in, unless given) when it is missing
    or the records on file have changed."""
    if holds_steps(store):
        return store
    data = Path(data) if data else Path(store).parent
    beside = str(Path(store).with_name(STEPS_STORE))
    if holds_steps(beside, data):
        return beside
    say = say or (lambda text: print(text, file=sys.stderr, flush=True))
    say(f"Loading every step of {len(record_ids(data))} sealed records into {beside} (once, about a minute) ...")
    Path(beside).unlink(missing_ok=True)
    build(beside, data)
    return beside


def build(store: str, data: Path) -> dict:
    """The whole graph with every step, from the records, validation records and published scores under `data`."""
    out = {"records": load.load(data / "records", store)}
    load.link_forks(store)
    if (data / "validations").exists():
        out["validations"] = load.load_validations(data / "validations", store)
    if (data / "epoch").exists():
        out["scores"] = load.load_scores(data / "epoch", store)
    out["steps"] = load.load_steps(data / "records", store)
    return out


def what_decisions_need(ask, version_key: str) -> list[dict]:
    """What a decision on this task depends on, as the worlds on file show it: [{decided, needs, via}]."""
    seen, out = set(), []
    for r in ask(questions.WHAT_DECISIONS_NEED, {"version_key": version_key}):
        if (r["decided"], r["needs"]) not in seen:
            seen.add((r["decided"], r["needs"]))
            out.append({"decided": r["decided"], "needs": r["needs"], "via": list(r["via"])})
    return out


def check(ask, name: str, scope: dict, kinds: list[str] | None = None) -> list[dict]:
    """One process question, per model, in a scope (version_key, conditions, suite, until: the scope of fitness).
    Self runs count like any other attempt of that model, as they do in its fitness. Each row: attempts, the
    attempts where the pattern was found (attempts_with), how often in all (times), and of the attempts with it
    how many still got every decision right (right_with) and how many the test passed (passed_with)."""
    params = {**scope, "kinds": kinds or None}
    query = questions.STEP_CHECKS[name]
    found = {r["model"]: r for r in ask(query, params)}
    for extra in ask(questions.for_self_runs(query), params):
        mine = found.get(extra["model"])
        if mine is None:
            continue  # as in fitness: a model with no match on this task has no row to add to
        for key in ("attempts", "times", "attempts_with", "right_with", "passed_with"):
            mine[key] += extra[key]
    return [found[model] for model in sorted(found)]


def process(ask, test: str, scope: dict, names: list[str] | None = None, kinds: list[str] | None = None) -> dict:
    """Every process question (or the ones named) for one task: what a decision there depends on, and each
    question's count per model beside the grader's own count where the grader has one."""
    graded: dict[tuple[str, str], int] = {}
    for f in ask(questions.TASK_FAULTS, scope) + ask(questions.SELF_FAULTS, scope):
        graded[(f["model"], f["fault"])] = graded.get((f["model"], f["fault"]), 0) + f["attempts_with"]
    checks = []
    for name in names or list(CHECKS):
        about = CHECKS[name]
        models = check(ask, name, scope, kinds if about["kinds"] else None)
        for m in models:
            m["grader_attempts_with"] = graded.get((m["model"], about["grader"])) if about["grader"] else None
        checks.append(
            {
                "check": name,
                "asks": about["asks"],
                "note": about["note"],
                "grader_counts": about["grader"],
                "needs": (kinds or None) if about["kinds"] else None,
                "models": models,
                "cypher": questions.STEP_CHECKS[name].strip(),
            }
        )
    return {
        "task": test,
        "version": scope["version_key"],
        "conditions": scope["conditions"],
        "suite": scope.get("suite"),
        "until": scope.get("until"),
        "decisions_need": what_decisions_need(ask, scope["version_key"]),
        "checks": checks,
    }


def as_faults(ask, scope: dict, levels: dict[str, str], kinds: list[str] | None = None) -> dict:
    """A reader's own checks as fault rows for fitness (ledger/policy.py): {model: [fault row]} and the level
    each fault was given. `levels` is {check name: level}. A check the reader adds is judged exactly like a
    fault the grader counted: by the level the reader gives it."""
    rows: dict[str, list[dict]] = {}
    overrides = {}
    for name, level in levels.items():
        about = CHECKS[name]
        fault = f"{about['fault']} (your check)"
        overrides[fault] = level
        for m in check(ask, name, scope, kinds if about["kinds"] else None):
            rows.setdefault(m["model"], []).append(
                {
                    "fault": fault,
                    "kind": "check",
                    "kind_of": None,
                    "attempts_with": m["attempts_with"],
                    "times": m["times"],
                }
            )
    return {"faults": rows, "levels": overrides}


def same_world(ask, matches: list[str]) -> list[dict]:
    """Scenarios, item by item: the two models on the same world. For each item, what each decided and which of
    the records it depends on each had seen by then. Per scenario: `decided_differently` lists the items where
    the two chose differently, `decided_unseen` counts, per model, the items decided before a needed record
    was seen."""
    worlds: dict[str, dict] = {}
    for r in ask(questions.SAME_WORLD, {"matches": list(matches)}):
        world = worlds.setdefault(r["match"], {"match": r["match"], "models": {}, "items": {}})
        world["models"][r["side"]] = r["model"]
        item = world["items"].setdefault(r["item"], {"item": r["item"], "kind": r["kind"], "sides": {}})
        needs = [dict(n) for n in r["needs"] if n is not None]
        item["sides"][r["side"]] = {
            "model": r["model"],
            "decision": r["decision"],
            "step": r["step"],
            "state": r["state"],
            "needs": needs,
            "unseen": [n["record"] for n in needs if n["seen"] is False],
        }
    out = []
    for key in matches:
        world = worlds.get(key)
        if world is None:
            continue
        items = list(world["items"].values())
        for item in items:
            item["differ"] = len({s["decision"] for s in item["sides"].values()}) > 1
        world["items"] = items
        world["decided_differently"] = [i["item"] for i in items if i["differ"]]
        world["decided_unseen"] = {
            side: sum(1 for i in items if i["sides"].get(side, {}).get("unseen")) for side in sorted(world["models"])
        }
        out.append(world)
    return out
