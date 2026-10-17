import os

import pytest

from alkonost import config as config_mod
from alkonost import discovery
from alkonost.flask_api import create_app


def _tree(tmp_path):
    for d in ("docs/concepts", "code/.git", "code/node_modules", "old/.1bcoder", "a/b/c"):
        (tmp_path / d).mkdir(parents=True)
    return str(tmp_path)


def test_list_folders_skips_what_discovery_skips(tmp_path):
    root = _tree(tmp_path)
    top = discovery.list_folders(root, "")
    assert [f["name"] for f in top["folders"]] == ["a", "code", "docs", "old"]
    assert {f["name"]: f["is_project"] for f in top["folders"]}["old"] is True
    assert top["path"] == "" and top["is_project"] is False and top["can_descend"] is True
    assert discovery.list_folders(root, "code")["folders"] == []           # .git, node_modules hidden
    assert discovery.list_folders(root, "docs\\concepts")["path"] == "docs/concepts"
    assert discovery.list_folders(root, "a/b", max_depth=2)["can_descend"] is False


def test_make_project_is_found_again(tmp_path):
    root = _tree(tmp_path)
    pid = discovery.make_project(root, "docs/concepts")
    assert os.listdir(tmp_path / "docs" / "concepts" / ".1bcoder") == []
    found = discovery.discover_projects(root)
    assert found[pid]["name"] == "concepts"
    assert discovery.make_project(root, "docs/concepts") == pid                # idempotent
    pid_root = discovery.make_project(root, "")                               # the scan root itself
    assert discovery.discover_projects(root)[pid_root]["root"] == os.path.abspath(root)


@pytest.mark.parametrize("bad", ["..", "../x", "docs/../..", "code/.git", "code/node_modules", "nope", "a/b/c"])
def test_make_project_refuses(tmp_path, bad):
    root = _tree(tmp_path)
    with pytest.raises(discovery.ProjectPathError):
        discovery.make_project(root, bad, max_depth=2)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config_mod, "_config_dir", lambda: str(tmp_path / ".alkonost"))
    root = tmp_path / "scan"
    root.mkdir()
    _tree(root)
    app = create_app(root=str(root), max_depth=6)
    app.testing = True
    with app.test_client() as c:
        c._root = str(root)
        yield c


def test_api_folders_and_create(client):
    r = client.get("/api/projects/folders").get_json()
    assert r["root"] == client._root and "docs" in [f["name"] for f in r["folders"]]
    assert client.get("/api/projects/folders?path=..").status_code == 400
    pid = client.post("/api/projects/create", json={"path": "docs/concepts"}).get_json()["id"]
    assert pid in [p["id"] for p in client.get("/api/projects").get_json()]
    assert client.post("/api/projects/create", json={"path": "../x"}).status_code == 400
