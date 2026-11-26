# Connecting Ledger to an AI assistant

`ledger mcp` serves the Relate store to any assistant that speaks the Model Context Protocol (MCP). It runs on your
own machine, opens the store read-only, and needs no API key of its own.

Do this once first, in a terminal, from the repository folder:

```bash
uv sync
```

## Claude Code
**Simplest: open the repository folder.** The file `.mcp.json` at the root registers the server. The first time,
Claude Code asks you to approve it; say yes. Then check it:

```bash
claude mcp list
```
It should show `ledger` as connected. Inside a session, `/mcp` shows the same, with the number of tools.

**From any other folder,** register it yourself (use the full path to your copy of the repository):

```bash
claude mcp add --transport stdio ledger -- uv run --directory /full/path/to/gladiator-ledger ledger mcp
```

## Claude desktop app
Add this to the app's `claude_desktop_config.json`, using the full path to your copy of the repository, then quit
the app completely and open it again.

```json
{
  "mcpServers": {
    "ledger": {
      "command": "uv",
      "args": ["run", "--directory", "/full/path/to/gladiator-ledger", "ledger", "mcp"]
    }
  }
}
```
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`. Write the path with forward slashes or doubled
  backslashes, for example `C:/Users/you/gladiator-ledger`.
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`.
- The file is reachable from the app's settings (the Developer section has an "Edit Config" button in the layouts
  that have it).

If the app cannot find `uv`, put the full path to `uv` in `"command"` (find it with `where uv` on Windows or
`which uv` on macOS and Linux).

## Any other MCP client
Start the server as a subprocess on stdio with: `uv run --directory /full/path/to/gladiator-ledger ledger mcp`.

## Try it
Ask in plain words, for example:

> I need a model for handling refund requests. I'm using Claude Haiku 5.5. What should I compare it with, and
> which is better at this task? Then write me the spec.

A good session finds the refund workflow, suggests opponents that are close on paper, and asks whether this is
for a business running it unattended or for you alone. It then leads with the answer to act on. Against MiniMax
for one person, as the record stood on Nov 26, 2026, that is "both are fit for this task; Claude Haiku 5.5 is
ahead head to head, **not settled**", with the counts behind it, and it offers the spec. Ask the same about
incident triage and it should say Haiku is the only one of the two that is fit and that it did the task better.
The record grows as live races are imported, so the counts, and in time the answers, can move. Tell it a fault is
unforgivable for you ("it must never act before reading") and the answer should change: on the refund queue it
becomes "neither is fit".

## What the assistant can and cannot do
- It can: find the closest tested workflow, list who has played it, suggest opponents, give a verdict, write the
  spec, and read the graph with its own read-only Cypher.
- It cannot: change the store (it is opened read-only), or run a new match. If two models have not met on a task,
  the right answer is "no match has been played", and the server's instructions tell the assistant to say so.

Setup steps above follow the products' documentation as read on 2026-11-22. Menus move; if a step does not match
what you see, the JSON shape and the command are the parts that matter.
