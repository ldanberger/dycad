import { loadAllData } from './data.js';
import { Store, ciEq, newId } from './state.js';
import { parseArchimateXml } from './archimate.js';
import { renderTabs, renderToolbar, renderToolbox, renderSelectionInfo, renderCommands, renderProperties, renderMessageLog, escapeHtml, groupFill, getCommandDefs, CMD_ICONS, getAllPinnedFields, setAllPinnedFields } from './render.js';
import { renderPages, renderCanvasPage, wireGlobalCanvasHandlers, buildMarkerDefs, redrawNodeSizes, redrawAndResolveLayout, getNodeSize, passesStreamFilter, passesElementTypeFilter, isAnyVisibilityFilterActive, expandVisiblePartVmIdsByLevel, disposeView3DTab, getView3DModule } from './canvas.js';
import { validRelationOptions, elementByType, defaultRelationKeyFor } from './rules.js';
import { createStream, duplicateStream, nextStreamName, splitNode, levelUp, levelUpEntityDetails, levelDown, levelDownSingle, copyNodes, pasteNodes, remap, mergeNodes, mergePartsAndView, mergeViewOnly, REMAP_SORT_KEYS, REMAP_SORT_LABELS, DEFAULT_REMAP_SORT_KEYS, generateInventoryView, generateIndustry, addExistingPartsToView, populateFromTemplate, insertSmartStream, duplicateSection as duplicateSectionCommand, smartCheckView, smartCheckNode, scanStreamsForAutoComplete, autoCompleteStreams, createBulkLookupCache, deriveStreamNames, findCrossingCounterpart, findCompositionChildView, importDDL, exportDDL, detectConnectorCandidates, createDetectedConnectors } from './commands.js';
import { APP_VERSION } from './version.js';
import { isSectionViewType, pixelToNearestGrid, isTypeAllowedInSection, insertSectionAfter, removeSectionAndMembers, findFreeCellInSection, computeSectionLayout, getAllowedTypesForView } from './sections.js';
import { stepSimulation, startContinuousRun, pauseContinuousRun, continueContinuousRun, stopContinuousRun, resetSimulation, saveSimSnapshot, loadSimSnapshot, pushMessageLog } from './simulation.js';
import { flattenJsonRecords, buildRowsFromRecords, detectSharedFunctions, resolveSharedFunctions, buildIndustryTree, flattenIndustryTree, GENERATE_UNIQUE_ID } from './sfce.js';

/** Pretty-prints a Script Console result. JSON.stringify covers plain data (the common
 * case — arrays of parts, objects, etc.); falls back to String() for anything it can't
 * serialize (functions, DOM nodes, circular structures). */
function stringifyForConsole(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/** Converts a free-text label (e.g. a DataDataEntity's own label, "Customer Order") into
 * a snake_case identifier fragment ("customer_order") — used only to name auto-created FK
 * attributes (finishConnect below) as `<parent_snake>_<pk_name_snake>`, matching typical
 * SQL naming convention for a foreign key column. */
function toSnakeCase(label) {
  return String(label || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'field';
}

/** Projects a point outward from a rectangle's center toward (dx,dy) to the rectangle's
 * edge — used only by buildViewSvgString's connector-endpoint math. */
function clipToRectEdgeForExport(cx, cy, dx, dy, halfW, halfH) {
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** Rough character-count word-wrap for buildViewSvgString's plain-SVG text — no real CSS
 * layout available there, so this approximates each font's average glyph width well
 * enough to keep node-card text from overflowing, capped at `maxLines`. */
function wrapTextForExport(text, maxWidthPx, fontSize, maxLines) {
  const avgCharWidth = fontSize * 0.55;
  const maxChars = Math.max(4, Math.floor(maxWidthPx / avgCharWidth));
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    } else {
      current = candidate;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (last.length > maxChars) lines[maxLines - 1] = `${last.slice(0, maxChars - 1)}…`;
  }
  return lines;
}

// ===================== RECENTLY OPENED FILES =====================
// A browser can't silently re-read a local file the user picked earlier (no persisted
// file handle without the newer, Chromium-only File System Access API) — so "recently
// opened" here means caching each file's own JSON TEXT in localStorage at load/save
// time, and re-loading straight from that cache. Purely a convenience cache, not
// critical data: capped in count and per-entry size, and any localStorage failure
// (quota, privacy mode) is swallowed rather than surfaced, since losing this list just
// means falling back to the ordinary file picker.
const RECENT_FILES_KEY = 'dycad-recent-files';
const RECENT_FILES_MAX = 8;
const RECENT_FILE_MAX_BYTES = 3 * 1024 * 1024; // stay well under typical 5-10MB localStorage quota even with several cached

// Local Settings cache: user PREFERENCES that auto-apply on every boot without any file
// to (re)load, deliberately separate from Local Secrets (API keys etc., which must NEVER
// be cached to localStorage — see saveLocalSecrets/the load-local-secrets-input handler
// below). Members today: maxScriptEntities and nodeSizeMultiplier (both only ever set via
// File > Load Local Settings — pinnedFields, the file's other member, already persists
// itself via its own localStorage key in render.js's getPinnedFields/setPinnedFields, so
// it doesn't need a slot here) and instructionsClosed (set purely from closing the
// Instructions tab in the UI, nothing to do with the Local Settings file at all — this
// cache is really "auto-persisted preferences" in general, not strictly a mirror of that
// one file's contents).
const LOCAL_SETTINGS_CACHE_KEY = 'dycad-local-settings-cache';

/** Read-modify-write helpers for LOCAL_SETTINGS_CACHE_KEY — every member is written via
 * setLocalSettingsCache(patch) (merges into whatever's already cached) rather than each
 * writer clobbering the whole object, so unrelated members never stomp on each other. */
function getLocalSettingsCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(LOCAL_SETTINGS_CACHE_KEY) || '{}');
    return (cached && typeof cached === 'object' && !Array.isArray(cached)) ? cached : {};
  } catch { return {}; }
}
function setLocalSettingsCache(patch) {
  try { localStorage.setItem(LOCAL_SETTINGS_CACHE_KEY, JSON.stringify({ ...getLocalSettingsCache(), ...patch })); } catch { /* quota/privacy mode — losing the cache just means falling back to defaults next session */ }
}

/** Reads the cached maxScriptEntities value (if any). Returns null if nothing valid is
 * cached (fresh browser, cache cleared, or never loaded). */
function getCachedMaxScriptEntities() {
  const n = Number(getLocalSettingsCache().maxScriptEntities);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Writes maxScriptEntities to the localStorage cache so it survives a page refresh
 * without re-loading the Local Settings file — called whenever it's set (today: only
 * from the Load Local Settings file handler below). */
function setCachedMaxScriptEntities(n) { setLocalSettingsCache({ maxScriptEntities: n }); }

/** Reads the cached Script Console text (if any). Returns null if nothing valid is
 * cached — bootstrapApp then leaves the Store constructor's own
 * DEFAULT_BATCH_SCRIPT_CODE in place. */
function getCachedBatchScriptCode() {
  const v = getLocalSettingsCache().batchScriptCode;
  return typeof v === 'string' && v ? v : null;
}
/** Writes the Script Console's current text to the localStorage cache so it survives a
 * page refresh — called on every Run and on closing the console, not just from the
 * Load Local Settings file handler (unlike maxScriptEntities/nodeSizeMultiplier, this
 * one is meant to be edited freely, not just loaded from a file). */
function setCachedBatchScriptCode(code) { setLocalSettingsCache({ batchScriptCode: code }); }

/** Reads the cached Insert Smart Stream presets list (if any). Returns null if nothing
 * valid is cached — bootstrapApp then leaves the Store constructor's own
 * DEFAULT_SMART_STREAM_PRESETS in place. */
function getCachedSmartStreamPresets() {
  const v = getLocalSettingsCache().smartStreamPresets;
  return Array.isArray(v) ? v : null;
}
/** Writes the full Insert Smart Stream presets list to the localStorage cache so it
 * survives a page refresh — called on every Save As from the dialog, not just from the
 * Load Local Settings file handler (same "meant to be edited freely" reasoning as
 * setCachedBatchScriptCode above). */
function setCachedSmartStreamPresets(list) { setLocalSettingsCache({ smartStreamPresets: list }); }

/** Reads the cached Remap presets list (if any). Returns null if nothing valid is
 * cached — bootstrapApp then leaves the Store constructor's own DEFAULT_REMAP_PRESETS
 * (an empty array) in place. */
function getCachedRemapPresets() {
  const v = getLocalSettingsCache().remapPresets;
  return Array.isArray(v) ? v : null;
}
/** Writes the full Remap presets list to the localStorage cache so it survives a page
 * refresh — called on every Save As from the dialog, not just from the Load Local
 * Settings file handler (same "meant to be edited freely" reasoning as
 * setCachedSmartStreamPresets above). */
function setCachedRemapPresets(list) { setLocalSettingsCache({ remapPresets: list }); }

/** Right-click on `button` copies a ready-to-paste JS function call (built by
 * `buildSnippet()`, called fresh on each right-click so it reflects whatever the form
 * currently holds) to the clipboard, instead of opening the browser's own context
 * menu — handy for pasting into the Script Console (Advanced menu) to replay the exact
 * same settings later, without re-clicking through every field by hand. Reported
 * directly: "Can right click be added to the remap submit button, to put into copy
 * the function call and parameters that match what user has filled out. This would be
 * very handy for any dialog form with multiple settings" — generic on purpose (any
 * dialog's submit button can wire this up the same way; today only Remap's does, see
 * promptRemap below). */
function wireCopyCallOnRightClick(app, button, buildSnippet) {
  button.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const snippet = buildSnippet();
    try {
      await navigator.clipboard.writeText(snippet);
      app.toast('Copied function call to clipboard.');
    } catch (err) {
      app.toast(`Couldn't copy to clipboard: ${err.message}`, true);
    }
  });
}

/** Reads the cached nodeSizeMultiplier value (if any). Returns null if nothing valid is
 * cached (fresh browser, cache cleared, or never loaded) — bootstrapApp then falls back
 * to the Store constructor's own 1.2 default. Clamped to a sane 0.5-3 range so a bad or
 * corrupted cached value can't produce degenerate (near-zero or absurdly huge) nodes. */
function getCachedNodeSizeMultiplier() {
  const n = Number(getLocalSettingsCache().nodeSizeMultiplier);
  return Number.isFinite(n) && n >= 0.5 && n <= 3 ? n : null;
}

/** Writes nodeSizeMultiplier to the localStorage cache so it survives a page refresh
 * without re-loading the Local Settings file — called whenever it's set (today: only
 * from the Load Local Settings file handler below). */
function setCachedNodeSizeMultiplier(n) { setLocalSettingsCache({ nodeSizeMultiplier: n }); }

/** Whether the user has closed the Instructions tab before — once true, bootstrapApp
 * stops auto-opening it on startup, so closing it is a real "don't show this again"
 * rather than something to repeat every session. Only ever set true (see closeTab
 * below); there's no UI to reset it back to auto-opening short of clearing browser data,
 * matching how "closed" is meant to stick. */
function getCachedInstructionsClosed() { return getLocalSettingsCache().instructionsClosed === true; }
function setCachedInstructionsClosed() { setLocalSettingsCache({ instructionsClosed: true }); }

/** Last-used Stream Template name, shared as the default selection across every dialog
 * that offers a Stream Template picker (Generate Stream, Smart Check View's Auto-Complete
 * Streams option, Remap) — picking a template in any one of them becomes the default for
 * the others next time, instead of each independently defaulting to "Enterprise". */
function getCachedStreamTemplate() {
  const v = getLocalSettingsCache().streamTemplate;
  return typeof v === 'string' && v ? v : null;
}
function setCachedStreamTemplate(name) { setLocalSettingsCache({ streamTemplate: name }); }

/** The 3D View's OWN layer-order preference — which streamTemplate's value[] decides
 * element-group/type ordering there (view3d.js's resolveLayerOrder) — deliberately
 * SEPARATE from getCachedStreamTemplate above, since Remap/Generate Stream/Smart Check
 * View's shared "last used" preference is about which template to GENERATE a stream
 * from, an unrelated concern from "how should the 3D scene visually order its layers."
 * Defaults to null, which view3d.js resolves to "All" (the former cubeOrder, now just
 * another streamTemplate entry covering all 77 known types) — today's out-of-the-box
 * 3D layer order, unchanged unless a person explicitly picks a different template. */
function getCachedView3DLayerOrderTemplate() {
  const v = getLocalSettingsCache().view3DLayerOrderTemplate;
  return typeof v === 'string' && v ? v : null;
}
function setCachedView3DLayerOrderTemplate(name) { setLocalSettingsCache({ view3DLayerOrderTemplate: name }); }

/** Remap dialog's own options (pattern, limit-to-view, filtered-only, the two force-
 * directed sub-options, and sort priority order) — remembered as user-level defaults
 * across ALL views, applied whenever Remap reopens so even a brand-new view starts from
 * them rather than the dialog's hardcoded defaults. Distinct from (and lower-priority
 * than) view.remapSortKeys, which remembers the order actually last used ON THAT SPECIFIC
 * view and still wins once a view has its own history — this is only the fallback for a
 * view that doesn't. */
function getCachedRemapOptions() {
  const v = getLocalSettingsCache().remapOptions;
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}
function setCachedRemapOptions(patch) { setLocalSettingsCache({ remapOptions: { ...getCachedRemapOptions(), ...patch } }); }

function getRecentFiles() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function addRecentFile(name, content) {
  if (!name || content.length > RECENT_FILE_MAX_BYTES) return; // too big to cache locally — Load still works normally via the file picker
  let list = getRecentFiles().filter((f) => f.name !== name); // de-dupe by name, most-recent-first
  list.unshift({ name, content, savedAt: Date.now() });
  list = list.slice(0, RECENT_FILES_MAX);
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(list));
  } catch {
    // Quota exceeded (e.g. several large files already cached) — halve the list and
    // retry once rather than losing the ability to cache anything at all.
    list = list.slice(0, Math.max(1, Math.floor(list.length / 2)));
    try { localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(list)); } catch { /* give up silently */ }
  }
}

/** Every valid Remap `pattern` value (promptRemap's #rm-pattern <option>s below) — a
 * single shared list so the dialog's own default-pattern resolution and preset-load
 * guard can never drift out of sync with which patterns actually exist. */
const REMAP_PATTERNS = ['default', 'none', 'layered', 'force', 'clusters'];

class App {
  constructor(store) {
    this.store = store;
    this.connectState = null;
    this.clipboard = null;
  }

  // ===================== RENDER =====================
  render() {
    renderTabs(this);
    renderToolbar(this);
    renderToolbox(this);
    renderPages(this);
    renderSelectionInfo(this);
    renderCommands(this);
    renderProperties(this);
    renderMessageLog(this);
    if (this.refreshSimToolbar) this.refreshSimToolbar();
    document.getElementById('save-json-btn').classList.toggle('dirty', this.store.dirty);
    document.getElementById('loaded-file-name').textContent = this.store.loadedFileName ? `(${this.store.loadedFileName})` : '';
    document.body.dataset.theme = localStorage.getItem('dycad-theme') || 'light';
  }

  recordAndRender() {
    const tab = this.store.activeTab();
    if (tab && tab.type === 'canvas') this.store.recordHistory(tab);
    this.render();
  }

  toast(message, isError = false) {
    const root = document.getElementById('toast-root');
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => el.remove(), isError ? 6000 : 3500);
    // Error/warning/rejection-style toasts (isError=true) also go to the Message Log —
    // toasts vanish after a few seconds and there was previously no record of a
    // rejected action after the fact. Routine success toasts stay out of the log so it
    // doesn't fill up with confirmations of things that worked fine. This single spot
    // covers every existing app.toast(msg, true) call throughout the app, not just new
    // ones — nothing else needed to change at each call site.
    if (isError) pushMessageLog(this.store, `[Warning] ${message}`);
  }

  // ===================== TABS =====================
  createCanvasTab(view) {
    const tab = this.store.createTab({ type: 'canvas', title: view.viewName, viewId: view.id });
    return tab;
  }

  /** Tears down every currently-open 3D tab's WebGL context/animation loop — call this
   * BEFORE any full-document-replace load path (Load/Load Example/Recently Opened all
   * wipe this.store.tabs directly rather than closing each tab through closeTab, which
   * is the only thing that normally triggers this disposal) wipes store.tabs out from
   * under it. Without this, an open 3D tab's renderer/animation loop keeps running
   * forever against a document that no longer exists — invisible (its own page-<id> DOM
   * container gets removed by the next render()), but never actually torn down: a real,
   * if silent, WebGL-context leak found and fixed after enough of these piled up. A
   * no-op for every other tab type. */
  disposeAllOpenView3DTabs() {
    for (const tab of this.store.tabs) {
      if (tab.type === '3d') disposeView3DTab(tab.id);
    }
  }

  switchToTab(tabId) {
    this.store.activeTabId = tabId;
    const tab = this.store.activeTab();
    if (tab && tab.type === 'canvas') this.store.currentView = tab.viewId;
    this.render();
  }

  closeTab(tabId) {
    const tab = this.store.tabs.find((t) => t.id === tabId);
    // Closing the Instructions tab is a "don't show this again" signal — cached so
    // bootstrapApp stops auto-opening it on future startups. See getCachedInstructionsClosed.
    if (tab && tab.type === 'docs') setCachedInstructionsClosed();
    // Tears down the WebGL context/animation loop instead of leaking it — a no-op if
    // this wasn't a 3D tab, or the 3D module was never loaded in the first place.
    if (tab && tab.type === '3d') disposeView3DTab(tabId);
    this.store.closeTab(tabId);
    this.render();
  }

  restoreTab(tabId) {
    const tab = this.store.restoreTab(tabId);
    if (tab) this.render();
  }

  /** Switch to the tab for a view, restoring from closed tabs, or creating a new tab named after the view. */
  openOrSwitchView(viewId, opts = {}) {
    let view = this.store.findView(viewId);
    if (!view) view = this.store.addView(viewId, opts.viewType || 'ff');

    let tab = this.store.findTabByView(view.id);
    if (!tab) {
      const closedIdx = this.store.closedTabs.findIndex((t) => t.type === 'canvas' && ciEq(t.viewId, view.id));
      if (closedIdx !== -1) {
        tab = this.store.closedTabs.splice(closedIdx, 1)[0];
        this.store.tabs.push(tab);
      } else {
        tab = this.createCanvasTab(view);
      }
    }
    if (!opts.silent) this.switchToTab(tab.id);
    return tab;
  }

  /** Double-click a node: open its linked view if it still resolves; else reuse an
   * EXISTING Composition-child decomposition of the same Part if one already exists
   * under a DIFFERENT ViewMember (linkedViewName lives on the ViewMember, not the
   * Part -- without this check, the same Part shown on two views would get two
   * independent decompositions, one per ViewMember someone happens to double-click);
   * else try a view matching the node's label; else create one (single-node
   * level-down). */
  openOrCreateLinkedView(tab, vmId) {
    const vm = this.store.findViewMember(vmId);
    if (!vm) return;
    if (vm.linkedViewName && this.store.findView(vm.linkedViewName)) {
      this.openOrSwitchView(vm.linkedViewName);
      return;
    }
    const part = this.store.findPart(vm.objectId);
    const existingChildView = part && findCompositionChildView(this.store, part.id);
    if (existingChildView) {
      vm.linkedViewName = existingChildView.id;
      this.recordAndRender();
      this.openOrSwitchView(existingChildView.id);
      return;
    }
    const matchingView = part && this.store.findView(part.label);
    if (matchingView) {
      vm.linkedViewName = matchingView.id;
      this.recordAndRender();
      this.openOrSwitchView(matchingView.id);
      return;
    }
    levelDownSingle(this, tab, vmId);
  }

  /** Data Modeling > Add/Edit Entity Details: the menu-triggered equivalent of
   * double-clicking a DataDataEntity node (openOrCreateLinkedView above) -- same
   * guarded logic (reuses an existing decomposition if this Part already has one
   * anywhere, even under a different ViewMember, rather than ever creating a second
   * one), just driven by the current selection instead of a double-click target, since
   * a menu command has no "which node was clicked" to work from. Requires exactly one
   * DataDataEntity node selected on a canvas tab. */
  promptAddEditEntityDetails() {
    const tab = this.store.activeTab();
    if (!tab || tab.type !== 'canvas') { this.toast('Open a view and select a Data Entity first.', true); return; }
    const selIds = [...tab.selection];
    if (selIds.length !== 1) { this.toast('Select a single Data Entity to add/edit its Entity Details.', true); return; }
    const vm = this.store.findViewMember(selIds[0]);
    if (!vm || vm.objectType !== 'part') { this.toast('Select a single node (not a connector) to add/edit its Entity Details.', true); return; }
    const part = this.store.findPart(vm.objectId);
    if (!part || !ciEq(part.type, 'DataDataEntity')) {
      this.toast(`Add/Edit Entity Details only applies to a Data Entity node — selected node is type "${part ? part.type : '?'}".`, true);
      return;
    }
    this.openOrCreateLinkedView(tab, vm.id);
  }

  /** Data Modeling > Export DDL: generates DDL text for whatever DataEntityDetails
   * tables + 'd' connectors are placed on the CURRENT view (commands.js's exportDDL —
   * scoped to one view, same as Insert Smart Stream, not the whole model) and shows it
   * in the same readonly text-viewer Code Summary/Message Log already use, rather than
   * a bespoke dialog. */
  promptExportDDL() {
    const tab = this.store.activeTab();
    if (!tab || tab.type !== 'canvas') { this.toast('Open a view with Data Entity Details tables to export first.', true); return; }
    try {
      const text = exportDDL(this, tab.viewId);
      this.promptTextEdit({ title: 'Export DDL', value: text, readonly: true, onSave: () => {} });
    } catch (err) {
      this.toast(err.message, true);
    }
  }

  /** Data Modeling > Auto-Detect Connectors...: preview-then-confirm UI over
   * commands.js's detectConnectorCandidates/createDetectedConnectors. Scoped to the
   * WHOLE document (every DataEntityDetails table, not just the current view — see
   * detectConnectorCandidates' own doc comment), so this is reachable with no canvas
   * tab open at all. A pasted DDL text box drives Part A (explicit REFERENCES,
   * matched against existing tables); Part B (field-name heuristic) always runs
   * regardless of whether any DDL text is given. Nothing is created until "Create
   * Selected Connectors" is clicked — every candidate starts checked, but a person can
   * uncheck individual rows (or Select All / none) first, since Part B in particular is
   * a guess, not a certainty. */
  promptAutoDetectConnectors() {
    const tableCount = this.store.doc.parts.filter((p) => ciEq(p.type, 'DataEntityDetails')).length;
    if (tableCount < 2) { this.toast('Need at least two Data Entity Details tables in the model to detect connectors.', true); return; }

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.style.width = '760px';
    box.style.maxWidth = '92vw';
    box.innerHTML = `
      <h3>Auto-Detect Connectors</h3>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
        Scans every Data Entity Details table in the model (not just the current view) for likely
        foreign-key relationships that aren't already connected: explicit DDL
        <code>FOREIGN KEY ... REFERENCES</code> text pasted below (optional), plus a field-name match
        against existing primary keys (e.g. a "CustomerId" column matching Customer's own primary
        key). Nothing is created until you review and confirm the list below.
      </div>
      <div class="prop-row"><label>Paste DDL (optional)</label></div>
      <textarea id="adc-ddl" rows="5" style="width:100%;font-family:monospace;font-size:12px;box-sizing:border-box;" placeholder="CREATE TABLE ... FOREIGN KEY (...) REFERENCES ...(...); -- optional, matched against existing tables only"></textarea>
      <div id="adc-results" style="margin-top:12px;">
        <div style="color:var(--text-muted);font-size:12px;">No candidates detected yet — click "Detect Connectors" below.</div>
      </div>
      <div class="modal-actions">
        <button class="cancel">Cancel</button>
        <button id="adc-detect" class="primary">Detect Connectors</button>
        <button id="adc-create" class="primary hidden">Create Selected Connectors</button>
      </div>
    `;
    overlay.appendChild(box);
    root.appendChild(overlay);
    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());

    let candidates = [];
    const selected = new Set();
    const resultsEl = box.querySelector('#adc-results');
    const createBtn = box.querySelector('#adc-create');

    const renderResults = () => {
      if (candidates.length === 0) {
        resultsEl.innerHTML = `<div style="color:var(--text-muted);font-size:12px;">No new connector candidates found.</div>`;
        createBtn.classList.add('hidden');
        return;
      }
      resultsEl.innerHTML = `
        <div style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:6px;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr>
              <th style="width:28px;"><input type="checkbox" id="adc-select-all" title="Select/deselect all" /></th>
              <th style="text-align:left;padding:5px 8px;">From (foreign key)</th>
              <th style="text-align:left;padding:5px 8px;">To (referenced primary key)</th>
              <th style="text-align:left;padding:5px 8px;">Source</th>
            </tr></thead>
            <tbody id="adc-tbody">
              ${candidates.map((c, i) => `
                <tr>
                  <td style="padding:4px 8px;"><input type="checkbox" class="adc-row-check" data-idx="${i}" ${selected.has(i) ? 'checked' : ''} /></td>
                  <td style="padding:4px 8px;">${escapeHtml(c.fromTableLabel)}.${escapeHtml(c.fromAttrName)}</td>
                  <td style="padding:4px 8px;">${escapeHtml(c.toTableLabel)}.${escapeHtml(c.toAttrName)}</td>
                  <td style="padding:4px 8px;">${escapeHtml(c.source)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;
      const syncSelectAll = () => {
        const sa = resultsEl.querySelector('#adc-select-all');
        sa.checked = selected.size === candidates.length;
        sa.indeterminate = selected.size > 0 && selected.size < candidates.length;
      };
      resultsEl.querySelectorAll('.adc-row-check').forEach((cb) => {
        cb.addEventListener('change', () => {
          const idx = Number(cb.dataset.idx);
          if (cb.checked) selected.add(idx); else selected.delete(idx);
          syncSelectAll();
        });
      });
      resultsEl.querySelector('#adc-select-all').addEventListener('change', (e) => {
        if (e.target.checked) candidates.forEach((_, i) => selected.add(i));
        else selected.clear();
        renderResults();
      });
      syncSelectAll();
      createBtn.classList.remove('hidden');
    };

    box.querySelector('#adc-detect').addEventListener('click', () => {
      const ddlText = box.querySelector('#adc-ddl').value;
      try {
        candidates = detectConnectorCandidates(this.store, ddlText);
      } catch (err) {
        this.toast(`DDL parse error: ${err.message}`, true);
        return;
      }
      selected.clear();
      candidates.forEach((_, i) => selected.add(i)); // every candidate starts checked
      renderResults();
    });

    createBtn.addEventListener('click', () => {
      const chosen = candidates.filter((_, i) => selected.has(i));
      overlay.remove();
      if (chosen.length === 0) { this.toast('No connectors selected.', true); return; }
      const { created, unplaced } = createDetectedConnectors(this, chosen);
      this.recordAndRender();
      const unplacedSuffix = unplaced > 0 ? ` (${unplaced} not yet placed on any view — both tables aren't shown together anywhere yet)` : '';
      this.toast(`Created ${created} connector${created === 1 ? '' : 's'}${unplacedSuffix}.`);
    });
  }

  /** Data Modeling > Autofill: extracts and calls a top-level `dataAutoFill()` function
   * out of store.batchScriptCode (see DEFAULT_BATCH_SCRIPT_CODE, state.js) and runs it
   * against the current view. Deliberately the SAME compile-and-run mechanism the
   * Script Console's own Run button uses (promptScriptConsole above) — same bindings,
   * same store.batchScriptCode source of truth — just naming a different top-level
   * function as the entry point instead of main(), so this menu item stays live to
   * whatever a person has edited dataAutoFill() into via Advanced > Script Console,
   * rather than running a hidden, separately-maintained copy of the same logic. */
  async promptAutofill() {
    const tab = this.store.activeTab();
    if (!tab || tab.type !== 'canvas') { this.toast('Open a canvas view with Data Entity Details tables first.', true); return; }

    const code = this.store.batchScriptCode || '';
    const bindingNames = ['app', 'store', 'model', 'findParts', 'log', 'messageLog', 'generateIndustry', 'populateFromTemplate', 'remap', 'smartCheckView', 'smartCheckNode', 'insertSmartStream'];
    const logToMessageLog = (...args) => pushMessageLog(this.store, args.map((a) => (typeof a === 'string' ? a : stringifyForConsole(a))).join(' '));
    const bindingValues = [
      this, this.store, this.store.simSelectedModel || null,
      (query) => { const { type, model } = query || {}; return this.store.doc.parts.filter((p) => (!type || ciEq(p.type, type)) && (!model || ciEq(p.model, model))); },
      logToMessageLog, logToMessageLog,
      generateIndustry, populateFromTemplate, remap, smartCheckView, smartCheckNode, insertSmartStream,
    ];

    let fn;
    try {
      fn = new Function(...bindingNames, `${code}\n;return typeof dataAutoFill === 'function' ? dataAutoFill : null;`)(...bindingValues);
    } catch (err) {
      this.toast(`Autofill script has a syntax error: ${err.message}`, true);
      return;
    }
    if (typeof fn !== 'function') {
      this.toast('No dataAutoFill() function found in the batch script — check Advanced > Script Console.', true);
      return;
    }
    try {
      const result = await fn();
      this.toast(typeof result === 'string' ? result : 'Autofill complete.');
    } catch (err) {
      this.toast(err.message || String(err), true);
    }
  }

  /** When a node's label changes and it has a linkedViewName, rename that view to match
   * (view id/viewName are kept identical throughout this app) — "renaming a parent node
   * renames its linked child view too." */
  renameLinkedViewIfNeeded(vm, oldLabel, newLabel) {
    if (!vm.linkedViewName) return;
    const view = this.store.findView(vm.linkedViewName);
    if (!view) return;
    this.store.renameView(vm.linkedViewName, newLabel);
  }

  /** Find-or-create the single catalog tab for a given type (parts/connectors/views/viewMembers). */
  /** Find-or-create the Instructions tab — same find-or-restore pattern as
   * openOrSwitchCatalog, keyed by tab.type === 'docs' since there's only ever one. */
  openOrSwitchDocs() {
    let tab = this.store.tabs.find((t) => t.type === 'docs');
    if (!tab) {
      const closedIdx = this.store.closedTabs.findIndex((t) => t.type === 'docs');
      if (closedIdx !== -1) {
        tab = this.store.closedTabs.splice(closedIdx, 1)[0];
        this.store.tabs.push(tab);
      } else {
        tab = this.store.createTab({ type: 'docs', title: 'Instructions' });
      }
    }
    this.switchToTab(tab.id);
    return tab;
  }

  openOrSwitchCatalog(catalogType, title) {
    let tab = this.store.tabs.find((t) => t.type === 'table' && t.catalogType === catalogType);
    if (!tab) {
      const closedIdx = this.store.closedTabs.findIndex((t) => t.type === 'table' && t.catalogType === catalogType);
      if (closedIdx !== -1) {
        tab = this.store.closedTabs.splice(closedIdx, 1)[0];
        this.store.tabs.push(tab);
      } else {
        tab = this.store.createTab({ type: 'table', title });
        tab.catalogType = catalogType;
      }
    }
    this.switchToTab(tab.id);
    return tab;
  }

  /** Find-or-create the single 3D View tab — one shared tab (like Instructions), not
   * one per anything, since it's a single whole-model visualization rather than scoped
   * to one view/catalog/model the way other tab types are. The actual WebGL scene lives
   * in view3d.js, lazy-loaded the first time this tab renders (see canvas.js's
   * renderView3DPage) — this method only manages the tab itself. */
  openOrSwitch3DView() {
    let tab = this.store.tabs.find((t) => t.type === '3d');
    if (!tab) {
      const closedIdx = this.store.closedTabs.findIndex((t) => t.type === '3d');
      if (closedIdx !== -1) {
        tab = this.store.closedTabs.splice(closedIdx, 1)[0];
        this.store.tabs.push(tab);
      } else {
        tab = this.store.createTab({ type: '3d', title: '3D View' });
      }
    }
    this.switchToTab(tab.id);
    return tab;
  }

  /** Find-or-create the simulation log tab for a given MODEL — same find-or-restore
   * pattern as openOrSwitchCatalog, keyed by simLogModel instead of catalogType. */
  openOrSwitchSimLog(modelName) {
    let tab = this.store.tabs.find((t) => t.type === 'table' && t.simLogModel === modelName);
    if (!tab) {
      const closedIdx = this.store.closedTabs.findIndex((t) => t.type === 'table' && t.simLogModel === modelName);
      if (closedIdx !== -1) {
        tab = this.store.closedTabs.splice(closedIdx, 1)[0];
        this.store.tabs.push(tab);
      } else {
        tab = this.store.createTab({ type: 'table', title: `Sim Log: ${modelName}` });
        tab.simLogModel = modelName;
      }
    }
    this.switchToTab(tab.id);
    return tab;
  }

  /** Advanced > Script Console: a persistent batch-script editor, separate from any one
   * Part's script — for one-shot bulk operations (generate an industry, build a whole
   * view, ...) rather than per-tick simulation behavior. Deliberately more powerful
   * than the sandboxed ctx a Part's script receives (full `app`/`store` access, plus
   * the raw command functions below, not just read-only findParts) since this is an
   * explicit, opt-in tool a person runs on demand — not something a saved document
   * carries and re-executes unattended.
   *
   * The editor's text IS store.batchScriptCode (Local Settings-persisted — see
   * DEFAULT_BATCH_SCRIPT_CODE, state.js, and saveLocalSettings/loadLocalSettings,
   * above/below) — not a one-off REPL entry. Run doesn't execute the text directly:
   * it defines everything in the box (so `function foo() {...}` declarations become
   * callable), then calls exactly one thing, a top-level `main()`, which is free to
   * call whatever else you've defined alongside it (they all share the same closure
   * over the bindings below, so a helper function doesn't need its own copy of
   * `app`/`store` passed in — it just refers to them directly, same as main() does).
   * This is what lets one script file hold several named batch operations
   * (`BatchScript_<Name>` by convention) with main() picking which to run, without
   * ever needing to rename anything to "the" entry point. */
  promptScriptConsole() {
    const modelName = this.store.simSelectedModel;
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box modal-box-textedit';
    box.innerHTML = `<h3>Script Console${modelName ? ` — ${escapeHtml(modelName)}` : ''}</h3>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
        Bindings: <code>app</code>, <code>store</code>, <code>model</code>
        ${modelName ? '' : ' <span style="color:#c0392b;">(no simulation model selected — model will be null)</span>'},
        <code>findParts({type, model})</code>, <code>log(...)</code> (prints below),
        <code>messageLog(...)</code> (writes to the persistent Message Log),
        <code>generateIndustry(app, onProgress, placeInView)</code>,
        <code>populateFromTemplate(app, tab, templateName)</code>,
        <code>remap(app, tab, options)</code> (options: <code>sortKeys, templateName, pattern
        ('default'|'none'|'layered'|'force'), limitColumnsToView, visiblePartVmIds, forcePreferRight,
        forceGroupRows, edgeAssignment</code> ({elementType: 'top'|'bottom'|'left'|'right'},
        'default'/'none' patterns only) <code>, minimizeCrossings, minimizeConnectorLength</code>
        (both boolean, 'default'/'none' patterns only) — all optional, same defaults as the
        Remap dialog),
        <code>smartCheckView(app, tab, options)</code> (options: <code>missingConnectors,
        missingConnectorsAndNodes, levels, syncWithInventory</code>),
        <code>smartCheckNode(app, tab, partId, options)</code> (options: same as
        smartCheckView plus <code>upstream, downstream, byStream, streams</code>),
        <code>insertSmartStream(app, tab, options)</code> (freeform views only; options:
        <code>connectorType</code> ('c'|'s'), <code>startPartIds</code> (array of part
        ids — use <code>findParts</code> to look them up), <code>direction</code>
        ('both'|'downstream'|'upstream'), <code>endType</code> (element type or null),
        <code>levels</code> (number or null for unlimited), <code>showTypes</code>
        (array of element types to keep)). Run (or
        Ctrl+Enter) defines everything below, then calls your top-level <code>main()</code> —
        it can call any other functions you've defined alongside it. Edits are saved
        automatically (Local Settings).
      </div>
      <div id="console-output" style="height:220px;overflow-y:auto;background:var(--bg);border:1px solid var(--border-strong);border-radius:5px;padding:8px;font-family:var(--mono);font-size:12px;white-space:pre-wrap;margin-bottom:8px;"></div>
      <textarea id="console-input" spellcheck="false" style="width:100%;height:260px;font-family:var(--mono);font-size:12px;box-sizing:border-box;border:1px solid var(--border-strong);border-radius:5px;padding:8px;background:var(--bg);color:var(--text);resize:vertical;"></textarea>
      <div class="modal-actions"><button class="cancel">Close</button><button class="primary run">Run main() (Ctrl+Enter)</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    const outputEl = box.querySelector('#console-output');
    const inputEl = box.querySelector('#console-input');
    inputEl.value = this.store.batchScriptCode || '';
    inputEl.focus();

    const appendOutput = (text, color) => {
      const line = document.createElement('div');
      if (color) line.style.color = color;
      line.textContent = text;
      outputEl.appendChild(line);
      outputEl.scrollTop = outputEl.scrollHeight;
    };

    const findPartsForConsole = (query) => {
      const { type, model } = query || {};
      return this.store.doc.parts.filter((p) => (!type || ciEq(p.type, type)) && (!model || ciEq(p.model, model)));
    };

    /** Persists the editor's CURRENT text as store.batchScriptCode, both in memory and
     * to the localStorage cache — called on every Run and on Close, so edits stick
     * across reopening the console even before an explicit File > Save Local
     * Settings. */
    const persist = () => {
      const code = inputEl.value;
      this.store.batchScriptCode = code;
      setCachedBatchScriptCode(code);
    };

    const run = async () => {
      const code = inputEl.value;
      persist();
      if (!code.trim()) return;

      const bindingNames = ['app', 'store', 'model', 'findParts', 'log', 'messageLog', 'generateIndustry', 'populateFromTemplate', 'remap', 'smartCheckView', 'smartCheckNode', 'insertSmartStream'];
      const bindingValues = [
        this, this.store, this.store.simSelectedModel || null,
        findPartsForConsole,
        (...args) => appendOutput(args.map((a) => (typeof a === 'string' ? a : stringifyForConsole(a))).join(' ')),
        (msg) => pushMessageLog(this.store, typeof msg === 'string' ? msg : stringifyForConsole(msg)),
        generateIndustry, populateFromTemplate, remap, smartCheckView, smartCheckNode, insertSmartStream,
      ];

      let result, threw = false, errMessage = '';
      try {
        const mainFn = new Function(...bindingNames, `${code}\n;return typeof main === 'function' ? main : null;`)(...bindingValues);
        if (typeof mainFn !== 'function') {
          threw = true;
          errMessage = "No top-level main() function found — Run calls main(), which can call whatever else you've defined.";
        } else {
          result = await mainFn();
        }
      } catch (err) {
        threw = true;
        errMessage = (err && err.message) ? err.message : String(err);
      }
      if (threw) {
        appendOutput(`Error: ${errMessage}`, '#c0392b');
      } else {
        appendOutput(result !== undefined ? `main() returned: ${stringifyForConsole(result)}` : 'main() completed.', 'var(--accent)');
        this.render();
      }
      inputEl.focus();
    };

    box.querySelector('.run').addEventListener('click', run);
    box.querySelector('.cancel').addEventListener('click', () => { persist(); overlay.remove(); });
    inputEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });
  }

  /** Simulation > Code Summary: a read-only listing of every part's own script — whether
   * currently scriptEnabled or not, since this is a security review of what CODE actually
   * exists in the file (a disabled script could always be re-enabled later), not just
   * what's presently wired to run. Grouped by model, sorted by label within each, and
   * each block clearly identifies its source part (label, type, id, enabled/disabled) so
   * a script can always be traced back to exactly which node it came from before trusting
   * it. Reuses promptTextEdit's readonly mode — the same "larger editor" modal a field's
   * own double-click-to-expand already opens, with the same monospace .text-edit-area —
   * rather than building a new modal for what's fundamentally the same "show me this text
   * in a bigger read-only box" need. */
  promptCodeSummary() {
    const scripted = this.store.doc.parts.filter((p) => (p.script || '').trim().length > 0);
    const batchCode = (this.store.batchScriptCode || '').trim();
    if (scripted.length === 0 && !batchCode) {
      this.promptTextEdit({ title: 'Code Summary', value: 'No parts in this document have a script, and the Script Console is empty.', readonly: true, onSave: () => {} });
      return;
    }
    const lines = [
      'Code Summary',
      'Review before running any unfamiliar simulation or Script Console main(): either runs with full access to the document (createPart/createConnector/findParts) and to any configured API secrets.',
      '',
    ];
    // Script Console's text (Advanced menu) — a personal toolkit of on-demand batch
    // operations, independent of any one document (see store.batchScriptCode's own
    // comment, state.js), shown first since it's a single, always-present block rather
    // than one entry per matching part.
    if (batchCode) {
      lines.push('########## Script Console (Advanced menu) ##########', '', batchCode, '');
    }
    if (scripted.length > 0) {
      const sorted = [...scripted].sort((a, b) =>
        String(a.model || '').localeCompare(String(b.model || '')) || String(a.label || '').localeCompare(String(b.label || '')));
      const modelCount = new Set(sorted.map((p) => p.model)).size;
      lines.push(`########## Part Scripts — ${sorted.length} part${sorted.length === 1 ? '' : 's'} with a script, across ${modelCount} model${modelCount === 1 ? '' : 's'} ##########`, '');
      let currentModel;
      for (const part of sorted) {
        if (part.model !== currentModel) {
          currentModel = part.model;
          lines.push(`==== Model: ${currentModel || '(none)'} ====`, '');
        }
        lines.push(`==== "${part.label}" (${part.type}, id: ${part.id}) — ${part.scriptEnabled ? 'ENABLED' : 'disabled'} ====`);
        lines.push(part.script.trim(), '');
      }
    }
    this.promptTextEdit({ title: 'Code Summary', value: lines.join('\n'), readonly: true, onSave: () => {} });
  }

  /** Clears every part's part.pin3D (right-click-drag positions set in the 3D View —
   * see view3d.js's pointerdown/pointermove/pointerup handlers) back to null in one go,
   * restoring auto-layout for all of them at once. Deliberately a single bulk reset, not
   * a per-part "Unpin" — reported directly: "Create new option somewhere to reset -
   * which clears all 'pinned' new locations." Confirmed first since it touches
   * potentially many parts at once, even though it's undoable like any other store
   * mutation (recordAndRender snapshots history). A no-op (with its own toast) if
   * nothing is currently pinned, rather than a confirm dialog for nothing to confirm. */
  async promptResetPinned3DPositions() {
    const pinned = this.store.doc.parts.filter((p) => p.pin3D);
    if (pinned.length === 0) { this.toast('No parts are currently pinned in the 3D View.'); return; }
    const count = pinned.length;
    if (!(await this.confirmModal(`Reset ${count} pinned 3D position${count === 1 ? '' : 's'} back to auto-layout?`))) return;
    for (const p of pinned) { p.pin3D = null; this.store.touchPart(p); }
    this.recordAndRender();
    this.toast(`Reset ${count} pinned 3D position${count === 1 ? '' : 's'}.`);
  }

  // ===================== SELECTION =====================
  selectOnly(vmId) {
    const tab = this.store.activeTab();
    if (!tab) return;
    tab.selection.clear();
    tab.selection.add(vmId);
    tab.selectedSectionId = null;
    this.render();
  }

  selectSection(tab, sectionInstanceId) {
    tab.selection.clear();
    tab.selectedSectionId = sectionInstanceId;
    this.render();
  }

  insertSection(tab, afterSectionInstanceId) {
    const view = this.store.findView(tab.viewId);
    if (!view) return;
    const newSection = insertSectionAfter(view, afterSectionInstanceId);
    tab.selectedSectionId = newSection.id;
    this.recordAndRender();
    this.toast('Section inserted.');
  }

  removeSection(tab, sectionInstanceId) {
    const view = this.store.findView(tab.viewId);
    if (!view) return;
    removeSectionAndMembers(this.store, view, sectionInstanceId);
    tab.selectedSectionId = null;
    this.recordAndRender();
    this.toast('Section removed.');
  }

  duplicateSection(tab, sectionInstanceId) {
    duplicateSectionCommand(this, tab, sectionInstanceId);
  }

  /** Keyboard Delete/Backspace on the current view's selection. Always removes just the
   * viewMember placement(s) first — a part/connector can legitimately appear on many
   * views, so removing it from THIS one is never destructive on its own. THEN checks
   * whether any of the underlying parts/connectors just lost their LAST placement
   * anywhere (and, for a part specifically, also has no connector still referencing it
   * — deleting a part that's still connected to something would leave that
   * connector's from/to dangling), and if so, offers a single confirm to also delete
   * those from the model entirely (Catalogs > Parts/Connectors), not just this view.
   * Declining leaves them as orphaned-but-real parts/connectors, exactly like today's
   * behavior — this is purely an added option, never a forced cleanup. Reported
   * directly: "check if underlying part or connector is used elsewhere, and if it is
   * not then ask user if it should be deleted from inventory as well." */
  deleteSelection(tab) {
    const selectedVmIds = [...tab.selection];
    const vms = selectedVmIds.map((id) => this.store.findViewMember(id)).filter(Boolean);
    const partIds = new Set(vms.filter((vm) => vm.objectType === 'part').map((vm) => vm.objectId));
    const connIds = new Set(vms.filter((vm) => vm.objectType === 'connector').map((vm) => vm.objectId));

    for (const id of selectedVmIds) this.store.deleteViewMember(id);
    tab.selection.clear();
    this.recordAndRender();

    const orphanedConnIds = [...connIds].filter((id) => !this.store.doc.viewMembers.some((vm) => vm.objectType === 'connector' && ciEq(vm.objectId, id)));
    const orphanedPartIds = [...partIds].filter((id) => {
      const stillPlaced = this.store.doc.viewMembers.some((vm) => vm.objectType === 'part' && ciEq(vm.objectId, id));
      if (stillPlaced) return false;
      const stillConnected = this.store.doc.connectors.some((c) => ciEq(c.from, id) || ciEq(c.to, id));
      return !stillConnected;
    });
    if (orphanedConnIds.length === 0 && orphanedPartIds.length === 0) return;

    const describePart = (id) => { const p = this.store.findPart(id); return p ? `"${p.label}" (${p.type})` : id; };
    const describeConn = (id) => { const c = this.store.findConnector(id); return c ? `${describePart(c.from)} → ${describePart(c.to)}` : id; };
    const names = [...orphanedPartIds.map(describePart), ...orphanedConnIds.map(describeConn)];
    const preview = names.length > 5 ? `${names.slice(0, 5).join(', ')}, and ${names.length - 5} more` : names.join(', ');
    const noun = names.length === 1 ? "isn't" : "aren't";

    this.confirmModal(`${preview} ${noun} used anywhere else in the model. Also delete from the model (not just this view)?`).then((confirmed) => {
      if (!confirmed) return;
      for (const id of orphanedConnIds) this.store.deleteConnectorAndMembers(id);
      for (const id of orphanedPartIds) this.store.deletePart(id);
      this.recordAndRender();
      this.toast(`Deleted ${names.length} item${names.length === 1 ? '' : 's'} from the model.`);
    });
  }

  // ===================== DROP / CREATE =====================
  dropNewPart(tab, elementType, x, y) {
    const el = elementByType(this.store, elementType);
    const resolvedType = el?.type || elementType || 'Unknown';
    const group = (this.store.settings.elementGroups || []).find((g) => ciEq(g.group, el?.group));
    const view = this.store.findView(tab.viewId);

    let finalX = Math.max(0, x - 60), finalY = Math.max(0, y - 20), sectionId = '';
    if (view && isSectionViewType(view.viewType)) {
      const snap = pixelToNearestGrid(view, x, y);
      if (snap) {
        if (!isTypeAllowedInSection(snap.layoutEntry.section, resolvedType)) {
          this.toast(`"${el?.title || resolvedType}" is not allowed in section "${snap.layoutEntry.section.name}".`, true);
          return;
        }
        const free = findFreeCellInSection(this.store, tab.viewId, snap.layoutEntry, snap.row, snap.col);
        finalX = free.x; finalY = free.y; sectionId = snap.layoutEntry.section.sectionId;
      }
    } else {
      const { w: freeNodeW, h: freeNodeH } = getNodeSize(view);
      const free = this.store.findNonOverlappingPosition(tab.viewId, finalX, finalY, undefined, freeNodeW, freeNodeH, view?.spacingScale || 1);
      finalX = free.x; finalY = free.y;
    }

    const part = this.store.createPart({ type: resolvedType, label: resolvedType, model: this.store.defaultModel, streams: [] });
    this.store.createViewMember({ view: tab.viewId, objectType: 'part', objectId: part.id, x: finalX, y: finalY, fillColor: group?.fill || '#cccccc', sectionId });
    this.recordAndRender();
  }

  // ===================== CONNECT =====================
  beginConnect(tab, fromVmId, toVmId, clientX, clientY) {
    const fromVm = this.store.findViewMember(fromVmId);
    const toVm = this.store.findViewMember(toVmId);
    const fromPart = fromVm && this.store.findPart(fromVm.objectId);
    const toPart = toVm && this.store.findPart(toVm.objectId);
    if (!fromPart || !toPart) return;

    // Data Modeling: dragging between two DataEntityDetails tables draws a crow's-foot
    // ('d') relationship instead of a plain 'c' connector -- inferred from both
    // endpoints' own type, the same way stream-generation code already infers 's' by
    // context rather than needing an explicit type picker for the common case. (The
    // connector's own Connector Type field is still editable afterward — see
    // showFields.connector.fields.connectorType — for anyone who wants a 'd'
    // relationship between two OTHER types, or a plain connector between two
    // DataEntityDetails tables.)
    const connectorType = (ciEq(fromPart.type, 'DataEntityDetails') && ciEq(toPart.type, 'DataEntityDetails')) ? 'd' : 'c';

    // enforce a unique (from,to,model,connectorType) combination: if a matching
    // connector already exists anywhere, offer to add THAT one to this view instead of
    // silently creating a duplicate.
    const existing = this.store.findExistingConnector(fromPart.id, toPart.id, this.store.defaultModel, connectorType);
    if (existing) {
      this.confirmModal(`A connector between "${fromPart.label}" and "${toPart.label}" already exists (model "${this.store.defaultModel}"). Add the existing connector to this view instead?`).then((confirmed) => {
        if (!confirmed) return; // decline -> do nothing, never create a duplicate
        const alreadyInView = this.store.viewMembersForView(tab.viewId).some((vm) => vm.objectType === 'connector' && ciEq(vm.objectId, existing.id) && ciEq(vm.fromVmId, fromVm.id) && ciEq(vm.toVmId, toVm.id));
        if (!alreadyInView) {
          this.store.createViewMember({ view: tab.viewId, objectType: 'connector', objectId: existing.id, fromVmId: fromVm.id, toVmId: toVm.id });
          this.recordAndRender();
        }
      });
      return;
    }

    const remembered = this.store.getDefaultRelationship(fromPart.type, toPart.type);
    const dataDefault = defaultRelationKeyFor(this.store, fromPart.type, toPart.type);
    const options = validRelationOptions(this.store, fromPart.type, toPart.type);
    let key;
    if (remembered && (this.store.settings.relations || []).some((r) => ciEq(r.name, remembered))) {
      key = (this.store.settings.relations || []).find((r) => ciEq(r.name, remembered)).key;
    } else if (dataDefault) {
      key = dataDefault; // settings.relationshipPairs.default (or its first-allowed fallback)
    } else if (options.length > 0) {
      key = options[0].key;
    } else {
      key = 'x'; // Not Configured
    }
    this.finishConnect(tab, fromVm, toVm, key, connectorType);
  }

  finishConnect(tab, fromVm, toVm, relationKey, connectorType = 'c') {
    const rel = (this.store.settings.relations || []).find((r) => r.key === relationKey);

    // Data Modeling: a manually drag-created 'd' (crow's-foot) connector auto-creates a
    // matching FK attribute on the target if one doesn't already exist, instead of
    // leaving the person to build it by hand. Reported directly: "when connector
    // dragged/created, auto create a fk in target of primary key from source, if it
    // doesn't exist ... Auto populate From Cardinality as One, and To Cardinality as
    // Many. Connectors are created from parent to children." This is the REVERSE of
    // importDDL's own convention (fromCardinality: 'many', toCardinality: 'one') —
    // there, "from" is DDL's referencing/child table (its own FOREIGN KEY clause names
    // it), so "many" is correct on that side; here "from" is the parent/PK side being
    // dragged from, so "one" is correct on that side. Two different, intentionally
    // non-conflicting conventions for two different creation paths, not a bug to
    // reconcile between them.
    let fromAttribute, toAttribute, fromCardinality, toCardinality;
    if (connectorType === 'd') {
      const fromPart = this.store.findPart(fromVm.objectId);
      const toPart = this.store.findPart(toVm.objectId);
      const pkAttr = (fromPart?.attributes || []).find((a) => a.isPrimaryKey);
      if (pkAttr) {
        const fkName = `${toSnakeCase(fromPart.label)}_${toSnakeCase(pkAttr.name)}`;
        let fkAttr = (toPart.attributes || []).find((a) => ciEq(a.name, fkName));
        if (!fkAttr) {
          fkAttr = { id: newId(), name: fkName, dataType: pkAttr.dataType, nullable: false, isPrimaryKey: false };
          toPart.attributes = [...(toPart.attributes || []), fkAttr];
        }
        fromAttribute = pkAttr.id;
        toAttribute = fkAttr.id;
        fromCardinality = 'one';
        toCardinality = 'many';
      }
    }

    const conn = this.store.createConnector({ from: fromVm.objectId, to: toVm.objectId, model: this.store.defaultModel, connectorType, relationship: rel?.name || 'Association', fromAttribute, toAttribute, fromCardinality, toCardinality });
    this.store.createViewMember({ view: tab.viewId, objectType: 'connector', objectId: conn.id, fromVmId: fromVm.id, toVmId: toVm.id });
    this.recordAndRender();
  }

  applyRelationToConnector(conn, relationKey) {
    const rel = (this.store.settings.relations || []).find((r) => r.key === relationKey);
    const style = (this.store.settings.relationshipStyles || []).find((s) => ciEq(s.code, relationKey));
    conn.relationship = rel?.name || conn.relationship;
    if (style) {
      conn.stroke = style.stroke; conn.strokeNormal = style.stroke;
      conn.strokeWidth = style.strokeWidth; conn.strokeWidthNormal = style.strokeWidth;
      conn.dash = style.dash || []; conn.fill = style.fill;
    }
    // remember this as the user's chosen default for this (typeA,typeB) pair going forward
    const fromPart = this.store.findPart(conn.from);
    const toPart = this.store.findPart(conn.to);
    if (fromPart && toPart && rel) this.store.setDefaultRelationship(fromPart.type, toPart.type, rel.name);
  }

  showCanvasContextMenu(clientX, clientY, canvasPos) {
    document.querySelectorAll('.canvas-context-menu').forEach((m) => m.remove());
    const defs = getCommandDefs(this);
    const menu = document.createElement('div');
    menu.className = 'edge-popover canvas-context-menu';
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    menu.innerHTML = defs.map((d) => `
      <div class="dd-item cmd-context-item ${d.enabled ? '' : 'disabled'}" data-key="${d.key}">
        <span class="cmd-context-icon">${CMD_ICONS[d.key]}</span>${escapeHtml(d.label)}
      </div>`).join('');
    document.getElementById('modal-root').appendChild(menu);
    menu.querySelectorAll('.cmd-context-item').forEach((item) => {
      item.addEventListener('click', () => {
        const def = defs.find((d) => d.key === item.dataset.key);
        if (!def || !def.enabled) return;
        menu.remove();
        this.runCommand(item.dataset.key, canvasPos);
      });
    });
    const closer = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', closer); } };
    setTimeout(() => document.addEventListener('pointerdown', closer), 10);
  }

  showRelationPicker(clientX, clientY, options, onPick) {
    const pop = document.createElement('div');
    pop.className = 'edge-popover';
    pop.style.left = `${clientX}px`;
    pop.style.top = `${clientY}px`;
    pop.innerHTML = `<div style="margin-bottom:4px;font-weight:600;">Choose relationship</div>` +
      options.map((o) => `<div class="dd-item" data-key="${o.key}" style="padding:4px 6px;border-radius:4px;cursor:pointer;">${escapeHtml(o.name)}</div>`).join('');
    document.getElementById('modal-root').appendChild(pop);
    pop.querySelectorAll('.dd-item').forEach((item) => {
      item.addEventListener('mouseenter', () => item.style.background = 'var(--accent-soft)');
      item.addEventListener('mouseleave', () => item.style.background = '');
      item.addEventListener('click', () => { onPick(item.dataset.key); pop.remove(); document.removeEventListener('pointerdown', closer); });
    });
    const closer = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', closer); } };
    setTimeout(() => document.addEventListener('pointerdown', closer), 10);
  }

  showEdgePopover(cvm, conn, clientX, clientY) {
    document.querySelectorAll('.edge-popover').forEach((p) => p.remove());
    // Same filtering the property panel's Relationship select already uses
    // (validRelationOptions, keyed by the connector's actual from/to element types) —
    // this popup was instead listing every relation in settings.relations
    // unconditionally, letting someone pick a relationship the two connected types
    // don't actually allow. Falls back to the full list only if neither endpoint
    // resolves to a real part (shouldn't normally happen for an existing connector),
    // so the popup never ends up completely empty.
    const fromPart = this.store.findPart(conn.from);
    const toPart = this.store.findPart(conn.to);
    const validOptions = (fromPart && toPart) ? validRelationOptions(this.store, fromPart.type, toPart.type) : [];
    const relations = validOptions.length > 0 ? validOptions : (this.store.settings.relations || []);
    const relOptions = relations.map((r) => `<option value="${r.key}" ${ciEq(r.name, conn.relationship) ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
    const pop = document.createElement('div');
    pop.className = 'edge-popover';
    pop.style.left = `${clientX}px`;
    pop.style.top = `${clientY}px`;
    pop.innerHTML = `<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(conn.relationship || 'Connector')}</div><select>${relOptions}</select>`;
    document.getElementById('modal-root').appendChild(pop);
    pop.querySelector('select').addEventListener('change', (e) => { this.applyRelationToConnector(conn, e.target.value); this.store.touchConnector(conn); this.recordAndRender(); pop.remove(); this.promptSyncInventoryConnector(conn); });
    const closer = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', closer); } };
    setTimeout(() => document.addEventListener('pointerdown', closer), 10);
  }

  // ===================== COMMANDS =====================
  runCommand(key, canvasPos) {
    const tab = this.store.activeTab();
    if (!tab || tab.type !== 'canvas') return;
    const selIds = [...tab.selection];

    if (key === 'duplicateStream') {
      const vm = this.store.findViewMember(selIds[0]);
      const part = vm && this.store.findPart(vm.objectId);
      if (!part || !(part.streams || []).length) return;
      const original = part.streams[0];
      this.promptModal({
        title: 'Duplicate Stream',
        fields: [{ key: 'name', label: 'New stream name', value: nextStreamName(original) }],
        onSubmit: (vals) => duplicateStream(this, tab, vm.id, vals.name),
      });
    } else if (key === 'splitNode') {
      splitNode(this, tab, selIds[0]);
    } else if (key === 'levelUp') {
      // Data Modeling: Level Up on a single selected DataEntityDetails node is the
      // reverse of Level Down on a DataDataEntity -- create/open its DataDataEntity
      // parent directly, no dialog, same as double-click/"Add/Edit Entity Details"
      // needing no dialog in the other direction. Every other selection (none,
      // multiple, or a different type) keeps the ordinary "prompt for a new view
      // name" Level Up unchanged.
      const singleVm = selIds.length === 1 ? this.store.findViewMember(selIds[0]) : null;
      const singlePart = singleVm && singleVm.objectType === 'part' && this.store.findPart(singleVm.objectId);
      if (singlePart && ciEq(singlePart.type, 'DataEntityDetails')) {
        levelUpEntityDetails(this, tab, singleVm.id);
      } else {
        this.promptModal({
          title: 'Level Up',
          fields: [{ key: 'name', label: 'New view name', value: 'New View' }],
          onSubmit: (vals) => levelUp(this, tab, vals.name),
        });
      }
    } else if (key === 'levelDown') {
      levelDown(this, tab, selIds);
    } else if (key === 'generate') {
      this.promptGenerateStream(tab, canvasPos);
    } else if (key === 'copy') {
      copyNodes(this, tab);
    } else if (key === 'paste') {
      this.promptPaste(tab, canvasPos);
    } else if (key === 'remap') {
      this.promptRemap(tab);
    } else if (key === 'merge') {
      this.promptMerge(tab, selIds);
    } else if (key === 'redraw') {
      // Uses redrawAndResolveLayout, not the bare resize — resizing alone can leave
      // nodes overlapping if they grew (a real bug: redraw used to call redrawNodeSizes
      // directly, skipping the overlap-resolution pass every other resize path already
      // used). This still only nudges genuinely-overlapping nodes to the nearest free
      // spot — it does not reposition everything the way Remap does.
      const did = redrawAndResolveLayout(this, tab);
      if (did) {
        this.store.normalizeViewCoordinates(tab.viewId);
        this.recordAndRender();
        this.toast('Node sizes redrawn and coordinates normalized for this view.');
      }
      else this.toast('No nodes in this view to measure.', true);
    } else if (key === 'addExisting') {
      this.promptAddExisting(tab, canvasPos);
    } else if (key === 'populateFromTemplate') {
      this.promptPopulateFromTemplate(tab);
    } else if (key === 'insertSmartStream') {
      this.promptInsertSmartStream(tab);
    } else if (key === 'smartCheckNode') {
      this.promptSmartCheckNode(tab);
    }
  }

  /** Bespoke (not the generic promptModal) so Stream Name can drive the other fields:
   * typing/picking an EXISTING stream name (native <input list> + <datalist>, same
   * discoverability pattern Function Name already used) prepopulates Function/Capability/
   * Application Capability/Entity Name from that stream's own already-generated parts (see
   * commands.js's deriveStreamNames — reads only the 4 canonical "precise category match"
   * types, so it works regardless of which template originally generated the stream), and
   * switches the template to one with an Application Capability level if the stream has one. A
   * brand-new stream name leaves every field at its own default, untouched. Actual
   * reuse-by-label-match for the parts/nodes themselves already happens inside
   * createStream (Step 33) — this dialog only pre-fills what to type, it doesn't
   * duplicate that check. */
  promptGenerateStream(tab, canvasPos) {
    const store = this.store;
    const templates = (store.settings.streamTemplates || []).map((t) => t.name);
    const cachedTemplate = getCachedStreamTemplate();
    const defaultTemplate = (cachedTemplate && templates.includes(cachedTemplate)) ? cachedTemplate : (templates.includes('Enterprise') ? 'Enterprise' : templates[0]);
    const existingFunctionNames = [...new Set(
      store.doc.parts
        .filter((p) => ciEq(p.type, 'BusinessFunction') && ciEq(p.model, store.defaultModel))
        .map((p) => p.label)
    )];
    const existingStreamNames = [...new Set(
      store.doc.parts
        .filter((p) => ciEq(p.model, store.defaultModel))
        .flatMap((p) => p.streams || [])
    )].sort();
    const templateHasAppCap = (name) => {
      const t = (store.settings.streamTemplates || []).find((tt) => ciEq(tt.name, name));
      return !!(t && t.applicationCapabilityNameBegin);
    };

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Generate Stream</h3>
      <div class="prop-row"><label>Stream template</label><select id="gs-template">${templates.map((n) => `<option value="${escapeHtml(n)}" ${n === defaultTemplate ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select></div>
      <div class="prop-row"><label>Stream name</label><input type="text" id="gs-stream" list="gs-stream-datalist" value="${escapeHtml(`Stream-${Date.now().toString().slice(-4)}`)}" /><datalist id="gs-stream-datalist">${existingStreamNames.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist></div>
      <div class="prop-row"><label>Function Name</label><input type="text" id="gs-function" list="gs-function-datalist" value="${escapeHtml(existingFunctionNames.length ? '' : 'testFunction')}" /><datalist id="gs-function-datalist">${existingFunctionNames.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist></div>
      <div class="prop-row"><label>Capability Name</label><input type="text" id="gs-capability" value="testCapability" /></div>
      <div class="prop-row hidden" id="gs-application-capability-row"><label>Application Capability Name</label><input type="text" id="gs-application-capability" value="testApplicationCapability" /></div>
      <div class="prop-row"><label>Entity Name</label><input type="text" id="gs-entity" value="testEntity" /></div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Generate</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    const templateSelect = box.querySelector('#gs-template');
    const appCapRow = box.querySelector('#gs-application-capability-row');
    const updateAppCapVisibility = () => appCapRow.classList.toggle('hidden', !templateHasAppCap(templateSelect.value));
    templateSelect.addEventListener('change', updateAppCapVisibility);
    updateAppCapVisibility();

    const streamInput = box.querySelector('#gs-stream');
    streamInput.addEventListener('input', () => {
      const name = streamInput.value;
      if (!existingStreamNames.includes(name)) return; // only act on an exact match to an existing stream
      const derived = deriveStreamNames(store, name);
      if (derived.functionName != null) box.querySelector('#gs-function').value = derived.functionName;
      if (derived.capabilityName != null) box.querySelector('#gs-capability').value = derived.capabilityName;
      if (derived.applicationCapabilityName != null) box.querySelector('#gs-application-capability').value = derived.applicationCapabilityName;
      if (derived.entityName != null) box.querySelector('#gs-entity').value = derived.entityName;
      if (derived.hasApplicationCapability && !templateHasAppCap(templateSelect.value)) {
        const appCapTemplate = templates.find((n) => templateHasAppCap(n));
        if (appCapTemplate) { templateSelect.value = appCapTemplate; updateAppCapVisibility(); }
      }
    });

    box.querySelector('input,select')?.focus();
    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('.submit').addEventListener('click', () => {
      // Function Name now defaults to blank (rather than a placeholder value) when
      // existing functions are available, so leaving it empty on submit is a real
      // possibility, not just a leftover default — guard against silently creating
      // a part with a blank label.
      const functionName = box.querySelector('#gs-function').value;
      if (!functionName.trim()) { this.toast('Function Name is required.', true); return; }
      const templateName = templateSelect.value;
      const streamName = streamInput.value;
      const capabilityName = box.querySelector('#gs-capability').value;
      const applicationCapabilityName = templateHasAppCap(templateName) ? box.querySelector('#gs-application-capability').value : undefined;
      const entityName = box.querySelector('#gs-entity').value;
      overlay.remove();
      setCachedStreamTemplate(templateName);
      createStream(this, {
        templateName, streamName, functionName, capabilityName, applicationCapabilityName, entityName,
        modelName: store.defaultModel, viewName: store.currentView,
        anchorX: canvasPos?.x, anchorY: canvasPos?.y,
      });
    });
  }

  promptPopulateFromTemplate(tab) {
    const view = this.store.findView(tab.viewId);
    const candidates = (this.store.settings.templates || []).filter((t) => (t.viewTypes || []).some((vt) => ciEq(vt, view?.viewType)));
    if (candidates.length === 0) { this.toast(`No page templates available for view type "${view?.viewType}".`, true); return; }
    const names = candidates.map((t) => t.name);
    this.promptModal({
      title: 'Populate From Template',
      fields: [
        { key: 'template', label: 'Template', type: 'select', options: names, value: names[0] },
      ],
      onSubmit: (vals) => populateFromTemplate(this, tab, vals.template),
    });
  }

  /** Bespoke (not the generic promptModal, which has no checklist field type) —
   * "Insert Smart Stream" (freeform views only; insertSmartStream itself rejects with a
   * toast naming the rule if the current view is section-based, same convention as
   * every other view-type-restricted command in this app). Reported directly: "Add
   * ability in freeform view to insert a smartStream. Through a dialog the user
   * selects connector type..., starting element..., upstream/downstream or both
   * indicator, ending element..., children levels..., and a selector checklist of
   * element types to show." Starting/Ending Element options are scoped to types
   * actually PRESENT in this model's own parts (an element type nothing exists for yet
   * can never be reached by a traversal anyway); Element Types to Show lists every
   * known element type (the traversal can discover any of them along the way),
   * defaulting to all-checked — same Select-All/Exclude-All pattern the toolbar's own
   * Type filter already uses. Picking a Starting Element type populates a second
   * checklist of that type's actual instances (also all-checked by default) so the
   * user can narrow the trace down to specific starting part(s), not just "every part
   * of this type" — re-rendered on every Starting Element change. Laid out as a wide,
   * two-column dialog (modal-box-wide): single-line fields in a 2-col grid up top, then
   * the Starting Element Instances and Element Types to Show checklists side by side —
   * shorter overall than stacking everything in the default narrow single column.
   * Element Types to Show, like Starting/Ending Element, only lists types actually
   * present in the current default model (an element type nothing exists for yet can
   * never end up in the traced result anyway). A Preset row (top of the dialog) can
   * save the current field values as a named smartStreamPreset (store.smartStreamPresets
   * — Local Settings, cached to localStorage and bundled into File > Save/Load Local
   * Settings, deliberately never touching the document/save file) or load one back in.
   * A preset remembers its starting element by TYPE + part LABEL(s), not raw part
   * id(s), so it can still resolve against a regenerated or different document later —
   * any label that no longer matches a real part is simply left unchecked on load. */
  promptInsertSmartStream(tab) {
    const store = this.store;
    const view = store.findView(tab.viewId);
    if (view && isSectionViewType(view.viewType)) {
      this.toast(`Insert Smart Stream only applies to freeform views — this view is section-based ("${view.viewType}").`, true);
      return;
    }
    const modelParts = store.doc.parts.filter((p) => ciEq(p.model, store.defaultModel));
    const typesInUse = [...new Set(modelParts.map((p) => p.type))]
      .map((type) => { const el = elementByType(store, type); return { type, title: el?.title || type }; })
      .sort((a, b) => a.title.localeCompare(b.title));
    if (typesInUse.length === 0) { this.toast(`No parts in model "${store.defaultModel}" to trace a stream from.`, true); return; }
    const instancesForType = (type) => modelParts.filter((p) => ciEq(p.type, type)).sort((a, b) => (a.label || '').localeCompare(b.label || ''));

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box modal-box-wide';
    box.innerHTML = `<h3>Insert Smart Stream</h3>
      <div class="prop-row"><label>Preset</label><select id="ss-preset-select">
        <option value="">(none)</option>
        ${(store.smartStreamPresets || []).map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('')}
      </select><button type="button" id="ss-preset-load">Load</button><button type="button" id="ss-preset-save">Save As…</button></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px;">
        <div class="prop-row"><label>Connector Type</label><select id="ss-connector-type">
          <option value="c">Connectors (c)</option>
          <option value="s">Streams (s)</option>
          <option value="d">Data (d)</option>
        </select></div>
        <div class="prop-row"><label>Direction</label><select id="ss-direction">
          <option value="both">Both</option>
          <option value="downstream">Downstream</option>
          <option value="upstream">Upstream</option>
        </select></div>
        <div class="prop-row"><label>Starting Element</label><select id="ss-start-type">${typesInUse.map((t) => `<option value="${escapeHtml(t.type)}">${escapeHtml(t.title)}</option>`).join('')}</select></div>
        <div class="prop-row"><label>Ending Element</label><select id="ss-end-type">
          <option value="">(none)</option>
          ${typesInUse.map((t) => `<option value="${escapeHtml(t.type)}">${escapeHtml(t.title)}</option>`).join('')}
        </select></div>
        <div class="prop-row"><label>Children Levels</label><input type="number" id="ss-levels" min="0" step="1" placeholder="Unlimited" title="How many hops beyond the starting element to include (blank = unlimited)." /></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px;margin-top:8px;">
        <div>
          <div style="font-size:12px;color:var(--text-muted);">Starting Element Instances</div>
          <div class="prop-row checkbox"><input type="checkbox" id="ss-start-select-all" checked /><label for="ss-start-select-all">Select All / Exclude All</label></div>
          <div id="ss-start-instances-list" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:5px;padding:6px 8px;"></div>
        </div>
        <div>
          <div style="font-size:12px;color:var(--text-muted);">Element Types to Show</div>
          <div class="prop-row checkbox"><input type="checkbox" id="ss-types-select-all" checked /><label for="ss-types-select-all">Select All / Exclude All</label></div>
          <div id="ss-types-list" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:5px;padding:6px 8px;">
            ${typesInUse.map((t) => `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;"><input type="checkbox" class="ss-type-cb" value="${escapeHtml(t.type)}" checked />${escapeHtml(t.title)}</label>`).join('')}
          </div>
        </div>
      </div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Insert</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    const startInstanceCbs = () => [...box.querySelectorAll('.ss-start-instance-cb')];
    const renderStartInstances = () => {
      const type = box.querySelector('#ss-start-type').value;
      const instances = instancesForType(type);
      box.querySelector('#ss-start-instances-list').innerHTML = instances.map((p) => `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;"><input type="checkbox" class="ss-start-instance-cb" value="${escapeHtml(p.id)}" checked />${escapeHtml(p.label || p.id)}</label>`).join('');
      box.querySelector('#ss-start-select-all').checked = true;
      startInstanceCbs().forEach((cb) => cb.addEventListener('change', () => {
        box.querySelector('#ss-start-select-all').checked = startInstanceCbs().every((c) => c.checked);
      }));
    };
    box.querySelector('#ss-start-type').addEventListener('change', renderStartInstances);
    box.querySelector('#ss-start-select-all').addEventListener('change', (e) => {
      startInstanceCbs().forEach((cb) => { cb.checked = e.target.checked; });
    });
    renderStartInstances();

    const typeCbs = () => [...box.querySelectorAll('.ss-type-cb')];
    box.querySelector('#ss-types-select-all').addEventListener('change', (e) => {
      typeCbs().forEach((cb) => { cb.checked = e.target.checked; });
    });
    typeCbs().forEach((cb) => cb.addEventListener('change', () => {
      box.querySelector('#ss-types-select-all').checked = typeCbs().every((c) => c.checked);
    }));

    box.querySelector('#ss-preset-load').addEventListener('click', () => {
      const name = box.querySelector('#ss-preset-select').value;
      if (!name) { this.toast('Select a preset to load.', true); return; }
      const preset = (store.smartStreamPresets || []).find((p) => p.name === name);
      if (!preset) { this.toast(`Preset "${name}" not found.`, true); return; }

      box.querySelector('#ss-connector-type').value = preset.connectorType || 'c';
      box.querySelector('#ss-direction').value = preset.direction || 'both';
      box.querySelector('#ss-end-type').value = preset.endType || '';
      box.querySelector('#ss-levels').value = preset.levels != null ? String(preset.levels) : '';

      const startTypeSelect = box.querySelector('#ss-start-type');
      const hasStartType = [...startTypeSelect.options].some((o) => o.value === preset.startType);
      if (hasStartType) startTypeSelect.value = preset.startType;
      renderStartInstances();
      const labels = new Set(preset.startInstanceLabels || []);
      let matchedAny = false;
      startInstanceCbs().forEach((cb) => {
        const match = labels.has(cb.closest('label').textContent.trim());
        cb.checked = match;
        if (match) matchedAny = true;
      });
      box.querySelector('#ss-start-select-all').checked = startInstanceCbs().length > 0 && startInstanceCbs().every((c) => c.checked);

      const showSet = new Set(preset.showTypes || []);
      typeCbs().forEach((cb) => { cb.checked = showSet.has(cb.value); });
      box.querySelector('#ss-types-select-all').checked = typeCbs().length > 0 && typeCbs().every((c) => c.checked);

      const warnings = [];
      if (!hasStartType) warnings.push(`Starting Element type "${preset.startType}" has no parts in this model — left unchanged.`);
      if (!matchedAny) warnings.push("none of the preset's starting instance labels were found — check Starting Element Instances manually.");
      this.toast(warnings.length ? `Preset "${name}" loaded (${warnings.join(' ')})` : `Preset "${name}" loaded.`, warnings.length > 0);
    });

    box.querySelector('#ss-preset-save').addEventListener('click', () => {
      this.promptModal({
        title: 'Save Smart Stream Preset',
        fields: [{ key: 'name', label: 'Preset Name', value: box.querySelector('#ss-preset-select').value || '' }],
        onSubmit: (vals) => {
          const name = (vals.name || '').trim();
          if (!name) { this.toast('Preset name is required.', true); return; }
          const levelsRaw = box.querySelector('#ss-levels').value.trim();
          const preset = {
            name,
            connectorType: box.querySelector('#ss-connector-type').value,
            startType: box.querySelector('#ss-start-type').value,
            startInstanceLabels: startInstanceCbs().filter((c) => c.checked).map((c) => c.closest('label').textContent.trim()),
            direction: box.querySelector('#ss-direction').value,
            endType: box.querySelector('#ss-end-type').value || null,
            levels: levelsRaw === '' ? null : Math.max(0, parseInt(levelsRaw, 10) || 0),
            showTypes: typeCbs().filter((c) => c.checked).map((c) => c.value),
          };
          const list = [...(store.smartStreamPresets || [])];
          const idx = list.findIndex((p) => p.name === name);
          if (idx >= 0) list[idx] = preset; else list.push(preset);
          store.smartStreamPresets = list;
          setCachedSmartStreamPresets(list);
          // Refresh the Preset dropdown in place so the new/updated name is selectable immediately.
          const sel = box.querySelector('#ss-preset-select');
          sel.innerHTML = `<option value="">(none)</option>${list.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('')}`;
          sel.value = name;
          this.toast(`Saved preset "${name}".`);
        },
      });
    });

    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('.submit').addEventListener('click', () => {
      const startPartIds = startInstanceCbs().filter((c) => c.checked).map((c) => c.value);
      if (startPartIds.length === 0) { this.toast('Select at least one Starting Element Instance.', true); return; }
      const levelsRaw = box.querySelector('#ss-levels').value.trim();
      const options = {
        connectorType: box.querySelector('#ss-connector-type').value,
        startPartIds,
        direction: box.querySelector('#ss-direction').value,
        endType: box.querySelector('#ss-end-type').value || null,
        levels: levelsRaw === '' ? null : Math.max(0, parseInt(levelsRaw, 10) || 0),
        showTypes: typeCbs().filter((c) => c.checked).map((c) => c.value),
      };
      overlay.remove();
      insertSmartStream(this, tab, options);
    });
  }

  /** Bespoke (not the generic promptModal) so it can carry the "Place on current view"
   * checkbox. Only one industry dataset ever exists (see state.js's doc.industryTree
   * comment), so there's no picker to show — just confirms there IS data loaded at all.
   * To review the dataset before generating, use Catalogs > SFCCE first, separately —
   * this dialog is a modal overlay (like every other modal in the app; see CLAUDE.md's
   * "no click-outside-to-close" convention), so nothing behind it is reachable while
   * it's open, which ruled out a "preview" button that would open the catalog in
   * another tab the person still couldn't see. */
  promptGenerateIndustry() {
    if (!this.store.doc.industryTree || this.store.doc.industryTree.length === 0) {
      this.toast('No industry data loaded — use File > Load SFCCE.', true);
      return;
    }

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Generate Industry</h3>
      <div class="prop-row checkbox"><input type="checkbox" id="gi-place-view" /><label for="gi-place-view">Place on current view</label></div>
      <div style="font-size:11px;color:var(--text-muted);margin:-4px 0 12px 0;">Unchecked: creates the parts/connectors only — much faster for a large dataset, but nothing is placed on any view. Review via Catalogs &gt; Parts, then Add Existing to bring chosen ones into a view.</div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Generate</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('.submit').addEventListener('click', () => {
      const placeInView = box.querySelector('#gi-place-view').checked;
      overlay.remove();
      this.runGenerateIndustryWithProgress(placeInView);
    });
  }

  /** Generate Industry can mean thousands of individual createStream calls on a large
   * imported dataset (see Load SFCE) — generateIndustry is async and yields
   * periodically specifically so this can show real progress instead of the tab
   * appearing to freeze for however long the whole operation takes. */
  async runGenerateIndustryWithProgress(placeInView = true) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Generating…</h3><p id="gi-progress-text">Starting…</p>`;
    overlay.appendChild(box);
    root.appendChild(overlay);
    const progressText = box.querySelector('#gi-progress-text');
    try {
      await generateIndustry(this, (done, total) => {
        progressText.textContent = `${done} / ${total} capabilities processed…`;
      }, placeInView);
    } finally {
      overlay.remove();
    }
  }

  /** Catalogs > SFCCE: a read-only, flattened table of the single loaded industry
   * dataset's Section/Function/Capability/Application Capability/Entity hierarchy (the
   * built-in default, or whatever File > Load SFCCE last replaced it with). Read-only
   * for now; the request notes this'll be expanded to a showFields-driven editor at a
   * later step, so this deliberately doesn't try to anticipate that — just a real,
   * working table today. */
  promptSfceCatalog() {
    if (!this.store.doc.industryTree || this.store.doc.industryTree.length === 0) {
      this.toast('No industry data loaded — use File > Load SFCCE.', true);
      return;
    }
    this.openOrSwitchSfceCatalog();
  }

  /** Find-or-create pattern matching openOrSwitchCatalog — only one SFCCE Catalog tab
   * ever exists (only one industry dataset does). Always refreshes tableRows/tableCols
   * from the CURRENT store.doc.industryTree, whether the tab is newly created, reused,
   * or restored from closedTabs, since Load SFCCE can replace the underlying data out
   * from under an already-open tab. */
  openOrSwitchSfceCatalog() {
    let tab = this.store.tabs.find((t) => t.type === 'table' && t.sfceCatalog);
    if (!tab) {
      const closedIdx = this.store.closedTabs.findIndex((t) => t.type === 'table' && t.sfceCatalog);
      if (closedIdx !== -1) {
        tab = this.store.closedTabs.splice(closedIdx, 1)[0];
        this.store.tabs.push(tab);
      } else {
        tab = this.store.createTab({ type: 'table', title: 'SFCCE Catalog' });
        tab.sfceCatalog = true;
      }
    }
    tab.tableRows = flattenIndustryTree(this.store.doc.industryTree || []);
    // Reported directly: "when I open catalog SFCCE I don't see these section
    // descriptions." Each row's own sectionDescription comes straight from the
    // imported/generated SFCCE data (nodeSectionDescription, sfce.js) -- populated
    // only when a Load SFCCE field mapping supplies a sectionDescriptionField. The
    // BUILT-IN default dataset's own mapping (GENERAL_SFCCE_MAPPING, data.js) never
    // has, so this column was always blank for the data most people are actually
    // looking at here. Fill in the gap (never override a row that already has its
    // own real description) from custom.json's own org-viewType section definitions
    // -- the same known-Section descriptions the Industry_to_SFCCE AI prompt
    // (Instructions tab) already gives an AI, by matching this row's own sectionId
    // against theirs, the identical sectionId->name lookup pattern already used for
    // Load SFCCE's own shared-section dialog (promptSFCCEMapping, below).
    const orgSectionDefs = this.store.settings.sections || [];
    for (const row of tab.tableRows) {
      if (row.sectionDescription || !row.sectionId) continue;
      const def = orgSectionDefs.find((s) => ciEq(s.viewType, 'org') && s.sectionId === row.sectionId);
      if (def?.description) row.sectionDescription = def.description;
    }
    tab.tableCols = ['section', 'sectionId', 'sectionDescription', 'sectionOrder', 'functionId', 'functionName', 'functionDescription', 'capabilityId', 'capabilityName', 'capabilityDescription', 'applicationCapabilityId', 'applicationCapabilityName', 'applicationCapabilityDescription', 'entityId', 'entityName', 'entityDescription'];
    this.switchToTab(tab.id);
    return tab;
  }

  /** Smart Check View (Advanced menu): repairs gaps between the current view's placed
   * content and the underlying model — missing connectors between already-placed nodes,
   * and optionally missing nodes+connectors reachable within N hops of what's already
   * on the view. Bespoke modal (not the generic promptModal) since the second
   * checkbox's Levels field needs to show/hide based on the checkbox's own state, the
   * same pattern already used for Remap's force-directed option. */
  promptSmartCheckView() {
    const tab = this.store.activeTab();
    if (!tab || tab.type !== 'canvas') { this.toast('Open a view to Smart Check first.', true); return; }
    const templateNames = (this.store.settings.streamTemplates || []).map((t) => t.name);
    const cachedTemplate = getCachedStreamTemplate();
    const defaultTemplate = (cachedTemplate && templateNames.includes(cachedTemplate)) ? cachedTemplate : (templateNames.includes('Enterprise') ? 'Enterprise' : templateNames[0]);
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Smart Check View</h3>
      <div class="prop-row checkbox"><input type="checkbox" id="scv-missing-connectors" checked /><label for="scv-missing-connectors">Missing connectors — add connectors between nodes already on this view</label></div>
      <div class="prop-row checkbox"><input type="checkbox" id="scv-missing-connectors-nodes" /><label for="scv-missing-connectors-nodes">Missing connectors and nodes — also pull in connected nodes not yet on this view</label></div>
      <div class="prop-row" id="scv-levels-row" style="margin-left:22px;"><label>Levels</label><input type="number" id="scv-levels-input" class="tb-select" style="width:60px;" min="0" step="1" value="" placeholder="All" title="How many hops of missing connected nodes to pull in. Blank = unlimited." /></div>
      <div class="prop-row checkbox"><input type="checkbox" id="scv-autocomplete" /><label for="scv-autocomplete">Auto-complete streams in model — find existing stream names and fill in any missing parts/nodes for them, following a stream template</label></div>
      <div class="prop-row" id="scv-autocomplete-template-row" style="margin-left:22px;"><label>Stream Template</label><select id="scv-autocomplete-template">${templateNames.map((n) => `<option value="${escapeHtml(n)}" ${n === defaultTemplate ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select></div>
      <div class="prop-row checkbox"><input type="checkbox" id="scv-sync-inventory" /><label for="scv-sync-inventory">Sync existing connectors with inventory — update this view's connectors to match their related part-to-part connector where they differ</label></div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Check</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    const nodesCheckbox = box.querySelector('#scv-missing-connectors-nodes');
    const levelsRow = box.querySelector('#scv-levels-row');
    const updateLevelsVisibility = () => levelsRow.classList.toggle('hidden', !nodesCheckbox.checked);
    nodesCheckbox.addEventListener('change', updateLevelsVisibility);
    updateLevelsVisibility();

    const autoCompleteCheckbox = box.querySelector('#scv-autocomplete');
    const autoCompleteTemplateRow = box.querySelector('#scv-autocomplete-template-row');
    const updateAutoCompleteVisibility = () => autoCompleteTemplateRow.classList.toggle('hidden', !autoCompleteCheckbox.checked);
    autoCompleteCheckbox.addEventListener('change', updateAutoCompleteVisibility);
    updateAutoCompleteVisibility();

    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('.submit').addEventListener('click', () => {
      const missingConnectors = box.querySelector('#scv-missing-connectors').checked;
      const missingConnectorsAndNodes = nodesCheckbox.checked;
      const rawLevels = box.querySelector('#scv-levels-input').value.trim();
      const levels = rawLevels === '' ? null : Math.max(0, Math.floor(Number(rawLevels)) || 0);
      const doAutoComplete = autoCompleteCheckbox.checked;
      const autoCompleteTemplate = box.querySelector('#scv-autocomplete-template').value;
      const syncWithInventory = box.querySelector('#scv-sync-inventory').checked;
      overlay.remove();

      if (!missingConnectors && !missingConnectorsAndNodes && !doAutoComplete && !syncWithInventory) { this.toast('Nothing selected to check.'); return; }

      if (missingConnectors || missingConnectorsAndNodes || syncWithInventory) {
        const result = smartCheckView(this, tab, { missingConnectors, missingConnectorsAndNodes, levels, syncWithInventory });
        if (!result) { this.toast('Smart Check failed — view not found.', true); return; }
        this.recordAndRender();
        const parts = [];
        if (result.connectorsAdded) parts.push(`${result.connectorsAdded} connector${result.connectorsAdded === 1 ? '' : 's'}`);
        if (result.nodesAdded) parts.push(`${result.nodesAdded} node${result.nodesAdded === 1 ? '' : 's'}`);
        if (result.parentConnectorsAdded) parts.push(`${result.parentConnectorsAdded} mirrored to a parent view`);
        if (result.connectorsUpdated) parts.push(`${result.connectorsUpdated} resynced`);
        this.toast(parts.length ? `Smart Check added ${parts.join(' and ')}.` : 'Smart Check found nothing missing.');
      }

      if (doAutoComplete) { setCachedStreamTemplate(autoCompleteTemplate); this.promptAutoCompleteStreams(tab, autoCompleteTemplate); }
    });
  }

  /** Smart Check Node (Advanced menu, and right-click on a single node): the single-node
   * analog of Smart Check View — same "missing connectors" / "missing connectors and
   * nodes, N hops" mechanics (see commands.js's smartCheckNode), but starting from just
   * the one selected node, with two extra filters that only make sense at that scope:
   * direction (Upstream/Downstream, relative to the selected node) and an optional
   * Stream filter. The stream checkbox list is built from the selected node's OWN
   * streams (checked by default) — not every stream in the model — and stays fixed for
   * the whole run: a newly-discovered node that happens to carry other streams doesn't
   * widen the search to those. Bespoke modal for the same reason Smart Check View's is:
   * several rows show/hide based on other checkboxes' state. */
  promptSmartCheckNode(tab) {
    if (!tab || tab.type !== 'canvas') { this.toast('Open a view to Smart Check a node first.', true); return; }
    const selIds = [...tab.selection];
    if (selIds.length !== 1) { this.toast('Select a single node to Smart Check.', true); return; }
    const vm = this.store.findViewMember(selIds[0]);
    if (!vm || vm.objectType !== 'part') { this.toast('Select a single node (not a connector) to Smart Check.', true); return; }
    const part = this.store.findPart(vm.objectId);
    if (!part) { this.toast('Selected node not found.', true); return; }

    const nodeStreams = part.streams || [];
    const hasStreams = nodeStreams.length > 0;

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Smart Check Node</h3>
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">Checking "${escapeHtml(part.label)}" (${escapeHtml(part.type)})</div>
      <div class="prop-row checkbox"><input type="checkbox" id="scn-by-stream" ${hasStreams ? 'checked' : ''} ${hasStreams ? '' : 'disabled'} /><label for="scn-by-stream">By Stream — only follow connectors tagged with the selected stream(s) below${hasStreams ? '' : ' (this node has no streams)'}</label></div>
      <div id="scn-streams-row" style="margin-left:22px;">${nodeStreams.map((s) => `<div class="prop-row checkbox"><input type="checkbox" class="scn-stream-cb" data-stream="${escapeHtml(s)}" checked /><label>${escapeHtml(s)}</label></div>`).join('')}</div>
      <div class="prop-row checkbox"><input type="checkbox" id="scn-upstream" checked /><label for="scn-upstream">Upstream — follow connectors into this node</label></div>
      <div class="prop-row checkbox"><input type="checkbox" id="scn-downstream" checked /><label for="scn-downstream">Downstream — follow connectors out of this node</label></div>
      <div class="prop-row checkbox"><input type="checkbox" id="scn-missing-connectors" checked /><label for="scn-missing-connectors">Missing connectors — add connectors between nodes already on this view</label></div>
      <div class="prop-row checkbox"><input type="checkbox" id="scn-missing-connectors-nodes" /><label for="scn-missing-connectors-nodes">Missing connectors and nodes — also pull in connected nodes not yet on this view</label></div>
      <div class="prop-row" id="scn-levels-row" style="margin-left:22px;"><label>Levels</label><input type="number" id="scn-levels-input" class="tb-select" style="width:60px;" min="0" step="1" value="" placeholder="All" title="How many hops of missing connected nodes to pull in. Blank = unlimited." /></div>
      <div class="prop-row checkbox"><input type="checkbox" id="scn-sync-inventory" /><label for="scn-sync-inventory">Sync existing connectors with inventory — update this node's connectors to match their related part-to-part connector where they differ</label></div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Check</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    const byStreamCheckbox = box.querySelector('#scn-by-stream');
    const streamsRow = box.querySelector('#scn-streams-row');
    const updateStreamsVisibility = () => streamsRow.classList.toggle('hidden', !byStreamCheckbox.checked);
    byStreamCheckbox.addEventListener('change', updateStreamsVisibility);
    updateStreamsVisibility();

    const nodesCheckbox = box.querySelector('#scn-missing-connectors-nodes');
    const levelsRow = box.querySelector('#scn-levels-row');
    const updateLevelsVisibility = () => levelsRow.classList.toggle('hidden', !nodesCheckbox.checked);
    nodesCheckbox.addEventListener('change', updateLevelsVisibility);
    updateLevelsVisibility();

    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('.submit').addEventListener('click', () => {
      const missingConnectors = box.querySelector('#scn-missing-connectors').checked;
      const missingConnectorsAndNodes = nodesCheckbox.checked;
      const syncWithInventory = box.querySelector('#scn-sync-inventory').checked;
      if (!missingConnectors && !missingConnectorsAndNodes && !syncWithInventory) { this.toast('Nothing selected to check.'); return; }
      const upstream = box.querySelector('#scn-upstream').checked;
      const downstream = box.querySelector('#scn-downstream').checked;
      if (!upstream && !downstream) { this.toast('Select at least one direction (Upstream/Downstream).', true); return; }
      const byStream = byStreamCheckbox.checked;
      const streams = [...box.querySelectorAll('.scn-stream-cb')].filter((cb) => cb.checked).map((cb) => cb.dataset.stream);
      if (byStream && streams.length === 0) { this.toast("Select at least one stream, or uncheck 'By Stream'.", true); return; }
      const rawLevels = box.querySelector('#scn-levels-input').value.trim();
      const levels = rawLevels === '' ? null : Math.max(0, Math.floor(Number(rawLevels)) || 0);
      overlay.remove();

      const result = smartCheckNode(this, tab, part.id, { missingConnectors, missingConnectorsAndNodes, levels, upstream, downstream, byStream, streams, syncWithInventory });
      if (!result) { this.toast('Smart Check Node failed — node not found on this view.', true); return; }
      this.recordAndRender();
      const parts = [];
      if (result.connectorsAdded) parts.push(`${result.connectorsAdded} connector${result.connectorsAdded === 1 ? '' : 's'}`);
      if (result.nodesAdded) parts.push(`${result.nodesAdded} node${result.nodesAdded === 1 ? '' : 's'}`);
      if (result.parentConnectorsAdded) parts.push(`${result.parentConnectorsAdded} mirrored to a parent view`);
      if (result.connectorsUpdated) parts.push(`${result.connectorsUpdated} resynced`);
      this.toast(parts.length ? `Smart Check Node added ${parts.join(' and ')}.` : 'Smart Check Node found nothing missing.');
    });
  }

  /** Review dialog for Smart Check's "Auto-complete streams in model" option: scans every
   * stream name tagged on a part in the current default model, reports which template
   * positions (per `templateName`) are missing their Part and/or this-view node, and lets
   * the user selectively check/uncheck Part and View per row before creating anything —
   * nothing is created until Proceed is clicked. */
  promptAutoCompleteStreams(tab, templateName) {
    const modelName = this.store.defaultModel;
    const rows = scanStreamsForAutoComplete(this.store, templateName, modelName, tab.viewId);
    if (!rows.length) { this.toast('Auto-Complete Streams: every tagged stream in this model is already complete.'); return; }

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box modal-box-textedit';
    box.innerHTML = `<h3>Auto-Complete Streams in Model</h3>
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">Found ${rows.length} incomplete position${rows.length === 1 ? '' : 's'} across the streams tagged in "${escapeHtml(modelName)}", checked against the "${escapeHtml(templateName)}" template. A node can't be created without its part — unchecking Part also unchecks and disables View.</div>
      <div style="max-height:50vh; overflow-y:auto; border:1px solid var(--border); border-radius:5px;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="position:sticky; top:0; background:var(--bg-alt);">
            <th style="text-align:left; padding:5px 8px;">Stream</th>
            <th style="text-align:left; padding:5px 8px;">Type</th>
            <th style="text-align:left; padding:5px 8px;">Label</th>
            <th style="text-align:center; padding:5px 8px;">Part</th>
            <th style="text-align:center; padding:5px 8px;">View</th>
          </tr></thead>
          <tbody>
            ${rows.map((r, i) => `<tr style="border-top:1px solid var(--border);">
              <td style="padding:4px 8px;">${escapeHtml(r.streamName)}</td>
              <td style="padding:4px 8px;">${escapeHtml(r.type)}</td>
              <td style="padding:4px 8px;">${escapeHtml(r.label)}</td>
              <td style="text-align:center;"><input type="checkbox" class="acs-part" data-idx="${i}" ${r.partExists ? 'checked disabled' : 'checked'} /></td>
              <td style="text-align:center;"><input type="checkbox" class="acs-view" data-idx="${i}" ${r.viewExists ? 'checked disabled' : 'checked'} /></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Proceed</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    const partBoxes = [...box.querySelectorAll('.acs-part')];
    const viewBoxes = [...box.querySelectorAll('.acs-view')];
    partBoxes.forEach((cb, i) => {
      if (cb.disabled) return; // part already exists — always available, unchecking makes no sense
      cb.addEventListener('change', () => {
        const vcb = viewBoxes[i];
        if (!cb.checked) { vcb.checked = false; vcb.disabled = true; }
        else if (!rows[i].viewExists) { vcb.disabled = false; }
      });
    });

    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('.submit').addEventListener('click', () => {
      // Group decisions by streamName — autoCompleteStreams operates on one stream at a
      // time (same scope createStream itself works in), so a multi-stream scan batches
      // into one call per distinct stream name, sharing one lookupCache across all of them
      // for the same reason bulk callers elsewhere in this codebase do (see
      // createBulkLookupCache's own doc comment).
      const decisionsByStream = new Map();
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const createPart = partBoxes[i].checked;
        const createView = viewBoxes[i].checked;
        if (!createPart && !createView) continue; // fully unchecked row -> nothing to do
        if (!decisionsByStream.has(r.streamName)) decisionsByStream.set(r.streamName, new Map());
        decisionsByStream.get(r.streamName).set(`${r.type}|${r.label}`.toLowerCase(), { createPart, createView });
      }
      overlay.remove();
      if (!decisionsByStream.size) { this.toast('Nothing checked — no changes made.'); return; }

      const template = (this.store.settings.streamTemplates || []).find((t) => t.name === templateName);
      const lookupCache = createBulkLookupCache(this.store);
      let totalParts = 0, totalVms = 0, totalStreams = 0;
      for (const [streamName, decisions] of decisionsByStream) {
        const result = autoCompleteStreams(this, template, streamName, modelName, tab.viewId, decisions, lookupCache, true);
        if (!result) continue;
        totalParts += result.newPartsCount;
        totalVms += result.newVmIds.length;
        totalStreams += 1;
      }
      this.recordAndRender();
      const summary = [];
      if (totalParts) summary.push(`${totalParts} part${totalParts === 1 ? '' : 's'}`);
      if (totalVms) summary.push(`${totalVms} node${totalVms === 1 ? '' : 's'}`);
      this.toast(summary.length ? `Auto-completed ${totalStreams} stream${totalStreams === 1 ? '' : 's'}: added ${summary.join(' and ')}.` : 'No changes made.');
    });
  }

  /** Bespoke, wide 2-column layout (matches promptInsertSmartStream's own reorg) — a
   * Preset row (Save As.../Load, store.remapPresets — Local Settings, never in the
   * save JSON, same story as smartStreamPresets) sits above Template/Pattern/checkboxes
   * on the left and the Sort priority list on the right, with a full-width Edge
   * Assignment section below. Reported directly: "let's add similar load/save settings
   * for remap, with additional options for laying out the nodes. Specifically the
   * ability to specify what goes on top of view, bottom, etc." — Edge Assignment pins
   * an element type (scoped to types actually placed on this view) to a single row/
   * column along the Top/Bottom/Left/Right edge of the layout instead of its normal
   * stream/element-group grid position, ordered within that edge by the same Sort
   * priority keys as the main grid (so 'connectionOrder' gives "natural flow" there
   * too). Two further checkboxes run additional passes over the remaining middle grid
   * afterward: Minimize connector crossings (barycenter-heuristic column reordering,
   * commands.js's minimizeRowCrossings) and Minimize connector length ("move nodes to
   * similar positions but closer" — a continuous barycenter-based x-position
   * refinement that keeps each row's order but pulls connected nodes toward each
   * other, commands.js's minimizeConnectorLengthPass; runs after crossing minimization
   * if both are checked, the classic Sugiyama ordering-then-coordinates pipeline). All
   * three (Edge Assignment + both minimize checkboxes) are 'default'/'none' pattern
   * only — force-directed placement doesn't use rows/columns or sort keys at all, so
   * they're hidden (like the priority list already is) whenever 'force' is selected.
   * Every field defaults from view.remapLastOptions (this SPECIFIC view's own settings
   * the last time Remap actually ran on it) ahead of the cross-view getCachedRemapOptions
   * default, same "this view's own history wins" precedent view.remapSortKeys already
   * set for sort order — reported directly: "Is it possible to retain the prior Remap
   * settings on the same view if the user reopens it to adjust?" Right-clicking the
   * Remap button (instead of left-clicking to actually run it) copies a ready-to-paste
   * `remap(app, tab, {...})` Script Console call matching the form's current values —
   * see wireCopyCallOnRightClick above, a generic helper any dialog's submit button
   * could reuse the same way. A fourth Pattern option, 'layered' (commands.js's
   * computeLayerAssignment), rows nodes by hierarchical graph depth (BFS/longest-path
   * from whatever has no incoming edges) instead of element-group/stream membership —
   * reported directly, describing a specific desired grid: "Is there any algorithm or
   * combination of options that could result in this layout?" for a case where the
   * DESIRED row-per-architectural-layer arrangement didn't match what 'default's
   * group-based row-breaking naturally produces (a Function and its own Processes
   * share an elementGroup, so 'default' merges them into one row instead of two).
   * 'layered' still supports Edge Assignment/Minimize Crossings/Minimize Connector
   * Length exactly like 'default'/'none' (only "Limit columns to view" is hidden for
   * it too, alongside 'force' — column-wrapping has no meaning when every row is
   * already exactly one hierarchy layer). */
  promptRemap(tab) {
    const view = this.store.findView(tab.viewId);
    if (view && isSectionViewType(view.viewType)) {
      // section-based views place nodes via the grid/section-placer logic, which has no
      // sort-key concept — skip the picker entirely rather than showing options that
      // would silently do nothing.
      remap(this, tab);
      return;
    }
    const labels = REMAP_SORT_LABELS;
    const cachedRemap = getCachedRemapOptions();
    // view.remapLastOptions: every dialog field (except sortKeys, its own separate
    // field below) from the last time Remap actually ran successfully ON THIS
    // SPECIFIC view — wins over the cross-view "last used anywhere" cache, same
    // precedent remapSortKeys already established. Reported directly: "Is it possible
    // to retain the prior Remap settings on the same view if the user reopens it to
    // adjust?"
    const viewLast = view?.remapLastOptions || {};
    const rOpt = (key) => (viewLast[key] !== undefined ? viewLast[key] : cachedRemap[key]);
    const cachedSortKeys = Array.isArray(cachedRemap.sortKeys) ? cachedRemap.sortKeys.filter((k) => REMAP_SORT_KEYS.includes(k)) : null;
    // view.remapSortKeys (this specific view's own remembered order) wins if present;
    // otherwise fall back to the cross-view user default; otherwise the built-in default.
    const remembered = (view?.remapSortKeys && view.remapSortKeys.length)
      ? view.remapSortKeys.filter((k) => REMAP_SORT_KEYS.includes(k))
      : (cachedSortKeys && cachedSortKeys.length ? cachedSortKeys : DEFAULT_REMAP_SORT_KEYS);
    // start from the remembered/default order, then append any keys missing from it
    // (e.g. a newly-added key like elementGroup that predates a saved remapSortKeys) —
    // every key appears exactly once, so duplicates are impossible by construction.
    const orderedKeys = [...remembered, ...REMAP_SORT_KEYS.filter((k) => !remembered.includes(k))];
    const templateNames = (this.store.settings.streamTemplates || []).map((t) => t.name);
    const cachedTemplate = getCachedStreamTemplate();
    const defaultTemplate = (viewLast.templateName && templateNames.includes(viewLast.templateName)) ? viewLast.templateName
      : (cachedTemplate && templateNames.includes(cachedTemplate)) ? cachedTemplate
      : (templateNames.includes('Enterprise') ? 'Enterprise' : templateNames[0]);
    const defaultPattern = REMAP_PATTERNS.includes(viewLast.pattern) ? viewLast.pattern
      : REMAP_PATTERNS.includes(cachedRemap.pattern) ? cachedRemap.pattern : 'default';

    const store = this.store;
    const typesInView = [...new Set(store.viewMembersForView(tab.viewId).filter((vm) => vm.objectType === 'part').map((vm) => store.findPart(vm.objectId)?.type).filter(Boolean))]
      .map((type) => { const el = elementByType(store, type); return { type, title: el?.title || type }; })
      .sort((a, b) => a.title.localeCompare(b.title));

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box modal-box-wide';
    box.innerHTML = `
      <h3>Remap</h3>
      <div class="prop-row"><label>Preset</label><select id="rm-preset-select">
        <option value="">(none)</option>
        ${(store.remapPresets || []).map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('')}
      </select><button type="button" id="rm-preset-load">Load</button><button type="button" id="rm-preset-save">Save As…</button></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px;">
        <div>
          <div class="prop-row"><label>Stream Template</label><select id="rm-template">${templateNames.map((n) => `<option value="${escapeHtml(n)}" ${n === defaultTemplate ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select></div>
          <div class="prop-row"><label>Pattern</label><select id="rm-pattern"><option value="default" ${defaultPattern === 'default' ? 'selected' : ''}>default</option><option value="none" ${defaultPattern === 'none' ? 'selected' : ''}>none</option><option value="layered" ${defaultPattern === 'layered' ? 'selected' : ''}>layered</option><option value="force" ${defaultPattern === 'force' ? 'selected' : ''}>force-directed</option><option value="clusters" ${defaultPattern === 'clusters' ? 'selected' : ''}>centralize in clusters</option></select></div>
          <div class="prop-row checkbox" id="rm-limit-row"><input type="checkbox" id="rm-limit" ${rOpt('limitColumnsToView') ? 'checked' : ''} /><label for="rm-limit">Limit columns to view</label></div>
          <div class="prop-row checkbox"><input type="checkbox" id="rm-filtered-only" ${rOpt('filteredOnly') ? 'checked' : ''} /><label for="rm-filtered-only">Only remap filtered nodes</label></div>
          <div class="prop-row checkbox"><input type="checkbox" id="rm-selected-only" ${rOpt('selectedOnly') ? 'checked' : ''} /><label for="rm-selected-only">Only remap selected nodes and their connectors</label></div>
          <div class="prop-row checkbox" id="rm-minimize-crossings-row"><input type="checkbox" id="rm-minimize-crossings" ${rOpt('minimizeCrossings') ? 'checked' : ''} /><label for="rm-minimize-crossings">Minimize connector crossings</label></div>
          <div class="prop-row checkbox" id="rm-minimize-length-row"><input type="checkbox" id="rm-minimize-length" ${rOpt('minimizeConnectorLength') ? 'checked' : ''} /><label for="rm-minimize-length">Minimize connector length</label></div>
          <div id="rm-force-note" class="hidden" style="margin-top:10px; font-size:12px; color:var(--text-muted);">Force-directed placement clusters connected nodes together and reduces total edge length — it doesn't use sort order, column limits, Edge Assignment, or crossing/length minimization, so those are hidden while this pattern is selected.</div>
          <div id="rm-clusters-note" class="hidden" style="margin-top:10px; font-size:12px; color:var(--text-muted);">Centralize in Clusters repeatedly centers each locally most-connected node with its own single-connection neighbors around it, tiling the resulting clusters together — like force-directed, it doesn't use sort order, column limits, Edge Assignment, or crossing/length minimization. A node that connects to more than one cluster (a "bridge") can't be guaranteed adjacent to every cluster it touches — an inherent limit of any 2D grid layout, same as force-directed's own cycle-edge case.</div>
          <div class="prop-row checkbox hidden" id="rm-force-prefer-right-row"><input type="checkbox" id="rm-force-prefer-right" ${rOpt('forcePreferRight') ? 'checked' : ''} /><label for="rm-force-prefer-right">Prefer placing connected nodes to the right when a cell is available</label></div>
          <div class="prop-row checkbox hidden" id="rm-force-group-rows-row"><input type="checkbox" id="rm-force-group-rows" ${rOpt('forceGroupRows') ? 'checked' : ''} /><label for="rm-force-group-rows">Only start a new row when a node is a new hop away (keep same-hop nodes on one row)</label></div>
        </div>
        <div id="rm-priority-section">
          <div style="font-size:12px; color:var(--text-muted);">Sort priority (top = highest priority)</div>
          <ul id="rm-priority-list" style="list-style:none; margin:6px 0 0 0; padding:0; display:flex; flex-direction:column; gap:3px; max-height:220px; overflow-y:auto;"></ul>
        </div>
      </div>
      <div id="rm-edge-section" style="margin-top:10px;">
        <div style="font-size:12px; color:var(--text-muted);">Edge Assignment — pin an element type to an edge of the layout instead of its normal row/column, ordered within that edge by Sort priority above</div>
        <div id="rm-edge-list" style="max-height:160px; overflow-y:auto; border:1px solid var(--border); border-radius:5px; padding:6px 8px; margin-top:4px;">
          ${typesInView.length ? typesInView.map((t) => `<div class="prop-row"><label style="flex:0 0 160px;">${escapeHtml(t.title)}</label><select class="rm-edge-select" data-type="${escapeHtml(t.type)}">
            <option value="">— (normal grid)</option>
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select></div>`).join('') : '<div class="empty-hint">No parts placed on this view yet.</div>'}
        </div>
      </div>
      <div class="modal-actions"><button class="reset" style="margin-right:auto;">Reset</button><button class="cancel">Cancel</button><button class="primary submit">Remap</button></div>
    `;
    overlay.appendChild(box);
    root.appendChild(overlay);

    const listEl = box.querySelector('#rm-priority-list');
    const renderPriorityList = () => {
      listEl.innerHTML = orderedKeys.map((k, i) => `
        <li data-key="${k}" style="display:flex; align-items:center; gap:8px; padding:4px 8px; border:1px solid var(--border); border-radius:5px; background:var(--bg);">
          <span style="flex:1;">${i + 1}. ${escapeHtml(labels[k])}</span>
          <button class="rm-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''} title="Move up" style="border:none;background:transparent;cursor:${i === 0 ? 'default' : 'pointer'};opacity:${i === 0 ? 0.3 : 1};">▲</button>
          <button class="rm-down" data-idx="${i}" ${i === orderedKeys.length - 1 ? 'disabled' : ''} title="Move down" style="border:none;background:transparent;cursor:${i === orderedKeys.length - 1 ? 'default' : 'pointer'};opacity:${i === orderedKeys.length - 1 ? 0.3 : 1};">▼</button>
        </li>`).join('');
      listEl.querySelectorAll('.rm-up').forEach((btn) => btn.addEventListener('click', () => {
        const i = Number(btn.dataset.idx);
        if (i > 0) { [orderedKeys[i - 1], orderedKeys[i]] = [orderedKeys[i], orderedKeys[i - 1]]; renderPriorityList(); }
      }));
      listEl.querySelectorAll('.rm-down').forEach((btn) => btn.addEventListener('click', () => {
        const i = Number(btn.dataset.idx);
        if (i < orderedKeys.length - 1) { [orderedKeys[i], orderedKeys[i + 1]] = [orderedKeys[i + 1], orderedKeys[i]]; renderPriorityList(); }
      }));
    };
    renderPriorityList();

    const patternSelect = box.querySelector('#rm-pattern');
    const updatePatternVisibility = () => {
      const isForce = patternSelect.value === 'force';
      const isClusters = patternSelect.value === 'clusters';
      const isForceOrClusters = isForce || isClusters;
      const isLayered = patternSelect.value === 'layered';
      box.querySelector('#rm-priority-section').classList.toggle('hidden', isForceOrClusters);
      // Column-wrapping (maxCols) has no meaning for 'layered' -- every row is exactly
      // one hierarchy layer, however wide -- so it's hidden for 'force'/'clusters' and
      // 'layered' alike, but Edge Assignment/Minimize Crossings/Minimize Connector
      // Length all still apply to 'layered' same as 'default'/'none'.
      box.querySelector('#rm-limit-row').classList.toggle('hidden', isForceOrClusters || isLayered);
      box.querySelector('#rm-edge-section').classList.toggle('hidden', isForceOrClusters);
      box.querySelector('#rm-minimize-crossings-row').classList.toggle('hidden', isForceOrClusters);
      box.querySelector('#rm-minimize-length-row').classList.toggle('hidden', isForceOrClusters);
      box.querySelector('#rm-force-note').classList.toggle('hidden', !isForce);
      box.querySelector('#rm-clusters-note').classList.toggle('hidden', !isClusters);
      // 'clusters' reuses 'force''s own "prefer right" option (same ring-placement
      // mechanic), but NOT "group rows" -- a hub's ring is always exactly one level
      // deep, so BFS-depth-based row grouping has nothing to do here.
      box.querySelector('#rm-force-prefer-right-row').classList.toggle('hidden', !isForceOrClusters);
      box.querySelector('#rm-force-group-rows-row').classList.toggle('hidden', !isForce);
    };
    patternSelect.addEventListener('change', updatePatternVisibility);
    updatePatternVisibility();

    const collectEdgeAssignment = () => {
      const out = {};
      box.querySelectorAll('.rm-edge-select').forEach((sel) => { if (sel.value) out[sel.dataset.type] = sel.value; });
      return out;
    };
    const applyEdgeAssignment = (edgeAssignment) => {
      box.querySelectorAll('.rm-edge-select').forEach((sel) => { sel.value = (edgeAssignment && edgeAssignment[sel.dataset.type]) || ''; });
    };
    // Pre-fill Edge Assignment from this view's own last-used settings (viewLast, see
    // above) — the same "this view wins" precedent as every other field in this
    // dialog, just applied one render-cycle later since the selects don't exist until
    // the innerHTML above runs.
    if (viewLast.edgeAssignment) applyEdgeAssignment(viewLast.edgeAssignment);

    box.querySelector('.reset').addEventListener('click', () => {
      // restores the app's built-in defaults, not this view's previously-remembered
      // order — a distinct action from just reopening the modal.
      box.querySelector('#rm-template').value = templateNames.includes('Enterprise') ? 'Enterprise' : templateNames[0];
      box.querySelector('#rm-pattern').value = 'default';
      box.querySelector('#rm-limit').checked = false;
      box.querySelector('#rm-filtered-only').checked = false;
      box.querySelector('#rm-selected-only').checked = false;
      box.querySelector('#rm-minimize-crossings').checked = false;
      box.querySelector('#rm-minimize-length').checked = false;
      box.querySelector('#rm-force-prefer-right').checked = false;
      box.querySelector('#rm-force-group-rows').checked = false;
      applyEdgeAssignment({});
      orderedKeys.splice(0, orderedKeys.length, ...DEFAULT_REMAP_SORT_KEYS, ...REMAP_SORT_KEYS.filter((k) => !DEFAULT_REMAP_SORT_KEYS.includes(k)));
      renderPriorityList();
      updatePatternVisibility();
    });

    box.querySelector('#rm-preset-load').addEventListener('click', () => {
      const name = box.querySelector('#rm-preset-select').value;
      if (!name) { this.toast('Select a preset to load.', true); return; }
      const preset = (store.remapPresets || []).find((p) => p.name === name);
      if (!preset) { this.toast(`Preset "${name}" not found.`, true); return; }

      if (templateNames.includes(preset.templateName)) box.querySelector('#rm-template').value = preset.templateName;
      box.querySelector('#rm-pattern').value = REMAP_PATTERNS.includes(preset.pattern) ? preset.pattern : 'default';
      box.querySelector('#rm-limit').checked = !!preset.limitColumnsToView;
      box.querySelector('#rm-filtered-only').checked = !!preset.filteredOnly;
      box.querySelector('#rm-selected-only').checked = !!preset.selectedOnly;
      box.querySelector('#rm-minimize-crossings').checked = !!preset.minimizeCrossings;
      box.querySelector('#rm-minimize-length').checked = !!preset.minimizeConnectorLength;
      box.querySelector('#rm-force-prefer-right').checked = !!preset.forcePreferRight;
      box.querySelector('#rm-force-group-rows').checked = !!preset.forceGroupRows;
      const presetKeys = Array.isArray(preset.sortKeys) ? preset.sortKeys.filter((k) => REMAP_SORT_KEYS.includes(k)) : [];
      orderedKeys.splice(0, orderedKeys.length, ...presetKeys, ...REMAP_SORT_KEYS.filter((k) => !presetKeys.includes(k)));
      renderPriorityList();
      applyEdgeAssignment(preset.edgeAssignment || {});
      updatePatternVisibility();
      this.toast(`Preset "${name}" loaded.`);
    });

    box.querySelector('#rm-preset-save').addEventListener('click', () => {
      this.promptModal({
        title: 'Save Remap Preset',
        fields: [{ key: 'name', label: 'Preset Name', value: box.querySelector('#rm-preset-select').value || '' }],
        onSubmit: (vals) => {
          const name = (vals.name || '').trim();
          if (!name) { this.toast('Preset name is required.', true); return; }
          const preset = {
            name,
            templateName: box.querySelector('#rm-template').value,
            pattern: box.querySelector('#rm-pattern').value,
            sortKeys: [...orderedKeys],
            limitColumnsToView: box.querySelector('#rm-limit').checked,
            filteredOnly: box.querySelector('#rm-filtered-only').checked,
            selectedOnly: box.querySelector('#rm-selected-only').checked,
            forcePreferRight: box.querySelector('#rm-force-prefer-right').checked,
            forceGroupRows: box.querySelector('#rm-force-group-rows').checked,
            edgeAssignment: collectEdgeAssignment(),
            minimizeCrossings: box.querySelector('#rm-minimize-crossings').checked,
            minimizeConnectorLength: box.querySelector('#rm-minimize-length').checked,
          };
          const list = [...(store.remapPresets || [])];
          const idx = list.findIndex((p) => p.name === name);
          if (idx >= 0) list[idx] = preset; else list.push(preset);
          store.remapPresets = list;
          setCachedRemapPresets(list);
          const sel = box.querySelector('#rm-preset-select');
          sel.innerHTML = `<option value="">(none)</option>${list.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('')}`;
          sel.value = name;
          this.toast(`Saved preset "${name}".`);
        },
      });
    });

    // Shared by the submit handler and the right-click "copy call" handler below, so
    // both read the form the same way and can never drift out of sync with each other.
    const collectRemapOptions = () => ({
      templateName: box.querySelector('#rm-template').value,
      pattern: box.querySelector('#rm-pattern').value,
      limitColumnsToView: box.querySelector('#rm-limit').checked,
      filteredOnly: box.querySelector('#rm-filtered-only').checked,
      selectedOnly: box.querySelector('#rm-selected-only').checked,
      minimizeCrossings: box.querySelector('#rm-minimize-crossings').checked,
      minimizeConnectorLength: box.querySelector('#rm-minimize-length').checked,
      forcePreferRight: box.querySelector('#rm-force-prefer-right').checked,
      forceGroupRows: box.querySelector('#rm-force-group-rows').checked,
      edgeAssignment: collectEdgeAssignment(),
      sortKeys: [...orderedKeys],
    });

    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    wireCopyCallOnRightClick(this, box.querySelector('.submit'), () => `remap(app, tab, ${JSON.stringify(collectRemapOptions(), null, 2)});`);
    box.querySelector('.submit').addEventListener('click', () => {
      const { templateName, pattern, limitColumnsToView, filteredOnly, selectedOnly, minimizeCrossings, minimizeConnectorLength, forcePreferRight, forceGroupRows, edgeAssignment, sortKeys } = collectRemapOptions();
      overlay.remove();

      setCachedStreamTemplate(templateName);
      setCachedRemapOptions({ pattern, limitColumnsToView, filteredOnly, selectedOnly, forcePreferRight, forceGroupRows, sortKeys, minimizeCrossings, minimizeConnectorLength });

      let visiblePartVmIds = null;
      if (filteredOnly && isAnyVisibilityFilterActive(tab)) {
        const allPartVms = this.store.viewMembersForView(tab.viewId).filter((vm) => vm.objectType === 'part');
        const allConnVms = this.store.viewMembersForView(tab.viewId).filter((vm) => vm.objectType === 'connector');
        const seedVmIds = new Set();
        for (const vm of allPartVms) {
          const part = this.store.findPart(vm.objectId) || {};
          if (passesStreamFilter(tab, part.streams) && passesElementTypeFilter(tab, part.type)) seedVmIds.add(vm.id);
        }
        visiblePartVmIds = expandVisiblePartVmIdsByLevel(seedVmIds, allConnVms, tab.connectorLevels);
      }
      // "Only remap selected nodes and their connectors" -- reported directly, valid
      // for every pattern (default/none/layered/force/clusters) since it plugs into
      // the SAME visiblePartVmIds param every pattern branch of applyRemapLayout
      // already respects uniformly (excluded parts just keep their current x/y).
      // Combines with filteredOnly above by INTERSECTION when both are checked (a
      // part must pass the filter AND be selected), not by replacing one with the
      // other. Silently a no-op with nothing selected, same precedent filteredOnly
      // already sets for "no filter active."
      if (selectedOnly && tab.selection.size > 0) {
        const selectedPartVmIds = new Set([...tab.selection].filter((id) => this.store.findViewMember(id)?.objectType === 'part'));
        visiblePartVmIds = visiblePartVmIds ? new Set([...visiblePartVmIds].filter((id) => selectedPartVmIds.has(id))) : selectedPartVmIds;
      }
      remap(this, tab, { sortKeys, templateName, pattern, limitColumnsToView, filteredOnly, selectedOnly, visiblePartVmIds, forcePreferRight, forceGroupRows, edgeAssignment, minimizeCrossings, minimizeConnectorLength });
    });
  }

  /** `canvasPos` (the right-click point, when opened via the canvas context menu) lets
   * this pre-filter the row list to types actually valid where the user clicked, on a
   * section-based view (e.g. 'org') — same rule dropNewPart already enforces when
   * dropping a NEW node from the Toolbox, just applied here to the existing-parts list
   * instead. Genuinely inside one specific section: filtered to that section's own
   * elementTypes, and — critically, not just the list — every part added ends up
   * PLACED in that exact section too (threaded through to addExistingPartsToView as
   * targetSectionInstanceId), not wherever createSectionPlacer's generic
   * first-type-matching-section rule would otherwise put it. Falls back to the
   * currently SELECTED section (tab.selectedSectionId, from clicking a header) if the
   * click itself didn't land inside any specific section but one is already selected.
   * Genuinely outside any specific section on a section-based view: filtered to the
   * union of every section's allowed types (getAllowedTypesForView) — still narrower
   * than "everything in the model" — and placement falls back to the generic placer,
   * same as before. This union fallback applies even with NO canvasPos at all, as long
   * as the view itself is section-based — nothing in ANY of its sections could ever
   * accept a type none of them allow, regardless of where (or whether) you clicked. A
   * plain 'ff' view is the only case that's genuinely unfiltered and generically
   * placed, exactly as before. Reported directly: "pre filter the 'Add Existing
   * Parts' to parts of type valid for that section or view if view is not in a
   * section," then: "ignores mouse location or selected section, always adds to first
   * section" — the list filter alone didn't touch placement at all. */
  promptAddExisting(tab, canvasPos) {
    const store = this.store;
    const view = store.findView(tab.viewId);
    const inViewPartIds = new Set(store.viewMembersForView(tab.viewId).filter((vm) => vm.objectType === 'part').map((vm) => vm.objectId));
    let availableParts = store.doc.parts.filter((p) => !inViewPartIds.has(p.id));
    if (availableParts.length === 0) { this.toast('No other parts available to add.', true); return; }

    let sectionFilterLabel = '', targetSectionInstanceId = '';
    if (view && isSectionViewType(view.viewType)) {
      const layout = computeSectionLayout(view);
      let targetEntry = canvasPos ? layout.find((entry) => canvasPos.x >= entry.left && canvasPos.x <= entry.left + entry.width && canvasPos.y >= entry.top && canvasPos.y <= entry.top + entry.height) : null;
      if (!targetEntry && tab.selectedSectionId) targetEntry = layout.find((entry) => entry.section.id === tab.selectedSectionId);
      if (targetEntry) {
        availableParts = availableParts.filter((p) => isTypeAllowedInSection(targetEntry.section, p.type));
        sectionFilterLabel = targetEntry.section.name || '(untitled section)';
        targetSectionInstanceId = targetEntry.section.id;
      } else {
        const allowed = getAllowedTypesForView(view);
        if (allowed) availableParts = availableParts.filter((p) => allowed.has(String(p.type).toLowerCase()));
      }
      if (availableParts.length === 0) {
        this.toast(sectionFilterLabel ? `No existing parts of a type valid for section "${sectionFilterLabel}" available to add.` : 'No existing parts of a type valid for this view available to add.', true);
        return;
      }
    }

    const elTitleFor = (type) => (store.settings.elements || []).find((e) => ciEq(e.type, type))?.title || type;
    const typeOptions = [...new Set(availableParts.map((p) => p.type))].sort();
    const modelOptions = [...new Set(availableParts.map((p) => p.model))].sort();
    const streamOptions = [...new Set(availableParts.flatMap((p) => p.streams || []))].sort();

    const uiState = { typeFilter: '', modelFilter: '', streamFilter: '', sortCol: 'label', sortDir: 'asc', selected: new Set() };

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.style.width = '700px';
    box.style.maxWidth = '92vw';
    box.innerHTML = `
      <h3>Add Existing Parts</h3>
      ${sectionFilterLabel ? `<div style="font-size:11px;color:var(--text-muted);margin:-4px 0 12px 0;">Pre-filtered to types valid for section "${escapeHtml(sectionFilterLabel)}".</div>` : ''}
      <div style="display:flex; gap:8px; margin-bottom:10px;">
        <select id="ae-type"><option value="">All types</option>${typeOptions.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(elTitleFor(t))}</option>`).join('')}</select>
        <select id="ae-model"><option value="">All models</option>${modelOptions.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')}</select>
        <select id="ae-stream"><option value="">All streams</option>${streamOptions.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}</select>
      </div>
      <div style="max-height:320px; overflow:auto; border:1px solid var(--border); border-radius:6px;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead><tr>
            <th style="width:28px;"><input type="checkbox" id="ae-select-all" title="Select/deselect all rows matching current filters" /></th>
            <th class="ae-sort" data-col="label" style="cursor:pointer; text-align:left; padding:5px 8px;">Label</th>
            <th class="ae-sort" data-col="type" style="cursor:pointer; text-align:left; padding:5px 8px;">Type</th>
            <th class="ae-sort" data-col="model" style="cursor:pointer; text-align:left; padding:5px 8px;">Model</th>
            <th class="ae-sort" data-col="stream" style="cursor:pointer; text-align:left; padding:5px 8px;">Stream</th>
          </tr></thead>
          <tbody id="ae-tbody"></tbody>
        </table>
      </div>
      <div class="prop-row checkbox" style="margin-top:10px;"><input type="checkbox" id="ae-include-connectors" /><label for="ae-include-connectors">Include connectors</label></div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Add Selected</button></div>
    `;
    overlay.appendChild(box);
    root.appendChild(overlay);

    const renderRows = () => {
      let rows = availableParts.filter((p) =>
        (!uiState.typeFilter || ciEq(p.type, uiState.typeFilter)) &&
        (!uiState.modelFilter || ciEq(p.model, uiState.modelFilter)) &&
        (!uiState.streamFilter || (p.streams || []).includes(uiState.streamFilter)));
      rows = [...rows].sort((a, b) => {
        let va, vb;
        if (uiState.sortCol === 'type') { va = elTitleFor(a.type); vb = elTitleFor(b.type); }
        else if (uiState.sortCol === 'stream') { va = (a.streams || [])[0] || ''; vb = (b.streams || [])[0] || ''; }
        else { va = a[uiState.sortCol] || ''; vb = b[uiState.sortCol] || ''; }
        const cmp = String(va).localeCompare(String(vb));
        return uiState.sortDir === 'asc' ? cmp : -cmp;
      });
      uiState.currentRows = rows;
      const tbody = box.querySelector('#ae-tbody');
      tbody.innerHTML = rows.map((p) => `
        <tr>
          <td style="padding:4px 8px;"><input type="checkbox" class="ae-row-check" data-id="${p.id}" ${uiState.selected.has(p.id) ? 'checked' : ''} /></td>
          <td style="padding:4px 8px;">${escapeHtml(p.label)}</td>
          <td style="padding:4px 8px;">${escapeHtml(elTitleFor(p.type))}</td>
          <td style="padding:4px 8px;">${escapeHtml(p.model)}</td>
          <td style="padding:4px 8px;">${escapeHtml((p.streams || []).join(', '))}</td>
        </tr>`).join('') || `<tr><td colspan="5" style="text-align:center; padding:12px; color:var(--text-muted);">No matching parts</td></tr>`;
      tbody.querySelectorAll('.ae-row-check').forEach((cb) => {
        cb.addEventListener('change', () => {
          if (cb.checked) uiState.selected.add(cb.dataset.id); else uiState.selected.delete(cb.dataset.id);
          syncSelectAllCheckbox();
        });
      });
      syncSelectAllCheckbox();
    };
    const syncSelectAllCheckbox = () => {
      const selectAllCb = box.querySelector('#ae-select-all');
      const rows = uiState.currentRows || [];
      selectAllCb.checked = rows.length > 0 && rows.every((p) => uiState.selected.has(p.id));
      selectAllCb.indeterminate = !selectAllCb.checked && rows.some((p) => uiState.selected.has(p.id));
    };
    renderRows();

    box.querySelector('#ae-select-all').addEventListener('change', (e) => {
      const rows = uiState.currentRows || [];
      if (e.target.checked) rows.forEach((p) => uiState.selected.add(p.id));
      else rows.forEach((p) => uiState.selected.delete(p.id));
      renderRows();
    });
    box.querySelector('#ae-type').addEventListener('change', (e) => { uiState.typeFilter = e.target.value; renderRows(); });
    box.querySelector('#ae-model').addEventListener('change', (e) => { uiState.modelFilter = e.target.value; renderRows(); });
    box.querySelector('#ae-stream').addEventListener('change', (e) => { uiState.streamFilter = e.target.value; renderRows(); });
    box.querySelectorAll('.ae-sort').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (uiState.sortCol === col) uiState.sortDir = uiState.sortDir === 'asc' ? 'desc' : 'asc';
        else { uiState.sortCol = col; uiState.sortDir = 'asc'; }
        renderRows();
      });
    });

    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('.submit').addEventListener('click', () => {
      const includeConnectors = box.querySelector('#ae-include-connectors').checked;
      const partIds = [...uiState.selected];
      overlay.remove();
      if (partIds.length === 0) { this.toast('No parts selected.', true); return; }
      addExistingPartsToView(this, tab, partIds, includeConnectors, targetSectionInstanceId);
    });
  }

  promptMerge(tab, selIds) {
    const nodeVmIds = selIds.filter((id) => this.store.findViewMember(id)?.objectType === 'part');
    if (nodeVmIds.length < 2) { this.toast('Select 2 or more nodes to merge.', true); return; }
    const firstPart = this.store.findPart(this.store.findViewMember(nodeVmIds[0]).objectId);
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Merge ${nodeVmIds.length} nodes</h3>
      <div style="margin-bottom:12px;font-size:12px;color:var(--text-muted);">Choose merge scope:</div>
      <button id="merge-parts-and-view" class="primary" style="width:100%;margin-bottom:8px;padding:8px;border:1px solid var(--border);border-radius:5px;background:var(--primary-bg);color:var(--text);cursor:pointer;">Merge Parts and View</button>
      <button id="merge-view-only" class="primary" style="width:100%;margin-bottom:12px;padding:8px;border:1px solid var(--border);border-radius:5px;background:var(--primary-bg);color:var(--text);cursor:pointer;">Merge View Only</button>
      <div class="modal-actions"><button class="cancel">Cancel</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);
    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('#merge-parts-and-view').addEventListener('click', () => {
      overlay.remove();
      this.promptMergeDetails(tab, nodeVmIds, true);
    });
    box.querySelector('#merge-view-only').addEventListener('click', () => {
      overlay.remove();
      this.promptMergeDetails(tab, nodeVmIds, false);
    });
  }

  promptMergeDetails(tab, nodeVmIds, mergeParts) {
    const firstPart = this.store.findPart(this.store.findViewMember(nodeVmIds[0]).objectId);

    // For "merge parts" mode, check for cross-view usage first
    if (mergeParts) {
      const vms = nodeVmIds.map((id) => this.store.findViewMember(id)).filter((vm) => vm && vm.objectType === 'part');
      const restVms = vms.slice(1);
      const restParts = restVms.map((vm) => this.store.findPart(vm.objectId)).filter(Boolean);
      const restPartIds = new Set(restParts.map((p) => p.id));

      const usedViews = new Set();
      for (const p of restParts) {
        for (const vm of this.store.doc.viewMembers) {
          if (vm.objectType === 'part' && p.id === vm.objectId && vm.view !== tab.viewId) {
            usedViews.add(vm.view);
          }
        }
      }

      if (usedViews.size > 0) {
        const viewNames = Array.from(usedViews)
          .map((viewId) => this.store.findView(viewId)?.viewName || viewId)
          .join(', ');
        this.confirmModal(
          `Parts being merged are used in other views: ${viewNames}. This merge will affect those views. Continue?`
        ).then((confirmed) => {
          if (confirmed) {
            this.promptMergeNameDialog(tab, nodeVmIds, mergeParts, firstPart);
          }
        });
        return;
      }
    }

    this.promptMergeNameDialog(tab, nodeVmIds, mergeParts, firstPart);
  }

  promptMergeNameDialog(tab, nodeVmIds, mergeParts, firstPart) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Merge ${nodeVmIds.length} nodes</h3>
      <div class="prop-row"><label>New name</label><input type="text" id="merge-name" value="${escapeHtml(firstPart?.label || '')}" /></div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Merge</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);
    box.querySelector('#merge-name').focus();
    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('.submit').addEventListener('click', () => {
      const newName = box.querySelector('#merge-name').value || firstPart?.label || 'Merged';
      overlay.remove();
      if (mergeParts) {
        mergePartsAndView(this, tab, nodeVmIds, newName);
      } else {
        mergeViewOnly(this, tab, nodeVmIds, newName);
      }
    });
  }

  promptPaste(tab, canvasPos) {
    if (!this.clipboard || !this.clipboard.nodeVmIds.length) { this.toast('Nothing to paste.', true); return; }
    this.promptModal({
      title: 'Paste',
      fields: [{ key: 'mode', label: 'Parts', type: 'select', options: ['Create new', 'Use existing'], value: 'Create new' }],
      onSubmit: (vals) => pasteNodes(this, tab, vals.mode === 'Use existing' ? 'existing' : 'new', canvasPos),
    });
  }

  // ===================== MODAL =====================
  promptModal({ title, fields, onSubmit, closeOnOutsideClick = true }) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>${escapeHtml(title)}</h3>` + fields.map((f) => {
      if (f.type === 'select') {
        return `<div class="prop-row"><label>${escapeHtml(f.label)}</label><select data-key="${f.key}">${f.options.map((o) => `<option value="${escapeHtml(o)}" ${o === f.value ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></div>`;
      }
      if (f.type === 'checkbox') {
        return `<div class="prop-row checkbox"><input type="checkbox" data-key="${f.key}" ${f.value ? 'checked' : ''} /><label>${escapeHtml(f.label)}</label></div>`;
      }
      if (f.type === 'combo') {
        // Step 37: text input + native <datalist> — shows a suggestion dropdown of
        // existing values but, unlike <select>, still accepts any free-form typed text.
        const listId = `${f.key}-datalist`;
        return `<div class="prop-row"><label>${escapeHtml(f.label)}</label><input type="text" data-key="${f.key}" list="${listId}" value="${escapeHtml(f.value ?? '')}" /><datalist id="${listId}">${(f.options || []).map((o) => `<option value="${escapeHtml(o)}"></option>`).join('')}</datalist></div>`;
      }
      return `<div class="prop-row"><label>${escapeHtml(f.label)}</label><input type="text" data-key="${f.key}" value="${escapeHtml(f.value ?? '')}" /></div>`;
    }).join('') + `<div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">OK</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);
    box.querySelector('input,select')?.focus();
    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    // Generate Stream (Step 33) opts out of outside-click-closes, since it's easy to
    // accidentally dismiss mid-fill; every other caller keeps the previous default.
    if (closeOnOutsideClick) {
    }
    box.querySelector('.submit').addEventListener('click', () => {
      const vals = {};
      for (const f of fields) {
        const el = box.querySelector(`[data-key="${f.key}"]`);
        vals[f.key] = f.type === 'checkbox' ? el.checked : el.value;
      }
      overlay.remove();
      onSubmit(vals);
    });
  }

  confirmModal(message) {
    return new Promise((resolve) => {
      const root = document.getElementById('modal-root');
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.innerHTML = `<h3>Confirm</h3><div>${escapeHtml(message)}</div><div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">OK</button></div>`;
      overlay.appendChild(box);
      root.appendChild(overlay);
      box.querySelector('.cancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
      box.querySelector('.submit').addEventListener('click', () => { overlay.remove(); resolve(true); });
    });
  }

  /** Hooked from the property panel's Relationship/Streams setters (both connector
   * panels) and the on-canvas edge popover — NOT the multi-select bulk-edit path,
   * where prompting once per selected connector would be unusable. If the just-edited
   * connector has a related "inventory" (part-to-part) counterpart across a
   * Composition boundary — see findCrossingCounterpart, commands.js: covers both Level
   * Down's own original crossing connectors and ones Smart Check itself created —
   * asks whether to update that counterpart's relationship/streams to match too,
   * rather than silently leaving it stale (or silently overwriting it, which an
   * earlier automatic version of this did). No-op (no prompt) if this connector has no
   * such counterpart, which is the common case. Reported directly: "when changing a
   * view connector..., ask user if they want the inventory... connector to also be
   * updated." See also promptSmartCheckView/promptSmartCheckNode's own new "Sync
   * existing connectors with inventory" checkbox for the opposite, on-demand
   * direction (inventory -> view, for connectors not just-edited). */
  promptSyncInventoryConnector(conn) {
    const counterpart = findCrossingCounterpart(this.store, conn);
    if (!counterpart) return;
    const fromPart = this.store.findPart(counterpart.from);
    const toPart = this.store.findPart(counterpart.to);
    const desc = `"${fromPart ? fromPart.label : counterpart.from}" -> "${toPart ? toPart.label : counterpart.to}"`;
    this.confirmModal(`This connector also has a related inventory connector (${desc}). Update it to match this one's relationship/streams too?`).then((confirmed) => {
      if (!confirmed) return;
      this.store.restyleConnector(counterpart, { from: counterpart.from, to: counterpart.to, model: counterpart.model, connectorType: conn.connectorType, relationship: conn.relationship, streams: [...(conn.streams || [])] });
      this.store.touchConnector(counterpart);
      this.recordAndRender();
      this.toast(`Updated the inventory connector (${desc}) to match.`);
    });
  }

  /**
   * Step 33: generic large text-edit modal. Used for double-clicking a property panel
   * field's label (any text-type field — readonly display or writable input/textarea) and
   * for double-clicking the Message Log header. `readonly` shows the content with only a
   * Close button; otherwise shows Save + Cancel (cancel discards edits, does not call
   * onSave — this is the "revert" behavior).
   */
  promptTextEdit({ title, value, readonly = false, onSave }) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box modal-box-textedit';
    box.innerHTML = `<h3>${escapeHtml(title)}</h3>
      <textarea id="text-edit-area" class="text-edit-area" ${readonly ? 'readonly' : ''}>${escapeHtml(value ?? '')}</textarea>
      <div class="modal-actions">
        ${readonly ? '<button class="primary close">Close</button>' : '<button class="cancel">Cancel</button><button class="primary submit">Save</button>'}
      </div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);
    const textarea = box.querySelector('#text-edit-area');
    textarea.focus();
    if (readonly) {
      box.querySelector('.close').addEventListener('click', () => overlay.remove());
    } else {
      box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
      box.querySelector('.submit').addEventListener('click', () => {
        const newValue = textarea.value;
        overlay.remove();
        onSave(newValue);
      });
    }
  }

  // ===================== SAVE / LOAD =====================
  saveJson() {
    const jsonText = JSON.stringify(this.store.toJSON(), null, 2);
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dycad-model.json';
    a.click();
    URL.revokeObjectURL(url);
    this.store.dirty = false;
    // Cache under the file's own working name (what the user thinks of this session as),
    // not the fixed 'dycad-model.json' download filename — matches what File > Recently
    // Opened should show for a "loaded X, edited, saved" session.
    addRecentFile(this.store.loadedFileName || 'dycad-model.json', jsonText);
    this.render(); // clears the Save button's unsaved-changes color immediately
  }

  /** File > Save Local Secrets: store.localSecrets (API keys etc. — see ctx.secrets in
   * simulation.js) as a standalone downloadable file, kept entirely separate from Local
   * Settings (below) since secrets must never be cached to localStorage or bundled with
   * anything that is. Flat {key: value} shape, matching what Load Local Secrets expects
   * back and what ctx.secrets exposes directly. */
  saveLocalSecrets() {
    const data = this.store.localSecrets || {};
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dycad-local-secrets.json';
    a.click();
    URL.revokeObjectURL(url);
    this.toast('Local secrets saved.');
  }

  /** File > Save Local Settings: bundles user PREFERENCES that deliberately live outside
   * the main save file — the pinned-fields config, maxScriptEntities (the
   * ctx.createPart/ctx.createConnector safety cap, see simulation.js),
   * nodeSizeMultiplier (the default node box size new views are created with, see
   * state.js's defaultNodeSize), batchScriptCode (the Script Console's persistent
   * text, Advanced menu), smartStreamPresets (Insert Smart Stream's named dialog
   * presets), and remapPresets (Remap's named dialog presets) — into a single
   * downloadable file, so they travel together between browsers/machines. Deliberately
   * excludes secrets (see saveLocalSecrets above) — these two were bundled together in
   * an earlier version of this feature; split apart because secrets must never be
   * cached to localStorage while these settings now deliberately ARE (see
   * loadLocalSettings's handler), so bundling them would have meant either caching
   * secrets too (unacceptable) or a settings load leaving secrets in some ambiguous
   * state. */
  saveLocalSettings() {
    const data = { pinnedFields: getAllPinnedFields(), maxScriptEntities: this.store.maxScriptEntities, nodeSizeMultiplier: this.store.nodeSizeMultiplier, batchScriptCode: this.store.batchScriptCode, smartStreamPresets: this.store.smartStreamPresets, remapPresets: this.store.remapPresets };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dycad-local-settings.json';
    a.click();
    URL.revokeObjectURL(url);
    this.toast('Local settings saved.');
  }

  async loadJson(file) {
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      this.disposeAllOpenView3DTabs();
      this.store.loadFromJSON(obj);
      this.store.tabs = [];
      this.store.closedTabs = [];
      this.store.activeTabId = null;
      this.store.dirty = false;
      this.store.loadedFileName = file.name;
      addRecentFile(file.name, text);
      const homeView = this.store.findView(this.store.currentView) || this.store.doc.views[0];
      const tab = this.createCanvasTab(homeView);
      this.switchToTab(tab.id);
      this.toast('Model loaded.');
    } catch (err) {
      this.toast(`Load failed: ${err.message}`, true);
    }
  }

  /** Used before Load / Load Example (File menu): if there are unsaved edits, ask
   * whether to save first, discard, or cancel the load entirely. Returns a Promise
   * resolving to 'save' | 'discard' | 'cancel' — 'discard' immediately if nothing is
   * dirty, so callers can await this unconditionally. */
  confirmUnsavedChanges() {
    if (!this.store.dirty) return Promise.resolve('discard');
    return new Promise((resolve) => {
      const root = document.getElementById('modal-root');
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.innerHTML = `<h3>Unsaved changes</h3><div>You have unsaved changes. Save before loading?</div>
        <div class="modal-actions">
          <button class="cancel">Cancel</button>
          <button class="discard">Discard &amp; Load</button>
          <button class="primary save">Save &amp; Load</button>
        </div>`;
      overlay.appendChild(box);
      root.appendChild(overlay);
      box.querySelector('.cancel').addEventListener('click', () => { overlay.remove(); resolve('cancel'); });
      box.querySelector('.discard').addEventListener('click', () => { overlay.remove(); resolve('discard'); });
      box.querySelector('.save').addEventListener('click', () => { overlay.remove(); resolve('save'); });
    });
  }

  /** File > Load: same underlying routine as the "Load JSON" button (reuses the same
   * hidden file input + its existing change listener) — this just adds the unsaved-
   * changes check in front of it. "Erase existing data" is already inherent to
   * loadJson()/loadFromJSON, which fully replaces store.doc rather than merging. */
  async promptFileMenuLoad() {
    const choice = await this.confirmUnsavedChanges();
    if (choice === 'cancel') return;
    if (choice === 'save') this.saveJson();
    document.getElementById('load-json-input').click();
  }

  promptPrint() {
    const tab = this.store.activeTab();
    if (!tab || tab.type !== 'canvas') { this.toast('No view open to print.', true); return; }

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Print</h3>
      <div style="margin-bottom:12px;font-size:12px;color:var(--text-muted);">Choose what to print:</div>
      <button id="print-current" class="primary" style="width:100%;margin-bottom:8px;padding:8px;border:1px solid var(--border);border-radius:5px;background:var(--primary-bg);color:var(--text);cursor:pointer;">Current View</button>
      <button id="print-open" class="primary" style="width:100%;margin-bottom:8px;padding:8px;border:1px solid var(--border);border-radius:5px;background:var(--primary-bg);color:var(--text);cursor:pointer;">All Open Views</button>
      <button id="print-all" class="primary" style="width:100%;margin-bottom:12px;padding:8px;border:1px solid var(--border);border-radius:5px;background:var(--primary-bg);color:var(--text);cursor:pointer;">All Views</button>
      <div class="modal-actions"><button class="cancel">Cancel</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('#print-current').addEventListener('click', () => {
      overlay.remove();
      this.printViews([tab.viewId]);
    });
    box.querySelector('#print-open').addEventListener('click', () => {
      overlay.remove();
      const openViewIds = [...new Set(this.store.tabs.filter((t) => t.type === 'canvas').map((t) => t.viewId))];
      this.printViews(openViewIds);
    });
    box.querySelector('#print-all').addEventListener('click', () => {
      overlay.remove();
      const allViewIds = this.store.doc.views.map((v) => v.id);
      this.printViews(allViewIds);
    });
  }

  /** File > Print. Earlier version hand-rolled a SECOND SVG renderer (manual path/marker/
   * text-wrap string-building) that duplicated canvas.js's own logic — slow (one giant
   * string built per view) and prone to silently drifting from what the canvas actually
   * shows. This version instead reuses the REAL renderer: renderCanvasPage (canvas.js) —
   * the exact function that draws every on-screen view — building each view into a fully
   * detached, throwaway tab/container (never touching store.tabs, undo history, or the
   * visible page), then cloning the resulting .canvas-surface DOM straight into the print
   * iframe. Guaranteed pixel-identical to the canvas, and no per-node string building at
   * all — just clone + crop-to-content-bounds CSS. */
  printViews(viewIds) {
    try {
      const PADDING = 30;
      const markerDefsEl = document.getElementById('global-marker-defs'); // arrowhead <marker> defs live OUTSIDE .canvas-surface (see buildMarkerDefs, canvas.js) — must be cloned in separately or connector line-ends silently vanish
      const pages = [];

      for (const viewId of viewIds) {
        const view = this.store.findView(viewId);
        if (!view) continue;
        const partVms = this.store.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part');
        if (partVms.length === 0) continue;

        // Throwaway tab: matches store.createTab's shape for the fields renderCanvasPage
        // and its callees actually read, but deliberately NOT created via store.createTab
        // (which would push it into store.tabs, polluting the tab bar/undo history, and
        // pay for a full document snapshot() per view for no reason). No active filters,
        // no selection, zoom 1:1 — a clean "as designed" render regardless of whatever
        // zoom/pan/selection the user currently has on screen.
        const fakeTab = {
          id: `print-${view.id}`, type: 'canvas', viewId: view.id,
          viewport: { x: 0, y: 0, zoom: 1 }, selection: new Set(),
          activeStreams: null, activeElementTypes: null, activeSections: null, connectorLevels: 0, selectedSectionId: null,
        };
        const offscreen = document.createElement('div'); // never attached to the document — absolute-positioned content needs no live layout to build correctly
        renderCanvasPage(this, fakeTab, offscreen);
        const surface = offscreen.querySelector('.canvas-surface');
        if (!surface) continue;

        const { w: nodeW, h: nodeH } = getNodeSize(view);
        const minX = Math.min(...partVms.map((vm) => vm.x));
        const minY = Math.min(...partVms.map((vm) => vm.y));
        const maxX = Math.max(...partVms.map((vm) => vm.x + nodeW));
        const maxY = Math.max(...partVms.map((vm) => vm.y + nodeH));

        const clone = surface.cloneNode(true); // strips all interactive listeners for free — clones simply have none
        clone.style.background = 'none'; // no background image/dots, per the original request
        clone.style.marginLeft = `${-(minX - PADDING)}px`; // shifts content so the crop window below starts exactly at the content's own top-left
        clone.style.marginTop = `${-(minY - PADDING)}px`;

        pages.push({ viewName: view.viewName, contentW: maxX - minX + PADDING * 2, contentH: maxY - minY + PADDING * 2, surfaceClone: clone });
      }

      if (pages.length === 0) { this.toast('Nothing to print — no views with placed nodes.', true); return; }

      // A hidden iframe with a minimal srcdoc skeleton (not window.open()+document.write()
      // — the latter is blocked or silently no-ops in some browsers, which previously
      // produced a blank print window even when the content itself was built correctly).
      // Content is added via real DOM APIs after load, not baked into srcdoc — importNode
      // + append, no HTML string round-trip for the (potentially large) cloned surfaces.
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0;';
      iframe.addEventListener('load', () => {
        const idoc = iframe.contentDocument;

        const style = idoc.createElement('style');
        style.textContent = `
          * { box-sizing: border-box; }
          body { margin: 0; font-family: sans-serif; }
          .print-page { page-break-after: always; padding: 20px; }
          .print-page:last-child { page-break-after: avoid; }
          .print-title { font-size: 18px; font-weight: bold; margin-bottom: 16px; }
          .print-frame { overflow: hidden; position: relative; border: 1px solid #ddd; }
        `;
        idoc.head.appendChild(style);

        if (markerDefsEl) idoc.body.appendChild(idoc.importNode(markerDefsEl, true)); // once, shared by every page's connectors

        for (const p of pages) {
          const pageEl = idoc.createElement('div');
          pageEl.className = 'print-page';
          const titleEl = idoc.createElement('div');
          titleEl.className = 'print-title';
          titleEl.textContent = p.viewName;
          const frameEl = idoc.createElement('div');
          frameEl.className = 'print-frame';
          frameEl.style.width = `${p.contentW}px`;
          frameEl.style.height = `${p.contentH}px`;
          frameEl.appendChild(idoc.importNode(p.surfaceClone, true));
          pageEl.appendChild(titleEl);
          pageEl.appendChild(frameEl);
          idoc.body.appendChild(pageEl);
        }

        const link = idoc.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('css/styles.css', window.location.href).href;
        const doPrint = () => {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();
          // Cleanup after the print dialog is dismissed; 'afterprint' doesn't fire in every
          // browser for iframe content, so this is backed up by a generous fallback timeout.
          const cleanup = () => iframe.remove();
          iframe.contentWindow.addEventListener('afterprint', cleanup);
          setTimeout(cleanup, 60000);
        };
        link.addEventListener('load', doPrint);
        link.addEventListener('error', doPrint); // still print (just possibly unstyled) rather than hang forever on a failed stylesheet fetch
        idoc.head.appendChild(link);
      });
      iframe.srcdoc = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Print</title></head><body></body></html>';
      document.body.appendChild(iframe);
    } catch (err) {
      this.toast(`Print error: ${err.message}`, true);
      console.error('Print error:', err);
    }
  }

  /** File > Export View as Image: choose SVG or PNG for a 2D canvas view; a 3D View
   * tab has no format choice (PNG only — there's no meaningful SVG serialization of a
   * rendered WebGL scene) so it skips straight to exporting instead of opening a
   * picker with a single real option. */
  promptExportViewAsImage() {
    const tab = this.store.activeTab();
    if (!tab) { this.toast('No view open to export.', true); return; }
    if (tab.type === '3d') { this.exportView3DAsImage(tab); return; }
    if (tab.type !== 'canvas') { this.toast('No view open to export.', true); return; }
    const view = this.store.findView(tab.viewId);
    if (!view) return;

    this.promptModal({
      title: 'Export View as Image',
      fields: [{ key: 'format', label: 'Format', type: 'select', options: ['SVG', 'PNG'], value: 'SVG' }],
      onSubmit: (vals) => {
        if (vals.format === 'PNG') this.exportViewAsPng(view);
        else this.exportViewAsSvg(view);
      },
    });
  }

  /** File > Export View as Image, for a 3D View tab — the WebGL counterpart to
   * exportViewAsPng/exportViewAsSvg below, delegating the actual WebGL capture to
   * view3d.js's captureView3DImage (canvas.js's getView3DModule reaches the already-
   * lazy-loaded module directly, without triggering an eager import of Three.js —
   * reaching this method at all requires the 3D tab to already be active, i.e.
   * already rendered at least once, so the module is already loaded in practice; the
   * null checks below are a paranoid fallback, not the expected path). Same Blob →
   * object URL → synthetic <a download> → revoke pattern exportViewAsPng/
   * exportViewAsSvg already use. */
  async exportView3DAsImage(tab) {
    const mod = getView3DModule();
    if (!mod) { this.toast('3D View export failed — the 3D view has not finished loading yet.', true); return; }
    const blob = await mod.captureView3DImage(tab.id);
    if (!blob) { this.toast('3D View export failed.', true); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '3D View.png';
    a.click();
    URL.revokeObjectURL(url);
    this.toast('Exported "3D View" as PNG.');
  }

  /** Builds a standalone, portable SVG for one view — deliberately a SEPARATE, purpose-
   * built native-SVG renderer (rect/text/path only, no <foreignObject>), NOT a reuse of
   * renderCanvasPage the way Print is. Two different jobs: Print needs pixel-perfect
   * on-screen fidelity, where reusing the real DOM+CSS renderer is exactly right; this
   * needs a portable file other tools can open — and critically, an SVG containing
   * <foreignObject>-embedded HTML TAINTS a <canvas> on rasterization (verified directly:
   * browsers refuse toDataURL/toBlob afterward, even same-origin, even via a blob URL),
   * which would make PNG export outright impossible. Plain SVG primitives don't have
   * that restriction, so this is what actually makes PNG export achievable at all — the
   * approximate text-wrapping below (no real CSS layout available here) is the accepted
   * tradeoff for that. Returns null if the view has no placed nodes. */
  buildViewSvgString(view) {
    const PADDING = 30;
    const { w: nodeW, h: nodeH } = getNodeSize(view);
    const vms = this.store.viewMembersForView(view.id);
    const partVms = vms.filter((vm) => vm.objectType === 'part');
    if (partVms.length === 0) return null;

    // Section boxes + headers (view types other than 'ff') — included in the exported
    // image the same way they show on the real canvas (buildSectionsOverlay). Folded
    // into the overall bounding box too, not just drawn: a section can legitimately
    // extend past every node currently placed in it (empty cells, or an entirely empty
    // section), and previously only partVms' own positions were considered, silently
    // clipping those section boxes/headers out of the exported image. Reported
    // directly: "'export view to image' for a view of type 'org' doesn't also export
    // the section markers or headers."
    const sectionLayout = isSectionViewType(view.viewType) ? computeSectionLayout(view) : [];

    const showTypes = view?.chkShowElementTypes;
    const showDescription = view?.chkShowDescription;
    const xs = [...partVms.map((vm) => vm.x), ...partVms.map((vm) => vm.x + nodeW), ...sectionLayout.map((e) => e.left), ...sectionLayout.map((e) => e.left + e.width)];
    const ys = [...partVms.map((vm) => vm.y), ...partVms.map((vm) => vm.y + nodeH), ...sectionLayout.map((e) => e.top), ...sectionLayout.map((e) => e.top + e.height)];
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const width = maxX - minX + PADDING * 2;
    const height = maxY - minY + PADDING * 2;
    const ox = minX - PADDING, oy = minY - PADDING; // shift so content starts at (0,0)

    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif"><defs>`];

    const markerSizes = { small: 7, medium: 9, large: 13 };
    const lineEnds = this.store.settings.lineEnds || {};
    for (const [name, le] of Object.entries(lineEnds)) {
      if (!le.path) continue;
      for (const [sizeName, px] of Object.entries(markerSizes)) {
        parts.push(`<marker id="marker-${name}-${sizeName}" viewBox="-12 -2 24 24" markerWidth="${px}" markerHeight="${px}" refX="0" refY="10" orient="auto-start-reverse"><g transform="rotate(90 0 10)"><path d="${le.path}" fill="${le.fill || 'none'}" stroke="${le.stroke || 'black'}"/></g></marker>`);
      }
    }
    parts.push('</defs>');
    parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);

    // Section boxes + header labels, drawn first so nodes/connectors layer on top —
    // same visual as buildSectionsOverlay's .section-box/.section-header (dashed
    // border, faint fill, dashed header separator, muted bold label), reproduced here
    // in plain SVG rather than the CSS custom properties those classes reference.
    for (const entry of sectionLayout) {
      const bx = entry.left - ox, by = entry.top - oy;
      parts.push(`<rect x="${bx}" y="${by}" width="${entry.width}" height="${entry.height}" rx="6" fill="rgba(0,0,0,0.015)" stroke="#c4cad2" stroke-width="1" stroke-dasharray="4,3"/>`);
      if (entry.bodyHeight > 0) {
        parts.push(`<line x1="${bx}" y1="${by + entry.headerHeight}" x2="${bx + entry.width}" y2="${by + entry.headerHeight}" stroke="#c4cad2" stroke-width="1" stroke-dasharray="4,3"/>`);
      }
      const label = entry.section.name || '(untitled section)';
      parts.push(`<text x="${bx + 10}" y="${by + entry.headerHeight / 2 + 4}" font-size="11.5" font-weight="600" fill="#6b7280">${escapeHtml(label)}</text>`);
    }

    const halfW = nodeW / 2, halfH = nodeH / 2;
    for (const cvm of vms.filter((vm) => vm.objectType === 'connector')) {
      const conn = this.store.findConnector(cvm.objectId);
      const fromVm = this.store.findViewMember(cvm.fromVmId);
      const toVm = this.store.findViewMember(cvm.toVmId);
      if (!conn || !fromVm || !toVm) continue;
      const fCenter = { x: fromVm.x - ox + halfW, y: fromVm.y - oy + halfH };
      const tCenter = { x: toVm.x - ox + halfW, y: toVm.y - oy + halfH };
      const dx = tCenter.x - fCenter.x, dy = tCenter.y - fCenter.y;
      const margin = 11;
      const fc = clipToRectEdgeForExport(fCenter.x, fCenter.y, dx, dy, halfW + margin, halfH + margin);
      const tc = clipToRectEdgeForExport(tCenter.x, tCenter.y, -dx, -dy, halfW + margin, halfH + margin);

      const style = (this.store.settings.relationshipStyles || []).find((s) => ciEq(s.type, conn.relationship));
      const stroke = style?.stroke ?? conn.stroke ?? '#333';
      const strokeWidth = style?.strokeWidth ?? conn.strokeWidth ?? 2;
      const dash = style?.dash ?? conn.dash ?? [];
      const endSize = conn.endSize || 'medium';

      let d;
      if (conn.connectorType === 'c') {
        const midX = (fc.x + tc.x) / 2, midY = (fc.y + tc.y) / 2;
        const cdx = tc.x - fc.x, cdy = tc.y - fc.y;
        const len = Math.sqrt(cdx * cdx + cdy * cdy) || 1;
        const curveOffset = 30;
        const ctrlX = midX + (-cdy / len) * curveOffset, ctrlY = midY + (cdx / len) * curveOffset;
        d = `M ${fc.x} ${fc.y} Q ${ctrlX} ${ctrlY} ${tc.x} ${tc.y}`;
      } else {
        d = `M ${fc.x} ${fc.y} L ${tc.x} ${tc.y}`;
      }
      let pathHtml = `<path d="${d}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="none"`;
      if (dash.length) pathHtml += ` stroke-dasharray="${dash.join(',')}"`;
      if (style?.toLineEndSettingType && lineEnds[style.toLineEndSettingType]?.path) pathHtml += ` marker-end="url(#marker-${style.toLineEndSettingType}-${endSize})"`;
      if (style?.fromLineEndSettingType && lineEnds[style.fromLineEndSettingType]?.path) pathHtml += ` marker-start="url(#marker-${style.fromLineEndSettingType}-${endSize})"`;
      pathHtml += '/>';
      parts.push(pathHtml);
    }

    for (const vm of partVms) {
      const part = this.store.findPart(vm.objectId);
      if (!part) continue;
      const elDef = elementByType(this.store, part.type);
      const fillColor = vm.fillColor || groupFill(this, elDef);
      const cornerRadius = elDef?.cornerRadius ?? 7;
      const x = vm.x - ox, y = vm.y - oy;

      parts.push(`<rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="${cornerRadius}" fill="${fillColor}" stroke="rgba(0,0,0,0.4)" stroke-width="1.5"/>`);

      const padX = 8, padY = 6;
      let cursorY = y + padY;
      if (showTypes || elDef) {
        const iconW = 26, iconH = 13;
        if (showTypes) {
          const typeText = (elDef?.title || part.type).toUpperCase();
          parts.push(`<text x="${x + padX}" y="${cursorY + 6}" font-size="9" letter-spacing="0.3" fill="#333" opacity="0.7">${escapeHtml(typeText)}</text>`);
        }
        const iconFill = groupFill(this, elDef);
        const iconX = x + nodeW - padX - iconW;
        if (elDef && elDef.path) {
          parts.push(`<svg x="${iconX}" y="${cursorY}" width="${iconW}" height="${iconH}" viewBox="0 0 40 20"><path d="${elDef.path}" stroke="black" stroke-width="1.5" fill="${iconFill}"/></svg>`);
        } else {
          const r = Math.min(elDef?.cornerRadius ?? 6, 8);
          parts.push(`<svg x="${iconX}" y="${cursorY}" width="${iconW}" height="${iconH}" viewBox="0 0 40 20"><rect x="4" y="1" width="32" height="18" rx="${r}" stroke="black" stroke-width="1.5" fill="${iconFill}"/></svg>`);
        }
        cursorY += iconH + 4;
      }

      const labelLines = wrapTextForExport(part.label, nodeW - padX * 2, 12, 2);
      for (const line of labelLines) {
        cursorY += 12;
        parts.push(`<text x="${x + padX}" y="${cursorY}" font-size="12" font-weight="600" fill="#1c2128">${escapeHtml(line)}</text>`);
      }
      if (showDescription && part.description) {
        const descLines = wrapTextForExport(part.description, nodeW - padX * 2, 10, 2);
        for (const line of descLines) {
          cursorY += 11;
          parts.push(`<text x="${x + padX}" y="${cursorY}" font-size="10" fill="#1c2128" opacity="0.8">${escapeHtml(line)}</text>`);
        }
      }
    }

    parts.push('</svg>');
    return { svgString: parts.join(''), width, height };
  }

  exportViewAsSvg(view) {
    const built = this.buildViewSvgString(view);
    if (!built) { this.toast('Nothing to export — no nodes in this view.', true); return; }
    const blob = new Blob([built.svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${view.viewName || 'view'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
    this.toast(`Exported "${view.viewName}" as SVG.`);
  }

  exportViewAsPng(view, scale = 2) {
    const built = this.buildViewSvgString(view);
    if (!built) { this.toast('Nothing to export — no nodes in this view.', true); return; }
    const { svgString, width, height } = built;
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.addEventListener('load', () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((pngBlob) => {
        if (!pngBlob) { this.toast('PNG export failed.', true); return; }
        const pngUrl = URL.createObjectURL(pngBlob);
        const a = document.createElement('a');
        a.href = pngUrl;
        a.download = `${view.viewName || 'view'}.png`;
        a.click();
        URL.revokeObjectURL(pngUrl);
        this.toast(`Exported "${view.viewName}" as PNG.`);
      }, 'image/png');
    });
    img.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      this.toast('PNG export failed to render.', true);
    });
    img.src = url;
  }

  /** File > Load Example: lists public/examples/index.json's entries, same unsaved-
   * changes gate as promptFileMenuLoad, then fetches and loads the chosen file through
   * the same loadFromJSON path (full replace = erase existing data). */
  async promptLoadExample() {
    const choice = await this.confirmUnsavedChanges();
    if (choice === 'cancel') return;
    if (choice === 'save') this.saveJson();

    let manifest;
    try {
      const res = await fetch('public/examples/index.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      this.toast(`Could not load examples list: ${err.message}`, true);
      return;
    }
    if (!Array.isArray(manifest) || manifest.length === 0) {
      this.toast('No example files found.', true);
      return;
    }

    this.promptModal({
      title: 'Load Example',
      fields: [{ key: 'file', label: 'Example', type: 'select', options: manifest, value: manifest[0] }],
      onSubmit: async (vals) => {
        try {
          const res = await fetch(`public/examples/${encodeURIComponent(vals.file)}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const obj = await res.json();
          this.disposeAllOpenView3DTabs();
          this.store.loadFromJSON(obj);
          this.store.tabs = [];
          this.store.closedTabs = [];
          this.store.activeTabId = null;
          this.store.dirty = false;
          this.store.loadedFileName = vals.file;
          const homeView = this.store.findView(this.store.currentView) || this.store.doc.views[0];
          const tab = this.createCanvasTab(homeView);
          this.switchToTab(tab.id);
          this.toast(`Loaded example "${vals.file}".`);
        } catch (err) {
          this.toast(`Failed to load example: ${err.message}`, true);
        }
      },
    });
  }

  /** File > Recently Opened: the last few files loaded (or saved) in THIS browser,
   * cached locally as plain JSON text — see addRecentFile's own comment for why. Loads
   * straight from that cached text, no file picker, same unsaved-changes gate and
   * full-replace semantics as Load/Load Example. */
  async promptLoadRecent() {
    const recent = getRecentFiles();
    if (recent.length === 0) { this.toast('No recently opened files in this browser yet.', true); return; }

    const choice = await this.confirmUnsavedChanges();
    if (choice === 'cancel') return;
    if (choice === 'save') this.saveJson();

    const labelFor = (f) => `${f.name} — ${new Date(f.savedAt).toLocaleString()}`;
    this.promptModal({
      title: 'Recently Opened',
      fields: [{
        key: 'file', label: 'File', type: 'select',
        options: recent.map(labelFor), value: labelFor(recent[0]),
      }],
      onSubmit: (vals) => {
        const entry = recent.find((f) => labelFor(f) === vals.file);
        if (!entry) { this.toast('That entry is no longer available.', true); return; }
        try {
          const obj = JSON.parse(entry.content);
          this.disposeAllOpenView3DTabs();
          this.store.loadFromJSON(obj);
          this.store.tabs = [];
          this.store.closedTabs = [];
          this.store.activeTabId = null;
          this.store.dirty = false;
          this.store.loadedFileName = entry.name;
          const homeView = this.store.findView(this.store.currentView) || this.store.doc.views[0];
          const tab = this.createCanvasTab(homeView);
          this.switchToTab(tab.id);
          this.toast(`Loaded "${entry.name}" from Recently Opened.`);
        } catch (err) {
          this.toast(`Failed to load "${entry.name}": ${err.message}`, true);
        }
      },
    });
  }

  /**
   * Step 33: File > Import Data. Bespoke modal (the generic promptModal has no file-
   * picker field type, and the file-vs-examples toggle needs live show/hide) with a file
   * selector OR an examples dropdown (toggled by the "Use example file" checkbox) plus
   * the three merge-behavior checkboxes. Runs the actual merge via runImportData below.
   */
  async promptImportData() {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Import Data</h3>
      <div class="prop-row checkbox"><input type="checkbox" id="imp-examples" /><label for="imp-examples">Use example file</label></div>
      <div class="prop-row" id="imp-file-row"><label>File</label><input type="file" id="imp-file-input" accept="application/json" /></div>
      <div class="prop-row hidden" id="imp-example-row"><label>Example</label><select id="imp-example-select"></select></div>
      <div class="prop-row checkbox"><input type="checkbox" id="imp-new-keys" /><label for="imp-new-keys">Create New Part and Connector Keys (don't update existing)</label></div>
      <div class="prop-row checkbox"><input type="checkbox" id="imp-cur-view" /><label for="imp-cur-view">Add to current View (don't use source views)</label></div>
      <div class="prop-row checkbox"><input type="checkbox" id="imp-cur-model" /><label for="imp-cur-model">Add to current Model (don't use source models)</label></div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Import</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    const examplesCheckbox = box.querySelector('#imp-examples');
    const fileRow = box.querySelector('#imp-file-row');
    const exampleRow = box.querySelector('#imp-example-row');
    const exampleSelect = box.querySelector('#imp-example-select');

    let manifest = null;
    const ensureManifestLoaded = async () => {
      if (manifest) return manifest;
      try {
        const res = await fetch('public/examples/index.json', { cache: 'no-store' });
        manifest = await res.json();
      } catch {
        manifest = [];
      }
      exampleSelect.innerHTML = manifest.map((f) => `<option value="${f}">${f}</option>`).join('') || '<option value="">(none found)</option>';
      return manifest;
    };

    examplesCheckbox.addEventListener('change', async () => {
      if (examplesCheckbox.checked) {
        fileRow.classList.add('hidden');
        exampleRow.classList.remove('hidden');
        await ensureManifestLoaded();
      } else {
        fileRow.classList.remove('hidden');
        exampleRow.classList.add('hidden');
      }
    });

    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('.submit').addEventListener('click', async () => {
      const useExamples = examplesCheckbox.checked;
      const newKeys = box.querySelector('#imp-new-keys').checked;
      const useCurrentView = box.querySelector('#imp-cur-view').checked;
      const useCurrentModel = box.querySelector('#imp-cur-model').checked;

      let obj;
      try {
        if (useExamples) {
          const chosen = exampleSelect.value;
          if (!chosen) { this.toast('No example file selected.', true); return; }
          const res = await fetch(`public/examples/${encodeURIComponent(chosen)}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          obj = await res.json();
        } else {
          const fileInput = box.querySelector('#imp-file-input');
          const file = fileInput.files[0];
          if (!file) { this.toast('Choose a file to import.', true); return; }
          obj = JSON.parse(await file.text());
        }
      } catch (err) {
        this.toast(`Import failed to load: ${err.message}`, true);
        return;
      }
      overlay.remove();
      runImportData(this, obj, { newKeys, useCurrentView, useCurrentModel });
    });
  }

  /** File > Load SFCE: imports an arbitrary JSON file as THE industry collection
   * (Section/Function/Capability/Application Capability/Entity) for Advanced > Generate
   * Industry — CLEARS and REPLACES whatever's currently loaded (the built-in default or
   * a previous Load SFCCE import; only one ever exists at a time), warning first if
   * something is already loaded (see promptSFCCEMapping's submit handler). Doesn't
   * touch the canvas — no viewMembers, no new view; only store.doc.industryTree. */
  promptLoadSFCCE() {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Load SFCCE</h3>
      <p style="font-size:12px; color:var(--text-muted); margin-top:-6px;">Loads a Section/Function/Capability/Application Capability/Entity collection from a JSON file as an alternate to the built-in "general" industry data, for use with Advanced &gt; Generate Industry. Any level below Function can be left unmapped — its value then inherits the level above it (e.g. no distinct Application Capability data means each one just takes its Business Capability's own name). This does not add anything to the current view.</p>
      <div class="prop-row"><label>File</label><input type="file" id="sfcce-file-input" accept="application/json" /></div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary" id="sfcce-preread-btn">Preread</button></div>
    `;
    overlay.appendChild(box);
    root.appendChild(overlay);
    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());

    box.querySelector('#sfcce-preread-btn').addEventListener('click', async () => {
      const fileInput = box.querySelector('#sfcce-file-input');
      const file = fileInput.files?.[0];
      if (!file) { this.toast('Choose a file first.', true); return; }
      let raw;
      try {
        const text = await file.text();
        raw = JSON.parse(text);
      } catch (err) {
        this.toast(`Could not read that file as JSON: ${err.message}`, true);
        return;
      }
      const { records, fields } = flattenJsonRecords(raw);
      if (records.length === 0) {
        this.toast('No records found in that file — check it contains an array of objects (optionally nested, e.g. groups each containing a list of items, which may themselves each contain another nested list).', true);
        return;
      }
      overlay.remove();
      this.promptSFCCEMapping(records, fields);
    });
  }

  /** Second step: field selectors, built from what flattenJsonRecords found in the
   * file. Capability/Application Capability/Entity (and their description fields) are
   * all optional — "(none)" means that level cascades from the one above it (see
   * buildRowsFromRecords' own comment) rather than being dropped, the way Load SFCE's
   * original Entity field alone used to work. No Industry Name field — there's only
   * ever one industry dataset (see state.js's doc.industryTree comment), so this always
   * replaces it rather than adding a new named one. */
  promptSFCCEMapping(records, fields) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box modal-box-textedit';

    // "Section for shared functions" (below): the real, known Sections a shared
    // Function can be collapsed into, sorted the same way custom.json's own org-view
    // sections display — see promptSFCCESharedFunctionsConfirm's own comment for how
    // this is actually used.
    // elementTypes-filtered: a header/label row (e.g. custom.json's 'title' section, with
    // elementTypes: []) can't actually hold BusinessFunction content in the org view, so
    // it's not a valid destination for a shared Function either.
    const orgSections = (this.store.settings.sections || []).filter((s) => ciEq(s.viewType, 'org') && (s.elementTypes || []).some((t) => ciEq(t, 'BusinessFunction'))).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const defaultSharedSectionId = orgSections.some((s) => s.sectionId === 'cof') ? 'cof' : (orgSections[0]?.sectionId || '');

    // Lightweight keyword-based suggestion per field — the person can always override
    // via the dropdown; this just saves picking through the list for the common case.
    // Tries each keyword in priority order across ALL fields before falling back to the
    // next keyword — not the other way around — otherwise a low-priority but early-
    // appearing keyword (e.g. 'capability' matching 'capability_count', a numeric
    // field) would win over a better, later match like 'name'.
    const suggest = (...keywords) => {
      for (const kw of keywords) {
        const match = fields.find((f) => f.toLowerCase().includes(kw));
        if (match) return match;
      }
      return '';
    };
    // Depth-aware variant, for Capability vs Application Capability specifically: with
    // flattenJsonRecords' full dot-path naming (e.g. "businessCapabilities.name" vs
    // "businessCapabilities.applicationCapabilities.name"), the two levels often share
    // the exact same trailing keyword — the field with FEWER dot-separated segments is
    // reliably the shallower (Capability) one, more segments the deeper (Application Capability)
    // one, regardless of what either level happens to be called in this particular file.
    const suggestByDepth = (keywords, deepest) => {
      const matches = fields.filter((f) => keywords.some((kw) => f.toLowerCase().includes(kw)));
      if (matches.length === 0) return '';
      return matches.reduce((best, f) => {
        const better = deepest ? f.split('.').length > best.split('.').length : f.split('.').length < best.split('.').length;
        return better ? f : best;
      });
    };
    const suggestedSection = suggest('section', 'ministr', 'department', 'group');
    const suggestedSectionDescription = suggest('sectiondescription', 'section description', 'section_description', 'section desc');
    const suggestedSectionId = suggest('sectionid', 'section id', 'section_id');
    const suggestedFunction = suggest('function', 'domain', 'category');
    const suggestedFunctionDescription = suggest('functiondescription', 'domaindescription', 'function description', 'function_description', 'function desc', 'domain description');
    const suggestedFunctionId = suggest('functionid', 'domainid', 'function id', 'function_id', 'domain id');
    const capabilityKeywords = ['capability', 'name', 'title'];
    const suggestedCapability = suggestByDepth(capabilityKeywords, false);
    const suggestedCapabilityDescription = suggestByDepth(['description', 'desc', 'summary'], false);
    // A bare 'id' keyword is too generic here — it'd happily match an unrelated shallow
    // field like "domainId"/"sectionId" ahead of the real "capabilities.capId" (confirmed:
    // a real false-positive found via direct testing). Scope the candidate set to fields
    // whose OWN dotted path already signals "this belongs to the capability group" (an
    // "capab" substring, matching how a real capabilities/businessCapabilities nesting
    // key would appear in the dot-path) before ranking by depth, same shallow-vs-deepest
    // split the name/description suggestions already use to tell Capability from
    // Application Capability.
    const isIdLikeField = (f) => {
      const last = f.split('.').pop();
      return /Id$/.test(last) || /^id$/i.test(last) || /_id$/i.test(last);
    };
    const suggestCapabilityIdByDepth = (deepest) => {
      const matches = fields.filter((f) => isIdLikeField(f) && f.toLowerCase().includes('capab'));
      if (matches.length === 0) return '';
      return matches.reduce((best, f) => {
        const better = deepest ? f.split('.').length > best.split('.').length : f.split('.').length < best.split('.').length;
        return better ? f : best;
      });
    };
    const suggestedCapabilityId = suggestCapabilityIdByDepth(false);
    const suggestedApplicationCapability = suggestByDepth(capabilityKeywords, true);
    const suggestedApplicationCapabilityDescription = suggestByDepth(['description', 'desc', 'summary'], true);
    const suggestedApplicationCapabilityId = suggestCapabilityIdByDepth(true);
    const suggestedEntity = suggest('entity', 'object', 'data');
    const suggestedEntityDescription = suggest('entity description', 'entity_description');
    const suggestedEntityId = suggest('entity id', 'entity_id');

    const fieldOptions = (selected) => fields.map((f) => `<option value="${escapeHtml(f)}" ${f === selected ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('');
    // Three distinct "nothing mapped" conventions, each worded for what actually
    // happens — conflating them (the original single fieldOptionsWithNone did, for
    // every optional field alike) is misleading: only Capability/Application
    // Capability/Entity NAME genuinely inherit from the level above when left
    // unmapped; a Description just stays blank (never inherited); an Id falls back to
    // an auto-DERIVED (deterministic, name-based) one, not inherited from anywhere.
    const fieldOptionsCascade = (selected) => `<option value="">(none — inherit from the level above)</option>` + fieldOptions(selected);
    const fieldOptionsDescription = (selected) => `<option value="">(none)</option>` + fieldOptions(selected);
    const fieldOptionsId = (selected) => `<option value="">(none — auto-generate from name)</option><option value="${GENERATE_UNIQUE_ID}" ${selected === GENERATE_UNIQUE_ID ? 'selected' : ''}>(generate unique)</option>` + fieldOptions(selected);

    box.innerHTML = `<h3>Load SFCCE — ${records.length} record${records.length === 1 ? '' : 's'} found</h3>
      <div class="sfcce-mapping-grid">
        <div class="sfcce-mapping-row sfcce-mapping-header prop-row"><span></span><span>Field</span><span>Description</span><span>Id</span></div>
        <div class="sfcce-mapping-row prop-row">
          <label>Section</label>
          <select id="sfcce-field-section">${fieldOptions(suggestedSection)}</select>
          <select id="sfcce-field-section-desc">${fieldOptionsDescription(suggestedSectionDescription)}</select>
          <select id="sfcce-field-section-id">${fieldOptionsId(suggestedSectionId)}</select>
        </div>
        <div class="sfcce-mapping-row prop-row">
          <label>Function</label>
          <select id="sfcce-field-function">${fieldOptions(suggestedFunction)}</select>
          <select id="sfcce-field-function-desc">${fieldOptionsDescription(suggestedFunctionDescription)}</select>
          <select id="sfcce-field-function-id">${fieldOptionsId(suggestedFunctionId)}</select>
        </div>
        <div class="sfcce-mapping-row prop-row">
          <label>Capability</label>
          <select id="sfcce-field-capability">${fieldOptionsCascade(suggestedCapability)}</select>
          <select id="sfcce-field-capability-desc">${fieldOptionsDescription(suggestedCapabilityDescription)}</select>
          <select id="sfcce-field-capability-id">${fieldOptionsId(suggestedCapabilityId)}</select>
        </div>
        <div class="sfcce-mapping-row prop-row">
          <label>Application Capability</label>
          <select id="sfcce-field-application-capability">${fieldOptionsCascade(suggestedApplicationCapability)}</select>
          <select id="sfcce-field-application-capability-desc">${fieldOptionsDescription(suggestedApplicationCapabilityDescription)}</select>
          <select id="sfcce-field-application-capability-id">${fieldOptionsId(suggestedApplicationCapabilityId)}</select>
        </div>
        <div class="sfcce-mapping-row prop-row">
          <label>Entity</label>
          <select id="sfcce-field-entity">${fieldOptionsCascade(suggestedEntity)}</select>
          <select id="sfcce-field-entity-desc">${fieldOptionsDescription(suggestedEntityDescription)}</select>
          <select id="sfcce-field-entity-id">${fieldOptionsId(suggestedEntityId)}</select>
        </div>
      </div>
      <p style="font-size:12px; color:var(--text-muted);">A Section value containing multiple entries (a comma-separated list, or an array) is split into one row per section. A missing Function value is kept as "(unspecified)" rather than dropped. A missing Capability/Application Capability/Entity value inherits the level above it instead. Description is always optional metadata — left blank if unmapped. Id is optional too: left blank, a level gets a deterministic id derived from its own name; "(generate unique)" mints a genuinely fresh, random id instead regardless of anything in the file.</p>
      <div class="prop-row"><label>Section for shared functions</label><select id="sfcce-shared-section">${orgSections.map((s) => `<option value="${escapeHtml(s.sectionId)}" ${s.sectionId === defaultSharedSectionId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select></div>
      <p style="font-size:11px; color:var(--text-muted); margin-top:-6px;">If a Function name ends up needing to exist in more than one Section and you choose to combine it into one shared node (next step, if it comes up), it's placed under this real Section instead of a generic "Shared" tag.</p>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Load</button></div>
    `;
    overlay.appendChild(box);
    root.appendChild(overlay);
    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());

    // Shared by the submit handler and the right-click "copy call" handler below, so
    // both read the form the same way and can never drift out of sync with each other
    // (same pattern promptRemap's collectRemapOptions already established).
    const collectSfcceMapping = () => ({
      sectionField: box.querySelector('#sfcce-field-section').value,
      sectionDescriptionField: box.querySelector('#sfcce-field-section-desc').value || null,
      sectionIdField: box.querySelector('#sfcce-field-section-id').value || null,
      functionField: box.querySelector('#sfcce-field-function').value,
      functionDescriptionField: box.querySelector('#sfcce-field-function-desc').value || null,
      functionIdField: box.querySelector('#sfcce-field-function-id').value || null,
      capabilityField: box.querySelector('#sfcce-field-capability').value || null,
      capabilityDescriptionField: box.querySelector('#sfcce-field-capability-desc').value || null,
      capabilityIdField: box.querySelector('#sfcce-field-capability-id').value || null,
      applicationCapabilityField: box.querySelector('#sfcce-field-application-capability').value || null,
      applicationCapabilityDescriptionField: box.querySelector('#sfcce-field-application-capability-desc').value || null,
      applicationCapabilityIdField: box.querySelector('#sfcce-field-application-capability-id').value || null,
      entityField: box.querySelector('#sfcce-field-entity').value || null,
      entityDescriptionField: box.querySelector('#sfcce-field-entity-desc').value || null,
      entityIdField: box.querySelector('#sfcce-field-entity-id').value || null,
    });

    wireCopyCallOnRightClick(this, box.querySelector('.submit'), () => `buildRowsFromRecords(records, ${JSON.stringify(collectSfcceMapping(), null, 2)});`);
    box.querySelector('.submit').addEventListener('click', () => {
      const mapping = collectSfcceMapping();
      const parsed = buildRowsFromRecords(records, mapping);
      const sharedSectionId = box.querySelector('#sfcce-shared-section').value;
      const sharedSectionName = orgSections.find((s) => s.sectionId === sharedSectionId)?.name || sharedSectionId;
      const proceed = () => { overlay.remove(); this.promptSFCCESharedFunctionsConfirm(parsed, parsed.rows, sharedSectionName, sharedSectionId); };
      // Only one industry dataset ever exists — this always REPLACES it, so warn first
      // if something is already loaded (the built-in default counts too, not just a
      // previous Load SFCCE import) rather than silently discarding it.
      if (this.store.doc.industryTree && this.store.doc.industryTree.length > 0) {
        this.confirmModal('Loading this file will clear and replace the current industry data (used by Advanced > Generate Industry and Catalogs > SFCCE). Continue?').then((confirmed) => {
          if (confirmed) proceed();
        });
      } else {
        proceed();
      }
    });
  }

  /** Checks whether any Function name ends up needing to exist in more than one
   * Section, and if so, shows one confirm modal asking whether to combine those
   * copies into a single shared Function (placed under `sharedSectionName`, from
   * promptSFCCEMapping's own "Section for shared functions" selector) or keep each
   * section's own numbered copy. Calls finishSFCCEImport either way. Reported directly:
   * "remove option for combining into 'shared' at business capability or application
   * capability level. these will never be combined into shared, only functions are
   * combined." — this used to walk THREE independently-resolvable levels (Function,
   * then Business Capability, then Application Capability, each its own confirm
   * modal); the deeper two are gone now, not just their UI option, since genuine
   * Capability/Application Capability-level sharing is structurally impossible once
   * Function-level sharing has always been resolved (see sfce.js's
   * resolveSharedFunctions comment for the proof). */
  promptSFCCESharedFunctionsConfirm(parsed, rows, sharedSectionName, sharedSectionId) {
    const { sectionsByFunction, sharedFunctionNames } = detectSharedFunctions(rows);
    if (sharedFunctionNames.size === 0) {
      this.finishSFCCEImport(rows, parsed);
      return;
    }

    const sharedCount = sharedFunctionNames.size;
    const exampleName = [...sharedFunctionNames][0];
    const exampleSections = sectionsByFunction.get(exampleName);

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Shared Domains found</h3>
      <p>${sharedCount} Domain${sharedCount === 1 ? '' : ' name'}${sharedCount === 1 ? ' ends' : 's end'} up needing to exist in more than one Section — e.g. "${escapeHtml(exampleName)}" appears in: ${exampleSections.map(escapeHtml).join(', ')}.</p>
      <p>Combine each of these into a single shared Domain (with everything below it from every section combined), placed under Section "${escapeHtml(sharedSectionName)}"?</p>
      <div class="modal-actions"><button class="cancel" id="sfcce-shared-no">No, keep in original sections</button><button class="primary" id="sfcce-shared-yes">Yes, use "${escapeHtml(sharedSectionName)}"</button></div>
    `;
    overlay.appendChild(box);
    root.appendChild(overlay);
    box.querySelector('#sfcce-shared-yes').addEventListener('click', () => {
      overlay.remove();
      this.finishSFCCEImport(resolveSharedFunctions(rows, sectionsByFunction, sharedFunctionNames, true, sharedSectionName, sharedSectionId), parsed);
    });
    box.querySelector('#sfcce-shared-no').addEventListener('click', () => {
      overlay.remove();
      this.finishSFCCEImport(resolveSharedFunctions(rows, sectionsByFunction, sharedFunctionNames, false, sharedSectionName, sharedSectionId), parsed);
    });
  }

  /** Builds the tree and REPLACES store.doc.industryTree with it (registering the
   * 'SFCCE' stream template so Generate Industry walks its 4 levels — see
   * store.doc.industryTemplateName's own comment in state.js), refreshes an already-
   * open SFCCE Catalog tab if there is one (it would otherwise keep showing the just-
   * replaced data until next switched away from and back to), and reports statistics —
   * the unique section list (first-seen order) and subtotals — to the Message Log as
   * well as a toast summary. */
  finishSFCCEImport(resolvedRows, parsed) {
    const { tree, stats } = buildIndustryTree(resolvedRows);
    this.store.doc.industryTree = tree;
    this.store.doc.industryTemplateName = 'SFCCE';
    const catalogTab = this.store.tabs.find((t) => t.type === 'table' && t.sfceCatalog);
    if (catalogTab) catalogTab.tableRows = flattenIndustryTree(tree);

    const lines = [
      `[Load SFCCE] ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} processed.`,
      `Sections (${stats.sectionOrder.length}, in order): ${stats.sectionOrder.join(', ')}`,
      `Subtotals — Functions: ${stats.functionCount}, Capabilities: ${stats.capabilityCount}, Application Capabilities: ${stats.applicationCapabilityCount}, Entities: ${stats.entityCount}`,
    ];
    const notes = [];
    if (stats.mergedDuplicates) notes.push(`${stats.mergedDuplicates} exact duplicate row${stats.mergedDuplicates === 1 ? '' : 's'} merged`);
    if (parsed.missingFunction) notes.push(`${parsed.missingFunction} row${parsed.missingFunction === 1 ? '' : 's'} had no Function value`);
    if (parsed.missingCapability) notes.push(`${parsed.missingCapability} row${parsed.missingCapability === 1 ? '' : 's'} had no Capability value (inherited Function's)`);
    if (parsed.missingApplicationCapability) notes.push(`${parsed.missingApplicationCapability} row${parsed.missingApplicationCapability === 1 ? '' : 's'} had no Application Capability value (inherited Capability's)`);
    if (parsed.missingEntity) notes.push(`${parsed.missingEntity} row${parsed.missingEntity === 1 ? '' : 's'} had no Entity value (inherited Application Capability's)`);
    if (parsed.missingDescription) notes.push(`${parsed.missingDescription} row${parsed.missingDescription === 1 ? '' : 's'} had no Capability Description value`);
    if (notes.length) lines.push(`Missing-value handling: ${notes.join('; ')} — kept, not dropped.`);

    for (const line of lines) pushMessageLog(this.store, line);
    this.recordAndRender();
    this.toast(`Loaded: ${stats.sectionOrder.length} sections, ${stats.functionCount} functions, ${stats.capabilityCount} capabilities, ${stats.applicationCapabilityCount} application capabilities, ${stats.entityCount} entities. Details in the Message Log.`);
  }
}

/**
 * Step 33: the actual Import Data merge algorithm.
 * - newKeys true: every imported part/connector gets a brand-new id, with every
 *   reference to the OLD id (connector.from/to, viewMember.objectId) rewritten to match
 *   — treats the import as entirely fresh content appended alongside whatever's there.
 * - newKeys false: imported ids are kept as-is; if a part/connector with that id already
 *   exists, the imported record's fields are shallow-merged onto it (imported data wins
 *   on any field present in both) rather than creating a duplicate.
 * - useCurrentView true: every imported viewMember's `view` is rewritten to the
 *   currently open view — the source file's own views array is not imported at all.
 *   false: the source views are merged into store.doc.views (same id-merge rule as
 *   parts/connectors) so whatever view the viewMembers actually reference exists.
 * - useCurrentModel true: every imported part/connector's `model` is rewritten to
 *   store.defaultModel; the source models array is not imported. false: the source
 *   models are merged into store.doc.models (dedup by modelName).
 * viewMembers themselves are never deduplicated/merged by id (not asked for) — they're
 * always appended as new entries, referencing the (possibly rewritten) part/connector/
 * view ids.
 */
function runImportData(app, obj, { newKeys, useCurrentView, useCurrentModel }) {
  const { store } = app;
  const idMap = new Map(); // old part/connector id -> new id, only populated when newKeys=true

  let importParts = (obj.parts || []).map((p) => ({ ...p }));
  let importConnectors = (obj.connectors || []).map((c) => ({ ...c }));
  let importViewMembers = (obj.viewMembers || []).map((vm) => ({ ...vm }));
  let importViews = (obj.views || []).map((v) => ({ ...v }));
  let importModels = (obj.models || []).map((m) => ({ ...m }));

  if (newKeys) {
    for (const p of importParts) { const nid = newId(); idMap.set(p.id, nid); p.id = nid; }
    for (const c of importConnectors) { const nid = newId(); idMap.set(c.id, nid); c.id = nid; }
    for (const c of importConnectors) {
      if (idMap.has(c.from)) c.from = idMap.get(c.from);
      if (idMap.has(c.to)) c.to = idMap.get(c.to);
    }
    for (const vm of importViewMembers) {
      if (idMap.has(vm.objectId)) vm.objectId = idMap.get(vm.objectId);
    }
  }

  if (useCurrentView) {
    for (const vm of importViewMembers) vm.view = store.currentView;
    importViews = [];
  } else {
    for (const v of importViews) {
      const existing = store.doc.views.find((x) => x.id === v.id);
      if (existing) Object.assign(existing, v);
      else store.doc.views.push(v);
    }
  }

  if (useCurrentModel) {
    for (const p of importParts) p.model = store.defaultModel;
    for (const c of importConnectors) c.model = store.defaultModel;
    importModels = [];
  } else {
    for (const m of importModels) {
      if (!store.doc.models.some((x) => x.modelName === m.modelName)) store.doc.models.push(m);
    }
  }

  let partsAdded = 0, partsUpdated = 0;
  for (const p of importParts) {
    const existing = store.doc.parts.find((x) => x.id === p.id);
    if (existing) { Object.assign(existing, p); partsUpdated += 1; }
    else { store.doc.parts.push(p); partsAdded += 1; }
  }

  let connsAdded = 0, connsUpdated = 0;
  for (const c of importConnectors) {
    const existing = store.doc.connectors.find((x) => x.id === c.id);
    if (existing) { Object.assign(existing, c); connsUpdated += 1; }
    else { store.doc.connectors.push(c); connsAdded += 1; }
  }

  for (const vm of importViewMembers) store.doc.viewMembers.push(vm);

  app.recordAndRender();
  const importDataMsg = `Imported: ${partsAdded} new part${partsAdded === 1 ? '' : 's'} (${partsUpdated} merged), ${connsAdded} new connector${connsAdded === 1 ? '' : 's'} (${connsUpdated} merged), ${importViewMembers.length} node${importViewMembers.length === 1 ? '' : 's'} placed.`;
  app.toast(importDataMsg);
  pushMessageLog(store, `[Import Data] ${importDataMsg}`);
}

// ===================== BOOTSTRAP =====================
async function alertRetryAbort(label, err) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Failed to load ${escapeHtml(label)}</h3><div style="color:var(--text-muted);margin-bottom:10px;">${escapeHtml(err.message || String(err))}</div>
      <div class="modal-actions"><button class="danger abort">Abort</button><button class="primary retry">Retry</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);
    box.querySelector('.retry').addEventListener('click', () => { overlay.remove(); resolve('retry'); });
    box.querySelector('.abort').addEventListener('click', () => { overlay.remove(); resolve('abort'); });
  });
}

function showAbortScreen() {
  document.getElementById('app').innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888;font-family:sans-serif;">Program aborted — required data could not be loaded.</div>`;
}

// Below this width the toolbox + canvas + properties three-panel layout, drag/drop node
// editing, etc. aren't usable — rather than let someone land on a broken-looking app,
// show a plain message (plus the Instructions content, so they still get something
// useful) instead of booting the real app at all. "Continue Anyway" exists so nobody's
// ever hard-locked out — a deliberately narrow browser window, a foldable device, etc.
const SMALL_SCREEN_MAX_WIDTH = 800;

function isSmallScreen() {
  return window.innerWidth < SMALL_SCREEN_MAX_WIDTH;
}

function showSmallScreenScreen(onContinueAnyway) {
  // A sibling overlay, NOT an overwrite of #app's innerHTML — #app is the real app's
  // entire static layout (header, panels, canvas, ...) from index.html; destroying it
  // here would leave nothing for bootstrapApp() to render into if "Continue anyway" is
  // clicked. Hide #app behind this overlay instead, and simply remove the overlay (never
  // touching #app's own content) once the real app is ready to take over.
  document.getElementById('app').style.display = 'none';
  const overlay = document.createElement('div');
  overlay.id = 'small-screen-overlay';
  overlay.style.cssText = 'position:fixed; inset:0; display:flex; flex-direction:column; background:var(--bg); color:var(--text); z-index:1000;';
  overlay.innerHTML = `
    <div style="padding:20px 20px 14px; border-bottom:1px solid var(--border); flex:0 0 auto;">
      <h2 style="margin:0 0 6px 0;">DyCAD needs a larger screen <span style="font-size:12px; font-weight:400; color:var(--text-muted);">v${escapeHtml(APP_VERSION)}</span></h2>
      <p style="margin:0; color:var(--text-muted); font-size:13px; line-height:1.5;">
        This is a canvas-based diagramming tool with several side panels — it isn't usable comfortably at this
        width. Try a laptop or desktop browser, or widen this window. In the meantime, here are the Instructions.
        Larry.danberger@larryhere.com
        <a href="#" id="small-screen-continue" style="margin-left:6px; white-space:nowrap;">Continue anyway →</a>
      </p>
    </div>
    <div id="small-screen-docs" style="flex:1; min-height:0; overflow:auto;"><div class="docs-content"><p>Loading…</p></div></div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#small-screen-continue').addEventListener('click', (e) => {
    e.preventDefault();
    overlay.remove();
    document.getElementById('app').style.display = '';
    onContinueAnyway();
  });
  fetch('public/instructions.html', { cache: 'no-store' })
    .then((res) => res.text())
    .then((html) => {
      const docsEl = overlay.querySelector('#small-screen-docs');
      if (docsEl) docsEl.innerHTML = html; // guard: overlay may already be removed ("Continue anyway") before this resolves
    })
    .catch(() => {
      const docsEl = overlay.querySelector('#small-screen-docs');
      if (docsEl) docsEl.innerHTML = '<div class="docs-content"><p>Could not load the instructions page.</p></div>';
    });
}

async function bootstrap() {
  if (isSmallScreen()) {
    let proceeded = false;
    showSmallScreenScreen(() => {
      if (proceeded) return; // ignore a stray double-click
      proceeded = true;
      bootstrapApp();
    });
    return;
  }
  await bootstrapApp();
}

async function bootstrapApp() {
  document.body.dataset.theme = localStorage.getItem('dycad-theme') || 'light';
  const versionEl = document.getElementById('app-version');
  versionEl.textContent = `v${APP_VERSION}`;
  versionEl.title = 'Designed by:\nLarry Danberger, Calgary, AB, Canada\nLarry.Danberger@larryhere.com\nCoding by Claude';

  let data;
  try {
    data = await loadAllData({ onRetryPrompt: alertRetryAbort });
  } catch (e) {
    showAbortScreen();
    return;
  }

  // nodeSizeMultiplier has to be known BEFORE the Store is constructed (unlike
  // maxScriptEntities below) — it's baked into the initial doc's own home view at
  // construction time, not applied after the fact, so a cached custom value must reach
  // the constructor itself rather than overwriting store.nodeSizeMultiplier afterward.
  const cachedMultiplier = getCachedNodeSizeMultiplier();
  const store = new Store(data.settings, data.industryTree, cachedMultiplier ?? undefined);
  store.mergedRelationshipPairs = data.mergedRelationshipPairs;
  // Local Settings' maxScriptEntities auto-loads from its localStorage cache here — see
  // LOCAL_SETTINGS_CACHE_KEY's comment for why this is safe to cache (unlike Local
  // Secrets, which never is). Leaves the Store's own 5000 default in place if nothing's
  // been cached yet (fresh browser, or the cache was cleared).
  const cachedCap = getCachedMaxScriptEntities();
  if (cachedCap !== null) store.maxScriptEntities = cachedCap;
  const cachedBatchScript = getCachedBatchScriptCode();
  if (cachedBatchScript !== null) store.batchScriptCode = cachedBatchScript;
  const cachedPresets = getCachedSmartStreamPresets();
  if (cachedPresets !== null) store.smartStreamPresets = cachedPresets;
  const cachedRemapPresets = getCachedRemapPresets();
  if (cachedRemapPresets !== null) store.remapPresets = cachedRemapPresets;

  document.body.appendChild(buildMarkerDefs(store));

  const app = new App(store);
  window.dycadApp = app; // debugging aid

  const homeView = store.doc.views[0];
  const homeTab = app.createCanvasTab(homeView);
  store.activeTabId = homeTab.id;
  // Instructions tab opens on startup, active by default, home tab stays open behind it
  // — UNLESS the user has closed it before (see getCachedInstructionsClosed/closeTab),
  // in which case respect that and leave it closed rather than reopening it every session.
  if (!getCachedInstructionsClosed()) app.openOrSwitchDocs();

  wireGlobalEvents(app);
  wireGlobalCanvasHandlers(app);
  app.render();
}

function wireGlobalEvents(app) {
  const { store } = app;

  // ===== Warn before closing/navigating away with unsaved changes — this app has no
  // auto-save, so losing store.dirty work silently on an accidental tab close was a real
  // gap. Browsers ignore any custom message text and show their own generic prompt; the
  // (e.returnValue = '') assignment is the old-but-still-required way to trigger it. =====
  window.addEventListener('beforeunload', (e) => {
    if (!store.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ===== Message Log header: double-click opens the full log in the generic read-only
  // text-edit modal (Step 33) =====
  document.getElementById('message-log-header').addEventListener('dblclick', () => {
    const el = document.getElementById('message-log');
    app.promptTextEdit({ title: 'Message Log', value: el.value, readonly: true, onSave: () => {} });
  });
  document.getElementById('message-log-copy-btn').addEventListener('click', async () => {
    const el = document.getElementById('message-log');
    if (!el.value) { app.toast('Message Log is empty.', true); return; }
    try {
      await navigator.clipboard.writeText(el.value);
      app.toast('Message Log copied to clipboard.');
    } catch {
      app.toast('Copy failed — clipboard access was blocked.', true);
    }
  });
  document.getElementById('message-log-clear-btn').addEventListener('click', () => {
    if (store.messageLog.length === 0) { app.toast('Message Log is already empty.'); return; }
    store.messageLog = [];
    app.render();
    app.toast('Message Log cleared.');
  });
  document.getElementById('help-btn').addEventListener('click', () => app.openOrSwitchDocs());

  // ===== resizable left/right panels =====
  const leftPanel = document.getElementById('left-panel');
  const rightPanel = document.getElementById('right-panel');
  const savedLeft = Number(localStorage.getItem('dycad-left-width'));
  const savedRight = Number(localStorage.getItem('dycad-right-width'));
  if (savedLeft) leftPanel.style.width = `${savedLeft}px`;
  if (savedRight) rightPanel.style.width = `${savedRight}px`;

  function wireResizer(handle, panel, side, storageKey) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      const startX = e.clientX;
      const startWidth = panel.getBoundingClientRect().width;
      const onMove = (ev) => {
        const delta = side === 'left' ? (ev.clientX - startX) : (startX - ev.clientX);
        const newWidth = Math.min(480, Math.max(180, startWidth + delta));
        panel.style.width = `${newWidth}px`;
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        handle.classList.remove('dragging');
        localStorage.setItem(storageKey, String(panel.getBoundingClientRect().width));
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }
  wireResizer(document.getElementById('left-resizer'), leftPanel, 'left', 'dycad-left-width');
  wireResizer(document.getElementById('right-resizer'), rightPanel, 'right', 'dycad-right-width');

  // ===== collapsible panels (toolkit/selection/commands/properties) — default expanded =====
  document.querySelectorAll('.panel-section.collapsible').forEach((section) => {
    const panelId = section.dataset.panelId;
    const collapsed = localStorage.getItem(`dycad-panel-${panelId}-collapsed`) === 'true';
    section.classList.toggle('collapsed', collapsed);
    section.querySelector('.panel-toggle').addEventListener('click', () => {
      const nowCollapsed = section.classList.toggle('collapsed');
      localStorage.setItem(`dycad-panel-${panelId}-collapsed`, String(nowCollapsed));
    });
  });


  document.getElementById('restore-closed-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('restore-closed-menu');
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('restore-closed-menu');
    if (!menu.contains(e.target) && e.target.id !== 'restore-closed-btn') menu.classList.add('hidden');
  });

  // ===== Shared simulation action dispatcher — used by both the Simulation menu items
  // and the centered toolbar Step/Run/Stop/Reset buttons, so the two triggers can never
  // drift out of sync with each other. All act on store.simSelectedModel — the dedicated
  // Simulation model selector, entirely independent of store.defaultModel (used only
  // when creating new nodes) — never on the active tab/view.
  function runSimAction(action) {
    const modelName = app.store.simSelectedModel;
    if (!modelName) { app.toast('No model selected.', true); return; }
    if (action === 'stepSimulation') {
      stepSimulation(app, modelName);
    } else if (action === 'runSimulation') {
      app.promptModal({
        title: `Run Simulation — ${modelName}`,
        fields: [{ key: 'interval', label: 'Interval (ms)', value: '500' }],
        onSubmit: (vals) => { startContinuousRun(app, modelName, Number(vals.interval) || 500); refreshSimRunIndicator(); },
      });
    } else if (action === 'pauseSimulation') {
      const entry = app.store.simRunning.get(modelName);
      if (!entry) { app.toast('No simulation is running for this model.'); return; }
      if (entry.paused) { app.toast('Already paused.'); return; }
      pauseContinuousRun(app, modelName);
      refreshSimRunIndicator();
    } else if (action === 'continueSimulation') {
      const entry = app.store.simRunning.get(modelName);
      if (!entry || !entry.paused) { app.toast('Nothing paused to continue for this model.'); return; }
      continueContinuousRun(app, modelName);
      refreshSimRunIndicator();
    } else if (action === 'stopSimulation') {
      if (!app.store.simRunning.has(modelName)) { app.toast('No simulation is running for this model.'); return; }
      stopContinuousRun(app, modelName);
      refreshSimRunIndicator();
    } else if (action === 'resetSimulation') {
      resetSimulation(app, modelName);
    } else if (action === 'showSimLog') {
      app.openOrSwitchSimLog(modelName);
    } else if (action === 'saveSimSnapshot') {
      saveSimSnapshot(app, modelName);
    } else if (action === 'loadSimSnapshot') {
      document.getElementById('load-sim-snapshot-input').click();
    }
  }
  document.getElementById('load-sim-snapshot-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const modelName = app.store.simSelectedModel;
    if (file && modelName) await loadSimSnapshot(app, modelName, file);
    e.target.value = '';
  });

  // ===== Centered toolbar Run/Pause-Continue/Step/Stop/Reset buttons + dedicated
  // simulation model selector (separate from the toolbar's "Default Model" selector) =====
  document.getElementById('sim-run-btn').addEventListener('click', () => runSimAction('runSimulation'));
  // Step 38: single toggle button — its own label/action flips between Pause and
  // Continue based on the selected model's current paused state, so the user doesn't
  // need two separate buttons to pause an existing run, step around, then resume it
  // without restarting.
  document.getElementById('sim-pause-btn').addEventListener('click', () => {
    const modelName = app.store.simSelectedModel;
    const entry = modelName && app.store.simRunning.get(modelName);
    runSimAction(entry && entry.paused ? 'continueSimulation' : 'pauseSimulation');
  });
  document.getElementById('sim-step-btn').addEventListener('click', () => runSimAction('stepSimulation'));
  document.getElementById('sim-stop-btn').addEventListener('click', () => runSimAction('stopSimulation'));
  document.getElementById('sim-reset-btn').addEventListener('click', () => runSimAction('resetSimulation'));

  const simModelSelect = document.getElementById('sim-model-select');
  function populateSimModelSelect() {
    const models = app.store.doc.models.map((m) => m.modelName);
    if (!models.includes(app.store.simSelectedModel)) app.store.simSelectedModel = models[0] || '';
    simModelSelect.innerHTML = models.map((m) => `<option value="${m}" ${m === app.store.simSelectedModel ? 'selected' : ''}>${m}</option>`).join('');
  }
  /** Visual "is the selected model running" indicator on the Run button, and the
   * Pause/Continue button's label+state — re-checked on selector change and on every
   * normal render (see App.render() hook below), so Stop/Pause/Continue (or a run ending
   * some other way) update it without touching the selector. */
  function refreshSimRunIndicator() {
    const modelName = app.store.simSelectedModel;
    const entry = modelName ? app.store.simRunning.get(modelName) : null;
    document.getElementById('sim-run-btn').classList.toggle('active', !!entry);
    const pauseBtn = document.getElementById('sim-pause-btn');
    const isPaused = !!(entry && entry.paused);
    pauseBtn.textContent = isPaused ? 'Continue' : 'Pause';
    pauseBtn.title = isPaused ? 'Continue Simulation' : 'Pause Simulation';
    pauseBtn.classList.toggle('active', isPaused);
    pauseBtn.disabled = !entry;
  }
  populateSimModelSelect();
  refreshSimRunIndicator();
  simModelSelect.addEventListener('change', () => {
    app.store.simSelectedModel = simModelSelect.value;
    refreshSimRunIndicator();
  });
  app.refreshSimToolbar = () => { populateSimModelSelect(); refreshSimRunIndicator(); };

  // ===== File menu =====
  const fileMenu = document.getElementById('file-menu');
  fileMenu.innerHTML = `
    <div class="dd-item" data-action="save">Save</div>
    <div class="dd-item" data-action="load">Load</div>
    <div class="dd-item" data-action="loadRecent">Recently Opened</div>
    <div class="dd-item" data-action="print">Print...</div>
    <div class="dd-item" data-action="exportImage">Export View as Image...</div>
    <div class="dd-separator"></div>
    <div class="dd-item" data-action="loadExample">Load Example</div>
    <div class="dd-item" data-action="loadSFCCE">Load SFCCE</div>
    <div class="dd-item" data-action="loadLocalSecrets">Load Local Secrets</div>
    <div class="dd-item" data-action="saveLocalSecrets">Save Local Secrets</div>
    <div class="dd-item" data-action="loadLocalSettings">Load Local Settings</div>
    <div class="dd-item" data-action="saveLocalSettings">Save Local Settings</div>
    <div class="dd-separator"></div>
    <div class="dd-item" data-action="importData">Import Data</div>
    <div class="dd-item" data-action="importArchimate">Import ArchiMate</div>
  `;
  fileMenu.querySelectorAll('.dd-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.action === 'save') app.saveJson();
      else if (item.dataset.action === 'load') app.promptFileMenuLoad();
      else if (item.dataset.action === 'loadRecent') app.promptLoadRecent();
      else if (item.dataset.action === 'print') app.promptPrint();
      else if (item.dataset.action === 'exportImage') app.promptExportViewAsImage();
      else if (item.dataset.action === 'loadExample') app.promptLoadExample();
      else if (item.dataset.action === 'loadSFCCE') app.promptLoadSFCCE();
      else if (item.dataset.action === 'loadLocalSecrets') document.getElementById('load-local-secrets-input').click();
      else if (item.dataset.action === 'saveLocalSecrets') app.saveLocalSecrets();
      else if (item.dataset.action === 'loadLocalSettings') document.getElementById('load-local-settings-input').click();
      else if (item.dataset.action === 'saveLocalSettings') app.saveLocalSettings();
      else if (item.dataset.action === 'importData') app.promptImportData();
      else if (item.dataset.action === 'importArchimate') document.getElementById('import-archimate-input').click();
      fileMenu.classList.add('hidden');
    });
  });
  // File > Load Local Secrets: secrets ONLY, memory-only, never cached to localStorage —
  // deliberately re-required every session (see state.js's localSecrets comment for why).
  // Accepts either a plain {key: value} file (what Save Local Secrets writes, and what
  // Load Local Settings originally accepted before the two were split apart) or an old
  // pre-split bundled { secrets, pinnedFields, maxScriptEntities } file, pulling out just
  // .secrets and ignoring the rest — so a file saved before this split still loads here.
  document.getElementById('load-local-secrets-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Expected a JSON object.');
      const secrets = ('secrets' in obj || 'pinnedFields' in obj || 'maxScriptEntities' in obj)
        ? ((obj.secrets && typeof obj.secrets === 'object' && !Array.isArray(obj.secrets)) ? obj.secrets : {})
        : obj;
      app.store.localSecrets = secrets;
      app.toast(`Local secrets loaded (${Object.keys(secrets).length} key${Object.keys(secrets).length === 1 ? '' : 's'}).`);
    } catch (err) {
      app.toast(`Local secrets load failed: ${err.message}`, true);
    }
  });
  // File > Load Local Settings: user PREFERENCES only (pinnedFields, maxScriptEntities,
  // nodeSizeMultiplier, batchScriptCode, smartStreamPresets, remapPresets) — separate
  // from secrets above. Caches maxScriptEntities/nodeSizeMultiplier/batchScriptCode/
  // smartStreamPresets/remapPresets to localStorage (see setCachedMaxScriptEntities/
  // setCachedNodeSizeMultiplier/setCachedBatchScriptCode/setCachedSmartStreamPresets/
  // setCachedRemapPresets) so they survive a page refresh without re-loading this file;
  // pinnedFields already caches itself the moment setAllPinnedFields runs. Same
  // dual-shape acceptance as Load Local Secrets, for the same pre-split-file reason.
  document.getElementById('load-local-settings-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Expected a JSON object.');
      if (obj.pinnedFields) setAllPinnedFields(obj.pinnedFields);
      const capNum = Number(obj.maxScriptEntities);
      const hasCap = Number.isFinite(capNum) && capNum > 0;
      if (hasCap) {
        app.store.maxScriptEntities = Math.floor(capNum);
        setCachedMaxScriptEntities(app.store.maxScriptEntities);
      }
      const multNum = Number(obj.nodeSizeMultiplier);
      // 0.5-3 matches getCachedNodeSizeMultiplier's own clamp — same sane range either way.
      const hasMult = Number.isFinite(multNum) && multNum >= 0.5 && multNum <= 3;
      if (hasMult) {
        app.store.nodeSizeMultiplier = multNum;
        setCachedNodeSizeMultiplier(multNum);
      }
      const hasBatchScript = typeof obj.batchScriptCode === 'string' && obj.batchScriptCode.length > 0;
      if (hasBatchScript) {
        app.store.batchScriptCode = obj.batchScriptCode;
        setCachedBatchScriptCode(obj.batchScriptCode);
      }
      const hasPresets = Array.isArray(obj.smartStreamPresets);
      if (hasPresets) {
        app.store.smartStreamPresets = obj.smartStreamPresets;
        setCachedSmartStreamPresets(obj.smartStreamPresets);
      }
      const hasRemapPresets = Array.isArray(obj.remapPresets);
      if (hasRemapPresets) {
        app.store.remapPresets = obj.remapPresets;
        setCachedRemapPresets(obj.remapPresets);
      }
      app.render(); // picks up the new pin config immediately if a property panel is open
      const parts = [];
      if (obj.pinnedFields) parts.push('pinned fields');
      if (hasCap) parts.push(`max script entities: ${app.store.maxScriptEntities}`);
      if (hasMult) parts.push(`node size multiplier: ${app.store.nodeSizeMultiplier}`);
      if (hasBatchScript) parts.push('script console text');
      if (hasPresets) parts.push('smart stream presets');
      if (hasRemapPresets) parts.push('remap presets');
      app.toast(parts.length ? `Local settings loaded (${parts.join(', ')}).` : 'Local settings file had nothing recognized to load.');
    } catch (err) {
      app.toast(`Local settings load failed: ${err.message}`, true);
    }
  });
  document.getElementById('import-archimate-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const knownTypes = new Set((app.store.settings.elements || []).map((el) => el.type));
      const elementGroupFills = new Map((app.store.settings.elementGroups || []).map((g) => [g.group, g.fill]));
      const { modelName, parts, connectors, views, viewMembers, unrecognizedTypes } = parseArchimateXml(text, knownTypes, app.store.settings.elements, elementGroupFills);
      const { store } = app;

      if (!store.doc.models.some((m) => m.modelName === modelName)) store.doc.models.push({ modelName });

      let partsAdded = 0, partsUpdated = 0;
      for (const p of parts) {
        const existing = store.doc.parts.find((x) => x.id === p.id);
        if (existing) { Object.assign(existing, p); partsUpdated += 1; }
        else { store.doc.parts.push(p); partsAdded += 1; }
      }
      let connsAdded = 0, connsUpdated = 0;
      for (const c of connectors) {
        const existing = store.doc.connectors.find((x) => x.id === c.id);
        if (existing) { Object.assign(existing, c); connsUpdated += 1; }
        else { store.doc.connectors.push(c); connsAdded += 1; }
      }
      let viewsAdded = 0, viewsUpdated = 0;
      for (const v of views) {
        const existing = store.doc.views.find((x) => x.id === v.id);
        if (existing) { Object.assign(existing, v); viewsUpdated += 1; }
        else { store.doc.views.push(v); viewsAdded += 1; }
      }
      // viewMembers: same merge-by-id idempotency as everything else here (re-importing
      // the same file re-places nodes at the same position rather than duplicating them,
      // consistent with parts/connectors/views all merging by id too).
      let vmsAdded = 0, vmsUpdated = 0;
      for (const vm of viewMembers) {
        const existing = store.doc.viewMembers.find((x) => x.id === vm.id);
        if (existing) { Object.assign(existing, vm); vmsUpdated += 1; }
        else { store.doc.viewMembers.push(vm); vmsAdded += 1; }
      }

      app.recordAndRender();
      const unrecognizedMsg = unrecognizedTypes.size
        ? ` ${unrecognizedTypes.size} type${unrecognizedTypes.size === 1 ? '' : 's'} had no matching definition (shown in grey): ${[...unrecognizedTypes].slice(0, 5).join(', ')}${unrecognizedTypes.size > 5 ? ', ...' : ''}.`
        : '';
      const archimateMsg = `Imported ArchiMate model "${modelName}": ${partsAdded} new part${partsAdded === 1 ? '' : 's'} (${partsUpdated} updated), ${connsAdded} new connector${connsAdded === 1 ? '' : 's'} (${connsUpdated} updated), ${viewsAdded} new view${viewsAdded === 1 ? '' : 's'} (${viewsUpdated} updated) with ${vmsAdded} node${vmsAdded === 1 ? '' : 's'} placed (${vmsUpdated} updated). Junctions were replaced with direct connections + notes.${unrecognizedMsg}`;
      app.toast(archimateMsg);
      pushMessageLog(store, `[ArchiMate Import] ${archimateMsg}`);
    } catch (err) {
      app.toast(`ArchiMate import failed: ${err.message}`, true);
    }
  });
  document.getElementById('import-ddl-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      importDDL(app, text); // creates parts/connectors + a new view, toasts its own summary, throws with a specific message on unparseable DDL
    } catch (err) {
      app.toast(`DDL import failed: ${err.message}`, true);
    }
  });

  // ===== Advanced menu (external reference links, open in a new tab) =====
  const ADVANCED_LINKS = [
    { label: 'Open TOGAF Meta Model', url: 'https://larry42.com/img/togafmetamodel.png' },
    { label: 'ArchiMate 3.2 Specification', url: 'https://pubs.opengroup.org/architecture/archimate32-doc/' },
    { label: 'Open Nubium Enterprise Functions Model', url: 'https://www.nubium.com/blog/datamanagementfaces/' },
    { label: 'Open Nubium Data Value Chain Model', url: 'https://www.nubium.com/blog/datavaluechain/' },
    { label: 'Open Microsoft CDM', url: 'https://github.com/microsoft/CDM?tab=readme-ov-file' },
    { separator: true },
    { label: 'Generate Inventory View', action: 'generateInventoryView' },
    { label: 'Generate Industry', action: 'generateIndustry' },
    { label: 'Smart Check View', action: 'smartCheckView' },
    { label: 'Smart Check Node', action: 'smartCheckNode' },
    { separator: true },
    { label: 'Script Console...', action: 'scriptConsole' },
    { label: 'Code Summary', action: 'codeSummary' },
  ];
  const advancedMenu = document.getElementById('advanced-menu');
  advancedMenu.innerHTML = ADVANCED_LINKS.map((l) => l.separator ? '<div class="dd-separator"></div>' : `<div class="dd-item" data-url="${l.url || ''}" data-action="${l.action || ''}">${l.label}</div>`).join('');
  advancedMenu.querySelectorAll('.dd-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.action === 'generateInventoryView') {
        generateInventoryView(app);
      } else if (item.dataset.action === 'generateIndustry') {
        app.promptGenerateIndustry();
      } else if (item.dataset.action === 'smartCheckView') {
        app.promptSmartCheckView();
      } else if (item.dataset.action === 'smartCheckNode') {
        app.promptSmartCheckNode(app.store.activeTab());
      } else if (item.dataset.action === 'scriptConsole') {
        app.promptScriptConsole();
      } else if (item.dataset.action === 'codeSummary') {
        app.promptCodeSummary();
      } else if (item.dataset.url) {
        window.open(item.dataset.url, '_blank', 'noopener');
      }
      advancedMenu.classList.add('hidden');
    });
  });

  // ===== Simulation menu (same actions as the toolbar Step/Run/Stop/Reset buttons,
  // plus the log/snapshot commands that don't warrant their own toolbar button) —
  // Script Console and Code Summary moved to the Advanced menu, since neither one is
  // actually a simulation action (Script Console works with no model selected at all,
  // and Code Summary reviews every model's scripts, not the selected one). =====
  const SIMULATION_LINKS = [
    { label: 'Run Simulation', action: 'runSimulation' },
    { label: 'Pause Simulation', action: 'pauseSimulation' },
    { label: 'Continue Simulation', action: 'continueSimulation' },
    { label: 'Step Simulation', action: 'stepSimulation' },
    { label: 'Stop Simulation', action: 'stopSimulation' },
    { label: 'Reset Simulation', action: 'resetSimulation' },
    { label: 'Show Simulation Log', action: 'showSimLog' },
    { label: 'Save Simulation Snapshot', action: 'saveSimSnapshot' },
    { label: 'Load Simulation Snapshot', action: 'loadSimSnapshot' },
  ];
  const simulationMenu = document.getElementById('simulation-menu');
  simulationMenu.innerHTML = SIMULATION_LINKS.map((l) => `<div class="dd-item" data-action="${l.action}">${l.label}</div>`).join('');
  simulationMenu.querySelectorAll('.dd-item').forEach((item) => {
    item.addEventListener('click', () => {
      runSimAction(item.dataset.action);
      simulationMenu.classList.add('hidden');
    });
  });

  // ===== Catalogs menu (Parts / Connectors / Views / ViewMembers — one live tab each) =====
  const CATALOGS = [
    { label: 'Parts', type: 'parts' },
    { label: 'Connectors', type: 'connectors' },
    { label: 'Views', type: 'views' },
    { label: 'ViewMembers', type: 'viewMembers' },
  ];
  const catalogsMenu = document.getElementById('catalogs-menu');
  catalogsMenu.innerHTML = CATALOGS.map((c) => `<div class="dd-item" data-type="${c.type}" data-label="${c.label}">${c.label}</div>`).join('')
    + '<div class="dd-separator"></div><div class="dd-item" data-action="sfce">SFCCE</div>';
  catalogsMenu.querySelectorAll('.dd-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.action === 'sfce') { app.promptSfceCatalog(); catalogsMenu.classList.add('hidden'); return; }
      app.openOrSwitchCatalog(item.dataset.type, `${item.dataset.label} Catalog`);
      catalogsMenu.classList.add('hidden');
    });
  });

  // ===== Explore menu (alternate, whole-model visualizations — currently just the 3D
  // View; distinct from Catalogs' per-entity tables and Advanced's one-shot commands) =====
  const EXPLORE_LINKS = [
    { label: '3D View', action: 'view3d' },
    { separator: true },
    { label: 'Reset Pinned 3D Positions', action: 'resetPinned3DPositions' },
  ];
  const exploreMenu = document.getElementById('explore-menu');
  exploreMenu.innerHTML = EXPLORE_LINKS.map((l) => l.separator ? '<div class="dd-separator"></div>' : `<div class="dd-item" data-action="${l.action}">${l.label}</div>`).join('');
  exploreMenu.querySelectorAll('.dd-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.action === 'view3d') app.openOrSwitch3DView();
      else if (item.dataset.action === 'resetPinned3DPositions') app.promptResetPinned3DPositions();
      exploreMenu.classList.add('hidden');
    });
  });

  // ===== Data Modeling menu (crow's-foot ERD: entity attributes, PK/FK, DDL
  // import/export) — "Add/Edit Entity Details" is the menu-triggered equivalent of
  // double-clicking a DataDataEntity node (see promptAddEditEntityDetails); "Autofill"
  // runs the user-editable dataAutoFill() batch script (see promptAutofill below and
  // DEFAULT_BATCH_SCRIPT_CODE, state.js); Import/Export DDL, and Auto-Detect Connectors
  // (see promptAutoDetectConnectors above) are the commands that need a real
  // dialog/file-picker, so they dispatch through app methods below rather than being
  // handled inline here, matching how Advanced's own generateIndustry/scriptConsole
  // items work. =====
  const DATA_MODELING_LINKS = [
    { label: 'Add/Edit Entity Details', action: 'addEditEntityDetails' },
    { separator: true },
    { label: 'Autofill', action: 'autofill' },
    { separator: true },
    { label: 'Import DDL...', action: 'importDDL' },
    { label: 'Export DDL', action: 'exportDDL' },
    { separator: true },
    { label: 'Auto-Detect Connectors...', action: 'autoDetectConnectors' },
  ];
  const dataModelingMenu = document.getElementById('data-modeling-menu');
  dataModelingMenu.innerHTML = DATA_MODELING_LINKS.map((l) => l.separator ? '<div class="dd-separator"></div>' : `<div class="dd-item" data-action="${l.action}">${l.label}</div>`).join('');
  dataModelingMenu.querySelectorAll('.dd-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.action === 'addEditEntityDetails') app.promptAddEditEntityDetails();
      else if (item.dataset.action === 'autofill') app.promptAutofill();
      else if (item.dataset.action === 'importDDL') document.getElementById('import-ddl-input').click();
      else if (item.dataset.action === 'exportDDL') app.promptExportDDL();
      else if (item.dataset.action === 'autoDetectConnectors') app.promptAutoDetectConnectors();
      dataModelingMenu.classList.add('hidden');
    });
  });

  // ===== Shared open/close wiring for all top-row dropdown menus =====
  const MENU_PAIRS = [
    ['file-menu-btn', fileMenu],
    ['catalogs-menu-btn', catalogsMenu],
    ['advanced-menu-btn', advancedMenu],
    ['simulation-menu-btn', simulationMenu],
    ['explore-menu-btn', exploreMenu],
    ['data-modeling-menu-btn', dataModelingMenu],
  ];
  MENU_PAIRS.forEach(([btnId, menu]) => {
    document.getElementById(btnId).addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = menu.classList.contains('hidden');
      MENU_PAIRS.forEach(([, m]) => m.classList.add('hidden'));
      if (willOpen) menu.classList.remove('hidden');
    });
  });
  document.addEventListener('click', (e) => {
    MENU_PAIRS.forEach(([btnId, menu]) => {
      if (!menu.contains(e.target) && e.target.id !== btnId) menu.classList.add('hidden');
    });
  });

  document.getElementById('model-select').addEventListener('change', (e) => { store.defaultModel = e.target.value; app.render(); });
  document.getElementById('model-add-btn').addEventListener('click', () => {
    app.promptModal({ title: 'Add Model', fields: [{ key: 'name', label: 'Model name', value: '' }], onSubmit: (v) => { if (v.name) { store.addModel(v.name); store.defaultModel = v.name; app.render(); } } });
  });
  document.getElementById('model-remove-btn').addEventListener('click', async () => {
    if (await app.confirmModal(`Remove model "${store.defaultModel}"? Parts/connectors referencing it are kept but the model entry is removed.`)) {
      store.removeModel(store.defaultModel);
      app.render();
    }
  });

  document.getElementById('view-select').addEventListener('change', (e) => app.openOrSwitchView(e.target.value));
  document.getElementById('view-add-btn').addEventListener('click', () => {
    const viewTypes = store.settings.viewTypes || [];
    app.promptModal({
      title: 'Add View',
      fields: [
        { key: 'name', label: 'View name', value: '' },
        { key: 'viewType', label: 'View type', type: 'select', options: viewTypes.map((vt) => vt.name), value: viewTypes.find((vt) => vt.key === 'ff')?.name || viewTypes[0]?.name },
      ],
      onSubmit: (v) => {
        if (!v.name) return;
        const vt = viewTypes.find((x) => x.name === v.viewType);
        app.openOrSwitchView(v.name, { viewType: vt?.key || 'ff' });
      },
    });
  });
  document.getElementById('view-remove-btn').addEventListener('click', async () => {
    if (store.doc.views.length <= 1) { app.toast('At least one view must remain.', true); return; }
    if (await app.confirmModal(`Remove view "${store.currentView}" and all its content?`)) {
      const removedId = store.currentView;
      const existingTab = store.findTabByView(removedId);
      if (existingTab) app.closeTab(existingTab.id);
      store.removeView(removedId);
      store.currentView = store.doc.views[0].id;
      const tab = app.openOrSwitchView(store.currentView);
      app.render();
    }
  });

  // View Scope (3D-only) — narrows the 3D scene to exactly one 2D view's own placed
  // content. A plain <select>, like Layer Order, since it's a single choice not a
  // multi-checkbox filter.
  document.getElementById('view3d-scope-select').addEventListener('change', (e) => {
    const tab = store.activeTab();
    if (!tab || tab.type !== '3d') return;
    tab.view3DScopeViewId = e.target.value || null;
    app.render();
  });

  document.getElementById('stream-filter-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('stream-filter-menu');
    const tab = store.activeTab();
    if (!tab || (tab.type !== 'canvas' && tab.type !== '3d')) return;
    const is3D = tab.type === '3d';
    const availableStreams = new Set();
    if (is3D) {
      // The 3D view represents the whole model's parts/connectors directly, not any one
      // view's viewMembers — so its filter options come from the raw data, not a view.
      for (const p of store.doc.parts) for (const s of p.streams || []) availableStreams.add(s);
      for (const c of store.doc.connectors) for (const s of c.streams || []) availableStreams.add(s);
    } else {
      for (const vm of store.viewMembersForView(tab.viewId)) {
        const obj = vm.objectType === 'part' ? store.findPart(vm.objectId) : store.findConnector(vm.objectId);
        for (const s of obj?.streams || []) availableStreams.add(s);
      }
    }
    const sorted = [...availableStreams].sort();

    // Same null/empty-array convention the element-type filter below already uses: null
    // = unfiltered (every item displays checked), an explicit array (including an empty
    // one, from "Exclude All") reflects exactly what's in it.
    const isFilterActive = tab.activeStreams != null;
    const checkedStreams = isFilterActive ? new Set(tab.activeStreams) : new Set(sorted);
    const allChecked = sorted.length > 0 && sorted.every((s) => checkedStreams.has(s));

    if (sorted.length === 0) {
      menu.innerHTML = `<div class="dd-empty">No streams in ${is3D ? 'the model' : 'this view'}</div>`;
    } else {
      menu.innerHTML = `
        <div class="dd-item dd-select-all">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" id="stream-select-all" ${allChecked ? 'checked' : ''} />Select All / Exclude All
          </label>
        </div>
        <div class="dd-item-list">
          ${sorted.map((s) => `<div class="dd-item"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" value="${escapeHtml(s)}" ${checkedStreams.has(s) ? 'checked' : ''} />${escapeHtml(s)}</label></div>`).join('')}
        </div>`;
    }

    const applyStreams = () => {
      // The auto-select-matching-nodes side effect only makes sense for a canvas tab's
      // own viewMember-backed selection — the 3D tab has no such selection concept yet.
      if (!is3D && tab.activeStreams && tab.activeStreams.length > 0) {
        tab.selection.clear();
        for (const vm of store.viewMembersForView(tab.viewId)) {
          const obj = vm.objectType === 'part' ? store.findPart(vm.objectId) : store.findConnector(vm.objectId);
          if (obj && (obj.streams || []).some((s) => tab.activeStreams.includes(s))) tab.selection.add(vm.id);
        }
      }
      app.render();
    };
    const itemCheckboxes = () => [...menu.querySelectorAll('.dd-item-list input[type="checkbox"]')];
    const selectAllCb = document.getElementById('stream-select-all');
    if (selectAllCb) {
      selectAllCb.addEventListener('change', () => {
        tab.activeStreams = selectAllCb.checked ? null : []; // null = unfiltered; [] = explicit "exclude all"
        itemCheckboxes().forEach((cb) => { cb.checked = selectAllCb.checked; });
        applyStreams();
      });
    }
    itemCheckboxes().forEach((cb) => {
      cb.addEventListener('change', () => {
        tab.activeStreams = itemCheckboxes().filter((c) => c.checked).map((c) => c.value);
        if (selectAllCb) selectAllCb.checked = itemCheckboxes().every((c) => c.checked);
        applyStreams();
      });
    });
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('stream-filter-menu');
    if (!menu.contains(e.target) && e.target.id !== 'stream-filter-btn') menu.classList.add('hidden');
  });

  // Element type multi-select filter (distinct from the stream filter above) — pure
  // visibility filtering, no auto-select side effect (unlike Stream's), since that
  // wasn't part of what was asked for here.
  document.getElementById('element-type-filter-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('element-type-filter-menu');
    const tab = store.activeTab();
    if (!tab || (tab.type !== 'canvas' && tab.type !== '3d')) return;
    const is3D = tab.type === '3d';

    const availableTypes = new Set();
    if (is3D) {
      // Same reasoning as the stream filter above — the whole model's parts, not one view's.
      for (const p of store.doc.parts) availableTypes.add(p.type);
    } else {
      for (const vm of store.viewMembersForView(tab.viewId)) {
        if (vm.objectType !== 'part') continue;
        const part = store.findPart(vm.objectId);
        if (part) availableTypes.add(part.type);
      }
    }
    // display title (falling back to the raw type if undefined), sorted by that title
    const items = [...availableTypes].map((type) => {
      const elDef = (store.settings.elements || []).find((el) => el.type === type);
      return { type, title: elDef ? elDef.title : type };
    }).sort((a, b) => a.title.localeCompare(b.title));

    // null = unfiltered (show everything) -> every item displays as checked; an
    // explicit array (including an empty one, from "exclude all") reflects exactly
    // what's in it.
    const isFilterActive = tab.activeElementTypes != null;
    const checkedTypes = isFilterActive ? new Set(tab.activeElementTypes) : new Set(items.map((i) => i.type));
    const allChecked = items.length > 0 && items.every((i) => checkedTypes.has(i.type));

    if (items.length === 0) {
      menu.innerHTML = `<div class="dd-empty">No elements in ${is3D ? 'the model' : 'this view'}</div>`;
    } else {
      menu.innerHTML = `
        <div class="dd-item dd-select-all">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" id="element-type-select-all" ${allChecked ? 'checked' : ''} />Select All / Exclude All
          </label>
        </div>
        <div class="dd-item-list">
          ${items.map((i) => `<div class="dd-item"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" value="${escapeHtml(i.type)}" ${checkedTypes.has(i.type) ? 'checked' : ''} />${escapeHtml(i.title)}</label></div>`).join('')}
        </div>`;
    }

    const itemCheckboxes = () => [...menu.querySelectorAll('.dd-item-list input[type="checkbox"]')];
    const selectAllCb = document.getElementById('element-type-select-all');
    if (selectAllCb) {
      selectAllCb.addEventListener('change', () => {
        if (selectAllCb.checked) {
          tab.activeElementTypes = null; // unfiltered — cleanest representation of "show everything"
        } else {
          tab.activeElementTypes = []; // explicit "exclude all" — show nothing
        }
        itemCheckboxes().forEach((cb) => { cb.checked = selectAllCb.checked; });
        app.render();
      });
    }
    itemCheckboxes().forEach((cb) => {
      cb.addEventListener('change', () => {
        tab.activeElementTypes = itemCheckboxes().filter((c) => c.checked).map((c) => c.value);
        if (selectAllCb) selectAllCb.checked = itemCheckboxes().every((c) => c.checked);
        app.render();
      });
    });
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('element-type-filter-menu');
    if (!menu.contains(e.target) && e.target.id !== 'element-type-filter-btn') menu.classList.add('hidden');
  });

  // Section multi-select filter (Part.section, a plain string field — distinct from
  // selectedSectionId, the 2D Section-view header-click selection) — same structure as
  // the Type filter above: pure visibility filtering, no auto-select side effect. A part
  // with no section is offered as its own '(no section)' option (empty-string value)
  // rather than being silently unreachable once a section filter is active.
  document.getElementById('section-filter-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('section-filter-menu');
    const tab = store.activeTab();
    if (!tab || (tab.type !== 'canvas' && tab.type !== '3d')) return;
    const is3D = tab.type === '3d';

    const availableSections = new Set();
    if (is3D) {
      for (const p of store.doc.parts) availableSections.add(p.section || '');
    } else {
      for (const vm of store.viewMembersForView(tab.viewId)) {
        if (vm.objectType !== 'part') continue;
        const part = store.findPart(vm.objectId);
        if (part) availableSections.add(part.section || '');
      }
    }
    // real section names sorted alphabetically first, '(no section)' always last
    const sorted = [...availableSections].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));

    const isFilterActive = tab.activeSections != null;
    const checkedSections = isFilterActive ? new Set(tab.activeSections) : new Set(sorted);
    const allChecked = sorted.length > 0 && sorted.every((s) => checkedSections.has(s));

    if (sorted.length === 0) {
      menu.innerHTML = `<div class="dd-empty">No sections in ${is3D ? 'the model' : 'this view'}</div>`;
    } else {
      menu.innerHTML = `
        <div class="dd-item dd-select-all">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" id="section-select-all" ${allChecked ? 'checked' : ''} />Select All / Exclude All
          </label>
        </div>
        <div class="dd-item-list">
          ${sorted.map((s) => `<div class="dd-item"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" value="${escapeHtml(s)}" ${checkedSections.has(s) ? 'checked' : ''} />${escapeHtml(s || '(no section)')}</label></div>`).join('')}
        </div>`;
    }

    const itemCheckboxes = () => [...menu.querySelectorAll('.dd-item-list input[type="checkbox"]')];
    const selectAllCb = document.getElementById('section-select-all');
    if (selectAllCb) {
      selectAllCb.addEventListener('change', () => {
        tab.activeSections = selectAllCb.checked ? null : []; // null = unfiltered; [] = explicit "exclude all"
        itemCheckboxes().forEach((cb) => { cb.checked = selectAllCb.checked; });
        app.render();
      });
    }
    itemCheckboxes().forEach((cb) => {
      cb.addEventListener('change', () => {
        tab.activeSections = itemCheckboxes().filter((c) => c.checked).map((c) => c.value);
        if (selectAllCb) selectAllCb.checked = itemCheckboxes().every((c) => c.checked);
        app.render();
      });
    });
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('section-filter-menu');
    if (!menu.contains(e.target) && e.target.id !== 'section-filter-btn') menu.classList.add('hidden');
  });

  // Connector Type filter — 3D-View-only (see renderToolbar's own comment), same
  // Select-All/Exclude-All + checkbox-list pattern as Stream/Type/Section above, just
  // over a fixed 2-item list ('c' Connectors, 's' Streams) instead of a scanned one.
  // Replaces the old node-right-click-only quick filter (tab.connectorTypeFilter) —
  // "let's make that user selectable for the view same as the view filters already
  // existing."
  const CONNECTOR_TYPE_ITEMS = [{ value: 'c', label: 'Connectors (c)' }, { value: 's', label: 'Streams (s)' }, { value: 'd', label: 'Data (d)' }];
  document.getElementById('connector-type-filter-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('connector-type-filter-menu');
    const tab = store.activeTab();
    if (!tab || tab.type !== '3d') return;

    const isFilterActive = tab.activeConnectorTypes != null;
    const checkedTypes = isFilterActive ? new Set(tab.activeConnectorTypes) : new Set(CONNECTOR_TYPE_ITEMS.map((i) => i.value));
    const allChecked = CONNECTOR_TYPE_ITEMS.every((i) => checkedTypes.has(i.value));

    menu.innerHTML = `
      <div class="dd-item dd-select-all">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="connector-type-select-all" ${allChecked ? 'checked' : ''} />Select All / Exclude All
        </label>
      </div>
      <div class="dd-item-list">
        ${CONNECTOR_TYPE_ITEMS.map((i) => `<div class="dd-item"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" value="${escapeHtml(i.value)}" ${checkedTypes.has(i.value) ? 'checked' : ''} />${escapeHtml(i.label)}</label></div>`).join('')}
      </div>`;

    const itemCheckboxes = () => [...menu.querySelectorAll('.dd-item-list input[type="checkbox"]')];
    const selectAllCb = document.getElementById('connector-type-select-all');
    selectAllCb.addEventListener('change', () => {
      tab.activeConnectorTypes = selectAllCb.checked ? null : []; // null = unfiltered; [] = explicit "exclude all"
      itemCheckboxes().forEach((cb) => { cb.checked = selectAllCb.checked; });
      app.render();
    });
    itemCheckboxes().forEach((cb) => {
      cb.addEventListener('change', () => {
        tab.activeConnectorTypes = itemCheckboxes().filter((c) => c.checked).map((c) => c.value);
        selectAllCb.checked = itemCheckboxes().every((c) => c.checked);
        app.render();
      });
    });
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('connector-type-filter-menu');
    if (!menu.contains(e.target) && e.target.id !== 'connector-type-filter-btn') menu.classList.add('hidden');
  });

  // Layer Order (3D-only) — which streamTemplate's value[] decides element-group/type
  // ordering in the 3D scene. A plain persisted preference (not a filter), so it's a
  // <select> like Current View/Default Model rather than the checkbox-dropdown pattern
  // Stream/Type/Section/Connector Type use.
  document.getElementById('view3d-layer-order-select').addEventListener('change', (e) => {
    setCachedView3DLayerOrderTemplate(e.target.value);
    app.render();
  });

  // Highlight (3D-only) — draws a wireframe box around every part of the checked
  // element type(s), a visual call-out layered on top of the scene rather than a
  // filter (highlighted and non-highlighted parts stay equally visible). Same
  // checkbox-dropdown pattern as the Type filter above, scanning the WHOLE document's
  // parts (not one view's) for its available-types list — same reasoning as the 3D
  // branch of the Type/Stream filters. No Select-All/Exclude-All row: "highlight
  // everything" isn't a meaningful default worth offering here, unlike a real filter.
  document.getElementById('highlight-type-filter-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('highlight-type-filter-menu');
    const tab = store.activeTab();
    if (!tab || tab.type !== '3d') return;

    const availableTypes = new Set();
    for (const p of store.doc.parts) availableTypes.add(p.type);
    const items = [...availableTypes].map((type) => {
      const elDef = (store.settings.elements || []).find((el) => el.type === type);
      return { type, title: elDef ? elDef.title : type };
    }).sort((a, b) => a.title.localeCompare(b.title));

    const checked = new Set(tab.highlightedTypes || []);
    if (items.length === 0) {
      menu.innerHTML = '<div class="dd-empty">No elements in the model</div>';
    } else {
      menu.innerHTML = `<div class="dd-item-list">${items.map((i) => `<div class="dd-item"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" value="${escapeHtml(i.type)}" ${checked.has(i.type) ? 'checked' : ''} />${escapeHtml(i.title)}</label></div>`).join('')}</div>`;
    }

    menu.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        tab.highlightedTypes = [...menu.querySelectorAll('input[type="checkbox"]')].filter((c) => c.checked).map((c) => c.value);
        app.render();
      });
    });
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('highlight-type-filter-menu');
    if (!menu.contains(e.target) && e.target.id !== 'highlight-type-filter-btn') menu.classList.add('hidden');
  });

  // Connector levels — blank input means null ("All"/unlimited); any non-negative
  // integer bounds the BFS expansion hop count. Only has any effect while Stream or
  // Types is actively filtering (canvas.js gates on that).
  document.getElementById('connector-levels-input').addEventListener('change', (e) => {
    const tab = store.activeTab();
    if (!tab || tab.type !== 'canvas') return;
    const raw = e.target.value.trim();
    if (raw === '') {
      tab.connectorLevels = null;
    } else {
      const n = Math.max(0, Math.floor(Number(raw)) || 0);
      tab.connectorLevels = n;
      e.target.value = String(n);
    }
    app.render();
  });

  document.getElementById('undo-btn').addEventListener('click', () => { const tab = store.activeTab(); if (store.undo(tab)) app.render(); });
  document.getElementById('redo-btn').addEventListener('click', () => { const tab = store.activeTab(); if (store.redo(tab)) app.render(); });

  document.getElementById('save-json-btn').addEventListener('click', () => app.saveJson());
  document.getElementById('load-json-btn').addEventListener('click', () => document.getElementById('load-json-input').click());
  document.getElementById('load-json-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) app.loadJson(file);
    e.target.value = '';
  });

  document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    const cur = localStorage.getItem('dycad-theme') || 'light';
    const next = cur === 'light' ? 'dark' : 'light';
    localStorage.setItem('dycad-theme', next);
    document.body.dataset.theme = next;
  });

  document.addEventListener('keydown', (e) => {
    const modifier = e.ctrlKey || e.metaKey;
    if (!modifier) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
    const tab = store.activeTab();
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); if (store.undo(tab)) app.render(); }
    else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') { e.preventDefault(); if (store.redo(tab)) app.render(); }
    else if (e.key.toLowerCase() === 'c') { if (tab && tab.type === 'canvas' && tab.selection.size > 0) { e.preventDefault(); app.runCommand('copy'); } }
    else if (e.key.toLowerCase() === 'v') { if (tab && tab.type === 'canvas' && app.clipboard) { e.preventDefault(); app.runCommand('paste'); } }
  });
}

bootstrap();
