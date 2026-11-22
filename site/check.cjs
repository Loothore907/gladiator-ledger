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

async function main() {
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'expected.json'), 'utf8'));
  for (const part of ['verdicts', 'specs', 'flows', 'opponents']) {
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
    await page.close();
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
