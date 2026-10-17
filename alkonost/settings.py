"""settings.py — read/write 1bcoder's own .1bcoder/config.yml (project) and
~/.1bcoder/config.yml (global). Alkonost's own theme preference lives in
config.py already (~/.alkonost/config.json) and is untouched here.

Mirrors chat.py's own hand-rolled config.yml grammar exactly
(CoderCLI._parse_config_yml / _write_config_yml in C:\\Projects\\1bcoder\\chat.py)
rather than depending on PyYAML: that file is not full YAML (no
quoting/escaping, two-level-max nesting — top-level scalars
host/model/ctx/auto/active_project, one-level dict sections
params/vars/hooks, one flat list section procs) and 1bcoder itself never
uses a YAML library to read it either. Re-implementing the identical
grammar guarantees round-trip compatibility with whatever 1bcoder's own
/config load/save commands produce or expect, and keeps alkonost
dependency-free (matches its existing flask+waitress-only convention).

The settings UI only ever edits host/model/ctx/params — vars/procs/hooks/
active_project/auto are read back untouched and never rendered/editable,
so this can never clobber session working state 1bcoder itself manages.
"""
import os

_EDITABLE_TOP = ("host", "model", "ctx")


def _parse_config_yml(text: str) -> dict:
    cfg = {}
    section = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line or line.strip().startswith('#'):
            continue
        if line.startswith('  ') or line.startswith('\t'):
            stripped = line.strip()
            if stripped.startswith('- '):
                if section:
                    cfg.setdefault(section, []).append(stripped[2:].strip())
            elif ':' in stripped and section:
                k, _, v = stripped.partition(':')
                cfg.setdefault(section, {})[k.strip()] = v.strip()
        else:
            section = None
            if ':' not in line:
                continue
            k, _, v = line.partition(':')
            k, v = k.strip(), v.strip()
            if k in ('params', 'vars', 'procs', 'hooks'):
                section = k
            elif k == 'auto':
                cfg['auto'] = v.lower() in ('true', '1', 'yes')
            elif k == 'ctx':
                try:
                    cfg['ctx'] = int(v)
                except ValueError:
                    pass
            elif v:
                cfg[k] = v
    return cfg


def _write_config_yml(cfg: dict) -> str:
    lines = []
    if 'auto' in cfg:
        lines.append(f"auto: {'true' if cfg['auto'] else 'false'}")
    for k in ('host', 'model'):
        if cfg.get(k):
            lines.append(f"{k}: {cfg[k]}")
    if cfg.get('ctx'):
        lines.append(f"ctx: {cfg['ctx']}")
    for section in ('params', 'vars', 'hooks'):
        d = cfg.get(section)
        if d:
            lines.append(f"{section}:")
            for sk, sv in d.items():
                if sv:
                    lines.append(f"  {sk}: {sv}")
    procs = cfg.get('procs')
    if procs:
        lines.append("procs:")
        for p in procs:
            lines.append(f"  - {p}")
    if cfg.get('active_project'):
        lines.append(f"active_project: {cfg['active_project']}")
    return '\n'.join(lines) + '\n' if lines else ''


def project_config_path(project_root: str) -> str:
    return os.path.join(project_root, ".1bcoder", "config.yml")


def global_config_path() -> str:
    return os.path.join(os.path.expanduser("~"), ".1bcoder", "config.yml")


def read_config(path: str) -> dict:
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return _parse_config_yml(f.read())
    except OSError:
        return {}


def settings_view(path: str) -> dict:
    """What the Settings UI actually shows/edits — host/model/ctx/params
    only. vars/procs/hooks/active_project/auto exist on disk (if present)
    but are deliberately not surfaced here — session working state 1bcoder
    itself manages, not something a generic settings form should touch."""
    cfg = read_config(path)
    return {
        "host": cfg.get("host", ""),
        "model": cfg.get("model", ""),
        "ctx": cfg.get("ctx", ""),
        "params": dict(cfg.get("params") or {}),
    }


def resolve_runtime(project_root: str) -> dict:
    """{"host": ..., "model": ...} actually to use for a launch — project
    config.yml wins, global config.yml fills in whatever the project one
    left unset. Empty string means "not configured anywhere".

    This deliberately bypasses 1bcoder's OWN config auto-loading
    (chat.py's `_load_startup_config()`), which only returns a config
    file's contents at all when that file also has `auto: true` set — a
    flag this module's own settings_view()/write_settings() never
    surfaces or writes. Confirmed live as the actual root cause of a
    launch silently using an arbitrary model: a model saved through
    Alkonost's Settings tab sat in config.yml correctly, but 1bcoder's own
    loader ignored the whole file (no `auto: true`), fell through to
    `model = models[0]` on whatever Ollama host it found, and once that
    was a reasoning model that produced pages of dim-gray <think> tokens
    before ever answering. Passing --host/--model explicitly on every
    launch sidesteps that loader entirely."""
    project_cfg = read_config(project_config_path(project_root)) if project_root else {}
    global_cfg = read_config(global_config_path())
    return {
        "host": project_cfg.get("host") or global_cfg.get("host") or "",
        "model": project_cfg.get("model") or global_cfg.get("model") or "",
    }


def resolve_session(project_root: str) -> dict:
    """{"ctx": ..., "params": {...}} for a launch — the rest of what the Settings tab
    saves. Same bypass as resolve_runtime(): with --host/--model given, 1bcoder's
    --scriptapply loads no config.yml at all, so ctx/timeout/think=false… saved here
    never reached a run. runner.render_script() turns this into `/ctx` and `/param`
    lines at the top of the launched script. ctx: project wins; params: global ones,
    each overridden by the project's."""
    project_cfg = read_config(project_config_path(project_root)) if project_root else {}
    global_cfg = read_config(global_config_path())
    params = dict(global_cfg.get("params") or {})
    params.update(project_cfg.get("params") or {})
    return {
        "ctx": project_cfg.get("ctx") or global_cfg.get("ctx") or "",
        "params": {k: v for k, v in params.items() if str(v).strip() != ""},
    }


def write_settings(path: str, patch: dict) -> None:
    """Merge-write only host/model/ctx/params — everything else already on
    disk (vars/procs/hooks/active_project/auto) passes through untouched."""
    cfg = read_config(path)
    for k in _EDITABLE_TOP:
        if k in patch:
            if patch[k] in (None, ""):
                cfg.pop(k, None)
            else:
                cfg[k] = patch[k]
    if "params" in patch:
        params = dict(cfg.get("params") or {})
        for k, v in (patch["params"] or {}).items():
            if v in (None, ""):
                params.pop(k, None)
            else:
                params[k] = v
        if params:
            cfg["params"] = params
        else:
            cfg.pop("params", None)
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(_write_config_yml(cfg))
