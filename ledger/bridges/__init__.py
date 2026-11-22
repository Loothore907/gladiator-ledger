"""Bridges: where Ledger's evidence comes from.

Ledger's subject is fixed: evidence about which model does a given task better. A bridge is one source of that
evidence. It reads its own files and hands back plain rows in the shared shape below; the loader (ledger/load.py)
writes them to the Relate graph and records which source each row came from, so every answer can be traced to
where its proof lives. A bridge never talks to the graph, and the loader never parses a source's files.

The shared shape, per kind of evidence:
  runs    head-to-head results: one row per run, each with its matches (a pair of attempts on the same task,
          the test version used, who won and by which rule) and each attempt's facts (model, passed, progress,
          mistakes, cost, tokens, time, the hazards it met and tripped on).
  checks  evidence that a test version can be trusted: one row per validation check.

Bridges in this repository: `gladiator` (ledger/bridges/gladiator.py).
"""

from dataclasses import dataclass, field


@dataclass
class Evidence:
    """What one bridge read: rows in the shared shape, plus what it had to skip and why."""

    source: str  # the bridge's name, stored on the graph as (:Source {name})
    description: str = ""
    runs: list[dict] = field(default_factory=list)
    checks: list[dict] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # files refused (for example a seal that does not match)
    records: int = 0  # source files behind `checks` (a run row is one file, so runs need no count)
