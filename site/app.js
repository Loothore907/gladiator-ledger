// The page: starts the engine worker, exposes window.ledgerDemo, and draws the three steps.

import { createLedger, decidedText } from './ledger.js';
import { fixed, floatRepr, percent, str } from './pyformat.js';

// ---- the worker -------------------------------------------------------------------------------------------

const startedAt = performance.now();
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const waiting = new Map();
let nextId = 1;
let markReady;
let markFailed;
const graphReady = new Promise((resolve, reject) => {
  markReady = resolve;
  markFailed = reject;
});
graphReady.catch(() => {});

worker.onmessage = ({ data }) => {
  if (data.type === 'ready') return markReady({ ...data.stats, total_ms: performance.now() - startedAt });
  if (data.type === 'fatal') return markFailed(new Error(data.error));
  const call = waiting.get(data.id);
  waiting.delete(data.id);
  if (data.error) call.reject(new Error(data.error));
  else call.resolve(data.rows);
};
worker.onerror = (event) => markFailed(new Error(event.message || 'The engine worker failed to start.'));

async function ask(query, params) {
  await graphReady;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, query, params: params || {} });
  });
}

const getJson = (path) =>
  fetch(new URL(path, import.meta.url)).then((r) => {
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  });

const ledgerReady = Promise.all([getJson('./data/questions.json'), getJson('./data/rules.json')]).then(
  ([questions, rules]) => ({ rules, ledger: createLedger(ask, questions, rules) }),
);
ledgerReady.catch(() => {});

// Plain-data answers, the same as the command line gives, so they can be checked without clicking.
window.ledgerDemo = {
  ready: async () => {
    await ledgerReady;
    return graphReady;
  },
  flows: async (text) => (await ledgerReady).ledger.findFlows(text),
  opponents: async (model, openOnly) => (await ledgerReady).ledger.opponents(model, Boolean(openOnly)),
  verdict: async (task, a, b) => (await ledgerReady).ledger.verdict(task, a, b),
  spec: async (task, a, b) => (await ledgerReady).ledger.spec(task, a, b),
  specMarkdown: async (task, a, b) => {
    const { ledger } = await ledgerReady;
    return ledger.markdown(await ledger.spec(task, a, b));
  },
};

// ---- small DOM helpers --------------------------------------------------------------------------------------

function fill(node, attrs, children) {
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
const el = (tag, attrs, ...children) => fill(document.createElement(tag), attrs, children);
const svg = (tag, attrs, ...children) => fill(document.createElementNS('http://www.w3.org/2000/svg', tag), attrs, children);
const $ = (id) => document.getElementById(id);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// ---- state ----------------------------------------------------------------------------------------------------

const state = { flows: null, task: null, flow: null, models: [], a: null, b: null, partners: new Map(), openOnly: false };
const names = new Map(); // model id -> display name, as the graph has it
let ledger;
let turn = 0; // guards against a slow answer landing after a newer choice
let searchTurn = 0;

const shortName = (id) => names.get(id) || id.split(':').pop().split('/').pop();
const modelLabel = (id) => [el('span', { class: 'name' }, shortName(id)), el('span', { class: 'id' }, id)];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- step 1: flows ----------------------------------------------------------------------------------------

async function searchFlows() {
  const text = $('flow-text').value.trim();
  const mine = ++searchTurn;
  const found = await ledger.findFlows(text || null);
  if (mine !== searchTurn) return;
  state.flows = found;
  drawFlows();
}

function drawFlows() {
  const f = state.flows;
  const note = $('flow-note');
  if (f.described && f.matched) note.textContent = `Closest tested workflows (searched for: ${f.searched_for}).`;
  else if (f.described) note.textContent = `Nothing tested matches “${f.described}”. Here is every tested workflow instead.`;
  else note.textContent = 'Every tested workflow. Describe yours above to see the closest ones first.';
  const top = Math.max(...f.flows.map((x) => x.score || 0));
  $('flow-cards').replaceChildren(
    ...f.flows.map((flow) =>
      el(
        'button',
        { type: 'button', class: 'card', 'aria-pressed': String(flow.test === state.task), onclick: () => chooseFlow(flow) },
        el(
          'span',
          { class: 'card-head' },
          el('span', { class: 'card-title' }, flow.title),
          flow.score !== null && flow.score !== undefined
            ? el(
                'span',
                { class: 'strength' },
                el('span', { class: 'bar', 'aria-hidden': 'true' }, el('span', { style: `width:${Math.max(4, (100 * flow.score) / top)}%` })),
                `match ${fixed(flow.score, 2)}`,
              )
            : null,
        ),
        el('span', { class: 'card-brief' }, firstSentence(flow.brief || '')),
        el(
          'span',
          { class: 'card-meta' },
          `${plural(flow.models, 'model')} and ${plural(flow.pairs, 'judged pair')} stand behind it · version ${flow.version}`,
          flow.emulates ? ` · modelled on ${flow.emulates}` : '',
        ),
      ),
    ),
  );
}

function firstSentence(text) {
  const cut = text.indexOf('. ');
  return cut > 0 ? text.slice(0, cut + 1) : text;
}

async function chooseFlow(flow) {
  const mine = ++turn;
  Object.assign(state, { task: flow.test, flow, a: null, b: null, partners: new Map(), models: [] });
  drawFlows();
  const models = await ledger.modelsOnFlow(flow.test);
  if (mine !== turn) return;
  state.models = models;
  for (const m of models) if (m.display_name) names.set(m.model, m.display_name);
  $('step-models').hidden = false;
  $('step-verdict').hidden = true;
  $('models-intro').textContent =
    `${plural(models.length, 'model')} have judged pairs on ${flow.title} (version ${flow.version}). ` +
    'Pick the two you are choosing between.';
  drawFirst();
  $('suggest').hidden = true;
  $('second-model').hidden = true;
  $('step-models').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- step 2: models -----------------------------------------------------------------------------------------

function option(group, id, checked, disabled, sub, onpick) {
  return el(
    'label',
    { class: `option${disabled ? ' off' : ''}` },
    el('input', { type: 'radio', name: group, value: id, checked, disabled, onchange: onpick }),
    el('span', { class: 'text' }, modelLabel(id), el('span', { class: 'sub' }, sub)),
  );
}

function drawFirst() {
  $('first-list').replaceChildren(
    ...state.models.map((m) =>
      option('first', m.model, m.model === state.a, false, `${plural(m.pairs, 'judged pair')} on this flow`, () => chooseFirst(m.model)),
    ),
  );
}

async function chooseFirst(model) {
  const mine = ++turn;
  Object.assign(state, { a: model, b: null });
  $('step-verdict').hidden = true;
  const partners = await ledger.partnersOnFlow(state.task, model);
  if (mine !== turn) return;
  state.partners = new Map(partners.map((p) => [p.model, p.pairs]));
  drawSecond();
  await drawSuggestions(mine);
}

async function drawSuggestions(mine = turn) {
  const found = await ledger.opponents(state.a, state.openOnly);
  if (mine !== turn) return;
  for (const c of found.candidates) if (c.display_name) names.set(c.model, c.display_name);
  $('suggest').hidden = false;
  const body = $('suggest-body');
  if (found.note) {
    $('suggest-intro').textContent = found.note;
    body.replaceChildren();
    return;
  }
  const s = found.score;
  $('suggest-intro').textContent =
    `${shortName(state.a)} scores ${fixed(s.score, 1)} on the ${found.benchmark} (range ${fixed(s.low, 1)} to ` +
    `${fixed(s.high, 1)}). These models score closest to it${found.open_only ? ', open weights only' : ''}.`;
  if (!found.candidates.length) {
    body.replaceChildren(el('p', { class: 'note' }, 'No model with a published score fits.'));
    return;
  }
  body.replaceChildren(
    el(
      'ul',
      { class: 'cands' },
      found.candidates.map((c) => {
        const here = state.partners.get(c.model);
        const gap = `${c.gap >= 0 ? '+' : '-'}${fixed(Math.abs(c.gap), 2)}`;
        let played = 'no matches yet';
        if (c.pairs_played) played = `${plural(c.pairs_played, 'pair')} already played against it`;
        else if (c.has_matches) played = 'has matches, none against it';
        return el(
          'li',
          null,
          el(
            'div',
            { class: 'text' },
            modelLabel(c.model),
            el(
              'span',
              { class: 'sub' },
              `score ${fixed(c.score, 1)} (gap ${gap}) · ranges ${c.ranges_overlap ? 'overlap' : 'do not overlap'} · ` +
                `${c.weights || 'unknown'} weights · ${played}`,
            ),
          ),
          here
            ? el('button', { type: 'button', class: 'small quiet', onclick: () => chooseSecond(c.model) }, `Pick (${plural(here, 'pair')} on this flow)`)
            : el('span', { class: 'sub off' }, 'no match played yet on this flow'),
        );
      }),
    ),
  );
}

function drawSecond() {
  $('second-model').hidden = false;
  $('second-intro').textContent =
    `Only models that have played ${shortName(state.a)} on this flow can be picked: this page cannot run new matches.`;
  const others = state.models.filter((m) => m.model !== state.a);
  const met = others.filter((m) => state.partners.has(m.model));
  const unmet = others.filter((m) => !state.partners.has(m.model));
  $('second-list').replaceChildren(
    ...met.map((m) =>
      option(
        'second',
        m.model,
        m.model === state.b,
        false,
        `${plural(state.partners.get(m.model), 'judged pair')} against ${shortName(state.a)}`,
        () => chooseSecond(m.model),
      ),
    ),
    ...unmet.map((m) => option('second', m.model, false, true, 'no match played yet on this flow', null)),
  );
}

async function chooseSecond(model) {
  if (!state.partners.has(model)) return;
  const mine = ++turn;
  state.b = model;
  drawSecond();
  const spec = await ledger.spec(state.task, state.a, state.b);
  const scores = await ledger.scoresOf([state.a, state.b]);
  if (mine !== turn) return;
  drawVerdict(spec, scores);
  $('step-verdict').hidden = false;
  $('step-verdict').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- step 3: verdict and spec ---------------------------------------------------------------------------------

const yesNo = (ok) => el('span', { class: ok ? 'yes' : 'no' }, ok ? 'yes' : 'no');

function table(headers, rows, numeric = []) {
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'stack' },
      el('thead', null, el('tr', null, ...headers.map((t, i) => el('th', { scope: 'col', class: numeric.includes(i) ? 'n' : null }, t)))),
      el(
        'tbody',
        null,
        rows.map((cells) =>
          el(
            'tr',
            null,
            ...cells.map((cell, i) =>
              el('td', { class: i === 0 ? 'lead' : numeric.includes(i) ? 'n' : null, 'data-label': i ? headers[i] : null }, cell),
            ),
          ),
        ),
      ),
    ),
  );
}

function drawVerdict(spec, scores) {
  const d = spec.decision;
  const { a, b } = d;
  const bp = spec.blueprint;
  const st = bp.settings;
  const title = bp.title || spec.task;
  const headline = {
    better: `${shortName(d.better)} does this task better`,
    leaning: `Leaning ${shortName(d.better)}, not settled`,
    'no real difference shown': 'No real difference shown',
    'not enough evidence': 'Not enough evidence',
  }[d.verdict];
  const meaning = {
    better: `Use it for this task: it did ${title} better than ${shortName(d.better === a ? b : a)} on the same worlds.`,
    leaning: 'It is ahead, but the lead could still be chance. No winner is named.',
    'no real difference shown': 'The two models split the pairs evenly on this task. No winner is named.',
    'not enough evidence': 'There are too few head-to-head pairs to call it. No winner is named.',
  }[d.verdict];
  const kindClass = { better: 'better', leaning: 'leaning' }[d.verdict] || 'none';
  const one = (values, isFloat) => {
    const kept = (values || []).filter((v) => v !== null && v !== undefined);
    return kept.length ? kept.map((v) => str(v, isFloat)).join(', ') : 'not recorded';
  };
  const markdown = ledger.markdown(spec);

  const copyNote = el('span', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const body = [
    el(
      'div',
      { class: `verdict ${kindClass}` },
      el('p', { class: 'kind' }, d.verdict),
      el('p', { class: 'headline', id: 'verdict-headline' }, headline),
      el('p', null, meaning),
      el('p', { class: 'note' }, `A claim about ${title} as tested, in a simulated world. Not a ranking of the models in general.`),
    ),
    el(
      'ul',
      { class: 'facts' },
      el(
        'li',
        null,
        `${d.pairs} judged pairs on the same generated worlds: ${shortName(a)} won ${d.wins[a]}, ${shortName(b)} won ${d.wins[b]}, ` +
          `${d.ties} tied (sign test p = ${floatRepr(d.p_value)}).`,
      ),
      el('li', null, `Decided by: ${decidedText(d.decided_by)}.`),
    ),
    table(
      ['Model', 'Passed', 'Cost per attempt', 'Seconds per attempt', 'Mistakes per attempt', `Good enough (bar ${percent(d.bar)})`],
      [a, b].map((name) => {
        const s = spec.models[name];
        return [
          modelLabel(name),
          `${s.passed} of ${s.attempts}`,
          `$${fixed(s.cost_per_attempt, 4)}`,
          fixed(s.seconds_per_attempt, 0),
          fixed(s.mistakes, 1),
          yesNo(s.good_enough),
        ];
      }),
      [1, 2, 3, 4],
    ),
    d.notes.length ? el('ul', { class: 'notes' }, d.notes.map((n) => el('li', null, n))) : null,
    pathFigure(spec, scores),

    el('h3', null, 'Blueprint'),
    el('p', { class: 'note' }, 'What the result was earned on. Build the real flow to match it, then re-test.'),
    el('h4', null, 'The job, as tested'),
    el('blockquote', null, bp.brief),
    bp.policy ? [el('h4', null, 'The rules, as tested'), el('blockquote', null, bp.policy)] : null,
    el('h4', null, 'Tools the flow needs'),
    el('ul', { class: 'tools' }, bp.tools.map((t) => el('li', null, el('code', null, t.name), el('span', { class: 'sub' }, t.kind)))),
    el('h4', null, 'Settings the result holds for'),
    el(
      'ul',
      { class: 'plain' },
      el('li', null, 'Model: ', spec.chosen ? [shortName(spec.chosen), ' (', el('code', null, spec.chosen), ')'] : 'none chosen (see the verdict).'),
      el('li', null, `Reasoning effort: ${one(st.effort)}`),
      el('li', null, `Output limit per call: ${one(st.max_output_tokens)} tokens`),
      el('li', null, `Hard budget per attempt: $${one(st.attempt_budget_usd, true)}`),
      el('li', null, `Difficulty level: ${one(st.difficulty)}; action budget ${st.action_budget || 'not recorded'}`),
    ),
    bp.modelled_on ? el('p', { class: 'note' }, `The test is modelled on: ${bp.modelled_on}.`) : null,
    el('h4', null, 'Guardrails and autonomy'),
    el(
      'p',
      { class: 'note' },
      `Each hazard this task can raise, how ${spec.chosen ? shortName(spec.chosen) : 'each model'} handled it, and what to build where it tripped.`,
    ),
    table(
      ['Hazard', 'Model', 'Tripped', 'Autonomy', 'Build this'],
      bp.hazards.map((g) => [
        [el('span', { class: 'name' }, g.hazard), g.unforgivable ? [' ', el('span', { class: 'tag' }, 'unforgivable')] : null],
        shortName(g.model),
        `${g.tripped} of ${g.exposed}`,
        g.autonomy,
        g.guardrail || '-',
      ]),
    ),
    el(
      'p',
      { class: 'note' },
      `Unforgivable by default for a tool-using workflow: ${bp.unforgivable_defaults.join(', ')}. Change the list to fit your flow.`,
    ),

    el('h3', null, 'Evidence'),
    el(
      'ul',
      { class: 'plain evidence' },
      el('li', null, 'Test version ', el('code', null, spec.version), ', package fingerprint ', el('code', null, str(spec.test_fingerprint).slice(0, 16)), '.'),
      spec.evidence.map((e) =>
        el(
          'li',
          null,
          'Sealed match record ',
          el('code', null, e.run),
          ', seal ',
          el('code', null, str(e.seal_sha256).slice(0, 16)),
          ', engine commit ',
          el('code', null, str(e.engine_commit).slice(0, 7)),
        ),
      ),
    ),
    el(
      'p',
      { class: 'note' },
      'This spec claims only what was measured: this task, in a simulated world, under these settings. Treat it as the ' +
        'starting point for the real flow, and test again once it is built.',
    ),
    el(
      'div',
      { class: 'actions' },
      el('button', { type: 'button', id: 'download-spec', onclick: () => download(markdown) }, 'Download spec.md'),
      el('button', { type: 'button', id: 'copy-spec', class: 'quiet', onclick: () => copy(markdown, copyNote) }, 'Copy'),
      copyNote,
    ),
    el('p', { class: 'note' }, 'The download is the same Markdown the ledger command line writes, with a machine-readable copy at the end.'),
  ];
  $('verdict-body').replaceChildren(...body.flat(Infinity).filter(Boolean));
}

function download(markdown) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = el('a', { href: url, download: 'spec.md' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copy(text, note) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const area = el('textarea', { style: 'position:fixed;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
  }
  note.textContent = ok ? 'Copied.' : 'Could not copy here. Use the download instead.';
}

// The walk through the graph that produced the answer, with this selection's real counts.
function pathFigure(spec, scores) {
  const d = spec.decision;
  const { a, b } = d;
  const bp = spec.blueprint;
  const scoreOf = new Map(scores.map((s) => [s.model, s]));
  const hasScore = scores.length > 0;
  const height = hasScore ? 382 : 304;
  const H = 52;
  const parts = [];
  const box = (x, y, w, kind, main, sub, cls = '') => {
    const max = Math.floor((w - 20) / 6.6);
    parts.push(
      svg('rect', { x, y, width: w, height: H, rx: 8, class: `g-box ${cls}` }),
      svg('text', { x: x + 10, y: y + 16, class: 'g-kind' }, kind),
      svg('text', { x: x + 10, y: y + 32, class: 'g-main' }, clip(main, max), svg('title', null, main)),
      svg('text', { x: x + 10, y: y + 46, class: 'g-sub' }, clip(sub, Math.floor((w - 20) / 5.6))),
    );
  };
  const arrow = (x1, y1, x2, y2, rel, dashed = false, labelAt = null) => {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const tip = (da, len) => `${x2 - len * Math.cos(angle + da)},${y2 - len * Math.sin(angle + da)}`;
    parts.push(
      svg('line', { x1, y1, x2: x2 - 4 * Math.cos(angle), y2: y2 - 4 * Math.sin(angle), class: `g-edge${dashed ? ' g-dash' : ''}` }),
      svg('polygon', { points: `${x2},${y2} ${tip(0.4, 8)} ${tip(-0.4, 8)}`, class: 'g-arrow' }),
    );
    if (rel) {
      const [lx, ly, anchor] = labelAt || [(x1 + x2) / 2 + 7, (y1 + y2) / 2 + 3, 'start'];
      parts.push(svg('text', { x: lx, y: ly, class: 'g-rel', 'text-anchor': anchor }, rel));
    }
  };
  const mainX = 10;
  const mainW = 215;
  const mid = mainX + mainW / 2;
  const srcX = 250;
  const srcW = 100;
  const rows = [8, 86, 164, 242, 320];
  const records = spec.evidence.length;

  box(mainX, rows[0], mainW, 'Flow', bp.title || spec.task, spec.task);
  arrow(mid, rows[0] + H, mid, rows[1], 'VERSION_OF');
  box(mainX, rows[1], mainW, 'Test version', spec.version.split('@').pop().split(':')[0], `fingerprint ${str(spec.test_fingerprint).slice(0, 12)}`);
  arrow(mid, rows[1] + H, mid, rows[2], 'USED');
  box(mainX, rows[2], mainW, 'Judged pairs', `${plural(d.pairs, 'pair')} on the same worlds`, `${d.wins[a]} to ${d.wins[b]}, ${d.ties} tied`, 'hot');
  arrow(mainX + mainW, rows[2] + H / 2, srcX, rows[2] + H / 2, 'FROM', true, [(mainX + mainW + srcX) / 2, rows[2] + H / 2 - 7, 'middle']);
  box(srcX, rows[2], srcW, 'Source', 'gladiator', plural(records, 'record'), 'src');

  const modelW = 165;
  const ax = 10;
  const bx = 185;
  arrow(mid - 30, rows[2] + H, ax + modelW / 2, rows[3], 'IN, BY', false, [ax + modelW / 2 - 8, rows[3] - 10, 'end']);
  arrow(mid + 30, rows[2] + H, bx + modelW / 2, rows[3], 'IN, BY', false, [bx + modelW / 2 + 2, rows[3] - 10, 'start']);
  const won = (m) => `won ${d.wins[m]} · passed ${spec.models[m].passed} of ${spec.models[m].attempts}`;
  box(ax, rows[3], modelW, 'Model', shortName(a), won(a), d.better === a ? 'hot' : '');
  box(bx, rows[3], modelW, 'Model', shortName(b), won(b), d.better === b ? 'hot' : '');

  if (hasScore) {
    const show = (m) => (scoreOf.has(m) ? fixed(scoreOf.get(m).score, 1) : 'none');
    if (scoreOf.has(a)) arrow(ax + modelW / 2, rows[3] + H, mid - 30, rows[4], 'SCORED', false, [ax + modelW / 2 - 8, rows[4] - 10, 'end']);
    if (scoreOf.has(b)) arrow(bx + modelW / 2, rows[3] + H, mid + 30, rows[4], 'SCORED', false, [bx + modelW / 2 + 2, rows[4] - 10, 'start']);
    box(mainX, rows[4], mainW, 'Benchmark', scores[0].benchmark, `scores: ${show(a)} and ${show(b)}`);
    arrow(mainX + mainW, rows[4] + H / 2, srcX, rows[4] + H / 2, 'FROM', true, [(mainX + mainW + srcX) / 2, rows[4] + H / 2 - 7, 'middle']);
    box(srcX, rows[4], srcW, 'Source', scores[0].source, 'CC BY 4.0', 'src');
  }

  const label =
    `The graph path behind this answer: the flow ${bp.title}, its test version, ${d.pairs} judged pairs from ` +
    `${plural(records, 'sealed match record')}, and the two models` +
    (hasScore ? ', with their published benchmark scores.' : '.');
  return el(
    'figure',
    { class: 'path' },
    svg('svg', { viewBox: `0 0 360 ${height}`, role: 'img', 'aria-label': label }, parts),
    el('figcaption', null, 'The answer is a walk through connected facts in the graph. The benchmark only suggests opponents; it never decides.'),
  );
}

// ---- start --------------------------------------------------------------------------------------------------

async function start() {
  const status = $('status');
  try {
    ({ ledger } = await ledgerReady);
    const stats = await graphReady;
    status.textContent =
      `Ready: ${stats.matches} matches (${stats.pairs} judged pairs), ${stats.models} models, built in ${Math.round(stats.total_ms)} ms.`;
  } catch (error) {
    status.textContent = `The graph could not be built in this browser: ${error.message}`;
    status.classList.add('error');
    return;
  }
  $('flow-text').disabled = false;
  $('flow-go').disabled = false;
  let timer = 0;
  $('flow-text').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(searchFlows, 250);
  });
  $('flow-form').addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(timer);
    searchFlows();
  });
  $('open-only').addEventListener('change', (event) => {
    state.openOnly = event.target.checked;
    if (state.a) drawSuggestions();
  });
  await searchFlows();
}

start();
