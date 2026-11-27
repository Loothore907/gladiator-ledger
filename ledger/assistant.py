"""Ledger for AI assistants: an MCP server over the Relate store.

Start it with `ledger mcp` (stdio). An assistant connected to it can walk the whole loop for a person in plain
language: find the tested workflow closest to what they describe, suggest a fair opponent for a model they name,
say which of two models did that task better and how sure that is, and write the spec.

The tools return the same answers as the command line, computed by the same code over the same graph. The store is
opened read-only: nothing an assistant asks can change it. Instructions sent to the assistant (INSTRUCTIONS below)
carry Ledger's rules, so it says "leaning" where the evidence says leaning and never invents a winner.
"""

from typing import Any

import relate
from mcp.server.mcpserver import MCPServer

from ledger import cli, policy, questions, reports, routes, spec

INSTRUCTIONS = """\
Gladiator Ledger answers one question: of two AI models, which does THIS task better, how sure is that, and what
should be built? Its evidence is head-to-head matches: two models play the same freshly generated worlds of a
tool-using workflow, and each pair of attempts is judged (success first, then efficiency or progress).

Walk the person through this loop, one step at a time:
1. find_flows: turn what they describe into the closest tested workflow. If nothing matches, say so and show what
   exists. Never pretend a workflow matches.
2. who_has_played and suggest_opponents: help them pick two models. suggest_opponents uses a published index only
   to find models that are close on paper, so the head-to-head is fair.
3. verdict: first whether each model is fit for this task at all, then which did it better head to head. Lead
   with `headline` exactly as returned: it already reads the head to head through fitness (a model can win head
   to head and still not be fit). Fitness depends on whose tolerance applies: ask whether this is for a business
   running it unattended (enterprise) or for one person (personal), and whether any fault is unforgivable for
   them; pass those as `tolerance` and `own_levels`. Give each model's reasons and counts ("in 1 of 54
   attempts"). Fitness has two parts, and they are not the same thing: `right` is the attempts whose RESULT was
   right (every decision right, nothing left undone), and the bar applies to that; `passed` is the smaller count
   the test itself passed, which also asks for its process. Never call a model unfit, or say it "failed", because
   `passed` is low: a lapse of process is a fault with a level, and the person decides whether it matters. The
   notes say when scenarios were won on process alone; pass that on. For the head to head, report the verdict word exactly: "better" is settled; "leaning" is ahead but
   could be chance; "no real difference shown" and "not enough evidence" name no winner. A fit call waits
   for the count to settle it: `fit` is true or false only then. When it is null, `so_far` says what the
   attempts show ("meets" or "short" of the bar) and you must say it that way ("meets the bar so far, on 9
   attempts: too few to be sure"), never as fit or unfit, and never recommend a model on it. When neither is fit,
   offer the models in `fit_on_task`; if that is empty, say no tested model has been shown fit and do not guess
   at one.
   How a model WORKED is in the graph too, step by step. how_they_worked asks process questions of every step
   on file (did it decide an item before it had seen a record the item depends on; did it repeat a timed-out
   action without checking), and gives each count beside the grader's own where the grader has one. A count is
   a fact, not a fault: whether it matters is the person's call. If it matters to them, pass it to verdict as
   `own_checks` with the level they choose, and it is judged like any other fault. same_world lays two models'
   routes through one scenario side by side, item by item: use it to show where they parted ways.
4. spec: the build plan (decision, blueprint, cost, evidence) as Markdown, and with report="cost" or "evidence" the two reports that go with it. Offer it once there is a verdict.

Rules that are not optional:
- Make task claims only. Never say a model is better in general, and never rank models by a published score.
- Never name a winner the verdict does not name. If two models have not met on a task, say no match has been
  played; do not infer a result from other tasks or other opponents.
- A result holds for the task as tested, in a simulated world, under the recorded settings. Say so when asked
  whether it will hold in production.
- Cite the evidence: the run ids returned with a verdict are sealed match records anyone can check.
- read_graph runs read-only Cypher for questions the other tools do not cover. Call describe_graph first.
  With `steps` true it reads the store that also holds every step, so you can write your own pattern over a
  model's route; keep such a question to one test version or one match, since there are tens of thousands of steps.
"""

MODELS_ON_FLOW = """
MATCH (t:Test {id: $test_id})<-[:VERSION_OF]-(tv:TestVersion {key: $version_key})<-[:USED]-(mt:Match)
      <-[:IN]-(:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded
RETURN m.name AS model, m.display_name AS display_name, m.weights AS weights, count(DISTINCT mt) AS pairs
ORDER BY pairs DESC, model
"""

PARTNERS_ON_FLOW = """
MATCH (t:Test {id: $test_id})<-[:VERSION_OF]-(tv:TestVersion {key: $version_key})<-[:USED]-(mt:Match)
      <-[:IN]-(:Attempt)-[:BY]->(:Model {name: $model}),
      (mt)<-[:IN]-(:Attempt)-[:BY]->(o:Model)
WHERE NOT mt.excluded AND o.name <> $model
RETURN o.name AS model, o.display_name AS display_name, count(DISTINCT mt) AS pairs_against_it
ORDER BY pairs_against_it DESC, model
"""

GRAPH = """\
Nodes: Source{name}, Run{run_id, suite, effort, attempt_budget_usd, engine_commit, seal_sha256},
Match{key, rule (success|progress|efficiency|tie|excluded), excluded, difficulty, conditions (the settings,
difficulty and scoring it was played under: only pairs with equal conditions are comparable)},
Attempt{key, passed (right result and right process), task_correct (the result alone), mistakes, progress,
cost_usd, wall_s, tokens, effort}, Model{name, display_name, weights,
organization}, Test{id}, TestVersion{key, version, version_rank, title, brief, policy, tools, emulates},
Hazard{name}, Fault{key, name, kind (trap|decision|mix-up|ending), test_id}, ValidationRun{key, level, player, ok},
Benchmark{name}.
Relationships: (Run)-[:FROM]->(Source), (Match)-[:PART_OF]->(Run), (Match)-[:USED]->(TestVersion),
(TestVersion)-[:VERSION_OF]->(Test), (Attempt)-[:IN]->(Match), (Attempt)-[:BY]->(Model),
(Match)-[:WON_BY]->(Model) (absent for a tie), (TestVersion)-[:INCLUDES]->(Hazard),
(Attempt)-[:TRIPPED_ON {count}]->(Hazard), (TestVersion)-[:CAN_SHOW]->(Fault), (Attempt)-[:MADE {count}]->(Fault)
(a fault is anything the grader says the model did wrong: fell for a hazard, a wrong decision, a task-specific
mix-up, work left undone, stopped before finishing), (Fault)-[:KIND_OF]->(Fault), (Fault)-[:FALLS_FOR]->(Hazard),
(TestVersion)-[:VALIDATED_BY]->(ValidationRun),
(ValidationRun)-[:GUARDS]->(Hazard), (Model)-[:SCORED {score, low, high}]->(Benchmark), (Benchmark)-[:FROM]->(Source).
A Match is one PAIR: both models' attempts on the same generated world. Always filter `NOT mt.excluded`.
Steps (only in the store read with `steps` true): Step{key, n (its place in the attempt, from 1), tool, kind
(read|check|act|end|talk), state (ok|timeout|refused), at_s, item}, Item{key, id, kind}: one record of a generated
world, e.g. a refund request, its order, the order's customer. (Attempt)-[:TOOK]->(Step), (Step)-[:NEXT]->(Step)
in order, (Step)-[:SAW]->(Item) (its answer showed the record), (Step)-[:DECIDED]->(Item) (it acted on it; the
tool is the decision), (Step)-[:CHECKED]->(Item), (Step)-[:TOLD_OF {notice}]->(Item) (a notice said the record
changed), (Item)-[:REFERS_TO {field}]->(Item) as the world's answers show it, (Item)-[:IN]->(Match): the two
attempts of a match share the world's items, so their routes can be compared item by item.
Model names are exact ids such as anthropic:claude-haiku-5-5; models known only from the published index are
named epoch:<name> and have no matches.
"""

ROW_LIMIT = 200


def build(store: str) -> MCPServer:
    """The server, bound to one store. Every tool opens the store read-only for the length of one call."""
    server = MCPServer(
        "gladiator-ledger",
        title="Gladiator Ledger",
        description="Which of two AI models does this task better, how sure is that, and what should be built.",
        instructions=INSTRUCTIONS,
        website_url="https://github.com/Loothore907/gladiator-ledger",
    )

    def model_id(name: str) -> str:
        return cli.resolve_model(store, name) or name

    @server.tool(title="Find the tested workflow closest to a described flow")
    def find_flows(description: str = "") -> dict[str, Any]:
        """Keyword search (a Relate full-text index) over every tested workflow's title, brief and rules, then
        along the graph to how many models and judged pairs stand behind each. `matched` is false when nothing
        fits; the list is then every tested workflow. Leave `description` empty to list them all."""
        return cli.find_flows(store, description or None)

    @server.tool(title="Models that have played a workflow, and who a model has met on it")
    def who_has_played(task: str, model: str = "") -> dict[str, Any]:
        """`task` is a test id such as refund-queue. Without `model`: every model with judged pairs on the task.
        With `model`: the opponents it has met on this task, with the number of pairs. Only two models that have
        met on a task can get a verdict."""
        test = cli.test_id(task)
        version = cli.current_version(store, test)
        if version is None:
            return {"task": test, "note": f"No judged matches on {test}.", "models": []}
        params = {"test_id": test, "version_key": version}
        if not model:
            return {"task": test, "version": version, "models": cli.rows(store, MODELS_ON_FLOW, params)}
        key = model_id(model)
        met = cli.rows(store, PARTNERS_ON_FLOW, dict(params, model=key))
        return {"task": test, "version": version, "model": key, "has_met": met}

    @server.tool(title="Suggest a fair opponent: models that score close on a published index")
    def suggest_opponents(model: str, open_weights_only: bool = False, how_many: int = 5) -> dict[str, Any]:
        """Models nearest to `model` on Epoch AI's Capabilities Index (CC BY 4.0), whether the two score ranges
        overlap, and what the graph already knows about each (matches played, pairs already played against it).
        A close score only makes a head-to-head fair. It is never a reason to prefer a model."""
        return cli.opponents(store, model, open_weights_only, max(1, min(how_many, 25)))

    def own(checks: dict[str, str] | None, needs: list[str] | None = None) -> dict | None:
        """A person's own process questions for a verdict: checked, and bound to the store that holds the steps."""
        if not checks:
            return None
        for name, level in checks.items():
            if name not in routes.CHECKS or level not in policy.LEVELS:
                raise ValueError(
                    f"own_checks maps a question ({', '.join(routes.CHECKS)}) to a level ({', '.join(policy.LEVELS)})"
                )
        return {"store": routes.ensure(store), "levels": dict(checks), "kinds": needs or None}

    @server.tool(title="How they worked: process questions asked of every step on file")
    def how_they_worked(
        task: str, model_a: str = "", model_b: str = "", question: str = "", needs: list[str] | None = None
    ) -> dict[str, Any]:
        """Every attempt is a route through a small world of records, held in the graph step by step. Each
        question is one Cypher pattern over those steps (returned as `cypher`), counted per model on the task:
        `attempts`, the attempts where it was found (`attempts_with`), how often in all (`times`), and of the
        attempts with it how many still got every decision right (`right_with`) and how many the test passed
        (`passed_with`). `grader_attempts_with` is Gladiator's own count where its grader counts the same thing.
        `decisions_need` says what a decision on this task depends on, as the worlds on file show it. Name two
        models for the scope of their verdict, one model or none for the task's own record; `question` keeps it
        to one question, `needs` to some kinds of record (e.g. ["customer"]). The first call loads the steps from
        the sealed records, which takes about a minute."""
        if question and question not in routes.CHECKS:
            return {
                "error": f"No question named {question!r}.",
                "questions": {k: v["asks"] for k, v in routes.CHECKS.items()},
            }
        a, b = (model_id(m) if m else None for m in (model_a, model_b))
        return cli.process(store, routes.ensure(store), task, a, b, [question] if question else None, needs or None)

    @server.tool(title="The same world, two routes: where two models parted ways")
    def same_world(task: str, model_a: str, model_b: str, scenario: int = 0) -> dict[str, Any]:
        """Two models played the same generated world, so their routes can be laid side by side. Without
        `scenario`: one line per scenario their verdict counts (who won it, on how many items they decided
        differently, and how many items each decided before seeing a record the item depends on). With
        `scenario` (1 is the first): that world item by item, each model's decision, the step it was made at, and
        which of the records the item depends on the model had seen by then."""
        steps = routes.ensure(store)
        return cli.route(store, steps, task, model_id(model_a), model_id(model_b), scenario or None)

    @server.tool(title="Verdict: which of two models did this task better")
    def verdict(
        task: str,
        model_a: str,
        model_b: str,
        tolerance: str = policy.DEFAULT_PROFILE,
        own_levels: dict[str, str] | None = None,
        good_enough_bar: float | None = None,
        own_checks: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Fit first, then head to head. `headline` is the answer to act on and `use` the model to use (null when
        there is none). `fit` says for each model whether it is fit for the task under `tolerance` (enterprise or
        personal), counting every attempt it made on the task, with the reasons and each fault's level and count:
        `right` of `attempts` had the right result (the bar applies to `right_rate`), and `passed` of them also
        followed the process the test asks for.
        `own_levels` overrules the level of any fault by name, e.g. {"left undone": "unforgivable"} (levels:
        unforgivable, serious, minor). The head to head counts only the pairs where these two met: verdict
        (better, leaning, no real difference shown, not enough evidence, or no data), pair counts, how pairs were
        decided, cost and time, and the sealed match records. `fit_on_task` lists every tested model that is fit.
        `own_checks` adds process questions from how_they_worked as faults at a level the person chooses, e.g.
        {"decided-before-seeing": "serious"}: counted from the steps and judged like any other fault."""
        return cli.verdict(
            store,
            task,
            model_id(model_a),
            model_id(model_b),
            bar=good_enough_bar,
            profile=tolerance,
            overrides=own_levels,
            checks=own(own_checks),
        )

    @server.tool(title="Spec: the build plan from one task and two models")
    def write_spec(
        task: str,
        model_a: str,
        model_b: str,
        tolerance: str = policy.DEFAULT_PROFILE,
        own_levels: dict[str, str] | None = None,
        good_enough_bar: float | None = None,
        report: str = "spec",
    ) -> str:
        """One Markdown document in four layers: the decision, the blueprint (the job and rules as tested, the
        tools, the settings the result holds for, a guardrail for each hazard it tripped on), the cost
        and the evidence. `report` picks the document: "spec" (default), "data" (the spec as JSON),
        "cost" (the cost breakdown, scenario by scenario), "evidence" (fitness with every fault, every
        scenario and its sealed record) or "all" (the three, one after another)."""
        found = cli.verdict(
            store,
            task,
            model_id(model_a),
            model_id(model_b),
            bar=good_enough_bar,
            profile=tolerance,
            overrides=own_levels,
        )
        found["suite"] = None
        built = spec.build(lambda q, p: cli.rows(store, q, p), found)
        title = (built.get("blueprint") or {}).get("title") or built["task"]
        docs = {
            "spec": lambda: spec.markdown(built),
            "cost": lambda: reports.cost_markdown(found, title),
            "evidence": lambda: reports.evidence_markdown(found, title),
        }
        if report == "all":
            return "\n\n".join(write() for write in docs.values())
        if report == "data":  # the spec as data, for a program: no longer printed at the end of the document
            return spec.as_json(built)
        if report not in docs:
            raise ValueError(f"report must be one of spec, data, cost, evidence, all (got {report!r})")
        return docs[report]()

    @server.tool(title="Describe the graph: nodes, relationships and the ready-made questions")
    def describe_graph() -> dict[str, Any]:
        """What is in the Relate graph and which named Cypher questions exist. Read this before read_graph."""
        counts = cli.rows(store, "MATCH (n) RETURN labels(n)[0] AS kind, count(*) AS n ORDER BY kind")
        return {
            "graph": GRAPH,
            "counts": counts,
            "named_questions": sorted(questions.ALL),
            "step_questions": sorted(cli.STEP_QUESTIONS),
        }

    @server.tool(title="Read the graph with Cypher (read-only)")
    def read_graph(
        cypher: str = "", named_question: str = "", parameters: dict[str, Any] | None = None, steps: bool = False
    ) -> dict[str, Any]:
        """Run one read-only Cypher statement, or one of the named questions from describe_graph (pass its name
        in `named_question`). The store is opened read-only, so a statement that writes fails. At most 200 rows
        come back; `truncated` says when there were more. `steps` true reads the store that also holds every
        step and world record (the named `step_questions` always do); its first use loads them, about a minute."""
        if named_question:
            if named_question not in questions.ALL:
                return {"error": f"No question named {named_question!r}.", "named_questions": sorted(questions.ALL)}
            cypher = questions.ALL[named_question]
            parameters = {**cli.SCOPE_DEFAULTS, **(parameters or {})}
        if not cypher.strip():
            return {"error": "Give `cypher` or `named_question`."}
        try:
            asked = routes.ensure(store) if steps or named_question in cli.STEP_QUESTIONS else store
            found = cli.rows(asked, cypher, parameters or {})
        except relate.Error as exc:  # the engine's message is the useful part for the assistant
            return {"error": f"{type(exc).__name__}: {exc}"}
        return {"rows": found[:ROW_LIMIT], "row_count": len(found), "truncated": len(found) > ROW_LIMIT}

    @server.prompt(title="Choose a model for a workflow")
    def choose_a_model(flow: str = "") -> str:
        """Start the loop: describe a flow, pick two models, get a verdict and a spec."""
        about = f"My workflow: {flow}\n\n" if flow else ""
        return (
            f"{about}Help me choose between two AI models for this workflow using Gladiator Ledger. Find the "
            "closest tested workflow, help me pick two models that have met on it (suggest a fair opponent if I "
            "only name one), give me the verdict in plain words with the evidence, and then write the spec."
        )

    return server


def serve(store: str) -> None:
    """Run the server on stdio until the client disconnects."""
    build(store).run("stdio")
