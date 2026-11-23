"""Export what the browser demo needs (site/data/): the same rows, the same Cypher and the same rules as the
command line, so the page builds the same graph in the visitor's browser and gives the same answers.

  graph.json     schema statements, the three write statements, and the rows each bridge produced
  questions.json every Cypher question by name
  rules.json     constants the page must share with the command line (thresholds, filler words, guardrails)
  expected.json  answers computed here by the command-line code, which the page's own answers are checked against
"""

import json
from pathlib import Path

from ledger import cli, load, questions, spec
from ledger.bridges import epoch, gladiator

# Pairs the page is checked against: (task, model a, model b).
CHECKED = [
    ("gladiator/refund-queue", "anthropic:claude-haiku-5-5", "openrouter:minimax/minimax-m3.1-flash"),
    ("gladiator/incident-triage", "anthropic:claude-haiku-5-5", "openrouter:minimax/minimax-m3.1-flash"),
    ("gladiator/refund-queue", "openrouter:deepseek/deepseek-v4.1-flash-1017", "openrouter:minimax/minimax-m3.1-flash"),
    ("gladiator/access-review", "openai:gpt-6.1-terra", "anthropic:claude-sonnet-5-5"),
]
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
            },
        ),
    }

    def ask(q, p):
        return cli.rows(store, q, p)

    expected = {"verdicts": [], "specs": [], "flows": [], "opponents": []}
    for task, a, b in CHECKED:
        found = cli.verdict(store, task, a, b)
        expected["verdicts"].append(found)
        expected["specs"].append(spec.build(ask, dict(found, suite=None)))
    for text in DESCRIBED:
        expected["flows"].append(cli.find_flows(store, text))
    expected["flows"].append(cli.find_flows(store, "zebra unicorns"))
    expected["opponents"].append(cli.opponents(store, "anthropic:claude-haiku-5-5", open_only=True))
    expected["opponents"].append(cli.opponents(store, "openrouter:minimax/minimax-m3.1-flash"))
    sizes["expected.json"] = _dump(out / "expected.json", expected)
    return sizes
