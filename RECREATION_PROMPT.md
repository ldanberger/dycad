# DyCAD — Recreation Prompt

This is a single, comprehensive prompt that summarizes an extended, multi-session
development history and could be handed to a capable AI coding assistant to rebuild
this project from nothing. It's written as an instruction to give, not as a narrative —
if you're regenerating the app, work through the phases in order; each depends on the
ones before it. If you're just trying to understand what was built and why, read it
straight through — the phase ordering doubles as the actual build history.

---

## 0. What this is

Build **DyCAD** (formerly named "FlowRun" — renamed partway through development; the
rename itself is documented as its own phase below), a single-page, browser-based
enterprise architecture modeling and simulation tool for EA/BA practitioners, built
around ArchiMate concepts (elements, relationships, views) with one deliberate addition
standard ArchiMate tooling doesn't have: **Streams**, a tagging and pattern-generation
layer for describing and regenerating whole business flows rather than hand-drawing
every box and line.

**Hard architectural constraints, non-negotiable:**
- Vanilla JavaScript, HTML, CSS. No frameworks, no npm packages, no build step, no
  bundler, no TypeScript.
- No backend. Everything runs client-side. Data loads from static JSON/XML files under
  `public/` via `fetch()`, and the person's own model data lives in memory and is
  saved/loaded as a JSON file they download/upload manually — there is no server, no
  database, no accounts.
- Must run from a plain static file server (`python3 -m http.server` or equivalent).
  `file://` won't work because `fetch()` calls to `public/*` are blocked by CORS on
  local files.
- ES modules throughout (`<script type="module">`), one file per concern (see module
  list in Phase 1).

**Audience**: enterprise architects and business analysts — assume real EA/TOGAF/
ArchiMate domain knowledge, not software engineering background, when writing anything
end-user-facing (the in-app Instructions page, toasts, labels).

---

## 1. Phase 1 — Data model and static configuration

Before writing any UI, establish the core data model and load it from a single
configuration file.

### The five core entities

- **Part** — a "thing" in the architecture (actor, capability, application component,
  data entity, etc.). Shared across every view that shows it — editing a Part's own
  fields (Label, Type, Description, ...) changes it everywhere it appears.
  Fields: `id, type, label, rawLabel, model, section, streams, note, order, other, xIds,
  description, script, scriptEnabled, createdAt, updatedAt`.
  (`rawLabel` is the label before any prefix/suffix decoration from the element
  definition is applied; `xIds` is a cross-reference id used for reuse/merge matching
  during generation and import; `other` is a free-form bag, e.g. `{src: originalType}`
  for elements that fell back to "Unknown"; `section` — added late, see Phase 11 — is
  set only at the Function level by industry generation, for a Section/Function/
  Capability/Entity hierarchy that has no other home in the base model.)

- **Connector** — a relationship between two Parts (Serves, Realizes, Triggers,
  Composition, ...). Also shared across views like a Part.
  Fields: `id, from, to, model, streams, note, connectorType, relationship,
  fromLineEndSettings, toLineEndSettings, stroke, strokeWidth, strokeNormal,
  strokeWidthNormal, dash, fill, createdAt, updatedAt`.
  `connectorType` is a two-value enum: `'c'` (user-drawn/regular) or `'s'`
  (stream-generated) — entirely distinct from relationship style codes; don't conflate
  them.

- **View** — a diagram. Doesn't contain Parts/Connectors directly; contains
  ViewMembers.
  Fields: `id, viewName, viewType, margin, spacingScale, chkShowConnectorType,
  chkShowStreamType, chkShowElementTypes, chkShowDescription, chkShowKeys,
  chkShowSimValues, chkShowScriptBadge, routingStyle, routingStyleStream`.
  `viewType` keys into a small config list (`ff` = free form, plus one or more
  section-based types — see Phase 6). `routingStyle` governs 'c'-type connector
  routing, `routingStyleStream` independently governs 's'-type — see Phase 5b.

- **ViewMember** — one Part or Connector's *placement on one specific view*: position,
  color, external flag. The same Part has a different ViewMember (and therefore a
  different position/color) on every view it appears on.
  Fields: `id, view, objectType ('part'|'connector'), objectId, x, y, fillColor,
  fontColor, fontSize, borderColor, order, note, linkedViewName, isExternal, sectionId,
  fromVmId, toVmId` (the last two only meaningful for connector-type members).

- **Model** — a namespace Parts/Connectors belong to (as-is vs to-be, different
  business units, whatever the person wants scoped independently). Simulation runs
  per-model.

Build the Store as a single class owning `doc.{models, parts, connectors, views,
viewMembers}`, `tabs`, undo/redo history, `settings` (loaded config), `industryData`
(see Phase 11), `messageLog`, `closedTabs`. Give it `createPart/createConnector/
createViewMember/createTab`, `findPart/findConnector/findView/findViewMember/
findTabByView`, `viewMembersForView(viewId)`, and a `migrateDoc(obj)` function that
defensively fills in every field with a sensible default (`??` chains) so old save
files never crash on load when new fields get added later — every single phase below
that adds a data model field needs a matching migration-default line.

### The configuration file (`public/custom.json`)

One JSON file drives almost the entire app's vocabulary — load it once at startup and
treat it as read-only runtime configuration (never generate an app feature that
requires editing this file to work; the file describes *what's possible*, the UI lets
people use it). Top-level keys:

- `elements` — the element type palette (~70+ entries): `{type, title, group,
  tkDisplayOrder, cornerRadius, sources, prefix, suffix, path}`. `path` is raw SVG path
  data for the type's icon glyph. `group` is one of a small fixed set (Application,
  Business, Data, Strategy&Motivation, Technology, ImplementationMigration, General,
  Unknown) used for default fill color and toolkit grouping. `sources` is a short code
  string (e.g. `"ta"`) marking which frameworks (TOGAF/ArchiMate/Other) this element
  belongs to, for toolkit filtering.
- `elementGroups` — `{group, fill}`, the default background color per group above.
- `relations` — `{key, name}`, the full relationship vocabulary (Access, Association,
  Composition, ...).
- `relationshipStyles` — `{type, code, stroke, strokeWidth, dash, fill, ABRoleName,
  BARoleName, fromLineEndSettingType, toLineEndSettingType}` — how each relationship
  type actually renders (line style + arrowhead pair), plus endpoint-hover tooltip role
  names.
- `relationshipPairs` — `{typeA, typeB, default, relations}` — for a given ordered pair
  of element types, which relationships are valid and which is the default; drives
  which options a person sees when drawing a new connector or changing an existing
  one's relationship, on both ends of the type pair (i.e. filtering must key off the
  *actual* from/to element types of the specific connector, not just show every
  relation unconditionally).
- `lineEnds` — named marker definitions (`{path, stroke, fill}` for arrowhead/diamond/
  etc. shapes), each in three sizes (small/medium/large — a `conn.endSize` field exists
  on the data model for this but nothing in the UI currently sets it away from the
  'medium' default; that's a known, accepted gap, not something to silently "fix" by
  inventing a UI for it unless asked).
- `viewTypes` — `{key, name}` list of selectable view types.
- `sections` — section *template* definitions used by section-based views:
  `{viewType, sectionId, order, name, rowCount, columnCount, elementTypes}`.
  `elementTypes: ["*"]` means any type; `elementTypes: []` means none (used for a
  title-only header row — see Phase 6's title-section pitfall).
- `templates` — "Populate From Template" page templates: `{name, viewTypes, parts:
  [{id, label, type, x, y, sectionId, xIds, note}], connectors: [...]}`. Note `x`/`y`
  hints on template parts are *not* honored by placement (a known, accepted gap — see
  Phase 6) — actual placement is row-major first-free-cell within the target section.
- `streamTemplates` — stream generation templates (see Phase 4): `{name, pattern,
  capabilityNameBegin, entityNameBegin, value: [elementType, ...], passive:
  [{from,to}, ...]}`.

Load this once at startup (`js/data.js`) alongside two other static files: a
relationships XML file (merged into `relationshipPairs`) and a default "general"
industry dataset JSON (`fce-generalnodes.json`, see Phase 11) — retry each fetch a few
times before giving up, since a cold static server can occasionally miss the very
first request.

---

## 2. Phase 2 — Canvas application shell

Build the interactive canvas: drag, connect, lasso-select, zoom, pan, multi-tab
interface, undo/redo, save/load.

- **Tabs**: `{id, type ('canvas'|'table'|'docs'|'pdf'), title, viewId, history:
  {past,present,future}, viewport: {x,y,zoom}, selection: Set, activeStreams,
  activeElementTypes, connectorLevels}`. `activeElementTypes: null` means "no filter
  configured, show everything" — deliberately distinct from an explicit empty array
  `[]`, which (after using the type filter's "exclude all") means "show nothing".
  `type='table'` tabs are generic: `tab.tableRows`/`tab.tableCols` (an array of plain
  objects and an array of column-key strings) drive a completely generic renderer, so
  any future tabular report reuses this instead of writing a new one — the SFCE Catalog
  page (Phase 11) is built entirely on this generic mechanism, no new renderer needed.
- **Undo/redo**: snapshot the *entire* `doc` (not per-view), since views share
  underlying Parts/Connectors — Ctrl+Z must be safe regardless of which tab is active.
- **Selection & multi-select**: lasso-select (marquee), shift-click add, drag multiple
  selected nodes together.
- **Property panels**: schema-driven from `custom.json`'s `showFields` block (a fifth
  top-level key, alongside `part/connector/viewMember/view/section`, listing
  `{fieldName: {show: <type-letter>, access: 'r'|'w', label}}` per entity). Build one
  generic `renderShowFieldsPanel(app, obj, entityKey, accessors, ctx, container)` that
  reads this schema and renders the right input type per field (`t`=text, `m`=multiline,
  `n`=number, `y`=boolean checkbox, `s`=select, with the `s` case needing per-field
  custom option lists supplied via a small dispatch — e.g. `type` options come from
  `settings.elements`, `relationship` options come from `validRelationOptions(store,
  fromType, toType)` filtered by the connector's *actual* endpoint types, `routingStyle`
  gets a hardcoded 4-option list). Never hardcode a field-specific panel by hand when
  the schema-driven renderer can do it — every new editable field added by a later
  phase should be a `showFields` entry plus an `accessors[field] = {get, set}` pair, not
  a bespoke DOM block.
- **Split the panel in two, deliberately**: a top section for *this view's placement*
  of the selected node/connector (ViewMember fields: position, Fill Color, Order,
  External flag), and a collapsible "Root Properties" section below for the *shared,
  underlying* Part/Connector fields (Label, Type, Description, Script, Note, ...,
  read-only Created/Updated timestamps). This split matters — someone should be able to
  tell at a glance whether a field they're about to edit changes this one diagram or
  the thing everywhere it appears. Catalog table rows (Phase 3) show only the Root
  Properties side, since there's no "this view's placement" concept outside a diagram.
- **Node sizing**: uniform node size per view (`view.nodeWidth`/`nodeHeight`,
  auto-derived), with a "Redraw" command that measures every node's actual content
  (current label text, plus whether type/keys/description toggles are on) and sets a
  uniform size to fit the largest, clamped to a sane range — and *always* pairs this
  with an overlap-resolution pass afterward (nudge apart anything that now overlaps
  because nodes grew), never resize alone. Any command that adds new content to a view
  (template population, industry generation, ...) should resize+resolve before
  rendering too, not leave it for a manual Redraw.
- **Dialogs**: build one shared modal pattern (`.modal-overlay > .modal-box`, appended
  to a dedicated `#modal-root`). **Every dialog must close only via its own explicit
  Cancel/Close/Submit button** — never on an outside click, never on any keyboard
  shortcut. This is a strict, blanket rule discovered the hard way after building it
  the other way first; don't reintroduce click-outside-to-close on any future dialog.
- **Dropdown menus**: one shared base CSS class capped at a sane viewport-relative
  height (`max-height: 70vh; overflow-y: auto`) so a long list (many Streams, many
  element types) scrolls instead of running off-screen — apply this at the shared base
  class, not per-dropdown, so it's automatic for every future menu.
- **Toasts + Message Log**: toasts for point-in-time feedback (auto-dismiss), plus a
  persistent Message Log side panel (with Copy/Clear buttons) that important messages
  should *also* land in, not just flash and disappear. Centralize this: hook a single
  `app.toast(message, isError)` function so that every `isError=true` call automatically
  also writes to the Message Log — don't rely on every call site remembering to log
  separately, and don't skip logging for anything genuinely important just because it
  isn't flagged as an "error" (e.g. an import summary is success, not an error, but
  still belongs in the durable log — log those explicitly at their own call sites).

---

## 3. Phase 3 — Commands, catalogs, filtering

- **Commands** (left sidebar panel + right-click canvas menu, enabled/disabled based on
  current selection): Generate Stream, Duplicate Stream, Split Node, Level Up, Level
  Down, Merge, Copy/Paste, Remap, Redraw, Add Existing, Populate From Template.
  Advanced-menu-only commands (less frequently used, or riskier/bulk): Smart Check
  View, Generate Industry, Generate Inventory View, SFCE Catalog (Phase 11).
- **Generate Stream**: given a chosen stream template (Phase 4) and a Function/
  Capability/Entity name triple, create-or-reuse Parts along the template's `value[]`
  chain (find-or-create by `label+type+model`, or by `xIds+model` when an xId is
  given), connecting each to the next with `connectorType: 's'`, plus any `passive`
  entries (independent `{from,to}` node pairs, e.g. a Function's own Process sibling,
  found-or-created the same way but requiring a *label* match too, not just a stream
  name match — see Phase 12's bug writeup for exactly why that distinction matters).
- **Level Down / Level Up**: push selected nodes into a new sub-view (placing a single
  linked placeholder node here, double-click to navigate down; double-click the
  placeholder to come back up) / build a new parent view containing this view's nodes.
- **Remap**: three patterns — default (group by stream into template-ordered rows),
  none (plain sorted grid), and force-directed (Phase 5). Options: template selector,
  sort-priority list (drag to reorder, hidden for force-directed since that pattern
  doesn't use it), column limit, "only remap filtered nodes" (combine with the
  Stream/Type filter to reorganize a subset without disturbing the rest of a busy
  view).
- **Smart Check View**: repairs gaps between a view and the underlying model. Two
  independent checkboxes: "missing connectors" (default on — adds a connector-
  ViewMember for any model connector whose both endpoints are already on-view) and
  "missing connectors and nodes" (default off, with a Levels field defaulting to blank/
  unlimited — BFS-expand to pull in missing nodes near their anchors too). Keep these
  two checks' logic phases strictly separate — the second must not silently do the
  first's job for pairs the first didn't touch. Log every individual change made to the
  Message Log, and append a short note directly onto whichever connector it
  created/placed, so there's a durable trail.
- **Catalog tables**: full sortable tables for Parts/Connectors/Views/ViewMembers,
  independent of any one diagram, reusing the same generic `tab.tableRows/tableCols`
  mechanism from Phase 2 — bulk review, find-by-name, click a row to select (which
  shows the same Root-Properties-only panel).
- **Filtering**: Stream filter (dropdown, multi-select), Type filter (checkbox list
  with select-all/exclude-all, scrollable for large toolkits), and a "connector levels"
  number (when either filter is active — how many extra hops of connected nodes to also
  show beyond direct matches, blank = unlimited, so a filtered node isn't shown floating
  with no context). Toolkit sidebar gets its own, separate Source (TOGAF/ArchiMate/
  Other) and Group (Application/Business/...) filter chips, styling Group chips
  distinctly (e.g. light blue) from Source chips.

---

## 4. Phase 4 — Simulation scripting

Any Part can carry a script (`part.script`, gated by `part.scriptEnabled`) that runs
once per simulation "tick" — this is what makes the tool model live behavior across an
architecture, not just a static diagram.

- **Per-model simulation runtime**: `store.simRuntime: Map<modelName, {tick, values:
  Map<partId, {value, state, lastError}>}>`. Simulate one Model at a time (a model
  selector next to Run/Pause/Step/Stop), across every scripted Part in that model
  regardless of which views currently show them.
- **The script's `ctx` contract** (document this exactly, it's the whole scripting
  API): `ctx.part` (the Part record), `ctx.inputs` (array, one per incoming connector:
  `{fromPartId, fromLabel, connector: {relationship, streams}, value}` — value is
  `undefined` if that neighbor hasn't produced one yet this tick), `ctx.responses`
  (same shape, for outgoing connectors whose target sent a *response* back last tick —
  see below), `ctx.state` (whatever this Part's own script returned as `state` last
  tick, empty on tick 0 / after Reset), `ctx.tick`, `ctx.log(message)` (writes to
  Message Log), `ctx.secrets` (read-only, locally-loaded-only settings like an API key
  that should never end up saved into a shared model file), `ctx.setState(patch)` (for
  async work — merges into state at the *start of the next* tick rather than
  immediately).
- **Required return shape**: `{value, state, response?, badge?}`. `value` is what
  downstream connectors carry next tick. `state` carries forward to this same Part's
  own `ctx.state` next tick. `response` (optional) travels *backward* to every node
  feeding into this one, arriving as their `ctx.responses` one tick later —
  acknowledgement/feedback flows. `badge` (optional) is `{text, color}` shown on the
  node (only while the view's "Show Script Badge" toggle is on, only for ticks that
  actually return one) — independent of the automatic value display.
- A Part with no script (or disabled) and exactly one incoming connector passes that
  single input through unchanged; with zero or multiple inputs and no script, it sits
  idle. Wrap each Part's script execution in its own try/catch — one Part's error
  (logged, node keeps its last good value) must never stop every other Part's tick from
  running that same cycle.
- Give the Message Log a Copy and Clear button, and (once Phase 2's toast/log hookup
  exists) make sure `ctx.log()` output and simulation errors both land there.

---

## 5. Phase 5 — Layout algorithms

### 5a. Force-directed Remap pattern

Direct discrete grid placement via BFS, not a continuous physics simulation with
tunable constants — this was rebuilt from a first attempt at "actual" force-directed
placement (Fruchterman-Reingold-style repulsion/attraction) after that produced
disconnected clusters drifting arbitrarily far apart and edges that were merely
"closer" rather than truly grid-adjacent. The discrete-BFS approach guarantees a real
property: any edge that's part of the BFS spanning tree places its two endpoints in
literally adjacent grid cells (one of 8 neighbors: N/NE/E/SE/S/SW/W/NW).

- Find connected components (Union-Find). For each component: start from its
  highest-degree node at grid (0,0), BFS outward, placing each newly-discovered
  neighbor in the nearest free one of its parent's 8 immediate neighbor cells (falling
  back to an expanding-ring search if all 8 are taken — a hub with many connections).
  Pack the resulting per-component grids onto a shared canvas via a simple shelf
  packer, non-overlapping.
- **Two independent placement options**, both real toggles in the Remap dialog:
  `preferRightPlacement` (try East first in the 8-neighbor search instead of North, so
  a newly-discovered node lands to the right of its parent when that cell's free) and
  `onlyNewRowForNewGroup` (replace the free-form 8-neighbor search with depth-fixed
  rows — root at row 0, its direct neighbors at row 1, etc. — so same-BFS-depth
  siblings share a row instead of scattering based on which immediate cells happened to
  be free; produces a level-by-level tree layout).
- Honest, permanent limitation to document rather than "fix": a *non*-tree edge (a
  cycle's extra edge, e.g. the third edge of a triangle where the first two already
  used up the shared node's adjacent slots) can't always land its endpoints adjacent
  either — no 2D grid can guarantee that for an arbitrary graph (a 5-node complete
  graph provably can't be drawn that way at all). Tree edges get the guarantee; cycles
  get the closest achievable placement.

### 5b. Obstacle-avoiding connector routing

Two independent per-view settings — `view.routingStyle` for `'c'`-type (regular)
connectors, `view.routingStyleStream` for `'s'`-type (stream) connectors, so someone
can keep one kind curved while routing the other around obstacles. Four options for
each: `default` ('c'-type draws a gentle quadratic-bezier curve; 's'-type draws a plain
line), `straight` (an explicit, unconditional straight line regardless of connector
type — distinct from `default`'s conditional behavior), `direct` (straight-line
obstacle avoidance via a visibility-graph + Dijkstra pathfind around nearby node
bounding boxes), `manhattan` (same but axis-aligned right-angle segments only).
Obstacle avoidance deliberately only considers obstacles local to each connector's own
region, not the whole diagram, for performance on large views — document this as
intentional, not a bug to "fix" by widening the search.

### 5c. Section-based view layout

For view types with a fixed grid of named sections (each restricted to certain element
types via `elementTypes`), compute each section's pixel bounds by stacking them
vertically with a gap, computing each one's grid-cell size from the *view's actual
current* node size (not a hardcoded constant, so a later Redraw/Remap that changes node
size doesn't leave the grid stuck at the old size).

**A specific pitfall worth calling out explicitly, since it's exactly the kind of thing
that's easy to reintroduce**: a title-only header section (`elementTypes: []`, meaning
it never accepts a drop) has zero *visual* body height in the stacking computation —
but if the hit-test function used to resolve "which section is at this pixel" computes
its own bottom-edge bound from `section.rowCount * cellHeight` directly instead of the
*actual* computed body height (which is correctly zero for a title-only section), the
title's hit-test zone silently extends a full cell-height below its header — right into
the top of whichever section comes immediately after it. Nodes dropped near the top of
that next section get misclassified into the title section and rejected. **The fix**:
have the hit-test function use the *same* computed body-height value the stacking
layout function produces, not an independently recomputed one — one source of truth for
"how tall is this section," used by both layout and hit-testing.

Drag-and-drop onto a section: resolve target section by pixel, reject (revert to
original position, with a specific, detailed rejection message — see Phase 7) if the
node's type isn't in that section's `elementTypes`. If the resolved cell is already
occupied by a *different* node, search the rest of the section (forward from the drop
point, then earlier rows in case something was deleted leaving a gap) for a free cell
instead of silently placing the dropped node on top of (hiding) the occupant; if the
whole section is genuinely full, grow it by one row rather than accept the overlap.
Scope this "grow on full" behavior to drag-and-drop specifically — other placement
paths (template population) can keep a simpler "accept the overlap" fallback, since
silently growing a section on every template populate would be surprising.

When a section's own `rowCount`/`columnCount` is edited directly (not via drag), every
node in every section stacked *after* it needs repositioning to match the new
boundaries — build one `rescaleSectionPositions(store, view, oldSnapshot)` helper
(convert each node's position to a (row,col) index using the *old* layout, then back to
pixels using the *new* one) and reuse it for the view-level (spacing scale, node size)
and section-level (rowCount, columnCount) editing paths alike, rather than writing this
twice.

---

## 6. Phase 6 — ArchiMate import

Import a standard ArchiMate 3.0 Exchange Format file into Parts/Connectors/Views.
Re-importing the same file should update existing records in place (matched by the
file's own stable ids) rather than duplicating.

Two conventions that don't map directly onto this app's own model, both requiring
active handling rather than silent data loss:

- **Junctions** (AND/OR routing points) have no equivalent Part — dissolve them:
  connect every real source directly to every real target it fed through the junction,
  noting which logic (AND/OR) the junction represented. Watch for a real bug class
  here: junction-touching connectors where only one side of a bypass has been placed on
  a view (the junction's own diagram node existed in the source file, but flattening
  through it means that node effectively "disappears") — auto-place the missing
  endpoint near its already-placed neighbor rather than dropping the connector.
- **Nested shapes**: some source files represent a Composition/Aggregation
  relationship by drawing one shape inside another in the diagram XML, with no explicit
  `<connection>` element for it at all. Detect this (recursively walk nested `<node>`
  elements, preserving parent/child structure — not a flattened list, which loses which
  shape is inside which) and create the connector anyway, noting on whichever record
  had to be created that it was inferred from nesting rather than an explicit line.

---

## 7. Phase 7 — Better feedback on rejected actions

Whenever a user action gets rejected (section placement, connector validity, form
validation, ...), the message should name the *specific rule* that caused it, not a
generic "that didn't work." E.g., for a section-placement rejection: name the specific
node, its type, the section it was dropped into, and that section's actual allowed
types — `"Audit" (BusinessFunction) cannot be placed in section "Enterprise Functions"
— that section only allows: no element types at all.` This is a real, general design
principle here, not a one-off: build every future rejection message this way, and once
Phase 2's `toast(msg, true)` → Message Log hookup exists, these all land in the durable
log automatically with no extra plumbing.

---

## 8. Phase 8 — In-app documentation

Add a startup tab (opens active alongside the home canvas tab, which stays open behind
it) containing a written reference for the target audience (EA/BA practitioners, not
developers): the data model and why the ViewMember split (Phase 2) matters in practice,
view types and layout options, a full commands table, filtering, the property-panel
split, simulation scripting's full contract with a minimal example, ArchiMate import's
two special cases, and a closing tips section — including stating plainly which fields
currently have no visible effect (be honest about known gaps like the unused
`endSize`/`fontColor`/`fontSize`/`borderColor`/`margin` fields — see Phase 12's audit —
rather than letting someone discover that by trial and error). Reachable again later
via a small header button if closed. Build this as a genuinely new content type (fetch
a static HTML fragment into a dedicated tab render path), not shoehorned into the
generic table mechanism.

---

## 9. Phase 9 — Regression test suite

No test framework, no build step (matching the rest of the project) — write a single
Python script (`tests/run_all.py`) that starts a local static server as a subprocess,
drives a headless-browser instance (Playwright) through the app's real JS API
(`window.<appGlobal>.store`, `commands.js` functions imported live via dynamic
`import()`), and asserts on real, observable outcomes. Each check is a small function
`check_something(page) -> (passed: bool, detail: str)`; keep each one scoped to a
single mechanism, not five unrelated assertions bundled together, so a failure is easy
to diagnose without re-running by hand.

**The suite must be able to catch a regression it's meant to guard against, not just
pass vacuously** — for any given check, prove this at least once during development by
deliberately reintroducing the bug it targets and confirming the check fails with a
message that matches the bug's actual symptom, then reverting and confirming it passes
again.

**A subtle environment lesson worth stating explicitly**: combining a locally-spawned
HTTP server subprocess with browser automation is reliable when written as a
standalone script file (server subprocess and browser logic co-located, executed via a
plain `python3 script.py`) but can be unreliable when the identical logic is run via an
inline shell `-c` command instead — if browser-based verification starts failing for
no apparent reason, try moving it to a script file before assuming the application code
is at fault.

Grow this suite continuously through every later phase — the goal by the end is one
permanent check per real bug found and fixed (not just one per new feature), so nothing
regresses silently.

---

## 10. Phase 10 — Import an arbitrary external SFCE dataset

Add a wizard (File menu) to import an arbitrary external JSON file as an alternate
Section/Function/Capability/Entity data collection for bulk-generating content (see
Phase 11), without touching the canvas at all (no viewMembers, no new view — purely
populates a stored data collection).

- **Generic nested-JSON flattening**: handle the realistic shape of an external export
  — a top-level array of groups, each carrying a nested array-of-objects field — by
  detecting that pattern and flattening each nested item into a record that also
  carries its parent's own scalar fields (so, e.g., a "domain" field on the outer group
  and a "name"/"description"/"ministries" on each inner item all become fields on one
  flat record). Don't assume the input is already flat rows; a real-world nested export
  is the common case to design for.
- **Three-step wizard**: pick a file and preread it (discover available field names);
  suggest an industry name (from the filename) and field mappings (keyword search
  across *all* candidate fields for each priority keyword before falling back to the
  next keyword — not the other way around, or a low-priority-but-early-appearing
  keyword like "capability" matching a field like "capability_count" would beat a
  better match like "name"); confirm and import. Handle missing values by keeping the
  row with an explicit "(unspecified)" placeholder rather than silently dropping it — a
  missing Entity value is the one deliberate exception, since a source row might
  genuinely have no distinct fourth-level concept at all (no entity name selected → no
  entity child created for that row, not an error).
- **A field with multiple values** (comma-separated string, or a native array) gets
  split into one row per value.
- **"Shared" — get this semantic right, it's easy to build the wrong version first**:
  Shared describes a **Function** that ends up needing to exist in more than one
  Section (because different Capabilities under it landed in different single
  sections), not a Capability whose own section field happened to have multiple
  values. After building all rows, detect which Function names span more than one
  distinct Section; if any do, prompt: combine every section's copy into one Function
  (placed in one literal section named "Shared", with all its Capabilities from every
  original section combined) or keep each section's own copy (in which case, apply a
  numbered suffix — plain name for the first section by first-seen order, then `Name1`,
  `Name2`, ... for each subsequent one — no parentheses, no space).
- On completion, log statistics to the Message Log: the ordered list of unique sections
  (in first-seen order — this ordering has downstream value, keep it stable and
  intentional, not just whatever `Object.keys` happens to return) plus Function/
  Capability/Entity subtotals, and a note on any missing-value handling.

---

## 11. Phase 11 — Bulk generation from an SFCE dataset

"Generate Industry": walk a Section/Function/Capability/Entity dataset (either the
built-in default, or one imported via Phase 10) and call the Phase 3 stream-generation
mechanism once per Capability×Entity pair, generating a full stream for each. A
Capability with no Entity children (a real, valid case per Phase 10's design) still
needs to generate something — fall back to the Capability's own name/description
standing in for the entity, rather than requiring every Capability to have a distinct
one.

- **A Section field belongs on the generated Part, at the Function level specifically**
  (not Capability or Entity — that's where the Phase 10 data actually puts it). Thread
  this through the stream-generation call as an explicit parameter and set it only when
  generating the Function-level node — but verify carefully *which* code path actually
  creates that node for whichever stream template is in use; a template's Function node
  might be produced by an entirely different code path (e.g. a "passive" side-node
  mechanism, not the main chain-generation loop) than a first glance at the template
  structure would suggest, and wiring a new field into the wrong path silently drops it
  with no error.
- **Past 100 generated nodes, leave the selection empty** rather than a small,
  misleading partial one (whatever the last individual generated stream happened to
  select) — do this unconditionally, before any step that could throw, not after one.
- **Performance, budget real attention here**: naive per-call lookups (find an existing
  Part by label+type+model, find an existing ViewMember for a Part in this view, find
  an existing stream connector, ...) are each a full scan across the *entire*, ever-
  growing document — fine once, but O(n²) or worse across hundreds or thousands of
  generation calls into the same growing view, and this is exactly the workload a real
  imported dataset produces. Build an explicit, opt-in lookup cache (plain `Map`s keyed
  by the same composite keys the scans would have searched by) built once up front and
  passed through every generation call in the loop; leave single-call callers (the
  manual "Generate Stream" command) on the original scan-based path, unaffected, by
  making the cache parameter optional everywhere. Also compute the anchor/placement
  position for each generated stream explicitly and incrementally rather than letting
  each call re-scan the view to find "the bottom" on every single call. Even after
  fixing the complexity class, a large real dataset (thousands of generation calls) is
  still enough real work that a fully synchronous loop would visibly freeze the tab for
  its whole duration — make the generation function async and yield control (a
  zero-delay timeout) periodically with a progress callback, and show that progress in
  the UI, rather than relying on the complexity fix alone to make it feel instant.
- **A companion read-only report**: a Catalog page showing this same
  Section→Function→Capability→Entity hierarchy flattened into rows (id + description at
  every level), reusing the generic table-tab mechanism from Phase 2/3, for either the
  default dataset or an imported one — no new rendering code needed, just a flattening
  function feeding the existing generic table.

---

## 12. Phase 12 — Property panel audit

At some point, deliberately audit the property panel field-by-field: for every writable
field the schema exposes, confirm the corresponding value actually gets *read* somewhere
during rendering, not just stored. This project genuinely had several fields (font
color, font size, border color, a view margin setting) that were fully wired as editable
inputs — schema entry, get/set accessor, they'd persist correctly on save/load — but
never once read back out during rendering, so editing them silently did nothing. This
kind of gap is easy to introduce (build the data-model plumbing for a feature, get
interrupted, never finish the rendering half) and easy to miss without a deliberate,
systematic pass rather than incidental testing. Do this pass again after any future
batch of property-panel work, and be upfront in the in-app documentation (Phase 8)
about whatever it finds rather than leaving it to be discovered by trial and error.

---

## 13. Phase 13 — Rebrand

If the product gets renamed at any point (this one was renamed from "FlowRun" to
"DyCAD" partway through), treat it as its own deliberate, systematic pass — search the
*entire* codebase case-insensitively for the old name, not just the obvious title/
heading, and categorize every hit before touching anything: user-facing text (rename
outright), code comments (rename for consistency, low risk), internal debug-only
identifiers like a `window.<name>App` global (rename for thoroughness, but grep for and
update every place that references it, including any test suite that reaches into the
app through it), `localStorage` keys (rename outright is reasonable — document that this
means existing users lose those specific saved preferences once, and decide
deliberately whether that's acceptable rather than treating it as inconsequential),
saved-file-format identifiers embedded in previously-exported files (e.g. a snapshot
format's internal type tag) — for these specifically, accept *both* the old and new
value when loading, so files people already saved under the old name keep working
even though new saves use the new one. Leave historical build-log/changelog entries
describing *past* work under the old name as-is; they're an accurate record of what was
true at the time, not something to retroactively rewrite. Rename delivered build
artifacts (zip filename, the folder it extracts to) to match.

---

## General principles that applied across every phase above

- **Review before building.** When a request has any real ambiguity, work through the
  ambiguity (investigate the current code, ask a clarifying question only if genuinely
  blocking) before writing anything — proceeding on a wrong assumption and having to
  unwind it costs far more than a moment's clarification up front.
- **Verify against the current file contents, not a memory of them from a previous
  step.** Re-read before editing.
- **Test against real data at real scale**, not just a small hand-built example, for
  anything performance-sensitive or anything whose correctness depends on the shape of
  real-world input (an actual customer export is never as clean as a synthetic
  fixture) — several of the bugs above (the passive-node section-field miss, the O(n²)
  performance issue, the anchor-step overlap) were only caught by testing against a
  large real dataset, not the small fixtures that exercised the same code paths
  correctly.
- **Grow the regression suite continuously**, one permanent check per real bug found,
  not just one per new feature — and prove each check can actually fail before trusting
  it.
- **When something is genuinely a limitation rather than a bug** (the force-directed
  cycle-edge case, routing's local-only obstacle scope, several unused property-panel
  fields), say so plainly, in both code comments and end-user documentation, rather
  than leaving it to be rediscovered and re-investigated as if it were new.
