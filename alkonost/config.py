"""config.py — read/write ~/.alkonost/config.json.

Unlike everything else in alkonost (which reads/writes files inside a
scanned project's own .1bcoder/), this is the one piece of state that
belongs to the alkonost installation itself, not to any project: which
project/plan were last selected, so the next launch can restore them
instead of starting back at "Select project…" every time. Same
~/.<tool>/config.json convention vyrii already uses.

A flat, merge-updatable JSON blob — POST /api/config merges into whatever
is already there rather than replacing it wholesale, so unrelated keys
added later don't require touching this module.
"""
import json
import os

_FILENAME = "config.json"


def _config_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".alkonost")


def _config_path() -> str:
    return os.path.join(_config_dir(), _FILENAME)


def read_config() -> dict:
    path = _config_path()
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_config(data: dict) -> None:
    os.makedirs(_config_dir(), exist_ok=True)
    with open(_config_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
