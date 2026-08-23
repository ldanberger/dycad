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
public/capabilities-general-SFCCE.json   default industry dataset — see §7
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
| `js/state.js` | `Store` class: `doc` (models/parts/connectors/views/viewMembers, plus `industryTree`/`industryTemplateName` — the single loaded industry dataset), tabs, undo/redo, settings, message log, save/load JSON (de)serialization and `migrateDoc` forward-compatibility defaults, id generation, timestamp formatting |
| `js/data.js` | Startup fetches (custom.json, relationships.xml, capabilities-general-SFCCE.json) with retry — the industry file is run through the same Load-SFCCE pipeline (`sfce.js`) a real import uses, not assigned as a pre-built tree |
| `js/rules.js` | Relationship-validity lookups (`validRelationOptions`, `elementByType`, `defaultRelationKeyFor`) — all keyed off `settings.relationshipPairs`/`settings.elements` |
| `js/render.js` | Header/toolbox/property-panel rendering; the schema-driven `renderShowFieldsPanel` that every editable-field UI in the app is built from; catalog row rendering; light/dark theme application |
| `js/canvas.js` | The interactive canvas itself: node/edge SVG rendering, drag/connect/lasso-select, zoom/pan, node sizing (`redrawNodeSizes`/`redrawAndResolveLayout`), generic table-tab rendering (`renderTablePage`, drives catalogs *and* the SFCE Catalog page), the Instructions tab's content-fetch renderer, connector routing dispatch (delegates path computation to `routing.js`) |
| `js/commands.js` | Every command: `createStream`, `duplicateStream`, `splitNode`, `levelUp`/`levelDown`/`levelDownSingle`, `copyNodes`/`pasteNodes`, `remap`/`applyRemapLayout`, `mergeNodes`, `generateInventoryView`, `generateIndustry`, `addExistingPartsToView`, `populateFromTemplate`, `insertSmartStream`, `duplicateSection`, `smartCheckView`, `importDDL`/`exportDDL` (Data Modeling, wiring `ddl.js`'s pure parse/generate logic into the Store), plus the bulk-generation lookup cache (`createBulkLookupCache`) |
| `js/layout.js` | Force-directed Remap pattern: `computeAdjacentGridLayout` (per-component BFS placement), `findConnectedComponents` (Union-Find), `packClustersOnGrid` (shelf packer), `computeClusteredGridLayout` (full pipeline) |
| `js/routing.js` | Obstacle-avoiding connector path computation (`computeRoutedPath`): visibility-graph + Dijkstra for `direct`, axis-aligned variant for `manhattan` |
| `js/sections.js` | Section-based view geometry: `computeSectionLayout`, `pixelToNearestGrid` (hit-testing), `isTypeAllowedInSection`, `findFreeCellInSection`/`findFreeCellOrGrowSection`, `rescaleSectionPositions`, `duplicateSectionDefinition` |
| `js/archimate.js` | ArchiMate 3.0 Exchange Format import: element/relationship/view parsing, junction flattening, nested-shape (Composition/Aggregation) detection |
| `js/sfce.js` | Pure logic (no DOM) for the Load SFCE wizard and industry-tree operations: `flattenJsonRecords` (generic nested-JSON flattener), `buildRowsFromRecords`, `detectSharedFunctions`/`resolveSharedFunctions`, `buildIndustryTree`, `flattenIndustryTree` (for the SFCE Catalog page) |
| `js/ddl.js` | Pure logic (no DOM) for Data Modeling's DDL import/export: `parseDDL` (a scoped `CREATE TABLE` subset — not a general SQL grammar), `generateDDL` (the reverse), `splitTopLevel` (paren/quote-aware delimiter splitting) |
| `js/simulation.js` | Per-model tick engine (`stepSimulation`, `startContinuousRun`/`pauseContinuousRun`/`stopContinuousRun`), the `ctx` contract implementation, Message Log (`pushMessageLog`), simulation snapshot save/load |
| `js/view3d.js` | The 3D View tab: a rotatable/zoomable WebGL scene over `store.doc.parts`/`connectors` (never viewMembers/views). The only module that imports the vendored Three.js/OrbitControls (`js/vendor/`) — reached exclusively via a dynamic `import()` from `canvas.js`'s `renderView3DPage`, so the ~800KB vendored library never loads unless the tab is actually opened. Persists its renderer/scene/camera/controls per tab id across re-renders instead of tearing down and rebuilding the WebGL context on every `app.render()` call the way the 2D canvas page does |
| `js/main.js` | `App` class: all UI-facing methods (every `prompt*` dialog, tab management, toast/message-log hookup, theme/panel-width persistence), global event wiring, the File/Advanced dropdown menus, bootstrap |
| `js/version.js` | `APP_VERSION` plus a per-release changelog as code comments — the authoritative history of *why* things are the way they are; consult before assuming something is unintentional |

Dependency direction is roughly `main.js → commands.js → {canvas.js, sections.js,
layout.js, routing.js, sfce.js, ddl.js} → {state.js, rules.js}` with `render.js`
consumed by both `main.js` and `canvas.js` for panel rendering. No module imports
`main.js` — the `App` class is the top of the graph.

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

### 6.1a Edge Assignment & layout optimization (`commands.js`'s `applyRemapLayout`)

Three options layered onto the `'default'`/`'none'` Remap patterns only (force-directed
above and section-based views' fixed grid have no free row/column axis to bias, so all
three are silently ignored there — the Remap dialog hides their controls whenever
`pattern:'force'` is selected). `edgeAssignment: {elementType: 'top'|'bottom'|'left'|
'right'}` pulls every part of a given type OUT of the normal stream/element-group grid
before that grid is built, and instead lays each edge's members out as a single row
(top/bottom) or column (left/right) along that side of the whole layout — ordered by
the same sort-priority keys as the main grid, so `connectionOrder` gives "natural flow"
within an edge too. The middle grid is computed first (completely unmodified, existing
code), then shifted right/down by one step to make room for any left/top band, then
each band is placed relative to the middle grid's own resulting bounding box.

`minimizeCrossings`/`minimizeConnectorLength` (both `boolean`) are the two phases of
the classic Sugiyama layered-graph-drawing pipeline, run in that order (ordering, then
coordinates) over the *middle* grid only, both immediately after it's built and before
edge bands are placed — both are bounded, iterative heuristics, not exact solvers, and
neither ever moves a node OUT of its already-assigned row (which stream/element-group
row a node landed on is always untouched, so neither can undo the existing grid's own
stream separation). `minimizeConnectorLength` (`minimizeConnectorLengthPass`) is the
*coordinate* phase: each row's nodes keep whatever left-to-right ORDER is now in place
(crossing-minimized if that ran, the existing sort-key order otherwise) but their exact
x shifts toward the average x of their connected neighbors (any row, not just
adjacent), shortening/straightening connectors — a node with no neighbors, or already
aligned with them, doesn't move. Each pass resolves a row two ways (a left-to-right
minimum-spacing sweep and a right-to-left one) and averages them, so the row doesn't
just drift in whichever sweep ran last. `resolveSpacedPositions` (the sweep-and-average
math) and `buildNeighborMap` (the connVms adjacency map) are shared between
`minimizeRowCrossings`, `minimizeConnectorLengthPass`, and the Edge Assignment
alignment pass below.

`minimizeCrossings` (`minimizeRowCrossings`) is the *ordering* phase — barycenter
averaging (sort each row by the average column position of its neighbors in the row
above/below, alternating direction) PLUS a **transpose** refinement pass (Gansner et
al., "A Technique for Drawing Directed Graphs", 1993 — the same two-phase structure
Graphviz's `dot` uses): after barycenter converges, repeatedly swap adjacent same-row
pairs whenever doing so strictly helps, until a full sweep finds no more improvements.
A swap's effect on the two adjacent items' own edges is fully local (swapping doesn't
change either one's left/right relation to any THIRD row member), so it's cheap to
evaluate directly per pair rather than recomputing the whole row. Reported directly,
after already trying every minimizeCrossings/minimizeConnectorLength on/off
combination: "did not produce desired result ... manually editing is not desired
option due to volume of views" — barycenter+a single transpose pass, scored only on
raw crossing count, reliably left two GENUINELY TIED orderings (identical crossing
count, different overall length) on the wrong one: a high-fan-out node at one END of
its row instead of centered between its own two targets, and a same-row-connected pair
(routine for the `'layered'` pattern, whose whole point is putting two directly
connected types on one row) "grouped" apart from each other instead of adjacent. Fixed
three ways, all found necessary via testing against the real reported data (a small
synthetic 2-/3-row fixture was NOT sufficient to reproduce the bug — it only shows up
once a row is pulled from BOTH above and below at once): (1) the full barycenter+
transpose search now runs from TWO starting points (downward-first and upward-first),
keeping whichever converges better — a single starting direction can get stuck in a
local optimum only reachable from the other; (2) the transpose step's per-swap
decision now also weighs LENGTH (inter-row AND intra-row, i.e. same-row-connected
pairs) as a secondary criterion, swapping a crossing-neutral pair when it strictly
shortens their own edges — without this, two orderings tied on raw crossing count can
never be locally improved upon; (3) the overall best-of-all-iterations result is
tracked by the SAME (crossings, then length) comparison, not crossings alone.

Neither optimization option stops at the middle grid — both extend to edge bands too,
each a real gap found via user testing after the first version of this feature shipped.
A band's ORDER, by default, comes from sortKeys (as described above); when
`minimizeCrossings` is also on, `orderBand` instead barycenter-sorts the band against
the middle grid's own FINAL positions on the band's along-axis (x for top/bottom, y for
left/right) — a member with no middle-grid connection at all falls back to (and ties
break by) the plain sortKeys position, so it's never reordered relative to other such
members. This is what resolves e.g. three Data Entities on a bottom band where one
entity is shared by two different middle-grid Capabilities and the other two are each
exclusive to one — alphabetical sortKeys order can easily disagree with the crossing-free
order (the shared entity needs to sit BETWEEN its two exclusive siblings), which
`minimizeCrossings` now fixes the same way it already fixes crossings within the middle
grid itself. Once each band's order is settled (by whichever of the two rules applied),
edge bands are placed at fixed, evenly-spaced positions along that order; THEN, if
`minimizeConnectorLength` is on, a further alignment pass runs per band: same
`resolveSpacedPositions` math as the middle grid, but solving for the band's *cross*
axis using the now-final middle-grid positions as neighbor lookups — the band's own
order and minimum spacing stay fixed, only where along that order each member sits
shifts. This is what makes e.g. a Business Function pinned to Top actually slide to sit
above (shorter connector to) whichever Process it's connected to, instead of just
occupying a static, evenly-spaced band slot regardless of connectivity. Both band
passes are one-directional (bands align to the middle grid, never the reverse), so
neither risks perturbing the middle grid's own already-finalized layout.

Two further pieces of state, separate from the layout algorithm itself:
`view.remapLastOptions` (set by `remap()` on every successful run, alongside the
pre-existing `view.remapSortKeys`) records every OTHER dialog field — pattern,
edgeAssignment, both minimize checkboxes, template, etc. — as genuine per-view document
state (round-trips through `store.toJSON()`, same as `remapSortKeys` already did), so
reopening the Remap dialog on a SPECIFIC view starts from what was last used there, not
just the cross-view `getCachedRemapOptions` default. `wireCopyCallOnRightClick`
(main.js) is a small, deliberately generic helper wired onto the Remap dialog's submit
button: right-clicking copies a ready-to-paste `remap(app, tab, {...})` Script Console
call reflecting the form's current values, instead of opening the browser's own context
menu — any other dialog's submit button could adopt the same helper the same way.

### 6.1b The `'layered'` Remap pattern (`computeLayerAssignment`, `commands.js`)

A fourth row-assignment rule alongside `'default'`/`'none'`/`'force'`, reported
directly against a specific script's output: "The cleanest result of drawing the
script resulting data 'Smart Stream Example' ... would be (in a 4 x 4 grid): General
Actor ...; Business Function Production; empty; General Actor ... Row 2: Business
Capability ...; Business Process ...; Business Process ...; Business Capability ...
Row 3: ... Application Capability ... Row 4: Data Entity ... Is there any algorithm ...
that could result in this layout?" — confirmed "yes" to building it as a new pattern.
Where `'default'`/`'none'` group rows by stream/element-group membership (`custom.json`
data, which puts a Business Function and its own Processes in the SAME group — wrong
for this request, since the target layout splits them across rows), `'layered'` instead
derives each row purely from directed connector-graph structure: a node's row is the
FEWEST hops any real edge justifies from a root (a node with no incoming edges),
computed via a standard multi-source BFS over `connVms`. This is deliberately
shortest-path, not longest-path/topological-sort (Kahn's-algorithm) layering, which was
the first approach tried and rejected after real-data testing: the actual traced data
has a genuine `Capability -> Process` edge (so longest-path layering would obey it as a
hard constraint and push Process one row below Capability), but ALSO has Production
directly connected to Process and each Consumer directly connected to its Capability —
both exactly 1 hop from a layer-0 root. Shortest-path layering lets each node settle at
the row its NEAREST real dependency justifies, landing Capability and Process on the
same row as requested, without hardcoding either type's position. It's also naturally
robust to the dual-connector convention's genuine 2-node cycles (see §7 or the
`relationshipPairs.default` discussion elsewhere in this doc): once BFS visits a node at
its shortest distance, a later, longer edge back into it is simply a no-op — no
feedback-arc-set removal or cycle-breaking pass is needed at all (an earlier
implementation used DFS-based back-edge removal plus longest-path Kahn's-algorithm
layering specifically to handle these cycles; it was replaced by the simpler BFS once
testing against real "Smart Stream Example" data showed longest-path layering itself,
not cycle-handling, was the actual mismatch with the requested layout).

Column position within a row, and Edge Assignment/`minimizeCrossings`/
`minimizeConnectorLength`, are unchanged from §6.1a — `'layered'` only decides which row
a node belongs on, then feeds the same `remainingVms`/`passiveVms`-derived middle grid
into the identical downstream machinery every other pattern shares. No column-wrapping
(`limitColumnsToView`/"Limit columns to view" is hidden in the dialog for this pattern —
every row is exactly one graph layer, however wide) and no passive-row special-casing
(that convention is specific to `'default'`'s stream/group semantics; every part in the
middle set, passive or not, is placed purely by its own layer). `BatchScript_RemapExample`
(state.js) uses `pattern:'layered'` with no `edgeAssignment` at all — Business
Function/Consumer parts land on row 0 as true graph roots for free, directly satisfying
the original report's own "turning off the requirement of general actor" phrasing.

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

"SFCE" = Section → Function → Capability → [Application Capability] → Entity, a
4-level hierarchy (Application Capability optional — see `buildRowsFromRecords`' own
cascade comment for the 3-level fallback) used to bulk-generate Streams. Exactly ONE
such tree is ever loaded at a time — `store.doc.industryTree` (plus
`store.doc.industryTemplateName`, the streamTemplate `generateIndustry` §7.2 should
walk it with) — persisted as part of the document (round-trips through Save/Load
JSON), not a memory-only, multi-keyed map. See §7.5 for how it's boot-seeded and how
File > Load SFCCE replaces it. Tree shape:

```js
[{
  nodeElementType: 'BusinessFunction', nodeName, nodeId, nodeDescription, nodeSection,
  nodeSectionId, nodeSectionDescription,
  nodeChildren: [{
    nodeElementType: 'BusinessCapability', nodeName, nodeId, nodeDescription,
    nodeChildren: [{
      nodeElementType: 'ApplicationCapability', nodeName, nodeId, nodeDescription,
      nodeChildren: [{
        nodeElementType: 'DataDataEntity', nodeName, nodeId, nodeDescription,
      }],
    }],
  }],
}]
```

### 7.1 Load SFCE (`js/sfce.js` + `main.js` wizard)

Imports an arbitrary external JSON file, replacing whatever `store.doc.industryTree`
currently holds (see §7.5 — there's no "Industry Name" to pick, since only one
industry dataset ever exists). `flattenJsonRecords` detects the common "outer array of
groups, each with a nested array of items" shape and flattens it, carrying the outer
item's own scalar fields onto each flattened record. The wizard suggests field
mappings (keyword search, trying each candidate keyword across every available field
before moving to the next keyword, so a low-priority-but-early-matching field name
can't beat a better-but-later one). A multi-valued Section field splits into one row
per value.

**Shared-Function resolution**: after building rows, `detectSharedFunctions` finds
Function names spanning more than one distinct Section (not: a Capability whose own
Section field had multiple values — that's the row-split, a different, earlier step).
If any are found, `resolveSharedFunctions` applies the user's choice: collapse every
copy into one Function in a literal `"Shared"` section (capabilities from every
original section combined; true post-collapse duplicates merge naturally in the
tree-build step's own uniqueness handling), or keep each section's own copy with a
numbered suffix (plain name, then `Name1`, `Name2`, ... by first-seen section order).

**Description/Id mapping, every level** — the wizard's per-level mapping fields
(`buildRowsFromRecords`' `mapping` param) are fully symmetric across all 5 levels
(Section/Function/Capability/Application Capability/Entity): every level supports an
optional Description field, and every level supports an optional explicit Id field.
Descriptions behave exactly as before (never cascaded — see the module comment).
**Ids deliberately do NOT cascade either** — unlike names, inheriting an id from a
different level would wrongly conflate two distinct identities — a level with no
mapped/blank id field simply falls back to `buildIndustryTree`'s existing
auto-derivation (a chained `slugify` of section/function/.../name). An explicit id
gives that node real, stable identity, surfacing as `xIds`-based find-or-reuse once
`generateIndustry` (§7.2) creates the actual Part (it already passes `func.nodeId`/
`cap.nodeId`/`appCap.nodeId`/`ent.nodeId` through as `functionxIds`/`capabilityxIds`/
`applicationCapabilityxIds`/`entityxIds` — no changes needed there at all). Section
itself has no dedicated tree node (it's a plain string tag on each Function node, per
the module comment above) — its mapped id/description ride along on whichever
Function node(s) fall under that section instead, as `nodeSectionId`/
`nodeSectionDescription` (new sibling fields to the existing `nodeSection` string),
surfaced in the SFCE Catalog page (`flattenIndustryTree`'s `makeRow`) as new
`sectionId`/`sectionDescription` columns for full parity with every other level's own
id/description columns.

The wizard's per-field auto-suggestion (keyword search) needed one real fix while
building this: a bare `'id'` keyword is too generic for Capability Id/Application
Capability Id specifically — it happily matched an unrelated SHALLOWER field (e.g. a
top-level `domainId`) ahead of the real, deeper `capabilities.capId`, since the
existing depth-based shallow-vs-deepest tiebreak (already used to tell Capability
from Application Capability apart) only helps once the candidate set is scoped to
the right GROUP of fields in the first place. Fixed by first filtering to fields
whose own dotted path contains a `capab` substring (matching how a real
`capabilities`/`businessCapabilities` nesting key would appear in the path) before
ranking by depth — every other new field's suggestion keyword list is specific enough
(`'section id'`, `'functiondescription'`, etc., including camelCase-joined variants
since a dotted-path field name has no word-boundary separator to match `'section
description'` against) to not need this same group-scoping treatment.

**Dialog layout, "(generate unique)", and properties wiring** — a follow-up round on
the same feature. The wizard's 16 stacked `.prop-row`s (Industry Name + 15 mapping
fields) got long enough to warrant a dedicated compact layout: `.sfcce-mapping-row`
(CSS, new) lays out one row per level — Section/Function/Capability/Application
Capability/Entity — with its Field/Description/Id `<select>`s side by side via CSS
grid, collapsing 15 rows down to 5 (+1 header row), each `.sfcce-mapping-row` also
carrying `.prop-row` so it still inherits the shared select/input styling; a
`.modal-box .sfcce-mapping-row` override is needed since `.modal-box .prop-row`'s own
`margin-bottom` rule has higher specificity than a bare single-class selector would.

The mapping dialog's "nothing mapped" option is now worded per field KIND instead of
one shared, sometimes-misleading string: `fieldOptionsCascade` (Capability/
Application Capability/Entity NAME — genuinely inherits from the level above, so
"(none — inherit from the level above)" is accurate), `fieldOptionsDescription`
(never cascades — a plain "(none)"), and `fieldOptionsId` (adds a distinct
`GENERATE_UNIQUE_ID` sentinel option, "(generate unique)", alongside the existing
"(none — auto-generate from name)" blank). Choosing "(generate unique)" for any Id
field mints a genuinely random id (`crypto.randomUUID()`, `resolveMappedId` in
`sfce.js`) instead of either reading a real file value or falling back to the
deterministic slugified-name chain — resolved once per RESULTING ROW (inside the
per-section loop, not once per input record), since a Section field that splits one
record into several rows produces that many genuinely distinct nodes once sections
diverge, and each needs its own fresh id rather than sharing one.

The dialog's Load button now uses the same `wireCopyCallOnRightClick` mechanism
Remap's own submit button already established (§5.3-adjacent, `main.js`) —
right-click copies a `buildRowsFromRecords(records, {...})` call reflecting the
CURRENT mapping to the clipboard, via a `collectSfcceMapping()` helper shared between
the submit handler and the copy-call snippet (same "read the form once, use it
twice" pattern `collectRemapOptions` already established).

Finally, the mapped Section Id/Description now actually reach the generated
`BusinessOrganizationUnit` Part's own properties, not just the industry tree:
`createStream` (commands.js) gained `sectionId`/`sectionDescription` params, threaded
from `generateIndustry`'s own `func.nodeSectionId`/`func.nodeSectionDescription`, and
sets them as the OrgUnit part's `xIds`/`description` at creation — previously the
OrgUnit was always created with neither. (Note: reuse of an already-existing OrgUnit
still matches by section-string label, not by `xIds` — if the SAME section string
ever carried two different mapped ids across different generation runs, whichever id
created the part first wins; not something this round changes.) The SFCE Catalog
page's own `tab.tableCols` (`main.js`'s `openOrSwitchSfceCatalog`) gained matching
`sectionId`/`sectionDescription` columns for parity with every other level's own
id/description columns, which `flattenIndustryTree`'s `makeRow` already produces.

### 7.2 Generate Industry (`commands.js`)

Walks `store.doc.industryTree` (no key/argument — there's only ever the one), calling
`createStream` once per Capability×[ApplicationCapability×]Entity job (a level with no
children falls back to its own name/description standing in for the next level down —
`hasApplicationCapability`, driven by the TEMPLATE's `applicationCapabilityNameBegin`,
picks which of the two walk shapes applies). A `functionSection` parameter threads the
Function's `nodeSection` onto the generated Part — but note the actual Function-level
node for the default "Enterprise"/"SFCCE" stream templates is produced via the
*passive*-node code path (`template.passive`), not the main chain-building loop; wiring
a new per-Function field into the wrong path is a real, previously-shipped bug
(silently drops the field with no error) worth re-checking if the default template
ever changes shape again.

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

### 7.3 Section reification: `BusinessOrganizationUnit` (aka "OrgUnit")

A new element type (`public/custom.json`'s `settings.elements`, "Business" group,
`sources: 't'` — a TOGAF Content Metamodel concept, not core ArchiMate, unlike
`BusinessActor`'s `"at"`), added after confirming ArchiMate itself has no "Organization
Unit" notation element — the closest core concepts are `Business Actor` and `Grouping`,
neither literally named this. Its icon is a taller oval with a horizontal divider line
(distinct path from `Requirement`'s own plain, flatter oval, even though both are
ellipses). Reported directly: *"add it as a new element type, with oval icon (similar
to requirement but looks different), same group (and coloring, relations, etc.) as
togaf business actor."*

**Coloring** needed no code change at all — fill color is looked up purely by
`elementGroups` group membership (`elementGroupFill`), never per-type, so placing
`BusinessOrganizationUnit` in the same `"Business"` group as `BusinessActor`
automatically matches its color.

**Relations** needed real data, though: `store.mergedRelationshipPairs` unions
`custom.json`'s own (sparse, ~35-entry, hand-authored) `relationshipPairs` array with
`public/relationships.xml` (the official, ~3800-pair ArchiMate 3.2 concept matrix,
XML-first then custom.json overlays/extends — see `data.js`'s `mergeRelationshipPairs`).
Since `BusinessOrganizationUnit` isn't a real ArchiMate concept, it has zero entries in
that XML file, and — critically — hand-fabricating entries directly into
`relationships.xml` itself would misrepresent invented data as the official spec, so
that file was left untouched. Instead, every `relationships.xml` entry naming
`BusinessActor` (as source AND as target — 62 pairs each direction, 125 total including
a self-pair) was mirrored into `custom.json`'s own `relationshipPairs` array with
`BusinessOrganizationUnit` substituted for `BusinessActor`, preserving the exact same
relation-letter strings (and therefore the same computed default, since
`mergeRelationshipPairs` picks the first letter of the merged set as the default when
none is given explicitly — matching `BusinessActor`'s own real, un-overridden default
for every one of those same pairs). Generated mechanically (a one-off script, not
hand-typed), not maintained as ongoing generated output.

**Generation behavior** — the more involved half of the request: *"When we import or
generate involving sections, these will now be business organization units... when
loading SFCCE for example, now generate a orgunit part."* Section (`functionSection`,
§7.2 above) previously only ever landed on `Part.section` as a plain string tag,
propagated onto every part a stream generates but never itself represented as a node.
`createStream` (`commands.js`) now additionally reifies it: for each unique section
*value* (not per-function), find-or-create exactly one `BusinessOrganizationUnit` part
with that value as its label (reused across every function sharing the same section,
via the same `lookupCache.partsByKey`-style find-or-create convention used everywhere
else in this function for capability/entity reuse — never duplicated), then
Assignment-connect (`connectorType: 'c'`, relation key `'i'`) it to the function it's
responsible for — the standard ArchiMate "active structure element assigned to a
behavior element" pattern, matching how a `BusinessActor`/`BusinessRole` would
ordinarily relate to a `BusinessFunction` it performs. If `placeInView`, the OrgUnit
also gets its own ViewMember (positioned above the function, `store.
findNonOverlappingPosition` or the view's own section placer) and the connector gets
placed too — both idempotently: re-running `generateIndustry` over the same data
reuses the existing OrgUnit/connector/ViewMembers rather than creating duplicates.

The tricky part: `createStream`'s main `template.value[]` chain-building loop was the
obvious place to capture "the" canonical `BusinessFunction` part/ViewMember for this
wiring — but **every currently-shipped template** (`Enterprise`, `SFCCE`, `Enterprise
Full`, `Test`) puts `BusinessFunction` only in `template.passive[]`
(`{from:'BusinessFunction', to:'BusinessProcess'}`), never in `value[]` at all (this is
the exact same shape that caused a real, previously-shipped bug for the `functionSection`
field itself — see §7.2's own note). So the capture has to run in BOTH places: the main
loop (dead code for every template that ships today, but correct and harmless if a
future/custom template ever puts `BusinessFunction` in its main chain) and the passive
loop (the one actually exercised). The OrgUnit-wiring block itself runs once, after
BOTH loops finish, so it's fed whichever loop supplied the function part. A new
`plainConnsByFromTo` map was added to `createBulkLookupCache` (mirroring the existing
`connsByFromToModel`'s pattern exactly, just for `connectorType: 'c'` instead of `'s'`)
so the Assignment-connector existence check stays O(1) per job — the same
O(n²)-avoidance discipline §7.2 already documents for everything else in this loop.

**A second, real bug caught once §7.5's boot data actually became section-tagged**:
every shipped template's own `passive[]` array ALSO lists
`{from:'BusinessOrganizationUnit', to:'BusinessFunction'}` (added earlier, purely so
the 3D View's own "is this type in this Layer Order template" scan — which reads
`value[]`+`passive[]` — keeps OrgUnit parts visible). Left unguarded, the GENERIC
passive-node mechanism (the same loop, for every OTHER passive pair) would ALSO
process this entry, creating a second, wrongly-labeled (by capability/entity name
instead of the actual section value) OrgUnit per stream, Stream/Passive-connected
instead of Assignment-connected — duplicating this dedicated block's own work. Never
surfaced while the built-in dataset had no sections at all (§2's `general` predates
§7.5); became a real, reproducible bug (3 correct OrgUnits ballooning to 21) the first
time `generateIndustry` actually ran a section-tagged dataset through a template
carrying this passive entry. Fixed with a one-line guard at the top of the passive
loop: `if (ciEq(p.from, 'BusinessOrganizationUnit') || ciEq(p.to,
'BusinessOrganizationUnit')) continue;` — this dedicated block stays the SOLE owner of
OrgUnit creation.

This only ever triggers through `generateIndustry` — Load SFCCE's own data, or the
built-in default dataset (§7.5), which now also carries real section values; the plain
manual Generate Stream dialog never passes a `functionSection` at all, so it's
completely unaffected.

### 7.4 SFCE Catalog page

`flattenIndustryTree(tree)` turns any tree (Load SFCE's or the built-in default's)
into flat rows — one per Function/Capability/[ApplicationCapability/]Entity
combination, id and description at every level (blank ApplicationCapability columns
for the rarer 3-level shape) — fed directly into the generic table-tab mechanism
(§5.2). Read-only; no new rendering code. `App.openOrSwitchSfceCatalog()` (no
industryKey — only one dataset — see §7.5) always refreshes `tab.tableRows`/
`tableCols` from the CURRENT `store.doc.industryTree` on every open/switch-to, since
Load SFCCE can replace the data out from under an already-open tab; `finishSFCCEImport`
also refreshes it directly so a tab left open and visible during the import doesn't
show stale rows until next switched away and back.

### 7.5 Single industry dataset: boot auto-load, replace-with-warning, persistence

Reported directly: *"Now load the capabilities-general-SFCCE.json file automatically,
replacing the load and all logic for loading fce-generalnodes.json. Change logic so
only one Industry will be available, if user does a 'Load SFCCE' it clears and
replaces any existing industry SFCCE data (warn user first if data has already been
created). Can now remove any dialogs or parameters for industry (SFCCE dataset), there
will be only the one. It needs to be saved in the json file when user selects save,
and loaded if they load later."*

**Boot-load** (`js/data.js`): the built-in dataset now lives in
`public/capabilities-general-SFCCE.json` — a raw, loosely-nested JSON array (function →
capabilities[] → entities[], with `section` per function and `applicationCapability`
per capability, both already baked into the file rather than derived at load time) —
run through the EXACT SAME pipeline a real `File > Load SFCCE` upload uses
(`flattenJsonRecords` → `buildRowsFromRecords` → `buildIndustryTree`, via a fixed
`GENERAL_SFCCE_MAPPING` matching this file's own dot-path field names). No id fields
are mapped, so every node's id auto-derives from its own full ancestor chain (same as
any Load SFCCE import that leaves Id unmapped) — this is a real, deliberate difference
from the old `fce-generalnodes.json`, whose ids were hand-curated to be SHARED across
capabilities that happened to reuse the same entity (e.g. "Production Schedule" under
both "Manufacturing Operations" and "Production Planning" used to be ONE Part; now
they're two, since their auto-derived ids differ by ancestor path). `data.js` returns
`industryTree` (not a raw `fce` blob); `Store`'s constructor takes it directly as its
second positional param and seeds `doc.industryTree`/`doc.industryTemplateName:
'SFCCE'` with it. `GENERAL_SFCCE_MAPPING` DOES map `sectionIdField`/`sectionOrderField`
(`'sectionId'`/`'order'`, matching the file's own per-function fields, themselves
matching `custom.json`'s org-viewType `sections[]`) — this is what gives every
generated `BusinessOrganizationUnit` part a real `xIds` (previously blank, since only
mof/cof/ssf's functions carried an id at all) and lets `sfce.js`'s new
`nodeSectionOrder` (parallel to `nodeSectionId`/`nodeSectionDescription` — a plain
read-through value, not an id, so no cascade/`GENERATE_UNIQUE_ID` semantics) surface a
real display/generation order per section, both in the tree and as a new
`sectionOrder` column in the SFCE Catalog (§7.4).

**Single dataset, not a keyed map**: `store.industryData: {[key]: tree}` /
`store.industryTemplates: {[key]: name}` (memory-only, never persisted) are gone,
replaced by `store.doc.industryTree` (array) / `store.doc.industryTemplateName`
(string) — genuinely part of the persisted document now (see Persistence below).
Every call site that used to thread an `industryKey` string through
(`generateIndustry`, `App.runGenerateIndustryWithProgress`,
`App.openOrSwitchSfceCatalog`) dropped that parameter entirely rather than just
hardcoding a constant — there is structurally nowhere left for a second dataset to
live. `App.promptGenerateIndustry`'s industry `<select>` and
`App.promptSfceCatalog`'s multi-industry picker modal are both gone for the same
reason (only ever one option, so no picker was ever meaningful); each now just
toasts "No industry data loaded" if `doc.industryTree` is empty, then proceeds
directly. `promptSFCCEMapping`'s "Industry Name" text input and its duplicate-name
guard are gone too — there's no name to collide with any more.

**Replace with warning**: `promptSFCCEMapping`'s submit handler now always REPLACES
`doc.industryTree` (`finishSFCCEImport` sets it directly, doesn't merge/append), and
warns first — `App.confirmModal('...clear and replace the current industry data...')`
— whenever `doc.industryTree` is already non-empty. Since the built-in default is
always loaded at boot, this means the warning fires on effectively every real Load
SFCCE a person ever runs, which is the deliberately conservative reading of "if data
has already been created": there's no way to distinguish "just the untouched boot
default" from "something the person actually cares about" without more state than the
request asked for, so both count. Cancelling leaves the mapping dialog open
(un-removed) rather than discarding the person's field-mapping choices along with the
warning.

**Persistence**: `doc.industryTree`/`doc.industryTemplateName` are set inside the
`Store` constructor's `this.doc = {...}` object (previously `industryData`/
`industryTemplates` were set as separate `this.*` fields OUTSIDE `this.doc`,
specifically so they'd stay memory-only) — since `toJSON()`/`loadFromJSON()` both
operate on `this.doc` as a whole, this alone is what makes a Load SFCCE import survive
a Save/Load JSON round-trip. `migrateDoc` defaults a save file with neither field
(anything predating this change) to `industryTree: []`/`industryTemplateName:
'SFCCE'` — no prior users, so no attempt to reconstruct a lost industry dataset from an
old file; the person just re-runs Load SFCCE (or accepts an empty one) after loading
it.

**Types-filter connectors bug, fixed the same day**: unrelated to the above, but
reported alongside it — *"connectors not showing when types filtered; on a view when
using Filter Types, connectors should continue to be displayed unless unselected in
view properties."* `renderCanvasPage` (`canvas.js`) forced `connVms = []` whenever
`tab.connectorLevels` was 0 (the default) and any Stream/Type/Section filter was
active, even for a connector directly between two parts that both individually passed
the filter — contradicting `instructions.html`'s own documented meaning of "Connector
levels" (controls how many extra HOPS OF NODES to pull in beyond direct matches, not
whether an already-matching connector draws). Fixed by always passing the full
`allConnVmsInView` through to `redrawEdges`, which already does the correct
per-connector check on its own (stream filter, `chkShowConnectorType`/
`chkShowStreamType`/`chkShowDataType` view properties, both-endpoints-present) —
`connectorLevels` now purely controls the BFS node-expansion radius.

## 7a. The Data Modeling subsystem (crow's-foot ERD)

Entity-relationship modeling (typed attributes, primary/foreign keys, crow's-foot
notation, DDL import/export) layered on top of the existing `DataDataEntity` element
type rather than replacing or extending it — a `DataDataEntity` used in a Stream/
Capability Map stays exactly as it was; ERD detail lives on a *separate* Level Down
child, so the two concerns (business-level data entity vs. physical table schema)
never collide. New top-level "Data Modeling" menu (`index.html`/`main.js`, positioned
after Explore): **Add/Edit Entity Details**, **Autofill**, **Import DDL...**,
**Export DDL**.

**`DataEntityDetails`** (`public/custom.json`'s `settings.elements`, "Data" group) is
the new element type carrying ERD detail — `Part.attributes`, an array of `{id, name,
dataType, nullable, isPrimaryKey}`. Reached via Level Down from an existing
`DataDataEntity` (`App.promptAddEditEntityDetails`, the menu-triggered twin of
double-clicking a node — see the guard below) or created directly by DDL import
(freestanding, no parent `DataDataEntity` at all — a bulk schema import isn't
decomposing anything that already existed).

**Level Down Part-level guard** (`js/main.js`'s `openOrCreateLinkedView`,
`js/commands.js`'s new `findCompositionChildConn`/`findCompositionChildView`): a real,
general gap found while designing this feature, not something new to it.
`vm.linkedViewName` (the existing double-click "already decomposed, just reopen it"
check) lives on the *ViewMember*, not the Part — the same Part shown as two different
ViewMembers (e.g. the same `DataDataEntity` appearing on two different Stream views,
completely ordinary) had two independent `linkedViewName`s, so decomposing it from one
view and then double-clicking (or using Add/Edit Entity Details on) the OTHER instance
created a second, orphaned decomposition instead of reusing the first. Fixed by
checking, before falling through to `levelDownSingle`, whether the Part already has a
Composition child *anywhere* in the doc (`findCompositionChildConn`, the mirror of the
pre-existing `findCompositionParentConn`) and linking to its existing view instead.

**`attributes`' `'a'` showFields widget** (`render.js`'s `renderShowFieldsPanel`,
`renderAttributeListField`): the schema-driven property panel's field-type vocabulary
(t/m/n/y/c/s/b/h) gained a new letter, `'a'`, rendering an inline editable table
(add/edit/delete rows) rather than a single input — the first field type that isn't a
scalar value. `isForeignKey` is deliberately **not** a stored field on the attribute —
it's computed live and shown as a read-only badge, so it can never drift out of sync
with the connectors that are the actual source of truth for what references what (the
same principle Composition/`mirrorOf` already follow elsewhere in this codebase,
applied to a new kind of reference). The derivation (`isAttributeForeignKey`,
`render.js`) checks BOTH ends of a `'d'` connector's `fromAttribute`/`toAttribute`
pair, not just `fromAttribute` — this app has three independent `'d'` connector
creation paths, and they don't agree on which end holds the actual FK column (DDL
import: `fromAttribute` = child's FK column, `toAttribute` = parent's referenced
column; manual drag-to-connect and Autofill, both later additions: the OPPOSITE,
`fromAttribute` = source's own PK, `toAttribute` = the newly-created FK — see their
own sections below). A single hardcoded "`fromAttribute` is always the FK" check (the
original implementation) was a real, reported bug: attributes created by Autofill or
drag-to-connect never showed the FK badge, and manually adding an `isForeignKey: true`
key did nothing, since the field doesn't exist. Fixed convention-agnostically: whichever
end of the pair references an attribute that IS flagged `isPrimaryKey` is the
"referenced" (parent) side, and the OTHER end is the actual foreign key — correct
regardless of which literal field each convention happens to store which role in.

**Connector type `'d'`** (crow's-foot relationships between two `DataEntityDetails`):
the third `connectorType` value alongside `'c'`/`'s'`. Unlike adding a new *element*
type (pure `custom.json` data — every read site already resolves `settings.elements`
dynamically), `connectorType` values are load-bearing string literals scattered across
several files, so `'d'` needed real code changes at each: `main.js`'s
`CONNECTOR_TYPE_ITEMS` (toolbar filter) and Insert Smart Stream's connector-type
`<select>`; `canvas.js`'s `chkShowDataType` visibility toggle (view-level, its own
`showFields` entry, sibling to `chkShowConnectorType`/`chkShowStreamType`) and its
crow's-foot marker rendering (below). Routing style is NOT given its own
`routingStyleData` field — `'d'` connectors simply fall into the existing
`routingStyle` (non-stream) bucket via `drawEdge`'s existing ternary, since that was
already functionally correct and a dedicated field would be unused scope creep.

A `'d'` connector stores four fields beyond the usual `from`/`to`: `fromAttribute`/
`toAttribute` (attribute *ids*, not names — stable across a column rename) and
`fromCardinality`/`toCardinality` (one of `'one'|'many'|'zeroOrOne'|'oneOrMany'`,
explicit per the user's own call — auto-derivation from PK/FK/nullable "may need to
revisit at a later step"). The property panel's From/To Attribute selects are the
first "options depend on ANOTHER field's current value" case `render.js`'s
`selectOptionsFor` has needed — `ctx.fromPartId`/`ctx.toPartId` (added alongside the
existing `ctx.fromType`/`ctx.toType`) let it look up whichever table is on that
specific end and list only its own attributes.

**Crow's-foot rendering** (`canvas.js`'s `drawEdge`, `CARDINALITY_LINE_ENDS`): reuses
the existing `lineEnds`/marker-def machinery (`buildMarkerDefs`, driven generically by
`settings.lineEnds`) rather than inventing a parallel rendering path — four new
`lineEnds` entries (`crowOne`/`crowMany`/`crowZeroOrOne`/`crowOneOrMany`) are plain SVG
path data, exactly like every existing arrow/diamond marker. `'d'` connectors look up
their marker by `fromCardinality`/`toCardinality` instead of the normal
relationship-driven `lineEnds` lookup, falling back to the relationship-driven one when
no cardinality is set yet (a fresh, unconfigured connector). A real bug found and fixed
during development: `crowZeroOrOne`'s circle was originally centered at a negative Y
that fell outside the shared marker `viewBox` (`buildMarkerDefs`' hardcoded
`"-12 -2 24 24"`, Y range -2..22) — silently clipping almost the entire circle down to
an unrecognizable sliver, invisible to any check of the marker's DOM attributes (fill/
stroke/path were all "correct"; only the actual rendered geometry was wrong). Confirmed
visually via a zoomed screenshot; the permanent regression test parses the shipped
path data directly and asserts its Y-bounds fit the viewBox, reproducing the exact bug.

**Creating `'d'` connectors and attributes actually being visible** — three real gaps
found and fixed immediately after the feature above first shipped, reported directly:
*"attributes on dataentitydetail are not appearing visually on node. unable to enable
FK. unable to create crows foot connector with another dataentitydetail, or at
datadataentity level."* All three traced back to the same root cause: the pieces above
built the *data model, rendering, and DDL import* for `'d'` connectors, but never the
*manual, canvas-driven* path a person actually uses day to day.
- **Attributes weren't drawn on the node itself** — `buildNodeEl` (`canvas.js`) never
  read `Part.attributes` at all, only the property panel did. Fixed by rendering each
  attribute as `name : dataType` (🔑 for PK, `(FK)` via the same live
  `isAttributeForeignKey` lookup the property panel uses — factored out of
  `render.js`'s `renderAttributeListField` into a shared export so canvas and panel
  can never disagree) inside the node, gated by a new `chkShowAttributes` view toggle
  (sibling to `chkShowDescription`/`chkShowKeys`). Node height/width is uniform per
  *view*, not per node (`getNodeSize`) — rather than building a whole new per-node
  sizing mechanism, this relies on `redrawNodeSizes`' existing content-measuring pass
  (which already calls `buildNodeEl` itself to measure) to naturally grow the view's
  shared node size to fit whatever attribute lists are now being rendered.
- **Drawing a connector by dragging always created `'c'`** — `main.js`'s
  `beginConnect`/`finishConnect` (the drag-a-node's-`.fnode-handle`-to-another-node
  flow) hardcoded `connectorType: 'c'` unconditionally; there was no toolbar toggle,
  modifier key, or dialog offering `'d'` anywhere in that path, so a `'d'` connector
  could only ever come from DDL import. Fixed by inferring `connectorType: 'd'`
  automatically when *both* drag endpoints are `DataEntityDetails` — the same
  "infer by type context, no picker needed for the common case" pattern the stream
  companion-connector logic already uses for `'s'`/`'c'` — while every other type
  pairing (including `DataDataEntity → DataDataEntity`, the *"or at datadataentity
  level"* half of the report) still gets a plain `'c'` connector as before.
- **`connectorType` had no edit surface anywhere** — its own `showFields` entry was
  `access:'r'` (readonly text), and neither the edge popover (`showEdgePopover`,
  relationship-only) nor any context menu exposed a way to change it, so even an
  *existing* connector's type could never be corrected manually — the actual root
  cause of *"unable to enable FK"*, since FK is derived from a `'d'` connector's
  `fromAttribute` (above) and there was no way to ever get one to exist except the
  one now-inferred drag case. Fixed generally, not just for the inferred case:
  `connectorType` is now a genuine `'s'` (select) field with real `c`/`s`/`d`
  options, editable like `relationship` already was — the broader, reusable fix
  (any connector's type can now be changed after the fact, not just ones between two
  `DataEntityDetails` tables) rather than only patching the one auto-inferred path.

**Attribute-editing ergonomics and auto-FK-on-drag** — six issues reported together in
a follow-up round, once the feature was actually being used: *"when keying in data
entity details attributes, tab should take user to next field... need ability to move
attribute up or down. type should be drop down list of acceptable types... unable to
enable pk in property panel attribute section... when connector dragged/created, auto
create a fk in target of primary key from source... problem: double click on
datadataentity or menu data Modeling -> add edit entity details creates a new
datadataentity, should be a dataentitydetail element for the details."*
- **`levelDownSingle` copied the parent's own type unconditionally** — correct for
  every OTHER element type's Level Down, but wrong for `DataDataEntity`, whose
  decomposition child must be `DataEntityDetails`. Fixed with a single special case
  (`ciEq(part.type, 'DataDataEntity') ? 'DataEntityDetails' : part.type`) in the one
  function both entry points (double-click and the menu command) already share, so
  both were fixed together with no duplicated logic.
- **Data Type became a fixed dropdown** (`ATTRIBUTE_DATA_TYPES` in `render.js`:
  numeric/string/boolean/date/blob/json) instead of free text — but DDL import still
  needs to land arbitrary concrete SQL types (`VARCHAR(100)`, etc.), so
  `renderAttributeListField` always injects the attribute's current value as an extra
  selected `<option>` when it isn't one of the fixed six, rather than silently
  clobbering it on next render.
- **Tab-key navigation lost focus to `<body>` entirely**, and this turned out to be
  the actual root cause of the separately-reported *"unable to enable pk"* too: a
  keyboard-driven person could never tab their way to the PK checkbox at all. Root
  cause — every attribute field's `'change'` handler calls `app.recordAndRender()`,
  which rebuilds the whole property panel's DOM; the native browser tab-order target
  (resolved against the OLD DOM *before* the rebuild) no longer existed by the time
  focus would actually land. Fixed with explicit `keydown` handlers on Name/Data
  Type/Nullable/PK that `preventDefault()`, commit the field themselves
  (deterministic — not dependent on native blur/change timing, which differs between
  a text input's blur-triggered change and a select's immediate change), then
  explicitly re-locate and focus the correct next field (`focusAttrField`, keyed by
  the table's own stable container id + the row's attribute id, since row order
  doesn't change from a Tab) in whatever DOM exists afterward: name → data type →
  nullable → PK → next row's name, or the Add Attribute button after the last row.
- **Row reordering** — ▲/▼ buttons per attribute row, swapping array position and
  recommitting, matching the existing delete button's wiring pattern exactly.
- **Auto-FK-creation-with-cardinality on drag** (`main.js`'s `finishConnect`): when a
  manually drag-created connector infers `connectorType: 'd'` and its source (the
  drag's "from"/parent side — *"Connectors are created from parent to children"*) has
  a primary key, the target automatically gets a matching FK attribute if it doesn't
  already have one — named `` `${toSnakeCase(fromPart.label)}_${toSnakeCase(pkAttr.name)}` ``
  (a small new `toSnakeCase` helper), reusing a same-named existing attribute
  case-insensitively rather than duplicating it — and the connector gets
  `fromCardinality: 'one'`/`toCardinality: 'many'`. This is deliberately the *reverse*
  of `importDDL`'s own convention (`fromCardinality: 'many'`, `toCardinality: 'one'`)
  — there, "from" is DDL's own referencing/child table (its `FOREIGN KEY` clause names
  it), so "many" is correct on that side; here "from" is the parent/PK side being
  dragged *from*, so "one" is correct. Two intentionally different conventions for two
  different creation paths, not reconciled between them.

**Autofill** (`dataAutoFill()` in `DEFAULT_BATCH_SCRIPT_CODE`, `state.js`; `App.
promptAutofill`, `main.js`) — a different kind of Data Modeling command from every
other one on the menu: it's not a fixed function in `commands.js`, it's a *named
function living inside the user-editable batch script* (`store.batchScriptCode`, the
same text the Script Console's `main()` is defined in). Reported directly: *"add a new
command to menu 'Data Modeling' called autofill, which will call a script called
dataAutoFill. This script (store/save/edit same as BatchScript_QuickStart approach)
will loop through dataentitydetail nodes on current view, and if attributes have not
been created yet (don't override existing) it will create an attribute using the label
+ 'Id', of type numeric, flag as primary key. Also create an attribute called label +
'Name', of type string, and null enabled. Also create an attribute called label +
'Description', of type string, and null enabled. Next loop through data connectors. If
the 'from' attribute have not been set: set From to the pk of the from node/part. set
To to the same field name in to node/part after creating it (numeric null fk), set
cardinality as from: one and to: one or many."*
- `promptAutofill` compiles `store.batchScriptCode` with the exact same bindings
  (`app`/`store`/`model`/`findParts`/`log`/`messageLog`/the raw `commands.js` command
  functions) `promptScriptConsole`'s own Run button uses via `new Function(...)` — but
  extracts and calls a top-level `dataAutoFill` instead of `main`, so editing
  `dataAutoFill()` in Script Console genuinely changes what the menu item does,
  without needing a separate storage/editing mechanism of its own.
- `dataAutoFill()` itself lives in `DEFAULT_BATCH_SCRIPT_CODE` alongside the three
  `BatchScript_*` example functions, but is deliberately **not** called from `main()`
  — `main()` unconditionally chains all three starter scripts on a fresh document with
  no Data Entity Details tables yet, and `dataAutoFill` would just throw there.
- Scoped to whatever `DataEntityDetails` parts + `'d'` connectors are placed on the
  *current view* (`store.viewMembersForView`), the same "current view, not whole
  model" scoping as `exportDDL`.
- Pass 1 (attribute scaffolding): a table with **zero** attributes gets exactly three
  — `<label>Id` (numeric, not null, PK), `<label>Name` (string, nullable),
  `<label>Description` (string, nullable) — literal string concatenation of the
  table's own label, not slugified/snake-cased (the labels are typically already
  reasonable identifiers, e.g. "Customer" → "CustomerId"). A table that already has
  *any* attributes at all is left completely untouched — "don't override existing"
  means don't touch that table, not "fill in only the missing ones of these three."
- Pass 2 (connector wiring): a `'d'` connector whose `fromAttribute` isn't set yet gets
  `fromAttribute` = the source table's own PK attribute id, `toAttribute` = a
  same-named attribute on the target table (case-insensitive reuse if one's already
  there, otherwise created — numeric, nullable, not a PK), and
  `fromCardinality:'one'`/`toCardinality:'oneOrMany'`. A connector that already has
  `fromAttribute` set is left completely untouched. Deliberately a THIRD naming/
  cardinality convention alongside the manual-drag one (`main.js`'s `finishConnect`,
  which snake-cases `<parent-label>_<pk-name>` and uses one/many) and `importDDL`'s
  (many/one) — here the target attribute reuses the source PK's own name verbatim
  (already label-prefixed by pass 1, e.g. "CustomerId" on both ends), and cardinality
  is one/oneOrMany specifically for this bulk-scaffolding case. Three intentionally
  different conventions for three different creation paths, none reconciled with the
  others — each is correct for its own context (typed-by-hand DDL text, one
  interactively-drawn connector, or a whole view's worth scaffolded in bulk).
- `newId()`/`ciEq()` aren't in the Script Console's binding set (a `new Function(...)`
  body doesn't share the module's lexical closure, only what's explicitly passed in),
  so `dataAutoFill()` uses the true global `crypto.randomUUID()` directly and a plain
  `.toLowerCase()` comparison instead — no new bindings needed for this feature.

**FK derivation bug, found using Autofill itself**: reported directly, *"foreign key
flag still not appearing anywhere, field is created in autofill script when parent
connected to child but not flagged as foreign key... Tried manually creating
isForeignKey: true, didn't work still not showing."* Confirmed there is no
`isForeignKey` field anywhere — see `isAttributeForeignKey`'s own updated doc comment,
`render.js`, for the full explanation and fix: the original hardcoded
"`fromAttribute` is always the FK" check only ever matched DDL import's own
convention; Autofill and drag-to-connect store the pair the other way around, so
their FK attributes never showed the badge. Fixed to check both ends, deriving FK
status from whichever end references an attribute actually flagged `isPrimaryKey`.

**Level Up on a DataEntityDetails node** (`js/commands.js`'s new
`levelUpEntityDetails`; dispatched from `runCommand`'s existing `'levelUp'` branch,
`main.js`) — the reverse of Level Down's `DataDataEntity` → `DataEntityDetails`
special case, reported directly: *"when a single dataentitydetail is selected and
user selects 'level-up' command, create (if doesn't already exist, otherwise just
open) a new datadataentity part/node of the same label name with link/connector
result as when done in reverse where user selected datadataentity and did
level-down."* `runCommand`'s ordinary Level Up (generic, `enabled: isCanvas`, unaware
of selection) is unconditionally unchanged for every other case — this only
special-cases exactly one selected `DataEntityDetails` ViewMember.
- "Doesn't already exist" is checked via `findCompositionParentConn(store, part.id)`
  — the SAME Composition-lookup `levelDownSingle`'s own reuse guard uses (see the
  Level Down Part-level guard, above), just walked in the other direction: this part
  is the Composition's `to` (child) side, its parent (if any) is `conn.from`. If
  found, this just opens/selects wherever that parent Part happens to already be
  placed (its first ViewMember found) — a `DataDataEntity` can legitimately be placed
  on more than one view (ordinary usage, e.g. shared across several Streams), so
  "first placement found" is a deterministic choice, not a uniqueness guarantee.
- If no parent exists yet, creates one: a new `DataDataEntity` part with the SAME
  label, a fresh dedicated view (the identical `New View`/dedup-suffix naming
  `levelDownSingle` uses), and the identical link shape `levelDownSingle` produces in
  the other direction — an unplaced Composition connector (`from`: new parent, `to`:
  this `DataEntityDetails` part) plus the new parent's own ViewMember's
  `linkedViewName` pointing DOWN at the CURRENT view (the Entity Details view the
  command was invoked from) — so double-clicking the new parent node
  (`openOrCreateLinkedView`) navigates straight back down to this exact view, mirroring
  how a normal Level Down's parent-side `vm.linkedViewName` already works.
- The command palette's own hint text (`getCommandDefs`, `render.js`) changes to
  *"Level Up — create (or open) this table's Data Entity parent"* only while a single
  `DataEntityDetails` node is selected, so the toolbar/context-menu button itself
  reflects which behavior will actually run.

**DDL import/export** (`js/ddl.js`, a new pure-logic module alongside `sfce.js`/
`archimate.js` — no DOM dependency, testable under plain `node`): a deliberately
*scoped* `CREATE TABLE` subset (MySQL/Postgres-flavored: column definitions, inline or
table-level `PRIMARY KEY`, table-level `FOREIGN KEY ... REFERENCES`), not a general SQL
grammar — no npm packages are allowed in this project, so the parser is hand-written
string scanning (`splitTopLevel` splits on a delimiter only at paren-depth zero and
outside quotes, so `DECIMAL(10,2)` and `REFERENCES t(c)` don't fracture a column list).
Anything outside the subset throws with a specific message naming the exact
table/entry that failed (not a silent drop or a generic failure) — `Import DDL...`
(`commands.js`'s `importDDL`, wired to the `import-ddl-input` file picker exactly like
ArchiMate import) creates all-or-nothing: if `parseDDL` throws, nothing is created.
`generateDDL` is the reverse, scoped to whichever `DataEntityDetails` parts + `'d'`
connectors are actually placed on the *current view* (matching Insert Smart Stream's
own per-view scoping, not whole-model) — shown via the existing `promptTextEdit`
readonly viewer (same one Code Summary uses), not a bespoke dialog.

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
  - **Connector levels (0, the default) was hiding connectors on the 2D canvas whenever
    a Stream/Type/Section filter was active — reported directly: "connectors not showing
    when types filtered; on a view when using Filter Types, connectors should continue
    to be displayed unless unselected in view properties."** `renderCanvasPage`
    (`canvas.js`) forced `connVms = []` whenever `tab.connectorLevels === 0` and any
    filter was active, even for a connector directly between two parts that BOTH
    individually passed the filter — contradicting `instructions.html`'s own documented
    meaning of "Connector levels" (how many extra hops of NODES to pull in beyond direct
    matches, not whether an already-matching connector draws). Fixed by always passing
    the full `allConnVmsInView` through to `redrawEdges`, which already does the correct
    per-connector check on its own (stream filter, `chkShowConnectorType`/
    `chkShowStreamType`/`chkShowDataType` view properties, and both-endpoints-present) —
    `connectorLevels` now purely controls the BFS node-expansion radius
    (`expandVisiblePartVmIdsByLevel`), never connector visibility directly.

- **Stage 6 series (done)** — six further real-usage fixes; see `view3d.js`'s own
  inline Stage 5.2/6/6.1/6.2/6.3/6.4/6.5 header comments for full rationale/tradeoffs
  on each.
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
  - **View Scope (Stage 6.5).** Reported directly: "add the ability for 3d view to show
    data based on an existing view." New toolbar `<select>` (3D-only, like Layer Order)
    narrows the whole scene down to exactly what ONE chosen 2D view has placed, instead
    of the whole document (still what "All" means, the default). Built as a new filter
    on the EXISTING 3D tab rather than a separate tab/entry point, so it composes
    cleanly with every other filter already there (Stream/Type/Section/Connector
    Type/Layer Order/Highlight all still apply WITHIN the scoped set).
    `tab.view3DScopeViewId` (`null` = unscoped) resolves to two id `Set`s —
    `scopedPartIds`, `scopedConnectorIds` — straight from
    `store.viewMembersForView(viewId)`, so a part or connector shows only if it's
    ACTUALLY placed on that view, not merely "both endpoints happen to also be
    visible" (the way ordinary connector visibility works elsewhere in this file) — an
    exact mirror of that view's own 2D content. `computeSignature` grew a dependency on
    the scoped view's own viewMembers (only computed when a scope is actually set, to
    keep the common unscoped case exactly as cheap as before) — nothing else it already
    hashes changes when a part is merely added to/removed from a view, so without this
    a scoped rebuild could be silently skipped.

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
