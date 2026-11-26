# Gladiator Ledger: the browser demo

One static page that answers Ledger's question in the visitor's browser: of these two AI models, is each fit for
*this* task, which did it better, and what should I build? There is no server and no API key, and it makes no
network request beyond the files in this folder unless a race runner is attached (below).

On load the page starts the Relate graph engine (WebAssembly) in a worker, builds the same graph the `ledger`
command line uses from `data/graph.json`, and then asks it the same Cypher questions. The visitor picks a
workflow and two models that have played each other on it, chooses whose tolerance for mistakes applies, and gets
the result as a fight card: the two models, one square per scenario, the comparison, every fault with a level
they can change, one verdict, and the build spec (the same Markdown `ledger spec` writes). Any scenario replays
as a race, step by step, from `data/replays/`.

**Live races.** The data is every finished, sealed match on file. The page can also ask a Gladiator race runner
for one fresh scenario (or a batch of them) and show it as it happens: open it with `?runner=<address>` for a
runner on your own machine, or set the address in `data/live.json`. With no runner it says live races are open to
the hackathon judges for now. A live result is shown with its sealed record at once, beside the recorded
evidence. It counts in the verdict once its record has been imported (`ledger import --runner`, which the
`Import live races` workflow runs) and this folder's data has been rebuilt from it.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | the page and its three steps |
| `ledger.js` | the answers: a JavaScript mirror of `ledger/cli.py` and `ledger/spec.py` |
| `pyformat.js` | number and JSON formatting that matches Python's, so wording and the spec file are identical |
| `worker.js` | the engine worker: builds the graph once, then runs Cypher sent by the page |
| `data/` | generated: rows and Cypher (`graph.json`, `questions.json`), shared constants (`rules.json`), the answers the Python computed (`expected.json`), one replay file per match record (`replays/`), and the runner's address (`live.json`) |
| `vendor/relate-wasm/` | the engine, `@relate/relate-wasm` (see `VERSION.txt` there) |
| `check.cjs` | compares the page's answers with `data/expected.json` |

## Rebuild the data

From the repository root, after the shipped store or the records change:

```bash
uv run ledger site
```

This rewrites `site/data/`. Do not edit those files by hand.

## Serve it locally

Any static file server works. The page must be served over http(s), not opened as a `file://` URL, because
browsers do not start module workers or WebAssembly from local files.

```bash
python3 -m http.server 8000 --directory site
# then open http://localhost:8000/
```

## Check it

Needs Node.js and Playwright with Chromium.

```bash
node site/check.cjs
```

It serves this folder on a free local port, opens the page in headless Chromium, waits for
`window.ledgerDemo.ready()`, and compares every verdict, spec (and the JSON inside its Markdown), flow search and
opponents answer with `data/expected.json`, numbers within 1e-9. It exits non-zero and prints what differed on any
mismatch, console error, failed request or request to another host.

The same answers are available in the browser console as plain data: `ledgerDemo.flows(text)`,
`ledgerDemo.opponents(model, openOnly)`, `ledgerDemo.verdict(task, a, b)`, `ledgerDemo.spec(task, a, b)` and
`ledgerDemo.specMarkdown(task, a, b)`. `ledgerDemo.cypher(query, params)` runs one Cypher statement on the graph
in the tab (a copy in memory: nothing there reaches the record), for example
`ledgerDemo.cypher('MATCH (m:Model) RETURN m.name')`.

## Host it

Copy this folder to any static host (GitHub Pages, Netlify, an S3 bucket, a plain web server). Every URL is
relative, so it works from any path. The host should send `.wasm` files as `application/wasm` (most do); the
engine file is about 7 MB, and smaller in transit if the host compresses it.

## Credits

Published model scores are used only to suggest a fair opponent, never to rank or recommend. They come from
Epoch AI, "Capabilities & benchmarking" (the Epoch Capabilities Index), epoch.ai/benchmarks, licensed CC BY 4.0;
see `data/epoch/README.md` in the repository root.
