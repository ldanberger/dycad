# DyCAD — Design Document

Describes the system as it currently exists (v0.63). For the story of *how* it got this
way, see `RECREATION_PROMPT.md`. For a plain-language feature walkthrough aimed at
end users, see `public/instructions.html` (rendered in-app as the Instructions tab).
This document is the technical/architectural reference.

## 1. Purpose and scope

DyCAD is a browser-based, ArchiMate-grounded enterprise architecture modeling and
simulation tool. It differs from standard ArchiMate tooling in one deliberate way: a
**Streams** layer for tagging parts/connectors as belonging to a named business flow
and bulk-generating or reorganizing whole flow patterns from a template, rather than
requiring every element and relationship to be hand-drawn.

Non-goals, by design: no multi-user collaboration, no server-side persistence, no
plugin system, no build pipeline. The entire application is static files served as-is.

## 2. Runtime architecture

```
index.html            3-column layout shell, loads js/main.js as a module
css/styles.css        light/dark theme via CSS custom properties
public/custom.json     the single configuration file — see §3
public/relationships.xml   merged into settings.relationshipPairs at boot
public/fce-generalnodes.json   default "general" industry dataset — see §7
public/instructions.html   static content for the in-app Instructions tab
```

Boot sequence (`js/data.js` → `js/state.js` → `js/main.js`): fetch the three public
files above (each with a short retry loop — a cold static server can miss the very
first request), construct one `Store` instance holding all application state, wrap it
in one `App` instance holding UI-facing methods, wire global DOM event handlers, open
the home canvas tab, open the Instructions tab active on top of it, and render.

There is no client-side router and no history API usage — the whole app is one page;
"navigation" means switching tabs within the store's own tab list.

## 3. Module map

| Module | Responsibility |
|---|---|
| `js/state.js` | `Store` class: `doc` (models/parts/connectors/views/viewMembers), tabs, undo/redo, settings, industryData, message log, save/load JSON (de)serialization and `migrateDoc` forward-compatibility defaults, id generation, timestamp formatting |
| `js/data.js` | Startup fetches (custom.json, relationships.xml, fce-generalnodes.json) with retry |
| `js/rules.js` | Relationship-validity lookups (`validRelationOptions`, `elementByType`, `defaultRelationKeyFor`) — all keyed off `settings.relationshipPairs`/`settings.elements` |
| `js/render.js` | Header/toolbox/property-panel rendering; the schema-driven `renderShowFieldsPanel` that every editable-field UI in the app is built from; catalog row rendering; light/dark theme application |
| `js/canvas.js` | The interactive canvas itself: node/edge SVG rendering, drag/connect/lasso-select, zoom/pan, node sizing (`redrawNodeSizes`/`redrawAndResolveLayout`), generic table-tab rendering (`renderTablePage`, drives catalogs *and* the SFCE Catalog page), the Instructions tab's content-fetch renderer, connector routing dispatch (delegates path computation to `routing.js`) |
| `js/commands.js` | Every command: `createStream`, `duplicateStream`, `splitNode`, `levelUp`/`levelDown`/`levelDownSingle`, `copyNodes`/`pasteNodes`, `remap`/`applyRemapLayout`, `mergeNodes`, `generateInventoryView`, `generateIndustry`, `addExistingPartsToView`, `populateFromTemplate`, `duplicateSection`, `smartCheckView`, plus the bulk-generation lookup cache (`createBulkLookupCache`) |
| `js/layout.js` | Force-directed Remap pattern: `computeAdjacentGridLayout` (per-component BFS placement), `findConnectedComponents` (Union-Find), `packClustersOnGrid` (shelf packer), `computeClusteredGridLayout` (full pipeline) |
| `js/routing.js` | Obstacle-avoiding connector path computation (`computeRoutedPath`): visibility-graph + Dijkstra for `direct`, axis-aligned variant for `manhattan` |
| `js/sections.js` | Section-based view geometry: `computeSectionLayout`, `pixelToNearestGrid` (hit-testing), `isTypeAllowedInSection`, `findFreeCellInSection`/`findFreeCellOrGrowSection`, `rescaleSectionPositions`, `duplicateSectionDefinition` |
| `js/archimate.js` | ArchiMate 3.0 Exchange Format import: element/relationship/view parsing, junction flattening, nested-shape (Composition/Aggregation) detection |
| `js/sfce.js` | Pure logic (no DOM) for the Load SFCE wizard and industry-tree operations: `flattenJsonRecords` (generic nested-JSON flattener), `buildRowsFromRecords`, `detectSharedFunctions`/`resolveSharedFunctions`, `buildIndustryTree`, `flattenIndustryTree` (for the SFCE Catalog page) |
| `js/simulation.js` | Per-model tick engine (`stepSimulation`, `startContinuousRun`/`pauseContinuousRun`/`stopContinuousRun`), the `ctx` contract implementation, Message Log (`pushMessageLog`), simulation snapshot save/load |
| `js/view3d.js` | The 3D View tab: a rotatable/zoomable WebGL scene over `store.doc.parts`/`connectors` (never viewMembers/views). The only module that imports the vendored Three.js/OrbitControls (`js/vendor/`) — reached exclusively via a dynamic `import()` from `canvas.js`'s `renderView3DPage`, so the ~800KB vendored library never loads unless the tab is actually opened. Persists its renderer/scene/camera/controls per tab id across re-renders instead of tearing down and rebuilding the WebGL context on every `app.render()` call the way the 2D canvas page does |
| `js/main.js` | `App` class: all UI-facing methods (every `prompt*` dialog, tab management, toast/message-log hookup, theme/panel-width persistence), global event wiring, the File/Advanced dropdown menus, bootstrap |
| `js/version.js` | `APP_VERSION` plus a per-release changelog as code comments — the authoritative history of *why* things are the way they are; consult before assuming something is unintentional |

Dependency direction is roughly `main.js → commands.js → {canvas.js, sections.js,
layout.js, routing.js, sfce.js} → {state.js, rules.js}` with `render.js` consumed by
both `main.js` and `canvas.js` for panel rendering. No module imports `main.js` — the
`App` class is the top of the graph.

## 4. Data model

See `RECREATION_PROMPT.md` §1 for the full field-by-field description; summarized here
as an entity-relationship sketch:

```
Model ─┐
       ├─< Part >──┬─< Connector >──┐
       │            │                │
       └────────────┴────────────────┘
                (Parts/Connectors reference a Model by name)

View ─< ViewMember >─ Part | Connector
  (a ViewMember is one Part-or-Connector's placement on one View;
   the same Part/Connector can have a ViewMember on many Views independently)
```

The load-bearing design decision is the **Part/Connector vs. ViewMember split**: Parts
and Connectors are the shared, model-level truth; ViewMembers are per-diagram
placement/styling. Editing a Part's Root Properties (Label, Type, Description, ...)
changes it on every View that shows it; editing a ViewMember field (position, Fill
Color) changes only this one View's rendering of it. The property panel UI reflects
this directly — see §5.

`store.migrateDoc(obj)` is the single point where an old save file's missing fields get
filled with defaults. Every field ever added to Part/Connector/View/ViewMember/Section
has a corresponding `??`-default line here; this is why decades-old-feeling save files
still load without crashing.

## 5. UI architecture

### 5.1 Schema-driven property panels

`custom.json`'s `showFields` block is the single source of truth for what's editable
where. Each entity key (`part`, `connector`, `viewMember`, `view`, `section`) maps to
`{fieldName: {show: <type-letter>, access: 'r'|'w', label}}`. `render.js`'s
`renderShowFieldsPanel(app, obj, entityKey, accessors, ctx, container)` reads this
schema and renders the appropriate input per `show` code (`t` text, `m` multiline, `n`
number, `y` checkbox, `s` select), calling into a small per-field dispatch for `s`
fields whose option list depends on live data (element `type`, connector
`relationship` — filtered by the connector's *actual* current from/to element types via
`validRelationOptions`, view `routingStyle`/`routingStyleStream`).

Every caller supplies an `accessors` object: `{fieldName: {get(), set(v)}}`. This keeps
`renderShowFieldsPanel` itself free of any entity-specific logic — adding a new
editable field to any entity is a `showFields` schema entry plus one accessor pair, not
a new UI component.

**Two-tier property panel**: selecting a node/connector shows (1) a small top section
for ViewMember-level fields (this placement's position/color/order/external-flag), and
(2) a collapsible "Root Properties" section for the underlying Part/Connector's own
fields. Catalog table rows (§5.2) show only tier 2, since there's no "this view's
placement" outside an actual diagram.

### 5.2 Generic table tabs

A tab with `type: 'table'` is driven entirely by `tab.tableRows` (array of plain
objects) and `tab.tableCols` (array of column-key strings) — `renderTablePage` in
`canvas.js` needs nothing more to render a full sortable table. Three consumers exist
today: the Parts/Connectors/Views/ViewMembers catalogs (`tab.catalogType` additionally
set, enabling click-a-row-to-select), and the read-only SFCE Catalog page (§7, no
`catalogType`, purely informational). Any future tabular report should be built the
same way rather than writing a new renderer.

### 5.3 Modals and dropdowns

Every dialog is `.modal-overlay > .modal-box`, appended to `#modal-root`, and closes
**only** via its own explicit button — there is intentionally no click-outside-to-close
or Escape-key handling anywhere in the app (removed after an earlier version had it;
see `js/version.js`'s changelog for the rationale). Every dropdown menu shares one base
CSS class capped at `max-height: 70vh; overflow-y: auto`, so a long list scrolls
instead of running off-screen.

### 5.4 Feedback channels

`app.toast(message, isError)` is the single entry point for user-facing feedback.
`isError=true` toasts automatically also write to the persistent Message Log side panel
(Copy/Clear buttons); routine success toasts don't, to avoid flooding it, but a
handful of call sites (import summaries, Smart Check View's per-change trail) log
explicitly regardless of error status because the information has lasting value.
Rejection messages are written to name the *specific rule* that fired — e.g. which
section, what it actually allows, what the rejected item's type is — not a generic
failure string.

## 6. Layout and rendering algorithms

### 6.1 Force-directed Remap (`layout.js`)

Not a physics simulation — direct discrete BFS grid placement, chosen after an earlier
continuous-force approach produced unbounded drift between disconnected components and
merely-close (not truly adjacent) node pairs. Per connected component (Union-Find):
start at the highest-degree node, BFS outward, place each newly-discovered node in the
nearest free one of its parent's 8 immediate neighbor cells (ring-search fallback for a
high-degree hub). Guarantees every BFS-tree edge connects grid-adjacent cells; a
non-tree (cycle) edge gets the closest achievable placement, which is an inherent 2D
embedding limit, not a defect. Components are packed onto a shared canvas via a simple
shelf packer. Two orthogonal options: `preferRightPlacement` (bias the 8-neighbor
search order toward East) and `onlyNewRowForNewGroup` (row = BFS depth, not free-form
neighbor search, so same-depth siblings share a row).

### 6.2 Connector routing (`routing.js`, dispatched from `canvas.js`)

`view.routingStyle` governs `'c'`-type connectors, `view.routingStyleStream` governs
`'s'`-type, independently. Four values each: `default` (curve for 'c', line for 's'),
`straight` (unconditional plain line, either type), `direct` (visibility-graph +
Dijkstra around nearby obstacles, straight polyline result), `manhattan` (same,
axis-aligned only). Obstacle search is intentionally local to each connector's own
region, not diagram-wide, for performance on large views.

### 6.3 Section-based views (`sections.js`)

`computeSectionLayout(view)` stacks a view's sections vertically, sizing each section's
grid cell from the view's *current* node dimensions (not a constant, so a later resize
doesn't strand the grid). `pixelToNearestGrid(view, x, y)` is the drag-and-drop
hit-test — it must derive a section's hit-test bottom edge from the *same* computed
body-height `computeSectionLayout` produces, not an independently recomputed one, or a
title-only (zero-height) section's hit zone silently swallows the top of whatever
section follows it (this was a real, shipped bug — see `js/version.js`).
`rescaleSectionPositions(store, view, oldSnapshot)` is the one shared mechanism for "a
layout parameter changed, reposition every affected node to match" — used for both
view-level (spacing scale, node size) and section-level (rowCount, columnCount)
parameter changes.

Drag-and-drop placement: reject with a specific message if the dragged type isn't in
the target section's `elementTypes`; if the target cell is occupied by a different
node, search the rest of the section for a free cell (forward from the drop point,
then earlier rows) rather than stacking on top of the occupant; grow the section by one
row if it's genuinely full. This "search then grow" behavior is scoped to
drag-and-drop specifically — template population keeps a simpler first-free-cell
fallback.

## 7. The SFCE subsystem

"SFCE" = Section → Function → Capability → Entity, a four-level hierarchy used to
bulk-generate Streams. `store.industryData: {[key]: tree}` holds one or more such
trees; the built-in `general` key comes from `fce-generalnodes.json` (no section
concept — every Function's `nodeSection` is blank). Tree shape:

```js
[{
  nodeElementType: 'BusinessFunction', nodeName, nodeId, nodeDescription, nodeSection,
  nodeChildren: [{
    nodeElementType: 'BusinessCapability', nodeName, nodeId, nodeDescription,
    nodeChildren: [{
      nodeElementType: 'DataDataEntity', nodeName, nodeId, nodeDescription,
    }],
  }],
}]
```

### 7.1 Load SFCE (`js/sfce.js` + `main.js` wizard)

Imports an arbitrary external JSON file as a new `industryData` entry. `flattenJsonRecords`
detects the common "outer array of groups, each with a nested array of items" shape and
flattens it, carrying the outer item's own scalar fields onto each flattened record.
The wizard suggests an industry name (from the filename) and field mappings (keyword
search, trying each candidate keyword across every available field before moving to
the next keyword, so a low-priority-but-early-matching field name can't beat a
better-but-later one). A multi-valued Section field splits into one row per value.

**Shared-Function resolution**: after building rows, `detectSharedFunctions` finds
Function names spanning more than one distinct Section (not: a Capability whose own
Section field had multiple values — that's the row-split, a different, earlier step).
If any are found, `resolveSharedFunctions` applies the user's choice: collapse every
copy into one Function in a literal `"Shared"` section (capabilities from every
original section combined; true post-collapse duplicates merge naturally in the
tree-build step's own uniqueness handling), or keep each section's own copy with a
numbered suffix (plain name, then `Name1`, `Name2`, ... by first-seen section order).

### 7.2 Generate Industry (`commands.js`)

Walks a chosen `industryData` tree, calling `createStream` once per Capability×Entity
pair (a Capability with no Entity children falls back to its own name/description
standing in for the entity). A `functionSection` parameter threads the Function's
`nodeSection` onto the generated Part — but note the actual Function-level node for the
default "Enterprise" stream template is produced via the *passive*-node code path
(`template.passive`), not the main chain-building loop; wiring a new per-Function field
into the wrong path is a real, previously-shipped bug (silently drops the field with no
error) worth re-checking if the default template ever changes shape again.

Performance: an explicit, opt-in `createBulkLookupCache(store)` — plain `Map`s keyed by
the same composite keys (`label|type|model`, `xIds|model`, `partId|viewId`, etc.) the
naive scans would otherwise search by — is built once and threaded through every
`createStream`/`createPassiveNode`/`findOrCreateStreamConnector`/
`createCompanionConnector` call in the generation loop, turning what would otherwise be
O(n²) (every call scanning the whole, ever-growing document) into O(n). Single-call
callers (manual Generate Stream) leave the cache parameter unset and keep the original
scan-based path. `generateIndustry` is `async` and yields (zero-delay timeout) every 40
capabilities with a progress callback, since even at O(n) a real multi-thousand-capability
dataset is enough synchronous work to otherwise freeze the tab. Past 100 generated
nodes, the tab's selection is explicitly cleared (before, not after, the
resize/redraw step, since that step can throw and must not gate whether the selection
gets cleared).

### 7.3 SFCE Catalog page

`flattenIndustryTree(tree)` turns any tree (Load SFCE's or the built-in `general`'s)
into flat rows — one per Function/Capability/Entity combination, id and description at
every level, blank Section column for trees that don't have one — fed directly into
the generic table-tab mechanism (§5.2). Read-only; no new rendering code.

## 8. Simulation engine

Per-model tick engine (`simulation.js`). `store.simRuntime: Map<modelName, {tick,
values: Map<partId, {value, state, lastError}>}>`. Each tick, every scripted
(`part.scriptEnabled`) Part in the selected model runs its script inside its own
try/catch (one Part's error is logged and doesn't stop the others), receiving a `ctx`
object (`part`, `inputs`, `responses`, `state`, `tick`, `log`, `secrets`, `setState`)
and required to return `{value, state, response?, badge?}`. `response` values delivered
this tick become the *sources'* `ctx.responses` next tick — the mechanism for
acknowledgement/feedback flows running opposite the connector direction. A Part with no
script and exactly one input passes it through unchanged. Full contract documented for
end users in `public/instructions.html`.

## 9. The 3D View subsystem (`view3d.js`)

A rotatable/zoomable WebGL scene over `store.doc.parts`/`connectors` directly —
deliberately not another placement of viewMembers/views, since the point is a data-level
visualization independent of any one 2D layout. The one deliberate exception to the
vanilla-JS/no-dependency rule: real 3D rendering needs a real rendering library. Rather
than a CDN `<script>` tag (a live runtime dependency — breaks offline, breaks if the CDN
changes or is unreachable), Three.js + its `OrbitControls` addon are downloaded once and
committed under `js/vendor/` (see that directory's own `README.md` for exact provenance
and how to update), imported the same way every other module is. `view3d.js` is the
*only* module that imports them, and is itself only ever reached via a dynamic
`import()` from `canvas.js`'s `renderView3DPage` — triggered the first time the 3D tab
is actually opened, so the ~800KB vendored payload never loads for anyone who doesn't
use this feature.

Rendering persistence is the one place this tab type genuinely differs from every other
`renderPages` dispatch target: `renderCanvasPage`/`renderTablePage`/etc. all wipe and
rebuild their container's DOM on every single `app.render()` call, which is fine for
plain DOM but wrong for a WebGL scene — recreating the renderer/camera/controls on every
store mutation would both be wasteful and would reset whatever rotation/zoom the person
is mid-interacting with. `view3d.js` instead keeps a `Map<tabId, {renderer, scene,
camera, controls, ...}>`, created once per tab and only *updated* (not rebuilt) on
subsequent calls; `disposeView3D(tabId)` (called from `App.closeTab`) tears the WebGL
context and animation loop down explicitly, since browsers cap how many live contexts a
page may hold.

Staged build-out (Stages 0-5 shipped; this is the plan for what's still ahead, kept here
so a future session doesn't have to re-derive it from scratch):

- **Stage 0 (done)** — plumbing only: persistent per-tab renderer/camera/`OrbitControls`,
  a placeholder cube, proof the vendored library loads and renders cleanly.
- **Stage 1 (done)** — real data: parts grouped into one `THREE.InstancedMesh` per
  element TYPE (instancing from the start, not retrofitted later — verified at 22K real
  parts/60K connectors with no console errors and near-instant no-op re-syncs), layered
  in Z by element GROUP first (`resolveLayerOrder`'s `groupOrder`, each group's
  first-seen position while walking the active stream template's `value[]`, a group the
  template never mentions appended afterward in `elementGroups`' own declared order),
  then by TYPE within that group (the template's own `value[]` position, falling back to
  `tkDisplayOrder` for a type outside it — Stage 3 gives that fallback case a real order).
  `syncSceneData` skips the rebuild entirely when a cheap signature (part ids, active
  filters, stream-template preference, theme) hasn't changed since the last sync, so the
  frequent `app.render()` calls that fire on nearly every store mutation don't pay for a
  full InstancedMesh rebuild when nothing relevant changed. The Stream/Type filters
  (`passesStreamFilter`/`passesElementTypeFilter`) and element-group fill colors
  (`groupFill`) are reused unchanged — reading from `store.doc.parts` directly rather
  than any one view's viewMembers, since main.js's filter-menu handlers now branch on
  `tab.type === '3d'` to source their available-options list from the whole model
  instead. `getDebugSceneInfo(tabId)` (view3d.js) exposes the real scene state
  (per-type instance counts, Z position, mesh identity) for the regression suite to
  assert on directly, the same "no mocks, genuine state" testing philosophy §10 describes.
- **Stage 2 (done)** — connector lines between resolved positions: one connector drawn
  iff BOTH endpoints are currently visible (the same "hide the node, its connectors
  disappear too" convention `passesStreamFilter`'s own comment already documents for the
  2D canvas — not a new rule invented for 3D), rendered as a single `THREE.LineSegments`
  with one shared `BufferGeometry` (one draw call for every visible connector — the
  line-drawing equivalent of Stage 1's `InstancedMesh` choice; verified at 60,530 real
  connectors with zero console errors). Within a type's own grid, parts are pre-sorted by
  `(section, representative stream, id)` and `layoutGridWithSectionBreaks` forces a new
  row at every section boundary, so a section's parts occupy their own visually distinct
  band instead of packing straight across into the next section's; same-stream parts end
  up adjacent via the sort even without their own forced break. `computeSignature` grew
  accordingly — every part's type/streams/section (not just id, so retyping an existing
  part via the property panel is now caught) and every connector's id/from/to (catches
  add/remove and rewiring) — confirmed still fast enough at that same real scale
  (~29ms for a no-op signature check over 22K parts + 60K connectors, comfortably
  imperceptible for a UI interaction).
- **Stage 3 (done)** — `custom.json`'s new `cubeOrder`: a hand-authored, flat list
  covering all 74 known element types (alongside `streamTemplates`/`elementGroups`),
  grouped by ArchiMate-conceptual layer (General, Strategy/Motivation, Business,
  Application, Technology, Data, Implementation/Migration, Unknown) rather than
  `elementGroups`' own JSON authoring order, which isn't itself a deliberate sequence.
  `resolveLayerOrder` walks `[...templateValue, ...cubeOrder]` for BOTH group and type
  ordering — the template's own choices always win (a type/group it mentions keeps its
  template-derived position); `cubeOrder` only fills in whatever the template left
  unordered, which for a typical handful-of-types template is most of the 74 types. Type
  order within a group still falls back to `tkDisplayOrder` as a final defensive case
  (shouldn't trigger now that `cubeOrder` has full coverage). Verified with the built-in
  'Test' template — the one case found where the old (`elementGroups`-order) and new
  (`cubeOrder`) fallbacks actually disagree on group order rather than coincidentally
  matching, so the regression check proves real behavior, not an incidental pass.
- **Stage 4 (done)** — zoom-to-detail: clicking a part (`pickPartAtClientXY`, a raycast
  against every `InstancedMesh`) focuses it — recenters `OrbitControls.target` on it,
  shows a reusable wireframe marker (`EdgesGeometry`+`LineBasicMaterial`, `ensureFocusMarker`)
  around it, and shows that part's own properties in the Properties panel
  (`selectPartInPanel` sets `tab.selectedCatalogRow` to `{catalogType: 'parts', id}`, the
  exact same field the Parts Catalog table's row selection already drives — `render.js`'s
  `renderProperties` dispatch was extended to also fire `renderCatalogRowProperties` for a
  `'3d'` tab, not just `'table'`, so the panel is the identical "Part" editor with no new
  rendering path). Zooming in past `ZOOM_JUMP_DISTANCE` (`NODE_SIZE * 4`) while a part is
  focused jumps to a 2D canvas view that already has it placed (opening/switching to that
  view and selecting the matching viewMember there) — a JUMP, not a continuous 3D→2D
  morph, the deliberately cheaper option chosen up front; a seamless morph may be explored
  later. A part with no view placement yet keeps showing its own properties instead of
  jumping anywhere (an earlier version just toasted "isn't placed on any view yet" and left
  the panel empty — less useful than showing what's actually clickable). Double-clicking
  a part jumps immediately, skipping the zoom gesture. Click/double-click are told apart
  from an `OrbitControls` rotate/pan drag release (which still fires a native browser
  `click` at the drag's end point) by checking the pointer barely moved between its own
  `pointerdown` and the `click` (`CLICK_DRAG_TOLERANCE`), not by trusting the browser's
  click/dblclick events alone. The zoom-jump only fires once per threshold crossing
  (`inst.jumpedForPartId`), not once per animation frame while still inside it — damped
  `OrbitControls` motion dispatches its own `change` event on every settling frame, so a
  naive "distance < threshold -> jump" check without that guard would re-navigate
  repeatedly; zooming back out past the threshold clears the guard so zooming back in
  jumps again. A real technical dead end hit along the way: `InstancedMesh.setColorAt`/
  `.instanceColor` did not visually render a per-instance highlight color against this
  vendored Three.js build, even though the underlying color buffer was verified correct
  (`getColorAt` returned exactly the hex just set) — and `material.vertexColors = true`,
  the first attempted fix, made it worse (solid black), because `vertexColors` reads a
  per-GEOMETRY-VERTEX `color` attribute (absent on plain `BoxGeometry`), an entirely
  different mechanism from `InstancedMesh`'s own separate `instanceColor`. The wireframe
  marker mesh sidesteps the whole question and is simpler besides.
- **Stage 5 (done)** — live simulation overlay: every currently-visible part with a
  `store.simRuntime` entry for its own model gets a small colored marker
  (`syncSimOverlay`) floating just above its cube — green/blue/red for
  normal/changed/error, `SIM_STATE_COLORS` mirroring `.fnode-sim-badge`'s CSS colors
  exactly, the SAME encoding the 2D canvas's "Show Simulation Values" badge already uses,
  not a new one. A 'changed' marker additionally pulses (`updateSimPulse`, its scale
  oscillates every animation frame via `performance.now()`) — 3D's stand-in for the 2D
  badge's static "changed" border color, since a static color swap reads less clearly in a
  scene you're also free to rotate. Current-tick only, no history scrubbing (that would
  need `simRuntime` to retain a tick history it doesn't today, a separate piece of scope),
  and color+pulse only — no numeric value text, both decided up front. Rendered as up to 3
  small `InstancedMesh`es (one per state actually present, sized/positioned from
  `inst.partPositions`, itself now stashing each part's own `model` so this never needs a
  `store.findPart` lookup — see the real bug below), matching the type/connector meshes'
  own "one InstancedMesh, not one object per instance" approach. Deliberately NOT gated by
  `syncSceneData`'s own structural rebuild signature: a continuous Run calls `app.render()`
  on every tick (~500ms) without touching any part/connector/filter field that signature
  tracks, so `syncSimOverlay` keeps its own, much cheaper signature (built only from
  currently-visible parts' runtime values) and only ever rebuilds its own couple of small
  marker meshes on a tick, never the big type/connector meshes.

  Two real bugs found and fixed while building this, both via real-scale testing (22,399
  parts) rather than a small fixture, per this doc's own testing convention:
  - `syncSimOverlay`'s first version called `store.findPart(partId)` — an `Array.find`
    (linear scan over every part in the whole document) — once per currently-VISIBLE part,
    turning a routine no-op `app.render()` into an O(n²) scan: ~16 SECONDS for a single
    no-op render at 22,399 parts, once any simulation had ever been stepped. Fixed by
    having `syncSceneData`'s own placement loop stash each part's `model` directly onto
    its `partPositions` entry (it already has the `part` object right there), so
    `syncSimOverlay` never needs a store lookup at all — O(n) with only `Map.get` calls.
  - `createInstance` used to capture `inst.animId` as a one-time snapshot of an outer
    `animId` variable at object-construction time (`const inst = { ..., animId, ... }`),
    but every SUBSEQUENT `requestAnimationFrame` call inside `animate()` only reassigned
    that outer variable, never `inst.animId` again — so `inst.animId` went stale after the
    very first frame. `disposeInstance`'s `cancelAnimationFrame(inst.animId)` was then
    always cancelling an already-fired, harmless id, never the actual currently-pending
    frame — silently leaking a forever-running render loop (against a disposed
    renderer/scene) on every closed 3D tab. Fixed by writing `inst.animId` directly inside
    `animate()` (moving `const inst = {...}`'s construction earlier, before `animate` is
    defined/first called, so it can close over `inst` itself).

- **Stage 5.1 (done)** — usability follow-ups requested after using Stage 4/5 for real:
  - **No camera recenter on click.** `focusPart` used to `controls.target.copy(position)`
    on every click, yanking the camera to center on whatever was clicked. It now only
    remembers the part's world position (`inst.focusedPartPosition`) and leaves
    `controls.target` alone — clicking highlights a part and shows its properties in
    place, the same way selecting a node on the 2D canvas doesn't recenter the canvas.
    The zoom-jump distance check (Stage 4) now measures `camera.position` to
    `inst.focusedPartPosition` instead of to `controls.target`, since those two points are
    no longer the same in general.
  - **Node right-click context menu** (`showNodeContextMenu`): "Filter to Streams" (sets
    `tab.activeStreams` to exactly the right-clicked part's own streams) and a Connector
    Type quick filter (`tab.connectorTypeFilter`: null/'c'/'s' — see below). Required
    remapping `OrbitControls.mouseButtons` (`RIGHT` defaults to `MOUSE.PAN`) to free the
    right button for the menu: `LEFT: ROTATE, MIDDLE: PAN, RIGHT: null`.
  - **Connector Type filter.** Previously the 3D view drew every connector regardless of
    `connectorType` ('c' Connectors vs 's' Streams — the same distinction the 2D canvas's
    own `chkShowConnectorType`/`chkShowStreamType` view checkboxes gate) with no way to
    narrow it. `tab.connectorTypeFilter` (tab-scoped, since a 3D tab isn't backed by a
    `view`) is now folded into both `computeSignature` and the connector-line-building
    loop, set via the new context menu.
  - **Stream filter Select All / Exclude All.** The Stream filter menu lacked the
    Select-All/Exclude-All top row the Element Type filter already had, because
    `tab.activeStreams`'s old convention (empty array = unfiltered) had no way to
    represent "show nothing." Unified both filters onto the SAME null-vs-`[]` convention
    (`passesStreamFilter`/`passesElementTypeFilter` now read identically): `null` =
    unfiltered (the new default, was `[]`), an explicit `[]` = exclude all.
  - A real bug found via this work, in ALREADY-SHIPPED code (v0.813): the "click shows
    properties in the panel" feature (added the session before) had `selectPartInPanel`
    wired into `debugFocusPart` (the test-only hook) but never into the REAL click
    listener — so it silently never worked for a genuine mouse click, only for the debug
    hook standing in for it. The existing permanent test used only the debug hook, so it
    passed despite the real path being broken — a hook that duplicates a real listener's
    logic can drift from it undetected. Caught by testing with a genuine
    `page.mouse.click()` for the first time (via a new `debugGetScreenPosition` test hook
    that projects a part's world position to on-screen client coordinates, so a real click
    can target a specific part regardless of layout) — now the standing discipline for any
    new 3D click-driven feature: exercise it with a real mouse event, not only its debug
    shortcut.
  - **Open 3D tab leaked across a full document replace.** File > Load, Load Example, and
    Recently Opened all replace `store.doc` by wiping `store.tabs = []` directly rather
    than closing each tab through `App.closeTab` — the only path that normally calls
    `disposeView3DTab`. An open 3D tab survived that wipe with its WebGL
    context/animation loop still running forever in the background (invisible once its
    own `page-<id>` DOM container gets removed by the next `render()`, but never actually
    torn down). Found while investigating a user report of a previous simulation's
    markers still visibly pulsing after loading a different file (that specific report's
    actual cause turned out to be Load SFCCE, which intentionally MERGES rather than
    replacing — correct-by-design, not a bug — but this leak was real and independently
    worth fixing). Fixed via a new `App.disposeAllOpenView3DTabs()`, called before the tab
    wipe in all three load paths.
  - **Section filter** (`tab.activeSections`, `passesSectionFilter` in `canvas.js`) — a
    third toolbar filter alongside Stream/Type, on the same `Part.section` string field
    3D's row-break clustering already groups by (`layoutGridWithSectionBreaks`, Stage 2).
    Applies to canvas AND 3D, same null(unfiltered)-vs-`[]`(exclude all) convention the
    other two share. A part with no section is offered as its own selectable
    `'(no section)'` option rather than being silently unreachable once a section filter
    is active.
  - **Section boundary + label in 3D** (`addSectionBoundary`, `makeSectionLabelSprite`) —
    a flat rectangle outline (`THREE.LineLoop`) plus a billboarded canvas-texture text
    sprite (`THREE.Sprite`, the standard dependency-free way to put readable text into a
    vanilla-Three.js scene — always faces the camera, so it stays legible through
    rotation) around each section's own cluster within a type's grid, at that type's own
    Z. One boundary+label per (type, section) pair actually present — section clustering
    has always been per-TYPE, never aggregated across types/Z-layers, so this visualizes
    the SAME grouping that already exists rather than inventing new cross-layer
    aggregation. Color is a neutral theme-aware `--border-strong` (matching the 2D
    canvas's own `.section-box` styling — there's no existing per-section color scheme
    anywhere in the app to instead echo). Verified clean at real scale (22,399 parts).
  - **Copy button now includes every part field.** The Parts Catalog row's Copy button
    (`buildCatalogRowCopyText` — also what the 3D View's node properties panel uses, via
    the same catalog-row mechanism) only ever copied a hand-picked handful
    (Type/Label/Model/Note/Streams) from an earlier version of the panel, never updated as
    more fields were added. Now includes every `showFields.part` field that has a value
    (Id, Section, Order, Script Enabled/Script, Created/Updated, ...), in Root Properties'
    own field order.
  - **Generate Industry's "Place on current view" now defaults unchecked** — the faster,
    more common path for a large dataset (create parts/connectors only, review via
    Catalogs > Parts + Add Existing) is now the default instead of requiring an extra
    click to opt into it every time.
  - **Section now propagates to a whole generated chain, not just the function node.**
    `createStream`'s Section identifier only ever exists on the source data at the
    function level (Load SFCE's own semantics: Section groups Functions, not
    Capabilities/Entities), but the OLD code applied it only to the part actually typed
    as the function — every other part the SAME `createStream` call creates (capability,
    application capability, entity, and every passive node) got `section: ''`. Since the
    new Section filter (and its 3D boundary/label) is exactly the feature that makes this
    visible, filtering to one section used to show just the lone function node, hiding
    the entire rest of its own chain. Both `createStream`'s main `value[]` loop and
    `createPassiveNode` now set `section: functionSection` unconditionally for every part
    THEY create — but never touch it when reusing an existing part (a capability shared
    across streams from two different sections keeps whichever section it was first
    created with, rather than flipping to whichever stream runs last).

- **Stage 6 series (done)** — five further real-usage fixes; see `view3d.js`'s own
  inline Stage 5.2/6/6.1/6.2/6.3/6.4 header comments for full rationale/tradeoffs on
  each.
  - **Cross-layer stream crisscrossing.** Stage 5.2 fixed a multi-stream part clustering
    under an arbitrary alphabetically-first stream regardless of the active filter, and
    forced a row break on a stream change within one type's own grid. Stage 6.1 went
    further: each type's Z-layer had still been computing its own row/col grid entirely
    independently, so a stream's row in one layer had no relationship to that stream's
    row in the next — `layoutGridWithSectionBreaks` was replaced by
    `computeStreamLanes`/`layoutTypeIntoLanes`, giving every `(section, stream)` lane ONE
    shared column width and row-band across ALL currently-visible parts regardless of
    type, so a lane sits at the identical world Y in every layer. Traded off knowingly: a
    type with few parts in a lane still reserves that lane's full (globally tallest)
    height.
  - **Connector direction indicators + Connector Type as a toolbar filter (Stage 6).**
    Connector lines used to be one flat, undirected, neutral-colored `LineSegments` for
    every connector. Now grouped by relationship (`settings.relationshipStyles`, the SAME
    lookup 2D's edge rendering uses) into per-relationship colored/dashed `LineSegments`,
    plus a cone/diamond/sphere `InstancedMesh` marker (`resolveMarkerFamily` — a
    best-effort SVG-path-to-3D-primitive approximation, not pixel-exact) at whichever
    end(s) that relationship's `lineEnds` entry marks. `tab.connectorTypeFilter`
    (right-click-only, single-select) was renamed `tab.activeConnectorTypes` and promoted
    to its own toolbar dropdown, matching Stream/Type/Section's existing pattern.
  - **`cubeOrder` retired into a `streamTemplates` entry (Stage 6.2).** `cubeOrder` used
    to be a separate top-level `custom.json` field, ALWAYS blended in underneath whichever
    stream template happened to be preferred elsewhere (Remap/Generate Stream's shared
    "last used" pick) as `resolveLayerOrder`'s fallback ordering for any type the active
    template's `value[]` didn't mention. It's now just another `streamTemplates` entry
    named `"All"` (`value[]` is the old `cubeOrder` list, verbatim), selected via a new
    toolbar-only "Layer Order" `<select>` (`view3DLayerOrderTemplate` in Local Settings —
    deliberately its OWN preference, separate from Remap/Generate Stream's). Defaults to
    `"All"` (today's out-of-the-box look, unchanged). `resolveLayerOrder`'s
    `templateTypeOrder` now does double duty: it's still the sequencing for whatever the
    selected template DOES mention, but `syncSceneData`'s own parts filter ALSO uses it to
    decide what renders at all — a type the selected template's `value[]` doesn't mention
    isn't shown in the scene, period (corrected directly after an initial version only
    reordered it via the `tkDisplayOrder`/alphabetical fallback instead — "anything that
    template's value[] doesn't mention should not be shown"). Corrected AGAIN right
    after: that fix also hid a type mentioned ONLY in the selected template's
    `passive[]` from/to pairs (its auxiliary/side relationships — e.g. Enterprise's
    BusinessFunction, never part of `value[]`'s main chain) — "the layer order appears
    to be missing the passive elements and their connectors, when a 'Layer Order' is
    selected that includes passives." `resolveLayerOrder`'s `visibleTypes` set is now
    `value[]` types UNION every `passive[]` entry's `from`/`to` type; `templateTypeOrder`
    (drives actual Z-ordering) still comes from `value[]` alone — a passive-only type has
    no natural chain position, so it falls to the `tkDisplayOrder`/alphabetical fallback
    tier, same as any other type `value[]` doesn't mention already did; only VISIBILITY
    was ever the bug. `"All"`'s `value[]` covers every known type, so nothing is hidden
    by default; picking a short template like `"Enterprise"` narrows the WHOLE scene
    down to just the types it actually cares about — `value[]` plus `passive[]`
    combined.
  - **Right-click-drag to reposition + Reset Pinned 3D Positions (Stage 6.3).** Reported
    directly: "in 3d view can it be supported to right click an object and move it
    around?" — then, for the persistence model: "let's try option 2 persist, with new
    locations treated as pinned. Create new option somewhere to reset - which clears all
    'pinned' new locations." New `Part.pin3D` field (`null`, or a real `{x,y,z}` world
    position, persisted with the document). Right-click-dragging a node past
    `CLICK_DRAG_TOLERANCE` (the SAME drag-vs-click distinction the left-click focus
    handler already uses) sets it, dragging along a plane facing the camera through the
    part's current position (`Plane.setFromNormalAndCoplanarPoint` + `Raycaster` against
    it — standard screen-space-drag-in-3D). A pinned part skips
    `computeStreamLanes`/`layoutTypeIntoLanes`'s auto-layout grid entirely (excluded from
    lane occupancy too, so it doesn't inflate a lane's reserved height without occupying
    a cell) and renders at exactly its stored position instead. New Advanced menu item
    "Reset Pinned 3D Positions" (`App.promptResetPinned3DPositions`) clears EVERY part's
    `pin3D` back to `null` in one bulk, confirmed action — deliberately no per-part
    unpin, matching what was actually asked for. `RIGHT` was already unbound in
    `OrbitControls.mouseButtons` (Stage 5.1, freed for the context menu), so a right-drag
    never fights the camera. Testing note: Playwright's own `page.mouse.down(button:
    'right')` fires a synthetic `contextmenu` event prematurely, ON mousedown rather than
    after release — a documented Chromium/CDP automation quirk, not real-browser
    behavior — so the permanent regression check dispatches raw `PointerEvent`s plus a
    manually-fired `contextmenu` event, in the actual order a real browser uses, rather
    than relying on `page.mouse`.
  - **Highlight picker (Stage 6.4).** Reported directly: "add a 'highlight' option,
    perhaps a dropdown list with checkbox... for element type in use, allowing user to
    enable for example highlighting the businessfunction parts." New toolbar
    checkbox-dropdown (3D-only, `tab.highlightedTypes` — a plain array, default `[]`,
    deliberately NOT the null-vs-`[]` "unfiltered" convention the real filters use,
    since "highlight everything" isn't a meaningful default). Draws a bright cyan
    (`HIGHLIGHT_COLOR`, distinct from `FOCUS_HIGHLIGHT_COLOR`'s yellow — a focused part
    and a highlighted type are different, simultaneously-visible concepts) wireframe box
    — `InstancedMesh` + `MeshBasicMaterial({wireframe:true})`, one instance per matching
    part — around every part of the checked type(s). Purely an ADDITIVE visual overlay,
    not a filter: an unchecked type's own `InstancedMesh` part count/rendering is
    completely untouched. Excluded from `pickPartAtClientXY`'s raycast target list (it
    only ever intersects `inst.typeMeshes.values()`), so the highlight overlay never
    interferes with click/drag/context-menu hit-testing.

## 10. Testing strategy

`tests/run_all.py` — no test framework, matching the app's own zero-dependency stance.
Starts a local static server as a subprocess, drives a real headless Chromium instance
via Playwright, and asserts on genuine, observable application state reached through
`window.dycadApp` (the app's own debug global) and live dynamic `import()` of the real
`commands.js`/`sfce.js` modules — not mocks. Each check is an independent function
`check_x(page) -> (bool, str)`; `CHECKS` is the flat list `main()` iterates. 29 checks
as of v0.63, each guarding a specific, previously-real bug or mechanism — see
`tests/README.md` for the full list and what each one catches. Fixtures live in
`tests/fixtures/` (currently one hand-built minimal ArchiMate file covering both
junction-bypass and nested-shape detection in one small file).

Node-only testing (no browser) is also viable and was found to be more reliable for
some sessions of this project's own development: `state.js`'s `Store` and
`commands.js`'s pure logic (`createStream`, `generateIndustry`, etc.) can run under
plain `node --input-type=module` with a hand-built minimal `app`/`store` stub (real
settings loaded from `custom.json`, UI methods stubbed as no-ops) — useful for
correctness and performance testing where no actual DOM interaction is being verified.
Anything that touches `document`/canvas rendering still needs the real Playwright path.

## 11. Known, permanent limitations

Documented here (and in `public/instructions.html` for end users) so they aren't
rediscovered and re-investigated as if new:

- Force-directed Remap can't guarantee a non-tree (cycle) edge lands between adjacent
  grid cells — an inherent 2D-embedding limit, not an implementation gap.
- Obstacle-avoiding routing (`direct`/`manhattan`) only considers obstacles local to
  each connector's own region, not the whole diagram, for performance on large views.
- `conn.endSize` (small/medium/large connector-end marker size) exists in the data
  model and marker CSS but has no UI control setting it away from the default —
  present but currently unreachable.
- `viewMember.fontColor`, `.fontSize`, `.borderColor`, and `view.margin` are fully
  wired as editable property-panel fields (schema entry, accessor, persist correctly)
  but are never read during rendering — editing them currently has no visible effect.
  Found via a deliberate field-by-field audit (see `RECREATION_PROMPT.md` §12); worth
  repeating after future property-panel work.
- `part.note` and `connector.note` show in the catalog table and the row Copy text, but
  not on the canvas node/edge itself (no tooltip).
- `templates[].parts[].x`/`.y` hints are not honored by Populate From Template's
  placement (row-major first-free-cell instead).

## 12. Extension points for future work

- New editable field on any entity → `showFields` schema entry + accessor pair (§5.1),
  not a bespoke panel.
- New tabular report → populate `tab.tableRows`/`tableCols` (§5.2), not a new renderer.
- New bulk-generation workload → check whether `createBulkLookupCache` already covers
  the lookup patterns needed before writing a new scan; if the workload is large,
  budget for the async-chunking-with-progress pattern from §7.2 up front rather than
  retrofitting it after a performance complaint.
- New dialog → the shared modal pattern (§5.3); resist adding any close-on-outside-
  interaction.
- New rejection path anywhere → follow §5.4's "name the specific rule" convention.
