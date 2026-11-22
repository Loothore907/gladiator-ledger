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

from ledger import scoring
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


def flow_facts(sides: dict) -> dict:
    """What a run's records say about each workflow it played, for search and for the spec: its title, the brief
    and policy the models were given (the lowest-numbered wording seen, so a rebuild picks the same text), its
    tags, the benchmark it is modelled on, and every tool a model used on it. Keys with no value are left out,
    so loading never erases a fact another record supplied."""
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
        flow.pop("wording")
        out[node] = {k: v for k, v in flow.items() if v not in (None, [], "")}
    return out


def run_rows(body: dict, seal: str) -> dict:
    run_id = body["run_id"]
    settings = body.get("settings") or {}
    profile = ((body.get("suite") or {}).get("success") or {}).get("profile") or "balanced"
    sides = body["contestants"]
    by_key = {side: {(r["node"], r.get("attempt", 1)): r for r in sides[side]["results"]} for side in ("A", "B")}
    flows = flow_facts(sides)
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
                    **flows.get(node, {}),
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
            "effort": (settings.get("defaults") or {}).get("effort"),
            "max_output_tokens": (settings.get("defaults") or {}).get("max_output_tokens"),
            "attempt_budget_usd": (settings.get("defaults") or {}).get("attempt_budget_usd"),
            "timeout_s": (settings.get("defaults") or {}).get("timeout_s"),
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
        out.runs.append(run_rows(record["body"], record["sha256"]))
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
