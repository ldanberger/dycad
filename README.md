# FlowRun

A single-page ArchiMate-based workflow canvas for enterprise architects. Pure vanilla
JS/HTML/CSS — no backend, no build step, no npm packages. Open `index.html` in a browser
served from this folder (a local static server is fine; `file://` will block the
`fetch()` calls to `public/*.json` and `public/relationships.xml` due to browser CORS
rules on local files).

To run:

```
cd flowrun
python3 -m http.server 8080
# open http://localhost:8080
```

## Structure

```
index.html          3-column layout shell
css/styles.css       light/dark theme via CSS variables
js/data.js            startup fetches + relationships.xml parsing + relationshipPairs merge
js/state.js           Store: models/parts/connectors/views/viewMembers, tabs, undo/redo,
                        id generation, createdAt/updatedAt timestamps, save/load migration
js/rules.js            connector validity lookups (merged relationshipPairs)
js/render.js            header/toolbox/properties rendering, schema-driven show-fields
                        panels (settings.showFields), catalog row panels, Root Properties
js/canvas.js            interactive canvas: nodes, edges, drag/connect/lasso, catalog table
                        pages, connector routing dispatch, marker/arrowhead defs
js/commands.js         Duplicate Stream, Split Node, Level Up/Down, Generate (createStream),
                        Remap, Merge, Smart Check View, Generate Industry/Inventory View
js/layout.js            force-directed placement + connected-component grid packing
                        (Remap's "force" pattern)
js/routing.js           obstacle-avoiding connector routing (direct + Manhattan styles),
                        visibility-graph pathfinding
js/sections.js          section/grid-based view layout (fixed-cell placement, as opposed
                        to js/layout.js's force-directed freeform placement)
js/simulation.js        node-scripting tick engine, Message Log
js/archimate.js         ArchiMate 3.0 Exchange Format import — parts/connectors/views,
                        junction flattening, nested-shape Composition/Aggregation detection
js/main.js               app controller, event wiring, save/load, modals
public/                 copies of the source data files, fetched at runtime
tests/                  lightweight Playwright-based regression suite — see tests/README.md
```

Per-version changes from Step 26 onward are documented as detailed comments directly
above `APP_VERSION` in `js/version.js` (what changed, why, and how it was verified) rather
than in this file — check there for anything past Step 25. The step-by-step log below
covers the earlier build (Steps 2–23).

## Known limitations

A few permanent, deliberate tradeoffs — not bugs to keep re-investigating:

- **Force-directed layout (Remap's "force" pattern) can't guarantee every edge lands in
  an adjacent grid cell.** Spanning-tree edges do, by construction. A "back edge" — e.g.
  the third edge of a fully-connected triangle, where the first two already used up the
  shared node's adjacent slots — gets the closest achievable placement instead. No 2D
  grid embedding can do better for an arbitrary graph; a 5-node complete graph provably
  can't be drawn with every edge between neighboring cells at all.
- **Obstacle-avoiding connector routing (Direct/Manhattan) only considers obstacles
  local to each connector's own region**, not the whole diagram, for performance reasons
  on large views. A connector will route around nodes near its path but won't discover a
  detour around something far away that happens to be relevant only because of how a
  third connector crosses it.
- **ArchiMate import's nested-shape detection only covers Composition/Aggregation.**
  These are the two relationship types ArchiMate tooling conventionally represents via
  visual nesting; other relationship types drawn without an explicit `<connection>`
  element (unusual, and not a standard convention) won't be picked up by this specific
  detection.
- **Smart Check View's two checks are intentionally independent.** With only "missing
  connectors and nodes" checked, a pair that was already both-present and disconnected
  before the command ran stays disconnected — fixing that is specifically "missing
  connectors"'s job. Most users will want both checked together.

## Design decisions on underspecified areas

The instructions document has more implicit logic in the sample data (`onestream.json`)
than in its own prose, and a few things are referenced without a full spec. Where I had
to make a call, here's what I did and why — flag any of these if they don't match intent:

- **Generate / createStream**: I reverse-engineered the exact labeling and passive-node
  logic against `onestream.json`'s `home` view, which is consistent with the Enterprise
  stream template's `value`/`passive` arrays and matches node-for-node (same relationship
  names, same connectorType `s`). The `Data` template's `capabilityNameBegin`/
  `entityNameBegin` intentionally reference element types that don't exist
  (`BusinessServicetbd`, `TechnologyLogicalComponenttbd`) — Generate correctly aborts
  with an error for that template rather than proceeding, per spec.
- **Undo/redo snapshots**: the spec says "each tab owns nodes/edges/viewport/history,"
  but nodes/edges are really just viewMembers referencing globally-shared Parts/Connectors
  across views. I snapshot the full doc (`parts`, `connectors`, `viewMembers`, `views`)
  per recorded action, keyed per tab. This is safer than a partial snapshot (it can't
  desync from cross-view references) at the cost of slightly larger snapshots.
- **Level Down "preserve id so edges resolve"**: taken literally, this would require two
  viewMembers sharing one `id` across two views, which breaks id-based lookup. I copy the
  neighbor into the new view with a *new* viewMember id but the *same* `objectId` (the
  underlying Part), marked `isExternal: true` — functionally equivalent (same node,
  recognizable as external) without ambiguous ids.
- **Level Up linkedViewName direction**: the new "Unknown" node's `linkedViewName` points
  back down to the view you leveled up *from*, mirroring how Level Down's placeholder
  node links down into its new sub-view. Double-clicking either navigates to the
  more-detailed view.
- **"Merge" command**: mentioned once in the instructions but never specified (also
  flagged in the earlier audit of this project). Not implemented — no behavior to infer.
- **connectorType 's' vs 'c'**: `s` (stream) is used exactly where specified (Generate,
  Duplicate Stream); everything drawn by hand via the connect-handle uses `c`.
- **Relationship validation**: `relationships.xml` (full ArchiMate 3.2 matrix) is merged
  with `custom.json`'s `relationshipPairs` — union of relation letters per `A→B` pair,
  A→B never inferred to also allow B→A. This is what lets the proprietary types
  (`GeneralActor`, `Tester`, `Multi`, etc., absent from the ArchiMate standard) get valid
  connections, since those rules only exist in `custom.json`.
- **View toggles**: `chkShowElementTypes` and `chkShowConnectors` have visible effects
  (type label, edge visibility). `chkShowKeys` shows the part id under the label.
  `chkShowOnPageCatalogs` is stored/persisted but has no rendering behavior yet — the
  spec doesn't describe what an "on-page catalog" should look like.

## Step 2 changes (zoom/pan/connector fixes, icons, catalogs, Advanced menu)

Real bugs found via actual browser testing (Playwright + pixel/DOM inspection — not guesswork):

- **Connector arrowheads were invisible**: edges were drawn to each node's *center*, and
  since nodes are opaque and render above the SVG layer, the arrowhead was rendered but
  hidden underneath the destination node. Fixed by clipping edges to the node's rectangle
  boundary (`edgeEndpoints`/`clipToRectEdge` in `canvas.js`).
- **Panning/scroll reset**: every re-render fully tore down and rebuilt the canvas DOM,
  resetting scroll to (0,0). This was the real cause of both "vertical scroll snaps back"
  and "horizontal panning doesn't work" (it moved, but the very next render — including
  ones triggered by the drag itself — snapped it back). Fixed by persisting scroll
  position on `tab.viewport.{x,y}` and restoring it after every rebuild.
- **Zoom**: added via CSS `zoom` on `.canvas-surface` (not `transform`, since `zoom`
  keeps native scroll/hit-testing math simple — `getBoundingClientRect()` already
  reflects it). Floating +/−/reset control bottom-right of the canvas, plus Ctrl/Cmd+scroll
  to zoom centered on the pointer. All screen→model coordinate math (drag, connect,
  lasso, drop) now divides by the active zoom factor.
- **Toolbox & node icons**: now render `element.path` as an SVG `<path>` filled with
  that element's `elementGroups.fill` color. Toolbox tiles sorted by
  `element.tkDisplayOrder` (stable sort — ties keep `custom.json`'s original order).
  Tooltip is just the element `type`. Node top row gets the same icon, plus
  `element.cornerRadius` applied to the node's border-radius, and the type label shows
  `element.title` rather than the raw `type` string.
  Note: 3 elements (`ApplicationPhysicalComponent`, `TechnologyPhysicalComponent`,
  `DataPhysicalComponent`) have a malformed `path` in `custom.json` (a curve command with
  the wrong number of coordinates) — browsers recover gracefully and render the valid
  prefix of the path, so this is a cosmetic data issue, not a functional one.
- **Properties panel**: each field is now label+value on one row (flex layout) instead of
  label-above-input.
- **Selection panel**: lists each selected node (label + type) under the selection count;
  clicking an entry re-selects just that node.
- **Top-level menu bar** (above the tabs row): **Advanced** (opens the 4 reference links
  in a new browser tab via `window.open`) and **Catalogs** (Parts/Connectors/Views/
  ViewMembers — each opens a single reusable tab showing a live table of that collection,
  read from the store directly so it stays current; re-selecting the same catalog switches
  to the existing tab instead of creating a duplicate).

All of the above was verified against a real Chromium instance (Playwright), not just
code review — DOM structure, pixel positions, scroll offsets, and click-driven tab
creation were all checked directly.

## Step 3 changes (icon styling, scrollbar bug, marker rotation)

- **Icon stroke**: toolbox and node icons now render `element.path` with `stroke="black"`
  in addition to the `elementGroups.fill` color, matching the reference `testicon.html`.
- **Icon coordinate space fixed**: `testicon.html`'s SVG uses `width="40px" height="20px"`
  with no `viewBox` — i.e. the path data's native coordinate space is ~40×20, not
  square. The icons were previously rendered in a `0 0 40 40` viewBox, which wasted the
  bottom half and made every icon appear smaller/off-center than intended. Fixed to
  `viewBox="0 0 40 20"`.
- **Toolbox**: rewritten to bare icons with no card/border/background/label, per
  `testicon.html` — just a draggable image with a tooltip, laid out as a flowing wrapped
  strip instead of a 2-column card grid.
- **Node top row**: title now left-justified, icon right-justified (`justify-content:
  space-between`), swapped from the previous icon-left/title-right order.
- **Real bug found while fixing the scrollbar report**: native scrollbar interactions
  fire `pointerdown` with `event.target` equal to the scroll container itself (there's no
  separate DOM node for a native scrollbar). The lasso-select handler was listening for
  exactly that (`e.target === scroll`), so *every* scrollbar click was being interpreted
  as "start a lasso on empty canvas," which — because that handler also called a
  synchronous `app.render()` to clear the previous selection — destroyed and rebuilt the
  very DOM element the browser's native scrollbar-drag was tracking, killing the drag
  mid-gesture. Fixed in two parts: (1) the lasso trigger now checks only
  `e.target === surface` (a real content click; the surface always fully covers the
  scrollable content area, so a scrollbar click can never land on it), and (2) the
  selection-clearing render was moved from mousedown to mouseup, since triggering *any*
  full re-render mid-drag was unsafe — it would silently orphan the in-progress gesture
  by replacing the DOM nodes the drag handlers were closed over. Both were verified with
  a real simulated mouse drag in Playwright (canvas DOM stays intact, selection resolves
  correctly on release).
- **Connector line-end rotation**: markers are now wrapped in `<g transform="rotate(90 0
  10)">` (90° clockwise around the marker's reference point), on top of the existing
  `orient="auto-start-reverse"` line-direction alignment.

## Step 4 changes (markers on all tabs, copy/paste, remap, dropdowns, versioning)

- **Markers missing on non-home tabs — root cause found**: marker `<defs>` were rebuilt
  per-tab on every render with identical ids (`marker-arrowSmall-medium`, etc). Inactive
  tabs' DOM is never cleared (just hidden via CSS), so once you'd visited a second tab,
  the document had multiple elements sharing the same id, and `url(#...)` references
  became ambiguous. Fixed by building all markers **once, globally**, at bootstrap
  (`buildMarkerDefs` now returns a single hidden `<svg>` appended to `<body>`), and every
  tab's edges reference that one shared set. Verified live: created a brand-new view/tab,
  added a node and connector purely via the API, and confirmed its edge's `marker-end`
  resolves to the real global marker element.
- **Line-end still slightly blocked**: increased the edge-clipping margin from 3px to
  11px so the whole marker clears the node border, not just its tip.
- **Copy / Paste**: `Ctrl/Cmd+C` copies the selected nodes (plus any connector that runs
  wholly between two copied nodes); `Ctrl/Cmd+V` prompts "Create new" vs. "Use existing"
  and pastes into the *currently active tab's view* (not the copy source), offset by
  40px. "Create new" clones fresh Parts/Connectors; "Use existing" reuses the same
  underlying Part/Connector records with new viewMembers only. Newly pasted
  nodes+edges become the new selection. Verified: "new" mode increases the Parts count;
  "existing" mode does not.
- **Auto-select after Generate / Duplicate Stream / stream filter**: implemented via a
  before/after diff of viewMember ids in the affected view (simpler and more robust than
  manually threading "was this newly created" through every call site). Selecting a
  stream in the filter dropdown now also selects every viewMember (node or connector) in
  the *current view* carrying that stream.
- **Stream filter is now per-tab**, not global — moved from a single `store.activeStream`
  to `tab.activeStream`. Verified two tabs hold independent filter values.
- **Properties panel**: Type and Model are now `<select>` dropdowns (all known element
  types sorted by `tkDisplayOrder`; all defined models). Changing Type also refreshes the
  node's fill color to match the new type's `elementGroups` color, so it doesn't go stale.
- **Commands panel**: rebuilt as a row of icon-only buttons (small hand-drawn SVG glyphs,
  `currentColor` stroke so they follow the theme) with the full description as the native
  tooltip, instead of label+hint text blocks. Copy, Paste, and Remap were added here too.
- **Remap command**: reorganizes the current view — finds the streamTemplate whose
  `viewtypes` includes the view's `viewType` (falling back to `'Enterprise'`, then the
  first available template), places nodes that are the "from" side of any Passive
  connector in a top row, nodes that are the "to" side in a rightmost column, and
  everything else in the main chain ordered by that template's `value[]` position
  (stacking same-column duplicates vertically). Verified against the sample data: the
  one genuinely Passive-`to` node in `onestream.json`'s home view was correctly pushed
  into the far-right column.
- **Save JSON / Load JSON / theme toggle** moved to the top menu-bar row, next to
  Advanced/Catalogs.
- **Toolbox tooltip** changed from `element.type` to `element.title`.
- **Visible version number**: `v0.1` shown in the header (no prior app-level version
  existed — `doc.version` is an unrelated JSON-save-format version, not a build number).
  I'll bump the minor version on each future round of changes.

## Step 5 changes (remap rework, resizable panels, lasso, connector filter, key display)

- **Toolbox sort**: now sorts by `element.group` (in `elementGroups`' own order) first,
  then `tkDisplayOrder` within each group — was `tkDisplayOrder` only. Verified: the
  first several tiles are now all "Application" group before any other group appears.
- **Remap, reworked**: estimates `MaxCols` from the shared canvas viewport width (read
  from `#pages-container`, so it works even for a brand-new not-yet-rendered tab — used
  by Level Down, see below); Passive-`to` nodes go in the `MaxCols`-th column; remaining
  nodes are ordered by the related streamTemplate's `value[]` position and wrap to a new
  row either at `MaxCols` columns *or* whenever `element.group` changes (whichever comes
  first); Passive-`from` nodes go in a top row. Verified against the sample data: nodes
  wrap into new rows exactly at each group boundary (General → Business → Application →
  Technology → Data), Passive-`to` nodes align in one shared column, Passive-`from` in
  the top row.
- **Level Down now uses the same remap layout** for its new view (previously it used
  fixed, ad-hoc coordinates for the external reference copies). Implemented as a shared
  `applyRemapLayout(app, viewId)` core function called by both the Remap command and
  Level Down.
- **Resizable left/right panels**: drag handles between the toolbox/canvas and
  canvas/properties panels (180–480px range), persisted to `localStorage`. Verified via
  a real simulated drag.
- **Lasso now selects on partial overlap**, not just "node center inside the rectangle."
  Nodes use rectangle-vs-rectangle overlap; connectors use a line-segment-vs-rectangle
  intersection test (point-in-rect for either endpoint, or the segment crossing any of
  the rectangle's four edges). Verified: a lasso covering only a node's corner selects
  it; a small lasso over just a connector's midpoint (touching no node) selects the
  connector.
- **View property: "Filter by connector type"** — new toggle + a dropdown of
  `settings.connectorTypes` (i.e. `connector`/`stream`, the `connectorType` field: `c`
  vs `s`) in the View properties panel. When enabled, only connectors whose
  `connectorType` matches are drawn. (This is my interpretation of "filter by connector
  type" — there's also a `relationship` field with 17 values like Association/
  Realization/etc.; if you actually meant filtering by *that*, let me know and I'll widen
  the dropdown to those instead.)
- **Show Keys**: now shows both `viewMember.id` and `viewMember.objectId` (was just the
  Part id, mislabeled) — for nodes as `vm:… obj:…` under the label, and now also for
  connectors, as a small text label at the edge's midpoint. Verified both render
  correctly with the real ids from the sample data.
- **Advanced/Catalogs dropdown cut off at the left** — root cause: `.dropdown-menu` was
  universally `right: 0`-anchored, which works for the restore-closed-tabs menu (near the
  right edge) but pushes a wide menu off-screen to the left when the button itself is
  near the left edge, as Advanced/Catalogs are. Fixed with a `left: 0` override scoped to
  `.menu-item-wrap .dropdown-menu`. Verified the menu's bounding rect now starts at a
  positive `left` coordinate.

## Step 6 changes (sections/grid layout, right-click menu, view-type picker)

- **A real bug I introduced then caught**: an earlier edit accidentally deleted the
  `function buildMarkerDefs(store) {` declaration line while keeping its body, leaving
  orphaned code at module top-level — a `return` statement outside any function. This
  is a hard error in ES modules but Node's plain `node --check file.js` didn't catch it
  (it validates bare `.js` files as CommonJS by default, where a top-level `return` is
  legal inside the implicit module wrapper). Caught it by re-checking with
  `node --input-type=module --check`, which matches what the browser actually does for
  `<script type="module">`. Worth remembering for future sessions on this project.
- **Sections / grid-based view layout** (new `js/sections.js` module): non-`ff` viewTypes
  (`sec`, `org`, `org4lob`) now render their sections as stacked, labeled grid regions on
  the canvas, using the existing 170×90 spacing. Each view gets its **own** copy of the
  matching `settings.sections`, seeded once (`Store.ensureViewSections`) and never
  written back to the shared settings — confirmed live that inserting/removing sections
  only affects that one view.
  - Dropping a node from the toolbox, or dragging one to a new spot, snaps it to the
    nearest row/column of the section it lands in, and enforces `elementTypes`
    (`['*']` = any, `[]` = none, else a whitelist) — a disallowed placement is rejected
    with a toast (drop) or reverted (drag). Verified precisely: a `BusinessFunction`
    dropped into the "Enterprise Scope Functions" section snapped to `(70, 234)` with
    `sectionId: 'esf'`; a `Tester` dropped in the same spot was correctly rejected.
  - Clicking a section's header opens a dedicated Properties-panel view (name/rows/
    columns editable, id/order/viewType/elementTypes readonly) with **Add Section**
    (inserts directly after, renumbering order) and **Remove Section** (deletes the
    section and any viewMembers placed in it, never the underlying Parts) buttons.
    Verified both live: insert correctly renumbers all subsequent sections' `order`;
    remove correctly dropped exactly the viewMembers that had been placed in it.
  - Level Down's new view uses this same section-aware setup (via `ensureViewSections`
    + the shared `applyRemapLayout`), consistent with freeform views.
- **Right-click context menu**: reuses the exact same command set/icons/enabled-state
  logic as the left Commands panel (refactored into a shared `getCommandDefs`), on both
  empty canvas and directly on a node (which selects it first, matching prior behavior).
  **Generate** and **Paste** anchor at the click position instead of a fixed spot when
  invoked this way — verified precisely: right-clicking at canvas x=500 and generating
  produced a chain starting at exactly `x:500`; right-clicking at `(800,700)` and pasting
  placed the node at exactly `(800,700)`.
- **"Add Page" removed**; **"Add View" gained a View Type picker** sourced from
  `settings.viewTypes`, defaulting to `ff`. New views default their `viewType` to `'ff'`
  everywhere (bootstrap, `addView`, and migration of older save files).
- **Show Keys**: `objectId` now sits on its own line below `vmId`, for both nodes and
  connectors.
- **Selection list** (left panel) now includes selected connectors, not just nodes,
  shown as `relationship: FromLabel → ToLabel`.
- **Generate**: when a template's element type can't be resolved and falls back to
  `Unknown`, the original requested type is now appended to both the Part's and the
  viewMember's `note` (e.g. `g4 (unknown type: thingamajack)`).

## Bug fix: Generate/nodes stacking at top, spanning full width

Reported and confirmed: **Generate** (and by extension anything using the same chain-
building code) never checked whether the target view was section-based — it always used
the old flat `baseX + i×stepX, baseY` layout, so every generated node landed at the same
`y` with `x` spread across the entire chain width, completely ignoring any section grid
drawn underneath. On a large template (e.g. "Enterprise", 18+ nodes) this produced
exactly the reported symptom: everything stacked near the top, spanning nearly 3000px of
width. Fixed with a new `createSectionPlacer(view)` in `sections.js` that Generate (and
its passive-node helper) now uses whenever the view is section-based: it fills each
matching section in order (respecting `elementTypes` and row/column capacity), moves to
the next matching section once one fills up, and falls back to a **bounded** overflow
grid (10 columns wide) below all sections for anything that doesn't fit any section's
type filter — rather than the old unbounded full-width spread. Verified against the real
`org` viewType + `Enterprise` template: nodes whose type is allowed in a section (e.g. a
`BusinessFunction`) land inside it correctly; everything else lands in the capped,
readable overflow area instead of sprawling across the whole canvas. Confirmed the `ff`
viewType's Generate output is byte-for-byte unchanged (still the classic flat chain).

**Correction also applied**: sections with `sectionId: 'title'` now reserve *only* their
header strip (no body/grid rows below), since they're meant purely as section labels.
Verified: a `title` section's box height is now exactly the header height (34px),
compared to a real section's height which includes its row grid.

## Bug fix (round 2): the real root cause was repeated Generate calls overlapping

The previous fix (section-awareness for Generate) was real and correct, but it wasn't
what you were actually hitting. Reproduced the actual issue by doing what a normal user
does — clicking the Generate command twice in a row via the real Commands panel button
(not an isolated single API call) — and confirmed every call landed at the exact same
fixed `(60, 60)` anchor, so successive streams stacked **completely on top of each
other**. That's what "stacking from top, using entire width" actually was: not one
call's layout, but every call resetting to the same spot.

Fixed in two parts:
- When Generate isn't right-click-anchored, it now defaults to stacking **below**
  whatever's already in the view (based on existing nodes' max Y + margin) instead of
  always resetting to `(60, 60)`.
- The section-based placer needed the same treatment, and while wiring that up I found a
  second, subtler bug in the *existing* passive-node code: it was calling the placer
  speculatively for both the `from` and `to` side of every passive pair, even when one of
  them already existed and its computed position was simply discarded. That silently
  burned grid-index slots, leaving gaps between "how many nodes actually got placed" and
  "how far the internal counter had advanced" — which broke the "seed the next call from
  the current count" approach and reintroduced occasional collisions specifically on
  section-based views. Fixed by only ever calling the placer at the point a node is
  actually about to be created.

Verified by calling Generate 3 times in a row through the real UI, on both a fresh `ff`
view and a fresh `org` (section-based) view, and checking every resulting node position
for duplicates: zero duplicates in either case, versus the original 2 duplicate positions
found under the section-view path before this fix.

## Bug fix (round 3): the actual cause — a missing CSS selector, not a layout-logic bug

Your report ("starting at 0,0, using entire width, height approx correct") pointed away
from layout math entirely, and that turned out to be right. Checked `getComputedStyle()`
on rendered nodes directly and found `position: static` and `width: 4000px` — i.e. the
**effective** CSS was completely different from what the stylesheet was supposed to say,
even though the inline `left`/`top` styles JS was setting were still correctly `260px`,
`190px`, etc. (`left`/`top` do nothing on a `position: static` element, which is exactly
why the properties panel — reading the same underlying data — looked "correct" while the
canvas didn't match it.)

Root cause: the same class of mistake as the earlier `buildMarkerDefs` incident, this
time in `css/styles.css` — an edit that inserted the new `.section-box`/`.section-header`/
`.section-body` rules had swallowed the `.fnode {` selector line itself, leaving its
properties (`position: absolute`, `min-width: 120px`, etc.) as an orphaned, selector-less
block that browsers silently discard. Without `position: absolute`, nodes fell back to
normal block-flow default — stacking vertically, each one 100% of its 4000px container's
width. Restored the missing selector and added a brace-balance + orphaned-property scan
of the whole stylesheet to confirm nothing else was affected.

Verified: `getComputedStyle()` now reports `position: absolute`, content-sized widths
(~130-160px instead of 4000px), and `left`/`top` matching the stored data exactly — on
both a loaded save file and a fresh section-based view. Also re-verified node dragging
and section rendering still work correctly after the fix.

**On the version number**: displayed correctly as `v0.5` in both this session's checks
and the prior one — I couldn't reproduce it failing to update, but if you're still
seeing a stale number, a hard refresh (the browser may have cached the old `version.js`)
should clear it up.

## Step 7 changes (single-node level-down, section toolkit filter, header reorg, double-click fix)

- **Version bumped to v0.7** as instructed. Confirmed rendering correctly in the header.
- **Double-click a node with no linked view**: now creates a blank new view and sets the
  node's `linkedViewName` to it, without altering the node's type — a lighter-weight
  cousin of the multi-select Level Down (which does convert its origin into an `Unknown`
  placeholder; that's not appropriate for a single node whose identity should stay
  intact). Verified with a **real** double-click gesture (`page.mouse.dblclick`), not a
  direct function call.
- **A real bug found and fixed while verifying that**: double-click wasn't firing at all
  through real mouse events, even though calling the underlying function directly worked
  perfectly — isolating it that way is what proved the bug was in event wiring, not
  logic. Root cause: the node's `pointerdown`/drag-end handlers were calling
  `app.render()` **unconditionally on every click**, even ones that changed nothing (like
  clicking an already-selected node). Since `app.render()` fully rebuilds the canvas DOM,
  every click — including both halves of a double-click — was destroying and recreating
  the node element mid-gesture, which breaks the browser's double-click detection. Fixed
  by only re-rendering when the click actually changed the selection or a drag actually
  moved something; verified the fix with a real double-click and a full click/select/
  drag/deselect/undo regression pass afterward (all clean).
- **Section toolkit filter**: the toolbox now shows only element types allowed by *any*
  of the current view's sections (union across sections; unrestricted for `ff` views or
  if any section allows `'*'`).
- **Drag/drop section-targeting fix**: the toolbox-drop handler was applying a
  cursor-centering offset *before* determining which section the drop landed in, which
  could misattribute drops near a section boundary. Now the raw cursor position
  determines the target section; the centering offset only applies for the non-section
  ('ff') fallback case.
- **Header reorg**: toolbar row order is now Stream filter (leftmost) → Undo/Redo →
  spacer → "Current View" (was "View") → "Default Model" (was "Model"), right-justified.
- **Version tooltip**: 3-line tooltip with the requested contact info.
- **Page title**: "FlowRun - Workflow modeling and simulation".
- **Mouse position indicator**: added below the Commands panel, showing live canvas
  (model-space) coordinates while hovering the canvas, clearing on mouse-leave.

## Step 8 changes (data-driven property panels, connector defaults, Merge command)

Step 8 arrived in two passes — the first `custom.json` used a single `show` code meaning
both widget type and editability at once, which produced several real conflicts (e.g.
view checkboxes coded `w`, `Model` coded `w` instead of a selector, `addSection`/
`removeSection` coded `b` for "boolean" despite being buttons). The corrected file split
this into two independent axes — `show` (widget type: `y` checkbox / `n` numeric / `c`
color / `t` text / `m` multiline / `s` selector / `b` button / `h` hidden) and `access`
(`r` readonly / `w` editable) — which resolves all of those cleanly. Rebuilt against the
corrected schema:

- **Property panels are now genuinely data-driven**: field presence, order, label,
  widget type, and editability all come from `settings.showFields` at render time, for
  `viewMember` (the node/canvas panel — distinct from `part`, which the data documents as
  "not implemented yet"), `connector`, `section`, and `view`. Verified live: the node
  panel's field order and labels match the spec exactly, `Type` and `Model` both render
  as real `<select>` elements, and editing the View's `id` field (or `viewName` — both
  alias to the same rename) correctly cascades through `currentView`, the tab title, and
  every affected viewMember's `.view` field.
- **Connector creation no longer shows a picker.** It uses the user's remembered choice
  for that (fromType, toType) pair if one exists (stored in the previously-unused
  `settingsUser.relationshipPairs`), else the first allowed relationship type from the
  merged relationshipPairs. Picking a relationship via the properties panel remembers it
  as the new default for that pair going forward. Verified: setting a default then
  connecting the same type pair produces a connector with exactly that relationship.
- **Merge command**: select 2+ nodes, provide a new name and an optional "also merge
  related parts" checkbox. Rewires every connector referencing a merged-away part onto
  the surviving (first-selected) node, de-duplicates resulting parallel connectors,
  cancels the whole operation with an alert if "merge parts" would delete a Part that's
  still used in another view. Verified live.
- **Bug fixes**: closing a tab now correctly syncs the Current View selector to whichever
  tab focus lands on (previously only `switchToTab` did this, not the fallback path
  inside `closeTab`); double-click now tries the linked view, then a view matching the
  node's label, then falls back to creating a blank linked view; renaming a node's label
  now cascades to rename its linked view (and everything that references it).
- **Collapsible panels**: Elements/Selection/Commands/Properties can each collapse
  independently (chevron toggle, persisted, default expanded). Verified live.
- **Selection list grows with content** (up to 100 rows' worth of height, then scrolls)
  instead of a fixed 220px cap. Verified live with a 21-item selection.
- **Menu order**: Catalogs now before Advanced.
- **"Sync connector updates across parent/child views"**: this is a request I did *not*
  need to write new code for. In this data model, the same underlying `Connector` record
  can already be displayed via multiple viewMembers across different views (this is how
  Level Down's crossing-edge recreation already works), and every panel always reads the
  live `Connector` object directly — so editing a connector's relationship/note already
  applies everywhere it's displayed, by construction. Flagging this conclusion rather
  than guessing at a different, unbuilt scenario the instruction might have meant.

## Step 9 changes (uniform nodes, no-overlap placement, data-defined connector defaults,
## multi-select bulk editing, Remap sort order, Generate Stream rename)

- **Confirmed via diff** that the corrected `custom.json` only changed two things:
  `relationshipPairs[].default` (33 entries) and `view.viewType` flipped to readonly —
  the readonly change needed zero code changes thanks to the data-driven property panel
  built in Step 8, which is exactly the point of building it that way.
- **Connector creation priority** is now: the user's remembered choice for that type
  pair (Step 8) → `relationshipPairs.default` (new) → first allowed relation as ultimate
  fallback. The XML-merge fills in a `default` for pairs that only came from
  `relationships.xml` (no `custom.json` entry) using the first allowed relation letter,
  per the instruction. Stream/Passive connector creation (Generate, Duplicate Stream)
  is untouched, as specified.
- **Uniform node size**: nodes are now a fixed 130×46px (previously auto-width, so two
  nodes with different label lengths were literally different sizes) — this also fixes a
  latent bug where several parts of the code (edge clipping, lasso hit-testing, section
  grid math) *assumed* that exact size without the CSS ever actually enforcing it.
  Verified: 5 sampled nodes all measured exactly 130×46px.
- **No-overlap placement**: new `Store.findNonOverlappingPosition` (spiral search
  outward, freeform views) and `findFreeCellInSection` (forward cell-scan, section-based
  views), wired into toolbox drag-drop and Generate's passive-node fallback placement.
  Verified: three toolbox drops aimed at nearly the same spot produced zero overlapping
  positions.
- **External nodes**: thicker dark-gray border instead of dashed.
- **Remap now prompts for sort priority** before running — four dropdowns (Priority 1–4)
  defaulting to exactly Stream name → Stream order → Entity type → Node label, feeding a
  proper multi-key comparator (ties on the primary key fall through in order). Verified
  the modal's defaults match the spec exactly.
- **Version tooltip**: updated to the exact 4-line text requested.
- **Generate → "Generate Stream"**, and its modal now prompts for Function Name /
  Capability Name / Entity Name (defaulting to the old hardcoded values, fully editable)
  instead of hardcoding them. Verified the modal's field set live.
- **Multi-select common-attributes panel**: selecting 2+ nodes and/or connectors now
  shows a properties panel of the fields common to the selection (all-node →
  `viewMember` fields; all-connector → `connector` fields; mixed → the intersection of
  field names present in both, using the more restrictive access if they differ), with
  fields the selection disagrees on shown blank with a "(multiple values)" placeholder.
  Editing any field prompts "Apply … to all N selected items?" before committing to
  every item; cancelling leaves everything untouched. Verified all three paths live:
  disagreeing values render blank, confirming applies to every selected item, and
  cancelling leaves values exactly as they were.
- **Stream filter** now only lists streams present on parts/connectors that actually
  have a viewMember in the *current* view, not the whole model.

## Step 10 changes (Redraw command, per-view node sizing, multi-select stream filter,
## curved connectors, catalog sort/select, and two more real regressions found+fixed)

- **Connect handle disappeared — root cause found**: the `overflow: hidden` added to
  `.fnode` in Step 9 (to clip long labels) was also clipping the connect-handle circle
  and the order badge, both intentionally positioned *outside* the node's box. Removed
  it — the label already clips its own overflow via line-clamp, so nothing depended on
  the parent-level clip. Verified: the handle's computed opacity is `1` on hover.
- **Generate Stream's two bugs, one root cause**: reproduced live and found a genuine
  `ReferenceError: stepY is not defined` in the passive-node placement code added in
  Step 9 (a variable that only existed in an unrelated function's scope). This explains
  both reported symptoms at once — the passive-node loop threw and aborted mid-command
  (why passive nodes stopped appearing), and since the throw happened before
  `recordAndRender()` ran, the DOM never updated until some unrelated later click
  triggered a render elsewhere (why nodes seemed to need an extra click to show up).
  Fixed with one variable declaration. Verified: nodes now render immediately with zero
  extra clicks, and passive-node markers are back.
- **Redraw command**: measures every node's natural content size in the current view
  (actual label text, and whether `chkShowKeys`/`chkShowElementTypes` are on) via an
  offscreen DOM measurement, then sets the view's uniform node size to fit the largest
  one (clamped 100–260 × 40–140px). Node size moved from a single fixed constant to a
  **per-view** value (`view.nodeWidth`/`nodeHeight`), threaded through edge-clipping and
  lasso hit-testing so those stay accurate after a redraw. Verified: growing a label and
  running Redraw grows the actual rendered node size to match (130×46 → 260×62 in
  testing).
- **Remap now calls Redraw first**, and its row/column spacing derives from the
  freshly-computed node size instead of a fixed constant. Verified live.
- **Remap sort order is now remembered per-view**: the priority modal defaults to
  whatever order was last used on *that specific view*, falling back to the standard
  default (stream name → stream order → entity type → node label) if none has been set.
- **Stream filter is now multi-select** (a checkbox dropdown, not a native `<select>` —
  better UX for picking several at once), matching membership with OR logic (an item
  passes if it carries *any* of the checked streams). `tab.activeStream` (string) became
  `tab.activeStreams` (array) throughout.
- **Connectors of type `'c'` now render as curves** (quadratic bezier via a
  perpendicular-offset control point at the midpoint); type `'s'` (stream/passive)
  connectors stay straight, matching the instruction to leave stream generation's own
  connector rendering untouched. Verified: a manually-drawn connector's path now
  contains a `Q` curve command.
- **Catalog tables**: column headers are now clickable to sort (ascending/descending
  toggle, with a directional arrow indicator); clicking a row shows the *same*
  data-driven properties panel a canvas selection would ("calculated permissions" = the
  same `showFields` access rules apply regardless of where the entity was selected from).
  This is also where the `part` entity's properties panel — flagged as "not implemented
  yet" all the way back in Step 8 — finally got built, since it's specifically what a
  Parts-catalog row needs (a Part on its own, with no particular viewMember placement
  context, so visual-override fields like `fillColor` genuinely don't apply and are
  correctly omitted rather than fabricated). Verified live: sorting the Parts catalog by
  `type` produces alphabetical order, and clicking a row shows exactly the Part-entity
  field set (Type, Label, Model, Note, Order, Crossref ids, Streams).

## Step 11 changes (live relationship-style lookup + tooltips, connector-type
## visibility checkboxes, dropdown position fix)

- **Connector line drawing now looked up live**: color/width/dash/fill are resolved at
  draw time via `relationshipStyle.type === connector.relationship` (was previously
  relying on a copy cached on the connector at creation time, which could drift). Falls
  back to the connector's own stored values only if no matching style exists. Verified:
  a Stream connector's rendered stroke color (`#5c22e2`) matches its relationshipStyle
  entry exactly.
- **Connector tooltips added**: hovering the line shows `relationshipStyle.type`;
  hovering near each endpoint shows `ABRoleName` (from-end) or `BARoleName` (to-end) via
  small invisible hoverable dots at each clipped endpoint, since a single SVG element's
  tooltip can't differ by which end you're near. Verified live — the line's tooltip
  reads "Stream", and the two endpoint tooltips read "utilizes" / "utilized by".
- **View properties: connector visibility split into two independent checkboxes**
  ("Connectors" / "Streams", matching `connectorType` `'c'`/`'s'`) — replacing the old
  single "Connectors" toggle plus the "Filter by connector type" toggle and its type
  selector. Verified both filter independently: disabling "Streams" hid all 20 sample
  connectors (all type `'s'`); disabling "Connectors" (with one manually-drawn type `'c'`
  connector added) hid exactly that one. **No new `custom.json` was provided this step**,
  so I edited `showFields.view.fields` myself to remove the three old field entries and
  add the two new ones — flagging this since it's the first time I've modified the data
  file rather than received an update; happy to have you take over that file again going
  forward if you'd rather keep authoring it directly.
- **Stream filter dropdown cutoff — same bug class as the earlier Advanced/Catalogs
  fix**: it wasn't covered by that fix's CSS selector (which only targeted the top menu
  bar's dropdowns), so being the leftmost toolbar item it was still overflowing off the
  left edge. Added the same `left: 0` override for it specifically. Verified: the menu's
  bounding rect now starts at `x: 10` (on-screen), not a negative/off-screen value.

## Step 12 changes (description field, auto-redraw on content-changing toggles,
## dual connector creation, editable-field styling, connector streams field)

- **A real data bug found and fixed first**: the uploaded `custom.json` had a genuine
  JSON syntax error (a missing comma right before `chkShowKeys` in
  `showFields.view.fields`), which would have broken the whole app if loaded as-is.
  Traced it to the exact line, applied the one-character fix, and confirmed the
  corrected file parses and diffs cleanly against the previous version — revealing
  exactly the 4 intended changes (`chkShowDescription` on `view`; `streams` made visible
  on `connector`; `description` added to both `part` and `viewMember`).
- **`description` field**: added to the Part schema (shared by the `part` and
  `viewMember` panels, matching how `label`/`note` already work), rendered on canvas
  nodes clamped to 2 lines when the view's new `chkShowDescription` toggle is on.
  Verified live: a long description renders with `webkit-line-clamp: 2`.
- **Content-changing view toggles now auto-redraw and de-overlap**: toggling Show Keys,
  Show Types, or Show Description now automatically recalculates the view's node size
  (reusing the Redraw logic) and nudges apart any nodes that now overlap as a result —
  a lighter-weight pass than a full Remap, so existing positions are preserved except
  where a genuine new overlap needs resolving. Verified live: toggling Show Keys grew
  node size from 130×46 to 260×95 automatically.
- **Dual connector creation**: every stream-type (`'s'`) connector created by Generate
  Stream (both the main chain and passive-node connections) now also creates a
  companion `'c'`-type connector between the same parts, using
  `relationshipPairs.default` (mapped to its `relations.name`) rather than a hardcoded
  relationship — falling back to Association if no pair rule matches. The companion
  carries the same stream tag, so Duplicate Stream naturally picks up both without any
  special-casing there. Verified live: Generate Stream created 7 new stream connectors
  and exactly 7 new companion connectors, with real data-driven relationship names.
- **Connector tooltip now also shows shared streams**: streams common to the connector
  *and* both its endpoint parts are appended to the line's tooltip. Verified live with a
  freshly generated (properly cross-tagged) connector.
- **Editable vs. readonly field styling**: editable fields now render with a white
  background, readonly fields keep the muted panel background — verified
  `rgb(255,255,255)` vs `rgb(245,246,248)` respectively.
- **A gap I found and fixed myself while verifying**: I'd added `streams` to
  `showFields.connector` in the data file but forgot the matching code accessor, so the
  field silently didn't appear. Caught this by checking the panel's actual rendered
  field list rather than assuming the data change alone was sufficient — a reminder that
  the data-driven panel system still requires an accessor on the code side for every
  field the data exposes.

## Step 13 changes (description-panel bug fix, tooltip fix, GenerateInventoryView,
## per-view node spacing control)

- **Description field bug fix**: same class of bug caught before — a data field
  (`description`) had been added to `showFields` without a matching code accessor, this
  time in the `viewMember` node panel (and proactively fixed in the `part`-only catalog
  panel too). Verified live: Description now appears in the node panel's field list.
- **Tooltip fix**: the shared-stream info added to connector tooltips in Step 12 now
  only appears for `connectorType === 's'` (stream) connectors, not regular ones.
  Verified: a manually-drawn connector's tooltip shows just its relationship name.
- **GenerateInventoryView**: new item under the Advanced menu. Creates a view named
  `inventory-<defaultModel>` (deduplicated with a numeric suffix if it already exists),
  populates it with every Part in that model plus every Connector whose both endpoints
  are in it, and lays it out using the same logic as Remap with default sort order (no
  prompt). Verified live: generated a 42-viewMember inventory view correctly.
- **Per-view node spacing control** (`view.spacingScale`, default 1.0): a +/− stepper
  next to the zoom control (±15%/click) plus an exact numeric field in the View
  properties panel, both writing the same value.
  - **Freeform views**: changing the value bakes a one-time position transform, scaling
    every node's position relative to the view's content centroid by the ratio between
    old and new scale — not a live effect, so drag/undo/Remap all just work with the
    already-transformed positions afterward. Verified live: one +15% click correctly
    scaled three sample nodes' positions outward from the computed centroid.
  - **Section-based views**: the grid's cell size (`CELL_W`/`CELL_H`) now derives live
    from each view's `spacingScale` inside `computeSectionLayout`, so all section-grid
    math (layout, `gridToPixel`, `pixelToNearestGrid`, the section placer's overflow
    area) automatically stays consistent.
  - **A real gap I found and fixed during my own verification**: scaling a section's
    cell size alone doesn't move *existing* nodes' already-stored pixel positions — only
    a node sitting in column 0 happens to stay correctly aligned; anything in column 1+
    would visually drift out of its cell as the grid grew or shrank around it. Added
    `rescaleSectionPositions`, which re-derives each existing node's row/col using the
    *old* scale and its new pixel position using the *new* scale, called right after
    every spacing change on a section-based view. Verified live with 3 nodes across
    different columns — after a spacing change, every node's position landed on an
    exact valid grid cell for the new (scaled) layout, not just the column-0 one.
  - Threaded `spacingScale` through Remap's `stepX`/`stepY` and the no-overlap
    placement search margin, so Generate/Remap/drag-drop stay consistent with whatever
    density a view's user has chosen instead of resetting to the default spacing.
  - Kept deliberately separate from Redraw, per the original design note: Redraw answers
    "how big does each node need to be for its content," spacing answers "how much
    space is between them."

## Step 14 changes (Level Down connector-loss bug, connector relationship filtering,
## view defaults, Remap connectivity-based ordering)

- **A real bug found and fixed**: Level Down's old-view "de-duplicate parallel edges"
  step keyed only on (neighbor, direction) — so when a stream connector's Step-12-added
  dual `'c'` companion crossed the same selection boundary as its `'s'` sibling (same
  neighbor, same direction, but a genuinely different connector), the dedup logic
  treated them as duplicates of each other and deleted one. Fixed by including the
  connector's type+relationship in the dedup key, so only truly-redundant same-type
  parallel edges get merged. Verified live: a stream with dual connectors now survives
  Level Down with balanced `'s'`/`'c'` counts in the original view (6/6), instead of
  losing the `'c'` side.
- **Connector relationship dropdown now filtered** to only the relations
  `relationshipPairs` allows for that connector's actual (fromType, toType) — previously
  showed all 17 relations regardless of type pair. Threaded an optional `ctx` parameter
  through the generic panel renderer for this (the first field to need context beyond
  its own current value). Keeps an existing-but-now-invalid choice in the list rather
  than silently dropping it. Verified live against a real multi-relation type pair — the
  dropdown's options matched `relationshipPairs.relations` exactly.
- **Generate Stream modal** now defaults to the "Enterprise" template instead of "Test".
- **New-view defaults changed**: `chkShowStreamType` now starts **off** (Generate Stream
  automatically turns it on when run, so newly-created stream connectors aren't
  invisible by surprise); `chkShowDescription` now starts **on**. Verified both live.
- **Remap: connectivity-based ordering within streams.** New `connectionOrder` sort key
  (5th option, freeform views only), computed per-stream via BFS from that stream's
  passive-from part (or its lowest-id part as a deterministic fallback when no
  passive-from exists), following only that stream's own connectors. Parts a stream's
  connectors don't reach are left out of the map so they tie and fall through to the
  next sort key rather than erroring. New default priority order is stream name →
  connection order → entity type → node label (stream order remains selectable, just no
  longer defaulted). Verified live with a plain 4-node chain (BFS correctly traversed
  the whole connected graph in valid breadth-first order) — a second test using a
  Passive-relationship connector produced a result that looked wrong at first glance,
  but turned out to be fully explained by Remap's *pre-existing*, unrelated
  passive-from/passive-to top-row/last-column placement rule pulling those nodes out of
  the sort bucket before the new key ever applied — not a bug in the new code.
- **Remap on section-based views now skips the sort-priority modal entirely** rather
  than showing a picker whose choices don't apply there (section-based views place
  nodes via the grid/section-placer logic, which has no sort-key concept). Verified
  live: invoking Remap on a section-based view runs immediately with no modal shown.

## Step 15 changes (spacing increments, connector filtering gap, Generate Stream
## xId-based reuse, Generate Industry)

- **Spacing stepper** changed from multiplicative (~±15%) to additive `±0.2` per click.
  Verified: 1.0 → 1.2 → 1.4 exactly.
- **Connector relationship filtering — a real gap found and fixed**: Step 14 correctly
  filtered the relationship dropdown by `relationshipPairs` for the single-connector and
  catalog-row panels, but the **multi-select** panel never received the from/to type
  context, so selecting 2+ connectors still showed all 17 relations unfiltered. Fixed by
  computing a shared type-pair context only when every selected connector shares the
  same (fromType, toType) — otherwise falls back to the full list, since there's no
  single valid set to filter against.
- **Generate Stream: new optional parameters** (`functionDescription`, `functionxIds`,
  `capabilityDescription`, `capabilityxIds`, `entityDescription`, `entityxIds`) with
  find-or-reuse-by-xId logic, fully backward compatible (inert when no xId is passed —
  the existing manual Generate Stream modal is unaffected).
  - **A real bug caught mid-implementation**: the first version only wired this into the
    main chain loop. Testing against the actual `Enterprise` template revealed its
    `capabilityNameBegin` sits at chain index 0 — meaning `'BusinessFunction'` never
    appears in the main chain at all, only in the *passive* list. Extended the same
    find-or-reuse logic into `createPassiveNode` to cover it.
  - **A second, more serious bug caught by testing the full pipeline, not just the
    fix**: the category-range check (`i >= capBeginIdx`) was applying `capabilityxIds`/
    `entityxIds` to *every* chain position within that broad range — 13 different
    element types for "capability," 5 for "entity" — not just the one position that's
    actually typed `BusinessCapability`/`DataDataEntity`. That collapsed an 18-position
    chain down to 8 real nodes on a single stream, since the 13-wide "capability" range
    kept re-finding and reusing whichever node had already claimed that xId. Fixed by
    only applying xId-based reuse to the position whose *resolved type* is the precise
    semantic match for its category, leaving every other supporting position in that
    range to keep being created fresh per-stream, as before. Verified: a full Enterprise
    chain now correctly produces 21 distinct nodes with exactly 3 xId-tagged (one each
    of BusinessFunction/BusinessCapability/DataDataEntity), and two streams sharing a
    function+capability xId correctly converge onto the same two shared nodes.
- **Generate Industry**: new Advanced-menu command, prompts for an industry (derived
  from each source filename's segment after the first `-` and before `nodes` — verified
  `fce-generalnodes.json` → `general`), then walks the function → capability → entity
  tree and calls Generate Stream (Enterprise template) once per entity, passing each
  level's name/description/xId up the chain so repeated functions/capabilities/entities
  across different streams converge onto shared nodes instead of duplicating. Batched
  with a new `silent` option on `createStream` (skips the per-call render/toast) so 36
  sequential calls don't trigger 36 redundant re-renders. Verified against the full
  "general" industry data (9 functions, 18 capabilities, 36 entity *entries*): resulting
  counts came out to exactly 9 distinct BusinessFunction and 18 distinct
  BusinessCapability nodes, and 27 (not 36) distinct DataDataEntity nodes — confirmed by
  inspecting the source data directly that this is *correct*, not a bug: 6 entities
  (e.g. "Customer Profile", "Sales Order") are intentionally referenced from multiple
  capabilities in the source data with the same `nodeId`, and the reuse logic correctly
  converged them onto shared nodes rather than creating 36 separate copies.

## Post-Step-15 fixes (edges clipped beyond a fixed boundary; spacing math using stale
## hardcoded node-size assumptions instead of the view's actual current size)

Reported: connector lines not showing above roughly y=3000/x=1090, and nodes not
leaving space around themselves (overlapping). Investigated with real data rather than
guessing at either:

- **Edges clipped beyond y=3000**: the canvas surface and its edge `<svg>` were both
  hardcoded to a fixed 4000×3000px "world," a leftover assumption from early in the
  build when views held far less content. Generate Industry alone can now produce
  layouts over 11,000px tall (36 sequential streams stacking below each other) — any
  edge connecting a node below the SVG's own declared height was silently clipped by
  the SVG's default overflow behavior, even though the node itself scrolled into view
  fine. Verified with the actual number: `maxNodeY: 11060` after a real Generate
  Industry run. Fixed by computing the surface/SVG size dynamically from actual content
  extent each render (`max(4000, contentMaxX/Y + 500)`), keeping the same 4000×3000
  minimum for ordinary small views. Verified: the surface now grows to match (11606px
  tall for that same dataset), and edges connecting nodes past the old clipping line
  now render (confirmed 2880 total edge paths, including ones between nodes at y=3084
  and y=2904).
- **Node overlap — a real, if narrower, cause found**: two call sites for the
  no-overlap placement search (`Store.findNonOverlappingPosition`) — the toolbox
  drag-drop handler and Generate Stream's passive-node fallback placement — were
  passing no node-size arguments at all, silently falling back to the function's
  original hardcoded default (130×46) instead of the *view's actual current*
  `nodeWidth`/`nodeHeight`. If a view's node size had grown past that default (via
  Redraw, or the auto-redraw-on-content-toggle behavior from Step 12), the overlap
  search kept assuming the old, smaller footprint — meaning it could clear a spot that
  was actually too small for the real node size. Separately, Generate Stream's own
  main-chain step spacing (and its "stack below existing content" default anchor) used
  the same hardcoded 170×90 base regardless of the view's real node size. Fixed all
  three to read the view's current size via `getNodeSize()`. Verified precisely: I
  initially miscounted "13 overlaps" after simulating a grown view, but on inspection
  those were *pre-existing* nodes whose stored positions predated the size change, not
  anything the fix caused or missed — isolating to only newly-generated content on a
  fresh view (same grown 260×140 size) showed exactly 0 overlaps among 21 nodes.

## Step 16 changes (Add Existing command, duplicate-connector prevention)

Both features were already present in the codebase when I reviewed this instruction
file — from earlier work in this session I didn't have full visibility into at review
time. Rather than assume that meant they were correct, I read through both
implementations in full against the actual spec and verified them live before treating
Step 16 as done:

- **Add Existing command**: new Commands-panel button. Modal lists every Part not
  already placed in the current view (label, type via element lookup, model, streams),
  with independent Type/Model/Stream filter dropdowns, click-to-sort columns, row
  checkboxes, and an "include connectors" toggle. Verified live: filtering by a stream
  correctly narrowed the list to exactly the matching part, and adding it placed a new
  node in the current view. On submit, selected parts get new ViewMembers via the same
  no-overlap / section-aware placement used elsewhere; when "include connectors" is
  checked, existing `connectorType: 'c'` connectors whose both endpoints are now in the
  view (already-present or newly-added) get added too — scoped to the connector's model
  matching the current Default Model (a judgment call on "matching model," since the
  instruction didn't specify matching against what).
- **Duplicate-connector prevention**: creating a connector (drag-to-connect) now checks
  for an existing connector with the same (from, to, model, connectorType) tuple before
  creating anything. If one exists and already has a ViewMember in the current view,
  nothing happens (it's already visible). If it exists but isn't in this view yet, a
  confirm modal offers to add the *existing* connector here instead of creating a
  duplicate; declining creates nothing. Verified both live: reconnecting the same pair
  in the same view is a no-op after declining (connector count unchanged); reconnecting
  the same underlying parts from a *different* view and confirming correctly added a
  new ViewMember for the existing Connector record without ever creating a second
  Connector — total connector count stayed identical before and after.

## Step 17 changes (icon fix, select-all in Add Existing, Remap pattern redesign)

- **Fixed the missing "Add Existing" icon**: `getCommandDefs` had the command entry but
  `CMD_ICONS` never got a matching glyph, so the button rendered the literal text
  `"undefined"`. Added an icon and verified the button's HTML no longer contains that
  string.
- **Add Existing: select/deselect all matching current filters** — a checkbox in the
  table header, synced to reflect whether every currently-filtered row is selected
  (checked/unchecked/indeterminate). Verified live: filtering to a stream then toggling
  select-all correctly selected exactly the filtered rows, and toggling again cleared
  exactly those.
- **Remap redesigned for freeform views**: the modal now also offers a Stream Template
  selector (defaults to Enterprise, overriding the previous auto-detection-only
  behavior), a Pattern selector (`default`/`none`, with the data noting more patterns
  are coming later), and a "Limit columns to view" checkbox (default unchecked).
  - **Column estimation now factors in zoom**: the same CSS pixel width shows more or
    fewer model-space columns depending on zoom level, so `estimateMaxCols` now divides
    by the current zoom before computing how many columns fit.
  - **Unlimited columns by default**: when "Limit columns to view" is unchecked, row
    wrapping is driven purely by stream-group boundaries, not viewport width. Verified:
    with the checkbox off, all of a single stream's chain landed on one continuous row;
    with it checked, the same content wrapped into multiple rows bounded by the
    estimated column count.
  - **`default` pattern** implements the specified algorithm precisely: nodes grouped by
    stream name (a new row starts on every stream-name change), ordered within a group
    by `streamTemplate.value` position with unresolved types falling after resolved
    ones, main content beginning at the second calculated row (row 0 reserved), and
    passive nodes placed one row above their own group's first row, appended after
    whatever else already occupies that row. Verified precisely with two distinct
    streams: the first stream's passive nodes correctly landed on the reserved row 0;
    the second stream's own main content correctly got a fresh row (via the group-change
    increment); and — matching the literal algorithm exactly, not a bug — the second
    stream's passive nodes landed appended onto the *first* stream's row, since "the row
    above" a later group's first row is often the previous group's own row. This looked
    surprising on first read of the raw output, so I traced through it by hand against
    the exact instruction before concluding it was correct rather than assuming either
    way.
  - **`none` pattern**: a simple flat placement in sorted order, wrapping only at the
    column limit (or one continuous row when unlimited) — no stream-boundary row breaks.
  - `applyRemapLayout` and `remap`'s signatures changed from a bare `sortKeys` array to
    an options object (`{ sortKeys, templateName, pattern, limitColumnsToView }`); all
    existing callers (Level Down, GenerateInventoryView, the section-view Remap
    shortcut) pass no options and get identical behavior to before, verified live.

## Step 18 changes (menu label, element.group row-wrap fix, group sort key,
## reorderable priority list)

- **Advanced menu label**: "GenerateInventoryView" → "Generate Inventory View".
- **`default` pattern row-wrap fix**: within a stream group, a change in the node's
  `element.group` now also starts a new row (in addition to the existing stream-name
  and column-limit triggers). Verified live: after Remap, every main-content row
  contained nodes from exactly one element group (General/Business/Application/
  Technology/Data each getting their own row), except the reserved passive row, which
  legitimately mixes groups since passive placement is a separate pass.
- **New `elementGroup` sort key**, sourced from the same element-group lookup used for
  the row-wrap fix above.
- **Remap priority UI replaced**: the four independent dropdowns (which could select
  the same key twice, and were awkward to reorder) are now a single reorderable list of
  all 6 available sort keys with up/down arrows — duplicates are impossible by
  construction since each key appears exactly once. Verified live: the default order
  matches the previous behavior, moving an item up/down swaps it correctly, and the
  chosen order persists and reloads correctly the next time Remap is opened on that
  view. `view.remapSortKeys` now stores the full reordered list (previously
  hardcoded to expect exactly 4 entries).

## Step 19 changes (refined passive placement, Remap reset button)

- **`default` pattern: only genuinely "extra" passive elements get special row-above
  placement.** Previously *every* passive element (both sides of any Passive-relationship
  connector) was pulled out of normal placement — but for the Enterprise template, the
  `to` side of each passive pair (BusinessProcess/ApplicationProcess/TechnologyProcess)
  is *also* a real position in `streamTemplate.value`, so it was being artificially
  yanked away from where it naturally belongs. Now only passive elements whose type is
  **not** present in `streamTemplate.value` (the Function side: BusinessFunction/
  ApplicationFunction/TechnologyFunction) get special placement; the rest are treated as
  ordinary chain content, subject to the normal sort/row-break logic including the
  element.group row-break from Step 18.
  - The still-special elements are placed one row above the row where their **own**
    element.group appears within their own stream's block (tracked per
    stream+group, not just per-stream), appended after whatever else already occupies
    that row — falling back to one row above the stream's own first row if that
    specific group never appears in the stream at all.
  - **Verified precisely** with the exact scenario a user had asked about: after this
    fix, `BusinessProcess` now correctly sits in the same row as the other Business-group
    elements (previously pulled to an isolated row); `BusinessFunction` (still special)
    lands one row above that Business row, sharing it with the General-group content via
    first-unused-column; and — directly resolving the original question — `GeneralActor`
    is now genuinely the top-left-most node after Generate Stream + Remap with all
    defaults, since nothing displaces it into a separately-reserved row anymore.
- **Remap modal: Reset button**, restoring the app's built-in defaults (Stream Template
  → Enterprise, Pattern → default, Limit columns → unchecked, priority order → the
  default list) — distinct from just reopening the modal, which would otherwise show
  the view's last-*remembered* order rather than the true defaults. Verified live.

## Step 21 changes (Add Existing: include all connector types)

- **Add Existing Parts' "Include connectors" now includes all associated connectors**,
  not just `connectorType: 'c'` ones — a correction to the Step 16 implementation, which
  had scoped this to regular connectors only. Verified live both ways: a stream-type
  (`'s'`) connector between two added parts is now correctly included, and a regular
  (`'c'`) connector continues to work as before.

## Post-Step-21 fix: multi-stream nodes sorted using the wrong stream

Reported: after Generate Industry, filtering a new view to one specific stream via Add
Existing, and running Remap, a node shared across multiple streams (e.g. a capability
reused by both a "Production Schedule" stream and a "Bill of Materials" stream) got
isolated onto its own row at the very end, instead of sitting with its correctly-ordered
peers.

**Root cause, confirmed with the user's exact reproduction**: `streamName` (and,
separately, `connectionOrder`'s per-stream BFS grouping) both used `part.streams[0]` as
"the" stream a node belongs to — but a node reused across multiple streams (via the
xIds find-or-create logic) carries multiple stream tags in *creation order*, and
`streams[0]` is simply whichever stream happened to create it first. In a view built by
filtering to one specific *different* stream (via Add Existing), that first-created tag
can be entirely irrelevant to the view actually being laid out. Verified precisely: the
reported node had `streams: ['Production Schedule', 'Bill of Materials']`; the view was
filtered to "Bill of Materials," but `streams[0]` = `'Production Schedule'` — a stream
tag shared by no other node in that view — so it sorted into a group of one, landing
dead last.

**Fix**: added `resolveViewRelevantStreams`, which computes each part's *view-relevant*
stream as whichever of its own stream tags is most popular among the other parts
actually present in the current view — not simply the first one chronologically.
Threaded through everywhere `streams[0]` was previously used as a stand-in for "the"
stream: the `streamName` sort key, `connectionOrder`'s BFS grouping, and both the
main-content and passive-element row-assignment loops in the `default` pattern.

Verified by re-running the exact reported scenario: the shared node now correctly lands
in the same row as its properly-ordered peers instead of being isolated at the end, and
a regression check confirmed the ordinary single-stream case (where every node has
exactly one stream tag, so this fix is a no-op) is unaffected — `GeneralActor` still
lands top-left-most after a plain Generate Stream + Remap with defaults.

## Step 23 changes (Populate From Template — first real consumer of custom.json's
## `templates` data)

- **New "Populate From Template" command** in the Commands panel. Prompts for a
  template, filtered to those whose `viewTypes` includes the current view's type. For
  each template part: looks for an existing Part matching by (xIds, Default Model) — if
  found, reuses it (adding a ViewMember only if one doesn't already exist in this view);
  if not, creates a new Part + ViewMember. Then, for each template connector, creates a
  new `connectorType: 'c'` connector using `relationshipPairs.default` for that type
  pair — **not** the template's own `relationship` hint, per the instruction ("using
  default for that node pair").
  - **Section-based views**: a template part only qualifies for placement at all if its
    type is allowed by at least one of the view's actual current sections — the
    template's own `sectionId` field is deliberately ignored for placement purposes
    (it's the template's own namespace and can't be assumed to correspond to a
    different view's real sections — confirmed via the shipped test data, which
    includes a section id that doesn't match anything real). Placement instead goes
    through the same section-aware placer used everywhere else, so it always lands in a
    real section your view actually has. A connector is skipped if either endpoint's
    part was skipped this way.
  - **Freeform views**: skip the section-eligibility gate entirely, using ordinary
    no-overlap placement.
  - Verified live, precisely: a freeform test template's 4 parts and 2 connectors were
    created with data-defined relationships (Association/Realization), not the
    template's own "flow" hint; the "Enterprise Functions" template correctly populated
    29 BusinessFunction nodes into real, correctly-labeled sections of a fresh `org`
    view (not the template's own bogus section ids); pre-creating a part with a
    matching xIds+model and re-running the same template correctly reused it (28 new +
    1 reused = 29, not 29 new) and kept the reused part's own label rather than
    overwriting it; and a template with a mixed-type part list on a restrictive
    section-based view correctly skipped every type that view's sections don't allow,
    along with both connectors that referenced the skipped part.

## Post-Step-23 fix: template sectionId hints were being discarded even when valid

Reported: populating a fresh `org`-type view from the "Enterprise Functions" template
placed "Procurement" (template `sectionId: 'cof'`) into section `esf` instead of `cof`.

**Root cause**: Step 23's implementation discarded the template's `sectionId` field
entirely, reasoning (from one bogus example in the shipped test data) that a template's
own section ids couldn't be trusted to correspond to a target view's real sections.
That was too broad a conclusion — verified directly against the data: `'cof'` is a
genuinely valid section id for the `org` viewtype ("Centralized Operational Functions"),
and "Enterprise Functions" deliberately uses the same section-id vocabulary real `org`
sections use, since it was authored specifically for that viewtype (`viewTypes: ['ff',
'org']`). Discarding that hint threw away real, meaningful placement data.

**Fix**: template parts now honor their own `sectionId` hint whenever it validly names a
section the current view actually has *and* that section allows the part's type —
falling back to "the first section that allows this type," as before, only when the
hint is absent, doesn't match a real section here, or doesn't allow the type. Also
switched the underlying placement mechanism from the stateful `createSectionPlacer`
(whose internal cursor tracking doesn't mix safely with directly-targeted placement) to
direct, always-freshly-scanned `findFreeCellInSection` calls, so hinted and fallback
placements can't collide with each other's bookkeeping.

Verified by re-running the exact reported scenario: all 29 nodes from "Enterprise
Functions" now land in exactly the sections the template specifies, matching the source
data's own function→section mapping one-for-one. Re-verified the three scenarios tested
in Step 23 (freeform template with connectors, xId-based reuse — which now also
preserves the template's sectionId hint for the reused node's placement — and the
type-mismatch skip path) all still behave correctly after the refactor.

## Step 25 changes (data update, section-resize-on-Redraw fix)

- **`custom.json` updated**: removed "test rsf section, with connectors" (the template
  with an invalid sectionId, `'100002'`, used to uncover the Step-23 sectionId-hint bug
  fixed just before this step). Applied this as a targeted edit to the current file
  rather than replacing it wholesale — the uploaded file predated several of this
  build's own additions (e.g. `showFields.view.spacingScale` from Step 13), so a naive
  replace would have silently regressed them. Diffed first, confirmed the *only*
  meaningful difference was the one template removal, and applied just that.
- **Fix: section-based views weren't resizing their grid when node size changed.** A
  section's cell size (`CELL_W`/`CELL_H`) was a fixed constant, scaled only by
  `spacingScale` — with no relationship at all to the view's actual current
  `nodeWidth`/`nodeHeight`. Running Redraw (or Remap, which redraws first) on a
  section-based view could grow nodes well past their cells' size, or leave excess
  empty space if nodes shrank, and existing nodes' positions would drift out of
  alignment with the (unchanged) grid lines regardless.
  - Cell size now derives from the view's actual current node size (`(nodeWidth + 40) *
    spacingScale` / `(nodeHeight + 44) * spacingScale`) — the same margin convention
    freeform's own row/column spacing already uses, so the two stay visually
    consistent with each other.
  - `redrawNodeSizes` (used by both the Redraw command and Remap's "redraw first" step)
    now re-snaps every existing node in a section-based view to the newly-resized grid
    whenever node size actually changes, reusing the same position-transform machinery
    built for spacingScale changes in Step 13 (generalized to capture node-size changes
    too, not just spacing scale).
  - Verified precisely: after inflating some labels and running Redraw on a populated
    `org`-type view, the section box width grew from 3400px to 6000px, matching the new
    formula exactly `(260+40)×20 cols`; and every existing node's x-position landed on
    the *exact* new cell boundary (`70, 370, 670, 970, 1270` — computed and matched to
    the pixel, not just visually similar).

## Known simplifications (given scope)

- The connector editor exposes relationship, line color, note, and end-marker size, but
  not the full `{connectorStyle, fillColor, endTypeStart, endTypeEnd}` shape described in
  the Connectors section — those map onto `relationshipStyles`, which already drive most
  of this automatically per relationship type.
- No automated test suite; this was built and reviewed by static analysis and cross-checks
  against `onestream.json`, not a live browser run (no network access in the build
  environment to fetch a headless browser).
