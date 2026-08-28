// render.js — header, toolbox, properties panel rendering (canvas rendering lives in canvas.js)
import { ciEq, newId } from './state.js';
import { getAllowedTypesForView, isSectionViewType, rescaleSectionPositions } from './sections.js';
import { redrawAndResolveLayout } from './canvas.js';
import { validRelationOptions } from './rules.js';

function groupFill(app, el) {
  const group = (app.store.settings.elementGroups || []).find((g) => ciEq(g.group, el?.group));
  return group?.fill || '#cccccc';
}

/** The element's own path glyph, filled with its elementGroups color, black stroke. Natural coordinate space is ~40x20. */
function iconSvgFor(app, el) {
  const fill = groupFill(app, el);
  if (el && el.path) {
    return `<svg viewBox="0 0 40 20" class="el-icon-img"><path d="${el.path}" stroke="black" stroke-width="1.5" fill="${fill}" /></svg>`;
  }
  const r = Math.min(el?.cornerRadius ?? 6, 8);
  return `<svg viewBox="0 0 40 20" class="el-icon-img"><rect x="4" y="1" width="32" height="18" rx="${r}" stroke="black" stroke-width="1.5" fill="${fill}" /></svg>`;
}

function kindFromType(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('process')) return 'process';
  if (t.includes('capability')) return 'capability';
  return 'function';
}

// ===================== TABS =====================
function renderTabs(app) {
  const { store } = app;
  const list = document.getElementById('tabs-list');
  list.innerHTML = '';
  for (const tab of store.tabs) {
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.id === store.activeTabId ? ' active' : '');
    el.dataset.tabId = tab.id;
    const icon = { canvas: '▦', pdf: '📄', text: '📝', table: '▤' }[tab.type] || '▦';
    el.innerHTML = `<span class="tab-icon">${icon}</span><span class="tab-name" spellcheck="false">${escapeHtml(tab.title)}</span><button class="tab-close" title="Close">×</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      app.switchToTab(tab.id);
    });
    const nameEl = el.querySelector('.tab-name');
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      nameEl.contentEditable = 'true';
      nameEl.focus();
      document.execCommand('selectAll', false, null);
    });
    nameEl.addEventListener('blur', () => {
      nameEl.contentEditable = 'false';
      const newTitle = nameEl.textContent.trim() || tab.title;
      tab.title = newTitle;
      if (tab.type === 'canvas') {
        const view = store.findView(tab.viewId);
        if (view) view.viewName = newTitle;
        app.recordAndRender();
      } else {
        app.render();
      }
    });
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { nameEl.textContent = tab.title; nameEl.blur(); }
    });
    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      app.closeTab(tab.id);
    });
    list.appendChild(el);
  }

  // restore-closed dropdown
  const menu = document.getElementById('restore-closed-menu');
  menu.innerHTML = '';
  if (store.closedTabs.length === 0) {
    menu.innerHTML = '<div class="dd-empty">No closed pages</div>';
  } else {
    for (const t of [...store.closedTabs].reverse()) {
      const item = document.createElement('div');
      item.className = 'dd-item';
      item.textContent = t.title;
      item.addEventListener('click', () => { app.restoreTab(t.id); menu.classList.add('hidden'); });
      menu.appendChild(item);
    }
  }
}

/** True when a canvas tab currently has a node, connector, or section selected —
 * "a specific canvas object is being edited right now" as opposed to the view itself.
 * Shared by the Filters panel's own visibility (renderToolbar, below) and its nested
 * view-display sub-panel (renderViewDisplayFilters, below) so the two conditions can
 * never drift apart — see both functions' own doc comments for why this exists.
 * Always false for a non-canvas tab (selection/selectedSectionId are canvas-only
 * concepts; a 3D tab's own part selection, tab.selectedCatalogRow, is deliberately NOT
 * included here — see renderToolbar's comment for why). */
function canvasHasObjectSelected(tab) {
  return !!(tab && tab.type === 'canvas' && (tab.selection.size > 0 || tab.selectedSectionId));
}

// ===================== TOOLBAR =====================
function renderToolbar(app) {
  const { store } = app;
  const tab = store.activeTab();

  const modelSel = document.getElementById('model-select');
  modelSel.innerHTML = store.doc.models.map((m) => `<option value="${escapeHtml(m.modelName)}">${escapeHtml(m.modelName)}</option>`).join('');
  modelSel.value = store.defaultModel;

  const viewSel = document.getElementById('view-select');
  viewSel.innerHTML = store.doc.views.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.viewName)}</option>`).join('');
  viewSel.value = store.currentView || '';

  const is3D = !!(tab && tab.type === '3d');

  // View Scope (3D-only): narrows the 3D scene down to exactly what one specific 2D
  // view has placed (its own part AND connector viewMembers), instead of the whole
  // document — distinct from "Current View" above, which is a navigation control (it
  // switches tabs), not a data filter. Default '' (mapped to null on tab) = unscoped,
  // today's whole-document behavior.
  const scopeSel = document.getElementById('view3d-scope-select');
  const viewOptionsSig = store.doc.views.map((v) => v.id).join(',');
  if (scopeSel.dataset.optionsSig !== viewOptionsSig) {
    scopeSel.innerHTML = ['<option value="">All (whole document)</option>', ...store.doc.views.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.viewName)}</option>`)].join('');
    scopeSel.dataset.optionsSig = viewOptionsSig;
  }
  const scopeValue = (is3D && tab.view3DScopeViewId && store.findView(tab.view3DScopeViewId)) ? tab.view3DScopeViewId : '';
  if (scopeSel.value !== scopeValue) scopeSel.value = scopeValue;
  scopeSel.disabled = !is3D;
  document.getElementById('view3d-scope-group').classList.toggle('hidden', !is3D);

  // Stream/Type/Section filters apply to canvas AND 3d tabs (3d reads store.doc.parts
  // directly, not any one view's viewMembers, but the same tab.activeStreams/
  // activeElementTypes/activeSections fields already exist on every tab type — see the
  // filter-menu click handlers below for the two tab types' different available-options
  // sourcing). Connector Levels stays canvas-only below — it expands via THIS view's own
  // viewMember-connectors, a concept the 3D scene (parts/connectors directly) doesn't
  // share the same way.
  const filtersApply = !!(tab && (tab.type === 'canvas' || tab.type === '3d'));

  const streamBtn = document.getElementById('stream-filter-btn');
  const rawActiveStreams = filtersApply ? tab.activeStreams : null;
  if (rawActiveStreams == null) {
    streamBtn.textContent = 'All streams';
  } else if (rawActiveStreams.length === 0) {
    streamBtn.textContent = 'No streams'; // explicit "exclude all"
  } else if (rawActiveStreams.length === 1) {
    streamBtn.textContent = rawActiveStreams[0];
  } else {
    streamBtn.textContent = `${rawActiveStreams.length} streams`;
  }
  streamBtn.disabled = !filtersApply;
  document.getElementById('stream-filter-group').classList.toggle('hidden', !filtersApply);

  const typeBtn = document.getElementById('element-type-filter-btn');
  const rawActiveTypes = filtersApply ? tab.activeElementTypes : null;
  if (rawActiveTypes == null) {
    typeBtn.textContent = 'All types';
  } else if (rawActiveTypes.length === 0) {
    typeBtn.textContent = 'No types'; // explicit "exclude all"
  } else if (rawActiveTypes.length === 1) {
    const elDef = (app.store.settings.elements || []).find((e) => e.type === rawActiveTypes[0]);
    typeBtn.textContent = elDef ? elDef.title : rawActiveTypes[0];
  } else {
    typeBtn.textContent = `${rawActiveTypes.length} types`;
  }
  typeBtn.disabled = !filtersApply;
  document.getElementById('element-type-filter-group').classList.toggle('hidden', !filtersApply);

  const sectionBtn = document.getElementById('section-filter-btn');
  const rawActiveSections = filtersApply ? tab.activeSections : null;
  if (rawActiveSections == null) {
    sectionBtn.textContent = 'All sections';
  } else if (rawActiveSections.length === 0) {
    sectionBtn.textContent = 'No sections'; // explicit "exclude all"
  } else if (rawActiveSections.length === 1) {
    sectionBtn.textContent = rawActiveSections[0] || '(no section)';
  } else {
    sectionBtn.textContent = `${rawActiveSections.length} sections`;
  }
  sectionBtn.disabled = !filtersApply;
  document.getElementById('section-filter-group').classList.toggle('hidden', !filtersApply);

  // Connector Type is 3D-only (the 2D canvas already has this per-VIEW, via
  // view.chkShowConnectorType/chkShowStreamType — this is the 3D-only, tab-scoped
  // counterpart, since a 3D tab isn't backed by any one view).
  const connTypeBtn = document.getElementById('connector-type-filter-btn');
  const rawActiveConnTypes = is3D ? tab.activeConnectorTypes : null;
  if (rawActiveConnTypes == null) {
    connTypeBtn.textContent = 'All (c + s)';
  } else if (rawActiveConnTypes.length === 0) {
    connTypeBtn.textContent = 'None';
  } else if (rawActiveConnTypes.length === 1) {
    connTypeBtn.textContent = rawActiveConnTypes[0] === 'c' ? 'Connectors (c)' : 'Streams (s)';
  } else {
    connTypeBtn.textContent = 'All (c + s)';
  }
  connTypeBtn.disabled = !is3D;
  document.getElementById('connector-type-filter-group').classList.toggle('hidden', !is3D);

  // Layer Order (3D-only): which streamTemplate's value[] decides element-group/type
  // ordering in the 3D scene (view3d.js's resolveLayerOrder) — independent of
  // Remap/Generate Stream's own shared "last used" template preference, since ordering
  // the 3D scene is an unrelated concern from which template to generate FROM. Reads
  // its own cache entry directly (same key/shape as main.js's getCachedView3DLayerOrderTemplate
  // — duplicated in miniature rather than importing main.js here, which sits at the TOP
  // of this app's dependency graph; see view3d.js's preferredStreamTemplateName for the
  // same precedent).
  const layerOrderSelect = document.getElementById('view3d-layer-order-select');
  const templateNames = (store.settings.streamTemplates || []).map((t) => t.name);
  const cachedLayerOrder = (() => {
    try {
      const cached = JSON.parse(localStorage.getItem('dycad-local-settings-cache') || '{}');
      return typeof cached.view3DLayerOrderTemplate === 'string' && cached.view3DLayerOrderTemplate ? cached.view3DLayerOrderTemplate : null;
    } catch { return null; }
  })();
  const layerOrderValue = (cachedLayerOrder && templateNames.includes(cachedLayerOrder)) ? cachedLayerOrder : (templateNames.includes('All') ? 'All' : templateNames[0]);
  if (layerOrderSelect.dataset.optionsSig !== templateNames.join(',')) {
    layerOrderSelect.innerHTML = templateNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    layerOrderSelect.dataset.optionsSig = templateNames.join(',');
  }
  if (layerOrderSelect.value !== layerOrderValue) layerOrderSelect.value = layerOrderValue;
  layerOrderSelect.disabled = !is3D;
  document.getElementById('view3d-layer-order-group').classList.toggle('hidden', !is3D);

  // Highlight (3D-only): plain array, no null-vs-[] convention (see state.js's
  // createTab comment) — [] always means "nothing highlighted", not "unfiltered".
  const highlightBtn = document.getElementById('highlight-type-filter-btn');
  const rawHighlighted = is3D ? (tab.highlightedTypes || []) : [];
  if (rawHighlighted.length === 0) {
    highlightBtn.textContent = 'None';
  } else if (rawHighlighted.length === 1) {
    const elDef = (store.settings.elements || []).find((e) => e.type === rawHighlighted[0]);
    highlightBtn.textContent = elDef ? elDef.title : rawHighlighted[0];
  } else {
    highlightBtn.textContent = `${rawHighlighted.length} types`;
  }
  highlightBtn.disabled = !is3D;
  document.getElementById('highlight-type-filter-group').classList.toggle('hidden', !is3D);

  const levelsInput = document.getElementById('connector-levels-input');
  if (document.activeElement !== levelsInput) { // don't clobber the value while the user is actively typing in it
    const rawLevels = tab && tab.type === 'canvas' ? tab.connectorLevels : 0;
    levelsInput.value = rawLevels == null ? '' : String(rawLevels);
  }
  const levelsApply = !!(tab && tab.type === 'canvas');
  levelsInput.disabled = !levelsApply;
  document.getElementById('connector-levels-group').classList.toggle('hidden', !levelsApply);

  document.getElementById('undo-btn').disabled = !tab || tab.history.past.length === 0;
  document.getElementById('redo-btn').disabled = !tab || tab.history.future.length === 0;

  // Reported directly: "add a new collapsable group called Filters... Move the
  // existing filters... to this new filter group for each view type that they apply
  // to." The 8 individual filter groups above (now living in the right column's
  // Filters panel, index.html — same ids, so every getElementById/classList.toggle
  // above keeps working unchanged regardless of where the element actually lives)
  // already hide themselves per tab type; when NONE of them apply (e.g. a table/pdf/
  // docs/text tab), hide the whole Filters panel section too, rather than leaving an
  // empty "Filters ▾" header with nothing under it.
  const filterGroupIds = ['view3d-scope-group', 'stream-filter-group', 'element-type-filter-group', 'section-filter-group', 'connector-type-filter-group', 'view3d-layer-order-group', 'highlight-type-filter-group', 'connector-levels-group'];
  const anyFilterApplies = filterGroupIds.some((id) => !document.getElementById(id).classList.contains('hidden'));
  // Direct follow-up, once the two panels had visibly collided: "the 'FILTERS'
  // property panel still shows when user clicks on a view freeform node; as it is not
  // specific to the selected node it should not be appearing. Filter section in
  // property panel should only appear when view is clicked in canvas not on a node,
  // connector, or section or other canvas object." The whole Filters panel (all 8
  // tab-scoped controls, not just the nested view-display sub-panel — see
  // renderViewDisplayFilters below, which already had its OWN narrower fix) now hides
  // for a canvas tab the instant anything on it is selected — canvasHasObjectSelected,
  // above, shared with renderViewDisplayFilters so the two conditions can't drift.
  // Scoped to canvas tabs only: a 3D tab has no per-object Properties panel competing
  // for the same space the way a canvas node/connector/section does, and hiding
  // Filters there would fight deselectAndShowViewFilters's own established "empty
  // click brings the Filters panel up" flow (view3d.js), which this report didn't ask
  // to change.
  const filtersSection = document.querySelector('.panel-section[data-panel-id="filters"]');
  if (filtersSection) filtersSection.classList.toggle('hidden', !anyFilterApplies || canvasHasObjectSelected(tab));
}

// ===================== TOOLBOX =====================
function renderLibraryFilters(app) {
  const wrap = document.getElementById('lib-filters');
  wrap.innerHTML = '';
  const libs = ['TOGAF', 'ArchiMate', 'Other'];
  const codeMap = { TOGAF: 't', BPMN: 'b', ArchiMate: 'a', Other: 'o' };
  for (const lib of libs) {
    const chip = document.createElement('div');
    chip.className = 'lib-chip' + (app.store.activeLibraries.has(lib) ? ' active' : '');
    chip.textContent = lib;
    chip.addEventListener('click', () => {
      if (app.store.activeLibraries.has(lib)) app.store.activeLibraries.delete(lib);
      else app.store.activeLibraries.add(lib);
      app.render();
    });
    wrap.appendChild(chip);
  }
}

/** Dynamic per-elementGroup toolkit filter chips — one per group actually defined in
 * store.settings.elementGroups (not a fixed list, since groups come from custom.json
 * and can vary). Lazily defaults to "everything on" the first time this runs, same
 * on/off-by-default convention as the sources chips above. Styled as light-blue
 * "group-chip"s (a distinct look from the source chips above them) via a second CSS
 * class rather than a source-vs-group difference in the underlying markup. */
function renderGroupFilters(app) {
  const wrap = document.getElementById('group-filters');
  if (!wrap) return;
  const groups = (app.store.settings.elementGroups || []).map((g) => g.group);
  if (!app.store.activeElementGroups) app.store.activeElementGroups = new Set(groups);
  wrap.innerHTML = '';
  for (const group of groups) {
    const chip = document.createElement('div');
    chip.className = 'lib-chip group-chip' + (app.store.activeElementGroups.has(group) ? ' active' : '');
    chip.textContent = group;
    chip.title = `Show/hide ${group} elements in the toolkit`;
    chip.addEventListener('click', () => {
      if (app.store.activeElementGroups.has(group)) app.store.activeElementGroups.delete(group);
      else app.store.activeElementGroups.add(group);
      app.render();
    });
    wrap.appendChild(chip);
  }
}

/** Drag a toolkit tile onto the active canvas to create a new part there. Deliberately a
 * custom pointer-event drag (pointerdown/pointermove/pointerup on `document`, same
 * pattern node-dragging/connect-drag/resize handles already use throughout this app)
 * rather than native HTML5 drag-and-drop (dragstart/dragover/drop) — the app's ONLY
 * prior use of native DnD. Reported directly: "drag from toolkit to freeform canvas
 * does not allow drop, mouse cursor stuck on hand symbol" — native HTML5 DnD's cursor
 * feedback and drop delivery are notoriously OS/compositor-dependent (a known failure
 * mode on Linux/GTK-based browsers in particular), so this switches the interaction to
 * the same reliable, self-contained mechanism already proven for every other
 * click-and-drag gesture in the app, rather than trying to patch native DnD's own
 * cross-platform quirks. */
function wireToolboxTileDrag(app, tile, el) {
  tile.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    let ghost = null;
    const prevCursor = document.body.style.cursor;

    const positionGhost = (clientX, clientY) => {
      if (ghost) { ghost.style.left = `${clientX + 12}px`; ghost.style.top = `${clientY + 12}px`; }
    };
    const onMove = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
        dragging = true;
        document.body.style.cursor = 'grabbing';
        ghost = document.createElement('div');
        ghost.className = 'toolbox-drag-ghost';
        ghost.textContent = el.title;
        document.body.appendChild(ghost);
      }
      positionGhost(ev.clientX, ev.clientY);
    };
    const onUp = (ev) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.cursor = prevCursor;
      if (ghost) ghost.remove();
      if (!dragging) return;

      const dropTab = app.store.activeTab();
      if (!dropTab || dropTab.type !== 'canvas') return;
      const scroll = document.querySelector('.page-view.active .canvas-scroll');
      if (!scroll) return;
      const rect = scroll.getBoundingClientRect();
      if (ev.clientX < rect.left || ev.clientX > rect.right || ev.clientY < rect.top || ev.clientY > rect.bottom) return;
      const z = dropTab.viewport?.zoom || 1;
      const x = (ev.clientX - rect.left + scroll.scrollLeft) / z;
      const y = (ev.clientY - rect.top + scroll.scrollTop) / z;
      app.dropNewPart(dropTab, el.type, x, y);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

function renderToolbox(app) {
  renderLibraryFilters(app);
  renderGroupFilters(app);
  const grid = document.getElementById('elements-grid');
  grid.innerHTML = '';
  const groupOrder = (app.store.settings.elementGroups || []).map((g) => g.group);
  const groupIndex = (group) => {
    const idx = groupOrder.findIndex((g) => ciEq(g, group));
    return idx === -1 ? groupOrder.length : idx;
  };
  const tab = app.store.activeTab();
  const activeView = tab && tab.type === 'canvas' ? app.store.findView(tab.viewId) : null;
  const allowedTypes = activeView ? getAllowedTypesForView(activeView) : null;

  const els = [...(app.store.settings.elements || [])].sort((a, b) => {
    const gi = groupIndex(a.group) - groupIndex(b.group);
    if (gi !== 0) return gi;
    return (a.tkDisplayOrder ?? 999) - (b.tkDisplayOrder ?? 999);
  });
  const codeMap = { t: 'TOGAF', a: 'ArchiMate', o: 'Other', b: 'BPMN' };
  const seen = new Set();
  for (const el of els) {
    if (allowedTypes && !allowedTypes.has(String(el.type).toLowerCase())) continue;
    if (app.store.activeElementGroups && !app.store.activeElementGroups.has(el.group)) continue;
    const srcCodes = String(el.sources || '').split('');
    const matches = srcCodes.some((c) => app.store.activeLibraries.has(codeMap[c] || 'Other')) || srcCodes.length === 0;
    if (!matches) continue;
    const kind = kindFromType(el.type);
    const dedupKey = `${kind}+${el.title}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const tile = document.createElement('div');
    tile.className = 'el-tile';
    tile.title = el.title;
    tile.innerHTML = iconSvgFor(app, el);
    wireToolboxTileDrag(app, tile, el);
    grid.appendChild(tile);
  }
}

// ===================== SELECTION / COMMANDS =====================
function describeSelection(app) {
  const tab = app.store.activeTab();
  if (!tab || tab.type !== 'canvas' || tab.selection.size === 0) return 'Nothing selected';
  const vms = [...tab.selection].map((id) => app.store.findViewMember(id)).filter(Boolean);
  if (vms.length === 1) {
    const vm = vms[0];
    if (vm.objectType === 'part') {
      const part = app.store.findPart(vm.objectId);
      return `1 node — ${part ? part.type : '?'} "${part ? part.label : vm.id}"`;
    }
    return `1 connector selected`;
  }
  return `${vms.length} items selected`;
}

function renderSelectionInfo(app) {
  const countEl = document.getElementById('selection-info');
  countEl.textContent = describeSelection(app);

  const listEl = document.getElementById('selection-list');
  listEl.innerHTML = '';
  const ROW_H = 24; // px, approx height of one .selection-list li including gap
  const tab = app.store.activeTab();
  if (!tab || tab.type !== 'canvas' || tab.selection.size === 0) return;

  const vms = [...tab.selection].map((id) => app.store.findViewMember(id)).filter(Boolean);
  listEl.style.maxHeight = `${Math.min(vms.length, 100) * ROW_H}px`;

  for (const vm of vms) {
    const li = document.createElement('li');
    if (vm.objectType === 'part') {
      const part = app.store.findPart(vm.objectId);
      li.textContent = part ? `${part.label} (${part.type})` : vm.id;
    } else {
      const conn = app.store.findConnector(vm.objectId);
      const fromPart = conn && app.store.findPart(conn.from);
      const toPart = conn && app.store.findPart(conn.to);
      li.textContent = conn
        ? `${conn.relationship || 'connector'}: ${fromPart?.label ?? conn.from} → ${toPart?.label ?? conn.to}`
        : vm.id;
      li.classList.add('selection-list-edge');
    }
    li.title = li.textContent;
    li.addEventListener('click', () => { app.selectOnly(vm.id); });
    listEl.appendChild(li);
  }
}

/** Left-panel "Message Log": scripts write to it via ctx.log(...) during a simulation
 * tick (see simulation.js). Read-only textarea, most recent message first, each line
 * prefixed with an HH:MM:SS timestamp. */
function formatLogTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderMessageLog(app) {
  const el = document.getElementById('message-log');
  if (!el) return;
  const entries = app.store.messageLog || [];
  el.value = entries
    .slice()
    .reverse()
    .map((e) => `[${formatLogTimestamp(e.ts)}] ${e.message}`)
    .join('\n');
}

const CMD_ICONS = {
  duplicateStream: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="10" height="10" rx="1.5"/><path d="M7 6V4.5A1.5 1.5 0 0 1 8.5 3H16a1.5 1.5 0 0 1 1.5 1.5V13a1.5 1.5 0 0 1-1.5 1.5H15"/></svg>',
  splitNode: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="10" r="2"/><circle cx="16" cy="4" r="2"/><circle cx="16" cy="16" r="2"/><path d="M6 10h2a2 2 0 0 1 2-2l4-2M8 10a2 2 0 0 1 2 2l4 2"/></svg>',
  levelUp: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="14" height="6" rx="1"/><path d="M10 9V2M6 5l4-4 4 4"/></svg>',
  levelDown: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="6" rx="1"/><path d="M10 11v7M6 15l4 4 4-4"/></svg>',
  levelIt: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="16" r="2"/><circle cx="16" cy="4" r="2"/><path d="M6 16h5a3 3 0 0 0 3-3V6"/></svg>',
  generate: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v3M10 15v3M2 10h3M15 10h3M4.5 4.5l2 2M13.5 13.5l2 2M4.5 15.5l2-2M13.5 6.5l2-2"/><circle cx="10" cy="10" r="2.2"/></svg>',
  copy: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7"/></svg>',
  paste: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="10" height="14" rx="1.5"/><path d="M8 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1"/><path d="M8 10h4M8 13h4"/></svg>',
  remap: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="6" height="6" rx="1"/><rect x="12" y="2" width="6" height="6" rx="1"/><rect x="2" y="12" width="6" height="6" rx="1"/><rect x="12" y="12" width="6" height="6" rx="1"/><path d="M9 5h2M5 9v2M15 9v2M9 15h2"/></svg>',
  merge: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.5"/><circle cx="15" cy="6" r="2.5"/><path d="M5 8.5v2a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3v-2"/><circle cx="10" cy="16" r="2.2"/></svg>',
  redraw: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="14" height="9" rx="1.5"/><path d="M14 2.5l2 2-2 2M16 4.5H10"/></svg>',
  addExisting: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="10" height="12" rx="1.5"/><path d="M5.5 7.5h4M5.5 10.5h4M5.5 13.5h2.5"/><circle cx="15.5" cy="14.5" r="3.2"/><path d="M15.5 13v3M14 14.5h3"/></svg>',
  populateFromTemplate: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="6" height="6" rx="1"/><rect x="11.5" y="2.5" width="6" height="6" rx="1"/><rect x="2.5" y="11.5" width="6" height="6" rx="1"/><path d="M14.5 12v6M11.5 15h6"/></svg>',
  insertSmartStream: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="3.5" cy="10" r="2"/><circle cx="10" cy="4.5" r="2"/><circle cx="10" cy="15.5" r="2"/><circle cx="16.5" cy="10" r="2"/><path d="M5.3 8.9L8.2 6M5.3 11.1L8.2 14M11.8 5.6L14.7 8.9M11.8 14.4L14.7 11.1"/></svg>',
  smartCheckNode: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="10" height="8" rx="1.5"/><circle cx="15.5" cy="14.5" r="3.2"/><path d="M14 14.5l1 1 2-2"/></svg>',
};

function getCommandDefs(app) {
  const tab = app.store.activeTab();
  const isCanvas = !!(tab && tab.type === 'canvas');
  const selCount = isCanvas ? tab.selection.size : 0;
  const singleVm = selCount === 1 ? app.store.findViewMember([...tab.selection][0]) : null;
  const singlePart = singleVm && singleVm.objectType === 'part' ? app.store.findPart(singleVm.objectId) : null;
  const hasNodeSelection = isCanvas && [...tab.selection].some((id) => app.store.findViewMember(id)?.objectType === 'part');
  const nodeSelectionCount = isCanvas ? [...tab.selection].filter((id) => app.store.findViewMember(id)?.objectType === 'part').length : 0;
  const view = isCanvas ? app.store.findView(tab.viewId) : null;
  const isFreeformCanvas = isCanvas && view && !isSectionViewType(view.viewType);

  return [
    { key: 'duplicateStream', label: 'Duplicate Stream', hint: 'Duplicate Stream — clone a stream to a new name', enabled: !!singlePart && (singlePart.streams || []).length > 0 },
    { key: 'splitNode', label: 'Split Node', hint: 'Split Node — create a sibling, rewire outgoing edges', enabled: !!singlePart },
    { key: 'levelUp', label: 'Level Up', hint: (singlePart && ciEq(singlePart.type, 'DataEntityDetails')) ? 'Level Up — create (or open) this table\'s Data Entity parent' : 'Level Up — open a new parent view containing this view\'s nodes', enabled: isCanvas },
    { key: 'levelDown', label: 'Level Down', hint: 'Level Down — push 2+ selected nodes into a sub-view', enabled: selCount >= 2 },
    { key: 'levelIt', label: 'Level It', hint: 'Level It — replace this node with the correct stream-template type where it directly connects across a gap (freeform views only)', enabled: isFreeformCanvas && !!singlePart },
    { key: 'generate', label: 'Generate Stream', hint: 'Generate Stream — build a stream from a template', enabled: isCanvas },
    { key: 'copy', label: 'Copy', hint: 'Copy — copy the selected nodes', enabled: hasNodeSelection },
    { key: 'paste', label: 'Paste', hint: 'Paste — paste copied nodes into this view', enabled: isCanvas && !!app.clipboard },
    { key: 'remap', label: 'Remap', hint: 'Remap — reorganize this view by stream template', enabled: isCanvas },
    { key: 'merge', label: 'Merge', hint: 'Merge — combine 2+ selected nodes into one', enabled: nodeSelectionCount >= 2 },
    { key: 'redraw', label: 'Redraw', hint: 'Redraw — recalculate best node size and normalize coordinates for this view', enabled: isCanvas },
    { key: 'addExisting', label: 'Add Existing', hint: 'Add Existing — bring existing parts (and optionally their connectors) into this view', enabled: isCanvas },
    { key: 'populateFromTemplate', label: 'Populate From Template', hint: 'Populate From Template — add parts/connectors from a page template matching this view type', enabled: isCanvas },
    { key: 'insertSmartStream', label: 'Insert Smart Stream', hint: 'Insert Smart Stream — trace a chain of parts/connectors by element type into this view', enabled: isCanvas },
    { key: 'smartCheckNode', label: 'Smart Check Node', hint: 'Smart Check Node — repair gaps reachable from this one node', enabled: !!singlePart },
  ];
}

function renderCommands(app) {
  const wrap = document.getElementById('commands-list');
  wrap.innerHTML = '';
  const defs = getCommandDefs(app);
  for (const d of defs) {
    const btn = document.createElement('button');
    btn.className = 'cmd-icon-btn';
    btn.disabled = !d.enabled;
    btn.title = d.hint;
    btn.innerHTML = CMD_ICONS[d.key];
    btn.addEventListener('click', () => app.runCommand(d.key));
    wrap.appendChild(btn);
  }
}

// ===================== PROPERTIES PANEL =====================
function renderProperties(app) {
  const body = document.getElementById('properties-body');
  const tab = app.store.activeTab();
  if (tab && tab.selectedCatalogRow && (tab.type === '3d' || (tab.type === 'table' && tab.catalogType))) {
    renderCatalogRowProperties(app, tab);
    return;
  }
  // Reported directly: "clicking on empty in the canvas will bring up this view
  // filters and any view properties specific to 3D View." A 3D tab has no single
  // backing `view` object of its own (unlike a 2D canvas tab, below) — its only real
  // "view properties" are the tab-scoped filters (View Scope, Stream, Types, Section,
  // Connector Type, Layer Order, Highlight), all of which now live in the Filters
  // panel (view3d.js's deselectAndShowViewFilters already expands/scrolls it into
  // view on empty-canvas click) — so this just points there instead of showing the
  // generic, canvas-flavored "Select a node or edge" hint below.
  if (tab && tab.type === '3d') {
    body.innerHTML = '<div class="empty-hint">3D View — no part selected.<br>View-level filters (Stream, Types, Section, Connector Type, View Scope, Layer Order, Highlight) are in the <strong>Filters</strong> panel above.</div>';
    return;
  }
  if (!tab || tab.type !== 'canvas') {
    body.innerHTML = '<div class="empty-hint">Select a node or edge to edit its properties.</div>';
    return;
  }
  if (tab.selectedSectionId) {
    renderSectionProperties(app, tab);
    return;
  }
  if (tab.selection.size === 0) {
    renderViewProperties(app, tab);
    return;
  }
  if (tab.selection.size !== 1) {
    renderMultiSelectProperties(app, tab);
    return;
  }
  const vm = app.store.findViewMember([...tab.selection][0]);
  if (!vm) { body.innerHTML = '<div class="empty-hint">Select a node or edge to edit its properties.</div>'; return; }

  if (vm.objectType === 'part') {
    renderPartProperties(app, vm);
  } else {
    renderConnectorProperties(app, vm);
  }
}

// ===================== GENERIC showFields-DRIVEN PROPERTY PANEL =====================
// Field-name -> button click handler, for show:'b' fields (addSection/removeSection).
function buttonHandlersFor(app, tab, entityKey, ctx) {
  if (entityKey === 'section') {
    return {
      addSection: () => app.insertSection(tab, ctx.section.id),
      removeSection: () => app.removeSection(tab, ctx.section.id),
      duplicateSection: () => app.duplicateSection(tab, ctx.section.id),
    };
  }
  return {};
}

// Field-name -> <option> list, for show:'s' (selector) fields.
function selectOptionsFor(app, entityKey, fieldName, currentValue, ctx) {
  if (entityKey === 'view' && (fieldName === 'routingStyle' || fieldName === 'routingStyleStream')) {
    const options = [
      { value: 'default', label: 'Default (curve/straight)' },
      { value: 'straight', label: 'Straight line' },
      { value: 'direct', label: 'Direct (obstacle-avoiding)' },
      { value: 'manhattan', label: 'Manhattan (obstacle-avoiding, right angles)' },
    ];
    return options.map((o) => `<option value="${o.value}" ${o.value === currentValue ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  }
  if (entityKey === 'view' && fieldName === 'spacingAxis') {
    const options = [
      { value: 'both', label: 'Both' },
      { value: 'horizontal', label: 'Horizontal only' },
      { value: 'vertical', label: 'Vertical only' },
    ];
    return options.map((o) => `<option value="${o.value}" ${o.value === currentValue ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  }
  if ((entityKey === 'part' || entityKey === 'viewMember') && fieldName === 'type') {
    return [...(app.store.settings.elements || [])]
      .sort((a, b) => (a.tkDisplayOrder ?? 999) - (b.tkDisplayOrder ?? 999))
      .map((el) => `<option value="${escapeHtml(el.type)}" ${ciEq(el.type, currentValue) ? 'selected' : ''}>${escapeHtml(el.title)} (${escapeHtml(el.type)})</option>`).join('');
  }
  if ((entityKey === 'part' || entityKey === 'viewMember') && fieldName === 'model') {
    return (app.store.doc.models || []).map((m) => `<option value="${escapeHtml(m.modelName)}" ${ciEq(m.modelName, currentValue) ? 'selected' : ''}>${escapeHtml(m.modelName)}</option>`).join('');
  }
  if (entityKey === 'connector' && fieldName === 'connectorType') {
    const options = [
      { value: 'c', label: 'Connector (c)' },
      { value: 's', label: 'Stream (s)' },
      { value: 'd', label: 'Data (d)' },
    ];
    return options.map((o) => `<option value="${o.value}" ${o.value === currentValue ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  }
  if (entityKey === 'connector' && fieldName === 'relationship') {
    const currentKey = relationKeyForConnector(app, { relationship: currentValue });
    // limit to relations allowed for this connector's actual (fromType, toType) pair
    let allowed = null;
    if (ctx?.fromType && ctx?.toType) {
      allowed = validRelationOptions(app.store, ctx.fromType, ctx.toType).map((o) => o.key);
    }
    const relations = app.store.settings.relations || [];
    const options = allowed ? relations.filter((r) => allowed.includes(r.key)) : relations;
    // always include the current value even if it wouldn't otherwise be offered, so an
    // existing (possibly no-longer-valid) choice doesn't silently vanish from the list
    const list = options.some((r) => r.key === currentKey) || !currentKey ? options : [...options, relations.find((r) => r.key === currentKey)].filter(Boolean);
    return list.map((r) => `<option value="${r.key}" ${r.key === currentKey ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
  }
  // 'd' (data/ERD) connectors' From/To Attribute: options are whichever attributes
  // exist on THAT END's own table (a "depends on another field's current value" select
  // — the from/to Part ids come through via ctx.fromPartId/toPartId, set alongside
  // fromType/toType wherever a connector's ctx is built). A table with no attributes
  // (or a non-'d' connector, whose ends aren't DataEntityDetails tables at all) falls
  // through to the generic single-current-value option below.
  if (entityKey === 'connector' && (fieldName === 'fromAttribute' || fieldName === 'toAttribute')) {
    const partId = fieldName === 'fromAttribute' ? ctx?.fromPartId : ctx?.toPartId;
    const part = partId ? app.store.findPart(partId) : null;
    const attrs = part?.attributes || [];
    const blank = `<option value="" ${!currentValue ? 'selected' : ''}>(none)</option>`;
    if (attrs.length) {
      return blank + attrs.map((a) => `<option value="${escapeHtml(a.id)}" ${a.id === currentValue ? 'selected' : ''}>${escapeHtml(a.name || '(unnamed)')}</option>`).join('');
    }
    return `<option value="" selected>(no attributes on this table)</option>`;
  }
  if (entityKey === 'connector' && (fieldName === 'fromCardinality' || fieldName === 'toCardinality')) {
    const options = [
      { value: '', label: '(none)' },
      { value: 'one', label: 'One (1)' },
      { value: 'many', label: 'Many (N)' },
      { value: 'zeroOrOne', label: 'Zero or one (0..1)' },
      { value: 'oneOrMany', label: 'One or many (1..N)' },
    ];
    return options.map((o) => `<option value="${o.value}" ${o.value === (currentValue || '') ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  }
  return `<option value="${escapeHtml(currentValue ?? '')}">${escapeHtml(currentValue ?? '')}</option>`;
}

// ===================== PINNED FIELDS =====================
// Cross-document, cross-model UI preference (like the theme or the Root Properties
// collapse state) — deliberately stored in localStorage, not settings.showFields or
// store.doc, so pinning a field is a per-browser habit, not something that round-trips
// through Save/Load JSON or varies per view/model. Three independent groups:
//   'node'      — Part fields, wherever a node's combined viewMember+part panel shows
//                 (canvas selection AND the ViewMembers catalog's part rows, since both
//                 render through renderPartProperties).
//   'connector' — Connector fields, same deal via renderConnectorProperties.
//   'table'     — the three catalog-row-only panels that show a single entity with no
//                 viewMember context: the Parts, Connectors, and Views catalog tabs.
const PINNED_FIELDS_KEY = 'dycad-pinned-fields';
const DEFAULT_PINNED_FIELDS = ['view', 'type', 'label', 'model', 'streams'];

function getPinnedFields(group) {
  try {
    const all = JSON.parse(localStorage.getItem(PINNED_FIELDS_KEY) || '{}');
    return Array.isArray(all[group]) ? all[group] : [...DEFAULT_PINNED_FIELDS];
  } catch {
    return [...DEFAULT_PINNED_FIELDS];
  }
}

function setPinnedFields(group, fields) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(PINNED_FIELDS_KEY) || '{}'); } catch { /* start fresh */ }
  all[group] = fields;
  localStorage.setItem(PINNED_FIELDS_KEY, JSON.stringify(all));
}

function isFieldPinned(group, fieldName) {
  return getPinnedFields(group).includes(fieldName);
}

function togglePinnedField(group, fieldName) {
  const fields = getPinnedFields(group);
  const idx = fields.indexOf(fieldName);
  if (idx === -1) fields.push(fieldName); else fields.splice(idx, 1);
  setPinnedFields(group, fields);
}

/** Whole-config read/write, used by File > Save/Load Local Settings so pin choices can
 * travel with a person between browsers/machines instead of being stuck in one browser's
 * localStorage. Always returns/accepts all three groups, backfilling any missing one with
 * the documented defaults, so a save always produces a complete file and a load from a
 * partial/malformed one still leaves every group in a valid state. */
function getAllPinnedFields() {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(PINNED_FIELDS_KEY) || '{}'); } catch { /* ignore */ }
  return {
    node: Array.isArray(all.node) ? all.node : [...DEFAULT_PINNED_FIELDS],
    connector: Array.isArray(all.connector) ? all.connector : [...DEFAULT_PINNED_FIELDS],
    table: Array.isArray(all.table) ? all.table : [...DEFAULT_PINNED_FIELDS],
  };
}

function setAllPinnedFields(config) {
  setPinnedFields('node', Array.isArray(config?.node) ? config.node : [...DEFAULT_PINNED_FIELDS]);
  setPinnedFields('connector', Array.isArray(config?.connector) ? config.connector : [...DEFAULT_PINNED_FIELDS]);
  setPinnedFields('table', Array.isArray(config?.table) ? config.table : [...DEFAULT_PINNED_FIELDS]);
}

// ===================== RESIZABLE TEXTAREA HEIGHTS =====================
// Same "cross-document, cross-model UI preference, a per-browser habit not document
// data" reasoning as PINNED_FIELDS above — reported directly: "when property
// resizable text fields are lengthened by user (lower right corner dragged) can that
// be persisted for the user for that property in any view for current session and
// future sessions. currently the resize is lost when user clicks away from the
// node." Keyed by field NAME alone (not entity-qualified) — "for that property in
// any view" reads as one shared height per field, e.g. Note ends up the same whether
// it's a Part's, Connector's, or ViewMember's (all three are labeled "Note" and use
// the same textarea), which is simpler and more useful than a finer per-entity-type
// split nobody asked for.
const FIELD_HEIGHTS_KEY = 'dycad-field-heights';

function getFieldHeight(fieldName) {
  try {
    const all = JSON.parse(localStorage.getItem(FIELD_HEIGHTS_KEY) || '{}');
    const px = Number(all[fieldName]);
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch {
    return null;
  }
}

function setFieldHeight(fieldName, px) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(FIELD_HEIGHTS_KEY) || '{}'); } catch { /* start fresh */ }
  all[fieldName] = Math.round(px);
  localStorage.setItem(FIELD_HEIGHTS_KEY, JSON.stringify(all));
}

/** Whole-config read/write, used by File > Save/Load Local Settings — same "travels
 * with a person between browsers/machines" precedent as getAllPinnedFields/
 * setAllPinnedFields above. */
function getAllFieldHeights() {
  try {
    const all = JSON.parse(localStorage.getItem(FIELD_HEIGHTS_KEY) || '{}');
    return (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
  } catch {
    return {};
  }
}

function setAllFieldHeights(config) {
  localStorage.setItem(FIELD_HEIGHTS_KEY, JSON.stringify((config && typeof config === 'object' && !Array.isArray(config)) ? config : {}));
}

/** The persisted height for `fieldName` (getFieldHeight, above) as an inline style
 * attribute string — empty if none saved yet, so a fresh field still falls back to
 * its normal CSS min-height. Shared by every textarea-rendering call site so a
 * field's remembered height stays identical everywhere it's edited. */
function fieldHeightStyle(fieldName) {
  const px = getFieldHeight(fieldName);
  return px ? ` style="height:${px}px;"` : '';
}

/** Wires a ResizeObserver onto a rendered textarea so a user's own drag-resize (the
 * native CSS `resize: vertical` handle, bottom-right corner) is genuinely persisted
 * per fieldName instead of lost the moment this panel next re-renders (every commit
 * calls app.recordAndRender(), which rebuilds the whole panel from scratch — reported
 * directly: "currently the resize is lost when user clicks away from the node").
 * Call once per textarea, right after it's actually in the DOM. A fresh
 * ResizeObserver + textarea element is created on every re-render; nothing else
 * references the old ones once replaced, so both become garbage-collectable together
 * with no explicit teardown needed — EXCEPT that a removed-from-DOM (or hidden)
 * element fires one final callback reporting a 0x0 content rect first (confirmed via
 * real testing: switching away from this node, which rebuilds #properties-body and
 * detaches the old textarea, was persisting a bogus 0px height for every field, not
 * just the one actually resized) — guarded against below, not just the redundant
 * "first callback reports the current size" case. */
function wireFieldHeightPersistence(el, fieldName) {
  if (!el || typeof ResizeObserver === 'undefined') return;
  let lastHeight = el.getBoundingClientRect().height;
  const ro = new ResizeObserver(() => {
    const h = el.getBoundingClientRect().height;
    if (h <= 0) return; // element was removed/hidden, not resized by the user
    if (Math.abs(h - lastHeight) < 1) return; // ResizeObserver's own first callback just reports the current size -- not a real user resize
    lastHeight = h;
    setFieldHeight(fieldName, h);
  });
  ro.observe(el);
}

/** Builds and appends the "Pinned" section above a property panel's normal content —
 * one field row per pinned name that actually exists in one of `sources` (in pin order),
 * reusing renderShowFieldsPanel's own per-field rendering/wiring so pinned fields stay
 * fully live (editable, same dbl-click-to-expand, same pin-toggle button) rather than a
 * separate read-only summary. Pinned fields are ADDED at the top, not moved — they still
 * render in their normal spot below too, same as a pinned Slack message stays in the
 * channel. `sources` is [{ entityKey, accessors, ctx? }, ...]; the first source (in
 * array order) that defines a given pinned field name wins if more than one does. */
function renderPinnedSection(app, tab, pinGroup, sources, body) {
  const pinnedNames = getPinnedFields(pinGroup);
  if (!pinnedNames.length) return;

  const mergedSpec = {};
  const mergedAccessors = {};
  let mergedCtx = {};
  for (const name of pinnedNames) {
    for (const src of sources) {
      const spec = app.store.settings.showFields?.[src.entityKey]?.fields || {};
      if (spec[name] && src.accessors[name]) {
        mergedSpec[name] = { ...spec[name], __sourceEntityKey: src.entityKey };
        mergedAccessors[name] = src.accessors[name];
        if (src.ctx) mergedCtx = { ...mergedCtx, ...src.ctx };
        break;
      }
    }
  }
  if (!Object.keys(mergedAccessors).length) return;

  const wrap = document.createElement('div');
  wrap.className = 'panel-section pinned-section';
  wrap.innerHTML = `<h3 class="panel-title">📌 Pinned</h3><div class="panel-body"></div>`;
  body.appendChild(wrap);
  renderShowFieldsPanel(app, tab, mergedSpec, mergedAccessors, {}, wrap.querySelector('.panel-body'), mergedCtx, { pinGroup, idNamespace: `pinned-${pinGroup}` });
}

/**
 * Renders a properties panel driven entirely by settings.showFields[entityKey].fields.
 * Two independent axes per field: `show` = widget type ('y' checkbox, 'n' numeric,
 * 'c' color, 't' text, 'm' multiline, 's' selector, 'b' button, 'h' hidden, 'a'
 * editable attribute list — see renderAttributeListField below), `access` =
 * 'r' readonly / 'w' editable. `access:'r'` always renders plain readonly text regardless
 * of `show` (a readonly selector has nothing to select). `accessors` maps field name ->
 * { get(), set(value) }; fields listed in showFields with no matching accessor are
 * skipped, so this stays safe even if the data file lists a field this view doesn't have.
 * `entityKeyOrSpec` is normally the settings.showFields key (a string); a caller that has
 * already assembled a merged multi-entity spec object (renderPinnedSection) may pass that
 * object directly instead — `options.idNamespace` is then required, since there's no
 * single entity-key string to derive DOM ids from. `options.pinGroup`, if set, adds a 📌
 * toggle button next to each field's label (skipped for button-type fields).
 */
/** Formats a field value for display as plain text — arrays join with ", ", booleans
 * become "true"/"false", plain objects (e.g. a connector's fromLineEndSettings, a
 * part's `other`) get JSON.stringify'd rather than rendering as the useless
 * "[object Object]" a bare String() coercion would otherwise produce. */
function formatFieldValue(val) {
  if (Array.isArray(val)) return val.join(', ');
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (val !== null && typeof val === 'object') { try { return JSON.stringify(val); } catch { return String(val); } }
  return String(val ?? '');
}

/** Is `attrId` (a DataEntityDetails attribute's id) a foreign key? Deliberately NOT a
 * stored field on the attribute itself (there is no `isForeignKey` key anywhere in the
 * data model — setting one by hand does nothing, since nothing ever reads it) —
 * computed live here instead, so it can never drift out of sync with the actual
 * crow's-foot connectors that are the real source of truth for what references what
 * (the same "connectors are the source of truth" principle Composition/mirrorOf
 * already follow elsewhere in this codebase). Shared by the property panel's
 * attribute table (below) and the canvas node's own attribute-list rendering
 * (canvas.js's buildNodeEl), so both agree.
 *
 * Deliberately checks BOTH ends of a 'd' connector, not just `fromAttribute` — this
 * app has THREE independent 'd' connector creation paths, and they don't agree on
 * which end (`fromAttribute` or `toAttribute`) holds the actual foreign-key column:
 * DDL import (`importDDL`, commands.js) sets `fromAttribute` to the child/referencing
 * table's own FK column (matching a `FOREIGN KEY (col)` clause) and `toAttribute` to
 * the parent's referenced column; manual drag-to-connect and the Autofill script
 * (`finishConnect`, main.js; `dataAutoFill`, state.js) do the OPPOSITE on purpose, per
 * a direct report: "auto create a fk in target of primary key from source... This is
 * reverse of current logic which flagged the parent as having fk" — `fromAttribute`
 * is the SOURCE's own primary key, `toAttribute` is the newly-created FK column on
 * the target. A single hardcoded "`fromAttribute` is always the FK" check (the
 * original implementation) is only ever right for one of these two conventions —
 * confirmed as a real bug: attributes created by dataAutoFill/drag-to-connect never
 * showed the FK badge, no matter what. Instead: whichever end of the pair references
 * an attribute that IS flagged `isPrimaryKey` is the "referenced" side, and the OTHER
 * end is the actual foreign key — this holds regardless of which literal field
 * (`fromAttribute`/`toAttribute`) each convention happens to store which role in. */
function isAttributeForeignKey(store, attrId) {
  const attrOf = (partId, id) => {
    const part = store.findPart(partId);
    return part && (part.attributes || []).find((a) => a.id === id);
  };
  return store.doc.connectors.some((c) => {
    if (c.connectorType !== 'd' || !c.fromAttribute || !c.toAttribute) return false;
    if (c.fromAttribute === attrId) return !!attrOf(c.to, c.toAttribute)?.isPrimaryKey;
    if (c.toAttribute === attrId) return !!attrOf(c.from, c.fromAttribute)?.isPrimaryKey;
    return false;
  });
}

/** Fixed data-type choices offered in the attribute table's Data Type dropdown. Kept
 * intentionally coarse (not real SQL types) since this is the modeling-level type, not
 * a DDL dialect's concrete column type — DDL import still needs to land arbitrary
 * concrete types (e.g. "VARCHAR(100)"), which is why renderAttributeListField below
 * always injects the attribute's current value as an extra selected option when it
 * doesn't match one of these, instead of silently clobbering it. */
const ATTRIBUTE_DATA_TYPES = ['numeric', 'string', 'boolean', 'date', 'blob', 'json'];

/** Builds the HTML for an `'a'` (attribute list) field — used by the Data Modeling
 * feature's `DataEntityDetails` element type (public/custom.json's
 * showFields.part.fields.attributes), an editable table of {id, name, dataType,
 * nullable, isPrimaryKey} rows. Shown as a read-only "FK" badge per row (see
 * isAttributeForeignKey above), not an editable checkbox. */
function renderAttributeListField(app, id, attributes) {
  const rows = attributes.map((attr, idx) => {
    const currentNotListed = attr.dataType && !ATTRIBUTE_DATA_TYPES.includes(attr.dataType);
    const dtOptions = (currentNotListed ? `<option value="${escapeHtml(attr.dataType)}" selected>${escapeHtml(attr.dataType)}</option>` : '')
      + ATTRIBUTE_DATA_TYPES.map((t) => `<option value="${t}" ${attr.dataType === t ? 'selected' : ''}>${t}</option>`).join('');
    return `
    <tr data-attr-id="${escapeHtml(attr.id)}">
      <td><input type="text" class="attr-name" value="${escapeHtml(attr.name || '')}" placeholder="name" /></td>
      <td><select class="attr-datatype">${dtOptions}</select></td>
      <td class="attr-check-cell"><input type="checkbox" class="attr-nullable" ${attr.nullable ? 'checked' : ''} title="Nullable" /></td>
      <td class="attr-check-cell"><input type="checkbox" class="attr-pk" ${attr.isPrimaryKey ? 'checked' : ''} title="Primary Key" /></td>
      <td class="attr-check-cell">${isAttributeForeignKey(app.store, attr.id) ? '<span class="attr-fk-badge" title="Referenced by a Data connector">FK</span>' : ''}</td>
      <td class="attr-check-cell">
        <button type="button" class="attr-move-up-btn" data-attr-id="${escapeHtml(attr.id)}" title="Move up" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="attr-move-down-btn" data-attr-id="${escapeHtml(attr.id)}" title="Move down" ${idx === attributes.length - 1 ? 'disabled' : ''}>▼</button>
      </td>
      <td><button type="button" class="attr-delete-btn" data-attr-id="${escapeHtml(attr.id)}" title="Delete attribute">✕</button></td>
    </tr>`;
  }).join('');
  return `
    <div class="attr-list-container" id="${id}">
      <table class="attr-table">
        <thead><tr><th>Name</th><th>Data Type</th><th>Null</th><th>PK</th><th>FK</th><th>Move</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="empty-hint">No attributes yet.</td></tr>'}</tbody>
      </table>
      <button type="button" class="attr-add-btn" data-attr-add="1">+ Add Attribute</button>
    </div>`;
}

/** Re-locates and focuses one cell of the attribute table by (containerId, attrId,
 * field) after the table's own DOM has potentially just been rebuilt (see the Tab-key
 * handling in renderShowFieldsPanel below for why a rebuild can happen mid-navigation).
 * field === 'add' focuses the "+ Add Attribute" button instead of a row cell. */
function focusAttrField(containerId, attrId, field) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (field === 'add') { container.querySelector('[data-attr-add]')?.focus(); return; }
  const selector = { name: '.attr-name', datatype: '.attr-datatype', nullable: '.attr-nullable', pk: '.attr-pk' }[field];
  if (!selector) return;
  container.querySelector(`tr[data-attr-id="${attrId}"] ${selector}`)?.focus();
}

function renderShowFieldsPanel(app, tab, entityKeyOrSpec, accessors, buttonHandlers, container, ctx, options = {}) {
  const isMergedSpec = typeof entityKeyOrSpec === 'object' && entityKeyOrSpec !== null;
  const spec = isMergedSpec ? entityKeyOrSpec : (app.store.settings.showFields?.[entityKeyOrSpec]?.fields || {});
  const idNs = options.idNamespace || (isMergedSpec ? 'custom' : entityKeyOrSpec);
  const pinGroup = options.pinGroup;
  const html = [];
  for (const [fieldName, def] of Object.entries(spec)) {
    if (def.show === 'h') continue;
    const acc = accessors[fieldName];
    if (!acc) continue;
    const label = def.label || fieldName;
    const id = `sf-${idNs}-${fieldName}`;
    const val = acc.get();
    const sourceEntityKey = def.__sourceEntityKey || entityKeyOrSpec;
    const pinBtn = (pinGroup && def.show !== 'b')
      ? `<button type="button" class="field-pin-btn${isFieldPinned(pinGroup, fieldName) ? ' pinned' : ''}" data-pin-field="${fieldName}" title="${isFieldPinned(pinGroup, fieldName) ? 'Unpin from top' : 'Pin to top'}">📌</button>`
      : '';

    if (def.show === 'b') {
      html.push(`<div class="modal-actions" style="justify-content:flex-start;"><button class="primary" id="${id}">${escapeHtml(label)}</button></div>`);
      continue;
    }
    if (def.access === 'r') {
      html.push(row(label, `<input type="text" id="${id}" value="${escapeHtml(formatFieldValue(val))}" readonly />`, fieldName, pinBtn, id));
      continue;
    }
    // access === 'w'
    if (def.show === 'y') {
      html.push(`<div class="prop-row checkbox">${pinBtn}<input type="checkbox" id="${id}" ${val ? 'checked' : ''} /><label for="${id}">${escapeHtml(label)}</label></div>`);
    } else if (def.show === 'n') {
      html.push(row(label, `<input type="number" id="${id}" value="${val ?? 0}" />`, fieldName, pinBtn, id));
    } else if (def.show === 'c') {
      html.push(row(label, `<input type="color" id="${id}" value="${toHexColor(val)}" />`, fieldName, pinBtn, id));
    } else if (def.show === 'm') {
      html.push(row(label, `<textarea id="${id}"${fieldHeightStyle(fieldName)}>${escapeHtml(val ?? '')}</textarea>`, fieldName, pinBtn, id));
    } else if (def.show === 's') {
      html.push(row(label, `<select id="${id}">${selectOptionsFor(app, sourceEntityKey, fieldName, val, ctx)}</select>`, fieldName, pinBtn, id));
    } else if (def.show === 'a') {
      html.push(`<div class="prop-row attr-list-row">${pinBtn}<label data-field="${fieldName}">${escapeHtml(label)}</label>${renderAttributeListField(app, id, val || [])}</div>`);
    } else { // 't' or unrecognized -> plain text
      html.push(row(label, `<input type="text" id="${id}" value="${escapeHtml(formatFieldValue(val))}" />`, fieldName, pinBtn, id));
    }
  }
  container.innerHTML = html.join('') || '<div class="empty-hint">No fields configured.</div>';

  for (const [fieldName, def] of Object.entries(spec)) {
    if (def.show === 'h') continue;
    const acc = accessors[fieldName];
    if (!acc) continue;
    const label = def.label || fieldName;

    // Step 33: double-click a field's label to open it in the larger generic text-edit
    // modal — any text-type field, readonly display or writable, but not checkboxes or
    // buttons (those aren't text), and not an 'a' attribute list (it's a whole table,
    // not a single text value — it gets its own add/edit/delete wiring below instead).
    if (def.show !== 'b' && def.show !== 'y' && def.show !== 'a') {
      const labelEl = container.querySelector(`label[data-field="${fieldName}"]`);
      if (labelEl) {
        labelEl.classList.add('dbl-edit-label');
        labelEl.title = 'Double-click to open in a larger editor';
        labelEl.addEventListener('dblclick', () => {
          app.promptTextEdit({
            title: label, value: acc.get(), readonly: def.access === 'r',
            onSave: (v) => { acc.set(v); app.recordAndRender(); },
          });
        });
      }
    }

    if (pinGroup && def.show !== 'b') {
      const pinBtnEl = container.querySelector(`[data-pin-field="${fieldName}"]`);
      if (pinBtnEl) {
        pinBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          togglePinnedField(pinGroup, fieldName);
          app.render();
        });
      }
    }

    if (def.show === 'a') {
      if (def.access !== 'r') {
        const listEl = document.getElementById(`sf-${idNs}-${fieldName}`);
        if (listEl) {
          const commit = (newAttrs) => { acc.set(newAttrs); app.recordAndRender(); };
          listEl.querySelector('[data-attr-add]')?.addEventListener('click', () => {
            commit([...(acc.get() || []), { id: newId(), name: '', dataType: '', nullable: false, isPrimaryKey: false }]);
          });
          listEl.querySelectorAll('.attr-delete-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
              commit((acc.get() || []).filter((a) => a.id !== btn.dataset.attrId));
            });
          });
          listEl.querySelectorAll('.attr-move-up-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
              const attrs = [...(acc.get() || [])];
              const i = attrs.findIndex((a) => a.id === btn.dataset.attrId);
              if (i > 0) { [attrs[i - 1], attrs[i]] = [attrs[i], attrs[i - 1]]; commit(attrs); }
            });
          });
          listEl.querySelectorAll('.attr-move-down-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
              const attrs = [...(acc.get() || [])];
              const i = attrs.findIndex((a) => a.id === btn.dataset.attrId);
              if (i >= 0 && i < attrs.length - 1) { [attrs[i + 1], attrs[i]] = [attrs[i], attrs[i + 1]]; commit(attrs); }
            });
          });
          listEl.querySelectorAll('tr[data-attr-id]').forEach((tr) => {
            const attrId = tr.dataset.attrId;
            const updateField = (field, value) => {
              commit((acc.get() || []).map((a) => (a.id === attrId ? { ...a, [field]: value } : a)));
            };
            const nameEl = tr.querySelector('.attr-name');
            const dtEl = tr.querySelector('.attr-datatype');
            const nullEl = tr.querySelector('.attr-nullable');
            const pkEl = tr.querySelector('.attr-pk');
            nameEl?.addEventListener('change', (e) => updateField('name', e.target.value));
            dtEl?.addEventListener('change', (e) => updateField('dataType', e.target.value));
            nullEl?.addEventListener('change', (e) => updateField('nullable', e.target.checked));
            pkEl?.addEventListener('change', (e) => updateField('isPrimaryKey', e.target.checked));

            // Tab-key navigation across name -> data type -> nullable -> PK -> next row's
            // name (or the Add Attribute button after the last row). A plain 'change'
            // listener plus native Tab isn't enough here: committing a field's edit calls
            // app.recordAndRender(), which rebuilds this whole table's DOM, so the native
            // tab-order target (resolved against the OLD DOM before the rebuild) no longer
            // exists by the time focus would land — focus falls back to <body> instead of
            // the next field. Reported directly: "when keying in data entity details
            // attributes, tab should take user to next field." Fix: preventDefault, commit
            // the field ourselves (deterministic, not dependent on native blur/change
            // timing), then explicitly re-locate and focus the next field in whatever DOM
            // exists afterward (rebuilt or not).
            const focusNext = (field) => {
              const order = ['name', 'datatype', 'nullable', 'pk'];
              const pos = order.indexOf(field);
              if (pos < order.length - 1) { focusAttrField(listEl.id, attrId, order[pos + 1]); return; }
              const attrs = acc.get() || [];
              const idx = attrs.findIndex((a) => a.id === attrId);
              if (idx >= 0 && idx + 1 < attrs.length) focusAttrField(listEl.id, attrs[idx + 1].id, 'name');
              else focusAttrField(listEl.id, null, 'add');
            };
            nameEl?.addEventListener('keydown', (e) => {
              if (e.key !== 'Tab' || e.shiftKey) return;
              e.preventDefault();
              updateField('name', nameEl.value);
              focusNext('name');
            });
            dtEl?.addEventListener('keydown', (e) => {
              if (e.key !== 'Tab' || e.shiftKey) return;
              e.preventDefault();
              updateField('dataType', dtEl.value);
              focusNext('datatype');
            });
            nullEl?.addEventListener('keydown', (e) => {
              if (e.key !== 'Tab' || e.shiftKey) return;
              e.preventDefault();
              focusNext('nullable');
            });
            pkEl?.addEventListener('keydown', (e) => {
              if (e.key !== 'Tab' || e.shiftKey) return;
              e.preventDefault();
              focusNext('pk');
            });
          });
        }
      }
      continue;
    }

    if (def.access === 'r') continue; // nothing else to wire for readonly fields
    const el = document.getElementById(`sf-${idNs}-${fieldName}`);
    if (!el) continue;
    if (def.show === 'm') wireFieldHeightPersistence(el, fieldName);
    if (def.show === 'b') {
      if (buttonHandlers[fieldName]) el.addEventListener('click', () => buttonHandlers[fieldName]());
      continue;
    }
    el.addEventListener('change', (e) => {
      const v = el.type === 'checkbox' ? el.checked : e.target.value;
      acc.set(v);
      app.recordAndRender();
    });
    // Script fields are code, not prose — Tab should indent, not jump focus away.
    if (fieldName === 'script' && el.tagName === 'TEXTAREA') {
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const start = el.selectionStart, end = el.selectionEnd;
        el.value = el.value.slice(0, start) + '  ' + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + 2;
      });
    }
  }
}

function renderSectionProperties(app, tab) {
  const body = document.getElementById('properties-body');
  const view = app.store.findView(tab.viewId);
  const section = view?.sections?.find((s) => s.id === tab.selectedSectionId);
  if (!view || !section) { body.innerHTML = '<div class="empty-hint">Section not found.</div>'; return; }

  const accessors = {
    viewType: { get: () => section.viewType, set: () => {} },
    sectionId: { get: () => section.sectionId, set: () => {} },
    order: { get: () => section.order, set: (v) => { section.order = Number(v) || 0; } },
    name: { get: () => section.name, set: (v) => { section.name = v; } },
    rowCount: {
      get: () => section.rowCount,
      set: (v) => {
        const oldRowCount = section.rowCount;
        section.rowCount = Math.max(1, Number(v) || 1);
        if (section.rowCount !== oldRowCount) {
          const oldSections = view.sections.map((s) => (s === section ? { ...s, rowCount: oldRowCount } : s));
          rescaleSectionPositions(app.store, view, { sections: oldSections });
        }
      },
    },
    columnCount: {
      get: () => section.columnCount,
      set: (v) => {
        const oldColumnCount = section.columnCount;
        section.columnCount = Math.max(1, Number(v) || 1);
        if (section.columnCount !== oldColumnCount) {
          const oldSections = view.sections.map((s) => (s === section ? { ...s, columnCount: oldColumnCount } : s));
          rescaleSectionPositions(app.store, view, { sections: oldSections });
        }
      },
    },
    elementTypes: {
      get: () => section.elementTypes || [],
      set: (v) => { section.elementTypes = v.split(',').map((s) => s.trim()).filter(Boolean); },
    },
    addSection: { get: () => null, set: () => {} },
    removeSection: { get: () => null, set: () => {} },
    duplicateSection: { get: () => null, set: () => {} },
  };
  renderShowFieldsPanel(app, tab, 'section', accessors, buttonHandlersFor(app, tab, 'section', { section }), body);
}

// Reported directly: "Move the view filter checkboxes such as connectors, streams,
// data, types, description, attributes, keys, show simulation values (rename to show
// left badge), show script badge (rename to show right badge) that are currently
// below properties to the newly created filters group." These 9 fields used to render
// inside renderViewProperties below (only while nothing was selected); they now
// render in the Filters panel (renderViewDisplayFilters, below). Direct follow-up,
// reported again once selection made the two panels visibly collide: "the view
// filters are shown as well as the node properties when a node or connector is
// selected" — so despite the name, this panel is NOT independent of selection: see
// renderViewDisplayFilters's own comment for the current (reverted-back) rule.
// (chkShowSimValues/chkShowScriptBadge were also renamed in their own showFields.view
// label, custom.json, to match what they actually indicate — a left-side vs.
// right-side badge on the node — now that "Show Simulation Values" sitting right next
// to "Show Script Badge" in the same panel made the asymmetric old naming obviously
// inconsistent.)
const VIEW_DISPLAY_FILTER_FIELDS = ['chkShowConnectorType', 'chkShowStreamType', 'chkShowDataType', 'chkShowElementTypes', 'chkShowDescription', 'chkShowAttributes', 'chkShowKeys', 'chkShowSimValues', 'chkShowScriptBadge'];

function viewFieldAccessors(app, tab, view) {
  return {
    id: { get: () => view.id, set: (v) => { if (v) app.store.renameView(view.id, v); } },
    viewName: { get: () => view.viewName, set: (v) => { if (v) app.store.renameView(view.id, v); } },
    viewType: { get: () => view.viewType, set: (v) => { if (v) view.viewType = v; } },
    margin: { get: () => view.margin ?? 50, set: (v) => { view.margin = Number(v) || 0; } },
    spacingScale: { get: () => view.spacingScale ?? 1, set: (v) => { const oldScale = view.spacingScale || 1; app.store.applySpacingScale(view.id, Number(v) || 1); if (isSectionViewType(view.viewType)) rescaleSectionPositions(app.store, view, { spacingScale: oldScale }); } },
    spacingAxis: { get: () => view.spacingAxis || 'both', set: (v) => { view.spacingAxis = v; } },
    chkShowConnectorType: { get: () => view.chkShowConnectorType, set: (v) => { view.chkShowConnectorType = v; } },
    chkShowStreamType: { get: () => view.chkShowStreamType, set: (v) => { view.chkShowStreamType = v; } },
    chkShowDataType: { get: () => view.chkShowDataType, set: (v) => { view.chkShowDataType = v; } },
    chkShowAttributes: { get: () => view.chkShowAttributes, set: (v) => { view.chkShowAttributes = v; } },
    chkShowElementTypes: { get: () => view.chkShowElementTypes, set: (v) => { view.chkShowElementTypes = v; redrawAndResolveLayout(app, tab); } },
    chkShowKeys: { get: () => view.chkShowKeys, set: (v) => { view.chkShowKeys = v; redrawAndResolveLayout(app, tab); } },
    chkShowDescription: { get: () => view.chkShowDescription, set: (v) => { view.chkShowDescription = v; redrawAndResolveLayout(app, tab); } },
    chkShowSimValues: { get: () => view.chkShowSimValues, set: (v) => { view.chkShowSimValues = v; } },
    chkShowScriptBadge: { get: () => view.chkShowScriptBadge, set: (v) => { view.chkShowScriptBadge = v; } },
    routingStyle: { get: () => view.routingStyle || 'default', set: (v) => { view.routingStyle = v; app.render(); } },
    routingStyleStream: { get: () => view.routingStyleStream || 'default', set: (v) => { view.routingStyleStream = v; app.render(); } },
  };
}

/** A subset of showFields.view.fields (custom.json), tagged with __sourceEntityKey so
 * selectOptionsFor still resolves correctly for any 's'-type field in the subset —
 * same merged-spec convention renderPinnedSection already established above. */
function filteredViewSpec(app, keep) {
  const fullSpec = app.store.settings.showFields?.view?.fields || {};
  const out = {};
  for (const [name, def] of Object.entries(fullSpec)) {
    if (!keep(name)) continue;
    out[name] = { ...def, __sourceEntityKey: 'view' };
  }
  return out;
}

function renderViewProperties(app, tab) {
  const body = document.getElementById('properties-body');
  const view = app.store.findView(tab.viewId);
  if (!view) { body.innerHTML = '<div class="empty-hint">Select a node or edge to edit its properties.</div>'; return; }

  const accessors = viewFieldAccessors(app, tab, view);
  const spec = filteredViewSpec(app, (name) => !VIEW_DISPLAY_FILTER_FIELDS.includes(name));
  body.innerHTML = `<div class="empty-hint" style="margin-bottom:10px;">Nothing selected — showing view settings for "${escapeHtml(view.viewName)}".</div><div id="sf-view-fields"></div>`;
  // idNamespace: 'view' keeps the original sf-view-<field> ids stable (a merged-spec
  // object, unlike the plain 'view' string this used to pass directly, would
  // otherwise default to the generic 'custom' namespace).
  renderShowFieldsPanel(app, tab, spec, accessors, {}, document.getElementById('sf-view-fields'), undefined, { idNamespace: 'view' });
}

/** Filters panel (index.html, right column, above Properties): the 9 view-level
 * display toggles moved here from renderViewProperties above. Direct follow-up
 * reported against the earlier "shown regardless of selection" behavior: "the panel
 * for view filters should only be displayed in right side panel when the view is
 * selected on canvas (ie not clicking on connector or node), current problem is the
 * view filters are shown as well as the node properties when a node or connector is
 * selected." So this panel is now shown exactly when renderProperties (above) would
 * show renderViewProperties for the SAME tab — nothing selected — and hidden the
 * moment anything is, via the same canvasHasObjectSelected(tab) the outer Filters
 * panel's own visibility now uses (renderToolbar, above this file) — a later, broader
 * follow-up against that SAME outer panel: "should only appear when view is clicked
 * in canvas not on a node, connector, or section or other canvas object" — so a
 * selected Section now hides this nested sub-panel too (it used to be a deliberate
 * carve-out here; superseded once the OUTER panel started hiding for section
 * selection as well — keeping this one narrower would just be silently unreachable,
 * confusing dead code once its ancestor is already hidden). Hidden entirely for every
 * other tab type, including 3D, since these are genuine View DOCUMENT properties, not
 * tab-scoped session filters, and a 3D tab isn't backed by any single view. */
function renderViewDisplayFilters(app) {
  const wrap = document.getElementById('view-display-filters-wrap');
  const container = document.getElementById('view-display-filters-body');
  if (!wrap || !container) return;
  const tab = app.store.activeTab();
  const view = tab && tab.type === 'canvas' ? app.store.findView(tab.viewId) : null;
  if (!view || canvasHasObjectSelected(tab)) {
    wrap.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  const accessors = viewFieldAccessors(app, tab, view);
  const spec = filteredViewSpec(app, (name) => VIEW_DISPLAY_FILTER_FIELDS.includes(name));
  renderShowFieldsPanel(app, tab, spec, accessors, {}, container, undefined, { idNamespace: 'view-filter' });
}

/**
 * The pin button is a SIBLING of the label, not nested inside it (Step: fixed a real bug
 * where it was nested — a real double-click aimed at the label text was landing on the
 * button between the two clicks of the gesture, since clicking it toggles the pin and
 * triggers a full re-render mid-gesture, which un-pins the row out from under the second
 * click entirely). Keeping them as separate elements with their own hit areas means a
 * click can only ever land on one or the other. `inputId`, when given, sets the label's
 * `for` attribute so a single click on the label also focuses/selects the field, the same
 * native behavior checkbox rows already got via their own hand-built `<label for>` markup.
 */
function row(labelText, inputHtml, fieldName, pinBtnHtml = '', inputId = '') {
  const forAttr = inputId ? ` for="${inputId}"` : '';
  return `<div class="prop-row">${pinBtnHtml}<label${forAttr}${fieldName ? ` data-field="${fieldName}"` : ''}>${escapeHtml(labelText)}</label>${inputHtml}</div>`;
}

// Node panel — spec entity 'viewMember' (a Part's specific placement on this view).
// ===================== CATALOG ROW PROPERTIES =====================
// Selecting a row in a Catalog table shows the same data-driven panel a canvas
// selection would ("calculated permissions" = same showFields access rules apply).
/** Builds a human-readable "Field: Value" text block for a catalog row, resolving
 * lookup-style fields (Part references on a Connector, etc.) to their readable label
 * rather than raw ids — e.g. "From: Customer Service (BusinessActor)" instead of the
 * bare id. Used by the catalog row property panel's Copy button. */
function buildCatalogRowCopyText(app, catalogType, id) {
  const store = app.store;
  const elTitle = (type) => (store.settings.elements || []).find((e) => ciEq(e.type, type))?.title || type;
  const lines = [];

  if (catalogType === 'parts' || (catalogType === 'viewMembers' && store.findViewMember(id)?.objectType === 'part')) {
    const part = catalogType === 'parts' ? store.findPart(id) : store.findPart(store.findViewMember(id).objectId);
    if (!part) return '';
    // Every showFields.part field, not just the handful originally copied — same order
    // Root Properties renders them in, so this reads like the whole panel.
    lines.push(`Id: ${part.id}`);
    lines.push(`Type: ${elTitle(part.type)} (${part.type})`);
    lines.push(`Label: ${part.label}`);
    if (part.rawLabel && part.rawLabel !== part.label) lines.push(`Raw Label: ${part.rawLabel}`);
    lines.push(`Model: ${part.model}`);
    if (part.section) lines.push(`Section: ${part.section}`);
    if ((part.streams || []).length) lines.push(`Streams: ${part.streams.join(', ')}`);
    if (part.note) lines.push(`Note: ${part.note}`);
    if (part.order) lines.push(`Order: ${part.order}`);
    if (part.other && Object.keys(part.other).length) lines.push(`Other: ${JSON.stringify(part.other)}`);
    if (part.xIds) lines.push(`xIds: ${part.xIds}`);
    if (part.description) lines.push(`Description: ${part.description}`);
    if (part.scriptEnabled) lines.push(`Script Enabled: true`);
    if (part.script) lines.push(`Script:\n${part.script}`);
    if (part.createdAt) lines.push(`Created: ${part.createdAt}`);
    if (part.updatedAt) lines.push(`Updated: ${part.updatedAt}`);
  } else if (catalogType === 'connectors' || (catalogType === 'viewMembers' && store.findViewMember(id)?.objectType === 'connector')) {
    const conn = catalogType === 'connectors' ? store.findConnector(id) : store.findConnector(store.findViewMember(id).objectId);
    if (!conn) return '';
    const fromPart = store.findPart(conn.from), toPart = store.findPart(conn.to);
    lines.push(`From: ${fromPart ? `${fromPart.label} (${elTitle(fromPart.type)})` : conn.from}`);
    lines.push(`To: ${toPart ? `${toPart.label} (${elTitle(toPart.type)})` : conn.to}`);
    lines.push(`Relationship: ${conn.relationship}`);
    lines.push(`Model: ${conn.model}`);
    if (conn.note) lines.push(`Note: ${conn.note}`);
    if ((conn.streams || []).length) lines.push(`Streams: ${conn.streams.join(', ')}`);
  } else if (catalogType === 'views') {
    const view = store.findView(id);
    if (!view) return '';
    lines.push(`Name: ${view.viewName}`);
    lines.push(`Type: ${view.viewType}`);
    lines.push(`Margin: ${view.margin ?? 50}`);
    lines.push(`Spacing: ${view.spacingScale ?? 1}`);
  }
  return lines.join('\n');
}

function renderCatalogRowProperties(app, tab) {
  const body = document.getElementById('properties-body');
  const { catalogType, id } = tab.selectedCatalogRow;
  const store = app.store;

  if (catalogType === 'viewMembers') {
    const vm = store.findViewMember(id);
    if (!vm) { body.innerHTML = '<div class="empty-hint">ViewMember not found.</div>'; return; }
    if (vm.objectType === 'part') renderPartProperties(app, vm);
    else renderConnectorProperties(app, vm);
    addCatalogRowCopyButton(app, body, catalogType, id);
    return;
  }
  if (catalogType === 'parts') {
    const part = store.findPart(id);
    if (!part) { body.innerHTML = '<div class="empty-hint">Part not found.</div>'; return; }
    renderPartOnlyProperties(app, part);
    addCatalogRowCopyButton(app, body, catalogType, id);
    return;
  }
  if (catalogType === 'connectors') {
    const conn = store.findConnector(id);
    if (!conn) { body.innerHTML = '<div class="empty-hint">Connector not found.</div>'; return; }
    renderConnectorOnlyProperties(app, conn);
    addCatalogRowCopyButton(app, body, catalogType, id);
    return;
  }
  if (catalogType === 'views') {
    const view = store.findView(id);
    if (!view) { body.innerHTML = '<div class="empty-hint">View not found.</div>'; return; }
    renderViewOnlyProperties(app, view);
    addCatalogRowCopyButton(app, body, catalogType, id);
    return;
  }
  body.innerHTML = '<div class="empty-hint">Nothing selected.</div>';
}

/** Prepends a Copy button above a catalog row's rendered fields (the delegate renderers
 * above fully overwrite `body.innerHTML`, so this runs AFTER them rather than being
 * baked into the same template). Copies the resolved-lookup-values text built by
 * buildCatalogRowCopyText to the clipboard. */
function addCatalogRowCopyButton(app, body, catalogType, id) {
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex; justify-content:flex-end; margin-bottom:6px;';
  bar.innerHTML = `<button class="icon-btn" id="catalog-row-copy-btn" title="Copy this row (with lookup values resolved)">📋 Copy</button>`;
  body.insertBefore(bar, body.firstChild);
  document.getElementById('catalog-row-copy-btn').addEventListener('click', async () => {
    const text = buildCatalogRowCopyText(app, catalogType, id);
    if (!text) { app.toast('Nothing to copy.', true); return; }
    try {
      await navigator.clipboard.writeText(text);
      app.toast('Row copied to clipboard.');
    } catch {
      app.toast('Copy failed — clipboard access was blocked.', true);
    }
  });
}

// entity 'part': fields intrinsic to the Part itself (no specific placement/viewMember
// context — visual overrides like fillColor live on ViewMember and don't apply here).
function renderPartOnlyProperties(app, part) {
  const body = document.getElementById('properties-body');
  body.innerHTML = '';
  const accessors = {
    id: { get: () => part.id, set: () => {} },
    type: { get: () => part.type, set: (v) => { part.type = v; app.store.touchPart(part); } },
    label: { get: () => part.label, set: (v) => { part.label = v; part.rawLabel = v; app.store.touchPart(part); } },
    rawLabel: { get: () => part.rawLabel, set: () => {} },
    description: { get: () => part.description, set: (v) => { part.description = v; app.store.touchPart(part); } },
    model: { get: () => part.model, set: (v) => { part.model = v; app.store.touchPart(part); } },
    section: { get: () => part.section, set: (v) => { part.section = v; app.store.touchPart(part); } },
    note: { get: () => part.note, set: (v) => { part.note = v; app.store.touchPart(part); } },
    order: { get: () => part.order, set: (v) => { part.order = Number(v) || 0; app.store.touchPart(part); } },
    other: { get: () => part.other, set: () => {} },
    xIds: { get: () => part.xIds, set: (v) => { part.xIds = v; app.store.touchPart(part); } },
    streams: { get: () => part.streams || [], set: (v) => { part.streams = v.split(',').map((s) => s.trim()).filter(Boolean); app.store.touchPart(part); } },
    attributes: { get: () => part.attributes || [], set: (v) => { part.attributes = v; app.store.touchPart(part); } },
    scriptEnabled: { get: () => part.scriptEnabled, set: (v) => { part.scriptEnabled = v; app.store.touchPart(part); } },
    script: { get: () => part.script, set: (v) => { part.script = v; app.store.touchPart(part); } },
    createdAt: { get: () => part.createdAt, set: () => {} },
    updatedAt: { get: () => part.updatedAt, set: () => {} },
  };
  renderPinnedSection(app, null, 'table', [{ entityKey: 'part', accessors }], body);
  const container = document.createElement('div');
  body.appendChild(container);
  renderShowFieldsPanel(app, null, 'part', accessors, {}, container, undefined, { pinGroup: 'table' });
}

function renderConnectorOnlyProperties(app, conn) {
  const body = document.getElementById('properties-body');
  body.innerHTML = '';
  const fromPart = app.store.findPart(conn.from);
  const toPart = app.store.findPart(conn.to);
  const accessors = {
    id: { get: () => conn.id, set: () => {} },
    from: { get: () => fromPart ? `${conn.from} — ${fromPart.label} (${fromPart.type})` : conn.from, set: () => {} },
    to: { get: () => toPart ? `${conn.to} — ${toPart.label} (${toPart.type})` : conn.to, set: () => {} },
    relationship: { get: () => conn.relationship, set: (relationKey) => { app.applyRelationToConnector(conn, relationKey); app.store.touchConnector(conn); app.promptSyncInventoryConnector(conn); } },
    fromAttribute: { get: () => conn.fromAttribute || '', set: (v) => { conn.fromAttribute = v; app.store.touchConnector(conn); } },
    toAttribute: { get: () => conn.toAttribute || '', set: (v) => { conn.toAttribute = v; app.store.touchConnector(conn); } },
    fromCardinality: { get: () => conn.fromCardinality || '', set: (v) => { conn.fromCardinality = v; app.store.touchConnector(conn); } },
    toCardinality: { get: () => conn.toCardinality || '', set: (v) => { conn.toCardinality = v; app.store.touchConnector(conn); } },
    model: { get: () => conn.model, set: () => {} },
    note: { get: () => conn.note, set: (v) => { conn.note = v; app.store.touchConnector(conn); } },
    streams: { get: () => conn.streams || [], set: (v) => { conn.streams = v.split(',').map((s) => s.trim()).filter(Boolean); app.store.touchConnector(conn); app.promptSyncInventoryConnector(conn); } },
    connectorType: { get: () => conn.connectorType, set: (v) => { conn.connectorType = v; app.store.touchConnector(conn); } },
    fromLineEndSettings: { get: () => conn.fromLineEndSettings, set: () => {} },
    toLineEndSettings: { get: () => conn.toLineEndSettings, set: () => {} },
    stroke: { get: () => conn.stroke, set: () => {} },
    strokeWidth: { get: () => conn.strokeWidth, set: () => {} },
    strokeNormal: { get: () => conn.strokeNormal, set: () => {} },
    strokeWidthNormal: { get: () => conn.strokeWidthNormal, set: () => {} },
    dash: { get: () => conn.dash, set: () => {} },
    fill: { get: () => conn.fill, set: () => {} },
    createdAt: { get: () => conn.createdAt, set: () => {} },
    updatedAt: { get: () => conn.updatedAt, set: () => {} },
  };
  const relCtx = { fromType: fromPart?.type, toType: toPart?.type, fromPartId: conn.from, toPartId: conn.to };
  renderPinnedSection(app, null, 'table', [{ entityKey: 'connector', accessors, ctx: relCtx }], body);
  const container = document.createElement('div');
  body.appendChild(container);
  renderShowFieldsPanel(app, null, 'connector', accessors, {}, container, relCtx, { pinGroup: 'table' });
}

function renderViewOnlyProperties(app, view) {
  const body = document.getElementById('properties-body');
  body.innerHTML = '';
  const accessors = {
    id: { get: () => view.id, set: (v) => { if (v) app.store.renameView(view.id, v); } },
    viewName: { get: () => view.viewName, set: (v) => { if (v) app.store.renameView(view.id, v); } },
    viewType: { get: () => view.viewType, set: () => {} },
    margin: { get: () => view.margin ?? 50, set: (v) => { view.margin = Number(v) || 0; } },
    spacingScale: { get: () => view.spacingScale ?? 1, set: (v) => { const oldScale = view.spacingScale || 1; app.store.applySpacingScale(view.id, Number(v) || 1); if (isSectionViewType(view.viewType)) rescaleSectionPositions(app.store, view, { spacingScale: oldScale }); } },
    spacingAxis: { get: () => view.spacingAxis || 'both', set: (v) => { view.spacingAxis = v; } },
    chkShowConnectorType: { get: () => view.chkShowConnectorType, set: (v) => { view.chkShowConnectorType = v; } },
    chkShowStreamType: { get: () => view.chkShowStreamType, set: (v) => { view.chkShowStreamType = v; } },
    chkShowDataType: { get: () => view.chkShowDataType, set: (v) => { view.chkShowDataType = v; } },
    chkShowAttributes: { get: () => view.chkShowAttributes, set: (v) => { view.chkShowAttributes = v; } },
    chkShowElementTypes: { get: () => view.chkShowElementTypes, set: (v) => { view.chkShowElementTypes = v; } },
    chkShowKeys: { get: () => view.chkShowKeys, set: (v) => { view.chkShowKeys = v; } },
    chkShowDescription: { get: () => view.chkShowDescription, set: (v) => { view.chkShowDescription = v; } },
    chkShowSimValues: { get: () => view.chkShowSimValues, set: (v) => { view.chkShowSimValues = v; } },
    chkShowScriptBadge: { get: () => view.chkShowScriptBadge, set: (v) => { view.chkShowScriptBadge = v; } },
    routingStyle: { get: () => view.routingStyle || 'default', set: (v) => { view.routingStyle = v; } },
    routingStyleStream: { get: () => view.routingStyleStream || 'default', set: (v) => { view.routingStyleStream = v; } },
  };
  renderPinnedSection(app, null, 'table', [{ entityKey: 'view', accessors }], body);
  const container = document.createElement('div');
  body.appendChild(container);
  renderShowFieldsPanel(app, null, 'view', accessors, {}, container, undefined, { pinGroup: 'table' });
}

/** Appends a "Root Properties" collapsible sub-section (same visual/behavioral pattern
 * as the sidebar's own collapsible panel sections — reuses the identical CSS classes,
 * so no new styling was needed) showing every field of the underlying part/connector,
 * driven by settings.showFields.part/connector — the schema-driven counterpart to the
 * viewMember-specific fields already rendered above it. Collapse state persists across
 * re-renders via localStorage, matching the sidebar sections' own persistence; wired
 * fresh on every call since this content is injected dynamically, unlike the sidebar's
 * own sections which are wired once at page load. */
function renderRootPropertiesSection(app, entityKey, accessors, body, ctx, options) {
  const collapsed = localStorage.getItem('dycad-root-properties-collapsed') === 'true';
  const wrap = document.createElement('div');
  wrap.className = 'panel-section collapsible root-properties-section' + (collapsed ? ' collapsed' : '');
  wrap.innerHTML = `<h3 class="panel-title" style="margin-top:14px; padding-top:10px; border-top:1px solid var(--border);"><button class="panel-toggle" title="Expand/collapse">▾</button>Root Properties</h3><div class="panel-body"></div>`;
  body.appendChild(wrap);
  wrap.querySelector('.panel-toggle').addEventListener('click', () => {
    const nowCollapsed = wrap.classList.toggle('collapsed');
    localStorage.setItem('dycad-root-properties-collapsed', String(nowCollapsed));
  });
  renderShowFieldsPanel(app, null, entityKey, accessors, {}, wrap.querySelector('.panel-body'), ctx, options);
}

function renderPartProperties(app, vm) {
  const part = app.store.findPart(vm.objectId);
  const body = document.getElementById('properties-body');
  if (!part) { body.innerHTML = '<div class="empty-hint">Part not found.</div>'; return; }
  body.innerHTML = '';

  // Top level: TRUE viewMember fields only — this view's own placement/display of the
  // part (position, colors, this-view-only note, ...). The part's OWN fields (label,
  // description, script, ...) live in Root Properties below instead, since they don't
  // belong to this view — they belong to the part itself, and editing them here still
  // edits the SAME underlying part every other view sees too.
  const vmAccessors = {
    fillColor: { get: () => vm.fillColor, set: (v) => { vm.fillColor = v; } },
    fontColor: { get: () => vm.fontColor, set: (v) => { vm.fontColor = v; } },
    fontSize: { get: () => vm.fontSize, set: (v) => { vm.fontSize = Number(v) || 0; } },
    borderColor: { get: () => vm.borderColor, set: (v) => { vm.borderColor = v; } },
    x: { get: () => vm.x, set: (v) => { vm.x = Number(v) || 0; } },
    y: { get: () => vm.y, set: (v) => { vm.y = Number(v) || 0; } },
    view: { get: () => vm.view, set: () => {} },
    order: { get: () => vm.order, set: (v) => { vm.order = Number(v) || 0; } },
    note: { get: () => vm.note, set: (v) => { vm.note = v; } },
    linkedViewName: { get: () => vm.linkedViewName, set: (v) => { vm.linkedViewName = v; } },
    isExternal: { get: () => vm.isExternal, set: (v) => { vm.isExternal = v; } },
    sectionId: { get: () => vm.sectionId, set: () => {} },
  };

  // Root Properties: TRUE Part fields — same side effects (type change recolors this
  // view's node; label change offers to rename a linked view) as before the split,
  // just relocated here since they're genuinely part-level concerns, not view-level.
  // Defined here (rather than right before renderRootPropertiesSection below) so the
  // Pinned section above can draw from both this and vmAccessors.
  const partAccessors = {
    id: { get: () => part.id, set: () => {} },
    type: {
      get: () => part.type,
      set: (v) => {
        const oldType = part.type;
        part.type = v;
        if (!ciEq(oldType, v)) {
          const newEl = (app.store.settings.elements || []).find((el) => ciEq(el.type, v));
          vm.fillColor = groupFill(app, newEl);
        }
        app.store.touchPart(part);
      },
    },
    label: {
      get: () => part.label,
      set: (v) => {
        const oldLabel = part.label;
        part.label = v; part.rawLabel = v;
        if (!ciEq(oldLabel, v)) app.renameLinkedViewIfNeeded(vm, oldLabel, v);
        app.store.touchPart(part);
      },
    },
    rawLabel: { get: () => part.rawLabel, set: () => {} },
    model: { get: () => part.model, set: (v) => { part.model = v; app.store.touchPart(part); } },
    section: { get: () => part.section, set: (v) => { part.section = v; app.store.touchPart(part); } },
    streams: { get: () => part.streams || [], set: (v) => { part.streams = v.split(',').map((s) => s.trim()).filter(Boolean); app.store.touchPart(part); } },
    note: { get: () => part.note, set: (v) => { part.note = v; app.store.touchPart(part); } },
    order: { get: () => part.order, set: (v) => { part.order = Number(v) || 0; app.store.touchPart(part); } },
    other: { get: () => part.other, set: () => {} },
    xIds: { get: () => part.xIds, set: (v) => { part.xIds = v; app.store.touchPart(part); } },
    description: { get: () => part.description, set: (v) => { part.description = v; app.store.touchPart(part); } },
    attributes: { get: () => part.attributes || [], set: (v) => { part.attributes = v; app.store.touchPart(part); } },
    script: { get: () => part.script, set: (v) => { part.script = v; app.store.touchPart(part); } },
    scriptEnabled: { get: () => part.scriptEnabled, set: (v) => { part.scriptEnabled = v; app.store.touchPart(part); } },
    createdAt: { get: () => part.createdAt, set: () => {} },
    updatedAt: { get: () => part.updatedAt, set: () => {} },
  };

  const tab = app.store.activeTab();

  renderPinnedSection(app, tab, 'node', [
    { entityKey: 'viewMember', accessors: vmAccessors },
    { entityKey: 'part', accessors: partAccessors },
  ], body);

  const topContainer = document.createElement('div');
  topContainer.className = 'vm-top-fields'; // stable hook for tests — the Pinned section above may or may not be present/first, so callers shouldn't rely on DOM position to find "the real viewMember-only panel"
  body.appendChild(topContainer);
  renderShowFieldsPanel(app, tab, 'viewMember', vmAccessors, {}, topContainer, undefined, { pinGroup: 'node' });

  renderRootPropertiesSection(app, 'part', partAccessors, body, undefined, { pinGroup: 'node' });
}

function renderConnectorProperties(app, vm) {
  const conn = app.store.findConnector(vm.objectId);
  const body = document.getElementById('properties-body');
  if (!conn) { body.innerHTML = '<div class="empty-hint">Connector not found.</div>'; return; }
  body.innerHTML = '';
  const fromPart = app.store.findPart(conn.from);
  const toPart = app.store.findPart(conn.to);

  // Top level: TRUE viewMember fields for this connector's placement on this view —
  // previously not shown at all here (the old combined panel only ever showed
  // connector-level fields); now genuinely exposed, matching how the node panel above
  // already exposes its own viewMember fields.
  const vmAccessors = {
    fillColor: { get: () => vm.fillColor, set: (v) => { vm.fillColor = v; } },
    fontColor: { get: () => vm.fontColor, set: (v) => { vm.fontColor = v; } },
    fontSize: { get: () => vm.fontSize, set: (v) => { vm.fontSize = Number(v) || 0; } },
    borderColor: { get: () => vm.borderColor, set: (v) => { vm.borderColor = v; } },
    view: { get: () => vm.view, set: () => {} },
    order: { get: () => vm.order, set: (v) => { vm.order = Number(v) || 0; } },
    note: { get: () => vm.note, set: (v) => { vm.note = v; } },
    linkedViewName: { get: () => vm.linkedViewName, set: (v) => { vm.linkedViewName = v; } },
    isExternal: { get: () => vm.isExternal, set: (v) => { vm.isExternal = v; } },
    sectionId: { get: () => vm.sectionId, set: () => {} },
    fromVmId: { get: () => vm.fromVmId, set: () => {} },
    toVmId: { get: () => vm.toVmId, set: () => {} },
  };

  // Root Properties: TRUE Connector fields — from/to show the actual id alongside the
  // resolved label for readability, since "all ids" was specifically asked for here,
  // not just a friendly display. Defined here (rather than right before
  // renderRootPropertiesSection below) so the Pinned section above can draw from both
  // this and vmAccessors.
  const connAccessors = {
    id: { get: () => conn.id, set: () => {} },
    from: { get: () => fromPart ? `${conn.from} — ${fromPart.label} (${fromPart.type})` : conn.from, set: () => {} },
    to: { get: () => toPart ? `${conn.to} — ${toPart.label} (${toPart.type})` : conn.to, set: () => {} },
    model: { get: () => conn.model, set: () => {} },
    streams: { get: () => conn.streams || [], set: (v) => { conn.streams = v.split(',').map((s) => s.trim()).filter(Boolean); app.store.touchConnector(conn); app.promptSyncInventoryConnector(conn); } },
    note: { get: () => conn.note, set: (v) => { conn.note = v; app.store.touchConnector(conn); } },
    connectorType: { get: () => conn.connectorType, set: (v) => { conn.connectorType = v; app.store.touchConnector(conn); } },
    relationship: { get: () => conn.relationship, set: (relationKey) => { app.applyRelationToConnector(conn, relationKey); app.store.touchConnector(conn); app.promptSyncInventoryConnector(conn); } },
    fromAttribute: { get: () => conn.fromAttribute || '', set: (v) => { conn.fromAttribute = v; app.store.touchConnector(conn); } },
    toAttribute: { get: () => conn.toAttribute || '', set: (v) => { conn.toAttribute = v; app.store.touchConnector(conn); } },
    fromCardinality: { get: () => conn.fromCardinality || '', set: (v) => { conn.fromCardinality = v; app.store.touchConnector(conn); } },
    toCardinality: { get: () => conn.toCardinality || '', set: (v) => { conn.toCardinality = v; app.store.touchConnector(conn); } },
    fromLineEndSettings: { get: () => conn.fromLineEndSettings, set: () => {} },
    toLineEndSettings: { get: () => conn.toLineEndSettings, set: () => {} },
    stroke: { get: () => conn.stroke, set: () => {} },
    strokeWidth: { get: () => conn.strokeWidth, set: () => {} },
    strokeNormal: { get: () => conn.strokeNormal, set: () => {} },
    strokeWidthNormal: { get: () => conn.strokeWidthNormal, set: () => {} },
    dash: { get: () => conn.dash, set: () => {} },
    fill: { get: () => conn.fill, set: () => {} },
    createdAt: { get: () => conn.createdAt, set: () => {} },
    updatedAt: { get: () => conn.updatedAt, set: () => {} },
  };

  const tab = app.store.activeTab();
  const relCtx = { fromType: fromPart?.type, toType: toPart?.type, fromPartId: conn.from, toPartId: conn.to };

  renderPinnedSection(app, tab, 'connector', [
    { entityKey: 'viewMember', accessors: vmAccessors },
    { entityKey: 'connector', accessors: connAccessors, ctx: relCtx },
  ], body);

  const topContainer = document.createElement('div');
  topContainer.className = 'vm-top-fields'; // stable hook for tests — the Pinned section above may or may not be present/first, so callers shouldn't rely on DOM position to find "the real viewMember-only panel"
  body.appendChild(topContainer);
  renderShowFieldsPanel(app, tab, 'viewMember', vmAccessors, {}, topContainer, relCtx, { pinGroup: 'connector' });

  renderRootPropertiesSection(app, 'connector', connAccessors, body, relCtx, { pinGroup: 'connector' });
}

// ===================== MULTI-SELECT COMMON ATTRIBUTES =====================
/** Reads fieldName for one multi-select item. Node fields not explicitly listed here
 * fall back to reading straight off `part` (every part-level showFields field name is
 * also a literal property name on the Part object); connector fields likewise default to
 * `conn`. Only fields that actually need vm-level routing, a computed display value
 * (from/to), or a fallback default get an explicit case.
 *
 * 'note' and 'order' deliberately exist at BOTH the viewMember level (this one
 * placement's own note/order) and the part level (the underlying Part's own note/order —
 * connectors only have a viewMember-level 'order', no entity-level one) — genuinely
 * different fields that happen to share a name. The merged spec built in
 * renderMultiSelectProperties always lets the entity-level (part/connector) definition
 * win when both exist, so 'note'/'order' here resolve to the SAME level the merged
 * spec's label/access describes — falling through to the generic `part`/`conn` default
 * for 'order'/node-'note', with an explicit vm-routed case only where the entity level
 * doesn't define that name at all (connector 'order'). */
function getFieldValueForItem(app, item, fieldName) {
  if (item.type === 'node') {
    const { vm, part } = item;
    switch (fieldName) {
      case 'view': return vm.view;
      case 'fillColor': return vm.fillColor;
      case 'fontColor': return vm.fontColor;
      case 'fontSize': return vm.fontSize;
      case 'borderColor': return vm.borderColor;
      case 'x': return vm.x;
      case 'y': return vm.y;
      case 'sectionId': return vm.sectionId;
      case 'linkedViewName': return vm.linkedViewName;
      case 'isExternal': return vm.isExternal;
      case 'streams': return part.streams || [];
      default: return part[fieldName];
    }
  }
  const { vm, conn } = item;
  switch (fieldName) {
    case 'from': { const p = app.store.findPart(conn.from); return p ? `${p.label} (${p.type})` : conn.from; }
    case 'to': { const p = app.store.findPart(conn.to); return p ? `${p.label} (${p.type})` : conn.to; }
    case 'view': return vm.view;
    case 'fillColor': return vm.fillColor;
    case 'fontColor': return vm.fontColor;
    case 'fontSize': return vm.fontSize;
    case 'borderColor': return vm.borderColor;
    case 'order': return vm.order; // connectors have no entity-level 'order', only viewMember's
    case 'linkedViewName': return vm.linkedViewName;
    case 'isExternal': return vm.isExternal;
    case 'sectionId': return vm.sectionId;
    case 'streams': return conn.streams || [];
    default: return conn[fieldName];
  }
}

/** Writes fieldName for one multi-select item — see getFieldValueForItem's own comment
 * for the vm-vs-entity routing rationale (same rules apply here). Only WRITABLE
 * (access:'w') fields ever reach here: the render loop never wires a change listener to
 * a read-only field (see renderMultiSelectProperties' `if (def.access === 'r')` early
 * continue), so an incomplete default case is safely never exercised for those. */
function setFieldValueForItem(app, item, fieldName, value) {
  if (item.type === 'node') {
    const { vm, part } = item;
    switch (fieldName) {
      case 'type': {
        part.type = value;
        const newEl = (app.store.settings.elements || []).find((el) => ciEq(el.type, value));
        vm.fillColor = groupFill(app, newEl);
        app.store.touchPart(part);
        break;
      }
      case 'label': {
        const oldLabel = part.label;
        part.label = value; part.rawLabel = value;
        if (!ciEq(oldLabel, value)) app.renameLinkedViewIfNeeded(vm, oldLabel, value);
        app.store.touchPart(part);
        break;
      }
      case 'fillColor': vm.fillColor = value; break;
      case 'fontColor': vm.fontColor = value; break;
      case 'fontSize': vm.fontSize = Number(value) || 0; break;
      case 'borderColor': vm.borderColor = value; break;
      case 'x': vm.x = Number(value) || 0; break;
      case 'y': vm.y = Number(value) || 0; break;
      case 'linkedViewName': vm.linkedViewName = value; break;
      case 'isExternal': vm.isExternal = value; break;
      case 'order': part.order = Number(value) || 0; app.store.touchPart(part); break;
      case 'streams': part.streams = value.split(',').map((s) => s.trim()).filter(Boolean); app.store.touchPart(part); break;
      case 'model': part.model = value; app.store.touchPart(part); break;
      case 'section': part.section = value; app.store.touchPart(part); break;
      case 'note': part.note = value; app.store.touchPart(part); break;
      case 'xIds': part.xIds = value; app.store.touchPart(part); break;
      case 'description': part.description = value; app.store.touchPart(part); break;
      case 'scriptEnabled': part.scriptEnabled = value; app.store.touchPart(part); break;
      case 'script': part.script = value; app.store.touchPart(part); break;
      default: break;
    }
    return;
  }
  const { vm, conn } = item;
  switch (fieldName) {
    case 'relationship': app.applyRelationToConnector(conn, value); app.store.touchConnector(conn); break;
    case 'note': conn.note = value; app.store.touchConnector(conn); break;
    case 'streams': conn.streams = value.split(',').map((s) => s.trim()).filter(Boolean); app.store.touchConnector(conn); break;
    case 'fillColor': vm.fillColor = value; break;
    case 'fontColor': vm.fontColor = value; break;
    case 'fontSize': vm.fontSize = Number(value) || 0; break;
    case 'borderColor': vm.borderColor = value; break;
    case 'order': vm.order = Number(value) || 0; break;
    case 'linkedViewName': vm.linkedViewName = value; break;
    case 'isExternal': vm.isExternal = value; break;
    default: break;
  }
}

/**
 * Properties panel for 2+ selected items (nodes and/or connectors): shows attributes
 * common to the selection (all-node -> viewMember fields, all-connector -> connector
 * fields, mixed -> the intersection of field names present in both, with the more
 * restrictive access if they differ). Fields where the selected items disagree show a
 * "(multiple values)" placeholder; any edit prompts to confirm applying it to every
 * selected item before committing.
 */
function renderMultiSelectProperties(app, tab) {
  const body = document.getElementById('properties-body');
  const vms = [...tab.selection].map((id) => app.store.findViewMember(id)).filter(Boolean);
  const nodeItems = vms.filter((vm) => vm.objectType === 'part')
    .map((vm) => ({ type: 'node', vm, part: app.store.findPart(vm.objectId) })).filter((i) => i.part);
  const connItems = vms.filter((vm) => vm.objectType === 'connector')
    .map((vm) => ({ type: 'connector', vm, conn: app.store.findConnector(vm.objectId) })).filter((i) => i.conn);
  const allItems = [...nodeItems, ...connItems];
  if (allItems.length === 0) { body.innerHTML = '<div class="empty-hint">Nothing selected.</div>'; return; }

  const vmSpec = app.store.settings.showFields?.viewMember?.fields || {};
  const partSpec = app.store.settings.showFields?.part?.fields || {};
  const connSpec = app.store.settings.showFields?.connector?.fields || {};
  let entityKeyForOptions, spec;
  let selectCtx = null;
  if (nodeItems.length > 0 && connItems.length === 0) {
    // Merges BOTH levels a node's properties actually span — viewMember (this
    // placement's own display fields) AND part (the underlying Part's own fields:
    // label, streams, description, script, ...), the same two halves the single-node
    // panel shows as "top level" + "Root Properties". Previously only vmSpec was used
    // here, so every part-level field (streams included) was silently unavailable in
    // multi-select regardless of value — not a blank-values special case, just never
    // considered at all. partSpec spread second so it wins the 'note'/'order' name
    // collision (both levels define those, genuinely different fields) — matching what
    // getFieldValueForItem already resolves them to.
    entityKeyForOptions = 'viewMember'; spec = { ...vmSpec, ...partSpec };
  } else if (connItems.length > 0 && nodeItems.length === 0) {
    // Same reasoning as the node branch above, mirrored for connectors: viewMember
    // (fillColor/fontColor/order/... for this connector's placement) + connector (the
    // underlying Connector's own fields: streams, relationship, ...). connSpec spread
    // second wins the 'note' collision; connectors have no entity-level 'order' at all,
    // so vmSpec's stays untouched there.
    entityKeyForOptions = 'connector'; spec = { ...vmSpec, ...connSpec };
    // only meaningful to filter the relationship dropdown if every selected connector
    // shares the same (fromType, toType) pair — otherwise there's no single valid list
    const pairs = connItems.map((item) => {
      const fromPart = app.store.findPart(item.conn.from), toPart = app.store.findPart(item.conn.to);
      return `${fromPart?.type}|${toPart?.type}`;
    });
    if (pairs.every((p) => p === pairs[0])) {
      const [fromType, toType] = pairs[0].split('|');
      selectCtx = { fromType, toType };
    }
  } else {
    entityKeyForOptions = 'viewMember';
    spec = {};
    for (const [name, def] of Object.entries(vmSpec)) {
      if (connSpec[name]) spec[name] = { show: def.show, access: (def.access === 'r' || connSpec[name].access === 'r') ? 'r' : 'w', label: def.label };
    }
  }

  const html = [`<div class="empty-hint" style="margin-bottom:10px;">${allItems.length} items selected — showing common attributes.</div>`];
  for (const [fieldName, def] of Object.entries(spec)) {
    if (def.show === 'h' || def.show === 'b') continue;
    const values = allItems.map((item) => getFieldValueForItem(app, item, fieldName));
    const allEqual = values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]));
    const id = `msf-${fieldName}`;
    const label = def.label || fieldName;

    if (def.access === 'r') {
      const display = allEqual ? (Array.isArray(values[0]) ? values[0].join(', ') : values[0]) : '(multiple values)';
      html.push(row(label, `<input type="text" value="${escapeHtml(String(display ?? ''))}" readonly />`));
      continue;
    }
    const placeholder = allEqual ? '' : '(multiple values)';
    if (def.show === 'y') {
      html.push(`<div class="prop-row checkbox"><input type="checkbox" id="${id}" ${allEqual && values[0] ? 'checked' : ''} data-field="${fieldName}" /><label for="${id}">${escapeHtml(label)}</label></div>`);
    } else if (def.show === 'n') {
      html.push(row(label, `<input type="number" id="${id}" value="${allEqual ? (values[0] ?? 0) : ''}" placeholder="${escapeHtml(placeholder)}" data-field="${fieldName}" />`));
    } else if (def.show === 'c') {
      html.push(row(label, `<input type="color" id="${id}" value="${toHexColor(allEqual ? values[0] : null)}" data-field="${fieldName}" />`));
    } else if (def.show === 'm') {
      html.push(row(label, `<textarea id="${id}" data-field="${fieldName}" placeholder="${escapeHtml(placeholder)}"${fieldHeightStyle(fieldName)}>${allEqual ? escapeHtml(values[0] ?? '') : ''}</textarea>`));
    } else if (def.show === 's') {
      html.push(row(label, `<select id="${id}" data-field="${fieldName}">${selectOptionsFor(app, entityKeyForOptions, fieldName, allEqual ? values[0] : '', selectCtx)}</select>`));
    } else {
      html.push(row(label, `<input type="text" id="${id}" value="${allEqual ? escapeHtml(String(values[0] ?? '')) : ''}" placeholder="${escapeHtml(placeholder)}" data-field="${fieldName}" />`));
    }
  }
  body.innerHTML = html.join('') || '<div class="empty-hint">No common editable attributes.</div>';

  body.querySelectorAll('[data-field]').forEach((el) => {
    if (el.tagName === 'TEXTAREA') wireFieldHeightPersistence(el, el.dataset.field);
    el.addEventListener('change', (e) => {
      const fieldName = el.dataset.field;
      const def = spec[fieldName];
      const value = el.type === 'checkbox' ? el.checked : e.target.value;
      const label = def.label || fieldName;
      app.confirmModal(`Apply "${label}" = "${value}" to all ${allItems.length} selected items?`).then((confirmed) => {
        if (!confirmed) { app.render(); return; }
        for (const item of allItems) setFieldValueForItem(app, item, fieldName, value);
        app.recordAndRender();
      });
    });
  });
}

function relationKeyForConnector(app, conn) {
  const rel = (app.store.settings.relations || []).find((r) => ciEq(r.name, conn.relationship));
  return rel ? rel.key : '';
}

// ===================== helpers =====================
function toHexColor(c) {
  if (!c) return '#cccccc';
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) return c;
  return '#cccccc';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export { renderTabs, renderToolbar, renderToolbox, renderSelectionInfo, renderCommands, renderProperties, renderViewDisplayFilters, renderMessageLog, escapeHtml, kindFromType, iconSvgFor, groupFill, getCommandDefs, CMD_ICONS, getAllPinnedFields, setAllPinnedFields, getAllFieldHeights, setAllFieldHeights, isAttributeForeignKey };
