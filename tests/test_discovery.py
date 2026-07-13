import os

from conftest import FIXTURES, PROJ_A, PROJ_B
from alkonost import discovery


def test_discover_projects_finds_both_projects():
    projects = discovery.discover_projects(FIXTURES, max_depth=6)
    roots = {info["root"] for info in projects.values()}
    assert os.path.abspath(PROJ_A) in roots
    assert os.path.abspath(PROJ_B) in roots


def test_discover_projects_prunes_node_modules():
    projects = discovery.discover_projects(FIXTURES, max_depth=6)
    names = {info["name"] for info in projects.values()}
    assert "node_modules" not in names
    assert len(projects) == 2


def test_discover_projects_respects_max_depth():
    # ignored/node_modules/.1bcoder is 3 levels below FIXTURES; a max_depth
    # of 0 must not even find proj_a/proj_b's .1bcoder (1 level below).
    projects = discovery.discover_projects(FIXTURES, max_depth=0)
    assert projects == {}


def test_project_id_is_stable():
    a1 = discovery.project_id(PROJ_A)
    a2 = discovery.project_id(PROJ_A)
    assert a1 == a2
    assert a1 != discovery.project_id(PROJ_B)


def test_list_plans_sparse_vs_full():
    plans_a = {p["name"]: p for p in discovery.list_plans(PROJ_A)}
    assert plans_a["plan1"]["has_spec"] is True
    assert plans_a["plan1"]["has_tasks"] is True
    assert plans_a["plan1"]["task_count"] == 4

    plans_b = {p["name"]: p for p in discovery.list_plans(PROJ_B)}
    assert plans_b["plan2"]["has_spec"] is False
    assert plans_b["plan2"]["has_tasks"] is False
