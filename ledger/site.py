"""Export what the browser demo needs (site/data/): the same rows, the same Cypher and the same rules as the
command line, so the page builds the same graph in the visitor's browser and gives the same answers.

  graph.json     schema statements, the three write statements, and the rows each bridge produced
  questions.json every Cypher question by name
  rules.json     constants the page must share with the command line (thresholds, filler words, guardrails)
  expected.json  answers computed here by the command-line code, which the page's own answers are checked against
  replays/       one file per match record: every step of every attempt, for replaying a scenario as a race
"""

import json
from pathlib import Path

from ledger import cli, load, policy, questions, replay, spec
from ledger.bridges import epoch, gladiator

# Pairs the page is checked against: (task, model a, model b).
CHECKED = [
    ("gladiator/refund-queue", "anthropic:claude-haiku-5-5", "openrouter:minimax/minimax-m3.1-flash"),
    ("gladiator/incident-triage", "anthropic:claude-haiku-5-5", "openrouter:minimax/minimax-m3.1-flash"),
    ("gladiator/refund-queue", "openrouter:deepseek/deepseek-v4.1-flash-1017", "openrouter:minimax/minimax-m3.1-flash"),
    ("gladiator/access-review", "openai:gpt-6.1-terra", "anthropic:claude-sonnet-5-5"),
]
# A reader's own rule, to check that overrides move the answer the same way on the page.
OWN_RULE = {"acted without reading": "unforgivable", "duplicate effect": "minor"}
DESCRIBED = ["an agent that handles refund requests for damaged orders", "page the on-call owner for alerts"]


def _dump(path: Path, value) -> int:
    path.write_text(json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str), encoding="utf-8")
    return path.stat().st_size


def export(data: Path, store: str, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    runs = gladiator.read_records(data / "records")
    checks = gladiator.read_validations(data / "validations")
    scores = epoch.read_scores(data / "epoch")
    sizes = {
        "graph.json": _dump(
            out / "graph.json",
            {
                "schema": load.SCHEMA,
                "writes": {
                    "runs": load.WRITE,
                    "faults": load.WRITE_FAULTS,
                    "made": load.WRITE_MADE,
                    "checks": load.WRITE_VALIDATIONS,
                    "scores": load.WRITE_SCORES,
                },
                "link_forks": "MATCH (child:TestVersion) WHERE child.forked_from IS NOT NULL "
                "MATCH (parent:TestVersion) WHERE parent.test_id + '@' + parent.version = child.forked_from "
                "OR parent.test_id = child.forked_from MERGE (child)-[:FORKED_FROM]->(parent)",
                "sources": {
                    "gladiator": {"name": gladiator.NAME, "description": gladiator.DESCRIPTION},
                    "epoch": {"name": epoch.NAME, "description": epoch.DESCRIPTION},
                },
                "rows": {"runs": runs.runs, "checks": checks.checks, "scores": scores.scores},
            },
        ),
        "questions.json": _dump(out / "questions.json", questions.ALL),
        "rules.json": _dump(
            out / "rules.json",
            {
                "min_pairs": cli.MIN_PAIRS,
                "clear_p": cli.CLEAR_P,
                "good_enough": cli.GOOD_ENOUGH,
                "filler": sorted(cli.FILLER),
                "benchmark": epoch.BENCHMARK,
                "guardrails": spec.GUARDRAILS,
                "unforgivable": spec.UNFORGIVABLE,
                "reads": list(spec.READS),
                # grader counter -> fault name, so the page can name the faults of a live race the same way
                "fault_counters": {**gladiator.HAZARDS, **gladiator.DECISION_FAULTS},
                "ending_faults": gladiator.ENDING_FAULTS,
                "policy": {
                    "levels": list(policy.LEVELS),
                    "profiles": policy.PROFILES,
                    "default_profile": policy.DEFAULT_PROFILE,
                    "fault_levels": policy.FAULT_LEVELS,
                    "task_levels": policy.TASK_LEVELS,
                },
            },
        ),
    }

    # One file per match record, fetched only when a visitor opens a scenario to watch it.
    replays = replay.export(data / "records", out / "replays")
    sizes["replays/"] = sum(replays.values())

    def ask(q, p):
        return cli.rows(store, q, p)

    expected = {"verdicts": [], "specs": [], "judged": [], "judged_specs": [], "flows": [], "opponents": []}
    for task, a, b in CHECKED:
        found = cli.verdict(store, task, a, b)
        expected["verdicts"].append(found)
        expected["specs"].append(spec.build(ask, dict(found, suite=None)))
    # The same pairs read through fitness, under each profile, and once with a reader's own rule.
    for task, a, b in CHECKED:
        for profile, overrides in [(p, None) for p in policy.PROFILES] + [(policy.DEFAULT_PROFILE, OWN_RULE)]:
            found = cli.verdict(store, task, a, b, profile=profile, overrides=overrides)
            expected["judged"].append({"overrides": overrides, "verdict": found})
            built = spec.build(ask, dict(found, suite=None))
            expected["judged_specs"].append({"overrides": overrides, "spec": built, "markdown": spec.markdown(built)})
    for text in DESCRIBED:
        expected["flows"].append(cli.find_flows(store, text))
    expected["flows"].append(cli.find_flows(store, "zebra unicorns"))
    expected["opponents"].append(cli.opponents(store, "anthropic:claude-haiku-5-5", open_only=True))
    expected["opponents"].append(cli.opponents(store, "openrouter:minimax/minimax-m3.1-flash"))
    sizes["expected.json"] = _dump(out / "expected.json", expected)
    return sizes
