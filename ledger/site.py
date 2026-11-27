"""Export what the browser demo needs (site/data/): the same rows, the same Cypher and the same rules as the
command line, so the page builds the same graph in the visitor's browser and gives the same answers.

  graph.json     schema statements, the write statements, and the rows each bridge produced
  questions.json every Cypher question by name
  rules.json     constants the page must share with the command line (thresholds, filler words, guardrails)
  expected.json  answers computed here by the command-line code, which the page's own answers are checked against
  replays/       one file per match record: every step of every attempt, for replaying a scenario as a race
  steps/         one file per match record: the same steps as rows for the graph, with the world records they
                 touched (ledger/bridges/steps.py, compact). The page loads them into its graph only for the
                 scenarios it is asked about, with the statements under "steps" in graph.json.
"""

import json
from pathlib import Path

from ledger import cli, load, policy, questions, replay, reports, routes, spec
from ledger.bridges import epoch, gladiator, steps

# Pairs the page is checked against: (task, model a, model b).
CHECKED = [
    ("gladiator/refund-queue", "anthropic:claude-haiku-5-5", "openrouter:minimax/minimax-m3.1-flash"),
    ("gladiator/incident-triage", "anthropic:claude-haiku-5-5", "openrouter:minimax/minimax-m3.1-flash"),
    ("gladiator/refund-queue", "openrouter:deepseek/deepseek-v4.1-flash-1017", "openrouter:minimax/minimax-m3.1-flash"),
    ("gladiator/access-review", "openai:gpt-6.1-terra", "anthropic:claude-sonnet-5-5"),
    # a pair where one model has also been run against itself (a self run): its attempts there count in its own
    # fitness and its consistency is reported, on the page as on the command line
    ("gladiator/access-review", "anthropic:claude-haiku-5-5", "openrouter:deepseek/deepseek-v4.1-flash-1017"),
]
# A reader's own rule, to check that overrides move the answer the same way on the page.
OWN_RULE = {"acted without reading": "unforgivable", "duplicate effect": "minor"}
# A reader's own process question at a level, to check that it moves the answer the same way on the page, and the
# scenario whose two routes are compared item by item.
OWN_CHECK = {"decided-before-seeing": "serious"}
ROUTE_SCENARIO = 2
SELF = {"world": "SelfCheck", "attempt": "SelfAttempt"}
DESCRIBED = ["an agent that handles refund requests for damaged orders", "page the on-call owner for alerts"]


def _dump(path: Path, value) -> int:
    path.write_text(json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str), encoding="utf-8")
    return path.stat().st_size


def _conditions_examples() -> dict:
    """Which pairs a verdict counts (cli.reference_conditions, cli.conditions_apart), on made-up cases. The shipped
    records hold no pair played under other conditions, so the page's own copy of the rule is checked against
    these, and site/check.cjs then adds such a pair to the graph in the browser and looks at the verdict."""
    std = "attempt_budget_usd=0.12; difficulty=standard; effort=low; max_output_tokens=4096; profile=budget; timeout_s=180"
    easy = std.replace("difficulty=standard", "difficulty=easy")
    fast = std.replace("profile=budget", "profile=latency")
    dearer = std.replace("attempt_budget_usd=0.12", "attempt_budget_usd=0.4")

    def met(conditions: str, pairs: int, suite_pairs: int) -> dict:
        return {"conditions": conditions, "pairs": pairs, "suite_pairs": suite_pairs}

    cases = [
        ([met(std, 16, 16), met(easy, 25, 0)], {std: 200}),  # the suite matches between the two decide
        ([met(std, 2, 0), met(easy, 25, 0)], {std: 200}),  # never met in a suite: the task's own record decides
        ([met(fast, 3, 0), met(easy, 4, 0)], {std: 200}),  # no pair under that either: where they met most
        ([met(fast, 3, 0), met(easy, 3, 0)], {std: 200}),  # a full tie: the first in order
        ([met(easy, 1, 0)], {}),
        ([met(std, 4, 4), met(dearer, 6, 6)], {std: 200, dearer: 20}),  # two suites, two budgets: the larger
    ]
    others = [easy, fast, easy.replace("profile=budget", "profile=latency"), dearer, std + "; new_setting=7"]
    others.append(std.replace("; timeout_s=180", ""))
    return {
        "reference": [{"found": f, "record": r, "is": cli.reference_conditions(f, r)} for f, r in cases],
        "apart": [{"reference": std, "other": o, "what": cli.conditions_apart(std, o)} for o in others],
        # one race at the easy level beside a record at the standard one: what the verdict must then say
        "one_easy_race": {
            "from": "difficulty=standard",
            "to": "difficulty=easy",
            "what": cli.conditions_apart(std, easy),
            "note": cli.not_counted_note([{"what": cli.conditions_apart(std, easy), "pairs": 1}]),
        },
    }


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
                    "includes": load.WRITE_INCLUDES,
                    "faults": load.WRITE_FAULTS,
                    "made": load.WRITE_MADE,
                    # a run of one model on both sides: its own kind of node, written after the runs themselves
                    "self": load.WRITE_SELF,
                    "self_made": load.WRITE_SELF_MADE,
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
                # the statements that load steps (data/steps/<run>.json), run only when a question needs them
                "steps": {
                    "schema": load.STEP_SCHEMA,
                    "writes": {
                        "items": load.WRITE_ITEMS.format(**load.LABELS),
                        "refers": load.WRITE_REFERS,
                        "steps": load.WRITE_STEPS.format(**load.LABELS),
                        "next": load.WRITE_NEXT,
                    },
                    "self_writes": {
                        "items": load.WRITE_ITEMS.format(**SELF),
                        "steps": load.WRITE_STEPS.format(**SELF),
                    },
                },
            },
        ),
        "questions.json": _dump(out / "questions.json", questions.ALL),
        "rules.json": _dump(
            out / "rules.json",
            {
                "min_pairs": cli.MIN_PAIRS,
                "clear_p": cli.CLEAR_P,
                "level_p": cli.LEVEL_P,
                "good_enough": cli.GOOD_ENOUGH,
                "filler": sorted(cli.FILLER),
                "benchmark": epoch.BENCHMARK,
                "condition_words": cli.CONDITION_WORDS,
                "guardrails": spec.GUARDRAILS,
                "unforgivable": spec.UNFORGIVABLE,
                # the kinds of fault the guardrail section lists beside the hazards
                "fault_kinds": list(spec.FAULT_KINDS),
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
                # the process questions asked of the steps: what each asks, and what the grader counts for it
                "step_checks": routes.CHECKS,
                # the records that have a step file (data/steps/<run>.json), so the page never asks for one that
                # does not exist (a race played in the visitor's tab has none until it is imported)
                "steps_for": [r["run_id"] for r in runs.runs],
            },
        ),
    }

    # One file per match record, fetched only when a visitor opens a scenario to watch it.
    replays = replay.export(data / "records", out / "replays")
    sizes["replays/"] = sum(replays.values())
    # The same steps as rows for the graph, a file per record, loaded only for the scenarios a visitor asks about.
    sizes["steps/"] = sum(steps.export(data / "records", out / "steps").values())

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
            title = (built.get("blueprint") or {}).get("title") or built["task"]
            expected["judged_specs"].append(
                {
                    "overrides": overrides,
                    "spec": built,
                    "markdown": spec.markdown(built),
                    "json": spec.as_json(built),
                    "cost": reports.cost_markdown(found, title),
                    "evidence": reports.evidence_markdown(found, title),
                }
            )
    for text in DESCRIBED:
        expected["flows"].append(cli.find_flows(store, text))
    expected["flows"].append(cli.find_flows(store, "zebra unicorns"))
    expected["opponents"].append(cli.opponents(store, "anthropic:claude-haiku-5-5", open_only=True))
    expected["opponents"].append(cli.opponents(store, "openrouter:minimax/minimax-m3.1-flash"))
    # How they got there, asked of the steps: the process questions for each pair, their two routes through the
    # same worlds (a line per scenario, and one scenario item by item), and a verdict with a reader's own check.
    with_steps = routes.ensure(store, data)
    expected["process"] = [
        {"a": a, "b": b, "found": cli.process(store, with_steps, task, a, b)} for task, a, b in CHECKED
    ]
    expected["routes"] = [
        {
            "every": cli.route(store, with_steps, task, a, b),
            "one": cli.route(store, with_steps, task, a, b, scenario=ROUTE_SCENARIO),
        }
        for task, a, b in CHECKED
    ]
    own = {"store": with_steps, "levels": OWN_CHECK, "kinds": None}
    expected["checked"] = [
        {"checks": OWN_CHECK, "verdict": cli.verdict(store, task, a, b, profile=policy.DEFAULT_PROFILE, checks=own)}
        for task, a, b in CHECKED
    ]
    expected["conditions"] = _conditions_examples()
    sizes["expected.json"] = _dump(out / "expected.json", expected)
    return sizes
