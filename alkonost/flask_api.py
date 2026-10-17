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
import pathlib
import shutil
import time

from flask import Flask, jsonify, request, redirect, send_from_directory, Response

from . import colors as colors_mod
from . import config as config_mod
from . import dashboard as dashboard_mod
from . import discovery
from . import glossary as glossary_mod
from . import planmd
from . import runner as runner_mod
from . import settings as settings_mod
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

    @app.route("/api/projects/folders")
    def api_project_folders():
        try:
            listing = discovery.list_folders(root, request.args.get("path", ""), max_depth)
        except discovery.ProjectPathError as e:
            return jsonify({"error": str(e)}), 400
        return jsonify(dict(listing, root=root))

    @app.route("/api/projects/create", methods=["POST"])
    def api_project_create():
        body = request.get_json(force=True, silent=True) or {}
        try:
            pid = discovery.make_project(root, body.get("path", ""), max_depth)
        except discovery.ProjectPathError as e:
            return jsonify({"error": str(e)}), 400
        except OSError as e:
            return jsonify({"error": f"cannot create .1bcoder/: {e}"}), 500
        return jsonify({"id": pid})

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

    # ── PLAN generation (concepts/ALKONOST_ADVANCE.md §3.2) ────────────────
    # No LLM calls happen in this process — every route here launches the
    # real 1bcoder process via --scriptapply (runner.py) and streams back
    # its own stdout. --host/--model are deliberately never passed, so
    # whatever the SETTINGS routes below wrote to config.yml is what
    # actually runs.

    @app.route("/api/flow_help", methods=["POST"])
    def api_flow_help():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        body = request.get_json(force=True, silent=True) or {}
        flow_key = (body.get("flow") or "").strip()
        if not flow_key:
            return jsonify({"error": "flow is required"}), 400
        flow_name = runner_mod.FLOW_BY_KEY.get(flow_key, flow_key)
        try:
            launch_id = runner_mod.launch(project_root, "flow_help", {"flow": flow_name})
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/plan/task")
    def api_plan_task():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        index_path = os.path.join(_plan_dir(project_root, plan), "index.md")
        task = ""
        if os.path.isfile(index_path):
            try:
                with open(index_path, encoding="utf-8") as f:
                    task = f.readline().lstrip("#").strip()
            except OSError:
                pass
        return jsonify({"task": task})

    @app.route("/api/plan/engine", methods=["GET", "POST"])
    def api_plan_engine():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        if request.method == "POST":
            body = request.get_json(force=True, silent=True) or {}
            engine = body.get("engine", "")
            if engine not in runner_mod.FLOW_BY_KEY:
                return jsonify({"error": f"engine must be one of {list(runner_mod.FLOW_BY_KEY)}"}), 400
            runner_mod.write_engine(plan_dir, runner_mod.FLOW_BY_KEY[engine])
            return jsonify({"ok": True})
        return jsonify({"engine": runner_mod.read_engine(plan_dir)})

    @app.route("/api/plan/source_params")
    def api_plan_source_params():
        """Backs the "Create new plan based on this" button: reads the
        original task/maxdepth/cfg this plan was generated with, so the
        Init tab's generation form can be prefilled to re-run the same
        task -- typically through a different, more technical model set
        in SETTINGS than whatever generated the original plan."""
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        meta = runner_mod.read_plan_meta(plan_dir)
        if not meta:
            return jsonify({"error": "no _deepagent_meta.yaml found for this plan"}), 404
        engine = runner_mod.read_engine(plan_dir)
        flow_by_engine = {v: k for k, v in runner_mod.FLOW_BY_KEY.items()}
        flow = flow_by_engine.get(engine, "")
        return jsonify({
            "task": meta.get("task", ""),
            "maxdepth": meta.get("maxdepth", 1),
            "flow": flow,
            "extra": "",
        })

    @app.route("/api/plan/generate", methods=["POST"])
    def api_plan_generate():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        body = request.get_json(force=True, silent=True) or {}
        flow = body.get("flow", "")
        if flow not in runner_mod.FLOW_BY_KEY:
            return jsonify({"error": f"flow must be one of {list(runner_mod.FLOW_BY_KEY)}"}), 400
        task = (body.get("task") or "").strip()
        if not task:
            return jsonify({"error": "task is required"}), 400
        maxdepth = body.get("maxdepth", 1)
        extra = body.get("extra", "") or ""

        # ── optional RAG grounding (concepts/ALKONOST_ADVANCE.md §2) ────────
        # --rag/--rag-store already exist in deepagent_md/tree/tree_md — no
        # new 1bcoder code, just appending the flags. The store lives inside
        # the SOURCE plan's own directory (<rag_source_plan_dir>/.simargl/),
        # matching where /api/plan/rag_index (below) actually writes it.
        rag_name = (body.get("rag_name") or "").strip()
        rag_source_plan = (body.get("rag_source_plan") or "").strip()
        if rag_name and rag_source_plan:
            rag_store = _plan_dir(project_root, rag_source_plan)
            # single quotes: deepagent_md's --rag-store accepts them, and the
            # value goes into the script line verbatim (runner.render_script).
            extra = f"{extra} --rag {rag_name} --rag-store '{rag_store}'".strip()

        try:
            launch_id = runner_mod.launch(project_root, f"plan_{flow}", {
                "task": f'"{task}"', "maxdepth": maxdepth, "extra": extra,
            })
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/plan/rag_projects")
    def api_plan_rag_projects():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        return jsonify({"projects": runner_mod.list_rag_projects(plan_dir)})

    @app.route("/api/plan/rag_index", methods=["POST"])
    def api_plan_rag_index():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        body = request.get_json(force=True, silent=True) or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name is required"}), 400
        try:
            launch_id = runner_mod.launch(project_root, "rag_index", {
                "plan_dir": plan_dir, "rag_name": name,
            })
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/axis/compose", methods=["POST"])
    def api_axis_compose():
        # Delegates the actual reformulation to 1bcoder itself, via the
        # same --scriptapply mechanism every other generation action uses —
        # Alkonost makes zero LLM calls of its own. This one step is a
        # plain, non-"/"-prefixed line, so 1bcoder just sends it to the
        # model as a normal chat message and streams the reply back.
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        body = request.get_json(force=True, silent=True) or {}
        task = (body.get("task") or "").strip()
        axis = (body.get("axis") or "").strip()
        if not task:
            return jsonify({"error": "task is required"}), 400
        if not axis:
            return jsonify({"error": "axis is required"}), 400
        try:
            launch_id = runner_mod.launch(project_root, "axis_compose", {"task": task, "axis": axis})
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/plan/continue", methods=["POST"])
    def api_plan_continue():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        engine = runner_mod.read_engine(plan_dir)
        if not engine:
            return jsonify({"error": "this plan's engine is not set yet — "
                                      "see /api/plan/engine (POST) first"}), 409
        body = request.get_json(force=True, silent=True) or {}
        label = (body.get("label") or "").strip()
        if not label:
            return jsonify({"error": "label is required"}), 400
        try:
            launch_id = runner_mod.launch(project_root, "plan_continue", {
                "engine": engine, "plan_dir": plan_dir, "label": label,
            })
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/plan/redo", methods=["POST"])
    def api_plan_redo():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        engine = runner_mod.read_engine(plan_dir)
        if not engine:
            return jsonify({"error": "this plan's engine is not set yet — "
                                      "see /api/plan/engine (POST) first"}), 409
        body = request.get_json(force=True, silent=True) or {}
        node_id = (body.get("node_id") or "").strip()
        if not node_id:
            return jsonify({"error": "node_id is required"}), 400
        try:
            launch_id = runner_mod.launch(project_root, "plan_redo", {
                "engine": engine, "plan_dir": plan_dir, "node_id": node_id,
            })
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/plan/resume", methods=["POST"])
    def api_plan_resume():
        # Finishes this plan's ORIGINAL generation if it was Stopped
        # partway (distinct from /api/plan/continue, which grows an
        # already-complete tree with a brand new layer).
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        engine = runner_mod.read_engine(plan_dir)
        if not engine:
            return jsonify({"error": "this plan's engine is not set yet — "
                                      "see /api/plan/engine (POST) first"}), 409
        # A `continue` call that got Stopped (hard taskkill, not a
        # graceful Ctrl+C) never reaches 1bcoder's own post-loop
        # _save_meta() — see bump_meta_maxdepth's own docstring — so
        # _deepagent_meta.yaml's maxdepth can be stale/shallower than what
        # the tree on disk actually reached. Bring it up to date first so
        # `resume` fills in every still-missing branch instead of seeing a
        # falsely "already complete" tree and doing nothing.
        runner_mod.bump_meta_maxdepth(plan_dir)
        try:
            launch_id = runner_mod.launch(project_root, "plan_resume", {
                "engine": engine, "plan_dir": plan_dir,
            })
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    # ── RADOGAST (its own dedicated page — key terms, out-of-scope, and the
    # similarity threshold all editable there, not baked-in defaults) ──────

    def _read_index_md(plan_dir: str) -> str:
        index_path = os.path.join(plan_dir, "index.md")
        if not os.path.isfile(index_path):
            return ""
        try:
            with open(index_path, encoding="utf-8") as f:
                return f.read()
        except OSError:
            return ""

    def _radogast_task_text(plan_dir: str, scope: str):
        """Returns (candidate_text, reference_text).

        candidate_text is ALWAYS used raw, completely unmodified, in
        BOTH scopes -- extract_core_task_text() is applied only to
        derive reference_text, never to the candidate pool itself.
        Confirmed live this distinction has to be absolute, not just
        "safe enough at small sizes": applying it to a candidate pool
        risks a catastrophic collapse if that text happens to contain ANY
        quoted phrase longer than the real task, and there's no size
        threshold below which that's truly impossible -- it was first
        confirmed on a 180K-character whole-tree candidate text (an
        incidental quote buried in one leaf's own prose won out as
        "longest"), but a short index.md alone could just as easily
        contain its own unrelated long quote; lower odds, not zero.

        "full" — candidates: the whole plan (index.md + every
          item_<id>.md), so a term only mentioned deep in one leaf still
          counts. reference: index.md alone, core-extracted -- ranking
          key terms against the whole tree's own centroid surfaces
          generic architecture vocabulary instead of domain-specific ones
          (see derive_target_embedded's own docstring) since that's
          simply what most of a deep technical tree discusses at every
          level.
        "index" — candidates: index.md alone, raw. reference: the SAME
          index.md content, but core-extracted -- e.g. axis_compose's own
          composed output ("You are an expert ... project requirement:
          <the real task>...") gets ranked against just "<the real
          task>...", not the instructional preamble, while the candidate
          pool still includes every word in the file, preamble included."""
        index_text = _read_index_md(plan_dir)
        reference = runner_mod.extract_core_task_text(index_text) if index_text else None
        if scope == "full":
            return planmd.full_text(plan_dir), reference
        return index_text, reference

    @app.route("/api/radogast/target", methods=["GET", "POST"])
    def api_radogast_target():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        if request.method == "POST":
            body = request.get_json(force=True, silent=True) or {}
            runner_mod.write_radogast_target(
                plan_dir,
                goal=(body.get("goal") or "").strip(),
                key_terms=[t.strip() for t in (body.get("key_terms") or []) if t.strip()],
                out_of_scope=[t.strip() for t in (body.get("out_of_scope") or []) if t.strip()],
            )
            return jsonify({"ok": True})
        return jsonify(runner_mod.read_radogast_target(plan_dir))

    @app.route("/api/radogast/derive", methods=["POST"])
    def api_radogast_derive():
        # Pure suggestion — never writes to disk itself (write_radogast_target
        # via the Save button does that once the user has reviewed/edited).
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        body = request.get_json(force=True, silent=True) or {}
        scope = body.get("scope") or "index"
        task_text, reference_text = _radogast_task_text(plan_dir, scope)
        if not task_text:
            return jsonify({"error": "no index.md for this plan yet"}), 400
        try:
            suggestion = runner_mod.derive_radogast_target(task_text, reference_text=reference_text)
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify(suggestion)

    @app.route("/api/radogast/analyze", methods=["POST"])
    def api_radogast_analyze():
        # No engine/model needed here — radogast makes no LLM calls of its
        # own (embeddings + term-matching, deterministic); see
        # launch_radogast_plan_analysis's own docstring.
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        if not os.path.isfile(os.path.join(plan_dir, "index.md")):
            return jsonify({"error": "no index.md for this plan yet — generate it first"}), 400
        body = request.get_json(force=True, silent=True) or {}
        try:
            threshold = float(body.get("threshold", 0.85))
        except (TypeError, ValueError):
            threshold = 0.85
        show_all = bool(body.get("show_all"))
        try:
            launch_id = runner_mod.launch_radogast_plan_analysis(plan_dir, threshold=threshold, show_all=show_all)
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/radogast/help", methods=["POST"])
    def api_radogast_help():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        try:
            launch_id = runner_mod.launch_radogast_help(project_root)
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/launch/stop", methods=["POST"])
    def api_launch_stop():
        body = request.get_json(force=True, silent=True) or {}
        launch_id = (body.get("launch_id") or "").strip()
        if not launch_id:
            return jsonify({"error": "launch_id is required"}), 400
        stopped = runner_mod.stop(launch_id)
        return jsonify({"ok": True, "stopped": stopped})

    @app.route("/api/plan/log/<launch_id>")
    def api_plan_log_stream(launch_id):
        path = runner_mod.log_path(launch_id)

        def gen():
            offset = 0
            pending = ""  # see runner.split_complete_lines's own docstring
            while True:
                chunk = ""
                try:
                    with open(path, encoding="utf-8", errors="replace") as f:
                        f.seek(offset)
                        chunk = f.read()
                        offset = f.tell()
                except OSError:
                    pass
                if chunk:
                    lines, pending = runner_mod.split_complete_lines(pending, chunk)
                    for line in lines:
                        yield f"data: {runner_mod.strip_ansi(line)}\n\n"
                st = runner_mod.status(launch_id)
                if st in ("done", "failed", "unknown", "stopped") and not chunk:
                    if pending:
                        yield f"data: {runner_mod.strip_ansi(pending)}\n\n"
                        pending = ""
                    yield f"event: status\ndata: {st}\n\n"
                    break
                time.sleep(1)

        return Response(gen(), mimetype="text/event-stream")

    # ── SPEC generation (deepagent_spec, over the currently selected plan) ──

    @app.route("/api/spec/generate", methods=["POST"])
    def api_spec_generate():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        if not plan:
            return jsonify({"error": "plan is required"}), 400
        body = request.get_json(force=True, silent=True) or {}
        focus = (body.get("focus") or "").strip()
        ctx = body.get("ctx", 0)
        profile = (body.get("profile") or "").strip()
        predictable = bool(body.get("predictable"))
        extra_parts = []
        if focus:
            extra_parts.append(f'--focus "{focus}"')
        if ctx:
            extra_parts.append(f"--ctx {ctx}")
        if profile:
            extra_parts.append(f"--profile {profile}")
        if predictable:
            extra_parts.append("--predictable")
        extra_parts.append((body.get("extra") or "").strip())
        extra = " ".join(p for p in extra_parts if p)
        try:
            launch_id = runner_mod.launch(project_root, "spec_generate", {
                "plan": plan, "extra": extra,
            })
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/spec/redo", methods=["POST"])
    def api_spec_redo():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        plan_dir = _plan_dir(project_root, plan)
        body = request.get_json(force=True, silent=True) or {}
        unit_id = (body.get("unit_id") or "").strip()
        if not unit_id:
            return jsonify({"error": "unit_id is required"}), 400
        try:
            launch_id = runner_mod.launch(project_root, "spec_redo", {
                "plan_dir": plan_dir, "unit_id": unit_id,
            })
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/task/generate", methods=["POST"])
    def api_task_generate():
        # deepagent_task rolls up this plan's spec_*.md units (plus plain
        # container titles for leaves with no spec yet) into tasks.md — the
        # deterministic compile step between Spec (generation) and Tasks
        # (the board that reads its output). No LLM call.
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        plan = request.args.get("plan", "")
        if not plan:
            return jsonify({"error": "plan is required"}), 400
        try:
            launch_id = runner_mod.launch(project_root, "task_generate", {"plan": plan})
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    # ── GLOSSARY (1bcoder's /flow glossary: launch, browse, search) ─────────
    # Launches go through runner.py like every other generation action; the
    # articles are read here (glossary.py re-implements their format); the
    # search calls simargl over the glossary's own store — no LLM call.

    def _glossary_dir_or_error(project_root: str, name: str):
        try:
            gdir = glossary_mod.glossary_dir(project_root, name)
        except glossary_mod.GlossaryError as e:
            return None, (jsonify({"error": str(e)}), 400)
        if not os.path.isfile(os.path.join(gdir, "glossary.md")):
            return None, (jsonify({"error": f"no glossary '{name}' in this project"}), 404)
        return gdir, None

    @app.route("/api/glossary/list")
    def api_glossary_list():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        return jsonify({"glossaries": glossary_mod.list_glossaries(project_root)})

    @app.route("/api/glossary/terms")
    def api_glossary_terms():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        gdir, err = _glossary_dir_or_error(project_root, request.args.get("name", ""))
        if err:
            return err
        return jsonify({"terms": glossary_mod.term_rows(gdir)})

    @app.route("/api/glossary/term")
    def api_glossary_term():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        gdir, err = _glossary_dir_or_error(project_root, request.args.get("name", ""))
        if err:
            return err
        term = request.args.get("term", "")
        try:
            article = glossary_mod.read_article(gdir, term)
        except glossary_mod.GlossaryError as e:
            return jsonify({"error": str(e)}), 400
        if article is None:
            return jsonify({"error": "term not found"}), 404
        article["term"] = term
        article["kind_verdict"] = glossary_mod.term_kind(article["kind"])
        return jsonify(article)

    @app.route("/api/glossary/index", methods=["POST"])
    def api_glossary_index():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        body = request.get_json(force=True, silent=True) or {}
        name = (body.get("name") or "").strip()
        if not glossary_mod.safe_name(name):
            return jsonify({"error": "name is required: letters, digits, '-', '_', '.'"}), 400
        source = (body.get("source") or "").strip()
        if not source:
            return jsonify({"error": "source is required (a file or folder of this project)"}), 400
        try:
            target, _root = _files_safe(project_root, source)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        if not target.exists():
            return jsonify({"error": f"not found in this project: {source}"}), 400
        try:
            extra = glossary_mod.index_extra(body)
        except glossary_mod.GlossaryError as e:
            return jsonify({"error": str(e)}), 400
        try:
            launch_id = runner_mod.launch(project_root, "glossary_index", {
                "source": source, "name": name, "extra": extra,
            })
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/glossary/rag_index", methods=["POST"])
    def api_glossary_rag_index():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        gdir, err = _glossary_dir_or_error(project_root, request.args.get("name", ""))
        if err:
            return err
        try:
            launch_id = runner_mod.launch(project_root, "rag_index", {
                "plan_dir": gdir, "rag_name": glossary_mod.RAG_PROJECT,
            })
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/glossary/run", methods=["POST"])
    def api_glossary_run():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        name = request.args.get("name", "")
        gdir, err = _glossary_dir_or_error(project_root, name)
        if err:
            return err
        try:
            cmd, args = glossary_mod.run_command(request.get_json(force=True, silent=True) or {})
        except glossary_mod.GlossaryError as e:
            return jsonify({"error": str(e)}), 400
        try:
            launch_id = runner_mod.launch(project_root, "glossary_cmd", {"cmd": cmd, "args": args, "name": name})
        except runner_mod.LaunchError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"launch_id": launch_id})

    @app.route("/api/glossary/search")
    def api_glossary_search():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        gdir, err = _glossary_dir_or_error(project_root, request.args.get("name", ""))
        if err:
            return err
        q = (request.args.get("q") or "").strip()
        if not q:
            return jsonify({"error": "q is required"}), 400
        try:
            hits = glossary_mod.search(gdir, q)
        except glossary_mod.GlossaryError as e:
            return jsonify({"error": str(e)}), 409
        return jsonify({"results": hits})

    # ── SETTINGS (concepts/ALKONOST_ADVANCE.md §3.1 — two separate stores) ─

    def _1bcoder_config_path(scope: str, project_root: str | None):
        if scope == "global":
            return settings_mod.global_config_path()
        return settings_mod.project_config_path(project_root)

    @app.route("/api/settings/1bcoder", methods=["GET", "POST"])
    def api_settings_1bcoder():
        scope = request.args.get("scope", "project")
        project_root = None
        if scope == "project":
            project_root = _resolve_project(request.args.get("project", ""))
            if project_root is None:
                return _unknown_project()
        path = _1bcoder_config_path(scope, project_root)
        if request.method == "POST":
            patch = request.get_json(force=True, silent=True) or {}
            settings_mod.write_settings(path, patch)
            return jsonify({"ok": True})
        return jsonify(settings_mod.settings_view(path))

    # ── FILES (generic file manager, ported from vyrii's /vyrii/files/*) ──
    # One real difference from vyrii's own version: vyrii's file manager is
    # rooted at the fixed ~/.vyrii directory (its own tool-private working
    # area). Alkonost has no equivalent private area — the thing worth
    # browsing here is the project itself — so every route below is rooted
    # at the currently selected project's own root directory instead,
    # resolved the same way every other route in this file resolves
    # `?project=<id>`. vyrii's directory-indexing ("Index" button, a direct
    # `simargl index files ...` subprocess call) and its LLM-backed "Scan"
    # button are intentionally NOT ported: Alkonost already has an
    # equivalent, 1bcoder-mediated RAG-indexing action on the Axis tab, and
    # Alkonost's own architecture makes zero LLM calls of its own outside
    # of delegating to 1bcoder — a direct "summarize this file" call from
    # here would be a new, inconsistent path.

    def _files_safe(project_root: str, rel: str):
        root = pathlib.Path(project_root).resolve()
        p = (root / (rel or "").lstrip("/\\")).resolve()
        if p != root and root not in p.parents:
            raise ValueError("Path outside project root")
        return p, root

    @app.route("/api/files/list")
    def api_files_list():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        rel = request.args.get("path", "").strip()
        try:
            target, root = _files_safe(project_root, rel)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        if not target.is_dir():
            return jsonify({"error": f"Not a directory: {rel}"}), 400
        # One directory level per call, not vyrii's eager full recursive
        # walk — a project root can hold node_modules/.git/venv and other
        # huge trees a tool-private ~/.vyrii never has to worry about, so
        # the frontend fetches each folder's children lazily on expand.
        try:
            entries = [{"name": item.name, "is_dir": item.is_dir()}
                       for item in sorted(target.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))]
        except OSError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"path": rel, "entries": entries})

    @app.route("/api/files/read")
    def api_files_read():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        rel = request.args.get("path", "").strip()
        if not rel:
            return jsonify({"error": "path is required"}), 400
        try:
            target, _root = _files_safe(project_root, rel)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        if not target.is_file():
            return jsonify({"error": f"Not a file: {rel}"}), 400
        MAX = 65536
        try:
            content = target.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return jsonify({"error": f"Cannot read: {e}"}), 500
        return jsonify({
            "name": target.name, "path": rel, "size": target.stat().st_size,
            "content": content[:MAX], "truncated": len(content) > MAX,
        })

    @app.route("/api/files/mkdir", methods=["POST"])
    def api_files_mkdir():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        body = request.get_json(force=True, silent=True) or {}
        rel = (body.get("path") or "").strip()
        if not rel:
            return jsonify({"error": "path is required"}), 400
        try:
            target, _root = _files_safe(project_root, rel)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        try:
            target.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"ok": True, "path": rel})

    @app.route("/api/files/upload", methods=["POST"])
    def api_files_upload():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        dest = (request.args.get("dest") or request.form.get("dest") or "").strip()
        saved, errors = [], []
        for f in request.files.getlist("files"):
            try:
                fname = f.filename or "upload"
                rel = f"{dest.rstrip('/\\')}/{fname}" if dest else fname
                target, root = _files_safe(project_root, rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                f.save(str(target))
                saved.append(str(target.relative_to(root)))
            except Exception as e:
                errors.append({"file": getattr(f, "filename", "?"), "error": str(e)})
        if errors and not saved:
            return jsonify({"error": errors}), 400
        return jsonify({"ok": True, "saved": saved, **({"errors": errors} if errors else {})})

    @app.route("/api/files", methods=["DELETE"])
    def api_files_delete():
        project_root = _resolve_project(request.args.get("project", ""))
        if project_root is None:
            return _unknown_project()
        body = request.get_json(force=True, silent=True) or {}
        rel = (body.get("path") or "").strip()
        if not rel:
            return jsonify({"error": "path is required"}), 400
        try:
            target, root = _files_safe(project_root, rel)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        if target == root:
            return jsonify({"error": "refusing to delete the project root"}), 400
        try:
            if target.is_dir():
                shutil.rmtree(target)
            elif target.is_file():
                target.unlink()
            else:
                return jsonify({"error": f"Not found: {rel}"}), 404
        except OSError as e:
            return jsonify({"error": str(e)}), 500
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
