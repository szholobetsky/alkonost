import os
import re
import shutil

from conftest import PROJ_A
from alkonost import tasks

TASKS_PATH = os.path.join(PROJ_A, ".1bcoder", "tasks", "plan1", "tasks.md")

# The exact contract deepagent_task.py itself uses (re-declared here, not
# imported, since alkonost has zero import dependency on 1bcoder) — a save
# from alkonost must keep every row recognizable by these same patterns.
_DEEPAGENT_TASK_ROW_RE = re.compile(r'^\[([ x])\]\s+.+-([0-9]+(?:\.[0-9]+)*)\.\s*(.*)$')
_DEEPAGENT_TASK_TAG_START_RE = re.compile(r'(?:^|\s)([#@+%_]\S*)')
_DEEPAGENT_TASK_DONE_RE = re.compile(r'_done:(\S+)')


def test_parse_tasks_md_row_shape():
    rows = tasks.parse_tasks_md(TASKS_PATH)
    assert len(rows) == 4
    by_id = {r["id"]: r for r in rows}

    assert by_id["1"]["title"] == "Root Feature"
    assert by_id["1"]["depth"] == 1
    assert by_id["1"]["tags"]["plus"] == ["backlog"]
    assert by_id["1"]["checked"] is False

    leaf = by_id["1.1.1"]
    assert leaf["depth"] == 3
    assert leaf["tags"]["hash"] == ["backend"]
    assert leaf["tags"]["plus"] == ["active"]
    assert leaf["tags"]["user"] == "user1"
    assert leaf["tags"]["due"] == "2026-07-29"

    urgent_row = by_id["1.2"]
    assert urgent_row["tags"]["plus"] == ["urgent"]


def test_tokenize_and_serialize_round_trip():
    raw = "#backend @backend +active %user1 due:2026-07-29 _done:2026-07-30"
    tags = tasks.tokenize_tags(raw)
    assert tags == {
        "hash": ["backend"], "at": "backend", "plus": ["active"],
        "user": "user1", "due": "2026-07-29", "done": "2026-07-30",
    }
    reserialized = tasks.serialize_tags(tags)
    assert tasks.tokenize_tags(reserialized) == tags


def test_serialize_tags_omits_empty_done():
    tags = {"hash": [], "at": None, "plus": ["backlog"], "user": None, "due": None, "done": None}
    assert tasks.serialize_tags(tags) == "+backlog"


def test_sanitize_title_strips_sigils():
    assert tasks.sanitize_title("Fix #bug in @module +now") == "Fix bug in module now"


def test_rewrite_preserves_deepagent_task_contract(tmp_path):
    src = tmp_path / "tasks.md"
    shutil.copy(TASKS_PATH, src)

    rows = tasks.parse_tasks_md(str(src))
    # simulate a UI edit: move a row from +backlog to +active, mark another done
    root = next(r for r in rows if r["id"] == "1")
    root["tags"]["plus"] = ["active"]
    child_two = next(r for r in rows if r["id"] == "1.2")
    child_two["tags"]["done"] = "2026-08-01"

    tasks.rewrite_tasks_md(str(src), "plan1", rows)

    with open(src, encoding="utf-8") as f:
        lines = [l for l in f.read().splitlines() if l.strip()]

    assert len(lines) == len(rows)
    for line in lines:
        m = _DEEPAGENT_TASK_ROW_RE.match(line.strip())
        assert m, f"row no longer matches deepagent_task's own _ROW_RE: {line!r}"
        task_id = m.group(2)
        title_and_tags = m.group(3)
        tag_match = _DEEPAGENT_TASK_TAG_START_RE.search(title_and_tags)
        assert tag_match, f"no tag-start token found in {title_and_tags!r}"
        title = title_and_tags[:tag_match.start(1)].strip()
        assert not re.search(r'[#@+%_]', title), "title leaked a sigil character"

        if task_id == "1.2":
            done_match = _DEEPAGENT_TASK_DONE_RE.search(title_and_tags)
            assert done_match and done_match.group(1) == "2026-08-01"
            assert m.group(1) == "x"  # checkbox mark derived from _done: presence

    # re-parse and confirm the edits survive a fresh parse
    reparsed = {r["id"]: r for r in tasks.parse_tasks_md(str(src))}
    assert reparsed["1"]["tags"]["plus"] == ["active"]
    assert reparsed["1.2"]["checked"] is True
    assert reparsed["1.2"]["tags"]["done"] == "2026-08-01"


def test_validate_row_ids():
    rows = tasks.parse_tasks_md(TASKS_PATH)
    assert tasks.validate_row_ids(rows, rows) is True

    reordered = list(reversed(rows))
    assert tasks.validate_row_ids(rows, reordered) is False

    dropped = rows[:-1]
    assert tasks.validate_row_ids(rows, dropped) is False


def test_validate_row_ids_allows_new_rows_inserted_anywhere():
    # Add Task / Add Subtask grow the row set — as long as every existing
    # id is still present, in order, new ids may be interleaved anywhere.
    rows = tasks.parse_tasks_md(TASKS_PATH)

    appended = rows + [{"id": "9", "title": "New root task", "tags": {}}]
    assert tasks.validate_row_ids(rows, appended) is True

    inserted_in_middle = rows[:1] + [{"id": "1.1.1.99", "title": "New subtask", "tags": {}}] + rows[1:]
    assert tasks.validate_row_ids(rows, inserted_in_middle) is True

    # still rejects a missing existing id even when new ones are also added
    dropped_plus_new = rows[:-1] + [{"id": "9", "title": "New root task", "tags": {}}]
    assert tasks.validate_row_ids(rows, dropped_plus_new) is False
