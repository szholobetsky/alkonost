"""spec.py — read-only parsing of deepagent_spec's spec_<leaf_id>.<sec_index>.md.

Exact format (deterministic, per deepagent_spec.py's _write_spec):

    # {PROJECT}-{leaf_id}.{sec_index}: {title}

    {free-form model-generated body}

    SOURCE: [src: item_{leaf_id}.md#{sec_index}]

spec/ is sparse relative to planMD/ — not every plan has a spec/<plan_name>/
counterpart, and not every leaf within a plan necessarily has specs yet.
"""
import os
import re

_TITLE_RE = re.compile(r'^# (?P<project>[A-Z0-9]+)-(?P<spec_id>[\d.]+): (?P<title>.+)$')
_SOURCE_RE = re.compile(r'^SOURCE: \[src: item_(?P<leaf_id>[\d.]+)\.md#(?P<sec_index>\d+)\]$')
_SPEC_FILENAME_RE_TMPL = r'^spec_{}\.(\d+)\.md$'


def find_spec_file(spec_dir: str, spec_id: str) -> str:
    """spec_id is "<leaf_id>.<sec_index>" — returns the file path, or ""
    if it doesn't exist / spec_dir doesn't exist."""
    path = os.path.join(spec_dir, f"spec_{spec_id}.md")
    return path if os.path.isfile(path) else ""


def spec_path(spec_dir: str, spec_id: str) -> str:
    """Same filename convention as find_spec_file, but doesn't require the
    file to already exist — used by the write path, which only ever edits
    a spec that was already successfully loaded (and therefore exists)."""
    return os.path.join(spec_dir, f"spec_{spec_id}.md")


def write_spec_raw(path: str, raw: str) -> None:
    """Writes the user-edited raw text verbatim. No validation of the
    title/SOURCE line format — alkonost trusts the human here the same way
    it trusts them editing tasks.md/colors.md; a malformed title just means
    parse_spec() (and this file's own cross-navigation) won't recognize it
    on the next load, same graceful "not found" handling as always."""
    with open(path, "w", encoding="utf-8") as f:
        f.write(raw)


def list_spec_files(spec_dir: str, leaf_id: str) -> list:
    """[(sec_index, path), ...] sorted by sec_index — empty if deepagent_spec
    hasn't been run on this leaf yet (not an error)."""
    if not os.path.isdir(spec_dir):
        return []
    pattern = re.compile(_SPEC_FILENAME_RE_TMPL.format(re.escape(leaf_id)))
    hits = []
    for fname in os.listdir(spec_dir):
        m = pattern.match(fname)
        if m:
            hits.append((int(m.group(1)), os.path.join(spec_dir, fname)))
    hits.sort(key=lambda x: x[0])
    return hits


def list_spec_ids(spec_dir: str) -> list:
    """Every spec_id ("<leaf_id>.<sec_index>") that has a spec file in this
    directory — used to answer "does this task row already have a spec"
    for the board/backlog UI's spec-link-vs-Add-spec-button decision.
    Empty if spec_dir doesn't exist (not an error, same sparse convention
    as list_spec_files)."""
    if not os.path.isdir(spec_dir):
        return []
    ids = []
    for fname in os.listdir(spec_dir):
        if fname.startswith("spec_") and fname.endswith(".md"):
            ids.append(fname[len("spec_"):-len(".md")])
    return sorted(ids)


def project_name(root_path: str) -> str:
    """Slugified project name for a new spec's title line — same
    derivation as deepagent_spec.py's own _project_name (basename,
    alnum-only, uppercased). Only needed when alkonost itself creates a
    new spec file (the Add Spec button); reading existing specs never
    needs this, the title line's project segment is already whatever
    deepagent_spec wrote."""
    name = re.sub(r'[^A-Za-z0-9]+', '', os.path.basename(root_path)).upper()
    return name or "PROJECT"


def create_spec_if_missing(spec_dir: str, task_id: str, title: str, project: str) -> str:
    """Creates spec_{task_id}.md with a starter template if it doesn't
    already exist — idempotent, re-clicking "Add spec" never overwrites
    real content. spec_id is the task_id itself, NOT task_id + ".1": every
    other spec lookup in this codebase (openSpecPanel/find_spec_file/
    hasSpec) resolves a task row's spec by its own id exactly, so a task
    "4.1" must get "spec_4.1.md", not "spec_4.1.1.md" — appending a
    section index here would create a file no lookup would ever find for
    that row again. Returns the file path either way."""
    os.makedirs(spec_dir, exist_ok=True)
    spec_id = task_id
    path = spec_path(spec_dir, spec_id)
    if not os.path.isfile(path):
        content = (
            f"# {project}-{spec_id}: {title}\n\n"
            f"<start writing the spec here>\n\n"
            f"SOURCE: [src: item_{task_id}.md#1]\n"
        )
        write_spec_raw(path, content)
    return path


def parse_spec(path: str) -> dict:
    """Returns {} if the file can't be read or the title line doesn't match
    the expected format."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except OSError:
        return {}

    lines = raw.splitlines()
    if not lines:
        return {}

    title_match = _TITLE_RE.match(lines[0])
    if not title_match:
        return {}

    source_leaf_id = None
    source_sec_index = None
    body_lines = lines[1:]
    last_content_idx = None
    for idx in range(len(body_lines) - 1, -1, -1):
        if body_lines[idx].strip():
            last_content_idx = idx
            break

    if last_content_idx is not None:
        source_match = _SOURCE_RE.match(body_lines[last_content_idx].strip())
        if source_match:
            source_leaf_id = source_match.group("leaf_id")
            source_sec_index = int(source_match.group("sec_index"))
            body_lines = body_lines[:last_content_idx]

    body = "\n".join(body_lines).strip()

    return {
        "project": title_match.group("project"),
        "spec_id": title_match.group("spec_id"),
        "title": title_match.group("title"),
        "body": body,
        "source_leaf_id": source_leaf_id,
        "source_sec_index": source_sec_index,
        "raw": raw,
    }
