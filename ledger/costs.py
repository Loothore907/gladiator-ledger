"""What each call really cost.

Match records made before 2026-11-23 hold a list-price estimate of each call's cost, and a check against the
providers' bills on that date showed the estimate was wrong in two ways (fixed in the engine since,
Loothore907/gladiator-core#6):

  * Claude Haiku 5.5 was priced with no cache-read rate, so cache reads (about 95% of the input in these tasks)
    were charged as plain input: about four times its real cost.
  * Models run through OpenRouter were priced from its list, but OpenRouter bills the same model at different
    rates depending on the host that served the call: from 0.7 to 2.5 times the estimate, model by model.

A sealed record cannot be changed, so the correction is applied when it is read, and every attempt says where its
cost came from (`cost_basis`):

  billed     what the provider charged for each call: a record made by the fixed engine, or an OpenRouter call
             looked up afterwards by its id (`billed.json` beside the record)
  repriced   recomputed from the record's own token counts at the provider's published price (Haiku 5.5)
  list       the record's list-price estimate, unchanged (OpenAI and Google matched their bills; and any
             OpenRouter call whose charge could not be looked up)
  mixed      some of each within one attempt

The corrected figures change costs and so the pairs decided on efficiency. They change no pass, fault or grade.
"""

import copy
import json
from pathlib import Path

# Published prices, USD per million tokens, for models the old engine priced wrongly. Source and date in the row.
REPRICE = {
    "anthropic:claude-haiku-5-5": {
        "input": 0.10,
        "cached_input": 0.01,
        "cache_write": 0.125,
        "output": 0.50,
        "source": "https://platform.claude.com/docs/en/about-claude/pricing (read 2026-11-23; prompts up to 100,000 tokens)",
    },
}


def reprice(turn: dict, price: dict) -> float:
    u = turn.get("usage") or {}
    cached, written = u.get("cached_input_tokens") or 0, u.get("cache_write_tokens") or 0
    plain = max(0, (u.get("input_tokens") or 0) - cached - written)
    return (
        plain * price["input"]
        + cached * price["cached_input"]
        + written * price["cache_write"]
        + (u.get("output_tokens") or 0) * price["output"]
    ) / 1_000_000


def read_billed(record_path: Path, record_sha256: str) -> dict:
    """The looked-up charges beside a record ({call id: USD}), if the file is there and belongs to this record."""
    path = Path(record_path).with_name("billed.json")
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("record_sha256") != record_sha256:
        return {}  # looked up for a different record: not this one's evidence
    return {call: float(v["total_cost"]) for call, v in (data.get("calls") or {}).items()}


def corrected(body: dict, billed: dict | None = None) -> dict:
    """A copy of a record's body with every call's real cost, each attempt's total, and where each came from."""
    billed = billed or {}
    out = copy.deepcopy(body)
    for contestant in out["contestants"].values():
        price = REPRICE.get(contestant["id"])
        for result in contestant["results"]:
            bases = set()
            for turn in result.get("turns") or []:
                if "list_cost_usd" in turn:  # the fixed engine: cost_usd is already the cost of record
                    said = (turn.get("usage") or {}).get("billed_usd") is not None
                    bases.add("billed" if said else "list")
                elif turn.get("response_id") in billed:
                    turn["cost_usd"] = billed[turn["response_id"]]
                    bases.add("billed")
                elif price:
                    turn["cost_usd"] = reprice(turn, price)
                    bases.add("repriced")
                else:
                    bases.add("list")
            if result.get("turns"):
                result["cost_usd"] = sum(float(t.get("cost_usd") or 0) for t in result["turns"])
            result["cost_basis"] = bases.pop() if len(bases) == 1 else ("mixed" if bases else "list")
    if isinstance(out.get("budget"), dict):  # what the match really cost, by the same figures
        out["budget"]["spent_usd"] = sum(
            float(r.get("cost_usd") or 0) for c in out["contestants"].values() for r in c["results"]
        )
    return out
