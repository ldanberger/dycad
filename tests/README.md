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
| `check_sfce_catalog_page` | The SFCE Catalog page failing to open, or missing rows/columns for the Section/Function/Capability/Entity hierarchy |
| `check_routing_style_per_connector_type` | 'c' and 's' connectors sharing one routing setting instead of independent ones, or "straight line" not producing a genuinely straight (uncurved) path |

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
