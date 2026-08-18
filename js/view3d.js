// view3d.js — the 3D View tab: a rotatable/zoomable WebGL scene over the SAME parts and
// connectors data every other view reads (never viewMembers or views — this is a
// data-level visualization, not another placement of the 2D canvas's own nodes).
//
// Stage 0 (done): plumbing only — persistent per-tab renderer/scene/camera/controls,
// proof the vendored Three.js loads and renders cleanly.
// Stage 1 (done): real data — parts grouped by element group (broad Z-slab), then by
// type within that group (finer sub-layer), ordered by a stream template's value[] (see
// resolveLayerOrder below); rendered via THREE.InstancedMesh from the start (not
// retrofitted later — this needs to handle thousands of parts, and switching a
// mesh-per-part scene to instancing after the fact would mean redoing the renderer).
// Reuses the existing Stream/Type filters (passesStreamFilter/passesElementTypeFilter,
// now wired up for this tab type too in main.js's filter-menu handlers) and element-group
// fill colors (groupFill) unchanged.
// Stage 2 (done): connector lines between resolved part positions — one connector
// drawn iff BOTH its endpoints are currently visible, same convention the 2D canvas
// already uses (see passesStreamFilter's own comment: hiding a node hides its connectors
// automatically, no separate connector-level filter check). Rendered as a single
// THREE.LineSegments with one shared BufferGeometry (one draw call for every visible
// connector, the line-drawing equivalent of Stage 1's InstancedMesh) rather than one Line
// object per connector. Also: within a type's own grid, parts now sort by (section, then
// a representative stream) before layout, and a new row starts at each section boundary
// — so a section's parts cluster together as their own visually distinct band, and
// same-stream parts end up adjacent via the sort even without their own forced break.
// Stage 3 (done): custom.json's new cubeOrder — a hand-authored master list covering
// every element type — is now the fallback ordering (both group and type) for anything
// the active stream template's value[] doesn't mention (see resolveLayerOrder below).
// The template's own choices still always win; cubeOrder only fills in what it left
// unordered, which for a typical handful-of-types template is most of the 74 known types.
// Stage 4 (done): zoom-to-2D-detail. Click a part to focus it (recenters OrbitControls'
// orbit target on it, highlights it) and shows its properties in the Properties panel —
// via tab.selectedCatalogRow, the exact same mechanism the Parts Catalog table's row
// selection already drives, so the panel is the identical "Part" editor, no new
// rendering path. Zooming in past a distance threshold while focused jumps to a 2D
// canvas view that already has that part placed (selecting it there) — a JUMP, not a
// continuous 3D->2D morph, the deliberately cheaper option chosen up front (see
// DESIGN_DOCUMENT.md §9). Double-click a part to jump immediately, skipping the zoom
// gesture. A part placed on no view yet just keeps showing its own properties (the same
// thing a click already shows) rather than jumping anywhere. Click/double-click are
// hand-distinguished from an OrbitControls drag-to-rotate release (which still fires a
// native 'click' at the drag's end point) by checking the pointer barely moved between
// its own pointerdown and the click, not by trusting the browser's click/dblclick events
// alone.
// Stage 5 (done): live simulation overlay. Every currently-visible part with a
// store.simRuntime entry for its own model (i.e. that model has been stepped/run at
// least once) gets a small colored marker floating just above its cube — green/blue/red
// for normal/changed/error, the SAME 3-state palette the 2D canvas's Show Simulation
// Values badge already uses (SIM_STATE_COLORS mirrors .fnode-sim-badge's CSS colors in
// styles.css), so the encoding is shared, not reinvented. A 'changed' marker additionally
// pulses (its own scale oscillates every animation frame) — 3D's stand-in for the 2D
// badge's static "changed" border color, since a static color alone reads less clearly in
// a scene you're also free to freely rotate/zoom. No numeric value text and no tick
// history scrubbing (current tick only) — both deliberately out of scope up front (see
// DESIGN_DOCUMENT.md §9). Deliberately NOT gated by the structural
// computeSignature/syncSceneData rebuild: a continuous Run calls app.render() on every
// tick (~every 500ms) without touching any part/connector/filter field that signature
// tracks, so syncSimOverlay keeps its own, much cheaper signature built only from the
// small set of currently-visible parts' runtime values, and only ever rebuilds its own
// couple of small marker InstancedMeshes — never the big type/connector meshes — on a
// tick.
//
// Deliberately the ONLY module that imports the vendored Three.js/OrbitControls — every
// other module stays free of a 3D dependency, and canvas.js only ever reaches this file
// via a lazy dynamic import() (see renderView3DPage there), so the ~800KB vendored
// library never loads unless someone actually opens the 3D tab.
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { ciEq } from './state.js';
import { elementByType } from './rules.js';
import { groupFill, escapeHtml } from './render.js';
import { passesStreamFilter, passesElementTypeFilter } from './canvas.js';

// tab.id -> { renderer, scene, camera, controls, container, resizeObserver, animId,
//             typeMeshes: Map<type, InstancedMesh>, hasFramedOnce, lastSignature }
const instances = new Map();

const NODE_SIZE = 0.9;          // box geometry edge length
const NODE_SPACING = 1.4;       // gap between adjacent instances within one type's grid
const TYPE_LAYER_GAP = 1.6;     // Z distance between consecutive type sub-layers
const GROUP_LAYER_GAP = 1.2;    // EXTRA Z gap inserted at each element-group boundary
const ZOOM_JUMP_DISTANCE = NODE_SIZE * 4; // camera-to-target distance that counts as "zoomed in on it"
const CLICK_DRAG_TOLERANCE = 5; // px of pointer movement still treated as a click, not a drag
const FOCUS_HIGHLIGHT_COLOR = 0xffcc00;
const SIM_BADGE_RADIUS = NODE_SIZE * 0.22;
const SIM_BADGE_HEIGHT = NODE_SIZE * 0.7; // floats above the node's own top face
// Mirrors css/styles.css' .fnode-sim-badge colors exactly (normal/error/changed) — the 2D
// canvas's own encoding, not a new one invented for 3D.
const SIM_STATE_COLORS = { normal: 0x2f8f4e, changed: 0x2f6fed, error: 0xc0392b };
const SIM_PULSE_PERIOD_MS = 260;
const SIM_PULSE_AMPLITUDE = 0.35; // +/- fraction of the marker's base scale

// Scratch objects reused across picks (no per-call allocation) — Raycaster/Vector2 hold
// no state between calls, safe to share at module scope.
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
// Scratch objects reused across every animation frame's pulse update, across every open
// 3D tab — safe to share since rAF callbacks run one at a time, never interleaved.
const pulseMatrix = new THREE.Matrix4();
const pulsePosition = new THREE.Vector3();
const pulseScaleVec = new THREE.Vector3();
const pulseQuaternion = new THREE.Quaternion();

/** Raycasts from the camera through a client-space (clientX/clientY) point into the
 * scene's InstancedMeshes, returning the nearest hit's partId (or null). Used by both
 * the click-to-focus and double-click-to-jump handlers. */
function pickPartAtClientXY(inst, clientX, clientY) {
  const rect = inst.renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, inst.camera);
  const hits = raycaster.intersectObjects([...inst.typeMeshes.values()], false);
  if (hits.length === 0) return null;
  const hit = hits[0];
  return { partId: hit.object.userData.partIds[hit.instanceId], mesh: hit.object, instanceId: hit.instanceId };
}

/** The focused-instance highlight: a wireframe box slightly larger than a node, moved to
 * sit around whatever's currently focused, rather than recoloring the InstancedMesh
 * instance itself — per-instance InstancedMesh color (setColorAt/instanceColor) turned
 * out not to render reliably against the vendored Three.js build here, and a separate
 * marker mesh sidesteps that entirely: simple, robust, and correct regardless of
 * per-instance-color shader support. One marker per tab, created lazily and reused
 * (just repositioned/shown/hidden) rather than recreated on every focus change. */
function ensureFocusMarker(inst) {
  if (inst.focusMarker) return inst.focusMarker;
  const size = NODE_SIZE * 1.35;
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(size, size, size));
  const material = new THREE.LineBasicMaterial({ color: FOCUS_HIGHLIGHT_COLOR });
  const marker = new THREE.LineSegments(edges, material);
  marker.visible = false;
  inst.scene.add(marker);
  inst.focusMarker = marker;
  return marker;
}

/** Un-highlights whatever was previously focused — a no-op if nothing was focused. */
function clearFocusHighlight(inst) {
  if (inst.focusMarker) inst.focusMarker.visible = false;
}

/** Focuses partId: shows the highlight marker on it and remembers its world position
 * (inst.focusedPartPosition, used by the zoom-jump distance check below) — deliberately
 * does NOT move OrbitControls' own orbit target, so clicking a node never yanks the
 * camera/recenters the view; it just clicks "where it already is" on screen, same as
 * selecting a node on the 2D canvas doesn't recenter the canvas either. Silently does
 * nothing if the part isn't currently in the scene (filtered out, or removed). Re-usable
 * both from a click and from syncSceneData's own "restore focus after a resync" step. */
function focusPart(inst, partId) {
  for (const mesh of inst.typeMeshes.values()) {
    const instanceId = mesh.userData.partIds.indexOf(partId);
    if (instanceId === -1) continue;
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(instanceId, matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    inst.focusedPartPosition = position.clone();
    const marker = ensureFocusMarker(inst);
    marker.position.copy(position);
    marker.visible = true;
    inst.focusedPartId = partId;
    inst.jumpedForPartId = null; // a fresh focus always gets its own chance to jump
    return true;
  }
  return false;
}

function themeBackgroundColor() {
  // Reads the app's own CSS custom property so the 3D scene's background matches
  // light/dark mode instead of hardcoding one — same source of truth the rest of the UI
  // already uses. Falls back to a neutral grey if the variable somehow isn't set yet.
  const raw = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  return raw || '#e8e8e8';
}

function themeConnectorColor() {
  // Same reasoning as themeBackgroundColor — a muted, theme-aware neutral so a dense
  // web of connectors doesn't visually fight the colorful element-group node layers.
  const raw = getComputedStyle(document.body).getPropertyValue('--text-muted').trim();
  return raw || '#888888';
}

/** A part's single representative stream for clustering purposes — the alphabetically
 * first of (possibly several) streams it carries, so ordering is deterministic. A part
 * with no streams sorts before any that has one (empty string < any non-empty string). */
function representativeStream(part) {
  const streams = part.streams || [];
  return streams.length ? [...streams].sort()[0] : '';
}

/**
 * Lays a type's parts out into a grid, clustering by section first (a new row starts at
 * every section boundary, so each section's parts occupy their own visually distinct
 * band within the layer) — parts must already be pre-sorted by (section, representative
 * stream, id) by the caller, so same-stream parts end up adjacent via sort order even
 * without their own forced row break. Returns each part's (col, row) plus the actual
 * total row count (not a simple ceil(count/cols), since section breaks can leave rows
 * partially filled) so the caller can center the grid correctly.
 */
function layoutGridWithSectionBreaks(typeParts, cols) {
  const placements = [];
  let col = 0, row = 0, prevSection;
  for (const p of typeParts) {
    const section = p.section || '';
    if (prevSection !== undefined && section !== prevSection && col !== 0) { row += 1; col = 0; }
    prevSection = section;
    placements.push({ part: p, col, row });
    col += 1;
    if (col >= cols) { col = 0; row += 1; }
  }
  const rows = placements.length ? Math.max(...placements.map((pl) => pl.row)) + 1 : 0;
  return { placements, rows };
}

/** The "last used" Stream Template preference (see main.js's getCachedStreamTemplate) —
 * read directly from its localStorage cache here rather than imported from main.js,
 * since main.js sits at the TOP of this app's dependency graph (nothing imports it; see
 * DESIGN_DOCUMENT.md §3) and importing it here would invert that. Same key, same shape,
 * deliberately duplicated in miniature rather than restructuring the module graph for a
 * four-line read. */
function preferredStreamTemplateName() {
  try {
    const cached = JSON.parse(localStorage.getItem('dycad-local-settings-cache') || '{}');
    return typeof cached.streamTemplate === 'string' && cached.streamTemplate ? cached.streamTemplate : null;
  } catch { return null; }
}

/**
 * Decides layer order: which element GROUPS come first (broad Z-slabs) and which TYPES
 * come first within a group (finer sub-layers). Three sources, in priority order:
 *   1. The current stream template's value[] — same "last used" default Generate
 *      Stream/Remap/Smart Check View already share (e.g. Enterprise's chain visits
 *      General, then Business, then Application, then Data, in that order).
 *   2. custom.json's cubeOrder — a hand-authored master list covering every element
 *      type, giving a real, deliberate fallback order for anything the active template
 *      doesn't mention (which is most types — a typical template's value[] only spans a
 *      handful). Grouped internally by the same conceptual ArchiMate layering (General,
 *      Strategy/Motivation, Business, Application, Technology, Data,
 *      Implementation/Migration, Unknown) rather than custom.json's own elementGroups
 *      declaration order, which isn't itself meaningful (just JSON authoring order).
 *   3. A type present in NEITHER list (shouldn't happen once cubeOrder covers everything,
 *      but stays a defensive fallback) uses its toolbox tkDisplayOrder, then alphabetical.
 * Group order is each group's first-seen position while walking [...templateValue,
 * ...cubeOrder] in that combined sequence — so the template's own choices always win,
 * and cubeOrder fills in every group the template didn't touch. Type order within a
 * group follows the same combined-sequence position.
 */
function resolveLayerOrder(store) {
  const templates = store.settings.streamTemplates || [];
  const preferredName = preferredStreamTemplateName();
  const template = (preferredName && templates.find((t) => ciEq(t.name, preferredName)))
    || templates.find((t) => ciEq(t.name, 'Enterprise'))
    || templates[0]
    || null;
  const templateValue = template?.value || [];
  const cubeOrder = store.settings.cubeOrder || [];

  const groupOrder = [];
  for (const type of [...templateValue, ...cubeOrder]) {
    const el = elementByType(store, type);
    if (el && !groupOrder.includes(el.group)) groupOrder.push(el.group);
  }
  for (const g of store.settings.elementGroups || []) {
    if (!groupOrder.includes(g.group)) groupOrder.push(g.group);
  }

  const templateTypeOrder = new Map(templateValue.map((t, i) => [String(t).toLowerCase(), i]));
  const cubeTypeOrder = new Map(cubeOrder.map((t, i) => [String(t).toLowerCase(), i]));
  return { template, groupOrder, templateTypeOrder, cubeTypeOrder };
}

/** Shows partId's own properties in the Properties panel while the 3D tab stays active —
 * reuses the exact same catalog-row mechanism the Parts Catalog table's row selection
 * already drives (tab.selectedCatalogRow -> renderCatalogRowProperties in render.js ->
 * renderPartOnlyProperties), so the 3D tab gets the identical "same controls as a Part
 * row" panel with no new rendering path. Called on every click-to-focus (so a click
 * always populates the panel, matching a canvas node click) and as jumpToMatching2DView's
 * fallback when there's nowhere to jump to. */
function selectPartInPanel(app, tab, partId) {
  tab.selectedCatalogRow = { catalogType: 'parts', id: partId };
  app.render();
}

/** Stage 4's actual "zoom-to-detail" destination: finds a 2D canvas view that already
 * has partId placed on it (the FIRST one found in store.doc.views order — no attempt to
 * prefer an already-open tab over a closed one; simplest thing that works), switches to
 * it, and selects that part's node there. A part that isn't placed on any view yet shows
 * its own properties in the 3D tab's own panel instead (selectPartInPanel) — this jumps
 * to EXISTING placements, it doesn't create one (that's what Add Existing is for, a
 * separate, deliberate action), but there's still something useful to show either way. */
function jumpToMatching2DView(app, tabId, partId) {
  const { store } = app;
  const part = store.findPart(partId);
  if (!part) return;
  for (const view of store.doc.views) {
    const vm = store.viewMembersForView(view.id).find((v) => v.objectType === 'part' && v.objectId === partId);
    if (vm) {
      const tab = app.openOrSwitchView(view.id);
      tab.selection.clear();
      tab.selection.add(vm.id);
      app.render();
      return;
    }
  }
  const tab3d = store.tabs.find((t) => t.id === tabId);
  if (tab3d) selectPartInPanel(app, tab3d, partId);
}

/** Right-click node context menu: a small self-contained floating menu (the same
 * .edge-popover class + inline-style/manual-hover pattern main.js's showRelationPicker/
 * showEdgePopover already use for lightweight popups — NOT the .dropdown-menu/.dd-item
 * combo, which is for actual header-bar dropdowns) built directly here rather than routed
 * through the canvas's command registry (runCommand), since none of its commands apply
 * to a raw part/3D context. Two things, both answering "quick filter, scoped to what I
 * just right-clicked":
 *   - Filter to Streams: sets tab.activeStreams to exactly this part's own streams — the
 *     same field the toolbar's Stream filter reads, so opening that dropdown afterward
 *     shows exactly this selection already checked.
 *   - Connector Type: tab.connectorTypeFilter (null/'c'/'s') — the 3D view draws BOTH
 *     connectorType 'c' (Connectors) and 's' (Streams) together with no distinction by
 *     default, unlike the 2D canvas's own per-view chkShowConnectorType/chkShowStreamType
 *     checkboxes; since a 3D tab isn't backed by a view, this is the tab-scoped
 *     equivalent instead, offered here rather than as its own toolbar control. */
function showNodeContextMenu(app, tab, partId, clientX, clientY) {
  document.querySelectorAll('.view3d-context-menu').forEach((m) => m.remove());
  const store = app.store;
  const part = store.findPart(partId);
  if (!part) return;

  const streams = part.streams || [];
  const connectorTypeOptions = [
    { value: null, label: 'All' },
    { value: 'c', label: 'Connectors' },
    { value: 's', label: 'Streams' },
  ];
  const items = [
    { header: true, label: part.label },
    {
      label: streams.length ? `Filter to Streams: ${streams.join(', ')}` : 'This node has no streams',
      disabled: streams.length === 0,
      onClick: () => { tab.activeStreams = [...streams]; app.render(); },
    },
    ...(tab.activeStreams != null ? [{ label: 'Clear Stream Filter', onClick: () => { tab.activeStreams = null; app.render(); } }] : []),
    { separator: true },
    { header: true, label: 'Connector Type' },
    ...connectorTypeOptions.map((opt) => ({
      label: `${(tab.connectorTypeFilter ?? null) === opt.value ? '✓' : '  '} ${opt.label}`,
      onClick: () => { tab.connectorTypeFilter = opt.value; app.render(); },
    })),
  ];

  const menu = document.createElement('div');
  menu.className = 'edge-popover view3d-context-menu';
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.innerHTML = items.map((it, i) => {
    if (it.separator) return '<div style="height:1px;margin:4px 0;background:var(--border);"></div>';
    if (it.header) return `<div style="font-weight:600;margin:${i === 0 ? '0' : '6px'} 0 4px 0;">${escapeHtml(it.label)}</div>`;
    return `<div class="v3d-ctx-item" data-idx="${i}" style="padding:4px 6px;border-radius:4px;cursor:${it.disabled ? 'default' : 'pointer'};opacity:${it.disabled ? '0.4' : '1'};">${escapeHtml(it.label)}</div>`;
  }).join('');
  document.getElementById('modal-root').appendChild(menu);

  menu.querySelectorAll('.v3d-ctx-item').forEach((el) => {
    const it = items[Number(el.dataset.idx)];
    if (it.disabled) return;
    el.addEventListener('mouseenter', () => { el.style.background = 'var(--accent-soft)'; });
    el.addEventListener('mouseleave', () => { el.style.background = ''; });
    el.addEventListener('click', () => { it.onClick(); menu.remove(); document.removeEventListener('pointerdown', closer); });
  });
  const closer = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', closer); } };
  setTimeout(() => document.addEventListener('pointerdown', closer), 10);
}

/** Removes and disposes every marker InstancedMesh the sim overlay currently owns — a
 * no-op if nothing's showing. Called both to clear stale markers before a rebuild and
 * when there's nothing left to show (no simRuntime data, or nothing currently visible). */
function clearSimOverlay(inst) {
  for (const mesh of inst.simMeshes.values()) {
    inst.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  inst.simMeshes.clear();
}

/** Refreshes the small colored "simulation state" marker floating above each currently-
 * visible part that has a live store.simRuntime entry for its own model — see this file's
 * own Stage 5 header comment for the full design rationale (shared color encoding,
 * pulse-not-recolor for "changed", why this bypasses the structural rebuild signature).
 * Reads inst.partPositions, populated by the last syncSceneData call — this only ever
 * reflects parts already resolved as currently visible, so the overlay automatically
 * respects the same Stream/Type filters and inherits the "hide it, its overlay marker
 * disappears too" convention for free. */
function syncSimOverlay(app, tab, inst) {
  const { store } = app;
  if (store.simRuntime.size === 0 || !inst.partPositions || inst.partPositions.size === 0) {
    if (inst.simMeshes.size > 0) clearSimOverlay(inst);
    inst.lastSimSignature = null;
    return;
  }

  // pos.model was stashed directly by syncSceneData's own placement loop — deliberately
  // NOT store.findPart(partId) here, which is an Array.find (linear scan) over every part
  // in the whole document; calling it once per currently-visible part turned this into an
  // O(n^2) scan (a real regression found and fixed via a real-scale test: ~16s for a
  // single no-op render() at 22,399 parts, versus single-digit ms once fixed).
  const entries = []; // { pos, state }
  const sigParts = [];
  for (const [partId, pos] of inst.partPositions) {
    const runtime = store.simRuntime.get(pos.model);
    const entry = runtime ? runtime.values.get(partId) : null;
    if (!entry) continue; // this part's model has no runtime yet, or hasn't reached it
    const state = entry.lastError ? 'error' : (entry.changed ? 'changed' : 'normal');
    entries.push({ pos, state });
    sigParts.push(`${partId}:${state}:${entry.lastTick}`);
  }

  const signature = sigParts.join(',');
  if (signature === inst.lastSimSignature) return;
  inst.lastSimSignature = signature;

  clearSimOverlay(inst);
  if (entries.length === 0) return;

  const byState = { normal: [], changed: [], error: [] };
  for (const { pos, state } of entries) byState[state].push(pos);

  const matrix = new THREE.Matrix4();
  for (const [state, positions] of Object.entries(byState)) {
    if (positions.length === 0) continue;
    const geometry = new THREE.SphereGeometry(SIM_BADGE_RADIUS, 8, 6);
    const material = new THREE.MeshStandardMaterial({ color: SIM_STATE_COLORS[state] });
    const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
    positions.forEach((p, i) => {
      matrix.setPosition(p.x, p.y + SIM_BADGE_HEIGHT, p.z);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.simState = state;
    mesh.userData.positions = positions;
    inst.scene.add(mesh);
    inst.simMeshes.set(state, mesh);
  }
}

/** Makes the 'changed' state's markers pulse in place every animation frame (their shared
 * scale oscillates around 1.0) — called from the per-tab animate() loop regardless of
 * whether anything actually needs pulsing right now (a Map.get + early return when
 * there's no 'changed' mesh, negligible per-frame cost). */
function updateSimPulse(inst) {
  const mesh = inst.simMeshes.get('changed');
  if (!mesh) return;
  const scale = 1 + SIM_PULSE_AMPLITUDE * Math.sin(performance.now() / SIM_PULSE_PERIOD_MS);
  pulseScaleVec.set(scale, scale, scale);
  const positions = mesh.userData.positions;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    pulsePosition.set(p.x, p.y + SIM_BADGE_HEIGHT, p.z);
    pulseMatrix.compose(pulsePosition, pulseQuaternion, pulseScaleVec);
    mesh.setMatrixAt(i, pulseMatrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

function createInstance(app, tab, container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(themeBackgroundColor());

  const width = container.clientWidth || 1, height = container.clientHeight || 1;
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 20000);
  camera.position.set(6, 6, 10);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  // OrbitControls' own default binds RIGHT-drag to panning, which would fight the node
  // right-click context menu added below (a right-click-then-tiny-move is easy to trigger
  // by accident, and OrbitControls still suppresses the native browser context menu
  // unconditionally via its own 'contextmenu' listener regardless of this mapping — see
  // its onContextMenu). Freeing RIGHT for the context menu and moving pan to MIDDLE-drag
  // (a common desktop-3D-app convention) avoids that conflict entirely, rather than
  // needing a click-vs-drag tolerance check for the right button too.
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);

  const resizeObserver = new ResizeObserver(() => {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(container);

  const inst = {
    renderer, scene, camera, controls, container, resizeObserver, animId: null,
    typeMeshes: new Map(), connectorLines: null, hasFramedOnce: false, lastSignature: null,
    focusMarker: null, focusedPartId: null, jumpedForPartId: null, focusedPartPosition: null,
    simMeshes: new Map(), lastSimSignature: null, partPositions: null,
  };

  // inst.animId is written directly here (not a separate outer variable captured once
  // into inst at construction time) — an earlier version used `let animId` and copied its
  // value into inst.animId as a one-time snapshot, which went stale after the very first
  // frame (a later requestAnimationFrame call only ever updated the outer variable, never
  // inst.animId again); disposeInstance's cancelAnimationFrame(inst.animId) was then
  // cancelling an already-fired, harmless id every time, never the actual pending frame —
  // silently leaking a forever-running render loop on every closed 3D tab.
  const animate = () => {
    inst.animId = requestAnimationFrame(animate);
    controls.update();
    updateSimPulse(inst);
    renderer.render(scene, camera);
  };
  animate();

  // Click-vs-drag: OrbitControls' own rotate/pan drag still ends with the browser firing
  // a native 'click' at the release point, so a raw 'click' listener can't be trusted
  // alone — only treat it as a real click if the pointer barely moved since its own
  // pointerdown.
  let pointerDownPos = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { pointerDownPos = { x: e.clientX, y: e.clientY }; });
  const wasClick = (e) => !!pointerDownPos && Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y) <= CLICK_DRAG_TOLERANCE;

  renderer.domElement.addEventListener('click', (e) => {
    if (!wasClick(e)) return;
    const hit = pickPartAtClientXY(inst, e.clientX, e.clientY);
    if (hit) {
      focusPart(inst, hit.partId);
      selectPartInPanel(app, tab, hit.partId);
    }
  });
  renderer.domElement.addEventListener('dblclick', (e) => {
    if (!wasClick(e)) return;
    const hit = pickPartAtClientXY(inst, e.clientX, e.clientY);
    if (hit) jumpToMatching2DView(app, tab.id, hit.partId);
  });
  renderer.domElement.addEventListener('contextmenu', (e) => {
    e.preventDefault(); // OrbitControls also does this unconditionally; harmless twice
    const hit = pickPartAtClientXY(inst, e.clientX, e.clientY);
    if (hit) showNodeContextMenu(app, tab, hit.partId, e.clientX, e.clientY);
  });

  // The actual "zoom in past a threshold" trigger — OrbitControls fires 'change' on
  // every camera/target update (including its own damped-zoom animation frames), so this
  // reacts as the zoom happens rather than needing an unconditional per-frame poll.
  // Measured against the focused part's own position (inst.focusedPartPosition), NOT
  // controls.target — focusing a part no longer recenters the orbit target (see
  // focusPart's own comment), so target and "the thing you're actually zoomed in on"
  // are no longer the same point in general.
  controls.addEventListener('change', () => {
    if (!inst.focusedPartId || !inst.focusedPartPosition) return;
    const distance = camera.position.distanceTo(inst.focusedPartPosition);
    if (distance < ZOOM_JUMP_DISTANCE) {
      if (inst.jumpedForPartId !== inst.focusedPartId) {
        inst.jumpedForPartId = inst.focusedPartId;
        jumpToMatching2DView(app, tab.id, inst.focusedPartId);
      }
    } else {
      inst.jumpedForPartId = null; // back out past the threshold re-arms it
    }
  });

  return inst;
}

function disposeInstance(inst) {
  if (inst.animId != null) cancelAnimationFrame(inst.animId);
  inst.resizeObserver.disconnect();
  inst.controls.dispose();
  inst.scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of materials) m.dispose();
    }
  });
  inst.renderer.dispose();
  if (inst.renderer.domElement.parentNode) inst.renderer.domElement.parentNode.removeChild(inst.renderer.domElement);
}

/** Cheap "did anything this sync depends on actually change" check, so re-rendering the
 * whole app (which happens on nearly every store mutation) doesn't rebuild every
 * InstancedMesh/the connector lines from scratch each time. Includes every PART field
 * that affects layout (type/streams/section — not just id, so editing an existing part's
 * type via the property panel is caught even though the part set itself didn't change)
 * and every CONNECTOR field that affects the line geometry (id/from/to — catches
 * add/remove and rewiring). Not a full diff (still a full rebuild when it DOES decide
 * something changed), just a skip for the common case of "something unrelated changed
 * and we re-rendered anyway" — verified fast enough at real scale (22K parts/60K
 * connectors) to not be a bottleneck itself. */
function computeSignature(app, tab) {
  const { store } = app;
  return JSON.stringify([
    store.doc.parts.map((p) => `${p.id}:${p.type}:${(p.streams || []).join('+')}:${p.section || ''}`).join(','),
    store.doc.connectors.map((c) => `${c.id}:${c.from}:${c.to}`).join(','),
    tab.activeStreams,
    tab.activeElementTypes,
    tab.connectorTypeFilter,
    preferredStreamTemplateName(),
    document.body.dataset.theme,
  ]);
}

function syncSceneData(app, tab, inst) {
  const { store } = app;
  const signature = computeSignature(app, tab);
  if (signature === inst.lastSignature) return;
  inst.lastSignature = signature;

  for (const mesh of inst.typeMeshes.values()) {
    inst.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  inst.typeMeshes.clear();
  if (inst.connectorLines) {
    inst.scene.remove(inst.connectorLines);
    inst.connectorLines.geometry.dispose();
    inst.connectorLines.material.dispose();
    inst.connectorLines = null;
  }
  inst.scene.background = new THREE.Color(themeBackgroundColor());

  const parts = store.doc.parts.filter((p) => passesStreamFilter(tab, p.streams) && passesElementTypeFilter(tab, p.type));
  if (parts.length === 0) { inst.partPositions = new Map(); return; }

  const { groupOrder, templateTypeOrder, cubeTypeOrder } = resolveLayerOrder(store);

  const byType = new Map();
  for (const p of parts) {
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type).push(p);
  }

  const typeEntries = [...byType.keys()].map((type) => {
    const el = elementByType(store, type);
    const groupIdx = groupOrder.indexOf(el?.group);
    const lower = type.toLowerCase();
    return {
      type, el,
      groupIdx: groupIdx === -1 ? groupOrder.length : groupIdx,
      templateIdx: templateTypeOrder.has(lower) ? templateTypeOrder.get(lower) : Infinity,
      cubeIdx: cubeTypeOrder.has(lower) ? cubeTypeOrder.get(lower) : Infinity,
      tkOrder: el?.tkDisplayOrder ?? 999,
    };
  });
  typeEntries.sort((a, b) => (a.groupIdx - b.groupIdx) || (a.templateIdx - b.templateIdx) || (a.cubeIdx - b.cubeIdx) || (a.tkOrder - b.tkOrder) || a.type.localeCompare(b.type));

  let z = 0;
  let prevGroupIdx = null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const matrix = new THREE.Matrix4();
  const partPositions = new Map(); // partId -> {x, y, z}, for the connector-line pass below

  for (const entry of typeEntries) {
    if (prevGroupIdx !== null && entry.groupIdx !== prevGroupIdx) z += GROUP_LAYER_GAP;
    prevGroupIdx = entry.groupIdx;

    // Cluster by section (a new row starts at every section boundary), then by
    // representative stream within a section — see layoutGridWithSectionBreaks' own
    // comment for why this needs an actual row count, not a simple ceil(count/cols).
    const typeParts = [...byType.get(entry.type)].sort((a, b) =>
      (a.section || '').localeCompare(b.section || '') || representativeStream(a).localeCompare(representativeStream(b)) || a.id.localeCompare(b.id));
    const count = typeParts.length;
    const color = new THREE.Color(groupFill(app, entry.el));
    const geometry = new THREE.BoxGeometry(NODE_SIZE, NODE_SIZE, NODE_SIZE);
    const material = new THREE.MeshStandardMaterial({ color });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.userData.type = entry.type;
    mesh.userData.group = entry.el?.group;
    mesh.userData.z = z;
    mesh.userData.partIds = typeParts.map((p) => p.id);

    const cols = Math.ceil(Math.sqrt(count));
    const { placements, rows } = layoutGridWithSectionBreaks(typeParts, cols);
    placements.forEach(({ part, col, row }, i) => {
      const x = (col - (cols - 1) / 2) * NODE_SPACING;
      const y = (row - (rows - 1) / 2) * NODE_SPACING;
      matrix.setPosition(x, y, z);
      mesh.setMatrixAt(i, matrix);
      partPositions.set(part.id, { x, y, z, model: part.model });
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    mesh.instanceMatrix.needsUpdate = true;

    inst.scene.add(mesh);
    inst.typeMeshes.set(entry.type, mesh);
    z += TYPE_LAYER_GAP;
  }

  // A resync rebuilds every mesh from scratch, so a part focused before this rebuild
  // needs its highlight marker (and remembered position, for the zoom-jump distance
  // check) repositioned to its NEW instance position — without touching controls.target
  // (focusing never did, see focusPart's own comment) or jumpedForPartId (if they'd
  // already zoomed in and jumped once, an unrelated resync shouldn't re-arm and
  // immediately jump them away again).
  if (inst.focusedPartId) {
    let stillPresent = false;
    for (const mesh of inst.typeMeshes.values()) {
      const instanceId = mesh.userData.partIds.indexOf(inst.focusedPartId);
      if (instanceId === -1) continue;
      mesh.getMatrixAt(instanceId, matrix);
      const marker = ensureFocusMarker(inst);
      marker.position.setFromMatrixPosition(matrix);
      marker.visible = true;
      inst.focusedPartPosition = marker.position.clone();
      stillPresent = true;
      break;
    }
    if (!stillPresent) {
      clearFocusHighlight(inst);
      inst.focusedPartId = null; inst.jumpedForPartId = null; inst.focusedPartPosition = null;
    }
  }

  // Connector lines: one visible iff BOTH endpoints are currently visible (same
  // convention the 2D canvas already uses — see passesStreamFilter's own comment), AND
  // it matches tab.connectorTypeFilter if one is set (null = both 'c'/Connectors and
  // 's'/Streams together, the default — see showNodeContextMenu's own comment for where
  // this gets set). A single LineSegments/BufferGeometry for every visible connector, one
  // draw call total, the line-drawing equivalent of the InstancedMesh approach above.
  const linePositions = [];
  for (const c of store.doc.connectors) {
    if (tab.connectorTypeFilter != null && c.connectorType !== tab.connectorTypeFilter) continue;
    const fromPos = partPositions.get(c.from);
    const toPos = partPositions.get(c.to);
    if (!fromPos || !toPos) continue;
    linePositions.push(fromPos.x, fromPos.y, fromPos.z, toPos.x, toPos.y, toPos.z);
  }
  if (linePositions.length > 0) {
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    const lineMaterial = new THREE.LineBasicMaterial({ color: new THREE.Color(themeConnectorColor()), transparent: true, opacity: 0.35 });
    const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
    lines.userData.connectorCount = linePositions.length / 6;
    inst.scene.add(lines);
    inst.connectorLines = lines;
  }

  // Frame the camera to the data's actual extent — only the FIRST time this tab gets
  // real data, so re-syncs after that (a filter change, a new part) don't yank the view
  // out from under someone who's already navigating.
  if (!inst.hasFramedOnce) {
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = z / 2;
    const radius = Math.max(maxX - minX, maxY - minY, z, NODE_SPACING * 4) / 2;
    inst.controls.target.set(cx, cy, cz);
    inst.camera.position.set(cx + radius * 1.6, cy + radius * 1.6, cz + radius * 2.2);
    inst.camera.far = Math.max(20000, radius * 20);
    inst.camera.updateProjectionMatrix();
    inst.hasFramedOnce = true;
  }

  inst.partPositions = partPositions;
}

/**
 * Entry point canvas.js calls on every render() while a 3D tab is active. Creates the
 * persistent renderer/scene/camera/controls the FIRST time this tab is seen, then only
 * re-syncs scene data on every subsequent call — never tears down and rebuilds the WebGL
 * context on every store change the way the 2D canvas page rebuilds its DOM, since that
 * would both be wasteful and would reset the camera/rotation the person is mid-interacting
 * with. syncSimOverlay runs unconditionally after syncSceneData (not gated by the same
 * structural signature) since simulation ticks need to refresh it every call — see this
 * file's own Stage 5 header comment.
 */
function renderView3D(app, tab, container) {
  let inst = instances.get(tab.id);
  if (!inst) {
    inst = createInstance(app, tab, container);
    instances.set(tab.id, inst);
  }
  syncSceneData(app, tab, inst);
  syncSimOverlay(app, tab, inst);
}

/** Called from App.closeTab (main.js, via canvas.js's disposeView3DTab) so a closed 3D
 * tab's WebGL context/animation loop are torn down instead of leaking — browsers cap the
 * number of live WebGL contexts a page can hold. */
function disposeView3D(tabId) {
  const inst = instances.get(tabId);
  if (!inst) return;
  disposeInstance(inst);
  instances.delete(tabId);
}

/** Read-only introspection of a 3D tab's actual current scene contents — for the
 * regression suite to assert on genuine internal state (per-type instance counts, Z
 * layer position, mesh identity) rather than only what a screenshot happens to show.
 * Not used by the app itself; a legitimate small hook in the same spirit as
 * window.dycadApp being exposed as a debugging aid (see main.js's bootstrapApp). */
function getDebugSceneInfo(tabId) {
  const inst = instances.get(tabId);
  if (!inst) return null;
  const types = {};
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  for (const [type, mesh] of inst.typeMeshes) {
    const positions = {};
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix);
      positions[mesh.userData.partIds[i]] = { x: position.x, y: position.y, z: position.z };
    }
    types[type] = { count: mesh.count, z: mesh.userData.z, group: mesh.userData.group, meshUuid: mesh.uuid, positions };
  }
  const simOverlay = {};
  for (const [state, mesh] of inst.simMeshes) simOverlay[state] = { count: mesh.count, meshUuid: mesh.uuid };
  return {
    types,
    meshCount: inst.typeMeshes.size,
    hasFramedOnce: inst.hasFramedOnce,
    connectorCount: inst.connectorLines ? inst.connectorLines.userData.connectorCount : 0,
    connectorLinesUuid: inst.connectorLines ? inst.connectorLines.uuid : null,
    focusedPartId: inst.focusedPartId,
    jumpedForPartId: inst.jumpedForPartId,
    focusMarkerVisible: inst.focusMarker ? inst.focusMarker.visible : false,
    cameraTargetDistance: inst.camera.position.distanceTo(inst.controls.target),
    controlsTarget: { x: inst.controls.target.x, y: inst.controls.target.y, z: inst.controls.target.z },
    simOverlay,
  };
}

/** Test-only entry points that drive the same code paths a real click/zoom would,
 * without needing to simulate actual mouse/wheel DOM events against a WebGL canvas
 * (unreliable in a headless test runner) — the regression suite calls these directly to
 * exercise focusPart/jumpToMatching2DView/the zoom-threshold check for real, on the
 * genuine internal scene state, same "no mocks" testing philosophy as the rest of the
 * app (see DESIGN_DOCUMENT.md §10). Not used by the app itself. */
function debugFocusPart(app, tabId, partId) {
  const inst = instances.get(tabId);
  if (!inst) return false;
  const ok = focusPart(inst, partId);
  if (ok) {
    const tab = app.store.tabs.find((t) => t.id === tabId);
    if (tab) selectPartInPanel(app, tab, partId);
  }
  return ok;
}
function debugJumpToMatching2DView(app, tabId, partId) {
  const inst = instances.get(tabId);
  if (!inst) return;
  jumpToMatching2DView(app, tabId, partId);
}
function debugSetCameraDistance(tabId, distance) {
  const inst = instances.get(tabId);
  if (!inst) return;
  // Repositions relative to the focused part's own position (what the real zoom-jump
  // check now measures against — see the 'change' listener's own comment), falling back
  // to controls.target if nothing's focused (matters only for tests exercising this with
  // no focus at all, which never trigger the jump check anyway).
  const referencePoint = inst.focusedPartPosition || inst.controls.target;
  const dir = new THREE.Vector3().subVectors(inst.camera.position, referencePoint).normalize();
  if (dir.lengthSq() === 0) dir.set(1, 1, 1).normalize();
  inst.camera.position.copy(referencePoint).addScaledVector(dir, distance);
  inst.controls.dispatchEvent({ type: 'change' });
}

/** Reads a sim overlay marker's current instance scale (the 'changed' state's markers are
 * the only ones ever animated — see updateSimPulse) — lets the regression suite confirm
 * the pulse animation is actually varying the rendered scale over time, without needing
 * to simulate real animation-frame timing or compare screenshot pixels. */
function debugGetSimMarkerScale(tabId, state) {
  const inst = instances.get(tabId);
  if (!inst) return null;
  const mesh = inst.simMeshes.get(state);
  if (!mesh || mesh.count === 0) return null;
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(0, matrix);
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return scale.x;
}

/** Projects a part's current world position to on-screen client coordinates (relative to
 * the viewport, exactly what a real page.mouse.click(x, y) expects) — lets the regression
 * suite drive GENUINE mouse events (real click/right-click, not a debug-hook shortcut)
 * against a specific, known part regardless of where the layout actually placed it. This
 * matters: a debug hook that duplicates a real listener's logic can silently drift from
 * what the real listener actually does (found exactly this drift once already — see
 * debugFocusPart's own history) — real click tests using this catch that class of bug,
 * hook-only tests structurally cannot. */
function debugGetScreenPosition(tabId, partId) {
  const inst = instances.get(tabId);
  if (!inst) return null;
  for (const mesh of inst.typeMeshes.values()) {
    const instanceId = mesh.userData.partIds.indexOf(partId);
    if (instanceId === -1) continue;
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(instanceId, matrix);
    const worldPos = new THREE.Vector3().setFromMatrixPosition(matrix);
    const projected = worldPos.clone().project(inst.camera);
    const rect = inst.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
    };
  }
  return null;
}

export { renderView3D, disposeView3D, getDebugSceneInfo, debugFocusPart, debugJumpToMatching2DView, debugSetCameraDistance, debugGetSimMarkerScale, debugGetScreenPosition };
