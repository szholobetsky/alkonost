"""planmd.py — read-only parsing of deepagent_md's item_<id>.md tree.

Independent re-implementation (no import dependency on 1bcoder) against the
same on-disk convention: item_<id>.md files live directly in a plan
directory (.1bcoder/planMD/<plan_name>/), <id> is a dot-separated integer
path (e.g. item_1.2.3.md), first line is "# {title}", and a node's children
are ids one level deeper sharing its own id as a dotted prefix.
"""
import os
import re

_ITEM_RE = re.compile(r'^item_([\d.]+)\.md$')


def _item_path(plan_dir: str, node_id: str) -> str:
    return os.path.join(plan_dir, f"item_{node_id}.md")


def collect_node_ids(plan_dir: str) -> set:
    ids = set()
    if not os.path.isdir(plan_dir):
        return ids
    for fname in os.listdir(plan_dir):
        m = _ITEM_RE.match(fname)
        if m:
            ids.add(m.group(1))
    return ids


def read_title(plan_dir: str, node_id: str) -> str:
    try:
        with open(_item_path(plan_dir, node_id), encoding="utf-8") as f:
            first_line = f.readline()
        return first_line.lstrip("#").strip()
    except OSError:
        return node_id


def read_item(plan_dir: str, node_id: str) -> str:
    """Raw file content, or "" if missing."""
    try:
        with open(_item_path(plan_dir, node_id), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def write_item_raw(plan_dir: str, node_id: str, raw: str) -> None:
    """Writes user-edited raw text verbatim — same "trust the human editing
    an already-generated file" convention as tasks.md/colors.md/spec files.
    A malformed title line just means read_title()'s next call falls back
    to the bare node_id, no different from any other missing/odd file."""
    with open(_item_path(plan_dir, node_id), "w", encoding="utf-8") as f:
        f.write(raw)


def child_ids(node_id: str, all_ids: set) -> list:
    prefix = node_id + "."
    depth = node_id.count(".") + 2
    kids = [i for i in all_ids if i.startswith(prefix) and i.count(".") == depth - 1]
    return sorted(kids, key=lambda x: tuple(int(p) for p in x.split(".")))


def is_leaf(node_id: str, all_ids: set) -> bool:
    return not child_ids(node_id, all_ids)


def build_tree(plan_dir: str) -> list:
    """[{"id","title","children":[...nested...]}, ...] — top-level nodes
    (single-segment ids), each recursively populated with its children.
    Powers the "direct planMD browsing" requirement (concepts/ALKONOST.md
    §4) independent of any task row."""
    all_ids = collect_node_ids(plan_dir)

    def _node(node_id: str) -> dict:
        return {
            "id": node_id,
            "title": read_title(plan_dir, node_id),
            "is_leaf": is_leaf(node_id, all_ids),
            "children": [_node(c) for c in child_ids(node_id, all_ids)],
        }

    roots = sorted(
        (i for i in all_ids if "." not in i),
        key=lambda x: int(x),
    )
    return [_node(r) for r in roots]
