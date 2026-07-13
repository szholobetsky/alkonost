from alkonost import dashboard


def test_parse_missing_file_returns_empty_list():
    assert dashboard.parse_dashboard_flow("/nonexistent/dashboard_flow.md") == []


def test_write_and_reparse_round_trip(tmp_path):
    path = tmp_path / "dashboard_flow.md"
    flow = ["selected", "active", "paused", "testing", "done", "releasing"]
    dashboard.write_dashboard_flow(str(path), flow)
    assert dashboard.parse_dashboard_flow(str(path)) == flow


def test_parse_strips_plus_prefix_and_whitespace(tmp_path):
    path = tmp_path / "dashboard_flow.md"
    path.write_text("+selected,  +active ,+paused\n", encoding="utf-8")
    assert dashboard.parse_dashboard_flow(str(path)) == ["selected", "active", "paused"]


def test_empty_line_is_empty_list(tmp_path):
    path = tmp_path / "dashboard_flow.md"
    path.write_text("\n", encoding="utf-8")
    assert dashboard.parse_dashboard_flow(str(path)) == []
