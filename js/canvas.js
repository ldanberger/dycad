// canvas.js — the interactive canvas: nodes (viewMembers of type 'part'), edges (viewMembers of type 'connector')
import { ciEq } from './state.js';
import { escapeHtml, groupFill, iconSvgFor, isAttributeForeignKey } from './render.js';
import { elementByType } from './rules.js';
import { isSectionViewType, computeSectionLayout, pixelToNearestGrid, isTypeAllowedInSection, findFreeCellOrGrowSection, CELL_W, CELL_H, rescaleSectionPositions } from './sections.js';
import { computeRoutedPath } from './routing.js';
import { pushMessageLog } from './simulation.js';

/** connectorType 'd' (Data Modeling / crow's-foot) connectors' fromCardinality/
 * toCardinality values -> the lineEnds entry (public/custom.json) drawing that
 * cardinality's symbol. See drawEdge below. */
const CARDINALITY_LINE_ENDS = { one: 'crowOne', many: 'crowMany', zeroOrOne: 'crowZeroOrOne', oneOrMany: 'crowOneOrMany' };

function ensurePageEl(app, tab) {
  let el = document.getElementById(`page-${tab.id}`);
  if (el) return el;
  el = document.createElement('div');
  el.id = `page-${tab.id}`;
  el.className = 'page-view';
  document.getElementById('pages-container').appendChild(el);
  return el;
}

function renderPages(app) {
  const container = document.getElementById('pages-container');
  for (const child of [...container.children]) {
    const tabId = child.id.replace('page-', '');
    if (!app.store.tabs.some((t) => t.id === tabId)) child.remove();
  }
  for (const tab of app.store.tabs) {
    const el = ensurePageEl(app, tab);
    el.classList.toggle('active', tab.id === app.store.activeTabId);
    if (tab.id !== app.store.activeTabId) continue; // only render the active page's contents
    if (tab.type === 'canvas') renderCanvasPage(app, tab, el);
    else if (tab.type === 'table') renderTablePage(app, tab, el);
    else if (tab.type === 'pdf') renderPdfPage(app, tab, el);
    else if (tab.type === 'docs') renderDocsPage(app, tab, el);
    else if (tab.type === '3d') renderView3DPage(app, tab, el);
    else renderTextPage(app, tab, el);
  }
}

// ===================== 3D VIEW PAGE =====================
// The vendored Three.js/OrbitControls (~800KB) only ever loads via this dynamic
// import() — triggered the first time a 3D tab is actually rendered, cached here after
// that so every later render() call for the same or another 3D tab reuses the already-
// loaded module instead of re-importing. Every other DyCAD module stays completely free
// of a 3D dependency; see view3d.js's own header comment for the full design.
let view3dModule = null;
let view3dLoadPromise = null;

function renderView3DPage(app, tab, container) {
  if (!view3dModule) {
    if (!view3dLoadPromise) {
      view3dLoadPromise = import('./view3d.js').then((mod) => {
        view3dModule = mod;
        app.render(); // re-dispatch now that the module is available
      });
    }
    if (!container.querySelector('.view3d-loading')) {
      container.innerHTML = '<div class="view3d-loading">Loading 3D view…</div>';
    }
    return;
  }
  // First render after the module finished loading — clear the placeholder text before
  // view3d.js appends its actual <canvas>, otherwise the two sit as siblings and the
  // unpositioned placeholder div (100% width/height) pushes the canvas out of view
  // beneath it instead of being replaced by it.
  if (container.querySelector('.view3d-loading')) container.innerHTML = '';
  view3dModule.renderView3D(app, tab, container);
}

/** Called from App.closeTab so a closed 3D tab's WebGL context/animation loop are torn
 * down instead of leaking (browsers cap how many live WebGL contexts a page can hold).
 * A no-op if the 3D module was never loaded (nothing to dispose) or this tab was never a
 * 3D tab in the first place. */
function disposeView3DTab(tabId) {
  if (view3dModule) view3dModule.disposeView3D(tabId);
}

/** The cached view3d.js module, if it's been loaded at least once (i.e. a 3D tab has
 * actually been rendered this session) — null otherwise. Lets a caller elsewhere in
 * the app (main.js's File > Export View as Image, for a 3D tab) reach view3d.js's own
 * exports synchronously, without importing it eagerly and defeating the whole point of
 * the lazy-load above, and without needing its own separate load-promise cache. Safe to
 * assume non-null whenever a 3D tab is the ACTIVE tab (rendering it once already
 * triggered the load), but callers should still null-check rather than assume it. */
function getView3DModule() {
  return view3dModule;
}

// ===================== CANVAS PAGE =====================
/** Stream visibility filter. null/undefined = no filter configured yet (show
 * everything) — an explicit empty array (set via either filter menu's "Select All /
 * Exclude All" top-row option) means "show nothing". Same convention
 * passesElementTypeFilter below uses. */
function passesStreamFilter(tab, streams) {
  if (tab.activeStreams == null) return true;
  return (streams || []).some((s) => tab.activeStreams.includes(s));
}

/** View-level element-TYPE visibility filter (distinct from the stream filter above,
 * same null-vs-empty-array convention). Connectors need no separate check: redrawEdges
 * already skips any connector whose endpoint isn't in the (already-filtered) partVms
 * list, so hiding a node's type here automatically hides its connectors too. */
function passesElementTypeFilter(tab, type) {
  if (tab.activeElementTypes == null) return true;
  return tab.activeElementTypes.includes(type);
}

/** Part.section visibility filter (distinct from stream/type above, same null-vs-
 * empty-array convention). A part with no section (`''`/undefined) is filtered as the
 * empty string, matching the '(no section)' option the filter menu offers for it —
 * unfiltered-by-default, but not silently unreachable once a section filter IS active.
 * Connectors need no separate check, same reasoning as passesElementTypeFilter above. */
function passesSectionFilter(tab, section) {
  if (tab.activeSections == null) return true;
  return tab.activeSections.includes(section || '');
}

/** "Connector levels" — whether any visibility filter above is actively narrowing
 * the view right now (as opposed to sitting in its default "show everything" state).
 * Connector-levels expansion only has any effect while this is true. */
function isAnyVisibilityFilterActive(tab) {
  return tab.activeStreams != null || tab.activeElementTypes != null || tab.activeSections != null;
}

/** BFS-expands a seed set of visible part-viewMember ids outward by `levels` hops,
 * walking this view's OWN connector-viewMembers only (never pulls in content from
 * elsewhere in the model that isn't already placed on this view). levels === 0 returns
 * the seed set unchanged (no expansion at all — connector visibility for that case is
 * handled by the caller, since level 0 means "no connectors at all", even between two
 * seed nodes, which is different from just "no new nodes"). levels === null/undefined
 * expands without a hop limit, until nothing new is reachable. */
function expandVisiblePartVmIdsByLevel(seedVmIds, allConnVms, levels) {
  if (levels === 0) return new Set(seedVmIds);
  const visible = new Set(seedVmIds);
  let frontier = new Set(seedVmIds);
  let hop = 0;
  while (frontier.size > 0 && (levels == null || hop < levels)) {
    const next = new Set();
    for (const cv of allConnVms) {
      if (!frontier.has(cv.fromVmId) && !frontier.has(cv.toVmId)) continue;
      if (!visible.has(cv.fromVmId)) { visible.add(cv.fromVmId); next.add(cv.fromVmId); }
      if (!visible.has(cv.toVmId)) { visible.add(cv.toVmId); next.add(cv.toVmId); }
    }
    frontier = next;
    hop += 1;
  }
  return visible;
}

function renderCanvasPage(app, tab, container) {
  if (!tab.viewport) tab.viewport = { x: 0, y: 0, zoom: 1 };
  if (!tab.viewport.zoom) tab.viewport.zoom = 1;

  container.innerHTML = '';
  const scroll = document.createElement('div');
  scroll.className = 'canvas-scroll';
  const surface = document.createElement('div');
  surface.className = 'canvas-surface';
  surface.style.zoom = String(tab.viewport.zoom);

  const view = app.store.findView(tab.viewId);
  const partVmsForSizing = app.store.viewMembersForView(tab.viewId).filter((vm) => vm.objectType === 'part');
  const { w: sizingNodeW, h: sizingNodeH } = getNodeSize(view);
  const contentMaxX = partVmsForSizing.length ? Math.max(...partVmsForSizing.map((vm) => vm.x + sizingNodeW)) : 0;
  const contentMaxY = partVmsForSizing.length ? Math.max(...partVmsForSizing.map((vm) => vm.y + sizingNodeH)) : 0;
  const surfaceW = Math.max(4000, contentMaxX + 500);
  const surfaceH = Math.max(3000, contentMaxY + 500);
  surface.style.width = `${surfaceW}px`;
  surface.style.height = `${surfaceH}px`;

  if (view && isSectionViewType(view.viewType)) {
    app.store.ensureViewSections(view);
    buildSectionsOverlay(app, tab, view, surface);
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'canvas-edges');
  svg.setAttribute('width', String(surfaceW));
  svg.setAttribute('height', String(surfaceH));
  const edgeLayer = document.createElementNS(svg.namespaceURI, 'g');
  edgeLayer.setAttribute('class', 'edge-layer');
  svg.appendChild(edgeLayer);

  surface.appendChild(svg);

  const vms = app.store.viewMembersForView(tab.viewId);
  const allPartVmsInView = vms.filter((vm) => vm.objectType === 'part');
  const allConnVmsInView = vms.filter((vm) => vm.objectType === 'connector');

  const seedVmIds = new Set();
  for (const vm of allPartVmsInView) {
    const part = app.store.findPart(vm.objectId) || {};
    if (passesStreamFilter(tab, part.streams) && passesElementTypeFilter(tab, part.type) && passesSectionFilter(tab, part.section)) seedVmIds.add(vm.id);
  }

  let partVms;
  if (isAnyVisibilityFilterActive(tab)) {
    // NOT `tab.connectorLevels ?? 0` — connectorLevels is always explicitly initialized
    // (never truly undefined), and `??` would incorrectly collapse an explicit null
    // ("unlimited") back down to 0 ("no expansion"), since ?? treats null as nullish too.
    const levels = tab.connectorLevels;
    const visiblePartVmIds = expandVisiblePartVmIdsByLevel(seedVmIds, allConnVmsInView, levels);
    partVms = allPartVmsInView.filter((vm) => visiblePartVmIds.has(vm.id));
  } else {
    partVms = allPartVmsInView;
  }
  // Connector visibility is NOT gated by connectorLevels (that setting only controls how
  // many extra hops of NODES to pull in, per instructions.html) — a connector between two
  // already-visible parts must always be offered to redrawEdges, which is the sole place
  // that decides per-connector visibility (stream filter + chkShowConnectorType/
  // chkShowStreamType/chkShowDataType view properties + both-endpoints-present check).
  const connVms = allConnVmsInView;

  const nodeEls = new Map();
  for (const pvm of partVms) {
    const part = app.store.findPart(pvm.objectId);
    if (!part) continue;
    const nodeEl = buildNodeEl(app, tab, pvm, part);
    surface.appendChild(nodeEl);
    nodeEls.set(pvm.id, nodeEl);
  }

  scroll.appendChild(surface);
  container.appendChild(scroll);

  // restore scroll position — full re-renders must never snap the canvas back to (0,0)
  scroll.scrollLeft = tab.viewport.x;
  scroll.scrollTop = tab.viewport.y;
  scroll.addEventListener('scroll', () => {
    tab.viewport.x = scroll.scrollLeft;
    tab.viewport.y = scroll.scrollTop;
  });

  redrawEdges(app, tab, edgeLayer, partVms, connVms);

  wireCanvasInteractions(app, tab, scroll, surface, svg, edgeLayer, nodeEls);
  buildZoomControls(app, tab, container, scroll, surface);
}

// One click of Spacing +/- on a 2+-node selection multiplies the selection's own
// spread by this ratio (or its reciprocal, for -) around the selection's own
// centroid — chosen to feel comparable to the whole-view stepper's own +0.2/-0.2 step
// off a base scale of 1 (roughly a 20% change per click), even though the two use
// different math (additive on a persisted scale vs. a flat multiplicative step with
// no persisted state of its own — see applySpacingRatioToVms's doc comment, state.js).
const SELECTION_SPACING_STEP_RATIO = 1.2;

// Reported directly as a follow-up: "Update spacing for vertical, horizontal, or
// both, when used with selected nodes; perhaps change existing <-> symbol to be
// toggle between vertical, horizonal, and both." The '↔' that used to be a static
// label inside .spacing-pct is now its own clickable button (.spacing-axis-toggle)
// cycling through these three — persisted on view.spacingAxis (a view-level display
// setting, same precedent as view.spacingScale itself) so it survives a reload the
// same way every other Remap/Spacing preference does. Only actually changes Spacing
// +/-'s BEHAVIOR while 2+ nodes are selected (applySpacingRatioToVms's own axis
// param) — the whole-view fallback (fewer than 2 selected) still always scales both
// x and y via the single spacingScale value, which has no separate per-axis concept
// to select between.
const SPACING_AXIS_ICONS = { both: '↔↕', horizontal: '↔', vertical: '↕' };
const SPACING_AXIS_LABELS = { both: 'Both', horizontal: 'Horizontal only', vertical: 'Vertical only' };
const SPACING_AXIS_CYCLE = { both: 'horizontal', horizontal: 'vertical', vertical: 'both' };

function buildZoomControls(app, tab, container, scroll, surface) {
  const wrap = document.createElement('div');
  wrap.className = 'zoom-controls';
  const view = app.store.findView(tab.viewId);
  const spacingPct = Math.round((view?.spacingScale ?? 1) * 100);
  const spacingAxis = view?.spacingAxis || 'both';
  wrap.innerHTML = `
    <button class="zoom-out" title="Zoom out">−</button>
    <span class="zoom-pct" title="Reset to 100%">${Math.round(tab.viewport.zoom * 100)}%</span>
    <button class="zoom-in" title="Zoom in">+</button>
    <span class="zoom-divider"></span>
    <button class="spacing-out" title="Decrease spacing between nodes">−</button>
    <button class="spacing-axis-toggle" title="Spacing direction (when 2+ nodes selected): ${SPACING_AXIS_LABELS[spacingAxis]} — click to cycle">${SPACING_AXIS_ICONS[spacingAxis]}</button>
    <span class="spacing-pct" title="Spacing between nodes">${spacingPct}%</span>
    <button class="spacing-in" title="Increase spacing between nodes">+</button>
  `;
  const applyZoom = (newZoom) => {
    const clamped = Math.min(3, Math.max(0.25, Math.round(newZoom * 20) / 20));
    // keep the viewport's visual center stable while zooming
    const rect = scroll.getBoundingClientRect();
    const centerX = scroll.scrollLeft + rect.width / 2;
    const centerY = scroll.scrollTop + rect.height / 2;
    const ratio = clamped / tab.viewport.zoom;
    tab.viewport.zoom = clamped;
    surface.style.zoom = String(clamped);
    scroll.scrollLeft = centerX * ratio - rect.width / 2;
    scroll.scrollTop = centerY * ratio - rect.height / 2;
    tab.viewport.x = scroll.scrollLeft;
    tab.viewport.y = scroll.scrollTop;
    wrap.querySelector('.zoom-pct').textContent = `${Math.round(clamped * 100)}%`;
  };
  wrap.querySelector('.zoom-in').addEventListener('click', () => applyZoom(tab.viewport.zoom + 0.1));
  wrap.querySelector('.zoom-out').addEventListener('click', () => applyZoom(tab.viewport.zoom - 0.1));
  wrap.querySelector('.zoom-pct').addEventListener('click', () => applyZoom(1));

  // Reported directly: "if multiple nodes selected, apply 'Spacing' command increase
  // or decrease only to selected nodes and update their x,y without changing view
  // spacing value." Only meaningful for freeform views — a section-based view's node
  // positions come from row/col grid math driven by view.spacingScale itself (see
  // applySpacingScale's own doc comment), not independent x/y a subset could be
  // scaled apart from the rest without conflicting with that grid on the next
  // section-layout pass. With fewer than 2 nodes selected (or a section view), the
  // button keeps its original whole-view behavior unchanged.
  const selectedPartVmIdsForSpacing = () => [...tab.selection].filter((id) => app.store.findViewMember(id)?.objectType === 'part');
  const axisPhraseFor = (axis) => (axis === 'horizontal' ? 'horizontal spacing for' : axis === 'vertical' ? 'vertical spacing for' : 'spacing for');
  wrap.querySelector('.spacing-axis-toggle').addEventListener('click', () => {
    const v = app.store.findView(tab.viewId);
    v.spacingAxis = SPACING_AXIS_CYCLE[v.spacingAxis || 'both'];
    app.recordAndRender();
  });
  wrap.querySelector('.spacing-in').addEventListener('click', () => {
    const v = app.store.findView(tab.viewId);
    const selectedVmIds = selectedPartVmIdsForSpacing();
    if (ciEq(v.viewType, 'ff') && selectedVmIds.length >= 2) {
      const axis = v.spacingAxis || 'both';
      app.store.applySpacingRatioToVms(selectedVmIds, SELECTION_SPACING_STEP_RATIO, axis);
      app.toast(`Increased ${axisPhraseFor(axis)} ${selectedVmIds.length} selected nodes.`);
    } else {
      const oldScale = v.spacingScale || 1;
      app.store.applySpacingScale(tab.viewId, oldScale + 0.2);
      if (isSectionViewType(v.viewType)) rescaleSectionPositions(app.store, v, { spacingScale: oldScale });
    }
    app.recordAndRender();
  });
  wrap.querySelector('.spacing-out').addEventListener('click', () => {
    const v = app.store.findView(tab.viewId);
    const selectedVmIds = selectedPartVmIdsForSpacing();
    if (ciEq(v.viewType, 'ff') && selectedVmIds.length >= 2) {
      const axis = v.spacingAxis || 'both';
      app.store.applySpacingRatioToVms(selectedVmIds, 1 / SELECTION_SPACING_STEP_RATIO, axis);
      app.toast(`Decreased ${axisPhraseFor(axis)} ${selectedVmIds.length} selected nodes.`);
    } else {
      const oldScale = v.spacingScale || 1;
      app.store.applySpacingScale(tab.viewId, oldScale - 0.2);
      if (isSectionViewType(v.viewType)) rescaleSectionPositions(app.store, v, { spacingScale: oldScale });
    }
    app.recordAndRender();
  });

  // Ctrl/Cmd + wheel to zoom, centered on the pointer
  scroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const rect = scroll.getBoundingClientRect();
    const pointerX = scroll.scrollLeft + (e.clientX - rect.left);
    const pointerY = scroll.scrollTop + (e.clientY - rect.top);
    const clamped = Math.min(3, Math.max(0.25, Math.round((tab.viewport.zoom - e.deltaY * 0.001) * 20) / 20));
    const ratio = clamped / tab.viewport.zoom;
    tab.viewport.zoom = clamped;
    surface.style.zoom = String(clamped);
    scroll.scrollLeft = pointerX * ratio - (e.clientX - rect.left);
    scroll.scrollTop = pointerY * ratio - (e.clientY - rect.top);
    tab.viewport.x = scroll.scrollLeft;
    tab.viewport.y = scroll.scrollTop;
    wrap.querySelector('.zoom-pct').textContent = `${Math.round(clamped * 100)}%`;
  }, { passive: false });

  container.appendChild(wrap);
}

function redrawEdges(app, tab, edgeLayer, partVms, connVms) {
  edgeLayer.innerHTML = '';
  const view = app.store.findView(tab.viewId);
  const partVmById = new Map(partVms.map((v) => [v.id, v]));
  for (const cvm of connVms) {
    const conn = app.store.findConnector(cvm.objectId);
    if (!conn) continue;
    if (!passesStreamFilter(tab, conn.streams)) continue;
    if (conn.connectorType === 'c' && view?.chkShowConnectorType === false) continue;
    if (conn.connectorType === 's' && view?.chkShowStreamType === false) continue;
    if (conn.connectorType === 'd' && view?.chkShowDataType === false) continue;
    const fromVm = partVmById.get(cvm.fromVmId);
    const toVm = partVmById.get(cvm.toVmId);
    if (!fromVm || !toVm) continue;
    drawEdge(app, edgeLayer, cvm, conn, fromVm, toVm, tab, partVms);
  }
}

function buildSectionsOverlay(app, tab, view, surface) {
  const layout = computeSectionLayout(view);
  for (const entry of layout) {
    const box = document.createElement('div');
    box.className = 'section-box';
    box.style.left = `${entry.left}px`;
    box.style.top = `${entry.top}px`;
    box.style.width = `${entry.width}px`;
    box.style.height = `${entry.height}px`;
    if (tab.selectedSectionId === entry.section.id) box.classList.add('selected');

    const header = document.createElement('div');
    header.className = 'section-header';
    header.style.height = `${entry.headerHeight}px`;
    header.textContent = entry.section.name || '(untitled section)';
    header.title = 'Click to edit this section';
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      app.selectSection(tab, entry.section.id);
    });
    box.appendChild(header);

    const body = document.createElement('div');
    body.className = 'section-body';
    body.style.top = `${entry.headerHeight}px`;
    body.style.backgroundSize = `${CELL_W}px ${CELL_H}px`;
    box.appendChild(body);

    surface.appendChild(box);
  }
}


function buildMarkerDefs(store) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('id', 'global-marker-defs');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.style.pointerEvents = 'none';
  const defs = document.createElementNS(svg.namespaceURI, 'defs');
  const lineEnds = store.settings.lineEnds || {};
  // Sizes reduced by 1/3 from their original values (10/14/20 -> 7/9/13, i.e. 2/3 of
  // the original) per a direct request to shrink line-end graphics (arrows etc.).
  const sizes = { small: 7, medium: 9, large: 13 };
  for (const [name, le] of Object.entries(lineEnds)) {
    if (!le.path) continue;
    for (const [sizeName, px] of Object.entries(sizes)) {
      const marker = document.createElementNS(svg.namespaceURI, 'marker');
      marker.setAttribute('id', `marker-${name}-${sizeName}`);
      marker.setAttribute('viewBox', '-12 -2 24 24');
      marker.setAttribute('markerWidth', String(px));
      marker.setAttribute('markerHeight', String(px));
      marker.setAttribute('refX', '0');
      marker.setAttribute('refY', '10');
      marker.setAttribute('orient', 'auto-start-reverse');
      const g = document.createElementNS(svg.namespaceURI, 'g');
      g.setAttribute('transform', 'rotate(90 0 10)'); // 90° clockwise around the marker's refX/refY
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', le.path);
      path.setAttribute('fill', le.fill || 'none');
      path.setAttribute('stroke', le.stroke || 'black');
      g.appendChild(path);
      marker.appendChild(g);
      defs.appendChild(marker);
    }
  }
  svg.appendChild(defs);
  return svg;
}

function rectsOverlap(r1, r2) {
  return r1.left <= r2.right && r1.right >= r2.left && r1.top <= r2.bottom && r1.bottom >= r2.top;
}
function pointInRect(p, rect) { return p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom; }
function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function segmentIntersectsRect(p1, p2, rect) {
  if (pointInRect(p1, rect) || pointInRect(p2, rect)) return true;
  const c = [{ x: rect.left, y: rect.top }, { x: rect.right, y: rect.top }, { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom }];
  for (let i = 0; i < 4; i++) if (segmentsIntersect(p1, p2, c[i], c[(i + 1) % 4])) return true;
  return false;
}
export { rectsOverlap, pointInRect, cross, segmentsIntersect, segmentIntersectsRect };

const NODE_HALF_W = 65, NODE_HALF_H = 23; // fallback default (130x46), used when no view is available

/** Current node box size for a view (defaults to 130x46 if the view has never been redrawn). */
function getNodeSize(view) {
  const w = view?.nodeWidth || 130, h = view?.nodeHeight || 46;
  return { w, h, halfW: w / 2, halfH: h / 2 };
}

/** Project a point outward from a rectangle's center toward (dx,dy) to the rectangle's edge. */
function clipToRectEdge(cx, cy, dx, dy, halfW, halfH) {
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function edgeEndpoints(fromVm, toVm, view) {
  const { halfW, halfH } = getNodeSize(view);
  const fCenter = { x: fromVm.x + halfW, y: fromVm.y + halfH };
  const tCenter = { x: toVm.x + halfW, y: toVm.y + halfH };
  const dx = tCenter.x - fCenter.x, dy = tCenter.y - fCenter.y;
  // extra margin so the marker sits fully clear of the node rather than overlapping its border
  const margin = 11;
  const fc = clipToRectEdge(fCenter.x, fCenter.y, dx, dy, halfW + margin, halfH + margin);
  const tc = clipToRectEdge(tCenter.x, tCenter.y, -dx, -dy, halfW + margin, halfH + margin);
  return { fc, tc };
}

function drawEdge(app, edgeLayer, cvm, conn, fromVm, toVm, tab, allPartVms) {
  const view = app.store.findView(tab.viewId);
  const { fc, tc } = edgeEndpoints(fromVm, toVm, view);
  // Separate routing settings per connector type — 'c' (regular) uses view.routingStyle,
  // 's' (stream) uses view.routingStyleStream, so a person can e.g. keep regular
  // connectors curved while routing stream connectors around obstacles, or vice versa.
  const routingStyle = (conn.connectorType === 's' ? view?.routingStyleStream : view?.routingStyle) || 'default';
  // 'default' | 'straight' | 'direct' | 'manhattan'

  let pathPoints = null;
  if ((routingStyle === 'direct' || routingStyle === 'manhattan') && allPartVms) {
    const { w, h } = getNodeSize(view);
    const otherVms = allPartVms.filter((vm) => vm.id !== fromVm.id && vm.id !== toVm.id);
    pathPoints = computeRoutedPath(fromVm, toVm, fc, tc, otherVms, w, h, routingStyle, segmentIntersectsRect);
  }

  let d;
  if (routingStyle === 'straight') {
    // Explicit, unconditional straight line — distinct from 'default', which still
    // draws 'c'-type connectors as a gentle curve. This always draws a plain line
    // regardless of connectorType, with no obstacle avoidance.
    d = `M ${fc.x} ${fc.y} L ${tc.x} ${tc.y}`;
  } else if (routingStyle === 'manhattan' && pathPoints) {
    // always axis-aligned segments, even in the trivial (no-obstacle) elbow case — never
    // a curve, since the whole point of this mode is right angles only.
    d = `M ${pathPoints[0].x} ${pathPoints[0].y} ` + pathPoints.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ');
  } else if (routingStyle === 'direct' && pathPoints && pathPoints.length > 2) {
    // had to route around something — straight polyline segments through the waypoints
    d = `M ${pathPoints[0].x} ${pathPoints[0].y} ` + pathPoints.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ');
  } else if (conn.connectorType === 'c') {
    // clear path (routingStyle 'default', or 'direct' with nothing in the way) — the
    // original gentle-curve look is preserved rather than forcing a plain straight line
    // just because obstacle-avoidance is technically available.
    const midX = (fc.x + tc.x) / 2, midY = (fc.y + tc.y) / 2;
    const dx = tc.x - fc.x, dy = tc.y - fc.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const curveOffset = 30;
    const ctrlX = midX + (-dy / len) * curveOffset, ctrlY = midY + (dx / len) * curveOffset;
    d = `M ${fc.x} ${fc.y} Q ${ctrlX} ${ctrlY} ${tc.x} ${tc.y}`;
  } else {
    d = `M ${fc.x} ${fc.y} L ${tc.x} ${tc.y}`;
  }
  const selected = tab.selection.has(cvm.id);

  // relationship line drawing is always looked up live via relationshipStyle.type === connector.relationship
  const style = (app.store.settings.relationshipStyles || []).find((s) => ciEq(s.type, conn.relationship));
  const stroke = style?.stroke ?? conn.stroke ?? '#333';
  const strokeWidth = style?.strokeWidth ?? conn.strokeWidth ?? 2;
  const dash = style?.dash ?? conn.dash ?? [];
  const fill = style?.fill ?? conn.fill ?? '#333';

  const path = document.createElementNS(edgeLayer.namespaceURI, 'path');
  path.setAttribute('d', d);
  path.setAttribute('stroke', selected ? '#3b5bfd' : stroke);
  path.setAttribute('stroke-width', String(selected ? Math.max(strokeWidth, 2.5) : strokeWidth));
  path.setAttribute('fill', 'none');
  if (dash.length) path.setAttribute('stroke-dasharray', dash.join(','));
  // Crow's-foot (Data Modeling) connectors: line ends come from the connector's OWN
  // fromCardinality/toCardinality, not the relationship-driven lineEnds lookup every
  // other connector uses — a cardinality symbol describes THIS relationship's shape,
  // not a fixed per-relationship-type style. Falls through to the normal
  // relationship-driven lookup when no cardinality is set (e.g. a fresh 'd' connector
  // before its ends are configured), so it never renders with no marker at all.
  const toLineEndType = (conn.connectorType === 'd' && CARDINALITY_LINE_ENDS[conn.toCardinality]) || style?.toLineEndSettingType;
  const fromLineEndType = (conn.connectorType === 'd' && CARDINALITY_LINE_ENDS[conn.fromCardinality]) || style?.fromLineEndSettingType;
  if (toLineEndType && app.store.settings.lineEnds[toLineEndType]?.path) {
    path.setAttribute('marker-end', `url(#marker-${toLineEndType}-${conn.endSize || 'medium'})`);
  }
  if (fromLineEndType && app.store.settings.lineEnds[fromLineEndType]?.path) {
    path.setAttribute('marker-start', `url(#marker-${fromLineEndType}-${conn.endSize || 'medium'})`);
  }
  edgeLayer.appendChild(path);

  const hit = document.createElementNS(edgeLayer.namespaceURI, 'path');
  hit.setAttribute('d', d);
  hit.setAttribute('stroke', 'transparent');
  hit.setAttribute('stroke-width', '14');
  hit.setAttribute('fill', 'none');
  hit.setAttribute('class', 'edge-hit');
  hit.dataset.vmId = cvm.id;
  hit.addEventListener('click', (e) => {
    e.stopPropagation();
    app.selectOnly(cvm.id);
    app.showEdgePopover(cvm, conn, e.clientX, e.clientY);
  });
  if (style?.type || conn.relationship) {
    let sharedStreams = [];
    if (conn.connectorType === 's') {
      const fromPart = app.store.findPart(conn.from);
      const toPart = app.store.findPart(conn.to);
      sharedStreams = (conn.streams || []).filter(
        (s) => (fromPart?.streams || []).includes(s) && (toPart?.streams || []).includes(s)
      );
    }
    const lineTitle = document.createElementNS(edgeLayer.namespaceURI, 'title');
    lineTitle.textContent = (style?.type || conn.relationship) + (sharedStreams.length ? `\nStreams: ${sharedStreams.join(', ')}` : '');
    hit.appendChild(lineTitle);
  }
  edgeLayer.appendChild(hit);

  // small hoverable dots at each endpoint carry the from/to role-name tooltips
  if (style?.ABRoleName || style?.BARoleName) {
    const endpointDot = (pt, roleName) => {
      const c = document.createElementNS(edgeLayer.namespaceURI, 'circle');
      c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); c.setAttribute('r', '6');
      c.setAttribute('fill', 'transparent');
      c.style.pointerEvents = 'auto';
      const t = document.createElementNS(edgeLayer.namespaceURI, 'title');
      t.textContent = roleName;
      c.appendChild(t);
      edgeLayer.appendChild(c);
    };
    if (style.ABRoleName) endpointDot(fc, style.ABRoleName);
    if (style.BARoleName) endpointDot(tc, style.BARoleName);
  }

  if (view?.chkShowKeys) {
    const midX = (fc.x + tc.x) / 2, midY = (fc.y + tc.y) / 2;
    const label = document.createElementNS(edgeLayer.namespaceURI, 'text');
    label.setAttribute('x', midX);
    label.setAttribute('y', midY - 10);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '9');
    label.setAttribute('fill', 'currentColor');
    label.setAttribute('opacity', '0.6');
    const line1 = document.createElementNS(edgeLayer.namespaceURI, 'tspan');
    line1.setAttribute('x', midX);
    line1.setAttribute('dy', '0');
    line1.textContent = `vm:${cvm.id}`;
    const line2 = document.createElementNS(edgeLayer.namespaceURI, 'tspan');
    line2.setAttribute('x', midX);
    line2.setAttribute('dy', '11');
    line2.textContent = `obj:${conn.id}`;
    label.appendChild(line1);
    label.appendChild(line2);
    edgeLayer.appendChild(label);
  }
}

function formatSimValue(v) {
  if (v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string') return v.length > 12 ? `${v.slice(0, 12)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 12 ? `${s.slice(0, 12)}…` : s;
  } catch {
    return String(v);
  }
}

function buildNodeEl(app, tab, vm, part) {
  const el = document.createElement('div');
  el.className = 'fnode' + (vm.isExternal ? ' external' : '') + (tab.selection.has(vm.id) ? ' selected' : '');
  el.style.left = `${vm.x}px`;
  el.style.top = `${vm.y}px`;
  el.style.background = vm.fillColor || elementGroupFill(app, part.type);
  el.dataset.vmId = vm.id;

  const elDef = elementByType(app.store, part.type);
  el.style.borderRadius = `${elDef?.cornerRadius ?? 7}px`;

  const view = app.store.findView(tab.viewId);
  const { w, h } = getNodeSize(view);
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  const showTypes = view?.chkShowElementTypes;
  const showKeys = view?.chkShowKeys;
  const showDescription = view?.chkShowDescription;
  // Reported directly: "In redraw command for a view, add option something like 'show
  // all text' checkbox and if selected resize default size for text that fits and
  // full size that displays all text of node such as long descriptions." Without
  // this, redrawNodeSizes below already measures the FULL label (it always has —
  // .fnode-label's own -webkit-line-clamp:2 is a display-time-only truncation,
  // unrelated to sizing) but .fnode-description stays clamped to 2 lines even after a
  // taller box is sized for it, wasting the extra room instead of showing more text.
  // view.chkShowAllText (persisted on the view itself, same as any other view.chkShowXxx
  // field — retained "for the specific view for future sessions" the same way, via
  // Save/Load JSON) removes BOTH clamps at actual render time too, not just during
  // measurement, so a Redraw genuinely displays the full text it sized for.
  const noClampStyle = view?.chkShowAllText ? ' style="-webkit-line-clamp:unset;display:block;overflow:visible;"' : '';

  // Data Modeling: a DataEntityDetails node shows its own attribute list right on the
  // canvas (name : dataType, PK marked, FK looked up live the same way the property
  // panel's own attribute table does — see isAttributeForeignKey, render.js) instead
  // of only in the side panel, gated by its own view toggle (chkShowAttributes,
  // sibling to chkShowDescription/chkShowKeys). Node height/width is uniform per
  // VIEW, not per node (getNodeSize above) — redrawNodeSizes' own content-measuring
  // pass (canvas.js) already grows the whole view to fit whatever's actually
  // rendered here, so a view containing wide attribute lists ends up with taller
  // nodes across the board rather than needing a separate per-node sizing mechanism.
  let attributesHtml = '';
  if (view?.chkShowAttributes && ciEq(part.type, 'DataEntityDetails') && (part.attributes || []).length) {
    const rows = part.attributes.map((a) => {
      const pk = a.isPrimaryKey ? '🔑 ' : '';
      const fk = isAttributeForeignKey(app.store, a.id) ? ' (FK)' : '';
      return `<div class="fnode-attr-row">${pk}${escapeHtml(a.name || '(unnamed)')}${fk}: ${escapeHtml(a.dataType || '')}</div>`;
    }).join('');
    attributesHtml = `<div class="fnode-attributes">${rows}</div>`;
  }

  let simBadgeHtml = '';
  if (view?.chkShowSimValues) {
    // Badges reflect the PART's shared simulation state (scoped to its own model), not
    // anything view/tab-specific — every viewMember referencing the same part shows the
    // identical value, in every view, regardless of which model is currently selected in
    // the Simulation toolbar.
    const runtime = app.store.simRuntime.get(part.model);
    const entry = runtime ? runtime.values.get(part.id) : null;
    if (entry) {
      const hasError = !!entry.lastError;
      const display = hasError ? 'ERR' : formatSimValue(entry.value);
      const title = hasError ? entry.lastError : `tick ${entry.lastTick}: ${formatSimValue(entry.value)}`;
      // "changed" (Step 33) is a lower-priority visual than error — only applied when
      // there's no error, so a node can't show both states confusingly at once.
      const stateClass = hasError ? ' error' : (entry.changed ? ' changed' : '');
      simBadgeHtml = `<div class="fnode-sim-badge${stateClass}" title="${escapeHtml(title)}">${escapeHtml(display)}</div>`;
    }
  }

  // Script-controlled badge: separate from the auto-computed value badge above — full
  // freeform text/color, driven entirely by whatever the script returned as `badge` this
  // tick (nothing shown if it didn't return one), gated by its own view toggle so it can
  // be shown/hidden independently of chkShowSimValues.
  let scriptBadgeHtml = '';
  if (view?.chkShowScriptBadge) {
    const runtime = app.store.simRuntime.get(part.model);
    const entry = runtime ? runtime.values.get(part.id) : null;
    if (entry && entry.badge) {
      scriptBadgeHtml = `<div class="fnode-sim-badge-right" style="background:${escapeHtml(entry.badge.color)};" title="${escapeHtml(entry.badge.text)}">${escapeHtml(entry.badge.text)}</div>`;
    }
  }

  el.innerHTML = `
    <div class="fnode-toprow">
      ${showTypes ? `<div class="fnode-type">${escapeHtml(elDef?.title || part.type)}</div>` : '<span></span>'}
      <span class="fnode-icon" title="${escapeHtml(part.type)}">${iconSvgFor(app, elDef)}</span>
    </div>
    <div class="fnode-label"${noClampStyle}>${escapeHtml(part.label)}</div>
    ${showDescription && part.description ? `<div class="fnode-description"${noClampStyle}>${escapeHtml(part.description)}</div>` : ''}
    ${attributesHtml}
    ${showKeys ? `<div class="fnode-type" style="opacity:.5;">vm:${escapeHtml(vm.id)}<br>obj:${escapeHtml(part.id)}</div>` : ''}
    ${part.order > 0 ? `<div class="fnode-badge">${part.order}</div>` : ''}
    ${simBadgeHtml}
    ${scriptBadgeHtml}
    <div class="fnode-handle" title="Drag to connect"></div>
  `;
  return el;
}

function elementGroupFill(app, type) {
  return groupFill(app, elementByType(app.store, type));
}

/**
 * Redraw command: measure the natural content size of every node in this view (current
 * label text, and whether chkShowKeys/chkShowElementTypes are on) and set the view's
 * uniform node size to fit the largest one, clamped to a sane range.
 */
function redrawNodeSizes(app, tab) {
  const view = app.store.findView(tab.viewId);
  if (!view) return false;
  const partVms = app.store.viewMembersForView(tab.viewId).filter((vm) => vm.objectType === 'part');
  if (partVms.length === 0) return false;

  const measureHost = document.createElement('div');
  measureHost.style.position = 'fixed';
  measureHost.style.visibility = 'hidden';
  measureHost.style.left = '-99999px';
  measureHost.style.top = '0';
  document.body.appendChild(measureHost);

  // Index parts by id once (O(total parts)) instead of calling app.store.findPart(...)
  // — an uncached ciEq-based linear scan over doc.parts — once per node below. That scan,
  // repeated once per node in the view, was a second confirmed O(m²) cost here (found via
  // CPU profile, same investigation as the DOM-batching fix below): a large generated
  // view's Redraw call was re-scanning the whole, similarly-large parts array for every
  // single one of its own nodes.
  const partById = new Map();
  for (const p of app.store.doc.parts) partById.set(p.id, p);

  // Batch every node's measurement element into the DOM in one pass, THEN read all their
  // rects, THEN remove them all — not append/read/remove one node at a time. Each
  // getBoundingClientRect() forces a synchronous layout reflow if anything dirtied
  // layout since the last read; interleaving writes and reads per-node was forcing a
  // full reflow per node, which dominated wall-clock time on a large generated view
  // (thousands of nodes). Batched, only the first read below pays for a reflow — every
  // read after that is free since nothing changes layout in between.
  const measured = [];
  for (const vm of partVms) {
    const part = partById.get(vm.objectId);
    if (!part) continue;
    const el = buildNodeEl(app, tab, vm, part);
    el.style.position = 'static';
    el.style.width = 'auto';
    el.style.height = 'auto';
    el.style.maxWidth = '260px';
    const labelEl = el.querySelector('.fnode-label');
    if (labelEl) { labelEl.style.webkitLineClamp = 'unset'; labelEl.style.display = 'block'; labelEl.style.overflow = 'visible'; }
    measureHost.appendChild(el);
    measured.push(el);
  }

  let maxW = 100, maxH = 40;
  for (const el of measured) {
    const rect = el.getBoundingClientRect();
    maxW = Math.max(maxW, Math.ceil(rect.width) + 4);
    maxH = Math.max(maxH, Math.ceil(rect.height) + 4);
  }
  document.body.removeChild(measureHost);

  const oldNodeWidth = view.nodeWidth, oldNodeHeight = view.nodeHeight;
  const newNodeWidth = Math.min(Math.max(maxW, 100), 260);
  // 600 (not 140): a DataEntityDetails node with its own attribute list rendered
  // on-canvas (chkShowAttributes) grows roughly linearly with column count — a table
  // with 8-9 columns (a perfectly ordinary DDL import, not a pathological case) already
  // needed more than the old 140px cap, so its LAST attribute row(s) silently
  // overflowed the node's fixed-height box (no overflow:hidden on .fnode itself,
  // so this wasn't invisible clipping — it visually overlapped whatever sat below the
  // node on the canvas). Reported directly, with a real two-table DDL fixture (9 and 8
  // columns) confirmed via getBoundingClientRect()/scrollHeight to overflow the old cap
  // by 3-5px. 600px comfortably fits ~40 attribute rows before hitting the new ceiling
  // — still a real ceiling (an accidentally pasted, truly enormous table doesn't blow
  // up every other node in a uniform-per-view-sized view without limit), just sized for
  // realistic schemas instead of the old chrome-only-content estimate.
  const newNodeHeight = Math.min(Math.max(maxH, 40), 600);
  view.nodeWidth = newNodeWidth;
  view.nodeHeight = newNodeHeight;
  // Section-based views: the grid's cell size derives from nodeWidth/nodeHeight, so a
  // size change here also needs existing nodes re-snapped to the newly-resized grid —
  // otherwise sections stay their old size (nodes overflowing cells, or wasted empty
  // space) and node positions drift out of alignment with the new grid lines.
  if (isSectionViewType(view.viewType) && (oldNodeWidth !== newNodeWidth || oldNodeHeight !== newNodeHeight)) {
    rescaleSectionPositions(app.store, view, { nodeWidth: oldNodeWidth, nodeHeight: oldNodeHeight });
  }
  return true;
}

/**
 * After a node size change (e.g. from redrawNodeSizes), nudge any node that now
 * overlaps an already-processed one to the nearest free spot — a lighter-weight pass
 * than a full Remap: existing positions are preserved as much as possible, only
 * genuinely-overlapping nodes move.
 */
function resolveOverlapsForView(app, tab) {
  const view = app.store.findView(tab.viewId);
  if (!view) return;
  const { w, h } = getNodeSize(view);
  const partVms = app.store.viewMembersForView(tab.viewId).filter((vm) => vm.objectType === 'part');

  // Spatial grid index instead of a linear "placed.some(...)" scan against every
  // already-placed node — that was O(m²) in view size, a real bottleneck after a bulk
  // generation into a large view (thousands of nodes). Cell size matches the overlap
  // test's own reach (w+4, h+4), so two nodes can only possibly overlap if they land in
  // the same or an adjacent cell — checking just that 3x3 neighborhood instead of every
  // prior node makes this ~O(m) amortized. Overlap condition itself is unchanged.
  const cellW = w + 4, cellH = h + 4;
  const grid = new Map(); // "cellX,cellY" -> array of already-placed vms in that cell
  const overlapsAny = (vm) => {
    const cx = Math.floor(vm.x / cellW), cy = Math.floor(vm.y / cellH);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const p of bucket) {
          if (Math.abs(p.x - vm.x) < cellW && Math.abs(p.y - vm.y) < cellH) return true;
        }
      }
    }
    return false;
  };
  const addToGrid = (vm) => {
    const key = `${Math.floor(vm.x / cellW)},${Math.floor(vm.y / cellH)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(vm);
  };

  for (const vm of partVms) {
    if (overlapsAny(vm)) {
      const free = app.store.findNonOverlappingPosition(tab.viewId, vm.x, vm.y, vm.id, w, h);
      vm.x = free.x; vm.y = free.y;
    }
    addToGrid(vm);
  }
}

/** Recalculate node size and resolve any resulting overlaps — call after any view
 * toggle that changes what content each node displays (keys, types, description), or
 * after an explicit Redraw. Returns the same boolean redrawNodeSizes does (false when
 * there was nothing to measure), so callers can still show an accurate toast. */
function redrawAndResolveLayout(app, tab) {
  const didRedraw = redrawNodeSizes(app, tab);
  if (didRedraw) resolveOverlapsForView(app, tab);
  return didRedraw;
}

// ===================== INTERACTIONS (per-page; only element-local listeners) =====================
function wireCanvasInteractions(app, tab, scroll, surface, svg, edgeLayer, nodeEls) {
  const zoom = () => tab.viewport?.zoom || 1;

  for (const [vmId, el] of nodeEls) {
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      app.openOrCreateLinkedView(tab, vmId);
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      tab.selection.clear();
      tab.selection.add(vmId);
      tab.selectedSectionId = null;
      app.render();
      const rect = surface.getBoundingClientRect();
      const z = zoom();
      app.showCanvasContextMenu(e.clientX, e.clientY, { x: (e.clientX - rect.left) / z, y: (e.clientY - rect.top) / z });
    });

    el.querySelector('.fnode-handle').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const rect = surface.getBoundingClientRect();
      const x = (e.clientX - rect.left) / zoom(), y = (e.clientY - rect.top) / zoom();
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('id', 'temp-connect-line');
      line.setAttribute('x1', x);
      line.setAttribute('y1', y);
      line.setAttribute('x2', x);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', '#3b5bfd');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-dasharray', '4,3');
      svg.appendChild(line);
      app.connectState = { tab, fromVmId: vmId, surface, getZoom: zoom };
    });

    el.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('fnode-handle')) return;
      e.stopPropagation();
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      let selectionChanged = false;
      if (!tab.selection.has(vmId)) {
        if (!additive) tab.selection.clear();
        tab.selection.add(vmId);
        tab.selectedSectionId = null;
        selectionChanged = true;
      } else if (additive) {
        tab.selection.delete(vmId);
        selectionChanged = true;
      }
      if (selectionChanged) app.render();
      if (!tab.selection.has(vmId)) return;

      const startX = e.clientX, startY = e.clientY;
      const startPositions = new Map();
      for (const id of tab.selection) {
        const vm = app.store.findViewMember(id);
        if (vm && vm.objectType === 'part') startPositions.set(id, { x: vm.x, y: vm.y, el: document.querySelector(`#page-${tab.id} .fnode[data-vm-id="${id}"]`) });
      }
      let moved = false;

      const onMove = (ev) => {
        const z = zoom();
        const dx = (ev.clientX - startX) / z, dy = (ev.clientY - startY) / z;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        for (const [id, pos] of startPositions) {
          const vm = app.store.findViewMember(id);
          if (!vm) continue;
          vm.x = pos.x + dx;
          vm.y = pos.y + dy;
          if (pos.el) { pos.el.style.left = `${vm.x}px`; pos.el.style.top = `${vm.y}px`; }
        }
        const freshVms = app.store.viewMembersForView(tab.viewId).filter((v) => v.objectType === 'part');
        const freshConns = app.store.viewMembersForView(tab.viewId).filter((v) => v.objectType === 'connector');
        redrawEdges(app, tab, edgeLayer, freshVms, freshConns);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        const view = app.store.findView(tab.viewId);
        if (moved && view && isSectionViewType(view.viewType)) {
          // Each rejection gets its own specific rule reference — which section, what
          // it actually allows, and what the rejected node's type is — rather than a
          // single generic "some nodes were rejected" message that gives no way to tell
          // why. A single rejection shows that full detail as the toast itself; multiple
          // rejections in one drag keep the toast short but every individual reason
          // still goes to the Message Log (also true of every error-style toast, since
          // app.toast(msg, true) always logs — see main.js).
          const rejections = [];
          const grownSections = new Set();
          for (const [id, pos] of startPositions) {
            const vm = app.store.findViewMember(id);
            if (!vm) continue;
            const part = app.store.findPart(vm.objectId);
            const snap = pixelToNearestGrid(view, vm.x, vm.y);
            if (snap && part && isTypeAllowedInSection(snap.layoutEntry.section, part.type)) {
              // If the resolved cell is already occupied by a DIFFERENT node, dropping
              // straight onto it would silently stack the two nodes — the dropped one
              // rendering on top and hiding the other entirely, with no visual sign
              // anything went wrong. Find the nearest genuinely empty cell instead; if
              // the whole section is full, grow it by a row rather than accept the
              // overlap (drag-and-drop specifically — other placement paths, like
              // Populate From Template, keep their existing "accept the overlap"
              // fallback, since silently growing a template's section on every import
              // wasn't asked for and could surprise someone re-populating a view).
              const occupant = app.store.viewMembersForView(tab.viewId).find(
                (other) => other.objectType === 'part' && other.id !== id && other.x === snap.x && other.y === snap.y
              );
              const rowCountBefore = snap.layoutEntry.section.rowCount;
              const dest = occupant
                ? findFreeCellOrGrowSection(app.store, tab.viewId, snap.layoutEntry, snap.row, snap.col, id)
                : { x: snap.x, y: snap.y };
              if (occupant && snap.layoutEntry.section.rowCount !== rowCountBefore) grownSections.add(snap.layoutEntry.section.name);
              vm.x = dest.x; vm.y = dest.y; vm.sectionId = snap.layoutEntry.section.sectionId;
            } else {
              vm.x = pos.x; vm.y = pos.y; // revert — not a valid placement
              if (snap && part) {
                const allowed = snap.layoutEntry.section.elementTypes || [];
                const allowedText = allowed.includes('*') ? 'any type' : allowed.length === 0 ? 'no element types at all' : allowed.join(', ');
                rejections.push(`"${part.label}" (${part.type}) cannot be placed in section "${snap.layoutEntry.section.name}" — that section only allows: ${allowedText}.`);
              }
            }
          }
          for (const sectionName of grownSections) app.toast(`Section "${sectionName}" was full — added a new row to fit the dropped node.`);
          if (rejections.length === 1) {
            app.toast(rejections[0], true);
          } else if (rejections.length > 1) {
            app.toast(`${rejections.length} nodes were not allowed in their target section and were returned to their original spot.`, true);
            for (const r of rejections) pushMessageLog(app.store, `[Section placement rejected] ${r}`);
          }
        }
        if (moved) app.recordAndRender();
        else if (selectionChanged) app.render();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  // lasso select on empty canvas (native scrollbar clicks also target `scroll`, so
  // only `surface` — the actual canvas content — should ever start a lasso)
  scroll.addEventListener('pointerdown', (e) => {
    if (e.target !== surface) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const scrollRect = scroll.getBoundingClientRect();
    const z = zoom();
    const startX = (e.clientX - scrollRect.left + scroll.scrollLeft) / z;
    const startY = (e.clientY - scrollRect.top + scroll.scrollTop) / z;
    const rectEl = document.createElement('div');
    rectEl.className = 'lasso-rect';
    surface.appendChild(rectEl);
    let lassoRect = null;

    const onMove = (ev) => {
      const x = (ev.clientX - scrollRect.left + scroll.scrollLeft) / z;
      const y = (ev.clientY - scrollRect.top + scroll.scrollTop) / z;
      const left = Math.min(x, startX), top = Math.min(y, startY);
      const w = Math.abs(x - startX), h = Math.abs(y - startY);
      Object.assign(rectEl.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
      lassoRect = { left, top, right: left + w, bottom: top + h };
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (!additive) tab.selection.clear();
      tab.selectedSectionId = null;
      if (lassoRect) {
        const allVms = app.store.viewMembersForView(tab.viewId);
        const partVms = allVms.filter((vm) => vm.objectType === 'part');
        const partVmById = new Map(partVms.map((v) => [v.id, v]));
        const lassoView = app.store.findView(tab.viewId);
        const { w: nodeW, h: nodeH } = getNodeSize(lassoView);
        for (const vm of partVms) {
          const nodeRect = { left: vm.x, top: vm.y, right: vm.x + nodeW, bottom: vm.y + nodeH };
          if (rectsOverlap(lassoRect, nodeRect)) tab.selection.add(vm.id);
        }
        for (const cvm of allVms) {
          if (cvm.objectType !== 'connector') continue;
          const fromVm = partVmById.get(cvm.fromVmId), toVm = partVmById.get(cvm.toVmId);
          if (!fromVm || !toVm) continue;
          const { fc, tc } = edgeEndpoints(fromVm, toVm, lassoView);
          if (segmentIntersectsRect(fc, tc, lassoRect)) tab.selection.add(cvm.id);
        }
      }
      rectEl.remove();
      app.render();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });

  // right-click on empty canvas: open the command context menu at this position
  scroll.addEventListener('contextmenu', (e) => {
    if (e.target !== surface) return;
    e.preventDefault();
    const rect = surface.getBoundingClientRect();
    const z = zoom();
    app.showCanvasContextMenu(e.clientX, e.clientY, { x: (e.clientX - rect.left) / z, y: (e.clientY - rect.top) / z });
  });

  // mouse position indicator (left panel, model/canvas-space coordinates)
  const posEl = document.getElementById('mouse-position');
  scroll.addEventListener('pointermove', (e) => {
    const rect = surface.getBoundingClientRect();
    const z = zoom();
    const x = Math.round((e.clientX - rect.left) / z);
    const y = Math.round((e.clientY - rect.top) / z);
    if (posEl) posEl.textContent = `x: ${x}, y: ${y}`;
  });
  scroll.addEventListener('pointerleave', () => { if (posEl) posEl.textContent = 'x: —, y: —'; });

  // Drop from the toolbox lands here — but as the COMPLETION of a custom
  // pointerdown/pointermove/pointerup drag (render.js's wireToolboxTileDrag), not a
  // native HTML5 'drop' event. See wireToolboxTileDrag's own doc comment for why.
}

/**
 * Wired ONCE globally (not per render) so listeners never accumulate.
 * Handles: connect-drag completion, and Delete/Backspace for the active tab's selection.
 */
function wireGlobalCanvasHandlers(app) {
  document.addEventListener('pointermove', (e) => {
    if (!app.connectState) return;
    const { surface, getZoom } = app.connectState;
    const rect = surface.getBoundingClientRect();
    const z = getZoom ? getZoom() : 1;
    const line = document.getElementById('temp-connect-line');
    if (line) { line.setAttribute('x2', (e.clientX - rect.left) / z); line.setAttribute('y2', (e.clientY - rect.top) / z); }
  });
  document.addEventListener('pointerup', (e) => {
    if (!app.connectState) return;
    const { tab, fromVmId } = app.connectState;
    const line = document.getElementById('temp-connect-line');
    if (line) line.remove();
    const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.fnode');
    if (targetEl && targetEl.dataset.vmId !== fromVmId) {
      app.beginConnect(tab, fromVmId, targetEl.dataset.vmId, e.clientX, e.clientY);
    }
    app.connectState = null;
  });
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
    const tab = app.store.activeTab();
    if (!tab || tab.type !== 'canvas') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && tab.selection.size > 0) {
      e.preventDefault();
      app.deleteSelection(tab);
    }
  });
}

// ===================== TABLE / PDF / TEXT PAGES =====================
const CATALOG_COLUMNS = {
  parts: ['id', 'type', 'label', 'model', 'section', 'streams', 'note', 'createdAt', 'updatedAt'],
  connectors: ['id', 'from', 'to', 'model', 'relationship', 'connectorType', 'streams', 'note', 'createdAt', 'updatedAt'],
  views: ['id', 'viewName', 'viewType', 'margin', 'chkShowConnectorType', 'chkShowStreamType', 'chkShowKeys', 'chkShowElementTypes', 'chkShowOnPageCatalogs'],
  viewMembers: ['id', 'view', 'objectType', 'objectId', 'x', 'y', 'order', 'linkedViewName', 'isExternal', 'note'],
};

function catalogRows(app, catalogType) {
  const { store } = app;
  if (catalogType === 'parts') return store.doc.parts;
  if (catalogType === 'connectors') return store.doc.connectors;
  if (catalogType === 'views') return store.doc.views;
  if (catalogType === 'viewMembers') return store.doc.viewMembers;
  return [];
}

function fmtCell(v) {
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v ?? '';
}

function renderTablePage(app, tab, container) {
  // Every re-render below tears down and rebuilds the whole table (a brand new .table-
  // page div, which is the scrollable element per CSS), so without capturing/restoring
  // scrollTop across that rebuild, clicking a row (or a sort header) to trigger
  // app.render() always snapped the view back to the top of the table (Step 28 fix).
  const prevWrap = container.querySelector('.table-page');
  const savedScrollTop = prevWrap ? prevWrap.scrollTop : 0;
  // Same problem applies to the filter input below: it's a real <input>, torn down and
  // recreated on every keystroke (since typing calls app.render(), same as a sort click)
  // — without explicitly restoring focus/cursor position, each keystroke would knock
  // focus out of the field entirely.
  const prevFilterInput = prevWrap ? prevWrap.querySelector('.table-filter-input') : null;
  const restoreFilterFocus = !!prevFilterInput && document.activeElement === prevFilterInput;
  const savedSelStart = restoreFilterFocus ? prevFilterInput.selectionStart : null;
  const savedSelEnd = restoreFilterFocus ? prevFilterInput.selectionEnd : null;

  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'table-page';

  let rows, cols;
  if (tab.catalogType) {
    rows = [...catalogRows(app, tab.catalogType)];
    cols = CATALOG_COLUMNS[tab.catalogType] || (rows[0] ? Object.keys(rows[0]) : []);
  } else if (tab.simLogModel) {
    // Simulation log: reuses this same table-page renderer (sorting, scroll
    // preservation, etc.) rather than a bespoke tab type — pulled live from
    // store.simLog each render, most recent tick first. Keyed by model, not view.
    const log = app.store.simLog.get(tab.simLogModel) || [];
    rows = log.map((e, i) => ({
      id: String(i), tick: e.tick, label: e.label, type: e.type,
      message: e.message, time: new Date(e.ts).toLocaleTimeString(),
    })).reverse();
    cols = ['tick', 'label', 'type', 'message', 'time'];
  } else {
    rows = tab.tableRows || [];
    cols = tab.tableCols || (rows[0] ? Object.keys(rows[0]) : []);
  }

  // Filter — catalog tabs AND the SFCE industry-data preview (Catalogs > SFCE, reviewing
  // a large dataset before Generate Industry is exactly when this matters most) — case-
  // insensitive substring match against ANY column's formatted cell value, so searching
  // "risk" finds it whether it's in the label, a note, or anywhere else in the row.
  const isFilterable = !!(tab.catalogType || tab.sfceCatalog);
  const totalCount = rows.length;
  if (isFilterable) {
    const filterText = (tab.catalogFilterText || '').trim().toLowerCase();
    if (filterText) rows = rows.filter((r) => cols.some((c) => fmtCell(r[c]).toLowerCase().includes(filterText)));
  }

  // Multi-column sort: tab.sortColumns is an ordered array of {col, dir} — the row
  // comparator walks it in order, falling through to the next criterion only on a tie,
  // same convention as a spreadsheet's "sort by X, then by Y". Plain click on a header
  // replaces the whole list with just that one column (the pre-multi-sort behavior,
  // unchanged); shift+click appends (or, if already present, toggles) a column without
  // disturbing the others — see the click handler below.
  const activeSorts = (tab.sortColumns || []).filter((s) => cols.includes(s.col));
  if (activeSorts.length) {
    rows.sort((a, b) => {
      for (const { col, dir } of activeSorts) {
        const d = dir === 'desc' ? -1 : 1;
        const va = fmtCell(a[col]).toLowerCase(), vb = fmtCell(b[col]).toLowerCase();
        if (va < vb) return -d;
        if (va > vb) return d;
      }
      return 0;
    });
  }

  const RANK_GLYPHS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];
  const arrow = (c) => {
    const idx = activeSorts.findIndex((s) => s.col === c);
    if (idx === -1) return '';
    const rankPrefix = activeSorts.length > 1 ? (RANK_GLYPHS[idx] || `${idx + 1}`) : '';
    return ` ${rankPrefix}${activeSorts[idx].dir === 'desc' ? '▾' : '▴'}`;
  };
  const searchBarHtml = isFilterable
    ? `<div class="table-search-bar"><input type="text" class="table-filter-input" placeholder="Filter rows…" value="${escapeHtml(tab.catalogFilterText || '')}" /><span class="table-search-count">${rows.length} / ${totalCount}</span></div>`
    : '';
  wrap.innerHTML = `${searchBarHtml}<table><thead><tr>${cols.map((c) => `<th class="sortable-col" data-col="${escapeHtml(c)}" title="Click to sort by this column. Shift+click to add it as an additional sort tiebreaker.">${escapeHtml(c)}${arrow(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr class="catalog-row${tab.selectedCatalogRow?.id === r.id ? ' selected' : ''}" data-id="${escapeHtml(r.id)}">${cols.map((c) => `<td>${escapeHtml(fmtCell(r[c]))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--text-muted);">No rows</td></tr>`}</tbody></table>`;
  container.appendChild(wrap);
  wrap.scrollTop = savedScrollTop;

  wrap.querySelectorAll('.sortable-col').forEach((th) => {
    th.addEventListener('click', (e) => {
      const col = th.dataset.col;
      const sortColumns = tab.sortColumns || (tab.sortColumns = []);
      if (e.shiftKey) {
        // Add this column as an additional tiebreaker without disturbing the others'
        // order or direction — same as re-clicking it flips just its own direction.
        const idx = sortColumns.findIndex((s) => s.col === col);
        if (idx === -1) sortColumns.push({ col, dir: 'asc' });
        else sortColumns[idx].dir = sortColumns[idx].dir === 'asc' ? 'desc' : 'asc';
      } else {
        // Plain click: sort by just this column, discarding any other tiebreakers —
        // toggles direction only when it was already the sole active sort.
        const wasSoleAsc = sortColumns.length === 1 && sortColumns[0].col === col && sortColumns[0].dir === 'asc';
        tab.sortColumns = [{ col, dir: wasSoleAsc ? 'desc' : 'asc' }];
      }
      app.render();
    });
  });
  if (tab.catalogType) {
    wrap.querySelectorAll('.catalog-row').forEach((tr) => {
      tr.addEventListener('click', () => {
        tab.selectedCatalogRow = { catalogType: tab.catalogType, id: tr.dataset.id };
        app.render();
      });
    });
  }
  if (isFilterable) {
    const filterInput = wrap.querySelector('.table-filter-input');
    filterInput.addEventListener('input', () => {
      tab.catalogFilterText = filterInput.value;
      app.render();
    });
    if (restoreFilterFocus) {
      filterInput.focus();
      filterInput.setSelectionRange(savedSelStart, savedSelEnd);
    }
  }
}
function renderPdfPage(app, tab, container) {
  container.innerHTML = `<div class="pdf-page">PDF page: ${escapeHtml(tab.title)} (no document attached)</div>`;
}
function renderTextPage(app, tab, container) {
  container.innerHTML = `<div class="text-page" contenteditable="true">${escapeHtml(tab.textContent || '')}</div>`;
}

// Module-level cache: the instructions content is static for the lifetime of the page
// (it's a fetched HTML file, not editable data), so there's no reason to re-fetch it
// every time the Instructions tab is switched to or the app re-renders.
let docsHtmlCache = null;
function renderDocsPage(app, tab, container) {
  if (docsHtmlCache !== null) {
    container.innerHTML = docsHtmlCache;
    return;
  }
  container.innerHTML = '<div class="docs-content"><p>Loading…</p></div>';
  fetch('public/instructions.html', { cache: 'no-store' })
    .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); })
    .then((html) => {
      docsHtmlCache = html;
      // Only apply if this tab is still the one on screen — the fetch is async, and the
      // user may have switched tabs (or this tab may have been closed) before it resolves.
      if (app.store.activeTabId === tab.id && app.store.tabs.some((t) => t.id === tab.id)) {
        container.innerHTML = html;
      }
    })
    .catch(() => {
      container.innerHTML = '<div class="docs-content"><p>Could not load the instructions page.</p></div>';
    });
}

export { renderPages, renderCanvasPage, wireGlobalCanvasHandlers, buildMarkerDefs, redrawNodeSizes, getNodeSize, redrawAndResolveLayout, passesStreamFilter, passesElementTypeFilter, passesSectionFilter, isAnyVisibilityFilterActive, expandVisiblePartVmIdsByLevel, disposeView3DTab, getView3DModule, formatSimValue };
