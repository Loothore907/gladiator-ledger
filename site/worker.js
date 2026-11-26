// The graph engine, in a dedicated worker: builds an in-memory Relate graph from data/graph.json once, then
// answers Cypher sent by the page. Steps (data/steps/<run>.json) are loaded into the same graph later, only for
// the scenarios a question is about. Nothing leaves the browser.

import init, { RelateDb } from './vendor/relate-wasm/relate.js';

let db = null;
let stepWrites = null; // the statements that load steps, kept from graph.json for when a question needs them
let stepSchema = false;

function execute(text, params) {
  const result = JSON.parse(db.execute(text, params ? JSON.stringify(params) : null));
  if (result.error) throw new Error(result.error);
  return result.rows || [];
}

async function build() {
  const started = performance.now();
  const [graph] = await Promise.all([
    fetch(new URL('./data/graph.json', import.meta.url)).then((r) => {
      if (!r.ok) throw new Error(`data/graph.json: HTTP ${r.status}`);
      return r.json();
    }),
    init(),
  ]);
  const loaded = performance.now();
  db = new RelateDb();
  for (const statement of graph.schema) execute(statement);
  execute(graph.writes.runs, { runs: graph.rows.runs, source: graph.sources.gladiator });
  execute(graph.writes.includes, { runs: graph.rows.runs });
  execute(graph.writes.faults, { runs: graph.rows.runs });
  execute(graph.writes.made, { runs: graph.rows.runs });
  // runs of one model against itself: kept apart from matches (SelfCheck, SelfAttempt), counted in that model's own
  // fitness for the task and never in a head-to-head
  if (graph.rows.runs.some((run) => (run.self_checks || []).length)) {
    execute(graph.writes.self, { runs: graph.rows.runs });
    execute(graph.writes.self_made, { runs: graph.rows.runs });
  }
  execute(graph.link_forks);
  execute(graph.writes.checks, { checks: graph.rows.checks, source: graph.sources.gladiator });
  execute(graph.writes.scores, { scores: graph.rows.scores, source: graph.sources.epoch });
  stepWrites = graph.steps;
  const count = (text) => execute(text)[0].n;
  return {
    matches: count('MATCH (r:Run) RETURN count(r) AS n'),
    pairs: count('MATCH (mt:Match) WHERE NOT mt.excluded RETURN count(mt) AS n'),
    models: count('MATCH (m:Model)<-[:BY]-(:Attempt) RETURN count(DISTINCT m) AS n'),
    scores: count('MATCH (:Model)-[s:SCORED]->(:Benchmark) RETURN count(s) AS n'),
    fetch_ms: loaded - started,
    build_ms: performance.now() - loaded,
  };
}

// Loads steps and the world records they touched (rows as ledger/bridges/steps.py makes them: {self, items,
// refers, routes}) with the statements the command line uses. Every write is a MERGE on a stable key, so loading
// the same rows twice changes nothing.
function loadSteps(rows) {
  if (!stepSchema) {
    for (const statement of stepWrites.schema) execute(statement);
    stepSchema = true;
  }
  const writes = rows.self ? { ...stepWrites.writes, ...stepWrites.self_writes } : stepWrites.writes;
  execute(writes.items, { items: rows.items });
  execute(writes.refers, { refers: rows.refers });
  let steps = 0;
  for (let at = 0; at < rows.routes.length; at += 100) {
    const routes = rows.routes.slice(at, at + 100);
    execute(writes.steps, { routes });
    execute(writes.next, { routes });
    for (const route of routes) steps += route.steps.length;
  }
  return [{ items: rows.items.length, steps }];
}

const ready = build().then(
  (stats) => {
    postMessage({ type: 'ready', stats });
    return true;
  },
  (error) => {
    postMessage({ type: 'fatal', error: String((error && error.message) || error) });
    return false;
  },
);

onmessage = async (event) => {
  const { id, query, params, load } = event.data;
  if (!(await ready)) return postMessage({ type: 'result', id, error: 'The graph did not build.' });
  try {
    postMessage({ type: 'result', id, rows: load ? loadSteps(load) : execute(query, params) });
  } catch (error) {
    postMessage({ type: 'result', id, error: String((error && error.message) || error) });
  }
};
