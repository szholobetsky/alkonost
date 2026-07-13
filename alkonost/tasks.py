"""tasks.py — read/write .1bcoder/tasks/<plan_name>/tasks.md.

Alkonost has NO import dependency on 1bcoder's deepagent_task.py — the
regexes below are ported verbatim from it (same literal patterns) so
alkonost's save path keeps writing rows in a shape deepagent_task's own
parser will still recognize as "existing" on its next run: same id, same
row order/depth, only title/tag-string content may change.

Row format (2-space indent per depth level):

    [ ] <plan_name>-<id>. <title> #tag @module +flag %user due:YYYY-MM-DD _done:YYYY-MM-DD

Everything up to the first #/@/+/%/_ -prefixed token is the title;
everything from there on is the tag string. deepagent_task treats that
trailing string as fully opaque (never parses individual tag values) — this
module additionally tokenizes it (tokenize_tags/serialize_tags) because
alkonost's UI needs individual #tag/@module/+flag/%user/due/_done values to
render filters, board lanes, and edit fields. Token order in the
serialized output is NOT preserved byte-for-byte from the source file —
deepagent_task's own contract never requires that (its docstring: the
trailing string is fully opaque to it); the only real contract is (a) the
row still matches _ROW_RE, (b) the title contains no stray #@+%_ tokens
(guaranteed by sanitize_title), and (c) _done: is present with a non-empty
value iff the row is checked.
"""
import re

_ROW_RE = re.compile(r'^\[([ x])\]\s+.+-([0-9]+(?:\.[0-9]+)*)\.\s*(.*)$')
_TAG_START_RE = re.compile(r'(?:^|\s)([#@+%_]\S*)')
_DONE_RE = re.compile(r'_done:(\S+)')


def sanitize_title(title: str) -> str:
    """Strip #@+%_ characters — identical reasoning to deepagent_task's own
    _sanitize_title: a stray sigil-prefixed token surviving in the title
    would be misread as the start of the tag string on the next parse."""
    return re.sub(r'[#@+%_]', '', title).strip()


def _split_title_and_tags(rest: str):
    m = _TAG_START_RE.search(rest)
    if not m:
        return rest.strip(), ""
    return rest[:m.start(1)].strip(), rest[m.start(1):].strip()


def tokenize_tags(tags_raw: str) -> dict:
    """{"hash": [...], "at": str|None, "plus": [...], "user": str|None,
    "due": str|None, "done": str|None} — alkonost's own finer-grained
    tokenizer, built on top of the opaque tag string deepagent_task itself
    never parses further."""
    result = {"hash": [], "at": None, "plus": [], "user": None, "due": None, "done": None}
    for token in tags_raw.split():
        if token.startswith("#") and len(token) > 1:
            result["hash"].append(token[1:])
        elif token.startswith("@") and len(token) > 1:
            result["at"] = token[1:]
        elif token.startswith("+") and len(token) > 1:
            result["plus"].append(token[1:])
        elif token.startswith("%") and len(token) > 1:
            result["user"] = token[1:]
        elif token.startswith("due:"):
            value = token[len("due:"):]
            result["due"] = value or None
        elif token.startswith("_done:"):
            value = token[len("_done:"):]
            result["done"] = value or None
    return result


def serialize_tags(tags: dict) -> str:
    """Canonical-order join, omitting any empty/None field entirely."""
    parts = []
    for h in tags.get("hash") or []:
        parts.append(f"#{h}")
    if tags.get("at"):
        parts.append(f"@{tags['at']}")
    for p in tags.get("plus") or []:
        parts.append(f"+{p}")
    if tags.get("user"):
        parts.append(f"%{tags['user']}")
    if tags.get("due"):
        parts.append(f"due:{tags['due']}")
    if tags.get("done"):
        parts.append(f"_done:{tags['done']}")
    return " ".join(parts)


def parse_tasks_md(path: str) -> list:
    """[{"id","title","depth","checked","tags_raw","tags"}, ...].
    depth = id.count(".") + 1 (same formula deepagent_task._build_rows
    uses) — not derived from leading whitespace, so it stays robust even if
    indentation was ever hand-edited inconsistently. `checked` is
    recomputed from the tag string's _done: value (single source of truth,
    matching deepagent_task's own mark-derivation logic), not read from the
    on-disk checkbox character."""
    rows = []
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return rows

    for line in lines:
        m = _ROW_RE.match(line.strip())
        if not m:
            continue
        task_id = m.group(2)
        title, tags_raw = _split_title_and_tags(m.group(3))
        depth = task_id.count(".") + 1
        done_match = _DONE_RE.search(tags_raw)
        checked = bool(done_match and done_match.group(1))
        rows.append({
            "id": task_id,
            "title": title,
            "depth": depth,
            "checked": checked,
            "tags_raw": tags_raw,
            "tags": tokenize_tags(tags_raw),
        })
    return rows


def rewrite_tasks_md(path: str, plan_name: str, rows: list) -> None:
    """Whole-file rewrite in the given order/ids only — never reorders,
    never adds/removes a row (row order is tree-derived, never
    user-reorderable; dragging a card between board lanes only toggles
    membership in tags["plus"])."""
    lines = []
    for row in rows:
        depth = row.get("depth") or (row["id"].count(".") + 1)
        indent = "  " * (depth - 1)
        title = sanitize_title(row["title"])
        tags = row["tags"]
        mark = "x" if tags.get("done") else " "
        tags_str = serialize_tags(tags)
        line = f"{indent}[{mark}] {plan_name}-{row['id']}. {title} {tags_str}".rstrip()
        lines.append(line)

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))


def validate_row_ids(existing_rows: list, submitted_rows: list) -> bool:
    """True iff every id currently on disk still appears in the submission,
    in the same relative order — new ids may be inserted anywhere (the
    Add Task/Add Subtask UI), but an existing id going missing or being
    reordered means the client's view is stale (someone reran
    deepagent_task, or another browser tab saved first while this page was
    open) and the save must be rejected rather than silently clobbering it.
    This is a subsequence check, not exact-match: submitted_ids must
    contain existing_ids in order, with any new ids interleaved."""
    existing_ids = [r["id"] for r in existing_rows]
    submitted_ids = [r["id"] for r in submitted_rows]
    it = iter(submitted_ids)
    return all(any(x == eid for x in it) for eid in existing_ids)
