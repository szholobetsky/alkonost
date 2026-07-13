"""colors.py — read/write .1bcoder/tasks/colors.md.

One shared file per project (not per-plan) — "@module=color" lines,
one @module -> hex-color legend used across every plan's board.
deepagent_task creates this file with generic starter defaults the first
time it's missing and never touches it again; alkonost is the file's
actual owner (add/edit/remove entries through its own UI).
"""
import os
import re

_LINE_RE = re.compile(r'^@(\S+)=(\S+)$')


def parse_colors(path: str) -> dict:
    """{"backend": "#4A90D9", ...} — module name without the leading '@'."""
    colors = {}
    if not os.path.isfile(path):
        return colors
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = _LINE_RE.match(line.strip())
            if m:
                colors[m.group(1)] = m.group(2)
    return colors


def write_colors(path: str, colors: dict) -> None:
    """One "@module=color" line per entry, insertion order preserved."""
    lines = [f"@{name}={color}" for name, color in colors.items()]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))
