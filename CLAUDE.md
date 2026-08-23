# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

DyCAD (formerly "FlowRun" — the historical build log still records that under its old
name; see "Rebrand" below) is a single-page, browser-based enterprise architecture modeling and
simulation tool built around ArchiMate concepts, with a "Streams" tagging/pattern-
generation layer on top. Audience is enterprise architects and business analysts, not
developers — keep that in mind for anything user-facing (toasts, labels, the
Instructions tab content).

For the full architectural reference, read `DESIGN_DOCUMENT.md`. For the reasoning
behind why the codebase looks the way it does, read `RECREATION_PROMPT.md` — it's
written as a phase-by-phase build history and calls out several specific, real bugs
that were found and fixed, worth knowing about before touching the same code again.
`js/version.js`'s trailing comments are the authoritative per-release changelog; check
there before assuming something is unintentional.

## Hard constraints — do not violate

- **Vanilla JS/HTML/CSS only.** No frameworks, no npm packages, no build step, no
  bundler, no TypeScript. ES modules (`<script type="module">`) throughout.
- **No backend.** Everything is static files. Data loads via `fetch()` from
  `public/*.json`/`public/*.xml`. The person's own model is saved/loaded as a
  downloaded/uploaded JSON file — there is no server-side persistence.
- Must be served over HTTP (`python3 -m http.server` or equivalent) — `file://` breaks
  the `fetch()` calls to `public/*` due to CORS.

## Running it

```
cd <this directory>
python3 -m http.server 8080
# open http://localhost:8080
```

## Testing

```
python3 tests/run_all.py
```

Starts a local server as a subprocess, drives a real headless Chromium via Playwright,
and asserts on genuine application state (`window.dycadApp`, live `import()` of the
real `js/commands.js`/`js/sfce.js`) — no mocks. `tests/README.md` lists every check and
what real bug each one guards against. **Read `tests/README.md`'s own instructions
before adding a check** — keep each check scoped to one mechanism, and prove a new
check can actually fail (temporarily reintroduce the bug, confirm the failure message
matches, then revert) before trusting it.

**Environment note**: combining a locally-spawned HTTP server subprocess with
Playwright is reliable as a standalone `.py` script file (server + browser logic
co-located, run via `python3 script.py`) but has been unreliable when the identical
logic runs via an inline shell `-c` command instead. If browser-based verification
starts failing for no apparent reason, move it into a script file before assuming the
application code is at fault.

For pure-logic testing with no DOM (fast, no server needed): `state.js`'s `Store` and
most of `commands.js`/`sfce.js` run fine under plain `node --input-type=module` with a
hand-built minimal `app`/`store` — real `settings` loaded from `public/custom.json`,
UI methods (`toast`, `render`, `recordAndRender`) stubbed as no-ops. Anything that
touches `document` or canvas rendering still needs the real Playwright path.

Run the full suite before considering any change done. Add a new permanent check for
any new real bug found, not just for new features.

## Code layout

One module per concern under `js/` — see `DESIGN_DOCUMENT.md` §3 for the full map and
dependency direction. Quick orientation:

- `state.js` — the `Store` (all data), `migrateDoc` (old-save-file compatibility).
- `main.js` — the `App` (all UI-facing methods, dialogs, event wiring, bootstrap).
- `commands.js` — every command (Generate Stream, Remap, Smart Check View, ...).
- `render.js` — schema-driven property panels (`renderShowFieldsPanel`), reads
  `custom.json`'s `showFields` block.
- `canvas.js` — the interactive canvas, node/edge rendering, generic table-tab
  rendering.
- `sections.js`, `layout.js`, `routing.js` — section-view geometry, force-directed
  layout, obstacle-avoiding connector routing, respectively.
- `sfce.js` — pure logic (no DOM) for the SFCE import/generation subsystem.
- `archimate.js` — ArchiMate 3.0 Exchange Format import.
- `simulation.js` — the per-model tick engine.
- `public/custom.json` — the single configuration file driving element types,
  relationships, section/stream templates, and the `showFields` panel schema. Treat as
  data the UI reads, not something an app feature should require hand-editing.

## Conventions to follow

- **New editable field on any entity** (Part/Connector/ViewMember/View/Section): add a
  `showFields` entry in `custom.json` plus a `{get, set}` accessor pair wherever the
  panel is rendered. Don't hand-build a bespoke panel — the schema-driven renderer
  already handles every field type (`t`/`m`/`n`/`y`/`s`).
- **New editable field also needs a `migrateDoc` default** in `state.js` (`?? <default>`)
  so old save files don't break, and usually a `createX(...)` default parameter too.
- **New dialog**: use the shared `.modal-overlay > .modal-box` pattern. It must close
  **only** via its own explicit button — no click-outside-to-close, no Escape-key
  handling. This was deliberately removed once already; don't reintroduce it.
- **New dropdown**: use the shared base dropdown CSS class (already capped at
  `max-height: 70vh; overflow-y: auto`) rather than a one-off style.
- **New tabular report**: populate `tab.tableRows`/`tab.tableCols` (plain objects +
  column-key array) and reuse the existing generic table renderer in `canvas.js`.
  Don't write a new render path for what's fundamentally a table.
- **Rejection/validation messages**: name the specific rule that fired (which section,
  what it actually allows, what the rejected item's type is) — not a generic "that
  didn't work." Route through `app.toast(msg, true)`; error-flagged toasts
  automatically also land in the persistent Message Log, no extra plumbing needed.
- **Bulk/loop operations that call into `commands.js`'s creation functions many times
  into the same growing document**: check whether `createBulkLookupCache` already
  covers the lookups involved before assuming a naive per-call scan is fine — it very
  likely isn't, past a few hundred iterations. See `DESIGN_DOCUMENT.md` §7.2 for the
  specific pattern (opt-in cache parameter, single-call callers unaffected) and why it
  exists.
- **Section-view geometry**: if you touch anything computing a section's height/bounds,
  make sure the hit-test function (`pixelToNearestGrid`) and the layout function
  (`computeSectionLayout`) derive that value from the same place. They diverged once
  before (a title-only section's hit-test zone silently extended into the section
  below it) and it was a real, shipped bug.
- **Test against realistic data at real scale**, not just a small hand-built example,
  for anything performance-sensitive or whose correctness depends on real-world input
  shape. Several real bugs in this codebase's history were only caught that way.

## Known, permanent (non-)issues — don't "fix" these without being asked

- Force-directed Remap can't guarantee every edge in a cycle lands between adjacent
  grid cells — a 2D-embedding limit, not a bug.
- Obstacle-avoiding routing only looks at obstacles near each connector's own path, not
  the whole diagram — intentional, for performance on large views.
- `viewMember.fontColor`/`.fontSize`/`.borderColor` and `view.margin` are fully wired
  as editable fields but never read during rendering — known gap, documented in
  `DESIGN_DOCUMENT.md` §10 and the in-app Instructions tab, not a regression to chase.

## Rebrand note

The product was renamed from "FlowRun" to "DyCAD" partway through this project's
history. As of the cleanup pass that removed the name from live documentation and code,
only two things still deliberately reference the old name, both genuine historical
record rather than something to rewrite: `js/version.js`'s changelog entries describing
past work under the old name, and `RECREATION_PROMPT.md`'s own "Phase 13 — Rebrand"
section, which documents the rename itself as a build phase. Simulation-snapshot file
loading no longer accepts the pre-rebrand format tag — since there were never any real
users, that backward-compat path was removed rather than kept as a safety net; a
snapshot file saved under the old tag is now rejected like any other unrecognized file.
If you're doing a rename-adjacent change, search case-insensitively for the old name
across the whole repo before assuming a grep for the new one is sufficient.
