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

from ledger import cli, policy, questions, spec

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
   attempts"). For the head to head, report the verdict word exactly: "better" is settled; "leaning" is ahead but
   could be chance; "no real difference shown" and "not enough evidence" name no winner. When neither is fit,
   offer the models in `fit_on_task`; if that is empty, say no tested model is fit and do not guess at one.
4. spec: the build plan (decision, blueprint, evidence) as Markdown. Offer it once there is a verdict.

Rules that are not optional:
- Make task claims only. Never say a model is better in general, and never rank models by a published score.
- Never name a winner the verdict does not name. If two models have not met on a task, say no match has been
  played; do not infer a result from other tasks or other opponents.
- A result holds for the task as tested, in a simulated world, under the recorded settings. Say so when asked
  whether it will hold in production.
- Cite the evidence: the run ids returned with a verdict are sealed match records anyone can check.
- read_graph runs read-only Cypher for questions the other tools do not cover. Call describe_graph first.
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
Match{key, rule (success|progress|efficiency|tie|excluded), excluded, difficulty},
Attempt{key, passed, mistakes, progress, cost_usd, wall_s, tokens, effort}, Model{name, display_name, weights,
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

    @server.tool(title="Verdict: which of two models did this task better")
    def verdict(
        task: str,
        model_a: str,
        model_b: str,
        tolerance: str = policy.DEFAULT_PROFILE,
        own_levels: dict[str, str] | None = None,
        good_enough_bar: float = cli.GOOD_ENOUGH,
    ) -> dict[str, Any]:
        """Fit first, then head to head. `headline` is the answer to act on and `use` the model to use (null when
        there is none). `fit` says for each model whether it is fit for the task under `tolerance` (enterprise or
        personal), counting every attempt it made on the task, with the reasons and each fault's level and count.
        `own_levels` overrules the level of any fault by name, e.g. {"left undone": "unforgivable"} (levels:
        unforgivable, serious, minor). The head to head counts only the pairs where these two met: verdict
        (better, leaning, no real difference shown, not enough evidence, or no data), pair counts, how pairs were
        decided, cost and time, and the sealed match records. `fit_on_task` lists every tested model that is fit."""
        return cli.verdict(
            store,
            task,
            model_id(model_a),
            model_id(model_b),
            bar=good_enough_bar,
            profile=tolerance,
            overrides=own_levels,
        )

    @server.tool(title="Spec: the build plan from one task and two models")
    def write_spec(
        task: str,
        model_a: str,
        model_b: str,
        tolerance: str = policy.DEFAULT_PROFILE,
        own_levels: dict[str, str] | None = None,
        good_enough_bar: float = cli.GOOD_ENOUGH,
    ) -> str:
        """One Markdown document in three layers: the decision, the blueprint (the job and rules as tested, the
        tools, the settings the result holds for, a guardrail and an autonomy call for each hazard) and the
        evidence. Ends with the same content as JSON."""
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
        return spec.markdown(spec.build(lambda q, p: cli.rows(store, q, p), found))

    @server.tool(title="Describe the graph: nodes, relationships and the ready-made questions")
    def describe_graph() -> dict[str, Any]:
        """What is in the Relate graph and which named Cypher questions exist. Read this before read_graph."""
        counts = cli.rows(store, "MATCH (n) RETURN labels(n)[0] AS kind, count(*) AS n ORDER BY kind")
        return {"graph": GRAPH, "counts": counts, "named_questions": sorted(questions.ALL)}

    @server.tool(title="Read the graph with Cypher (read-only)")
    def read_graph(
        cypher: str = "", named_question: str = "", parameters: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Run one read-only Cypher statement, or one of the named questions from describe_graph (pass its name
        in `named_question`). The store is opened read-only, so a statement that writes fails. At most 200 rows
        come back; `truncated` says when there were more."""
        if named_question:
            if named_question not in questions.ALL:
                return {"error": f"No question named {named_question!r}.", "named_questions": sorted(questions.ALL)}
            cypher = questions.ALL[named_question]
            parameters = {**cli.SCOPE_DEFAULTS, **(parameters or {})}
        if not cypher.strip():
            return {"error": "Give `cypher` or `named_question`."}
        try:
            found = cli.rows(store, cypher, parameters or {})
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
