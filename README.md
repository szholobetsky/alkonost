![alkonost](https://raw.githubusercontent.com/szholobetsky/simrgl/main/images/logo/alkonost.png)

# alkonost

A local, self-hosted task tracker that stores everything as plain markdown files on your own disk — no account, no cloud, no database to manage.

The name comes from **Алконост** (Alkonost), the Slavic paradise-bird of joyful song — traditionally depicted paired with **Сирин** (Sirin, sorrow/night), the tool this ecosystem already calls **syryn**.

---

## What it is

Open Alkonost in your browser and you get a Kanban-style board, a searchable backlog table, tags and color-coded modules, and a full markdown editor for writing out what each task actually involves — tables, formulas, diagrams included.

Everything is stored in a plain checklist file you could just as easily open in a text editor, back up, or put under version control. Nothing is sent anywhere; the whole thing runs on your own machine.

---

## Features

### Board & Backlog
Move cards between status columns by dragging them, or use the "move to" dropdown on any card — handy if drag-and-drop isn't convenient (touch screens, for example). Every task also shows up in a filterable backlog table below the board, no matter its status, so nothing is ever truly hidden.

### Show only what matters right now
Got a long backlog but only want to see active work on the board? Type a short list of statuses (e.g. `selected, active, testing, done`) and the board shows only those columns — everything else stays out of the way in the backlog table until you need it.

### Tags, modules, people
Add hashtags, assign a task to a module or team (each with its own color), flag something urgent, or assign it to a person — all clickable as filters.

### Full task descriptions
Click a task to open its full description in a side panel, rendered as real formatted text — headings, tables, formulas, and diagrams, not just plain text. Click the pencil icon to edit it, with a live preview underneath so you can see exactly what your text will look like as you type, even if you don't know markdown syntax.

### Works across multiple projects
Point Alkonost at a folder containing several projects and it finds all of them — switch between projects and boards from the same running instance.

### Autosave, themes, small screens
Every change saves itself automatically — no save button to remember. Pick from eight color themes. The layout adapts to narrow windows and touch devices.

---

## Install

```bash
pip install alkonost
```

### For developers

```bash
git clone https://github.com/szholobetsky/alkonost.git
cd alkonost
pip install -e .
```

---

## Quick start

```bash
alkonost
```

Open `http://localhost:8090` in your browser. Run it from the folder where you keep your project (or a folder that contains several projects) — Alkonost looks for existing boards there and lets you pick one. If nothing exists yet, just click **+ Add Task** to start a board from scratch, right there in the browser.

Common options:

```bash
alkonost -p 8090             # custom port (default: 8090)
alkonost --root D:\Work      # folder to look in (default: current folder)
alkonost --bind 127.0.0.1    # this computer only (default: reachable on your network)
```

---

## Two ways to fill a board

**By hand** — click **+ Add Task**, give it a title and any tags you like, and go. Each task can get its own **+ Add SubTask** and its own written description (**+ Add spec**), directly in the app. No other tool required.

**Generated from a task breakdown** — if you're already using **1bcoder** (a companion AI assistant) to break a large task down into smaller steps, its output turns into an Alkonost board automatically, with no manual setup:

- one flow expands a task description into an outline of smaller sections
- another writes a clear, structured description for each of the smallest steps
- a final one collects the whole outline into a single checklist

Point Alkonost at the same folder, and that checklist *is* your board — editable from either side, so you can keep refining the breakdown with 1bcoder while managing day-to-day progress in Alkonost.

---

## Quick call: from one big task to a full board

The full pipeline for turning a single task description into a ready-to-use board, using [1bcoder](https://github.com/szholobetsky/1bcoder):

**1. Start 1bcoder in your project folder and point it at your model**

```bash
pip install 1bcoder
1bcoder
```
```
/model gemma3:1b
/host localhost:11434
```
(`/host` only if you're not using the default local Ollama setup — see 1bcoder's own docs for other backends.)

**2. Load your task description**

Write out what you're trying to build in a plain text file, then load it:

```
/read task.txt
```

**3. Expand it into an outline** — `deepagent_md` turns the task into a tree of smaller and smaller sections. How you phrase the task and the `plan:` labels decides what kind of tree you get:

For a technical, architecture-first breakdown (modules → layers → concrete classes/routes/tables):
```
/flow deepagent_md "how to implement such system" --ctx 2 --maxdepth 4 plan: inter-module boundaries (frontend/backend/database), intra-module layers (e.g. MVC), concrete objects (class/method/route/table)
```

For a product-style breakdown (feature → user story → the exact technical flow behind it) — phrase the task itself like an app-store listing, not "how to implement":
```
/flow deepagent_md "the feature list for this app's store page, written the way a user reads it before downloading — never mentioning backend, database, or implementation details" --ctx 2 --maxdepth 3 plan: a single non-overlapping user-facing capability — named the way a product manager would name a feature on a roadmap — never a technical mechanism or system layer or a non-functional/performance concern (those are not epics), one single user story within that capability — written strictly as "As a [app user] I want [one specific action] so that [one specific benefit]" — describe exactly one thing the user does in one sitting — never combine multiple actions or backend responsibilities into one story, the complete closed end-to-end technical flow that fully implements that one story — name the actual screen or UI element — the actual API endpoint and method — the actual database fields written or read — and the exact response the user sees
```

Drop `--maxdepth` to `2` for just epic → user story, with no third level spelling out the technical flow — faster, but leaves less for the next step to work with.

**4. Write a real description for each smallest step**

```
/flow deepagent_spec plan1
```

(`plan1` is whatever plan name `deepagent_md` printed when it finished — check its output.)

**5. Roll the whole tree up into one checklist**

```
/flow deepagent_task plan1
```

This is the file Alkonost reads as a board.

**6. Open it in Alkonost**

```bash
alkonost --root .
```

Pick the project and plan you just generated, and everything `deepagent_md`/`deepagent_spec`/`deepagent_task` produced is already there as cards you can edit, move, and re-tag.

---

## Requirements

Python 3.10 or newer. Everything else (Flask, Waitress) installs automatically with `pip`.

---

## For developers

<details>
<summary>Project layout</summary>

```
alkonost/
├── alkonost/
│   ├── discovery.py    # finds projects/boards under a folder
│   ├── planmd.py       # reads a task-breakdown tree, if one exists
│   ├── spec.py         # reads/writes task description files
│   ├── tasks.py        # reads/writes the board's checklist file
│   ├── colors.py       # module → color legend
│   ├── dashboard.py    # "show only these statuses" setting
│   ├── config.py       # remembers your last-used project/plan/theme
│   ├── flask_api.py    # the web server
│   ├── __main__.py      # CLI entry point
│   └── ui/              # the browser UI (no build step)
├── tests/
│   ├── fixtures/         # sample data for the Python tests
│   ├── js/               # Node test suite for the UI
│   └── test_*.py         # pytest suite
├── pyproject.toml
├── README.md
└── .gitignore
```
</details>

<details>
<summary>Tests</summary>

Python side (parsing, discovery, the web API):

```bash
pip install -e ".[dev]"
pytest
```

Client-side (`ui/app.js` — rendering, autosave, filtering). No build step, no extra dependency — runs on Node's built-in test runner (Node 18+):

```bash
node --test tests/js/*.test.js
```
</details>

---

## Part of the SIMARGL toolkit

alkonost is one of eight tools that together form an **intellectual development support system**:

| Tool | Role |
|---|---|
| **[simargl](https://github.com/szholobetsky/simargl)** | Task-to-code retrieval — given a task description, finds which files and modules are likely affected, using semantic similarity over git history |
| **[svitovyd](https://github.com/szholobetsky/svitovyd)** | Project map — scans any codebase and produces a structural map of definitions and cross-file dependencies; exposes it as an MCP server |
| **[1bcoder](https://github.com/szholobetsky/1bcoder)** | AI coding assistant for small local models — surgical context management, agents, parallel inference, proc scripts |
| **[yasna](https://github.com/szholobetsky/yasna)** | Session memory — indexes conversations from all AI agents so you can find what was discussed, when, and where |
| **[radogast](https://github.com/szholobetsky/radogast)** | Context drift monitor — measures how far an AI agent's conversation has drifted from the original task |
| **[vyrii](https://github.com/szholobetsky/vyrii)** | Local AI web UI — chat, translate, web research, RAG, and file management via Gradio; powered by Ollama or any OpenAI-compatible backend |
| **[syryn](https://github.com/szholobetsky/syryn)** | Bluetooth identity beacon — returns hostname, mDNS, and active network interfaces for headless devices |
| **[alkonost](https://github.com/szholobetsky/alkonost)** | Task-board viewer/editor — Trello-style board and backlog over 1bcoder's `deepagent_task` output, with full spec rendering and autosave |

- **simargl** answers: *what code is related to this task?*
- **svitovyd** answers: *how is the code structured and what depends on what?*
- **1bcoder** answers: *how do I work with local models efficiently?*
- **yasna** answers: *where did I already discuss this?*
- **radogast** answers: *is the AI agent still on track toward the goal?*
- **vyrii** answers: *how do I access all of this through a browser?*
- **syryn** answers: *what is the address of this headless device?*
- **alkonost** answers: *where do I see and edit the tasks generated from a spec tree?*

Together they cover the full development loop: understand the codebase, find relevant history, work with AI locally, access everything through a web UI, remember what was decided, verify the context stays on target, locate a headless device, and manage the resulting tasks.

---

## About

(c) 2026 Stanislav Zholobetskyi, Oleh Andriichuk
Institute for Information Recording, National Academy of Sciences of Ukraine, Kyiv
PhD research: «Intelligent Technology for Software Development and Maintenance Support»
