from alkonost import config


def test_read_missing_config_returns_empty_dict(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "_config_dir", lambda: str(tmp_path / ".alkonost"))
    assert config.read_config() == {}


def test_write_and_read_round_trip(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "_config_dir", lambda: str(tmp_path / ".alkonost"))
    config.write_config({"last_project_id": "abc123", "theme": "dark"})
    assert config.read_config() == {"last_project_id": "abc123", "theme": "dark"}


def test_corrupt_json_falls_back_to_empty_dict(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "_config_dir", lambda: str(tmp_path / ".alkonost"))
    import os
    os.makedirs(tmp_path / ".alkonost", exist_ok=True)
    (tmp_path / ".alkonost" / "config.json").write_text("{not valid json", encoding="utf-8")
    assert config.read_config() == {}
