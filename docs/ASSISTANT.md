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

A good session finds the refund workflow, suggests opponents that are close on paper, gives a verdict with the pair
counts ("MiniMax M3.1 Flash does this task better, 12 of 15 pairs"), and offers the spec. Ask the same about
incident triage and it should say **leaning** Claude Haiku 5.5, not a settled result.

## What the assistant can and cannot do
- It can: find the closest tested workflow, list who has played it, suggest opponents, give a verdict, write the
  spec, and read the graph with its own read-only Cypher.
- It cannot: change the store (it is opened read-only), or run a new match. If two models have not met on a task,
  the right answer is "no match has been played", and the server's instructions tell the assistant to say so.

Setup steps above follow the products' documentation as read on 2026-11-22. Menus move; if a step does not match
what you see, the JSON shape and the command are the parts that matter.
