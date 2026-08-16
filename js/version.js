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
export const APP_VERSION = '0.77';
