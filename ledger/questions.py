"""The questions Ledger answers, as Cypher over the Relate graph (schema: docs/SCHEMA.md).

Each question is one Cypher statement with named parameters. They answer what a flat match report cannot,
because each one follows connections across runs: models, matches, test versions, hazards and validation.

  best_under_budget  Q1  For a workflow and a budget, which model wins most often among those that fit?
  hazard_profile     Q2  Which hazards trip which models, out of the attempts where the hazard could happen?
  beat_cycles        Q3  A beat B, B beat C, C beat A on the same test version: the ranking is not a ladder.
  promotion          Q4  Which test versions are validated, played by enough models, and separate them?
  stale_results      Q5  Which results were earned on a version that has since been replaced or forked?

Judged pairs exclude attempts that ended for reasons outside the models' control (outages, run caps).
"""

# Q1. Per model on one workflow (all versions unless stale ones are excluded by the caller): pair wins, judged
# pairs, average cost per attempt, cost per clean (passed) result. The budget is the average cost per attempt
# the user can pay. Models over budget are listed too, flagged, so the answer can say what the budget rules out.
BEST_UNDER_BUDGET = """
MATCH (t:Test {id: $test_id})<-[:VERSION_OF]-(tv:TestVersion)<-[:USED]-(mt:Match)<-[:IN]-(a:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded AND ($version_key IS NULL OR tv.key = $version_key)
OPTIONAL MATCH (mt)-[:WON_BY]->(w:Model)
WITH m.name AS model, a, mt,
     CASE WHEN w.name = m.name THEN 1 ELSE 0 END AS won,
     CASE WHEN w IS NULL THEN 1 ELSE 0 END AS tied,
     CASE WHEN a.passed THEN 1 ELSE 0 END AS ok
WITH model, count(a) AS attempts, sum(won) AS pair_wins, sum(tied) AS ties, sum(ok) AS passed,
     sum(a.cost_usd) AS spent, avg(a.cost_usd) AS cost_per_attempt, avg(a.mistakes) AS mistakes,
     avg(a.progress) AS progress, collect(DISTINCT mt.run_id) AS runs
RETURN model, attempts, pair_wins, ties, passed, cost_per_attempt,
       CASE WHEN passed = 0 THEN NULL ELSE spent / passed END AS cost_per_clean,
       mistakes, progress, cost_per_attempt <= $budget AS within_budget, runs,
       toFloat(pair_wins) / attempts AS win_rate
ORDER BY within_budget DESC, win_rate DESC, cost_per_attempt
"""

# Head-to-head between two models on one workflow: the evidence behind a pick, pair by pair.
HEAD_TO_HEAD = """
MATCH (t:Test {id: $test_id})<-[:VERSION_OF]-(tv:TestVersion)<-[:USED]-(mt:Match)
WHERE NOT mt.excluded AND ($version_key IS NULL OR tv.key = $version_key)
MATCH (mt)<-[:IN]-(:Attempt)-[:BY]->(x:Model {name: $a}), (mt)<-[:IN]-(:Attempt)-[:BY]->(y:Model {name: $b})
OPTIONAL MATCH (mt)-[:WON_BY]->(w:Model)
RETURN mt.key AS match, tv.version AS version, mt.difficulty AS difficulty, mt.rule AS rule,
       coalesce(w.name, 'tie') AS winner
ORDER BY mt.key
"""

# Q2. Hazard profile: exposure comes from the test version (it can generate the hazard), tripping from the attempt.
HAZARD_PROFILE = """
MATCH (a:Attempt)-[:BY]->(m:Model), (a)-[:IN]->(mt:Match)-[:USED]->(:TestVersion)-[:INCLUDES]->(h:Hazard)
WHERE NOT mt.excluded
OPTIONAL MATCH (a)-[t:TRIPPED_ON]->(h)
WITH m.name AS model, h.name AS hazard, count(a) AS exposed, count(t) AS tripped, sum(coalesce(t.count, 0)) AS times
RETURN model, hazard, exposed, tripped, times, toFloat(tripped) / exposed AS rate
ORDER BY hazard, rate DESC, model
"""

# Q3. Beat cycles: per test version, who beat whom by pair majority (ties dropped), then 3-cycles among them.
BEAT_CYCLES = """
MATCH (tv:TestVersion)<-[:USED]-(mt:Match)<-[:IN]-(:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded
WITH tv, mt, collect(m) AS p
OPTIONAL MATCH (mt)-[:WON_BY]->(w:Model)
WITH tv, p[0] AS x, p[1] AS y, sum(CASE WHEN w = p[0] THEN 1 WHEN w = p[1] THEN -1 ELSE 0 END) AS net
WHERE net <> 0
WITH tv, CASE WHEN net > 0 THEN x.name ELSE y.name END AS winner, CASE WHEN net > 0 THEN y.name ELSE x.name END AS loser
WITH tv, collect([winner, loser]) AS beats
UNWIND beats AS ab
UNWIND beats AS bc
UNWIND beats AS ca
WITH tv, ab, bc, ca
WHERE ab[1] = bc[0] AND bc[1] = ca[0] AND ca[1] = ab[0] AND ab[0] < bc[0] AND ab[0] < ca[0]
RETURN tv.key AS version, ab[0] AS a, bc[0] AS b, ca[0] AS c
ORDER BY version
"""

# Beat edges (for the ladder view and for explaining a cycle): per test version, pair-majority results.
BEATS = """
MATCH (tv:TestVersion)<-[:USED]-(mt:Match)<-[:IN]-(:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded
WITH tv, mt, collect(m.name) AS p
OPTIONAL MATCH (mt)-[:WON_BY]->(w:Model)
WITH tv, p[0] AS x, p[1] AS y,
     sum(CASE WHEN w.name = p[0] THEN 1 ELSE 0 END) AS x_wins,
     sum(CASE WHEN w.name = p[1] THEN 1 ELSE 0 END) AS y_wins,
     count(*) AS pairs
RETURN tv.key AS version, x AS a, y AS b, x_wins AS a_wins, y_wins AS b_wins, pairs
ORDER BY version, a, b
"""

# Q4. Promotion evidence per test version: validation (every check ok), distinct models that played it, judged
# pairs, and how often a pair had a clear winner. Thresholds are the caller's (see ledger.cli PROMOTION_RULE).
PROMOTION = """
MATCH (tv:TestVersion)
OPTIONAL MATCH (tv)-[:VALIDATED_BY]->(v:ValidationRun)
WITH tv, count(v) AS checks, sum(CASE WHEN v.ok THEN 0 ELSE 1 END) AS failed_checks
OPTIONAL MATCH (tv)<-[:USED]-(mt:Match)<-[:IN]-(:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded
WITH tv, checks, failed_checks, count(DISTINCT m) AS models, collect(DISTINCT mt) AS matches
WITH tv, checks, failed_checks, models, size(matches) AS pairs,
     size([x IN matches WHERE x.rule <> 'tie']) AS decisive
RETURN tv.key AS version, tv.test_id AS test, tv.status AS status_at_run,
       checks > 0 AND failed_checks = 0 AS validated, checks, failed_checks, models, pairs, decisive,
       CASE WHEN pairs = 0 THEN NULL ELSE toFloat(decisive) / pairs END AS decisive_share
ORDER BY validated DESC, models DESC, pairs DESC
"""

# Q5. Stale results: matches played on a version when a newer version of the same test exists, or that has been
# forked. Their results stay in the graph but should not count toward the current version.
STALE_RESULTS = """
MATCH (old:TestVersion)<-[:USED]-(mt:Match)
OPTIONAL MATCH (old)-[:VERSION_OF]->(:Test)<-[:VERSION_OF]-(newer:TestVersion)
WHERE newer.version_rank > old.version_rank
OPTIONAL MATCH (fork:TestVersion)-[:FORKED_FROM]->(old)
WITH old, count(DISTINCT mt) AS matches, collect(DISTINCT newer.version) AS newer_versions,
     collect(DISTINCT fork.key) AS forks
WHERE size(newer_versions) > 0 OR size(forks) > 0
RETURN old.key AS version, matches, newer_versions, forks
ORDER BY version
"""

ALL = {
    "best_under_budget": BEST_UNDER_BUDGET,
    "head_to_head": HEAD_TO_HEAD,
    "hazard_profile": HAZARD_PROFILE,
    "beat_cycles": BEAT_CYCLES,
    "beats": BEATS,
    "promotion": PROMOTION,
    "stale_results": STALE_RESULTS,
}
