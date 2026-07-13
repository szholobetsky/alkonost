import os
import shutil

import pytest

from conftest import FIXTURES
from alkonost.flask_api import create_app
from alkonost import config as config_mod
from alkonost import discovery


@pytest.fixture
def client(tmp_path, monkeypatch):
    # ~/.alkonost/config.json is machine-global (not scoped to `root` the
    # way every other route is) — redirect it into tmp_path so tests never
    # touch the real user's config file.
    monkeypatch.setattr(config_mod, "_config_dir", lambda: str(tmp_path / ".alkonost"))
    root = tmp_path / "fixtures"
    shutil.copytree(FIXTURES, root)
    app = create_app(root=str(root), max_depth=6)
    app.testing = True
    with app.test_client() as c:
        c._root = str(root)
        yield c


def _project_id(client, name):
    projects = client.get("/api/projects").get_json()
    return next(p["id"] for p in projects if p["name"] == name)


def test_projects_route(client):
    data = client.get("/api/projects").get_json()
    names = {p["name"] for p in data}
    assert names == {"proj_a", "proj_b"}


def test_plans_route(client):
    pid = _project_id(client, "proj_a")
    plans = client.get(f"/api/plans?project={pid}").get_json()
    assert plans[0]["name"] == "plan1"
    assert plans[0]["has_tasks"] is True


def test_plans_route_unknown_project_404(client):
    resp = client.get("/api/plans?project=deadbeefdead")
    assert resp.status_code == 404


def test_tasks_get_and_post_round_trip(client):
    pid = _project_id(client, "proj_a")
    got = client.get(f"/api/tasks?project={pid}&plan=plan1").get_json()
    assert got["exists"] is True
    rows = got["rows"]
    assert len(rows) == 4

    for row in rows:
        if row["id"] == "1":
            row["tags"]["plus"] = ["active"]

    post = client.post(
        f"/api/tasks?project={pid}&plan=plan1",
        json={"rows": [{"id": r["id"], "title": r["title"], "tags": r["tags"]} for r in rows]},
    )
    assert post.status_code == 200
    assert post.get_json()["row_count"] == 4

    reget = client.get(f"/api/tasks?project={pid}&plan=plan1").get_json()
    updated = next(r for r in reget["rows"] if r["id"] == "1")
    assert updated["tags"]["plus"] == ["active"]


def test_tasks_post_rejects_row_mismatch(client):
    pid = _project_id(client, "proj_a")
    got = client.get(f"/api/tasks?project={pid}&plan=plan1").get_json()
    rows = got["rows"][:-1]  # drop one row -> mismatch

    post = client.post(
        f"/api/tasks?project={pid}&plan=plan1",
        json={"rows": [{"id": r["id"], "title": r["title"], "tags": r["tags"]} for r in rows]},
    )
    assert post.status_code == 409


def test_tasks_get_missing_file_for_sparse_plan(client):
    pid = _project_id(client, "proj_b")
    got = client.get(f"/api/tasks?project={pid}&plan=plan2").get_json()
    assert got["exists"] is False
    assert got["rows"] == []


def test_config_get_returns_empty_dict_when_none_saved_yet(client):
    assert client.get("/api/config").get_json() == {}


def test_config_post_merges_and_persists(client):
    post = client.post("/api/config", json={"last_project_id": "abc123", "theme": "dark"})
    assert post.status_code == 200

    reget = client.get("/api/config").get_json()
    assert reget == {"last_project_id": "abc123", "theme": "dark"}

    # a second POST merges rather than replacing wholesale
    client.post("/api/config", json={"last_plan": "plan1"})
    reget2 = client.get("/api/config").get_json()
    assert reget2 == {"last_project_id": "abc123", "theme": "dark", "last_plan": "plan1"}


def test_colors_get_and_post_round_trip(client):
    pid = _project_id(client, "proj_a")
    got = client.get(f"/api/colors?project={pid}").get_json()
    assert got["colors"]["backend"] == "#4A90D9"

    new_colors = {"backend": "#000000", "api": "#ffffff"}
    post = client.post(f"/api/colors?project={pid}", json={"colors": new_colors})
    assert post.status_code == 200

    reget = client.get(f"/api/colors?project={pid}").get_json()
    assert reget["colors"] == new_colors


def test_dashboard_flow_get_and_post_round_trip(client):
    pid = _project_id(client, "proj_a")
    got = client.get(f"/api/dashboard_flow?project={pid}").get_json()
    assert got["flow"] == []  # no file yet -> empty (no filter -> show every lane)

    flow = ["selected", "active", "paused", "testing", "done", "releasing"]
    post = client.post(f"/api/dashboard_flow?project={pid}", json={"flow": flow})
    assert post.status_code == 200

    reget = client.get(f"/api/dashboard_flow?project={pid}").get_json()
    assert reget["flow"] == flow


def test_spec_route(client):
    pid = _project_id(client, "proj_a")
    got = client.get(f"/api/spec?project={pid}&plan=plan1&spec_id=1.1.1.1").get_json()
    assert got["title"] == "Request Body Specification"
    assert got["source_leaf_id"] == "1.1.1"


def test_spec_route_404(client):
    pid = _project_id(client, "proj_a")
    resp = client.get(f"/api/spec?project={pid}&plan=plan1&spec_id=9.9.9")
    assert resp.status_code == 404


def test_spec_post_writes_raw_and_get_reflects_it(client):
    pid = _project_id(client, "proj_a")
    edited = "# PLAN1-1.1.1.1: Request Body Specification\n\nWHO: someone\n\n---\n**Note:** added by hand.\n\nSOURCE: [src: item_1.1.1.md#1]\n"
    post = client.post(f"/api/spec?project={pid}&plan=plan1&spec_id=1.1.1.1", json={"raw": edited})
    assert post.status_code == 200

    reget = client.get(f"/api/spec?project={pid}&plan=plan1&spec_id=1.1.1.1").get_json()
    assert reget["raw"] == edited
    assert "added by hand" in reget["body"]


def test_spec_post_404_for_nonexistent_spec(client):
    pid = _project_id(client, "proj_a")
    resp = client.post(f"/api/spec?project={pid}&plan=plan1&spec_id=9.9.9", json={"raw": "x"})
    assert resp.status_code == 404


def test_item_route(client):
    pid = _project_id(client, "proj_a")
    got = client.get(f"/api/item?project={pid}&plan=plan1&item_id=1.1.1").get_json()
    assert got["title"] == "Leaf Under Child One"
    assert got["is_leaf"] is True


def test_item_post_writes_raw_and_get_reflects_it(client):
    pid = _project_id(client, "proj_a")
    edited = "# Leaf Under Child One\n\nAppended note from the user.\n"
    post = client.post(f"/api/item?project={pid}&plan=plan1&item_id=1.1.1", json={"raw": edited})
    assert post.status_code == 200

    reget = client.get(f"/api/item?project={pid}&plan=plan1&item_id=1.1.1").get_json()
    assert reget["raw"] == edited


def test_item_post_404_for_nonexistent_item(client):
    pid = _project_id(client, "proj_a")
    resp = client.post(f"/api/item?project={pid}&plan=plan1&item_id=9.9.9", json={"raw": "x"})
    assert resp.status_code == 404


def test_spec_index_route(client):
    pid = _project_id(client, "proj_a")
    got = client.get(f"/api/spec_index?project={pid}&plan=plan1").get_json()
    assert got["spec_ids"] == ["1.1.1.1"]

    # sparse plan (proj_b, no spec/ at all) -> empty list, not an error
    pid_b = _project_id(client, "proj_b")
    got_b = client.get(f"/api/spec_index?project={pid_b}&plan=plan2").get_json()
    assert got_b["spec_ids"] == []


def test_spec_create_route_writes_a_new_spec_and_is_idempotent(client):
    pid = _project_id(client, "proj_a")
    post = client.post(
        f"/api/spec/create?project={pid}&plan=plan1",
        json={"task_id": "9", "title": "Brand new task"},
    )
    assert post.status_code == 200
    data = post.get_json()
    assert data["spec_id"] == "9"
    assert data["title"] == "Brand new task"

    # now shows up in the index
    index = client.get(f"/api/spec_index?project={pid}&plan=plan1").get_json()
    assert "9" in index["spec_ids"]

    # re-creating doesn't clobber a hand-edit made in between
    client.post(f"/api/spec?project={pid}&plan=plan1&spec_id=9",
                json={"raw": data["raw"] + "\nhand-written content\n"})
    post2 = client.post(
        f"/api/spec/create?project={pid}&plan=plan1",
        json={"task_id": "9", "title": "Brand new task"},
    )
    assert "hand-written content" in post2.get_json()["body"]


def test_spec_create_route_for_a_subtask_id_matches_what_openSpecPanel_would_look_up(client):
    # Regression: task "4.1" (e.g. a manually-added subtask under root "4")
    # must get a spec addressable by GET /api/spec?spec_id=4.1 — the exact
    # lookup the "spec" view link/openSpecPanel uses for that row.
    pid = _project_id(client, "proj_a")
    post = client.post(
        f"/api/spec/create?project={pid}&plan=plan1",
        json={"task_id": "4.1", "title": "Some subtask"},
    )
    assert post.get_json()["spec_id"] == "4.1"

    got = client.get(f"/api/spec?project={pid}&plan=plan1&spec_id=4.1").get_json()
    assert got["title"] == "Some subtask"


def test_spec_create_route_requires_task_id(client):
    pid = _project_id(client, "proj_a")
    resp = client.post(f"/api/spec/create?project={pid}&plan=plan1", json={"title": "no id"})
    assert resp.status_code == 400


def test_planmd_tree_route(client):
    pid = _project_id(client, "proj_a")
    got = client.get(f"/api/planmd/tree?project={pid}&plan=plan1").get_json()
    assert len(got) == 1
    assert got[0]["id"] == "1"


def test_ui_index_served(client):
    resp = client.get("/ui/")
    assert resp.status_code == 200
    assert b"Alkonost" in resp.data


def test_themes_route_lists_bundled_themes(client):
    data = client.get("/api/themes").get_json()
    assert "ocean" in data["themes"]
    assert "dark" in data["themes"]
    assert data["themes"] == sorted(data["themes"])


def test_theme_css_served_as_static(client):
    resp = client.get("/ui/themes/ocean.css")
    assert resp.status_code == 200
    assert b"--accent" in resp.data
