// render.js — header, toolbox, properties panel rendering (canvas rendering lives in canvas.js)
import { ciEq } from './state.js';
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

  const streamBtn = document.getElementById('stream-filter-btn');
  const activeStreams = tab && tab.type === 'canvas' ? (tab.activeStreams || []) : [];
  streamBtn.textContent = activeStreams.length === 0 ? 'All streams' : activeStreams.length === 1 ? activeStreams[0] : `${activeStreams.length} streams`;
  streamBtn.disabled = !(tab && tab.type === 'canvas');

  const typeBtn = document.getElementById('element-type-filter-btn');
  const rawActiveTypes = tab && tab.type === 'canvas' ? tab.activeElementTypes : null;
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
  typeBtn.disabled = !(tab && tab.type === 'canvas');

  const levelsInput = document.getElementById('connector-levels-input');
  if (document.activeElement !== levelsInput) { // don't clobber the value while the user is actively typing in it
    const rawLevels = tab && tab.type === 'canvas' ? tab.connectorLevels : 0;
    levelsInput.value = rawLevels == null ? '' : String(rawLevels);
  }
  levelsInput.disabled = !(tab && tab.type === 'canvas');

  document.getElementById('undo-btn').disabled = !tab || tab.history.past.length === 0;
  document.getElementById('redo-btn').disabled = !tab || tab.history.future.length === 0;
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
    tile.draggable = true;
    tile.title = el.title;
    tile.innerHTML = iconSvgFor(app, el);
    tile.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/json', JSON.stringify({ kind, label: el.title, elementType: el.type }));
      e.dataTransfer.effectAllowed = 'copy';
    });
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
  generate: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v3M10 15v3M2 10h3M15 10h3M4.5 4.5l2 2M13.5 13.5l2 2M4.5 15.5l2-2M13.5 6.5l2-2"/><circle cx="10" cy="10" r="2.2"/></svg>',
  copy: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7"/></svg>',
  paste: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="10" height="14" rx="1.5"/><path d="M8 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1"/><path d="M8 10h4M8 13h4"/></svg>',
  remap: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="6" height="6" rx="1"/><rect x="12" y="2" width="6" height="6" rx="1"/><rect x="2" y="12" width="6" height="6" rx="1"/><rect x="12" y="12" width="6" height="6" rx="1"/><path d="M9 5h2M5 9v2M15 9v2M9 15h2"/></svg>',
  merge: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.5"/><circle cx="15" cy="6" r="2.5"/><path d="M5 8.5v2a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3v-2"/><circle cx="10" cy="16" r="2.2"/></svg>',
  redraw: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="14" height="9" rx="1.5"/><path d="M14 2.5l2 2-2 2M16 4.5H10"/></svg>',
  addExisting: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="10" height="12" rx="1.5"/><path d="M5.5 7.5h4M5.5 10.5h4M5.5 13.5h2.5"/><circle cx="15.5" cy="14.5" r="3.2"/><path d="M15.5 13v3M14 14.5h3"/></svg>',
  populateFromTemplate: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="6" height="6" rx="1"/><rect x="11.5" y="2.5" width="6" height="6" rx="1"/><rect x="2.5" y="11.5" width="6" height="6" rx="1"/><path d="M14.5 12v6M11.5 15h6"/></svg>',
};

function getCommandDefs(app) {
  const tab = app.store.activeTab();
  const isCanvas = !!(tab && tab.type === 'canvas');
  const selCount = isCanvas ? tab.selection.size : 0;
  const singleVm = selCount === 1 ? app.store.findViewMember([...tab.selection][0]) : null;
  const singlePart = singleVm && singleVm.objectType === 'part' ? app.store.findPart(singleVm.objectId) : null;
  const hasNodeSelection = isCanvas && [...tab.selection].some((id) => app.store.findViewMember(id)?.objectType === 'part');
  const nodeSelectionCount = isCanvas ? [...tab.selection].filter((id) => app.store.findViewMember(id)?.objectType === 'part').length : 0;

  return [
    { key: 'duplicateStream', label: 'Duplicate Stream', hint: 'Duplicate Stream — clone a stream to a new name', enabled: !!singlePart && (singlePart.streams || []).length > 0 },
    { key: 'splitNode', label: 'Split Node', hint: 'Split Node — create a sibling, rewire outgoing edges', enabled: !!singlePart },
    { key: 'levelUp', label: 'Level Up', hint: 'Level Up — open a new parent view containing this view\'s nodes', enabled: isCanvas },
    { key: 'levelDown', label: 'Level Down', hint: 'Level Down — push 2+ selected nodes into a sub-view', enabled: selCount >= 2 },
    { key: 'generate', label: 'Generate Stream', hint: 'Generate Stream — build a stream from a template', enabled: isCanvas },
    { key: 'copy', label: 'Copy', hint: 'Copy — copy the selected nodes', enabled: hasNodeSelection },
    { key: 'paste', label: 'Paste', hint: 'Paste — paste copied nodes into this view', enabled: isCanvas && !!app.clipboard },
    { key: 'remap', label: 'Remap', hint: 'Remap — reorganize this view by stream template', enabled: isCanvas },
    { key: 'merge', label: 'Merge', hint: 'Merge — combine 2+ selected nodes into one', enabled: nodeSelectionCount >= 2 },
    { key: 'redraw', label: 'Redraw', hint: 'Redraw — recalculate best node size and normalize coordinates for this view', enabled: isCanvas },
    { key: 'addExisting', label: 'Add Existing', hint: 'Add Existing — bring existing parts (and optionally their connectors) into this view', enabled: isCanvas },
    { key: 'populateFromTemplate', label: 'Populate From Template', hint: 'Populate From Template — add parts/connectors from a page template matching this view type', enabled: isCanvas },
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
  if (tab && tab.type === 'table' && tab.catalogType && tab.selectedCatalogRow) {
    renderCatalogRowProperties(app, tab);
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
  if ((entityKey === 'part' || entityKey === 'viewMember') && fieldName === 'type') {
    return [...(app.store.settings.elements || [])]
      .sort((a, b) => (a.tkDisplayOrder ?? 999) - (b.tkDisplayOrder ?? 999))
      .map((el) => `<option value="${escapeHtml(el.type)}" ${ciEq(el.type, currentValue) ? 'selected' : ''}>${escapeHtml(el.title)} (${escapeHtml(el.type)})</option>`).join('');
  }
  if ((entityKey === 'part' || entityKey === 'viewMember') && fieldName === 'model') {
    return (app.store.doc.models || []).map((m) => `<option value="${escapeHtml(m.modelName)}" ${ciEq(m.modelName, currentValue) ? 'selected' : ''}>${escapeHtml(m.modelName)}</option>`).join('');
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
 * 'c' color, 't' text, 'm' multiline, 's' selector, 'b' button, 'h' hidden), `access` =
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
      html.push(row(label, `<textarea id="${id}">${escapeHtml(val ?? '')}</textarea>`, fieldName, pinBtn, id));
    } else if (def.show === 's') {
      html.push(row(label, `<select id="${id}">${selectOptionsFor(app, sourceEntityKey, fieldName, val, ctx)}</select>`, fieldName, pinBtn, id));
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
    // buttons (those aren't text).
    if (def.show !== 'b' && def.show !== 'y') {
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

    if (def.access === 'r') continue; // nothing else to wire for readonly fields
    const el = document.getElementById(`sf-${idNs}-${fieldName}`);
    if (!el) continue;
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

function renderViewProperties(app, tab) {
  const body = document.getElementById('properties-body');
  const view = app.store.findView(tab.viewId);
  if (!view) { body.innerHTML = '<div class="empty-hint">Select a node or edge to edit its properties.</div>'; return; }

  const accessors = {
    id: { get: () => view.id, set: (v) => { if (v) app.store.renameView(view.id, v); } },
    viewName: { get: () => view.viewName, set: (v) => { if (v) app.store.renameView(view.id, v); } },
    viewType: { get: () => view.viewType, set: (v) => { if (v) view.viewType = v; } },
    margin: { get: () => view.margin ?? 50, set: (v) => { view.margin = Number(v) || 0; } },
    spacingScale: { get: () => view.spacingScale ?? 1, set: (v) => { const oldScale = view.spacingScale || 1; app.store.applySpacingScale(view.id, Number(v) || 1); if (isSectionViewType(view.viewType)) rescaleSectionPositions(app.store, view, { spacingScale: oldScale }); } },
    chkShowConnectorType: { get: () => view.chkShowConnectorType, set: (v) => { view.chkShowConnectorType = v; } },
    chkShowStreamType: { get: () => view.chkShowStreamType, set: (v) => { view.chkShowStreamType = v; } },
    chkShowElementTypes: { get: () => view.chkShowElementTypes, set: (v) => { view.chkShowElementTypes = v; redrawAndResolveLayout(app, tab); } },
    chkShowKeys: { get: () => view.chkShowKeys, set: (v) => { view.chkShowKeys = v; redrawAndResolveLayout(app, tab); } },
    chkShowDescription: { get: () => view.chkShowDescription, set: (v) => { view.chkShowDescription = v; redrawAndResolveLayout(app, tab); } },
    chkShowSimValues: { get: () => view.chkShowSimValues, set: (v) => { view.chkShowSimValues = v; } },
    chkShowScriptBadge: { get: () => view.chkShowScriptBadge, set: (v) => { view.chkShowScriptBadge = v; } },
    routingStyle: { get: () => view.routingStyle || 'default', set: (v) => { view.routingStyle = v; app.render(); } },
    routingStyleStream: { get: () => view.routingStyleStream || 'default', set: (v) => { view.routingStyleStream = v; app.render(); } },
  };
  body.innerHTML = `<div class="empty-hint" style="margin-bottom:10px;">Nothing selected — showing view settings for "${escapeHtml(view.viewName)}".</div><div id="sf-view-fields"></div>`;
  renderShowFieldsPanel(app, tab, 'view', accessors, {}, document.getElementById('sf-view-fields'));
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
    lines.push(`Type: ${elTitle(part.type)} (${part.type})`);
    lines.push(`Label: ${part.label}`);
    if (part.description) lines.push(`Description: ${part.description}`);
    lines.push(`Model: ${part.model}`);
    if (part.note) lines.push(`Note: ${part.note}`);
    if ((part.streams || []).length) lines.push(`Streams: ${part.streams.join(', ')}`);
    if (part.xIds) lines.push(`xIds: ${part.xIds}`);
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
    relationship: { get: () => conn.relationship, set: (relationKey) => { app.applyRelationToConnector(conn, relationKey); app.store.touchConnector(conn); } },
    model: { get: () => conn.model, set: () => {} },
    note: { get: () => conn.note, set: (v) => { conn.note = v; app.store.touchConnector(conn); } },
    streams: { get: () => conn.streams || [], set: (v) => { conn.streams = v.split(',').map((s) => s.trim()).filter(Boolean); app.store.touchConnector(conn); } },
    connectorType: { get: () => conn.connectorType, set: () => {} },
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
  const relCtx = { fromType: fromPart?.type, toType: toPart?.type };
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
    chkShowConnectorType: { get: () => view.chkShowConnectorType, set: (v) => { view.chkShowConnectorType = v; } },
    chkShowStreamType: { get: () => view.chkShowStreamType, set: (v) => { view.chkShowStreamType = v; } },
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
    streams: { get: () => conn.streams || [], set: (v) => { conn.streams = v.split(',').map((s) => s.trim()).filter(Boolean); app.store.touchConnector(conn); } },
    note: { get: () => conn.note, set: (v) => { conn.note = v; app.store.touchConnector(conn); } },
    connectorType: { get: () => conn.connectorType, set: () => {} },
    relationship: { get: () => conn.relationship, set: (relationKey) => { app.applyRelationToConnector(conn, relationKey); app.store.touchConnector(conn); } },
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
  const relCtx = { fromType: fromPart?.type, toType: toPart?.type };

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
function getFieldValueForItem(app, item, fieldName) {
  if (item.type === 'node') {
    const { vm, part } = item;
    switch (fieldName) {
      case 'type': return part.type;
      case 'label': return part.label;
      case 'fillColor': return vm.fillColor;
      case 'fontColor': return vm.fontColor;
      case 'fontSize': return vm.fontSize;
      case 'borderColor': return vm.borderColor;
      case 'x': return vm.x;
      case 'y': return vm.y;
      case 'view': return vm.view;
      case 'model': return part.model;
      case 'note': return part.note;
      case 'order': return part.order;
      case 'xIds': return part.xIds;
      case 'sectionId': return vm.sectionId;
      case 'streams': return part.streams || [];
      case 'linkedViewName': return vm.linkedViewName;
      case 'isExternal': return vm.isExternal;
      case 'scriptEnabled': return part.scriptEnabled;
      case 'script': return part.script;
      default: return undefined;
    }
  }
  const { conn } = item;
  switch (fieldName) {
    case 'from': { const p = app.store.findPart(conn.from); return p ? `${p.label} (${p.type})` : conn.from; }
    case 'to': { const p = app.store.findPart(conn.to); return p ? `${p.label} (${p.type})` : conn.to; }
    case 'relationship': return conn.relationship;
    case 'model': return conn.model;
    case 'note': return conn.note;
    default: return undefined;
  }
}

function setFieldValueForItem(app, item, fieldName, value) {
  if (item.type === 'node') {
    const { vm, part } = item;
    switch (fieldName) {
      case 'type': {
        part.type = value;
        const newEl = (app.store.settings.elements || []).find((el) => ciEq(el.type, value));
        vm.fillColor = groupFill(app, newEl);
        break;
      }
      case 'label': {
        const oldLabel = part.label;
        part.label = value; part.rawLabel = value;
        if (!ciEq(oldLabel, value)) app.renameLinkedViewIfNeeded(vm, oldLabel, value);
        break;
      }
      case 'fillColor': vm.fillColor = value; break;
      case 'fontColor': vm.fontColor = value; break;
      case 'fontSize': vm.fontSize = Number(value) || 0; break;
      case 'borderColor': vm.borderColor = value; break;
      case 'x': vm.x = Number(value) || 0; break;
      case 'y': vm.y = Number(value) || 0; break;
      case 'model': part.model = value; break;
      case 'note': part.note = value; break;
      case 'order': part.order = Number(value) || 0; break;
      case 'xIds': part.xIds = value; break;
      case 'linkedViewName': vm.linkedViewName = value; break;
      case 'isExternal': vm.isExternal = value; break;
      case 'scriptEnabled': part.scriptEnabled = value; break;
      case 'script': part.script = value; break;
      default: break;
    }
    return;
  }
  const { conn } = item;
  switch (fieldName) {
    case 'relationship': app.applyRelationToConnector(conn, value); break;
    case 'note': conn.note = value; break;
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
  const connSpec = app.store.settings.showFields?.connector?.fields || {};
  let entityKeyForOptions, spec;
  let selectCtx = null;
  if (nodeItems.length > 0 && connItems.length === 0) {
    entityKeyForOptions = 'viewMember'; spec = vmSpec;
  } else if (connItems.length > 0 && nodeItems.length === 0) {
    entityKeyForOptions = 'connector'; spec = connSpec;
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
      html.push(row(label, `<textarea id="${id}" data-field="${fieldName}" placeholder="${escapeHtml(placeholder)}">${allEqual ? escapeHtml(values[0] ?? '') : ''}</textarea>`));
    } else if (def.show === 's') {
      html.push(row(label, `<select id="${id}" data-field="${fieldName}">${selectOptionsFor(app, entityKeyForOptions, fieldName, allEqual ? values[0] : '', selectCtx)}</select>`));
    } else {
      html.push(row(label, `<input type="text" id="${id}" value="${allEqual ? escapeHtml(String(values[0] ?? '')) : ''}" placeholder="${escapeHtml(placeholder)}" data-field="${fieldName}" />`));
    }
  }
  body.innerHTML = html.join('') || '<div class="empty-hint">No common editable attributes.</div>';

  body.querySelectorAll('[data-field]').forEach((el) => {
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

export { renderTabs, renderToolbar, renderToolbox, renderSelectionInfo, renderCommands, renderProperties, renderMessageLog, escapeHtml, kindFromType, iconSvgFor, groupFill, getCommandDefs, CMD_ICONS, getAllPinnedFields, setAllPinnedFields };
