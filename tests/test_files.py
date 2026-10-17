import io

from test_api import client, _project_id  # noqa: F401 -- `client` is a pytest fixture


def test_files_list_defaults_to_project_root(client):
    pid = _project_id(client, "proj_a")
    resp = client.get(f"/api/files/list?project={pid}&path=")
    data = resp.get_json()
    assert resp.status_code == 200
    names = {e["name"] for e in data["entries"]}
    assert ".1bcoder" in names
    entry = next(e for e in data["entries"] if e["name"] == ".1bcoder")
    assert entry["is_dir"] is True


def test_files_list_one_level_only_not_recursive(client):
    # A real project root can hold node_modules/.git/venv — unlike vyrii's
    # own ~/.vyrii listing, this must NOT eagerly walk the whole tree.
    pid = _project_id(client, "proj_a")
    data = client.get(f"/api/files/list?project={pid}&path=.1bcoder").get_json()
    names = {e["name"] for e in data["entries"]}
    assert names == {"planMD", "spec", "tasks"}
    # confirm children were not pre-expanded into nested structures
    for e in data["entries"]:
        assert set(e.keys()) == {"name", "is_dir"}


def test_files_list_rejects_path_traversal_outside_project_root(client):
    pid = _project_id(client, "proj_a")
    resp = client.get(f"/api/files/list?project={pid}&path=../proj_b")
    assert resp.status_code == 400
    assert "outside" in resp.get_json()["error"].lower()


def test_files_mkdir_read_write_delete_round_trip(client):
    pid = _project_id(client, "proj_a")

    mk = client.post(f"/api/files/mkdir?project={pid}", json={"path": "scratch/sub"})
    assert mk.status_code == 200
    assert mk.get_json()["ok"] is True

    listed = client.get(f"/api/files/list?project={pid}&path=scratch").get_json()
    assert {"name": "sub", "is_dir": True} in listed["entries"]

    del_resp = client.delete(f"/api/files?project={pid}", json={"path": "scratch"})
    assert del_resp.status_code == 200
    assert del_resp.get_json()["ok"] is True

    after = client.get(f"/api/files/list?project={pid}&path=").get_json()
    assert "scratch" not in {e["name"] for e in after["entries"]}


def test_files_delete_refuses_project_root(client):
    pid = _project_id(client, "proj_a")
    resp = client.delete(f"/api/files?project={pid}", json={"path": "."})
    assert resp.status_code == 400
    assert "root" in resp.get_json()["error"].lower()


def test_files_read_round_trips_uploaded_content(client):
    pid = _project_id(client, "proj_a")
    data = {"files": (io.BytesIO(b"hello alkonost"), "note.txt")}
    up = client.post(f"/api/files/upload?project={pid}", data=data,
                      content_type="multipart/form-data")
    assert up.status_code == 200
    body = up.get_json()
    assert body["ok"] is True
    assert body["saved"] == ["note.txt"]

    read = client.get(f"/api/files/read?project={pid}&path=note.txt").get_json()
    assert read["content"] == "hello alkonost"
    assert read["truncated"] is False


def test_files_read_rejects_a_directory(client):
    pid = _project_id(client, "proj_a")
    resp = client.get(f"/api/files/read?project={pid}&path=.1bcoder")
    assert resp.status_code == 400


def test_files_routes_404_on_unknown_project(client):
    assert client.get("/api/files/list?project=deadbeefdead").status_code == 404
    assert client.get("/api/files/read?project=deadbeefdead&path=x").status_code == 404
    assert client.post("/api/files/mkdir?project=deadbeefdead", json={"path": "x"}).status_code == 404
    assert client.delete("/api/files?project=deadbeefdead", json={"path": "x"}).status_code == 404
