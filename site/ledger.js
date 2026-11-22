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
]);

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
    return {
      attempts: n,
      passed,
      pass_rate: passed / n,
      cost_per_attempt: sum(pairs.map((p) => p[`${s}_cost`] || 0)) / n,
      seconds_per_attempt: sum(pairs.map((p) => p[`${s}_time`] || 0)) / n,
      mistakes: sum(pairs.map((p) => p[`${s}_mistakes`] || 0)) / n,
      effort: [...new Set(pairs.map((p) => str(p[`${s}_effort`])))].sort(byCodePoint),
    };
  }

  // A task claim: which of two models did THIS task better on the same worlds, how sure that is, and whether
  // either is good enough. No winner is named on thin evidence or a level score.
  async function verdict(workflow, a, b, suite = null, bar = rules.good_enough, minPairs = rules.min_pairs) {
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
    const chosen = v.better ?? null;
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
    lines.push(headline, '');
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
      '## 3. Evidence',
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

  async function spec(workflow, a, b) {
    return build({ ...(await verdict(workflow, a, b)), suite: null });
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

  const scoresOf = (models) => ask(SCORES_OF, { benchmark: rules.benchmark, models });

  return {
    searchWords,
    findFlows,
    currentVersion,
    resolveModel,
    opponents,
    verdict,
    build,
    spec,
    markdown,
    modelsOnFlow,
    partnersOnFlow,
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
