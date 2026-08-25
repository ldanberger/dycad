// version.js — visible build version. Increment the minor number each rebuild.
// History: 0.1 = Step 4 (markers/copy-paste/remap/etc.), 0.2 = Step 5 (remap rework,
// resizable panels, lasso partial-overlap, connector-type filter, key display),
// 0.3 = Step 6 (sections/grid layout, right-click context menu, view-type picker),
// 0.4 = fix: Generate ignored sections (stacked/spread nodes), title-section sizing,
// 0.5 = fix: repeated Generate calls overlapped (fixed anchor + wasted placer slots),
// 0.6 = fix: missing .fnode CSS selector (nodes lost position:absolute),
// 0.7 = Step 7 (single-node level-down on double-click, section toolkit filter,
// drag/drop section-targeting fix, header reorg, version tooltip, mouse position),
// 0.8 = Step 8 (data-driven showFields property panels, connector relationship
// defaults, Merge command, collapsible panels, selection-list growth, view-rename
// cascade, tab-close currentView sync),
// 0.9 = Step 9 (uniform/no-overlap node placement, relationshipPairs.default,
// multi-select bulk editing, Remap sort-order prompt, Generate Stream rename,
// view-scoped stream filter),
// 1.0 = Step 10 (fix: connect handle clipped by Step9's overflow:hidden; fix: Generate
// Stream's stepY ReferenceError silently killed passive nodes + delayed rendering;
// Redraw command + per-view node sizing; Remap calls Redraw first + remembers sort
// order per view; multi-select stream filter; curved 'c' connectors; catalog
// column-sort + row-select-to-properties, including the part entity panel),
// 1.1 = Step 11 (live relationshipStyle lookup for connector line drawing + role-name
// tooltips; view connector-visibility split into Connectors/Streams checkboxes;
// stream-filter dropdown left-edge cutoff fix).
// 1.2 = Step 12 (fix: malformed custom.json from user upload; description field +
// chkShowDescription; auto-redraw/de-overlap on content-changing view toggles; dual
// connector creation on stream-connector creation using relationshipPairs.default;
// shared-stream connector tooltips; editable-vs-readonly field styling; connector
// streams field accessor).
// 1.3 = Step 13 (fix: missing description accessor in the viewMember/part panels; fix:
// stream tooltip leaking onto non-stream connectors; GenerateInventoryView menu item;
// per-view node spacing control (spacingScale) with freeform centroid-scale transform,
// section-grid live cell scaling + existing-position re-snap, and threading through
// Remap/no-overlap-placement spacing math).
// 1.4 = Step 14 (fix: Level Down's dedup logic deleted 'c' connectors that shared a
// crossing boundary with their dual 's' sibling; connector relationship dropdown now
// filtered by relationshipPairs for the actual type pair; Generate Stream defaults to
// Enterprise template; new views start with Streams off / Description on, Generate
// Stream auto-enables Streams; Remap connectivity-based ordering (connectionOrder sort
// key, freeform views only, section-based views skip the sort-priority modal).
// 1.5 = Step 15 (additive spacing stepper; fix: multi-select connector relationship
// dropdown wasn't filtered by relationshipPairs; Generate Stream xId-based find-or-
// reuse for function/capability/entity nodes (fixing two real bugs found along the way
// — passive-node businessFunction coverage, and over-broad category-range reuse
// collapsing supporting node types); new Generate Industry command).
// 1.6 = fix: edges silently clipped beyond a hardcoded fixed 4000x3000 canvas world
// (now sized dynamically to actual content, e.g. Generate Industry's 11000px+ tall
// layouts); fix: no-overlap placement search and Generate Stream's spacing math used
// hardcoded default node dimensions instead of the view's actual current (possibly
// grown, e.g. via Redraw) node size.
// 1.7 = Step 16 (Add Existing command: filterable/sortable/multi-select parts picker
// with optional connector inclusion; duplicate-connector prevention on manual connect,
// enforcing a unique from/to/model/connectorType combination with a confirm-to-reuse
// prompt instead of silently creating parallel duplicates).
// 1.8 = Step 17 (fix: missing Add Existing icon glyph; Add Existing select/deselect-all
// matching filters; Remap redesigned for freeform views — Stream Template selector,
// pluggable Pattern selector ('default'/'none'), zoom-aware column estimation, optional
// unlimited columns, and the new precise 'default' pattern: stream-name row grouping,
// streamTemplate.value ordering within a group, main content starting at the second
// row, passive nodes placed one row above their own group's first row).
// 1.9 = Step 18 (Advanced menu label spacing; default pattern also starts a new row on
// element.group change within a stream; new elementGroup sort key; Remap priority UI
// replaced with a single reorderable up/down list covering all 6 keys, avoiding
// duplicate selections by construction).
// 2.0 = Step 19 (default pattern: only passive elements whose type is absent from
// streamTemplate.value get special row-above placement — elements present in
// value[], like Enterprise's *Process types, are now treated as ordinary chain content
// in their natural element.group row; special elements target the row above their OWN
// group's row, tracked per stream+group; Remap modal gets a Reset button restoring
// built-in defaults).
// 2.1 = Step 21 (fix: Add Existing Parts' "include connectors" now includes all
// connector types, not just 'c' — was incorrectly excluding stream-type connectors).
// 2.2 = fix: multi-stream nodes (reused across streams via xIds find-or-create) were
// sorted/grouped in Remap using streams[0] regardless of the current view's actual
// content, isolating them onto their own row instead of grouping with their correctly-
// ordered peers; now resolves each part's view-relevant stream (most popular among
// other parts actually present) instead of blindly using the first stream tag.
// 2.3 = Step 23 (Populate From Template command — first real consumer of custom.json's
// templates data: match-or-create parts by xIds+Default Model, section-eligibility
// gating using the current view's real sections rather than the template's own
// sectionId hints, connectors created with relationshipPairs.default rather than the
// template's own relationship hint).
// 2.4 = fix: Populate From Template discarded every template part's sectionId hint
// unconditionally; now honors it whenever it validly names a section the current view
// actually has and that section allows the part's type, falling back to "first section
// that allows this type" only when the hint doesn't apply — placement mechanism
// switched to always-freshly-scanned findFreeCellInSection calls throughout.
// 2.5 = Step 25 (data: removed the invalid-sectionId test template from custom.json,
// applied as a targeted diff to preserve this build's own schema additions; fix:
// section-based views' grid cell size now derives from the view's actual current
// nodeWidth/nodeHeight instead of a fixed constant, and Redraw/Remap now re-snap
// existing section-placed nodes to the newly-resized grid whenever node size changes).
// 2.6 = Step 26 (fix: Remap on a section-based view ignored sections entirely and threw
// every node to the top-left via freeform row/column math; now keeps each node in the
// section it's already assigned to and only reorders/repositions it within that
// section's own grid, spilling downward past declared capacity rather than overlapping
// or losing nodes; unassigned/orphaned-section nodes fall into an overflow grid below
// all sections. Double-clicking a node with no linkedViewName and no matching-name view
// (openOrCreateLinkedView's 'Neither' case, via levelDownSingle) now also places a
// non-external copy of the node itself as the new view's anchor, and recreates each
// crossing connector inside the new view against isExternal copies of the other-side
// neighbors — deduplicated per neighbor, positioned at a fixed x (900 if this node was
// the from side, 20 if to) stacked vertically — reusing the same approach as a portion
// of multi-node Level Down. The original node's own viewMember is untouched, staying in
// the old view exactly as before.
// 2.7 = Step 27 (fix: Level Up was node-specific — required selecting exactly one node
// — when it's meant to operate on the whole view; now enabled for any canvas view with
// no selection required, creates a "created node" placeholder representing the ENTIRE
// leveled-up view (same drill-down-link mechanism as before, keyed to the view's own
// name instead of one node's label), plus an isExternal copy of every node currently in
// that view, each wired to the created node with a new connector — leveled-up view
// itself is untouched. New Section Property Panel "Duplicate Section" button: inserts a
// copy of the current section's definition immediately below it (sectionId/name
// incremented, e.g. "esf" -> "esf2" / "Enterprise Scope Functions" -> "Enterprise Scope
// Functions 2", all section order numbers adjusted), duplicates every part currently
// placed in the original section as genuinely new Part records placed into the new
// section's grid, and duplicates (with new ids) any connector whose both endpoints were
// among the duplicated parts.
// 2.8 = Step 28 (fix: Level Up was duplicating EVERY node in the leveled-up view instead
// of just its already-external boundary/context nodes — now filters to vm.isExternal
// only; fix: Duplicate Section's free-cell placement could leave nodes visually
// misplaced relative to the view's other sections, so it now runs the (already
// section-aware, per Step 26) Remap layout once at the end instead of re-deriving that
// placement math; Duplicate Section's new parts now get an incremented label too, e.g.
// "Audit" -> "Audit 2", same trailing-number convention as the sectionId/name increment;
// fix: selecting a row in any Catalog table reset the table's scroll to the top on every
// click — the whole table DOM (a brand-new element each time) was being torn down and
// rebuilt on every render, discarding scroll position; now captures/restores scrollTop
// across that rebuild so the selected row stays visible).
// 2.9 = Step 28 follow-up (fix: flipping custom.json's showFields.viewMember.isExternal
// .access to "w" correctly switched the field to a checkbox but it couldn't actually be
// toggled — its accessor's set() in the node property panel was a hardcoded no-op left
// over from when the field was display-only; same no-op existed in the multi-select
// bulk-edit path. Both now actually write vm.isExternal. custom.json's viewMember.
// isExternal.access is now shipped as "w" so the field is editable by default).
// 3.0 = Step 29 (fix: Generate Industry — createStream's xIds+model reuse already
// covered the function/capability/entity anchor parts (verified: zero duplicate
// (xIds,model) pairs even before this fix), but the ~16 "supporting" chain positions
// per stream have no crossref id in the industry data at all, so a second full re-run
// of the same industry was creating a complete fresh duplicate supporting chain for
// every entity — 576 extra parts / 2016 extra viewMembers observed in testing on a
// single re-run. Now records each successfully-generated (function, capability) pair
// against its entity anchor part; re-running skips any triple already recorded, reusing
// what's there instead of recreating it. Keyed on the (function, capability) pair rather
// than the entity alone, so the legitimate case of the same entity appearing under two
// different capabilities — verified still produces two distinct supporting chains —
// remains untouched, matching the prior fix that stopped over-broad xId reuse from
// collapsing genuinely different supporting node instances).
// 3.1 = Node Scripting / Simulation, v1. New: Part gets `script` (JS source, run as the
// BODY of a function via new Function('ctx', script) — ctx = {part, inputs, state, tick},
// must return {value, state}) and `scriptEnabled`. Tick-based engine (js/simulation.js):
// every node computes against a fully-COMMITTED snapshot of last tick's outputs, new
// outputs only swap in once every node has run that tick, so evaluation order within a
// tick never matters and cycles/feedback loops work without special-casing. Every
// connector currently in the view ('c' and 's' both) counts as a sim edge. Unscripted/
// disabled nodes pass their single input through unchanged (idle if 0 or 2+ inputs). A
// thrown script error is caught per-node — keeps its last good value, logs the error,
// every other node still runs that tick. Sandboxing is intentionally the simplest form
// (main-thread new Function, no Worker) — accepted tradeoff: a single script's infinite
// loop WILL hang the tab; Run Simulation is setTimeout-chained between ticks so Stop
// stays responsive and can still halt a runaway multi-tick run. New Advanced-menu
// commands: Step/Run/Stop/Reset Simulation, Show Simulation Log (reuses the existing
// catalog table renderer's scroll/sort plumbing, pulled live from a per-view log
// capped at 500 entries), Save/Load Simulation Snapshot (separate file format from
// Save/Load JSON — tick, timestamp, per-viewMember value/state, log; load tolerates
// viewMembers that no longer exist rather than crashing). Runtime state (store.
// simRuntime, store.simLog) deliberately lives outside store.doc so it's automatically
// excluded from Save/Load JSON — verified via round-trip test. New view toggle
// chkShowSimValues shows each node's live value as a small badge (bottom-left corner;
// red + "ERR" on script error). Script field is edited inline in the existing property
// panel (multiline textarea, show:'m' — no new modal needed) with Tab-to-indent since
// it's code, not prose.
// 3.2 = Message Log. New read-only textarea in the left panel, directly below Position,
// showing a running console scripts can write to via ctx.log(message) during a tick —
// separate from the per-tick Simulation Log, for free-form narration. Each entry is
// prefixed with an HH:MM:SS timestamp and the writing node's label; newest message
// always at the top. Backed by store.messageLog (capped at 500, non-persisted — same
// exclusion pattern as simRuntime/simLog). Global across the whole session rather than
// scoped to one view, since it's a single always-visible sidebar element rather than a
// per-view tab.
// 3.3 = Step 31. New "File" menu (top row, before Catalogs): Save/Load (same routines as
// the existing Save JSON/Load JSON header buttons, which are otherwise untouched),
// separator, Load Example (reads public/examples/index.json — a manifest is required
// since a static site can't list a directory itself; adding a future example means
// updating both the folder and this manifest), separator, Import Data (prompts the
// three specified checkboxes; actual import behavior explicitly deferred), Export Data
// (stub, deferred). New "Simulation" menu (top row, after Advanced) — all 7 simulation
// commands (Step/Run/Stop/Reset/Show Log/Save Snapshot/Load Snapshot) moved out of
// Advanced into it. New centered toolbar buttons: Step/Run/Stop/Reset — share the exact
// same action dispatcher as their Simulation-menu counterparts so the two triggers can't
// drift apart. New: store.dirty, set by any model edit (via recordHistory), cleared by
// Save/Load JSON and Load Example — drives a new "Unsaved changes: Save & Load / Discard
// & Load / Cancel" prompt shown before File > Load or File > Load Example proceeds.
// "Erase existing data" on Load/Load Example needed no separate implementation — it's
// already inherent to loadFromJSON's full store.doc replacement. New public/examples/
// folder with "basic script.json" (the verified Counter->Summer scripting demo) as the
// first entry.
// 3.4 = Step 32. Simulation engine reworked from view-scoped to MODEL-WIDE, with real
// multi-model concurrency: the graph is now built directly from Part/Connector records
// filtered by model (no viewMember indirection), so a Part has one shared simulated
// value/state across every view that displays it. store.simRuntime/simLog rekeyed from
// viewId/viewMemberId to modelName/partId; new store.simRunning: Map<modelName,
// {timerId}>, independent of any tab (fixes a confirmed bug where a run become
// unstoppable through the UI once its originating tab was closed). New dedicated
// simulation model selector in the toolbar (entirely independent of the existing
// "Default Model" selector, which remains only for new-node creation) — Step/Run/Stop/
// Reset/Show Log/Save+Load Snapshot all act on whichever model is selected there; two+
// models can run simultaneously by selecting each in turn and clicking Run. Run button
// shows a depressed/active state whenever the currently selected model has an active
// run, re-checked on both selector change and every render. Badges (canvas.js) now look
// up by part.model+part.id instead of view+viewMember. Snapshot format changed to
// {..., model, values: {partId: ...}} (was {..., viewId, values: {viewMemberId: ...}}).
// New ctx.secrets (read-only mirror of store.localSettings) and ctx.setState(patch) —
// for async work (e.g. fetch) whose response arrives after a tick's synchronous script
// call has returned; setState queues a patch merged into that part's state at the START
// of the next tick, preserving the "every tick's outputs commit together, once"
// guarantee (verified: a patch queued via a resolved microtask during tick 0 was NOT
// visible until tick 1). New File > Load Local Settings: reads a flat {key: value} JSON
// file into store.localSettings — memory-only, does not survive a page refresh (must be
// re-loaded each session), unrelated to tab/view lifecycle so unaffected by closing/
// reopening tabs. Never touches Save/Load JSON.
// 3.5 = Step 33 (fix: Generate Stream modal no longer closes on an outside click —
// scoped via a new promptModal `closeOnOutsideClick` option, every other modal keeps the
// old default; fix: createStream/createPassiveNode/populateFromTemplate now also find-
// or-reuse an existing part by LABEL + MODEL when there's no xIds anchor match (was:
// always fresh, per a deliberate earlier design choice — now explicitly relaxed per
// spec), and do the same for connectors via a new findOrCreateStreamConnector helper —
// covers Generate Stream, Generate Industry (calls createStream internally), and
// Populate From Template; deliberately NOT extended to Duplicate Section/Merge/Split
// Node, which exist specifically to create new distinct parts even with overlapping
// labels; fix: Merge command now unions the streams field from every merged part onto
// the survivor, deduplicated. New generic text-edit modal (app.promptTextEdit) — Save/
// Cancel for writable fields, Close-only for readonly — opened by double-clicking any
// text-type field's label in the property panel (any entity) or the Message Log header
// (always readonly there). New engine field `changed` on each simulation runtime entry
// (true when a part's value differs from last tick, never true on tick 0) driving a
// third badge visual state distinct from error — added specifically to make the new API-
// call example demonstrate "badge changes color on new data" using genuine engine
// behavior rather than misusing the error state. New examples: "variable reference
// demo.json" (date/time, ctx.part attributes, incoming/outgoing packet content, new
// script variables) and "api call with secrets demo.json" (ctx.secrets placeholder +
// ctx.setState + automatic changed-badge on the receiving node) — both added to
// public/examples/index.json. Import Data fully implemented: bespoke modal (file picker
// or, via a new "Use example file" checkbox, the same examples manifest) plus the three
// existing checkboxes now drive a real merge — newKeys regenerates part/connector ids
// and rewrites every reference; without it, matching ids get their fields shallow-merged
// (imported data wins) rather than duplicated; the view/model checkboxes each either
// redirect every reference to the current view/model or merge the source's own
// views/models entries in, same id-merge rule. viewMembers are always appended fresh
// (never deduplicated by id, not asked for).
// 3.6 = Step 34. Example files (basic script.json, variable reference demo.json, api
// call with secrets demo.json) now use the real element-group default fill color
// (#ff5e61 for type 'Unknown') instead of hand-picked colors — same convention future
// examples should follow. New store.loadedFileName (non-persisted): set by Load JSON,
// File > Load, and File > Load Example (NOT Import Data, which merges rather than
// replaces) — shown in the header next to the version, exposed to scripts as
// ctx.loadedFileName. New bidirectional "response" channel on every connector: a
// script's return may include an optional `response` (single value, not a queue —
// broadcast to every node that sent this part forward data, i.e. its own ctx.inputs
// sources), delivered one tick later via a new ctx.responses array (mirrors ctx.inputs'
// shape: fromPartId/fromLabel identify the responder, so scripts never hardcode which
// neighbor they're talking to). Needed no new engine bookkeeping for "don't resend" —
// falls out naturally from the existing two-phase-commit model (a response only exists
// in the runtime for the one tick it's set, gone the tick after unless explicitly
// reset) — verified via a request/response pair where each distinct ack was delivered
// exactly once, one tick behind, with zero duplicates across 5 ticks. New: Save JSON
// button turns bright green (#22c55e, distinct from the existing accent/danger/badge
// palette) whenever store.dirty is true (unsaved changes), reverting immediately on
// save — reuses the Step 31 dirty flag, no new tracking.
// 3.7 = Step 37. Generate Stream's "Function Name" field is now a combo field (new
// promptModal field type: text input + native <datalist>) suggesting existing
// BusinessFunction-type parts in the current model — still free-text, so typing a new
// name works exactly as before. Purely a discoverability aid: actual reuse-by-label
// already happens in createStream (Step 33), no new reuse logic needed. Scoped to
// Function Name only, not Capability/Entity Name (not asked for). New example file
// "response packet demo.json" demonstrates ctx.responses/response — verified zero
// script errors and exactly one delivery per distinct response across 5 ticks, no
// duplicates.
// 3.8 = Bug fix (reported after v3.7): Generate Stream was producing reversed/
// bidirectional connector pairs between the same two parts. Root cause: the Step 33
// "reuse by label+model" fallback (createStream's main loop, createPassiveNode,
// populateFromTemplate) matched on label alone — but many chain positions in the
// Enterprise template render to the SAME label text despite being different element
// types (e.g. GeneralCapability/ApplicationCapability/TechnologyCapability all have
// blank prefix/suffix, so all three render as bare capabilityName). Label-only matching
// collapsed these onto one shared part; since the chain connects strictly by array
// position, that produced both-direction connectors between the same two parts — a
// reintroduction of the exact over-broad-reuse failure mode the earlier Step 15 fix was
// built to prevent. Fixed by requiring TYPE to also match at all three sites (label +
// type + model). Verified: a repro that previously showed 4 reversed pairs and only 9
// parts (chain collapsed) now shows 0 reversed pairs and the full 18 distinct parts per
// entity chain; re-running with the same names still correctly reuses (idempotent,
// verified 0 new parts on an exact repeat); a second entity under the same function/
// capability still correctly shares the upper chain while getting its own distinct
// lower chain; Generate Industry's Step 29 idempotency and zero-reversed-pairs also
// reconfirmed unaffected.
// 3.9 = Bug fix + new feature. Fix: chkShowSimValues was never showing up in the View
// property panel most people actually use ("nothing selected — showing view settings"),
// because render.js has TWO separate places that build the View entity's accessors —
// it had only been added to one (the Views-catalog-row panel), not the other. Both now
// carry it. New: script-controlled second badge. A script's return may include
// `badge: { text, color }` — freeform text and any CSS color, fully script-controlled,
// rendered bottom-right (nudged in 2px from the corner to avoid the connect-handle
// circle that also lives there) as `.fnode-sim-badge-right`, independent of the
// existing auto-computed value badge at bottom-left. Computed fresh from the script's
// return every tick, same rule as value/state/response — NOT auto-persisted; a script
// that wants its badge to keep showing just returns it again (the script already runs
// every tick regardless). Gated by its own new view toggle, chkShowScriptBadge,
// completely independent of chkShowSimValues — verified both badges render
// simultaneously with correct freeform color, the badge disappears the tick a script
// omits it, and each visibility toggle only affects its own badge.
// 3.10 = New example file "right badge chain demo.json": A -> B -> C. A generates a
// random number each tick and forwards it; B appends a random letter and forwards the
// combined value to C, also acknowledging A with a response; C shows what it received
// in its own right-side badge and responds to B with a random number. A and B each show
// whatever came back to them via ctx.responses in their own right-side badge (distinct
// colors per node). Verified end to end: forward chain propagates correctly one tick per
// hop, both response deliveries (C->B and B->A) land exactly one tick behind when they
// were set, zero script errors across 6 ticks, and both badge types (value + script)
// render simultaneously and correctly on all three nodes.
// 0.38 = Step 38. Versioning scheme reset here per explicit instruction: from this point
// forward, increment the minor by exactly 0.01 per build (0.38 -> 0.39 -> 0.40 -> ...),
// replacing the previous ad-hoc 3.x sequence. Renamed "Script Enabled" to "Part Script
// Enabled" in the property panel (both the part and viewMember entities in custom.json)
// to avoid confusion with other things "script" could mean. Fix: copying a node
// (mode==='new' paste) was silently dropping script/scriptEnabled on the new part —
// createPart wasn't passed those fields at all. New: Pause/Continue toggle for
// Simulation — pausing keeps the run's entry in store.simRunning (Step/Stop/Reset still
// see it as live, Run's "active" indicator stays on) but stops its timer; Continue
// resumes at the original interval with no re-prompt. Single toggle button in the
// toolbar (label/state flips between Pause and Continue based on the selected model's
// paused flag); Simulation menu gets both as separate items. Toolbar order changed to
// model selector, Run, Pause/Continue, Step, Stop, Reset, per instruction. Fix: Remap's
// spacing formula only scaled the small additive gap constant (nodeW + 40*spacing), not
// nodeW itself — the dominant term — so a spacingScale of 1.8 barely changed the visual
// layout despite the field correctly holding 1.8, while applySpacingScale (used when the
// Spacing field itself is edited) proportionally scales the WHOLE existing layout.
// Changed to (nodeW + 40) * spacing so Remap's result now actually looks ~1.8x wider,
// consistent with what a direct Spacing-field edit already produces, instead of
// regressing back toward the unscaled default every time Remap runs. Fixed in both the
// freeform and section-overflow layout branches.
// 0.39 = ArchiMate import. Added 44 element definitions to custom.json's `elements`
// array (76 total now) covering every type found missing in the earlier gap analysis of
// a real ArchiMate 3.0.1 exchange-format test file — group values pulled from that
// file's own <organizations> folders, collapsed onto FlowRun's existing elementGroups
// color keys (Strategy+Motivation -> Strategymotivation, Technology&Physical ->
// Technology, Other -> General); cornerRadius follows the spec's own square=structure/
// round=behavior rule where it didn't conflict with FlowRun's already-established
// per-family conventions; icons are original simple line-art in the same coordinate
// space as existing icons, reusing FlowRun's own family glyphs where a natural match
// exists (Capability grid, Interface lollipop, Object header-bar) rather than tracing
// any specific copyrighted illustration. New File > Import ArchiMate command (new
// js/archimate.js module) parses an ArchiMate Exchange Format XML file (elements +
// relationships only — <organizations> has no FlowRun equivalent so isn't imported;
// <views> are explicitly out of scope for now, so imported parts/connectors exist in
// the model but aren't placed on any canvas until added manually or a future step adds
// view import) and merges them into store.doc, always keeping the exchange format's own
// <identifier> values as the Part/Connector id and merging by id — re-importing the same
// file is idempotent by design, verified: importing the real 219-element/232-relationship
// test file twice produced identical counts both times, not double. AndJunction/
// OrJunction elements import as plain Parts with no special routing behavior — the
// multi-way relationship semantics are explicitly deferred to a future step, to be
// handled via node script logic rather than hard-coded into the importer. Verified end
// to end against the real uploaded file: exact 219/232 part/connector counts, a
// previously-unrecognized type (Capability) now imports correctly typed, zero
// unrecognized types remain across all 56 distinct types in the file, and the imported
// data round-trips cleanly through Save/Load JSON.
// 0.40 = New element-type view filter, positioned right after the Stream filter in the
// toolbar (tab.activeElementTypes, same empty-means-show-all convention as
// tab.activeStreams). Pure visibility filtering — deliberately no auto-select side
// effect (unlike Stream's). Connectors need no separate check: redrawEdges already
// skips any connector whose endpoint isn't in the filtered partVms list, so hiding a
// type's nodes automatically hides their connectors too — verified (filtering to one
// type left the edge layer empty). New dynamic per-elementGroup toolkit filter chips
// (store.activeElementGroups), positioned between the existing sources chips and the
// element icon grid — one chip per group actually defined in store.settings.
// elementGroups (not a fixed list), all on by default, same chip-toggle pattern as the
// sources filter. Verified: 76 tiles with everything on, 64 after disabling "Business"
// (exactly the 12 Business-group elements removed), fully restored after re-enabling.
// New example files: the three uploaded ArchiMate exchange XML files placed in
// public/examples/ (Test Model-3.0.1.xml, ArchiMate 3.0.1 complete.xml, Test
// Model-3.0.1 exported from SA.xml) — deliberately NOT added to examples/index.json,
// since that manifest is consumed by Load Example and Import Data, both of which
// JSON.parse the fetched content; adding XML entries there would break those flows if
// selected. Import ArchiMate still uses a plain OS file picker, unconnected to this
// folder — wiring an in-app picker for these (mirroring Import Data's "use example
// file" checkbox) would be a natural follow-up but wasn't asked for here.
// 0.41 = Element type filter improvements. New Select All / Exclude All row at the top
// of the menu — required a small semantic change to support "exclude all" (hide
// everything): tab.activeElementTypes is now null (unset, show everything) vs an
// explicit array (even an empty one, meaning show nothing) rather than the old
// empty-means-unfiltered convention, which couldn't represent "show nothing" at all.
// Items now sort by and display each type's TITLE (looked up from store.settings.
// elements) instead of the raw type string — e.g. "Application Logical Component"
// instead of "ApplicationLogicalComponent" — while the underlying filter value is still
// the raw type, unaffected. List wrapper capped at a 540px scrollable max-height
// (~20 rows) so it doesn't grow unboundedly with many types — verified with 25 types:
// confirmed both the max-height/overflow CSS is applied and that the content actually
// exceeds the visible area, so scrolling is genuinely needed and working, not just
// configured. Verified end to end: Exclude All hides every node, Select All restores
// them all, individual toggling still works and correctly keeps the Select All
// checkbox's own state in sync (checked only when everything happens to be checked).
// 0.42 = ArchiMate import: junction flattening + full view import. Junctions
// (AndJunction/OrJunction) are no longer imported as Parts at all — every incoming
// source of a junction is directly connected to every outgoing target (the full cross
// product), using the relationship type of the edge closest to each real target;
// chained junctions (one feeding another) resolve recursively back to real endpoints,
// deduplicated globally so a chain can't produce the same direct connector twice. Each
// affected target part's `note` gets "incoming uses AND logic" / "incoming uses OR
// logic". AndJunction/OrJunction removed entirely from custom.json's elements array —
// no longer pickable in the toolkit. New: <views>/<diagrams>/<view> are now imported as
// real FlowRun Views — recursively walks (possibly nested) <node> elements for
// placement (skipping nodes with no elementRef — pure visual/group/label boxes, no
// FlowRun equivalent — and nodes referencing a junction, whose diagram placement is
// dissolved along with the junction itself) and <connection> elements for wiring;
// wherever a view already places both a bypass connector's real source and target, the
// bypass connector gets a viewMember there too, so the diagram visually matches the
// flattened model instead of showing a gap where the junction used to be. Verified end
// to end against the real uploaded file: 0 junction parts, 0 junctions in the toolkit,
// 13 bypass connectors, 7 correctly-worded notes, 10 views (9 imported + the pre-
// existing default), 217 part-viewMembers (an exact match: 233 total diagram nodes − 6
// junction refs − 10 no-elementRef nodes), zero dangling references anywhere across
// parts/connectors/views/viewMembers, an imported view renders correctly on canvas with
// the exact expected node count, and re-importing the same file twice is still fully
// idempotent across every one of parts/connectors/views/viewMembers.
// 0.43 = Bug fix + new feature. Fix: ArchiMate-imported view nodes were all hardcoded to
// #ff5e61 (the Unknown-type color) regardless of their actual element type — now looks
// up each part's own type's real elementGroup fill color, same as every other node-
// creation path in the app. Verified against the real test file: 6 distinct colors now
// appear across 217 imported nodes (matching the real elementGroups palette), and a
// spot-checked Capability element correctly gets its Strategymotivation group color
// instead of the old hardcoded one. New: "Levels" numeric input right after the Types
// filter — controls how many hops of connector+node expansion to reveal beyond nodes
// directly matching the Stream/Types filters, only taking effect while one of those is
// actually narrowing the view. Blank = unlimited (BFS to exhaustion); 0 = exactly the
// matching nodes and nothing else, not even a connector directly between two matching
// nodes; N = N hops of expansion, walking only this view's own placed connectors (never
// pulls in content from elsewhere in the model). Caught and fixed a real bug during
// testing: `tab.connectorLevels ?? 0` incorrectly collapsed an explicit null
// ("unlimited") back down to 0 ("no expansion"), since ?? treats null as nullish too —
// fixed by reading the field directly, since it's always explicitly initialized (never
// truly undefined). Verified against a 5-node chain with only the first node matching
// the active filter: level 0 shows 1 node/0 connectors, level 1 shows 2 nodes/1
// connector, level 2 shows 3 nodes/2 connectors, and unlimited correctly expands to the
// full chain (5 nodes/4 connectors) — plus confirmed two mutually-matching nodes at
// level 0 still hide their shared connector, and the whole feature has zero effect when
// no Stream/Types filter is active.
// 0.44 = New: Remap "only remap filtered nodes" checkbox — when checked, nodes/
// connectors hidden by the current Stream/Types/Levels filter are excluded from
// repositioning entirely (keep their exact current x/y, stay in the view as normal
// viewMembers, become visible again once unfiltered) instead of being moved to wherever
// the layout algorithm would otherwise place them. New: "Copy" button in the catalog row
// property panel (parts/connectors/views/viewMembers tables) — copies the row as
// readable "Field: Value" text with lookup fields resolved (a connector's From/To show
// the actual part label + type title, not raw ids). New Advanced menu items: "ArchiMate
// 3.2 Specification" link right after "Open TOGAF Meta Model", and a separator after
// "Open Microsoft CDM" matching the File menu's own separator style.
//
// Bug report investigation: the specific example given (a Composition relationship
// "missing" from its view) turned out to be correct behavior on closer inspection — that
// relationship appears exactly twice in the whole source file (its own definition, and
// an <organizations> folder reference) and has no <connection> element in any view at
// all, meaning the source file itself never drew it on any diagram. But the broader claim
// was right: found a genuine, separate bug affecting 19 relationships. Root cause: every
// one of the 19 touches a junction whose diagram node was drawn in a view, but whose
// OTHER real endpoint (reached by flattening through the junction, added in the last
// build) wasn't ALSO placed in that same view — so the bypass connector correctly existed
// at the model level but had nowhere to visually attach. Fixed by auto-placing the
// missing endpoint near its already-placed neighbor whenever only one side of a bypass
// connector is present in a view, so the connection is still drawn instead of silently
// vanishing. Verified against the real file: confirmed 19/19 exactly matches junction-
// touching relationships with a real <connection> in source (100% root-cause match); after
// the fix, all 13 bypass connectors have at least one placement (previously several had
// zero); traced the exact originally-reported style of case end to end (IT Management ->
// AndJunction -> Digital customer intimacy strategy) and confirmed both the real target
// and the connector between them are now correctly placed in "08 View with all Relation
// Types"; re-confirmed the affected view still renders with a matching node count and no
// console errors.
// 0.45 = Obstacle-avoiding connector routing (both current-style and Manhattan), new
// js/routing.js module. New per-view "Connector Routing" selector: Default (unchanged
// curve/straight, no avoidance), Direct (obstacle-avoiding, straight polyline
// segments), Manhattan (obstacle-avoiding, right-angle segments only). Real pathfinding,
// not a heuristic — a visibility-graph search (Direct: any two mutually-visible obstacle
// corners/endpoints, Euclidean-weighted; Manhattan: a coordinate-compressed grid,
// horizontal/vertical-only edges, small per-bend cost so Dijkstra prefers fewer/cleaner
// turns over a jagged shortest-distance zigzag) via Dijkstra, falling back to the
// pre-existing curve/line whenever nothing's in the way (the common case) so most
// diagrams look unchanged. Performance: each connector only considers obstacles within
// its OWN routing region (source+target bounding box, expanded by a margin), not every
// node in the view, plus hard caps on obstacle count and grid size that fall back to a
// simple unrouted path rather than risking a slow/frozen render in a pathological case.
// Caught and fixed a real bug during testing: the Manhattan grid's candidate lines were
// built from each obstacle's EXACT edge coordinates, which — combined with the
// intersection check's inclusive boundary test — meant every grid line touching an
// obstacle was itself always flagged as blocked, including the ones meant to route past
// it, leaving no viable route near any obstacle at all; fixed by offsetting candidate
// grid lines a small epsilon outside each obstacle's edges instead of sitting exactly on
// them. Verified: a controlled single-blocker scenario confirmed Default stays an
// unchanged bezier curve, Direct correctly detours around the blocker (confirmed the
// path geometrically never crosses its rectangle), and Manhattan does the same with
// every segment confirmed strictly axis-aligned. Performance-verified against the real
// ArchiMate import's largest view (46 nodes/35 connectors: 103ms/238ms/288ms across the
// three styles) and a synthetic dense stress case (150 nodes/275 connectors: 190ms/
// 428ms/269ms) — all comfortably fast, full node/edge counts rendered, no hangs.
// 0.46 = Force-directed placement, new js/layout.js module, as a third Remap pattern
// ("force-directed") alongside the existing default/none. Fruchterman-Reingold: every
// node repels every other node, connected nodes attract each other (spring-like,
// proportional to distance), iterated with a cooling schedule so movement settles
// instead of oscillating — the standard algorithm for this, not a custom heuristic.
// Classic Fruchterman-Reingold treats nodes as dimensionless points, which can still
// leave real (rectangularly-sized) nodes overlapping for tightly clustered subgraphs, so
// a final pairwise de-overlap pass cleans up any residual overlap the force simulation
// alone doesn't fully resolve. Reuses the view's own Spacing setting to scale the
// layout's rest distance, consistent with how every other Remap pattern already
// respects it, and respects the "only remap filtered nodes" checkbox (Step 40) the same
// way every other pattern does — connectors touching a filtered-out node are simply
// excluded from the attraction graph. Remap modal hides the sort-priority list and
// column-limit checkbox while force-directed is selected, since neither applies to it.
// Verified: a two-cluster test (A-B-C fully connected, X-Y-Z fully connected, zero
// connections between them, scrambled starting positions) confirmed within-cluster
// average distance (~231px) is roughly 22x smaller than between-cluster average distance
// (~5175px) — connected nodes are genuinely, dramatically pulled together rather than
// just marginally closer — plus zero rectangle overlaps remained and all positions
// normalized non-negative. Performance-verified against a dense 150-node/329-connector
// clustered stress case: 164ms to compute, zero overlaps, all 150 nodes rendered.
// 0.47 = Bug fix (reported after v0.46): force-directed layout could send a pair of
// disconnected nodes thousands of pixels away (e.g. x~8000/y~4600 for a 4-node, 2-edge
// graph — two separate connected pairs with nothing linking them), and left connected
// pairs more loosely spaced than intended. Root cause: repulsion between nodes never
// fully reaches zero, only weakens with distance — with nothing counteracting it,
// disconnected components can drift apart without bound over many iterations, since
// nothing is ever pulling them back together. Reproduced exactly (a 4-node/2-edge graph
// drifted to ~4500px between the pairs) before fixing. Fix: added gravity — a mild pull
// toward the whole system's current centroid, strength growing linearly with distance,
// exactly countering repulsion at long range where it's weakest, so a genuine
// equilibrium exists regardless of how many disconnected pieces the graph has.
// gravityStrength was tuned empirically (not guessed): swept 0.03 through 2.0 against
// two competing tests — the worst-case sparse reproduction, and the earlier clustering-
// quality test (two triangles, nothing linking them) — since gravity too strong
// collapses genuinely-separate clusters together, undoing the whole point of force-
// directed placement. Landed on 0.5: the sparse case's between-pair distance drops to
// roughly 3x its within-pair distance (proportionate, not runaway) while the clustering
// test still shows connected clusters ending up ~3.6x closer than unconnected ones —
// clearly still working, not collapsed. Re-verified via the real Remap command (not just
// the raw function): the original 4-node repro no longer produces extreme coordinates,
// clustering behavior is confirmed intact, zero rectangle overlaps remain, and the
// 150-node/329-connector performance stress case still computes in ~300ms with zero
// overlaps (a modest, expected increase from gravity's added per-iteration cost).
// 0.48 = Bug fix (reported after v0.47): gravity dampened the drift problem but didn't
// bound it — a genuinely disconnected pair could still land hundreds to thousands of
// pixels away, sometimes off-screen. Root cause was more fundamental than a tuning
// problem: repulsion between disconnected components has no reason to exist at all —
// they never interact — so a single continuous simulation across the whole graph was
// always going to be hard to bound reliably for sparse/disconnected cases. Redesigned
// per user's suggestion: identify connected components first (a real graph traversal,
// Union-Find), lay out each one completely independently (zero cross-component forces,
// so there's nothing to drift apart from), snap each cluster's local layout to a grid
// (cell size = node size, same (nodeW+40)*spacing convention Remap's other patterns
// already use), then shelf-pack the clusters into adjacent, guaranteed-non-overlapping
// grid regions — largest cluster first, wrapping to a new row once a shelf gets too
// wide. New js/layout.js exports: findConnectedComponents, computeClusteredGridLayout.
// Verified against the exact reported repro (a-b connected, c-d connected, nothing
// linking them): between-pair distance dropped to 576px — exactly proportional (2x the
// within-pair distance of 288px each) — down from the ~4500-8000px range seen before,
// with every coordinate comfortably on-screen. Re-verified the earlier clustering-
// quality test (two triangles) still shows clear, tight, consistent separation (~282px
// within each triangle, ratio 2.1x). Added and verified a new edge case this redesign
// specifically needed to handle correctly: a fully isolated single node (zero edges,
// its own one-node "cluster") — placed at a sane on-screen position, no crash. Zero
// overlaps confirmed on both the reported repro and the clustering test. Performance
// actually improved (159ms vs ~300ms before) on the 150-node stress case, since each
// small cluster now runs its own tiny simulation instead of one large O(N^2) pass
// across the whole graph.
// 0.49 = Follow-up fix (reported after v0.48): connected pairs were still farther apart
// than expected (~288px) even after the per-cluster grid-packing redesign, because that
// redesign still relied on continuous force-directed physics to arrange each cluster
// internally, then rounded the result to the nearest grid cell — a settled physics
// equilibrium doesn't necessarily land exactly one cell apart once rounded. Per the
// user's own suggested approach: replaced per-cluster physics entirely with a direct
// discrete algorithm — computeAdjacentGridLayout (new, js/layout.js) does a BFS
// traversal from each cluster's highest-degree node, placing every newly-discovered
// neighbor directly into one of its parent's 8 immediate grid neighbors (an expanding-
// ring search is the fallback only for a hub with more than 8 connections). This
// guarantees any spanning-tree edge lands its two endpoints in truly adjacent cells, by
// construction, not by chance. Documented the one honest limitation this can't get
// around: a "back edge" (e.g. the third edge of a triangle, after the first two already
// used the parent's adjacent slots) can't always be adjacent too — no 2D grid embedding
// can guarantee that for an arbitrary graph, a fundamental fact, not an implementation
// gap. Verified against the exact reported repro (a-b connected, c-d connected): a and
// b now land in cells (0,1) and (0,0) — directly adjacent, confirmed via explicit
// grid-cell math, not just eyeballed distance — with actual pixel distance dropping to
// 92px (down from 288px). Re-confirmed the triangle clustering test now shows an even
// tighter 135.6px within each triangle (down from 282px) while still keeping a clear
// 3.2x separation from the other triangle, the isolated-single-node edge case still
// works with no special-casing needed, zero overlaps remain across every test, and
// performance improved further still (101ms vs 159ms on the 150-node stress case),
// since a single BFS pass is inherently cheaper than 300 iterations of physics.
// 0.50 = Bug fix (reported after v0.49, unrelated to force-directed Remap — this was in
// the general Spacing +/- feature used on any freeform view): increasing spacing left
// nodes near the left/top edge visibly stuck in place, with the gap to their nearest
// neighbor compressed while other gaps expanded correctly. Root cause: applySpacingScale
// computed each node's new position by scaling around the layout's centroid (correct),
// but then clamped EACH node's result to Math.max(0, ...) individually — so a node whose
// proportional scale would have gone negative got snapped back to exactly 0 while every
// other node kept scaling normally, breaking the uniform relationship the whole
// centroid-scaling approach was meant to preserve. Fixed exactly per the suggested
// approach: compute every node's scaled position first, allowing negative values, then
// — only if the result actually went negative — shift the WHOLE layout by one uniform
// amount so the minimum lands back at zero. A uniform translation can never distort
// relative spacing, unlike clamping each node independently. Verified two ways: a
// symmetric 5-node row confirmed all 4 gaps scaled by exactly 1.8x; a deliberately
// asymmetric layout (uneven starting gaps of 50/70/100/680px, chosen specifically to
// stress-test whether the smallest edge-adjacent gap would be disproportionately
// compressed) confirmed all 4 gaps scaled by exactly 2.0x when increasing and exactly
// 0.25x when decreasing back down — including the smallest gap, which is precisely the
// case the old clamping bug broke. All positions stayed non-negative throughout. Also
// checked the separate section-view spacing rescale function (rescaleSectionPositions)
// for the same pattern — it works completely differently (re-deriving grid indices, no
// per-node clamping at all) and doesn't share this bug, so it was left untouched.
// 0.51 = New "Smart Check View" command (Advanced menu, bespoke modal since the Levels
// field needs to show/hide based on a checkbox, same pattern already used for Remap's
// force-directed option). Two independent checks: "Missing connectors" (default
// checked) adds any model-level connector whose both endpoints are already placed on
// the view but which has no connector-viewMember yet — never adds new nodes. "Missing
// connectors and nodes" (default unchecked, reveals a Levels field — same null=
// unlimited/N=hop-count convention as the connector-levels display filter, default 1)
// walks outward from the view's current content: for every connector with exactly one
// endpoint on-view, pulls in the missing part (placed near its already-present
// counterpart) plus the connector itself, then — within the same hop, before moving to
// the next — also wires up any other connector that touches one of that hop's new
// arrivals and whose other end is now on-view too (catches two nodes pulled in the same
// hop that also connect directly to each other). The two checks are independent: with
// only the second one on, a pair that was ALREADY both-present before the command ran
// stays disconnected unless the first check is also on — that's deliberately checkbox
// 1's job, not checkbox 2's. Caught and fixed a real scoping bug during testing: an
// early version's "wire up newly-resolvable connectors" step checked ALL connectors
// with both ends on-view, not just ones touching this hop's new arrivals — which meant
// checkbox 2 alone was also fixing pre-existing disconnected pairs it had no business
// touching. Verified precisely: with checkbox 1 off, a pre-existing disconnected A-B
// pair now stays disconnected while a genuinely-pulled-in C correctly gets its own C-B
// and C-D connectors. Verified level semantics exactly on a 7-node chain with only the
// two ends (A, G) initially placed: level 1 pulls in exactly B and F; level 2 pulls in
// B,C and E,F; unlimited pulls in the entire chain, meeting in the middle; level 0 does
// nothing. Verified full UI end-to-end (menu item, checkbox defaults, Levels field
// show/hide, actual button click producing the right result) and confirmed the command
// is idempotent — running it twice on an already-fixed view adds nothing the second
// time.
// 0.52 = Reorganized the node/connector property panel: viewMember-only fields (x, y,
// fillColor, order, note, linkedViewName, isExternal, sectionId, and — newly exposed
// for connectors — fromVmId/toVmId) stay at the top; every field genuinely belonging to
// the underlying part or connector now lives in a new collapsible "Root Properties"
// section below (reuses the sidebar's own collapsible panel CSS classes — no new
// styling needed — with its own fresh-wired toggle each render, since this content is
// injected dynamically rather than wired once at page load; collapse state persists via
// localStorage). Rebuilt settings.showFields.part/connector/viewMember from the actual
// object shapes in state.js's createPart/createConnector/createViewMember — found and
// fixed a real pre-existing schema bug along the way: showFields.part had fillColor/
// fontColor/fontSize/borderColor/view/isExternal listed as if they were Part's own
// fields, when Part never had them at all (they're viewMember fields that had leaked in
// from sharing a field list); showFields.viewMember had the mirror problem (type/label/
// description/model/xIds/streams/scriptEnabled/script listed as if viewMember's own).
// Both now list only their true fields, plus every field that was missing entirely: id,
// rawLabel, other for Part; id, connectorType, fromLineEndSettings, toLineEndSettings,
// stroke, strokeWidth, strokeNormal, strokeWidthNormal, dash, fill for Connector; id,
// view, objectType, objectId, fromVmId, toVmId for ViewMember. Fixed two real
// implementation bugs found while building this: (1) renderShowFieldsPanel generated
// field ids as plain `sf-${fieldName}`, which would collide the moment two sections for
// different entities (e.g. viewMember's own "note" and the part's own "note") render in
// the same panel — namespaced to `sf-${entityKey}-${fieldName}`; (2) readonly/plain-text
// field display coerced values with a bare String(), which turns any object-valued field
// (other, fromLineEndSettings, ...) into the useless literal "[object Object]" — now
// JSON.stringify's plain objects instead. Also updated the catalog row panel (parts/
// connectors tables) to show the same complete field sets, and the from/to fields (both
// there and in the new Root Properties section) now show the actual id alongside the
// resolved label, since "include all ids" was specifically asked for. Verified
// extensively: top-level panel confirmed to contain only true viewMember fields (no
// "label" field, which now only lives in Root Properties); Root Properties confirmed
// to contain the complete real field set for both parts and connectors; the type-change
// (recolors the node) and label-rename (offers to rename a linked view) side effects
// both confirmed still firing correctly from within Root Properties; editing a part
// field from one view's node panel confirmed visible in a SECOND view showing the same
// part (proving these edits hit the shared underlying object, not a per-view copy);
// object-valued fields confirmed rendering as JSON text, not "[object Object]"; the
// collapsible toggle confirmed working and both catalog panels confirmed showing the
// complete new field sets; zero console errors across the whole test suite.
// 0.53 = Investigated a specific reported ArchiMate import gap (connector id-35df05b6...,
// missing from "07 Technology View" until Smart Check View added it) and found the real
// root cause: the relationship is Composition ("Application server AS1 (Node)" ->
// "Blade (Device)"), and the source diagram represents it via visual NESTING — Blade's
// diagram node is drawn directly INSIDE AS1's — rather than an explicit <connection>
// element, which is a standard, valid ArchiMate convention some tools/authors use for
// Composition/Aggregation specifically. The importer only ever reads explicit
// <connection> elements, so it has no way to see relationships drawn this way. Confirmed
// this isn't a one-off: scanned the whole file and found 49 relationships across 6 views
// represented via nesting instead of an explicit connection (15 of them in "07
// Technology View" alone, including the reported one) — a real, moderately significant
// gap, left as a candidate for its own future fix since it wasn't explicitly requested
// this round. New: Smart Check View now logs each change to the Message Log (via
// simulation.js's existing pushMessageLog, now exported) — every connector added, every
// node added (naming what it was anchored near), and a final summary line, or a "no
// missing connectors or nodes found" line when nothing needed fixing — namespaced per
// call as "[Smart Check View: <view name>] ...". New: Copy and Clear buttons on the
// Message Log panel itself (📋/🗑 icons next to the header) — Copy copies the exact
// visible textarea content to the clipboard with a toast confirmation or a graceful
// "clipboard access was blocked" message if denied; Clear empties store.messageLog and
// re-renders, with a toast either way (including a distinct "already empty" case).
// Verified: running Smart Check on a real gap produced exactly the expected two log
// lines (the specific connector added, then the summary); a second no-op run correctly
// logged "No missing connectors or nodes found"; the visible Message Log textarea
// reflects the log; Copy correctly places the exact textarea content on the clipboard;
// Clear correctly empties both the underlying store array and the visible textarea; and
// the full real UI flow (open Smart Check dialog, submit, check the log) was confirmed
// end to end, not just the underlying function in isolation.
// 0.54 = Six changes in one round. (1) Toolkit group filter chips (Application etc.)
// now render light blue via a new "group-chip" CSS class, distinct from the unchanged
// source filter chips (TOGAF etc.). (2) Removed the "BPMN" toolkit source filter
// button — left the underlying BPMN source code, default-active state, and per-element
// filtering logic untouched, so BPMN-sourced elements still display normally, just
// without a dedicated toggle. (3) Line-end graphics (arrows etc.) reduced by 1/3 —
// marker sizes 10/14/20 -> 7/9/13 (2/3 of original). (4) Parts and connectors now carry
// createdAt/updatedAt fields (format yyyymmdd_hhmmss, new nowStamp() utility in
// state.js) — set together at creation, with updatedAt refreshed via new
// store.touchPart()/touchConnector() helpers wired into every true mutating field
// setter across all four property-panel accessor sets (both catalog-row and canvas-
// selection panels). Added to settings.showFields.part/connector (read-only) and to
// the parts/connectors catalog table columns. Old save files migrate cleanly — missing
// timestamps default to empty string, not a fabricated "now". (5) ArchiMate import now
// detects the nested-shape Composition/Aggregation convention investigated last round
// (new collectNestedElementPairs, walks the diagram's real parent/child <node>
// structure — not the flattened list used elsewhere — cross-referencing every
// ancestor/descendant pair against the model's Composition/Aggregation relationships).
// If the relationship already exists as a normal connector, only the missing
// viewMember gets added (and noted, since the connector itself isn't new); if it
// doesn't exist at all (e.g. it touched a junction), the connector is created directly
// (and IT gets the note instead). Note text: "Import detected nested shape without a
// connector; created." (6) Smart Check View now appends "Smart Check created." to a
// connector's note (preserving any existing note, not overwriting it) and touches its
// updatedAt whenever it adds that connector's viewMember to a view.
// Verified extensively: re-imported the exact real file from the investigation and
// confirmed the originally-reported connector (id-35df05b6...) is now correctly placed
// in "07 Technology View" with the expected note on its viewMember (the connector
// itself already existed, so its own note stayed empty, exactly as designed); scanned
// the whole re-import and found all 49 nested relationships identified during the
// investigation now correctly detected and placed, zero of them needing a freshly-
// created connector (none touched a junction), zero duplicate placements, and a second
// re-import of the same file produced the identical connector-viewMember count,
// confirming idempotency. Separately verified: BPMN button gone from source chips,
// group chips carry the new class, marker width confirmed reduced to 7 for "small",
// both timestamps set correctly on creation in the right format, touchPart leaves
// createdAt untouched while changing updatedAt, the timestamp displays correctly in
// the Root Properties panel, the parts catalog table shows both new columns, and
// Smart Check's note correctly appends to an existing user note rather than
// clobbering it while also touching updatedAt. Full regression pass (existing
// example, old-format migration, other Remap patterns, connector panel rendering)
// came back clean with zero console errors throughout.
// 0.55 = Development-infrastructure round, no application behavior changed. Added
// tests/run_all.py: a permanent, runnable Playwright regression suite (11 checks)
// covering the mechanisms that have actually broken during development — force-
// directed layout drift and adjacent-cell placement, all three Remap patterns, Smart
// Check View (including idempotency), the viewMember-vs-part property panel split,
// spacing-scale uniformity, obstacle-avoiding routing, ArchiMate junction-bypass and
// nested-shape detection (via a new small hand-built fixture,
// tests/fixtures/mini_archimate.xml, covering both in one file), and creation/update
// timestamps. Added tests/README.md documenting what each check guards against and how
// to add new ones. Verified the suite is a genuine regression net, not just vacuously
// passing: deliberately reintroduced the exact v0.50 spacing-clamp bug, confirmed
// check_spacing_scale_uniform correctly failed with the same ratio pattern the real bug
// produced ([0, 0, 1.82, 2] — the first two nodes clamped to 0 while the rest scaled
// normally), then reverted and confirmed all 11 checks passed again. Brought
// README.md's "Structure" section up to date — it hadn't been touched since roughly
// Step 23 and was missing layout.js, routing.js, archimate.js, sections.js, and
// simulation.js entirely; also added a "Known limitations" section documenting four
// permanent, deliberate tradeoffs (force-directed layout's cycle-edge limitation,
// routing's local-region-only obstacle scope, nested-shape detection's Composition/
// Aggregation-only scope, and Smart Check's two independent checks) so they don't get
// re-investigated as if they were new bugs. Noted that js/version.js's own per-version
// comments are the authoritative changelog for anything past Step 25, rather than
// duplicating that history into a second document.
// 0.56 = Three fixes/features from a real bug report + two follow-on requests.
// (1) Generate Stream's Function Name combo defaulted to a hardcoded 'testFunction'
// value, which — since HTML5 <datalist> filters its suggestion dropdown to match
// whatever's already typed — hid any existing function names that didn't happen to
// start with "testFunction," effectively burying the dropdown the field exists to
// offer. Now defaults to blank whenever existing functions are available (unchanged
// when none exist, since there's nothing to conflict with then); added a submit-time
// guard so leaving it blank shows a clear "Function Name is required" toast instead of
// silently creating a part with an empty label — worth knowing the generic modal
// helper always closes on submit regardless of what the handler does, so the dialog
// itself still closes rather than staying open for correction; a deeper change than
// this ask called for.
// (2) Root cause found for a real reported bug (drag "Audit" to "Mainstream
// Operational Functions" works; drag it back to "Enterprise Scope Functions" gets
// rejected and reverted) — pixelToNearestGrid's hit-test zone for a title-only section
// computed its bottom edge from section.rowCount * cellH directly, while the actual
// layout (computeSectionLayout) gives title-only sections zero body height by design.
// That mismatch meant title's hit-test region silently extended a full cell-height
// below its own header, into the TOP of whichever section comes right after it — here,
// "Enterprise Scope Functions," the very first section after title — so a drop near
// the top of that section was landing in title's (phantom) zone instead, and title's
// elementTypes is always empty, hence always-rejected. Fixed by exposing bodyHeight
// from computeSectionLayout and having pixelToNearestGrid use that directly instead of
// recomputing it (wrongly) from section.rowCount.
// (3) Rejection/warning messages now carry a specific rule reference instead of a
// generic "some nodes were rejected" — e.g. '"Audit" (BusinessFunction) cannot be
// placed in section "Enterprise Functions" — that section only allows: no element
// types at all.' A single rejection shows that full detail as the toast itself;
// multiple rejections in one drag keep the toast short but log every individual reason.
// (4) Every error-style toast anywhere in the app (app.toast(msg, true)) now also
// writes to the Message Log automatically — hooked once at the toast() function itself
// rather than touching each of the many existing call sites, so this covers all of
// them retroactively, not just new ones. Routine success toasts stay out of the log.
// Verified: reproduced the exact reported bug first (confirmed a drop 5px into ESF's
// real body was resolving to "title" before the fix), then confirmed the fix resolves
// it correctly, via both direct function calls AND a full simulated real pointer drag
// through the actual UI (pointerdown/pointermove/pointerup on the real node element);
// confirmed a genuine rejection (dragging to title's own header area, which correctly
// still has no allowed types) still reverts the node and shows the exact expected
// specific-rule-reference text in both the toast and the Message Log; confirmed the
// Generate Stream field defaults blank only when functions exist and the empty-submit
// guard blocks part creation. Added a permanent regression check
// (check_section_drag_title_overlap) to tests/run_all.py guarding specifically against
// this class of bug — full suite now 12/12.
// 0.57 = Two more reported issues.
// (1) Section-view drag-and-drop near an existing node was placing the dropped node
// directly on top of it (same grid cell), hiding the existing node behind the dropped
// one with no visual sign anything happened. New findFreeCellOrGrowSection
// (js/sections.js): when the drag's resolved cell is already occupied by a different
// node, searches the rest of the section (forward from the drop point, then any
// earlier rows in case something was deleted leaving a gap) for a genuinely free cell;
// if the section is truly full, grows section.rowCount by 1 and places the node in the
// new row's first cell instead of accepting the overlap, with a toast noting the
// section grew. Scoped specifically to drag-and-drop — Populate From Template, Add
// Existing, and the other existing callers of the original findFreeCellInSection keep
// their prior "accept the overlap" fallback unchanged, since silently growing a
// section on every template populate wasn't asked for and could surprise someone
// re-populating a view they'd already laid out.
// (2) The canvas edge-click popover for changing a connector's relationship
// (showEdgePopover, js/main.js) was listing every relation in settings.relations
// unconditionally — unlike the property panel's Relationship select, which was already
// correctly filtered via validRelationOptions(fromType, toType). Now uses the exact
// same function, so a connector's actual endpoint types determine what's offered in
// both places identically; falls back to the unfiltered list only if either endpoint
// somehow doesn't resolve to a real part, so the popup never ends up empty.
// Verified: reproduced the drag-onto-occupied-cell case via a real simulated pointer
// drag and confirmed the dropped node lands on a different, non-overlapping cell in
// the same section; separately built a deliberately full 1x1 section and confirmed a
// drop into it grows rowCount from 1 to 2, places the node with zero overlap, and
// shows the expected "was full — added a new row" toast. For the popover, found a
// type pair (Multi->Multi) with a genuinely restricted valid-relations subset (15 of
// 17 total) and confirmed the canvas popover and the property panel's Relationship
// select now return the exact same option set. Added three new permanent regression
// checks (check_section_drag_no_stacking, check_section_drag_grows_full_section,
// check_connector_popover_matches_panel) — full suite now 15/15.
// 0.58 = New Instructions tab, opened active on startup (home canvas tab stays open
// behind it) — a written reference for enterprise architects/business analysts, not a
// developer doc. New static content file public/instructions.html covers: the core
// data model (Part/Connector/View/ViewMember/Model, and why the ViewMember split
// matters — editing Root Properties changes the shared thing everywhere it appears,
// editing the top-level view fields only changes this one placement); views and layout
// (view types, Remap's three patterns, routing styles, spacing); a full commands
// table; filtering/streams/catalogs; the property-panel Root Properties split, stated
// plainly including which fields currently have no visible effect (Font Color/Size,
// Border Color, Margin) rather than leaving that to be discovered by trial and error;
// simulation scripting (the ctx contract, the return shape, a minimal working example);
// ArchiMate import's junction and nested-shape handling; and a closing tips section.
// New tab type 'docs' (js/canvas.js renderDocsPage) — fetches and caches the content
// once per session (it's static, no reason to re-fetch on every tab switch), guards
// against a race where the tab was switched away from or closed before the fetch
// resolves. New app.openOrSwitchDocs() (js/main.js), same find-or-restore-from-
// closedTabs pattern already used for catalog tabs — closing the Instructions tab and
// reopening it (via a new ❓ header button) restores the same tab rather than creating
// a duplicate or silently failing. New css/styles.css block for .docs-content and
// friends, using the app's own theme variables so it matches light/dark mode instead
// of looking like a foreign, unstyled document dropped into the shell.
// Verified: confirmed the Instructions tab is open AND active immediately on startup
// (not just present) with the home canvas tab still open behind it; confirmed the
// content actually loads (checked for specific section text, a table, and the code
// example, not just "some content exists"); confirmed closing the tab via its own
// close button and reopening via the help button restores the exact same tab id
// (proving it's genuinely find-or-restore, not create-a-new-one-every-time); confirmed
// switching to the canvas tab and back doesn't break anything. Added a permanent
// regression check (check_instructions_tab_on_startup) covering all of the above in
// one pass — full suite now 16/16.
// 0.59 = Five issues from a real bug report.
// (1) ArchiMate/Data-import success toasts weren't reaching the Message Log — both
// call app.toast() without isError=true, so they fell outside the earlier "errors
// auto-log" hook. Both now explicitly logged, matching the pattern Smart Check View
// already used.
// (2) Section rowCount/columnCount changes left nodes in later sections at their old
// pixel position, misaligned with the shifted boundaries. rescaleSectionPositions
// already existed (used for spacing/node-size changes) but was never wired to
// section-level edits — extended it to accept a { sections: [...] } override for "just
// this one section changed" and wired it into both property panel setters.
// (2b/3) Populate From Template, Generate Industry, and double-click-to-new-view
// (levelDownSingle) all left nodes at whatever size the view previously had — traced to
// a real, consistent gap: redrawNodeSizes was only ever called from Remap and the
// explicit Redraw command, never these three. Added it to all three (levelDown, the
// multi-node version, already had it via its own internal Remap call).
// (3) Redraw resized without resolving the overlaps that resize could create — the
// command handler called redrawNodeSizes directly, skipping the resolveOverlapsForView
// step every OTHER resize path already used. Switched it to redrawAndResolveLayout
// (now returns its result so the toast logic still works).
// (4) Smart Check View's Levels default changed from 1 to blank (unlimited/"All").
// (5) Two new independent force-directed Remap options, added to the modal (shown only
// while "force-directed" is selected): "prefer right" reorders the BFS placement
// search to try East before North, so a connected node lands to the right of its
// parent when that cell's free, instead of the default direction; "only new row for
// new group" replaces the free-form 8-neighbor search with depth-fixed rows (root =
// row 0, its neighbors = row 1, etc.), so same-BFS-depth siblings share a row instead
// of scattering based on which immediate cells happened to be free. Both threaded
// through computeAdjacentGridLayout -> computeClusteredGridLayout -> applyRemapLayout.
// Verified all five independently against real reproductions: the exact reported
// section-rowCount scenario (nodes in "cof" — the section after "mof" — confirmed
// staying within bounds after mof's rowCount shrinks); populateFromTemplate/
// generateIndustry both confirmed resizing without being asked; the real "redraw"
// command run via app.runCommand (not just the underlying function) confirmed
// producing zero overlaps on packed long-label nodes; ArchiMate import via the actual
// ArchiMate-input file element confirmed writing to the Message Log; and both new
// force-directed options confirmed on real test graphs (a simple pair landing on the
// same row instead of stacked vertically; three same-depth siblings landing on one
// shared row, distinct from their root's row). Added five new permanent regression
// checks covering all of the above — full suite now 21/21.
// 0.60 = New File > Load SFCE: imports an arbitrary JSON file as an alternate industry
// collection (Section/Function/Capability/Entity) for Advanced > Generate Industry —
// doesn't touch the canvas at all, only store.industryData (no viewMembers, no new view).
// New js/sfce.js, pure parsing logic with no DOM: a generic nested-JSON flattener
// (handles the real-world "outer array of groups, each with a nested array of items"
// shape — exactly what the provided capabilities.json test file turned out to be, not
// the flat-rows shape originally assumed); section-value reading that handles a
// comma-separated string OR an array OR a missing value (kept as "(unspecified)"
// rather than dropping the record); the Shared-collapse decision (rows from a
// multi-section split get marked shared, and either forced into one literal "Shared"
// section with true post-collapse duplicates removed, or left in their original
// sections with per-section Function-name disambiguation — "increment as needed" — as
// a safety net); and tree-building with merge-to-uniqueness on (section, function,
// capability, entity). Schema addition, as flagged in the request: a Function-level
// node now carries nodeSection, extending the existing fce-generalnodes.json shape
// (Function -> Capability -> Entity) by exactly the one field needed, rather than
// restructuring it.
// New three-step wizard in js/main.js (promptLoadSFCE -> promptSFCEMapping ->
// promptSFCESharedConfirm -> finishSFCEImport), added to the File menu right after
// Load Example. Preread suggests an industry name from the filename and field mappings
// via keyword search over the fields actually found in the file (checks each keyword
// across every field before falling back to the next keyword, not the other way
// around — matters in practice: an early but low-priority match like "capability"
// hitting "capability_count", a count field, would otherwise beat the better match
// "name"). Reports statistics to the Message Log on completion: the unique section
// list in first-seen order (kept, per the request, since it's needed elsewhere) plus
// Function/Capability/Entity subtotals and a note on any missing-value handling.
// Real bug found and fixed along the way, not just newly-added-feature work:
// generateIndustry's existing loop required entity-level children to exist at all, so
// a capability with no natural entity field in its source data (exactly
// capabilities.json's actual situation — it has no fourth-level concept) would import
// correctly but silently generate nothing when later run through Generate Industry.
// Fixed with a fallback — a capability with no entity children now generates using its
// own name/description standing in for the entity — verified not to change behavior
// for data that does have entities (the existing "general" industry still produces the
// same 412 parts it always did).
// Verified against the real, large uploaded file, not just a toy example: correct
// flattening of 2182 records from 40 domain groups; 5869 rows after the section split,
// with real Shared-row detection; both Shared-collapse paths validated end to end
// through the actual three-step modal UI (collapsed: 2182 capabilities under 332
// functions; not collapsed: 5869 capabilities under 697 functions, confirmed 12
// independent per-section copies of one recurring function name with zero of 6566
// generated node IDs colliding); confirmed the newly-loaded industry appears in
// Generate Industry's own selector and that it can be consumed without errors or
// duplicate parts on a second run. Caught and fixed a real suggestion-heuristic bug
// along the way (capability_count beating name for the Capability field) using the
// real file's actual field set, not a hypothetical one. Added a permanent regression
// check using a small synthetic fixture that mirrors the real file's nested shape, so
// the suite stays fast rather than parsing the full multi-thousand-record file on every
// run — full suite now 22/22.
// 0.61 = Corrected Load SFCE's Shared logic per clarification, plus a real perf bug fix
// and a new Part field, with three additional real bugs found and fixed along the way.
// (1) Shared logic corrected: "Shared" describes a FUNCTION that ends up needing to
// exist in more than one Section (because different capabilities under it landed in
// different single sections) — not a capability whose own section field had multiple
// values (the row-splitting behavior itself is unchanged; only what counts as
// "Shared" was wrong). New detectSharedFunctions/resolveSharedFunctions in
// js/sfce.js replace the old row-level resolveSharedRows. Collapse=yes now combines
// every section's copy of a shared Function into one, placed in a single "Shared"
// section, with its capabilities from every original section combined. Collapse=no
// keeps each section's own copy, with a numbered suffix (no parentheses, no space —
// "Name", "Name1", "Name2", ...) on every occurrence after the first, by first-seen
// section order. Verified against the real uploaded file: "Analytics, Reporting &
// Business Intelligence" (which genuinely spans Agriculture, Central Government, and
// 20 other sections) resolves exactly as specified either way.
// (2) New Part field "section" — store.createPart, migrateDoc (old saves default to
// '' cleanly), a showFields.part entry (writable), and property-panel accessors in
// both locations render.js needs them. Threaded through createStream via a new
// functionSection parameter and wired into generateIndustry's call, matching where
// Load SFCE's Section data actually lives (the Function level, not Capability or
// Entity — see sfce.js's own doc comment).
// (3) Real bug: functionSection never reached the generated part at all, because the
// "Enterprise" template's Function-level node is created through createPassiveNode
// (the passive-node code path used for `passive: [{from,to}]` entries), not the main
// value[] template loop that Fix #2 was originally wired into. Fixed by threading
// functionSection through createPassiveNode and its four call sites too.
// (4) Real bug, found while fixing #3: findExistingStreamNode (avoids creating a
// duplicate passive node within the same stream) matched on type + streamName alone.
// Two different generateIndustry jobs can legitimately share a streamName — common
// with the entity-fallback (a capability with no distinct entity uses its own name as
// the stream name), which is exactly what happens when the same capability appears
// under a shared Function's two section-copies. Without a label check too, the SECOND
// job's passive-node lookup incorrectly matched and reused the FIRST job's node (e.g.
// its BusinessFunction), silently merging two things that should have stayed separate
// — "Domain One1" was vanishing entirely. Fixed by requiring the label to match too,
// and rewrote the lookup itself to use the existing O(1) partsByKey cache instead of
// scanning every same-type viewMember in the view (which, for a type reused once per
// CAPABILITY rather than once per function — ApplicationFunction/TechnologyFunction in
// this template — meant scanning lists that grew into the thousands).
// (5) Real bug: generateIndustry's own explicit anchor-stepping (added to avoid
// createStream's default-position scan — see the entry below) sized each job's step by
// a single row, but the "Enterprise" template's passive entries place additional nodes
// on rows below the main row (3 extra rows for this template) — so consecutive jobs'
// content actually overlapped. Confirmed via a real regression-suite failure (17 exact
// position collisions) before fixing; step now reserves (1 + passive.length) rows.
// (6) Performance: generateIndustry on a large imported dataset (Load SFCE) was
// reported making the site unresponsive. Confirmed and fixed several genuine O(n²)
// sources: createStream's several find-or-reuse lookups (parts by label/xid, view-
// members by part) were full array scans of store.doc.parts/viewMembers, which
// themselves grow by several entries on every single call in a loop — new
// createBulkLookupCache (Maps, built once) is threaded through createStream,
// createPassiveNode, findOrCreateStreamConnector, and createCompanionConnector,
// opt-in via an optional lookupCache argument so single-call callers (manual Generate
// Stream, levelDown) are unaffected. Also eliminated two before/after array-diff scans
// (replaced with direct tracking of newly-created viewMember ids) and generateIndustry
// now computes its own incrementing anchor position instead of letting each call scan
// the view to find "the bottom". generateIndustry is now async and yields (a zero-
// delay setTimeout) every 40 capabilities, calling an onProgress(done,total) callback
// — wired into a simple progress modal on the actual Generate Industry menu command,
// so the tab stays responsive and shows real progress during a long run instead of
// appearing frozen with no feedback.
// Verified throughout using two methods: full browser tests via Playwright, AND
// (found to be far more reliable this session, given repeated environment flakiness
// with server/browser startup) direct Node-based testing — a real Store instance with
// settings loaded from the actual custom.json, stubbed UI methods, no DOM — which let
// every fix be verified precisely against the real uploaded file at full scale,
// including timing, without depending on a browser at all. Confirmed: all 697 real
// Function parts (no-collapse case) have their section field correctly set; the exact
// "Domain One"/"Domain One1" separation works correctly end to end, not just in the
// tree-building step; generateIndustry on the real 414-part "general" dataset produces
// zero position overlaps; the "general" industry's own output is unchanged (412 parts,
// matching before these changes). Added two new permanent regression checks
// (check_sfce_import_and_generate rewritten for the corrected Shared-Function
// semantics and now also checking the section field; new
// check_generate_industry_no_collapse_keeps_functions_separate for the label-match
// bug) — also fixed two now-async-related bugs the existing suite itself had (missing
// `await` on generateIndustry calls, which was silently checking results before the
// operation had actually finished) — full suite now 23/23.
// 0.62 = Seven requested items.
// (1) custom.json's streamTemplates updated as provided: the original "Enterprise" was
// renamed "Enterprise Full" and a new, shortened "Enterprise" (10 positions/1 passive,
// down from 18/3) takes over as the default — confirmed no code hardcoded assumptions
// about "Enterprise"'s structure (everything looks it up by name and reads passive.length
// dynamically), so this was a safe direct file swap.
// (2) Generate Industry and Generate Inventory View now leave the selection empty when
// more than 100 nodes were generated/added, instead of a small, misleading partial
// selection (whatever the last individual stream happened to select). Found and fixed a
// real ordering bug in this fix itself: the clearing code was originally placed after a
// resize/redraw step that can throw, so if that step ever failed, the clear would never
// run — moved earlier, unconditional on what follows.
// (3) Every dialog box now only closes via its own Cancel/Close control — removed all
// ten occurrences of the click-outside-to-close pattern from js/main.js's modals.
// Confirmed no Escape-key close handler existed anywhere to also need removing.
// (4) capabilities-single.json (a much shorter real-data test file) noted for future
// testing use — no code change needed for this item itself.
// (5) Dropdown menus (Stream filter, and every other dropdown, since this was added to
// the shared base class) now cap at 70vh with a scrollbar, instead of growing unbounded
// and running off-screen for a long list.
// (6) New Advanced > SFCE Catalog: a read-only, flattened table of one industryData
// collection's Section/Function/Capability/Entity hierarchy, with id and description at
// every level — works for both a Load SFCE import and the built-in "general" data
// (fce-generalnodes.json, which has no section concept — comes back blank rather than
// erroring). New flattenIndustryTree in js/sfce.js; reuses the existing generic table-
// tab infrastructure (tab.tableRows/tableCols) rather than building a new renderer.
// Explicitly read-only for now, per the request — a showFields-driven editable version
// is a separate, later step.
// (7) The single view.routingStyle setting is now two: 'c'-type (regular) connectors use
// view.routingStyle as before, and a new view.routingStyleStream independently controls
// 's'-type (stream) connectors — a person can e.g. keep regular connectors curved while
// routing stream connectors around obstacles, or vice versa. Both selectors gained a new
// explicit "Straight line" option — distinct from "Default", which still draws 'c'-type
// connectors as a gentle curve; "Straight line" always forces a plain line regardless of
// connector type. New showFields.view entry, state.js defaults/migration for the new
// field, and property-panel accessors in both of render.js's view-panel locations.
// Verified with real browser tests throughout (after resolving a genuine environment
// issue this session — combining a local server with Playwright inside an inline
// `python3 -c` command was unreliable, but the identical logic as a standalone script
// file, matching tests/run_all.py's own pattern, worked consistently): confirmed the
// Enterprise swap's actual sizes; confirmed Generate Industry leaves an empty selection
// past 100 nodes and a normal one below it; confirmed a real outside click leaves an open
// modal open and Cancel still closes it; confirmed the Stream filter dropdown's actual
// computed max-height/overflow-y; confirmed the SFCE Catalog renders a real table with
// the correct row count and all ten id/description columns; confirmed the actual SVG
// path output — "straight" produces a plain line with no curve, "default" still curves
// 'c'-type connectors as before, and the two connector types have genuinely independent
// routing settings. Added six new permanent regression checks covering all of the above
// — full suite now 29/29.
// 0.63 = Rebrand: FlowRun -> DyCAD. Every user-facing name and every code identifier
// that referenced the old name has been updated: the page title, public/instructions.html
// (10 mentions), README.md and tests/README.md, code comments in state.js/archimate.js,
// the debug global window.flowrunApp -> window.dycadApp (and all 27 references to it in
// tests/run_all.py updated to match, so the suite still runs), and every localStorage
// key (theme, left/right panel widths, panel-collapsed states, Root Properties collapsed
// state) renamed from flowrun-* to dycad-*. Download filenames changed too: saved model
// files are now dycad-model.json, simulation snapshots dycad-sim-*.json.
// Two deliberate exceptions, not oversights: (1) the simulation snapshot file format's
// internal "kind" field is now 'dycad-sim-snapshot' for newly-saved files, but loading
// still accepts the old 'flowrun-sim-snapshot' value too, so snapshots saved before this
// rebrand still load correctly instead of being silently rejected. (2) historical
// changelog entries further up this file that describe past work (e.g. the ArchiMate
// import build steps) still say "FlowRun" — left as-is since they're an accurate record
// of what was true at the time, not something to retroactively rewrite. localStorage
// preference keys were NOT given the same old-key-fallback treatment as the snapshot
// format — renamed outright, so existing users will see their theme/panel-width/
// collapsed-state preferences reset once after updating. Considered a reasonable,
// expected one-time side effect of a rebrand rather than something worth the added
// complexity of a migration for low-stakes UI preferences.
// Verified with a real browser: confirmed the actual page title, confirmed
// window.dycadApp exists and window.flowrunApp no longer does, confirmed toggling the
// theme writes to the new localStorage key and not the old one. Full regression suite
// re-run after the window.flowrunApp -> window.dycadApp rename across all 27 references
// in tests/run_all.py itself — 29/29 still passing, confirming the rename didn't silently
// break the suite's own ability to reach the app.
// Smart Check View gained a third option, "Auto-complete streams in model": scans every
// stream name already tagged on a part in the current default model, checks each one
// against a chosen stream template using the same find-or-reuse logic Generate Stream
// itself uses (label+type+model), and shows a review dialog listing every incomplete
// (stream, type, label) position with independent Part/View checkboxes — View is
// disabled+unchecked whenever Part is unchecked, since a node can't exist without its
// underlying part. Nothing is created until Proceed. The bare name used for every
// category (function/capability/entity) is the stream name itself, not a
// reverse-engineered guess — a Part only stores its final prefixed/suffixed label, so
// there's no reliable way to recover whatever name was originally typed into Generate
// Stream's Function/Capability/Entity fields for a partially-built stream, and this
// matches how Generate Industry already works (entityName === streamName there, always).
// The creation function (autoCompleteStreams, commands.js) walks the template's main
// chain and passive list exactly like createStream, but bridges over any position the
// user left unchecked (and unresolvable) instead of breaking the chain there — the next
// resolved position connects straight back to the last one that had a part. A position
// with a part but no view placement in this view still gets its model-level connector
// created/updated, just without a viewMember edge for it. New permanent regression check
// (check_auto_complete_streams_ui) exercises the real dialog end-to-end: verified it
// fails with the expected message when the Part/View checkbox dependency is broken,
// before confirming it passes with the real code. Full suite now 30/30.
// Part and Connector's "streams" showFields field changed from read-only ("r") to
// writable ("w") in custom.json — the property panel's Streams field can now be edited
// directly (comma-separated, trimmed, empty entries dropped), for both. The get/set
// accessor pairs in render.js (part-only panel, connector-only panel, and the node/
// connector canvas-selection panels — four spots total) previously had a no-op `set`
// left over from when the field was read-only; wired to a real setter matching the same
// split/trim/filter pattern renderSectionProperties' elementTypes field already used.
// New permanent regression check (check_streams_field_editable): verified it fails with
// the expected message against the old no-op setters before confirming it passes with
// the real fix. Full suite now 31/31.
// Bug fix: Auto-Complete Streams in Model was bridging over a skipped chain position —
// if a middle position's Part was left unchecked in the review dialog, its two neighbors
// still got connected DIRECTLY to each other, skipping the gap. A connector represents a
// specific designed relationship between two ADJACENT template positions; bridging over a
// missing one produces a relationship the template never actually specified. Fixed in
// autoCompleteStreams (commands.js): the main-chain loop now only creates a connector
// between the immediately-preceding position and the current one, and only when BOTH are
// resolved — `prev` is reset to null (not carried forward) whenever a position isn't
// resolved, so a gap breaks the chain there instead of being bridged. check_auto_complete_
// streams_ui extended to catch exactly this: unchecking BusinessCapability (a genuine
// middle position in the Enterprise template, with real neighbors on both sides) and
// verifying no connector was created directly between BusinessService and
// BusinessProcess — verified the check fails with the expected message against the old
// bridging behavior before confirming it passes with the fix. Full suite still 31/31.
// Bug fix: a pinned field's 📌 icon was nested INSIDE its <label> element (render.js's
// row() helper). A real double-click aimed at the label text could land its second click
// on the icon instead — the icon's own click handler toggles the pin and calls
// app.render(), which rebuilds the whole panel and removes the row from Pinned mid-
// gesture, so the "double-click to open the larger editor" affordance would silently stop
// working (and repeated attempts kept failing since the row kept disappearing). Root
// cause confirmed empirically, not guessed: instrumented real click/dblclick events during
// a Playwright double-click and watched the second click land on the pin button, not the
// label, even though both clicks targeted the identical on-screen coordinate — the DOM
// under that coordinate had changed between the two clicks because the first click's
// side effect (the re-render) had already fired.
// Fixed by making the pin button a SIBLING of the label instead of a child (own hit area,
// can never be "hit while aiming for the label" again), and giving the label a `for`
// attribute pointing at its field's input id, so a single click on the label now also
// focuses the field — the same native behavior checkbox rows already had via their own
// hand-built markup, extended here to every other field type via row()'s new `inputId`
// parameter. New permanent regression check
// (check_pinned_field_dblclick_not_stolen_by_pin_icon): repeats a real double-click on a
// pinned label 3 times checking the editor opens every time and the row survives, then
// confirms a direct click on the icon still unpins normally — verified it fails with the
// expected message against the old nested-icon markup before confirming it passes with
// the fix. Full suite now 32/32.
// Added ctx.createNode(spec) to the simulation script contract (simulation.js) — no
// prior way for a script to place an existing Part onto a view as a visible node;
// ctx.createPart/ctx.createConnector only ever touched the Part/Connector tables, never
// any viewMember. Find-or-create (same part+view -> returns the existing node, no
// duplicate), places into a section-based view's own grid via sections.js's
// createSectionPlacer when the view is one (imported fresh — verified this doesn't
// create a circular dependency: sections.js only imports from state.js, and canvas.js,
// which already imports FROM simulation.js, is untouched). New example file
// "createNode demo.json" (registered in examples/index.json): a script-driven node that
// creates a part, wires it, places it on the view, then calls createNode a second time
// to demonstrate the find-or-create no-duplicate guarantee. instructions.html's ctx
// reference table updated. Verified via plain-Node runTick harnesses (no permanent
// Playwright check added — matches how ctx.createPart/ctx.createConnector themselves
// shipped, verified the same way): freeform placement, section-view placement lands
// inside a real section not raw x/y, idempotency across ticks, and all four error paths
// (missing objectId, unknown objectId, no view open, unknown explicit view id) all throw
// the expected message. Full suite still 32/32.
// Added ctx.createNodeConnector(spec) alongside ctx.createNode — a Connector (from
// ctx.createConnector) has no viewMember any more than a Part does, so it never draws a
// line on any canvas until something places it; this is that placement call for edges.
// Requires both endpoint parts to already have a node on the target view (looked up via
// their CURRENT viewMember there, not passed explicitly) — throws naming whichever
// endpoint ("from", "to", or both) is missing one rather than guessing/bridging, the same
// philosophy behind the recent Auto-Complete Streams bridging fix. Find-or-create, same
// as createNode. Extended the "createNode demo.json" example (rather than adding a
// separate file) to chain all four calls in the natural order a real script would use:
// createPart -> createConnector -> createNode -> createNodeConnector, then repeats the
// last two to demonstrate neither creates a duplicate. instructions.html's ctx reference
// table updated. Verified via plain-Node runTick harnesses: happy path + idempotency,
// missing-"to"-endpoint error, missing-both-endpoints error (correct singular/plural
// wording), unknown objectId error, and a section-based view (both endpoints placed via
// createNode into real sections, edge still connects the two correctly) — plus the same
// full loadFromJSON+runTick integration test on the actual updated example file used for
// createNode itself. Full suite still 32/32.
// Split File > Load/Save Local Settings into two independently-scoped features, per a
// direct request: "is it possible to autoload local settings on start" led to separating
// what should and shouldn't ever touch localStorage. File > Load/Save Local Secrets (API
// keys, exposed as ctx.secrets — store.localSettings renamed to store.localSecrets
// throughout state.js/simulation.js/main.js) stays exactly as security-conscious as
// before: memory-only, must be re-loaded every browser session, NEVER cached anywhere.
// File > Load/Save Local Settings now covers only pinned fields + Max Script Entities —
// genuine user preferences with nothing sensitive in them — and Max Script Entities is
// now cached to a new localStorage key (LOCAL_SETTINGS_CACHE_KEY, main.js) the moment
// it's loaded, auto-applied on every future boot via bootstrapApp() reading the cache
// right after constructing the Store, with no file re-selection needed; pinnedFields
// already had its own independent localStorage persistence (render.js) and needed no
// change. Both file loaders still accept the OLD pre-split combined
// {secrets,pinnedFields,maxScriptEntities} shape and pull out only what's relevant to
// each, so files saved before this split still load correctly on either side. New
// permanent regression check (check_local_secrets_settings_split): loads both files
// through the real file inputs, reloads the page, and confirms secrets reset to {}
// (proven to fail against a version where the cache-write line was removed) while
// maxScriptEntities survives via its cache. Full suite now 33/33.
// Closing the Instructions tab now sticks across sessions — a real "don't show this
// again" instead of reopening every time the app boots. Added to the SAME
// LOCAL_SETTINGS_CACHE_KEY localStorage blob maxScriptEntities already uses
// (instructionsClosed: true), which required refactoring that cache from a single
// blind-overwrite setter into general getLocalSettingsCache/setLocalSettingsCache
// read-modify-write helpers first — the old setCachedMaxScriptEntities wrote
// `{maxScriptEntities: n}` directly, which would have silently wiped out
// instructionsClosed (or vice versa) the next time either was set. App.closeTab now
// checks whether the tab being closed is type 'docs' and caches the flag; bootstrapApp
// checks it before calling openOrSwitchDocs (the Help button's own click handler is
// unconditional, so it still opens Instructions on demand regardless of the cached flag).
// New permanent regression check (check_instructions_closed_persists_across_reload):
// closes Instructions, reloads the page, confirms it does NOT reopen and the home canvas
// tab is active instead, then confirms the Help button still works — verified it fails
// with the expected message against a version with the boot-time check removed before
// confirming it passes with the fix. Full suite now 34/34.
// Replaced Load SFCE and Load Capability Map (a prior version of this session's own
// work, since reverted) with ONE unified feature, File > Load SFCCE — a
// Section/Function/Capability/Sub-Capability/Entity import, per a direct request that
// the two features were "almost the same wizard with one extra level." The unification
// turned out to require more than just merging two menu items:
//
// - custom.json gained a new 'SFCCE' stream template (BusinessFunction ->
//   BusinessCapability -> ApplicationCapability -> DataDataEntity, no passive entries —
//   discovered while designing it that every EXISTING template routes BusinessFunction
//   through a passive pair rather than the main chain, a template design choice, not a
//   technical requirement, so SFCCE's own BusinessFunction sits directly at chain
//   position 0 instead).
// - createStream (commands.js) gained a 4th category, 'subCapability', alongside
//   function/capability/entity — a new optional subCapabilityNameBegin template field
//   (only 'SFCCE' sets it; every other template's behavior is 100% unchanged, verified
//   byte-identical against the pre-change baseline for the built-in 'general' dataset:
//   198 parts, 18 of them ApplicationCapability-typed from Enterprise's own unrelated
//   chain position, both confirmed against a real pre-change run, not assumed) — plus
//   isPreciseCategoryMatch extended so a Sub-Capability position's description/xIds
//   actually get threaded through (caught via a real failing test: generated parts had
//   empty descriptions until this was added).
// - generateIndustry (commands.js) now reads store.industryTemplates[industryKey] (new
//   Store field, state.js) instead of hardcoding 'Enterprise', and its job-building walk
//   branches on whether that template declares subCapabilityNameBegin — 4 levels deep
//   for 'SFCCE' data, the ORIGINAL unchanged 3-level walk for everything else (the
//   built-in dataset and any file predating this feature), so a 3-level tree's own
//   entity-level nodes are never misread as sub-capabilities.
// - sfce.js: buildRowsFromRecords now cascades every level below Function when its
//   mapped field is missing/unmapped — Capability inherits Function's name, Sub-
//   Capability inherits Capability's, Entity inherits Sub-Capability's — rather than the
//   old behavior (Capability/Function fell back to "(unspecified)", a missing Entity was
//   simply never created). This is what lets old-style 3-level data and new 4-level data
//   share one wizard: old data just never maps Sub-Capability, so it inherits Capability's
//   own name at that position instead of the level being absent. buildIndustryTree
//   correspondingly always builds the full 4 levels now (no more "capability with no
//   entity children" branch — cascade guarantees there's always a next level).
// - flattenJsonRecords (sfce.js) now unwraps arbitrarily many levels of nested
//   array-of-objects, not just one — needed once a real merged-capabilities file's shape
//   (domain -> businessCapabilities[] -> applicationCapabilities[]) turned out to be two
//   levels deep, past what the original single-level unwrap (built for Load SFCE's one
//   real-world case) could handle. A field name colliding between two nesting levels
//   (e.g. both a Business Capability and its own Application Capabilities having their
//   own "name"/"description") is preserved under a renamed field
//   (`${nestedKey}_${field}`, e.g. "applicationCapabilities_name") rather than the
//   deeper level silently overwriting the outer one and losing data.
// - Sharing (a Domain/Capability/Sub-Capability spanning more than one Section) is now
//   THREE independently-resolvable questions instead of Load SFCE's original one,
//   generalized into one detectSharedLevel/resolveSharedLevel pair (sfce.js) rather than
//   three hand-copied near-duplicates, and the wizard (main.js) walks them via one
//   SFCCE_SHARED_LEVELS-driven recursive step instead of three separate modal functions.
//   Found and fixed a real design bug before shipping: Capability-level detection, if run
//   using the CURRENT (already Domain-resolved) section/name fields, could never fire —
//   Domain-level resolution fully consumes a Domain's section diversity when it resolves
//   (every row of a collapsed-or-suffixed Domain ends up with exactly one section), so
//   grouping by the live fields always saw at most one section per Capability. This
//   wasn't a rare corner case: verified 93% of business capabilities in a real merged
//   capabilities dataset genuinely span multiple sections through their own application
//   capabilities. Fixed by freezing originalFunctionName/originalCapabilityName/
//   originalSubCapabilityName/originalSection on each row (never touched by any
//   resolution) and keying/ranking all three levels' detection AND resolution off those
//   instead — correct regardless of what order the three run in or what the others
//   already decided, including "collapse one level, suffix another," which — given that
//   93% overlap rate — is the common case here, not an edge case.
//
// New permanent regression check (check_load_sfcce) exercises the full wizard against a
// small deliberate fixture (one domain, one business capability, one application
// capability that itself lists 2 ministries — chosen so all three sharing levels fire
// from a single row) — verified it fails with the expected message against the
// Capability-detection ordering bug above (using the live section/name fields instead of
// the frozen ones) before confirming it passes with the real fix. Four existing checks
// (check_sfce_import_and_generate, check_generate_industry_no_collapse_keeps_functions_
// separate, check_modal_no_close_on_outside_click, check_sfce_catalog_page) updated for
// the renamed method/menu item and the new field-mapping/template-registration shape.
// Verified via plain-Node harnesses first, at both small fixture scale and full real-data
// scale (2,182 source records -> 5,869 fanned-out rows -> 15,167 generated parts in
// ~450ms) before the Playwright checks. Full suite now 35/35.
//
// 0.96: Load SFCCE's field-mapping wizard was mislabeling fields when a source file has
// more than one "name"/"description" at different nesting depths (a merged capabilities
// file has one on each Business Capability AND each of its own Application Capabilities).
// flattenJsonRecords (sfce.js) now ALWAYS renames every field belonging to a nested-array
// unwrap to its full dot-path from the outermost record, e.g.
// "businessCapabilities.applicationCapabilities.name" — not just on collision, and not
// abbreviated to the nearest nesting level — so the wizard's dropdowns show each field's
// complete parentage at a glance. A field never inside any nested array (e.g. the
// outermost "domain") still stays bare, since there's nothing to disambiguate it from.
// main.js's auto-suggestion logic (suggestByDepth) was updated to pick the SHALLOWEST
// matching dot-path for "Capability field" and the DEEPEST for "Sub-Capability field",
// replacing the old flat keyword-priority heuristic that assumed unique field names.
// Confirmed against the real 2,182-record merged file: fields now read exactly
// ['domain', 'businessCapabilities.name', 'businessCapabilities.description',
// 'businessCapabilities.applicationCapabilities.name',
// 'businessCapabilities.applicationCapabilities.description',
// 'businessCapabilities.applicationCapabilities.ministries'], and auto-suggestion picks
// the correct field at each of the 6 mapping slots. Updated the three SFCE/SFCCE tests
// whose fixtures reference nested field names (check_sfce_import_and_generate,
// check_generate_industry_no_collapse_keeps_functions_separate, check_load_sfcce) to the
// new dot-path values; re-verified check_load_sfcce still catches the original
// resolution-order bug by temporarily reintroducing it (swapping originalSection back to
// the live section field in detectSharedLevel/resolveSharedLevel), confirming the exact
// expected failure message, then restoring the fix. Full suite 35/35.
// 0.97: Renamed the "Catalogs > SFCE" label to "SFCCE" (menu item, dialog title, table
// tab title, and matching doc comments) to match the unified Load SFCCE wizard — it was
// still saying "SFCE" from before the two features were merged. Also gave the 'SFCCE'
// stream template (custom.json) the same `passive` entries as 'Enterprise'
// (BusinessFunction->BusinessProcess, ApplicationApplication->ApplicationPhysicalComponent)
// so Generate Industry on SFCCE-imported data also creates a Business Process (reusing
// the chain's own BusinessFunction node) and an Application Application / Application
// Physical Component pair per stream, needed to map real software applications onto the
// generated Application Capabilities — previously SFCCE's passive list was empty.
// capabilityNameBegin/entityNameBegin/value/subCapabilityNameBegin were deliberately left
// distinct from Enterprise's (copying those would have collapsed generateIndustry back to
// its 3-level walk and silently dropped every Application Capability node). Extended
// check_load_sfcce to assert all three passive-generated part types appear exactly once;
// verified by temporarily reverting SFCCE's passive back to [] and confirming the check
// fails with the expected message before restoring the fix. Full suite 35/35.
// 0.98: Dialog defaults now persist across sessions via the existing Local Settings
// localStorage cache (LOCAL_SETTINGS_CACHE_KEY). Two new members: `streamTemplate` — the
// last Stream Template picked in ANY dialog offering one (Generate Stream, Smart Check
// View's Auto-Complete Streams, Remap) becomes the shared default for all of them, instead
// of each independently defaulting to "Enterprise"; and `remapOptions` — Remap's own
// pattern/limit-columns/filtered-only/force-directed-suboptions/sort-priority-order are
// remembered as user-level defaults across ALL views, applied whenever Remap reopens (even
// on a brand-new view). This sits BELOW view.remapSortKeys in priority — a view's own
// remembered sort order (set the first time Remap actually runs on it) still wins once it
// has one; the cached user default is only the fallback for a view that doesn't yet.
// Remap's "Reset" button is unchanged — it still restores the app's true built-in defaults
// (Enterprise/default pattern/unchecked), ignoring both the per-view and user-level
// remembered values, since that's a distinct, deliberate action from just reopening the
// dialog. Added two permanent checks (check_stream_template_shared_default,
// check_remap_options_persist_across_views), each verified via reload and via temporarily
// reverting the two new cache getters to no-ops, confirming the expected failure, then
// restoring the fix. Full suite 37/37.
// 0.99: Instructions tab, Commands section — added "AI-Assisted Capability Data
// Generation" with two ready-to-paste prompts for producing industry JSON to feed
// Generate Industry / File > Load SFCCE: GoA_Capabilities_to_SFCCE (condenses a flat,
// ministry-tagged capability list into DyCAD's two-tier Capability/Sub-Capability shape —
// matches capabilities.json -> capabilities-merged.json's real schema) and
// Industry_to_SFCCE (a from-scratch generator with an {{INDUSTRY}} placeholder, 4-level
// SFCCE shape by default, 3-level SFCE-style if the Sub-Capability level is omitted).
// Content-only change, no code touched.
// 1.00: Generate Stream's Stream Name field is now a text input backed by a <datalist>
// of existing stream names (same discoverability pattern Function Name already used),
// not a plain text box — typing a brand-new name still works exactly as before, but
// picking/typing an EXISTING stream name now prepopulates Function/Capability/
// Sub-Capability/Entity Name from that stream's own already-generated parts
// (commands.js: new deriveStreamNames + its unjoinLabel helper, reading only the 4
// canonical "precise category match" types createStream itself singles out, so it works
// regardless of which template originally generated the stream) and switches the
// template to one with a Sub-Capability level if the stream has one. A brand-new stream
// name leaves every field at its own default rather than clearing anything. Added a new
// "Sub-Capability Name" field (shown only for templates with subCapabilityNameBegin) —
// previously Generate Stream had no way to set it at all, so picking the 'SFCCE' template
// from this dialog silently produced a Sub-Capability part labeled just its bare prefix
// ("Manage"). The dialog is now bespoke (like Remap/Smart Check View) instead of the
// generic promptModal, for the dynamic show/hide and the Stream Name input's own change
// handling. Existing-part reuse itself needed no new code — createStream already
// find-or-creates every position by xIds or by label+type+model — this dialog only
// affects what gets typed into it. One new permanent regression check, verified via
// temporarily disabling the prepopulation logic and confirming the expected failure
// before restoring it. Full suite 38/38.
// 1.01: Renamed "Sub-Capability" to "Application Capability" everywhere — UI labels
// (Generate Stream's field, the Load SFCCE mapping wizard's field/description, the SFCCE
// Catalog's columns, Instructions), and internal identifiers/ids (subCapabilityName ->
// applicationCapabilityName, subCapabilityNameBegin -> applicationCapabilityNameBegin in
// custom.json's SFCCE template, category 'subCapability' -> 'applicationCapability',
// gs-subcapability* -> gs-application-capability*, sfcce-field-subcapability* ->
// sfcce-field-application-capability*, short-form subCap/SubCap -> appCap/AppCap). This
// also fixes a pre-existing inconsistency: the shared-level confirmation dialog
// (SFCCE_SHARED_LEVELS in main.js) already said "Application Capability" while the
// field-mapping wizard and dialogs said "Sub-Capability" for the exact same level — now
// they agree. Historical changelog entries above describing past work still say
// "Sub-Capability" — an accurate record of what it was called at the time, not rewritten
// (see CLAUDE.md's Rebrand note for the same policy applied to the FlowRun->DyCAD rename).
// Content/identifier rename only, no behavior change. Full suite 38/38.
// 0.800: Version reset — no prior users, so no backwards-compatibility reason to keep
// climbing the old 0.xx/1.xx numbering. Increments are now 0.001 per change going
// forward (was 0.01).
//
// Also: SFCCE's stream template (custom.json) now matches Enterprise's on every field
// except name (and the one field Enterprise doesn't have, applicationCapabilityNameBegin)
// — capabilityNameBegin -> "GeneralActor", value gains GeneralActor/BusinessService/
// BusinessProcess/ApplicationProcess/ApplicationLogicalComponent/ApplicationPhysicalComponent
// (matching Enterprise's own supporting-node chain) and drops the literal "BusinessFunction"
// entry (it's created via the existing passive entry only, same as Enterprise already does
// — BusinessFunction was never meant to be in a template's own value[]). Verified this
// doesn't reintroduce the earlier-flagged label-collision risk: two distinct Application
// Capabilities under the same Business Capability now generate two distinct
// ApplicationCapability parts with their own labels/descriptions (confirmed via a live
// generateIndustry run against a 2-Application-Capability fixture) — applicationCapabilityNameBegin
// still marks where naming switches from capabilityName to applicationCapabilityName, it's
// only the SUPPORTING node types around it that now match Enterprise's richer chain. Full
// suite 38/38.
// 0.801: New views default to a bigger node box — 156x55 (130x46 * 1.2) instead of the
// old flat 130x46 — generated nodes were cramped and often clipped their own label text.
// The 1.2 multiplier is a real, user-configurable Local Settings preference
// (nodeSizeMultiplier), not a one-off hardcoded bump: state.js's Store constructor takes
// it as an optional param (default 1.2, so it stays usable headless under plain Node with
// no localStorage), used by defaultNodeSize() wherever a view's nodeWidth/nodeHeight gets
// set (the initial doc, addView, migrateDoc's fallback for an older file with no
// nodeWidth/nodeHeight of its own). main.js reads it from the same localStorage cache
// maxScriptEntities already uses (getCachedNodeSizeMultiplier/setCachedNodeSizeMultiplier,
// clamped to 0.5-3), settable via File > Load/Save Local Settings. Only affects NEW
// views — doesn't resize anything already on screen (that's still Redraw/Remap's job).
// Ordering mattered here: the cached value has to reach the Store constructor itself
// (not be applied to store.nodeSizeMultiplier after construction), since the initial home
// view is built inside the constructor — verified via a new permanent check
// (check_node_size_multiplier) that specifically confirms the very first view after a
// reload already reflects a cached custom multiplier, and by temporarily reintroducing
// the wrong order (apply-after-construction) and confirming the expected failure before
// restoring the fix. Full suite 39/39.
// 0.802: Added Advanced > Smart Check Node (also right-click a single node) — the
// single-node analog of Smart Check View, sharing its exact "missing connectors" /
// "missing connectors and nodes, N levels" mechanics (commands.js: new smartCheckNode,
// modeled closely on smartCheckView, not a refactor of it — smartCheckView's own tests
// stay untouched/unaffected). Two extra filters this scope needed: Upstream/Downstream
// (direction relative to the selected node) and By Stream (only follow connectors
// carrying the node's own stream(s), pre-checked from that node's actual streams,
// multi-select if it has more than one). The stream filter is fixed for the whole run
// from the ORIGINALLY selected node — pulling in a node that also happens to carry a
// different stream does not widen the search to that stream too (verified via a
// permanent check with a small real graph, and by temporarily reintroducing the widening
// bug and confirming the expected failure before restoring the fix). New render.js
// getCommandDefs entry (singlePart-gated, so it's usable via the left Commands panel
// too, not just right-click) and CMD_ICONS entry. Full suite 40/40.
// 0.803: Instructions tab's Industry_to_SFCCE prompt was missing the Entity level
// entirely — added it (nested under Application Capabilities, or directly under
// Capabilities when that level is omitted), with guidance/examples ("Sales Order,"
// "Customer Profile," "Bill of Materials") pulled from the actual DataDataEntity
// examples in DyCAD's own built-in "general" industry dataset (fce-generalnodes.json),
// per the user's pointer to look there. Content-only change, no code touched.
// 0.804: Stage 0 of the new 3D View (Catalogs menu): a rotatable/zoomable WebGL scene
// over store.doc.parts/connectors directly (never viewMembers/views) — plumbing only so
// far (persistent per-tab renderer/camera/OrbitControls, a placeholder cube), proving
// the vendored library loads and renders cleanly before any real data logic touches it.
// The one deliberate exception to the vanilla-JS/no-dependency rule: real 3D needs a
// real rendering library. Rather than a CDN <script> tag (a live runtime dependency —
// breaks offline, breaks if the CDN changes), Three.js r185 + OrbitControls are
// downloaded once and committed under js/vendor/ (see its own README.md for exact
// provenance/update instructions), imported the same way every other module is. New
// js/view3d.js is the only module that imports them, reached exclusively via a dynamic
// import() from canvas.js's renderView3DPage, so the ~800KB vendored payload never loads
// unless the tab is actually opened. Persists its renderer/scene/camera/controls per tab
// id across re-renders instead of tearing down and rebuilding the WebGL context on every
// app.render() call the way every other tab type's page does — recreating a WebGL
// context on every store mutation would both be wasteful and would reset whatever
// rotation/zoom the person is mid-interacting with. App.closeTab now disposes a closed
// 3D tab's WebGL context/animation loop explicitly (browsers cap live contexts per page).
// Fixed a real bug found while testing: the "Loading 3D view..." placeholder was never
// cleared before the actual <canvas> got appended, so the unpositioned, 100%-height
// placeholder div pushed the canvas out of view beneath it instead of being replaced by
// it — caught via a new permanent check (temporarily reverted the fix, confirmed the
// check fails with the expected message, restored it). Full staged plan (Stages 1-5:
// real data grouped by element type via InstancedMesh, connectors + section/stream
// clustering, a master cube-order fallback list, zoom-to-2D-detail, live simulation
// overlay) recorded in DESIGN_DOCUMENT.md §9 so it doesn't need re-deriving later. Full
// suite 41/41.
// 0.805: New top-level "Explore" menu (index.html, after Simulation) — for alternate,
// whole-model visualizations, distinct from Catalogs' per-entity tables and Advanced's
// one-shot commands. Moved 3D View there from Catalogs (its first and, for now, only
// item). check_view3d_boots and the docs updated for the new menu location.
// 0.806: Stage 1 of the 3D View (Explore menu): real data. Parts are grouped into one
// THREE.InstancedMesh per element type (instancing from the start, not retrofitted
// later), layered in Z by element group first (each group's first-seen position while
// walking the active stream template's value[] — Enterprise's own chain visits General,
// then Business, then Application, then Data, in that order; a group the template never
// mentions is appended afterward in elementGroups' own declared order), then by type
// within that group (the template's own value[] position, falling back to tkDisplayOrder
// for a type outside it — Stage 3 will give that fallback case a real order). Reuses the
// existing Stream/Type filters and element-group fill colors unchanged — main.js's
// filter-menu handlers now branch on tab.type === '3d' to source their available-options
// list from store.doc.parts directly (the whole model) instead of one view's
// viewMembers, and the toolbar enables both filter buttons for this tab type too.
// syncSceneData skips rebuilding entirely when a cheap signature (part ids, active
// filters, stream-template preference, theme) hasn't changed since the last sync, so the
// frequent app.render() calls that fire on nearly every store mutation don't pay for a
// full InstancedMesh rebuild when nothing relevant changed — verified this actually
// works (and that the layer ordering is actually correct) via a new permanent check,
// each assertion confirmed to catch its own deliberately-reintroduced regression before
// being trusted. Verified at real scale: 22,399 parts / 60,530 connectors generated and
// rendered with zero console errors, nearly-instant no-op re-syncs (~7ms). Also: new
// top-level Explore menu (after Simulation) — 3D View moved there from Catalogs, its
// first and, for now, only item. Full suite 42/42.
// 0.807: Stage 2 of the 3D View (Explore menu): connector lines and section/stream
// clustering. A connector draws iff BOTH its endpoints are currently visible — the same
// "hide the node, its connectors disappear too" convention the 2D canvas already uses
// (passesStreamFilter's own comment), not a new rule invented for 3D — rendered as one
// THREE.LineSegments with a single shared BufferGeometry (one draw call for every
// visible connector, the line-drawing equivalent of Stage 1's InstancedMesh choice).
// Within a type's own grid, parts now sort by (section, then a representative stream,
// then id) before layout, and layoutGridWithSectionBreaks forces a new row at every
// section boundary, so a section's parts occupy their own visually distinct band instead
// of packing straight across into the next section's; same-stream parts end up adjacent
// via the sort even without their own forced break. computeSignature grew accordingly —
// every part's type/streams/section (not just id, so retyping an existing part via the
// property panel is now caught, a real gap in Stage 1's signature) and every connector's
// id/from/to (catches add/remove and rewiring) — verified still comfortably fast at real
// scale (~29ms for a no-op signature check over 22,399 parts + 60,530 connectors). New
// permanent regression check (fixture sized so natural packing and clustering-aware
// packing would actually disagree, not coincidentally match), each assertion confirmed
// to catch its own deliberately-reintroduced regression before being trusted. Full suite
// 43/43.
// 0.808: Stage 3 of the 3D View (Explore menu): custom.json's new cubeOrder — a
// hand-authored, flat list covering all 74 known element types, grouped by
// ArchiMate-conceptual layer (General, Strategy/Motivation, Business, Application,
// Technology, Data, Implementation/Migration, Unknown) — is now the fallback layer order
// (both group and type) for anything the active stream template's value[] doesn't
// mention, replacing the old fallback of elementGroups' own JSON declaration order
// (which was never a deliberate sequence, just authoring order). view3d.js's
// resolveLayerOrder now walks [...templateValue, ...cubeOrder]: the template's own
// choices always win; cubeOrder only fills in what's left, which for a typical
// handful-of-types template is most of the 74 types. New permanent regression check
// using the built-in 'Test' template — the one case found where the old and new
// fallbacks actually disagree on group order (General vs Application) rather than
// coincidentally matching, confirmed to catch the regression via temporarily reverting
// to the old fallback before restoring the fix. Full suite 44/44.
// 0.809: Stage 4 of the 3D View (Explore menu): zoom-to-2D-detail. Click a part to focus
// it (recenters OrbitControls' orbit target on it, shows a wireframe highlight marker);
// zoom in past a distance threshold while focused jumps to a 2D canvas view that already
// has that part placed (selecting it there) — a jump, not a continuous 3D->2D morph, the
// deliberately cheaper option. Double-click a part to jump immediately. A part placed on
// no view yet just toasts. Click/double-click are hand-distinguished from an
// OrbitControls drag-to-rotate release (which still fires a native browser click at the
// drag's end point) by checking the pointer barely moved since its own pointerdown.
// Real dead end hit along the way: InstancedMesh.setColorAt/.instanceColor did not
// visually render a per-instance highlight color against this vendored Three.js build
// (the underlying color buffer was verified correct via getColorAt, but the cube's
// rendered color never changed), and material.vertexColors = true (the first attempted
// fix) made it worse — solid black — because vertexColors reads a per-geometry-vertex
// color attribute, absent on plain BoxGeometry, a different mechanism from
// InstancedMesh's own separate instanceColor. Abandoned per-instance color entirely for
// a separate, reusable wireframe marker mesh, repositioned/shown/hidden to indicate
// focus — simpler and correct regardless of per-instance-color shader support. New
// permanent regression check covers click-to-focus, the zoom-threshold jump firing
// exactly once per crossing (verified via a spy on the navigation call count, not just
// resulting state, since a duplicate jump to an already-open view looks identical to a
// single one) rather than once per animation frame during OrbitControls' damped zoom,
// re-arming after zooming back out and in, and the no-placement toast path — each
// assertion confirmed to catch its own deliberately-reintroduced regression before being
// trusted. Full suite 45/45.
// 0.810: 3D View click now shows the clicked part's own properties in the Properties
// panel — via tab.selectedCatalogRow, the exact same mechanism the Parts Catalog table's
// row selection already drives (render.js's renderProperties dispatch extended to also
// fire renderCatalogRowProperties for a '3d' tab, not just 'table'), so it's the
// identical "Part" editor a canvas node click or catalog row gets, no new rendering
// path. Previously a click only recentered the camera and showed the wireframe marker —
// no properties appeared anywhere. Also fixes double-clicking a part with no view
// placement: it used to just toast "isn't placed on any view yet" and leave the panel
// empty; now it shows that part's own properties instead (the same thing a plain click
// already shows), which is more useful than a dead-end toast — and the zoom-triggered
// jump falls back the same way for an unplaced focused part. jumpToMatching2DView now
// takes the 3D tab's id so it can reach that tab's own selectedCatalogRow for this
// fallback. Permanent regression check updated to assert the panel actually renders the
// clicked/unplaced part's fields (not just that the state field got set), confirmed to
// catch a deliberately-reintroduced regression before being trusted. Full suite 45/45.
// 0.811: fix Load SFCCE's field-mapping wizard silently omitting a real field from the
// selector list. flattenJsonRecords' "carry the outer record's own fields forward into
// the next nesting pass" step excluded every Array value wholesale, not just
// array-of-OBJECTS values (the ones that genuinely need a further unwrap pass) — so an
// already-flat array-of-primitives field (e.g. an Application Capability's own
// "sections"/"ministries" list) got silently dropped the moment there was ANOTHER nested
// array-of-objects field below it (e.g. that same Application Capability's "entities").
// This didn't surface with a file where the array field was the deepest level (nothing
// left to flatten past it, so the drop never triggered) — only with a real generated
// SFCCE file (capabilities-legal-SFCCE.json) that had a further "entities" nesting
// underneath "sections". Fixed by only excluding array-of-objects (and plain nested
// objects) from the carry-forward, keeping arrays of primitives intact through
// arbitrarily many further nesting levels. New permanent regression check
// (check_sfce_array_field_survives_deeper_nesting) confirmed to catch the exact
// regression via temporarily reverting the fix before restoring it. Full suite 46/46.
// 0.812: Stage 5 of the 3D View (Explore menu) — live simulation overlay. Every
// currently-visible part with a store.simRuntime entry for its own model gets a small
// colored marker floating above its cube — green/blue/red for normal/changed/error,
// SIM_STATE_COLORS mirroring .fnode-sim-badge's own CSS colors exactly, the SAME encoding
// the 2D canvas's Show Simulation Values badge already uses. A 'changed' marker
// additionally pulses (its scale oscillates every animation frame) — 3D's stand-in for
// the 2D badge's static "changed" border color, since a static color reads less clearly
// in a scene you're also free to rotate. Current-tick only, color+pulse only (no numeric
// text) — both decided up front. Deliberately bypasses the structural rebuild signature
// (a continuous Run calls app.render() every ~500ms without touching anything that
// signature tracks), keeping its own much cheaper signature instead.
// Two real bugs found and fixed along the way, both via real-scale testing (22,399
// parts): (1) the overlay's first version called store.findPart per visible part — an
// Array.find, linear scan over the whole document — turning a routine no-op render() into
// an O(n^2) scan, ~16 SECONDS at real scale once any simulation had been stepped; fixed by
// having syncSceneData's own placement loop stash each part's model directly onto its
// partPositions entry, so the overlay never needs a store lookup at all. (2)
// createInstance captured inst.animId as a one-time snapshot at object-construction time,
// so it went stale after the very first animation frame — disposeInstance's
// cancelAnimationFrame(inst.animId) was then always cancelling an already-fired, harmless
// id, never the actual pending frame, silently leaking a forever-running render loop on
// every closed 3D tab; fixed by writing inst.animId directly inside animate() itself.
// Two new permanent regression checks (check_view3d_sim_overlay,
// check_view3d_dispose_cancels_current_animation_frame), each confirmed to catch its own
// deliberately-reintroduced regression before being trusted. Full suite 48/48.
// 0.813: new File > Load Example, "smart factory 3d demo.json" — a 21-part/20-connector
// smart-factory monitoring model spanning every ArchiMate layer and two sections (Plant
// North/South), built specifically to show off the 3D View end to end: a real layered
// cube with cross-layer connectors, click-to-focus/properties and double-click-to-2D-jump
// (Stage 4), and a live simulation overlay (Stage 5) — five Device sensors emit noisy
// periodic readings, one intermittently faults (drops offline every 5th tick), two
// Gateways + an Analytics Engine average the signal through a real multi-hop propagation
// chain, and an edge-triggered anomaly check raises a script badge + logs a Message Log
// alert when the combined score swings away from its own recent trend. Verified end to
// end via a real browser: both a direct store.loadFromJSON and the actual File > Load
// Example menu flow, confirmed zero console errors, confirmed the anomaly/alert path
// actually fires over enough ticks. Full suite unaffected, still 48/48 (this is a new
// data asset, not a code change).
// 0.814: 3D View usability follow-ups. Clicking a part no longer recenters the camera
// (focusPart used to controls.target.copy(position) on every click; now it only
// remembers the part's world position for the zoom-jump distance check, leaving
// controls.target alone — click highlights in place, same as a 2D canvas selection
// doesn't recenter the canvas). New node right-click context menu: "Filter to Streams"
// (tab.activeStreams) and a Connector Type quick filter (tab.connectorTypeFilter:
// null/'c'/'s' — the 3D view previously drew every connectorType together with no way to
// narrow it, unlike the 2D canvas's own chkShowConnectorType/chkShowStreamType view
// checkboxes). OrbitControls' RIGHT button (default: pan) remapped to null and MIDDLE to
// pan, freeing right-click for the menu. Stream filter menu gained the same Select All /
// Exclude All top row the Element Type filter already had — required unifying
// tab.activeStreams onto the same null(unfiltered)-vs-[](exclude all) convention
// passesElementTypeFilter already used (was: empty array always meant unfiltered, with
// no way to represent "show nothing").
// Also fixes a real bug found in ALREADY-SHIPPED v0.813: the click listener called
// focusPart but never selectPartInPanel, so "click shows properties in the panel" (added
// the version before) silently never worked for a genuine mouse click — only
// debugFocusPart (the test hook, with its own separate correct call) exercised it, so
// the existing test passed despite the real path being broken. Found via a new
// debugGetScreenPosition test hook (projects a part's world position to on-screen client
// coordinates) that let a permanent check drive a genuine page.mouse.click() for the
// first time instead of only the debug shortcut. Four new/updated permanent regression
// checks, each confirmed to catch its own deliberately-reintroduced regression. Full
// suite 51/51.
// 0.815: fix a WebGL-context leak — File > Load, Load Example, and Recently Opened all
// replace store.doc by wiping store.tabs = [] directly rather than closing each tab
// through App.closeTab, the only path that normally disposes a 3D tab's WebGL context/
// animation loop. An open 3D tab survived that wipe with its render loop leaking forever
// in the background (invisible once its own page-<id> DOM container gets removed by the
// next render(), but never actually torn down). Found while investigating a user report
// of a previous simulation's markers still visibly pulsing after loading a different
// file — that specific report's cause turned out to be Load SFCCE, which intentionally
// MERGES rather than replacing (correct by design), but this leak was real and
// independently worth fixing. Fixed via new App.disposeAllOpenView3DTabs(), called
// before the tab wipe in all three load paths. New permanent regression check
// (check_view3d_disposed_on_full_document_load), driven via a genuine File > Load
// through the real UI, confirmed to catch the regression via a temporary revert before
// being trusted. Full suite 52/52.
// 0.816: fix multi-select common-attributes panel silently missing an entire field
// level. It built its field list from ONLY viewMember-level showFields (nodes) or ONLY
// connector-level showFields (connectors), never merging in the other level — so every
// part-level field (streams, label, description, script, ...) was entirely unavailable
// when multi-selecting nodes, and every viewMember-level field (fillColor, ...) was
// entirely unavailable when multi-selecting connectors, regardless of value (not a
// blank-values special case — those fields were simply never considered). Fixed by
// merging both levels' showFields into the multi-select spec (entity-level wins the
// 'note'/'order' name collision, both genuinely different fields at each level, matching
// what getFieldValueForItem already resolved them to before this fix), and extending
// getFieldValueForItem/setFieldValueForItem to cover the full merged field set instead
// of a hand-maintained switch statement that had quietly drifted out of sync with
// showFields (a generic `part[fieldName]`/`conn[fieldName]` default now covers every
// field with no special logic, so it can't drift again the same way).
// Also adds Simulation > Code Summary: a read-only listing of every part's own script,
// for security review before running an unfamiliar simulation. Lists a script
// REGARDLESS of scriptEnabled (a disabled script could always be re-enabled later, so
// this reviews what code exists in the file, not just what's currently wired to run),
// grouped by model, each entry identifying its source part (label/type/id) and
// enabled/disabled state. Reuses promptTextEdit's existing readonly mode (the same
// "larger editor" modal a field's own double-click-to-expand already opens) rather than
// building a new modal.
// New/updated permanent regression checks (check_multiselect_shows_entity_level_fields,
// check_code_summary), each confirmed to catch its own deliberately-reintroduced
// regression before being trusted. Full suite 54/54.
// 0.817: four requests. (1) The Parts Catalog / 3D View node Copy button now includes
// every showFields.part field with a value (was a hand-picked handful: Type/Label/Model/
// Note/Streams, never updated as more fields were added) — Id, Section, Order, Script
// Enabled/Script, Created/Updated, etc. (2) Generate Industry's "Place on current view"
// checkbox now defaults unchecked — the faster, more common path for a large dataset.
// (3) A new Section filter (tab.activeSections, passesSectionFilter) alongside Stream/
// Type, same two places (toolbar, canvas AND 3D), same null(unfiltered)-vs-[](exclude
// all) convention, with a '(no section)' option for parts with no section at all; Remap's
// "only filtered nodes" option and Connector Levels both pick it up for free via
// isAnyVisibilityFilterActive. (4) The 3D View now draws a visible boundary (a flat
// rectangle outline) plus a billboarded text-sprite label around each Part.section's own
// cluster within a type's grid, at that type's own Z — one per (type, section) pair
// actually present, mirroring the row-break clustering layoutGridWithSectionBreaks has
// always done per-type (never aggregated across types/Z-layers). Verified clean at real
// scale (22,399 parts, zero console errors, negligible render-time impact).
// New/updated permanent regression checks (check_catalog_row_copy_includes_all_part_fields,
// check_generate_industry_place_on_view_defaults_unchecked, check_section_filter,
// check_view3d_section_boundaries), each confirmed to catch its own deliberately-
// reintroduced regression before being trusted. Full suite 58/58.
// 0.818: fix Section not propagating to a whole generated chain. createStream's Section
// identifier only ever lives on the source data at the function level (Load SFCE's own
// semantics), but the code applied it only to the part actually typed as the function —
// every other part the SAME createStream call creates (capability, application
// capability, entity, every passive node) got section: '' regardless. Since the new
// Section filter (and its 3D boundary/label, v0.817) is exactly what makes this visible,
// filtering to one section used to show just the lone function node, hiding the rest of
// its own chain — reported directly from using it: "if I filter to Agriculture, I want
// to see all the nodes related to the section, not just the business function nodes."
// Both createStream's main value[] loop and createPassiveNode now set
// section: functionSection unconditionally for every part THEY create, but never touch
// it when reusing an existing part (a capability shared across streams from two
// different sections keeps whichever section it was first created with). New permanent
// regression check (check_generate_industry_propagates_section_to_whole_chain, using the
// built-in SFCCE template's 9-type chain + 2 passive pairs), confirmed to catch the
// regression via a temporary revert. Full suite 59/59.
// 0.819: fix single-node Level Down (double-click a node with no linked view yet)
// reusing the SAME part as the new sub-view's own anchor — a second viewMember of the
// identical Part, not a new one — meaning editing/renaming/retyping the decomposition's
// own anchor there silently edited the summary-level node too. Reported directly from a
// real scenario: DataEntity 'in' -flow-> Process 'process1' -flow-> DataEntity 'out';
// leveling down on 'process1' should create a genuinely new Process part to build the
// decomposition around. levelDownSingle now creates a new Part (type/label/model/
// streams/note/order/other copied from the original, as a starting point — same
// approach Split Node already uses) for the anchor, and NEW connectors (copying the
// original's model/connectorType/relationship/streams as a template) pointing at it —
// reusing the ORIGINAL connectors here would leave their from/to referencing the old
// part even though the view visually shows them attached to the new one. The external
// copies of the crossing connectors' neighbors (the real 'in'/'out' parts) are still
// correctly reused as-is — only the leveled-down node itself needed to become new. The
// original node and its original connectors up at the parent level are untouched either
// way. New permanent regression check (check_level_down_single_creates_new_part),
// confirmed to catch the regression via a temporary revert. Full suite 60/60.
// 0.820: v0.819 fixed Level Down to give the new sub-view a genuinely separate anchor
// Part — but that meant a connector added to the PARENT-level part afterward had no
// relationship to the child anchor at all. Reported directly: "if I add a dataentity
// and connect it to the process, the new part does not show up in the lower level as an
// external part. Smart check view brings in the part process, which we don't want as
// we're in that process. Smart check node doesn't see the new connection to its
// parent." Fixed with a Composition connector (parent -> anchor, created unplaced by
// levelDownSingle) plus new composition-awareness in Smart Check View/Node:
// pullInCompositionParentConnections proactively mirrors the parent's own connections
// onto the child anchor (creating + placing a mirrored connector, pulling the other end
// in as external if missing-nodes is checked); redirectViaCompositionChild is a BFS
// safety net that stops the classic "missing node" walk from independently
// rediscovering and duplicating the parent itself via some other already-on-view shared
// neighbor (guards against a self-loop when the BFS reaches the Composition link
// itself); mirrorCompositionChildConnectorsUp handles the reverse direction — a new
// connection made AT the child level to something genuinely external gets mirrored back
// up to the parent, while a connection to a sibling under the same parent (purely
// internal to this decomposition) is correctly left alone, per the user's own stated
// rule. Four new permanent regression checks (check_level_down_creates_composition_link,
// check_smart_check_composition_top_down, check_smart_check_composition_bottom_up,
// check_smart_check_node_composition_redirect), each confirmed to catch its own
// regression via a temporary revert. Full suite 64/64.
// 0.821: fix v0.820's composition-mirrored connectors going stale after their SOURCE
// changed. Reported directly: "smart check does not update the connector type, end
// points etc. if external->child connector is different than external->parent." The
// mirror lookup matched an existing mirror by its CURRENT from/to/connectorType — so
// once the source connector's relationship, streams, or other endpoint changed, that
// lookup simply failed to find the now-stale mirror and would have created a SECOND,
// orphaned one instead of updating it in place. Fixed with a persistent `mirrorOf`
// field on Connector (js/state.js: added to createConnector's params/object literal
// and migrateDoc's connector whitelist) pointing at the source connector's id — a link
// that survives the source's endpoint moving, unlike a from/to match. New
// syncMirroredConnector (js/commands.js) finds-or-creates a mirror via this field and,
// if found with drifted fields, updates + restyles it via a new Store.restyleConnector
// (factored out of createConnector's own style-lookup, now shared as
// connectorStyleFields in state.js) rather than leaving it untouched or duplicating it.
// pullInCompositionParentConnections/redirectViaCompositionChild (top-down) also now
// repair a placed connector viewMember's fromVmId/toVmId if the source's endpoint
// moved; mirrorCompositionChildConnectorsUp (bottom-up) resyncs the same way. Smart
// Check's return value and toast gained a `connectorsUpdated`/"N resynced" count.
// Deliberately still never DELETES a mirror whose source no longer qualifies (e.g.
// retargeted onto a sibling) — stays additive/corrective, not destructive, like the
// rest of Smart Check. New permanent regression check
// (check_smart_check_composition_mirror_resyncs, covering relationship+streams drift
// and a full endpoint retarget, asserting exactly one mirror ever exists per source),
// confirmed to catch the regression via a temporary revert. Full suite 65/65.
// 0.822: v0.821's sync fix only covered connectors SMART CHECK ITSELF creates — Level
// Down's own crossing connectors (the "external neighbor" copies it makes at level-down
// time, for context that existed BEFORE leveling down) were never tagged with
// mirrorOf, so they were completely invisible to the sync mechanism. Reported directly,
// with the user's own exact scenario: dataentity_p1 -> connector_p1 -> businessprocess_
// p1 -> connector_p2 -> dataentity_p2; leveling down creates dataentity_p1 (external)
// -> connector_c1 -> businessprocess_c1 -> connector_c2 -> dataentity_p2 (external);
// "if I change connector_c2, connector_p2 never changes... when will it change?".
// Fixed levelDownSingle to tag each crossing connector with mirrorOf pointing at the
// original it was copied from. That alone would have made things WORSE, though: the
// existing sync direction (source always wins onto mirror) is fixed parent-authoritative
// — tagging connector_c2 as "a mirror of connector_p2" without also making sync
// bidirectional would mean editing connector_c2 and running Smart Check silently
// REVERTS it back to match the untouched connector_p2, instead of just failing to
// propagate. So syncMirroredConnector (js/commands.js) is now genuinely bidirectional —
// findCrossingCounterpart looks up a pair's other half regardless of which side
// mirrorOf is recorded on, and whichever side was touched more recently pushes its
// relationship/connectorType/streams onto the other (endpoints stay one-directional,
// source's own from/to always wins onto its mirror — retargeting a connector's
// placement on some OTHER, not-currently-open view isn't safe to do from here).
// "More recently" needed a real fix of its own: comparing `updatedAt` (nowStamp,
// SECOND-level precision) meant two edits in the same real-world second — an entirely
// normal occurrence, not just a fast test — compared as a tie and picked the wrong
// direction, confirmed via a temporary revert that failed 5/5 runs. Replaced with a new
// monotonic `_touchSeq` counter (Store constructor's `_connectorTouchSeq`, stamped by
// createConnector/touchConnector) — deliberately NOT part of migrateDoc's persisted
// whitelist, so it simply resets to a fresh, all-tied baseline after a save/reload
// rather than needing to survive across sessions. Two new permanent regression checks
// (check_smart_check_level_down_crossing_connectors_sync_bidirectionally, and a fix to
// check_smart_check_composition_mirror_resyncs which needed its own missing
// touchConnector call to keep passing under the new recency logic), each confirmed to
// catch its own regression via a temporary revert (including 5 repeated runs for the
// same-second timestamp case specifically, given its previously nondeterministic
// nature). Full suite 66/66.
// 0.823: replaced v0.822's automatic bidirectional recency-based Composition-crossing
// connector sync with an explicit, user-driven design, per direct feedback: "still not
// working... let's change approach." The automatic version was too easy to distrust —
// a Smart Check run could silently rewrite either side's relationship/streams with no
// warning, and there was no way to tell it to leave things alone. Now: (1)
// App.promptSyncInventoryConnector (main.js), hooked into the property panel's
// Relationship/Streams setters (both connector panels) and the on-canvas edge popover
// — NOT the multi-select bulk-edit path — asks "update the related inventory connector
// too?" right at edit time via the existing confirmModal, and only pushes the change if
// you say yes; silent no-op for the common case of a connector with no counterpart. (2)
// Smart Check View/Node gained a new "Sync existing connectors with inventory"
// checkbox, off by default: only when checked does it compare each connector already
// on the view (or, for Node, touching that node) against its inventory counterpart and
// pull relationship/connectorType/streams from the inventory side into the view side —
// one direction only, never automatic. syncMirroredConnector (js/commands.js) is
// simplified back down to find-or-create-plus-endpoint-repair only; the recency
// comparison and its `_touchSeq` plumbing (js/state.js) are removed entirely as
// unused. The underlying `mirrorOf` linkage (added in 0.822, letting Level Down's own
// crossing connectors and Smart-Check-created ones both be found via the new
// findCrossingCounterpart, now exported) is unchanged and still what both new
// mechanisms use to find "the related inventory connector." Three new permanent
// regression checks (check_smart_check_sync_with_inventory_checkbox,
// check_prompt_sync_inventory_connector, and
// check_property_panel_relationship_edit_triggers_sync_prompt — the last driving the
// REAL property-panel <select> element, not just a direct function call) replace the
// two checks for the removed automatic mechanism, each confirmed to catch its own
// regression via a temporary revert. Full suite 67/67.
// 0.824: fix Level Down placing a downstream ("to" side) external neighbor at a fixed
// x=900 regardless of the anchor's own position or the view's node size — reported
// directly as "placed far right... can this be updated to place it closer, one node
// width to the right of the right-most node that is not external." At the point this
// runs, the anchor (selfVm) is always the only non-external node on the freshly
// leveled-down view, so "right-most non-external node" simplifies to selfVm itself:
// now placed at selfVm.x + getNodeSize(view).w instead of the hardcoded 900. The
// upstream ("from" side) neighbor's placement (x=20, near the left edge) was never
// reported as a problem and is unchanged. Also fixed a stale doc comment nearby still
// describing 0.822's automatic "whichever was touched more recently wins" mirrorOf
// sync, which 0.823 replaced with the explicit confirm-prompt/checkbox design. New
// permanent regression check (check_level_down_downstream_external_placed_near_anchor
// — assertions are tolerance-based, not exact-equality, since levelDownSingle's own
// trailing redrawAndResolveLayout call can resize/reflow nodes after this placement
// runs), confirmed to catch the regression via a temporary revert. Full suite 68/68.
// 0.825: data correction, not a code change — audited public/custom.json's elements
// list against the TOGAF 9.2 Content Metamodel (core entities plus the Governance,
// Data, Infrastructure Consolidation, Motivation, and Migration Planning extensions)
// and added the 't' (TOGAF) source code to 18 elements that correspond to a standard
// TOGAF entity but were only tagged 'a' (ArchiMate): BusinessActor (Actor),
// DataDataEntity (Data Entity), BusinessRole (Role), ApplicationFunction and
// ApplicationProcess (Function/Process — inconsistent with BusinessFunction/
// BusinessProcess/TechnologyFunction/TechnologyProcess already being tagged),
// Capability and BusinessCapability, Contract, Product, Location, Driver, Goal,
// Constraint, Principle, Requirement, Gap, WorkPackage, and Stakeholder. This only
// affects which elements the Toolbox's TOGAF library filter surfaces (see
// renderToolbox/js/render.js's codeMap) — verified live: filtering to TOGAF-only now
// shows exactly the 32 expected elements (was 14). No application logic changed, so no
// new permanent regression check — full suite still 68/68 (unaffected). Also
// identified, but deliberately left untouched pending further review: Business Event
// is missing from the elements list entirely (independent of TOGAF tagging — ArchiMate
// has it, this app doesn't), and TOGAF's Measure/Service Quality/Assumption entities
// have no corresponding element at all.
// 0.826: added the missing BusinessEvent element (Business group, tkDisplayOrder 12 —
// appended after Representation rather than reordering the group's existing 12
// entries; same lightning-bolt icon path already shared by ApplicationEvent/
// TechnologyEvent/ImplementationEvent; sources: 'a' only, matching those same
// siblings — left ungraded for TOGAF pending the same confirmation caveat as
// Deliverable/Plateau/ImplementationEvent in 0.825). No relationshipPairs entry added
// either, again matching the other Event types' existing (unrestricted) precedent.
// While verifying this, found a real near-miss: custom.json's cubeOrder (3D View's
// fallback ordering list, "a hand-authored master list covering every element type"
// per its own doc comment) has no enforcement keeping it in sync with
// settings.elements — BusinessEvent worked immediately in the Toolbox and on canvas
// without it, and would have silently gotten 3D View's defensive fallback ordering
// instead of its intended position if I hadn't caught it manually. Added BusinessEvent
// to cubeOrder too (same position, after Representation), and a new permanent
// regression check (check_cubeorder_covers_all_elements, verifying the full 1:1
// correspondence in both directions) to catch this class of omission for any FUTURE
// new element type, confirmed to catch the regression via a temporary revert. Full
// suite 69/69.
// 0.827: added the last two elements flagged missing by 0.825's TOGAF audit — Measure
// (Governance extension) and Assumption (Motivation extension), neither of which has
// an ArchiMate counterpart to borrow an icon/placement from, unlike BusinessEvent in
// 0.826. sources: 't' only (no 'a' — these aren't ArchiMate elements). Measure placed
// in the General group (tkDisplayOrder 6, after Location) as a generic governance
// artifact not tied to one architecture layer; Assumption in Strategymotivation
// (tkDisplayOrder 13, after Value) alongside the app's other TOGAF/motivation-adjacent
// elements (Driver, Goal, Constraint, Requirement, Stakeholder, ...). New hand-drawn
// icons: Measure a simple ascending bar chart, Assumption a question mark in a circle
// (both compared against alternate candidates rendered side-by-side before picking).
// Both added to cubeOrder in the same relative positions, verified via
// check_cubeorder_covers_all_elements (added in 0.826 specifically to catch this).
// No relationshipPairs entries added, matching the other ungoverned/generic element
// types' existing precedent. Full suite 69/69 (unaffected — pure data addition).
// 0.828: added a contact email to the small-screen overlay's ("DyCAD needs a larger
// screen") body text, right before the "Continue anyway" link. Cosmetic text-only
// change, verified in a real browser at a sub-800px viewport width; full suite
// unaffected (69/69, no new check — nothing here is application logic to regress).
// 0.829: three requests.
// (1) Fix: Export View as Image (buildViewSvgString, main.js) only ever drew
// connectors and part nodes — a section-based view's (e.g. 'org') section boxes and
// header labels, visible on the real canvas, were completely absent from the exported
// SVG/PNG. Reproduced the same visual (dashed rounded box, faint fill, dashed header
// separator, muted bold label) in plain SVG. Also had to fold section bounds into the
// overall bounding box computation, not just part positions — an empty section (or one
// extending past its placed nodes) was otherwise silently clipped out of frame.
// (2) Enhancement: keyboard Delete/Backspace (App.deleteSelection) now offers, via a
// single confirm after the viewMember(s) are already removed from the current view, to
// also delete the underlying part/connector from the model entirely — but ONLY when it
// just lost its last placement anywhere, and for a part specifically, only if nothing
// still connects to it (deleting a part some connector still references would leave
// that connector's from/to dangling). Declining leaves it exactly as before — this is
// purely an added option, the old view-only deletion is unchanged when declined.
// (3) Enhancement: Add Existing (right-click on a section-based view) now pre-filters
// its row list to types valid for the section the pointer landed in; right-clicking
// outside any one specific section (but still on a section-based view) falls back to
// the union of every section's own allowed types (getAllowedTypesForView) instead of
// the whole model; a plain freeform view is never filtered, matching how
// dropNewPart/getAllowedTypesForView already gate a NEW node's drop target.
// Three new permanent regression checks (check_export_svg_includes_sections,
// check_delete_offers_inventory_cleanup, check_add_existing_prefiltered_by_section),
// each confirmed to catch its own regression via a temporary revert. Full suite 72/72.
// 0.830: fix 0.829's Add Existing pre-filter — it correctly filtered the ROW LIST by
// the clicked section, but never touched WHERE added parts actually get placed, which
// is a completely separate code path (addExistingPartsToView's createSectionPlacer,
// commands.js) that only ever asks "does ANY section (in view order) allow this type,"
// with no notion of where the user clicked at all. Reported directly: "ignores mouse
// location or selected section, always adds to first section." Fixed by threading the
// resolved target section through as a new targetSectionInstanceId param —
// addExistingPartsToView now places every added part directly into that section (via
// findFreeCellOrGrowSection, the same grow-rather-than-overlap search drag-and-drop
// already uses) instead of deferring to the generic placer, whenever one was
// resolved. promptAddExisting (main.js) also gained a fallback the original pass
// didn't have: if the click itself didn't land inside any specific section, but one is
// already selected (tab.selectedSectionId, from clicking a header), that's used for
// both the list filter AND placement before falling back further to the view-wide
// union. Also fixed an inconsistency the fallback logic exposed: with NO canvasPos at
// all, a section-based view now still applies the view-wide union filter (nothing in
// any of its sections could ever accept a type none of them allow, regardless of
// whether you clicked) — previously true only when canvasPos was present. Rewrote
// check_add_existing_prefiltered_by_section to cover actual PLACEMENT (not just the
// list) using two sections that both allow the same type — the one case that exposes
// "always lands in the first section," since the generic placer would happily accept
// either — plus the selected-section fallback; confirmed the rewritten check catches
// the regression via a temporary revert. Full suite 72/72.
// 0.831: four requests.
// (1) Moved 'Script Console...' and 'Code Summary' from the Simulation menu to the
// Advanced menu, after a separator — neither is actually a simulation action (Script
// Console works with no model selected at all; Code Summary reviews every model's
// scripts, not the selected one).
// (2) New Store field batchScriptCode (state.js) — a persistent "batch script" text,
// independent of any one document, defaulting to a ready-to-run starter
// (DEFAULT_BATCH_SCRIPT_CODE). Local Settings-persisted exactly like
// maxScriptEntities/nodeSizeMultiplier: cached to localStorage, bundled into File >
// Save/Load Local Settings, auto-applied on boot. Also now shown in Code Summary
// (a new top section, ahead of the existing per-part scripts listing) — "these can be
// viewed in Code Summary and saved along with user local settings."
// (3) Script Console (App.promptScriptConsole, main.js) reworked: the editor's text IS
// store.batchScriptCode now — pre-filled on open, persisted on every Run AND on Close,
// never cleared after Run — not a one-off REPL entry anymore. Run no longer evaluates
// the text directly: it defines everything in the box, then calls a predetermined
// top-level main() (new bindings besides the existing app/store/model/findParts/log:
// messageLog, generateIndustry, populateFromTemplate). main() can call any other
// function defined alongside it with no extra plumbing — every top-level function
// declared in the box shares the same closure over the bindings, since they're all
// parameters of the single generated wrapper function the whole box's text runs
// inside. A script with no top-level main() reports a clear error instead of silently
// no-op'ing.
// (4) New default script: BatchScript_QuickStart, called by main() out of the box.
// Generates the built-in "general" industry (parts/connectors only, not placed — the
// template below does the placing), creates a new "Business Functions" view (viewType
// 'org' = "Business Function Organization"), runs Populate From Template with
// "Enterprise Functions" inside it, shrinks the "mof" (Mainstream Operational
// Functions) section's rowCount from its default 2 down to 1, zooms that view's tab to
// 60%, and writes "Done" to the persistent Message Log. Verified end-to-end in a real
// browser (screenshot-checked) before writing tests.
// Five new permanent regression checks
// (check_script_console_and_code_summary_moved_to_advanced,
// check_script_console_runs_main_function, check_batch_script_quickstart,
// check_batch_script_code_persists_with_local_settings, plus check_code_summary
// updated for the new menu location and the batch-script section), each confirmed to
// catch its own regression via a temporary revert. Full suite 76/76.
// 0.832: Script Console (Advanced menu) gained three more bindings: remap(app, tab,
// options), smartCheckView(app, tab, options), smartCheckNode(app, tab, partId,
// options) — the same raw commands.js functions the Remap/Smart Check View/Smart
// Check Node dialogs already call, options object and all (sortKeys/templateName/
// pattern/limitColumnsToView/visiblePartVmIds/forcePreferRight/forceGroupRows for
// remap; missingConnectors/missingConnectorsAndNodes/levels/syncWithInventory for
// smartCheckView; same plus upstream/downstream/byStream/streams for smartCheckNode).
// Reported directly: "add remap and the smartCheck functions too; add options as
// parameters for full functionality if you can." A script builds its own tab when it
// needs one (app.createCanvasTab(view) / app.switchToTab(tab.id)), same as
// BatchScript_QuickStart already does. Help text in the console itself and
// public/instructions.html updated to list every option per function. New permanent
// check check_script_console_remap_and_smart_check_bindings builds a real view/part/
// connector graph, then drives all three functions purely through the real Script
// Console UI — proving both that the bindings exist and that a downstream/upstream
// option pair genuinely filters (not just accepted and ignored); confirmed it catches
// the regression via a temporary revert of the binding list. Full suite 77/77.
// 0.833: multi-column sort for every catalog table AND the SFCCE preview table
// (canvas.js's shared renderTablePage — Parts/Connectors/Views/ViewMembers, the
// simulation log, and any tab.tableRows/tableCols table alike). tab.sortColumn/
// sortDir (a single column) replaced by tab.sortColumns, an ordered [{col, dir}, ...]
// array — the row comparator walks it in order, falling through to the next criterion
// only on a tie. Plain click on a header is unchanged (sorts by just that column,
// toggling direction on repeat clicks of the same sole column); shift+click adds
// another column as a secondary tiebreaker (or, if it's already active, flips just
// that column's own direction) without disturbing the others. Each active column's
// header shows a rank glyph (①②③...) ahead of its ▴/▾ arrow once more than one column
// is active. Reported directly: "can multi column sorting be supported? For example
// sorting parts by type and label" -> "yes, implement it for all catalogs and SFCCE."
// Two new permanent checks: check_catalog_multi_column_sort (Parts catalog — the
// tab.catalogType/catalogRows() branch) and check_sfce_table_multi_column_sort (SFCE
// preview — the separate tab.tableRows/tab.tableCols branch), each dispatching real
// click/shift+click DOM events and reading the actual rendered row order back out;
// both confirmed to catch the regression via a temporary revert (shift-click support
// removed). tests/README.md and public/instructions.html updated. Full suite 79/79.
// 0.834: fixed the 3D View's node right-click "Filter to Streams" quick filter
// (view3d.js's showNodeContextMenu) — a multi-stream part offered only one combined
// "Filter to Streams: A, B" item, which always set tab.activeStreams to every stream
// at once with no way to pick just one. Reported directly: "if the stream has
// multiple I can't select one or the other. For example 'Supplier Profile, Purchase
// Contract' shows up instead of one or the other. this is after executing
// BatchScript_QuickStart" (the Enterprise Functions template's own data has several
// multi-stream parts, so this was reachable from the shipped default script).
// Replaced with one clickable item per stream the part actually carries (checkmarked
// when it's the sole active filter), plus an "All of the above" item — only shown
// when there's more than one stream — for the old lump-them-together behavior.
// check_view3d_node_context_menu extended to prove picking one stream narrows to
// exactly that stream and SWITCHES (not stacks) when a different single stream is
// picked next; confirmed it catches the regression via a temporary revert.
// tests/README.md and public/instructions.html updated. Full suite 79/79.
// 0.835: BatchScript_QuickStart (DEFAULT_BATCH_SCRIPT_CODE, state.js) gained a final
// remap(app, tab, { pattern: 'default' }) step, right after the zoom-to-60% line and
// before the closing recordAndRender()/messageLog('Done') — requested directly.
// check_batch_script_quickstart extended to capture the Script Console's own output
// and fail if it contains "error" (proving the new remap call is wired in and
// doesn't throw — 'org' is a section-based view type, so remap routes through
// applyRemapLayoutSectioned rather than pattern-based freeform placement there,
// making 'pattern' accepted but not itself meaningful for this particular view type;
// the check documents that rather than asserting exact resulting positions).
// Confirmed it catches the regression via a temporary revert (typo'd the call so it
// throws ReferenceError). tests/README.md updated. Full suite 79/79.
// 0.836: fixed 3D View multi-stream clustering (view3d.js) — reported directly:
// "when a node is in multiple streams, the nodes crisscross columns and back later.
// Filtering to streams Purchase Order and Inventory Item is an example." Two root
// causes. (1) representativeStream() picked a part's alphabetically-first stream
// across ALL its streams, ignoring which stream(s) the active Stream filter was
// actually about — now prefers a stream from tab.activeStreams when one's set,
// falling back to alphabetically-first overall otherwise. (2)
// layoutGridWithSectionBreaks only forced a new grid row at a SECTION boundary, never
// a representative-stream boundary, so one cluster's tail could share a row with the
// next cluster's head — now forces a break on either. New permanent check
// check_view3d_multi_stream_clustering, with two isolated fixtures (one exercising
// each fix independently via exact world-Y position equality/inequality on real
// Three.js instance data), confirmed to catch each regression separately via a
// temporary revert. tests/README.md updated. Full suite 80/80.
// 0.837: 3D View connector direction indicators + toolbar-selectable Connector Type
// filter. Reported directly, after a "why does X show a connector from Y" question the
// 3D view genuinely couldn't answer: "implement direction indicators for the 3D lines
// ideally matching line end settings, and line characteristics as well, but they
// should be based on connections of type 'c' or 's', lets make that user selectable
// for the view same as the view filters already existing."
// (1) view3d.js's connector lines were one flat, undirected, uncolored LineSegments for
// every connector. Now grouped by relationship (custom.json's relationshipStyles, the
// SAME lookup the 2D canvas's own edge rendering already uses) into per-relationship
// colored/dashed LineSegments, plus a small cone/diamond/sphere InstancedMesh marker
// (resolveMarkerFamily/resolveMarkerAppearance) at whichever end(s) that relationship's
// lineEnds entry marks — a best-effort SVG-path-to-3D-primitive approximation (see
// those functions' own comments), not a pixel match: filled vs. open line-ends become a
// solid vs. wireframe marker; DASH_SCALE converts SVG-pixel dash units into roughly-
// proportioned Three.js world units. Still bounded to a handful of draw calls (one line
// mesh + up to two marker meshes per DISTINCT relationship actually present).
// (2) tab.connectorTypeFilter (null/'c'/'s', previously only reachable via the 3D node
// right-click menu) renamed to tab.activeConnectorTypes and promoted to its own toolbar
// dropdown filter (index.html/render.js/main.js), matching Stream/Type/Section's
// existing Select-All/Exclude-All + checkbox pattern instead of being buried in a
// context menu — 3D-only, disabled on canvas tabs (which have their own per-view
// chkShowConnectorType/chkShowStreamType instead). The context menu's Connector Type
// submenu is gone; Filter to Stream stays there unchanged.
// check_view3d_node_context_menu updated (Connector Type assertions removed, one added
// confirming it's gone from there); two new checks:
// check_view3d_connector_type_toolbar_filter (real toolbar clicks, disabled-outside-3D,
// genuine connectorCount changes) and check_view3d_connector_direction_markers (three
// distinct relationships' line color/dash and marker family/color/wireframe verified
// against getDebugSceneInfo's new connectorGroups/connectorMarkers fields) — both
// confirmed to catch their own regression via a temporary revert. tests/README.md and
// public/instructions.html updated. Full suite 82/82.
// 0.838: fixed persistent 3D View crisscrossing between type layers, reported directly
// after 0.836's per-type stream clustering fix: "there is still significant criss
// cross between columns, stream names seem to jump around. Is there another option to
// sort these?" -> "yes, implement that." Root cause: each type's own Z-layer computed
// its row/col grid entirely independently (its own row/col count from its own part
// count alone), so a stream's row position in one type's layer had NO relationship to
// that same stream's row position in the next layer — 0.836 only ever fixed
// crisscrossing WITHIN one type's own grid, not BETWEEN layers, where most of the main
// dependency chain's connectors actually run.
// layoutGridWithSectionBreaks (per-type, sequential-discovery row breaks) replaced by
// computeStreamLanes + layoutTypeIntoLanes: ONE shared column width and ONE shared
// row-band per (section, stream) lane, computed across every currently-visible part
// regardless of type — so a lane sits at the identical row, and therefore the same
// world Y, in every type's own layer. Traded off and accepted up front: a type with
// few parts in a lane still reserves that lane's full (globally tallest) height, so
// layers with uneven per-lane counts look sparser than the old tightly-packed-but-
// misaligned grid. check_view3d_multi_stream_clustering rewritten as
// check_view3d_stream_lane_alignment (the old fixture's exact-position math no longer
// applies to the new algorithm) — verifies 4 Alpha-stream and 4 Beta-stream parts,
// spread across two different element types, land at exactly the same world Y within
// their own stream and a different Y between streams, and that a multi-stream part
// still resolves to whichever of its streams the active filter is actually about (the
// 0.836 fix, still exercised); confirmed it catches the regression via a temporary
// revert. tests/README.md and public/instructions.html updated. Full suite 82/82.
// 0.839: custom.json's cubeOrder retired into a real streamTemplates entry, plus a new
// toolbar-only way to pick which template drives 3D layer ordering. Reported directly:
// "can we change to make cubeorder into a new streamTemplate named something like all,
// and cubeOrder list goes into value. Then provide user ability to switch
// streamTemplate for 3d view display -- they can select cubeOrder (which is what
// they're getting now) or a streamTemplate." custom.json's separate top-level
// cubeOrder field (77 types) is now a streamTemplates entry named "All", its value[]
// exactly the old cubeOrder list. New toolbar <select> "Layer Order" (index.html/
// render.js/main.js, 3D-only, disabled elsewhere) lists every streamTemplate; picking
// one persists to Local Settings (view3DLayerOrderTemplate, its OWN preference --
// deliberately separate from Remap/Generate Stream's shared "last used" template pick).
// view3d.js's resolveLayerOrder no longer blends two sources (template value[] + an
// automatic cubeOrder fallback underneath it) -- it now uses exactly the ONE selected
// template's value[], falling back to tkDisplayOrder/alphabetical for anything that
// template doesn't mention. Defaults to "All", so out-of-the-box 3D layer order is
// unchanged; picking a short template like "Enterprise" now genuinely changes the
// fallback order for everything it doesn't cover, instead of silently still following
// cubeOrder underneath it.
// check_view3d_cube_order_fallback rewritten as check_view3d_layer_order_template_selector
// (verifies the <select>'s options/default, and that "All" vs. "Test" genuinely
// disagree on unmentioned types' fallback order -- proving the auto-blend is gone);
// check_cubeorder_covers_all_elements rewritten as
// check_view3d_all_template_covers_all_elements (same 1:1-correspondence check, now
// against "All"'s value[]). Both confirmed to still catch their regression via a
// temporary revert. tests/README.md, public/instructions.html, and
// DESIGN_DOCUMENT.md updated. Full suite 82/82.
// 0.840: corrected 0.839's Layer Order template picker — "anything that template's
// value[] doesn't mention should not be shown" (0.839 only REORDERED an unmentioned
// type via the tkDisplayOrder/alphabetical fallback; it should HIDE it instead).
// syncSceneData's own parts filter now also checks resolveLayerOrder's
// templateTypeOrder — a type the selected template's value[] doesn't mention no longer
// renders in the 3D scene at all. "All"'s value[] covers all 77 known types, so this is
// a no-op there (default behavior unchanged); picking a real template like "Enterprise"
// now narrows the WHOLE scene down to just the types it actually lists. Rewrote
// check_view3d_layer_order_template_selector accordingly (BusinessCapability, which
// the 'Test' template mentions, stays visible; GeneralActor, which it doesn't, must
// disappear entirely rather than just reorder) — confirmed it catches the regression
// via a temporary revert. tests/README.md, public/instructions.html, and
// DESIGN_DOCUMENT.md updated. Full suite 82/82.
// 0.841: right-click-drag to reposition a node in the 3D View, persisted as
// Part.pin3D. Reported directly: "in 3d view can it be supported to right click an
// object and move it around?" -> confirmed persistence model: "let's try option 2
// persist, with new locations treated as pinned. Create new option somewhere to
// reset - which clears all 'pinned' new locations." New Part.pin3D field (null, or a
// real {x,y,z}, persisted with the document; state.js createPart/migrateDoc). Right-
// click-dragging a node past CLICK_DRAG_TOLERANCE (the same drag-vs-click distinction
// the left-click focus handler already uses) sets it, dragging along a plane facing
// the camera through the part's current position. A pinned part skips
// computeStreamLanes/layoutTypeIntoLanes' auto-layout grid entirely -- excluded from
// lane occupancy too, so it doesn't inflate a lane's reserved height without
// occupying a cell -- and renders at exactly its stored position. New Advanced menu
// item "Reset Pinned 3D Positions" (App.promptResetPinned3DPositions) clears every
// part's pin3D back to null in one confirmed, bulk action -- deliberately no per-part
// unpin, matching what was actually asked for. computeSignature extended to include
// each part's pin3D so a drag actually triggers a resync.
// Two new permanent checks: check_view3d_right_click_drag_pins_node (drag sets
// pin3D, suppresses the context menu for that drag, renders at exactly the pinned
// spot, excludes the part from lane occupancy -- a sibling recentres -- and doesn't
// interfere with a plain right-click elsewhere) and check_view3d_reset_pinned_positions
// (no-op with nothing pinned, confirm dialog names the exact count, Cancel leaves
// pins untouched, OK clears every pin3D with a genuine return to auto-layout).
// Testing note: Playwright's own page.mouse.down(button:'right') fires a synthetic
// contextmenu event prematurely, ON mousedown rather than after release -- a
// documented Chromium/CDP automation quirk, not real-browser behavior -- so both new
// checks dispatch raw PointerEvents plus a manually-fired contextmenu event, in the
// actual order a real browser uses, rather than relying on page.mouse. Confirmed both
// checks catch their own regression via a temporary revert. tests/README.md,
// public/instructions.html, and DESIGN_DOCUMENT.md updated. Full suite 84/84.
// 0.842: fixed 0.840's Layer Order "hide unmentioned types" fix wrongly hiding
// PASSIVE elements too. Reported directly: "in 3d view the layer order appears to be
// missing the passive elements and their connectors, when a 'Layer Order' is selected
// that includes passives." Root cause: syncSceneData's parts filter checked
// templateTypeOrder, built from the selected template's value[] ONLY -- a type
// mentioned solely via the template's passive[] from/to pairs (e.g. Enterprise's
// BusinessFunction, tied to BusinessProcess but never part of value[]'s main chain)
// was therefore treated as "unmentioned" and hidden, along with it every connector
// touching it (a connector only draws once BOTH endpoints are visible). Fixed by
// having resolveLayerOrder return a separate visibleTypes set: value[] types UNION
// every passive[] entry's from/to types. templateTypeOrder (drives Z-ordering) still
// comes from value[] alone -- a passive-only type has no natural chain position, so it
// falls to the tkDisplayOrder/alphabetical fallback tier, exactly like any other
// value[]-unmentioned type already did; only VISIBILITY was ever wrong.
// check_view3d_layer_order_template_selector extended with a BusinessFunction fixture
// (passive[]-only under the 'Test' template) alongside the existing value[]-mentioned
// and mentioned-in-neither cases; confirmed it catches the regression via a temporary
// revert. tests/README.md, public/instructions.html, and DESIGN_DOCUMENT.md updated.
// Full suite 84/84.
// 0.843: two requests.
// (1) New 3D View "Highlight" toolbar picker (3D-only checkbox-dropdown, like Type/
// Connector Type) — reported directly: "add a 'highlight' option, perhaps a dropdown
// list with checkbox but other approach can be considered, for element type in use,
// allowing user to enable for example highlighting the businessfunction parts."
// tab.highlightedTypes (plain array, default [] -- no null-vs-[] "unfiltered"
// convention, since "highlight everything" isn't a meaningful default) drives a bright
// cyan wireframe box (InstancedMesh + MeshBasicMaterial({wireframe:true}), one
// instance per matching part) around every part of the checked type(s) -- purely an
// ADDITIVE visual overlay, never a filter (an unchecked type's own rendering/part
// count is completely untouched, and the overlay is excluded from raycast hit-testing,
// so it never interferes with click/drag/context-menu). Distinct color from
// FOCUS_HIGHLIGHT_COLOR (yellow) on purpose -- a focused part and a highlighted type
// are different, simultaneously-visible concepts.
// (2) BatchScript_QuickStart (DEFAULT_BATCH_SCRIPT_CODE, state.js) now opens (and
// switches to) the 3D View as its final step, right after remap() and before logging
// "Done".
// New check_view3d_highlight_type_picker (disabled outside 3D, checking a type
// highlights EXACTLY its own parts by id, checking a second type ADDS rather than
// replaces, highlighting never disturbs another type's own InstancedMesh count, label
// text reflects the selection); check_batch_script_quickstart extended to verify the
// 3D View opens and becomes the active tab. Both confirmed to catch their own
// regression via a temporary revert. tests/README.md, public/instructions.html, and
// DESIGN_DOCUMENT.md updated. Full suite 85/85.
// 0.844: two requests.
// (1) 'Reset Pinned 3D Positions' moved from the Advanced menu to the Explore menu,
// after a separator (matching the pattern the earlier Script Console/Code Summary
// move to Advanced already used).
// (2) Toolbar filter groups (Stream, Types, Section, Connector Type, Layer Order,
// Highlight, Levels) are now HIDDEN entirely -- not just disabled -- on a tab type
// they don't apply to, instead of sitting there disabled and confusing. Reported
// directly: "Can the filters... be hidden unless active for the current tab? For
// example Highlight has no purpose and is confusing on other types of tabs." Each
// .toolbar-group wrapper in index.html got a stable id; render.js's renderToolbar
// toggles a 'hidden' class on each using the SAME applicability booleans that already
// drove .disabled (filtersApply for Stream/Types/Section, is3D for Connector
// Type/Layer Order/Highlight, canvas-only for Levels) -- so a canvas tab shows Stream/
// Types/Section/Levels, a 3D tab shows everything except Levels, and a table/catalog
// tab (or any other non-diagram tab) hides all seven. Deliberately did NOT extend this
// to Current View/Default Model -- those are navigation/global-preference controls,
// not tab-scoped filters (View literally switches to a different tab; Model is a
// persistent app-wide preference used well beyond just the active tab's own
// rendering), so hiding them would risk removing the only way to switch views/models
// while parked on some other tab; left visible everywhere as before.
// Two new permanent checks: check_reset_pinned_3d_positions_moved_to_explore (menu
// placement + separator + gone from Advanced) and
// check_toolbar_filter_groups_hidden_when_inactive (all seven groups' hidden state
// checked across canvas/3D/table tabs). Both confirmed to catch their own regression
// via a temporary revert. tests/README.md and public/instructions.html updated.
// Full suite 87/87.
// 0.845: new 3D View "View Scope" toolbar picker. Reported directly: "add the
// ability for 3d view to show data based on an existing view. This can be the same
// 3d view or a new function" -- built as a new filter on the EXISTING 3D tab (a
// <select>, like Layer Order) rather than a separate tab/entry point, so it composes
// cleanly with every filter already there (Stream/Type/Section/Connector Type/Layer
// Order/Highlight all still apply WITHIN the scoped set). tab.view3DScopeViewId
// (null = unscoped, today's whole-document default, unchanged) resolves to two id
// Sets straight from store.viewMembersForView(viewId) -- a part or connector shows
// only if it's ACTUALLY placed on the scoped view, not merely "both endpoints happen
// to also be visible" the way ordinary connector visibility works elsewhere in this
// file -- an exact mirror of that view's own 2D content. computeSignature grew a
// dependency on the scoped view's own viewMembers (only computed when a scope is
// actually set, so the common unscoped case stays exactly as cheap as before) --
// nothing else it already hashes changes when a part is merely added to/removed from
// a view, so without this a scoped rebuild could be silently skipped. Also added to
// last version's toolbar-hides-when-inactive mechanism (3D-only, like Connector
// Type/Layer Order/Highlight).
// New check_view3d_view_scope_filter: verifies the <select> lists every real view,
// scoping narrows to exactly one view's own placed parts (a same-type part on a
// DIFFERENT view must disappear) and exactly its own placed connectors (a second
// connector whose both ends are visible but which was never itself given a
// connector-viewMember on the scoped view must NOT show -- the one case that
// distinguishes "placed on this view" from ordinary endpoint-based visibility), and
// switching back to "All" restores the whole document. check_toolbar_filter_groups_
// hidden_when_inactive extended for the new group. Both confirmed to catch their own
// regression via a temporary revert. tests/README.md, public/instructions.html, and
// DESIGN_DOCUMENT.md updated. Full suite 88/88.
// 0.846: new freeform-view-only "Insert Smart Stream" command. Reported directly:
// "Add ability in freeform view to insert a smartStream. Through a dialog the user
// selects connector type (currently 'c' or 's'), starting element..., upstream/
// downstream or both indicator, ending element..., children levels..., and a selector
// checklist of element types to show." commands.js's insertSmartStream seeds a BFS
// from every part of the chosen Starting Element type, walks connectors of the chosen
// Connector Type in the chosen direction(s) up to a hop limit (blank = unlimited,
// mirroring Smart Check's own Levels convention), lets a part matching the optional
// Ending Element type still get collected without itself propagating further (so
// sibling branches keep expanding independently), then prunes the traced set down to
// the checked Element Types to Show -- a connector only survives if BOTH its endpoints
// did. Only ever places real, pre-existing connectors (never synthetic ones), so line/
// arrowhead styling is inherited for free from each connector's own relationship via
// the existing relationshipStyles lookup, satisfying "use connector line and line end
// settings of top most parents" with no new rendering code. Already-placed parts/
// connectors are skipped, not duplicated, so re-running is idempotent. Refuses to run
// on section-based views with a toast naming the view type, same convention as
// populateFromTemplate. main.js's promptInsertSmartStream is a bespoke modal (not the
// generic promptModal, which has no multi-checkbox field type) with a Select All/
// Exclude All checklist header matching the existing Type filter's own convention;
// Starting/Ending Element options are scoped to types actually present in the current
// model. Fixed a real bug found while testing: the showTypes prune was comparing
// part.type with a case-sensitive Array#includes, inconsistent with every other
// comparison in this same function (all via ciEq) -- switched to a ciEq-based match.
// Two new permanent checks: check_insert_smart_stream_traversal (connectorType/
// direction/levels/endType/showTypes filtering including connector-pruning-by-endpoint,
// idempotent re-run, and the freeform-only restriction) and
// check_insert_smart_stream_dialog (command wiring, Starting/Ending option scoping,
// checklist default-all-checked + Select All/Exclude All sync, and submit wiring
// through to insertSmartStream). Both confirmed to catch their own regression via a
// temporary revert. tests/README.md, public/instructions.html, and DESIGN_DOCUMENT.md
// updated. Full suite 90/90.
// 0.847: two follow-up requests on Insert Smart Stream. Reported directly: "when
// starting element is identified, show a sublist of those elements available for user
// to select - this is the part to start at. Also, show the derived connections; for
// example if business function is shown and then application capability, there is a
// derived connection through business process." (1) main.js's promptInsertSmartStream
// now renders a Starting Element Instances checklist (all-checked by default,
// re-rendered whenever the Starting Element type changes) listing that type's actual
// parts by label, so the trace can be seeded from specific instance(s) instead of
// every part of the type; insertSmartStream's options now take startPartIds (explicit
// part ids) instead of startType. (2) When one or more excluded-type parts sit between
// two surviving parts (any number of consecutive hidden hops, not just one), a genuine
// new Connector is now created linking the surviving endpoints directly -- a real,
// persisted connector (not a view-only decoration), reusing all existing rendering/
// export/inventory code with zero new render paths, per user confirmation on both
// design questions (real Connector vs. visual-only line; any-length vs. single-hop
// chains). Styled after the FIRST real hop's relationship (the existing "topmost
// parent" styling convention), with a note recording which hidden type(s) it passes
// through (e.g. "Derived -- implied via Business Process (not shown)"). Skipped when a
// real direct connector already covers the same pair; naturally idempotent on re-run,
// since a derived connector becomes a normal directly-discoverable edge the next time
// connsByPart is built. Three checks updated/added: check_insert_smart_stream_traversal
// (startType calls switched to startPartIds; new empty-selection-rejected case),
// check_insert_smart_stream_dialog (new Starting Element Instances checklist assertions
// -- lists real instances, re-renders per type switch, Select All/Exclude All sync, and
// genuinely narrows which parts seed the trace), and new
// check_insert_smart_stream_derived_connections (single hidden hop, a two-hop hidden
// chain collapsing into one edge, skipped when a real direct connector exists, and
// idempotent re-run). All three confirmed to catch their own regression via a temporary
// revert -- including one revert (dropping the "already exists" guard) that visibly
// broke all three at once, since it duplicated every direct real edge as a spurious
// derived one. tests/README.md and public/instructions.html updated. Full suite 91/91.
// 0.848: three more Insert Smart Stream refinements. Reported directly: "reduce the
// 'Element Types to Show' list to only show those currently existing in default model.
// Also confirm this can be called by script along with parameters, add an example...
// The 'Insert Smart Stream' form is long, can it be reorganized to be shorter, perhaps
// wider?" (1) Element Types to Show (main.js's promptInsertSmartStream) now reuses the
// same typesInUse list already computed for Starting/Ending Element, instead of the
// full 77-type settings.elements toolbox -- a type nothing exists for in the current
// model could never appear in a traced result anyway. (2) insertSmartStream is now a
// Script Console binding (bindingNames/bindingValues in promptScriptConsole, alongside
// remap/smartCheckView/smartCheckNode), documented in the console's own help text and
// in instructions.html; state.js's DEFAULT_BATCH_SCRIPT_CODE gained a new
// BatchScript_InsertSmartStreamExample() (not called by main() by default) showing a
// full call with the reported parameters (Connectors, Business Function seeded from a
// part labeled "Production", Both directions, ending at Data Entity, unlimited levels,
// seven element types shown) against the exact data BatchScript_QuickStart's "general"
// industry generates, so it's a genuinely runnable template, not a hypothetical one.
// (3) The dialog is now a new modal-box-wide CSS variant (620px, vs. the default
// 360px), reorganized into a 2-column grid for the single-line fields plus the
// Starting Element Instances and Element Types to Show checklists laid out side by
// side instead of stacked -- noticeably shorter overall. check_insert_smart_stream_
// dialog updated (exact scoped type list, modal-box-wide class) and
// check_script_console_remap_and_smart_check_bindings extended to also drive
// insertSmartStream through the real console with startPartIds/direction/showTypes.
// Both confirmed to catch their own regression via a temporary revert (three separate
// reverts: type-list scoping, the wide class, and the console binding, each caught by
// exactly the check meant to guard it). tests/README.md and public/instructions.html
// updated. Full suite 91/91.
// 0.849: Insert Smart Stream presets, plus wiring the example into the default script.
// Reported directly: "add the insertSmartStream example into the main() script after
// 3d view. Add ability to create and maintain a list of smartStream settings, called
// something like smartStreamPreset. Add load from or save to dialog either on page or
// another page/tab of the dialog. These should be saved local, not in the save json
// file. Save first smartStreamPreset named 'StreamSet1' with parameters used in
// example." (1) state.js's DEFAULT_BATCH_SCRIPT_CODE main() is now async and awaits
// BatchScript_QuickStart before calling BatchScript_InsertSmartStreamExample -- runs
// genuinely AFTER QuickStart's own 3D View step, not concurrently with it, since
// QuickStart must finish first. (2) New store.smartStreamPresets: an array of named
// {name, connectorType, startType, startInstanceLabels, direction, endType, levels,
// showTypes} presets, following the EXACT same Local Settings pattern batchScriptCode
// already established (a Store field living OUTSIDE this.doc, so store.toJSON() -- the
// actual Save JSON document -- never includes it; cached to localStorage via a new
// getCachedSmartStreamPresets/setCachedSmartStreamPresets pair; bundled into File >
// Save/Load Local Settings alongside pinnedFields/maxScriptEntities/nodeSizeMultiplier/
// batchScriptCode; auto-applied at bootstrapApp from its localStorage cache). Starting
// element is remembered by TYPE + part LABEL(s), not raw part id(s) -- ids only ever
// resolve within the document they were created in, while a label is far more likely
// to still resolve later against a regenerated or different document. Ships with one
// default preset, "StreamSet1" (DEFAULT_SMART_STREAM_PRESETS, state.js), mirroring
// BatchScript_InsertSmartStreamExample's own parameters exactly. (3) main.js's
// promptInsertSmartStream dialog gained a Preset row (top of the dialog, "on page" per
// the request's own either/or) with a dropdown + Load/Save As... buttons. Save As
// (via the existing generic promptModal, stacked on top of the still-open Insert Smart
// Stream dialog) captures every current field value -- including only the CHECKED
// Starting Element Instances, by label -- into a named preset, overwriting any existing
// preset of the same name; the dropdown immediately offers the new/updated name. Load
// repopulates every field, re-renders the Starting Element Instances checklist for the
// preset's own Starting Element type first, then checks exactly the remembered
// label(s) -- any label no longer matching a real part is simply left unchecked, with
// an error-styled toast naming what didn't resolve, rather than silently substituting
// something else. check_batch_script_quickstart extended to also verify
// BatchScript_InsertSmartStreamExample runs after QuickStart (ending with the Smart
// Stream Example tab active, not the 3D tab -- proof it genuinely ran afterward, not
// that main() stopped early). Two new checks: check_smart_stream_preset_local_
// persistence (default StreamSet1's exact shape, exclusion from store.toJSON(), and
// the full Local Settings file/localStorage/reload-survives story) and check_smart_
// stream_preset_dialog_save_and_load (Save As capturing current state correctly, Load
// repopulating every field including the instance checklist, and the missing-label
// graceful-degradation path). All three confirmed to catch their own regression via a
// temporary revert -- including one revert (main() no longer awaiting+chaining the
// second script) that failed three separate assertions in the same check at once.
// tests/README.md and public/instructions.html updated. Full suite 93/93.
// 0.850: Remap presets + layout controls. Reported directly: "let's add similar
// load/save settings for remap, with additional options for laying out the nodes.
// Specifically the ability to specify what goes on top of view, bottom, etc." then,
// on scope: "business actors on left, business functions on top, data entities on
// bottom, ordered by connector order/natural flow, allow for smart stream
// representation and connectors. Cleanly separate streams or clusters/groups with
// minimal connectors crossing" -- confirmed as two features, both in scope, both
// 'default'/'none' pattern only (force-directed and section-based views have no free
// row/column axis to bias). (1) Edge Assignment: applyRemapLayout's new
// `edgeAssignment: {elementType: 'top'|'bottom'|'left'|'right'}` option pulls every
// part of a given type out of the normal stream/element-group grid and places it
// instead in a single row/column band along that edge -- the existing grid logic runs
// completely unmodified on whatever's left (the "middle" set), then gets shifted right/
// down by one step to make room for a left/top band, then each band is placed off the
// middle grid's own resulting bounding box, ordered by the same sort-priority keys as
// everything else (so `connectionOrder` gives "natural flow" along an edge too). (2)
// Minimize connector crossings: a new `minimizeRowCrossings` helper runs a bounded,
// iterative barycenter heuristic (Sugiyama-style layered graph drawing, not an exact
// solver) over the middle grid, re-sorting each row by the average column position of
// its neighbors in the row above/below, alternating direction a few passes -- verified
// with a real crossing (two connected middle rows) that it eliminates, not just "some
// position changed". (3) store.remapPresets: named, reusable Remap dialog snapshots
// (templateName, pattern, sortKeys, the checkboxes, edgeAssignment, minimizeCrossings)
// -- exact same Local Settings pattern smartStreamPresets already established (a Store
// field outside this.doc, cached to localStorage via new getCachedRemapPresets/
// setCachedRemapPresets, bundled into File > Save/Load Local Settings, auto-applied at
// boot). Empty by default -- no seeded example this time, unlike StreamSet1. (4)
// promptRemap reorganized into the same modal-box-wide 2-column layout Insert Smart
// Stream uses (Preset row on top; Template/Pattern/checkboxes left, Sort priority
// right; a new Edge Assignment section below, scoped to element types actually placed
// on the current view) -- both new sections hide whenever Pattern is 'force', same as
// the sort-priority list already did. remap's Script Console binding and inline docs
// updated for the two new options. Two new checks:
// check_remap_edge_assignment_and_crossing_minimization (band placement + band
// ordering by sortKeys + genuine crossing reduction + force/sectioned silently
// ignoring both) and check_remap_preset_dialog_and_local_persistence (Save As/Load
// field-for-field, force-pattern hiding, exclusion from store.toJSON(), and the full
// Local Settings file/localStorage/reload-survives story); check_remap_options_
// persist_across_views extended for the new minimizeCrossings checkbox. All three
// confirmed to catch their own regression via a temporary revert (four separate
// reverts: edge-band placement, crossing minimization, preset Save As, and the
// existing options cache -- each caught by exactly the check meant to guard it).
// DESIGN_DOCUMENT.md (new SS6.1a), tests/README.md, and public/instructions.html
// updated. Full suite 95/95.
// 0.851: Remap's "Minimize connector length" checkbox. Reported directly: "for remap,
// in addition to checkbox 'minimize connector crossings' can you add 'minimize
// connector length' and move nodes to similar positions but closer." A second phase
// of the same Sugiyama layered-graph-drawing pipeline Minimize Crossings already
// implements: crossings is the *ordering* phase (which column a node lands in within
// its row); this new option is the *coordinate* phase (exactly where within that
// order), run afterward if both are checked. commands.js's new
// minimizeConnectorLengthPass keeps each row's left-to-right order completely fixed --
// only x shifts, toward the average x of a node's connected neighbors (any row, not
// just the one above/below) -- so connected chains straighten and pull closer together
// instead of sitting at fixed, evenly-spaced grid slots; a node with no neighbors, or
// already aligned with them, doesn't move at all. Each pass resolves a row two ways (a
// left-to-right minimum-spacing sweep, and the same in reverse) and averages them, so
// repeated passes don't just drift the block in whichever direction ran last -- plus a
// final cleanup sweep and a whole-block re-anchor to the original left edge. Same
// scope as Minimize Crossings: 'default'/'none' patterns only (force-directed and
// section-based views have no free row/column axis to bias, and hide the checkbox
// same as the other two). Wired through the full existing stack: applyRemapLayout's
// options, the Remap dialog (new checkbox next to Minimize Crossings, hidden under
// 'force'), remapPresets (new field, Save As/Load), the cross-view "last used"
// defaults cache, and the Script Console's remap() binding docs.
// check_remap_edge_assignment_and_layout_optimization (renamed from
// ..._and_crossing_minimization) extended with a clean, unambiguous fixture: a single
// unconstrained node (sole occupant of its row, so no same-row neighbor blocks it)
// whose only connection sits at the far side of a 3-node row below -- verified it
// slides to align with that connection (literal Euclidean distance reduction), while
// every other node's position stays byte-for-byte untouched.
// check_remap_preset_dialog_and_local_persistence and
// check_remap_options_persist_across_views both extended for the new checkbox. All
// three confirmed to catch their own regression via a temporary revert (three separate
// reverts: the algorithm pass itself, the dialog's Save-As capture, and the options
// cache -- each caught by exactly the check meant to guard it). DESIGN_DOCUMENT.md
// (SS6.1a retitled/expanded), tests/README.md, and public/instructions.html updated.
// Full suite 95/95.
// 0.852: a real bug fix plus three more Remap improvements. Reported directly: "Is it
// possible to retain the prior Remap settings on the same view if the user reopens it
// to adjust? Can right click be added to the remap submit button, to put into copy the
// function call and parameters that match what user has filled out... The 'minimize
// connector length' didn't result in the business function moving to the right,
// above (and shorter connector) the process... Please add to the main script a call
// to remap with these parameters."
// (1) BUG FIX: minimizeConnectorLength only ever aligned the middle grid -- an Edge
// Assignment band member (e.g. Business Function pinned to Top) stayed at its fixed,
// evenly-spaced band slot even when connected to an off-center middle-grid node,
// silently defeating the "shorter connector" promise for anything pinned to an edge.
// applyRemapLayout's Edge Assignment placement now runs a second alignment pass per
// band after the middle grid is finalized: same forward/backward-sweep-and-average
// math as minimizeConnectorLengthPass (extracted into two new shared helpers,
// resolveSpacedPositions and buildNeighborMap, used by all three passes now), but
// solving for the band's CROSS axis (x for top/bottom, y for left/right) against the
// middle grid's now-final positions -- the band's own order and minimum spacing stay
// fixed, only where along that order each member sits shifts. One-directional (bands
// align to the middle grid, never the reverse), so the middle grid is never perturbed.
// (2) view.remapLastOptions: every OTHER dialog field (pattern, both minimize
// checkboxes, edgeAssignment, template) now gets remembered PER VIEW too, not just
// sort order (view.remapSortKeys, pre-existing) -- recorded by remap() on every
// successful run, read by promptRemap ahead of the cross-view getCachedRemapOptions
// default, same "this view's own history wins" precedent remapSortKeys already set.
// Genuine per-view document state (round-trips through store.toJSON(), migrateDoc
// default added), deliberately the opposite of smartStreamPresets/remapPresets, which
// are Local Settings on purpose. (3) wireCopyCallOnRightClick (main.js): a small,
// deliberately generic helper -- right-clicking Remap's submit button copies a
// ready-to-paste remap(app, tab, {...}) Script Console call reflecting the form's
// CURRENT values to the clipboard, instead of opening the browser's own context menu,
// without actually submitting. Any other dialog's submit button could adopt the same
// helper the same way, per the user's own note ("This would be very handy for any
// dialog form with multiple settings") -- only Remap's uses it today. (4)
// BatchScript_RemapExample: a third starter script, appended to main()'s sequence
// after BatchScript_InsertSmartStreamExample, calling remap() on the same "Smart
// Stream Example" view with the exact parameters reported (Enterprise template,
// pattern default, both minimize checkboxes, a specific sort-priority order, Business
// Function/Data Entity/General Actor pinned to top/bottom/left) -- reuses the existing
// tab (not a redundant new one) when the active tab already shows that view.
// check_remap_edge_assignment_and_layout_optimization extended with a fixture
// reproducing the exact reported bug (a Business Function pinned to Top, connected
// only to the rightmost of three middle-grid Business Processes, now correctly slides
// to align with it). Two new checks: check_remap_view_remembers_own_settings (records
// on success, round-trips through the Save JSON document, pre-fills on reopen, doesn't
// leak to a fresh view) and check_remap_copy_call_on_right_click (copies a valid,
// current-values snippet; never actually submits). check_batch_script_quickstart
// extended for the third script (reused tab, correct edge placements, message log).
// All four confirmed to catch their own regression via a temporary revert. commands.js
// SS6.1a (DESIGN_DOCUMENT.md) expanded, tests/README.md and public/instructions.html
// updated. Full suite 97/97.
// 0.853: Remap's Minimize Crossings now also reorders Edge Assignment bands, not just
// the middle grid. Reported directly (against the shipped BatchScript_RemapExample's
// own output): "remap puts the last row of data entities as Bill of Materials, Demand
// Forecast, and Production Schedule. This results in connectors for Demand Forecast
// and Production Schedule crossing over. If Demand Forecast and Production Schedule
// positions are swapped, there is no cross over. Is this too complicated to do
// automatically, without hardcoding specific positions?" -- confirmed it's a natural
// extension of the crossing-minimization pass already built, not a hardcoding problem.
// applyRemapLayout's edge-band ordering (previously ALWAYS plain sortKeys) now runs a
// barycenter reordering (orderBand) against the middle grid's own FINAL positions
// whenever minimizeCrossings is checked -- a band member with no middle-grid
// connection at all has no preference and falls back to (and ties break by) the plain
// sortKeys position, never reordered relative to other such members. This resolves
// exactly the reported case: a Data Entity shared by two Capabilities now correctly
// lands BETWEEN the two Entities that connect to only one Capability each, instead of
// wherever alphabetical order happened to put it. Ordering runs before placement/
// spacing (unchanged) and before the existing Minimize Connector Length alignment
// pass, which now refines positions within whichever order this settled on -- the
// classic Sugiyama pipeline (layer assignment, then ordering, then coordinates) now
// applies fully to edge bands too, not just the middle grid. buildNeighborMap is built
// once per applyRemapLayout call and shared between ordering and the length-alignment
// pass (previously rebuilt separately). check_remap_edge_assignment_and_layout_
// optimization extended with a direct reproduction of the reported scenario (two
// Capabilities, one shared Entity plus two exclusive ones, entity labels chosen so
// alphabetical order crosses) -- confirmed to catch its own regression via a temporary
// revert. DESIGN_DOCUMENT.md SS6.1a, tests/README.md, and public/instructions.html
// updated. Full suite 97/97.
//
// 0.854: New Remap pattern, 'layered' -- rows come from directed connector-graph
// structure (hop-distance from a root) instead of stream/element-group membership.
// Reported directly, against the "Smart Stream Example" script's own output: "The
// cleanest result of drawing the script resulting data 'Smart Stream Example',
// turning off the requirement of general actor, would be (in a 4 x 4 grid): General
// Actor Manufacturing Operation Consumer; Business Function Production; empty;
// General Actor Production Planning. Row 2: Business Capability Manage Manufacturing
// Operations; Business Process Manufacturing Operation Process; Business Process
// Production Planning Process; Business Capability Manage Production Planning. Row
// 3: empty; Application Capability Manage Manufacturing Operations; Application
// Capability Manage Production Planning; empty. Row 4: Data Entity Bill of
// Materials; Data Entity Production Schedule; Data Entity Demand Forecast. Is there
// any algorithm or combination of options that could result in this layout?" --
// confirmed "yes" to building it. Verified the existing 'default' pattern genuinely
// can't produce this (BusinessFunction and BusinessProcess share custom.json's same
// "Business" elementGroup, so 'default' merges them into one row). New
// computeLayerAssignment (commands.js) computes each node's row via multi-source
// BFS -- a node's layer is the FEWEST hops any real connector justifies from a root
// (no incoming edges), NOT longest-path/topological-sort (Kahn's-algorithm)
// layering, which was the first approach tried. Real-data testing (a Playwright
// script running the actual shipped default batch script end to end, not just a
// hand-built fixture) showed WHY: the traced data has a genuine Capability ->
// Process edge, so longest-path layering obeys it as a hard constraint and pushes
// Process one row below Capability -- but Production also connects directly to
// Process, and each Consumer connects directly to its own Capability, both exactly
// 1 hop from a layer-0 root. Shortest-path layering lets each node settle at the
// row its NEAREST dependency justifies, correctly merging Capability and Process
// onto one row without hardcoding either type's position. Also naturally robust to
// the dual-connector convention's genuine 2-node cycles (e.g. Process <-> its own
// Application Capability, both directions real) -- once BFS visits a node at its
// shortest distance, a later, longer edge back into it is simply a no-op; no
// feedback-arc-set removal or DFS cycle-breaking pass is needed at all. (An earlier
// implementation DID use DFS-based back-edge removal plus longest-path Kahn's-
// algorithm layering specifically to handle these cycles, including a root-
// visitation-order heuristic to fix a real scrambled-layering bug it introduced --
// all of that was removed once testing against the real default-script data showed
// longest-path layering ITSELF, not cycle-handling, was the actual mismatch with
// the requested layout; the BFS replacement handles the same cycles for free, with
// far less code.) Column position within a row and Edge Assignment/Minimize
// Crossings/Minimize Connector Length are unchanged -- 'layered' only decides which
// row a node belongs on, then feeds the same downstream machinery every other
// pattern already shares. No column-wrapping (hidden in the dialog for this
// pattern -- every row is exactly one graph layer, however wide) and no passive-row
// special-casing (that's specific to 'default's stream/group semantics).
// BatchScript_RemapExample (state.js) now uses pattern:'layered' with NO
// edgeAssignment at all -- Business Function/Consumer parts land on row 0 as true
// graph roots for free, directly satisfying the original report's own "turning off
// the requirement of general actor" phrasing. New check_remap_layered_pattern
// (tests/run_all.py): a synthetic fixture proving the shortest-vs-longest-path
// distinction specifically (two roots, a middle node reachable from each root both
// directly AND via a longer path through the other root's own middle node -- the
// same edge shape as Capability/Process), a second fixture adding the reciprocal
// edge back (dual-connector cycle) to prove no hang/error, and a third proving Edge
// Assignment/Minimize Crossings/Minimize Connector Length all still work with
// pattern:'layered'. check_batch_script_quickstart updated for the new row
// structure (previously asserted Business Function/General Actor/Data Entity
// pinned to edge-assignment bands; now asserts the 4-row layered structure with
// Business Capability and Business Process correctly sharing one row).
// check_remap_preset_dialog_and_local_persistence extended: switching Pattern to
// 'layered' hides "Limit columns to view" only, leaving Edge Assignment/Minimize
// Crossings/Minimize Connector Length visible (unlike 'force', which hides all
// three). Every new/changed assertion proven against its own regression via a
// temporary revert (reinstating the old longest-path algorithm, and separately the
// old dialog-visibility logic) confirmed to fail with an informative message, then
// restored. DESIGN_DOCUMENT.md SS6.1b, tests/README.md, and public/instructions.html
// updated. Full suite 98/98.
//
// 0.855: Fixed minimizeRowCrossings (commands.js) getting stuck on a genuinely tied
// (not just suboptimal) ordering. Reported directly, after already trying every
// minimizeCrossings/minimizeConnectorLength on/off combination against the 'layered'
// pattern's own output: "did not produce desired result. Note turning both off
// results in connectors behind nodes, which would be very confusing for users.
// manually editing is not desired option due to volume of views this would need to be
// done to, repeated. (value of this tool is no manual editing needed...)" -- the
// reported layout wanted Business Function centered between its two Processes (not at
// one end of its row) and Business Capability/Business Process interleaved (not
// grouped apart). Hand-computed crossing counts on the actual reported data confirmed
// BOTH the algorithm's actual output AND the requested layout were genuinely tied at
// ZERO row-to-row crossings -- the old algorithm (one downward-first barycenter sweep
// + a single trailing transpose pass, scored only by raw crossing count) had no way
// to prefer between them. Root-caused and fixed in three parts, each confirmed
// necessary by testing against the real reported topology (NOT just a hand-built
// synthetic fixture -- a smaller synthetic 2-/3-row case tried first did not
// reproduce the bug; it only shows up once a row is pulled from both above AND below
// simultaneously, same as the real Capability/Process row sitting between Actor/
// Function above and Application Capability below): (1) the full barycenter+
// transpose search now runs from TWO starting points (downward-first and
// upward-first) and keeps whichever converges better -- a single starting direction
// can get stuck in a local optimum only reachable from the other; (2) the transpose
// step's per-swap decision now ALSO weighs total edge LENGTH (inter-row AND, newly,
// intra-row -- a same-row-connected pair, routine for pattern:'layered') as a
// secondary criterion once crossings are tied, swapping a crossing-neutral adjacent
// pair when it strictly shortens their own edges; (3) the overall best-of-all-
// iterations result is now tracked by that same (crossings, then length) comparison,
// not crossings alone. Part (2) turned out to be the one that actually mattered for
// the real data -- two starting points alone still wasn't enough, since without a
// length-aware transpose the search could still land in (and never locally escape) a
// crossing-tied "grouped" ordering. New check_remap_crossing_minimization_finds_
// global_optimum (tests/run_all.py): hand-builds the exact real "Smart Stream
// Example" topology directly via createPart/createConnector (fast, no
// generateIndustry/insertSmartStream dependency) with BatchScript_RemapExample's own
// sortKeys, and asserts Business Function centered + Business Capability/Process
// interleaved. Proven against TWO prior buggy states via temporary revert: the
// fully-original single-start algorithm, and the intermediate two-start-plus-global-
// length-only version (part 1+3 without part 2) -- both fail with an informative
// message; the final fix passes. DESIGN_DOCUMENT.md SS6.1a and tests/README.md
// updated. Full suite 99/99.
//
// 0.856: New "Data Modeling" feature (crow's-foot ERD): entity attributes, primary/
// foreign keys, crow's-foot relationship notation, and DDL import/export, layered on
// top of the existing DataDataEntity element rather than changing what it already
// means in Streams/Capability Maps. Reported directly: "I'd like to add data
// modeling capabilities that support crows foot notation, entity attributes,
// foreign keys, primary keys, data types etc. One new menu item after explore
// called 'Data Modeling'. To include import and export of standard formats. This
// will be a new connector type 'd'." -- design worked out collaboratively (a
// DataDataEntity stays unchanged; ERD detail lives on a Level Down child of a new
// element type; "just ddl" for import/export; explicit cardinality "may need to
// revisit at a later step"; isForeignKey derived from connectors, not stored).
// New new element type: DataEntityDetails (public/custom.json, "Data" group),
// carrying the new Part.attributes field (array of {id, name, dataType, nullable,
// isPrimaryKey}). New connectorType 'd' wired through every branch point that
// mattered (unlike a new element type, connectorType values are load-bearing string
// literals scattered across several files, not schema-only): main.js's
// CONNECTOR_TYPE_ITEMS toolbar filter and Insert Smart Stream's connector-type
// select, canvas.js's new chkShowDataType view-level visibility toggle (its own
// showFields entry, sibling to chkShowConnectorType/chkShowStreamType) and its
// crow's-foot marker rendering. A 'd' connector stores fromAttribute/toAttribute
// (attribute IDs, stable across a rename) and fromCardinality/toCardinality
// (explicit, one of one/many/zeroOrOne/oneOrMany).
// A real, general Level Down gap found and fixed while designing this: vm.
// linkedViewName (the existing double-click "already decomposed" guard) lives on
// the ViewMember, not the Part -- the SAME Part shown as two different ViewMembers
// (ordinary: e.g. one DataDataEntity on two different Stream views) got TWO
// independent, orphaned decompositions instead of the second reusing the first's.
// Fixed via new findCompositionChildConn/findCompositionChildView (commands.js, the
// mirror of the existing findCompositionParentConn) -- checked before falling
// through to levelDownSingle, in both the double-click path (openOrCreateLinkedView)
// and the new menu-triggered "Add/Edit Entity Details" (promptAddEditEntityDetails).
// New 'a' showFields widget (render.js's renderShowFieldsPanel/
// renderAttributeListField) -- the first field type that isn't a scalar value: an
// inline editable table (add/edit/delete rows) for Part.attributes. isForeignKey is
// deliberately NOT stored on the attribute -- computed live (some 'd' connector's
// fromAttribute references this attribute's id) and shown as a read-only badge, so
// it can never drift out of sync with the connectors that are the real source of
// truth (same principle Composition/mirrorOf already follow elsewhere in this
// codebase). New "options depend on another field's value" case in render.js's
// selectOptionsFor -- the 'd' connector's From/To Attribute selects list only
// whichever table is on THAT end's own attributes (ctx.fromPartId/toPartId, new
// alongside the existing ctx.fromType/toType).
// Crow's-foot rendering (canvas.js's drawEdge, new CARDINALITY_LINE_ENDS) reuses the
// existing lineEnds/marker-def machinery (four new lineEnds entries -- crowOne/
// crowMany/crowZeroOrOne/crowOneOrMany -- are plain SVG path data, same as every
// existing arrow/diamond marker) rather than inventing a parallel rendering path,
// falling back to the normal relationship-driven marker when no cardinality is set
// yet. A real bug found and fixed during development: crowZeroOrOne's circle was
// originally centered at a negative Y that fell outside the shared marker viewBox
// (buildMarkerDefs' hardcoded "-12 -2 24 24", Y range -2..22) -- silently clipping
// almost the entire circle down to an unrecognizable sliver, invisible to any check
// of the marker's DOM attributes (fill/stroke/path were all "correct"; only the
// actual rendered geometry was wrong) -- confirmed visually via a zoomed screenshot,
// then fixed by repositioning the circle into positive-Y space.
// New "Data Modeling" top-level menu (index.html/main.js), positioned after Explore:
// Add/Edit Entity Details (the menu-triggered equivalent of double-clicking a
// DataDataEntity node, requiring exactly one selected), Import DDL... (file picker,
// same wiring pattern as ArchiMate import), Export DDL (shown via the existing
// promptTextEdit readonly viewer, same one Code Summary uses). New js/ddl.js module
// (pure logic, no DOM, alongside sfce.js/archimate.js): parseDDL/generateDDL, a
// deliberately SCOPED CREATE TABLE subset (column definitions, inline/table-level
// PRIMARY KEY, table-level FOREIGN KEY ... REFERENCES) -- not a general SQL grammar,
// hand-written string scanning since no npm packages are allowed in this project.
// Anything outside the subset throws with a specific message naming the exact
// table/entry that failed, not a silent drop; Import DDL creates all-or-nothing (if
// parseDDL throws, nothing is created). Export DDL is scoped to the CURRENT view's
// own DataEntityDetails parts + 'd' connectors only (matching Insert Smart Stream's
// own per-view scoping), not the whole model.
// New permanent regression tests, each proven against its own reverted regression:
// check_level_down_reuses_existing_decomposition_across_viewmembers (the Part-level
// guard, isolated from the older label-matching fallback by renaming the first
// decomposition's view); check_data_modeling_attributes_and_data_connector
// (attribute add/edit/delete via the real 'a' widget, derived-not-stored
// isForeignKey, From/To Attribute dropdown scoping, Save/Load JSON round-trip);
// check_data_modeling_crowfoot_rendering (four distinct markers, graceful fallback
// when unconfigured, the exact circle-clipping bug reproduced by parsing the
// shipped path data, the chkShowDataType toggle); check_data_modeling_menu_and_ddl_
// import_export (the real menu + file-input UI end to end, specific error toasts
// for malformed DDL/empty exports/missing selections, decomposition reuse proven via
// the menu entry point specifically). check_view3d_connector_type_toolbar_filter
// updated for the new 'd' toolbar item (its exact-array assertion was stale, not a
// real regression). DESIGN_DOCUMENT.md SS7a, tests/README.md, and
// public/instructions.html updated. Full suite 103/103.
//
// 0.857: Fixed three real gaps in Data Modeling, reported directly right after it
// shipped: "attributes on dataentitydetail are not appearing visually on node.
// unable to enable FK. unable to create crows foot connector with another
// dataentitydetail, or at datadataentity level." All three traced back to the same
// root cause: 0.856 built the data model, rendering, and DDL import for 'd'
// connectors, but never the manual, canvas-driven path a person actually uses day
// to day. (1) buildNodeEl (canvas.js) never rendered Part.attributes at all -- only
// the property panel did. Fixed: each attribute now renders as "name : dataType"
// (with a PK key emoji and a live FK marker, using a shared isAttributeForeignKey
// helper factored out of render.js's renderAttributeListField so canvas and panel
// can never disagree) directly on DataEntityDetails nodes, gated by a new
// chkShowAttributes view toggle (sibling to chkShowDescription/chkShowKeys). Node
// size is uniform per VIEW not per node, so this relies on redrawNodeSizes' own
// existing content-measuring pass (which already calls buildNodeEl to measure) to
// grow the view's shared node size to fit attribute lists, rather than building a
// new per-node sizing mechanism. (2) Drag-to-connect (main.js's beginConnect/
// finishConnect) hardcoded connectorType:'c' unconditionally -- there was no
// toolbar toggle, modifier key, or dialog anywhere in that path offering 'd', so a
// crow's-foot connector could only ever come from DDL import, never from drawing
// one by hand. Fixed by inferring connectorType:'d' automatically when BOTH drag
// endpoints are DataEntityDetails (the same "infer by type context, no picker
// needed" pattern the stream companion-connector logic already uses for 's'/'c'),
// while every other type pairing -- including DataDataEntity -> DataDataEntity,
// the "or at datadataentity level" half of the report -- still gets a plain 'c'
// connector as before. (3) connectorType had NO edit surface anywhere: its own
// showFields entry was access:'r' (readonly text), and neither the edge popover
// (relationship-only) nor any context menu exposed a way to change it -- so even an
// EXISTING connector's type could never be corrected manually. This was the actual
// root cause of "unable to enable FK": FK is derived from a 'd' connector's
// fromAttribute, and there was no way to ever get a 'd' connector to exist except
// the one now-auto-inferred drag case. Fixed generally, not just for the inferred
// case: connectorType is now a genuine 's' (select) field with real c/s/d options,
// editable exactly like relationship already was -- so any connector's type,
// however it was created, can always be changed afterward as a manual escape
// hatch, not just the one auto-inferred pairing.
// New check_data_modeling_node_attributes_and_manual_connector_creation
// (tests/run_all.py) covers all three together, proven against three separate
// reverted regressions (each confirmed to fail with an informative message, then
// restored): the node's own rendered innerText includes its attributes with live
// PK/FK markers; dragging DataEntityDetails->DataEntityDetails infers 'd' while
// DataDataEntity->DataDataEntity stays 'c'; the connectorType select is genuinely
// enabled with the right options and a value change actually persists.
// DESIGN_DOCUMENT.md SS7a and tests/README.md updated;
// public/instructions.html's Data Modeling section rewritten to describe the new
// drag-to-create flow and the Attributes view toggle instead of the old "set
// Connector Type manually" instructions. Full suite 104/104.
//
// 0.858: Six fixes reported together in one follow-up round on Data Modeling: "when
// keying in data entity details attributes, tab should take user to next field. for
// example from name to type. need ability to move attribute up or down. type should
// be drop down list of acceptable types (numeric, string, boolean, date, blob, json).
// unable to enable pk in property panel attribute section for dataentitydetail. when
// connector dragged/created, auto create a fk in target of primary key from source,
// if it doesn't exist. This is reverse of current logic which flagged the parent as
// having fk. Auto populate From Cardinality as One, and To Cardinality as Many.
// Connectors are created from parent to children. problem: double click on
// datadataentity or menu data Modeling -> add edit entity details creates a new
// datadataentity, should be a dataentitydetail element for the details."
// (1) levelDownSingle (commands.js) unconditionally copied the decomposed Part's own
// type onto its new decomposition child -- correct for every other element type, but
// wrong for DataDataEntity specifically. Fixed with a special case: decomposing a
// DataDataEntity now creates a DataEntityDetails child instead. Both entry points
// (double-click's openOrCreateLinkedView and the "Add/Edit Entity Details" menu
// command) funnel through this same function, so both are fixed together, and the
// existing Part-level decomposition-reuse guard means invoking either entry point a
// second time reuses the same child rather than creating another one.
// (2) The attribute table's Data Type cell was a free-text input. Now a <select>
// with fixed options (numeric/string/boolean/date/blob/json) -- always injecting the
// attribute's current value as an extra selected option when it isn't one of those,
// so a DDL-imported concrete SQL type (e.g. "VARCHAR(100)") isn't silently clobbered.
// (3) Tab-key navigation lost focus to <body> entirely when leaving the Name field --
// and this was ALSO the actual root cause of "unable to enable pk": a keyboard-driven
// person could never tab their way to the PK checkbox at all. Root cause: committing
// any attribute field's edit calls app.recordAndRender(), which rebuilds the whole
// property panel's DOM; the native browser tab-order target (resolved against the OLD
// DOM before the rebuild) no longer existed by the time focus would land. Fixed with
// explicit keydown handlers on Name/Data Type/Nullable/PK that preventDefault, commit
// the field deterministically themselves (not relying on native blur/change timing),
// then explicitly re-locate and focus the correct next field (name -> data type ->
// nullable -> PK -> next row's name, or the Add Attribute button after the last row)
// in whatever DOM exists afterward.
// (4) Added per-row up/down move buttons to the attribute table, swapping the
// attribute's position in the array and re-rendering, matching the existing delete
// button's wiring pattern.
// (5) A manually drag-created 'd' connector now auto-creates a matching FK attribute
// on the target when the source (the drag's "from"/parent side, per "Connectors are
// created from parent to children") has a primary key and no matching FK already
// exists on the target -- named `<parent_label_snake>_<pk_name_snake>` via a new
// toSnakeCase helper, reusing an existing same-named attribute instead of duplicating
// it if one's already there -- and sets fromCardinality:'one'/toCardinality:'many' on
// the connector. This is deliberately the REVERSE of importDDL's own convention
// (fromCardinality:'many', toCardinality:'one'), which is correct there because DDL's
// own FOREIGN KEY clause is declared on the child/referencing table, making that side
// "from" -- two intentionally different conventions for two different creation paths,
// not reconciled between them.
// New check_data_modeling_attribute_editing_and_auto_fk (tests/run_all.py) covers all
// six together, each proven against its own reverted regression (confirmed to fail
// with an informative message, then restored): decomposition child type via both
// entry points with reuse; the Data Type select's fixed options plus preserved
// unlisted value; real keyboard-driven Tab navigation through all four fields
// (name->type->nullable->PK) landing on the right element each time, with PK actually
// toggled via keyboard at the end; row reordering; and the auto-created FK attribute
// plus its One/Many cardinality on a drag-created connector.
// DESIGN_DOCUMENT.md SS7a and tests/README.md updated; public/instructions.html's
// Data Modeling section updated for Tab navigation, the Data Type dropdown, row
// reordering, and auto-FK-on-drag. Full suite 105/105.
//
// 0.859: New Data Modeling menu command, reported directly: "add a new command to
// menu 'Data Modeling' called autofill, which will call a script called dataAutoFill.
// This script (store/save/edit same as BatchScript_QuickStart approach) will loop
// through dataentitydetail nodes on current view, and if attributes have not been
// created yet (don't override existing) it will create an attribute using the label +
// 'Id', of type numeric, flag as primary key. Also create an attribute called label +
// 'Name', of type string, and null enabled. Also create an attribute called label +
// 'Description', of type string, and null enabled. Next loop through data connectors.
// If the 'from' attribute have not been set: set From to the pk of the from
// node/part. set To to the same field name in to node/part after creating it
// (numeric null fk), set cardinality as from: one and to: one or many. Connectors are
// created from parent to children."
// Implemented as a NEW kind of command for this menu: rather than a fixed function in
// commands.js, dataAutoFill() is a named function living inside the same
// user-editable batch script as BatchScript_QuickStart (DEFAULT_BATCH_SCRIPT_CODE,
// state.js) -- same storage (store.batchScriptCode), same editor (Advanced > Script
// Console), same Local Settings persistence. It's deliberately NOT called from
// main() (which would break it on a fresh document with no Data Entity Details
// tables yet); instead the new Data Modeling > Autofill menu item (App.
// promptAutofill, main.js) compiles store.batchScriptCode with the exact same
// bindings promptScriptConsole's own Run button uses, but extracts and calls
// dataAutoFill specifically -- so editing dataAutoFill() in the Script Console
// genuinely changes what the menu item does.
// Pass 1 scaffolds three attributes (<label>Id numeric/not-null/PK, <label>Name and
// <label>Description both string/nullable) onto any Data Entity Details table on the
// current view that has ZERO attributes so far -- a table with even one existing
// attribute is left completely untouched, not merged with or topped up. Pass 2 wires
// up any 'd' connector on the view whose From Attribute isn't set yet: From becomes
// the source table's own primary key, To becomes a same-named attribute on the
// target table (reusing a case-insensitive match instead of duplicating it),
// cardinality defaults to One (from) / One or Many (to) -- deliberately a third
// naming/cardinality convention alongside the manual-drag one (finishConnect,
// snake-cased name, one/many) and importDDL's (many/one), each correct for its own
// creation path, not reconciled between them. newId()/ciEq() aren't in the Script
// Console's binding set (a `new Function(...)` body doesn't share the module's
// lexical closure), so dataAutoFill() uses the true global crypto.randomUUID()
// directly instead.
// New check_data_modeling_autofill (tests/run_all.py) covers: the menu item existing;
// a specific error toast when there's no active canvas tab; correct scaffolding on an
// empty table; an already-detailed table left untouched (proven via reverting the
// guard and confirming that specific assertion fails); correct connector wiring on an
// unset connector; an already-wired connector left untouched (same revert-and-confirm
// proof); and dataAutoFill() staying out of main()'s own call chain. DESIGN_DOCUMENT.md
// SS7a, tests/README.md, and public/instructions.html (both the new Data Modeling >
// Autofill subsection and a note in the Script Console section) updated. Full suite
// 106/106.
//
// 0.860: Two issues reported directly after using the Autofill/Level Down/Level Up
// Data Modeling features:
// (1) "foreign key flag still not appearing anywhere, field is created in autofill
// script when parent connected to child but not flagged as foreign key... Tried
// manually creating isForeignKey: true, didn't work still not showing. Field name
// related to ForeignKey not showing in saved data, what is it called and is it the
// same format as primary key like isForeignKey : true?" There is no isForeignKey
// field anywhere in the data model (confirmed: setting one by hand does nothing,
// since nothing reads it) -- FK status is fully derived. Root cause of it not
// showing: isAttributeForeignKey (render.js) hardcoded "the attribute referenced by
// a 'd' connector's fromAttribute is the FK" -- correct only for DDL import's own
// convention (fromAttribute = child's FK column, toAttribute = parent's referenced
// column); the LATER Autofill/drag-to-connect convention (0.859/0.858) deliberately
// stores it the opposite way (fromAttribute = source's own PK, toAttribute = the
// newly-created FK), so nothing either of those two paths ever created showed the
// badge. Fixed convention-agnostically: checks BOTH ends of the fromAttribute/
// toAttribute pair, and whichever end references an attribute actually flagged
// isPrimaryKey marks the OTHER end as the real foreign key -- correct for all three
// creation conventions regardless of which literal field each one stores which role
// in. check_data_modeling_autofill extended to confirm the FK badge genuinely
// appears (property panel AND canvas node) on the attribute Autofill creates,
// proven against the reverted bug. Two PRE-EXISTING tests (check_data_modeling_
// attributes_and_data_connector, check_data_modeling_node_attributes_and_manual_
// connector_creation) had artificial fromAttribute-only test setups that the new,
// more correct derivation logic no longer satisfies (neither end was a real PK in
// their scenarios) -- updated both to also set a matching toAttribute pointing at a
// genuine PK, modeling a realistic FK->PK reference instead (not a regression --
// same category of expected test-assumption update as check_view3d_connector_type_
// toolbar_filter's own update earlier this project).
// (2) Enhancement: "when a single dataentitydetail is selected and user selects
// 'level-up' command, create (if doesn't already exist, otherwise just open) a new
// datadataentity part/node of the same label name with link/connector result as
// when done in reverse where user selected datadataentity and did level-down." New
// levelUpEntityDetails (commands.js), dispatched from runCommand's existing
// 'levelUp' branch (main.js) only when exactly one DataEntityDetails ViewMember is
// selected -- every other selection keeps the ordinary "prompt for a new view name"
// Level Up unchanged. Checks for an existing parent via findCompositionParentConn
// (the reverse walk of levelDownSingle's own reuse guard) and just opens/selects it
// if found; otherwise creates a new DataDataEntity part with the same label, a
// fresh dedicated view (same dedup-suffix naming as levelDownSingle), and the
// identical link shape levelDownSingle produces in reverse -- an unplaced
// Composition connector plus the new parent's own linkedViewName pointing back down
// at the current Entity Details view, so double-clicking the new parent navigates
// straight back. The command palette's own Level Up hint text now reflects which
// behavior will run while a single DataEntityDetails node is selected.
// New check_level_up_creates_data_data_entity covers: first Level Up creates exactly
// one new part + Composition connector + correct linkedViewName and switches to a
// view named after the label; double-clicking the new parent navigates back;
// a SECOND Level Up reuses the existing parent instead of duplicating (proven via
// forcing findCompositionParentConn's result to null and confirming failure, then
// reverting); and an unrelated selection still gets the ordinary Level Up dialog
// (proven by disabling the special case and confirming the whole check throws).
// DESIGN_DOCUMENT.md SS7a, tests/README.md, and public/instructions.html (Level Up's
// own row, the new Data Modeling reverse-direction paragraph, and the FK badge
// description) updated. Full suite 107/107.
//
// 0.861: New element type, reported directly: "please confirm that a togaf element
// 'business organization unit' or 'organization unit' is missing" -- confirmed: zero
// matches for "org"/"unit" anywhere across all 78 existing element types, in any
// group. Not a core ArchiMate 3.x notation element either (the closest existing
// concepts are Business Actor and Grouping) -- it's a TOGAF Content Metamodel entity.
// Follow-up: "add it as a new element type, with oval icon (similar to requirement
// but looks different), same group (and coloring, relations, etc.) as togaf business
// actor. When we import or generate involving sections, these will now be business
// organization units (aka orgunit); meaning when loading SFCCE for example, now
// generate a orgunit part."
// New BusinessOrganizationUnit element (public/custom.json): Business group (fill
// color matches Business Actor automatically, since coloring is purely by group
// membership, not per-type), sources:'t' (TOGAF-only, not "at" -- honestly reflects
// that this isn't a core ArchiMate concept), a taller oval-with-divider icon path
// distinct from Requirement's own plain oval. relationshipPairs: every relationships.xml
// entry naming BusinessActor (source and target, 125 pairs including a self-pair) was
// mechanically mirrored with BusinessOrganizationUnit substituted, preserving the exact
// same relation letters/computed defaults BusinessActor itself gets for those same
// pairs -- relationships.xml (the official ArchiMate 3.2 spec matrix) itself was left
// untouched, since hand-fabricating entries there for a non-standard concept would
// misrepresent invented data as the official spec. Also added to the "All"
// streamTemplate's value[] (kept in 1:1 correspondence with every element type, same
// requirement as every other element addition this project has made).
// Generation behavior: createStream/generateIndustry now reifies each stream's own
// section as an actual BusinessOrganizationUnit part instead of only tagging
// Part.section as a string -- one OrgUnit per unique section VALUE per model, reused
// (never duplicated) across every function sharing it, Assignment-connected to the
// function it's responsible for, placed on the view, idempotent across re-runs. The
// capture had to run in BOTH createStream's main value[] loop AND its passive-node
// loop, since every currently-shipped template (Enterprise, SFCCE, Enterprise Full,
// Test) puts BusinessFunction only in template.passive[], never the main chain -- the
// main-loop capture is correct but currently-dead code, kept for template shapes that
// might do it differently. A new plainConnsByFromTo map was added to
// createBulkLookupCache (mirroring connsByFromToModel's own pattern, for connectorType
// 'c' instead of 's') so the Assignment-connector dedup check stays O(1) per job, not
// reintroducing the O(n^2) risk this cache exists to avoid. Only ever triggers via
// generateIndustry (Load SFCCE's data, or any future industryData with real sections --
// the built-in "general" dataset has none, so unaffected); the plain manual Generate
// Stream dialog never passes a section at all, so it's completely unaffected too.
// New check_business_organization_unit_element_and_generation (tests/run_all.py)
// covers the element definition itself, relationshipPairs in both directions plus the
// self-pair, and the generation behavior end to end -- proven via three separate
// reverted regressions (the whole wiring block, the passive-loop capture specifically
// since that's the actually-exercised path, and the reuse/dedup lookup), each
// confirmed to fail with an informative message, then restored. Existing
// check_generate_industry_propagates_section_to_whole_chain's part count changed
// (11 -> 12) as an expected, verified side effect of the new OrgUnit part+connector,
// not a regression. DESIGN_DOCUMENT.md SS7.3 (new), tests/README.md, and
// public/instructions.html's Generate Industry row updated. Full suite 108/108.
//
// 0.862: New Load SFCCE mapping fields, reported directly: "Add to Load SFCCE
// mapping, into the appropriate fields: Section Description, Section Id, Function
// Description, Function Id, Capability Id, Application Capability Id, Entity Id."
// Before this, the wizard only supported a Description for Capability/Application
// Capability/Entity (never Section or Function) and no explicit Id at any level --
// every node's id was always an auto-derived chained-slugify of names, and Section
// (a plain string tag on each Function node, not a tree node of its own) had nowhere
// to carry an id/description at all.
// buildRowsFromRecords/buildIndustryTree (js/sfce.js) extended: every level now
// supports an optional mapped Id, which overrides that node's auto-derived one
// (surfacing immediately as xIds-based find-or-reuse once generateIndustry creates
// the Part -- it already threads func.nodeId/cap.nodeId/appCap.nodeId/ent.nodeId
// through as functionxIds/capabilityxIds/applicationCapabilityxIds/entityxIds, no
// changes needed there); Ids deliberately do NOT cascade the way names do (an
// unmapped level just falls back to auto-derivation, never inheriting a DIFFERENT
// level's id, which would wrongly conflate two distinct identities). Function now
// also supports a mapped Description (previously always blank regardless of any
// mapping). Section's mapped Id/Description ride along on the Function node(s)
// under it as new nodeSectionId/nodeSectionDescription fields, surfaced in the SFCE
// Catalog page (flattenIndustryTree's makeRow) as new sectionId/sectionDescription
// columns for parity with every other level.
// The wizard (main.js's promptSFCCEMapping) gained 7 new <select> mapping rows.
// Found and fixed a real suggestion-heuristic bug while building this: Capability
// Id/Application Capability Id's auto-suggestion used a bare 'id' keyword, which
// matched an unrelated SHALLOWER field (e.g. a top-level "domainId") ahead of the
// real, deeper "capabilities.capId" -- the existing shallow-vs-deepest depth
// tiebreak (already used for Capability vs Application Capability name/description)
// only disambiguates WITHIN the right group of fields, not across unrelated ones.
// Fixed by first filtering candidates to fields whose own dotted path contains a
// "capab" substring before ranking by depth. Other new fields' suggestion keywords
// needed camelCase-joined variants too (e.g. "sectiondescription" alongside "section
// description") since a dotted-path field name has no word-boundary separator.
// New check_load_sfcce_id_and_description_mapping (tests/run_all.py) covers all 7
// new fields end to end through the real wizard DOM, each of the 5 distinct wiring
// points (function id/description override, section id/description attachment,
// capability/entity id override, unmapped-application-capability still cascading
// its name while auto-deriving its id from the capability's) proven via its own
// reverted regression, plus the suggestion-heuristic fix itself. DESIGN_DOCUMENT.md
// SS7.1, tests/README.md, and public/instructions.html's Generate Industry row
// updated. Also created public/capabilities-general-SFCCE.json (a new raw-input
// JSON reshaping the built-in "general" dataset with Section values derived from
// custom.json's "Enterprise Functions" template + "org"-viewType sections, and
// Application Capability values cascaded from each Business Capability's own name,
// matching Load SFCCE's own inherit-from-the-level-above convention) -- not yet
// wired into the boot-time load path; that replacement is a deliberately separate,
// not-yet-built next step. Full suite 109/109.
//
// 0.863: Follow-up UX round on the Load SFCCE mapping dialog, reported directly:
// "Load SFCCE dialog: make shorter, perhaps 2 columns or reduced spacing. add
// '(none)' as an option so nothing is added. add '(generate unique' to generate a
// unique id. Update submit button to show script call with parameters, as done with
// other form submit buttons. Update SFCE catalog display and properties for all new
// fields."
// (1) Compact layout: the 16 stacked .prop-rows collapse to 6 -- a new
// .sfcce-mapping-row CSS grid lays out each level's Field/Description/Id selects
// side by side (Section/Function/Capability/Application Capability/Entity, one row
// each, plus a header row), each still carrying .prop-row for its select/input
// styling (a .modal-box .sfcce-mapping-row override was needed since .modal-box
// .prop-row's own margin-bottom rule has higher specificity than a bare single
// class).
// (2) "(none)" wording: the original single fieldOptionsWithNone's "(none — inherit
// from the level above)" was only accurate for the 3 genuinely-cascading NAME
// fields -- reused verbatim for the new Description/Id fields, it was actively
// misleading (neither cascades). Now three distinct builders: fieldOptionsCascade
// (unchanged, NAME fields only), fieldOptionsDescription (a plain "(none)"),
// fieldOptionsId (blank = auto-derive from name, distinct from the new option
// below).
// (3) "(generate unique)": a new GENERATE_UNIQUE_ID sentinel (js/sfce.js, exported)
// selectable in any Id dropdown -- mints a genuinely random id (crypto.randomUUID(),
// resolveMappedId) instead of reading a file field or falling back to the
// deterministic slugified-name chain. Resolved once per RESULTING ROW (moved inside
// buildRowsFromRecords' per-section loop, not once per input record), since a
// Section field that splits one record into several rows produces that many
// genuinely distinct nodes once sections diverge, each needing its own fresh id.
// (4) Submit button script call: wired the SAME wireCopyCallOnRightClick mechanism
// Remap's own submit button already uses onto Load SFCCE's Load button -- right-click
// copies a buildRowsFromRecords(records, {...}) call reflecting the live form,
// via a new collectSfcceMapping() helper shared between the submit handler and the
// snippet builder (same pattern collectRemapOptions already established).
// (5) Catalog + properties: the mapped Section Id/Description now actually reach
// the generated BusinessOrganizationUnit Part's own xIds/description fields
// (createStream gained sectionId/sectionDescription params, threaded from
// generateIndustry's func.nodeSectionId/nodeSectionDescription -- previously the
// OrgUnit was always created with neither set). The SFCE Catalog's own tab.tableCols
// (openOrSwitchSfceCatalog, main.js) gained matching sectionId/sectionDescription
// columns, which flattenIndustryTree's makeRow already produces.
// New check_load_sfcce_dialog_ux_and_generate_unique_id (tests/run_all.py) covers
// all 6 mechanisms above, each proven via its own reverted regression (including a
// precise UUID-regex check for "(generate unique)", not just a length/shape guess,
// since a UUID and the deterministic fallback chain can both be long strings for a
// given fixture). Required updating the PRE-EXISTING check_sfce_catalog_page's
// exact-column-list assertion for the two new columns -- an expected, documented
// side effect, not a regression. DESIGN_DOCUMENT.md SS7.1, tests/README.md, and
// public/instructions.html's Generate Industry row updated. Full suite 110/110.
//
// v0.864: fixed a real bug reported directly: "connectors not showing when types
// filtered; on a view when using Filter Types, connectors should continue to be
// displayed unless unselected in view properties." renderCanvasPage (canvas.js) forced
// connVms = [] whenever tab.connectorLevels was 0 (the default) and any Stream/Type/
// Section filter was active -- even for a connector directly between two parts that
// BOTH individually passed the filter -- contradicting instructions.html's own
// documented meaning of "Connector levels" (how many extra hops of NODES to pull in
// beyond direct matches, not whether an already-matching connector draws at all).
// Fixed by always passing the full allConnVmsInView through to redrawEdges, which
// already does the correct per-connector check on its own (stream filter,
// chkShowConnectorType/chkShowStreamType/chkShowDataType view properties, and both-
// endpoints-present); connectorLevels now purely controls the BFS node-expansion
// radius (expandVisiblePartVmIdsByLevel), never connector visibility directly. New
// check_types_filter_keeps_connectors_visible (tests/run_all.py), proven via a
// deliberate revert-then-restore against the exact reported scenario. DESIGN_DOCUMENT.md
// SS9's Stage-5-series log and tests/README.md updated. Full suite 111/111.
//
// v0.865: reported directly: "Now load the capabilities-general-SFCCE.json file
// automatically, replacing the load and all logic for loading fce-generalnodes.json.
// Change logic so only one Industry will be available, if user does a 'Load SFCCE' it
// clears and replaces any existing industry SFCCE data (warn user first if data has
// already been created). Can now remove any dialogs or parameters for industry (SFCCE
// dataset), there will be only the one. It needs to be saved in the json file when user
// selects save, and loaded if they load later." A large refactor collapsing the whole
// industry-data subsystem onto ONE dataset:
// - data.js now fetches public/capabilities-general-SFCCE.json (a raw, loosely-nested
//   JSON array with section-per-function and applicationCapability-per-capability
//   already baked in) and runs it through the EXACT SAME pipeline a real Load SFCCE
//   upload uses (flattenJsonRecords -> buildRowsFromRecords -> buildIndustryTree, via
//   a new GENERAL_SFCCE_MAPPING) -- no more hand-built fce-generalnodes.json tree
//   assigned directly. Every node's id auto-derives from its own ancestor chain (no id
//   fields mapped), a real, deliberate difference from the old file's hand-shared ids
//   (e.g. "Production Schedule" under two different capabilities is now two Parts, not
//   one) -- see DESIGN_DOCUMENT.md SS7.5.
// - store.industryData/{[key]:tree} and store.industryTemplates/{[key]:name} (memory-
//   only, never persisted) are GONE, replaced by store.doc.industryTree (array) and
//   store.doc.industryTemplateName (string) -- genuinely part of the persisted
//   document now, so a Load SFCCE import survives Save/Load JSON (previously entirely
//   memory-only). migrateDoc defaults an older file with neither field to an empty
//   industryTree/'SFCCE' -- no prior users, so no attempt to reconstruct a lost
//   dataset.
// - Every industryKey parameter is GONE, not just hardcoded to a constant --
//   generateIndustry(app, onProgress, placeInView), App.runGenerateIndustryWithProgress
//   (placeInView), App.openOrSwitchSfceCatalog() all dropped it, since there is
//   structurally nowhere left for a second dataset to live. promptGenerateIndustry's
//   industry <select> and promptSfceCatalog's multi-industry picker modal are both
//   gone (only ever one option). promptSFCCEMapping's "Industry Name" text input and
//   its duplicate-name guard are gone too.
// - Load SFCCE now REPLACES store.doc.industryTree (finishSFCCEImport sets it
//   directly, no longer merges into a keyed map) and warns first
//   (App.confirmModal(...)) whenever industryTree is already non-empty -- which, since
//   the built-in default is always loaded at boot, is effectively every real Load
//   SFCCE a person runs. Cancelling leaves the mapping dialog open rather than
//   discarding the person's field-mapping choices.
// - Real bug caught once the boot data actually became section-tagged for the first
//   time: every shipped streamTemplate's own passive[] array lists
//   {from:'BusinessOrganizationUnit', to:'BusinessFunction'} (added earlier purely for
//   3D View layer-visibility scanning) -- unguarded, createStream's GENERIC passive-
//   node mechanism processed this entry too, creating a second, wrongly-labeled OrgUnit
//   per stream alongside the dedicated section-reification block's correct one (3
//   correct OrgUnits ballooned to 21 on the built-in dataset). Fixed with a one-line
//   guard skipping BusinessOrganizationUnit entries in that loop entirely -- the
//   dedicated block is now the sole owner of OrgUnit creation. Strengthened the
//   pre-existing check_business_organization_unit_element_and_generation to count ALL
//   BusinessOrganizationUnit parts (not just correctly-labeled ones), since the old
//   label-filtered assertion could never have caught this.
// - DEFAULT_BATCH_SCRIPT_CODE's BatchScript_InsertSmartStreamExample switched from
//   connectorType 'c' to 's': 'c' also carries the OrgUnit Assignment edges, so tracing
//   from "Production" via 'c' now fans out into every other function sharing its
//   Section (89 elements instead of a tight ~13-element demo) -- 's' is the network
//   createStream itself builds one stream at a time, so it stays scoped correctly.
// - Unrelated fix bundled into the same request: promptGenerateIndustry/openOrSwitchSfceCatalog
//   toast "No industry data loaded" instead of erroring when doc.industryTree is empty.
// New check_types_filter_keeps_connectors_visible (last version) and this version's
// updates to check_sfce_import_and_generate, check_generate_industry_no_collapse_keeps_functions_separate,
// check_generate_industry_selection_cap, check_sfce_catalog_page, check_load_sfcce (now
// also asserts the replace-warning fires), check_load_sfcce_id_and_description_mapping,
// check_load_sfcce_dialog_ux_and_generate_unique_id, check_business_organization_unit_element_and_generation
// (strengthened), check_batch_script_quickstart (connectorType 's', two "Production
// Schedule" parts) -- every fixture-injection call site moved from
// store.industryData[key]=tree to store.doc.industryTree=tree. Proven via two separate
// revert-then-restore cycles (the BusinessOrganizationUnit passive-loop guard, and the
// "clear and replace" warning). DESIGN_DOCUMENT.md SS7 substantially rewritten (new
// SS7.5), tests/README.md, and public/instructions.html updated. Full suite 111/111.
//
// v0.866: capabilities-general-SFCCE.json gained sectionId/order fields per function
// (matching custom.json's org-viewType sections), plus 4 new placeholder function
// entries for the org sections that had none yet (Enterprise Scope/Continuous
// Improvement/Resources Sustainment/Finance Control Functions -- 'title' excluded,
// it's a header row with elementTypes:[], not a real content section). Then, reported
// directly: "wire sectionId and order into the boot loader" -- GENERAL_SFCCE_MAPPING
// (data.js) now maps sectionIdField:'sectionId'/sectionOrderField:'order' (previously
// only mof/cof/ssf's functions carried an id at all, via nothing -- sectionId was
// entirely unmapped). sfce.js gained a new sectionOrderField/nodeSectionOrder concept,
// parallel to the existing sectionDescriptionField/nodeSectionDescription -- a plain
// read-through value (readScalar), not an id, so no cascade/GENERATE_UNIQUE_ID
// semantics. Real, visible effect: every generated BusinessOrganizationUnit part now
// gets a genuine xIds (its sectionId) instead of blank, and all 7 real content
// sections (not just 3) now generate their own OrgUnit. sectionOrder also surfaced as
// a new SFCE Catalog column (flattenIndustryTree's makeRow, main.js's tableCols). New
// check_boot_loader_wires_section_id_and_order (tests/run_all.py), proven via a
// deliberate revert-then-restore of GENERAL_SFCCE_MAPPING; updated the PRE-EXISTING
// check_sfce_catalog_page's exact-column-list assertion for the new column (an
// expected, documented side effect, not a regression). DESIGN_DOCUMENT.md SS7.5 and
// tests/README.md updated. Full suite 112/112.
//
// v0.867: replaced instructions.html's "Industry_to_SFCCE" AI-prompt template
// (public/instructions.html, "AI-Assisted Capability Data Generation" section) after a
// multi-round review at the user's request. Function now carries functionDescription/
// functionId; a fixed baseline of ~29 generic enterprise-support Functions (Accounting,
// Audit, Procurement, Human Resourcing, ...) is included verbatim, matching
// custom.json's own "Enterprise Functions" populate-from-template data, so a generated
// file's Functions line up with that template's functionId/Section assignments out of
// the box. Section moved back to (and stayed at) the Application Capability level as
// "sections" (a string array, supporting genuine cross-section sharing via the
// wizard's existing shared-Section detection) -- an earlier draft during review moved
// it to the Function level as a single scalar, which was simpler to wire but lost
// multi-section sharing; corrected per direct feedback: "cross-section sharing is
// needed... section is currently supported under applicationCapabilities... it should
// stay to support existing input structure." A parallel per-value "sectionId" array
// was also considered and rejected -- buildRowsFromRecords only reads ONE scalar
// Section-Id field per record (resolveMappedId), so a plural sectionId array can never
// correctly line up with a plural sections array; kept as a single OPTIONAL scalar
// instead, filled in only when "sections" names exactly one of 7 known Sections,
// otherwise left blank ("SectionId can be blank or a lookup from the values provided"
// -- an unrecognized or multi-valued section still imports fine, auto-deriving its own
// id, same as any other unmapped Section Id). Sections are no longer a closed set of 7
// ("Sections will not just be one of the 7, others need to be accepted") -- reworded to
// "prefer... wherever it genuinely fits" rather than a hard constraint. All numeric
// target ranges (Function/Capability/Entity counts) removed per direct request ("Should
// not have count limits on any type of data, please remove"). No code changes; no new
// test (nothing in run_all.py asserts this section's content). Full suite 112/112
// (unaffected, run as a sanity check).
//
// v0.868: reported directly: "update SFCCE load: add to dialog something like 'section
// for shared functions', and default it to sectionId cof but provide selector for
// known sections. Any shared functions should go to that section." Before this, a
// collapsed shared Function (spanning more than one Section, Domain-level sharing --
// SFCCE_SHARED_LEVELS[0]) always landed on the literal placeholder string "Shared"
// with no real sectionId at all. promptSFCCEMapping (main.js) gained a new
// #sfcce-shared-section <select>, listing every real content-bearing org-viewType
// Section from custom.json (excludes a header/label row like 'title', whose
// elementTypes:[] means it can't hold BusinessFunction content), defaulted to 'cof'
// (Centralized Operational Functions). sfce.js's resolveSharedLevel gained optional
// sharedSectionName/sharedSectionId params (default 'Shared'/null, preserving exact
// prior behavior for any caller that doesn't pass them) -- when collapsing, a row's
// section becomes the given name, and sectionId is only overwritten when a real id is
// given. Threaded uniformly through promptSFCCESharedLevelConfirm's whole recursive
// walk (SFCCE_SHARED_LEVELS gained an allowsSharedSectionOverride flag on the Domain
// entry only), so the loop itself needs no special-casing -- only the Domain level's
// own resolve wrapper actually forwards the override into resolveSharedFunctions;
// Business Capability/Application Capability-level sharing still collapses to the
// plain "Shared" tag, unchanged (the request specifically said "shared functions").
// The confirm modal's own copy/button text now names the real chosen Section instead
// of a generic "Shared" placeholder when it's the Domain level being resolved. Known,
// documented (not fixed) limitation: if the SAME row is ALSO shared at a deeper level,
// that level's own (still-'Shared') resolution runs afterward and overwrites the
// Domain level's chosen Section back to the literal string -- out of scope per the
// request's own "shared functions" wording; see DESIGN_DOCUMENT.md SS7.1. New
// check_load_sfcce_shared_section_selector (tests/run_all.py), proven via a deliberate
// revert-then-restore of resolveSharedLevel's new params. DESIGN_DOCUMENT.md SS7.1,
// tests/README.md, and public/instructions.html updated. Full suite 113/113.
//
// v0.869: two direct reports handled together.
// (1) "In SFCCE load command, remove option for combining into 'shared' at business
// capability or application capability level. these will never be combined into
// shared, only functions are combined." Load SFCCE used to ask up to three separate
// "combine into Shared?" questions (Domain, then Business Capability, then Application
// Capability, walked via an SFCCE_SHARED_LEVELS array of level configs). Removed the
// deeper two ENTIRELY, not just their UI option -- confirmed structurally safe: a
// Capability/Application Capability identity can only span more than one ORIGINAL
// section when its parent Function's own rows ALSO span those sections, so
// Function-level resolution (which always runs) already disambiguates the scope
// those keys are built from either way. detectSharedCapabilities/
// resolveSharedCapabilities/detectSharedApplicationCapabilities/
// resolveSharedApplicationCapabilities (sfce.js) deleted outright, along with the
// now-dead originalCapabilityName/originalApplicationCapabilityName row fields only
// they read. promptSFCCESharedLevelConfirm's level-walking loop (main.js) and the
// SFCCE_SHARED_LEVELS array it walked are gone, replaced by a single, simpler
// promptSFCCESharedFunctionsConfirm. New check_load_sfcce_shared_functions_only
// (tests/run_all.py); check_load_sfcce updated (its old step4/step5 assertions
// tested modals that no longer exist -- counts stay the same, achieved via one
// confirm instead of three, since buildIndustryTree's own key-based dedup already
// merges what the removed levels used to handle explicitly).
// (2) "Problem: data entity detail does not get sized correctly upon creation, using
// remap, or redraw" -- reported with an exact failing DDL fixture (two ordinary
// tables, 9 and 8 columns). redrawNodeSizes (canvas.js) -- the single content-
// measuring function Import DDL/Remap/Redraw all funnel through -- clamped
// view.nodeHeight to a stale 140px ceiling that an 8-9 column DataEntityDetails
// node's own on-canvas attribute list already exceeded; .fnode has no
// overflow:hidden, so this wasn't invisible clipping, the last row(s) visually
// overflowed the node's fixed-height box. Fixed by raising the ceiling to 600px
// (fits ~40 attribute rows -- still a real ceiling, not removed outright). New
// check_data_entity_details_sizing_fits_attribute_count (tests/run_all.py), using
// the exact reported DDL, asserting every attribute row's own bounding rect falls
// within its node's rendered box across all three named paths.
// Both proven via deliberate revert-then-restore. DESIGN_DOCUMENT.md SS7.1/SS7a,
// tests/README.md, and public/instructions.html updated. Full suite 115/115.
//
// v0.870: "let's finish data connectors in data modeling -> erd. Part A: auto
// determine from ddl content 'references'. Part B: find matching field names where
// one is primary key and other is not, this is potential for n to 1 and foreign key,
// show preview list to user to confirm before creating new connectors." Part A
// already existed inside importDDL, but only for tables being created fresh from
// pasted DDL text -- this adds the missing piece: a new Data Modeling menu command,
// Auto-Detect Connectors..., that finds candidate 'd' connectors between tables that
// ALREADY exist in the document (scoped to the whole document, not just the current
// view -- these tables may not even share a view yet), previews them, and creates
// only what's confirmed.
// commands.js gained detectConnectorCandidates(store, ddlText) -- pure logic,
// combining Part A (ddl.js's parseDDL, the exact REFERENCES parsing importDDL itself
// uses, matched against EXISTING tables/columns by name instead of creating new ones)
// and Part B (a field-name heuristic: any non-primary-key attribute whose name
// matches another table's primary key, either exactly or via the common
// "<Table>Id" convention, e.g. Customer's PK "Id" matching Order's "CustomerId") into
// one de-duplicated candidate list, using importDDL's own fromAttribute/toAttribute/
// cardinality convention throughout. A pair already linked by a real 'd' connector
// (checked by exact attribute-id pair, not store.findExistingConnector's coarser
// from/to/model/type key, which would wrongly collapse two distinct FK relationships
// between the same two tables into one) is never re-proposed.
// createDetectedConnectors(app, candidates) creates a real connector for each
// CONFIRMED candidate, placing a viewMember in every view where both endpoint parts
// are already placed together (mirroring smartCheckView's own missingConnectors
// placement rule) -- a pair sharing no view yet still gets its connector created,
// just left unplaced, the same "unplaced Composition connector" precedent Level
// Up/Down already established, rather than being silently dropped.
// App.promptAutoDetectConnectors (main.js) is a single modal: optional DDL-paste
// textarea, a Detect Connectors button populating a checkbox preview table (every row
// checked by default, Select All toggle), and a Create Selected Connectors button
// (hidden until Detect has run) that creates only what's checked. New Data Modeling
// menu item after Export DDL.
// New check_auto_detect_connectors_detection_and_creation (Part A/B, de-dup,
// placement-vs-unplaced, idempotent re-detection) and check_auto_detect_connectors_
// dialog (real menu/DOM wiring), both proven via deliberate revert-then-restore.
// DESIGN_DOCUMENT.md SS7a, tests/README.md, and public/instructions.html updated.
// Full suite 117/117.
//
// v0.871: "need a better remap for erd that puts popular nodes central to single
// children around them, repeat this pattern in clusters. perhaps a 'centralize in
// clusters' option that could work on any view." New 5th Remap pattern,
// 'clusters'/"Centralize in Clusters". The existing 'force' pattern (SS6.1) already
// centers the single highest-degree node -- but only ONCE per connected component,
// and a real ERD schema is often one giant connected component end to end, so 'force'
// gives exactly one hub for the whole diagram. 'clusters' decomposes a component into
// SEVERAL hub-and-leaves stars instead, tiling them together the same way 'force'
// tiles separate components.
// layout.js gained computeHubClusterDecomposition(nodeIds, edges) -- pure graph logic,
// no coordinates, exported separately for direct unit testing. A node's "primary hub"
// is whichever neighbor has STRICTLY higher degree than its own (ties broken by input
// order); every node with degree >= 2 is a hub candidate, processed highest-degree-
// first, absorbing every still-unclaimed node whose primary hub it is -- true leaves
// (degree 1) always join their one neighbor's ring, and a lower-degree NON-leaf also
// joins a hub's ring when that hub is its one clearly-more-connected neighbor (the
// specific "leans toward one hub" choice made for this feature, over "only literal
// leaves cluster"). Absorption is NOT transitive -- an absorbed node's OWN further
// edges become cross-cluster bridges, same category as 'force''s own unplaceable
// cycle edges. Two EQUAL-degree hubs connected to each other stay separate clusters
// (neither outranks the other) rather than merging. Any node still unclaimed after
// the hub pass (isolated node, or an isolated pair/chain where neither side ever
// reaches degree 2) becomes its own small hub, so every node lands in exactly one
// cluster.
// computeHubClusterGridLayout places each star's ring in the 8 cells around its hub,
// then shelf-packs the stars via the existing packClustersOnGrid unchanged. The
// 8-neighbor/expanding-ring placement mechanic itself (makeRingPlacer) was factored
// out of computeAdjacentGridLayout into code both layouts now share, so 'force' and
// 'clusters' can never silently disagree on how a crowded hub's neighbors get packed.
// commands.js's applyRemapLayout gained a pattern==='clusters' branch mirroring
// 'force''s own (same stepX/stepY convention, same early return before Edge
// Assignment/minimizeCrossings/minimizeConnectorLength, reusing forcePreferRight for
// the ring's own placement bias but not forceGroupRows, which has nothing to apply to
// on a one-level-deep ring). main.js's Remap dialog gained the new option, its own
// explanatory note, and a shared REMAP_PATTERNS constant (replacing two independently-
// hand-maintained allow-lists) so the dialog's default-pattern resolution and
// preset-load guard can never drift out of sync with which patterns actually exist.
// New check_remap_clusters_decomposition (pure logic: star/leaning-absorption/
// equal-degree-bridge/isolated-pair/isolated-singleton fixtures) and
// check_remap_clusters_grid_placement (applyRemapLayout end to end: hub-ring
// adjacency, non-overlapping shelf-packed clusters, forcePreferRight), both proven via
// deliberate revert-then-restore; check_remap_patterns extended to cover the new
// pattern too. DESIGN_DOCUMENT.md SS6.1c, tests/README.md, and public/instructions.html
// updated. Full suite 119/119.
//
// v0.872: direct follow-up on the new 'clusters' Remap pattern: "is it possible to add
// the existing 'minimize connector crossing' or something similar, to avoid placing
// nodes directly on unrelated connectors after 'centralize in clusters' is applied?"
// The existing minimizeCrossings/minimizeConnectorLength options are Sugiyama
// row-reordering passes with no meaning on a 2D grid-packed cluster layout, so this
// needed two genuinely new, 'clusters'-specific mechanisms instead -- both always-on,
// no new dialog checkbox, since this fixes an intrinsic layout defect, not a
// stylistic preference.
// (1) packClustersOnGrid (layout.js, still shared with 'force') is now connectivity-
// aware via a new optional `edges` third argument: root cause of the underlying
// defect was that clusters got ordered purely by area, oblivious to which clusters
// share a cross-cluster "bridge" edge, so a bridge-connected pair could land on
// opposite ends of the shelf-packed sequence with an unrelated cluster between them --
// stretching that bridge's straight line across (and often through) unrelated
// territory. Fixed packing order: largest cluster first (unchanged default), then
// greedily whichever remaining cluster shares the most bridge edges with what's
// ALREADY placed, tie-broken by area. For 'force' (whole connected COMPONENTS as
// clusters -- no edge ever crosses between two components, by definition) this is a
// proven no-op: zero cross-cluster weight ever exists there, so packing falls
// straight back to the original pure-area order, unchanged.
// (2) New avoidNodeOnConnectorOverlap (layout.js, exported) -- a best-effort cleanup
// pass run after packing, for whatever a bridge edge still crosses despite (1): for
// every edge, checks whether its straight-line path (center to center, small pixel
// padding) passes through any OTHER node's rectangle, and if so relocates that node.
// Deliberately conservative about what it's allowed to move: only a RING MEMBER is
// ever eligible (never a hub -- moving a hub would cascade and disturb its entire
// ring), and only to a still-free cell among its OWN hub's 8 immediate neighbor cells
// (never farther) -- so a relocated node is always exactly as hub-adjacent afterward
// as before. A bystander with no free alternative slot, or a hub itself sitting in an
// unrelated edge's path, is left exactly where it was -- heuristic, not a guaranteed-
// collision-free solver, same honest-limitation category as 'force''s own unplaceable
// cycle edges. Runs up to 3 bounded passes (relocating one node can occasionally free
// up, or create, a different collision elsewhere), same convention
// resolveResidualOverlaps already uses. Plain, self-contained segment-vs-rectangle
// geometry (segmentIntersectsRect/segmentsIntersect/cross2D) -- no external library,
// per this project's no-npm-packages constraint.
// New check_remap_clusters_connectivity_aware_packing (a hand-built P/Q/R cluster
// fixture proving the fixed ordering pulls a bridge-connected cluster ahead of a
// same-sized but unconnected one) and check_remap_clusters_avoid_node_on_connector_
// overlap (all three of avoidNodeOnConnectorOverlap's own safety guarantees: relocates
// a genuine bystander, never moves a hub, leaves a node with no free slot in place),
// both proven via deliberate revert-then-restore against the real algorithm (not just
// hand-derived expectations -- traced and empirically verified via a standalone node
// script before writing the assertions). DESIGN_DOCUMENT.md SS6.1c, tests/README.md,
// and public/instructions.html updated. Full suite 121/121.
//
// v0.873: "enable 'export view as image' for 3d view." File > Export View as Image
// already worked for a 2D canvas view but just toasted "No view open to export." for
// the 3D View tab -- tab.type !== 'canvas' there, and there's no SVG-serializable
// scene to build in the first place (the existing 2D export path is a hand-written
// SVG serializer, buildViewSvgString), just a real WebGL framebuffer that needs a
// genuinely different capture mechanism.
// New captureView3DImage(tabId) (view3d.js): forces one synchronous
// renderer.render(scene, camera) call immediately before capturing, then
// renderer.domElement.toBlob(..., 'image/png'). Relies on the renderer now being
// constructed with preserveDrawingBuffer:true (createInstance) -- without it, whether
// a capture returns real pixels or a blank/black image depends on browser-internal
// timing (when the drawing buffer gets cleared after the last requestAnimationFrame)
// the app has no control over; the small extra cost (the browser can't just discard
// the buffer each frame) is the accepted tradeoff for reliable export. Exported
// alongside the existing debugXxx introspection hooks, but given a real name since
// it's used by the app itself now, not just the test suite.
// canvas.js gained getView3DModule() -- returns the already-lazy-loaded view3d.js
// module reference (set once renderView3DPage's own dynamic import() populates it)
// rather than main.js importing view3d.js eagerly, which would defeat the entire
// point of the lazy-load (the ~800KB vendored Three.js payload only loads once a 3D
// tab is actually opened).
// main.js's promptExportViewAsImage now branches on tab.type === '3d' before its
// existing 'canvas' check, delegating to new App.exportView3DAsImage -- skips the
// SVG/PNG format-picker modal entirely (PNG is the only meaningful choice for a
// rendered 3D scene) and reuses the exact same Blob -> URL.createObjectURL ->
// synthetic <a download> -> revokeObjectURL pattern exportViewAsPng/exportViewAsSvg
// already use.
// New check_export_view3d_as_image: captureView3DImage resolves to a real non-empty
// image/png Blob for an open, rendered 3D tab (and null, not a throw, for a tabId
// with no live instance); the real File menu entry point on an active 3D tab skips
// the format picker and hands a real PNG Blob to URL.createObjectURL with a specific
// success toast; the pre-existing 2D canvas export path is unaffected. Proven to
// catch a regression two ways (disabling the 3D branch reproduces the exact original
// bug; forcing captureView3DImage to always resolve null reproduces a failed-capture
// toast), both reverted. Also verified visually outside the test suite: captured a
// real PNG of the bundled "smart factory 3d demo" showing actual cube meshes/
// connector lines, not a blank frame -- confirms preserveDrawingBuffer actually fixes
// the capture-timing risk it's meant to, not just that the code path runs.
// DESIGN_DOCUMENT.md SS9, tests/README.md, and public/instructions.html updated.
// Full suite 122/122.
//
// v0.874: two related requests handled together: "Update remap (any view) with a new
// checkbox 'selected' to apply remaping only to selected items and related
// connectors; valid for any pattern selected. If multiple nodes selected, apply
// 'Spacing' command increase or decrease only to selected nodes and update their
// x,y without changing view spacing value."
// (1) Remap dialog gained "Only remap selected nodes and their connectors"
// (#rm-selected-only, main.js's promptRemap) -- a sibling to the pre-existing "Only
// remap filtered nodes" (filteredOnly), reusing the exact same visiblePartVmIds
// parameter applyRemapLayout already threads uniformly through every pattern branch
// (default/none/layered/force/clusters all independently filter partVms down to
// this set, leaving anything excluded at its current x/y untouched), so "valid for
// any pattern" needed no pattern-specific code at all -- only the set itself needed
// to also be computable from tab.selection instead of only the active filter.
// Selected part viewMember ids are pulled the same way copyNodes already does, then
// INTERSECTED with whatever filteredOnly already produced when both are checked (a
// part must pass the filter AND be selected), not one replacing the other. Silently
// a no-op with nothing selected, same "no filter active" precedent filteredOnly
// already set. Not extended to section-based views' dialog-free quick-Remap path --
// that path has no options at all today and no "pattern" concept in the first
// place.
// (2) Spacing +/- (js/canvas.js's buildZoomControls) now branches on 2+ selected
// nodes (freeform views only): new state.js applySpacingRatioToVms(vmIds, ratio) is
// a standalone sibling to applySpacingScale, NOT a scoped call to it, since
// applySpacingScale always writes view.spacingScale by contract -- couldn't satisfy
// "without changing view spacing value" no matter how it was scoped. Same centroid-
// then-scale-then-shift-if-negative math, just computed over the given viewMembers'
// own centroid, and view.spacingScale is never touched. No persisted "current
// selection scale" exists to compute an old-vs-new ratio from (unlike the whole-view
// case), so each click is a flat multiplicative step (SELECTION_SPACING_STEP_RATIO =
// 1.2, chosen to feel comparable to the whole-view stepper's own +0.2/-0.2 off a base
// of 1) applied directly to the current positions, compounding naturally across
// repeated clicks. Fewer than 2 selected, or a section-based view (node positions
// come from live row/col grid math driven by spacingScale itself, not independent
// x/y), falls through unchanged to the original whole-view behavior.
// New check_remap_selected_only (real dialog UI, pattern deliberately 'clusters' to
// prove no pattern-specific wiring was needed) and
// check_spacing_command_selected_nodes_only (real .spacing-in button: selected nodes
// move, unselected node and view.spacingScale both stay untouched; fallback path
// with <2 selected still changes view.spacingScale as before), both proven to catch
// a reintroduced regression and reverted. DESIGN_DOCUMENT.md SS6.1d, tests/README.md,
// and public/instructions.html updated. Full suite 124/124.
//
// v0.875: two direct follow-ups on v0.874's Remap/Spacing selection features.
// (1) "remap selected places nodes over top existing. Can the results be placed
// starting in selected x,y?" Every Remap pattern computes fresh positions from the
// view's own FIXED origin -- fine for a whole-view remap, but a restricted subset
// (visiblePartVmIds set, via filteredOnly or the new selectedOnly) landed its result
// directly on top of wherever OTHER, un-remapped content already sat near that
// origin. New commands.js shiftToOriginalPosition(vms, originalPositions): a
// snapshot of the restricted partVms' own x/y is taken BEFORE any pattern mutates
// them; called right before each of applyRemapLayout's three return points (force,
// clusters, and the default/none/layered/Edge-Assignment path) whenever
// visiblePartVmIds was actually set, it translates the WHOLE restricted result by
// one uniform offset so its new top-left lands exactly where the group's own
// top-left was before this remap ran -- never per-node, which would distort the
// relative layout the pattern just computed. Proven a no-op for an unrestricted
// whole-view remap, and not extended to section-based views (fixed grid cells, no
// free origin to anchor against).
// (2) "Update spacing for vertical, horizontal, or both, when used with selected
// nodes; perhaps change existing <-> symbol to be toggle between vertical,
// horizonal, and both." The static '↔' inside .spacing-pct is now its own clickable
// .spacing-axis-toggle button, cycling view.spacingAxis ('both'/'horizontal'/
// 'vertical', SPACING_AXIS_CYCLE in canvas.js) through three icons ('↔↕'/'↔'/'↕' --
// "both" shown as the two individual glyphs concatenated, guaranteed to render
// identically everywhere the two already do). Persisted on view.spacingAxis, same
// view-level-display-setting precedent as view.spacingScale itself, including its
// own showFields.view entry (custom.json, render.js's selectOptionsFor) so it's also
// reachable from the property panel. applySpacingRatioToVms (state.js) gained a
// third `axis` parameter (default 'both', backward compatible), implemented by
// substituting a no-op ratio of 1 for whichever axis isn't selected rather than a
// separate code path, so the shared negative-position guard runs identically either
// way. Deliberately scoped to ONLY the 2+-selected path per the report's own "when
// used with selected nodes" -- the whole-view fallback still always scales both x
// and y, since a single spacingScale has no per-axis concept to select between; the
// toggle stays visible there, it just has no effect.
// New check_remap_selected_only_anchors_at_original_position (applyRemapLayout
// directly: a restricted remap lands exactly at its own original top-left, not the
// view's origin where two other untouched parts sit; an unrestricted remap is
// unaffected) and check_spacing_axis_toggle (real .spacing-axis-toggle/.spacing-in
// buttons: three clicks cycle the axis correctly; horizontal/vertical each leave the
// other axis's coordinate untouched), both proven to catch a reintroduced regression
// and reverted. Verified visually too: a 3-node selected group placed far from an
// existing pair anchored back at its own original position after a real
// dialog-driven "Only remap selected nodes" run, confirmed via direct position
// readback (not just a screenshot). DESIGN_DOCUMENT.md SS6.1d, tests/README.md, and
// public/instructions.html updated. Full suite 126/126.
//
// v0.876: "update documentation, remove all reference to flowrun." Repo-wide
// case-insensitive sweep for the pre-rebrand product name. README.md's title
// dropped its "(formerly FlowRun)" suffix. CLAUDE.md's intro and its own "Rebrand
// note" section were reworded to describe the current, smaller set of intentional
// exceptions accurately, rather than claiming a compat path that no longer exists.
// js/simulation.js's loadSimSnapshot no longer accepts the pre-rebrand
// 'flowrun-sim-snapshot' file-format tag alongside 'dycad-sim-snapshot' -- per this
// project's own "no prior users, no backwards-compat needed for naming/terminology
// renames" stance, confirmed directly rather than assumed, since removing it changes
// real behavior (an old-tagged snapshot file is now rejected like any other
// unrecognized file, the same as it would be for a genuinely foreign file). Two
// spots deliberately kept the name unchanged, confirmed directly rather than
// assumed: js/version.js's own changelog (this section) and RECREATION_PROMPT.md's
// "Phase 13 — Rebrand" section, both genuine historical record of work that already
// happened, not something to retroactively rewrite -- consistent with this
// changelog's own established practice. Full suite 126/126 (no test referenced the
// removed compat path).
//
// v0.877: reported directly, "please add these section definitions to the source
// file" -- FUNCTIONS (Enterprise Scope, Mainstream Operational, Staff Specialist,
// Continuous Improvement, Resources Sustainment, Financial/Finance Control) and DATA
// MANAGEMENT ROLES definitions, given verbatim. Identified "the source file" as
// public/instructions.html's Industry_to_SFCCE AI-prompt template (the one place in
// the repo that already lists these exact 7 known-Section names, per v0.867's own
// entry) rather than public/custom.json's org-viewType section rows (which have no
// description field at all, and aren't consumed as an AI prompt) -- the pasted
// FUNCTIONS text is a definition for each of the 7 known Sections the prompt already
// tells the AI to prefer reusing, and the DATA MANAGEMENT ROLES text explains, using
// data-function examples, exactly the Mainstream-vs-Centralized ("economies of
// scale") distinction the prompt's own baseline Function list already encodes
// (Data Admin tagged Centralized Operational, Data Management tagged Mainstream
// Operational) but never spelled out as a rule. Inserted both, lightly normalized
// (e.g. "Finance Control Functions" to match the section name already used
// verbatim elsewhere in this same prompt, a duplicated "Functions Functions" word
// fixed) but not reworded, right after the known-Sections list and before the
// existing "sectionId is optional" paragraph -- exactly where an AI reading the
// prompt needs the definitions to correctly apply "prefer reusing... wherever it
// genuinely fits." Pure content addition to a static documentation string; no code
// changed, no new test (nothing in run_all.py asserts this prompt's prose content,
// consistent with v0.867's own "no code changes; no new test" precedent for the
// same file). Full suite sanity-checked via check_boots_clean only, per that same
// precedent, rather than the full run.
//
// v0.878: direct follow-up: "when I open catalog SFCCE I don't see these section
// descriptions. please add." Root cause: Catalogs > SFCCE's sectionDescription
// column (openOrSwitchSfceCatalog, main.js; sfce.js's makeRow) reads a row's own
// nodeSectionDescription, populated only when a Load SFCCE field mapping supplies a
// sectionDescriptionField -- the BUILT-IN default dataset's own mapping
// (GENERAL_SFCCE_MAPPING, data.js) never has one, so this column was always blank
// for the data most people actually see there. public/custom.json's org/org4lob-
// viewType section rows (esf/mof/cof/ssf/cif/rsf/fcf, plus org4lob's mof2/mof3/mof4)
// gained a real `description` field each -- the same v0.877 definitions, now living
// as actual data, not just AI-prompt prose. openOrSwitchSfceCatalog now fills in any
// row's blank sectionDescription from this same custom.json data by matching
// sectionId (the identical sectionId->name lookup pattern Load SFCCE's own shared-
// section dialog already uses), leaving a row that DOES carry its own real
// description from the imported data completely untouched. Verified in a real
// browser: all 40 rows of the built-in default dataset went from 40 blank to 0 blank
// sectionDescription cells. New check_sfce_catalog_section_description_fallback,
// proven to catch a reintroduced regression and reverted. DESIGN_DOCUMENT.md SS7.1
// and tests/README.md updated. Full suite 128/128.
// v0.879: direct follow-up: "the script console page is too long ... Update the
// instructions page script references to include the information from script console
// references, put it in a table format for ease of reading. Can a tab be created in
// script console page to only show reference details when user selects it? this
// leaves the two main windows in script console, make these wider." promptScriptConsole
// (main.js) used to open with a dense bindings/options paragraph running ahead of
// #console-output/#console-input, pushing the dialog tall on every open. Split into a
// Console tab (output + editor only, open by default) and a Reference tab (hidden
// until clicked, holding the same bindings/options content as a docs-table instead of
// flowing prose) via plain .tb-btn/.tb-btn.active toggle buttons. Also widened the
// dialog itself: new modal-box-console class (min(920px, 96vw)) replacing the older,
// narrower modal-box-textedit (min(640px, 90vw)), so Console's two panes get the freed
// width. public/instructions.html's own Script Console section got the same table
// (also fixing a real staleness bug in the process: neither copy previously mentioned
// the 'clusters' remap pattern added back in v0.871). Three existing Script Console
// tests updated for the new modal-box-console selector (check_script_console_runs_
// main_function, check_batch_script_quickstart, check_script_console_remap_and_
// smart_check_bindings); new check_script_console_reference_tab, proven to catch a
// reintroduced regression (temporarily broke the tab-toggle to always show Console)
// and reverted. DESIGN_DOCUMENT.md SS5.3 and tests/README.md updated. Full suite
// 129/129.
// v0.880: direct follow-up: "script console page still too long, barely fits at 80%.
// Make output window half the length and scrollable, and make reference part
// scrollable and have the length on open. Add 'copy' buttons to the three windows:
// output, script, reference to allow user to easily copy individually."
// promptScriptConsole (main.js): #console-output height halved 280px -> 140px (still
// overflow-y:auto). The Reference tab's content now lives inside a new
// #console-reference-scroll wrapper with its own fixed height (480px) + overflow-y:
// auto set directly in the initial innerHTML -- fixed the moment the dialog opens, not
// something that only appears once the tab is first clicked, so switching tabs never
// resizes the dialog. Each of the three panes (Output, Script, Reference) got a small
// header row with its own Copy button, wired through one shared copyPaneText(getText,
// label, btn) handler (writes to navigator.clipboard, same pattern as the existing
// "copy remap() call" and "copy Message Log" buttons) -- each button supplies a
// different getter so a mixed-up wire-up is directly testable. New
// check_script_console_sizing_and_copy_buttons, proven to catch a reintroduced
// regression (temporarily made the Output Copy button grab the Script pane's text
// instead) and reverted. DESIGN_DOCUMENT.md SS5.3 and tests/README.md updated. Full
// suite 130/130.
// v0.881: direct follow-up: "when creating derived connectors, create both 's' and
// 'c' versions. Add creation of derived (same logic) to a new checkbox in 'Smart
// Check View' command." Two new shared helpers in commands.js: findDerivedPairsForType
// (discovery -- walks one connectorType's own graph, directionally, up to `levels`
// hops, for pairs of "present" parts linked only through NOT-present ones) and
// createDerivedConnectorPairs (creation -- always materializes BOTH a 'c' and an 's'
// Connector per pair, regardless of which type's graph found it, skipping whichever
// already exists). insertSmartStream's own discovery is unchanged (still scoped to
// its own hop-limited, showTypes-filtered collectedPartIds), but its creation step now
// goes through createDerivedConnectorPairs too -- only the ONE type matching the
// trace's own connectorType gets placed on the view being built, the other still
// exists in the model. smartCheckView gained a new "Derive hidden connections"
// checkbox (deriveConnectors option, off by default, #scv-derive-connectors in
// promptSmartCheckView/main.js): here "hidden" means "not placed on this view" (no
// showTypes filter at this scope); walks findDerivedPairsForType once per type up to
// the SAME `levels` field "missing connectors and nodes" already uses (Levels row now
// shows for either checkbox); runs LAST so a part missingConnectorsAndNodes just
// pulled onto the view in the same call no longer counts as hidden; places BOTH
// created types on the view (Smart Check View has no single-connectorType scope,
// unlike Insert Smart Stream -- its other checkboxes already add either type without
// discriminating). New check_smart_check_view_derive_connectors and
// check_smart_check_view_dialog_derive_checkbox_wiring, plus a "both versions" +
// idempotency extension to check_insert_smart_stream_derived_connections -- all proven
// to catch a reintroduced regression (temporarily limited createDerivedConnectorPairs
// to 'c' only, and separately broke the Levels-row visibility toggle) and reverted.
// DESIGN_DOCUMENT.md SS5.5 (new) and tests/README.md updated; public/instructions.html's
// Insert Smart Stream and Smart Check View sections, plus the Script Console
// Reference table (main.js + instructions.html), updated for the new behavior/option.
// Full suite 132/132.
// v0.882: direct follow-up: "when a derived connector is created, if a default
// relationship or valid relationship is not available, use 'o' 'Association' not the
// current 's' 'Stream' for relationship for connectors of type 'c'." A derived pair's
// 'c' version was reusing whatever relationship the discovery walk traced verbatim --
// fine from a 'c'-typed hidden chain, but a chain discovered by walking 's' edges
// traces back the literal word "Stream" (findOrCreateStreamConnector's own convention
// for every real 's' connector), which isn't a real 'c'-type relation at all.
// createDerivedConnectorPairs (commands.js) now keeps the traced relationship for the
// 'c' version only when it's genuinely valid for that specific fromType->toType pair
// (isRelationValid, rules.js -- the same rules the property panel's own relationship
// dropdown enforces); otherwise falls back to that pair's own data-defined default
// relation (findRelationshipPair(...).default) when one exists, else plain
// 'Association' (key 'o') -- the same "default, else Association" fallback
// createCompanionConnector already used elsewhere in this file. relationCodeFor
// (state.js) and isRelationValid (rules.js) newly imported into commands.js. The 's'
// version is never affected -- "Stream" stays exactly right for it. New
// check_derived_connector_relationship_fallback, covering both a pair WITH its own
// default (BusinessFunction->BusinessProcess: 'r' Realization) and one with no rule at
// all (falls to 'Association'), confirming the 's' sibling is untouched in both cases,
// and confirming a genuinely-valid traced relationship from a 'c'-typed chain is kept
// as-is rather than overridden to the pair's own different default -- proven to catch
// a reintroduced regression and reverted. DESIGN_DOCUMENT.md SS5.5, tests/README.md,
// and public/instructions.html's Insert Smart Stream section updated. Full suite
// 133/133.
// v0.883: direct follow-up to a UI-writing audit ("are there any UI changes
// recommended?", answered by loading the frontend-design skill and reviewing toast/
// dialog copy against it): "is toasts not going to the message log considered
// appropriate?", then "do both" (also fix the audit's other finding, no explicit
// keyboard-focus style).
// Part 1 -- app.toast(message, isError, alsoLog) (main.js) gained a third parameter:
// alsoLog=true writes a routine SUCCESS toast to the Message Log too (isError=true
// already always did). Most document-mutating commands reported a real outcome/count
// in their toast but left zero persistent trace once it faded -- an accident of which
// features happened to already have a log() closure threaded through, not a
// deliberate policy. Added alsoLog=true at ~20 call sites: Auto-Detect Connectors,
// Section insert/remove, Delete-from-model, Auto-Complete Streams, Sync Inventory
// Connector (main.js); Create/Duplicate Stream, Level Up (both variants), Generate
// Industry/Inventory View, Add Existing, Populate From Template, Insert Smart Stream,
// Remap, Merge (both variants), Duplicate Section, Import DDL (commands.js). Left
// alone: routine no-op toasts ("Nothing selected"), exports (no document mutation),
// Smart Check View/Node summaries (already covered by their own per-change log()
// trail), and Import Data (already separately logged).
// Part 2 -- css/styles.css gained one global :focus-visible rule (outline: 2px solid
// var(--accent)) -- verified in a real browser first that native default outlines
// WERE rendering (not actually invisible), but unbranded and not guaranteed
// consistent; canvas nodes have no tabindex anywhere in this app, so this can never
// collide with .fnode.selected's own outline.
// New check_mutation_toasts_log_to_message_log (the toast() primitive directly, plus
// three real command flows spanning main.js and commands.js) and
// check_keyboard_focus_visible (a real toolbar button and real dialog controls,
// distinguishing OUR rule's exact outline-style/width from Chromium's own nonzero
// default -- a weaker assertion didn't actually catch the rule being removed) -- both
// proven to catch a reintroduced regression and reverted. DESIGN_DOCUMENT.md SS5.4 and
// tests/README.md updated. Full suite 135/135.
// v0.884: two direct follow-ups. (1) "add smart view check: missing connectors and
// derive hidden connections to example script main() after await
// BatchScript_InsertSmartStreamExample()" -- new BatchScript_SmartCheckViewExample
// (state.js) calls smartCheckView(app, tab, {missingConnectors: true,
// deriveConnectors: true}) on the same "Smart Stream Example" view/tab
// BatchScript_InsertSmartStreamExample just built, logging "Smart Check View example
// done"; main() now awaits it between InsertSmartStreamExample and RemapExample. A
// genuine no-op on the shipped default topology (nothing off-view to bridge, no
// not-yet-placed same-pair connector), verified NOT to disturb anything
// BatchScript_RemapExample later asserts. (2) "updated smart view check 'check' button
// right-click to copy function with parameter call matching options set, same
// behaviour as in other dialogs" -- promptSmartCheckView (main.js) now uses
// wireCopyCallOnRightClick (the same helper Remap's and Load SFCCE's own submit
// buttons already use) via a new collectSmartCheckViewOptions() closure shared by both
// the right-click handler and the real submit handler, matching exactly
// smartCheckView's own option keys and deliberately excluding the dialog's separate
// Auto-complete streams fields (a different action). check_batch_script_quickstart
// extended with a "Smart Check View example done" log assertion; new
// check_smart_check_view_copy_call_on_right_click -- both proven to catch a
// reintroduced regression and reverted. DESIGN_DOCUMENT.md SS6.1a, tests/README.md,
// and public/instructions.html's Script Console section updated (also fixed a
// pre-existing staleness there: it said the Insert Smart Stream example traces via
// "Connectors" when the actual code, and its own comment, explicitly uses 's' Streams).
// Full suite 136/136.
// v0.885: direct follow-up, reported after running the updated example script: "when
// user does 'export view as image' both types of connectors appear hard coded to
// show up in image but should only be whatever was selected by view checkboxes for
// connectors or streams." Investigated and ruled out the 3D View's own Connector Type
// filter (verified working correctly, on-screen and on export) before finding the
// real root cause: buildViewSvgString (main.js), the separate hand-written SVG
// renderer Export View as Image's SVG/PNG paths both use, never checked the view's
// own chkShowConnectorType/chkShowStreamType/chkShowDataType checkboxes at all
// (redrawEdges, canvas.js, already did, for the real on-screen canvas) -- always drew
// every placed connector regardless of type. Clarifying follow-up broadened this to
// all nine of the view's own display checkboxes (click the view background, not a
// node/connector, for its property panel): chkShowElementTypes/chkShowDescription
// were already respected; chkShowAttributes/chkShowKeys/chkShowSimValues/
// chkShowScriptBadge were never drawn in the export at all (Print already gets these
// for free -- it clones the real, already-filtered on-screen DOM instead of using
// this separate renderer). All six now match buildNodeEl's own gating content-for-
// content; formatSimValue newly exported from canvas.js, isAttributeForeignKey newly
// imported from render.js into main.js. New check_export_svg_respects_connector_
// type_checkboxes and check_export_svg_respects_content_checkboxes -- both proven to
// catch a reintroduced regression and reverted (the former counts only real
// connector <path> elements via :scope > path, since the always-present arrowhead/
// marker <path>s inside <defs><marker> would otherwise mask a broken filter). Root-
// caused during investigation, worth noting for future work: the batch script's new
// BatchScript_SmartCheckViewExample step (v0.884) is what makes the Smart Stream
// Example view's own 'c'-type companion connectors visible for the first time (via
// missingConnectors) -- genuine content the user can now choose to hide per-view via
// these same checkboxes, not a bug in that step itself. DESIGN_DOCUMENT.md SS9 and
// tests/README.md updated. Full suite 138/138.
// v0.886: direct follow-up: "In the right column above properties add a new
// collapsable group called Filters. Move the existing filters Stream, Type, Section,
// Level and the others but not 'Undo / Redo', 'Current View' or 'Default Model' to
// this new filter group for each view type that they apply to. So filters such as
// 'View Scope' that only apply to 3D View will only show up in the filter group when
// viewing a 3D View. Update the 3D View behaviour so that clicking on empty in the
// canvas will bring up this view filters and any view properties specific to 3D
// View."
// The 8 tab-scoped filter controls (View Scope, Stream, Types, Section, Connector
// Type, Layer Order, Highlight, Levels) moved from the header toolbar (#toolbar-row)
// into a new collapsible [data-panel-id="filters"] panel section (index.html) inside
// #right-panel, directly above Properties -- a pure relocation, same element ids
// throughout, so renderToolbar's existing per-tab-type classList.toggle('hidden', ...)
// calls needed no logic changes; new CSS (#right-panel .toolbar-group) just stacks
// them one per row instead of the toolbar's flex-wrap layout, and the whole section
// now also hides itself when none of the 8 groups apply (a table/pdf/docs/text tab)
// rather than showing an empty header. Undo/Redo/Current View/Default Model stay in
// the toolbar, untouched. view3d.js's click listener gained an else branch (empty
// space, no part hit) calling new deselectAndShowViewFilters(app, tab): clears
// tab.selectedCatalogRow, re-renders, then expands + scrollIntoView's the Filters
// panel. renderProperties (render.js) gained a 3D-tab branch (no selectedCatalogRow)
// showing a short hint pointing at the Filters panel instead of the generic,
// canvas-flavored "Select a node or edge" text -- a 3D tab has no single backing
// `view` document object the way 2D does, so its only real "view properties" are
// exactly these filters. New check_filters_panel_moved_from_toolbar and
// check_view3d_empty_click_deselects_and_shows_filters (the latter via a genuine
// page.mouse.click(), same debugGetScreenPosition pattern
// check_view3d_real_click_shows_panel_and_no_recenter already established, since a
// debug-hook-only test can't catch drift from the real listener) -- both proven to
// catch a reintroduced regression and reverted. DESIGN_DOCUMENT.md SS5.6 (new),
// tests/README.md updated. Full suite 140/140.
// v0.887: direct follow-up: "align view filter panel values to same column as
// property values. Move view filter checkboxes such as connectors, streams, data,
// types, description, attributes, keys, show simulation values (rename to show left
// badge), show script badge (rename to show right badge) that are currently below
// properties to the newly created filters group. In property and filter panels
// reduce vertical gaps between rows."
// The 9 view-display toggles moved from renderViewProperties (Properties panel) into
// a new renderViewDisplayFilters(app) (Filters panel, #view-display-filters-wrap/
// #view-display-filters-body, below the 8 tab-scoped filter controls, separated by a
// thin border), called from app.render() any time the active tab is a canvas view --
// independent of node selection, unlike before, when deselecting everything was the
// only way to reach them. renderViewProperties keeps the remaining 8 fields (Id/Name/
// View Type/Margin/Spacing/Spacing Direction/Connector Routing/Stream Connector
// Routing). Both now share a new viewFieldAccessors(app, tab, view) + filteredViewSpec
// (app, keep) pair (factored out of the old single accessors object) so neither copy
// can drift; each renderShowFieldsPanel call passes an explicit idNamespace ('view'/
// 'view-filter') since a merged-spec object (unlike the plain 'view' string this used
// to pass) would otherwise default both to the generic 'custom' namespace and collide.
// chkShowSimValues/chkShowScriptBadge renamed in their own showFields.view label
// (custom.json) to Show Left Badge / Show Right Badge, matching what they actually
// indicate now that they sit side by side in the same panel.
// #right-panel .tb-label got .prop-row label's own fixed 84px width, and #right-panel
// .toolbar-group's gap bumped 4px->8px to match .prop-row's gap too (both the label
// width AND the label-to-control gap have to match for the control's left edge to
// land on the identical pixel) -- so a Filters row's value control now aligns to the
// same column as a Properties row's. Base .prop-row margin-bottom dropped 8px->4px in
// both panels; a dialog's own higher-specificity .modal-box .prop-row override (12px)
// is untouched.
// New check_view_display_filters_moved_to_filters_panel and check_filters_properties_
// alignment_and_row_spacing, both proven to catch a reintroduced regression and
// reverted. DESIGN_DOCUMENT.md SS5.6 and tests/README.md updated. Full suite 142/142.
// v0.888: two direct follow-ups.
// (1) "when property resizable text fields are lengthened by user (lower right
// corner dragged) can that be persisted for the user for that property in any view
// for current session and future sessions. currently the resize is lost when user
// clicks away from the node." New dycad-field-heights localStorage key (render.js),
// same PINNED_FIELDS "cross-document, cross-model, per-browser habit" precedent --
// getFieldHeight/setFieldHeight/getAllFieldHeights/setAllFieldHeights, the latter two
// wired into File > Save/Load Local Settings alongside pinnedFields. A new
// wireFieldHeightPersistence(el, fieldName) ResizeObserver persists a genuine
// textarea resize keyed by field NAME alone (Note shares one height across Part/
// Connector/ViewMember); fieldHeightStyle(fieldName) applies whatever's saved as the
// initial height. Real bug found via direct testing before landing this: a removed-
// from-DOM textarea's own final ResizeObserver callback reports a bogus 0x0 rect --
// an `if (h <= 0) return;` guard was needed, or every deselect (which rebuilds
// #properties-body) would silently zero out the height it had just saved. Wired into
// both textarea call sites (the single-selection panel, and renderMultiSelectProperties's
// bulk-edit textarea).
// (2) "In redraw command for a view, add option something like 'show all text'
// checkbox and if selected resize default size for text that fits and full size
// that displays all text of node such as long descriptions. And retain setting for
// the specific view for future sessions." Redraw (Commands panel) previously ran
// immediately; new App.promptRedraw(tab) (main.js) shows one checkbox, pre-filled
// from and written back to view.chkShowAllText (a plain view field, retained the
// same way every other view.chkShowXxx toggle already is -- round-trips through
// Save/Load JSON for free). buildNodeEl (canvas.js) reads the same flag at BOTH
// measurement time (redrawNodeSizes measures by calling buildNodeEl itself) and real
// render time, removing .fnode-label/.fnode-description's -webkit-line-clamp:2 at
// both -- without touching render time too, a taller box would just show the same
// truncated "..." with the extra room wasted. chkShowAllText added to every view-
// creation/migration default alongside the other chkShowXxx fields (state.js x3,
// archimate.js) for consistency.
// Two existing tests (check_new_content_sized_and_non_overlapping,
// check_data_entity_details_sizing_fits_attribute_count) updated for Redraw now
// opening a dialog instead of running immediately. New
// check_textarea_height_persisted_per_field and check_redraw_dialog_show_all_text,
// both proven to catch a reintroduced regression and reverted. DESIGN_DOCUMENT.md
// SS5.1 and its Data Modeling section, plus tests/README.md, updated. Full suite
// 144/144.
// v0.889: direct follow-up: "update state.js default function
// BatchScript_InsertSmartStreamExample and DEFAULT_SMART_STREAM_PRESETS from
// showTypes: ['ApplicationCapability', 'BusinessFunction', 'BusinessProcess',
// 'BusinessCapability', 'DataDataEntity', 'GeneralActor', 'ApplicationLogicalComponent',
// 'ApplicationApplication','ApplicationPhysicalComponent','BusinessService'] to
// showTypes: ['GeneralActor', 'BusinessService', 'BusinessCapability',
// 'BusinessProcess', 'ApplicationService', 'ApplicationCapability',
// 'ApplicationProcess', 'ApplicationLogicalComponent', 'ApplicationPhysicalComponent',
// 'DataDataEntity', 'BusinessFunction', 'ApplicationApplication']." Both call sites
// (state.js's own comment already documented they're meant to mirror each other
// exactly, so the same trace is available both as a runnable script and as a
// ready-made StreamSet1 dialog preset) broadened from 7 to 12 element types --
// verified every new type name exists in custom.json's own element list before
// landing this. Genuinely changes what the SAME trace (from "Production", built-in
// default industry data) collects: 10 more parts now pass the filter (Application-
// layer + BusinessService companions the narrower original list excluded), and
// BatchScript_RemapExample's pattern:'layered' now needs a 5th row (ApplicationProcess
// lands one hop further out than the Capability/Process/Service row, the lone
// ApplicationLogicalComponent pair a hop further still) -- verified this new shape
// directly against a fresh trace (not assumed) before updating check_batch_script_
// quickstart's and check_smart_stream_preset_local_persistence's fixed expectations
// to match. Full suite 144/144.
// v0.890: direct follow-up: "copy the newly updated BatchScript_InsertSmartStreamExample
// to BatchScript_InsertSmartStreamExample2 and revert the original back to the previous
// element list, including the DEFAULT_SMART_STREAM_PRESETS list. Call the
// BatchScript_InsertSmartStreamExample2 after the original in console script."
// BatchScript_InsertSmartStreamExample2 added as a verbatim copy of the (former v0.889)
// 12-type BatchScript_InsertSmartStreamExample, distinguished only by its own Message
// Log line ("Insert Smart Stream example 2 done"); the original BatchScript_
// InsertSmartStreamExample and DEFAULT_SMART_STREAM_PRESETS's StreamSet1 both reverted
// back to the pre-v0.889 7-type showTypes list; main() updated to call
// BatchScript_InsertSmartStreamExample2() immediately after BatchScript_
// InsertSmartStreamExample(), both still running on the same "Smart Stream Example"
// tab/view (insertSmartStream only ever adds parts/connectors not already on the view,
// so the second pass tops the first up rather than duplicating it). Verified directly
// against a fresh trace (a dedicated probe script, not assumed): the two-pass 7-then-12
// run lands on the exact same 23-part set as the old one-pass 12-type run, but a
// different connector topology -- the first pass's own connectors are already on the
// view before the second pass runs, so BatchScript_RemapExample's pattern:'layered' now
// puts BusinessCapability 1 hop out (grouped with BusinessProcess/BusinessService/
// ApplicationPhysicalComponent) instead of 2 (previously grouped with
// ApplicationCapability/DataDataEntity) -- still 5 rows total. check_batch_script_
// quickstart updated for the new call, new "Insert Smart Stream example 2 done" Message
// Log check (proven to catch a missing call, then reverted), and the new row grouping;
// check_smart_stream_preset_local_persistence's expected showTypes reverted to match.
// tests/README.md updated for both. Full suite 144/144.
// v0.891: direct follow-up: "in example script comment out call to
// BatchScript_InsertSmartStreamExample2." main()'s call to
// BatchScript_InsertSmartStreamExample2() commented out (function definition kept,
// just not invoked by default) -- main() is back to a single 7-type
// BatchScript_InsertSmartStreamExample pass, same shape it had right after v0.890's own
// "revert the original" step, before the second pass was ever added to main(). Also
// answers the same follow-up's question: "Problem, BatchScript_InsertSmartStreamExample
// is creating two duplicate nodes Data Entity 'Production Schedule', why?" Investigated
// and confirmed NOT a regression from this session's changes -- reproduces with the
// single 7-type pass alone. Root cause: public/capabilities-general-SFCCE.json itself
// lists an entity named "Production Schedule" under BOTH the "Manufacturing Operations"
// and "Production Planning" Business Capabilities as two separate source records, and
// buildIndustryTree (since v0.865, see DESIGN_DOCUMENT.md SS7.5) auto-derives every
// generated Part's id from its own full ancestor chain (Function -> Capability ->
// Entity) rather than sharing ids across capabilities that happen to reuse an entity
// name -- a deliberate, previously-made and documented design choice, not a dedup bug,
// confirmed via each Part's own distinct id (not assumed). Left as-is pending a
// decision on whether to change that dedup behavior (would affect ALL industry
// generation, not just this one example). check_batch_script_quickstart updated: its
// "Insert Smart Stream example 2 done" Message Log check inverted (now requires it NOT
// present, proven via TEMP BREAK against a temporarily-restored call, then reverted),
// and its stream-label/row-type-set expectations reverted to the single-pass 7-type
// shape (13 parts, 4 rows). tests/README.md updated. Full suite 144/144.
// v0.892: reported directly: "in Advanced menu before Smart Check View add a new item
// 'Smart Check Model' for a new smart check model command. This command opens a dialog
// confirming what the user wants to check, begin with two items 'disconnected parts'
// for parts with no connectors of any type, 'disconnected connectors' for connectors
// that have one or both parts invalid (missing), and 'duplicate parts' for parts that
// have same type, model, and label, and present list to user to confirm individually
// which to fix / merge or leave as is." New commands.js smartCheckModel (pure
// detection, three categories, each independently toggleable) and
// applySmartCheckModelFixes (deletes confirmed disconnected parts/connectors, merges
// confirmed duplicate groups via a new mergeDuplicateParts -- same rewire/dedupe shape
// mergePartsAndView already uses, keyed by part id instead of a view selection). New
// App.promptSmartCheckModel (main.js): Advanced menu item added directly ABOVE Smart
// Check View, per the report; reachable with no canvas tab open (whole-model, not
// view-scoped, same as Auto-Detect Connectors); same preview-then-confirm two-step
// shape that dialog established -- Check populates a per-category results table (every
// row checked by default, per-section Select All), Fix Selected applies only what's
// still checked. Real bug caught while building this: a duplicate-group part that's
// ALSO zero-connector gets confirmed in both the delete-disconnected-parts list and the
// merge-this-group list at once (same pre-fix snapshot) -- applying delete first (or
// any order not accounting for this) silently no-ops the merge or drops a copy's
// connectors on the floor. Fixed by giving merge precedence: any part id in a confirmed
// mergeGroups entry is excluded from deletePartIds processing regardless of order --
// proven directly against a TEMP BREAK removing that exclusion (reproduced the exact
// failure, then reverted). New check_smart_check_model_detection_and_fix_precedence
// and check_smart_check_model_dialog. DESIGN_DOCUMENT.md SS5.7 and tests/README.md
// added/updated. Full suite 146/146.
// v0.893: reported directly: "smart stream example from script console is directly
// placing nodes over connectors instead of resizing to fit properly after remap. why?
// what remap settings are needed to avoid this?" then "yes, treat it as a real penalty
// in the scoring." Diagnosed against the REAL generateIndustry -> insertSmartStream ->
// smartCheckView -> remap pipeline: 'layered' puts a Business Capability and its own
// Business Process on the same row (equidistant from a root), connected by a real
// same-row connector; minimizeRowCrossings' crossings-first scoring could lock in a
// column order (Process, Process, Capability, Capability) that's genuinely better on
// cross-row crossings than the interleaved alternative, so the same-row connector drew
// a straight line directly through the OTHER pair's Process node sitting between them
// -- no existing Remap setting avoided this, a genuine scoring gap, not a missing
// checkbox. Fixed by adding a new `occlusions` criterion (commands.js's
// minimizeRowCrossings) -- for every same-row edge, how many other row members sit
// strictly between its two endpoint columns -- checked FIRST, ahead of crossings, in
// both the local swap heuristic (transposeAll, via a new rowOcclusionCount) and the
// final best-of-all-iterations comparison (isBetter). New
// check_remap_layered_avoids_node_occlusion (tests/run_all.py): runs the real pipeline
// (not a hand-built fixture -- the sibling crossing-minimization test's own fixture
// doesn't reproduce this) and checks every connector's straight-line path against
// every other node's bounding box for genuine intersection, proven via TEMP BREAK to
// reproduce all 4 real overlaps before this criterion existed, then reverted.
// DESIGN_DOCUMENT.md SS6 and tests/README.md updated. Full suite 147/147.
// v0.894: reported directly: "Create a common script in script console example that
// can be called from any part script. Within the new script I want to take action
// based on calling part type, label, and model. As an example have the script send to
// message log something like 'called by ' part type, label, and model." runTick
// (simulation.js) now compiles a part's own script as new Function('ctx',
// store.batchScriptCode + newline + part.script) instead of just new Function('ctx',
// part.script) -- every function/const the Script Console's own text defines is
// therefore in scope inside every part script too, callable by name using that
// script's own ctx. New CommonScript_Example(ctx) (state.js, DEFAULT_BATCH_SCRIPT_CODE)
// ships as the reported example, logging "called by <type> <label> <model>" via
// ctx.log/ctx.part -- a THIRD kind of entry point this file hosts, alongside main()'s
// BatchScript_* chain and dataAutoFill; CommonScript_<Name> is the naming convention
// for future additions meant to be called from a part script. Caught and fixed a real
// authoring bug along the way: using a raw '\n' inside a comment INSIDE the
// DEFAULT_BATCH_SCRIPT_CODE template literal gets interpreted as an actual newline by
// the OUTER template literal (not left as literal backslash-n), corrupting the string
// -- fixed by writing it as plain "newline" in prose there instead of a stray
// backtick/backslash-n. New check_common_script_callable_from_part_script (tests/
// run_all.py): the shipped default logs the exact reported message; a person's own
// custom function added to store.batchScriptCode is equally callable (a general
// mechanism, not special-cased to the shipped example); an ordinary part script with
// no batchScriptCode dependency behaves exactly as before -- proven via TEMP BREAK
// reverting the prepend ("CommonScript_Example is not defined"), then reverted.
// DESIGN_DOCUMENT.md SS8 and public/instructions.html updated (a new paragraph next to
// dataAutoFill's own). Full suite 148/148.
// v0.895: direct follow-up, given verbatim: exact lines to add to main() after
// "await BatchScript_RemapExample();" -- an await BatchScript_InsertSmartStreamExample2()
// call, a messageLog(...) reminder naming the exact Smart Check View/Remap settings to
// use, and a return; -- plus an exact replacement for BatchScript_InsertSmartStream2's
// (sic -- BatchScript_InsertSmartStreamExample2's) own conditional "reuse the active
// tab if it's already a freeform canvas" check, swapped for an unconditional
// store.addView('Smart Stream Example 2', 'ff')/createCanvasTab/switchToTab sequence.
// main() now runs BatchScript_InsertSmartStreamExample2 LAST (uncommented, and moved
// from right after the first InsertSmartStreamExample to after RemapExample), and it
// always builds its own SEPARATE "Smart Stream Example 2" view (the 12-type trace, 23
// parts) instead of topping up the first "Smart Stream Example" view (the 7-type
// trace) -- so the two showTypes traces now live on two independent views, and only
// the first ever gets Smart Check View/Remap run on it automatically; the second is
// left exactly as insertSmartStream places it, with main()'s own reminder message
// telling a person which settings to use if they want to Smart Check/Remap it too,
// interactively. check_batch_script_quickstart heavily updated: new streamExample2*
// fields/assertions (view created, 23 parts, single tab, ACTIVE once main() finishes,
// exact reminder text logged) -- proven via TEMP BREAK reverting
// BatchScript_InsertSmartStreamExample2 back to its old conditional-reuse behavior,
// which fails 6 different assertions at once (including corrupting the FIRST view's
// own row count/labels by topping it up instead of building a separate one), then
// reverted. tests/README.md and public/instructions.html (main()'s own five-step
// walkthrough paragraph) updated. Full suite 148/148.
// v0.896: a short design back-and-forth, reported directly: "is it possible to build a
// small framework for user designed remap logic, something that can be loaded in and
// stored in user local settings perhaps. What types of parameter options can be added
// beyond what is already there?" -> (design discussion) -> "can there be an option to
// use grid coordinates based on rows and columns and spacers between, as an alternate
// to the x,y canvas coordinates?" -> (design discussion: convenience layer, resolved
// at remap time, never persisted) -> "yes go with the convenience layer at remap time.
// please build it." New 'custom' Remap pattern (sixth REMAP_PATTERNS entry): a
// function named CustomRemap_<Name>(ctx), written directly in the Script Console's own
// text (store.batchScriptCode) -- the FOURTH such convention that text hosts,
// alongside main()'s BatchScript_<Name> chain, dataAutoFill, and CommonScript_<Name>
// -- picked from a new "Custom Function" dropdown in the Remap dialog once "custom" is
// selected as the Pattern (findCustomRemapFunctionNames, main.js, a pure regex scan).
// applyRemapLayout's new 'custom' branch (commands.js, sitting right after 'clusters',
// same early-return group) extracts and calls the chosen function, passing a ctx with
// this remap's own parts/connectors/nodeSize/spacingScale PLUS a grid-coordinate
// convenience layer -- ctx.gridToXY(row, col), ctx.setRowGap(afterRow, extraPx),
// ctx.setColGap(afterCol, extraPx) (new makeGridResolver helper) -- answering the
// "spacers between" half of the report: extra space after a specific row/column index,
// applied to everything strictly past it, resolved to plain x/y right there and never
// persisted as a grid anywhere else in the app. A returned position may be {vmId, x,
// y} or {vmId, row, col}, freely mixed. Every failure mode (no function selected, not
// found, the function throws, a non-array return) now THROWS a specific Error instead
// of returning null; remap() (commands.js) wraps its applyRemapLayout call in
// try/catch specifically to turn these into a real "Remap failed: ..." toast instead
// of an uncaught exception, leaving every pre-existing null-return failure mode
// unaffected. New CustomRemap_Example(ctx) (state.js) ships as a worked example --
// groups parts onto one row per element type using grid coordinates alone, plus a
// ctx.setRowGap(0, 30) call. customFunctionName round-trips through
// view.remapLastOptions/the cross-view cache/remapPresets exactly like every other
// Remap field. New check_custom_remap_grid_convenience_layer and
// check_custom_remap_dialog (tests/run_all.py) -- the gap boundary semantics
// (afterIdx < idx, not <=) and remap()'s catch-and-toast both proven via TEMP BREAK,
// reverted. DESIGN_DOCUMENT.md SS6.1e, tests/README.md, and public/instructions.html
// (Remap's own pattern list + a new Script Console paragraph) updated. Full suite
// 150/150.
export const APP_VERSION = '0.896';
