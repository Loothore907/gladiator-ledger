"""Load Gladiator run records into a Relate graph.

Reads runs/<run_id>/record.json files (Gladiator's sealed, versioned run-record format, docs/RUN_RECORD.md in the
Gladiator repo). Only the public record.json is read: operator.json holds private simulator state and is never
opened. Every write is a MERGE on a stable key, so loading the same records again changes nothing.

Graph (spike version):
  (:Run)            one record: suite, date, cap, spend, seal
  (:Match)          one paired attempt: both models played the same generated world
  (:Attempt)        one side of a match
  (:Model) (:Test) (:TestVersion) (:Hazard)
  (Match)-[:PART_OF]->(Run)          (Match)-[:USED]->(TestVersion)    (TestVersion)-[:VERSION_OF]->(Test)
  (Attempt)-[:IN]->(Match)           (Attempt)-[:BY]->(Model)          (Match)-[:WON_BY]->(Model)  (absent = tie)
  (TestVersion)-[:INCLUDES]->(Hazard) (Attempt)-[:TRIPPED_ON {count}]->(Hazard)
  (TestVersion)-[:FORKED_FROM]->(TestVersion)
  (TestVersion)-[:VALIDATED_BY]->(:ValidationRun)-[:GUARDS]->(Hazard)
     one ValidationRun per level and player of a Gladiator validation record (validations/*.json): the reference
     player must pass every seed; each corner-cutting player must fail where its hazard is present.
"""

import hashlib
import json
from pathlib import Path

import relate

from ledger import scoring

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

SCHEMA = [
    "CREATE CONSTRAINT run_id IF NOT EXISTS FOR (n:Run) REQUIRE n.run_id IS UNIQUE",
    "CREATE CONSTRAINT match_key IF NOT EXISTS FOR (n:Match) REQUIRE n.key IS UNIQUE",
    "CREATE CONSTRAINT attempt_key IF NOT EXISTS FOR (n:Attempt) REQUIRE n.key IS UNIQUE",
    "CREATE CONSTRAINT model_name IF NOT EXISTS FOR (n:Model) REQUIRE n.name IS UNIQUE",
    "CREATE CONSTRAINT test_id IF NOT EXISTS FOR (n:Test) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT version_key IF NOT EXISTS FOR (n:TestVersion) REQUIRE n.key IS UNIQUE",
    "CREATE CONSTRAINT hazard_name IF NOT EXISTS FOR (n:Hazard) REQUIRE n.name IS UNIQUE",
    "CREATE CONSTRAINT validation_key IF NOT EXISTS FOR (n:ValidationRun) REQUIRE n.key IS UNIQUE",
]

# Corner-cutting validation players that stand for a hazard models trip on (see HAZARDS).
PLAYER_HAZARDS = {
    "blind_retry": "ambiguous timeout (retried without checking)",
    "obeys_injections": "planted instruction",
    "no_reading": "acted without reading",
}

WRITE_VALIDATIONS = """
UNWIND $checks AS c
MERGE (tv:TestVersion {key: c.version_key})
SET tv += c.version
MERGE (tst:Test {id: c.version.test_id})
MERGE (tv)-[:VERSION_OF]->(tst)
MERGE (v:ValidationRun {key: c.key})
SET v += c.props
MERGE (tv)-[:VALIDATED_BY]->(v)
WITH v, c
FOREACH (h IN CASE WHEN c.hazard IS NULL THEN [] ELSE [c.hazard] END |
  MERGE (hz:Hazard {name: h}) MERGE (v)-[:GUARDS]->(hz))
"""

WRITE = """
UNWIND $runs AS r
MERGE (run:Run {run_id: r.run_id})
SET run += r.props
WITH run, r
UNWIND r.matches AS m
MERGE (tst:Test {id: m.test_id})
MERGE (tv:TestVersion {key: m.version_key})
SET tv += m.version
MERGE (tv)-[:VERSION_OF]->(tst)
MERGE (match:Match {key: m.key})
SET match += m.props
MERGE (match)-[:PART_OF]->(run)
MERGE (match)-[:USED]->(tv)
WITH match, tv, m
UNWIND m.attempts AS a
MERGE (model:Model {name: a.model})
SET model.provider = a.provider
MERGE (att:Attempt {key: a.key})
SET att += a.props
MERGE (att)-[:IN]->(match)
MERGE (att)-[:BY]->(model)
WITH match, tv, att, model, a
FOREACH (_ IN CASE WHEN a.won THEN [1] ELSE [] END | MERGE (match)-[:WON_BY]->(model))
WITH tv, att, a
UNWIND a.hazards AS h
MERGE (hz:Hazard {name: h.name})
MERGE (tv)-[:INCLUDES]->(hz)
FOREACH (_ IN CASE WHEN h.count > 0 THEN [1] ELSE [] END |
  MERGE (att)-[t:TRIPPED_ON]->(hz) SET t.count = h.count)
"""


def seal_ok(record: dict) -> bool:
    body = record.get("body")
    canonical = json.dumps(
        body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False, default=str
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest() == record.get("sha256")


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


def attempt_props(res: dict, side: str, effort, efficiency: float | None) -> dict:
    details = res.get("grade_details") or {}
    return {
        "side": side,
        "effort": effort,
        "passed": bool(res.get("passed")),
        "first_pass": res.get("first_pass"),
        "mistakes": scoring.mistake_points(res),
        "model_errors": res.get("model_errors"),
        "progress": round(scoring.progress(res), 4),
        "cost_usd": float(res.get("cost_usd") or 0),
        "tokens": int((res.get("input_tokens") or 0) + (res.get("output_tokens") or 0)),
        "wall_s": float(res.get("wall_s") or 0),
        "calls": res.get("calls"),
        "termination": res.get("termination"),
        "items": details.get("items"),
        "efficiency": efficiency,
    }


def run_rows(body: dict, seal: str) -> dict:
    run_id = body["run_id"]
    settings = body.get("settings") or {}
    profile = ((body.get("suite") or {}).get("success") or {}).get("profile") or "balanced"
    sides = body["contestants"]
    by_key = {side: {(r["node"], r.get("attempt", 1)): r for r in sides[side]["results"]} for side in ("A", "B")}
    matches = []
    for node, attempt in by_key["A"]:
        a, b = by_key["A"][(node, attempt)], by_key["B"].get((node, attempt))
        if b is None:
            continue
        challenge = a.get("challenge") or {"id": node, "version": "0", "content_sha256": ""}
        excluded = a.get("termination") in EXCLUDED or b.get("termination") in EXCLUDED
        if excluded:
            outcome = {"winner": None, "by": "excluded", "efficiency": (None, None)}
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
                    "hazards": [
                        {"name": name, "count": int(details[counter] or 0)}
                        for counter, name in HAZARDS.items()
                        if counter in details
                    ],
                }
            )
        instance = a.get("instance") or {}
        matches.append(
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
                },
                "props": {
                    "run_id": run_id,
                    "node": node,
                    "attempt": attempt,
                    "difficulty": instance.get("difficulty"),
                    "seed": instance.get("seed"),
                    "profile": profile,
                    "rule": rule,
                    "excluded": excluded,
                    "started_unix": body.get("started_unix"),
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
            "model_a": sides["A"]["id"],
            "model_b": sides["B"]["id"],
            "recorded_winner": verdict.get("winner"),
            "seal_sha256": seal,
        },
        "matches": matches,
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


def load_validations(root: Path, store: str) -> dict:
    """Load Gladiator validation records (validations/**/*.json) into the store."""
    checks, skipped, records = [], [], 0
    for path in sorted(Path(root).rglob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        if (record.get("body") or {}).get("kind") != "validation":
            continue
        if not seal_ok(record):
            skipped.append(str(path))
            continue
        records += 1
        checks += validation_rows(record["body"], record["sha256"])
    with relate.connect(store) as conn:
        for statement in SCHEMA:
            conn.execute(statement)
        stats = conn.execute(WRITE_VALIDATIONS, {"checks": checks}).stats if checks else {}
    return {"loaded": records, "checks": len(checks), "skipped_bad_seal": skipped, "stats": stats}


def find_records(root: Path) -> list[Path]:
    return sorted(Path(root).rglob("record.json"))


def load(records_root: Path, store: str) -> dict:
    """Load every sealed record under records_root into the store. Returns a short summary."""
    rows, skipped = [], []
    for path in find_records(records_root):
        record = json.loads(path.read_text(encoding="utf-8"))
        if not seal_ok(record):
            skipped.append(str(path))
            continue
        rows.append(run_rows(record["body"], record["sha256"]))
    with relate.connect(store) as conn:
        for statement in SCHEMA:
            conn.execute(statement)
        stats = conn.execute(WRITE, {"runs": rows}).stats if rows else {}
    return {"loaded": len(rows), "skipped_bad_seal": skipped, "stats": stats}


def link_forks(store: str) -> None:
    """(TestVersion)-[:FORKED_FROM]->(TestVersion) where a package names its parent and the parent is loaded."""
    with relate.connect(store) as conn:
        conn.execute(
            """
            MATCH (child:TestVersion) WHERE child.forked_from IS NOT NULL
            MATCH (parent:TestVersion) WHERE parent.test_id + '@' + parent.version = child.forked_from
               OR parent.test_id = child.forked_from
            MERGE (child)-[:FORKED_FROM]->(parent)
            """
        )
