"""The MCP server gives an assistant the same answers as the command line, read-only, with Ledger's rules."""

import asyncio
import sys
from pathlib import Path

from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

from ledger import assistant, cli, spec
from tests.test_spec import build as build_flows

ROOT = Path(__file__).resolve().parent.parent


def call(server, name, arguments):
    async def go():
        async with Client(server) as client:
            return await client.call_tool(name, arguments)

    return asyncio.run(go())


def test_tools_give_the_command_lines_answers(tmp_path):
    store = build_flows(tmp_path)
    server = assistant.build(store)

    found = call(server, "find_flows", {"description": "handle refunds for my shop"}).structured_content
    assert found["matched"] and found["flows"][0]["test"] == "t/refunds"

    played = call(server, "who_has_played", {"task": "t/refunds"}).structured_content
    assert [m["model"] for m in played["models"]] == ["p:a", "p:b"]
    met = call(server, "who_has_played", {"task": "t/refunds", "model": "p:a"}).structured_content
    assert met["has_met"] == [{"model": "p:b", "display_name": None, "pairs_against_it": 10}]

    answer = call(server, "verdict", {"task": "t/refunds", "model_a": "p:a", "model_b": "p:b"}).structured_content
    assert answer == cli.verdict(store, "t/refunds", "p:a", "p:b")  # the same function, the same answer

    text = call(server, "write_spec", {"task": "t/refunds", "model_a": "p:a", "model_b": "p:b"}).content[0].text
    expected = cli.verdict(store, "t/refunds", "p:a", "p:b")
    expected["suite"] = None
    assert text == spec.markdown(spec.build(lambda q, p: cli.rows(store, q, p), expected))


def test_no_winner_is_handed_to_the_assistant_when_there_is_none(tmp_path):
    store = build_flows(tmp_path)
    server = assistant.build(store)
    thin = call(server, "verdict", {"task": "t/access", "model_a": "p:a", "model_b": "p:b"}).structured_content
    assert (thin["verdict"], thin["better"]) == ("not enough evidence", None)
    never = call(server, "verdict", {"task": "t/access", "model_a": "p:a", "model_b": "p:z"}).structured_content
    assert (never["verdict"], never["better"]) == ("no data", None)
    assert "no published score" in call(server, "suggest_opponents", {"model": "p:a"}).structured_content["note"]


def test_the_graph_can_be_read_but_never_written(tmp_path):
    store = build_flows(tmp_path)
    server = assistant.build(store)
    described = call(server, "describe_graph", {}).structured_content
    assert "pair_on_task" in described["named_questions"] and {"kind": "Model", "n": 2} in described["counts"]

    rows = call(server, "read_graph", {"cypher": "MATCH (m:Model) RETURN m.name AS name ORDER BY name"})
    assert rows.structured_content["rows"] == [{"name": "p:a"}, {"name": "p:b"}]
    named = call(server, "read_graph", {"named_question": "flows"}).structured_content
    assert [r["test"] for r in named["rows"]] == ["t/access", "t/refunds"]

    refused = call(server, "read_graph", {"cypher": "CREATE (:Model {name: 'made-up'})"}).structured_content
    assert "error" in refused and "read-only" in refused["error"].lower()
    assert cli.rows(store, "MATCH (m:Model) RETURN count(m) AS n") == [{"n": 2}]  # nothing was written
    assert "error" in call(server, "read_graph", {"named_question": "no_such_question"}).structured_content


def test_instructions_carry_the_rules():
    text = assistant.INSTRUCTIONS
    for rule in ("task claims only", "Never name a winner", "never rank models by a published score", "leaning"):
        assert rule in text


def test_the_real_server_answers_over_stdio(tmp_path):
    """Start `ledger mcp` as a client would (a subprocess on stdio) and ask it one question end to end."""
    store = build_flows(tmp_path)
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "ledger.cli", "mcp", "--store", store], cwd=str(ROOT)
    )

    async def go():
        async with Client(params) as client:
            tools = {t.name for t in (await client.list_tools()).tools}
            answer = await client.call_tool("verdict", {"task": "t/refunds", "model_a": "p:a", "model_b": "p:b"})
            return tools, client.instructions, answer.structured_content

    tools, instructions, answer = asyncio.run(go())
    assert {"find_flows", "who_has_played", "suggest_opponents", "verdict", "write_spec", "read_graph"} <= tools
    assert "task claims only" in instructions
    assert (answer["verdict"], answer["better"], answer["pairs"]) == ("better", "p:a", 10)
