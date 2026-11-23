// Ledger's answers, in the browser. This mirrors the Python command line (ledger/cli.py and ledger/spec.py):
// the Cypher is the same text (data/questions.json), and the arithmetic and wording here follow the Python line
// for line. site/check.cjs compares the results with the answers the Python produced (data/expected.json).

import { fixed, floatRepr, jsonDumps, percent, round, str, sum } from './pyformat.js';

// Numbers that are floats in Python even when they are whole (JSON cannot tell 1 from 1.0).
const FLOAT_KEYS = new Set([
  'bar',
  'p_value',
  'pass_rate',
  'cost_per_attempt',
  'seconds_per_attempt',
  'mistakes',
  'attempt_budget_usd',
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

const usd = (x, places = 4) => (x === null || x === undefined ? 'none passed' : `$${fixed(x, places)}`);

export function costLines(models, a, b) {
  const lines = [
    '| Model | Cost per attempt | Cost per passed attempt | Per 1,000 runs | Per 1,000 passed runs | Source of the cost |',
    '|---|---|---|---|---|---|',
  ];
  for (const name of [a, b]) {
    const s = models[name];
    const perPass = s.cost_per_pass;
    lines.push(
      `| \`${name}\` | ${usd(s.cost_per_attempt)} | ${usd(perPass)} | ${usd(s.cost_per_attempt * 1000, 2)} | ` +
        `${usd(perPass === null ? null : perPass * 1000, 2)} | ${s.cost_basis.join(', ')} |`,
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
      `| \`${name}\` | ${fixed(s.calls_per_attempt, 1)} | ${fixed(s.tokens_in, 0)} | ${fixed(s.tokens_cached, 0)} (${percent(share)}) | ` +
        `${fixed(s.tokens_out, 0)} | ${fixed(s.seconds_per_attempt, 0)} |`,
    );
  }
  const used = [...new Set([a, b].flatMap((name) => models[name].cost_basis))].sort(byCodePoint);
  lines.push(
    '',
    '- Cost per passed attempt is everything spent divided by the attempts that passed: what one successful ' +
      'result costs, failures included.',
    '- Token counts are averages per attempt. Re-read tokens are the part of the input a provider served from its ' +
      'cache, which it bills at a fraction of the normal price.',
    '- The 1,000-run figures are straight multiples of these attempts, not a quote: your prompts, tools and ' +
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
    lines.push(`- \`${name}\`: $${fixed(s.spent, 4)} over ${s.attempts} attempts, ${s.passed} passed.`);
  }
  if (v.rounds && v.rounds.length) {
    lines.push('', '## Scenario by scenario', '', `| # | \`${a}\` | \`${b}\` | Sealed record |`, '|---|---|---|---|');
    v.rounds.forEach((r, i) => {
      const cells = ['a', 'b'].map((side) => `$${fixed(r[`${side}_cost`] || 0, 4)} (${r[`${side}_passed`] ? 'passed' : 'failed'})`);
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
    lines.push('Every attempt each model made on this task counts here, whoever the opponent was.', '');
    for (const name of [a, b]) {
      const f = v.fit[name];
      const word = f.fit === null ? 'too few attempts to say' : f.fit ? 'fit' : 'not fit';
      lines.push(
        `### \`${name}\`: ${word}`,
        '',
        `Passed ${f.passed} of ${f.attempts} attempts (${percent(f.pass_rate)}; bar ${percent(f.bar)}).`,
        '',
      );
      if (f.faults.length) {
        lines.push('| Fault | Level | Attempts with it | Counts against fitness |', '|---|---|---|---|');
        for (const x of f.faults) {
          lines.push(`| ${x.fault} | ${x.level} | ${x.attempts_with} of ${f.attempts} | ${x.breaks ? 'yes' : 'no'} |`);
        }
      } else lines.push('No fault recorded.');
      lines.push('');
    }
  }
  lines.push(
    '## Head to head',
    '',
    `${v.pairs} judged pairs on the same generated worlds: \`${a}\` won ${v.wins[a]}, \`${b}\` won ` +
      `${v.wins[b]}, ${v.ties} tied (sign test p = ${floatRepr(v.p_value)}).`,
    '',
  );
  for (const n of v.notes) lines.push(`- ${n}`);
  if (v.notes.length) lines.push('');
  if (v.rounds && v.rounds.length) {
    lines.push(`| # | Winner | Decided on | \`${a}\` | \`${b}\` | Sealed record |`, '|---|---|---|---|---|---|');
    v.rounds.forEach((r, i) => {
      const winner = r.winner === 'tie' ? 'tie' : `\`${r.winner}\``;
      lines.push(
        `| ${i + 1} | ${winner} | ${r.rule} | ${r.a_passed ? 'passed' : 'failed'} | ` +
          `${r.b_passed ? 'passed' : 'failed'} | \`${r.run}\` |`,
      );
    });
    lines.push('');
  }
  lines.push('## Sealed records', '');
  for (const e of v.evidence) {
    lines.push(`- \`${e.run}\`, seal \`${str(e.seal_sha256).slice(0, 16)}\`, engine commit \`${str(e.engine_commit).slice(0, 7)}\``);
  }
  lines.push(
    '',
    "Each record's public half and private answer key are published; `ledger verify` checks every seal, and " +
      'anyone can re-grade a match from them.',
    '',
  );
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

export function createLedger(ask, questions, rules) {
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
    const spent = sum(pairs.map((p) => p[`${s}_cost`] || 0));
    return {
      attempts: n,
      passed,
      pass_rate: passed / n,
      cost_per_attempt: spent / n,
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
    const passRate = attempts ? passed / attempts : 0.0;
    const listed = [];
    const reasons = [];
    for (const f of faults) {
      const level = levelOf(test, f.fault, f.kind_of ?? null, profile, overrides);
      const share = attempts ? f.attempts_with / attempts : 0.0;
      let breaks = false;
      if (level === 'unforgivable') breaks = f.attempts_with > 0;
      // a mix-up is already counted in the fault it is a kind of: it explains, it does not decide twice
      else if (level === 'serious') breaks = (f.kind_of ?? null) === null && share > limits.serious_share;
      listed.push({ ...f, level, share: round(share, 4), breaks });
      if (breaks) {
        reasons.push(
          `${f.fault} (${level}) in ${f.attempts_with} of ${attempts} attempts` +
            (level === 'unforgivable' ? '' : `, over the ${percent(limits.serious_share)} allowed`),
        );
      }
    }
    if (passRate < bar) {
      reasons.unshift(`passed ${passed} of ${attempts} attempts (${percent(passRate)}), under the ${percent(bar)} bar`);
    }
    const thin = attempts < limits.min_attempts;
    const order = (e) => policy.levels.indexOf(e.level);
    listed.sort(
      (x, y) =>
        Number(!x.breaks) - Number(!y.breaks) ||
        order(x) - order(y) ||
        y.attempts_with - x.attempts_with ||
        byCodePoint(x.fault, y.fault),
    );
    return {
      fit: thin ? null : reasons.length === 0,
      attempts,
      passed,
      pass_rate: round(passRate, 4),
      bar,
      cost_per_attempt: row.cost_per_attempt ?? null,
      reasons,
      thin,
      faults: listed.filter((e) => e.attempts_with || e.level === 'unforgivable'),
    };
  }

  // Every model's fitness for one task version, counting every attempt it made under those suites' settings.
  async function fitness(test, version, suites, profile, overrides = null, bar = null) {
    const scope = { version_key: version, suites };
    const faults = {};
    for (const { model, ...f } of await ask(questions.task_faults, scope)) (faults[model] ||= []).push(f);
    const out = {};
    for (const r of await ask(questions.task_attempts, scope)) {
      out[r.model] = assess(test, r, faults[r.model] || [], profile, overrides, bar);
    }
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
      const thin = [a, b].filter((m) => fit[m].fit === null);
      return ['too few attempts', `Too few attempts to say whether ${thin.join(' or ')} is fit for this task.`, null];
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
    bar = rules.good_enough,
    minPairs = rules.min_pairs,
    profile = null,
    overrides = null,
  ) {
    const test = testId(workflow);
    const version = await currentVersion(test);
    const params = { test_id: test, a, b, suite, version_key: version };
    const pairs = await ask(questions.pair_on_task, params);
    const out = { task: test, version: version || 'all versions', suite, a, b, bar };
    if (!pairs.length) {
      return { ...out, verdict: 'no data', better: null, pairs: 0, notes: [`${a} and ${b} never met on ${test}.`] };
    }
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
    for (const s of each) s.good_enough = s.pass_rate >= bar;
    if (better && !stats[better].good_enough) {
      notes.push(
        `${better} did better here, but passed only ${percent(stats[better].pass_rate)} of attempts ` +
          `(bar ${percent(bar)}): better than the other one is not the same as good enough.`,
      );
    }
    if (!each.some((s) => s.good_enough)) notes.push(`Neither model reaches the bar of ${percent(bar)} passed on this task.`);
    const efforts = new Set(each.map((s) => JSON.stringify(s.effort)));
    if (efforts.size > 1 || each.some((s) => s.effort.length > 1)) {
      notes.push('The two models did not play under one identical effort setting in every pair.');
    }
    const hazards = await ask(questions.pair_hazards, params);
    const runs = {};
    for (const p of pairs) runs[p.run] = { run: p.run, seal_sha256: p.seal, engine_commit: p.engine, suite: p.suite };
    if (profile) {
      // Fit first: is each model fit for the task at all, under the reader's tolerance? Then the head to head.
      const suites = [...new Set(pairs.map((p) => p.suite))].sort(byCodePoint);
      const versionKey = pairs.map((p) => p.version).sort(byCodePoint).at(-1);
      const everyone = await fitness(test, versionKey, suites, profile, overrides);
      out.profile = profile;
      out.fit = { [a]: everyone[a], [b]: everyone[b] };
      [out.outcome, out.headline, out.use] = outcome({ a, b, better, verdict: kind }, out.fit);
      out.rounds = pairs.map((p) => ({
        winner: p.winner,
        rule: p.rule,
        a_passed: p.a_passed,
        b_passed: p.b_passed,
        a_cost: p.a_cost,
        b_cost: p.b_cost,
        run: p.run,
        match: p.match,
      }));
      out.fit_on_task = Object.entries(everyone)
        .filter(([, f]) => f.fit)
        .map(([model, f]) => ({ model, pass_rate: f.pass_rate, attempts: f.attempts, cost_per_attempt: f.cost_per_attempt }));
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
      models: stats,
      hazards: hazards.filter((h) => h.tripped),
      evidence: Object.values(runs).sort((x, y) => byCodePoint(x.run, y.run)),
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
    for (const k of ['verdict', 'better', 'a', 'b', 'pairs', 'wins', 'ties', 'p_value', 'decided_by', 'bar', 'notes']) {
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
          attempts: f.attempts,
          passed: f.passed,
          pass_rate: f.pass_rate,
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
          autonomy: h.tripped === 0 ? 'can run alone' : 'needs a guard',
          guardrail: h.tripped ? (rules.guardrails[h.hazard] ?? null) : null,
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
      'no real difference shown': '**No winner.** The two models split the pairs evenly on this task.',
      'not enough evidence': '**No winner yet.** There are too few head-to-head pairs to call it.',
    }[d.verdict];
    if (d.headline) {
      // fit for the task comes first; the head to head follows as the evidence between the two
      lines.push(`**${d.headline}**`, '', `Fit for this task, at ${d.profile} tolerance:`, '');
      for (const name of [a, b]) {
        const f = spec.fit[name];
        const word = f.fit === null ? 'too few attempts to say' : f.fit ? 'fit' : 'not fit';
        const why = f.reasons.join('; ');
        lines.push(
          `- \`${name}\`: **${word}**. Passed ${f.passed} of ${f.attempts} attempts on this task ` +
            `(${percent(f.pass_rate)}; bar ${percent(f.bar)}).` +
            (why ? ` Because: ${why}.` : ''),
        );
      }
      const versus = {
        better: `\`${d.better}\` did this task better than the other model.`,
        leaning: `\`${d.better}\` is ahead, but the lead could still be chance.`,
        'no real difference shown': 'the two models split the pairs evenly.',
        'not enough evidence': 'too few head-to-head pairs to call it.',
      }[d.verdict];
      lines.push('', `Head to head: ${versus}`, '');
    } else {
      lines.push(headline, '');
    }
    lines.push(
      `- ${d.pairs} judged pairs on the same generated worlds: \`${a}\` won ${d.wins[a]}, \`${b}\` won ` +
        `${d.wins[b]}, ${d.ties} tied (sign test p = ${floatRepr(d.p_value)}).`,
      `- Decided by: ${decidedText(d.decided_by)}.`,
      '',
      `| Model | Passed | Cost per attempt | Seconds per attempt | Mistakes per attempt | Good enough (bar ${percent(d.bar)}) |`,
      '|---|---|---|---|---|---|',
    );
    for (const name of [a, b]) {
      const s = models[name];
      lines.push(
        `| \`${name}\` | ${s.passed} of ${s.attempts} | $${fixed(s.cost_per_attempt, 4)} | ` +
          `${fixed(s.seconds_per_attempt, 0)} | ${fixed(s.mistakes, 1)} | ${s.good_enough ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
    lines = lines.concat(d.notes.map((n) => `- ${n}`), d.notes.length ? [''] : []);

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
      '### Guardrails and autonomy',
      '',
      `Each hazard this task can raise, how ${who} handled it, and what to build where it tripped.`,
      '',
      '| Model | Hazard | Tripped | Autonomy | Build this |',
      '|---|---|---|---|---|',
    );
    for (const g of bp.hazards) {
      const flag = g.unforgivable ? ' (unforgivable)' : '';
      lines.push(
        `| \`${g.model}\` | ${g.hazard}${flag} | ${g.tripped} of ${g.exposed} | ${g.autonomy} | ${g.guardrail || '-'} |`,
      );
    }
    lines.push(
      '',
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
      '- Sealed match records (public half and private answer key both published; check with `ledger verify`):',
    );
    for (const e of spec.evidence) {
      lines.push(
        `  - \`${e.run}\`, seal \`${str(e.seal_sha256).slice(0, 16)}\`, engine commit \`${str(e.engine_commit).slice(0, 7)}\``,
      );
    }
    lines.push(
      '',
      'This spec claims only what was measured: this task, in a simulated world, under these settings. Treat it as ' +
        'the starting point for the real flow, and test again once it is built.',
      '',
      '## Machine-readable',
      '',
      '```json',
      jsonDumps(spec, FLOAT_KEYS),
      '```',
      '',
    );
    return lines.join('\n');
  }

  async function spec(workflow, a, b, profile = null, overrides = null) {
    const found = await verdict(workflow, a, b, null, rules.good_enough, rules.min_pairs, profile, overrides);
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
  };
}

// "12 on efficiency, 3 on success": the rules that decided the pairs, most common first.
export function decidedText(decidedBy) {
  return Object.entries(decidedBy)
    .sort((x, y) => y[1] - x[1])
    .map(([rule, n]) => `${n} on ${rule}`)
    .join(', ');
}
