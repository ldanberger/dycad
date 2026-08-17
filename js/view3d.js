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
// Stage 2 (current): connector lines between resolved part positions — one connector
// drawn iff BOTH its endpoints are currently visible, same convention the 2D canvas
// already uses (see passesStreamFilter's own comment: hiding a node hides its connectors
// automatically, no separate connector-level filter check). Rendered as a single
// THREE.LineSegments with one shared BufferGeometry (one draw call for every visible
// connector, the line-drawing equivalent of Stage 1's InstancedMesh) rather than one Line
// object per connector. Also: within a type's own grid, parts now sort by (section, then
// a representative stream) before layout, and a new row starts at each section boundary
// — so a section's parts cluster together as their own visually distinct band, and
// same-stream parts end up adjacent via the sort even without their own forced break.
// Still ahead: a master cube-order fallback list for types outside any template's
// value[] (Stage 3), zoom-to-2D-detail (Stage 4), and a live simulation-value overlay
// (Stage 5). Full plan: DESIGN_DOCUMENT.md §9.
//
// Deliberately the ONLY module that imports the vendored Three.js/OrbitControls — every
// other module stays free of a 3D dependency, and canvas.js only ever reaches this file
// via a lazy dynamic import() (see renderView3DPage there), so the ~800KB vendored
// library never loads unless someone actually opens the 3D tab.
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { ciEq } from './state.js';
import { elementByType } from './rules.js';
import { groupFill } from './render.js';
import { passesStreamFilter, passesElementTypeFilter } from './canvas.js';

// tab.id -> { renderer, scene, camera, controls, container, resizeObserver, animId,
//             typeMeshes: Map<type, InstancedMesh>, hasFramedOnce, lastSignature }
const instances = new Map();

const NODE_SIZE = 0.9;          // box geometry edge length
const NODE_SPACING = 1.4;       // gap between adjacent instances within one type's grid
const TYPE_LAYER_GAP = 1.6;     // Z distance between consecutive type sub-layers
const GROUP_LAYER_GAP = 1.2;    // EXTRA Z gap inserted at each element-group boundary

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
 * come first within a group (finer sub-layers) — both driven by the current stream
 * template's value[] order, same "last used" default Generate Stream/Remap/Smart Check
 * View already share. Group order is each group's first-seen position while walking the
 * template's value[] (e.g. Enterprise's chain visits General, then Business, then
 * Application, then Data, in that order); a group the template never mentions is
 * appended afterward in custom.json's own elementGroups declaration order (the same
 * order the toolbox sidebar's group chips already use). Type order within a group
 * follows the SAME template value[] position when the type is in it; a type that isn't
 * falls back to its toolbox tkDisplayOrder — the Stage 1 fallback. (Stage 3's master
 * cube-order list will give that fallback case a real, hand-authored order instead.)
 */
function resolveLayerOrder(store) {
  const templates = store.settings.streamTemplates || [];
  const preferredName = preferredStreamTemplateName();
  const template = (preferredName && templates.find((t) => ciEq(t.name, preferredName)))
    || templates.find((t) => ciEq(t.name, 'Enterprise'))
    || templates[0]
    || null;
  const templateValue = template?.value || [];

  const groupOrder = [];
  for (const type of templateValue) {
    const el = elementByType(store, type);
    if (el && !groupOrder.includes(el.group)) groupOrder.push(el.group);
  }
  for (const g of store.settings.elementGroups || []) {
    if (!groupOrder.includes(g.group)) groupOrder.push(g.group);
  }

  const templateTypeOrder = new Map(templateValue.map((t, i) => [String(t).toLowerCase(), i]));
  return { template, groupOrder, templateTypeOrder };
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

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);

  let animId = null;
  const animate = () => {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  const resizeObserver = new ResizeObserver(() => {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(container);

  return {
    renderer, scene, camera, controls, container, resizeObserver, animId,
    typeMeshes: new Map(), connectorLines: null, hasFramedOnce: false, lastSignature: null,
  };
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
  if (parts.length === 0) return;

  const { groupOrder, templateTypeOrder } = resolveLayerOrder(store);

  const byType = new Map();
  for (const p of parts) {
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type).push(p);
  }

  const typeEntries = [...byType.keys()].map((type) => {
    const el = elementByType(store, type);
    const groupIdx = groupOrder.indexOf(el?.group);
    return {
      type, el,
      groupIdx: groupIdx === -1 ? groupOrder.length : groupIdx,
      templateIdx: templateTypeOrder.has(type.toLowerCase()) ? templateTypeOrder.get(type.toLowerCase()) : Infinity,
      tkOrder: el?.tkDisplayOrder ?? 999,
    };
  });
  typeEntries.sort((a, b) => (a.groupIdx - b.groupIdx) || (a.templateIdx - b.templateIdx) || (a.tkOrder - b.tkOrder) || a.type.localeCompare(b.type));

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
      partPositions.set(part.id, { x, y, z });
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    mesh.instanceMatrix.needsUpdate = true;

    inst.scene.add(mesh);
    inst.typeMeshes.set(entry.type, mesh);
    z += TYPE_LAYER_GAP;
  }

  // Connector lines: one visible iff BOTH endpoints are currently visible (same
  // convention the 2D canvas already uses — see passesStreamFilter's own comment).
  // A single LineSegments/BufferGeometry for every visible connector, one draw call
  // total, the line-drawing equivalent of the InstancedMesh approach above.
  const linePositions = [];
  for (const c of store.doc.connectors) {
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
}

/**
 * Entry point canvas.js calls on every render() while a 3D tab is active. Creates the
 * persistent renderer/scene/camera/controls the FIRST time this tab is seen, then only
 * re-syncs scene data on every subsequent call — never tears down and rebuilds the WebGL
 * context on every store change the way the 2D canvas page rebuilds its DOM, since that
 * would both be wasteful and would reset the camera/rotation the person is mid-interacting
 * with.
 */
function renderView3D(app, tab, container) {
  let inst = instances.get(tab.id);
  if (!inst) {
    inst = createInstance(app, tab, container);
    instances.set(tab.id, inst);
  }
  syncSceneData(app, tab, inst);
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
  return {
    types,
    meshCount: inst.typeMeshes.size,
    hasFramedOnce: inst.hasFramedOnce,
    connectorCount: inst.connectorLines ? inst.connectorLines.userData.connectorCount : 0,
    connectorLinesUuid: inst.connectorLines ? inst.connectorLines.uuid : null,
  };
}

export { renderView3D, disposeView3D, getDebugSceneInfo };
