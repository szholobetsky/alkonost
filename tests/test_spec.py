import os

from conftest import PROJ_A, PROJ_B
from alkonost import spec

SPEC_DIR_A = os.path.join(PROJ_A, ".1bcoder", "spec", "plan1")
SPEC_DIR_B = os.path.join(PROJ_B, ".1bcoder", "spec", "plan2")


def test_find_and_parse_spec_file():
    path = spec.find_spec_file(SPEC_DIR_A, "1.1.1.1")
    assert path
    parsed = spec.parse_spec(path)
    assert parsed["project"] == "PLAN1"
    assert parsed["spec_id"] == "1.1.1.1"
    assert parsed["title"] == "Request Body Specification"
    assert parsed["source_leaf_id"] == "1.1.1"
    assert parsed["source_sec_index"] == 1
    assert "SOURCE:" not in parsed["body"]
    assert "WHO: backend engineer" in parsed["body"]


def test_list_spec_files():
    hits = spec.list_spec_files(SPEC_DIR_A, "1.1.1")
    assert hits == [(1, os.path.join(SPEC_DIR_A, "spec_1.1.1.1.md"))]

    # leaf with no specs generated yet
    assert spec.list_spec_files(SPEC_DIR_A, "1.2") == []


def test_missing_spec_dir_is_not_an_error():
    # proj_b has no spec/ directory at all
    assert spec.list_spec_files(SPEC_DIR_B, "1") == []
    assert spec.find_spec_file(SPEC_DIR_B, "1.1") == ""


def test_list_spec_ids():
    assert spec.list_spec_ids(SPEC_DIR_A) == ["1.1.1.1"]
    # missing dir -> empty, not an error, same convention as list_spec_files
    assert spec.list_spec_ids(SPEC_DIR_B) == []


def test_project_name_slugifies_the_root_basename():
    assert spec.project_name(r"C:\Project\AnimalAlert") == "ANIMALALERT"
    assert spec.project_name(r"C:\Project\my-cool_app 2") == "MYCOOLAPP2"
    assert spec.project_name(r"C:\Project\!!!") == "PROJECT"  # nothing alnum left -> fallback


def test_create_spec_if_missing_writes_a_well_formed_starter_and_is_idempotent(tmp_path):
    spec_dir = str(tmp_path / "spec" / "plan1")
    path = spec.create_spec_if_missing(spec_dir, "5", "New root task", "ANIMALALERT")
    assert os.path.isfile(path)
    assert os.path.basename(path) == "spec_5.md"

    parsed = spec.parse_spec(path)
    assert parsed["spec_id"] == "5"
    assert parsed["project"] == "ANIMALALERT"
    assert parsed["title"] == "New root task"
    assert parsed["source_leaf_id"] == "5"
    assert parsed["source_sec_index"] == 1

    # re-clicking "Add spec" must never overwrite real content
    spec.write_spec_raw(path, parsed["raw"] + "\nhand-written content\n")
    path2 = spec.create_spec_if_missing(spec_dir, "5", "New root task", "ANIMALALERT")
    assert path2 == path
    assert "hand-written content" in spec.parse_spec(path)["body"]


def test_create_spec_if_missing_for_a_subtask_id_does_not_append_a_section_index(tmp_path):
    # Regression: task "4.1" must get spec_4.1.md (matching how
    # openSpecPanel/find_spec_file/hasSpec resolve a row's spec by its own
    # id exactly) — not spec_4.1.1.md, which no lookup would ever find.
    spec_dir = str(tmp_path / "spec" / "plan5")
    path = spec.create_spec_if_missing(spec_dir, "4.1", "Some subtask", "ANIMALALERT")
    assert os.path.basename(path) == "spec_4.1.md"

    parsed = spec.parse_spec(path)
    assert parsed["spec_id"] == "4.1"
    assert parsed["title"] == "Some subtask"

    # the spec created for this exact row id must be found by the same
    # lookup openSpecPanel uses (spec_id == row.id)
    assert spec.find_spec_file(spec_dir, "4.1") == path
    assert "4.1" in spec.list_spec_ids(spec_dir)
