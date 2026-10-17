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
  view: "tasks", // "tasks" | "plan" | "settings" — source of truth for the
                 // active view-tab, not the DOM (querySelector(".active")
                 // is unreliable under the JS test harness's permissive stub)
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

  // Step 3b — links [text](url): relative paths, http(s), and the in-app "src:" (a glossary
  // source); any other scheme (javascript:, data:) stays text
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s"'<>]+)\)/g, (m, label, url) => {
    if (/^https?:/i.test(url)) return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    if (/^src:/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url)) return `<a href="${url}" data-local-link>${label}</a>`;
    return m;
  });

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
      return `<${tag} class="katex-wrap${mb.display ? " katex-display-wrap" : ""}" data-tex="${encoded}">${html}<button class="katex-copy" onclick="copyKatexSrc(this)" title="${t("copy_latex")}">&#128203;</button></${tag}>`;
    } catch { return escHtml(mb.tex); }
  });

  // Step 10 — insert mermaid placeholders (rendered async after innerHTML)
  s = s.replace(/\x00MM(\d+)\x00/g, (_, i) => {
    const raw = mermaidBlocks[+i];
    const encoded = raw.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return `<div class="mermaid-wrap"><button class="mermaid-copy" onclick="copyMermaidSrc(this)" title="${t("copy_source")}">&#128203;</button><pre class="mermaid" data-src="${encoded}">${escHtml(raw)}</pre></div>`;
  });

  // Step 11 — restore SOURCE: provenance lines as clickable item links
  s = s.replace(/\x00SR(\d+)\x00/g, (_, i) => {
    const ref = sourceRefs[+i];
    return `<a class="source-link" onclick="openItemPanel('${ref.itemId}')" title="${t("open_source_item", { id: ref.itemId })}">SOURCE: item_${ref.itemId}.md #${ref.sec}</a> `
      + `<button type="button" class="source-jump-btn" onclick="focusPlanNode('${ref.itemId}')" title="${t("jump_plan_title")}">${t("jump_plan")}</button>`;
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
  let localLang = "";
  try { localLang = localStorage.getItem("alkonost-lang") || ""; } catch (e) { /* ignore */ }
  if (!localLang && cfg.lang && I18N[cfg.lang] && cfg.lang !== state.lang) setLang(cfg.lang);

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
  renderProjectSelect();
}

function renderProjectSelect() {
  const sel = $("#project-select");
  const keep = sel.value;
  sel.innerHTML = `<option value="">${t("select_project_opt")}</option>` +
    state.projects.map(p => `<option value="${p.id}">${p.name} (${p.plan_count})</option>`).join("");
  if (keep) sel.value = keep;
  renderNoProjectsBanner();
}

// ── making a folder a project ─────────────────────────────────────────────
// A project is any folder holding .1bcoder/ (discovery.py) — there is no registry, so
// "a new project" = an empty .1bcoder/ created in a folder under the scan root. With no
// project at all, every tab only said "select a project first"; the banner says why.

const projectModal = { path: "", listing: null };

function projectPathInto(path, name) {
  return path ? `${path}/${name}` : name;
}

function projectPathUp(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

async function renderNoProjectsBanner() {
  const banner = $("#no-projects-banner");
  if (!banner) return;
  banner.classList.toggle("hidden", state.projects.length > 0);
  if (state.projects.length > 0) return;
  let root = "";
  try { root = (await fetchJSON("/api/projects/folders")).root || ""; } catch (e) { /* the text works without it */ }
  $("#no-projects-text").innerHTML = t("np_none", { root: escHtml(root) });
}

async function openProjectModal() {
  $("#project-modal-error").classList.add("hidden");
  $("#project-modal").classList.remove("hidden");
  await loadProjectFolders(projectModal.path);
}

function closeProjectModal() {
  $("#project-modal").classList.add("hidden");
}

async function loadProjectFolders(path) {
  const err = $("#project-modal-error");
  try {
    projectModal.listing = await fetchJSON(`/api/projects/folders?path=${encodeURIComponent(path)}`);
    projectModal.path = projectModal.listing.path;
    err.classList.add("hidden");
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove("hidden");
    if (path) return loadProjectFolders("");          // a folder that vanished: back to the root
    return;
  }
  renderProjectFolders();
}

function renderProjectFolders() {
  const l = projectModal.listing;
  const sep = /\\/.test(l.root) ? "\\" : "/";
  $("#project-modal-path").textContent = l.path ? `${l.root}${sep}${l.path.split("/").join(sep)}` : l.root;
  const items = [];
  if (l.path) items.push(`<li><button type="button" class="np-folder" data-up="1">⬑ ..</button></li>`);
  for (const f of l.folders) {
    const mark = f.is_project ? ` <span class="np-mark">${escHtml(t("np_is_project"))}</span>` : "";
    items.push(l.can_descend
      ? `<li><button type="button" class="np-folder" data-name="${escHtml(f.name)}">📁 ${escHtml(f.name)}</button>${mark}</li>`
      : `<li class="hint">📁 ${escHtml(f.name)}${mark}</li>`);
  }
  if (!l.folders.length) items.push(`<li class="hint">${escHtml(t("np_no_folders"))}</li>`);
  const ul = $("#project-modal-folders");
  ul.innerHTML = items.join("");
  ul.querySelectorAll("button.np-folder").forEach(b => b.addEventListener("click", () =>
    loadProjectFolders(b.dataset.up ? projectPathUp(l.path) : projectPathInto(l.path, b.dataset.name))));
  $("#project-modal-ok").textContent = l.is_project ? t("np_open") : t("np_ok");
}

async function confirmProjectModal() {
  const err = $("#project-modal-error");
  let res;
  try {
    res = await fetchJSON("/api/projects/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectModal.path }),
    });
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove("hidden");
    return;
  }
  closeProjectModal();
  await loadProjects();
  $("#project-select").value = res.id;
  await onProjectChange();
}

async function loadPlans(projectId) {
  state.plans = await fetchJSON(`/api/plans?project=${encodeURIComponent(projectId)}`);
  renderPlanSelect();
}

function renderPlanSelect() {
  const sel = $("#plan-select");
  const keep = sel.value;
  sel.disabled = state.plans.length === 0 || !state.projectId;
  sel.innerHTML = `<option value="">${t("select_plan_opt")}</option>` +
    (state.projectId ? state.plans : []).map(p => {
      const label = `${p.name}${p.has_tasks ? ` (${p.task_count})` : t("no_tasks_yet")}`;
      return `<option value="${p.name}">${label}</option>`;
    }).join("");
  if (keep) sel.value = keep;
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
    setSaveStatus(t("flow_save_failed", { msg: e.message }), "error");
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
      <div class="card-id"><span class="drag-handle" title="${t("drag_to_move")}">&#8942;&#8942;</span>${row.id}${isUrgent(row) ? `<span class="urgent-badge">${t("urgent")}</span>` : ""} ${navLinks(row)}</div>
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
  return `<select class="lane-select" data-id="${row.id}" title="${t("move_to_lane")}">${options}</select>`;
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
        <h3><span class="drop-marker" title="${escapeAttr(t("drop_into", { lane }))}">&#8942;&#8942;</span>${lane} (${laneRows.length})</h3>
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
    const urgentBadge = isUrgent(row) ? `<span class="urgent-badge">${t("urgent")}</span>` : "";
    return `
      <tr class="${rowClasses}" data-id="${row.id}">
        <td>${row.id}</td>
        <td><input class="title-input" data-id="${row.id}" value="${escapeAttr(row.title)}">${urgentBadge}</td>
        <td><input class="tag-input" data-id="${row.id}" data-field="tags_raw" value="${escapeAttr(serializeTagsClient(row.tags))}"></td>
        <td>${navLinks(row)} ${laneSelectHtml(row, lanes)}</td>
        <td><button class="add-subtask-btn" data-parent-id="${row.id}" title="${t("add_subtask_title")}">${t("add_subtask_btn")}</button></td>
      </tr>`;
  }).join("");
  wireCardEvents(body);
}

function navLinks(row) {
  if (hasSpec(row)) {
    return `<a class="spec-link" data-nav-spec="${row.id}" title="${t("spec_link_title")}">${t("spec_link")}</a>`;
  }
  return `<button class="add-spec-btn" data-add-spec="${row.id}" title="${t("add_spec_title")}">${t("add_spec_btn")}</button>`;
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
  setSaveStatus(t("unsaved"));
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
  return confirm(t("discard_confirm"));
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
    link.textContent = t("source_item", { id: sourceItemId });
    link.href = "javascript:void(0)";
    link.addEventListener("click", () => openItemPanel(sourceItemId));
    crumb.appendChild(link);
  }
  const contentEl = $("#side-panel-content");
  contentEl.innerHTML = md(content);
  renderMermaid(contentEl);
  $("#side-panel").classList.remove("hidden");
}

// ── side panel width: dragged by its left edge, remembered per browser ──────
const SIDE_PANEL_MIN = 320;

// the width the drawer may take: not narrower than SIDE_PANEL_MIN, not wider than 92% of the window
function clampPanelWidth(w, viewport) {
  return Math.round(Math.max(SIDE_PANEL_MIN, Math.min(w, viewport * 0.92)));
}

function setPanelWidth(w) {
  const panel = $("#side-panel");
  if (w) panel.style.setProperty("--side-panel-w", `${clampPanelWidth(w, window.innerWidth)}px`);
  else panel.style.removeProperty("--side-panel-w");
}

function initPanelResizer() {
  const panel = $("#side-panel");
  const handle = $("#side-panel-resizer");
  try { setPanelWidth(+localStorage.getItem("alkonost-side-panel-w") || 0); } catch (e) { /* ignore */ }
  const save = (w) => { try { localStorage.setItem("alkonost-side-panel-w", String(w || "")); } catch (e) { /* ignore */ } };
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    panel.classList.add("resizing");
    const move = (ev) => setPanelWidth(window.innerWidth - ev.clientX);
    const up = (ev) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      panel.classList.remove("resizing");
      save(clampPanelWidth(window.innerWidth - ev.clientX, window.innerWidth));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  handle.addEventListener("dblclick", () => { setPanelWidth(0); save(0); });
}

async function openSpecPanel(rowId) {
  try {
    const data = await fetchJSON(`/api/spec?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}&spec_id=${encodeURIComponent(rowId)}`);
    showSidePanel(`spec ${data.spec_id}`, data.raw, data.source_leaf_id, { kind: "spec", id: data.spec_id });
  } catch (e) {
    showSidePanel(`spec ${rowId}`, t("no_spec"));
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
    alert(t("create_spec_failed", { msg: e.message }));
  }
}

async function openItemPanel(itemId) {
  try {
    const data = await fetchJSON(`/api/item?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}&item_id=${encodeURIComponent(itemId)}`);
    showSidePanel(`item ${data.id}`, data.raw, null, { kind: "item", id: data.id });
  } catch (e) {
    showSidePanel(`item ${itemId}`, t("item_not_found"));
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
  setEditStatus(t("unsaved"));
  updateEditPreviewDebounced();
}

async function saveSidePanelEdit() {
  const { kind, id } = state.sidePanel;
  if (!kind || !id) return;
  const raw = $("#side-panel-textarea").value;
  const route = kind === "spec"
    ? `/api/spec?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}&spec_id=${encodeURIComponent(id)}`
    : `/api/item?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}&item_id=${encodeURIComponent(id)}`;
  setEditStatus(t("saving"));
  try {
    await fetchJSON(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    state.sidePanel.raw = raw;
    state.sidePanel.dirty = false;
    setEditStatus(t("saved"), "ok");
    const contentEl = $("#side-panel-content");
    contentEl.innerHTML = md(raw);
    renderMermaid(contentEl);
    exitEditMode(true);
  } catch (e) {
    setEditStatus(t("save_failed", { msg: e.message }), "error");
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
  $("#task-modal-heading").textContent = context.mode === "root" ? t("add_task") : t("add_subtask_under", { id: context.parentId });
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
    errorEl.textContent = t("id_required");
    errorEl.classList.remove("hidden");
    return;
  }
  if (state.rows.some(r => r.id === id)) {
    errorEl.textContent = t("id_in_use", { id });
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
  setSaveStatus(t("saving"));
  try {
    await fetchJSON(`/api/tasks?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    state.dirty.clear();
    $("#save-btn").disabled = true;
    setSaveStatus(t("saved"), "ok");
    setTimeout(() => { if (state.dirty.size === 0) setSaveStatus(""); }, 1500);
  } catch (e) {
    if (e.status === 409) {
      setSaveStatus(t("save_conflict"), "error");
    } else {
      setSaveStatus(t("save_failed", { msg: e.message }), "error");
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
    setSaveStatus(t("colors_save_failed", { msg: e.message }), "error");
  }
}

// ── wiring ─────────────────────────────────────────────────────────────

// ── manual refresh (⟳ button, top bar) ───────────────────────────────────
// Re-scans the filesystem for projects/plans (discovery.discover_projects
// is re-run fresh on every /api/projects call anyway — no caching to
// invalidate server-side) and, unlike a raw page reload, tries to keep
// whatever project/plan was already selected instead of dropping back to
// "Select project…".

async function refreshProjectsAndPlans() {
  const prevProjectId = state.projectId;
  const prevPlan = state.plan;

  await loadProjects();

  if (prevProjectId && state.projects.some(p => p.id === prevProjectId)) {
    $("#project-select").value = prevProjectId;
    await onProjectChange();
    if (prevPlan && state.plans.some(p => p.name === prevPlan)) {
      $("#plan-select").value = prevPlan;
      await onPlanChange();
    }
  } else {
    $("#project-select").value = "";
    await onProjectChange();
  }
}

async function onProjectChange() {
  state.projectId = $("#project-select").value;
  saveLastSelection({ last_project_id: state.projectId });
  state.plan = null;
  $("#plan-select").innerHTML = `<option value="">${t("select_plan_opt")}</option>`;
  $("#plan-select").disabled = true;
  $("#browse-planmd-btn").disabled = true;
  state.rows = [];
  renderAll();
  if (currentView() === "files") refreshFiles();
  glossaryState.name = "";                         // a glossary name belongs to its project
  if (currentView() === "glossary") refreshGlossaryView();
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
  if (currentView() === "plan") refreshPlanView();
  if (currentView() === "radogast") refreshRadogastView();
  if (currentView() === "axis") refreshAxisView();
  if (currentView() === "spec") refreshSpecView();
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
    showSidePanel(`planMD/${state.plan}`, lines.join("\n") || t("no_items"));
  } catch (e) {
    showSidePanel(`planMD/${state.plan}`, t("load_failed", { msg: e.message }));
  }
}

// ── view tabs (Init / Plan / Axis / Spec / Tasks / Settings) ────────────
// Follows the actual deepagent_* pipeline order (concepts/ALKONOST_ADVANCE.md):
// Init generates a fresh plan and shows its progress; Plan is where an
// EXISTING plan gets read, edited, and has individual elements regenerated
// (kept as two separate views on request — generation/progress vs.
// read/edit/redo are different modes of attention). Axis and Spec are new
// per-stage screens; Tasks is the original board/backlog/colors, unchanged.

const VIEW_ELS = {
  init: "#init-view", plan: "#plan-view", radogast: "#radogast-view", axis: "#axis-view",
  spec: "#spec-view", tasks: "#main", settings: "#settings-view",
  files: "#files-view", glossary: "#glossary-view",
};

function switchView(view) {
  state.view = view;
  for (const [name, sel] of Object.entries(VIEW_ELS)) {
    $(sel).classList.toggle("hidden", name !== view);
  }
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  if (view === "plan") refreshPlanView();
  if (view === "radogast") refreshRadogastView();
  if (view === "axis") refreshAxisView();
  if (view === "spec") refreshSpecView();
  if (view === "settings") loadSettings();
  if (view === "files") refreshFiles();
  if (view === "glossary") refreshGlossaryView();
}

function currentView() {
  return state.view;
}

// ── shared log streaming (Init / Plan / Axis / Spec all reuse this) ─────
// One-way, server-reads-a-file (see runner.py) — never IPC into the
// launched 1bcoder process itself (concepts/ALKONOST_ADVANCE.md §3.2).
// `prefix` selects which view's log elements to update, so a launch
// triggered from any tab shows its own progress in place rather than
// forcing a tab switch.

const _logSources = {};
const _spinnerTimers = {};
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatElapsedHMS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function _stopSpinner(prefix) {
  if (_spinnerTimers[prefix]) {
    clearInterval(_spinnerTimers[prefix]);
    _spinnerTimers[prefix] = null;
  }
}

function _startSpinner(prefix) {
  _stopSpinner(prefix);
  const el = $(`#${prefix}-log-status`);
  const startedAt = Date.now();
  let frame = 0;
  const tick = () => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    el.textContent = t("running_s", { spin: SPINNER_FRAMES[frame % SPINNER_FRAMES.length], s: elapsed, hms: formatElapsedHMS(elapsed) });
    frame++;
  };
  tick();
  _spinnerTimers[prefix] = setInterval(tick, 300);
}

function _setBusy(btn, busy) {
  if (!btn) return;
  if (busy) {
    btn.disabled = true;
    btn.dataset._label = btn.dataset._label || btn.textContent;
    btn.textContent = `${btn.dataset._label}…`;
  } else {
    btn.disabled = false;
    if (btn.dataset._label) btn.textContent = btn.dataset._label;
  }
}

const _currentLaunchIds = {};

async function stopLaunch(prefix) {
  const launchId = _currentLaunchIds[prefix];
  if (!launchId) return;
  if (!confirm(t("stop_confirm"))) return;
  try {
    await fetchJSON("/api/launch/stop", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ launch_id: launchId }),
    });
    // the SSE stream itself reports the resulting "stopped" status and
    // tidies up spinner/button state — no need to duplicate that here
  } catch (e) {
    alert(t("stop_failed", { msg: e.message }));
  }
}

// Axis has THREE separate buttons (Index this plan / Generate axis-plan /
// Compose via LLM) that all launch into the same "axis" log slot —
// _setBusy(btn, ...) below only disables whichever one was clicked, so
// without this a second button could still fire a genuinely concurrent
// 1bcoder process while the first is still running (confirmed possible:
// clicking Compose then immediately clicking Generate axis-plan starts a
// second subprocess, and streamLog's own EventSource-replace above would
// silently drop the view of the first one, though it keeps running).
const _BUSY_GROUP_BTNS = {
  axis: ["#axis-rag-index-btn", "#axis-generate-btn", "#axis-compose-btn", "#axis-flow-help-btn"],
  // Per-node "redo" buttons in the tree are dynamic (one per node) and not
  // covered here, but the two static ones sharing this same "plan" log
  // slot are — continueLayer() and resumePlan() are different operations
  // on the same plan_dir and must not run concurrently.
  plan: ["#plan-continue-btn", "#plan-resume-btn"],
  radogast: ["#radogast-derive-index-btn", "#radogast-derive-full-btn", "#radogast-save-target-btn", "#radogast-help-btn", "#radogast-analyze-btn"],
  // Per-node "redo" buttons in the spec list are dynamic and not covered
  // here, but the static ones sharing this same "spec" log slot are.
  spec: ["#spec-flow-help-btn", "#spec-generate-btn", "#spec-task-btn"],
  // building the glossary and building its search index both run 1bcoder over the same folder
  glossary: ["#glossary-flow-help-btn", "#glossary-build-btn", "#glossary-rag-btn", "#glossary-relink-btn",
             "#glossary-html-btn", "#glossary-contents-btn", "#glossary-cmd-btn"],
};

function _setGroupBusy(prefix, activeBtn, busy) {
  const ids = _BUSY_GROUP_BTNS[prefix];
  if (!ids) return;
  for (const sel of ids) {
    const el = $(sel);
    if (el && el !== activeBtn) el.disabled = busy;
  }
}

function streamLog(launchId, prefix, onDone, btn, noTruncate, restoring) {
  if (_logSources[prefix]) _logSources[prefix].close();
  const pre = $(`#${prefix}-log`);
  pre.textContent = "";
  const section = $(`#${prefix}-log-section`);
  section.classList.remove("hidden");
  _currentLaunchIds[prefix] = launchId;
  // Persisted so a page reload can reconnect to whatever this view was
  // last watching instead of just losing it — the log FILE was never
  // gone (runner.py writes it to disk regardless), only the browser's
  // in-memory EventSource/launch_id reference was. Survives as long as
  // the Alkonost server process itself doesn't restart (its own
  // in-memory _PROCESSES map is a separate, smaller limitation — see
  // runner.py's own docstring on that).
  try { localStorage.setItem(`alkonost-launch-${prefix}`, launchId); } catch (e) { /* ignore */ }
  const stopBtn = $(`#${prefix}-stop-btn`);
  if (stopBtn) stopBtn.disabled = false;
  // Two things happen right where the user is looking, not just at the
  // bottom of a possibly-long page: the button that was clicked disables
  // itself (so "did my click register" is answered instantly, without
  // risk of double-firing), and the log section scrolls into view. Skipped
  // when silently reconnecting after a page reload — jumping the page on
  // load, for a launch the user didn't just trigger, would be jarring.
  _setBusy(btn, true);
  _setGroupBusy(prefix, btn, true);
  if (!restoring) section.scrollIntoView({ behavior: "smooth", block: "nearest" });
  // Visible immediately, independent of whether/when the launched process
  // actually writes anything — a Python subprocess block-buffers its own
  // stdout when it isn't a real terminal, so relying on the first log line
  // to prove "something is happening" left the UI looking dead for however
  // long that buffer takes to flush (fixed on the backend too, but this
  // indicator no longer depends on that being right).
  _startSpinner(prefix);
  const lines = [];
  // A live generation genuinely needs bounding (it could run for a long
  // time) — a `--help` dump is finite and short, and trimming its START
  // is actively wrong (that's exactly where "Usage:"/"Core flags:" live).
  const MAX_LINES = noTruncate ? Infinity : 100;
  const src = new EventSource(`/api/plan/log/${encodeURIComponent(launchId)}`);
  _logSources[prefix] = src;
  src.onmessage = (ev) => {
    lines.push(ev.data);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    pre.textContent = lines.join("\n");
    pre.scrollTop = pre.scrollHeight;
  };
  src.addEventListener("status", (ev) => {
    _stopSpinner(prefix);
    _setBusy(btn, false);
    _setGroupBusy(prefix, btn, false);
    if (stopBtn) stopBtn.disabled = true;
    _currentLaunchIds[prefix] = null;
    $(`#${prefix}-log-status`).textContent = ev.data;
    src.close();
    _logSources[prefix] = null;
    if (onDone) onDone(ev.data);
  });
  src.onerror = () => {
    _stopSpinner(prefix);
    _setBusy(btn, false);
    _setGroupBusy(prefix, btn, false);
    if (stopBtn) stopBtn.disabled = true;
    _currentLaunchIds[prefix] = null;
    $(`#${prefix}-log-status`).textContent = t("disconnected");
    if (_logSources[prefix]) { _logSources[prefix].close(); _logSources[prefix] = null; }
  };
}

// Reconnects any log a view was still watching before a page reload —
// the log FILE and the server's own launch-status tracking survive a
// browser refresh untouched, so this just re-opens the SSE stream against
// whatever launch_id was last recorded. Works whether that launch is
// still running (picks the live stream back up) or already finished
// (server replays the full file, then immediately sends the terminal
// status) — either way beats the log just vanishing. Does NOT survive
// an Alkonost *server* restart, since status() then has no record of the
// launch_id at all and reports "unknown".
function restoreLogs() {
  const onDoneByPrefix = {
    init: null,
    plan: (status) => { if (status === "done") renderPlanTree(); },
    radogast: null,
    axis: (status) => { if (status === "done") loadAxisRagProjects(); },
    spec: (status) => { if (status === "done") renderSpecList(); },
    glossary: () => refreshGlossaryView(),
  };
  ["init", "plan", "radogast", "axis", "spec", "glossary"].forEach(prefix => {
    let launchId;
    try { launchId = localStorage.getItem(`alkonost-launch-${prefix}`); } catch (e) { return; }
    if (!launchId) return;
    streamLog(launchId, prefix, onDoneByPrefix[prefix], null, false, true);
  });
}

// ── flow help (1bcoder's own built-in `/flow help <name>` — AST-parses
// the flow module's docstring, no new discovery logic needed here) ──────

async function showFlowHelp(flow, prefix, btn) {
  if (!state.projectId) { alert(t("need_project")); return; }
  try {
    const { launch_id } = await fetchJSON(`/api/flow_help?project=${encodeURIComponent(state.projectId)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flow }),
    });
    streamLog(launch_id, prefix, null, btn, true);
  } catch (e) {
    alert(t("help_failed", { msg: e.message }));
  }
}

// ── INIT view — generate a brand new plan ────────────────────────────────

async function generatePlan() {
  if (!state.projectId) { alert(t("need_project")); return; }
  const task = $("#plan-task-input").value.trim();
  if (!task) { alert(t("need_task")); return; }
  const flow = $("#plan-flow-select").value;
  const mode = $("#plan-mode-select").value;
  const maxdepth = mode === "layer1" ? 1 : (parseInt($("#plan-maxdepth-input").value, 10) || 1);
  const extra = $("#plan-extra-input").value.trim();
  try {
    const { launch_id } = await fetchJSON(`/api/plan/generate?project=${encodeURIComponent(state.projectId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flow, task, maxdepth, extra }),
    });
    streamLog(launch_id, "init", null, $("#plan-generate-btn"));
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

// ── PLAN view — read/edit an existing plan, regenerate elements ─────────

async function refreshPlanView() {
  const hasPlan = !!(state.projectId && state.plan);
  $("#plan-tree-section").classList.toggle("hidden", !hasPlan);
  $("#plan-engine-picker").classList.add("hidden");
  if (!hasPlan) {
    $("#plan-tree-container").innerHTML = "";
    return;
  }
  let engine = "";
  try {
    ({ engine } = await fetchJSON(`/api/plan/engine?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`));
  } catch (e) { /* treat as unset */ }
  await renderPlanTree();
  if (!engine) {
    // Only worth asking once the plan actually has content — an empty,
    // just-launched plan doesn't need this yet (the Init tab's log covers that).
    const tree = await fetchJSON(`/api/planmd/tree?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`).catch(() => []);
    if (tree.length) $("#plan-engine-picker").classList.remove("hidden");
  }
}

function planNodeHtml(node) {
  const kids = node.children.map(planNodeHtml).join("");
  return `
    <li>
      <div class="plan-node-row" data-id="${escapeAttr(node.id)}">
        <span class="plan-node-open">${escHtml(node.id)} — ${escHtml(node.title)}</span>
        <button class="plan-node-redo" data-id="${escapeAttr(node.id)}" title="${t("redo_node_title")}">${t("redo")}</button>
      </div>
      ${kids ? `<ul>${kids}</ul>` : ""}
    </li>`;
}

async function renderPlanTree() {
  const container = $("#plan-tree-container");
  try {
    const tree = await fetchJSON(`/api/planmd/tree?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`);
    container.innerHTML = tree.length ? `<ul>${tree.map(planNodeHtml).join("")}</ul>` : `<p class="hint">${t("no_items_yet")}</p>`;
    container.querySelectorAll(".plan-node-open").forEach(el => {
      el.addEventListener("click", () => openItemPanel(el.closest(".plan-node-row").dataset.id));
    });
    container.querySelectorAll(".plan-node-redo").forEach(el => {
      el.addEventListener("click", (e) => { e.stopPropagation(); redoNode(el.dataset.id, el); });
    });
  } catch (e) {
    container.innerHTML = `<p class="hint">${escHtml(t("load_failed", { msg: e.message }))}</p>`;
  }
}

// Dotted node id -> every ancestor id from the root down to itself,
// inclusive — e.g. "1.2.3" -> ["1", "1.2", "1.2.3"]. Pure/DOM-free so it's
// unit-testable; the wider-context highlighting in focusPlanNode() below
// is what actually makes "which broader idea did this leaf grow out of"
// visible without the caller having to trace indentation by eye.
function ancestorChain(itemId) {
  const parts = String(itemId).split(".");
  return parts.map((_, i) => parts.slice(0, i + 1).join("."));
}

// Jumps to the Plan tab and highlights the FULL ancestor chain down to
// the given item, not just the item itself — a spec unit's own SOURCE
// link already shows which item it came from, but seeing just that one
// leaf loses the broader idea it grew out of. The chain stays highlighted
// briefly so scrolling up from the (strongly highlighted) target reveals
// a visibly connected path back to the root.
async function focusPlanNode(itemId) {
  switchView("plan");
  await refreshPlanView();
  const container = $("#plan-tree-container");
  const chain = ancestorChain(itemId);
  const rows = chain.map(id => container.querySelector(`.plan-node-row[data-id="${escapeAttr(id)}"]`));
  rows.forEach((row, i) => {
    if (!row) return;
    row.classList.add(i === rows.length - 1 ? "plan-node-focus" : "plan-node-ancestor");
  });
  const target = rows[rows.length - 1];
  if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => {
    rows.forEach(row => row && row.classList.remove("plan-node-focus", "plan-node-ancestor"));
  }, 4000);
}

// 1bcoder's own `continue` (deepagent_tree_md.py etc.) splits this label
// on commas and adds ONE layer per segment in a single call
// (target_depth = leaf_depth + len(new_labels)) — a real, documented
// 1bcoder feature (its own usage string shows `plan: <label>[, ...]`),
// but nothing in this UI hinted at it before. Confirmed live: typing
// "modules, files, classes, methods" (4 segments) silently added 4 new
// layers in one click instead of the expected 1.
function planContinueLayerCount() {
  const raw = $("#plan-continue-label-input").value;
  return raw.split(",").map(s => s.trim()).filter(Boolean).length || 1;
}

function updatePlanContinueHint() {
  const hint = $("#plan-continue-hint");
  if (hint) hint.innerHTML = t("continue_hint", { n: planContinueLayerCount() });
}

async function continueLayer() {
  if (!state.projectId || !state.plan) return;
  const label = $("#plan-continue-label-input").value.trim();
  if (!label) { alert(t("need_label")); return; }
  const layerCount = planContinueLayerCount();
  if (layerCount > 1 && !confirm(t("continue_confirm", { n: layerCount }))) return;
  try {
    const { launch_id } = await fetchJSON(
      `/api/plan/continue?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) });
    streamLog(launch_id, "plan", (status) => { if (status === "done") renderPlanTree(); }, $("#plan-continue-btn"));
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

// Finishes this plan's ORIGINAL generation if it was Stopped partway
// through — distinct from continueLayer() above, which grows an
// already-complete tree with a brand new layer. Uses 1bcoder's own
// `resume <plan_dir>` (deepagent_md/tree/tree_md), which re-enters the
// same index-generate + expand loop toward the maxdepth already recorded
// in _deepagent_meta.yaml; _expand's own skip-if-file-exists check fills
// in only what's missing.
async function resumePlan() {
  if (!state.projectId || !state.plan) return;
  try {
    const { launch_id } = await fetchJSON(
      `/api/plan/resume?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    streamLog(launch_id, "plan", (status) => { if (status === "done") renderPlanTree(); }, $("#plan-resume-btn"));
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

// Reads this plan's original _deepagent_meta.yaml (task/maxdepth/engine)
// and prefills the Init tab's generation form with it, WITHOUT clicking
// Generate — the whole point is to let the user review/edit the task and,
// typically, pick a different (larger/more technical) model in Settings
// before regenerating from scratch. See "Create new plan based on this"
// in the plan for the motivating case: a good plan from a small model,
// worth re-running through a bigger one for more concrete detail.
async function createPlanFromSource() {
  if (!state.projectId || !state.plan) return;
  let params;
  try {
    params = await fetchJSON(
      `/api/plan/source_params?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`);
  } catch (e) {
    alert(t("source_params_failed", { msg: e.message }));
    return;
  }
  switchView("init");
  if (params.flow) $("#plan-flow-select").value = params.flow;
  $("#plan-task-input").value = params.task || "";
  $("#plan-maxdepth-input").value = params.maxdepth || 1;
  $("#plan-extra-input").value = params.extra || "";
  $("#plan-mode-select").value = "full";
}

// ── RADOGAST view — own dedicated page (key terms, out-of-scope, and the
// similarity threshold are all editable here now, not baked-in defaults
// the way the very first version of this button worked). Not a 1bcoder/
// model call at all — radogast is a separate, deterministic (embeddings +
// term-matching) CLI tool with no --host/--model of its own; see
// launch_radogast_plan_analysis's own docstring for why it still goes
// through the same log-streaming plumbing every 1bcoder launch uses.

function splitCommaList(raw) {
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

async function refreshRadogastView() {
  if (!state.projectId || !state.plan) return;
  $("#radogast-target-status").textContent = "";
  try {
    const data = await fetchJSON(`/api/radogast/target?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`);
    $("#radogast-goal-input").value = data.goal || "";
    $("#radogast-keyterms-input").value = (data.key_terms || []).join(", ");
    $("#radogast-oos-input").value = (data.out_of_scope || []).join(", ");
  } catch (e) {
    // no existing target yet for this plan — leave the form empty rather
    // than surfacing this as an error state.
  }
}

// scope "index" — quick, reads only index.md's full content.
// scope "full" — thorough but slower, reads index.md plus every
// item_*.md in the tree (planmd.full_text), so a term only mentioned
// deep in one branch still counts, not just whatever's in the overview.
async function deriveRadogastTarget(scope, btn) {
  if (!state.projectId || !state.plan) { alert(t("need_project_plan")); return; }
  _setBusy(btn, true);
  try {
    const data = await fetchJSON(
      `/api/radogast/derive?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope }) });
    $("#radogast-goal-input").value = data.goal || "";
    $("#radogast-keyterms-input").value = (data.key_terms || []).join(", ");
  } catch (e) {
    alert(t("derive_failed", { msg: e.message }));
  } finally {
    _setBusy(btn, false);
  }
}

async function saveRadogastTarget() {
  if (!state.projectId || !state.plan) { alert(t("need_project_plan")); return; }
  const body = {
    goal: $("#radogast-goal-input").value.trim(),
    key_terms: splitCommaList($("#radogast-keyterms-input").value),
    out_of_scope: splitCommaList($("#radogast-oos-input").value),
  };
  const status = $("#radogast-target-status");
  try {
    await fetchJSON(`/api/radogast/target?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    status.textContent = t("saved");
    status.className = "dirty-indicator status-ok";
  } catch (e) {
    status.textContent = t("save_failed_plain", { msg: e.message });
    status.className = "dirty-indicator status-error";
  }
}

async function analyzeWithRadogast() {
  if (!state.projectId || !state.plan) { alert(t("need_project_plan")); return; }
  const btn = $("#radogast-analyze-btn");
  const threshold = parseFloat($("#radogast-threshold-input").value);
  const body = {
    threshold: Number.isFinite(threshold) ? threshold : 0.85,
    show_all: $("#radogast-show-all-checkbox").checked,
  };
  try {
    const { launch_id } = await fetchJSON(
      `/api/radogast/analyze?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    streamLog(launch_id, "radogast", null, btn, true);
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

async function showRadogastHelp() {
  if (!state.projectId) { alert(t("need_project")); return; }
  const btn = $("#radogast-help-btn");
  try {
    const { launch_id } = await fetchJSON(`/api/radogast/help?project=${encodeURIComponent(state.projectId)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    streamLog(launch_id, "radogast", null, btn, true);
  } catch (e) {
    alert(t("help_failed", { msg: e.message }));
  }
}

// Both redo flavors regenerate a node/unit FROM one specific numbered
// section of one specific item_*.md file — deepagent_tree_md's own redo
// re-reads the PARENT's "## N." section via _extract_parent_section;
// deepagent_spec's own redo re-reads the originating leaf item's "## N."
// section the same way. Neither reruns from "what you meant to change" —
// only from whatever text is currently saved there, so telling the user
// exactly which file+section that is (not just "the parent", which they'd
// still have to work out by hand) is the whole point of the confirm
// dialog below.
function redoParentRef(kind, id) {
  if (kind === "spec") {
    const lastDot = id.lastIndexOf(".");
    return { file: `item_${id.slice(0, lastDot)}.md`, section: id.slice(lastDot + 1) };
  }
  const parts = id.split(".");
  if (parts.length === 1) return { file: "index.md", section: parts[0] };
  return { file: `item_${parts.slice(0, -1).join(".")}.md`, section: parts[parts.length - 1] };
}

// Promise-based confirm — a plain confirm() can't show which file/section
// to check first, and a modal fits this codebase's existing pattern
// (#task-modal) better than a second native dialog flavor.
function confirmRedo(detailHtml) {
  return new Promise((resolve) => {
    $("#redo-confirm-detail").innerHTML = detailHtml;
    $("#redo-confirm-modal").classList.remove("hidden");
    const yesBtn = $("#redo-confirm-yes");
    const cancelBtn = $("#redo-confirm-cancel");
    const cleanup = (result) => {
      $("#redo-confirm-modal").classList.add("hidden");
      yesBtn.removeEventListener("click", onYes);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onCancel = () => cleanup(false);
    yesBtn.addEventListener("click", onYes);
    cancelBtn.addEventListener("click", onCancel);
  });
}

async function redoNode(nodeId, btn) {
  if (!state.projectId || !state.plan) return;
  const ref = redoParentRef("plan", nodeId);
  const ok = await confirmRedo(t("redo_node_detail", { id: escHtml(nodeId), file: escHtml(ref.file), sec: escHtml(ref.section) }));
  if (!ok) return;
  try {
    const { launch_id } = await fetchJSON(
      `/api/plan/redo?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ node_id: nodeId }) });
    streamLog(launch_id, "plan", (status) => { if (status === "done") renderPlanTree(); }, btn);
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

async function savePlanEngineSetup() {
  if (!state.projectId || !state.plan) return;
  const engine = $("#plan-engine-select").value;
  const qs = `project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`;
  try {
    await fetchJSON(`/api/plan/engine?${qs}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ engine }),
    });
    $("#plan-engine-picker").classList.add("hidden");
  } catch (e) {
    alert(t("save_failed_plain", { msg: e.message }));
  }
}

// ── AXIS view — RAG-grounded axis-plan generation (ALKONOST_ADVANCE.md §2) ─

function fillSelect(sel, values, placeholder) {
  sel.innerHTML = (placeholder ? `<option value="">${escHtml(placeholder)}</option>` : "") +
    values.map(v => `<option value="${escapeAttr(v)}">${escHtml(v)}</option>`).join("");
}

async function refreshAxisView() {
  if (!state.projectId) return;
  fillSelect($("#axis-source-plan-select"), state.plans.map(p => p.name), "");
  if (state.plan) $("#axis-source-plan-select").value = state.plan;
  await loadAxisRagProjects();
}

async function loadAxisRagProjects() {
  const source = $("#axis-source-plan-select").value;
  const sel = $("#axis-rag-project-select");
  if (!source) { fillSelect(sel, [], t("ax_pick_source_first")); return; }
  try {
    const { projects } = await fetchJSON(
      `/api/plan/rag_projects?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(source)}`);
    fillSelect(sel, projects, projects.length ? "" : t("ax_none_indexed"));
  } catch (e) {
    fillSelect(sel, [], t("ax_failed_load"));
  }
  if (!$("#axis-rag-name-input").value.trim() && source) {
    $("#axis-rag-name-input").value = `${source}_rag`;
  }
}

async function indexAxisRag() {
  const source = $("#axis-source-plan-select").value;
  if (!source) { alert(t("ax_pick_source")); return; }
  const name = $("#axis-rag-name-input").value.trim() || `${source}_rag`;
  try {
    const { launch_id } = await fetchJSON(
      `/api/plan/rag_index?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(source)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    streamLog(launch_id, "axis", (status) => { if (status === "done") loadAxisRagProjects(); }, $("#axis-rag-index-btn"));
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

async function seedAxisTask() {
  const source = $("#axis-source-plan-select").value;
  if (!source) { alert(t("ax_pick_source")); return; }
  try {
    const { task } = await fetchJSON(`/api/plan/task?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(source)}`);
    if (!task) { alert(t("ax_no_index")); return; }
    // Raw task text, verbatim — no axis instruction appended. What
    // decomposition axis a given task actually needs can't be guessed
    // here; either the user edits this field by hand, or uses "Compose
    // via LLM" below to have 1bcoder rewrite it toward a stated axis.
    $("#axis-task-input").value = task;
  } catch (e) {
    alert(t("load_failed", { msg: e.message }));
  }
}

// Pulls just the content of the LAST non-empty fenced code block out of a
// model's reply, falling back to the full trimmed text if it never fenced
// anything usable. Line-based (find every FENCE-MARKER line first, then
// pair them up 1st/2nd, 3rd/4th, ...) rather than one greedy regex — three
// things had to be true at once to get this right, each confirmed live
// rather than assumed:
//
// 1. A fence delimiter must be ALONE on its own line (standard Markdown
//    fence syntax), not just "```" appearing anywhere in running text.
//    Our own axis_compose instruction told the model to answer "wrapped
//    in a single ``` fenced code block" — a reasoning model then quoted
//    that instruction back verbatim inside its own "Thinking Process"
//    prose, and an unanchored regex (1bcoder's own `_extract_code_block`
//    in chat.py, used by /save_code, included) treated that mid-sentence
//    "```" as an opening fence.
// 2. LAST rather than first: a reasoning model's think/draft phase can
//    itself contain a genuine, line-anchored fence (an example it sketches
//    before committing to a final answer), so even with (1) fixed, taking
//    the FIRST real fence can still grab a draft instead of the model's
//    actual final answer.
// 3. Pairing fence-marker LINES (not one greedy regex capture) matters
//    once a degenerate model repeats several bare ``` lines back to back
//    with nothing between them: a single non-greedy regex ends up
//    treating one of those malformed marker lines as if it were CONTENT
//    (it has to consume something to find its next valid closing
//    delimiter), producing garbage like a lone "```" as the "last
//    non-empty" match instead of correctly falling through past all of
//    them to the real answer above. Pairing whole lines up front sidesteps
//    that entirely.
function extractFence(text) {
  const lines = text.split("\n");
  const fenceLines = [];
  lines.forEach((line, i) => { if (/^[ \t]*```/.test(line)) fenceLines.push(i); });
  const blocks = [];
  for (let i = 0; i + 1 < fenceLines.length; i += 2) {
    blocks.push(lines.slice(fenceLines[i] + 1, fenceLines[i + 1]).join("\n").trim());
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]) return blocks[i];
  }
  return text.trim();
}

async function composeAxisTask() {
  if (!state.projectId) { alert(t("need_project")); return; }
  const task = $("#axis-task-input").value.trim();
  if (!task) { alert(t("ax_task_empty")); return; }
  const axis = $("#axis-description-input").value.trim();
  if (!axis) { alert(t("ax_need_axis")); return; }
  const btn = $("#axis-compose-btn");
  try {
    const { launch_id } = await fetchJSON(`/api/axis/compose?project=${encodeURIComponent(state.projectId)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task, axis }),
    });
    // noTruncate=true: this is a single finite reply, not a long-running
    // generation — trimming from the front (the 100-line live-log cap)
    // would risk cutting off the start of the composed prompt.
    streamLog(launch_id, "axis", (status) => {
      if (status === "done") $("#axis-task-input").value = extractFence($("#axis-log").textContent);
    }, btn, true);
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

async function generateAxisPlan() {
  if (!state.projectId) { alert(t("need_project")); return; }
  const task = $("#axis-task-input").value.trim();
  if (!task) { alert(t("ax_need_task")); return; }
  const flow = $("#axis-flow-select").value;
  const maxdepth = parseInt($("#axis-maxdepth-input").value, 10) || 1;
  const extra = $("#axis-extra-input").value.trim();
  const body = { flow, task, maxdepth, extra };
  if ($("#axis-rag-use-checkbox").checked) {
    const source = $("#axis-source-plan-select").value;
    const ragName = $("#axis-rag-project-select").value;
    if (!source || !ragName) { alert(t("ax_need_rag")); return; }
    body.rag_name = ragName;
    body.rag_source_plan = source;
  }
  try {
    const { launch_id } = await fetchJSON(`/api/plan/generate?project=${encodeURIComponent(state.projectId)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    streamLog(launch_id, "axis", null, $("#axis-generate-btn"));
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

// ── SPEC view — deepagent_spec over the currently selected plan ─────────

async function refreshSpecView() {
  if (!state.projectId || !state.plan) {
    $("#spec-list-container").innerHTML = `<p class="hint">${t("sp_select_plan")}</p>`;
    return;
  }
  await renderSpecList();
}

function specNodeHtml(id) {
  return `
    <li>
      <div class="plan-node-row" data-id="${escapeAttr(id)}">
        <span class="plan-node-open">spec_${escHtml(id)}.md</span>
        <button class="plan-node-redo" data-id="${escapeAttr(id)}" title="${t("sp_redo_title")}">${t("redo")}</button>
      </div>
    </li>`;
}

async function renderSpecList() {
  const container = $("#spec-list-container");
  try {
    const { spec_ids } = await fetchJSON(
      `/api/spec_index?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`);
    container.innerHTML = spec_ids.length
      ? `<ul>${spec_ids.map(specNodeHtml).join("")}</ul>`
      : `<p class="hint">${t("sp_none_yet")}</p>`;
    container.querySelectorAll(".plan-node-open").forEach(el => {
      el.addEventListener("click", () => openSpecPanel(el.closest(".plan-node-row").dataset.id));
    });
    container.querySelectorAll(".plan-node-redo").forEach(el => {
      el.addEventListener("click", (e) => { e.stopPropagation(); redoSpecUnit(el.dataset.id, el); });
    });
  } catch (e) {
    container.innerHTML = `<p class="hint">${escHtml(t("load_failed", { msg: e.message }))}</p>`;
  }
}

async function generateSpec() {
  if (!state.projectId || !state.plan) { alert(t("need_project_plan")); return; }
  const body = {
    focus: $("#spec-focus-input").value.trim(),
    ctx: parseInt($("#spec-ctx-input").value, 10) || 0,
    profile: $("#spec-profile-input").value.trim(),
    predictable: $("#spec-predictable-checkbox").checked,
    extra: $("#spec-extra-input").value.trim(),
  };
  try {
    const { launch_id } = await fetchJSON(
      `/api/spec/generate?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    streamLog(launch_id, "spec", (status) => { if (status === "done") renderSpecList(); }, $("#spec-generate-btn"));
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

// deepagent_task itself makes no LLM call — a deterministic rollup of
// this plan's tree + spec units into tasks.md. Lives on the Spec page
// (generation-oriented) rather than Tasks (implementation/board-oriented)
// to match the existing generate+log+stop pattern Init/Axis/Spec already
// share — Tasks stays a pure viewer/editor with no launch plumbing.
async function generateTasksFromSpec() {
  if (!state.projectId || !state.plan) { alert(t("need_project_plan")); return; }
  const btn = $("#spec-task-btn");
  try {
    const { launch_id } = await fetchJSON(
      `/api/task/generate?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    streamLog(launch_id, "spec", async (status) => {
      if (status === "done") {
        await loadTasks(state.projectId, state.plan);
        renderAll();
      }
    }, btn);
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

async function redoSpecUnit(unitId, btn) {
  if (!state.projectId || !state.plan) return;
  const ref = redoParentRef("spec", unitId);
  const ok = await confirmRedo(t("redo_spec_detail", { id: escHtml(unitId), file: escHtml(ref.file), sec: escHtml(ref.section) }));
  if (!ok) return;
  try {
    const { launch_id } = await fetchJSON(
      `/api/spec/redo?project=${encodeURIComponent(state.projectId)}&plan=${encodeURIComponent(state.plan)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unit_id: unitId }) });
    streamLog(launch_id, "spec", (status) => { if (status === "done") renderSpecList(); }, btn);
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

// ── SETTINGS view ─────────────────────────────────────────────────────────

async function loadSettings() {
  const scope = $("#settings-scope-select").value;
  if (scope === "project" && !state.projectId) {
    $("#settings-scope-select").value = "global";
  }
  const effectiveScope = $("#settings-scope-select").value;
  const qs = effectiveScope === "project" ? `scope=project&project=${encodeURIComponent(state.projectId)}` : "scope=global";
  try {
    const cfg = await fetchJSON(`/api/settings/1bcoder?${qs}`);
    $("#settings-host-input").value = cfg.host || "";
    $("#settings-model-input").value = cfg.model || "";
    $("#settings-ctx-input").value = cfg.ctx || "";
    $("#settings-timeout-input").value = cfg.params.timeout || "";
    $("#settings-run-timeout-input").value = cfg.params.run_timeout || "";
    settingsOtherKeys = Object.keys(cfg.params).filter(k => !SETTINGS_OWN_PARAMS.includes(k));
    $("#settings-params-input").value = formatOtherParams(cfg.params);
    setSettingsStatus("");
  } catch (e) {
    setSettingsStatus(t("load_failed", { msg: e.message }), "err");
  }
}

// "Other params": every config.yml param except the two with their own inputs, as one
// `key=value, key=value` row (think=false, temperature=0.2…). Every launch carries them
// as /param lines (runner.session_lines) — 1bcoder reads no config.yml under --scriptapply.
const SETTINGS_OWN_PARAMS = ["timeout", "run_timeout"];
let settingsOtherKeys = [];

function formatOtherParams(params) {
  return Object.entries(params || {})
    .filter(([k]) => !SETTINGS_OWN_PARAMS.includes(k))
    .map(([k, v]) => `${k}=${v}`).join(", ");
}

function parseOtherParams(text) {
  const out = {};
  for (const part of (text || "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf("=");
    const k = i < 0 ? "" : p.slice(0, i).trim();
    const v = i < 0 ? "" : p.slice(i + 1).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(k) || !v) throw new Error(t("st_params_bad", { part: p }));
    if (SETTINGS_OWN_PARAMS.includes(k)) continue;              // they have their own inputs
    out[k] = v;
  }
  return out;
}

function setSettingsStatus(text, kind) {
  const el = $("#settings-save-status");
  el.textContent = text;
  el.className = "dirty-indicator" + (kind === "err" ? " error" : "");
}

async function saveSettings() {
  const scope = $("#settings-scope-select").value;
  if (scope === "project" && !state.projectId) { alert(t("st_need_project")); return; }
  const qs = scope === "project" ? `scope=project&project=${encodeURIComponent(state.projectId)}` : "scope=global";
  let other;
  try {
    other = parseOtherParams($("#settings-params-input").value);
  } catch (e) {
    setSettingsStatus(e.message, "err");
    return;
  }
  const params = {};
  for (const k of settingsOtherKeys) params[k] = "";          // removed from the row: dropped on save
  Object.assign(params, other, {
    timeout: $("#settings-timeout-input").value.trim(),
    run_timeout: $("#settings-run-timeout-input").value.trim(),
  });
  const patch = {
    host: $("#settings-host-input").value.trim(),
    model: $("#settings-model-input").value.trim(),
    ctx: $("#settings-ctx-input").value.trim(),
    params,
  };
  try {
    await fetchJSON(`/api/settings/1bcoder?${qs}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    setSettingsStatus(t("saved"));
  } catch (e) {
    setSettingsStatus(t("save_failed_plain", { msg: e.message }), "err");
  }
}

// ── GLOSSARY view — 1bcoder's /flow glossary: launch, browse, search ─────
// Launches go through runner.py (the model from Settings); the articles are
// read by the server (glossary.py); the search is simargl over the
// glossary's own store. The filters and the article text are pure functions
// (filterGlossaryRows / glossaryArticleMd) so the JS tests can reach them.

const glossaryState = { list: [], name: "", rows: [], shown: 0 };

function filterGlossaryRows(rows, f) {
  const q = (f.text || "").trim().toLowerCase().replace(/\s+/g, "-");
  const minSeen = Number(f.minSeen) || 0;
  const out = rows.filter(r =>
    (!q || r.term.includes(q)) &&
    (!f.kind || (f.kind === "unjudged" ? !r.kind : r.kind === f.kind)) &&
    r.seen >= minSeen &&
    (!f.multiword || r.words > 1));
  const by = {
    seen: (a, b) => b.seen - a.seen || a.term.localeCompare(b.term),
    facts: (a, b) => b.facts - a.facts || b.seen - a.seen || a.term.localeCompare(b.term),
    name: (a, b) => a.term.localeCompare(b.term),
  }[f.sort] || ((a, b) => a.term.localeCompare(b.term));
  return out.sort(by);
}

// "docs/a.md:12" -> a markdown link the article panel opens in place (openGlossarySource)
function glossarySourceLink(ref) {
  ref = (ref || "").trim();
  return `[${ref.replace(/[\[\]]/g, "")}](src:${ref.replace(/[\s()]/g, encodeURIComponent)})`;
}

// "[file: docs/a.md:12]" at the end of an entry -> a link to the source
function glossaryEntryMd(entry) {
  const m = /^(.*?)\s*\[file:\s*([^\]]*)\]\s*$/.exec(entry || "");
  return m ? `${m[1]} ${glossarySourceLink(m[2])}` : (entry || "");
}

function glossaryArticleMd(a) {
  const term = a.term || "";
  const lines = [`# ${term.replace(/-/g, " ")}`, ""];
  if (a.kind_verdict) lines.push(`*${t("gl_kind_verdict", { kind: a.kind_verdict })}*`, "");
  const list = (key, title, fmt) => {
    const items = a[key] || [];
    if (!items.length) return;
    lines.push(`## ${t(title)}`, "");
    items.forEach(x => lines.push(`- ${fmt ? fmt(x) : glossaryEntryMd(x)}`));
    lines.push("");
  };
  list("definition", "gl_sec_definition");
  list("facts", "gl_sec_facts");
  list("link", "gl_sec_links", x => `[${x}](${x}.md)`);
  list("synonym", "gl_sec_synonyms", x => `[${x}](${x}.md)`);
  list("kind", "gl_sec_kind");
  list("seen", "gl_sec_seen", x => /^file:/.test(x) ? glossarySourceLink(x.replace(/^file:\s*/, "")) : x);
  list("history", "gl_sec_history");
  return lines.join("\n");
}

function glossaryApi(path, name) {
  let url = `/api/glossary/${path}?project=${encodeURIComponent(state.projectId)}`;
  if (name !== undefined) url += `&name=${encodeURIComponent(name)}`;
  return url;
}

async function refreshGlossaryView() {
  const sel = $("#glossary-select");
  if (!state.projectId) {
    glossaryState.list = []; glossaryState.rows = [];
    fillSelect(sel, [], t("select_project"));
    renderGlossaryTable();
    return;
  }
  try {
    glossaryState.list = (await fetchJSON(glossaryApi("list"))).glossaries;
  } catch (e) {
    glossaryState.list = [];
  }
  const names = glossaryState.list.map(g => g.name);
  fillSelect(sel, names, names.length ? "" : t("gl_none"));
  $("#glossary-name-list").innerHTML = names.map(n => `<option value="${escapeAttr(n)}">`).join("");
  let want = glossaryState.name;
  try { want = want || localStorage.getItem(`alkonost-glossary-${state.projectId}`) || ""; } catch (e) { /* ignore */ }
  if (!names.includes(want)) want = names[0] || "";
  sel.value = want;
  if (want && !$("#glossary-name-input").value.trim()) $("#glossary-name-input").value = want;
  await selectGlossary(want);
}

async function selectGlossary(name) {
  glossaryState.name = name || "";
  glossaryState.rows = [];
  try { if (name) localStorage.setItem(`alkonost-glossary-${state.projectId}`, name); } catch (e) { /* ignore */ }
  if (name) {
    try {
      glossaryState.rows = (await fetchJSON(glossaryApi("terms", name))).terms;
    } catch (e) {
      glossaryState.rows = [];
    }
  }
  $("#glossary-results").innerHTML = "";
  renderGlossaryTable();
}

function glossaryFilters() {
  return {
    text: $("#glossary-filter-input").value, kind: $("#glossary-kind-select").value,
    minSeen: $("#glossary-min-seen-input").value, multiword: $("#glossary-multiword-checkbox").checked,
    sort: $("#glossary-sort-select").value,
  };
}

function renderGlossaryTable() {
  const tbody = $("#glossary-tbody");
  if (!tbody) return;
  const rows = filterGlossaryRows(glossaryState.rows, glossaryFilters());
  glossaryState.shown = rows.length;
  if (!glossaryState.rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="hint">${escHtml(state.projectId ? t("gl_none") : t("select_project"))}</td></tr>`;
  } else if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="hint">${escHtml(t("gl_empty_filter"))}</td></tr>`;
  } else {
    // a long glossary is thousands of rows: the first 1000 after filtering are plenty to scan
    tbody.innerHTML = rows.slice(0, 1000).map(r => `<tr data-term="${escapeAttr(r.term)}">
      <td><a href="javascript:void(0)" class="gl-term">${escHtml(r.term.replace(/-/g, " "))}</a></td>
      <td>${r.kind ? `<span class="gl-kind gl-kind-${escapeAttr(r.kind)}">${escHtml(r.kind)}</span>` : ""}</td>
      <td class="num">${r.seen}</td><td class="num">${r.definitions}</td>
      <td class="num">${r.facts}</td><td class="num">${r.links}</td></tr>`).join("");
    tbody.querySelectorAll("tr[data-term]").forEach(tr =>
      tr.querySelector(".gl-term").addEventListener("click", () => openGlossaryTerm(tr.dataset.term)));
  }
  renderGlossarySummary();
}

function renderGlossarySummary() {
  const g = glossaryState.list.find(x => x.name === glossaryState.name);
  $("#glossary-summary").textContent = g
    ? t("gl_summary", { shown: glossaryState.shown, total: glossaryState.rows.length, files: g.files_read }) : "";
  $("#glossary-index-status").textContent = g ? t(g.indexed ? "gl_indexed" : "gl_not_indexed") : "";
}

// the article panel's own links: <term>.md (LINK:/SYNONYM:) opens that article, src:<path:line>
// its source — both in the panel, never by navigating away
function wireGlossaryPanel(term) {
  $("#side-panel-content").querySelectorAll("a[href]").forEach(link => {
    const href = link.getAttribute("href");
    if (/^src:/.test(href)) {
      link.addEventListener("click", (e) => { e.preventDefault(); openGlossarySource(decodeURIComponent(href.slice(4)), term); });
    } else if (/^[^:/]+\.md$/.test(href)) {
      link.addEventListener("click", (e) => { e.preventDefault(); openGlossaryTerm(href.replace(/\.md$/, "")); });
    }
  });
}

async function openGlossaryTerm(term) {
  if (!glossaryState.name) return;
  try {
    const a = await fetchJSON(`${glossaryApi("term", glossaryState.name)}&term=${encodeURIComponent(term)}`);
    showSidePanel(`glossary ${glossaryState.name} › ${term}`, glossaryArticleMd(a), null, null);
    wireGlossaryPanel(term);
  } catch (e) {
    alert(t("error_prefix") + e.message);
  }
}

// "docs/a.md:12" -> {path: "docs/a.md", line: 12}; no line -> 0
function parseSourceRef(ref) {
  const m = /^(.*?)(?::(\d+))?$/.exec((ref || "").trim());
  return { path: m[1], line: m[2] ? +m[2] : 0 };
}

// the lines around `line`, numbered, the line itself marked — a markdown code block for the panel
function sourceExcerptMd(content, line, before = 12, after = 28) {
  const lines = (content || "").split(/\r?\n/);
  const from = line ? Math.max(1, line - before) : 1;
  const to = Math.min(lines.length, line ? line + after : before + after + 1);
  const width = String(to).length;
  const out = [];
  for (let n = from; n <= to; n++) {
    out.push(`${n === line ? "▶" : " "} ${String(n).padStart(width)} │ ${lines[n - 1].replace(/```/g, "'".repeat(3))}`);
  }
  return "```\n" + out.join("\n") + "\n```";
}

async function openGlossarySource(ref, term) {
  const { path, line } = parseSourceRef(ref);
  try {
    const data = await fetchJSON(`/api/files/read?project=${encodeURIComponent(state.projectId)}&path=${encodeURIComponent(path)}`);
    const body = [`[← ${term.replace(/-/g, " ")}](${term}.md)`, "", `## ${path}${line ? ":" + line : ""}`, "",
                  sourceExcerptMd(data.content, line)].join("\n");
    showSidePanel(`glossary ${glossaryState.name} › ${term} › ${path}`, body, null, null);
    wireGlossaryPanel(term);
  } catch (e) {
    alert(t("gl_source_missing", { path, msg: e.message }));
  }
}

// relink / html / contents / find / extract / show / filter — 1bcoder's other /flow glossary commands
async function runGlossaryCommand(cmd, args, btn) {
  if (!glossaryState.name) { alert(t("gl_pick_glossary")); return; }
  const body = { cmd, args: args || "", synonyms: cmd === "relink" && $("#glossary-synonyms-checkbox").checked };
  try {
    const { launch_id } = await fetchJSON(glossaryApi("run", glossaryState.name), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    streamLog(launch_id, "glossary", () => selectGlossary(glossaryState.name), btn);
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

async function buildGlossary() {
  if (!state.projectId) { alert(t("need_project")); return; }
  const name = $("#glossary-name-input").value.trim();
  const source = $("#glossary-source-input").value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) { alert(t("gl_need_name")); return; }
  if (!source) { alert(t("gl_need_source")); return; }
  const body = {
    name, source,
    terms_only: $("#glossary-terms-only-checkbox").checked, crosslink: $("#glossary-crosslink-checkbox").checked,
    all: $("#glossary-all-checkbox").checked, prune: $("#glossary-prune-checkbox").checked,
    jev: $("#glossary-jev-checkbox").checked,
    jev_model: $("#glossary-jev-model-input").value.trim(), jev_host: $("#glossary-jev-host-input").value.trim(),
    extra: $("#glossary-extra-input").value.trim(),
  };
  try {
    const { launch_id } = await fetchJSON(glossaryApi("index"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    glossaryState.name = name;
    streamLog(launch_id, "glossary", () => refreshGlossaryView(), $("#glossary-build-btn"));
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

async function indexGlossaryRag() {
  if (!glossaryState.name) { alert(t("gl_pick_glossary")); return; }
  try {
    const { launch_id } = await fetchJSON(glossaryApi("rag_index", glossaryState.name), { method: "POST" });
    streamLog(launch_id, "glossary", () => refreshGlossaryView(), $("#glossary-rag-btn"));
  } catch (e) {
    alert(t("launch_failed", { msg: e.message }));
  }
}

async function searchGlossary() {
  const box = $("#glossary-results");
  const q = $("#glossary-query-input").value.trim();
  if (!glossaryState.name) { alert(t("gl_pick_glossary")); return; }
  if (!q) return;
  const btn = $("#glossary-search-btn");
  _setBusy(btn, true);
  try {
    const { results } = await fetchJSON(`${glossaryApi("search", glossaryState.name)}&q=${encodeURIComponent(q)}`);
    const byTerm = Object.fromEntries(glossaryState.rows.map(r => [r.term, r]));
    box.innerHTML = results.length ? results.map(r => {
      const row = byTerm[r.term];
      return `<div class="gl-hit" data-term="${escapeAttr(r.term)}"><span class="gl-score">${r.score.toFixed(3)}</span>
        <a href="javascript:void(0)">${escHtml(r.term.replace(/-/g, " "))}</a>
        ${row && row.kind ? `<span class="gl-kind gl-kind-${escapeAttr(row.kind)}">${escHtml(row.kind)}</span>` : ""}
        ${row ? `<span class="hint">SEEN ${row.seen}</span>` : ""}</div>`;
    }).join("") : `<p class="hint">${escHtml(t("gl_no_results"))}</p>`;
    box.querySelectorAll(".gl-hit").forEach(div =>
      div.querySelector("a").addEventListener("click", () => openGlossaryTerm(div.dataset.term)));
  } catch (e) {
    box.innerHTML = `<p class="hint">${escHtml(t("error_prefix") + e.message)}</p>`;
  } finally {
    _setBusy(btn, false);
  }
}

// ── i18n ─────────────────────────────────────────────────────────────────
// Structured like vyrii's own I18N/t()/applyLang() (data-i18n / data-i18n-ph
// attributes, one flat string table per language), with the same six
// languages. English lives here, so app.js alone (and the JS test harness,
// which loads only this file) always has every string; the other languages
// come from ui/lang/<code>.js, loaded before app.js into ALK_LANGS. Only the
// interface's own strings are translated — task titles, plan items, tags,
// file names, logs and server messages are data and stay as they are.
const LANGS = [["en", "EN — English"], ["uk", "UK — Українська"], ["de", "DE — Deutsch"],
               ["fr", "FR — Français"], ["es", "ES — Español"], ["pt", "PT — Português"]];
const I18N = {
  en: {
    // files view (the first strings, from the stub)
    tab_files: "Files", refresh: "Refresh", new_folder: "New folder", upload: "Upload",
    create: "Create", cancel: "Cancel", loading: "Loading…",
    select_project: "Select a project first", select_file: "Select a file or folder",
    view: "View", delete_btn: "Delete", mkdir_ph: "folder/name",
    error_prefix: "Error: ", api_error: "API error",
    files_hint: "Browses the currently selected project's own root directory — pick a project in the top bar first.",
    fi_type: "Type", fi_path: "Path", fi_directory: "directory", fi_file: "file",
    file_empty: "(empty)", file_truncated: "⚠ File truncated at 64 KB", confirm_delete: "Delete: {path}?",

    // sidebar
    tagline: "deepagent_* cockpit",
    nav_init: "Init", nav_plan: "Plan", nav_radogast: "Radogast", nav_axis: "Axis", nav_spec: "Spec",
    nav_tasks: "Tasks", nav_settings: "Settings", nav_glossary: "Glossary",

    // top bar
    refresh_btn: "⟳ Refresh", refresh_title: "Re-scan for projects/plans on disk",
    select_project_opt: "Select project…", select_plan_opt: "Select plan…", no_tasks_yet: " — no tasks yet",
    browse_planmd: "Browse planMD", browse_planmd_title: "Browse raw planMD tree for this plan",
    theme_title: "Theme", lang_title: "Language", save_changes: "Save Changes",

    // tasks view
    empty_state: "No tasks.md yet for this plan — run <code>deepagent_task</code> and refresh.",
    dashboard: "Dashboard",
    dashboard_flow_title: "Comma-separated lane statuses to show on the dashboard board below. Tasks in other statuses (e.g. +backlog, +complete, +canceled, +closed) are hidden here and stay visible only in the Backlog table.",
    fit_title: "Shrink columns so every lane fits the screen width, instead of scrolling left/right",
    fit_label: "Fit to screen",
    backlog: "Backlog", add_task_btn: "+ Add Task",
    th_id: "ID", th_title: "Title", th_tags: "Tags",
    module_colors: "Module Colors", add_module: "+ Add module", save_colors: "Save Colors",
    tag_reference: "Tag reference",
    tag_ref_intro: "Every task row is <code>[ ] &lt;plan&gt;-&lt;id&gt;. &lt;title&gt; #tag @module +flag %user due:YYYY-MM-DD _done:YYYY-MM-DD</code> — any number of these, in any order, after the title.",
    th_prefix: "Prefix", th_meaning: "Meaning", th_example: "Example",
    tag_hash: "Classification — any number of these",
    tag_at: "Single grouping tag — drives card color via the Module Colors legend above",
    tag_plus: "Status/priority — any number of these, open-ended",
    tag_user: "Assignee", tag_due: "Deadline",
    tag_done: "Completion date — a non-empty value marks the row <code>[x]</code>",
    tag_ref_note: "<code>%</code> was chosen for assignee (over <code>!</code>/<code>$</code>/<code>&amp;</code>/<code>=</code>) specifically to avoid colliding with markdown image syntax (<code>![</code>) and with KaTeX math delimiters (<code>$...$</code>), both already in use elsewhere in this codebase.",
    drag_to_move: "Drag to move", urgent: "URGENT", move_to_lane: "Move to lane",
    drop_into: "Drop a card here to move it into {lane}",
    add_subtask_btn: "+ Add SubTask", add_subtask_title: "Add a subtask under this row",
    spec_link: "spec", spec_link_title: "View spec for this task",
    add_spec_btn: "+ Add spec", add_spec_title: "Create a new spec for this task",
    unsaved: "unsaved changes…", saving: "saving…", saved: "saved",
    save_conflict: "⚠ save conflict — reload this plan and reapply your edits",
    save_failed: "⚠ save failed: {msg}", colors_save_failed: "⚠ colors save failed: {msg}",
    flow_save_failed: "⚠ dashboard flow save failed: {msg}",

    // side panel
    edit_raw_title: "Edit raw markdown", save: "Save", preview: "Preview",
    discard_confirm: "Discard unsaved changes to this file?",
    source_item: "→ source item {id}",
    no_spec: "No spec found for this row yet.", item_not_found: "Item not found.",
    create_spec_failed: "Failed to create spec: {msg}",
    copy_latex: "Copy LaTeX", copy_source: "Copy source",
    open_source_item: "Open source item_{id}.md", jump_plan_title: "Open on the Plan tab and scroll to this item", jump_plan: "→ Plan",
    no_items: "(no items)",

    // add task modal
    add_task: "Add Task", add_subtask_under: "Add Subtask (under {id})",
    modal_task: "Task", modal_task_ph: "Task description", ok: "OK",
    id_required: "ID and Task text are both required.", id_in_use: "ID \"{id}\" is already in use.",

    // logs, launches
    log: "Log", stop: "🛑 Stop", stop_title: "Kill this launch immediately",
    running_s: "{spin} running… {s}s ({hms})", disconnected: "disconnected",
    stop_confirm: "Kill this launch immediately? Whatever it was writing stops mid-way.",
    stop_failed: "Failed to stop: {msg}", help_failed: "Failed to load help: {msg}",
    launch_failed: "Failed to launch: {msg}", load_failed: "Failed to load: {msg}",
    save_failed_plain: "Failed to save: {msg}", derive_failed: "Failed to derive: {msg}",
    need_project: "Select a project first.", need_project_plan: "Select a project and plan first.",
    need_task: "Task is required.",
    help_btn: "❓ Help", flow_help_title: "Show this flow's own usage/flags (via 1bcoder's built-in /flow help)",

    // init
    gen_new_plan: "Generate a new plan", flow: "Flow",
    flow_tree_md: "deepagent_tree_md — structured backlog, full-paragraph detail per item",
    flow_tree: "deepagent_tree — structured backlog, terse/compact items",
    flow_md: "deepagent_md — prose document, sections free to revisit themes",
    flow_hint: "Pick the genre, not just the verbosity. <code>deepagent_md</code> writes <strong>prose to read</strong> — an essay free to revisit a theme, where a section doesn't have to equal the sum of its subsections. <code>deepagent_tree</code>/<code>deepagent_tree_md</code> write a <strong>structure to build from</strong> — every branch owns a disjoint slice, siblings stay the same size/kind of thing, nothing restates an ancestor or reaches below its own level; the two differ only in how much text lands under each heading (one disciplined sentence vs. a full paragraph), not in that discipline. Pick prose for something meant to be read end-to-end; pick a tree when the output will be cut into tickets/specs afterward. See <code>concepts/DEEPAGENT_TREE.md</code> for the full contract and measured failure modes.",
    task: "Task", plan_task_ph: "Describe the task to expand into a plan…",
    mode: "Mode", mode_full: "Full (one-shot, set it running and walk away)",
    mode_layer1: "Layer-by-layer (depth 1 first, edit, then \"generate next layer\" on the Plan tab)",
    max_depth_full: "Max depth (full mode only)", extra_flags: "Extra flags",
    extra_flags_hint: "(anything not covered above — passed through as-is, e.g. <code>--web 3 --profile phones</code>)",
    generate: "Generate",
    init_after: "Once a plan exists, switch to the <strong>Plan</strong> tab (top bar plan-select) to read it, edit items, or regenerate individual elements.",

    // plan
    engine_setup_t: "This plan needs a one-time setup",
    engine_setup_hint: "Alkonost can't tell which <code>deepagent_*</code> engine generated this plan (they all write the same file shapes) — pick it once so <code>redo</code>/\"generate next layer\" know which flow to call.",
    engine: "Engine", plan_tree: "Plan tree",
    continue_ph: "new level label, e.g. 'implementation details'",
    continue_title: "Comma-separated labels add that many layers in ONE call, e.g. 'modules, files, classes, methods' adds 4 layers at once",
    continue_btn: "Generate next layer",
    resume_btn: "▶️ Resume", resume_title: "Finish this plan's ORIGINAL generation if it was Stopped partway through (not for adding a new layer — that's the button on the left)",
    new_from_source_btn: "🔁 Create new plan based on this",
    new_from_source_title: "Reads this plan's original task/maxdepth and prefills the Init tab, so you can regenerate the same task from scratch — e.g. through a bigger/more technical model set in Settings",
    continue_hint: "Will add <strong>{n}</strong> layer(s). Comma-separated labels add more than one LAYER in a single call — e.g. \"modules, files, classes, methods\" adds 4 layers at once.",
    redo: "redo", redo_node_title: "Wipe this node's subtree and regenerate it — hand-edit its parent's numbered section first",
    no_items_yet: "No items generated yet.",
    need_label: "Give the new layer a label first.",
    continue_confirm: "This label has {n} comma-separated parts, which will add {n} layers in this single call (1bcoder's own \"continue\" behavior), not just one. Continue?",
    source_params_failed: "Failed to read source plan's parameters: {msg}",
    redo_before: "Before you redo this",
    redo_note: "The system only regenerates from what's currently saved on disk — if the change you want isn't in that section yet, redoing now will just reproduce the old content. Save your edit there first, then redo.",
    redo_yes: "Yes, regenerate",
    redo_node_detail: "<strong>{id}</strong> and its whole subtree will be backed up (not deleted) and regenerated from scratch, based on <code>{file}</code>'s own \"## {sec}.\" section. Did you already edit that section with what you want this branch to reflect?",
    redo_spec_detail: "Spec unit <strong>{id}</strong> will be backed up (not deleted) and regenerated from scratch, based on <code>{file}</code>'s own \"## {sec}.\" section. Did you already edit that section with what you want this spec to reflect?",

    // radogast
    rg_target: "Target (key terms & scope)",
    rg_derive_index: "↺ Derive from index.md", rg_derive_index_title: "Quick — reads only index.md's full content",
    rg_derive_full: "↺ Derive from whole planMD", rg_derive_full_title: "Thorough but slower — reads index.md plus every item_*.md in the tree, so a term only mentioned deep in one branch still counts",
    rg_hint: "Radogast checks this plan's tree against a target: which key terms should eventually be covered somewhere, and which topics are out of scope (shouldn't get reinvented). Nothing here has to be right on the first try — derive a starting point, edit it, save, then analyze.",
    rg_goal: "Goal", rg_goal_ph: "one-sentence description of what this plan should cover",
    rg_keyterms: "Key terms", rg_keyterms_hint: "(comma-separated — concepts/modules/technologies that should be covered somewhere)",
    rg_oos: "Out of scope", rg_oos_hint: "(comma-separated — topics that shouldn't be reinvented/elaborated)",
    rg_save_target: "Save target", rg_analyze_t: "Analyze", rg_help_title: "Show radogast plan analyze's own usage/flags",
    rg_threshold: "Similarity threshold", rg_threshold_hint: "(cosine similarity ≥ this counts as a duplicate)",
    rg_show_all: "Show all nodes (not just flagged ones)", rg_analyze_btn: "🔍 Analyze",

    // axis
    ax_rag_t: "RAG grounding (optional)",
    ax_rag_hint: "Indexes a research plan's own files with simargl, so the axis-plan's generation can pull in relevant chunks from it via 1bcoder's existing <code>--rag</code>/<code>--rag-store</code> flags. This is plain semantic file search, not deduplication.",
    ax_source_plan: "Source research plan", ax_index_btn: "Index this plan", ax_use_rag: "Use RAG",
    ax_none_indexed: "(none indexed yet)", ax_refresh: "⟳ refresh", ax_refresh_title: "Refresh indexed-project list",
    ax_pick_source_first: "(pick a source plan first)", ax_failed_load: "(failed to load)",
    ax_generate_t: "Generate axis-plan", ax_seed_btn: "Seed task from source plan's root task",
    ax_desc_ph: "layers/areas to cover, e.g. Frontend (Kotlin/Android), Backend (Java Spring Boot), Database (PostgreSQL)",
    ax_compose_btn: "🪄 Compose via LLM",
    ax_compose_title: "Ask the LLM to compose a task prompt below: decomposed by implementation units (modules/files/classes/methods), one level per turn, covering the layers you list here",
    ax_flow_hint: "An axis-plan is scaffolding you'll walk mechanically (labels only, no prose) — <code>deepagent_tree</code>/<code>deepagent_tree_md</code> are almost always the right pick here, not <code>deepagent_md</code>; see the Flow hint on the Init tab for the full genre distinction.",
    ax_task_ph: "Describe the implementation/architecture-oriented decomposition…",
    max_depth: "Max depth", ax_generate_btn: "Generate axis-plan",
    ax_pick_source: "Pick a source research plan first.",
    ax_no_index: "That plan has no index.md yet — nothing to seed from.",
    ax_task_empty: "Task is empty — seed it from a source plan or type one first.",
    ax_need_axis: "Describe the axis to decompose along first (e.g. \"implementation architecture\").",
    ax_need_task: "Task is required — try “Seed task from source plan’s root task” first.",
    ax_need_rag: "Pick a source plan and an indexed RAG project first, or uncheck “Use RAG”.",

    // spec
    sp_generate_t: "Generate specs", sp_help_title: "Show deepagent_spec's own usage/flags (via 1bcoder's built-in /flow help)",
    sp_hint: "Runs <code>deepagent_spec</code> over the plan currently selected in the top bar — point that at an axis-plan once you have one, or at a research plan directly for the plain 1:1 behavior.",
    sp_focus: "Focus note", sp_focus_ph: "e.g. prioritize data integrity over UI polish",
    sp_ctx: "Ctx (recent messages)", sp_profile: "Profile",
    sp_predictable: "Predictable (temperature=0.3/num_predict=2000 if unset)", sp_generate_btn: "Generate specs",
    sp_rollup_t: "Roll up into tasks.md",
    sp_rollup_hint: "Runs <code>deepagent_task</code> over the plan currently selected in the top bar — compiles container titles and any generated <code>spec_*.md</code> units into the flat <code>tasks.md</code> the Tasks board reads. No LLM call: existing task tags (#backend, +active, %user, etc.) are preserved on re-run, only titles refresh and brand-new leaves get <code>+backlog</code>.",
    sp_task_btn: "📋 Generate tasks.md", sp_list_t: "Specs for this plan",
    sp_redo_title: "Delete and regenerate this one spec unit (no subtree — spec units are flat/independent)",
    sp_select_plan: "Select a plan in the top bar first.", sp_none_yet: "No specs generated yet.",

    // settings
    st_runtime: "1bcoder runtime",
    st_runtime_hint: "Edits <code>.1bcoder/config.yml</code> (this project) or <code>~/.1bcoder/config.yml</code> (every project) directly — the same file every Plan/redo launch reads its model and context from. Other keys already in that file (<code>vars</code>/<code>procs</code>/<code>hooks</code>/<code>active_project</code>) are left untouched and are not shown here.",
    st_scope: "Scope", st_scope_project: "This project (.1bcoder/config.yml)", st_scope_global: "Global (~/.1bcoder/config.yml)",
    st_host: "Host", st_model: "Model", st_ctx: "Context (num_ctx)", st_timeout: "Timeout, s",
    st_run_timeout: "Run timeout, s", st_run_timeout_hint: "(cap for /run commands, 0 = no timeout)", st_params: "Other params", st_params_hint: "(key=value, comma-separated — e.g. think=false, temperature=0.2; sent with every request, as /param)", st_params_bad: "Not key=value: {part}",
    st_prefs: "Alkonost preferences", st_prefs_hint: "Theme and language live in the top bar selectors.",
    st_need_project: "Select a project first, or switch scope to Global.",

    // glossary
    gl_build_t: "Build a glossary",
    gl_help_title: "Show /flow glossary's own usage/flags (via 1bcoder's built-in /flow help)",
    gl_build_hint: "Runs 1bcoder's <code>/flow glossary index</code> with the model from Settings. It is incremental: running it again skips the files already read in full, re-reads the changed ones and finishes a stopped run — so the same button builds, updates and resumes.",
    gl_name: "Glossary", gl_source: "Source (file or folder of the project)",
    gl_terms_only: "Terms only (one LLM call per chunk)",
    gl_terms_only_title: "Only collect the terms and where they occur (SEEN:) — no definitions or facts. Several times faster; the right first pass on a weak machine.",
    gl_crosslink: "Cross-link", gl_crosslink_title: "After the run, link the articles whose names contain each other (LINK:)",
    gl_all: "Re-read all files", gl_all_title: "Ignore the incremental index: read every file again",
    gl_prune: "Prune deleted files", gl_prune_title: "Forget what the files that no longer exist gave",
    gl_jev: "Check with jev (KIND, facts)",
    gl_jev_title: "A decision model (tev1) judges each new term: domain / technology / noise; with full articles it also checks definitions and facts against the text. A jev model or host implies this.",
    gl_jev_model: "jev model", gl_jev_host: "jev host", gl_build_btn: "📖 Build / continue",
    gl_need_name: "Name the glossary (letters, digits, -, _).", gl_need_source: "Give a source: a file or folder of the project.",
    gl_browse_t: "Articles", gl_filter_ph: "filter by name…", gl_kind: "Kind", gl_kind_any: "any", gl_kind_unjudged: "not judged",
    gl_min_seen: "Seen ≥", gl_min_seen_title: "Support: in how many chunks of the source the term was found (SEEN:)",
    gl_multiword: "Multi-word only", gl_sort: "Sort", gl_sort_seen: "by support (SEEN)", gl_sort_name: "by name", gl_sort_facts: "by facts",
    gl_col_term: "Term", gl_col_seen: "Seen", gl_col_defs: "Definitions", gl_col_facts: "Facts", gl_col_links: "Links",
    gl_none: "No glossaries in this project yet — build one above.",
    gl_summary: "{shown} of {total} terms · {files} files read",
    gl_empty_filter: "No term matches the filters.",
    gl_search_t: "Search (simargl)",
    gl_search_hint: "Semantic search over the articles of the glossary chosen above: meaning, not spelling — a question finds the terms whose definitions and facts answer it. The index lives in the glossary folder (<code>.simargl/</code>); rebuild it after the glossary grows.",
    resize_title: "Drag to resize; double-click for the default width",
    gl_tools_t: "1bcoder commands",
    gl_tools_hint: "Run on the glossary chosen above; the output goes to the log. <b>HTML</b> and <b>Contents</b> are exports for reading the glossary without alkonost or for committing it to git: <code>glossary.html</code> + one page per term, and <code>_contents.md</code> with every term as a link for a markdown viewer.",
    gl_relink_btn: "🔗 Relink", gl_relink_title: "/flow glossary relink: re-sort glossary.md and recompute every LINK: (no LLM)",
    gl_synonyms: "with synonyms", gl_synonyms_title: "--synonyms: also look for SYNONYM: pairs by embeddings (needs radogast[embed]; asks to confirm in the log)",
    gl_html_btn: "🌐 Export HTML", gl_html_title: "/flow glossary html: glossary.html + one page per term, for a browser without alkonost",
    gl_contents_btn: "📑 Export contents (.md)", gl_contents_title: "/flow glossary contents: _contents.md — every term as a link, for a markdown viewer or git",
    gl_cmd_find: "find — text in definitions and facts", gl_cmd_extract: "extract — terms in a free text",
    gl_cmd_show: "show — one article", gl_cmd_filter: "filter — \\term -term !term tokens",
    gl_cmd_ph: "text, a term, or filter tokens", gl_cmd_btn: "▶ Run",
    gl_source_missing: "Cannot open the source {path}: {msg}",
    gl_rag_btn: "🧭 Build search index", gl_rag_title: "Index the glossary's articles with simargl (1bcoder's /flow rag index)",
    gl_indexed: "index: built", gl_not_indexed: "index: not built yet",
    gl_query_ph: "a question or a few words…", gl_search_btn: "🔍 Search",
    gl_no_results: "Nothing found.", gl_pick_glossary: "Pick a glossary first.",
    gl_sec_definition: "Definitions", gl_sec_facts: "Facts", gl_sec_links: "Links", gl_sec_synonyms: "Synonyms",
    gl_sec_kind: "Kind (jev votes)", gl_sec_seen: "Seen in", gl_sec_history: "History", gl_kind_verdict: "Kind: {kind}",

    // making a folder a project
    np_title: "Make a folder a project (creates an empty .1bcoder/ in it)",
    np_make: "＋ Make a folder a project",
    np_none: "No project found under <code>{root}</code>. A project is any folder with a <code>.1bcoder/</code> inside — make one from a folder to start.",
    np_heading: "Make a folder a project",
    np_hint: "A project is any folder with a <code>.1bcoder/</code> inside. Pick a folder: alkonost creates an empty <code>.1bcoder/</code> there and nothing else.",
    np_ok: "Make this folder a project", np_open: "Open this project",
    np_is_project: "project", np_no_folders: "(no subfolders)",
  },
};
if (typeof ALK_LANGS !== "undefined") Object.assign(I18N, ALK_LANGS);
state.lang = (() => {
  let l = "";
  try { l = localStorage.getItem("alkonost-lang") || ""; } catch (e) { /* ignore */ }
  try {                                          // ?lang=uk in a link
    const q = new URLSearchParams(location.search).get("lang");
    if (q && I18N[q]) { l = q; localStorage.setItem("alkonost-lang", q); }
  } catch (e) { /* no location (tests) */ }
  return I18N[l] ? l : "en";
})();

// t("key") or t("key", { n: 3 }) — {n} in the string is replaced; callers
// escape whatever they pass in that ends up in innerHTML
function t(key, vars) {
  let s = (I18N[state.lang] && I18N[state.lang][key]) ?? I18N.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}

function applyLang(l) {
  const lang = I18N[l] ? l : "en";
  document.documentElement.setAttribute("lang", lang);
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-title]").forEach(el => { el.title = t(el.dataset.i18nTitle); });
  const sel = $("#lang-select");
  if (sel && sel.value !== lang) sel.value = lang;
}

function fillLangSelect() {
  const sel = $("#lang-select");
  if (!sel) return;
  sel.innerHTML = LANGS.map(([c, label]) => `<option value="${c}">${label}</option>`).join("");
  sel.value = state.lang;
}

// A new language redraws everything JS drew from strings, from the state in
// hand — no reload, no new requests except the Plan/Spec lists that are
// always fetched fresh anyway.
function setLang(l) {
  state.lang = I18N[l] ? l : "en";
  try { localStorage.setItem("alkonost-lang", state.lang); } catch (e) { /* ignore */ }
  saveLastSelection({ lang: state.lang });
  applyLang(state.lang);
  renderProjectSelect();
  renderPlanSelect();
  updatePlanContinueHint();
  renderAll();
  if (currentView() === "plan" && state.plan) renderPlanTree();
  if (currentView() === "spec") refreshSpecView();
  if (currentView() === "files") refreshFiles();
  if (currentView() === "glossary") { renderGlossaryTable(); renderGlossarySummary(); }
}

// ── FILES view — generic project-root file manager (ported from vyrii's
// /vyrii/files/* + Files tab). One deliberate difference from vyrii: vyrii
// always browses its own fixed ~/.vyrii directory; here there is no
// equivalent Alkonost-private folder, so this always browses whichever
// project is currently selected in the top bar. Another: listing is
// per-directory and lazy (fetched on expand), not one eager recursive
// walk of the whole tree — a real project root can contain node_modules/
// .git/venv, which ~/.vyrii never has to deal with.

function filesApiBase() {
  return `/api/files/list?project=${encodeURIComponent(state.projectId)}`;
}

async function refreshFiles() {
  const tree = $("#files-tree");
  const preview = $("#files-preview");
  if (!state.projectId) {
    tree.innerHTML = `<div class="placeholder-text">${t("select_project")}</div>`;
    preview.innerHTML = `<div class="placeholder-text">${t("select_file")}</div>`;
    return;
  }
  tree.innerHTML = `<div class="placeholder-text">${t("loading")}</div>`;
  try {
    const data = await fetchJSON(`${filesApiBase()}&path=`);
    tree.innerHTML = "";
    tree.appendChild(filesBuildTree(data.entries || [], ""));
  } catch (e) {
    tree.innerHTML = `<div class="placeholder-text">${t("error_prefix")}${e.message}</div>`;
  }
}

function filesIcon(name, isDir) {
  if (isDir) return "📁";
  const ext = name.split(".").pop().toLowerCase();
  const icons = {
    py: "🐍", js: "📜", ts: "📜", html: "🌐", css: "🎨", md: "📝",
    txt: "📄", json: "📋", yaml: "📋", yml: "📋", sh: "⚙️", bat: "⚙️",
    png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️",
    pdf: "📑", zip: "🗜️", gz: "🗜️", tar: "🗜️",
  };
  return icons[ext] || "📄";
}

function filesBuildTree(entries, basePath) {
  const ul = document.createElement("ul");
  ul.className = "tree-list";
  for (const entry of entries) {
    const li = document.createElement("li");
    const item = document.createElement("div");
    item.className = "tree-item";
    const path = basePath ? `${basePath}/${entry.name}` : entry.name;
    item.innerHTML = `<span class="item-icon">${filesIcon(entry.name, entry.is_dir)}</span><span class="item-name"></span>`;
    item.querySelector(".item-name").textContent = entry.name;

    if (entry.is_dir) {
      let sub = null;
      let loaded = false;
      item.addEventListener("click", async (e) => {
        e.stopPropagation();
        document.querySelectorAll(".tree-item").forEach(i => i.classList.remove("selected"));
        item.classList.add("selected");
        filesShowInfo({ name: entry.name, path, is_dir: true });
        if (!loaded) {
          try {
            const data = await fetchJSON(`${filesApiBase()}&path=${encodeURIComponent(path)}`);
            sub = filesBuildTree(data.entries || [], path);
            sub.style.display = "none";
            li.appendChild(sub);
            loaded = true;
          } catch (err) {
            return;
          }
        }
        sub.style.display = sub.style.display === "none" ? "block" : "none";
        item.querySelector(".item-icon").textContent = sub.style.display === "none" ? "📁" : "📂";
      });
    } else {
      item.addEventListener("click", () => {
        document.querySelectorAll(".tree-item").forEach(i => i.classList.remove("selected"));
        item.classList.add("selected");
        filesShowInfo({ name: entry.name, path, is_dir: false });
      });
    }
    li.appendChild(item);
    ul.appendChild(li);
  }
  return ul;
}

function filesShowInfo(info) {
  const preview = $("#files-preview");
  const escapedPath = info.path.replace(/'/g, "\\'");
  const actionBtns = !info.is_dir
    ? `<button type="button" onclick="filesView('${escapedPath}')">${t("view")}</button>`
    : "";
  preview.innerHTML = `
    <div class="file-info-box">
      <h3 id="files-info-name"></h3>
      <div class="fi-row"><span class="fi-label">${t("fi_type")}</span><span>${info.is_dir ? t("fi_directory") : t("fi_file")}</span></div>
      <div class="fi-row"><span class="fi-label">${t("fi_path")}</span><span id="files-info-path" style="word-break:break-all;font-size:0.8rem"></span></div>
    </div>
    <div class="plan-form-row">
      ${actionBtns}
      <button type="button" onclick="filesDelete('${escapedPath}')">${t("delete_btn")}</button>
    </div>
    <div id="files-content-wrap"></div>`;
  $("#files-info-name").textContent = info.name;
  $("#files-info-path").textContent = info.path;
}

async function filesView(path) {
  const wrap = $("#files-content-wrap");
  wrap.innerHTML = `<div class="file-raw">${t("loading")}</div>`;
  try {
    const data = await fetchJSON(`/api/files/read?project=${encodeURIComponent(state.projectId)}&path=${encodeURIComponent(path)}`);
    const ext = path.split(".").pop().toLowerCase();
    const content = data.content || "";
    if (ext === "md" || ext === "markdown") {
      wrap.innerHTML = `<div class="md-content">${md(content)}</div>`;
    } else if (ext === "html" || ext === "htm") {
      wrap.innerHTML = "";
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-forms");
      iframe.style.cssText = "width:100%;height:45vh;border:1px solid var(--border);border-radius:4px;background:#fff;display:block";
      iframe.srcdoc = content;
      wrap.appendChild(iframe);
    } else {
      const pre = document.createElement("pre");
      pre.className = "file-raw";
      pre.textContent = content || t("file_empty");
      wrap.innerHTML = "";
      wrap.appendChild(pre);
    }
    if (data.truncated) {
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent = t("file_truncated");
      wrap.appendChild(note);
    }
  } catch (e) {
    wrap.innerHTML = `<div class="file-raw">${t("error_prefix")}${e.message}</div>`;
  }
}

async function filesDelete(path) {
  if (!confirm(t("confirm_delete", { path }))) return;
  try {
    await fetchJSON(`/api/files?project=${encodeURIComponent(state.projectId)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
    });
    $("#files-preview").innerHTML = `<div class="placeholder-text">${t("select_file")}</div>`;
    refreshFiles();
  } catch (e) {
    alert(`${t("error_prefix")}${e.message}`);
  }
}

function filesShowMkdir() {
  $("#files-mkdir-dialog").classList.remove("hidden");
  $("#files-mkdir-input").focus();
}
function filesCloseMkdir() {
  $("#files-mkdir-dialog").classList.add("hidden");
  $("#files-mkdir-input").value = "";
}
async function filesDoMkdir() {
  const name = $("#files-mkdir-input").value.trim();
  if (!name) return;
  try {
    await fetchJSON(`/api/files/mkdir?project=${encodeURIComponent(state.projectId)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: name }),
    });
    filesCloseMkdir();
    refreshFiles();
  } catch (e) {
    alert(`${t("error_prefix")}${e.message}`);
  }
}

async function filesUpload(input) {
  if (!input.files.length) return;
  const form = new FormData();
  for (const f of input.files) form.append("files", f);
  try {
    const res = await fetch(`/api/files/upload?project=${encodeURIComponent(state.projectId)}`, {
      method: "POST", body: form,
    });
    const data = await res.json();
    if (data.ok) {
      refreshFiles();
    } else {
      alert(JSON.stringify(data.error || t("api_error")));
    }
  } catch (e) {
    alert(`${t("error_prefix")}${e.message}`);
  }
  input.value = "";
}

async function init() {
  $("#refresh-btn").addEventListener("click", refreshProjectsAndPlans);
  $("#project-select").addEventListener("change", onProjectChange);
  $("#new-project-btn").addEventListener("click", openProjectModal);
  $("#no-projects-btn").addEventListener("click", openProjectModal);
  $("#project-modal-ok").addEventListener("click", confirmProjectModal);
  $("#project-modal-cancel").addEventListener("click", closeProjectModal);
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
  initPanelResizer();
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

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  $("#plan-generate-btn").addEventListener("click", generatePlan);
  $("#plan-flow-help-btn").addEventListener("click", () =>
    showFlowHelp($("#plan-flow-select").value, "init", $("#plan-flow-help-btn")));
  $("#plan-continue-btn").addEventListener("click", continueLayer);
  $("#plan-resume-btn").addEventListener("click", resumePlan);
  $("#plan-new-from-source-btn").addEventListener("click", createPlanFromSource);
  $("#plan-continue-label-input").addEventListener("input", updatePlanContinueHint);
  $("#plan-engine-save-btn").addEventListener("click", savePlanEngineSetup);
  $("#radogast-derive-index-btn").addEventListener("click", () =>
    deriveRadogastTarget("index", $("#radogast-derive-index-btn")));
  $("#radogast-derive-full-btn").addEventListener("click", () =>
    deriveRadogastTarget("full", $("#radogast-derive-full-btn")));
  $("#radogast-save-target-btn").addEventListener("click", saveRadogastTarget);
  $("#radogast-analyze-btn").addEventListener("click", analyzeWithRadogast);
  $("#radogast-help-btn").addEventListener("click", showRadogastHelp);
  $("#axis-source-plan-select").addEventListener("change", loadAxisRagProjects);
  $("#axis-rag-index-btn").addEventListener("click", indexAxisRag);
  $("#axis-rag-refresh-btn").addEventListener("click", loadAxisRagProjects);
  $("#axis-seed-btn").addEventListener("click", seedAxisTask);
  $("#axis-compose-btn").addEventListener("click", composeAxisTask);
  $("#axis-flow-help-btn").addEventListener("click", () =>
    showFlowHelp($("#axis-flow-select").value, "axis", $("#axis-flow-help-btn")));
  $("#axis-generate-btn").addEventListener("click", generateAxisPlan);
  $("#spec-flow-help-btn").addEventListener("click", () =>
    showFlowHelp("deepagent_spec", "spec", $("#spec-flow-help-btn")));
  $("#spec-generate-btn").addEventListener("click", generateSpec);
  $("#spec-task-btn").addEventListener("click", generateTasksFromSpec);
  ["init", "plan", "radogast", "axis", "spec", "glossary"].forEach(prefix => {
    $(`#${prefix}-stop-btn`).addEventListener("click", () => stopLaunch(prefix));
  });
  $("#glossary-build-btn").addEventListener("click", buildGlossary);
  $("#glossary-flow-help-btn").addEventListener("click", () =>
    showFlowHelp("glossary", "glossary", $("#glossary-flow-help-btn")));
  $("#glossary-select").addEventListener("change", (e) => selectGlossary(e.target.value));
  $("#glossary-reload-btn").addEventListener("click", refreshGlossaryView);
  ["#glossary-filter-input", "#glossary-min-seen-input"].forEach(sel =>
    $(sel).addEventListener("input", renderGlossaryTable));
  ["#glossary-kind-select", "#glossary-sort-select", "#glossary-multiword-checkbox"].forEach(sel =>
    $(sel).addEventListener("change", renderGlossaryTable));
  // md() links to a relative path or src: lead nowhere in this page by themselves: a view that
  // understands them (the glossary article panel) handles the click, the rest go nowhere
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("a[data-local-link]")) e.preventDefault();
  });
  $("#glossary-rag-btn").addEventListener("click", indexGlossaryRag);
  [["#glossary-relink-btn", "relink"], ["#glossary-html-btn", "html"], ["#glossary-contents-btn", "contents"]]
    .forEach(([sel, cmd]) => $(sel).addEventListener("click", () => runGlossaryCommand(cmd, "", $(sel))));
  const runCmd = () => runGlossaryCommand($("#glossary-cmd-select").value, $("#glossary-cmd-input").value.trim(), $("#glossary-cmd-btn"));
  $("#glossary-cmd-btn").addEventListener("click", runCmd);
  $("#glossary-cmd-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runCmd(); });
  $("#glossary-search-btn").addEventListener("click", searchGlossary);
  $("#glossary-query-input").addEventListener("keydown", (e) => { if (e.key === "Enter") searchGlossary(); });
  $("#settings-scope-select").addEventListener("change", loadSettings);
  $("#settings-save-btn").addEventListener("click", saveSettings);

  $("#files-refresh-btn").addEventListener("click", refreshFiles);
  $("#files-mkdir-toggle-btn").addEventListener("click", filesShowMkdir);
  $("#files-mkdir-create-btn").addEventListener("click", filesDoMkdir);
  $("#files-mkdir-cancel-btn").addEventListener("click", filesCloseMkdir);
  $("#files-upload-input").addEventListener("change", (e) => filesUpload(e.target));

  fillLangSelect();
  $("#lang-select").addEventListener("change", (e) => setLang(e.target.value));
  applyLang(state.lang);
  updatePlanContinueHint();
  applyTheme(state.theme);
  applyFitWidth();
  loadThemes();
  await loadProjects();
  await restoreLastSelection();
  restoreLogs();
}

document.addEventListener("DOMContentLoaded", init);
