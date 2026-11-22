"""The Epoch bridge: published model scores from Epoch AI's Benchmarking Hub (https://epoch.ai/benchmarks).

Ledger's own claims are about tasks: two models, the same worlds, who did it better. A published score is not such
a claim, and Ledger never ranks by it. It is used for one thing: finding a fair opponent. "Which model scores close
to this one, so the head-to-head is worth running?" is a path through the graph from a model, over a benchmark, to
its neighbours, and on to the matches those two have (or have not) already played.

Source file: data/epoch/eci_scores.csv, a pinned copy of Epoch's Capabilities Index (one combined score per model,
with a confidence interval). Licence: Creative Commons Attribution 4.0; see data/epoch/README.md for the citation.

Only models whose Epoch name is an exact, hand-checked match for a model id Gladiator uses are joined to that id
(MODEL_IDS). Every other Epoch model is loaded under the key "epoch:<Epoch's name>": a candidate opponent that has
no matches yet. A wrong join would attach a score to the wrong model, so a missing one is left missing.
"""

import csv
from pathlib import Path

from ledger.bridges import Evidence

NAME = "epoch"
DESCRIPTION = "Published model scores from Epoch AI's Benchmarking Hub (CC BY 4.0), used to suggest opponents"
BENCHMARK = "Epoch Capabilities Index"
FILE = "eci_scores.csv"

# Epoch's model name -> the exact model id used in Gladiator matches. Exact names only.
MODEL_IDS = {
    "Claude Haiku 5.5": "anthropic:claude-haiku-5-5",
    "Claude Sonnet 5.5": "anthropic:claude-sonnet-5-5",
    "GPT-6 Luna": "openai:gpt-6-luna",
    "GPT-6.1 Terra": "openai:gpt-6.1-terra",
    "Gemini 3.1 Flash-Lite": "google:gemini-3.1-flash-lite",
    "Gemini 3.5 Flash-Lite": "google:gemini-3.5-flash-lite",
    "Gemini 3.8 Flash": "google:gemini-3.8-flash",
    "DeepSeek V4.1 Flash 1017": "openrouter:deepseek/deepseek-v4.1-flash-1017",
    "GLM-5.3": "openrouter:z-ai/glm-5.3",
    "Qwen 3.8 27B": "openrouter:qwen/qwen3.8-27b",
}

WEIGHTS = {"Open weights": "open", "Closed weights": "closed"}


def model_key(epoch_name: str) -> str:
    return MODEL_IDS.get(epoch_name, f"epoch:{epoch_name}")


def read_scores(root: Path) -> Evidence:
    """One score row per model in Epoch's Capabilities Index file under root. Rows without a number are skipped."""
    out = Evidence(source=NAME, description=DESCRIPTION)
    path = Path(root) / FILE
    with path.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            name = (row.get("Model") or "").strip()
            try:
                score, low, high = (float(row[k]) for k in ("eci", "eci_ci_low", "eci_ci_high"))
            except (KeyError, TypeError, ValueError):
                out.skipped.append(f"{path}: {name or '(no name)'} has no usable score")
                continue
            if not name:
                out.skipped.append(f"{path}: a row with no model name")
                continue
            out.scores.append(
                {
                    "model": model_key(name),
                    "model_props": {
                        "display_name": (row.get("Display name") or name).strip(),
                        "organization": (row.get("Organization") or "").strip() or None,
                        "weights": WEIGHTS.get((row.get("Accessibility group") or "").strip(), "other"),
                        "released": (row.get("date") or "").strip() or None,
                    },
                    "benchmark": BENCHMARK,
                    "benchmark_props": {"publisher": "Epoch AI", "url": "https://epoch.ai/benchmarks"},
                    "props": {"score": score, "low": low, "high": high},
                }
            )
    out.records = 1
    return out
