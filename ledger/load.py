"""Write evidence into the Relate graph.

Evidence comes from bridges (ledger/bridges/): each reads one source and hands back rows in a shared shape. This
module is the only place that writes to the graph. Every write is a MERGE on a stable key behind a uniqueness
constraint, so loading the same evidence again changes nothing, and each run and validation check is linked to
the source it came from.

Graph (docs/SCHEMA.md):
  (:Source)         where evidence came from (one per bridge)
  (:Run)            one record: suite, date, cap, spend, seal
  (:Match)          one paired attempt: both models played the same generated world
  (:Attempt)        one side of a match
  (:Model) (:Test) (:TestVersion) (:Hazard)
  (:Benchmark)      a published benchmark or index (from the epoch bridge)
  (Run)-[:FROM]->(Source)            (ValidationRun)-[:FROM]->(Source)   (Benchmark)-[:FROM]->(Source)
  (Model)-[:SCORED {score, low, high}]->(Benchmark)   a published score; used only to find close opponents
  (Match)-[:PART_OF]->(Run)          (Match)-[:USED]->(TestVersion)    (TestVersion)-[:VERSION_OF]->(Test)
  (Attempt)-[:IN]->(Match)           (Attempt)-[:BY]->(Model)          (Match)-[:WON_BY]->(Model)  (absent = tie)
  (TestVersion)-[:INCLUDES]->(Hazard) (Attempt)-[:TRIPPED_ON {count}]->(Hazard)
  (:Fault)          something a model did wrong on an attempt: fell for a hazard, a wrong decision, work left
                    undone, stopped before finishing (kind: trap, decision, mix-up, ending)
  (TestVersion)-[:CAN_SHOW]->(Fault)  (Attempt)-[:MADE {count}]->(Fault)
  (Fault)-[:KIND_OF]->(Fault)         a test's specific mix-up is a kind of "wrong decision"
  (Fault)-[:FALLS_FOR]->(Hazard)      the fault of falling for that hazard
  (TestVersion)-[:FORKED_FROM]->(TestVersion)
  (TestVersion)-[:VALIDATED_BY]->(:ValidationRun)-[:GUARDS]->(Hazard)
     one ValidationRun per level and player of a validation record: the reference player must pass every seed;
     each corner-cutting player must fail where its hazard is present.
"""

from pathlib import Path

import relate

from ledger.bridges import Evidence, epoch, gladiator
from ledger.bridges.gladiator import seal_ok  # noqa: F401  (re-exported: the seal check other modules use)

SCHEMA = [
    "CREATE CONSTRAINT run_id IF NOT EXISTS FOR (n:Run) REQUIRE n.run_id IS UNIQUE",
    "CREATE CONSTRAINT match_key IF NOT EXISTS FOR (n:Match) REQUIRE n.key IS UNIQUE",
    "CREATE CONSTRAINT attempt_key IF NOT EXISTS FOR (n:Attempt) REQUIRE n.key IS UNIQUE",
    "CREATE CONSTRAINT model_name IF NOT EXISTS FOR (n:Model) REQUIRE n.name IS UNIQUE",
    "CREATE CONSTRAINT test_id IF NOT EXISTS FOR (n:Test) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT version_key IF NOT EXISTS FOR (n:TestVersion) REQUIRE n.key IS UNIQUE",
    "CREATE CONSTRAINT hazard_name IF NOT EXISTS FOR (n:Hazard) REQUIRE n.name IS UNIQUE",
    "CREATE CONSTRAINT fault_key IF NOT EXISTS FOR (n:Fault) REQUIRE n.key IS UNIQUE",
    "CREATE CONSTRAINT validation_key IF NOT EXISTS FOR (n:ValidationRun) REQUIRE n.key IS UNIQUE",
    "CREATE CONSTRAINT source_name IF NOT EXISTS FOR (n:Source) REQUIRE n.name IS UNIQUE",
    "CREATE CONSTRAINT benchmark_name IF NOT EXISTS FOR (n:Benchmark) REQUIRE n.name IS UNIQUE",
    # Keyword search over what each workflow asks for ("describe your flow, find the closest tested one").
    "CREATE FULLTEXT INDEX flow_text IF NOT EXISTS FOR (n:TestVersion) ON EACH [n.title, n.brief, n.policy]",
]

WRITE_VALIDATIONS = """
UNWIND $checks AS c
MERGE (tv:TestVersion {key: c.version_key})
SET tv += c.version
MERGE (tst:Test {id: c.version.test_id})
MERGE (tv)-[:VERSION_OF]->(tst)
MERGE (v:ValidationRun {key: c.key})
SET v += c.props
MERGE (tv)-[:VALIDATED_BY]->(v)
MERGE (src:Source {name: $source.name})
SET src.description = $source.description
MERGE (v)-[:FROM]->(src)
WITH v, c
FOREACH (h IN CASE WHEN c.hazard IS NULL THEN [] ELSE [c.hazard] END |
  MERGE (hz:Hazard {name: h}) MERGE (v)-[:GUARDS]->(hz))
"""

WRITE = """
UNWIND $runs AS r
MERGE (run:Run {run_id: r.run_id})
SET run += r.props
MERGE (src:Source {name: $source.name})
SET src.description = $source.description
MERGE (run)-[:FROM]->(src)
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

# Which hazards each test version includes (its grader counts them), stated once per run and version.
WRITE_INCLUDES = """
UNWIND $runs AS r
UNWIND r.includes AS i
MATCH (tv:TestVersion {key: i.version_key})
MERGE (hz:Hazard {name: i.name})
MERGE (tv)-[:INCLUDES]->(hz)
"""

# Faults are written after the runs (WRITE creates the attempts and test versions they attach to): first the
# faults each test version can show, then the ones each attempt made.
WRITE_FAULTS = """
UNWIND $runs AS r
UNWIND r.can_show AS f
MATCH (tv:TestVersion {key: f.version_key})
MERGE (ft:Fault {key: f.key})
SET ft.name = f.name, ft.kind = f.kind
MERGE (tv)-[:CAN_SHOW]->(ft)
FOREACH (t IN CASE WHEN f.test_id IS NULL THEN [] ELSE [f.test_id] END | SET ft.test_id = t)
FOREACH (p IN CASE WHEN f.kind_of IS NULL THEN [] ELSE [f.kind_of] END |
  MERGE (parent:Fault {key: p}) MERGE (ft)-[:KIND_OF]->(parent))
FOREACH (h IN CASE WHEN f.hazard IS NULL THEN [] ELSE [f.hazard] END |
  MERGE (hz:Hazard {name: h}) MERGE (ft)-[:FALLS_FOR]->(hz))
"""

WRITE_MADE = """
UNWIND $runs AS r
UNWIND r.made AS x
MATCH (att:Attempt {key: x.attempt})
MATCH (ft:Fault {key: x.fault})
MERGE (att)-[made:MADE]->(ft)
SET made.count = x.count
"""

WRITE_SCORES = """
UNWIND $scores AS s
MERGE (b:Benchmark {name: s.benchmark})
SET b += s.benchmark_props
MERGE (src:Source {name: $source.name})
SET src.description = $source.description
MERGE (b)-[:FROM]->(src)
MERGE (m:Model {name: s.model})
SET m += s.model_props
MERGE (m)-[r:SCORED]->(b)
SET r += s.props
"""


def write(evidence: Evidence, store: str) -> dict:
    """Write one bridge's evidence to the store. Safe to repeat: the second time creates nothing."""
    stats = {}
    with relate.connect(store) as conn:
        for statement in SCHEMA:
            conn.execute(statement)
        source = {"name": evidence.source, "description": evidence.description}
        if evidence.runs:
            stats["runs"] = conn.execute(WRITE, {"runs": evidence.runs, "source": source}).stats
            if any(r.get("includes") for r in evidence.runs):
                conn.execute(WRITE_INCLUDES, {"runs": evidence.runs})
            if any(r.get("can_show") for r in evidence.runs):
                faults = conn.execute(WRITE_FAULTS, {"runs": evidence.runs}).stats
                made = conn.execute(WRITE_MADE, {"runs": evidence.runs}).stats
                stats["faults"] = {k: faults[k] + made[k] for k in ("nodes_created", "relationships_created")}
        if evidence.checks:
            stats["checks"] = conn.execute(WRITE_VALIDATIONS, {"checks": evidence.checks, "source": source}).stats
        if evidence.scores:
            stats["scores"] = conn.execute(WRITE_SCORES, {"scores": evidence.scores, "source": source}).stats
    return stats


def load(records_root: Path, store: str) -> dict:
    """Load every sealed Gladiator match record under records_root. Returns a short summary."""
    evidence = gladiator.read_records(records_root)
    stats = write(evidence, store)
    return {
        "loaded": len(evidence.runs),
        "skipped_bad_seal": evidence.skipped,
        "stats": stats.get("runs", {}),
        "fault_stats": stats.get("faults", {}),
    }


def load_validations(root: Path, store: str) -> dict:
    """Load Gladiator validation records (validations/**/*.json)."""
    evidence = gladiator.read_validations(root)
    stats = write(evidence, store)
    return {
        "loaded": evidence.records,
        "checks": len(evidence.checks),
        "skipped_bad_seal": evidence.skipped,
        "stats": stats.get("checks", {}),
    }


def load_scores(root: Path, store: str) -> dict:
    """Load published scores (Epoch's Capabilities Index file under root)."""
    evidence = epoch.read_scores(root)
    stats = write(evidence, store)
    return {"loaded": len(evidence.scores), "skipped": evidence.skipped, "stats": stats.get("scores", {})}


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
