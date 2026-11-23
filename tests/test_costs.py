import copy

from ledger import costs

HAIKU = "anthropic:claude-haiku-5-5"


def turn(call, cost, cached=900, **more):
    usage = {"input_tokens": 1000, "cached_input_tokens": cached, "output_tokens": 100}
    return {"response_id": call, "cost_usd": cost, "usage": usage, **more}


def body():
    return {
        "budget": {"spent_usd": 9.0},
        "contestants": {
            "A": {"id": HAIKU, "results": [{"cost_usd": 0.5, "turns": [turn("m1", 0.5)]}]},
            "B": {
                "id": "openrouter:x/y",
                "results": [{"cost_usd": 0.3, "turns": [turn("gen-1", 0.1), turn("gen-2", 0.2)]}],
            },
            "C": {"id": "openai:z", "results": [{"cost_usd": 0.7, "turns": [turn("r1", 0.7)]}]},
        },
    }


def test_each_attempt_gets_its_real_cost_and_says_where_it_came_from():
    original = body()
    fixed = costs.corrected(copy.deepcopy(original), {"gen-1": 0.25, "gen-2": 0.5})
    a, b, c = (fixed["contestants"][s]["results"][0] for s in "ABC")
    # Haiku: recomputed from the record's own tokens at the published price (cache reads at a tenth of input)
    expected = (100 * 0.10 + 900 * 0.01 + 100 * 0.50) / 1_000_000
    assert abs(a["cost_usd"] - expected) < 1e-12 and a["cost_basis"] == "repriced"
    # OpenRouter: what was billed for each call
    assert (b["cost_usd"], b["cost_basis"]) == (0.75, "billed")
    # everyone else: the record's own figure, untouched
    assert (c["cost_usd"], c["cost_basis"]) == (0.7, "list")
    assert abs(fixed["budget"]["spent_usd"] - (expected + 0.75 + 0.7)) < 1e-12
    assert original == body()  # the record handed in is never changed


def test_a_call_that_could_not_be_looked_up_keeps_its_estimate_and_the_attempt_says_mixed():
    fixed = costs.corrected(body(), {"gen-1": 0.25})
    b = fixed["contestants"]["B"]["results"][0]
    assert (b["cost_usd"], b["cost_basis"]) == (0.45, "mixed")
    assert costs.corrected(body())["contestants"]["B"]["results"][0]["cost_basis"] == "list"


def test_a_record_from_the_fixed_engine_is_left_alone():
    new = body()
    for c in new["contestants"].values():
        for t in c["results"][0]["turns"]:
            t["list_cost_usd"] = t["cost_usd"] / 2
            t["usage"]["billed_usd"] = t["cost_usd"] if c["id"].startswith("openrouter") else None
    fixed = costs.corrected(new, {"gen-1": 99.0})  # a stray look-up must not override the engine's own figure
    a, b, _ = (fixed["contestants"][s]["results"][0] for s in "ABC")
    assert (a["cost_usd"], a["cost_basis"]) == (0.5, "list")
    assert (round(b["cost_usd"], 9), b["cost_basis"]) == (0.3, "billed")


def test_looked_up_charges_only_count_for_the_record_they_were_fetched_for(tmp_path):
    import json

    (tmp_path / "record.json").write_text("{}")
    (tmp_path / "billed.json").write_text(
        json.dumps({"record_sha256": "abc", "calls": {"gen-1": {"total_cost": 0.25}}})
    )
    assert costs.read_billed(tmp_path / "record.json", "abc") == {"gen-1": 0.25}
    assert costs.read_billed(tmp_path / "record.json", "some other record") == {}
    assert costs.read_billed(tmp_path / "missing" / "record.json", "abc") == {}
