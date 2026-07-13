"""flask_api.py — Alkonost's Flask app: static UI + JSON API.

No LLM calls anywhere — pure read/render/edit over already-generated
1bcoder deepagent_md/deepagent_spec/deepagent_task artifacts (same
"deterministic compiler, not a generator" principle already established
for deepagent_task itself).

Project ids are opaque (sha1-derived, see discovery.project_id) rather
than raw filesystem paths in URLs, since project roots are absolute
Windows paths containing ':' and '\\'. Every route resolves `project=<id>`
by re-running discovery.discover_projects() fresh — cheap given the
depth cap + ignore-list, and sidesteps any stale-cache invalidation
question since ids are a pure function of path.
"""
import os

from flask import Flask, jsonify, request, redirect, send_from_directory

from . import colors as colors_mod
from . import config as config_mod
from . import dashboard as dashboard_mod
from . import discovery
from . import planmd
from . import spec as spec_mod
from . import tasks as tasks_mod

_DOT1BCODER = ".1bcoder"


def _plan_dir(root: str, plan: str) -> str:
    return os.path.join(root, _DOT1BCODER, "planMD", plan)


def _spec_dir(root: str, plan: str) -> str:
    return os.path.join(root, _DOT1BCODER, "spec", plan)


def _tasks_dir(root: str, plan: str) -> str:
    return os.path.join(root, _DOT1BCODER, "tasks", plan)


def _tasks_path(root: str, plan: str) -> str:
    return os.path.join(_tasks_dir(root, plan), "tasks.md")


def _colors_path(root: str) -> str:
    return os.path.join(root, _DOT1BCODER, "tasks", "colors.md")


def _dashboard_flow_path(root: str) -> str:
    return os.path.join(root, _DOT1BCODER, "tasks", "dashboard_flow.md")


def create_app(root: str, max_depth: int = 6) -> Flask:
    app = Flask(__name__, static_folder=None)
    root = os.path.abspath(root)

    def _resolve_project(project_id: str):
        projects = discovery.discover_projects(root, max_depth)
        entry = projects.get(project_id)
        return entry["root"] if entry else None

    def _unknown_project():
        return jsonify({"error": "unknown project id — refresh /api/projects"}), 404

    # ── API ──────────────────────────────────────────────────────────────

    @app.route("/api/config", methods=["GET"])
    def api_config_get():
        return jsonify(config_mod.read_config())

    @app.route("/api/config", methods=["POST"])
    def api_config_post():
        body = request.get_json(force=True, silent=True) or {}
        cfg = config_mod.read_config()
        cfg.update(body)
        config_mod.write_config(cfg)
        return jsonify({"ok": True})

    @app.route("/api/themes")
    def api_themes():
        themes_dir = os.path.join(os.path.dirname(__file__), "ui", "themes")
        if not os.path.isdir(themes_dir):
            return jsonify({"themes": ["ocean"]})
        themes = sorted(
            os.path.splitext(f)[0] for f in os.listdir(themes_dir) if f.endswith(".css")
        )
        return jsonify({"themes": themes or ["ocean"]})

    @app.route("/api/projects")
    def api_projects():
        projects = discovery.discover_projects(root, max_depth)
        return jsonify([
            {"id": pid, "root": info["root"], "name": info["name"], "plan_count": info["plan_count"]}
            for pid, info in sorted(projects.items(), key=lambda kv: kv[1]["name"])
        ])

    @app.route("/api/plans")
    def api_plans():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        return jsonify(discovery.list_plans(project_root))

    @app.route("/api/planmd/tree")
    def api_planmd_tree():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        return jsonify(planmd.build_tree(plan_dir))

    @app.route("/api/item", methods=["GET", "POST"])
    def api_item():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        item_id = request.args.get("item_id", "")
        plan_dir = _plan_dir(project_root, plan)
        all_ids = planmd.collect_node_ids(plan_dir)
        if item_id not in all_ids:
            return jsonify({"error": "item not found"}), 404

        if request.method == "POST":
            body = request.get_json(force=True, silent=True) or {}
            planmd.write_item_raw(plan_dir, item_id, body.get("raw", ""))
            return jsonify({"ok": True})

        return jsonify({
            "id": item_id,
            "title": planmd.read_title(plan_dir, item_id),
            "raw": planmd.read_item(plan_dir, item_id),
            "children": planmd.child_ids(item_id, all_ids),
            "is_leaf": planmd.is_leaf(item_id, all_ids),
        })

    @app.route("/api/spec", methods=["GET", "POST"])
    def api_spec():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        spec_id = request.args.get("spec_id", "")
        spec_dir = _spec_dir(project_root, plan)
        path = spec_mod.find_spec_file(spec_dir, spec_id)
        if not path:
            return jsonify({"error": "spec not found"}), 404

        if request.method == "POST":
            body = request.get_json(force=True, silent=True) or {}
            spec_mod.write_spec_raw(path, body.get("raw", ""))
            return jsonify({"ok": True})

        parsed = spec_mod.parse_spec(path)
        if not parsed:
            return jsonify({"error": "spec not found"}), 404
        return jsonify(parsed)

    @app.route("/api/spec_index")
    def api_spec_index():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        spec_dir = _spec_dir(project_root, plan)
        return jsonify({"spec_ids": spec_mod.list_spec_ids(spec_dir)})

    @app.route("/api/spec/create", methods=["POST"])
    def api_spec_create():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        body = request.get_json(force=True, silent=True) or {}
        task_id = body.get("task_id", "")
        title = body.get("title") or task_id
        if not task_id:
            return jsonify({"error": "task_id required"}), 400

        spec_dir = _spec_dir(project_root, plan)
        project_name = spec_mod.project_name(project_root)
        path = spec_mod.create_spec_if_missing(spec_dir, task_id, title, project_name)
        parsed = spec_mod.parse_spec(path)
        if not parsed:
            return jsonify({"error": "failed to create spec"}), 500
        return jsonify(parsed)

    @app.route("/api/tasks", methods=["GET"])
    def api_tasks_get():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        path = _tasks_path(project_root, plan)
        if not os.path.isfile(path):
            return jsonify({"plan": plan, "exists": False, "rows": []})
        return jsonify({"plan": plan, "exists": True, "rows": tasks_mod.parse_tasks_md(path)})

    @app.route("/api/tasks", methods=["POST"])
    def api_tasks_post():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        path = _tasks_path(project_root, plan)

        body = request.get_json(force=True, silent=True) or {}
        submitted_rows = body.get("rows", [])
        for row in submitted_rows:
            row.setdefault("depth", row["id"].count(".") + 1)
            row.setdefault("tags", {})

        existing_rows = tasks_mod.parse_tasks_md(path) if os.path.isfile(path) else []
        if not tasks_mod.validate_row_ids(existing_rows, submitted_rows):
            return jsonify({"error": "row id set does not match tasks.md on disk — reload and retry"}), 409

        os.makedirs(_tasks_dir(project_root, plan), exist_ok=True)
        tasks_mod.rewrite_tasks_md(path, plan, submitted_rows)
        return jsonify({"ok": True, "row_count": len(submitted_rows)})

    @app.route("/api/colors", methods=["GET"])
    def api_colors_get():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        return jsonify({"colors": colors_mod.parse_colors(_colors_path(project_root))})

    @app.route("/api/colors", methods=["POST"])
    def api_colors_post():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        body = request.get_json(force=True, silent=True) or {}
        colors = body.get("colors", {})
        os.makedirs(os.path.join(project_root, _DOT1BCODER, "tasks"), exist_ok=True)
        colors_mod.write_colors(_colors_path(project_root), colors)
        return jsonify({"ok": True})

    @app.route("/api/dashboard_flow", methods=["GET"])
    def api_dashboard_flow_get():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        return jsonify({"flow": dashboard_mod.parse_dashboard_flow(_dashboard_flow_path(project_root))})

    @app.route("/api/dashboard_flow", methods=["POST"])
    def api_dashboard_flow_post():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        body = request.get_json(force=True, silent=True) or {}
        flow = body.get("flow", [])
        os.makedirs(os.path.join(project_root, _DOT1BCODER, "tasks"), exist_ok=True)
        dashboard_mod.write_dashboard_flow(_dashboard_flow_path(project_root), flow)
        return jsonify({"ok": True})

    # ── static UI ────────────────────────────────────────────────────────

    _ui_dir = os.path.join(os.path.dirname(__file__), "ui")

    if os.path.isdir(_ui_dir):
        @app.route("/")
        def _ui_root():
            return redirect("/ui/")

        @app.route("/ui/")
        def _ui_index():
            return send_from_directory(_ui_dir, "index.html")

        @app.route("/ui/<path:filename>")
        def _ui_static(filename):
            return send_from_directory(_ui_dir, filename)

    return app
