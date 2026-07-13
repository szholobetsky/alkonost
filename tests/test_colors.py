import os

from conftest import PROJ_A
from alkonost import colors

COLORS_PATH = os.path.join(PROJ_A, ".1bcoder", "tasks", "colors.md")


def test_parse_colors():
    parsed = colors.parse_colors(COLORS_PATH)
    assert parsed == {"backend": "#4A90D9", "frontend": "#7ED321"}


def test_parse_missing_file_returns_empty_dict():
    assert colors.parse_colors("/nonexistent/colors.md") == {}


def test_write_and_reparse_round_trip(tmp_path):
    path = tmp_path / "colors.md"
    data = {"backend": "#111111", "infra": "#222222"}
    colors.write_colors(str(path), data)
    assert colors.parse_colors(str(path)) == data
