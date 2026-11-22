// The graph engine, in a dedicated worker: builds an in-memory Relate graph from data/graph.json once, then
// answers Cypher sent by the page. Nothing leaves the browser.

import init, { RelateDb } from './vendor/relate-wasm/relate.js';

let db = null;

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
  execute(graph.link_forks);
  execute(graph.writes.checks, { checks: graph.rows.checks, source: graph.sources.gladiator });
  execute(graph.writes.scores, { scores: graph.rows.scores, source: graph.sources.epoch });
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
  const { id, query, params } = event.data;
  if (!(await ready)) return postMessage({ type: 'result', id, error: 'The graph did not build.' });
  try {
    postMessage({ type: 'result', id, rows: execute(query, params) });
  } catch (error) {
    postMessage({ type: 'result', id, error: String((error && error.message) || error) });
  }
};
