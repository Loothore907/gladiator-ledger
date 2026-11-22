"""The Epoch bridge: published scores are loaded through the shared dock and used only to suggest opponents."""

from pathlib import Path

import relate

from ledger import cli, load
from ledger.bridges import epoch
from tests.test_questions import run

HEADER = "Model,Display name,eci,eci_ci_low,eci_ci_high,date,Organization,Country (of organization),"
HEADER += "Model accessibility,Accessibility group,model_versions"


def scores_file(folder: Path, lines: list[str]) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / epoch.FILE).write_text("\n".join([HEADER, *lines]) + "\n", encoding="utf-8")
    return folder


def test_scores_load_through_the_dock_and_join_only_exact_model_names(tmp_path):
    folder = scores_file(
        tmp_path / "epoch",
        [
            "Claude Haiku 5.5,Claude Haiku 5.5,160.3,158.2,162.7,2026-10-07,Anthropic,USA,API access,Closed weights,",
            "Some Open Model,Some Open Model,159.0,157.0,161.0,2026-09-01,Lab,X,Open weights (unrestricted),Open weights,",
            "No Score Yet,No Score Yet,,,,2026-01-01,Lab,X,API access,Closed weights,",
        ],
    )
    evidence = epoch.read_scores(folder)
    assert [s["model"] for s in evidence.scores] == ["anthropic:claude-haiku-5-5", "epoch:Some Open Model"]
    assert len(evidence.skipped) == 1 and "No Score Yet" in evidence.skipped[0]

    store = str(tmp_path / "s.rl")
    first = load.load_scores(folder, store)
    second = load.load_scores(folder, store)
    assert first["loaded"] == 2 and first["stats"]["nodes_created"] > 0
    assert second["stats"]["nodes_created"] == 0 and second["stats"]["relationships_created"] == 0
    with relate.connect(store, read_only=True) as conn:
        got = conn.execute(
            "MATCH (m:Model)-[s:SCORED]->(b:Benchmark)-[:FROM]->(src:Source) "
            "RETURN m.name AS m, m.weights AS w, s.score AS score, b.name AS b, src.name AS src ORDER BY m"
        ).fetchall()
    assert [(r["m"], r["w"], r["score"], r["src"]) for r in got] == [
        ("anthropic:claude-haiku-5-5", "closed", 160.3, "epoch"),
        ("epoch:Some Open Model", "open", 159.0, "epoch"),
    ]


def test_every_joined_name_is_in_the_shipped_file():
    """A join to a name Epoch no longer uses would silently drop that model's score."""
    shipped = {s["model"] for s in epoch.read_scores(Path("data/epoch")).scores}
    assert set(epoch.MODEL_IDS.values()) <= shipped


def test_opponents_are_the_closest_scores_and_say_what_the_graph_already_knows(tmp_path, capsys):
    # p:a and p:b have played each other; p:c has matches but none against p:a; Far Model scores far away.
    runs = tmp_path / "runs"
    run(runs, "r1", "p:a", "p:b", [(True, False, 0.01, 0.02)] * 3)
    run(runs, "r2", "p:c", "p:b", [(True, False, 0.01, 0.02)] * 3)
    store = str(tmp_path / "s.rl")
    load.load(runs, store)
    folder = scores_file(
        tmp_path / "epoch",
        [
            "A,A,150.0,148.0,152.0,2026-01-01,Lab,X,API access,Closed weights,",
            "B,B,151.0,149.0,153.0,2026-01-01,Lab,X,Open weights (unrestricted),Open weights,",
            "C,C,149.5,147.5,151.5,2026-01-01,Lab,X,API access,Closed weights,",
            "Far Model,Far Model,120.0,118.0,122.0,2026-01-01,Lab,X,Open weights (unrestricted),Open weights,",
        ],
    )
    old = dict(epoch.MODEL_IDS)
    epoch.MODEL_IDS.update({"A": "p:a", "B": "p:b", "C": "p:c"})
    try:
        load.load_scores(folder, store)
    finally:
        epoch.MODEL_IDS.clear()
        epoch.MODEL_IDS.update(old)

    found = cli.opponents(store, "p:a")
    assert [c["model"] for c in found["candidates"]] == ["p:c", "p:b", "epoch:Far Model"]  # nearest first
    by = {c["model"]: c for c in found["candidates"]}
    assert by["p:b"]["pairs_played"] == 3 and by["p:b"]["ranges_overlap"]
    assert by["p:c"]["pairs_played"] == 0 and by["p:c"]["has_matches"]
    assert not by["epoch:Far Model"]["has_matches"] and not by["epoch:Far Model"]["ranges_overlap"]

    assert [c["model"] for c in cli.opponents(store, "p:a", open_only=True)["candidates"]] == ["p:b", "epoch:Far Model"]
    assert cli.opponents(store, "far model")["model"] == "epoch:Far Model"  # found by its display name
    assert len(cli.opponents(store, "p:a", limit=1)["candidates"]) == 1

    # a model with matches but no published score: say so, suggest nobody
    run(runs, "r3", "p:d", "p:b", [(True, False, 0.01, 0.02)] * 3)
    load.load(runs, store)
    assert "no published score" in cli.opponents(store, "p:d")["note"]
    assert cli.main(["opponents", "p:a", "--store", store]) == 0
    assert "Epoch AI" in capsys.readouterr().out
