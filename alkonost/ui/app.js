"use strict";

const state = {
  projects: [],
  projectId: null,
  plans: [],
  plan: null,
  rows: [],
  colors: {},
  specIds: new Set(), // every "<leaf_id>.<sec_index>" that has a real spec_*.md file for the current plan
  dashboardFlow: [],   // ordered, bare lane names (no "+") — empty = show every lane found in data
  dirty: new Set(),
  activeFilters: new Set(),
  theme: localStorage.getItem("alkonost-theme") || "ocean",
  fitWidth: localStorage.getItem("alkonost-fit-width") === "1",
  // the currently-open side panel document — kind is 'spec' | 'item' | null
  // (null means the content isn't a single editable file: the "not found"
  // fallback text, or the synthetic planMD tree listing)
  sidePanel: { kind: null, id: null, raw: "", editing: false, dirty: false },
};

const $ = (sel) => document.querySelector(sel);

// ── markdown / LaTeX / mermaid rendering (ported from vyrii's chat `md()`) ──

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function md(text) {
  if (!text) return "";

  // Step 0 — extract math blocks before anything else (LaTeX / KaTeX)
  const mathBlocks = [];
  let s = text.replace(/\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g, (m, a, b) => {
    const idx = mathBlocks.length;
    mathBlocks.push({ display: true, tex: (a ?? b).trim() });
    return `\x00MB${idx}\x00`;
  });
  s = s.replace(/\$([^\$\n]+?)\$|\\\((.+?)\\\)/g, (m, a, b) => {
    const idx = mathBlocks.length;
    mathBlocks.push({ display: false, tex: (a ?? b).trim() });
    return `\x00MB${idx}\x00`;
  });

  // Step 0b — extract SOURCE: [src: item_<id>.md#<n>] provenance lines
  // (written by deepagent_spec) into a clickable link that opens the
  // referenced planMD item in the side panel.
  const sourceRefs = [];
  s = s.replace(/SOURCE:\s*\[src:\s*item_([\d.]+)\.md#(\d+)\]/g, (_, itemId, sec) => {
    const idx = sourceRefs.length;
    sourceRefs.push({ itemId, sec });
    return `\x00SR${idx}\x00`;
  });

  // Step 1a — extract mermaid blocks
  const mermaidBlocks = [];
  s = s.replace(/```mermaid\n?([\s\S]*?)```/g, (_, c) => {
    const idx = mermaidBlocks.length;
    mermaidBlocks.push(c.trim());
    return `\x00MM${idx}\x00`;
  });

  // Step 1b — extract pipe tables (| col | col | with --- separator)
  const tableBlocks = [];
  s = s.replace(/(^\|.+\|[ \t]*\n\|[ \t]*[-:]+[-| :\t]*\n(?:\|.+\|[ \t]*\n?)+)/gm, (m) => {
    const idx = tableBlocks.length;
    tableBlocks.push(m.trim());
    return `\x00TB${idx}\x00`;
  });

  // Step 1c — extract remaining code blocks before escaping
  const codeBlocks = [];
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, c) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escHtml(c.trim())}</code></pre>`);
    return `\x00CB${idx}\x00`;
  });

  // Step 2 — escape ALL HTML entities in remaining text (prevents <tag> injection)
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Step 3 — inline code
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${escHtml(c)}</code>`);

  // Step 4 — bold / italic
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

  // Step 5 — headings
  s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Step 6 — lists
  s = s.replace(/^[*-] (.+)$/gm, "<li>$1</li>");
  s = s.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  s = s.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul>${m}</ul>`);

  // Step 7 — paragraphs (double newline)
  s = s.split(/\n{2,}/)
    .map(para => para.startsWith("<") ? para : `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");

  // Step 8 — restore code blocks
  s = s.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[+i]);

  // Step 8b — restore table blocks as HTML tables
  s = s.replace(/\x00TB(\d+)\x00/g, (_, i) => {
    const raw = tableBlocks[+i];
    const lines = raw.split("\n").filter(l => l.trim());
    if (lines.length < 2) return escHtml(raw);
    const parseRow = (line) => line.split("|").slice(1, -1).map(c => c.trim());
    const headers = parseRow(lines[0]);
    const aligns = parseRow(lines[1]).map(c => {
      if (c.startsWith(":") && c.endsWith(":")) return "center";
      if (c.endsWith(":")) return "right";
      return "left";
    });
    let h = '<table class="md-table"><thead><tr>';
    headers.forEach((hd, j) => {
      h += `<th style="text-align:${aligns[j] || "left"}">${escHtml(hd)}</th>`;
    });
    h += "</tr></thead><tbody>";
    for (let r = 2; r < lines.length; r++) {
      const cells = parseRow(lines[r]);
      h += "<tr>";
      cells.forEach((c, j) => {
        h += `<td style="text-align:${aligns[j] || "left"}">${escHtml(c)}</td>`;
      });
      h += "</tr>";
    }
    h += "</tbody></table>";
    return h;
  });

  // Step 9 — render math blocks via KaTeX
  s = s.replace(/\x00MB(\d+)\x00/g, (_, i) => {
    const mb = mathBlocks[+i];
    const encoded = mb.tex.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const tag = mb.display ? "div" : "span";
    try {
      const html = katex.renderToString(mb.tex, { displayMode: mb.display, throwOnError: false });
      return `<${tag} class="katex-wrap${mb.display ? " katex-display-wrap" : ""}" data-tex="${encoded}">${html}<button class="katex-copy" onclick="copyKatexSrc(this)" title="Copy LaTeX">&#128203;</button></${tag}>`;
    } catch { return escHtml(mb.tex); }
  });

  // Step 10 — insert mermaid placeholders (rendered async after innerHTML)
  s = s.replace(/\x00MM(\d+)\x00/g, (_, i) => {
    const raw = mermaidBlocks[+i];
    const encoded = raw.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return `<div class="mermaid-wrap"><button class="mermaid-copy" onclick="copyMermaidSrc(this)" title="Copy source">&#128203;</button><pre class="mermaid" data-src="${encoded}">${escHtml(raw)}</pre></div>`;
  });

  // Step 11 — restore SOURCE: provenance lines as clickable item links
  s = s.replace(/\x00SR(\d+)\x00/g, (_, i) => {
    const ref = sourceRefs[+i];
    return `<a class="source-link" onclick="openItemPanel('${ref.itemId}')" title="Open source item_${ref.itemId}.md">SOURCE: item_${ref.itemId}.md #${ref.sec}</a>`;
  });

  return s;
}

function renderMermaid(container) {
  if (typeof mermaid === "undefined") return;
  const nodes = (container || document).querySelectorAll("pre.mermaid:not([data-processed])");
  if (!nodes.length) return;
  try { mermaid.run({ nodes }); } catch (e) { /* ignore render errors */ }
}

function copyKatexSrc(btn) {
  const wrap = btn.parentElement;
  const src = wrap?.dataset.tex || "";
  navigator.clipboard.writeText(src);
}

function copyMermaidSrc(btn) {
  const pre = btn.parentElement.querySelector("pre.mermaid");
  const src = pre?.dataset.src || pre?.textContent || "";
  navigator.clipboard.writeText(src);
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── last-selection persistence (~/.alkonost/config.json) ────────────────
// The one bit of state that belongs to the alkonost installation itself
// rather than to any scanned project — which project/plan/theme were last
// used, saved immediately on each change (not debounced/autosaved: a
// deliberate select action, not continuous typing) so the next launch can
// restore them instead of starting back at "Select project…" every time.

function saveLastSelection(patch) {
  fetchJSON("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => { /* best-effort — not worth surfacing an error for a preference save */ });
}

async function restoreLastSelection() {
  let cfg;
  try {
    cfg = await fetchJSON("/api/config");
  } catch (e) {
    return;
  }

  if (cfg.theme && cfg.theme !== state.theme) {
    setTheme(cfg.theme);
  }

  if (cfg.last_project_id && state.projects.some(p => p.id === cfg.last_project_id)) {
    $("#project-select").value = cfg.last_project_id;
    await onProjectChange();
    if (cfg.last_plan && state.plans.some(p => p.name === cfg.last_plan)) {
      $("#plan-select").value = cfg.last_plan;
      await onPlanChange();
    }
  }
}

// ── loading ────────────────────────────────────────────────────────────

async function loadProjects() {
  state.projects = await fetchJSON("/api/projects");
  const sel = $("#project-select");
  sel.innerHTML = '<option value="">Select project…</option>' +
    state.projects.map(p => `<option value="${p.id}">${p.name} (${p.plan_count})</option>`).join("");
}

async function loadPlans(projectId) {
  state.plans = await fetchJSON(`/api/plans?project=${encodeURIComponent(projectId)}`);
  const sel = $("#plan-select");
  sel.disabled = state.plans.length === 0;
  sel.innerHTML = '<option value="">Select plan…</option>' +
    state.plans.map(p => {
      const label = `${p.name}${p.has_tasks ? ` (${p.task_count})` : " — no tasks yet"}`;
      return `<option value="${p.name}">${label}</option>`;
    }).join("");
}

async function loadTasks(projectId, plan) {
  const data = await fetchJSON(`/api/tasks?project=${encodeURIComponent(projectId)}&plan=${encodeURIComponent(plan)}`);
  state.rows = data.rows;
  state.dirty.clear();
  $("#save-btn").disabled = true;
  setSaveStatus("");
  $("#empty-state").classList.toggle("hidden", data.exists);
  $("#board").classList.toggle("hidden", !data.exists);
  $("#backlog-section").classList.toggle("hidden", !data.exists);
}

async function loadSpecIndex(projectId, plan) {
  try {
    const data = await fetchJSON(`/api/spec_index?project=${encodeURIComponent(projectId)}&plan=${encodeURIComponent(plan)}`);
    state.specIds = new Set(data.spec_ids || []);
  } catch (e) {
    state.specIds = new Set();
  }
}

function hasSpec(row) {
  return state.specIds.has(row.id);
}

async function loadColors(projectId) {
  const data = await fetchJSON(`/api/colors?project=${encodeURIComponent(projectId)}`);
  state.colors = data.colors;
}

async function loadDashboardFlow(projectId) {
  const data = await fetchJSON(`/api/dashboard_flow?project=${encodeURIComponent(projectId)}`);
  state.dashboardFlow = data.flow || [];
}

function parseDashboardFlowInput(raw) {
  return raw.split(",").map(s => s.trim().replace(/^\+/, "")).filter(Boolean);
}

async function saveDashboardFlow() {
  if (!state.projectId) return;
  try {
    await fetchJSON(`/api/dashboard_flow?project=${encodeURIComponent(state.projectId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flow: state.dashboardFlow }),
    });
  } catch (e) {
    setSaveStatus(`⚠ dashboard flow save failed: ${e.message}`, "error");
  }
}

// ── theme ──────────────────────────────────────────────────────────────

async function loadThemes() {
  try {
    const data = await fetchJSON("/api/themes");
    const themes = data.themes && data.themes.length ? data.themes : ["ocean"];
    const sel = $("#theme-select");
    if (!sel) return;
    sel.innerHTML = themes
      .map(n => `<option value="${n}"${n === state.theme ? " selected" : ""}>${n.charAt(0).toUpperCase() + n.slice(1)}</option>`)
      .join("");
  } catch (e) { /* offline — keep default */ }
}

function setTheme(name) {
  state.theme = name;
  localStorage.setItem("alkonost-theme", name);
  applyTheme(name);
  saveLastSelection({ theme: name });
}

function applyTheme(name) {
  const link = $("#theme-link");
  if (link) link.href = `themes/${name}.css`;
  document.documentElement.setAttribute("data-theme", name);
  const sel = $("#theme-select");
  if (sel && sel.value !== name) sel.value = name;
}

// ── fit-to-screen ──────────────────────────────────────────────────────
// Toggles between the default (lanes at a fixed width, board scrolls
// left/right once there are more columns than fit) and shrinking every
// lane to an equal share of the available width instead. Set once on the
// #board element itself, not re-applied per renderBoard() call — the
// <section> node is never replaced, only its children, so the class
// persists across re-renders on its own.
function setFitWidth(on) {
  state.fitWidth = on;
  localStorage.setItem("alkonost-fit-width", on ? "1" : "0");
  applyFitWidth();
}

function applyFitWidth() {
  $("#board").classList.toggle("fit-width", state.fitWidth);
  const toggle = $("#fit-width-toggle");
  if (toggle) toggle.checked = state.fitWidth;
}

// ── rendering ──────────────────────────────────────────────────────────

function laneOf(row) {
  const nonUrgent = (row.tags.plus || []).filter(p => p !== "urgent");
  return nonUrgent.length ? nonUrgent[0] : "no-lane";
}

function isUrgent(row) {
  return (row.tags.plus || []).includes("urgent");
}

function collectLanes(rows) {
  const seen = [];
  for (const row of rows) {
    const lane = laneOf(row);
    if (!seen.includes(lane)) seen.push(lane);
  }
  return seen;
}

// Every lane the "move to lane" dropdown should offer: every lane actually
// present in the data, plus every configured-but-currently-empty dashboard
// lane (e.g. a fresh "+releasing" column with no cards yet) — always the
// full set, regardless of the dashboard filter below.
function allLaneOptions() {
  const set = new Set(collectLanes(state.rows));
  state.dashboardFlow.forEach(l => set.add(l));
  return [...set];
}

// Rows to actually show on the dashboard board — when a flow is
// configured, hides any row whose lane isn't in that list (e.g.
// +backlog/+complete/+canceled/+closed) without touching the Backlog
// table, which always lists every row regardless of this filter.
function dashboardRows(rows) {
  if (!state.dashboardFlow.length) return rows;
  return rows.filter(r => state.dashboardFlow.includes(laneOf(r)));
}

// Lane columns to render on the board — the configured flow's own order
// when set (columns always shown, even if currently empty, like a normal
// Kanban board), otherwise every lane found in the (already-filtered) rows.
function dashboardLanes(rows) {
  return state.dashboardFlow.length ? state.dashboardFlow : collectLanes(rows);
}

function collectFilterTags(rows) {
  const tags = new Set();
  for (const row of rows) {
    (row.tags.hash || []).forEach(h => tags.add(`#${h}`));
    if (row.tags.at) tags.add(`@${row.tags.at}`);
    (row.tags.plus || []).forEach(p => tags.add(`+${p}`));
    if (row.tags.user) tags.add(`%${row.tags.user}`);
  }
  return [...tags].sort();
}

function rowMatchesFilters(row) {
  if (state.activeFilters.size === 0) return true;
  const rowTags = new Set();
  (row.tags.hash || []).forEach(h => rowTags.add(`#${h}`));
  if (row.tags.at) rowTags.add(`@${row.tags.at}`);
  (row.tags.plus || []).forEach(p => rowTags.add(`+${p}`));
  if (row.tags.user) rowTags.add(`%${row.tags.user}`);
  for (const f of state.activeFilters) {
    if (rowTags.has(f)) return true;
  }
  return false;
}

function moduleColor(row) {
  return row.tags.at ? state.colors[row.tags.at] : null;
}

function renderFilterBar() {
  const bar = $("#filter-bar");
  const tags = collectFilterTags(state.rows);
  bar.innerHTML = tags.map(t => {
    const active = state.activeFilters.has(t) ? "active" : "";
    return `<button class="filter-btn ${active}" data-tag="${t}">${t}</button>`;
  }).join("");
  bar.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tag = btn.dataset.tag;
      if (state.activeFilters.has(tag)) state.activeFilters.delete(tag);
      else state.activeFilters.add(tag);
      renderAll();
    });
  });
}

function cardHtml(row, lanes) {
  const urgentClass = isUrgent(row) ? "urgent-marker" : "";
  const color = moduleColor(row);
  const style = color ? `border-left:4px solid ${color};` : "";
  return `
    <div class="card ${urgentClass}" draggable="true" data-id="${row.id}" style="${isUrgent(row) ? "" : style}">
      <div class="card-id"><span class="drag-handle" title="Drag to move">&#8942;&#8942;</span>${row.id}${isUrgent(row) ? '<span class="urgent-badge">URGENT</span>' : ""} ${navLinks(row)}</div>
      <input class="title-input" data-id="${row.id}" value="${escapeAttr(row.title)}">
      <input class="tag-input" data-id="${row.id}" data-field="tags_raw" value="${escapeAttr(serializeTagsClient(row.tags))}">
      ${laneSelectHtml(row, lanes)}
    </div>`;
}

function laneSelectHtml(row, lanes) {
  const current = laneOf(row);
  const options = lanes
    .map(l => `<option value="${escapeAttr(l)}"${l === current ? " selected" : ""}>${escapeAttr(l)}</option>`)
    .join("");
  return `<select class="lane-select" data-id="${row.id}" title="Move to lane">${options}</select>`;
}

function serializeTagsClient(tags) {
  const parts = [];
  (tags.hash || []).forEach(h => parts.push(`#${h}`));
  if (tags.at) parts.push(`@${tags.at}`);
  (tags.plus || []).forEach(p => parts.push(`+${p}`));
  if (tags.user) parts.push(`%${tags.user}`);
  if (tags.due) parts.push(`due:${tags.due}`);
  if (tags.done) parts.push(`_done:${tags.done}`);
  return parts.join(" ");
}

function parseTagsClient(raw) {
  const tags = { hash: [], at: null, plus: [], user: null, due: null, done: null };
  raw.split(/\s+/).filter(Boolean).forEach(tok => {
    if (tok.startsWith("#")) tags.hash.push(tok.slice(1));
    else if (tok.startsWith("@")) tags.at = tok.slice(1);
    else if (tok.startsWith("+")) tags.plus.push(tok.slice(1));
    else if (tok.startsWith("%")) tags.user = tok.slice(1);
    else if (tok.startsWith("due:")) tags.due = tok.slice(4) || null;
    else if (tok.startsWith("_done:")) tags.done = tok.slice(6) || null;
  });
  return tags;
}

function escapeAttr(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function renderBoard() {
  const board = $("#board");
  const visibleRows = dashboardRows(state.rows);
  const lanes = dashboardLanes(visibleRows);
  const laneOptions = allLaneOptions();
  board.innerHTML = lanes.map(lane => {
    const laneRows = visibleRows.filter(r => laneOf(r) === lane && rowMatchesFilters(r));
    return `
      <div class="lane" data-lane="${lane}">
        <h3><span class="drop-marker" title="Drop a card here to move it into ${escapeAttr(lane)}">&#8942;&#8942;</span>${lane} (${laneRows.length})</h3>
        <div class="lane-body" data-lane="${lane}">
          ${laneRows.map(r => cardHtml(r, laneOptions)).join("")}
        </div>
      </div>`;
  }).join("");
  wireCardEvents(board);
  wireDragAndDrop(board);
}

function renderBacklog() {
  const body = $("#backlog-body");
  const lanes = allLaneOptions();
  body.innerHTML = state.rows.filter(rowMatchesFilters).map(row => {
    const rowClasses = [
      state.dirty.has(row.id) ? "dirty-row" : "",
      laneOf(row) !== "no-lane" && laneOf(row) !== "backlog" ? "active-row" : "",
    ].join(" ");
    const urgentBadge = isUrgent(row) ? '<span class="urgent-badge">URGENT</span>' : "";
    return `
      <tr class="${rowClasses}" data-id="${row.id}">
        <td>${row.id}</td>
        <td><input class="title-input" data-id="${row.id}" value="${escapeAttr(row.title)}">${urgentBadge}</td>
        <td><input class="tag-input" data-id="${row.id}" data-field="tags_raw" value="${escapeAttr(serializeTagsClient(row.tags))}"></td>
        <td>${navLinks(row)} ${laneSelectHtml(row, lanes)}</td>
        <td><button class="add-subtask-btn" data-parent-id="${row.id}" title="Add a subtask under this row">+ Add SubTask</button></td>
      </tr>`;
  }).join("");
  wireCardEvents(body);
}

function navLinks(row) {
  if (hasSpec(row)) {
    return `<a class="spec-link" data-nav-spec="${row.id}" title="View spec for this task">spec</a>`;
  }
  return `<button class="add-spec-btn" data-add-spec="${row.id}" title="Create a new spec for this task">+ Add spec</button>`;
}

function wireCardEvents(container) {
  container.querySelectorAll(".title-input").forEach(input => {
    input.addEventListener("change", () => {
      const row = findRow(input.dataset.id);
      if (!row) return;
      row.title = input.value;
      markDirty(row.id);
    });
  });
  container.querySelectorAll('.tag-input[data-field="tags_raw"]').forEach(input => {
    input.addEventListener("change", () => {
      const row = findRow(input.dataset.id);
      if (!row) return;
      row.tags = parseTagsClient(input.value);
      row.tags_raw = input.value;
      markDirty(row.id);
      renderAll();
    });
  });
  container.querySelectorAll("[data-nav-spec]").forEach(a => {
    a.addEventListener("click", () => openSpecPanel(a.dataset.navSpec));
  });
  container.querySelectorAll("[data-add-spec]").forEach(btn => {
    btn.addEventListener("click", () => {
      const row = findRow(btn.dataset.addSpec);
      if (row) addSpecForRow(row.id, row.title);
    });
  });
  container.querySelectorAll(".lane-select").forEach(sel => {
    sel.addEventListener("change", () => moveRowToLane(sel.dataset.id, sel.value));
  });
  container.querySelectorAll(".add-subtask-btn").forEach(btn => {
    btn.addEventListener("click", () => openAddTaskModal({ mode: "subtask", parentId: btn.dataset.parentId }));
  });
}

function moveRowToLane(rowId, targetLane) {
  const row = findRow(rowId);
  if (!row) return;
  const urgent = row.tags.plus.includes("urgent");
  row.tags.plus = urgent ? [targetLane, "urgent"] : [targetLane];
  markDirty(row.id);
  renderAll();
}

function wireDragAndDrop(board) {
  board.querySelectorAll(".card").forEach(card => {
    card.addEventListener("dragstart", (e) => {
      card.classList.add("dragging");
      e.dataTransfer.setData("text/plain", card.dataset.id);
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  // Drop target is the WHOLE lane (title row + body), not just .lane-body —
  // an empty lane's .lane-body has no cards and no min-height, so without
  // this an empty group is basically a zero-height sliver with nowhere to
  // actually drop a card onto.
  board.querySelectorAll(".lane").forEach(laneEl => {
    laneEl.addEventListener("dragover", (e) => e.preventDefault());
    laneEl.addEventListener("drop", (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain");
      moveRowToLane(id, laneEl.dataset.lane);
    });
  });
}

function findRow(id) {
  return state.rows.find(r => r.id === id);
}

// ── autosave ───────────────────────────────────────────────────────────
// Every edit (title, tags, drag-and-drop lane move, colors) persists on
// its own shortly after the user stops interacting — debounced (not
// per-keystroke: fields still commit on "change"/blur) so a burst of
// edits collapses into one save call instead of flooding the API. The
// manual Save buttons remain as an explicit "save now" fallback.
const AUTOSAVE_MS = 400;

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const autosaveTasks = debounce(() => saveTasks(), AUTOSAVE_MS);
const autosaveColors = debounce(() => saveColors(), AUTOSAVE_MS);
const autosaveDashboardFlow = debounce(() => saveDashboardFlow(), AUTOSAVE_MS);

function setSaveStatus(text, kind) {
  const el = $("#dirty-indicator");
  el.textContent = text;
  el.classList.toggle("hidden", !text);
  el.classList.toggle("status-error", kind === "error");
  el.classList.toggle("status-ok", kind === "ok");
}

function markDirty(id) {
  state.dirty.add(id);
  $("#save-btn").disabled = false;
  setSaveStatus("unsaved changes…");
  autosaveTasks();
}

function normalizeModuleName(raw) {
  // @module tags are always stored/matched WITHOUT the leading "@" (see
  // tags.at in tokenize_tags) — strip it here so typing "@backend" (the
  // format shown everywhere else in this UI: filter buttons, tag inputs)
  // still resolves to the same key as "backend", instead of silently
  // creating a second, never-matching legend entry.
  return raw.trim().replace(/^@+/, "");
}

// Wires the remove/change listeners for one .color-row — the single place
// this happens, used by both renderColors() (existing rows) and the
// "+ Add module" handler (a freshly-created row), so the two can't drift
// out of sync the way they previously did (the add-button's row used to
// have no change listeners at all, silently never autosaving).
function wireColorRow(div) {
  div.querySelector(".remove-color").addEventListener("click", () => {
    div.remove();
    autosaveColors();
  });
  const nameInput = div.querySelector(".module-name");
  nameInput.addEventListener("change", () => {
    nameInput.value = normalizeModuleName(nameInput.value);
    autosaveColors();
  });
  div.querySelector(".module-color").addEventListener("change", () => autosaveColors());
}

function colorRowHtml(name, color) {
  return `
    <div class="color-row" data-name="${name}">
      <span class="color-row-at">@</span>
      <input type="text" class="module-name" value="${escapeAttr(name)}">
      <input type="color" class="module-color" value="${color && color.startsWith('#') ? color : '#888888'}">
      <button class="remove-color">&times;</button>
    </div>`;
}

function renderColors() {
  const editor = $("#colors-editor");
  editor.innerHTML = Object.entries(state.colors).map(([name, color]) => colorRowHtml(name, color)).join("");
  editor.querySelectorAll(".color-row").forEach(wireColorRow);
}

function renderAll() {
  renderFilterBar();
  renderBoard();
  renderBacklog();
}

// ── side panel ─────────────────────────────────────────────────────────

// True if it's OK to navigate/close now — either nothing unsaved, or the
// user confirmed discarding it. Centralized so every way of leaving an
// edit session (close button, breadcrumb "source item" link, opening a
// different card entirely, the pencil toggle itself) goes through one
// check instead of each needing its own guard.
function confirmDiscardIfDirty() {
  if (!state.sidePanel.editing || !state.sidePanel.dirty) return true;
  return confirm("Discard unsaved changes to this file?");
}

function showSidePanel(breadcrumb, content, sourceItemId, editable) {
  if (!confirmDiscardIfDirty()) return;

  state.sidePanel = { kind: editable ? editable.kind : null, id: editable ? editable.id : null, raw: content, editing: false, dirty: false };
  $("#side-panel-edit-btn").classList.toggle("hidden", !editable);
  exitEditMode(true);

  const crumb = $("#side-panel-breadcrumb");
  crumb.textContent = "";
  const label = document.createElement("span");
  label.textContent = breadcrumb;
  crumb.appendChild(label);
  if (sourceItemId) {
    crumb.appendChild(document.createTextNode("  "));
    const link = document.createElement("a");
    link.textContent = `→ source item ${sourceItemId}`;
    link.href = "javascript:void(0)";
    link.addEventListener("click", () => openItemPanel(sourceItemId));
    crumb.appendChild(link);
  }
  const contentEl = $("#side-panel-content");
  contentEl.innerHTML = md(content);
  renderMermaid(contentEl);
  $("#side-panel").classList.remove("hidden");
}

async function openSpecPanel(rowId) {
  try {
    const data = await fetchJSON(`/api/spec?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}&spec_id=${encodeURIComponent(rowId)}`);
    showSidePanel(`spec ${data.spec_id}`, data.raw, data.source_leaf_id, { kind: "spec", id: data.spec_id });
  } catch (e) {
    showSidePanel(`spec ${rowId}`, "No spec found for this row yet.");
  }
}

async function addSpecForRow(taskId, title) {
  try {
    const data = await fetchJSON(`/api/spec/create?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId, title }),
    });
    state.specIds.add(data.spec_id);
    renderAll();
    // straight into edit mode — the whole point of "Add spec" is to start
    // writing it, not just look at the starter template
    showSidePanel(`spec ${data.spec_id}`, data.raw, data.source_leaf_id, { kind: "spec", id: data.spec_id });
    enterEditMode();
  } catch (e) {
    alert(`Failed to create spec: ${e.message}`);
  }
}

async function openItemPanel(itemId) {
  try {
    const data = await fetchJSON(`/api/item?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}&item_id=${encodeURIComponent(itemId)}`);
    showSidePanel(`item ${data.id}`, data.raw, null, { kind: "item", id: data.id });
  } catch (e) {
    showSidePanel(`item ${itemId}`, "Item not found.");
  }
}

// ── side panel raw-markdown editor ───────────────────────────────────────
// No WYSIWYG — bidirectional HTML<->markdown conversion that preserves
// code/table/LaTeX/Mermaid blocks intact is a real project on its own.
// Instead: a plain textarea over the raw file plus a live preview using
// the same md() renderer the read-only view already uses, so "what will
// this look like" is answered directly rather than needing to imagine it.

function toggleEditMode() {
  if (state.sidePanel.editing) {
    if (!confirmDiscardIfDirty()) return;
    exitEditMode();
  } else {
    enterEditMode();
  }
}

function enterEditMode() {
  state.sidePanel.editing = true;
  state.sidePanel.dirty = false;
  const ta = $("#side-panel-textarea");
  ta.value = state.sidePanel.raw;
  $("#side-panel-content").classList.add("hidden");
  $("#side-panel-editor").classList.remove("hidden");
  setEditStatus("");
  updateEditPreview();
  ta.focus();
  ta.scrollTop = ta.scrollHeight; // land at the end — the natural spot to append a comment
}

function exitEditMode(skipConfirm) {
  if (!skipConfirm && !confirmDiscardIfDirty()) return;
  state.sidePanel.editing = false;
  state.sidePanel.dirty = false;
  $("#side-panel-editor").classList.add("hidden");
  $("#side-panel-content").classList.remove("hidden");
}

function setEditStatus(text, kind) {
  const el = $("#side-panel-edit-status");
  el.textContent = text;
  el.classList.toggle("status-error", kind === "error");
  el.classList.toggle("status-ok", kind === "ok");
}

const updateEditPreviewDebounced = debounce(() => updateEditPreview(), 300);

function updateEditPreview() {
  const preview = $("#side-panel-preview");
  preview.innerHTML = md($("#side-panel-textarea").value);
  renderMermaid(preview);
}

function onEditTextareaInput() {
  state.sidePanel.dirty = true;
  setEditStatus("unsaved changes…");
  updateEditPreviewDebounced();
}

async function saveSidePanelEdit() {
  const { kind, id } = state.sidePanel;
  if (!kind || !id) return;
  const raw = $("#side-panel-textarea").value;
  const route = kind === "spec"
    ? `/api/spec?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}&spec_id=${encodeURIComponent(id)}`
    : `/api/item?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}&item_id=${encodeURIComponent(id)}`;
  setEditStatus("saving…");
  try {
    await fetchJSON(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    state.sidePanel.raw = raw;
    state.sidePanel.dirty = false;
    setEditStatus("saved", "ok");
    const contentEl = $("#side-panel-content");
    contentEl.innerHTML = md(raw);
    renderMermaid(contentEl);
    exitEditMode(true);
  } catch (e) {
    setEditStatus(`⚠ save failed: ${e.message}`, "error");
  }
}

// ── add task / add subtask modal ─────────────────────────────────────────
// Both buttons open the same modal — only the id/insertion computation
// differs (root append vs. last-child-of-a-specific-parent). Saves
// immediately on OK (not debounced/autosaved: a deliberate one-shot
// action, matching the last-selection-persistence precedent), reusing
// the existing saveTasks() as-is — the server's validate_row_ids was
// relaxed specifically so a grown row set no longer 409s.

let addTaskModalContext = null; // { mode: "root" } | { mode: "subtask", parentId }

function collectDistinctTagValues(rows) {
  const hash = new Set(), at = new Set(), plus = new Set(), user = new Set();
  rows.forEach(r => {
    (r.tags.hash || []).forEach(h => hash.add(h));
    if (r.tags.at) at.add(r.tags.at);
    (r.tags.plus || []).forEach(p => { if (p !== "urgent") plus.add(p); });
    if (r.tags.user) user.add(r.tags.user);
  });
  return { hash: [...hash].sort(), at: [...at].sort(), plus: [...plus].sort(), user: [...user].sort() };
}

function fillDatalist(selector, values) {
  $(selector).innerHTML = values.map(v => `<option value="${escapeAttr(v)}">`).join("");
}

function computeNewTaskId(context) {
  if (context.mode === "root") {
    const rootNums = state.rows
      .filter(r => !r.id.includes("."))
      .map(r => parseInt(r.id, 10))
      .filter(n => !isNaN(n));
    return String(rootNums.length ? Math.max(...rootNums) + 1 : 1);
  }
  const prefix = context.parentId + ".";
  const directChildNums = state.rows
    .filter(r => r.id.startsWith(prefix) && !r.id.slice(prefix.length).includes("."))
    .map(r => parseInt(r.id.slice(prefix.length), 10))
    .filter(n => !isNaN(n));
  return `${context.parentId}.${directChildNums.length ? Math.max(...directChildNums) + 1 : 1}`;
}

function computeInsertIndex(context) {
  if (context.mode === "root") return state.rows.length;
  const parentIdx = state.rows.findIndex(r => r.id === context.parentId);
  if (parentIdx === -1) return state.rows.length;
  const prefix = context.parentId + ".";
  let idx = parentIdx + 1;
  while (idx < state.rows.length && state.rows[idx].id.startsWith(prefix)) idx++;
  return idx;
}

function openAddTaskModal(context) {
  addTaskModalContext = context;
  $("#task-modal-heading").textContent = context.mode === "root" ? "Add Task" : `Add Subtask (under ${context.parentId})`;
  $("#task-modal-id").value = computeNewTaskId(context);
  $("#task-modal-text").value = "";
  $("#task-modal-hash").value = "";
  $("#task-modal-at").value = "";
  $("#task-modal-plus").value = "";
  $("#task-modal-user").value = "";
  $("#task-modal-urgent").checked = false;
  $("#task-modal-error").classList.add("hidden");

  const suggestions = collectDistinctTagValues(state.rows);
  fillDatalist("#task-modal-hash-list", suggestions.hash);
  fillDatalist("#task-modal-at-list", suggestions.at);
  fillDatalist("#task-modal-plus-list", suggestions.plus);
  fillDatalist("#task-modal-user-list", suggestions.user);

  $("#task-modal").classList.remove("hidden");
  $("#task-modal-text").focus();
}

function closeAddTaskModal() {
  addTaskModalContext = null;
  $("#task-modal").classList.add("hidden");
}

async function confirmAddTask() {
  const id = $("#task-modal-id").value.trim();
  const title = $("#task-modal-text").value.trim();
  const errorEl = $("#task-modal-error");
  if (!id || !title) {
    errorEl.textContent = "ID and Task text are both required.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (state.rows.some(r => r.id === id)) {
    errorEl.textContent = `ID "${id}" is already in use.`;
    errorEl.classList.remove("hidden");
    return;
  }

  const hash = $("#task-modal-hash").value.trim();
  const at = $("#task-modal-at").value.trim();
  const plus = $("#task-modal-plus").value.trim();
  const user = $("#task-modal-user").value.trim();
  const urgent = $("#task-modal-urgent").checked;

  const tags = { hash: hash ? [hash] : [], at: at || null, plus: [], user: user || null, due: null, done: null };
  if (plus) tags.plus.push(plus);
  if (urgent) tags.plus.push("urgent");
  if (!tags.plus.length) tags.plus = ["backlog"];

  const newRow = { id, title, depth: id.split(".").length, checked: false, tags_raw: "", tags };
  const insertIdx = computeInsertIndex(addTaskModalContext);
  state.rows.splice(insertIdx, 0, newRow);

  closeAddTaskModal();
  renderAll();
  await saveTasks();
}

// ── save ───────────────────────────────────────────────────────────────

async function saveTasks() {
  if (!state.projectId || !state.plan) return;
  const rows = state.rows.map(r => ({ id: r.id, title: r.title, tags: r.tags }));
  setSaveStatus("saving…");
  try {
    await fetchJSON(`/api/tasks?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    state.dirty.clear();
    $("#save-btn").disabled = true;
    setSaveStatus("saved", "ok");
    setTimeout(() => { if (state.dirty.size === 0) setSaveStatus(""); }, 1500);
  } catch (e) {
    if (e.status === 409) {
      setSaveStatus("⚠ save conflict — reload this plan and reapply your edits", "error");
    } else {
      setSaveStatus(`⚠ save failed: ${e.message}`, "error");
    }
  }
}

async function saveColors() {
  if (!state.projectId) return;
  const colors = {};
  document.querySelectorAll(".color-row").forEach(row => {
    const name = normalizeModuleName(row.querySelector(".module-name").value);
    const color = row.querySelector(".module-color").value;
    if (name) colors[name] = color;
  });
  try {
    await fetchJSON(`/api/colors?project=${encodeURIComponent(state.projectId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ colors }),
    });
    state.colors = colors;
    renderBoard();
    renderBacklog();
  } catch (e) {
    setSaveStatus(`⚠ colors save failed: ${e.message}`, "error");
  }
}

// ── wiring ─────────────────────────────────────────────────────────────

async function onProjectChange() {
  state.projectId = $("#project-select").value;
  saveLastSelection({ last_project_id: state.projectId });
  state.plan = null;
  $("#plan-select").innerHTML = '<option value="">Select plan…</option>';
  $("#plan-select").disabled = true;
  $("#browse-planmd-btn").disabled = true;
  state.rows = [];
  renderAll();
  if (!state.projectId) return;
  await loadPlans(state.projectId);
  await loadColors(state.projectId);
  renderColors();
  await loadDashboardFlow(state.projectId);
  $("#dashboard-flow-input").value = state.dashboardFlow.map(f => `+${f}`).join(", ");
}

async function onPlanChange() {
  state.plan = $("#plan-select").value;
  saveLastSelection({ last_plan: state.plan });
  if (!state.plan) {
    $("#browse-planmd-btn").disabled = true;
    return;
  }
  $("#browse-planmd-btn").disabled = false;
  await loadTasks(state.projectId, state.plan);
  await loadSpecIndex(state.projectId, state.plan);
  renderAll();
}

async function browsePlanmd() {
  if (!state.projectId || !state.plan) return;
  try {
    const tree = await fetchJSON(`/api/planmd/tree?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`);
    const lines = [];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        lines.push(`${"  ".repeat(depth)}${n.id} ${n.title}`);
        walk(n.children, depth + 1);
      }
    };
    walk(tree, 0);
    showSidePanel(`planMD/${state.plan}`, lines.join("\n") || "(no items)");
  } catch (e) {
    showSidePanel(`planMD/${state.plan}`, `Failed to load: ${e.message}`);
  }
}

async function init() {
  $("#project-select").addEventListener("change", onProjectChange);
  $("#plan-select").addEventListener("change", onPlanChange);
  $("#browse-planmd-btn").addEventListener("click", browsePlanmd);
  $("#save-btn").addEventListener("click", saveTasks);
  $("#colors-save-btn").addEventListener("click", saveColors);
  $("#colors-add-btn").addEventListener("click", () => {
    const editor = $("#colors-editor");
    const div = document.createElement("div");
    div.className = "color-row";
    div.innerHTML = colorRowHtml("", "#888888");
    editor.appendChild(div);
    wireColorRow(div);
    div.querySelector(".module-name").focus();
  });
  $("#side-panel-close").addEventListener("click", () => {
    if (!confirmDiscardIfDirty()) return;
    $("#side-panel").classList.add("hidden");
  });
  $("#side-panel-edit-btn").addEventListener("click", toggleEditMode);
  $("#side-panel-save-btn").addEventListener("click", saveSidePanelEdit);
  $("#side-panel-cancel-btn").addEventListener("click", () => exitEditMode());
  $("#side-panel-textarea").addEventListener("input", onEditTextareaInput);
  $("#dashboard-flow-input").addEventListener("change", (e) => {
    state.dashboardFlow = parseDashboardFlowInput(e.target.value);
    e.target.value = state.dashboardFlow.map(f => `+${f}`).join(", ");
    renderBoard();
    autosaveDashboardFlow();
  });
  $("#fit-width-toggle").addEventListener("change", (e) => setFitWidth(e.target.checked));
  $("#add-task-btn").addEventListener("click", () => openAddTaskModal({ mode: "root" }));
  $("#task-modal-ok").addEventListener("click", confirmAddTask);
  $("#task-modal-cancel").addEventListener("click", closeAddTaskModal);

  applyTheme(state.theme);
  applyFitWidth();
  loadThemes();
  await loadProjects();
  await restoreLastSelection();
}

document.addEventListener("DOMContentLoaded", init);
