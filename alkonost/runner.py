"""runner.py — launches 1bcoder flows headlessly via `--scriptapply`, the
same mechanism 1bcoder itself already uses for chained deepagent_*
pipelines (see e.g. C:\\Projects\\1bcoder\\_bcoder_data\\scripts\\deepagent_plan.txt).
Alkonost never re-implements generation logic — it only writes thin,
parameterized wrapper scripts and launches the real 1bcoder process
against them (concepts/ALKONOST_ADVANCE.md §3.2).

Always passes --host/--model explicitly, resolved from .1bcoder/config.yml
(project) / ~/.1bcoder/config.yml (global) via settings.resolve_runtime() —
the exact files settings.py's own Settings-tab routes edit, so that stays
the single source of truth for which model a launch uses, but 1bcoder is
told directly rather than left to resolve it itself. This used to be the
other way around (host/model deliberately omitted, relying on 1bcoder's
own startup config-loading) until it was confirmed live that 1bcoder's own
loader (`_load_startup_config()`) silently ignores a config file entirely
unless it also has `auto: true` set — a flag this project's Settings UI
never writes — so a model saved through Settings was never actually
picked up, and 1bcoder fell back to whatever Ollama happened to list
first (once, a reasoning model that produced pages of dim-gray <think>
tokens before ever answering anything).

No live IPC into the launched process. Its stdout/stderr is redirected to
a per-launch log file that a Flask SSE route tails to the browser
(one-way, server-reads-a-file — not the rejected background-listener-
inside-chat.py idea from ALKONOST_ADVANCE.md §3.2).
"""
import os
import re
import subprocess
import uuid

import yaml

from . import planmd
from . import settings as settings_mod

_LOG_DIR = os.path.join(os.path.expanduser("~"), ".alkonost", "logs")

# action -> (script filename, template content). The file is written once and
# never overwritten (the user may edit it); each launch renders the {{param}}
# placeholders itself into a per-launch copy (render_script) — no --param k=v.
_TEMPLATES = {
    "plan_md": ("alkonost_plan_md.txt",
                "/flow deepagent_md {{task}} --maxdepth {{maxdepth}} {{extra}}\n"),
    "plan_tree": ("alkonost_plan_tree.txt",
                  "/flow deepagent_tree {{task}} --maxdepth {{maxdepth}} {{extra}}\n"),
    "plan_tree_md": ("alkonost_plan_tree_md.txt",
                     "/flow deepagent_tree_md {{task}} --maxdepth {{maxdepth}} {{extra}}\n"),
    "plan_continue": ("alkonost_plan_continue.txt",
                      "/flow {{engine}} continue {{plan_dir}} plan: {{label}}\n"),
    "plan_redo": ("alkonost_plan_redo.txt",
                  "/flow {{engine}} redo {{plan_dir}} {{node_id}}\n"),
    # Distinct from `continue`: resume re-enters the plan's ORIGINAL
    # index-generate + expand loop toward its already-recorded maxdepth
    # (from _deepagent_meta.yaml), for a generation that was Stopped
    # partway through — `_expand`'s own "skip if file already exists"
    # check (at every depth, not just top-level) fills in exactly what's
    # missing and leaves everything already written untouched. `continue`
    # is a different operation (grows the tree past its current leaves
    # with a NEW layer) and is naturally re-runnable for the same purpose
    # with the same label text, since it recomputes "which nodes are
    # leaves" fresh on every call -- no separate resume action needed
    # there.
    "plan_resume": ("alkonost_plan_resume.txt",
                    "/flow {{engine}} resume {{plan_dir}}\n"),
    # 1bcoder already has a built-in "show me the docstring" command for
    # any flow (chat.py's _cmd_flow, `sub == "help"` branch — AST-parses
    # the flow .py file's own module docstring) — reused as-is rather than
    # Alkonost trying to independently rediscover where 1bcoder's flow
    # files live on disk.
    "flow_help": ("alkonost_flow_help.txt", "/flow help {{flow}}\n"),
    # `rag.py`'s own --path consumes the directory as the subprocess cwd
    # and does NOT forward it to simargl -- simargl's own `index files`
    # subcommand takes a separate, required POSITIONAL path of its own
    # (confirmed directly against simargl/ui/cli.py's argparse setup:
    # `idx_files.add_argument("path")`, no default), so "." (relative to
    # the cwd --path just set) is what actually gets indexed.
    "rag_index": ("alkonost_rag_index.txt",
                  "/flow rag index --path {{plan_dir}} files . --project {{rag_name}}\n"),
    # 1bcoder's /flow glossary: incremental on its own (_index.json), so the
    # same launch both starts a glossary and resumes a stopped one. {{source}}
    # is relative to the project root (the cwd); the glossary lands in
    # .1bcoder/glossary/{{name}}/. The Glossary tab's search index reuses
    # "rag_index" above with plan_dir = the glossary folder.
    "glossary_index": ("alkonost_glossary_index.txt",
                       "/flow glossary index {{source}} --project {{name}} {{extra}}\n"),
    # every other /flow glossary command (relink, html, contents, find, extract,
    # show, and the bare filter): {{cmd}} is checked against glossary.RUN_COMMANDS,
    # empty for the filter, whose tokens come straight after "glossary".
    "glossary_cmd": ("alkonost_glossary_cmd.txt",
                     "/flow glossary {{cmd}} {{args}} --project {{name}}\n"),
    "spec_generate": ("alkonost_spec.txt",
                      "/flow deepagent_spec {{plan}} {{extra}}\n"),
    "spec_redo": ("alkonost_spec_redo.txt",
                  "/flow deepagent_spec redo {{plan_dir}} {{unit_id}}\n"),
    # deepagent_task itself makes NO LLM calls -- a deterministic rollup of
    # the plan tree + spec units into a flat tasks.md, same "compiler, not
    # generator" principle as deepagent_task.py's own module docstring.
    # {{plan}} must be the BARE plan name, not plan_dir -- deepagent_task
    # uses this exact string verbatim as the row-id prefix
    # ("{plan_name}-{task_id}."), not just for path resolution, so passing
    # an absolute path here (like plan_redo/plan_continue do) would leak
    # the whole path into every task id.
    "task_generate": ("alkonost_task_generate.txt",
                      "/flow deepagent_task {{plan}}\n"),
    # A plain line with no leading "/" is just a normal chat message, not a
    # command -- 1bcoder sends it straight to the model and streams the
    # reply, exactly like every other --scriptapply step. Deliberately NOT
    # using 1bcoder's `-p`/--pipe one-shot mode for this: -p's model
    # resolution shares the *interactive* codepath (chat.py main(), the
    # `else` branch), which calls _pick_model() when no model is pinned in
    # config.yml and more than one is available on the Ollama host --
    # confirmed live: with stdin redirected to DEVNULL, `_input()`'s
    # `sys.stdin.readline()` returns "" instead of raising, so the picker
    # silently defaults to whatever Ollama lists first ("Pick [1]") with no
    # way to influence it, plus the "Available models: ..." banner itself
    # leaks into the log. --scriptapply's own model resolution is a
    # separate, headless-safe code path (main(), the `args.scriptapply`
    # branch) that never prompts -- it silently uses models[0] with just a
    # one-line `[model: ...]` announcement when nothing is configured.
    # No literal backtick fence in this instruction text itself — confirmed
    # live that a reasoning model will happily quote the instruction back
    # verbatim inside its own "Thinking Process" prose, and a literal ```
    # in there gets mistaken for a real fence delimiter downstream
    # (extractFence in app.js is anchored to whole-line fences precisely
    # because of this). "a single fenced markdown code block" describes
    # the same requirement without ever spelling out the character
    # sequence for the model to echo back.
    #
    # This is a META-prompt: its own output is not the axis-plan task
    # itself, it's a task PROMPT that gets pasted into the Task field and
    # then handed to deepagent_md/tree/tree_md, which re-invokes the same
    # prompt once per `continue` call to grow the tree one layer at a
    # time (concepts/ALKONOST_ADVANCE.md's whole reason `continue` exists
    # instead of one deep unattended run). The composing LLM has no idea
    # its OWN output will be reused that way unless the composed prompt
    # says so explicitly -- confirmed live, hand-correcting a first
    # attempt, that without an explicit "one level per call" instruction
    # the composed task told the EXECUTING model to try to write the
    # entire nested recursive tree in a single response, defeating the
    # whole layer-by-layer point. Also confirmed live: the right axis for
    # this kind of decomposition is implementation-unit granularity
    # (modules -> files -> classes -> methods), NOT the tech-stack layers
    # (frontend/backend/database) a user naturally types into the axis
    # field first -- those layers are real, but belong in a "make sure
    # every one of these is covered somewhere" constraint, not as the
    # recursion axis itself, or the executing model tries to recurse
    # layer-by-layer through frontend/backend/db instead of drilling into
    # actual code structure.
    "axis_compose": ("alkonost_axis_compose.txt",
                      'You are writing a task prompt for ANOTHER LLM that will be called once per '
                      'recursion level to expand a single section into its child sections at a time, '
                      'never attempting the whole tree in one response. Compose that task prompt for '
                      'this project requirement: "{{task}}". The task prompt you write must: '
                      '(1) instruct the executing LLM to decompose strictly along the IMPLEMENTATION '
                      'UNITS axis (modules, files, classes, methods), not by feature or user story; '
                      '(2) require that these architectural layers/areas are all accounted for '
                      'somewhere in the decomposition: {{axis}}; '
                      '(3) explicitly state that only ONE level of decomposition is produced per call, '
                      'and the executing LLM must never attempt multiple levels or the whole recursive '
                      'tree in a single response; '
                      '(4) require the output to be formatted as top-level numbered sections, one per '
                      'sibling item at that level, using the exact heading style "## 1.", "## 2.", '
                      '"## 3." and so on; '
                      '(5) contain only the instructions for the executing LLM, with no meta-commentary '
                      'explaining your own reasoning, your own approach, or how the recursive process '
                      'works. Output only the composed task prompt itself, wrapped in a single fenced '
                      'markdown code block, and nothing else.\n'),
}

_ENGINE_SIDECAR = "_alkonost_engine.txt"

FLOW_BY_KEY = {"md": "deepagent_md", "tree": "deepagent_tree", "tree_md": "deepagent_tree_md"}


def scripts_dir(project_root: str) -> str:
    return os.path.join(project_root, ".1bcoder", "scripts")


def ensure_script(project_root: str, action: str) -> str:
    """Writes the template for `action` if missing — same "create with
    generic defaults, then never touch it again" convention deepagent_task
    already uses for colors.md. Returns the script's bare filename (not a
    full path — 1bcoder's --scriptapply resolves it relative to
    .1bcoder/scripts/ itself, given cwd=project_root)."""
    fname, content = _TEMPLATES[action]
    d = scripts_dir(project_root)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, fname)
    if not os.path.isfile(path):
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    return fname


def engine_sidecar_path(plan_dir: str) -> str:
    return os.path.join(plan_dir, _ENGINE_SIDECAR)


def write_engine(plan_dir: str, engine: str) -> None:
    os.makedirs(plan_dir, exist_ok=True)
    with open(engine_sidecar_path(plan_dir), "w", encoding="utf-8") as f:
        f.write(engine.strip() + "\n")


def read_engine(plan_dir: str) -> str:
    path = engine_sidecar_path(plan_dir)
    if not os.path.isfile(path):
        return ""
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


_META_FILENAME = "_deepagent_meta.yaml"


def _tree_max_depth(plan_dir: str) -> int:
    """Deepest node_id currently on disk, by dot-count -- matches
    deepagent_md/tree/tree_md's own `node_id.count(".") + 1` depth
    convention exactly, so this lines up with whatever depth their own
    `continue`/`resume` logic would compute for the same tree."""
    max_depth = 0
    try:
        for name in os.listdir(plan_dir):
            m = re.match(r"item_([\d.]+)\.md$", name)
            if m:
                max_depth = max(max_depth, m.group(1).count(".") + 1)
    except OSError:
        pass
    return max_depth


def bump_meta_maxdepth(plan_dir: str) -> None:
    """Before calling `resume` on a plan whose tree was grown deeper by a
    `continue` call that then got hard-killed (see stop()'s own docstring:
    taskkill /F gives 1bcoder's own process no chance to run the graceful
    _StopGeneration cleanup that would otherwise persist continue's new,
    deeper maxdepth back into _deepagent_meta.yaml), plain `resume` reads
    the STALE, shallower maxdepth still on disk, sees the tree as already
    "complete" at that depth, and fills in nothing.

    Patches ONLY the one `maxdepth: N` line in place via plain text search
    -- deliberately not a full yaml.safe_load/safe_dump round trip, even
    though Alkonost has a real PyYAML dependency now (added later, for
    .radogast/task.yaml). This file's `task:`/`cfg:` fields use real,
    sometimes multi-line YAML block-scalar quoting, and re-serializing the
    WHOLE structure just to touch one already-known-format line still
    carries needless risk of reformatting or reordering something a
    human, or 1bcoder itself, expects to stay untouched -- a plain
    string-replace of that one line carries none of that risk. Raises the
    stored value up to whatever depth already exists somewhere in the
    tree, never lowers it, so a subsequent `resume` walks the WHOLE tree
    to that depth and fills in exactly what's missing without re-touching
    branches that already reached it."""
    path = os.path.join(plan_dir, _META_FILENAME)
    if not os.path.isfile(path):
        return
    target = _tree_max_depth(plan_dir)
    if target <= 0:
        return
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return
    m = re.search(r"^maxdepth:\s*(\d+)\s*$", text, re.MULTILINE)
    if not m or int(m.group(1)) >= target:
        return
    text = text[:m.start(1)] + str(target) + text[m.end(1):]
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    except OSError:
        pass


def read_plan_meta(plan_dir: str) -> dict:
    """Reads _deepagent_meta.yaml -- the original task/maxdepth/cfg this
    plan was generated with. Used by "Create new plan based on this" to
    prefill the Init tab's generation form from an existing plan, e.g. to
    re-run the same task through a different (larger/more technical)
    model than whatever generated the original plan."""
    path = os.path.join(plan_dir, _META_FILENAME)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
        return {}


def _radogast_target_path(plan_dir: str) -> str:
    return os.path.join(plan_dir, ".radogast", "task.yaml")


def _read_radogast_yaml(plan_dir: str) -> dict:
    path = _radogast_target_path(plan_dir)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
        return {}


def read_radogast_target(plan_dir: str) -> dict:
    """{"goal", "key_terms", "out_of_scope"} — the only Target fields
    plan_analyzer.analyze_plan() actually reads (confirmed against
    radogast's own plan_analyzer.py: milestones/marker_words/verification
    exist on the shared Target dataclass for the conversation-drift
    analyzer, `analyze()`, and are simply never looked at by
    `analyze_plan()`), so those are the only ones exposed for editing."""
    data = _read_radogast_yaml(plan_dir)
    return {
        "goal": data.get("goal", ""),
        "key_terms": list(data.get("key_terms") or []),
        "out_of_scope": list(data.get("out_of_scope") or []),
    }


def write_radogast_target(plan_dir: str, goal: str, key_terms: list, out_of_scope: list) -> None:
    """Merge-write: goal/key_terms/out_of_scope come from this call, any
    OTHER top-level key already on disk (verification/milestones/
    marker_words -- set by hand, or by the CLI's own `plan init` wizard)
    passes through untouched, same merge-preserving convention as
    settings.write_settings() for .1bcoder/config.yml. Uses real PyYAML
    (unlike bump_meta_maxdepth's deliberate plain-text line patch on
    _deepagent_meta.yaml) because this file's shape is simple and flat
    (radogast's own target_to_yaml() writes it the same way) and the
    whole point here is letting the user freely add/remove list entries,
    not touch one already-known-format line."""
    path = _radogast_target_path(plan_dir)
    data = _read_radogast_yaml(plan_dir)
    data["goal"] = goal
    if key_terms:
        data["key_terms"] = key_terms
    else:
        data.pop("key_terms", None)
    if out_of_scope:
        data["out_of_scope"] = out_of_scope
    else:
        data.pop("out_of_scope", None)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        yaml.dump(data, f, allow_unicode=True, sort_keys=False)


def extract_core_task_text(text: str) -> str:
    """If `text` is one of Alkonost's own axis_compose-style meta-prompts
    (the real project description wrapped in double quotes inside a much
    larger "You are writing a task prompt for ANOTHER LLM..." instruction
    -- see _TEMPLATES["axis_compose"]), pull out just the quoted task
    instead of handing the whole meta-prompt to radogast's own
    derive_target() heuristic.

    Confirmed live this matters, not just theoretically: derive_target()
    picks its key_terms as the first ~12 unique non-stopword words in RAW
    document order. When the text is a composed meta-prompt, every one of
    those slots fills up with generic instructional vocabulary ("writing",
    "recursion", "expand", "instruct", "executing"...) before the scan
    ever reaches the real task's own words, because the meta-instructions
    physically come first in the string -- key_terms ends up with zero
    words actually about the project.

    Picks the LONGEST double-quoted substring (the real task is always
    far longer than the other quoted things a meta-prompt contains, e.g.
    axis_compose's own "## 1.", "## 2." heading-style examples) and only
    uses it if it clears a length floor, so a plain task with no quotes
    at all -- or a short one that happens to contain a quoted word --
    passes through completely untouched.

    Second, quote-free fallback: axis_compose's own COMPOSED OUTPUT (what
    the LLM actually writes back, as opposed to the meta-prompt sent TO
    it) restates the task in plain prose with no quotes at all -- "You are
    an expert software architect ... decompose the project requirement:
    Create an AnimalAlert system. [...]" -- and that composed text is
    exactly what an axis-plan's own index.md ends up containing once it's
    used as the seed task for generation. Confirmed live this is a real,
    not theoretical, gap: the quote-based branch above does nothing for
    this shape (no quotes anywhere), so the full instructional preamble
    was still going into radogast's embedding centroid untouched, ranking
    words like "Alert"/"Confirmation"/"Schema" against a centroid still
    dominated by "expert/architect/decomposition/specialist" framing
    rather than the AnimalAlert domain. Cuts everything up to and
    including the first "requirement:"/"task:" (optionally
    "project "-prefixed) found within the first ~300 characters, keeping
    everything after -- including the composed prompt's own trailing
    constraint checklist (e.g. "Architecture must be split between
    Frontend (Kotlin/Android)..."), which is itself useful reference
    content, not noise to also strip."""
    quotes = re.findall(r'"([^"]*)"', text)
    if quotes:
        longest = max(quotes, key=len)
        if len(longest) > 40:
            return longest
    m = re.search(r'\b(?:project\s+)?(?:requirement|task)\s*:\s*', text, re.IGNORECASE)
    if m and m.start() < 300:
        rest = text[m.end():].strip()
        if len(rest) > 40:
            return rest
    return text


def derive_radogast_target(task_text: str, reference_text: str = None) -> dict:
    """Runs `radogast target derive --embed [--reference ...]` with no
    --output, so it prints the YAML to stdout instead of writing a file,
    and parses just goal/key_terms back out. A pure suggestion for the UI
    to prefill — never touches disk itself; the user reviews/edits before
    write_radogast_target() actually saves anything. Same no-LLM heuristic
    `plan init`'s own wizard and launch_radogast_plan_analysis's
    auto-create fallback both already rely on. Callers should run
    extract_core_task_text() over the raw task text first — see its own
    docstring for why.

    `task_text` goes over stdin, never as a CLI argument -- confirmed
    live that a "full plan tree" text (tens of KB, from planmd.full_text)
    blows straight through Windows's CreateProcess argument-length ceiling
    ("The filename or extension is too long"), something a positional
    argument can silently never support at that size. `reference_text`
    (short -- the project's own root task, e.g. index.md alone) IS passed
    as a normal CLI argument, on purpose: confirmed live that ranking key
    terms against a whole plan tree's OWN centroid surfaces generic
    architecture vocabulary ("protocols", "concurrency", "scalability")
    instead of domain-specific ones, since that's simply what most of a
    deep technical tree discusses at every level -- see
    derive_target_embedded's own docstring for the full reasoning."""
    cmd = ["radogast", "target", "derive", "--embed"]
    if reference_text:
        cmd += ["--reference", reference_text]
    try:
        result = subprocess.run(
            cmd, input=task_text, capture_output=True, text=True, timeout=60,
        )
    except OSError as e:
        raise LaunchError(
            f"could not start 'radogast' ({e}) — is it installed and on PATH "
            f"in the environment running Alkonost?"
        ) from e
    if result.returncode != 0:
        raise LaunchError(f"radogast target derive failed: {(result.stderr or result.stdout).strip()[:300]}")
    try:
        data = yaml.safe_load(result.stdout) or {}
    except yaml.YAMLError as e:
        raise LaunchError(f"radogast target derive produced invalid YAML: {e}") from e
    return {"goal": data.get("goal", ""), "key_terms": list(data.get("key_terms") or [])}


def launch_radogast_plan_analysis(plan_dir: str, threshold: float = 0.85, show_all: bool = False) -> str:
    """Runs `radogast plan analyze <plan_dir> --threshold N [--all]` --
    redundancy/duplicate clusters, out-of-scope drift, and key-term
    coverage across the tree. Not a 1bcoder launch: radogast is its own
    installed CLI tool, makes no LLM/chat calls at all (embeddings +
    term-matching, deterministic), and has no --host/--model of its own to
    pass. Reuses the same log-file/Popen plumbing as every 1bcoder launch
    (_launch_cmd) purely because that machinery (SSE streaming, Stop
    button, ANSI stripping) is generic, not because this is secretly a
    1bcoder call.

    `plan analyze` requires <plan_dir>/.radogast/task.yaml to already
    exist. The Radogast page's own "Analyze" button always calls
    write_radogast_target() first, so normally this is already there --
    the auto-derive-and-write fallback below is only a safety net (e.g.
    the page was skipped, or a save silently failed), not the primary
    path anymore."""
    target_path = _radogast_target_path(plan_dir)
    if not os.path.isfile(target_path):
        # The WHOLE plan (index.md + every item_<id>.md), not just
        # index.md's one-line root task -- see planmd.full_text's own
        # docstring for why (a term only mentioned deep in one leaf is
        # exactly as real a project term as anything in the overview).
        # NOT run through extract_core_task_text() -- confirmed live that
        # its quote-picking heuristic can seize on an unrelated, merely
        # coincidentally-long quoted phrase buried in one leaf's own
        # prose out of a whole tree's worth of text, discarding 99.98% of
        # the real candidate pool. That heuristic is for a single
        # index.md-scoped text (below), never the full aggregated one.
        task_text = planmd.full_text(plan_dir) or os.path.basename(plan_dir)
        # ...but ranked against index.md's OWN (much shorter) content, not
        # the whole tree's centroid -- see derive_radogast_target's own
        # docstring for why a deep tree's centroid skews toward generic
        # architecture vocabulary instead of the project's actual domain.
        index_path = os.path.join(plan_dir, "index.md")
        reference_text = None
        if os.path.isfile(index_path):
            try:
                with open(index_path, encoding="utf-8") as f:
                    reference_text = extract_core_task_text(f.read()) or None
            except OSError:
                pass
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        cmd = ["radogast", "target", "derive", "--embed", "--output", target_path]
        if reference_text:
            cmd += ["--reference", reference_text]
        try:
            result = subprocess.run(
                cmd, input=task_text, capture_output=True, text=True, timeout=60,
            )
        except OSError as e:
            raise LaunchError(
                f"could not start 'radogast' ({e}) — is it installed and on PATH "
                f"in the environment running Alkonost?"
            ) from e
        if result.returncode != 0:
            raise LaunchError(f"radogast target derive failed: {(result.stderr or result.stdout).strip()[:300]}")
    cmd = ["radogast", "plan", "analyze", plan_dir, "--threshold", str(threshold)]
    if show_all:
        cmd.append("--all")
    return _launch_cmd(plan_dir, cmd)


def launch_radogast_help(project_root: str) -> str:
    """`radogast plan analyze --help` — radogast has its own native
    --help, unlike 1bcoder's flows which need the `/flow help <name>`
    AST-parse trick; no equivalent indirection needed here."""
    return _launch_cmd(project_root, ["radogast", "plan", "analyze", "--help"])


def list_rag_projects(plan_dir: str) -> list:
    """Indexed simargl project ids for this plan — literally the
    subdirectories of <plan_dir>/.simargl/, since that's exactly where
    `/flow rag index --path <plan_dir> --project <name>` writes its store
    (simargl's own STORE_DIR default is the plain ".simargl" relative to
    whatever cwd rag.py's --path put it in, per simargl/config.py). No
    registry file to parse — this reads the actual on-disk stores."""
    simargl_dir = os.path.join(plan_dir, ".simargl")
    if not os.path.isdir(simargl_dir):
        return []
    return sorted(
        name for name in os.listdir(simargl_dir)
        if os.path.isdir(os.path.join(simargl_dir, name)) and not name.startswith(".")
    )


def new_launch_id() -> str:
    return uuid.uuid4().hex[:12]


def log_path(launch_id: str) -> str:
    os.makedirs(_LOG_DIR, exist_ok=True)
    return os.path.join(_LOG_DIR, f"{launch_id}.log")


# launch_id -> subprocess.Popen. In-process only for this MVP — does not
# survive an Alkonost server restart (a launch started before a restart
# will still finish and its log file remains readable, but `status()`
# reports "unknown" for it afterward rather than "running"/"done"/"failed").
_PROCESSES = {}


class LaunchError(Exception):
    pass


_UNSAFE_UNQUOTED = set(" \t\n\r\\'\"")


def _quote_param_value(v) -> str:
    """1bcoder's own `--scriptapply` reconstructs `--param key=value` pairs
    by naively rejoining them into one string and re-parsing it with
    shlex.split() (chat.py main()'s `param_tokens = " ".join(f"{k}={v}" ...)`
    fed into `_cmd_script("/script apply -y ... " + param_tokens)`). A value
    survives that second shlex pass unmangled only if any shlex-special
    character in it is protected by quoting. Two failure modes confirmed
    directly, not just reasoned about: (1) unquoted whitespace tears the
    value into multiple bogus tokens, remainder silently dropped; (2) POSIX
    shlex treats a bare backslash as an escape character even OUTSIDE
    quotes -- an earlier version of this function only quoted on
    whitespace, so a plain Windows path with no spaces at all (e.g.
    `C:\\Projects\\AnimalAlert\\.1bcoder\\planMD\\plan1`) sailed through
    unquoted and had every single backslash silently stripped
    (`C:ProjectsAnimalAlert.1bcoderplanMDplan1`), corrupting the path with
    no error anywhere in the chain. Centralized here so no call site has to
    remember either quirk. Uses double quotes; a value that itself needs
    literal double quotes (e.g. --rag-store '<path>') should use single
    quotes internally to avoid collision -- single quotes are ordinary,
    non-special characters once already inside a double-quoted token.

    No longer used by launch(): it renders the values into the script itself
    (render_script), since a newer 1bcoder quotes --param on its own and this
    quoting then reached the command line. Kept for a caller that still passes
    --param to an older 1bcoder."""
    v = str(v)
    if not v or not any(c in _UNSAFE_UNQUOTED for c in v):
        return v
    if len(v) >= 2 and v[0] == v[-1] == '"':
        return v  # caller already quoted it
    # POSIX-style backslash-escaping (what shlex.split expects inside a
    # double-quoted token) turns an embedded `"` back into a literal quote
    # character once 1bcoder's own re-parse unwraps our outer quotes —
    # needed for flags like deepagent_spec's --focus, which only accepts a
    # DOUBLE-quoted value (its own regex has no single-quote alternative,
    # unlike e.g. --rag-store).
    escaped = v.replace('\\', '\\\\').replace('"', '\\"')
    return f'"{escaped}"'


def session_lines(session: dict) -> str:
    """`/ctx N` and `/param key value` lines for the Settings a launch must carry
    (settings.resolve_session) — 1bcoder reads no config.yml under --scriptapply
    with --host/--model given, so these go first in the script. A key that is not
    one word, or a value with a line break, is skipped: it would break the line."""
    lines = []
    ctx = str((session or {}).get("ctx") or "").strip()
    if ctx.isdigit():
        lines.append(f"/ctx {ctx}\n")
    for k, v in ((session or {}).get("params") or {}).items():
        v = ("true" if v else "false") if isinstance(v, bool) else str(v).strip()
        if re.fullmatch(r"[A-Za-z0-9_.\-]+", str(k)) and v and "\n" not in v and "\r" not in v:
            lines.append(f"/param {k} {v}\n")
    return "".join(lines)


def render_script(project_root: str, action: str, params: dict, launch_id: str,
                  session: dict = None) -> str:
    """The project's script for `action` (the user may have edited it) with every
    {{key}} replaced by its value VERBATIM, written to ~/.alkonost/logs/<id>.script.txt;
    returns that absolute path. alkonost substitutes the values itself instead of
    passing `--param k=v`: how 1bcoder re-parses --param changed (an older one
    re-split the joined pairs with shlex, so values had to be quoted — see
    _quote_param_value; a newer one shlex.quote()s each pair itself), and a quoted
    value then reached the command with its quotes —
    `"--terms-only --jev-model tev:0.8b --jev-host h:11434"` became one bogus
    argument. A rendered script reads the same under every 1bcoder: what a caller
    passes is exactly what appears in the line."""
    fname = ensure_script(project_root, action)
    with open(os.path.join(scripts_dir(project_root), fname), encoding="utf-8-sig") as f:
        text = f.read()
    for k, v in params.items():
        text = text.replace("{{" + k + "}}", "" if v is None else str(v))
    text = session_lines(session) + text
    os.makedirs(_LOG_DIR, exist_ok=True)
    path = os.path.join(_LOG_DIR, f"{launch_id}.script.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def _launch_cmd(project_root: str, cmd: list, launch_id: str = None) -> str:
    """Shared launch plumbing: fresh launch_id, per-launch log file, UTF-8 +
    unbuffered child stdout (see launch()'s own docstring for why both are
    load-bearing), Popen with stdout/stderr redirected to that file. Used
    by both launch() (--scriptapply) and launch_pipe() (-p) — they only
    differ in how `cmd` itself is built."""
    launch_id = launch_id or new_launch_id()
    log_file = log_path(launch_id)

    # Force UTF-8 on the child's own stdout — a Python subprocess whose
    # stdout is redirected to a file/pipe picks the system codepage
    # (confirmed directly: cp1251 on this machine) unless told otherwise,
    # and 1bcoder prints Unicode box-drawing/decorative characters that
    # crash with UnicodeEncodeError under any non-UTF-8 codepage, killing
    # the whole launch with no useful error surfaced anywhere upstream.
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    # A Python process block-buffers stdout when it isn't a real terminal
    # (writing to our log file counts) — without this, nothing shows up in
    # the log until the whole launch finishes and the buffer flushes on
    # exit, which looks indistinguishable from "the button did nothing."
    env["PYTHONUNBUFFERED"] = "1"

    with open(log_file, "w", encoding="utf-8") as lf:
        lf.write(f"$ {' '.join(cmd)}\n")
        lf.flush()
        try:
            proc = subprocess.Popen(
                cmd, cwd=project_root, stdout=lf, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, env=env,
            )
        except OSError as e:
            raise LaunchError(
                f"could not start '1bcoder' ({e}) — is it installed and on PATH "
                f"in the environment running Alkonost?"
            ) from e
    _PROCESSES[launch_id] = proc
    return launch_id


def launch(project_root: str, action: str, params: dict) -> str:
    """Ensures the wrapper script exists, launches
    `1bcoder --scriptapply <rendered script> --host <h> --model <m>`
    with cwd=project_root and stdout/stderr redirected to a fresh per-launch
    log file. The params are already substituted into the script, verbatim
    (render_script).
    Returns the launch_id.

    --host/--model come from settings.resolve_runtime() (see module
    docstring for why they're passed explicitly rather than left for
    1bcoder to resolve itself). --host is omitted if unconfigured
    anywhere — 1bcoder already falls back to a sane default
    (http://localhost:11434) with no ambiguity. --model has no such safe
    default (which model to run is exactly the thing that must not be
    left arbitrary), so an unconfigured model raises LaunchError instead
    of silently launching."""
    runtime = settings_mod.resolve_runtime(project_root)
    if not runtime["model"]:
        raise LaunchError(
            "No model configured — set one on the Settings tab "
            "(.1bcoder/config.yml for this project, or ~/.1bcoder/config.yml "
            "globally) before launching."
        )
    launch_id = new_launch_id()
    script = render_script(project_root, action, params, launch_id,   # values already in, no --param
                           session=settings_mod.resolve_session(project_root))
    cmd = ["1bcoder", "--scriptapply", script]
    if runtime["host"]:
        cmd += ["--host", runtime["host"]]
    cmd += ["--model", runtime["model"]]
    return _launch_cmd(project_root, cmd, launch_id)


_STOPPED = set()  # launch_ids the user explicitly killed — see status()


def stop(launch_id: str) -> bool:
    """Immediately kill a running launch, "Ralph" leash of last resort.
    Returns True if a running process was found and a kill was issued,
    False if there was nothing running under this launch_id.

    Plain proc.terminate() is not enough on Windows: the `1bcoder` command
    found on PATH is a pip-generated console-script .exe launcher, which
    may run the actual work in a CHILD python.exe process rather than
    inside the PID subprocess.Popen itself returned -- terminating just
    that top PID can leave the real worker orphaned and still running,
    still holding the model/GPU, still writing to the log file. `taskkill
    /T` kills the entire descendant tree from that PID, not just it, which
    covers this regardless of how the launcher chose to spawn things."""
    proc = _PROCESSES.get(launch_id)
    if proc is None or proc.poll() is not None:
        return False
    _STOPPED.add(launch_id)
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                       capture_output=True)
    else:
        try:
            proc.terminate()
        except OSError:
            pass
    return True


def status(launch_id: str) -> str:
    proc = _PROCESSES.get(launch_id)
    if proc is None:
        return "unknown"
    code = proc.poll()
    if code is None:
        return "running"
    if launch_id in _STOPPED:
        return "stopped"
    return "done" if code == 0 else "failed"


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")


def split_complete_lines(pending: str, chunk: str):
    """Given text already buffered from a previous poll (`pending` — no
    trailing newline yet) and a newly-read `chunk`, returns
    (complete_lines, new_pending). Used by the log-tailing SSE route to
    avoid tearing one real line into several fake ones: a streamed LLM
    reply has no newlines at all until the model happens to emit one, so
    treating "whatever's new since the last 1-second poll" as a complete
    set of lines (a plain chunk.splitlines()) breaks mid-sentence wherever
    a poll boundary landed — confirmed live, it corrupted fence-block
    detection on the client and made the plain log itself wrap oddly
    mid-word. Only truly newline-terminated text is ever returned as a
    complete line; the trailing partial line is carried forward."""
    combined = pending + chunk
    parts = combined.split("\n")
    return parts[:-1], parts[-1]


def strip_ansi(text: str) -> str:
    """1bcoder colors its own terminal output (e.g. dim-gray <think> tokens
    from a reasoning model in -p/pipe mode) using raw ANSI escape codes,
    which look fine in a real terminal but show up as literal garbage like
    `\\x1b[90m` once captured into a plain log file with no TTY to
    interpret them. Stripped once here rather than in every consumer."""
    return _ANSI_RE.sub("", text)


def read_log_tail(launch_id: str, max_lines: int = 100) -> list:
    path = log_path(launch_id)
    if not os.path.isfile(path):
        return []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []
    return [strip_ansi(line.rstrip("\n")) for line in lines[-max_lines:]]
