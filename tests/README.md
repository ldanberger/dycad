# DyCAD regression suite

A lightweight Playwright-based regression net covering the mechanisms that have
actually broken during development — not exhaustive feature coverage, but the specific
things that are easy to silently break while changing something else nearby.

## Running

```
cd dycad
python3 tests/run_all.py
```

Requires `playwright` (`pip install playwright && playwright install chromium`). The
script starts its own local server on port 8123, runs every check against a fresh page
each, and prints a PASS/FAIL line per check with a short detail message. Exits non-zero
if anything failed.

## What's covered, and why each check exists

| Check | Guards against |
|---|---|
| `check_boots_clean` | Any change breaking the app at load time |
| `check_example_simulates` | The bundled example / simulation engine breaking |
| `check_remap_patterns` | Any of the three Remap patterns (default/none/force) throwing |
| `check_force_directed_no_runaway_drift` | Disconnected components drifting apart without bound (the v0.47 bug — gravity alone didn't fully fix it, the v0.48 cluster-grid redesign did) |
| `check_force_directed_adjacent_cells` | Connected nodes landing merely "closer" instead of truly adjacent grid cells (the v0.49 fix) |
| `check_smart_check_view` | Smart Check missing a fixable gap, failing to note what it created, or not being idempotent on re-run |
| `check_property_panel_field_split` | The v0.52 viewMember-vs-part field separation regressing (e.g. "label" reappearing in the top-level panel) |
| `check_multiselect_shows_entity_level_fields` | A real bug: the multi-select "N items selected" panel built its field list from ONLY viewMember-level showFields (nodes) or ONLY connector-level showFields (connectors), never merging in the other level — so every part-level field (streams, label, description, script, ...) was entirely unavailable when multi-selecting nodes, and every viewMember-level field (fillColor, ...) was entirely unavailable when multi-selecting connectors, regardless of value. Covers both directions and confirms applying a merged field actually updates every selected item's underlying entity |
| `check_catalog_row_copy_includes_all_part_fields` | The Parts Catalog row's Copy button (also what the 3D View's node properties panel uses, via the same catalog-row mechanism) only ever copying a hand-picked handful of fields (Type/Label/Model/Note/Streams) instead of every `showFields.part` field that has a value — verified via the browser's real clipboard API, not a mock |
| `check_generate_industry_place_on_view_defaults_unchecked` | Generate Industry's "Place on current view" checkbox reverting to its old checked-by-default state |
| `check_section_filter` | The new Section filter (toolbar, between Types and Levels — same two places Stream/Type already apply, canvas AND 3D) not listing every distinct `Part.section` value with a `'(no section)'` option last; filtering not actually narrowing the 2D canvas; or `tab.activeSections` not also reaching the 3D scene |
| `check_view3d_section_boundaries` | The 3D View's Section boundary + label (one rectangle outline + billboarded text-sprite label per (type, section) pair actually present, at that type's own Z — mirroring `layoutGridWithSectionBreaks`' existing per-type row-break clustering) drawing a boundary for an unsectioned part (nothing to box around a blank section); a boundary's recorded bounds not actually enclosing its own section's parts (checked by position, not just that a box with *some* bounds exists); or the Section filter failing to also hide non-matching boundaries the same way it hides their parts |
| `check_generate_industry_propagates_section_to_whole_chain` | A real bug: Section used to only ever land on the function-level part (BusinessFunction) a stream generates — every other part in that same stream (capability, application capability, entity, and every passive node) got `section: ''` regardless of the function's own section, so filtering the 3D View (or 2D canvas) to one section only ever showed the lone function node, hiding the entire rest of the chain it belongs to |
| `check_level_down_single_creates_new_part` | A real bug: single-node Level Down (double-click a node with no linked view yet) placed a SECOND viewMember of the SAME part as the new sub-view's own anchor, rather than a genuinely new Part — editing/renaming/retyping the decomposition's own anchor silently edited the summary-level node too, since they were the identical Part. Also confirms the new connectors it creates point at the new part (not reusing the original connectors' identity, which would leave their from/to mismatched against what the view visually shows), and that the original node/connectors up at the parent level stay completely untouched |
| `check_level_down_downstream_external_placed_near_anchor` | Level Down's downstream ("to" side) external neighbor placement reverting to the old fixed x=900 (reported as "placed far right") instead of roughly one node width right of the anchor; also guards the upstream ("from" side) placement (x=20) staying unaffected |
| `check_level_down_creates_composition_link` | Level Down no longer creating the structural 'Composition' connector (parent part -> new decomposition anchor) that Smart Check View/Node rely on to recognize the two levels are related — or that link accidentally getting placed on a view (there's no view showing both levels at once) |
| `check_smart_check_composition_top_down` | A real bug (direct user report): after Level Down, connecting a NEW part to the parent-level part was invisible from the child view — Smart Check View must redirect the parent's connections onto the child anchor and pull the new part in as external, rather than doing nothing, or duplicating the parent itself as a redundant node on its own decomposition view (the other half of the same report). Uses a part with no other connectivity path onto the child view, so this only passes via the proactive composition scan, not organic BFS. Also guards against a self-loop connector being fabricated when the BFS independently rediscovers the Composition link itself |
| `check_smart_check_composition_bottom_up` | The bottom-up half of Smart Check's composition-awareness: a child anchor's connection to a genuinely external part must get mirrored up to the parent, but a connection to a SIBLING (something else composed under the same parent) must NOT — that's purely internal to the decomposition. Per the user's own stated rule |
| `check_smart_check_node_composition_redirect` | The other half of the same user report: Smart Check Node run ON a Level Down anchor not discovering a brand-new connection made to the PARENT part — the anchor and parent are now genuinely different parts, so a plain connectivity walk from the anchor's own id could never reach it without composition-awareness |
| `check_smart_check_sync_with_inventory_checkbox` | Smart Check View/Node's "Sync existing connectors with inventory" checkbox (replaced an earlier automatic, recency-based bidirectional sync that turned out too surprising — see git history) not staying OFF by default, not actually syncing a drifted view connector to match its inventory (parent-level) counterpart when turned ON, or — critically — auto-syncing in EITHER direction when left OFF (no automatic behavior should remain at all) |
| `check_prompt_sync_inventory_connector` | `App.promptSyncInventoryConnector` — hooked into the property panel's Relationship/Streams setters and the on-canvas edge popover — not showing a confirm dialog for a connector with a related "inventory" counterpart, showing one for a connector WITHOUT one (would nag on every ordinary edit), not updating the counterpart on OK, or updating it despite Cancel |
| `check_property_panel_relationship_edit_triggers_sync_prompt` | Same mechanism as above but verifying genuine wiring into the REAL property panel (not just a direct function call) — changing the actual Relationship `<select>` element not triggering the confirm prompt |
| `check_code_summary` | Simulation > Code Summary (a read-only listing of every part's own script, for security review before running an unfamiliar simulation) excluding a DISABLED script instead of still surfacing it (a disabled script could always be re-enabled later, so this must review what code exists, not just what's currently wired to run); a part with no script at all being wrongly included; a script block not identifying its source part (label/type/id) or model; or the modal not actually being read-only (a Save/Cancel pair instead of just Close) |
| `check_spacing_scale_uniform` | The v0.50 bug where edge-adjacent nodes got clamped to 0 during spacing changes, compressing their nearest gap while others scaled normally |
| `check_routing_avoids_obstacle` | Obstacle-avoiding routing silently falling back to a straight line through a blocker |
| `check_archimate_import_fixture` | Junction-bypass placement (v0.44) or nested-shape Composition/Aggregation detection (v0.54) regressing, using a small hand-built fixture covering both in one file |
| `check_timestamps` | createdAt/updatedAt not being set correctly, or touchPart refreshing the wrong field |
| `check_section_drag_title_overlap` | `pixelToNearestGrid`'s hit-test zone for a title-only section using `section.rowCount` directly instead of the actual computed body height, causing it to swallow drops into the top of whichever section immediately follows and reject them |
| `check_section_drag_no_stacking` | Dropping a node onto an already-occupied section cell placing it directly on top, hiding the existing node with no visual sign anything went wrong |
| `check_section_drag_grows_full_section` | A genuinely full section accepting an overlapping placement instead of growing by a row |
| `check_connector_popover_matches_panel` | The canvas edge-click relationship popover listing every relation unconditionally instead of the same from/to-type-filtered subset the property panel's Relationship select already used |
| `check_instructions_tab_on_startup` | The Instructions tab not opening active on startup, its content failing to load, or closing/reopening it via the help button not restoring the same tab |
| `check_import_logs_to_message_log` | ArchiMate import's summary toast not also being written to the Message Log |
| `check_section_rowcount_realigns_nodes` | Changing a section's rowCount/columnCount leaving nodes in later sections at their old pixel position, out of alignment with the shifted section boundaries |
| `check_new_content_sized_and_non_overlapping` | Populate From Template / Generate Industry leaving nodes at the wrong size, or the Redraw command resizing without resolving the overlaps that resize can create |
| `check_smart_check_view_default_levels_unlimited` | Smart Check View's Levels field defaulting to 1 instead of blank (unlimited) |
| `check_force_directed_options` | The force-directed Remap pattern's "prefer right" and "only new row for new group" options not actually changing placement |
| `check_sfce_import_and_generate` | Load SFCE's nested-JSON flattening losing fields, function-level Shared detection failing (a Function repeated across Sections, not a capability split across sections), or Generate Industry leaving the section field unset on generated Function parts |
| `check_generate_industry_no_collapse_keeps_functions_separate` | Two different Generate Industry jobs sharing a stream name (common via the entity-fallback) causing the second shared-Function copy to be silently swallowed into the first, instead of generating its own separate part |
| `check_enterprise_template_is_short_default` | "Enterprise" not being the shortened default template, or "Enterprise Full" (the original) going missing |
| `check_generate_industry_selection_cap` | Generate Industry leaving a small, misleading partial selection after generating well over 100 nodes, instead of clearing it |
| `check_modal_no_close_on_outside_click` | Any dialog closing on a click outside the box instead of only via its own Cancel/Close control |
| `check_dropdown_scrollable` | A dropdown menu growing unbounded instead of being capped with scrolling for a long list |
| `check_sfce_catalog_page` | The SFCCE Catalog page failing to open, or missing rows/columns for the Section/Function/Capability/Application Capability/Entity hierarchy |
| `check_routing_style_per_connector_type` | 'c' and 's' connectors sharing one routing setting instead of independent ones, or "straight line" not producing a genuinely straight (uncurved) path |
| `check_auto_complete_streams_ui` | Smart Check View's Auto-Complete Streams review dialog letting a node be created without its underlying part (Part/View checkbox dependency broken), Proceed creating/skipping the wrong rows, or a skipped middle position getting its two neighbors wrongly bridged with a direct connector |
| `check_streams_field_editable` | Part/Connector's Streams property-panel field silently no-op'ing edits instead of persisting them (access is now "w", parsed as a trimmed comma-separated list) |
| `check_pinned_field_dblclick_not_stolen_by_pin_icon` | A pinned field's 📌 icon being nested inside its label, so a real double-click aimed at the label text lands its second click on the icon instead — toggling the pin and unpinning the row mid-gesture, silently breaking the "double-click to open the larger editor" affordance |
| `check_local_secrets_settings_split` | Local Secrets (API keys) getting cached to localStorage and leaking across a page reload — they must reset every session; or Local Settings' Max Script Entities failing to auto-apply from its localStorage cache after a reload, with no file re-selection needed |
| `check_instructions_closed_persists_across_reload` | Closing the Instructions tab not sticking across a page reload (reopening every session instead of respecting "don't show this again"), or the Help button losing the ability to reopen it on demand |
| `check_load_sfcce` | Load SFCCE's Business-Capability-sharing question being unable to fire because Domain-level resolution already consumed the section diversity it needs to detect (a real bug — fixed via frozen `original*` row fields immune to resolution order), a 2-level-nested field-name collision silently losing data instead of being preserved under a full dot-path field name, Generate Industry producing the wrong element types / ignoring the 'SFCCE' template, or SFCCE's passive entries (BusinessProcess / ApplicationApplication / ApplicationPhysicalComponent, matching Enterprise's) failing to generate |
| `check_stream_template_shared_default` | Picking a Stream Template in one dialog (Remap) not becoming the default selection in every other dialog offering the same picker (Generate Stream, Smart Check View's Auto-Complete Streams), or that shared default not surviving a page reload |
| `check_remap_options_persist_across_views` | Remap's own options (pattern, limit-columns, filtered-only, the two force-directed sub-options, sort priority order) not persisting as user-level defaults onto a brand-new view (or not surviving a page reload) — distinct from `view.remapSortKeys`, which remembers a specific view's own last-used order and still wins once that view has history |
| `check_generate_stream_prepopulates_from_existing` | Generate Stream's Stream Name field failing to prepopulate Function/Capability/Application Capability/Entity Name (and switch to an Application Capability-capable template) when an existing stream name is picked, clearing those fields when a brand-new stream name is typed instead of leaving them alone, or regenerating the same stream creating duplicate parts instead of reusing the existing ones |
| `check_node_size_multiplier` | New views not defaulting to 156x55 (130x46 * the Store's 1.2 nodeSizeMultiplier), Load Local Settings failing to accept/cache a custom nodeSizeMultiplier, or (the real ordering risk) a reload's very first (home) view missing the cached multiplier because it was applied to store.nodeSizeMultiplier only AFTER the Store (and its initial view) was already constructed |
| `check_smart_check_node` | Right-click on a single node failing to open Smart Check Node (or the context menu item not being enabled), wrong checkbox defaults (By Stream + the node's own streams pre-checked, both directions checked, Missing Connectors checked), or — the core behavior — a stream filter that widens once a newly-discovered node's OWN extra streams get pulled in, instead of staying fixed to whatever was picked from the originally selected node |
| `check_view3d_boots` | Explore > 3D View failing to open, opening more than one tab instead of a singleton, any console error while lazy-loading the vendored Three.js/OrbitControls, or (a real bug found while building this) the "Loading 3D view..." placeholder never being cleared before the actual `<canvas>` is appended, leaving it pushed out of view behind the placeholder |
| `check_view3d_layers_and_filters` | Parts not grouped into one InstancedMesh per element type, wrong Z layer order (General/Business/Application/Data, driven by the active stream template's `value[]`), the Stream/Type filters (now wired up for the 3D tab too) not actually reaching the 3D scene, or an unchanged re-render rebuilding every InstancedMesh instead of reusing them (the signature-based skip in `syncSceneData`) — which would be wasteful on every `app.render()` call at real scale |
| `check_view3d_connectors_and_clustering` | Connector lines not drawn between resolved part positions, a connector staying visible after one of its endpoints gets filtered out (should disappear, same convention the 2D canvas already uses), or section-based clustering packing straight across a section boundary instead of forcing a new row — verified with a fixture sized so natural packing and clustering-aware packing would disagree, not just coincidentally produce the same layout either way |
| `check_view3d_cube_order_fallback` | The 3D View's fallback layer order (for an element type outside the active stream template's `value[]`) reverting to `elementGroups`' own (not meaningfully ordered) JSON declaration order instead of using custom.json's hand-authored `cubeOrder` list — verified with the 'Test' template, the one case where the two fallbacks actually disagree on group order rather than coincidentally agreeing |
| `check_view3d_focus_and_zoom_jump` | Focusing a part (via `debugFocusPart`) not setting `focusedPartId`/showing the wireframe highlight marker/showing its own properties in the Properties panel (via `tab.selectedCatalogRow`, the same field the Parts Catalog table's row selection drives — checked by asserting the panel HTML actually contains the part's rendered fields, not just that the state field got set); zooming in past `ZOOM_JUMP_DISTANCE` while focused (via `debugSetCameraDistance`) not jumping to the matching 2D view and selecting the right viewMember; the jump re-firing on every damped-zoom animation frame instead of once per crossing (checked by spying on `app.openOrSwitchView`'s call count, not just resulting state, since a duplicate jump to an already-open view is otherwise indistinguishable from a single one); zooming back out past the threshold failing to re-arm the jump for next time; or a focused part with no view placement anywhere throwing/navigating away instead of continuing to show its own properties |
| `check_view3d_sim_overlay` | The 3D View's simulation overlay markers not using the exact normal/changed/error color palette the 2D canvas's `.fnode-sim-badge` already uses; the wrong part landing in the wrong state's marker mesh; the 'changed' marker's pulse animation not actually varying its scale over real elapsed time (`debugGetSimMarkerScale`); or a part's overlay marker surviving after that part gets filtered out, instead of disappearing along with it |
| `check_view3d_dispose_cancels_current_animation_frame` | A real bug found while building Stage 5: `createInstance` captured `inst.animId` as a one-time snapshot at object-construction time, so it went stale after the very first frame and `disposeInstance`'s `cancelAnimationFrame` cancelled an already-fired id every time instead of the actual pending frame — silently leaking a forever-running render loop on every closed 3D tab. Verified by intercepting the real `requestAnimationFrame`/`cancelAnimationFrame` and confirming the id cancelled at tab-close time is the MOST RECENTLY requested one, not the first |
| `check_view3d_real_click_shows_panel_and_no_recenter` | A real bug found in ALREADY-SHIPPED code: the click listener called `focusPart` but never `selectPartInPanel`, so "click shows properties in the panel" silently never worked for a genuine mouse click — only `debugFocusPart` (the test-only hook, which has its own separate, correct call) exercised it, so the existing hook-only test passed despite the real path being broken. Uses a genuine `page.mouse.click()`, positioned via the new `debugGetScreenPosition` hook (world-to-screen projection, so a real click can target a specific part regardless of layout) — a hook-only test structurally cannot catch this class of drift. Also confirms clicking a node does NOT move `OrbitControls`' own orbit target (no camera recenter) |
| `check_view3d_node_context_menu` | The 3D node right-click context menu (genuine `page.mouse.click(..., button='right')` events) not offering a working "Filter to Streams" quick filter (`tab.activeStreams`) or Connector Type filter (`tab.connectorTypeFilter`: null/'c'/'s' — 3D draws both connectorType 'c' and 's' together by default, unlike the 2D canvas's own per-view checkboxes); verified via a fixture with one 'c' and one 's' connector from the same source part, so switching the filter produces a directly observable, different `connectorCount` |
| `check_view3d_disposed_on_full_document_load` | A real bug: File > Load / Load Example / Recently Opened all replace `store.doc` by wiping `store.tabs` directly rather than closing each tab through `App.closeTab` — the only path that normally disposes a 3D tab's WebGL context/animation loop — so an open 3D tab survived the wipe with its render loop leaking forever in the background. Verified via a genuine File > Load through the real UI, checking that `view3d.js`'s own module-level `instances` map actually drops the old tab's entry (a more direct signal than intercepting `requestAnimationFrame` globally, which can't be pinned to one specific instance without a timing race against Playwright's own file-picker boundary) |
| `check_stream_filter_select_all_exclude_all` | The Stream filter menu's new Select All / Exclude All top-row checkbox (added to match the pre-existing Element Type filter's own version) not toggling `tab.activeStreams` between `null` (unfiltered) and an explicit `[]` (exclude all) — the same convention `passesElementTypeFilter` already used, now shared by both filters instead of the Stream filter's old "empty array means unfiltered, with no way to represent excluding everything" convention |
| `check_sfce_array_field_survives_deeper_nesting` | Load SFCCE's `flattenJsonRecords` silently dropping a multi-value array-of-primitives field (e.g. an Application Capability's own "sections"/"ministries" list) from the mapping wizard's field selector, the moment there's a FURTHER nested array-of-objects field below it (e.g. that same Application Capability's "entities") — a real bug found via a user-generated file (capabilities-legal-SFCCE.json) where "sections" sat above an "entities" nesting; didn't surface with any fixture where the array field was the deepest level |

## Fixtures

`fixtures/mini_archimate.xml` — a minimal ArchiMate 3.0 Exchange Format file, hand-built
specifically for this suite (not derived from any user file), containing:
- A→Junction→B via an AndJunction, to exercise junction flattening + bypass placement.
- A Composition relationship between "Whole" and "Part" represented by nesting "Part"'s
  diagram node inside "Whole"'s, with no explicit `<connection>` element, to exercise
  nested-shape detection.

This is deliberately small and synthetic. It's a fast, stable regression guard for the
*mechanism* — it is not a substitute for testing against a real, complex ArchiMate
export when working on import logic specifically. Real files are what actually
surfaced both of the bugs this fixture now guards against; if you're touching
`js/archimate.js`, re-test against a real file too, not just this fixture.

## Adding a new check

Write a function `check_something(page) -> (bool, str)`:
- `page` is a Playwright page already navigated to the running app (`window.dycadApp`
  is available).
- Do the setup and assertion via a single `js(page, "async () => {...}")` call where
  possible — keeps the check self-contained and fast.
- Return `(True, "short description of what passed")` or `(False, "what was wrong,
  with actual values")`. The detail string is what shows up in the failure output, so
  make it useful without needing to re-run anything by hand.
- Add the function to the `CHECKS` list in `run_all.py`.

Keep each check to one mechanism. A check that verifies five unrelated things makes
failures hard to diagnose — prefer more small checks over fewer large ones.

## What this suite deliberately doesn't do

- No visual/screenshot regression testing — DyCAD's correctness is almost entirely
  structural (data model, layout math, routing geometry), not pixel-level rendering.
- No coverage of every UI dialog end-to-end — a few checks exercise the underlying
  commands directly (faster, more stable) rather than clicking through every modal.
  Where a bug has actually involved the UI wiring itself (e.g. a button's id, a
  checkbox's default state), test that specifically when you touch it, but it doesn't
  need to live in this permanent suite unless it broke once already.
- No CI configuration — there's no build/deploy pipeline for this project yet. This is
  meant to be run manually before/after a change, and extended as new bugs get found
  and fixed, the same way each one already got a Playwright check written for it during
  development — this just keeps those checks around afterward instead of discarding them.
