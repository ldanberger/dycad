// state.js — central store for DyCAD.

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Formats a timestamp as "yyyymmdd_hhmmss" (local time) — used for Part/Connector
 * createdAt/updatedAt. Defaults to right now. */
function nowStamp(date = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p2(date.getMonth() + 1)}${p2(date.getDate())}_${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`;
}

function ciEq(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

/** e.g. 'fce-generalnodes.json' -> 'general' (segment after the first '-', before 'nodes'). */
function deriveIndustryName(filename) {
  const afterDash = filename.split('-').slice(1).join('-');
  const idx = afterDash.indexOf('nodes');
  return idx >= 0 ? afterDash.slice(0, idx) : afterDash;
}

class Store {
  constructor(settings, fce) {
    this.settings = settings;   // custom.json contents
    this.fce = fce;             // fce-generalnodes.json contents
    this.mergedRelationshipPairs = []; // set by main.js after data load

    // Industry reference data for "Generate Industry": keyed by name derived from each
    // source filename (the segment after the first '-' and before 'nodes', e.g.
    // 'fce-generalnodes.json' -> 'general'). Only one file is loaded today; more can be
    // added here later without changing how Generate Industry consumes this map.
    this.industryData = { [deriveIndustryName('fce-generalnodes.json')]: fce };
    // Which stream template generateIndustry (commands.js) should use for each
    // industryData key — every key defaults to 'Enterprise' (generateIndustry's own
    // fallback when a key has no entry here, matching the built-in 'general' dataset's
    // 3-level Function/Capability/Entity shape) except keys imported via File > Load
    // SFCCE, which register 'SFCCE' here (a 4-level Function/Capability/Sub-Capability/
    // Entity chain — see sfce.js's own module comment). Memory-only, same lifetime as
    // industryData itself.
    this.industryTemplates = {};

    // ---- persisted model doc (round-trips via Save/Load JSON, shape ~ onestream.json) ----
    this.doc = {
      version: '0.2',
      readme: { note: '' },
      defaultModel: 'Reference',
      currentView: 'home',
      models: [{ modelName: 'Reference' }, { modelName: 'As-is' }, { modelName: 'To-be' }, { modelName: 'Gap' }],
      views: [
        { id: 'home', viewName: 'home', viewType: 'ff', chkShowConnectorType: true, chkShowStreamType: false, chkShowKeys: false, chkShowElementTypes: true, chkShowDescription: true, chkShowOnPageCatalogs: false, chkShowSimValues: false, chkShowScriptBadge: false, routingStyle: 'default', routingStyleStream: 'default', margin: 50, sections: [], nodeWidth: 130, nodeHeight: 46, remapSortKeys: null, spacingScale: 1 },
      ],
      parts: [],
      connectors: [],
      viewMembers: [],
      settingsUser: { relationshipPairs: [] },
    };

    // ---- non-persisted UI/session state ----
    this.tabs = [];        // { id, title, type: 'canvas'|'pdf'|'text'|'table', viewId, history:{past,present,future}, viewport, selection:Set }
    this.activeTabId = null;
    this.closedTabs = [];  // stack of closed tab descriptors, for restore
    this.activeLibraries = new Set(['TOGAF', 'BPMN', 'ArchiMate', 'Other']);
    // Node Scripting / Simulation runtime state — deliberately kept OUTSIDE this.doc so
    // it never round-trips through Save/Load JSON (toJSON()/loadFromJSON() only touch
    // this.doc). Saved/restored separately via its own snapshot file (simulation.js).
    // Scoped by MODEL NAME (not view/tab) — a Part has one simulated value/state shared
    // across every view that displays it; multiple models can run independently and
    // concurrently.
    // simRuntime: modelName -> { tick, values: Map<partId, {value, state, lastError, lastTick}> }
    this.simRuntime = new Map();
    // simLog: modelName -> [{ tick, partId, label, type: 'value'|'error', message, ts }], capped per model.
    this.simLog = new Map();
    // simRunning: modelName -> { timerId } — presence of an entry means that model has an
    // active continuous run. Independent of any tab, so Stop can always find and kill a
    // run regardless of whether its originating tab/view is still open.
    this.simRunning = new Map();
    // Which model the Simulation toolbar (Step/Run/Stop/Reset + its model selector)
    // currently targets — entirely independent of this.doc.defaultModel (defaultModel is
    // used only when creating new nodes). Initialized to defaultModel at boot purely as a
    // starting point; not persisted, not restored across Save/Load or a page refresh.
    this.simSelectedModel = this.doc.defaultModel;
    // Global message console (left-panel "Message Log"): scripts can write arbitrary
    // messages here via ctx.log(...) during a tick, independent of any one view — a
    // running session console rather than a per-view record. Capped at 500 entries.
    this.messageLog = [];
    // Local Secrets (File > Load Local Secrets): a flat key/value object read from a
    // user-loaded JSON file, for secrets (API keys etc.) that must never end up in a
    // save file AND must never be cached to localStorage (unlike Local Settings below) —
    // exposed to scripts as ctx.secrets. Memory-only by design — does NOT survive a page
    // refresh (must be re-loaded each session, deliberately, so a secret never lingers
    // anywhere on disk this app controls); does survive closing/reopening DyCAD's own
    // tabs/views, since it's unrelated to tab lifecycle.
    this.localSecrets = {};
    // Cap on doc.parts.length + doc.connectors.length that ctx.createPart/
    // ctx.createConnector (simulation.js) will allow before refusing further creation —
    // the one guardrail against a buggy/runaway script (especially under continuous Run)
    // unboundedly growing the document. Part of Local Settings (File > Load/Save Local
    // Settings) — unlike Local Secrets above, this one IS cached to localStorage by
    // main.js's bootstrap/load-handler code (kept out of this Node-testable class itself,
    // same reason theme/pinned-fields localStorage access lives in render.js/main.js, not
    // here), so it survives a refresh without re-loading the file. Default here is just
    // the fresh-session fallback before any cached or loaded value is applied.
    this.maxScriptEntities = 5000;
    // Filename of the last file that fully replaced store.doc (Save/Load JSON's own
    // "Load JSON" button, File > Load, File > Load Example) — NOT set by Import Data,
    // which merges additively into whatever's already loaded rather than replacing it.
    // Non-persisted, shown in the header, exposed to scripts as ctx.loadedFileName.
    this.loadedFileName = null;
    // Unsaved-changes tracking for the File menu's Load/Load Example prompts: set true
    // by any recordHistory() call (i.e. any model edit), cleared by Save/Load JSON and
    // Load Example.
    this.dirty = false;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  // ===================== MODELS =====================
  get defaultModel() { return this.doc.defaultModel; }
  set defaultModel(v) { this.doc.defaultModel = v; }

  addModel(name) {
    if (this.doc.models.some((m) => ciEq(m.modelName, name))) return false;
    this.doc.models.push({ modelName: name });
    return true;
  }
  removeModel(name) {
    if (this.doc.models.length <= 1) return false;
    this.doc.models = this.doc.models.filter((m) => !ciEq(m.modelName, name));
    if (ciEq(this.doc.defaultModel, name)) this.doc.defaultModel = this.doc.models[0].modelName;
    return true;
  }

  // ===================== VIEWS =====================
  get currentView() { return this.doc.currentView; }
  set currentView(v) { this.doc.currentView = v; }

  findView(id) { return this.doc.views.find((v) => ciEq(v.id, id)); }

  addView(viewName, viewType = 'ff') {
    const id = viewName;
    if (this.findView(id)) return this.findView(id);
    const view = { id, viewName, viewType, chkShowConnectorType: true, chkShowStreamType: false, chkShowKeys: false, chkShowElementTypes: true, chkShowDescription: true, chkShowOnPageCatalogs: false, chkShowSimValues: false, chkShowScriptBadge: false, routingStyle: 'default', routingStyleStream: 'default', margin: 50, sections: [], nodeWidth: 130, nodeHeight: 46, remapSortKeys: null, spacingScale: 1 };
    this.doc.views.push(view);
    this.ensureViewSections(view);
    return view;
  }

  /** Seed view.sections from the global settings.sections template for its viewType, if not already seeded. */
  ensureViewSections(view) {
    if (!view || ciEq(view.viewType, 'ff') || !view.viewType) return;
    if (view.sections && view.sections.length > 0) return;
    const globalSections = (this.settings.sections || []).filter((s) => ciEq(s.viewType, view.viewType));
    if (globalSections.length === 0) return;
    view.sections = globalSections
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((s) => ({ ...s, id: newId() }));
  }
  removeView(id) {
    this.doc.views = this.doc.views.filter((v) => !ciEq(v.id, id));
    this.doc.viewMembers = this.doc.viewMembers.filter((vm) => !ciEq(vm.view, id));
  }

  /**
   * Rename a view's id/viewName (they're kept identical throughout this app) and
   * cascade the change to every viewMember.view, every viewMember.linkedViewName,
   * every open/closed tab's viewId, and currentView that referenced the old id.
   * Returns the final id actually used (deduplicated with a numeric suffix on conflict).
   */
  renameView(oldId, desiredNewId) {
    const view = this.findView(oldId);
    if (!view || ciEq(oldId, desiredNewId)) return oldId;
    let newId2 = desiredNewId;
    let n = 1;
    while (this.findView(newId2) && !ciEq(newId2, oldId)) { newId2 = `${desiredNewId} ${n}`; n += 1; }
    view.id = newId2;
    view.viewName = newId2;
    for (const vm of this.doc.viewMembers) {
      if (ciEq(vm.view, oldId)) vm.view = newId2;
      if (vm.linkedViewName && ciEq(vm.linkedViewName, oldId)) vm.linkedViewName = newId2;
    }
    for (const tab of this.tabs) { if (tab.type === 'canvas' && ciEq(tab.viewId, oldId)) { tab.viewId = newId2; tab.title = newId2; } }
    for (const tab of this.closedTabs) { if (tab.type === 'canvas' && ciEq(tab.viewId, oldId)) { tab.viewId = newId2; tab.title = newId2; } }
    if (ciEq(this.currentView, oldId)) this.currentView = newId2;
    return newId2;
  }

  // ===================== USER-REMEMBERED CONNECTOR DEFAULTS =====================
  /** The relationship name the user last explicitly chose for this (typeA,typeB) pair, if any. */
  getDefaultRelationship(typeA, typeB) {
    const list = this.doc.settingsUser?.relationshipPairs || [];
    const found = list.find((p) => ciEq(p.typeA, typeA) && ciEq(p.typeB, typeB));
    return found ? found.relationship : null;
  }
  /** Remember the user's explicit relationship choice for this (typeA,typeB) pair going forward. */
  setDefaultRelationship(typeA, typeB, relationship) {
    if (!this.doc.settingsUser) this.doc.settingsUser = { relationshipPairs: [] };
    const list = this.doc.settingsUser.relationshipPairs;
    const found = list.find((p) => ciEq(p.typeA, typeA) && ciEq(p.typeB, typeB));
    if (found) found.relationship = relationship;
    else list.push({ typeA, typeB, relationship });
  }

  // ===================== PARTS / CONNECTORS =====================
  findPart(id) { return this.doc.parts.find((p) => ciEq(p.id, id)); }
  findConnector(id) { return this.doc.connectors.find((c) => ciEq(c.id, id)); }
  /** Look up a connector by the unique (from,to,model,connectorType) combination, for
   * duplicate detection when creating a new connector. */
  findExistingConnector(from, to, model, connectorType) {
    return this.doc.connectors.find((c) => ciEq(c.from, from) && ciEq(c.to, to) && ciEq(c.model, model) && ciEq(c.connectorType, connectorType));
  }

  createPart({ type, label, model, streams = [], note = '', order = 0, other = {}, xIds = '', description = '', script = '', scriptEnabled = false, section = '' }) {
    const stamp = nowStamp();
    const part = { id: newId(), type, label: label ?? '', rawLabel: label ?? '', model, streams, note, order, other, xIds, description, script, scriptEnabled: !!scriptEnabled, section, createdAt: stamp, updatedAt: stamp };
    this.doc.parts.push(part);
    return part;
  }

  /** Marks a part as freshly modified — sets updatedAt to right now. Called from every
   * property-panel setter that actually mutates a part's own fields (not viewMember
   * fields, which have no createdAt/updatedAt of their own), so the timestamp reflects
   * genuine edits to the part itself, regardless of which view/panel made them. */
  touchPart(part) { if (part) part.updatedAt = nowStamp(); }
  /** Same as touchPart, for connectors. */
  touchConnector(conn) { if (conn) conn.updatedAt = nowStamp(); }

  createConnector({ from, to, model, connectorType = 'c', relationship = '', streams = [], note = '' }) {
    const style = (this.settings.relationshipStyles || []).find((s) => ciEq(s.code, relationCodeFor(relationship, this.settings)));
    const lineEnds = this.settings.lineEnds || {};
    const fromLE = lineEnds[style?.fromLineEndSettingType] || { path: '', stroke: 'black', strokeNormal: 'black', strokeWidth: 2, strokeWidthNormal: 2, fill: 'red' };
    const toLE = lineEnds[style?.toLineEndSettingType] || { path: '', stroke: 'black', strokeNormal: 'black', strokeWidth: 2, strokeWidthNormal: 2, fill: 'black' };
    const stamp = nowStamp();
    const connector = {
      id: newId(), from, to, model, streams, note,
      connectorType, relationship: style?.type || relationship,
      fromLineEndSettings: { ...fromLE },
      toLineEndSettings: { ...toLE },
      stroke: style?.stroke || '#333', strokeWidth: style?.strokeWidth ?? 2,
      strokeNormal: style?.stroke || '#333', strokeWidthNormal: style?.strokeWidth ?? 2,
      dash: style?.dash || [], fill: style?.fill || '#333',
      createdAt: stamp, updatedAt: stamp,
    };
    this.doc.connectors.push(connector);
    return connector;
  }

  deletePart(id) { this.doc.parts = this.doc.parts.filter((p) => !ciEq(p.id, id)); }
  deleteConnector(id) { this.doc.connectors = this.doc.connectors.filter((c) => !ciEq(c.id, id)); }
  /** Delete a connector and every viewMember (in any view) that displays it. */
  deleteConnectorAndMembers(id) {
    this.deleteConnector(id);
    this.doc.viewMembers = this.doc.viewMembers.filter((vm) => !(vm.objectType === 'connector' && ciEq(vm.objectId, id)));
  }
  /** Delete a view outright: removes any remaining viewMembers still pointing at it
   * (callers that already relocated them, e.g. a linked-view merge, pass an empty set
   * here), plus any open/closed tab showing it, so nothing dangles. */
  deleteView(id) {
    this.doc.views = this.doc.views.filter((v) => !ciEq(v.id, id));
    this.doc.viewMembers = this.doc.viewMembers.filter((vm) => !ciEq(vm.view, id));
    this.tabs = this.tabs.filter((t) => !(t.type === 'canvas' && ciEq(t.viewId, id)));
    this.closedTabs = this.closedTabs.filter((t) => !(t.type === 'canvas' && ciEq(t.viewId, id)));
  }

  // ===================== VIEW MEMBERS (nodes) =====================
  viewMembersForView(viewId) {
    return this.doc.viewMembers.filter((vm) => ciEq(vm.view, viewId));
  }

  /**
   * Given a desired top-left position, find the nearest position (same spot if already
   * free) whose node-sized bounding box doesn't overlap any existing node in the view.
   * Uses the view's current node size (defaults to 130x46 if not provided/redrawn).
   * Searches outward on a grid matching the node size + a small margin.
   *
   * `lookupCache` (optional, shape: { partVmsByView: Map<viewId, vm[]> } — see
   * createBulkLookupCache in commands.js) skips the O(current-viewMembers-count)
   * viewMembersForView() scan below in favor of an O(1) lookup into an already-indexed,
   * incrementally-maintained array. Without it (the default, for the many one-off
   * interactive callers of this method — dragging a single node, etc.), a single scan is
   * cheap and not worth the caller having to build/thread a cache for. WITH it, this
   * turns what was a confirmed real bottleneck for generateIndustry (this function is
   * called once per passive-node placement, once per stream job — re-scanning the WHOLE,
   * still-growing viewMembers array from scratch every single time, genuinely O(n²) —
   * into O(1) amortized per call. Found via a CPU profile after the earlier
   * createBulkLookupCache fix (which covers createStream's find-or-reuse lookups, not
   * this positioning call) turned out NOT to be the dominant cost it was assumed to be.
   */
  findNonOverlappingPosition(viewId, desiredX, desiredY, excludeVmId, nodeW = 130, nodeH = 46, spacingScale = 1, lookupCache = null) {
    const MARGIN = 8 * (spacingScale || 1);
    const stepX = nodeW + MARGIN, stepY = nodeH + MARGIN;
    let existing;
    if (lookupCache) {
      const cached = lookupCache.partVmsByView.get(viewId) || [];
      existing = excludeVmId ? cached.filter((vm) => vm.id !== excludeVmId) : cached;
    } else {
      existing = this.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part' && vm.id !== excludeVmId);
    }
    const overlaps = (x, y) => existing.some((vm) => Math.abs(vm.x - x) < nodeW + MARGIN / 2 && Math.abs(vm.y - y) < nodeH + MARGIN / 2);

    if (!overlaps(desiredX, desiredY)) return { x: desiredX, y: desiredY };
    for (let ring = 1; ring <= 60; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // ring boundary only
          const x = desiredX + dx * stepX, y = desiredY + dy * stepY;
          if (!overlaps(x, y)) return { x, y };
        }
      }
    }
    return { x: desiredX, y: desiredY }; // give up, better than nothing
  }

  /**
   * Change a view's spacingScale. Freeform views: bakes a one-time position transform,
   * scaling every node's position relative to the view's content centroid by the ratio
   * between the old and new scale (not a live per-render effect — subsequent drags,
   * Remap, etc. all just work with the already-transformed positions). Section-based
   * views: positions are computed from row/col via the grid math, which already reads
   * spacingScale live, so no position rewrite is needed here.
   */
  applySpacingScale(viewId, newScale) {
    const view = this.findView(viewId);
    if (!view) return;
    const oldScale = view.spacingScale || 1;
    const clamped = Math.max(0.25, Math.min(4, newScale || 1));
    if (ciEq(view.viewType, 'ff') && oldScale !== clamped) {
      const partVms = this.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part');
      if (partVms.length > 0) {
        const cx = partVms.reduce((s, vm) => s + vm.x, 0) / partVms.length;
        const cy = partVms.reduce((s, vm) => s + vm.y, 0) / partVms.length;
        const ratio = clamped / oldScale;
        // Compute the scaled positions FIRST, allowing negative values — clamping each
        // node individually to >=0 right here was a real bug: nodes near the left/top
        // edge would get clamped back to exactly 0 while everything else kept scaling
        // outward around the centroid, which visibly compressed the gap to their
        // nearest neighbor and made edge nodes look like they weren't moving at all.
        const scaled = partVms.map((vm) => ({
          vm,
          x: Math.round(cx + (vm.x - cx) * ratio),
          y: Math.round(cy + (vm.y - cy) * ratio),
        }));
        // THEN, if scaling pushed anything negative, shift the WHOLE layout by the same
        // amount so the minimum lands back at (0-ish). A uniform translation preserves
        // every pair's relative spacing exactly, unlike clamping each node on its own.
        const minX = Math.min(...scaled.map((p) => p.x));
        const minY = Math.min(...scaled.map((p) => p.y));
        const shiftX = minX < 0 ? -minX : 0;
        const shiftY = minY < 0 ? -minY : 0;
        for (const { vm, x, y } of scaled) {
          vm.x = x + shiftX;
          vm.y = y + shiftY;
        }
      }
    }
    view.spacingScale = clamped;
  }

  normalizeViewCoordinates(viewId) {
    const partVms = this.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part');
    if (partVms.length === 0) return;
    const minX = Math.min(...partVms.map((vm) => vm.x));
    const minY = Math.min(...partVms.map((vm) => vm.y));
    const shiftX = minX < 0 ? -minX : 0;
    const shiftY = minY < 0 ? -minY : 0;
    if (shiftX !== 0 || shiftY !== 0) {
      for (const vm of partVms) {
        vm.x += shiftX;
        vm.y += shiftY;
      }
    }
  }

  createViewMember({ view, objectType, objectId, x = 0, y = 0, fillColor = '#cccccc', fontColor = '', fontSize = '', borderColor = '', order = 0, note = '', linkedViewName = '', isExternal = false, sectionId = '', fromVmId, toVmId }) {
    const vm = { id: newId(), view, objectType, objectId, x, y, fillColor, fontColor, fontSize, borderColor, order, note, linkedViewName, isExternal: !!isExternal, sectionId };
    if (objectType === 'connector') { vm.fromVmId = fromVmId; vm.toVmId = toVmId; vm.x = null; vm.y = null; }
    this.doc.viewMembers.push(vm);
    return vm;
  }

  // Deleting a node deletes only the viewMember, never the underlying Part/Connector.
  deleteViewMember(id) {
    this.doc.viewMembers = this.doc.viewMembers.filter((vm) => !ciEq(vm.id, id));
  }
  findViewMember(id) { return this.doc.viewMembers.find((vm) => ciEq(vm.id, id)); }

  // ===================== TABS / PAGES =====================
  createTab({ type = 'canvas', title, viewId } = {}) {
    const tab = {
      id: newId(),
      type,
      title: title || viewId || 'Untitled',
      viewId: type === 'canvas' ? viewId : null,
      history: { past: [], present: this.snapshot(), future: [] },
      viewport: { x: 0, y: 0, zoom: 1 },
      selection: new Set(),
      activeStreams: [],
      // null = no filter configured yet (show everything) — distinct from an explicit
      // empty array [], which (after the type filter's "exclude all" is used) means
      // "show nothing". Kept separate from activeStreams' own empty-means-unfiltered
      // convention since that filter has no "exclude all" concept to support.
      activeElementTypes: null,
      // "Connector levels" (numeric, null = unlimited/"All") — only takes effect while
      // a stream or type filter is actively narrowing the view; controls how many hops
      // of connector+node expansion to reveal beyond the directly-matching nodes.
      // Defaults to 0 (no expansion) so introducing this control doesn't silently
      // change the existing filter behavior for anyone already using it.
      connectorLevels: 0,
      selectedSectionId: null,
    };
    this.tabs.push(tab);
    return tab;
  }

  findTabByView(viewId) { return this.tabs.find((t) => t.type === 'canvas' && ciEq(t.viewId, viewId)); }
  activeTab() { return this.tabs.find((t) => t.id === this.activeTabId); }

  closeTab(tabId) {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const [tab] = this.tabs.splice(idx, 1);
    this.closedTabs.push(tab);
    if (this.closedTabs.length > 20) this.closedTabs.shift();
    if (this.activeTabId === tabId) {
      const fallback = this.tabs[idx] || this.tabs[idx - 1] || this.tabs[0];
      this.activeTabId = fallback ? fallback.id : null;
      if (fallback && fallback.type === 'canvas') this.currentView = fallback.viewId;
      else this.currentView = null;
    }
  }

  restoreTab(tabId) {
    const idx = this.closedTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return null;
    const [tab] = this.closedTabs.splice(idx, 1);
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    return tab;
  }

  // ===================== HISTORY (undo/redo) — full-doc snapshots per tab =====================
  snapshot() {
    return JSON.parse(JSON.stringify({ parts: this.doc.parts, connectors: this.doc.connectors, viewMembers: this.doc.viewMembers, views: this.doc.views }));
  }
  restoreSnapshot(snap) {
    this.doc.parts = snap.parts;
    this.doc.connectors = snap.connectors;
    this.doc.viewMembers = snap.viewMembers;
    this.doc.views = snap.views;
  }

  recordHistory(tab) {
    if (!tab) return;
    this.dirty = true;
    tab.history.past.push(tab.history.present);
    if (tab.history.past.length > 100) tab.history.past.shift();
    tab.history.present = this.snapshot();
    tab.history.future = [];
  }

  undo(tab) {
    if (!tab || tab.history.past.length === 0) return false;
    tab.history.future.unshift(tab.history.present);
    tab.history.present = tab.history.past.pop();
    this.restoreSnapshot(JSON.parse(JSON.stringify(tab.history.present)));
    return true;
  }

  redo(tab) {
    if (!tab || tab.history.future.length === 0) return false;
    tab.history.past.push(tab.history.present);
    tab.history.present = tab.history.future.shift();
    this.restoreSnapshot(JSON.parse(JSON.stringify(tab.history.present)));
    return true;
  }

  // ===================== SAVE / LOAD =====================
  toJSON() {
    return JSON.parse(JSON.stringify(this.doc));
  }

  loadFromJSON(obj) {
    const migrated = migrateDoc(obj);
    this.doc = migrated;
    // A freshly loaded model's parts/connectors are unrelated to whatever was simulated
    // before — stop any active runs and clear all runtime state, rather than risk stale
    // entries pointing at ids that no longer exist (or, worse, silently matching
    // different parts that happen to reuse the same id in the new file).
    for (const entry of this.simRunning.values()) {
      if (entry.timerId) clearTimeout(entry.timerId);
    }
    this.simRunning.clear();
    this.simRuntime.clear();
    this.simLog.clear();
    this.simSelectedModel = this.doc.defaultModel;
  }
}

/** Migrate an older/foreign save file: fill in missing fields with documented defaults. */
function migrateDoc(obj) {
  const doc = {
    version: obj.version || '0.2',
    readme: obj.readme || { note: '' },
    defaultModel: obj.defaultModel || (obj.models?.[0]?.modelName ?? 'Reference'),
    currentView: obj.currentView || 'home',
    models: obj.models && obj.models.length ? obj.models : [{ modelName: 'Reference' }],
    views: obj.views && obj.views.length ? obj.views.map((v) => ({ ...v, viewType: v.viewType || 'ff', sections: v.sections ?? [], nodeWidth: v.nodeWidth ?? 130, nodeHeight: v.nodeHeight ?? 46, remapSortKeys: v.remapSortKeys ?? null, chkShowConnectorType: v.chkShowConnectorType ?? (v.chkShowConnectors ?? true), chkShowStreamType: v.chkShowStreamType ?? (v.chkShowConnectors ?? true), chkShowDescription: v.chkShowDescription ?? true, chkShowSimValues: v.chkShowSimValues ?? false, chkShowScriptBadge: v.chkShowScriptBadge ?? false, routingStyle: v.routingStyle ?? 'default', routingStyleStream: v.routingStyleStream ?? 'default', spacingScale: v.spacingScale ?? 1 })) : [{ id: 'home', viewName: 'home', viewType: 'ff', chkShowConnectorType: true, chkShowStreamType: false, chkShowKeys: false, chkShowElementTypes: true, chkShowDescription: true, chkShowOnPageCatalogs: false, chkShowSimValues: false, chkShowScriptBadge: false, routingStyle: 'default', routingStyleStream: 'default', margin: 50, sections: [], nodeWidth: 130, nodeHeight: 46, remapSortKeys: null, spacingScale: 1 }],
    parts: (obj.parts || []).map((p) => ({
      id: p.id, type: p.type, label: p.label ?? p.id, rawLabel: p.rawLabel ?? p.label ?? p.id,
      model: p.model ?? (obj.defaultModel || 'Reference'),
      streams: p.streams ?? [],
      note: p.note ?? '',
      order: p.order ?? 0,
      other: p.other ?? {},
      xIds: p.xIds ?? '',
      description: p.description ?? '',
      script: p.script ?? '',
      scriptEnabled: p.scriptEnabled === true || p.scriptEnabled === 'true',
      section: p.section ?? '',
      createdAt: p.createdAt ?? '', updatedAt: p.updatedAt ?? '',
    })),
    connectors: (obj.connectors || []).map((c) => ({
      id: c.id, from: c.from, to: c.to,
      model: c.model ?? (obj.defaultModel || 'Reference'),
      streams: c.streams ?? [],
      fromLineEndSettings: c.fromLineEndSettings ?? { path: '', stroke: 'black', strokeNormal: 'black', strokeWidth: 2, strokeWidthNormal: 2, fill: 'red' },
      toLineEndSettings: c.toLineEndSettings ?? { path: '', stroke: 'black', strokeNormal: 'black', strokeWidth: 2, strokeWidthNormal: 2, fill: 'black' },
      note: c.note ?? '',
      connectorType: c.connectorType ?? 'c',
      relationship: c.relationship ?? '',
      stroke: c.stroke ?? '#333', strokeWidth: c.strokeWidth ?? 2,
      strokeNormal: c.strokeNormal ?? c.stroke ?? '#333', strokeWidthNormal: c.strokeWidthNormal ?? c.strokeWidth ?? 2,
      dash: c.dash ?? [], fill: c.fill ?? '#333',
      createdAt: c.createdAt ?? '', updatedAt: c.updatedAt ?? '',
    })),
    viewMembers: (obj.viewMembers || []).map((vm) => ({
      id: vm.id, view: vm.view ?? (obj.currentView || 'home'),
      objectType: vm.objectType, objectId: vm.objectId,
      x: vm.x ?? 0, y: vm.y ?? 0,
      fillColor: vm.fillColor ?? '#cccccc',
      fontColor: vm.fontColor ?? '',
      fontSize: vm.fontSize ?? '',
      borderColor: vm.borderColor ?? '',
      order: vm.order ?? 0,
      note: vm.note ?? '',
      linkedViewName: vm.linkedViewName ?? '',
      isExternal: vm.isExternal === true || vm.isExternal === 'true',
      sectionId: vm.sectionId ?? '',
      fromVmId: vm.fromVmId, toVmId: vm.toVmId,
    })),
    settingsUser: obj.settingsUser ?? { relationshipPairs: [] },
  };
  return doc;
}

function relationCodeFor(relationshipTypeOrCode, settings) {
  const rel = (settings.relations || []).find((r) => ciEq(r.name, relationshipTypeOrCode) || ciEq(r.key, relationshipTypeOrCode));
  return rel ? rel.key : relationshipTypeOrCode;
}

export { Store, newId, ciEq, migrateDoc, relationCodeFor, nowStamp };
