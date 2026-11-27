// Checks the demo page against the answers the Python command line computed (data/expected.json).
//   node site/check.cjs
// Serves this folder on a local port, opens the page in headless Chromium, and compares every verdict, spec,
// flow search and opponents answer. Exits non-zero, printing what differed, on any mismatch, console error,
// failed request, or request outside the page's own folder (it is served from a sub-folder, as on GitHub Pages).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
// The page is hosted under a sub-folder (GitHub Pages serves it at /gladiator-ledger/), so the check serves it
// from one too: an absolute path such as "/data/graph.json" would then miss and fail the check.
const BASE = '/gladiator-ledger/';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function serve() {
  const server = http.createServer((req, res) => {
    const asked = decodeURIComponent(req.url.split('?')[0]);
    const name = asked.startsWith(BASE) ? asked.slice(BASE.length - 1).replace(/\/$/, '/index.html') : null;
    const file = name === null ? null : path.join(ROOT, name);
    if (!file || !file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    // This check is about the page's own copy of the record, and must reach nothing outside this folder: the
    // page is served without the address of the hosted live record (site/check-live.cjs checks the page with
    // one, on this machine). The runner's address stays: the page must not contact it unasked, and that is checked.
    if (name === '/data/live.json') return res.end(JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), record: undefined }));
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const problems = [];
let compared = 0;

// Every field the Python produced must be there and equal (numbers within 1e-9).
function same(expected, actual, where) {
  if (expected === null || typeof expected !== 'object') {
    compared += 1;
    const ok =
      typeof expected === 'number' && typeof actual === 'number'
        ? Math.abs(expected - actual) <= 1e-9
        : expected === actual;
    if (!ok) problems.push(`${where}: expected ${JSON.stringify(expected)}, page gave ${JSON.stringify(actual)}`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return void problems.push(`${where}: expected a list, page gave ${JSON.stringify(actual)}`);
    compared += 1;
    if (expected.length !== actual.length) {
      problems.push(`${where}: expected ${expected.length} items, page gave ${actual.length}`);
    }
    expected.forEach((item, i) => i < actual.length && same(item, actual[i], `${where}[${i}]`));
    return;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return void problems.push(`${where}: expected an object, page gave ${JSON.stringify(actual)}`);
  }
  for (const key of Object.keys(expected)) same(expected[key], actual[key], `${where}.${key}`);
}

// A stand-in race runner speaking the real one's protocol (gladiator-core engine/serve.py): /options, and /race
// as an event stream that ends with a sealed record. It lets the check drive a live race with no keys or spending.
function fakeRunner(models, extra) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  const json = (res, status, value) => res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  let races = 3;
  const run = []; // the live races this stand-in has 'run', as the real runner lists them
  const batches = []; // and its batches
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.url === '/options') {
      const tasks = ['refund-queue', 'access-review', 'incident-triage', 'inventory-transfer'].map((id) => ({ id, name: id, levels: ['easy', 'standard'] }));
      const budgets = [{ provider: 'openrouter', limit_usd: 30, left_usd: 30 - (3 - races) * 0.0055 }, { provider: 'google', limit_usd: 20, left_usd: 0.1 }];
      // `server.own`: a runner on a person's own machine with their own key, as `gladiator serve` starts one with
      // no options. It asks for no sign-in, and has a cap on one race and one limit on everything it may spend.
      if (server.own) return json(res, 200, { tasks, models: [...models, extra], models_out: [], models_unpriced: [], budgets: [], total: { limit_usd: 5, left_usd: 5 - (server.ownSpent || 0) }, cap_usd_per_race: 0.25, profiles: ['balanced', 'budget', 'latency'], batches: [], batch_pass_rate: 0.8, needs_code: false });
      return json(res, 200, { tasks, models: [...models, extra, ...(server.more || [])], models_out: ['google:gemini-3.1-flash-lite'], budgets, profiles: ['balanced', 'budget', 'latency'], needs_code: true, ...(server.old ? {} : { batches: [{ runs: 10, cap_usd: 0.6 }], batch_pass_rate: 0.8 }) });
    }
    if (req.url === '/races') return json(res, 200, { races: run, batches });
    // the real runner plays one race at a time and says when it is busy; `server.busy` makes this one say so
    if (req.url === '/health') return json(res, 200, { ok: true, busy: Boolean(server.busy) });
    if (!['/race', '/signin'].includes(req.url) || req.method !== 'POST') return res.writeHead(404, cors).end();
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const ask = JSON.parse(body);
      // an invite is exchanged once for a session; after that only the session is sent
      if (req.url === '/signin') {
        server.signins = (server.signins || []).concat([ask]);
        if (ask.invite === 'judge-invite' || ask.token === 'session-1') return json(res, 200, { token: 'session-1', expires_unix: 0, races_left: races });
        return json(res, 403, { error: 'You are not signed in for live races, or the sign-in has expired.' });
      }
      server.asked = ask;
      if (!server.own && ask.token !== 'session-1') return json(res, 403, { error: 'You are not signed in for live races, or the sign-in has expired.' });
      if (server.busy) return json(res, 409, { error: 'The runner is busy with another race or a test being checked. Try again in a minute.' });
      if (ask.runs > 1) {
        // a batch: each attempt as it ends, then the facts of the whole batch. Side A fails its third attempt.
        if (ask.runs !== 10) return json(res, 400, { error: 'A batch must be one of these sizes: 10.' });
        res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8' });
        const send = (kind, value) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ event: kind, ...value })}\n\n`);
        const same = ask.a === ask.b;
        for (let n = 1; n <= 10; n += 1) {
          send('step', { side: 'A', attempt: n, turn: 0, tool_name: 'list_alerts' });
          send('attempt_end', { side: 'A', attempt: n, passed: n !== 3, termination: 'session_ended', ...(n === 3 ? { grade_details: { items: 3, correct: 3, acted_without_reading: 1 } } : {}) });
          // in a batch between two models, the second runs out of money after eight scenarios
          send('attempt_end', same || n <= 8 ? { side: 'B', attempt: n, passed: true, termination: 'session_ended' } : { side: 'B', attempt: n, passed: false, termination: 'not_run' });
        }
        const scenarios = Array.from({ length: 10 }, (_, i) => ({ a_passed: i !== 2, b_passed: true, winner: i === 2 ? 'B' : i < 6 ? 'A' : i < 8 ? 'B' : 'tie' }));
        const batch = { run_id: `live-batch-${batches.length + 1}`, seal: 'fedcba9876543210', task: ask.task, a: ask.a, b: ask.b, same_model: same, runs: 10, difficulty: ask.difficulty, profile: ask.profile, spent_usd: 0.0412,
          a_attempts: 10, a_passed: 9, a_not_run: 0, a_cost_usd: 0.021, a_seconds: 31, a_faults: { acted_without_reading: 1 }, a_endings: {},
          b_attempts: 10, b_passed: 10, b_not_run: 0, b_cost_usd: 0.0202, b_seconds: 28, b_faults: {}, b_endings: {},
          scenarios, pairs: 10, a_wins: 5, b_wins: 3, ties: 2, same_result: 9, p_value: 0.7266 };
        if (!same) Object.assign(batch, { early_stop: ask.early_stop === false ? null : { side: 'A', model: ask.a, failed: 3, runs: 10, pass_rate: 0.8 }, b_attempts: 8, b_passed: 8, b_not_run: 2, pairs: 8, ties: 0, scenarios: scenarios.map((x, i) => (i < 8 ? x : { a_passed: null, b_passed: null, winner: null })) });
        batches.push(batch);
        send('batch', { batch });
        return res.end();
      }
      if (server.refuse) {
        // the provider refuses the key this runner holds: neither attempt is run, nothing is spent, and the
        // race is still sealed and filed, as the real runner does
        res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8' });
        const send = (kind, value) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ event: kind, ...value })}\n\n`);
        send('match_start', { models: { A: ask.a, B: ask.b } });
        const none = { passed: false, cost_usd: 0, calls: 0, wall_s: 0, termination: 'not_run', error: server.refuse, grade_details: {} };
        for (const side of ['A', 'B']) send('attempt_end', { side, passed: false, termination: 'not_run', error: server.refuse });
        send('record', { record: { sha256: '0123456789abcdef', body: { run_id: 'live-refused-1', live: true, verdict: { winner: null }, contestants: { A: { results: [none] }, B: { results: [none] } } } }, operator: {} });
        return res.end();
      }
      races -= 1;
      if (server.own) server.ownSpent = (server.ownSpent || 0) + 0.0055; // what this race cost, off its one limit
      run.push({ run_id: `live-check-${run.length + 1}`, seal: 'abcdef0123456789', task: ask.task, a: ask.a, b: ask.b, winner: ask.a, a_passed: true, b_passed: false, a_cost_usd: 0.0021, b_cost_usd: 0.0034, ...(server.old ? {} : { a_details: { items: 1, correct: 1, wrong: 0, mistakes: {}, outcome_tools: { close: 'close_alert', escalate: 'escalate_alert' } }, b_details: { items: 1, correct: 0, wrong: 1, mistakes: { 'ALR-1': 'close->escalate' }, outcome_tools: { close: 'close_alert', escalate: 'escalate_alert' } }, a_termination: 'session_ended', b_termination: 'no_action', a_seconds: 6, b_seconds: 5 }) });
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8' });
      const send = (kind, value) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ event: kind, ...value })}\n\n`);
      const step = (side, turn, tool_name, tool_args, elapsed_s, error = null) =>
        send('step', { side, turn, tool_name, tool_args, error, call_s: 1, cost_usd: 0.001, tokens: 500, elapsed_s });
      send('match_start', { models: { A: ask.a, B: ask.b } });
      step('A', 0, 'list_alerts', { page: 1 }, 1);
      res.write(': still running\n\n');
      step('B', 0, 'list_alerts', { page: 1 }, 2);
      step('A', 1, 'close_alert', { alert_id: 'ALR-1' }, 3, 'timeout');
      step('A', 2, 'check_page', { alert_id: 'ALR-1' }, 4);
      step('A', 3, 'close_alert', { alert_id: 'ALR-1' }, 50); // long enough to stretch the time scale
      step('B', 1, 'escalate_alert', { alert_id: 'ALR-1' }, 5);
      send('attempt_end', { side: 'A', passed: true, termination: 'session_ended', grade_details: { items: 1, correct: 1 } });
      send('attempt_end', { side: 'B', passed: false, termination: 'no_action', grade_details: { items: 1, correct: 0, wrong: 1 } });
      send('record', { record: { sha256: 'abcdef0123456789', body: { run_id: `live-check-${run.length}`, live: true, verdict: { winner: 'A' }, contestants: { A: { results: [{ passed: true, cost_usd: 0.0021, calls: 3, input_tokens: 900, output_tokens: 40, wall_s: 6, termination: 'session_ended', grade_details: { items: 1, correct: 1, wrong: 0, mistakes: {}, outcome_tools: { close: 'close_alert', escalate: 'escalate_alert' } } }] }, B: { results: [{ passed: false, cost_usd: 0.0034, calls: 1, input_tokens: 400, output_tokens: 25, wall_s: 5, termination: 'no_action', grade_details: { items: 1, correct: 0, wrong: 1, mistakes: { 'ALR-1': 'close->escalate' }, outcome_tools: { close: 'close_alert', escalate: 'escalate_alert' } } }] } } } }, operator: {} });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Choose the second model the way a visitor does: its card, opening the list of other models if it is in there.
async function pickSecond(page, model) {
  const card = page.locator(`#second-model input[name="second"][value="${model}"]`);
  await card.waitFor({ state: 'attached' });
  const folded = await card.evaluate((input) => Boolean(input.closest('#second-more')) && !document.getElementById('second-more').open);
  if (folded) await page.locator('#second-more-summary').click();
  await card.check();
}

async function main() {
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'expected.json'), 'utf8'));
  for (const part of ['verdicts', 'specs', 'judged', 'judged_specs', 'flows', 'opponents', 'process', 'routes', 'checked']) {
    if (!Array.isArray(expected[part]) || !expected[part].length) {
      throw new Error(`data/expected.json has no ${part}: nothing to compare. Rebuild it with "uv run ledger site".`);
    }
  }
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let requests = 0;
  try {
    const page = await browser.newPage();
    page.on('console', (m) => m.type() === 'error' && problems.push(`console error: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} (${r.failure() && r.failure().errorText})`));
    page.on('request', (r) => {
      requests += 1;
      const url = r.url();
      if (!url.startsWith(origin + BASE) && !url.startsWith('data:') && !url.startsWith('blob:')) {
        problems.push(`request outside the page's own folder: ${url}`);
      }
    });
    page.on('response', (r) => {
      if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
    });
    await page.goto(`${origin}${BASE}`);
    const stats = await page.evaluate(() => window.ledgerDemo.ready());
    if (!(stats.matches > 0 && stats.models > 0)) problems.push(`the page reports an empty graph: ${JSON.stringify(stats)}`);

    for (const [i, want] of expected.verdicts.entries()) {
      const got = await page.evaluate(([t, a, b]) => window.ledgerDemo.verdict(t, a, b), [want.task, want.a, want.b]);
      same(want, got, `verdicts[${i}] (${want.task}: ${want.a} vs ${want.b})`);
    }
    for (const [i, want] of expected.specs.entries()) {
      const args = [want.task, want.decision.a, want.decision.b];
      const got = await page.evaluate(([t, a, b]) => window.ledgerDemo.spec(t, a, b), args);
      same(want, got, `specs[${i}] (${args.join(', ')})`);
      // The document a person reads carries no copy of itself as data (owner, 2026-11-27): the data is its own
      // file, and it must be the same spec.
      const md = await page.evaluate(([t, a, b]) => window.ledgerDemo.specMarkdown(t, a, b), args);
      if (!md.startsWith('# Spec: ') || /```json|Machine-readable/.test(md)) problems.push(`specs[${i}]: the Markdown is not in the expected shape`);
      same(want, JSON.parse(await page.evaluate(([t, a, b]) => window.ledgerDemo.specJson(t, a, b), args)), `specs[${i}] as data`);
    }
    // The same answers read through fitness (ledger/policy.py): both profiles, and a reader's own rule.
    for (const [i, { overrides, verdict: want }] of expected.judged.entries()) {
      const args = [want.task, want.a, want.b, want.profile, overrides];
      const got = await page.evaluate(([t, a, b, p, o]) => window.ledgerDemo.verdict(t, a, b, p, o), args);
      same(want, got, `judged[${i}] (${want.task}: ${want.a} vs ${want.b}, ${want.profile}${overrides ? ', own rule' : ''})`);
    }
    for (const [i, { overrides, spec: want, markdown: wantText, json: wantJson, cost: wantCost, evidence: wantEvidence }] of expected.judged_specs.entries()) {
      const args = [want.task, want.decision.a, want.decision.b, want.decision.profile, overrides];
      const got = await page.evaluate(([t, a, b, p, o]) => window.ledgerDemo.spec(t, a, b, p, o), args);
      same(want, got, `judged_specs[${i}] (${args.slice(0, 4).join(', ')})`);
      const md = await page.evaluate(
        async ([t, a, b, p, o]) => window.ledgerDemo.specMarkdownJudged(t, a, b, p, o),
        args,
      );
      // the spec as data must be the command line's text too, in Python's formatting, character for character
      const data = await page.evaluate(([t, a, b, p, o]) => window.ledgerDemo.specJson(t, a, b, p, o), args);
      if (typeof wantJson !== 'string' || wantJson.length < 200) problems.push(`judged_specs[${i}]: no expected spec as data to compare`);
      else if (data !== wantJson) {
        const at = [...data].findIndex((ch, k) => ch !== wantJson[k]);
        problems.push(`judged_specs[${i}]: the spec as data differs at character ${at}: page ${JSON.stringify(data.slice(at - 30, at + 60))}, command line ${JSON.stringify(wantJson.slice(at - 30, at + 60))}`);
      }
      compared += 1;
      if (/```json|Machine-readable/.test(md)) problems.push(`judged_specs[${i}]: the document still carries a copy of itself as data`);
      // the downloadable spec must be the command line's text, character for character
      if (md !== wantText) {
        const at = [...md].findIndex((ch, k) => ch !== wantText[k]);
        problems.push(`judged_specs[${i}]: Markdown differs at character ${at}: page ${JSON.stringify(md.slice(at - 30, at + 60))}, command line ${JSON.stringify(wantText.slice(at - 30, at + 60))}`);
      }
      compared += 1;
      // the two reports that go with the spec must be the command line's text too
      const reports = await page.evaluate(([t, a, b, p, o]) => window.ledgerDemo.reports(t, a, b, p, o), args);
      for (const [kind, wantReport] of [['cost', wantCost], ['evidence', wantEvidence]]) {
        if (typeof wantReport !== 'string' || wantReport.length < 200) problems.push(`judged_specs[${i}]: no expected ${kind} report to compare`);
        else if (reports[kind] !== wantReport) {
          const at = [...reports[kind]].findIndex((ch, k) => ch !== wantReport[k]);
          problems.push(`judged_specs[${i}]: the ${kind} report differs at character ${at}: page ${JSON.stringify(reports[kind].slice(at - 30, at + 60))}, command line ${JSON.stringify(wantReport.slice(at - 30, at + 60))}`);
        }
        compared += 1;
      }
      same(want, JSON.parse(data), `judged_specs[${i}] as data`);
    }
    for (const [i, want] of expected.flows.entries()) {
      const got = await page.evaluate((text) => window.ledgerDemo.flows(text), want.described);
      const where = `flows[${i}] (${JSON.stringify(want.described)})`;
      same(want.matched, got.matched, `${where}.matched`);
      same(want.searched_for, got.searched_for, `${where}.searched_for`);
      same(want.flows.map((f) => f.test), got.flows.map((f) => f.test), `${where} test ids in order`);
      same(want.flows, got.flows, `${where}.flows`);
    }
    // Which pairs a verdict counts: the page's copy of the rule against the command line's, on made-up cases.
    for (const [i, want] of expected.conditions.reference.entries()) {
      const got = await page.evaluate(([found, record]) => window.ledgerDemo.referenceConditions(found, record), [want.found, want.record]);
      same(want.is, got, `conditions.reference[${i}]`);
    }
    for (const [i, want] of expected.conditions.apart.entries()) {
      const got = await page.evaluate(([reference, other]) => window.ledgerDemo.conditionsApart(reference, other), [want.reference, want.other]);
      same(want.what, got, `conditions.apart[${i}]`);
    }
    // How they got there. The page loads the steps of a pair's scenarios into its own graph (data/steps/) and must
    // then give the command line's answers: the two routes through the same worlds (one scenario item by item,
    // and a line for every scenario), each process question's counts, and a verdict judged with a reader's own
    // check at a level.
    for (const [i, want] of expected.routes.entries()) {
      const { task, a, b } = want.one;
      const where = `routes[${i}] (${task}: ${a} vs ${b})`;
      const scenario = want.one.scenarios[0].scenario;
      same(want.one, await page.evaluate(([t, x, y, n]) => window.ledgerDemo.route(t, x, y, n), [task, a, b, scenario]), `${where}, scenario ${scenario}`);
      same(want.every, await page.evaluate(([t, x, y]) => window.ledgerDemo.route(t, x, y), [task, a, b]), `${where}, every scenario`);
    }
    for (const [i, want] of expected.process.entries()) {
      const got = await page.evaluate(([t, x, y]) => window.ledgerDemo.process(t, x, y), [want.found.task, want.a, want.b]);
      same(want.found, got, `process[${i}] (${want.found.task}: ${want.a} vs ${want.b})`);
      if (got.not_loaded) problems.push(`process[${i}]: ${got.not_loaded} scenarios of the shipped record had no steps to load`);
    }
    for (const [i, want] of expected.checked.entries()) {
      const v = want.verdict;
      const got = await page.evaluate(([t, x, y, p, levels]) => window.ledgerDemo.verdictChecked(t, x, y, p, levels), [v.task, v.a, v.b, v.profile, want.checks]);
      same(v, got, `checked[${i}] (${v.task}: ${v.a} vs ${v.b}, ${JSON.stringify(want.checks)})`);
    }
    for (const [i, want] of expected.opponents.entries()) {
      const got = await page.evaluate(([m, open]) => window.ledgerDemo.opponents(m, open), [want.asked, want.open_only]);
      const where = `opponents[${i}] (${want.asked}${want.open_only ? ', open only' : ''})`;
      const pick = (o) => o.candidates.map((c) => ({ model: c.model, score: c.score, pairs_played: c.pairs_played }));
      same(pick(want), pick(got), `${where} candidates in order`);
      same(want, got, where);
    }
    // Step 1 never hides a workflow: a description only puts the closest first, and a description that matches
    // nothing says so and still shows every workflow.
    const allCards = await page.locator('#flow-cards button').count();
    for (const [text, expectNone] of [['refund requests for damaged orders', false], ['zebra unicorns', true]]) {
      await page.fill('#flow-text', text);
      await page.click('#flow-go');
      await page.waitForFunction((t) => document.getElementById('flow-note').innerText.includes(t.split(' ')[0]), text, { timeout: 5000 }).catch(() => {});
      const shown = await page.locator('#flow-cards button').count();
      const note = await page.locator('#flow-note').innerText();
      if (shown !== allCards) problems.push(`describing "${text}" left ${shown} of ${allCards} workflows on the page`);
      if (expectNone !== note.startsWith('None of')) problems.push(`describing "${text}": the note reads ${JSON.stringify(note)}`);
      if (!expectNone && !(await page.locator('#flow-cards button').first().innerText()).includes('Refund')) {
        problems.push(`describing "${text}" did not put the refund workflow first`);
      }
    }
    if (!(await page.locator('#flow-cards button').first().innerText()).includes('Catches:')) {
      problems.push('the workflow cards do not say what each test catches');
    }
    await page.fill('#flow-text', '');
    await page.click('#flow-go');
    await page.waitForFunction(() => document.getElementById('flow-note').innerText === '', null, { timeout: 5000 }).catch(() => {});

    // Click through the page itself, the way a visitor does: every flow, every first model, every second model.
    // The comparisons above call the page's functions; this proves the buttons lead to a drawn verdict, including
    // for pairs where no winner is named.
    let clicked = 0;
    // The page answers one question at a time, so a verdict asked for here waits behind whatever the pair before
    // it was still drawing (its evidence graph, one scenario's steps). On a slow machine the pair with the most
    // matches took over 5 seconds that way, on a page that was working. The limit is for a page that never
    // draws; how long the slowest one took is printed, so a page that is getting slow is seen and not guessed.
    const DRAW_LIMIT_MS = 20000;
    const soFar = { verdicts: 0, lines: 0 }; // verdicts that wait for more attempts, and "so far" lines shown
    const explained = { attempts: 0 }; // attempts without the right result that the click-through saw explained
    const slowest = { ms: 0, what: '' };
    const flowCount = await page.locator('#flow-cards button').count();
    if (!flowCount) problems.push('the page lists no flows to click');
    const values = (list) => page.locator(`#${list} input:not([disabled])`).evaluateAll((inputs) => inputs.map((x) => x.value));
    for (let f = 0; f < flowCount; f += 1) {
      // each list fills a moment after the click: empty it first and wait, so a stale or half-drawn list is never read
      await page.evaluate(() => document.getElementById('first-list').replaceChildren());
      await page.locator('#flow-cards button').nth(f).click();
      const filled = await page
        .waitForFunction(() => document.querySelectorAll('#first-list input').length > 0, null, { timeout: 5000 })
        .then(() => true, () => false);
      const firsts = filled ? await values('first-list') : [];
      if (!firsts.length) problems.push(`flow ${f}: no first model to pick`);
      for (const a of firsts) {
        // empty the list first, so what is read next is this model's opponents and not the previous model's
        await page.evaluate(() => ['second-list', 'second-more-list'].forEach((id) => document.getElementById(id).replaceChildren()));
        await page.locator(`#first-list input[value="${a}"]`).check();
        const met = await page
          .waitForFunction(() => document.querySelectorAll('#second-model input[name="second"]').length > 0, null, { timeout: 5000 })
          .then(() => true, () => false);
        if (!met) {
          problems.push(`flow ${f}, ${a}: no second model to pick`);
          continue;
        }
        for (const b of await page.locator('#second-model input[name="second"]').evaluateAll((all) => all.map((x) => x.value))) {
          await page.evaluate(() => document.getElementById('verdict-body').replaceChildren());
          const asked = Date.now();
          await pickSecond(page, b);
          const drawn = await page
            .waitForFunction(
              () => !document.getElementById('step-verdict').hidden && document.getElementById('verdict-body').innerText.trim().length > 200,
              null,
              { timeout: DRAW_LIMIT_MS },
            )
            .then(() => true, () => false);
          if (!drawn) problems.push(`clicking flow ${f}, ${a} vs ${b}: no verdict was drawn within ${DRAW_LIMIT_MS / 1000} seconds`);
          else if (Date.now() - asked > slowest.ms) Object.assign(slowest, { ms: Date.now() - asked, what: `flow ${f}, ${a} vs ${b}` });
          // A fit call waits for the count to settle it (owner, 2026-11-27), on every verdict the page draws: a
          // headline that names a model to use is never in a band that is not a winner's, a verdict that waits
          // for more attempts is never in a winner's band unless it names the one settled model, and it says what
          // the attempts show so far. (A pair that never met has no verdict band of this kind.)
          if (drawn) {
            const band = await page.evaluate(() => {
              const box = document.getElementById('verdict-band');
              const head = document.getElementById('verdict-headline');
              return box && head ? { win: box.classList.contains('win'), headline: head.innerText, why: [...box.querySelectorAll('ul.why li')].map((n) => n.textContent) } : null;
            });
            if (band) {
              const waits = /not settled yet/.test(band.headline);
              const names = band.headline.startsWith('Use ');
              if (waits) soFar.verdicts += 1;
              if (names && !band.win) problems.push(`flow ${f}, ${a} vs ${b}: "${band.headline}" is not in a winner's band`);
              if (waits && band.win && !names) problems.push(`flow ${f}, ${a} vs ${b}: a verdict that waits for more attempts is in a winner's band: "${band.headline}"`);
              if (waits && !band.why.some((x) => /so far|too few to say/.test(x))) problems.push(`flow ${f}, ${a} vs ${b}: a verdict that waits does not say what the attempts show so far: ${JSON.stringify(band.why)}`);
              if (band.why.some((x) => /so far/.test(x))) soFar.lines += 1;
              // A count of failures is never left unexplained (owner, 2026-11-27). The head-to-head table says
              // in how many scenarios each model got the right result; every attempt that did not must have
              // its own line under the counts saying which scenario, which model and what went wrong. The two
              // are counted by different questions of the graph, so this holds one to the other.
              const wrong = await page.evaluate(() => {
                const row = [...document.querySelectorAll('.tape .tape-row')].find((r) => (r.querySelector('.lab') || {}).firstChild?.textContent === 'Right result');
                const missed = (cell) => {
                  const m = /^(\d+) of (\d+)$/.exec(cell ? cell.innerText.trim() : '');
                  return m ? Number(m[2]) - Number(m[1]) : null;
                };
                const counted = row ? [missed(row.querySelector('.val.l')), missed(row.querySelector('.val.r'))] : [null, null];
                // a pair that never met has no head-to-head table, and nothing to explain
                return { met: Boolean(document.querySelector('.tape')), counted, lines: [...document.querySelectorAll('#went-wrong li')].map((li) => li.textContent) };
              });
              if (!wrong.met) {
                if (wrong.lines.length) problems.push(`flow ${f}, ${a} vs ${b}: a pair that never met lists attempts that went wrong`);
              } else if (wrong.counted.includes(null)) problems.push(`flow ${f}, ${a} vs ${b}: the head-to-head table does not say how many attempts had the right result`);
              else {
                const expected = wrong.counted[0] + wrong.counted[1];
                if (wrong.lines.length !== expected) problems.push(`flow ${f}, ${a} vs ${b}: ${expected} attempts did not end in the right result, and ${wrong.lines.length} are explained`);
                if (wrong.lines.some((x) => !/^Scenario \d+, .+: .+\.$/.test(x) || /no fault recorded/.test(x))) problems.push(`flow ${f}, ${a} vs ${b}: a wrong result is not explained: ${JSON.stringify(wrong.lines)}`);
                explained.attempts += expected;
              }
            }
          }
          // a broken page fails every pair the same way: stop early instead of waiting out each one
          if (problems.length >= 5) throw new Error(`stopped after ${problems.length} problems:\n  - ${problems.join('\n  - ')}`);
          clicked += 1;
        }
      }
    }
    if (!clicked) problems.push('no pair of models could be clicked: the click-through tested nothing');
    // the record holds wrong results (no model is perfect on every task), so some must have been explained: a
    // pass that saw none tested nothing about them
    if (clicked && !explained.attempts) problems.push('no attempt without the right result was seen in the click-through: the "what went wrong" lines were not exercised');
    // the record holds models with few attempts, so some verdict must have been one that waits: a pass that saw
    // none tested nothing about them
    if (clicked && !(soFar.verdicts && soFar.lines)) problems.push(`no verdict in the click-through was one that waits for more attempts (${JSON.stringify(soFar)}): the fit rule was not exercised`);
    // The race: open a scenario of the pair on screen, skip to the end, and require both lanes to show the grade
    // and the finish line to name the same winner the square does.
    // (the click-through ends on whatever pair is last in the list, which may be one that never met: go to a
    // pair with a settled record)
    {
      const known = expected.judged.find((j) => j.verdict.better && !j.overrides).verdict;
      await page.locator('#flow-cards button', { hasText: known.task.includes('refund') ? 'Refund' : known.task.includes('incident') ? 'Incident' : known.task.includes('access') ? 'Access' : 'Inventory' }).first().click();
      await page.locator(`#first-list input[value="${known.a}"]`).check();
      await pickSecond(page, known.b);
      // step 2 groups the second model by how close it is to the first in capability and in cost: the
      // first-choice pairings are cards, every model is in the one list, and the picture marks the first model
      const firstChoice = await page.locator('#second-list input').count();
      if ((await page.locator(`#second-model input[name="second"]:checked`).count()) !== 1) problems.push('the chosen second model is not shown as chosen');
      // every other model is a card that can be clicked, in the list under the picture; the reference list of
      // models this platform cannot run holds none that can be picked
      const elsewhere = await page.locator('#second-more-list input').count();
      if (firstChoice + elsewhere !== (await page.locator('#first-list input').count()) - 1) problems.push(`step 2 offers ${firstChoice} + ${elsewhere} second models, not every other model`);
      if (!(await page.locator('#second-more-list .more-group').count())) problems.push('the list of other models is not grouped by how close each is');
      const pickable = await page.locator('#first-list input').evaluateAll((all) => all.map((x) => x.title || x.closest('label').title));
      await page.waitForFunction(() => /Not on this platform yet/.test(document.getElementById('suggest-summary').innerText), null, { timeout: 6000 }).catch(() => problems.push('the reference list does not say its models are not on this platform'));
      const reference = await page.locator('#suggest-body').innerText();
      if (pickable.some((id) => id && reference.includes(id))) problems.push('the reference list holds a model that can be picked');
      if ((await page.locator('#second-chart .pc-dot.me').count()) !== 1 || !(await page.locator('#second-chart .pc-band').count())) problems.push('the pairing picture does not mark the first model and the band around it');
      const inBand = await page.locator('#second-chart .pc-dot.first').count();
      if (inBand !== firstChoice) problems.push(`the picture fills ${inBand} dots for ${firstChoice} first-choice pairings`);
      if (!/does not\s+say who does the task better/.test(await page.locator('#second-chart figcaption').innerText())) problems.push('the pairing picture does not say it only suggests who to pair');
      await page.waitForSelector('#pair-graph button.gdot', { timeout: 8000 }).catch(() => {});
    }
    const squares = await page.locator('#pair-graph button.gdot').count();
    if (!squares) problems.push('the graph has no scenario to open');
    else {
      const square = page.locator('#pair-graph button.gdot').first();
      const label = await square.getAttribute('title');
      await square.click();
      const opened = await page.waitForSelector('#race-end', { timeout: 10000 }).then(() => true, () => false);
      if (!opened) problems.push('opening a scenario did not load its replay');
      else {
        if (!(await page.locator('.race .track .tick').count())) problems.push('the replay has no steps to show');
        if ((await page.locator('.race .legend.marks > span').count()) < 6) problems.push('the replay has no legend saying what each mark means');
        await page.locator('#race-end').click();
        const finish = await page.locator('#race-finish').innerText();
        const outcomes = await page.locator('.race .outcome:not([hidden])').count();
        if (outcomes !== 2) problems.push(`the finished race shows ${outcomes} of 2 grades`);
        // the cell and the end of its replay say the same thing: who took it, and why, in the same words
        const winner = /: taken by (.+?) \((.+?)\)\. /.exec(label || '');
        if (!winner && !/: a tie\. /.test(label || '')) problems.push(`the cell of a scenario does not say who took it: ${JSON.stringify(label)}`);
        if (winner && finish !== `${winner[1]} took this scenario: ${winner[2]}.`) problems.push(`the cell says ${JSON.stringify(label)} but the race ends ${JSON.stringify(finish)}`);
        const hidden = await page.locator('.race .track .tick[hidden]').count();
        if (hidden) problems.push(`${hidden} steps are still hidden after the race ended`);
        // the graph picture under the race: one dot per scenario, and exactly the watched one ringed
        const dots = await page.locator('#pair-graph figure.graph .gdot').count();
        const ringed = await page.locator('#pair-graph figure.graph .gdot.ring').count();
        if (dots !== squares || ringed !== 1) problems.push(`the graph picture shows ${dots} dots (${ringed} ringed) for ${squares} scenarios`);
        // under the replay: the same world as a picture and item by item, read from the steps now in the graph.
        // It must say what the command line says about that scenario (the first of this pair).
        const drawn = await page.waitForSelector('#same-world-sum', { timeout: 15000 }).then(() => true, () => false);
        if (!drawn) problems.push('the replay shows no item-by-item comparison of the two routes');
        else {
          const now = await page.evaluate(() => window.ledgerDemo.current());
          const told = await page.evaluate(([t, x, y]) => window.ledgerDemo.route(t, x, y, 1), [now.task, now.a, now.b]);
          const world = told.scenarios[0];
          // the picture: one node per record of that world, every mark shown once the race has ended, and one
          // broken line (dashed: read afterwards; dotted: never read) for every record a model had not seen
          // when it decided
          const picture = '#same-world figure.world > svg';
          const boxes = await page.locator(`${picture} rect.wnode`).count();
          if (boxes !== world.records.length) problems.push(`the picture of the world has ${boxes} nodes for ${world.records.length} records`);
          const waiting = await page.locator(`${picture} [hidden]`).count();
          if (waiting) problems.push(`${waiting} marks of the picture are still hidden after the race ended`);
          const broken = (await page.locator(`${picture} line.wl.late`).count()) + (await page.locator(`${picture} line.wl.never`).count());
          const notSeen = world.items.reduce((n, item) => n + Object.values(item.sides).reduce((m, side) => m + side.unseen.length, 0), 0);
          if (broken !== notSeen) problems.push(`the picture draws ${broken} broken lines, the graph says ${notSeen} records were not seen in time`);
          if (!(await page.locator(`${picture} line.wl.before`).count())) problems.push('the picture draws no line for a record read in time');
          // the evidence box shows the same scenario as it ended, one level down from its dot
          const opened = await page.waitForSelector('#world-graph figure.world', { timeout: 15000 }).then(() => true, () => false);
          if (!opened) problems.push('the evidence box does not open a scenario as a graph of its own');
          else if ((await page.locator('#world-graph figure.world > svg rect.wnode').count()) !== world.records.length) problems.push('the evidence box draws another world than the scenario watched');
          const rows = await page.locator('#same-world table.routes tbody tr').count();
          const marked = await page.locator('#same-world table.routes tr.differ').count();
          const unseen = await page.locator('#same-world table.routes .chip.bad').count();
          const records = world.items.reduce((n, item) => n + Object.values(item.sides).reduce((m, side) => m + side.unseen.length, 0), 0);
          if (rows !== world.items.length) problems.push(`the item-by-item table has ${rows} rows for ${world.items.length} items`);
          if (marked !== world.decided_differently.length) problems.push(`the table marks ${marked} items as decided differently, the graph says ${world.decided_differently.length}`);
          if (unseen !== records) problems.push(`the table flags ${unseen} records as not seen, the graph says ${records}`);
          const sum = await page.locator('#same-world-sum').innerText();
          if (!sum.includes(`differently on ${world.decided_differently.length} of ${world.items.length} item`)) problems.push(`the item-by-item summary reads ${JSON.stringify(sum)}`);
          if (!/\d+ rows · /.test(await page.locator('#same-world-stats').innerText())) problems.push('the item-by-item panel does not say what its query returned');
          if (!((await page.locator('#same-world details.graph-query pre').textContent()) || '').includes('REFERS_TO')) problems.push('the item-by-item panel does not show its query');
        }
        // How they got there: asking loads the steps of the task, each question shows both models with the
        // command line's counts, and a level the visitor gives one of them is judged in the verdict above.
        {
          const now = await page.evaluate(() => window.ledgerDemo.current());
          const told = await page.evaluate(([t, x, y]) => window.ledgerDemo.process(t, x, y), [now.task, now.a, now.b]);
          await page.locator('#worked-go').click();
          const asked = await page.waitForSelector('#worked .question', { timeout: 90000 }).then(() => true, () => false);
          if (!asked) problems.push('asking how they got there never showed a question');
          else {
            const questions = await page.locator('#worked .question').count();
            if (questions !== told.checks.length) problems.push(`the page asks ${questions} process questions, the command line ${told.checks.length}`);
            for (const c of told.checks) {
              const text = await page.locator(`#worked .question[data-check="${c.check}"] ul.who`).innerText();
              for (const m of c.models) {
                if (!text.includes(`in ${m.attempts_with} of ${m.attempts} attempt`)) problems.push(`${c.check}: the page does not show ${m.attempts_with} of ${m.attempts} for ${m.model}: ${JSON.stringify(text)}`);
              }
            }
            // the question both models show most often: unforgivable must turn the answer round and add the
            // fault to the card, and "not counted" must put the answer back
            const busiest = [...told.checks].sort((x, y) => Math.min(...y.models.map((m) => m.attempts_with)) - Math.min(...x.models.map((m) => m.attempts_with)))[0];
            if (!Math.min(...busiest.models.map((m) => m.attempts_with))) problems.push('no process question was found in both models of the pair checked: nothing to judge');
            else {
              const headline = () => page.locator('#verdict-headline').innerText();
              const before = await headline();
              const picker = () => page.locator(`#worked .question[data-check="${busiest.check}"] select`);
              await picker().selectOption('unforgivable');
              const moved = await page.waitForFunction((old) => document.getElementById('verdict-headline')?.innerText !== old, before, { timeout: 20000 }).then(() => true, () => false);
              if (!moved || !/^Neither is fit/.test(await headline())) problems.push(`making "${busiest.check}" unforgivable did not make both models unfit: ${JSON.stringify(await headline())}`);
              if (!(await page.locator('.tape-row', { hasText: '(your check)' }).count())) problems.push('the visitor\'s own check is not listed among the faults');
              if ((await picker().inputValue()) !== 'unforgivable') problems.push('the level given to a process question is not kept on screen');
              await picker().selectOption('not counted');
              await page.waitForFunction((old) => document.getElementById('verdict-headline')?.innerText === old, before, { timeout: 20000 }).catch(() => problems.push('taking the check away did not restore the verdict'));
              if (await page.locator('.tape-row', { hasText: '(your check)' }).count()) problems.push('a check that is not counted is still listed among the faults');
            }
          }
        }
      }
    }

    // A pair that has never met on a task can still be picked: the result says there is no verdict, shows each
    // model's own record, and names no winner. (Looked for on every workflow: the data has such pairs.)
    let unmetSeen = 0;
    let neverMet = null; // { card, a, b }: a pair with no record, raced live further down
    const cards = await page.locator('#flow-cards button').all();
    for (const [index, card] of cards.entries()) {
      await card.click();
      await page.waitForSelector('#first-list input');
      for (const first of await page.locator('#first-list input').all()) {
        await first.check();
        await page.waitForSelector('#second-model input[name="second"]', { state: 'attached' });
        // every other model is offered as the second, in one list
        const offered = await page.locator('#second-model input[name="second"]').count();
        const tested = await page.locator('#first-list input').count();
        if (offered !== tested - 1) problems.push(`the second-model list offers ${offered} models, but ${tested - 1} others can be chosen first`);
        const unmet = page.locator('#second-model label', { hasText: 'no head-to-head' }).locator('input');
        if (!(await unmet.count())) continue;
        neverMet = { card: index, a: await first.inputValue(), b: await unmet.first().getAttribute('value') };
        await pickSecond(page, neverMet.b);
        await page.waitForFunction(() => !document.getElementById('step-verdict').hidden && /never met/.test(document.getElementById('verdict-headline')?.innerText || ''), null, { timeout: 8000 }).catch(() => problems.push('a pair that never met did not get a plain "no verdict" result'));
        if ((await page.locator('table.own tbody tr').count()) !== 2) problems.push('the no-verdict result does not show each model\'s own record');
        if (await page.locator('#verdict-band.win').count()) problems.push('a pair that never met was given a winner');
        unmetSeen += 1;
        break;
      }
      if (unmetSeen) break;
    }
    if (await page.locator('#unmet-list, #live-a, #live-b').count()) problems.push('the page has a second place to choose models');
    if (!unmetSeen) problems.push('no pair that never met was found to check (the data should have some)');

    // The example button must walk all three steps on its own and end on a drawn verdict with enough evidence.
    await page.evaluate(() => document.getElementById('verdict-body').replaceChildren());
    await page.locator('#example').click();
    const example = await page
      .waitForFunction(
        () => !document.getElementById('step-verdict').hidden && document.getElementById('verdict-body').innerText.trim().length > 200,
        null,
        { timeout: 15000 },
      )
      .then(() => true, () => false);
    // The Relate graph in step 3: one simple picture, labelled as a Relate graph, showing this verdict's own
    // numbers and the question it was read with. The panel that used to sit beside the steps is gone.
    if (example) {
      await page.waitForSelector('#pair-graph figure.graph .gdot', { timeout: 8000 }).catch(() => problems.push('step 3 has no graph picture'));
      // and under the dots, one scenario opened as a graph of its own without a click: the records of its world,
      // with every mark shown (it is drawn as the scenario ended)
      await page.waitForSelector('#world-graph figure.world > svg rect.wnode', { timeout: 15000 }).catch(() => problems.push('step 3 does not show a scenario as a graph of its records'));
      if (await page.locator('#world-graph figure.world > svg [hidden]').count()) problems.push('the scenario drawn in step 3 has marks still hidden');
      if (!(await page.locator('#world-watch').count())) problems.push('the scenario drawn in step 3 offers no way to watch it');
      const shown = await page.evaluate(async () => {
        const v = await window.ledgerDemo.current();
        return {
          rounds: v.rounds.length,
          dots: document.querySelectorAll('#pair-graph .gdot:not(.live)').length,
          a: document.querySelectorAll('#pair-graph .gdot.a:not(.live)').length,
          // the picture is drawn top down: a row per sealed record, and each cell's halves say how the two
          // attempts of that scenario ended, exactly as the verdict's own rounds have it
          records: new Set(v.rounds.map((r) => r.run)).size,
          rows: document.querySelectorAll('#pair-graph .grow:not(.live)').length,
          perRow: [...document.querySelectorAll('#pair-graph .grow:not(.live)')].map((row) => [row.dataset.run, row.querySelectorAll('.gdot').length]),
          halves: [...document.querySelectorAll('#pair-graph .gdot:not(.live)')].map((cell) => [...cell.querySelectorAll('.half')].map((h) => ['clean', 'skipped', 'wrong'].find((k) => h.classList.contains(k))).join('/')).join(' '),
          wanted: v.rounds.map((r) => [[r.a_right, r.a_passed], [r.b_right, r.b_passed]].map(([right, clean]) => (clean ? 'clean' : right ? 'skipped' : 'wrong')).join('/')).join(' '),
          wantedRows: Object.entries(v.rounds.reduce((n, r) => ({ ...n, [r.run]: (n[r.run] || 0) + 1 }), {})),
          grid: document.querySelectorAll('.rounds, .round').length,
          lines: document.querySelectorAll('#pair-graph figure.graph line').length,
          winsA: v.wins[v.a],
          pictures: document.querySelectorAll('figure.graph').length,
          stats: document.getElementById('graph-stats')?.innerText || '',
          query: document.querySelector('#pair-graph pre')?.textContent || '',
          badge: document.querySelector('#pair-graph .relate-badge')?.innerText || '',
          old: document.querySelectorAll('#spine, #spine-body, .frame').length,
        };
      });
      if (shown.dots !== shown.rounds || shown.a !== shown.winsA) problems.push(`the graph picture shows ${shown.dots} scenarios (${shown.a} won by the first model), the verdict has ${shown.rounds} (${shown.winsA})`);
      if (shown.pictures !== 1) problems.push(`the page should have one graph picture, it has ${shown.pictures}`);
      // Step 3 stands in two panes on a wide window (this one is 1280 wide): the answer, the race and the reports
      // on the left, the Relate graph on the right, which stays in view while the left is read down to its end.
      // On a narrow window the three parts read top to bottom, and nothing is wider than the window.
      {
        const boxes = () =>
          page.evaluate(() => {
            const box = (q) => {
              const r = document.querySelector(q).getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            };
            // how far the first thing shown in a part of the answer is set in from that part's own left edge
            const setIn = (q) => {
              const pane = document.querySelector(q);
              const first = [...pane.children].find((n) => n.getBoundingClientRect().height > 0);
              return Math.round(first.getBoundingClientRect().left - pane.getBoundingClientRect().left);
            };
            const titles = [...document.querySelectorAll('.pane-title')].map((n) => Math.round(n.getBoundingClientRect().top));
            return { top: box('.pane-first'), graph: box('#pane-graph'), bottom: box('.pane-rest'), setIn: [setIn('.pane-first'), setIn('.pane-rest')], titles, window: [window.innerWidth, window.innerHeight], wide: document.documentElement.scrollWidth - window.innerWidth };
          });
        const side = await boxes();
        if (!(side.graph.left >= side.top.right && side.bottom.right <= side.graph.left && side.top.left < 100)) problems.push(`on a wide window the graph is not beside the answer: ${JSON.stringify(side)}`);
        if (side.wide > 1) problems.push(`step 3 is ${side.wide} px wider than a wide window`);
        // The two panes start level and the answer fills its own: the first version named a part "top", the page
        // header's class, and the answer came out 40 px lower than the graph and set in at both sides.
        if (side.titles.length !== 2 || Math.abs(side.titles[0] - side.titles[1]) > 1) problems.push(`on a wide window the two panes do not start level: their headings are at ${JSON.stringify(side.titles)}`);
        if (side.setIn.some((x) => Math.abs(x) > 1)) problems.push(`on a wide window the answer is set in from its pane by ${JSON.stringify(side.setIn)} px`);
        for (const id of ['pair-graph', 'worked']) if (!(await page.locator(`#pane-graph #${id}, #pane-graph .${id}`).count())) problems.push(`the graph pane does not hold ${id}`);
        for (const id of ['live', 'race', 'download-spec', 'verdict-band']) if (await page.locator(`#pane-graph #${id}`).count()) problems.push(`${id} is in the graph pane, not with the answer`);
        // (asked in the middle of the left side: at its very end the two panes end together, and the graph
        // leaves the window with the last of the reports, as it should)
        await page.evaluate(() => document.querySelector('.pane-rest h3').scrollIntoView({ block: 'start' }));
        await page.waitForTimeout(300);
        const read = await boxes();
        if (!(read.top.bottom < 0)) problems.push('the window was not scrolled past the answer for the check that the graph stays in view');
        if (!(read.graph.top >= 0 && read.graph.top < 140 && read.graph.bottom <= read.window[1] + 1)) problems.push(`the graph does not stay in view while the reports are read: ${JSON.stringify(read.graph)} in a window ${read.window[1]} high`);
        await page.setViewportSize({ width: 900, height: 720 });
        await page.waitForTimeout(300);
        const stacked = await boxes();
        if (!(stacked.top.bottom <= stacked.graph.top + 1 && stacked.graph.bottom <= stacked.bottom.top + 1 && Math.abs(stacked.graph.left - stacked.top.left) < 2)) problems.push(`on a narrow window the three parts do not read top to bottom: ${JSON.stringify(stacked)}`);
        if (stacked.wide > 1) problems.push(`step 3 is ${stacked.wide} px wider than a narrow window`);
        if (stacked.setIn.some((x) => Math.abs(x) > 1)) problems.push(`on a narrow window the answer is set in from its pane by ${JSON.stringify(stacked.setIn)} px`);
        if (Math.abs(stacked.top.right - stacked.top.left - (stacked.bottom.right - stacked.bottom.left)) > 1) problems.push(`on a narrow window the two parts of the answer are not the same width: ${JSON.stringify(stacked)}`);
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.locator('#h-verdict').scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
      }
      if (shown.rows !== shown.records || JSON.stringify(shown.perRow) !== JSON.stringify(shown.wantedRows)) problems.push(`the graph picture has ${shown.rows} rows (${JSON.stringify(shown.perRow)}) for ${shown.records} sealed records (${JSON.stringify(shown.wantedRows)})`);
      if (shown.halves !== shown.wanted) problems.push('the cells of the graph picture do not say how each attempt ended as the verdict has it');
      if (shown.grid) problems.push('the old grid of squares is still on the page beside the graph');
      if (shown.lines) problems.push(`the graph picture still draws ${shown.lines} lines, one for every link of every scenario`);
      // pointing at a scenario says what happened in it, in a line that stays when the pointer moves on
      await page.locator('#pair-graph button.gdot').nth(Math.min(3, shown.dots - 1)).hover();
      const pointed = await page.locator('#graph-tip').innerText();
      if (!/^Scenario \d+ of \d+, in the (suite match|live race|live batch) of \w+ \d+, \d\d:\d\d UTC: /.test(pointed) || !/(clean run|right, a step skipped|wrong result)\.$/.test(pointed)) problems.push(`pointing at a scenario says: ${JSON.stringify(pointed)}`);
      await page.locator('#h-verdict').hover();
      if ((await page.locator('#graph-tip').innerText()) !== pointed) problems.push('what was said of a scenario is gone as soon as the pointer moves on');
      if ((await page.locator('#pair-graph .gdot.shown').count()) !== 1) problems.push('the scenario whose world is drawn under the rows is not marked in them');
      if (shown.old) problems.push('the graph panel beside the steps is still on the page');
      if (!new RegExp(`${shown.rounds} rows · .* ms`).test(shown.stats) || !shown.query.includes('MATCH')) problems.push(`the graph picture does not show the query behind it and what it returned: ${JSON.stringify(shown.stats)}`);
      if (!/relate/i.test(shown.badge)) problems.push('the graph picture is not labelled as a Relate graph');
      // a scenario in the picture opens its replay, and is then the ringed one
      await page.locator('#pair-graph button.gdot').first().click();
      await page.waitForSelector('#race .track .tick', { state: 'attached', timeout: 8000 }).catch(() => problems.push('clicking a scenario in the graph picture did not open its replay'));
      await page.waitForSelector('#pair-graph .gdot.ring', { timeout: 8000 }).catch(() => problems.push('the scenario being watched is not ringed in the graph picture'));
    }
    const foot = await page.locator('footer').innerText();
    if (!/This view cannot start a match/.test(foot) || /real money/.test(foot)) problems.push('the small print of the public page should say this view cannot start a match');
    for (const id of ['download-spec', 'download-cost', 'download-evidence', 'download-all', 'download-json']) {
      if (example && !(await page.locator(`#${id}`).count())) problems.push(`the result offers no ${id} button`);
    }
    // What the screen may claim (the reports are held to the command line's text above; this is the page's own
    // blueprint and evidence). A hazard with no trips is "not seen", with what that count can rule out, never a
    // clearance. A record is listed with its kind, and an answer key is promised only where one is published.
    // Nothing the record does not hold is printed as "None".
    if (example) {
      const claims = await page.evaluate(() => ({
        left: document.querySelector('.pane-rest').innerText,
        guards: [...document.querySelectorAll('#guard-notes li')].map((n) => n.textContent),
        keys: (document.getElementById('answer-keys') || {}).textContent || '',
        records: [...document.querySelectorAll('ul.evidence li')].map((n) => n.textContent).filter((x) => x.startsWith('Sealed match record')),
        notes: [...document.querySelectorAll('#verdict-body ul.notes:not(#guard-notes) li')].map((n) => n.textContent),
      }));
      for (const never of ['can run alone', 'Autonomy', 'engine commit None', 'sign test p', 'answer key both published']) {
        if (claims.left.includes(never)) problems.push(`step 3 still says "${never}"`);
      }
      // A count of failures is never left unexplained. The guardrails list every fault the model made (how often,
      // and a guard to build) before the planted hazards, and step 3 lists each attempt that did not end in the
      // right result with what went wrong in it. Both must be what the graph says for the pair on screen.
      const shown = await page.evaluate(() => {
        return {
          faultRows: [...document.querySelectorAll('#faults-seen tbody tr')].map((tr) => tr.innerText),
          hazardsFirst: (() => {
            const seen = document.getElementById('faults-seen');
            const hazards = [...document.querySelectorAll('.pane-rest table')].find((t) => /Hazard/.test(t.tHead ? t.tHead.innerText : ''));
            return Boolean(seen && hazards && seen.compareDocumentPosition(hazards) & Node.DOCUMENT_POSITION_FOLLOWING);
          })(),
          wentItems: [...document.querySelectorAll('#went-wrong li')].map((li) => li.textContent),
        };
      });
      if (!shown.faultRows.length) problems.push('the guardrails do not list what went wrong in practice (the faults the model made)');
      if (!shown.hazardsFirst) problems.push('the guardrails must say what went wrong in practice before the planted hazards');
      if (shown.faultRows.some((row) => !/\d+ of \d+/.test(row))) problems.push(`a row of what went wrong has no count: ${JSON.stringify(shown.faultRows)}`);
      if (shown.faultRows.some((row) => /\t-$/.test(row) && !/^nothing:/.test(row))) problems.push(`a fault that was seen has no guard to build: ${JSON.stringify(shown.faultRows)}`);
      if (shown.wentItems.some((x) => !/^Scenario \d+, .+: .+\.$/.test(x))) problems.push(`a line of what went wrong does not say which scenario, which model and what: ${JSON.stringify(shown.wentItems)}`);
      if (!claims.guards.some((x) => /^Not seen is a count, not a clearance: none in \d+ rules out a rate above about \d+%/.test(x))) problems.push(`the guardrail table does not say what "not seen" is worth: ${JSON.stringify(claims.guards)}`);
      if (!/An answer key is published only once a match is over, and only for tests that generate a fresh world/.test(claims.keys)) problems.push('the evidence list does not say when an answer key is published');
      if (!claims.records.length || !claims.records.every((x) => /, (suite match|live race|live batch), seal /.test(x) && /engine commit (not recorded|[0-9a-f]{7}), (no answer key published|answer key published)$/.test(x))) problems.push(`a sealed record is listed without its kind, its engine build or whether its answer key is published: ${JSON.stringify(claims.records.slice(0, 3))}`);
      if (!claims.notes.some((x) => / won \d+: \d+ on (the result|process|efficiency|a tie-break)/.test(x))) problems.push(`the notes do not say what each model's wins were won on: ${JSON.stringify(claims.notes)}`);
      if (claims.notes.some((x) => /it won them on process|good enough/.test(x))) problems.push('the notes still carry the old wording');
    }
    if (!example) problems.push('the example button did not end on a drawn verdict');
    else if (!(await page.locator('#verdict-band').getAttribute('class')).includes('win')) {
      problems.push('the example button did not end on a verdict that names a model to use (the data has one)');
    } else {
      // The visitor's own say must move the verdict: stricter tolerance, then one fault made unforgivable.
      const headline = () => page.locator('#verdict-headline').innerText();
      const settle = (was) =>
        page.waitForFunction((old) => document.getElementById('verdict-headline')?.innerText !== old, was, { timeout: 5000 }).then(
          () => true,
          () => false,
        );
      const personal = await headline();
      await page.locator('input[name=profile][value=enterprise]').check();
      if (!(await settle(personal))) problems.push('switching to enterprise tolerance did not change the example verdict');
      await page.locator('input[name=profile][value=personal]').check();
      await settle(await headline());
      if ((await headline()) !== personal) problems.push('switching back to personal tolerance did not restore the verdict');
      // make every fault unforgivable, one at a time, until the verdict moves; then reset
      const pickers = await page.locator('select.level').count();
      let moved = false;
      for (let i = 0; i < pickers && !moved; i += 1) {
        const before = await headline();
        await page.locator('select.level').nth(i).selectOption('unforgivable');
        moved = await page.waitForFunction((old) => document.getElementById('verdict-headline')?.innerText !== old, before, { timeout: 1500 }).then(() => true, () => false);
      }
      if (!pickers) problems.push('the result offers no fault whose level the visitor can set');
      else if (!moved) problems.push('making every fault unforgivable never changed the example verdict');
      else {
        await page.locator('#reset-levels').click();
        await settle(await headline());
        if ((await headline()) !== personal) problems.push('resetting the levels did not restore the verdict');
      }
    }
    await page.close();

    // A race played under other conditions (here: one at the easy level, added to the graph in this tab) is on
    // file and said so, and moves nothing: not the head to head, not either model's fitness, not the picture.
    {
      const made = expected.conditions.one_easy_race;
      const judged = expected.judged.find((j) => !j.overrides && j.verdict.profile === 'personal' && j.verdict.pairs >= 8).verdict;
      const other = await browser.newPage();
      other.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
      await other.goto(`${origin}${BASE}`);
      await other.evaluate(() => window.ledgerDemo.ready());
      const ask = [judged.task, judged.a, judged.b, 'personal'];
      const before = await other.evaluate(([t, a, b, p]) => window.ledgerDemo.verdict(t, a, b, p), ask);
      const easy = before.conditions.replace(made.from, made.to);
      if (easy === before.conditions) problems.push('the verdict used for the conditions check is not at the standard level');
      await other.evaluate(
        ([version, a, b, conditions]) =>
          window.ledgerDemo.cypher(
            `MATCH (tv:TestVersion {key: $version}), (a:Model {name: $a}), (b:Model {name: $b})
             CREATE (r:Run {run_id: 'check-other-conditions', suite: 'live-race'})
             CREATE (mt:Match {key: 'check-other-conditions/x/1', excluded: false, conditions: $conditions, difficulty: 'easy', rule: 'success'})
             CREATE (mt)-[:PART_OF]->(r)
             CREATE (mt)-[:USED]->(tv)
             CREATE (mt)-[:WON_BY]->(b)
             CREATE (xa:Attempt {key: 'check-other-conditions/x/1/A', passed: false, cost_usd: 0.01})
             CREATE (xa)-[:IN]->(mt)
             CREATE (xa)-[:BY]->(a)
             CREATE (xb:Attempt {key: 'check-other-conditions/x/1/B', passed: true, cost_usd: 0.01})
             CREATE (xb)-[:IN]->(mt)
             CREATE (xb)-[:BY]->(b)`,
            { version, a, b, conditions },
          ),
        [before.version, judged.a, judged.b, easy],
      );
      const after = await other.evaluate(([t, a, b, p]) => window.ledgerDemo.verdict(t, a, b, p), ask);
      same(judged, before, 'conditions check, the verdict before');
      for (const key of ['conditions', 'pairs', 'wins', 'ties', 'p_value', 'verdict', 'better', 'rounds', 'fit', 'headline', 'hazards', 'evidence']) {
        same(before[key], after[key], `a race at the easy level must not move the verdict's ${key}`);
      }
      same([{ conditions: easy, pairs: 1, what: made.what }], after.not_counted, 'the race at the easy level, as not counted');
      if (!after.notes.includes(made.note)) problems.push(`the verdict does not say a race under other conditions was left out: ${JSON.stringify(after.notes)}`);
      if (before.notes.some((n) => /Not counted here/.test(n))) problems.push('the shipped record already has a pair under other conditions: this check needs a new example');
      compared += 2;
      await other.close();
    }

    // With no runner the page says live races are not open, and offers nothing to press.
    // With one (here the stand-in), a race streams into two lanes and ends with a comparison to the record.
    const pair = expected.judged.find((j) => j.verdict.better && !j.overrides).verdict;
    const NEWCOMER = 'openrouter:example/never-raced';
    const runner = await fakeRunner([pair.a, pair.b], NEWCOMER);
    const runnerUrl = `http://127.0.0.1:${runner.address().port}`;
    try {
      const pickPair = async (live) => {
        await live.evaluate(() => window.ledgerDemo.ready());
        await live.locator('#flow-cards button', { hasText: pair.task.includes('refund') ? 'Refund' : pair.task.includes('incident') ? 'Incident' : pair.task.includes('access') ? 'Access' : 'Inventory' }).first().click();
        await live.locator(`#first-list input[value="${pair.a}"]`).check();
        await pickSecond(live, pair.b);
        await live.waitForSelector('#live h4');
      };
      // Nobody is offered a live race without a runner, or with one but no invitation: nothing to press or type.
      for (const query of ['', `?runner=${encodeURIComponent(runnerUrl)}`]) {
        const live = await browser.newPage();
        live.on('pageerror', (e) => problems.push(`live page error: ${e.message}`));
        await live.goto(`${origin}${BASE}${query}`);
        await pickPair(live);
        const who = query ? 'with a runner but no invitation' : 'with no runner';
        await live.waitForSelector('#live-soon', { timeout: 5000 }).catch(() => problems.push(`${who}, the page does not say live races are not open yet`));
        if (await live.locator('#live-go, #live input').count()) problems.push(`${who}, the page still offers a live race or asks for a code`);
        // It says where a live race can be run: on the visitor's own machine with their own key, with a link to
        // the commands. Nobody is told to ask for a code, and a sign-in is named only where there is one.
        const closed = await live.locator('#live-soon').innerText();
        if (!closed.includes('your own API key')) problems.push(`${who}, the page does not say a live race runs with the visitor's own key: ${JSON.stringify(closed)}`);
        if (/judges?\b/i.test(closed) || /judges?\b/i.test(await live.locator('#foot-view').innerText())) problems.push(`${who}, the page still says live races are for judges`);
        const link = await live.locator('#live-soon a').getAttribute('href').catch(() => null);
        if (!link || !link.endsWith('#race-two-models-live-with-your-own-api-key')) problems.push(`${who}, the page does not link to the README's own-key commands: ${link}`);
        else {
          // the link is to a heading that is really in the README
          const heading = link.split('#')[1];
          const headings = fs.readFileSync(path.join(path.dirname(ROOT), 'README.md'), 'utf8').split('\n').filter((line) => /^#+ /.test(line)).map((line) => line.replace(/^#+ /, '').toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'));
          if (!headings.includes(heading)) problems.push(`the page links to a README heading that is not there: #${heading}`);
        }
        // either way a runner is named for this page (in its address, or the one it was published with), and
        // that one is by invitation: the sign-in button is there, and the note says what it is for
        if (!closed.includes('by invitation')) problems.push(`${who}, the page does not say the hosted runner is by invitation`);
        if (!(await live.locator('#judge-open').isVisible())) problems.push(`${who}, the page offers no sign-in button for the runner it names`);
        else if (!(await live.locator('#judge-open').innerText()).includes('by invitation')) problems.push(`${who}, the sign-in button does not say it is by invitation`);
        await live.close();
      }
      if ((runner.signins || []).length) problems.push('a visitor with no invitation was sent to the runner to sign in');

      // With an invitation link: signed in once, the invite leaves the address, and a race needs nothing typed.
      const context = await browser.newContext();
      const live = await context.newPage();
      live.on('pageerror', (e) => problems.push(`live page error: ${e.message}`));
      await live.goto(`${origin}${BASE}?runner=${encodeURIComponent(runnerUrl)}&invite=judge-invite`);
      // the visitor is told at the top, before picking anything, that the link worked
      await live.waitForFunction(() => document.getElementById('live-banner').innerText.includes('signed in for live races'), null, { timeout: 15000 }).catch(() => problems.push('an accepted invitation is not announced at the top of the page'));
      if (!(await live.locator('#live-banner').innerText()).includes('3 live races left')) problems.push('the sign-in banner does not say how many races are left');
      await pickPair(live);
      await live.waitForSelector('#live-go', { timeout: 5000 }).catch(() => problems.push('an invitation link did not open live races'));
      // a visitor who can race live is brought to the run box once the pair is picked: it comes to rest in the
      // middle of the window, and stays there (the picture above it is in place before the page moves)
      const centred = () => {
        const box = document.getElementById('live').getBoundingClientRect();
        return Math.abs((box.top + box.bottom) / 2 - window.innerHeight / 2) < window.innerHeight * 0.2;
      };
      await live.waitForFunction(centred, null, { timeout: 8000 }).catch(() => problems.push('after picking the pair, a signed-in visitor is not brought to the run box'));
      await live.waitForTimeout(1200);
      if (!(await live.evaluate(centred))) problems.push('the run box did not stay in the middle of the window after the page came to rest on it');
      // what the button will run is said in words beside it, and each dropdown says what it chooses
      const what = () => live.locator('#live-what').innerText();
      if (!/This will run: 1 new scenario, .+ against .+\./.test(await what())) problems.push(`the run box says ${JSON.stringify(await what())} before a plain race`);
      if ((await live.locator('#live .race-controls label.pick').count()) !== 4) problems.push('the dropdowns of the run box are not labelled');
      if (!(await live.locator('#live-jump').count())) problems.push('a signed-in visitor has no way straight to the live race from the top of the result');
      if (live.url().includes('judge-invite')) problems.push('the invite is still in the address bar after signing in');
      if (await live.locator('#live input:not([type="checkbox"])').count()) problems.push('a signed-in visitor is still asked to type something');
      // one place to choose the pair: the live panel names the two models from step 2 and offers no others
      if ((await live.locator('#live select').count()) !== 4 || (await live.locator('#live-who option').count()) !== 3) problems.push('the live panel may choose difficulty, scoring, how many scenarios, and which of the two chosen models play: nothing else');
      const named = await live.locator('#live-pair').innerText();
      const chosen = await live.evaluate(() => [...document.querySelectorAll('#first-list input:checked, #second-model input[name="second"]:checked')].map((i) => i.closest('label').querySelector('.name').innerText));
      if (chosen.length !== 2 || !chosen.every((name) => named.includes(name))) problems.push(`the live panel names ${JSON.stringify(named)}, step 2 has ${JSON.stringify(chosen)}`);
      if (!(await live.locator('#first-list label', { hasText: 'can race live' }).count())) problems.push('step 2 does not say which models can be raced live');
      if (!(await live.locator('#live-prior').innerText()).includes('the record')) problems.push('the live panel does not state what the record expects');
      const budget = await live.locator('#live-budget').innerText();
      for (const part of ['OpenRouter $30.00 of $30.00', 'Google $0.10 of $20.00', '3 live races left', 'Gemini']) {
        if (!budget.includes(part)) problems.push(`the live budget line lacks ${JSON.stringify(part)}: ${JSON.stringify(budget)}`);
      }
      await live.locator('#live-go').click();
      await live.waitForFunction(() => document.getElementById('live-result').innerText.startsWith('Live,'), null, { timeout: 10000 }).catch(() => problems.push('the live race never reported a result'));
      const said = await live.locator('#live-result').innerText();
      // The race is said from what happened. Here one model got the right result and the other did not, so it
      // is a win on the job and gets the green box, with how usual each result is for each model in the record.
      const box = live.locator('#live-outcome.win[data-kind="result"]');
      if (!(await box.count())) problems.push('a race one model got right and the other got wrong has no winner box');
      else {
        const text = await box.innerText();
        for (const part of ['won: it got the right result', 'did not (0 of 1 items right)', 'standard difficulty', 'budget scoring', 'right in', 'every step followed', 'not judged: the result was wrong']) {
          if (!text.includes(part)) problems.push(`the box under the live race lacks ${JSON.stringify(part)}: ${JSON.stringify(text)}`);
        }
      }
      // each lane says how its attempt ended in the page's three words, never "passed" or "did not pass"
      const ends = await live.locator('#live-stage .outcome .end').allInnerTexts();
      if (ends.join(' | ') !== '✓ Clean run | ✕ Wrong result') problems.push(`the live lanes end with ${JSON.stringify(ends)}`);
      if (/\bpass(ed)?\b/i.test(await live.locator('#live-stage').innerText())) problems.push('the live lanes still speak of passing');

      // The rules behind those words, case by case (window.ledgerDemo.raceOutcome): a winner's box only when the
      // winner did the job. Two runs that both cut a corner, or two wrong results, are never called a win.
      {
        const end = (right, clean, extra = {}) => ({ graded: true, right, clean, items: 12, correct: right ? 12 : 9, slips: clean ? [] : right ? ['acted without reading'] : [], cost: 0.004, seconds: 30, ...extra });
        const cases = [
          ['both clean, one cheaper', end(true, true, { cost: 0.01 }), end(true, true), 'b', 'efficiency', 'win', 'won on efficiency'],
          ['both clean, nothing between them', end(true, true), end(true, true), null, 'tie', 'even', 'No winner'],
          ['both right, one clean', end(true, false), end(true, true), 'b', 'process', 'win', 'won on process'],
          ['both right, neither clean', end(true, false, { cost: 0.0185, seconds: 201 }), end(true, false), 'b', 'unclean', 'mixed', 'Both right, neither clean'],
          ['one right and clean, one wrong', end(true, true), end(false, false), 'a', 'result', 'win', 'won: it got the right result'],
          ['one right with a step skipped, one wrong', end(true, false), end(false, false), 'a', 'result', 'win', 'won: it got the right result'],
          ['only the loser got it right', end(true, false), end(false, false, { correct: 12 }), 'b', 'split', 'mixed', 'No clear winner'],
          ['neither right, one got further', end(false, false, { correct: 10 }), end(false, false, { correct: 7 }), 'a', 'neither', 'stop', 'Neither got the right result'],
        ];
        for (const [what, A, B, winner, kind, tone, headline] of cases) {
          const got = await live.evaluate(([x, y, w, a, b]) => window.ledgerDemo.raceOutcome({ a, b, winner: w === 'a' ? a : w === 'b' ? b : null, A: x, B: y }), [A, B, winner, pair.a, pair.b]);
          if (got.kind !== kind || got.tone !== tone || !got.headline.includes(headline)) problems.push(`a race that was "${what}" is said as ${JSON.stringify([got.kind, got.tone, got.headline])}, not ${JSON.stringify([kind, tone, headline])}`);
          if (tone !== 'win' && /\bwon\b/.test(`${got.headline} ${got.body}`)) problems.push(`a race that was "${what}" is still called won: ${JSON.stringify(got)}`);
          compared += 1;
        }
        // the owner's race of Nov 26: both right, each skipped one lookup, one far cheaper and faster
        const both = await live.evaluate(([x, y, a, b]) => window.ledgerDemo.raceOutcome({ a, b, winner: b, A: x, B: y }), [end(true, false, { cost: 0.0185, seconds: 201 }), end(true, false, { cost: 0.0045, seconds: 30 }), pair.a, pair.b]);
        for (const part of ['neither passed the test as written', 'is ahead on efficiency ($0.0045 in 30 s, against $0.0185 in 201 s)', 'not a win on the job']) {
          if (!both.body.includes(part)) problems.push(`"both right, neither clean" does not say ${JSON.stringify(part)}: ${JSON.stringify(both.body)}`);
        }
        // why a recorded scenario went to its winner, in the same words (the replay's last line, the grid's labels)
        const round = (winner, ar, ac, br, bc, rule = 'efficiency') => ({ winner, rule, a_right: ar, a_passed: ac, b_right: br, b_passed: bc });
        const whys = [
          [round(pair.a, true, true, true, true), 'efficiency'],
          [round(pair.a, true, true, true, false, 'success'), 'process'],
          [round(pair.b, false, false, true, true, 'success'), 'result'],
          [round(pair.b, true, false, true, false), 'unclean'],
          [round(pair.a, false, false, false, false, 'progress'), 'neither'],
          [round('tie', true, true, true, true), 'tie'],
        ];
        for (const [r, kind] of whys) {
          const got = await live.evaluate(([x, a]) => window.ledgerDemo.whyTaken(x, a), [r, pair.a]);
          if (got.kind !== kind) problems.push(`a scenario ${JSON.stringify(r)} is explained as ${JSON.stringify(got)}, not as ${kind}`);
          compared += 1;
        }
      }
      const want = pair.better === pair.a ? 'in line with the record' : 'against the record';
      if (!said.includes(want)) problems.push(`the live result should read "${want}": ${JSON.stringify(said)}`);
      if (!said.includes('live-check-1')) problems.push('the live result does not name its sealed record');
      // the live race offers its own report: this scenario, both costs, its sealed record, and that it is live
      const liveText = await live.evaluate(() => window.ledgerDemo.lastLiveReport || '');
      if (!(await live.locator('#download-live').count())) problems.push('the live result offers no report to download');
      for (const part of ['# Live race report', 'live-check-1', '$0.0021', '$0.0034', 'This race cost $0.0055', 'joins the record']) {
        if (!liveText.includes(part)) problems.push(`the live race report lacks ${JSON.stringify(part)}`);
      }
      const ticks = await live.locator('#live-stage .track .tick').count();
      if (ticks !== 6) problems.push(`the live lanes show ${ticks} of the 6 streamed steps`);
      if ((await live.locator('#live-stage .outcome:not([hidden])').count()) !== 2) problems.push('the live lanes do not both show a grade');
      if (!(await live.locator('#live-stage .track .tick.timeout').count())) problems.push('the timed-out step is not marked');
      if (!(await live.locator('#live-stage .track .tick.again').count())) problems.push('acting on the same item again is not marked');
      // the marks are explained, and each lane counts what happened: lane A of the stand-in race had 4 steps, one
      // timed out and one repeated an action; lane B had none of either
      if ((await live.locator('#live-stage .legend.marks > span').count()) < 6) problems.push('the live lanes have no legend saying what each mark means');
      const chips = await live.locator('#live-stage .lane').evaluateAll((lanes) => lanes.map((lane) => [...lane.querySelectorAll('.counts .chip:not([hidden])')].map((c) => c.innerText.trim())));
      if (!(chips[0] || []).includes('4 steps') || !chips[0].includes('1 timed out') || !chips[0].includes('1 acted again')) problems.push(`lane A's running counts are wrong: ${JSON.stringify(chips[0])}`);
      if (!(chips[1] || []).includes('2 steps') || chips[1].some((c) => /timed out|acted again|wrong|refused/.test(c))) problems.push(`lane B's running counts are wrong: ${JSON.stringify(chips[1])}`);
      const off = await live.locator('#live-stage .track .tick').evaluateAll((marks) => marks.filter((m) => parseFloat(m.style.left) > 100).length);
      if (off) problems.push(`${off} live steps are drawn past the end of the track`);
      // the live result joined the graph as its own kind of node: drawn dashed, and counted in no verdict
      await live.waitForSelector('#pair-graph .gdot.live', { timeout: 5000 }).catch(() => problems.push('the live result did not join the graph picture'));
      const drawn = await live.locator('#pair-graph .gdot').count(); // the scenario cells, not the marks of the world drawn under them
      if (drawn !== pair.pairs + 1) problems.push(`the graph after the live race shows ${drawn} dots, not ${pair.pairs} recorded + 1 live`);
      const after = await live.evaluate(([t, a, b]) => window.ledgerDemo.verdict(t, a, b), [pair.task, pair.a, pair.b]);
      if (after.pairs !== pair.pairs || after.wins[pair.a] !== pair.wins[pair.a]) problems.push('a live result changed the recorded verdict');
      const ask = runner.asked;
      if (!(ask.a === pair.a && ask.b === pair.b && ask.task === pair.task.split('/').pop())) problems.push(`the page asked the runner for ${JSON.stringify(ask)}`);
      if (ask.token !== 'session-1' || 'code' in ask || 'invite' in ask) problems.push(`a race must carry the session and nothing else secret: ${JSON.stringify(Object.keys(ask))}`);
      // the race is written up on the page: who passed, what the other got wrong (the item, what it chose and what
      // was right), and the first draft of the pair's live history, kept apart from the record
      await live.waitForSelector('#live-history .race-card', { timeout: 5000 }).catch(() => problems.push('the live race was not written up on the page'));
      const written = await live.locator('#live-history').innerText();
      for (const part of ['First draft from 1 live race', 'took 1', 'took 0', 'Right result:', 'Clean runs:', 'Live race 1', 'won: it got the right result', '1 of 1 items right', 'wrong decision', 'stopped before finishing', 'ALR-1: it chose "escalate alert", the right decision was "close alert"', 'live-check-1', 'not a verdict', 'join the record']) {
        if (!written.includes(part)) problems.push(`the live write-up lacks ${JSON.stringify(part)}: ${JSON.stringify(written.slice(0, 600))}`);
      }
      if ((await live.locator('#live-history .race-card').count()) !== 1) problems.push('one live race should be written up once');
      // The runner plays one race at a time. A run it refuses for being busy must not look like a race under way:
      // no empty lanes, the button off, and the reason right beside it. The button must come back by itself once
      // the runner is free (the page asks it every few seconds), with nothing spent.
      {
        const budgets = () => live.evaluate((at) => fetch(`${at}/options`).then((x) => x.json()).then((o) => JSON.stringify(o.budgets)), runnerUrl);
        const before = await budgets();
        runner.busy = true;
        await live.locator('#live-go').click();
        await live
          .waitForFunction(() => document.getElementById('live-go').disabled && !document.getElementById('live-busy').hidden, null, { timeout: 6000 })
          .catch(() => problems.push('a run refused by a busy runner did not switch the button off and say so'));
        const told = await live.locator('#live-busy').innerText();
        if (!/busy/.test(told) || !/comes back by itself/.test(told)) problems.push(`the busy notice reads ${JSON.stringify(told)}`);
        if (await live.locator('#live-stage > *').count()) problems.push('a run refused by a busy runner left lanes on screen, as if a race were under way');
        if ((await live.locator('#live-result').innerText()).trim()) problems.push('a busy runner is reported twice: once beside the button and once as a result');
        runner.busy = false;
        await live
          .waitForFunction(() => !document.getElementById('live-go').disabled && document.getElementById('live-busy').hidden, null, { timeout: 12000 })
          .catch(() => problems.push('the button did not come back when the runner was free again'));
        const after = await budgets();
        if (before !== after) problems.push('a refused run moved the live budget');
      }
      // A batch: the same test ten times in one go. First one model on both lanes (a steadiness check), then the pair.
      if ((await live.locator('#live-runs option:not([disabled])').count()) !== 2) problems.push('the live panel does not offer exactly the batch sizes the runner has');
      if ((await live.locator('#live-runs option[disabled]').count()) !== 2) problems.push('the bigger batch sizes are not shown as coming');
      // before any money is spent: what the record says of each model on this task, and what the run should cost
      const before = await live.locator('#live-expect').innerText();
      if (!/Before you run/.test(before) || (before.match(/got the right result in \d+ of \d+ recorded attempts on this task/g) || []).length !== 2 || !/should cost about \$/.test(before)) problems.push(`the live panel does not say what to expect before a run: ${JSON.stringify(before)}`);
      if (!(await live.locator('#foot-view').innerText()).includes('real money')) problems.push('the small print of a signed-in page does not say live runs spend real money');
      await live.locator('#live-who').selectOption('a');
      if ((await live.locator('#live-runs').inputValue()) !== '10' || !(await live.locator('#live-go').innerText()).includes('batch of 10')) problems.push('choosing one model on both lanes did not switch to a batch');
      // one model on both lanes is easy to choose by mistake: the button names it, and the line beside it says
      // in words that this is a steadiness check and not the match
      if (!(await live.locator('#live-go').innerText()).includes('against itself')) problems.push('the button does not say a batch is one model against itself');
      const alone = await live.locator('#live-what').innerText();
      if (!/10 new scenarios, .+ on both lanes/.test(alone) || !/steadiness check/.test(alone) || !(await live.locator('#live-what.alone').count())) problems.push(`the run box does not warn that one model plays both lanes: ${JSON.stringify(alone)}`);
      await live.locator('#live-go').click();
      await live.waitForSelector('#batch-band', { timeout: 10000 }).catch(() => problems.push('the batch never reported a result'));
      if (runner.asked.a !== pair.a || runner.asked.b !== pair.a || runner.asked.runs !== 10) problems.push(`a steadiness batch asked the runner for ${JSON.stringify(runner.asked)}`);
      const steady = await live.locator('#live-batch').innerText();
      for (const part of ['STEADINESS CHECK', 'ran 19 of 20 attempts clean (95%)', 'ended the same way in 9 of 10', 'unlikely to be above', 'acted without reading in 1', '$0.0412', 'live-batch-1', 'never head-to-head']) {
        if (!steady.toUpperCase().includes(part.toUpperCase())) problems.push(`the steadiness result lacks ${JSON.stringify(part)}: ${JSON.stringify(steady.slice(0, 500))}`);
      }
      if (!(await live.locator('#live-stage .batch-lane').first().innerText()).includes('10 steps so far')) problems.push('a batch lane does not count steps as they happen');
      const squares = await live.locator('#live-stage .bsq').evaluateAll((all) => [all.length, all.filter((x) => x.classList.contains('pass')).length, all.filter((x) => x.classList.contains('fail')).length]);
      if (squares.join() !== '20,19,1') problems.push(`the batch squares show ${squares} (all, clean runs, not clean), not 20,19,1`);
      // an attempt that got every decision right and skipped a step is not the same failure as a wrong decision
      const soft = live.locator('#live-stage .bsq.fail.soft');
      if ((await soft.count()) !== 1 || !/right result, a step skipped \(acted without reading\)/.test((await soft.first().getAttribute('title')) || '')) problems.push('an attempt that got every decision right but skipped a step is not marked apart from a wrong one');
      if (!(await live.locator('#batch-right').innerText().catch(() => '')).includes('1 of the 1 that were not clean runs')) problems.push('the batch does not say how many of the attempts that were not clean runs had every decision right');
      if (!(await live.locator('#batch-legend').count())) problems.push('the batch lanes have no legend');
      if (await live.locator('#live-stage .bsq.won, #live-stage .bsq.lost').count()) problems.push('one model on both lanes was given scenario winners');
      if (!(await live.evaluate(() => window.ledgerDemo.lastLiveReport)).includes('# Live batch report')) problems.push('the batch offers no report');
      // a steadiness check is chosen for one run: once it is done the run box is back on the match
      if ((await live.locator('#live-who').inputValue()) !== 'pair' || /on both lanes/.test(await live.locator('#live-what').innerText())) problems.push('after a steadiness check the run box still has one model on both lanes');
      await live.locator('#live-who').selectOption('pair');
      await live.locator('#live-go').click();
      await live.waitForFunction(() => /won 5 of 8 scenarios both played/.test(document.getElementById('batch-band')?.innerText || ''), null, { timeout: 10000 }).catch(() => problems.push('a batch between the pair did not name who won more scenarios'));
      if (runner.asked.a !== pair.a || runner.asked.b !== pair.b) problems.push('a pair batch did not race the pair chosen in step 2');
      if (!(await live.locator('#batch-band.win').count())) problems.push('the winner of a batch does not get the green box');
      // which lane won which scenario is on the lanes themselves: 5 to the first, 3 to the second, none where one did not play
      const rings = await live.evaluate(() => ['a', 'b'].map((lane) => document.querySelectorAll(`#live-stage .batch-lane.${lane} .bsq.won`).length));
      if (rings.join() !== '5,3') problems.push(`the lanes ring ${rings} scenarios as won, not 5 and 3`);
      if (!(await live.locator('#live-stage .batch-lane.a').innerText()).includes('took 5 scenarios')) problems.push('a lane does not say how many scenarios it took');
      if (!/won this scenario/.test((await live.locator('#live-stage .batch-lane.b .bsq').nth(2).getAttribute('title')) || '')) problems.push('the scenario one lane passed and the other did not is not marked as won');
      // pressing the button brings the race into view, and the way back to the start stays in reach
      const inView = await live
        .waitForFunction(
          () => {
            const [lanes, strip] = ['live-stage', 'trail'].map((id) => document.getElementById(id).getBoundingClientRect());
            return lanes.bottom > 0 && lanes.top < innerHeight && strip.top >= 0 && strip.bottom <= innerHeight;
          },
          null,
          { timeout: 4000 },
        )
        .then(() => true, () => false);
      if (!inView) problems.push('after a batch, the lanes or the Start over strip are out of view');
      if (!(await live.locator('#trail #start-over').isVisible())) problems.push('Start over is not in the strip at the top of the window');
      // scenarios one side did not play are said plainly, and every count stands on the scenarios both played
      const unplayed = await live.locator('#batch-unplayed').innerText().catch(() => '');
      if (runner.asked.early_stop !== true) problems.push('a batch did not ask the runner to stop early by default');
      if (!(await live.locator('#live-early').isVisible())) problems.push('a batch does not offer the early stop');
      if (!/^Stopped early: .* did not run 3 of the 10 scenarios asked for clean, so it could no longer run 80% of them clean/.test(unplayed) || !unplayed.includes('8 scenarios were played by both')) problems.push(`a batch cut short does not say so: ${JSON.stringify(unplayed)}`);
      const cutShort = await live.locator('#live-batch').innerText();
      for (const part of ['8 of 8 played (100%); 2 not played', '9 of 10 played (90%)', '8 fresh scenarios (of 10 asked for)']) if (!cutShort.includes(part)) problems.push(`the cut-short batch lacks ${JSON.stringify(part)}: ${JSON.stringify(cutShort.slice(0, 700))}`);
      if ((await live.locator('#live-stage .bsq.skip').count()) !== 2) problems.push('scenarios that were not played are not marked on the lane');
      await live.waitForFunction(() => document.querySelectorAll('#live-batches li').length === 2, null, { timeout: 6000 }).catch(() => problems.push('the batches on file are not listed'));
      const afterBatch = await live.evaluate(([t, a, b]) => window.ledgerDemo.verdict(t, a, b), [pair.task, pair.a, pair.b]);
      if (afterBatch.pairs !== pair.pairs) problems.push('a live batch changed the recorded verdict');
      await live.locator('#live-runs').selectOption('1');
      // the money and the races left are read again after a race
      await live.waitForFunction(() => document.getElementById('live-budget').innerText.includes('2 live races left'), null, { timeout: 5000 }).catch(() => problems.push('the budget line was not refreshed after the race'));
      if (!(await live.locator('#live-budget').innerText()).includes('OpenRouter $29.99 of $30.00')) problems.push('the provider budget was not refreshed after the race');

      // A live result that has not been downloaded is not thrown away by a stray click: the page asks first.
      let asked = 0;
      let answer = 'dismiss';
      live.on('dialog', (dialog) => {
        asked += 1;
        return answer === 'accept' ? dialog.accept() : dialog.dismiss();
      });
      await live.locator('#flow-cards button').first().click();
      if (asked !== 1) problems.push('picking another workflow over an undownloaded live result did not ask first');
      if (!(await live.locator('#batch-band').count())) problems.push('saying no to leaving still threw the live result away');
      await live.locator('#start-over').click();
      if (asked !== 2 || (await live.locator('#step-verdict').isHidden())) problems.push('Start over did not ask before dropping a live result, or dropped it anyway');
      answer = 'accept';
      await live.locator('#start-over').click();
      await live.waitForFunction(() => document.getElementById('step-verdict').hidden && document.getElementById('step-models').hidden, null, { timeout: 5000 }).catch(() => problems.push('Start over did not clear the page'));
      if (!(await live.locator('#live-banner').innerText()).includes('signed in')) problems.push('Start over signed the visitor out');
      await live.locator('#flow-cards button').first().click();
      if (asked !== 3) problems.push('the page asked again about a live result that was already let go');
      await live.close();

      // A pair with a model that is not on the live list is not raced as some other pair: the panel says which
      // model cannot be raced and offers no race at all.
      const other = await context.newPage();
      await other.goto(`${origin}${BASE}?runner=${encodeURIComponent(runnerUrl)}`);
      await other.evaluate(() => window.ledgerDemo.ready());
      await other.locator('#flow-cards button', { hasText: pair.task.includes('refund') ? 'Refund' : pair.task.includes('incident') ? 'Incident' : pair.task.includes('access') ? 'Access' : 'Inventory' }).first().click();
      await other.locator(`#first-list input[value="${pair.a}"]`).check();
      await other.waitForSelector('#second-model input[name="second"]', { state: 'attached' });
      const offList = await other.locator('#second-model input[name="second"]').evaluateAll((inputs, b) => inputs.map((i) => i.value).find((value) => value !== b), pair.b);
      if (!offList) problems.push('no second model off the live list was found to check');
      else {
        await pickSecond(other, offList);
        await other.waitForSelector('#live-absent', { timeout: 8000 }).catch(() => problems.push('the page does not say that a model on screen cannot be raced live'));
        if (await other.locator('#live-go').count()) problems.push('a race is offered for a pair with a model that is not on the live list');
      }
      // A model the platform can run but that has no record at all is still offered, and says so: a record is
      // information, never a condition. (The stand-in runner offers one such model.)
      const fresh = other.locator(`#second-model input[name="second"][value="${NEWCOMER}"]`);
      if (!(await fresh.count())) problems.push('a model the runner offers, with no record, is not offered in step 2');
      else {
        if (!(await other.locator('#first-list label', { hasText: 'not tested on this workflow yet' }).count())) problems.push('a model with no record is not described as one on its card');
        await pickSecond(other, NEWCOMER);
        await other.waitForFunction(() => /never met/.test(document.getElementById('verdict-headline')?.innerText || ''), null, { timeout: 8000 }).catch(() => problems.push('choosing a model with no record did not give a plain "no verdict" result'));
        await other.waitForSelector('#live-go', { timeout: 8000 }).catch(() => problems.push('a model with no record, on the live list, cannot be raced'));
      }
      await other.close();

      // Two models that never met, both on the live list: chosen in step 2 like any pair, raced, and described as
      // the first evidence between them, before and after.
      if (neverMet) {
        runner.more = [neverMet.a, neverMet.b];
        const first = await context.newPage();
        await first.goto(`${origin}${BASE}?runner=${encodeURIComponent(runnerUrl)}`);
        await first.evaluate(() => window.ledgerDemo.ready());
        await first.locator('#flow-cards button').nth(neverMet.card).click();
        await first.locator(`#first-list input[value="${neverMet.a}"]`).check();
        await pickSecond(first, neverMet.b);
        await first.waitForSelector('#live-go', { timeout: 8000 }).catch(() => problems.push('a pair that never met, both on the live list, is not offered a live race'));
        if (!(await first.locator('#live-prior').innerText()).includes('never met')) problems.push('a pair with no record is not described as one in the live panel');
        await first.locator('#live-go').click();
        await first.waitForFunction(() => document.getElementById('live-result').innerText.includes('the first these two have played'), null, { timeout: 10000 }).catch(() => problems.push('a first race between two models is not described as the first evidence'));
        await first.waitForFunction(() => /met once/.test(document.getElementById('band-live')?.innerText || ''), null, { timeout: 6000 }).catch(() => problems.push('after a first live race the no-verdict band does not say the two have now met live'));
        if (!(await first.locator('#live-history').innerText()).includes('all that is known')) problems.push('the live history of a pair with no record does not say it is all that is known');
        await first.waitForFunction(() => document.querySelectorAll('#pair-graph .gdot.live').length === 1, null, { timeout: 6000 }).catch(() => problems.push('a first live race is not drawn in the graph picture of a pair with no record'));
        if (runner.asked.a !== neverMet.a || runner.asked.b !== neverMet.b) problems.push(`the page raced ${runner.asked.a} vs ${runner.asked.b}, not the pair chosen in step 2`);
        if (!(await first.evaluate(() => window.ledgerDemo.lastLiveReport)).includes('no match between these two')) problems.push('the live report of a first race does not say there was no record');
        await first.close();
        runner.more = [];
      }

      // A runner on the visitor's own machine, with their own key: it asks for no sign-in, so the race button is
      // there with nothing typed, the page says whose runner it is using, and what a race can cost is on screen
      // before it is pressed.
      {
        runner.own = true;
        const signinsBefore = (runner.signins || []).length;
        const own = await (await browser.newContext()).newPage();
        own.on('pageerror', (e) => problems.push(`own-runner page error: ${e.message}`));
        await own.goto(`${origin}${BASE}?runner=${encodeURIComponent(runnerUrl)}`);
        await own.waitForFunction(() => document.getElementById('live-banner').innerText.includes('Live races are on'), null, { timeout: 15000 }).catch(() => problems.push('a runner that asks for no sign-in is not announced at the top of the page'));
        const banner = await own.locator('#live-banner').innerText();
        if (!banner.includes(runnerUrl) || !banner.includes('no sign-in')) problems.push(`the banner does not say which runner the page is using, or that it needs no sign-in: ${JSON.stringify(banner)}`);
        if (banner.includes('signed in')) problems.push('a visitor using their own runner is told they are signed in');
        if (await own.locator('#judge-open').isVisible()) problems.push('a sign-in button is shown for a runner that asks for none');
        if (await own.locator('#judge-out').count()) problems.push('a sign-out button is shown for a runner that asks for no sign-in');
        await pickPair(own);
        await own.waitForSelector('#live-go', { timeout: 5000 }).catch(() => problems.push('a runner that asks for no sign-in did not open live races'));
        const limits = await own.locator('#live-budget').innerText();
        for (const part of ['One race can cost $0.25 at most', '$5.00 more at most, of $5.00 in all']) {
          if (!limits.includes(part)) problems.push(`the run box of an own runner lacks ${JSON.stringify(part)}: ${JSON.stringify(limits)}`);
        }
        const print = await own.locator('#foot-view').innerText();
        for (const part of ['asks for no sign-in', 'real money', 'the API key that runner holds']) if (!print.includes(part)) problems.push(`the small print of a page using an own runner lacks ${JSON.stringify(part)}`);
        if (print.includes('your sign-in')) problems.push('the small print says a sign-in is sent to a runner that asks for none');
        await own.locator('#live-go').click();
        await own.waitForFunction(() => document.getElementById('live-result').innerText.startsWith('Live,'), null, { timeout: 10000 }).catch(() => problems.push('a race on an own runner never reported a result'));
        if (runner.asked.token || runner.asked.invite || runner.asked.code) problems.push(`a race on a runner that asks for no sign-in carried one: ${JSON.stringify(runner.asked)}`);
        if ((runner.signins || []).length !== signinsBefore) problems.push('the page tried to sign in to a runner that asks for no sign-in');
        // what is left has moved with the race
        await own.waitForFunction(() => document.getElementById('live-budget').innerText.includes('$4.99 more at most'), null, { timeout: 8000 }).catch(() => problems.push('what the own runner has left to spend was not read again after the race'));
        // The provider refuses the key (mistyped, no credit, or not allowed this model): neither model is run.
        // That is not a result. The page says the race was not played, gives the provider's words, says nothing
        // is counted, and on an own runner says what to check. It never words it as two wrong results.
        runner.refuse = "anthropic AuthenticationError: Error code: 401 - {'type': 'error', 'error': {'type': 'authentication_error', 'message': 'invalid x-api-key'}}";
        await own.locator('#live-go').click();
        await own.waitForSelector('#live-outcome[data-kind="not-judged"]', { timeout: 10000 }).catch(() => problems.push('a race the provider refused is not shown as a race that could not be judged'));
        const refusedBox = await own.locator('#live-outcome').innerText().catch(() => '');
        for (const part of ['Not played', 'was not run', 'invalid x-api-key', 'counts for nothing', '.env']) {
          if (!refusedBox.includes(part)) problems.push(`the box of a refused race lacks ${JSON.stringify(part)}: ${JSON.stringify(refusedBox.slice(0, 400))}`);
        }
        for (const part of ['right result', 'unusual for it', 'won']) if (refusedBox.includes(part)) problems.push(`a race that was not played is worded as a result (${JSON.stringify(part)})`);
        const refusedSaid = await own.locator('#live-result').innerText();
        if (!refusedSaid.includes('could not be judged')) problems.push(`the line under a refused race does not say it could not be judged: ${JSON.stringify(refusedSaid)}`);
        if (/other conditions|had no winner/.test(refusedSaid)) problems.push(`the line under a refused race gives another reason: ${JSON.stringify(refusedSaid)}`);
        if ((await own.locator('#live-stage .lane .now').allInnerTexts()).filter((t) => t.includes('invalid x-api-key')).length !== 2) problems.push('the lanes of a refused race do not both show what the provider said');
        runner.refuse = null;
        await own.context().close();
        runner.own = false;
      }

      // An invitation the runner does not accept is said so at the top: never a silent fall back to the public page.
      const wrong = await browser.newPage();
      await wrong.goto(`${origin}${BASE}?runner=${encodeURIComponent(runnerUrl)}&invite=not-the-invite`);
      await wrong.waitForFunction(() => document.getElementById('live-banner').innerText.includes('was not accepted'), null, { timeout: 15000 }).catch(() => problems.push('a refused invitation is not announced at the top of the page'));
      await pickPair(wrong);
      if (await wrong.locator('#live-go, #live-jump').count()) problems.push('a refused invitation still offers a live race');
      await wrong.close();

      // Signing in from the page itself: a button opens a box, the code typed there signs the browser in, and a
      // result already on screen gets its live panel. No address has to be put together by hand.
      const typed = await (await browser.newContext()).newPage();
      typed.on('pageerror', (e) => problems.push(`sign-in page error: ${e.message}`));
      await typed.goto(`${origin}${BASE}?runner=${encodeURIComponent(runnerUrl)}`);
      await pickPair(typed);
      await typed.waitForSelector('#live-soon', { timeout: 5000 });
      if (!(await typed.locator('#judge-open').isVisible())) problems.push('the public page offers no sign-in button');
      await typed.locator('#judge-open').click();
      await typed.fill('#judge-code', 'not-the-code');
      await typed.locator('#judge-go').click();
      await typed.waitForFunction(() => document.getElementById('judge-note').innerText.includes('not accepted'), null, { timeout: 8000 }).catch(() => problems.push('a wrong code typed into the sign-in box is not refused in plain words'));
      // 'not-the-code' is 12 characters and its SHA-256 starts 8970b: the box says both, and never the code
      const refusal = await typed.locator('#judge-note').innerText();
      for (const part of ['12 characters', 'fingerprint 8970b']) if (!refusal.includes(part)) problems.push(`a refused code is not described (${part}): ${JSON.stringify(refusal)}`);
      if (refusal.includes('not-the-code')) problems.push('the sign-in box repeated the refused code');
      if (await typed.locator('#live-go').count()) problems.push('a wrong code opened live races');
      await typed.fill('#judge-code', 'judge-invite');
      await typed.locator('#judge-go').click();
      await typed.waitForFunction(() => document.getElementById('live-banner').innerText.includes('signed in for live races'), null, { timeout: 8000 }).catch(() => problems.push('the right code typed into the sign-in box did not sign the visitor in'));
      await typed.waitForSelector('#live-go', { timeout: 8000 }).catch(() => problems.push('after signing in from the box, the result on screen did not get its live panel'));
      if (await typed.locator('#judge-dialog[open]').count()) problems.push('the sign-in box stayed open after signing in');
      if (await typed.locator('#judge-open').isVisible()) problems.push('the sign-in button is still shown to a signed-in visitor');
      if (typed.url().includes('judge-invite')) problems.push('the typed code ended up in the address bar');
      // and out again: back to the public page
      await typed.locator('#judge-out').click();
      await typed.waitForSelector('#live-soon', { timeout: 8000 }).catch(() => problems.push('signing out did not return to the public page'));
      if (!(await typed.locator('#foot-view').innerText()).includes('cannot start a match')) problems.push('after signing out the small print is still the signed-in one');
      if (await typed.locator('#live-go').count()) problems.push('a signed-out visitor is still offered a live race');
      await typed.context().close();

      // The sign-in is kept: the same browser comes back with no invite in the link and can still race.
      const back = await context.newPage();
      await back.goto(`${origin}${BASE}?runner=${encodeURIComponent(runnerUrl)}`);
      await pickPair(back);
      await back.waitForSelector('#live-go', { timeout: 5000 }).catch(() => problems.push('the sign-in was not kept for the next visit'));
      // and the tally is still there: it lives on the runner, not in the page
      await back.waitForSelector('#live-history .race-card', { timeout: 6000 }).catch(() => problems.push('the live history was lost on the next visit'));
      const kept = await back.locator('#live-history').innerText();
      if (!kept.includes('First draft from') || !kept.includes('it chose')) problems.push(`the live history on the next visit does not carry the write-ups: ${JSON.stringify(kept.slice(0, 300))}`);
      if ((await back.locator('#pair-graph .gdot.live').count()) < 1) problems.push('earlier live races are not drawn in the graph on the next visit');
      await context.close();
    } finally {
      runner.close();
    }
    return { stats, requests, clicked, slowest };
  } finally {
    await browser.close();
    server.close();
  }
}

main().then(
  ({ stats, requests, clicked, slowest }) => {
    if (!compared) problems.push('nothing was compared');
    if (problems.length) {
      console.error(`FAILED: ${problems.length} problem(s)`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(
      `OK: the page matches the command line. ${compared} values compared ` +
        `(verdicts, specs and their Markdown, flow searches, opponents); no console errors or failed requests.`,
    );
    console.log(
      `Graph: ${stats.matches} matches, ${stats.pairs} judged pairs, ${stats.models} models; ready in ` +
        `${Math.round(stats.total_ms)} ms (fetch and start ${Math.round(stats.fetch_ms)} ms, build ${Math.round(stats.build_ms)} ms). ` +
        `${requests} requests, all to this folder. Clicked through ${clicked} pairs of models; each drew a verdict, ` +
        `the slowest in ${slowest.ms} ms (${slowest.what}).`,
    );
  },
  (error) => {
    console.error(`FAILED: ${error.stack || error}`);
    process.exit(1);
  },
);
