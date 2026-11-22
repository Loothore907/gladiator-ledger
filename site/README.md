# Gladiator Ledger: the browser demo

One static page that answers Ledger's question in the visitor's browser: of these two AI models, which does
*this* task better, how sure is that, and what should I build? There is no server, no API key and no network
request beyond the files in this folder.

On load the page starts the Relate graph engine (WebAssembly) in a worker, builds the same graph the `ledger`
command line uses from `data/graph.json`, and then asks it the same Cypher questions. The visitor describes or
picks a workflow, picks two models that have played each other on it, and gets the verdict, the comparison, the
build spec (downloadable as the same Markdown `ledger spec` writes) and a small picture of the graph path the
answer came from. The data is a fixed set of finished matches: the page cannot run new ones.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | the page and its three steps |
| `ledger.js` | the answers: a JavaScript mirror of `ledger/cli.py` and `ledger/spec.py` |
| `pyformat.js` | number and JSON formatting that matches Python's, so wording and the spec file are identical |
| `worker.js` | the engine worker: builds the graph once, then runs Cypher sent by the page |
| `data/` | generated: rows and Cypher (`graph.json`, `questions.json`), shared constants (`rules.json`), and the answers the Python computed (`expected.json`) |
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
`ledgerDemo.specMarkdown(task, a, b)`.

## Host it

Copy this folder to any static host (GitHub Pages, Netlify, an S3 bucket, a plain web server). Every URL is
relative, so it works from any path. The host should send `.wasm` files as `application/wasm` (most do); the
engine file is about 7 MB, and smaller in transit if the host compresses it.

## Credits

Published model scores are used only to suggest a fair opponent, never to rank or recommend. They come from
Epoch AI, "Capabilities & benchmarking" (the Epoch Capabilities Index), epoch.ai/benchmarks, licensed CC BY 4.0;
see `data/epoch/README.md` in the repository root.
