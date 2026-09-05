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
| `js/commands.js` | Every command: `createStream`, `duplicateStream`, `splitNode`, `levelUp`/`levelDown`/`levelDownSingle`, `copyNodes`/`pasteNodes`, `remap`/`applyRemapLayout`, `mergeNodes`, `generateInventoryView`, `generateSelectedViews` (Advanced > Generate View, `GENERATE_VIEW_GROUPS`), `generateIndustry`, `addExistingPartsToView`, `populateFromTemplate`, `insertSmartStream`, `duplicateSection`, `smartCheckView`, `importDDL`/`exportDDL` (Data Modeling, wiring `ddl.js`'s pure parse/generate logic into the Store), plus the bulk-generation lookup cache (`createBulkLookupCache`) |
| `js/layout.js` | Force-directed Remap pattern: `computeAdjacentGridLayout` (per-component BFS placement), `findConnectedComponents` (Union-Find), `packClustersOnGrid` (shelf packer), `computeClusteredGridLayout` (full pipeline) |
| `js/routing.js` | Obstacle-avoiding connector path computation (`computeRoutedPath`): visibility-graph + Dijkstra for `direct`, axis-aligned variant for `manhattan` |
| `js/sections.js` | Section-based view geometry: `computeSectionLayout`, `pixelToNearestGrid` (hit-testing), `isTypeAllowedInSection`, `findFreeCellInSection`/`findFreeCellOrGrowSection`, `rescaleSectionPositions`, `duplicateSectionDefinition` |
| `js/archimate.js` | ArchiMate 3.0 Exchange Format import: element/relationship/view parsing, junction flattening, nested-shape (Composition/Aggregation) detection |
| `js/sfce.js` | Pure logic (no DOM) for the Load SFCE wizard and industry-tree operations: `flattenJsonRecords` (generic nested-JSON flattener), `buildRowsFromRecords`, `detectSharedFunctions`/`resolveSharedFunctions`, `buildIndustryTree`, `flattenIndustryTree` (for the SFCE Catalog page) |
| `js/ddl.js` | Pure logic (no DOM) for Data Modeling's DDL import/export: `parseDDL` (a scoped `CREATE TABLE` subset — not a general SQL grammar), `generateDDL` (the reverse), `splitTopLevel` (paren/quote-aware delimiter splitting) |
| `js/simulation.js` | Per-model tick engine (`stepSimulation`, `startContinuousRun`/`pauseContinuousRun`/`stopContinuousRun`), the `ctx` contract implementation, the 3-tab Log area (`pushMessageLog`/`pushActivityLog`/`pushDebugLog`), simulation snapshot save/load |
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

**`Part.rawLabel`, actually wired up (Step 45)**: asked directly whether it was live —
*"what is RawLabel currently used for? Was meant to be the label portion without
element prefix or suffix, but currently appears same as label"* — confirmed true: every
`createPart` call site, including `createStream`'s own, set `rawLabel` to the exact
same value as `label`, so the field (per `RECREATION_PROMPT.md` §1's original Phase 1
spec — *"the label before any prefix/suffix decoration from the element definition is
applied"*) had never actually been populated with anything but `label` itself. Fixed
directly: `Store.createPart` (`state.js`) gains an optional `rawLabel` parameter,
defaulting to `label` when omitted — every caller with no decoration concept at all
(manual part creation, `ctx.createPart`, ArchiMate import) is completely unaffected.
The three `commands.js` call sites that actually build a `joinLabel(el, rawName)`-
decorated label now thread the true pre-decoration `rawName` through explicitly:
`createStream`'s main `template.value[]`-chain loop, `createPassiveNode` (the
`passive[]`-pair loop), and `autoCompleteStreams`' `resolve()` (which deliberately uses
the stream's own name as `rawName` for every category — see that function's
pre-existing comment). `deriveStreamNames` (the Generate Stream dialog's "prepopulate
from an existing stream" support, §7 area) now reads `part.rawLabel` directly instead
of reverse-engineering it from the decorated `label` — the `unjoinLabel` helper that
used to do that guess-work (regex-stripping a known prefix/suffix back off, with its own
comment admitting it wasn't a general-purpose inverse) is removed as dead code, since
nothing else called it and `rawLabel` now genuinely holds what it was reconstructing.
New `check_raw_label_wired_up` (`tests/run_all.py`) covers all three real creation
paths — SFCCE (main-loop decoration on BusinessCapability/ApplicationCapability, no
decoration on DataDataEntity, passive-loop no-decoration on BusinessFunction), the
"Test" template (passive-loop decoration on GeneralActor, the one type in its
`passive[]` list not also in its own `value[]`, so it's only ever created via
`createPassiveNode`), and a real Auto-Complete Streams dialog run (Enterprise template,
decorated BusinessCapability) — plus a plain manual `createPart` call confirming the
no-`rawLabel`-argument default is unchanged; proven via TEMP BREAK (reverting
`createPart`'s default back to always mirroring `label`, which collapses every
decorated case in the test back to `label === rawLabel`). The pre-existing
`check_generate_stream_prepopulates_from_existing` (unchanged) already covers the
`deriveStreamNames` rewrite end to end through the real dialog, since it exercises
exactly the same "Manage"/"Provide"-decorated SFCCE types.

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

**Resizable textarea heights** (`show: 'm'` fields — Note, Description, Script) are a
cross-document, cross-model UI preference, `dycad-field-heights` in localStorage — the
exact same "per-browser habit, not document data" reasoning `PINNED_FIELDS`
(`render.js`) already uses for pinned fields, get/set/getAll/setAll functions included
(`getFieldHeight`/`setFieldHeight`/`getAllFieldHeights`/`setAllFieldHeights`, the last
two wired into File > Save/Load Local Settings alongside `pinnedFields`). Reported
directly: *"when property resizable text fields are lengthened by user (lower right
corner dragged) can that be persisted for the user for that property in any view for
current session and future sessions. currently the resize is lost when user clicks
away from the node."* Root cause: `renderShowFieldsPanel`'s own `'change'` handler
calls `app.recordAndRender()` on every commit — including a plain blur — which rebuilds
`#properties-body` from scratch, discarding whatever height a user had dragged the
native CSS `resize: vertical` handle to. `wireFieldHeightPersistence(el, fieldName)`
observes each rendered textarea with a `ResizeObserver`, persisting `fieldName`'s new
height (keyed by field NAME alone, not entity-qualified — Note ends up the same
whether it's a Part's, Connector's, or ViewMember's, all sharing the one textarea
style) whenever it genuinely changes; `fieldHeightStyle(fieldName)` applies whatever's
saved as each textarea's own initial inline `height`. A real bug found via direct
testing before landing this: a `ResizeObserver`'s very last callback on an element
that's just been removed from the DOM (exactly what happens to the OLD textarea the
instant a re-render swaps it for a new one) reports a bogus `0x0` content rect — an
early guard (`if (h <= 0) return;`) was needed, or every deselect would have silently
zeroed out the height it had just saved a moment earlier. Wired into both textarea
call sites — the single-selection panel above, and `renderMultiSelectProperties`'s own
bulk-edit textarea.

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

**Script Console's Console/Reference tab split** (`promptScriptConsole`, `main.js`):
reported directly, *"the script console page is too long ... put [the reference info]
in a table format ... Can a tab be created ... to only show reference details when
user selects it? this leaves the two main windows ... wider."* The dialog used to open
straight into a dense bindings/options paragraph sitting above the output area and
editor, pushing the whole thing tall on every open. It now opens on a **Console** tab
(just `#console-output` + `#console-input`, no inline prose) with a separate
**Reference** tab (hidden until clicked) holding the same bindings/options content as a
`docs-table` — plain `.tb-btn`/`.tb-btn.active` toggle buttons swap which pane's
`display` is set, nothing fancier. The dialog itself grew from `modal-box-textedit`
(`min(640px, 90vw)`) to a new, wider `modal-box-console` (`min(920px, 96vw)`) — since
the reference text no longer has to read as narrow flowing paragraphs, the two main
panes get to use the freed-up width. `public/instructions.html`'s own Script Console
section mirrors the same table (kept as two independently-maintained copies, same
precedent as every other in-app help text duplicated there).

Direct follow-up, since the dialog was still too tall: *"script console page still too
long, barely fits at 80%. Make output window half the length and scrollable, and make
reference part scrollable and have the length on open. Add 'copy' buttons to the three
windows: output, script, reference to allow user to easily copy individually."*
`#console-output` dropped from 280px to 140px (still `overflow-y: auto`); the
Reference tab's content moved inside a new `#console-reference-scroll` wrapper given
its own fixed height (`480px`) and `overflow-y: auto` set directly in the initial
`innerHTML` — i.e. already fixed **at open**, not something that only appears/grows
once the tab is first clicked, so switching tabs never resizes the dialog. Each of the
three panes (Output, Script, Reference) got its own small header row with a **Copy**
button — one shared `copyPaneText(getText, label, btn)` handler per button, each
supplying a different getter (`outputEl.textContent` / `inputEl.value` /
`referenceScrollEl.textContent`) so a mixed-up wire-up is directly testable (marker
text unique to each pane, checked against the real clipboard).

**Further shrinking, once the Detach button existed**: reported directly, *"Shorten
text starting with 'Ctrl+Enter' and move to same line as console and reference
buttons, and reduce by about 25% the length of the output text area."* The old
three-sentence paragraph (Ctrl+Enter usage, a pointer to the Reference tab, and an
"Edits are saved automatically" reassurance) sat in its own row directly above the
Output pane; it's now one short sentence living inside `.console-tabs` itself, as a
genuine sibling of the Console/Reference tab buttons — the "see the Reference tab"
pointer was dropped entirely (redundant now that the Reference button sits right next
to it), and the auto-save reassurance survives as a `title` tooltip on that same
sentence rather than being deleted outright — the same "shown only on request" pattern
the Remap dialog's own "Align by section" note already established. `#console-output`
dropped from `140px` to `105px` (~25% less, on top of the earlier `280px -> 140px`
halving above). New `check_script_console_header_and_output_size`
(`tests/run_all.py`) — `check_script_console_sizing_and_copy_buttons`'s own stale
`140px` height assertion updated to `105px` in the same pass — both proven via TEMP
BREAK.

**Run function picker**: reported directly, *"change the run button so user can select
(from a sorted list of functions in the script file) a function from the script file to
run, with main as the default."* Run used to always compile-and-call a hardcoded
`main`; it now calls whichever name is selected in a new `#console-run-fn <select>`
next to the Run button. `findAllScriptFunctionNames(code)` (`main.js`, alongside
`findCustomRemapFunctionNames`, same pure-text-scan technique — no `new Function`
compile, so it's safe to call on every keystroke even against code that doesn't
currently parse) scans for every top-level `function Name(` declaration (matching
`async function` too, since `async` just precedes the `function` keyword the regex
looks for) and returns the names sorted alphabetically. The dropdown is rebuilt on the
editor's own `input` event via `populateRunFnSelect(preserveSelection)`: it tries to
keep whatever's currently selected if that name still exists in the rebuilt list, else
falls back to `main` if present, else the first name alphabetically — so a person
picking, say, `BatchScript_RemapExample` doesn't get silently bounced back to `main` on
every keystroke, but an edit that removes the selected function entirely still lands on
a sane default instead of a dangling selection. `run()` reads `runFnSelect.value` (or
`'main'` if the dropdown is empty) as `fnName` and swaps it into the same
`new Function(...)('...;return typeof ${fnName} === "function" ? ${fnName} : null;')`
extraction the old hardcoded-`main` version used — `fnName` only ever comes from a
scanned `function Name(` match (word characters only), never free-typed, so this stays
as safe as the existing `main`/`dataAutoFill`/`CustomRemap_<Name>` extractions. New
`check_script_console_run_function_picker` (`tests/run_all.py`): the default script's
functions list sorted with `main` selected by default; the list rebuilding after an
edit; Run actually calling a selected non-`main` function; the prior selection
surviving an edit that drops `main` but keeps that selection; and falling back to the
first name alphabetically once neither `main` nor the prior selection survives — the
fallback-priority and non-`main` execution both proven via TEMP BREAK.

**Detach to a real window**: reported directly, *"can script console window be non
modal, and larger? detachable window?"* Rather than reworking the shared
`.modal-overlay` every dialog uses (a deliberate app-wide "block everything behind it"
pattern), a new **Detach** button (`App.detachScriptConsole`, `main.js`) opens the
console in a same-origin `window.open(...)` popup instead — a real OS window gets all
three asks for free: it doesn't block the canvas (non-modal), it's freely resizable and
movable to another monitor ("larger"), and it IS the detached window. Same-origin means
the popup can share `this`/`this.store` directly, no `postMessage`/serialization, so
editing there is exactly as live as the in-app dialog: Run/Ctrl+Enter always executes
whatever text currently sits in THAT document's own `#console-input`, never a
cached/saved copy — there is no separate save step. The markup (tabs, output/input
panes, Reference tab, action row) and its wiring (Run, tab switching, the three Copy
buttons, the run-function dropdown) were factored out of `promptScriptConsole` into a
shared `scriptConsoleInnerHTML(modelName, {standalone})` template and a
`_wireScriptConsole(box, win, {standalone, onClose, onDetach})` method respectively, so
the modal and the popup share one implementation — `win` (either `window` or the
popup) is threaded through only for `navigator.clipboard`, so a Copy button's
permission check runs against whichever document is actually focused. The in-app modal
closes as soon as Detach is clicked, so there's only ever one live editor open against
`store.batchScriptCode` at a time — two simultaneously-open copies could silently
clobber each other's edits on Run/Close. The popup gets its own CSS (`css/styles.css`,
`body.console-standalone-body`): no backdrop/centering, and the modal's fixed pixel
pane heights become viewport-relative (`22vh`/`52vh`/`72vh`) so resizing/maximizing the
window actually grows the panes instead of leaving them pinned to the original dialog
size. It inherits the main window's current theme (`data-theme` copied onto the
popup's own `<body>` at open time — a one-time copy, not live-synced if the main
window's theme is toggled afterward) and links the same `css/styles.css` (relative to
the opener's location, since an `about:blank` popup's base URL is inherited from its
opener). Closing the popup via its own window-close (not the in-box Close button) still
persists whatever's typed, via a `beforeunload` handler that writes
`store.batchScriptCode` directly — otherwise text edited but never Run, then closed via
the titlebar, would silently be lost instead of surviving like the in-app modal's Close
button already guarantees. New `check_script_console_detach_to_window`
(`tests/run_all.py`) — the only check in the suite that deals with a real Playwright
popup (`page.context.expect_page()`), since every prior check drives the console via
`app.promptScriptConsole()`/direct DOM inside one page. Covers: the in-app modal
closing on Detach; the popup rendering the same console UI; a script run in the popup
immediately reflecting in `store.batchScriptCode` as seen from the main window; theme
inheritance; and `beforeunload` persistence on window-close without Run/Close — the
Detach wiring and the `beforeunload` persistence both proven via TEMP BREAK (the
`beforeunload` proof needs Playwright's `page.close(run_before_unload=True)`, since a
plain `close()` skips `beforeunload` handlers entirely).

**Live persist while editing (v0.907)**: direct follow-up bug report — *"a node script
calls CommonScript_Example(ctx) but when I edit that function in detached console the
updated code (changing 'called ' to 'called... ') does not take affect until I close
the detached window."* `persist()` used to run only from Run's and Close's own click
handlers — fine for the in-app modal, since its `.modal-overlay` makes it physically
impossible to interact with the rest of the app (e.g. step a simulation from the
Properties panel) while the console is open, so a Close (or a Run) was unavoidable
before testing a change anywhere else. Detaching removes exactly that overlay — the
whole point is to keep editing in one window while acting on the main one — so the same
"only synced on Run/Close" story silently went stale the instant that became possible:
`simulation.js`'s `runTick` compiles a part's script as
`new Function('ctx', store.batchScriptCode + '\n' + part.script)`, read fresh every
tick from the SAME `store` object `persist()` writes to, so any lag between "typed" and
"persisted" is directly user-visible as "my edit didn't take". Fixed by also calling
`persist()` from the input box's own `'input'` listener (`_wireScriptConsole`,
main.js), alongside the pre-existing `populateRunFnSelect(true)` call already there —
now genuinely living up to the dialog's own longstanding "Edits are saved automatically
(Local Settings)" copy, for both the modal and the popup alike, not just Run/Close.
New `check_script_console_edits_persist_live_while_open` (`tests/run_all.py`): creates
a real Part with `scriptEnabled`/`script` calling `CommonScript_Example(ctx)`, detaches
the console, edits `CommonScript_Example`'s own text in the popup, then — WITHOUT
clicking Run or closing the popup — steps the simulation from the main window and
confirms the Message Log shows the just-typed text, not the stale compiled copy;
proven via TEMP BREAK.

**Reopen-while-detached freeze (Step 44)**: reported directly — *"when script editor is
detached, and user goes back to app and double clicks to open script editor again, it
occasionally freezes application completely."* Root cause: `promptScriptConsole` and
`detachScriptConsole` (`main.js`) never actually enforced the single-live-editor
invariant their OWN comment already documented (quoted just above — *"there's only ever
one live editor open against `store.batchScriptCode` at a time"*) — it was only
enforced in ONE direction (detaching closes the in-app modal). `promptScriptConsole` had
no guard against opening a SECOND, simultaneously-live editor while the detached popup
was already open, so reopening via the Advanced menu while already detached produced two
fully-wired editors (in-app modal + popup) each independently attaching their own
`input`/`keydown` listeners against the same store field. Separately,
`detachScriptConsole` had no guard against re-entering itself while its own popup was
already open — since `window.open('', 'dycad-script-console', ...)` targeting an
already-open same-named window reuses that window rather than opening a second one, a
second call still ran through the full `document.head`/`body` teardown-and-rebuild
(`popup.document.body.innerHTML = ''`, then a fresh `scriptConsoleInnerHTML` render and a
fresh `_wireScriptConsole` call), re-wiring a redundant second set of listeners
(including a second `beforeunload` handler) onto a document whose FIRST set of listeners
was still attached — consistent with the reported intermittent freeze under real,
non-headless timing. Fixed by tracking the open popup on a new `App._scriptConsolePopup`
field (set in `detachScriptConsole`, checked via `.closed` rather than nulled out
elsewhere, since every close path — titlebar X, in-box Close, re-detach — eventually
sets it): `promptScriptConsole` now checks `_scriptConsolePopup` first (focus it and
return) and then checks for an already-open in-app modal (focus its input and return)
before building anything; `detachScriptConsole` checks `_scriptConsolePopup` first
(focus and return) before doing any `window.open`/rebuild work. New
`check_script_console_reopen_while_detached_is_idempotent` (`tests/run_all.py`) covers,
via real detach/reopen sequences with no page reload between steps: reopening in-app
while the popup is already detached opens no second modal and no second OS window;
calling `detachScriptConsole` again while its popup is already open opens no second
window and does not replace the popup's `#console-input` DOM node (checked via node
identity — a rebuild always creates a fresh node, which can't be told apart from a
no-op by reading `.value` back alone, since a real edit already persists live into
`store.batchScriptCode`, which a rebuild would then read right back out again); and,
with no popup involved at all, calling `promptScriptConsole` twice back to back still
opens exactly one modal — all three scenarios proven via TEMP BREAK.

**Toolbar Save/Load, and 3D View's menu home — a reversal.** Reported directly:
*"change 'Save JSON' button to 'Save' and 'Load JSON' to 'Load'."* Immediately
corrected in the same exchange: *"remove 'Load' renamed from 'Load JSON' from the top
menu, but keep 'Load' in File menu."* So `#save-json-btn`'s own text is genuinely
renamed to plain `"Save"`, but `#load-json-btn` is REMOVED from the toolbar entirely,
not renamed — File's own `"Load"` item (already plainly labeled, `promptFileMenuLoad`)
is left as the only top-menu-bar way to load a file; it clicks the same hidden
`#load-json-input` directly, so removing the toolbar button's own click wiring doesn't
touch that shared input or its `change` handler at all.
Same exchange: *"Move '3D View' and 'Reset Pinned 3D Positions' and create a new
separator after 'Smart Check Node' in Advanced menu."* Both had previously been moved
INTO their own standalone Explore menu (a direct follow-up at the time: *"Move 'Reset
Pinned 3D Positions' to the Explore menu after a separator"*) — this reverses that
specific decision (see [[feedback-check-for-reversed-prior-decisions]] — recognized as
exactly that pattern going in). Since those two were the Explore menu's ONLY items,
moving both out leaves it permanently empty — rather than leave a dangling,
non-functional top-menu-bar button, the whole Explore menu (button + dropdown div,
`index.html`; `EXPLORE_LINKS`/wiring/its `MENU_PAIRS` entry, `main.js`) is removed
outright. `ADVANCED_LINKS` gains a new separator right after `'Smart Check Node'`,
then `'3D View'`/`'Reset Pinned 3D Positions'`, then the PRE-EXISTING separator that
used to lead straight into Script Console/Code Summary — so the 3D-View pair now sits
in its own distinct group between two separators, not blended into either neighbor.
New `check_3d_view_and_reset_pinned_moved_to_advanced` (replacing the now-obsolete
`check_reset_pinned_3d_positions_moved_to_explore`, whose own assertions the reversal
makes false) and `check_save_load_toolbar_buttons_renamed`; `check_view3d_boots`
updated to open 3D View from its new Advanced-menu location — all three proven/
re-verified via TEMP BREAK, the latter two also exercising a REAL download and a REAL
file-chooser load respectively, not just DOM/label assertions.

### 5.4 Feedback channels

`app.toast(message, isError, alsoLog)` is the single entry point for user-facing
feedback. `isError=true` toasts always also write to the persistent Message Log side
panel (Copy/Clear buttons). `alsoLog=true` opts a routine SUCCESS toast into the log
too — a UI-writing audit (*"are there any UI changes recommended?"*, then *"is toasts
not going to the message log considered appropriate?"*, then *"do both"*) found most
document-mutating commands (Remap, Merge, Duplicate Stream/Section, Level Up, Import
DDL, Auto-Detect Connectors, Add Existing, Populate From Template, Insert Smart
Stream, Generate Industry/Inventory View, Section insert/remove, Delete-from-model,
Sync Inventory Connector, Auto-Complete Streams) reported a real outcome/count in
their toast but left zero persistent trace once it faded — while Smart Check View's
own per-change trail (and a couple of import paths) did, an accident of which
features happened to already have a `log()` closure threaded through, not a
deliberate policy. `alsoLog=true` now marks every genuine-mutation-with-an-outcome
toast explicitly; a routine confirmation with no lasting value (clipboard copy, export
success, a "nothing to do" no-op) stays plain so the log doesn't fill with noise —
same rationale as before, just now an explicit per-call-site choice. Rejection
messages are written to name the *specific rule* that fired — e.g. which section, what
it actually allows, what the rejected item's type is — not a generic failure string.

**Keyboard focus** — the same audit found no explicit `:focus-visible` style anywhere
in `css/styles.css`; every interactive element relied entirely on the browser's own
unstyled default outline. Verified in a real browser (Playwright, tabbing through the
toolbar/menus/a dialog) that this was NOT actually invisible — Chromium's default was
rendering — but it's unbranded (doesn't use the app's own `--accent`/dark-theme
tokens) and not guaranteed consistent elsewhere. Added one global rule,
`:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` — deliberately
`:focus-visible` rather than `:focus`, so it shows for keyboard navigation only, never
for a mouse click. Canvas nodes (`.fnode`) have no `tabindex` anywhere in this app and
so are never part of the native focus order at all — this can never collide with a
selected node's own `.fnode.selected` outline (`var(--node-selected)`).

### 5.5 Derived connectors (`insertSmartStream`, `smartCheckView` — `commands.js`)

A "derived" connector is a genuine, persisted `Connector` synthesized to stand in for a
relationship that would otherwise be silently lost because something in the middle of
it isn't showing on this particular view — not a view-only decoration, so it gets full
rendering/export/inventory treatment like any hand-drawn one. Its `note` field always
records which hidden element type(s)/part(s) it passes through
(`Derived — implied via <Type1, Type2, ...> (not shown)`), and it's styled after the
*first* real hop's relationship (the "topmost parent" convention used elsewhere in this
codebase, e.g. `mirrorCompositionChildConnectorsUp`). Reported directly: *"when
deriving connectors, add flag in connectors that it is derived, in addition to the
existing note addition."* Every derived connector also gets `isDerived: true`
(`Connector.isDerived`, `state.js`'s `createConnector` — genuine document/model data,
round-tripping through `store.toJSON()`/`loadFromJSON()` like any other connector
field, no special-casing needed) — a real, machine-checkable field alongside the
human-readable `note` text, rather than something that has to be inferred by parsing
`note`'s own string. This is what lets `smartCheckView`'s own "Include existing derived
connectors" option (below) tell an existing derived connector apart from an ordinary
one.

Two shared helpers do the work, both used by both commands below:
- **`findDerivedPairsForType(store, connectorType, presentPartIdSet, levels)`** —
  discovery. Walks exactly one `connectorType`'s own graph (called once per type),
  directionally (`c.from -> c.to` only), up to `levels` hops (`null` = unlimited),
  looking for pairs of `presentPartIdSet` members linked only through one or more
  NOT-present parts. Returns a `Map` of `"from|to" -> {from, to, relationship,
  viaTypes}`, excluding any pair already linked by a real direct connector of that same
  type (present or not — a real one already existing anywhere in the model is enough
  to skip it).
- **`createDerivedConnectorPairs(store, derivedPairs, log?, describePart?)`** —
  creation. Reported directly: *"when creating derived connectors, create both 's' and
  'c' versions."* For every pair, creates **both** a `'c'` and an `'s'` `Connector`,
  regardless of which connectorType's graph the pair was actually discovered through —
  a derived/implied relationship is a structural fact worth showing under either lens
  (e.g. the 3D View's own Connector Type filter). Model is taken from the pair's own
  `from` part. Skips whichever type(s) already exist for that exact from/to/model, so
  it stays idempotent no matter how many times — or how many different discovery
  passes — call it for the same pair.

  The pair's own traced `relationship` (the first real hop's relationship name) is used
  as-is for the `'s'` version — matching how every genuine `'s'` connector already gets
  `relationship: 'Stream'` (`findOrCreateStreamConnector`). Direct follow-up: *"when a
  derived connector is created, if a default relationship or valid relationship is not
  available, use 'o' Association not the current 's' Stream for relationship for
  connectors of type 'c'."* A pair discovered by walking `'s'` edges traces back the
  literal word `"Stream"`, which isn't a real `'c'`-type relation at all — so for the
  `'c'` version only, the traced relationship is kept **only if it's genuinely valid**
  for this specific `fromType->toType` pair (`isRelationValid`, `rules.js` — the same
  validity rules the property panel's own relationship dropdown enforces); otherwise it
  falls back to that pair's own data-defined default relation
  (`findRelationshipPair(...).default`) when one exists, else plain `'Association'`
  (key `'o'`) — the exact same "default, else Association" fallback
  `createCompanionConnector` already used elsewhere in this file. A genuinely valid
  traced relationship (typically from a `'c'`-typed hidden chain) always wins over the
  pair's own default, not just over the generic `'Association'` fallback.

  Returns `{ created, all }` (Step 40 follow-up) — `created` is only the connectors
  genuinely minted this call; `all` is every matching connector for the given pairs
  regardless of whether it was just created or already existed. This matters when a
  pair is still a genuine gap this call but one of its two types was already created by
  an *earlier* call over the same pair (e.g. `smartCheckView`'s own `'c'` and `'s'`
  iterations, below, re-discovering one another's pair from each side) — without `all`,
  a caller that only reacts to `created` places a viewMember for the type it just made
  but silently never for the sibling that already existed.

**A real, reported gap `all` does NOT cover on its own (Step 40)**: reported directly —
*"in script main example, when running smart check view on 'smart stream example' the
derived 'c' connectors are not created for datadatadentity or generalactor nodes."*
Traced to the exact shipped pipeline: `BatchScript_InsertSmartStreamExample` (a
`connectorType: 's'` trace) reaches `GeneralActor`/`DataDataEntity` only through a
hidden multi-hop chain, so `insertSmartStream`'s own derivation (below) creates BOTH a
`'c'` and an `'s'` connector for that pair — but places only the `'s'` one, matching
its own trace's scope (see below). The `'c'` one now sits in the model, `isDerived:
true`, with NO viewMember anywhere. `BatchScript_SmartCheckViewExample` then runs
`deriveConnectors: true` on that SAME view — and finds nothing new to derive for that
exact pair: `findDerivedPairsForType`'s own `existingDirectPairs` correctly excludes a
pair that's ALREADY directly connected between two present parts (there's no gap left
to bridge), so it's never even handed to `createDerivedConnectorPairs` in the first
place — `all` never gets a chance to help. Meanwhile `missingConnectors`' own
`isDerived` exclusion (guarding against an UNRELATED other view's derived connector
silently leaking in when not asked for — §5.5's own "Include existing derived
connectors" note, below) blocks it too. The connector falls through BOTH pull-in paths
and never gets a viewMember at all. Fixed with a THIRD, independent sweep in
`smartCheckView`'s `deriveConnectors` block: for the connectorType currently being
processed, any `isDerived` connector with both endpoints already present but no
viewMember on THIS view yet gets placed (and counted in `derivedConnectorsAdded`)
regardless of whether this specific call is what created it — requesting
`deriveConnectors` at all is exactly the explicit opt-in the `missingConnectors`
exclusion was designed to require. New `check_smart_check_view_derive_places_already_
existing_sibling` (`tests/run_all.py`): a synthetic version of the exact shape (A
--hidden--> B, both a `'c'` and `'s'` chain, plus a pre-existing `'c'`+`'s'` derived
A->B pair with only the `'s'` one placed — mirroring `insertSmartStream`'s own real
behavior exactly) confirms `deriveConnectors` places the missing `'c'` sibling, counts
it, and stays idempotent on re-run — proven via TEMP BREAK.

**That sweep introduced a real regression of its own (Step 40 follow-up)**: reported
directly — *"smart check view should only create derived connectors if only connected
through not-shown parts, but instead is currently creating in addition to existing
shown parts. To reproduce: Smart Stream Example 2 from main script, when smart check
view is run with only 'missing connectors' and 'derive hidden' selected, it create
derived connector from application capability to data entity, but should not have
since in view path exists: application capability -> application process ->
application logical component -> application physical component -> data entity."*
Reproduced exactly against the real shipped pipeline: `insertSmartStream` legitimately
derived and created an `ApplicationCapability` → `DataDataEntity` connector while
building the FIRST, narrower "Smart Stream Example" (whose `showTypes` genuinely hides
the intermediate chain) — but that connector's endpoints ALSO both happen to be
present on "Smart Stream Example 2" (a separate, later, broader-`showTypes` view where
the full 4-hop chain IS shown), and the sweep above blindly placed it there too,
purely because both endpoints were present, without checking whether the gap it
represents is still real on THIS view. A derived connector's validity is relative to
what's showing on the CURRENT view, not a fixed property of the connector object —
`isDerived: true` records that it WAS legitimately derived somewhere, not that it
still SHOULD be shown here. Fixed by re-validating before placing: `hasRealPresentPath`
is a small BFS over ordinary (non-derived) connectors of the same connectorType,
staying entirely within `presentPartIdSet` — if `from` can already reach `to` this
way, the shortcut is stale for this view and gets skipped, exactly as it would never
have been derived here in the first place. New `check_smart_check_view_derive_skips_
stale_sibling_when_real_path_shown` (`tests/run_all.py`): the same synthetic A→hidden→B
shape, with a stale derived A→B connector, proves it still gets placed when `hidden`
is genuinely absent (the legitimate case the previous test covers) but is correctly
skipped — with the real A→hidden/hidden→B connectors pulled in by `missingConnectors`
instead — once `hidden` is also present and the chain is fully shown — proven via TEMP
BREAK.

**`insertSmartStream`**'s own discovery predates the shared helper and keeps its
original, narrower scope on purpose: it only derives across parts already inside
`collectedPartIds` (this trace's own already-BFS'd-and-`levels`-bounded neighborhood
from the seeds), not the whole model — so it does NOT call `findDerivedPairsForType`,
only `createDerivedConnectorPairs` for the creation step. Of the two connectors that
step creates, only the one matching *this trace's own* `connectorType` (the dialog's
Connector Type radio) gets pushed into `finalConnIds`/`connsByPart` and thus actually
placed as a viewMember on the view being built — the other type still exists in the
model, just not shown here.

**`smartCheckView`**'s **"Derive hidden connections"** checkbox (`deriveConnectors`
option, off by default) is the direct follow-up that added this same concept to Smart
Check View: *"Add creation of derived (same logic) to a new checkbox in 'Smart Check
View' command."* Here "hidden" simply means "not placed on this view" (there's no
`showTypes`-style filter at this scope) — `presentPartIdSet` is every part currently on
the view (`partIdToVmId.keys()`), and the walk runs once for `'c'`, once for `'s'`, up
to the SAME `levels` field the "missing connectors and nodes" checkbox above already
uses (so the dialog doesn't need a second hop-count input — the Levels row's
visibility toggles on either checkbox). It runs **last**, after every other checkbox's
own additions, so a node "missing connectors and nodes" just pulled in this same run no
longer counts as hidden and won't get spuriously bridged. Every created connector IS
placed as a viewMember here (unlike `mirrorCompositionChildConnectorsUp`, which mirrors
onto a *different*, parent view and so never places anything) — both endpoints are, by
definition, already on this view.

**"Include existing derived connectors"** (`includeDerivedConnectors` option, off by
default) is the companion checkbox to "Derive hidden connections," addressing the other
half of the same report: *"In smart check view, add a checkbox (default disabled) for
include/exclude existing derived connectors for the options so that connectors derived
for other views are not automatically added to the current view unless user enables
it."* Without this option, `smartCheckView`'s own `missingConnectors` pull-in (both the
plain single pass and the per-hop phase-2 pass inside `missingConnectorsAndNodes`) would
happily grab ANY connector — derived or not — the instant both its endpoints happen to
already be present on the CURRENT view, regardless of which view's own Smart Check run
(or `insertSmartStream` call) actually derived it in the first place. A derived
connector genuinely belongs to the model as a whole (same as any other connector), but a
person working on view B usually doesn't want view A's own "bridge the gap" edges
silently appearing just because both nodes happen to also live on view B — so both
pull-in loops now `continue` past any `conn.isDerived` connector unless this checkbox is
checked, leaving every ORDINARY (non-derived) connector's pull-in completely unaffected.
Freshly-created derived connectors from THIS SAME run's own "Derive hidden connections"
checkbox are unaffected by this option too — they're placed through their own dedicated
code path (`createDerivedConnectorPairs`'s returned list, above), never through the
`missingConnectors` pull-in loops this option gates.

**`isDerived` display and a "derived only" filter (Step 40)**: `isDerived` itself
already existed (set by `createDerivedConnectorPairs`, above, on every connector it
creates, either `connectorType`) — reported directly as a follow-up: *"add a isDerived
(or something similar) flag to connectors, set it anytime a derived connector is
created. Valid for any connector type. Add it to connector property view in all views
and catalogs where connector properties are shown. Not user updatable."* The flag was
never actually SHOWN anywhere — a new `isDerived` entry in `custom.json`'s
`showFields.connector` (`show: 'y'`, `access: 'r'` — readonly, since `renderShowFieldsPanel`
checks `access === 'r'` before it ever looks at `show`, so this always renders as a
plain readonly text input regardless of the `'y'` type) now appears in BOTH places a
connector's properties are shown: the Catalogs > Connectors row panel
(`renderConnectorOnlyProperties`) and the canvas-selected-connector panel
(`renderConnectorProperties`) — both needed their own accessor added (`{ get: () =>
!!conn.isDerived, set: () => {} }`), same "no shared helper, duplicated per panel"
pattern the `from`/`to` label-resolution accessors already follow in both functions.

*"Add a view filter (any place connector types can be filtered) to allow only showing
derived connectors."* Two independent additions, matching the two existing connector-
type-filter mechanisms exactly: a new `view.chkShowOnlyDerived` boolean (2D canvas,
default `false`) sits alongside `chkShowConnectorType`/`chkShowStreamType`/
`chkShowDataType` everywhere those three already gate connector visibility —
`redrawEdges` (`canvas.js`) and `buildViewSvgString`'s Export-as-Image path (`main.js`,
which has its own separate connector-drawing loop specifically so exports match what's
on screen — see that function's own comment) — and is schema-driven into the View
Display Filters panel for free via `VIEW_DISPLAY_FILTER_FIELDS`. A new
`tab.showOnlyDerivedConnectors` boolean (3D View, default `false`) is a SEPARATE,
orthogonal toggle from `tab.activeConnectorTypes` — a derived connector can be EITHER
connectorType, so "derived" isn't a value to add to that checklist, it's its own gate —
added as an extra checkbox inside the existing Connector Type filter dropdown
(`main.js`) and checked in `view3d.js`'s own connector-line-building loop. Real bug
caught while verifying this: `view3d.js`'s `computeSignature` (the scene-rebuild-skip
optimization) enumerates every tab/store field that affects the 3D scene and skips a
full rebuild when none of them changed — `tab.showOnlyDerivedConnectors` had to be
added to that list too, or toggling the new checkbox would silently do nothing (the
filtering logic itself was correct; the cached scene just never got asked to re-run
it).

*"Note updated with derived does not replace this, keep existing note for ease of use,
but as an editable note the user may replace it."* No change needed — `createDerivedConnectorPairs`'s
own `note` text and the `note` field's own free-text accessor were never touched by any
of the above; `isDerived` is a separate, independent field. New `check_derived_
connector_flag_display_and_only_derived_filters` (`tests/run_all.py`): both property
panels show `isDerived` correctly (readonly `'true'`/`'false'`), `chkShowOnlyDerived`
reduces both the on-canvas edge count and the exported SVG's path count to just the
derived connector, the 3D dropdown checkbox is present and correctly filters the scene,
and the note text is confirmed both unchanged and still freely editable — proven via
TEMP BREAK (each of the four wiring points independently).

**`insertSmartStream`'s own collection BFS — stream-continuity gate (Step 40)**: a real
bug surfaced once §7.3's Business Organization Unit part gained a genuine `connectorType:
's'` Assignment edge to every Function it's assigned to — an OrgUnit is legitimately a
graph hub, and `direction: 'both'` traversal (`BatchScript_InsertSmartStreamExample`'s
own default) started walking straight through it into every unrelated sibling Function,
not just the seed's own chain (91 parts pulled into one trace instead of 13). A first fix
made `'upstream'`/`'downstream'` strictly direction-consistent per BFS pass (once a pass
starts walking `'to'`-edges, it only ever continues via `'to'`-edges, never switching to
`'from'` mid-walk, and vice versa) — this correctly stopped the OrgUnit fan-out (nothing
points TO an OrgUnit, so upstream traversal naturally dead-ends there) but ALSO broke a
genuinely legitimate zigzag the Enterprise template's own chain relies on: reaching
`GeneralActor` from a Function requires going downstream to its passive `BusinessProcess`
pair, then upstream through `BusinessCapability` and `BusinessService` — two independent
chains (the Function's own passive link, and the template's actor→...→process main
chain) that converge at the same Process node. Direction-consistency broke that
convergence, confirmed directly against `check_batch_script_quickstart`'s own shipped
"Smart Stream Example" losing every `GeneralActor`.

Resolved with a different, orthogonal gate instead of touching direction at all: direction
reverted to the original PER-EDGE check (any edge touching the frontier node counts, in
whichever direction(s) were requested — full zigzag restored), and a NEWLY-discovered
candidate part must now ALSO share at least one `streams` entry with the seed part(s) to
be admitted. This is the actual distinguishing signal between "still this Function's own
generated chain" (every part `createStream` touches for one job shares that job's exact
`streamName`, regardless of which direction the connector runs) and "an unrelated sibling
reached only by transiting a shared hub" (a disjoint `streams` set) — the OrgUnit ITSELF
still passes the gate (its own `streams` is the union of every Function assigned to it,
which includes the seed's), but walking onward from it into a sibling's own chain does
not, since that sibling's `streams` don't overlap the seed's. The gate is computed once,
from the seed(s)' own `streams` union, and is skipped ENTIRELY when that union is empty —
a manually-built graph with no stream tagging at all traces exactly as it always did,
this is purely an additional narrowing that only ever activates for stream-tagged data.
An already-collected part is never re-gated (the check only ever decides admission the
FIRST time a part is discovered). New `check_insert_smart_stream_stream_continuity_gate`
(`tests/run_all.py`): a small synthetic hub graph (seed --downstream--> B <--upstream--
C, all sharing one stream; a hub D --upstream of seed--, sharing that stream too since
it's a union; D --downstream--> sibling E, a DISJOINT stream) proves the zigzag is
admitted and the sibling is blocked, plus a fully untagged pair proving the gate stays
inactive without any seed streams — proven via TEMP BREAK.

### 5.6 The Filters panel (right column)

Reported directly: *"In the right column above properties add a new collapsable group
called Filters. Move the existing filters Stream, Type, Section, Level and the others
but not 'Undo / Redo', 'Current View' or 'Default Model' to this new filter group for
each view type that they apply to."* The 8 tab-scoped filter controls — View Scope,
Stream, Types, Section, Connector Type, Layer Order, Highlight, Levels — used to live
in the header's `#toolbar-row`; they now live in a new `[data-panel-id="filters"]`
collapsible section inside `#right-panel`, immediately above Properties. This was a
**pure relocation**, not a rewrite: every one of these elements keeps the exact same
id (`stream-filter-group`, `view3d-scope-group`, ...), so `renderToolbar`'s existing
`document.getElementById(...).classList.toggle('hidden', ...)` calls (one per group,
gating each on tab type — canvas gets Stream/Types/Section/Levels, 3D gets everything
except Levels, a table/catalog tab gets none) needed **zero logic changes**, only new
CSS (`#right-panel .toolbar-group` — same `.toolbar-group` markup as the toolbar
itself, just one per row with spacing instead of flex-wrap-many-per-line) and the
generic collapsible-panel wiring (`bootstrapApp`, main.js) picking it up automatically
via its `data-panel-id`. One genuinely new behavior: when NONE of the 8 groups apply
(so the section would otherwise show an empty "Filters ▾" header), the whole section
hides too (`renderToolbar`'s own new check, at the end).

Direct follow-up: *"Update the 3D View behaviour so that clicking on empty in the
canvas will bring up this view filters and any view properties specific to 3D
View."* A 3D tab has no single backing `view` document object the way a 2D canvas tab
does (§5.1's `renderViewProperties`) — its only real "view properties" are exactly
these tab-scoped filters. `view3d.js`'s click listener already called `focusPart` +
`selectPartInPanel` on a hit; the `else` branch (empty space, no hit) now calls a new
`deselectAndShowViewFilters(app, tab)`: clears `tab.selectedCatalogRow`, re-renders
(so `renderProperties`'s new 3D-tab branch, `render.js`, shows a short hint pointing
at the Filters panel instead of the generic canvas-flavored "Select a node or edge"
text), then explicitly expands + `scrollIntoView`s the Filters section (removing
`.collapsed`, updating its `dycad-panel-filters-collapsed` localStorage key directly
— duplicated in miniature rather than importing `main.js`'s generic collapsible-panel
handler, same precedent as this file's own `preferredStreamTemplateName`) so the
panel is genuinely "brought up," not just referenced in text.

Further direct follow-up, once the panel existed: *"Move the view filter checkboxes
such as connectors, streams, data, types, description, attributes, keys, show
simulation values (rename to show left badge), show script badge (rename to show
right badge) that are currently below properties to the newly created filters
group."* These 9 fields (`chkShowConnectorType`/`chkShowStreamType`/`chkShowDataType`/
`chkShowElementTypes`/`chkShowDescription`/`chkShowAttributes`/`chkShowKeys`/
`chkShowSimValues`/`chkShowScriptBadge`) used to render inside `renderViewProperties`
(Properties panel), and — unlike the 8 tab-scoped filters above — only while nothing
was selected. `renderViewProperties`'s own `showFields.view.fields` spec (`custom.json`)
is now split via a shared `filteredViewSpec(app, keep)` helper into two disjoint
filtered subsets, both still built from the same underlying `viewFieldAccessors(app,
tab, view)` (factored out so neither copy can drift): the 8 REMAINING properties
(Id/Name/View Type/Margin/Spacing/Spacing Direction/Connector Routing/Stream Connector
Routing) render exactly as before, still gated on "nothing selected"; the 9 MOVED
fields now render via a new `renderViewDisplayFilters(app)` — called from `app.render()`
directly, into a new `#view-display-filters-wrap`/`#view-display-filters-body` pair
appended after the Filters panel's 8 tab-scoped controls (a thin `border-top`
separates the two groups visually) — shown when the active tab is a canvas view AND
nothing is selected (see the reversal below for why "independent of selection state"
no longer holds). Hidden entirely for every other tab type (including 3D — a 3D tab
has no single backing `view` object, per §5.6's own earlier paragraph). Both `renderShowFieldsPanel`
calls pass an explicit `idNamespace` (`'view'` for Properties, `'view-filter'` for
Filters) — passing a merged/filtered spec OBJECT instead of the plain `'view'` string
this used to pass directly triggers `renderShowFieldsPanel`'s own `isMergedSpec`
branch, which would otherwise default BOTH to the generic `'custom'` namespace and
collide.

`chkShowSimValues`/`chkShowScriptBadge` were also renamed in their own
`showFields.view` label (`custom.json`) — **Show Left Badge** / **Show Right Badge** —
to match what they actually indicate (a badge on the node's bottom-left vs.
bottom-right corner, `.fnode-sim-badge`/`.fnode-sim-badge-right`, `css/styles.css`),
now that they sit side by side in the same panel and the old asymmetric naming
("Show Simulation Values" next to "Show Script Badge") read as inconsistent.

Final direct follow-up in the same exchange: *"align view filter panel values to same
column as property values. ... In property and filter panels reduce vertical gaps
between rows."* `#right-panel .tb-label` now gets the exact same fixed `flex: 0 0
84px` width `.prop-row label` already used, so a Filters row's own value control
lines up under a Properties row's regardless of how long either row's label text is
("Stream" vs. "View Scope" vs. "Id") — and `#right-panel .toolbar-group`'s own `gap`
was bumped from the toolbar's original `4px` to `8px` to match `.prop-row`'s `gap`
too, since the label-to-control GAP has to match, not just the label's own width, for
the control's left edge to land on the identical pixel. Base `.prop-row`'s
`margin-bottom` dropped from `8px` to `4px` (denser rows in both panels); a dialog's
own `.modal-box .prop-row` override (`12px`, higher specificity) is untouched.

**Reversal: hidden while a node/connector is selected.** Direct follow-up, once the
"independent of selection" behavior above had been live for a while: *"the panel for
view filters should only be displayed in right side panel when the view is selected on
canvas (ie not clicking on connector or node), current problem is the view filters are
shown as well as the node properties when a node or connector is selected."* The two
panels were visibly colliding — Properties showing a node's own fields while, right
above it, the view-display Filters panel kept showing the VIEW's own display settings,
implying two different objects' properties were open for editing at once.
`renderViewDisplayFilters` (`render.js`) now hides `#view-display-filters-wrap` (clearing
`#view-display-filters-body`) via a new shared `canvasHasObjectSelected(tab)` helper
(`true` for a canvas tab with `tab.selection.size > 0` or `tab.selectedSectionId` set),
in addition to its existing "no view" check — the exact same condition `renderProperties`
itself already uses to decide whether to render `renderViewProperties` vs. a
node/connector's own panel, so the two functions now agree on when "the view itself"
(rather than one of its members) is the thing being edited. (An earlier version of this
fix deliberately kept Section selection carved out — see the broader follow-up
immediately below for why that carve-out was removed.)
`check_view_display_filters_moved_to_filters_panel` (the original relocation guard) had
its own "stays visible with a node selected" assertion removed since that's no longer
true; `check_view_display_filters_hidden_when_node_selected` (`tests/run_all.py`) covers
the reversed behavior, proven via TEMP BREAK.

**Broader reversal: the whole Filters panel, not just the view-display sub-panel.**
Direct follow-up, once the fix above still left a visible collision: *"the 'FILTERS'
property panel still shows when user clicks on a view freeform node; as it is not
specific to the selected node it should not be appearing. Filter section in property
panel should only appear when view is clicked in canvas not on a node, connector, or
section or other canvas object."* The fix above only hid the NESTED
`#view-display-filters-wrap`; the OUTER `[data-panel-id="filters"]` panel itself — its
`<h3>Filters</h3>` header and all 8 tab-scoped controls (Stream/Type/Section/Connector
Type/View Scope/Layer Order/Highlight/Levels) — stayed visible regardless of selection,
so a selected node's Properties still sat directly under a visible "Filters ▾" section
showing unrelated canvas-wide controls. `renderToolbar` (`render.js`) now ALSO hides the
whole panel (`filtersSection.classList.toggle('hidden', !anyFilterApplies ||
canvasHasObjectSelected(tab))`) using the SAME shared helper `renderViewDisplayFilters`
uses, so the two conditions can never drift apart again — and since `canvasHasObjectSelected`
now includes `selectedSectionId`, the nested sub-panel's own earlier Section carve-out
became unreachable dead code the moment its ancestor started hiding for Section
selection too (an already-hidden ancestor wins regardless of a descendant's own class),
so it was removed there rather than left as confusing, never-taken special-casing.
Scoped to canvas tabs only — `canvasHasObjectSelected` is unconditionally `false` for a
3D tab, deliberately NOT extending to a 3D tab's own part selection
(`tab.selectedCatalogRow`): that wasn't part of this report, and hiding Filters there
would fight `deselectAndShowViewFilters`'s own established "empty click brings the
Filters panel up" flow (`view3d.js`, earlier in this section) — the Filters panel IS 3D's
real "view properties" equivalent, unlike a 2D canvas view which has its own dedicated
`renderViewProperties`. New `check_filters_panel_hidden_when_canvas_object_selected`
(`tests/run_all.py`): shown with nothing selected; hidden for a selected node, a selected
connector, and a selected Section (built via a real `store.addView(name, 'org')`, not a
whole-document `store.doc.sections` lookup — `tab.selectedSectionId` actually indexes
`view.sections`, a section-VIEW's own header list, a different concept the ORIGINAL
Section assertion in `check_view_display_filters_hidden_when_node_selected` had gotten
wrong, meaning it silently never ran until fixed here too); shown again after
deselecting; and unchanged on a 3D tab, both before and after selecting a part there.
Both the outer-panel hide and the inner sub-panel's now-unconditional Section hide
proven via TEMP BREAK.

**Select All/Exclude All consistency.** Reported directly: *"Any form with multiple
select checkboxes should also have select all/deselect all checkboxes."* An audit
against the app's existing pattern (a header/lead checkbox toggling every row, syncing
back to reflect the individual boxes' state — Insert Smart Stream's two checklists,
Auto-Detect Connectors' and Add Existing's own table header checkboxes, and the toolbar
Stream/Type/Section/Connector Type filters all already followed it) found exactly two
genuine multi-item checklists without one: Auto-Complete Streams' Part/View table
columns (`promptAutoCompleteStreams`, §5.5's Auto-Complete Streams paragraphs) and Smart
Check Node's "By Stream" checklist (§5.5, `promptSmartCheckNode`). New
`#acs-part-select-all`/`#acs-view-select-all` table-header checkboxes for the former —
`.checked` mirrors whether every row in that column is checked (disabled-and-forced-
checked rows, where the part/view already exists, included), `.indeterminate` a genuine
mixed state, and `.disabled` whether there's any TOGGLABLE row left to act on; clicking
Part-select-all still drives the pre-existing per-row Part→View cascade (unchecking a
part disables+unchecks its View box), just via a shared `applyPartCascade(i)` helper
called both from the per-row listener and the bulk toggle so the two paths can't drift.
New `#scn-streams-select-all` "Select All / Exclude All" row for the latter (only
rendered once there's more than one stream to choose from, the same threshold Insert
Smart Stream's own rows implicitly use — a single item is never ambiguous). Deliberately
left alone: the Highlight (3D) type checklist, which already documents its own reasoned
exception ("highlight everything" isn't a meaningful default), and every dialog whose
checkboxes are independent, differently-meaning options (Import DDL, Smart Check
View/Node's own feature toggles, Redraw) rather than "pick some subset of many similar
items" — a Select All over unrelated options wouldn't mean anything. New
`check_auto_complete_streams_select_all` and `check_smart_check_node_by_stream_select_all`
(`tests/run_all.py`), both proven via TEMP BREAK.

### 5.7 Smart Check Model (`smartCheckModel`, `applySmartCheckModelFixes` — `commands.js`)

Reported directly: *"in Advanced menu before Smart Check View add a new item 'Smart
Check Model' for a new smart check model command. This command opens a dialog
confirming what the user wants to check, begin with two items 'disconnected parts' for
parts with no connectors of any type, 'disconnected connectors' for connectors that
have one or both parts invalid (missing), and 'duplicate parts' for parts that have
same type, model, and label, and present list to user to confirm individually which to
fix / merge or leave as is."* The whole-document counterpart to §5.5's Smart Check
View/Node — those two repair gaps within ONE view's own placed content; this one scans
the entire model (every part/connector, regardless of which views, if any, show them)
for three kinds of data-hygiene issue, unrelated to any one view. `App.
promptSmartCheckModel` (`main.js`) is reachable with no canvas tab open at all — same
as Data Modeling > Auto-Detect Connectors (§7a) — and follows that dialog's own
preview-then-confirm two-step shape: a "Check" button runs pure detection
(`smartCheckModel`, no store mutation) against whichever category checkboxes are on,
rendering one sub-table per category with every row checked by default (plus a
per-section Select All); a "Fix Selected" button then applies only whatever's still
checked via `applySmartCheckModelFixes`, so unchecking a specific row leaves that one
issue alone.

- **Disconnected parts** — parts with no connector (`from`/`to`) referencing them at
  all, of ANY `connectorType`. Fix = delete the part model-wide (and any viewMember
  placements — `Store.deletePart` itself doesn't cascade, same non-cascading
  convention `App.deleteSelection`'s own orphan-cleanup prompt already relies on).
- **Disconnected connectors** — connectors whose `from` and/or `to` no longer resolves
  to a real part (`store.findPart` returns nothing), e.g. left behind by a part deleted
  through some path that didn't clean up its connectors. Fix = delete via
  `store.deleteConnectorAndMembers`, which already cascades to every viewMember
  showing it.
- **Duplicate parts** — 2+ parts sharing the exact same type + model + label, grouped
  by that triple. The FIRST part in each group (`store.doc.parts`' own array order —
  creation order) is always the keep part; there's no UI to pick a different one, but
  each row names it, so which copy survives is never a surprise. Fix = merge
  (`mergeDuplicateParts`) — reassigns every connector's `from`/`to` and every `'part'`
  viewMember's `objectId` from each duplicate onto the keep part (de-duplicating
  per-view where the keep part and a duplicate turn out to already share a view — the
  earliest viewMember there survives, with any `'connector'` viewMember's own
  `fromVmId`/`toVmId` that referenced the removed one repointed first), then
  de-duplicates any connectors this reassignment made identical (same
  `from`+`to`+`connectorType`, via `deleteConnectorAndMembers` so its own viewMembers
  go too, everywhere at once) — the exact same rewire/dedupe shape `mergePartsAndView`
  (§ merge, `commands.js`) already uses for a view-selection-driven merge, just keyed
  directly by part id instead, since Smart Check Model's duplicates were found
  model-wide and may not be selected — or even placed — on any one view together.

**A real bug caught while building this**: `deletePartIds` and `mergeGroups` are both
computed from the SAME pre-fix detection snapshot, so a part that's disconnected (zero
connectors) AND also a duplicate-group member — the keep part or one of its copies —
can legitimately appear checked in both the "delete this" and "merge this group" rows
at once. Applying the delete first (or in any order that doesn't account for this)
either silently no-ops the merge entirely (`mergeDuplicateParts` bails once its own
keep part is already gone) or drops a copy's connectors/streams on the floor instead of
carrying them into the survivor. `applySmartCheckModelFixes`'s fix: merge always wins —
every part id appearing in any confirmed `mergeGroups` entry (keep or duplicate) is
excluded from `deletePartIds` processing regardless of call order. Proven directly
against a TEMP BREAK removing that exclusion (reproduced the exact failure, then
reverted) — see `check_smart_check_model_detection_and_fix_precedence`,
`tests/run_all.py`.

New `check_smart_check_model_detection_and_fix_precedence` (pure logic, the above) and
`check_smart_check_model_dialog` (real Advanced menu/dialog wiring — menu position
above Smart Check View, no-tab-required reachability, per-row uncheck-then-fix, and
Cancel making zero changes) in `tests/run_all.py`.

### 5.8 Toolkit drag-and-drop and filters (`render.js`)

**Group filter chips hide when nothing they'd show survives (`renderGroupFilters`)**:
reported directly — *"in toolkit the element group filters should only display if
elements of that group are visible. For example filtered to source 'Other', there are
elements of group 'Application' so it should show, but there are no elements of group
'Business' so it should not be visible."* `renderGroupFilters` now only renders a
group's chip (`#group-filters .group-chip`) when at least one of its elements survives
the OTHER active toolkit filters — the current view's own `allowedTypes` restriction
(same rule `renderToolbox`'s own tile loop already applies, so `renderToolbox` now
computes `allowedTypes` before calling either filter-chip renderer, not after) and the
active source/library chips (`store.activeLibraries`) — deliberately NOT gated by
`store.activeElementGroups` itself: a group's own on/off toggle must never be the thing
that removes its own chip, or there'd be no way to turn it back on. New
`check_toolbox_group_filter_chips_hide_when_no_visible_elements`: with every source
active every group's chip shows; narrowing Source to "Other" leaves exactly the groups
with an 'o'-sourced element in the real shipped `custom.json` data (matching the
reported Application/Business example precisely) and drops the rest; and switching a
group's own chip off leaves it present, just no longer `.active` — proven via TEMP
BREAK.

Dragging a toolkit tile (`#elements-grid .el-tile`) onto the active canvas creates a
new part there (`App.dropNewPart`, `main.js`). Reported directly: *"drag from toolkit
to freeform canvas does not allow drop, mouse cursor stuck on hand symbol."* This used
to be native HTML5 drag-and-drop (`draggable=true` + `dragstart`/`dragover`/`drop`) —
the app's ONLY use of that mechanism; every other click-and-drag gesture in DyCAD
(node repositioning, connect-drag, panel/section resize handles, canvas lasso-select)
is a self-contained `pointerdown`/`pointermove`/`pointerup` sequence instead. Native
DnD's cursor feedback and drop delivery are notoriously OS/compositor-dependent (a
known failure mode on Linux/GTK-based browsers in particular — the reported symptom
matches exactly: the browser never transitions off the source element's own CSS
`cursor: grabbing` because no real drag session ever started, so no `drop` ever fires
either). Rather than chase a platform-specific native-DnD quirk, `wireToolboxTileDrag`
replaces the whole mechanism with the same pointer-event pattern already proven
everywhere else in the app:

- `pointerdown` on a tile starts tracking; nothing else happens until the pointer moves
  past a 3px threshold (same threshold convention as node-dragging's own `moved` flag,
  `canvas.js`) — so a plain click is inert, matching a `dragstart` never firing on a
  sub-threshold native drag.
- Past the threshold, `document.body.style.cursor` is forced to `'grabbing'` (restored
  to whatever it was on release) and a small floating `.toolbox-drag-ghost` (fixed
  position, `pointer-events:none`, the tile's own title as its text) is created and
  repositioned on every `pointermove` — replacing the drag image a native `dragstart`
  would otherwise supply.
- On `pointerup`, the release point is tested against `.page-view.active
  .canvas-scroll`'s own `getBoundingClientRect()` — outside those bounds (still over
  the toolbox panel, or any other UI) creates nothing, mirroring `dragover`'s old
  implicit "not a valid drop target" behavior. Inside them, the same
  scrollLeft/scrollTop/zoom math the old native `drop` handler used converts the
  release point to canvas-local coordinates and calls `app.dropNewPart(tab,
  el.type, x, y)` — `dropNewPart` itself is completely unchanged; only how its
  `x`/`y` arguments get produced changed.

New `check_toolbox_drag_to_canvas` (`tests/run_all.py`): a real drag (past threshold)
onto a fresh freeform view's canvas creates one new part near the drop point, with the
ghost/`grabbing` cursor both present mid-drag and cleared after release; a sub-3px
jitter shows no ghost and creates nothing; and a release that never leaves the toolbox
panel creates nothing either — the threshold guard and the out-of-bounds guard both
proven via TEMP BREAK (removing each independently reproduces its specific failure),
then reverted.

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

Four options layered onto the `'default'`/`'none'` Remap patterns only (force-directed
above and section-based views' fixed grid have no free row/column axis to bias, so all
four are silently ignored there — the Remap dialog hides their controls whenever
`pattern:'force'` is selected). `edgeAssignment: {elementType: 'top1'..'top5'|
'bottom1'..'bottom5'|'left1'..'left5'|'right1'..'right5'}` pulls every part of a given
type OUT of the normal stream/element-group grid before that grid is built, and instead
lays each edge's members out into one of 5 numbered slots — a single row (top/bottom) or
column (left/right) along that side of the whole layout — ordered within its own slot by
the same sort-priority keys as the main grid, so `connectionOrder` gives "natural flow"
within a slot too. Reported directly: *"for remap edge assignment (all applicable
patterns); change left to be left 1, and add left 2, left 3 etc to 5. likewise for other
edges. this directs placement to be first column or row, 2nd column or row etc. from
that specific edge. Add ability to specify 'blank', where nothing goes into that edge
column or row."*

Slot 1 always sits closest to that physical edge of the layout; slot 5 sits closest to
the middle grid. `parseEdgeAssignmentValue` parses a value like `'left3'` into `{edge:
'left', index: 3}` — a bare edge name with no digit (`'left'`, the pre-v0.899
convention still stored in every already-saved document/preset/`remapLastOptions`) is
treated as index 1, so nothing written before this feature existed changes behavior.
`edgeSlotLayout` (one call per edge) then decides which of the 5 slots are actually
**active**: any slot occupied by ≥1 part, UNION the new `edgeBlanks: {top|bottom|left|
right: [1-5, ...]}` option's explicitly forced-blank indices for that edge — sorted
ascending and mapped to compacted, 0-based physical positions. This is
auto-compaction-by-default: Left 1 + Left 3 assigned, Left 2 untouched, produces exactly
2 physical columns with NO gap between them (Left 3's occupants sit immediately next to
Left 1's) — UNLESS `edgeBlanks: {left: [2]}` explicitly reserves Left 2 as a permanently
empty spacer column, in which case Left 3 lands a full extra step further out. A
forced-blank slot still contributes to that edge's total depth (and therefore to how far
the middle grid gets shifted, and to every OTHER active slot's own spacing) despite
never actually holding any part. The middle grid is computed first (completely
unmodified, existing code), then shifted right/down by `leftDepth`/`topDepth` steps (the
COUNT of that edge's active slots, not a fixed 1) to make room, then each slot is placed
relative to the middle grid's own resulting bounding box — slot *n*'s physical position
directly determines its row/column offset from either the true edge (top/left) or the
middle grid's own far side (bottom/right, which never needs to shift the grid itself,
exactly as before).

**Bottom/Right must also account for Left/Right/Top/Bottom's own reach, not just the
middle grid.** Reported directly: *"when calculating bottom row or right column, the
bottom row or right column to use is not including the rows or columns created due to
remap layout. Currently when 15 nodes are placed in first column which results in 15
rows, the 'last row' calculation uses just remaining nodes and is lower, so placement
on 'last row' or last row 2 etc. are not actually on the last rows."* Every left/right
slot starts at `middleMinY` and grows DOWNWARD one row per member (`middleMinY +
i*stepY`); every top/bottom slot starts at `middleMinX` and grows RIGHTWARD one column
per member (`middleMinX + i*stepX`) — so a left or right band with more members than
the middle grid has ROWS reaches past `middleMaxY`, and a top or bottom band with more
members than the middle grid has COLUMNS reaches past `middleMaxX`, entirely
independent of the middle grid's own size. Bottom's own starting Y (previously always
`middleMaxY`) and Right's own starting X (previously always `middleMaxX`) didn't know
this — a tall left/right band, or a wide top/bottom band, could silently overlap the
Bottom/Right band instead of sitting genuinely beyond it. Fixed by computing, right
after the four `orderedSlotsFor` calls (so every slot's own member COUNT is already
known) but before any position is assigned: `maxLeftOrRightCount` = the largest member
count across every active left OR right slot, and `maxTopOrBottomCount` = the same
across every active top OR bottom slot. `bottomBaseY` becomes `Math.max(middleMaxY,
middleMinY + (maxLeftOrRightCount - 1) * stepY)` (only when a left/right band actually
exists), and `rightBaseX` the symmetric `Math.max(middleMaxX, middleMinX +
(maxTopOrBottomCount - 1) * stepX)` — replacing the old bare `middleMaxY`/`middleMaxX`
in the Bottom/Right `.forEach` placement lines only. Top and Left are unaffected by
this bug and need no equivalent fix: both anchor at the NEAR edge (`rowBaseY`/`baseX`,
or `middleMinX`/`middleMinY`), which every band's own `i*step` growth only ever moves
AWAY from (larger i), never past. Verified via TEMP BREAK on two separate details: (1)
reverting `bottomBaseY`/`rightBaseX` back to the bare `middleMaxY`/`middleMaxX`
reproduces the exact reported symptom (a 15-member Left 1 band vs. a 2-node middle
grid — Bottom lands barely past the tiny middle grid, deep inside the Left band's own
lower rows); (2) computing `maxLeftOrRightCount` as the SUM of every left/right slot's
member count instead of their `Math.max` still "fixes" the reported symptom (any
extra distance downward still clears the middle grid) but overshoots past the true
deepest slot whenever 2+ slots are populated at different depths — caught only by an
exact-equality assertion (`bottomY === trueMaxY + stepY`), not the weaker "moved
somewhere lower" check the other scenarios use.

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

**Node occlusion** (a fourth fix to `minimizeRowCrossings`, direct follow-up to the
three above): reported directly — *"smart stream example from script console is
directly placing nodes over connectors instead of resizing to fit properly after
remap. why? what remap settings are needed to avoid this?"*, then *"yes, treat it as a
real penalty in the scoring."* Diagnosed against the REAL `generateIndustry` →
`insertSmartStream` → `smartCheckView` → remap pipeline (the synthetic fixture (2)
above already scores its own interleaved order best on crossings alone, so it never
exposed this): the crossings-first scoring could lock in a column order — Process,
Process, Capability, Capability — that's genuinely BETTER on cross-row crossings than
the interleaved alternative, so the LENGTH tie-break from fix (2) above never even got
a chance to run; the same-row Capability→Process connector then drew a straight line
directly through the OTHER pair's Process node sitting between them. No existing Remap
setting (Minimize Crossings, Minimize Connector Length, Edge Assignment, Spacing Scale)
avoided this — a genuine scoring gap, not a missing checkbox: neither `crossings`
(only ever counted between ADJACENT-row edge pairs) nor `length` modeled "does this
same-row edge's straight path pass over an unrelated third node" at all. Fixed by
adding a new `occlusions` criterion — for every same-row edge, how many other row
members sit strictly between its two endpoint columns — checked FIRST, ahead of
crossings, in both the local swap heuristic (`transposeAll`, via a brute-force
before/after `rowOcclusionCount` recompute — cheap at realistic row sizes, simpler than
deriving a closed-form delta) and the final best-of-all-iterations comparison
(`isBetter`): a node sitting directly on a connector it has nothing to do with is a
worse visual defect than a diagonal crossing, so a real crossing increase is worth
accepting to eliminate one. New `check_remap_layered_avoids_node_occlusion`
(`tests/run_all.py`) runs the real pipeline (not a hand-built fixture) and checks
EVERY connector's straight-line path against EVERY other node's bounding box for
genuine geometric intersection — proven via TEMP BREAK to reproduce all 4 real
overlaps before this criterion existed, then reverted.

**Latent limitation, surfaced then no longer triggered (Step 40)**: `transposeAll`'s
local, adjacent-columns-only swap heuristic doesn't reliably reach zero occlusions once
several same-row Function/Process pairs land on one row at once (as opposed to the 1–2
pairs the fix above was built and tested against) — briefly confirmed via
`check_remap_layered_avoids_node_occlusion`'s own real pipeline once §7.3's Business
Organization Unit `'s'` connector legitimately pulled ~7 such pairs onto one row: 200+
occlusions, not the isolated handful the original fix targeted. That specific trigger
was a SEPARATE bug (`insertSmartStream` fanning out through the OrgUnit into unrelated
sibling Functions — see its own stream-continuity gate, §5.5), now fixed, so the real
pipeline is back to its original small scope and this heuristic gap isn't currently
exercised by anything shipped. The underlying weakness is still real and unaddressed,
though — architectural, not a tuning issue: a same-row pair can only ever be GUARANTEED
occlusion-free by staying column-adjacent, but a one-step-at-a-time local swap search
can get stuck short of that arrangement once multiple pairs compete for the same row.
Not yet fixed — the leading candidate is treating each same-row pair as one merged unit
during ordering (guaranteeing adjacency by construction) and expanding it into its real
two columns afterward, rather than further heuristic tuning.

**Align by section** (`alignBySection`, default `true`, `commands.js`): reported
directly — *"add option default enabled to align columns or rows by section, or to
cluster by section. For example if business organization unit 'continuous improvement
functions' is on first row, then function 'continuous improvement functions' matches
section so should have priority for being below (or nearby for clusters) (if edges
configured as such)."* For the grid patterns (`'default'`/`'none'`/`'layered'`), a new
`alignRowsBySection` function runs as its own pass, right after `minimizeRowCrossings`
(if that ran) and before `minimizeConnectorLengthPass`: for every REAL connector
between ADJACENT rows whose two endpoints share the same non-blank `part.section`
("if edges configured as such" — matching section alone with no connector between the
two parts never creates a pull), it repeatedly swaps adjacent same-row columns,
bubble-sort style, to bring a misaligned same-section pair into the same column —
"priority for being below."

This is deliberately a *separate* pass rather than a new criterion folded into
`minimizeRowCrossings`'s own barycenter+transpose search (an earlier version tried
exactly that, ranking a new `sectionMisalignment` score between `occlusions` and
`crossings`). Real-data regression testing on the actual `generateIndustry` →
`insertSmartStream` → `smartCheckView` → remap pipeline (`check_remap_layered_avoids_
node_occlusion`) found two separate problems with interleaving: (1) letting section
swaps interleave with the crossing-minimization search's own swap sequence changed
which local optimum it converged to, at one point *reintroducing* the exact
node-on-connector occlusion the previous fix eliminated, even though each individual
section swap's own local delta check never allowed occlusion to get worse — a step's
opportunity cost on *later* steps isn't visible to a per-swap delta; (2) folding
`alignBySection` into the same gate that triggers `minimizeRowCrossings` at all
(`if (minimizeCrossings || alignBySection)`) made the pass's general-purpose barycenter
sort run even when the user explicitly left `minimizeCrossings` off (`alignBySection`
defaults **on**), silently reordering rows they'd asked to leave alone
(`check_remap_edge_assignment_and_layout_optimization`). Splitting into its own pass —
run unconditionally when `alignBySection` is on, entirely independent of
`minimizeCrossings` — fixed both: `minimizeRowCrossings` itself is now byte-for-byte
identical to before this feature existed (so its own tuned behavior and regression
tests are untouched), and `alignRowsBySection`'s own per-swap guard rejects any swap
that would increase *same-row* occlusion (the same `rowOcclusionCount` concept
`minimizeRowCrossings` uses).

Same-row occlusion isn't the whole story, though: a diagonal INTER-row connector can
still drift through an unrelated node's box as a side effect of column reordering, a
defect no same-row check can see — found on a real dataset where nearly every node
shared one section (maximal section-alignment pressure). An early version tried
modeling this as a global **all-or-nothing safety net**: compare real geometric
occlusion (the same segment-vs-rect check `check_remap_layered_avoids_node_occlusion`
itself uses) before/after the whole pass, discarding the entire pass if worse. That
regressed on a large, real Edge Assignment band (see below) — a handful of unavoidable
side effects caused the WHOLE pass, including every genuinely correct alignment, to be
thrown away. `alignRowsBySection`'s per-swap guard now checks this same real geometry
directly (not the same-row proxy, and not a final aggregate gate) for every individual
candidate swap, so only the specific change that would itself increase occlusion is
rejected — everything else the pass could safely achieve still lands.

**Edge Assignment bands** — direct follow-up bug report against the above: *"didn't
fix problem. reproduce problem by running console script, generate inventory view.
remap with business organization unit on top 1 and business function on top 2, the
nodes are not aligned by section nor by connector priority."* Root cause:
`alignRowsBySection` only ever ran against the middle grid (`allMiddleVms`) — when an
Edge Assignment pins BOTH a section's Organization Unit and its Function to different
numbered slots on the SAME edge, neither reaches `allMiddleVms` at all, so "Align by
section" silently never applied there. Fixed by generalizing `alignRowsBySection` with
an `axis` parameter (`'x'` for top/bottom bands, whose members sit side by side; `'y'`
for left/right, which stack vertically) and calling it a second time, once per edge,
directly on each edge's own stacked slot arrays (`topSlots`/`bottomSlots`/`leftSlots`/
`rightSlots`) — adjacent slots on one edge are structurally identical to adjacent
middle-grid rows.

Real-data testing against the actual `generateIndustry`/`generateInventoryView`
pipeline this was reported against exposed two more, deeper bugs fixed alongside this
one:

1. `sectionDelta`'s original swap-acceptance rule was a BINARY aligned/misaligned flag,
   which can only ever show an improvement on the exact swap that lands a pair in the
   same column — a pair starting more than one column apart (routine on a real edge
   holding dozens of parts) could never take even one step toward each other. Fixed by
   switching to a continuous column-DISTANCE delta (matching `lengthDeltaOf`'s own
   established pattern), plus a new barycenter-style SORT phase each iteration (the
   same two-phase shape `minimizeRowCrossings` already uses) so a vm can move any
   distance in one step instead of walking there one adjacent swap at a time — real-data
   testing found the swap-only version could get blocked indefinitely on a dense,
   contested row.
2. Minimize Connector Length, when also on, independently repositions each band/row
   member toward the barycenter of ALL its real connections. Since `part.section`
   propagates to an entire generated chain (every Capability/Process/Entity spawned
   from one Function, not just its own reified Organization Unit), a Function can have
   several real, same-section neighbors — so even a section-aware average still
   diluted the position away from the one specific adjacent-band pairing "Align by
   section" targets. Fixed with a new shared helper, `sectionPriorityPartners`
   (`commands.js`) — the same adjacent-row/band, same-section connector scan
   `alignRowsBySection` itself uses, returning `Map<vmId, Set<partnerVmId>>` — consulted
   by both `minimizeConnectorLengthPass` (middle grid) and `alignBand` (Edge Assignment
   bands): an UNAMBIGUOUS (mutual 1:1) partner exclusively decides "desired" position,
   skipping the plain average entirely, but only when neither side is shared with a
   third row member. An org with several functions instead falls back to the ordinary
   average — forcing every one of them toward the exact same desired x would create a
   hard multi-way tie that `resolveSpacedPositions`' single-chain forward/backward
   spacing sweep can only resolve by cascading a large compromise through the *entire*
   row, dragging even unrelated, otherwise-perfectly-alignable pairs out of position.

New `check_remap_align_by_section_edge_bands` (`tests/run_all.py`) exercises two
adversarially-named 1:1 Organization-Unit/Function pairs (proving both the ordering fix
and the binary-vs-distance fix) on a `top1`/`top2` Edge Assignment (the exact reported
shape) and, separately, a `left1`/`left2` one, with Minimize Crossings and Minimize
Connector Length both on (the report's own scenario always has both) — each function
also carries a real connector to an unrelated middle-grid Capability, exercising the
`sectionPriorityPartners` fix specifically. Both new fixes were proven via TEMP BREAK
(reverting the edge-band `alignRowsBySection` calls, and separately reverting
`alignBand`'s priority-partner lookup, each confirmed to make this test fail), then
reverted. A known, accepted limitation: on a SEVERELY oversubscribed section (many
Functions sharing one Organization Unit, an inherent many-to-one imbalance no algorithm
can perfectly satisfy — verified separately against the real, unmodified industry-data
pipeline) Minimize Connector Length's spacing cascade can still leave some otherwise-
clean pairs elsewhere in the same crowded band imperfectly positioned; the reported
scenario itself (and the overwhelmingly common real-world shape) is the ordinary,
non-oversubscribed case this fix handles correctly.

For the `'clusters'` pattern specifically ("nearby for clusters" in the report) —
structurally different from the grid patterns, since `packClustersOnGrid`'s clusters
are hub-and-spoke decompositions of one connected component (`computeHubClusterDecomp
osition`) rather than the disjoint connected components `'force'` clusters into (see
§6.1c) — `sectionPackingBonusEdges` filters `edgesForLayout` down to pairs whose
endpoints share a non-blank matching section, and this extra edge list is passed
alongside the real edges into `packClustersOnGrid`'s existing bridge-weight packing
logic (from the connectivity-aware packing feature, below) as `packingBonusEdges`: a
purely additive nudge to which already-connected cluster gets placed shelf-adjacent
first, never real graph structure. `'force'` is deliberately excluded — its clusters
*are* connected components, and by definition two different connected components never
share a real edge, so a same-section boost keyed on "an already-existing edge" is a
permanent structural no-op there; the Remap dialog hides the "Align by section"
checkbox for `'force'`/`'custom'` accordingly (relabeling it "Cluster by section" for
`'clusters'`).

**Dialog-length follow-up (UI only, no algorithm change)**: reported directly — *"on
the remap dialog form, it is too long. Can you remove the 'Align by sector' related
text that starts with 'On by default' and show it as a tool tip or some other approach
that removes it from the form and shows only when user requests."* The explanatory
paragraph above the checkbox (`#rm-align-section-note`) was shown for every pattern
except `'force'`/`'custom'` — i.e. present on the dialog most of the time, unlike the
OTHER pattern-specific notes in this same dialog (force/clusters/custom), which stay
hidden unless that one specific pattern is actually picked. Removed the element
entirely and moved its full original text, verbatim, onto a plain `title` attribute on
`#rm-align-section-row` (the checkbox+label row itself) — a native hover tooltip,
shown only on request, using the same bare `title=` convention already used elsewhere
in this same dialog (the row-reorder ▲/▼ buttons) and across the app generally (e.g.
the toolbar's Highlight/Connector Type filter buttons) — no new tooltip component
needed. New `check_remap_align_section_explanation_is_tooltip` (`tests/run_all.py`):
the note element is gone from the DOM; the row's `title` holds the full original text;
the dialog's own always-visible text no longer includes it — proven via TEMP BREAK.

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
menu — any other dialog's submit button could adopt the same helper the same way (Load
SFCCE's own mapping dialog and, direct follow-up, Smart Check View's Check button both
do — `collectSmartCheckViewOptions` in `promptSmartCheckView`, main.js, shared by both
the right-click handler and the real submit handler so they can never drift out of
sync, matching exactly the fields `smartCheckView(app, tab, {...})` itself takes and
deliberately excluding the dialog's separate Auto-complete streams fields, which
trigger a different action entirely).

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

### 6.1c The `'clusters'` Remap pattern — "Centralize in Clusters" (`layout.js`, `commands.js`)

A fifth pattern, reported directly: *"need a better remap for erd that puts popular
nodes central to single children around them, repeat this pattern in clusters. perhaps
a 'centralize in clusters' option that could work on any view."* §6.1's `'force'`
pattern already centers the single highest-degree node — but only ONCE per connected
component (Union-Find), and a real ERD schema is often one giant connected component
end to end (everything FKs to everything transitively), so `'force'` gives exactly one
hub for the whole diagram. `'clusters'` decomposes a component into SEVERAL
hub-and-leaves stars instead, tiling the results together the same way `'force'` tiles
separate components — reusing `packClustersOnGrid`, since a hub-cluster here and a
connected-component cluster there are the same `{grid, minCol, maxCol, minRow, maxRow}`
shape as far as shelf-packing cares (that function itself gained new connectivity-aware
behavior for this pattern specifically — see below).

`computeHubClusterDecomposition(nodeIds, edges)` (`layout.js`) is pure graph logic (no
coordinates), exported separately from the pixel-producing pipeline so it's directly
unit-testable. A node's **primary hub** is whichever neighbor has STRICTLY higher
degree than the node's own (ties among equally-connected neighbors broken by the
input's own node order, for determinism) — a node with no such neighbor (a local
degree maximum, or isolated) has no primary hub and must become a hub itself. Every
node with degree ≥ 2 is a hub CANDIDATE, processed highest-degree-first: a candidate
becomes a real hub unless it was already claimed as some earlier (bigger-or-equal-
degree) hub's ring member, then absorbs every still-unclaimed node whose primary hub
it is. This directly implements "popular nodes central, single children around them"
for true leaves (degree 1, whose only neighbor IS their primary hub by construction)
while ALSO pulling in a lower-degree NON-leaf if its one clearly-more-connected
neighbor outranks it (the specific design choice made for this feature over "only
literal leaves cluster") — a degree-2 node straddling two hubs of EQUAL standing (no
neighbor outranks the other) becomes its own hub instead of arbitrarily picking a
side, so two equally-popular hubs connected to each other stay two separate clusters,
bridged by that one edge, rather than merging into one. Absorption is NOT transitive —
a node absorbed into a hub's ring doesn't pull ITS OWN further neighbors in too; those
become bridge edges into other clusters, exactly like a ring member's other edges. Any
node still unclaimed after the hub-candidate pass (an isolated node, or an isolated
pair/chain where no node ever reaches degree 2) becomes its own small hub, absorbing
whatever of its own neighbors are still unclaimed — so every node ends up placed in
EXACTLY one cluster.

`computeHubClusterGridLayout(nodes, edges, options)` places each star's ring in the 8
cells around its hub (expanding outward past 8, same crowded-hub fallback as `'force'`)
then shelf-packs the stars — mirroring `computeClusteredGridLayout`'s own shape with
`computeHubClusterDecomposition` + a one-level ring placement standing in for
`findConnectedComponents` + `computeAdjacentGridLayout`. The actual 8-neighbor/
expanding-ring placement mechanic (`makeRingPlacer`) was factored out of
`computeAdjacentGridLayout` into a function BOTH layouts now share — not a speculative
abstraction, a real second caller needing byte-identical behavior, so the two
placement strategies can never silently drift apart. Same honest limitation as
`'force'`'s own cycle edges, reached by a different route: a bridge edge (hub-to-hub,
or a ring member's OTHER connection to a different hub) isn't guaranteed adjacent
cells — inherent to any 2D grid embedding, not an implementation gap.

**Reducing (not eliminating) that bridge-edge problem** — a direct follow-up report:
*"is it possible to add the existing 'minimize connector crossing' or something
similar, to avoid placing nodes directly on unrelated connectors after 'centralize in
clusters' is applied?"* The existing `minimizeCrossings`/`minimizeConnectorLength`
options (§6.1a) are Sugiyama row-reordering passes with no meaning on a 2D grid-packed
cluster layout, so this needed two genuinely new, `'clusters'`-specific mechanisms
instead — both always-on (no new dialog checkbox; this fixes an intrinsic layout
defect, not a stylistic preference):
- **`packClustersOnGrid` is now connectivity-aware** (still shared with `'force'`,
  still exported unchanged in signature terms — `edges` is a new, optional third
  argument). Root cause: the function used to order clusters purely by area, with zero
  awareness of which clusters are bridge-connected — so a bridge-connected pair could
  easily land on opposite ends of the shelf-packed sequence with an unrelated cluster
  between them, forcing that bridge's straight line to stretch across (and often
  visually through) unrelated territory. Fixed packing order: the largest cluster
  first (unchanged default), then greedily, whichever NOT-YET-PLACED cluster shares
  the most bridge edges with whatever's ALREADY placed goes next (tie-broken by area)
  — so bridge-connected clusters end up shelf-adjacent, or close to it, instead of
  scattered by size alone. For `'force'` (whole connected COMPONENTS as clusters — no
  edge ever crosses between two components, by definition), this is a proven no-op:
  zero cross-cluster weight ever exists there, so packing falls straight back to the
  original pure-area order, unchanged.
- **`avoidNodeOnConnectorOverlap`** (`layout.js`, new, exported) is a best-effort
  cleanup pass run after packing: for every edge, checks whether its straight-line
  path (center to center) passes through any OTHER node's rectangle (small pixel
  padding included, so a near-miss still counts), and if so, relocates that node.
  Deliberately conservative about what it's allowed to move, so it can never undo any
  of `computeHubClusterGridLayout`'s own placement guarantees: only a RING MEMBER is
  ever eligible (never a hub — moving a hub would cascade and disturb its entire ring),
  and only to a still-free cell among its OWN hub's 8 immediate neighbor cells (never
  farther) — so a relocated node is always exactly as hub-adjacent afterward as
  before, just possibly a different one of the (up to) 8 equally-valid slots. A
  bystander with no free alternative slot, or a hub itself sitting in an unrelated
  edge's path, is left exactly where it was — a heuristic, not a guaranteed-collision-
  free solver, the same honest-limitation category as `'force'`'s own unplaceable
  cycle edges. Runs up to 3 full scans (relocating one node can occasionally free up,
  or create, a different collision elsewhere), stopping as soon as a scan moves
  nothing — same bounded-passes convention `resolveResidualOverlaps` (§6.1) already
  uses. Segment-vs-rectangle intersection (`segmentIntersectsRect`/`segmentsIntersect`/
  `cross2D`) is plain, self-contained 2D geometry — no external library, consistent
  with this project's no-npm-packages constraint.

`applyRemapLayout`'s `pattern === 'clusters'` branch (`commands.js`) mirrors `'force'`'s
own branch exactly (same `stepX`/`stepY` convention, same early return before Edge
Assignment/`minimizeCrossings`/`minimizeConnectorLength`, none of which have meaning
here either) and reuses `'force'`'s own `forcePreferRight` option for the ring's own
placement bias — but NOT `forceGroupRows`, since a hub's ring is always exactly one
level deep, so BFS-depth-based row grouping has nothing to apply to. The Remap dialog
(`main.js`'s `promptRemap`) gained a `<option value="clusters">centralize in
clusters</option>`, its own explanatory note (`#rm-clusters-note`, parallel to
`#rm-force-note`), and a shared `REMAP_PATTERNS` module-level constant (`['default',
'none', 'layered', 'force', 'clusters']`) so the dialog's default-pattern resolution
and preset-load guard can never drift out of sync with which patterns actually exist.

### 6.1d Scoping Remap and Spacing to the current selection

Two related requests, reported together: *"Update remap (any view) with a new
checkbox 'selected' to apply remaping only to selected items and related connectors;
valid for any pattern selected. If multiple nodes selected, apply 'Spacing' command
increase or decrease only to selected nodes and update their x,y without changing
view spacing value."*

**Remap's "Only remap selected nodes and their connectors"** (`#rm-selected-only`,
`promptRemap`) is a sibling checkbox to the pre-existing "Only remap filtered nodes"
(`filteredOnly`) — and deliberately reuses that SAME `visiblePartVmIds` parameter
`applyRemapLayout` already threads uniformly through every pattern branch (default/
none/layered/force/clusters all independently filter `partVms` down to this set
before doing anything else, and a part NOT in the set simply keeps its current x/y
completely untouched — see §6.1's `force` branch and §6.1c's `clusters` branch for two
concrete examples of the identical mechanism). This is why "valid for any pattern" was
free: no pattern-specific code was needed, only the SET fed into the existing
parameter needed to also be able to come from the current selection instead of only
the active Stream/Type filter. The submit handler computes the selected part
viewMember ids the same way `copyNodes` already does (`[...tab.selection].filter(id =>
findViewMember(id)?.objectType === 'part')`), then INTERSECTS it with whatever
`filteredOnly` already produced if both checkboxes are checked (a part must pass the
filter AND be selected) rather than one silently overriding the other. Silently a
no-op with nothing selected, the same "no filter active" precedent `filteredOnly`
already set. Not extended to section-based views' own dialog-free quick-Remap path
(`promptRemap`'s early return when `isSectionViewType`) — that path has no options at
all today, "pattern" doesn't apply there in the first place (fixed grid/section-placer
logic, not one of the five row/grid patterns), and the request's own "valid for any
pattern selected" phrasing is specifically about the pattern-having dialog.

**Spacing +/- scoped to a 2+-node selection** (`js/canvas.js`'s `buildZoomControls`)
is a DIFFERENT mechanism from the whole-view case, not a scoped call to the same
function — `state.js`'s existing `applySpacingScale(viewId, newScale)` always writes
`view.spacingScale`, by contract, so it couldn't be reused for "without changing view
spacing value" no matter how it was scoped. New `applySpacingRatioToVms(vmIds, ratio)`
(`state.js`) is a standalone sibling: same centroid-then-scale-then-shift-if-negative
math as `applySpacingScale` (compute every node's new position around the group's OWN
centroid first, allowing negative values, THEN shift the whole affected group by one
uniform translation if anything went negative — never clamp a node individually,
which would visibly compress its gap to whichever neighbor happens to sit nearest the
edge), but computed over just the given viewMembers' own centroid and NEVER touching
`view.spacingScale` at all. Since there's no persisted "current selection scale" the
way `view.spacingScale` persists for the whole-view case, there's nothing to compute
an old-vs-new RATIO from between calls — each click is instead a flat multiplicative
step (`SELECTION_SPACING_STEP_RATIO = 1.2`, chosen to feel comparable to the whole-
view stepper's own +0.2/-0.2 off a base of 1) applied directly to whatever the current
positions already are, compounding naturally across repeated clicks the same way any
other +/- stepper does. `buildZoomControls`'s `.spacing-in`/`.spacing-out` handlers
branch on `ciEq(view.viewType, 'ff') && selectedVmIds.length >= 2`: true routes to the
new selection-scoped path (plus a toast naming how many nodes were affected); false
(fewer than 2 selected, OR a section-based view, whose node positions come from live
row/col grid math driven by `spacingScale` itself rather than independent x/y a subset
could sensibly be pulled apart from) falls through completely unchanged to the
original whole-view `applySpacingScale` call.

**Follow-up: anchoring a restricted remap at its own original position.** Reported
directly: *"remap selected places nodes over top existing. Can the results be placed
starting in selected x,y?"* Every pattern above computes fresh positions from the
view's own FIXED origin (`baseX`/`rowBaseY` for default/none/layered, `marginX`/
`marginY` for force/clusters) — correct for a whole-view remap, but for a restricted
subset (`visiblePartVmIds` set, whether via "Only remap filtered nodes" or "Only remap
selected nodes and their connectors") that just lands the freshly-computed result
directly on top of wherever OTHER, un-remapped content already happens to sit near
that same origin. Fixed with a new `shiftToOriginalPosition(vms, originalPositions)`
(`commands.js`), called right before each of `applyRemapLayout`'s three return points
(the `force` branch, the `clusters` branch, and the default/none/layered/Edge-
Assignment path's own final return) whenever `visiblePartVmIds` was actually set: a
snapshot of `partVms`' own x/y is taken BEFORE any pattern mutates them, then after
the pattern computes its (origin-relative) result, the WHOLE restricted group is
translated by one uniform offset so its own new top-left corner lands exactly where
the group's own top-left corner was BEFORE this remap ran — never a per-node
adjustment, which would distort the relative layout the pattern just computed. A
no-op (and thus a no-behavior-change) for an unrestricted whole-view remap
(`visiblePartVmIds: null`), and not extended to section-based views (`
applyRemapLayoutSectioned` returns earlier, before this snapshot/shift logic runs at
all — a section's node positions come from its own fixed grid cell, not a free origin
this fix could meaningfully anchor).

**Follow-up: Spacing direction (horizontal/vertical/both).** Reported directly:
*"Update spacing for vertical, horizontal, or both, when used with selected nodes;
perhaps change existing <-> symbol to be toggle between vertical, horizonal, and
both."* The static `↔` that used to sit inside `.spacing-pct`'s own text is now a
separate, clickable `.spacing-axis-toggle` button, cycling `view.spacingAxis`
(`'both'` → `'horizontal'` → `'vertical'` → `'both'`, `SPACING_AXIS_CYCLE` in
`canvas.js`) through three icons (`SPACING_AXIS_ICONS`: `'↔↕'`/`'↔'`/`'↕'` — "both"
deliberately shown as the two individual glyphs concatenated rather than inventing a
new combined-arrow character, guaranteed to render identically everywhere the two
individual glyphs already do). Persisted on `view.spacingAxis` — a view-level display
setting, the same precedent `view.spacingScale` itself already set, including its own
`showFields.view` entry (`custom.json`, `show:'s'`, options wired into `render.js`'s
`selectOptionsFor`) so it's ALSO reachable from the property panel, not just the
toolbar toggle. `applySpacingRatioToVms` (`state.js`) gained a third `axis` parameter
(default `'both'`, backward compatible with every existing caller): implemented by
substituting `1` (a no-op ratio) for whichever axis isn't selected, rather than a
separate code path per axis, so the shared negative-position guard still runs
identically regardless of which axis (or both) actually moved. Deliberately scoped to
ONLY the 2+-node-selected path, per the report's own "when used with selected nodes"
— the whole-view fallback (fewer than 2 selected) still always scales both x and y via
the single `spacingScale` value, which has no separate per-axis concept to select
between; the toggle button is still visible and clickable regardless, it simply has no
effect on that fallback path.

### 6.1e The `'custom'` Remap pattern — user-designed layout logic (`commands.js`, `state.js`)

A short design back-and-forth, reported directly: *"is it possible to build a small
framework for user designed remap logic, something that can be loaded in and stored in
user local settings perhaps. What types of parameter options can be added beyond what
is already there?"* → (design discussion, not yet built) → *"can there be an option to
use grid coordinates based on rows and columns and spacers between, as an alternate to
the x,y canvas coordinates?"* → (design discussion: as a convenience layer resolved at
remap time, never persisted as a grid) → *"yes go with the convenience layer at remap
time. please build it."*

**Storage: no new field at all.** Rather than a new Local Settings field/editor, a
user-designed remap function is just a function named `CustomRemap_<Name>(ctx)` written
directly in the Script Console's own text (`store.batchScriptCode`) — the exact same
persistence, editing surface, and "found by name" mechanism `main()`'s own
`BatchScript_<Name>` chain, `dataAutoFill()`, and `CommonScript_<Name>` (§8) already
established. This is the FOURTH such convention that text now hosts; `state.js`'s own
top-of-file doc comment documents all four together. `findCustomRemapFunctionNames(code)`
(`main.js`) is a pure regex scan (`/function\s+(CustomRemap_\w+)\s*\(/g`, deliberately
NOT a `new Function` compile, so it's safe to call on every dialog open even against
code that doesn't currently parse) populating a new "Custom Function" dropdown that
appears in the Remap dialog (`App.promptRemap`) once `'custom'` is selected as the
Pattern — a sixth `REMAP_PATTERNS` entry alongside `default`/`none`/`layered`/`force`/
`clusters`. Selecting it hides Sort priority/Edge Assignment/Minimize Crossings/Minimize
Connector Length, the same "the function owns placement completely" treatment `force`/
`clusters` already get (§6.1, §6.1c) — extended from a two-way `isForceOrClusters` flag
to a three-way `ownsPlacementItself`. `customFunctionName` round-trips through every
existing per-view/cross-view memory path exactly like every other Remap field already
does: `view.remapLastOptions`, the cross-view `getCachedRemapOptions` cache, and
`remapPresets` entries (Save As.../Load).

**Shipped preset defaults** (`DEFAULT_REMAP_PRESETS`, `state.js`): reported directly,
with the exact field values to ship — two named presets, `"FocusedStreamDefault"` and
`"BUtoData"`, both full Edge Assignment layouts against the `"Enterprise"` template
with `pattern: 'layered'`. `remapPresets` used to ship empty (deliberately — "nothing
analogous to 'Production' was asked for here," unlike `DEFAULT_SMART_STREAM_PRESETS`'s
own seeded `"StreamSet1"`); these are the first real examples. `"FocusedStreamDefault"`
deliberately OMITS `alignBySection` entirely rather than setting it explicitly — not an
oversight, but the genuine reported shape, relying on the SAME "absent field defaults
to checked/true on Load" convention `check_remap_align_by_section_dialog_wiring`
already covers for a preset saved before that option existed; `"BUtoData"` carries
`alignBySection: true` explicitly. Both point `customFunctionName` at
`CustomRemap_Example` even though `pattern` is `'layered'`, not `'custom'` — harmless,
reflecting nothing more than whatever the Custom Function dropdown happened to hold
when the preset was originally saved (`#rm-preset-save`'s own handler always captures
it, regardless of the currently-selected pattern). New
`check_remap_presets_shipped_defaults` (`tests/run_all.py`): both preset names present
by default and reachable from the real dialog's own `#rm-preset-select`; the
`alignBySection` presence/absence preserved exactly as reported; loading `"BUtoData"`
populates Template/Pattern/Align by section correctly; and — proving the data is
genuinely functional Remap configuration, not just well-formed JSON — a real `remap()`
call using EACH preset's full option set, against real parts covering every type in
that preset's own `edgeAssignment`, runs with no error — the preset-name and
`alignBySection` assertions both proven via TEMP BREAK.

**`applyRemapLayout`'s `'custom'` branch** (`commands.js`) sits right after `'clusters'`,
in the same early-return group (before Edge Assignment/passive-row splitting, which
`'custom'` — like `'force'`/`'clusters'` — has no use for): extracts the named function
via `new Function('ctx', store.batchScriptCode + '\n' + 'return typeof ' + name + " ===
'function' ? " + name + ' : null;')()` (the same extraction shape `dataAutoFill`/`main`
already use), builds a `ctx` from the CURRENT `partVms`/`connVms` for this remap
(already scoped by `visiblePartVmIds`, same as every other pattern), calls it, and
applies whatever it returns. Every failure mode along the way — no function name given,
the name not found, a Script Console syntax error, the function itself throwing, or a
non-array return — THROWS a specific `Error` rather than returning `null` (every other
pattern's failure convention); `remap()` (also `commands.js`) now wraps its
`applyRemapLayout` call in try/catch specifically to turn one of these into a real
`"Remap failed: <message>"` toast instead of an uncaught exception, while every
pre-existing `null`-return failure mode (no stream templates available) is completely
unaffected.

**`ctx` contract**: `{ parts: [{vmId, partId, type, label, model, x, y}, ...],
connectors: [{fromVmId, toVmId, relationship, connectorType, streams}, ...], nodeSize:
{w, h}, spacingScale, gridToXY(row, col), setRowGap(afterRow, extraPx),
setColGap(afterCol, extraPx) }`. A returned position may be `{vmId, x, y}` (explicit
pixels) or `{vmId, row, col}` (resolved via `gridToXY`) — freely mixed in one array — and
a `vmId` never mentioned keeps its current position untouched. **The grid-coordinate
convenience layer is `makeGridResolver(baseX, rowBaseY, stepX, stepY)`** (`commands.js`,
shared only by the `'custom'` branch): the exact same `baseX + col*stepX`/`rowBaseY +
row*stepY` math every OTHER pattern already computes internally, just exposed directly
so a script can think in row/column terms instead of hand-computing canvas pixels — and,
critically, a PURE convenience layer: grid coordinates are resolved to plain x/y right
here and nowhere else in the app (viewMembers, rendering, overlap-avoidance, Save/Load
JSON) ever knows a grid was involved. `setRowGap`/`setColGap` add EXTRA space after a
specific row/column index, on top of the uniform per-cell step — answering "spacers
between" directly: a sparse map (`afterIndex -> extraPx`, last call for the same index
wins) applied to every row/column strictly PAST that index (`after < idx`, not `<=` —
the gap point itself is unaffected, only what comes after it shifts), letting a script
visually separate sub-bands within one grid without needing genuinely disconnected
components or a separate Edge Assignment band. Row/column indices may be fractional
(e.g. row `1.5`) to nest a position between two grid rows without disturbing either —
ordinary floating-point arithmetic, no special casing needed.

**`CustomRemap_Example(ctx)`** (`state.js`, shipped default, not called from `main()`)
demonstrates the convenience layer end to end: groups parts onto one row per element
TYPE (alphabetically), columns within each row sorted by label, using `{row, col}`
directly with no pixel arithmetic anywhere in the function body, plus a
`ctx.setRowGap(0, 30)` call adding breathing room below the first row.

New `check_custom_remap_grid_convenience_layer` (grid resolution, gap boundary
semantics, mixed x/y and row/col entries, all four failure modes, `remap()`'s
catch-and-toast — the gap boundary and the catch-and-toast both proven via TEMP BREAK)
and `check_custom_remap_dialog` (Pattern dropdown option, Custom Function dropdown
population/visibility, a real submit repositioning nodes, per-view persistence on
reopen) in `tests/run_all.py`.

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
If any are found, `promptSFCCESharedFunctionsConfirm` (`main.js`) asks the user's
choice ONE time: `resolveSharedFunctions` either collapses every copy into one
Function under a real, chosen Section (capabilities from every original section
combined; true post-collapse duplicates merge naturally in the tree-build step's own
uniqueness handling), or keeps each section's own copy with a numbered suffix (plain
name, then `Name1`, `Name2`, ... by first-seen section order). This is the ONLY
"combine into shared" question the wizard ever asks — Business Capability and
Application Capability-level sharing questions existed once (a 3-question walk over
`SFCCE_SHARED_LEVELS`, an array of level configs) but were removed entirely, reported
directly: *"remove option for combining into 'shared' at business capability or
application capability level. these will never be combined into shared, only functions
are combined."* Confirmed structurally safe to delete outright (not just hide the
option): a Capability/Application Capability identity can only span more than one
ORIGINAL section when its parent Function's own rows ALSO span those same sections —
so Function-level resolution, which always runs, already disambiguates the scope
Capability/Application Capability keys are built from either way (collapsed: they
share one funcKey, so `buildIndustryTree`'s own capKey/appCapKey dedup merges them
naturally; kept separate: their funcKeys already differ, so no clash is possible).
`detectSharedCapabilities`/`resolveSharedCapabilities`/
`detectSharedApplicationCapabilities`/`resolveSharedApplicationCapabilities` (and the
now-unused `originalCapabilityName`/`originalApplicationCapabilityName` row fields
they alone read) were deleted from `sfce.js` along with the UI path, not left as dead
exports.

Which Section a collapsed shared Function lands under is itself a mapping-dialog
setting, reported directly (same request as above, its first half): *"add to dialog
something like 'section for shared functions', and default it to sectionId cof but
provide selector for known sections. Any shared functions should go to that section."*
`promptSFCCEMapping`'s `#sfcce-shared-section` `<select>` lists every real,
content-bearing org-viewType Section from `custom.json` (excludes a header/label row
like `title`, whose `elementTypes: []` means it can't actually hold `BusinessFunction`
content), defaulted to `cof` (Centralized Operational Functions). The chosen
`{name, sectionId}` pair passes straight into `resolveSharedFunctions`; its collapse
branch (`resolveSharedLevel`) only overwrites a row's `sectionId` when a real one is
given.

**Description/Id mapping, every level** — the wizard's per-level mapping fields
(`buildRowsFromRecords`' `mapping` param) are fully symmetric across all 5 levels
(Section/Function/Capability/Application Capability/Entity): every level supports an
optional Description field, and every level supports an optional explicit Id field.
Descriptions behave exactly as before (never cascaded — see the module comment).
**Ids deliberately do NOT cascade either** — unlike names, inheriting an id from a
different level would wrongly conflate two distinct identities — a level with no
mapped/blank id field simply falls back to `buildIndustryTree`'s existing
auto-derivation: a chained `slugify` of section/function/.../name for
Function/Capability/Application Capability (scoped under their own parent, matching
"these will never be combined into shared" above), or the entity's own name ALONE for
Entity — see §7.2's own note on why Entity is the one level whose fallback identity is
deliberately NOT chained through its parent. An explicit id
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

**`sectionDescription` fallback to `custom.json`** — reported directly: *"when I open
catalog SFCCE I don't see these section descriptions. please add."* `sectionDescription`
above is populated only when a Load SFCCE field mapping actually supplies a
`sectionDescriptionField` — the BUILT-IN default dataset's own mapping
(`GENERAL_SFCCE_MAPPING`, `data.js`) never has one, so this column was always blank for
the data most people actually see. `public/custom.json`'s `org`/`org4lob`-viewType
section rows (`esf`/`mof`/`cof`/`ssf`/`cif`/`rsf`/`fcf`, plus `org4lob`'s own
`mof2`/`mof3`/`mof4`) gained a real `description` field each. `openOrSwitchSfceCatalog`
(`main.js`) now fills in any row's blank `sectionDescription` from this data by matching
`sectionId` — the identical `sectionId → name` lookup pattern Load SFCCE's own
shared-section dialog (`promptSFCCEMapping`) already uses for its own dropdown — leaving
a row that DOES carry its own real description from the imported data (a mapping that
supplies `sectionDescriptionField`) completely untouched.

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

**A shared entity across capabilities was silently duplicated, one Part per
capability** — reported directly: *"there are what appears to be duplicate parts when
I use 'generate industry', which results in multiple copies in the new views. For
example DataDataEntity appears 3 times for label 'Customer Profile', all same stream
and section. Were these actually from different streams and recorded incorrectly?"*
Diagnosis confirmed against the actual shipped default dataset
(`public/capabilities-general-SFCCE.json`): "Customer Profile" genuinely appears as an
entity under 4 different Business Capabilities (Sales Management, Campaign
Management, Customer Support, Customer Feedback Management), all sharing the same
section — a completely ordinary shape for canonical/shared master data, and NOT a
data-entry error in the dataset itself. `generateIndustry`/`createStream`'s
xIds+model-based Part reuse (§7.2 above, and the v3.0 changelog entry it was built
against) is correct and was NOT the bug — it was never given a chance to fire, because
`buildIndustryTree`'s entity-level nodeId fallback (§7.1, "Ids deliberately do NOT
cascade either") derived each occurrence's id by chaining through its own PARENT
Application Capability's nodeId, exactly like Capability/Application Capability do —
so the SAME entity name under 4 DIFFERENT capability branches minted 4 DIFFERENT auto
ids, and the otherwise-correct reuse check never found a match. Since `streamName` is
always just the entity's own `nodeName` (identical across every branch it appears
under) and `functionSection` happened to be shared here too, every duplicate looked
identical from the properties panel — "same stream and section" was the visible
symptom, not a separate recording bug of its own.

**This directly reversed a prior, deliberate decision — reconciled, not overridden by
accident.** `check_batch_script_quickstart`'s own docstring, and the v0.865 changelog
entry it references (§7.5), had *already* investigated this exact shape once before
("Production Schedule" under two Business Capabilities in the same built-in dataset)
and concluded, twice, that two separate Parts was correct, intentional behavior — the
full suite run after an initial fix attempt caught this directly (that one test
failed, asserting the old two-Part count). Surfaced to the user before proceeding
further, who reconciled the two positions across two follow-ups into a final rule,
reported verbatim: first *"if the two elements are same label etc. and same stream,
they should be merged. If they are same label etc. but different streams they should
remain separate,"* then refined further: *"If same label, model, section, and streams
then elements should be merged or reused. If same label, model, but different section
or stream then should remain separate."*

Since `generateIndustry` always sets a generated entity's `streamName` to the
entity's own `nodeName` (commands.js) — identical across every branch it appears
under — "same label" and "same stream" are the exact same condition for this
pipeline, leaving **section** as the one remaining axis this tree-building step must
encode itself ("model" is already handled independently: every `xIds`+model lookup,
commands.js, is scoped to whichever model a given `generateIndustry` run targets, so
two runs against different models never collide regardless of this id). Fixed by
giving Entity — and only Entity — a fallback nodeId based on its own SECTION and name
together (`entity-<slugified section>-<slugified name>`, `js/sfce.js`), rather than
chained through its parent Application Capability the way Function/Capability/
Application Capability deliberately still are. This is NOT the same "these will
never be combined into shared" decision from §7.1 — that was about the Load SFCCE
wizard's own explicit "combine into shared?" collapsing step for Capability/
Application Capability, a fundamentally different concept (deliberately scoped
ownership under one Function) from a Data Entity, which is exactly the kind of
cross-cutting, reusable concept real capabilities are expected to share, WITHIN one
section. The explicit-Entity-Id mapping (§7.1) still works exactly as before and
takes priority when given; this change only affects the auto-derived fallback used
when no id is mapped — which is what the built-in default dataset (no id columns at
all) and most hand-authored Load SFCCE imports actually hit.

New `check_generate_industry_shares_entity_across_capabilities` (`tests/run_all.py`)
covers both halves in one fixture: two rows share an entity name under different
function/capability/application-capability branches WITHIN the same section (must
merge into one shared `DataDataEntity` Part, connected to BOTH chains, not merely
deduped-then-orphaned) and a third row reuses the identical entity name under a
DIFFERENT section (must produce a genuinely SEPARATE Part) — while the three
originating Function/Capability parts all stay properly distinct throughout. Both
halves proven via TEMP BREAK: reverting to name-only derivation reproduces the
original reported duplication AND incorrectly merges the different-section case too.
`check_batch_script_quickstart` was updated to expect the now-correctly-merged part
count/labels (both "Production Schedule" occurrences share one section, so still
merge under the final section-aware rule exactly as they did under the simpler
name-only version), its stale "confirmed as genuinely distinct, not a dedup bug"
framing corrected, and its docstring extended with this resolution — the v0.865
history itself (§7.5) is left as an accurate record of what was decided *then*, not
rewritten. The rule's "different stream, stay separate" clause doesn't arise anywhere
in `generateIndustry`'s own pipeline (streamName always equals the entity's own
name there) — it would only matter for a manual Generate Stream call passing an
explicit, differing `streamName` for a same-named entity, a `createStream`
(commands.js) concern this change does not touch.

An already-generated document with duplicate Parts baked in from a previous run isn't
retroactively fixed by any of this — Advanced > Smart Check Model's duplicate-part
detection (2+ Parts sharing type+model+label) already catches and offers to merge
exactly this shape.

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

**A third, real gap caught after shipping (Step 40)**: reported directly — *"a
connectors type 'c' are created from business organization unit to business function,
but not of type 's' and business organization unit does not contain streams."* Every
OTHER part/connector `createStream` touches (the main chain, every `passive[]` node,
every edge between them via `findOrCreateStreamConnector`) follows the SAME
`streams: [streamName]`-on-create / `part.streams = [...streams, streamName]`-on-reuse
convention — but the OrgUnit block above was written as a genuine one-off (hand-rolled
find-or-create for both the part and its `'c'` connector, not routed through that
shared helper) and simply never carried it over: the OrgUnit part was created with
`streams: []` and never updated on reuse, and its Assignment connector was created with
no `streams` at all. Fixed by tagging `streamName` onto both (create AND reuse, same as
everywhere else).

A genuine `connectorType: 's'` companion alongside the existing `'c'` one (matching the
pattern every OTHER edge in this function uses) is now also created, both stream-tagged
— but NOT routed through `findOrCreateStreamConnector`/`createCompanionConnector` (that
pair's companion relationship is inferred from `findRelationshipPair`'s generic
type-pair default, a DIFFERENT relation key than `'i'`/Assignment here, which would
silently replace this connector's deliberate ArchiMate semantics, and its `'s'`-side
lookup wouldn't recognize an already-existing pre-fix `'c'` connector in an older
document) — both types found-or-created independently, right here. Direct follow-up:
*"normalize it to 'Stream'/'Passive', the 's' connectors are not intended to be
Archimate."* Only the `'c'` connector keeps the real `'i'`/Assignment relationship; the
`'s'` one uses `'Passive'` instead — matching how every shipped template's own
`passive[]` array already categorizes this exact `{from:'BusinessOrganizationUnit',
to:'BusinessFunction'}` pair, and consistent with every OTHER `'s'` connector in the
app, which never carries a real ArchiMate relationship name (always `'Stream'` or
`'Passive'`, a role label for a chain position, from `findOrCreateStreamConnector`).

This IS a real, confirmed behavior change, not a side effect to route around: an
OrgUnit genuinely connects every Function it's assigned to now — confirmed directly as
the INTENDED behavior, not a bug: *"Bridge behaviour identified is normal, what is
expected."* `insertSmartStream` traversing THROUGH that bridge into unrelated sibling
Functions, though, was a genuine bug in `insertSmartStream` itself, fixed separately —
see its own stream-continuity gate, §5.5. `check_business_organization_unit_element_
and_generation` (`tests/run_all.py`) extended: both connector types present with the
right relationship and per-function `streams`, the OrgUnit part's own `streams` is the
union across every function sharing it, the new `'s'` connector gets its own
ViewMember too, and idempotent re-runs don't duplicate it either — proven via TEMP
BREAK.

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

*(Later reconciled, not reversed by accident: the "Production Schedule under two
Capabilities becomes two Parts" decision above was revisited and superseded — see
§7.2's "A shared entity across capabilities was silently duplicated" for the full
resolution and the general same-label/same-stream rule that settled it. This
paragraph is left as-is as an accurate record of what was decided at the time.)*

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
after Simulation — originally after a since-removed Explore menu; see §5.3's own
Advanced-menu paragraph for where 3D View/Reset Pinned 3D Positions ended up
instead): **Add/Edit Entity Details**, **Autofill**, **Import DDL...**,
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
  (`app`/`store`/`model`/`findParts`/`log`/`messageLog`/`activityLog`/`debugLog`/the raw
  `commands.js` command functions — the latter two added in Step 43, see below)
  `promptScriptConsole`'s own Run button uses via `new Function(...)` — but
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

**"Level It"** (`js/commands.js`'s new `levelIt`; `getCommandDefs`/`CMD_ICONS`,
`render.js`; dispatched from `runCommand`'s new `'levelIt'` branch, `main.js` — a
freeform-views-only right-click/toolbar command, distinct from Level Up/Level Down's
own decomposition concept above despite the similar name) — reported directly: *"when
in a free form view, add a new right-click level-it command. Use case: when an
existing datadataentity is added and connected to a businessprocess, the level-it
command will replace the datadataentity since stream template does not have its type
connected directly to a businessprocess, and will replace it with applicationcapability
since in the stream template 'path' that is the next valid element between it and the
target datadataentity. Silently (no user prompt) replace the view dataentity node with
existing applicationcapability node of that named stream."* Fixes a node that's
connected DIRECTLY, on this view, to a neighbor several steps away in the current
stream template's chain (`template.value[]`, the same ordered-type-array `createStream`
itself walks — §7.2) — the exact reported example uses the real shipped "Enterprise"
template, where `BusinessProcess` sits 5 slots before `DataDataEntity` with
`ApplicationCapability` immediately after `BusinessProcess`.
- Which template: `store.doc.industryTemplateName || 'Enterprise'` — the same default
  `generateIndustry` itself resolves to, so this command needs no dialog of its own
  (*"Silently (no user prompt)"*) and stays consistent with whatever template this
  document's own data actually came from.
- With a single node selected, scans its own connectors on this view (in viewMember
  order) for the first one whose OTHER endpoint's type sits more than one position away
  from this node's own type in `template.value[]` — a genuine "gap." Both ends' types
  must actually be found in the chain; a type absent from it (e.g. `'Unknown'`) can't
  be reasoned about, so that connector is skipped, not treated as a gap. The command is
  bidirectional: whichever of the two nodes is later in the chain gets replaced with
  the type sitting immediately adjacent to the EARLIER one — so right-clicking the
  later node (the reported example) replaces IT with the type just after the earlier
  neighbor, while right-clicking the earlier node instead replaces IT with the type
  just before the later neighbor. Only the first connector with a genuine gap is acted
  on per invocation; running the command again addresses the next one.
- The replacement is always an EXISTING part — never created — found by walking the
  original node's own `streams[]` in order and taking the first stream that already has
  a part of the replacement type tagged with it (`store.doc.parts`, matched by
  type+model+`streams.includes(...)`). No match on ANY of the node's streams aborts
  with a toast naming the type and label; nothing changes.
- Deliberately conservative and VIEW-scoped, matching *"replace the VIEW dataentity
  node"*: neither the original node's Part nor the connector it ran through are ever
  deleted from the model (either may still be legitimate elsewhere, e.g. another view)
  — only this view's own viewMembers for them are removed. The replacement part's own
  viewMember on this view is found-or-created (reusing one already placed here, else a
  new one at the OLD node's exact position, so nothing visually jumps), and the new
  connector between the replacement and the neighbor is found-or-created via
  `findOrCreateStreamConnector` (§7.2's own shared chain-building helper) — the exact
  same "connect chain-adjacent parts" mechanism `createStream`'s own main loop already
  uses, always oriented in the template's earlier-index → later-index direction
  regardless of which way the ORIGINAL connector happened to run (verified as a real,
  not just theoretical, distinction via TEMP BREAK — a naive "keep the original
  connector's own from/to direction" implementation produces a backwards Stream
  connector whenever the original ran opposite the template's own order). The original
  node's own viewMember is only removed if nothing else on this view still references
  it — it may legitimately have other connectors here too.

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

**Attribute-list sizing had a stale 140px ceiling** — reported directly, with an exact
failing DDL fixture (two ordinary tables, 9 and 8 columns): *"data entity detail does
not get sized correctly upon creation, using remap, or redraw."* `redrawNodeSizes`'
content-measuring pass (the single mechanism `Import DDL`/Remap/Redraw all funnel
through — see the `chkShowAttributes` bullet above) correctly measured a
`DataEntityDetails` node's true rendered height, but then clamped the RESULT to a
`140px` ceiling meant for the feature's original (attribute-list-free) node content —
an 8-9 column table, not a pathological case, already exceeded it. Since `.fnode` has
no `overflow: hidden`, this wasn't invisible clipping: the last attribute row(s)
visually overflowed past the node's own fixed-height box, overlapping whatever the
canvas placed below it. Fixed by raising the ceiling to `600px` (comfortably fits
~40 attribute rows — still a real ceiling, so one pathologically huge pasted table
can't blow up every other node's shared, uniform-per-view size without limit).

**Redraw's "Show all text" option** — direct follow-up: *"In redraw command for a view,
add option something like 'show all text' checkbox and if selected resize default
size for text that fits and full size that displays all text of node such as long
descriptions. And retain setting for the specific view for future sessions."* Redraw
(Commands panel) previously ran `redrawAndResolveLayout` immediately, no dialog; a new
`App.promptRedraw(tab)` (`main.js`) now shows one checkbox, pre-filled from — and, on
submit, written back to — `view.chkShowAllText`, the exact same "retained for the
specific view" mechanism every other `view.chkShowXxx` toggle already gets (a plain
document field, round-trips through Save/Load JSON via `Store.toJSON`'s whole-doc
clone, no special-casing needed). `buildNodeEl` (`canvas.js`) reads this same flag at
BOTH measurement time (`redrawNodeSizes` builds its measurement element by calling
`buildNodeEl` itself, so this is "free") and real render time: `.fnode-label` and
`.fnode-description` both have a `-webkit-line-clamp: 2` truncation in their base CSS,
which `redrawNodeSizes`' pre-existing label-measurement already bypassed (it has
*always* measured the label's true, unclamped height, a quirk that predates this
feature) but the description never did — so without this fix, a taller box would have
displayed the identical truncated "…" with the extra room simply wasted. When
`chkShowAllText` is on, an inline `-webkit-line-clamp: unset; display: block; overflow:
visible;` override removes BOTH clamps, at both times, so a size Redraw computes for
"the full text" is a size that genuinely SHOWS the full text — not a bigger, still-
truncated box.

**Auto-Detect Connectors** (`js/commands.js`'s `detectConnectorCandidates`/
`createDetectedConnectors`; `App.promptAutoDetectConnectors`, `main.js`) — reported
directly: *"Part A: auto determine from ddl content 'references'. Part B: find
matching field names where one is primary key and other is not, this is potential for
n to 1 and foreign key, show preview list to user to confirm before creating new
connectors."* Part A itself already existed inside `importDDL` (above) but only for
tables being created fresh from the pasted DDL; this is the missing piece — finding
candidate `'d'` connectors between tables that ALREADY exist in the document, with a
preview-then-confirm step before anything is created (the field-name heuristic in
particular is a guess, not a certainty). Deliberately scoped to the WHOLE document,
not the current view (the user's own explicit choice over the current-view scoping
every other Data Modeling command uses) — the two tables involved may not even be
placed together on any view yet.
- `detectConnectorCandidates(store, ddlText)` is pure logic (no DOM, no mutation),
  combining two independent mechanisms into one merged, de-duplicated list:
  - **Part A**: if `ddlText` is given, `ddl.js`'s `parseDDL` — the exact same
    `FOREIGN KEY ... REFERENCES` parsing `importDDL` itself uses — has its
    `foreignKeys` matched against EXISTING `DataEntityDetails` tables/attributes by
    name. A reference `parseDDL` can't resolve among existing tables is silently
    skipped (not fabricated), same principle as `importDDL`'s own `fkSkipped`.
  - **Part B**: every (primary-key attribute, non-primary-key attribute) pair across
    two DIFFERENT tables whose names match — either exactly (case/punctuation-
    insensitive, via a small `normalizeIdent` helper) or the non-PK name matches the
    PK table's own label concatenated with the PK's name (the "`<Table>Id`"
    convention, e.g. Customer's PK "Id" matching Order's "CustomerId") — is proposed.
  - Both mechanisms use `importDDL`'s own `fromAttribute`/`toAttribute` convention
    (`fromAttribute` = the FK/child/"many" side, `toAttribute` = the referenced/PK/
    "one" side, `fromCardinality:'many'`/`toCardinality:'one'`), so a confirmed
    candidate is indistinguishable from one DDL import would have produced directly.
  - A pair already linked by an existing `'d'` connector between those exact two
    attributes (either direction) is never proposed again — checked by attribute-id
    pair, deliberately NOT via `store.findExistingConnector`'s coarser (from, to,
    model, connectorType) uniqueness key, since that key would incorrectly collapse
    two genuinely different FK relationships between the same two tables (e.g. Order
    referencing Customer via both `CustomerId` and `ShipToCustomerId`) into one.
- `createDetectedConnectors(app, candidates)` creates a real `'d'` connector for each
  CONFIRMED candidate (the caller has already filtered to whatever a person checked in
  the preview list), then places a connector viewMember in every view where both
  endpoint parts already have a part viewMember — the same "both endpoints already on
  this view" placement rule `smartCheckView`'s own `missingConnectors` block uses,
  just applied across every view in the document at once since detection isn't scoped
  to one view. A pair with no shared view yet still gets its connector created at the
  document level (mirrors Level Up/Down's own "unplaced Composition connector"
  precedent, above) rather than being silently dropped — it becomes visible once both
  tables are eventually placed together on some view, including automatically the next
  time Smart Check View runs there. Returns `{ created, placements, unplaced }`.
- `App.promptAutoDetectConnectors` (new Data Modeling menu item, after a separator
  following Export DDL) is a single modal: an optional DDL-paste textarea, a "Detect
  Connectors" button that runs `detectConnectorCandidates` and renders a checkbox
  table (every row checked by default, with a Select All toggle), and a "Create
  Selected Connectors" button (hidden until at least one Detect has run) that filters
  to what's checked and calls `createDetectedConnectors`. Follows this codebase's
  standard `.modal-overlay > .modal-box` convention (closes only via its own Cancel/
  Create buttons). New `check_auto_detect_connectors_detection_and_creation` (pure
  logic, covering Part A/B, de-dup, and placement-vs-unplaced) and
  `check_auto_detect_connectors_dialog` (real menu/DOM wiring) in `tests/run_all.py`.

## 8. Simulation engine

Per-model tick engine (`simulation.js`). `store.simRuntime: Map<modelName, {tick,
values: Map<partId, {value, lastGoodValue, state, lastError, response, lastGoodResponse,
changed, responseChanged, leftBadge, rightBadge}>}>`. Each tick, every scripted
(`part.scriptEnabled`) Part in the selected model runs its script inside its own
try/catch (one Part's error is logged and doesn't stop the others), receiving a `ctx`
object (`part`, `inputs`, `responses`, `state`, `tick`, `log`, `secrets`, `setState`) and
required to return `{value, state, response?, leftBadge?, rightBadge?}`. `value` and
`response` are conventionally objects (matching `state`'s own always-object shape) but
the engine has never enforced this — a script may return any JS value for either. `response`
values delivered this tick become the *sources'* `ctx.responses` next tick — the
mechanism for acknowledgement/feedback flows running opposite the connector direction. A
Part with no script and exactly one input passes it through unchanged. Full contract
documented for end users in `public/instructions.html`.

**`leftBadge`/`rightBadge` (Step 41, tightened)**: `rightBadge` is the original
script-controlled badge (bottom-right corner, `.fnode-sim-badge-right`, gated by the
"Show Right Badge" view checkbox), simply renamed from its earlier name `badge` for
symmetry — fully freeform `{text, color}`, fresh every tick, shows nothing if omitted.
`leftBadge` is new and occupies the SAME slot as the badge that used to auto-display a
part's `value` (bottom-left corner, `.fnode-sim-badge`, gated by "Show Left Badge" — the
same checkbox, renamed from "Show Simulation Values"): when a script returns `leftBadge:
{text, color}` this tick, that text/color is shown. Purely opt-in, exactly like
`rightBadge` — a direct follow-up ("if leftBadge is empty then no value should be
displayed in left badge... only 'return {value, leftBadge: {...}}' pattern should
trigger left badge to be displayed, same behavior as rightBadge") removed an initial
version's fallback to auto-formatted `value` when `leftBadge` was omitted; a script that
never returns `leftBadge` now shows no left badge at all — reported directly against the
"smart factory 3d demo" example's plain `return { value }` sensor scripts, which were
still showing a badge under the old fallback behavior. The one exception: a UI Output
widget's own pre-existing display mechanism (its written value IS its entire reason for
existing — see the UI dashboard elements section below) is a separate code path unaffected
by this opt-in rule, since a widget can never set its own `leftBadge`. The "ERR" overlay
(from `lastError`) always wins over `leftBadge`, since a thrown script never reaches its
own return statement.

**`ctx.outputs` (Step 42)**: reported directly, after asking what `ctx` field lists a
part's outgoing connectors and being told there wasn't one — *"add a ctx.outputs list of
outgoing connectors, and an example file where a node loops through all the connected
inputs and connected outputs showing connector type and other (to/from) part type,
display to message log."* `ctx.outputs` is new — one entry per OUTGOING connector of the
part (within its own model), `{toPartId, toLabel, toPartType, connector: {relationship,
streams, connectorType}}`. Purely structural, unlike `ctx.inputs`/`ctx.responses` — a
script hasn't returned its own `value` yet when `ctx` is built, and that single `value`
gets broadcast identically to every outgoing connector regardless, so there's no
per-connector value to expose. `ctx.inputs` gained two matching new fields in the same
change: `fromPartType` and `connector.connectorType` (previously `connector` only carried
`relationship`/`streams`) — `ctx.responses[i].connector` gained `connectorType` too, for
the same three-way symmetry. New `public/examples/connector introspection demo.json`:
Requestor → Router over a `'c'` connector; Router fans out to Approval Service over an
`'s'` connector and Audit Log over a `'c'` connector — Router's script loops `ctx.inputs`
then `ctx.outputs`, logging each connector's type and the OTHER part's own type to the
Message Log, without hardcoding any neighbor's id. New
`check_ctx_outputs_and_inputs_connector_metadata` (drives a real multi-connector-type
graph through an actual `sim.stepSimulation()` call, confirms every new field on both
`ctx.inputs` and `ctx.outputs`, and confirms both read as empty arrays — not `undefined`
— for a part with no connectors at all) and `check_connector_introspection_example`
(confirms the file is listed in `examples/index.json` and that Router's script genuinely
logs the documented lines) — both proven via TEMP BREAK removing `outputs` from the `ctx`
object entirely, which throws `ctx.outputs is not iterable` from the example's own script.

**3-tab Log area (Step 43)**: reported directly — *"change message log area to have
three 'tabs': message log (for brief messages), activity log (for details), and debug
log, and create commands to write to these from common script or through ctx."* The
left panel's single "Message Log" section becomes 3 tabs (`.log-tab` buttons,
`index.html`) over 3 independent, equally-capped-at-500 arrays: `store.messageLog`
(unchanged, brief), new `store.activityLog` (more detail), new `store.debugLog`
(deep/verbose). `app.activeLogTab` (`main.js`, pure UI state, not persisted) picks which
one `renderMessageLog` (`render.js`) shows in the shared `#message-log` textarea, updates
the tab buttons' `active` class, and updates the header text (`LOG_TABS`, exported from
`render.js` so `main.js`'s click/copy/clear/double-click handlers share the same
tab→store-key→label map) — Copy/Clear/double-click-to-expand all act on whichever tab is
currently active, not a fixed one. Two write paths, both new, mirroring the pre-existing
`ctx.log`/`messageLog(...)` pair exactly: `ctx.logActivity(...)`/`ctx.logDebug(...)` for
a part script (`runTick`, `simulation.js`, alongside the existing `ctx.log`), and
`activityLog(...)`/`debugLog(...)` bindings in BOTH of the Script Console's own execution
contexts (`promptScriptConsole`'s Run button and `promptAutofill`, `main.js`) alongside
the existing `messageLog(...)` binding. `pushMessageLog`/`pushActivityLog`/`pushDebugLog`
(`simulation.js`) now share one internal `pushLog(store, arrayName, message)` helper
rather than three independent copies of the same cap-at-500 splice logic.
**`CommonScript_DebugOutLog(ctx)`** (`state.js`, right after `CommonScript_Sim`): a third
`CommonScript_<Name>` example, the requested script itself — *"Write a
common_debugOutLog script that will be called from any element connected as a 'to', to
display deep to the new debug log all the input values looping through arrays."* Meant
to be called from (or copied into) any part that receives input; loops `ctx.inputs`, and
for any input whose `value` is an array, loops through each element individually
(logging an `array of N` summary line, then one line per element) rather than dumping
the whole array as one block — everything logged via `ctx.logDebug` as pretty-printed
(2-space, multi-line) JSON, matching the Debug tab's own "deep/verbose" purpose, and
reusing `ctx.inputs`' Step 42 `fromPartType`/`connector.connectorType` fields to name
each source. A part with zero inputs logs one explicit "no inputs connected this tick"
line rather than silently doing nothing. New `check_activity_and_debug_logs` (the two
write paths, via a real part script AND the real Script Console dialog's Run button),
`check_common_script_debug_out_log` (array-looping, non-array, and zero-input cases, via
real multi-part chains and real simulation ticks), and `check_log_tabs_ui` (against the
real left-panel DOM: default tab, switching tabs swaps content/active-class/header, and
Copy/Clear act only on the currently-active tab) — every changed/new behavior proven via
TEMP BREAK. DESIGN_DOCUMENT.md (here), `public/instructions.html`'s ctx-object table and
Script Console bindings table, and `tests/README.md` updated.

**Packet protocol: `value` never auto-holds, `lastGoodValue` does (Step 35)**: reported
directly, expanding on `value`/`response` — *"can value and response be objects?"*, then
*"can the changed flag ... be baked into script handler instead of needing the script to
track"*, then — after a design pass on making `value` behave like the already-transient
`response` for consistency, which was flagged as reversing a deliberate "never propagates
undefined downstream from a broken node" protection — *"can we retain last known good
value in addition to new value, which may be null if no value provided? thrown errors
will not be hidden downstream, up to script logic to see and respond accordingly -- which
may be to use last known good."* A Part's raw `value` this tick is `undefined` unless
something actually produced one THIS tick (a script returning `value`, an unscripted
single-input pass-through, or nothing at all for an idle node, an omitted `value`, or a
thrown error — all read identically as "nothing this tick," confirmed directly: *"why
doesn't matter to consumer, will be responsibility of sender to address problem,"* so no
separate error signal is exposed downstream). `lastGoodValue` is a new, separately
persisted field — the last value that was actually defined (`!== undefined && !== null`),
held across any number of gap ticks — exposed both on the Part's own runtime entry and as
`ctx.inputs[i].lastGoodValue`, so a script that wants the old "keep computing with
whatever's freshest" behavior opts into it explicitly instead of the engine choosing on
every script's behalf. `response` gets the same treatment via a new `lastGoodResponse`
(internal — `ctx.responses[i]` already only ever contains real deliveries, so there's
nothing new to expose in the payload itself). `changed`/`ctx.responses[i].changed` are
now computed from this lastGood lineage with a recursive deep-equal (not `===`), so an
object/array with identical content on two consecutive real deliveries doesn't
spuriously read as changed, and a gap tick never flips it on its own. The node's own
badge (`canvas.js`) reads raw `value`, unchanged — confirmed directly: *"blank the
instant nothing's returned, should reflect last tick"* — only the separate "ERR" overlay
(from `lastError`) still marks a broken node differently from an idle one. Snapshot
save/load (`saveSimSnapshot`/`loadSimSnapshot`, version bumped to 3) now round-trips
`lastGoodValue`/`lastGoodResponse` too. New
`check_sim_value_no_auto_hold_and_last_good_tracking` (`tests/run_all.py`): a 5-tick
sequence (fresh value, thrown error, identical-content recovery via a fresh object
reference, real content change, thrown error again) checked on the source Part directly
and one tick downstream via `ctx.inputs`/`ctx.responses`, plus an unscripted pass-through
Part mirroring the same raw blanking, plus the snapshot round-trip — the entire auto-hold
removal proven via TEMP BREAK (reintroducing the old `resultValue = prevSelf?.value`
carry).

**Common scripts callable from any part script**: reported directly — *"Create a common
script in script console example that can be called from any part script. Within the
new script I want to take action based on calling part type, label, and model. As an
example have the script send to message log something like 'called by ' part type,
label, and model."* `runTick` now compiles a Part's script as `new Function('ctx',
store.batchScriptCode + '\n' + part.script)` instead of just `new Function('ctx',
part.script)` — every function/const the Script Console's own text
(`store.batchScriptCode`) defines is therefore in scope inside EVERY part script too, so
a part's script can call any of them by name, using its own `ctx`. This is the THIRD
kind of entry point `DEFAULT_BATCH_SCRIPT_CODE` (state.js) hosts, alongside `main()`'s
own `BatchScript_*` chain and `dataAutoFill()` (§7a) — `CommonScript_Example(ctx)` ships
as the reported example (`ctx.log('called by ' + ctx.part.type + ' ' + ctx.part.label +
' ' + ctx.part.model)`), and `CommonScript_<Name>` is the naming convention for future
additions meant to be called this way. `batchScriptCode`'s OTHER top-level functions
(`main`, `BatchScript_*`, `dataAutoFill`) reference free variables (`app`, `store`, ...)
that aren't in scope for a part script — calling one of THOSE from a part script throws
(caught by the same per-part try/catch as any other script error); they simply sit
defined-but-unused otherwise, exactly as they already do inside each other's own
executions today (e.g. `dataAutoFill` is equally inert from inside `main()`, and vice
versa, unless explicitly called). New `check_common_script_callable_from_part_script`
(`tests/run_all.py`): the shipped default logs the exact reported message; a person's
own CUSTOM function added to `store.batchScriptCode` is equally callable (proving this
is a general mechanism, not special-cased to the one shipped example); an ORDINARY part
script with no `batchScriptCode` dependency at all behaves exactly as before (purely
additive) — proven via TEMP BREAK reverting the prepend, which fails with
"CommonScript_Example is not defined".

**`CommonScript_Sim(ctx)`** (`state.js`, shipped default, right after
`CustomRemap_Example`): a second `CommonScript_<Name>` example, this one meant to be
copied into (or called from) a PART's own `script` field directly rather than only
called from another script — reported directly with a starter shape (a
`switch (ctx.part.type.toLowerCase())` logging a per-type message, `default` logging an
"unknown" variant) to extend to *"all known element types identified in streamTemplates
where name = 'Enterprise', and add generic return statement with value, state,
response, and badge settings."* "Enterprise" (`public/custom.json`,
`settings.streamTemplates`) uses 12 element types total once its `passive[]` pairs are
counted alongside its own ordered `value[]` chain: `value[]` itself has 9 (GeneralActor,
BusinessService, BusinessCapability, BusinessProcess, ApplicationCapability,
ApplicationProcess, ApplicationLogicalComponent, ApplicationPhysicalComponent,
DataDataEntity); `passive[]` introduces 3 more that never appear in `value[]`
(BusinessFunction, ApplicationApplication, BusinessOrganizationUnit) — see Catalogs >
Stream Templates, directly below, for a live way to confirm this instead of
hand-cross-referencing the JSON. The function's own return statement demonstrates the
full `{ value, state, response, badge }` shape a real part script can use: `value`
defaults to the part's own label when there's no input to forward; `state` increments a
`ticksSeen` counter, showing the "merges forward automatically" behavior in a way a
person can actually observe tick over tick; `response` is only set once
`ctx.inputs.length > 0` (omitted otherwise, matching the contract's own "single value,
not a queue" semantics); `badge` returns a real `{ text, color }` object. New
`check_common_script_sim_covers_enterprise_types` (`tests/run_all.py`): drives a real
part per element type through an actual `sim.stepSimulation()` call (not a text scan) to
confirm each one logs its own message, an unrecognized type falls through to the default
case, and the example return's four fields all behave as documented across two real
ticks — proven via TEMP BREAK (both a removed case and a stripped `badge`).

**Update (Step 41)**: reported directly — *"change simulator script so value can return
an object, same behaviour as state, and create new 5th return value for left badge...
and right badge... Change script so return value and return response are now objects,
same as state and badge (now to be called rightBadge), with new leftBadge.text being
shown in left badge instead of whatever is in value."* `CommonScript_Sim`'s return
statement now demonstrates `value` and `response` as objects (`{type, label,
receivedFrom}` / `{ack: true, from, tick}`) rather than a bare string, matching `state`'s
own always-object convention — documentation of a *recommended* shape, since the engine
itself has never required and still does not require `value`/`response` to be objects.
`badge` is renamed `rightBadge` (same `{text, color}` shape, unchanged behavior); the new
`leftBadge` field (`{text: String(ticksSeen + 1), color: '#2f8f4e'}`) demonstrates
setting it explicitly, since (per a direct follow-up) it's purely opt-in like
`rightBadge` — see the `leftBadge`/`rightBadge` paragraph above for the tightened
no-fallback behavior. Both `check_common_script_sim_covers_enterprise_types`'s
assertions and the fabricated `store.simRuntime` data in
`check_export_svg_respects_content_checkboxes` were updated for the field rename; a new
dedicated check proves the leftBadge-is-opt-in behavior, the UI Output widget exception,
and ERR always winning.

**Full replacement, and reordered last (Step 44)**: reported directly, replacing the
type-switch example above wholesale rather than extending it — a relationship-
classification example instead. `CommonScript_Sim(ctx)` now checks `ctx.inputs` (this
part as the 'to' side of each incoming connector) against two relationship lists,
`toCtxAction` (`['aggregation','composition','flow','realization','triggering']`) and
`toCtxPassthrough` (`['assignment','association']`), and `ctx.outputs` (this part as
the 'from' side of each outgoing connector) against `fromCtxAction`
(`['flow','triggering']`) and `fromCtxPassthrough`
(`['aggregation','assignment','association','composition','realization']`) — each match
appends a `{ action, reason }` descriptor (`reason` is the connector's own, non-
lowercased `relationship`) to a running `value` ARRAY rather than a bare object, since
several connectors can classify in the same tick. Every intermediate
(`value`/`state`/`response`/`leftBadge`/`rightBadge`, the last two literal empty
objects `{}` here — `simulation.js`'s own Step 41 badge normalization still fills them
in as `{text: '', color: '#666666'}` before they reach `store.simRuntime`, since a
truthy-but-empty object is still "the script returned a badge") is dumped to the Debug
Log (`--v--`/`--s--`/`--r--`/`--lb-`/`--rb--` markers bracketing each JSON value,
`--e--` at the end) before the same full 5-field shape is returned. `CommonScript_
DebugOutLog(ctx)` was simplified the same way — the Step 43 looping/pretty-printed
per-array-element version replaced with a single-block dump: `ctx.inputs` logged
verbatim as one compact-JSON line, bracketed by `'-i--'`/`'-e--'` markers, no special
case for zero inputs (an empty `ctx.inputs` array just logs `[]` in the middle, same
3-line shape either way). Both examples were also REORDERED — `CommonScript_
DebugOutLog` now comes first (right after `CustomRemap_Example`), `CommonScript_Sim`
last, as "the more complete one" of the two — so every file-location reference to
either function above describes their positions as of when each paragraph was written,
not the current layout. `check_common_script_sim_covers_enterprise_types` was replaced
by `check_common_script_sim_classifies_connectors` (a real 4-connector graph — one of
each of the 4 relationship buckets — driven through one real simulation tick, checking
the returned `value` array's 4 entries, the `{}`-vs-normalized state of the other 4
return fields, all 10 Debug Log lines, and a no-connectors part returning an empty
array) and `check_common_script_debug_out_log` was rewritten in place for the new
3-line shape — both proven via TEMP BREAK. `state.js`'s own top-of-file doc comment,
`tests/README.md`, and this section were all updated for the new order/behavior.

**`CommonScript_GenericPartActions(ctx, opts)` fully replaces `CommonScript_Sim`, and
becomes every Part's new default `script`**: a follow-up built on top of the earlier
"generic part actions demo" example (public/examples/, added the same session as this
paragraph — a 9-part model where every part's own `script` field carried an identical,
~6KB copy-pasted request/response dispatcher), reported directly: *"move the generic
scripts from each part to one script replacing CommonScript_Sim with parameters as
needed. This will reduce file size and simplify maintenance, and make simulation
available by default for all files. By default each part should now have the script
disabled and script field populated with the call to the generic script, leaving user
able to override with their own script as desired."* Three changes: (1) the old
`CommonScript_Sim` (connector-relationship classification into a placeholder value
array, Step 44 above) is REMOVED, not extended, and a new `CommonScript_
GenericPartActions(ctx, opts)` takes its place, last among the `CommonScript_<Name>`
examples — a genuinely generic request/response dispatcher driven purely by
`ctx.part.type` (an INITIATOR that originates a fresh request every tick, a RESPONDER
that terminates a request with a reply instead of relaying it, or — the default — a
PASSTHROUGH that relays both directions) and each connector's own `relationship`
(which action label a RESPONDER's reply gets), reading only `connectorType: 'c'`
connectors and using `ctx.part.rawLabel` as every packet's subject; `opts` (optional:
`initiatorTypes`/`responderTypes`/`relationshipActions`) lets a calling script
override just the classification, each replacing (not merging with) its own built-in
default list/map, without forking the whole function — the literal answer to "with
parameters as needed." (2) `Store.createPart`'s (`state.js`) own `script` default
parameter changes from `''` to `'return CommonScript_GenericPartActions(ctx);'`
(`scriptEnabled` stays `false`) — since essentially no caller across `commands.js`/
`main.js`/`simulation.js`'s own `ctx.createPart` passes `script` explicitly for a
brand-new part, this one default-parameter change makes every part created ANY way
(manual creation, Generate Stream/Industry, Auto-Complete Streams, Level Down, Split,
Data Modeling tables, a script's own `ctx.createPart`, ...) simulation-ready the
moment `scriptEnabled` is flipped on — "available by default for all files" going
forward. `migrateDoc`'s per-part mapping gets the matching `p.script ?? 'return
CommonScript_GenericPartActions(ctx);'` fallback, so a raw/foreign document with no
`script` key at all (loaded via Load JSON/Load/Load Example) is backfilled the same
way — `??` only fires on a genuinely missing/undefined field, so a part that
explicitly saved `script: ''` (every bundled example's non-scripted parts included) is
left untouched. `archimate.js`'s own part-construction (bypasses `Store.createPart`
entirely, building plain objects for `store.loadFromJSON`) gets the identical default
for the same reason, so ArchiMate-imported models are simulation-ready out of the box
too. (3) the "generic part actions demo" example is rewritten to actually USE this:
every one of its 9 parts' `script` field shrinks to the one-line `'return
CommonScript_GenericPartActions(ctx);'` (left `scriptEnabled: true`, per the reported
instruction to "leave script enabled" on this specific demo, unlike the new
create-time default), cutting the file from roughly 56KB to about 13KB — proving the
shared-function design didn't change behavior at all: the same 4-hop product-inquiry
chain and 3-way capability-inventory fan-out round-trip identically. `check_common_
script_sim_classifies_connectors` is replaced by `check_common_script_generic_part_
actions_default` (`tests/run_all.py`): the new create-time/migrateDoc defaults
(including the "leaves an explicit empty script alone" case), a real initiator ->
passthrough -> responder chain round-tripping over a real `sim.stepSimulation()` run,
and the `opts` override reclassifying an otherwise-passthrough type into a responder
with a custom reply action — proven via a plain Node `Store`/`runTick` script (no
browser) before writing the test, then via a real TEMP BREAK. `check_generic_part_
actions_example` was updated in place for the shrunk demo file (its "every part
shares one script" assertion now checks the shared one-liner, not a shared ~6KB
blob). `state.js`'s own top-of-file doc comment and this section were both updated.

The one-line default call itself is now a single exported constant, `DEFAULT_PART_
SCRIPT` (`state.js`, right after `DEFAULT_BATCH_SCRIPT_CODE`), rather than the same
literal string retyped at each of `Store.createPart`'s default parameter, `migrateDoc`'s
backfill, and `archimate.js`'s own part construction — a real follow-on bug surfaced
this: Advanced > Code Summary's "part with no script" exclusion (`promptCodeSummary`,
`main.js`) used to mean a truly empty string, and now that EVERY new part ships with a
non-empty default script, that filter would have started listing every single
unscripted part in the document, defeating the feature's own security-review purpose.
Fixed by excluding a part whose script is blank OR exactly equal to `DEFAULT_PART_
SCRIPT` (already-reviewed, shipped code — nothing new to surface) while still including
one that calls the same function with a custom `opts` override (genuinely
reviewable). `check_code_summary` gained two more parts covering exactly this
distinction, proven via the same TEMP BREAK pass.

**Simulation > Manage Part Scripts...** (`App.promptManagePartScripts`, `main.js`):
a direct follow-up in the same session, once the default-everywhere change above made
individually flipping "Part Script Enabled" per part impractical at any real scale —
reported directly: *"add a command under simulation for enabling/disabling part
scripts by presenting a dialog showing headers for order and filters (stream, part
type, model, etc, checkbox all/none) and list of parts for user to quickly
enable/disable."* Reuses `promptAddExisting`'s own established shape almost exactly
(Type/Model/Stream `<select>` filters, a `<table>` with clickable sortable column
headers, a header "select/deselect all" checkbox synced to the filtered rows'
current state) rather than inventing a new list-with-filters pattern — the one
difference is behavioral, not structural: `promptAddExisting`'s checkboxes build up a
SELECTION for one eventual "Add Selected" submit, while this dialog's checkboxes ARE
the action — each row's checkbox toggles that Part's own `scriptEnabled` immediately
(the identical single-property, live-and-undoable change the property panel's own
"Part Script Enabled" checkbox already makes), so there's nothing to Save/Cancel —
just a Close button, like the read-only Stream Templates catalog. Lists every Part in
the WHOLE document, deliberately not scoped to `store.simSelectedModel` — Model is one
of the filters instead, since managing scripts is a document-wide setup task, not a
per-simulation-run one. Columns are Label/Type/Model/Stream/Order, all sortable by
clicking their header — Order included per the report, alongside the
`promptAddExisting`-style trio. The header checkbox applies to whatever the CURRENT
filters resolve to, as a single `recordAndRender()` — one undo step for the whole
bulk toggle, matching how Smart Check Model's own "Fix Selected" batches its history
entry rather than one per affected part — rather than the per-row toggle's own
one-recordAndRender-per-click (each individual toggle is its own small, deliberate
edit; a filtered bulk toggle is one coherent action). Reachable from the Simulation
menu's own new group (a separator above and below it, between Reset Simulation and
the log/snapshot commands), and — unlike every other Simulation menu action — does
NOT require a simulation model to be selected first, handled as a special case ahead
of `runSimAction`'s existing `if (!modelName) return` guard. New
`check_manage_part_scripts_dialog` (`tests/run_all.py`): the dialog lists parts
spanning multiple models at once; each filter narrows the row list correctly; a
single row's own checkbox flips the real part's `scriptEnabled`; the Order header
sorts numerically; and the header select-all/none, with a Stream filter active,
toggles only the matching row while leaving an out-of-filter part's own
`scriptEnabled` alone — proven via TEMP BREAK (the bulk toggle applied to every part
instead of just the filtered rows). `public/instructions.html`'s Simulation Scripting
intro paragraph, and a new "What to expect from each role" pair of summary tables
(INITIATOR/RESPONDER/PASSTHROUGH's default types and per-tick behavior, and the
`relationshipActions` reply-wording map) were added in the same pass — the latter
also a direct follow-up: *"add a summary table to instructions in simulation
scripting section regarding initiator types, passthroughs etc. logic to help users
understand what to expect of each type."*

**Manage Part Scripts gains Cancel/Apply staging**: a later direct follow-up —
*"manage part scripts needs a cancel button to not change anything, and change close
to apply."* The dialog's checkboxes (both the per-row one and the header
select/deselect-all) no longer write straight to a Part's own `scriptEnabled` — each
now only stages its intended value in a local `pending` Map (partId -> boolean),
scoped to the one open dialog instance; a new `effectiveEnabled(p)` helper (`pending`
value if staged, else the Part's own current `scriptEnabled`) is what every checkbox's
rendered/synced state actually reads, so a staged-but-not-yet-applied toggle still
displays correctly across filter/sort re-renders within the same session. **Cancel**
(renamed from the old single "Close") simply removes the dialog — since nothing was
ever written to the real document, there's nothing to revert, matching the report's
"not change anything." **Apply** (renamed from "Close") walks `pending` once, writing
every staged value to its real Part, then a SINGLE `recordAndRender()` if anything was
actually staged (skipped entirely on an empty `pending`, e.g. a dialog opened and
immediately closed with no edits) — one undo step for the whole session, same
batching rationale as the header bulk-toggle's own single `recordAndRender()` already
had. Reopening the dialog after a Cancel always starts from a fresh, empty `pending`
map (built fresh each `promptManagePartScripts()` call), so a discarded session's
staged choices can never leak into a later one. `check_manage_part_scripts_dialog`
was rewritten in place to prove staging explicitly: toggling a checkbox and reading
the real Part's `scriptEnabled` immediately afterward (still the OLD value); Cancel
leaving it unchanged; a freshly reopened dialog reflecting the real value, not the
cancelled session's staged one; Apply committing the staged value; and the header
bulk-toggle's own staged change committing only for the currently-filtered part,
leaving an out-of-filter part untouched even after Apply — proven via TEMP BREAK (a
row checkbox writing directly to the real Part in addition to staging it, which
failed four of the check's assertions at once).

**Catalogs > Stream Templates** (`App.promptStreamTemplates`, `main.js`): reported
directly, immediately after the above — *"In Catalogs menu after SFCCE create a new
separation line and then a new item 'Stream Templates' and command to open new form --
create a new read only form that shows user the contents of streamTemplate templates in
an easy to read format. This includes a sorted selector for streamtemplate name (default
Enterprise), and all the attributes for the selected stream template."* A read-only
modal — unlike Catalogs > SFCCE (`promptSfceCatalog`, just above), which opens a full
table TAB — since a stream template isn't a flat list of interchangeable rows: it's ONE
named object with a few scalar fields (`pattern`, `capabilityNameBegin`,
`applicationCapabilityNameBegin`, `entityNameBegin`) plus two differently-shaped
sub-structures (an ORDERED chain, `value[]`, rendered as a numbered table so the sequence
itself is visible; and `passive[]`, a set of `{from, to}` pairs, rendered as its own
From/To table) — a dedicated small layout reads far more clearly here than forcing this
shape into generic table columns. `#st-template-select` lists every
`settings.streamTemplates` name, alphabetically sorted, defaulting to "Enterprise" when
present (else the first name alphabetically) — the same "known, most commonly
referenced default" precedent Remap/Generate Stream/Populate From Template's own
template pickers already follow elsewhere. Purely read-only: no submit button, no store
mutation of any kind, just a Close. New `check_stream_templates_catalog_dialog`
(`tests/run_all.py`): the Catalogs menu's own second separator/item ordering after SFCCE;
the selector's alphabetical sort and Enterprise default; Enterprise's own scalar fields,
full `value[]` chain, and `passive[]` pairs (including a type like BusinessFunction that
only appears in `passive[]`) all rendering correctly; switching to a differently-shaped
template ("SFCCE," which additionally has `applicationCapabilityNameBegin`) re-rendering
the details; and Close removing the dialog — the default-selection and scalar-field
rendering both proven via TEMP BREAK.

**Model Copy** (`copyModel`, `commands.js` — first piece of a larger, in-progress "UI
dashboard elements" feature; see the same section for the rest once built). Reported
directly as testing infrastructure for that feature: *"We'll also need a model copy
function, where everything identified for a specific model will be copied into a new
model; which will also help in testing this."* "Everything for a model" is exactly the
same `part.model`/`connector.model` tag every other model-scoped mechanism
(`runTick`/`buildIncomingMap`, `ctx.findParts`) already keys off — deliberately NOT
views/viewMembers, since nothing in this app scopes a View to one model at all (a
single View can already hold viewMembers for parts from several different models —
`generateInventoryView` names *itself* after one model purely as its own convention,
and "Add Existing" places requested part ids onto the current view with no model check
whatsoever), and NOT simulation runtime state (`store.simRuntime`/`simLog`), since a
freshly copied model hasn't run a tick yet. `copyModel(store, sourceModelName,
newModelName)` builds an old→new PART id map while cloning every part tagged with the
source model (new id, but the SAME label — unlike `duplicateSection`'s own renaming,
the whole point here is a same-labeled counterpart in a different model, so a
dashboard or a person can compare "Model A: Revenue Total" against "Model B: Revenue
Total" directly — `script`/`scriptEnabled`/`attributes` all copied verbatim, since the
point is a working, testable duplicate of the sim itself), then a second pass clones
every connector tagged with the source model whose BOTH endpoints were copied
(endpoints remapped via the part-id map, same "skip if not both duplicated" rule
`duplicateSection` already establishes), building its OWN old→new CONNECTOR id map,
then a third pass remaps `mirrorOf` (a connector→connector reference — companion
stream pairs, Level Down crossing links) using that connector map, leaving it blank
if the connector it pointed at wasn't itself copied. `fromAttribute`/`toAttribute` (a
`'d'` connector referencing an ATTRIBUTE id, not a part id) need no remapping at all,
since `attributes` are deep-cloned with their original inner `id`s intact. The real
UI (`#model-copy-btn`, next to the existing Add/Remove Model buttons) suggests a
deduplicated `"<source> copy"` name and switches Default Model to the new copy on
submit, matching Add Model's own convention. New `check_copy_model`
(`tests/run_all.py`) exercises every one of these rules directly (script preservation,
endpoint remapping, `mirrorOf` remapping, attribute-id preservation, exclusion of an
unrelated model's parts, zero new viewMembers) plus the real button/dialog; the
`mirrorOf` remap and the source-model filter both proven via TEMP BREAK — the latter's
break (iterating the LIVE `store.doc.parts` array instead of a `.filter()`'d copy,
while also pushing new parts onto that same array mid-loop) hung the test outright
rather than just failing an assertion, itself a real confirmation the filter matters.

**Model Copy also switches the Simulation toolbar's own model target**: a later direct
bug report — *"i copied a model, added all parts to new view, with new model as
default i ran simulator. It runs the original not the new copied model pointed to by
default model or active on current view."* Root cause: `store.simSelectedModel` (the
Simulation toolbar's OWN model selector, targeted by Run/Step/Stop/Reset Simulation —
see its own comment, state.js: "Which model the Simulation toolbar... currently
targets — entirely independent of this.doc.defaultModel") is deliberately decoupled
from Default Model in general, so that switching Default Model elsewhere in the UI can
never yank a running simulation out from under whoever's watching it — but Copy
Model's own submit handler only ever updated Default Model, never `simSelectedModel`,
so it silently kept pointing at the OLD (source) model after a copy, even though every
other visible signal (Default Model, the newly populated view) suggested the NEW model
was now "current." Fixed by also setting `store.simSelectedModel = v.name` in Copy
Model's submit handler, right alongside `store.defaultModel`, and applied the identical
fix to Add Model's own handler for the same "you're about to work in what you just
created" reasoning — a one-time model-creation action is never the same case the
general decoupling exists to protect against. `app.render()`'s existing
`refreshSimToolbar()` hook (already called on every render) picks up the new
`simSelectedModel` value automatically via `populateSimModelSelect`'s own
already-valid-value passthrough, so no new render wiring was needed. `check_copy_model`
gained two new assertions (`store.simSelectedModel` itself, and the real
`#sim-model-select` DOM dropdown's value after render) — proven via TEMP BREAK
(reverting just the `simSelectedModel` line), which reproduces the exact reported
symptom: Default Model shows the copy, but the Simulation toolbar's own dropdown still
reads the original.

**Property panel: UI dashboard "Value" pinning, Attributes gated to DataEntityDetails,
Script/Part Script Enabled pinned by default, scroll preserved during sim ticks**: four
independent property-panel fixes/requests from one follow-up report. (1) *"the special
ui elements numeric input, text input cannot pin the value field to the pinned area."*
UINumericInput/UITextInput's synthesized `uiInputValue` ("Value") Root Properties field
(see "UI dashboard elements" below) only ever existed in a merged spec object built
fresh inside `renderPartProperties`, never in `custom.json`'s `showFields.part.fields`
— but `renderPinnedSection` (`render.js`) always looked a pinned field's spec up via
the plain `custom.json` lookup, so pinning "Value" correctly toggled the pin state (the
button itself lives in the merged-spec-driven Root Properties section, so it renders
fine there) while the Pinned section could never find a matching spec entry for it and
silently rendered nothing. Fixed two ways together: `renderPinnedSection`'s per-source
shape gained an optional `fields` override (used INSTEAD of the `custom.json` lookup
when given), and `renderPartProperties` now computes its merged `partSpec` BEFORE
calling `renderPinnedSection` (it used to be computed after) so that merged spec can be
passed straight through as the `part` source's `fields`. (2) *"only datadatadetail
should show the special 'attributes' and 'add addtributes' portion in the properties
panel"* (i.e. DataEntityDetails) — `showFields.part.fields.attributes` (the Data
Modeling editable attribute table, `show:'a'`) used to render unconditionally for every
part type's Root Properties, even though `canvas.js`'s own on-node attribute-list
rendering already gates its display to DataEntityDetails only (`isAttributeForeignKey`'s
own doc comment references this same asymmetry). Every other part type showed an
always-empty, meaningless "+ Add Attribute" table. Fixed by extending the same
"`partSpec` computed once, used everywhere" restructuring from fix (1): a part that is
neither a UI dashboard type nor DataEntityDetails now gets its own merged spec with
`attributes` stripped, so both Root Properties AND the Pinned section (if someone
globally pins `attributes`) correctly hide it. (3) *"add the fields 'script' and 'Part
Script Enabled' to be pinned by default in current settings"* — `DEFAULT_PINNED_FIELDS`
used to be one flat array shared by all three pin groups (`node`/`connector`/`table`);
a new `defaultPinnedFieldsFor(group)` returns `DEFAULT_PINNED_FIELDS` plus
`script`/`scriptEnabled` for every group except `connector` (which has no script field
at all), used by both `getPinnedFields`'s and `getAllPinnedFields`'s empty-localStorage
fallback — a fresh browser (or one with `dycad-pinned-fields` cleared) now pins
Script/Part Script Enabled on a Part's Root Properties with no action taken. (4) *"when
simulator is running, the properties panel repositions to top each tick, can this be
removed so if user scrolls through properties while sim is running it doesn't
reposition view back to top of properties?"* Every sim tick calls `app.render()`,
rebuilding `#properties-body`'s content from scratch even when the exact same node/
edge/view is still selected. The Properties section doesn't scroll itself —
`#right-panel` (the whole right sidebar column: Filters then Properties stacked) is the
actual `overflow-y:auto` container — and its scroll position was getting clobbered on
every such rebuild with no way to tell "same thing, just updated" apart from "genuinely
different thing selected." Fixed with a new `propertiesIdentityKey(app, tab)` helper
(cheaply derives a string key from whichever of catalog-row/3d/section/no-selection/
multi-select/single-viewMember branch `renderProperties` is about to take, `null` for
the panel's various empty-hint states) plus a small restructuring: the old monolithic
`renderProperties` body moved into `renderPropertiesContent(app, tab, body)` unchanged,
and the new thin `renderProperties(app)` wrapper computes the key, snapshots
`#right-panel.scrollTop`, stores the key on `properties-body.dataset.propKey`, calls
`renderPropertiesContent`, then either restores the snapshotted scrollTop (key
unchanged from last render — same thing still selected, e.g. a sim tick) or explicitly
resets it to `0` (key differs, or is `null` — a genuine new selection), matching the
conventional "picking something new scrolls you to its top" expectation rather than
leaving that case's behavior to chance. Four new checks
(`check_pinned_field_ui_dashboard_value`, `check_attributes_field_only_for_data_entity_details`,
`check_pinned_fields_default_includes_script`,
`check_properties_panel_preserves_scroll_during_render`) — all four proven via TEMP
BREAK, the last one's negative control (a genuine selection change still resets to
top) doubling as proof that the reset-to-0 branch is deliberate, not incidental.

**UI dashboard elements** (`isUIDashboardType`, state.js; `ctx.ui`, simulation.js): a
new element group for building simple sim-driven dashboards, reported directly —
*"create a new group 'UI' of elements text_out, text_in, numeric_out, numeric_in ...
Each will have an attribute for selecting a specific part. _out will act like badges
where they display a specific value, while _in will provide ability to update values
available in script. These are to be refreshed or retrieved as part of each sim
tick."* Final naming (settled during design): `UITextOutput`, `UITextInput`,
`UINumericOutput`, `UINumericInput` — four ordinary `Part` types (see below for why
that, not a separate catalog), under a new `"UI"` `elementGroup` (`public/custom.json`
`elementGroups`/`elements`, a plain `{group, fill}`/`{type, title, group, ...}` data
addition — no `path` glyph, so they fall back to `iconSvgFor`'s own plain rounded-rect
default) and added to the `"All"` streamTemplate's own `value[]` (the 3D View's
reference type list — `check_view3d_all_template_covers_all_elements` requires every
`settings.elements` type accounted for there).

*Storage: ordinary Parts, not a separate catalog.* Considered and rejected — a
separate catalog would mean rebuilding, in parallel, everything Parts already give for
free: placement (`ViewMember`/`objectType`), canvas rendering, drag/select/delete/
copy-paste, Undo/Redo snapshotting, Save/Load JSON, the property panel dispatch, and —
the part that matters most given where this design ended up — `model` tagging and
`ctx.findParts`-style lookup, which the binding mechanism (below) leans on directly.
Two new Part fields, `uiTargetPartId` (which part this widget binds to) and
`uiInputValue` (Input types only — what a person's typed), added to `Store.createPart`
and, critically, to `migrateDoc`'s own explicit field allow-list (state.js) — the
latter rebuilds every loaded Part field-by-field rather than spreading the source
object, so a field only added to `createPart` and NOT to `migrateDoc` would be silently
stripped on every File > Load, even for a document saved WITH it. Caught during this
feature's own manual verification, before any test ever exercised a save/load
round-trip — a good example of why `migrateDoc`'s allow-list needs updating in lockstep
with any new Part field, not just `createPart`.

*Binding: a plain field, not a connector.* Reported directly, once the alternative
(reusing the connector graph, `ctx.inputs`) was raised and rejected: *"These may not be
the same values passed through connectors so are not related to connectors."*
`uiTargetPartId` is a new selector field ("Bound Part") on the property panel — a
NEW field type this app didn't have before (a part-picker), built as a merged/filtered
spec object (`renderPartProperties`, render.js, same `filteredViewSpec` technique the
Filters panel already established) rather than touching `custom.json`'s shared
`showFields.part.fields`, since these fields are meaningless for every other part type.
The picker (`selectOptionsFor`'s new `uiTargetPartId` branch) lists every OTHER part in
the WHOLE document — deliberately unrestricted to the current model or view — labeled
with its own type AND model, so a cross-model bind (see below) is a visible, deliberate
choice rather than an accident; the 4 UI types themselves are excluded from the
candidate list, so a widget can never bind to another widget. For the same reason
Script/Script Enabled are dropped entirely from a UI widget's Root Properties (they're
inert — no script/tick of their own; see `ctx.ui` below for why).

*`ctx.ui`: the fourth data-flow channel a part script can use* (alongside `inputs`,
`responses`, and the create*/find* mutators). An early proposal imagined bare
script-global variables (`UINumericOutput = UINumericInput + 5;`) — rejected once
worked through concretely: a script's own local reassignment of a bare variable/
function-parameter can never be observed by the caller after the call returns (basic
JS semantics — only object MUTATION survives a function call), so `ctx.ui` is instead
`{ UITextInput, UITextOutput, UINumericInput, UINumericOutput }`, each a plain object
KEYED BY THE BOUND WIDGET'S OWN LABEL (not a single scalar) — settled on once multiple
inputs/outputs per part was confirmed wanted ("multiple inputs and outputs per part
would be great"): `ctx.ui.UINumericOutput['Total Cost'] = ctx.ui.UINumericInput['Base
Price'] + 5;`. The two Input objects are built fresh by `collectUIInputs` (a plain
`store.doc.parts` scan for widgets whose `uiTargetPartId` points at this part) — read
directly from `uiInputValue`, a live document field, no simulation/runtime concept
involved at all, since it's just something a person typed. The two Output objects
start EMPTY and are the script's own to mutate; after a successful call,
`queueUIOutputWrites` walks every bound Output widget of that type and queues a
`{widgetId, widgetModel, value}` write — `value` is `undefined` (not `null`) for a
label the script didn't address this tick, so `canvas.js`'s own `formatSimValue`
renders it identically to a widget with no runtime entry at all — one consistent "—"
placeholder regardless of cause (reported directly: *"it stays as null or similar"* —
`undefined` is the "or similar"). `runTick`'s main per-part loop EXCLUDES all 4 UI
types entirely (`parts = allParts.filter((p) => !isUIDashboardType(p.type))`) — a
widget never computes its own value the ordinary way; an Output widget's value is
PURELY a side effect of whatever it's bound to writes, and an Input widget never gets a
runtime entry of its own at all.

*Why writes are queued, not applied immediately — the cross-model case.* A bound widget
can live in a DIFFERENT model than the part being ticked (a deliberately supported
scenario — see Model Copy, above, and the dashboard scenario below) — `runTick(app,
modelName)` only ever holds `modelName`'s own `runtime` in scope, and writing into a
DIFFERENT model's `ensureRuntime(...).values` mid-tick, or even into `modelName`'s own
`nextValues`/`runtime.values` before this tick's single atomic commit, would risk
leaking a change into another part's `ctx.inputs` snapshot this SAME tick — the
single-commit-per-tick guarantee this whole engine is built on (top-of-file comment).
So every write is queued in a local array across the WHOLE tick call and applied once,
at the very end, strictly AFTER `runtime.values = nextValues` — a same-model widget's
write lands in the map just committed (found via `ensureRuntime(store, w.widgetModel)`
returning that same object); a cross-model widget's write lands in THAT OTHER model's
own runtime instead, which this tick never otherwise touched. This also has to run on
EVERY successful tick (not skipped when a label goes unaddressed), specifically because
of the cross-model case: without an explicit `undefined` write every time, a stale
value from some earlier tick would sit untouched in the other model's runtime map
(which this tick doesn't otherwise touch at all), silently breaking "not carried over"
for exactly the scenario this feature is built to support.

*Errors: deliberately NOT "keep the last good value."* An erroring part's OWN value
keeps its last-good reading (top-of-file comment) specifically to stop a broken part's
failure from cascading through OTHER real parts' `ctx.inputs`. A UI Output widget has
no such downstream — nothing reads it via a real connector, only a human looking at a
badge — so `queueUIOutputWrites` is only ever called on the SUCCESS path; a thrown
script error means NO write is queued at all this tick, so every bound widget reads
exactly like an unaddressed label (the same "—" placeholder), not a stale number left
over from before the target broke. The erroring target's own badge already shows "ERR"
as the visible signal.

*Badges: reusing the existing mechanism, with one override.* `_out` widgets were
reported to *"act like badges"* — rather than a new rendering path, `canvas.js`'s
EXISTING value badge (`.fnode-sim-badge`, `store.simRuntime.get(part.model).values.get
(part.id)`) already does exactly the right lookup once a widget has a runtime entry —
no canvas.js changes were needed for the lookup itself. The one addition: Output
widgets show their badge regardless of the view's own `chkShowSimValues` toggle
(`isUIOutput = ciEq(part.type,'UITextOutput') || ciEq(part.type,'UINumericOutput')`),
since a fresh view defaults that toggle to `false` — relying on it here would leave a
brand-new dashboard looking completely broken until someone found and enabled "Show
Left Badge" in Filters, when for these two types the badge IS the widget's entire
reason for existing, not a secondary annotation. An Output widget with no runtime entry
at all shows a `"—"` placeholder rather than nothing, so it still reads as "a working
widget with nothing to show yet."

*Exclusion from streams/industry generation/Level Up-Down* (reported directly: *"These
would not be part of streams, industry generation, level up/down etc."*) needed no
active gating at all, on inspection — every one of those mechanisms is driven either by
real Connectors (which a UI widget never has, under this design) or explicit allow-list
data (stream templates, the SFCCE mapping) that simply never names these 4 types.
`settings.elements`-wide scans elsewhere in the app (`commands.js`'s three
`typeToFill` builders) are harmless type→color lookups, not generators — a new type
existing there adds an unused map entry, nothing more.

*The confirmed end-to-end scenario*: *"at the end of this user can create sim in one
model, copy it to a new model, and then create a new view that can show UIs from both
models in the same view and values changing as both model sims run."* Verified
directly — nothing in this app scopes a View to one model (Model Copy's own comment,
above), so a single freeform view can already hold widgets bound across two models; a
widget's OWN `.model` field (inherited like any Part) decides which model's
`simRuntime` its computed value lands in, independent of which model actually computed
it — so two widgets on one view, each bound to a different model's own target, update
completely independently exactly when their OWN model ticks. `copyModel` (above) copies
`uiInputValue` verbatim and remaps `uiTargetPartId` through the same part-id map it
already builds for connector endpoints — a same-model binding lands on the new copy's
own counterpart; a binding to a part OUTSIDE the copied model (an existing cross-model
bind) is left pointing at that same external part, since copying the model doesn't
touch it.

New tests (`tests/run_all.py`): `check_ui_dashboard_element_types_and_toolkit`,
`check_ui_dashboard_property_panel`, `check_ui_dashboard_ctx_ui_engine` (the core
read/write/label-keyed/not-carried-over/unbound/error-path behavior, via real
`sim.stepSimulation()` calls, not a static scan), `check_ui_dashboard_output_value_
display_always_visible` (renamed from `..._badge_visibility` — see the follow-up
paragraph below), `check_copy_model_remaps_ui_bindings`, and `check_ui_dashboard_cross_
model_binding` (the exact confirmed scenario above) — the cross-model routing, the
`ctx.ui` wiring itself, the value-display override, `copyModel`'s binding remap, and
the property panel field injection all proven via TEMP BREAK.

**UI dashboard canvas rendering moves from badges to the description slot**: a later
direct follow-up, reported once the badge-reuse design above was actually in use —
*"use the node space otherwise used for description as input field for inputs and to
display the output values, instead of using the badges. Leave badges available for
scripts."* Two changes to `buildNodeEl` (canvas.js), both replacing the SAME visual
slot/sizing normally used for `part.description`: (1) `_out` widgets' value — the
previous paragraph's `.fnode-sim-badge` reuse-with-an-override — now renders instead
into a plain read-only `.fnode-ui-value` div there (same "—" unset placeholder, same
"always visible regardless of `chkShowSimValues`" property, just a different slot);
(2) `_in` widgets, which had NO on-canvas representation at all before this (only the
Root Properties "Value" field), now get a REAL, live-editable `<input>` there
(`.fnode-ui-input`) instead — pre-filled from `part.uiInputValue`, committing back on
`change` with the exact same string-vs-Number conversion the property panel's own
"Value" field accessor already used, so editing either one stays consistent. The
ordinary sim-value badge logic (`view.chkShowSimValues` + a script's own returned
`leftBadge`) is now completely UNAWARE of UI dashboard types — no more `isUIOutput`
branch inside it at all — matching "leave badges available for scripts" literally:
dashboard widgets simply never touch that code path anymore, in either direction.
`part.description` itself is additionally stripped from a UI dashboard part's merged
Root Properties spec (`renderPartProperties`, alongside the pre-existing
script/scriptEnabled/attributes stripping) since it no longer has anywhere left to
display — the same "don't leave a field editable with zero visible effect" reasoning
already applied once to viewMember's fontColor/fontSize/borderColor (§11).

*Live-editing on a page that rebuilds itself every tick.* `renderCanvasPage`
(canvas.js) tears down and rebuilds its ENTIRE `container.innerHTML` on every
`app.render()` call, including every simulation tick (default 500ms) — invisible for
an ordinary node, but a `.fnode-ui-input` can genuinely be focused, mid-edit, with
characters typed but not yet committed (commit only happens on `change`, i.e.
blur/Enter). Without a fix, a tick landing mid-keystroke would silently discard
whatever was typed — the same class of bug as the properties panel's own scroll-reset
issue two paragraphs up (§11's sibling fix, `propertiesIdentityKey`), but worse here
since it's actual data loss, not just a lost scroll offset. Fixed the same way:
`renderCanvasPage` snapshots `{vmId, value, selectionStart, selectionEnd}` from
`document.activeElement` right before the teardown (only if it's one of these inputs),
then after the rebuild re-locates the same `vmId`'s new input element and restores its
live value, focus, and cursor position (wrapped in try/catch — `type="number"` inputs
throw on `setSelectionRange` in real browsers, confirmed while writing the check
below; losing just the cursor position there is harmless). The click/drag/dblclick/
contextmenu handlers on the whole node (`wireCanvasInteractions`) all gained an early
bail-out (`isUiInputTarget`) so clicking into the input focuses/places a cursor
normally instead of starting a node drag, clearing the canvas selection, or hijacking
right-click away from the browser's own cut/copy/paste menu.

New checks: `check_ui_dashboard_canvas_value_and_input_rendering` (the core rendering
swap — no badge for either UI type anymore, an ordinary scripted part's own
`leftBadge` completely unaffected, a bound/ticked Output's real value, an unbound
Output's placeholder, an Input's real pre-filled `<input>`, and committing a new value
through that real DOM input with correct type conversion for both Text and Numeric
Input), `check_ui_dashboard_canvas_input_preserves_focus_during_rerender` (the
tick-safe focus/value/cursor preservation mechanism specifically, including a negative
check that a mere re-render does NOT commit the uncommitted value), and
`check_ui_dashboard_description_hidden_from_root_properties` (description stripped
for UI dashboard parts, unaffected for ordinary ones) — all three proven via TEMP
BREAK. The pre-existing `check_ui_dashboard_output_badge_visibility` was renamed to
`check_ui_dashboard_output_value_display_always_visible` and updated to assert against
`.fnode-ui-value` instead of `.fnode-sim-badge` (its one surviving, still-relevant
assertion: the display stays visible regardless of `chkShowSimValues`); `check_left_
badge_overrides_value_display`'s own UI-Output control case was updated the same way.

**UI dashboard Output value was truncated to 12 characters**: an immediate follow-up
bug report against the change above, using the shipped example file verbatim — *"the
ui element text output appears to cut off the text: using example 'ui dashboard
elements demo.json' it shows just 'Discount app..' which isn't the full width of
available text area."* Root cause: `dashboardValueHtml` reused `formatSimValue` (the
same helper `.fnode-sim-badge` has always used) to render a UI Output's value into the
new `.fnode-ui-value` slot — but `formatSimValue` truncates any string over 12
characters plus a trailing "…", a limit that made sense for the old badge (a small,
fixed-width pill, `max-width: 70px`) but was never adjusted for the new slot, which is
`.fnode-description`-sized (wraps up to 2 lines via CSS `-webkit-line-clamp`, plenty of
room for "Discount applied (SAVE10)"). Fixed with a new `formatUiDashboardValue`
(canvas.js) — identical number/string/object formatting to `formatSimValue`, just
without the length cap, since CSS already handles genuine overflow here. `formatSimValue`
itself is untouched, so the badge (used by ordinary scripted parts' `leftBadge`, where a
tight cap still makes sense for a small pill) keeps its existing truncation behavior.
New `check_ui_dashboard_output_value_not_truncated`: a long string (the exact reported
"Discount applied (SAVE10)") renders in full, and a non-integer number still formats to
2 decimal places — proven via TEMP BREAK, reverting to `formatSimValue` and confirming
the check reproduces the exact reported truncated text ("Discount app…").

**Example file**: `public/examples/ui dashboard elements demo.json` (listed in
`examples/index.json`, File > Load Example), reported directly — *"create a new
example file showing the new 4 UI elements in a simulation."* A "Pricing Calculator"
`BusinessFunction` reads a bound `UINumericInput` ("Base Price") and `UITextInput`
("Discount Code") and writes a bound `UINumericOutput` ("Total Cost") and
`UITextOutput` ("Status") — `connectors: []` in the file itself, since binding is
entirely `uiTargetPartId`, matching the design above. Ships with Base Price 100 and
code "SAVE10" (a 10%-off total of 90 on the very first tick) so the effect is visible
immediately without editing anything first; the readme also walks through editing an
Input's Value field and Model Copy-ing the whole thing into a second, independently
steppable model. New `check_ui_dashboard_elements_example` (`tests/run_all.py`):
confirms the file is actually reachable from the manifest (proven via TEMP BREAK —
removing it from `index.json`), loads with no simulation errors, all 4 elements are
genuinely bound with zero real connectors, and the shipped values (plus an edited
Input, re-stepped) both produce the documented, correct Total Cost.

**Advanced > Generate View — TOGAF-style starter views from existing model content**
(`GENERATE_VIEW_GROUPS`/`generateSelectedViews`, `commands.js`; `App.promptGenerateView`,
main.js). Reported directly, with a specific 13-view list under four headers ("Business
Architecture Views," "Information Systems (Data & Application) Architecture Views,"
"Technology Architecture Views," "Cross-Cutting & Governance Views"): *"create a new
'Generate View' menu item under advanced tab in its own section before 'Generate
Inventory View'. This generate view item will present user with the headers... and view
names, with a selection box for each (and one to select/deselect all) and a model
selector. Upon selection, using existing parts and connectors type 'c' for specified
model, generate a view for each. Do not create new parts. if a part is missing that is
needed (for example role), identify it as needed and for what view in the message log
and put the remaining parts in the view. Provide a 'process' or similar submit button...
Format as appropriate for clean layout using remap with options, and in view note field
record remap parameters to reproduce layout of each view."*

`GENERATE_VIEW_GROUPS` is a flat, hand-authored mapping from each of the report's 13 view
names to a `requiredTypes`/`optionalTypes` pair of ArchiMate `type` names (from
`public/custom.json`'s `elements` list) — the ArchiMate/TOGAF metamodels don't define a
1:1 element-type mapping for several of these (e.g. there is no distinct "Value Stream"
element type in this tool's vocabulary at all), so each mapping is this project's own
reasonable default, not a normative TOGAF reading; `requiredTypes` are just the ones
worth calling out by NAME when absent (see the "missing" logging below) — a view still
generates from whatever `optionalTypes` parts exist even when every `requiredType` is
missing. `App.promptGenerateView` renders this single array directly (headers, then one
checkbox per view, all pre-checked, plus a synced Select/Deselect All checkbox using the
same idiom `promptAutoDetectConnectors` already established) so the dialog can never
drift out of sync with the definitions — there is no separate list to maintain. A Model
`<select>` (defaulting to Default Model) picks which model's parts to draw from.

`generateSelectedViews(app, { model, viewKeys })` — the Process button's handler — for
each checked definition: collects every Part in `model` whose type is in that view's
type list (deduped, required types checked first so partial overlaps still read
sensibly), filters `store.doc.connectors` to `connectorType === 'c'` ("connectors type
'c'" per the report — this deliberately excludes `'s'` Stream and `'d'` Derived
connectors, the same three-way `connectorType` distinction `generateInventoryView`
itself does NOT make, since that command pulls in every connector type regardless) whose
BOTH endpoints landed in the view, then creates ViewMembers exactly as
`generateInventoryView` does — **no MODELED Part or Connector is ever created**,
satisfying "do not create new parts" for real ArchiMate content by construction (there
is no code path here that calls `createPart`/`createConnector` for a real element type
at all — the one exception, a diagnostic "Parts Needed" marker, is covered in its own
paragraph below and is never mistaken for modeled content: distinct `Text` type, no
connectors, soft-red fill). A `requiredType` with zero matching parts in
`model` logs `[Generate View: <view name>] No "<type>" parts found in model "<model>" —
needed for this view. Generating with the remaining available parts.` to the Message Log
(`pushMessageLog`) — not blocking, matching "identify it as needed and for what view...
and put the remaining parts in the view" precisely. A view with NOTHING to show at all
(none of its types, required or optional, matched any part) is skipped outright rather
than creating an empty view, and that skip is logged by name too — the degrade-gracefully
counterpart the report's own wording implies but doesn't say explicitly. Layout uses
`applyRemapLayout` with the same `pattern: 'default'`/`DEFAULT_REMAP_SORT_KEYS` defaults
`generateInventoryView` uses for a clean starter layout, and (unlike
`generateInventoryView`, which calls `applyRemapLayout` directly and records nothing)
also sets `view.remapSortKeys`/`view.remapLastOptions` — the same fields `remap()`
itself records — AND writes a human-readable mirror of those same parameters into the
view's own `note` field: which template/pattern/sortKeys were used, plus a ready-to-paste
`remap(app, tab, {...})` Script Console call carrying the exact options object, satisfying
"in view note field record remap parameters to reproduce layout of each view" as an
actually actionable reproduction step, not just a structural record only Remap's own UI
reads.

**Missing required types get an on-canvas "Parts Needed" marker, not just a Message
Log entry** — direct follow-up: *"change: when generating the views requested and
parts are missing for a view, create Text part and node with label view name + '
Parts Needed' and put list of parts needed in the description field and show in view
near upper left area with soft red fill."* When a view definition has one or more
missing `requiredTypes`, `generateSelectedViews` now creates one plain `Text`-type
Part (`public/custom.json`'s `elements` list — no prefix/suffix decoration, so its
label renders exactly as given) labeled `<view name> Parts Needed`, its
`description` listing each missing type by name, and places its ViewMember using a
distinct `PARTS_NEEDED_FILL` (`#ffb3b3`, a soft red never reused by any real
`elementGroups` fill) so it reads as a diagnostic annotation, never a modeled
element. Deliberately created and placed AFTER the `applyRemapLayout` call above
(not folded into `includedParts`) — it has no connectors and isn't real content, so
feeding it into Remap as an ordinary node would be wrong on both counts; instead it's
positioned via the same `store.findNonOverlappingPosition` nudge every other
manual-placement call in this codebase already uses, from a desired point near the
view's own origin (upper-left), so it never lands on top of the just-remapped
content while still generally landing at or before it. This IS a Part-creation
exception to "do not create new parts" (see this section's opening paragraph above)
— by design, since it's diagnostic metadata about the generation run itself, not a
new piece of the architecture being modeled. New
`check_generate_view_creates_parts_needed_marker` (`tests/run_all.py`): confirms the
marker Part/label/description/fill/position for the missing-BusinessRole scenario,
and confirms NO marker at all when every required type is already present — proven
via TEMP BREAK disabling the marker-creation branch. This also meant
`check_generate_view_generates_only_from_existing_parts_and_c_connectors`'s own "zero
new Parts" assertion needed updating (that check's own fixture has a missing required
type, so it NOW also creates exactly one new Part — the marker) — its docstring and
assertions were revised to expect exactly that one new Part and to check it's
specifically the `Text` marker, rather than dropping the check's actual purpose
(verifying no MODELED content is fabricated).

**View gains a `note` field**: until this feature, `note` existed on Part/Connector/
ViewMember but not View itself (confirmed by reading `addView`'s object literal and
`custom.json`'s `showFields.view.fields` directly — there was no view-level free-text
field at all). Added the same way any new editable field is added per this project's own
convention: `state.js`'s `addView`/migrateDoc default it to `''`, `custom.json` gains a
`showFields.view.fields.note` entry (`show:'m'`, multi-line), and `render.js`'s
`viewFieldAccessors` gains a plain `get`/`set` pair — no bespoke panel needed, since
`renderViewProperties` already renders `showFields.view.fields` generically via
`filteredViewSpec`/`renderShowFieldsPanel`, the same schema-driven renderer every other
entity's panel already uses.

New tests (`tests/run_all.py`): `check_generate_view_menu_position` (own
separator-bounded section, immediately before `Generate Inventory View`, proven via TEMP
BREAK removing the second separator); `check_generate_view_dialog_matches_definitions`
(every header/view name from `GENERATE_VIEW_GROUPS` actually renders, checkbox count
matches, Select All starts fully checked not indeterminate, Model options match
`store.doc.models` — proven via TEMP BREAK dropping a group from the render); `check_
generate_view_generates_only_from_existing_parts_and_c_connectors` (a model with an
existing BusinessActor + BusinessOrganizationUnit, deliberately no BusinessRole, joined
by both a `'c'` and a same-endpoints `'s'` connector, run through the real Advanced-menu
dialog — confirms zero new MODELED Parts (the sole new Part is the "Parts Needed"
marker, below), exactly the 2 existing Parts (plus that marker) and exactly the 1 `'c'`
connector viewMember land on the new view, the missing-BusinessRole gap is logged naming
the view, and the note field records template/pattern/sortKeys — proven via TEMP BREAK
including every connectorType instead of just `'c'`, which correctly produced 2
connector viewMembers instead of 1); `check_generate_view_skips_view_with_no_matching_
parts` (a view definition matching nothing anywhere in the model is skipped, not left as
an empty view, and the skip is logged — proven via TEMP BREAK disabling the skip branch);
`check_generate_view_creates_parts_needed_marker` (the "Parts Needed" Text marker itself
— see its own paragraph above — proven via TEMP BREAK disabling the marker-creation
branch).

**Remap's Sort Priority gains "Raw label"** — reported directly: *"add raw label to
the sort priority part of remap."* `REMAP_SORT_KEYS`/`REMAP_SORT_LABELS`
(`commands.js`) gained a `'rawLabel'` entry alongside the pre-existing `'nodeLabel'`,
and `remapSortValue` a matching `if (key === 'rawLabel') return part.rawLabel || '';`
case. `Part.rawLabel` is the true pre-decoration name (distinct from the
fully-decorated `part.label` — e.g. an `ApplicationCapability`'s "Manage " prefix),
useful as a sort key whenever that decoration would otherwise scramble an
alphabetical grouping across mixed types. `promptRemap`'s own Sort Priority list
(main.js) is fully data-driven off `REMAP_SORT_KEYS` — its own comment: "start from
the remembered/default order, then append any keys missing from it" — so no other UI
code needed to change at all; the new key simply appears, appended after every
already-remembered key on first open, exactly like `elementGroup` did when it was
added. `DEFAULT_REMAP_SORT_KEYS` (the built-in default order) is deliberately left
unchanged — this is a new available option, not a change to the out-of-the-box
default. New `check_remap_sort_priority_includes_raw_label` (`tests/run_all.py`):
confirms the real dialog's `#rm-priority-list` lists it, and that
`sortKeys:['rawLabel']` genuinely orders by `rawLabel` — two parts whose rawLabel and
decorated-label orderings are deliberately REVERSED, with their ViewMembers also
created in the "wrong" order first, so a broken/no-op sort silently falling back to
stable creation order couldn't accidentally look correct — proven via TEMP BREAK,
which on the first attempt surfaced exactly that false-pass risk (the initial test
fixture only reversed Part creation order, not ViewMember creation order, so the
break didn't actually fail the check until ViewMember creation order was reversed
too) before landing on a break that correctly failed.

**Generated views get Redrawn with "Show all text"** — reported directly: *"for the
new views as a result of generate views command, run redraw with 'show all text'."*
`generateSelectedViews` now sets `view.chkShowAllText = true` and runs the same pair
Commands > Redraw's own "Show all text" checkbox uses (`promptRedraw`, main.js):
`redrawAndResolveLayout` (recompute node size to fit full content, then nudge apart
anything that growth makes overlap) followed by `store.normalizeViewCoordinates`.
Run LAST in each view's own processing — after remap AND the Parts Needed marker —
so the marker's own (often multi-line) description factors into the resize too, and
so growth from the "show all text" resize can't reintroduce overlaps remap's own
placement didn't anticipate.

Building this surfaced a real bug the hard way: the first attempt called
`redrawAndResolveLayout(app, { viewId: view.id })` — a bare object, mirroring
`generateIndustry`'s similar-LOOKING call elsewhere, but missing the `selection`
field that call actually includes. `buildNodeEl` (canvas.js, called internally by
`redrawNodeSizes` to measure each node) unconditionally reads
`tab.selection.has(vm.id)` — with `selection` undefined, this throws a TypeError,
which propagated all the way up through `redrawAndResolveLayout` with no try/catch
anywhere in the call chain, silently ABORTING the rest of `generateSelectedViews` for
that run: no active-tab switch, no summary toast, no processing of any further
selected view definitions still queued — while the already-created view/parts/
connectors up to that point stayed in the document, looking superficially fine in
every store-level assertion. This is exactly why `check_generate_view_generates_
only_from_existing_parts_and_c_connectors` and `check_generate_view_creates_parts_
needed_marker` (both store-only assertions) kept passing even with this bug live —
only `check_generate_view_redraws_with_show_all_text`'s own DOM-level assertion
(checking the real rendered `.fnode-description` element) surfaced it, since that
line never executed once the exception fired one statement earlier. Fixed by passing
`{ viewId: view.id, selection: new Set() }`, matching `generateIndustry`'s own actual
call shape exactly. New `check_generate_view_redraws_with_show_all_text`
(`tests/run_all.py`): a part with a long, multi-line-worthy description confirms
`chkShowAllText` is persisted true on the new view AND the real `.fnode-description`
element has no line-clamp truncation — proven via TEMP BREAK disabling the redraw
call outright.

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
  exactly, the SAME encoding the 2D canvas's "Show Left Badge" (renamed from "Show
  Simulation Values") badge already uses, not a new one. A 'changed' marker additionally pulses (`updateSimPulse`, its scale
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
  - **Export View as Image.** Reported directly: "enable 'export view as image' for 3d
    view." File > Export View as Image (`main.js`'s `promptExportViewAsImage`) already
    worked for a 2D canvas view (a hand-written SVG serializer, `buildViewSvgString` —
    plain `<rect>`/`<text>`/`<path>` only, no `<foreignObject>`, since an SVG containing
    embedded HTML taints a `<canvas>` on rasterization and breaks `toDataURL`/`toBlob`
    outright — with an optional SVG→canvas→PNG rasterization pass) but simply toasted
    "No view open to export." for a 3D tab, since `tab.type !== 'canvas'` there and
    there's no SVG-serializable scene to build in the first place, just a real WebGL
    framebuffer. New `captureView3DImage(tabId)` (`view3d.js`) is the WebGL-native
    counterpart: forces one synchronous `renderer.render(scene, camera)` call
    immediately before capturing, then `renderer.domElement.toBlob(..., 'image/png')`.
    This relies on the renderer now being constructed with `preserveDrawingBuffer:
    true` (`createInstance`) — without it, whether a capture returns real pixels or a
    blank/black image depends on exactly when the browser decides to clear the
    drawing buffer after the last `requestAnimationFrame`, timing the app has no
    control over; the extra `preserveDrawingBuffer` cost (the browser can't just
    discard the buffer each frame) is an accepted tradeoff for reliable export.
    `App.exportView3DAsImage` (`main.js`) reaches this through `canvas.js`'s new
    `getView3DModule()` — returns the module's already-lazy-loaded reference (set once
    `view3dModule` is populated by `renderView3DPage`'s own dynamic `import()`) rather
    than importing `view3d.js` eagerly from `main.js`, which would defeat the whole
    point of the lazy-load described above. `promptExportViewAsImage` now branches on
    `tab.type === '3d'` before its existing `'canvas'` check and skips straight to
    exporting — no SVG/PNG format-picker modal, since PNG is the only meaningful
    choice for a rendered 3D scene — reusing the exact same `Blob` → `URL
    .createObjectURL` → synthetic `<a download>` → `revokeObjectURL` pattern
    `exportViewAsPng`/`exportViewAsSvg` already use.
  - **`buildViewSvgString` ignored the view's own display checkboxes.** Reported
    directly: *"when user does 'export view as image' both types of connectors appear
    hard coded to show up in image but should only be whatever was selected by view
    checkboxes for connectors or streams."* Then, clarifying: the view's own property
    panel (click the view background, not a node/connector) has checkboxes for
    **Connectors, Streams, Data, Types, Description, Attributes, Keys, Show Simulation
    Values, and Show Script Badge** (`chkShowConnectorType`/`chkShowStreamType`/
    `chkShowDataType`/`chkShowElementTypes`/`chkShowDescription`/`chkShowAttributes`/
    `chkShowKeys`/`chkShowSimValues`/`chkShowScriptBadge`) — *"User selection of these
    when in view tab should also be applied when creating print or image
    representation of view."* Root cause: `buildViewSvgString` is a genuinely
    SEPARATE, hand-written renderer from the real on-screen canvas (`redrawEdges`/
    `buildNodeEl`, `canvas.js`) — Print already gets every one of these for free (it
    clones the real, already-filtered on-screen DOM, `printViews`' own doc comment),
    but the SVG/PNG export path builds its own image independently and had simply
    never been taught about six of these nine toggles. `chkShowElementTypes`/
    `chkShowDescription` already worked; the connector loop now skips a connector
    whose type's own checkbox is off (matching `redrawEdges` exactly), and the node
    loop now also draws attribute rows (`chkShowAttributes`, DataEntityDetails only,
    reusing `isAttributeForeignKey`, `render.js`), the `vm:`/`obj:` debug id text
    (`chkShowKeys`, on both nodes and connector midpoints), and the two live-simulation
    badges (`chkShowSimValues`/`chkShowScriptBadge`, reading `store.simRuntime` — the
    same state `buildNodeEl` reads, via a newly-exported `formatSimValue`,
    `canvas.js`) — all gated exactly like `buildNodeEl`'s own conditions, just
    hand-drawn as SVG `<rect>`/`<text>` instead of styled `<div>`s.
  - **`buildViewSvgString` ignored `view.routingStyle`/`routingStyleStream` too.**
    Reported directly: *"view options 'Connector Routing' and 'Stream Connector
    Routing' are ignored when exporting view to image."* Same root cause as the
    checkbox gap above — being a genuinely separate renderer, the connector loop had
    its OWN hard-coded shape rule (always a fixed gentle curve for `'c'`, always a
    plain straight line for anything else) and never once read either routing field or
    called `computeRoutedPath` (`routing.js`, §6.2) — the same obstacle-avoiding router
    `drawEdge` (`canvas.js`) already uses on-screen. Fix mirrors `drawEdge`'s own
    branching exactly: look up `routingStyle` per connectorType (`'s'` uses
    `routingStyleStream`, everything else uses `routingStyle`), and for `'direct'`/
    `'manhattan'` call `computeRoutedPath` with the OTHER placed parts as obstacles,
    falling through to the pre-existing curve/straight-line shapes otherwise. The one
    wrinkle unique to this exporter: its endpoints (`fc`/`tc`) are computed already
    shifted by `-ox`/`-oy` (the export's own local coordinate frame, content starting
    at `(0,0)`), but `computeRoutedPath`'s obstacle search reads `fromVm`/`toVm`/every
    obstacle's OWN `.x`/`.y` directly — so routing is computed entirely in RAW,
    unshifted view-space (mirroring `drawEdge`/`edgeEndpoints` exactly, via a local
    `fcRaw`/`tcRaw` pair) and only the FINAL resolved path points get shifted by
    `-ox`/`-oy` afterward, same as every other shape in this export. Mixing the two
    frames (e.g. routing against already-shifted endpoints but raw obstacle rects)
    silently produces a wrong-shaped detour rather than an error — proven as a real
    failure mode via TEMP BREAK, not just theorized.

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
  wired in the data model (create/persist correctly) but are never read during
  rendering — editing them would have no visible effect. Found via a deliberate
  field-by-field audit (see `RECREATION_PROMPT.md` §12); worth repeating after future
  property-panel work. Reported directly: *"in view property panel the Font Color,
  Border Color, and Font Size have no affect. Change to hidden if that is still
  available in custom.json showFields, otherwise just remove from property panel
  display, may be implemented later."* The three `viewMember` fields are now
  `show: 'h'` in `custom.json`'s `showFields.viewMember` — `renderShowFieldsPanel`
  (`render.js`) already skips any field with `def.show === 'h'`, in both the main
  panel body and the "📌 Pinned" section (same function, called with a merged spec),
  so this hides them everywhere with no other code change. `view.margin` is left
  alone — not reported, and less obviously dead (a view-level setting, not a
  per-node one someone would notice has no effect while directly editing a node).
  New `check_viewmember_font_border_fields_hidden` (`tests/run_all.py`): a real
  selected node's property panel confirms all three field inputs are absent, while a
  genuinely-working sibling field (`fillColor`) stays present — proven via TEMP
  BREAK.
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
