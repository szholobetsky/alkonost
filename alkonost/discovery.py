"""discovery.py — bounded recursive search for .1bcoder project roots.

Alkonost is started from a common ancestor directory that may contain
several independent projects (each with its own project-local .1bcoder/).
This module walks that ancestor directory looking for every .1bcoder/ it
can find, treating the directory that directly contains it as a "project
root". Recursion is bounded (max_depth) and prunes a fixed ignore-list of
directory names, since walking an entire home directory or drive root
would otherwise be slow or simply wrong (see concepts/ALKONOST.md open
question 5).

Once a .1bcoder/ is found, its own contents are read directly via
os.listdir (see list_plans) — never walked further by this module; only
sibling/cousin directories elsewhere in the tree keep being searched for
other projects.
"""
import hashlib
import os

IGNORE_DIRS = {
    ".git", "node_modules", "venv", ".venv", "__pycache__",
    "dist", "build", ".idea", ".vscode",
    # no projects live here, only temporary copies left by tests and tools (tmpXXXX/.1bcoder,
    # pytest-of-<user>/...) — started from the home folder they flooded the project list
    "AppData", "Temp", "tmp",
}

_DOT1BCODER = ".1bcoder"


def project_id(root_path: str) -> str:
    """Deterministic id for a project root — same path always yields the
    same id, so re-scanning never needs cache-invalidation logic."""
    return hashlib.sha1(os.path.abspath(root_path).encode("utf-8")).hexdigest()[:12]


def _should_descend(name: str) -> bool:
    if name in IGNORE_DIRS:
        return False
    if name.startswith(".") and name != _DOT1BCODER:
        return False
    return True


def _walk(dir_path: str, depth: int, max_depth: int, found: list) -> None:
    try:
        entries = list(os.scandir(dir_path))
    except OSError:
        return

    for entry in entries:
        if not entry.is_dir(follow_symlinks=False):
            continue
        # a Windows junction is a second road to a folder found elsewhere (C:\Users\<u>\Local Settings
        # -> AppData\Local): following it lists the same projects twice. is_dir(follow_symlinks=False)
        # stops symlinks but not junctions; DirEntry.is_junction() exists from Python 3.12
        if getattr(entry, "is_junction", lambda: False)():
            continue
        if entry.name == _DOT1BCODER:
            found.append(dir_path)
            continue
        if depth >= max_depth:
            continue
        if not _should_descend(entry.name):
            continue
        _walk(entry.path, depth + 1, max_depth, found)


def _count_plans(project_root: str) -> int:
    planmd_dir = os.path.join(project_root, _DOT1BCODER, "planMD")
    if not os.path.isdir(planmd_dir):
        return 0
    return sum(1 for e in os.scandir(planmd_dir) if e.is_dir())


def discover_projects(root: str, max_depth: int = 6) -> dict:
    """{id: {"root": abs_path, "name": basename, "plan_count": n}}."""
    root = os.path.abspath(root)
    found = []
    _walk(root, 0, max_depth, found)

    result = {}
    for proj_root in found:
        pid = project_id(proj_root)
        result[pid] = {
            "root": proj_root,
            "name": os.path.basename(proj_root),
            "plan_count": _count_plans(proj_root),
        }
    return result


# ── making a folder a project ───────────────────────────────────────────
# A project is nothing but a folder holding .1bcoder/, so "creating" one means creating
# that folder. Only a folder discovery would find again counts: inside the scan root,
# not deeper than max_depth, not under a folder the walk skips (.git, node_modules, …).

class ProjectPathError(ValueError):
    pass


def _parts(rel: str) -> list:
    return [p for p in (rel or "").replace("\\", "/").split("/") if p not in ("", ".")]


def scan_folder(root: str, rel: str, max_depth: int = 6) -> str:
    """Absolute path of root/rel, checked: an existing folder the walk reaches."""
    parts = _parts(rel)
    if any(p == ".." or not _should_descend(p) for p in parts):
        raise ProjectPathError(f"not a folder alkonost scans: {rel}")
    if len(parts) > max_depth:
        raise ProjectPathError(f"deeper than --max-depth {max_depth}: {rel}")
    path = os.path.join(os.path.abspath(root), *parts)
    if not os.path.isdir(path):
        raise ProjectPathError(f"no such folder: {rel}")
    return path


def list_folders(root: str, rel: str, max_depth: int = 6) -> dict:
    """{"path", "is_project", "can_descend", "folders": [{"name", "is_project"}]} — one level."""
    path = scan_folder(root, rel, max_depth)
    parts = _parts(rel)
    folders = []
    try:
        entries = sorted(os.scandir(path), key=lambda e: e.name.lower())
    except OSError:
        entries = []
    for e in entries:
        if e.is_dir(follow_symlinks=False) and _should_descend(e.name) and e.name != _DOT1BCODER:
            folders.append({"name": e.name,
                            "is_project": os.path.isdir(os.path.join(e.path, _DOT1BCODER))})
    return {"path": "/".join(parts),
            "is_project": os.path.isdir(os.path.join(path, _DOT1BCODER)),
            "can_descend": len(parts) < max_depth,
            "folders": folders}


def make_project(root: str, rel: str, max_depth: int = 6) -> str:
    """Create <root>/<rel>/.1bcoder/ (nothing inside); return the project id. Idempotent."""
    path = scan_folder(root, rel, max_depth)
    os.makedirs(os.path.join(path, _DOT1BCODER), exist_ok=True)
    return project_id(path)


def list_plans(project_root: str) -> list:
    """[{"name","item_count","has_spec","spec_count","has_tasks","task_count"}, ...]
    Reads .1bcoder/planMD/<name>/ directly; spec/tasks are optional/sparse
    relative to planMD (not every plan has a spec/ or tasks/ counterpart —
    confirmed against a real project's .1bcoder/ layout)."""
    dot1bcoder = os.path.join(project_root, _DOT1BCODER)
    planmd_root = os.path.join(dot1bcoder, "planMD")
    spec_root = os.path.join(dot1bcoder, "spec")
    tasks_root = os.path.join(dot1bcoder, "tasks")

    if not os.path.isdir(planmd_root):
        return []

    plans = []
    for entry in sorted(os.scandir(planmd_root), key=lambda e: e.name):
        if not entry.is_dir():
            continue
        name = entry.name
        item_count = sum(
            1 for f in os.listdir(entry.path)
            if f.startswith("item_") and f.endswith(".md")
        )

        spec_dir = os.path.join(spec_root, name)
        has_spec = os.path.isdir(spec_dir)
        spec_count = (
            sum(1 for f in os.listdir(spec_dir) if f.startswith("spec_") and f.endswith(".md"))
            if has_spec else 0
        )

        tasks_path = os.path.join(tasks_root, name, "tasks.md")
        has_tasks = os.path.isfile(tasks_path)
        task_count = 0
        if has_tasks:
            with open(tasks_path, encoding="utf-8") as f:
                task_count = sum(1 for line in f if line.strip().startswith("["))

        plans.append({
            "name": name,
            "item_count": item_count,
            "has_spec": has_spec,
            "spec_count": spec_count,
            "has_tasks": has_tasks,
            "task_count": task_count,
        })
    return plans
