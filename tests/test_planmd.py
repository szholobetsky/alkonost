import os

from conftest import PROJ_A
from alkonost import planmd

PLAN_DIR = os.path.join(PROJ_A, ".1bcoder", "planMD", "plan1")


def test_collect_node_ids():
    ids = planmd.collect_node_ids(PLAN_DIR)
    assert ids == {"1", "1.1", "1.2", "1.1.1"}


def test_read_title_strips_hash_and_whitespace():
    assert planmd.read_title(PLAN_DIR, "1") == "Root Feature"
    assert planmd.read_title(PLAN_DIR, "1.1.1") == "Leaf Under Child One"


def test_child_ids_and_leaf_detection():
    all_ids = planmd.collect_node_ids(PLAN_DIR)
    assert planmd.child_ids("1", all_ids) == ["1.1", "1.2"]
    assert planmd.child_ids("1.1", all_ids) == ["1.1.1"]
    assert planmd.is_leaf("1.2", all_ids) is True
    assert planmd.is_leaf("1.1.1", all_ids) is True
    assert planmd.is_leaf("1", all_ids) is False
    assert planmd.is_leaf("1.1", all_ids) is False


def test_build_tree_shape():
    tree = planmd.build_tree(PLAN_DIR)
    assert len(tree) == 1
    root = tree[0]
    assert root["id"] == "1"
    assert root["title"] == "Root Feature"
    assert {c["id"] for c in root["children"]} == {"1.1", "1.2"}
    child_one = next(c for c in root["children"] if c["id"] == "1.1")
    assert child_one["children"][0]["id"] == "1.1.1"
    assert child_one["children"][0]["is_leaf"] is True


def test_read_item_returns_raw_text():
    raw = planmd.read_item(PLAN_DIR, "1.1.1")
    assert raw.startswith("# Leaf Under Child One")
    assert "Follow-up Notes" in raw


def test_read_item_missing_returns_empty():
    assert planmd.read_item(PLAN_DIR, "9.9") == ""
