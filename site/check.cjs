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
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.url === '/options') {
      const tasks = ['refund-queue', 'access-review', 'incident-triage', 'inventory-transfer'].map((id) => ({ id, name: id, levels: ['easy', 'standard'] }));
      const budgets = [{ provider: 'openrouter', limit_usd: 30, left_usd: 30 - (3 - races) * 0.0055 }, { provider: 'google', limit_usd: 20, left_usd: 0.1 }];
      return json(res, 200, { tasks, models: [...models, extra], models_out: ['google:gemini-3.1-flash-lite'], budgets, profiles: ['balanced', 'budget', 'latency'], needs_code: true });
    }
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
      if (ask.token !== 'session-1') return json(res, 403, { error: 'You are not signed in for live races, or the sign-in has expired.' });
      races -= 1;
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
      send('record', { record: { sha256: 'abcdef0123456789', body: { run_id: 'live-check-1', live: true, verdict: { winner: 'A' }, contestants: { A: { results: [{ passed: true, cost_usd: 0.0021, calls: 3, input_tokens: 900, output_tokens: 40, wall_s: 6, termination: 'session_ended' }] }, B: { results: [{ passed: false, cost_usd: 0.0034, calls: 1, input_tokens: 400, output_tokens: 25, wall_s: 5, termination: 'no_action' }] } } } }, operator: {} });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'expected.json'), 'utf8'));
  for (const part of ['verdicts', 'specs', 'judged', 'judged_specs', 'flows', 'opponents']) {
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
      // The downloadable Markdown ends with the spec as JSON: it must be the same spec, in Python's formatting.
      const md = await page.evaluate(([t, a, b]) => window.ledgerDemo.specMarkdown(t, a, b), args);
      const block = /## Machine-readable\n\n```json\n([\s\S]*)\n```\n$/.exec(md);
      if (!md.startsWith('# Spec: ') || !block) {
        problems.push(`specs[${i}]: the Markdown is not in the expected shape`);
      } else {
        same(want, JSON.parse(block[1]), `specs[${i}] Markdown JSON block`);
      }
    }
    // The same answers read through fitness (ledger/policy.py): both profiles, and a reader's own rule.
    for (const [i, { overrides, verdict: want }] of expected.judged.entries()) {
      const args = [want.task, want.a, want.b, want.profile, overrides];
      const got = await page.evaluate(([t, a, b, p, o]) => window.ledgerDemo.verdict(t, a, b, p, o), args);
      same(want, got, `judged[${i}] (${want.task}: ${want.a} vs ${want.b}, ${want.profile}${overrides ? ', own rule' : ''})`);
    }
    for (const [i, { overrides, spec: want, markdown: wantText, cost: wantCost, evidence: wantEvidence }] of expected.judged_specs.entries()) {
      const args = [want.task, want.decision.a, want.decision.b, want.decision.profile, overrides];
      const got = await page.evaluate(([t, a, b, p, o]) => window.ledgerDemo.spec(t, a, b, p, o), args);
      same(want, got, `judged_specs[${i}] (${args.slice(0, 4).join(', ')})`);
      const md = await page.evaluate(
        async ([t, a, b, p, o]) => window.ledgerDemo.specMarkdownJudged(t, a, b, p, o),
        args,
      );
      const block = /## Machine-readable\n\n```json\n([\s\S]*)\n```\n$/.exec(md);
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
      if (!block) problems.push(`judged_specs[${i}]: the Markdown is not in the expected shape`);
      else same(want, JSON.parse(block[1]), `judged_specs[${i}] Markdown JSON block`);
    }
    for (const [i, want] of expected.flows.entries()) {
      const got = await page.evaluate((text) => window.ledgerDemo.flows(text), want.described);
      const where = `flows[${i}] (${JSON.stringify(want.described)})`;
      same(want.matched, got.matched, `${where}.matched`);
      same(want.searched_for, got.searched_for, `${where}.searched_for`);
      same(want.flows.map((f) => f.test), got.flows.map((f) => f.test), `${where} test ids in order`);
      same(want.flows, got.flows, `${where}.flows`);
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
        await page.evaluate(() => document.getElementById('second-list').replaceChildren());
        await page.locator(`#first-list input[value="${a}"]`).check();
        const met = await page
          .waitForFunction(() => document.querySelectorAll('#second-list input').length > 0, null, { timeout: 5000 })
          .then(() => true, () => false);
        if (!met) {
          problems.push(`flow ${f}, ${a}: no second model to pick`);
          continue;
        }
        for (const b of await values('second-list')) {
          await page.evaluate(() => document.getElementById('verdict-body').replaceChildren());
          await page.locator(`#second-list input[value="${b}"]`).check();
          const drawn = await page
            .waitForFunction(
              () => !document.getElementById('step-verdict').hidden && document.getElementById('verdict-body').innerText.trim().length > 200,
              null,
              { timeout: 5000 },
            )
            .then(() => true, () => false);
          if (!drawn) problems.push(`clicking flow ${f}, ${a} vs ${b}: no verdict was drawn`);
          // a broken page fails every pair the same way: stop early instead of waiting out each one
          if (problems.length >= 5) throw new Error(`stopped after ${problems.length} problems:\n  - ${problems.join('\n  - ')}`);
          clicked += 1;
        }
      }
    }
    if (!clicked) problems.push('no pair of models could be clicked: the click-through tested nothing');
    // The race: open a scenario of the pair on screen, skip to the end, and require both lanes to show the grade
    // and the finish line to name the same winner the square does.
    const squares = await page.locator('.rounds button.round').count();
    if (!squares) problems.push('the arena has no scenario to open');
    else {
      const square = page.locator('.rounds button.round').first();
      const label = await square.getAttribute('title');
      await square.click();
      const opened = await page.waitForSelector('#race-end', { timeout: 10000 }).then(() => true, () => false);
      if (!opened) problems.push('opening a scenario did not load its replay');
      else {
        if (!(await page.locator('.race .tick').count())) problems.push('the replay has no steps to show');
        await page.locator('#race-end').click();
        const finish = await page.locator('#race-finish').innerText();
        const outcomes = await page.locator('.race .outcome:not([hidden])').count();
        if (outcomes !== 2) problems.push(`the finished race shows ${outcomes} of 2 grades`);
        const winner = /won by (.+?) \(/.exec(label || '');
        if (winner && !finish.startsWith(winner[1])) problems.push(`the square says ${JSON.stringify(label)} but the race ends ${JSON.stringify(finish)}`);
        const hidden = await page.locator('.race .tick[hidden]').count();
        if (hidden) problems.push(`${hidden} steps are still hidden after the race ended`);
        // the graph picture under the race: one dot per scenario, and exactly the watched one ringed
        const dots = await page.locator('#race figure.graph circle').count();
        const ringed = await page.locator('#race figure.graph circle.ring').count();
        if (dots !== squares || ringed !== 1) problems.push(`the graph under the race shows ${dots} dots (${ringed} ringed) for ${squares} scenarios`);
      }
    }

    // A pair that has never met on a task can still be picked: the result says there is no verdict, shows each
    // model's own record, and names no winner. (Looked for on every workflow: the data has such pairs.)
    let unmetSeen = 0;
    for (const card of await page.locator('#flow-cards button').all()) {
      await card.click();
      await page.waitForSelector('#first-list input');
      for (const first of await page.locator('#first-list input').all()) {
        await first.check();
        await page.waitForSelector('#second-list input, #unmet-list input');
        const unmet = page.locator('#unmet-list input');
        if (!(await unmet.count())) continue;
        await unmet.first().check();
        await page.waitForFunction(() => !document.getElementById('step-verdict').hidden && /never met/.test(document.getElementById('verdict-headline')?.innerText || ''), null, { timeout: 8000 }).catch(() => problems.push('a pair that never met did not get a plain "no verdict" result'));
        if ((await page.locator('table.own tbody tr').count()) !== 2) problems.push('the no-verdict result does not show each model\'s own record');
        if (await page.locator('#verdict-band.win').count()) problems.push('a pair that never met was given a winner');
        unmetSeen += 1;
        break;
      }
      if (unmetSeen) break;
    }
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
    for (const id of ['download-spec', 'download-cost', 'download-evidence', 'download-all']) {
      if (example && !(await page.locator(`#${id}`).count())) problems.push(`the result offers no ${id} button`);
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
        await live.locator(`#second-list input[value="${pair.b}"]`).check();
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
      if (!(await live.locator('#live-jump').count())) problems.push('a signed-in visitor has no way straight to the live race from the top of the result');
      if (live.url().includes('judge-invite')) problems.push('the invite is still in the address bar after signing in');
      if (await live.locator('#live input').count()) problems.push('a signed-in visitor is still asked to type something');
      if (!(await live.locator('#live-prior').innerText()).includes('the record')) problems.push('the live panel does not state what the record expects');
      const budget = await live.locator('#live-budget').innerText();
      for (const part of ['OpenRouter $30.00 of $30.00', 'Google $0.10 of $20.00', '3 live races left', 'Gemini']) {
        if (!budget.includes(part)) problems.push(`the live budget line lacks ${JSON.stringify(part)}: ${JSON.stringify(budget)}`);
      }
      await live.locator('#live-go').click();
      await live.waitForFunction(() => document.getElementById('live-result').innerText.startsWith('Live,'), null, { timeout: 10000 }).catch(() => problems.push('the live race never reported a result'));
      const said = await live.locator('#live-result').innerText();
      const want = pair.better === pair.a ? 'in line with the record' : 'against the record';
      if (!said.includes(want)) problems.push(`the live result should read "${want}": ${JSON.stringify(said)}`);
      if (!said.includes('live-check-1')) problems.push('the live result does not name its sealed record');
      // the live race offers its own report: this scenario, both costs, its sealed record, and that it is live
      const liveText = await live.evaluate(() => window.ledgerDemo.lastLiveReport || '');
      if (!(await live.locator('#download-live').count())) problems.push('the live result offers no report to download');
      for (const part of ['# Live race report', 'live-check-1', '$0.0021', '$0.0034', 'This race cost $0.0055', 'kept apart from the recorded matches']) {
        if (!liveText.includes(part)) problems.push(`the live race report lacks ${JSON.stringify(part)}`);
      }
      const ticks = await live.locator('#live-stage .tick').count();
      if (ticks !== 6) problems.push(`the live lanes show ${ticks} of the 6 streamed steps`);
      if ((await live.locator('#live-stage .outcome:not([hidden])').count()) !== 2) problems.push('the live lanes do not both show a grade');
      if (!(await live.locator('#live-stage .tick.timeout').count())) problems.push('the timed-out step is not marked');
      if (!(await live.locator('#live-stage .tick.again').count())) problems.push('acting on the same item again is not marked');
      const off = await live.locator('#live-stage .tick').evaluateAll((marks) => marks.filter((m) => parseFloat(m.style.left) > 100).length);
      if (off) problems.push(`${off} live steps are drawn past the end of the track`);
      // the live result joined the graph as its own kind of node: drawn dashed, and counted in no verdict
      await live.waitForSelector('#live-graph circle.live', { timeout: 5000 }).catch(() => problems.push('the live result did not join the graph picture'));
      const drawn = await live.locator('#live-graph circle').count();
      if (drawn !== pair.pairs + 1) problems.push(`the graph after the live race shows ${drawn} dots, not ${pair.pairs} recorded + 1 live`);
      const after = await live.evaluate(([t, a, b]) => window.ledgerDemo.verdict(t, a, b), [pair.task, pair.a, pair.b]);
      if (after.pairs !== pair.pairs || after.wins[pair.a] !== pair.wins[pair.a]) problems.push('a live result changed the recorded verdict');
      const ask = runner.asked;
      if (!(ask.a === pair.a && ask.b === pair.b && ask.task === pair.task.split('/').pop())) problems.push(`the page asked the runner for ${JSON.stringify(ask)}`);
      if (ask.token !== 'session-1' || 'code' in ask || 'invite' in ask) problems.push(`a race must carry the session and nothing else secret: ${JSON.stringify(Object.keys(ask))}`);
      // the money and the races left are read again after a race
      await live.waitForFunction(() => document.getElementById('live-budget').innerText.includes('2 live races left'), null, { timeout: 5000 }).catch(() => problems.push('the budget line was not refreshed after the race'));
      if (!(await live.locator('#live-budget').innerText()).includes('OpenRouter $29.99 of $30.00')) problems.push('the provider budget was not refreshed after the race');

      // Any two models on the runner's list can be raced. With no record between them the page says so, both ways.
      await live.locator('#live-b').selectOption(NEWCOMER);
      await live.waitForFunction(() => document.getElementById('live-prior').innerText.includes('never met'), null, { timeout: 5000 }).catch(() => problems.push('a pair with no record is not described as one'));
      await live.locator('#live-go').click();
      await live.waitForFunction(() => document.getElementById('live-result').innerText.includes('the first these two have played'), null, { timeout: 10000 }).catch(() => problems.push('a first race between two models is not described as the first evidence'));
      if (runner.asked.b !== NEWCOMER) problems.push('the page did not race the model that was picked');
      if (!(await live.evaluate(() => window.ledgerDemo.lastLiveReport)).includes('no match between these two')) problems.push('the live report of a first race does not say there was no record');
      await live.locator('#live-a').selectOption(NEWCOMER);
      if (!(await live.locator('#live-go').isDisabled())) problems.push('the same model can be raced against itself');
      // A live result that has not been downloaded is not thrown away by a stray click: the page asks first.
      let asked = 0;
      let answer = 'dismiss';
      live.on('dialog', (dialog) => {
        asked += 1;
        return answer === 'accept' ? dialog.accept() : dialog.dismiss();
      });
      await live.locator('#flow-cards button').first().click();
      if (asked !== 1) problems.push('picking another workflow over an undownloaded live result did not ask first');
      if (!(await live.locator('#live-result').innerText()).startsWith('Live,')) problems.push('saying no to leaving still threw the live result away');
      await live.locator('#start-over').click();
      if (asked !== 2 || (await live.locator('#step-verdict').isHidden())) problems.push('Start over did not ask before dropping a live result, or dropped it anyway');
      answer = 'accept';
      await live.locator('#start-over').click();
      await live.waitForFunction(() => document.getElementById('step-verdict').hidden && document.getElementById('step-models').hidden, null, { timeout: 5000 }).catch(() => problems.push('Start over did not clear the page'));
      if (!(await live.locator('#live-banner').innerText()).includes('signed in')) problems.push('Start over signed the visitor out');
      await live.locator('#flow-cards button').first().click();
      if (asked !== 3) problems.push('the page asked again about a live result that was already let go');
      await live.close();

      // A model on screen that is not on the live list is never swapped for another one: its place stays empty,
      // the page says why, and nothing can be raced until the visitor chooses.
      const other = await context.newPage();
      await other.goto(`${origin}${BASE}?runner=${encodeURIComponent(runnerUrl)}`);
      await other.evaluate(() => window.ledgerDemo.ready());
      await other.locator('#flow-cards button', { hasText: pair.task.includes('refund') ? 'Refund' : pair.task.includes('incident') ? 'Incident' : pair.task.includes('access') ? 'Access' : 'Inventory' }).first().click();
      await other.locator(`#first-list input[value="${pair.a}"]`).check();
      await other.waitForSelector('#second-list input');
      const offList = await other.locator('#second-list input').evaluateAll((inputs, b) => inputs.map((i) => i.value).find((value) => value !== b), pair.b);
      if (!offList) problems.push('no second model off the live list was found to check');
      else {
        await other.locator(`#second-list input[value="${offList}"]`).check();
        await other.waitForSelector('#live-go', { timeout: 8000 });
        if ((await other.locator('#live-b').inputValue()) !== '') problems.push('a model that is not on the live list was swapped for another one');
        if ((await other.locator('#live-a').inputValue()) !== pair.a) problems.push('the model that is on the live list was not kept');
        if (!(await other.locator('#live-absent').isVisible())) problems.push('the page does not say that a model on screen cannot be raced live');
        if (!(await other.locator('#live-go').isDisabled())) problems.push('a race can be started before the missing model is replaced');
        await other.locator('#live-b').selectOption(pair.b);
        if (await other.locator('#live-go').isDisabled()) problems.push('choosing a model from the live list did not make the race available');
      }
      await other.close();

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
      if (await typed.locator('#live-go').count()) problems.push('a signed-out visitor is still offered a live race');
      await typed.context().close();

      // The sign-in is kept: the same browser comes back with no invite in the link and can still race.
      const back = await context.newPage();
      await back.goto(`${origin}${BASE}?runner=${encodeURIComponent(runnerUrl)}`);
      await pickPair(back);
      await back.waitForSelector('#live-go', { timeout: 5000 }).catch(() => problems.push('the sign-in was not kept for the next visit'));
      await context.close();
    } finally {
      runner.close();
    }
    return { stats, requests, clicked };
  } finally {
    await browser.close();
    server.close();
  }
}

main().then(
  ({ stats, requests, clicked }) => {
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
        `${requests} requests, all to this folder. Clicked through ${clicked} pairs of models; each drew a verdict.`,
    );
  },
  (error) => {
    console.error(`FAILED: ${error.stack || error}`);
    process.exit(1);
  },
);
