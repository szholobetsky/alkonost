import os

from alkonost import settings


def test_read_missing_config_returns_empty_dict(tmp_path):
    assert settings.read_config(str(tmp_path / "config.yml")) == {}


def test_write_and_read_round_trip(tmp_path):
    path = str(tmp_path / ".1bcoder" / "config.yml")
    settings.write_settings(path, {
        "host": "http://localhost:11434",
        "model": "qwen2.5-coder:7b",
        "ctx": "8",
        "params": {"timeout": "300", "run_timeout": "30"},
    })
    cfg = settings.read_config(path)
    assert cfg["host"] == "http://localhost:11434"
    assert cfg["model"] == "qwen2.5-coder:7b"
    assert cfg["ctx"] == 8  # parsed back as int, same as chat.py's own parser
    assert cfg["params"] == {"timeout": "300", "run_timeout": "30"}


def test_settings_view_exposes_only_editable_fields(tmp_path):
    path = str(tmp_path / "config.yml")
    settings.write_settings(path, {"host": "h", "model": "m", "ctx": "4", "params": {"timeout": "60"}})
    view = settings.settings_view(path)
    assert view == {"host": "h", "model": "m", "ctx": 4, "params": {"timeout": "60"}}


def test_write_settings_preserves_unrelated_sections(tmp_path):
    path = str(tmp_path / "config.yml")
    os.makedirs(tmp_path, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(
            "host: http://old:1234\n"
            "model: old-model\n"
            "vars:\n"
            "  myvar: hello\n"
            "procs:\n"
            "  - build\n"
            "active_project: myproj\n"
        )
    settings.write_settings(path, {"model": "new-model"})
    cfg = settings.read_config(path)
    assert cfg["model"] == "new-model"
    assert cfg["host"] == "http://old:1234"  # untouched, not in the patch
    assert cfg["vars"] == {"myvar": "hello"}
    assert cfg["procs"] == ["build"]
    assert cfg["active_project"] == "myproj"


def test_write_settings_can_clear_a_field(tmp_path):
    path = str(tmp_path / "config.yml")
    settings.write_settings(path, {"host": "http://x", "model": "m"})
    settings.write_settings(path, {"host": ""})
    cfg = settings.read_config(path)
    assert "host" not in cfg
    assert cfg["model"] == "m"


def test_resolve_runtime_prefers_project_over_global_per_field(tmp_path, monkeypatch):
    # Isolated from the real ~/.1bcoder/config.yml on whatever machine runs
    # this test — resolve_runtime() falls back to the real global path
    # otherwise, which would make this test depend on local machine state.
    global_path = str(tmp_path / "global_config.yml")
    monkeypatch.setattr(settings, "global_config_path", lambda: global_path)
    settings.write_settings(global_path, {"host": "http://global:1", "model": "global-model"})

    project_root = str(tmp_path / "proj")
    settings.write_settings(settings.project_config_path(project_root), {"model": "project-model"})

    # project set only `model` -- its own `host` is unset, so that field
    # falls back to global while `model` stays project-local.
    assert settings.resolve_runtime(project_root) == {
        "host": "http://global:1", "model": "project-model",
    }


def test_resolve_session_project_ctx_wins_params_merge(tmp_path, monkeypatch):
    global_path = str(tmp_path / "global_config.yml")
    monkeypatch.setattr(settings, "global_config_path", lambda: global_path)
    settings.write_settings(global_path, {"ctx": "8192", "params": {"think": "false", "timeout": "300"}})
    project_root = str(tmp_path / "proj")
    settings.write_settings(settings.project_config_path(project_root),
                            {"ctx": "4096", "params": {"timeout": "600", "seed": "1"}})
    s = settings.resolve_session(project_root)
    assert str(s["ctx"]) == "4096"
    assert {k: str(v).lower() for k, v in s["params"].items()} == {"think": "false", "timeout": "600", "seed": "1"}


def test_resolve_runtime_empty_when_nothing_configured_anywhere(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "global_config_path", lambda: str(tmp_path / "no_such_global.yml"))
    assert settings.resolve_runtime(str(tmp_path / "proj")) == {"host": "", "model": ""}


def test_project_and_global_paths():
    assert settings.project_config_path("/proj").endswith(os.path.join(".1bcoder", "config.yml"))
    assert settings.global_config_path().endswith(os.path.join(".1bcoder", "config.yml"))
    assert os.path.expanduser("~") in settings.global_config_path()
