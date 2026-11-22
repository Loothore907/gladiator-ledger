"""Copy Gladiator's public records into this repository's data folder (the shipped store's sources).

Only sealed public files are copied:
  runs/<run_id>/record.json         -> data/records/<run_id>/record.json
  validations/**/<name>@<ver>.json  -> data/validations/<namespace>/<name>@<ver>.json
operator.json (private simulator state) is never read or copied. A record whose seal does not match is refused.
Copying the same file again changes nothing.
"""

import json
import shutil
from pathlib import Path

from ledger.bridges.gladiator import seal_ok


def _sealed(path: Path) -> dict | None:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) and seal_ok(record) else None


def import_records(src: Path, dest: Path) -> dict:
    copied, unchanged, refused = [], 0, []
    for path in sorted(Path(src).rglob("record.json")):
        record = _sealed(path)
        if record is None:
            refused.append(str(path))
            continue
        run_id = record["body"]["run_id"]
        target = Path(dest) / run_id / "record.json"
        if target.exists() and target.read_bytes() == path.read_bytes():
            unchanged += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        copied.append(run_id)
    return {"copied": copied, "unchanged": unchanged, "refused": refused}


def import_validations(src: Path, dest: Path) -> dict:
    copied, unchanged, refused = [], 0, []
    for path in sorted(Path(src).rglob("*.json")):
        record = _sealed(path)
        if record is None or record["body"].get("kind") != "validation":
            refused.append(str(path))
            continue
        ch = record["body"]["challenge"]
        target = Path(dest) / f"{ch['id']}@{ch['version']}.json"
        if target.exists() and target.read_bytes() == path.read_bytes():
            unchanged += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        copied.append(f"{ch['id']}@{ch['version']}")
    return {"copied": copied, "unchanged": unchanged, "refused": refused}
