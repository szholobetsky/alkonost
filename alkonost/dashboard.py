"""dashboard.py — read/write .1bcoder/tasks/dashboard_flow.md.

One shared file per project (not per-plan), same convention as colors.md —
a single ordered, comma-separated list of "+flag" lane names to show on
the board, e.g.:

    +selected, +active, +paused, +testing, +done, +releasing

This is the mechanism for hiding lanes like +backlog/+complete/+canceled/
+closed from the dashboard board without hiding their rows from the
Backlog table (which always shows every row regardless of this filter).
Missing/empty file -> empty list, meaning "no filter configured" — the
board falls back to showing every distinct lane found in the data (the
original, pre-filter behavior), not an empty board.
"""
import os

_FILENAME = "dashboard_flow.md"


def parse_dashboard_flow(path: str) -> list:
    """Ordered list of bare lane names (no leading '+')."""
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as f:
        line = f.readline().strip()
    if not line:
        return []
    return [tok.strip().lstrip("+") for tok in line.split(",") if tok.strip()]


def write_dashboard_flow(path: str, flow: list) -> None:
    line = ", ".join(f"+{name}" for name in flow if name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(line + "\n" if line else "")
