import os

import pytest

from alkonost import runner


def test_ensure_script_writes_template_once(tmp_path):
    fname = runner.ensure_script(str(tmp_path), "plan_tree_md")
    path = os.path.join(str(tmp_path), ".1bcoder", "scripts", fname)
    assert os.path.isfile(path)
    original = open(path, encoding="utf-8").read()
    assert "{{task}}" in original
    assert "{{maxdepth}}" in original

    # editable per-project afterward, same convention as colors.md — a
    # second ensure_script call must NOT clobber a hand-edited script
    with open(path, "w", encoding="utf-8") as f:
        f.write("/flow deepagent_tree_md {{task}} --maxdepth {{maxdepth}} --web 3\n")
    runner.ensure_script(str(tmp_path), "plan_tree_md")
    assert "--web 3" in open(path, encoding="utf-8").read()


def test_ensure_script_writes_rag_and_spec_templates(tmp_path):
    for action, must_contain in [
        ("rag_index", ["--path", "{{plan_dir}}", "files .", "--project", "{{rag_name}}"]),
        ("spec_generate", ["deepagent_spec", "{{plan}}", "{{extra}}"]),
        ("spec_redo", ["deepagent_spec redo", "{{plan_dir}}", "{{unit_id}}"]),
        # resume finishes an interrupted ORIGINAL generation (distinct
        # from continue, which grows an already-complete tree) — no
        # node_id/label param, just engine + plan_dir.
        ("plan_resume", ["{{engine}} resume", "{{plan_dir}}"]),
        # {{plan}} must stay the bare plan name here, never plan_dir — see
        # _TEMPLATES["task_generate"]'s own comment for why.
        ("task_generate", ["deepagent_task", "{{plan}}"]),
    ]:
        fname = runner.ensure_script(str(tmp_path), action)
        path = os.path.join(str(tmp_path), ".1bcoder", "scripts", fname)
        content = open(path, encoding="utf-8").read()
        for token in must_contain:
            assert token in content, f"{action}: missing {token!r} in {content!r}"


def test_list_rag_projects_reads_simargl_subdirs(tmp_path):
    plan_dir = str(tmp_path / "plan1")
    assert runner.list_rag_projects(plan_dir) == []

    os.makedirs(os.path.join(plan_dir, ".simargl", "plan1_rag"))
    os.makedirs(os.path.join(plan_dir, ".simargl", "another_rag"))
    # a stray file next to the project dirs must not show up as a project
    open(os.path.join(plan_dir, ".simargl", "meta.json"), "w").close()

    assert runner.list_rag_projects(plan_dir) == ["another_rag", "plan1_rag"]


def test_engine_sidecar_round_trip(tmp_path):
    plan_dir = str(tmp_path / "plan1")
    assert runner.read_engine(plan_dir) == ""
    runner.write_engine(plan_dir, "deepagent_tree_md")
    assert runner.read_engine(plan_dir) == "deepagent_tree_md"


def test_tree_max_depth_finds_the_deepest_item_file(tmp_path):
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(plan_dir)
    assert runner._tree_max_depth(plan_dir) == 0
    for name in ("index.md", "item_1.md", "item_1.1.md", "item_1.1.1.1.1.1.md",
                 "_alkonost_engine.txt", "_deepagent_meta.yaml"):
        open(os.path.join(plan_dir, name), "w").close()
    assert runner._tree_max_depth(plan_dir) == 6


# Real _deepagent_meta.yaml shape (task uses a multi-line YAML block
# scalar, cfg is a nested dict) — bump_meta_maxdepth must touch ONLY the
# maxdepth line, confirmed byte-for-byte below, not just "still parses".
_REAL_META_YAML = """task: 'You are an expert software architect and decomposition specialist. Your task
  is to recursively decompose the complex project requirement: Create an AnimalAlert
  system.'
plan_labels:
- overview
- analysis
- implementation
aspects: []
maxdepth: 2
use_web: false
cfg:
  web_n: 3
  rag_project: plan1_rag
  dedup_threshold: 0.85
"""


def test_bump_meta_maxdepth_raises_a_stale_value_and_touches_nothing_else(tmp_path):
    plan_dir = str(tmp_path / "plan6")
    os.makedirs(plan_dir)
    meta_path = os.path.join(plan_dir, "_deepagent_meta.yaml")
    with open(meta_path, "w", encoding="utf-8") as f:
        f.write(_REAL_META_YAML)
    # A `continue` call reached depth 6 on one branch before being
    # hard-killed, so _save_meta() (which would have raised maxdepth to 6)
    # never ran — this is exactly that on-disk state.
    open(os.path.join(plan_dir, "item_1.1.1.1.1.1.md"), "w").close()

    runner.bump_meta_maxdepth(plan_dir)

    with open(meta_path, encoding="utf-8") as f:
        patched = f.read()
    assert patched == _REAL_META_YAML.replace("maxdepth: 2", "maxdepth: 6")


def test_bump_meta_maxdepth_never_lowers_an_existing_value(tmp_path):
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(plan_dir)
    meta_path = os.path.join(plan_dir, "_deepagent_meta.yaml")
    with open(meta_path, "w", encoding="utf-8") as f:
        f.write("task: 'x'\nmaxdepth: 10\n")
    open(os.path.join(plan_dir, "item_1.md"), "w").close()  # only depth 1 on disk

    runner.bump_meta_maxdepth(plan_dir)

    with open(meta_path, encoding="utf-8") as f:
        assert f.read() == "task: 'x'\nmaxdepth: 10\n"


def test_bump_meta_maxdepth_is_a_noop_without_a_meta_file(tmp_path):
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(plan_dir)
    open(os.path.join(plan_dir, "item_1.1.md"), "w").close()
    runner.bump_meta_maxdepth(plan_dir)  # must not raise
    assert not os.path.isfile(os.path.join(plan_dir, "_deepagent_meta.yaml"))


def test_read_plan_meta_parses_the_real_yaml_shape(tmp_path):
    plan_dir = str(tmp_path / "plan6")
    os.makedirs(plan_dir)
    with open(os.path.join(plan_dir, "_deepagent_meta.yaml"), "w", encoding="utf-8") as f:
        f.write(_REAL_META_YAML)

    meta = runner.read_plan_meta(plan_dir)

    assert meta["maxdepth"] == 2
    assert meta["task"].startswith("You are an expert software architect")
    assert meta["cfg"]["rag_project"] == "plan1_rag"


def test_read_plan_meta_is_empty_dict_without_a_meta_file(tmp_path):
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(plan_dir)
    assert runner.read_plan_meta(plan_dir) == {}


def test_flow_by_key_matches_engine_names():
    assert runner.FLOW_BY_KEY["tree_md"] == "deepagent_tree_md"
    assert runner.FLOW_BY_KEY["tree"] == "deepagent_tree"
    assert runner.FLOW_BY_KEY["md"] == "deepagent_md"


class _FakeProc:
    def __init__(self, returncode=None, pid=4242):
        self._returncode = returncode
        self.pid = pid

    def poll(self):
        return self._returncode


class _FakeCompleted:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_launch_radogast_plan_analysis_derives_target_then_analyzes(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(plan_dir)
    with open(os.path.join(plan_dir, "index.md"), "w", encoding="utf-8") as f:
        f.write("# Build an AnimalAlert system\n\n## 1. Overview\n")
    with open(os.path.join(plan_dir, "item_1.md"), "w", encoding="utf-8") as f:
        f.write("# Deep implementation detail mentioning Kotlin\n")

    run_calls = []
    monkeypatch.setattr(runner.subprocess, "run",
                         lambda cmd, **k: (run_calls.append((cmd, k)), _FakeCompleted())[1])
    popen_calls = {}
    monkeypatch.setattr(runner.subprocess, "Popen",
                         lambda cmd, **k: (popen_calls.__setitem__("cmd", cmd), _FakeProc())[1])

    launch_id = runner.launch_radogast_plan_analysis(plan_dir)

    assert len(run_calls) == 1
    derive_cmd, derive_kwargs = run_calls[0]
    assert derive_cmd[:3] == ["radogast", "target", "derive"]
    # planmd.full_text(plan_dir) -- index.md AND item_1.md -- goes over
    # stdin (`input=`), never as a CLI argument: a "full plan tree" text
    # can be tens of KB, well past Windows's CreateProcess argument-length
    # ceiling, confirmed live ("The filename or extension is too long").
    assert "Deep implementation detail mentioning Kotlin" in derive_kwargs["input"]
    assert "Build an AnimalAlert system" in derive_kwargs["input"]
    # index.md ALONE, though, is short enough and goes as --reference (a
    # normal CLI arg) -- ranking key terms against the WHOLE tree's own
    # centroid instead skews toward generic architecture vocabulary; see
    # derive_radogast_target's own docstring for the full reasoning.
    assert "--reference" in derive_cmd
    assert derive_cmd[derive_cmd.index("--reference") + 1] == "# Build an AnimalAlert system\n\n## 1. Overview\n"
    assert "--embed" in derive_cmd
    assert "--output" in derive_cmd
    target_path = derive_cmd[derive_cmd.index("--output") + 1]
    assert target_path == os.path.join(plan_dir, ".radogast", "task.yaml")

    assert popen_calls["cmd"] == ["radogast", "plan", "analyze", plan_dir, "--threshold", "0.85"]
    assert runner.status(launch_id) == "running"


def test_launch_radogast_plan_analysis_passes_threshold_and_show_all(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(os.path.join(plan_dir, ".radogast"))
    with open(os.path.join(plan_dir, ".radogast", "task.yaml"), "w", encoding="utf-8") as f:
        f.write("goal: hand-curated already\n")
    popen_calls = {}
    monkeypatch.setattr(runner.subprocess, "Popen",
                         lambda cmd, **k: (popen_calls.__setitem__("cmd", cmd), _FakeProc())[1])

    runner.launch_radogast_plan_analysis(plan_dir, threshold=0.72, show_all=True)

    assert popen_calls["cmd"] == ["radogast", "plan", "analyze", plan_dir, "--threshold", "0.72", "--all"]


def test_launch_radogast_plan_analysis_skips_derive_if_target_already_exists(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(os.path.join(plan_dir, ".radogast"))
    with open(os.path.join(plan_dir, ".radogast", "task.yaml"), "w", encoding="utf-8") as f:
        f.write("goal: hand-curated already\n")

    def fail_run(*a, **k):
        raise AssertionError("target derive should not run when task.yaml already exists")

    monkeypatch.setattr(runner.subprocess, "run", fail_run)
    monkeypatch.setattr(runner.subprocess, "Popen", lambda cmd, **k: _FakeProc())

    runner.launch_radogast_plan_analysis(plan_dir)  # must not raise


def test_launch_radogast_plan_analysis_raises_when_derive_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(plan_dir)
    monkeypatch.setattr(runner.subprocess, "run",
                         lambda cmd, **k: _FakeCompleted(returncode=1, stderr="boom"))
    with pytest.raises(runner.LaunchError, match="boom"):
        runner.launch_radogast_plan_analysis(plan_dir)


def test_launch_radogast_plan_analysis_raises_when_radogast_not_found(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(plan_dir)

    def fake_run(*a, **k):
        raise OSError("not found")

    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    with pytest.raises(runner.LaunchError):
        runner.launch_radogast_plan_analysis(plan_dir)


def test_read_radogast_target_defaults_when_missing(tmp_path):
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(plan_dir)
    assert runner.read_radogast_target(plan_dir) == {"goal": "", "key_terms": [], "out_of_scope": []}


def test_write_then_read_radogast_target_round_trips(tmp_path):
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(plan_dir)
    runner.write_radogast_target(plan_dir, "Build an AnimalAlert system",
                                 ["kotlin", "spring boot", "postgres"], ["dns", "tcp/ip"])
    assert runner.read_radogast_target(plan_dir) == {
        "goal": "Build an AnimalAlert system",
        "key_terms": ["kotlin", "spring boot", "postgres"],
        "out_of_scope": ["dns", "tcp/ip"],
    }


def test_write_radogast_target_preserves_unrelated_fields(tmp_path):
    # e.g. `verification`/`milestones` set by the CLI's own `plan init`
    # wizard, or by hand -- plan_analyzer.py never reads them (confirmed
    # against its own source), but they're still the user's data to keep.
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(os.path.join(plan_dir, ".radogast"))
    with open(os.path.join(plan_dir, ".radogast", "task.yaml"), "w", encoding="utf-8") as f:
        f.write("goal: old goal\nverification:\n- old\nkey_terms:\n- old_term\n")

    runner.write_radogast_target(plan_dir, "new goal", ["new_term"], [])

    raw = runner._read_radogast_yaml(plan_dir)
    assert raw["goal"] == "new goal"
    assert raw["key_terms"] == ["new_term"]
    assert raw["verification"] == ["old"]
    assert "out_of_scope" not in raw


def test_write_radogast_target_can_clear_key_terms_and_out_of_scope(tmp_path):
    plan_dir = str(tmp_path / "plan1")
    os.makedirs(plan_dir)
    runner.write_radogast_target(plan_dir, "goal", ["a", "b"], ["c"])
    runner.write_radogast_target(plan_dir, "goal", [], [])
    raw = runner._read_radogast_yaml(plan_dir)
    assert "key_terms" not in raw
    assert "out_of_scope" not in raw


def test_derive_radogast_target_parses_stdout_yaml(monkeypatch):
    yaml_out = "goal: Build an AnimalAlert system\nkey_terms:\n- kotlin\n- postgres\n"
    captured = {}
    monkeypatch.setattr(runner.subprocess, "run",
                         lambda cmd, **k: (captured.__setitem__("cmd", cmd), captured.__setitem__("kwargs", k),
                                            _FakeCompleted(stdout=yaml_out))[2])

    result = runner.derive_radogast_target("Build an AnimalAlert system")

    # task_text goes over stdin (`input=`), not as a CLI argument -- see
    # derive_radogast_target's own docstring for why (Windows's
    # CreateProcess argument-length ceiling).
    assert captured["cmd"] == ["radogast", "target", "derive", "--embed"]
    assert captured["kwargs"]["input"] == "Build an AnimalAlert system"
    assert "--output" not in captured["cmd"]  # stdout, not a file — this is a pure suggestion
    assert result == {"goal": "Build an AnimalAlert system", "key_terms": ["kotlin", "postgres"]}


def test_derive_radogast_target_passes_reference_text_as_a_cli_arg(monkeypatch):
    yaml_out = "goal: g\nkey_terms:\n- x\n"
    captured = {}
    monkeypatch.setattr(runner.subprocess, "run",
                         lambda cmd, **k: (captured.__setitem__("cmd", cmd), _FakeCompleted(stdout=yaml_out))[1])

    runner.derive_radogast_target("whole tree text", reference_text="short root task")

    assert captured["cmd"] == ["radogast", "target", "derive", "--embed", "--reference", "short root task"]


def test_derive_radogast_target_raises_on_failure(monkeypatch):
    monkeypatch.setattr(runner.subprocess, "run",
                         lambda cmd, **k: _FakeCompleted(returncode=1, stderr="boom"))
    with pytest.raises(runner.LaunchError, match="boom"):
        runner.derive_radogast_target("x")


def _mock_runtime(monkeypatch, host="http://localhost:11434", model="qwen2.5-coder:7b-instruct"):
    # Isolates a test from whatever the real developer machine's
    # ~/.1bcoder/config.yml actually contains — settings.resolve_runtime()
    # falls back to that real global file when nothing project-local is
    # set, which would otherwise make these tests silently depend on
    # local machine state (or the CI machine having none at all).
    monkeypatch.setattr(runner.settings_mod, "resolve_runtime",
                         lambda project_root: {"host": host, "model": model})
    monkeypatch.setattr(runner.settings_mod, "resolve_session",
                         lambda project_root: {"ctx": "", "params": {}})


def test_session_lines_carry_ctx_and_params():
    assert runner.session_lines({"ctx": 8192, "params": {"think": False, "temperature": "0.2", "timeout": 300}}) == \
        "/ctx 8192\n/param think false\n/param temperature 0.2\n/param timeout 300\n"
    assert runner.session_lines({"ctx": "", "params": {"bad key": 1, "x": "a\nb", "y": ""}}) == ""
    assert runner.session_lines(None) == ""


def test_launch_starts_the_script_with_the_settings(tmp_path, monkeypatch):
    # with --host/--model given 1bcoder's --scriptapply reads no config.yml: ctx, timeout,
    # think=false saved on the Settings tab reach a run only as lines of its script
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    _mock_runtime(monkeypatch)
    monkeypatch.setattr(runner.settings_mod, "resolve_session",
                        lambda project_root: {"ctx": "4096", "params": {"think": "false"}})
    captured = {}
    monkeypatch.setattr(runner.subprocess, "Popen",
                         lambda cmd, **k: (captured.__setitem__("cmd", cmd), _FakeProc(returncode=None))[1])
    runner.launch(str(tmp_path / "proj"), "glossary_index", {"source": "docs", "name": "d", "extra": ""})
    cmd = captured["cmd"]
    assert open(cmd[cmd.index("--scriptapply") + 1], encoding="utf-8").read() == \
        "/ctx 4096\n/param think false\n/flow glossary index docs --project d \n"


def test_launch_builds_correct_command_and_passes_host_and_model(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    _mock_runtime(monkeypatch, host="http://localhost:11434", model="qwen2.5-coder:7b-instruct")
    captured = {}

    def fake_popen(cmd, cwd, stdout, stderr, stdin, env=None):
        captured["cmd"] = cmd
        captured["cwd"] = cwd
        captured["env"] = env
        return _FakeProc(returncode=None)

    monkeypatch.setattr(runner.subprocess, "Popen", fake_popen)

    launch_id = runner.launch(str(tmp_path / "proj"), "plan_tree_md",
                              {"task": '"do the thing"', "maxdepth": 2, "extra": ""})

    assert captured["cwd"] == str(tmp_path / "proj")
    # forces UTF-8 on the child's stdout regardless of the system codepage —
    # confirmed directly this session that 1bcoder's own decorative Unicode
    # output crashes the whole launch under a non-UTF-8 codepage otherwise
    assert captured["env"]["PYTHONIOENCODING"] == "utf-8"
    cmd = captured["cmd"]
    assert cmd[0] == "1bcoder"
    script = cmd[cmd.index("--scriptapply") + 1]
    # the rendered per-launch copy, not the template: values are already in it
    assert script == os.path.join(str(tmp_path / "logs"), f"{launch_id}.script.txt")
    assert open(script, encoding="utf-8").read() == '/flow deepagent_tree_md "do the thing" --maxdepth 2 \n'
    assert "--param" not in cmd
    # --host/--model are passed explicitly now, resolved from settings —
    # see runner.launch()'s own docstring for why 1bcoder's own config
    # auto-loading can't be trusted to pick these up on its own.
    assert cmd[cmd.index("--host") + 1] == "http://localhost:11434"
    assert cmd[cmd.index("--model") + 1] == "qwen2.5-coder:7b-instruct"
    assert runner.status(launch_id) == "running"


def test_launch_puts_values_into_the_script_verbatim(tmp_path, monkeypatch):
    # A value with spaces, quotes and backslashes reaches the line as it is — a
    # newer 1bcoder shlex.quote()s --param itself, so the old double-quoting
    # turned "--terms-only --jev-model m --jev-host h" into ONE quoted argument.
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    _mock_runtime(monkeypatch)
    captured = {}
    monkeypatch.setattr(runner.subprocess, "Popen",
                         lambda cmd, **k: (captured.__setitem__("cmd", cmd), _FakeProc(returncode=None))[1])
    runner.launch(str(tmp_path / "proj"), "glossary_index",
                  {"source": r"C:\docs\concepts", "name": "concepts",
                   "extra": "--terms-only --jev-model tev:0.8b --jev-host panteon.local:11434"})
    cmd = captured["cmd"]
    line = open(cmd[cmd.index("--scriptapply") + 1], encoding="utf-8").read()
    assert line == (r"/flow glossary index C:\docs\concepts --project concepts "
                    "--terms-only --jev-model tev:0.8b --jev-host panteon.local:11434\n")


def test_launch_renders_the_users_edited_script(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    _mock_runtime(monkeypatch)
    proj = tmp_path / "proj"
    os.makedirs(runner.scripts_dir(str(proj)))
    with open(os.path.join(runner.scripts_dir(str(proj)), "alkonost_plan_md.txt"), "w", encoding="utf-8") as f:
        f.write("/flow deepagent_md {{task}} --maxdepth {{maxdepth}} --preset fast {{extra}}\n")
    captured = {}
    monkeypatch.setattr(runner.subprocess, "Popen",
                         lambda cmd, **k: (captured.__setitem__("cmd", cmd), _FakeProc(returncode=None))[1])
    runner.launch(str(proj), "plan_md", {"task": '"x"', "maxdepth": 1, "extra": ""})
    cmd = captured["cmd"]
    assert open(cmd[cmd.index("--scriptapply") + 1], encoding="utf-8").read() == \
        '/flow deepagent_md "x" --maxdepth 1 --preset fast \n'


def test_launch_omits_host_flag_when_host_not_configured(tmp_path, monkeypatch):
    # No safe universal default for --model (which model runs must never
    # be arbitrary), but --host has one (1bcoder's own localhost:11434
    # fallback) — so an unconfigured host is fine to just omit.
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    _mock_runtime(monkeypatch, host="", model="qwen2.5-coder:7b-instruct")
    captured = {}
    monkeypatch.setattr(runner.subprocess, "Popen",
                         lambda cmd, **k: (captured.__setitem__("cmd", cmd), _FakeProc(returncode=None))[1])

    runner.launch(str(tmp_path / "proj"), "plan_md", {"task": "x", "maxdepth": 1, "extra": ""})

    assert "--host" not in captured["cmd"]
    assert "--model" in captured["cmd"]


def test_launch_raises_launch_error_when_no_model_configured(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    _mock_runtime(monkeypatch, host="", model="")
    with pytest.raises(runner.LaunchError, match="No model configured"):
        runner.launch(str(tmp_path / "proj"), "plan_md", {"task": "x", "maxdepth": 1, "extra": ""})


def test_ensure_script_writes_axis_compose_as_a_plain_chat_line(tmp_path):
    # Deliberately NOT a `/flow ...` line and NOT built on 1bcoder's `-p`
    # mode — see runner.py's own comment on _TEMPLATES["axis_compose"] for
    # why: -p's model resolution can fall into an interactive picker that
    # silently defaults to an arbitrary model when none is pinned in
    # config.yml, confirmed live. A plain line through --scriptapply reuses
    # the same headless-safe (never-prompts) model resolution as every
    # other launch in this module.
    fname = runner.ensure_script(str(tmp_path), "axis_compose")
    path = os.path.join(str(tmp_path), ".1bcoder", "scripts", fname)
    content = open(path, encoding="utf-8").read()
    assert not content.lstrip().startswith("/")
    assert "{{task}}" in content and "{{axis}}" in content
    assert "fenced" in content  # asks the model to fence its answer
    # No literal ``` in the instruction itself — confirmed live that a
    # reasoning model will quote the instruction text back verbatim inside
    # its own "Thinking Process" prose, and a literal ``` in there gets
    # mistaken downstream for a real fence delimiter.
    assert "```" not in content
    # This is a META-prompt whose OWN output becomes the seed task for
    # deepagent_md/tree/tree_md, which re-invokes it once per `continue`
    # call to grow the tree one layer at a time — the composed prompt must
    # say so explicitly, or the executing model tries to write the whole
    # recursive tree in one response instead. Confirmed live (hand-fixing
    # a first attempt) that the right axis is implementation-unit
    # granularity, with the user's own axis input demoted to a coverage
    # constraint rather than the recursion axis itself.
    assert "one level" in content.lower()
    assert "implementation units" in content.lower()
    assert "## 1." in content
    # Must not literally contain a newline — 1bcoder's script format is
    # one step per physical line (chat.py's _load_script/_content_lines
    # just does f.readlines()/content[pc], no multi-line continuation), so
    # an embedded "\n" here would silently fragment this one message into
    # several separate chat turns instead of one coherent instruction.
    assert content.count("\n") == 1
    assert content.endswith("\n")


def test_quote_param_value_leaves_simple_values_alone():
    assert runner._quote_param_value("2") == "2"
    assert runner._quote_param_value("no-spaces-here") == "no-spaces-here"
    assert runner._quote_param_value('"already quoted"') == '"already quoted"'


def test_quote_param_value_wraps_multiword_values():
    # Confirmed directly this session: 1bcoder's own --scriptapply
    # reconstructs `--param key=value` pairs by rejoining and re-running
    # shlex.split() on them (chat.py main()'s param_tokens rebuild) — an
    # unquoted multi-word value silently tears apart on that second pass,
    # with everything after the first space dropped with no error anywhere.
    assert runner._quote_param_value("two words") == '"two words"'


def test_quote_param_value_escapes_embedded_double_quotes():
    # e.g. deepagent_spec's --focus, which only accepts a DOUBLE-quoted
    # value (no single-quote alternative in its own regex) — the embedded
    # quotes must survive being re-wrapped in an outer quoted string.
    v = runner._quote_param_value('--focus "be careful"')
    assert v == '"--focus \\"be careful\\""'


def test_quote_param_value_quotes_bare_windows_paths_with_no_spaces():
    # Real bug, hit live: a plain Windows path with backslashes but NO
    # whitespace (e.g. a plan_dir) used to sail through unquoted (the
    # earlier version of this function only checked for whitespace) and
    # had every backslash silently eaten by 1bcoder's own shlex.split —
    # POSIX shlex treats a bare backslash as an escape character even
    # OUTSIDE quotes, not just inside them. Confirmed from a real launch's
    # own log: "--path C:\Projects\AnimalAlert\.1bcoder\planMD\plan1"
    # arrived at simargl as "C:ProjectsAnimalAlert.1bcoderplanMDplan1".
    path = r"C:\Projects\AnimalAlert\.1bcoder\planMD\plan1"
    quoted = runner._quote_param_value(path)
    assert quoted == '"' + path.replace("\\", "\\\\") + '"'
    # and it must round-trip back through shlex exactly like 1bcoder's own
    # re-parse would, recovering the original path with real backslashes
    import shlex
    assert shlex.split(f"plan_dir={quoted}")[0] == f"plan_dir={path}"


def test_launch_raises_launch_error_when_1bcoder_not_found(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path / "logs"))
    _mock_runtime(monkeypatch)

    def fake_popen(*a, **k):
        raise OSError("not found")

    monkeypatch.setattr(runner.subprocess, "Popen", fake_popen)
    with pytest.raises(runner.LaunchError):
        runner.launch(str(tmp_path / "proj"), "plan_md", {"task": "x", "maxdepth": 1, "extra": ""})


def test_stop_returns_false_when_nothing_running():
    assert runner.stop("no-such-launch") is False
    runner._PROCESSES["already-done"] = _FakeProc(returncode=0)
    assert runner.stop("already-done") is False


def test_stop_kills_the_whole_process_tree_on_windows(monkeypatch):
    # Plain proc.terminate() is not enough here: 1bcoder's pip-installed
    # console-script .exe launcher may run the real work in a CHILD
    # python.exe, not the PID Popen itself returned — taskkill's /T flag
    # kills the whole descendant tree from that PID, not just it.
    monkeypatch.setattr(runner.os, "name", "nt")
    captured = {}

    def fake_run(cmd, capture_output=False):
        captured["cmd"] = cmd

    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    proc = _FakeProc(returncode=None, pid=9999)
    runner._PROCESSES["to-kill"] = proc

    assert runner.stop("to-kill") is True
    assert captured["cmd"] == ["taskkill", "/F", "/T", "/PID", "9999"]
    assert "to-kill" in runner._STOPPED


def test_status_reports_stopped_for_a_killed_launch():
    runner._PROCESSES["killed-one"] = _FakeProc(returncode=1)  # taskkill'd processes often report a nonzero exit
    runner._STOPPED.add("killed-one")
    assert runner.status("killed-one") == "stopped"


def test_status_variants(monkeypatch):
    assert runner.status("no-such-launch") == "unknown"
    runner._PROCESSES["running-one"] = _FakeProc(returncode=None)
    assert runner.status("running-one") == "running"
    runner._PROCESSES["done-one"] = _FakeProc(returncode=0)
    assert runner.status("done-one") == "done"
    runner._PROCESSES["failed-one"] = _FakeProc(returncode=1)
    assert runner.status("failed-one") == "failed"


def test_split_complete_lines_holds_back_a_trailing_partial_line():
    # Reproduces a real bug, confirmed live: a streamed LLM reply has no
    # newlines until the model happens to emit one, so if a 1-second poll
    # lands mid-sentence ("Okay, let's tackle this" | ". The user wants"),
    # naively splitting each poll's own chunk on its own would tear one
    # real line into two fake ones and corrupt fence-block detection
    # downstream (and just look wrong in the plain log too).
    lines, pending = runner.split_complete_lines("", "Okay, let's tackle this")
    assert lines == []
    assert pending == "Okay, let's tackle this"

    lines, pending = runner.split_complete_lines(pending, ". The user wants a prompt\nsecond line\nthird")
    assert lines == ["Okay, let's tackle this. The user wants a prompt", "second line"]
    assert pending == "third"


def test_split_complete_lines_flushes_cleanly_on_a_line_boundary():
    lines, pending = runner.split_complete_lines("", "one\ntwo\n")
    assert lines == ["one", "two"]
    assert pending == ""


def test_strip_ansi_removes_color_codes_but_keeps_text():
    # Confirmed live: 1bcoder colors a reasoning model's <think> tokens
    # dim-gray in a real terminal, but captured into a plain log file (no
    # TTY to interpret them) those raw escape codes show up as literal
    # garbage like "\x1b[90mOkay\x1b[0m" in the browser.
    raw = "\x1b[90mOkay\x1b[0m\x1b[90m,\x1b[0m the user wants"
    assert runner.strip_ansi(raw) == "Okay, the user wants"
    assert runner.strip_ansi("plain text, no codes") == "plain text, no codes"


def test_read_log_tail_bounds_and_missing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_LOG_DIR", str(tmp_path))
    assert runner.read_log_tail("missing") == []
    path = runner.log_path("present")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(f"line {i}" for i in range(150)) + "\n")
    tail = runner.read_log_tail("present", max_lines=100)
    assert len(tail) == 100
    assert tail[0] == "line 50"
    assert tail[-1] == "line 149"
