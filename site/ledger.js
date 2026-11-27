// Ledger's answers, in the browser. This mirrors the Python command line (ledger/cli.py and ledger/spec.py):
// the Cypher is the same text (data/questions.json), and the arithmetic and wording here follow the Python line
// for line. site/check.cjs compares the results with the answers the Python produced (data/expected.json).

import { fixed, jsonDumps, percent, round, str, sum } from './pyformat.js';

// One model's attempts on a task in a sentence (policy.result_line): how often the result was right, which is
// what the bar asks, and in how many of those the process the test sets was followed as well.
// How an attempt ended, in three words (ledger/reports.py, ended). A clean run is what the test itself calls a
// pass: the right result and every step it asks for.
export const ended = (right, clean) => (clean ? 'clean run' : right ? 'right, a step skipped' : 'wrong result');

// ---- wording every document shares (ledger/reports.py) -----------------------------------------------------------
// What kind of sealed record a run is, from its suite. It decides what is published with it (ANSWER_KEYS).
const KINDS = { 'live-race': 'live race', 'live-batch': 'live batch' };
export const recordKind = (suite) => KINDS[suite] || 'suite match';

// What a reader can check, said once wherever sealed records are listed. Each record in the list says whether
// its own answer key is published (recordLine): a report must not promise one for a record published without it.
export const ANSWER_KEYS =
  "Every record is sealed, and `ledger verify` checks each seal. Where a record's answer key (its private half) " +
  'is published beside it, `ledger verify` checks it against the fingerprint the record carries, and anyone ' +
  'can re-grade that match from it. An answer key is published only once a match is over, and only for tests ' +
  'that generate a fresh world for every attempt.';
export const keyOf = (e) => (e.answer_key ? 'answer key published' : 'no answer key published');

// The engine build a record names, or that it names none (the hosted runner does not record one).
export const engineOf = (commit) => (commit ? `engine commit \`${str(commit).slice(0, 7)}\`` : 'engine commit not recorded');
export const recordLine = (e) =>
  `\`${e.run}\`, ${recordKind(e.suite)}, seal \`${str(e.seal_sha256).slice(0, 16)}\`, ${engineOf(e.engine_commit)}, ${keyOf(e)}`;

// How often chance alone gives a split, in words: never "p = 0.0".
export function chance(p) {
  if (p < 0.001) return 'less than 0.1%';
  return p < 0.1 ? `about ${percent(p, 1)}` : `about ${percent(p)}`;
}

// What one attempt got wrong, in words, from the faults it made (reports.fault_words): how it stopped, then what it
// did with the items it was given (on how many of them), then the hazards it fell for. A wrong decision names the
// mix-up it was. A count of failed attempts says that something went wrong; this says what.
const WRONG_DECISION = 'wrong decision';
export function faultWords(items, faults) {
  const mixups = faults.filter((f) => f.kind === 'mix-up');
  const said = [];
  for (const kind of ['ending', 'decision', 'trap']) {
    for (const f of faults) {
      if (f.kind !== kind) continue;
      let text;
      if (kind === 'decision') {
        text = items ? `${f.fault}: ${f.count} of ${items} items` : `${f.fault}: ${f.count}`;
        if (f.fault === WRONG_DECISION && mixups.length) {
          text += ` (${mixups.map((m) => m.fault + (m.count > 1 ? `, ${m.count} times` : '')).join('; ')})`;
        }
      } else if (kind === 'trap') {
        text = f.fault + (f.count > 1 ? ` (${f.count} times)` : '');
      } else {
        text = f.fault;
      }
      said.push(text);
    }
  }
  return said.length ? said.join('; ') : 'no fault recorded';
}

// The rows of the question what_went_wrong, gathered attempt by attempt (reports.what_went_wrong). `order`: a
// verdict's scenarios, as match keys, so `scenario` is the number the verdict gives it; without it, the number
// the record gives.
export function whatWentWrong(found, order = null) {
  const by = new Map();
  for (const r of found) {
    const key = `${r.match}\n${r.side}`;
    if (!by.has(key)) by.set(key, { match: r.match, side: r.side, model: r.model, right: Boolean(r.right), items: r.items, faults: [] });
    if (r.fault) by.get(key).faults.push({ fault: r.fault, kind: r.kind, count: r.count });
  }
  const place = new Map((order || []).map((match, i) => [match, i + 1]));
  const out = [...by.values()].map((e) => ({
    match: e.match,
    scenario: order ? place.get(e.match) : Number(e.match.slice(e.match.lastIndexOf('/') + 1)),
    side: e.side,
    model: e.model,
    right: e.right,
    faults: e.faults,
    what: faultWords(e.items, e.faults),
  }));
  return out.sort((x, y) => x.scenario - y.scenario || (x.side < y.side ? -1 : x.side > y.side ? 1 : 0));
}

// The first half of the guardrail section, as Markdown lines (spec.fault_lines): what went wrong in practice, how
// often, and what to build against it. Nothing when the spec was read without a tolerance.
export function faultLines(spec) {
  const bp = spec.blueprint;
  const attempts = bp.fault_attempts || {};
  if (!Object.keys(attempts).length) return [];
  const who = spec.chosen ? `\`${spec.chosen}\`` : 'each model';
  const lines = [
    `What went wrong when ${who} did this task, how often, and what to build against it. Counted over every ` +
      'attempt it made on the task under these conditions, whoever the opponent was: the attempts its fitness ' +
      'is judged on.',
    '',
    '| Model | What went wrong | Attempts with it | Level at this tolerance | Build this |',
    '|---|---|---|---|---|',
  ];
  for (const [model, made] of Object.entries(attempts)) {
    const mine = bp.faults.filter((f) => f.model === model);
    for (const f of mine) {
      const kinds = f.kinds.map((k) => `${k.fault} in ${k.attempts_with}`).join('; ');
      lines.push(
        `| \`${model}\` | ${f.fault}${kinds ? ` (${kinds})` : ''} | ` +
          `${f.attempts_with} of ${f.attempts} (${percent(f.share)}) | ${f.level} | ${f.guardrail || '-'} |`,
      );
    }
    if (!mine.length) {
      lines.push(
        `| \`${model}\` | nothing: in all ${made} attempts every item was decided rightly and the attempt ` +
          `finished | 0 of ${made} | - | - |`,
      );
    }
  }
  return [...lines, ''];
}

// What a report says under its scenarios (reports.went_wrong_lines): every attempt that did not end in the right
// result, with what went wrong in it; and, in one line, the attempts whose result was right with a step skipped.
export function wentWrongLines(went, tick = '`') {
  const wrong = went.filter((w) => !w.right);
  const skipped = went.filter((w) => w.right);
  const lines = [];
  if (wrong.length) {
    lines.push('What went wrong in the attempts that did not end in the right result:', '');
    for (const w of wrong) lines.push(`- Scenario ${w.scenario}, ${tick}${w.model}${tick}: ${w.what}.`);
    lines.push('');
  }
  if (skipped.length) {
    const tally = new Map();
    for (const w of skipped) for (const f of w.faults) if (f.kind !== 'mix-up') tally.set(f.fault, (tally.get(f.fault) || 0) + 1);
    const said = [...tally.entries()]
      .sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))
      .map(([name, n]) => `${name} in ${n}`)
      .join('; ');
    const many = `${skipped.length} ${skipped.length === 1 ? 'attempt' : 'attempts'}`;
    lines.push(`The right result with a step skipped: ${many}${said ? ` (${said}).` : '.'}`, '');
  }
  return lines;
}

// The head to head in a sentence: the count, and how often two equal models would split like that.
export function headToHead(d, a, b, tick = '`') {
  let line = `${d.pairs} judged pairs on the same generated worlds: ${tick}${a}${tick} won ${d.wins[a]}, ${tick}${b}${tick} won ${d.wins[b]}, ${d.ties} tied.`;
  if (d.wins[a] !== d.wins[b] && d.p_value < 1) line += ` Between two equally good models a split this lopsided would happen ${chance(d.p_value)} of the time.`;
  return line;
}

// What a scenario was decided on, in the order a reader cares about. The engine's own rule names stay in the data
// (decided_by): its "success" means one side passed and the other did not, which is two different things to a
// reader (a wrong result, or a right result with a step skipped), so it is never printed.
const ON = ['result', 'process', 'efficiency', 'no result'];
export const DECIDED_ON = {
  result: 'on the result (only the winner got it right)',
  process: 'on process (both got the right result, only the winner ran clean)',
  efficiency: 'on efficiency (level on result and process: mistakes, cost, tokens and time decided)',
  'no result': 'on a tie-break the winner took without the right result',
};
export const WON_ON = {
  result: 'on the result (only it got the right result)',
  process: 'on process (both got the right result, only it ran clean)',
  efficiency: 'on efficiency (level on result and process)',
  'no result': 'on a tie-break, without the right result',
};
export const MISTAKE_POINTS =
  "Mistake points are the engine's count of what went wrong in an attempt: the grader's severity for each wrong " +
  'or missing decision, 2 for each blind retry after a timeout, 1 for each action taken before reading a record ' +
  'it depends on, 3 for stopping without calling finish. They feed the efficiency tie-break.';

// What one scenario was decided on, for a reader (reports.decided_on).
export function decidedOn(r, a) {
  if (r.winner === 'tie' || !r.winner) return 'tie';
  const [w, other] = r.winner === a ? ['a', 'b'] : ['b', 'a'];
  const [wRight, wClean, lRight, lClean] = [r[`${w}_right`], r[`${w}_passed`], r[`${other}_right`], r[`${other}_passed`]].map(Boolean);
  if (wClean) return lClean ? 'efficiency' : lRight ? 'process' : 'result';
  if (wRight) return lRight ? 'efficiency' : 'result';
  return 'no result';
}

// "45 on process (...), 27 on efficiency (...)": what the scenarios were decided on, in a fixed order.
export function decidedText(counts, words = DECIDED_ON) {
  return ON.filter((k) => counts[k])
    .map((k) => `${counts[k]} ${words[k]}`)
    .join(', ');
}

// What no trips in `attempts` attempts can rule out: the rate above which seeing none would be unlikely (under 5%).
export const ruledOut = (attempts) => (attempts ? 1 - 0.05 ** (1 / attempts) : 1.0);

// What the guardrail table does not say by itself (spec.guard_notes): what "not seen" is worth, and the faults
// that count against a model's fitness, which is judged over every attempt it made and not only these scenarios.
export function guardNotes(spec) {
  const hazards = spec.blueprint.hazards;
  const lines = [];
  const unseen = [...new Set(hazards.filter((g) => !g.tripped && g.exposed).map((g) => g.exposed))].sort((x, y) => x - y);
  if (unseen.length) {
    const said = unseen.map((n) => `none in ${n} rules out a rate above about ${percent(ruledOut(n))}`).join('; ');
    lines.push(`- Not seen is a count, not a clearance: ${said}. A hazard that must never happen still needs its guard in the real flow.`);
  }
  for (const model of new Set(hazards.map((g) => g.model))) {
    const f = (spec.fit || {})[model];
    if (f && f.reasons.length) {
      lines.push(
        `- Fitness is judged over every attempt \`${model}\` made on this task (${f.attempts}), and counts ` +
          `faults that are not hazards of the world too. Against it at this tolerance${f.fit === false ? '' : ', so far'}: ${f.reasons.join('; ')}.`,
      );
    }
  }
  return lines;
}

// Python's f"{x:,.0f}": a whole number with thousands separators.
const grouped = (x) => fixed(x, 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ---- a call waits for the count to settle it (ledger/policy.py) -----------------------------------------------------
// "Fit" and "not fit" are said only when the attempts on file leave under a 5% chance that the truth is on the
// other side of the line. Until then a model meets the bar so far, or is short of it so far.
const ALPHA = 0.05;

// The chance of each count 0..n in n attempts when the true rate is p (binomial), in logs so a long record cannot
// underflow. Only what these sums decide is compared with the command line, never their digits.
function binomial(n, p) {
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  const out = [];
  let logC = 0.0;
  for (let i = 0; i <= n; i += 1) {
    out.push(Math.exp(logC + i * logP + (n - i) * logQ));
    if (i < n) logC += Math.log((n - i) / (i + 1));
  }
  return out;
}
const chanceOfAtLeast = (k, n, p) => binomial(n, p).reduce((total, t, i) => (i >= k ? total + t : total), 0);
const chanceOfAtMost = (k, n, p) => binomial(n, p).reduce((total, t, i) => (i <= k ? total + t : total), 0);
const open = (x) => x > 0 && x < 1;

// The count settles that the model meets the bar / does not meet it / shows a fault in more than its share.
export function clears(right, attempts, bar) {
  if (!attempts || !open(bar)) return Boolean(attempts) && bar <= 0;
  return chanceOfAtLeast(right, attempts, bar) < ALPHA;
}
export function fallsShort(right, attempts, bar) {
  if (!attempts || !open(bar)) return Boolean(attempts) && bar >= 1 && right < attempts;
  return chanceOfAtMost(right, attempts, bar) < ALPHA;
}
export function exceeds(withIt, attempts, share) {
  if (!attempts || !open(share)) return Boolean(attempts) && share <= 0 && withIt > 0;
  return chanceOfAtLeast(withIt, attempts, share) < ALPHA;
}

// How many attempts, with none wrong, settle that a model meets the bar: 14 at 80%, 29 at 90%.
export function sureAt(bar) {
  let n = 1;
  while (!clears(n, n, bar)) n += 1;
  return n;
}

const SO_FAR = {
  meets: 'meets the bar so far, too few attempts to be sure',
  short: 'short of the bar so far, too few attempts to be sure',
};

// Where one model stands on a task, in words: fit, not fit, or what the count says so far (policy.standing).
export function standing(f) {
  if (f.fit === null) return SO_FAR[f.so_far] || 'too few attempts to say';
  return f.fit ? 'fit' : 'not fit';
}

// Where the same content is to be had as data: the last line of the document a person reads (spec.DATA_LINE).
const DATA_LINE = 'The same content as data, for a program to read: `ledger spec` with `--json`, or "Spec as data" on the page.';

// The spec as data: everything the document says, for a program to read (spec.as_json).
export const specJson = (spec) => `${jsonDumps(spec, FLOAT_KEYS)}\n`;

export function resultLine(f) {
  return (
    `Right result in ${f.right} of ${f.attempts} attempts (${percent(f.right_rate)}; bar ${percent(f.bar)}); ` +
    `${f.passed} of them also followed the process the test asks for.`
  );
}

// Numbers that are floats in Python even when they are whole (JSON cannot tell 1 from 1.0).
const FLOAT_KEYS = new Set([
  'bar',
  'p_value',
  'pass_rate',
  'right_rate',
  'cost_per_attempt',
  'seconds_per_attempt',
  'mistakes',
  'attempt_budget_usd',
  'cost_per_right',
  'cost_per_pass',
  'spent',
  'calls_per_attempt',
  'tokens_in',
  'tokens_cached',
  'tokens_out',
]);

// ---- the reports that go with a spec (ledger/reports.py) ---------------------------------------------------------
const BASIS = {
  billed: 'billed: what the provider charged for each call',
  repriced: "repriced: recomputed from the record's token counts at the provider's published price",
  list: "list: tokens times the provider's list price",
  mixed: 'mixed: some calls billed and some at list price within one attempt',
};

const usd = (x, places = 4, none = 'none') => (x === null || x === undefined ? none : `$${fixed(x, places)}`);

export function costLines(models, a, b) {
  const lines = [
    '| Model | Cost per attempt | Cost per right result | Cost per clean run | Per 1,000 runs | Source of the cost |',
    '|---|---|---|---|---|---|',
  ];
  for (const name of [a, b]) {
    const s = models[name];
    lines.push(
      `| \`${name}\` | ${usd(s.cost_per_attempt)} | ${usd(s.cost_per_right, 4, 'none right')} | ` +
        `${usd(s.cost_per_pass, 4, 'none clean')} | ${usd(s.cost_per_attempt * 1000, 2)} | ` +
        `${s.cost_basis.join(', ')} |`,
    );
  }
  lines.push(
    '',
    '| Model | Calls per attempt | Tokens read | of which re-read from cache | Tokens written | Seconds per attempt |',
    '|---|---|---|---|---|---|',
  );
  for (const name of [a, b]) {
    const s = models[name];
    const share = s.tokens_in ? s.tokens_cached / s.tokens_in : 0;
    lines.push(
      `| \`${name}\` | ${fixed(s.calls_per_attempt, 1)} | ${grouped(s.tokens_in)} | ${grouped(s.tokens_cached)} (${percent(share)}) | ` +
        `${grouped(s.tokens_out)} | ${fixed(s.seconds_per_attempt, 0)} |`,
    );
  }
  const used = [...new Set([a, b].flatMap((name) => models[name].cost_basis))].sort(byCodePoint);
  lines.push(
    '',
    '- Cost per right result is everything spent divided by the attempts that ended in the right result: ' +
      'what one right result costs, wrong ones included. Cost per clean run divides by the attempts that also ' +
      'followed every step the test asks for.',
    '- Token counts are averages per attempt. Re-read tokens are the part of the input a provider served from its ' +
      'cache, which it bills at a fraction of the normal price.',
    '- The 1,000-run figure is a straight multiple of these attempts, not a quote: your prompts, tools and ' +
      'volume will differ.',
    `- Source of the cost: ${used.map((x) => BASIS[x] || x).join('; ')}.`,
    '',
  );
  return lines;
}

const reportHead = (kind, title, v) => [
  `# ${kind}: ${title}`,
  '',
  `Task \`${v.task}\`, version \`${v.version}\`. Compared: \`${v.a}\` and \`${v.b}\`.`,
  '',
];

export function costMarkdown(v, title) {
  const { a, b } = v;
  const lines = reportHead('Cost breakdown', title, v);
  if (v.verdict === 'no data') return [...lines, `**No costs.** ${v.notes[0]}`, ''].join('\n');
  lines.push(`Measured over the ${v.pairs} head-to-head pairs these two models played on this task.`, '');
  lines.push(...costLines(v.models, a, b));
  lines.push('## Total spent in these matches', '');
  for (const name of [a, b]) {
    const s = v.models[name];
    lines.push(
      `- \`${name}\`: $${fixed(s.spent, 4)} over ${s.attempts} attempts: ${s.right} ended in the right result, ` +
        `${s.passed} of them clean runs.`,
    );
  }
  if (v.rounds && v.rounds.length) {
    lines.push(
      '',
      '## Scenario by scenario',
      '',
      'What each attempt cost and how it ended: a clean run (the right result and every step the test asks ' +
        'for), the right result with a step skipped, or a wrong result.',
      '',
      `| # | \`${a}\` | \`${b}\` | Sealed record |`,
      '|---|---|---|---|',
    );
    v.rounds.forEach((r, i) => {
      const cells = ['a', 'b'].map((side) => `$${fixed(r[`${side}_cost`] || 0, 4)} (${ended(r[`${side}_right`], r[`${side}_passed`])})`);
      lines.push(`| ${i + 1} | ${cells[0]} | ${cells[1]} | \`${r.run}\` |`);
    });
  }
  lines.push('', 'Costs are for a simulated world under the settings in the spec. Measure again on the real flow.', '');
  return lines.join('\n');
}

export function evidenceMarkdown(v, title) {
  const { a, b } = v;
  const lines = reportHead('Evidence report', title, v);
  if (v.verdict === 'no data') return [...lines, `**No evidence.** ${v.notes[0]}`, ''].join('\n');
  if (v.headline) {
    lines.push(`**${v.headline}**`, '', `## Fit for this task, at ${v.profile} tolerance`, '');
    lines.push(
      'Every attempt each model made on this task counts here, whoever the opponent was. A model is called ' +
        'fit or not fit only when its attempts settle it; until then the report says what they show so far.',
      '',
    );
    for (const name of [a, b]) {
      const f = v.fit[name];
      lines.push(
        `### \`${name}\`: ${standing(f)}`,
        '',
        resultLine(f),
        '',
      );
      if (f.faults.length) {
        lines.push('| Fault | Level | Attempts with it | Counts against fitness |', '|---|---|---|---|');
        for (const x of f.faults) {
          lines.push(
            `| ${x.fault} | ${x.level} | ${x.attempts_with} of ${f.attempts} | ` +
              `${x.breaks ? (x.settled ? 'yes' : 'so far: too few attempts to be sure') : 'no'} |`,
          );
        }
      } else lines.push('No fault recorded.');
      lines.push('');
    }
  }
  lines.push('## Head to head', '', headToHead(v, a, b), '');
  for (const n of v.notes) lines.push(`- ${n}`);
  if (v.notes.length) lines.push('');
  if (v.rounds && v.rounds.length) {
    lines.push(
      'Each attempt ended one of three ways: a clean run (the right result and every step the test asks for, ' +
        'which is what the test itself calls a pass), the right result with a step skipped, or a wrong result.',
      '',
      `| # | Winner | Decided on | \`${a}\` | \`${b}\` | Sealed record |`,
      '|---|---|---|---|---|---|',
    );
    v.rounds.forEach((r, i) => {
      const winner = r.winner === 'tie' ? 'tie' : `\`${r.winner}\``;
      lines.push(
        `| ${i + 1} | ${winner} | ${r.on} | ${ended(r.a_right, r.a_passed)} | ` +
          `${ended(r.b_right, r.b_passed)} | \`${r.run}\` |`,
      );
    });
    lines.push('');
    lines.push(...wentWrongLines(v.went_wrong || []));
  }
  lines.push('## Sealed records', '');
  for (const e of v.evidence) lines.push(`- ${recordLine(e)}`);
  lines.push('', ANSWER_KEYS, '');
  return lines.join('\n');
}

const CURRENT_VERSION = `MATCH (t:Test {id: $t})<-[:VERSION_OF]-(tv:TestVersion)<-[:USED]-(mt:Match) WHERE NOT mt.excluded
           RETURN tv.key AS key, tv.version_rank AS rank ORDER BY rank DESC LIMIT 1`;

// The page's own small questions (the command line takes model names as typed; the page offers a list).
const MODELS_ON_FLOW = `MATCH (t:Test {id: $test_id})<-[:VERSION_OF]-(tv:TestVersion {key: $version_key})<-[:USED]-(mt:Match)
      <-[:IN]-(:Attempt)-[:BY]->(m:Model)
WHERE NOT mt.excluded
RETURN m.name AS model, m.display_name AS display_name, m.weights AS weights, count(DISTINCT mt) AS pairs
ORDER BY model`;

const PARTNERS_ON_FLOW = `MATCH (t:Test {id: $test_id})<-[:VERSION_OF]-(tv:TestVersion {key: $version_key})<-[:USED]-(mt:Match)
      <-[:IN]-(:Attempt)-[:BY]->(:Model {name: $model}),
      (mt)<-[:IN]-(:Attempt)-[:BY]->(o:Model)
WHERE NOT mt.excluded AND o.name <> $model
RETURN o.name AS model, count(DISTINCT mt) AS pairs
ORDER BY model`;

// What each tested workflow can catch: the faults its grader reports (not its one-off mix-ups or how a run ended).
const FLOW_FAULTS = `MATCH (t:Test)<-[:VERSION_OF]-(tv:TestVersion)-[:CAN_SHOW]->(f:Fault)
WHERE f.kind IN ['trap', 'decision']
RETURN t.id AS test, collect(DISTINCT f.name) AS faults`;

const SCORES_OF = `MATCH (m:Model)-[s:SCORED]->(b:Benchmark {name: $benchmark})-[:FROM]->(src:Source)
WHERE m.name IN $models
RETURN m.name AS model, s.score AS score, s.low AS low, s.high AS high, b.name AS benchmark, src.name AS source`;

const byCodePoint = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

// How likely a split this lopsided is if the two models were equally good (two-sided sign test).
export function signTestP(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 1.0;
  const k = Math.min(wins, losses);
  let tail = 0n;
  let term = 1n; // C(n, 0)
  for (let i = 0; i <= k; i++) {
    tail += term;
    term = (term * BigInt(n - i)) / BigInt(i + 1);
  }
  return Math.min(1.0, (2 * Number(tail)) / 2 ** n);
}

export const testId = (name) => (name.includes('/') ? name : `gladiator/${name}`);

// One run's steps from the small form of data/steps/<run>.json, as the rows the loader writes
// (ledger/bridges/steps.py, expand). `only` keeps it to some worlds ("<workflow>/<attempt>").
const STEP_KINDS = ['read', 'check', 'act', 'end', 'talk'];
const STEP_STATES = ['ok', 'timeout', 'refused'];
export function expandSteps(small, only = null) {
  const items = [];
  const refers = [];
  const routes = [];
  for (const [name, w] of Object.entries(small.worlds)) {
    if (only && !only.has(name)) continue;
    const world = `${small.run}/${name}`;
    for (const [id, kind] of w.items) items.push({ key: `${world}/${id}`, id, kind, world });
    for (const [a, b, field] of w.refers) refers.push({ a: `${world}/${a}`, b: `${world}/${b}`, field });
    for (const [side, rows] of Object.entries(w.routes)) {
      const steps = rows.map((row, i) => {
        const [tool, kind, state, item] = [small.tools[row[0]], STEP_KINDS[row[1]], STEP_STATES[row[2]], row[4]];
        const saw = row.length > 5 ? row[5] : kind === 'read' && state === 'ok' && item ? [item] : [];
        const told = row.length > 6 ? row[6] : [];
        return {
          key: `${world}/${side}/${i + 1}`,
          n: i + 1,
          tool,
          kind,
          state,
          at_s: row[3],
          item,
          saw: saw.map((x) => `${world}/${x}`),
          decided: kind === 'act' && item ? [`${world}/${item}`] : [],
          checked: kind === 'check' && item ? [`${world}/${item}`] : [],
          told: told.map(([x, notice]) => ({ item: `${world}/${x}`, notice })),
        };
      });
      routes.push({ attempt: `${world}/${side}`, steps });
    }
  }
  return { run_id: small.run, self: small.self, items, refers, routes };
}

// `loadSteps(matches)` puts the steps of those scenarios into the graph (the page fetches their files) and
// resolves to {missing: how many had no steps to load}. Without it, questions about steps find nothing.
export function createLedger(ask, questions, rules, loadSteps = async () => ({ missing: 0 })) {
  const filler = new Set(rules.filler);

  // The words worth searching for in a described flow (lower case, letters and digits only, filler removed).
  function searchWords(text) {
    const cleaned = Array.from(text || '', (c) => (/[\p{L}\p{N}]/u.test(c) ? c.toLowerCase() : ' ')).join('');
    const words = cleaned.split(/\s+/).filter((w) => w && !filler.has(w));
    // The index matches whole words, so add the singular of a plural ("refunds" also searches "refund").
    for (const w of [...words]) {
      if (Array.from(w).length > 3 && w.endsWith('s') && !w.endsWith('ss')) words.push(w.slice(0, -1));
    }
    return [...new Set(words)].join(' ');
  }

  async function findFlows(described) {
    const words = searchWords(described || '');
    const found = words ? await ask(questions.find_flow, { q: words }) : [];
    const text = described ?? null;
    if (found.length) return { described: text, searched_for: words, matched: true, flows: found };
    return { described: text, searched_for: words, matched: false, flows: await ask(questions.flows, {}) };
  }

  async function currentVersion(test) {
    const found = await ask(CURRENT_VERSION, { t: test });
    return found.length ? found[0].key : null;
  }

  async function resolveModel(name) {
    const models = await ask('MATCH (m:Model) RETURN m.name AS name, m.display_name AS display_name', {});
    const want = name.trim().toLowerCase();
    for (const m of models) {
      if (want === m.name.toLowerCase() || want === (m.display_name || '').toLowerCase()) return m.name;
    }
    const partial = models
      .filter((m) => m.name.toLowerCase().includes(want) || (m.display_name || '').toLowerCase().includes(want))
      .map((m) => m.name);
    return partial.length === 1 ? partial[0] : null;
  }

  // Models that score close to this one on a published index: candidates for a fair head-to-head.
  async function opponents(model, openOnly = false, limit = 5) {
    openOnly = Boolean(openOnly);
    const key = await resolveModel(model);
    const out = { asked: model, model: key, benchmark: rules.benchmark, open_only: openOnly, candidates: [] };
    if (key === null) return { ...out, note: `No single model matches '${model}'. Use an exact id or a fuller name.` };
    const mine = await ask(
      'MATCH (m:Model {name: $m})-[s:SCORED]->(:Benchmark {name: $b}) RETURN s.score AS score, s.low AS low, ' +
        's.high AS high, m.display_name AS display_name',
      { m: key, b: rules.benchmark },
    );
    if (!mine.length) {
      return { ...out, note: `${key} has no published score on the ${rules.benchmark}, so no opponent is suggested.` };
    }
    const close = await ask(questions.close_to, { model: key, benchmark: rules.benchmark, open_only: openOnly });
    return { ...out, score: mine[0], candidates: close.slice(0, limit) };
  }

  function side(pairs, s) {
    const n = pairs.length;
    const passed = pairs.filter((p) => p[`${s}_passed`]).length;
    const right = pairs.filter((p) => p[`${s}_right`]).length; // the result alone, whatever the process was
    const spent = sum(pairs.map((p) => p[`${s}_cost`] || 0));
    return {
      attempts: n,
      passed,
      pass_rate: passed / n,
      right,
      right_rate: right / n,
      cost_per_attempt: spent / n,
      cost_per_right: right ? spent / right : null,
      cost_per_pass: passed ? spent / passed : null,
      spent,
      cost_basis: [...new Set(pairs.map((p) => str(p[`${s}_basis`])))].sort(byCodePoint),
      calls_per_attempt: sum(pairs.map((p) => p[`${s}_calls`] || 0)) / n,
      tokens_in: sum(pairs.map((p) => p[`${s}_in`] || 0)) / n,
      tokens_cached: sum(pairs.map((p) => p[`${s}_cached`] || 0)) / n,
      tokens_out: sum(pairs.map((p) => p[`${s}_out`] || 0)) / n,
      seconds_per_attempt: sum(pairs.map((p) => p[`${s}_time`] || 0)) / n,
      mistakes: sum(pairs.map((p) => p[`${s}_mistakes`] || 0)) / n,
      effort: [...new Set(pairs.map((p) => str(p[`${s}_effort`])))].sort(byCodePoint),
    };
  }

  // ---- fit for the task (ledger/policy.py and cli.fitness / cli.outcome) ----------------------------------------
  const policy = rules.policy;
  const profileNames = Object.keys(policy.profiles);

  // The level of one fault on one task under a profile: the reader's override, then the task's exception, then
  // the fault's default; a mix-up falls back to the fault it is a kind of; anything unknown is serious.
  function levelOf(test, fault, kindOf, profile, overrides = null) {
    const column = profileNames.indexOf(profile);
    const task = (policy.task_levels[test] || {}).levels || {};
    for (const name of [fault, kindOf]) {
      if (name === null || name === undefined) continue;
      if (overrides && name in overrides) return overrides[name];
      if (name in task) return task[name][column];
      if (name in policy.fault_levels) return policy.fault_levels[name][column];
    }
    return 'serious';
  }

  function assess(test, row, faults, profile, overrides = null, bar = null) {
    const limits = policy.profiles[profile];
    bar = bar === null ? limits.bar : bar;
    const { attempts, passed } = row;
    const right = row.right ?? passed;
    const passRate = attempts ? passed / attempts : 0.0;
    const rightRate = attempts ? right / attempts : 0.0;
    const listed = [];
    const reasons = [];
    let unforgivable = false; // an unforgivable fault was seen
    let decided = false; // some reason is settled by the count
    for (const f of faults) {
      const level = levelOf(test, f.fault, f.kind_of ?? null, profile, overrides);
      const share = attempts ? f.attempts_with / attempts : 0.0;
      // breaks: the attempts on file show it over what the reader accepts. settled: the count leaves no real
      // doubt of that (one attempt with an unforgivable fault is a fact; a share needs enough attempts).
      let breaks = false;
      let settled = false;
      if (level === 'unforgivable') {
        breaks = f.attempts_with > 0;
        settled = breaks;
        unforgivable = unforgivable || breaks;
      } else if (level === 'serious') {
        // a mix-up is already counted in the fault it is a kind of: it explains, it does not decide twice
        breaks = (f.kind_of ?? null) === null && share > limits.serious_share;
        settled = breaks && exceeds(f.attempts_with, attempts, limits.serious_share);
      }
      decided = decided || settled;
      listed.push({ ...f, level, share: round(share, 4), breaks, settled });
      if (breaks) {
        reasons.push(
          `${f.fault} (${level}) in ${f.attempts_with} of ${attempts} attempts` +
            (level === 'unforgivable' ? '' : `, over the ${percent(limits.serious_share)} allowed`),
        );
      }
    }
    if (rightRate < bar) {
      reasons.unshift(`right result in ${right} of ${attempts} attempts (${percent(rightRate)}), under the ${percent(bar)} bar`);
      decided = decided || fallsShort(right, attempts, bar);
    }
    const thin = attempts < limits.min_attempts;
    // The call, and what the count says where it cannot make one yet (ledger/policy.py).
    let fit = null;
    let soFar = null;
    if (unforgivable || (decided && !thin)) fit = false;
    else if (thin) fit = null;
    else if (reasons.length) soFar = 'short';
    else if (clears(right, attempts, bar)) fit = true;
    else soFar = 'meets';
    const order = (e) => policy.levels.indexOf(e.level);
    listed.sort(
      (x, y) =>
        Number(!x.breaks) - Number(!y.breaks) ||
        order(x) - order(y) ||
        y.attempts_with - x.attempts_with ||
        byCodePoint(x.fault, y.fault),
    );
    return {
      fit,
      so_far: soFar,
      attempts,
      passed,
      pass_rate: round(passRate, 4),
      right,
      right_rate: round(rightRate, 4),
      bar,
      cost_per_attempt: row.cost_per_attempt ?? null,
      reasons,
      thin,
      faults: listed.filter((e) => e.attempts_with || e.level === 'unforgivable'),
    };
  }

  // The one set of conditions a verdict between two models is read under (cli.reference_conditions): those of the
  // suite matches between the two; if they never met in a suite, those most of the task's own suite record was
  // played under; if they have no pair under those either, the conditions they met under most.
  function referenceConditions(found, record) {
    // the first place two ranks differ decides; a full tie goes to the first in code-point order
    const higher = (x, y) => {
      for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
      return false;
    };
    let best = null;
    for (const c of [...found].sort((x, y) => byCodePoint(x.conditions, y.conditions))) {
      const rank = [c.suite_pairs, record.get(c.conditions) || 0, c.pairs];
      if (!best || higher(rank, best.rank)) best = { rank, conditions: c.conditions };
    }
    return best.conditions;
  }

  // How one set of conditions differs from the reference, in words: only the settings that differ.
  function conditionsApart(reference, other) {
    const read = (text) =>
      new Map(text.split('; ').filter((part) => part.includes('=')).map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)]));
    const [ref, oth] = [read(reference), read(other)];
    const words = [];
    for (const key of [...new Set([...ref.keys(), ...oth.keys()])].sort(byCodePoint)) {
      if (ref.get(key) === oth.get(key)) continue;
      if (!oth.has(key)) words.push(`no ${key} set`);
      else words.push((rules.condition_words[key] ?? `${key} {}`).split('{}').join(oth.get(key)));
    }
    return words.join(', ') || 'other conditions';
  }

  // Every model's fitness for one task version, counting every attempt it made under one set of conditions,
  // whoever the opponent was and whether the match was a suite match or a live race. `suite` keeps it to one
  // suite's matches (a fixed set).
  async function fitness(test, version, conditions, suite, profile, overrides = null, bar = null, checks = null) {
    const scope = { version_key: version, conditions, suite, until: null };
    const faults = {};
    for (const { model, ...f } of await ask(questions.task_faults, scope)) (faults[model] ||= []).push(f);
    const attempts = new Map((await ask(questions.task_attempts, scope)).map((r) => [r.model, { ...r }]));
    // self runs (one model on both sides) are attempts at the task too: added to that model's own count
    for (const extra of await ask(questions.self_attempts, scope)) {
      const r = attempts.get(extra.model);
      if (!r) continue;
      const spent = (r.cost_per_attempt || 0) * r.attempts + (extra.spent || 0);
      r.attempts += extra.attempts;
      r.passed += extra.passed;
      r.right += extra.right;
      r.cost_per_attempt = spent / r.attempts;
    }
    for (const f of await ask(questions.self_faults, scope)) {
      const mine = (faults[f.model] || []).find((x) => x.fault === f.fault);
      if (mine) {
        mine.attempts_with += f.attempts_with;
        mine.times += f.times;
      }
    }
    // the reader's own process questions join the faults, at the levels the reader gave them
    if (checks && Object.keys(checks.levels || {}).length) {
      await loadScope(scope);
      const own = await asFaults(scope, checks.levels, checks.kinds || null);
      for (const [model, added] of Object.entries(own.faults)) (faults[model] ||= []).push(...added);
      overrides = { ...(overrides || {}), ...own.levels };
    }
    const out = {};
    for (const [model, r] of attempts) out[model] = assess(test, r, faults[model] || [], profile, overrides, bar);
    return out;
  }

  // ---- steps: how a model got to its result (ledger/routes.py, and process and route in ledger/cli.py) --------

  const stepChecks = rules.step_checks;
  const forSelfRuns = (query) => query.replaceAll(':Match', ':SelfCheck').replaceAll(':Attempt', ':SelfAttempt');
  // The scenarios of a scope, so their steps can be loaded before a question is asked of them.
  const WORLDS_IN_SCOPE = `MATCH (tv:TestVersion {key: $version_key})<-[:USED]-(mt:Match)-[:PART_OF]->(r:Run)
WHERE ($conditions IS NULL OR mt.conditions = $conditions) AND ($suite IS NULL OR r.suite = $suite)
RETURN mt.key AS match ORDER BY match`;
  const scopesLoaded = new Map(); // scope -> how many of its scenarios had no steps to load

  async function loadScope(scope) {
    const key = JSON.stringify([scope.version_key, scope.conditions, scope.suite]);
    if (!scopesLoaded.has(key)) {
      const worlds = [...(await ask(WORLDS_IN_SCOPE, scope)), ...(await ask(forSelfRuns(WORLDS_IN_SCOPE), scope))];
      scopesLoaded.set(key, (await loadSteps(worlds.map((r) => r.match))).missing);
    }
    return scopesLoaded.get(key);
  }

  // The scope a process question is asked in: the task's current version under one set of conditions, which is
  // the scope of fitness. For two models, the conditions their verdict is read under; for a task alone, the
  // conditions most of its suite record was played under.
  async function stepScope(workflow, a = null, b = null, suite = null) {
    const test = testId(workflow);
    const version = await currentVersion(test);
    if (version === null || version === undefined) return null;
    const task = { test_id: test, suite, version_key: version, until: null };
    const record = new Map((await ask(questions.task_conditions, task)).map((r) => [r.conditions, r.pairs]));
    let conditions = null;
    if (a && b) {
      const met = await ask(questions.pair_conditions, { ...task, a, b });
      if (!met.length) return null;
      conditions = referenceConditions(met, record);
    } else {
      for (const c of [...record.keys()].sort(byCodePoint)) {
        if (conditions === null || record.get(c) > record.get(conditions)) conditions = c;
      }
    }
    return { version_key: version, conditions, suite, until: null };
  }

  // What a decision on this task depends on, as the worlds in the graph show it: [{decided, needs, via}].
  async function whatDecisionsNeed(versionKey) {
    const seen = new Set();
    const out = [];
    for (const r of await ask(questions.what_decisions_need, { version_key: versionKey })) {
      const key = `${r.decided}\u0000${r.needs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ decided: r.decided, needs: r.needs, via: [...r.via] });
    }
    return out;
  }

  // One process question, per model, in a scope. Self runs count like any other attempt of that model.
  async function check(name, scope, kinds = null) {
    const params = { ...scope, kinds: kinds && kinds.length ? kinds : null };
    const query = questions[`steps:${name}`];
    const found = new Map((await ask(query, params)).map((r) => [r.model, { ...r }]));
    for (const extra of await ask(forSelfRuns(query), params)) {
      const mine = found.get(extra.model);
      if (!mine) continue;
      for (const key of ['attempts', 'times', 'attempts_with', 'right_with', 'passed_with']) mine[key] += extra[key];
    }
    return [...found.keys()].sort(byCodePoint).map((model) => found.get(model));
  }

  // How two models worked on one task: every process question counted from the steps, beside the grader's own
  // count where the grader has one. `not_loaded` says how many scenarios of the scope had no steps to load
  // (a race run in this tab, until it is imported).
  async function process(workflow, a, b, names = null, kinds = null) {
    const test = testId(workflow);
    const scope = await stepScope(workflow, a, b);
    if (!scope) return { task: test, checks: [], note: 'No judged match on file for this.' };
    const notLoaded = await loadScope(scope);
    const graded = new Map();
    for (const f of [...(await ask(questions.task_faults, scope)), ...(await ask(questions.self_faults, scope))]) {
      const key = `${f.model}\u0000${f.fault}`;
      graded.set(key, (graded.get(key) || 0) + f.attempts_with);
    }
    const kept = kinds && kinds.length ? kinds : null;
    const found = [];
    for (const name of names || Object.keys(stepChecks)) {
      const about = stepChecks[name];
      const models = [];
      for (const m of await check(name, scope, about.kinds ? kept : null)) {
        if (m.model !== a && m.model !== b) continue;
        models.push({ ...m, grader_attempts_with: about.grader ? (graded.get(`${m.model}\u0000${about.grader}`) ?? null) : null });
      }
      found.push({
        check: name,
        asks: about.asks,
        note: about.note,
        grader_counts: about.grader,
        needs: about.kinds ? kept : null,
        models,
        cypher: questions[`steps:${name}`].trim(),
      });
    }
    return {
      task: test,
      version: scope.version_key,
      conditions: scope.conditions,
      suite: scope.suite,
      until: null,
      decisions_need: await whatDecisionsNeed(scope.version_key),
      checks: found,
      not_loaded: notLoaded,
    };
  }

  // A reader's own checks as fault rows for fitness: {model: [fault row]} and the level each was given.
  async function asFaults(scope, levels, kinds = null) {
    const faults = {};
    const given = {};
    for (const [name, level] of Object.entries(levels)) {
      const about = stepChecks[name];
      const fault = `${about.fault} (your check)`;
      given[fault] = level;
      for (const m of await check(name, scope, about.kinds ? kinds : null)) {
        (faults[m.model] ||= []).push({ fault, kind: 'check', kind_of: null, attempts_with: m.attempts_with, times: m.times });
      }
    }
    return { faults, levels: given };
  }

  // Scenarios, item by item: the two models on the same world. For each item, what each decided and which of
  // the records it depends on each had seen by then. The steps of `matches` must be in the graph (loadSteps).
  async function sameWorld(matches) {
    const worlds = new Map();
    const asked = { matches: [...matches] };
    // the world itself (every record and the records it refers to) and when each model first saw each record:
    // what a picture of the two routes is drawn from
    const records = new Map();
    for (const r of await ask(questions.world_records, asked)) {
      if (!records.has(r.match)) records.set(r.match, []);
      records.get(r.match).push({ id: r.id, kind: r.kind, refers: (r.refers || []).filter((x) => x !== null).map((x) => ({ ...x })) });
    }
    const seen = new Map();
    for (const r of await ask(questions.world_seen, asked)) {
      if (!seen.has(r.match)) seen.set(r.match, {});
      (seen.get(r.match)[r.side] ||= {})[r.record] = { step: r.step, at_s: r.at_s };
    }
    for (const r of await ask(questions.same_world, asked)) {
      if (!worlds.has(r.match)) worlds.set(r.match, { match: r.match, models: {}, items: new Map() });
      const world = worlds.get(r.match);
      world.models[r.side] = r.model;
      if (!world.items.has(r.item)) world.items.set(r.item, { item: r.item, kind: r.kind, sides: {} });
      const needs = (r.needs || []).filter((n) => n !== null).map((n) => ({ ...n }));
      world.items.get(r.item).sides[r.side] = {
        model: r.model,
        decision: r.decision ?? null,
        step: r.step ?? null,
        at_s: r.at_s ?? null,
        state: r.state ?? null,
        needs,
        unseen: needs.filter((n) => n.seen === false).map((n) => n.record),
      };
    }
    const out = [];
    for (const key of matches) {
      const world = worlds.get(key);
      if (!world) continue;
      const items = [...world.items.values()];
      for (const item of items) item.differ = new Set(Object.values(item.sides).map((s) => s.decision)).size > 1;
      const sides = Object.keys(world.models).sort(byCodePoint);
      out.push({
        match: world.match,
        models: world.models,
        items,
        records: records.get(key) || [],
        seen: seen.get(key) || {},
        decided_differently: items.filter((i) => i.differ).map((i) => i.item),
        decided_unseen: Object.fromEntries(sides.map((s) => [s, items.filter((i) => ((i.sides[s] || {}).unseen || []).length).length])),
      });
    }
    return out;
  }

  // The same world, two routes: for the scenarios two models both played (the pairs their verdict counts), where
  // they decided differently and what each had seen when it decided. One scenario in full with `scenario`
  // (1 is the first), a line per scenario without it.
  async function route(workflow, a, b, scenario = null) {
    const test = testId(workflow);
    const scope = await stepScope(workflow, a, b);
    const out = { task: test, a, b, scenarios: [] };
    if (!scope) return { ...out, note: `${a} and ${b} never met on ${test}.` };
    const pairs = await ask(questions.pair_on_task, { test_id: test, a, b, ...scope });
    Object.assign(out, { version: scope.version_key, conditions: scope.conditions, pairs: pairs.length });
    const chosen = scenario === null ? pairs : pairs.slice(scenario - 1, scenario);
    if (scenario !== null && !chosen.length) {
      return { ...out, note: `There are ${pairs.length} scenarios; --scenario takes 1 to ${pairs.length}.` };
    }
    await loadSteps(chosen.map((p) => p.match));
    out.decisions_need = await whatDecisionsNeed(scope.version_key);
    const worlds = await sameWorld(chosen.map((p) => p.match));
    for (const w of worlds) {
      const sideOf = Object.fromEntries(Object.entries(w.models).map(([side, model]) => [model, side]));
      const pair = pairs.findIndex((p) => p.match === w.match);
      Object.assign(w, { scenario: pair + 1, winner: pairs[pair].winner, side: { [a]: sideOf[a] ?? null, [b]: sideOf[b] ?? null } });
      if (scenario === null) for (const detail of ['items', 'records', 'seen']) delete w[detail];
    }
    out.scenarios = worlds;
    return out;
  }

  // The answer a reader acts on: [code, sentence, the model to use or null].
  function outcome(v, fit) {
    const { a, b } = v;
    const fa = fit[a].fit;
    const fb = fit[b].fit;
    const ahead = v.better;
    const settled = v.verdict === 'better';
    if (fa === null || fb === null) {
      // A call that waits for more attempts names no model on its own. Where the other model's fit is settled,
      // that one is said, and it alone can be the model to use.
      const soFar = (m) => {
        const f = fit[m];
        const said = { meets: 'it meets the bar so far', short: 'it is short of the bar so far' }[f.so_far];
        return said ? `${said}, on ${f.attempts} attempts` : `it has only ${f.attempts} attempts`;
      };
      if (fa === null && fb === null) {
        return ['not settled', `Not settled yet whether either is fit for this task: for ${a}, ${soFar(a)}; for ${b}, ${soFar(b)}.`, null];
      }
      const [known, waiting] = fa === null ? [b, a] : [a, b];
      const rest = `Whether ${waiting} is fit is not settled yet: ${soFar(waiting)}.`;
      if (!fit[known].fit) return ['not settled', `${known} is not fit for this task. ${rest}`, null];
      if (ahead === known) {
        const lead = settled ? 'did it better' : 'is ahead, not settled';
        return ['one settled', `Use ${known}: it is fit for this task, and it ${lead}. ${rest}`, known];
      }
      if (ahead === waiting) {
        const lead = settled ? 'did it better' : 'is ahead';
        return ['one settled', `${known} is fit for this task. ${waiting} ${lead} head to head. ${rest}`, known];
      }
      return ['one settled', `${known} is fit for this task. ${rest}`, known];
    }
    if (!fa && !fb) {
      const more = ahead ? ` ${ahead} did it better of the two, which is not the same as fit.` : '';
      return ['neither fit', `Neither is fit for this task.${more}`, null];
    }
    if (fa !== fb) {
      const [fitOne, other] = fa ? [a, b] : [b, a];
      if (ahead === other) {
        const lead = settled ? 'did it better' : 'is ahead';
        return ['only one fit', `${other} ${lead} head to head, but only ${fitOne} is fit for this task.`, fitOne];
      }
      if (ahead === fitOne) {
        const lead = settled ? 'did it better' : 'is ahead, not settled';
        return ['only one fit', `Use ${fitOne}: it is the only one of the two fit for this task, and it ${lead}.`, fitOne];
      }
      return ['only one fit', `Use ${fitOne}: it is the only one of the two fit for this task.`, fitOne];
    }
    if (settled) return ['use', `Use ${ahead}: both are fit for this task and it did it better.`, ahead];
    if (ahead) {
      return ['both fit', `Both are fit for this task. ${ahead} is ahead head to head, but that is not settled.`, null];
    }
    return ['both fit', 'Both are fit for this task, and the matches show no winner between them.', null];
  }

  // A task claim: which of two models did THIS task better on the same worlds, how sure that is, and whether
  // either is good enough. No winner is named on thin evidence or a level score.
  async function verdict(
    workflow,
    a,
    b,
    suite = null,
    bar = null,
    minPairs = rules.min_pairs,
    profile = null,
    overrides = null,
    checks = null,
  ) {
    // One verdict has one bar: the reader's when one is given, else the tolerance's own, else the default.
    const askedBar = bar;
    bar = askedBar ?? (profile ? policy.profiles[profile].bar : rules.good_enough);
    const test = testId(workflow);
    const version = await currentVersion(test);
    // the page always reads the whole record: `until` (the command line's --until) stays empty here
    const params = { test_id: test, a, b, suite, version_key: version, until: null };
    const out = { task: test, version: version || 'all versions', suite, until: null, a, b, bar };
    const metUnder = await ask(questions.pair_conditions, params);
    if (!metUnder.length) {
      return { ...out, verdict: 'no data', better: null, pairs: 0, notes: [`${a} and ${b} never met on ${test}.`] };
    }
    // One verdict, one set of conditions: pairs played under any other are on file and said so, never pooled.
    const record = new Map(
      (await ask(questions.task_conditions, { test_id: test, suite, version_key: version, until: null })).map((r) => [r.conditions, r.pairs]),
    );
    const conditions = referenceConditions(metUnder, record);
    params.conditions = conditions;
    const notCounted = [...metUnder]
      .sort((x, y) => byCodePoint(x.conditions, y.conditions))
      .filter((c) => c.conditions !== conditions)
      .map((c) => ({ conditions: c.conditions, pairs: c.pairs, what: conditionsApart(conditions, c.conditions) }));
    const pairs = await ask(questions.pair_on_task, params);
    const winsA = pairs.filter((p) => p.winner === a).length;
    const winsB = pairs.filter((p) => p.winner === b).length;
    const ties = pairs.length - winsA - winsB;
    const decidedBy = {};
    for (const p of pairs) decidedBy[p.rule] = (decidedBy[p.rule] || 0) + 1;
    const stats = { [a]: side(pairs, 'a'), [b]: side(pairs, 'b') };
    const pValue = signTestP(winsA, winsB);
    const notes = [];
    let better = null;
    let kind;
    if (pairs.length < minPairs) {
      kind = 'not enough evidence';
      notes.push(`Only ${pairs.length} judged pairs (fewer than ${minPairs}): too few to call.`);
    } else if (winsA === winsB) {
      kind = 'no real difference shown';
      notes.push(`The pairs split ${winsA}-${winsB}: neither did this task better.`);
    } else if (pValue >= rules.level_p) {
      kind = 'no real difference shown';
      notes.push(
        `The pairs split ${Math.max(winsA, winsB)}-${Math.min(winsA, winsB)}: two equal models split at least that ` +
          `unevenly ${percent(pValue)} of the time, so neither is ahead.`,
      );
    } else {
      const [lead, trail] = winsA > winsB ? [winsA, winsB] : [winsB, winsA];
      better = winsA > winsB ? a : b;
      if (pValue < rules.clear_p) {
        kind = 'better';
      } else {
        kind = 'leaning';
        notes.push(
          `A ${lead}-${trail} split happens by chance ${percent(pValue)} of the time between equal models: ` +
            'a lean, not a settled result.',
        );
      }
    }
    const each = Object.values(stats);
    for (const s of each) s.good_enough = s.right_rate >= bar;
    // Read through a tolerance, the fitness lines say who clears the bar, over every attempt each model made:
    // a second answer here, over the pair's scenarios only, could contradict them.
    if (!profile) {
      if (better && !stats[better].good_enough) {
        notes.push(
          `${better} did better here, but got the right result in only ${percent(stats[better].right_rate)} of ` +
            `attempts (bar ${percent(bar)}): better than the other one is not the same as good enough.`,
        );
      }
      if (!each.some((s) => s.good_enough)) notes.push(`Neither model reaches the bar of ${percent(bar)} right results on this task.`);
    }
    // What the scenarios were decided on, in a reader's words: a scenario can be won with both results right.
    for (const p of pairs) p.on = decidedOn(p, a);
    const decidedOnCounts = {};
    for (const p of pairs) decidedOnCounts[p.on] = (decidedOnCounts[p.on] || 0) + 1;
    if (pairs.length && pairs.every((p) => p.a_right && p.b_right)) {
      notes.push(
        `Both got the right result in all ${pairs.length} scenarios, so every one was decided on process or ` +
          'efficiency, never on a wrong result.',
      );
    }
    for (const [model, won] of [
      [a, winsA],
      [b, winsB],
    ]) {
      if (!won) continue;
      const mine = {};
      for (const p of pairs) if (p.winner === model) mine[p.on] = (mine[p.on] || 0) + 1;
      notes.push(`${model} won ${won}: ${decidedText(mine, WON_ON)}.`);
    }
    const efforts = new Set(each.map((s) => JSON.stringify(s.effort)));
    if (efforts.size > 1 || each.some((s) => s.effort.length > 1)) {
      notes.push('The two models did not play under one identical effort setting in every pair.');
    }
    if (notCounted.length) {
      // cli.not_counted_note
      const leftOut = notCounted.reduce((n, c) => n + c.pairs, 0);
      notes.push(
        `Not counted here: ${leftOut} judged ${leftOut === 1 ? 'pair' : 'pairs'} these two played under other ` +
          `conditions (${notCounted.map((c) => `${c.what}: ${c.pairs}`).join('; ')}). ` +
          'A result holds for the conditions it was played under.',
      );
    }
    const hazards = await ask(questions.pair_hazards, params);
    const runs = {};
    for (const p of pairs) {
      runs[p.run] = { run: p.run, seal_sha256: p.seal, engine_commit: p.engine, suite: p.suite, answer_key: Boolean(p.answer_key) };
    }
    if (profile) {
      // Fit first: is each model fit for the task at all, under the reader's tolerance? Then the head to head.
      const versionKey = pairs.map((p) => p.version).sort(byCodePoint).at(-1);
      const everyone = await fitness(test, versionKey, conditions, suite, profile, overrides, askedBar, checks);
      out.profile = profile;
      if (checks && Object.keys(checks.levels || {}).length) out.own_checks = { levels: checks.levels, needs: checks.kinds ?? null };
      out.fit = { [a]: everyone[a], [b]: everyone[b] };
      [out.outcome, out.headline, out.use] = outcome({ a, b, better, verdict: kind }, out.fit);
      out.rounds = pairs.map((p) => ({
        winner: p.winner,
        rule: p.rule,
        on: p.on,
        a_passed: p.a_passed,
        b_passed: p.b_passed,
        a_right: Boolean(p.a_right),
        b_right: Boolean(p.b_right),
        a_cost: p.a_cost,
        b_cost: p.b_cost,
        run: p.run,
        suite: p.suite,
        match: p.match,
      }));
      // what went wrong, attempt by attempt, in these scenarios (cli.verdict)
      const order = pairs.map((p) => p.match);
      out.went_wrong = whatWentWrong(await ask(questions.what_went_wrong, { run: null, matches: order }), order);
      out.consistency = await ask(questions.self_consistency, { version_key: versionKey, models: [a, b], conditions, suite, until: null });
      out.fit_on_task = Object.entries(everyone)
        .filter(([, f]) => f.fit)
        .map(([model, f]) => ({ model, pass_rate: f.pass_rate, right_rate: f.right_rate, attempts: f.attempts, cost_per_attempt: f.cost_per_attempt }));
    }
    return {
      ...out,
      verdict: kind,
      better,
      pairs: pairs.length,
      wins: { [a]: winsA, [b]: winsB },
      ties,
      p_value: round(pValue, 4),
      decided_by: decidedBy,
      decided_on: decidedOnCounts,
      models: stats,
      hazards: hazards.filter((h) => h.tripped),
      evidence: Object.values(runs).sort((x, y) => byCodePoint(x.run, y.run)),
      conditions,
      not_counted: notCounted,
      notes,
    };
  }

  // Read, act or end, from the tool's name (the record keeps tool names, not their definitions).
  function toolKind(name) {
    if (name === 'finish') return 'ends the task';
    return rules.reads.some((prefix) => name.startsWith(prefix)) ? 'reads' : 'changes something';
  }

  // The spec as data, from a verdict (ledger/spec.py build).
  async function build(v) {
    const judged = 'outcome' in v; // the verdict was read through fitness
    const chosen = (judged ? v.use : v.better) ?? null;
    const decision = {};
    for (const k of ['verdict', 'better', 'a', 'b', 'pairs', 'wins', 'ties', 'p_value', 'decided_by', 'decided_on', 'bar', 'notes']) {
      decision[k] = v[k] ?? null;
    }
    const out = {
      task: v.task,
      version: v.version,
      decision,
      models: v.models || {},
      chosen,
      evidence: v.evidence || [],
    };
    if (judged) {
      Object.assign(decision, { outcome: v.outcome, headline: v.headline, profile: v.profile });
      out.fit = {};
      for (const [model, f] of Object.entries(v.fit)) {
        out.fit[model] = {
          fit: f.fit,
          so_far: f.so_far,
          attempts: f.attempts,
          passed: f.passed,
          pass_rate: f.pass_rate,
          right: f.right,
          right_rate: f.right_rate,
          bar: f.bar,
          reasons: f.reasons,
        };
      }
    }
    if (v.verdict === 'no data') return out;
    const found = await ask(questions.flow_as_tested, {
      test_id: v.task,
      version_key: v.version,
      runs: (v.evidence || []).map((e) => e.run),
    });
    const flow = found.length ? found[0] : {};
    const hazards = await ask(questions.pair_hazards, {
      test_id: v.task,
      a: v.a,
      b: v.b,
      suite: v.suite ?? null,
      version_key: v.version,
      conditions: v.conditions ?? null,
      until: v.until ?? null,
    });
    const guards = [];
    for (const model of chosen ? [chosen] : [v.a, v.b]) {
      for (const h of hazards) {
        if (h.model !== model) continue;
        guards.push({
          model,
          hazard: h.hazard,
          exposed: h.exposed,
          tripped: h.tripped,
          unforgivable: rules.unforgivable.includes(h.hazard),
          // never "can run alone": no trips in N attempts is a count, not a clearance
          seen: h.tripped ? 'needs a guard' : 'not seen',
          guardrail: h.tripped ? (rules.guardrails[h.hazard] ?? null) : null,
        });
      }
    }
    // What went wrong in practice (spec.build): every fault of a decision or an ending the model made on this
    // task, over every attempt it made on it, with its level at the reader's tolerance and a guard to build.
    const seen = [];
    const faultAttempts = {};
    for (const model of chosen ? [chosen] : [v.a, v.b]) {
      const fit = (v.fit || {})[model];
      if (!fit) continue;
      faultAttempts[model] = fit.attempts;
      for (const x of fit.faults || []) {
        if (!rules.fault_kinds.includes(x.kind) || !x.attempts_with) continue;
        const kinds = fit.faults
          .filter((k) => (k.kind_of ?? null) === x.fault && k.attempts_with)
          .sort((p, q) => q.attempts_with - p.attempts_with || byCodePoint(p.fault, q.fault));
        seen.push({
          model,
          fault: x.fault,
          attempts_with: x.attempts_with,
          attempts: fit.attempts,
          share: x.share,
          level: x.level,
          kinds: kinds.map((k) => ({ fault: k.fault, attempts_with: k.attempts_with })),
          guardrail: rules.guardrails[x.fault] ?? null,
        });
      }
    }
    out.blueprint = {
      title: flow.title ?? null,
      brief: flow.brief ?? null,
      policy: flow.policy ?? null,
      tools: (flow.tools || []).map((t) => ({ name: t, kind: toolKind(t) })),
      modelled_on: flow.emulates ?? null,
      settings: {
        effort: flow.effort ?? null,
        max_output_tokens: flow.max_output_tokens ?? null,
        attempt_budget_usd: flow.attempt_budget_usd ?? null,
        difficulty: flow.difficulty ?? null,
        action_budget: flow.action_budget ?? null,
        suites: flow.suites ?? null,
      },
      unforgivable_defaults: rules.unforgivable,
      hazards: guards,
      faults: seen,
      fault_attempts: faultAttempts,
    };
    out.test_fingerprint = flow.content_sha256 ?? null;
    return out;
  }

  const one = (values, isFloat = false) => {
    const kept = (values || []).filter((v) => v !== null && v !== undefined);
    return kept.length ? kept.map((v) => str(v, isFloat)).join(', ') : 'not recorded';
  };

  // The spec as Markdown (ledger/spec.py markdown): the same text `ledger spec` writes.
  function markdown(spec) {
    const d = spec.decision;
    const models = spec.models;
    const { a, b } = d;
    const title = (spec.blueprint || {}).title || spec.task;
    let lines = [
      `# Spec: ${title}`,
      '',
      `Task \`${spec.task}\`, version \`${spec.version}\`. Compared: \`${a}\` and \`${b}\`.`,
      '',
      '## 1. Decision',
      '',
    ];
    if (d.verdict === 'no data') {
      lines.push(`**No decision.** ${d.notes[0]} Run a match between them on this task first.`, '');
      return lines.join('\n');
    }
    const headline = {
      better: `**Use \`${d.better}\` for this task.** It did the task better than the other model.`,
      leaning: `**Leaning \`${d.better}\`, not settled.** It is ahead, but the lead could still be chance.`,
      'no real difference shown': '**No winner.** The pairs show no real difference between the two on this task.',
      'not enough evidence': '**No winner yet.** There are too few head-to-head pairs to call it.',
    }[d.verdict];
    if (d.headline) {
      // fit for the task comes first; the head to head follows as the evidence between the two
      lines.push(`**${d.headline}**`, '', `Fit for this task, at ${d.profile} tolerance:`, '');
      for (const name of [a, b]) {
        const f = spec.fit[name];
        const why = f.reasons.join('; ');
        const lead = f.fit === false ? 'Because' : 'So far';
        lines.push(`- \`${name}\`: **${standing(f)}**. ${resultLine(f)}` + (why ? ` ${lead}: ${why}.` : ''));
      }
      const versus = {
        better: `\`${d.better}\` did this task better than the other model.`,
        leaning: `\`${d.better}\` is ahead, but the lead could still be chance.`,
        'no real difference shown': 'the pairs show no real difference between the two.',
        'not enough evidence': 'too few head-to-head pairs to call it.',
      }[d.verdict];
      lines.push('', `Head to head: ${versus}`, '');
    } else {
      lines.push(headline, '');
    }
    lines.push(`- ${headToHead(d, a, b)}`);
    if (Object.keys(d.decided_on).length) lines.push(`- Decided: ${decidedText(d.decided_on)}.`);
    lines.push('');
    // Read through a tolerance, fitness is said above, over every attempt each model made: a second "good
    // enough" here, over the pair's scenarios only, could contradict it.
    const judged = Boolean(d.headline);
    lines.push(
      '| Model | Right result | Clean runs (result and process) | Cost per attempt | Seconds per attempt | ' +
        `Mistake points per attempt |${judged ? '' : ` Good enough (bar ${percent(d.bar)}) |`}`,
      `|---|---|---|---|---|---|${judged ? '' : '---|'}`,
    );
    for (const name of [a, b]) {
      const s = models[name];
      lines.push(
        `| \`${name}\` | ${s.right} of ${s.attempts} | ${s.passed} of ${s.attempts} | $${fixed(s.cost_per_attempt, 4)} | ` +
          `${fixed(s.seconds_per_attempt, 0)} | ${fixed(s.mistakes, 1)} |${judged ? '' : ` ${s.good_enough ? 'yes' : 'no'} |`}`,
      );
    }
    lines.push('');
    lines = lines.concat(d.notes.map((n) => `- ${n}`), [`- ${MISTAKE_POINTS}`, '']);

    const bp = spec.blueprint;
    const st = bp.settings;
    lines.push(
      '## 2. Blueprint',
      '',
      'What the result was earned on. Build the real flow to match it, then re-test.',
      '',
      '### The job, as tested',
      '',
      `> ${str(bp.brief)}`,
      '',
    );
    if (bp.policy) lines.push('### The rules, as tested', '', `> ${bp.policy}`, '');
    lines.push('### Tools the flow needs', '', '| Tool | What it does |', '|---|---|');
    lines = lines.concat(bp.tools.map((t) => `| \`${t.name}\` | ${t.kind} |`), ['']);
    lines.push(
      '### Settings the result holds for',
      '',
      spec.chosen ? `- Model: \`${spec.chosen}\`` : '- Model: none chosen (see the decision).',
      `- Reasoning effort: ${one(st.effort)}`,
      `- Output limit per call: ${one(st.max_output_tokens)} tokens`,
      `- Hard budget per attempt: $${one(st.attempt_budget_usd, true)}`,
      `- Difficulty level: ${one(st.difficulty)}; action budget ${st.action_budget || 'not recorded'}`,
      '',
    );
    if (bp.modelled_on) lines.push(`The test is modelled on: ${bp.modelled_on}.`, '');
    const who = spec.chosen ? `\`${spec.chosen}\`` : 'each model';
    lines.push(
      '### Guardrails',
      '',
      ...faultLines(spec),
      `Each hazard this task can raise, how ${who} handled it in the ${d.pairs} head-to-head scenarios, and ` +
        'what to build where it tripped.',
      '',
      '| Model | Hazard | Tripped | Reading | Build this |',
      '|---|---|---|---|---|',
    );
    for (const g of bp.hazards) {
      const flag = g.unforgivable ? ' (unforgivable)' : '';
      lines.push(
        `| \`${g.model}\` | ${g.hazard}${flag} | ${g.tripped} of ${g.exposed} | ${g.seen} | ${g.guardrail || '-'} |`,
      );
    }
    const guarded = guardNotes(spec);
    lines.push('', ...guarded, ...(guarded.length ? [''] : []));
    lines.push(
      `Unforgivable by default for a tool-using workflow: ${bp.unforgivable_defaults.join(', ')}. ` +
        'Change the list to fit your flow.',
      '',
      '## 3. Cost',
      '',
      `What these ${d.pairs} head-to-head pairs cost. The cost breakdown report has the scenario-by-scenario detail.`,
      '',
      ...costLines(models, a, b),
      '## 4. Evidence',
      '',
      `- Test version: \`${spec.version}\` (package fingerprint \`${str(spec.test_fingerprint)}\`).`,
      '- Sealed match records:',
    );
    for (const e of spec.evidence) lines.push(`  - ${recordLine(e)}`);
    lines.push(
      '',
      ANSWER_KEYS,
      '',
      'This spec claims only what was measured: this task, in a simulated world, under these settings. Treat it as ' +
        'the starting point for the real flow, and test again once it is built.',
      '',
      DATA_LINE,
      '',
    );
    return lines.join('\n');
  }

  async function spec(workflow, a, b, profile = null, overrides = null) {
    const found = await verdict(workflow, a, b, null, null, rules.min_pairs, profile, overrides);
    return build({ ...found, suite: null });
  }

  // For the page's step 2: who has judged pairs on this flow, and who has met `model` on it.
  async function modelsOnFlow(workflow) {
    const test = testId(workflow);
    const version = await currentVersion(test);
    return ask(MODELS_ON_FLOW, { test_id: test, version_key: version });
  }

  async function partnersOnFlow(workflow, model) {
    const test = testId(workflow);
    const version = await currentVersion(test);
    return ask(PARTNERS_ON_FLOW, { test_id: test, version_key: version, model });
  }

  const flowFaults = () => ask(FLOW_FAULTS, {});

  const scoresOf = (models) => ask(SCORES_OF, { benchmark: rules.benchmark, models });

  return {
    // the page's own two questions, as text, so the graph panel can show what was asked
    text: { modelsOnFlow: MODELS_ON_FLOW, partnersOnFlow: PARTNERS_ON_FLOW },
    searchWords,
    findFlows,
    currentVersion,
    resolveModel,
    opponents,
    levelOf,
    verdict,
    build,
    spec,
    markdown,
    modelsOnFlow,
    partnersOnFlow,
    flowFaults,
    scoresOf,
    referenceConditions,
    conditionsApart,
    stepChecks,
    stepScope,
    process,
    route,
    sameWorld,
    whatDecisionsNeed,
  };
}

