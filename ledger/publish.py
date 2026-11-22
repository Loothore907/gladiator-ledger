"""Copy Gladiator's sealed records into this repository's data folder (the shipped store's sources), and check them.

  runs/<run_id>/record.json         -> data/records/<run_id>/record.json     the public half, sealed
  runs/<run_id>/operator.json       -> data/records/<run_id>/operator.json   the private half (see below)
  validations/**/<name>@<ver>.json  -> data/validations/<namespace>/<name>@<ver>.json

The private half of a match holds the answer key of every generated world: the right decision for each item and
which items were traps. It is published with a FINISHED match so anyone can check the result, under two rules:
  - only when every test in the match generates a fresh world per attempt (`instances: generator`), so the answers
    cannot help anyone on a later match. A match that includes a fixed test is published without its private half;
  - only when it matches the fingerprint its public record carries (`operator_sha256`). A private half that does
    not match is refused together with its record.
A record whose own seal does not match is refused. Copying the same file again changes nothing.
"""

import json
import shutil
from pathlib import Path

from ledger.bridges.gladiator import canonical_sha256, seal_ok


def _sealed(path: Path) -> dict | None:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) and seal_ok(record) else None


def fresh_worlds_only(record: dict) -> bool:
    """True when every test in the match generates a fresh world per attempt (so its answers are spent)."""
    kinds = {
        (res.get("challenge") or {}).get("instances")
        for side in record["body"]["contestants"].values()
        for res in side["results"]
    }
    return kinds == {"generator"}


def private_half_matches(record: dict, private_path: Path) -> bool:
    try:
        private = json.loads(private_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return canonical_sha256(private) == record["body"].get("operator_sha256")


def _copy(src: Path, target: Path) -> bool:
    """Copy unless the target already holds the same bytes. True when something was written."""
    if target.exists() and target.read_bytes() == src.read_bytes():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, target)
    return True


def import_records(src: Path, dest: Path, private: bool = True) -> dict:
    copied, unchanged, refused, private_copied, private_withheld = [], 0, [], [], []
    for path in sorted(Path(src).rglob("record.json")):
        record = _sealed(path)
        if record is None:
            refused.append(str(path))
            continue
        run_id = record["body"]["run_id"]
        private_src = path.with_name("operator.json")
        publish_private = private and private_src.exists()
        if publish_private and not fresh_worlds_only(record):
            private_withheld.append(run_id)  # a fixed test's answers stay private
            publish_private = False
        if publish_private and not private_half_matches(record, private_src):
            refused.append(f"{private_src} (does not match the fingerprint in its record)")
            continue
        if _copy(path, Path(dest) / run_id / "record.json"):
            copied.append(run_id)
        else:
            unchanged += 1
        if publish_private and _copy(private_src, Path(dest) / run_id / "operator.json"):
            private_copied.append(run_id)
    return {
        "copied": copied,
        "unchanged": unchanged,
        "refused": refused,
        "private_copied": private_copied,
        "private_withheld": private_withheld,
    }


def verify(dest: Path) -> dict:
    """Check every shipped match: the public record's seal, and the private half against the record's fingerprint.
    Returns counts and a list of problems (empty when everything checks out)."""
    records = private = 0
    problems = []
    for path in sorted(Path(dest).rglob("record.json")):
        records += 1
        record = _sealed(path)
        if record is None:
            problems.append(f"{path}: the record does not match its seal")
            continue
        private_path = path.with_name("operator.json")
        if not private_path.exists():
            continue
        private += 1
        if not fresh_worlds_only(record):
            problems.append(f"{private_path}: a private half is published for a match that includes a fixed test")
        elif not private_half_matches(record, private_path):
            problems.append(f"{private_path}: does not match the fingerprint in its record")
    for stray in sorted(Path(dest).rglob("operator.json")):
        if not stray.with_name("record.json").exists():
            problems.append(f"{stray}: a private half with no record beside it")
    return {"records": records, "private_halves": private, "problems": problems}


def import_validations(src: Path, dest: Path) -> dict:
    copied, unchanged, refused = [], 0, []
    for path in sorted(Path(src).rglob("*.json")):
        record = _sealed(path)
        if record is None or record["body"].get("kind") != "validation":
            refused.append(str(path))
            continue
        ch = record["body"]["challenge"]
        target = Path(dest) / f"{ch['id']}@{ch['version']}.json"
        if _copy(path, target):
            copied.append(f"{ch['id']}@{ch['version']}")
        else:
            unchanged += 1
    return {"copied": copied, "unchanged": unchanged, "refused": refused}
