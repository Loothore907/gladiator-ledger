// The page: starts the engine worker, exposes window.ledgerDemo, and draws the three steps.

import { costMarkdown, createLedger, evidenceMarkdown } from './ledger.js';
import { fixed, percent, str } from './pyformat.js';

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
  verdict: async (task, a, b, profile = null, overrides = null) => {
    const { ledger, rules } = await ledgerReady;
    return ledger.verdict(task, a, b, null, rules.good_enough, rules.min_pairs, profile, overrides);
  },
  spec: async (task, a, b, profile = null, overrides = null) => (await ledgerReady).ledger.spec(task, a, b, profile, overrides),
  specMarkdownJudged: async (task, a, b, profile, overrides = null) => {
    const { ledger } = await ledgerReady;
    return ledger.markdown(await ledger.spec(task, a, b, profile, overrides));
  },
  // the cost breakdown and the evidence report for one judged pair, as the command line writes them
  reports: async (task, a, b, profile, overrides = null) => {
    const { ledger, rules } = await ledgerReady;
    const v = await ledger.verdict(task, a, b, null, rules.good_enough, rules.min_pairs, profile, overrides);
    const built = await ledger.build({ ...v, suite: null });
    const title = (built.blueprint || {}).title || built.task;
    return { cost: costMarkdown(v, title), evidence: evidenceMarkdown(v, title) };
  },
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

// ---- state ----------------------------------------------------------------------------------------------------

const state = {
  flows: null,
  task: null,
  flow: null,
  models: [],
  a: null,
  b: null,
  partners: new Map(),
  scores: new Map(),
  openOnly: false,
  profile: null, // whose tolerance decides "fit for the task" (set from the rules once loaded)
  overrides: {}, // the visitor's own level for a fault, by fault name; kept per task
  flowFaults: new Map(), // test id -> the faults its grader can report
};
const names = new Map(); // model id -> display name, as the graph has it
let ledger;
let rules;
let turn = 0; // guards against a slow answer landing after a newer choice
let searchTurn = 0;

// id is null when no winner is named: the caller's sentence then does not use the name
const shortName = (id) => (id ? names.get(id) || id.split(':').pop().split('/').pop() : '');
const modelLabel = (id) => [el('span', { class: 'name' }, shortName(id)), el('span', { class: 'id' }, id)];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- step 1: flows ----------------------------------------------------------------------------------------

// Step 1 is a choice among the workflows Ledger has matches for, and it says so. A description only puts the
// closest ones first (a keyword match on each workflow's text): it never hides one, and it cannot test a new flow.
async function searchFlows() {
  const text = $('flow-text').value.trim();
  const mine = ++searchTurn;
  const [found, every, faults] = await Promise.all([ledger.findFlows(text || null), ledger.findFlows(null), ledger.flowFaults()]);
  if (mine !== searchTurn) return;
  const ranked = found.matched ? found.flows : [];
  const rest = every.flows.filter((f) => !ranked.some((r) => r.test === f.test)).map((f) => ({ ...f, score: null }));
  state.flows = { ...found, flows: [...ranked, ...rest], total: every.flows.length };
  state.flowFaults = new Map(faults.map((f) => [f.test, f.faults]));
  drawFlows();
}

function drawFlows() {
  const f = state.flows;
  $('flow-intro').textContent =
    `Ledger has matches for ${plural(f.total, 'workflow')}. Pick the one closest to what your agent has to do. ` +
    'If none is close, the answers here do not apply to your flow: it would need its own test.';
  const note = $('flow-note');
  // a workflow that shares only a stray word with the description is a weak match, and is shown as one
  const top = Math.max(...f.flows.map((x) => x.score || 0));
  const strong = (x) => x.score !== null && x.score >= 0.25 * top;
  const matched = f.flows.filter(strong).length;
  if (!f.described) note.textContent = '';
  else if (matched) {
    note.textContent =
      `${matched} of ${f.total} ${matched === 1 ? 'matches' : 'match'} the words in your description (${f.searched_for}), closest first. ` +
      'This is a keyword match on what each workflow asks for, not a judgement that yours is the same.';
  } else {
    note.textContent =
      `None of the ${f.total} shares a word with “${f.described}”. Your flow is probably not tested here; ` +
      'the cards below show what is.';
  }
  const order = ['wrong amount', 'duplicate effect', 'planted instruction'];
  $('flow-cards').replaceChildren(
    ...f.flows.map((flow) => {
      const catches = [...(state.flowFaults.get(flow.test) || [])].sort(
        (x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99) || (x < y ? -1 : 1),
      );
      return el(
        'button',
        {
          type: 'button',
          class: `card${f.described && matched && !strong(flow) ? ' far' : ''}`,
          'aria-pressed': String(flow.test === state.task),
          onclick: () => chooseFlow(flow),
        },
        el(
          'span',
          { class: 'card-head' },
          el('span', { class: 'card-title' }, flow.title),
          strong(flow)
            ? el(
                'span',
                { class: 'strength' },
                el('span', { class: 'bar', 'aria-hidden': 'true' }, el('span', { style: `width:${Math.max(4, (100 * flow.score) / top)}%` })),
                `match ${fixed(flow.score, 2)}`,
              )
            : f.described && matched
              ? el('span', { class: 'strength' }, flow.score === null ? 'no words in common' : 'weak match')
              : null,
        ),
        el('span', { class: 'card-brief' }, firstSentence(flow.brief || '')),
        catches.length
          ? el('span', { class: 'card-meta' }, `Catches: ${plural(catches.length, 'kind')} of fault, such as ${catches.slice(0, 3).join(', ')}`)
          : null,
        el(
          'span',
          { class: 'card-meta' },
          `${plural(flow.models, 'model')} and ${plural(flow.pairs, 'judged pair')} stand behind it · version ${flow.version}`,
          flow.emulates ? ` · modelled on ${flow.emulates}` : '',
        ),
      );
    }),
  );
}

function firstSentence(text) {
  const cut = text.indexOf('. ');
  return cut > 0 ? text.slice(0, cut + 1) : text;
}

async function chooseFlow(flow) {
  const mine = ++turn;
  Object.assign(state, { task: flow.test, flow, a: null, b: null, partners: new Map(), models: [], overrides: {} });
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
  $('second-model').hidden = true;
  $('step-models').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- step 2: models -----------------------------------------------------------------------------------------

function option(group, id, checked, disabled, sub, onpick, compact = false) {
  // compact: the name and one fact on a card; the full model id is the card's tooltip
  const text = compact
    ? el('span', { class: 'text' }, el('span', { class: 'name' }, shortName(id)), el('span', { class: 'sub' }, sub))
    : el('span', { class: 'text' }, modelLabel(id), el('span', { class: 'sub' }, sub));
  return el(
    'label',
    { class: `option${disabled ? ' off' : ''}${compact ? ' compact' : ''}`, title: compact ? id : null },
    el('input', { type: 'radio', name: group, value: id, checked, disabled, onchange: onpick }),
    text,
  );
}

// First model: every model with judged pairs on this flow, most evidence first, as compact cards.
function drawFirst() {
  const models = [...state.models].sort((x, y) => y.pairs - x.pairs || (x.model < y.model ? -1 : 1));
  $('first-list').className = 'options compact';
  $('first-list').replaceChildren(
    ...models.map((m) =>
      option('first', m.model, m.model === state.a, false, plural(m.pairs, 'judged pair'), () => chooseFirst(m.model), true),
    ),
  );
}

async function chooseFirst(model) {
  const mine = ++turn;
  Object.assign(state, { a: model, b: null });
  $('step-verdict').hidden = true;
  const partners = await ledger.partnersOnFlow(state.task, model);
  const scores = await ledger.scoresOf([model, ...partners.map((p) => p.model)]);
  if (mine !== turn) return;
  state.partners = new Map(partners.map((p) => [p.model, p.pairs]));
  state.scores = new Map(scores.map((s) => [s.model, s]));
  drawSecond();
  await drawSuggestions(mine);
}

// How close a model that has played the first one is to it on paper, in words; null gap when either has no score.
function onPaper(model) {
  const mine = state.scores.get(state.a);
  const theirs = state.scores.get(model);
  if (!mine || !theirs) return { gap: null, text: 'no published score to compare' };
  const gap = Math.abs(theirs.score - mine.score);
  const overlap = theirs.low <= mine.high && mine.low <= theirs.high;
  return { gap, text: `${fixed(gap, 1)} points apart on paper, ranges ${overlap ? 'overlap' : 'do not overlap'}` };
}

// Second model: the opponents this page can answer for (they have played the first model on this flow), the ones
// with the most head-to-head evidence first. Published scores only break ties and say how fair the match is.
function drawSecond() {
  $('second-model').hidden = false;
  const mine = state.scores.get(state.a);
  const met = state.models
    .filter((m) => m.model !== state.a && state.partners.has(m.model))
    .map((m) => ({ ...m, paper: onPaper(m.model) }))
    .map((m) => ({ ...m, met: state.partners.get(m.model) }))
    .sort((x, y) => y.met - x.met || (x.paper.gap ?? Infinity) - (y.paper.gap ?? Infinity) || (x.model < y.model ? -1 : 1));
  const enough = met.filter((m) => m.met >= rules.min_pairs).length;
  $('second-intro').textContent =
    `${plural(met.length, 'model')} ${met.length === 1 ? 'has' : 'have'} played ${shortName(state.a)} on this flow` +
    ', listed with the most head-to-head evidence first. ' +
    (enough
      ? `${enough} of them ${enough === 1 ? 'has' : 'have'} the ${rules.min_pairs} judged pairs a verdict needs. `
      : `None has the ${rules.min_pairs} judged pairs a verdict needs yet, so no winner will be named. `) +
    (mine ? `${shortName(state.a)} scores ${fixed(mine.score, 1)} on the Epoch Capabilities Index; a close score only makes the match fair.` : '');
  $('second-list').className = 'options';
  $('second-list').replaceChildren(
    ...met.map((m) =>
      option(
        'second',
        m.model,
        m.model === state.b,
        false,
        `${plural(m.met, 'judged pair')} against ${shortName(state.a)}: ` +
          `${m.met >= rules.min_pairs ? 'enough for a verdict' : 'too few for a verdict yet'} · ${m.paper.text}`,
        () => chooseSecond(m.model),
      ),
    ),
  );
}

// Worth testing next: models close on paper that have NOT played the first one on this flow. The page cannot run
// new matches, so these are shown as candidates, folded away under the list of opponents it can answer for.
async function drawSuggestions(mine = turn) {
  const found = await ledger.opponents(state.a, state.openOnly);
  if (mine !== turn) return;
  for (const c of found.candidates) if (c.display_name) names.set(c.model, c.display_name);
  const body = $('suggest-body');
  $('suggest').hidden = false;
  if (found.note) {
    $('suggest-summary').textContent = 'Close on paper, not matched on this flow yet';
    $('suggest-intro').textContent = found.note;
    body.replaceChildren();
    return;
  }
  const untested = found.candidates.filter((c) => !state.partners.has(c.model));
  $('suggest-summary').textContent = `Worth testing next: ${plural(untested.length, 'model')} close on paper with no match against ${shortName(state.a)} on this flow`;
  $('suggest-intro').textContent =
    `These score closest to ${shortName(state.a)}${found.open_only ? ' among open-weights models' : ''} but have not ` +
    'played it on this flow, so there is no verdict to show. This page cannot run new matches.';
  if (!untested.length) {
    body.replaceChildren(el('p', { class: 'note' }, 'Every close model has already played it on this flow: see the list above.'));
    return;
  }
  body.replaceChildren(
    el(
      'ul',
      { class: 'cands' },
      untested.map((c) => {
        const gap = `${c.gap >= 0 ? '+' : '-'}${fixed(Math.abs(c.gap), 2)}`;
        let known = 'no matches in Ledger yet';
        if (c.pairs_played) known = `${plural(c.pairs_played, 'pair')} against it on other flows`;
        else if (c.has_matches) known = 'has matches, none against it';
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
                `${c.weights || 'unknown'} weights · ${known}`,
            ),
          ),
        );
      }),
    ),
  );
}

async function chooseSecond(model) {
  if (!state.partners.has(model)) return;
  state.b = model;
  drawSecond();
  await showVerdict(true);
}

// The verdict for the chosen task and pair, read through the visitor's tolerance and their own rules.
async function showVerdict(scroll = false) {
  const mine = ++turn;
  const overrides = Object.keys(state.overrides).length ? state.overrides : null;
  const judged = await ledger.verdict(state.task, state.a, state.b, null, rules.good_enough, rules.min_pairs, state.profile, overrides);
  const spec = await ledger.build({ ...judged, suite: null });
  if (mine !== turn) return;
  drawVerdict(spec, judged);
  drawLive(judged);
  $('step-verdict').hidden = false;
  if (scroll) $('step-verdict').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- step 3: verdict and spec ---------------------------------------------------------------------------------


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

// Model ids inside a sentence from the ledger, swapped for the names people know.
function plainNames(text, ids) {
  return ids.reduce((out, id) => out.split(id).join(shortName(id)), text);
}

const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const PROFILE_HELP = {
  personal: 'One person runs it and sees the results.',
  enterprise: 'A business runs it unattended, at volume.',
};
const LEVEL_HELP = {
  unforgivable: 'one attempt with it makes a model unfit',
  serious: 'fine if rare; unfit above the share allowed',
  minor: 'shown, never decides on its own',
};

// One row of the comparison: the first model's value, what is compared, the second model's value.
function tapeRow(left, label, small, right, extra = null) {
  return el(
    'div',
    { class: 'tape-row' },
    el('div', { class: 'val l' }, left),
    el('div', { class: 'lab' }, label, small ? el('small', null, small) : null, extra),
    el('div', { class: 'val r' }, right),
  );
}

// ---- the race: one recorded scenario, replayed step by step ---------------------------------------------------

const replays = new Map(); // run id -> its replay file, fetched once
let raceTimer = 0;
const SPEEDS = [
  ['8', '8× speed'],
  ['2', '2× speed'],
  ['1', 'true speed'],
];
const stepWords = (tool, item) => `${tool ? tool.replaceAll('_', ' ') : 'answered without acting'}${item ? ` ${item}` : ''}`;
const STATE_WORDS = ['', ': timed out, outcome unknown', ': refused'];

async function replayOf(run) {
  if (!replays.has(run)) {
    const response = await fetch(new URL(`./data/replays/${run}.json`, import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    replays.set(run, await response.json());
  }
  return replays.get(run);
}

// One lane of the race: the track with a mark per step, what the model is doing now, and four running gauges
// (the parts of the efficiency score). Returns how to draw it at a given second.
function raceLane(id, cls, line, tools, span) {
  const track = el('div', { class: 'track' });
  const marks = line.steps.map(([at, tool, item, kind, state, mark]) => {
    const what = mark === 'wrong' ? 'wrong' : state === 1 ? 'timeout' : state === 2 ? 'refused' : mark === 'repeat' ? 'again' : kind;
    const said = `${fixed(at, 1)}s: ${stepWords(tools[tool], item)}${STATE_WORDS[state]}${mark === 'wrong' ? ': the wrong decision' : mark === 'repeat' ? ' (again)' : ''}`;
    return track.appendChild(el('span', { class: `tick ${what}`, style: `left:${(100 * at) / span}%`, title: said, hidden: true }));
  });
  const now = el('p', { class: 'now' }, 'Waiting to start.');
  const gauge = (label) => {
    const value = el('b', null, '0');
    return [el('span', { class: 'gauge' }, value, ` ${label}`), value];
  };
  const [gSteps, vSteps] = gauge('steps');
  const [gTime, vTime] = gauge('seconds');
  const [gCost, vCost] = gauge('spent');
  const [gTokens, vTokens] = gauge('tokens');
  const result = el('p', { class: 'outcome', hidden: true });
  const faults = Object.entries(line.faults);
  result.append(
    el('strong', { class: line.passed ? 'pass' : 'fail' }, line.passed ? 'Passed' : 'Did not pass'),
    line.items ? ` · ${line.correct} of ${line.items} items right` : '',
    faults.length ? ` · ${faults.map(([name, n]) => `${name}${n > 1 ? ` ×${n}` : ''}`).join(', ')}` : ' · no faults',
  );
  const node = el(
    'div',
    { class: `lane ${cls}` },
    el('div', { class: 'lane-head' }, el('span', { class: 'name' }, shortName(id)), el('span', { class: 'gauges' }, gSteps, gTime, gCost, gTokens)),
    track,
    now,
    result,
  );
  let shown = 0;
  const draw = (clock) => {
    while (shown < line.steps.length && line.steps[shown][0] <= clock) {
      marks[shown].hidden = false;
      shown += 1;
    }
    if (clock < (line.steps[0] || [0])[0]) for (let i = 0; i < shown; i += 1) marks[i].hidden = true;
    const done = clock >= line.seconds;
    const seen = line.steps.slice(0, shown);
    vSteps.textContent = String(shown);
    vTime.textContent = fixed(Math.min(clock, line.seconds), 0);
    vCost.textContent = `$${fixed(done ? line.cost_usd : seen.reduce((sum, x) => sum + x[6], 0), 4)}`;
    vTokens.textContent = seen.reduce((sum, x) => sum + x[7], 0).toLocaleString('en-US');
    const last = seen.at(-1);
    now.textContent = done ? 'Finished.' : last ? `${stepWords(tools[last[1]], last[2])}${STATE_WORDS[last[4]]}` : 'Waiting to start.';
    result.hidden = !done;
    return done;
  };
  const reset = () => {
    shown = 0;
    for (const m of marks) m.hidden = true;
  };
  return { node, draw, reset };
}

// Replays scenario `index` of this verdict's pairs: both models on the same world, at the pace they really ran.
async function openRace(v, index) {
  cancelAnimationFrame(raceTimer);
  const box = $('race');
  const round = v.rounds[index];
  box.hidden = false;
  box.replaceChildren(el('p', { class: 'note center' }, 'Loading the recorded match…'));
  let file;
  try {
    file = await replayOf(round.run);
  } catch (error) {
    box.replaceChildren(el('p', { class: 'note center' }, `This scenario's replay could not be loaded (${error.message}).`));
    return;
  }
  const match = file.matches[round.match];
  const { a, b } = v;
  const span = Math.max(match[a].seconds, match[b].seconds, 1);
  const lanes = [raceLane(a, 'a', match[a], file.tools, span), raceLane(b, 'b', match[b], file.tools, span)];
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let speed = Number(SPEEDS[0][0]);
  let clock = 0;
  let playing = false;
  let before = 0;
  const how = { both: 'both passed, and its run was cheaper and faster', sole: 'it was the only one to pass', neither: round.rule === 'progress' ? 'neither passed, and it got further' : 'neither passed, and its run cost less' }[
    round.a_passed && round.b_passed ? 'both' : round.a_passed || round.b_passed ? 'sole' : 'neither'
  ];
  const finish = el('p', { class: 'finish', id: 'race-finish', hidden: true }, round.winner === 'tie' ? 'This scenario was a tie.' : `${shortName(round.winner)} took this scenario: ${how}.`);
  const play = el('button', { type: 'button', id: 'race-play' }, 'Play');
  const paint = () => {
    const done = lanes.map((lane) => lane.draw(clock)).every(Boolean);
    finish.hidden = !done;
    if (done) playing = false;
    play.textContent = playing ? 'Pause' : done ? 'Play again' : 'Play';
    return done;
  };
  const tick = (time) => {
    if (!playing) return;
    clock += ((time - before) / 1000) * speed;
    before = time;
    if (!paint()) raceTimer = requestAnimationFrame(tick);
  };
  const start = () => {
    if (clock >= span) {
      clock = 0;
      for (const lane of lanes) lane.reset();
    }
    playing = true;
    before = performance.now();
    raceTimer = requestAnimationFrame(tick);
    paint();
  };
  play.addEventListener('click', () => {
    if (playing) {
      playing = false;
      cancelAnimationFrame(raceTimer);
      paint();
    } else start();
  });
  const end = el('button', { type: 'button', class: 'quiet', id: 'race-end', onclick: () => { playing = false; cancelAnimationFrame(raceTimer); clock = span; paint(); } }, 'Skip to the end');
  const pace = el(
    'select',
    { id: 'race-speed', 'aria-label': 'Replay speed', onchange: (event) => { speed = Number(event.target.value); } },
    SPEEDS.map(([value, label]) => el('option', { value }, label)),
  );
  box.replaceChildren(
    el('h4', null, `Scenario ${index + 1}: replay of a recorded match`),
    el(
      'p',
      { class: 'note' },
      `Both models got the same generated world. Each mark is one step, placed when it really happened (${fixed(span, 0)} seconds for the slower one). `,
      'Nothing here is re-run: it is the sealed record ', el('code', null, round.run), ', played back.',
    ),
    el('div', { class: 'race-controls' }, play, end, pace),
    ...lanes.map((lane) => lane.node),
    el(
      'p',
      { class: 'legend left' },
      el('span', { class: 'tick read' }), 'looks something up',
      el('span', { class: 'tick act' }), 'acts',
      el('span', { class: 'tick check' }), 'checks an outcome',
      el('span', { class: 'tick timeout' }), 'the world timed out',
      el('span', { class: 'tick again' }), 'acts on the same item again',
      el('span', { class: 'tick wrong' }), 'a wrong decision',
    ),
    finish,
    await evidenceGraph(v, index),
  );
  if (still) {
    clock = span;
    paint();
  } else start();
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---- the graph behind a verdict, as a picture -------------------------------------------------------------------

// Live results join the graph in this browser as their own kind of node, linked to the same test version and
// models as the recorded matches, so they can be drawn beside them without ever being counted in a verdict.
const ADD_LIVE = `MERGE (l:LiveMatch {run_id: $run})
SET l.winner = $winner, l.seal = $seal, l.at = $at
WITH l
MATCH (tv:TestVersion {key: $version}), (a:Model {name: $a}), (b:Model {name: $b})
MERGE (l)-[:RAN_ON]->(tv)
MERGE (l)-[:PLAYED_BY]->(a)
MERGE (l)-[:PLAYED_BY]->(b)`;
const LIVE_BETWEEN = `MATCH (l:LiveMatch)-[:RAN_ON]->(:TestVersion {key: $version}),
      (l)-[:PLAYED_BY]->(:Model {name: $a}), (l)-[:PLAYED_BY]->(:Model {name: $b})
RETURN l.run_id AS run, l.winner AS winner ORDER BY l.at`;

// The neighbourhood of the graph a verdict is read from: the test version, the two models, and one dot per
// scenario both played (a Match), each linked to all three. `ring` marks the scenario just watched; live results
// (asked from the graph) are drawn dashed, off to the side.
async function evidenceGraph(v, ring = null) {
  const live = await ask(LIVE_BETWEEN, { version: v.version, a: v.a, b: v.b });
  const W = 720;
  const H = 230;
  const n = v.rounds.length;
  const gap = Math.min(30, 430 / Math.max(n, 1));
  const first = W / 2 - 60 - ((n - 1) * gap) / 2;
  const dots = v.rounds.map((round, i) => ({ x: first + i * gap, y: 118, who: round.winner === v.a ? 'a' : round.winner === v.b ? 'b' : 'tie', ring: i === ring, label: `Scenario ${i + 1}` }));
  const liveDots = live.map((l, i) => ({ x: W - 110 + i * 26, y: 118, who: l.winner === v.a ? 'a' : l.winner === v.b ? 'b' : 'tie', live: true, label: `Live race ${l.run}` }));
  const top = { x: W / 2, y: 30 };
  const left = { x: 150, y: 200 };
  const right = { x: W - 150, y: 200 };
  const line = (from, to, cls) => svg('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: cls });
  const node = (at, text, cls) => [
    svg('rect', { x: at.x - 105, y: at.y - 16, width: 210, height: 32, rx: 8, class: `gnode ${cls}` }),
    svg('text', { x: at.x, y: at.y + 5, 'text-anchor': 'middle', class: 'glabel' }, text),
  ];
  const figure = el(
    'figure',
    { class: 'graph' },
    svg(
      'svg',
      { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `The graph behind this verdict: ${n} recorded scenarios${live.length ? ` and ${live.length} live` : ''} linking the test version to both models.` },
      [...dots, ...liveDots].flatMap((d) => [top, left, right].map((to) => line(d, to, `glink${d.ring ? ' ring' : ''}${d.live ? ' live' : ''}`))),
      node(top, v.version.split('/').pop().split(':')[0], 'task'),
      node(left, shortName(v.a), 'a'),
      node(right, shortName(v.b), 'b'),
      [...dots, ...liveDots].map((d) => svg('circle', { cx: d.x, cy: d.y, r: d.ring || d.live ? 9 : 6, class: `gdot ${d.who}${d.ring ? ' ring' : ''}${d.live ? ' live' : ''}` }, svg('title', null, d.label))),
    ),
    el(
      'figcaption',
      null,
      `The graph this verdict is read from. Each dot is one scenario both models played, linked to the test version it used and to each model, and coloured by who won it.`,
      ring !== null ? ' The ringed one is the race you just watched.' : '',
      live.length ? ` The dashed ${live.length === 1 ? 'one is the live race' : 'ones are live races'}: now in the graph and linked the same way, but as a different kind of node, so no verdict counts ${live.length === 1 ? 'it' : 'them'}.` : '',
    ),
  );
  return figure;
}

// ---- a live race: one fresh scenario, played now by a Gladiator runner -------------------------------------------

// Where a runner is, if there is one: ?runner=<address> for a runner on your own machine, else the address the
// page was published with (site/data/live.json). No runner means no live races, and the page says so.
let runnerPromise;
function findRunner() {
  runnerPromise ||= (async () => {
    const asked = new URLSearchParams(location.search).get('runner');
    let base = asked;
    if (!base) {
      const response = await fetch(new URL('./data/live.json', import.meta.url));
      base = response.ok ? (await response.json()).runner : null;
    }
    if (!base) return null;
    // The published runner is only contacted for a visitor who holds an invitation or is already signed in.
    // Everyone else's page stays inside its own folder: nothing is sent anywhere, and the runner is not woken.
    if (!asked && !new URLSearchParams(location.search).get('invite') && !stored.get()) return null;
    base = base.replace(/\/$/, '');
    try {
      const options = await (await fetch(`${base}/options`)).json();
      return { base, options };
    } catch {
      return { base, options: null };
    }
  })();
  return runnerPromise;
}

const liveKind = (tool) => (!tool ? 'talk' : tool === 'finish' ? 'end' : tool.startsWith('check_') ? 'check' : rules.reads.some((p) => tool.startsWith(p)) || tool.startsWith('stock_for_') ? 'read' : 'act');
function liveItem(args) {
  if (!args || typeof args !== 'object') return null;
  for (const [key, value] of Object.entries(args)) if (key.endsWith('id') || key === 'sku' || key === 'page') return key === 'page' ? `page ${value}` : String(value);
  return null;
}

// A lane that grows as steps arrive. The time scale stretches when a model runs longer than the track shows.
function liveLane(id, cls) {
  const track = el('div', { class: 'track' });
  const now = el('p', { class: 'now' }, 'Waiting for its first step…');
  const count = { steps: el('b', null, '0'), time: el('b', null, '0'), cost: el('b', null, '$0.0000'), tokens: el('b', null, '0') };
  const result = el('p', { class: 'outcome', hidden: true });
  const node = el(
    'div',
    { class: `lane ${cls}` },
    el(
      'div',
      { class: 'lane-head' },
      el('span', { class: 'name' }, shortName(id)),
      el('span', { class: 'gauges' }, el('span', { class: 'gauge' }, count.steps, ' steps'), el('span', { class: 'gauge' }, count.time, ' seconds'), el('span', { class: 'gauge' }, count.cost, ' spent'), el('span', { class: 'gauge' }, count.tokens, ' tokens')),
    ),
    track,
    now,
    result,
  );
  const marks = [];
  const acted = new Set();
  let span = 30;
  let cost = 0;
  let tokens = 0;
  const place = () => {
    for (const [mark, at] of marks) mark.style.left = `${(100 * at) / span}%`;
  };
  return {
    node,
    step(e) {
      const kind = liveKind(e.tool_name);
      const item = liveItem(e.tool_args);
      const again = kind === 'act' && item && acted.has(item);
      if (kind === 'act' && item) acted.add(item);
      const what = e.error === 'timeout' ? 'timeout' : e.error ? 'refused' : again ? 'again' : kind;
      const said = `${stepWords(e.tool_name, item)}${e.error === 'timeout' ? STATE_WORDS[1] : e.error ? STATE_WORDS[2] : ''}`;
      const mark = track.appendChild(el('span', { class: `tick ${what}`, title: `${fixed(e.elapsed_s, 1)}s: ${said}` }));
      marks.push([mark, e.elapsed_s]);
      while (e.elapsed_s > span * 0.92) span *= 1.5;
      place();
      cost += e.cost_usd;
      tokens += e.tokens;
      count.steps.textContent = String(marks.length);
      count.time.textContent = fixed(e.elapsed_s, 0);
      count.cost.textContent = `$${fixed(cost, 4)}`;
      count.tokens.textContent = tokens.toLocaleString('en-US');
      now.textContent = said;
    },
    end(e) {
      const details = e.grade_details || {};
      const faults = Object.entries(rules.fault_counters).filter(([counter]) => details[counter]).map(([counter, name]) => `${name}${details[counter] > 1 ? ` ×${details[counter]}` : ''}`);
      if (rules.ending_faults[e.termination]) faults.push(rules.ending_faults[e.termination]);
      now.textContent = e.error ? `Stopped: ${e.error}` : 'Finished.';
      result.hidden = false;
      result.replaceChildren(
        el('strong', { class: e.passed ? 'pass' : 'fail' }, e.passed ? 'Passed' : 'Did not pass'),
        details.items ? ` · ${details.correct} of ${details.items} items right` : '',
        faults.length ? ` · ${faults.join(', ')}` : e.error ? '' : ' · no faults',
      );
    },
  };
}

// Reads a text/event-stream body: calls back with (kind, value) for each message.
async function readEvents(response, onMessage) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let kind = null;
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) kind = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (kind) onMessage(kind, JSON.parse(data));
    }
    if (done) return;
  }
}

// Signing in for live races. An invitation link (?invite=...) is exchanged once with the runner for a session,
// which this browser keeps, so nothing is typed and the invite leaves the address bar. A runner on your own
// machine needs no sign-in. Returns { token, races_left } or null (not signed in: no button is shown at all).
const SESSION_KEY = 'ledger-live-session';
const stored = {
  get() {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return null; // storage is blocked: the invitation link still works for this visit
    }
  },
  set(token) {
    try {
      if (token) localStorage.setItem(SESSION_KEY, token);
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      /* nothing to keep it in */
    }
  },
};
let sessionPromise;
function signIn(runner, again = false) {
  if (again) sessionPromise = null;
  sessionPromise ||= (async () => {
    if (!runner.options.needs_code) return { token: null, races_left: null };
    const post = async (ask) => {
      const response = await fetch(`${runner.base}/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ask) });
      return response.ok ? response.json() : null;
    };
    const url = new URL(location.href);
    const invite = url.searchParams.get('invite');
    let session = null;
    try {
      if (invite) {
        session = await post({ invite });
        url.searchParams.delete('invite');
        history.replaceState(null, '', url); // the invite is spent: do not leave it in the address bar or history
      }
      if (!session && stored.get()) session = await post({ token: stored.get() });
    } catch {
      return null; // the runner did not answer
    }
    stored.set(session ? session.token : null);
    return session;
  })();
  return sessionPromise;
}

const providerName = (id) => ({ openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' })[id] || id;

// The live panel under the arena: what the record expects, then a fresh scenario raced now, then how it compares.
async function drawLive(v) {
  const box = $('live');
  if (!box) return;
  const runner = await findRunner();
  if ($('live') !== box) return; // the verdict was redrawn while we looked
  const title = el('h4', null, 'Race them live on a fresh scenario');
  const soon = 'Live races are open to the hackathon judges for now, by invitation link, and coming soon for everyone. Every scenario above is a real recorded race you can replay.';
  if (!runner) {
    box.replaceChildren(title, el('p', { class: 'note', id: 'live-soon' }, soon));
    return;
  }
  if (!runner.options) {
    box.replaceChildren(title, el('p', { class: 'note' }, `The race runner at ${runner.base} is not answering. Recorded races still play.`));
    return;
  }
  const session = await signIn(runner);
  if ($('live') !== box) return;
  if (!session) {
    // not signed in: nothing to press and nothing to type
    box.replaceChildren(title, el('p', { class: 'note', id: 'live-soon' }, soon));
    return;
  }
  const task = spec_task(v.task);
  const offered = runner.options.tasks.find((t) => t.id === task);
  const models = runner.options.models;
  if (!offered || models.length < 2) {
    box.replaceChildren(title, el('p', { class: 'note' }, !offered ? 'This runner does not offer this task.' : 'The live budgets are used up for now. Recorded races still play.'));
    return;
  }
  // Any two models on the runner's list can be raced. The pair being looked at is the starting choice where it is on it.
  const start = [models.includes(v.a) ? v.a : models[0]];
  start.push(models.includes(v.b) && v.b !== start[0] ? v.b : models.find((m) => m !== start[0]));
  const pick = (id, label, chosen) =>
    el('select', { id, 'aria-label': label }, models.map((m) => el('option', { value: m, selected: m === chosen }, shortName(m))));
  const pickA = pick('live-a', 'First model', start[0]);
  const pickB = pick('live-b', 'Second model', start[1]);
  const level = el('select', { id: 'live-level', 'aria-label': 'Difficulty' }, offered.levels.map((x) => el('option', { value: x, selected: x === 'standard' }, `${x} difficulty`)));
  const profile = el('select', { id: 'live-profile', 'aria-label': 'What matters most' }, runner.options.profiles.map((x) => el('option', { value: x, selected: x === 'budget' }, `${x} scoring`)));
  const go = el('button', { type: 'button', id: 'live-go' }, 'Race them live');
  const prior = el('p', { class: 'note', id: 'live-prior' });
  const money = el('p', { class: 'note small', id: 'live-budget' });
  const stage = el('div', { id: 'live-stage' });
  const say = el('p', { class: 'finish', id: 'live-result', role: 'status', 'aria-live': 'polite' });
  const grown = el('div', { id: 'live-graph' });

  // what is left to spend, by provider, and how many races this sign-in has left
  const showBudget = (options, left) => {
    const parts = (options.budgets || []).map((b) => `${providerName(b.provider)} $${fixed(b.left_usd, 2)} of $${fixed(b.limit_usd, 2)}`);
    const out = (options.models_out || []).map(shortName);
    money.replaceChildren(
      parts.length ? `Live budget left: ${parts.join(' · ')}.` : '',
      left === null || left === undefined ? '' : ` ${plural(left, 'live race')} left on this sign-in.`,
      out.length ? ` Not on offer now (their provider's budget is used up): ${out.join(', ')}.` : '',
    );
  };
  showBudget(runner.options, session.races_left);

  // the record for whichever two are chosen: it may favour one, lean, name no favourite, or not exist at all
  let recordFor = v;
  const readRecord = async () => {
    const [a, b] = [pickA.value, pickB.value];
    go.disabled = a === b;
    if (a === b) {
      prior.textContent = 'Choose two different models.';
      return;
    }
    recordFor = a === v.a && b === v.b ? v : await ledger.verdict(v.task, a, b, null, rules.good_enough, rules.min_pairs, state.profile, null);
    const r = recordFor;
    const text =
      r.verdict === 'no data'
        ? `${shortName(a)} and ${shortName(b)} have never met on this task in the record. This race would be the first evidence, and one race is not a verdict.`
        : r.verdict === 'better'
          ? `On this tested workflow the record favours ${shortName(r.better)}: it won ${r.wins[r.better]} of their ${r.pairs} scenarios.`
          : r.verdict === 'leaning'
            ? `On this tested workflow the record leans to ${shortName(r.better)} (${r.wins[r.better]} of ${r.pairs}), not settled.`
            : `On this tested workflow the record names no favourite between them (${r.wins[a]} to ${r.wins[b]} over ${plural(r.pairs, 'scenario')}).`;
    prior.textContent = `${text} Now put that to the test: one new scenario, generated this minute, never seen by either model.`;
  };
  pickA.addEventListener('change', readRecord);
  pickB.addEventListener('change', readRecord);
  await readRecord();

  go.addEventListener('click', async () => {
    const [a, b] = [pickA.value, pickB.value];
    const r = recordFor;
    go.disabled = true;
    say.textContent = '';
    const lanes = { A: liveLane(a, 'a'), B: liveLane(b, 'b') };
    stage.replaceChildren(el('p', { class: 'note' }, 'A new world is being generated and handed to both models. Nothing below is a replay.'), lanes.A.node, lanes.B.node);
    try {
      const response = await fetch(`${runner.base}/race`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, a, b, difficulty: level.value, profile: profile.value, token: session.token || '' }),
      });
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      let record = null;
      let failed = null;
      await readEvents(response, (kind, e) => {
        if (kind === 'step') lanes[e.side].step(e);
        else if (kind === 'attempt_end') lanes[e.side].end(e);
        else if (kind === 'record') record = e.record;
        else if (kind === 'failed') failed = e.error;
      });
      if (failed || !record) throw new Error(failed || 'the race ended without a record');
      const winner = { A: a, B: b }[record.body.verdict.winner] || null;
      const versus = !winner
        ? 'Live, this scenario had no winner.'
        : r.verdict === 'no data'
          ? `Live, ${shortName(winner)} took this scenario: the first these two have played on this task. One scenario is not a verdict.`
          : !r.better
            ? `Live, ${shortName(winner)} took this scenario. The record had no favourite, and one scenario does not make one.`
            : winner === r.better
              ? `Live, ${shortName(winner)} took this scenario too: in line with the record.`
              : `Live, ${shortName(winner)} took this scenario: against the record. One upset does not overturn ${r.wins[r.better]} of ${r.pairs}, but it is now on file.`;
      say.replaceChildren(versus, ' ', el('span', { class: 'note' }, 'Sealed record ', el('code', null, record.body.run_id), ', seal ', el('code', null, record.sha256.slice(0, 12)), '. A live result is kept apart from the recorded evidence the verdict rests on.'));
      const liveText = liveReport(record, a, b, task, r);
      window.ledgerDemo.lastLiveReport = liveText;
      say.append(
        ' ',
        el('button', { type: 'button', id: 'download-live', class: 'quiet small', onclick: () => download(liveText, 'live-race-report.md') }, 'Download the live race report'),
      );
      // the result joins the graph, as its own kind of node, and the picture is drawn from the graph again
      await ask(ADD_LIVE, { run: record.body.run_id, winner, seal: record.sha256, at: Date.now(), version: r.version, a, b });
      grown.replaceChildren(r.rounds ? await evidenceGraph(r) : '');
    } catch (error) {
      say.textContent = `The live race did not run: ${error.message}`;
    } finally {
      go.disabled = false;
      // the budgets and this sign-in's races have moved: read them again
      try {
        const [options, renewed] = await Promise.all([fetch(`${runner.base}/options`).then((x) => x.json()), signIn(runner, true)]);
        showBudget(options, renewed ? renewed.races_left : null);
      } catch {
        /* the next race will say what is wrong */
      }
    }
  });
  box.replaceChildren(title, prior, el('div', { class: 'race-controls' }, pickA, el('span', { class: 'note' }, 'vs'), pickB, level, profile, go), money, stage, say, grown);
}
const spec_task = (test) => test.split('/').pop();

// The report of one live race, from the sealed record the runner handed back. It is one scenario, and it says so:
// a live result never joins the recorded evidence a verdict rests on.
function liveReport(record, a, b, title, v) {
  const body = record.body;
  const winner = { A: a, B: b }[(body.verdict || {}).winner] || null;
  const lines = [
    `# Live race report: ${title}`,
    '',
    `Task \`${v.task}\`, version \`${v.version}\`. Raced live: \`${a}\` and \`${b}\`.`,
    '',
    '**This is one live scenario, generated for this race. It is kept apart from the recorded matches, and one ' +
      'scenario does not make a verdict.**',
    '',
    `- Result: ${winner ? `\`${winner}\` took this scenario` : 'no winner'}.`,
    v.verdict === 'no data'
      ? '- The record holds no match between these two on this task: this is the first evidence.'
      : `- On this tested workflow the record ${v.better ? `${v.verdict === 'better' ? 'favours' : 'leans to'} \`${v.better}\` (${v.wins[v.better]} of ${v.pairs} scenarios)` : `names no favourite (${v.wins[a]} to ${v.wins[b]})`}.`,
    `- Sealed record \`${body.run_id}\`, seal \`${str(record.sha256).slice(0, 16)}\`${body.engine_commit ? `, engine commit \`${str(body.engine_commit).slice(0, 7)}\`` : ''}.`,
    '',
    '## What each model did and what it cost',
    '',
    '| Model | Result | Cost | Calls | Tokens read | Tokens written | Seconds | How it ended |',
    '|---|---|---|---|---|---|---|---|',
  ];
  let spent = 0;
  for (const [side, name] of [['A', a], ['B', b]]) {
    const r = (((body.contestants || {})[side] || {}).results || [])[0];
    if (!r) {
      lines.push(`| \`${name}\` | not in the record | - | - | - | - | - | - |`);
      continue;
    }
    spent += r.cost_usd || 0;
    lines.push(
      `| \`${name}\` | ${r.passed ? 'passed' : 'failed'} | $${fixed(r.cost_usd || 0, 4)} | ${r.calls ?? '-'} | ${r.input_tokens ?? '-'} | ` +
        `${r.output_tokens ?? '-'} | ${fixed(r.wall_s || 0, 0)} | ${r.termination || '-'} |`,
    );
  }
  lines.push(
    '',
    `This race cost $${fixed(spent, 4)} in all. The cost is what the runner recorded for each call: the provider's billed ` +
      'figure where it reports one, otherwise tokens times its list price.',
    '',
  );
  return lines.join('\n');
}

// The result as a fight card: the two models, the arena, the comparison row by row, where each one slipped
// (with the visitor's own say on how serious each fault is), then one verdict, then how to check it.
function fightCard(spec, v) {
  const { a, b } = v;
  const ids = [a, b];
  const title = spec.blueprint.title || spec.task;
  const fa = v.fit[a];
  const fb = v.fit[b];
  const A = v.models[a];
  const B = v.models[b];

  const tolerance = el(
    'fieldset',
    { class: 'tolerance' },
    el('legend', null, 'Whose tolerance decides?'),
    Object.keys(rules.policy.profiles).map((name) => {
      const p = rules.policy.profiles[name];
      return el(
        'label',
        { class: `option compact${name === v.profile ? ' on' : ''}` },
        el('input', {
          type: 'radio',
          name: 'profile',
          value: name,
          checked: name === v.profile,
          onchange: () => {
            state.profile = name;
            showVerdict();
          },
        }),
        el(
          'span',
          { class: 'text' },
          el('span', { class: 'name' }, sentence(name)),
          el('span', { class: 'sub' }, `${PROFILE_HELP[name] || ''} ${percent(p.bar)} of attempts must pass; a serious fault may show in at most ${percent(p.serious_share)} of them.`),
        ),
      );
    }),
  );

  const side = (id, cls) =>
    el('div', { class: `fighter ${cls}` }, el('div', { class: 'name' }, shortName(id)), el('div', { class: 'id' }, id));
  const settings = [spec.blueprint.settings.effort, spec.blueprint.settings.attempt_budget_usd];
  const card = [
    el('div', { class: 'fighters' }, side(a, 'a'), el('div', { class: 'vs', 'aria-hidden': 'true' }, 'vs'), side(b, 'b')),
    el(
      'p',
      { class: 'note center' },
      `Matches played by Gladiator, an open engine · ${plural(v.evidence.length, 'sealed match record')} · the same settings for both` +
        (settings[0] && settings[0].length === 1 ? `: ${settings[0][0]} effort` : '') +
        (settings[1] && settings[1].length === 1 ? `, $${str(settings[1][0], true)} limit per attempt` : ''),
    ),
  ];

  // Each square says who won the scenario and what state both were in: both passed (plain), only the winner
  // passed (dashed outline), or neither passed (faded: the one that got further, or spent less, took it).
  const stateOf = (r) => (r.a_passed && r.b_passed ? 'both' : r.a_passed || r.b_passed ? 'sole' : 'neither');
  const tally = { both: 0, sole: 0, neither: 0 };
  for (const r of v.rounds) tally[stateOf(r)] += 1;
  const arena = [
    el('h3', { class: 'center' }, `The arena: ${plural(v.pairs, 'scenario')}`),
    el(
      'p',
      { class: 'note center' },
      'Each scenario is a freshly generated world with its own records and traps. Both models are handed the same one. ' +
        'One scenario played by both is a pair, and each pair has a winner.',
    ),
    el(
      'ol',
      { class: 'rounds', 'aria-label': 'Who won each scenario' },
      v.rounds.map((r, i) => {
        const who = r.winner === a ? 'a' : r.winner === b ? 'b' : 'tie';
        const what = stateOf(r);
        const how = {
          both: 'both passed; the cheaper, faster run won',
          sole: 'only the winner passed',
          neither: r.rule === 'progress' ? 'neither passed; the one that got further won' : 'neither passed; the cheaper, faster run won',
        }[what];
        const label = who === 'tie' ? `Scenario ${i + 1}: a tie` : `Scenario ${i + 1}: won by ${shortName(r.winner)} (${how})`;
        return el(
          'li',
          null,
          el('button', { type: 'button', class: `round ${who} ${what}`, title: `${label}. Watch it.`, 'aria-label': `${label}. Watch the replay.`, onclick: () => openRace(v, i) }, String(i + 1)),
        );
      }),
    ),
    el(
      'p',
      { class: 'legend' },
      el('span', { class: 'key a' }), `won by ${shortName(a)}`,
      el('span', { class: 'key b' }), `won by ${shortName(b)}`,
      tally.both ? [el('span', { class: 'key both' }), `both passed, the cheaper and faster run won (${tally.both})`] : null,
      tally.sole ? [el('span', { class: 'key sole' }), `only the winner passed (${tally.sole})`] : null,
      tally.neither ? [el('span', { class: 'key neither' }), `neither passed, the one that got further or spent less won (${tally.neither})`] : null,
    ),
    el('p', { class: 'note center' }, 'Pick a scenario to watch both models work it, step by step.'),
    el('div', { id: 'race', class: 'race', hidden: true }),
    el('div', { id: 'live', class: 'race live' }),
  ];

  const num = (text, cls = '') => el('span', { class: `fig ${cls}` }, text);
  const tape = [
    tapeRow(num(String(v.wins[a])), 'Scenarios won', `of ${v.pairs} played against each other`, num(String(v.wins[b]))),
    tapeRow(num(`${A.passed} of ${A.attempts}`), 'Scenarios passed', 'in those same pairs', num(`${B.passed} of ${B.attempts}`)),
    tapeRow(num(`$${fixed(A.cost_per_attempt, 4)}`), 'Cost per attempt', 'lower is better', num(`$${fixed(B.cost_per_attempt, 4)}`)),
    tapeRow(num(`${fixed(A.seconds_per_attempt, 0)}s`), 'Seconds per attempt', 'lower is better', num(`${fixed(B.seconds_per_attempt, 0)}s`)),
    el('div', { class: 'tape-head' }, `Fit for this task: every attempt each model made on it, against any opponent`),
    tapeRow(
      num(`${fa.passed} of ${fa.attempts}`, fa.pass_rate < fa.bar ? 'bad' : ''),
      'Attempts passed',
      `${percent(fa.pass_rate)} and ${percent(fb.pass_rate)}; ${percent(fa.bar)} needed`,
      num(`${fb.passed} of ${fb.attempts}`, fb.pass_rate < fb.bar ? 'bad' : ''),
    ),
  ];

  // Where each one slipped: every fault either model made (and every unforgivable one, made or not), with the
  // level it has under this tolerance. The visitor can change a level; the verdict below follows.
  const faults = new Map();
  for (const [key, f] of [['a', fa], ['b', fb]]) {
    for (const x of f.faults) {
      if (!faults.has(x.fault)) faults.set(x.fault, { fault: x.fault, kind_of: x.kind_of ?? null, level: x.level });
      faults.get(x.fault)[key] = x;
    }
  }
  const order = (x) => rules.policy.levels.indexOf(x.level);
  const top = [...faults.values()].filter((x) => x.kind_of === null).sort((x, y) => order(x) - order(y) || (x.fault < y.fault ? -1 : 1));
  const count = (x, f) => (x ? num(`${x.attempts_with} of ${f.attempts}`, x.breaks ? 'bad' : x.attempts_with ? '' : 'none') : num(`0 of ${f.attempts}`, 'none'));
  const slips = [];
  for (const row of top) {
    const picker = el(
      'select',
      {
        class: `level ${row.level}`,
        'aria-label': `How serious is "${row.fault}" for you?`,
        title: LEVEL_HELP[row.level],
        onchange: (event) => {
          state.overrides = { ...state.overrides, [row.fault]: event.target.value };
          showVerdict();
        },
      },
      rules.policy.levels.map((level) => el('option', { value: level, selected: level === row.level }, level)),
    );
    slips.push(tapeRow(count(row.a, fa), sentence(row.fault), null, count(row.b, fb), picker));
    for (const kid of [...faults.values()].filter((x) => x.kind_of === row.fault).sort((x, y) => (x.fault < y.fault ? -1 : 1))) {
      slips.push(
        el(
          'div',
          { class: 'tape-row kid' },
          el('div', { class: 'val l' }, count(kid.a, fa)),
          el('div', { class: 'lab' }, sentence(kid.fault)),
          el('div', { class: 'val r' }, count(kid.b, fb)),
        ),
      );
    }
  }
  const changed = Object.keys(state.overrides).length;
  const slipsHead = el(
    'div',
    { class: 'tape-head' },
    'Where each one slipped (attempts with the fault). ',
    el('span', { class: 'plainer' }, 'Set how serious each is for you: ', rules.policy.levels.map((l) => `${l} = ${LEVEL_HELP[l]}`).join('; '), '.'),
    changed
      ? [' ', el('button', { type: 'button', class: 'quiet small', id: 'reset-levels', onclick: () => { state.overrides = {}; showVerdict(); } }, `Reset ${plural(changed, 'change')}`)]
      : null,
  );

  const kind = { use: 'win', 'only one fit': 'win', 'both fit': 'even', 'neither fit': 'stop', 'too few attempts': 'even' }[v.outcome];
  const versus = {
    better: `Head to head, ${shortName(v.better)} won ${v.wins[v.better]} of ${v.pairs} scenarios. A split that lopsided between two equal models would happen about ${percent(v.p_value, 1)} of the time.`,
    leaning: `Head to head, ${shortName(v.better)} won ${v.wins[v.better]} of ${v.pairs} scenarios: ahead, but a split like that happens by chance ${percent(v.p_value)} of the time, so it is not settled.`,
    'no real difference shown': `Head to head they split the ${v.pairs} scenarios ${v.wins[a]} to ${v.wins[b]}.`,
    'not enough evidence': `Head to head they have met on only ${plural(v.pairs, 'scenario')}, fewer than the ${rules.min_pairs} a verdict needs.`,
  }[v.verdict];
  const why = ids
    .filter((id) => v.fit[id].fit === false)
    .map((id) => el('li', null, `${shortName(id)} is not fit: ${v.fit[id].reasons.join('; ')}.`));
  const others = v.fit_on_task.filter((o) => !ids.includes(o.model));
  const elsewhere =
    v.outcome !== 'neither fit'
      ? null
      : others.length
        ? el(
            'p',
            null,
            'Fit for this task among the models tested, cheapest first: ',
            others.map((o) => `${shortName(o.model)} (passed ${percent(o.pass_rate)} of ${o.attempts} attempts, $${fixed(o.cost_per_attempt, 4)} each)`).join('; '),
            '.',
          )
        : el('p', null, `No model tested on this task is fit at ${v.profile} tolerance. That points to a larger model, more reasoning effort, or guardrails around the faults above; this page has no matches for those to show.`);
  const band = el(
    'div',
    { class: `band ${kind}`, id: 'verdict-band' },
    el('p', { class: 'band-kind' }, `Verdict for this task, at ${v.profile} tolerance`),
    el('p', { class: 'headline', id: 'verdict-headline' }, plainNames(v.headline, ids)),
    why.length ? el('ul', { class: 'why' }, why) : null,
    el('p', null, versus),
    elsewhere,
    el('p', { class: 'small' }, `A claim about ${title} as tested, in a simulated world. Not a ranking of the models in general.`),
  );

  const proof = el(
    'p',
    { class: 'proof' },
    'Test ', el('code', null, spec.version.split('/').pop()),
    ' · sealed records ', v.evidence.map((e, i) => [i ? ', ' : '', el('code', null, str(e.seal_sha256).slice(0, 12))]),
    ' · check every record yourself: ', el('code', null, 'uv run ledger verify'),
  );
  return [tolerance, card, arena, el('div', { class: 'tape' }, tape, slipsHead, slips), band, proof];
}

function drawVerdict(spec, v) {
  const d = spec.decision;
  const bp = spec.blueprint;
  const st = bp.settings;
  const one = (values, isFloat) => {
    const kept = (values || []).filter((x) => x !== null && x !== undefined);
    return kept.length ? kept.map((x) => str(x, isFloat)).join(', ') : 'not recorded';
  };
  const markdown = ledger.markdown(spec);
  const costText = costMarkdown(v, spec.blueprint.title || spec.task);
  const evidenceText = evidenceMarkdown(v, spec.blueprint.title || spec.task);

  const copyNote = el('span', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const body = [
    fightCard(spec, v),
    d.notes.length ? el('ul', { class: 'notes' }, d.notes.map((n) => el('li', null, plainNames(n, [d.a, d.b])))) : null,

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
      el('button', { type: 'button', id: 'download-spec', onclick: () => download(markdown, 'spec.md') }, 'Spec (build plan)'),
      el('button', { type: 'button', id: 'download-cost', onclick: () => download(costText, 'cost-breakdown.md') }, 'Cost breakdown'),
      el('button', { type: 'button', id: 'download-evidence', onclick: () => download(evidenceText, 'evidence-report.md') }, 'Evidence report'),
      el(
        'button',
        { type: 'button', id: 'download-all', class: 'quiet', onclick: () => download([markdown, costText, evidenceText].join('\n\n'), 'ledger-reports.md') },
        'All three in one file',
      ),
      el('button', { type: 'button', id: 'copy-spec', class: 'quiet', onclick: () => copy(markdown, copyNote) }, 'Copy spec'),
      copyNote,
    ),
    el(
      'p',
      { class: 'note' },
      'Three documents for this pair, each the same Markdown the ledger command line writes: the spec (what to build, with a ' +
        'machine-readable copy at the end), the cost breakdown (per attempt, per successful result, per 1,000 runs, scenario by ' +
        'scenario) and the evidence report (fit, every fault with its count, every scenario and its sealed record).',
    ),
  ];
  $('verdict-body').replaceChildren(...body.flat(Infinity).filter(Boolean));
}

function download(markdown, name) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = el('a', { href: url, download: name });
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

// ---- the example ------------------------------------------------------------------------------------------------

// Walks the three steps for a flow and pair of models with the most head-to-head evidence in the graph (a settled
// verdict if one of them has it), so a first-time visitor sees a full verdict and spec. Nothing is hard-coded: more matches can change the example.
async function showExample() {
  const button = $('example');
  button.disabled = true;
  try {
    $('flow-text').value = '';
    await searchFlows();
    const found = [];
    for (const flow of state.flows.flows) {
      for (const m of await ledger.modelsOnFlow(flow.test)) {
        for (const p of await ledger.partnersOnFlow(flow.test, m.model)) {
          if (m.model < p.model) found.push({ flow, a: m.model, b: p.model, pairs: p.pairs });
        }
      }
    }
    found.sort((x, y) => y.pairs - x.pairs);
    // among the pairs with the most evidence, prefer a settled one that names a model to use and where the
    // visitor's tolerance changes the answer; failing that a settled one; otherwise the most evidence
    const judge = (c, profile) => ledger.verdict(c.flow.test, c.a, c.b, null, rules.good_enough, rules.min_pairs, profile, {});
    let best = null;
    let settled = null;
    for (const c of found.slice(0, 12)) {
      const personal = await judge(c, 'personal');
      if (personal.verdict !== 'better') continue;
      settled = settled || c;
      if (!['use', 'only one fit'].includes(personal.outcome)) continue;
      if ((await judge(c, 'enterprise')).headline !== personal.headline) {
        best = c;
        break;
      }
    }
    best = best || settled || found[0];
    if (!best) return;
    await chooseFlow(best.flow);
    await chooseFirst(best.a);
    drawFirst();
    await chooseSecond(best.b);
  } finally {
    button.disabled = false;
  }
}

// ---- start --------------------------------------------------------------------------------------------------

async function start() {
  const status = $('status');
  try {
    ({ ledger, rules } = await ledgerReady);
    state.profile = rules.policy.default_profile;
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
  $('example').disabled = false;
  $('example').addEventListener('click', showExample);
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
