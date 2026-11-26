// The page: starts the engine worker, exposes window.ledgerDemo, and draws the three steps.

import { costMarkdown, createLedger, ended, evidenceMarkdown, expandSteps } from './ledger.js';
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

async function send(message) {
  await graphReady;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, ...message });
  });
}
const ask = (query, params) => send({ query, params: params || {} });

const getJson = (path) =>
  fetch(new URL(path, import.meta.url)).then((r) => {
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  });

// ---- steps, loaded into the graph only for the scenarios a question is about -----------------------------------

const stepFiles = new Map(); // run id -> its step file, fetched once (null when there is none)
const worldsLoaded = new Set(); // scenarios whose steps are in the graph
const worldsMissing = new Set(); // scenarios with no steps to load: a race run in this tab, until it is imported
let stepProgress = null; // (done, total) while steps load, for whoever is showing progress

function stepFile(run, known) {
  if (!stepFiles.has(run)) stepFiles.set(run, known.includes(run) ? getJson(`./data/steps/${run}.json`) : Promise.resolve(null));
  return stepFiles.get(run);
}

// Puts the steps of these scenarios ("<run>/<workflow>/<attempt>") into the graph, a run file at a time.
async function loadSteps(matches) {
  const wanted = new Map(); // run -> its scenarios still to load
  for (const match of matches) {
    if (worldsLoaded.has(match) || worldsMissing.has(match)) continue;
    const cut = match.indexOf('/');
    const run = match.slice(0, cut);
    if (!wanted.has(run)) wanted.set(run, []);
    wanted.get(run).push(match.slice(cut + 1));
  }
  const total = [...wanted.values()].reduce((n, worlds) => n + worlds.length, 0);
  let done = 0;
  const known = wanted.size ? (await ledgerReady).rules.steps_for : [];
  for (const [run, worlds] of wanted) {
    const file = await stepFile(run, known);
    const here = worlds.filter((w) => file && file.worlds[w]);
    if (here.length) await send({ load: expandSteps(file, new Set(here)) });
    for (const w of worlds) (here.includes(w) ? worldsLoaded : worldsMissing).add(`${run}/${w}`);
    done += worlds.length;
    if (stepProgress) stepProgress(done, total);
  }
  return { missing: matches.filter((m) => worldsMissing.has(m)).length };
}

// ---- the live record: races that ended after this page was published -------------------------------------------
//
// The page ships with a copy of the record (data/graph.json). Ledger's live record (`ledger serve`, ledger/live.py)
// keeps the same record in one Relate store and takes in each race as the runner files it. Where one is published
// ("record" in data/live.json, or ?record=<address> for one on your own machine), the page asks it which records
// it holds and loads the ones its own copy lacks into the graph in this tab, with the statements the shipped ones
// were written with: the same graph, a few records ahead. The requests are plain reads of public records and
// carry nothing about the visitor. With no live record, or one that does not answer, the page is its shipped copy.

const inAddress = new URLSearchParams(location.search);
let publishedPromise;
// what the page was published with (data/live.json): where the race runner is, and where the live record is
function published() {
  publishedPromise ||= fetch(new URL('./data/live.json', import.meta.url))
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return publishedPromise;
}
const recordAddress = async () => (inAddress.get('record') || (await published()).record || '').replace(/\/+$/, '') || null;

const liveRecord = { address: null, held: 0, added: [], problem: null, looked: false }; // what it has given this tab
const fromLive = new Set(); // the records in this tab's graph that came from the live record

async function getLive(url, ms = 20000) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ms);
  try {
    const response = await fetch(url, { signal: stop.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// One look at the live record: every record it holds that this tab's graph lacks is loaded into the graph. One
// look at a time (a second waits for the first). `fresh` says a race has just ended, so the live record looks at
// the runner before it answers. It never throws: a live record that cannot be read is said, and nothing changes.
let catching = Promise.resolve();
function catchUp(fresh = false) {
  catching = catching.then(() => look(fresh));
  return catching;
}
async function look(fresh) {
  const base = await recordAddress();
  if (!base) return { added: [] };
  liveRecord.address = base;
  const added = [];
  try {
    const answer = await getLive(`${base}/runs${fresh ? '?fresh=1' : ''}`);
    const listed = (answer.runs || []).map((x) => x.run_id);
    const held = new Set((await ask('MATCH (r:Run) RETURN r.run_id AS run', {})).map((x) => x.run));
    const missing = listed.filter((run) => !held.has(run));
    const fetched = missing.map((run) => getLive(`${base}/rows/${run}`));
    for (const waiting of fetched) waiting.catch(() => {}); // each is awaited below; none may fail unheard
    for (const [i, run] of missing.entries()) {
      const rows = await fetched[i];
      await send({ add: rows.run });
      stepFiles.set(run, Promise.resolve(rows.steps));
      fromLive.add(run);
      liveRecord.added.push(run);
      added.push(run);
    }
    liveRecord.held = listed.length;
    liveRecord.problem = null;
    return { added };
  } catch (error) {
    liveRecord.problem = String((error && error.message) || error);
    return { added, problem: liveRecord.problem };
  } finally {
    liveRecord.looked = true;
  }
}

// When a live run joins the record, in words, for the reports written as it ends.
const joinsWhen = () => (liveRecord.address ? 'as soon as the runner has filed it (Ledger’s live record takes it in)' : 'at the next import of live races');

// A run that has just ended, into the record at once: the live record is asked to look at the runner now, and
// what it took in is loaded into this tab's graph. The runner may need a moment to file the record, so the
// question is asked a few times. False when there is no live record, or it did not take the run in: the run
// then joins with the next import, as before.
async function joinRecord(run) {
  if (!(await recordAddress())) return false;
  const inGraph = async () => (await ask('MATCH (r:Run {run_id: $run}) RETURN count(r) AS n', { run }))[0].n > 0;
  for (let tries = 0; tries < 8; tries += 1) {
    const looked = await catchUp(true);
    if (await inGraph()) return true;
    if (looked.problem && tries >= 1) return false;
    await new Promise((done) => setTimeout(done, 2500));
  }
  return false;
}

const ledgerReady = Promise.all([getJson('./data/questions.json'), getJson('./data/rules.json')]).then(
  ([questions, rules]) => ({ rules, questions, ledger: createLedger(ask, questions, rules, loadSteps) }),
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
  // the verdict now on screen (what the graph picture is drawn from)
  current: async () => shown.v,
  // which pairs a verdict counts: the rule itself, for site/check.cjs
  referenceConditions: async (found, record) => (await ledgerReady).ledger.referenceConditions(found, new Map(Object.entries(record))),
  conditionsApart: async (reference, other) => (await ledgerReady).ledger.conditionsApart(reference, other),
  // one Cypher statement on the graph in this tab (a copy in memory: nothing here reaches the record)
  cypher: async (query, params = {}) => {
    await graphReady;
    return ask(query, params);
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
  // how they got there, asked of the steps: the process questions for a pair, their routes through the same
  // worlds, and a verdict with the reader's own check at a level
  process: async (task, a, b) => (await ledgerReady).ledger.process(task, a, b),
  route: async (task, a, b, scenario = null) => (await ledgerReady).ledger.route(task, a, b, scenario),
  verdictChecked: async (task, a, b, profile, levels) => {
    const { ledger, rules } = await ledgerReady;
    return ledger.verdict(task, a, b, null, rules.good_enough, rules.min_pairs, profile, null, { levels, kinds: null });
  },
  stepsLoaded: async () => ({ scenarios: worldsLoaded.size, missing: worldsMissing.size }),
  // what the live record has given this tab, once the look that is under way has ended
  liveRecord: async () => {
    await catching;
    return { ...liveRecord, added: [...liveRecord.added] };
  },
  catchUp: async (fresh = false) => catchUp(fresh),
  // what one race showed, and why a scenario went to its winner: the wording rules, for site/check.cjs
  raceOutcome: async (facts) => {
    await ledgerReady;
    return raceOutcome(facts);
  },
  whyTaken: async (round, a) => whyTaken(round, a),
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
  checks: {}, // the visitor's own process questions, by name, each at the level they gave it
  flowFaults: new Map(), // test id -> the faults its grader can report
};
const names = new Map(); // model id -> display name, as the graph has it
let ledger;
let rules;
let questionsText; // the named questions, as the Cypher text Relate runs
let turn = 0; // guards against a slow answer landing after a newer choice
let searchTurn = 0;

// id is null when no winner is named: the caller's sentence then does not use the name
const shortName = (id) => (id ? names.get(id) || id.split(':').pop().split('/').pop() : '');
const modelLabel = (id) => [el('span', { class: 'name' }, shortName(id)), el('span', { class: 'id' }, id)];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- how an attempt ended, in the page's three words ---------------------------------------------------------
//
// A test passes an attempt only when the result is right and the process it sets was followed. The page calls that
// a clean run and keeps the two apart everywhere, because an attempt that got every decision right and skipped a
// step has not failed the job: how serious the skipped step is, is the reader's call (the fault levels).
//   clean    the right result and every step the test asks for (what the test itself calls a pass)
//   skipped  the right result, with a step skipped
//   wrong    a decision wrong or left undone
const endOf = (right, clean) => (clean ? 'clean' : right ? 'skipped' : 'wrong');
const END_LABEL = { clean: '✓ Clean run', skipped: 'Right result, a step skipped', wrong: '✕ Wrong result', none: '✕ No result' };
const endMark = (state) => el('strong', { class: `end ${state}` }, END_LABEL[state]);

// Why a scenario went to its winner, from how both attempts ended and the engine's rule. `r` is a round of a
// verdict (winner, rule, a_right, a_passed, b_right, b_passed) and `a` the model on the first side. A scenario
// can go to a model on a tie-break when neither ran it clean, and the words must not call that a win on the job.
function whyTaken(r, a) {
  if (r.winner === 'tie' || !r.winner) return { kind: 'tie', text: 'nothing between them' };
  const [wr, wc, lr, lc] = r.winner === a ? [r.a_right, r.a_passed, r.b_right, r.b_passed] : [r.b_right, r.b_passed, r.a_right, r.a_passed];
  if (wc && lc) return { kind: 'efficiency', text: 'both ran it clean, and its run was the more efficient' };
  if (wc && lr) return { kind: 'process', text: 'both got the right result, and only it ran clean: the other skipped a step' };
  if (wc) return { kind: 'result', text: 'only it got the right result' };
  if (wr && lr) return { kind: 'unclean', text: 'both got the right result and neither ran clean, so it went on efficiency' };
  if (wr) return { kind: 'result', text: 'only it got the right result, though it skipped a step' };
  if (lr) return { kind: 'split', text: 'neither ran clean, and the tie-break went to it though only the other got every decision right' };
  return { kind: 'neither', text: r.rule === 'progress' ? 'neither got the right result, and it got further' : 'neither got the right result, so it went on efficiency' };
}

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

// A live race result that has not been downloaded is the one thing on this page that cannot be got back: a
// recorded verdict can always be drawn again. Anything that would replace it asks first.
let unsavedLive = false;
function mayLeave() {
  if (!unsavedLive) return true;
  const leave = window.confirm('You have a live race result on screen that you have not downloaded. Leave it? (Cancel, then use "Download the live race report" to keep it.)');
  if (leave) unsavedLive = false;
  return leave;
}

// Back to the start: nothing chosen, nothing on screen. The sign-in is kept.
// The strip that stays at the top of the window while the page is scrolled: what is chosen so far, and the one
// way back to the start. It is there from the first choice on, so nobody has to scroll up to find it.
function drawTrail() {
  $('trail').hidden = !state.task;
  const pair = state.a ? shortName(state.a) + (state.b ? ` vs ${shortName(state.b)}` : '') : null;
  $('trail-text').textContent = [state.flow ? state.flow.title : null, pair].filter(Boolean).join(' · ');
}

// How often a split would happen by chance, in words: never "about 0.0%".
const chance = (p) => (p < 0.001 ? 'less than 0.1%' : `about ${percent(p, 1)}`);

// Bring what was just started, or has just finished, into view, and move the keyboard's focus with it.
function follow(node, block = 'start') {
  if (!node) return;
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
  node.scrollIntoView({ behavior: 'smooth', block });
  node.focus({ preventScroll: true });
}

function startOver() {
  if (!mayLeave()) return;
  turn += 1;
  Object.assign(state, { task: null, flow: null, a: null, b: null, partners: new Map(), models: [], overrides: {} });
  shown.v = null;
  $('step-models').hidden = true;
  $('step-verdict').hidden = true;
  $('verdict-body').replaceChildren();
  drawTrail();
  $('flow-text').value = '';
  searchFlows();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function chooseFlow(flow) {
  if (!mayLeave()) return;
  const mine = ++turn;
  Object.assign(state, { task: flow.test, flow, a: null, b: null, partners: new Map(), models: [], costs: new Map(), overrides: {} });
  drawTrail();
  shown.v = null;
  drawFlows();
  $('first-list').replaceChildren(); // the last workflow's models must not be clickable while this one loads
  $('second-model').hidden = true;
  const [models, costs] = await Promise.all([ledger.modelsOnFlow(flow.test), costsFor(flow.test)]);
  if (mine !== turn) return;
  state.models = models;
  state.costs = costs;
  for (const m of models) if (m.display_name) names.set(m.model, m.display_name);
  $('step-models').hidden = false;
  $('step-verdict').hidden = true;
  $('models-intro').textContent =
    `${plural(models.length, 'model')} have judged pairs on ${flow.title} (version ${flow.version}). ` +
    'Pick the two you are choosing between. A record is shown where there is one; it never limits what you can pick.';
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

// The models the runner will race live, known once the visitor is signed in. A model's card says so, so a pair for
// a live race is chosen here, in the one place models are chosen.
let liveModels = null;
const liveTag = (model) => (liveModels && liveModels.has(model) ? ' · can race live' : '');

// First model: every model with judged pairs on this flow, most evidence first, as compact cards.
// Every model that can be chosen: the ones with a record on this flow, and any model the platform can run that has
// none yet. A record is information about a model, never a condition for choosing it.
function availableModels() {
  const known = new Set(state.models.map((m) => m.model));
  const fresh = liveModels ? [...liveModels].filter((m) => !known.has(m)).map((model) => ({ model, pairs: 0 })) : [];
  return [...state.models, ...fresh];
}
const recordWords = (pairs) => (pairs ? plural(pairs, 'judged pair') : 'not tested on this workflow yet');

function drawFirst() {
  const models = availableModels().sort((x, y) => y.pairs - x.pairs || (x.model < y.model ? -1 : 1));
  $('first-list').className = 'options compact';
  $('first-list').replaceChildren(
    ...models.map((m) =>
      option('first', m.model, m.model === state.a, false, recordWords(m.pairs) + liveTag(m.model), () => chooseFirst(m.model), true),
    ),
  );
}

async function chooseFirst(model) {
  if (!mayLeave()) {
    drawFirst(); // put the choice back as it was
    return;
  }
  const mine = ++turn;
  Object.assign(state, { a: model, b: null });
  drawTrail();
  $('second-more-list').replaceChildren(); // the last model's pairings must not be choosable while this one's load
  $('second-more').open = false;
  $('second-list').replaceChildren();
  shown.v = null;
  $('step-verdict').hidden = true;
  const partners = await ledger.partnersOnFlow(state.task, model);
  const scores = await ledger.scoresOf([...new Set([model, ...partners.map((p) => p.model), ...availableModels().map((m) => m.model)])]);
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

// ---- where a model sits: capability against cost, the two things that make a pairing a fair one ----------------
//
// Capability is the published Epoch Capabilities Index. Cost is what an attempt cost in Gladiator's own matches: on
// this task where the model has played it, otherwise on the other tasks it has played (and said so). Two models
// close on both are a first-choice pairing: a match between them is the one worth running, because neither the
// price nor the capability decides it before it starts. This only suggests who to pair. It never says who is better.

const COST_ON_TASK = `MATCH (tv:TestVersion {key: $version})<-[:USED]-(mt:Match)<-[:IN]-(x:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded
RETURN m.name AS model, count(x) AS attempts, avg(x.cost_usd) AS cost`;
const COST_ANYWHERE = `MATCH (mt:Match)<-[:IN]-(x:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded
RETURN m.name AS model, count(x) AS attempts, avg(x.cost_usd) AS cost`;
const CLOSE_COST = 3; // within three times the cost per attempt, either way

async function costsFor(task) {
  const version = await ledger.currentVersion(task);
  const [here, anywhere] = await Promise.all([ask(COST_ON_TASK, { version }), ask(COST_ANYWHERE, {})]);
  const out = new Map(anywhere.filter((x) => x.cost > 0).map((x) => [x.model, { cost: x.cost, attempts: x.attempts, basis: 'other tasks' }]));
  for (const x of here) if (x.cost > 0) out.set(x.model, { cost: x.cost, attempts: x.attempts, basis: 'this task' });
  return out;
}

// How one model sits against the first: 'first' (close on both), 'capability', 'cost', 'far', or 'unplaced'.
function placeOf(model) {
  const paper = onPaper(model);
  const [mine, theirs] = [state.costs.get(state.a), state.costs.get(model)];
  const [s1, s2] = [state.scores.get(state.a), state.scores.get(model)];
  const ratio = mine && theirs ? Math.max(mine.cost, theirs.cost) / Math.min(mine.cost, theirs.cost) : null;
  const capClose = Boolean(s1 && s2 && s2.low <= s1.high && s1.low <= s2.high);
  const costClose = ratio !== null && ratio <= CLOSE_COST;
  const group = paper.gap === null || ratio === null ? 'unplaced' : capClose && costClose ? 'first' : capClose ? 'capability' : costClose ? 'cost' : 'far';
  const costText =
    ratio === null
      ? 'no cost measured yet'
      : (ratio < 1.25 ? 'about the same cost per attempt' : theirs.cost > mine.cost ? `${fixed(ratio, 1)}× the cost per attempt` : `${fixed(ratio, 1)}× cheaper per attempt`) +
        ` ($${fixed(theirs.cost, 4)}${theirs.basis === 'this task' ? '' : ', measured on other tasks'})`;
  return { group, gap: paper.gap, ratio, text: `${paper.text} · ${costText}` };
}

const GROUPS = [
  ['first', 'First-choice pairings: close in capability and in cost'],
  ['capability', 'Close in capability, not in cost'],
  ['cost', 'Close in cost, not in capability'],
  ['far', 'Further apart on both'],
  ['unplaced', 'Not placed: no published score or no cost measured yet'],
];

// The picture: every placed model by cost per attempt (across, log scale) and Epoch score (up). The first model is
// marked, the band around it is "close on both", and a dot can be clicked to choose that model.
function pairingChart(others) {
  if (!state.costs.get(state.a) || !state.scores.get(state.a)) return ''; // the first model cannot be placed
  const placed = [{ model: state.a, me: true }, ...others.filter((m) => m.place.group !== 'unplaced')].map((m) => ({ ...m, cost: state.costs.get(m.model).cost, score: state.scores.get(m.model) }));
  if (placed.length < 2) return '';
  const [W, H, L, R, T, B] = [720, 300, 54, 150, 16, 40];
  const lx = (c) => Math.log10(c);
  // wide enough for every model and for the whole band around the first one
  const xs = [...placed.map((m) => lx(m.cost)), lx(placed[0].cost / CLOSE_COST), lx(placed[0].cost * CLOSE_COST)];
  const [x0, x1] = [Math.min(...xs) - 0.15, Math.max(...xs) + 0.15];
  const [y0, y1] = [Math.min(...placed.map((m) => m.score.low)) - 2, Math.max(...placed.map((m) => m.score.high)) + 2];
  const X = (c) => L + ((lx(c) - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const me = placed[0];
  const ticks = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5].filter((c) => lx(c) > x0 && lx(c) < x1);
  // labels sit to the right of their dot; ones that would overlap are nudged down
  const labels = placed.map((m) => ({ m, x: X(m.cost) + 10, y: Y(m.score.score) + 4 })).sort((p, q) => p.y - q.y);
  for (let i = 1; i < labels.length; i += 1) for (let j = 0; j < i; j += 1) if (Math.abs(labels[i].x - labels[j].x) < 120 && labels[i].y - labels[j].y < 13) labels[i].y = labels[j].y + 13;
  const cls = (m) => (m.me ? 'me' : m.place.group === 'first' ? 'first' : 'other');
  return el(
    'figure',
    { class: 'pairing-chart', id: 'second-chart' },
    svg(
      'svg',
      { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Models by cost per attempt and published capability score. ${shortName(state.a)} is marked; models inside the band are close to it on both.` },
      svg('rect', { x: Math.max(L, X(me.cost / CLOSE_COST)), y: Y(me.score.high), width: Math.min(W - R, X(me.cost * CLOSE_COST)) - Math.max(L, X(me.cost / CLOSE_COST)), height: Y(me.score.low) - Y(me.score.high), class: 'pc-band' }),
      svg('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, class: 'pc-axis' }),
      svg('line', { x1: L, y1: T, x2: L, y2: H - B, class: 'pc-axis' }),
      ticks.map((c) => [svg('line', { x1: X(c), y1: H - B, x2: X(c), y2: H - B + 4, class: 'pc-axis' }), svg('text', { x: X(c), y: H - B + 16, 'text-anchor': 'middle', class: 'pc-tick' }, `$${c}`)]),
      svg('text', { x: (L + W - R) / 2, y: H - 6, 'text-anchor': 'middle', class: 'pc-title' }, 'Cost per attempt in our own matches (cheaper ← → dearer)'),
      svg('text', { x: 14, y: (T + H - B) / 2, 'text-anchor': 'middle', transform: `rotate(-90 14 ${(T + H - B) / 2})`, class: 'pc-title' }, 'Epoch Capabilities Index'),
      [y0 + 2, (y0 + y1) / 2, y1 - 2].map((v) => svg('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'pc-tick' }, fixed(v, 0))),
      placed.map((m) => svg('line', { x1: X(m.cost), y1: Y(m.score.low), x2: X(m.cost), y2: Y(m.score.high), class: `pc-range ${cls(m)}` })),
      placed.map((m) =>
        svg(
          'circle',
          { cx: X(m.cost), cy: Y(m.score.score), r: m.me ? 8 : 6, class: `pc-dot ${cls(m)}${m.model === state.b ? ' chosen' : ''}`, ...(m.me ? {} : { tabindex: 0, role: 'button', onclick: () => chooseSecond(m.model) }) },
          svg('title', null, m.me ? `${shortName(m.model)}: your first model` : `${shortName(m.model)}: ${m.place.text}. Click to choose.`),
        ),
      ),
      labels.map(({ m, x, y }) => svg('text', { x, y, class: `pc-label ${cls(m)}` }, shortName(m.model) + (m.me ? ' (first model)' : ''))),
    ),
    el('figcaption', null, `The shaded band is "close to ${shortName(state.a)} on both": published score ranges that overlap, and a cost per attempt within ${CLOSE_COST}×. Filled dots inside it are the first-choice pairings. The picture suggests who to pair; it does not say who does the task better. That is what the match is for.`),
  );
}

// Second model: the first-choice pairings as cards (close to the first model in capability and in cost), a picture
// of where every model sits, and one list of every other model that can be chosen, grouped by how close it is.
function drawSecond() {
  $('second-model').hidden = false;
  const others = availableModels()
    .filter((m) => m.model !== state.a)
    .map((m) => ({ ...m, place: placeOf(m.model), met: state.partners.get(m.model) || 0 }))
    .sort((x, y) => y.met - x.met || (x.place.gap ?? Infinity) - (y.place.gap ?? Infinity) || (x.model < y.model ? -1 : 1));
  const firsts = others.filter((m) => m.place.group === 'first');
  const mine = state.scores.get(state.a);
  const cost = state.costs.get(state.a);
  $('second-intro').textContent =
    (mine && cost
      ? `${shortName(state.a)} scores ${fixed(mine.score, 1)} on the Epoch Capabilities Index and costs about $${fixed(cost.cost, 4)} an attempt in our matches${cost.basis === 'this task' ? ' on this task' : ' (on other tasks; it has not played this one)'}. `
      : `${shortName(state.a)} cannot be placed yet (no published score, or no cost measured), so no pairing can be called close. `) +
    (firsts.length
      ? `${plural(firsts.length, 'model')} ${firsts.length === 1 ? 'is' : 'are'} close to it on both: the first-choice pairings below. Any other model can still be chosen: open "Choose a different model" under the picture.`
      : `No model is close to it on both, so there is no first-choice pairing. Choose any model from the list under the picture.`);
  const head = (m) =>
    (m.met
      ? `${plural(m.met, 'judged pair')} against ${shortName(state.a)}: ${m.met >= rules.min_pairs ? 'enough for a verdict' : 'too few for a verdict yet'}`
      : `no head-to-head with ${shortName(state.a)} yet: no verdict, each model's own record only`);
  const cards = firsts; // every other model is a card too, in the list under the picture
  $('second-list').className = 'options';
  $('second-list').replaceChildren(...cards.map((m) => option('second', m.model, m.model === state.b, false, `${head(m)} · ${m.place.text}${liveTag(m.model)}`, () => chooseSecond(m.model))));
  $('second-chart-box').replaceChildren(pairingChart(others));
  // Every other model, as cards to click, grouped by how close each is. Folded away when there are first-choice
  // pairings to look at first; open when there are none, or when the chosen model is in here.
  const rest = others.filter((m) => m.place.group !== 'first');
  const more = $('second-more');
  more.hidden = !rest.length;
  $('second-more-summary').textContent = firsts.length ? `Choose a different model: all ${plural(rest.length, 'other model')} you can pick` : `All ${plural(rest.length, 'model')} you can pick`;
  $('second-more-list').replaceChildren(
    ...GROUPS.filter(([group]) => group !== 'first').flatMap(([group, label]) => {
      const inGroup = rest.filter((m) => m.place.group === group);
      return inGroup.length
        ? [el('p', { class: 'more-group' }, label), el('div', { class: 'options' }, inGroup.map((m) => option('second', m.model, m.model === state.b, false, `${head(m)} · ${m.place.text}${liveTag(m.model)}`, () => chooseSecond(m.model))))]
        : [];
    }),
  );
  if (!firsts.length || rest.some((m) => m.model === state.b)) more.open = true;
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
    $('suggest-summary').textContent = 'Not on this platform yet: models close on paper (for reference)';
    $('suggest-intro').textContent = found.note;
    body.replaceChildren();
    return;
  }
  // models that can be chosen are in the lists above; what is left here cannot be run on this platform yet
  const here = new Set(availableModels().map((m) => m.model));
  const untested = found.candidates.filter((c) => !state.partners.has(c.model) && !here.has(c.model));
  $('suggest-summary').textContent = `Not on this platform yet: ${plural(untested.length, 'model')} close to ${shortName(state.a)} on paper (for reference)`;
  $('suggest-intro').textContent =
    `These score closest to ${shortName(state.a)}${found.open_only ? ' among open-weights models' : ''} but have not ` +
    'played it on this flow, and this platform cannot run them yet, so they cannot be picked. Every model that can be picked is in the lists above.';
  if (!untested.length) {
    body.replaceChildren(el('p', { class: 'note' }, 'Every close model can already be picked in the lists above.'));
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
  if (!mayLeave()) {
    drawSecond(); // put the choice back as it was
    return;
  }
  state.b = model;
  drawTrail();
  drawSecond();
  await showVerdict(true);
}

// The verdict for the chosen task and pair, read through the visitor's tolerance and their own rules.
// `keep` is the live panel now on screen, when the verdict is read again because a run started there has just
// joined the record: everything is drawn again from the graph except that panel, which stays as it is, and the
// scenario of `ringRun` (the race just run) is the one ringed and opened in the picture. Returns the verdict
// drawn, or null when a newer choice overtook it.
async function showVerdict(scroll = false, keep = null, ringRun = null) {
  const mine = ++turn;
  const overrides = Object.keys(state.overrides).length ? state.overrides : null;
  const checks = Object.keys(state.checks).length ? { levels: state.checks, kinds: null } : null;
  const judged = await ledger.verdict(state.task, state.a, state.b, null, rules.good_enough, rules.min_pairs, state.profile, overrides, checks);
  // where the kept panel is in the window, and the picture above it: both are put back so the page does not jump
  const held = keep && document.body.contains(keep) ? { top: keep.getBoundingClientRect().top, graph: $('pair-graph') } : null;
  if (judged.verdict === 'no data') {
    // the two have never met on this task: no verdict, and no pretending there is one
    const own = await ask(OWN_RECORD, { version: judged.version, a: state.a, b: state.b });
    if (mine !== turn) return null;
    drawNoRecord(judged, own);
  } else {
    const spec = await ledger.build({ ...judged, suite: null });
    if (mine !== turn) return null;
    drawVerdict(spec, judged);
  }
  shown.v = judged;
  if (held) {
    if (held.graph && $('pair-graph')) $('pair-graph').replaceWith(held.graph); // drawn again in place, below
    $('live').replaceWith(keep);
    window.scrollBy({ top: keep.getBoundingClientRect().top - held.top, behavior: 'instant' });
  }
  const at = ringRun ? (judged.rounds || []).findIndex((x) => x.run === ringRun) : -1;
  const drawn = drawPairGraph(judged, at < 0 ? null : at, at >= 0);
  $('step-verdict').hidden = false;
  if (!held) land(drawLive(judged), drawn, scroll, mine);
  return judged;
}

// Where the page comes to rest once the second model is picked. A visitor who can race live is brought to the
// run box, in the middle of the window (owner, 2026-11-26); anyone else, or a pair that cannot race live, to the
// top of the result. `live` settles once the run box has been drawn, true when it has a button in it; `graph`
// once the picture above it is in place, which is waited for (briefly) so the run box does not move after the
// page has come to rest on it.
async function land(live, graph, scroll, mine) {
  if (!scroll) return;
  const top = () => $('step-verdict').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (signInOutcome !== 'signed') return top();
  const offered = await live.catch(() => false);
  await Promise.race([graph.catch(() => {}), new Promise((done) => setTimeout(done, 2000))]);
  if (mine !== turn) return;
  if (offered && $('live-go')) follow($('live'), 'center');
  else top();
}

// What each of two models did on a task on its own account, whoever it played: for a pair that never met.
const OWN_RECORD = `MATCH (tv:TestVersion {key: $version})<-[:USED]-(mt:Match)<-[:IN]-(x:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded AND m.name IN [$a, $b]
RETURN m.name AS model, count(x) AS attempts, sum(CASE WHEN x.passed THEN 1 ELSE 0 END) AS passed,
       sum(CASE WHEN coalesce(x.task_correct, x.passed) THEN 1 ELSE 0 END) AS right,
       avg(x.cost_usd) AS cost_per_attempt`;

// Two models that have never met on this task: say so, show what each did against others, and leave the
// head-to-head to a match (a live race, for a signed-in visitor).
function drawNoRecord(v, own) {
  const row = (name) => {
    const r = own.find((x) => x.model === name);
    return el(
      'tr',
      null,
      el('th', { scope: 'row' }, modelLabel(name)),
      el('td', null, r ? `${r.right} of ${r.attempts} (${percent(r.right / r.attempts)})` : 'never played this task'),
      el('td', null, r ? `${r.passed} of ${r.attempts}` : '-'),
      el('td', null, r ? `$${fixed(r.cost_per_attempt, 4)}` : '-'),
    );
  };
  $('verdict-body').replaceChildren(
    el(
      'div',
      { class: 'band even', id: 'verdict-band' },
      el('p', { class: 'band-kind' }, 'No head-to-head yet'),
      el('p', { class: 'headline', id: 'verdict-headline' }, `${shortName(v.a)} and ${shortName(v.b)} have never met on this task, so there is no verdict.`),
      el('p', { class: 'small' }, 'A verdict needs the two models to play the same generated worlds. What each did against other opponents is below; it does not say which of these two does the task better.'),
      el('p', { class: 'small', id: 'band-live', hidden: true }),
    ),
    el(
      'table',
      { class: 'own' },
      el('caption', null, 'Each model\'s own record on this task, against other opponents'),
      el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Model'), el('th', { scope: 'col' }, 'Attempts with the right result'), el('th', { scope: 'col' }, 'Of those, clean runs'), el('th', { scope: 'col' }, 'Cost per attempt'))),
      el('tbody', null, row(v.a), row(v.b)),
    ),
    el('div', { id: 'pair-graph', class: 'pair-graph' }),
    el('div', { id: 'live', class: 'race live' }),
  );
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
    // a record that joined after the page was published has no file here: the live record makes the same one
    const response = await fetch(fromLive.has(run) ? `${liveRecord.address}/replay/${run}` : new URL(`./data/replays/${run}.json`, import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    replays.set(run, await response.json());
  }
  return replays.get(run);
}

// What each mark on a lane means. Shape says what the model did; colour is only for trouble.
function laneLegend() {
  const item = (cls, text) => el('span', null, el('span', { class: `tick ${cls}` }), text);
  return el(
    'p',
    { class: 'legend marks' },
    item('read', 'looked something up'),
    item('act', 'acted (changed something)'),
    item('check', 'checked its own action'),
    item('end', 'finished'),
    item('timeout', 'timed out'),
    item('again', 'did the same action again'),
    item('wrong', 'a wrong decision'),
    item('refused', 'the tool refused'),
  );
}

// The running counts of a lane: what the model has done so far, and any trouble, as it happens.
function laneCounts() {
  const part = (label, cls = '') => {
    const value = el('b', null, '0');
    const node = el('span', { class: `chip ${cls}`, hidden: Boolean(cls) }, value, ` ${label}`);
    return { node, value };
  };
  const parts = {
    steps: part('steps'),
    read: part('lookups'),
    act: part('actions'),
    check: part('checks'),
    timeout: part('timed out', 'warn'),
    again: part('acted again', 'warn'),
    wrong: part('wrong', 'bad'),
    refused: part('refused', 'bad'),
  };
  const node = el('span', { class: 'gauges counts' }, Object.values(parts).map((x) => x.node));
  // kinds: the kind of every step so far, in order
  const show = (kinds) => {
    parts.steps.value.textContent = String(kinds.length);
    for (const kind of ['read', 'act', 'check', 'timeout', 'again', 'wrong', 'refused']) {
      // a repeated or wrong action is still an action; a timed-out or refused step was an attempt to act
      const n = kinds.filter((k) => k === kind || (kind === 'act' && ['again', 'wrong'].includes(k))).length;
      parts[kind].value.textContent = String(n);
      if (parts[kind].node.classList.length > 1) parts[kind].node.hidden = n === 0;
    }
  };
  return { node, show };
}

// One lane of the race: the track with a mark per step, what the model is doing now, and four running gauges
// (the parts of the efficiency score). Returns how to draw it at a given second.
function raceLane(id, cls, line, tools, span) {
  const track = el('div', { class: 'track' });
  const kinds = [];
  const counts = laneCounts();
  const marks = line.steps.map(([at, tool, item, kind, state, mark]) => {
    const what = mark === 'wrong' ? 'wrong' : state === 1 ? 'timeout' : state === 2 ? 'refused' : mark === 'repeat' ? 'again' : kind;
    kinds.push(what);
    const said = `${fixed(at, 1)}s: ${stepWords(tools[tool], item)}${STATE_WORDS[state]}${mark === 'wrong' ? ': the wrong decision' : mark === 'repeat' ? ' (again)' : ''}`;
    return track.appendChild(el('span', { class: `tick ${what}`, style: `left:${(100 * at) / span}%`, title: said, hidden: true }));
  });
  const now = el('p', { class: 'now' }, 'Waiting to start.');
  const gauge = (label) => {
    const value = el('b', null, '0');
    return [el('span', { class: 'gauge' }, value, ` ${label}`), value];
  };
  const [gTime, vTime] = gauge('seconds');
  const [gCost, vCost] = gauge('spent');
  const [gTokens, vTokens] = gauge('tokens');
  const result = el('p', { class: 'outcome', hidden: true });
  const faults = Object.entries(line.faults);
  // a replay made before `right` was written (one read from an older live record) says it by its counts
  const right = line.right ?? (line.items ? line.correct === line.items : line.passed);
  result.append(
    endMark(endOf(right, line.passed)),
    line.items ? ` · ${line.correct} of ${line.items} items right` : '',
    faults.length ? ` · ${faults.map(([name, n]) => `${name}${n > 1 ? ` ×${n}` : ''}`).join(', ')}` : ' · no faults',
  );
  const node = el(
    'div',
    { class: `lane ${cls}` },
    el('div', { class: 'lane-head' }, el('span', { class: 'name' }, shortName(id)), counts.node, el('span', { class: 'gauges' }, gTime, gCost, gTokens)),
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
    counts.show(kinds.slice(0, shown));
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
  const finish = el('p', { class: 'finish', id: 'race-finish', hidden: true }, round.winner === 'tie' ? 'This scenario was a tie.' : `${shortName(round.winner)} took this scenario: ${whyTaken(round, a).text}.`);
  const play = el('button', { type: 'button', id: 'race-play' }, 'Play');
  racePicture = null;
  raceClock = () => clock;
  const paint = () => {
    const done = lanes.map((lane) => lane.draw(clock)).every(Boolean);
    if (racePicture) racePicture.update(clock);
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
    laneLegend(),
    ...lanes.map((lane) => lane.node),
    finish,
    el('div', { id: 'same-world', class: 'same-world' }),
  );
  drawPairGraph(v, index);
  drawSameWorld(v, index);
  if (still) {
    clock = span;
    paint();
  } else start();
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---- one scenario's world as a picture ------------------------------------------------------------------------

const worlds = new Map(); // scenario -> its world as the graph gives it (ledger.sameWorld), asked once

// Loads one scenario's steps into the graph (if they are not there yet) and reads its world back: the records,
// how they refer to each other, what each model decided and when it first saw each record. Null when the
// scenario has no steps (a race run in this tab, until it is imported).
function worldOf(match) {
  if (!worlds.has(match)) {
    worlds.set(
      match,
      (async () => {
        await loadSteps([match]);
        const before = performance.now();
        const [world] = await ledger.sameWorld([match]);
        return world ? { world, ms: performance.now() - before } : null;
      })(),
    );
  }
  return worlds.get(match);
}

// The picture: the world's records as nodes, in columns by how far they are from an item that gets decided, and
// linked as the world's own answers link them. On every link each model has its own line (the first model's
// above, the second's below), drawn from the moment that model read the record the link leads to: solid when it
// read it before deciding the item on that row, dashed when only afterwards, and red and dotted when it never
// did. A dot beside an item appears when the model decides it. `update(clock)` shows the picture as it stood
// `clock` seconds into the attempts, so it plays along with the race; Infinity shows how it ended.
function worldPicture(world, v) {
  const sideOf = Object.fromEntries(Object.entries(world.models).map(([side, model]) => [model, side]));
  const lanes = [['a', sideOf[v.a], v.a, -3], ['b', sideOf[v.b], v.b, 3]];
  const byId = new Map(world.records.map((r) => [r.id, r]));
  const referred = new Set(world.records.flatMap((r) => r.refers.map((x) => x.to)));
  const depth = new Map();
  let frontier = world.records.filter((r) => !referred.has(r.id)).map((r) => r.id);
  for (let d = 0; frontier.length && d < 6; d += 1) {
    const next = [];
    for (const id of frontier) {
      if (depth.has(id)) continue;
      depth.set(id, d);
      for (const x of (byId.get(id) || { refers: [] }).refers) if (!depth.has(x.to)) next.push(x.to);
    }
    frontier = next;
  }
  for (const r of world.records) if (!depth.has(r.id)) depth.set(r.id, 0);
  const columns = [];
  for (const r of world.records) (columns[depth.get(r.id)] ||= []).push(r.id);
  // which decided items a record belongs to (the rows it is drawn for)
  const roots = new Map(columns[0].map((id) => [id, [id]]));
  for (let d = 0; d < columns.length; d += 1) {
    for (const id of columns[d] || []) {
      for (const x of byId.get(id).refers) roots.set(x.to, [...new Set([...(roots.get(x.to) || []), ...(roots.get(id) || [])])]);
    }
  }
  // rows: the decided items in order; every later column sits where the records that refer to it sit
  const ROW = 26;
  const TOP = 34;
  const y = new Map();
  columns[0].sort().forEach((id, i) => y.set(id, TOP + i * ROW));
  for (let d = 1; d < columns.length; d += 1) {
    const wish = (id) => {
      const from = world.records.filter((r) => y.has(r.id) && r.refers.some((x) => x.to === id)).map((r) => y.get(r.id));
      return from.length ? from.reduce((sum, at) => sum + at, 0) / from.length : TOP;
    };
    const placed = columns[d].map((id) => [id, wish(id)]).sort((p, q) => p[1] - q[1] || (p[0] < q[0] ? -1 : 1));
    let last = -Infinity;
    for (const [id, at] of placed) {
      last = Math.max(at, last + ROW);
      y.set(id, last);
    }
  }
  const W = 720;
  const NODE = 96;
  const LEFT = 196; // room for what was decided, written beside each item
  const x = (d) => (columns.length < 2 ? LEFT : LEFT + (d * (W - LEFT - NODE / 2 - 12)) / (columns.length - 1));
  const H = Math.max(...y.values()) + 22;
  const decisions = new Map(); // item -> {a: its decision, b: its decision}
  for (const item of world.items) {
    decisions.set(item.item, Object.fromEntries(lanes.map(([cls, side]) => [cls, (item.sides[side] || {}).decision ? item.sides[side] : null])));
  }
  const timed = []; // [element, the second it appears]
  const show = (node, at) => {
    timed.push([node, at]);
    return node;
  };
  const marks = [];
  for (const r of world.records) {
    for (const link of r.refers) {
      if (!y.has(link.to)) continue;
      const from = { x: x(depth.get(r.id)) + NODE / 2, y: y.get(r.id) };
      const to = { x: x(depth.get(link.to)) - NODE / 2, y: y.get(link.to) };
      marks.push(svg('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: 'wbase' }));
      for (const [cls, side, model, shift] of lanes) {
        const decided = (roots.get(r.id) || []).map((root) => (decisions.get(root) || {})[cls]).filter(Boolean);
        if (!decided.length) continue; // this model decided nothing on this row
        const first = decided.reduce((p, q) => (q.step < p.step ? q : p));
        const seen = (world.seen[side] || {})[link.to];
        const state = !seen ? 'never' : seen.step < first.step ? 'before' : 'late';
        const words = { before: 'had read it before deciding', late: 'read it only after deciding', never: 'never read it' }[state];
        marks.push(
          show(
            svg('line', { x1: from.x, y1: from.y + shift, x2: to.x, y2: to.y + shift, class: `wl ${cls} ${state}` }, svg('title', null, `${shortName(model)} ${words}: ${link.to}`)),
            seen ? seen.at_s : first.at_s,
          ),
        );
      }
    }
  }
  const nodes = world.records.map((r) => {
    const at = { x: x(depth.get(r.id)), y: y.get(r.id) };
    const mine = decisions.get(r.id);
    const differ = mine && mine.a && mine.b && mine.a.decision !== mine.b.decision;
    const parts = [
      svg('rect', { x: at.x - NODE / 2, y: at.y - 10, width: NODE, height: 20, rx: 6, class: `wnode${differ ? ' differ' : ''}` }),
      svg('text', { x: at.x, y: at.y + 4, 'text-anchor': 'middle' }, r.id),
    ];
    if (mine) {
      for (const [cls, , model, shift] of lanes) {
        const did = mine[cls];
        if (!did) continue;
        const said = `${shortName(model)}: ${stepWords(did.decision)} at step ${did.step}`;
        parts.push(show(svg('circle', { cx: at.x - NODE / 2 - 9, cy: at.y + shift * 1.6, r: 3.6, class: `wdec ${cls}` }, svg('title', null, said)), did.at_s));
        // what it decided, in its own colour when the two differ and once in plain ink when they agree
        if (differ) parts.push(show(svg('text', { x: at.x - NODE / 2 - 18, y: at.y + (cls === 'a' ? -2 : 10), 'text-anchor': 'end', class: `wsaid ${cls}` }, stepWords(did.decision)), did.at_s));
      }
      if (!differ && (mine.a || mine.b)) {
        const one = mine.a && mine.b ? (mine.a.at_s <= mine.b.at_s ? mine.a : mine.b) : mine.a || mine.b;
        parts.push(show(svg('text', { x: at.x - NODE / 2 - 18, y: at.y + 4, 'text-anchor': 'end', class: 'wsaid' }, stepWords(one.decision)), one.at_s));
      }
    }
    return parts;
  });
  const heads = columns.map((ids, d) => {
    const kinds = [...new Set(ids.map((id) => byId.get(id).kind))];
    // the last column's heading ends at the picture's edge, so a long one ("customers and skus") is not cut off
    const last = d === columns.length - 1 && d > 0;
    return svg('text', { x: last ? x(d) + NODE / 2 : x(d), y: 14, 'text-anchor': last ? 'end' : 'middle', class: 'whead' }, kinds.map((k) => `${k}s`).join(' and '));
  });
  const figure = el(
    'figure',
    { class: 'world' },
    svg(
      'svg',
      { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `The world of this scenario as a graph: ${plural(world.records.length, 'record')} and the links between them, with what each model had read when it decided.` },
      heads,
      marks,
      nodes,
    ),
    el(
      'figcaption',
      null,
      el('span', { class: 'wkey' }, svg('svg', { viewBox: '0 0 34 10', class: 'wsample' }, svg('line', { x1: 1, y1: 3, x2: 33, y2: 3, class: 'wl a before' }), svg('line', { x1: 1, y1: 8, x2: 33, y2: 8, class: 'wl b before' })), ` ${shortName(v.a)} above, ${shortName(v.b)} below: had read the record before deciding that row`),
      el('span', { class: 'wkey' }, svg('svg', { viewBox: '0 0 34 10', class: 'wsample' }, svg('line', { x1: 1, y1: 5, x2: 33, y2: 5, class: 'wl a late' })), ' read it only after deciding'),
      el('span', { class: 'wkey' }, svg('svg', { viewBox: '0 0 34 10', class: 'wsample' }, svg('line', { x1: 1, y1: 5, x2: 33, y2: 5, class: 'wl never' })), ' never read it'),
    ),
  );
  const update = (clock) => {
    for (const [node, at] of timed) node.toggleAttribute('hidden', at > clock);
  };
  return { node: figure, update };
}

let racePicture = null; // the picture under the race on screen, played along with it
let raceClock = () => Infinity; // how far that race has got, in seconds

// Under a replay: that scenario's world as a graph with both routes drawn on it, played along with the race, and
// the same thing item by item as a table.
async function drawSameWorld(v, index) {
  const box = $('same-world');
  if (!box) return;
  const round = v.rounds[index];
  box.replaceChildren(el('p', { class: 'note' }, 'Loading both routes into the graph…'));
  let found;
  let needs;
  try {
    found = await worldOf(round.match);
    needs = await ledger.whatDecisionsNeed(v.version);
  } catch (error) {
    box.replaceChildren(el('p', { class: 'note' }, `The steps of this scenario could not be read (${error.message}).`));
    return;
  }
  if ($('same-world') !== box) return;
  if (!found) {
    box.replaceChildren(el('p', { class: 'note' }, 'The steps of this scenario are not in the graph yet: a race run in this tab joins them once it is imported.'));
    return;
  }
  const { world, ms } = found;
  const sideOf = Object.fromEntries(Object.entries(world.models).map(([side, model]) => [model, side]));
  const cell = (side) => {
    if (!side || !side.decision) return el('span', { class: 'note' }, 'left undone');
    const seen = side.needs.filter((n) => n.seen).map((n) => n.kind);
    return [
      el('span', { class: 'did' }, stepWords(side.decision), side.state === 'timeout' ? ' (timed out)' : ''),
      el('span', { class: 'note' }, ` at step ${side.step}`),
      el('br'),
      seen.length ? el('span', { class: 'note' }, `had seen the ${seen.join(' and the ')} `) : null,
      side.needs.filter((n) => !n.seen).map((n) => el('span', { class: 'chip bad', title: n.record }, `had not seen the ${n.kind}`)),
    ];
  };
  const unseen = (model) => world.decided_unseen[sideOf[model]] || 0;
  const differ = world.decided_differently.length;
  const picture = worldPicture(world, v);
  racePicture = picture;
  picture.update(raceClock());
  box.replaceChildren(
    el('h4', { class: 'pair-graph-title' }, el('span', { class: 'relate-badge' }, 'Relate graph'), ' The same world, two routes'),
    el(
      'p',
      { class: 'note' },
      'Every step of this scenario is in the graph, linked to the record it read or decided, and both models walked the same records. ',
      needs.length ? `Here ${needsWords(needs)}. ` : '',
      'The picture fills in as the race plays: a line is drawn when a model reads a record, a dot when it decides.',
    ),
    picture.node,
    el(
      'p',
      { class: 'finish', id: 'same-world-sum' },
      `They decided differently on ${differ} of ${plural(world.items.length, 'item')}. `,
      `Decided before seeing a record the item depends on: ${shortName(v.a)} ${unseen(v.a)}, ${shortName(v.b)} ${unseen(v.b)}.`,
    ),
    el(
      'p',
      { class: 'note small', id: 'same-world-stats' },
      `Read from the steps in the graph with one Cypher query: ${plural(world.items.length * 2, 'row')} · ${ms < 1 ? 'under 1' : Math.round(ms)} ms · run by Relate in this browser tab.`,
    ),
    el(
      'details',
      { class: 'graph-query' },
      el('summary', null, 'Show it item by item'),
      el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          { class: 'stack routes' },
          el('thead', null, el('tr', null, el('th', { scope: 'col' }, sentence((world.items[0] || {}).kind || 'item')), el('th', { scope: 'col', class: 'a' }, shortName(v.a)), el('th', { scope: 'col', class: 'b' }, shortName(v.b)))),
          el(
            'tbody',
            null,
            world.items.map((item) =>
              el(
                'tr',
                { class: item.differ ? 'differ' : null },
                el('td', { class: 'lead' }, item.item, item.differ ? el('span', { class: 'chip warn' }, 'decided differently') : null),
                el('td', { 'data-label': shortName(v.a) }, cell(item.sides[sideOf[v.a]])),
                el('td', { 'data-label': shortName(v.b) }, cell(item.sides[sideOf[v.b]])),
              ),
            ),
          ),
        ),
      ),
    ),
    el('details', { class: 'graph-query' }, el('summary', null, 'Show the query'), el('pre', null, questionsText.same_world.trim())),
  );
}

// "each refund request refers to its order (order_id); ...": what a decision depends on, in words (cli.needs_line).
const needsWords = (needs) => needs.map((n) => `each ${n.decided} refers to its ${n.needs} (${n.via.join(' > ')})`).join('; ');

// ---- how they got there: process questions asked of every step on file ----------------------------------------

const worked = new Map(); // task and pair -> what the steps said (the counts do not depend on the levels chosen)
const NOT_COUNTED = 'not counted';
const checkOfFault = (fault) => Object.keys(rules.step_checks).find((name) => `${rules.step_checks[name].fault} (your check)` === fault) || null;

function setCheck(name, level) {
  const next = { ...state.checks };
  if (level === NOT_COUNTED) delete next[name];
  else next[name] = level;
  state.checks = next;
  showVerdict();
}

// The panel in step 3. Until asked it only says what it would do; asking loads the steps of every scenario of
// this task into the graph (some seconds) and then each question is one Cypher pattern over them.
function workedPanel(v) {
  const key = `${v.task}|${v.a}|${v.b}`;
  const box = el('section', { id: 'worked', class: 'pair-graph worked' });
  const head = el('h3', { class: 'pair-graph-title' }, el('span', { class: 'relate-badge' }, 'Relate graph'), ' How they got there');
  const draw = (found) => {
    const row = (c, m) =>
      el(
        'li',
        { class: m.model === v.a ? 'a' : 'b' },
        el('strong', null, shortName(m.model)),
        `: in ${m.attempts_with} of ${plural(m.attempts, 'attempt')}`,
        m.attempts_with ? ` (${plural(m.times, 'time')}). ${m.right_with} of those still got every decision right, and ${m.passed_with} were counted as clean runs by the test.` : '.',
        c.grader_counts ? ` The grader counted ${m.grader_attempts_with || 0}.` : '',
      );
    box.replaceChildren(
      head,
      el(
        'p',
        { class: 'note' },
        `Every step of every scenario of this task is now in the graph. ${found.decisions_need.length ? `Here ${needsWords(found.decisions_need)}. ` : ''}`,
        'Each question below is one pattern over those steps. A count is a fact, not a fault: say how serious it is for you and the verdict above is judged with it.',
      ),
      ...found.checks.map((c) =>
        el(
          'div',
          { class: 'question', 'data-check': c.check },
          el('h4', null, c.asks),
          c.note ? el('p', { class: 'note small' }, c.note) : null,
          el('ul', { class: 'who' }, c.models.map((m) => row(c, m))),
          el(
            'label',
            { class: 'note' },
            'For you this is ',
            el(
              'select',
              { class: `own-level ${state.checks[c.check] || ''}`, 'aria-label': `How serious is this for you: ${c.asks}`, onchange: (event) => setCheck(c.check, event.target.value) },
              [NOT_COUNTED, ...rules.policy.levels].map((level) => el('option', { value: level, selected: level === (state.checks[c.check] || NOT_COUNTED) }, level)),
            ),
          ),
          el('details', { class: 'graph-query' }, el('summary', null, 'Show the query'), el('pre', null, c.cypher)),
        ),
      ),
      ...(found.not_loaded ? [el('p', { class: 'note small' }, `${plural(found.not_loaded, 'scenario')} had no steps to load (a race run in this tab joins them once it is imported).`)] : []),
    );
  };
  if (worked.has(key)) {
    draw(worked.get(key));
    return box;
  }
  const note = el('span', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const go = el('button', { type: 'button', id: 'worked-go' }, 'Ask the steps');
  go.addEventListener('click', async () => {
    go.disabled = true;
    note.textContent = ' Loading the steps into the graph…';
    stepProgress = (done, total) => {
      note.textContent = ` Loading the steps into the graph: ${done} of ${plural(total, 'scenario')}…`;
    };
    try {
      const found = await ledger.process(v.task, v.a, v.b);
      worked.set(key, found);
      if ($('worked') === box) draw(found);
    } catch (error) {
      note.textContent = ` The steps could not be read (${error.message}).`;
      go.disabled = false;
    } finally {
      stepProgress = null;
    }
  });
  box.replaceChildren(
    head,
    el(
      'p',
      { class: 'note' },
      'The verdict above counts how each attempt ended. The sealed records also keep every step: which record each model read, and what it decided, in order. ',
      'Load them into the graph and ask how these two worked: did either decide an item before it had seen a record that item depends on, or repeat an action without checking? ',
      'It takes some seconds, and nothing is re-run.',
    ),
    el('p', null, go, note),
  );
  return box;
}

const shown = { v: null }; // the verdict on screen, when there is one

async function timed(query, params) {
  const before = performance.now();
  const rows = await ask(query, params);
  return { rows: rows.length, ms: performance.now() - before };
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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// When a sealed record was started, from its id (which is that moment, in UTC), and what kind of record it is.
function runWhen(run) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(String(run));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[4]}:${m[5]}` : String(run);
}
const runKind = (suite) => (suite === 'live-race' ? 'live race' : suite === 'live-batch' ? 'live batch' : 'suite match');

// The picture is drawn top down: the test version, then one row per sealed match record (a Run) with one cell per
// scenario both models played in it (a Match), then the two models. A cell's two halves are the two attempts of
// that scenario and say how each ended: a clean run, the right result with a step skipped, or a wrong result;
// a dot marks the half that took the scenario. Every scenario is linked to the version above and to both models
// below. The picture draws those links once per row (the rails at the sides) and not once per scenario, so
// seventy scenarios stay seventy things a visitor can point at and pick (owner, 2026-11-26: the old picture drew
// three lines per scenario and nobody could select one on purpose). `ring` marks one scenario: the one just
// watched, or just run. Live results the record does not hold yet are a row of their own, dashed, and counted
// in no verdict.
async function evidenceGraph(v, ring = null, justRan = false) {
  const live = await ask(LIVE_BETWEEN, { version: v.version, a: v.a, b: v.b });
  const rounds = v.rounds || [];
  const n = rounds.length;
  const rows = []; // one per sealed record, in the order of the rounds
  rounds.forEach((r, index) => {
    const last = rows[rows.length - 1];
    if (last && last.run === r.run) last.cells.push({ r, index });
    else rows.push({ run: r.run, suite: r.suite, cells: [{ r, index }] });
  });
  const idle = n ? 'Point at a scenario to read what happened in it. Click it to watch both models work it, step by step.' : '';
  const tip = el('p', { class: 'gtip', id: 'graph-tip', role: 'status', 'aria-live': 'polite' }, idle);
  const say = (text) => (tip.textContent = text);
  const half = (side, right, clean) => el('i', { class: `half ${side} ${endOf(right, clean)}` });
  const cell = ({ r, index }, row) => {
    const who = r.winner === v.a ? 'a' : r.winner === v.b ? 'b' : 'tie';
    const text =
      `Scenario ${index + 1} of ${n}, in the ${runKind(row.suite)} of ${runWhen(row.run)} UTC: ` +
      `${who === 'tie' ? 'a tie' : `taken by ${shortName(r.winner)} (${whyTaken(r, v.a).text})`}. ` +
      `${shortName(v.a)}: ${ended(r.a_right, r.a_passed)}. ${shortName(v.b)}: ${ended(r.b_right, r.b_passed)}.`;
    return el(
      'button',
      { type: 'button', class: `gdot ${who}${index === ring ? ' ring' : ''}`, title: `${text} Click to watch it.`, 'aria-label': `${text} Watch the replay.`, 'data-scenario': index + 1, onclick: () => openRace(v, index), onmouseenter: () => say(text), onfocus: () => say(text) },
      half('a', r.a_right, r.a_passed),
      half('b', r.b_right, r.b_passed),
    );
  };
  const rowOf = (row) =>
    el(
      'div',
      { class: 'grow', 'data-run': row.run },
      el('div', { class: 'grun', title: `Sealed record ${row.run}` }, el('b', null, runWhen(row.run)), ` · ${runKind(row.suite)}`, el('br'), plural(row.cells.length, 'scenario'), row.cells.some((c) => c.index === ring) ? (justRan ? ' · just run' : ' · being watched') : ''),
      el('div', { class: 'gcells' }, row.cells.map((c) => cell(c, row))),
    );
  const liveRow = live.length
    ? el(
        'div',
        { class: 'grow live' },
        el('div', { class: 'grun' }, el('b', null, plural(live.length, 'live race')), el('br'), 'not in the record yet'),
        el(
          'div',
          { class: 'gcells' },
          live.map((l) => el('span', { class: `gdot live ${l.winner === v.a ? 'a' : l.winner === v.b ? 'b' : 'tie'}`, title: `Live race ${l.run}: sealed, and not in the record yet, so no verdict counts it.` })),
        ),
      )
    : null;
  const key = (cls, text) => el('span', null, el('i', { class: `gkey ${cls}` }), text);
  return el(
    'figure',
    { class: 'graph', role: 'group', 'aria-label': `The graph behind this verdict: ${plural(n, 'recorded scenario')} in ${plural(rows.length, 'sealed match record')}${live.length ? ` and ${live.length} live` : ''}, each linked to the test version and to both models.` },
    el('div', { class: 'gtop' }, el('span', { class: 'gnode task', title: v.version }, v.version.split('/').pop().split(':')[0])),
    el('div', { class: 'gstem', 'aria-hidden': 'true' }),
    el('div', { class: 'grows' }, el('span', { class: 'grail a', 'aria-hidden': 'true' }), el('span', { class: 'grail b', 'aria-hidden': 'true' }), rows.map(rowOf), liveRow, n || live.length ? null : el('p', { class: 'note' }, 'No recorded scenario links them yet.')),
    el('div', { class: 'gmodels' }, el('span', { class: 'gnode a' }, shortName(v.a), el('small', null, ' · top half')), el('span', { class: 'gnode b' }, shortName(v.b), el('small', null, ' · bottom half'))),
    n
      ? el(
          'p',
          { class: 'glegend' },
          key('clean', 'clean run'),
          key('skipped', 'right result, a step skipped'),
          key('wrong', 'wrong result'),
          key('took', 'took the scenario'),
          el('span', null, 'each row is one sealed match record'),
        )
      : null,
    tip,
    el(
      'figcaption',
      null,
      n
        ? 'Each cell is one scenario: a freshly generated world, handed to both models. Its top half is how the first model ended, its bottom half the second. A cell says who took the scenario, not who failed: a model can get every decision right and still lose it to a cleaner or cheaper run.'
        : 'The test version and the two models are in the graph, but no recorded scenario links them yet.',
      ring !== null ? (justRan ? ' The ringed one is the race you just ran: it joined the record a moment ago.' : ' The ringed one is the race you just watched.') : '',
      live.length ? ` The dashed ${live.length === 1 ? 'one is a live race' : 'ones are live races'} the record does not hold yet: in the graph as a different kind of node, so no verdict counts ${live.length === 1 ? 'it' : 'them'}.` : '',
    ),
  );
}

// The one home of that picture in step 3, labelled for what it is: a Relate graph, with the question it was read
// with and what came back. It is drawn again when a scenario is watched (ringed) and when live races join it.
async function drawPairGraph(v, ring = null, justRan = false) {
  const box = $('pair-graph');
  if (!box) return;
  const version = v.version !== 'all versions' ? v.version : await ledger.currentVersion(v.task);
  const query = questionsText.pair_on_task;
  const ran = await timed(query, { test_id: v.task, a: v.a, b: v.b, suite: null, version_key: version, conditions: v.conditions ?? null, until: null });
  const figure = await evidenceGraph(v, ring, justRan);
  if ($('pair-graph') !== box) return;
  box.replaceChildren(
    el('h3', { class: 'pair-graph-title' }, el('span', { class: 'relate-badge' }, 'Relate graph'), ' The evidence behind this answer'),
    figure,
    el(
      'p',
      { class: 'note small', id: 'graph-stats' },
      `Read from the graph with one Cypher query: ${plural(ran.rows, 'row')} · ${ran.ms < 1 ? 'under 1' : Math.round(ran.ms)} ms · run by `,
      el('a', { href: 'https://relatedb.ai', rel: 'noopener' }, 'Relate'),
      ' in this browser tab.',
    ),
    el('details', { class: 'graph-query' }, el('summary', null, 'Show the query'), el('pre', null, query.trim())),
    // the scenario picture under the dots: kept as it is when the box is drawn again (live races join the dots
    // above it), so the page below does not jump
    $('world-graph') || el('div', { id: 'world-graph', class: 'world-graph' }),
  );
  await drawWorldGraph(v, ring, justRan);
}

// Under the dots: one of them opened. The scenario just watched, or the first one, as a graph of its own: the
// records of that world and what each model had read when it decided. It is the same graph, one level down.
async function drawWorldGraph(v, ring = null, justRan = false) {
  const box = $('world-graph');
  const rounds = v.rounds || [];
  if (!box) return;
  if (!rounds.length) return box.replaceChildren();
  const index = ring ?? 0;
  const showing = `${rounds[index].match}|${ring === null}`;
  if (box.dataset.showing === showing && box.firstChild) return; // already drawn, as it should be
  let found;
  try {
    found = await worldOf(rounds[index].match);
  } catch {
    return; // the picture is an extra: without it the box is what it was
  }
  if ($('world-graph') !== box || !found) return;
  const { world } = found;
  const sideOf = Object.fromEntries(Object.entries(world.models).map(([side, model]) => [model, side]));
  const unseen = (model) => world.decided_unseen[sideOf[model]] || 0;
  const picture = worldPicture(world, v);
  picture.update(Infinity);
  box.dataset.showing = showing;
  for (const cell of document.querySelectorAll('#pair-graph .gdot.shown')) cell.classList.remove('shown');
  document.querySelector(`#pair-graph .gdot[data-scenario="${index + 1}"]`)?.classList.add('shown');
  box.replaceChildren(
    el('h4', { class: 'world-title' }, `One scenario, opened: scenario ${index + 1} of ${rounds.length}`),
    el(
      'p',
      { class: 'note small' },
      'Each scenario is a small world of linked records, and every step either model took in it is in the graph too. ',
      `In this one they decided differently on ${world.decided_differently.length} of ${plural(world.items.length, 'item')}, and decided before reading a record the item depends on: `,
      `${shortName(v.a)} ${unseen(v.a)}, ${shortName(v.b)} ${unseen(v.b)}. `,
      ring === null ? el('button', { type: 'button', class: 'quiet small', id: 'world-watch', onclick: () => openRace(v, index) }, 'Watch it fill in') : justRan ? 'This is the race you just ran, read from the graph a moment after it ended.' : 'It filled in below as the race played.',
    ),
    picture.node,
  );
}

// ---- a live race: one fresh scenario, played now by a Gladiator runner -------------------------------------------

// Where a runner is, if there is one: ?runner=<address> for a runner on your own machine, else the address the
// page was published with (site/data/live.json). No runner means no live races, and the page says so.
let runnerPromise;
let wantsRunner = false; // set when the visitor asks to sign in from the page
const askedRunner = new URLSearchParams(location.search).get('runner');
let basePromise;
function runnerAddress() {
  basePromise ||= (async () => askedRunner || (await published()).runner || null)();
  return basePromise;
}
function findRunner() {
  runnerPromise ||= (async () => {
    const asked = askedRunner;
    let base = await runnerAddress();
    if (!base) return null;
    // The published runner is only contacted for a visitor who asks to sign in, holds an invitation or is
    // already signed in. Everyone else's page stays inside its own folder: nothing is sent anywhere, and
    // the runner is not woken.
    if (!asked && !wantsRunner && !new URLSearchParams(location.search).get('invite') && !stored.get()) return null;
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
  const count = { time: el('b', null, '0'), cost: el('b', null, '$0.0000'), tokens: el('b', null, '0') };
  const counts = laneCounts();
  const kinds = [];
  const result = el('p', { class: 'outcome', hidden: true });
  const node = el(
    'div',
    { class: `lane ${cls}` },
    el(
      'div',
      { class: 'lane-head' },
      el('span', { class: 'name' }, shortName(id)),
      counts.node,
      el('span', { class: 'gauges' }, el('span', { class: 'gauge' }, count.time, ' seconds'), el('span', { class: 'gauge' }, count.cost, ' spent'), el('span', { class: 'gauge' }, count.tokens, ' tokens')),
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
      kinds.push(what);
      counts.show(kinds);
      marks.push([mark, e.elapsed_s]);
      while (e.elapsed_s > span * 0.92) span *= 1.5;
      place();
      cost += e.cost_usd;
      tokens += e.tokens;
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
        endMark(details.items || e.passed ? endOf(rightResult(details), e.passed) : 'none'),
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
let signInOutcome = 'none'; // 'signed' | 'refused' (the runner said no) | 'unreachable' | 'none' (nothing to sign in with)
function signIn(runner, again = false, typed = null) {
  if (again) sessionPromise = null;
  sessionPromise ||= (async () => {
    if (!runner.options.needs_code) {
      signInOutcome = 'signed';
      smallPrint();
      return { token: null, races_left: null };
    }
    const post = async (ask) => {
      const response = await fetch(`${runner.base}/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ask) });
      return response.ok ? response.json() : null;
    };
    const url = new URL(location.href);
    const invite = typed || url.searchParams.get('invite');
    let session = null;
    const tried = Boolean(invite || stored.get());
    try {
      if (invite) {
        session = await post({ invite });
        if (url.searchParams.has('invite')) {
          url.searchParams.delete('invite');
          history.replaceState(null, '', url); // the invite is spent: do not leave it in the address bar or history
        }
      }
      if (!session && stored.get()) session = await post({ token: stored.get() });
    } catch {
      signInOutcome = 'unreachable';
      smallPrint();
      return null; // the runner did not answer
    }
    stored.set(session ? session.token : null);
    signInOutcome = session ? 'signed' : tried ? 'refused' : 'none';
    smallPrint();
    return session;
  })();
  return sessionPromise;
}

// A visitor who arrives by an invitation link (or comes back signed in) is told at once, at the top of the
// page, whether live races are open to them. A link that was not accepted says so: it never quietly turns
// into the public page.
// The small print at the foot says what is true of the page as this visitor has it: the public page only reads
// recorded matches; a signed-in visitor can start live runs that call real models and spend real money.
function smallPrint() {
  const foot = $('foot-view');
  if (!foot) return;
  foot.textContent =
    signInOutcome === 'signed'
      ? `You are signed in for live runs. The verdict in step 3 rests on recorded matches: finished, sealed and replayable here, read locally in this browser tab. A live race or batch you start is different: it is sent to a Gladiator runner, which calls the real models and spends real money from the live budgets shown beside the button. What goes to the runner is the task, the two models, the settings and your sign-in; nothing else. ${
          liveRecord.address
            ? 'Each live result is sealed, and joins the record as soon as the runner has filed it: Ledger’s live record takes it in, this page loads it into its graph, and the verdict is read again.'
            : 'Each live result is sealed and shown beside the record at once; it is counted in the verdict once it has been imported into the record, which happens in batches, not instantly.'
        } A verdict counts the races played under its own conditions: one you start at another difficulty or scoring is kept on file, and the verdict says so and leaves it out.`
      : `Every verdict on this page rests on recorded matches: finished, sealed and replayable here. The page reads them locally in this browser tab, needs no key and sends nothing you type anywhere.${
          liveRecord.address ? ' Matches newer than the page are fetched from Ledger’s live record, a plain read of public records, and join the same graph in this tab.' : ''
        } This view cannot start a match. Live races run on a separate Gladiator runner and are open to the hackathon judges for now (Judge sign-in, at the top).`;
}

async function announceLive() {
  const banner = $('live-banner');
  const runner = await findRunner();
  if (!runner) return; // an ordinary visit: nothing to announce, nothing contacted
  const show = (text, refused = false, signedIn = false) => {
    banner.replaceChildren(text);
    if (signedIn && runner.options.needs_code) banner.append(el('button', { type: 'button', id: 'judge-out', class: 'quiet small', onclick: signOut }, 'Sign out'));
    banner.classList.toggle('refused', refused);
    banner.hidden = false;
    $('judge-open').hidden = signedIn;
  };
  if (!runner.options) {
    show(`Live races: the race runner at ${runner.base} is not answering right now. Recorded races still play. Reload the page to try again.`, true);
    return;
  }
  const session = await signIn(runner);
  if (session) {
    // the cards in step 2 can now say which models race live
    liveModels = new Set(runner.options.models);
    if (state.task) drawFirst();
    if (state.a) drawSecond();
    const left = session.races_left === null || session.races_left === undefined ? '' : ` ${plural(session.races_left, 'live race')} left on this sign-in.`;
    show(`You are signed in for live races.${left} Pick a workflow and two models marked "can race live", then press "Race them live".`, false, true);
  } else if (signInOutcome === 'refused') {
    show('This invitation link was not accepted by the race runner, so you are seeing the public page. Check that the link is complete and exactly as it was given to you. Recorded races still play.', true);
  } else if (signInOutcome === 'unreachable') {
    show('Live races: the race runner could not be reached to sign you in. Recorded races still play. Reload the page to try again.', true);
  }
}

// Back to the public page: forget the session and stop contacting the runner.
function signOut() {
  stored.set(null);
  sessionPromise = null;
  runnerPromise = null;
  wantsRunner = false;
  signInOutcome = 'none';
  smallPrint();
  liveModels = null;
  if (state.task) drawFirst();
  if (state.a) drawSecond();
  $('live-banner').hidden = true;
  $('judge-open').hidden = false;
  if (!$('step-verdict').hidden) showVerdict();
}

// Five characters of a code's SHA-256: enough to tell two codes apart, far too little to find one.
async function fingerprint(text) {
  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 5);
  } catch {
    return 'not available';
  }
}

// The sign-in box: a button on the public page opens it, and the code typed there signs this browser in.
// Nothing is sent to the runner until a code is submitted.
async function setUpSignIn() {
  const open = $('judge-open');
  const dialog = $('judge-dialog');
  const note = $('judge-note');
  if (!(await runnerAddress())) return; // no runner is published: nothing to sign in to
  open.hidden = Boolean(stored.get()) || new URLSearchParams(location.search).has('invite');
  open.addEventListener('click', () => {
    note.textContent = '';
    $('judge-code').value = '';
    dialog.showModal();
    $('judge-code').focus();
  });
  $('judge-cancel').addEventListener('click', () => dialog.close());
  $('judge-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = $('judge-code').value.trim();
    if (!code) return;
    $('judge-go').disabled = true;
    note.textContent = 'Checking the code…';
    try {
      wantsRunner = true;
      runnerPromise = null; // look the runner up again, this time contacting it
      const runner = await findRunner();
      if (!runner || !runner.options) {
        note.textContent = 'The race runner is not answering right now. Try again in a moment.';
        return;
      }
      const session = await signIn(runner, true, code);
      if (!session) {
        if (signInOutcome === 'unreachable') note.textContent = 'The race runner could not be reached. Try again in a moment.';
        else {
          // say what was received, without repeating it: its length, and five characters of its hash, which the
          // person who issued the codes can compare with the ones on file
          note.textContent = `That code was not accepted. You entered ${plural(code.length, 'character')} (fingerprint ${await fingerprint(code)}). A code is one unbroken run of letters, digits, - and _, with nothing before or after it.`;
        }
        return;
      }
      dialog.close();
      await announceLive();
      if (!$('step-verdict').hidden) showVerdict(); // a result is already on screen: give it its live panel
    } finally {
      $('judge-go').disabled = false;
    }
  });
}

const providerName = (id) => ({ openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' })[id] || id;

// The live panel under the arena: what the record expects, then a fresh scenario raced now, then how it compares.
async function drawLive(v) {
  const box = $('live');
  if (!box) return;
  const runner = await findRunner();
  if ($('live') !== box) return; // the verdict was redrawn while we looked
  const title = el('h4', null, 'Race them live on a fresh scenario');
  const soon = 'Live races are open to the hackathon judges for now (Judge sign-in, at the top of the page), and coming soon for everyone. Every scenario above is a real recorded race you can replay.';
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
  // The live race is between the two models chosen in step 2: the page has one place to choose a pair, and every
  // part of it is about that pair. If one of them is not on the live list, there is no race to offer, and the
  // panel says which models can be raced.
  const [a, b] = [v.a, v.b];
  const missing = [a, b].filter((m) => !models.includes(m));
  if (missing.length) {
    box.replaceChildren(
      title,
      el(
        'p',
        { class: 'note', id: 'live-absent' },
        `${missing.map(shortName).join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not on the live list, so this pair cannot be raced live. `,
        'To race live, pick two models marked "can race live" in step 2: ',
        models.map(shortName).join(', '),
        '.',
      ),
    );
    return;
  }
  const level = el('select', { id: 'live-level', 'aria-label': 'Difficulty' }, offered.levels.map((x) => el('option', { value: x, selected: x === 'standard' }, `${x} difficulty`)));
  const profile = el('select', { id: 'live-profile', 'aria-label': 'What matters most' }, runner.options.profiles.map((x) => el('option', { value: x, selected: x === 'budget' }, `${x} scoring`)));
  const go = el('button', { type: 'button', id: 'live-go' }, 'Race them live');
  const pick = (label, select) => el('label', { class: 'pick' }, el('span', null, label), select);
  // Batches, where the runner offers them: the same test many times in one go, by the pair or by one of the two
  // on both lanes. The bigger sizes are shown as what is coming, never as something to press.
  const sizes = runner.options.batches || [];
  const runsPick = el(
    'select',
    { id: 'live-runs', 'aria-label': 'How many scenarios' },
    el('option', { value: 1, selected: true }, '1 scenario: watch every step'),
    sizes.map((x) => el('option', { value: x.runs }, `${x.runs} scenarios in one batch (cap $${fixed(x.cap_usd, 2)})`)),
    el('option', { disabled: true }, '100 scenarios: coming soon'),
    el('option', { disabled: true }, '10,000 scenarios: enterprise, with your own keys'),
  );
  const whoPick = el(
    'select',
    { id: 'live-who', 'aria-label': 'Who plays' },
    el('option', { value: 'pair', selected: true }, `${shortName(v.a)} vs ${shortName(v.b)}`),
    el('option', { value: 'a' }, `${shortName(v.a)} on both lanes: how steady is it?`),
    el('option', { value: 'b' }, `${shortName(v.b)} on both lanes: how steady is it?`),
  );
  const batchBox = el('div', { id: 'live-batch' });
  // What the record already says about each of the two on this task, whoever they played: how often it passed and
  // what an attempt cost. A model far below the pass rate the task needs is flagged before any money is spent,
  // and the same figures give the expected cost of the run about to start.
  const expect = el('p', { class: 'note', id: 'live-expect' });
  const ownVersion = v.version !== 'all versions' ? v.version : await ledger.currentVersion(v.task);
  let ownRows = await ask(OWN_RECORD, { version: ownVersion, a: v.a, b: v.b });
  const ownOf = (m) => ownRows.find((x) => x.model === m);
  const showExpect = () => {
    const runs = Number(runsPick.value);
    const [ma, mb] = whoPick.value === 'a' ? [v.a, v.a] : whoPick.value === 'b' ? [v.b, v.b] : [v.a, v.b];
    const parts = [...new Set([ma, mb])].map((m) => {
      const o = ownOf(m);
      if (!o) return el('span', null, `${shortName(m)} has no record on this task, so there is nothing to go on yet. `);
      // the result is what fitness asks for; the test's own pass (result and process) is what a batch's early stop counts
      const rate = o.right / o.attempts;
      const weak = o.attempts >= 5 && rate < rules.good_enough;
      const stopAt = runner.options.batch_pass_rate;
      const stops = !weak && runs > 1 && stopAt && o.attempts >= 5 && o.passed / o.attempts < stopAt;
      return el(
        'span',
        weak ? { class: 'expect-weak' } : null,
        `${shortName(m)} got the right result in ${o.right} of ${o.attempts} recorded attempts on this task (${percent(rate)}) and ran it clean in ${o.passed}, at about $${fixed(o.cost_per_attempt, 4)} an attempt`,
        weak
          ? `: well short of the ${percent(rules.good_enough)} this page asks of a model, so expect wrong results in most scenarios. `
          : stops
            ? `. The early stop counts clean runs (the right result and every step the test asks for), so with it on, this batch is likely to end before its last scenario. `
            : '. ',
      );
    });
    const known = [ma, mb].map(ownOf);
    const cost = known.every(Boolean) ? known.reduce((sum, o) => sum + o.cost_per_attempt * runs, 0) : null;
    const cap = runs > 1 ? (sizes.find((x) => x.runs === runs) || {}).cap_usd : runner.options.cap_usd_per_race;
    expect.replaceChildren(
      el('strong', null, 'Before you run: '),
      ...parts,
      cost === null ? '' : `At those rates this run should cost about $${fixed(cost, 2)}`,
      cost !== null && cap ? ` (hard cap $${fixed(cap, 2)}${cost > cap * 0.8 ? ': close to the cap, so some scenarios may not be played' : ''}).` : cost !== null ? '.' : '',
    );
  };
  const filed = el('div', { id: 'live-batches', class: 'live-history', hidden: true });
  // What pressing the button will run, in words, right beside it: two dropdowns side by side are easy to mix up,
  // and one model on both lanes is a different thing from the match a visitor usually means to run.
  const what = el('p', { class: 'live-what', id: 'live-what' });
  const relabel = () => {
    // one model against itself needs a batch: one run cannot show steadiness
    if (whoPick.value !== 'pair' && Number(runsPick.value) === 1 && sizes.length) runsPick.value = String(sizes[0].runs);
    const runs = Number(runsPick.value);
    const alone = whoPick.value === 'pair' ? null : whoPick.value === 'a' ? v.a : v.b;
    go.textContent = runs > 1 ? `Run the batch of ${runs}${alone ? `: ${shortName(alone)} against itself` : ''}` : 'Race them live';
    what.replaceChildren(
      'This will run: ',
      el('strong', null, `${runs === 1 ? '1 new scenario' : `${runs} new scenarios`}, ${alone ? `${shortName(alone)} on both lanes` : `${shortName(v.a)} against ${shortName(v.b)}`}`),
      alone ? '. That is a steadiness check of one model, not a match between the two: nothing in it counts as a win.' : '.',
    );
    what.classList.toggle('alone', Boolean(alone));
    showExpect();
  };
  relabel();
  runsPick.addEventListener('change', () => {
    if (Number(runsPick.value) === 1) whoPick.value = 'pair';
    relabel();
  });
  whoPick.addEventListener('change', relabel);
  // Early stop, where the runner has it: a batch ends once a model can no longer pass the share asked of it.
  const passRate = runner.options.batch_pass_rate;
  const earlyBox = el('input', { type: 'checkbox', id: 'live-early', checked: true });
  const early = el('label', { class: 'check', id: 'live-early-label', hidden: true }, earlyBox, ` Stop the batch early once a model can no longer pass ${percent(passRate || 0)} of its scenarios (saves the rest of the money)`);
  const showEarly = () => (early.hidden = !passRate || Number(runsPick.value) === 1);
  runsPick.addEventListener('change', showEarly);
  whoPick.addEventListener('change', showEarly);
  const prior = el('p', { class: 'note', id: 'live-prior' });
  const money = el('p', { class: 'note small', id: 'live-budget' });
  const stage = el('div', { id: 'live-stage' });
  const say = el('p', { class: 'finish', id: 'live-result', role: 'status', 'aria-live': 'polite' });

  // The runner plays one race at a time, for everyone. It says when it is busy (/health), whether with a race
  // this visitor started a moment ago under another choice of models, or with someone else's. The button is then
  // off and says why, right beside it, and comes back by itself: the runner is asked again every few seconds.
  const busyNote = el('p', { class: 'live-banner refused', id: 'live-busy', role: 'status', 'aria-live': 'polite', hidden: true });
  let running = false; // a race or batch this panel started is being played
  let runnerBusy = false;
  let asking = 0; // the next time the runner is asked, while it is busy
  const ready = () => {
    go.disabled = running || runnerBusy;
    busyNote.hidden = running || !runnerBusy;
  };
  const watchRunner = async (refused = false) => {
    if (!document.body.contains(go) || running) return;
    let busy = refused;
    if (!refused) {
      try {
        busy = Boolean((await fetch(`${runner.base}/health`).then((x) => x.json())).busy);
      } catch {
        busy = false; // a runner that cannot say is not held against the visitor: the race itself will answer
      }
    }
    if (!document.body.contains(go) || running) return;
    runnerBusy = busy;
    if (busy) {
      busyNote.textContent = refused
        ? 'That did not start: the runner is busy with another race, and it plays one at a time. Nothing was spent. This button comes back by itself when the runner is free, usually within a minute or two.'
        : 'The runner is busy with another race right now (it plays one at a time; it may be one you started a moment ago). This button comes back by itself when it is free, usually within a minute or two.';
      clearTimeout(asking);
      asking = setTimeout(() => watchRunner(), 4000);
    }
    ready();
  };
  // a refusal for being busy: take the empty lanes away again, so nothing on screen looks like a race under way
  const refusedBusy = (error) => {
    if (!/busy/i.test(error.message)) return false;
    stage.replaceChildren();
    say.textContent = '';
    running = false;
    watchRunner(true);
    follow(busyNote, 'center');
    return true;
  };

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

  // The live races on file for the two models chosen that the record does not hold yet: each one written up (who
  // passed, what each got wrong), and together a first draft of how the pair compares, shown beside the record.
  // The runner lists every signed-in visitor's races; a race just run here is added from its own sealed record,
  // so the write-up does not wait on the list. Where a live record is published a race joins the record as it
  // ends, and is then a scenario of the verdict above like any other, not a line here.
  const history = el('div', { id: 'live-history', class: 'live-history', hidden: true });
  let liveRaces = [];
  let liveBatches = [];
  // the runs the record already holds: a live race that has been imported is recorded evidence now
  const inRecord = new Set((await ask('MATCH (r:Run) RETURN r.run_id AS run', {})).map((x) => x.run));
  const joined = el('p', { class: 'note', id: 'live-joined', hidden: true });
  const mine = new Map(); // run_id -> the facts of a race run in this visit
  const loadRaces = async () => {
    try {
      const response = await fetch(`${runner.base}/races`);
      const listed = response.ok ? await response.json() : {};
      liveRaces = listed.races || [];
      liveBatches = listed.batches || [];
    } catch {
      liveRaces = [];
      liveBatches = [];
    }
  };
  // the batches on file for this task that are about these two models: the pair, or either against itself
  const showBatches = () => {
    const [a, b] = [v.a, v.b];
    const about = liveBatches.filter((x) => x.task === task && [x.a, x.b].every((m) => m === a || m === b) && !inRecord.has(x.run_id));
    filed.hidden = !about.length;
    if (about.length) filed.replaceChildren(el('h5', null, 'Live batches on file for these models on this task'), el('ul', { class: 'batch-list' }, [...about].reverse().map(batchLine)));
  };
  const showTally = async (a, b, r) => {
    const filedHere = liveRaces.filter((x) => x.task === task && ((x.a === a && x.b === b) || (x.a === b && x.b === a)));
    const listed = filedHere.filter((x) => !inRecord.has(x.run_id));
    const absorbed = filedHere.length - listed.length;
    joined.hidden = !absorbed;
    joined.textContent = absorbed ? `${plural(absorbed, 'live race')} between these two ${absorbed === 1 ? 'is' : 'are'} part of the record now: read by the verdict above like any other match, and replayable there.` : '';
    const between = [...listed.map((x) => (x.a_details ? x : mine.get(x.run_id) || x)), ...[...mine.values()].filter((x) => !inRecord.has(x.run_id) && !listed.some((y) => y.run_id === x.run_id))];
    history.hidden = !between.length;
    if (!between.length) return;
    history.replaceChildren(...liveHistory(between, a, b, r));
    const note = $('band-live');
    if (note) {
      note.hidden = false;
      note.textContent = `Live, they have now met ${between.length === 1 ? 'once' : `${between.length} times`}: the first draft of their history is below. It is not a verdict yet.`;
    }
    // they join the graph as live results, so the picture shows them too
    for (const x of between) await ask(ADD_LIVE, { run: x.run_id, winner: x.winner, seal: x.seal, at: Number(String(x.run_id).replace(/\D/g, '').slice(0, 14)), version: r.version, a: x.a, b: x.b });
    await drawPairGraph(r);
  };
  await loadRaces();
  showBatches();

  // what the record says about this pair: it may favour one, lean, name no favourite, or not exist at all
  let r = v;
  const showPrior = () => {
    prior.textContent =
      (r.verdict === 'no data'
        ? `${shortName(a)} and ${shortName(b)} have never met on this task in the record. This race would be the first evidence, and one race is not a verdict.`
        : r.verdict === 'better'
          ? `On this tested workflow the record favours ${shortName(r.better)}: it won ${r.wins[r.better]} of their ${r.pairs} scenarios.`
          : r.verdict === 'leaning'
            ? `On this tested workflow the record leans to ${shortName(r.better)} (${r.wins[r.better]} of ${r.pairs}), not settled.`
            : `On this tested workflow the record names no favourite between them (${r.wins[a]} to ${r.wins[b]} over ${plural(r.pairs, 'scenario')}).`) +
      ' Now put that to the test: one new scenario, generated this minute, never seen by either model.';
  };
  showPrior();
  await showTally(a, b, r);

  // A run that has just ended joins the record at once where a live record is published: the verdict above is
  // read again from the graph, with this panel left as it is, and `note` says what became of the run. With no
  // live record, or one that has not taken the run in, it says the run joins with the next import, as before.
  const LATER = 'It is not in the verdict yet: live runs join the record at the next import.';
  const join = async (run, note, alone = null, ring = false) => {
    const later = alone ? `It joins the record at the next import: counted in ${shortName(alone)}'s own fitness for the task and shown under "Consistency", never head-to-head.` : LATER;
    if (!(await recordAddress())) return void (note.textContent = later);
    note.textContent = 'Joining the record…';
    try {
      if (!(await joinRecord(run))) return void (note.textContent = `The live record has not taken it in yet. ${later}`);
      inRecord.add(run);
      // the visitor may have moved on to another pair while this was asked: then there is nothing here to redraw
      const judged = document.body.contains(box) ? await showVerdict(false, box, ring ? run : null) : null;
      if (judged) {
        r = judged;
        showPrior();
        ownRows = await ask(OWN_RECORD, { version: ownVersion, a: v.a, b: v.b });
        showExpect();
      }
      const counted = judged && (judged.evidence || []).some((e) => e.run === run);
      note.textContent = alone
        ? `It is in the record now, as a steadiness check of ${shortName(alone)}: its attempts count in that model's own fitness above, and never as a match.`
        : counted
          ? 'It is in the record now, and the verdict above counts it: read again from the graph a moment ago.'
          : 'It is in the record now. The verdict above leaves it out of the head to head, because it was played under other conditions than the verdict; the note there says which.';
      recordArrived({ added: [] }); // the line at the top counts it too
    } catch {
      note.textContent = later; // whatever went wrong here, the run is sealed and filed: it joins with the import
    }
  };

  // A batch: every attempt is shown as it ends, then the result of the whole batch.
  const runBatch = async (runs) => {
    const [ma, mb] = whoPick.value === 'a' ? [a, a] : whoPick.value === 'b' ? [b, b] : [a, b];
    running = true;
    ready();
    say.textContent = '';
    box.querySelector('#live-outcome')?.remove();
    const lanes = batchLanes(ma, mb, runs);
    const clock = el('strong', null, '0 s');
    const began = Date.now();
    const ticking = setInterval(() => (clock.textContent = `${Math.round((Date.now() - began) / 1000)} s`), 1000);
    stage.replaceChildren(
      el('p', { class: 'note' }, `${runs} new worlds, each handed to both lanes, several at a time. A square counts the steps of its scenario while it is played, then shows how it ended. This takes a few minutes. `, clock),
      lanes.A.node,
      lanes.B.node,
      batchLegend(ma === mb),
    );
    batchBox.replaceChildren();
    follow(stage, 'center');
    // a scenario one lane passed and the other did not is decided there and then; the rest wait for the judging
    const ended = { A: new Map(), B: new Map() };
    const clear = (attempt) => {
      const [x, y] = [ended.A.get(attempt), ended.B.get(attempt)];
      if (ma === mb || !x || !y || x === 'skip' || y === 'skip' || (x === 'pass') === (y === 'pass')) return;
      lanes.A.mark(attempt, x === 'pass' ? 'won' : 'lost');
      lanes.B.mark(attempt, y === 'pass' ? 'won' : 'lost');
    };
    try {
      const response = await fetch(`${runner.base}/race`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, a: ma, b: mb, runs, difficulty: level.value, profile: profile.value, early_stop: earlyBox.checked, token: session.token || '' }),
      });
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      let batch = null;
      let failed = null;
      await readEvents(response, (kind, e) => {
        if (kind === 'step') lanes[e.side].step(e);
        else if (kind === 'attempt_end') {
          ended[e.side].set(e.attempt || 1, lanes[e.side].end(e));
          clear(e.attempt || 1);
        } else if (kind === 'batch') batch = e.batch;
        else if (kind === 'failed') failed = e.error;
      });
      if (failed || !batch) throw new Error(failed || 'the batch ended without a result');
      // every scenario as the runner judged it: the lane that won it is ringed
      if (!batch.same_model) {
        (batch.scenarios || []).forEach((x, i) => {
          if (x.winner !== 'A' && x.winner !== 'B' && x.winner !== 'tie') return;
          lanes.A.mark(i + 1, x.winner === 'tie' ? 'level' : x.winner === 'A' ? 'won' : 'lost');
          lanes.B.mark(i + 1, x.winner === 'tie' ? 'level' : x.winner === 'B' ? 'won' : 'lost');
        });
        lanes.A.tally(batch.a_wins);
        lanes.B.tally(batch.b_wins);
      }
      const right = { a: lanes.A.right(), b: lanes.B.right() };
      const text = batchReport(batch, offered.name || task, right);
      window.ledgerDemo.lastLiveReport = text;
      unsavedLive = true;
      batchBox.replaceChildren(
        batchBand(batch),
        ...batchTable(batch, right),
        el(
          'p',
          null,
          el(
            'button',
            {
              type: 'button',
              id: 'download-batch',
              class: 'quiet small',
              onclick: () => {
                download(text, 'live-batch-report.md');
                unsavedLive = false;
              },
            },
            'Download the batch report',
          ),
        ),
      );
      follow(batchBox.firstElementChild, 'nearest');
      const became = el('p', { class: 'note', id: 'batch-joined', role: 'status', 'aria-live': 'polite' });
      batchBox.append(became);
      await join(batch.run_id, became, ma === mb ? ma : null);
    } catch (error) {
      if (!refusedBusy(error)) say.textContent = `The batch did not run: ${error.message}`;
    } finally {
      clearInterval(ticking);
      lanes.A.finish();
      lanes.B.finish();
      running = false;
      ready();
      if (ma === mb && whoPick.value !== 'pair') {
        // one model on both lanes is chosen for one run at a time: the next press is the match again
        whoPick.value = 'pair';
        relabel();
      }
      if (!runnerBusy) watchRunner(); // the runner may still be filing the result: ask before offering the button again
      try {
        const [options, renewed] = await Promise.all([fetch(`${runner.base}/options`).then((x) => x.json()), signIn(runner, true)]);
        showBudget(options, renewed ? renewed.races_left : null);
        await loadRaces();
        showBatches();
      } catch {
        /* the next run will say what is wrong */
      }
    }
  };

  go.addEventListener('click', async () => {
    if (Number(runsPick.value) > 1) return runBatch(Number(runsPick.value));
    batchBox.replaceChildren();
    const before = r; // the record as it stood before this race: what each model usually does
    running = true;
    ready();
    say.textContent = '';
    const lanes = { A: liveLane(a, 'a'), B: liveLane(b, 'b') };
    stage.replaceChildren(el('p', { class: 'note' }, 'A new world is being generated and handed to both models. Nothing below is a replay.'), laneLegend(), lanes.A.node, lanes.B.node);
    follow(stage, 'center');
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
          ? `Live, ${shortName(winner)} took this scenario: the first these two have played on this task.`
          : !r.better
            ? `Live, ${shortName(winner)} took this scenario. The record had no favourite between them.`
            : winner === r.better
              ? `Live, ${shortName(winner)} took this scenario too: in line with the record.`
              : `Live, ${shortName(winner)} took this scenario: against the record. One upset does not overturn ${r.wins[r.better]} of ${r.pairs}, but it is now on file.`;
      const became = el('span', { id: 'live-became' }, LATER);
      say.replaceChildren(versus, ' ', el('span', { class: 'note' }, 'Sealed record ', el('code', null, record.body.run_id), ', seal ', el('code', null, record.sha256.slice(0, 12)), '. ', became));
      // What this race showed, said from what happened: a winner's box only when the winner did the job, and
      // beside each model's result how usual that is for it in the record as it stood before the race.
      const facts = raceFacts(record, task, a, b);
      const usual = (m) => (before.fit && before.fit[m]) || ownOf(m) || null;
      box.querySelector('#live-outcome')?.remove();
      say.before(outcomeBox(facts, a, b, usual, `${offered.name || task}, ${level.value} difficulty, ${profile.value} scoring`));
      follow($('live-outcome'), 'nearest');
      const liveText = liveReport(record, a, b, task, r);
      window.ledgerDemo.lastLiveReport = liveText;
      unsavedLive = true;
      say.append(
        ' ',
        el(
          'button',
          {
            type: 'button',
            id: 'download-live',
            class: 'quiet small',
            onclick: () => {
              download(liveText, 'live-race-report.md');
              unsavedLive = false;
            },
          },
          'Download the live race report',
        ),
      );
      // written up below from its own sealed record; it joins the graph and the pair's live history there
      mine.set(facts.run_id, facts);
      await join(facts.run_id, became, null, true);
    } catch (error) {
      if (!refusedBusy(error)) say.textContent = `The live race did not run: ${error.message}`;
    } finally {
      running = false;
      ready();
      if (!runnerBusy) watchRunner(); // the runner may still be filing the result: ask before offering the button again
      // the budgets and this sign-in's races have moved: read them again
      try {
        const [options, renewed] = await Promise.all([fetch(`${runner.base}/options`).then((x) => x.json()), signIn(runner, true)]);
        showBudget(options, renewed ? renewed.races_left : null);
        await loadRaces();
        await showTally(a, b, r);
      } catch {
        /* the next race will say what is wrong */
      }
    }
  });
  box.replaceChildren(
    title,
    el('p', { class: 'live-pair', id: 'live-pair' }, el('strong', null, shortName(a)), ' vs ', el('strong', null, shortName(b)), el('span', { class: 'note' }, ' · the two models chosen in step 2')),
    prior,
    el('div', { class: 'race-controls' }, sizes.length ? [pick('Who plays', whoPick), pick('How many', runsPick)] : null, pick('Difficulty', level), pick('Scoring', profile), go),
    what,
    busyNote,
    early,
    expect,
    money,
    stage,
    say,
    batchBox,
    joined,
    history,
    filed,
  );
  watchRunner();
  return true; // there is a run box with a button in it
}
const spec_task = (test) => test.split('/').pop();

// ---- a live batch: one test played many times in one go ----------------------------------------------------------
//
// A single race says which model did the job better this time. A batch says how steadily: the same test, a fresh
// world each time, played 10 or 25 times by the two models, or by one model on both lanes (a steadiness check of
// that model, and of the test: a model that cannot agree with itself is telling you the test is noisy).

// With f failures in n attempts, the highest failure rate that is still plausible (Wilson, 95%).
function failureCeiling(f, n) {
  if (!n) return 1;
  const z = 1.96;
  const p = f / n;
  return Math.min(1, (p + (z * z) / (2 * n) + z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n));
}

// The faults of one side of a batch, by how many attempts each showed in.
function batchFaults(x, s) {
  const named = Object.entries(x[`${s}_faults`] || {})
    .filter(([counter]) => rules.fault_counters[counter])
    .map(([counter, k]) => [rules.fault_counters[counter], k]);
  for (const [ending, k] of Object.entries(x[`${s}_endings`] || {})) if (rules.ending_faults[ending]) named.push([rules.ending_faults[ending], k]);
  return named.sort((p, q) => q[1] - p[1]);
}

// Scenarios that one side or both did not play (the batch reached its spending cap, or a provider failed).
// They are left out of every count, and the result says so before anything else can mislead.
function batchUnplayed(x) {
  const missing = x.runs - x.pairs;
  if (!missing) return null;
  if (x.early_stop) {
    const e = x.early_stop;
    return `Stopped early: ${shortName(e.model)} did not run ${e.failed} of the ${e.runs} scenarios asked for clean, so it could no longer run ${percent(e.pass_rate)} of them clean. No further scenario was started, which saved the rest of the money. ${plural(x.pairs, 'scenario')} ${x.pairs === 1 ? 'was' : 'were'} played by both lanes, and every count here is over those.`;
  }
  const who = [x.a_not_run ? `${shortName(x.a)}${x.same_model ? ' (lane 1)' : ''} did not play ${x.a_not_run}` : '', x.b_not_run ? `${shortName(x.b)}${x.same_model ? ' (lane 2)' : ''} did not play ${x.b_not_run}` : ''].filter(Boolean).join('; ');
  return `Only ${x.pairs} of the ${x.runs} scenarios were played by both lanes: ${who}. The batch reached its spending cap, or a provider stopped answering. Those scenarios are left out of every count here.`;
}

function batchSettings(x) {
  return `${plural(x.pairs, 'fresh scenario')}${x.pairs < x.runs ? ` (of ${x.runs} asked for)` : ''}, ${x.difficulty} difficulty, ${x.profile} scoring`;
}

// The headline of a batch: a winner for two models, a share of clean runs for one model against itself.
function batchBand(x) {
  const unplayed = batchUnplayed(x);
  const warn = unplayed ? el('p', { class: 'band-warn', id: 'batch-unplayed' }, unplayed) : null;
  if (x.same_model) {
    const attempts = x.a_attempts + x.b_attempts;
    const passed = x.a_passed + x.b_passed;
    const ceiling = failureCeiling(attempts - passed, attempts);
    return el(
      'div',
      { class: `band ${attempts && passed === attempts ? 'win' : 'even'}`, id: 'batch-band' },
      el('p', { class: 'band-kind' }, 'Steadiness check'),
      el('p', { class: 'headline' }, attempts ? `${shortName(x.a)} ran ${passed} of ${attempts} attempts clean (${percent(passed / attempts)})` : `${shortName(x.a)} completed no attempts`),
      el('p', null, `One model on both lanes, in this test, with these settings: ${batchSettings(x)}. Given the same scenario twice, it ended the same way in ${x.same_result} of ${x.pairs}.`),
      warn,
      attempts ? el('p', { class: 'small' }, `What ${plural(attempts, 'attempt')} can show: its real failure rate on this test is unlikely to be above ${percent(ceiling)}. More runs narrow that.`) : null,
    );
  }
  const [wa, wb] = [x.a_wins, x.b_wins];
  if (wa === wb) {
    return el(
      'div',
      { class: 'band even', id: 'batch-band' },
      el('p', { class: 'band-kind' }, 'Result of this live batch'),
      el('p', { class: 'headline' }, `Level: ${wa} scenarios each`),
      el('p', { class: 'small' }, `${shortName(x.a)} and ${shortName(x.b)}, in this test, with these settings: ${batchSettings(x)}.${x.ties ? ` ${plural(x.ties, 'scenario')} had no winner.` : ''}`),
      warn,
    );
  }
  const [winner, loser, won, lost] = wa > wb ? [x.a, x.b, wa, wb] : [x.b, x.a, wb, wa];
  return el(
    'div',
    { class: 'band win', id: 'batch-band' },
    el('p', { class: 'band-kind' }, 'Winner of this live batch'),
    el('p', { class: 'headline' }, `${shortName(winner)} won ${won} of ${x.pairs} scenarios${x.pairs < x.runs ? ' both played' : ''}`),
    el('p', null, `It did this task better than ${shortName(loser)} (${lost} won${x.ties ? `, ${x.ties} level` : ''}) in this test, with these settings: ${batchSettings(x)}, the same scenario for both each time.`),
    warn,
    el('p', { class: 'small' }, `Between two equally good models, a split this lopsided would happen ${chance(x.p_value)} of the time.`),
  );
}

// Both sides of a batch as a small table: clean runs, the faults that showed, money and time.
function batchTable(x, right = null) {
  const soft = batchRight(x, right);
  const row = (s, label) => {
    const faults = batchFaults(x, s);
    const n = x[`${s}_attempts`];
    return el(
      'tr',
      null,
      el('th', { scope: 'row' }, label),
      el('td', null, (n ? `${x[`${s}_passed`]} of ${n} played (${percent(x[`${s}_passed`] / n)})` : 'none played') + (x[`${s}_not_run`] ? `; ${x[`${s}_not_run`]} not played` : '')),
      el('td', null, n ? `$${fixed(x[`${s}_cost_usd`] / n, 4)}` : '-'),
      el('td', null, faults.length ? faults.map(([name, k]) => `${name} in ${k}`).join('; ') : 'none'),
      el('td', null, `$${fixed(x[`${s}_cost_usd`], 4)}`),
      el('td', null, `${fixed(x[`${s}_seconds`], 0)} s`),
    );
  };
  return [
    el(
      'table',
      { class: 'own batch-table' },
      el('thead', null, el('tr', null, ['', 'Clean runs', 'Cost per attempt', 'Faults (attempts they showed in)', 'Cost in all', 'Time per attempt'].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', null, row('a', x.same_model ? `${shortName(x.a)}, lane 1` : shortName(x.a)), row('b', x.same_model ? `${shortName(x.b)}, lane 2` : shortName(x.b))),
    ),
    soft ? el('p', { class: 'note', id: 'batch-right' }, soft) : null,
    el(
      'p',
      { class: 'note' },
      `This batch cost $${fixed(x.spent_usd, 4)}.`,
      ' Sealed record ',
      el('code', null, x.run_id),
      ', seal ',
      el('code', null, String(x.seal).slice(0, 12)),
      '.',
    ),
  ];
}

// In words: how many of each lane's attempts that were not clean runs had every decision right. `right` is counted from
// the attempts as they ended in this browser ({a, b}); a batch read from the runner's list has no such count.
function batchRight(x, right) {
  if (!right) return null;
  const lanes = [
    ['a', x.same_model ? `${shortName(x.a)}, lane 1` : shortName(x.a)],
    ['b', x.same_model ? `${shortName(x.b)}, lane 2` : shortName(x.b)],
  ]
    .filter(([s]) => right[s])
    .map(([s, label]) => `${label}: ${right[s]} of the ${x[`${s}_attempts`] - x[`${s}_passed`]} that were not clean runs`);
  if (!lanes.length) return null;
  return `Right result, with a step skipped (such as deciding before looking a record up): ${lanes.join('; ')}. A clean run needs the right result and every step the test asks for; a skipped step is a fault with a level, not a wrong answer.`;
}

// The squares of a batch in progress: one per scenario on each lane. A square counts the steps of its attempt
// while it is being played (so there is movement from the first second), then turns into a pass or a fail.
// An attempt that did not pass can still have got every decision right (the grader's public counts say so): what
// failed it was then a step of the process, such as deciding before looking a record up. The two are not the same
// kind of failure, so a batch shows them apart.
function rightResult(g) {
  if (!g || typeof g.items !== 'number' || typeof g.correct !== 'number' || !g.items) return false;
  return g.correct === g.items && !g.wrong && !g.wrong_args && !g.missing && !g.wrong_amounts && !g.duplicate_effects && !g.conflicting;
}
const DECISION_COUNTERS = new Set(['wrong', 'wrong_args', 'missing', 'wrong_amounts', 'duplicate_effects', 'conflicting']);
// The steps such an attempt skipped, by name.
function stepsSkipped(g) {
  const named = Object.entries(g || {})
    .filter(([counter, n]) => n && rules.fault_counters[counter] && !DECISION_COUNTERS.has(counter))
    .map(([counter]) => rules.fault_counters[counter]);
  return named.length ? named.join(', ') : 'it did not finish the task';
}

// What the marks of a batch mean, under its lanes.
function batchLegend(same) {
  return el(
    'p',
    { class: 'note small', id: 'batch-legend' },
    el('span', { class: 'bkey pass' }, '✓'),
    ' clean run · ',
    el('span', { class: 'bkey soft' }, '!'),
    ' right result, a step skipped (such as deciding before looking a record up) · ',
    el('span', { class: 'bkey fail' }, '✕'),
    ' wrong result: a decision was wrong or left undone · ',
    el('span', { class: 'bkey skip' }, '–'),
    ' not played.',
    same
      ? ''
      : ' A ring marks the lane that took that scenario. A scenario goes to the lane that ran it clean where the other did not. When both did, or neither did, it goes to the one that got further, and then to the one that did it with fewer mistakes, less money, fewer tokens and less time. So a scenario can be taken by a run that was not clean, and lost by one with every decision right.',
  );
}

function batchLanes(a, b, runs) {
  const same = a === b;
  const lane = (model, cls, label) => {
    const squares = Array.from({ length: runs }, (_, i) => el('span', { class: 'bsq', title: `Scenario ${i + 1}: waiting` }));
    const count = el('span', { class: 'note' }, `0 of ${runs} done`);
    const latest = el('p', { class: 'note small batch-latest' }, 'Waiting for the first step…');
    const steps = new Map(); // attempt -> steps so far
    let done = 0;
    let passed = 0;
    let soft = 0; // the right result, with a step skipped
    let wins = null; // scenarios won, once the batch has been judged
    let all = 0;
    const say = () =>
      (count.textContent =
        `${done} of ${runs} done · ${plural(passed, 'clean run')}` +
        (soft ? ` · ${soft} more right with a step skipped` : '') +
        (wins === null ? '' : ` · took ${plural(wins, 'scenario')}`) +
        ` · ${plural(all, 'step')} so far`);
    return {
      node: el('div', { class: `batch-lane ${cls}` }, el('p', { class: 'batch-lane-name' }, el('strong', null, label), ' ', count), el('div', { class: 'bsqs' }, squares), latest),
      step(e) {
        const sq = squares[(e.attempt || 1) - 1];
        if (!sq || sq.classList.contains('pass') || sq.classList.contains('fail')) return;
        const n = (steps.get(e.attempt) || 0) + 1;
        steps.set(e.attempt, n);
        all += 1;
        sq.className = 'bsq run';
        sq.textContent = String(n);
        sq.title = `Scenario ${e.attempt}: ${plural(n, 'step')} so far`;
        latest.textContent = `Scenario ${e.attempt}, step ${n}: ${String(e.tool_name || 'thinking').replaceAll('_', ' ')}`;
        say();
      },
      // Returns how the attempt ended: 'pass', 'fail', 'skip' (not played).
      end(e) {
        const sq = squares[(e.attempt || 1) - 1];
        if (!sq) return null;
        const what = e.termination === 'not_run' ? 'skip' : e.passed ? 'pass' : 'fail';
        const right = what === 'fail' && rightResult(e.grade_details);
        sq.className = `bsq ${what}${right ? ' soft' : ''}`;
        sq.textContent = right ? '!' : { pass: '✓', fail: '✕', skip: '–' }[what];
        sq.title = `Scenario ${e.attempt}: ${
          right ? `right result, a step skipped (${stepsSkipped(e.grade_details)})` : { pass: 'a clean run', fail: 'wrong result: a decision was wrong or left undone', skip: 'not played' }[what]
        }`;
        done += 1;
        passed += what === 'pass' ? 1 : 0;
        soft += right ? 1 : 0;
        say();
        return what;
      },
      // Who took this scenario: 'won', 'lost' or 'level'.
      mark(attempt, how) {
        const sq = squares[attempt - 1];
        if (!sq) return;
        sq.classList.remove('won', 'lost', 'level');
        sq.classList.add(how);
        sq.title = sq.title.replace(/ · (won|lost|level: no winner).*$/, '') + { won: ' · won this scenario', lost: ' · lost this scenario', level: ' · level: no winner' }[how];
      },
      tally(n) {
        wins = n;
        say();
      },
      right: () => soft,
      finish() {
        latest.textContent = '';
      },
    };
  };
  return { A: lane(a, 'a', same ? `${shortName(a)}, lane 1` : shortName(a)), B: lane(b, 'b', same ? `${shortName(b)}, lane 2` : shortName(b)) };
}

// One line for a batch already on file.
function batchLine(x) {
  const text = x.same_model
    ? `${shortName(x.a)} against itself: ${x.a_passed + x.b_passed} clean runs in ${x.a_attempts + x.b_attempts} attempts, same ending in ${x.same_result} of ${x.pairs} scenarios`
    : `${shortName(x.a)} ${x.a_wins}, ${shortName(x.b)} ${x.b_wins}${x.ties ? `, ${x.ties} level` : ''} over ${plural(x.pairs, 'scenario')} (clean runs: ${x.a_passed} of ${x.a_attempts} and ${x.b_passed} of ${x.b_attempts})`;
  return el('li', null, text, el('span', { class: 'note' }, ` · ${x.difficulty}, ${x.profile} · $${fixed(x.spent_usd, 4)} · `, el('code', null, x.run_id)));
}

// The report of one live batch, to download.
function batchReport(x, title, right = null) {
  const side = (s, label) => {
    const n = x[`${s}_attempts`];
    const faults = batchFaults(x, s);
    return `| ${label} | ${x[`${s}_passed`]} of ${n} played${x[`${s}_not_run`] ? `, ${x[`${s}_not_run`]} not played` : ''} | ${faults.length ? faults.map(([name, k]) => `${name} in ${k}`).join('; ') : 'none'} | $${fixed(x[`${s}_cost_usd`], 4)} | ${fixed(x[`${s}_seconds`], 0)} s |`;
  };
  const attempts = x.a_attempts + x.b_attempts;
  const passed = x.a_passed + x.b_passed;
  const headline = x.same_model
    ? `\`${x.a}\` on both lanes ran ${passed} of ${attempts} attempts clean and ended the same way in ${x.same_result} of ${x.pairs} scenarios. With ${attempts} attempts, its real failure rate on this test is unlikely to be above ${percent(failureCeiling(attempts - passed, attempts))}.`
    : x.a_wins === x.b_wins
      ? `Level: \`${x.a}\` and \`${x.b}\` won ${x.a_wins} scenarios each${x.ties ? `, ${x.ties} had no winner` : ''}.`
      : `\`${x.a_wins > x.b_wins ? x.a : x.b}\` won ${Math.max(x.a_wins, x.b_wins)} of ${x.pairs} scenarios against \`${x.a_wins > x.b_wins ? x.b : x.a}\` (${Math.min(x.a_wins, x.b_wins)} won${x.ties ? `, ${x.ties} level` : ''}). Between two equally good models a split this lopsided would happen ${chance(x.p_value)} of the time.`;
  return [
    `# Live batch report: ${title}`,
    '',
    `Task \`${x.task}\`. ${batchSettings(x)}. ${x.same_model ? 'One model on both lanes.' : 'The same scenario for both models each time.'}`,
    '',
    `**${headline}**`,
    '',
    ...(batchUnplayed(x) ? [batchUnplayed(x), ''] : []),
    `This is a live batch. It joins the record (and the verdict) ${joinsWhen()}, and it holds for this test with these settings.`,
    '',
    '| Side | Clean runs | Faults (attempts they showed in) | Cost | Time per attempt |',
    '|---|---|---|---|---|',
    side('a', x.same_model ? `${x.a}, lane 1` : x.a),
    side('b', x.same_model ? `${x.b}, lane 2` : x.b),
    '',
    ...(batchRight(x, right) ? [batchRight(x, right), ''] : []),
    `Scenario by scenario: ${x.scenarios.map((sc, i) => `${i + 1} ${sc.winner === 'A' ? 'A' : sc.winner === 'B' ? 'B' : sc.winner === 'tie' ? 'level' : 'not run'}`).join(', ')}.`,
    '',
    `This batch cost $${fixed(x.spent_usd, 4)}. Sealed record \`${x.run_id}\`, seal \`${x.seal}\`.`,
    '',
  ].join('\n');
}

// ---- a live race written up: what each model did, what it got wrong, and the history of the pair ----------------
//
// The same few facts describe a race whether it finished a moment ago in this browser (read from its sealed
// record) or was run earlier by anyone signed in (read from the runner's list): who played, who passed, what the
// grader found for each side, what it cost and how it ended.

function raceFacts(record, task, a, b) {
  const body = record.body;
  const first = (side) => (((body.contestants || {})[side] || {}).results || [])[0] || {};
  const winner = (body.verdict || {}).winner;
  const out = { run_id: body.run_id, seal: record.sha256, task, a, b, winner: winner === 'A' ? a : winner === 'B' ? b : null };
  for (const [side, s] of [['A', 'a'], ['B', 'b']]) {
    const x = first(side);
    Object.assign(out, { [`${s}_passed`]: Boolean(x.passed), [`${s}_cost_usd`]: x.cost_usd || 0, [`${s}_details`]: x.grade_details || {}, [`${s}_termination`]: x.termination, [`${s}_seconds`]: x.wall_s || 0 });
  }
  return out;
}

// One model's side of a race, whichever side it played on.
function sideOf(x, model) {
  const s = x.a === model ? 'a' : 'b';
  return { passed: x[`${s}_passed`], cost: x[`${s}_cost_usd`] || 0, details: x[`${s}_details`] || null, termination: x[`${s}_termination`], seconds: x[`${s}_seconds`] || 0 };
}

// One side of a race as the facts its outcome is read from: did it get the right result, did it run clean, and
// which steps it skipped (the faults that are about process, not about a decision).
function endingOf(side) {
  const d = side.details || {};
  const graded = Boolean(side.details && d.items);
  const slips = Object.entries(rules.fault_counters)
    .filter(([counter]) => d[counter] && !DECISION_COUNTERS.has(counter))
    .map(([counter, name]) => `${name}${d[counter] > 1 ? ` ×${d[counter]}` : ''}`);
  if (rules.ending_faults[side.termination]) slips.push(rules.ending_faults[side.termination]);
  const clean = Boolean(side.passed);
  return { graded, clean, right: clean || (graded && rightResult(d)), items: d.items || 0, correct: d.correct || 0, slips, cost: side.cost || 0, seconds: side.seconds || 0 };
}

// What one race showed, said from what actually happened. A scenario always goes to somebody in the engine's
// count (success, then how far each got, then efficiency), but that is only a win on the job when the winner did
// the job: got the right result, cleanly or more cleanly than the other. Two runs that both cut a corner, or two
// wrong results, are said as that, with who is ahead on the tie-break and no winner's box (owner, 2026-11-26).
//   kind: efficiency | process | result | unclean | split | neither | tie      tone: win | mixed | stop | even
function raceOutcome({ a, b, winner, A, B }) {
  const [w, l, W, L] = winner === a ? [a, b, A, B] : winner === b ? [b, a, B, A] : [null, null, null, null];
  const n = shortName;
  const got = (x) => (x.graded ? `${x.correct} of ${x.items} items right` : 'no result on file');
  const slips = (x) => (x.slips.length ? x.slips.join(', ') : 'a step the test asks for');
  const spent = (x) => `$${fixed(x.cost, 4)} in ${fixed(x.seconds, 0)} s`;
  const ahead = w ? `${n(w)} is ahead on efficiency (${spent(W)}, against ${spent(L)}).` : 'There was nothing between them on efficiency either.';
  if (A.right && B.right) {
    if (A.clean && B.clean) {
      if (!w) return { kind: 'tie', tone: 'even', headline: 'No winner', body: 'Both got every decision right and followed every step the test asks for, with nothing between them on cost and time.' };
      return { kind: 'efficiency', tone: 'win', headline: `${n(w)} won on efficiency`, body: `Both got every decision right and followed every step the test asks for. ${n(w)} did it for ${spent(W)}, against ${spent(L)}.` };
    }
    if (W && W.clean) return { kind: 'process', tone: 'win', headline: `${n(w)} won on process`, body: `Both got every decision right. ${n(l)} skipped a step the test asks for (${slips(L)}), so only ${n(w)} ran it clean.` };
    return {
      kind: 'unclean',
      tone: 'mixed',
      headline: 'Both right, neither clean',
      body: `Both got every decision right, and both skipped a step the test asks for (${n(a)}: ${slips(A)}; ${n(b)}: ${slips(B)}), so neither passed the test as written. ${ahead}${w ? ' That is a tie-break between two runs that both cut a corner, not a win on the job.' : ''}`,
    };
  }
  if (A.right !== B.right) {
    const [r, o, R, O] = A.right ? [a, b, A, B] : [b, a, B, A];
    if (w === r) return { kind: 'result', tone: 'win', headline: `${n(w)} won: it got the right result`, body: `${n(o)} did not (${got(O)}).${R.clean ? '' : ` ${n(r)} skipped a step on the way (${slips(R)}), so the test as written did not pass it either.`}` };
    return { kind: 'split', tone: 'mixed', headline: 'No clear winner', body: `Only ${n(r)} got every decision right, and it skipped a step (${slips(R)}), so neither passed the test as written.${w ? ` The tie-break went to ${n(w)}.` : ''}` };
  }
  const further = w && W.graded && L.graded && W.items && L.items && W.correct / W.items > L.correct / L.items;
  return {
    kind: 'neither',
    tone: 'stop',
    headline: 'Neither got the right result',
    body: `${n(a)}: ${got(A)}. ${n(b)}: ${got(B)}.${w ? ` ${n(w)} ${further ? 'got further' : 'is ahead on efficiency'}, which settles the scenario in the count, but nobody did the job.` : ''}`,
  };
}

// The box under a live race: what happened, how usual that is for each model, and under which settings.
// `usual(model)` gives what the record said of that model on this task before the race ({attempts, right,
// passed}), or null. A result is "as usual" when the record shows the same in at least half of the model's
// attempts and "unusual for it" in a fifth or fewer, so a visitor can tell a surprise from the expected.
function outcomeBox(x, a, b, usual, settings) {
  const ends = { [a]: endingOf(sideOf(x, a)), [b]: endingOf(sideOf(x, b)) };
  const out = raceOutcome({ a, b, winner: x.winner, A: ends[a], B: ends[b] });
  const tag = (share) => (share >= 0.5 ? 'as usual' : share <= 0.2 ? 'unusual for it' : 'on record');
  const row = (m, cls) => {
    const e = ends[m];
    const u = usual(m);
    const known = u && u.attempts > 0;
    const rightShare = known ? u.right / u.attempts : 0;
    const cleanShare = known ? u.passed / u.attempts : 0;
    const skippedShare = known ? (u.right - u.passed) / u.attempts : 0;
    return el(
      'tr',
      null,
      el('th', { scope: 'row', class: cls }, shortName(m)),
      el(
        'td',
        null,
        e.graded ? `${e.correct} of ${e.items} right` : e.right ? 'right' : 'no result',
        el('small', null, known ? `${tag(e.right ? rightShare : 1 - rightShare)}: right in ${u.right} of ${u.attempts}` : 'no record on this task yet'),
      ),
      el(
        'td',
        null,
        !e.right ? 'not judged: the result was wrong' : e.clean ? 'every step followed' : `skipped: ${e.slips.length ? e.slips.join(', ') : 'a step the test asks for'}`,
        e.right
          ? el('small', null, !known ? 'no record on this task yet' : e.clean ? `${tag(cleanShare)}: clean in ${u.passed} of ${u.attempts}` : `${tag(skippedShare)}: a step skipped in ${u.right - u.passed} of ${u.attempts}`)
          : null,
      ),
      el('td', null, `$${fixed(e.cost, 4)} · ${fixed(e.seconds, 0)} s`),
    );
  };
  return el(
    'div',
    { class: `band ${out.tone}`, id: 'live-outcome', 'data-kind': out.kind },
    el('p', { class: 'band-kind' }, 'This live race'),
    el('p', { class: 'headline' }, out.headline),
    el('p', null, out.body),
    el(
      'table',
      { class: 'what-happened' },
      el('thead', null, el('tr', null, ['', 'Result', 'Process', 'Cost · time'].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', null, row(a, 'a'), row(b, 'b')),
    ),
    el(
      'p',
      { class: 'small' },
      `One fresh scenario, the same for both, in this test with these settings: ${settings}. `,
      out.tone === 'win' ? 'That is what one race shows. How consistently it would win takes more races.' : 'One race is one scenario: the record above is what says how each model usually does.',
    ),
  );
}

// The faults the grader counted for one side, in the page's own names.
function faultsOf(side) {
  if (!side.details) return null; // an older race, listed without its grade
  const found = Object.entries(rules.fault_counters)
    .filter(([counter]) => side.details[counter])
    .map(([counter, name]) => ({ name, times: side.details[counter] }));
  if (rules.ending_faults[side.termination]) found.push({ name: rules.ending_faults[side.termination], times: 1 });
  return found;
}

// Which items a model decided wrongly, in the task's own words where the grader gave the tool behind each outcome.
function mistakesOf(side) {
  const details = side.details || {};
  const tools = details.outcome_tools || {};
  const say = (outcome) => (tools[outcome] ? tools[outcome].replaceAll('_', ' ') : outcome);
  return Object.entries(details.mistakes || {}).map(([item, pair]) => {
    const [expected, chosen] = String(pair).split('->');
    return `${item}: it chose "${say(chosen)}", the right decision was "${say(expected)}"`;
  });
}

function raceSide(x, model, cls) {
  const side = sideOf(x, model);
  const faults = faultsOf(side);
  const mistakes = mistakesOf(side);
  const d = side.details || {};
  return el(
    'div',
    { class: `race-side ${cls}` },
    el('p', { class: 'race-side-name' }, shortName(model)),
    el('p', { class: 'race-side-result' }, endMark(side.details || side.passed ? endOf(endingOf(side).right, side.passed) : 'none'), d.items ? ` · ${d.correct} of ${d.items} items right` : ''),
    faults === null
      ? el('p', { class: 'note' }, 'The grade of this earlier race is not listed.')
      : faults.length
        ? el('ul', { class: 'race-faults' }, faults.map((f) => el('li', null, `${f.name}${f.times > 1 ? ` ×${f.times}` : ''}`)))
        : el('p', { class: 'note' }, 'No faults.'),
    d.wrong && !d.mistakes ? el('p', { class: 'note' }, 'This race was graded before the grader named the item, so its record does not say which decision was wrong. Races from now on do.') : null,
    mistakes.length ? el('ul', { class: 'race-mistakes' }, mistakes.slice(0, 6).map((m) => el('li', null, m)), mistakes.length > 6 ? el('li', null, `and ${mistakes.length - 6} more`) : null) : null,
    el('p', { class: 'note' }, `$${fixed(side.cost, 4)} · ${fixed(side.seconds, 0)} s`),
  );
}

// One race as a card: the headline, both sides, and the sealed record it is filed under.
function raceCard(x, a, b, number, open) {
  const how = raceOutcome({ a, b, winner: x.winner, A: endingOf(sideOf(x, a)), B: endingOf(sideOf(x, b)) }).headline;
  return el(
    'details',
    { class: 'race-card', open },
    el('summary', null, el('strong', null, `Live race ${number}`), ` · ${how}`),
    el('div', { class: 'race-sides' }, raceSide(x, a, 'a'), raceSide(x, b, 'b')),
    el('p', { class: 'note' }, 'Sealed record ', el('code', null, x.run_id), ', seal ', el('code', null, String(x.seal).slice(0, 12)), '.'),
  );
}

// The pair's live history on this task: a first draft of how they compare, from every live race on file.
function liveHistory(races, a, b, r) {
  const n = races.length;
  const won = (m) => races.filter((x) => x.winner === m).length;
  const none = races.filter((x) => !x.winner).length;
  const clean = (m) => races.filter((x) => sideOf(x, m).passed).length;
  const right = (m) => races.filter((x) => endingOf(sideOf(x, m)).right).length;
  const tallyOf = (m) => {
    const counts = new Map();
    let graded = 0;
    for (const x of races) {
      const faults = faultsOf(sideOf(x, m));
      if (faults === null) continue;
      graded += 1;
      for (const f of faults) counts.set(f.name, (counts.get(f.name) || 0) + 1);
    }
    const list = [...counts].sort((p, q) => q[1] - p[1]).map(([name, k]) => `${name} in ${k} of ${graded}`);
    return list.length ? list.join(', ') : graded ? 'no faults' : 'grades not listed';
  };
  const recorded = r.verdict === 'no data' ? 'There are no recorded scenarios between them yet, so this is all that is known.' : `They are not in the verdict above yet: live races join the record, and its ${plural(r.pairs, 'recorded scenario')}, at the next import.`;
  return [
    el('h5', null, `Live history: ${shortName(a)} vs ${shortName(b)} on this task`),
    el(
      'p',
      { class: 'live-draft', id: 'live-draft' },
      el('strong', null, `First draft from ${plural(n, 'live race')}: ${shortName(a)} took ${won(a)}, ${shortName(b)} took ${won(b)}${none ? `, ${none} with no winner` : ''}.`),
      ` Right result: ${shortName(a)} ${right(a)} of ${n}, ${shortName(b)} ${right(b)} of ${n}. Clean runs: ${shortName(a)} ${clean(a)}, ${shortName(b)} ${clean(b)}.`,
    ),
    el('ul', { class: 'live-faults' }, el('li', null, el('strong', null, shortName(a)), `: ${tallyOf(a)}`), el('li', null, el('strong', null, shortName(b)), `: ${tallyOf(b)}`)),
    el('p', { class: 'note' }, `A draft, not a verdict: each race is one fresh scenario, and a verdict needs ${rules.min_pairs} scenarios both models played. ${recorded} Every signed-in visitor's races are counted.`),
    ...races
      .map((x, i) => [x, i + 1])
      .reverse()
      .map(([x, number], i) => raceCard(x, a, b, number, i === 0)),
  ];
}


// The report of one live race, from the sealed record the runner handed back. It is one scenario, and it says so:
// a live result never joins the recorded evidence a verdict rests on.
function liveReport(record, a, b, title, v) {
  const body = record.body;
  const winner = { A: a, B: b }[(body.verdict || {}).winner] || null;
  const facts = raceFacts(record, v.task, a, b);
  const outcome = raceOutcome({ a, b, winner, A: endingOf(sideOf(facts, a)), B: endingOf(sideOf(facts, b)) });
  const lines = [
    `# Live race report: ${title}`,
    '',
    `Task \`${v.task}\`, version \`${v.version}\`. Raced live: \`${a}\` and \`${b}\`.`,
    '',
    `**This is one live scenario, generated for this race. It joins the record, and the verdict, ${joinsWhen()}.**`,
    '',
    `- What happened: **${outcome.headline}.** ${outcome.body}`,
    `- In the count: ${winner ? `\`${winner}\` took this scenario` : 'no winner'}.`,
    v.verdict === 'no data'
      ? '- The record holds no match between these two on this task: this is the first evidence.'
      : `- On this tested workflow the record ${v.better ? `${v.verdict === 'better' ? 'favours' : 'leans to'} \`${v.better}\` (${v.wins[v.better]} of ${v.pairs} scenarios)` : `names no favourite (${v.wins[a]} to ${v.wins[b]})`}.`,
    `- Sealed record \`${body.run_id}\`, seal \`${str(record.sha256).slice(0, 16)}\`${body.engine_commit ? `, engine commit \`${str(body.engine_commit).slice(0, 7)}\`` : ''}.`,
    '',
    '## What each model did and what it cost',
    '',
    'An attempt ends one of three ways: a clean run (the right result and every step the test asks for, which is ' +
      'what the test itself calls a pass), the right result with a step skipped, or a wrong result.',
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
      `| \`${name}\` | ${ended(r.passed || rightResult(r.grade_details), r.passed)} | $${fixed(r.cost_usd || 0, 4)} | ${r.calls ?? '-'} | ${r.input_tokens ?? '-'} | ` +
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
// Consistency: what each model did when it was given the same scenario twice (a batch of one model on both lanes).
// Not a comparison between the two: it says how steady each is on this task, and so how far one race can be
// trusted. Those attempts are already counted in the fit rows above. Nothing is shown until a self run exists.
function consistencyRows(v, a, b) {
  const rows = v.consistency || [];
  if (!rows.length) return [];
  const of = (m) => rows.find((x) => x.model === m);
  const cell = (m) => {
    const x = of(m);
    return x ? el('span', { class: `fig${x.same < x.scenarios ? '' : ' none'}` }, `${x.same} of ${x.scenarios}`) : el('span', { class: 'fig none' }, 'not run');
  };
  const said = [a, b]
    .map(of)
    .filter(Boolean)
    .map((x) => `${shortName(x.model)} ran ${x.passed} of ${x.attempts} of those attempts clean`)
    .join('; ');
  return [
    el('div', { class: 'tape-head', id: 'consistency-head' }, 'Consistency: each model against itself, the same scenario twice (not a comparison)'),
    tapeRow(cell(a), 'Same ending both times', `${said}. They are counted in the fit rows above, never in the head-to-head.`, cell(b)),
  ];
}

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
          el('span', { class: 'sub' }, `${PROFILE_HELP[name] || ''} ${percent(p.bar)} of attempts must end in the right result; a serious fault may show in at most ${percent(p.serious_share)} of them.`),
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

  // The scenarios themselves are in the Relate graph box (evidenceGraph): one cell each, to point at and to open.
  const arena = [
    el('div', { id: 'pair-graph', class: 'pair-graph' }),
    workedPanel(v),
    el('div', { id: 'race', class: 'race', hidden: true }),
    el('div', { id: 'live', class: 'race live' }),
  ];

  const num = (text, cls = '') => el('span', { class: `fig ${cls}` }, text);
  const beyondPair = [fa.attempts - A.attempts, fb.attempts - B.attempts]; // attempts in other matches (and against itself)
  const tape = [
    el('div', { class: 'tape-head' }, `Head to head: the ${plural(v.pairs, 'scenario')} these two played against each other`),
    tapeRow(num(String(v.wins[a])), 'Scenarios won', 'who took each one: a scenario can be lost with every decision right', num(String(v.wins[b]))),
    tapeRow(num(`${A.right} of ${A.attempts}`), 'Right result', 'every decision right, nothing left undone', num(`${B.right} of ${B.attempts}`)),
    tapeRow(num(`${A.passed} of ${A.attempts}`), 'Clean runs', 'the right result and every step the test asks for: what the test itself calls a pass', num(`${B.passed} of ${B.attempts}`)),
    tapeRow(num(`$${fixed(A.cost_per_attempt, 4)}`), 'Cost per attempt', 'lower is better', num(`$${fixed(B.cost_per_attempt, 4)}`)),
    tapeRow(num(`${fixed(A.seconds_per_attempt, 0)}s`), 'Seconds per attempt', 'lower is better', num(`${fixed(B.seconds_per_attempt, 0)}s`)),
    el(
      'div',
      { class: 'tape-head', id: 'tape-fit-head' },
      `Fit for this task: every attempt each model made on it, against anyone. That is the ${v.pairs} above` +
        (beyondPair[0] > 0 || beyondPair[1] > 0 ? ` and ${beyondPair[0]} and ${beyondPair[1]} more, in other matches` : ''),
    ),
    tapeRow(
      num(`${fa.right} of ${fa.attempts}`, fa.right_rate < fa.bar ? 'bad' : ''),
      'Right result, against anyone',
      `${percent(fa.right_rate)} and ${percent(fb.right_rate)}; ${percent(fa.bar)} needed`,
      num(`${fb.right} of ${fb.attempts}`, fb.right_rate < fb.bar ? 'bad' : ''),
    ),
    tapeRow(
      num(`${fa.passed} of ${fa.attempts}`),
      'Of those, clean runs',
      'how it got there is judged below, fault by fault, at the level you set',
      num(`${fb.passed} of ${fb.attempts}`),
    ),
    ...consistencyRows(v, a, b),
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
          // a process question the visitor added keeps its level where it was given (How they got there)
          const own = checkOfFault(row.fault);
          if (own) return setCheck(own, event.target.value);
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
    better: `Head to head, ${shortName(v.better)} won ${v.wins[v.better]} of ${v.pairs} scenarios. A split that lopsided between two equal models would happen ${chance(v.p_value)} of the time.`,
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
            others.map((o) => `${shortName(o.model)} (right result in ${percent(o.right_rate)} of ${o.attempts} attempts, $${fixed(o.cost_per_attempt, 4)} each)`).join('; '),
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
    signInOutcome === 'signed'
      ? el(
          'p',
          { class: 'live-jump' },
          el('button', { type: 'button', id: 'live-jump', onclick: () => $('live').scrollIntoView({ behavior: 'smooth', block: 'center' }) }, 'Race these two live ↓'),
          el('span', { class: 'note' }, ' The record comes first; the live race is just below it.'),
        )
      : null,
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

// Walks the three steps for the case the page exists to show: two models that are a tie on paper (their published
// score ranges overlap), with enough head-to-head evidence for a verdict, where the task still names one to use and
// the visitor's tolerance changes the answer. Among those, the pair with the most evidence, then the closest on
// paper. If the record holds no such case: a settled verdict, and failing that simply the most evidence.
// Nothing is hard-coded: more matches can change the example.
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
    const judge = (c, profile) => ledger.verdict(c.flow.test, c.a, c.b, null, rules.good_enough, rules.min_pairs, profile, {});
    const namesOne = (v) => ['use', 'only one fit'].includes(v.outcome);
    const movedBy = async (c, personal) => (await judge(c, 'enterprise')).headline !== personal.headline;
    // a tie on paper: both have a published score and the two ranges overlap
    const scores = new Map((await ledger.scoresOf([...new Set(found.flatMap((c) => [c.a, c.b]))])).map((x) => [x.model, x]));
    const gap = (c) => {
      const [x, y] = [scores.get(c.a), scores.get(c.b)];
      return x && y && x.low <= y.high && y.low <= x.high ? Math.abs(x.score - y.score) : null;
    };
    const ties = found
      .filter((c) => c.pairs >= rules.min_pairs && gap(c) !== null)
      .sort((x, y) => y.pairs - x.pairs || gap(x) - gap(y));
    let best = null;
    for (const c of ties.slice(0, 12)) {
      const personal = await judge(c, 'personal');
      if (namesOne(personal) && (await movedBy(c, personal))) {
        best = c;
        break;
      }
    }
    // no such case in the record: among the pairs with the most evidence, a settled verdict that names a model to
    // use and that the visitor's tolerance changes; failing that a settled one; otherwise the most evidence
    let settled = null;
    for (const c of best ? [] : found.slice(0, 12)) {
      const personal = await judge(c, 'personal');
      if (personal.verdict !== 'better') continue;
      settled = settled || c;
      if (namesOne(personal) && (await movedBy(c, personal))) {
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

// The visitor's choices, read again from the graph now that it holds more: the same workflow and models, with
// whatever the new records changed.
async function showAgain() {
  const { task, a, b } = state;
  await searchFlows();
  const flow = task && state.flows.flows.find((f) => f.test === task);
  if (!flow) return;
  await chooseFlow(flow);
  if (a && state.task === task) await chooseFirst(a);
  if (b && state.a === a) await chooseSecond(b);
}

// What the top of the page says once the live record has been looked at: how much it added to the copy the page
// was published with, or that it could not be read. Nothing chosen yet: the list of workflows is simply drawn
// again. Otherwise what is on screen was read before the new records arrived, and a button reads it again.
async function recordArrived(caught) {
  const note = $('record-note');
  if (!liveRecord.address || !note) return;
  smallPrint();
  const n = liveRecord.added.length;
  if (caught.problem && !n) {
    note.textContent = 'The live record could not be reached just now, so this is the record as this page was published.';
  } else if (!n) {
    note.textContent = 'Live record: connected. Nothing is newer than this page.';
  } else {
    const matches = (await ask('MATCH (r:Run) RETURN count(r) AS n', {}))[0].n;
    note.replaceChildren(
      `Live record: ${n === 1 ? '1 record is' : `${n} records are`} newer than this page (races run since it was published). ${n === 1 ? 'It is' : 'They are'} in the graph now, ${matches} in all, and counted like the rest.`,
    );
    if (!state.task) await searchFlows();
    else if (caught.added.length) note.append(' ', el('button', { type: 'button', id: 'record-show', class: 'quiet small', onclick: (event) => (event.target.remove(), showAgain()) }, 'Show this page with them'));
  }
  note.hidden = false;
}

async function start() {
  const status = $('status');
  try {
    ({ ledger, rules, questions: questionsText } = await ledgerReady);
    state.profile = rules.policy.default_profile;
    const stats = await graphReady;
    status.textContent =
      `Ready: ${stats.matches} matches (${stats.pairs} judged pairs), ${stats.models} models, built in ${Math.round(stats.total_ms)} ms.`;
  } catch (error) {
    status.textContent = `The graph could not be built in this browser: ${error.message}`;
    status.classList.add('error');
    return;
  }
  announceLive();
  setUpSignIn();
  // The live record, if one is published: records newer than this page join the graph. One that answers at once
  // is counted before the first workflow is listed; a slower one (a host waking up) is not waited for.
  const caught = catchUp();
  await Promise.race([caught, new Promise((done) => setTimeout(done, 1200))]);
  caught.then(async (first) => {
    await recordArrived(first);
    // a host that was asleep may not answer the first look in time: one more, once it has had time to wake
    if (first.problem) setTimeout(async () => recordArrived(await catchUp()), 15000);
  });
  $('flow-text').disabled = false;
  $('flow-go').disabled = false;
  $('example').disabled = false;
  $('example').addEventListener('click', showExample);
  $('start-over').addEventListener('click', startOver);
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
