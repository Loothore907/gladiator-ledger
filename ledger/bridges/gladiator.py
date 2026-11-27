"""The Gladiator bridge: reads Gladiator's sealed public records and turns them into evidence rows.

Sources (both sealed with a SHA-256 over the body; a file whose seal does not match is skipped):
  runs/<run_id>/record.json   a match between two models (Gladiator's run-record format, docs/RUN_RECORD.md in
                              the Gladiator repository). Each pair of attempts is re-judged here with Gladiator's
                              own rule (ledger/scoring.py).
  validations/**/*.json       the evidence that a test version passed automatic validation.
The graph is built from these public files only. The private half of a match (operator.json: the answer key of
each generated world) is published beside its record once the match is over (ledger/publish.py) so anyone can
check a result, but it is not loaded into the graph.
"""

import hashlib
import json
from pathlib import Path

from ledger import costs, scoring
from ledger.bridges import Evidence

NAME = "gladiator"
DESCRIPTION = "Head-to-head matches and test validation records from the Gladiator engine"

# Attempts that ended for reasons outside the model's control: kept in the graph, never judged.
EXCLUDED = {"budget_stop", "provider_error", "not_run"}

# Grader counters that mean "the model fell for this hazard". A counter present in an attempt's grade details
# means the test version can generate that hazard; a count above zero means the model tripped on it.
HAZARDS = {
    "blind_retries_after_unknown_outcome": "ambiguous timeout (retried without checking)",
    "duplicate_effects": "duplicate effect",
    "injections_obeyed": "planted instruction",
    "acted_without_reading": "acted without reading",
    "conflicting": "conflicting records",
    "wrong_amounts": "wrong amount",
}

# Faults: everything a grader can say a model did wrong on an attempt. A hazard a model fell for is one kind of
# fault; a wrong decision, work left undone and an attempt that ended before the model finished are others.
# A counter present in the grade details means the test version can show that fault.
DECISION_FAULTS = {
    "wrong": "wrong decision",
    "wrong_args": "right decision, wrong details",
    "missing": "left undone",
}
ENDING_FAULTS = {
    "no_action": "stopped before finishing",
    "action_limit": "ran out of allowed actions",
}
WRONG_DECISION = "wrong decision"


def fault_rows(res: dict, test_id: str) -> list[dict]:
    """The faults one attempt could show and how often it showed each (count 0 = could, did not).

    kind: `trap` (fell for a hazard the test planted), `decision` (the outcome it gave an item), `mix-up` (one
    specific wrong decision of this test, e.g. should close, did escalate; a kind of `wrong decision`) and
    `ending` (how the attempt stopped). Mix-ups belong to one test, so their key carries the test id."""
    details = res.get("grade_details") or {}
    rows = []

    def add(key, name, kind, count, test_id=None, kind_of=None, hazard=None):
        rows.append(
            {
                "key": key,
                "name": name,
                "kind": kind,
                "count": int(count or 0),
                "test_id": test_id,
                "kind_of": kind_of,
                "hazard": hazard,
            }
        )

    for counter, name in HAZARDS.items():
        if counter in details:
            add(name, name, "trap", details[counter], hazard=name)
    for counter, name in DECISION_FAULTS.items():
        if counter in details:
            add(name, name, "decision", details[counter])
    for pair, count in sorted((details.get("confusions") or {}).items()):
        want, _, got = pair.partition("->")
        add(f"{test_id}: {pair}", f"should {want}, did {got}", "mix-up", count, test_id=test_id, kind_of=WRONG_DECISION)
    for termination, name in ENDING_FAULTS.items():
        add(name, name, "ending", res.get("termination") == termination)
    return rows


# Corner-cutting validation players that stand for a hazard models trip on (see HAZARDS).
PLAYER_HAZARDS = {
    "blind_retry": "ambiguous timeout (retried without checking)",
    "obeys_injections": "planted instruction",
    "no_reading": "acted without reading",
}


def canonical_sha256(value) -> str:
    """Gladiator's seal: SHA-256 over the value as canonical JSON (sorted keys, no spaces)."""
    canonical = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False, default=str
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def seal_ok(record: dict) -> bool:
    return canonical_sha256(record.get("body")) == record.get("sha256")


def fresh_worlds_only(record: dict) -> bool:
    """True when every test in the match generates a fresh world per attempt (so its answers are spent)."""
    kinds = {
        (res.get("challenge") or {}).get("instances")
        for side in record["body"]["contestants"].values()
        for res in side["results"]
    }
    return kinds == {"generator"}


def private_half_matches(record: dict, private_path: Path) -> bool:
    try:
        private = json.loads(Path(private_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return canonical_sha256(private) == record["body"].get("operator_sha256")


def answer_key_beside(record_path: Path, record: dict) -> bool:
    """True when the record's answer key (its private half, `operator.json`) is published beside it: the file is
    there, the match was played on fresh worlds only (the one kind whose answers are ever published) and the file
    matches the fingerprint the sealed record carries. This is all the graph knows of an answer key: whether a
    reader can check the match with it. Nothing inside it is read into the graph."""
    private = Path(record_path).with_name("operator.json")
    return private.is_file() and fresh_worlds_only(record) and private_half_matches(record, private)


def version_rank(version) -> int:
    """2.10.1 -> 2010001, so versions compare as numbers in Cypher."""
    parts = [int(x) if x.isdigit() else 0 for x in str(version).split(".")[:3]] + [0, 0, 0]
    return parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2]


def version_key(challenge: dict) -> str:
    return f"{challenge['id']}@{challenge['version']}:{(challenge.get('content_sha256') or '')[:12]}"


def effort_for(settings: dict, side: str):
    effort = (settings.get("defaults") or {}).get("effort")
    effort = (settings.get("overrides") or {}).get("effort", effort)
    return ((settings.get("per_contestant") or {}).get(side) or {}).get("effort", effort)


def conditions_of(settings: dict, node: str, difficulty, profile: str, sides: dict) -> str:
    """The conditions one pair was played and judged under, as a single string that is equal exactly when two pairs
    are comparable: every setting the engine applied to this test (the suite's defaults, the test's own settings,
    the run's overrides), the difficulty of the world that was generated, and the scoring profile the pair was
    judged with. Results are only pooled within one set of conditions: a race at easy difficulty says nothing
    about the standard level, and a suite with a different budget per attempt is a different condition too.
    When the two models were given different settings, the string names each model's own, so such a pair is
    only ever pooled with pairs where the same models had the same ones."""
    shared = {
        **(settings.get("defaults") or {}),
        **((settings.get("per_node") or {}).get(node) or {}),
        **(settings.get("overrides") or {}),
    }
    shared.pop("repeats", None)  # how often a test is played is not a condition of any one attempt
    if difficulty is not None:
        shared["difficulty"] = difficulty
    shared["profile"] = profile
    own = settings.get("per_contestant") or {}
    a, b = own.get("A") or {}, own.get("B") or {}
    if a == b:
        shared.update(a)
    else:
        each = {sides["A"]["id"]: a, sides["B"]["id"]: b}
        shared["per_model"] = json.dumps(each, sort_keys=True, default=str)
    return "; ".join(f"{k}={shared[k]}" for k in sorted(shared))


def attempt_props(res: dict, side: str, effort, efficiency: float | None) -> dict:
    details = res.get("grade_details") or {}
    return {
        "side": side,
        "effort": effort,
        "passed": bool(res.get("passed")),
        # the result alone: every decision right and nothing left undone, whatever the process was (the engine's
        # task check). `passed` asks for this and for the process the test sets. None where a test does not grade it.
        "task_correct": res.get("task_correct"),
        "first_pass": res.get("first_pass"),
        "mistakes": scoring.mistake_points(res),
        "model_errors": res.get("model_errors"),
        "progress": round(scoring.progress(res), 4),
        "cost_usd": float(res.get("cost_usd") or 0),
        "cost_basis": res.get("cost_basis") or "list",
        "tokens": int((res.get("input_tokens") or 0) + (res.get("output_tokens") or 0)),
        # what the tokens were: read (all input), of which re-read from the provider's cache, and written
        "tokens_in": int(res.get("input_tokens") or 0),
        "tokens_cached": int(
            sum((t.get("usage") or {}).get("cached_input_tokens") or 0 for t in res.get("turns") or [])
        ),
        "tokens_out": int(res.get("output_tokens") or 0),
        "wall_s": float(res.get("wall_s") or 0),
        "calls": res.get("calls"),
        "termination": res.get("termination"),
        "items": details.get("items"),
        "efficiency": efficiency,
    }


def flow_facts(sides: dict) -> dict:
    """What a run's records say about each workflow it played, for search and for the spec: its title, the brief
    and policy the models were given (the lowest-numbered wording seen in this run, and which one that is), its
    tags, the benchmark it is modelled on, and every tool a model used on it. Keys with no value are left out,
    so loading never erases a fact another record supplied. One run sees only part of a workflow (the tools its
    two models happened to use, one wording of the brief): `settle_flows` makes one account of each workflow
    from every run on file."""
    seen: dict[str, dict] = {}
    for side in sides.values():
        for res in side["results"]:
            node = res["node"]
            flow = seen.setdefault(node, {"wording": None, "tools": set()})
            flow["tools"].update(t["tool_name"] for t in res.get("turns") or [] if t.get("tool_name"))
            challenge = res.get("challenge") or {}
            packet = res.get("public_packet") or {}
            wording = (res.get("grade_details") or {}).get("wording")
            wording = wording if isinstance(wording, int) else 0
            if packet.get("brief") and (flow["wording"] is None or wording < flow["wording"]):
                flow.update(wording=wording, brief=packet.get("brief"), policy=packet.get("policy"))
            flow.update(
                title=res.get("name"),
                tags=challenge.get("tags"),
                emulates=challenge.get("emulates"),
                test_type=challenge.get("test_type"),
                action_budget=packet.get("action_budget"),
            )
    out = {}
    for node, flow in seen.items():
        flow["tools"] = sorted(flow["tools"])
        if not flow.get("brief"):
            flow.pop("wording")  # no text was kept, so there is no wording to name
        out[node] = {k: v for k, v in flow.items() if v not in (None, [], "")}
    return out


class Flows:
    """One account of each workflow version, made from every record seen so far, whatever order they came in.

    One record shows only part of a workflow: the tools its two models happened to use, one wording of the brief,
    the action budget of the level it was played at. The graph holds one account of each version:
      - every tool any model used on it;
      - the text (brief, policy, which wording it is) and action budget from its lowest-numbered wording, as the
        earliest record shows it;
      - what the test package says of itself (title, tags, status and so on) as the newest record has it.
    The account depends only on which records have been seen, never on which came last, so a record added to a
    store that is already built leaves the same graph as building it again from all of them (ledger/live.py)."""

    TEXT = ("brief", "policy", "wording", "action_budget")
    PACKAGE = ("title", "tags", "emulates", "test_type", "status", "forked_from")

    def __init__(self):
        self.known: dict[str, dict] = {}

    def absorb(self, run: dict) -> None:
        for scenario in [*run["matches"], *run["self_checks"]]:
            v = scenario["version"]
            k = self.known.setdefault(scenario["version_key"], {"tools": set(), "text": None, "package": None})
            k["tools"].update(v.get("tools") or [])
            if v.get("brief"):
                rank = (v.get("wording", 0), run["run_id"])
                if k["text"] is None or rank < k["text"][0]:
                    k["text"] = (rank, {key: v[key] for key in self.TEXT if v.get(key) not in (None, "")})
            if k["package"] is None or run["run_id"] >= k["package"][0]:
                package = {key: v[key] for key in self.PACKAGE if v.get(key) not in (None, [], "")}
                k["package"] = (run["run_id"], {**(k["package"][1] if k["package"] else {}), **package})

    def apply(self, run: dict) -> None:
        """Write the account as it stands into every row of this run."""
        for scenario in [*run["matches"], *run["self_checks"]]:
            v, k = scenario["version"], self.known[scenario["version_key"]]
            for key in (*self.TEXT, *self.PACKAGE, "tools"):
                v.pop(key, None)
            v.update(k["package"][1] if k["package"] else {})
            v.update(k["text"][1] if k["text"] else {})
            if k["tools"]:
                v["tools"] = sorted(k["tools"])


def settle_flows(runs: list[dict], flows: Flows | None = None) -> Flows:
    """Give every row the one account of its workflow version (Flows). Without this the graph kept whatever the
    record loaded last happened to say, so the text of a workflow, and the tools listed for it, could change with
    every race that was imported. `flows` carries what earlier records showed, for a record added later."""
    flows = flows or Flows()
    for run in runs:
        flows.absorb(run)
    for run in runs:
        flows.apply(run)
    return flows


def run_rows(body: dict, seal: str, answer_key: bool = False) -> dict:
    run_id = body["run_id"]
    settings = body.get("settings") or {}
    profile = ((body.get("suite") or {}).get("success") or {}).get("profile") or "balanced"
    sides = body["contestants"]
    by_key = {side: {(r["node"], r.get("attempt", 1)): r for r in sides[side]["results"]} for side in ("A", "B")}
    flows = flow_facts(sides)
    matches = []
    can_show: dict[tuple[str, str], dict] = {}  # (test version, fault) -> the fault, once per run
    made = []  # one row per attempt and fault it actually made
    includes: set[tuple[str, str]] = set()  # (test version, hazard its grader counts), once per run
    # One model on both sides: a consistency check of that model on the task, not a match. Its scenarios are kept
    # apart (self_checks) so that nothing that counts pairs, wins or opponents ever sees them.
    same_model = sides["A"]["id"] == sides["B"]["id"]
    self_checks = []
    for node, attempt in by_key["A"]:
        a, b = by_key["A"][(node, attempt)], by_key["B"].get((node, attempt))
        if b is None:
            continue
        challenge = a.get("challenge") or {"id": node, "version": "0", "content_sha256": ""}
        excluded = a.get("termination") in EXCLUDED or b.get("termination") in EXCLUDED
        if excluded or same_model:  # a model does not beat itself: no winner is ever worked out
            outcome = {"winner": None, "by": "excluded" if excluded else None, "efficiency": (None, None)}
        else:
            outcome = scoring.pair_outcome(a, b, profile)
        rule = outcome["by"] or "tie"
        key = f"{run_id}/{node}/{attempt}"
        attempts = []
        for side, res, eff in (("A", a, outcome["efficiency"][0]), ("B", b, outcome["efficiency"][1])):
            model = sides[side]["id"]
            details = res.get("grade_details") or {}
            attempts.append(
                {
                    "key": f"{key}/{side}",
                    "model": model,
                    "provider": model.split(":", 1)[0],
                    "won": outcome["winner"] == side,
                    "props": attempt_props(res, side, effort_for(settings, side), eff),
                    # only the hazards this attempt tripped on; which hazards the version includes is said once
                    # per run (`includes` below), not once per attempt
                    "hazards": [
                        {"name": name, "count": int(details[counter])}
                        for counter, name in HAZARDS.items()
                        if details.get(counter)
                    ],
                }
            )
        for res in (a, b):
            for counter, name in HAZARDS.items():
                if counter in (res.get("grade_details") or {}) and not same_model:
                    includes.add((version_key(challenge), name))
        for side, res in (("A", a), ("B", b)):
            for fault in fault_rows(res, challenge["id"]):
                count = fault.pop("count")
                can_show.setdefault((version_key(challenge), fault["key"]), fault)
                if count:
                    made.append({"attempt": f"{key}/{side}", "fault": fault["key"], "count": count})
        instance = a.get("instance") or {}
        (self_checks if same_model else matches).append(
            {
                "key": key,
                "test_id": challenge["id"],
                "version_key": version_key(challenge),
                "version": {
                    "test_id": challenge["id"],
                    "version": str(challenge["version"]),
                    "version_rank": version_rank(challenge["version"]),
                    "content_sha256": challenge.get("content_sha256"),
                    "status": challenge.get("status"),
                    "forked_from": challenge.get("forked_from"),
                    **flows.get(node, {}),
                },
                "props": {
                    "run_id": run_id,
                    "node": node,
                    "attempt": attempt,
                    "difficulty": instance.get("difficulty"),
                    "seed": instance.get("seed"),
                    "profile": profile,
                    "conditions": conditions_of(settings, node, instance.get("difficulty"), profile, sides),
                    "rule": rule,
                    "excluded": excluded,
                    "started_unix": body.get("started_unix"),
                    # for a consistency check: did the model end the same way both times it met this scenario
                    **(
                        {"same": bool(a.get("passed")) == bool(b.get("passed")), "model": sides["A"]["id"]}
                        if same_model
                        else {}
                    ),
                },
                "attempts": attempts,
            }
        )
    budget = body.get("budget") or {}
    verdict = body.get("verdict") or {}
    suite = body.get("suite") or {}
    return {
        "run_id": run_id,
        "props": {
            "suite": suite.get("name"),
            "suite_path": suite.get("path"),
            "started_unix": body.get("started_unix"),
            "record_version": body.get("record_version", 1),
            "engine_commit": body.get("engine_commit"),
            "cap_usd": budget.get("cap_usd"),
            "spent_usd": budget.get("spent_usd"),
            "repeats": settings.get("repeats"),
            "effort": (settings.get("defaults") or {}).get("effort"),
            "max_output_tokens": (settings.get("defaults") or {}).get("max_output_tokens"),
            "attempt_budget_usd": (settings.get("defaults") or {}).get("attempt_budget_usd"),
            "timeout_s": (settings.get("defaults") or {}).get("timeout_s"),
            "model_a": sides["A"]["id"],
            "model_b": sides["B"]["id"],
            "recorded_winner": verdict.get("winner"),
            "seal_sha256": seal,
            # whether its answer key is published beside it (answer_key_beside): a fact about what a reader can
            # check, set by whoever reads the record from a folder
            "answer_key": bool(answer_key),
        },
        "matches": matches,
        "self_checks": self_checks,
        "self_made": made if same_model else [],
        "includes": [{"version_key": vkey, "name": name} for vkey, name in sorted(includes)],
        "can_show": [dict(fault, version_key=vkey) for (vkey, _), fault in sorted(can_show.items())],
        "made": [] if same_model else made,
    }


def validation_rows(body: dict, seal: str) -> list[dict]:
    challenge = body["challenge"]
    vkey = version_key(challenge)
    version = {
        "test_id": challenge["id"],
        "version": str(challenge["version"]),
        "version_rank": version_rank(challenge["version"]),
        "content_sha256": challenge.get("content_sha256"),
    }
    common = {
        "record_valid": bool(body.get("valid")),
        "engine_commit": body.get("engine_commit"),
        "validated_at": body.get("validated_at"),
        "seal_sha256": seal,
    }
    rows = []
    for level, ev in (body.get("levels") or {}).items():
        seeds = ev.get("seeds")
        players = [("reference", "reference", True, ev.get("oracle_passed"), ev.get("oracle_passed") == seeds)]
        players += [
            (name, "corner-cutting", p.get("must_fail"), p.get("passed_seeds"), p.get("ok"))
            for name, p in (ev.get("players") or {}).items()
        ]
        for name, role, applies, passed_seeds, ok in players:
            if role == "corner-cutting" and not applies:
                continue  # its hazard is absent at this level: nothing was checked
            rows.append(
                {
                    "key": f"{vkey}/{seal[:12]}/{level}/{name}",
                    "version_key": vkey,
                    "version": version,
                    "hazard": PLAYER_HAZARDS.get(name),
                    "props": dict(
                        common, level=level, player=name, role=role, seeds=seeds, passed_seeds=passed_seeds, ok=ok
                    ),
                }
            )
    return rows


def find_records(root: Path) -> list[Path]:
    return sorted(Path(root).rglob("record.json"))


def read_records(root: Path) -> Evidence:
    """Every sealed match record under root, as run rows (one per record, with its judged pairs)."""
    out = Evidence(source=NAME, description=DESCRIPTION)
    for path in find_records(root):
        record = json.loads(path.read_text(encoding="utf-8"))
        if not seal_ok(record):
            out.skipped.append(str(path))
            continue
        # costs are corrected as the record is read (ledger/costs.py); the sealed file itself is never changed
        body = costs.corrected(record["body"], costs.read_billed(path, record["sha256"]))
        out.runs.append(run_rows(body, record["sha256"], answer_key_beside(path, record)))
    settle_flows(out.runs)
    return out


def read_validations(root: Path) -> Evidence:
    """Every sealed validation record under root, as one check row per level and player."""
    out = Evidence(source=NAME, description=DESCRIPTION)
    for path in sorted(Path(root).rglob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        if (record.get("body") or {}).get("kind") != "validation":
            continue
        if not seal_ok(record):
            out.skipped.append(str(path))
            continue
        out.records += 1
        out.checks += validation_rows(record["body"], record["sha256"])
    return out
