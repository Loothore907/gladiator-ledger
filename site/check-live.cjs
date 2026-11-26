// Checks the page against Ledger's live record (ledger/live.py), with the real service and a real browser.
//   node site/check-live.cjs        (needs uv, for `uv run ledger serve`)
//
// What must hold: a page published before some races, reading a live record that has taken those races in, gives
// exactly the answers of a page published after them, which are the command line's (data/expected.json).
//
// So the check plays the last four records on file over again:
//   - the page is served as it was before them (its graph data without those four, no step or replay file for them)
//   - the real service is started from the records without those four, beside a stand-in race runner
//   - the runner has already filed two of them (a race and a run of one model against itself): the service takes
//     them in when it starts, and the page catches up when it loads
//   - the other two are "run" from the page, one as a single race and one as a batch: the stand-in runner streams
//     them and files the real sealed record, the service takes each in, the page loads it and reads the verdict again
// and then compares the page with a page built from all the shipped data, and with the command line's answers.
// No key, no spending, nothing outside this machine.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = __dirname;
const REPO = path.dirname(ROOT);
const DATA = path.join(REPO, 'data');
const BASE = '/gladiator-ledger/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm' };

// The four records played over again, oldest first, and what each is.
const FILED = ['20261126-115557-050b61', '20261126-115812-3d1417']; // a race and a self run, on access review
const BATCH = '20261126-120139-7801c6'; // 25 scenarios of refund queue
const RACE = '20261126-121057-018a06'; // one scenario of refund queue
const HELD_BACK = [...FILED, BATCH, RACE];
// A sealed record is served as the bytes on file: its seal is over the record as Python wrote it, and a trip
// through JavaScript's JSON would rewrite its numbers (1.0 becomes 1) and break it.
const sealedText = (run) => fs.readFileSync(path.join(DATA, 'records', run, 'record.json'), 'utf8');
const sealed = (run) => JSON.parse(sealedText(run));

// LEDGER_LIVE_SHOTS=<folder> also saves pictures of the page at the moments that matter, for a person to look at.
const SHOTS = process.env.LEDGER_LIVE_SHOTS || null;
async function shot(page, name, selector = null) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  if (selector) await page.locator(selector).scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const problems = [];
let compared = 0;
const check = (ok, text) => {
  compared += 1;
  if (!ok) problems.push(text);
};

// Every field expected must be there and equal (numbers within 1e-9): the comparison of site/check.cjs.
function same(expected, actual, where) {
  if (expected === null || typeof expected !== 'object') {
    compared += 1;
    const ok = typeof expected === 'number' && typeof actual === 'number' ? Math.abs(expected - actual) <= 1e-9 : expected === actual;
    if (!ok) problems.push(`${where}: expected ${JSON.stringify(expected)}, page gave ${JSON.stringify(actual)}`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return void problems.push(`${where}: expected a list, page gave ${JSON.stringify(actual)}`);
    compared += 1;
    if (expected.length !== actual.length) problems.push(`${where}: expected ${expected.length} items, page gave ${actual.length}`);
    expected.forEach((item, i) => i < actual.length && same(item, actual[i], `${where}[${i}]`));
    return;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return void problems.push(`${where}: expected an object, page gave ${JSON.stringify(actual)}`);
  for (const key of Object.keys(expected)) same(expected[key], actual[key], `${where}.${key}`);
}

// The page's folder. `without` serves it as it was published before those records: they are not in its graph
// data, and it has no step file or replay file for them. It never names a runner or a live record of its own:
// the check gives the page both in its address, so nothing here can reach a real one.
function serve(without = []) {
  const gone = new Set(without);
  const graph = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'graph.json'), 'utf8'));
  graph.rows.runs = graph.rows.runs.filter((run) => !gone.has(run.run_id));
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'rules.json'), 'utf8'));
  rules.steps_for = rules.steps_for.filter((run) => !gone.has(run));
  const made = { '/data/graph.json': JSON.stringify(graph), '/data/rules.json': JSON.stringify(rules), '/data/live.json': '{}' };
  const server = http.createServer((req, res) => {
    const asked = decodeURIComponent(req.url.split('?')[0]);
    const name = asked.startsWith(BASE) ? asked.slice(BASE.length - 1).replace(/\/$/, '/index.html') : null;
    const file = name === null ? null : path.join(ROOT, name);
    const hidden = name && /^\/data\/(steps|replays)\//.test(name) && gone.has(path.basename(name, '.json'));
    if (name && made[name]) return res.writeHead(200, { 'content-type': TYPES['.json'] }).end(made[name]);
    if (!file || hidden || !file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// A stand-in race runner that files real sealed records. It speaks the routes of the real one (gladiator-core
// engine/serve.py) that the page and the live record use: /options, /signin, /health, /races, /records/<run_id>
// and /race, which streams a few of the record's own steps and ends with the record itself. A "race" here is one
// of the shipped records played over again, so what the service takes in and the page then shows is real.
function filingRunner(filed) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  const json = (res, status, value) => res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  const records = new Map(filed.map((run) => [run, sealed(run)]));
  const sides = (record) => ({ A: record.body.contestants.A, B: record.body.contestants.B });
  const task = (record) => record.body.contestants.A.results[0].node;
  // one line of the runner's list for a record, as the real runner writes it
  const listed = (record) => {
    const { A, B } = sides(record);
    const about = { run_id: record.body.run_id, seal: record.sha256, task: task(record), a: A.id, b: B.id };
    if (A.results.length === 1) {
      const [x, y] = [A.results[0], B.results[0]];
      const winner = { A: A.id, B: B.id }[record.body.verdict.winner] || null;
      return { ...about, winner, a_passed: x.passed, b_passed: y.passed, a_cost_usd: x.cost_usd, b_cost_usd: y.cost_usd, a_details: x.grade_details, b_details: y.grade_details, a_termination: x.termination, b_termination: y.termination, a_seconds: x.wall_s, b_seconds: y.wall_s };
    }
    // a batch: the stand-in calls a scenario for the side that passed it alone, and level otherwise
    const scenarios = A.results.map((x, i) => ({ a_passed: x.passed, b_passed: B.results[i].passed, winner: x.passed === B.results[i].passed ? 'tie' : x.passed ? 'A' : 'B' }));
    const of = (side, s) => ({ [`${s}_attempts`]: side.results.length, [`${s}_passed`]: side.results.filter((x) => x.passed).length, [`${s}_not_run`]: 0, [`${s}_cost_usd`]: side.results.reduce((sum, x) => sum + x.cost_usd, 0), [`${s}_seconds`]: side.results.reduce((sum, x) => sum + x.wall_s, 0) / side.results.length, [`${s}_faults`]: {}, [`${s}_endings`]: {} });
    const wins = (who) => scenarios.filter((x) => x.winner === who).length;
    return { ...about, same_model: A.id === B.id, runs: A.results.length, difficulty: 'standard', profile: 'budget', spent_usd: record.body.budget.spent_usd, ...of(A, 'a'), ...of(B, 'b'), scenarios, pairs: scenarios.length, a_wins: wins('A'), b_wins: wins('B'), ties: wins('tie'), same_result: wins('tie'), p_value: 1, early_stop: null };
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    server.asked.push(`${req.method} ${req.url}`);
    if (req.url === '/options') {
      const tasks = ['refund-queue', 'access-review', 'incident-triage', 'inventory-transfer'].map((id) => ({ id, name: id, levels: ['easy', 'standard'] }));
      const models = [...new Set(HELD_BACK.flatMap((run) => Object.values(sides(sealed(run))).map((x) => x.id)))];
      return json(res, 200, { tasks, models, models_out: [], budgets: [{ provider: 'openrouter', limit_usd: 30, left_usd: 29 }], profiles: ['balanced', 'budget', 'latency'], needs_code: true, cap_usd_per_race: 0.4, batches: [{ runs: 25, cap_usd: 3 }], batch_pass_rate: 0.8 });
    }
    if (req.url === '/health') return json(res, 200, { ok: true, busy: false });
    if (req.url === '/races') {
      const all = [...records.values()].map(listed);
      return json(res, 200, { races: all.filter((x) => !x.runs), batches: all.filter((x) => x.runs) });
    }
    if (req.url.startsWith('/records/')) {
      const run = req.url.slice('/records/'.length);
      return records.has(run) ? res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(sealedText(run)) : json(res, 404, { error: 'No such record.' });
    }
    if (!['/race', '/signin'].includes(req.url) || req.method !== 'POST') return res.writeHead(404, cors).end();
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const ask = JSON.parse(body);
      if (req.url === '/signin') return ask.invite === 'judge-invite' || ask.token === 'session-1' ? json(res, 200, { token: 'session-1', expires_unix: 0, races_left: 5 }) : json(res, 403, { error: 'Not signed in.' });
      if (ask.token !== 'session-1') return json(res, 403, { error: 'Not signed in.' });
      // the record this "race" plays over again: the batch for a batch, the single race otherwise
      const record = sealed(ask.runs > 1 ? BATCH : RACE);
      const { A, B } = sides(record);
      if (ask.task !== task(record) || ask.a !== A.id || ask.b !== B.id || (ask.runs || 1) !== A.results.length) {
        return json(res, 400, { error: `The stand-in runner plays ${task(record)}, ${A.id} against ${B.id}, ${A.results.length} at a time; it was asked for ${JSON.stringify(ask)}.` });
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8' });
      const send = (kind, value) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ event: kind, ...value })}\n\n`);
      send('match_start', { models: { A: A.id, B: B.id } });
      for (const [side, x] of [['A', A], ['B', B]]) {
        for (const result of x.results) {
          const attempt = result.attempt || 1;
          let clock = 0;
          for (const turn of result.turns.slice(0, 6)) {
            clock += turn.call_s || 0;
            send('step', { side, attempt, turn: turn.turn, tool_name: turn.tool_name, tool_args: turn.tool_args, error: null, call_s: turn.call_s, cost_usd: turn.cost_usd, tokens: 100, elapsed_s: clock });
          }
          send('attempt_end', { side, attempt, passed: result.passed, termination: result.termination, grade_details: result.grade_details });
        }
      }
      // the real runner files the record, then says the race is over
      records.set(record.body.run_id, record);
      if (ask.runs > 1) send('batch', { batch: listed(record) });
      // (on one line: the file is indented, and a line of JSON only ever breaks outside a string)
      else res.write(`event: record\ndata: {"event":"record","record":${sealedText(record.body.run_id).replace(/\n\s*/g, '')},"operator":{}}\n\n`);
      res.end();
    });
  });
  server.asked = [];
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// The real service, started from the shipped data without the records played over again.
async function startService(runner, origin, scratch) {
  for (const beside of ['validations', 'epoch']) fs.cpSync(path.join(DATA, beside), path.join(scratch, 'data', beside), { recursive: true });
  for (const run of fs.readdirSync(path.join(DATA, 'records'))) {
    if (!HELD_BACK.includes(run)) fs.cpSync(path.join(DATA, 'records', run), path.join(scratch, 'data', 'records', run), { recursive: true });
  }
  const args = ['run', 'ledger', 'serve', '--runner', runner, '--state', path.join(scratch, 'state'), '--data', path.join(scratch, 'data'), '--host', '127.0.0.1', '--port', '0', '--origin', origin];
  const child = spawn('uv', args, { cwd: REPO, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  const said = [];
  const address = await new Promise((resolve, reject) => {
    const give = setTimeout(() => reject(new Error(`the live record did not start within 5 minutes. It said:\n${said.join('')}`)), 300000);
    const hear = (chunk) => {
      said.push(String(chunk));
      const found = /listening on 127\.0\.0\.1:(\d+)/.exec(said.join(''));
      if (found) {
        clearTimeout(give);
        resolve(`http://127.0.0.1:${found[1]}`);
      }
    };
    child.stdout.on('data', hear);
    child.stderr.on('data', hear);
    child.on('error', (error) => reject(new Error(`could not start "uv run ledger serve": ${error.message}`)));
    child.on('exit', (code) => reject(new Error(`the live record stopped (exit ${code}). It said:\n${said.join('')}`)));
  });
  return { address, said, stop: () => child.kill('SIGTERM') };
}

// Choose a workflow and two models the way a visitor does.
async function pick(page, flow, a, b) {
  await page.locator('#flow-cards button', { hasText: flow }).first().click();
  await page.locator(`#first-list input[value="${a}"]`).check();
  const card = page.locator(`#second-model input[name="second"][value="${b}"]`);
  await card.waitFor({ state: 'attached' });
  if (await card.evaluate((input) => Boolean(input.closest('#second-more')) && !document.getElementById('second-more').open)) await page.locator('#second-more-summary').click();
  await card.check();
  await page.waitForFunction(() => !document.getElementById('step-verdict').hidden && document.querySelector('#pair-graph .gdot'), null, { timeout: 30000 });
}

// Everything in a page's graph but the steps (which each page loads only for the scenarios it was asked about),
// in an order that does not depend on how it got there.
const graphOf = (page) =>
  page.evaluate(async () => {
    const d = window.ledgerDemo;
    const key = 'coalesce(%.key, %.run_id, %.name, %.id)';
    const nodes = await d.cypher('MATCH (n) WHERE NOT n:Step AND NOT n:Item RETURN labels(n) AS labels, properties(n) AS props');
    const links = await d.cypher(`MATCH (a)-[r]->(b) WHERE NOT a:Step AND NOT a:Item AND NOT b:Step AND NOT b:Item RETURN type(r) AS kind, ${key.replaceAll('%', 'a')} AS a, ${key.replaceAll('%', 'b')} AS b, properties(r) AS props`);
    const sorted = (value) => (Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])])) : value);
    return {
      nodes: nodes.map((n) => JSON.stringify([[...n.labels].sort(), sorted(n.props)])).sort(),
      links: links.map((l) => JSON.stringify([l.kind, l.a, l.b, sorted(l.props)])).sort(),
    };
  });

async function main() {
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'expected.json'), 'utf8'));
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'graph.json'), 'utf8')).rows.runs.map((run) => run.run_id);
  for (const run of HELD_BACK) if (!shipped.includes(run)) throw new Error(`${run} is not in the shipped data: nothing to play over again.`);
  const [RACE_A, RACE_B] = ['A', 'B'].map((side) => sealed(RACE).body.contestants[side].id);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-live-check-'));
  const before = await serve(HELD_BACK); // the page as it was published before the four records
  const after = await serve(); // the page as it is published now, with all of them
  const origin = `http://127.0.0.1:${before.address().port}`;
  const runner = await filingRunner(FILED);
  const runnerUrl = `http://127.0.0.1:${runner.address().port}`;
  let service = null;
  let browser = null;
  try {
    service = await startService(runnerUrl, origin, scratch);
    const enc = encodeURIComponent;
    browser = await chromium.launch();
    const watch = (page, name, allowed) => {
      page.on('console', (m) => m.type() === 'error' && problems.push(`${name}: console error: ${m.text()}`));
      page.on('pageerror', (e) => problems.push(`${name}: page error: ${e.message}`));
      page.on('requestfailed', (r) => problems.push(`${name}: request failed: ${r.url()} (${r.failure() && r.failure().errorText})`));
      page.on('request', (r) => {
        const url = r.url();
        if (!allowed.some((prefix) => url.startsWith(prefix)) && !url.startsWith('data:') && !url.startsWith('blob:')) problems.push(`${name}: request to somewhere it should not go: ${url}`);
      });
    };

    // ---- 1. a page behind the record catches up when it loads -------------------------------------------------
    const context = await browser.newContext(SHOTS ? { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 } : {});
    const page = await context.newPage();
    const fetched = [];
    page.on('response', (r) => r.url().startsWith(service.address) && fetched.push(`${r.status()} ${r.url().slice(service.address.length)}`));
    watch(page, 'the page behind the record', [origin + BASE, service.address, runnerUrl]);
    await page.goto(`${origin}${BASE}?record=${enc(service.address)}&runner=${enc(runnerUrl)}&invite=judge-invite`);
    const stats = await page.evaluate(() => window.ledgerDemo.ready());
    check(stats.matches === shipped.length - HELD_BACK.length, `the page behind the record was built with ${stats.matches} records, not ${shipped.length - HELD_BACK.length}`);
    const caught = await page.evaluate(() => window.ledgerDemo.liveRecord());
    check(JSON.stringify([...caught.added].sort()) === JSON.stringify(FILED) && !caught.problem, `on load the page took ${JSON.stringify(caught.added)} from the live record (problem: ${caught.problem}), not ${JSON.stringify(FILED)}`);
    await page.waitForFunction(() => !document.getElementById('record-note').hidden, null, { timeout: 10000 }).catch(() => problems.push('the page does not say what the live record gave it'));
    const said = await page.locator('#record-note').innerText();
    check(said.includes('2 records are newer than this page') && said.includes(`${shipped.length - 2} in all`), `the line about the live record reads: ${said}`);
    check(!(await page.locator('#record-show').count()), 'records that arrived before anything was chosen still ask to be shown');
    await shot(page, '1-caught-up-on-load');
    check((await page.locator('#foot-view').innerText()).includes('live record'), 'the small print does not say that newer matches come from the live record');

    // both access review records are in: that pair now reads exactly as the command line has it from all records
    const access = expected.verdicts.findIndex((v) => v.task.includes('access-review') && [v.a, v.b].includes(RACE_A) && [v.a, v.b].includes(RACE_B));
    if (access < 0) throw new Error('data/expected.json has no access review verdict for the pair of the records played over again.');
    const want = expected.verdicts[access];
    same(want, await page.evaluate(([t, a, b]) => window.ledgerDemo.verdict(t, a, b), [want.task, want.a, want.b]), 'after catching up, the access review verdict');
    check((await page.evaluate(() => window.ledgerDemo.cypher('MATCH (s:SelfCheck) RETURN count(s) AS n')))[0].n > 0, 'the run of one model against itself did not come in as a consistency check');

    // a scenario of a record that came from the live record replays, and its world is drawn from its steps
    await pick(page, 'Access', want.a, want.b);
    const round = await page.evaluate((run) => window.ledgerDemo.current().then((v) => v.rounds.findIndex((x) => x.run === run)), FILED[0]);
    check(round >= 0, `the verdict on screen has no scenario from ${FILED[0]}`);
    await page.locator('#pair-graph button.gdot').nth(round).click();
    await page.waitForSelector('#race .lane', { timeout: 20000 }).catch(() => problems.push('a scenario from the live record does not replay'));
    check(fetched.includes(`200 /replay/${FILED[0]}`), `the replay of ${FILED[0]} was not read from the live record (read: ${fetched.join(', ')})`);
    await page.waitForSelector('#world-graph svg', { timeout: 30000 }).catch(() => problems.push('the world of a scenario from the live record is not drawn'));
    const world = await page.evaluate((run) => window.ledgerDemo.cypher('MATCH (:Run {run_id: $run})<-[:PART_OF]-(:Match)<-[:IN]-(:Attempt)-[:TOOK]->(s:Step) RETURN count(s) AS n', { run }), FILED[0]);
    check(world[0].n > 0, `no step of ${FILED[0]} reached the page's graph`);

    // ---- 2. a race run from the page joins the record as it ends ----------------------------------------------
    await page.locator('#start-over').click();
    await pick(page, 'Refund', RACE_A, RACE_B);
    await page.waitForSelector('#live-go', { timeout: 15000 });
    await page.waitForFunction(() => !document.getElementById('live-go').disabled, null, { timeout: 15000 });
    const first = await page.evaluate(() => window.ledgerDemo.current());
    await page.locator('#live-go').click();
    await page.waitForFunction(() => (document.getElementById('live-became') || {}).innerText && !document.getElementById('live-became').innerText.includes('Joining'), null, { timeout: 60000 }).catch(() => problems.push('a race that ended never said what became of it'));
    const became = await page.locator('#live-became').innerText().catch(() => '');
    check(became.includes('in the record now') && became.includes('the verdict above counts it'), `after the race the page says: ${became}`);
    const second = await page.evaluate(() => window.ledgerDemo.current());
    check(second.pairs === first.pairs + 1, `the verdict on screen went from ${first.pairs} judged pairs to ${second.pairs} after one race, not ${first.pairs + 1}`);
    check(second.evidence.some((e) => e.run === RACE), 'the verdict on screen does not list the race just run among its sealed records');
    check(((await page.locator('#verdict-body').textContent()) || '').includes(`Head to head: the ${second.pairs} scenarios these two played against each other`), 'the verdict was not drawn again with the race in it');
    check((await page.locator('#live-outcome').count()) === 1 && (await page.locator('#live-stage .lane').count()) === 2, 'the race just run is no longer on screen after the verdict was read again');
    // that race, as it really went: both got every refund right, DeepSeek skipped lookups and Haiku ran it clean.
    // So it is said as a win on process, each lane ends in the page's own words, and each result is set beside
    // what the record said of that model before the race.
    const outcome = await page.locator('#live-outcome').innerText().catch(() => '');
    check((await page.locator('#live-outcome.win[data-kind="process"]').count()) === 1 && outcome.includes('won on process') && outcome.includes('Both got every decision right'), `the race just run is said as: ${outcome.slice(0, 300)}`);
    check(/as usual: right in \d+ of \d+/.test(outcome) && /clean in \d+ of \d+/.test(outcome), `the box under the race does not set each result beside the record: ${outcome.slice(0, 400)}`);
    const ends = await page.locator('#live-stage .outcome .end').allInnerTexts();
    check(ends.join(' | ') === 'Right result, a step skipped | ✓ Clean run', `the lanes of the race just run end with ${JSON.stringify(ends)}`);
    await page.waitForFunction((n) => document.querySelectorAll('#pair-graph .gdot:not(.live)').length === n, second.pairs, { timeout: 20000 }).catch(() => problems.push('the evidence graph does not show the race as one more scenario'));
    check((await page.locator('#pair-graph .gdot.live').count()) === 0, 'the race is still drawn as a live result beside the record');
    check((await page.locator('#pair-graph .gdot.ring').count()) === 1, 'the scenario of the race just run is not ringed in the evidence graph');
    check((await page.locator(`#pair-graph .grow[data-run="${RACE}"]`).innerText().catch(() => '')).includes('just run'), 'the row of the race just run does not say so');
    check((await page.locator(`#pair-graph .grow[data-run="${RACE}"] .gdot.ring .half.a.skipped`).count()) === 1 && (await page.locator(`#pair-graph .grow[data-run="${RACE}"] .gdot.ring .half.b.clean`).count()) === 1, 'the cell of the race just run does not show how the two attempts ended');
    check((await page.locator('#pair-graph figcaption').first().innerText()).includes('the race you just ran'), 'the evidence graph does not say the ringed scenario is the race just run');
    await page.waitForFunction(() => document.getElementById('world-graph').innerText.includes('This is the race you just ran'), null, { timeout: 30000 }).catch(() => problems.push('the world of the race just run is not drawn under the evidence graph'));
    check((await page.locator('#record-note').innerText()).includes('3 records are newer than this page'), `after the race the line about the live record reads: ${await page.locator('#record-note').innerText()}`);
    check((await page.evaluate(() => window.ledgerDemo.cypher('MATCH (l:LiveMatch) RETURN count(l) AS n')))[0].n === 0, 'the race is in the graph twice: as a match and as a live result');
    const inView = await page.evaluate(() => { const node = document.getElementById('live-outcome'); const box = node && node.getBoundingClientRect(); return Boolean(box) && box.bottom > 0 && box.top < window.innerHeight; });
    check(inView, 'the page moved away from the race when the verdict was read again');
    await shot(page, '2-race-joined-live-panel');
    await shot(page, '3-race-joined-evidence-graph', '#pair-graph');
    await page.locator('#live-outcome').scrollIntoViewIfNeeded();
    check((await page.locator('#live-prior').innerText()).includes(String(second.pairs)), 'the run box still describes the record as it was before the race');
    check((await page.locator('#live-history').isHidden()) || !(await page.locator('#live-history').innerText()).includes(RACE), 'the race is still listed as a live race waiting to join');

    // ---- 3. and so does a batch -------------------------------------------------------------------------------
    await page.locator('#live-runs').selectOption('25');
    await page.locator('#live-go').click();
    await page.waitForFunction(() => (document.getElementById('batch-joined') || {}).innerText && !document.getElementById('batch-joined').innerText.includes('Joining'), null, { timeout: 120000 }).catch(() => problems.push('a batch that ended never said what became of it'));
    const batchBecame = await page.locator('#batch-joined').innerText().catch(() => '');
    check(batchBecame.includes('in the record now') && batchBecame.includes('the verdict above counts it'), `after the batch the page says: ${batchBecame}`);
    const third = await page.evaluate(() => window.ledgerDemo.current());
    check(third.pairs > second.pairs && third.evidence.some((e) => e.run === BATCH), `the verdict on screen has ${third.pairs} judged pairs after the batch (it had ${second.pairs}) and ${third.evidence.some((e) => e.run === BATCH) ? 'lists' : 'does not list'} the batch`);
    check((await page.locator('#live-batch table').count()) > 0, 'the batch just run is no longer on screen after the verdict was read again');
    await shot(page, '4-batch-joined', '#batch-joined');
    const held = await page.evaluate(() => window.ledgerDemo.liveRecord());
    check(JSON.stringify([...held.added].sort()) === JSON.stringify([...HELD_BACK].sort()), `the page took ${JSON.stringify(held.added)} from the live record in all, not the four records`);
    // the service was only ever asked for its five answers, and it asked the runner only for the list and the records
    check(fetched.every((line) => /^200 \/(runs(\?fresh=1)?|rows\/[0-9a-f-]+|replay\/[0-9a-f-]+)$/.test(line)), `the page asked the live record for something else, or was refused: ${fetched.filter((line) => !/^200 \/(runs(\?fresh=1)?|rows\/[0-9a-f-]+|replay\/[0-9a-f-]+)$/.test(line)).join(', ')}`);

    // ---- 4. the page behind the record is now the page published after it -------------------------------------
    const plain = await browser.newPage();
    const afterOrigin = `http://127.0.0.1:${after.address().port}`;
    watch(plain, 'the page with all the data', [afterOrigin + BASE]);
    await plain.goto(`${afterOrigin}${BASE}`);
    await plain.evaluate(() => window.ledgerDemo.ready());
    const [mine, theirs] = [await graphOf(page), await graphOf(plain)];
    check(theirs.nodes.length > 3000 && theirs.links.length > 5000, `the page with all the data holds only ${theirs.nodes.length} nodes and ${theirs.links.length} links: nothing to compare`);
    for (const part of ['nodes', 'links']) {
      const [have, wanted] = [new Set(mine[part]), new Set(theirs[part])];
      const missing = theirs[part].filter((x) => !have.has(x));
      const extra = mine[part].filter((x) => !wanted.has(x));
      check(!missing.length && !extra.length, `the graph of the page that caught up differs from the page with all the data: ${missing.length} ${part} missing (first: ${String(missing[0]).slice(0, 300)}), ${extra.length} too many (first: ${String(extra[0]).slice(0, 300)})`);
    }
    await plain.close();
    // and its answers are the command line's, from every record: verdicts, fitness under each profile, a reader's
    // own check, the process questions and the routes (the last three read steps, some of them from the live record)
    for (const [i, v] of expected.verdicts.entries()) same(v, await page.evaluate(([t, a, b]) => window.ledgerDemo.verdict(t, a, b), [v.task, v.a, v.b]), `verdicts[${i}]`);
    for (const [i, { overrides, verdict: v }] of expected.judged.entries()) same(v, await page.evaluate(([t, a, b, p, o]) => window.ledgerDemo.verdict(t, a, b, p, o), [v.task, v.a, v.b, v.profile, overrides]), `judged[${i}]`);
    for (const [i, { checks, verdict: v }] of expected.checked.entries()) same(v, await page.evaluate(([t, a, b, p, c]) => window.ledgerDemo.verdictChecked(t, a, b, p, c), [v.task, v.a, v.b, v.profile, checks]), `checked[${i}]`);
    for (const [i, { a, b, found }] of expected.process.entries()) same(found, await page.evaluate(([t, x, y]) => window.ledgerDemo.process(t, x, y), [found.task, a, b]), `process[${i}]`);
    for (const [i, { every, one }] of expected.routes.entries()) {
      same(every, await page.evaluate(([t, a, b]) => window.ledgerDemo.route(t, a, b), [every.task, every.a, every.b]), `routes[${i}]`);
      same(one, await page.evaluate(([t, a, b, n]) => window.ledgerDemo.route(t, a, b, n), [one.task, one.a, one.b, one.scenarios[0].scenario]), `routes[${i}], one scenario`);
    }
    const asked = new Set(runner.asked.filter((line) => line.startsWith('GET /records/') || line === 'GET /races'));
    check(HELD_BACK.every((run) => asked.has(`GET /records/${run}`)), `the live record did not read every sealed record from the runner: ${[...asked].join(', ')}`);
    await context.close();

    // ---- 5. records that arrive after a choice was made wait for the visitor ----------------------------------
    // (a host that is waking up answers late: the page must not wait for it, and must not redraw under a reader)
    const late = await browser.newPage();
    watch(late, 'the page with a slow live record', [origin + BASE, service.address]);
    await late.route(`${service.address}/runs*`, (route) => setTimeout(() => route.continue(), 6000));
    await late.goto(`${origin}${BASE}?record=${enc(service.address)}`);
    await late.evaluate(() => window.ledgerDemo.ready());
    await pick(late, 'Access', want.a, want.b);
    const early = await late.evaluate(() => window.ledgerDemo.current());
    check(early.pairs < want.pairs, `the page with a slow live record already shows ${early.pairs} judged pairs: it waited for the live record`);
    await late.waitForSelector('#record-show', { timeout: 30000 }).catch(() => problems.push('records that arrived after a choice was made are not offered to the visitor'));
    check((await late.evaluate(() => window.ledgerDemo.current())).pairs === early.pairs, 'the verdict on screen changed by itself when the live record answered');
    await shot(late, '5-arrived-late', '#record-note');
    if (await late.locator('#record-show').count()) await late.locator('#record-show').click();
    await late.waitForFunction((n) => window.ledgerDemo.current().then((v) => v && v.pairs === n), want.pairs, { timeout: 30000 }).catch(() => problems.push('"Show this page with them" did not read the verdict again with the new records'));
    same(want, await late.evaluate(() => window.ledgerDemo.current().then((v) => window.ledgerDemo.verdict(v.task, v.a, v.b))), 'after "Show this page with them", the access review verdict');
    await late.close();

    // ---- 6. no live record: the page is its shipped copy, and says so -----------------------------------------
    service.stop();
    await new Promise((done) => setTimeout(done, 1500));
    const alone = await browser.newPage();
    alone.on('pageerror', (e) => problems.push(`the page with no live record: page error: ${e.message}`));
    await alone.goto(`${origin}${BASE}?record=${enc(service.address)}`);
    const lonely = await alone.evaluate(() => window.ledgerDemo.ready());
    const gave = await alone.evaluate(() => window.ledgerDemo.liveRecord());
    check(Boolean(gave.problem) && !gave.added.length, `with the live record stopped, the page reports ${JSON.stringify(gave)}`);
    check(lonely.matches === shipped.length - HELD_BACK.length, 'with the live record stopped, the page did not build its own copy');
    await alone.waitForFunction(() => document.getElementById('record-note').innerText.includes('could not be reached'), null, { timeout: 30000 }).catch(() => problems.push('a live record that cannot be reached is not said'));
    await shot(alone, '6-not-reachable', '#record-note');
    await pick(alone, 'Access', want.a, want.b);
    check((await alone.evaluate(() => window.ledgerDemo.current())).pairs === early.pairs, 'with the live record stopped, the page does not show the verdict of its own copy');
    await alone.close();
    return { stats, fetched: fetched.length };
  } catch (error) {
    if (service) console.error(`The live record said:\n${service.said.join('')}`);
    throw error;
  } finally {
    if (browser) await browser.close();
    if (service) service.stop();
    for (const server of [before, after, runner]) server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().then(
  ({ stats, fetched }) => {
    if (!compared) problems.push('nothing was compared');
    if (problems.length) {
      console.error(`FAILED: ${problems.length} problem(s)`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(
      `OK: a page published before ${HELD_BACK.length} records, reading the live record, is the page published after them. ` +
        `It started from ${stats.matches} records, read the live record ${fetched} times, and ${compared} values were compared ` +
        '(the graph node by node and link by link, and the command line\'s verdicts, process questions and routes).',
    );
  },
  (error) => {
    console.error(`FAILED: ${error.stack || error}`);
    for (const p of problems) console.error(`  - before that: ${p}`);
    process.exit(1);
  },
);
