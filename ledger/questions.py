"""The questions Ledger answers, as Cypher over the Relate graph (schema: docs/SCHEMA.md).

Each question is one Cypher statement with named parameters. They answer what a flat match report cannot,
because each one follows connections across runs: models, matches, test versions, hazards and validation.

  best_under_budget  Q1  For a workflow and a budget, which model wins most often among those that fit?
  hazard_profile     Q2  Which hazards trip which models, out of the attempts where the hazard could happen?
  beat_cycles        Q3  A beat B, B beat C, C beat A on the same test version: the ranking is not a ladder.
  promotion          Q4  Which test versions are validated, played by enough models, and separate them?
  stale_results      Q5  Which results were earned on a version that has since been replaced or forked?

  pair_on_task           One task, two models: every pair where they met, with both sides' facts.
  pair_hazards           The hazards each of those two models met and tripped on, in those pairs.
  find_flow              Describe your flow: the tested workflows whose text matches your words best.
  flows                  Every tested workflow (newest versions).
  flow_as_tested         The text, tools and settings a workflow was tested with (what a spec is built from).
  close_to               Which models score closest to this one on a published benchmark (to pick an opponent).
  sources                Where the evidence came from: each bridge, and how much it contributed.

Judged pairs exclude attempts that ended for reasons outside the models' control (outages, run caps).
"""

# Scope parameters shared by Q1 and head-to-head (pass every one; null means "any"):
#   $test_id one workflow, $suite every workflow in runs of that suite, $version_key one exact version,
#   $current_only only versions with no newer version of the same test.
# Q1. Per model in that scope: pair wins, judged pairs, average cost per attempt, cost per clean (passed) result. The budget is the average cost per attempt
# the user can pay. Models over budget are listed too, flagged, so the answer can say what the budget rules out.
BEST_UNDER_BUDGET = """
MATCH (t:Test)<-[:VERSION_OF]-(tv:TestVersion)<-[:USED]-(mt:Match)-[:PART_OF]->(r:Run),
      (mt)<-[:IN]-(a:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded
  AND ($test_id IS NULL OR t.id = $test_id)
  AND ($suite IS NULL OR r.suite = $suite)
  AND ($version_key IS NULL OR tv.key = $version_key)
  AND (NOT $current_only OR NOT EXISTS {
        MATCH (tv)-[:VERSION_OF]->(:Test)<-[:VERSION_OF]-(newer:TestVersion) WHERE newer.version_rank > tv.version_rank })
OPTIONAL MATCH (mt)-[:WON_BY]->(w:Model)
WITH m.name AS model, a, mt, tv,
     CASE WHEN w.name = m.name THEN 1 ELSE 0 END AS won,
     CASE WHEN w IS NULL THEN 1 ELSE 0 END AS tied,
     CASE WHEN a.passed THEN 1 ELSE 0 END AS ok
WITH model, count(a) AS attempts, sum(won) AS pair_wins, sum(tied) AS ties, sum(ok) AS passed,
     sum(a.cost_usd) AS spent, avg(a.cost_usd) AS cost_per_attempt, avg(a.mistakes) AS mistakes,
     avg(a.progress) AS progress, collect(DISTINCT mt.run_id) AS runs, collect(DISTINCT tv.key) AS versions
RETURN model, attempts, pair_wins, ties, passed, cost_per_attempt, versions,
       CASE WHEN passed = 0 THEN NULL ELSE spent / passed END AS cost_per_clean,
       mistakes, progress, cost_per_attempt <= $budget AS within_budget, runs,
       toFloat(pair_wins) / attempts AS win_rate
ORDER BY within_budget DESC, win_rate DESC, cost_per_attempt
"""

# Head-to-head between two models on one workflow: the evidence behind a pick, pair by pair.
HEAD_TO_HEAD = """
MATCH (t:Test)<-[:VERSION_OF]-(tv:TestVersion)<-[:USED]-(mt:Match)-[:PART_OF]->(r:Run)
WHERE NOT mt.excluded
  AND ($test_id IS NULL OR t.id = $test_id)
  AND ($suite IS NULL OR r.suite = $suite)
  AND ($version_key IS NULL OR tv.key = $version_key)
  AND (NOT $current_only OR NOT EXISTS {
        MATCH (tv)-[:VERSION_OF]->(:Test)<-[:VERSION_OF]-(newer:TestVersion) WHERE newer.version_rank > tv.version_rank })
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

# Q3. Beat cycles: per test version, who beat whom by pair majority (ties dropped), then 3-cycles among them,
# with each edge's pair score (a cycle of 2-1 wins is weak evidence; one of 6-0 wins is not). $suite limits it to
# matches from one suite (suites can share test versions but play them under different settings).
BEAT_CYCLES = """
MATCH (tv:TestVersion)<-[:USED]-(mt:Match)-[:PART_OF]->(r:Run), (mt)<-[:IN]-(:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded AND ($suite IS NULL OR r.suite = $suite)
WITH tv, mt, collect(m) AS p
OPTIONAL MATCH (mt)-[:WON_BY]->(w:Model)
WITH tv, p[0] AS x, p[1] AS y,
     sum(CASE WHEN w = p[0] THEN 1 ELSE 0 END) AS xw, sum(CASE WHEN w = p[1] THEN 1 ELSE 0 END) AS yw
WHERE xw <> yw
WITH tv, CASE WHEN xw > yw THEN [x.name, y.name, xw, yw] ELSE [y.name, x.name, yw, xw] END AS beat
WITH tv, collect(beat) AS beats
UNWIND beats AS ab
UNWIND beats AS bc
UNWIND beats AS ca
WITH tv, ab, bc, ca
WHERE ab[1] = bc[0] AND bc[1] = ca[0] AND ca[1] = ab[0] AND ab[0] < bc[0] AND ab[0] < ca[0]
RETURN tv.key AS version, ab[0] AS a, bc[0] AS b, ca[0] AS c,
       [toString(ab[2]) + '-' + toString(ab[3]), toString(bc[2]) + '-' + toString(bc[3]),
        toString(ca[2]) + '-' + toString(ca[3])] AS margins,
       [ab[2] - ab[3], bc[2] - bc[3], ca[2] - ca[3]] AS leads
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

# One task, two models: every judged pair where exactly these two met on this task, with both sides' facts.
# This is the unit Ledger's claims are made of: a task claim ("A does this task better than B"), never a
# general claim about a model.
PAIR_ON_TASK = """
MATCH (t:Test {id: $test_id})<-[:VERSION_OF]-(tv:TestVersion)<-[:USED]-(mt:Match)-[:PART_OF]->(r:Run),
      (mt)<-[:IN]-(xa:Attempt)-[:BY]->(:Model {name: $a}),
      (mt)<-[:IN]-(xb:Attempt)-[:BY]->(:Model {name: $b})
WHERE NOT mt.excluded
  AND ($suite IS NULL OR r.suite = $suite)
  AND ($version_key IS NULL OR tv.key = $version_key)
OPTIONAL MATCH (mt)-[:WON_BY]->(w:Model)
RETURN mt.key AS match, r.run_id AS run, r.seal_sha256 AS seal, r.engine_commit AS engine, r.suite AS suite,
       tv.key AS version, mt.difficulty AS difficulty, mt.rule AS rule, coalesce(w.name, 'tie') AS winner,
       xa.passed AS a_passed, xa.cost_usd AS a_cost, xa.wall_s AS a_time, xa.mistakes AS a_mistakes,
       xa.effort AS a_effort,
       xb.passed AS b_passed, xb.cost_usd AS b_cost, xb.wall_s AS b_time, xb.mistakes AS b_mistakes,
       xb.effort AS b_effort
ORDER BY mt.key
"""

# The hazards each of the two models met and tripped on, in those same pairs only.
PAIR_HAZARDS = """
MATCH (t:Test {id: $test_id})<-[:VERSION_OF]-(tv:TestVersion)<-[:USED]-(mt:Match)-[:PART_OF]->(r:Run),
      (mt)<-[:IN]-(x:Attempt)-[:BY]->(m:Model), (mt)<-[:IN]-(:Attempt)-[:BY]->(o:Model)
WHERE NOT mt.excluded AND m.name IN [$a, $b] AND o.name IN [$a, $b] AND m.name <> o.name
  AND ($suite IS NULL OR r.suite = $suite)
  AND ($version_key IS NULL OR tv.key = $version_key)
MATCH (tv)-[:INCLUDES]->(h:Hazard)
OPTIONAL MATCH (x)-[tr:TRIPPED_ON]->(h)
WITH m.name AS model, h.name AS hazard, count(x) AS exposed, count(tr) AS tripped
RETURN model, hazard, exposed, tripped
ORDER BY hazard, model
"""

# Opponents: the models whose published score on a benchmark is closest to one model's, whether the two score
# ranges overlap ("close on paper"), and what the graph already knows about each: has it played any matches, and
# how many pairs has it already played against this model? Scores only pick the opponent; the match decides.
CLOSE_TO = """
MATCH (me:Model {name: $model})-[mine:SCORED]->(b:Benchmark {name: $benchmark})<-[theirs:SCORED]-(other:Model)
WHERE other <> me AND (NOT $open_only OR other.weights = 'open')
OPTIONAL MATCH (me)<-[:BY]-(:Attempt)-[:IN]->(mt:Match)<-[:IN]-(:Attempt)-[:BY]->(other)
WHERE NOT mt.excluded
WITH mine, theirs, other, count(DISTINCT mt) AS pairs_played
OPTIONAL MATCH (other)<-[:BY]-(x:Attempt)
WITH mine, theirs, other, pairs_played, count(x) AS attempts
RETURN other.name AS model, other.display_name AS display_name, other.weights AS weights,
       theirs.score AS score, theirs.score - mine.score AS gap,
       (theirs.low <= mine.high AND mine.low <= theirs.high) AS ranges_overlap,
       attempts > 0 AS has_matches, pairs_played
ORDER BY abs(theirs.score - mine.score), model
LIMIT 25
"""

# Describe your flow: keyword search over each tested workflow's title, brief and policy (a full-text index), then
# out along the graph to what is known about it: how many models have played it and how many judged pairs exist.
# Only the newest version of each test is returned. $q is the words to look for (cli.search_words drops filler).
FIND_FLOW = """
MATCH (tv:TestVersion)
SEARCH tv IN (FULLTEXT INDEX flow_text FOR $q LIMIT 20) SCORE AS score
MATCH (tv)-[:VERSION_OF]->(t:Test)
WHERE NOT EXISTS { MATCH (t)<-[:VERSION_OF]-(newer:TestVersion) WHERE newer.version_rank > tv.version_rank }
OPTIONAL MATCH (tv)<-[:USED]-(mt:Match)<-[:IN]-(:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded
RETURN t.id AS test, tv.title AS title, tv.version AS version, score, tv.brief AS brief, tv.emulates AS emulates,
       tv.tools AS tools, count(DISTINCT m) AS models, count(DISTINCT mt) AS pairs
ORDER BY score DESC
"""

# Every tested workflow (newest versions), for when nothing is typed.
FLOWS = """
MATCH (t:Test)<-[:VERSION_OF]-(tv:TestVersion)<-[:USED]-(mt:Match)<-[:IN]-(:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded
  AND NOT EXISTS { MATCH (t)<-[:VERSION_OF]-(newer:TestVersion) WHERE newer.version_rank > tv.version_rank }
RETURN t.id AS test, tv.title AS title, tv.version AS version, tv.brief AS brief, tv.emulates AS emulates,
       tv.tools AS tools, count(DISTINCT m) AS models, count(DISTINCT mt) AS pairs
ORDER BY test
"""

# What a workflow was tested as: the text and tools, and the settings of the runs in $runs (the matches a spec's
# decision rests on, so the settings it prints are the ones its result was earned under).
FLOW_AS_TESTED = """
MATCH (t:Test {id: $test_id})<-[:VERSION_OF]-(tv:TestVersion {key: $version_key})
OPTIONAL MATCH (tv)<-[:USED]-(mt:Match)-[:PART_OF]->(r:Run)
WHERE r.run_id IN $runs
RETURN tv.key AS version, tv.title AS title, tv.brief AS brief, tv.policy AS policy, tv.tools AS tools,
       tv.emulates AS emulates, tv.tags AS tags, tv.content_sha256 AS content_sha256, tv.action_budget AS action_budget,
       collect(DISTINCT mt.difficulty) AS difficulty, collect(DISTINCT r.effort) AS effort,
       collect(DISTINCT r.max_output_tokens) AS max_output_tokens,
       collect(DISTINCT r.attempt_budget_usd) AS attempt_budget_usd, collect(DISTINCT r.suite) AS suites
"""

# Where the evidence came from: each bridge (source), with how much it contributed.
SOURCES = """
MATCH (s:Source)
OPTIONAL MATCH (r:Run)-[:FROM]->(s)
WITH s, count(r) AS runs
OPTIONAL MATCH (v:ValidationRun)-[:FROM]->(s)
WITH s, runs, count(v) AS validation_checks
OPTIONAL MATCH (b:Benchmark)-[:FROM]->(s)
OPTIONAL MATCH (:Model)-[sc:SCORED]->(b)
RETURN s.name AS source, s.description AS description, runs, validation_checks, count(sc) AS published_scores
ORDER BY source
"""

ALL = {
    "best_under_budget": BEST_UNDER_BUDGET,
    "head_to_head": HEAD_TO_HEAD,
    "hazard_profile": HAZARD_PROFILE,
    "beat_cycles": BEAT_CYCLES,
    "beats": BEATS,
    "promotion": PROMOTION,
    "stale_results": STALE_RESULTS,
    "sources": SOURCES,
    "close_to": CLOSE_TO,
    "find_flow": FIND_FLOW,
    "flows": FLOWS,
    "flow_as_tested": FLOW_AS_TESTED,
    "pair_on_task": PAIR_ON_TASK,
    "pair_hazards": PAIR_HAZARDS,
}
