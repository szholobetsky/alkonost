"""glossary.py — reads the glossaries 1bcoder's `/flow glossary` writes into
<project>/.1bcoder/glossary/<name>/: glossary.md (one kebab-case term per
line), one <term>.md article per term, _index.json (the files read in full).

No import dependency on 1bcoder — the article format is re-implemented here,
the same way planmd.py/spec.py re-implement deepagent_md/spec's formats.
Article sections, in order: DEFINITION:, FACTS:, LINK:, SYNONYM:, KIND:
(what the decision model took the term for, per chunk: "domain 0.90 [file:
a.md:12]"), SEEN: (every chunk the term was found in — its support),
HISTORY:. A section may be missing (KIND:/SEEN: are written only when
non-empty; older articles have neither).

Search over the articles is simargl's (`simargl search --mode file`) over a
store kept inside the glossary folder itself: <glossary>/.simargl/ (a dot
folder, so simargl never indexes its own store). The index is built through
1bcoder's `/flow rag index` (runner.py, the same template the Axis tab
uses); the search below calls simargl directly — an embedding lookup, no LLM.
"""
import json
import os
import re
import subprocess

_DOT1BCODER = ".1bcoder"
RAG_PROJECT = "glossary"
_SECTIONS = ("DEFINITION", "FACTS", "LINK", "SYNONYM", "KIND", "SEEN", "HISTORY")
_SECTION_RE = re.compile(r"^(%s):\s*$" % "|".join(_SECTIONS))
_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]*$")
_SOURCE_TAG = re.compile(r"\s*\[file:[^\]]*\]\s*$")
KINDS = ("domain", "technology", "noise")


class GlossaryError(Exception):
    pass


def safe_name(name: str) -> bool:
    """A glossary or term name that cannot leave its folder (no separators, no '..')."""
    return bool(name) and bool(_SAFE_NAME.match(name)) and ".." not in name


def glossary_root(project_root: str) -> str:
    return os.path.join(project_root, _DOT1BCODER, "glossary")


def glossary_dir(project_root: str, name: str) -> str:
    if not safe_name(name):
        raise GlossaryError(f"bad glossary name: {name!r}")
    return os.path.join(glossary_root(project_root), name)


def load_terms(gdir: str) -> list:
    path = os.path.join(gdir, "glossary.md")
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8", errors="replace") as f:
        return [l.strip() for l in f if l.strip()]


def files_read(gdir: str) -> int:
    try:
        with open(os.path.join(gdir, "_index.json"), encoding="utf-8") as f:
            return len(json.load(f).get("files") or {})
    except (OSError, ValueError, AttributeError):
        return 0


def rag_indexed(gdir: str) -> bool:
    return os.path.isdir(os.path.join(gdir, ".simargl", RAG_PROJECT))


def strip_source(entry: str) -> str:
    return _SOURCE_TAG.sub("", entry or "").strip()


def parse_article(text: str) -> dict:
    """The sections of one <term>.md as lists of bullet texts (LINK:/SYNONYM: as term names).
    DEFINITION: in the old single-paragraph format becomes one entry."""
    out = {k.lower(): [] for k in _SECTIONS}
    current, para = None, []
    for line in text.splitlines():
        m = _SECTION_RE.match(line.strip())
        if m:
            if current == "definition" and para:
                out["definition"].append(" ".join(para))
            current, para = m.group(1).lower(), []
            continue
        if current is None or not line.strip():
            continue
        s = line.strip()
        if s[:2] in ("- ", "* "):
            item = s[2:].strip()
            if current in ("link", "synonym"):
                lm = _LINK_RE.match(item)
                item = lm.group(1) if lm else item
            out[current].append(item)
        elif current == "definition":
            para.append(s)                             # legacy plain paragraph
    if current == "definition" and para:
        out["definition"].append(" ".join(para))
    return out


def term_kind(kind_entries: list):
    """The kind most KIND: votes say (ties: the higher summed probability); None if unjudged."""
    votes, mass = {}, {}
    for e in kind_entries:
        parts = strip_source(e).split()
        if not parts:
            continue
        k = parts[0]
        votes[k] = votes.get(k, 0) + 1
        try:
            mass[k] = mass.get(k, 0.0) + float(parts[1])
        except (IndexError, ValueError):
            pass
    if not votes:
        return None
    return max(votes, key=lambda k: (votes[k], mass.get(k, 0.0)))


def read_article(gdir: str, term: str):
    if not safe_name(term):
        raise GlossaryError(f"bad term: {term!r}")
    path = os.path.join(gdir, term + ".md")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8", errors="replace") as f:
        return parse_article(f.read())


def list_glossaries(project_root: str) -> list:
    """[{"name", "terms", "files_read", "indexed"}] — every folder under .1bcoder/glossary/ with a glossary.md."""
    root = glossary_root(project_root)
    if not os.path.isdir(root):
        return []
    out = []
    for name in sorted(os.listdir(root)):
        gdir = os.path.join(root, name)
        if not (safe_name(name) and os.path.isfile(os.path.join(gdir, "glossary.md"))):
            continue
        out.append({"name": name, "terms": len(load_terms(gdir)), "files_read": files_read(gdir),
                    "indexed": rag_indexed(gdir)})
    return out


def term_rows(gdir: str) -> list:
    """One row per term for the list: kind, support (SEEN:), counts of definitions/facts/links."""
    rows = []
    for term in load_terms(gdir):
        a = read_article(gdir, term) if safe_name(term) else None
        a = a or {k.lower(): [] for k in _SECTIONS}
        rows.append({"term": term, "kind": term_kind(a["kind"]), "seen": len(a["seen"]),
                     "definitions": len(a["definition"]), "facts": len(a["facts"]),
                     "links": len(a["link"]) + len(a["synonym"]), "words": len(term.split("-"))})
    return rows


def _is_article(path: str) -> bool:
    """A search hit that is an article: <term>.md at the top of the glossary (not _think/, glossary.md, html)."""
    p = path.replace("\\", "/").lstrip("./")
    return "/" not in p and p.endswith(".md") and p != "glossary.md" and not p.startswith("_")


def search(gdir: str, query: str, top: int = 15, timeout: int = 120) -> list:
    """[{"term", "score"}] — simargl's file search over the glossary's own store, articles only.
    Asks for more than `top` because _think/ dumps and glossary.md share the store."""
    if not rag_indexed(gdir):
        raise GlossaryError("this glossary has no search index yet — build it first")
    cmd = ["simargl", "search", "-", "--mode", "file", "--format", "json", "--project", RAG_PROJECT,
           "--store-dir", os.path.join(gdir, ".simargl"), "--top-n", str(top * 4), "--top-k", str(top * 4)]
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    try:
        r = subprocess.run(cmd, input=query, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout, cwd=gdir, env=env)
    except OSError as e:
        raise GlossaryError(f"could not start 'simargl' ({e}) — is it installed and on PATH?") from e
    except subprocess.TimeoutExpired as e:
        raise GlossaryError(f"simargl search took longer than {timeout} s") from e
    if r.returncode != 0:
        raise GlossaryError(f"simargl search failed: {(r.stderr or r.stdout).strip()[:300]}")
    try:
        data = json.loads(r.stdout)
    except ValueError as e:
        raise GlossaryError(f"simargl search printed no JSON: {r.stdout.strip()[:200]}") from e
    hits = []
    for f in data.get("files") or []:
        path = f.get("path") or ""
        if _is_article(path):
            hits.append({"term": os.path.splitext(os.path.basename(path))[0],
                         "score": round(float(f.get("score") or 0), 4)})
        if len(hits) >= top:
            break
    return hits


# /flow glossary commands the Glossary tab can launch besides index: the exports for a
# machine without alkonost or for git (html, contents), the relink pass, and the queries.
# "filter" is the bare form: /flow glossary <tokens>.
RUN_COMMANDS = ("relink", "html", "contents", "find", "extract", "show", "filter")
_NEEDS_ARGS = ("find", "extract", "show", "filter")


def run_command(body: dict) -> tuple:
    """(cmd, args) for the glossary_cmd template, or GlossaryError."""
    cmd = (body.get("cmd") or "").strip()
    if cmd not in RUN_COMMANDS:
        raise GlossaryError(f"unknown glossary command: {cmd!r}")
    args = str(body.get("args") or "").strip()
    if "\n" in args or "\r" in args:
        raise GlossaryError("arguments must be one line")
    if "--project" in args:
        raise GlossaryError("--project is the glossary chosen above")
    if cmd == "relink" and body.get("synonyms"):
        args = (args + " --synonyms").strip()
    if cmd in _NEEDS_ARGS and not args:
        raise GlossaryError(f"{cmd} needs a text")
    return ("" if cmd == "filter" else cmd), args


def index_extra(body: dict) -> str:
    """The `/flow glossary index` flags from the launch form (only known flags; free text last)."""
    parts = []
    for key, flag in (("terms_only", "--terms-only"), ("crosslink", "--crosslink"), ("all", "--all"),
                      ("prune", "--prune"), ("jev", "--jev")):
        if body.get(key):
            parts.append(flag)
    for key, flag in (("jev_model", "--jev-model"), ("jev_host", "--jev-host")):
        v = str(body.get(key) or "").strip()
        if v:
            if any(c.isspace() for c in v):
                raise GlossaryError(f"{flag} takes one word, got {v!r}")
            parts.append(f"{flag} {v}")
    extra = str(body.get("extra") or "").strip()
    if extra:
        parts.append(extra)
    return " ".join(parts)
