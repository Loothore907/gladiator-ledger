// Number and JSON formatting that matches what Python prints, so the page's wording and the downloadable spec
// are the same text the `ledger` command line produces.

// The exact decimal digits of |x| (a double has a finite expansion; 100 places is enough to see a tie).
function digitsOf(x) {
  const [whole, frac] = Math.abs(x).toFixed(100).split('.');
  return { whole, frac };
}

// Python's f"{x:.{places}f}": rounded half-to-even on the exact value. `shift` moves the decimal point right
// first (2 for a percentage).
export function fixed(x, places, shift = 0) {
  const { whole, frac } = digitsOf(x);
  const all = whole + frac;
  const keep = whole.length + shift + places;
  const kept = all.slice(0, keep);
  const rest = all.slice(keep);
  let n = BigInt(kept || '0');
  const half = rest[0] === '5' && !/[1-9]/.test(rest.slice(1));
  if (rest[0] > '5' || (rest[0] === '5' && !half) || (half && n % 2n === 1n)) n += 1n;
  const s = n.toString().padStart(places + 1, '0');
  const text = places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s;
  return (x < 0 && n !== 0n ? '-' : '') + text;
}

// Python's f"{x:.{places}%}".
export const percent = (x, places = 0) => `${fixed(x, places, 2)}%`;

// Python's round(x, places).
export const round = (x, places) => Number(fixed(x, places));

// Python's repr() of a float: shortest digits that round-trip, always with a decimal point or an exponent.
export function floatRepr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mantissa, expText] = Math.abs(x).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exp = Number(expText);
  const sign = x < 0 ? '-' : '';
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  const whole = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
  return `${sign}${whole}.${digits.slice(exp + 1) || '0'}`;
}

// Python's str() of a value read from the graph. `isFloat` says a number is a float in Python (so 1 prints "1.0").
export function str(value, isFloat = false) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return isFloat || !Number.isInteger(value) ? floatRepr(value) : String(value);
  return String(value);
}

// Python's sum() over floats (3.12 and later add with Neumaier compensation).
export function sum(values) {
  let total = 0;
  let c = 0;
  for (const x of values) {
    const t = total + x;
    c += Math.abs(total) >= Math.abs(x) ? total - t + x : x - t + total;
    total = t;
  }
  return c && Number.isFinite(c) ? total + c : total;
}

function jsonString(s) {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Python's json.dumps(value, indent=1). JSON cannot tell 1 from 1.0, so `floatKeys` names the keys whose numbers
// (or lists of numbers) are floats in Python.
export function jsonDumps(value, floatKeys = new Set(), depth = 0, isFloat = false) {
  const pad = ' '.repeat(depth + 1);
  const end = ' '.repeat(depth);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value < 0 ? '-Infinity' : 'Infinity';
    return isFloat || !Number.isInteger(value) ? floatRepr(value) : String(value);
  }
  if (typeof value === 'string') return jsonString(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => pad + jsonDumps(v, floatKeys, depth + 1, isFloat)).join(',\n')}\n${end}]`;
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  const items = keys.map((k) => `${pad}${jsonString(k)}: ${jsonDumps(value[k], floatKeys, depth + 1, floatKeys.has(k))}`);
  return `{\n${items.join(',\n')}\n${end}}`;
}
