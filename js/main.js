import { loadAllData } from './data.js';
import { Store, ciEq, newId } from './state.js';
import { parseArchimateXml } from './archimate.js';
import { renderTabs, renderToolbar, renderToolbox, renderSelectionInfo, renderCommands, renderProperties, renderMessageLog, escapeHtml, groupFill, getCommandDefs, CMD_ICONS, getAllPinnedFields, setAllPinnedFields } from './render.js';
import { renderPages, renderCanvasPage, wireGlobalCanvasHandlers, buildMarkerDefs, redrawNodeSizes, redrawAndResolveLayout, getNodeSize, passesStreamFilter, passesElementTypeFilter, isAnyVisibilityFilterActive, expandVisiblePartVmIdsByLevel } from './canvas.js';
import { validRelationOptions, elementByType, defaultRelationKeyFor } from './rules.js';
import { createStream, duplicateStream, nextStreamName, splitNode, levelUp, levelDown, levelDownSingle, copyNodes, pasteNodes, remap, mergeNodes, mergePartsAndView, mergeViewOnly, REMAP_SORT_KEYS, REMAP_SORT_LABELS, DEFAULT_REMAP_SORT_KEYS, generateInventoryView, generateIndustry, addExistingPartsToView, populateFromTemplate, duplicateSection as duplicateSectionCommand, smartCheckView, scanStreamsForAutoComplete, autoCompleteStreams, createBulkLookupCache } from './commands.js';
import { APP_VERSION } from './version.js';
import { isSectionViewType, pixelToNearestGrid, isTypeAllowedInSection, insertSectionAfter, removeSectionAndMembers, findFreeCellInSection } from './sections.js';
import { stepSimulation, startContinuousRun, pauseContinuousRun, continueContinuousRun, stopContinuousRun, resetSimulation, saveSimSnapshot, loadSimSnapshot, pushMessageLog } from './simulation.js';
import { flattenJsonRecords, buildRowsFromRecords, detectSharedFunctions, resolveSharedFunctions, buildIndustryTree, flattenIndustryTree } from './sfce.js';

/** Pretty-prints a Script Console result. JSON.stringify covers plain data (the common
 * case — arrays of parts, objects, etc.); falls back to String() for anything it can't
 * serialize (functions, DOM nodes, circular structures). */
function stringifyForConsole(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
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

  switchToTab(tabId) {
    this.store.activeTabId = tabId;
    const tab = this.store.activeTab();
    if (tab && tab.type === 'canvas') this.store.currentView = tab.viewId;
    this.render();
  }

  closeTab(tabId) {
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

  /** Double-click a node: open its linked view if it still resolves; else try a view
   * matching the node's label; else create one (single-node level-down). */
  openOrCreateLinkedView(tab, vmId) {
    const vm = this.store.findViewMember(vmId);
    if (!vm) return;
    if (vm.linkedViewName && this.store.findView(vm.linkedViewName)) {
      this.openOrSwitchView(vm.linkedViewName);
      return;
    }
    const part = this.store.findPart(vm.objectId);
    const matchingView = part && this.store.findView(part.label);
    if (matchingView) {
      vm.linkedViewName = matchingView.id;
      this.recordAndRender();
      this.openOrSwitchView(matchingView.id);
      return;
    }
    levelDownSingle(this, tab, vmId);
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

  /** Simulation > Script Console: a REPL-style debugging aid, separate from any one
   * Part's script — for poking at live simulation/document state interactively rather
   * than round-tripping through a node's script field. Deliberately more powerful than
   * the sandboxed ctx a Part's script receives (full `app`/`store` access, not just
   * read-only findParts) since this is an explicit, opt-in debugging tool, not something
   * a saved document can carry and re-execute unattended. Each entry is evaluated as an
   * expression first (auto-wrapped in `return (...)`) so one-liners like
   * `findParts({ type: 'BusinessCapability', model }).map(p => p.label)` don't need an
   * explicit return; falls back to raw statement execution (the same contract node
   * scripts use) if that doesn't parse, so multi-statement snippets still work. */
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
        <code>findParts({type, model})</code>, <code>log(...)</code>. Enter an expression, or full
        statements ending in your own <code>return</code>. Ctrl+Enter (or the Run button) to execute.
      </div>
      <div id="console-output" style="height:220px;overflow-y:auto;background:var(--bg);border:1px solid var(--border-strong);border-radius:5px;padding:8px;font-family:var(--mono);font-size:12px;white-space:pre-wrap;margin-bottom:8px;"></div>
      <textarea id="console-input" spellcheck="false" placeholder="e.g. findParts({ type: 'BusinessCapability', model }).map(p => ({ id: p.id, label: p.label }))" style="width:100%;height:70px;font-family:var(--mono);font-size:12px;box-sizing:border-box;border:1px solid var(--border-strong);border-radius:5px;padding:8px;background:var(--bg);color:var(--text);resize:vertical;"></textarea>
      <div class="modal-actions"><button class="cancel">Close</button><button class="primary run">Run (Ctrl+Enter)</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    const outputEl = box.querySelector('#console-output');
    const inputEl = box.querySelector('#console-input');
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

    const run = () => {
      const code = inputEl.value;
      if (!code.trim()) return;
      appendOutput(`> ${code}`, 'var(--accent)');

      const bindingNames = ['app', 'store', 'model', 'findParts', 'log'];
      const bindingValues = [
        this, this.store, this.store.simSelectedModel || null,
        findPartsForConsole,
        (...args) => appendOutput(args.map((a) => (typeof a === 'string' ? a : stringifyForConsole(a))).join(' ')),
      ];

      let result, threw = false, errMessage = '';
      try {
        result = new Function(...bindingNames, `return (\n${code}\n)`)(...bindingValues);
      } catch (exprErr) {
        try {
          result = new Function(...bindingNames, code)(...bindingValues);
        } catch (stmtErr) {
          threw = true;
          errMessage = (stmtErr && stmtErr.message) ? stmtErr.message : String(stmtErr);
        }
      }
      if (threw) {
        appendOutput(`Error: ${errMessage}`, '#c0392b');
      } else if (result !== undefined) {
        appendOutput(stringifyForConsole(result));
      }
      inputEl.value = '';
      inputEl.focus();
    };

    box.querySelector('.run').addEventListener('click', run);
    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    inputEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });
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

  deleteSelection(tab) {
    for (const id of tab.selection) this.store.deleteViewMember(id);
    tab.selection.clear();
    this.recordAndRender();
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

    // enforce a unique (from,to,model,connectorType) combination: if a matching
    // connector already exists anywhere, offer to add THAT one to this view instead of
    // silently creating a duplicate.
    const existing = this.store.findExistingConnector(fromPart.id, toPart.id, this.store.defaultModel, 'c');
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
    this.finishConnect(tab, fromVm, toVm, key);
  }

  finishConnect(tab, fromVm, toVm, relationKey) {
    const rel = (this.store.settings.relations || []).find((r) => r.key === relationKey);
    const conn = this.store.createConnector({ from: fromVm.objectId, to: toVm.objectId, model: this.store.defaultModel, connectorType: 'c', relationship: rel?.name || 'Association' });
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
    pop.querySelector('select').addEventListener('change', (e) => { this.applyRelationToConnector(conn, e.target.value); this.recordAndRender(); pop.remove(); });
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
      this.promptModal({
        title: 'Level Up',
        fields: [{ key: 'name', label: 'New view name', value: 'New View' }],
        onSubmit: (vals) => levelUp(this, tab, vals.name),
      });
    } else if (key === 'levelDown') {
      levelDown(this, tab, selIds);
    } else if (key === 'generate') {
      const templates = (this.store.settings.streamTemplates || []).map((t) => t.name);
      // Step 37: existing BusinessFunction-type parts in the current model — shown as a
      // suggestion list on Function Name so the user can pick one to reuse without
      // retyping it exactly, but the field stays free-text (they can still type a new
      // name). Actual reuse-by-label-match already happens in createStream (Step 33) —
      // this is purely a discoverability aid, no new reuse logic needed.
      const existingFunctionNames = [...new Set(
        this.store.doc.parts
          .filter((p) => ciEq(p.type, 'BusinessFunction') && ciEq(p.model, this.store.defaultModel))
          .map((p) => p.label)
      )];
      this.promptModal({
        title: 'Generate Stream',
        fields: [
          { key: 'template', label: 'Stream template', type: 'select', options: templates, value: templates.includes('Enterprise') ? 'Enterprise' : templates[0] },
          { key: 'stream', label: 'Stream name', value: `Stream-${Date.now().toString().slice(-4)}` },
          { key: 'functionName', label: 'Function Name', type: 'combo', options: existingFunctionNames, value: existingFunctionNames.length ? '' : 'testFunction' },
          { key: 'capabilityName', label: 'Capability Name', value: 'testCapability' },
          { key: 'entityName', label: 'Entity Name', value: 'testEntity' },
        ],
        onSubmit: (vals) => {
          // Function Name now defaults to blank (rather than a placeholder value) when
          // existing functions are available, so leaving it empty on submit is a real
          // possibility, not just a leftover default — guard against silently creating
          // a part with a blank label.
          if (!vals.functionName.trim()) { this.toast('Function Name is required.', true); return; }
          createStream(this, {
            templateName: vals.template, streamName: vals.stream,
            functionName: vals.functionName, capabilityName: vals.capabilityName, entityName: vals.entityName,
            modelName: this.store.defaultModel, viewName: this.store.currentView,
            anchorX: canvasPos?.x, anchorY: canvasPos?.y,
          });
        },
        closeOnOutsideClick: false,
      });
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
      this.promptAddExisting(tab);
    } else if (key === 'populateFromTemplate') {
      this.promptPopulateFromTemplate(tab);
    }
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

  /** Bespoke (not the generic promptModal) so it can carry the "Place on current view"
   * checkbox alongside the industry picker. To review a dataset before generating, use
   * Catalogs > SFCE first, separately — this dialog is a modal overlay (like every
   * other modal in the app; see CLAUDE.md's "no click-outside-to-close" convention),
   * so nothing behind it is reachable while it's open, which ruled out a "preview"
   * button that would open the catalog in another tab the person still couldn't see. */
  promptGenerateIndustry() {
    const industries = Object.keys(this.store.industryData || {});
    if (industries.length === 0) { this.toast('No industry data loaded.', true); return; }

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Generate Industry</h3>
      <div class="prop-row"><label>Industry</label><select id="gi-industry">${industries.map((i) => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join('')}</select></div>
      <div class="prop-row checkbox"><input type="checkbox" id="gi-place-view" checked /><label for="gi-place-view">Place on current view</label></div>
      <div style="font-size:11px;color:var(--text-muted);margin:-4px 0 12px 0;">Unchecked: creates the parts/connectors only — much faster for a large dataset, but nothing is placed on any view. Review via Catalogs &gt; Parts, then Add Existing to bring chosen ones into a view.</div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Generate</button></div>`;
    overlay.appendChild(box);
    root.appendChild(overlay);

    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('.submit').addEventListener('click', () => {
      const industry = box.querySelector('#gi-industry').value;
      const placeInView = box.querySelector('#gi-place-view').checked;
      overlay.remove();
      this.runGenerateIndustryWithProgress(industry, placeInView);
    });
  }

  /** Generate Industry can mean thousands of individual createStream calls on a large
   * imported dataset (see Load SFCE) — generateIndustry is async and yields
   * periodically specifically so this can show real progress instead of the tab
   * appearing to freeze for however long the whole operation takes. */
  async runGenerateIndustryWithProgress(industryKey, placeInView = true) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Generating "${escapeHtml(industryKey)}"…</h3><p id="gi-progress-text">Starting…</p>`;
    overlay.appendChild(box);
    root.appendChild(overlay);
    const progressText = box.querySelector('#gi-progress-text');
    try {
      await generateIndustry(this, industryKey, (done, total) => {
        progressText.textContent = `${done} / ${total} capabilities processed…`;
      }, placeInView);
    } finally {
      overlay.remove();
    }
  }

  /** Catalogs > SFCE: a read-only, flattened table of one industryData
   * collection's Section/Function/Capability/Entity hierarchy — works for both a
   * Load SFCE import and the built-in "general" data (fce-generalnodes.json), since
   * flattenIndustryTree supports both shapes. Read-only for now; the request notes
   * this'll be expanded to a showFields-driven editor at a later step, so this
   * deliberately doesn't try to anticipate that — just a real, working table today. */
  promptSfceCatalog() {
    const industries = Object.keys(this.store.industryData || {});
    if (industries.length === 0) { this.toast('No industry data loaded.', true); return; }
    if (industries.length === 1) { this.openOrSwitchSfceCatalog(industries[0]); return; }
    this.promptModal({
      title: 'SFCE Catalog',
      fields: [
        { key: 'industry', label: 'Industry', type: 'select', options: industries, value: industries[0] },
      ],
      onSubmit: (vals) => this.openOrSwitchSfceCatalog(vals.industry),
    });
  }

  /** Find-or-create pattern matching openOrSwitchCatalog, keyed by industryKey so a
   * separate tab opens per dataset rather than one shared, overwritten tab. */
  openOrSwitchSfceCatalog(industryKey) {
    let tab = this.store.tabs.find((t) => t.type === 'table' && t.sfceIndustryKey === industryKey);
    if (!tab) {
      const closedIdx = this.store.closedTabs.findIndex((t) => t.type === 'table' && t.sfceIndustryKey === industryKey);
      if (closedIdx !== -1) {
        tab = this.store.closedTabs.splice(closedIdx, 1)[0];
        this.store.tabs.push(tab);
      } else {
        const tree = this.store.industryData?.[industryKey] || [];
        const rows = flattenIndustryTree(tree);
        tab = this.store.createTab({ type: 'table', title: `SFCE: ${industryKey}` });
        tab.sfceIndustryKey = industryKey;
        tab.tableRows = rows;
        tab.tableCols = ['section', 'functionId', 'functionName', 'functionDescription', 'capabilityId', 'capabilityName', 'capabilityDescription', 'entityId', 'entityName', 'entityDescription'];
      }
    }
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
      <div class="prop-row" id="scv-autocomplete-template-row" style="margin-left:22px;"><label>Stream Template</label><select id="scv-autocomplete-template">${templateNames.map((n) => `<option value="${escapeHtml(n)}" ${n === (templateNames.includes('Enterprise') ? 'Enterprise' : templateNames[0]) ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select></div>
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
      overlay.remove();

      if (!missingConnectors && !missingConnectorsAndNodes && !doAutoComplete) { this.toast('Nothing selected to check.'); return; }

      if (missingConnectors || missingConnectorsAndNodes) {
        const result = smartCheckView(this, tab, { missingConnectors, missingConnectorsAndNodes, levels });
        if (!result) { this.toast('Smart Check failed — view not found.', true); return; }
        this.recordAndRender();
        const parts = [];
        if (result.connectorsAdded) parts.push(`${result.connectorsAdded} connector${result.connectorsAdded === 1 ? '' : 's'}`);
        if (result.nodesAdded) parts.push(`${result.nodesAdded} node${result.nodesAdded === 1 ? '' : 's'}`);
        this.toast(parts.length ? `Smart Check added ${parts.join(' and ')}.` : 'Smart Check found nothing missing.');
      }

      if (doAutoComplete) this.promptAutoCompleteStreams(tab, autoCompleteTemplate);
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
    const remembered = view?.remapSortKeys && view.remapSortKeys.length ? view.remapSortKeys.filter((k) => REMAP_SORT_KEYS.includes(k)) : DEFAULT_REMAP_SORT_KEYS;
    // start from the remembered/default order, then append any keys missing from it
    // (e.g. a newly-added key like elementGroup that predates a saved remapSortKeys) —
    // every key appears exactly once, so duplicates are impossible by construction.
    const orderedKeys = [...remembered, ...REMAP_SORT_KEYS.filter((k) => !remembered.includes(k))];
    const templateNames = (this.store.settings.streamTemplates || []).map((t) => t.name);

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `
      <h3>Remap</h3>
      <div class="prop-row"><label>Stream Template</label><select id="rm-template">${templateNames.map((n) => `<option value="${escapeHtml(n)}" ${n === (templateNames.includes('Enterprise') ? 'Enterprise' : templateNames[0]) ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select></div>
      <div class="prop-row"><label>Pattern</label><select id="rm-pattern"><option value="default">default</option><option value="none">none</option><option value="force">force-directed</option></select></div>
      <div class="prop-row checkbox" id="rm-limit-row"><input type="checkbox" id="rm-limit" /><label for="rm-limit">Limit columns to view</label></div>
      <div class="prop-row checkbox"><input type="checkbox" id="rm-filtered-only" /><label for="rm-filtered-only">Only remap filtered nodes (others stay put, hidden by the current filter)</label></div>
      <div id="rm-priority-section">
        <div style="margin-top:10px; font-size:12px; color:var(--text-muted);">Sort priority (top = highest priority)</div>
        <ul id="rm-priority-list" style="list-style:none; margin:6px 0 0 0; padding:0; display:flex; flex-direction:column; gap:3px;"></ul>
      </div>
      <div id="rm-force-note" class="hidden" style="margin-top:10px; font-size:12px; color:var(--text-muted);">Force-directed placement clusters connected nodes together and reduces total edge length — it doesn't use sort order or column limits, so those are hidden while this pattern is selected.</div>
      <div class="prop-row checkbox hidden" id="rm-force-prefer-right-row"><input type="checkbox" id="rm-force-prefer-right" /><label for="rm-force-prefer-right">Prefer placing connected nodes to the right when a cell is available</label></div>
      <div class="prop-row checkbox hidden" id="rm-force-group-rows-row"><input type="checkbox" id="rm-force-group-rows" /><label for="rm-force-group-rows">Only start a new row when a node is a new hop away (keep same-hop nodes on one row)</label></div>
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
      box.querySelector('#rm-priority-section').classList.toggle('hidden', isForce);
      box.querySelector('#rm-limit-row').classList.toggle('hidden', isForce);
      box.querySelector('#rm-force-note').classList.toggle('hidden', !isForce);
      box.querySelector('#rm-force-prefer-right-row').classList.toggle('hidden', !isForce);
      box.querySelector('#rm-force-group-rows-row').classList.toggle('hidden', !isForce);
    };
    patternSelect.addEventListener('change', updatePatternVisibility);
    updatePatternVisibility();

    box.querySelector('.reset').addEventListener('click', () => {
      // restores the app's built-in defaults, not this view's previously-remembered
      // order — a distinct action from just reopening the modal.
      box.querySelector('#rm-template').value = templateNames.includes('Enterprise') ? 'Enterprise' : templateNames[0];
      box.querySelector('#rm-pattern').value = 'default';
      box.querySelector('#rm-limit').checked = false;
      box.querySelector('#rm-filtered-only').checked = false;
      box.querySelector('#rm-force-prefer-right').checked = false;
      box.querySelector('#rm-force-group-rows').checked = false;
      orderedKeys.splice(0, orderedKeys.length, ...DEFAULT_REMAP_SORT_KEYS, ...REMAP_SORT_KEYS.filter((k) => !DEFAULT_REMAP_SORT_KEYS.includes(k)));
      renderPriorityList();
      updatePatternVisibility();
    });
    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    box.querySelector('.submit').addEventListener('click', () => {
      const templateName = box.querySelector('#rm-template').value;
      const pattern = box.querySelector('#rm-pattern').value;
      const limitColumnsToView = box.querySelector('#rm-limit').checked;
      const filteredOnly = box.querySelector('#rm-filtered-only').checked;
      const forcePreferRight = box.querySelector('#rm-force-prefer-right').checked;
      const forceGroupRows = box.querySelector('#rm-force-group-rows').checked;
      const sortKeys = [...orderedKeys];
      overlay.remove();

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
      remap(this, tab, { sortKeys, templateName, pattern, limitColumnsToView, visiblePartVmIds, forcePreferRight, forceGroupRows });
    });
  }

  promptAddExisting(tab) {
    const store = this.store;
    const inViewPartIds = new Set(store.viewMembersForView(tab.viewId).filter((vm) => vm.objectType === 'part').map((vm) => vm.objectId));
    const availableParts = store.doc.parts.filter((p) => !inViewPartIds.has(p.id));
    if (availableParts.length === 0) { this.toast('No other parts available to add.', true); return; }

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
      addExistingPartsToView(this, tab, partIds, includeConnectors);
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

  /** File > Save Local Settings: bundles the things that deliberately live OUTSIDE the
   * main save file — store.localSettings (secrets, e.g. API keys — see ctx.secrets in
   * simulation.js), the pinned-fields config (a UI preference, otherwise stuck in this
   * one browser's localStorage), and maxScriptEntities (the ctx.createPart/
   * ctx.createConnector safety cap, see simulation.js) — into a single downloadable
   * file, so all of it travels together between browsers/machines. Wrapped under
   * `secrets`/`pinnedFields`/`maxScriptEntities` keys rather than the old flat
   * {key:value} shape Load Local Settings originally used; loadLocalSettings below stays
   * backward-compatible with those older, secrets-only files (see its own comment). */
  saveLocalSettings() {
    const data = { secrets: this.store.localSettings || {}, pinnedFields: getAllPinnedFields(), maxScriptEntities: this.store.maxScriptEntities };
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
          activeStreams: [], activeElementTypes: null, connectorLevels: 0, selectedSectionId: null,
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

  /** File > Export View as Image: choose SVG or PNG for the current view. */
  promptExportViewAsImage() {
    const tab = this.store.activeTab();
    if (!tab || tab.type !== 'canvas') { this.toast('No view open to export.', true); return; }
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

    const showTypes = view?.chkShowElementTypes;
    const showDescription = view?.chkShowDescription;
    const minX = Math.min(...partVms.map((vm) => vm.x));
    const minY = Math.min(...partVms.map((vm) => vm.y));
    const maxX = Math.max(...partVms.map((vm) => vm.x + nodeW));
    const maxY = Math.max(...partVms.map((vm) => vm.y + nodeH));
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

  /** File > Load SFCE: imports an arbitrary JSON file as an alternate industry
   * collection (Section/Function/Capability/Entity) for Advanced > Generate Industry.
   * Doesn't touch the canvas — no viewMembers, no new view; only store.industryData. */
  promptLoadSFCE() {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Load SFCE</h3>
      <p style="font-size:12px; color:var(--text-muted); margin-top:-6px;">Loads a Section/Function/Capability/Entity collection from a JSON file as an alternate to the built-in "general" industry data, for use with Advanced &gt; Generate Industry. This does not add anything to the current view.</p>
      <div class="prop-row"><label>File</label><input type="file" id="sfce-file-input" accept="application/json" /></div>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary" id="sfce-preread-btn">Preread</button></div>
    `;
    overlay.appendChild(box);
    root.appendChild(overlay);
    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());

    box.querySelector('#sfce-preread-btn').addEventListener('click', async () => {
      const fileInput = box.querySelector('#sfce-file-input');
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
        this.toast('No records found in that file — check it contains an array of objects (optionally nested one level, e.g. groups each containing a list of items).', true);
        return;
      }
      overlay.remove();
      this.promptSFCEMapping(file.name, records, fields);
    });
  }

  /** Second step: suggested industry name + field selectors, built from what
   * flattenJsonRecords found in the file. */
  promptSFCEMapping(fileName, records, fields) {
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';

    const suggestedName = fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'imported';
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
    const suggestedSection = suggest('section', 'ministr', 'department', 'group');
    const suggestedFunction = suggest('function', 'domain', 'category');
    const suggestedCapability = suggest('name', 'capability', 'title');
    const suggestedEntity = suggest('entity', 'object', 'data');
    const suggestedDescription = suggest('description', 'desc', 'summary');

    const fieldOptions = (selected) => fields.map((f) => `<option value="${escapeHtml(f)}" ${f === selected ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('');
    const fieldOptionsWithNone = (selected) => `<option value="">(none)</option>` + fieldOptions(selected);

    box.innerHTML = `<h3>Load SFCE — ${records.length} record${records.length === 1 ? '' : 's'} found</h3>
      <div class="prop-row"><label>Industry Name</label><input type="text" id="sfce-industry-name" value="${escapeHtml(suggestedName)}" /></div>
      <div class="prop-row"><label>Section field</label><select id="sfce-field-section">${fieldOptions(suggestedSection)}</select></div>
      <div class="prop-row"><label>Function field</label><select id="sfce-field-function">${fieldOptions(suggestedFunction)}</select></div>
      <div class="prop-row"><label>Capability field</label><select id="sfce-field-capability">${fieldOptions(suggestedCapability)}</select></div>
      <div class="prop-row"><label>Entity field</label><select id="sfce-field-entity">${fieldOptionsWithNone(suggestedEntity)}</select></div>
      <div class="prop-row"><label>Description field</label><select id="sfce-field-description">${fieldOptionsWithNone(suggestedDescription)}</select></div>
      <p style="font-size:12px; color:var(--text-muted);">A Section value containing multiple entries (a comma-separated list, or an array) is split into one row per section. Missing Section/Function/Capability values are kept as "(unspecified)" rather than dropped; a missing Entity value simply means that row won't add an entity.</p>
      <div class="modal-actions"><button class="cancel">Cancel</button><button class="primary submit">Load</button></div>
    `;
    overlay.appendChild(box);
    root.appendChild(overlay);
    box.querySelector('.cancel').addEventListener('click', () => overlay.remove());

    box.querySelector('.submit').addEventListener('click', () => {
      const industryName = box.querySelector('#sfce-industry-name').value.trim();
      if (!industryName) { this.toast('Industry Name is required.', true); return; }
      if (this.store.industryData?.[industryName]) {
        this.toast(`"${industryName}" already exists — choose a different Industry Name.`, true);
        return;
      }
      const mapping = {
        sectionField: box.querySelector('#sfce-field-section').value,
        functionField: box.querySelector('#sfce-field-function').value,
        capabilityField: box.querySelector('#sfce-field-capability').value,
        entityField: box.querySelector('#sfce-field-entity').value || null,
        descriptionField: box.querySelector('#sfce-field-description').value || null,
      };
      overlay.remove();
      const parsed = buildRowsFromRecords(records, mapping);
      const { sectionsByFunction, sharedFunctionNames } = detectSharedFunctions(parsed.rows);
      if (sharedFunctionNames.size > 0) {
        this.promptSFCESharedConfirm(industryName, parsed, sectionsByFunction, sharedFunctionNames);
      } else {
        this.finishSFCEImport(industryName, parsed.rows, parsed);
      }
    });
  }

  /** Third step, only shown when detectSharedFunctions found any Function names that
   * end up needing to exist in more than one Section: ask whether to combine each of
   * those into one shared Function (placed in a single section called "Shared", with
   * its capabilities from every section combined), or keep each Section's own copy
   * (with a numbered suffix on the name for every section after the first). */
  promptSFCESharedConfirm(industryName, parsed, sectionsByFunction, sharedFunctionNames) {
    const sharedCount = sharedFunctionNames.size;
    const exampleName = [...sharedFunctionNames][0];
    const exampleSections = sectionsByFunction.get(exampleName);
    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = `<h3>Shared Functions found</h3>
      <p>${sharedCount} Function name${sharedCount === 1 ? '' : 's'} appear${sharedCount === 1 ? 's' : ''} in more than one Section — e.g. "${escapeHtml(exampleName)}" appears in: ${exampleSections.map(escapeHtml).join(', ')}.</p>
      <p>Combine each of these into a single shared Function (with its Capabilities from every section combined), placed in one Section called "Shared"?</p>
      <div class="modal-actions"><button class="cancel" id="sfce-shared-no">No, keep in original sections</button><button class="primary" id="sfce-shared-yes">Yes, use "Shared"</button></div>
    `;
    overlay.appendChild(box);
    root.appendChild(overlay);
    box.querySelector('#sfce-shared-yes').addEventListener('click', () => {
      overlay.remove();
      this.finishSFCEImport(industryName, resolveSharedFunctions(parsed.rows, sectionsByFunction, sharedFunctionNames, true), parsed);
    });
    box.querySelector('#sfce-shared-no').addEventListener('click', () => {
      overlay.remove();
      this.finishSFCEImport(industryName, resolveSharedFunctions(parsed.rows, sectionsByFunction, sharedFunctionNames, false), parsed);
    });
  }

  /** Builds the tree, stores it, and reports statistics — the unique section list (in
   * first-seen order, per the request, since it'll be needed elsewhere) and subtotals —
   * to the Message Log as well as a toast summary. */
  finishSFCEImport(industryName, resolvedRows, parsed) {
    const { tree, stats } = buildIndustryTree(resolvedRows);
    this.store.industryData = { ...(this.store.industryData || {}), [industryName]: tree };

    const lines = [
      `[Load SFCE: "${industryName}"] ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} processed.`,
      `Sections (${stats.sectionOrder.length}, in order): ${stats.sectionOrder.join(', ')}`,
      `Subtotals — Functions: ${stats.functionCount}, Capabilities: ${stats.capabilityCount}, Entities: ${stats.entityCount}`,
    ];
    const notes = [];
    if (stats.mergedDuplicates) notes.push(`${stats.mergedDuplicates} exact duplicate row${stats.mergedDuplicates === 1 ? '' : 's'} merged`);
    if (parsed.missingFunction) notes.push(`${parsed.missingFunction} row${parsed.missingFunction === 1 ? '' : 's'} had no Function value`);
    if (parsed.missingCapability) notes.push(`${parsed.missingCapability} row${parsed.missingCapability === 1 ? '' : 's'} had no Capability value`);
    if (parsed.missingEntity) notes.push(`${parsed.missingEntity} row${parsed.missingEntity === 1 ? '' : 's'} had no Entity value`);
    if (parsed.missingDescription) notes.push(`${parsed.missingDescription} row${parsed.missingDescription === 1 ? '' : 's'} had no Description value`);
    if (notes.length) lines.push(`Missing-value handling: ${notes.join('; ')} — kept, not dropped.`);

    for (const line of lines) pushMessageLog(this.store, line);
    this.render();
    this.toast(`Loaded "${industryName}": ${stats.sectionOrder.length} sections, ${stats.functionCount} functions, ${stats.capabilityCount} capabilities, ${stats.entityCount} entities. Details in the Message Log.`);
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

  const store = new Store(data.settings, data.fce);
  store.mergedRelationshipPairs = data.mergedRelationshipPairs;

  document.body.appendChild(buildMarkerDefs(store));

  const app = new App(store);
  window.dycadApp = app; // debugging aid

  const homeView = store.doc.views[0];
  const homeTab = app.createCanvasTab(homeView);
  store.activeTabId = homeTab.id;
  app.openOrSwitchDocs(); // Instructions tab opens on startup, active by default — home tab stays open behind it

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
    if (action === 'scriptConsole') { app.promptScriptConsole(); return; } // works with no model selected
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
    <div class="dd-item" data-action="loadSFCE">Load SFCE</div>
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
      else if (item.dataset.action === 'loadSFCE') app.promptLoadSFCE();
      else if (item.dataset.action === 'loadLocalSettings') document.getElementById('load-local-settings-input').click();
      else if (item.dataset.action === 'saveLocalSettings') app.saveLocalSettings();
      else if (item.dataset.action === 'importData') app.promptImportData();
      else if (item.dataset.action === 'importArchimate') document.getElementById('import-archimate-input').click();
      fileMenu.classList.add('hidden');
    });
  });
  document.getElementById('load-local-settings-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Expected a JSON object.');
      // File > Save Local Settings (added alongside pinned fields / the script-entity
      // cap) writes the new { secrets, pinnedFields, maxScriptEntities } wrapped shape.
      // Files saved before that — a flat {key: value} object of secrets only, with none
      // of those keys present — still load the same as always, straight into
      // store.localSettings, so nobody's older file breaks.
      if ('secrets' in obj || 'pinnedFields' in obj || 'maxScriptEntities' in obj) {
        const secrets = (obj.secrets && typeof obj.secrets === 'object' && !Array.isArray(obj.secrets)) ? obj.secrets : {};
        app.store.localSettings = secrets;
        if (obj.pinnedFields) setAllPinnedFields(obj.pinnedFields);
        const capNum = Number(obj.maxScriptEntities);
        if (Number.isFinite(capNum) && capNum > 0) app.store.maxScriptEntities = Math.floor(capNum);
        app.render(); // picks up the new pin config immediately if a property panel is open
        const parts = [`${Object.keys(secrets).length} secret key${Object.keys(secrets).length === 1 ? '' : 's'}`];
        if (obj.pinnedFields) parts.push('pinned fields');
        if (Number.isFinite(capNum) && capNum > 0) parts.push(`max script entities: ${app.store.maxScriptEntities}`);
        app.toast(`Local settings loaded (${parts.join(', ')}).`);
      } else {
        app.store.localSettings = obj;
        app.toast(`Local settings loaded (${Object.keys(obj).length} key${Object.keys(obj).length === 1 ? '' : 's'}).`);
      }
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
      } else if (item.dataset.url) {
        window.open(item.dataset.url, '_blank', 'noopener');
      }
      advancedMenu.classList.add('hidden');
    });
  });

  // ===== Simulation menu (same actions as the toolbar Step/Run/Stop/Reset buttons,
  // plus the log/snapshot commands that don't warrant their own toolbar button) =====
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
    { label: 'Script Console...', action: 'scriptConsole' },
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
    + '<div class="dd-separator"></div><div class="dd-item" data-action="sfce">SFCE</div>';
  catalogsMenu.querySelectorAll('.dd-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.action === 'sfce') { app.promptSfceCatalog(); catalogsMenu.classList.add('hidden'); return; }
      app.openOrSwitchCatalog(item.dataset.type, `${item.dataset.label} Catalog`);
      catalogsMenu.classList.add('hidden');
    });
  });

  // ===== Shared open/close wiring for all four top-row dropdown menus =====
  const MENU_PAIRS = [
    ['file-menu-btn', fileMenu],
    ['catalogs-menu-btn', catalogsMenu],
    ['advanced-menu-btn', advancedMenu],
    ['simulation-menu-btn', simulationMenu],
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

  document.getElementById('stream-filter-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('stream-filter-menu');
    const tab = store.activeTab();
    if (!tab || tab.type !== 'canvas') return;
    const availableStreams = new Set();
    for (const vm of store.viewMembersForView(tab.viewId)) {
      const obj = vm.objectType === 'part' ? store.findPart(vm.objectId) : store.findConnector(vm.objectId);
      for (const s of obj?.streams || []) availableStreams.add(s);
    }
    const sorted = [...availableStreams].sort();
    menu.innerHTML = sorted.length
      ? sorted.map((s) => `<div class="dd-item"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" value="${escapeHtml(s)}" ${tab.activeStreams.includes(s) ? 'checked' : ''} />${escapeHtml(s)}</label></div>`).join('')
      : '<div class="dd-empty">No streams in this view</div>';
    menu.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        tab.activeStreams = [...menu.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
        if (tab.activeStreams.length > 0) {
          tab.selection.clear();
          for (const vm of store.viewMembersForView(tab.viewId)) {
            const obj = vm.objectType === 'part' ? store.findPart(vm.objectId) : store.findConnector(vm.objectId);
            if (obj && (obj.streams || []).some((s) => tab.activeStreams.includes(s))) tab.selection.add(vm.id);
          }
        }
        app.render();
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
    if (!tab || tab.type !== 'canvas') return;

    const availableTypes = new Set();
    for (const vm of store.viewMembersForView(tab.viewId)) {
      if (vm.objectType !== 'part') continue;
      const part = store.findPart(vm.objectId);
      if (part) availableTypes.add(part.type);
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
      menu.innerHTML = '<div class="dd-empty">No elements in this view</div>';
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
