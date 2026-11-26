"""The steps of every attempt, and the records of the world those steps touched.

The gladiator bridge (ledger/bridges/gladiator.py) reads how an attempt ended. This one reads how it got there. A
sealed record keeps every step of every attempt: the tool the model called, its arguments and what the simulated
world answered. From that this module hands the loader (ledger/load.py) three kinds of row:

  steps   each attempt's steps in order: the tool, its kind (read, check, act, end, talk) and how the world
          answered (ok, timeout, refused)
  items   the records of the generated world that some step saw, decided or checked: a refund request, its
          order, the order's customer. Both attempts of a pair played the same world, so they share its items.
  refers  how those records point at each other, exactly as the world's answers show it: a request names its
          order (`order_id`), the order names its customer (`customer_id`)

Everything comes from the public record: what the models were shown and what they did. Nothing is read from the
answer key, and nothing here knows any one test. A field refers to another record when its name ends in `_id`, or
when a lookup tool takes an argument of that name (`stock_for_sku(sku)` makes an order's `sku` a reference).
"""

import json
import re
from pathlib import Path

from ledger.bridges import gladiator
from ledger.replay import ACT, CHECK, READ, item_of, step_kind

OK, TIMEOUT, REFUSED = "ok", "timeout", "refused"
LOOKUPS = ("get_", "stock_for_", "find_", "lookup_", "search_")
# Which source names an item's kind best: the tool that looks it up, the list that shows it, the field that
# refers to it, the argument an action names it by.
BY_LOOKUP, BY_LIST, BY_FIELD, BY_ARGUMENT = 3, 2, 1, 0
ID_IN_TEXT = re.compile(r"\b[A-Z][A-Z0-9]*-[A-Z0-9]+\b")


def _words(name: str) -> str:
    return name.replace("_", " ").strip()


def _singular(name: str) -> str:
    return name[:-1] if name.endswith("s") and not name.endswith("ss") else name


def kind_of_tool(tool: str) -> tuple[int, str] | None:
    """The kind of record a reading tool shows, from its name: get_order -> order, list_refund_requests ->
    refund request, stock_for_sku -> sku."""
    for prefix in LOOKUPS:
        if tool.startswith(prefix):
            return BY_LOOKUP, _words(tool[len(prefix) :])
    if tool.startswith("list_"):
        return BY_LIST, _singular(_words(tool[len("list_") :]))
    return None


def kind_of_field(field: str) -> str:
    return _words(field.removesuffix("_id"))


def _family(item_id: str) -> str:
    """REQ-0007 -> REQ: the ids of one kind of record share what stands before the dash."""
    return item_id.split("-", 1)[0] if "-" in item_id else item_id


def _shown_rows(observation) -> list[dict]:
    """The records an answer shows: the rows of a list, or the one record a lookup returned."""
    if not isinstance(observation, dict):
        return []
    if isinstance(observation.get("items"), list):
        return [r for r in observation["items"] if isinstance(r, dict)]
    return [observation]


def _state(observation) -> str:
    error = observation.get("error") if isinstance(observation, dict) else None
    return TIMEOUT if error == "timeout" else REFUSED if error else OK


def _lookup_arguments(results: list[dict]) -> set[str]:
    """The argument names lookup tools were called with, other than a bare `id`: a field of that name refers to
    something a model can look up."""
    names = set()
    for res in results:
        for turn in res.get("turns") or []:
            tool, args = turn.get("tool_name") or "", turn.get("tool_args")
            if tool.startswith(LOOKUPS) and isinstance(args, dict):
                names.update(k for k in args if k != "id" and not k.endswith("_id"))
    return names


def world_rows(world: str, sides: list[tuple[str, dict]], lookup_fields: set[str]) -> dict:
    """One generated world and the attempts played on it. `sides` is [(attempt key, result)]. Returns the world's
    items (each with the best hint of its kind seen here), how they refer to each other, and each attempt's
    steps."""
    hints: dict[str, tuple[int, str]] = {}  # item id -> (how sure, kind)
    refers: dict[tuple[str, str], str] = {}  # (from id, to id) -> field
    routes = []

    def note(item_id, how: int, kind: str) -> str:
        item_id = str(item_id)
        if item_id not in hints or how > hints[item_id][0]:
            hints[item_id] = (how, kind)
        return item_id

    for attempt, res in sides:
        steps, clock = [], 0.0
        for n, turn in enumerate(res.get("turns") or [], 1):
            tool = turn.get("tool_name") or ""
            kind = step_kind(tool or None)
            args = turn.get("tool_args") if isinstance(turn.get("tool_args"), dict) else {}
            observation = turn.get("observation")
            state = _state(observation)
            clock += float(turn.get("call_s") or 0)
            named = item_of(args)
            saw, decided, checked = [], [], []
            if kind == READ and state == OK:
                shows = kind_of_tool(tool)
                if named and not tool.startswith("list_") and shows:
                    saw.append(note(named, *shows))
                for row in _shown_rows(observation):
                    if row.get("id") is None:
                        continue
                    row_id = note(row["id"], *(shows or (BY_FIELD, "record")))
                    if row_id not in saw:
                        saw.append(row_id)
                    for field, value in row.items():
                        if isinstance(value, str) and (field.endswith("_id") or field in lookup_fields):
                            refers[(row_id, note(value, BY_FIELD, kind_of_field(field)))] = field
            elif kind in (ACT, CHECK) and named:
                argument = next((k for k in args if str(args[k]) == named), "")
                target = note(named, BY_ARGUMENT, kind_of_field(argument))
                (decided if kind == ACT else checked).append(target)
            notices = observation.get("notices") if isinstance(observation, dict) else None
            steps.append(
                {
                    "key": f"{attempt}/{n}",
                    "n": n,
                    "tool": tool,
                    "kind": kind,
                    "state": state,
                    "at_s": round(clock, 3),
                    "item": None if kind == READ and tool.startswith("list_") else named,
                    "saw": saw,
                    "decided": decided,
                    "checked": checked,
                    "notices": [str(x) for x in notices] if isinstance(notices, list) else [],
                }
            )
        routes.append({"attempt": attempt, "steps": steps})
    return {"world": world, "hints": hints, "refers": refers, "routes": routes}


def run_steps(body: dict) -> dict:
    """Every world of one run record, as rows for the loader. Matches and self runs keep their own labels in the
    graph (Match and Attempt, SelfCheck and SelfAttempt), so `self` says which this run is."""
    run_id, sides = body["run_id"], body["contestants"]
    by_key = {side: {(r["node"], r.get("attempt", 1)): r for r in sides[side]["results"]} for side in ("A", "B")}
    lookup_fields: dict[str, set[str]] = {}
    for side in ("A", "B"):
        for (node, _), res in by_key[side].items():
            lookup_fields.setdefault(node, set()).update(_lookup_arguments([res]))
    worlds = []
    for node, attempt in by_key["A"]:
        if (node, attempt) not in by_key["B"]:
            continue  # the same pairs the gladiator bridge loads: a step needs its attempt in the graph
        key = f"{run_id}/{node}/{attempt}"
        pair = [(f"{key}/{side}", by_key[side][(node, attempt)]) for side in ("A", "B")]
        worlds.append((node, world_rows(key, pair, lookup_fields[node])))
    # One kind per family of ids in a test, taken from the best hint anywhere in the run, so a customer nobody
    # looked up in one world is still called a customer there.
    families: dict[tuple[str, str], tuple[int, str]] = {}
    for node, w in worlds:
        for item_id, hint in w["hints"].items():
            family = (node, _family(item_id))
            if family not in families or hint[0] > families[family][0]:
                families[family] = hint
    items, refers, routes = [], [], []
    for node, w in worlds:
        world = w["world"]
        known = set(w["hints"])
        for route in w["routes"]:
            for step in route["steps"]:
                told = []
                for notice in step.pop("notices"):
                    for item_id in dict.fromkeys(ID_IN_TEXT.findall(notice)):
                        # a notice names a record of this world: one already met, or one of a kind met here
                        if item_id in known or (node, _family(item_id)) in families:
                            known.add(item_id)
                            told.append({"item": f"{world}/{item_id}", "notice": notice})
                step["told"] = told
                for field in ("saw", "decided", "checked"):
                    step[field] = [f"{world}/{item_id}" for item_id in step[field]]
            routes.append(route)
        for item_id in sorted(known):
            kind = families.get((node, _family(item_id)), w["hints"].get(item_id, (0, "record")))[1]
            items.append({"key": f"{world}/{item_id}", "id": item_id, "kind": kind or "record", "world": world})
        refers += [
            {"a": f"{world}/{a}", "b": f"{world}/{b}", "field": field} for (a, b), field in sorted(w["refers"].items())
        ]
    return {
        "run_id": run_id,
        "self": sides["A"]["id"] == sides["B"]["id"],
        "items": items,
        "refers": refers,
        "routes": routes,
    }


def read_steps(root: Path):
    """Yields one run's steps at a time (a record is large, and the loader writes run by run). A record whose seal
    does not match is passed over, exactly as the gladiator bridge does."""
    for path in gladiator.find_records(root):
        record = json.loads(path.read_text(encoding="utf-8"))
        if gladiator.seal_ok(record):
            yield run_steps(record["body"])
