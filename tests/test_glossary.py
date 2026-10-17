import json
import os
import shutil
import subprocess

import pytest

from conftest import FIXTURES
from alkonost import config as config_mod
from alkonost import glossary as G
from alkonost import runner
from alkonost.flask_api import create_app

ARTICLE = """# dbt-templater

DEFINITION:
- Renders SQL through dbt before linting. [file: docs/a.md:3]

FACTS:
- Needs a dbt project. [file: docs/a.md:9]
- Slower than jinja. [file: docs/b.md:1]

LINK:
- [templater](templater.md)

SYNONYM:

KIND:
- domain 0.91 [file: docs/a.md:3]
- technology 0.60 [file: docs/b.md:1]
- domain 0.80 [file: docs/c.md:2]

SEEN:
- file: docs/a.md:3
- file: docs/b.md:1
- file: docs/c.md:2

HISTORY:
"""


def _glossary(root, name="docs", terms=None):
    gdir = os.path.join(root, ".1bcoder", "glossary", name)
    os.makedirs(gdir, exist_ok=True)
    terms = terms or {"dbt-templater": ARTICLE, "templater": "# templater\n\nDEFINITION:\n- Renders.\n"}
    with open(os.path.join(gdir, "glossary.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(sorted(terms)) + "\n")
    for t, text in terms.items():
        with open(os.path.join(gdir, t + ".md"), "w", encoding="utf-8") as f:
            f.write(text)
    with open(os.path.join(gdir, "_index.json"), "w", encoding="utf-8") as f:
        json.dump({"files": {"docs/a.md": [1, 2], "docs/b.md": [1, 2]}}, f)
    return gdir


def test_parse_article_sections():
    a = G.parse_article(ARTICLE)
    assert a["definition"] == ["Renders SQL through dbt before linting. [file: docs/a.md:3]"]
    assert len(a["facts"]) == 2 and a["link"] == ["templater"] and a["synonym"] == []
    assert len(a["kind"]) == 3 and len(a["seen"]) == 3 and a["history"] == []


def test_parse_article_legacy_paragraph_and_missing_sections():
    a = G.parse_article("# x\n\nDEFINITION:\nA plain\nparagraph.\n\nFACTS:\n- one\n")
    assert a["definition"] == ["A plain paragraph."] and a["facts"] == ["one"]
    assert a["kind"] == [] and a["seen"] == []


def test_term_kind_majority_then_mass():
    assert G.term_kind(G.parse_article(ARTICLE)["kind"]) == "domain"
    assert G.term_kind(["noise 0.9 [file: a:1]", "domain 0.6 [file: b:1]"]) == "noise"   # tie: more mass
    assert G.term_kind([]) is None


def test_list_and_rows(tmp_path):
    _glossary(str(tmp_path))
    (tmp_path / ".1bcoder" / "glossary" / "empty-folder").mkdir()          # no glossary.md: not listed
    gl = G.list_glossaries(str(tmp_path))
    assert gl == [{"name": "docs", "terms": 2, "files_read": 2, "indexed": False}]
    rows = {r["term"]: r for r in G.term_rows(os.path.join(str(tmp_path), ".1bcoder", "glossary", "docs"))}
    assert rows["dbt-templater"] == {"term": "dbt-templater", "kind": "domain", "seen": 3, "definitions": 1,
                                     "facts": 2, "links": 1, "words": 2}
    assert rows["templater"]["kind"] is None and rows["templater"]["seen"] == 0


def test_names_cannot_leave_the_folder(tmp_path):
    for bad in ("../x", "a/b", "..", "", ".hidden", "a\\b"):
        assert not G.safe_name(bad)
        with pytest.raises(G.GlossaryError):
            G.glossary_dir(str(tmp_path), bad)


def test_index_extra_flags():
    assert G.index_extra({"terms_only": True, "jev": True, "jev_model": "tev1:4b",
                          "jev_host": "localhost:11434", "extra": "--chunk 800"}) == \
        "--terms-only --jev --jev-model tev1:4b --jev-host localhost:11434 --chunk 800"
    assert G.index_extra({}) == ""
    with pytest.raises(G.GlossaryError):
        G.index_extra({"jev_model": "tev1 4b"})


def test_search_keeps_articles_only(tmp_path, monkeypatch):
    gdir = _glossary(str(tmp_path))
    os.makedirs(os.path.join(gdir, ".simargl", G.RAG_PROJECT))
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"], seen["input"] = cmd, kw.get("input")
        out = {"files": [{"path": "_think/a.md_chunk1.md", "score": 0.9},
                         {"path": "glossary.md", "score": 0.8},
                         {"path": "dbt-templater.md", "score": 0.7},
                         {"path": "glossary.html", "score": 0.6},
                         {"path": "./templater.md", "score": 0.5}]}
        return subprocess.CompletedProcess(cmd, 0, json.dumps(out), "")
    monkeypatch.setattr(G.subprocess, "run", fake_run)
    hits = G.search(gdir, "how is SQL rendered?")
    assert hits == [{"term": "dbt-templater", "score": 0.7}, {"term": "templater", "score": 0.5}]
    assert seen["input"] == "how is SQL rendered?"                         # the query over stdin, never argv
    assert seen["cmd"][seen["cmd"].index("--store-dir") + 1] == os.path.join(gdir, ".simargl")


def test_search_without_index(tmp_path):
    with pytest.raises(G.GlossaryError):
        G.search(_glossary(str(tmp_path)), "x")


# ── API ─────────────────────────────────────────────────────────────────

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config_mod, "_config_dir", lambda: str(tmp_path / ".alkonost"))
    root = tmp_path / "fixtures"
    shutil.copytree(FIXTURES, root)
    app = create_app(root=str(root), max_depth=6)
    app.testing = True
    with app.test_client() as c:
        c._root = str(root)
        yield c


def _pid(client, name="proj_a"):
    return next(p["id"] for p in client.get("/api/projects").get_json() if p["name"] == name)


def test_api_list_terms_term(client):
    pid = _pid(client)
    _glossary(os.path.join(client._root, "proj_a"))
    assert client.get(f"/api/glossary/list?project={pid}").get_json()["glossaries"][0]["name"] == "docs"
    terms = client.get(f"/api/glossary/terms?project={pid}&name=docs").get_json()["terms"]
    assert {t["term"] for t in terms} == {"dbt-templater", "templater"}
    a = client.get(f"/api/glossary/term?project={pid}&name=docs&term=dbt-templater").get_json()
    assert a["kind_verdict"] == "domain" and a["link"] == ["templater"]
    assert client.get(f"/api/glossary/term?project={pid}&name=docs&term=nope").status_code == 404
    assert client.get(f"/api/glossary/term?project={pid}&name=docs&term=..%2Fx").status_code == 400
    assert client.get(f"/api/glossary/terms?project={pid}&name=missing").status_code == 404
    assert client.get(f"/api/glossary/terms?project={pid}&name=..").status_code == 400


def test_api_index_launches_the_flow(client, monkeypatch):
    pid = _pid(client)
    os.makedirs(os.path.join(client._root, "proj_a", "docs"))
    calls = []
    monkeypatch.setattr(runner, "launch", lambda root, action, params: calls.append((action, params)) or "L1")
    r = client.post(f"/api/glossary/index?project={pid}",
                    json={"name": "docs", "source": "docs", "terms_only": True, "jev_model": "tev1:4b"})
    assert r.get_json() == {"launch_id": "L1"}
    assert calls == [("glossary_index", {"source": "docs", "name": "docs",
                                         "extra": "--terms-only --jev-model tev1:4b"})]
    assert client.post(f"/api/glossary/index?project={pid}", json={"name": "docs", "source": "nope"}).status_code == 400
    assert client.post(f"/api/glossary/index?project={pid}", json={"name": "docs", "source": "../.."}).status_code == 400
    assert client.post(f"/api/glossary/index?project={pid}", json={"name": "a/b", "source": "docs"}).status_code == 400


def test_api_rag_index_uses_the_glossary_folder(client, monkeypatch):
    pid = _pid(client)
    gdir = _glossary(os.path.join(client._root, "proj_a"))
    calls = []
    monkeypatch.setattr(runner, "launch", lambda root, action, params: calls.append((action, params)) or "L2")
    assert client.post(f"/api/glossary/rag_index?project={pid}&name=docs").get_json() == {"launch_id": "L2"}
    assert calls == [("rag_index", {"plan_dir": gdir, "rag_name": G.RAG_PROJECT})]


def test_api_search_without_index_says_so(client):
    pid = _pid(client)
    _glossary(os.path.join(client._root, "proj_a"))
    r = client.get(f"/api/glossary/search?project={pid}&name=docs&q=sql")
    assert r.status_code == 409 and "index" in r.get_json()["error"]
    assert client.get(f"/api/glossary/search?project={pid}&name=docs").status_code == 400


def test_glossary_index_template(tmp_path):
    fname = runner.ensure_script(str(tmp_path), "glossary_index")
    text = open(os.path.join(str(tmp_path), ".1bcoder", "scripts", fname), encoding="utf-8").read()
    assert text.startswith("/flow glossary index {{source}} --project {{name}}") and "{{extra}}" in text


def test_run_command_checks_what_it_launches():
    assert G.run_command({"cmd": "relink", "synonyms": True}) == ("relink", "--synonyms")
    assert G.run_command({"cmd": "html"}) == ("html", "")
    assert G.run_command({"cmd": "find", "args": " amortization "}) == ("find", "amortization")
    assert G.run_command({"cmd": "filter", "args": "\\rule -deprecated"}) == ("", "\\rule -deprecated")
    for bad in ({"cmd": "index"}, {"cmd": "find"}, {"cmd": "show", "args": "a\n/run x"},
                {"cmd": "find", "args": "x --project other"}):
        with pytest.raises(G.GlossaryError):
            G.run_command(bad)


def test_api_run_launches_the_command(client, monkeypatch):
    pid = _pid(client)
    _glossary(os.path.join(client._root, "proj_a"))
    calls = []
    monkeypatch.setattr(runner, "launch", lambda root, action, params: calls.append((action, params)) or "L3")
    assert client.post(f"/api/glossary/run?project={pid}&name=docs", json={"cmd": "contents"}).get_json() == {"launch_id": "L3"}
    assert calls == [("glossary_cmd", {"cmd": "contents", "args": "", "name": "docs"})]
    assert client.post(f"/api/glossary/run?project={pid}&name=docs", json={"cmd": "rm"}).status_code == 400
    assert client.post(f"/api/glossary/run?project={pid}&name=missing", json={"cmd": "html"}).status_code == 404


def test_glossary_cmd_template(tmp_path):
    fname = runner.ensure_script(str(tmp_path), "glossary_cmd")
    text = open(os.path.join(str(tmp_path), ".1bcoder", "scripts", fname), encoding="utf-8").read()
    assert text == "/flow glossary {{cmd}} {{args}} --project {{name}}\n"
