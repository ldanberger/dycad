#!/usr/bin/env python3
"""
DyCAD regression suite.

Runs a fixed set of checks against a live instance of the app via Playwright,
covering the mechanisms that have actually broken during development (force-directed
layout drift, Remap patterns, Smart Check View, the property-panel field split,
ArchiMate import's junction/nesting handling, connector routing, and spacing scale).
This is not exhaustive coverage of every feature — it's the regression net for the
things that are easy to silently break while changing something else.

Usage:
    cd dycad
    python3 tests/run_all.py

Requires: playwright (sync API), a Python 3 with `python3 -m http.server` available.
Exits 0 if every check passes, 1 otherwise (so it's CI-friendly even though there's no
CI configured yet).

Adding a new check: write a function `check_something(page) -> (bool, str)` returning
(passed, detail_message), add it to CHECKS below. Keep each check to one mechanism —
small, fast, and easy to tell apart in the failure output.
"""
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 8123

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)


def js(page, script):
    """Runs an async JS snippet in the page and returns the result, raising with full
    console output attached if it throws — makes failures debuggable without re-running
    by hand."""
    return page.evaluate(script)


# ===================== CHECKS =====================
# Each returns (passed: bool, detail: str).

def check_boots_clean(page):
    logs = []
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    page.goto(f"http://localhost:{PORT}/index.html")
    page.wait_for_timeout(1200)
    version = js(page, "async () => { const v = await import('./js/version.js'); return v.APP_VERSION; }")
    if logs:
        return False, f"console errors on boot: {logs}"
    return True, f"booted cleanly, version {version}"


def check_example_simulates(page):
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const sim = await import('./js/simulation.js');
      const res = await fetch('public/examples/right badge chain demo.json', { cache: 'no-store' });
      const obj = await res.json();
      store.loadFromJSON(obj);
      store.tabs = [];
      const homeView = store.findView(store.currentView) || store.doc.views[0];
      const tab = app.createCanvasTab(homeView);
      app.switchToTab(tab.id);
      for (let i = 0; i < 3; i++) sim.stepSimulation(app, store.defaultModel);
      const rt = store.simRuntime.get(store.defaultModel);
      const errors = [...rt.values.values()].filter(v => v.lastError).map(v => v.lastError);
      return { errors };
    }
    """)
    if result["errors"]:
        return False, f"simulation errors: {result['errors']}"
    return True, "bundled example loaded and simulated 3 ticks with no errors"


def check_sim_snapshot_rejects_pre_rebrand_tag(page):
    """Regression guard for a deliberate behavior change, reported directly: "update
    documentation, remove all reference to flowrun" (confirmed explicitly, not
    assumed, that this should extend to dropping the pre-rebrand compat path in
    js/simulation.js's loadSimSnapshot, since the project has no prior users to keep
    backward-compatible). loadSimSnapshot used to accept EITHER 'dycad-sim-snapshot'
    or the pre-rebrand 'flowrun-sim-snapshot' as a valid snapshot file `kind` tag; it
    now accepts only 'dycad-sim-snapshot' — a file saved under the old tag is
    rejected exactly like any other unrecognized file, with the same specific "Not a
    simulation snapshot file" toast. Exercises loadSimSnapshot directly with two
    synthetic File objects, otherwise identical, differing only in `kind`: covers
    that the old-tagged file is rejected (no store.simRuntime entry created, specific
    toast shown) while the current-tagged file still loads correctly (real
    store.simRuntime entry with the snapshot's own tick count, success toast) —
    proving the rejection is specific to the removed tag, not a general regression in
    snapshot loading itself."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const sim = await import('./js/simulation.js');
      const modelName = store.defaultModel;
      const lastToast = () => { const all = document.querySelectorAll('.toast'); return all.length ? all[all.length - 1].textContent : null; };
      const mkFile = (kind, tick) => new File([JSON.stringify({ kind, version: 2, tick, model: modelName, values: {}, log: [] })], 'snap.json', { type: 'application/json' });

      store.simRuntime.delete(modelName);
      await sim.loadSimSnapshot(app, modelName, mkFile('flowrun-sim-snapshot', 99));
      const oldTagRejectedToast = lastToast();
      const oldTagRuntimeCreated = store.simRuntime.has(modelName);

      await sim.loadSimSnapshot(app, modelName, mkFile('dycad-sim-snapshot', 7));
      const newTagToast = lastToast();
      const newTagTick = store.simRuntime.get(modelName)?.tick;

      return { oldTagRejectedToast, oldTagRuntimeCreated, newTagToast, newTagTick };
    }
    """)
    problems = []
    if not result["oldTagRejectedToast"] or "not a simulation snapshot" not in result["oldTagRejectedToast"].lower():
        problems.append(f"expected the pre-rebrand 'flowrun-sim-snapshot' tag to be rejected with a specific 'Not a simulation snapshot file' toast, got {result['oldTagRejectedToast']!r}")
    if result["oldTagRuntimeCreated"]:
        problems.append("expected the rejected old-tagged file to create NO simRuntime entry")
    if not result["newTagToast"] or "loaded" not in result["newTagToast"].lower():
        problems.append(f"expected the current 'dycad-sim-snapshot' tag to still load successfully, got toast {result['newTagToast']!r}")
    if result["newTagTick"] != 7:
        problems.append(f"expected the successfully-loaded snapshot's own tick count (7) to land in store.simRuntime, got {result['newTagTick']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "loadSimSnapshot now rejects the pre-rebrand 'flowrun-sim-snapshot' tag with a specific toast and creates no runtime entry, while the current 'dycad-sim-snapshot' tag still loads correctly"


def check_remap_patterns(page):
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const view = store.addView('RegrRemap_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      commands.createStream(app, {
        templateName: 'Enterprise', streamName: 'RegrStream',
        functionName: 'RegrFunc', capabilityName: 'RegrCap', entityName: 'RegrEnt',
        modelName: store.defaultModel, viewName: view.id, silent: true,
      });
      const results = {};
      for (const pattern of ['default', 'none', 'layered', 'force', 'clusters']) {
        results[pattern] = !!commands.applyRemapLayout(app, view.id, { pattern });
      }
      return results;
    }
    """)
    failed = [p for p, ok in result.items() if not ok]
    if failed:
        return False, f"patterns failed: {failed}"
    return True, "default/none/layered/force/clusters Remap patterns all completed"


def check_remap_layered_pattern(page):
    """Regression guard for applyRemapLayout's pattern:'layered' option and its
    computeLayerAssignment helper (commands.js) -- the row-assignment rule follows
    directed graph structure (hop-distance from a root) instead of element-group/stream
    membership. Reported directly, given the "Smart Stream Example" script data: "The
    cleanest result ... would be (in a 4 x 4 grid): General Actor ...; Business
    Function Production; empty; General Actor ...  Row 2: Business Capability ...;
    Business Process ...; Business Process ...; Business Capability ... Row 3: ...
    Application Capability ... Row 4: Data Entity ... Is there any algorithm ... that
    could result in this layout?" -- confirmed "yes" to building it. The real data's
    Business Capability and Business Process types are directly connected by a real
    edge (Capability -> Process) AND each is also reachable from a topmost root via its
    OWN direct edge (Actor -> Capability, Function -> Process) -- so the core design
    decision this test exists to prove is SHORTEST-path layering (a node's row is the
    FEWEST hops any real edge justifies), not longest-path/topological-sort layering:
    the latter would obey the Capability -> Process edge as a hard constraint and push
    Process one row below Capability, splitting a pair the user wanted on the SAME row.
    Fixture mirrors that exact shape with generic types: two roots (X, Y) each with
    their own direct edge to a distinct middle node (M via X, N via Y), plus a genuine
    N -> M edge (so M is ALSO reachable the long way, via N) -- shortest-path layering
    must still place M and N on the SAME row (both 1 hop from a root), while
    longest-path layering would incorrectly split them. Also proves robustness against
    DyCAD's dual-connector convention (a real, common 2-node cycle: both M -> N and N
    -> M existing as separate connectors) -- BFS's "already visited" check makes a
    later, longer edge back into an already-layered node a no-op, so this must complete
    without hanging or producing a nonsensical result. Finally confirms Edge
    Assignment, Minimize Crossings, and Minimize Connector Length -- all pre-existing
    options -- still function normally with pattern:'layered' (unlike 'force', which
    ignores them; see check_remap_edge_assignment_and_layout_optimization)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const mk = (type, label) => store.createPart({ type, label, model, streams: [] });
      const conn = (from, to) => store.createConnector({ from: from.id, to: to.id, connectorType: 'c', model, relationship: 'Association' });
      const freshView = () => {
        const view = store.addView('RegrLayered_' + Date.now(), 'ff');
        const tab = app.createCanvasTab(view);
        app.switchToTab(tab.id);
        return { view, tab };
      };
      const place = (view, parts, conns) => {
        const vmByPart = new Map();
        for (const p of parts) { const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: p.id, x: 0, y: 0 }); vmByPart.set(p.id, vm); }
        for (const c of conns) { store.createViewMember({ view: view.id, objectType: 'connector', objectId: c.id, fromVmId: vmByPart.get(c.from).id, toVmId: vmByPart.get(c.to).id }); }
        return vmByPart;
      };
      const rowsOf = (view, vmByPart, parts) => {
        const vms = store.viewMembersForView(view.id).filter(v => v.objectType === 'part');
        const byId = new Map(vms.map(v => [v.id, v]));
        return Object.fromEntries(parts.map(p => [p.label, Math.round(byId.get(vmByPart.get(p.id).id).y)]));
      };

      // --- Fixture 1: shortest-path proof, plain DAG (no cycle) ---
      const { view: v1 } = freshView();
      const x = mk('BusinessFunction', 'RootX'), y = mk('GeneralActor', 'RootY');
      const m = mk('BusinessProcess', 'M'), n = mk('BusinessCapability', 'N');
      const c1 = conn(x, m), c2 = conn(y, n), c3 = conn(n, m); // N -> M: the "long path" edge
      const vmByPart1 = place(v1, [x, y, m, n], [c1, c2, c3]);
      commands.applyRemapLayout(app, v1.id, { pattern: 'layered', sortKeys: ['nodeLabel'] });
      const rows1 = rowsOf(v1, vmByPart1, [x, y, m, n]);

      // --- Fixture 2: same shape, but with the reciprocal edge too (dual-connector
      // convention: a genuine 2-node cycle between M and N) ---
      const { view: v2 } = freshView();
      const x2 = mk('BusinessFunction', 'RootX'), y2 = mk('GeneralActor', 'RootY');
      const m2 = mk('BusinessProcess', 'M'), n2 = mk('BusinessCapability', 'N');
      const d1 = conn(x2, m2), d2 = conn(y2, n2), d3 = conn(n2, m2), d4 = conn(m2, n2); // both directions
      const vmByPart2 = place(v2, [x2, y2, m2, n2], [d1, d2, d3, d4]);
      let cycleThrew = false, cycleErr = '';
      try {
        commands.applyRemapLayout(app, v2.id, { pattern: 'layered', sortKeys: ['nodeLabel'] });
      } catch (e) { cycleThrew = true; cycleErr = e.message; }
      const rows2 = rowsOf(v2, vmByPart2, [x2, y2, m2, n2]);

      // --- Fixture 3: Edge Assignment + Minimize Crossings + Minimize Connector Length
      // all combined with pattern:'layered' -- just needs to run without error and
      // actually pin the assigned type to its single band. ---
      const { view: v3 } = freshView();
      const x3 = mk('BusinessFunction', 'RootX3'), m3 = mk('BusinessProcess', 'M3'), e3 = mk('DataDataEntity', 'E3');
      const c31 = conn(x3, m3), c32 = conn(m3, e3);
      const vmByPart3 = place(v3, [x3, m3, e3], [c31, c32]);
      let optionsThrew = false, optionsErr = '';
      try {
        commands.applyRemapLayout(app, v3.id, {
          pattern: 'layered', sortKeys: ['nodeLabel'],
          edgeAssignment: { DataDataEntity: 'bottom' },
          minimizeCrossings: true, minimizeConnectorLength: true,
        });
      } catch (e) { optionsThrew = true; optionsErr = e.message; }
      const vms3 = store.viewMembersForView(v3.id).filter(v => v.objectType === 'part');
      const eVm = vms3.find(v => store.findPart(v.objectId).id === e3.id);
      const others3 = vms3.filter(v => v.id !== eVm.id);
      const entityAtBottom = others3.every(v => v.y < eVm.y);

      return { rows1, rows2, cycleThrew, cycleErr, optionsThrew, optionsErr, entityAtBottom };
    }
    """)
    problems = []
    r1 = result["rows1"]
    if r1["RootX"] != r1["RootY"]:
        problems.append(f"expected both roots on the same (topmost) row, got RootX={r1['RootX']} RootY={r1['RootY']}")
    if r1["M"] != r1["N"]:
        problems.append(f"shortest-path layering should place M and N on the SAME row (both 1 hop from a root) despite the real N -> M edge -- longest-path layering would incorrectly split them; got M={r1['M']} N={r1['N']}")
    if r1["M"] <= r1["RootX"]:
        problems.append(f"expected M/N strictly below the roots' row, got roots={r1['RootX']} M={r1['M']}")
    if result["cycleThrew"]:
        problems.append(f"pattern:'layered' threw on a genuine 2-node cycle (dual-connector convention): {result['cycleErr']}")
    r2 = result["rows2"]
    if r2["M"] != r2["N"]:
        problems.append(f"with the reciprocal M<->N edge added, expected the same same-row result as the acyclic fixture, got M={r2['M']} N={r2['N']}")
    if result["optionsThrew"]:
        problems.append(f"Edge Assignment + Minimize Crossings + Minimize Connector Length threw with pattern:'layered': {result['optionsErr']}")
    if not result["entityAtBottom"]:
        problems.append("expected edgeAssignment: {DataDataEntity: 'bottom'} to still pin the entity to the single bottommost row with pattern:'layered'")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "pattern:'layered' uses shortest-path (not longest-path) layering, handles a genuine 2-node cycle without error, and still honors Edge Assignment/Minimize Crossings/Minimize Connector Length"


def check_remap_crossing_minimization_finds_global_optimum(page):
    """Regression guard for minimizeRowCrossings (commands.js) -- shared by the
    'default'/'none'/'layered' patterns' Minimize Crossings option. Reported directly,
    after already trying every minimizeCrossings/minimizeConnectorLength on/off
    combination without success: "did not produce desired result. Note turning both
    off results in connectors behind nodes ... manually editing is not desired option
    due to volume of views." Root cause diagnosed via hand-computed crossing counts on
    the actual reported data: the OLD algorithm (single downward-first barycenter sweep
    + one transpose pass, scoring only INTER-row edge length) could converge to an
    ordering that's genuinely tied on raw crossing count with a better one, then never
    discover or prefer the better tie -- specifically Business Function (connects to
    BOTH Business Processes below) left at one END of its row instead of centered
    between them, and Business Capability/Business Process (a same-row pair once
    'layered' merges them onto one row -- see computeLayerAssignment) stretched apart
    into a "grouped" CC-PP order instead of the shorter-overall "interleaved" CPPC
    order, because scoring only counted INTER-row length and never the real, same-row
    Capability -> Process edge's own length. Fixed three ways: (1) minimizeRowCrossings
    now runs the full barycenter+transpose search from TWO starting points (downward-
    first and upward-first) and keeps whichever converges better, since a single
    starting direction can get stuck in a local optimum reachable only from the other;
    (2) its scoring now includes INTRA-row edge length (previously only inter-row); (3)
    ties on raw crossing count are broken by (now-complete) total length. Fixture is
    the EXACT real topology from the reported "Smart Stream Example" data (hand-built
    directly via createPart/createConnector -- not the full generateIndustry/
    insertSmartStream pipeline, so this runs in milliseconds and doesn't depend on the
    "general" industry dataset staying the same shape), confirmed via direct diagnostic
    testing to reproduce the bug against the OLD algorithm with these exact sortKeys
    (BatchScript_RemapExample's own) — a synthetic 2- and 3-row generic fixture tried
    first was NOT sufficient to reproduce it (this exact 4-row depth, with the middle
    row pulled from both above AND below simultaneously, is what actually matters)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const mk = (type, label) => store.createPart({ type, label, model, streams: [] });
      const conn = (from, to, relationship) => store.createConnector({ from: from.id, to: to.id, connectorType: 'c', model, relationship });

      const view = store.addView('RegrCrossTiebreak_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const fn = mk('BusinessFunction', 'Production');
      const actorMfg = mk('GeneralActor', 'Manufacturing Operations Consumer');
      const actorProd = mk('GeneralActor', 'Production Planning Consumer');
      const capMfg = mk('BusinessCapability', 'Manage Manufacturing Operations');
      const capProd = mk('BusinessCapability', 'Manage Production Planning');
      const procMfg = mk('BusinessProcess', 'Manufacturing Operations Process');
      const procProd = mk('BusinessProcess', 'Production Planning Process');
      const appMfg = mk('ApplicationCapability', 'Manage Manufacturing Operations');
      const appProd = mk('ApplicationCapability', 'Manage Production Planning');
      const entBom = mk('DataDataEntity', 'Bill of Materials');
      const entSchedule = mk('DataDataEntity', 'Production Schedule');
      const entDemand = mk('DataDataEntity', 'Demand Forecast');

      const conns = [
        conn(fn, procMfg, 'Realization'), conn(fn, procProd, 'Realization'),
        conn(capMfg, procMfg, 'Realization'), conn(capProd, procProd, 'Realization'),
        conn(procMfg, appMfg, 'Association'), conn(procProd, appProd, 'Association'),
        conn(appMfg, entSchedule, 'Realization'), conn(appMfg, entBom, 'Realization'),
        conn(appProd, entSchedule, 'Realization'), conn(appProd, entDemand, 'Realization'),
        conn(actorMfg, capMfg, 'Flow'), conn(actorProd, capProd, 'Flow'),
      ];
      const vmByPart = new Map();
      const allParts = [fn, actorMfg, actorProd, capMfg, capProd, procMfg, procProd, appMfg, appProd, entBom, entSchedule, entDemand];
      for (const p of allParts) vmByPart.set(p.id, store.createViewMember({ view: view.id, objectType: 'part', objectId: p.id, x: 0, y: 0 }));
      for (const c of conns) store.createViewMember({ view: view.id, objectType: 'connector', objectId: c.id, fromVmId: vmByPart.get(c.from).id, toVmId: vmByPart.get(c.to).id });

      // Exact sortKeys BatchScript_RemapExample uses -- confirmed via direct testing
      // to be the specific starting order that exposed the bug.
      commands.applyRemapLayout(app, view.id, {
        pattern: 'layered', minimizeCrossings: true,
        sortKeys: ['connectionOrder', 'streamOrder', 'streamName', 'entityType', 'nodeLabel', 'elementGroup'],
      });

      const vms = store.viewMembersForView(view.id).filter(v => v.objectType === 'part');
      const byLabel = {};
      for (const vm of vms) {
        const part = store.findPart(vm.objectId);
        byLabel[part.type + ':' + part.label] = { x: vm.x, y: Math.round(vm.y) };
      }
      const row0 = ['GeneralActor:Manufacturing Operations Consumer', 'BusinessFunction:Production', 'GeneralActor:Production Planning Consumer']
        .sort((a, b) => byLabel[a].x - byLabel[b].x);
      const row1 = ['BusinessCapability:Manage Manufacturing Operations', 'BusinessProcess:Manufacturing Operations Process', 'BusinessProcess:Production Planning Process', 'BusinessCapability:Manage Production Planning']
        .sort((a, b) => byLabel[a].x - byLabel[b].x);
      const rowCount = new Set(Object.values(byLabel).map(p => p.y)).size;
      return { row0, row1, rowCount };
    }
    """)
    fn_key = 'BusinessFunction:Production'
    problems = []
    if result["rowCount"] != 4:
        problems.append(f"expected exactly 4 rows, got {result['rowCount']}")
    if result["row0"][1] != fn_key:
        problems.append(f"expected Business Function centered in row 0 (between the two General Actors), got {result['row0']}")
    mfg_cap, mfg_proc = 'BusinessCapability:Manage Manufacturing Operations', 'BusinessProcess:Manufacturing Operations Process'
    prod_cap, prod_proc = 'BusinessCapability:Manage Production Planning', 'BusinessProcess:Production Planning Process'
    interleaved_options = [
        [mfg_cap, mfg_proc, prod_proc, prod_cap], [prod_cap, prod_proc, mfg_proc, mfg_cap],
    ]
    if result["row1"] not in interleaved_options:
        problems.append(f"expected row 1 interleaved as Capability/Process/Process/Capability (mirror-symmetric), got {result['row1']} -- a 'grouped' Capability/Capability/Process/Process order means the intra-row-length tie-break regressed")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "minimizeRowCrossings' two-start search + intra-row-length tie-break correctly centers Business Function between its two Processes and interleaves Business Capability/Process instead of grouping them, on the exact real 'Smart Stream Example' topology and sortKeys"


def check_remap_layered_avoids_node_occlusion(page):
    """Regression guard for minimizeRowCrossings' new `occlusions` scoring criterion
    (commands.js), direct follow-up to check_remap_crossing_minimization_finds_global_
    optimum above (same file/topology, different failure mode). Reported directly:
    "smart stream example from script console is directly placing nodes over
    connectors instead of resizing to fit properly after remap. why? what remap
    settings are needed to avoid this?" Diagnosed via the REAL generateIndustry ->
    insertSmartStream -> smartCheckView -> remap pipeline (not the hand-built synthetic
    fixture the sibling check above uses -- that fixture's extra connectors happen to
    already score the interleaved order best on crossings alone, so it never exposed
    this): 'layered' puts a Business Capability and its own Business Process on the
    same row (equidistant from a root) with a real same-row connector between them:
    the OLD scoring (crossings first, intra-row length only as a tie-break) locked in
    a column order -- Process, Process, Capability, Capability -- that's genuinely
    BETTER on cross-row crossings than the interleaved alternative, so the tie-break
    never even got a chance to run; the Capability -> Process same-row connector then
    drew a straight line directly through the OTHER pair's Process node sitting between
    them. No existing Remap setting (Minimize Crossings, Minimize Connector Length,
    Edge Assignment, Spacing Scale) avoided this -- it's a genuine scoring gap, not a
    missing checkbox. Fixed by adding `occlusions` (how many row members sit strictly
    between a same-row edge's two endpoint columns) as a NEW criterion checked before
    crossings, in both the local swap heuristic (transposeAll) and the final
    best-of-all-iterations comparison (isBetter) -- accepting a real crossing increase
    is worth it to eliminate a node sitting directly on a connector, since that's a far
    more visible defect than a diagonal line crossing. Runs the real pipeline directly
    (generateIndustry/insertSmartStream/smartCheckView/applyRemapLayout, not through
    the Script Console UI, for speed) with BatchScript_RemapExample's own exact
    options, then checks EVERY connector's straight-line path against EVERY other
    node's bounding box for genuine geometric intersection (a small inward padding so
    mere edge-touching at a box's boundary isn't flagged) -- not just the specific
    Capability/Process pair the bug happened to hit, so any future regression of the
    same shape (any same-row edge landing on top of any other row member) is caught
    too."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const canvas = await import('./js/canvas.js');

      await commands.generateIndustry(app, null, false);
      const view = store.addView('RegrOcclusion_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const start = store.doc.parts.find(p => p.type === 'BusinessFunction' && p.label === 'Production');
      commands.insertSmartStream(app, tab, {
        connectorType: 's', startPartIds: [start.id], direction: 'both', endType: 'DataDataEntity', levels: null,
        showTypes: ['ApplicationCapability', 'BusinessFunction', 'BusinessProcess', 'BusinessCapability', 'DataDataEntity', 'GeneralActor', 'TechnologyLogicalComponent'],
      });
      commands.smartCheckView(app, tab, { missingConnectors: true, deriveConnectors: true });
      commands.remap(app, tab, {
        templateName: 'Enterprise', pattern: 'layered', minimizeCrossings: true, minimizeConnectorLength: true,
        sortKeys: ['connectionOrder', 'streamOrder', 'streamName', 'entityType', 'nodeLabel', 'elementGroup'],
      });

      const partVms = store.viewMembersForView(view.id).filter(v => v.objectType === 'part');
      const connVms = store.viewMembersForView(view.id).filter(v => v.objectType === 'connector');
      const { w, h } = canvas.getNodeSize(view);
      const nodeById = new Map(partVms.map(vm => [vm.id, vm]));

      const segIntersectsRect = (x1, y1, x2, y2, rx, ry, rw, rh) => {
        let t0 = 0, t1 = 1;
        const dx = x2 - x1, dy = y2 - y1;
        const p = [-dx, dx, -dy, dy];
        const q = [x1 - rx, rx + rw - x1, y1 - ry, ry + rh - y1];
        for (let i = 0; i < 4; i++) {
          if (p[i] === 0) { if (q[i] < 0) return false; continue; }
          const r = q[i] / p[i];
          if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
          else { if (r < t0) return false; if (r < t1) t1 = r; }
        }
        return true;
      };

      const overlaps = [];
      for (const cv of connVms) {
        const fromVm = nodeById.get(cv.fromVmId), toVm = nodeById.get(cv.toVmId);
        if (!fromVm || !toVm) continue;
        const x1 = fromVm.x + w / 2, y1 = fromVm.y + h / 2;
        const x2 = toVm.x + w / 2, y2 = toVm.y + h / 2;
        for (const vm of partVms) {
          if (vm.id === fromVm.id || vm.id === toVm.id) continue;
          const pad = 4;
          if (segIntersectsRect(x1, y1, x2, y2, vm.x + pad, vm.y + pad, w - 2 * pad, h - 2 * pad)) {
            overlaps.push({ from: store.findPart(fromVm.objectId)?.label, to: store.findPart(toVm.objectId)?.label, through: store.findPart(vm.objectId)?.label });
          }
        }
      }

      return { overlapsCount: overlaps.length, overlaps, partCount: partVms.length };
    }
    """)
    if result["overlapsCount"] != 0:
        return False, f"expected zero connectors passing through an unrelated node's box after 'layered' remap with Minimize Crossings on, got {result['overlapsCount']}: {result['overlaps']} (full: {result})"
    if result["partCount"] < 8:
        return False, f"test setup itself is wrong -- expected the real Smart Stream Example trace to place at least 8 parts, got {result['partCount']}"
    return True, "'layered' remap with Minimize Crossings on produces zero connectors passing through an unrelated node's box, on the real generateIndustry/insertSmartStream/smartCheckView pipeline that originally reported this"


def check_custom_remap_grid_convenience_layer(page):
    """New-feature check for the 'custom' Remap pattern (commands.js's
    applyRemapLayout), reported directly across a short back-and-forth: "is it
    possible to build a small framework for user designed remap logic, something that
    can be loaded in and stored in user local settings perhaps" -> (answered: reuse the
    Script Console's own text/persistence, a new CustomRemap_<Name>(ctx) naming
    convention) -> "can there be an option to use grid coordinates based on rows and
    columns and spacers between, as an alternate to the x,y canvas coordinates?" ->
    (answered: yes, as a pure convenience layer resolved to x/y at remap time, never
    persisted as a grid) -> "yes go with the convenience layer at remap time. please
    build it." Exercises applyRemapLayout/remap directly (commands.js), covering: (1)
    the shipped CustomRemap_Example groups parts onto one row per element TYPE using
    grid coordinates alone (no pixel math in the function itself), with its own
    ctx.setRowGap(0, 30) call actually widening the gap after row 0; (2) a custom
    function can freely MIX explicit {vmId, x, y} and grid {vmId, row, col} entries in
    one returned array, and ctx.setColGap's "applies to every column PAST the given
    index, last call wins" semantics are exactly right (col 0 itself unaffected by
    setColGap(0, ...), col 1 shifted by the full extra amount); (3) four distinct
    failure modes -- no customFunctionName given, a name not found in
    store.batchScriptCode, the named function itself throwing, and the named function
    returning something other than an array -- each throw a SPECIFIC, distinguishable
    error message from applyRemapLayout directly, not a generic failure; (4) remap()
    (the dialog/script-facing wrapper) catches any of those and reports them via a
    real toast ("Remap failed: ...") instead of leaving them as an uncaught exception,
    proven via TEMP BREAK removing remap()'s own try/catch (which then throws instead
    of toasting), then reverted."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;

      const view = store.addView('CustomRemapUnit_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const a = store.createPart({ type: 'GeneralActor', label: 'A', model, streams: [] });
      const b = store.createPart({ type: 'BusinessFunction', label: 'B', model, streams: [] });
      const c = store.createPart({ type: 'BusinessFunction', label: 'C', model, streams: [] });
      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: a.id, x: 0, y: 0 });
      const vmB = store.createViewMember({ view: view.id, objectType: 'part', objectId: b.id, x: 0, y: 0 });
      const vmC = store.createViewMember({ view: view.id, objectType: 'part', objectId: c.id, x: 0, y: 0 });

      // 1) shipped CustomRemap_Example: BusinessFunction row (alphabetically before
      // GeneralActor) gets B, C (sorted by label); GeneralActor row gets A -- with an
      // extra 30px gap below row 0.
      commands.remap(app, tab, { pattern: 'custom', customFunctionName: 'CustomRemap_Example' });
      const exampleRowY = { a: vmA.y, b: vmB.y, c: vmC.y };
      const exampleSameRow = vmB.y === vmC.y;
      const exampleRowGap = vmA.y - vmB.y; // row 1 - row 0, should include the +30 extra

      // Baseline gap (no setRowGap) for comparison, using a fresh throwaway pair.
      store.batchScriptCode = store.batchScriptCode + `
        function CustomRemap_NoGap(ctx) {
          const out = [];
          for (const p of ctx.parts) out.push({ vmId: p.vmId, row: p.label === 'A' ? 1 : 0, col: 0 });
          return out;
        }
      `;
      commands.remap(app, tab, { pattern: 'custom', customFunctionName: 'CustomRemap_NoGap' });
      const baselineRowGap = vmA.y - vmB.y;

      // 2) mixed x/y + row/col, and setColGap boundary semantics.
      store.batchScriptCode = store.batchScriptCode + `
        function CustomRemap_Mixed(ctx) {
          ctx.setColGap(0, 100);
          const out = [];
          for (const p of ctx.parts) {
            if (p.label === 'A') out.push({ vmId: p.vmId, x: 999, y: 888 });
            if (p.label === 'B') out.push({ vmId: p.vmId, row: 0, col: 0 });
            if (p.label === 'C') out.push({ vmId: p.vmId, row: 0, col: 1 });
          }
          return out;
        }
      `;
      commands.remap(app, tab, { pattern: 'custom', customFunctionName: 'CustomRemap_Mixed' });
      const mixed = { ax: vmA.x, ay: vmA.y, bx: vmB.x, cx: vmC.x };

      // 3) four distinct failure modes, straight from applyRemapLayout.
      const errors = {};
      try { commands.applyRemapLayout(app, view.id, { pattern: 'custom' }); } catch (e) { errors.noName = e.message; }
      try { commands.applyRemapLayout(app, view.id, { pattern: 'custom', customFunctionName: 'NoSuchFn' }); } catch (e) { errors.notFound = e.message; }
      store.batchScriptCode = store.batchScriptCode + `function CustomRemap_Throws(ctx) { throw new Error('boom'); }`;
      try { commands.applyRemapLayout(app, view.id, { pattern: 'custom', customFunctionName: 'CustomRemap_Throws' }); } catch (e) { errors.threw = e.message; }
      store.batchScriptCode = store.batchScriptCode + `function CustomRemap_BadReturn(ctx) { return 'nope'; }`;
      try { commands.applyRemapLayout(app, view.id, { pattern: 'custom', customFunctionName: 'CustomRemap_BadReturn' }); } catch (e) { errors.badReturn = e.message; }

      // 4) remap() wrapper catches and toasts instead of throwing.
      let remapThrew = false;
      try { commands.remap(app, tab, { pattern: 'custom', customFunctionName: 'NoSuchFn2' }); } catch (e) { remapThrew = true; }
      await new Promise(r => setTimeout(r, 60));
      const toasts = [...document.querySelectorAll('.toast')];
      const lastToast = toasts.length ? toasts[toasts.length - 1].textContent : null;

      return { exampleRowY, exampleSameRow, exampleRowGap, baselineRowGap, mixed, errors, remapThrew, lastToast };
    }
    """)
    problems = []
    if not result["exampleSameRow"]:
        problems.append(f"expected CustomRemap_Example to put both BusinessFunction parts on the SAME row (grid col 0/1), got y values {result['exampleRowY']}")
    if result["exampleRowGap"] <= result["baselineRowGap"]:
        problems.append(f"expected CustomRemap_Example's ctx.setRowGap(0, 30) to make row 1 sit further from row 0 than the no-gap baseline, got exampleRowGap={result['exampleRowGap']} baselineRowGap={result['baselineRowGap']}")
    m = result["mixed"]
    if m["ax"] != 999 or m["ay"] != 888:
        problems.append(f"expected an explicit {{x,y}} entry to be used verbatim, got A at ({m['ax']},{m['ay']})")
    if m["bx"] != 60:
        problems.append(f"expected col 0 to be UNAFFECTED by setColGap(0, 100) (gap applies strictly PAST the given index), got B at x={m['bx']}")
    expected_col_gap_effect = m["cx"] - m["bx"]
    if expected_col_gap_effect <= 100:
        problems.append(f"expected col 1 to be shifted by its normal step PLUS the full 100px gap (since 0 < 1), got C-B x distance = {expected_col_gap_effect}")
    e = result["errors"]
    if "selected" not in (e.get("noName") or ""):
        problems.append(f"expected a specific 'no custom remap function selected' error when customFunctionName is omitted, got {e.get('noName')!r}")
    if "NoSuchFn" not in (e.get("notFound") or ""):
        problems.append(f"expected a specific 'no function named ... found' error for an unknown function name, got {e.get('notFound')!r}")
    if "boom" not in (e.get("threw") or ""):
        problems.append(f"expected the custom function's own thrown error message to propagate, got {e.get('threw')!r}")
    if "array" not in (e.get("badReturn") or ""):
        problems.append(f"expected a specific 'must return an array' error when the custom function returns something else, got {e.get('badReturn')!r}")
    if result["remapThrew"]:
        problems.append("expected remap() to catch a custom-pattern error itself, not let it propagate as an uncaught exception")
    if not result["lastToast"] or "Remap failed" not in result["lastToast"]:
        problems.append(f"expected remap() to report the custom-pattern error via a real toast starting with 'Remap failed:', got {result['lastToast']!r}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "the 'custom' Remap pattern's grid-coordinate convenience layer (ctx.gridToXY/setRowGap/setColGap) resolves correctly, mixes freely with explicit x/y, and all four of its distinct failure modes are caught by remap() and reported via a specific toast instead of an uncaught exception"


def check_custom_remap_dialog(page):
    """UI-level companion to check_custom_remap_grid_convenience_layer, above (same
    report) — covers the actual Remap dialog wiring that check bypasses. Covers: (1)
    'custom' appears in the Pattern dropdown and, once selected, reveals a Custom
    Function dropdown populated from every CustomRemap_<Name> function found in
    store.batchScriptCode (including the shipped CustomRemap_Example) while hiding
    Sort priority/Edge Assignment/Minimize Crossings/Minimize Connector Length — same
    "the function owns placement completely" treatment force-directed/clusters already
    get; (2) submitting with CustomRemap_Example selected actually repositions the
    view's nodes (not a no-op); (3) view.remapLastOptions.customFunctionName persists
    the choice, and reopening Remap on the SAME view later pre-selects both the
    'custom' pattern and that exact function again -- the same "this view's own last
    choice wins" precedent every other Remap field already follows."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;

      const view = store.addView('CustomRemapDialog_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const a = store.createPart({ type: 'GeneralActor', label: 'DialogA', model, streams: [] });
      const b = store.createPart({ type: 'BusinessFunction', label: 'DialogB', model, streams: [] });
      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: a.id, x: 5, y: 5 });
      const vmB = store.createViewMember({ view: view.id, objectType: 'part', objectId: b.id, x: 5, y: 5 });
      const beforeX = { a: vmA.x, b: vmB.x };

      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 60));
      const box = document.querySelector('.modal-box');
      const patternSelect = box.querySelector('#rm-pattern');
      const hasCustomOption = [...patternSelect.options].some(o => o.value === 'custom');
      patternSelect.value = 'custom';
      patternSelect.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 30));

      const fnRowVisible = !box.querySelector('#rm-custom-function-row').classList.contains('hidden');
      const priorityHidden = box.querySelector('#rm-priority-section').classList.contains('hidden');
      const edgeHidden = box.querySelector('#rm-edge-section').classList.contains('hidden');
      const minimizeCrossingsHidden = box.querySelector('#rm-minimize-crossings-row').classList.contains('hidden');
      const fnSelect = box.querySelector('#rm-custom-function');
      const hasExampleOption = [...fnSelect.options].some(o => o.value === 'CustomRemap_Example');
      fnSelect.value = 'CustomRemap_Example';

      box.querySelector('.submit').click();
      await new Promise(r => setTimeout(r, 60));
      const afterX = { a: vmA.x, b: vmB.x };
      const movedSomething = afterX.a !== beforeX.a || afterX.b !== beforeX.b;

      // Reopen: this view's own last choice (pattern + function name) should win.
      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 60));
      const box2 = document.querySelector('.modal-box');
      const reopenedPattern = box2.querySelector('#rm-pattern').value;
      const reopenedFn = box2.querySelector('#rm-custom-function').value;
      box2.querySelector('.cancel').click();

      return { hasCustomOption, fnRowVisible, priorityHidden, edgeHidden, minimizeCrossingsHidden, hasExampleOption, movedSomething, reopenedPattern, reopenedFn };
    }
    """)
    problems = []
    if not result["hasCustomOption"]:
        problems.append("expected 'custom' to be a Pattern option in the Remap dialog")
    if not result["fnRowVisible"]:
        problems.append("expected the Custom Function dropdown to appear once 'custom' is selected")
    if not result["priorityHidden"] or not result["edgeHidden"] or not result["minimizeCrossingsHidden"]:
        problems.append(f"expected Sort priority/Edge Assignment/Minimize Crossings to be hidden for 'custom', got priorityHidden={result['priorityHidden']} edgeHidden={result['edgeHidden']} minimizeCrossingsHidden={result['minimizeCrossingsHidden']}")
    if not result["hasExampleOption"]:
        problems.append("expected the shipped CustomRemap_Example to appear in the Custom Function dropdown")
    if not result["movedSomething"]:
        problems.append("expected submitting with CustomRemap_Example selected to actually move at least one node")
    if result["reopenedPattern"] != "custom" or result["reopenedFn"] != "CustomRemap_Example":
        problems.append(f"expected reopening Remap on this view to pre-select pattern='custom' and function='CustomRemap_Example' (this view's own last choice), got pattern={result['reopenedPattern']!r} fn={result['reopenedFn']!r}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "the Remap dialog's 'custom' pattern reveals a Custom Function dropdown populated from store.batchScriptCode (hiding the grid-specific options that don't apply), submitting with it actually repositions nodes, and this view's own last choice is remembered on reopen"


def check_force_directed_no_runaway_drift(page):
    """Regression guard: force-directed layout once let two disconnected pairs drift
    thousands of pixels apart. Confirms a-b/c-d stay within a sane bound."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const view = store.addView('RegrDrift_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      function mkNode(label, x, y) {
        const part = store.createPart({ type: 'Unknown', label, model: store.defaultModel, streams: [] });
        return store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x, y });
      }
      function mkConn(a, b) {
        const conn = store.createConnector({ from: store.findPart(a.objectId).id, to: store.findPart(b.objectId).id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
        return store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: a.id, toVmId: b.id });
      }
      const a = mkNode('a', 0, 0), b = mkNode('b', 200, 0), c = mkNode('c', 400, 0), d = mkNode('d', 600, 0);
      mkConn(a, b); mkConn(c, d);
      commands.applyRemapLayout(app, view.id, { pattern: 'force' });
      const distAB = Math.hypot(a.x - b.x, a.y - b.y);
      const maxCoord = Math.max(a.x, b.x, c.x, d.x, a.y, b.y, c.y, d.y);
      return { distAB, maxCoord, allNonNegative: [a, b, c, d].every(v => v.x >= 0 && v.y >= 0) };
    }
    """)
    if result["maxCoord"] > 3000:
        return False, f"coordinates drifted too far: max={result['maxCoord']} (expected < 3000)"
    if not result["allNonNegative"]:
        return False, "some coordinates went negative"
    return True, f"connected pair distance={result['distAB']:.0f}px, max coord={result['maxCoord']:.0f}px, no drift"


def check_force_directed_adjacent_cells(page):
    """Regression guard: connected nodes should land in truly adjacent grid cells, not
    just 'closer than before'."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const view = store.addView('RegrAdjacent_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const partA = store.createPart({ type: 'Unknown', label: 'a', model: store.defaultModel, streams: [] });
      const partB = store.createPart({ type: 'Unknown', label: 'b', model: store.defaultModel, streams: [] });
      const a = store.createViewMember({ view: view.id, objectType: 'part', objectId: partA.id, x: 0, y: 0 });
      const b = store.createViewMember({ view: view.id, objectType: 'part', objectId: partB.id, x: 200, y: 0 });
      const conn = store.createConnector({ from: partA.id, to: partB.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: a.id, toVmId: b.id });
      commands.applyRemapLayout(app, view.id, { pattern: 'force' });
      const stepX = 170, stepY = 90;
      const cellA = { col: Math.round(a.x / stepX), row: Math.round(a.y / stepY) };
      const cellB = { col: Math.round(b.x / stepX), row: Math.round(b.y / stepY) };
      const adjacent = Math.abs(cellA.col - cellB.col) <= 1 && Math.abs(cellA.row - cellB.row) <= 1 && !(cellA.col === cellB.col && cellA.row === cellB.row);
      return { adjacent, cellA, cellB };
    }
    """)
    if not result["adjacent"]:
        return False, f"connected nodes not in adjacent cells: {result['cellA']} vs {result['cellB']}"
    return True, "connected pair landed in truly adjacent grid cells"


def check_remap_clusters_decomposition(page):
    """Regression guard for the new Remap 'clusters' ("Centralize in Clusters") pattern,
    reported directly: "need a better remap for erd that puts popular nodes central to
    single children around them, repeat this pattern in clusters. perhaps a 'centralize
    in clusters' option that could work on any view." Exercises
    layout.js's computeHubClusterDecomposition directly -- pure graph logic, no
    coordinates, no store -- covering the specific design choices made for this
    feature (any node with degree >= 2 is a hub candidate; a lower-degree non-leaf
    joins a hub's ring when that hub is its ONE strictly-more-connected neighbor,
    rather than only true degree-1 leaves being pulled in):
    - a star (one hub, three leaves) collapses to one cluster with all three leaves in
      the ring;
    - a degree-2 node ("D") whose sole more-connected neighbor is a hub joins that
      hub's ring instead of becoming its own hub, even though its own degree is 2, not
      1 -- the "leans toward one hub" behavior specifically chosen for this feature;
    - a node ("E") whose only neighbor is that same absorbed D (not the hub itself)
      does NOT transitively join the hub's cluster -- D's own further edges aren't
      inherited by the hub, so E becomes its own separate singleton cluster (its edge
      to D becomes a cross-cluster "bridge", the same category of limitation as a
      force-directed pattern's own unplaceable cycle edge);
    - two EQUAL-degree hubs connected to each other stay two separate clusters (neither
      outranks the other, so neither absorbs the other) instead of merging into one;
    - an isolated pair (two nodes connected only to each other, both degree 1) becomes
      its own hub+ring-of-one cluster rather than being dropped;
    - a fully isolated node (no edges at all) becomes its own hub with an empty ring.
    Every node must appear in EXACTLY one cluster (no node lost, no node duplicated)."""
    result = js(page, """
    async () => {
      const layout = await import('./js/layout.js');

      // star: H1 + 3 leaves
      const starEdges = [{ from: 'H1', to: 'L1' }, { from: 'H1', to: 'L2' }, { from: 'H1', to: 'L3' }];
      const starClusters = layout.computeHubClusterDecomposition(['H1', 'L1', 'L2', 'L3'], starEdges);

      // hub H3 (3 leaves + D), D (degree 2: H3 + E), E (degree 1: D only)
      const leanEdges = [
        { from: 'H3', to: 'F1' }, { from: 'H3', to: 'F2' }, { from: 'H3', to: 'F3' },
        { from: 'H3', to: 'D' }, { from: 'D', to: 'E' },
      ];
      const leanClusters = layout.computeHubClusterDecomposition(['H3', 'F1', 'F2', 'F3', 'D', 'E'], leanEdges);

      // two equal-degree hubs (4 each, bridged to each other)
      const bridgeEdges = [
        { from: 'H1b', to: 'A1' }, { from: 'H1b', to: 'A2' }, { from: 'H1b', to: 'A3' }, { from: 'H1b', to: 'H2b' },
        { from: 'H2b', to: 'B1' }, { from: 'H2b', to: 'B2' }, { from: 'H2b', to: 'B3' },
      ];
      const bridgeClusters = layout.computeHubClusterDecomposition(['H1b', 'A1', 'A2', 'A3', 'H2b', 'B1', 'B2', 'B3'], bridgeEdges);

      // isolated pair + isolated singleton
      const miscClusters = layout.computeHubClusterDecomposition(['P', 'Q', 'Z'], [{ from: 'P', to: 'Q' }]);

      const findCluster = (clusters, hub) => clusters.find(c => c.hub === hub);
      const allNodesCovered = (clusters, expectedIds) => {
        const seen = new Set();
        for (const c of clusters) { seen.add(c.hub); for (const r of c.ring) seen.add(r); }
        return expectedIds.every(id => seen.has(id)) && [...seen].length === expectedIds.length;
      };

      return {
        starClusterCount: starClusters.length,
        starRing: findCluster(starClusters, 'H1')?.ring.slice().sort(),
        leanClusterCount: leanClusters.length,
        h3Ring: findCluster(leanClusters, 'H3')?.ring.slice().sort(),
        eIsOwnHub: !!findCluster(leanClusters, 'E'),
        eRing: findCluster(leanClusters, 'E')?.ring,
        leanNodesCovered: allNodesCovered(leanClusters, ['H3', 'F1', 'F2', 'F3', 'D', 'E']),
        bridgeClusterCount: bridgeClusters.length,
        h1bIsHub: !!findCluster(bridgeClusters, 'H1b'),
        h2bIsHub: !!findCluster(bridgeClusters, 'H2b'),
        bridgeNodesCovered: allNodesCovered(bridgeClusters, ['H1b', 'A1', 'A2', 'A3', 'H2b', 'B1', 'B2', 'B3']),
        miscClusterCount: miscClusters.length,
        pRing: findCluster(miscClusters, 'P')?.ring,
        zRing: findCluster(miscClusters, 'Z')?.ring,
      };
    }
    """)
    problems = []
    if result["starClusterCount"] != 1 or result["starRing"] != ["L1", "L2", "L3"]:
        problems.append(f"expected a star to collapse to one cluster with all 3 leaves in the hub's ring, got count={result['starClusterCount']} ring={result['starRing']}")
    if result["leanClusterCount"] != 2:
        problems.append(f"expected the 'leaning' fixture to produce exactly 2 clusters (H3's star + E's own singleton), got {result['leanClusterCount']}")
    if result["h3Ring"] != ["D", "F1", "F2", "F3"]:
        problems.append(f"expected D (degree-2, leaning toward H3) to join H3's ring alongside the 3 true leaves, got {result['h3Ring']}")
    if not result["eIsOwnHub"] or result["eRing"] != []:
        problems.append(f"expected E to become its own singleton cluster (D was already claimed by H3, so E's edge to D is a bridge, not inherited) eIsOwnHub={result['eIsOwnHub']} eRing={result['eRing']}")
    if not result["leanNodesCovered"]:
        problems.append("expected every node in the 'leaning' fixture to appear in exactly one cluster")
    if result["bridgeClusterCount"] != 2 or not result["h1bIsHub"] or not result["h2bIsHub"]:
        problems.append(f"expected two EQUAL-degree hubs connected to each other to stay two separate clusters (neither absorbs the other), got count={result['bridgeClusterCount']} h1bIsHub={result['h1bIsHub']} h2bIsHub={result['h2bIsHub']}")
    if not result["bridgeNodesCovered"]:
        problems.append("expected every node in the equal-degree-bridge fixture to appear in exactly one cluster")
    if result["miscClusterCount"] != 2:
        problems.append(f"expected an isolated pair (1 cluster) + an isolated singleton (1 cluster) = 2 clusters, got {result['miscClusterCount']}")
    if result["pRing"] != ["Q"]:
        problems.append(f"expected the isolated pair to become one hub+ring-of-one cluster, got P's ring={result['pRing']}")
    if result["zRing"] != []:
        problems.append(f"expected the fully isolated node to become its own hub with an empty ring, got {result['zRing']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "computeHubClusterDecomposition centers popular (degree>=2) nodes with their single-connection leaves around them, pulls in a lower-degree non-leaf that leans toward one hub, keeps equal-degree hubs as separate clusters instead of merging, and never loses or duplicates a node including isolated pairs/singletons"


def check_remap_clusters_grid_placement(page):
    """Integration regression guard for Remap's 'clusters' pattern end to end (commands.js's
    applyRemapLayout, pattern:'clusters' -- see check_remap_clusters_decomposition for the
    underlying pure-logic decomposition), proving the shared makeRingPlacer refactor
    (layout.js, factored out of computeAdjacentGridLayout so 'force' and 'clusters' share
    identical ring-placement code) didn't break either consumer. Covers: every ring member
    lands in a grid cell truly ADJACENT to its own hub (same assertion style as
    check_force_directed_adjacent_cells, just per-cluster instead of per-component); TWO
    separate hub clusters on the same view end up in DIFFERENT, non-overlapping grid
    regions (the packClustersOnGrid tail actually ran, not just one cluster's own
    placement); no two nodes anywhere in the final layout land on the exact same pixel
    position; and forcePreferRight biases a ring member to the hub's own EAST cell when
    that cell is free, same as it already does for 'force'."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const mk = (label) => store.createPart({ type: 'Unknown', label, model, streams: [] });
      const conn = (fromPart, toPart) => store.createConnector({ from: fromPart.id, to: toPart.id, model, connectorType: 'c', relationship: 'Association', streams: [] });
      const place = (view, part, x, y) => store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x, y });
      const wire = (view, c, fromVm, toVm) => store.createViewMember({ view: view.id, objectType: 'connector', objectId: c.id, fromVmId: fromVm.id, toVmId: toVm.id });

      const view = store.addView('RegrClusters_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      // cluster 1: hub H with 3 leaves
      const H = mk('H'), L1 = mk('L1'), L2 = mk('L2'), L3 = mk('L3');
      const hVm = place(view, H, 0, 0), l1Vm = place(view, L1, 500, 500), l2Vm = place(view, L2, 600, 500), l3Vm = place(view, L3, 700, 500);
      wire(view, conn(H, L1), hVm, l1Vm); wire(view, conn(H, L2), hVm, l2Vm); wire(view, conn(H, L3), hVm, l3Vm);

      // cluster 2: separate hub K with 2 leaves, no connection at all to cluster 1
      const K = mk('K'), M1 = mk('M1'), M2 = mk('M2');
      const kVm = place(view, K, 2000, 2000), m1Vm = place(view, M1, 2100, 2000), m2Vm = place(view, M2, 2200, 2000);
      wire(view, conn(K, M1), kVm, m1Vm); wire(view, conn(K, M2), kVm, m2Vm);

      commands.applyRemapLayout(app, view.id, { pattern: 'clusters' });

      const stepX = 170, stepY = 90;
      const cellOf = (vm) => ({ col: Math.round(vm.x / stepX), row: Math.round(vm.y / stepY) });
      const isAdjacent = (a, b) => Math.abs(a.col - b.col) <= 1 && Math.abs(a.row - b.row) <= 1 && !(a.col === b.col && a.row === b.row);
      const hCell = cellOf(hVm);
      const leafCells = [l1Vm, l2Vm, l3Vm].map(cellOf);
      const allLeafAdjacentToH = leafCells.every(c => isAdjacent(hCell, c));

      // packClustersOnGrid's job is to keep each cluster's own cells in a DISTINCT
      // region -- not to space clusters far apart (a tight shelf-pack with a 1-cell gap
      // is the intended, space-efficient behavior) -- so the real assertion is that the
      // two clusters' bounding boxes don't overlap, not that they're far apart.
      const boundsOf = (cells) => ({
        minCol: Math.min(...cells.map(c => c.col)), maxCol: Math.max(...cells.map(c => c.col)),
        minRow: Math.min(...cells.map(c => c.row)), maxRow: Math.max(...cells.map(c => c.row)),
      });
      const rectsOverlap = (a, b) => a.minCol <= b.maxCol && b.minCol <= a.maxCol && a.minRow <= b.maxRow && b.minRow <= a.maxRow;
      const kCell = cellOf(kVm), m1Cell = cellOf(m1Vm), m2Cell = cellOf(m2Vm);
      const hClusterBounds = boundsOf([hCell, ...leafCells]);
      const kClusterBounds = boundsOf([kCell, m1Cell, m2Cell]);
      const clustersOverlap = rectsOverlap(hClusterBounds, kClusterBounds);

      const allVms = [hVm, l1Vm, l2Vm, l3Vm, kVm, m1Vm, m2Vm];
      const positions = allVms.map(vm => `${Math.round(vm.x)},${Math.round(vm.y)}`);
      const noOverlap = new Set(positions).size === positions.length;

      // forcePreferRight: re-run on a fresh single hub+leaf pair, confirm the leaf lands directly EAST of the hub
      const view2 = store.addView('RegrClustersRight_' + Date.now(), 'ff');
      const H2 = mk('H2'), R1 = mk('R1');
      const h2Vm = place(view2, H2, 0, 0), r1Vm = place(view2, R1, 500, 0);
      wire(view2, conn(H2, R1), h2Vm, r1Vm);
      commands.applyRemapLayout(app, view2.id, { pattern: 'clusters', forcePreferRight: true });
      const h2Cell = cellOf(h2Vm), r1Cell = cellOf(r1Vm);
      const leafIsEastOfHub = r1Cell.col === h2Cell.col + 1 && r1Cell.row === h2Cell.row;

      return { allLeafAdjacentToH, clustersOverlap, noOverlap, leafIsEastOfHub, hCell, leafCells, kCell };
    }
    """)
    problems = []
    if not result["allLeafAdjacentToH"]:
        problems.append(f"expected all 3 leaves adjacent to hub H, got hCell={result['hCell']} leafCells={result['leafCells']}")
    if result["clustersOverlap"]:
        problems.append(f"expected the two separate hub clusters' bounding boxes to never overlap, got hCell={result['hCell']} kCell={result['kCell']}")
    if not result["noOverlap"]:
        problems.append("expected no two nodes anywhere in the final layout to land on the exact same pixel position")
    if not result["leafIsEastOfHub"]:
        problems.append("expected forcePreferRight to place a free ring member directly EAST of its hub")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "applyRemapLayout(pattern:'clusters') places every ring member in a grid cell truly adjacent to its own hub, shelf-packs separate hub clusters well apart with no overlapping positions anywhere, and honors forcePreferRight the same way 'force' does"


def check_remap_clusters_connectivity_aware_packing(page):
    """Regression guard for a direct follow-up report on the 'clusters' pattern: "is it
    possible to add the existing 'minimize connector crossing' or something similar, to
    avoid placing nodes directly on unrelated connectors after 'centralize in clusters'
    is applied?" Root cause of the underlying defect: packClustersOnGrid (layout.js)
    used to order clusters purely by AREA, with zero awareness of which clusters are
    connected to each other by a cross-cluster "bridge" edge -- so a bridge-connected
    pair could easily end up on opposite ends of the shelf-packed sequence with an
    unrelated cluster sitting between them, forcing the bridge's straight-line connector
    to stretch across (and often visually through) that unrelated territory. Fixed by
    making the packing order connectivity-aware: after the largest cluster, whichever
    remaining cluster shares the most bridge edges with what's ALREADY placed goes next
    (tie-broken by area), not just whichever is biggest.

    Exercises layout.js's computeHubClusterGridLayout directly (pure logic, no store).
    Fixture: cluster P (hub + 5 leaves, clearly largest, the unambiguous first pick),
    cluster Q (hub + 3 leaves, same size as R, NOT connected to anything else), cluster
    R (hub + 3 leaves, one of which bridges to one of P's own leaves). Old pure-area
    ordering would place P first, then Q and R tied for second (stable sort keeps their
    original relative order, Q first) -- producing the sequence [P, Q, R], with the
    bridge-connected pair P/R NOT adjacent. Asserts the FIXED ordering instead places R
    right after P (ahead of the same-sized, unconnected Q) by checking each cluster's
    own leftmost column in the final packed grid: R's minimum column must be smaller
    than Q's (R was packed earlier/closer), and P's smaller than R's (P still goes
    first, being unambiguously largest)."""
    result = js(page, """
    async () => {
      const layout = await import('./js/layout.js');
      const w = 130, h = 46;
      const mkNode = (id) => ({ id, x: 0, y: 0, w, h });

      const HP = 'HP', LP = ['LP1', 'LP2', 'LP3', 'LP4', 'LP5'];
      const HQ = 'HQ', LQ = ['LQ1', 'LQ2', 'LQ3'];
      const HR = 'HR', LR = ['LR1', 'LR2', 'LR3'];
      const nodeIds = [HP, ...LP, HQ, ...LQ, HR, ...LR];
      const nodes = nodeIds.map(mkNode);
      const edges = [
        ...LP.map(l => ({ from: HP, to: l })),
        ...LQ.map(l => ({ from: HQ, to: l })),
        ...LR.map(l => ({ from: HR, to: l })),
        { from: LP[0], to: LR[0] }, // the bridge: a leaf of P connects to a leaf of R
      ];

      const stepX = 170;
      const positions = layout.computeHubClusterGridLayout(nodes, edges, { stepX, stepY: 90, maxShelfWidthCells: 30 });
      const colOf = (id) => Math.round(positions.get(id).x / stepX);
      const minColOf = (ids) => Math.min(...ids.map(colOf));

      return {
        minColP: minColOf([HP, ...LP]),
        minColQ: minColOf([HQ, ...LQ]),
        minColR: minColOf([HR, ...LR]),
      };
    }
    """)
    if not (result["minColP"] < result["minColR"] < result["minColQ"]):
        return False, f"expected packing order P, R, Q (bridge-connected R pulled ahead of same-sized, unconnected Q) by leftmost column, got minColP={result['minColP']} minColR={result['minColR']} minColQ={result['minColQ']}"
    return True, "packClustersOnGrid places a bridge-connected cluster (R) shelf-adjacent to what's already placed (P) ahead of a same-sized but unconnected cluster (Q), instead of ordering purely by area"


def check_remap_clusters_avoid_node_on_connector_overlap(page):
    """Regression guard for layout.js's avoidNodeOnConnectorOverlap -- the direct fix for
    "is it possible to ... avoid placing nodes directly on unrelated connectors after
    'centralize in clusters' is applied?" once a bridge edge still ends up crossing
    through a bystander node's cell despite the connectivity-aware packing above.
    Exercises the function directly (pure logic: hand-built finalGrid/nodeSizes/
    ringMemberToHub/edges, no store), covering the three design guarantees documented
    on the function itself:
    - a genuine bystander (a RING member, not an endpoint of the offending connector)
      sitting exactly on a connector's straight-line path gets relocated to a different
      cell -- one of its own hub's other 8 immediate neighbor cells, so it's still
      exactly as hub-adjacent afterward;
    - a HUB sitting on a connector's path is NEVER moved (moving a hub would disturb
      its entire ring) -- confirmed left in place;
    - a ring member on the path but with NO free alternative cell around its own hub
      (every other neighbor already occupied) is also left in place -- best-effort, not
      a crash or an invalid relocation.
    In every case the connector's own two endpoints are themselves never touched."""
    result = js(page, """
    async () => {
      const layout = await import('./js/layout.js');
      const offsets = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];

      // Case 1: ring member Z sits on the X-Y connector path -- should relocate around its own hub H.
      const grid1 = new Map([['X', {col:0,row:0}], ['Y', {col:4,row:0}], ['H', {col:2,row:-1}], ['Z', {col:2,row:0}]]);
      const sizes1 = new Map([['X',{w:100,h:40}], ['Y',{w:100,h:40}], ['H',{w:100,h:40}], ['Z',{w:100,h:40}]]);
      layout.avoidNodeOnConnectorOverlap(grid1, sizes1, new Map([['Z','H']]), [{from:'X',to:'Y'}], 100, 100);
      const zMoved = grid1.get('Z').col !== 2 || grid1.get('Z').row !== 0;
      const zStillHubAdjacent = Math.abs(grid1.get('Z').col - grid1.get('H').col) <= 1 && Math.abs(grid1.get('Z').row - grid1.get('H').row) <= 1;
      const endpointsUntouched1 = grid1.get('X').col === 0 && grid1.get('X').row === 0 && grid1.get('Y').col === 4 && grid1.get('Y').row === 0;
      const hubUntouched1 = grid1.get('H').col === 2 && grid1.get('H').row === -1;

      // Case 2: a HUB (not a ring member) sits on the path -- must NEVER move.
      const grid2 = new Map([['X', {col:0,row:0}], ['Y', {col:4,row:0}], ['HubOnPath', {col:2,row:0}]]);
      const sizes2 = new Map([['X',{w:100,h:40}], ['Y',{w:100,h:40}], ['HubOnPath',{w:100,h:40}]]);
      layout.avoidNodeOnConnectorOverlap(grid2, sizes2, new Map(), [{from:'X',to:'Y'}], 100, 100);
      const hubNeverMoved = grid2.get('HubOnPath').col === 2 && grid2.get('HubOnPath').row === 0;

      // Case 3: ring member on the path, but every one of its hub's 8 neighbor cells is
      // already occupied -- best-effort, must stay put (not crash, not relocate invalidly).
      const grid3 = new Map([['X', {col:0,row:0}], ['Y', {col:4,row:0}], ['H2', {col:2,row:-1}], ['Z2', {col:2,row:0}]]);
      const sizes3 = new Map([['X',{w:100,h:40}], ['Y',{w:100,h:40}], ['H2',{w:100,h:40}], ['Z2',{w:100,h:40}]]);
      let n = 0;
      for (const [dc, dr] of offsets) {
        const c = 2 + dc, r = -1 + dr;
        if (c === 2 && r === 0) continue; // Z2's own cell
        grid3.set('Filler' + (n++), { col: c, row: r });
      }
      for (let i = 0; i < n; i++) sizes3.set('Filler' + i, { w: 100, h: 40 });
      layout.avoidNodeOnConnectorOverlap(grid3, sizes3, new Map([['Z2','H2']]), [{from:'X',to:'Y'}], 100, 100);
      const z2StayedPut = grid3.get('Z2').col === 2 && grid3.get('Z2').row === 0;

      return { zMoved, zStillHubAdjacent, endpointsUntouched1, hubUntouched1, hubNeverMoved, z2StayedPut };
    }
    """)
    problems = []
    if not result["zMoved"]:
        problems.append("expected the bystander ring member sitting on the connector's path to be relocated")
    if not result["zStillHubAdjacent"]:
        problems.append("expected the relocated ring member to still be adjacent to its own hub")
    if not result["endpointsUntouched1"] or not result["hubUntouched1"]:
        problems.append("expected the connector's own endpoints and the bystander's hub to never move")
    if not result["hubNeverMoved"]:
        problems.append("expected a HUB sitting on an unrelated connector's path to never be moved")
    if not result["z2StayedPut"]:
        problems.append("expected a ring member with no free alternative cell around its hub to stay put (best-effort, not an invalid relocation)")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "avoidNodeOnConnectorOverlap relocates a bystander ring member off an unrelated connector's path (staying adjacent to its own hub, endpoints/hub untouched), never moves a hub, and leaves a node with no free slot in place"


def check_smart_check_view(page):
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const view = store.addView('RegrSCV_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const px = store.createPart({ type: 'Unknown', label: 'X', model: store.defaultModel, streams: [] });
      const py = store.createPart({ type: 'Unknown', label: 'Y', model: store.defaultModel, streams: [] });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: px.id, x: 0, y: 0 });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: py.id, x: 200, y: 0 });
      const conn = store.createConnector({ from: px.id, to: py.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      const res = commands.smartCheckView(app, tab, { missingConnectors: true, missingConnectorsAndNodes: false });
      const placed = store.viewMembersForView(view.id).some(v => v.objectType === 'connector' && v.objectId === conn.id);
      const noteApplied = conn.note.includes('Smart Check created.');
      // idempotency: re-run should add nothing more
      const res2 = commands.smartCheckView(app, tab, { missingConnectors: true, missingConnectorsAndNodes: false });
      return { connectorsAdded: res.connectorsAdded, placed, noteApplied, secondRunNoop: res2.connectorsAdded === 0 };
    }
    """)
    if result["connectorsAdded"] != 1 or not result["placed"] or not result["noteApplied"] or not result["secondRunNoop"]:
        return False, f"unexpected result: {result}"
    return True, "Smart Check added the missing connector, noted it, and was idempotent on re-run"


def check_property_panel_field_split(page):
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.addView('RegrPanel_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const part = store.createPart({ type: 'Unknown', label: 'Z', model: store.defaultModel, streams: [] });
      const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x: 0, y: 0 });
      app.selectOnly(vm.id);
      app.render();
      await new Promise(r => setTimeout(r, 30));
      const topLabels = [...document.querySelectorAll('.vm-top-fields label[data-field]')].map(l => l.dataset.field);
      const rootSection = document.querySelector('.root-properties-section');
      const rootLabels = rootSection ? [...rootSection.querySelectorAll('label[data-field]')].map(l => l.dataset.field) : [];
      return {
        rootSectionExists: !!rootSection,
        topHasNoLabel: !topLabels.includes('label'),
        topHasX: topLabels.includes('x'),
        rootHasLabel: rootLabels.includes('label'),
        rootHasCreatedAt: rootLabels.includes('createdAt'),
      };
    }
    """)
    problems = [k for k, v in result.items() if not v]
    if problems:
        return False, f"panel structure wrong: {problems} (full: {result})"
    return True, "top-level shows only viewMember fields; Root Properties shows part fields including timestamps"


def check_multiselect_shows_entity_level_fields(page):
    """Regression guard: the multi-select "N items selected — showing common attributes"
    panel used to build its field list from ONLY viewMember-level showFields (nodes) or
    ONLY connector-level showFields (connectors) — never merging in the OTHER level, so
    every part-level field (streams, label, description, script, ...) was entirely
    unavailable when multi-selecting nodes, and every viewMember-level field (fillColor,
    fontColor, ...) was entirely unavailable when multi-selecting connectors. Not a
    blank-value special case — those fields were never considered at all, regardless of
    value. Covers both directions: an all-node selection now offers 'streams' (a
    part-level field) and applying a new value actually updates every selected part's own
    streams; an all-connector selection now offers 'fillColor' (a viewMember-level
    field)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.addView('RegrMultiSelect_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const p1 = store.createPart({ type: 'GeneralActor', label: 'MS1', model: store.defaultModel, streams: [] });
      const p2 = store.createPart({ type: 'GeneralActor', label: 'MS2', model: store.defaultModel, streams: [] });
      const vm1 = store.createViewMember({ view: view.id, objectType: 'part', objectId: p1.id, x: 40, y: 40 });
      const vm2 = store.createViewMember({ view: view.id, objectType: 'part', objectId: p2.id, x: 240, y: 40 });
      tab.selection.clear();
      tab.selection.add(vm1.id);
      tab.selection.add(vm2.id);
      app.render();
      await new Promise(r => setTimeout(r, 60));

      const streamsInputExists = !!document.getElementById('msf-streams');
      const input = document.getElementById('msf-streams');
      input.value = 'Alpha, Beta';
      input.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 60));
      document.querySelector('.modal-overlay .primary')?.click();
      await new Promise(r => setTimeout(r, 100));
      const p1StreamsAfter = store.findPart(p1.id).streams;
      const p2StreamsAfter = store.findPart(p2.id).streams;

      // Connector direction: an all-connector selection should now offer a
      // viewMember-level field (fillColor) it previously never considered.
      const c1part = store.createPart({ type: 'GeneralActor', label: 'C1', model: store.defaultModel, streams: [] });
      const c2part = store.createPart({ type: 'GeneralActor', label: 'C2', model: store.defaultModel, streams: [] });
      const c3part = store.createPart({ type: 'GeneralActor', label: 'C3', model: store.defaultModel, streams: [] });
      const conn1 = store.createConnector({ from: c1part.id, to: c2part.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      const conn2 = store.createConnector({ from: c2part.id, to: c3part.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      const cvm1 = store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn1.id, fromVmId: vm1.id, toVmId: vm2.id });
      const cvm2 = store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn2.id, fromVmId: vm1.id, toVmId: vm2.id });
      tab.selection.clear();
      tab.selection.add(cvm1.id);
      tab.selection.add(cvm2.id);
      app.render();
      await new Promise(r => setTimeout(r, 60));
      const connFillColorInputExists = !!document.getElementById('msf-fillColor');

      return { streamsInputExists, p1StreamsAfter, p2StreamsAfter, connFillColorInputExists };
    }
    """)
    problems = []
    if not result["streamsInputExists"]:
        problems.append("expected a 'streams' input (part-level field) to be offered for an all-node multi-selection, got none")
    if result["p1StreamsAfter"] != ["Alpha", "Beta"] or result["p2StreamsAfter"] != ["Alpha", "Beta"]:
        problems.append(f"expected applying the streams field to update every selected part's own streams, got p1={result['p1StreamsAfter']} p2={result['p2StreamsAfter']}")
    if not result["connFillColorInputExists"]:
        problems.append("expected a 'fillColor' input (viewMember-level field) to be offered for an all-connector multi-selection, got none")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "multi-select now offers both viewMember-level and entity-level (part/connector) common fields, in both directions, and applying one actually updates every selected item's underlying entity"


def check_code_summary(page):
    """Regression guard for Advanced > Code Summary (moved here from the Simulation menu
    — see check_script_console_and_code_summary_moved_to_advanced): a read-only listing
    of every part's own script, for reviewing what code exists in a file before running
    an unfamiliar simulation. Covers: a part with NO script is excluded; a part with a
    script is included REGARDLESS of scriptEnabled (a disabled script could always be
    re-enabled later, so this is a review of what code exists, not just what's
    presently wired to run) and clearly marked ENABLED/disabled; each block identifies
    its source part (label, type, id); grouped by model; the Script Console's own
    persistent text (store.batchScriptCode) is ALSO included, not just per-part
    scripts; and the modal is genuinely read-only (no Save/Cancel, just Close)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const p1 = store.createPart({ type: 'GeneralActor', label: 'Requester', model: store.defaultModel, streams: [] });
      p1.scriptEnabled = true;
      p1.script = 'return { value: 42 };';
      const p2 = store.createPart({ type: 'ApplicationComponent', label: 'DisabledScriptNode', model: 'As-is', streams: [] });
      p2.scriptEnabled = false;
      p2.script = 'return { value: 1 };';
      const p3 = store.createPart({ type: 'GeneralActor', label: 'NoScriptNode', model: store.defaultModel, streams: [] });
      // p3 has no script at all -- should not appear in the summary

      document.getElementById('advanced-menu-btn').click();
      await new Promise(r => setTimeout(r, 60));
      document.querySelector('#advanced-menu .dd-item[data-action=\\"codeSummary\\"]').click();
      await new Promise(r => setTimeout(r, 150));

      const textarea = document.getElementById('text-edit-area');
      const modalActions = document.querySelector('.modal-overlay .modal-actions');
      return {
        modalText: textarea ? textarea.value : null,
        readonly: textarea ? textarea.readOnly : null,
        actionButtonLabels: modalActions ? [...modalActions.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
      };
    }
    """)
    problems = []
    text = result["modalText"] or ""
    if "Requester" not in text or "GeneralActor" not in text or "ENABLED" not in text:
        problems.append(f"expected the summary to include the enabled scripted part, its type, and ENABLED marker, got: {text[:400]}")
    if "DisabledScriptNode" not in text or "disabled" not in text:
        problems.append(f"expected the summary to include the DISABLED scripted part too (code exists regardless of scriptEnabled) with a 'disabled' marker, got: {text[:400]}")
    if "NoScriptNode" in text:
        problems.append("expected a part with no script at all to be excluded from the summary")
    if "Model: As-is" not in text or "Model:" not in text:
        problems.append(f"expected the summary to group scripts by model (a 'Model: As-is' section header, at least), got: {text[:400]}")
    if "Script Console" not in text or "main()" not in text:
        problems.append(f"expected the Script Console's own persistent text (store.batchScriptCode) to also appear in the summary, got: {text[:400]}")
    if not result["readonly"]:
        problems.append("expected the Code Summary textarea to be readonly")
    if result["actionButtonLabels"] != ["Close"]:
        problems.append(f"expected only a single 'Close' button (read-only modal), got {result['actionButtonLabels']}")
    if problems:
        return False, "; ".join(problems) + f" (full text: {text})"
    return True, "Code Summary lists every scripted part (enabled or disabled) grouped by model, identifies its source part, excludes unscripted parts, includes the Script Console's own text, and opens as a genuinely read-only modal"


def check_script_console_and_code_summary_moved_to_advanced(page):
    """Regression guard: 'Script Console...' and 'Code Summary' moved from the
    Simulation menu to the Advanced menu, after a separator — reported directly: "Move
    'Script Console...' and 'Code Summary' to Advanced after a separator." Neither is
    actually a simulation action (Script Console works with no model selected at all;
    Code Summary reviews every model's scripts, not the selected one), so this also
    checks they're genuinely GONE from the Simulation menu, not just duplicated."""
    result = js(page, """
    async () => {
      const app = window.dycadApp;
      document.getElementById('advanced-menu-btn').click();
      await new Promise(r => setTimeout(r, 60));
      const advItems = [...document.querySelectorAll('#advanced-menu .dd-item')];
      const scriptConsoleIdx = advItems.findIndex(e => e.dataset.action === 'scriptConsole');
      const codeSummaryIdx = advItems.findIndex(e => e.dataset.action === 'codeSummary');
      const advSeparators = [...document.querySelectorAll('#advanced-menu > *')];
      const scriptConsoleEl = advItems[scriptConsoleIdx];
      const precedingEl = scriptConsoleEl ? scriptConsoleEl.previousElementSibling : null;
      const hasSeparatorBeforeScriptConsole = !!precedingEl && precedingEl.classList.contains('dd-separator');
      document.getElementById('advanced-menu-btn').click();

      document.getElementById('simulation-menu-btn').click();
      await new Promise(r => setTimeout(r, 60));
      const simItems = [...document.querySelectorAll('#simulation-menu .dd-item')].map(e => ({ text: e.textContent.trim(), action: e.dataset.action }));
      document.getElementById('simulation-menu-btn').click();

      return {
        scriptConsoleInAdvanced: scriptConsoleIdx !== -1,
        codeSummaryInAdvanced: codeSummaryIdx !== -1,
        hasSeparatorBeforeScriptConsole,
        simItemActions: simItems.map(i => i.action),
      };
    }
    """)
    problems = []
    if not result["scriptConsoleInAdvanced"]:
        problems.append("expected 'Script Console...' in the Advanced menu")
    if not result["codeSummaryInAdvanced"]:
        problems.append("expected 'Code Summary' in the Advanced menu")
    if not result["hasSeparatorBeforeScriptConsole"]:
        problems.append("expected a separator immediately before 'Script Console...' in the Advanced menu")
    if 'scriptConsole' in result["simItemActions"]:
        problems.append("expected 'Script Console...' to be GONE from the Simulation menu, not just duplicated")
    if 'codeSummary' in result["simItemActions"]:
        problems.append("expected 'Code Summary' to be GONE from the Simulation menu, not just duplicated")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Script Console and Code Summary now live in the Advanced menu, after a separator, and are gone from the Simulation menu"


def check_reset_pinned_3d_positions_moved_to_explore(page):
    """Regression guard: 'Reset Pinned 3D Positions' moved from the Advanced menu to
    the Explore menu, after a separator — reported directly: "Move 'Reset Pinned 3D
    Positions' to the Explore menu after a separator." Also checks it's genuinely GONE
    from the Advanced menu, not just duplicated."""
    result = js(page, """
    async () => {
      const app = window.dycadApp;
      document.getElementById('explore-menu-btn').click();
      await new Promise(r => setTimeout(r, 60));
      const exploreItems = [...document.querySelectorAll('#explore-menu .dd-item')];
      const resetIdx = exploreItems.findIndex(e => e.dataset.action === 'resetPinned3DPositions');
      const resetEl = exploreItems[resetIdx];
      const precedingEl = resetEl ? resetEl.previousElementSibling : null;
      const hasSeparatorBeforeReset = !!precedingEl && precedingEl.classList.contains('dd-separator');
      document.getElementById('explore-menu-btn').click();

      document.getElementById('advanced-menu-btn').click();
      await new Promise(r => setTimeout(r, 60));
      const advActions = [...document.querySelectorAll('#advanced-menu .dd-item')].map(e => e.dataset.action);
      document.getElementById('advanced-menu-btn').click();

      return {
        resetInExplore: resetIdx !== -1,
        hasSeparatorBeforeReset,
        advActions,
      };
    }
    """)
    problems = []
    if not result["resetInExplore"]:
        problems.append("expected 'Reset Pinned 3D Positions' in the Explore menu")
    if not result["hasSeparatorBeforeReset"]:
        problems.append("expected a separator immediately before 'Reset Pinned 3D Positions' in the Explore menu")
    if 'resetPinned3DPositions' in result["advActions"]:
        problems.append("expected 'Reset Pinned 3D Positions' to be GONE from the Advanced menu, not just duplicated")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Reset Pinned 3D Positions now lives in the Explore menu, after a separator, and is gone from the Advanced menu"


def check_toolbar_filter_groups_hidden_when_inactive(page):
    """Regression guard: the tab-scoped filter controls (View Scope, Stream, Types,
    Section, Connector Type, Layer Order, Highlight, Levels — since moved from the
    header toolbar into their own Filters panel, see check_filters_panel_moved_from_
    toolbar) are HIDDEN entirely (not just disabled) on a tab type they don't apply
    to, instead of sitting there disabled and confusing — reported directly: "Can the
    filters... be hidden unless active for the current tab? For example Highlight has
    no purpose and is confusing on other types of tabs." Checks all three tab types these controls
    actually differ across: a canvas tab (Stream/Types/Section/Levels visible; View
    Scope/Connector Type/Layer Order/Highlight hidden — those four are 3D-only), a 3D
    tab (the reverse: View Scope/Connector Type/Layer Order/Highlight visible, Levels
    hidden — canvas-only — Stream/Types/Section stay visible on both), and a table tab
    (catalog — ALL EIGHT hidden, since none of them apply there at all)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const groupIds = ['view3d-scope-group', 'stream-filter-group', 'element-type-filter-group', 'section-filter-group', 'connector-type-filter-group', 'view3d-layer-order-group', 'highlight-type-filter-group', 'connector-levels-group'];
      const hiddenMap = () => Object.fromEntries(groupIds.map(id => [id, document.getElementById(id).classList.contains('hidden')]));

      const view = store.doc.views[0];
      const canvasTab = app.createCanvasTab(view);
      app.switchToTab(canvasTab.id);
      app.render();
      await new Promise(r => setTimeout(r, 60));
      const onCanvas = hiddenMap();

      app.openOrSwitch3DView();
      await new Promise(r => setTimeout(r, 200));
      const on3D = hiddenMap();

      app.openOrSwitchCatalog('parts', 'Parts');
      await new Promise(r => setTimeout(r, 60));
      const onTable = hiddenMap();

      return { onCanvas, on3D, onTable };
    }
    """)
    r = result
    problems = []
    canvasExpectedHidden = {'view3d-scope-group': True, 'stream-filter-group': False, 'element-type-filter-group': False, 'section-filter-group': False, 'connector-type-filter-group': True, 'view3d-layer-order-group': True, 'highlight-type-filter-group': True, 'connector-levels-group': False}
    for gid, expectedHidden in canvasExpectedHidden.items():
        if r["onCanvas"][gid] != expectedHidden:
            problems.append(f"canvas tab: expected #{gid} hidden={expectedHidden}, got {r['onCanvas'][gid]}")
    view3dExpectedHidden = {'view3d-scope-group': False, 'stream-filter-group': False, 'element-type-filter-group': False, 'section-filter-group': False, 'connector-type-filter-group': False, 'view3d-layer-order-group': False, 'highlight-type-filter-group': False, 'connector-levels-group': True}
    for gid, expectedHidden in view3dExpectedHidden.items():
        if r["on3D"][gid] != expectedHidden:
            problems.append(f"3D tab: expected #{gid} hidden={expectedHidden}, got {r['on3D'][gid]}")
    for gid, hidden in r["onTable"].items():
        if not hidden:
            problems.append(f"table tab: expected #{gid} hidden=True (none of these apply to a catalog table), got False")
    if problems:
        return False, "; ".join(problems) + f" (full: {r})"
    return True, "toolbar filter groups (View Scope/Stream/Types/Section/Connector Type/Layer Order/Highlight/Levels) show/hide correctly per tab type -- canvas gets Stream/Types/Section/Levels, 3D gets everything except Levels, and a table tab hides all eight"


def check_script_console_runs_main_function(page):
    """Regression guard for the Script Console's new execution model: Run no longer
    executes the editor's text directly (the old REPL-style "evaluate this one entry"
    behavior) — it defines everything in the box, then calls exactly one predetermined
    top-level function, main(), which is free to call any other functions defined
    alongside it (all sharing one closure over the same bindings, so a helper doesn't
    need app/store re-passed to it). Reported directly: "change run command to run a
    specific predetermined function within the script file, something like 'main'. The
    users can then write multiple functions but run button only executes main, it in
    turn will call the others as desired." Also covers: the editor's text is
    store.batchScriptCode (a persistent "script file", not a one-off entry) — Run does
    NOT clear it afterward, and both Run and Close persist whatever's currently typed
    back to store.batchScriptCode (and its localStorage cache); missing a top-level
    main() is a clear, reported error rather than silently doing nothing."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const results = {};

      // main() calling a sibling function it didn't have to receive as a parameter --
      // both close over the same `app`/`store` bindings automatically.
      app.promptScriptConsole();
      await new Promise(r => setTimeout(r, 60));
      const box = document.querySelector('.modal-box.modal-box-console');
      const textarea = box.querySelector('#console-input');
      textarea.value = "function main() { return helper() + 1; }\\nfunction helper() { return store.doc.parts.length; }";
      const partsBefore = store.doc.parts.length;
      box.querySelector('.run').click();
      await new Promise(r => setTimeout(r, 200));
      const output1 = box.querySelector('#console-output').textContent;
      results.calledSiblingFunction = output1.includes(String(partsBefore + 1));
      results.textareaNotClearedAfterRun = textarea.value.includes('function main()');
      results.persistedAfterRun = store.batchScriptCode.includes('function helper()');

      // Missing main() -- clear, reported error, not silent.
      textarea.value = 'function notMain() { return 1; }';
      box.querySelector('.run').click();
      await new Promise(r => setTimeout(r, 100));
      const output2 = box.querySelector('#console-output').textContent;
      results.missingMainReportsError = /error/i.test(output2) && /main/i.test(output2);

      // Close persists too, not just Run.
      textarea.value = 'function main() { return "closed-edit"; }';
      box.querySelector('.cancel').click();
      await new Promise(r => setTimeout(r, 60));
      results.persistedAfterClose = store.batchScriptCode.includes('closed-edit');

      return results;
    }
    """)
    problems = []
    if not result["calledSiblingFunction"]:
        problems.append("expected main() to be able to call a sibling function defined in the same script, sharing the same app/store closure")
    if not result["textareaNotClearedAfterRun"]:
        problems.append("expected the editor's text to remain after Run — it's a persistent script file, not a one-off REPL entry")
    if not result["persistedAfterRun"]:
        problems.append("expected Run to persist the current text to store.batchScriptCode")
    if not result["missingMainReportsError"]:
        problems.append("expected a script with no top-level main() to report a clear error mentioning 'main'")
    if not result["persistedAfterClose"]:
        problems.append("expected Close to ALSO persist the current text to store.batchScriptCode, not just Run")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Script Console's Run button now calls a predetermined main() (which can call sibling functions), keeps the editor's text as a persistent script file, and persists edits on both Run and Close"


def check_script_console_run_function_picker(page):
    """Regression guard/new-feature check for the Script Console's Run function picker.
    Reported directly: "change the run button so user can select (from a sorted list of
    functions in the script file) a function from the script file to run, with main as
    the default." Run used to always call a hardcoded main(); it now calls whichever
    top-level function name is selected in a new #console-run-fn <select>, populated
    (alphabetically sorted) by scanning the editor's own text for `function Name(`
    declarations on every edit, defaulting to main() when present. Covers: the default
    script's own functions appear sorted with main present; editing the script rebuilds
    the list; running a non-main selection actually calls that function (not main); the
    previously-selected function is kept selected across an edit if it still exists,
    even when main is no longer present; and with neither the prior selection nor main
    present, selection falls back to the first name alphabetically."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const results = {};

      app.promptScriptConsole();
      await new Promise(r => setTimeout(r, 60));
      const box = document.querySelector('.modal-box.modal-box-console');
      const textarea = box.querySelector('#console-input');
      const sel = box.querySelector('#console-run-fn');

      const initialOptions = [...sel.options].map(o => o.value);
      results.initialOptionsSorted = JSON.stringify(initialOptions) === JSON.stringify([...initialOptions].sort());
      results.initialOptionsHasMain = initialOptions.includes('main');
      results.initialSelectedIsMain = sel.value === 'main';

      textarea.value = "function zeta() { return 'z'; }\\nfunction main() { return 'm'; }\\nfunction alpha() { return 'a'; }";
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      results.rebuiltOptionsSorted = JSON.stringify([...sel.options].map(o => o.value)) === JSON.stringify(['alpha', 'main', 'zeta']);
      results.rebuiltSelectionStaysMain = sel.value === 'main';

      sel.value = 'alpha';
      box.querySelector('.run').click();
      await new Promise(r => setTimeout(r, 150));
      results.ranSelectedNonMainFunction = box.querySelector('#console-output').textContent.includes('alpha() returned: "a"');

      // Selection (zeta) survives an edit that drops main entirely.
      sel.value = 'zeta';
      textarea.value = "function zeta() { return 'z2'; }\\nfunction beta() { return 'b'; }";
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      results.keepsPriorSelectionWhenMainGone = sel.value === 'zeta';

      // Neither main nor the prior selection (zeta) exists -- falls back to first alphabetically.
      textarea.value = "function gamma() { return 'g'; }\\nfunction delta() { return 'd'; }";
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      results.fallsBackToFirstAlphabetically = sel.value === 'delta';

      return results;
    }
    """)
    problems = []
    if not result["initialOptionsSorted"]:
        problems.append("expected the default script's function list to be sorted alphabetically")
    if not result["initialOptionsHasMain"]:
        problems.append("expected the default script's function list to include main")
    if not result["initialSelectedIsMain"]:
        problems.append("expected main to be selected by default")
    if not result["rebuiltOptionsSorted"]:
        problems.append("expected the function list to rebuild (sorted) after editing the script")
    if not result["rebuiltSelectionStaysMain"]:
        problems.append("expected main to stay selected across an edit where it's still present")
    if not result["ranSelectedNonMainFunction"]:
        problems.append("expected Run to call the selected non-main function (alpha), not main")
    if not result["keepsPriorSelectionWhenMainGone"]:
        problems.append("expected the previously-selected function (zeta) to stay selected after an edit that removes main but keeps zeta")
    if not result["fallsBackToFirstAlphabetically"]:
        problems.append("expected selection to fall back to the first function alphabetically when neither main nor the prior selection exists")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Script Console's Run button now offers a sorted, live-updating dropdown of the script's top-level functions (main selected by default) and Run calls whichever one is selected"


def check_batch_script_quickstart(page):
    """Regression guard/new-feature check for the built-in default batch script
    (store.batchScriptCode's out-of-the-box default, DEFAULT_BATCH_SCRIPT_CODE in
    state.js) — verifies main() actually runs its starter scripts in sequence, via
    the real Script Console UI. BatchScript_QuickStart: (1) Generate Industry with the
    built-in default industry data, not placed on any view; (2) a new View "Business
    Functions" of type "org" (Business Function Organization); (3) Populate From
    Template using "Enterprise Functions" inside that view; (4) the "mof" (Mainstream
    Operational Functions) section's rowCount changed from its default of 2 down to 1;
    (5) the view's own tab zoomed to 60%; (6) remap(app, tab, {pattern:'default'})
    running without error (a later-added step: 'org' is a section-based view type, so
    remap's own applyRemapLayout routes it through applyRemapLayoutSectioned rather
    than pattern-based freeform placement — 'pattern' is accepted but not itself
    meaningful there; this just proves the call is wired in and doesn't throw); (7) the
    3D View opened along the way; (8) "Done" written to the persistent Message Log (not
    just the Script Console's own output area). Then, reported directly: "add the
    insertSmartStream example into the main() script after 3d view" —
    BatchScript_InsertSmartStreamExample runs next (main() awaits QuickStart first, so
    this genuinely happens after the 3D View step, not concurrently), tracing from the
    "Production" Business Function QuickStart's own default industry data creates into
    a new "Smart Stream Example" freeform view/tab -- via connectorType 's' (Stream),
    not 'c' (Connector): 'c' also carries the section-reification BusinessOrganizationUnit
    Assignment edges, and since the default dataset now genuinely tags every function
    with a real Section, walking 'c' from Production would fan out into every OTHER
    function sharing its Section instead of staying scoped to Production's own chain.
    Then, reported directly (a follow-up in the same session): "add smart view check:
    missing connectors and derive hidden connections to example script main() after
    await BatchScript_InsertSmartStreamExample()" — BatchScript_SmartCheckViewExample
    runs next, calling smartCheckView(app, tab, {missingConnectors: true,
    deriveConnectors: true}) on that same "Smart Stream Example" tab (reusing it, same
    as BatchScript_RemapExample does below), logging "Smart Check View example done" —
    verified this doesn't disturb anything BatchScript_RemapExample later asserts (same
    part labels, same row grouping): on this exact topology it has nothing new to add
    (no off-view parts to bridge, no not-yet-placed same-pair connector), so it's a
    genuine no-op here, proven to actually run rather than just proven harmless. Then,
    reported directly (this
    session's own layout report): "The cleanest result of drawing the script resulting
    data 'Smart Stream Example' ... would be (in a 4 x 4 grid): General Actor
    Manufacturing Operation Consumer; Business Function Production; empty; General
    Actor Production Planning. Row 2: Business Capability Manage Manufacturing
    Operations; Business Process Manufacturing Operation Process; Business Process
    Production Planning Process; Business Capability Manage Production Planning. Row
    3: ... Application Capability ... Row 4: Data Entity ..." — BatchScript_RemapExample
    now uses pattern:'layered' (hierarchical rows by graph hop-distance, computed via
    computeLayerAssignment in commands.js — see its own doc comment) instead of
    'default' with edgeAssignment: BusinessFunction/GeneralActor land on layer 0 as
    true graph roots (no pinning needed — "turning off the requirement of general
    actor" from the original report is satisfied for free), and — the whole reason
    'layered' uses shortest-path rather than longest-path layering — Business
    Capability and Business Process end up on the SAME row (both are exactly 1 hop
    from a layer-0 root: Capability from its General Actor, Process from Production
    directly) even though a real Capability -> Process edge also exists, matching the
    requested layout exactly. Reuses the same "Smart Stream Example" tab (not opening
    a redundant second one), which ends up the ACTIVE tab once main() finishes (not
    the 3D tab — proving the later scripts really did run afterward, rather than
    main() silently stopping early). Direct follow-up, later in the same session:
    "update state.js default function BatchScript_InsertSmartStreamExample and
    DEFAULT_SMART_STREAM_PRESETS from showTypes: [...] to showTypes: [...]" —
    both broadened from 7 to 12 element types (adding BusinessService,
    ApplicationService, ApplicationProcess, dropping the never-actually-reachable
    TechnologyLogicalComponent), which genuinely changed what this SAME trace collected
    from the SAME built-in data: 10 more parts passed the filter, and 'layered' needed a
    5th row. Then, direct follow-up in the same session: "copy the newly updated
    BatchScript_InsertSmartStreamExample to BatchScript_InsertSmartStreamExample2 and
    revert the original back to the previous element list, including the
    DEFAULT_SMART_STREAM_PRESETS list. Call the BatchScript_InsertSmartStreamExample2
    after the original" — BatchScript_InsertSmartStreamExample (and
    DEFAULT_SMART_STREAM_PRESETS's own StreamSet1) reverted back to the original 7-type
    showTypes list, BatchScript_InsertSmartStreamExample2 added as a copy of the
    (now former) 12-type version, main() briefly running BOTH back to back. Then, direct
    follow-up in the same session: "in example script comment out call to
    BatchScript_InsertSmartStreamExample2" — main()'s call to
    BatchScript_InsertSmartStreamExample2() commented out (function definition kept,
    just not invoked by default), so main() is back to a single 7-type
    BatchScript_InsertSmartStreamExample pass — same part/row shape as immediately after
    the "revert the original" step above, before the (now-commented-out) second pass was
    ever added to main(). Same follow-up message also asked: "Problem, [it] is creating
    two duplicate nodes Data Entity 'Production Schedule', why?" — investigated and
    confirmed NOT a regression from any of this session's changes: it happens with the
    single 7-type pass alone too, and traces back to public/capabilities-general-
    SFCCE.json itself, which lists an entity named "Production Schedule" under BOTH the
    "Manufacturing Operations" and "Production Planning" Business Capabilities as two
    separate source records. Since v0.865 (see js/version.js's own changelog and
    DESIGN_DOCUMENT.md SS7.5), buildIndustryTree auto-derives every generated Part's id
    from its own full ancestor chain (Function -> Capability -> Entity) rather than
    string-matching/sharing ids across capabilities that happen to reuse the same entity
    name — a deliberate, previously-made and documented design choice, not something
    newly introduced here — so these become two genuinely distinct Parts (confirmed via
    each one's own distinct id) that simply share a label, the same as the pre-existing
    Application-layer "Manufacturing Operations"/"Production Planning" pairs already
    documented below. Then, direct follow-up in the same session: "in script console
    function main, after 'await BatchScript_RemapExample();' line add [an
    InsertSmartStreamExample2 call, a messageLog reminder, and a return] and remove
    from function BatchScript_InsertSmartStream2 the first if statement after 'let
    tab =...', replace with unconditional [a store.addView/createCanvasTab/
    switchToTab sequence]" (see main()/BatchScript_InsertSmartStreamExample2's own
    source, state.js, for the exact wording used) — main() now runs BOTH
    Insert Smart Stream examples every time (uncommented, and reordered to run
    InsertSmartStreamExample2 LAST, after RemapExample rather than right after the
    first InsertSmartStreamExample), and InsertSmartStreamExample2 now unconditionally
    builds its OWN separate "Smart Stream Example 2" view (via `store.addView`, not the
    old "reuse the active tab if it's already a freeform canvas" check) instead of
    topping up the first "Smart Stream Example" view — so the two showTypes traces
    (7-type and 12-type) now live on two genuinely independent views, and only the
    FIRST one ever gets Smart Check View/Remap run on it by main() itself; the second
    is left exactly as insertSmartStream places it, with a Message Log reminder (exact
    text given in the report, reproduced verbatim below) telling a person which
    settings to use if they want to Smart Check/Remap it too, interactively."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      app.promptScriptConsole();
      await new Promise(r => setTimeout(r, 60));
      // Each check runs on its own fresh page (see run_all.py's main()), so
      // store.batchScriptCode is still the real, unmodified default here.
      const box = document.querySelector('.modal-box.modal-box-console');

      box.querySelector('.run').click();
      await new Promise(r => setTimeout(r, 2500));
      const consoleOutput = box.querySelector('#console-output').textContent;
      box.querySelector('.cancel').click();
      await new Promise(r => setTimeout(r, 60));

      const view = store.findView('Business Functions');
      const mof = view ? (view.sections || []).find(s => s.sectionId === 'mof') : null;
      const tab = store.tabs.find(t => t.viewId === view?.id);
      const genActor = store.doc.parts.find(p => p.type === 'BusinessCapability');
      const view3dTab = store.tabs.find(t => t.type === '3d');
      const streamView = store.findView('Smart Stream Example');
      const streamTabsForView = streamView ? store.tabs.filter(t => t.viewId === streamView.id) : [];
      const streamView2 = store.findView('Smart Stream Example 2');
      const streamTabsForView2 = streamView2 ? store.tabs.filter(t => t.viewId === streamView2.id) : [];
      const streamVms2 = streamView2 ? store.viewMembersForView(streamView2.id).filter(v => v.objectType === 'part') : [];

      const streamVms = streamView ? store.viewMembersForView(streamView.id).filter(v => v.objectType === 'part') : [];
      // Group by row (y) so the 'layered' pattern's hierarchical structure can be
      // checked directly -- which TYPES share a row matters here, not just which type
      // sits at an extreme edge (that was the old edgeAssignment-based check).
      const typesByRow = {};
      for (const vm of streamVms) {
        const part = store.findPart(vm.objectId);
        const y = Math.round(vm.y);
        if (!typesByRow[y]) typesByRow[y] = new Set();
        typesByRow[y].add(part.type);
      }
      const rowYs = Object.keys(typesByRow).map(Number).sort((a, b) => a - b);
      const rowTypeSets = rowYs.map(y => [...typesByRow[y]].sort());

      return {
        viewCreated: !!view,
        viewType: view ? view.viewType : null,
        partsPlaced: view ? store.viewMembersForView(view.id).filter(v => v.objectType === 'part').length : 0,
        mofRowCount: mof ? mof.rowCount : null,
        zoom: tab ? tab.viewport.zoom : null,
        industryGenerated: !!genActor,
        messageLogHasDone: store.messageLog.some(e => JSON.stringify(e).includes('Done')),
        messageLogHasRemapDone: store.messageLog.some(e => JSON.stringify(e).includes('Remap example done')),
        messageLogHasSmartCheckDone: store.messageLog.some(e => JSON.stringify(e).includes('Smart Check View example done')),
        messageLogHasStream1Done: store.messageLog.some(e => JSON.stringify(e).includes('Insert Smart Stream example done')),
        messageLogHasStream2Done: store.messageLog.some(e => JSON.stringify(e).includes('Insert Smart Stream example 2 done')),
        consoleOutput,
        view3dOpened: !!view3dTab,
        streamExampleViewCreated: !!streamView,
        streamExamplePartLabels: streamVms.map(vm => store.findPart(vm.objectId).label),
        streamExampleSingleTab: streamTabsForView.length === 1,
        rowCount: rowYs.length,
        rowTypeSets,
        streamExample2ViewCreated: !!streamView2,
        streamExample2PartCount: streamVms2.length,
        streamExample2SingleTab: streamTabsForView2.length === 1,
        streamExample2TabIsActive: streamTabsForView2.length ? store.activeTabId === streamTabsForView2[0].id : false,
        messageLogHasReminder: store.messageLog.some(e => JSON.stringify(e).includes('example 2 created, now run smart check view (missing connectors; derive connectors) and remap (enterprise; layered; minimum crossings; minimum connector length; connectorOrder, streamOrder, streamName, entityType, nodeLevel, elementGroup)')),
      };
    }
    """)
    problems = []
    if not result["viewCreated"] or result["viewType"] != "org":
        problems.append(f"expected a new 'Business Functions' view of type 'org', got viewCreated={result['viewCreated']} viewType={result['viewType']}")
    if result["partsPlaced"] != 29:
        problems.append(f"expected all 29 'Enterprise Functions' template parts placed in the new view, got {result['partsPlaced']}")
    if result["mofRowCount"] != 1:
        problems.append(f"expected the 'mof' section's rowCount changed from its default 2 down to 1, got {result['mofRowCount']}")
    if result["zoom"] != 0.6:
        problems.append(f"expected the view's tab zoomed to 60% (0.6), got {result['zoom']}")
    if not result["view3dOpened"]:
        problems.append("expected the script to open the 3D View (app.openOrSwitch3DView()) along the way")
    if "error" in result["consoleOutput"].lower():
        problems.append(f"expected the script to run end-to-end (including its remap(app, tab, {{pattern:'default'}}) step) without reporting an error, got console output: {result['consoleOutput']}")
    if not result["industryGenerated"]:
        problems.append("expected Generate Industry (default 'general') to have actually run, producing at least one BusinessCapability part")
    if not result["messageLogHasDone"]:
        problems.append("expected 'Done' written to the persistent Message Log")
    if not result["streamExampleViewCreated"]:
        problems.append("expected main() to also run BatchScript_InsertSmartStreamExample after BatchScript_QuickStart, creating a 'Smart Stream Example' view")
    if not result["messageLogHasStream1Done"]:
        problems.append("expected 'Insert Smart Stream example done' written to the persistent Message Log -- BatchScript_InsertSmartStreamExample should have run")
    if not result["messageLogHasStream2Done"]:
        problems.append("expected 'Insert Smart Stream example 2 done' written to the persistent Message Log -- BatchScript_InsertSmartStreamExample2 should have run, now uncommented and moved to the end of main()")
    # 'Production Schedule' appears twice, not once: public/capabilities-general-
    # SFCCE.json itself lists it as an entity under BOTH the "Manufacturing Operations"
    # and "Production Planning" Business Capabilities as two separate source records,
    # and buildIndustryTree (since v0.865, see DESIGN_DOCUMENT.md SS7.5) auto-derives
    # every Part's id from its own full ancestor chain rather than sharing ids across
    # capabilities that happen to reuse an entity name -- a deliberate, previously-made
    # design choice, confirmed (not just assumed) via each part's own distinct id, not a
    # dedup failure and not something this function's own docstring history introduced.
    expected_stream_labels = sorted(['Production', 'Production Planning Process', 'Production Planning Consumer', 'Manage Production Planning', 'Manage Production Planning', 'Manufacturing Operations Process', 'Manufacturing Operations Consumer', 'Manage Manufacturing Operations', 'Manage Manufacturing Operations', 'Demand Forecast', 'Production Schedule', 'Production Schedule', 'Bill of Materials'])
    if sorted(result["streamExamplePartLabels"]) != expected_stream_labels:
        problems.append(f"expected BatchScript_InsertSmartStreamExample to trace the full chain from 'Production', got {sorted(result['streamExamplePartLabels'])}")
    if not result["streamExampleSingleTab"]:
        problems.append("expected exactly ONE tab open on the 'Smart Stream Example' view -- BatchScript_RemapExample should reuse InsertSmartStreamExample's own tab, not open a redundant second one")
    if not result["streamExample2ViewCreated"]:
        problems.append("expected BatchScript_InsertSmartStreamExample2 to create its own separate 'Smart Stream Example 2' view")
    if result["streamExample2PartCount"] != 23:
        problems.append(f"expected the broader 12-type trace to place 23 parts on 'Smart Stream Example 2' (same as the old one-pass 12-type shape), got {result['streamExample2PartCount']}")
    if not result["streamExample2SingleTab"]:
        problems.append("expected exactly ONE tab open on the 'Smart Stream Example 2' view")
    if not result["streamExample2TabIsActive"]:
        problems.append("expected the 'Smart Stream Example 2' tab to be the ACTIVE tab once main() finishes -- InsertSmartStreamExample2 now runs LAST and switches to its own new tab, proving it genuinely ran rather than main() stopping early")
    if not result["messageLogHasReminder"]:
        problems.append("expected the exact 'example 2 created, now run smart check view ...' reminder written to the persistent Message Log after InsertSmartStreamExample2")
    if not result["messageLogHasSmartCheckDone"]:
        problems.append("expected 'Smart Check View example done' written to the persistent Message Log -- BatchScript_SmartCheckViewExample should have run between InsertSmartStreamExample and RemapExample")
    if not result["messageLogHasRemapDone"]:
        problems.append("expected 'Remap example done' written to the persistent Message Log -- BatchScript_RemapExample should have run")
    # pattern:'layered' row structure (single 7-type pass, BatchScript_
    # InsertSmartStreamExample2 commented out of main() -- see this function's own
    # docstring): Function+Actors (layer 0), then Capability/Process together on one row
    # (both exactly 1 hop from a layer-0 root -- shortest-path layering, not
    # longest-path, is what merges same-hop-distance types onto one row regardless of a
    # direct Capability -> Process edge; see computeLayerAssignment's doc comment in
    # commands.js), then Application Capability (2 hops), then the lone Data Entity
    # row (3 hops).
    expected_row_type_sets = [
        sorted(['BusinessFunction', 'GeneralActor']),
        sorted(['BusinessProcess', 'BusinessCapability']),
        sorted(['ApplicationCapability']),
        sorted(['DataDataEntity']),
    ]
    if result["rowCount"] != 4:
        problems.append(f"expected BatchScript_RemapExample's pattern:'layered' to produce exactly 5 rows, got {result['rowCount']} ({result['rowTypeSets']})")
    elif result["rowTypeSets"] != expected_row_type_sets:
        problems.append(f"expected row type groupings {expected_row_type_sets}, got {result['rowTypeSets']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "main() (run via the real Script Console UI) runs BatchScript_QuickStart, BatchScript_InsertSmartStreamExample, BatchScript_SmartCheckViewExample, BatchScript_RemapExample, then BatchScript_InsertSmartStreamExample2 in sequence, with pattern:'layered' correctly producing the 4-row hierarchy the first (7-type) trace implies, InsertSmartStreamExample2 unconditionally building its own separate 'Smart Stream Example 2' view (23 parts, the 12-type trace) and ending as the ACTIVE tab, and the exact reminder message logged afterward -- with the two 'Production Schedule' Data Entity parts on the first view confirmed as genuinely distinct (not a dedup bug) by tracing back to the source SFCCE data and buildIndustryTree's own documented id-derivation behavior"


def check_script_console_remap_and_smart_check_bindings(page):
    """Regression guard: remap, smartCheckView, smartCheckNode, and insertSmartStream
    became callable from a Script Console main() (js/main.js's promptScriptConsole
    bindingNames/bindingValues), with their full options objects actually wired through
    end to end -- not just present as bindings. Reported directly: "add remap and the
    smartCheck functions too; add options as parameters for full functionality if you
    can" and (for insertSmartStream) "confirm this can be called by script along with
    parameters." Builds a small real view/part/connector graph directly via store, then
    drives remap (pattern:'none', a real sortKeys array), smartCheckView/smartCheckNode
    (with a downstream/upstream option pair that must actually filter, not just be
    accepted), and insertSmartStream (startPartIds/direction/showTypes on a fresh
    freeform view) purely through the real Script Console UI -- proving both that the
    bindings exist and that options passed through them have a genuine effect."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;

      const view = store.addView('RemapConsoleTest_' + Date.now());
      const partA = store.createPart({ type: 'Unknown', label: 'A', model: store.defaultModel, streams: [] });
      const partB = store.createPart({ type: 'Unknown', label: 'B', model: store.defaultModel, streams: [] });
      const partD = store.createPart({ type: 'Unknown', label: 'Downstream', model: store.defaultModel, streams: [] });
      const partE = store.createPart({ type: 'Unknown', label: 'Upstream', model: store.defaultModel, streams: [] });
      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: partA.id, x: 900, y: 900 });
      const vmB = store.createViewMember({ view: view.id, objectType: 'part', objectId: partB.id, x: 10, y: 10 });
      // A->B: both ends placed but the connector itself isn't -- for smartCheckView.
      const connAB = store.createConnector({ from: partA.id, to: partB.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      // A->D: downstream of seed A, D not placed at all -- for smartCheckNode's downstream option.
      store.createConnector({ from: partA.id, to: partD.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      // E->A: upstream of seed A, E not placed at all -- must NOT be pulled in with upstream:false.
      store.createConnector({ from: partE.id, to: partA.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });

      // Separate small chain for insertSmartStream, seeded from a specific instance.
      const fn = store.createPart({ type: 'BusinessFunction', label: 'ConsoleFn', model: store.defaultModel, streams: [] });
      const proc = store.createPart({ type: 'BusinessProcess', label: 'ConsoleProc', model: store.defaultModel, streams: [] });
      const cap = store.createPart({ type: 'ApplicationCapability', label: 'ConsoleCap', model: store.defaultModel, streams: [] });
      store.createConnector({ from: fn.id, to: proc.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      store.createConnector({ from: proc.id, to: cap.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      const issView = store.addView('InsertSmartStreamConsoleTest_' + Date.now(), 'ff');

      app.promptScriptConsole();
      await new Promise(r => setTimeout(r, 60));
      const box = document.querySelector('.modal-box.modal-box-console');
      const textarea = box.querySelector('#console-input');
      textarea.value = `
        function main() {
          const view = store.findView('${view.id}');
          const tab = app.createCanvasTab(view);
          app.switchToTab(tab.id);
          remap(app, tab, { pattern: 'none', sortKeys: ['type'] });
          smartCheckView(app, tab, { missingConnectors: true });
          smartCheckNode(app, tab, '${partA.id}', { missingConnectorsAndNodes: true, downstream: true, upstream: false });

          const issView = store.findView('${issView.id}');
          const issTab = app.createCanvasTab(issView);
          app.switchToTab(issTab.id);
          insertSmartStream(app, issTab, {
            connectorType: 'c', startPartIds: ['${fn.id}'], direction: 'both', endType: null,
            levels: null, showTypes: ['BusinessFunction', 'BusinessProcess', 'ApplicationCapability'],
          });
        }
      `;
      box.querySelector('.run').click();
      await new Promise(r => setTimeout(r, 300));
      const output = box.querySelector('#console-output').textContent;
      box.querySelector('.cancel').click();
      await new Promise(r => setTimeout(r, 60));

      const vms = store.viewMembersForView(view.id);
      const partVmObjectIds = new Set(vms.filter(v => v.objectType === 'part').map(v => v.objectId));
      const freshA = store.findViewMember(vmA.id);
      const freshB = store.findViewMember(vmB.id);

      const issVms = store.viewMembersForView(issView.id);
      const issPartLabels = issVms.filter(v => v.objectType === 'part').map(v => store.findPart(v.objectId).label).sort();
      const issConnCount = issVms.filter(v => v.objectType === 'connector').length;

      return {
        ranWithoutError: !/error/i.test(output),
        remapMovedNodes: (freshA.x !== 900 || freshA.y !== 900) && (freshB.x !== 10 || freshB.y !== 10),
        smartCheckViewAddedConnector: vms.some(v => v.objectType === 'connector' && v.objectId === connAB.id),
        downstreamNodeAdded: partVmObjectIds.has(partD.id),
        upstreamNodeNotAdded: !partVmObjectIds.has(partE.id),
        issPartLabels, issConnCount,
      };
    }
    """)
    problems = []
    if not result["ranWithoutError"]:
        problems.append("expected remap/smartCheckView/smartCheckNode/insertSmartStream to run via the Script Console without error")
    if not result["remapMovedNodes"]:
        problems.append("expected remap(app, tab, {pattern:'none', sortKeys:['type']}) to actually reposition the view's nodes")
    if not result["smartCheckViewAddedConnector"]:
        problems.append("expected smartCheckView(app, tab, {missingConnectors:true}) to add the missing A->B connector to the view")
    if not result["downstreamNodeAdded"]:
        problems.append("expected smartCheckNode(..., {missingConnectorsAndNodes:true, downstream:true, upstream:false}) to pull in the downstream-only node")
    if not result["upstreamNodeNotAdded"]:
        problems.append("expected smartCheckNode with upstream:false to NOT pull in the upstream-only node -- the direction option isn't actually filtering")
    if result["issPartLabels"] != ["ConsoleCap", "ConsoleFn", "ConsoleProc"] or result["issConnCount"] != 2:
        problems.append(f"expected insertSmartStream(app, issTab, {{startPartIds:[fn.id], direction:'both', showTypes:[...]}}) called from the console to trace and place the whole 3-part chain, got labels={result['issPartLabels']} connCount={result['issConnCount']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "remap, smartCheckView, smartCheckNode, and insertSmartStream are all callable from the Script Console's main(), and their options (pattern/sortKeys, missingConnectors, direction filters, and startPartIds/showTypes) genuinely take effect"


def check_script_console_reference_tab(page):
    """Regression guard for the Script Console's Console/Reference tab split.
    Reported directly: "the script console page is too long ... Update ... put [the
    reference info] in a table format ... Can a tab be created ... to only show
    reference details when user selects it? this leaves the two main windows ...
    wider." promptScriptConsole (main.js) now opens with the Console tab active
    (output+input visible, no bindings prose above them) and a separate Reference tab
    (hidden by default) holding a docs-table of every binding. Confirms: (1) on open,
    #console-output/#console-input are visible and the reference table is not; (2)
    clicking Reference shows the table and hides the console panes; (3) the table
    genuinely lists the bindings (including the 'clusters' remap pattern, which the
    old inline prose never mentioned); (4) the dialog uses the wider modal-box-console
    class, not the older, narrower modal-box-textedit."""
    result = js(page, """
    async () => {
      const app = window.dycadApp;
      app.promptScriptConsole();
      await new Promise(r => setTimeout(r, 60));
      const box = document.querySelector('.modal-box.modal-box-console');
      if (!box) return { found: false };

      const consolePane = box.querySelector('#console-tab-console');
      const referencePane = box.querySelector('#console-tab-reference');
      const consoleVisibleInitially = consolePane.style.display !== 'none' && box.querySelector('#console-output').offsetParent !== null;
      const referenceHiddenInitially = referencePane.style.display === 'none';

      box.querySelector('.console-tabs button[data-tab="reference"]').click();
      await new Promise(r => setTimeout(r, 30));
      const referenceVisibleAfterClick = referencePane.style.display !== 'none';
      const consoleHiddenAfterClick = consolePane.style.display === 'none';
      const tableText = referencePane.querySelector('table.docs-table')?.textContent || '';
      const mentionsRemapOptions = tableText.includes('remap(app, tab, options)') && tableText.includes('clusters') && tableText.includes('insertSmartStream');

      box.querySelector('.console-tabs button[data-tab="console"]').click();
      await new Promise(r => setTimeout(r, 30));
      const backToConsoleVisible = consolePane.style.display !== 'none';
      const backToReferenceHidden = referencePane.style.display === 'none';

      box.querySelector('.cancel').click();
      return {
        found: true, consoleVisibleInitially, referenceHiddenInitially,
        referenceVisibleAfterClick, consoleHiddenAfterClick, mentionsRemapOptions,
        backToConsoleVisible, backToReferenceHidden,
      };
    }
    """)
    problems = []
    if not result["found"]:
        return False, "expected Script Console to open with class 'modal-box modal-box-console' (the wider class) -- not found"
    if not result["consoleVisibleInitially"] or not result["referenceHiddenInitially"]:
        problems.append("expected the Console tab (output+input) visible and Reference tab hidden on open")
    if not result["referenceVisibleAfterClick"] or not result["consoleHiddenAfterClick"]:
        problems.append("expected clicking the Reference tab to show the bindings table and hide the console panes")
    if not result["mentionsRemapOptions"]:
        problems.append("expected the Reference tab's table to document remap's options including the 'clusters' pattern, and insertSmartStream")
    if not result["backToConsoleVisible"] or not result["backToReferenceHidden"]:
        problems.append("expected clicking back to the Console tab to re-show the console panes and re-hide the reference table")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Script Console opens on a wider Console tab (output+input, no inline bindings prose) with bindings/options moved to a separate Reference tab that toggles visibility correctly and documents the 'clusters' remap pattern"


def check_script_console_sizing_and_copy_buttons(page):
    """Regression guard, direct follow-up: "script console page still too long, barely
    fits at 80%. Make output window half the length and scrollable, and make reference
    part scrollable and have the length on open. Add 'copy' buttons to the three
    windows: output, script, reference to allow user to easily copy individually."
    Confirms: (1) #console-output is half its old 280px height (140px) and still
    scrollable (overflow-y auto); (2) #console-reference-scroll has a fixed height set
    the moment the dialog opens (not just after the tab is first clicked -- checked
    both before AND after clicking to Reference, same value both times) and is
    scrollable; (3) each of the three Copy buttons (.copy-output/.copy-script/
    .copy-reference) puts that exact pane's own text on the real clipboard, not some
    other pane's."""
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    result = js(page, """
    async () => {
      const app = window.dycadApp;
      app.promptScriptConsole();
      await new Promise(r => setTimeout(r, 60));
      const box = document.querySelector('.modal-box.modal-box-console');
      const outputEl = box.querySelector('#console-output');
      const refScroll = box.querySelector('#console-reference-scroll');
      const inputEl = box.querySelector('#console-input');

      const outputHeightPx = parseInt(outputEl.style.height, 10);
      const outputScrollable = getComputedStyle(outputEl).overflowY === 'auto';
      const refHeightOnOpen = refScroll.style.height;
      const refScrollableOnOpen = getComputedStyle(refScroll).overflowY === 'auto';

      // Put known, distinguishable text in output + script BEFORE copying, so a mixed-up
      // handler (e.g. copy-script grabbing outputEl instead of inputEl) is caught.
      outputEl.textContent = 'OUTPUT_MARKER_TEXT';
      inputEl.value = 'function main() { return 1; } // SCRIPT_MARKER_TEXT';

      box.querySelector('.copy-output').click();
      await new Promise(r => setTimeout(r, 30));
      const outputClip = await navigator.clipboard.readText();

      box.querySelector('.copy-script').click();
      await new Promise(r => setTimeout(r, 30));
      const scriptClip = await navigator.clipboard.readText();

      box.querySelector('.console-tabs button[data-tab="reference"]').click();
      await new Promise(r => setTimeout(r, 30));
      const refHeightAfterClick = refScroll.style.height;

      box.querySelector('.copy-reference').click();
      await new Promise(r => setTimeout(r, 30));
      const refClip = await navigator.clipboard.readText();

      box.querySelector('.cancel').click();
      return {
        outputHeightPx, outputScrollable, refHeightOnOpen, refScrollableOnOpen,
        outputClip, scriptClip, refHeightAfterClick, refClip,
      };
    }
    """)
    problems = []
    if result["outputHeightPx"] != 140:
        problems.append(f"expected #console-output height to be halved to 140px, got {result['outputHeightPx']}px")
    if not result["outputScrollable"]:
        problems.append("expected #console-output to stay scrollable (overflow-y: auto)")
    if not result["refHeightOnOpen"] or result["refHeightOnOpen"] == '0px':
        problems.append(f"expected #console-reference-scroll to have a real fixed height set immediately on open, got {result['refHeightOnOpen']!r}")
    if not result["refScrollableOnOpen"]:
        problems.append("expected #console-reference-scroll to be scrollable (overflow-y: auto)")
    if result["refHeightAfterClick"] != result["refHeightOnOpen"]:
        problems.append(f"expected the reference pane's height to stay fixed once switched to (not grow to fit content) -- on open: {result['refHeightOnOpen']!r}, after click: {result['refHeightAfterClick']!r}")
    if result["outputClip"] != 'OUTPUT_MARKER_TEXT':
        problems.append(f"Copy on the Output pane should copy exactly the output text, got clipboard={result['outputClip']!r}")
    if 'SCRIPT_MARKER_TEXT' not in result["scriptClip"]:
        problems.append(f"Copy on the Script pane should copy exactly the editor's text, got clipboard={result['scriptClip']!r}")
    if 'remap(app, tab, options)' not in result["refClip"] or 'clusters' not in result["refClip"]:
        problems.append(f"Copy on the Reference pane should copy the bindings table's text, got clipboard={result['refClip']!r}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Output pane is half-height (140px) and scrollable, the Reference pane has a real fixed height set on open (unchanged after switching to it) and is scrollable, and each of the three Copy buttons puts exactly that pane's own text on the clipboard"


def check_catalog_multi_column_sort(page):
    """Regression guard for the catalog table's multi-column sort (canvas.js
    renderTablePage, tab.sortColumns): a plain click sorts by exactly one column
    (unchanged, pre-multi-sort behavior); shift+click ADDS another column as a
    secondary tiebreaker without disturbing the first; a second shift+click on an
    already-active secondary column flips only its own direction; a later plain click
    discards every other criterion back down to one column. Reported directly: "can
    multi column sorting be supported? For example sorting parts by type and label."
    Uses the real Parts catalog tab and dispatches real click/shift+click DOM events on
    the header cells, then reads the actual rendered row order back out of the table."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;

      // Three parts chosen so type-only order differs from type-then-label order, and
      // so the two same-type parts are only disambiguated once label sort is added.
      const p1 = store.createPart({ type: 'Zeta', label: 'Beta', model: store.defaultModel, streams: [] });
      const p2 = store.createPart({ type: 'Zeta', label: 'Alpha', model: store.defaultModel, streams: [] });
      const p3 = store.createPart({ type: 'Alpha', label: 'Charlie', model: store.defaultModel, streams: [] });
      const ids = new Set([p1.id, p2.id, p3.id]);

      app.openOrSwitchCatalog('parts', 'Parts');
      await new Promise(r => setTimeout(r, 60));

      const readOrder = () => [...document.querySelectorAll('tr.catalog-row')]
        .map(tr => tr.dataset.id)
        .filter(id => ids.has(id));
      const clickHeader = (col, shift) => {
        const th = document.querySelector(`th.sortable-col[data-col="${col}"]`);
        th.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: !!shift }));
      };

      // Plain click 'type': ties (the two Zetas) keep their original relative order.
      clickHeader('type', false);
      await new Promise(r => setTimeout(r, 60));
      const afterTypeOnly = readOrder();

      // Shift+click 'label': 'type' stays primary, 'label' becomes the tiebreaker.
      clickHeader('label', true);
      await new Promise(r => setTimeout(r, 60));
      const afterTypeThenLabel = readOrder();

      // Shift+click 'label' again: flips ONLY label's direction, 'type' unaffected.
      clickHeader('label', true);
      await new Promise(r => setTimeout(r, 60));
      const afterLabelDescToggle = readOrder();

      // Plain click 'label': discards the 'type' criterion, sorts by label alone.
      clickHeader('label', false);
      await new Promise(r => setTimeout(r, 60));
      const afterLabelOnly = readOrder();

      return { afterTypeOnly, afterTypeThenLabel, afterLabelDescToggle, afterLabelOnly, p1: p1.id, p2: p2.id, p3: p3.id };
    }
    """)
    problems = []
    if result["afterTypeOnly"] != [result["p3"], result["p1"], result["p2"]]:
        problems.append(f"plain click on 'type' should sort Alpha-type first then the two Zeta-type parts in their original (stable) order, got {result['afterTypeOnly']}")
    if result["afterTypeThenLabel"] != [result["p3"], result["p2"], result["p1"]]:
        problems.append(f"shift+click on 'label' should keep 'type' as primary and add 'label' as tiebreaker, got {result['afterTypeThenLabel']}")
    if result["afterLabelDescToggle"] != [result["p3"], result["p1"], result["p2"]]:
        problems.append(f"a second shift+click on 'label' should flip only label's direction, leaving 'type' as primary, got {result['afterLabelDescToggle']}")
    if result["afterLabelOnly"] != [result["p2"], result["p1"], result["p3"]]:
        problems.append(f"a plain click on 'label' should discard the 'type' criterion and sort by label alone, got {result['afterLabelOnly']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "catalog table headers support multi-column sort: shift+click adds a column as a secondary tiebreaker, a second shift+click flips just that column's direction, and a plain click resets back to a single-column sort"


def check_sfce_table_multi_column_sort(page):
    """Regression guard: the SFCCE preview table (Catalogs > SFCE) reaches
    renderTablePage's tab.tableRows/tab.tableCols branch directly, not the catalogType
    branch check_catalog_multi_column_sort exercises -- confirms the same
    tab.sortColumns multi-column sort applies there too, not just to catalogType
    tables. Reported directly: "implement it for all catalogs and SFCCE.\""""
    result = js(page, """
    async () => {
      const app = window.dycadApp;
      const tab = app.openOrSwitchSfceCatalog('general');
      // Overwrite with a small synthetic dataset for a deterministic assertion --
      // still exercises the real tab.tableRows/tab.tableCols path (tab.catalogType is
      // unset on an SFCE tab).
      tab.tableRows = [
        { section: 'B', functionName: 'Beta' },
        { section: 'B', functionName: 'Alpha' },
        { section: 'A', functionName: 'Charlie' },
      ];
      app.render();
      await new Promise(r => setTimeout(r, 60));

      const clickHeader = (col, shift) => {
        const th = document.querySelector(`th.sortable-col[data-col="${col}"]`);
        th.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: !!shift }));
      };
      clickHeader('section', false);
      await new Promise(r => setTimeout(r, 60));
      clickHeader('functionName', true);
      await new Promise(r => setTimeout(r, 60));

      return {
        order: tab.tableRows.map(r => `${r.section}/${r.functionName}`),
        sortColumns: tab.sortColumns.map(s => `${s.col}:${s.dir}`),
      };
    }
    """)
    problems = []
    if result["order"] != ["A/Charlie", "B/Alpha", "B/Beta"]:
        problems.append(f"expected the SFCE table's rows sorted by 'section' then 'functionName' (A/Charlie, B/Alpha, B/Beta), got {result['order']}")
    if result["sortColumns"] != ["section:asc", "functionName:asc"]:
        problems.append(f"expected tab.sortColumns to record ['section:asc','functionName:asc'], got {result['sortColumns']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "the SFCCE preview table's tab.tableRows/tab.tableCols code path also honors multi-column sort (shift+click adds a tiebreaker), not just catalogType tables"


def check_spacing_scale_uniform(page):
    """Regression guard: increasing spacing once clamped edge-adjacent nodes to 0,
    compressing their nearest gap while other gaps scaled correctly."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.addView('RegrSpacing_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const positions = [0, 50, 120, 220, 900];
      const vms = positions.map((x, i) => {
        const part = store.createPart({ type: 'Unknown', label: 'N' + i, model: store.defaultModel, streams: [] });
        return store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x, y: 200 });
      });
      function gaps() { const g = []; for (let i = 1; i < vms.length; i++) g.push(vms[i].x - vms[i-1].x); return g; }
      const before = gaps();
      store.applySpacingScale(view.id, 2.0);
      const after = gaps();
      const ratios = before.map((g, i) => after[i] / g);
      const allConsistent = ratios.every(r => Math.abs(r - ratios[0]) < 0.05);
      return { ratios, allConsistent };
    }
    """)
    if not result["allConsistent"]:
        return False, f"gap ratios not uniform: {result['ratios']}"
    return True, f"all gaps scaled uniformly by {result['ratios'][0]:.2f}x, including the smallest edge-adjacent one"


def check_routing_avoids_obstacle(page):
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.addView('RegrRouting_' + Date.now());
      view.viewType = 'ff';
      view.nodeWidth = 130; view.nodeHeight = 46;
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const partA = store.createPart({ type: 'Unknown', label: 'A', model: store.defaultModel, streams: [] });
      const partBlocker = store.createPart({ type: 'Unknown', label: 'Blocker', model: store.defaultModel, streams: [] });
      const partB = store.createPart({ type: 'Unknown', label: 'B', model: store.defaultModel, streams: [] });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: partA.id, x: 100, y: 100 });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: partBlocker.id, x: 400, y: 100 });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: partB.id, x: 700, y: 100 });
      const conn = store.createConnector({ from: partA.id, to: partB.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      const vmA = store.viewMembersForView(view.id).find(v => v.objectId === partA.id);
      const vmB = store.viewMembersForView(view.id).find(v => v.objectId === partB.id);
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: vmA.id, toVmId: vmB.id });
      view.routingStyle = 'manhattan';
      app.render();
      await new Promise(r => setTimeout(r, 50));
      const path = document.querySelector('.edge-layer path:not(.edge-hit)');
      const d = path ? path.getAttribute('d') : '';
      const segmentCount = (d.match(/[ML]/g) || []).length;
      return { segmentCount, d };
    }
    """)
    if result["segmentCount"] < 3:
        return False, f"path looks unrouted (only {result['segmentCount']} points) — expected a detour around the blocker: {result['d']}"
    return True, f"Manhattan routing produced a {result['segmentCount']}-point detour around the blocker"


def check_archimate_import_fixture(page):
    fixture_path = ROOT / "tests" / "fixtures" / "mini_archimate.xml"
    xml_text = fixture_path.read_text()
    result = js(page, f"""
    async () => {{
      const app = window.dycadApp, store = app.store;
      const xmlText = {json.dumps(xml_text)};
      const blob = new Blob([xmlText], {{ type: 'application/xml' }});
      const file = new File([blob], 'mini_archimate.xml', {{ type: 'application/xml' }});
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('import-archimate-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {{ bubbles: true }}));
      await new Promise(r => setTimeout(r, 400));

      const view = store.doc.views.find(v => v.viewName === 'Mini View');
      if (!view) return {{ viewFound: false }};

      // junction bypass: A should connect directly to B (junction dissolved)
      const partA = store.doc.parts.find(p => p.label === 'A');
      const partB = store.doc.parts.find(p => p.label === 'B');
      const bypassConn = store.doc.connectors.find(c => c.from === partA.id && c.to === partB.id);
      const bypassPlaced = bypassConn ? store.viewMembersForView(view.id).some(v => v.objectType === 'connector' && v.objectId === bypassConn.id) : false;
      const noJunctionPart = !store.doc.parts.some(p => p.label === 'J');

      // nested composition: Whole/Part should be connected even with no explicit <connection>
      const partWhole = store.doc.parts.find(p => p.label === 'Whole');
      const partPart = store.doc.parts.find(p => p.label === 'Part');
      const compConn = store.doc.connectors.find(c => c.from === partWhole.id && c.to === partPart.id);
      const compPlaced = compConn ? store.viewMembersForView(view.id).some(v => v.objectType === 'connector' && v.objectId === compConn.id) : false;

      return {{ viewFound: true, bypassConnFound: !!bypassConn, bypassPlaced, noJunctionPart, compConnFound: !!compConn, compPlaced }};
    }}
    """)
    if not result.get("viewFound"):
        return False, "imported view not found"
    problems = [k for k, v in result.items() if k != "viewFound" and not v]
    if problems:
        return False, f"import checks failed: {problems} (full: {result})"
    return True, "junction bypass and nested-composition detection both worked on the fixture"


def check_timestamps(page):
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const part = store.createPart({ type: 'Unknown', label: 'TS', model: store.defaultModel, streams: [] });
      const formatOk = /^\\d{8}_\\d{6}$/.test(part.createdAt);
      const equalInitially = part.createdAt === part.updatedAt;
      const before = part.createdAt;
      await new Promise(r => setTimeout(r, 1100));
      store.touchPart(part);
      return { formatOk, equalInitially, createdUnchanged: part.createdAt === before, updatedChanged: part.updatedAt !== before };
    }
    """)
    problems = [k for k, v in result.items() if not v]
    if problems:
        return False, f"timestamp checks failed: {problems} (full: {result})"
    return True, "createdAt/updatedAt set correctly on creation; touchPart refreshes only updatedAt"


def check_section_drag_title_overlap(page):
    """Regression guard: pixelToNearestGrid once used section.rowCount directly for its
    hit-test zone instead of the actual computed body height, so a title-only section's
    (always-empty) hit-test region extended a full cellH below its header — silently
    swallowing drops into the TOP of whichever section immediately follows it and
    rejecting them, since title's elementTypes is always empty."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const sections = await import('./js/sections.js');
      const view = store.addView('RegrSectionDrag_' + Date.now());
      view.viewType = 'org';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      commands.populateFromTemplate(app, tab, 'Enterprise Functions');
      const layout = sections.computeSectionLayout(view);
      const audit = store.doc.parts.find(p => p.label === 'Audit');
      const esfEntry = layout.find(e => e.section.sectionId === 'esf');
      // 5px into esf's real body, immediately after the title section
      const snap = sections.pixelToNearestGrid(view, esfEntry.bodyLeft + 5, esfEntry.bodyTop + 5);
      return {
        resolvedSection: snap ? snap.layoutEntry.section.sectionId : null,
        allowed: snap ? sections.isTypeAllowedInSection(snap.layoutEntry.section, audit.type) : null,
      };
    }
    """)
    if result["resolvedSection"] != "esf" or not result["allowed"]:
        return False, f"drop near top of esf resolved to {result['resolvedSection']!r} (allowed={result['allowed']}) instead of esf/True"
    return True, "a drop 5px into the section immediately after 'title' correctly resolves to that section, not 'title'"


def check_section_drag_no_stacking(page):
    """Regression guard: dropping a node onto an already-occupied cell used to place it
    directly on top, hiding the existing node with no visual sign anything went wrong."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const sections = await import('./js/sections.js');
      const view = store.addView('RegrNoStack_' + Date.now());
      view.viewType = 'org';
      view.sections = [
        { viewType: 'org', sectionId: 'tiny', order: 0, name: 'Tiny', rowCount: 1, columnCount: 3, elementTypes: ['Unknown'] },
      ];
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const layout = sections.computeSectionLayout(view);
      const entry = layout.find(e => e.section.sectionId === 'tiny');
      function mkNode(label, row, col) {
        const part = store.createPart({ type: 'Unknown', label, model: store.defaultModel, streams: [] });
        const pos = sections.gridToPixel(entry, row, col);
        return store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x: pos.x, y: pos.y, sectionId: 'tiny' });
      }
      const n1 = mkNode('N1', 0, 0);
      const part2 = store.createPart({ type: 'Unknown', label: 'N2', model: store.defaultModel, streams: [] });
      const n2 = store.createViewMember({ view: view.id, objectType: 'part', objectId: part2.id, x: 800, y: 800, sectionId: '' });
      app.render();
      await new Promise(r => setTimeout(r, 50));
      const n2El = document.querySelector('#page-' + tab.id + ' .fnode[data-vm-id=\"' + n2.id + '\"]');
      const box = n2El.getBoundingClientRect();
      const targetX = box.left + (n1.x - n2.x), targetY = box.top + (n1.y - n2.y);
      n2El.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + 5, clientY: box.top + 5 }));
      await new Promise(r => setTimeout(r, 20));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: targetX, clientY: targetY }));
      await new Promise(r => setTimeout(r, 20));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: targetX, clientY: targetY }));
      await new Promise(r => setTimeout(r, 50));
      return { overlap: n1.x === n2.x && n1.y === n2.y, n2SectionId: n2.sectionId };
    }
    """)
    if result["overlap"]:
        return False, "dropped node landed exactly on top of the existing occupant"
    if result["n2SectionId"] != "tiny":
        return False, f"dropped node wasn't assigned to the target section (got {result['n2SectionId']!r})"
    return True, "dropping onto an occupied cell found a free cell in the same section instead of stacking"


def check_section_drag_grows_full_section(page):
    """Regression guard for the companion behavior: when a section is genuinely full,
    a drop into it should grow the section by a row rather than accept an overlap."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const sections = await import('./js/sections.js');
      const view = store.addView('RegrGrow_' + Date.now());
      view.viewType = 'org';
      view.sections = [
        { viewType: 'org', sectionId: 'tiny', order: 0, name: 'Tiny', rowCount: 1, columnCount: 1, elementTypes: ['Unknown'] },
      ];
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const layout = sections.computeSectionLayout(view);
      const entry = layout.find(e => e.section.sectionId === 'tiny');
      const part1 = store.createPart({ type: 'Unknown', label: 'N1', model: store.defaultModel, streams: [] });
      const pos1 = sections.gridToPixel(entry, 0, 0);
      const n1 = store.createViewMember({ view: view.id, objectType: 'part', objectId: part1.id, x: pos1.x, y: pos1.y, sectionId: 'tiny' });
      const part2 = store.createPart({ type: 'Unknown', label: 'N2', model: store.defaultModel, streams: [] });
      const n2 = store.createViewMember({ view: view.id, objectType: 'part', objectId: part2.id, x: 800, y: 800, sectionId: '' });
      app.render();
      await new Promise(r => setTimeout(r, 50));
      const rowCountBefore = view.sections[0].rowCount;
      const n2El = document.querySelector('#page-' + tab.id + ' .fnode[data-vm-id=\"' + n2.id + '\"]');
      const box = n2El.getBoundingClientRect();
      const targetX = box.left + (n1.x - n2.x), targetY = box.top + (n1.y - n2.y);
      n2El.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + 5, clientY: box.top + 5 }));
      await new Promise(r => setTimeout(r, 20));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: targetX, clientY: targetY }));
      await new Promise(r => setTimeout(r, 20));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: targetX, clientY: targetY }));
      await new Promise(r => setTimeout(r, 50));
      return { rowCountBefore, rowCountAfter: view.sections[0].rowCount, overlap: n1.x === n2.x && n1.y === n2.y };
    }
    """)
    if result["rowCountAfter"] <= result["rowCountBefore"]:
        return False, f"section didn't grow (before={result['rowCountBefore']}, after={result['rowCountAfter']})"
    if result["overlap"]:
        return False, "node still overlapped after the section was supposed to grow"
    return True, f"a completely full section grew from {result['rowCountBefore']} to {result['rowCountAfter']} rows instead of accepting an overlap"


def check_connector_popover_matches_panel(page):
    """Regression guard: the canvas edge-click popover for changing a connector's
    relationship once listed every relation unconditionally, unlike the property panel's
    Relationship select, which was already correctly filtered to the connector's actual
    from/to element types."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const rules = await import('./js/rules.js');
      const view = store.addView('RegrPopover_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const elTypes = (store.settings.elements || []).map(e => e.type);
      let chosen = null;
      const allCount = (store.settings.relations || []).length;
      outer:
      for (const t1 of elTypes.slice(0, 30)) {
        for (const t2 of elTypes.slice(0, 30)) {
          const opts = rules.validRelationOptions(store, t1, t2);
          if (opts.length > 0 && opts.length < allCount) { chosen = { t1, t2, opts }; break outer; }
        }
      }
      if (!chosen) return { skipped: true };
      const partA = store.createPart({ type: chosen.t1, label: 'A', model: store.defaultModel, streams: [] });
      const partB = store.createPart({ type: chosen.t2, label: 'B', model: store.defaultModel, streams: [] });
      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: partA.id, x: 0, y: 0 });
      const vmB = store.createViewMember({ view: view.id, objectType: 'part', objectId: partB.id, x: 200, y: 0 });
      const conn = store.createConnector({ from: partA.id, to: partB.id, model: store.defaultModel, connectorType: 'c', relationship: chosen.opts[0].name, streams: [] });
      const cvm = store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: vmA.id, toVmId: vmB.id });
      app.render();
      await new Promise(r => setTimeout(r, 50));
      app.showEdgePopover(cvm, conn, 300, 300);
      await new Promise(r => setTimeout(r, 30));
      const popoverKeys = [...document.querySelectorAll('.edge-popover select option')].map(o => o.value).sort();
      const expectedKeys = chosen.opts.map(o => o.key).sort();
      return { skipped: false, popoverKeys, expectedKeys, allCount, validCount: chosen.opts.length };
    }
    """)
    if result.get("skipped"):
        return True, "skipped — no restricted-subset type pair found to test with"
    if result["popoverKeys"] != result["expectedKeys"]:
        return False, f"popover showed {result['popoverKeys']} but valid options are {result['expectedKeys']}"
    return True, f"canvas popover correctly shows only {result['validCount']}/{result['allCount']} valid relations, matching the property panel"


def check_instructions_tab_on_startup(page):
    """Regression guard for the Instructions tab: it should be open and active on
    startup, its content should actually load (not just an empty/loading placeholder),
    and closing + reopening it via the help button should restore the same tab rather
    than silently failing or duplicating it."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const out = {};
      const activeTab = store.activeTab();
      out.activeIsDocs = activeTab && activeTab.type === 'docs';
      await new Promise(r => setTimeout(r, 300));
      const docsEl = document.querySelector('.docs-content');
      out.contentLoaded = !!docsEl && docsEl.textContent.includes('The Data Model');

      const docsTabId = store.tabs.find(t => t.type === 'docs')?.id;
      const closeBtn = [...document.querySelectorAll('.tab-item')]
        .find(el => el.textContent.includes('Instructions'))?.querySelector('.tab-close');
      closeBtn?.click();
      await new Promise(r => setTimeout(r, 30));
      out.closedOk = !store.tabs.some(t => t.type === 'docs');

      document.getElementById('help-btn').click();
      await new Promise(r => setTimeout(r, 300));
      out.reopenedSameTab = store.tabs.find(t => t.type === 'docs')?.id === docsTabId;
      out.contentStillThereAfterReopen = !!document.querySelector('.docs-content');

      return out;
    }
    """)
    problems = [k for k, v in result.items() if not v]
    if problems:
        return False, f"failed: {problems} (full: {result})"
    return True, "Instructions tab opens active on startup, loads real content, and closing/reopening restores the same tab"


def check_keyboard_focus_visible(page):
    """Regression guard for the other half of the same UI-writing audit ("do both"): a
    global :focus-visible style (css/styles.css) — every interactive element used to
    rely entirely on the browser's own unstyled default outline (verified fine in
    Chromium, but unbranded and not guaranteed elsewhere). Covers: (1) a real toolbar
    button (#file-menu-btn) gets a visible, on-brand outline (var(--accent), a real
    non-zero width) when focused; (2) a real dialog's own submit button and a text
    input both get it too, not just top-level chrome; (3) it does NOT collide with
    .fnode's own .selected outline — canvas nodes have no tabindex, so they can never
    themselves become :focus-visible, and a genuinely selected node keeps exactly its
    own outline color (var(--node-selected)), not the generic focus one."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const styleOf = (el) => {
        const cs = getComputedStyle(el);
        return { outlineStyle: cs.outlineStyle, outlineWidthPx: parseFloat(cs.outlineWidth), outlineColor: cs.outlineColor, matchesFocusVisible: el.matches(':focus-visible') };
      };
      const out = {};

      const homeTabEarly = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTabEarly.id);

      const menuBtn = document.getElementById('file-menu-btn');
      menuBtn.focus();
      out.menuBtn = styleOf(menuBtn);

      app.promptSmartCheckView();
      await new Promise(r => setTimeout(r, 30));
      // Levels input only renders visible (and so only becomes real-focusable) once
      // "Missing connectors and nodes" is checked -- same real flow a user follows.
      document.getElementById('scv-missing-connectors-nodes').checked = true;
      document.getElementById('scv-missing-connectors-nodes').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      const dialogInput = document.getElementById('scv-levels-input');
      dialogInput.focus();
      out.dialogInput = styleOf(dialogInput);
      const dialogSubmit = document.querySelector('.modal-overlay .submit');
      dialogSubmit.focus();
      out.dialogSubmit = styleOf(dialogSubmit);
      document.querySelector('.modal-overlay .cancel').click();

      // .fnode selection outline must stay its own color, unrelated to :focus-visible
      // (no tabindex anywhere in the app -- canvas nodes are never natively focusable)
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      const focusPart = store.createPart({ type: 'BusinessFunction', label: 'RegrFocusVisibleNode', model: store.defaultModel, streams: [] });
      const focusVm = store.createViewMember({ view: homeTab.viewId, objectType: 'part', objectId: focusPart.id, x: 40, y: 40 });
      homeTab.selection = new Set([focusVm.id]);
      app.render();
      await new Promise(r => setTimeout(r, 30));
      const fnodeEl = document.querySelector('.fnode.selected');
      out.selectedNodeFound = !!fnodeEl;
      if (fnodeEl) {
        const cs = getComputedStyle(fnodeEl);
        out.selectedNodeOutline = cs.outlineColor;
        out.selectedNodeMatchesFocusVisible = fnodeEl.matches(':focus-visible');
      }

      return out;
    }
    """)
    problems = []
    for name in ("menuBtn", "dialogInput", "dialogSubmit"):
        info = result[name]
        # Distinguish OUR explicit rule from a browser's own unstyled default outline
        # (Chromium's own default reports outlineStyle:'auto', outlineWidth:'1px' --
        # both real/nonzero, so a weaker "just check it's nonzero" assertion would
        # pass even with our :focus-visible rule completely missing).
        if info["outlineStyle"] != 'solid' or info["outlineWidthPx"] != 2:
            problems.append(f"expected {name} to have OUR explicit :focus-visible rule applied (outlineStyle:'solid', width:2px) rather than just a browser default, got {info}")
        if not info["matchesFocusVisible"]:
            problems.append(f"expected {name} to match :focus-visible when focus()'d programmatically, got {info}")
    if not result.get("selectedNodeFound"):
        problems.append("expected a selected node to render with class 'fnode selected'")
    elif result.get("selectedNodeMatchesFocusVisible"):
        problems.append("a canvas node must never itself match :focus-visible (no tabindex anywhere in this app) -- something changed that")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "A real toolbar button, and a real dialog's own input and submit button, all get a visible on-brand :focus-visible outline; canvas nodes stay outside the native focus system entirely, so a selected node's own outline color is never affected by this"


def check_mutation_toasts_log_to_message_log(page):
    """Regression guard for a UI-writing audit: "is toasts not going to the message log
    considered appropriate?", then "do both" (extend logging + fix keyboard focus, the
    other audit finding). app.toast(message, isError, alsoLog) (main.js) gained a third
    parameter -- alsoLog=true writes a routine SUCCESS toast to the Message Log too
    (isError=true already always did), used at every document-mutating command's own
    toast that reports a real outcome/count (Remap, Merge, Duplicate Stream/Section,
    Level Up, Import DDL, Auto-Detect Connectors, Add Existing, Populate From Template,
    Insert Smart Stream, Generate Industry/Inventory View, Section insert/remove,
    Delete-from-model, Sync Inventory Connector, Auto-Complete Streams). Covers: (1)
    the toast() primitive itself -- alsoLog=true logs a plain (non-'[Warning]') entry,
    alsoLog omitted/false does NOT log, isError=true always logs regardless of alsoLog;
    (2) three real, separately-implemented command flows spanning both main.js and
    commands.js (Merge Nodes and Remap, both commands.js; Insert Section, a main.js App
    method calling this.toast directly) actually reach the Message Log end to end
    through their own genuine call sites, not just the primitive; (3) a
    genuinely routine toast with no lasting value (a no-op "Nothing selected" toast)
    still does NOT log, proving this wasn't turned into "log everything.\""""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const out = {};

      // 1) the toast() primitive directly
      const before1 = store.messageLog.length;
      app.toast('RegrToastLog plain success, no log.');
      out.plainNotLogged = store.messageLog.length === before1;

      const before2 = store.messageLog.length;
      app.toast('RegrToastLog alsoLog success.', false, true);
      out.alsoLogLogged = store.messageLog.length === before2 + 1 && store.messageLog[store.messageLog.length - 1].message === 'RegrToastLog alsoLog success.';

      const before3 = store.messageLog.length;
      app.toast('RegrToastLog error, alsoLog false.', true, false);
      out.errorAlwaysLogged = store.messageLog.length === before3 + 1 && store.messageLog[store.messageLog.length - 1].message === '[Warning] RegrToastLog error, alsoLog false.';

      // 2a) Merge Nodes (main.js/commands.js real flow)
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      const view = store.addView('RegrToastLog_merge', 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const a = store.createPart({ type: 'BusinessFunction', label: 'RegrToastLogA', model, streams: [] });
      const b = store.createPart({ type: 'BusinessFunction', label: 'RegrToastLogB', model, streams: [] });
      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: a.id, x: 40, y: 40 });
      const vmB = store.createViewMember({ view: view.id, objectType: 'part', objectId: b.id, x: 200, y: 40 });
      const beforeMerge = store.messageLog.length;
      commands.mergePartsAndView(app, tab, [vmA.id, vmB.id], 'RegrToastLogMerged');
      out.mergeLogged = store.messageLog.slice(beforeMerge).some(e => e.message.includes('Merged') && e.message.includes('RegrToastLogMerged'));

      // 2b) Remap (real flow)
      const c = store.createPart({ type: 'BusinessFunction', label: 'RegrToastLogC', model, streams: [] });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: c.id, x: 40, y: 40 });
      const beforeRemap = store.messageLog.length;
      commands.remap(app, tab, { pattern: 'none' });
      out.remapLogged = store.messageLog.slice(beforeRemap).some(e => e.message.startsWith('Remapped'));

      // 2c) Insert Section -- a main.js App method calling this.toast directly (not
      // wrapped in a commands.js function), so this covers a genuinely different call
      // path than 2a/2b above
      const orgView = store.addView('RegrToastLog_org', 'org');
      const orgTab = app.createCanvasTab(orgView);
      app.switchToTab(orgTab.id);
      const beforeInsertSection = store.messageLog.length;
      app.insertSection(orgTab, null);
      out.insertSectionLogged = store.messageLog.slice(beforeInsertSection).some(e => e.message === 'Section inserted.');

      // 3) a genuinely routine no-op toast must NOT log
      app.switchToTab(tab.id);
      const beforeNoop = store.messageLog.length;
      app.promptSmartCheckView();
      await new Promise(r => setTimeout(r, 30));
      document.getElementById('scv-missing-connectors').checked = false;
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 30));
      out.noopNotLogged = store.messageLog.length === beforeNoop;

      return out;
    }
    """)
    problems = []
    if not result["plainNotLogged"]:
        problems.append("a plain success toast (no third arg) must NOT write to the Message Log")
    if not result["alsoLogLogged"]:
        problems.append(f"app.toast(msg, false, true) must write exactly that message (no '[Warning]' prefix) to the Message Log, got {result}")
    if not result["errorAlwaysLogged"]:
        problems.append(f"an error toast must always log with its '[Warning]' prefix regardless of alsoLog, got {result}")
    if not result["mergeLogged"]:
        problems.append("Merge Nodes' own real toast did not reach the Message Log")
    if not result["remapLogged"]:
        problems.append("Remap's own real toast did not reach the Message Log")
    if not result["insertSectionLogged"]:
        problems.append("Insert Section's own real toast (a main.js App method calling this.toast directly) did not reach the Message Log")
    if not result["noopNotLogged"]:
        problems.append("a genuinely routine no-op toast ('Nothing selected to check') must NOT write to the Message Log -- this wasn't meant to become log-everything")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "app.toast's new alsoLog parameter logs exactly the right thing (plain success toasts stay silent, alsoLog=true logs the exact message, errors always log with their prefix), and three real, independently-implemented command flows (Merge Nodes, Remap, Insert Section) genuinely reach the Message Log through their own call sites -- while a routine no-op toast still doesn't log"


def check_import_logs_to_message_log(page):
    """Regression guard: ArchiMate import's summary toast wasn't reaching the Message
    Log (only error-style toasts auto-log; the import success message needs explicit
    logging since it's genuinely worth keeping a record of)."""
    fixture_path = ROOT / "tests" / "fixtures" / "mini_archimate.xml"
    xml_text = fixture_path.read_text()
    result = js(page, f"""
    async () => {{
      const app = window.dycadApp, store = app.store;
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      const xmlText = {json.dumps(xml_text)};
      const blob = new Blob([xmlText], {{ type: 'application/xml' }});
      const file = new File([blob], 'mini_archimate.xml', {{ type: 'application/xml' }});
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('import-archimate-input');
      const beforeLogLen = store.messageLog.length;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {{ bubbles: true }}));
      await new Promise(r => setTimeout(r, 400));
      const newEntries = store.messageLog.slice(beforeLogLen);
      return {{ logged: newEntries.some(e => e.message.includes('ArchiMate Import') && e.message.includes('Imported ArchiMate model')) }};
    }}
    """)
    if not result["logged"]:
        return False, "ArchiMate import summary was not written to the Message Log"
    return True, "ArchiMate import summary correctly logged to the Message Log"


def check_section_rowcount_realigns_nodes(page):
    """Regression guard: changing a section's rowCount/columnCount left every node
    below it at its old absolute pixel position, out of alignment with the shifted
    section boundaries (rescaleSectionPositions existed but wasn't wired to this)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const sections = await import('./js/sections.js');
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      const view = store.addView('RegrRowCount_' + Date.now());
      view.viewType = 'org';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      commands.populateFromTemplate(app, tab, 'Enterprise Functions');
      app.render();
      await new Promise(r => setTimeout(r, 30));

      const mofSection = view.sections.find(s => s.sectionId === 'mof');
      const oldRowCount = mofSection.rowCount;
      mofSection.rowCount = 1;
      const oldSections = view.sections.map(s => s === mofSection ? { ...s, rowCount: oldRowCount } : s);
      sections.rescaleSectionPositions(store, view, { sections: oldSections });

      const layout = sections.computeSectionLayout(view);
      const cof = layout.find(e => e.section.sectionId === 'cof');
      const cofParts = store.viewMembersForView(view.id).filter(v => v.objectType === 'part' && v.sectionId === 'cof');
      const withinBounds = cofParts.every(v => v.x >= cof.bodyLeft && v.x < cof.bodyLeft + cof.width && v.y >= cof.bodyTop && v.y < cof.bodyTop + cof.bodyHeight);
      return { withinBounds, cofPartCount: cofParts.length };
    }
    """)
    if result["cofPartCount"] == 0:
        return False, "test setup produced no nodes in the section after the changed one"
    if not result["withinBounds"]:
        return False, "nodes in a later section landed outside its boundaries after an earlier section's rowCount changed"
    return True, "nodes in a later section stayed correctly aligned after an earlier section's rowCount shrank"


def check_toolbox_drag_to_canvas(page):
    """Regression guard for dragging a toolkit tile onto the canvas. Reported directly:
    "drag from toolkit to freeform canvas does not allow drop, mouse cursor stuck on
    hand symbol" -- traced to native HTML5 drag-and-drop (dragstart/dragover/drop),
    whose cursor feedback and drop delivery are notoriously OS/compositor-dependent (the
    app's only use of it), being replaced with a self-contained pointerdown/pointermove/
    pointerup drag (wireToolboxTileDrag, render.js) -- the same mechanism node-dragging/
    connect-drag/resize handles already use everywhere else in the app. Covers: a real
    drag (past the 3px threshold) onto the freeform canvas creates a part of the
    dragged element's type roughly at the drop point; a `.toolbox-drag-ghost` follows
    the cursor and `document.body`'s cursor becomes 'grabbing' mid-drag, both clearing
    on release; a plain click with no movement creates nothing; and releasing over the
    toolbox panel itself (never entering the canvas) creates nothing either."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      if (!store.defaultModel) store.defaultModel = 'ToolboxDragTestModel';
      const view = store.addView('ToolboxDragTest_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      app.render();
      await new Promise(r => setTimeout(r, 60));

      const tile = document.querySelector('#elements-grid .el-tile');
      const tileBox = tile.getBoundingClientRect();
      const scroll = document.querySelector('.canvas-scroll');
      const scrollBox = scroll.getBoundingClientRect();
      const startX = tileBox.left + tileBox.width / 2, startY = tileBox.top + tileBox.height / 2;
      const dropX = scrollBox.left + 200, dropY = scrollBox.top + 150;

      const results = {};

      // A genuine drag (past the movement threshold) onto the canvas.
      const partsBefore = store.doc.parts.length;
      tile.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startX, clientY: startY, button: 0 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: startX + 10, clientY: startY + 10 }));
      await new Promise(r => setTimeout(r, 20));
      const ghostMid = document.querySelector('.toolbox-drag-ghost');
      results.ghostVisibleMidDrag = !!ghostMid;
      results.ghostTextMidDrag = ghostMid ? ghostMid.textContent : null;
      results.bodyCursorMidDrag = document.body.style.cursor;
      results.expectedGhostText = tile.title;
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: dropX, clientY: dropY }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: dropX, clientY: dropY }));
      await new Promise(r => setTimeout(r, 50));
      results.ghostGoneAfterDrop = !document.querySelector('.toolbox-drag-ghost');
      results.bodyCursorResetAfterDrop = document.body.style.cursor === '';
      const partsAfterDrag = store.doc.parts.length;
      results.dragCreatedOnePart = partsAfterDrag === partsBefore + 1;
      const newPart = store.doc.parts[store.doc.parts.length - 1];
      const newVm = newPart ? store.viewMembersForView(view.id).find(v => v.objectType === 'part' && v.objectId === newPart.id) : null;
      results.newPartNearDropPoint = newVm ? (Math.abs(newVm.x - (200 - 60)) < 150 && Math.abs(newVm.y - (150 - 20)) < 150) : false;

      // A sub-3px jitter should stay below the drag-start threshold -- no ghost yet --
      // and the eventual click (still over the tile, well clear of the canvas) creates
      // nothing.
      const partsBeforeClick = store.doc.parts.length;
      tile.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startX, clientY: startY, button: 0 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: startX + 1, clientY: startY }));
      await new Promise(r => setTimeout(r, 10));
      results.noGhostForSubThresholdJitter = !document.querySelector('.toolbox-drag-ghost');
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: startX + 1, clientY: startY }));
      await new Promise(r => setTimeout(r, 30));
      results.plainClickCreatedNothing = store.doc.parts.length === partsBeforeClick;

      // Releasing back over the toolbox itself (never reaching the canvas) creates nothing.
      const partsBeforeOutside = store.doc.parts.length;
      tile.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startX, clientY: startY, button: 0 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: startX + 20, clientY: startY + 5 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: startX + 20, clientY: startY + 5 }));
      await new Promise(r => setTimeout(r, 30));
      results.releaseOutsideCanvasCreatedNothing = store.doc.parts.length === partsBeforeOutside;

      return results;
    }
    """)
    problems = []
    if not result["ghostVisibleMidDrag"] or result["ghostTextMidDrag"] != result["expectedGhostText"]:
        problems.append(f"expected a .toolbox-drag-ghost showing the dragged tile's title mid-drag (got visible={result['ghostVisibleMidDrag']}, text={result['ghostTextMidDrag']!r}, expected={result['expectedGhostText']!r})")
    if result["bodyCursorMidDrag"] != "grabbing":
        problems.append(f"expected document.body's cursor to be 'grabbing' mid-drag, got {result['bodyCursorMidDrag']!r}")
    if not result["ghostGoneAfterDrop"]:
        problems.append("expected the drag ghost to be removed after drop")
    if not result["bodyCursorResetAfterDrop"]:
        problems.append("expected document.body's cursor to be reset after drop")
    if not result["dragCreatedOnePart"]:
        problems.append("expected a real drag onto the freeform canvas to create exactly one new part")
    if not result["newPartNearDropPoint"]:
        problems.append("expected the new part to land near the drop point")
    if not result["plainClickCreatedNothing"]:
        problems.append("expected a plain click (sub-threshold jitter) on a toolkit tile to create nothing")
    if not result["noGhostForSubThresholdJitter"]:
        problems.append("expected sub-3px movement to stay below the drag-start threshold and never show a ghost")
    if not result["releaseOutsideCanvasCreatedNothing"]:
        problems.append("expected releasing outside the canvas (still over the toolbox) to create nothing")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "dragging a toolkit tile onto the freeform canvas (custom pointer-event drag, not native HTML5 DnD) shows a following ghost + grabbing cursor, creates the right part near the drop point, and correctly creates nothing on a plain click or a release outside the canvas"


def check_new_content_sized_and_non_overlapping(page):
    """Regression guard: Populate From Template, Generate Industry, and double-click-
    to-new-view all left nodes at whatever size the view previously had, requiring a
    manual Remap/Redraw; and the Redraw command itself resized without resolving the
    overlaps that resize could create."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const out = {};
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);

      const view = store.addView('RegrSizing_' + Date.now());
      view.viewType = 'org';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const widthBefore = view.nodeWidth;
      commands.populateFromTemplate(app, tab, 'Enterprise Functions');
      out.populateResized = view.nodeWidth !== widthBefore;

      const view3 = store.addView('RegrIndustry_' + Date.now());
      view3.viewType = 'ff';
      const tab3 = app.createCanvasTab(view3);
      app.switchToTab(tab3.id);
      if ((store.doc.industryTree || []).length > 0) {
        await commands.generateIndustry(app, () => {});
        const partVms = store.viewMembersForView(view3.id).filter(v => v.objectType === 'part');
        function overlap(v1, v2, w, h) { return !(v1.x+w<=v2.x || v2.x+w<=v1.x || v1.y+h<=v2.y || v2.y+h<=v1.y); }
        let overlapCount = 0;
        for (let i=0;i<partVms.length;i++) for (let j=i+1;j<partVms.length;j++) if (overlap(partVms[i],partVms[j],view3.nodeWidth,view3.nodeHeight)) overlapCount++;
        out.industryOverlapCount = overlapCount;
      } else {
        out.industryOverlapCount = 0;
      }

      const view4 = store.addView('RegrRedraw_' + Date.now());
      view4.viewType = 'ff';
      const tab4 = app.createCanvasTab(view4);
      app.switchToTab(tab4.id);
      for (let i = 0; i < 6; i++) {
        const part = store.createPart({ type: 'Unknown', label: 'Node ' + i + ' with a longer descriptive label', model: store.defaultModel, streams: [] });
        store.createViewMember({ view: view4.id, objectType: 'part', objectId: part.id, x: (i % 3) * 135, y: Math.floor(i/3) * 50 });
      }
      app.render();
      await new Promise(r => setTimeout(r, 30));
      // Redraw now opens a dialog (the new "Show all text" checkbox) instead of
      // running immediately -- click its own Redraw submit button.
      app.runCommand('redraw');
      await new Promise(r => setTimeout(r, 30));
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 50));
      const redrawVms = store.viewMembersForView(view4.id).filter(v => v.objectType === 'part');
      function overlap2(v1, v2, w, h) { return !(v1.x+w<=v2.x || v2.x+w<=v1.x || v1.y+h<=v2.y || v2.y+h<=v1.y); }
      let redrawOverlapCount = 0;
      for (let i=0;i<redrawVms.length;i++) for (let j=i+1;j<redrawVms.length;j++) if (overlap2(redrawVms[i],redrawVms[j],view4.nodeWidth,view4.nodeHeight)) redrawOverlapCount++;
      out.redrawOverlapCount = redrawOverlapCount;
      out.redrawGrew = view4.nodeWidth > 130;

      return out;
    }
    """)
    problems = []
    if not result["populateResized"]: problems.append("populateFromTemplate didn't resize")
    if result["industryOverlapCount"] > 0: problems.append(f"generateIndustry left {result['industryOverlapCount']} overlaps")
    if result["redrawOverlapCount"] > 0: problems.append(f"redraw command left {result['redrawOverlapCount']} overlaps")
    if not result["redrawGrew"]: problems.append("redraw command didn't grow node size for long labels")
    if problems:
        return False, "; ".join(problems)
    return True, "populateFromTemplate resizes automatically, generateIndustry produces no overlaps, and the Redraw command both resizes and resolves overlaps"


def check_smart_check_view_default_levels_unlimited(page):
    """Regression guard: Smart Check View's Levels field should default to blank
    (unlimited/"All"), not 1."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      app.promptSmartCheckView();
      await new Promise(r => setTimeout(r, 30));
      document.getElementById('scv-missing-connectors-nodes').checked = true;
      document.getElementById('scv-missing-connectors-nodes').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      const value = document.getElementById('scv-levels-input').value;
      document.querySelector('.modal-overlay .cancel')?.click();
      return { value };
    }
    """)
    if result["value"] != "":
        return False, f"Levels field defaulted to {result['value']!r}, expected blank (unlimited)"
    return True, "Smart Check View's Levels field defaults to blank (unlimited)"


def check_smart_check_view_dialog_derive_checkbox_wiring(page):
    """Regression guard for the real Smart Check View DIALOG's new "Derive hidden
    connections" checkbox (#scv-derive-connectors, main.js) -- confirms it's genuinely
    wired end to end through the actual UI, not just the underlying commands.js
    function (covered separately by check_smart_check_view_derive_connectors). Checks:
    (1) unchecked by default; (2) checking it (with 'Missing connectors and nodes'
    left OFF) alone reveals the Levels row -- proving Levels' visibility now depends on
    EITHER checkbox, not just missingConnectorsAndNodes; (3) submitting with only this
    checkbox checked genuinely creates the derived connector on the view via the real
    Check button, not just via a direct function call."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const fn = store.createPart({ type: 'BusinessFunction', label: 'RegrSCVDlg_Fn', model, streams: [] });
      const proc = store.createPart({ type: 'BusinessProcess', label: 'RegrSCVDlg_Proc', model, streams: [] }); // left off the view
      const cap = store.createPart({ type: 'ApplicationCapability', label: 'RegrSCVDlg_Cap', model, streams: [] });
      store.createConnector({ from: fn.id, to: proc.id, connectorType: 'c', model, relationship: 'Association' });
      store.createConnector({ from: proc.id, to: cap.id, connectorType: 'c', model, relationship: 'Association' });
      const view = store.addView('RegrSCVDlg_view', 'ff');
      store.createViewMember({ view: view.id, objectType: 'part', objectId: fn.id, x: 40, y: 40 });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: cap.id, x: 300, y: 40 });
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      app.promptSmartCheckView();
      await new Promise(r => setTimeout(r, 30));
      const deriveCb = document.getElementById('scv-derive-connectors');
      const levelsRow = document.getElementById('scv-levels-row');
      const out = { checkedByDefault: deriveCb.checked, levelsHiddenBefore: levelsRow.classList.contains('hidden') };

      deriveCb.checked = true;
      deriveCb.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      out.levelsVisibleAfterCheckingDerive = !levelsRow.classList.contains('hidden');

      document.getElementById('scv-missing-connectors').checked = false; // isolate to JUST the derive checkbox
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 60));

      const connVms = store.viewMembersForView(view.id).filter(v => v.objectType === 'connector');
      out.derivedPlacedOnView = connVms.some(v => {
        const c = store.findConnector(v.objectId);
        return c && c.from === fn.id && c.to === cap.id && (c.note || '').includes('Derived');
      });
      return out;
    }
    """)
    problems = []
    if result["checkedByDefault"]:
        problems.append("expected #scv-derive-connectors unchecked by default")
    if not result["levelsHiddenBefore"]:
        problems.append("expected the Levels row hidden before either checkbox is checked")
    if not result["levelsVisibleAfterCheckingDerive"]:
        problems.append("expected checking Derive hidden connections (alone) to reveal the Levels row")
    if not result["derivedPlacedOnView"]:
        problems.append("expected submitting with ONLY Derive hidden connections checked to actually place a derived connector on the view via the real dialog")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Smart Check View's real dialog wires up the new Derive hidden connections checkbox correctly: unchecked by default, reveals the shared Levels row on its own, and submitting with only it checked genuinely creates and places the derived connector"


def check_smart_check_view_copy_call_on_right_click(page):
    """Regression guard, direct follow-up: "updated smart view check 'check' button
    right-click to copy function with parameter call matching options set, same
    behaviour as in other dialogs" — Smart Check View's Check button now uses the same
    wireCopyCallOnRightClick helper Remap's own submit button already does (see
    check_remap_copy_call_on_right_click). Covers: right-clicking Check copies a
    `smartCheckView(app, tab, {...})` snippet reflecting the CURRENT form values (not
    stale ones from open time); the snippet includes every one of smartCheckView's own
    option keys but NOT the dialog's other, unrelated fields (Auto-complete streams'
    own checkbox/template select, which drive a completely separate action,
    promptAutoCompleteStreams, never part of the smartCheckView(...) call itself); and
    — critically — right-clicking must NOT actually submit the form (dialog stays
    open, nothing gets checked/added), distinguishing it from a real click."""
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);

      app.promptSmartCheckView();
      await new Promise(r => setTimeout(r, 30));
      const box = document.querySelector('.modal-overlay .modal-box');
      document.getElementById('scv-missing-connectors').checked = false;
      document.getElementById('scv-missing-connectors-nodes').checked = true;
      document.getElementById('scv-missing-connectors-nodes').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      document.getElementById('scv-levels-input').value = '3';
      document.getElementById('scv-derive-connectors').checked = true;
      document.getElementById('scv-autocomplete').checked = true; // unrelated field -- must NOT leak into the copied call

      const beforeConnCount = store.doc.connectors.length;
      const submitBtn = box.querySelector('.submit');
      submitBtn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 60));

      const out = {};
      out.dialogStillOpen = !!document.querySelector('.modal-overlay .modal-box');
      out.nothingChecked = store.doc.connectors.length === beforeConnCount;
      try {
        out.clipboardText = await navigator.clipboard.readText();
      } catch (e) {
        out.clipboardReadFailed = e.message;
      }
      box.querySelector('.cancel').click();
      return out;
    }
    """)
    problems = []
    if not result.get("dialogStillOpen"):
        problems.append("right-clicking Check should NOT close the dialog (that's what a real left-click/submit does)")
    if not result.get("nothingChecked"):
        problems.append("right-clicking Check should NOT actually run Smart Check View")
    clip = result.get("clipboardText")
    if not clip:
        problems.append(f"right-click should copy a snippet to the clipboard, got clipboardText={clip!r} (read error: {result.get('clipboardReadFailed')})")
    else:
        if not clip.startswith("smartCheckView(app, tab,"):
            problems.append(f"copied snippet should be a smartCheckView(app, tab, {{...}}) call, got: {clip[:120]!r}")
        for key in ["missingConnectors", "missingConnectorsAndNodes", "levels", "syncWithInventory", "deriveConnectors"]:
            if key not in clip:
                problems.append(f"copied snippet should include '{key}', got: {clip[:400]!r}")
        if '"missingConnectors": false' not in clip or '"missingConnectorsAndNodes": true' not in clip or '"levels": 3' not in clip or '"deriveConnectors": true' not in clip:
            problems.append(f"copied snippet should reflect the CURRENT form values, got: {clip[:400]!r}")
        if "autoComplete" in clip.lower():
            problems.append(f"copied snippet must NOT include the Auto-complete streams fields (a separate action, not part of smartCheckView's own call), got: {clip[:400]!r}")
    if problems:
        return False, "; ".join(problems) + f" (full result: {result})"
    return True, "right-clicking Smart Check View's Check button copies a valid smartCheckView(app, tab, {...}) call reflecting the current form (and only smartCheckView's own options, not the unrelated Auto-complete streams fields) to the clipboard, without actually submitting"


def check_force_directed_options(page):
    """Regression guard for the two new force-directed Remap options: preferRightPlacement
    (place connected nodes to the right when a cell is free) and onlyNewRowForNewGroup
    (row only changes for a genuinely new BFS-depth group, so same-depth siblings share
    a row instead of scattering)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      const out = {};

      const view1 = store.addView('RegrForceRight_' + Date.now());
      view1.viewType = 'ff';
      const tab1 = app.createCanvasTab(view1);
      app.switchToTab(tab1.id);
      const pA = store.createPart({ type: 'Unknown', label: 'a', model: store.defaultModel, streams: [] });
      const pB = store.createPart({ type: 'Unknown', label: 'b', model: store.defaultModel, streams: [] });
      const vA = store.createViewMember({ view: view1.id, objectType: 'part', objectId: pA.id, x: 0, y: 0 });
      const vB = store.createViewMember({ view: view1.id, objectType: 'part', objectId: pB.id, x: 200, y: 0 });
      const cAB = store.createConnector({ from: pA.id, to: pB.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      store.createViewMember({ view: view1.id, objectType: 'connector', objectId: cAB.id, fromVmId: vA.id, toVmId: vB.id });
      commands.applyRemapLayout(app, view1.id, { pattern: 'force', forcePreferRight: true });
      out.sameRow = vA.y === vB.y;
      out.horizontalOffset = vA.x !== vB.x;

      const view2 = store.addView('RegrForceGroup_' + Date.now());
      view2.viewType = 'ff';
      const tab2 = app.createCanvasTab(view2);
      app.switchToTab(tab2.id);
      const pR = store.createPart({ type: 'Unknown', label: 'R', model: store.defaultModel, streams: [] });
      const pX = store.createPart({ type: 'Unknown', label: 'X', model: store.defaultModel, streams: [] });
      const pY = store.createPart({ type: 'Unknown', label: 'Y', model: store.defaultModel, streams: [] });
      const vR = store.createViewMember({ view: view2.id, objectType: 'part', objectId: pR.id, x: 0, y: 0 });
      const vX = store.createViewMember({ view: view2.id, objectType: 'part', objectId: pX.id, x: 100, y: 0 });
      const vY = store.createViewMember({ view: view2.id, objectType: 'part', objectId: pY.id, x: 200, y: 0 });
      for (const [p1, p2, v1, v2] of [[pR,pX,vR,vX],[pR,pY,vR,vY]]) {
        const c = store.createConnector({ from: p1.id, to: p2.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
        store.createViewMember({ view: view2.id, objectType: 'connector', objectId: c.id, fromVmId: v1.id, toVmId: v2.id });
      }
      commands.applyRemapLayout(app, view2.id, { pattern: 'force', forceGroupRows: true });
      out.siblingsSameRow = vX.y === vY.y;
      out.siblingsDifferentFromRoot = vX.y !== vR.y;

      return out;
    }
    """)
    problems = [k for k, v in result.items() if not v]
    if problems:
        return False, f"failed: {problems} (full: {result})"
    return True, "preferRightPlacement places connected nodes horizontally; onlyNewRowForNewGroup keeps same-depth siblings on one row"


def check_sfce_import_and_generate(page):
    """Regression guard for Load SFCE: parses a small nested JSON fixture (mirroring
    capabilities.json's real shape — an outer array of groups, each with a nested array
    of items), detects a Function name repeated across Sections (not a capability split
    across sections — see detectSharedFunctions's own doc comment for why that
    distinction matters), resolves it both ways, stores a section-tagged industry tree,
    and confirms Generate Industry actually sets the section field on the generated
    Function part — a real bug this session: the "Enterprise" template creates its
    Function node via the passive-node code path, not the main template loop, so the
    section value silently never reached the generated part until fixed."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const sfce = await import('./js/sfce.js');
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);

      const fixture = [
        { domain: 'Domain One', capabilities: [
          { name: 'Cap A', description: 'desc A', ministries: ['Sec1'] },
          { name: 'Cap B', description: 'desc B', ministries: ['Sec2'] },
          { name: 'Cap C', description: '', ministries: [] },
        ]},
        { domain: 'Domain Two', capabilities: [
          { name: 'Cap D', description: 'desc D', ministries: ['Sec2'] },
        ]},
      ];

      const { records, fields } = sfce.flattenJsonRecords(fixture);
      const mapping = { sectionField: 'capabilities.ministries', functionField: 'domain', capabilityField: 'capabilities.name', capabilityDescriptionField: 'capabilities.description', entityField: null };
      const parsed = sfce.buildRowsFromRecords(records, mapping);
      const { sectionsByFunction, sharedFunctionNames } = sfce.detectSharedFunctions(parsed.rows);
      const resolved = sfce.resolveSharedFunctions(parsed.rows, sectionsByFunction, sharedFunctionNames, true);
      const { tree, stats } = sfce.buildIndustryTree(resolved);
      // Only one industry dataset exists (store.doc.industryTree) — setting it directly
      // is exactly what Load SFCCE's own wizard does (finishSFCCEImport), replacing
      // whatever the boot default loaded. Registering 'SFCCE' here is required now that
      // buildIndustryTree always produces a 4-level tree (Application Capability
      // cascades from Capability when unmapped, same as here): without it
      // generateIndustry defaults to 'Enterprise', which has no Application Capability
      // concept and would reject every Application Capability-typed child as an invalid
      // entity, producing zero jobs.
      store.doc.industryTree = tree;
      store.doc.industryTemplateName = 'SFCCE';

      const view = store.addView('SFCERegr_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const before = store.doc.parts.length;
      let threw = null;
      try { await commands.generateIndustry(app, () => {}); } catch (e) { threw = e.message; }
      const created = store.doc.parts.length - before;

      const funcParts = store.doc.parts.filter(p => p.type === 'BusinessFunction');

      return {
        recordCount: records.length,
        fieldsHasMinistries: fields.includes('capabilities.ministries'),
        domainOneIsShared: sharedFunctionNames.has('Domain One'),
        domainTwoIsShared: sharedFunctionNames.has('Domain Two'),
        sectionOrder: stats.sectionOrder,
        functionCount: stats.functionCount,
        threw,
        partsCreatedFromNoEntityData: created,
        functionPartsCount: funcParts.length,
        functionPartsAllHaveSection: funcParts.length > 0 && funcParts.every(p => !!p.section),
      };
    }
    """)
    problems = []
    if result["recordCount"] != 4: problems.append(f"expected 4 flattened records, got {result['recordCount']}")
    if not result["fieldsHasMinistries"]: problems.append("flattening lost the nested 'ministries' field")
    if not result["domainOneIsShared"]: problems.append("'Domain One' (spans Sec1 and Sec2) should be detected as a shared Function")
    if result["domainTwoIsShared"]: problems.append("'Domain Two' (only Sec2) should NOT be detected as shared")
    if result["threw"]: problems.append(f"generateIndustry threw: {result['threw']}")
    if result["partsCreatedFromNoEntityData"] == 0: problems.append("generateIndustry produced nothing for capabilities with no entity children")
    if not result["functionPartsAllHaveSection"]: problems.append("generateIndustry left the section field unset on a generated Function part")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, f"detected the shared Function correctly, and Generate Industry set section on all {result['functionPartsCount']} generated Function parts"


def check_generate_industry_no_collapse_keeps_functions_separate(page):
    """Regression guard for a subtle real bug: when a shared Function's sections are
    NOT collapsed, each section gets its own Function copy with a numbered suffix
    (Domain One / Domain One1) — but the second copy's own generated parts (built via
    the "Enterprise" template's passive-node path) were being silently swallowed into
    the FIRST copy's parts, because the passive-node reuse check matched on stream name
    alone. Two different generateIndustry jobs can share a stream name legitimately
    (most commonly when a capability has no distinct entity and its own name becomes
    the stream name), so the check needed to also verify the label matched — otherwise
    the second Function (and its whole branch) just vanished."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const sfce = await import('./js/sfce.js');
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);

      const fixture = [
        { domain: 'Domain One', capabilities: [
          { name: 'Cap A', description: 'd', ministries: ['SecA'] },
          { name: 'Cap B', description: 'd', ministries: ['SecA', 'SecB'] },
        ]},
      ];
      const { records } = sfce.flattenJsonRecords(fixture);
      const mapping = { sectionField: 'capabilities.ministries', functionField: 'domain', capabilityField: 'capabilities.name', capabilityDescriptionField: 'capabilities.description', entityField: null };
      const { rows } = sfce.buildRowsFromRecords(records, mapping);
      const { sectionsByFunction, sharedFunctionNames } = sfce.detectSharedFunctions(rows);
      const resolved = sfce.resolveSharedFunctions(rows, sectionsByFunction, sharedFunctionNames, false);
      const { tree } = sfce.buildIndustryTree(resolved);
      store.doc.industryTree = tree; // see check_sfce_import_and_generate's own comment on this line
      store.doc.industryTemplateName = 'SFCCE';

      const view = store.addView('SFCENoCollapse_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      await commands.generateIndustry(app, () => {});

      const funcParts = store.doc.parts.filter(p => p.type === 'BusinessFunction');
      return {
        treeFunctionCount: tree.length,
        funcPartLabels: funcParts.map(p => ({ label: p.label, section: p.section })).sort((a, b) => a.label.localeCompare(b.label)),
      };
    }
    """)
    if result["treeFunctionCount"] != 2:
        return False, f"test setup itself is wrong — expected 2 function nodes in the tree, got {result['treeFunctionCount']}"
    labels = {f["label"]: f["section"] for f in result["funcPartLabels"]}
    if "Domain One" not in labels or "Domain One1" not in labels:
        return False, f"expected both 'Domain One' and 'Domain One1' as separate parts, got: {result['funcPartLabels']}"
    if labels["Domain One"] != "SecA" or labels["Domain One1"] != "SecB":
        return False, f"function parts have the wrong section: {result['funcPartLabels']}"
    return True, "the second shared-Function copy ('Domain One1') generated its own separate part instead of being swallowed into the first"


def check_enterprise_template_is_short_default(page):
    """Regression guard: "Enterprise" was replaced with a shortened template (stays the
    default), and the original was renamed "Enterprise Full" — confirms both exist with
    the right relative sizes, not that a rename accidentally dropped one or left the
    default pointing at the wrong one."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const templates = store.settings.streamTemplates || [];
      const ent = templates.find(t => t.name === 'Enterprise');
      const entFull = templates.find(t => t.name === 'Enterprise Full');
      return {
        entExists: !!ent, entFullExists: !!entFull,
        entValueLen: ent ? ent.value.length : null,
        entFullValueLen: entFull ? entFull.value.length : null,
      };
    }
    """)
    if not result["entExists"] or not result["entFullExists"]:
        return False, f"missing template(s): {result}"
    if not (result["entValueLen"] < result["entFullValueLen"]):
        return False, f"'Enterprise' should be shorter than 'Enterprise Full': {result}"
    return True, f"'Enterprise' ({result['entValueLen']} positions) is the short default; 'Enterprise Full' ({result['entFullValueLen']} positions) is the original"


def check_generate_industry_selection_cap(page):
    """Regression guard: past 100 generated nodes, Generate Industry should leave
    nothing selected rather than a small, misleading partial selection (whatever the
    last individual stream happened to select)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);

      const tree = [];
      for (let i = 0; i < 150; i++) {
        tree.push({ nodeElementType: 'BusinessFunction', nodeName: 'CapFunc' + i, nodeId: 'capfunc-' + i, nodeDescription: '', nodeSection: '', nodeChildren: [
          { nodeElementType: 'BusinessCapability', nodeName: 'CapCap' + i, nodeId: 'capfunc-' + i + '-cap', nodeDescription: 'd', nodeChildren: [] }
        ]});
      }
      store.doc.industryTree = tree;
      store.doc.industryTemplateName = 'SFCCE';

      const view = store.addView('RegrSelCap_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      await commands.generateIndustry(app, () => {});
      return { selectionSize: tab.selection.size };
    }
    """)
    if result["selectionSize"] != 0:
        return False, f"expected empty selection after generating 150 nodes, got {result['selectionSize']}"
    return True, "Generate Industry left the selection empty after generating well over 100 nodes"


def check_modal_no_close_on_outside_click(page):
    """Regression guard: dialogs (tested here via Load SFCCE, but the fix applies to all
    of them — every modal in the app shares the same overlay pattern) should only close
    via their own Cancel/Close controls, not a click anywhere outside the box."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      const out = {};
      app.promptLoadSFCCE();
      await new Promise(r => setTimeout(r, 30));
      out.openInitially = !!document.querySelector('.modal-overlay');
      document.querySelector('.modal-overlay').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      out.stillOpenAfterOutsideClick = !!document.querySelector('.modal-overlay');
      document.querySelector('.modal-overlay .cancel')?.click();
      await new Promise(r => setTimeout(r, 30));
      out.closedAfterCancel = !document.querySelector('.modal-overlay');
      return out;
    }
    """)
    problems = [k for k, v in result.items() if (k != "closedAfterCancel" and not v) or (k == "closedAfterCancel" and not v)]
    if not result["openInitially"] or not result["stillOpenAfterOutsideClick"] or not result["closedAfterCancel"]:
        return False, f"failed: {result}"
    return True, "modal stays open on an outside click and only closes via its own Cancel button"


def check_stream_filter_select_all_exclude_all(page):
    """Regression guard: the Stream filter menu's Select All / Exclude All top-row
    checkbox (new — added to match the pre-existing Element Type filter's own version).
    Unchecking it should hide every streamed node (tab.activeStreams becomes an explicit
    [] -> passesStreamFilter's "exclude all" case, not the old "empty array means
    unfiltered" convention this filter used to have on its own), and re-checking it
    should reset tab.activeStreams to null (unfiltered) — the exact same null-vs-[]
    convention passesElementTypeFilter already used, now shared by both filters."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.findView(store.currentView) || store.doc.views[0];
      const canvasTab = store.tabs.find(t => t.type === 'canvas') || app.createCanvasTab(view);
      app.switchToTab(canvasTab.id); // Instructions opens active on startup, not a canvas tab
      const mk = (label, streams) => {
        const part = store.createPart({ type: 'GeneralActor', label, model: store.defaultModel, streams: streams || [] });
        store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x: Math.random() * 400, y: Math.random() * 400 });
        return part;
      };
      mk('Streamed1', ['S1']);
      mk('Streamed2', ['S1']);
      mk('Unstreamed', []);
      app.render();
      await new Promise(r => setTimeout(r, 100));
      const tab = store.activeTab();
      const initialCount = document.querySelectorAll('.fnode').length;

      document.getElementById('stream-filter-btn').click();
      await new Promise(r => setTimeout(r, 60));
      const selectAllCb = document.getElementById('stream-select-all');
      const initiallyChecked = selectAllCb ? selectAllCb.checked : null;

      selectAllCb.checked = false;
      selectAllCb.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 60));
      const afterExcludeAll = { activeStreams: tab.activeStreams, visibleCount: document.querySelectorAll('.fnode').length };

      document.getElementById('stream-filter-btn').click();
      await new Promise(r => setTimeout(r, 60));
      const selectAllCb2 = document.getElementById('stream-select-all');
      selectAllCb2.checked = true;
      selectAllCb2.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 60));
      const afterSelectAll = { activeStreams: tab.activeStreams, visibleCount: document.querySelectorAll('.fnode').length };

      return { initialCount, initiallyChecked, afterExcludeAll, afterSelectAll };
    }
    """)
    problems = []
    if not result["initiallyChecked"]:
        problems.append(f"expected the Select All checkbox to start checked (unfiltered), got {result}")
    ax = result["afterExcludeAll"]
    if ax["activeStreams"] != []:
        problems.append(f"expected unchecking Select All to set tab.activeStreams to an explicit [] (exclude all), got {ax['activeStreams']}")
    if ax["visibleCount"] != 0:
        problems.append(f"expected excluding all streams to hide every node, got {ax['visibleCount']} still visible")
    asel = result["afterSelectAll"]
    if asel["activeStreams"] is not None:
        problems.append(f"expected re-checking Select All to reset tab.activeStreams to null (unfiltered), got {asel['activeStreams']}")
    if asel["visibleCount"] != result["initialCount"]:
        problems.append(f"expected re-selecting all to restore every node, got {asel['visibleCount']} visible vs {result['initialCount']} originally")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "the Stream filter's Select All / Exclude All checkbox correctly toggles tab.activeStreams between null (unfiltered) and [] (exclude all), matching the Element Type filter's own convention"


def check_section_filter(page):
    """Regression guard for the new Section filter (toolbar, between Types and Levels —
    same two places Stream/Type already apply: canvas AND 3D tabs). Covers: the menu
    lists every distinct Part.section value, sorted alphabetically with a
    '(no section)' option (for parts with no section at all) always last; filtering to
    one section hides everything else on the 2D canvas; the SAME fixture read directly
    via store.doc.parts (not any one view's viewMembers) filters correctly in the 3D
    scene too, via tab.activeSections — the exact null(unfiltered)-vs-[](exclude all)
    convention Stream/Type already use."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.findView(store.currentView) || store.doc.views[0];
      const canvasTab = store.tabs.find(t => t.type === 'canvas') || app.createCanvasTab(view);
      app.switchToTab(canvasTab.id);
      const mk = (label, section) => {
        const part = store.createPart({ type: 'GeneralActor', label, model: store.defaultModel, streams: [], section: section || '' });
        store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x: Math.random() * 600, y: Math.random() * 400 });
        return part;
      };
      mk('North1', 'North');
      mk('North2', 'North');
      mk('South1', 'South');
      mk('NoSection', '');
      app.render();
      await new Promise(r => setTimeout(r, 100));
      const initialCount = document.querySelectorAll('.fnode').length;

      document.getElementById('section-filter-btn').click();
      await new Promise(r => setTimeout(r, 60));
      const menuLabels = [...document.querySelectorAll('#section-filter-menu .dd-item-list label')].map(l => l.textContent.trim());

      // filter to only 'North'
      const selectAllCb = document.getElementById('section-select-all');
      selectAllCb.checked = false;
      selectAllCb.dispatchEvent(new Event('change'));
      const northCb = [...document.querySelectorAll('#section-filter-menu .dd-item-list input[type=\\"checkbox\\"]')].find(c => c.value === 'North');
      northCb.checked = true;
      northCb.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 60));
      const visibleAfterFilter = [...document.querySelectorAll('.fnode .fnode-label')].map(e => e.textContent.trim());
      const activeSectionsAfterFilter = canvasTab.activeSections;

      // now check the same fixture's data reaches the 3D scene
      app.openOrSwitch3DView();
      const view3d = await import('./js/view3d.js');
      const tab3d = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 300));
      const info3dUnfiltered = view3d.getDebugSceneInfo(tab3d.id);
      tab3d.activeSections = ['North'];
      app.render();
      await new Promise(r => setTimeout(r, 150));
      const info3dFiltered = view3d.getDebugSceneInfo(tab3d.id);

      return { initialCount, menuLabels, visibleAfterFilter, activeSectionsAfterFilter, info3dUnfiltered, info3dFiltered };
    }
    """)
    problems = []
    if result["menuLabels"] != ["North", "South", "(no section)"]:
        problems.append(f"expected section options sorted alphabetically with '(no section)' last, got {result['menuLabels']}")
    if sorted(result["visibleAfterFilter"]) != ["North1", "North2"]:
        problems.append(f"expected filtering to 'North' to leave only North1/North2 visible on the canvas, got {result['visibleAfterFilter']}")
    if result["activeSectionsAfterFilter"] != ["North"]:
        problems.append(f"expected tab.activeSections to be ['North'] after the filter, got {result['activeSectionsAfterFilter']}")
    unf = result["info3dUnfiltered"]["types"].get("GeneralActor", {}).get("count")
    if unf != 4:
        problems.append(f"expected all 4 parts visible in 3D before any section filter, got {unf}")
    filt = result["info3dFiltered"]["types"].get("GeneralActor", {}).get("count")
    if filt != 2:
        problems.append(f"expected the 3D scene to also respect tab.activeSections (only the 2 'North' parts), got {filt}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "the Section filter lists every distinct section with '(no section)' last, filters the 2D canvas correctly, and the same tab.activeSections field also filters the 3D scene"


def check_types_filter_keeps_connectors_visible(page):
    """Reported directly: "connectors not showing when types filtered; on a view when
    using Filter Types, connectors should continue to be displayed unless unselected in
    view properties." Root cause: renderCanvasPage forced connVms to [] whenever
    tab.connectorLevels was 0 (the default) and any Stream/Type/Section filter was
    active, even for a connector directly between two parts that both individually
    passed the filter — contradicting instructions.html's own documented meaning of
    "Connector levels" (controls extra NODES pulled in beyond direct matches, not
    whether a directly-matching connector draws at all). Covers: with the default
    connectorLevels (0) and a Types filter that includes BOTH connected parts' types,
    the connector between them still renders; narrowing the Types filter to exclude one
    endpoint still correctly hides it (endpoint genuinely gone, not a filter bypass);
    and the per-view "view properties" checkbox (chkShowConnectorType) still hides it
    even when both endpoints pass the Types filter, proving visibility is governed by
    that checkbox, not by connectorLevels."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.findView(store.currentView) || store.doc.views[0];
      const canvasTab = store.tabs.find(t => t.type === 'canvas') || app.createCanvasTab(view);
      app.switchToTab(canvasTab.id);
      view.chkShowConnectorType = true;

      const a = store.createPart({ type: 'GeneralActor', label: 'A', model: store.defaultModel, streams: [] });
      const b = store.createPart({ type: 'BusinessCapability', label: 'B', model: store.defaultModel, streams: [] });
      const avm = store.createViewMember({ view: view.id, objectType: 'part', objectId: a.id, x: 100, y: 100 });
      const bvm = store.createViewMember({ view: view.id, objectType: 'part', objectId: b.id, x: 400, y: 100 });
      const conn = store.createConnector({ from: a.id, to: b.id, model: store.defaultModel, connectorType: 'c' });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: avm.id, toVmId: bvm.id });

      canvasTab.activeElementTypes = null;
      canvasTab.connectorLevels = 0;
      app.render();
      await new Promise(r => setTimeout(r, 80));
      const unfilteredEdges = document.querySelectorAll('.edge-hit').length;

      // Types filter includes BOTH connected parts' types, connectorLevels stays 0
      canvasTab.activeElementTypes = ['GeneralActor', 'BusinessCapability'];
      app.render();
      await new Promise(r => setTimeout(r, 80));
      const edgesWithBothTypesShown = document.querySelectorAll('.edge-hit').length;
      const nodesWithBothTypesShown = document.querySelectorAll('.fnode').length;

      // narrow to exclude B's type entirely -> connector must genuinely disappear
      canvasTab.activeElementTypes = ['GeneralActor'];
      app.render();
      await new Promise(r => setTimeout(r, 80));
      const edgesWithOneEndpointHidden = document.querySelectorAll('.edge-hit').length;

      // back to both types shown, but now the view property turns connectors off
      canvasTab.activeElementTypes = ['GeneralActor', 'BusinessCapability'];
      view.chkShowConnectorType = false;
      app.render();
      await new Promise(r => setTimeout(r, 80));
      const edgesWithViewPropertyOff = document.querySelectorAll('.edge-hit').length;

      return { unfilteredEdges, edgesWithBothTypesShown, nodesWithBothTypesShown, edgesWithOneEndpointHidden, edgesWithViewPropertyOff };
    }
    """)
    problems = []
    if result["unfilteredEdges"] != 1:
        problems.append(f"expected 1 connector rendered with no filter active, got {result['unfilteredEdges']}")
    if result["nodesWithBothTypesShown"] != 2:
        problems.append(f"expected both parts visible once the Types filter includes both their types, got {result['nodesWithBothTypesShown']} nodes")
    if result["edgesWithBothTypesShown"] != 1:
        problems.append(f"expected the connector to STILL render when Filter Types includes both endpoints' types (connectorLevels=0 default), got {result['edgesWithBothTypesShown']}")
    if result["edgesWithOneEndpointHidden"] != 0:
        problems.append(f"expected the connector hidden once its endpoint's type is filtered out, got {result['edgesWithOneEndpointHidden']}")
    if result["edgesWithViewPropertyOff"] != 0:
        problems.append(f"expected chkShowConnectorType=false to hide the connector even with both endpoints passing the Types filter, got {result['edgesWithViewPropertyOff']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "a connector between two parts that both pass the active Types filter stays visible regardless of connectorLevels, still disappears when an endpoint is actually filtered out, and is still governed by the chkShowConnectorType view property"


def check_export_svg_includes_sections(page):
    """Regression guard: File > Export View as Image (buildViewSvgString) only ever drew
    connectors and part nodes — for a section-based view type (anything other than
    'ff', e.g. 'org'), the section boxes and header labels visible on the real canvas
    (buildSectionsOverlay) were completely absent from the exported SVG/PNG. Reported
    directly: "'export view to image' for a view of type 'org' doesn't also export the
    section markers or headers." Covers: both section names appear in the exported SVG
    string; a section with NO parts placed in it still gets exported (the overall
    bounding box has to fold in section bounds, not just part positions, or an empty
    section's box/header would get silently clipped out of frame); a plain 'ff'
    (freeform) view — which has no sections at all — is completely unaffected."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const sections = await import('./js/sections.js');

      const view = store.addView('RegrExportSections_' + Date.now());
      view.viewType = 'org';
      view.sections = [
        { id: 'sec1', sectionId: 'sec1', name: 'Leadership', order: 0, rowCount: 1, columnCount: 2, elementTypes: ['*'] },
        { id: 'sec2', sectionId: 'sec2', name: 'EmptySection', order: 1, rowCount: 1, columnCount: 2, elementTypes: ['*'] },
      ];
      const layout = sections.computeSectionLayout(view);
      const l1 = layout.find(e => e.section.id === 'sec1');
      const pos1 = sections.gridToPixel(l1, 0, 0);
      const part = store.createPart({ type: 'BusinessActor', label: 'CEO', model: store.defaultModel, streams: [] });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x: pos1.x, y: pos1.y, sectionId: 'sec1' });

      const built = app.buildViewSvgString(view);

      // A plain freeform view (no sections at all) should be completely unaffected.
      const ffView = store.addView('RegrExportSectionsFF_' + Date.now());
      ffView.viewType = 'ff';
      const ffPart = store.createPart({ type: 'GeneralActor', label: 'Solo', model: store.defaultModel, streams: [] });
      store.createViewMember({ view: ffView.id, objectType: 'part', objectId: ffPart.id, x: 40, y: 40 });
      const builtFF = app.buildViewSvgString(ffView);

      return {
        hasSvg: !!built,
        includesLeadership: built.svgString.includes('Leadership'),
        includesEmptySection: built.svgString.includes('EmptySection'),
        dashedElementCount: (built.svgString.match(/stroke-dasharray/g) || []).length,
        ffIncludesDasharray: builtFF.svgString.includes('stroke-dasharray'),
        ffHasSvg: !!builtFF,
      };
    }
    """)
    problems = []
    if not result["hasSvg"]:
        problems.append("expected an SVG to be built for the section-based view")
    if not result["includesLeadership"]:
        problems.append("expected the exported SVG to include the 'Leadership' section's header label")
    if not result["includesEmptySection"]:
        problems.append("expected the exported SVG to include the EMPTY section's header label too (bounding box must fold in section bounds, not just part positions)")
    if result["dashedElementCount"] < 4:
        problems.append(f"expected at least 4 dashed section-boundary/header-separator elements (2 sections x 2 each), got {result['dashedElementCount']}")
    if not result["ffHasSvg"]:
        problems.append("expected a plain freeform view to still export normally")
    if result["ffIncludesDasharray"]:
        problems.append("expected a plain freeform view (no sections) to have NO dashed section elements at all")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Export View as Image now includes section boxes and header labels for section-based view types, including an entirely empty section, while a plain freeform view is unaffected"


def check_catalog_row_copy_includes_all_part_fields(page):
    """Regression guard: the Parts Catalog row's Copy button (buildCatalogRowCopyText,
    also what the 3D View's node properties panel uses via the same catalog-row
    mechanism) used to copy only Type/Label/Model/Note/Streams — a hand-picked handful
    from an earlier version of the panel that was never updated as more part fields were
    added. Confirms every showFields.part field that has a value now makes it into the
    copied text, via the browser's real clipboard API (not a mock)."""
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const part = store.createPart({
        type: 'GeneralActor', label: 'CopyTest', model: store.defaultModel,
        streams: ['S1'], section: 'North', order: 5, note: 'a note',
        xIds: 'xid1', description: 'a desc',
      });
      part.scriptEnabled = true;
      part.script = 'return { value: 1 };';

      app.openOrSwitchCatalog('parts', 'Parts Catalog');
      await new Promise(r => setTimeout(r, 100));
      document.querySelector(`.catalog-row[data-id="${part.id}"]`).click();
      await new Promise(r => setTimeout(r, 100));
      document.getElementById('catalog-row-copy-btn').click();
      await new Promise(r => setTimeout(r, 150));
      const text = await navigator.clipboard.readText();
      return { text, partId: part.id };
    }
    """)
    text = result["text"]
    expectations = [
        ("Id", f"Id: {result['partId']}"),
        ("Section", "Section: North"),
        ("Order", "Order: 5"),
        ("Script Enabled", "Script Enabled: true"),
        ("Script body", "return { value: 1 };"),
        ("Created timestamp", "Created:"),
        ("Updated timestamp", "Updated:"),
        # the originally-copied fields should still be there too
        ("Type", "GeneralActor"),
        ("Label", "Label: CopyTest"),
        ("Streams", "Streams: S1"),
    ]
    missing = [name for name, needle in expectations if needle not in text]
    if missing:
        return False, f"expected the copied text to include {missing}, got: {text}"
    return True, "the Copy button now includes every showFields.part field with a value, not just the original Type/Label/Model/Note/Streams handful"


def check_generate_industry_place_on_view_defaults_unchecked(page):
    """Regression guard: Generate Industry's "Place on current view" checkbox now
    defaults unchecked (was checked) — generating industry data without placing it on a
    view first is much faster for a large dataset and is the more common intended use
    (review via Catalogs > Parts, then Add Existing), so unchecked is now the default."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      if (!store.doc.industryTree.length) store.doc.industryTree = [{ nodeElementType: 'BusinessFunction', nodeName: 'x', nodeId: 'x', nodeDescription: '', nodeChildren: [] }];
      app.promptGenerateIndustry();
      await new Promise(r => setTimeout(r, 60));
      const cb = document.getElementById('gi-place-view');
      return { exists: !!cb, checked: cb ? cb.checked : null };
    }
    """)
    if not result["exists"]:
        return False, f"expected the Generate Industry dialog's 'Place on current view' checkbox to exist, got {result}"
    if result["checked"]:
        return False, f"expected 'Place on current view' to default UNCHECKED, got checked={result['checked']}"
    return True, "Generate Industry's 'Place on current view' checkbox now defaults unchecked"


def check_dropdown_scrollable(page):
    """Regression guard: any dropdown (tested here via the Stream filter) should be
    capped to a sane viewport-relative height with scrolling, rather than growing
    unbounded and running off-screen for a long list."""
    result = js(page, """
    async () => {
      document.getElementById('stream-filter-btn')?.click();
      await new Promise(r => setTimeout(r, 30));
      const menu = document.getElementById('stream-filter-menu');
      const computed = menu ? getComputedStyle(menu) : null;
      return { maxHeight: computed ? computed.maxHeight : null, overflowY: computed ? computed.overflowY : null };
    }
    """)
    if not result["maxHeight"] or result["maxHeight"] == "none":
        return False, f"dropdown has no max-height constraint: {result}"
    if result["overflowY"] != "auto" and result["overflowY"] != "scroll":
        return False, f"dropdown isn't scrollable: {result}"
    return True, f"dropdown menu is capped ({result['maxHeight']}) and scrollable ({result['overflowY']})"


def check_sfce_catalog_page(page):
    """Regression guard: Catalogs > SFCE should open a read-only table of the single
    loaded industry dataset's Section/Function/Capability/Application Capability/Entity
    hierarchy, with id and description at EVERY level including Section (sectionId/
    sectionDescription — a later addition; Section has no tree node of its own, so these
    ride along on the Function node, see DESIGN_DOCUMENT.md SS7.1) — the built-in
    default (public/capabilities-general-SFCCE.json, boot-loaded through the same
    pipeline a real Load SFCCE import uses, so it's a genuine 4-level tree with real
    Application Capability values, not blank ones)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      app.promptSfceCatalog();
      await new Promise(r => setTimeout(r, 50));
      const catalogTab = store.tabs.find(t => t.sfceCatalog);
      const tableEl = document.querySelector('.table-page table');
      return {
        tabCreated: !!catalogTab,
        rowCount: catalogTab ? catalogTab.tableRows.length : 0,
        cols: catalogTab ? catalogTab.tableCols : [],
        tableRendered: !!tableEl,
        headerCount: tableEl ? tableEl.querySelectorAll('th').length : 0,
      };
    }
    """)
    expectedCols = ["section", "sectionId", "sectionDescription", "sectionOrder", "functionId", "functionName", "functionDescription", "capabilityId", "capabilityName", "capabilityDescription", "applicationCapabilityId", "applicationCapabilityName", "applicationCapabilityDescription", "entityId", "entityName", "entityDescription"]
    if not result["tabCreated"] or result["rowCount"] == 0:
        return False, f"catalog tab wasn't created or has no rows: {result}"
    if result["cols"] != expectedCols:
        return False, f"unexpected columns: {result['cols']}"
    if not result["tableRendered"] or result["headerCount"] != len(expectedCols):
        return False, f"table didn't render correctly: {result}"
    return True, f"SFCE Catalog opened with {result['rowCount']} rows and all {len(expectedCols)} id/description columns"


def check_sfce_catalog_section_description_fallback(page):
    """Regression guard/new-feature check, reported directly: "when I open catalog
    SFCCE I don't see these section descriptions. please add." Each row's own
    sectionDescription (sfce.js's makeRow) comes from the imported/generated SFCCE
    data's own nodeSectionDescription, populated only when a Load SFCCE field mapping
    supplies a sectionDescriptionField -- the BUILT-IN default dataset's own mapping
    (GENERAL_SFCCE_MAPPING, data.js) never has, so this column was always blank for
    the data most people actually see here. Fixed in openOrSwitchSfceCatalog
    (main.js): after flattenIndustryTree builds tableRows, any row with a blank
    sectionDescription (but a real sectionId) gets filled in from
    store.settings.sections' own org-viewType section definitions (public/
    custom.json, matched by sectionId) -- the same 7 known-Section descriptions the
    Industry_to_SFCCE AI prompt (Instructions tab) already gives an AI. Covers: every
    row of the built-in default dataset (which has no descriptions of its own) ends
    up with a real, non-empty sectionDescription; a sampled 'mof' row's description
    matches custom.json's own org-viewType 'mof' section definition EXACTLY (proving
    it's a genuine lookup, not a hardcoded string); and a row whose underlying SFCCE
    data DOES supply its own real sectionDescription is left completely untouched,
    not overwritten by the fallback."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;

      const tab1 = app.openOrSwitchSfceCatalog();
      const allSectionedRowsHaveDescriptions = tab1.tableRows.every(r => !r.sectionId || !!r.sectionDescription);
      const mofRow = tab1.tableRows.find(r => r.sectionId === 'mof');
      const mofCustomJsonDescription = (store.settings.sections || []).find(s => s.viewType === 'org' && s.sectionId === 'mof')?.description;
      const mofDescriptionMatches = !!mofCustomJsonDescription && mofRow?.sectionDescription === mofCustomJsonDescription;

      // a row whose data already carries its OWN real sectionDescription must be left alone
      const origTree = store.doc.industryTree;
      store.doc.industryTree = [{
        nodeElementType: 'BusinessFunction', nodeId: 'regr-f1', nodeName: 'RegrF1', nodeDescription: '',
        nodeSection: 'Regr Custom Section', nodeSectionId: 'mof', nodeSectionOrder: '1',
        nodeSectionDescription: 'MY OWN REAL DESCRIPTION', nodeChildren: [],
      }];
      const tab2 = app.openOrSwitchSfceCatalog();
      const ownDescriptionPreserved = tab2.tableRows[0]?.sectionDescription === 'MY OWN REAL DESCRIPTION';
      store.doc.industryTree = origTree;

      return { allSectionedRowsHaveDescriptions, mofDescriptionMatches, ownDescriptionPreserved, mofCustomJsonDescription };
    }
    """)
    problems = []
    if not result["allSectionedRowsHaveDescriptions"]:
        problems.append("expected every sectioned row of the built-in default dataset to end up with a non-empty sectionDescription")
    if not result["mofDescriptionMatches"]:
        problems.append(f"expected a sampled 'mof' row's sectionDescription to exactly match custom.json's own org-viewType 'mof' section description ({result['mofCustomJsonDescription']!r}), mismatch")
    if not result["ownDescriptionPreserved"]:
        problems.append("expected a row whose underlying SFCCE data already supplies its own real sectionDescription to be left untouched by the fallback, not overwritten")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "SFCE Catalog fills in a blank sectionDescription from custom.json's own org-viewType section definitions (exact match, not overriding a row's own real description)"


def check_boot_loader_wires_section_id_and_order(page):
    """Regression guard/new-feature check, reported directly: "wire sectionId and order
    into the boot loader." public/capabilities-general-SFCCE.json's own per-function
    `sectionId`/`order` fields (matching custom.json's org-viewType sections) previously
    reached nothing — GENERAL_SFCCE_MAPPING (data.js) didn't map either, so every
    Function node's nodeSectionId stayed null and there was no nodeSectionOrder concept
    at all (sfce.js's buildRowsFromRecords/buildIndustryTree had no sectionOrderField/
    nodeSectionOrder). Covers: every boot-loaded Function node's nodeSectionId matches
    its section's real sectionId (not null); nodeSectionOrder matches the section's real
    numeric order (as a string, same as sectionId — sfce.js's readScalar always
    stringifies); Generate Industry's dedicated section-reification block now gives each
    generated BusinessOrganizationUnit part a real xIds (the sectionId) instead of the
    previous empty string, one real fix this surfaced (mof/cof/ssf were the only 3
    sections with a mapped sectionId before; all 7 real content sections have one now,
    since the file's own remaining-rows entries — Enterprise Scope/Continuous
    Improvement/Resources Sustainment/Finance Control Functions — also carry it); and
    the SFCE Catalog's tableCols include the new sectionOrder column, populated with the
    matching real value in a sample row."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');

      const bySectionId = {};
      for (const f of store.doc.industryTree) bySectionId[f.nodeSectionId] = { sectionId: f.nodeSectionId, sectionOrder: f.nodeSectionOrder, section: f.nodeSection };

      await commands.generateIndustry(app, null, false);
      const orgUnits = store.doc.parts.filter(p => p.type === 'BusinessOrganizationUnit');
      const orgUnitXIdsBySection = {};
      for (const o of orgUnits) orgUnitXIdsBySection[o.label] = o.xIds;

      const catalogTab = app.openOrSwitchSfceCatalog();
      const sampleRow = catalogTab.tableRows.find(r => r.section === 'Mainstream Operational Functions');

      return {
        bySectionId,
        orgUnitCount: orgUnits.length,
        orgUnitXIdsBySection,
        catalogCols: catalogTab.tableCols,
        sampleRowSectionOrder: sampleRow ? sampleRow.sectionOrder : null,
      };
    }
    """)
    problems = []
    expectedOrders = {'esf': '1', 'mof': '2', 'cof': '3', 'ssf': '4', 'cif': '5', 'rsf': '6', 'fcf': '7'}
    for sectionId, expectedOrder in expectedOrders.items():
        entry = result["bySectionId"].get(sectionId)
        if not entry:
            problems.append(f"expected a Function node with nodeSectionId {sectionId!r}, found none among {list(result['bySectionId'].keys())}")
        elif entry["sectionOrder"] != expectedOrder:
            problems.append(f"expected nodeSectionOrder {expectedOrder!r} for section {sectionId!r}, got {entry['sectionOrder']!r}")
    if result["orgUnitCount"] != 7:
        problems.append(f"expected 7 BusinessOrganizationUnit parts (one per real content section: esf/mof/cof/ssf/cif/rsf/fcf), got {result['orgUnitCount']}")
    for label, xIds in result["orgUnitXIdsBySection"].items():
        if not xIds:
            problems.append(f"expected every generated BusinessOrganizationUnit part to have a real xIds (its sectionId), got blank for {label!r}")
    if "sectionOrder" not in result["catalogCols"]:
        problems.append(f"expected the SFCE Catalog's tableCols to include 'sectionOrder', got {result['catalogCols']}")
    if result["sampleRowSectionOrder"] != "2":
        problems.append(f"expected the 'Mainstream Operational Functions' catalog row's sectionOrder to be '2', got {result['sampleRowSectionOrder']!r}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "the boot loader now wires sectionId/order from capabilities-general-SFCCE.json into nodeSectionId/nodeSectionOrder, every generated BusinessOrganizationUnit gets a real xIds, and the SFCE Catalog surfaces the new sectionOrder column"


def check_routing_style_per_connector_type(page):
    """Regression guard: 'c' and 's' connectors should each have their own routing
    setting (view.routingStyle vs view.routingStyleStream), and the new "straight line"
    option should produce a genuinely straight path (no curve) — distinct from
    "default", which still curves 'c'-type connectors."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);

      const view = store.addView('RegrRoutingStyle_' + Date.now());
      view.viewType = 'ff';
      view.routingStyle = 'straight';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const pA = store.createPart({ type: 'Unknown', label: 'a', model: store.defaultModel, streams: [] });
      const pB = store.createPart({ type: 'Unknown', label: 'b', model: store.defaultModel, streams: [] });
      const vA = store.createViewMember({ view: view.id, objectType: 'part', objectId: pA.id, x: 0, y: 0 });
      const vB = store.createViewMember({ view: view.id, objectType: 'part', objectId: pB.id, x: 300, y: 200 });
      const cC = store.createConnector({ from: pA.id, to: pB.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: cC.id, fromVmId: vA.id, toVmId: vB.id });
      app.render();
      await new Promise(r => setTimeout(r, 50));
      const straightPath = document.querySelector('.edge-layer path:not(.edge-hit)')?.getAttribute('d');

      view.routingStyle = 'default';
      app.render();
      await new Promise(r => setTimeout(r, 50));
      const defaultPath = document.querySelector('.edge-layer path:not(.edge-hit)')?.getAttribute('d');

      return {
        hasSeparateStreamField: 'routingStyleStream' in view,
        straightPathHasNoCurve: straightPath ? !straightPath.includes('Q') : null,
        defaultPathHasCurve: defaultPath ? defaultPath.includes('Q') : null,
      };
    }
    """)
    if not result["hasSeparateStreamField"]:
        return False, "view.routingStyleStream doesn't exist — 'c' and 's' connectors would share one setting"
    if not result["straightPathHasNoCurve"]:
        return False, f"'straight' routing produced a curve: {result}"
    if not result["defaultPathHasCurve"]:
        return False, f"'default' routing stopped curving 'c'-type connectors: {result}"
    return True, "'c' and 's' connectors have independent routing settings, and 'straight' produces a genuinely straight line distinct from 'default'"


def check_auto_complete_streams_ui(page):
    """Regression guard for Smart Check View's 'Auto-complete streams in model' option:
    exercises the real DOM review dialog end-to-end — the Part/View checkbox dependency
    (unchecking Part must auto-uncheck+disable View, since a node can't exist without its
    part), that Proceed's creation call respects a left-unchecked row (it stays a gap)
    while completing the rest, and — the actual bug this check was written for — that
    leaving a MIDDLE chain position unchecked does NOT create a connector directly
    bridging its two neighbors together, skipping over the gap. A connector should only
    ever be created between positions that are both resolved AND immediately adjacent in
    the template."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const streamName = 'RegrACS_' + Date.now();
      // A lone, otherwise-unrelated part tagged with a fresh stream name -> every
      // Enterprise template position for this stream comes back as a gap.
      store.createPart({ type: 'Unknown', label: 'seed', model: store.defaultModel, streams: [streamName] });

      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      app.promptSmartCheckView();
      await new Promise(r => setTimeout(r, 30));
      document.getElementById('scv-missing-connectors').checked = false;
      document.getElementById('scv-autocomplete').checked = true;
      document.getElementById('scv-autocomplete').dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('scv-autocomplete-template').value = 'Enterprise';
      await new Promise(r => setTimeout(r, 30));
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 60));

      const rowEls = [...document.querySelectorAll('.modal-box tbody tr')];
      const ourRows = rowEls.filter(tr => tr.children[0].textContent === streamName);
      if (!ourRows.length) return { error: 'no review rows found for our stream', rowCount: rowEls.length };

      // Enterprise's template.value is [GeneralActor, BusinessService, BusinessCapability,
      // BusinessProcess, ApplicationCapability, ApplicationProcess,
      // ApplicationLogicalComponent, ApplicationPhysicalComponent, DataDataEntity] — pick
      // the row for BusinessCapability (a genuine middle position with a real neighbor on
      // each side: BusinessService before, BusinessProcess after) and leave it unchecked.
      const targetRow = ourRows.find(tr => tr.children[1].textContent === 'BusinessCapability');
      if (!targetRow) return { error: 'no BusinessCapability row found', rowCount: ourRows.length };

      const partCb = targetRow.querySelector('.acs-part');
      const viewCb = targetRow.querySelector('.acs-view');
      const viewCheckedBefore = viewCb.checked;
      partCb.checked = false;
      partCb.dispatchEvent(new Event('change', { bubbles: true }));
      const dependencyWorked = viewCb.checked === false && viewCb.disabled === true;

      document.querySelector('.modal-box .submit').click();
      await new Promise(r => setTimeout(r, 60));

      const commands = await import('./js/commands.js');
      const remainingRows = commands.scanStreamsForAutoComplete(store, 'Enterprise', store.defaultModel, homeTab.viewId)
        .filter(r => r.streamName === streamName);
      const skippedStillGap = remainingRows.some(r => r.type === 'BusinessCapability');

      const svcPart = store.doc.parts.find(p => p.type === 'BusinessService' && (p.streams || []).includes(streamName));
      const procPart = store.doc.parts.find(p => p.type === 'BusinessProcess' && (p.streams || []).includes(streamName));
      const bothNeighborsCreated = !!svcPart && !!procPart;
      const bridgingConnectorExists = bothNeighborsCreated && store.doc.connectors.some(c =>
        (c.from === svcPart.id && c.to === procPart.id) || (c.from === procPart.id && c.to === svcPart.id));

      return {
        rowCount: ourRows.length,
        viewCheckedBefore,
        dependencyWorked,
        skippedStillGap,
        remainingCount: remainingRows.length,
        bothNeighborsCreated,
        bridgingConnectorExists,
      };
    }
    """)
    if result.get("error"):
        return False, f"setup failed: {result}"
    if not result["viewCheckedBefore"]:
        return False, "test precondition failed: View checkbox wasn't checked by default"
    if not result["dependencyWorked"]:
        return False, "unchecking Part did not auto-uncheck+disable View"
    if not (result["remainingCount"] == 1 and result["skippedStillGap"]):
        return False, f"unexpected post-creation state: {result}"
    if not result["bothNeighborsCreated"]:
        return False, f"test precondition failed: BusinessService/BusinessProcess neighbors weren't both created: {result}"
    if result["bridgingConnectorExists"]:
        return False, "unchecking a middle chain position's Part incorrectly created a connector directly bridging its two neighbors, skipping the gap"
    return True, f"Auto-Complete Streams dialog: {result['rowCount']} rows found, Part/View checkbox dependency correct, creation respected the unchecked row (only it remains a gap), and no bridging connector was created across the gap"


def check_streams_field_editable(page):
    """Regression guard: showFields.part/connector 'streams' access was changed from
    read-only to writable — confirms the property panel's Streams field actually persists
    edits back to part.streams / connector.streams (parsed as a trimmed, comma-separated
    list), not just silently no-op like it did before this change."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.addView('RegrStreams_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const partA = store.createPart({ type: 'Unknown', label: 'a', model: store.defaultModel, streams: [] });
      const partB = store.createPart({ type: 'Unknown', label: 'b', model: store.defaultModel, streams: [] });
      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: partA.id, x: 0, y: 0 });
      const vmB = store.createViewMember({ view: view.id, objectType: 'part', objectId: partB.id, x: 200, y: 0 });
      const conn = store.createConnector({ from: partA.id, to: partB.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      const connVm = store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: vmA.id, toVmId: vmB.id });

      app.selectOnly(vmA.id);
      app.render();
      await new Promise(r => setTimeout(r, 30));
      const partInput = document.getElementById('sf-part-streams');
      const partWasReadonly = partInput.readOnly;
      partInput.value = ' S1 , S2 ,, S3 ';
      partInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));

      app.selectOnly(connVm.id);
      app.render();
      await new Promise(r => setTimeout(r, 30));
      const connInput = document.getElementById('sf-connector-streams');
      const connWasReadonly = connInput.readOnly;
      connInput.value = 'S4, S5';
      connInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));

      return { partWasReadonly, connWasReadonly, partStreams: partA.streams, connStreams: conn.streams };
    }
    """)
    if result["partWasReadonly"] or result["connWasReadonly"]:
        return False, f"Streams field still rendered readonly despite access:'w': {result}"
    if result["partStreams"] != ["S1", "S2", "S3"]:
        return False, f"editing the part Streams field didn't persist correctly: {result['partStreams']}"
    if result["connStreams"] != ["S4", "S5"]:
        return False, f"editing the connector Streams field didn't persist correctly: {result['connStreams']}"
    return True, "part.streams and connector.streams are now editable via the property panel, parsed as trimmed comma-separated lists"


def check_pinned_field_dblclick_not_stolen_by_pin_icon(page):
    """Regression guard: the pin icon used to be nested INSIDE the field label in the
    Pinned section. A real double-click aimed at the label text could have its second
    click land on the pin icon instead (the icon's own click handler toggles the pin and
    triggers a full re-render mid-gesture), un-pinning the row out from under the second
    click and silently breaking the "double-click to open the larger editor" gesture.
    Repeats a real double-click on a pinned field's label several times and checks the
    editor opens every time and the row never disappears from Pinned; then confirms a
    single click directly on the icon still unpins normally."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.addView('RegrPinDbl_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const part = store.createPart({ type: 'Unknown', label: 'PinDblNode', model: store.defaultModel, streams: ['x'] });
      const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x: 0, y: 0 });
      app.render();
      return { vmId: vm.id };
    }
    """)
    node_el = page.locator(f'[data-vm-id="{result["vmId"]}"]').first
    node_el.click()
    page.wait_for_timeout(100)

    opens = []
    for _ in range(3):
        label = page.locator('.pinned-section label[data-field="streams"]')
        if label.count() == 0:
            return False, "pinned 'streams' row disappeared mid-test (got unpinned unexpectedly)"
        box = label.bounding_box()
        page.mouse.dblclick(box["x"] + box["width"] - 3, box["y"] + box["height"] / 2)
        page.wait_for_timeout(100)
        opened = page.locator('#text-edit-area').count() > 0
        opens.append(opened)
        if opened:
            page.locator('.modal-box .cancel').click()
            page.wait_for_timeout(80)

    if not all(opens):
        return False, f"double-clicking the pinned label didn't reliably open the larger editor: {opens}"

    pin_btn = page.locator('.pinned-section [data-pin-field="streams"]')
    if pin_btn.count() == 0:
        return False, "pin icon not found after the double-click round"
    pin_btn.click()
    page.wait_for_timeout(100)
    still_in_pinned = page.locator('.pinned-section label[data-field="streams"]').count() > 0
    if still_in_pinned:
        return False, "clicking the pin icon directly did not unpin the field"
    if page.locator('#sf-part-streams').count() == 0:
        return False, "field should still be editable in Root Properties after unpinning"

    return True, "double-clicking a pinned field's label reliably opens the larger editor without accidentally unpinning, and the pin icon alone still unpins correctly"


def check_local_secrets_settings_split(page):
    """Regression guard for the Local Secrets / Local Settings split: secrets (API keys,
    File > Load Local Secrets) must stay memory-only and reset on every page reload —
    never cached to localStorage — while settings (pinned fields, Max Script Entities,
    File > Load Local Settings) must survive a reload via localStorage, auto-applying on
    the very next boot with no file re-selection needed. That auto-apply-on-start behavior
    is the whole point of the split (a user explicitly asked for it) — this proves secrets
    didn't get swept up in it by mistake, and that settings actually deliver it."""
    def load_file(input_id, obj):
        js(page, f"""
        async () => {{
          const text = {json.dumps(json.dumps(obj))};
          const blob = new Blob([text], {{ type: 'application/json' }});
          const file = new File([blob], 'test.json', {{ type: 'application/json' }});
          const dt = new DataTransfer();
          dt.items.add(file);
          const input = document.getElementById('{input_id}');
          input.files = dt.files;
          input.dispatchEvent(new Event('change', {{ bubbles: true }}));
          await new Promise(r => setTimeout(r, 150));
        }}
        """)

    load_file('load-local-secrets-input', {'TEST_API_KEY': 'shh-secret-123'})
    load_file('load-local-settings-input', {'maxScriptEntities': 777})

    before = js(page, """
    async () => ({
      secrets: window.dycadApp.store.localSecrets,
      cap: window.dycadApp.store.maxScriptEntities,
      cached: localStorage.getItem('dycad-local-settings-cache'),
    })
    """)
    if before["secrets"].get("TEST_API_KEY") != "shh-secret-123":
        return False, f"secrets didn't load correctly: {before}"
    if before["cap"] != 777:
        return False, f"maxScriptEntities didn't load correctly: {before}"
    if not before["cached"] or json.loads(before["cached"]).get("maxScriptEntities") != 777:
        return False, f"maxScriptEntities wasn't cached to localStorage on load: {before}"

    page.reload()
    page.wait_for_timeout(1200)

    after = js(page, """
    async () => ({
      secrets: window.dycadApp.store.localSecrets,
      cap: window.dycadApp.store.maxScriptEntities,
    })
    """)
    if after["secrets"] and len(after["secrets"]) > 0:
        return False, f"secrets leaked across a page reload — should be memory-only, reset to {{}}: {after}"
    if after["cap"] != 777:
        return False, f"maxScriptEntities did not auto-apply from its localStorage cache after reload (expected 777): {after}"

    return True, "Local Secrets reset on reload (memory-only); Local Settings' maxScriptEntities auto-loads from localStorage after a reload with no file re-selection"


def check_batch_script_code_persists_with_local_settings(page):
    """Regression guard: the Script Console's text (store.batchScriptCode) is bundled
    into File > Save/Load Local Settings and its localStorage cache, same as
    maxScriptEntities/nodeSizeMultiplier — reported directly: "These can be viewed in
    'Code Summary' and saved along with user local settings." Covers the same
    auto-apply-on-reload behavior check_local_secrets_settings_split already proves for
    maxScriptEntities: loading a Local Settings file with a custom batchScriptCode
    caches it to localStorage immediately, and a full page reload picks it up with no
    file re-selection needed."""
    custom_code = "function main() { return 'custom-batch-script-marker'; }"

    def load_file(input_id, obj):
        js(page, f"""
        async () => {{
          const text = {json.dumps(json.dumps(obj))};
          const blob = new Blob([text], {{ type: 'application/json' }});
          const file = new File([blob], 'test.json', {{ type: 'application/json' }});
          const dt = new DataTransfer();
          dt.items.add(file);
          const input = document.getElementById('{input_id}');
          input.files = dt.files;
          input.dispatchEvent(new Event('change', {{ bubbles: true }}));
          await new Promise(r => setTimeout(r, 150));
        }}
        """)

    load_file('load-local-settings-input', {'batchScriptCode': custom_code})

    before = js(page, """
    async () => ({
      code: window.dycadApp.store.batchScriptCode,
      cached: localStorage.getItem('dycad-local-settings-cache'),
    })
    """)
    if before["code"] != custom_code:
        return False, f"batchScriptCode didn't load correctly: {before}"
    if not before["cached"] or json.loads(before["cached"]).get("batchScriptCode") != custom_code:
        return False, f"batchScriptCode wasn't cached to localStorage on load: {before}"

    page.reload()
    page.wait_for_timeout(1200)

    after = js(page, "async () => ({ code: window.dycadApp.store.batchScriptCode })")
    if after["code"] != custom_code:
        return False, f"batchScriptCode did not auto-apply from its localStorage cache after reload: {after}"

    return True, "batchScriptCode loads from a Local Settings file, caches to localStorage, and auto-applies on the next page load with no file re-selection"


def check_common_script_callable_from_part_script(page):
    """Regression guard/new-feature check, reported directly: "Create a common script
    in script console example that can be called from any part script. Within the new
    script I want to take action based on calling part type, label, and model. As an
    example have the script send to message log something like 'called by ' part type,
    label, and model." runTick (simulation.js) now compiles a part's own script as
    `new Function('ctx', store.batchScriptCode + '\\n' + part.script)` instead of just
    `new Function('ctx', part.script)` — every function/const store.batchScriptCode
    defines (the Script Console's own editable text) is therefore in scope inside every
    part script too. DEFAULT_BATCH_SCRIPT_CODE (state.js) ships a ready-made
    CommonScript_Example(ctx) doing exactly the reported example: `ctx.log('called by '
    + ctx.part.type + ' ' + ctx.part.label + ' ' + ctx.part.model)`. Covers: (1) the
    shipped default — a part with no edits to store.batchScriptCode at all, whose own
    script just calls CommonScript_Example(ctx), produces the exact expected message in
    the persistent Message Log after one tick, and the tick itself reports no error
    (proving the function is genuinely callable, not just present as dead text); (2) the
    GENERAL mechanism, not just the shipped example — a person's own CUSTOM function
    added to store.batchScriptCode (simulating an edit via the Script Console) is
    equally callable from a part script, using that function's own return value to
    influence the part's `value` output, not just logging; (3) an ORDINARY part script
    that never references any batchScriptCode function at all still behaves exactly as
    before (a plain `return { value: ... }` with no dependency on the new prefix) --
    proving this is additive, not a breaking change to the existing script contract."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const sim = await import('./js/simulation.js');
      const model = store.defaultModel;

      // (1) shipped default CommonScript_Example, unmodified store.batchScriptCode.
      const callerPart = store.createPart({
        type: 'GeneralActor', label: 'CommonScriptCaller', model, streams: [],
        script: 'CommonScript_Example(ctx); return { value: 1 };', scriptEnabled: true,
      });

      // (3) an ordinary script with no dependency on batchScriptCode at all.
      const plainPart = store.createPart({
        type: 'GeneralActor', label: 'PlainScriptCaller', model, streams: [],
        script: 'return { value: 42 };', scriptEnabled: true,
      });

      sim.stepSimulation(app, model);

      const rt1 = store.simRuntime.get(model);
      const callerEntry1 = rt1.values.get(callerPart.id);
      const plainEntry1 = rt1.values.get(plainPart.id);
      const logHasDefaultMessage = store.messageLog.some(e => JSON.stringify(e).includes(
        'called by GeneralActor CommonScriptCaller ' + model));

      // (2) a person's OWN custom function added to store.batchScriptCode -- simulates
      // editing it via the Script Console (same mechanism check_batch_script_code_
      // persists_with_local_settings uses to replace it wholesale) -- callable from a
      // part script too, using its return value in the part's own output.
      store.batchScriptCode = store.batchScriptCode + '\\nfunction CommonScript_Double(n) { return n * 2; }';
      const doublerPart = store.createPart({
        type: 'GeneralActor', label: 'DoublerCaller', model, streams: [],
        script: 'return { value: CommonScript_Double(21) };', scriptEnabled: true,
      });
      sim.stepSimulation(app, model);
      const rt2 = store.simRuntime.get(model);
      const doublerEntry = rt2.values.get(doublerPart.id);
      const plainEntry2 = rt2.values.get(plainPart.id);

      return {
        callerError: callerEntry1?.lastError,
        callerValue: callerEntry1?.value,
        logHasDefaultMessage,
        plainValue1: plainEntry1?.value,
        plainError1: plainEntry1?.lastError,
        doublerError: doublerEntry?.lastError,
        doublerValue: doublerEntry?.value,
        plainValue2: plainEntry2?.value,
        plainError2: plainEntry2?.lastError,
      };
    }
    """)
    problems = []
    if result["callerError"]:
        return False, f"expected a part calling the shipped CommonScript_Example(ctx) to run without error, got {result['callerError']}"
    if result["callerValue"] != 1:
        problems.append(f"expected the calling part's own returned value (1) to still come through unaffected, got {result['callerValue']}")
    if not result["logHasDefaultMessage"]:
        problems.append("expected the Message Log to contain 'called by GeneralActor CommonScriptCaller <model>' after CommonScript_Example(ctx) ran")
    if result["plainError1"] or result["plainValue1"] != 42:
        problems.append(f"expected an ordinary part script with no batchScriptCode dependency to behave exactly as before, got value={result['plainValue1']} error={result['plainError1']}")
    if result["doublerError"]:
        problems.append(f"expected a part calling a CUSTOM function just added to store.batchScriptCode to run without error, got {result['doublerError']}")
    if result["doublerValue"] != 42:
        problems.append(f"expected CommonScript_Double(21), called from a part script, to return 42, got {result['doublerValue']}")
    if result["plainError2"] or result["plainValue2"] != 42:
        problems.append(f"expected the ordinary part script to still behave the same on a later tick too (after batchScriptCode was edited), got value={result['plainValue2']} error={result['plainError2']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "a part's own script can call ANY function store.batchScriptCode defines -- both the shipped CommonScript_Example(ctx) (logging 'called by <type> <label> <model>') and a person's own custom addition -- while an ordinary part script with no such dependency behaves exactly as before"


def check_smart_stream_preset_local_persistence(page):
    """Regression guard: Insert Smart Stream's named presets (store.smartStreamPresets)
    are Local Settings — reported directly: "Add ability to create and maintain a list
    of smartStream settings, called something like smartStreamPreset... These should be
    saved local, not in the save json file." Covers: (1) a default preset named
    "StreamSet1" ships out of the box, matching BatchScript_InsertSmartStreamExample's
    own parameters exactly; (2) smartStreamPresets never appears in store.toJSON()'s
    output (the actual Save JSON document) — it must never round-trip through the save
    file; (3) same File > Load Local Settings + localStorage-cache + reload-survives
    story as batchScriptCode/maxScriptEntities already have (see
    check_batch_script_code_persists_with_local_settings) — proven independently here
    since presets are a different LOCAL_SETTINGS_CACHE_KEY member with its own load/
    cache code path (setCachedSmartStreamPresets)."""
    default_presets = js(page, "async () => window.dycadApp.store.smartStreamPresets")
    if not isinstance(default_presets, list) or not any(p.get("name") == "StreamSet1" for p in default_presets):
        return False, f"expected a default preset named 'StreamSet1' to ship out of the box, got {default_presets}"
    stream_set_1 = next(p for p in default_presets if p["name"] == "StreamSet1")
    expected = {
        "connectorType": "c", "startType": "BusinessFunction", "startInstanceLabels": ["Production"],
        "direction": "both", "endType": "DataDataEntity", "levels": None,
        "showTypes": ["ApplicationCapability", "BusinessFunction", "BusinessProcess", "BusinessCapability", "DataDataEntity", "GeneralActor", "TechnologyLogicalComponent"],
    }
    for key, val in expected.items():
        if stream_set_1.get(key) != val:
            return False, f"StreamSet1's {key} should be {val!r} (matching BatchScript_InsertSmartStreamExample), got {stream_set_1.get(key)!r} -- full preset: {stream_set_1}"

    doc_json = js(page, "async () => JSON.stringify(window.dycadApp.store.toJSON())")
    if "smartStreamPresets" in doc_json or "StreamSet1" in doc_json:
        return False, "smartStreamPresets must never appear in store.toJSON() (the actual Save JSON document) -- these are Local Settings, not document data"

    custom_presets = [{"name": "RegrPreset", "connectorType": "s", "startType": "BusinessActor", "startInstanceLabels": ["X"], "direction": "upstream", "endType": None, "levels": 3, "showTypes": ["BusinessActor"]}]

    js(page, f"""
    async () => {{
      const text = {json.dumps(json.dumps({"smartStreamPresets": custom_presets}))};
      const blob = new Blob([text], {{ type: 'application/json' }});
      const file = new File([blob], 'test.json', {{ type: 'application/json' }});
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('load-local-settings-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {{ bubbles: true }}));
      await new Promise(r => setTimeout(r, 150));
    }}
    """)

    before = js(page, """
    async () => ({
      presets: window.dycadApp.store.smartStreamPresets,
      cached: localStorage.getItem('dycad-local-settings-cache'),
    })
    """)
    if before["presets"] != custom_presets:
        return False, f"smartStreamPresets didn't load correctly from the Local Settings file: {before}"
    if not before["cached"] or json.loads(before["cached"]).get("smartStreamPresets") != custom_presets:
        return False, f"smartStreamPresets wasn't cached to localStorage on load: {before}"

    page.reload()
    page.wait_for_timeout(1200)

    after = js(page, "async () => ({ presets: window.dycadApp.store.smartStreamPresets })")
    if after["presets"] != custom_presets:
        return False, f"smartStreamPresets did not auto-apply from its localStorage cache after reload: {after}"

    return True, "a default 'StreamSet1' preset ships matching BatchScript_InsertSmartStreamExample, smartStreamPresets never appears in the Save JSON document, and it loads from a Local Settings file, caches to localStorage, and auto-applies on the next page load with no file re-selection"


def check_smart_stream_preset_dialog_save_and_load(page):
    """Regression guard for the Insert Smart Stream dialog's Preset row (Save As.../
    Load buttons, main.js's promptInsertSmartStream) — reported directly: "Add load
    from or save to dialog either on page or another page/tab of the dialog." Covers:
    Save As collects the CURRENT dialog field values (including only the CHECKED
    Starting Element Instances, by label) into a named preset, adds it to
    store.smartStreamPresets (or overwrites an existing same-named one), caches it, and
    the Preset dropdown immediately offers the new name; Load re-populates every field
    from a chosen preset -- connector type, direction, ending element, levels, the
    Starting Element type AND re-rendering its instance checklist to check exactly the
    labels the preset remembers, and the Element Types to Show checklist -- and degrades
    gracefully (leaves that part unchecked, warns via an error-styled toast) when a
    remembered starting-instance label no longer matches any real part."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const fn = store.createPart({ type: 'BusinessFunction', label: 'RegrPresetFn', model, streams: [] });
      const proc = store.createPart({ type: 'BusinessProcess', label: 'RegrPresetProc', model, streams: [] });
      const cap = store.createPart({ type: 'ApplicationCapability', label: 'RegrPresetCap', model, streams: [] });
      store.createConnector({ from: fn.id, to: proc.id, connectorType: 'c', model, relationship: 'Association' });
      store.createConnector({ from: proc.id, to: cap.id, connectorType: 'c', model, relationship: 'Association' });

      const view = store.addView('RegrPresetDialog_view', 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const out = {};

      // --- Save As: set some non-default field values, then save as a new preset. ---
      app.promptInsertSmartStream(tab);
      await new Promise(r => setTimeout(r, 30));
      let box = document.querySelector('.modal-box.modal-box-wide');
      box.querySelector('#ss-connector-type').value = 'c';
      box.querySelector('#ss-direction').value = 'downstream';
      box.querySelector('#ss-start-type').value = 'BusinessFunction';
      box.querySelector('#ss-start-type').dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 30));
      box.querySelector('#ss-end-type').value = 'ApplicationCapability';
      box.querySelector('#ss-levels').value = '5';
      [...box.querySelectorAll('.ss-type-cb')].forEach(cb => { cb.checked = (cb.value === 'BusinessFunction' || cb.value === 'BusinessProcess'); });

      box.querySelector('#ss-preset-save').click();
      await new Promise(r => setTimeout(r, 30));
      const nameInput = [...document.querySelectorAll('.modal-box')].find(b => b.querySelector('h3')?.textContent === 'Save Smart Stream Preset').querySelector('input[data-key=\"name\"]');
      nameInput.value = 'RegrDialogPreset';
      [...document.querySelectorAll('.modal-box')].find(b => b.querySelector('h3')?.textContent === 'Save Smart Stream Preset').querySelector('.submit').click();
      await new Promise(r => setTimeout(r, 30));

      out.presetSavedToStore = (store.smartStreamPresets || []).some(p => p.name === 'RegrDialogPreset');
      const saved = (store.smartStreamPresets || []).find(p => p.name === 'RegrDialogPreset');
      out.savedShape = saved ? { connectorType: saved.connectorType, direction: saved.direction, startType: saved.startType, startInstanceLabels: saved.startInstanceLabels, endType: saved.endType, levels: saved.levels, showTypes: (saved.showTypes || []).sort() } : null;
      const cachedAfterSave = JSON.parse(localStorage.getItem('dycad-local-settings-cache') || '{}').smartStreamPresets;
      out.presetCachedAfterSave = Array.isArray(cachedAfterSave) && cachedAfterSave.some(p => p.name === 'RegrDialogPreset');
      out.dropdownOffersNewPreset = [...box.querySelectorAll('#ss-preset-select option')].some(o => o.value === 'RegrDialogPreset');

      box.querySelector('.cancel').click();
      await new Promise(r => setTimeout(r, 30));

      // --- Load: reopen fresh, load the just-saved preset, verify every field populated. ---
      app.promptInsertSmartStream(tab);
      await new Promise(r => setTimeout(r, 30));
      box = document.querySelector('.modal-box.modal-box-wide');
      box.querySelector('#ss-preset-select').value = 'RegrDialogPreset';
      box.querySelector('#ss-preset-load').click();
      await new Promise(r => setTimeout(r, 30));

      out.loadedConnectorType = box.querySelector('#ss-connector-type').value;
      out.loadedDirection = box.querySelector('#ss-direction').value;
      out.loadedStartType = box.querySelector('#ss-start-type').value;
      out.loadedEndType = box.querySelector('#ss-end-type').value;
      out.loadedLevels = box.querySelector('#ss-levels').value;
      out.loadedCheckedInstances = [...box.querySelectorAll('.ss-start-instance-cb')].filter(c => c.checked).map(c => c.closest('label').textContent.trim());
      out.loadedCheckedTypes = [...box.querySelectorAll('.ss-type-cb')].filter(c => c.checked).map(c => c.value).sort();

      box.querySelector('.cancel').click();
      await new Promise(r => setTimeout(r, 30));

      // --- Load with a starting-instance label that no longer exists anywhere. ---
      store.smartStreamPresets = [...store.smartStreamPresets, { name: 'RegrGhostPreset', connectorType: 'c', startType: 'BusinessFunction', startInstanceLabels: ['NoSuchPartLabel'], direction: 'both', endType: null, levels: null, showTypes: ['BusinessFunction'] }];
      app.promptInsertSmartStream(tab);
      await new Promise(r => setTimeout(r, 30));
      box = document.querySelector('.modal-box.modal-box-wide');
      box.querySelector('#ss-preset-select').value = 'RegrGhostPreset';
      box.querySelector('#ss-preset-load').click();
      await new Promise(r => setTimeout(r, 30));
      out.ghostLoadCheckedInstances = [...box.querySelectorAll('.ss-start-instance-cb')].filter(c => c.checked).map(c => c.closest('label').textContent.trim());
      out.ghostLoadToastIsError = document.querySelector('.toast.error')?.textContent.includes('RegrGhostPreset') || false;
      box.querySelector('.cancel').click();

      return out;
    }
    """)
    problems = []
    if not result["presetSavedToStore"]:
        problems.append("Save As should add the new preset to store.smartStreamPresets")
    expected_saved = {"connectorType": "c", "direction": "downstream", "startType": "BusinessFunction", "startInstanceLabels": ["RegrPresetFn"], "endType": "ApplicationCapability", "levels": 5, "showTypes": ["BusinessFunction", "BusinessProcess"]}
    if result["savedShape"] != expected_saved:
        problems.append(f"Save As should capture the CURRENT dialog field values (including only checked instances/types), expected {expected_saved}, got {result['savedShape']}")
    if not result["presetCachedAfterSave"]:
        problems.append("Save As should cache the updated presets list to localStorage immediately")
    if not result["dropdownOffersNewPreset"]:
        problems.append("the Preset dropdown should immediately offer the newly saved preset's name, in the same dialog instance")
    if (result["loadedConnectorType"], result["loadedDirection"], result["loadedStartType"], result["loadedEndType"], result["loadedLevels"]) != ("c", "downstream", "BusinessFunction", "ApplicationCapability", "5"):
        problems.append(f"Load should repopulate connector type/direction/starting element/ending element/levels from the preset, got connectorType={result['loadedConnectorType']} direction={result['loadedDirection']} startType={result['loadedStartType']} endType={result['loadedEndType']} levels={result['loadedLevels']}")
    if result["loadedCheckedInstances"] != ["RegrPresetFn"]:
        problems.append(f"Load should re-render the Starting Element Instances checklist for the preset's type and check exactly the remembered label(s), got {result['loadedCheckedInstances']}")
    if result["loadedCheckedTypes"] != ["BusinessFunction", "BusinessProcess"]:
        problems.append(f"Load should check exactly the Element Types to Show the preset remembers, got {result['loadedCheckedTypes']}")
    if result["ghostLoadCheckedInstances"] != []:
        problems.append(f"loading a preset whose starting-instance label no longer matches any real part should leave the checklist unchecked (not silently check something else), got {result['ghostLoadCheckedInstances']}")
    if not result["ghostLoadToastIsError"]:
        problems.append("loading a preset with an unresolvable starting-instance label should show an error-styled toast naming the preset")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Insert Smart Stream's Preset row saves the current dialog state as a named, persisted preset (offered immediately in the dropdown) and loads one back in field-for-field, including re-checking Starting Element Instances by label and degrading gracefully when a label no longer resolves"


def check_instructions_closed_persists_across_reload(page):
    """Regression guard: closing the Instructions tab should be a real "don't show this
    again" — cached to localStorage (the same LOCAL_SETTINGS_CACHE_KEY blob
    maxScriptEntities uses, read-modify-write merged so the two never clobber each
    other), so bootstrapApp does NOT reopen it on the next page load. The Help button
    must still open it regardless of the cached flag."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const out = {};
      out.docsPresentInitially = store.tabs.some(t => t.type === 'docs');
      const closeBtn = [...document.querySelectorAll('.tab-item')]
        .find(el => el.textContent.includes('Instructions'))?.querySelector('.tab-close');
      closeBtn?.click();
      await new Promise(r => setTimeout(r, 100));
      out.cachedClosed = JSON.parse(localStorage.getItem('dycad-local-settings-cache') || '{}').instructionsClosed === true;
      return out;
    }
    """)
    if not result["docsPresentInitially"]:
        return False, "Instructions tab wasn't open on first load — can't test closing it"
    if not result["cachedClosed"]:
        return False, f"closing Instructions didn't cache instructionsClosed=true: {result}"

    page.reload()
    page.wait_for_timeout(1200)
    result2 = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const out = {};
      out.docsPresentAfterReload = store.tabs.some(t => t.type === 'docs');
      out.activeIsCanvas = store.activeTab()?.type === 'canvas';
      document.getElementById('help-btn').click();
      await new Promise(r => setTimeout(r, 300));
      out.docsPresentAfterHelpClick = store.tabs.some(t => t.type === 'docs');
      return out;
    }
    """)
    if result2["docsPresentAfterReload"]:
        return False, f"Instructions tab reopened on reload despite being closed previously: {result2}"
    if not result2["activeIsCanvas"]:
        return False, f"expected the home canvas tab to be active when Instructions doesn't auto-open: {result2}"
    if not result2["docsPresentAfterHelpClick"]:
        return False, f"Help button failed to reopen Instructions even though the user can still do so manually: {result2}"

    return True, "closing Instructions sticks across a reload (no auto-reopen), while the Help button still opens it on demand"


def check_stream_template_shared_default(page):
    """Regression guard: picking a Stream Template in one dialog (Remap) should become
    the default selection in every OTHER dialog that also offers a Stream Template picker
    (Generate Stream, Smart Check View's Auto-Complete Streams option) — cached to
    localStorage (LOCAL_SETTINGS_CACHE_KEY's streamTemplate member) so it survives a page
    reload too, not just later dialogs in the same session."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.addView('RegrTemplateShare_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const templateNames = (store.settings.streamTemplates || []).map(t => t.name);
      const nonDefault = templateNames.find(n => n !== 'Enterprise');

      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      document.getElementById('rm-template').value = nonDefault;
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 80));

      return { nonDefault, cached: JSON.parse(localStorage.getItem('dycad-local-settings-cache') || '{}').streamTemplate };
    }
    """)
    if not result["nonDefault"]:
        return False, "test setup itself is wrong — need at least 2 stream templates to pick a non-default one"
    if result["cached"] != result["nonDefault"]:
        return False, f"Remap's chosen template wasn't cached as the shared default: {result}"

    page.reload()
    page.wait_for_timeout(1200)
    result2 = js(page, f"""
    async () => {{
      const app = window.dycadApp, store = app.store;
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);

      app.runCommand('generate', null);
      await new Promise(r => setTimeout(r, 30));
      const generateDefault = document.getElementById('gs-template')?.value;
      document.querySelector('.modal-overlay .cancel')?.click();
      await new Promise(r => setTimeout(r, 30));

      app.promptSmartCheckView();
      await new Promise(r => setTimeout(r, 30));
      const smartCheckDefault = document.getElementById('scv-autocomplete-template')?.value;
      document.querySelector('.modal-overlay .cancel')?.click();

      return {{ generateDefault, smartCheckDefault }};
    }}
    """)
    if result2["generateDefault"] != result["nonDefault"]:
        return False, f"Generate Stream's default template after reload should be {result['nonDefault']!r}, got: {result2}"
    if result2["smartCheckDefault"] != result["nonDefault"]:
        return False, f"Smart Check View's Auto-Complete Streams default template after reload should be {result['nonDefault']!r}, got: {result2}"
    return True, f"picking {result['nonDefault']!r} in Remap made it the shared default for Generate Stream and Smart Check View, surviving a reload"


def check_remap_options_persist_across_views(page):
    """Regression guard: Remap's own options (pattern, limit-columns, filtered-only,
    minimize connector crossings, minimize connector length, the two force-directed
    sub-options, and sort priority order) should be remembered as user-level defaults
    across ALL views, not just the
    specific view they were set on — so even a brand-new view's Remap dialog starts
    from them, surviving a page reload. Distinct from (and lower-priority than)
    view.remapSortKeys, which remembers a specific view's own last-used order and still
    wins once that view has its own history — this only checks the fallback a fresh
    view gets."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.addView('RegrRemapOptsA_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const commands = await import('./js/commands.js');
      commands.createStream(app, {
        templateName: 'Enterprise', streamName: 'RegrRemapOptsStream',
        functionName: 'RegrFunc', capabilityName: 'RegrCap', entityName: 'RegrEnt',
        modelName: store.defaultModel, viewName: view.id, silent: true,
      });

      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      document.getElementById('rm-pattern').value = 'force';
      document.getElementById('rm-pattern').dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('rm-limit').checked = true;
      document.getElementById('rm-filtered-only').checked = true;
      document.getElementById('rm-minimize-crossings').checked = true;
      document.getElementById('rm-minimize-length').checked = true;
      document.getElementById('rm-force-prefer-right').checked = true;
      document.getElementById('rm-force-group-rows').checked = true;
      // move the first sort-priority item down one slot, so the new first item is
      // distinguishable from DEFAULT_REMAP_SORT_KEYS' own first item ('streamName')
      document.querySelector('#rm-priority-list .rm-down[data-idx="0"]').click();
      const reorderedFirstKey = document.querySelector('#rm-priority-list li').dataset.key;
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 80));

      return { reorderedFirstKey };
    }
    """)
    if not result["reorderedFirstKey"] or result["reorderedFirstKey"] == "streamName":
        return False, f"test setup itself is wrong — reordering didn't change the first sort-priority key: {result}"

    page.reload()
    page.wait_for_timeout(1200)
    result2 = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.addView('RegrRemapOptsB_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      const out = {
        pattern: document.getElementById('rm-pattern').value,
        limit: document.getElementById('rm-limit').checked,
        filteredOnly: document.getElementById('rm-filtered-only').checked,
        minimizeCrossings: document.getElementById('rm-minimize-crossings').checked,
        minimizeConnectorLength: document.getElementById('rm-minimize-length').checked,
        forcePreferRight: document.getElementById('rm-force-prefer-right').checked,
        forceGroupRows: document.getElementById('rm-force-group-rows').checked,
        firstKey: document.querySelector('#rm-priority-list li')?.dataset.key,
      };
      document.querySelector('.modal-overlay .cancel')?.click();
      return out;
    }
    """)
    problems = []
    if result2["pattern"] != "force": problems.append(f"pattern default should be 'force', got {result2['pattern']!r}")
    if not result2["limit"]: problems.append("'Limit columns to view' should default checked")
    if not result2["filteredOnly"]: problems.append("'Only remap filtered nodes' should default checked")
    if not result2["minimizeCrossings"]: problems.append("'Minimize connector crossings' should default checked")
    if not result2["minimizeConnectorLength"]: problems.append("'Minimize connector length' should default checked")
    if not result2["forcePreferRight"]: problems.append("'Prefer placing connected nodes to the right' should default checked")
    if not result2["forceGroupRows"]: problems.append("'Only start a new row when a node is a new hop away' should default checked")
    if result2["firstKey"] != result["reorderedFirstKey"]: problems.append(f"sort priority order should default to the previously-reordered order (first key {result['reorderedFirstKey']!r}), got {result2['firstKey']!r}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result2})"
    return True, "Remap's options (pattern, checkboxes including minimize crossings and minimize connector length, sort order) persisted as user-level defaults onto a brand-new view, surviving a reload"


def check_remap_edge_assignment_and_layout_optimization(page):
    """Regression guard for commands.js's applyRemapLayout Edge Assignment, Minimize
    Crossings, and Minimize Connector Length options ('default'/'none' patterns only).
    Reported directly: "let's add similar load/save settings for remap, with
    additional options for laying out the nodes. Specifically the ability to specify
    what goes on top of view, bottom, etc" and (on scope) "business actors on left,
    business functions on top, data entities on bottom, ordered by connector
    order/natural flow... Cleanly separate streams or clusters/groups with minimal
    connectors crossing", then later: "add 'minimize connector length' and move nodes
    to similar positions but closer." Calls applyRemapLayout directly, covering: (1)
    edgeAssignment pulls BusinessActor to the single leftmost column, BusinessFunction
    to the single topmost row, and DataDataEntity to the single bottommost row, with
    the remaining (unassigned) BusinessProcess type left in its normal middle grid,
    strictly between the top and bottom bands vertically; (2) edge-band members are
    ordered by the chosen sortKeys (nodeLabel here, with labels deliberately reversed
    from creation order so the assertion distinguishes "ordered by sortKeys" from
    "ordered by creation/insertion order") rather than arbitrarily; (3)
    minimizeCrossings, run on a deliberately crossing pattern (two middle-grid rows
    connected so the naive nodeLabel-sorted column order crosses), actually reorders
    columns in the second row to eliminate the crossing -- verified by literal
    crossing-count comparison with vs. without the option, not just "some position
    changed"; (4) minimizeConnectorLength, run on a single unconstrained node (a
    lone occupant of its own row, so no same-row neighbor blocks it from moving) whose
    only connection sits at the far side of a 3-node row below, actually slides it to
    align directly with that connection -- verified by literal Euclidean distance
    reduction, not just "some position changed" -- while leaving every OTHER node's
    position completely untouched; (4b) a REAL bug found via user testing:
    minimizeConnectorLength originally only touched the middle grid, so a part pinned
    via Edge Assignment (e.g. Business Function on Top) never moved even when
    connected to an off-center middle-grid node, defeating the "shorter connector"
    promise for anything pinned to an edge -- verified an edge-band member's cross
    axis now aligns with its middle-grid connection too; (6) a SECOND real bug found
    via user testing, in the shipped BatchScript_RemapExample's own output: an edge
    band's ORDER came only from sortKeys, never from crossing minimization, so
    alphabetical order could still disagree with what the middle grid needs and
    produce a genuine visible crossing even with Minimize Crossings checked -- two
    middle-grid capabilities each connected to one exclusive Data Entity plus a THIRD,
    shared entity, with entity labels chosen so alphabetical order crosses; verified
    minimizeCrossings:true now reorders the band (not just the middle grid) so the
    shared entity lands between its two exclusive siblings, eliminating the crossing --
    exactly the "Bill of Materials / Demand Forecast / Production Schedule" case
    reported; (5) sectioned/force patterns ignore all three options entirely without
    erroring."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const mk = (type, label) => store.createPart({ type, label, model, streams: [] });
      const conn = (from, to) => store.createConnector({ from: from.id, to: to.id, connectorType: 'c', model, relationship: 'Association' });
      const freshView = (name, viewType) => {
        const view = store.addView(name + '_' + Date.now(), viewType || 'ff');
        const tab = app.createCanvasTab(view);
        app.switchToTab(tab.id);
        return { view, tab };
      };
      const placeAll = (view, parts, conns) => {
        const vmByPart = new Map();
        for (const p of parts) { const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: p.id, x: 0, y: 0 }); vmByPart.set(p.id, vm); }
        for (const c of conns) {
          const fromVm = vmByPart.get(c.from), toVm = vmByPart.get(c.to);
          if (fromVm && toVm) store.createViewMember({ view: view.id, objectType: 'connector', objectId: c.id, fromVmId: fromVm.id, toVmId: toVm.id });
        }
      };

      const out = {};

      // 1+2) Edge assignment placement + ordering within a band. Labels chosen so
      // alphabetical (nodeLabel) order is the OPPOSITE of creation order below, so the
      // ordering assertion actually distinguishes "ordered by sortKeys" from "ordered
      // by creation/insertion order".
      const actorZ = mk('BusinessActor', 'ActorZ'), actorA = mk('BusinessActor', 'ActorA');
      const fn1 = mk('BusinessFunction', 'Fn1'), fn2 = mk('BusinessFunction', 'Fn2');
      const proc1 = mk('BusinessProcess', 'Proc1'), proc2 = mk('BusinessProcess', 'Proc2');
      const de1 = mk('DataDataEntity', 'De1'), de2 = mk('DataDataEntity', 'De2');
      conn(actorZ, fn2); conn(actorA, fn1);
      conn(fn1, proc1); conn(fn2, proc2);
      conn(proc1, de1); conn(proc2, de2);
      const { view: v1 } = freshView('RegrRemapEdge');
      placeAll(v1, [actorZ, actorA, fn1, fn2, proc1, proc2, de1, de2], store.doc.connectors);
      commands.applyRemapLayout(app, v1.id, {
        pattern: 'default', sortKeys: ['nodeLabel'],
        edgeAssignment: { BusinessActor: 'left', BusinessFunction: 'top', DataDataEntity: 'bottom' },
      });
      const posOf = (view, label) => {
        const vm = store.viewMembersForView(view.id).find(v => v.objectType === 'part' && store.findPart(v.objectId)?.label === label);
        return vm ? { x: vm.x, y: vm.y } : null;
      };
      const pActorZ = posOf(v1, 'ActorZ'), pActorA = posOf(v1, 'ActorA');
      const pFn1 = posOf(v1, 'Fn1'), pFn2 = posOf(v1, 'Fn2');
      const pProc1 = posOf(v1, 'Proc1'), pProc2 = posOf(v1, 'Proc2');
      const pDe1 = posOf(v1, 'De1'), pDe2 = posOf(v1, 'De2');
      const allY = [pActorZ, pActorA, pFn1, pFn2, pProc1, pProc2, pDe1, pDe2].map(p => p.y);
      const allX = [pActorZ, pActorA, pFn1, pFn2, pProc1, pProc2, pDe1, pDe2].map(p => p.x);
      out.actorsShareMinX = pActorZ.x === pActorA.x && pActorZ.x === Math.min(...allX);
      out.fnsShareMinY = pFn1.y === pFn2.y && pFn1.y === Math.min(...allY);
      out.desShareMaxY = pDe1.y === pDe2.y && pDe1.y === Math.max(...allY);
      out.procsBetween = pProc1.y > Math.min(...allY) && pProc1.y < Math.max(...allY) && pProc2.y === pProc1.y;
      // nodeLabel-driven band ordering: 'ActorA' (created SECOND) should still sort
      // before 'ActorZ' (created FIRST) in the left band's column position, since the
      // band is ordered by the sortKeys (here just nodeLabel), not creation order.
      out.actorBandOrderMatchesSortKeys = pActorA.y < pActorZ.y;

      // 3) crossing minimization: two middle rows with a deliberate crossing pattern.
      const procX = mk('BusinessProcess', 'ProcX'), procY = mk('BusinessProcess', 'ProcY');
      const capA = mk('ApplicationCapability', 'CapA'), capB = mk('ApplicationCapability', 'CapB');
      const crossConns = [
        store.createConnector({ from: procX.id, to: capB.id, connectorType: 'c', model, relationship: 'Association' }),
        store.createConnector({ from: procY.id, to: capA.id, connectorType: 'c', model, relationship: 'Association' }),
      ];
      const { view: v2 } = freshView('RegrRemapCrossOff');
      placeAll(v2, [procX, procY, capA, capB], crossConns);
      commands.applyRemapLayout(app, v2.id, { pattern: 'default', sortKeys: ['nodeLabel'], minimizeCrossings: false });
      out.withoutMin = { procX: posOf(v2, 'ProcX'), procY: posOf(v2, 'ProcY'), capA: posOf(v2, 'CapA'), capB: posOf(v2, 'CapB') };

      const { view: v3 } = freshView('RegrRemapCrossOn');
      placeAll(v3, [procX, procY, capA, capB], crossConns);
      commands.applyRemapLayout(app, v3.id, { pattern: 'default', sortKeys: ['nodeLabel'], minimizeCrossings: true });
      out.withMin = { procX: posOf(v3, 'ProcX'), procY: posOf(v3, 'ProcY'), capA: posOf(v3, 'CapA'), capB: posOf(v3, 'CapB') };

      // 4) connector-length minimization: a single unconstrained node (Row1, alone --
      // no same-row neighbor to block it) whose only connection is to the RIGHTMOST of
      // three Row2 nodes.
      const lone = mk('BusinessProcess', 'Lone');
      const capL1 = mk('ApplicationCapability', 'CapL1'), capL2 = mk('ApplicationCapability', 'CapL2'), capL3 = mk('ApplicationCapability', 'CapL3');
      const lenConns = [store.createConnector({ from: lone.id, to: capL3.id, connectorType: 'c', model, relationship: 'Association' })];
      const { view: v6 } = freshView('RegrRemapLenOff');
      placeAll(v6, [lone, capL1, capL2, capL3], lenConns);
      commands.applyRemapLayout(app, v6.id, { pattern: 'default', sortKeys: ['nodeLabel'], minimizeConnectorLength: false });
      out.lenOff = { lone: posOf(v6, 'Lone'), capL1: posOf(v6, 'CapL1'), capL2: posOf(v6, 'CapL2'), capL3: posOf(v6, 'CapL3') };

      const { view: v7 } = freshView('RegrRemapLenOn');
      placeAll(v7, [lone, capL1, capL2, capL3], lenConns);
      commands.applyRemapLayout(app, v7.id, { pattern: 'default', sortKeys: ['nodeLabel'], minimizeConnectorLength: true });
      out.lenOn = { lone: posOf(v7, 'Lone'), capL1: posOf(v7, 'CapL1'), capL2: posOf(v7, 'CapL2'), capL3: posOf(v7, 'CapL3') };

      // 4b) real bug found via user testing: minimizeConnectorLength only aligned the
      // MIDDLE grid -- an edge-band member (e.g. a Business Function pinned to Top)
      // never budged from its fixed, evenly-spaced band slot even when connected to a
      // middle-grid node far off to one side, so the "shorter connector" promise never
      // applied to anything pinned via Edge Assignment. Business Function (top),
      // General Actor (left), Data Entity (bottom) around a small BusinessProcess
      // middle row -- Fn connects only to the RIGHTMOST BusinessProcess, so it should
      // slide right to align with it.
      const bandFn = mk('BusinessFunction', 'BandFn');
      const bandProcA = mk('BusinessProcess', 'BandProcA'), bandProcB = mk('BusinessProcess', 'BandProcB'), bandProcC = mk('BusinessProcess', 'BandProcC');
      const bandConns = [store.createConnector({ from: bandFn.id, to: bandProcC.id, connectorType: 'c', model, relationship: 'Association' })];
      const { view: v8 } = freshView('RegrRemapBandAlign');
      placeAll(v8, [bandFn, bandProcA, bandProcB, bandProcC], bandConns);
      commands.applyRemapLayout(app, v8.id, {
        pattern: 'default', sortKeys: ['nodeLabel'],
        edgeAssignment: { BusinessFunction: 'top' },
        minimizeConnectorLength: true,
      });
      out.bandFnPos = posOf(v8, 'BandFn');
      out.bandProcCPos = posOf(v8, 'BandProcC');

      // 6) real bug found via user testing (from the shipped BatchScript_RemapExample):
      // an edge band's ORDER came only from sortKeys, never from crossing minimization
      // -- so alphabetical order could disagree with what the middle grid actually
      // needs, producing a genuine visible crossing Minimize Crossings was supposed to
      // prevent. Two middle-grid capabilities, CapLeft and CapRight; three bottom-band
      // entities named so ALPHABETICAL order ('EntBillOfMaterials' < 'EntDemand' <
      // 'EntSchedule') disagrees with the correct order -- EntSchedule connects to
      // BOTH capabilities and belongs BETWEEN EntBillOfMaterials (CapLeft-only) and
      // EntDemand (CapRight-only), exactly the reported "Bill of Materials, Demand
      // Forecast, Production Schedule" crossing.
      const capLeft = mk('ApplicationCapability', 'CapLeft'), capRight = mk('ApplicationCapability', 'CapRight');
      const entBom = mk('DataDataEntity', 'EntBillOfMaterials'), entDemand = mk('DataDataEntity', 'EntDemand'), entSchedule = mk('DataDataEntity', 'EntSchedule');
      const bandCrossConns = [
        store.createConnector({ from: capLeft.id, to: entBom.id, connectorType: 'c', model, relationship: 'Association' }),
        store.createConnector({ from: capLeft.id, to: entSchedule.id, connectorType: 'c', model, relationship: 'Association' }),
        store.createConnector({ from: capRight.id, to: entSchedule.id, connectorType: 'c', model, relationship: 'Association' }),
        store.createConnector({ from: capRight.id, to: entDemand.id, connectorType: 'c', model, relationship: 'Association' }),
      ];
      const { view: v9 } = freshView('RegrRemapBandCrossOff');
      placeAll(v9, [capLeft, capRight, entBom, entDemand, entSchedule], bandCrossConns);
      commands.applyRemapLayout(app, v9.id, {
        pattern: 'default', sortKeys: ['nodeLabel'],
        edgeAssignment: { DataDataEntity: 'bottom' },
        minimizeCrossings: false,
      });
      out.bandCrossOff = { capLeft: posOf(v9, 'CapLeft'), capRight: posOf(v9, 'CapRight'), entBom: posOf(v9, 'EntBillOfMaterials'), entDemand: posOf(v9, 'EntDemand'), entSchedule: posOf(v9, 'EntSchedule') };

      const { view: v10 } = freshView('RegrRemapBandCrossOn');
      placeAll(v10, [capLeft, capRight, entBom, entDemand, entSchedule], bandCrossConns);
      commands.applyRemapLayout(app, v10.id, {
        pattern: 'default', sortKeys: ['nodeLabel'],
        edgeAssignment: { DataDataEntity: 'bottom' },
        minimizeCrossings: true,
      });
      out.bandCrossOn = { capLeft: posOf(v10, 'CapLeft'), capRight: posOf(v10, 'CapRight'), entBom: posOf(v10, 'EntBillOfMaterials'), entDemand: posOf(v10, 'EntDemand'), entSchedule: posOf(v10, 'EntSchedule') };

      // 5) force pattern + sectioned view all ignore the three options without erroring.
      const { view: v4, tab: t4 } = freshView('RegrRemapForceIgnore');
      const fPart = mk('BusinessActor', 'ForceActor');
      store.createViewMember({ view: v4.id, objectType: 'part', objectId: fPart.id, x: 0, y: 0 });
      let forceThrew = false;
      try {
        commands.applyRemapLayout(app, v4.id, { pattern: 'force', edgeAssignment: { BusinessActor: 'left' }, minimizeCrossings: true, minimizeConnectorLength: true });
      } catch (e) { forceThrew = true; }
      out.forceDidNotThrow = !forceThrew;

      const { view: v5 } = freshView('RegrRemapSectionIgnore', 'org');
      const sPart = mk('BusinessActor', 'SectionActor');
      store.createViewMember({ view: v5.id, objectType: 'part', objectId: sPart.id, x: 0, y: 0, sectionId: '' });
      let sectionThrew = false;
      try {
        commands.applyRemapLayout(app, v5.id, { pattern: 'default', edgeAssignment: { BusinessActor: 'left' }, minimizeCrossings: true, minimizeConnectorLength: true });
      } catch (e) { sectionThrew = true; }
      out.sectionDidNotThrow = !sectionThrew;

      return out;
    }
    """)
    problems = []
    if not result["actorsShareMinX"]:
        problems.append(f"edgeAssignment:left should place both BusinessActor parts at the single leftmost column, got Actor1/2 positions imply otherwise (full: {result})")
    if not result["fnsShareMinY"]:
        problems.append("edgeAssignment:top should place both BusinessFunction parts on the single topmost row")
    if not result["desShareMaxY"]:
        problems.append("edgeAssignment:bottom should place both DataDataEntity parts on the single bottommost row")
    if not result["procsBetween"]:
        problems.append("unassigned BusinessProcess parts should stay in the normal middle grid, strictly between the top and bottom edge bands")
    if not result["actorBandOrderMatchesSortKeys"]:
        problems.append("edge band members should be ordered by the chosen sortKeys (nodeLabel here), not creation/insertion order")
    wm, wom = result["withMin"], result["withoutMin"]
    def crossing_count(pos):
        proc_order = sorted(["procX", "procY"], key=lambda k: pos[k]["x"])
        edges = {"procX": "capB", "procY": "capA"}
        expected_cap_order = [edges[p] for p in proc_order]
        actual_cap_order = sorted(["capA", "capB"], key=lambda k: pos[k]["x"])
        return 0 if expected_cap_order == actual_cap_order else 1
    if crossing_count(wom) != 1:
        problems.append(f"test setup itself is wrong -- expected a real crossing with minimizeCrossings:false (base nodeLabel-sorted order), got {wom}")
    if crossing_count(wm) != 0:
        problems.append(f"minimizeCrossings:true should reorder the second row's columns to eliminate the crossing, got {wm}")
    def dist(a, b):
        return math.hypot(a["x"] - b["x"], a["y"] - b["y"])
    lenOff, lenOn = result["lenOff"], result["lenOn"]
    distOff = dist(lenOff["lone"], lenOff["capL3"])
    distOn = dist(lenOn["lone"], lenOn["capL3"])
    if lenOff["lone"]["x"] != lenOff["capL1"]["x"]:
        problems.append(f"test setup itself is wrong -- expected the unconstrained node to default to the leftmost slot without minimizeConnectorLength, got {lenOff}")
    if not (distOn < distOff):
        problems.append(f"minimizeConnectorLength:true should slide the unconstrained node toward its only connection, shortening the connector, got distance {distOn} (was {distOff}) -- full: {lenOn} vs {lenOff}")
    if lenOn["capL1"] != lenOff["capL1"] or lenOn["capL2"] != lenOff["capL2"] or lenOn["capL3"] != lenOff["capL3"]:
        problems.append(f"minimizeConnectorLength should only move the unconstrained node itself, not any of the fixed row it's aligning to, got on={lenOn} off={lenOff}")
    if result["bandFnPos"]["x"] != result["bandProcCPos"]["x"]:
        problems.append(f"real bug: an Edge Assignment band member (Business Function pinned to Top) should also be aligned by minimizeConnectorLength toward its middle-grid connection, not just sit at its fixed evenly-spaced band slot -- expected BandFn's x to match BandProcC's x, got {result['bandFnPos']} vs {result['bandProcCPos']}")
    def band_crossing_count(pos):
        cap_order = sorted(["capLeft", "capRight"], key=lambda k: pos[k]["x"])
        # entSchedule connects to BOTH capabilities -- its correct position is BETWEEN
        # entBom (capLeft-only) and entDemand (capRight-only), regardless of which
        # capability is physically on the left; a crossing exists whenever entSchedule
        # does NOT sit strictly between the other two on x.
        lo, hi = sorted([pos["entBom"]["x"], pos["entDemand"]["x"]])
        return 0 if lo < pos["entSchedule"]["x"] < hi else 1
    if band_crossing_count(result["bandCrossOff"]) != 1:
        problems.append(f"test setup itself is wrong -- expected alphabetical sortKeys order (EntBillOfMaterials, EntDemand, EntSchedule) to produce a real crossing without minimizeCrossings, got {result['bandCrossOff']}")
    if band_crossing_count(result["bandCrossOn"]) != 0:
        problems.append(f"real bug (from the shipped BatchScript_RemapExample): minimizeCrossings:true should also reorder Edge Assignment bands against the middle grid (not just sortKeys), eliminating this crossing by placing EntSchedule between EntBillOfMaterials and EntDemand, got {result['bandCrossOn']}")
    if not result["forceDidNotThrow"]:
        problems.append("pattern:'force' with edgeAssignment/minimizeCrossings/minimizeConnectorLength set should ignore them silently, not throw")
    if not result["sectionDidNotThrow"]:
        problems.append("a section-based view with edgeAssignment/minimizeCrossings/minimizeConnectorLength set should ignore them silently, not throw")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "applyRemapLayout's Edge Assignment places pinned element types on a single top/bottom/left/right band, reordering band members against the middle grid (not just sortKeys) when Minimize Crossings is on so a shared connection lands between its two exclusive ones, Minimize Connector Length genuinely shortens real connectors (middle grid and edge bands alike), and all three options are safely ignored by the force pattern and section-based views"


def check_remap_edge_assignment_numbered_slots_and_blanks(page):
    """Regression guard/new-feature check for Edge Assignment's numbered slots (1-5 per
    edge) and forced-blank spacer slots. Reported directly: "for remap edge assignment
    (all applicable patterns); change left to be left 1, and add left 2, left 3 etc to
    5. likewise for other edges. this directs placement to be first column or row, 2nd
    column or row etc. from that specific edge. Add ability to specify 'blank', where
    nothing goes into that edge column or row." A bare 'left'/'top'/'bottom'/'right' (no
    digit -- the pre-v0.899 convention, still what every existing document/preset has
    stored) is treated as index 1 for backward compatibility (parseEdgeAssignmentValue,
    commands.js). Covers: (1) 'left1' and 'left2' assigned to two different element
    types produce two SEPARATE columns, 'left1' sitting exactly at the true left edge
    (baseX) and 'left2' one stepX further in, with the unassigned middle-grid part
    starting right after 'left2's column; (2) auto-compaction — 'left1' + 'left3' used,
    'left2' untouched and NOT forced blank — produces only two columns with NO gap
    between them (left3's occupant sits immediately next to left1's, one stepX apart,
    not two); (3) the companion case with edgeBlanks:{left:[2]} forcing 'left2' blank —
    now left3's occupant sits a full TWO stepX from left1's (a real reserved gap column
    in between, containing nothing); (4) same index-1-closest-to-edge / higher-index-
    closer-to-middle convention holds for 'top' (top1 at the true top, smaller y) and
    'bottom' (bottom1 farthest from the middle grid, larger y) as it already does for
    'left'."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const mk = (type, label) => store.createPart({ type, label, model, streams: [] });
      const freshView = (name) => {
        const view = store.addView(name + '_' + Date.now(), 'ff');
        const tab = app.createCanvasTab(view);
        app.switchToTab(tab.id);
        return view;
      };
      const place = (view, parts) => { for (const p of parts) store.createViewMember({ view: view.id, objectType: 'part', objectId: p.id, x: 0, y: 0 }); };
      const posOf = (view, label) => {
        const vm = store.viewMembersForView(view.id).find(v => v.objectType === 'part' && store.findPart(v.objectId)?.label === label);
        return vm ? { x: vm.x, y: vm.y } : null;
      };
      const out = {};

      // 1) left1 vs left2 -> two separate columns.
      const la = mk('BusinessActor', 'NumLA'), lb = mk('ApplicationCapability', 'NumLB'), mid = mk('BusinessProcess', 'NumMid');
      const v1 = freshView('RegrEdgeNumbered');
      place(v1, [la, lb, mid]);
      commands.applyRemapLayout(app, v1.id, { pattern: 'default', sortKeys: ['nodeLabel'], edgeAssignment: { BusinessActor: 'left1', ApplicationCapability: 'left2' } });
      const pLa = posOf(v1, 'NumLA'), pLb = posOf(v1, 'NumLB'), pMid = posOf(v1, 'NumMid');
      out.stepX = pLb.x - pLa.x;
      out.left1AtTrueEdge = pLa.x === 60;
      out.left2OneStepIn = pLb.x === pLa.x + out.stepX;
      out.midAfterLeft2 = pMid.x === pLb.x + out.stepX;

      // 2) auto-compaction: left1 + left3, left2 untouched -> no gap. (3, same labels
      // as scenario 2 so redrawNodeSizes -- called at the top of applyRemapLayout,
      // auto-fitting nodeWidth/stepX to each view's OWN longest label text -- computes
      // an identical stepX for both views, making their deltas directly comparable.)
      const ca = mk('BusinessActor', 'EdgeCompA'), cb = mk('GeneralActor', 'EdgeCompB');
      const v2 = freshView('RegrEdgeCompact');
      place(v2, [ca, cb]);
      commands.applyRemapLayout(app, v2.id, { pattern: 'default', sortKeys: ['nodeLabel'], edgeAssignment: { BusinessActor: 'left1', GeneralActor: 'left3' } });
      const pCa = posOf(v2, 'EdgeCompA'), pCb = posOf(v2, 'EdgeCompB');
      const compactStepX = pCb.x - pCa.x;

      const ba = mk('BusinessActor', 'EdgeCompA'), bb = mk('GeneralActor', 'EdgeCompB');
      const v3 = freshView('RegrEdgeBlank');
      place(v3, [ba, bb]);
      commands.applyRemapLayout(app, v3.id, { pattern: 'default', sortKeys: ['nodeLabel'], edgeAssignment: { BusinessActor: 'left1', GeneralActor: 'left3' }, edgeBlanks: { left: [2] } });
      const pBa = posOf(v3, 'EdgeCompA'), pBb = posOf(v3, 'EdgeCompB');
      const blankStepX = pBb.x - pBa.x;
      out.compactStepX = compactStepX;
      out.compactedOneStepApart = compactStepX > 100;
      out.blankedTwoStepsApart = blankStepX === compactStepX * 2;

      // 4) top1 (true top, smaller y) / top2 (further in, larger y); bottom1 (farthest
      // from grid, larger y) / bottom2 (closer to grid, smaller y).
      const ta = mk('BusinessActor', 'TopA'), tb = mk('GeneralActor', 'TopB');
      const v4 = freshView('RegrEdgeTopNumbered');
      place(v4, [ta, tb]);
      commands.applyRemapLayout(app, v4.id, { pattern: 'default', sortKeys: ['nodeLabel'], edgeAssignment: { BusinessActor: 'top1', GeneralActor: 'top2' } });
      const pTa = posOf(v4, 'TopA'), pTb = posOf(v4, 'TopB');
      out.top1AtTrueEdge = pTa.y === 40;
      out.top2FurtherIn = pTb.y > pTa.y;

      const boa = mk('BusinessActor', 'BotA'), bob = mk('GeneralActor', 'BotB');
      const v5 = freshView('RegrEdgeBottomNumbered');
      place(v5, [boa, bob]);
      commands.applyRemapLayout(app, v5.id, { pattern: 'default', sortKeys: ['nodeLabel'], edgeAssignment: { BusinessActor: 'bottom1', GeneralActor: 'bottom2' } });
      const pBoa = posOf(v5, 'BotA'), pBob = posOf(v5, 'BotB');
      out.bottom1FarthestFromGrid = pBoa.y > pBob.y;

      return out;
    }
    """)
    problems = []
    if not result["left1AtTrueEdge"]:
        problems.append(f"expected 'left1' to sit exactly at the true left edge (x=60), got {result}")
    if not result["left2OneStepIn"]:
        problems.append("expected 'left2' to sit exactly one column-step further in from 'left1', as its own separate column")
    if not result["midAfterLeft2"]:
        problems.append("expected the unassigned middle-grid part to start immediately after the 'left2' column")
    if not result["compactedOneStepApart"]:
        problems.append("expected 'left1'+'left3' with 'left2' untouched (not forced blank) to auto-compact into two adjacent columns, one step apart -- no gap")
    if not result["blankedTwoStepsApart"]:
        problems.append("expected 'left1'+'left3' with edgeBlanks:{left:[2]} to reserve a real gap column at 'left2', putting 'left3' TWO steps from 'left1' instead of one")
    if not result["top1AtTrueEdge"]:
        problems.append("expected 'top1' to sit exactly at the true top edge (y=40)")
    if not result["top2FurtherIn"]:
        problems.append("expected 'top2' to sit further down (larger y) than 'top1' -- stepping inward toward the middle grid")
    if not result["bottom1FarthestFromGrid"]:
        problems.append("expected 'bottom1' to sit farther from the middle grid (larger y) than 'bottom2' -- index 1 is always closest to the true physical edge, not the grid")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Edge Assignment's numbered slots (1-5 per edge) place different element types into separate, correctly-ordered columns/rows, auto-compact around an untouched gap, and correctly reserve a real empty gap when edgeBlanks explicitly forces one -- consistently for all four edges"


def check_remap_preset_dialog_and_local_persistence(page):
    """Regression guard for Remap's named presets (store.remapPresets, main.js's
    promptRemap Preset row) — reported directly: "let's add similar load/save settings
    for remap" (mirroring Insert Smart Stream's own smartStreamPreset system). Covers:
    the dialog renders as the wider modal-box-wide variant with an Edge Assignment
    section listing exactly the element types actually placed on the current view; Save
    As captures every current field (including edge assignment selects and the Minimize
    Crossings/Minimize Connector Length checkboxes) into a named preset, offered
    immediately in the dropdown; Load repopulates every field from a chosen preset; the
    Edge Assignment/Minimize Crossings/Minimize Connector Length controls all hide when
    Pattern is switched to 'force' (none apply there), while switching to 'layered'
    hides only "Limit columns to view" (meaningless there) and leaves Edge
    Assignment/Minimize Crossings/Minimize Connector Length visible (they still apply);
    remapPresets is excluded from
    store.toJSON() (the Save JSON document,
    since these are Local Settings, not model data); and it loads from a Local Settings
    file, caches to localStorage, and survives a page reload with no file
    re-selection."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const actor = store.createPart({ type: 'BusinessActor', label: 'RegrRPActor', model, streams: [] });
      const fn = store.createPart({ type: 'BusinessFunction', label: 'RegrRPFn', model, streams: [] });
      store.createConnector({ from: actor.id, to: fn.id, connectorType: 'c', model, relationship: 'Association' });

      const view = store.addView('RegrRemapPresetDialog_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: actor.id, x: 0, y: 0 });
      const vmF = store.createViewMember({ view: view.id, objectType: 'part', objectId: fn.id, x: 0, y: 0 });

      const out = {};
      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      let box = document.querySelector('.modal-box.modal-box-wide');
      out.isWide = !!box;
      out.edgeTypes = [...document.querySelectorAll('.rm-edge-select')].map(s => s.dataset.type).sort();

      document.querySelector('.rm-edge-select[data-type=\"BusinessActor\"]').value = 'left2';
      document.querySelector('.rm-edge-select[data-type=\"BusinessFunction\"]').value = 'top3';
      document.getElementById('rm-minimize-crossings').checked = true;
      document.getElementById('rm-minimize-length').checked = true;
      document.getElementById('rm-pattern').value = 'none';

      document.getElementById('rm-preset-save').click();
      await new Promise(r => setTimeout(r, 30));
      const nameInput = [...document.querySelectorAll('.modal-box')].find(b => b.querySelector('h3')?.textContent === 'Save Remap Preset').querySelector('input[data-key=\"name\"]');
      nameInput.value = 'RegrDialogRemapPreset';
      [...document.querySelectorAll('.modal-box')].find(b => b.querySelector('h3')?.textContent === 'Save Remap Preset').querySelector('.submit').click();
      await new Promise(r => setTimeout(r, 30));

      out.savedPreset = (store.remapPresets || []).find(p => p.name === 'RegrDialogRemapPreset');
      out.dropdownOffersNew = [...box.querySelectorAll('#rm-preset-select option')].some(o => o.value === 'RegrDialogRemapPreset');

      // force pattern hides Edge Assignment/Minimize Crossings/Minimize Connector Length
      document.getElementById('rm-pattern').value = 'force';
      document.getElementById('rm-pattern').dispatchEvent(new Event('change'));
      out.edgeHiddenOnForce = document.getElementById('rm-edge-section').classList.contains('hidden');
      out.minCrossHiddenOnForce = document.getElementById('rm-minimize-crossings-row').classList.contains('hidden');
      out.minLengthHiddenOnForce = document.getElementById('rm-minimize-length-row').classList.contains('hidden');

      // 'layered' pattern: "Limit columns to view" has no meaning (every row is
      // exactly one graph layer, however wide) so it hides same as 'force', but Edge
      // Assignment/Minimize Crossings/Minimize Connector Length all still apply --
      // unlike 'force', which hides all of them.
      document.getElementById('rm-pattern').value = 'layered';
      document.getElementById('rm-pattern').dispatchEvent(new Event('change'));
      out.limitColumnsHiddenOnLayered = document.getElementById('rm-limit-row').classList.contains('hidden');
      out.edgeHiddenOnLayered = document.getElementById('rm-edge-section').classList.contains('hidden');
      out.minCrossHiddenOnLayered = document.getElementById('rm-minimize-crossings-row').classList.contains('hidden');
      out.minLengthHiddenOnLayered = document.getElementById('rm-minimize-length-row').classList.contains('hidden');

      box.querySelector('.cancel').click();
      await new Promise(r => setTimeout(r, 30));

      // Load into a fresh dialog instance.
      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      box = document.querySelector('.modal-box.modal-box-wide');
      document.getElementById('rm-preset-select').value = 'RegrDialogRemapPreset';
      document.getElementById('rm-preset-load').click();
      await new Promise(r => setTimeout(r, 30));
      out.loadedPattern = document.getElementById('rm-pattern').value;
      out.loadedMinCross = document.getElementById('rm-minimize-crossings').checked;
      out.loadedMinLength = document.getElementById('rm-minimize-length').checked;
      out.loadedActorEdge = document.querySelector('.rm-edge-select[data-type=\"BusinessActor\"]').value;
      out.loadedFnEdge = document.querySelector('.rm-edge-select[data-type=\"BusinessFunction\"]').value;
      box.querySelector('.cancel').click();

      out.docJsonExcludes = !JSON.stringify(store.toJSON()).includes('RegrDialogRemapPreset');
      return out;
    }
    """)
    problems = []
    if not result["isWide"]:
        problems.append("Remap dialog should render with the wider modal-box-wide variant")
    if "BusinessActor" not in result["edgeTypes"] or "BusinessFunction" not in result["edgeTypes"]:
        problems.append(f"Edge Assignment should list the element types actually placed on this view, got {result['edgeTypes']}")
    saved = result["savedPreset"] or {}
    if saved.get("pattern") != "none" or saved.get("edgeAssignment") != {"BusinessActor": "left2", "BusinessFunction": "top3"} or saved.get("minimizeCrossings") is not True or saved.get("minimizeConnectorLength") is not True:
        problems.append(f"Save As should capture the current pattern/edgeAssignment/minimizeCrossings/minimizeConnectorLength, expected pattern='none' edgeAssignment={{BusinessActor:left2,BusinessFunction:top3}} minimizeCrossings=True minimizeConnectorLength=True, got {saved}")
    if not result["dropdownOffersNew"]:
        problems.append("the Preset dropdown should immediately offer the newly saved preset's name")
    if not result["edgeHiddenOnForce"] or not result["minCrossHiddenOnForce"] or not result["minLengthHiddenOnForce"]:
        problems.append("Edge Assignment, Minimize Crossings, and Minimize Connector Length should all hide when Pattern is switched to 'force'")
    if not result["limitColumnsHiddenOnLayered"]:
        problems.append("'Limit columns to view' should hide when Pattern is switched to 'layered' (no meaning there -- every row is exactly one graph layer)")
    if result["edgeHiddenOnLayered"] or result["minCrossHiddenOnLayered"] or result["minLengthHiddenOnLayered"]:
        problems.append("Edge Assignment, Minimize Crossings, and Minimize Connector Length should all stay VISIBLE for pattern:'layered' (unlike 'force')")
    if result["loadedPattern"] != "none" or not result["loadedMinCross"] or not result["loadedMinLength"] or result["loadedActorEdge"] != "left2" or result["loadedFnEdge"] != "top3":
        problems.append(f"Load should repopulate pattern/minimizeCrossings/minimizeConnectorLength/edge assignment selects from the preset, got pattern={result['loadedPattern']} minCross={result['loadedMinCross']} minLength={result['loadedMinLength']} actorEdge={result['loadedActorEdge']} fnEdge={result['loadedFnEdge']}")
    if not result["docJsonExcludes"]:
        problems.append("remapPresets must never appear in store.toJSON() (the actual Save JSON document) -- these are Local Settings, not document data")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"

    # Local Settings file round-trip + localStorage cache + reload survives.
    custom_presets = [{"name": "RegrRemapFilePreset", "templateName": "Enterprise", "pattern": "default", "sortKeys": ["nodeLabel"], "limitColumnsToView": False, "filteredOnly": False, "forcePreferRight": False, "forceGroupRows": False, "edgeAssignment": {"BusinessActor": "right"}, "minimizeCrossings": False, "minimizeConnectorLength": True}]
    js(page, f"""
    async () => {{
      const text = {json.dumps(json.dumps({"remapPresets": custom_presets}))};
      const blob = new Blob([text], {{ type: 'application/json' }});
      const file = new File([blob], 'test.json', {{ type: 'application/json' }});
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('load-local-settings-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {{ bubbles: true }}));
      await new Promise(r => setTimeout(r, 150));
    }}
    """)
    before = js(page, """
    async () => ({
      presets: window.dycadApp.store.remapPresets,
      cached: localStorage.getItem('dycad-local-settings-cache'),
    })
    """)
    if before["presets"] != custom_presets:
        return False, f"remapPresets didn't load correctly from the Local Settings file: {before}"
    if not before["cached"] or json.loads(before["cached"]).get("remapPresets") != custom_presets:
        return False, f"remapPresets wasn't cached to localStorage on load: {before}"

    page.reload()
    page.wait_for_timeout(1200)
    after = js(page, "async () => ({ presets: window.dycadApp.store.remapPresets })")
    if after["presets"] != custom_presets:
        return False, f"remapPresets did not auto-apply from its localStorage cache after reload: {after}"

    return True, "Remap's Preset row saves the current dialog state (including Edge Assignment, Minimize Crossings, and Minimize Connector Length) as a named, persisted preset and loads it back field-for-field, hides all three new controls under the force pattern, keeps remapPresets out of the Save JSON document, and loads/caches/survives a reload via Local Settings same as smartStreamPresets"


def check_remap_view_remembers_own_settings(page):
    """Regression guard for view.remapLastOptions (commands.js's remap, main.js's
    promptRemap) — reported directly: "Is it possible to retain the prior Remap
    settings on the same view if the user reopens it to adjust?" Every dialog field
    (pattern, both minimize checkboxes, edge assignment, template) should default from
    THIS SPECIFIC view's own last successful Remap run, ahead of the cross-view
    getCachedRemapOptions default — same "this view's own history wins" precedent
    view.remapSortKeys already established for sort order alone. Covers: (1) after
    running Remap once with a distinctive set of options, reopening the dialog on the
    SAME view pre-fills every one of those fields, not just sort order; (2) a
    brand-new, never-remapped view still falls back to the cross-view cache (proving
    view-level memory doesn't leak across views); (3) view.remapLastOptions is
    recorded on this.doc's view object, so it DOES round-trip through store.toJSON()
    (the Save JSON document) — deliberately the opposite of smartStreamPresets/
    remapPresets, since this is genuinely per-view document state, not a personal
    Local Settings preference."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const fn = store.createPart({ type: 'BusinessFunction', label: 'RegrRLOFn', model, streams: [] });
      const proc = store.createPart({ type: 'BusinessProcess', label: 'RegrRLOProc', model, streams: [] });
      store.createConnector({ from: fn.id, to: proc.id, connectorType: 'c', model, relationship: 'Association' });

      const view = store.addView('RegrRememberLastOptions_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const vmFn = store.createViewMember({ view: view.id, objectType: 'part', objectId: fn.id, x: 0, y: 0 });
      const vmProc = store.createViewMember({ view: view.id, objectType: 'part', objectId: proc.id, x: 0, y: 0 });

      const out = {};
      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      let box = document.querySelector('.modal-box.modal-box-wide');
      document.getElementById('rm-pattern').value = 'none';
      document.getElementById('rm-minimize-crossings').checked = true;
      document.getElementById('rm-minimize-length').checked = true;
      document.querySelector('.rm-edge-select[data-type=\"BusinessFunction\"]').value = 'top1';
      box.querySelector('.submit').click();
      await new Promise(r => setTimeout(r, 60));

      out.recordedInDoc = !!view.remapLastOptions;
      out.docJsonIncludesIt = JSON.stringify(store.toJSON()).includes('RegrRLOFn') && JSON.stringify(store.toJSON().views.find(v => v.id === view.id)).includes('minimizeConnectorLength');

      // Reopen on the SAME view -- every field should come back pre-filled.
      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      box = document.querySelector('.modal-box.modal-box-wide');
      out.reopenedPattern = document.getElementById('rm-pattern').value;
      out.reopenedMinCross = document.getElementById('rm-minimize-crossings').checked;
      out.reopenedMinLength = document.getElementById('rm-minimize-length').checked;
      out.reopenedFnEdge = document.querySelector('.rm-edge-select[data-type=\"BusinessFunction\"]').value;
      box.querySelector('.cancel').click();
      await new Promise(r => setTimeout(r, 30));

      // A brand-new, never-remapped view should NOT inherit this view's own settings
      // -- it falls back to the cross-view cache (which is now 'none'/checked/checked
      // from the run above, proving the CACHE still works, just that the fresh view's
      // own remapLastOptions is genuinely empty, not leaking from view A).
      const view2 = store.addView('RegrRememberLastOptionsFresh_' + Date.now(), 'ff');
      const tab2 = app.createCanvasTab(view2);
      app.switchToTab(tab2.id);
      out.freshViewHasNoOwnOptions = !view2.remapLastOptions;
      app.promptRemap(tab2);
      await new Promise(r => setTimeout(r, 30));
      box = document.querySelector('.modal-box.modal-box-wide');
      out.freshViewPatternFromCache = document.getElementById('rm-pattern').value;
      box.querySelector('.cancel').click();

      return out;
    }
    """)
    problems = []
    if not result["recordedInDoc"]:
        problems.append("running Remap should record view.remapLastOptions on the view itself")
    if not result["docJsonIncludesIt"]:
        problems.append("view.remapLastOptions should round-trip through store.toJSON() (the Save JSON document) -- it's per-view document state, not a Local Settings preference")
    if result["reopenedPattern"] != "none" or not result["reopenedMinCross"] or not result["reopenedMinLength"] or result["reopenedFnEdge"] != "top1":
        problems.append(f"reopening Remap on the SAME view should pre-fill every field from its own last run, got pattern={result['reopenedPattern']} minCross={result['reopenedMinCross']} minLength={result['reopenedMinLength']} fnEdge={result['reopenedFnEdge']}")
    if not result["freshViewHasNoOwnOptions"]:
        problems.append("a brand-new view should have no remapLastOptions of its own")
    if result["freshViewPatternFromCache"] != "none":
        problems.append(f"a brand-new view's dialog should still fall back to the cross-view cache (expected 'none' from the run above), got {result['freshViewPatternFromCache']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Remap remembers every dialog field (not just sort order) per-view via view.remapLastOptions, pre-filling them on reopen while a fresh view still falls back to the cross-view cache, and this state correctly round-trips through the Save JSON document as genuine per-view data"


def check_remap_edge_assignment_dialog_numbered_ui(page):
    """Regression guard/new-feature check for the Remap dialog's numbered Edge
    Assignment UI. Reported directly (same request as
    check_remap_edge_assignment_numbered_slots_and_blanks): "change left to be left 1,
    and add left 2, left 3 etc to 5 ... Add ability to specify 'blank'." Covers: (1)
    each element type's edge <select> now offers 21 options (the default "normal grid"
    plus 5 numbered slots x 4 edges, grouped into 4 <optgroup>s); (2) a view whose
    remapLastOptions has the OLD bare 'left' (no digit) value pre-fills the dialog's
    <select> as 'left1', not blank/unselected -- backward compatibility for every
    already-saved document; (3) a new Blank Slots checkbox grid (.rm-edge-blank, one
    per edge x index) exists and round-trips through Reset (unchecked), Save As/Load
    (a preset's edgeBlanks), and reopening the same view (view.remapLastOptions.
    edgeBlanks) exactly like every other field already does."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const actor = store.createPart({ type: 'BusinessActor', label: 'EdgeUiActor', model, streams: [] });
      const view = store.addView('RegrEdgeUi_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      store.createViewMember({ view: view.id, objectType: 'part', objectId: actor.id, x: 0, y: 0 });

      // Legacy pre-fill: a document saved before numbered slots existed.
      view.remapLastOptions = { edgeAssignment: { BusinessActor: 'left' } };

      const out = {};
      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      let box = document.querySelector('.modal-box.modal-box-wide');
      const sel = box.querySelector('.rm-edge-select[data-type=\"BusinessActor\"]');
      out.optionCount = sel.querySelectorAll('option').length;
      out.optgroupCount = sel.querySelectorAll('optgroup').length;
      out.hasLeft5 = [...sel.options].some(o => o.value === 'left5');
      out.legacyPrefillNormalized = sel.value;

      out.blankGridExists = box.querySelectorAll('.rm-edge-blank').length === 20;

      // Set a slot + a blank, then Reset should clear both.
      sel.value = 'left3';
      box.querySelector('.rm-edge-blank[data-edge=\"left\"][data-index=\"2\"]').checked = true;
      box.querySelector('.reset').click();
      out.resetClearsSelect = sel.value;
      out.resetClearsBlank = box.querySelector('.rm-edge-blank[data-edge=\"left\"][data-index=\"2\"]').checked;

      // Save As with a slot + a blank set, then reload the dialog fresh and Load it back.
      sel.value = 'left3';
      box.querySelector('.rm-edge-blank[data-edge=\"left\"][data-index=\"2\"]').checked = true;
      box.querySelector('#rm-preset-save').click();
      await new Promise(r => setTimeout(r, 30));
      const nameInput = [...document.querySelectorAll('.modal-box')].find(b => b.querySelector('h3')?.textContent === 'Save Remap Preset').querySelector('input[data-key=\"name\"]');
      nameInput.value = 'RegrEdgeUiPreset';
      [...document.querySelectorAll('.modal-box')].find(b => b.querySelector('h3')?.textContent === 'Save Remap Preset').querySelector('.submit').click();
      await new Promise(r => setTimeout(r, 30));
      out.savedPresetBlanks = (store.remapPresets || []).find(p => p.name === 'RegrEdgeUiPreset')?.edgeBlanks;
      box.querySelector('.cancel').click();
      await new Promise(r => setTimeout(r, 30));

      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      box = document.querySelector('.modal-box.modal-box-wide');
      box.querySelector('#rm-preset-select').value = 'RegrEdgeUiPreset';
      box.querySelector('#rm-preset-load').click();
      await new Promise(r => setTimeout(r, 30));
      out.loadedSelect = box.querySelector('.rm-edge-select[data-type=\"BusinessActor\"]').value;
      out.loadedBlank = box.querySelector('.rm-edge-blank[data-edge=\"left\"][data-index=\"2\"]').checked;
      box.querySelector('.submit').click();
      await new Promise(r => setTimeout(r, 60));

      // Reopen on the same view -- edgeBlanks should now come back from
      // view.remapLastOptions too, same as edgeAssignment already does.
      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      box = document.querySelector('.modal-box.modal-box-wide');
      out.reopenedBlank = box.querySelector('.rm-edge-blank[data-edge=\"left\"][data-index=\"2\"]').checked;
      box.querySelector('.cancel').click();

      return out;
    }
    """)
    problems = []
    if result["optionCount"] != 21:
        problems.append(f"expected 21 options (1 default + 5 numbered slots x 4 edges) in the edge-assignment select, got {result['optionCount']}")
    if result["optgroupCount"] != 4:
        problems.append(f"expected 4 optgroups (Top/Bottom/Left/Right), got {result['optgroupCount']}")
    if not result["hasLeft5"]:
        problems.append("expected a 'left5' option to exist")
    if result["legacyPrefillNormalized"] != "left1":
        problems.append(f"expected a legacy bare 'left' value (no digit) to pre-fill the select as 'left1', got {result['legacyPrefillNormalized']!r}")
    if not result["blankGridExists"]:
        problems.append("expected exactly 20 .rm-edge-blank checkboxes (5 indices x 4 edges)")
    if result["resetClearsSelect"] or result["resetClearsBlank"]:
        problems.append(f"expected Reset to clear both the edge-assignment select and the blank checkbox, got select={result['resetClearsSelect']!r} blank={result['resetClearsBlank']}")
    if result["savedPresetBlanks"] != {"left": [2]}:
        problems.append(f"expected Save As to capture edgeBlanks:{{left:[2]}} into the preset, got {result['savedPresetBlanks']}")
    if result["loadedSelect"] != "left3" or not result["loadedBlank"]:
        problems.append(f"expected Load to repopulate both the edge-assignment select and the blank checkbox from the preset, got select={result['loadedSelect']!r} blank={result['loadedBlank']}")
    if not result["reopenedBlank"]:
        problems.append("expected reopening Remap on the same view to pre-fill the blank checkbox from view.remapLastOptions.edgeBlanks, same as edgeAssignment already does")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "The Remap dialog's Edge Assignment select now offers 5 numbered slots per edge (grouped, 21 options total), correctly normalizes a legacy bare-edge-name value to slot 1 on pre-fill, and its new Blank Slots checkbox grid round-trips through Reset, Save As/Load, and per-view remembered settings exactly like every other field"


def check_remap_selected_only(page):
    """Regression guard/new-feature check for the Remap dialog's new "Only remap
    selected nodes and their connectors" checkbox, reported directly: "Update remap
    (any view) with a new checkbox 'selected' to apply remaping only to selected items
    and related connectors; valid for any pattern selected." Drives the REAL dialog UI
    (not a direct applyRemapLayout call), deliberately using the 'clusters' pattern
    (the newest/least-battle-tested one) to prove the checkbox genuinely plugs into
    the SAME visiblePartVmIds parameter every pattern already respects uniformly
    (proven earlier for 'force'/'clusters'/'default' via the filteredOnly checkbox),
    rather than needing pattern-specific wiring. Fixture: two connected "selected"
    parts placed far from where 'clusters' would ever naturally put them (so any real
    repositioning is unambiguous, not a coincidence) and two connected "unselected"
    parts. Covers: with only the two selected parts in tab.selection and the checkbox
    checked, submitting Remap moves at least one of the selected parts (proving the
    pattern actually ran against them) while leaving BOTH unselected parts at their
    exact original x/y (proving they were excluded from the layout algorithm
    entirely, not just left alone by coincidence)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.addView('RegrSelOnly_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const mk = (label) => store.createPart({ type: 'Unknown', label, model, streams: [] });
      const p1 = mk('Sel1'), p2 = mk('Sel2'), p3 = mk('Unsel3'), p4 = mk('Unsel4');
      const vm1 = store.createViewMember({ view: view.id, objectType: 'part', objectId: p1.id, x: 9000, y: 9000 });
      const vm2 = store.createViewMember({ view: view.id, objectType: 'part', objectId: p2.id, x: 9100, y: 9000 });
      const vm3 = store.createViewMember({ view: view.id, objectType: 'part', objectId: p3.id, x: 500, y: 500 });
      const vm4 = store.createViewMember({ view: view.id, objectType: 'part', objectId: p4.id, x: 600, y: 500 });
      const wire = (a, b, fromVm, toVm) => {
        const c = store.createConnector({ from: a.id, to: b.id, model, connectorType: 'c', relationship: 'Association', streams: [] });
        store.createViewMember({ view: view.id, objectType: 'connector', objectId: c.id, fromVmId: fromVm.id, toVmId: toVm.id });
      };
      wire(p1, p2, vm1, vm2);
      wire(p3, p4, vm3, vm4);

      const p1Before = { x: vm1.x, y: vm1.y };
      const p3Before = { x: vm3.x, y: vm3.y };
      const p4Before = { x: vm4.x, y: vm4.y };

      tab.selection = new Set([vm1.id, vm2.id]);
      app.render();

      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      document.getElementById('rm-pattern').value = 'clusters';
      document.getElementById('rm-pattern').dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('rm-selected-only').checked = true;
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 80));

      return {
        p1Moved: vm1.x !== p1Before.x || vm1.y !== p1Before.y,
        p3Unchanged: vm3.x === p3Before.x && vm3.y === p3Before.y,
        p4Unchanged: vm4.x === p4Before.x && vm4.y === p4Before.y,
      };
    }
    """)
    problems = []
    if not result["p1Moved"]:
        problems.append("expected at least one of the SELECTED parts to actually move (proving 'clusters' ran against the selected subset)")
    if not result["p3Unchanged"] or not result["p4Unchanged"]:
        problems.append(f"expected both UNSELECTED parts to stay at their exact original x/y, got p3Unchanged={result['p3Unchanged']} p4Unchanged={result['p4Unchanged']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Remap's 'Only remap selected nodes and their connectors' checkbox restricts even a non-default pattern ('clusters') to the current selection, leaving every unselected node's position completely untouched"


def check_spacing_command_selected_nodes_only(page):
    """Regression guard/new-feature check for the Spacing +/- toolbar command, reported
    directly: "If multiple nodes selected, apply 'Spacing' command increase or
    decrease only to selected nodes and update their x,y without changing view
    spacing value." Drives the REAL .spacing-in button (js/canvas.js's
    buildZoomControls), not a direct store call. Covers: with 2+ nodes selected on a
    freeform view, clicking Spacing + moves the selected nodes' x/y (scaled apart
    around their OWN centroid, via state.js's new applySpacingRatioToVms) while
    leaving an UNSELECTED third node's x/y completely untouched AND leaving
    view.spacingScale completely unchanged (the explicit "without changing view
    spacing value" requirement); and the pre-existing fallback still works correctly
    with fewer than 2 nodes selected (clearing the selection and clicking again DOES
    change view.spacingScale, exactly like before this feature existed)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.addView('RegrSpacingSel_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const mk = (label) => store.createPart({ type: 'Unknown', label, model, streams: [] });
      const p1 = mk('S1'), p2 = mk('S2'), p3 = mk('S3');
      const vm1 = store.createViewMember({ view: view.id, objectType: 'part', objectId: p1.id, x: 100, y: 100 });
      const vm2 = store.createViewMember({ view: view.id, objectType: 'part', objectId: p2.id, x: 300, y: 100 });
      const vm3 = store.createViewMember({ view: view.id, objectType: 'part', objectId: p3.id, x: 700, y: 700 });
      app.recordAndRender();

      const scaleBefore = view.spacingScale || 1;
      const p1Before = { x: vm1.x, y: vm1.y };
      const p3Before = { x: vm3.x, y: vm3.y };

      tab.selection = new Set([vm1.id, vm2.id]);
      app.render();
      document.querySelector('.spacing-in').click();
      await new Promise(r => setTimeout(r, 30));

      const scaleAfterSelected = view.spacingScale || 1;
      const p1MovedSelected = vm1.x !== p1Before.x || vm1.y !== p1Before.y;
      const p3UnchangedAfterSelected = vm3.x === p3Before.x && vm3.y === p3Before.y;

      // fallback: fewer than 2 selected -> the pre-existing whole-view behavior,
      // which DOES change view.spacingScale (proving the fallback path wasn't broken)
      tab.selection = new Set();
      app.render();
      document.querySelector('.spacing-in').click();
      await new Promise(r => setTimeout(r, 30));
      const scaleAfterGlobal = view.spacingScale || 1;

      return { scaleBefore, scaleAfterSelected, p1MovedSelected, p3UnchangedAfterSelected, scaleAfterGlobal };
    }
    """)
    problems = []
    if result["scaleAfterSelected"] != result["scaleBefore"]:
        problems.append(f"expected view.spacingScale to stay EXACTLY unchanged while 2+ nodes are selected, got {result['scaleBefore']} -> {result['scaleAfterSelected']}")
    if not result["p1MovedSelected"]:
        problems.append("expected the selected nodes' x/y to actually change when Spacing + is clicked with 2+ selected")
    if not result["p3UnchangedAfterSelected"]:
        problems.append("expected the UNSELECTED node's x/y to stay completely untouched")
    if result["scaleAfterGlobal"] <= result["scaleBefore"]:
        problems.append(f"expected the pre-existing fallback (fewer than 2 selected) to still increase view.spacingScale, got {result['scaleBefore']} -> {result['scaleAfterGlobal']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Spacing +/- applies only to selected nodes' own x/y (scaled around their own centroid) without touching view.spacingScale when 2+ nodes are selected, and falls back to the original whole-view behavior otherwise"


def check_remap_selected_only_anchors_at_original_position(page):
    """Regression guard for a direct follow-up report: "remap selected places nodes
    over top existing. Can the results be placed starting in selected x,y?" A restricted
    remap (visiblePartVmIds set, via either "Only remap filtered nodes" or "Only remap
    selected nodes and their connectors") used to compute fresh positions from the
    view's own fixed origin (baseX=60/rowBaseY=40 for default/none/layered) regardless
    of where the restricted subset actually started — landing the result directly on
    top of whatever OTHER, un-remapped content already sits near that origin. Fixed by
    commands.js's new shiftToOriginalPosition: after a restricted remap computes its
    (origin-relative) positions, the whole result is translated by ONE uniform offset
    so its own new top-left lands exactly where the restricted group's OWN top-left
    was before this remap ran.

    Exercises applyRemapLayout directly (pure logic, not the dialog). Covers: two
    parts placed far from the view's origin (2000,2000) with visiblePartVmIds
    restricting the remap to just them — after a 'default' pattern remap, their new
    bounding box's minimum x/y is EXACTLY 2000/2000 (their original position), not
    60/40 (the view's fixed origin, where two other UNSELECTED parts already sit,
    confirmed untouched); and, as a negative control, an UNRESTRICTED remap
    (visiblePartVmIds: null) on a separate far-placed pair still lands at the
    original 60/40 origin, completely unaffected by this fix — proving the shift only
    ever engages for a genuinely restricted remap."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;

      // restricted case: two far-placed "selected" parts, plus two UNSELECTED parts
      // already sitting right where the view's fixed origin would otherwise land the result
      const viewA = store.addView('RegrShiftOriginA_' + Date.now(), 'ff');
      const p1 = store.createPart({ type: 'Unknown', label: 'Far1', model, streams: [] });
      const p2 = store.createPart({ type: 'Unknown', label: 'Far2', model, streams: [] });
      const p3 = store.createPart({ type: 'Unknown', label: 'Near1', model, streams: [] });
      const p4 = store.createPart({ type: 'Unknown', label: 'Near2', model, streams: [] });
      const vm1 = store.createViewMember({ view: viewA.id, objectType: 'part', objectId: p1.id, x: 2000, y: 2000 });
      const vm2 = store.createViewMember({ view: viewA.id, objectType: 'part', objectId: p2.id, x: 2200, y: 2000 });
      const vm3 = store.createViewMember({ view: viewA.id, objectType: 'part', objectId: p3.id, x: 60, y: 40 });
      const vm4 = store.createViewMember({ view: viewA.id, objectType: 'part', objectId: p4.id, x: 230, y: 40 });

      commands.applyRemapLayout(app, viewA.id, { pattern: 'default', visiblePartVmIds: new Set([vm1.id, vm2.id]) });

      const restrictedMinX = Math.min(vm1.x, vm2.x);
      const restrictedMinY = Math.min(vm1.y, vm2.y);

      // negative control: an UNRESTRICTED remap on a separate far-placed pair should
      // still behave exactly as before -- lands at the view's own fixed origin.
      const viewB = store.addView('RegrShiftOriginB_' + Date.now(), 'ff');
      const p5 = store.createPart({ type: 'Unknown', label: 'Far5', model, streams: [] });
      const p6 = store.createPart({ type: 'Unknown', label: 'Far6', model, streams: [] });
      const vm5 = store.createViewMember({ view: viewB.id, objectType: 'part', objectId: p5.id, x: 5000, y: 5000 });
      const vm6 = store.createViewMember({ view: viewB.id, objectType: 'part', objectId: p6.id, x: 5200, y: 5000 });
      commands.applyRemapLayout(app, viewB.id, { pattern: 'none', visiblePartVmIds: null });
      const unrestrictedMinX = Math.min(vm5.x, vm6.x);
      const unrestrictedMinY = Math.min(vm5.y, vm6.y);

      return {
        restrictedMinX, restrictedMinY,
        p3Unchanged: vm3.x === 60 && vm3.y === 40, p4Unchanged: vm4.x === 230 && vm4.y === 40,
        unrestrictedMinX, unrestrictedMinY,
      };
    }
    """)
    problems = []
    if result["restrictedMinX"] != 2000 or result["restrictedMinY"] != 2000:
        problems.append(f"expected the restricted remap's result to anchor exactly at the selection's own original top-left (2000,2000), got ({result['restrictedMinX']},{result['restrictedMinY']})")
    if not result["p3Unchanged"] or not result["p4Unchanged"]:
        problems.append("expected the two UNSELECTED parts (sitting at the view's fixed origin) to stay completely untouched")
    if result["unrestrictedMinX"] != 60 or result["unrestrictedMinY"] != 40:
        problems.append(f"expected an UNRESTRICTED remap to still land at the view's own fixed origin (60,40), unaffected by this fix, got ({result['unrestrictedMinX']},{result['unrestrictedMinY']})")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "a restricted remap (selected/filtered subset) now anchors its result at the subset's own original top-left position instead of the view's fixed origin, avoiding overlap with un-remapped content there, while an unrestricted whole-view remap is completely unaffected"


def check_spacing_axis_toggle(page):
    """Regression guard/new-feature check for the Spacing direction toggle, reported
    directly as a follow-up: "Update spacing for vertical, horizontal, or both, when
    used with selected nodes; perhaps change existing <-> symbol to be toggle between
    vertical, horizonal, and both." Drives the real .spacing-axis-toggle button
    (js/canvas.js's buildZoomControls) and the real .spacing-in button together.
    Covers: clicking the toggle three times cycles view.spacingAxis through
    'both' -> 'horizontal' -> 'vertical' -> 'both' in that exact order; with 2+ nodes
    selected and the axis set to 'horizontal', Spacing + changes x but leaves y
    completely untouched; and with the axis set to 'vertical', Spacing + changes y
    but leaves x completely untouched."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.addView('RegrSpacingAxis_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const p1 = store.createPart({ type: 'Unknown', label: 'AxA', model, streams: [] });
      const p2 = store.createPart({ type: 'Unknown', label: 'AxB', model, streams: [] });
      const vm1 = store.createViewMember({ view: view.id, objectType: 'part', objectId: p1.id, x: 100, y: 100 });
      const vm2 = store.createViewMember({ view: view.id, objectType: 'part', objectId: p2.id, x: 300, y: 300 });
      tab.selection = new Set([vm1.id, vm2.id]);
      app.render();

      document.querySelector('.spacing-axis-toggle').click();
      const axisAfterFirstToggle = view.spacingAxis;
      const beforeH = { x: vm1.x, y: vm1.y };
      document.querySelector('.spacing-in').click();
      const xChangedHorizontal = vm1.x !== beforeH.x;
      const yUnchangedHorizontal = vm1.y === beforeH.y && vm2.y === 300;

      document.querySelector('.spacing-axis-toggle').click();
      const axisAfterSecondToggle = view.spacingAxis;
      const beforeV = { x: vm1.x, y: vm1.y };
      document.querySelector('.spacing-in').click();
      const yChangedVertical = vm1.y !== beforeV.y;
      const xUnchangedVertical = vm1.x === beforeV.x;

      document.querySelector('.spacing-axis-toggle').click();
      const axisAfterThirdToggle = view.spacingAxis;

      return {
        axisAfterFirstToggle, axisAfterSecondToggle, axisAfterThirdToggle,
        xChangedHorizontal, yUnchangedHorizontal, yChangedVertical, xUnchangedVertical,
      };
    }
    """)
    problems = []
    if result["axisAfterFirstToggle"] != "horizontal":
        problems.append(f"expected the first toggle click to set 'horizontal', got {result['axisAfterFirstToggle']!r}")
    if result["axisAfterSecondToggle"] != "vertical":
        problems.append(f"expected the second toggle click to set 'vertical', got {result['axisAfterSecondToggle']!r}")
    if result["axisAfterThirdToggle"] != "both":
        problems.append(f"expected the third toggle click to cycle back to 'both', got {result['axisAfterThirdToggle']!r}")
    if not result["xChangedHorizontal"] or not result["yUnchangedHorizontal"]:
        problems.append(f"expected 'horizontal' axis to change x but leave y untouched, got xChanged={result['xChangedHorizontal']} yUnchanged={result['yUnchangedHorizontal']}")
    if not result["yChangedVertical"] or not result["xUnchangedVertical"]:
        problems.append(f"expected 'vertical' axis to change y but leave x untouched, got yChanged={result['yChangedVertical']} xUnchanged={result['xUnchangedVertical']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "the Spacing direction toggle cycles view.spacingAxis through both/horizontal/vertical, and Spacing +/- on a 2+-node selection actually respects the chosen axis (leaving the other axis's coordinate untouched)"


def check_remap_copy_call_on_right_click(page):
    """Regression guard for main.js's wireCopyCallOnRightClick, wired onto the Remap
    dialog's submit button — reported directly: "Can right click be added to the remap
    submit button, to put into copy the function call and parameters that match what
    user has filled out. This would be very handy for any dialog form with multiple
    settings" (a generic helper, in case other dialogs adopt it later — today only
    Remap's submit button does). Covers: right-clicking the submit button copies a
    `remap(app, tab, {...})` snippet to the clipboard reflecting the CURRENT form
    values (not stale ones from when the dialog opened); the copied snippet is valid,
    parseable JS containing every option key; and — critically — right-clicking must
    NOT actually submit the form (the dialog stays open, nothing gets remapped),
    distinguishing it from a real click."""
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.addView('RegrCopyCall_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      app.promptRemap(tab);
      await new Promise(r => setTimeout(r, 30));
      const box = document.querySelector('.modal-box.modal-box-wide');
      document.getElementById('rm-pattern').value = 'none';
      document.getElementById('rm-minimize-length').checked = true;

      const submitBtn = box.querySelector('.submit');
      submitBtn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 60));

      const out = {};
      out.dialogStillOpen = !!document.querySelector('.modal-box.modal-box-wide');
      out.nothingRemapped = store.viewMembersForView(view.id).length === 0;
      try {
        out.clipboardText = await navigator.clipboard.readText();
      } catch (e) {
        out.clipboardReadFailed = e.message;
      }
      box.querySelector('.cancel').click();
      return out;
    }
    """)
    problems = []
    if not result.get("dialogStillOpen"):
        problems.append("right-clicking the submit button should NOT close the dialog (that's what a real left-click/submit does)")
    if not result.get("nothingRemapped"):
        problems.append("right-clicking the submit button should NOT actually run Remap")
    clip = result.get("clipboardText")
    if not clip:
        problems.append(f"right-click should copy a snippet to the clipboard, got clipboardText={clip!r} (read error: {result.get('clipboardReadFailed')})")
    else:
        if not clip.startswith("remap(app, tab,"):
            problems.append(f"copied snippet should be a remap(app, tab, {{...}}) call, got: {clip[:120]!r}")
        for key in ["pattern", "minimizeConnectorLength", "edgeAssignment", "sortKeys"]:
            if key not in clip:
                problems.append(f"copied snippet should include '{key}', got: {clip[:400]!r}")
        if '"pattern": "none"' not in clip or '"minimizeConnectorLength": true' not in clip:
            problems.append(f"copied snippet should reflect the CURRENT form values (pattern='none', minimizeConnectorLength=true), got: {clip[:400]!r}")
    if problems:
        return False, "; ".join(problems) + f" (full result: {result})"
    return True, "right-clicking Remap's submit button copies a valid remap(app, tab, {...}) call reflecting the current form to the clipboard, without actually submitting"


def check_generate_stream_prepopulates_from_existing(page):
    """Regression guard for Generate Stream's Stream Name field: it's a text input backed
    by a <datalist> of existing stream names (not a locked-down <select>), so typing a
    brand-new name still works exactly as before; but typing/picking an EXISTING stream
    name should prepopulate Function/Capability/Application Capability/Entity Name from that
    stream's own already-generated parts (commands.js's deriveStreamNames) and switch the
    template to one with an Application Capability level if the stream has one — without touching
    those fields for a stream name that doesn't match anything (typing further shouldn't
    fight the user). Also confirms regenerating the SAME stream (same names) reuses the
    existing parts instead of creating duplicates — createStream's own pre-existing
    find-or-create logic, exercised end-to-end through this dialog."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const view = store.addView('RegrGenStreamPrepop_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      commands.createStream(app, {
        templateName: 'SFCCE', streamName: 'RegrGSStream',
        functionName: 'RegrFunc', capabilityName: 'RegrCap',
        applicationCapabilityName: 'RegrAppCap', entityName: 'RegrEnt',
        modelName: store.defaultModel, viewName: view.id, silent: true,
      });
      const partCountBefore = store.doc.parts.length;

      app.promptGenerateStream(tab, null);
      await new Promise(r => setTimeout(r, 30));
      const templateBefore = document.getElementById('gs-template').value;

      document.getElementById('gs-stream').value = 'RegrGSStream';
      document.getElementById('gs-stream').dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));

      const populated = {
        template: document.getElementById('gs-template').value,
        appCapRowHidden: document.getElementById('gs-application-capability-row').classList.contains('hidden'),
        functionName: document.getElementById('gs-function').value,
        capabilityName: document.getElementById('gs-capability').value,
        applicationCapabilityName: document.getElementById('gs-application-capability').value,
        entityName: document.getElementById('gs-entity').value,
      };

      // typing a brand-new stream name shouldn't clear what was just prepopulated
      document.getElementById('gs-stream').value = 'RegrGSStream-brand-new';
      document.getElementById('gs-stream').dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      const afterNewName = { functionName: document.getElementById('gs-function').value };

      // put the stream name back and submit -- should reuse the existing parts, not duplicate them
      document.getElementById('gs-stream').value = 'RegrGSStream';
      document.getElementById('gs-stream').dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 80));

      return { templateBefore, populated, afterNewName, partCountBefore, partCountAfter: store.doc.parts.length };
    }
    """)
    if result["templateBefore"] == "SFCCE":
        return False, f"test setup itself is wrong — template shouldn't default to SFCCE before selecting the existing stream: {result}"
    p = result["populated"]
    problems = []
    if p["template"] != "SFCCE": problems.append(f"template should auto-switch to 'SFCCE' (the stream has an Application Capability), got {p['template']!r}")
    if p["appCapRowHidden"]: problems.append("Application Capability Name row should be visible once the template switched to SFCCE")
    if p["functionName"] != "RegrFunc": problems.append(f"functionName should prepopulate to 'RegrFunc', got {p['functionName']!r}")
    if p["capabilityName"] != "RegrCap": problems.append(f"capabilityName should prepopulate to 'RegrCap', got {p['capabilityName']!r}")
    if p["applicationCapabilityName"] != "RegrAppCap": problems.append(f"applicationCapabilityName should prepopulate to 'RegrAppCap', got {p['applicationCapabilityName']!r}")
    if p["entityName"] != "RegrEnt": problems.append(f"entityName should prepopulate to 'RegrEnt', got {p['entityName']!r}")
    if result["afterNewName"]["functionName"] != "RegrFunc": problems.append(f"typing a brand-new stream name shouldn't clear the already-prepopulated Function Name, got {result['afterNewName']['functionName']!r}")
    if result["partCountAfter"] != result["partCountBefore"]: problems.append(f"regenerating the same stream with the same names should reuse existing parts, not create new ones: {result['partCountBefore']} -> {result['partCountAfter']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "selecting an existing stream prepopulated Function/Capability/Application Capability/Entity Name and switched to the SFCCE template, without disturbing fields when a brand-new name is typed, and regenerating reused the existing parts"


def check_node_size_multiplier(page):
    """Regression guard: new views should default to a bigger node box (130x46 * the
    Store's nodeSizeMultiplier, default 1.2 -> 156x55) than the old flat 130x46 — nodes
    generated at the old size were cramped and often clipped their own label text. Also
    confirms nodeSizeMultiplier is a real Local Settings preference: File > Load Local
    Settings can set a custom value, it's cached to localStorage (same mechanism as
    maxScriptEntities), and a NEW view created after a reload uses the cached value —
    proving the cached multiplier reaches the Store BEFORE its initial home view is built
    (bootstrapApp must read the cache and pass it into `new Store(...)`, not apply it to
    store.nodeSizeMultiplier only after construction, or the very first view would miss
    it)."""
    default_result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const freshView = store.addView('RegrNodeSizeDefault_' + Date.now());
      return {
        multiplier: store.nodeSizeMultiplier,
        homeWidth: store.doc.views[0].nodeWidth,
        homeHeight: store.doc.views[0].nodeHeight,
        freshWidth: freshView.nodeWidth,
        freshHeight: freshView.nodeHeight,
      };
    }
    """)
    if default_result["multiplier"] != 1.2:
        return False, f"expected the default nodeSizeMultiplier to be 1.2, got {default_result['multiplier']}"
    if default_result["freshWidth"] != 156 or default_result["freshHeight"] != 55:
        return False, f"expected a fresh view to default to 156x55 (130x46 * 1.2), got {default_result['freshWidth']}x{default_result['freshHeight']}"
    if default_result["homeWidth"] != 156 or default_result["homeHeight"] != 55:
        return False, f"expected the initial home view to also default to 156x55, got {default_result['homeWidth']}x{default_result['homeHeight']}"

    load_result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const text = JSON.stringify({ nodeSizeMultiplier: 2 });
      const blob = new Blob([text], { type: 'application/json' });
      const file = new File([blob], 'settings.json', { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('load-local-settings-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      const view = store.addView('RegrNodeSizeLoaded_' + Date.now());
      return {
        multiplier: store.nodeSizeMultiplier,
        width: view.nodeWidth,
        height: view.nodeHeight,
        cached: JSON.parse(localStorage.getItem('dycad-local-settings-cache') || '{}').nodeSizeMultiplier,
      };
    }
    """)
    if load_result["multiplier"] != 2:
        return False, f"Load Local Settings should have set store.nodeSizeMultiplier to 2, got {load_result['multiplier']}"
    if load_result["width"] != 260 or load_result["height"] != 92:
        return False, f"a view created after loading multiplier=2 should be 260x92 (130x46 * 2), got {load_result['width']}x{load_result['height']}"
    if load_result["cached"] != 2:
        return False, f"nodeSizeMultiplier=2 wasn't cached to localStorage: {load_result}"

    page.reload()
    page.wait_for_timeout(1200)
    reload_result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      return {
        multiplier: store.nodeSizeMultiplier,
        homeWidth: store.doc.views[0].nodeWidth,
        homeHeight: store.doc.views[0].nodeHeight,
      };
    }
    """)
    if reload_result["multiplier"] != 2:
        return False, f"nodeSizeMultiplier didn't auto-apply from its localStorage cache after reload (expected 2): {reload_result}"
    if reload_result["homeWidth"] != 260 or reload_result["homeHeight"] != 92:
        return False, f"the very first (home) view after a reload should already reflect the cached multiplier=2 (260x92) — got {reload_result['homeWidth']}x{reload_result['homeHeight']}, meaning the cache reached the Store too late"
    return True, "new views default to 156x55 (130x46 * 1.2), and a custom nodeSizeMultiplier loaded via Local Settings is cached and reaches the Store before its very first view is built, surviving a reload"


def check_smart_check_node(page):
    """Regression guard for Advanced > Smart Check Node / right-click on a single node —
    the single-node analog of Smart Check View (commands.js's smartCheckNode). Builds a
    small realistic graph: Z -> A -> B -> C (all tagged stream S1), B -> D (stream S2,
    a different stream B ALSO happens to carry), C -> E (untagged). Only A starts on the
    view. Confirms: (1) the right-click context menu actually opens this dialog and its
    "Smart Check Node" item is enabled only for a single node selection; (2) checkbox
    defaults — By Stream checked with A's own stream(s) pre-checked, both direction
    checkboxes checked, Missing Connectors checked, Missing Connectors And Nodes
    unchecked (so the Levels row starts hidden); (3) the core "stays filtered to the
    originally selected stream" behavior — with Downstream-only + By Stream=S1, pulls in
    B and C (both reachable via S1 edges) but NOT D (a different stream, even though B
    itself carries it — the filter must stay fixed to what was picked from the ORIGINAL
    node, not widen to include a newly-discovered node's own extra streams) and NOT E
    (untagged edge) and NOT Z (wrong direction)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.addView('RegrSmartCheckNode_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const mk = (label, streams) => store.createPart({ type: 'Unknown', label, model: store.defaultModel, streams });
      const conn = (from, to, streams) => store.createConnector({ from: from.id, to: to.id, model: store.defaultModel, connectorType: 's', relationship: 'Association', streams });
      const A = mk('RegrSCN_A', ['S1']);
      const B = mk('RegrSCN_B', ['S1', 'S2']);
      const C = mk('RegrSCN_C', ['S1']);
      const D = mk('RegrSCN_D', ['S2']);
      const E = mk('RegrSCN_E', []);
      const Z = mk('RegrSCN_Z', ['S1']);
      conn(A, B, ['S1']); conn(B, C, ['S1']); conn(Z, A, ['S1']); conn(B, D, ['S2']); conn(C, E, []);

      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: A.id, x: 100, y: 100 });
      tab.selection.clear();
      app.render();

      // Advanced menu path should refuse with nothing selected.
      document.getElementById('advanced-menu-btn').click();
      await new Promise(r => setTimeout(r, 50));
      document.querySelector('#advanced-menu .dd-item[data-action=\"smartCheckNode\"]').click();
      await new Promise(r => setTimeout(r, 50));
      const noSelectionDialogOpened = !!document.querySelector('.modal-overlay h3');

      // Right-click path: select the node, then dispatch a real contextmenu event on its DOM element.
      tab.selection.add(vmA.id);
      app.render();
      await new Promise(r => setTimeout(r, 50));
      const nodeEl = document.querySelector(`[data-vm-id=\"${vmA.id}\"]`);
      const rect = nodeEl.getBoundingClientRect();
      nodeEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 10, clientY: rect.top + 10 }));
      await new Promise(r => setTimeout(r, 50));
      const menuItem = document.querySelector('.canvas-context-menu .cmd-context-item[data-key=\"smartCheckNode\"]');
      const menuItemEnabled = menuItem && !menuItem.classList.contains('disabled');
      menuItem.click();
      await new Promise(r => setTimeout(r, 50));

      const title = document.querySelector('.modal-overlay h3')?.textContent || '';
      const defaults = {
        byStreamChecked: document.getElementById('scn-by-stream').checked,
        streamCbCount: document.querySelectorAll('.scn-stream-cb').length,
        streamCbChecked: document.querySelector('.scn-stream-cb[data-stream=\"S1\"]')?.checked,
        upstreamChecked: document.getElementById('scn-upstream').checked,
        downstreamChecked: document.getElementById('scn-downstream').checked,
        missingConnectorsChecked: document.getElementById('scn-missing-connectors').checked,
        missingConnectorsAndNodesChecked: document.getElementById('scn-missing-connectors-nodes').checked,
        levelsRowHidden: document.getElementById('scn-levels-row').classList.contains('hidden'),
      };

      // Downstream-only, By Stream=S1 (leave default checked), unlimited levels.
      document.getElementById('scn-upstream').click();
      document.getElementById('scn-missing-connectors-nodes').click();
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 80));

      const onViewLabels = store.viewMembersForView(view.id).filter(vm => vm.objectType === 'part').map(vm => store.findPart(vm.objectId).label).sort();

      return { noSelectionDialogOpened, menuItemEnabled, title, defaults, onViewLabels };
    }
    """)
    if result["noSelectionDialogOpened"]:
        return False, f"Advanced > Smart Check Node should refuse (toast, no dialog) with nothing selected: {result}"
    if not result["menuItemEnabled"]:
        return False, f"right-click's 'Smart Check Node' item should be enabled for a single selected node: {result}"
    if result["title"] != "Smart Check Node":
        return False, f"right-click didn't open the Smart Check Node dialog: {result}"
    d = result["defaults"]
    problems = []
    if not d["byStreamChecked"]: problems.append("'By Stream' should default checked (the node has streams)")
    if d["streamCbCount"] != 1: problems.append(f"expected exactly 1 stream checkbox (node A only carries 'S1'), got {d['streamCbCount']}")
    if not d["streamCbChecked"]: problems.append("the 'S1' stream checkbox should default checked")
    if not d["upstreamChecked"] or not d["downstreamChecked"]: problems.append("both direction checkboxes should default checked")
    if not d["missingConnectorsChecked"]: problems.append("'Missing connectors' should default checked")
    if d["missingConnectorsAndNodesChecked"]: problems.append("'Missing connectors and nodes' should default unchecked")
    if not d["levelsRowHidden"]: problems.append("the Levels row should start hidden (Missing connectors and nodes starts unchecked)")
    expected = ["RegrSCN_A", "RegrSCN_B", "RegrSCN_C"]
    if result["onViewLabels"] != expected:
        problems.append(f"downstream-only + By Stream=S1 should pull in exactly A, B, C (not D — different stream despite B carrying it; not E — untagged edge; not Z — wrong direction), got {result['onViewLabels']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "right-click opened Smart Check Node with correct defaults, and downstream-only + fixed-to-the-original-node's-stream traversal pulled in exactly the reachable same-stream nodes"


def check_view3d_boots(page):
    """Regression guard for the 3D View tab (Stage 0 plumbing): Explore > 3D View opens
    a singleton tab, lazy-loads the vendored Three.js/OrbitControls (js/vendor/) without
    any console error, and renders a real <canvas> with nonzero size — not stuck behind
    the "Loading 3D view..." placeholder (a real bug found while building this: the
    placeholder div was never removed before the canvas got appended as its sibling,
    so the unpositioned, 100%-height placeholder pushed the actual canvas out of view
    instead of being replaced by it). Also confirms closing and reopening the tab doesn't
    throw (the WebGL context gets disposed and a fresh one created, not a stale/duplicate
    one) and that reopening finds the same singleton tab rather than creating a second."""
    logs = []
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda exc: logs.append(str(exc)))
    page.goto(f"http://localhost:{PORT}/index.html")
    page.wait_for_timeout(800)

    page.click("#explore-menu-btn")
    menu_has_item = js(page, "async () => !!document.querySelector('#explore-menu .dd-item[data-action=\"view3d\"]')")
    page.click('#explore-menu .dd-item[data-action="view3d"]')
    try:
        page.wait_for_function("!!document.querySelector('.page-view.active canvas')", timeout=5000)
    except Exception:
        pass
    page.wait_for_timeout(300)

    first = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const canvas = document.querySelector('.page-view.active canvas');
      const placeholderStillShowing = !!document.querySelector('.page-view.active .view3d-loading');
      const tabCount = store.tabs.filter(t => t.type === '3d').length;
      return {
        canvasFound: !!canvas,
        canvasWidth: canvas ? canvas.width : 0,
        canvasHeight: canvas ? canvas.height : 0,
        placeholderStillShowing,
        tabCount,
      };
    }
    """)

    # Close and reopen — should dispose cleanly and re-render without error, still one tab.
    js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const tab = store.tabs.find(t => t.type === '3d');
      app.closeTab(tab.id);
      app.openOrSwitch3DView();
    }
    """)
    page.wait_for_timeout(400)
    second = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const canvas = document.querySelector('.page-view.active canvas');
      return {
        canvasFound: !!canvas,
        tabCount: store.tabs.filter(t => t.type === '3d').length,
      };
    }
    """)

    if not menu_has_item:
        return False, "Explore menu is missing the '3D View' item"
    if logs:
        return False, f"console errors opening the 3D View tab: {logs}"
    if not first["canvasFound"]:
        return False, f"no <canvas> found after opening 3D View: {first}"
    if first["canvasWidth"] == 0 or first["canvasHeight"] == 0:
        return False, f"the 3D view's canvas has zero size: {first}"
    if first["placeholderStillShowing"]:
        return False, f"the 'Loading 3D view...' placeholder is still showing alongside the rendered canvas: {first}"
    if first["tabCount"] != 1:
        return False, f"expected exactly one 3D tab, got {first['tabCount']}"
    if not second["canvasFound"]:
        return False, f"closing and reopening the 3D View tab left no canvas: {second}"
    if second["tabCount"] != 1:
        return False, f"closing and reopening should still result in exactly one 3D tab (singleton), got {second['tabCount']}"
    return True, f"3D View opened as a singleton tab, lazy-loaded cleanly with no console errors, rendered a real {first['canvasWidth']}x{first['canvasHeight']} canvas, and survived a close/reopen cycle"


def check_view3d_layers_and_filters(page):
    """Regression guard for 3D View Stage 1 (real data): parts are grouped into one
    InstancedMesh per element TYPE, layered in Z by element GROUP order (General, then
    Business, then Application, then Data — the Enterprise template's own value[] group
    order), reads the actual Three.js scene via view3d.js's getDebugSceneInfo (genuine
    internal state, not a screenshot guess). Also confirms the Stream/Type filters — now
    wired up for the 3D tab in main.js's filter-menu handlers, previously canvas-tab-only
    — actually reach the 3D scene, and that re-rendering with nothing changed reuses the
    same InstancedMesh objects (the signature-based skip in syncSceneData) rather than
    rebuilding them every single app.render() call, which fires on nearly every store
    mutation."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const mk = (type, streams) => store.createPart({ type, label: type, model: store.defaultModel, streams: streams || [] });
      for (let i = 0; i < 3; i++) mk('GeneralActor');
      for (let i = 0; i < 2; i++) mk('BusinessCapability');
      for (let i = 0; i < 5; i++) mk('ApplicationCapability', i < 2 ? ['S1'] : []);
      mk('DataDataEntity', ['S1']);

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 200));

      const initial = view3d.getDebugSceneInfo(tab.id);

      // stream filter: only ApplicationCapability(x2)+DataDataEntity(x1) carry S1
      tab.activeStreams = ['S1'];
      app.render();
      await new Promise(r => setTimeout(r, 100));
      const streamFiltered = view3d.getDebugSceneInfo(tab.id);

      // clear stream filter (null = unfiltered; [] now means "exclude all", distinct —
      // see canvas.js's passesStreamFilter), apply type filter instead
      tab.activeStreams = null;
      tab.activeElementTypes = ['BusinessCapability'];
      app.render();
      await new Promise(r => setTimeout(r, 100));
      const typeFiltered = view3d.getDebugSceneInfo(tab.id);

      // back to unfiltered, capture a mesh identity, re-render with nothing changed
      tab.activeElementTypes = null;
      app.render();
      await new Promise(r => setTimeout(r, 100));
      const beforeNoopUuid = view3d.getDebugSceneInfo(tab.id).types['GeneralActor'].meshUuid;
      app.render();
      await new Promise(r => setTimeout(r, 100));
      const afterNoopUuid = view3d.getDebugSceneInfo(tab.id).types['GeneralActor'].meshUuid;

      // a REAL change (new part of an already-present type) should be picked up
      mk('GeneralActor');
      app.render();
      await new Promise(r => setTimeout(r, 100));
      const afterRealChange = view3d.getDebugSceneInfo(tab.id);

      return { initial, streamFiltered, typeFiltered, beforeNoopUuid, afterNoopUuid, afterRealChange };
    }
    """)
    i = result["initial"]
    problems = []
    if i["meshCount"] != 4:
        problems.append(f"expected 4 InstancedMeshes (one per distinct type present), got {i['meshCount']}: {i['types']}")
    else:
        for type_, count in [("GeneralActor", 3), ("BusinessCapability", 2), ("ApplicationCapability", 5), ("DataDataEntity", 1)]:
            if i["types"].get(type_, {}).get("count") != count:
                problems.append(f"expected {count} instances of {type_}, got {i['types'].get(type_)}")
        z_general = i["types"]["GeneralActor"]["z"]
        z_business = i["types"]["BusinessCapability"]["z"]
        z_application = i["types"]["ApplicationCapability"]["z"]
        z_data = i["types"]["DataDataEntity"]["z"]
        if not (z_general < z_business < z_application < z_data):
            problems.append(f"expected layer Z order General < Business < Application < Data, got {z_general}, {z_business}, {z_application}, {z_data}")
    sf = result["streamFiltered"]
    if sf["meshCount"] != 2 or sf["types"].get("ApplicationCapability", {}).get("count") != 2 or sf["types"].get("DataDataEntity", {}).get("count") != 1:
        problems.append(f"Stream filter ['S1'] should leave only 2 ApplicationCapability + 1 DataDataEntity, got {sf}")
    tf = result["typeFiltered"]
    if tf["meshCount"] != 1 or tf["types"].get("BusinessCapability", {}).get("count") != 2:
        problems.append(f"Type filter ['BusinessCapability'] should leave only that type (2 instances), got {tf}")
    if result["beforeNoopUuid"] != result["afterNoopUuid"]:
        problems.append("re-rendering with nothing changed should reuse the same InstancedMesh (signature-based skip), got a different mesh uuid — rebuilding on every render() would be wasteful at real scale")
    arc = result["afterRealChange"]
    if arc["types"].get("GeneralActor", {}).get("count") != 4:
        problems.append(f"adding a new GeneralActor part should bring its count to 4 after the next render(), got {arc['types'].get('GeneralActor')}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "parts grouped into one InstancedMesh per type, layered in the correct General/Business/Application/Data Z order, Stream and Type filters both reach the 3D scene, and an unchanged re-render reuses the same mesh instead of rebuilding it"


def check_view3d_stream_lane_alignment(page):
    """Regression guard for view3d.js's computeStreamLanes/layoutTypeIntoLanes (Stage
    6.1) — a follow-up fix reported directly after Stage 5.2's per-type stream
    clustering still left "significant criss cross between columns, stream names seem
    to jump around": each type's own Z-layer used to compute its row/col grid entirely
    independently, so a stream's row position in one type's layer had NO relationship
    to that same stream's row position in the next layer, and cross-layer connectors
    (the main dependency chain) crisscrossed heavily even though each layer's OWN
    clustering was internally clean. Fix: one shared column width and one shared
    row-band per (section, stream) LANE, computed across every currently-visible part
    regardless of type, so a lane sits at the identical row (and therefore world Y) in
    every type's layer. This fixture puts 2 parts in an 'Alpha'-stream lane and 2 in a
    'Beta'-stream lane, in EACH of two different types (GeneralActor,
    BusinessCapability), plus a THIRD type (ApplicationCapability) holding a single
    multi-stream part 'q' (streams: ['Aardvark', 'Beta']) under an active filter of
    ['Alpha', 'Beta'] — 'Aardvark' isn't in the filter, so a filter-aware pick must
    still land 'q' on 'Beta' (Stage 5.2's own fix, still exercised here), landing it at
    the SAME world Y as every other Beta-lane part in every type. Every cell here has
    <= cols parts (no within-lane wrapping), so every assertion is an exact,
    deterministic world-Y equality/inequality — not a screenshot guess."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const mk = (type, label, streams) => store.createPart({ type, label, model: store.defaultModel, streams });

      const xa1 = mk('GeneralActor', 'XA1', ['Alpha']);
      const xa2 = mk('GeneralActor', 'XA2', ['Alpha']);
      const xb1 = mk('GeneralActor', 'XB1', ['Beta']);
      const xb2 = mk('GeneralActor', 'XB2', ['Beta']);
      const ya1 = mk('BusinessCapability', 'YA1', ['Alpha']);
      const ya2 = mk('BusinessCapability', 'YA2', ['Alpha']);
      const yb1 = mk('BusinessCapability', 'YB1', ['Beta']);
      const yb2 = mk('BusinessCapability', 'YB2', ['Beta']);
      // Alone in its own (type, lane) cell -- no tie-breaking ambiguity with xb1/xb2/
      // yb1/yb2 about which sub-row it lands on, only which LANE (lane = row-band).
      const q = mk('ApplicationCapability', 'Q', ['Aardvark', 'Beta']);

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      tab.activeStreams = ['Alpha', 'Beta'];
      app.render();
      await new Promise(r => setTimeout(r, 300));

      const info = view3d.getDebugSceneInfo(tab.id);
      const posX = info.types['GeneralActor']?.positions || {};
      const posY = info.types['BusinessCapability']?.positions || {};
      const posQ = info.types['ApplicationCapability']?.positions || {};

      return {
        xa1Y: posX[xa1.id]?.y, xa2Y: posX[xa2.id]?.y, xb1Y: posX[xb1.id]?.y, xb2Y: posX[xb2.id]?.y,
        ya1Y: posY[ya1.id]?.y, ya2Y: posY[ya2.id]?.y, yb1Y: posY[yb1.id]?.y, yb2Y: posY[yb2.id]?.y,
        qY: posQ[q.id]?.y,
      };
    }
    """)
    def close(a, b):
        return a is not None and b is not None and abs(a - b) < 1e-6
    r = result
    problems = []
    if not close(r["xa1Y"], r["xa2Y"]) or not close(r["xa1Y"], r["ya1Y"]) or not close(r["ya1Y"], r["ya2Y"]):
        problems.append(f"expected all 4 Alpha-stream parts (across BOTH GeneralActor and BusinessCapability) to share the SAME world Y -- the whole point of global stream lanes -- got xa1Y={r['xa1Y']} xa2Y={r['xa2Y']} ya1Y={r['ya1Y']} ya2Y={r['ya2Y']}")
    if not close(r["xb1Y"], r["xb2Y"]) or not close(r["xb1Y"], r["yb1Y"]) or not close(r["yb1Y"], r["yb2Y"]):
        problems.append(f"expected all 4 Beta-stream parts (across BOTH types) to share the SAME world Y, got xb1Y={r['xb1Y']} xb2Y={r['xb2Y']} yb1Y={r['yb1Y']} yb2Y={r['yb2Y']}")
    if close(r["xa1Y"], r["xb1Y"]):
        problems.append(f"expected the Alpha lane and the Beta lane to occupy DIFFERENT rows (distinct world Y), got both at {r['xa1Y']}")
    if not close(r["qY"], r["xb1Y"]):
        problems.append(f"expected 'q' (streams: Aardvark + Beta, filtered to [Alpha,Beta]) to resolve to the filter-relevant 'Beta' lane and land at the SAME world Y as every other Beta-lane part in every type, got qY={r['qY']} vs the Beta lane's {r['xb1Y']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {r})"
    return True, "computeStreamLanes/layoutTypeIntoLanes give every (section, stream) lane one shared, globally-consistent row-band -- a stream's row (and world Y) is now identical across every type's own Z-layer, not just internally clean within one layer, and a multi-stream part still resolves to whichever of its streams the active filter is actually about"


def check_view3d_connectors_and_clustering(page):
    """Regression guard for 3D View Stage 2: connector lines and section clustering.
    Builds A0/A1/A2 (GeneralActor, section "SectionA"), B0 (GeneralActor, section
    "SectionB"), C (BusinessCapability, a different type/layer), and Ghost
    (DataDataEntity) — with cols=2 for the 4 GeneralActor parts, so filling them in
    section-sorted order WITHOUT a forced row break would land A2 and B0 on the SAME row
    (2 per row, 4 parts -> exactly 2 rows, no room for a section boundary unless a row is
    deliberately left partially filled). Connectors: A0->A1 (same type), A0->C (crosses
    type/group layers), A0->Ghost (to prove a connector disappears once either endpoint
    is filtered out — same "hide the node, its connectors disappear too" convention the
    2D canvas already uses, not a new rule invented for 3D)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const mk = (type, label, section) => store.createPart({ type, label, model: store.defaultModel, streams: [], section: section || '' });
      const A0 = mk('GeneralActor', 'A0', 'SectionA');
      const A1 = mk('GeneralActor', 'A1', 'SectionA');
      const A2 = mk('GeneralActor', 'A2', 'SectionA');
      const B0 = mk('GeneralActor', 'B0', 'SectionB');
      const C = mk('BusinessCapability', 'C', '');
      const ghost = mk('DataDataEntity', 'Ghost', '');
      const conn = (from, to) => store.createConnector({ from: from.id, to: to.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      conn(A0, A1);
      conn(A0, C);
      conn(A0, ghost);

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 200));
      const initial = view3d.getDebugSceneInfo(tab.id);

      // exclude DataDataEntity -> the A0->Ghost connector's target vanishes
      tab.activeElementTypes = ['GeneralActor', 'BusinessCapability'];
      app.render();
      await new Promise(r => setTimeout(r, 150));
      const filtered = view3d.getDebugSceneInfo(tab.id);

      return { initial, filtered };
    }
    """)
    i = result["initial"]
    problems = []
    if i["connectorCount"] != 3:
        problems.append(f"expected 3 connector lines initially (all endpoints visible), got {i['connectorCount']}")
    ga = i["types"].get("GeneralActor", {})
    positions = ga.get("positions", {})
    if len(positions) != 4:
        problems.append(f"expected 4 GeneralActor positions, got {len(positions)}")
    else:
        distinctYs = len(set(round(p["y"], 6) for p in positions.values()))
        if distinctYs != 3:
            problems.append(f"expected 3 distinct rows (Y values) among A0/A1/A2/B0 with cols=2 — proves the section boundary forced an extra row rather than naturally packing 4 into 2 rows — got {distinctYs} distinct Y values: {positions}")
    f = result["filtered"]
    if f["connectorCount"] != 2:
        problems.append(f"expected the A0->Ghost connector to disappear once DataDataEntity is filtered out (2 remaining), got {f['connectorCount']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "connector lines drawn between resolved positions (and correctly disappearing once a filtered-out endpoint hides), and section clustering forces a new row at each section boundary instead of packing across it"


def check_view3d_layer_order_template_selector(page):
    """Regression guard for Stage 6.2: custom.json's cubeOrder (a separate top-level
    field that used to ALWAYS blend into layer ordering underneath whichever
    streamTemplate happened to be preferred elsewhere) is now just another
    streamTemplates entry named "All" (its value[] is the old cubeOrder list, verbatim),
    picked via a new toolbar-only "Layer Order" <select> (view3DLayerOrderTemplate in
    Local Settings) — independent of Remap/Generate Stream's own shared template
    preference. Reported directly: "make cubeorder into a new streamTemplate named
    something like all, and cubeOrder list goes into value. Then provide user ability to
    switch streamTemplate for 3d view display", then corrected TWICE: (1) "anything that
    template's value[] doesn't mention should not be shown" (an initial version only
    REORDERED unmentioned types via the tkDisplayOrder/alphabetical fallback; picking a
    template now HIDES them entirely instead); (2) "the layer order appears to be
    missing the passive elements and their connectors, when a 'Layer Order' is selected
    that includes passives" (fix (1) wrongly hid a type ONLY mentioned in the template's
    passive[] from/to pairs, not its value[] chain — passive[] types must count as
    visible too, just without a defined chain position of their own). Verifies the
    toolbar <select> lists "All" among the real templates and defaults to it; that ALL
    THREE element types render under "All" (which covers everything); and that switching
    to the built-in 'Test' template (value: BusinessService, BusinessCapability,
    BusinessProcess, thingamajack, DataDataEntity; passive: BusinessFunction->
    BusinessProcess, BusinessCapability->metaDataRegistry, GeneralActor->thingamajig)
    keeps BOTH BusinessCapability (value[]) AND BusinessFunction (passive[]-only)
    visible, while ApplicationComponent (mentioned in NEITHER Test's value[] nor its
    passive[]) disappears from the scene entirely."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');

      store.createPart({ type: 'ApplicationComponent', label: 'AC', model: store.defaultModel, streams: [] });
      store.createPart({ type: 'BusinessCapability', label: 'BC', model: store.defaultModel, streams: [] });
      store.createPart({ type: 'BusinessFunction', label: 'BF', model: store.defaultModel, streams: [] });

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 200));

      const select = document.getElementById('view3d-layer-order-select');
      const options = [...select.options].map(o => o.value);
      const defaultValue = select.value;
      const infoAll = view3d.getDebugSceneInfo(tab.id);

      select.value = 'Test';
      select.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 200));
      const infoTest = view3d.getDebugSceneInfo(tab.id);

      return {
        options, defaultValue,
        acShownAll: !!infoAll.types.ApplicationComponent, bcShownAll: !!infoAll.types.BusinessCapability, bfShownAll: !!infoAll.types.BusinessFunction,
        acShownTest: !!infoTest.types.ApplicationComponent, bcShownTest: !!infoTest.types.BusinessCapability, bfShownTest: !!infoTest.types.BusinessFunction,
      };
    }
    """)
    r = result
    problems = []
    if 'All' not in r["options"]:
        problems.append(f"expected the Layer Order <select> to list 'All' among the streamTemplates, got {r['options']}")
    if r["defaultValue"] != 'All':
        problems.append(f"expected the Layer Order <select> to default to 'All', got {r['defaultValue']}")
    if not r["acShownAll"] or not r["bcShownAll"] or not r["bfShownAll"]:
        problems.append(f"expected ALL THREE types visible with 'All' selected (covers everything), got {r}")
    if not r["bcShownTest"]:
        problems.append("expected BusinessCapability to stay visible with 'Test' selected -- Test's value[] DOES mention it")
    if not r["bfShownTest"]:
        problems.append("expected BusinessFunction to stay visible with 'Test' selected -- Test's passive[] mentions it (from: BusinessFunction), even though value[] doesn't -- passive-only types must not be hidden")
    if r["acShownTest"]:
        problems.append("expected ApplicationComponent to disappear entirely with 'Test' selected -- Test mentions it in NEITHER value[] nor passive[]")
    if problems:
        return False, "; ".join(problems) + f" (full: {r})"
    return True, "the 3D View's Layer Order template picker lists 'All' (the former cubeOrder) alongside real streamTemplates, defaults to it, HIDES a type mentioned in neither value[] nor passive[], and keeps a passive[]-only type visible (not just a value[]-mentioned one)"


def check_view3d_all_template_covers_all_elements(page):
    """Regression guard for a real near-miss: the "All" streamTemplate (formerly
    custom.json's separate cubeOrder field — see check_view3d_layer_order_template_selector
    above) is meant to cover every element type — but it's a second, hand-maintained list
    that has to be kept in sync with settings.elements by hand every time a new element
    type is added, with nothing enforcing that today. Caught while adding BusinessEvent:
    the new element worked fine in the Toolbox and on canvas immediately, but would have
    silently fallen through to resolveLayerOrder's defensive tkDisplayOrder/alphabetical
    fallback in the 3D View (rather than its deliberate, intended position) if cubeOrder
    hadn't ALSO been updated at the time — an easy thing to forget since nothing else
    surfaces the omission. Checks both directions: every element type appears in "All"'s
    value[] exactly once, and every value[] entry has a matching element."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const elTypes = (store.settings.elements || []).map(e => e.type);
      const allTemplate = (store.settings.streamTemplates || []).find(t => t.name === 'All');
      const all = allTemplate ? allTemplate.value : [];
      const elSet = new Set(elTypes);
      const allSet = new Set(all);
      const missingFromAll = elTypes.filter(t => !allSet.has(t));
      const orphanedInAll = all.filter(t => !elSet.has(t));
      const dupesInAll = all.filter((t, i) => all.indexOf(t) !== i);
      return { found: !!allTemplate, elementCount: elTypes.length, allCount: all.length, missingFromAll, orphanedInAll, dupesInAll };
    }
    """)
    problems = []
    if not result["found"]:
        problems.append("expected a streamTemplates entry named 'All'")
    if result["missingFromAll"]:
        problems.append(f"element type(s) missing from 'All''s value[]: {result['missingFromAll']}")
    if result["orphanedInAll"]:
        problems.append(f"'All' value[] entries with no matching element: {result['orphanedInAll']}")
    if result["dupesInAll"]:
        problems.append(f"duplicate entries in 'All''s value[]: {result['dupesInAll']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, f"the 'All' streamTemplate's value[] stays in exact 1:1 correspondence with settings.elements ({result['elementCount']} types, no gaps/orphans/duplicates)"


def check_view3d_focus_and_zoom_jump(page):
    """Regression guard for 3D View Stage 4 (zoom-to-2D-detail): focusing a part (driven
    here via view3d.js's debugFocusPart, since real mouse/wheel events are unreliable
    against a headless WebGL canvas — see that function's own comment) sets focusedPartId,
    shows the wireframe highlight marker, AND shows that part's own properties in the
    Properties panel — via tab.selectedCatalogRow, the same mechanism the Parts Catalog
    table's row selection already drives, so a 3D click gets the identical "Part" editor a
    canvas node click or catalog row would. Zooming in past ZOOM_JUMP_DISTANCE while
    focused (driven via debugSetCameraDistance, which repositions the camera and dispatches
    the same 'change' event a real zoom would) switches to the matching 2D view and selects
    the right viewMember there — exactly once per crossing, checked directly via
    jumpedForPartId rather than only by side effect, so a regression that re-fires every
    frame while still inside the threshold would be caught even though it'd look
    superficially the same (still ends up on the right view); zooming back out past the
    threshold re-arms it so zooming back in jumps again; and a focused part with no view
    placement anywhere keeps showing its own properties (the same thing the initial focus
    already showed) instead of navigating anywhere or throwing."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');

      const placed = store.createPart({ type: 'GeneralActor', label: 'Placed', model: store.defaultModel, streams: [] });
      const orphan = store.createPart({ type: 'GeneralActor', label: 'Orphan', model: store.defaultModel, streams: [] });
      const view = store.addView('ZoomJumpDemo');
      const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: placed.id, x: 100, y: 100 });

      app.openOrSwitch3DView();
      const tab3d = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 200));

      // Spy on openOrSwitchView (jumpToMatching2DView's only way to navigate) so the
      // "fires once per crossing, not once per frame" guard is checked by actual CALL
      // COUNT, not just by the resulting state, which stays identical either way once
      // openOrSwitchView/reselecting the same viewMember is itself idempotent.
      let switchCalls = 0;
      const origOpenOrSwitchView = app.openOrSwitchView.bind(app);
      app.openOrSwitchView = (...args) => { switchCalls++; return origOpenOrSwitchView(...args); };

      const focusOk = view3d.debugFocusPart(app, tab3d.id, placed.id);
      const afterFocus = view3d.getDebugSceneInfo(tab3d.id);
      const afterFocusSelectedRow = { ...tab3d.selectedCatalogRow };

      // zoom in past the threshold -> should jump to ZoomJumpDemo and select vm
      view3d.debugSetCameraDistance(tab3d.id, 0.5);
      await new Promise(r => setTimeout(r, 100));
      const at1 = store.activeTab();
      const afterJump = { type: at1 ? at1.type : null, viewId: at1 ? at1.viewId : null, selection: at1 ? [...at1.selection] : [] };
      const switchCallsAfterFirstJump = switchCalls;

      // still "inside" the threshold, no re-arm in between -> must NOT re-trigger
      const jumpedForBefore = view3d.getDebugSceneInfo(tab3d.id).jumpedForPartId;
      view3d.debugSetCameraDistance(tab3d.id, 0.4);
      const jumpedForAfterRepeat = view3d.getDebugSceneInfo(tab3d.id).jumpedForPartId;
      const switchCallsAfterRepeat = switchCalls;

      // zoom back OUT past the threshold -> re-arms (jumpedForPartId clears, focus stays)
      app.switchToTab(tab3d.id);
      view3d.debugSetCameraDistance(tab3d.id, 50);
      const rearmed = view3d.getDebugSceneInfo(tab3d.id);

      // zoom back in -> jumps again, proving re-arm actually re-fires, not just the flag
      view3d.debugSetCameraDistance(tab3d.id, 0.5);
      await new Promise(r => setTimeout(r, 100));
      const at2 = store.activeTab();
      const secondJump = { type: at2 ? at2.type : null, viewId: at2 ? at2.viewId : null };

      // a focused part with NO view placement should show its own properties, not
      // navigate or throw — and the Properties panel should actually render them (not
      // just tab.selectedCatalogRow being set), since renderProperties' 3D-tab dispatch
      // is a separate piece of wiring (render.js) from view3d.js setting the field.
      app.switchToTab(tab3d.id);
      view3d.debugFocusPart(app, tab3d.id, orphan.id);
      view3d.debugSetCameraDistance(tab3d.id, 0.5);
      await new Promise(r => setTimeout(r, 100));
      const at3 = store.activeTab();
      const orphanResult = {
        activeTabType: at3 ? at3.type : null,
        selectedCatalogRow: { ...tab3d.selectedCatalogRow },
        panelHtml: document.getElementById('properties-body').innerHTML,
      };

      app.openOrSwitchView = origOpenOrSwitchView;
      return { focusOk, afterFocus, afterFocusSelectedRow, afterJump, jumpedForBefore, jumpedForAfterRepeat, switchCallsAfterFirstJump, switchCallsAfterRepeat, rearmed, secondJump, orphanResult, vmId: vm.id, viewId: view.id, partId: placed.id, orphanId: orphan.id };
    }
    """)
    problems = []
    partId = result["partId"]
    if not result["focusOk"]:
        problems.append("debugFocusPart returned false for a part actually present in the scene")
    af = result["afterFocus"]
    if af["focusedPartId"] != partId or not af["focusMarkerVisible"]:
        problems.append(f"expected focusPart to set focusedPartId and show the highlight marker, got {af}")
    afsr = result["afterFocusSelectedRow"]
    if afsr.get("catalogType") != "parts" or afsr.get("id") != partId:
        problems.append(f"expected focusing a part to select it in the Properties panel via tab.selectedCatalogRow (catalogType 'parts', id {partId}), got {afsr}")
    aj = result["afterJump"]
    if aj["type"] != "canvas" or aj["viewId"] != result["viewId"] or result["vmId"] not in aj["selection"]:
        problems.append(f"zooming past the threshold while focused should jump to view '{result['viewId']}' and select viewMember {result['vmId']}, got {aj}")
    if result["switchCallsAfterFirstJump"] != 1:
        problems.append(f"expected exactly 1 navigation call for the first threshold crossing, got {result['switchCallsAfterFirstJump']}")
    if result["jumpedForBefore"] != partId:
        problems.append(f"expected jumpedForPartId to be set to the focused part right after the jump, got {result['jumpedForBefore']}")
    if result["jumpedForAfterRepeat"] != partId:
        problems.append(f"a second zoom call while still inside the threshold (no re-arm in between) should NOT change jumpedForPartId — the jump must fire once per crossing, not once per frame; got {result['jumpedForAfterRepeat']}")
    if result["switchCallsAfterRepeat"] != 1:
        problems.append(f"a second zoom call while still inside the threshold (no re-arm in between) should NOT trigger a second navigation call — expected the call count to stay at 1, got {result['switchCallsAfterRepeat']}")
    if result["rearmed"]["jumpedForPartId"] is not None:
        problems.append(f"zooming back out past the threshold should re-arm (clear jumpedForPartId), got {result['rearmed']}")
    if result["rearmed"]["focusedPartId"] != partId:
        problems.append(f"zooming back out shouldn't clear the focus itself, only re-arm the jump, got {result['rearmed']}")
    sj = result["secondJump"]
    if sj["type"] != "canvas" or sj["viewId"] != result["viewId"]:
        problems.append(f"zooming back in past the threshold after re-arming should jump again, got {sj}")
    orp = result["orphanResult"]
    if orp["activeTabType"] != "3d":
        problems.append(f"a focused part with no view placement should NOT navigate anywhere, got active tab type {orp['activeTabType']}")
    if orp["selectedCatalogRow"].get("catalogType") != "parts" or orp["selectedCatalogRow"].get("id") != result["orphanId"]:
        problems.append(f"a focused part with no view placement should keep showing its own properties (tab.selectedCatalogRow), got {orp['selectedCatalogRow']}")
    if "Orphan" not in orp["panelHtml"]:
        problems.append(f"the Properties panel should actually render the unplaced part's own fields (e.g. its label 'Orphan'), got panel HTML that doesn't mention it: {orp['panelHtml'][:300]}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "click-to-focus sets state, shows the marker, and shows the part's properties in the panel; zooming past the threshold jumps to the matching 2D view and selects the right node exactly once per crossing; zooming back out re-arms it so zooming back in jumps again; and an unplaced part keeps showing its own properties instead of navigating or throwing"


def check_sfce_array_field_survives_deeper_nesting(page):
    """Regression guard for a real bug found in Load SFCCE's field-mapping wizard: a
    multi-value field holding an array of PRIMITIVES (e.g. an Application Capability's own
    "sections"/"ministries" list) sitting alongside a DEEPER nested array-of-OBJECTS field
    (e.g. that same Application Capability's "entities") was silently dropped from
    flattenJsonRecords' output fields — so it never appeared as a selector option in the
    mapping step at all. Root cause: the outer-record "carry forward into the next nesting
    pass" filter excluded every Array value, not just array-of-OBJECTS values (the ones
    that actually need a further unwrap pass) — so a field that was already a flat
    array-of-strings got treated the same as an unflattened array-of-objects and discarded
    once ANOTHER nested array existed below it. This didn't show up with a file where the
    array-of-primitives field was the DEEPEST level (nothing left to flatten past it, so
    the drop never triggered) — only once a file had a further nesting level underneath,
    which a real user-generated SFCCE file (capabilities-legal-SFCCE.json, applicationCapabilities
    carrying both "sections" and a further-nested "entities") actually did."""
    result = js(page, """
    async () => {
      const sfce = await import('./js/sfce.js');
      const data = [{
        function: 'F1',
        capabilities: [{
          name: 'Cap1',
          applicationCapabilities: [{
            name: 'AC1',
            sections: ['SecA', 'SecB'],
            entities: [{ name: 'Ent1' }, { name: 'Ent2' }],
          }],
        }],
      }];
      const { records, fields } = sfce.flattenJsonRecords(data);
      return { records, fields };
    }
    """)
    problems = []
    fields = result["fields"]
    if "capabilities.applicationCapabilities.sections" not in fields:
        problems.append(f"expected 'capabilities.applicationCapabilities.sections' (an array-of-primitives field sitting above a deeper 'entities' nesting) to survive into flattenJsonRecords' fields list, got: {fields}")
    records = result["records"]
    if len(records) != 2:
        problems.append(f"expected 2 flattened records (one per entity under AC1), got {len(records)}")
    else:
        for r in records:
            if r.get("capabilities.applicationCapabilities.sections") != ["SecA", "SecB"]:
                problems.append(f"expected every flattened record to carry the full, unmodified sections array, got {r.get('capabilities.applicationCapabilities.sections')} in record {r}")
                break
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "an array-of-primitives field (sections) sitting above a deeper nested array-of-objects field (entities) survives flattening intact, on every resulting record, instead of being silently dropped"


def check_view3d_sim_overlay(page):
    """Regression guard for 3D View Stage 5 (live simulation overlay): a currently-visible
    part with a store.simRuntime entry for its own model gets a small colored marker above
    it — green/blue/red for normal/changed/error, the exact palette css/styles.css'
    .fnode-sim-badge already uses for the 2D canvas (SIM_STATE_COLORS), not a new encoding.
    Covers: three parts (steady/unscripted, a script that changes value every tick, a
    script that throws) each land in the correct one of the three marker meshes after two
    ticks; the 'changed' marker's scale actually oscillates over real elapsed time
    (debugGetSimMarkerScale sampled twice with a real wait in between — proves the pulse
    animation is live, not just a static bigger sphere); and filtering a simulated part
    out removes its marker too, the same "hide the node, its overlay disappears" convention
    already established for connectors."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const sim = await import('./js/simulation.js');
      const view3d = await import('./js/view3d.js');

      const steady = store.createPart({ type: 'GeneralActor', label: 'Steady', model: store.defaultModel, streams: [] });
      const changing = store.createPart({ type: 'GeneralActor', label: 'Changing', model: store.defaultModel, streams: [] });
      changing.scriptEnabled = true;
      changing.script = 'return { value: ctx.tick };';
      const erroring = store.createPart({ type: 'GeneralActor', label: 'Erroring', model: store.defaultModel, streams: [] });
      erroring.scriptEnabled = true;
      erroring.script = 'throw new Error(\\"boom\\");';

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 200));
      const beforeAnyTick = view3d.getDebugSceneInfo(tab.id).simOverlay;

      sim.stepSimulation(app, store.defaultModel);
      sim.stepSimulation(app, store.defaultModel);
      await new Promise(r => setTimeout(r, 150));
      const afterTicks = view3d.getDebugSceneInfo(tab.id).simOverlay;

      const scaleA = view3d.debugGetSimMarkerScale(tab.id, 'changed');
      await new Promise(r => setTimeout(r, 220));
      const scaleB = view3d.debugGetSimMarkerScale(tab.id, 'changed');

      // filter out every part's type entirely -> every overlay marker should disappear too
      tab.activeElementTypes = ['BusinessCapability']; // a type none of these parts have
      app.render();
      await new Promise(r => setTimeout(r, 150));
      const afterFilteredOut = view3d.getDebugSceneInfo(tab.id).simOverlay;

      return { beforeAnyTick, afterTicks, scaleA, scaleB, afterFilteredOut };
    }
    """)
    problems = []
    if len(result["beforeAnyTick"]) != 0:
        problems.append(f"expected no sim overlay markers before any simulation tick has run, got {result['beforeAnyTick']}")
    at = result["afterTicks"]
    for state, expectedCount in [("normal", 1), ("changed", 1), ("error", 1)]:
        if at.get(state, {}).get("count") != expectedCount:
            problems.append(f"expected exactly {expectedCount} '{state}' marker after ticking (1 steady/1 changing/1 erroring part), got {at.get(state)}: full {at}")
    if result["scaleA"] is None or result["scaleB"] is None:
        problems.append(f"expected debugGetSimMarkerScale to find the 'changed' marker both times, got {result['scaleA']} then {result['scaleB']}")
    elif abs(result["scaleA"] - result["scaleB"]) < 0.05:
        problems.append(f"expected the 'changed' marker's scale to visibly pulse (oscillate) over ~220ms of real elapsed time, got barely-different samples {result['scaleA']} and {result['scaleB']}")
    af = result["afterFilteredOut"]
    if len(af) != 0:
        problems.append(f"expected every sim overlay marker to disappear once its part is filtered out (Type filter set to a type none of these parts have), got {af}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "sim overlay markers use the 2D canvas's own normal/changed/error color encoding, the 'changed' marker visibly pulses over real elapsed time, and filtering a part out removes its overlay marker too"


def check_view3d_dispose_cancels_current_animation_frame(page):
    """Regression guard for a real bug found while building Stage 5: createInstance used
    to capture inst.animId as a one-time snapshot of an outer `animId` variable at object-
    construction time (`const inst = { ..., animId, ... }`), but every SUBSEQUENT
    requestAnimationFrame call inside animate() only reassigned that outer variable, never
    inst.animId again — so inst.animId went stale after the very first frame. disposeInstance's
    cancelAnimationFrame(inst.animId) was then always cancelling an already-fired, harmless
    id, never the actual currently-pending frame, silently leaking a forever-running render
    loop (against a disposed renderer/scene) on every closed 3D tab. Verified here by
    intercepting the real window.requestAnimationFrame/cancelAnimationFrame, letting
    several real frames elapse (so the first- and most-recently-requested ids differ), then
    confirming the id actually passed to cancelAnimationFrame at tab-close time matches the
    LAST id requested, not the first."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const requestedIds = [];
      const cancelledIds = [];
      const origRAF = window.requestAnimationFrame.bind(window);
      const origCAF = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => { const id = origRAF(cb); requestedIds.push(id); return id; };
      window.cancelAnimationFrame = (id) => { cancelledIds.push(id); return origCAF(id); };

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 400)); // let several real animation frames elapse

      const idsBeforeClose = [...requestedIds];
      app.closeTab(tab.id);
      await new Promise(r => setTimeout(r, 50));

      window.requestAnimationFrame = origRAF;
      window.cancelAnimationFrame = origCAF;

      return {
        requestedCount: idsBeforeClose.length,
        firstRequestedId: idsBeforeClose[0],
        lastRequestedId: idsBeforeClose[idsBeforeClose.length - 1],
        cancelledIds,
      };
    }
    """)
    problems = []
    if result["requestedCount"] < 2:
        problems.append(f"expected multiple real animation frames to have elapsed before closing the tab (so first vs. last id actually differ), only saw {result['requestedCount']} — increase the wait if this is flaky")
    elif result["lastRequestedId"] not in result["cancelledIds"]:
        problems.append(f"expected the MOST RECENTLY requested animation frame id ({result['lastRequestedId']}) to be the one cancelled on tab close, but cancelAnimationFrame was called with {result['cancelledIds']} — the render loop's actual pending frame was never cancelled, leaking it")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, f"closing a 3D tab cancels its actually-current pending animation frame ({result['lastRequestedId']}), not a stale id from the first frame ever scheduled"


def check_view3d_real_click_shows_panel_and_no_recenter(page):
    """Regression guard for a real bug found via genuine mouse-click testing: the click
    listener only ever called focusPart, never selectPartInPanel — so "click shows this
    part's properties in the panel" (a feature added earlier, and already covered by a
    regression check) silently never worked for an ACTUAL mouse click, only for the
    debugFocusPart test hook, which has its own separate, correct call to
    selectPartInPanel. A hook-only test structurally cannot catch this class of drift
    between a debug shortcut and the real listener it stands in for — this check drives a
    genuine page.mouse.click(), positioned via debugGetScreenPosition (world-to-screen
    projection), and would have caught the bug immediately. Also confirms focusing a part
    via click does NOT recenter/move OrbitControls' own orbit target (a deliberate
    change — clicking a node shows its properties and highlights it in place, not yanks
    the camera to center on it)."""
    setup = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const part = store.createPart({ type: 'GeneralActor', label: 'ClickTarget', model: store.defaultModel, streams: [] });
      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 250));
      const before = view3d.getDebugSceneInfo(tab.id).controlsTarget;
      const pos = view3d.debugGetScreenPosition(tab.id, part.id);
      return { partId: part.id, before, pos };
    }
    """)
    if not setup["pos"]:
        return False, f"debugGetScreenPosition couldn't find the part on screen: {setup}"

    page.mouse.click(setup["pos"]["x"], setup["pos"]["y"])
    page.wait_for_timeout(200)
    after = js(page, """
    async () => {
      const view3d = await import('./js/view3d.js');
      const app = window.dycadApp, store = app.store;
      const tab = store.tabs.find(t => t.type === '3d');
      const info = view3d.getDebugSceneInfo(tab.id);
      return {
        controlsTarget: info.controlsTarget,
        focusedPartId: info.focusedPartId,
        focusMarkerVisible: info.focusMarkerVisible,
        selectedCatalogRow: tab.selectedCatalogRow,
        panelHtml: document.getElementById('properties-body').innerHTML,
      };
    }
    """)
    problems = []
    if after["focusedPartId"] != setup["partId"] or not after["focusMarkerVisible"]:
        problems.append(f"expected a real click to focus the part and show its marker, got {after}")
    if not after["selectedCatalogRow"] or after["selectedCatalogRow"].get("id") != setup["partId"]:
        problems.append(f"expected a real click to select the part in the Properties panel via tab.selectedCatalogRow, got {after['selectedCatalogRow']}")
    if "ClickTarget" not in after["panelHtml"]:
        problems.append(f"expected the Properties panel to actually render the clicked part's own fields (its label 'ClickTarget'), got HTML that doesn't mention it: {after['panelHtml'][:300]}")
    before, targetAfter = setup["before"], after["controlsTarget"]
    moved = any(abs(before[k] - targetAfter[k]) > 1e-9 for k in ("x", "y", "z"))
    if moved:
        problems.append(f"expected clicking a node NOT to move OrbitControls' own orbit target (no camera recenter), got it move from {before} to {targetAfter}")
    if problems:
        return False, "; ".join(problems) + f" (setup: {setup}, after: {after})"
    return True, "a genuine mouse click focuses the part, shows its properties in the panel, and does not recenter the camera"


def check_filters_panel_moved_from_toolbar(page):
    """Regression guard for the header toolbar's own filter controls (View Scope,
    Stream, Types, Section, Connector Type, Layer Order, Highlight, Levels) being
    relocated into a new collapsible "Filters" panel section in the right column,
    above Properties -- reported directly: "In the right column above properties add
    a new collapsable group called Filters. Move the existing filters ... but not
    'Undo / Redo', 'Current View' or 'Default Model' to this new filter group."
    Covers: (1) the new #right-panel > [data-panel-id="filters"] section exists,
    positioned immediately before [data-panel-id="properties"]; (2) all 8 filter
    group elements are genuinely inside it (not still in #toolbar-row); (3) Undo/
    Redo, Current View, and Default Model are still in #toolbar-row, untouched; (4)
    it's a real collapsible panel (toggling .panel-toggle collapses/expands it, with
    the same localStorage persistence every other collapsible panel already uses);
    (5) per-tab-type show/hide still works correctly now that these live in a new
    location (same assertions as check_toolbar_filter_groups_hidden_when_inactive,
    confirming the move didn't break the existing behavior); (6) the whole Filters
    section itself hides when NONE of the 8 groups apply (a table/catalog tab)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const groupIds = ['view3d-scope-group', 'stream-filter-group', 'element-type-filter-group', 'section-filter-group', 'connector-type-filter-group', 'view3d-layer-order-group', 'highlight-type-filter-group', 'connector-levels-group'];
      const out = {};

      const filtersSection = document.querySelector('#right-panel [data-panel-id="filters"]');
      const propertiesSection = document.querySelector('#right-panel [data-panel-id="properties"]');
      out.filtersSectionExists = !!filtersSection;
      out.filtersBeforeProperties = !!(filtersSection && propertiesSection && filtersSection.compareDocumentPosition(propertiesSection) & Node.DOCUMENT_POSITION_FOLLOWING);
      out.allGroupsInsideFilters = groupIds.every(id => filtersSection && filtersSection.contains(document.getElementById(id)));
      out.noGroupsInToolbar = groupIds.every(id => !document.getElementById('toolbar-row').contains(document.getElementById(id)));
      out.undoRedoStillInToolbar = document.getElementById('toolbar-row').contains(document.getElementById('undo-btn')) && document.getElementById('toolbar-row').contains(document.getElementById('redo-btn'));
      out.currentViewStillInToolbar = document.getElementById('toolbar-row').contains(document.getElementById('view-select'));
      out.defaultModelStillInToolbar = document.getElementById('toolbar-row').contains(document.getElementById('model-select'));

      // collapsible, with the same localStorage persistence pattern as every other panel
      const toggle = filtersSection.querySelector('.panel-toggle');
      out.startsExpanded = !filtersSection.classList.contains('collapsed');
      toggle.click();
      out.collapsedAfterToggle = filtersSection.classList.contains('collapsed');
      out.localStorageCollapsed = localStorage.getItem('dycad-panel-filters-collapsed');
      toggle.click();
      out.expandedAfterSecondToggle = !filtersSection.classList.contains('collapsed');

      // per-tab-type visibility still correct after the move
      const view = store.doc.views[0];
      const canvasTab = app.createCanvasTab(view);
      app.switchToTab(canvasTab.id);
      app.render();
      await new Promise(r => setTimeout(r, 60));
      out.filtersVisibleOnCanvas = !filtersSection.classList.contains('hidden');
      out.streamHiddenOnCanvas = document.getElementById('stream-filter-group').classList.contains('hidden');
      out.viewScopeHiddenOnCanvas = document.getElementById('view3d-scope-group').classList.contains('hidden');

      app.openOrSwitchCatalog('parts', 'Parts');
      await new Promise(r => setTimeout(r, 60));
      out.filtersHiddenOnTable = filtersSection.classList.contains('hidden');

      return out;
    }
    """)
    problems = []
    if not result["filtersSectionExists"]:
        problems.append("expected a new [data-panel-id=\"filters\"] section inside #right-panel")
    if not result["filtersBeforeProperties"]:
        problems.append("expected the Filters section to come BEFORE the Properties section in the right column")
    if not result["allGroupsInsideFilters"]:
        problems.append("expected all 8 filter group elements to be inside the new Filters section")
    if not result["noGroupsInToolbar"]:
        problems.append("expected none of the 8 filter groups to remain in #toolbar-row")
    if not result["undoRedoStillInToolbar"]:
        problems.append("expected Undo/Redo to stay in the toolbar (not moved)")
    if not result["currentViewStillInToolbar"]:
        problems.append("expected Current View to stay in the toolbar (not moved)")
    if not result["defaultModelStillInToolbar"]:
        problems.append("expected Default Model to stay in the toolbar (not moved)")
    if not result["startsExpanded"]:
        problems.append("expected the Filters panel to start expanded")
    if not result["collapsedAfterToggle"] or result["localStorageCollapsed"] != "true":
        problems.append(f"expected clicking the Filters panel's toggle to collapse it and persist that to localStorage, got {result}")
    if not result["expandedAfterSecondToggle"]:
        problems.append("expected clicking the toggle again to re-expand the Filters panel")
    if not result["filtersVisibleOnCanvas"] or result["streamHiddenOnCanvas"] or not result["viewScopeHiddenOnCanvas"]:
        problems.append(f"expected correct per-tab-type visibility to survive the move to the new panel, got {result}")
    if not result["filtersHiddenOnTable"]:
        problems.append("expected the whole Filters section to hide when none of its 8 groups apply (a table/catalog tab)")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "The 8 filter controls (View Scope/Stream/Types/Section/Connector Type/Layer Order/Highlight/Levels) now live in a new collapsible Filters panel above Properties in the right column, Undo/Redo/Current View/Default Model stay in the toolbar, per-tab-type show/hide still works, and the whole section hides when nothing applies"


def check_view3d_empty_click_deselects_and_shows_filters(page):
    """Regression guard, direct follow-up: "Update the 3D View behaviour so that
    clicking on empty in the canvas will bring up this view filters and any view
    properties specific to 3D View." Uses a genuine page.mouse.click() (not a debug
    hook) on a real, on-screen part first (via debugGetScreenPosition, the same
    proven-necessary pattern check_view3d_real_click_shows_panel_and_no_recenter
    uses, since a hook-only test can't catch drift between a debug shortcut and the
    real listener), then a second real click on an empty corner of the canvas.
    Covers: (1) the empty click clears tab.selectedCatalogRow (deselects the part);
    (2) the Properties panel switches from the part's own fields to the new 3D
    "no part selected... Filters panel above" hint; (3) the Filters panel
    auto-expands if it had been manually collapsed beforehand, so the feature is
    genuinely "brought up" for the user, not just mentioned in text."""
    setup = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const part = store.createPart({ type: 'GeneralActor', label: 'RegrEmptyClickTarget', model: store.defaultModel, streams: [] });
      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 250));
      const pos = view3d.debugGetScreenPosition(tab.id, part.id);

      // Manually collapse the Filters panel, same as a user might have left it
      const filtersSection = document.querySelector('#right-panel [data-panel-id="filters"]');
      filtersSection.classList.add('collapsed');
      localStorage.setItem('dycad-panel-filters-collapsed', 'true');

      const canvasRect = document.querySelector('#pages-container canvas').getBoundingClientRect();
      return { partId: part.id, pos, emptyCorner: { x: canvasRect.left + 8, y: canvasRect.top + 8 } };
    }
    """)
    if not setup["pos"]:
        return False, f"debugGetScreenPosition couldn't find the part on screen: {setup}"

    page.mouse.click(setup["pos"]["x"], setup["pos"]["y"])
    page.wait_for_timeout(150)
    selectedAfterPartClick = js(page, """
    () => {
      const store = window.dycadApp.store;
      const tab = store.tabs.find(t => t.type === '3d');
      return tab.selectedCatalogRow ? tab.selectedCatalogRow.id : null;
    }
    """)

    page.mouse.click(setup["emptyCorner"]["x"], setup["emptyCorner"]["y"])
    page.wait_for_timeout(150)
    result = js(page, """
    () => {
      const store = window.dycadApp.store;
      const tab = store.tabs.find(t => t.type === '3d');
      const filtersSection = document.querySelector('#right-panel [data-panel-id="filters"]');
      return {
        selectedCatalogRow: tab.selectedCatalogRow,
        panelHtml: document.getElementById('properties-body').innerHTML,
        filtersCollapsedClass: filtersSection.classList.contains('collapsed'),
        localStorageCollapsed: localStorage.getItem('dycad-panel-filters-collapsed'),
      };
    }
    """)
    problems = []
    if selectedAfterPartClick != setup["partId"]:
        problems.append(f"setup problem: the first real click didn't select the part, got {selectedAfterPartClick!r}")
    if result["selectedCatalogRow"] is not None:
        problems.append(f"expected clicking empty canvas space to clear tab.selectedCatalogRow, got {result['selectedCatalogRow']}")
    if "RegrEmptyClickTarget" in result["panelHtml"] or "no part selected" not in result["panelHtml"] or "Filters" not in result["panelHtml"]:
        problems.append(f"expected the Properties panel to switch to the 3D 'no part selected... Filters panel above' hint, got: {result['panelHtml'][:300]!r}")
    if result["filtersCollapsedClass"] or result["localStorageCollapsed"] != "false":
        problems.append(f"expected the empty click to re-expand the (manually collapsed) Filters panel and persist that, got {result}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Clicking empty 3D canvas space (a genuine mouse click, not a debug hook) deselects the part, switches the Properties panel to the 3D-specific hint pointing at the Filters panel, and re-expands that panel if it had been collapsed"


def check_view_display_filters_moved_to_filters_panel(page):
    """Regression guard, direct follow-up: "Move the view filter checkboxes such as
    connectors, streams, data, types, description, attributes, keys, show simulation
    values (rename to show left badge), show script badge (rename to show right
    badge) that are currently below properties to the newly created filters group."
    Covers: (1) the 9 fields render inside #view-display-filters-body (the Filters
    panel), not inside #properties-body, with the two renamed labels; (2) they render
    there even while a NODE is selected (unlike before the move, when they only
    showed once nothing was selected) -- a real behavior improvement, not just a
    relocation; (3) they're genuinely gone from Properties' own view-settings display
    (renderViewProperties keeps only Id/Name/View Type/Margin/Spacing/Spacing
    Direction/Connector Routing/Stream Connector Routing); (4) toggling one there
    still actually writes view.chkShowXxx (the move didn't silently break the wiring);
    (5) the whole #view-display-filters-wrap hides for a non-canvas tab (3D)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      app.render();
      await new Promise(r => setTimeout(r, 60));
      const view = store.findView(homeTab.viewId);
      const out = {};

      const filtersHtml = document.getElementById('view-display-filters-body').innerHTML;
      const propertiesHtml = document.getElementById('properties-body').innerHTML;
      out.filtersHasConnectors = filtersHtml.includes('>Connectors<');
      out.filtersHasLeftBadge = filtersHtml.includes('>Show Left Badge<');
      out.filtersHasRightBadge = filtersHtml.includes('>Show Right Badge<');
      out.propertiesLacksConnectors = !propertiesHtml.includes('>Connectors<');
      out.propertiesHasId = propertiesHtml.includes('>Id<');
      out.propertiesHasRouting = propertiesHtml.includes('>Connector Routing<');
      out.wrapHiddenBefore = document.getElementById('view-display-filters-wrap').classList.contains('hidden');

      // select a node -- the 9 fields should STILL show in Filters (independent of
      // selection), while Properties switches away to the node's own fields
      const part = store.createPart({ type: 'BusinessFunction', label: 'RegrViewFiltersMove', model: store.defaultModel, streams: [] });
      const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x: 40, y: 40 });
      homeTab.selection = new Set([vm.id]);
      app.render();
      await new Promise(r => setTimeout(r, 60));
      out.filtersStillShownWithNodeSelected = document.getElementById('view-display-filters-body').innerHTML.includes('>Connectors<');
      out.propertiesShowsNodeNotView = document.getElementById('properties-body').innerHTML.includes('RegrViewFiltersMove');
      homeTab.selection = new Set();

      // toggling actually still writes to the view
      app.render();
      await new Promise(r => setTimeout(r, 60));
      const streamsCb = [...document.querySelectorAll('#view-display-filters-body .prop-row.checkbox label')].find(l => l.textContent === 'Streams')?.previousElementSibling;
      const before = view.chkShowStreamType;
      streamsCb.checked = !before;
      streamsCb.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      out.toggleWorked = view.chkShowStreamType === !before;

      // hidden on a non-canvas (3D) tab
      app.openOrSwitch3DView();
      await new Promise(r => setTimeout(r, 400));
      out.wrapHiddenOn3D = document.getElementById('view-display-filters-wrap').classList.contains('hidden');

      return out;
    }
    """)
    problems = []
    if not result["filtersHasConnectors"] or not result["filtersHasLeftBadge"] or not result["filtersHasRightBadge"]:
        problems.append(f"expected the Filters panel to include Connectors and the two renamed labels (Show Left Badge/Show Right Badge), got {result}")
    if not result["propertiesLacksConnectors"]:
        problems.append("expected 'Connectors' (and the other 8 moved fields) to be GONE from the Properties panel's own view settings")
    if not result["propertiesHasId"] or not result["propertiesHasRouting"]:
        problems.append(f"expected Properties to still show the fields that DIDN'T move (Id, Connector Routing, ...), got {result}")
    if result["wrapHiddenBefore"]:
        problems.append("expected #view-display-filters-wrap visible on a canvas tab with nothing selected")
    if not result["filtersStillShownWithNodeSelected"]:
        problems.append("expected the Filters panel's view-display fields to keep showing even while a node is selected (independent of selection state)")
    if not result["propertiesShowsNodeNotView"]:
        problems.append("expected Properties to switch to the selected node's own fields once one is selected")
    if not result["toggleWorked"]:
        problems.append("expected toggling 'Streams' in the Filters panel to actually flip view.chkShowStreamType")
    if not result["wrapHiddenOn3D"]:
        problems.append("expected #view-display-filters-wrap to hide on a non-canvas (3D) tab")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "The 9 view-display toggles (Connectors/Streams/Data/Types/Description/Attributes/Keys/Show Left Badge/Show Right Badge) now render in the Filters panel independent of node selection, are gone from Properties' own view settings (which keeps the rest), still write to the view when toggled, and hide on non-canvas tabs"


def check_filters_properties_alignment_and_row_spacing(page):
    """Regression guard, direct follow-up: "align view filter panel values to same
    column as property values. ... In property and filter panels reduce vertical
    gaps between rows." Covers: (1) a Filters row's own value control (e.g. the
    Stream filter button) starts at the SAME x pixel position as a Properties row's
    own value control (e.g. the Id input) -- proving the column alignment survives
    each row's differently-long label text ("Stream" vs "View Scope" vs "Id"), not
    just that they happen to look similar; (2) .prop-row's own computed margin-bottom
    dropped from the old 8px to a tighter 4px, in BOTH panels; (3) a dialog's own
    .prop-row (higher-specificity 12px override) is genuinely UNAFFECTED by the
    tightened base rule -- this was meant to only apply to the two side panels."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      app.render();
      await new Promise(r => setTimeout(r, 60));

      const streamBtn = document.getElementById('stream-filter-btn');
      const idInput = document.getElementById('sf-view-id');
      const out = {};
      out.streamLeft = Math.round(streamBtn.getBoundingClientRect().left);
      out.idLeft = idInput ? Math.round(idInput.getBoundingClientRect().left) : null;

      out.filtersRowMarginBottom = getComputedStyle(document.getElementById('stream-filter-group')).marginBottom;
      out.propertiesRowMarginBottom = getComputedStyle(document.querySelector('#properties-body .prop-row')).marginBottom;

      app.promptRemap(homeTab);
      await new Promise(r => setTimeout(r, 60));
      const modalPropRow = document.querySelector('.modal-overlay .prop-row');
      out.modalRowMarginBottom = modalPropRow ? getComputedStyle(modalPropRow).marginBottom : null;
      document.querySelector('.modal-overlay .cancel')?.click();

      return out;
    }
    """)
    problems = []
    if result["idLeft"] is None:
        problems.append("test fixture problem: couldn't find a Properties panel input to compare against")
    elif abs(result["streamLeft"] - result["idLeft"]) > 1:
        problems.append(f"expected the Filters panel's Stream button and the Properties panel's Id input to start at the same x position (column-aligned), got streamLeft={result['streamLeft']} idLeft={result['idLeft']}")
    if result["filtersRowMarginBottom"] != "4px":
        problems.append(f"expected the Filters panel's own row spacing to be 4px, got {result['filtersRowMarginBottom']}")
    if result["propertiesRowMarginBottom"] != "4px":
        problems.append(f"expected the Properties panel's own row spacing to be 4px, got {result['propertiesRowMarginBottom']}")
    if result["modalRowMarginBottom"] != "12px":
        problems.append(f"expected a dialog's own .prop-row spacing to stay at its original 12px (unaffected by the side panels' tightened spacing), got {result['modalRowMarginBottom']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "The Filters panel's own value controls now align to the same column as the Properties panel's, both panels' row spacing tightened to 4px, and a dialog's own .prop-row spacing (12px) stayed untouched"


def check_view3d_node_context_menu(page):
    """Regression guard for the 3D node right-click context menu's Filter to Stream
    quick filter. (Its former Connector Type submenu moved to the toolbar's own
    Connector Type filter — see check_view3d_connector_type_toolbar_filter — matching
    Stream/Type/Section's existing dropdown pattern rather than being buried here.)
    Filter to Stream used to be a single combined "Filter to Streams: S1, S2" item that
    always selected every stream a multi-stream part carried at once — reported directly:
    "if the stream has multiple I can't select one or the other." Now each stream the
    part carries gets its own clickable item (plus an "All of the above" item when there
    is more than one), so this specifically verifies picking ONE stream out of several
    actually narrows to just that one (not the old lump-everything-together behavior),
    and that picking a different single stream afterward SWITCHES rather than stacking.
    Uses genuine page.mouse.click(..., button='right') events, positioned via
    debugGetScreenPosition."""
    setup = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const a = store.createPart({ type: 'GeneralActor', label: 'CtxSource', model: store.defaultModel, streams: ['S1', 'S2'] });
      const b = store.createPart({ type: 'BusinessCapability', label: 'CtxRel', model: store.defaultModel, streams: ['S1'] });
      store.createConnector({ from: a.id, to: b.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 250));
      const pos = view3d.debugGetScreenPosition(tab.id, a.id);
      return { pos };
    }
    """)
    if not setup["pos"]:
        return False, f"debugGetScreenPosition couldn't find the source part on screen: {setup}"

    x, y = setup["pos"]["x"], setup["pos"]["y"]
    page.mouse.click(x, y, button="right")
    page.wait_for_timeout(200)
    menu1 = js(page, "async () => [...document.querySelectorAll('.view3d-context-menu .v3d-ctx-item')].map(e => e.textContent.trim())")

    # Pick S1 alone.
    js(page, "async () => { [...document.querySelectorAll('.view3d-context-menu .v3d-ctx-item')].find(el => el.textContent.trim() === 'S1')?.click(); }")
    page.wait_for_timeout(150)
    afterS1Only = js(page, "async () => window.dycadApp.store.tabs.find(t => t.type === '3d').activeStreams")

    # Pick S2 alone -- must SWITCH to just S2, not add to S1.
    page.mouse.click(x, y, button="right")
    page.wait_for_timeout(200)
    js(page, "async () => { [...document.querySelectorAll('.view3d-context-menu .v3d-ctx-item')].find(el => el.textContent.trim() === 'S2')?.click(); }")
    page.wait_for_timeout(150)
    afterS2Only = js(page, "async () => window.dycadApp.store.tabs.find(t => t.type === '3d').activeStreams")

    # Pick "All of the above" -- restores both streams.
    page.mouse.click(x, y, button="right")
    page.wait_for_timeout(200)
    js(page, "async () => { [...document.querySelectorAll('.view3d-context-menu .v3d-ctx-item')].find(el => el.textContent.includes('All of the above'))?.click(); }")
    page.wait_for_timeout(150)
    afterStreamFilter = js(page, "async () => window.dycadApp.store.tabs.find(t => t.type === '3d').activeStreams")

    problems = []
    if not any(t == "S1" for t in menu1):
        problems.append(f"expected the right-click menu to offer a standalone 'S1' stream item, got {menu1}")
    if not any(t == "S2" for t in menu1):
        problems.append(f"expected the right-click menu to offer a standalone 'S2' stream item, got {menu1}")
    if not any("All of the above" in t for t in menu1):
        problems.append(f"expected an 'All of the above' item for a multi-stream part, got {menu1}")
    if any("Connector Type" in t for t in menu1):
        problems.append(f"expected the Connector Type submenu to be gone from here (moved to the toolbar filter), got {menu1}")
    if afterS1Only != ["S1"]:
        problems.append(f"expected clicking the standalone 'S1' item to set tab.activeStreams to exactly ['S1'] -- not both of the part's streams -- got {afterS1Only}")
    if afterS2Only != ["S2"]:
        problems.append(f"expected clicking the standalone 'S2' item to SWITCH tab.activeStreams to exactly ['S2'], not stack onto S1, got {afterS2Only}")
    if afterStreamFilter != ["S1", "S2"]:
        problems.append(f"expected clicking 'All of the above' to set tab.activeStreams to the part's own streams ['S1','S2'], got {afterStreamFilter}")
    if problems:
        return False, "; ".join(problems) + f" (menu1: {menu1})"
    return True, "the 3D node right-click context menu offers a per-stream Filter to Stream item (picking one stream out of several genuinely narrows to just that one, and switches rather than stacking), with Connector Type no longer duplicated here"


def check_view3d_view_scope_filter(page):
    """Regression guard for the 3D View's "View Scope" toolbar picker — reported
    directly: "add the ability for 3d view to show data based on an existing view."
    Narrows the whole 3D scene down to exactly what ONE chosen 2D view has placed (its
    own part AND connector viewMembers) — not merely "both endpoints happen to also be
    visible" the way ordinary connector visibility works, an exact mirror of that
    view's own 2D content. Fixture: 4 same-type parts + 2 connectors. P1/P2/P4 (plus
    the P1-P2 connector) are placed on 'SceneA' via real viewMembers; P3 only on a
    separate 'SceneB'; a SECOND connector (P2-P4) exists in the document and BOTH its
    endpoints are placed on SceneA, but the connector itself has no connector-
    viewMember there — the one case that actually distinguishes "explicitly placed on
    this view" from "both endpoints happen to also be visible," which ordinary
    connector-line visibility elsewhere in this file relies on. Verifies: the <select>
    lists "All (whole document)" plus every real view; unscoped (default) shows all 4
    parts; scoping to SceneA narrows to exactly its own 3 parts (not P3, even though
    it's the same type/section/stream) and exactly 1 connector (P1-P2 only — NOT the
    P2-P4 connector, despite both its ends being visible); and switching back to "All"
    restores all 4 — proving the scope is a genuine toggle, not a one-way filter."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');

      const viewA = store.addView('SceneA_' + Date.now());
      const viewB = store.addView('SceneB_' + Date.now());
      const p1 = store.createPart({ type: 'GeneralActor', label: 'P1', model: store.defaultModel, streams: [] });
      const p2 = store.createPart({ type: 'GeneralActor', label: 'P2', model: store.defaultModel, streams: [] });
      const p3 = store.createPart({ type: 'GeneralActor', label: 'P3', model: store.defaultModel, streams: [] });
      const p4 = store.createPart({ type: 'GeneralActor', label: 'P4', model: store.defaultModel, streams: [] });
      const conn12 = store.createConnector({ from: p1.id, to: p2.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      // Exists in the document, both ends placed on SceneA below, but deliberately
      // NEVER given its own connector-viewMember there.
      store.createConnector({ from: p2.id, to: p4.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      const vm1 = store.createViewMember({ view: viewA.id, objectType: 'part', objectId: p1.id, x: 0, y: 0 });
      const vm2 = store.createViewMember({ view: viewA.id, objectType: 'part', objectId: p2.id, x: 200, y: 0 });
      store.createViewMember({ view: viewA.id, objectType: 'part', objectId: p4.id, x: 400, y: 0 });
      store.createViewMember({ view: viewA.id, objectType: 'connector', objectId: conn12.id, fromVmId: vm1.id, toVmId: vm2.id });
      store.createViewMember({ view: viewB.id, objectType: 'part', objectId: p3.id, x: 0, y: 0 });

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 250));
      const optionValues = [...document.getElementById('view3d-scope-select').options].map(o => o.value);
      const infoUnscoped = view3d.getDebugSceneInfo(tab.id);

      const sel = document.getElementById('view3d-scope-select');
      sel.value = viewA.id;
      sel.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 250));
      const infoScopedA = view3d.getDebugSceneInfo(tab.id);
      const scopedPartIds = infoScopedA.types.GeneralActor ? Object.keys(infoScopedA.types.GeneralActor.positions) : [];

      sel.value = '';
      sel.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 250));
      const infoUnscopedAgain = view3d.getDebugSceneInfo(tab.id);

      return {
        optionValues, includesA: optionValues.includes(viewA.id), includesB: optionValues.includes(viewB.id),
        unscopedCount: infoUnscoped.types.GeneralActor.count,
        scopedACount: infoScopedA.types.GeneralActor ? infoScopedA.types.GeneralActor.count : 0,
        scopedAConnCount: infoScopedA.connectorCount,
        scopedPartIds, p1: p1.id, p2: p2.id, p3: p3.id, p4: p4.id,
        unscopedAgainCount: infoUnscopedAgain.types.GeneralActor.count,
      };
    }
    """)
    r = result
    problems = []
    if "" not in r["optionValues"]:
        problems.append(f"expected the View Scope <select> to include an 'All (whole document)' option (value ''), got {r['optionValues']}")
    if not r["includesA"] or not r["includesB"]:
        problems.append(f"expected the View Scope <select> to list both real views, got {r['optionValues']}")
    if r["unscopedCount"] != 4:
        problems.append(f"expected all 4 parts visible unscoped (default), got {r['unscopedCount']}")
    if r["scopedACount"] != 3:
        problems.append(f"expected exactly 3 parts visible scoped to SceneA (only what's actually placed there), got {r['scopedACount']}")
    if sorted(r["scopedPartIds"]) != sorted([r["p1"], r["p2"], r["p4"]]):
        problems.append(f"expected scoping to SceneA to show exactly P1+P2+P4 (not P3, even though it's the same type), got {r['scopedPartIds']}")
    if r["scopedAConnCount"] != 1:
        problems.append(f"expected exactly 1 connector visible scoped to SceneA (P1-P2, the one actually PLACED there) -- the P2-P4 connector must NOT show even though both its ends are visible, since it was never given its own connector-viewMember on SceneA, got {r['scopedAConnCount']}")
    if r["unscopedAgainCount"] != 4:
        problems.append(f"expected switching back to 'All' to restore all 4 parts, got {r['unscopedAgainCount']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {r})"
    return True, "the 3D View's View Scope picker lists every real view, and narrows the scene down to exactly one view's own placed parts+connectors (not just anything of the same type), toggling cleanly back to the whole document"


def check_view3d_connector_type_toolbar_filter(page):
    """Regression guard: the 3D View's Connector Type filter (which connectorType(s) --
    'c' Connectors, 's' Streams, 'd' Data -- draw at all) moved from a right-click-only quick
    filter to its own toolbar dropdown, matching Stream/Type/Section's existing
    Select-All/Exclude-All + checkbox-list pattern. Reported directly: "let's make that
    user selectable for the view same as the view filters already existing." Uses real
    button clicks and checkbox change events against the toolbar's #connector-type-
    filter-btn, verifying both tab.activeConnectorTypes and the actual visible
    connectorCount (view3d.js's getDebugSceneInfo) change accordingly -- and that the
    filter button is disabled outside a 3D tab, since it has no meaning for canvas tabs
    (the 2D canvas already has its own per-VIEW chkShowConnectorType/chkShowStreamType
    checkboxes for this)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const a = store.createPart({ type: 'GeneralActor', label: 'CTA', model: store.defaultModel, streams: [] });
      const b = store.createPart({ type: 'BusinessCapability', label: 'CTB', model: store.defaultModel, streams: [] });
      store.createConnector({ from: a.id, to: b.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      store.createConnector({ from: a.id, to: b.id, model: store.defaultModel, connectorType: 's', relationship: 'Stream', streams: ['S1'] });

      const canvasTab = store.tabs.find(t => t.type === 'canvas') || app.createCanvasTab(store.doc.views[0]);
      app.switchToTab(canvasTab.id);
      app.render();
      await new Promise(r => setTimeout(r, 60));
      const disabledOnCanvas = document.getElementById('connector-type-filter-btn').disabled;

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 250));
      const disabledOn3D = document.getElementById('connector-type-filter-btn').disabled;
      const initialCount = view3d.getDebugSceneInfo(tab.id).connectorCount;

      document.getElementById('connector-type-filter-btn').click();
      await new Promise(r => setTimeout(r, 60));
      const selectAllCb = document.getElementById('connector-type-select-all');
      const initiallyChecked = selectAllCb ? selectAllCb.checked : null;
      const itemCheckboxes = () => [...document.querySelectorAll('#connector-type-filter-menu .dd-item-list input[type=\\"checkbox\\"]')];
      const connectorsOnlyCb = itemCheckboxes().find(cb => cb.value === 'c');
      connectorsOnlyCb.checked = false;
      connectorsOnlyCb.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 100));
      const afterConnectorsOnly = { activeConnectorTypes: tab.activeConnectorTypes, connectorCount: view3d.getDebugSceneInfo(tab.id).connectorCount };

      document.getElementById('connector-type-filter-btn').click();
      await new Promise(r => setTimeout(r, 60));
      document.getElementById('connector-type-select-all').checked = false;
      document.getElementById('connector-type-select-all').dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 100));
      const afterExcludeAll = { activeConnectorTypes: tab.activeConnectorTypes, connectorCount: view3d.getDebugSceneInfo(tab.id).connectorCount };

      document.getElementById('connector-type-filter-btn').click();
      await new Promise(r => setTimeout(r, 60));
      document.getElementById('connector-type-select-all').checked = true;
      document.getElementById('connector-type-select-all').dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 100));
      const afterSelectAll = { activeConnectorTypes: tab.activeConnectorTypes, connectorCount: view3d.getDebugSceneInfo(tab.id).connectorCount };

      return { disabledOnCanvas, disabledOn3D, initialCount, initiallyChecked, afterConnectorsOnly, afterExcludeAll, afterSelectAll };
    }
    """)
    problems = []
    if not result["disabledOnCanvas"]:
        problems.append("expected the Connector Type filter button to be disabled on a canvas tab (3D-only concept)")
    if result["disabledOn3D"]:
        problems.append("expected the Connector Type filter button to be enabled on the 3D tab")
    if result["initialCount"] != 2:
        problems.append(f"expected both connectors visible with no filter set, got {result['initialCount']}")
    if not result["initiallyChecked"]:
        problems.append("expected the Select All checkbox to start checked (unfiltered)")
    ac = result["afterConnectorsOnly"]
    # activeConnectorTypes also includes 'd' (Data Modeling) here since it's a real,
    # checked-by-default toolbar item regardless of whether this fixture has any 'd'
    # connectors -- the actually-meaningful assertions are that 'c' got excluded and
    # 's' stayed included, and that the SCENE's visible connector count (this fixture
    # has none of type 'd') reflects only the real 'c' connector disappearing.
    if "c" in ac["activeConnectorTypes"] or "s" not in ac["activeConnectorTypes"] or ac["connectorCount"] != 1:
        problems.append(f"expected unchecking 'Connectors (c)' to exclude 'c', keep 's', and leave only the 's' connector visible, got {ac}")
    ax = result["afterExcludeAll"]
    if ax["activeConnectorTypes"] != [] or ax["connectorCount"] != 0:
        problems.append(f"expected Exclude All to set tab.activeConnectorTypes to [] and hide every connector line, got {ax}")
    asel = result["afterSelectAll"]
    if asel["activeConnectorTypes"] is not None or asel["connectorCount"] != 2:
        problems.append(f"expected Select All to reset tab.activeConnectorTypes to null (unfiltered) and restore both connectors, got {asel}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "the 3D View's Connector Type filter is a real toolbar dropdown (Select All/Exclude All + per-type checkboxes), disabled outside a 3D tab, and genuinely narrows which connectorType(s) draw"


def check_view3d_connector_direction_markers(page):
    """Regression guard for 3D connector direction indicators (view3d.js's per-
    relationship line/marker grouping) — reported directly: "implement direction
    indicators for the 3D lines ideally matching line end settings, and line
    characteristics as well." Verifies, via getDebugSceneInfo's connectorGroups/
    connectorMarkers, that THREE DISTINCT relationships (custom.json's
    relationshipStyles) each render distinctly: Composition (dash:[2,5], a black
    diamond marker at the FROM end, none at TO) — the two-endpoints case;
    Association (dash:[], an open/wireframe cone at the TO end, none at FROM) — solid
    line + open marker; Realization (dash:[3,2], a white-filled cone at the TO end) —
    dashed line + filled marker. Confirms line color matches each relationship's own
    stroke, dashed vs. solid matches its own dash array, and marker family/color/
    wireframe matches its own lineEnds entries — not just that SOMETHING renders."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const a = store.createPart({ type: 'GeneralActor', label: 'MkA', model: store.defaultModel, streams: [] });
      const b = store.createPart({ type: 'BusinessCapability', label: 'MkB', model: store.defaultModel, streams: [] });
      const c = store.createPart({ type: 'BusinessProcess', label: 'MkC', model: store.defaultModel, streams: [] });
      const d = store.createPart({ type: 'BusinessFunction', label: 'MkD', model: store.defaultModel, streams: [] });
      store.createConnector({ from: a.id, to: b.id, model: store.defaultModel, connectorType: 'c', relationship: 'Composition', streams: [] });
      store.createConnector({ from: b.id, to: c.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      store.createConnector({ from: c.id, to: d.id, model: store.defaultModel, connectorType: 'c', relationship: 'Realization', streams: [] });

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 300));
      const info = view3d.getDebugSceneInfo(tab.id);
      return { groups: info.connectorGroups, markers: info.connectorMarkers };
    }
    """)
    groups, markers = result["groups"], result["markers"]
    problems = []

    comp = groups.get("Composition")
    if not comp or comp["count"] != 1 or not comp["dashed"] or comp["color"].lower() != "#000000":
        problems.append(f"expected Composition's line: 1 connector, dashed (dash:[2,5]), black stroke, got {comp}")
    compFrom = markers.get("Composition|from")
    if not compFrom or compFrom["family"] != "diamond" or compFrom["color"].lower() != "#000000" or compFrom["wireframe"]:
        problems.append(f"expected Composition's FROM-end marker: a solid black diamond (diamondSmallBlack), got {compFrom}")
    if "Composition|to" in markers:
        problems.append(f"expected Composition to have NO marker at its TO end (toLineEndSettingType is 'none'), got {markers.get('Composition|to')}")

    assoc = groups.get("Association")
    if not assoc or assoc["count"] != 1 or assoc["dashed"]:
        problems.append(f"expected Association's line: 1 connector, solid (dash:[]), got {assoc}")
    assocTo = markers.get("Association|to")
    if not assocTo or assocTo["family"] != "cone" or not assocTo["wireframe"]:
        problems.append(f"expected Association's TO-end marker: an open/wireframe cone (openHalfArrowSmall has no fill), got {assocTo}")

    real = groups.get("Realization")
    if not real or real["count"] != 1 or not real["dashed"]:
        problems.append(f"expected Realization's line: 1 connector, dashed (dash:[3,2]), got {real}")
    realTo = markers.get("Realization|to")
    if not realTo or realTo["family"] != "cone" or realTo["wireframe"] or realTo["color"].lower() != "#ffffff":
        problems.append(f"expected Realization's TO-end marker: a SOLID white cone (arrowLargeWhite), got {realTo}")

    if problems:
        return False, "; ".join(problems) + f" (full groups: {groups}, markers: {markers})"
    return True, "3D connector lines/markers are grouped and styled per relationship (stroke color, dash pattern, and a from/to marker shape+fill matching custom.json's relationshipStyles/lineEnds), not one flat undirected line for everything"


def check_view3d_right_click_drag_pins_node(page):
    """Regression guard for right-click-drag repositioning in the 3D View — reported
    directly: "in 3d view can it be supported to right click an object and move it
    around?" Real user right-click-drag fires 'contextmenu' AFTER pointerup (standard
    browser behavior); Playwright/CDP's own mouse.down(button='right') fires it
    prematurely ON mousedown instead (a documented automation quirk, not a real-browser
    behavior), so this dispatches raw PointerEvents + a synthetic 'contextmenu' event
    directly, in the REAL order, rather than driving it through page.mouse -- verified
    against the app's own actual event listeners either way, not a mock.
    Fixture: two same-type, same-(default)-lane parts (A dragged, B left alone). Checks,
    in order: (1) a genuine drag (past CLICK_DRAG_TOLERANCE) sets A's part.pin3D to
    (approximately) the drop position AND suppresses the context menu that would
    otherwise open on a right-click release; (2) A's actual rendered position after the
    resync matches its stored pin3D; (3) B (now the ONLY unpinned part in that lane)
    recentres to a single-item grid (x=0) -- proving the pinned part was excluded from
    lane occupancy, not just visually moved while still holding a grid cell; (4) a plain
    right-click (no movement) on B, a part that was never touched, still opens the
    context menu normally -- proving the drag-vs-click distinction doesn't over-suppress
    unrelated right-clicks."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const a = store.createPart({ type: 'GeneralActor', label: 'DragA', model: store.defaultModel, streams: [] });
      const b = store.createPart({ type: 'GeneralActor', label: 'KeepB', model: store.defaultModel, streams: [] });

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 250));

      const screenPos = view3d.debugGetScreenPosition(tab.id, a.id);
      const canvasEl = document.querySelector('canvas');
      const fire = (type, x, y, button) => canvasEl.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true, pointerId: 1 }));

      fire('pointerdown', screenPos.x, screenPos.y, 2);
      fire('pointermove', screenPos.x + 40, screenPos.y + 20, 2);
      fire('pointermove', screenPos.x + 70, screenPos.y + 35, 2);
      fire('pointerup', screenPos.x + 70, screenPos.y + 35, 2);
      canvasEl.dispatchEvent(new MouseEvent('contextmenu', { clientX: screenPos.x + 70, clientY: screenPos.y + 35, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 150));

      const menuOpenAfterDrag = !!document.querySelector('.view3d-context-menu');
      const partA = store.findPart(a.id);
      const infoAfterDrag = view3d.getDebugSceneInfo(tab.id);
      const renderedA = infoAfterDrag.types.GeneralActor.positions[a.id];
      const renderedB = infoAfterDrag.types.GeneralActor.positions[b.id];

      // Plain right-click (no movement) on B, untouched by the drag -- must still work.
      const screenPosB = view3d.debugGetScreenPosition(tab.id, b.id);
      fire('pointerdown', screenPosB.x, screenPosB.y, 2);
      fire('pointerup', screenPosB.x, screenPosB.y, 2);
      canvasEl.dispatchEvent(new MouseEvent('contextmenu', { clientX: screenPosB.x, clientY: screenPosB.y, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 150));
      const menuTextAfterPlainClick = document.querySelector('.view3d-context-menu')?.textContent || '';

      return {
        pin3D: partA.pin3D, menuOpenAfterDrag, renderedA, renderedB,
        plainClickOpenedMenu: menuTextAfterPlainClick.includes('KeepB'),
      };
    }
    """)
    r = result
    problems = []
    if not r["pin3D"]:
        problems.append(f"expected the dragged part's pin3D to be set after a genuine right-click-drag, got {r['pin3D']}")
    if r["menuOpenAfterDrag"]:
        problems.append("expected the context menu to stay closed after a genuine drag (contextmenu fires on release, same as a plain right-click would, but a real drag must suppress it)")
    if not r["renderedA"] or abs(r["renderedA"]["x"] - r["pin3D"]["x"]) > 1e-3 or abs(r["renderedA"]["y"] - r["pin3D"]["y"]) > 1e-3:
        problems.append(f"expected A's actual rendered position to match its stored pin3D after the resync, got rendered={r['renderedA']} pin3D={r['pin3D']}")
    if not r["renderedB"] or abs(r["renderedB"]["x"]) > 1e-3:
        problems.append(f"expected B (now the only unpinned GeneralActor) to recentre to a single-item grid (x=0), proving the pinned part no longer occupies a grid cell, got {r['renderedB']}")
    if not r["plainClickOpenedMenu"]:
        problems.append("expected a plain right-click (no movement) on an untouched part to still open its context menu -- the drag-vs-click distinction must not over-suppress unrelated right-clicks")
    if problems:
        return False, "; ".join(problems) + f" (full: {r})"
    return True, "right-click-dragging a 3D node sets part.pin3D to the drop position, suppresses the context menu for that genuine drag, renders at exactly the pinned position, excludes it from its type's auto-layout grid (a sibling recentres), and doesn't interfere with a plain right-click elsewhere"


def check_view3d_reset_pinned_positions(page):
    """Regression guard for Advanced > Reset Pinned 3D Positions — reported directly:
    "Create new option somewhere to reset - which clears all 'pinned' new locations."
    Verifies: (1) with nothing pinned, it's a no-op (toast only, no confirm dialog);
    (2) with 2 parts pinned, it shows a confirm dialog naming the exact count; (3)
    Cancel leaves both pin3D values untouched; (4) OK clears BOTH pin3D fields back to
    null in one go and the parts genuinely return to auto-layout positions (re-checked
    via getDebugSceneInfo, not just that pin3D is null)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');

      // (1) No-op case: no pinned parts at all yet.
      app.promptResetPinned3DPositions();
      await new Promise(r => setTimeout(r, 100));
      const noopHadDialog = !!document.querySelector('.modal-box');

      const a = store.createPart({ type: 'GeneralActor', label: 'PinA', model: store.defaultModel, streams: [] });
      const b = store.createPart({ type: 'BusinessCapability', label: 'PinB', model: store.defaultModel, streams: [] });
      a.pin3D = { x: 5, y: 5, z: 5 };
      b.pin3D = { x: -5, y: -5, z: -5 };

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 250));

      // (2)+(3) Cancel leaves pins intact.
      app.promptResetPinned3DPositions();
      await new Promise(r => setTimeout(r, 100));
      const confirmText = document.querySelector('.modal-box')?.textContent || '';
      document.querySelector('.modal-box .cancel')?.click();
      await new Promise(r => setTimeout(r, 100));
      const afterCancel = { aPinned: !!store.findPart(a.id).pin3D, bPinned: !!store.findPart(b.id).pin3D };

      // (4) OK clears both.
      app.promptResetPinned3DPositions();
      await new Promise(r => setTimeout(r, 100));
      document.querySelector('.modal-box .primary')?.click();
      await new Promise(r => setTimeout(r, 150));
      const afterOk = { aPinned: !!store.findPart(a.id).pin3D, bPinned: !!store.findPart(b.id).pin3D };
      const info = view3d.getDebugSceneInfo(tab.id);
      const posA = info.types.GeneralActor?.positions?.[a.id];
      const posB = info.types.BusinessCapability?.positions?.[b.id];

      return { noopHadDialog, confirmText, afterCancel, afterOk, posA, posB };
    }
    """)
    r = result
    problems = []
    if r["noopHadDialog"]:
        problems.append("expected NO confirm dialog when nothing is pinned (should just toast)")
    if "2" not in r["confirmText"]:
        problems.append(f"expected the confirm dialog to mention the exact pinned count (2), got: {r['confirmText']!r}")
    if not r["afterCancel"]["aPinned"] or not r["afterCancel"]["bPinned"]:
        problems.append(f"expected Cancel to leave both pins untouched, got {r['afterCancel']}")
    if r["afterOk"]["aPinned"] or r["afterOk"]["bPinned"]:
        problems.append(f"expected OK to clear BOTH pins back to null, got {r['afterOk']}")
    if not r["posA"] or (abs(r["posA"]["x"] - 5) < 1e-3 and abs(r["posA"]["y"] - 5) < 1e-3):
        problems.append(f"expected A to genuinely return to an auto-layout position (not still at its old pinned (5,5,5)), got {r['posA']}")
    if not r["posB"] or (abs(r["posB"]["x"] + 5) < 1e-3 and abs(r["posB"]["y"] + 5) < 1e-3):
        problems.append(f"expected B to genuinely return to an auto-layout position (not still at its old pinned (-5,-5,-5)), got {r['posB']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {r})"
    return True, "Advanced > Reset Pinned 3D Positions is a no-op with nothing pinned, confirms with the exact count otherwise, Cancel leaves pins untouched, and OK clears every pin3D back to null with parts genuinely returning to auto-layout"


def check_view3d_highlight_type_picker(page):
    """Regression guard for the 3D View's Highlight picker — reported directly: "add a
    'highlight' option, perhaps a dropdown list with checkbox... for element type in
    use, allowing user to enable for example highlighting the businessfunction parts."
    A toolbar checkbox-dropdown (#highlight-type-filter-btn/-menu, tab.highlightedTypes)
    like Type/Connector Type, listing every element type actually present in the
    document. Purely a visual call-out (a wireframe InstancedMesh, one instance per
    matching part) layered on top of the normal scene, NOT a filter — checking a type
    must not hide or otherwise change any OTHER type's own rendering. Verifies: the
    button is disabled on a canvas tab; checking ONE type highlights exactly its own
    parts (right count AND right partIds, not just a count that happens to match);
    checking a SECOND type on top adds to the highlight rather than replacing it;
    unchecking both clears the highlight mesh entirely; and the button's own label
    text reflects None / a single type's title / "N types" as the selection changes."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const a1 = store.createPart({ type: 'GeneralActor', label: 'A1', model: store.defaultModel, streams: [] });
      const a2 = store.createPart({ type: 'GeneralActor', label: 'A2', model: store.defaultModel, streams: [] });
      const a3 = store.createPart({ type: 'GeneralActor', label: 'A3', model: store.defaultModel, streams: [] });
      const b1 = store.createPart({ type: 'BusinessCapability', label: 'B1', model: store.defaultModel, streams: [] });
      const b2 = store.createPart({ type: 'BusinessCapability', label: 'B2', model: store.defaultModel, streams: [] });

      const canvasTab = store.tabs.find(t => t.type === 'canvas') || app.createCanvasTab(store.doc.views[0]);
      app.switchToTab(canvasTab.id);
      app.render();
      await new Promise(r => setTimeout(r, 60));
      const disabledOnCanvas = document.getElementById('highlight-type-filter-btn').disabled;

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 250));
      const disabledOn3D = document.getElementById('highlight-type-filter-btn').disabled;
      const labelNone = document.getElementById('highlight-type-filter-btn').textContent;
      const initialHighlight = view3d.getDebugSceneInfo(tab.id).highlight;

      const checkType = (value, checked) => {
        document.getElementById('highlight-type-filter-btn').click();
        const cb = [...document.querySelectorAll('#highlight-type-filter-menu input[type=\"checkbox\"]')].find(c => c.value === value);
        cb.checked = checked;
        cb.dispatchEvent(new Event('change'));
      };

      checkType('GeneralActor', true);
      await new Promise(r => setTimeout(r, 150));
      const afterA = view3d.getDebugSceneInfo(tab.id).highlight;
      const labelA = document.getElementById('highlight-type-filter-btn').textContent;
      const generalActorMeshStillFull = view3d.getDebugSceneInfo(tab.id).types.GeneralActor.count === 3
        && view3d.getDebugSceneInfo(tab.id).types.BusinessCapability.count === 2;

      checkType('BusinessCapability', true);
      await new Promise(r => setTimeout(r, 150));
      const afterBoth = view3d.getDebugSceneInfo(tab.id).highlight;
      const labelBoth = document.getElementById('highlight-type-filter-btn').textContent;

      checkType('GeneralActor', false);
      checkType('BusinessCapability', false);
      await new Promise(r => setTimeout(r, 150));
      const afterNone = view3d.getDebugSceneInfo(tab.id).highlight;

      return {
        disabledOnCanvas, disabledOn3D, labelNone, initialHighlight,
        afterA, labelA, generalActorMeshStillFull,
        afterBoth, labelBoth, afterNone,
        aIds: [a1.id, a2.id, a3.id], bIds: [b1.id, b2.id],
      };
    }
    """)
    r = result
    problems = []
    if not r["disabledOnCanvas"]:
        problems.append("expected the Highlight button to be disabled on a canvas tab (3D-only concept)")
    if r["disabledOn3D"]:
        problems.append("expected the Highlight button to be enabled on the 3D tab")
    if r["labelNone"] != "None":
        problems.append(f"expected the Highlight button to read 'None' with nothing checked, got {r['labelNone']!r}")
    if r["initialHighlight"]["count"] != 0:
        problems.append(f"expected no highlight mesh at all with nothing checked, got {r['initialHighlight']}")
    if sorted(r["afterA"]["partIds"]) != sorted(r["aIds"]):
        problems.append(f"expected checking GeneralActor to highlight exactly its 3 own parts, got {r['afterA']}")
    if not r["generalActorMeshStillFull"]:
        problems.append("expected highlighting to be purely additive -- both types' own InstancedMeshes must still have their full part counts, not be filtered down")
    if r["labelA"] != "General Actor":
        problems.append(f"expected the button label to read the single checked type's own display title ('General Actor'), got {r['labelA']!r}")
    if sorted(r["afterBoth"]["partIds"]) != sorted(r["aIds"] + r["bIds"]):
        problems.append(f"expected checking a SECOND type to ADD to the highlight (all 5 parts), not replace it, got {r['afterBoth']}")
    if r["labelBoth"] != "2 types":
        problems.append(f"expected the button label to read '2 types' with two checked, got {r['labelBoth']!r}")
    if r["afterNone"]["count"] != 0:
        problems.append(f"expected unchecking both types to clear the highlight mesh entirely, got {r['afterNone']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {r})"
    return True, "the 3D View's Highlight picker is disabled outside 3D, lists element types in use, and checking type(s) draws a wireframe box around exactly their own parts -- additively, without disturbing any other type's own rendering -- with a label reflecting the current selection"


def check_view3d_disposed_on_full_document_load(page):
    """Regression guard for a real bug: File > Load / Load Example / Recently Opened all
    replace store.doc by wiping store.tabs directly (this.store.tabs = []) rather than
    closing each tab through App.closeTab — the only path that normally disposes a 3D
    tab's WebGL context/animation loop. An open 3D tab survived that wipe with its render
    loop still running forever in the background (invisible once its own page-<id> DOM
    container gets removed by the next render(), but never actually torn down) — a silent
    WebGL-context leak found after a user reported a previous simulation's markers still
    visibly pulsing (root cause turned out to be a different, correct-by-design case —
    Load SFCCE intentionally merges rather than replacing — but this leak was real and
    worth fixing regardless). Fixed via App.disposeAllOpenView3DTabs(), called before the
    tab wipe in all three load paths. Verified here via a genuine File > Load through the
    real UI (file input + change event, not a direct loadJson() call): view3d.js's own
    module-level `instances` map only ever drops a tab's entry via disposeView3D, so
    getDebugSceneInfo(oldTabId) returning non-null after the load directly proves the old
    instance was never disposed — a more direct signal than intercepting
    requestAnimationFrame globally (whose call timing can't be pinned to one specific
    instance without a race against Playwright's own file-picker boundary)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      app.openOrSwitch3DView();
      const oldTabId = store.tabs.find(t => t.type === '3d').id;
      await new Promise(r => setTimeout(r, 300));
      const hadInstanceBefore = !!view3d.getDebugSceneInfo(oldTabId);

      document.getElementById('file-menu-btn').click();
      await new Promise(r => setTimeout(r, 50));
      document.querySelector('#file-menu .dd-item[data-action="load"]').click();
      return { oldTabId, hadInstanceBefore };
    }
    """)
    page.set_input_files("#load-json-input", "/home/larry/projects/dycad/public/examples/pipeline demo.json")
    page.wait_for_timeout(400)
    after = js(page, f"""
    async () => {{
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      return {{
        instanceStillExistsAfterLoad: !!view3d.getDebugSceneInfo({result["oldTabId"]!r}),
        tabTypesAfterLoad: store.tabs.map(t => t.type),
      }};
    }}
    """)
    problems = []
    if not result["hadInstanceBefore"]:
        problems.append(f"expected the 3D tab to have a real live instance before the load, got {result}")
    if after["instanceStillExistsAfterLoad"]:
        problems.append(f"expected the old 3D tab's instance to be disposed (removed from view3d.js's own instances map) after a full document replace, but it's still there — the render loop is leaking")
    if "3d" in after["tabTypesAfterLoad"]:
        problems.append(f"expected the 3D tab to be gone after a full document replace, got tab types {after['tabTypesAfterLoad']}")
    if problems:
        return False, "; ".join(problems) + f" (result: {result}, after: {after})"
    return True, "a genuine File > Load disposes the open 3D tab's WebGL instance before replacing the document, instead of leaking it"


def check_export_svg_respects_connector_type_checkboxes(page):
    """Regression guard, reported directly: "when user does 'export view as image' both
    types of connectors appear hard coded to show up in image but should only be
    whatever was selected by view checkboxes for connectors or streams." Root cause:
    buildViewSvgString (main.js, used by both Export View as Image's SVG and PNG
    paths) is a SEPARATE, purpose-built renderer from the real on-screen canvas
    (redrawEdges, canvas.js) -- and unlike redrawEdges, it never checked the view's own
    chkShowConnectorType/chkShowStreamType/chkShowDataType toggles (set via the
    view's own property panel, clicking the view background rather than any node/
    connector) at all, always drawing every placed connector regardless of type. Uses
    a DOMParser + `:scope > path` selector to count only the connector paths actually
    drawn as direct children of the root <svg> -- NOT the arrowhead/marker <path>
    elements nested inside <defs><marker>, which are always present regardless of
    which connector types are showing and would otherwise make a naive count wrong.
    Covers all three connectorTypes independently, and confirms turning one off
    doesn't affect the others."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.addView('RegrSvgConnType_' + Date.now(), 'ff');
      view.chkShowStreamType = true; // 'ff' views default this to false -- turn on for this test
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const a = store.createPart({ type: 'BusinessFunction', label: 'RegrSvgCTa', model, streams: [] });
      const b = store.createPart({ type: 'BusinessFunction', label: 'RegrSvgCTb', model, streams: [] });
      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: a.id, x: 40, y: 40 });
      const vmB = store.createViewMember({ view: view.id, objectType: 'part', objectId: b.id, x: 300, y: 40 });
      const mkConn = (connectorType) => {
        const conn = store.createConnector({ from: a.id, to: b.id, connectorType, model, relationship: 'Association' });
        store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: vmA.id, toVmId: vmB.id });
      };
      mkConn('c'); mkConn('s'); mkConn('d');

      const countPaths = () => {
        const svg = app.buildViewSvgString(view).svgString;
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        return doc.documentElement.querySelectorAll(':scope > path').length;
      };

      const out = {};
      out.allThreeOn = countPaths();

      view.chkShowConnectorType = false;
      out.connectorOffCount = countPaths();
      view.chkShowConnectorType = true;

      view.chkShowStreamType = false;
      out.streamOffCount = countPaths();
      view.chkShowStreamType = true;

      view.chkShowDataType = false;
      out.dataOffCount = countPaths();
      view.chkShowDataType = true;

      view.chkShowConnectorType = false;
      view.chkShowStreamType = false;
      view.chkShowDataType = false;
      out.allThreeOff = countPaths();

      return out;
    }
    """)
    problems = []
    if result["allThreeOn"] != 3:
        problems.append(f"expected 3 connector paths (one 'c', one 's', one 'd') with all three checkboxes on, got {result['allThreeOn']}")
    if result["connectorOffCount"] != 2:
        problems.append(f"expected unchecking chkShowConnectorType to drop exactly the 'c' path (3 -> 2), got {result['connectorOffCount']}")
    if result["streamOffCount"] != 2:
        problems.append(f"expected unchecking chkShowStreamType to drop exactly the 's' path (3 -> 2), got {result['streamOffCount']}")
    if result["dataOffCount"] != 2:
        problems.append(f"expected unchecking chkShowDataType to drop exactly the 'd' path (3 -> 2), got {result['dataOffCount']}")
    if result["allThreeOff"] != 0:
        problems.append(f"expected unchecking all three to leave zero connector paths, got {result['allThreeOff']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Export View as Image's SVG builder now respects the view's own chkShowConnectorType/chkShowStreamType/chkShowDataType checkboxes exactly like the real on-screen canvas does, instead of always drawing every connector type regardless"


def check_export_svg_respects_connector_routing(page):
    """Regression guard, reported directly: "view options 'Connector Routing' and
    'Stream Connector Routing' are ignored when exporting view to image." Root cause:
    buildViewSvgString's connector-drawing loop was a separate, hand-rolled path
    builder that always drew a 'c' connector as a fixed gentle curve and anything else
    as a plain straight line, never once reading view.routingStyle/routingStyleStream
    or calling computeRoutedPath (routing.js) — the same obstacle-avoiding router
    drawEdge (canvas.js) already uses for the real on-screen canvas. Covers: (1) with an
    obstacle node sitting directly between two others, routingStyle:'manhattan' on the
    'c' connector produces a multi-point elbow path in the EXPORTED svg (not a straight
    2-point line or the default curve), with the same point count as the real on-screen
    render of the identical setup; (2) independently, routingStyleStream:'direct' on
    the 's' connector between the SAME two endpoints also detours around the obstacle
    in the export, proving the two settings are read independently per connectorType,
    matching drawEdge's own per-type lookup; (3) routingStyle:'straight' forces a plain
    2-point line for a 'c' connector in the export too, overriding its usual default
    curve; (4) with no obstacle and the default routing style, a 'c' connector still
    exports as the classic quadratic curve ('Q' command) — the pre-existing look is
    preserved when there's nothing to route around."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.addView('RegrSvgRouting_' + Date.now(), 'ff');
      view.chkShowStreamType = true; // 'ff' views default this to false
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const a = store.createPart({ type: 'BusinessFunction', label: 'RegrSvgRouteA', model, streams: [] });
      const blocker = store.createPart({ type: 'BusinessProcess', label: 'RegrSvgRouteBlocker', model, streams: [] });
      const b = store.createPart({ type: 'ApplicationCapability', label: 'RegrSvgRouteB', model, streams: [] });
      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: a.id, x: 60, y: 60 });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: blocker.id, x: 260, y: 60 });
      const vmB = store.createViewMember({ view: view.id, objectType: 'part', objectId: b.id, x: 460, y: 60 });
      const connC = store.createConnector({ from: a.id, to: b.id, connectorType: 'c', model, relationship: 'Association' });
      const connS = store.createConnector({ from: a.id, to: b.id, connectorType: 's', model, relationship: 'Association' });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: connC.id, fromVmId: vmA.id, toVmId: vmB.id });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: connS.id, fromVmId: vmA.id, toVmId: vmB.id });

      const pointCount = (d) => (d.match(/[ML]/g) || []).length;
      const exportPaths = () => {
        const svg = app.buildViewSvgString(view).svgString;
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        return [...doc.documentElement.querySelectorAll(':scope > path')].map(p => p.getAttribute('d'));
      };

      const out = {};

      // 1) manhattan 'c' routing detours around the obstacle in the export, matching
      // the real on-screen render's own point count.
      view.routingStyle = 'manhattan';
      view.routingStyleStream = 'default';
      app.render();
      await new Promise(r => setTimeout(r, 60));
      const onScreenC = document.querySelector('.edge-layer path:not(.edge-hit)').getAttribute('d');
      const [exportedC1] = exportPaths();
      out.manhattanCPointCountMatch = pointCount(exportedC1) === pointCount(onScreenC);
      out.manhattanCPointCount = pointCount(exportedC1);

      // 2) independently, 's' direct routing also detours -- proves the two fields
      // (routingStyle vs routingStyleStream) are read independently per connectorType.
      view.routingStyle = 'default';
      view.routingStyleStream = 'direct';
      const [, exportedS] = exportPaths();
      out.directSPointCount = pointCount(exportedS);

      // 3) 'straight' forces a plain 2-point line for 'c', overriding its usual curve.
      view.routingStyle = 'straight';
      view.routingStyleStream = 'default';
      const [exportedCStraight] = exportPaths();
      out.straightCIsPlainLine = /^M [\\d.]+ [\\d.]+ L [\\d.]+ [\\d.]+$/.test(exportedCStraight.trim());

      // 4) default style, no obstacle -- classic curve preserved.
      const view2 = store.addView('RegrSvgRouteCurve_' + Date.now(), 'ff');
      const tab2 = app.createCanvasTab(view2);
      app.switchToTab(tab2.id);
      const a2 = store.createPart({ type: 'BusinessFunction', label: 'RegrSvgCurveA', model, streams: [] });
      const b2 = store.createPart({ type: 'ApplicationCapability', label: 'RegrSvgCurveB', model, streams: [] });
      const vmA2 = store.createViewMember({ view: view2.id, objectType: 'part', objectId: a2.id, x: 60, y: 60 });
      const vmB2 = store.createViewMember({ view: view2.id, objectType: 'part', objectId: b2.id, x: 300, y: 60 });
      const connC2 = store.createConnector({ from: a2.id, to: b2.id, connectorType: 'c', model, relationship: 'Association' });
      store.createViewMember({ view: view2.id, objectType: 'connector', objectId: connC2.id, fromVmId: vmA2.id, toVmId: vmB2.id });
      const svg2 = app.buildViewSvgString(view2).svgString;
      const doc2 = new DOMParser().parseFromString(svg2, 'image/svg+xml');
      const curvePath = doc2.documentElement.querySelector(':scope > path').getAttribute('d');
      out.defaultStillCurved = curvePath.includes('Q ');

      return out;
    }
    """)
    problems = []
    if result["manhattanCPointCount"] < 3:
        problems.append(f"expected the exported 'c' connector to detour around the obstacle under routingStyle:'manhattan' (>= 3 points), got {result['manhattanCPointCount']}")
    if not result["manhattanCPointCountMatch"]:
        problems.append(f"expected the exported manhattan path's point count to match the real on-screen render's, got {result}")
    if result["directSPointCount"] < 3:
        problems.append(f"expected the exported 's' connector to detour around the obstacle under routingStyleStream:'direct' (>= 3 points), independently of the 'c' connector's own routingStyle, got {result['directSPointCount']}")
    if not result["straightCIsPlainLine"]:
        problems.append(f"expected routingStyle:'straight' to force a plain 2-point line for a 'c' connector in the export, got a path that doesn't match, full: {result}")
    if not result["defaultStillCurved"]:
        problems.append("expected a 'c' connector with default routing and no obstacle to still export as the classic quadratic curve ('Q' command)")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Export View as Image's SVG builder now reads view.routingStyle/routingStyleStream independently per connectorType and routes around obstacles (manhattan/direct) exactly like the real on-screen canvas, while 'straight' still forces a plain line and the default curve is preserved when there's nothing to route around"


def check_export_svg_respects_content_checkboxes(page):
    """Regression guard, direct follow-up clarifying the report above: the view's own
    property panel (click the view background, not a node/connector) also has
    Types, Description, Attributes, Keys, Show Simulation Values, and Show Script
    Badge checkboxes -- "User selection of these when in view tab should also be
    applied when creating print or image representation of view." Types/Description
    were already respected by buildViewSvgString; Attributes/Keys/Sim Values/Script
    Badge were never drawn there at all (Print already gets these for free, since it
    clones the real, already-filtered on-screen DOM instead of using this separate
    renderer -- see printViews' own doc comment). Covers each of the four newly-added
    ones turning its own content on/off in the exported SVG, using a DataEntityDetails
    part (for Attributes) and fabricated store.simRuntime data (for Sim Values/Script
    Badge, which read live simulation state)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.addView('RegrSvgContent_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const a = store.createPart({ type: 'BusinessFunction', label: 'RegrSvgContentA', model, streams: [] });
      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: a.id, x: 40, y: 40 });
      const ded = store.createPart({ type: 'DataEntityDetails', label: 'RegrSvgContentTable', model, streams: [], attributes: [{ id: 'regrAttr1', name: 'RegrAttrName', dataType: 'numeric', isPrimaryKey: true }] });
      const vmDed = store.createViewMember({ view: view.id, objectType: 'part', objectId: ded.id, x: 300, y: 40 });
      store.simRuntime.set(model, { values: new Map([[a.id, { value: 'RegrSimVal', lastTick: 1, changed: false, badge: { text: 'RegrBadgeText', color: '#123456' } }]]) });

      const getSvg = () => app.buildViewSvgString(view).svgString;
      const out = {};

      view.chkShowAttributes = true;
      out.attrsOn = getSvg().includes('RegrAttrName');
      view.chkShowAttributes = false;
      out.attrsOff = getSvg().includes('RegrAttrName');
      view.chkShowAttributes = true;

      view.chkShowKeys = true;
      out.keysOn = getSvg().includes(`vm:${vmA.id}`);
      view.chkShowKeys = false;
      out.keysOff = getSvg().includes(`vm:${vmA.id}`);
      view.chkShowKeys = true;

      view.chkShowSimValues = true;
      out.simOn = getSvg().includes('RegrSimVal');
      view.chkShowSimValues = false;
      out.simOff = getSvg().includes('RegrSimVal');
      view.chkShowSimValues = true;

      view.chkShowScriptBadge = true;
      out.badgeOn = getSvg().includes('RegrBadgeText');
      view.chkShowScriptBadge = false;
      out.badgeOff = getSvg().includes('RegrBadgeText');
      view.chkShowScriptBadge = true;

      return out;
    }
    """)
    problems = []
    for name, label in [("attrs", "chkShowAttributes"), ("keys", "chkShowKeys"), ("sim", "chkShowSimValues"), ("badge", "chkShowScriptBadge")]:
        if not result[f"{name}On"]:
            problems.append(f"expected {label}=true to include its content in the exported SVG, got {result}")
        if result[f"{name}Off"]:
            problems.append(f"expected {label}=false to EXCLUDE its content from the exported SVG, got {result}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Export View as Image's SVG builder now also respects chkShowAttributes/chkShowKeys/chkShowSimValues/chkShowScriptBadge, matching the real on-screen canvas content-for-content"


def check_export_view3d_as_image(page):
    """Regression guard/new-feature check, reported directly: "enable 'export view as
    image' for 3d view." File > Export View as Image (App.promptExportViewAsImage,
    main.js) previously guarded on `tab.type !== 'canvas'` and just toasted "No view
    open to export." for a 3D tab -- there was no WebGL capture path at all. Fixed with
    view3d.js's new captureView3DImage(tabId) (forces one synchronous render() call,
    relies on the renderer's own new preserveDrawingBuffer:true so canvas.toBlob()
    reliably returns real pixels instead of occasionally blank ones) plus
    App.exportView3DAsImage, reached via canvas.js's new getView3DModule() (the
    already-lazy-loaded view3d.js module, without eagerly importing Three.js). Covers:
    (1) captureView3DImage on a genuinely open, rendered 3D tab resolves to a real,
    non-empty image/png Blob; (2) captureView3DImage on a tabId with no live instance
    (e.g. never opened) resolves to null rather than throwing; (3) the real File menu
    entry point on an ACTIVE 3D tab skips the SVG/PNG format-picker modal entirely (3D
    has no meaningful SVG serialization) and triggers a real Blob download directly
    (intercepting URL.createObjectURL to inspect what was actually about to be saved,
    without needing to handle an OS-level download), reporting a specific PNG-export
    success toast; (4) the pre-existing 2D canvas SVG/PNG export path (format picker
    modal) is completely unaffected by this change."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');

      // (2) no live instance for this tabId -- must resolve to null, not throw
      const blobForMissingTab = await view3d.captureView3DImage('regr-no-such-tab-' + Date.now());

      // (1) a genuinely open, rendered 3D tab
      app.openOrSwitch3DView();
      const tab3d = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 400)); // let the module load and render at least once
      const blob = await view3d.captureView3DImage(tab3d.id);
      const blobInfo = blob ? { type: blob.type, size: blob.size } : null;

      // (3) the real File > Export View as Image entry point, on the active 3D tab
      app.switchToTab(tab3d.id);
      let capturedBlobType = null, capturedBlobSize = null;
      const origCreateObjectURL = URL.createObjectURL;
      URL.createObjectURL = (b) => { capturedBlobType = b.type; capturedBlobSize = b.size; return origCreateObjectURL(new Blob(['x'])); };
      document.getElementById('file-menu-btn').click();
      await new Promise(r => setTimeout(r, 50));
      document.querySelector('#file-menu .dd-item[data-action="exportImage"]').click();
      await new Promise(r => setTimeout(r, 300));
      URL.createObjectURL = origCreateObjectURL;
      const noModalOpened = !document.querySelector('.modal-box');
      const lastToast = (() => { const all = document.querySelectorAll('.toast'); return all.length ? all[all.length - 1].textContent : null; })();

      // (4) the pre-existing 2D canvas path still opens its format-picker modal, unaffected
      const view2d = store.addView('RegrExport3DCanvas_' + Date.now(), 'ff');
      const p = store.createPart({ type: 'Unknown', label: 'X', model: store.defaultModel, streams: [] });
      store.createViewMember({ view: view2d.id, objectType: 'part', objectId: p.id, x: 0, y: 0 });
      const tab2d = app.createCanvasTab(view2d);
      app.switchToTab(tab2d.id);
      document.getElementById('file-menu-btn').click();
      await new Promise(r => setTimeout(r, 50));
      document.querySelector('#file-menu .dd-item[data-action="exportImage"]').click();
      await new Promise(r => setTimeout(r, 50));
      const canvasModalOpened = !!document.querySelector('.modal-box');
      document.querySelector('.modal-box .cancel')?.click();

      return {
        blobForMissingTabIsNull: blobForMissingTab === null,
        blobInfo, noModalOpened, lastToast, capturedBlobType, capturedBlobSize,
        canvasModalOpened,
      };
    }
    """)
    problems = []
    if not result["blobForMissingTabIsNull"]:
        problems.append("expected captureView3DImage on a tabId with no live instance to resolve to null")
    if not result["blobInfo"] or result["blobInfo"]["type"] != "image/png" or result["blobInfo"]["size"] <= 0:
        problems.append(f"expected captureView3DImage on a real, open, rendered 3D tab to resolve to a non-empty image/png Blob, got {result['blobInfo']}")
    if not result["noModalOpened"]:
        problems.append("expected exporting a 3D tab to skip the SVG/PNG format-picker modal entirely (no meaningful SVG choice for a 3D scene)")
    if not result["lastToast"] or "3D View" not in result["lastToast"] or "PNG" not in result["lastToast"]:
        problems.append(f"expected a specific '...3D View... as PNG' success toast, got {result['lastToast']!r}")
    if result["capturedBlobType"] != "image/png" or not result["capturedBlobSize"]:
        problems.append(f"expected the real File > Export View as Image menu action to hand a non-empty image/png Blob to URL.createObjectURL, got type={result['capturedBlobType']!r} size={result['capturedBlobSize']}")
    if not result["canvasModalOpened"]:
        problems.append("expected the pre-existing 2D canvas Export View as Image format-picker modal to still open normally, unaffected by the 3D export path")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "File > Export View as Image now works for a 3D View tab (captures a real PNG via the WebGL renderer, no format picker, specific success toast) without touching the pre-existing 2D canvas SVG/PNG export path"


def check_view3d_section_boundaries(page):
    """Regression guard for the 3D View's Section boundary + label: each Part.section's
    own cluster within a TYPE's grid (the same row-break clustering
    layoutGridWithSectionBreaks has always done, per-type — see its own Stage 2 history)
    gets a visible rectangle outline plus a billboarded text-sprite label with the
    section's name, at that type's own Z. Covers: one boundary+label per (type, section)
    pair actually present (GeneralActor/North, GeneralActor/South, ApplicationComponent/
    North here — 3, not fewer/more); an unsectioned part contributes NO boundary (nothing
    to box around a blank section); the boundary's
    recorded bounds genuinely enclose every part actually in that section (not some
    unrelated placeholder rectangle); and the Section filter narrowing to one section
    removes the OTHER section's boundary too (same filter pipeline that already hides its
    parts)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const mk = (label, type, section) => store.createPart({ type, label, model: store.defaultModel, streams: [], section: section || '' });
      const n1 = mk('N1', 'GeneralActor', 'North');
      const n2 = mk('N2', 'GeneralActor', 'North');
      const s1 = mk('S1', 'GeneralActor', 'South');
      mk('U1', 'GeneralActor', ''); // no section -> should get no boundary
      mk('AppN1', 'ApplicationComponent', 'North');

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 300));
      const info = view3d.getDebugSceneInfo(tab.id);

      const northGA = info.sectionBoundaries.find(b => b.sectionName === 'North' && b.z === info.types['GeneralActor'].z);
      const gaPositions = info.types['GeneralActor'].positions;

      tab.activeSections = ['North'];
      app.render();
      await new Promise(r => setTimeout(r, 150));
      const infoFiltered = view3d.getDebugSceneInfo(tab.id);

      return {
        boundaryCount: info.sectionBoundaries.length,
        labelCount: info.sectionLabels.length,
        sectionNames: info.sectionBoundaries.map(b => b.sectionName).sort(),
        northGA,
        n1Pos: gaPositions[n1.id], n2Pos: gaPositions[n2.id], s1Pos: gaPositions[s1.id],
        filteredBoundaryCount: infoFiltered.sectionBoundaries.length,
        filteredSectionNames: infoFiltered.sectionBoundaries.map(b => b.sectionName),
      };
    }
    """)
    def inside(bounds, pos):
        return bounds["x0"] <= pos["x"] <= bounds["x1"] and bounds["y0"] <= pos["y"] <= bounds["y1"]
    problems = []
    if result["boundaryCount"] != 3:
        problems.append(f"expected 3 boundaries (GeneralActor/North, GeneralActor/South, ApplicationComponent/North), got {result['boundaryCount']}: {result['sectionNames']}")
    if result["labelCount"] != 3:
        problems.append(f"expected 3 labels matching the 3 boundaries, got {result['labelCount']}")
    nb = result["northGA"]
    if not nb:
        problems.append("expected to find a 'North' boundary at GeneralActor's own Z layer")
    else:
        if not inside(nb["bounds"], result["n1Pos"]) or not inside(nb["bounds"], result["n2Pos"]):
            problems.append(f"expected N1/N2 (actually in 'North') to fall inside the 'North' boundary's own bounds, got bounds={nb['bounds']} n1={result['n1Pos']} n2={result['n2Pos']}")
        if inside(nb["bounds"], result["s1Pos"]):
            problems.append(f"expected S1 (in 'South', a different section) to fall OUTSIDE the 'North' boundary, got bounds={nb['bounds']} s1={result['s1Pos']}")
    if result["filteredBoundaryCount"] != 2:
        problems.append(f"expected the Section filter (narrowed to 'North') to also hide the 'South' boundaries, leaving 2 (one per type), got {result['filteredBoundaryCount']}: {result['filteredSectionNames']}")
    if any(n != "North" for n in result["filteredSectionNames"]):
        problems.append(f"expected only 'North' boundaries to remain after filtering, got {result['filteredSectionNames']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "each Part.section's cluster within a type's grid gets its own boundary+label, an unsectioned part contributes none, and the Section filter also hides non-matching boundaries"


def check_generate_industry_propagates_section_to_whole_chain(page):
    """Regression guard: Section used to only ever land on the function-level part
    (BusinessFunction) a stream generates — every other part in that same stream
    (capability, application capability, entity, and every supporting/passive node in
    between) got section: '' regardless of the function's own section. That meant
    filtering the 3D View (or 2D canvas) to one section only ever showed the lone
    function node, hiding the entire rest of the chain it belongs to. Uses the built-in
    'SFCCE' template (9 value[] types + 2 passive pairs — BusinessFunction->BusinessProcess,
    ApplicationApplication->ApplicationPhysicalComponent) so this covers both the main
    chain AND the passive-node path in one fixture."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const sfce = await import('./js/sfce.js');
      const commands = await import('./js/commands.js');
      const row = {
        section: 'Agriculture', functionName: 'Crop Planning',
        capabilityName: 'Yield Forecasting', applicationCapabilityName: 'Forecast Engine',
        applicationCapabilityDescription: '', entityName: 'Forecast Record', entityDescription: '',
      };
      const { tree } = sfce.buildIndustryTree([row]);
      store.doc.industryTree = tree;
      store.doc.industryTemplateName = 'SFCCE';
      await commands.generateIndustry(app, null, false);

      // A fresh page starts with no parts, so everything in the document now is exactly
      // what this one generateIndustry call created.
      const allParts = store.doc.parts.map((p) => ({ label: p.label, type: p.type, section: p.section }));
      return { allParts };
    }
    """)
    parts = result["allParts"]
    if len(parts) == 0:
        return False, f"expected Generate Industry to create at least one part, got none (full: {result})"
    wrongSection = [p for p in parts if p["section"] != "Agriculture"]
    if wrongSection:
        return False, f"expected EVERY part generated from this one stream to inherit the function's own section 'Agriculture' (capability/application capability/entity/passive nodes included, not just the BusinessFunction), but these didn't: {wrongSection} (full: {parts})"
    return True, f"all {len(parts)} parts generated from one stream (function, capability, application capability, entity, and passive nodes) correctly inherited the function's own section"


def check_business_organization_unit_element_and_generation(page):
    """Regression guard/new-feature check for a new element type, reported directly:
    'please confirm that a togaf element business organization unit or organization
    unit is missing' -> confirmed missing, then: 'add it as a new element type, with
    oval icon (similar to requirement but looks different), same group (and
    coloring, relations, etc.) as togaf business actor. When we import or generate
    involving sections, these will now be business organization units (aka orgunit);
    meaning when loading SFCCE for example, now generate a orgunit part.' Covers: (1)
    the new BusinessOrganizationUnit element definition itself -- Business group
    (same fill as Business Actor), TOGAF-only source tag ('t', not 'at' -- this is a
    TOGAF Content Metamodel concept, not core ArchiMate), an oval icon path distinct
    from Requirement's own oval (both are ellipses, but not the identical path); (2)
    relationshipPairs mirrored from Business Actor's own real ArchiMate 3.2 relations
    (relationships.xml) in both directions plus a self-pair, not left with zero
    valid relations (which would make it uncreatable as a manual connector
    endpoint); (3) generateIndustry (used by both Load SFCCE and the built-in
    'general' industry, though 'general' itself carries no section data) now reifies
    each function's own section as an actual BusinessOrganizationUnit part instead of
    only tagging Part.section as a string -- one OrgUnit per unique section VALUE,
    reused (not duplicated) across every function that shares it, Assignment-connected
    to the function it's responsible for, and placed on the view; re-running
    generateIndustry is idempotent (no duplicate OrgUnits or connectors); and this
    only ever triggers via generateIndustry (Load SFCCE / built-in industries), never
    the plain manual Generate Stream dialog, which has no section concept at all."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const { generateIndustry } = await import('./js/commands.js');

      const el = (store.settings.elements || []).find(e => e.type === 'BusinessOrganizationUnit');
      const requirementEl = (store.settings.elements || []).find(e => e.type === 'Requirement');
      const businessActorFill = (store.settings.elementGroups || []).find(g => g.group === 'Business')?.fill;

      const relPairs = store.mergedRelationshipPairs;
      const toFunction = relPairs.find(p => p.typeA === 'BusinessOrganizationUnit' && p.typeB === 'BusinessFunction');
      const toActor = relPairs.find(p => p.typeA === 'BusinessOrganizationUnit' && p.typeB === 'BusinessActor');
      const fromActor = relPairs.find(p => p.typeA === 'BusinessActor' && p.typeB === 'BusinessOrganizationUnit');
      const selfPair = relPairs.find(p => p.typeA === 'BusinessOrganizationUnit' && p.typeB === 'BusinessOrganizationUnit');

      const view = store.addView('RegrOrgUnit_' + Date.now(), 'ff');
      store.currentView = view.id;
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      store.doc.industryTree = [
        { nodeElementType: 'BusinessFunction', nodeName: 'RegrOUFuncA', nodeId: 'ouA', nodeSection: 'RegrEnvironment',
          nodeChildren: [{ nodeElementType: 'BusinessCapability', nodeName: 'RegrOUCapA', nodeId: 'oucA',
            nodeChildren: [{ nodeElementType: 'ApplicationCapability', nodeName: 'RegrOUAppCapA', nodeId: 'ouacA',
              nodeChildren: [{ nodeElementType: 'DataDataEntity', nodeName: 'RegrOUEntA', nodeId: 'oueA' }] }] }] },
        { nodeElementType: 'BusinessFunction', nodeName: 'RegrOUFuncB', nodeId: 'ouB', nodeSection: 'RegrEnvironment',
          nodeChildren: [{ nodeElementType: 'BusinessCapability', nodeName: 'RegrOUCapB', nodeId: 'oucB',
            nodeChildren: [{ nodeElementType: 'ApplicationCapability', nodeName: 'RegrOUAppCapB', nodeId: 'ouacB',
              nodeChildren: [{ nodeElementType: 'DataDataEntity', nodeName: 'RegrOUEntB', nodeId: 'oueB' }] }] }] },
      ];
      store.doc.industryTemplateName = 'SFCCE';

      await generateIndustry(app, null, true);
      const orgUnitsAfterFirst = store.doc.parts.filter(p => p.type === 'BusinessOrganizationUnit' && p.label === 'RegrEnvironment');
      // ALL BusinessOrganizationUnit parts, not just correctly-labeled ones -- catches the
      // generic passive-node mechanism (every template's own passive[] also lists
      // {from:'BusinessOrganizationUnit', to:'BusinessFunction'}, added for 3D View layer
      // visibility) creating a SECOND, wrongly-labeled (by capability/entity name instead
      // of the section value) OrgUnit per stream, which the label-filtered count above
      // would never see.
      const allOrgUnitsAfterFirst = store.doc.parts.filter(p => p.type === 'BusinessOrganizationUnit');
      const assignConnsAfterFirst = store.doc.connectors.filter(c => c.connectorType === 'c' && c.relationship === 'Assignment' && orgUnitsAfterFirst.some(o => o.id === c.from));
      const orgUnitVms = store.viewMembersForView(view.id).filter(v => v.objectType === 'part' && orgUnitsAfterFirst.some(o => o.id === v.objectId));

      // Re-run: must reuse the same OrgUnit and not duplicate the Assignment connectors.
      await generateIndustry(app, null, true);
      const orgUnitsAfterSecond = store.doc.parts.filter(p => p.type === 'BusinessOrganizationUnit' && p.label === 'RegrEnvironment');
      const assignConnsAfterSecond = store.doc.connectors.filter(c => c.connectorType === 'c' && c.relationship === 'Assignment' && orgUnitsAfterSecond.some(o => o.id === c.from));

      return {
        el, requirementPath: requirementEl?.path, businessActorFill,
        toFunction, toActor, fromActor, selfPair,
        orgUnitCountAfterFirst: orgUnitsAfterFirst.length,
        allOrgUnitCountAfterFirst: allOrgUnitsAfterFirst.length,
        assignConnCountAfterFirst: assignConnsAfterFirst.length,
        orgUnitVmCount: orgUnitVms.length,
        orgUnitCountAfterSecond: orgUnitsAfterSecond.length,
        assignConnCountAfterSecond: assignConnsAfterSecond.length,
      };
    }
    """)
    problems = []
    el = result["el"]
    if not el:
        problems.append("expected a BusinessOrganizationUnit entry in settings.elements")
    else:
        if el["group"] != "Business":
            problems.append(f"expected BusinessOrganizationUnit in the Business group, got {el['group']!r}")
        if el["sources"] != "t":
            problems.append(f"expected sources 't' (TOGAF-only, not core ArchiMate), got {el['sources']!r}")
        if el["path"] == result["requirementPath"]:
            problems.append("expected a distinct icon path from Requirement's own oval, got an identical path")
        if "A" not in el["path"] or el["path"].count("A") < 2:
            problems.append(f"expected an oval (elliptical arc) icon path, got {el['path']!r}")
    for label, pair in [("BusinessOrganizationUnit->BusinessFunction", result["toFunction"]),
                         ("BusinessOrganizationUnit->BusinessActor", result["toActor"]),
                         ("BusinessActor->BusinessOrganizationUnit", result["fromActor"]),
                         ("BusinessOrganizationUnit self-pair", result["selfPair"])]:
        if not pair or not pair.get("relations"):
            problems.append(f"expected a real relationshipPairs entry with allowed relations for {label}, got {pair}")
    if result["orgUnitCountAfterFirst"] != 1:
        problems.append(f"expected exactly 1 OrgUnit ('RegrEnvironment', shared by both functions), got {result['orgUnitCountAfterFirst']}")
    if result["allOrgUnitCountAfterFirst"] != 1:
        problems.append(f"expected exactly 1 BusinessOrganizationUnit part TOTAL (not just correctly-labeled ones) — the generic passive-node mechanism must not also create a second, wrongly-labeled OrgUnit for the same stream, got {result['allOrgUnitCountAfterFirst']}")
    if result["assignConnCountAfterFirst"] != 2:
        problems.append(f"expected 2 Assignment connectors (one per function sharing the OrgUnit), got {result['assignConnCountAfterFirst']}")
    if result["orgUnitVmCount"] != 1:
        problems.append(f"expected the OrgUnit placed exactly once on the view, got {result['orgUnitVmCount']}")
    if result["orgUnitCountAfterSecond"] != result["orgUnitCountAfterFirst"]:
        problems.append(f"expected OrgUnit count unchanged on re-run, got {result['orgUnitCountAfterFirst']} -> {result['orgUnitCountAfterSecond']}")
    if result["assignConnCountAfterSecond"] != result["assignConnCountAfterFirst"]:
        problems.append(f"expected Assignment connector count unchanged on re-run (no duplicates), got {result['assignConnCountAfterFirst']} -> {result['assignConnCountAfterSecond']}")
    if problems:
        return False, "; ".join(problems)
    return True, "BusinessOrganizationUnit is a real Business-group element with a distinct oval icon and mirrored Business Actor relations, and generateIndustry now reifies each function's section as a shared, Assignment-connected OrgUnit part instead of only a string tag, idempotently across re-runs"


def check_level_down_single_creates_new_part(page):
    """Regression guard: single-node Level Down (double-click a node with no
    linkedViewName yet) used to place a SECOND viewMember of the SAME part as the new
    view's own anchor — meaning editing/renaming/retyping the decomposition's own anchor
    silently edited the summary-level node too, since they were the identical Part
    underneath. Reported directly from a real scenario: DataEntity 'in' --flow-->
    Process 'process1' --flow--> DataEntity 'out'; leveling down on 'process1' should
    create a genuinely NEW Process part (same type/label as a starting point, distinct
    identity — same approach Split Node already uses) wired up with NEW connectors to
    external copies of 'in'/'out' (the real neighbor parts, correctly reused — only the
    leveled-down node itself needs to be new), while the ORIGINAL 'process1' and its
    original connectors up at the parent level stay completely untouched."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.findView(store.currentView) || store.doc.views[0];
      const tab = store.tabs.find(t => t.type === 'canvas') || app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const inPart = store.createPart({ type: 'DataDataEntity', label: 'in', model: store.defaultModel, streams: [] });
      const proc = store.createPart({ type: 'ApplicationProcess', label: 'process1', model: store.defaultModel, streams: [] });
      const outPart = store.createPart({ type: 'DataDataEntity', label: 'out', model: store.defaultModel, streams: [] });
      const inVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: inPart.id, x: 40, y: 40 });
      const procVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: proc.id, x: 240, y: 40 });
      const outVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: outPart.id, x: 440, y: 40 });
      const conn1 = store.createConnector({ from: inPart.id, to: proc.id, model: store.defaultModel, connectorType: 'c', relationship: 'Flow', streams: [] });
      const conn2 = store.createConnector({ from: proc.id, to: outPart.id, model: store.defaultModel, connectorType: 'c', relationship: 'Flow', streams: [] });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn1.id, fromVmId: inVm.id, toVmId: procVm.id });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn2.id, fromVmId: procVm.id, toVmId: outVm.id });

      app.openOrCreateLinkedView(tab, procVm.id);
      await new Promise(r => setTimeout(r, 150));

      const newView = store.findView('process1');
      const newViewMembers = newView ? store.viewMembersForView(newView.id) : [];
      const newPartVms = newViewMembers.filter(v => v.objectType === 'part');
      const anchorVm = newPartVms.find(v => !v.isExternal);
      const anchorPart = anchorVm ? store.findPart(anchorVm.objectId) : null;
      const externalParts = newPartVms.filter(v => v.isExternal).map(v => store.findPart(v.objectId));
      const newConns = newViewMembers.filter(v => v.objectType === 'connector').map(v => store.findConnector(v.objectId));

      return {
        newViewExists: !!newView,
        origProcLinkedViewName: procVm.linkedViewName,
        anchorPartId: anchorPart ? anchorPart.id : null,
        anchorLabel: anchorPart ? anchorPart.label : null,
        anchorType: anchorPart ? anchorPart.type : null,
        procId: proc.id,
        externalIds: externalParts.map(p => p.id).sort(),
        inOutIds: [inPart.id, outPart.id].sort(),
        newConnFromTo: newConns.map(c => ({ from: c.from, to: c.to })),
        newConnIds: newConns.map(c => c.id),
        origConnIds: [conn1.id, conn2.id],
        origConn1: store.findConnector(conn1.id),
        origConn2: store.findConnector(conn2.id),
        origProcStillInParentView: store.viewMembersForView(view.id).some(v => v.objectType === 'part' && v.objectId === proc.id),
      };
    }
    """)
    problems = []
    if not result["newViewExists"]:
        problems.append("expected a new view named 'process1' to be created")
    if result["origProcLinkedViewName"] != "process1":
        problems.append(f"expected the original process1 viewMember's linkedViewName to be set to the new view, got {result['origProcLinkedViewName']}")
    if not result["anchorPartId"]:
        problems.append("expected the new view to have a non-external anchor part")
    elif result["anchorPartId"] == result["procId"]:
        problems.append("expected the new view's anchor to be a GENUINELY NEW part, but it reused the original process1's own part id")
    if result["anchorLabel"] != "process1" or result["anchorType"] != "ApplicationProcess":
        problems.append(f"expected the new anchor part to copy the original's label/type ('process1'/'ApplicationProcess'), got label={result['anchorLabel']} type={result['anchorType']}")
    if result["externalIds"] != result["inOutIds"]:
        problems.append(f"expected the external copies to reuse the REAL 'in'/'out' parts (only the leveled-down node itself should be new), got {result['externalIds']} vs expected {result['inOutIds']}")
    if len(result["newConnFromTo"]) != 2 or not all(result["anchorPartId"] in (c["from"], c["to"]) for c in result["newConnFromTo"]):
        problems.append(f"expected exactly 2 new connectors, each touching the new anchor part, got {result['newConnFromTo']}")
    if any(result["procId"] in (c["from"], c["to"]) for c in result["newConnFromTo"]):
        problems.append(f"expected the new view's connectors to point at the NEW anchor part, not the original process1, got {result['newConnFromTo']}")
    if any(cid in result["origConnIds"] for cid in result["newConnIds"]):
        problems.append(f"expected genuinely NEW connector objects (not reusing the original connectors' identity, which would leave their from/to pointing at the old part), got {result['newConnIds']} overlapping {result['origConnIds']}")
    origEndpoints = (result["origConn1"]["from"], result["origConn1"]["to"], result["origConn2"]["from"], result["origConn2"]["to"])
    if result["procId"] not in origEndpoints:
        problems.append(f"expected the ORIGINAL connectors (up at the parent level) to still reference process1's real id, untouched, got origConn1={result['origConn1']} origConn2={result['origConn2']} procId={result['procId']}")
    if not result["origProcStillInParentView"]:
        problems.append("expected the original process1 part to remain in the parent view, untouched")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "single-node Level Down now creates a genuinely new Part for the decomposition anchor (with new connectors pointing at it), reusing only the real external neighbor parts, and leaves the original node/connectors at the parent level untouched"


def check_level_down_downstream_external_placed_near_anchor(page):
    """Regression guard: Level Down used to place a downstream ("to" side) external
    neighbor at a fixed x=900, regardless of the anchor's own position or the view's
    node size — reported directly as "placed far right" when it should sit close to the
    decomposition it's actually next to. Now placed one node width to the right of the
    anchor (the only non-external node on a freshly leveled-down view) instead. The
    upstream ("from" side) external neighbor's placement near the left edge (x=20) is
    unaffected — only the "to" side was reported as a problem."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const view = store.addView('RegrExtPlacement_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const inPart = store.createPart({ type: 'DataDataEntity', label: 'in', model: store.defaultModel, streams: [] });
      const proc = store.createPart({ type: 'ApplicationProcess', label: 'PlaceProc', model: store.defaultModel, streams: [] });
      const outPart = store.createPart({ type: 'DataDataEntity', label: 'out', model: store.defaultModel, streams: [] });
      const inVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: inPart.id, x: 40, y: 40 });
      const procVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: proc.id, x: 240, y: 40 });
      const outVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: outPart.id, x: 440, y: 40 });
      const conn1 = store.createConnector({ from: inPart.id, to: proc.id, model: store.defaultModel, connectorType: 'c', relationship: 'Flow', streams: [] });
      const conn2 = store.createConnector({ from: proc.id, to: outPart.id, model: store.defaultModel, connectorType: 'c', relationship: 'Flow', streams: [] });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn1.id, fromVmId: inVm.id, toVmId: procVm.id });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn2.id, fromVmId: procVm.id, toVmId: outVm.id });

      app.openOrCreateLinkedView(tab, procVm.id);
      await new Promise(r => setTimeout(r, 150));
      const newView = store.findView('PlaceProc');
      const newVms = store.viewMembersForView(newView.id).filter(v => v.objectType === 'part');
      const anchorVm = newVms.find(v => !v.isExternal);
      const outVmNew = newVms.find(v => v.isExternal && v.objectId === outPart.id);
      const inVmNew = newVms.find(v => v.isExternal && v.objectId === inPart.id);
      return {
        anchorX: anchorVm.x,
        outX: outVmNew ? outVmNew.x : null,
        inX: inVmNew ? inVmNew.x : null,
        nodeWidth: newView.nodeWidth,
      };
    }
    """)
    problems = []
    # Not exact-equality against anchorX + nodeWidth: levelDownSingle's own placement
    # runs BEFORE its trailing redrawAndResolveLayout call, which can resize/reflow
    # nodes afterward (e.g. a label needing a wider box than the view's current
    # default) — so the FINAL nodeWidth/positions legitimately drift a bit from what
    # was placed. Assert the qualitative property actually reported instead: close to
    # the anchor, not clumped on top of it, and nowhere near the old fixed x=900.
    offset = None if result["outX"] is None else result["outX"] - result["anchorX"]
    if result["outX"] is None:
        problems.append("expected an external copy of 'out' (downstream neighbor) on the new view")
    elif not (result["nodeWidth"] * 0.5 <= offset <= result["nodeWidth"] * 2):
        problems.append(f"expected the downstream external neighbor roughly one node width right of the anchor (anchorX={result['anchorX']}, nodeWidth={result['nodeWidth']}), got outX={result['outX']} (offset {offset})")
    if result["outX"] is not None and result["outX"] >= 900:
        problems.append(f"expected the downstream external neighbor to NOT be placed at the old fixed far-right position (900+), got outX={result['outX']}")
    if result["inX"] != 20:
        problems.append(f"expected the upstream external neighbor's placement (x=20, near the left edge) to be unaffected, got inX={result['inX']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Level Down places a downstream ('to' side) external neighbor roughly one node width right of the anchor instead of a fixed far-right x=900, leaving the upstream ('from' side) placement unchanged"


def check_level_down_creates_composition_link(page):
    """Regression guard: single-node Level Down now creates an explicit 'Composition'
    connector from the parent-level part to the new decomposition anchor (not placed on
    any view — there's no view showing both levels at once), giving Smart Check
    View/Node a durable structural link between the two levels. Without this, a
    connector added to the parent part AFTER leveling down had no way to be recognized
    as relevant to the child view at all (see check_smart_check_composition_top_down and
    check_smart_check_node_composition_redirect, which depend on this link existing)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.findView(store.currentView) || store.doc.views[0];
      const tab = store.tabs.find(t => t.type === 'canvas') || app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const proc = store.createPart({ type: 'ApplicationProcess', label: 'CompLinkProc', model: store.defaultModel, streams: [] });
      const procVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: proc.id, x: 40, y: 40 });
      app.openOrCreateLinkedView(tab, procVm.id);
      await new Promise(r => setTimeout(r, 150));
      const newView = store.findView('CompLinkProc');
      const anchorVm = newView ? store.viewMembersForView(newView.id).find(v => v.objectType === 'part' && !v.isExternal) : null;
      const anchorPart = anchorVm ? store.findPart(anchorVm.objectId) : null;
      const compConn = anchorPart ? store.doc.connectors.find(c => c.relationship === 'Composition' && c.from === proc.id && c.to === anchorPart.id) : null;
      const placedOnAnyView = compConn ? store.doc.viewMembers.some(v => v.objectType === 'connector' && v.objectId === compConn.id) : null;
      return { anchorFound: !!anchorPart, compConnExists: !!compConn, placedOnAnyView };
    }
    """)
    problems = []
    if not result["anchorFound"]:
        problems.append("expected Level Down to create a new decomposition anchor")
    if not result["compConnExists"]:
        problems.append("expected a Composition connector from the parent part to the new anchor")
    if result["placedOnAnyView"]:
        problems.append("expected the Composition connector to NOT be placed on any view (no view shows both levels at once)")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Level Down creates an unplaced Composition connector linking the parent part to its new decomposition anchor"


def check_level_down_reuses_existing_decomposition_across_viewmembers(page):
    """Regression guard for openOrCreateLinkedView (main.js) — the SAME Part appearing
    as TWO DIFFERENT ViewMembers (on two different views) must resolve to the SAME
    decomposition, not create two independent ones. `vm.linkedViewName` (the existing
    double-click guard) lives on the ViewMember, not the Part, so without an
    additional Part-level check, double-clicking a second ViewMember of an
    already-decomposed Part fell through to levelDownSingle again, creating a second
    child Part, a second Composition connector, and a second detail view — orphaning
    the first one. Found while designing a new feature (Data Modeling / crow's-foot
    ERD) that decomposes a DataDataEntity into an attribute-detail child via Level
    Down: the same DataDataEntity commonly appears on multiple Stream views, so this
    was a real, immediate risk, not a hypothetical one. Fixed via
    findCompositionChildView (commands.js): before falling through to
    levelDownSingle, check whether `part` already has a Composition child ANYWHERE in
    the doc (not just via this ViewMember's own linkedViewName) and reuse/link to its
    existing view instead. The fixture deliberately RENAMES the first decomposition's
    view after creation so it no longer coincidentally matches the older "view named
    the same as the part's label" fallback (openOrCreateLinkedView's third check) --
    proving this new guard, specifically, is what's doing the work, not that
    pre-existing fallback."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const part = store.createPart({ type: 'DataDataEntity', label: 'RegrSharedEntity_' + Date.now(), model, streams: [] });

      const viewA = store.addView('RegrLDReuseA_' + Date.now(), 'ff');
      const tabA = app.createCanvasTab(viewA);
      app.switchToTab(tabA.id);
      const vmA = store.createViewMember({ view: viewA.id, objectType: 'part', objectId: part.id, x: 0, y: 0 });

      const viewB = store.addView('RegrLDReuseB_' + Date.now(), 'ff');
      const tabB = app.createCanvasTab(viewB);
      const vmB = store.createViewMember({ view: viewB.id, objectType: 'part', objectId: part.id, x: 0, y: 0 });

      app.switchToTab(tabA.id);
      app.openOrCreateLinkedView(tabA, vmA.id);
      store.renameView(vmA.linkedViewName, 'RegrLDReuseRenamed_' + Date.now());
      const firstLinkedView = vmA.linkedViewName;

      app.switchToTab(tabB.id);
      app.openOrCreateLinkedView(tabB, vmB.id);
      const secondLinkedView = vmB.linkedViewName;

      const compositionConns = store.doc.connectors.filter(c => c.relationship === 'Composition' && c.from === part.id);
      return {
        firstLinkedView, secondLinkedView,
        sameView: firstLinkedView === secondLinkedView,
        compositionCount: compositionConns.length,
      };
    }
    """)
    problems = []
    if not result["sameView"]:
        problems.append(f"expected both ViewMembers of the same Part to resolve to the SAME decomposition view, got {result['firstLinkedView']!r} vs {result['secondLinkedView']!r}")
    if result["compositionCount"] != 1:
        problems.append(f"expected exactly ONE Composition connector for the Part (reused, not duplicated), got {result['compositionCount']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "double-clicking a second ViewMember of an already-decomposed Part reuses the existing decomposition instead of creating a duplicate"


def check_data_modeling_attributes_and_data_connector(page):
    """Regression guard for the Data Modeling (crow's-foot ERD) feature's foundational
    data model: the new 'DataEntityDetails' element type, Part.attributes (an array of
    {id, name, dataType, nullable, isPrimaryKey}), the new 'a' showFields widget
    (render.js's renderShowFieldsPanel — an inline editable table with add/edit/delete),
    the new connectorType 'd' with fromAttribute/toAttribute/fromCardinality/
    toCardinality fields, and the dependent From/To Attribute dropdowns (options scoped
    to whichever table is on that end, via ctx.fromPartId/toPartId). Covers: (1) the
    '+ Add Attribute' button and per-cell inputs genuinely mutate part.attributes (not
    just the DOM) — add two rows, edit name/dataType/nullable/PK on the first, delete
    the second, confirm the final array; (2) isForeignKey is DERIVED, not stored — an
    attribute referenced by a 'd' connector's fromAttribute shows the FK badge, an
    unreferenced one doesn't, and this is computed live (no isForeignKey field is ever
    written to the attribute object itself); (3) the From/To Attribute select options
    are correctly scoped per end (From Attribute lists ONLY the from-table's own
    attributes, To Attribute ONLY the to-table's, not a merged/wrong list); (4) a
    full store.toJSON()/loadFromJSON round-trip preserves Part.attributes and the
    connector's new fields exactly."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.addView('RegrDataModel_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const t1 = store.createPart({ type: 'DataEntityDetails', label: 'RegrOrders', model, streams: [] });
      const t2 = store.createPart({ type: 'DataEntityDetails', label: 'RegrCustomers', model, streams: [],
        attributes: [{ id: 'regr-b1', name: 'id', dataType: 'INTEGER', nullable: false, isPrimaryKey: true }] });
      const vm1 = store.createViewMember({ view: view.id, objectType: 'part', objectId: t1.id, x: 0, y: 0 });
      const vm2 = store.createViewMember({ view: view.id, objectType: 'part', objectId: t2.id, x: 300, y: 0 });
      const conn = store.createConnector({ from: t1.id, to: t2.id, connectorType: 'd', model, relationship: 'Association' });
      const connVm = store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: vm1.id, toVmId: vm2.id });
      app.recordAndRender();

      // (1) UI-driven attribute add/edit/delete on t1 (starts with zero attributes).
      const selectNode = (vmId) => { tab.selection = new Set([vmId]); app.render(); };
      selectNode(vm1.id);
      document.querySelector('.attr-add-btn').click();
      await new Promise(r => setTimeout(r, 30));
      document.querySelector('.attr-add-btn').click();
      await new Promise(r => setTimeout(r, 30));
      const rowsAfterAdd = document.querySelectorAll('tr[data-attr-id]').length;

      const setInput = (sel, value, isCheckbox) => {
        const el = document.querySelectorAll(sel)[0];
        if (isCheckbox) { el.checked = value; } else { el.value = value; }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setInput('.attr-name', 'order_id', false);
      await new Promise(r => setTimeout(r, 30));
      setInput('.attr-datatype', 'numeric', false);
      await new Promise(r => setTimeout(r, 30));
      setInput('.attr-pk', true, true);
      await new Promise(r => setTimeout(r, 30));
      // delete the second (still-blank) row
      const deleteBtns = document.querySelectorAll('.attr-delete-btn');
      deleteBtns[deleteBtns.length - 1].click();
      await new Promise(r => setTimeout(r, 30));

      const t1AttrsAfterUI = store.findPart(t1.id).attributes;

      // (2) FK derivation: set the connector's fromAttribute to t1's real attribute id
      // and toAttribute to t2's own primary key (a realistic FK->PK reference -- FK
      // derivation looks at BOTH ends, see isAttributeForeignKey's own doc comment),
      // confirm the FK badge appears on THAT row and nowhere else, and that no
      // isForeignKey key was ever written onto the attribute object.
      const realAttrId = t1AttrsAfterUI[0].id;
      conn.fromAttribute = realAttrId;
      conn.toAttribute = 'regr-b1';
      selectNode(vm1.id); // re-render to recompute the FK badge from the connector's new fromAttribute
      const fkBadgeRows = [...document.querySelectorAll('tr[data-attr-id]')].filter(tr => tr.querySelector('.attr-fk-badge'));
      const hasIsForeignKeyField = 'isForeignKey' in t1AttrsAfterUI[0];

      // (3) Dependent dropdown scoping: select the 'd' connector, read its From/To
      // Attribute select options.
      const connVmEl = { id: connVm.id };
      tab.selection = new Set([connVm.id]);
      app.render();
      const selects = [...document.querySelectorAll('select')];
      const fromSel = selects.find(s => s.id.includes('fromAttribute'));
      const toSel = selects.find(s => s.id.includes('toAttribute'));
      const fromOptionLabels = fromSel ? [...fromSel.options].map(o => o.textContent) : null;
      const toOptionLabels = toSel ? [...toSel.options].map(o => o.textContent) : null;

      // (4) Save/Load JSON round-trip.
      const savedJson = store.toJSON();
      store.loadFromJSON(JSON.parse(JSON.stringify(savedJson)));
      const t1AfterReload = store.doc.parts.find(p => p.id === t1.id);
      const connAfterReload = store.doc.connectors.find(c => c.id === conn.id);

      return {
        rowsAfterAdd,
        t1AttrsAfterUI,
        fkBadgeCount: fkBadgeRows.length,
        fkBadgeOnCorrectRow: fkBadgeRows.length === 1 && fkBadgeRows[0].dataset.attrId === realAttrId,
        hasIsForeignKeyField,
        fromOptionLabels, toOptionLabels,
        attributesAfterReload: t1AfterReload ? t1AfterReload.attributes : null,
        connFieldsAfterReload: connAfterReload ? {
          connectorType: connAfterReload.connectorType, fromAttribute: connAfterReload.fromAttribute,
          toAttribute: connAfterReload.toAttribute, fromCardinality: connAfterReload.fromCardinality, toCardinality: connAfterReload.toCardinality,
        } : null,
      };
    }
    """)
    problems = []
    if result["rowsAfterAdd"] != 2:
        problems.append(f"expected 2 rows after two '+ Add Attribute' clicks, got {result['rowsAfterAdd']}")
    attrs = result["t1AttrsAfterUI"]
    if len(attrs) != 1 or attrs[0]["name"] != "order_id" or attrs[0]["dataType"] != "numeric" or attrs[0]["isPrimaryKey"] is not True:
        problems.append(f"expected exactly one attribute {{name:'order_id', dataType:'numeric', isPrimaryKey:true}} after UI edits + delete, got {attrs}")
    if not result["fkBadgeOnCorrectRow"] or result["fkBadgeCount"] != 1:
        problems.append(f"expected exactly one FK badge, on the attribute referenced by the connector's fromAttribute, got count={result['fkBadgeCount']} correctRow={result['fkBadgeOnCorrectRow']}")
    if result["hasIsForeignKeyField"]:
        problems.append("expected isForeignKey to be DERIVED (never stored on the attribute object) -- found a stored isForeignKey key")
    if result["fromOptionLabels"] != ['(none)', 'order_id']:
        problems.append(f"expected From Attribute options scoped to t1's own attributes ['(none)', 'order_id'], got {result['fromOptionLabels']}")
    if result["toOptionLabels"] != ['(none)', 'id']:
        problems.append(f"expected To Attribute options scoped to t2's own attributes ['(none)', 'id'], got {result['toOptionLabels']}")
    if result["attributesAfterReload"] != attrs:
        problems.append(f"expected Part.attributes to survive a Save/Load JSON round-trip unchanged, got {result['attributesAfterReload']}")
    expectedConnFields = {"connectorType": "d", "fromAttribute": result["t1AttrsAfterUI"][0]["id"], "toAttribute": "regr-b1", "fromCardinality": "", "toCardinality": ""}
    if result["connFieldsAfterReload"] != expectedConnFields:
        problems.append(f"expected connector's connectorType/fromAttribute/toAttribute/fromCardinality/toCardinality to survive a Save/Load JSON round-trip, expected {expectedConnFields}, got {result['connFieldsAfterReload']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "DataEntityDetails' attribute list (add/edit/delete via the 'a' showFields widget), derived (not stored) FK badges, dependent From/To Attribute dropdown scoping, and Save/Load JSON round-tripping of Part.attributes + connector's data-modeling fields all work correctly"


def check_data_modeling_crowfoot_rendering(page):
    """Regression guard for crow's-foot marker rendering (canvas.js's drawEdge +
    CARDINALITY_LINE_ENDS, public/custom.json's lineEnds crowOne/crowMany/
    crowZeroOrOne/crowOneOrMany). Covers: (1) each of the four cardinality values
    (one/many/zeroOrOne/oneOrMany) produces a DISTINCT marker-start/marker-end
    reference on the rendered connector path -- not all collapsing to the same
    symbol, and not falling back to a relationship-driven marker when a real
    cardinality is set; (2) a 'd' connector with NO cardinality set (fresh, before
    configuring) falls back gracefully to the relationship-driven lineEnds lookup
    instead of rendering with no marker at all or throwing; (3) a REAL bug found and
    fixed during this feature's own development: crowZeroOrOne's circle was
    originally centered at a negative Y that fell outside the shared marker
    viewBox (buildMarkerDefs' hardcoded "-12 -2 24 24", Y range -2..22), silently
    CLIPPING almost the entire circle down to an unrecognizable sliver -- confirmed
    visually via a zoomed screenshot during development, not caught by any
    DOM-attribute-only check (the marker's fill/stroke/path attributes are all
    "correct" even when badly positioned; only the geometry matters). This check
    parses the actual custom.json path data for the circle arc's start point + radius
    and asserts its computed Y-bounds stay within the marker's own viewBox, which
    directly reproduces (and would catch a regression of) that specific bug;
    (4) the new 'Data' toolbar/view visibility toggle (chkShowDataType,
    view.chkShowConnectorType's new sibling) actually hides/shows 'd' connectors
    independently of 'c'/'s' ones."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.addView('RegrCrowfoot_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const mkConn = (fromCardinality, toCardinality) => {
        const t1 = store.createPart({ type: 'DataEntityDetails', label: 'L', model, streams: [] });
        const t2 = store.createPart({ type: 'DataEntityDetails', label: 'R', model, streams: [] });
        const vm1 = store.createViewMember({ view: view.id, objectType: 'part', objectId: t1.id, x: 0, y: 0 });
        const vm2 = store.createViewMember({ view: view.id, objectType: 'part', objectId: t2.id, x: 300, y: 0 });
        const conn = store.createConnector({ from: t1.id, to: t2.id, connectorType: 'd', model, relationship: 'Association', fromCardinality, toCardinality });
        const connVm = store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: vm1.id, toVmId: vm2.id });
        return connVm.id;
      };

      const cardinalities = ['one', 'many', 'zeroOrOne', 'oneOrMany'];
      const connVmIds = cardinalities.map((c) => mkConn(c, c));
      const noneVmId = mkConn('', ''); // fresh 'd' connector, no cardinality configured yet
      app.recordAndRender();

      const markerRefOf = (connVmId, attr) => {
        const pathEl = document.querySelector(`.edge-hit[data-vm-id="${connVmId}"]`)?.previousElementSibling;
        return pathEl ? pathEl.getAttribute(attr) : null;
      };
      const markerEnds = cardinalities.map((c, i) => markerRefOf(connVmIds[i], 'marker-end'));
      const noneMarkerEnd = markerRefOf(noneVmId, 'marker-end'); // should fall back, not be null

      // (3) parse the ACTUAL shipped lineEnds path data for the zeroOrOne circle's arc
      // start point + radius, compute its Y bounds, and confirm they fit the marker's
      // own viewBox (hardcoded in buildMarkerDefs, canvas.js) -- reproduces the exact
      // clipping bug found during development.
      const circlePath = store.settings.lineEnds.crowZeroOrOne.path;
      const arcMatch = circlePath.match(/M\\s*(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+a\\s+([\\d.]+)/);
      const circleStartY = arcMatch ? parseFloat(arcMatch[2]) : null;
      const circleRadius = arcMatch ? parseFloat(arcMatch[3]) : null;
      // the arc's start point sits on the circle's own horizontal diameter (same
      // pattern as the pre-existing, working 'circleSmall' lineEnd), so the circle's
      // vertical extent is [startY - r, startY + r].
      const circleMinY = circleStartY - circleRadius, circleMaxY = circleStartY + circleRadius;
      const viewBoxMinY = -2, viewBoxMaxY = 22; // buildMarkerDefs' hardcoded marker viewBox="-12 -2 24 24"

      // (4) chkShowDataType visibility toggle
      view.chkShowDataType = false;
      app.recordAndRender();
      const hiddenWhileOff = !document.querySelector(`.edge-hit[data-vm-id="${connVmIds[0]}"]`);
      view.chkShowDataType = true;
      app.recordAndRender();
      const visibleWhenOn = !!document.querySelector(`.edge-hit[data-vm-id="${connVmIds[0]}"]`);

      return { markerEnds, noneMarkerEnd, circleMinY, circleMaxY, viewBoxMinY, viewBoxMaxY, hiddenWhileOff, visibleWhenOn };
    }
    """)
    problems = []
    expectedMarkers = {'one': 'crowOne', 'many': 'crowMany', 'zeroOrOne': 'crowZeroOrOne', 'oneOrMany': 'crowOneOrMany'}
    cardinalities = ['one', 'many', 'zeroOrOne', 'oneOrMany']
    for i, card in enumerate(cardinalities):
        ref = result["markerEnds"][i] or ''
        if f'marker-crow' not in ref or expectedMarkers[card] not in ref:
            problems.append(f"expected cardinality '{card}' to reference marker '{expectedMarkers[card]}', got {ref!r}")
    if len(set(result["markerEnds"])) != 4:
        problems.append(f"expected all 4 cardinality values to produce 4 DISTINCT markers, got {result['markerEnds']}")
    if not result["noneMarkerEnd"]:
        problems.append("expected a 'd' connector with no cardinality set to still fall back to a relationship-driven marker, got none at all")
    if result["circleMinY"] < result["viewBoxMinY"] or result["circleMaxY"] > result["viewBoxMaxY"]:
        problems.append(f"crowZeroOrOne's circle (Y range {result['circleMinY']}..{result['circleMaxY']}) falls outside the marker's own viewBox (Y range {result['viewBoxMinY']}..{result['viewBoxMaxY']}) -- this is the exact clipping bug found during development, where the circle rendered as an unrecognizable sliver")
    if not result["hiddenWhileOff"]:
        problems.append("expected chkShowDataType=false to hide 'd' connectors")
    if not result["visibleWhenOn"]:
        problems.append("expected chkShowDataType=true to show 'd' connectors again")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "crow's-foot markers (one/many/zeroOrOne/oneOrMany) render as 4 distinct markers with a graceful relationship-driven fallback when unconfigured, the zeroOrOne circle stays within the shared marker viewBox, and the Data visibility toggle independently hides/shows 'd' connectors"


def check_data_modeling_menu_and_ddl_import_export(page):
    """Regression guard for the "Data Modeling" menu (index.html, main.js) and its
    three commands, driven through the REAL menu/file-input UI (not calling
    commands.js's importDDL/exportDDL directly), covering: (1) Import DDL... (file
    input #import-ddl-input, same DataTransfer/File/Blob synthetic-upload pattern
    check_archimate_import_fixture already uses) creates one DataEntityDetails part
    per CREATE TABLE with the right attributes, a 'd' connector for the FOREIGN KEY
    with fromAttribute/toAttribute correctly resolved, and reports a specific,
    non-generic error toast (not a silent no-op or an uncaught exception) for
    malformed DDL; (2) Export DDL (promptExportDDL) shows the regenerated DDL text in
    the same readonly viewer Code Summary uses, scoped to the CURRENT view only, and
    reports a specific error toast (not a blank/empty export) when the current view
    has no DataEntityDetails tables at all; (3) Add/Edit Entity Details
    (promptAddEditEntityDetails) requires exactly one DataDataEntity node selected
    (rejects zero/multiple selections and non-DataDataEntity types with a specific
    toast each), and delegates to the SAME Part-level decomposition guard
    openOrCreateLinkedView uses (see check_level_down_reuses_existing_decomposition_
    across_viewmembers) -- reusing an existing decomposition rather than creating a
    second one, proven here via the MENU entry point specifically, not just the
    double-click one."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;

      const uploadDDL = (text) => {
        const blob = new Blob([text], { type: 'text/plain' });
        const file = new File([blob], 'schema.sql', { type: 'text/plain' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.getElementById('import-ddl-input');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const clickMenuItem = async (action) => {
        document.getElementById('data-modeling-menu-btn').click();
        await new Promise(r => setTimeout(r, 40));
        document.querySelector(`[data-action="${action}"]`).click();
        await new Promise(r => setTimeout(r, 40));
      };
      // toasts stack and persist for several seconds (auto-removed after 3.5-6s), so
      // multiple can coexist in the DOM at once -- grab the MOST RECENTLY added one
      // (toasts are appended, so the last DOM match is the newest), not the first.
      const lastToast = () => { const all = document.querySelectorAll('.toast'); return all.length ? all[all.length - 1].textContent : null; };

      // (1) valid DDL import via the real file input
      uploadDDL('CREATE TABLE regr_customers (id INTEGER NOT NULL, name VARCHAR(50), PRIMARY KEY (id));\\n' +
                'CREATE TABLE regr_orders (id INTEGER NOT NULL PRIMARY KEY, customer_id INTEGER NOT NULL, FOREIGN KEY (customer_id) REFERENCES regr_customers(id));');
      await new Promise(r => setTimeout(r, 300));
      const importToast = lastToast();
      const importedView = store.doc.views.find(v => v.viewName.startsWith('DDL Import'));
      const importedParts = importedView ? store.viewMembersForView(importedView.id).filter(v => v.objectType === 'part').map(v => store.findPart(v.objectId)) : [];
      const custTable = importedParts.find(p => p.label === 'regr_customers');
      const orderTable = importedParts.find(p => p.label === 'regr_orders');
      const importedConn = importedView ? store.doc.connectors.find(c => c.connectorType === 'd' && c.from === orderTable?.id && c.to === custTable?.id) : null;
      const fkAttrsResolved = importedConn && custTable && orderTable
        ? { fromName: orderTable.attributes.find(a => a.id === importedConn.fromAttribute)?.name, toName: custTable.attributes.find(a => a.id === importedConn.toAttribute)?.name }
        : null;

      // (1b) malformed DDL -> specific error toast, no crash, no partial table created
      const priorPartCount = store.doc.parts.length;
      uploadDDL('CREATE TABLE broken (@#$%);');
      await new Promise(r => setTimeout(r, 300));
      const malformedToast = lastToast();
      const partCountUnchanged = store.doc.parts.length === priorPartCount;

      // (2) Export DDL via the real menu, scoped to the imported view
      app.switchToTab((store.tabs.find(t => t.viewId === importedView.id) || app.createCanvasTab(importedView)).id);
      await clickMenuItem('exportDDL');
      const exportedText = document.querySelector('.modal-box textarea')?.value || null;
      document.querySelector('.modal-box .close')?.click();
      await new Promise(r => setTimeout(r, 40));

      // (2b) Export DDL on a view with no DataEntityDetails tables -> specific error toast
      const emptyView = store.addView('RegrEmptyExport_' + Date.now(), 'ff');
      app.switchToTab(app.createCanvasTab(emptyView).id);
      await clickMenuItem('exportDDL');
      const emptyExportToast = lastToast();
      const noDialogOnEmptyExport = !document.querySelector('.modal-box.modal-box-textedit');

      // (3) Add/Edit Entity Details selection guards
      await clickMenuItem('addEditEntityDetails'); // nothing selected
      const noSelectionToast = lastToast();

      const dm1 = store.createPart({ type: 'DataDataEntity', label: 'RegrMenuEntity_' + Date.now(), model, streams: [] });
      const vmA = store.createViewMember({ view: emptyView.id, objectType: 'part', objectId: dm1.id, x: 0, y: 0 });
      const viewB = store.addView('RegrMenuEntityB_' + Date.now(), 'ff');
      const tabB = app.createCanvasTab(viewB);
      const vmB = store.createViewMember({ view: viewB.id, objectType: 'part', objectId: dm1.id, x: 0, y: 0 });
      app.recordAndRender();

      app.switchToTab(app.store.tabs.find(t => t.viewId === emptyView.id).id);
      const tabA = app.store.activeTab();
      tabA.selection = new Set([vmA.id]);
      app.render();
      await clickMenuItem('addEditEntityDetails'); // first decomposition, via the menu
      const firstLinkedView = vmA.linkedViewName;

      app.switchToTab(tabB.id);
      tabB.selection = new Set([vmB.id]);
      app.render();
      await clickMenuItem('addEditEntityDetails'); // same Part, different ViewMember -- should REUSE
      const secondLinkedView = vmB.linkedViewName;

      return {
        importToast, importedPartCount: importedParts.length,
        custAttrCount: custTable ? custTable.attributes.length : null,
        orderAttrCount: orderTable ? orderTable.attributes.length : null,
        fkAttrsResolved,
        malformedToast, partCountUnchanged,
        exportedText,
        emptyExportToast, noDialogOnEmptyExport,
        noSelectionToast,
        firstLinkedView, secondLinkedView, sameDecomposition: firstLinkedView === secondLinkedView,
      };
    }
    """)
    problems = []
    if 'Imported 2 tables, 1 foreign key' not in (result["importToast"] or ''):
        problems.append(f"expected a specific 'Imported 2 tables, 1 foreign key...' toast, got {result['importToast']!r}")
    if result["importedPartCount"] != 2 or result["custAttrCount"] != 2 or result["orderAttrCount"] != 2:
        problems.append(f"expected 2 imported DataEntityDetails parts with 2 attributes each, got count={result['importedPartCount']} custAttrs={result['custAttrCount']} orderAttrs={result['orderAttrCount']}")
    if result["fkAttrsResolved"] != {"fromName": "customer_id", "toName": "id"}:
        problems.append(f"expected the FK 'd' connector's fromAttribute/toAttribute to resolve to customer_id/id, got {result['fkAttrsResolved']}")
    if not result["malformedToast"] or "failed" not in result["malformedToast"].lower():
        problems.append(f"expected a specific 'DDL import failed: ...' toast for malformed DDL, got {result['malformedToast']!r}")
    if not result["partCountUnchanged"]:
        problems.append("expected malformed DDL import to create NOTHING (no partial tables), not even the tables before the bad entry")
    if 'CREATE TABLE regr_customers' not in (result["exportedText"] or '') or 'FOREIGN KEY' not in (result["exportedText"] or ''):
        problems.append(f"expected Export DDL to show regenerated DDL text including both tables and the FOREIGN KEY, got {result['exportedText']!r}")
    if not result["emptyExportToast"] or "no data entity details" not in result["emptyExportToast"].lower():
        problems.append(f"expected a specific error toast exporting a view with no DataEntityDetails tables, got {result['emptyExportToast']!r}")
    if not result["noDialogOnEmptyExport"]:
        problems.append("expected NO export dialog to open when the view has nothing to export")
    if not result["noSelectionToast"] or "select" not in result["noSelectionToast"].lower():
        problems.append(f"expected a specific 'select a...' toast when Add/Edit Entity Details is used with nothing selected, got {result['noSelectionToast']!r}")
    if not result["sameDecomposition"]:
        problems.append(f"expected Add/Edit Entity Details, run via the MENU on two different ViewMembers of the same Part, to reuse the same decomposition (not create two), got {result['firstLinkedView']!r} vs {result['secondLinkedView']!r}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "the Data Modeling menu's Import DDL/Export DDL/Add-Edit Entity Details all work through the real UI, with specific error toasts (not silent failures or crashes) for malformed DDL, empty exports, and missing selections, and Add/Edit Entity Details reuses an existing decomposition across ViewMembers via the menu entry point too"


def check_data_modeling_node_attributes_and_manual_connector_creation(page):
    """Regression guard for three real gaps reported directly after the Data Modeling
    feature first shipped: "attributes on dataentitydetail are not appearing visually
    on node. unable to enable FK. unable to create crows foot connector with another
    dataentitydetail, or at datadataentity level." Root causes: (1) buildNodeEl
    (canvas.js) never rendered Part.attributes at all — only the property panel did;
    (2) drag-to-connect (main.js's beginConnect/finishConnect) hardcoded
    connectorType:'c' unconditionally, so there was literally no way to create a 'd'
    connector via the canvas UI (DDL import was the only path); (3) connectorType's
    own showFields entry was `access:'r'` (readonly text) with no edit surface
    anywhere (property panel, edge popover, or context menu) — even an existing
    connector's type could never be changed, so there was no manual escape hatch
    either. "unable to enable FK" was a direct downstream consequence of (2)/(3): FK
    is derived from a 'd' connector's fromAttribute (see check_data_modeling_
    attributes_and_data_connector), and a person could never get a 'd' connector to
    exist at all through the UI. Fixed: (1) buildNodeEl now renders an attribute list
    (name : dataType, PK marked, live FK lookup via the shared isAttributeForeignKey)
    when the part is DataEntityDetails, gated by a new per-view chkShowAttributes
    toggle (sibling to chkShowDescription/chkShowKeys) — proven here by reading the
    real rendered node's own innerText, not just checking Part.attributes exists; (2)
    beginConnect now infers connectorType:'d' automatically when BOTH drag endpoints
    are DataEntityDetails (mirroring how 's' is already inferred by context
    elsewhere), still 'c' for every other type pairing (including DataDataEntity ->
    DataDataEntity, addressing the "or at datadataentity level" half of the report);
    (3) connectorType is now a genuine editable `'s'` select (public/custom.json:
    show/access both flipped) with real options, so ANY connector's type can be
    changed after the fact regardless of how it was created — the general-purpose fix
    that makes both problems recoverable even outside the one auto-inferred case."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.addView('RegrDMNode_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const t1 = store.createPart({ type: 'DataEntityDetails', label: 'RegrOrders', model, streams: [],
        attributes: [
          { id: 'ra1', name: 'id', dataType: 'INTEGER', nullable: false, isPrimaryKey: true },
          { id: 'ra2', name: 'customer_id', dataType: 'INTEGER', nullable: false, isPrimaryKey: false },
        ] });
      const t2 = store.createPart({ type: 'DataEntityDetails', label: 'RegrCustomers', model, streams: [],
        attributes: [{ id: 'rb1', name: 'id', dataType: 'INTEGER', nullable: false, isPrimaryKey: true }] });
      const vm1 = store.createViewMember({ view: view.id, objectType: 'part', objectId: t1.id, x: 60, y: 60 });
      const vm2 = store.createViewMember({ view: view.id, objectType: 'part', objectId: t2.id, x: 400, y: 60 });
      app.recordAndRender();

      // (1) attribute list rendered ON the node itself
      const nodeEl = document.querySelector(`[data-vm-id="${vm1.id}"]`);
      const nodeText = nodeEl.innerText;
      const hasAttributesEl = !!nodeEl.querySelector('.fnode-attributes');

      // toggle chkShowAttributes off -> the node's own attribute rows disappear
      view.chkShowAttributes = false;
      app.recordAndRender();
      const hiddenWhenToggledOff = !document.querySelector(`[data-vm-id="${vm1.id}"] .fnode-attributes`);
      view.chkShowAttributes = true;
      app.recordAndRender();

      // (2) drag-to-connect between two DataEntityDetails infers 'd'
      app.beginConnect(tab, vm1.id, vm2.id, 0, 0);
      const ddConn = store.doc.connectors.find(c => c.from === t1.id && c.to === t2.id);
      const ddConnectorType = ddConn ? ddConn.connectorType : null;

      // (2b) drag-to-connect between two DataDataEntity (NOT DataEntityDetails) stays 'c'
      const dd1 = store.createPart({ type: 'DataDataEntity', label: 'RegrParentA', model, streams: [] });
      const dd2 = store.createPart({ type: 'DataDataEntity', label: 'RegrParentB', model, streams: [] });
      const vmDd1 = store.createViewMember({ view: view.id, objectType: 'part', objectId: dd1.id, x: 60, y: 300 });
      const vmDd2 = store.createViewMember({ view: view.id, objectType: 'part', objectId: dd2.id, x: 400, y: 300 });
      app.beginConnect(tab, vmDd1.id, vmDd2.id, 0, 0);
      const plainConn = store.doc.connectors.find(c => c.from === dd1.id && c.to === dd2.id);
      const plainConnectorType = plainConn ? plainConn.connectorType : null;

      // (3) FK becomes settable once a 'd' connector exists -- set fromAttribute (and
      // toAttribute to t2's own primary key, a realistic FK->PK reference -- FK
      // derivation looks at BOTH ends, see isAttributeForeignKey's own doc comment)
      // and confirm the node's own rendering picks it up live
      ddConn.fromAttribute = 'ra2';
      ddConn.toAttribute = 'rb1';
      app.recordAndRender();
      const nodeTextAfterFk = document.querySelector(`[data-vm-id="${vm1.id}"]`).innerText;

      // (3b) connectorType is now a real, editable select in the property panel
      const connVm = store.viewMembersForView(view.id).find(v => v.objectType === 'connector' && v.objectId === ddConn.id);
      tab.selection = new Set([connVm.id]);
      app.render();
      const sel = [...document.querySelectorAll('select')].find(s => s.id.includes('connectorType'));
      const selReadonly = sel ? sel.disabled : null;
      const selOptions = sel ? [...sel.options].map(o => o.value) : null;
      // actually change it via the real select + change event, confirm it persists
      let changedType = null;
      if (sel) {
        sel.value = 's';
        sel.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 30));
        changedType = store.findConnector(ddConn.id).connectorType;
      }

      return {
        nodeText, hasAttributesEl, hiddenWhenToggledOff,
        ddConnectorType, plainConnectorType,
        nodeTextAfterFk,
        selReadonly, selOptions, changedType,
      };
    }
    """)
    problems = []
    if 'id: INTEGER' not in result["nodeText"] or 'customer_id: INTEGER' not in result["nodeText"]:
        problems.append(f"expected the node's own rendered text to include its attributes (name: dataType), got {result['nodeText']!r}")
    if not result["hasAttributesEl"]:
        problems.append("expected the node to have a .fnode-attributes element")
    if not result["hiddenWhenToggledOff"]:
        problems.append("expected chkShowAttributes=false to hide the node's own attribute list")
    if result["ddConnectorType"] != 'd':
        problems.append(f"expected dragging between two DataEntityDetails nodes to create a 'd' connector, got {result['ddConnectorType']!r}")
    if result["plainConnectorType"] != 'c':
        problems.append(f"expected dragging between two DataDataEntity nodes to stay a plain 'c' connector, got {result['plainConnectorType']!r}")
    if 'customer_id (FK): INTEGER' not in result["nodeTextAfterFk"]:
        problems.append(f"expected the node's own rendering to show the FK marker once the drag-created connector's fromAttribute was set, got {result['nodeTextAfterFk']!r}")
    if result["selReadonly"] is not False or result["selOptions"] != ['c', 's', 'd']:
        problems.append(f"expected connectorType to be a genuine, enabled select with options ['c','s','d'], got disabled={result['selReadonly']} options={result['selOptions']}")
    if result["changedType"] != 's':
        problems.append(f"expected changing the connectorType select to 's' to actually persist to the connector, got {result['changedType']!r}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "DataEntityDetails nodes render their own attribute list on the canvas (toggleable via chkShowAttributes), drag-to-connect infers connectorType 'd' between two DataEntityDetails (staying 'c' for other type pairs like DataDataEntity), and connectorType is now a genuinely editable select so FK relationships (and any other type change) are always reachable through the UI"


def check_data_entity_details_sizing_fits_attribute_count(page):
    """Regression guard for a real bug, reported directly with an exact failing DDL
    fixture (two tables, 9 and 8 columns): "data entity detail does not get sized
    correctly upon creation, using remap, or redraw." redrawNodeSizes (canvas.js) --
    the SAME content-measuring function importDDL/Remap/Redraw all funnel through --
    clamped view.nodeHeight to a 140px ceiling, which a DataEntityDetails node's own
    on-canvas attribute list (chkShowAttributes) already exceeds at around 8-9 columns
    (ordinary, not a pathological case) -- .fnode has no overflow:hidden, so this wasn't
    invisible clipping, it visually overflowed past the node's own fixed-height box.
    Covers: right after File > Import DDL with the exact reported fixture,
    view.nodeHeight is NOT clamped to the old 140px ceiling (it's tall enough that
    every attribute row's own bounding rect falls within the rendered node's box, i.e.
    nothing hangs out below it); the SAME correct, non-clamped height still holds after
    both the Redraw command AND a real Remap call -- not just at creation, matching all
    three paths named in the report."""
    ddl = """CREATE TABLE legal_entities (
    entity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_name VARCHAR(255) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    formation_date DATE,
    jurisdiction VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'Active',
    parent_entity_id UUID REFERENCES legal_entities(entity_id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE Trust_Ledger_Entries (
    trust_ledger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL,
    entity_id UUID REFERENCES legal_entities(entity_id),
    transaction_type VARCHAR(50) NOT NULL,
    amount NUMERIC(15, 2) NOT NULL,
    balance_after NUMERIC(15, 2) NOT NULL,
    transaction_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    description TEXT
);"""
    result = js(page, f"""
    async () => {{
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const ddl = {json.dumps(ddl)};
      commands.importDDL(app, ddl);
      await new Promise(r => setTimeout(r, 150));
      const view = store.findView(store.currentView);
      const tab = store.activeTab();

      const measureFit = () => {{
        const nodeBottoms = new Map();
        for (const el of document.querySelectorAll('.fnode')) {{
          const box = el.getBoundingClientRect();
          nodeBottoms.set(el, box.bottom);
        }}
        let allRowsFit = true;
        const details = [];
        for (const [nodeEl, bottom] of nodeBottoms) {{
          const rows = nodeEl.querySelectorAll('.fnode-attr-row');
          let lastRowBottom = 0;
          for (const row of rows) lastRowBottom = Math.max(lastRowBottom, row.getBoundingClientRect().bottom);
          const fits = rows.length === 0 || lastRowBottom <= bottom + 0.5;
          if (!fits) allRowsFit = false;
          details.push({{ rowCount: rows.length, fits }});
        }}
        return {{ allRowsFit, details }};
      }};

      const afterCreate = {{ nodeHeight: view.nodeHeight, ...measureFit() }};

      // Redraw now opens a dialog (the new "Show all text" checkbox) instead of
      // running immediately -- click its own Redraw submit button.
      app.runCommand('redraw');
      await new Promise(r => setTimeout(r, 30));
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 150));
      const afterRedraw = {{ nodeHeight: view.nodeHeight, ...measureFit() }};

      commands.remap(app, tab, {{ pattern: 'default' }});
      await new Promise(r => setTimeout(r, 150));
      const afterRemap = {{ nodeHeight: view.nodeHeight, ...measureFit() }};

      return {{ afterCreate, afterRedraw, afterRemap }};
    }}
    """)
    problems = []
    for label, snapshot in [("creation", result["afterCreate"]), ("Redraw", result["afterRedraw"]), ("Remap", result["afterRemap"])]:
        if snapshot["nodeHeight"] >= 140 and snapshot["nodeHeight"] <= 145:
            problems.append(f"expected view.nodeHeight to NOT sit right at the old 140px clamp after {label}, got {snapshot['nodeHeight']}")
        if not snapshot["allRowsFit"]:
            problems.append(f"expected every attribute row to fit within its node's own rendered box after {label}, got {snapshot['details']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "a DataEntityDetails node with a realistic 8-9 column attribute list sizes tall enough to show every row, on creation (Import DDL), Redraw, and Remap alike"


def check_textarea_height_persisted_per_field(page):
    """Regression guard, reported directly: "when property resizable text fields are
    lengthened by user (lower right corner dragged) can that be persisted for the
    user for that property in any view for current session and future sessions.
    currently the resize is lost when user clicks away from the node." A
    ResizeObserver (wireFieldHeightPersistence, render.js) now persists a textarea's
    own height to localStorage (dycad-field-heights) keyed by field NAME alone (not
    entity-qualified) whenever it genuinely changes size. Covers: (1) resizing the
    Note textarea (simulated via a direct style.height change, same real box-size
    change a native drag-resize produces) persists it; (2) a full panel rebuild
    (deselect then reselect, exactly what "clicks away from the node" does — the
    reported bug) picks the saved height back up, instead of resetting to default;
    (3) "for that property in any view" — a DIFFERENT part's SAME field (Note) also
    picks up the identical saved height, and a genuinely different field (Description)
    does NOT; (4) a real bug found during testing: deselecting itself (which removes
    the old textarea from the DOM) must NOT overwrite the just-saved height with a
    bogus 0px (ResizeObserver's own final callback on a removed element reports a
    0x0 rect) — proven by checking the stored height survives a deselect intact;
    (5) File > Save/Load Local Settings round-trips fieldHeights, same as pinnedFields
    already does."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const render = await import('./js/render.js');
      localStorage.removeItem('dycad-field-heights');
      const view = store.doc.views[0];
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const partA = store.createPart({ type: 'BusinessFunction', label: 'RegrHeightA', model: store.defaultModel, streams: [], note: 'note A', description: 'description A' });
      const partB = store.createPart({ type: 'BusinessFunction', label: 'RegrHeightB', model: store.defaultModel, streams: [], note: 'note B', description: 'description B' });
      const vmA = store.createViewMember({ view: view.id, objectType: 'part', objectId: partA.id, x: 40, y: 40 });
      const vmB = store.createViewMember({ view: view.id, objectType: 'part', objectId: partB.id, x: 300, y: 40 });

      tab.selection = new Set([vmA.id]);
      app.render();
      await new Promise(r => setTimeout(r, 60));
      const noteTextarea = document.getElementById('sf-part-note');
      const originalHeight = noteTextarea.getBoundingClientRect().height;
      noteTextarea.style.height = (originalHeight + 90) + 'px';
      await new Promise(r => setTimeout(r, 150));

      const out = {};
      out.storedAfterResize = { ...render.getAllFieldHeights() };

      // deselect (removes the textarea from the DOM) -- must NOT zero out the height
      tab.selection = new Set();
      app.render();
      await new Promise(r => setTimeout(r, 100));
      out.storedAfterDeselect = { ...render.getAllFieldHeights() };

      // reselect the SAME part -- rebuilt textarea should come back at the saved height
      tab.selection = new Set([vmA.id]);
      app.render();
      await new Promise(r => setTimeout(r, 60));
      out.rebuiltSameFieldHeight = document.getElementById('sf-part-note').style.height;

      // a DIFFERENT part's SAME field name picks up the identical saved height
      tab.selection = new Set([vmB.id]);
      app.render();
      await new Promise(r => setTimeout(r, 60));
      out.otherPartSameFieldHeight = document.getElementById('sf-part-note').style.height;
      // a genuinely different field is NOT affected
      out.otherFieldHeight = document.getElementById('sf-part-description').style.height;

      // Local Settings round-trip
      const saved = render.getAllFieldHeights();
      render.setAllFieldHeights({});
      out.clearedHeights = { ...render.getAllFieldHeights() };
      render.setAllFieldHeights(saved);
      out.restoredHeights = { ...render.getAllFieldHeights() };

      return out;
    }
    """)
    problems = []
    if not result["storedAfterResize"].get("note") or result["storedAfterResize"]["note"] < 100:
        problems.append(f"expected resizing the Note textarea to persist a real height under 'note', got {result['storedAfterResize']}")
    if result["storedAfterDeselect"].get("note") != result["storedAfterResize"].get("note"):
        problems.append(f"expected deselecting (which removes the textarea from the DOM) to NOT overwrite the saved height with a bogus 0px, got {result['storedAfterDeselect']} vs originally {result['storedAfterResize']}")
    if not result["rebuiltSameFieldHeight"] or result["rebuiltSameFieldHeight"] == "44px":
        problems.append(f"expected the rebuilt Note textarea (after deselect+reselect) to come back at the saved height, got {result['rebuiltSameFieldHeight']}")
    elif result["rebuiltSameFieldHeight"] != f"{result['storedAfterResize']['note']}px":
        problems.append(f"expected the rebuilt Note textarea's height to exactly match the stored value, got {result['rebuiltSameFieldHeight']} vs stored {result['storedAfterResize']['note']}")
    if result["otherPartSameFieldHeight"] != result["rebuiltSameFieldHeight"]:
        problems.append(f"expected a DIFFERENT part's Note field to share the identical saved height ('for that property in any view'), got {result['otherPartSameFieldHeight']} vs {result['rebuiltSameFieldHeight']}")
    if result["otherFieldHeight"] == result["rebuiltSameFieldHeight"]:
        problems.append(f"expected Description's own height to be independent of Note's, got both {result['otherFieldHeight']}")
    if result["clearedHeights"]:
        problems.append(f"expected setAllFieldHeights({{}}) to genuinely clear stored heights, got {result['clearedHeights']}")
    if result["restoredHeights"].get("note") != result["storedAfterResize"].get("note"):
        problems.append(f"expected setAllFieldHeights to restore exactly what getAllFieldHeights returned (Local Settings round-trip), got {result['restoredHeights']} vs {result['storedAfterResize']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "A resized textarea's height is persisted per field name (dycad-field-heights), survives the exact rebuild that used to lose it (deselecting the node), doesn't get zeroed out by the element's own removal from the DOM, is shared across different parts using the same field, stays independent per field, and round-trips through Local Settings"


def check_redraw_dialog_show_all_text(page):
    """Regression guard, reported directly: "In redraw command for a view, add option
    something like 'show all text' checkbox and if selected resize default size for
    text that fits and full size that displays all text of node such as long
    descriptions. And retain setting for the specific view for future sessions."
    Redraw previously ran immediately with no dialog; it now opens one with a single
    "Show all text" checkbox. Covers: (1) unchecked by default on a fresh view; (2)
    leaving it unchecked reproduces today's existing behavior (description still
    2-line-clamped, smaller nodeHeight); (3) checking it grows nodeHeight further AND
    the actually-rendered node's own .fnode-description genuinely loses its line-clamp
    (not just a bigger box with the same truncated text); (4) the checked state is
    retained on THIS view for next time (view.chkShowAllText, reopening Redraw here
    defaults to checked); (5) a DIFFERENT, unrelated view's own Redraw dialog is
    NOT affected (defaults to unchecked) -- proving this is genuinely per-view, not a
    global setting."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const longDesc = 'A genuinely long description with enough words to definitely wrap past two lines when fully shown, since the whole point of this checkbox is to prove the extra text really becomes visible instead of staying clamped.';
      const view = store.addView('RegrRedrawShowAllText_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const part = store.createPart({ type: 'BusinessFunction', label: 'RegrRedrawShowAllTextPart', model: store.defaultModel, streams: [], description: longDesc });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x: 40, y: 40 });
      view.chkShowDescription = true;

      const out = {};

      app.promptRedraw(tab);
      await new Promise(r => setTimeout(r, 30));
      out.defaultUnchecked = !document.getElementById('redraw-show-all-text').checked;
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 60));
      out.heightOff = view.nodeHeight;
      out.chkShowAllTextOff = view.chkShowAllText;
      app.render();
      await new Promise(r => setTimeout(r, 30));
      out.descStyleOff = document.querySelector('.fnode-description')?.getAttribute('style') || null;

      app.promptRedraw(tab);
      await new Promise(r => setTimeout(r, 30));
      document.getElementById('redraw-show-all-text').checked = true;
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 60));
      out.heightOn = view.nodeHeight;
      out.chkShowAllTextOn = view.chkShowAllText;
      app.render();
      await new Promise(r => setTimeout(r, 30));
      out.descStyleOn = document.querySelector('.fnode-description')?.getAttribute('style') || null;

      // reopening on the SAME view retains the checked state
      app.promptRedraw(tab);
      await new Promise(r => setTimeout(r, 30));
      out.retainedOnSameView = document.getElementById('redraw-show-all-text').checked;
      document.querySelector('.modal-overlay .cancel').click();

      // a DIFFERENT view is unaffected
      const otherView = store.addView('RegrRedrawShowAllTextOther_' + Date.now(), 'ff');
      const otherTab = app.createCanvasTab(otherView);
      app.switchToTab(otherTab.id);
      app.promptRedraw(otherTab);
      await new Promise(r => setTimeout(r, 30));
      out.uncheckedOnOtherView = !document.getElementById('redraw-show-all-text').checked;
      document.querySelector('.modal-overlay .cancel').click();

      return out;
    }
    """)
    problems = []
    if not result["defaultUnchecked"]:
        problems.append("expected 'Show all text' unchecked by default on a fresh view")
    if result["chkShowAllTextOff"]:
        problems.append("expected view.chkShowAllText to stay false after submitting unchecked")
    if result["descStyleOff"] is not None:
        problems.append(f"expected the rendered description to have NO clamp-override style when off, got {result['descStyleOff']!r}")
    if not result["chkShowAllTextOn"]:
        problems.append("expected view.chkShowAllText to be set true after submitting checked")
    if result["descStyleOn"] != "-webkit-line-clamp:unset;display:block;overflow:visible;":
        problems.append(f"expected the rendered description to genuinely lose its line-clamp when on, got {result['descStyleOn']!r}")
    if result["heightOn"] <= result["heightOff"]:
        problems.append(f"expected nodeHeight to grow further with 'Show all text' checked (full description) than unchecked (2-line clamp), got off={result['heightOff']} on={result['heightOn']}")
    if not result["retainedOnSameView"]:
        problems.append("expected reopening Redraw on the SAME view to retain the checked state")
    if not result["uncheckedOnOtherView"]:
        problems.append("expected a DIFFERENT view's own Redraw dialog to default to unchecked (per-view, not global)")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Redraw's new 'Show all text' checkbox defaults to unchecked, growing nodeHeight further and genuinely removing the description's line-clamp at render time when checked, is retained per-view for next time, and doesn't leak to other views"


def check_data_modeling_attribute_editing_and_auto_fk(page):
    """Regression guard for six issues reported directly in one follow-up round on the
    Data Modeling feature: "when keying in data entity details attributes, tab should
    take user to next field ... need ability to move attribute up or down. type should
    be drop down list of acceptable types ... unable to enable pk in property panel
    attribute section for dataentitydetail. when connector dragged/created, auto create
    a fk in target of primary key from source, if it doesn't exist ... Auto populate
    From Cardinality as One, and To Cardinality as Many ... problem: double click on
    datadataentity or menu data Modeling -> add edit entity details creates a new
    datadataentity, should be a dataentitydetail element for the details." Root causes
    and fixes: (a) levelDownSingle (commands.js) unconditionally copied the parent
    Part's own type onto the decomposition child -- correct for every other element
    type but wrong for DataDataEntity, now special-cased to DataEntityDetails; (b) the
    attribute table's Data Type cell was a free-text input, now a <select> with fixed
    options (numeric/string/boolean/date/blob/json), always including the attribute's
    current value as an extra selected option when it isn't one of those (so a
    DDL-imported concrete SQL type like "VARCHAR(100)" isn't silently clobbered); (c)
    the panel's blur-triggered full re-render (app.recordAndRender() on every field
    'change') destroyed the DOM mid-Tab-transition, so native browser tab-order landed
    on a now-nonexistent element and focus fell back to <body> entirely -- this was
    also the actual root cause of "unable to enable pk", since a keyboard-driven user
    could never tab their way to the PK checkbox; fixed via explicit keydown Tab
    handlers that commit the field themselves and re-focus the correct next field
    (name -> data type -> nullable -> PK -> next row's name, or the Add Attribute
    button after the last row) in whatever DOM exists afterward; (d) added ▲/▼
    move-up/move-down buttons per attribute row; (e) beginConnect/finishConnect
    (main.js) now auto-creates a matching FK attribute on the drag target when the
    source has a primary key and no matching FK already exists, and sets
    fromCardinality:'one'/toCardinality:'many' -- deliberately the REVERSE of
    importDDL's own convention (see check_data_modeling_menu_and_ddl_import_export),
    which is correct for its own DDL-declared-on-the-child-table convention; the two
    are intentionally different, not to be reconciled."""
    result_setup = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;

      // (a) levelDownSingle child type, via BOTH double-click (openOrCreateLinkedView)
      // and the "Add/Edit Entity Details" menu command (promptAddEditEntityDetails) --
      // both funnel through the same function, and the second call must REUSE the same
      // child (the pre-existing Part-level Level Down guard), not create a second one.
      const view = store.addView('RegrDMFields_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const parentEntity = store.createPart({ type: 'DataDataEntity', label: 'RegrCustomer', model, streams: [] });
      const parentVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: parentEntity.id, x: 60, y: 60 });
      app.recordAndRender();
      app.openOrCreateLinkedView(tab, parentVm.id);
      const countAfterDoubleClick = store.doc.parts.length;
      const typesAfterDoubleClick = store.doc.parts.filter(p => p.id !== parentEntity.id).map(p => p.type);

      tab.selection = new Set([parentVm.id]);
      app.render();
      app.promptAddEditEntityDetails();
      const countAfterMenu = store.doc.parts.length;
      const typesAfterMenu = store.doc.parts.filter(p => p.id !== parentEntity.id).map(p => p.type);

      // Add/Edit Entity Details switches the active tab to the decomposition's linked
      // view -- switch back to this test's own view before continuing.
      app.switchToTab(tab.id);

      // (b) Data Type dropdown, with the current non-listed value preserved
      const t1 = store.createPart({ type: 'DataEntityDetails', label: 'RegrOrders2', model, streams: [],
        attributes: [{ id: 'fa1', name: 'id', dataType: 'VARCHAR(100)', nullable: false, isPrimaryKey: true }] });
      const vmT1 = store.createViewMember({ view: view.id, objectType: 'part', objectId: t1.id, x: 60, y: 300 });
      app.recordAndRender();
      tab.selection = new Set([vmT1.id]);
      app.render();
      const dtSelect = document.querySelector('.attr-datatype');
      const dtTag = dtSelect.tagName;
      const dtOptions = [...dtSelect.options].map(o => o.value);
      const dtSelectedValue = dtSelect.value;

      return { viewId: view.id, tabId: tab.id, t1Id: t1.id, countAfterDoubleClick, typesAfterDoubleClick, countAfterMenu, typesAfterMenu, dtTag, dtOptions, dtSelectedValue };
    }
    """)

    # (c) Tab navigation across name -> data type -> nullable -> PK -> next row/Add
    # button, driven via real trusted key events (page.keyboard), and PK toggled via a
    # real keyboard space-press at wherever focus actually lands -- proving the fix
    # works for an actual keyboard-driven user, not just a direct programmatic click.
    page.locator('.attr-add-btn').click()
    page.wait_for_timeout(150)
    name_inputs = page.locator('.attr-name')
    new_row_name = name_inputs.nth(name_inputs.count() - 1)
    new_row_name.click()
    new_row_name.fill('regr_new_field')
    page.keyboard.press('Tab')
    page.wait_for_timeout(150)
    after_tab1 = page.evaluate("document.activeElement.className + '/' + document.activeElement.tagName")
    page.keyboard.press('Tab')
    page.wait_for_timeout(150)
    after_tab2 = page.evaluate("document.activeElement.className + '/' + document.activeElement.tagName")
    page.keyboard.press('Tab')
    page.wait_for_timeout(150)
    after_tab3 = page.evaluate("document.activeElement.className + '/' + document.activeElement.tagName")
    page.keyboard.press(' ')
    page.wait_for_timeout(150)

    # (d) reorder: move the just-added (now PK) attribute up above the original 'id' row
    order_before = js(page, f"() => window.dycadApp.store.findPart('{result_setup['t1Id']}').attributes.map(a => a.name)")
    up_btns = page.locator('.attr-move-up-btn')
    up_btns.nth(up_btns.count() - 1).click()
    page.wait_for_timeout(150)
    order_after = js(page, f"() => window.dycadApp.store.findPart('{result_setup['t1Id']}').attributes.map(a => a.name)")

    attrs_after_pk = js(page, f"() => window.dycadApp.store.findPart('{result_setup['t1Id']}').attributes")

    # (e) auto-FK-creation-with-cardinality on drag
    result2 = js(page, f"""
    async () => {{
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.findView('{result_setup["viewId"]}');
      const tab = store.activeTab();
      const src = store.createPart({{ type: 'DataEntityDetails', label: 'Regr Parent Co', model, streams: [],
        attributes: [{{ id: 'pkX', name: 'id', dataType: 'numeric', nullable: false, isPrimaryKey: true }}] }});
      const dst = store.createPart({{ type: 'DataEntityDetails', label: 'RegrChild', model, streams: [], attributes: [] }});
      const srcVm = store.createViewMember({{ view: view.id, objectType: 'part', objectId: src.id, x: 60, y: 600 }});
      const dstVm = store.createViewMember({{ view: view.id, objectType: 'part', objectId: dst.id, x: 400, y: 600 }});
      app.recordAndRender();
      app.beginConnect(tab, srcVm.id, dstVm.id, 0, 0);
      const fkConn = store.doc.connectors.find(c => c.from === src.id && c.to === dst.id && c.connectorType === 'd');
      const dstAttrsAfterDrag = store.findPart(dst.id).attributes;
      return {{ fkConn, dstAttrsAfterDrag, srcPkId: src.attributes[0].id }};
    }}
    """)

    problems = []
    if result_setup["countAfterDoubleClick"] == 0 or 'DataEntityDetails' not in result_setup["typesAfterDoubleClick"] or 'DataDataEntity' in result_setup["typesAfterDoubleClick"]:
        problems.append(f"double-click decomposition should produce a DataEntityDetails child, not DataDataEntity, got types {result_setup['typesAfterDoubleClick']}")
    if result_setup["countAfterMenu"] != result_setup["countAfterDoubleClick"]:
        problems.append(f"Add/Edit Entity Details menu command should reuse the existing decomposition, not create a second one (part count {result_setup['countAfterDoubleClick']} -> {result_setup['countAfterMenu']})")
    if 'DataDataEntity' in result_setup["typesAfterMenu"]:
        problems.append(f"Add/Edit Entity Details menu command must not create a DataDataEntity child, got types {result_setup['typesAfterMenu']}")
    if result_setup["dtTag"] != 'SELECT':
        problems.append(f"expected the Data Type cell to be a <select>, got {result_setup['dtTag']}")
    if not all(t in result_setup["dtOptions"] for t in ['numeric', 'string', 'boolean', 'date', 'blob', 'json']):
        problems.append(f"expected the fixed data type options, got {result_setup['dtOptions']}")
    if result_setup["dtSelectedValue"] != 'VARCHAR(100)':
        problems.append(f"expected the attribute's existing non-listed data type to be preserved as the selected value, got {result_setup['dtSelectedValue']!r}")
    if 'attr-datatype' not in after_tab1:
        problems.append(f"expected Tab from the Name field to focus the Data Type select, got {after_tab1!r}")
    if 'attr-nullable' not in after_tab2:
        problems.append(f"expected Tab from Data Type to focus the Nullable checkbox, got {after_tab2!r}")
    if 'attr-pk' not in after_tab3:
        problems.append(f"expected Tab from Nullable to focus the PK checkbox, got {after_tab3!r}")
    if not any(a["name"] == "regr_new_field" and a["isPrimaryKey"] for a in attrs_after_pk):
        problems.append(f"expected PK to be enabled via a keyboard-only flow (Tab, Tab, Tab, Space), got {attrs_after_pk}")
    if order_after[0] != order_before[1]:
        problems.append(f"expected the move-up button to reorder attributes, before={order_before} after={order_after}")
    fk_conn = result2["fkConn"]
    dst_attrs = result2["dstAttrsAfterDrag"]
    if not fk_conn:
        problems.append("expected a 'd' connector to be created by beginConnect between two DataEntityDetails tables")
    elif len(dst_attrs) != 1 or dst_attrs[0]["isPrimaryKey"] or dst_attrs[0]["name"] != "regr_parent_co_id":
        problems.append(f"expected exactly one auto-created, non-PK FK attribute named 'regr_parent_co_id' on the drag target, got {dst_attrs}")
    elif fk_conn["fromCardinality"] != "one" or fk_conn["toCardinality"] != "many":
        problems.append(f"expected the auto-created connector to have fromCardinality 'one' / toCardinality 'many', got {fk_conn['fromCardinality']!r}/{fk_conn['toCardinality']!r}")
    elif fk_conn["fromAttribute"] != result2["srcPkId"] or fk_conn["toAttribute"] != dst_attrs[0]["id"]:
        problems.append(f"expected the connector's fromAttribute/toAttribute to reference the source PK and the new FK attribute, got {fk_conn['fromAttribute']!r}/{fk_conn['toAttribute']!r}")
    if problems:
        return False, "; ".join(problems)
    return True, "Decomposing a DataDataEntity (double-click or the menu command) produces a reused DataEntityDetails child; the attribute table's Data Type is a dropdown preserving unlisted values; Tab moves focus name->type->nullable->PK->next row correctly (fixing PK's keyboard reachability too); attributes can be reordered; and drag-creating a 'd' connector auto-creates a matching FK attribute with One/Many cardinality"


def check_data_modeling_autofill(page):
    """Regression guard/new-feature check for Data Modeling > Autofill, reported
    directly: "add a new command to menu 'Data Modeling' called autofill, which will
    call a script called dataAutoFill. This script (store/save/edit same as
    BatchScript_QuickStart approach) will loop through dataentitydetail nodes on
    current view, and if attributes have not been created yet (don't override
    existing) it will create an attribute using the label + 'Id', of type numeric,
    flag as primary key. Also create an attribute called label + 'Name', of type
    string, and null enabled. Also create an attribute called label + 'Description',
    of type string, and null enabled. Next loop through data connectors. If the
    'from' attribute have not been set: set From to the pk of the from node/part. set
    To to the same field name in to node/part after creating it (numeric null fk),
    set cardinality as from: one and to: one or many." Implemented as a new
    dataAutoFill() function living in DEFAULT_BATCH_SCRIPT_CODE (state.js) --
    editable via Script Console exactly like BatchScript_QuickStart, persisted the
    same way via store.batchScriptCode -- but NOT called from main() (it would break
    on a fresh document with no Data Entity Details tables yet). The new menu item
    (App.promptAutofill, main.js) extracts and calls dataAutoFill() specifically, by
    name, using the same compile-with-bindings mechanism the Script Console's own Run
    button uses for main(). Covers: the menu item existing and reachable; a clean
    error toast (not a crash) when there's no active canvas tab; a table with NO
    attributes yet getting all three scaffolded (Id: numeric/PK/not-null,
    Name/Description: string/nullable) named exactly `<label>Id`/`<label>Name`/
    `<label>Description`; a table that ALREADY has attributes being left completely
    untouched ("don't override existing"); a 'd' connector with no fromAttribute set
    getting wired to the source's own PK and a same-named, auto-created (numeric,
    nullable, non-PK) attribute on the target, with fromCardinality:'one'/
    toCardinality:'oneOrMany'; a 'd' connector that ALREADY has fromAttribute set
    being left completely untouched; that dataAutoFill() is NOT part of main()'s own
    call chain (editing/running the default Script Console script is unaffected by
    this feature's addition); and a follow-up bug reported directly after using this
    exact feature: "foreign key flag still not appearing anywhere, field is created
    in autofill script when parent connected to child but not flagged as foreign
    key... Tried manually creating isForeignKey: true, didn't work still not
    showing." Root cause: isAttributeForeignKey (render.js) hardcoded "the attribute
    referenced by a 'd' connector's fromAttribute is the FK" -- true only for DDL
    import's own convention (fromAttribute = child's FK column); Autofill and
    drag-to-connect deliberately store it the OPPOSITE way (fromAttribute = source's
    own PK, toAttribute = the newly-created FK), so their FK attributes never
    matched. There is no stored isForeignKey field anywhere (confirmed: manually
    adding one does nothing, since nothing reads it) -- fixed by deriving FK status
    from whichever end of a 'd' connector's pair references an attribute actually
    flagged isPrimaryKey, checking BOTH ends instead of hardcoding one, which is
    correct for all three creation conventions at once. Covered here by confirming
    the FK badge genuinely appears (property panel AND the canvas node's own
    rendering) on the attribute Autofill just auto-created."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;

      const menuItems = [...document.querySelectorAll('#data-modeling-menu .dd-item')].map(i => i.textContent);

      // The Instructions tab is open by default on a fresh page (not type 'canvas') --
      // running Autofill against it should produce a specific error toast, not a crash.
      const startTab = store.activeTab();
      const noCanvasTabOk = !startTab || startTab.type !== 'canvas';
      await app.promptAutofill();
      const noTabToasts = [...document.querySelectorAll('.toast')].map(t => t.textContent);

      const view = store.addView('RegrAutofill_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const customer = store.createPart({ type: 'DataEntityDetails', label: 'RegrCustomer', model, streams: [] });
      const order = store.createPart({ type: 'DataEntityDetails', label: 'RegrOrder', model, streams: [] });
      const product = store.createPart({ type: 'DataEntityDetails', label: 'RegrProduct', model, streams: [],
        attributes: [{ id: 'regr-existing1', name: 'sku', dataType: 'string', nullable: false, isPrimaryKey: true }] });
      const vmC = store.createViewMember({ view: view.id, objectType: 'part', objectId: customer.id, x: 0, y: 0 });
      const vmO = store.createViewMember({ view: view.id, objectType: 'part', objectId: order.id, x: 300, y: 0 });
      const vmP = store.createViewMember({ view: view.id, objectType: 'part', objectId: product.id, x: 600, y: 0 });
      const conn1 = store.createConnector({ from: customer.id, to: order.id, model, connectorType: 'd', relationship: 'Association' });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn1.id, fromVmId: vmC.id, toVmId: vmO.id });
      const conn2 = store.createConnector({ from: order.id, to: product.id, model, connectorType: 'd', relationship: 'Association',
        fromAttribute: 'regr-preset', toAttribute: 'regr-existing1', fromCardinality: 'many', toCardinality: 'one' });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn2.id, fromVmId: vmO.id, toVmId: vmP.id });
      app.recordAndRender();

      await app.promptAutofill();
      const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent);

      // Reported directly, a separate bug found using this exact feature: "foreign
      // key flag still not appearing anywhere, field is created in autofill script
      // when parent connected to child but not flagged as foreign key." Select
      // Order's node and confirm the auto-created FK attribute (CustomerId) actually
      // shows the FK badge, both in the property panel and on the canvas node itself
      // -- isAttributeForeignKey (render.js) originally hardcoded "fromAttribute is
      // always the FK", which only matches DDL import's own convention; Autofill/
      // drag-to-connect deliberately store it the other way around (fromAttribute =
      // source's PK, toAttribute = the new FK), so the badge never showed for
      // anything Autofill or drag-to-connect ever created.
      tab.selection = new Set([vmO.id]);
      app.render();
      const orderFkBadgeCount = document.querySelectorAll('.attr-fk-badge').length;
      const orderNodeText = document.querySelector(`[data-vm-id="${vmO.id}"]`).innerText;

      const codeHasFn = /function dataAutoFill/.test(store.batchScriptCode);
      const mainBody = store.batchScriptCode.split('async function main()')[1].split('}')[0];
      const mainCallsAutofill = mainBody.includes('dataAutoFill(');

      return {
        menuItems,
        noCanvasTabOk, noTabToast: noTabToasts[noTabToasts.length - 1],
        customerAttrs: store.findPart(customer.id).attributes,
        orderAttrs: store.findPart(order.id).attributes,
        productAttrs: store.findPart(product.id).attributes,
        conn1: store.findConnector(conn1.id),
        conn2: store.findConnector(conn2.id),
        lastToast: toasts[toasts.length - 1],
        orderFkBadgeCount, orderNodeText,
        codeHasFn, mainCallsAutofill,
      };
    }
    """)
    problems = []
    if 'Autofill' not in result["menuItems"]:
        problems.append(f"expected an 'Autofill' item in the Data Modeling menu, got {result['menuItems']}")
    if result["noCanvasTabOk"] and (not result["noTabToast"] or "canvas" not in result["noTabToast"].lower()):
        problems.append(f"expected a specific error toast when there's no active canvas tab, got {result['noTabToast']!r}")
    cust = result["customerAttrs"]
    if len(cust) != 3 or [a["name"] for a in cust] != ["RegrCustomerId", "RegrCustomerName", "RegrCustomerDescription"]:
        problems.append(f"expected Customer to get exactly 3 scaffolded attributes named <label>Id/<label>Name/<label>Description, got {cust}")
    else:
        pk = cust[0]
        if pk["dataType"] != "numeric" or pk["nullable"] is not False or pk["isPrimaryKey"] is not True:
            problems.append(f"expected the scaffolded Id attribute to be numeric/not-null/PK, got {pk}")
        nm = cust[1]
        if nm["dataType"] != "string" or nm["nullable"] is not True or nm["isPrimaryKey"] is not False:
            problems.append(f"expected the scaffolded Name attribute to be string/nullable/non-PK, got {nm}")
    if len(result["productAttrs"]) != 1 or result["productAttrs"][0]["id"] != "regr-existing1":
        problems.append(f"expected a table that already has attributes to be left completely untouched, got {result['productAttrs']}")
    conn1 = result["conn1"]
    if not cust or conn1["fromAttribute"] != cust[0]["id"]:
        problems.append(f"expected conn1's fromAttribute to be wired to the source's own PK, got {conn1.get('fromAttribute')!r}")
    if conn1["fromCardinality"] != "one" or conn1["toCardinality"] != "oneOrMany":
        problems.append(f"expected conn1's cardinality to be set to one/oneOrMany, got {conn1['fromCardinality']!r}/{conn1['toCardinality']!r}")
    order_fk = [a for a in result["orderAttrs"] if a["id"] == conn1.get("toAttribute")]
    if len(order_fk) != 1:
        problems.append(f"expected a new FK attribute on Order matching conn1's toAttribute, got order attrs {result['orderAttrs']}")
    elif cust and (order_fk[0]["name"] != cust[0]["name"] or order_fk[0]["dataType"] != "numeric" or order_fk[0]["nullable"] is not True or order_fk[0]["isPrimaryKey"] is not False):
        problems.append(f"expected the auto-created FK attribute to be same-named/numeric/nullable/non-PK, got {order_fk[0]}")
    conn2 = result["conn2"]
    if conn2["fromAttribute"] != "regr-preset" or conn2["fromCardinality"] != "many":
        problems.append(f"expected a connector that already had fromAttribute set to be left completely untouched, got {conn2}")
    if not result["lastToast"] or "Autofill" not in result["lastToast"]:
        problems.append(f"expected a specific Autofill summary toast, got {result['lastToast']!r}")
    if not result["codeHasFn"]:
        problems.append("expected dataAutoFill() to be defined in the default batch script (store.batchScriptCode)")
    if result["mainCallsAutofill"]:
        problems.append("expected main() to NOT call dataAutoFill() -- it would break on a fresh document with no Data Entity Details tables yet")
    if result["orderFkBadgeCount"] != 1:
        problems.append(f"expected exactly one FK badge in Order's property panel (on the autofill-created FK attribute), got {result['orderFkBadgeCount']}")
    if "(FK)" not in result["orderNodeText"]:
        problems.append(f"expected the Order node's own canvas rendering to show a (FK) marker on the autofill-created attribute, got {result['orderNodeText']!r}")
    if problems:
        return False, "; ".join(problems)
    return True, "Data Modeling > Autofill runs the user-editable dataAutoFill() batch script against the current view: scaffolds Id/Name/Description on tables with no attributes yet (leaving already-detailed tables untouched), wires From/To Attribute + One/OneOrMany cardinality on 'd' connectors with no fromAttribute yet (leaving already-wired ones untouched), the auto-created FK attribute genuinely shows its FK badge (both in the property panel and on the canvas node), and dataAutoFill() stays out of main()'s own call chain"


def check_auto_detect_connectors_detection_and_creation(page):
    """Regression guard/new-feature check for Data Modeling > Auto-Detect Connectors,
    reported directly: "Part A: auto determine from ddl content 'references'. Part B:
    find matching field names where one is primary key and other is not, this is
    potential for n to 1 and foreign key, show preview list to user to confirm before
    creating new connectors." Exercises commands.js's detectConnectorCandidates/
    createDetectedConnectors directly (not the dialog UI -- see
    check_auto_detect_connectors_dialog for that), scoped to the WHOLE document per
    the user's own explicit choice (not just the current view), covering:
    - Part A: DDL text pasted with an explicit FOREIGN KEY ... REFERENCES clause is
      matched against an EXISTING table/column already in the document (not creating a
      new table the way Import DDL does) -- proven with a column name ("cust_ref")
      that the Part B heuristic would NOT catch on its own, so this specifically
      isolates Part A's own mechanism.
    - Part B, exact match: a non-PK attribute name equal (case/punctuation-
      insensitive) to another table's PK attribute name is proposed.
    - Part B, "<Table>Id"-style match: a non-PK attribute name equal to the PK table's
      OWN LABEL concatenated with its PK's name (e.g. "RegrCust_<n>Id") is proposed.
    - De-duplication: a pair already linked by a real 'd' connector between those exact
      two attributes is never proposed again.
    - createDetectedConnectors' placement rule: a candidate whose two tables already
      share a view gets a connector viewMember placed there automatically; a candidate
      whose two tables are NOT placed together on any view yet still gets its
      document-level connector created, just with zero placements (counted in
      `unplaced`) -- mirroring Level Up/Down's own "unplaced Composition connector"
      precedent rather than silently dropping it.
    - Re-running detection after creation finds zero further candidates for the same
      pairs (the dedup above also holds for connectors this feature itself just
      created, not just pre-existing ones)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const ts = Date.now();
      const mkTable = (label, attributes) => store.createPart({ type: 'DataEntityDetails', label, model, streams: [], attributes });

      const viewA = store.addView('RegrADCViewA_' + ts, 'ff'); // cust + ord + inv all placed here (shared view)
      const viewC = store.addView('RegrADCViewC_' + ts, 'ff'); // dept placed here only
      const viewD = store.addView('RegrADCViewD_' + ts, 'ff'); // emp placed here only (NOT shared with dept)
      const place = (view, part) => store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x: 0, y: 0 });

      const custLabel = 'RegrCust_' + ts;
      const cust = mkTable(custLabel, [{ id: 'c-pk-' + ts, name: 'Id', dataType: 'numeric', nullable: false, isPrimaryKey: true }]);
      // Part B, "<Table>Id" pattern: ord's FK column is literally custLabel + 'Id'.
      const ord = mkTable('RegrOrd_' + ts, [
        { id: 'o-pk-' + ts, name: 'Id', dataType: 'numeric', nullable: false, isPrimaryKey: true },
        { id: 'o-fk-' + ts, name: custLabel + 'Id', dataType: 'numeric', nullable: true, isPrimaryKey: false },
      ]);
      // Part A only: 'cust_ref' matches neither 'Id' nor the '<Table>Id' pattern, so
      // the field-name heuristic (Part B) must NOT catch this -- only explicit DDL text can.
      const inv = mkTable('RegrInv_' + ts, [
        { id: 'i-pk-' + ts, name: 'Id', dataType: 'numeric', nullable: false, isPrimaryKey: true },
        { id: 'i-fk-' + ts, name: 'cust_ref', dataType: 'numeric', nullable: true, isPrimaryKey: false },
      ]);
      place(viewA, cust); place(viewA, ord); place(viewA, inv);

      // Part B, exact-name match, but tables placed on DIFFERENT views -> should still
      // be created (whole-document scope) but land unplaced (no shared view).
      const dept = mkTable('RegrDept_' + ts, [{ id: 'd-pk-' + ts, name: 'Code', dataType: 'string', nullable: false, isPrimaryKey: true }]);
      const emp = mkTable('RegrEmp_' + ts, [
        { id: 'e-pk-' + ts, name: 'Id', dataType: 'numeric', nullable: false, isPrimaryKey: true },
        { id: 'e-fk-' + ts, name: 'Code', dataType: 'string', nullable: true, isPrimaryKey: false },
      ]);
      place(viewC, dept); place(viewD, emp);

      // De-dup fixture: a pair ALREADY linked by a real 'd' connector between the exact
      // two attributes -- must never be re-proposed.
      const region = mkTable('RegrRegion_' + ts, [{ id: 'r-pk-' + ts, name: 'Code2', dataType: 'string', nullable: false, isPrimaryKey: true }]);
      const branch = mkTable('RegrBranch_' + ts, [{ id: 'b-fk-' + ts, name: 'Code2', dataType: 'string', nullable: true, isPrimaryKey: false }]);
      place(viewC, region); place(viewC, branch);
      store.createConnector({ from: branch.id, to: region.id, model, connectorType: 'd', relationship: 'Association', fromAttribute: 'b-fk-' + ts, toAttribute: 'r-pk-' + ts, fromCardinality: 'many', toCardinality: 'one' });

      const ddlText = `CREATE TABLE ${inv.label} (id INTEGER, cust_ref INTEGER, FOREIGN KEY (cust_ref) REFERENCES ${cust.label}(Id));`;
      const candidates = commands.detectConnectorCandidates(store, ddlText);

      const findCand = (fromAttributeId, toAttributeId) => candidates.find(c => c.fromAttributeId === fromAttributeId && c.toAttributeId === toAttributeId);
      const ordCand = findCand('o-fk-' + ts, 'c-pk-' + ts);
      const invCand = findCand('i-fk-' + ts, 'c-pk-' + ts);
      const deptCand = findCand('e-fk-' + ts, 'd-pk-' + ts);
      const branchProposed = candidates.some(c => c.fromAttributeId === 'b-fk-' + ts || c.toAttributeId === 'b-fk-' + ts);

      const { created, placements, unplaced } = commands.createDetectedConnectors(app, candidates);

      const ordConn = store.doc.connectors.find(c => c.connectorType === 'd' && c.fromAttribute === 'o-fk-' + ts && c.toAttribute === 'c-pk-' + ts);
      const invConn = store.doc.connectors.find(c => c.connectorType === 'd' && c.fromAttribute === 'i-fk-' + ts && c.toAttribute === 'c-pk-' + ts);
      const deptConn = store.doc.connectors.find(c => c.connectorType === 'd' && c.fromAttribute === 'e-fk-' + ts && c.toAttribute === 'd-pk-' + ts);
      const ordPlaced = store.doc.viewMembers.some(vm => vm.objectType === 'connector' && vm.objectId === ordConn?.id && vm.view === viewA.id);
      const invPlaced = store.doc.viewMembers.some(vm => vm.objectType === 'connector' && vm.objectId === invConn?.id && vm.view === viewA.id);
      const deptPlacedAnywhere = store.doc.viewMembers.some(vm => vm.objectType === 'connector' && vm.objectId === deptConn?.id);

      const reDetected = commands.detectConnectorCandidates(store, ddlText);
      const stillProposesOrd = !!findCandIn(reDetected, 'o-fk-' + ts, 'c-pk-' + ts);
      function findCandIn(list, f, t) { return list.find(c => c.fromAttributeId === f && c.toAttributeId === t); }

      return {
        candidateCount: candidates.length,
        ordCandSource: ordCand ? ordCand.source : null,
        invCandSource: invCand ? invCand.source : null,
        deptCandSource: deptCand ? deptCand.source : null,
        branchProposed,
        created, placements, unplaced,
        ordConnCardinality: ordConn ? [ordConn.fromCardinality, ordConn.toCardinality] : null,
        ordPlaced, invPlaced, deptPlacedAnywhere,
        stillProposesOrd,
      };
    }
    """)
    problems = []
    if result["candidateCount"] != 3:
        problems.append(f"expected exactly 3 candidates (ord/inv/dept pairs; branch's pair already connected), got {result['candidateCount']}")
    if result["ordCandSource"] != "Name match":
        problems.append(f"expected the '<Table>Id'-pattern ord/cust pair to be proposed with source 'Name match', got {result['ordCandSource']!r}")
    if result["invCandSource"] != "DDL REFERENCES":
        problems.append(f"expected the inv/cust pair (name-mismatched FK column) to be proposed ONLY via Part A's DDL REFERENCES match, got {result['invCandSource']!r}")
    if result["deptCandSource"] != "Name match":
        problems.append(f"expected the exact-name dept/emp pair to be proposed with source 'Name match', got {result['deptCandSource']!r}")
    if result["branchProposed"]:
        problems.append("expected the branch/region pair (already linked by a real 'd' connector) to NEVER be re-proposed")
    if result["created"] != 3:
        problems.append(f"expected createDetectedConnectors to create 3 connectors, got {result['created']}")
    if result["unplaced"] != 1:
        problems.append(f"expected exactly 1 of the 3 created connectors to land unplaced (dept/emp share no view), got unplaced={result['unplaced']}")
    if result["placements"] != 2:
        problems.append(f"expected 2 total connector placements (ord and inv both share viewA with their PK table), got {result['placements']}")
    if result["ordConnCardinality"] != ["many", "one"]:
        problems.append(f"expected the created connector to use fromCardinality:'many'/toCardinality:'one' (importDDL's own convention), got {result['ordConnCardinality']}")
    if not result["ordPlaced"] or not result["invPlaced"]:
        problems.append(f"expected the ord/cust and inv/cust connectors to be auto-placed on viewA (both endpoints already there), got ordPlaced={result['ordPlaced']} invPlaced={result['invPlaced']}")
    if result["deptPlacedAnywhere"]:
        problems.append("expected the dept/emp connector to be created but placed NOWHERE (its two tables share no view)")
    if result["stillProposesOrd"]:
        problems.append("expected re-running detection after creation to find ZERO further candidates for the same pair (dedup must also cover connectors this feature itself just created)")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "detectConnectorCandidates finds explicit DDL REFERENCES matched against EXISTING tables (Part A), exact-name and '<Table>Id'-pattern field-name matches (Part B), never re-proposes an already-connected pair, and createDetectedConnectors places new connectors only where both tables already share a view (leaving the rest created-but-unplaced) -- all idempotent on re-detection"


def check_auto_detect_connectors_dialog(page):
    """UI-wiring regression guard for the Auto-Detect Connectors... dialog itself
    (Data Modeling menu, App.promptAutoDetectConnectors, main.js) -- driven through the
    real menu click and DOM, not by calling commands.js directly (see
    check_auto_detect_connectors_detection_and_creation for the underlying logic).
    Covers: the menu item opens a dialog with a DDL textarea and a Detect button; a
    Data Entity Details table with no candidates found before the button is ever
    clicked doesn't show a Create button; clicking Detect (with no DDL pasted, relying
    only on the field-name heuristic) populates a preview row per candidate, every row
    starting checked; unchecking one row before clicking "Create Selected Connectors"
    excludes exactly that one candidate from what actually gets created (proving the
    dialog's own selection state, not just detection, drives what's created); and
    Cancel closes the dialog without creating anything."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const ts = Date.now();
      const view = store.addView('RegrADCDlg_' + ts, 'ff');
      const custLabel = 'RegrDlgCust_' + ts;
      const cust = store.createPart({ type: 'DataEntityDetails', label: custLabel, model, streams: [],
        attributes: [{ id: 'dc-pk-' + ts, name: 'Id', dataType: 'numeric', nullable: false, isPrimaryKey: true }] });
      const ord = store.createPart({ type: 'DataEntityDetails', label: 'RegrDlgOrd_' + ts, model, streams: [],
        attributes: [
          { id: 'dc-pk2-' + ts, name: 'Id', dataType: 'numeric', nullable: false, isPrimaryKey: true },
          { id: 'dc-fk-' + ts, name: custLabel + 'Id', dataType: 'numeric', nullable: true, isPrimaryKey: false },
        ] });
      // second, independent candidate pair (exact-name match) so unchecking ONE row
      // below still leaves a second one checked to actually create.
      const dept = store.createPart({ type: 'DataEntityDetails', label: 'RegrDlgDept_' + ts, model, streams: [],
        attributes: [{ id: 'dc-pk3-' + ts, name: 'Code', dataType: 'string', nullable: false, isPrimaryKey: true }] });
      const emp = store.createPart({ type: 'DataEntityDetails', label: 'RegrDlgEmp_' + ts, model, streams: [],
        attributes: [
          { id: 'dc-pk4-' + ts, name: 'Id', dataType: 'numeric', nullable: false, isPrimaryKey: true },
          { id: 'dc-fk2-' + ts, name: 'Code', dataType: 'string', nullable: true, isPrimaryKey: false },
        ] });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: cust.id, x: 0, y: 0 });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: ord.id, x: 200, y: 0 });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: dept.id, x: 0, y: 200 });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: emp.id, x: 200, y: 200 });
      app.recordAndRender();

      document.getElementById('data-modeling-menu-btn').click();
      await new Promise(r => setTimeout(r, 40));
      document.querySelector('[data-action="autoDetectConnectors"]').click();
      await new Promise(r => setTimeout(r, 40));

      const box = document.querySelector('.modal-box');
      const hasTextarea = !!box.querySelector('#adc-ddl');
      const createHiddenBeforeDetect = box.querySelector('#adc-create').classList.contains('hidden');

      box.querySelector('#adc-detect').click();
      await new Promise(r => setTimeout(r, 40));

      const rows = [...box.querySelectorAll('.adc-row-check')];
      const rowCountAfterDetect = rows.length;
      const allCheckedByDefault = rows.every(cb => cb.checked);
      const createVisibleAfterDetect = !box.querySelector('#adc-create').classList.contains('hidden');

      // uncheck the first row before confirming
      if (rows.length) { rows[0].checked = false; rows[0].dispatchEvent(new Event('change', { bubbles: true })); }

      const connCountBefore = store.doc.connectors.filter(c => c.connectorType === 'd').length;
      box.querySelector('#adc-create').click();
      await new Promise(r => setTimeout(r, 40));
      const connCountAfter = store.doc.connectors.filter(c => c.connectorType === 'd').length;
      const dialogClosedAfterCreate = !document.querySelector('.modal-box');
      const toastText = (() => { const all = document.querySelectorAll('.toast'); return all.length ? all[all.length - 1].textContent : null; })();

      // Cancel path: open again, confirm Cancel closes with no changes
      document.getElementById('data-modeling-menu-btn').click();
      await new Promise(r => setTimeout(r, 40));
      document.querySelector('[data-action="autoDetectConnectors"]').click();
      await new Promise(r => setTimeout(r, 40));
      const box2 = document.querySelector('.modal-box');
      box2.querySelector('.cancel').click();
      await new Promise(r => setTimeout(r, 40));
      const dialogClosedAfterCancel = !document.querySelector('.modal-box');
      const connCountAfterCancel = store.doc.connectors.filter(c => c.connectorType === 'd').length;

      return {
        hasTextarea, createHiddenBeforeDetect, rowCountAfterDetect, allCheckedByDefault, createVisibleAfterDetect,
        connCountBefore, connCountAfter, dialogClosedAfterCreate, toastText,
        dialogClosedAfterCancel, connCountAfterCancel,
      };
    }
    """)
    problems = []
    if not result["hasTextarea"]:
        problems.append("expected the Auto-Detect Connectors dialog to include a DDL paste textarea (#adc-ddl)")
    if not result["createHiddenBeforeDetect"]:
        problems.append("expected the Create button to stay hidden until Detect Connectors has actually run")
    if result["rowCountAfterDetect"] < 1:
        problems.append(f"expected at least one candidate row after clicking Detect (field-name heuristic should catch the '<Table>Id' fixture), got {result['rowCountAfterDetect']}")
    if not result["allCheckedByDefault"]:
        problems.append("expected every candidate row to start checked")
    if not result["createVisibleAfterDetect"]:
        problems.append("expected the Create Selected Connectors button to become visible once candidates are found")
    if result["connCountAfter"] - result["connCountBefore"] != result["rowCountAfterDetect"] - 1:
        problems.append(f"expected unchecking one row to exclude exactly that candidate from creation ({result['rowCountAfterDetect'] - 1} of {result['rowCountAfterDetect']} expected created), got {result['connCountAfter'] - result['connCountBefore']} created")
    if not result["dialogClosedAfterCreate"]:
        problems.append("expected the dialog to close after Create Selected Connectors")
    if not result["toastText"] or "Created" not in result["toastText"]:
        problems.append(f"expected a specific 'Created N connector(s)...' toast, got {result['toastText']!r}")
    if not result["dialogClosedAfterCancel"]:
        problems.append("expected Cancel to close the dialog")
    if result["connCountAfterCancel"] != result["connCountAfter"]:
        problems.append(f"expected Cancel to create NOTHING, got connector count changed from {result['connCountAfter']} to {result['connCountAfterCancel']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Auto-Detect Connectors... dialog (Data Modeling menu) opens with a DDL textarea, Detect Connectors populates a checked-by-default preview list, unchecking a row excludes exactly that candidate from what Create Selected Connectors actually creates, and Cancel closes without creating anything"


def check_level_it_replaces_across_template_gap(page):
    """Regression guard/new-feature check for the new "Level It" command
    (levelIt, commands.js — freeform views only), reported directly: "when in a free
    form view, add a new right-click level-it command. Use case: when an existing
    datadataentity is added and connected to a businessprocess, the level-it command
    will replace the datadataentity since stream template does not have its type
    connected directly to a businessprocess, and will replace it with
    applicationcapability since in the stream template 'path' that is the next valid
    element between it and the target datadataentity. Silently (no user prompt)
    replace the view dataentity node with existing applicationcapability node of that
    named stream." Uses the REAL shipped "Enterprise" template
    (BusinessProcess sits 5 slots before DataDataEntity in its value[] chain, with
    ApplicationCapability immediately after BusinessProcess — the exact reported
    example, not a synthetic one). Covers: (1) the exact reported scenario — a
    DataDataEntity directly connected to a BusinessProcess gets silently replaced (on
    this view only) with an EXISTING ApplicationCapability node sharing the
    DataDataEntity's own stream, with a new 's' (+ companion 'c') Stream connector
    linking BusinessProcess -> ApplicationCapability in the template's own
    earlier-to-later direction; (2) that direction holds even when the ORIGINAL
    connector ran the opposite way (DataDataEntity -> BusinessProcess); (3) the
    original connector's viewMember is removed from this view but the underlying
    Connector and both original Parts are left completely untouched in the model
    (never deleted — may still be legitimate elsewhere); (4) already-adjacent types
    (no gap) make no changes; (5) a type not part of the template's chain (e.g.
    'Unknown') makes no changes; (6) no existing replacement part for the node's own
    stream aborts with no changes (never creates a new one); (7) if the replaced
    node still has ANOTHER connector on this view afterward, its own viewMember
    survives (not unconditionally removed); (8) a section-based view makes no changes
    even when called directly."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      store.doc.industryTemplateName = 'Enterprise';
      const out = {};
      const freshFf = (name) => {
        const view = store.addView(name + '_' + Date.now() + '_' + Math.random(), 'ff');
        const tab = app.createCanvasTab(view);
        app.switchToTab(tab.id);
        return { view, tab };
      };

      // 1) The exact reported scenario.
      {
        const bp = store.createPart({ type: 'BusinessProcess', label: 'RegrLevelItBP', model, streams: ['RegrLevelItStream'] });
        const dde = store.createPart({ type: 'DataDataEntity', label: 'RegrLevelItDDE', model, streams: ['RegrLevelItStream'] });
        const appCap = store.createPart({ type: 'ApplicationCapability', label: 'RegrLevelItCap', model, streams: ['RegrLevelItStream'] });
        const origConn = store.createConnector({ from: bp.id, to: dde.id, connectorType: 'c', model, relationship: 'Association' });
        const { view, tab } = freshFf('RegrLevelIt1');
        const vmBp = store.createViewMember({ view: view.id, objectType: 'part', objectId: bp.id, x: 60, y: 60 });
        const vmDde = store.createViewMember({ view: view.id, objectType: 'part', objectId: dde.id, x: 300, y: 60 });
        const vmConn = store.createViewMember({ view: view.id, objectType: 'connector', objectId: origConn.id, fromVmId: vmBp.id, toVmId: vmDde.id });

        commands.levelIt(app, tab, vmDde.id);
        const vmsAfter = store.viewMembersForView(view.id);
        out.ddeVmGone = !vmsAfter.some(v => v.objectType === 'part' && v.objectId === dde.id);
        out.appCapVmPresent = vmsAfter.some(v => v.objectType === 'part' && v.objectId === appCap.id);
        out.appCapVmAtOldPos = (() => { const v = vmsAfter.find(v => v.objectType === 'part' && v.objectId === appCap.id); return v && v.x === 300 && v.y === 60; })();
        out.origConnVmGone = !vmsAfter.some(v => v.objectType === 'connector' && v.objectId === origConn.id);
        out.origConnStillInModel = !!store.findConnector(origConn.id);
        out.ddePartStillInModel = !!store.findPart(dde.id);
        const newS = store.doc.connectors.find(c => c.connectorType === 's' && c.from === bp.id && c.to === appCap.id);
        out.newStreamConnCorrectDirection = !!newS;
        out.newStreamConnHasStream = newS && (newS.streams || []).includes('RegrLevelItStream');
        out.newCompanionExists = store.doc.connectors.some(c => c.connectorType === 'c' && c.from === bp.id && c.to === appCap.id);
      }

      // 2) Bidirectionality: right-click the EARLIER node this time (BusinessProcess,
      // template index 3) directly connected to the LATER neighbor (DataDataEntity,
      // index 8) -- should replace BusinessProcess itself with ApplicationPhysical
      // Component (index 7, immediately before DataDataEntity), not touch DataDataEntity.
      // The ORIGINAL connector deliberately runs DataDataEntity -> BusinessProcess
      // (backwards relative to template order) to prove the new connector's direction
      // comes from the template's own chain position, not from the original
      // connector's from/to fields.
      {
        const bp = store.createPart({ type: 'BusinessProcess', label: 'RegrLevelItBP2', model, streams: ['RegrLevelItStream2'] });
        const dde = store.createPart({ type: 'DataDataEntity', label: 'RegrLevelItDDE2', model, streams: ['RegrLevelItStream2'] });
        const apc = store.createPart({ type: 'ApplicationPhysicalComponent', label: 'RegrLevelItApc2', model, streams: ['RegrLevelItStream2'] });
        const origConn = store.createConnector({ from: dde.id, to: bp.id, connectorType: 'c', model, relationship: 'Association' }); // backwards vs. template order
        const { view, tab } = freshFf('RegrLevelIt2');
        const vmDde = store.createViewMember({ view: view.id, objectType: 'part', objectId: dde.id, x: 60, y: 60 });
        const vmBp = store.createViewMember({ view: view.id, objectType: 'part', objectId: bp.id, x: 300, y: 60 });
        store.createViewMember({ view: view.id, objectType: 'connector', objectId: origConn.id, fromVmId: vmDde.id, toVmId: vmBp.id });

        commands.levelIt(app, tab, vmBp.id);
        const vmsAfter2 = store.viewMembersForView(view.id);
        out.earlierNodeReplaced = !vmsAfter2.some(v => v.objectType === 'part' && v.objectId === bp.id);
        out.laterNeighborUntouched = vmsAfter2.some(v => v.objectType === 'part' && v.objectId === dde.id);
        out.apcVmPresent = vmsAfter2.some(v => v.objectType === 'part' && v.objectId === apc.id);
        // Direction should be ApplicationPhysicalComponent -> DataDataEntity (template order), NOT the reverse.
        out.earlierCaseCorrectDirection = store.doc.connectors.some(c => c.connectorType === 's' && c.from === apc.id && c.to === dde.id);
        out.earlierCaseNoBackwardsConn = !store.doc.connectors.some(c => c.connectorType === 's' && c.from === dde.id && c.to === apc.id);
      }

      // 4) Already adjacent -- no changes. A SECOND ApplicationCapability part sharing
      // the same stream also exists, so this genuinely proves the adjacency guard
      // itself is what's skipping the connector -- without it, the "find an existing
      // node of the (self-)same type" step would still find THIS other part and
      // wrongly swap in a same-type replacement.
      {
        const bp = store.createPart({ type: 'BusinessProcess', label: 'RegrLevelItAdjBP', model, streams: ['S1'] });
        const cap = store.createPart({ type: 'ApplicationCapability', label: 'RegrLevelItAdjCap', model, streams: ['S1'] });
        store.createPart({ type: 'ApplicationCapability', label: 'RegrLevelItAdjCapDecoy', model, streams: ['S1'] });
        const conn = store.createConnector({ from: bp.id, to: cap.id, connectorType: 'c', model, relationship: 'Association' });
        const { view, tab } = freshFf('RegrLevelIt4');
        const vmBp = store.createViewMember({ view: view.id, objectType: 'part', objectId: bp.id, x: 0, y: 0 });
        const vmCap = store.createViewMember({ view: view.id, objectType: 'part', objectId: cap.id, x: 100, y: 0 });
        store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: vmBp.id, toVmId: vmCap.id });
        const before = store.viewMembersForView(view.id).length;
        commands.levelIt(app, tab, vmCap.id);
        out.adjacentNoChange = store.viewMembersForView(view.id).length === before;
      }

      // 5) Type not in the template's chain -- no changes.
      {
        const u = store.createPart({ type: 'Unknown', label: 'RegrLevelItUnk', model, streams: ['S1'] });
        const { view, tab } = freshFf('RegrLevelIt5');
        const vmU = store.createViewMember({ view: view.id, objectType: 'part', objectId: u.id, x: 0, y: 0 });
        const before = store.viewMembersForView(view.id).length;
        commands.levelIt(app, tab, vmU.id);
        out.unknownTypeNoChange = store.viewMembersForView(view.id).length === before;
      }

      // 6) No existing replacement part for the node's stream -- no changes.
      {
        const bp = store.createPart({ type: 'BusinessProcess', label: 'RegrLevelItNoReplBP', model, streams: ['S6'] });
        const dde = store.createPart({ type: 'DataDataEntity', label: 'RegrLevelItNoReplDDE', model, streams: ['S6'] });
        const conn = store.createConnector({ from: bp.id, to: dde.id, connectorType: 'c', model, relationship: 'Association' });
        const { view, tab } = freshFf('RegrLevelIt6');
        const vmBp = store.createViewMember({ view: view.id, objectType: 'part', objectId: bp.id, x: 0, y: 0 });
        const vmDde = store.createViewMember({ view: view.id, objectType: 'part', objectId: dde.id, x: 100, y: 0 });
        store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: vmBp.id, toVmId: vmDde.id });
        const before = store.viewMembersForView(view.id).length;
        commands.levelIt(app, tab, vmDde.id);
        out.noReplacementNoChange = store.viewMembersForView(view.id).length === before;
      }

      // 7) The replaced node still has ANOTHER connector on this view -- survives.
      {
        const bp = store.createPart({ type: 'BusinessProcess', label: 'RegrLevelItKeepBP', model, streams: ['S7'] });
        const dde = store.createPart({ type: 'DataDataEntity', label: 'RegrLevelItKeepDDE', model, streams: ['S7'] });
        store.createPart({ type: 'ApplicationCapability', label: 'RegrLevelItKeepCap', model, streams: ['S7'] });
        const other = store.createPart({ type: 'DataDataEntity', label: 'RegrLevelItKeepOther', model, streams: [] });
        const conn1 = store.createConnector({ from: bp.id, to: dde.id, connectorType: 'c', model, relationship: 'Association' });
        const conn2 = store.createConnector({ from: dde.id, to: other.id, connectorType: 'c', model, relationship: 'Association' });
        const { view, tab } = freshFf('RegrLevelIt7');
        const vmBp = store.createViewMember({ view: view.id, objectType: 'part', objectId: bp.id, x: 0, y: 0 });
        const vmDde = store.createViewMember({ view: view.id, objectType: 'part', objectId: dde.id, x: 100, y: 0 });
        const vmOther = store.createViewMember({ view: view.id, objectType: 'part', objectId: other.id, x: 200, y: 0 });
        store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn1.id, fromVmId: vmBp.id, toVmId: vmDde.id });
        store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn2.id, fromVmId: vmDde.id, toVmId: vmOther.id });
        commands.levelIt(app, tab, vmDde.id);
        out.originalVmSurvivesWithOtherConn = store.viewMembersForView(view.id).some(v => v.objectType === 'part' && v.objectId === dde.id);
      }

      // 8) Section-based view -- no changes even called directly.
      {
        const view = store.addView('RegrLevelIt8_' + Date.now(), 'org');
        const tab = app.createCanvasTab(view);
        app.switchToTab(tab.id);
        const bp = store.createPart({ type: 'BusinessProcess', label: 'RegrLevelItSecBP', model, streams: ['S8'] });
        const dde = store.createPart({ type: 'DataDataEntity', label: 'RegrLevelItSecDDE', model, streams: ['S8'] });
        store.createPart({ type: 'ApplicationCapability', label: 'RegrLevelItSecCap', model, streams: ['S8'] });
        const conn = store.createConnector({ from: bp.id, to: dde.id, connectorType: 'c', model, relationship: 'Association' });
        const vmBp = store.createViewMember({ view: view.id, objectType: 'part', objectId: bp.id, x: 0, y: 0, sectionId: '' });
        const vmDde = store.createViewMember({ view: view.id, objectType: 'part', objectId: dde.id, x: 100, y: 0, sectionId: '' });
        store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: vmBp.id, toVmId: vmDde.id });
        const before = store.viewMembersForView(view.id).length;
        commands.levelIt(app, tab, vmDde.id);
        out.sectionViewNoChange = store.viewMembersForView(view.id).length === before;
      }

      return out;
    }
    """)
    problems = []
    if not result["ddeVmGone"]:
        problems.append("expected the DataDataEntity's own viewMember to be removed from this view after replacement")
    if not result["appCapVmPresent"]:
        problems.append("expected an ApplicationCapability viewMember to be placed on this view")
    if not result["appCapVmAtOldPos"]:
        problems.append("expected the replacement node to land exactly where the old DataDataEntity node was")
    if not result["origConnVmGone"]:
        problems.append("expected the original connector's viewMember to be removed from this view")
    if not result["origConnStillInModel"]:
        problems.append("expected the original Connector to remain untouched in the model (never deleted)")
    if not result["ddePartStillInModel"]:
        problems.append("expected the original DataDataEntity Part to remain untouched in the model (never deleted)")
    if not result["newStreamConnCorrectDirection"]:
        problems.append("expected a new 's' Stream connector from BusinessProcess to the ApplicationCapability")
    if not result["newStreamConnHasStream"]:
        problems.append("expected the new Stream connector to carry the DataDataEntity's own stream name")
    if not result["newCompanionExists"]:
        problems.append("expected a companion 'c' connector to also be created alongside the new 's' connector")
    if not result["earlierNodeReplaced"]:
        problems.append("expected right-clicking the EARLIER node (BusinessProcess) to replace IT, not the later neighbor")
    if not result["laterNeighborUntouched"]:
        problems.append("expected the later neighbor (DataDataEntity) to remain untouched when the earlier node is the one being replaced")
    if not result["apcVmPresent"]:
        problems.append("expected BusinessProcess to be replaced with ApplicationPhysicalComponent (template index 7, immediately before DataDataEntity)")
    if not result["earlierCaseCorrectDirection"]:
        problems.append("expected the new connector to run ApplicationPhysicalComponent -> DataDataEntity (template order) even though the ORIGINAL connector ran DataDataEntity -> BusinessProcess")
    if not result["earlierCaseNoBackwardsConn"]:
        problems.append("expected no backwards (DataDataEntity -> ApplicationPhysicalComponent) Stream connector to be created")
    if not result["adjacentNoChange"]:
        problems.append("expected already-adjacent template positions to produce no changes")
    if not result["unknownTypeNoChange"]:
        problems.append("expected a type not part of the template's chain to produce no changes")
    if not result["noReplacementNoChange"]:
        problems.append("expected no existing replacement part for the node's own stream to abort with no changes (never create a new one)")
    if not result["originalVmSurvivesWithOtherConn"]:
        problems.append("expected the original node's own viewMember to survive when it still has another connector on this view")
    if not result["sectionViewNoChange"]:
        problems.append("expected a section-based view to produce no changes even when levelIt is called directly")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Level It replaces a node directly connected across a stream-template chain gap with an existing node of the correct intermediate type (view-scoped, direction-correct, never deleting model data, never creating new replacement parts), and correctly no-ops on adjacency/unknown-type/no-replacement/section-view cases"


def check_level_it_context_menu_and_toolbar_wiring(page):
    """Regression guard for the real UI wiring of the new "Level It" command
    (getCommandDefs/CMD_ICONS, render.js; runCommand, main.js) — confirms it's reached
    end to end through the actual right-click context menu and toolbar, not just the
    underlying commands.js function (covered separately by
    check_level_it_replaces_across_template_gap). Covers: (1) right-clicking a single
    node on a freeform view shows an enabled 'Level It' item, and clicking it performs
    the real replacement through runCommand; (2) the same command also appears as a
    toolbar button (getCommandDefs backs both surfaces, same as every other command);
    (3) right-clicking a node on a SECTION-based view shows 'Level It' disabled (or
    absent) — freeform views only, per the report."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      store.doc.industryTemplateName = 'Enterprise';
      const out = {};

      const bp = store.createPart({ type: 'BusinessProcess', label: 'RegrLevelItUiBP', model, streams: ['RegrLevelItUiStream'] });
      const dde = store.createPart({ type: 'DataDataEntity', label: 'RegrLevelItUiDDE', model, streams: ['RegrLevelItUiStream'] });
      const appCap = store.createPart({ type: 'ApplicationCapability', label: 'RegrLevelItUiCap', model, streams: ['RegrLevelItUiStream'] });
      const conn = store.createConnector({ from: bp.id, to: dde.id, connectorType: 'c', model, relationship: 'Association' });
      const view = store.addView('RegrLevelItUi_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const vmBp = store.createViewMember({ view: view.id, objectType: 'part', objectId: bp.id, x: 60, y: 60 });
      const vmDde = store.createViewMember({ view: view.id, objectType: 'part', objectId: dde.id, x: 300, y: 60 });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: vmBp.id, toVmId: vmDde.id });
      app.render();
      await new Promise(r => setTimeout(r, 80));

      const ddeEl = document.querySelector(`.fnode[data-vm-id="${vmDde.id}"]`);
      const box = ddeEl.getBoundingClientRect();
      ddeEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: box.left + 10, clientY: box.top + 10 }));
      await new Promise(r => setTimeout(r, 60));
      const menuItem = [...document.querySelectorAll('.cmd-context-item')].find(el => el.textContent.includes('Level It'));
      out.contextMenuHasLevelIt = !!menuItem;
      out.contextMenuLevelItEnabled = !!menuItem && !menuItem.classList.contains('disabled');

      menuItem.click();
      await new Promise(r => setTimeout(r, 100));
      const vmsAfter = store.viewMembersForView(view.id);
      out.realClickReplaced = vmsAfter.some(v => v.objectType === 'part' && v.objectId === appCap.id) && !vmsAfter.some(v => v.objectType === 'part' && v.objectId === dde.id);

      const bpEl = document.querySelector(`.fnode[data-vm-id="${vmBp.id}"]`);
      bpEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      app.render();
      await new Promise(r => setTimeout(r, 60));
      out.toolbarHasLevelIt = [...document.querySelectorAll('#commands-list button')].some(b => (b.title || '').includes('Level It'));

      const view2 = store.addView('RegrLevelItUiSection_' + Date.now(), 'org');
      const tab2 = app.createCanvasTab(view2);
      app.switchToTab(tab2.id);
      const bp2 = store.createPart({ type: 'BusinessProcess', label: 'RegrLevelItUiBP2', model, streams: [] });
      const vmBp2 = store.createViewMember({ view: view2.id, objectType: 'part', objectId: bp2.id, x: 0, y: 0, sectionId: '' });
      app.render();
      await new Promise(r => setTimeout(r, 80));
      const bp2El = document.querySelector(`.fnode[data-vm-id="${vmBp2.id}"]`);
      const box2 = bp2El.getBoundingClientRect();
      bp2El.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: box2.left + 10, clientY: box2.top + 10 }));
      await new Promise(r => setTimeout(r, 60));
      const menuItem2 = [...document.querySelectorAll('.cmd-context-item')].find(el => el.textContent.includes('Level It'));
      out.sectionViewLevelItDisabled = !menuItem2 || menuItem2.classList.contains('disabled');

      return out;
    }
    """)
    problems = []
    if not result["contextMenuHasLevelIt"]:
        problems.append("expected a 'Level It' item in the right-click context menu for a single node on a freeform view")
    if not result["contextMenuLevelItEnabled"]:
        problems.append("expected 'Level It' to be enabled for this exact scenario")
    if not result["realClickReplaced"]:
        problems.append("expected clicking the real context menu item to perform the actual replacement via runCommand")
    if not result["toolbarHasLevelIt"]:
        problems.append("expected a 'Level It' button in the Commands toolbar too (getCommandDefs backs both surfaces)")
    if not result["sectionViewLevelItDisabled"]:
        problems.append("expected 'Level It' to be disabled or absent on a section-based view")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "The real right-click context menu and Commands toolbar both offer 'Level It' for a single node on a freeform view, correctly perform the replacement when clicked, and correctly disable it on a section-based view"


def check_level_up_creates_data_data_entity(page):
    """Regression guard/new-feature check, reported directly: "Enhancement: when a
    single dataentitydetail is selected and user selects 'level-up' command, create
    (if doesn't already exist, otherwise just open) a new datadataentity part/node of
    the same label name with link/connector result as when done in reverse where
    user selected datadataentity and did level-down." Implemented as a special case
    inside runCommand's 'levelUp' branch (main.js): when exactly one selected
    ViewMember is a DataEntityDetails part, dispatches to the new
    levelUpEntityDetails (commands.js) instead of the ordinary "prompt for a new view
    name" Level Up -- every other selection (none, multiple, or a different type)
    keeps the unchanged original behavior. levelUpEntityDetails first checks for an
    EXISTING parent via findCompositionParentConn (the reverse walk of the same
    Composition-lookup levelDownSingle's own reuse guard uses) -- if found, just
    opens/selects wherever that parent Part is placed, no duplicate created. If not,
    creates a new DataDataEntity part with the SAME label, a fresh dedicated view
    (same dedup-suffix naming levelDownSingle uses), an unplaced Composition
    connector (from: new parent, to: this DataEntityDetails part) -- the exact same
    link shape levelDownSingle produces in the other direction -- and the new
    parent's own ViewMember linkedViewName pointing back down at the CURRENT
    (Entity Details) view, so double-clicking the new parent node
    (openOrCreateLinkedView) navigates straight back to it. Covers: first Level Up
    creates exactly one new DataDataEntity part + the Composition connector +
    correct linkedViewName, and switches to a view named after the label;
    double-clicking that new parent node navigates back to the original Entity
    Details view; a SECOND Level Up on the same Entity Details node reuses the
    existing parent (no duplicate part, switches to the SAME view) instead of
    creating another one; and a selection that ISN'T a single DataEntityDetails part
    still gets the ordinary Level Up dialog, unaffected by this feature."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const view = store.addView('RegrLevelUp_' + Date.now(), 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const details = store.createPart({ type: 'DataEntityDetails', label: 'RegrLevelUpWidget', model, streams: [],
        attributes: [{ id: 'lu1', name: 'id', dataType: 'numeric', nullable: false, isPrimaryKey: true }] });
      const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: details.id, x: 100, y: 100 });
      app.recordAndRender();
      tab.selection = new Set([vm.id]);
      app.render();

      app.runCommand('levelUp');
      await new Promise(r => setTimeout(r, 60));

      const parentParts = store.doc.parts.filter(p => p.label === 'RegrLevelUpWidget' && p.type === 'DataDataEntity');
      const conn = store.doc.connectors.find(c => c.relationship === 'Composition' && c.to === details.id);
      let activeTab = store.activeTab();
      let activeView = store.findView(activeTab.viewId);
      const parentPartId = parentParts[0]?.id;
      const parentVm = parentPartId ? store.viewMembersForView(activeView.id).find(v => v.objectType === 'part' && v.objectId === parentPartId) : null;

      // Double-click the new parent node -> should navigate back down to this view.
      app.openOrCreateLinkedView(activeTab, parentVm.id);
      await new Promise(r => setTimeout(r, 60));
      const viewIdAfterDoubleClick = store.activeTab().viewId;

      // Go back to the Entity Details view, select it, Level Up a SECOND time.
      const detailsTab2 = app.createCanvasTab(view);
      app.switchToTab(detailsTab2.id);
      detailsTab2.selection = new Set([vm.id]);
      app.render();
      app.runCommand('levelUp');
      await new Promise(r => setTimeout(r, 60));
      const parentPartsAfterSecond = store.doc.parts.filter(p => p.label === 'RegrLevelUpWidget' && p.type === 'DataDataEntity');
      activeTab = store.activeTab();
      activeView = store.findView(activeTab.viewId);

      // Sanity: an unrelated selection (none) still gets the ordinary dialog.
      const detailsTab3 = app.createCanvasTab(view);
      app.switchToTab(detailsTab3.id);
      detailsTab3.selection = new Set();
      app.render();
      app.runCommand('levelUp');
      await new Promise(r => setTimeout(r, 60));
      const modalOpen = !!document.querySelector('.modal-box');
      document.querySelector('.modal-box .cancel')?.click();

      return {
        parentPartsCount: parentParts.length,
        conn,
        parentPartId,
        parentVmLinkedViewName: parentVm ? parentVm.linkedViewName : null,
        originalViewId: view.id,
        viewIdAfterDoubleClick,
        parentPartsAfterSecondCount: parentPartsAfterSecond.length,
        viewNameAfterSecond: activeView ? activeView.viewName : null,
        modalOpen,
      };
    }
    """)
    problems = []
    if result["parentPartsCount"] != 1:
        problems.append(f"expected exactly 1 new DataDataEntity part named after the label, got {result['parentPartsCount']}")
    if not result["conn"] or result["conn"]["from"] != result["parentPartId"] or result["conn"]["relationship"] != "Composition":
        problems.append(f"expected an unplaced Composition connector from the new parent to the Entity Details part, got {result['conn']}")
    if result["parentVmLinkedViewName"] != result["originalViewId"]:
        problems.append(f"expected the new parent's own ViewMember linkedViewName to point back at the Entity Details view, got {result['parentVmLinkedViewName']!r} vs {result['originalViewId']!r}")
    if result["viewIdAfterDoubleClick"] != result["originalViewId"]:
        problems.append(f"expected double-clicking the new parent node to navigate back to the Entity Details view, got {result['viewIdAfterDoubleClick']!r}")
    if result["parentPartsAfterSecondCount"] != 1:
        problems.append(f"expected a SECOND Level Up to reuse the existing parent (still exactly 1), got {result['parentPartsAfterSecondCount']}")
    if result["viewNameAfterSecond"] != "RegrLevelUpWidget":
        problems.append(f"expected the second Level Up to switch to the existing parent's view, got {result['viewNameAfterSecond']!r}")
    if not result["modalOpen"]:
        problems.append("expected Level Up with no relevant selection to still show its ordinary dialog")
    if problems:
        return False, "; ".join(problems)
    return True, "Level Up on a single selected DataEntityDetails node creates (or reuses) its DataDataEntity parent with the same link shape Level Down produces in reverse (Composition connector + linkedViewName back down), while every other selection keeps the ordinary Level Up dialog"


def check_smart_check_composition_top_down(page):
    """Regression guard: after Level Down (see check_level_down_creates_composition_link),
    adding a NEW part at the PARENT level and connecting it to the leveled-down part used
    to be invisible from the child view — reported directly: "if I add a dataentity...
    and connect it to the process, the new part does not show up in the lower level as an
    external part." Also covers the flip side of the same report: "smart check view
    brings in the part process, which we don't want as we're in that process" — Smart
    Check View must redirect the parent's own connections onto the child anchor instead
    of duplicating the parent itself as a node on its own decomposition view. Uses a part
    (X) connected to the parent AFTER Level Down, with no other path onto the child
    view, so this can only pass via the proactive composition scan (organic BFS
    connectivity alone can't reach it)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const view = store.addView('RegrCompTD_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const proc = store.createPart({ type: 'ApplicationProcess', label: 'TDProc', model: store.defaultModel, streams: [] });
      const procVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: proc.id, x: 40, y: 40 });
      app.openOrCreateLinkedView(tab, procVm.id);
      await new Promise(r => setTimeout(r, 150));
      const childView = store.findView('TDProc');
      const childTab = store.tabs.find(t => t.type === 'canvas' && t.viewId === childView.id);
      const anchorVm = store.viewMembersForView(childView.id).find(v => v.objectType === 'part' && !v.isExternal);
      const anchorPart = store.findPart(anchorVm.objectId);

      const xPart = store.createPart({ type: 'GeneralActor', label: 'TDExternal', model: store.defaultModel, streams: [] });
      const xVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: xPart.id, x: 400, y: 40 });
      const connX = store.createConnector({ from: proc.id, to: xPart.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: connX.id, fromVmId: procVm.id, toVmId: xVm.id });

      const res = commands.smartCheckView(app, childTab, { missingConnectors: true, missingConnectorsAndNodes: true, levels: null });
      const childPartVms = store.viewMembersForView(childView.id).filter(v => v.objectType === 'part');
      const procOnChildView = childPartVms.some(v => v.objectId === proc.id);
      const xVmOnChild = childPartVms.find(v => v.objectId === xPart.id);
      const mirroredConn = store.viewMembersForView(childView.id).filter(v => v.objectType === 'connector').map(v => store.findConnector(v.objectId))
        .find(c => (c.from === anchorPart.id && c.to === xPart.id) || (c.to === anchorPart.id && c.from === xPart.id));
      const selfLoops = store.doc.connectors.filter(c => c.from === c.to);
      return {
        nodesAdded: res.nodesAdded, connectorsAdded: res.connectorsAdded,
        procOnChildView, xOnChildView: !!xVmOnChild, xIsExternal: xVmOnChild ? xVmOnChild.isExternal : null,
        mirroredConnRelationship: mirroredConn ? mirroredConn.relationship : null,
        selfLoopCount: selfLoops.length,
      };
    }
    """)
    problems = []
    if result["procOnChildView"]:
        problems.append("expected the parent part NOT to be duplicated onto its own decomposition view")
    if not result["xOnChildView"] or not result["xIsExternal"]:
        problems.append(f"expected the new parent-level part to be pulled into the child view as external, got xOnChildView={result['xOnChildView']} xIsExternal={result['xIsExternal']}")
    if result["mirroredConnRelationship"] != "Association":
        problems.append(f"expected a mirrored connector (anchor<->new part) carrying the original relationship, got {result['mirroredConnRelationship']}")
    if result["selfLoopCount"] != 0:
        problems.append(f"expected no self-loop connectors, got {result['selfLoopCount']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Smart Check View redirects a parent's new connection onto the decomposition anchor instead of duplicating the parent, with no self-loops"


def check_smart_check_composition_bottom_up(page):
    """Regression guard for the bottom-up half of the user's own stated rule: "if the
    part has a connector to another part that is not of the same parent, then it is
    external and a connector added to the parent as well; if the part has connectors to
    other parts that are connected to the same parent, then it does not need to be added
    to the parent as well." Connects the child anchor to a genuinely external new part
    (Y) and to a sibling (S, also composed under the same parent via its own Composition
    connector) — only Y's connection should get mirrored up to the parent; S's should
    not, since it's purely internal to this decomposition."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const view = store.addView('RegrCompBU_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const proc = store.createPart({ type: 'ApplicationProcess', label: 'BUProc', model: store.defaultModel, streams: [] });
      const procVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: proc.id, x: 40, y: 40 });
      app.openOrCreateLinkedView(tab, procVm.id);
      await new Promise(r => setTimeout(r, 150));
      const childView = store.findView('BUProc');
      const childTab = store.tabs.find(t => t.type === 'canvas' && t.viewId === childView.id);
      const anchorVm = store.viewMembersForView(childView.id).find(v => v.objectType === 'part' && !v.isExternal);
      const anchorPart = store.findPart(anchorVm.objectId);

      const yPart = store.createPart({ type: 'GeneralActor', label: 'BUExternal', model: store.defaultModel, streams: [] });
      const yVm = store.createViewMember({ view: childView.id, objectType: 'part', objectId: yPart.id, x: 400, y: 300 });
      const connY = store.createConnector({ from: anchorPart.id, to: yPart.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      store.createViewMember({ view: childView.id, objectType: 'connector', objectId: connY.id, fromVmId: anchorVm.id, toVmId: yVm.id });

      const sPart = store.createPart({ type: 'GeneralActor', label: 'BUSibling', model: store.defaultModel, streams: [] });
      const compSibling = store.createConnector({ from: proc.id, to: sPart.id, model: store.defaultModel, connectorType: 'c', relationship: 'Composition' });
      const sVm = store.createViewMember({ view: childView.id, objectType: 'part', objectId: sPart.id, x: 400, y: 500 });
      const connS = store.createConnector({ from: anchorPart.id, to: sPart.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      store.createViewMember({ view: childView.id, objectType: 'connector', objectId: connS.id, fromVmId: anchorVm.id, toVmId: sVm.id });

      const res = commands.smartCheckView(app, childTab, { missingConnectors: true, missingConnectorsAndNodes: false, levels: null });
      const parentYConn = store.doc.connectors.find(c => c.relationship !== 'Composition' && ((c.from === proc.id && c.to === yPart.id) || (c.from === yPart.id && c.to === proc.id)));
      const parentSConn = store.doc.connectors.find(c => c.id !== compSibling.id && c.relationship !== 'Composition' && ((c.from === proc.id && c.to === sPart.id) || (c.from === sPart.id && c.to === proc.id)));
      return { parentConnectorsAdded: res.parentConnectorsAdded, parentYConnExists: !!parentYConn, parentSConnExists: !!parentSConn };
    }
    """)
    problems = []
    if not result["parentYConnExists"]:
        problems.append("expected the child anchor's connection to a genuinely external part to be mirrored up to the parent")
    if result["parentSConnExists"]:
        problems.append("expected the child anchor's connection to a SIBLING (composed under the same parent) NOT to be mirrored up — it's internal to this decomposition")
    if result["parentConnectorsAdded"] != 1:
        problems.append(f"expected exactly 1 connector mirrored up (the external one only), got {result['parentConnectorsAdded']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Smart Check View mirrors a decomposition's external connections up to the parent, correctly skipping connections to siblings under the same parent"


def check_smart_check_node_composition_redirect(page):
    """Regression guard for the other half of the user's report: "Smart check node
    doesn't see the new connection to its parent" — Smart Check Node run ON the
    decomposition's own anchor part must also pick up a brand new connection made to the
    PARENT part after Level Down (via the same composition-awareness Smart Check View
    uses), pulling the new part in and connecting it to the anchor rather than finding
    nothing (the anchor and the parent are now genuinely different parts, so a plain
    connectivity walk from the anchor's own id could never reach it on its own)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const view = store.addView('RegrCompNode_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const proc = store.createPart({ type: 'ApplicationProcess', label: 'NodeProc', model: store.defaultModel, streams: [] });
      const procVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: proc.id, x: 40, y: 40 });
      app.openOrCreateLinkedView(tab, procVm.id);
      await new Promise(r => setTimeout(r, 150));
      const childView = store.findView('NodeProc');
      const childTab = store.tabs.find(t => t.type === 'canvas' && t.viewId === childView.id);
      const anchorVm = store.viewMembersForView(childView.id).find(v => v.objectType === 'part' && !v.isExternal);
      const anchorPart = store.findPart(anchorVm.objectId);

      const zPart = store.createPart({ type: 'GeneralActor', label: 'NodeExternal', model: store.defaultModel, streams: [] });
      const connZ = store.createConnector({ from: zPart.id, to: proc.id, model: store.defaultModel, connectorType: 'c', relationship: 'Triggering', streams: [] });

      const res = commands.smartCheckNode(app, childTab, anchorPart.id, { missingConnectors: true, missingConnectorsAndNodes: true, levels: null, upstream: true, downstream: true });
      const childPartVms = store.viewMembersForView(childView.id).filter(v => v.objectType === 'part');
      const procOnChildView = childPartVms.some(v => v.objectId === proc.id);
      const zOnChildView = childPartVms.some(v => v.objectId === zPart.id);
      return { nodesAdded: res.nodesAdded, procOnChildView, zOnChildView };
    }
    """)
    problems = []
    if not result["zOnChildView"]:
        problems.append("expected Smart Check Node (run on the anchor) to discover and pull in the part newly connected to the parent")
    if result["procOnChildView"]:
        problems.append("expected the parent part NOT to be pulled in as a duplicate node")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Smart Check Node, run on a Level Down anchor, discovers a brand-new connection made at the parent level via the Composition link, without duplicating the parent"


def check_smart_check_sync_with_inventory_checkbox(page):
    """Regression guard for Smart Check View/Node's new "Sync existing connectors with
    inventory" checkbox (unchecked by default) — the REPLACEMENT for an earlier,
    automatic bidirectional recency-based sync that turned out to be too surprising
    (silently overwriting either side with no warning). Reported directly, twice: first
    "smart check does not update the connector type... when will it change?", then
    after the automatic fix, "still not working... let's change approach... add a new
    checkbox 'sync existing connectors with inventory'... when it is checked compare
    current view or node connectors against the related part to part connector, and if
    different update the view." Covers: (1) with the checkbox OFF, a drifted view
    connector (Level Down's own crossing connector) stays drifted even after a normal
    Smart Check run — no more silent auto-sync; (2) with it ON, the view connector is
    updated to match its inventory (parent-level) counterpart, one direction only; (3)
    editing the view connector afterward and running Smart Check WITHOUT the checkbox
    again does NOT push that edit back up to the inventory connector — confirming there
    is no automatic bidirectional behavior left at all, only this explicit, opt-in,
    one-directional (inventory -> view) sync. Checks both Smart Check View and Smart
    Check Node."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const view = store.addView('RegrSyncCheckbox_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const proc = store.createPart({ type: 'ApplicationProcess', label: 'CkboxProc', model: store.defaultModel, streams: [] });
      const procVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: proc.id, x: 40, y: 40 });
      const xPart = store.createPart({ type: 'GeneralActor', label: 'CkboxExternal', model: store.defaultModel, streams: [] });
      const xVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: xPart.id, x: 300, y: 40 });
      const connP = store.createConnector({ from: proc.id, to: xPart.id, model: store.defaultModel, connectorType: 'c', relationship: 'Flow', streams: [] });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: connP.id, fromVmId: procVm.id, toVmId: xVm.id });

      app.openOrCreateLinkedView(tab, procVm.id);
      await new Promise(r => setTimeout(r, 150));
      const childView = store.findView('CkboxProc');
      const childTab = store.tabs.find(t => t.type === 'canvas' && t.viewId === childView.id);
      const anchorVm = store.viewMembersForView(childView.id).find(v => v.objectType === 'part' && !v.isExternal);
      const anchorPart = store.findPart(anchorVm.objectId);
      const connC = store.doc.connectors.find(c => c.mirrorOf === connP.id);

      // Edit the PARENT-level (inventory) connector directly.
      connP.relationship = 'Serving';
      connP.streams = ['Beta'];
      store.touchConnector(connP);

      // (1) Checkbox OFF: normal Smart Check run should NOT auto-sync anymore.
      const res1 = commands.smartCheckView(app, childTab, { missingConnectors: true, missingConnectorsAndNodes: true, syncWithInventory: false });
      const connCAfterOff = { relationship: connC.relationship, streams: [...connC.streams] };

      // (2) Checkbox ON: now it should sync, one direction (inventory -> view).
      const res2 = commands.smartCheckView(app, childTab, { missingConnectors: true, syncWithInventory: true });
      const connCAfterOn = { relationship: connC.relationship, streams: [...connC.streams] };

      // (3) Edit the VIEW connector, run Smart Check WITHOUT the checkbox -- should
      // NOT push back up to the inventory connector (no automatic bidirectionality).
      connC.relationship = 'Triggering';
      connC.streams = ['Gamma'];
      store.touchConnector(connC);
      const res3 = commands.smartCheckView(app, childTab, { missingConnectors: true, syncWithInventory: false });
      const connPAfterChildEdit = { relationship: connP.relationship, streams: [...connP.streams] };

      // Smart Check Node: same checkbox, scoped to the anchor's own connectors.
      const resNodeOff = commands.smartCheckNode(app, childTab, anchorPart.id, { missingConnectors: true, syncWithInventory: false });
      const connCAfterNodeOff = { relationship: connC.relationship, streams: [...connC.streams] };
      const resNodeOn = commands.smartCheckNode(app, childTab, anchorPart.id, { missingConnectors: true, syncWithInventory: true });
      const connCAfterNodeOn = { relationship: connC.relationship, streams: [...connC.streams] };

      return {
        res1connectorsUpdated: res1.connectorsUpdated, connCAfterOff,
        res2connectorsUpdated: res2.connectorsUpdated, connCAfterOn,
        res3connectorsUpdated: res3.connectorsUpdated, connPAfterChildEdit,
        resNodeOffConnectorsUpdated: resNodeOff.connectorsUpdated, connCAfterNodeOff,
        resNodeOnConnectorsUpdated: resNodeOn.connectorsUpdated, connCAfterNodeOn,
      };
    }
    """)
    problems = []
    if result["connCAfterOff"] != {"relationship": "Flow", "streams": []}:
        problems.append(f"expected the view connector to stay UNCHANGED with the checkbox off (no more automatic sync), got {result['connCAfterOff']}")
    if result["res1connectorsUpdated"] != 0:
        problems.append(f"expected 0 resynced with the checkbox off, got {result['res1connectorsUpdated']}")
    if result["connCAfterOn"] != {"relationship": "Serving", "streams": ["Beta"]}:
        problems.append(f"expected the view connector to be updated to match the inventory connector with the checkbox ON, got {result['connCAfterOn']}")
    if result["res2connectorsUpdated"] != 1:
        problems.append(f"expected 1 resynced with the checkbox on, got {result['res2connectorsUpdated']}")
    if result["connPAfterChildEdit"] != {"relationship": "Serving", "streams": ["Beta"]}:
        problems.append(f"expected editing the VIEW connector NOT to propagate back up to the inventory connector (no automatic bidirectionality), got {result['connPAfterChildEdit']}")
    if result["res3connectorsUpdated"] != 0:
        problems.append(f"expected 0 resynced for the view-side edit with the checkbox off, got {result['res3connectorsUpdated']}")
    if result["connCAfterNodeOff"] != {"relationship": "Triggering", "streams": ["Gamma"]}:
        problems.append(f"expected Smart Check Node with the checkbox off to leave the connector unchanged, got {result['connCAfterNodeOff']}")
    if result["connCAfterNodeOn"] != {"relationship": "Serving", "streams": ["Beta"]}:
        problems.append(f"expected Smart Check Node with the checkbox on to sync the connector to the inventory connector, got {result['connCAfterNodeOn']}")
    if result["resNodeOnConnectorsUpdated"] != 1:
        problems.append(f"expected Smart Check Node's checkbox-on run to report 1 resynced, got {result['resNodeOnConnectorsUpdated']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Smart Check View/Node's new 'Sync existing connectors with inventory' checkbox is opt-in and one-directional (inventory -> view); with it off, nothing auto-syncs in either direction"


def check_prompt_sync_inventory_connector(page):
    """Regression guard for App.promptSyncInventoryConnector — the new confirm-dialog
    mechanism hooked into the property panel's Relationship/Streams setters and the
    on-canvas edge popover (NOT the multi-select bulk-edit path). Reported directly:
    "when changing a view connector (either in property panel or on canvas), ask user
    if they want the inventory (ie part to part) connector to also be updated, and if
    they say yes then also update the related part to part connector." Covers: a
    connector WITH an inventory counterpart shows a confirm dialog and, on OK, updates
    the counterpart's relationship/streams to match; on Cancel, the counterpart is left
    untouched; a connector with NO counterpart (the common case — most connectors have
    no Composition-crossing relationship at all) shows no dialog at all."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view = store.addView('RegrPromptSync_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const proc = store.createPart({ type: 'ApplicationProcess', label: 'PromptProc', model: store.defaultModel, streams: [] });
      const procVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: proc.id, x: 40, y: 40 });
      const xPart = store.createPart({ type: 'GeneralActor', label: 'PromptExternal', model: store.defaultModel, streams: [] });
      const xVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: xPart.id, x: 300, y: 40 });
      const connP = store.createConnector({ from: proc.id, to: xPart.id, model: store.defaultModel, connectorType: 'c', relationship: 'Flow', streams: [] });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: connP.id, fromVmId: procVm.id, toVmId: xVm.id });
      app.openOrCreateLinkedView(tab, procVm.id);
      await new Promise(r => setTimeout(r, 150));
      const childView = store.findView('PromptProc');
      const connC = store.doc.connectors.find(c => c.mirrorOf === connP.id);

      // No counterpart at all: should show no dialog.
      const plainPart1 = store.createPart({ type: 'GeneralActor', label: 'Plain1', model: store.defaultModel, streams: [] });
      const plainPart2 = store.createPart({ type: 'GeneralActor', label: 'Plain2', model: store.defaultModel, streams: [] });
      const plainConn = store.createConnector({ from: plainPart1.id, to: plainPart2.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      app.promptSyncInventoryConnector(plainConn);
      await new Promise(r => setTimeout(r, 60));
      const noDialogForPlainConn = !document.querySelector('.modal-overlay');

      // Has a counterpart, click OK.
      connC.relationship = 'Serving';
      connC.streams = ['Beta'];
      store.touchConnector(connC);
      app.promptSyncInventoryConnector(connC);
      await new Promise(r => setTimeout(r, 60));
      const dialogShown = !!document.querySelector('.modal-overlay');
      const dialogText = document.querySelector('.modal-overlay')?.textContent || '';
      document.querySelector('.modal-overlay .submit')?.click();
      await new Promise(r => setTimeout(r, 60));
      const connPAfterOk = { relationship: connP.relationship, streams: [...connP.streams] };

      // Edit again, click Cancel this time.
      connC.relationship = 'Triggering';
      connC.streams = ['Gamma'];
      store.touchConnector(connC);
      app.promptSyncInventoryConnector(connC);
      await new Promise(r => setTimeout(r, 60));
      document.querySelector('.modal-overlay .cancel')?.click();
      await new Promise(r => setTimeout(r, 60));
      const connPAfterCancel = { relationship: connP.relationship, streams: [...connP.streams] };

      return { noDialogForPlainConn, dialogShown, dialogText, connPAfterOk, connPAfterCancel };
    }
    """)
    problems = []
    if not result["noDialogForPlainConn"]:
        problems.append("expected NO dialog for a connector with no inventory counterpart (the common case)")
    if not result["dialogShown"]:
        problems.append("expected a confirm dialog for a connector WITH an inventory counterpart")
    if "inventory" not in result["dialogText"].lower():
        problems.append(f"expected the dialog text to mention 'inventory', got: {result['dialogText']}")
    if result["connPAfterOk"] != {"relationship": "Serving", "streams": ["Beta"]}:
        problems.append(f"expected clicking OK to update the inventory connector to match, got {result['connPAfterOk']}")
    if result["connPAfterCancel"] != {"relationship": "Serving", "streams": ["Beta"]}:
        problems.append(f"expected clicking Cancel to leave the inventory connector UNCHANGED (still the OK'd value from before), got {result['connPAfterCancel']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "promptSyncInventoryConnector shows a confirm dialog only when a related inventory connector exists, updates it on OK, and leaves it alone on Cancel"


def check_property_panel_relationship_edit_triggers_sync_prompt(page):
    """Regression guard proving the confirm-dialog mechanism is genuinely WIRED into the
    real property panel (not just callable directly, as check_prompt_sync_inventory_connector
    verifies) — selects the Level Down anchor's own crossing connector on the actual
    canvas, opens its real property panel, changes the real Relationship <select>
    element the same way a person would, and confirms a '.modal-overlay' with the
    inventory-sync prompt appears as a result."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      // Guarantee at least 2 valid relationship options for this type pair, regardless
      // of custom.json's actual configured pairs (a real pair might allow only 1,
      // which would make it impossible to pick a genuinely DIFFERENT option below) --
      // reassigning (not mutating in place) so findRelationshipPair's cache invalidates.
      store.mergedRelationshipPairs = [...store.mergedRelationshipPairs, { typeA: 'ApplicationProcess', typeB: 'GeneralActor', relations: 'fa', default: 'f' }];
      const view = store.addView('RegrPanelWiring_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const proc = store.createPart({ type: 'ApplicationProcess', label: 'WiringProc', model: store.defaultModel, streams: [] });
      const procVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: proc.id, x: 40, y: 40 });
      const xPart = store.createPart({ type: 'GeneralActor', label: 'WiringExternal', model: store.defaultModel, streams: [] });
      const xVm = store.createViewMember({ view: view.id, objectType: 'part', objectId: xPart.id, x: 300, y: 40 });
      const connP = store.createConnector({ from: proc.id, to: xPart.id, model: store.defaultModel, connectorType: 'c', relationship: 'Flow', streams: [] });
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: connP.id, fromVmId: procVm.id, toVmId: xVm.id });
      app.openOrCreateLinkedView(tab, procVm.id);
      await new Promise(r => setTimeout(r, 150));
      const childView = store.findView('WiringProc');
      const childTab = store.tabs.find(t => t.type === 'canvas' && t.viewId === childView.id);
      app.switchToTab(childTab.id);
      const connCVm = store.viewMembersForView(childView.id).find(v => v.objectType === 'connector');

      app.selectOnly(connCVm.id);
      app.render();
      await new Promise(r => setTimeout(r, 60));
      const select = [...document.querySelectorAll('#properties-body select')].find(s => [...s.options].some(o => /flow|serving|association/i.test(o.textContent)));
      const selectFound = !!select;
      if (select) {
        const targetOption = [...select.options].find(o => !/flow/i.test(o.textContent));
        select.value = targetOption.value;
        select.dispatchEvent(new Event('change'));
      }
      await new Promise(r => setTimeout(r, 100));
      const dialogAppeared = !!document.querySelector('.modal-overlay');
      document.querySelector('.modal-overlay .cancel')?.click();

      return { selectFound, dialogAppeared };
    }
    """)
    problems = []
    if not result["selectFound"]:
        problems.append("expected to find the Relationship <select> in the real property panel")
    if not result["dialogAppeared"]:
        problems.append("expected changing the real Relationship select to trigger the inventory-sync confirm dialog")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "changing the real Relationship field in the property panel genuinely triggers the inventory-sync confirm prompt, not just the direct function call"


def check_delete_offers_inventory_cleanup(page):
    """Regression guard/new-feature check for keyboard Delete's new "also delete from the
    model?" prompt. Reported directly: "check if underlying part or connector is used
    elsewhere, and if it is not then ask user if it should be deleted from inventory as
    well, and if they confirm then delete it from parts or connectors as well." Covers
    four cases via app.deleteSelection (the same method the real Delete/Backspace
    keydown handler calls): (A) a part placed on ANOTHER view too — no prompt, deleting
    its viewMember here must never touch the shared Part; (B) a part placed only here
    with no connectors — prompts, and confirming removes it from store.doc.parts; (C) a
    part placed only here but STILL referenced by a connector's from/to (even though
    that connector itself isn't placed on any view) — no prompt, since deleting the
    part would leave the connector's from/to dangling; (D) a connector placed only
    here — prompts, and confirming removes it from store.doc.connectors WITHOUT
    touching the parts it connects. In every prompted case, declining/no-op must leave
    the underlying record untouched — this is strictly an added option, never forced."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view1 = store.addView('DelViewA_' + Date.now());
      view1.viewType = 'ff';
      const view2 = store.addView('DelViewB_' + Date.now());
      view2.viewType = 'ff';
      const tab1 = app.createCanvasTab(view1);
      app.createCanvasTab(view2);
      app.switchToTab(tab1.id);

      const sharedPart = store.createPart({ type: 'GeneralActor', label: 'Shared', model: store.defaultModel, streams: [] });
      const vmA1 = store.createViewMember({ view: view1.id, objectType: 'part', objectId: sharedPart.id, x: 40, y: 40 });
      store.createViewMember({ view: view2.id, objectType: 'part', objectId: sharedPart.id, x: 40, y: 40 });

      const soloPart = store.createPart({ type: 'GeneralActor', label: 'Solo', model: store.defaultModel, streams: [] });
      const vmB = store.createViewMember({ view: view1.id, objectType: 'part', objectId: soloPart.id, x: 200, y: 40 });

      const connectedPart = store.createPart({ type: 'GeneralActor', label: 'Connected', model: store.defaultModel, streams: [] });
      const otherPart = store.createPart({ type: 'GeneralActor', label: 'Other', model: store.defaultModel, streams: [] });
      const vmC = store.createViewMember({ view: view1.id, objectType: 'part', objectId: connectedPart.id, x: 400, y: 40 });
      store.createConnector({ from: connectedPart.id, to: otherPart.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });

      const p1 = store.createPart({ type: 'GeneralActor', label: 'P1', model: store.defaultModel, streams: [] });
      const p2 = store.createPart({ type: 'GeneralActor', label: 'P2', model: store.defaultModel, streams: [] });
      const p1vm = store.createViewMember({ view: view1.id, objectType: 'part', objectId: p1.id, x: 600, y: 40 });
      const p2vm = store.createViewMember({ view: view1.id, objectType: 'part', objectId: p2.id, x: 600, y: 140 });
      const connD = store.createConnector({ from: p1.id, to: p2.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      const connDvm = store.createViewMember({ view: view1.id, objectType: 'connector', objectId: connD.id, fromVmId: p1vm.id, toVmId: p2vm.id });

      const results = {};

      tab1.selection.clear(); tab1.selection.add(vmA1.id);
      app.deleteSelection(tab1);
      await new Promise(r => setTimeout(r, 60));
      results.caseA_dialogShown = !!document.querySelector('.modal-overlay');
      results.caseA_vmGone = !store.findViewMember(vmA1.id);
      results.caseA_partStillExists = !!store.findPart(sharedPart.id);
      document.querySelector('.modal-overlay .cancel')?.click();

      tab1.selection.clear(); tab1.selection.add(vmB.id);
      app.deleteSelection(tab1);
      await new Promise(r => setTimeout(r, 60));
      results.caseB_dialogShown = !!document.querySelector('.modal-overlay');
      document.querySelector('.modal-overlay .submit')?.click();
      await new Promise(r => setTimeout(r, 60));
      results.caseB_partDeletedAfterConfirm = !store.findPart(soloPart.id);

      tab1.selection.clear(); tab1.selection.add(vmC.id);
      app.deleteSelection(tab1);
      await new Promise(r => setTimeout(r, 60));
      results.caseC_dialogShown = !!document.querySelector('.modal-overlay');
      results.caseC_partStillExists = !!store.findPart(connectedPart.id);
      document.querySelector('.modal-overlay .cancel')?.click();

      tab1.selection.clear(); tab1.selection.add(connDvm.id);
      app.deleteSelection(tab1);
      await new Promise(r => setTimeout(r, 60));
      results.caseD_dialogShown = !!document.querySelector('.modal-overlay');
      document.querySelector('.modal-overlay .submit')?.click();
      await new Promise(r => setTimeout(r, 60));
      results.caseD_connDeletedAfterConfirm = !store.findConnector(connD.id);
      results.caseD_partsStillExist = !!store.findPart(p1.id) && !!store.findPart(p2.id);

      return results;
    }
    """)
    problems = []
    if result["caseA_dialogShown"]:
        problems.append("case A: expected NO prompt for a part still placed on another view")
    if not result["caseA_vmGone"] or not result["caseA_partStillExists"]:
        problems.append(f"case A: expected the viewMember removed but the shared Part untouched, got {result}")
    if not result["caseB_dialogShown"]:
        problems.append("case B: expected a prompt for a part placed only here with no connectors")
    if not result["caseB_partDeletedAfterConfirm"]:
        problems.append("case B: expected confirming the prompt to delete the part from store.doc.parts")
    if result["caseC_dialogShown"]:
        problems.append("case C: expected NO prompt for a part still referenced by a connector's from/to (would dangle if deleted)")
    if not result["caseC_partStillExists"]:
        problems.append("case C: expected the connected part to remain untouched")
    if not result["caseD_dialogShown"]:
        problems.append("case D: expected a prompt for a connector placed only here")
    if not result["caseD_connDeletedAfterConfirm"]:
        problems.append("case D: expected confirming the prompt to delete the connector from store.doc.connectors")
    if not result["caseD_partsStillExist"]:
        problems.append("case D: expected deleting the connector to NOT cascade-delete the parts it connects")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "keyboard Delete offers to also remove an orphaned part/connector from the model, skips parts still referenced elsewhere (including by a connector), and never cascades a connector deletion onto its parts"


def check_add_existing_prefiltered_by_section(page):
    """Regression guard/new-feature check for Add Existing (right-click > Add Existing on
    a section-based view, e.g. 'org') pre-filtering its row list by the section the
    pointer landed in, AND — the actual bug reported after the list-filter alone
    shipped — actually PLACING added parts into that section, not wherever
    createSectionPlacer's generic first-type-matching-section rule would otherwise put
    them: "add existing ignores mouse location or selected section, always adds to
    first section." Covers: right-clicking genuinely INSIDE a section shows only
    matching-type parts (with a subtitle naming it) AND the part added from there lands
    in THAT section specifically — using two sections that both allow the SAME element
    type, the one case that actually exposes "always lands in the first section" (since
    createSectionPlacer would happily accept either); a right-click outside any
    specific section (but still on a section-based view) falls back to the view-wide
    union of every section's allowed types, and — with no specific section resolved —
    to the SELECTED section (tab.selectedSectionId, from clicking a header) for
    placement if one is set, or the generic placer otherwise; a plain 'ff' view stays
    completely unfiltered/generically placed regardless of position."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const sections = await import('./js/sections.js');

      const view = store.addView('RegrAddExistingFilter_' + Date.now());
      view.viewType = 'org';
      view.sections = [
        { id: 'sec1', sectionId: 'sec1', name: 'Leadership', order: 0, rowCount: 1, columnCount: 2, elementTypes: ['BusinessActor'] },
        { id: 'sec2', sectionId: 'sec2', name: 'Delivery', order: 1, rowCount: 1, columnCount: 2, elementTypes: ['BusinessRole'] },
      ];
      const layout = sections.computeSectionLayout(view);
      const l1 = layout.find(e => e.section.id === 'sec1');
      const l2 = layout.find(e => e.section.id === 'sec2');

      const actor = store.createPart({ type: 'BusinessActor', label: 'ActorPart', model: store.defaultModel, streams: [] });
      const role = store.createPart({ type: 'BusinessRole', label: 'RolePart', model: store.defaultModel, streams: [] });
      const other = store.createPart({ type: 'GeneralActor', label: 'OtherPart', model: store.defaultModel, streams: [] });

      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const results = {};

      const check = (checkboxId) => { const cb = document.querySelector(checkboxId); cb.checked = true; cb.dispatchEvent(new Event('change')); };

      app.promptAddExisting(tab, { x: l1.left + 10, y: l1.top + 10 });
      await new Promise(r => setTimeout(r, 60));
      results.insideSection = [...document.querySelectorAll('#ae-tbody tr td:nth-child(2)')].map(td => td.textContent.trim());
      results.subtitle = document.querySelector('.modal-box div[style*="margin:-4px"]')?.textContent || '';
      document.querySelector('.modal-overlay .cancel')?.click();

      app.promptAddExisting(tab, { x: l2.left + 10, y: l2.top + l2.height + 200 });
      await new Promise(r => setTimeout(r, 60));
      results.outsideAnySection = [...document.querySelectorAll('#ae-tbody tr td:nth-child(2)')].map(td => td.textContent.trim());
      document.querySelector('.modal-overlay .cancel')?.click();

      const ffView = store.addView('RegrAddExistingFilterFF_' + Date.now());
      ffView.viewType = 'ff';
      const ffTab = app.createCanvasTab(ffView);
      app.switchToTab(ffTab.id);
      app.promptAddExisting(ffTab, { x: 10, y: 10 });
      await new Promise(r => setTimeout(r, 60));
      results.freeformView = [...document.querySelectorAll('#ae-tbody tr td:nth-child(2)')].map(td => td.textContent.trim());
      document.querySelector('.modal-overlay .cancel')?.click();
      app.switchToTab(tab.id);

      app.promptAddExisting(tab, undefined);
      await new Promise(r => setTimeout(r, 60));
      results.noCanvasPos = [...document.querySelectorAll('#ae-tbody tr td:nth-child(2)')].map(td => td.textContent.trim());
      document.querySelector('.modal-overlay .cancel')?.click();

      // The actual reported bug: two sections that both allow the SAME type
      // (GeneralActor) -- createSectionPlacer would always pick the first one
      // regardless of where the user clicked. Right-click inside the SECOND section
      // specifically and confirm the added part actually lands there.
      const view2 = store.addView('RegrAddExistingPlacement_' + Date.now());
      view2.viewType = 'org';
      view2.sections = [
        { id: 'p1', sectionId: 'p1', name: 'First', order: 0, rowCount: 2, columnCount: 2, elementTypes: ['GeneralActor'] },
        { id: 'p2', sectionId: 'p2', name: 'Second', order: 1, rowCount: 2, columnCount: 2, elementTypes: ['GeneralActor'] },
      ];
      const layout2 = sections.computeSectionLayout(view2);
      const p1entry = layout2.find(e => e.section.id === 'p1');
      const p2entry = layout2.find(e => e.section.id === 'p2');
      const genericPart = store.createPart({ type: 'GeneralActor', label: 'GenericPart', model: store.defaultModel, streams: [] });
      const tab2 = app.createCanvasTab(view2);
      app.switchToTab(tab2.id);

      app.promptAddExisting(tab2, { x: p2entry.left + 10, y: p2entry.top + 10 });
      await new Promise(r => setTimeout(r, 60));
      check('[data-id="' + genericPart.id + '"]');
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 60));
      const placedVm = store.viewMembersForView(view2.id).find(v => v.objectType === 'part' && v.objectId === genericPart.id);
      results.placedInSectionId = placedVm ? placedVm.sectionId : null;

      // Selected-section fallback: click doesn't land in any specific section, but one
      // is already selected via header-click (app.selectSection) -- placement should
      // still go to the SELECTED section, not the generic (first-match) placer.
      const genericPart2 = store.createPart({ type: 'GeneralActor', label: 'GenericPart2', model: store.defaultModel, streams: [] });
      app.selectSection(tab2, 'p2');
      app.promptAddExisting(tab2, { x: p2entry.left + 10, y: p2entry.top + p2entry.height + 300 });
      await new Promise(r => setTimeout(r, 60));
      check('[data-id="' + genericPart2.id + '"]');
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 60));
      const placedVm2 = store.viewMembersForView(view2.id).find(v => v.objectType === 'part' && v.objectId === genericPart2.id);
      results.selectedSectionPlacedInSectionId = placedVm2 ? placedVm2.sectionId : null;

      return results;
    }
    """)
    problems = []
    if sorted(result["insideSection"]) != ["ActorPart"]:
        problems.append(f"expected only the BusinessActor part when right-clicking inside 'Leadership' (elementTypes: ['BusinessActor']), got {result['insideSection']}")
    if "Leadership" not in result["subtitle"]:
        problems.append(f"expected a subtitle naming the section, got {result['subtitle']!r}")
    if sorted(result["outsideAnySection"]) != ["ActorPart", "RolePart"]:
        problems.append(f"expected the view-wide union (BusinessActor + BusinessRole, not GeneralActor) when right-clicking outside any specific section, got {result['outsideAnySection']}")
    if sorted(result["freeformView"]) != ["ActorPart", "OtherPart", "RolePart"]:
        problems.append(f"expected a plain freeform view to be completely unfiltered, got {result['freeformView']}")
    if sorted(result["noCanvasPos"]) != ["ActorPart", "RolePart"]:
        problems.append(f"expected no canvasPos at all (but still a section-based view) to still apply the view-wide union filter, got {result['noCanvasPos']}")
    if result["placedInSectionId"] != "p2":
        problems.append(f"expected the part added after right-clicking inside the SECOND of two same-type-allowing sections to actually be PLACED there, got sectionId={result['placedInSectionId']}")
    if result["selectedSectionPlacedInSectionId"] != "p2":
        problems.append(f"expected placement to fall back to the currently SELECTED section when the click itself didn't land in any specific section, got sectionId={result['selectedSectionPlacedInSectionId']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Add Existing pre-filters its row list AND places added parts based on the section right-clicked on (or currently selected), not wherever the generic first-type-matching-section placer would otherwise put them"


def check_insert_smart_stream_traversal(page):
    """Regression guard for commands.js's insertSmartStream (Insert Smart Stream —
    freeform-view-only command that traces a chain of parts/connectors by element type
    into the current view). Reported directly: "Add ability in freeform view to insert
    a smartStream... starting element..., upstream/downstream or both indicator, ending
    element..., children levels..., and a selector checklist of element types to show."
    Builds a realistic branching chain — BusinessFunction -> two BusinessProcesses ->
    ApplicationCapability -> two DataDataEntities, plus an unrelated BusinessActor
    connected upstream of the function (to prove direction filtering) — and a separate
    BusinessCollaboration/BusinessInterface pair linked ONLY by a Stream ('s') connector
    (to prove connectorType filtering, since both would otherwise become seeds by type
    regardless of any edge). Calls insertSmartStream directly (bypassing the dialog) for
    precision, covering: (1) baseline downstream trace with an endType stops-further-
    propagation part still collected; (2) levels cap; (3) showTypes pruning BOTH the
    excluded parts and any connector touching one; (4) upstream direction; (5)
    connectorType selecting only same-typed edges; (6) idempotent re-run adds nothing
    once everything is already on the view; (7) rejects with a toast naming the view
    type on a section-based view, adding nothing."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const mkPart = (type, label) => store.createPart({ type, label, model, streams: [] });
      const mkConn = (from, to, connectorType) => store.createConnector({ from: from.id, to: to.id, connectorType, model, relationship: 'Association' });

      const fn = mkPart('BusinessFunction', 'RegrISS_Fn');
      const proc1 = mkPart('BusinessProcess', 'RegrISS_Proc1');
      const proc2 = mkPart('BusinessProcess', 'RegrISS_Proc2');
      const cap = mkPart('ApplicationCapability', 'RegrISS_Cap');
      const de1 = mkPart('DataDataEntity', 'RegrISS_De1');
      const de2 = mkPart('DataDataEntity', 'RegrISS_De2');
      const unrelated = mkPart('BusinessActor', 'RegrISS_Unrelated');
      mkConn(fn, proc1, 'c'); mkConn(fn, proc2, 'c');
      mkConn(proc1, cap, 'c'); mkConn(proc2, cap, 'c');
      mkConn(cap, de1, 'c'); mkConn(cap, de2, 'c');
      mkConn(unrelated, fn, 'c');

      const collab = mkPart('BusinessCollaboration', 'RegrISS_Collab');
      const iface = mkPart('BusinessInterface', 'RegrISS_Iface');
      mkConn(collab, iface, 's');

      const allTypes = ['BusinessFunction', 'BusinessProcess', 'ApplicationCapability', 'DataDataEntity', 'BusinessActor', 'BusinessCollaboration', 'BusinessInterface'];
      const freshView = (name) => {
        const view = store.addView(name, 'ff');
        const tab = app.createCanvasTab(view);
        app.switchToTab(tab.id);
        return { view, tab };
      };
      const state = (view) => {
        const vms = store.viewMembersForView(view.id);
        const partVms = vms.filter(v => v.objectType === 'part');
        const connVms = vms.filter(v => v.objectType === 'connector');
        return { partCount: partVms.length, connCount: connVms.length, types: partVms.map(v => store.findPart(v.objectId).type).sort() };
      };

      const out = {};

      // 1) baseline: downstream, endType=DataDataEntity, unlimited levels, all types shown
      let { view: v1, tab: t1 } = freshView('RegrISS_baseline');
      commands.insertSmartStream(app, t1, { connectorType: 'c', startPartIds: [fn.id], direction: 'downstream', endType: 'DataDataEntity', levels: null, showTypes: allTypes });
      out.baseline = state(v1);

      // 2) levels=1 -> only the function + its two direct processes
      let { view: v2, tab: t2 } = freshView('RegrISS_levels1');
      commands.insertSmartStream(app, t2, { connectorType: 'c', startPartIds: [fn.id], direction: 'downstream', endType: null, levels: 1, showTypes: allTypes });
      out.levels1 = state(v2);

      // 3) showTypes excludes DataDataEntity -> cap's downstream edges to de1/de2 pruned too
      let { view: v3, tab: t3 } = freshView('RegrISS_excludetype');
      commands.insertSmartStream(app, t3, { connectorType: 'c', startPartIds: [fn.id], direction: 'downstream', endType: null, levels: null, showTypes: allTypes.filter(t => t !== 'DataDataEntity') });
      out.excludeType = state(v3);

      // 4) upstream from the capability -> reaches the processes, the function, and (continuing
      //    upstream past the function) the unrelated actor too, but never the data entities
      let { view: v4, tab: t4 } = freshView('RegrISS_upstream');
      commands.insertSmartStream(app, t4, { connectorType: 'c', startPartIds: [cap.id], direction: 'upstream', endType: null, levels: null, showTypes: allTypes });
      out.upstream = state(v4);

      // 5) connectorType: 'c' from the collaboration reaches nothing extra (only an 's' edge exists);
      //    'c' from the interface behaves the same. 's' DOES reach it.
      let { view: v5, tab: t5 } = freshView('RegrISS_connTypeC');
      commands.insertSmartStream(app, t5, { connectorType: 'c', startPartIds: [collab.id], direction: 'both', endType: null, levels: null, showTypes: allTypes });
      out.connTypeC = state(v5);
      let { view: v6, tab: t6 } = freshView('RegrISS_connTypeS');
      commands.insertSmartStream(app, t6, { connectorType: 's', startPartIds: [collab.id], direction: 'both', endType: null, levels: null, showTypes: allTypes });
      out.connTypeS = state(v6);

      // 6) idempotent re-run on the same (baseline) view adds nothing further
      commands.insertSmartStream(app, t1, { connectorType: 'c', startPartIds: [fn.id], direction: 'downstream', endType: 'DataDataEntity', levels: null, showTypes: allTypes });
      out.rerun = state(v1);

      // 7) rejected on a section-based view type, nothing added
      const orgView = store.addView('RegrISS_org', 'org');
      const orgTab = app.createCanvasTab(orgView);
      app.switchToTab(orgTab.id);
      commands.insertSmartStream(app, orgTab, { connectorType: 'c', startPartIds: [fn.id], direction: 'downstream', endType: null, levels: null, showTypes: allTypes });
      out.sectionRejected = state(orgView);

      // 8) no starting elements selected -> rejected, nothing added
      let { view: v8, tab: t8 } = freshView('RegrISS_noseed');
      commands.insertSmartStream(app, t8, { connectorType: 'c', startPartIds: [], direction: 'downstream', endType: null, levels: null, showTypes: allTypes });
      out.noSeed = state(v8);

      return out;
    }
    """)
    problems = []
    b = result["baseline"]
    if b["partCount"] != 6 or b["connCount"] != 6 or b["types"] != sorted(["BusinessFunction", "BusinessProcess", "BusinessProcess", "ApplicationCapability", "DataDataEntity", "DataDataEntity"]):
        problems.append(f"baseline downstream trace with endType=DataDataEntity: expected 6 parts/6 conns covering the whole chain (unrelated BusinessActor excluded by direction), got {b}")
    l1 = result["levels1"]
    if l1["partCount"] != 3 or l1["connCount"] != 2 or l1["types"] != sorted(["BusinessFunction", "BusinessProcess", "BusinessProcess"]):
        problems.append(f"levels=1 should stop at the function's direct processes, got {l1}")
    ex = result["excludeType"]
    if ex["partCount"] != 4 or ex["connCount"] != 4 or "DataDataEntity" in ex["types"]:
        problems.append(f"excluding DataDataEntity from showTypes should prune the data entities AND the capability's connectors to them, got {ex}")
    up = result["upstream"]
    if up["partCount"] != 5 or up["connCount"] != 5 or "DataDataEntity" in up["types"]:
        problems.append(f"upstream from the capability should reach the processes, function, and (continuing upstream) the unrelated actor, but not the data entities, got {up}")
    ctc = result["connTypeC"]
    if ctc["partCount"] != 1 or ctc["connCount"] != 0:
        problems.append(f"connectorType='c' trace from the collaboration should NOT follow the 's'-only edge to the interface, got {ctc}")
    cts = result["connTypeS"]
    if cts["partCount"] != 2 or cts["connCount"] != 1:
        problems.append(f"connectorType='s' trace from the collaboration SHOULD follow the 's' edge to the interface, got {cts}")
    rerun = result["rerun"]
    if rerun["partCount"] != 6 or rerun["connCount"] != 6:
        problems.append(f"re-running an identical trace on a view that already has every result should add nothing further, got {rerun}")
    sr = result["sectionRejected"]
    if sr["partCount"] != 0 or sr["connCount"] != 0:
        problems.append(f"Insert Smart Stream must refuse to run on a section-based view type, got {sr}")
    ns = result["noSeed"]
    if ns["partCount"] != 0 or ns["connCount"] != 0:
        problems.append(f"an empty startPartIds list must be rejected with nothing added, got {ns}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "insertSmartStream traces by connectorType/direction/levels/endType, prunes by showTypes (parts and their connectors), is idempotent, and refuses non-freeform views"


def check_insert_smart_stream_dialog(page):
    """Regression guard for the Insert Smart Stream dialog itself (main.js's
    promptInsertSmartStream) — a bespoke modal (promptModal has no multi-checkbox
    field type, so this dialog is hand-built) covering: the command is wired into the
    Commands panel; Starting/Ending Element options are scoped to types actually
    present in the current model (not the full toolbox type list, which would offer
    types nothing could ever be traced to/from); the Element Types to Show checklist
    is scoped to that SAME current-model type list too (reported directly: "reduce the
    'Element Types to Show' list to only show those currently existing in default
    model") and defaults to all checked; its Select All/Exclude All header checkbox
    toggles every row and itself reflects the rows' state; the Starting Element
    Instances checklist lists the actual part instances of the chosen Starting Element
    type (re-rendering, all-checked, when the type changes) and genuinely narrows which
    specific part(s) get used as seeds; the dialog renders as the wider modal-box-wide
    variant (reported directly: "The 'Insert Smart Stream' form is long, can it be
    reorganized to be shorter, perhaps wider?") rather than the default narrow modal
    width; and submitting calls through to insertSmartStream with the collected field
    values, landing the traced parts/connectors on the view."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;
      const fn1 = store.createPart({ type: 'BusinessFunction', label: 'RegrISSD_Fn1', model, streams: [] });
      const fn2 = store.createPart({ type: 'BusinessFunction', label: 'RegrISSD_Fn2', model, streams: [] });
      const proc1 = store.createPart({ type: 'BusinessProcess', label: 'RegrISSD_Proc1', model, streams: [] });
      const proc2 = store.createPart({ type: 'BusinessProcess', label: 'RegrISSD_Proc2', model, streams: [] });
      store.createConnector({ from: fn1.id, to: proc1.id, connectorType: 'c', model, relationship: 'Association' });
      store.createConnector({ from: fn2.id, to: proc2.id, connectorType: 'c', model, relationship: 'Association' });

      const view = store.addView('RegrISSD_view', 'ff');
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      app.render();

      const out = {};
      out.commandButtonPresent = !!document.querySelector('button[title^=\"Insert Smart Stream\"]');

      app.promptInsertSmartStream(tab);
      await new Promise(r => setTimeout(r, 30));
      out.modalBoxIsWide = document.querySelector('.modal-box').classList.contains('modal-box-wide');
      out.startOptions = [...document.querySelectorAll('#ss-start-type option')].map(o => o.value).sort();
      const allCbs = [...document.querySelectorAll('.ss-type-cb')];
      out.allCheckedByDefault = allCbs.every(cb => cb.checked);
      out.typeValues = allCbs.map(cb => cb.value).sort();

      // Starting Element Instances: defaults to the two BusinessFunction instances, all checked.
      out.startInstanceLabels = [...document.querySelectorAll('#ss-start-instances-list label')].map(l => l.textContent.trim()).sort();
      const startInstanceCbs = () => [...document.querySelectorAll('.ss-start-instance-cb')];
      out.startInstancesAllCheckedByDefault = startInstanceCbs().every(cb => cb.checked);

      // Switching Starting Element type re-renders the instance list for the new type.
      document.querySelector('#ss-start-type').value = 'BusinessProcess';
      document.querySelector('#ss-start-type').dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 30));
      out.startInstanceLabelsAfterTypeSwitch = [...document.querySelectorAll('#ss-start-instances-list label')].map(l => l.textContent.trim()).sort();

      // Switch back to BusinessFunction and uncheck Fn2 -> only Fn1's own branch should trace through.
      document.querySelector('#ss-start-type').value = 'BusinessFunction';
      document.querySelector('#ss-start-type').dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 30));
      const fn2cb = startInstanceCbs().find(cb => cb.closest('label').textContent.trim() === 'RegrISSD_Fn2');
      fn2cb.checked = false;
      fn2cb.dispatchEvent(new Event('change'));
      out.startSelectAllUncheckedAfterOneInstanceUnchecked = !document.querySelector('#ss-start-select-all').checked;

      // Uncheck one Element Types to Show row -> the Select All header should reflect the mixed state.
      allCbs[0].checked = false;
      allCbs[0].dispatchEvent(new Event('change'));
      out.selectAllUncheckedAfterOneRowUnchecked = !document.querySelector('#ss-types-select-all').checked;

      // Re-check via the Select All header -> every row should end up checked again.
      const selectAll = document.querySelector('#ss-types-select-all');
      selectAll.checked = true;
      selectAll.dispatchEvent(new Event('change'));
      out.allCheckedAfterSelectAllToggle = [...document.querySelectorAll('.ss-type-cb')].every(cb => cb.checked);

      document.querySelector('#ss-direction').value = 'downstream';
      document.querySelector('.modal-box .submit').click();
      await new Promise(r => setTimeout(r, 60));

      const vms = store.viewMembersForView(view.id);
      out.placedPartCount = vms.filter(v => v.objectType === 'part').length;
      out.placedConnCount = vms.filter(v => v.objectType === 'connector').length;
      out.dialogClosed = !document.querySelector('.modal-overlay');
      return out;
    }
    """)
    problems = []
    if not result["commandButtonPresent"]:
        problems.append("Insert Smart Stream command button not found in the Commands panel")
    if "BusinessFunction" not in result["startOptions"] or "BusinessProcess" not in result["startOptions"]:
        problems.append(f"Starting Element options should include types present in the model, got {result['startOptions']}")
    if not result["modalBoxIsWide"]:
        problems.append("Insert Smart Stream dialog should render with the wider modal-box-wide variant, not the default narrow modal width")
    if not result["allCheckedByDefault"] or result["typeValues"] != ["BusinessFunction", "BusinessProcess"]:
        problems.append(f"Element Types to Show should be scoped to exactly the types present in the current model (BusinessFunction, BusinessProcess — not the full 77-type toolbox list) and default to all checked, got allCheckedByDefault={result['allCheckedByDefault']} typeValues={result['typeValues']}")
    if result["startInstanceLabels"] != ["RegrISSD_Fn1", "RegrISSD_Fn2"]:
        problems.append(f"Starting Element Instances should list the actual BusinessFunction parts by label, got {result['startInstanceLabels']}")
    if not result["startInstancesAllCheckedByDefault"]:
        problems.append("Starting Element Instances should default to all checked")
    if result["startInstanceLabelsAfterTypeSwitch"] != ["RegrISSD_Proc1", "RegrISSD_Proc2"]:
        problems.append(f"switching Starting Element to BusinessProcess should re-render the instance list to that type's own parts, got {result['startInstanceLabelsAfterTypeSwitch']}")
    if not result["startSelectAllUncheckedAfterOneInstanceUnchecked"]:
        problems.append("Starting Element Instances' Select All/Exclude All header should uncheck itself once any instance is unchecked")
    if not result["selectAllUncheckedAfterOneRowUnchecked"]:
        problems.append("Select All/Exclude All header should uncheck itself once any row is unchecked")
    if not result["allCheckedAfterSelectAllToggle"]:
        problems.append("toggling Select All back on should re-check every row")
    if result["placedPartCount"] != 2 or result["placedConnCount"] != 1:
        problems.append(f"submitting with Fn2 unchecked should trace only Fn1's own branch (Fn1+Proc1, 1 connector) -- proving the instance checklist actually narrows the seed set, not just the type -- got parts={result['placedPartCount']} conns={result['placedConnCount']}")
    if not result["dialogClosed"]:
        problems.append("dialog should close after submit")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Insert Smart Stream dialog is wired into Commands, scopes Starting/Ending options to types present in the model, its Starting Element Instances checklist re-renders per type and genuinely narrows the seed set, defaults both checklists to all-checked with working Select All/Exclude All toggles, and submits through to insertSmartStream"


def check_insert_smart_stream_derived_connections(page):
    """Regression guard for commands.js's insertSmartStream "derived connection"
    behavior. Reported directly: "show the derived connections; for example if
    business function is shown and then application capability, there is a derived
    connection through business process." When a run of one or more excluded-type
    parts sits between two surviving parts, insertSmartStream creates a genuine new
    Connector linking the surviving endpoints directly (not a view-only decoration --
    a real, persisted Connector, so it reuses the app's existing rendering/export/
    inventory machinery), noting which hidden type(s) it passes through. Covers: (1) a
    single hidden hop (Function -> hidden Process -> Capability) produces one derived
    Function->Capability connector with a note naming Business Process; (2) a run of
    TWO consecutive hidden types collapses into one derived edge naming both, in order;
    (3) no derived edge is created when a real, direct connector already covers the
    same pair; (4) re-running the identical trace is idempotent -- no duplicate derived
    connector, because once created it becomes a normal directly-discoverable edge on
    the next pass; (5) a real connector this command placed (not derived) has an empty
    note, so the note field alone distinguishes the two; (6) direct follow-up, "when
    creating derived connectors, create both 's' and 'c' versions" -- the derived pair
    also gets a genuine 's'-type Connector created in the model (not just the 'c' one
    this 'c'-typed trace actually places on the view), and re-running the same trace
    doesn't duplicate that 's' sibling either."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const mkPart = (type, label) => store.createPart({ type, label, model, streams: [] });
      const mkConn = (from, to, connectorType) => store.createConnector({ from: from.id, to: to.id, connectorType, model, relationship: 'Association' });
      const freshView = (name) => {
        const view = store.addView(name, 'ff');
        const tab = app.createCanvasTab(view);
        app.switchToTab(tab.id);
        return { view, tab };
      };
      const state = (view) => {
        const vms = store.viewMembersForView(view.id);
        const partVms = vms.filter(v => v.objectType === 'part');
        const connVms = vms.filter(v => v.objectType === 'connector');
        const conns = connVms.map(v => {
          const c = store.findConnector(v.objectId);
          return { from: store.findPart(c.from)?.label, to: store.findPart(c.to)?.label, note: c.note };
        });
        return { partCount: partVms.length, connCount: connVms.length, conns };
      };

      const out = {};

      // 1) single hidden hop
      const fn = mkPart('BusinessFunction', 'RegrDC_Fn');
      const proc = mkPart('BusinessProcess', 'RegrDC_Proc');
      const cap = mkPart('ApplicationCapability', 'RegrDC_Cap');
      mkConn(fn, proc, 'c'); mkConn(proc, cap, 'c');
      const showFnCap = ['BusinessFunction', 'ApplicationCapability'];
      let { view: v1, tab: t1 } = freshView('RegrDC_singleHop');
      commands.insertSmartStream(app, t1, { connectorType: 'c', startPartIds: [fn.id], direction: 'downstream', endType: null, levels: null, showTypes: showFnCap });
      out.singleHop = state(v1);
      const streamSiblings = () => store.doc.connectors.filter(c => c.connectorType === 's' && c.from === fn.id && c.to === cap.id && (c.note || '').startsWith('Derived'));
      out.streamSiblingCountAfterFirstRun = streamSiblings().length;
      out.streamSiblingNote = streamSiblings()[0]?.note || null;

      // 2) two consecutive hidden types collapse into one derived edge naming both, in order
      const fn2 = mkPart('BusinessFunction', 'RegrDC_Fn2');
      const proc2 = mkPart('BusinessProcess', 'RegrDC_Proc2');
      const role2 = mkPart('BusinessRole', 'RegrDC_Role2');
      const cap2 = mkPart('ApplicationCapability', 'RegrDC_Cap2');
      mkConn(fn2, proc2, 'c'); mkConn(proc2, role2, 'c'); mkConn(role2, cap2, 'c');
      let { view: v2, tab: t2 } = freshView('RegrDC_twoHiddenHops');
      commands.insertSmartStream(app, t2, { connectorType: 'c', startPartIds: [fn2.id], direction: 'downstream', endType: null, levels: null, showTypes: showFnCap });
      out.twoHiddenHops = state(v2);

      // 3) a real, direct connector already covers the pair -> no derived edge created
      const fn3 = mkPart('BusinessFunction', 'RegrDC_Fn3');
      const proc3 = mkPart('BusinessProcess', 'RegrDC_Proc3');
      const cap3 = mkPart('ApplicationCapability', 'RegrDC_Cap3');
      mkConn(fn3, proc3, 'c'); mkConn(proc3, cap3, 'c'); mkConn(fn3, cap3, 'c');
      let { view: v3, tab: t3 } = freshView('RegrDC_alreadyDirect');
      commands.insertSmartStream(app, t3, { connectorType: 'c', startPartIds: [fn3.id], direction: 'downstream', endType: null, levels: null, showTypes: showFnCap });
      out.alreadyDirect = state(v3);

      // 4) idempotent re-run on the single-hop view -> no duplicate derived connector
      commands.insertSmartStream(app, t1, { connectorType: 'c', startPartIds: [fn.id], direction: 'downstream', endType: null, levels: null, showTypes: showFnCap });
      out.rerun = state(v1);
      out.streamSiblingCountAfterRerun = streamSiblings().length;

      return out;
    }
    """)
    problems = []
    sh = result["singleHop"]
    if sh["partCount"] != 2 or sh["connCount"] != 1 or sh["conns"] != [{"from": "RegrDC_Fn", "to": "RegrDC_Cap", "note": "Derived — implied via Business Process (not shown)"}]:
        problems.append(f"a single hidden Business Process between Function and Capability should produce exactly one derived connector naming it, got {sh}")
    th = result["twoHiddenHops"]
    if th["partCount"] != 2 or th["connCount"] != 1 or th["conns"] != [{"from": "RegrDC_Fn2", "to": "RegrDC_Cap2", "note": "Derived — implied via Business Process, Business Role (not shown)"}]:
        problems.append(f"two consecutive hidden types (Business Process then Business Role) should collapse into ONE derived connector naming both in order, got {th}")
    ad = result["alreadyDirect"]
    if ad["partCount"] != 2 or ad["connCount"] != 1 or ad["conns"] != [{"from": "RegrDC_Fn3", "to": "RegrDC_Cap3", "note": ""}]:
        problems.append(f"when a real direct connector already links the pair, no extra derived connector should be created (and the real one's note must stay empty, distinguishing it from a derived one), got {ad}")
    rr = result["rerun"]
    if rr["partCount"] != 2 or rr["connCount"] != 1:
        problems.append(f"re-running the same trace must not create a duplicate derived connector, got {rr}")
    if result["streamSiblingCountAfterFirstRun"] != 1 or result["streamSiblingNote"] != "Derived — implied via Business Process (not shown)":
        problems.append(f"expected creating a 'c'-typed derived connector to ALSO create a genuine 's'-typed sibling in the model (not placed on this 'c'-scoped view, but real), got streamSiblingCountAfterFirstRun={result['streamSiblingCountAfterFirstRun']} note={result['streamSiblingNote']!r}")
    if result["streamSiblingCountAfterRerun"] != 1:
        problems.append(f"re-running the same trace must not duplicate the 's'-typed derived sibling either, got {result['streamSiblingCountAfterRerun']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "insertSmartStream creates a real, persisted derived Connector (noting which hidden type(s) it collapses) when excluded-type parts sit between two shown parts, collapses arbitrarily long hidden chains into one edge, skips it when a real direct connector already exists, is idempotent on re-run, and also creates a genuine 's'-typed sibling Connector in the model for every derived pair (placing only the trace's own connectorType on the view)"


def check_smart_check_view_derive_connectors(page):
    """Regression guard for Smart Check View's new "Derive hidden connections" checkbox
    (deriveConnectors option, commands.js). Direct follow-up to insertSmartStream's own
    derived-connector concept: "Add creation of derived (same logic) to a new checkbox
    in 'Smart Check View' command" -- here "hidden" means "not placed on this view"
    (no showTypes filter at this scope). Covers: (1) off by default -- a chain through
    an off-view part produces nothing when the checkbox isn't set; (2) checked, it adds
    BOTH a real 'c' Connector and a real 's' Connector directly between the two
    on-view parts, and places BOTH on the view -- unlike insertSmartStream (which is
    scoped to one connectorType by its own dialog and only places the matching one),
    Smart Check View has no such single-type scope, and its other checkboxes (e.g.
    Missing connectors) already add either type without discriminating, so both
    derived connectors belong on the view same as any other missing connector would;
    (3) it's hop-limited by the SAME
    `levels` field the "missing connectors and nodes" checkbox already uses (levels:1
    is one hop too short to reach through the hidden part, levels:2 reaches it); (4)
    ordering: run together with missingConnectorsAndNodes in ONE call, the hidden part
    gets pulled onto the view FIRST, so it's no longer "hidden" and derive finds
    nothing to bridge; (5) idempotent on re-run."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const mkPart = (type, label) => store.createPart({ type, label, model, streams: [] });
      const mkConn = (from, to, connectorType) => store.createConnector({ from: from.id, to: to.id, connectorType, model, relationship: 'Association' });
      const freshView = (name) => {
        const view = store.addView(name, 'ff');
        const tab = app.createCanvasTab(view);
        app.switchToTab(tab.id);
        return { view, tab };
      };
      const placeOnly = (view, ...parts) => {
        for (const p of parts) store.createViewMember({ view: view.id, objectType: 'part', objectId: p.id, x: 40 + Math.random() * 400, y: 40 + Math.random() * 400 });
      };
      const viewConnCount = (view) => store.viewMembersForView(view.id).filter(v => v.objectType === 'connector').length;
      const modelConnCount = (from, to, connectorType) => store.doc.connectors.filter(c => c.connectorType === connectorType && c.from === from.id && c.to === to.id).length;

      const out = {};

      // 1) off by default -- deriveConnectors not set at all
      const fn1 = mkPart('BusinessFunction', 'RegrSCVD_Fn1');
      const proc1 = mkPart('BusinessProcess', 'RegrSCVD_Proc1'); // deliberately left off the view
      const cap1 = mkPart('ApplicationCapability', 'RegrSCVD_Cap1');
      mkConn(fn1, proc1, 'c'); mkConn(proc1, cap1, 'c');
      const { view: v1, tab: t1 } = freshView('RegrSCVD_off');
      placeOnly(v1, fn1, cap1);
      commands.smartCheckView(app, t1, { missingConnectors: false, missingConnectorsAndNodes: false, syncWithInventory: false, deriveConnectors: false });
      out.offByDefault = { viewConnCount: viewConnCount(v1), modelHasC: modelConnCount(fn1, cap1, 'c') > 0, modelHasS: modelConnCount(fn1, cap1, 's') > 0 };

      // 2) checked -- derives, places the 'c' one, and creates a genuine 's' sibling
      const result2 = commands.smartCheckView(app, t1, { missingConnectors: false, missingConnectorsAndNodes: false, syncWithInventory: false, deriveConnectors: true, levels: null });
      out.checked = {
        viewConnCount: viewConnCount(v1), result: { connectorsAdded: result2.connectorsAdded, derivedConnectorsAdded: result2.derivedConnectorsAdded },
        modelCCount: modelConnCount(fn1, cap1, 'c'), modelSCount: modelConnCount(fn1, cap1, 's'),
        cNote: store.doc.connectors.find(c => c.connectorType === 'c' && c.from === fn1.id && c.to === cap1.id)?.note,
      };

      // 3) hop-limited by `levels` -- fresh pair, one hidden hop away needs levels >= 2
      const fn3 = mkPart('BusinessFunction', 'RegrSCVD_Fn3');
      const proc3 = mkPart('BusinessProcess', 'RegrSCVD_Proc3');
      const cap3 = mkPart('ApplicationCapability', 'RegrSCVD_Cap3');
      mkConn(fn3, proc3, 'c'); mkConn(proc3, cap3, 'c');
      const { view: v3, tab: t3 } = freshView('RegrSCVD_levels');
      placeOnly(v3, fn3, cap3);
      commands.smartCheckView(app, t3, { missingConnectors: false, missingConnectorsAndNodes: false, syncWithInventory: false, deriveConnectors: true, levels: 1 });
      out.levelsTooShort = { viewConnCount: viewConnCount(v3) };
      commands.smartCheckView(app, t3, { missingConnectors: false, missingConnectorsAndNodes: false, syncWithInventory: false, deriveConnectors: true, levels: 2 });
      out.levelsEnough = { viewConnCount: viewConnCount(v3) };

      // 4) ordering: missingConnectorsAndNodes pulls the hidden part in FIRST (same call),
      // so derive finds nothing left to bridge
      const fn4 = mkPart('BusinessFunction', 'RegrSCVD_Fn4');
      const proc4 = mkPart('BusinessProcess', 'RegrSCVD_Proc4');
      const cap4 = mkPart('ApplicationCapability', 'RegrSCVD_Cap4');
      mkConn(fn4, proc4, 'c'); mkConn(proc4, cap4, 'c');
      const { view: v4, tab: t4 } = freshView('RegrSCVD_ordering');
      placeOnly(v4, fn4, cap4);
      const result4 = commands.smartCheckView(app, t4, { missingConnectors: true, missingConnectorsAndNodes: true, levels: null, syncWithInventory: false, deriveConnectors: true });
      out.ordering = { derivedConnectorsAdded: result4.derivedConnectorsAdded, modelHasDirectDerived: modelConnCount(fn4, cap4, 'c') > 0 };

      // 5) idempotent re-run
      commands.smartCheckView(app, t1, { missingConnectors: false, missingConnectorsAndNodes: false, syncWithInventory: false, deriveConnectors: true, levels: null });
      out.rerun = { modelCCount: modelConnCount(fn1, cap1, 'c'), modelSCount: modelConnCount(fn1, cap1, 's') };

      return out;
    }
    """)
    problems = []
    off = result["offByDefault"]
    if off["viewConnCount"] != 0 or off["modelHasC"] or off["modelHasS"]:
        problems.append(f"expected NO derived connector (either type, anywhere) when deriveConnectors is false, got {off}")
    ck = result["checked"]
    if ck["viewConnCount"] != 2 or ck["modelCCount"] != 1 or ck["modelSCount"] != 1:
        problems.append(f"expected deriveConnectors:true to place BOTH the 'c' and 's' connector on the view (Smart Check View has no single-connectorType scope) and create exactly one of each in the model, got {ck}")
    if ck["cNote"] != "Derived — implied via Business Process (not shown)":
        problems.append(f"expected the derived connector's note to name the hidden Business Process, got {ck['cNote']!r}")
    if ck["result"]["derivedConnectorsAdded"] != 2 or ck["result"]["connectorsAdded"] != 2:
        problems.append(f"expected smartCheckView's own return value to report derivedConnectorsAdded:2 (one 'c', one 's', rolled into connectorsAdded:2), got {ck['result']}")
    if result["levelsTooShort"]["viewConnCount"] != 0:
        problems.append(f"levels:1 is one hop too short to reach through the single hidden Business Process -- expected no derived connector yet, got {result['levelsTooShort']}")
    if result["levelsEnough"]["viewConnCount"] != 2:
        problems.append(f"levels:2 should be enough to bridge through the single hidden Business Process (both 'c' and 's'), got {result['levelsEnough']}")
    ordering = result["ordering"]
    if ordering["derivedConnectorsAdded"] != 0 or ordering["modelHasDirectDerived"]:
        problems.append(f"expected missingConnectorsAndNodes (same call) to pull the hidden part onto the view FIRST, leaving nothing for deriveConnectors to bridge, got {ordering}")
    if result["rerun"]["modelCCount"] != 1 or result["rerun"]["modelSCount"] != 1:
        problems.append(f"re-running deriveConnectors on an unchanged view must not duplicate either sibling, got {result['rerun']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Smart Check View's 'Derive hidden connections' checkbox is off by default, bridges two on-view parts linked only through an off-view chain by creating and placing both a 'c' and 's' Connector, respects the shared Levels hop limit, correctly runs after missingConnectorsAndNodes so a newly-pulled-in part is no longer treated as hidden, and is idempotent on re-run"


def check_derived_connector_isDerived_flag_and_include_option(page):
    """Regression guard/new-feature check, reported directly: "when deriving
    connectors, add flag in connectors that it is derived, in addition to the existing
    note addition. In smart check view, add a checkbox (default disabled) for include/
    exclude existing derived connectors for the options so that connectors derived for
    other views are not automatically added to the current view unless user enables
    it." Covers: (1) createDerivedConnectorPairs (commands.js, shared by Smart Check
    View's "Derive hidden connections" and insertSmartStream's own derived-connector
    creation) now sets isDerived:true on every connector it creates, alongside the
    existing note text; (2) a genuinely ORDINARY connector (created directly, not
    derived) never gets isDerived set; (3) Smart Check View's new
    includeDerivedConnectors option (default false) — a derived connector already
    sitting in the model inventory from a run against a DIFFERENT view is NOT silently
    pulled onto a second view via the plain "Missing connectors" pass just because both
    its endpoints happen to be present there too; (4) includeDerivedConnectors:true
    pulls it in, same as any other missing connector; (5) the SAME gating applies to
    the missingConnectorsAndNodes hop-based pull-in phase, not just the plain
    missingConnectors pass; (6) an ordinary (non-derived) connector between two present
    parts is still pulled in regardless of includeDerivedConnectors — only derived ones
    are ever gated by it."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const mk = (type, label) => store.createPart({ type, label, model, streams: [] });
      const freshView = (name) => {
        const view = store.addView(name + '_' + Date.now(), 'ff');
        const tab = app.createCanvasTab(view);
        app.switchToTab(tab.id);
        return { view, tab };
      };
      const place = (view, parts) => { for (const p of parts) store.createViewMember({ view: view.id, objectType: 'part', objectId: p.id, x: 0, y: 0 }); };
      const out = {};

      // 1+2) isDerived flag: set true on a derived connector, absent/false on an ordinary one.
      const a = mk('BusinessFunction', 'FlagA'), hidden = mk('BusinessProcess', 'FlagHidden'), b = mk('ApplicationCapability', 'FlagB');
      store.createConnector({ from: a.id, to: hidden.id, connectorType: 'c', model, relationship: 'Association' });
      store.createConnector({ from: hidden.id, to: b.id, connectorType: 'c', model, relationship: 'Association' });
      const { view: v1, tab: t1 } = freshView('RegrIsDerivedFlag');
      place(v1, [a, b]);
      commands.smartCheckView(app, t1, { missingConnectors: false, deriveConnectors: true, levels: null });
      const derivedConn = store.doc.connectors.find(c => c.from === a.id && c.to === b.id && c.connectorType === 'c');
      out.derivedHasFlag = derivedConn ? derivedConn.isDerived === true : null;

      const x = mk('BusinessActor', 'OrdX'), y = mk('GeneralActor', 'OrdY');
      const ordinaryConn = store.createConnector({ from: x.id, to: y.id, connectorType: 'c', model, relationship: 'Association' });
      out.ordinaryHasNoFlag = !ordinaryConn.isDerived;

      // 3+4) include/exclude an EXISTING derived connector when pulling into a DIFFERENT view.
      const { view: v2, tab: t2 } = freshView('RegrExcludeByDefault');
      place(v2, [a, b]);
      const r2 = commands.smartCheckView(app, t2, { missingConnectors: true, includeDerivedConnectors: false });
      out.excludedByDefault = { added: r2.connectorsAdded, placed: store.viewMembersForView(v2.id).some(vm => vm.objectType === 'connector' && vm.objectId === derivedConn.id) };

      const { view: v3, tab: t3 } = freshView('RegrIncludeWhenEnabled');
      place(v3, [a, b]);
      const r3 = commands.smartCheckView(app, t3, { missingConnectors: true, includeDerivedConnectors: true });
      out.includedWhenEnabled = { added: r3.connectorsAdded, placed: store.viewMembersForView(v3.id).some(vm => vm.objectType === 'connector' && vm.objectId === derivedConn.id) };

      // 5) same gating applies to the missingConnectorsAndNodes hop-based phase-2 pull-in.
      const anchor = mk('BusinessFunction', 'HopAnchor');
      store.createConnector({ from: anchor.id, to: a.id, connectorType: 'c', model, relationship: 'Association' });
      const { view: v4, tab: t4 } = freshView('RegrHopExcludeByDefault');
      place(v4, [anchor]);
      const r4 = commands.smartCheckView(app, t4, { missingConnectors: false, missingConnectorsAndNodes: true, levels: 3, includeDerivedConnectors: false });
      // anchor->a pulls a's node in via hop 1 (ordinary connector); a<->b's derived
      // connector should then be excluded by default even though both are now on-view.
      out.hopExcludedByDefault = !store.viewMembersForView(v4.id).some(vm => vm.objectType === 'connector' && vm.objectId === derivedConn.id);

      // 6) an ordinary connector is still pulled in regardless of includeDerivedConnectors.
      const { view: v5, tab: t5 } = freshView('RegrOrdinaryStillPulledIn');
      place(v5, [x, y]);
      const r5 = commands.smartCheckView(app, t5, { missingConnectors: true, includeDerivedConnectors: false });
      out.ordinaryStillPulledIn = r5.connectorsAdded === 1;

      return out;
    }
    """)
    problems = []
    if not result["derivedHasFlag"]:
        problems.append("expected a connector created by 'Derive hidden connections' to have isDerived:true")
    if not result["ordinaryHasNoFlag"]:
        problems.append("expected a genuinely ordinary connector to NOT have isDerived set")
    if result["excludedByDefault"]["added"] != 0 or result["excludedByDefault"]["placed"]:
        problems.append(f"expected includeDerivedConnectors:false (the default) to skip pulling an existing derived connector into a different view, got {result['excludedByDefault']}")
    if result["includedWhenEnabled"]["added"] == 0 or not result["includedWhenEnabled"]["placed"]:
        problems.append(f"expected includeDerivedConnectors:true to pull the existing derived connector in like any other missing connector, got {result['includedWhenEnabled']}")
    if not result["hopExcludedByDefault"]:
        problems.append("expected the missingConnectorsAndNodes hop-based pull-in to ALSO respect includeDerivedConnectors:false, not just the plain missingConnectors pass")
    if not result["ordinaryStillPulledIn"]:
        problems.append("expected an ordinary (non-derived) connector to still be pulled in even with includeDerivedConnectors:false")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "createDerivedConnectorPairs now flags every connector it creates with isDerived:true (leaving ordinary connectors untouched), and Smart Check View's new includeDerivedConnectors option (default false) keeps an existing derived connector from silently spreading onto other views via either missing-connector pull-in pass, while never affecting ordinary connectors"


def check_smart_check_view_dialog_include_derived_checkbox_wiring(page):
    """Regression guard for the real Smart Check View DIALOG's new "Include existing
    derived connectors" checkbox (#scv-include-derived, main.js) -- confirms it's wired
    end to end through the actual UI, not just the underlying commands.js option
    (covered separately by check_derived_connector_isDerived_flag_and_include_option).
    Checks: (1) unchecked by default; (2) its row is visible whenever either "Missing
    connectors" or "Missing connectors and nodes" is checked, and hidden when neither
    is; (3) submitting with it left unchecked genuinely excludes an existing derived
    connector via the real Check button, not just via a direct function call; (4)
    checking it and submitting again genuinely includes it."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const a = store.createPart({ type: 'BusinessFunction', label: 'RegrInclDlg_A', model, streams: [] });
      const hidden = store.createPart({ type: 'BusinessProcess', label: 'RegrInclDlg_Hidden', model, streams: [] });
      const b = store.createPart({ type: 'ApplicationCapability', label: 'RegrInclDlg_B', model, streams: [] });
      store.createConnector({ from: a.id, to: hidden.id, connectorType: 'c', model, relationship: 'Association' });
      store.createConnector({ from: hidden.id, to: b.id, connectorType: 'c', model, relationship: 'Association' });

      // Derive the A->B connector via a throwaway view first, so it already exists in
      // the model inventory (marked isDerived) before the dialog test even starts.
      const seedView = store.addView('RegrInclDlg_seed', 'ff');
      const seedTab = app.createCanvasTab(seedView);
      app.switchToTab(seedTab.id);
      store.createViewMember({ view: seedView.id, objectType: 'part', objectId: a.id, x: 0, y: 0 });
      store.createViewMember({ view: seedView.id, objectType: 'part', objectId: b.id, x: 0, y: 0 });
      commands.smartCheckView(app, seedTab, { missingConnectors: false, deriveConnectors: true, levels: null });
      const derivedConn = store.doc.connectors.find(c => c.from === a.id && c.to === b.id && c.connectorType === 'c');

      const view = store.addView('RegrInclDlg_view', 'ff');
      store.createViewMember({ view: view.id, objectType: 'part', objectId: a.id, x: 40, y: 40 });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: b.id, x: 300, y: 40 });
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);

      const out = {};
      app.promptSmartCheckView();
      await new Promise(r => setTimeout(r, 30));
      const inclCb = document.getElementById('scv-include-derived');
      const inclRow = document.getElementById('scv-include-derived-row');
      out.uncheckedByDefault = inclCb.checked;
      out.rowVisibleWithMissingConnectorsChecked = !inclRow.classList.contains('hidden');

      document.getElementById('scv-missing-connectors').checked = false;
      document.getElementById('scv-missing-connectors').dispatchEvent(new Event('change', { bubbles: true }));
      out.rowHiddenWhenNeitherChecked = inclRow.classList.contains('hidden');
      document.getElementById('scv-missing-connectors').checked = true;
      document.getElementById('scv-missing-connectors').dispatchEvent(new Event('change', { bubbles: true }));

      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 60));
      out.excludedViaRealButton = !store.viewMembersForView(view.id).some(vm => vm.objectType === 'connector' && vm.objectId === derivedConn.id);

      app.promptSmartCheckView();
      await new Promise(r => setTimeout(r, 30));
      document.getElementById('scv-include-derived').checked = true;
      document.querySelector('.modal-overlay .submit').click();
      await new Promise(r => setTimeout(r, 60));
      out.includedViaRealButton = store.viewMembersForView(view.id).some(vm => vm.objectType === 'connector' && vm.objectId === derivedConn.id);

      return out;
    }
    """)
    problems = []
    if result["uncheckedByDefault"]:
        problems.append("expected #scv-include-derived unchecked by default")
    if not result["rowVisibleWithMissingConnectorsChecked"]:
        problems.append("expected the Include Derived row visible while Missing connectors is checked")
    if not result["rowHiddenWhenNeitherChecked"]:
        problems.append("expected the Include Derived row hidden when neither Missing connectors nor Missing connectors and nodes is checked")
    if not result["excludedViaRealButton"]:
        problems.append("expected the real Check button, with Include existing derived connectors left unchecked, to exclude the existing derived connector")
    if not result["includedViaRealButton"]:
        problems.append("expected checking Include existing derived connectors and submitting again to genuinely include the derived connector")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "The Smart Check View dialog's new 'Include existing derived connectors' checkbox is unchecked by default, its row visibility tracks the Missing Connectors checkboxes, and it genuinely gates whether an existing derived connector gets pulled in through the real Check button"


def check_derived_connector_relationship_fallback(page):
    """Regression guard, direct follow-up: "when a derived connector is created, if a
    default relationship or valid relationship is not available, use 'o' Association
    not the current 's' Stream for relationship for connectors of type 'c'."
    createDerivedConnectorPairs (commands.js) always creates BOTH a 'c' and an 's'
    version of a derived pair, reusing whichever relationship the discovery walk
    traced -- but a chain discovered by walking 's' (Stream) edges traces back the
    literal word "Stream" (the same relationship every real 's' connector gets --
    findOrCreateStreamConnector), which is nonsensical as a 'c' connector's
    relationship. Uses Smart Check View's "Derive hidden connections" checkbox (an
    's'-typed hidden chain) to force that scenario directly. Covers: (1) the type
    pair HAS a genuine data-defined default relation (BusinessFunction->BusinessProcess:
    default key 'r', Realization) -- the 'c' version should get that pair-specific
    default, not the generic 'Association' fallback; (2) the type pair has NO rule at
    all (BusinessFunction->ApplicationCapability) -- the 'c' version falls all the way
    back to 'Association'; (3) in both cases the 's' version keeps the traced "Stream"
    relationship unchanged (this fallback is 'c'-only, per the report); (4) a 'c'-typed
    hidden chain whose OWN first-hop relationship ("Association") IS already valid for
    the resulting pair is kept as-is, NOT overridden to that pair's own different
    default ("Realization") -- proving a genuinely valid traced relationship always
    wins over the pair's own default, not just over the plain 'Association' fallback."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;
      const mkPart = (type, label) => store.createPart({ type, label, model, streams: [] });
      const mkConn = (from, to, connectorType, relationship) => store.createConnector({ from: from.id, to: to.id, connectorType, model, relationship });
      const freshView = (name) => {
        const view = store.addView(name, 'ff');
        const tab = app.createCanvasTab(view);
        app.switchToTab(tab.id);
        return { view, tab };
      };
      const placeOnly = (view, ...parts) => {
        for (const p of parts) store.createViewMember({ view: view.id, objectType: 'part', objectId: p.id, x: 40 + Math.random() * 400, y: 40 + Math.random() * 400 });
      };
      const relOf = (from, to, connectorType) => store.doc.connectors.find(c => c.connectorType === connectorType && c.from === from.id && c.to === to.id)?.relationship;

      const out = {};

      // 1) type pair HAS its own default (BusinessFunction->BusinessProcess: default 'r' Realization)
      const fn1 = mkPart('BusinessFunction', 'RegrRelFn1');
      const hidden1 = mkPart('ApplicationCapability', 'RegrRelHidden1'); // left off the view
      const proc1 = mkPart('BusinessProcess', 'RegrRelProc1');
      mkConn(fn1, hidden1, 's', 'Stream'); mkConn(hidden1, proc1, 's', 'Stream');
      const { view: v1 } = freshView('RegrRel_hasDefault');
      placeOnly(v1, fn1, proc1);
      commands.smartCheckView(app, { viewId: v1.id }, { missingConnectors: false, missingConnectorsAndNodes: false, syncWithInventory: false, deriveConnectors: true, levels: null });
      out.hasDefault = { c: relOf(fn1, proc1, 'c'), s: relOf(fn1, proc1, 's') };

      // 2) type pair has NO rule at all (BusinessFunction->ApplicationCapability)
      const fn2 = mkPart('BusinessFunction', 'RegrRelFn2');
      const hidden2 = mkPart('BusinessProcess', 'RegrRelHidden2'); // left off the view
      const cap2 = mkPart('ApplicationCapability', 'RegrRelCap2');
      mkConn(fn2, hidden2, 's', 'Stream'); mkConn(hidden2, cap2, 's', 'Stream');
      const { view: v2 } = freshView('RegrRel_noRule');
      placeOnly(v2, fn2, cap2);
      commands.smartCheckView(app, { viewId: v2.id }, { missingConnectors: false, missingConnectorsAndNodes: false, syncWithInventory: false, deriveConnectors: true, levels: null });
      out.noRule = { c: relOf(fn2, cap2, 'c'), s: relOf(fn2, cap2, 's') };

      // 3) a 'c'-typed hidden chain whose own traced relationship IS valid -- kept as-is,
      // not overridden to the pair's own (different) default
      const fn3 = mkPart('BusinessFunction', 'RegrRelFn3');
      const hidden3 = mkPart('ApplicationCapability', 'RegrRelHidden3'); // left off the view
      const proc3 = mkPart('BusinessProcess', 'RegrRelProc3');
      mkConn(fn3, hidden3, 'c', 'Association'); mkConn(hidden3, proc3, 'c', 'Association');
      const { view: v3 } = freshView('RegrRel_tracedValid');
      placeOnly(v3, fn3, proc3);
      commands.smartCheckView(app, { viewId: v3.id }, { missingConnectors: false, missingConnectorsAndNodes: false, syncWithInventory: false, deriveConnectors: true, levels: null });
      out.tracedValid = { c: relOf(fn3, proc3, 'c') };

      return out;
    }
    """)
    problems = []
    hd = result["hasDefault"]
    if hd["c"] != "Realization":
        problems.append(f"expected the 'c' version, for a pair with its own data-defined default (BusinessFunction->BusinessProcess: 'r' Realization), to use THAT default instead of the traced 'Stream' or the generic 'Association', got {hd['c']!r}")
    if hd["s"] != "Stream":
        problems.append(f"expected the 's' version to keep the traced 'Stream' relationship unchanged (this fallback is 'c'-only), got {hd['s']!r}")
    nr = result["noRule"]
    if nr["c"] != "Association":
        problems.append(f"expected the 'c' version, for a pair with NO rule/default at all (BusinessFunction->ApplicationCapability), to fall all the way back to 'Association', got {nr['c']!r}")
    if nr["s"] != "Stream":
        problems.append(f"expected the 's' version to keep the traced 'Stream' relationship unchanged, got {nr['s']!r}")
    if result["tracedValid"]["c"] != "Association":
        problems.append(f"expected a 'c'-typed hidden chain's own traced relationship ('Association', already valid for this exact pair) to be kept as-is rather than overridden to the pair's own different default ('Realization'), got {result['tracedValid']['c']!r}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "A derived 'c' connector's relationship falls back correctly when the traced value (e.g. the literal 'Stream' from an 's'-typed hidden chain) isn't valid for the resulting pair: the pair's own data-defined default when one exists, else 'Association' -- while a genuinely valid traced relationship (from a 'c'-typed hidden chain) is always kept as-is, and the 's' version is never affected by any of this"


def check_smart_check_model_detection_and_fix_precedence(page):
    """Regression guard, direct follow-up: "in Advanced menu before Smart Check View add
    a new item 'Smart Check Model' for a new smart check model command. This command
    opens a dialog confirming what the user wants to check, begin with two items
    'disconnected parts' for parts with no connectors of any type, 'disconnected
    connectors' for connectors that have one or both parts invalid (missing), and
    'duplicate parts' for parts that have same type, model, and label, and present list
    to user to confirm individually which to fix / merge or leave as is." Exercises
    commands.js's smartCheckModel (pure detection) and applySmartCheckModelFixes
    directly (bypassing the dialog -- check_smart_check_model_dialog, below, covers the
    UI itself), against a small hand-built graph: a normal connected pair (must never be
    flagged by anything); an orphan part with zero connectors (disconnected part); a
    connector whose `to` doesn't resolve to any real part (disconnected connector); and
    a 3-way duplicate group (same type+model+label) where the keep part (the FIRST one
    created) and one of its two copies are BOTH also zero-connector parts in their own
    right -- deliberately constructed to hit a real bug caught while building this
    feature: with all three checkboxes on, a duplicate-group part that's also
    "disconnected" gets confirmed in BOTH the delete-disconnected-parts list AND the
    merge-this-group list at once (both computed from the same pre-fix snapshot), and
    applying the delete first (or in any order that doesn't account for this) either
    silently no-ops the merge entirely (mergeDuplicateParts bails once its own keep part
    is already gone) or drops a copy's connectors/streams on the floor instead of
    carrying them into the survivor. applySmartCheckModelFixes' fix -- merge always wins
    for any part id that appears in fixes.mergeGroups, excluded from deletePartIds
    processing regardless of order -- is proven directly against a TEMP BREAK removing
    that exclusion (confirmed to reproduce exactly this failure, then reverted). Also
    covers: the third (non-keep, non-disconnected) duplicate copy, which HAS a
    connector to the connected pair's own second part, ends up correctly rewired onto
    the surviving keep part after merge; the keep part and that third copy, placed
    together on the SAME view, correctly end up as exactly one viewMember there
    afterward (not zero, not two); and toggling a category checkbox off makes
    smartCheckModel return an empty array for exactly that category, nothing else."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const commands = await import('./js/commands.js');
      const model = store.defaultModel;

      const view = store.addView('SCM_Detect_' + Date.now(), 'ff');
      const partA = store.createPart({ type: 'Unknown', label: 'SCM Connected A', model, streams: [] });
      const partB = store.createPart({ type: 'Unknown', label: 'SCM Connected B', model, streams: [] });
      store.createConnector({ from: partA.id, to: partB.id, model, connectorType: 'c', relationship: 'Association', streams: [] });

      const orphan = store.createPart({ type: 'Unknown', label: 'SCM Orphan', model, streams: [] });
      const badConn = store.createConnector({ from: partA.id, to: 'no-such-part-id', model, connectorType: 'c', relationship: 'Association', streams: [] });

      const dupKeep = store.createPart({ type: 'GeneralActor', label: 'SCM Dup Actor', model, streams: [] });
      const dupNoConn = store.createPart({ type: 'GeneralActor', label: 'SCM Dup Actor', model, streams: [] });
      const dupConnected = store.createPart({ type: 'GeneralActor', label: 'SCM Dup Actor', model, streams: [] });
      store.createConnector({ from: dupConnected.id, to: partB.id, model, connectorType: 'c', relationship: 'Association', streams: [] });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: dupKeep.id, x: 10, y: 10 });
      store.createViewMember({ view: view.id, objectType: 'part', objectId: dupConnected.id, x: 200, y: 10 });

      // Category toggle: only duplicateParts on -- the other two arrays must be empty.
      const onlyDup = commands.smartCheckModel(store, { disconnectedParts: false, disconnectedConnectors: false, duplicateParts: true });

      const full = commands.smartCheckModel(store, { disconnectedParts: true, disconnectedConnectors: true, duplicateParts: true });
      const group = full.duplicateGroups.find(g => g.keepId === dupKeep.id);

      const summary = commands.applySmartCheckModelFixes(app, {
        deletePartIds: full.disconnectedParts.map(p => p.id),
        deleteConnectorIds: full.disconnectedConnectors.map(c => c.id),
        mergeGroups: full.duplicateGroups.map(g => ({ keepId: g.keepId, duplicateIds: g.duplicateIds })),
      });

      return {
        onlyDupOtherCategoriesEmpty: onlyDup.disconnectedParts.length === 0 && onlyDup.disconnectedConnectors.length === 0,
        onlyDupHasGroup: onlyDup.duplicateGroups.some(g => g.keepId === dupKeep.id),
        foundOrphan: full.disconnectedParts.some(p => p.id === orphan.id),
        foundBadConn: full.disconnectedConnectors.some(c => c.id === badConn.id),
        foundGroup: !!group,
        groupCount: group ? group.count : null,
        summary,
        orphanGone: !store.findPart(orphan.id),
        badConnGone: !store.findConnector(badConn.id),
        dupKeepSurvives: !!store.findPart(dupKeep.id),
        dupNoConnGone: !store.findPart(dupNoConn.id),
        dupConnectedGone: !store.findPart(dupConnected.id),
        rewiredOntoKeep: store.doc.connectors.some(c => c.from === dupKeep.id && c.to === partB.id),
        viewMemberCountForView: store.viewMembersForView(view.id).filter(vm => vm.objectType === 'part').length,
        partAUntouched: !!store.findPart(partA.id),
        partBUntouched: !!store.findPart(partB.id),
        connectedPairUntouched: store.doc.connectors.some(c => c.from === partA.id && c.to === partB.id),
      };
    }
    """)
    problems = []
    if not result["onlyDupOtherCategoriesEmpty"]:
        problems.append("expected disconnectedParts/disconnectedConnectors to come back empty when only duplicateParts is requested")
    if not result["onlyDupHasGroup"]:
        problems.append("expected the duplicate group to still be found when duplicateParts is the only category requested")
    if not result["foundOrphan"]:
        problems.append("expected the zero-connector 'SCM Orphan' part to be flagged as a disconnected part")
    if not result["foundBadConn"]:
        problems.append("expected the connector with an invalid 'to' part id to be flagged as a disconnected connector")
    if not result["foundGroup"] or result["groupCount"] != 3:
        problems.append(f"expected a 3-member duplicate group for 'SCM Dup Actor', got group={result['foundGroup']} count={result['groupCount']}")
    if not result["orphanGone"]:
        problems.append("expected the disconnected part to be deleted")
    if not result["badConnGone"]:
        problems.append("expected the disconnected connector to be deleted")
    if not result["dupKeepSurvives"]:
        problems.append("expected the duplicate group's keep part (first-created) to survive the merge, even though it was ALSO confirmed as a disconnected part -- merge must take precedence over an independent delete for the same part id")
    if not result["dupNoConnGone"] or not result["dupConnectedGone"]:
        problems.append(f"expected both non-keep duplicate copies to be gone after merge, got dupNoConnGone={result['dupNoConnGone']} dupConnectedGone={result['dupConnectedGone']}")
    if not result["rewiredOntoKeep"]:
        problems.append("expected the connector from the connected duplicate copy to be rewired onto the surviving keep part after merge")
    if result["viewMemberCountForView"] != 1:
        problems.append(f"expected exactly one part viewMember left on the shared view after merging two duplicates that were both placed there, got {result['viewMemberCountForView']}")
    if not result["partAUntouched"] or not result["partBUntouched"] or not result["connectedPairUntouched"]:
        problems.append("expected the normal connected pair (and its connector) to be completely untouched by any of this")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "smartCheckModel correctly detects disconnected parts, disconnected connectors, and duplicate-part groups (respecting each category's own on/off toggle), and applySmartCheckModelFixes correctly gives a duplicate-group merge precedence over an independent disconnected-part deletion for the same part id -- proven against a real bug caught while building this feature, not just designed around it"


def check_smart_check_model_dialog(page):
    """Regression guard, direct follow-up (same report as
    check_smart_check_model_detection_and_fix_precedence, above): covers the actual
    Advanced menu item and its dialog UI, which that check bypasses entirely. Covers:
    (1) 'Smart Check Model' appears in the Advanced menu ABOVE 'Smart Check View', per
    the report's own "in Advanced menu before Smart Check View add a new item"; (2) the
    dialog opens with NO open canvas tab at all (it's whole-model, not view-scoped, same
    as Auto-Detect Connectors) and its Check button populates a real results table;
    (3) unchecking one specific row before clicking "Fix Selected" leaves exactly that
    one issue alone while still applying every other checked row -- the "confirm
    individually which to fix ... or leave as is" part of the report, not just an
    all-or-nothing bulk apply; (4) Cancel (after Check has already populated results)
    makes zero changes to the model."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const model = store.defaultModel;

      const advancedMenuLabels = [...document.querySelectorAll('#advanced-menu .dd-item')].map(el => el.textContent.trim());

      const keepPart = store.createPart({ type: 'Unknown', label: 'SCMDialogOrphanKeep', model, streams: [] });
      const deletePart = store.createPart({ type: 'Unknown', label: 'SCMDialogOrphanDelete', model, streams: [] });

      app.promptSmartCheckModel();
      await new Promise(r => setTimeout(r, 60));
      const dialogOpenedWithNoTab = !!document.querySelector('.modal-box #scm-check');

      const box = document.querySelector('.modal-box');
      box.querySelector('#scm-check').click();
      await new Promise(r => setTimeout(r, 60));

      // Uncheck the row for "SCMDialogOrphanKeep" specifically, leaving every other
      // checked row (including SCMDialogOrphanDelete) as-is.
      const rows = [...box.querySelectorAll('.scm-row-check[data-section="parts"]')];
      const keepRowCb = rows.find(cb => cb.closest('tr').textContent.includes('SCMDialogOrphanKeep'));
      keepRowCb.checked = false;
      keepRowCb.dispatchEvent(new Event('change', { bubbles: true }));

      box.querySelector('#scm-fix').click();
      await new Promise(r => setTimeout(r, 60));

      const toasts = [...document.querySelectorAll('.toast')];
      const lastToast = toasts.length ? toasts[toasts.length - 1].textContent : null;

      // Second run, to check Cancel makes no changes.
      const partBeforeCancel = store.createPart({ type: 'Unknown', label: 'SCMDialogCancelProbe', model, streams: [] });
      app.promptSmartCheckModel();
      await new Promise(r => setTimeout(r, 60));
      const box2 = document.querySelector('.modal-box');
      box2.querySelector('#scm-check').click();
      await new Promise(r => setTimeout(r, 60));
      box2.querySelector('.cancel').click();
      await new Promise(r => setTimeout(r, 60));

      return {
        advancedMenuLabels,
        dialogOpenedWithNoTab,
        keepPartStillExists: !!store.findPart(keepPart.id),
        deletePartGone: !store.findPart(deletePart.id),
        lastToast,
        cancelLeftDialogClosed: !document.querySelector('.modal-overlay'),
        cancelProbeStillExists: !!store.findPart(partBeforeCancel.id),
      };
    }
    """)
    problems = []
    labels = result["advancedMenuLabels"]
    if 'Smart Check Model' not in labels or 'Smart Check View' not in labels:
        problems.append(f"expected both 'Smart Check Model' and 'Smart Check View' in the Advanced menu, got {labels}")
    elif labels.index('Smart Check Model') >= labels.index('Smart Check View'):
        problems.append(f"expected 'Smart Check Model' to appear BEFORE 'Smart Check View' in the Advanced menu, got order {labels}")
    if not result["dialogOpenedWithNoTab"]:
        problems.append("expected Smart Check Model's dialog to open with no canvas tab required (whole-model, not view-scoped)")
    if not result["keepPartStillExists"]:
        problems.append("expected unchecking a specific disconnected-part row before Fix Selected to leave that exact part alone")
    if not result["deletePartGone"]:
        problems.append("expected every OTHER still-checked disconnected-part row to still be deleted by Fix Selected")
    if not result["lastToast"] or "Smart Check Model" not in result["lastToast"]:
        problems.append(f"expected a summary toast mentioning Smart Check Model's results, got {result['lastToast']!r}")
    if not result["cancelLeftDialogClosed"]:
        problems.append("expected Cancel to close the dialog")
    if not result["cancelProbeStillExists"]:
        problems.append("expected Cancel (even after Check already populated results) to make zero changes to the model")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Smart Check Model appears in the Advanced menu above Smart Check View, its dialog is reachable with no canvas tab open, unchecking a specific row before Fix Selected leaves exactly that issue alone while still applying the rest, and Cancel never touches the model"


def check_load_sfcce(page):
    """Regression guard for File > Load SFCCE — the unified Section/Function/Capability/
    Application Capability/Entity import that replaced separate Load SFCE and Load Capability Map
    features. Uses a small, deliberate 2-level-nested fixture (one domain, one business
    capability, one application capability that itself lists 2 ministries) designed so a
    single row splits into 2, making the Domain shared across both resulting sections —
    only ONE sharing question is asked (Business Capability/Application Capability-level
    sharing were removed entirely — see check_load_sfcce_shared_functions_only), and
    collapsing just the Domain still correctly merges the capability/appcap/entity down
    to 1 each via buildIndustryTree's own key-based dedup, no separate confirm needed.
    Also exercises flattenJsonRecords' full-dot-path field
    naming (both nesting levels have their own "name"/"description" fields, which must
    surface as distinct businessCapabilities.name / businessCapabilities.applicationCapabilities.name
    rather than clobbering each other), the cascade-when-unmapped design (Entity isn't
    mapped here, so it inherits the Application Capability's own name — producing a real
    DataDataEntity part one level deeper, not an absent one), confirms Generate Industry
    produces a real ApplicationCapability-typed part via the 'SFCCE' stream template
    (through store.doc.industryTemplateName, not always 'Enterprise'), confirms the
    "clear and replace" warning appears (the built-in default industry data is already
    loaded at boot, so Load SFCCE always replaces something), and confirms SFCCE's
    passive entries (matching Enterprise's: BusinessFunction->BusinessProcess,
    ApplicationApplication->ApplicationPhysicalComponent) each produce their own part —
    the BusinessFunction side reusing the chain's own node rather than duplicating it."""
    fixture = {
        "type": "array",
        "value": [
            {
                "domain": "Alpha Domain",
                "businessCapabilities": [
                    {
                        "name": "Shared Business Cap",
                        "description": "Biz cap desc",
                        "applicationCapabilities": [
                            {"name": "App Cap One", "description": "Desc one.", "ministries": ["Ministry A", "Ministry B"]},
                        ],
                    },
                ],
            },
        ],
    }
    result = js(page, f"""
    async () => {{
      const app = window.dycadApp, store = app.store;
      const text = {json.dumps(json.dumps(fixture["value"]))};
      const blob = new Blob([text], {{ type: 'application/json' }});
      const file = new File([blob], 'fixture.json', {{ type: 'application/json' }});
      const dt = new DataTransfer();
      dt.items.add(file);

      document.getElementById('file-menu-btn').click();
      await new Promise(r => setTimeout(r, 50));
      [...document.querySelectorAll('#file-menu .dd-item')].find(el => el.dataset.action === 'loadSFCCE')?.click();
      await new Promise(r => setTimeout(r, 50));

      const input = document.getElementById('sfcce-file-input');
      input.files = dt.files;
      document.getElementById('sfcce-preread-btn').click();
      await new Promise(r => setTimeout(r, 100));

      const step2Title = document.querySelector('.modal-box h3')?.textContent || '';
      // Force the correct mapping explicitly rather than trusting auto-suggestion —
      // this check is about the import mechanism, not the suggestion heuristic.
      document.getElementById('sfcce-field-section').value = 'businessCapabilities.applicationCapabilities.ministries';
      document.getElementById('sfcce-field-function').value = 'domain';
      document.getElementById('sfcce-field-capability').value = 'businessCapabilities.name';
      document.getElementById('sfcce-field-capability-desc').value = 'businessCapabilities.description';
      document.getElementById('sfcce-field-application-capability').value = 'businessCapabilities.applicationCapabilities.name';
      document.getElementById('sfcce-field-application-capability-desc').value = 'businessCapabilities.applicationCapabilities.description';
      document.querySelector('.modal-box .submit').click();
      await new Promise(r => setTimeout(r, 80));
      // Only one industry dataset ever exists — the built-in default is already loaded
      // at boot, so this always triggers the "clear and replace" warning first.
      const replaceConfirmBox = [...document.querySelectorAll('.modal-box')].find(b => b.textContent.includes('clear and replace'));
      const replaceConfirmShown = !!replaceConfirmBox;
      replaceConfirmBox?.querySelector('.submit')?.click();
      await new Promise(r => setTimeout(r, 80));

      const step3Title = document.querySelector('.modal-box h3')?.textContent || '';
      document.getElementById('sfcce-shared-yes')?.click(); // Domain: collapse
      await new Promise(r => setTimeout(r, 100));

      const tree = store.doc.industryTree;
      const templateName = store.doc.industryTemplateName;

      const commands = await import('./js/commands.js');
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      store.currentView = homeTab.viewId;
      await commands.generateIndustry(app, null, false);

      const funcParts = store.doc.parts.filter(p => p.type === 'BusinessFunction');
      const capParts = store.doc.parts.filter(p => p.type === 'BusinessCapability');
      const appCapParts = store.doc.parts.filter(p => p.type === 'ApplicationCapability');
      const dataEntityParts = store.doc.parts.filter(p => p.type === 'DataDataEntity');
      const businessProcessParts = store.doc.parts.filter(p => p.type === 'BusinessProcess');
      const appApplicationParts = store.doc.parts.filter(p => p.type === 'ApplicationApplication');
      const appPhysicalComponentParts = store.doc.parts.filter(p => p.type === 'ApplicationPhysicalComponent');

      return {{
        step2Title, step3Title, replaceConfirmShown,
        treeLength: tree?.length,
        templateName,
        funcCount: funcParts.length,
        capCount: capParts.length,
        appCapCount: appCapParts.length,
        appCapLabel: appCapParts[0]?.label,
        appCapDescription: appCapParts[0]?.description,
        dataEntityCount: dataEntityParts.length,
        businessProcessCount: businessProcessParts.length,
        appApplicationCount: appApplicationParts.length,
        appPhysicalComponentCount: appPhysicalComponentParts.length,
      }};
    }}
    """)
    if 'record' not in result['step2Title']:
        return False, f"unexpected step 2 title (preread didn't parse the 2-level-nested fixture correctly): {result}"
    if not result['replaceConfirmShown']:
        return False, f"expected the 'clear and replace' warning since the built-in default industry data is already loaded at boot: {result}"
    if result['step3Title'] != 'Shared Domains found':
        return False, f"expected the Domain-sharing question to appear: {result}"
    if result['templateName'] != 'SFCCE':
        return False, f"expected store.doc.industryTemplateName to register the 'SFCCE' template: {result}"
    # Business Capability/Application Capability-level sharing is no longer its own
    # question (removed per direct request — see check_load_sfcce_shared_functions_only)
    # — collapsing ONLY the Domain level still merges the capability/appcap/entity
    # correctly down to 1 each, since they're now scoped under the SAME single
    # collapsed Function+Section identity (buildIndustryTree's own key-based dedup
    # handles it with no separate confirm step needed).
    if result['funcCount'] != 1 or result['capCount'] != 1 or result['appCapCount'] != 1:
        return False, f"expected exactly 1 part at each of Function/Capability/ApplicationCapability after collapsing only the Domain level: {result}"
    # Entity was left unmapped, so it cascades from the Application Capability's own name
    # (not left absent) — a real DataDataEntity part IS expected here, one level deeper
    # than the ApplicationCapability part, both sharing the same cascaded name/label.
    if result['dataEntityCount'] != 1:
        return False, f"expected exactly 1 DataDataEntity part (cascaded from the Application Capability's own name, since Entity was left unmapped): {result}"
    # SFCCE's template.passive now matches Enterprise's: BusinessFunction->BusinessProcess
    # (reusing the chain's own BusinessFunction node, not duplicating it) and
    # ApplicationApplication->ApplicationPhysicalComponent (both newly created, to map real
    # software applications onto the generated Application Capability).
    if result['businessProcessCount'] != 1 or result['appApplicationCount'] != 1 or result['appPhysicalComponentCount'] != 1:
        return False, f"expected SFCCE's passive entries (BusinessFunction->BusinessProcess, ApplicationApplication->ApplicationPhysicalComponent) to each produce exactly 1 part: {result}"
    if result['appCapLabel'] != 'Manage App Cap One':
        return False, f"unexpected ApplicationCapability part label: {result['appCapLabel']}"
    if result['appCapDescription'] != 'Desc one.':
        return False, f"expected the ApplicationCapability part's description threaded through from the collision-renamed field, got: {result['appCapDescription']}"
    return True, "Load SFCCE's unified wizard resolves Domain-level sharing (the only level asked about) and Generate Industry produces a real ApplicationCapability-typed part via the 'SFCCE' template"


def check_load_sfcce_shared_functions_only(page):
    """Regression guard/new-feature check, reported directly: "remove option for
    combining into 'shared' at business capability or application capability level.
    these will never be combined into shared, only functions are combined." Before
    this, Load SFCCE asked up to THREE separate "combine into Shared?" questions
    (Domain, then Business Capability, then Application Capability). Using a fixture
    engineered to previously trigger all three (one Application Capability whose own
    ministries field splits into 2 sections — the same fixture check_load_sfcce uses),
    covers: after resolving the single Domain-level question, NO further "Shared ...
    found" modal ever appears (not even transiently) — the wizard goes straight to
    finishSFCCEImport; and sfce.js no longer exports detectSharedCapabilities/
    resolveSharedCapabilities/detectSharedApplicationCapabilities/
    resolveSharedApplicationCapabilities at all (removed, not just unused), locking
    in that this was a real deletion, not just a UI path no longer reachable."""
    fixture = {
        "value": [
            {
                "domain": "Alpha Domain",
                "businessCapabilities": [
                    {
                        "name": "Shared Business Cap",
                        "description": "Biz cap desc",
                        "applicationCapabilities": [
                            {"name": "App Cap One", "description": "Desc one.", "ministries": ["Ministry A", "Ministry B"]},
                        ],
                    },
                ],
            },
        ],
    }
    result = js(page, f"""
    async () => {{
      const app = window.dycadApp, store = app.store;
      const sfce = await import('./js/sfce.js');
      const sfceExports = Object.keys(sfce);

      const text = {json.dumps(json.dumps(fixture["value"]))};
      const blob = new Blob([text], {{ type: 'application/json' }});
      const file = new File([blob], 'regr-shared-only-fixture.json', {{ type: 'application/json' }});
      const dt = new DataTransfer();
      dt.items.add(file);

      document.getElementById('file-menu-btn').click();
      await new Promise(r => setTimeout(r, 50));
      [...document.querySelectorAll('#file-menu .dd-item')].find(el => el.dataset.action === 'loadSFCCE')?.click();
      await new Promise(r => setTimeout(r, 50));
      const input = document.getElementById('sfcce-file-input');
      input.files = dt.files;
      document.getElementById('sfcce-preread-btn').click();
      await new Promise(r => setTimeout(r, 100));

      document.getElementById('sfcce-field-section').value = 'businessCapabilities.applicationCapabilities.ministries';
      document.getElementById('sfcce-field-function').value = 'domain';
      document.getElementById('sfcce-field-capability').value = 'businessCapabilities.name';
      document.getElementById('sfcce-field-application-capability').value = 'businessCapabilities.applicationCapabilities.name';
      document.querySelector('.modal-box .submit').click();
      await new Promise(r => setTimeout(r, 80));
      [...document.querySelectorAll('.modal-box')].find(b => b.textContent.includes('clear and replace'))?.querySelector('.submit')?.click();
      await new Promise(r => setTimeout(r, 80));

      const domainTitle = document.querySelector('.modal-box h3')?.textContent || '';
      document.getElementById('sfcce-shared-yes')?.click(); // Domain: collapse (the only question)
      await new Promise(r => setTimeout(r, 100));

      const remainingModalCount = document.querySelectorAll('.modal-overlay').length;
      const remainingModalTitle = document.querySelector('.modal-box h3')?.textContent || null;

      return {{ sfceExports, domainTitle, remainingModalCount, remainingModalTitle, treeLength: store.doc.industryTree?.length }};
    }}
    """)
    problems = []
    for name in ["detectSharedCapabilities", "resolveSharedCapabilities", "detectSharedApplicationCapabilities", "resolveSharedApplicationCapabilities"]:
        if name in result["sfceExports"]:
            problems.append(f"expected sfce.js to no longer export {name} at all")
    if result["domainTitle"] != "Shared Domains found":
        problems.append(f"expected the (only) sharing question to be the Domain one, got {result['domainTitle']!r}")
    if result["remainingModalCount"] != 0:
        problems.append(f"expected NO further modal after resolving the single Domain-sharing question, got {result['remainingModalCount']} still open (title: {result['remainingModalTitle']!r})")
    if not result["treeLength"]:
        problems.append(f"expected the import to complete (finishSFCCEImport reached directly after the one Domain question), got tree length {result['treeLength']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "Load SFCCE only ever asks about Domain-level sharing now; Business Capability/Application Capability-level sharing (and its underlying detect/resolve functions) are gone entirely"


def check_load_sfcce_shared_section_selector(page):
    """Regression guard/new-feature check, reported directly: "update SFCCE load: add
    to dialog something like 'section for shared functions', and default it to
    sectionId cof but provide selector for known sections. Any shared functions should
    go to that section." Before this, a collapsed shared Function (spanning more than
    one Section) always landed on the literal placeholder string "Shared" with no real
    sectionId at all. Covers: the mapping dialog's new #sfcce-shared-section select
    exists, defaults to 'cof' (Centralized Operational Functions), lists only the real
    content Sections (excludes custom.json's 'title' header row, which has
    elementTypes:[] and can't actually hold BusinessFunction content); choosing a
    different known Section and then collapsing a detected shared Function actually
    lands that Function's nodeSection/nodeSectionId on the CHOSEN Section (not the
    literal "Shared" string, and not blank) — verified both via the resulting tree AND
    via the confirm modal's own "Yes, use ..." button text and body copy naming the
    real Section. Business Capability/Application Capability-level sharing (a
    DIFFERENT, independent step in the same wizard) is untouched by this feature —
    still collapses to the plain "Shared" tag, confirmed by the full suite's
    pre-existing check_load_sfcce (which exercises all three levels together) staying
    green."""
    fixture = [
        {"domain": "Domain One", "capabilities": [
            {"name": "Cap A", "description": "desc A", "ministries": ["Sec1"]},
            {"name": "Cap B", "description": "desc B", "ministries": ["Sec2"]},
        ]},
    ]
    result = js(page, f"""
    async () => {{
      const app = window.dycadApp, store = app.store;
      const text = {json.dumps(json.dumps(fixture))};
      const blob = new Blob([text], {{ type: 'application/json' }});
      const file = new File([blob], 'regr-shared-section-fixture.json', {{ type: 'application/json' }});
      const dt = new DataTransfer();
      dt.items.add(file);

      document.getElementById('file-menu-btn').click();
      await new Promise(r => setTimeout(r, 50));
      [...document.querySelectorAll('#file-menu .dd-item')].find(el => el.dataset.action === 'loadSFCCE')?.click();
      await new Promise(r => setTimeout(r, 50));
      const input = document.getElementById('sfcce-file-input');
      input.files = dt.files;
      document.getElementById('sfcce-preread-btn').click();
      await new Promise(r => setTimeout(r, 100));

      const sel = document.getElementById('sfcce-shared-section');
      const selExists = !!sel;
      const defaultValue = sel?.value;
      const optionValues = sel ? [...sel.options].map(o => o.value) : [];
      sel.value = 'ssf';

      document.getElementById('sfcce-field-section').value = 'capabilities.ministries';
      document.getElementById('sfcce-field-function').value = 'domain';
      document.getElementById('sfcce-field-capability').value = 'capabilities.name';
      document.getElementById('sfcce-field-capability-desc').value = 'capabilities.description';
      document.querySelector('.modal-box .submit').click();
      await new Promise(r => setTimeout(r, 80));
      [...document.querySelectorAll('.modal-box')].find(b => b.textContent.includes('clear and replace'))?.querySelector('.submit')?.click();
      await new Promise(r => setTimeout(r, 100));

      const domainBodyText = [...document.querySelectorAll('.modal-box p')].map(p => p.textContent).join(' ');
      const yesBtnText = document.getElementById('sfcce-shared-yes')?.textContent || '';
      document.getElementById('sfcce-shared-yes')?.click();
      await new Promise(r => setTimeout(r, 100));

      const tree = store.doc.industryTree;
      return {{
        selExists, defaultValue, optionValues,
        domainMentionsChosenSection: domainBodyText.includes('Staff Specialist Functions'),
        yesBtnText,
        treeFunctionCount: tree.length,
        funcSection: tree[0]?.nodeSection,
        funcSectionId: tree[0]?.nodeSectionId,
      }};
    }}
    """)
    problems = []
    if not result["selExists"]:
        problems.append("expected a #sfcce-shared-section select in the Load SFCCE mapping dialog")
    if result["defaultValue"] != "cof":
        problems.append(f"expected the selector to default to sectionId 'cof', got {result['defaultValue']!r}")
    if "title" in result["optionValues"]:
        problems.append(f"expected the header-row 'title' section excluded from the selector's options, got {result['optionValues']}")
    if sorted(result["optionValues"]) != sorted(["esf", "mof", "cof", "ssf", "cif", "rsf", "fcf"]):
        problems.append(f"expected exactly the 7 real content Sections as options, got {result['optionValues']}")
    if not result["domainMentionsChosenSection"]:
        problems.append("expected the 'Shared Domains found' modal's own copy to name the chosen Section ('Staff Specialist Functions'), not a generic 'Shared' placeholder")
    if 'Staff Specialist Functions' not in result["yesBtnText"]:
        problems.append(f"expected the confirm button to read 'Yes, use \"Staff Specialist Functions\"', got {result['yesBtnText']!r}")
    if result["treeFunctionCount"] != 1:
        problems.append(f"expected the shared Function to collapse into exactly 1 tree node, got {result['treeFunctionCount']}")
    if result["funcSection"] != "Staff Specialist Functions":
        problems.append(f"expected the collapsed Function's nodeSection to be the CHOSEN Section, not a literal 'Shared' tag, got {result['funcSection']!r}")
    if result["funcSectionId"] != "ssf":
        problems.append(f"expected the collapsed Function's nodeSectionId to be 'ssf' (matching the chosen Section), got {result['funcSectionId']!r}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "the Load SFCCE wizard's new 'Section for shared functions' selector defaults to cof, offers only real content Sections, and a collapsed shared Function actually lands on the chosen Section (both nodeSection and nodeSectionId), not the old literal 'Shared' placeholder"


def check_load_sfcce_id_and_description_mapping(page):
    """Regression guard/new-feature check, reported directly: "Add to Load SFCCE
    mapping, into the appropriate fields: Section Description, Section Id, Function
    Description, Function Id, Capability Id, Application Capability Id, Entity Id."
    Before this, the wizard only supported mapping a Description for Capability/
    Application Capability/Entity (never Section or Function) and NO explicit Id field
    at any level at all — every node's id was always auto-derived by chaining
    slugified names together, and Section (which has no tree node of its own — it's a
    plain string tag on each Function) had nowhere to carry an id/description at all.
    Covers: all 7 new `<select>` mapping rows exist in the real wizard DOM; explicitly
    mapping each of them (via the actual wizard UI, not a direct sfce.js call) produces
    a tree whose Function node picks up the mapped functionId (overriding its own
    auto-slugify-chain id) and functionDescription (previously always blank, no matter
    what), plus nodeSectionId/nodeSectionDescription (a new pair of fields riding along
    on the Function node, since Section has no node of its own); the Application
    Capability level, left deliberately UNMAPPED, still cascades its name from the
    Business Capability (proving the new id/description fields don't interfere with
    the pre-existing name-cascade mechanism) while auto-deriving its own id from the
    mapped Capability id (not from scratch) since IDs don't cascade the way names do;
    and the mapped Capability/Entity ids DO override their own auto-derivation. Also
    covers a real bug found while building this: the auto-suggestion heuristic for
    Capability Id / Application Capability Id used a bare 'id' keyword, which matched
    an unrelated shallow field ("domainId") ahead of the real, deeper
    "capabilities.capId" — fixed by scoping the candidate set to fields whose own
    dotted path signals "this belongs to the capability group" before ranking by
    depth, same shallow-vs-deepest split already used for Capability vs. Application
    Capability name/description suggestions."""
    fixture = [
        {
            "domain": "Finance", "domainDescription": "Financial ops", "domainId": "fin",
            "section": "Corporate", "sectionDescription": "Corporate-wide functions", "sectionId": "corp",
            "capabilities": [
                {"name": "Budgeting", "description": "Budget planning", "capId": "budget-cap",
                 "entities": [{"name": "Budget Record", "description": "A budget line", "entId": "budget-rec"}]},
            ],
        },
    ]
    result = js(page, f"""
    async () => {{
      const app = window.dycadApp, store = app.store;
      const text = {json.dumps(json.dumps(fixture))};
      const blob = new Blob([text], {{ type: 'application/json' }});
      const file = new File([blob], 'regr-id-fixture.json', {{ type: 'application/json' }});
      const dt = new DataTransfer();
      dt.items.add(file);

      document.getElementById('file-menu-btn').click();
      await new Promise(r => setTimeout(r, 50));
      [...document.querySelectorAll('#file-menu .dd-item')].find(el => el.dataset.action === 'loadSFCCE')?.click();
      await new Promise(r => setTimeout(r, 50));

      const input = document.getElementById('sfcce-file-input');
      input.files = dt.files;
      document.getElementById('sfcce-preread-btn').click();
      await new Promise(r => setTimeout(r, 100));

      const newFieldIds = ['sfcce-field-section-desc', 'sfcce-field-section-id', 'sfcce-field-function-desc', 'sfcce-field-function-id',
                            'sfcce-field-capability-id', 'sfcce-field-application-capability-id', 'sfcce-field-entity-id'];
      const allNewFieldsPresent = newFieldIds.every((id) => !!document.getElementById(id));
      const suggestedCapabilityId = document.getElementById('sfcce-field-capability-id')?.value;

      document.getElementById('sfcce-field-section').value = 'section';
      document.getElementById('sfcce-field-section-desc').value = 'sectionDescription';
      document.getElementById('sfcce-field-section-id').value = 'sectionId';
      document.getElementById('sfcce-field-function').value = 'domain';
      document.getElementById('sfcce-field-function-desc').value = 'domainDescription';
      document.getElementById('sfcce-field-function-id').value = 'domainId';
      document.getElementById('sfcce-field-capability').value = 'capabilities.name';
      document.getElementById('sfcce-field-capability-desc').value = 'capabilities.description';
      document.getElementById('sfcce-field-capability-id').value = 'capabilities.capId';
      // Application Capability deliberately left UNMAPPED (explicitly blanked, not just
      // left at whatever the auto-suggestion pre-filled -- in a genuinely 3-level
      // dataset like this one, the depth-based suggestion heuristic can pick the
      // deeper Entity name field instead, a real user would need to notice and clear
      // it too) -- must still cascade its name from Capability, and auto-derive its
      // own id from the mapped Capability id.
      document.getElementById('sfcce-field-application-capability').value = '';
      document.getElementById('sfcce-field-application-capability-desc').value = '';
      document.getElementById('sfcce-field-application-capability-id').value = '';
      document.getElementById('sfcce-field-entity').value = 'capabilities.entities.name';
      document.getElementById('sfcce-field-entity-desc').value = 'capabilities.entities.description';
      document.getElementById('sfcce-field-entity-id').value = 'capabilities.entities.entId';
      document.querySelector('.modal-box .submit').click();
      await new Promise(r => setTimeout(r, 80));
      // Only one industry dataset ever exists — the built-in default is already loaded
      // at boot, so this always triggers the "clear and replace" warning first.
      [...document.querySelectorAll('.modal-box')].find(b => b.textContent.includes('clear and replace'))?.querySelector('.submit')?.click();
      await new Promise(r => setTimeout(r, 100));

      // No sharing across sections here, so no shared-level confirm steps should appear.
      const tree = store.doc.industryTree;
      const func = tree[0];
      const cap = func.nodeChildren[0];
      const appCap = cap.nodeChildren[0];
      const ent = appCap.nodeChildren[0];

      return {{
        allNewFieldsPresent, suggestedCapabilityId,
        functionId: func.nodeId, functionDescription: func.nodeDescription,
        nodeSectionId: func.nodeSectionId, nodeSectionDescription: func.nodeSectionDescription,
        capabilityId: cap.nodeId,
        appCapName: appCap.nodeName, appCapId: appCap.nodeId,
        entityId: ent.nodeId,
      }};
    }}
    """)
    problems = []
    if not result["allNewFieldsPresent"]:
        problems.append("expected all 7 new mapping <select> rows (Section/Function Description+Id, Capability/Application Capability/Entity Id) to exist in the real wizard DOM")
    if result["suggestedCapabilityId"] != "capabilities.capId":
        problems.append(f"expected the Capability Id auto-suggestion to correctly pick 'capabilities.capId' (not an unrelated shallow field like 'domainId'), got {result['suggestedCapabilityId']!r}")
    if result["functionId"] != "fin":
        problems.append(f"expected the mapped Function Id to override the auto-derived one, got {result['functionId']!r}")
    if result["functionDescription"] != "Financial ops":
        problems.append(f"expected the mapped Function Description to land on the Function node (previously always blank), got {result['functionDescription']!r}")
    if result["nodeSectionId"] != "corp" or result["nodeSectionDescription"] != "Corporate-wide functions":
        problems.append(f"expected Section Id/Description to be carried on the Function node (nodeSectionId/nodeSectionDescription), got {result['nodeSectionId']!r}/{result['nodeSectionDescription']!r}")
    if result["capabilityId"] != "budget-cap":
        problems.append(f"expected the mapped Capability Id to override the auto-derived one, got {result['capabilityId']!r}")
    if result["appCapName"] != "Budgeting":
        problems.append(f"expected the unmapped Application Capability to still cascade its name from the Capability, got {result['appCapName']!r}")
    if result["appCapId"] != "budget-cap-budgeting":
        problems.append(f"expected the unmapped Application Capability's id to auto-derive from the mapped Capability id (ids don't cascade), got {result['appCapId']!r}")
    if result["entityId"] != "budget-rec":
        problems.append(f"expected the mapped Entity Id to override the auto-derived one, got {result['entityId']!r}")
    if problems:
        return False, "; ".join(problems)
    return True, "Load SFCCE's wizard now supports mapping Section/Function Description+Id and Capability/Application Capability/Entity Id, correctly overriding auto-derived node ids and populating previously-always-blank Function/Section description fields, without disturbing the existing name-cascade-when-unmapped mechanism"


def check_load_sfcce_dialog_ux_and_generate_unique_id(page):
    """Regression guard/new-feature check for a follow-up round of UX requests on the
    Load SFCCE mapping dialog, reported directly: "Load SFCCE dialog: make shorter,
    perhaps 2 columns or reduced spacing. add '(none)' as an option so nothing is
    added. add '(generate unique' to generate a unique id. Update submit button to
    show script call with parameters, as done with other form submit buttons. Update
    SFCE catalog display and properties for all new fields." Covers: (1) the compact
    grid layout (.sfcce-mapping-row, one row per level with Field/Description/Id
    selects side by side) actually renders as exactly 6 rows (header + 5 levels)
    instead of the original 16 stacked .prop-rows, with a genuinely short modal
    height; (2) a Description select's blank option reads plainly "(none)" (not the
    misleading "(none — inherit from the level above)" carried over from the
    genuinely-cascading NAME fields — Descriptions never cascade); (3) an Id select
    offers a distinct "(generate unique)" option, and choosing it for a mapped level
    (here: Entity Id) produces a genuinely random id for each resulting row instead
    of either a real file value or the deterministic auto-derived (slugified-name)
    chain; (4) right-click on the dialog's Load button copies a
    buildRowsFromRecords(records, {...}) call reflecting the exact current mapping to
    the clipboard, the same "copy call" mechanism (wireCopyCallOnRightClick) Remap's
    own submit button already uses; (5) the generated BusinessOrganizationUnit Part's
    own description/xIds now come from the mapped Section Description/Id (previously
    the OrgUnit was always created with no description and no xIds at all), and the
    SFCE Catalog's own table columns (tab.tableCols) include the new sectionId/
    sectionDescription columns alongside every other level's existing id/description
    columns."""
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    fixture = [
        {
            "domain": "Finance", "domainDescription": "Financial ops", "domainId": "fin",
            "section": "Corporate", "sectionDescription": "Corporate-wide functions", "sectionId": "corp",
            "capabilities": [
                {"name": "Budgeting", "description": "Budget planning", "capId": "budget-cap",
                 "entities": [{"name": "Budget Record", "description": "A budget line", "entId": "budget-rec"}]},
            ],
        },
    ]
    result = js(page, f"""
    async () => {{
      const app = window.dycadApp, store = app.store;
      const text = {json.dumps(json.dumps(fixture))};
      const blob = new Blob([text], {{ type: 'application/json' }});
      const file = new File([blob], 'regr-dialog-ux-fixture.json', {{ type: 'application/json' }});
      const dt = new DataTransfer();
      dt.items.add(file);

      document.getElementById('file-menu-btn').click();
      await new Promise(r => setTimeout(r, 50));
      [...document.querySelectorAll('#file-menu .dd-item')].find(el => el.dataset.action === 'loadSFCCE')?.click();
      await new Promise(r => setTimeout(r, 50));

      const input = document.getElementById('sfcce-file-input');
      input.files = dt.files;
      document.getElementById('sfcce-preread-btn').click();
      await new Promise(r => setTimeout(r, 100));

      const gridRows = document.querySelectorAll('.sfcce-mapping-row').length;
      const modalHeight = document.querySelector('.modal-box').getBoundingClientRect().height;
      const descOptions = [...document.getElementById('sfcce-field-capability-desc').options].map(o => o.textContent);
      const idOptions = [...document.getElementById('sfcce-field-capability-id').options].map(o => o.textContent);
      const genUniqueOption = [...document.getElementById('sfcce-field-entity-id').options].find(o => o.textContent === '(generate unique)');

      document.getElementById('sfcce-field-section').value = 'section';
      document.getElementById('sfcce-field-section-desc').value = 'sectionDescription';
      document.getElementById('sfcce-field-section-id').value = 'sectionId';
      document.getElementById('sfcce-field-function').value = 'domain';
      document.getElementById('sfcce-field-function-desc').value = 'domainDescription';
      document.getElementById('sfcce-field-function-id').value = 'domainId';
      document.getElementById('sfcce-field-capability').value = 'capabilities.name';
      document.getElementById('sfcce-field-capability-desc').value = 'capabilities.description';
      document.getElementById('sfcce-field-capability-id').value = 'capabilities.capId';
      document.getElementById('sfcce-field-application-capability').value = '';
      document.getElementById('sfcce-field-application-capability-desc').value = '';
      document.getElementById('sfcce-field-application-capability-id').value = '';
      document.getElementById('sfcce-field-entity').value = 'capabilities.entities.name';
      document.getElementById('sfcce-field-entity-desc').value = 'capabilities.entities.description';
      document.getElementById('sfcce-field-entity-id').value = genUniqueOption.value; // "(generate unique)", not a real field

      const submitBtn = document.querySelector('.modal-box .submit');
      submitBtn.dispatchEvent(new MouseEvent('contextmenu', {{ bubbles: true, cancelable: true }}));
      await new Promise(r => setTimeout(r, 100));
      let clipboardText = null;
      try {{ clipboardText = await navigator.clipboard.readText(); }} catch (e) {{ clipboardText = null; }}

      submitBtn.click();
      await new Promise(r => setTimeout(r, 80));
      // Only one industry dataset ever exists — the built-in default is already loaded
      // at boot, so this always triggers the "clear and replace" warning first.
      [...document.querySelectorAll('.modal-box')].find(b => b.textContent.includes('clear and replace'))?.querySelector('.submit')?.click();
      await new Promise(r => setTimeout(r, 100));

      const tree = store.doc.industryTree;
      const ent = tree[0].nodeChildren[0].nodeChildren[0].nodeChildren[0];

      const commands = await import('./js/commands.js');
      const view = store.addView('RegrDialogUxView_' + Date.now(), 'ff');
      store.currentView = view.id;
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      await commands.generateIndustry(app, null, true);
      const orgUnit = store.doc.parts.find(p => p.type === 'BusinessOrganizationUnit' && p.label === 'Corporate');

      app.openOrSwitchSfceCatalog();
      const catalogTab = store.tabs.find(t => t.sfceCatalog);

      return {{
        gridRows, modalHeight, descOptions, idOptions, clipboardText,
        entityId: ent.nodeId,
        orgUnitDescription: orgUnit?.description, orgUnitXIds: orgUnit?.xIds,
        catalogCols: catalogTab?.tableCols,
      }};
    }}
    """)
    problems = []
    if result["gridRows"] != 6:
        problems.append(f"expected the compact grid layout to render exactly 6 rows (header + 5 levels), got {result['gridRows']}")
    if result["modalHeight"] >= 500:
        problems.append(f"expected a genuinely compact modal (<500px tall), got {result['modalHeight']}")
    if "(none)" not in result["descOptions"]:
        problems.append(f"expected a plain, non-misleading '(none)' option in a Description select, got {result['descOptions']}")
    if not any("generate unique" in o for o in result["idOptions"]):
        problems.append(f"expected a '(generate unique)' option in an Id select, got {result['idOptions']}")
    if not result["clipboardText"] or "buildRowsFromRecords(records," not in result["clipboardText"]:
        problems.append(f"expected right-click on the submit button to copy a buildRowsFromRecords(records, {{...}}) call, got {result['clipboardText']!r}")
    elif "capabilityIdField" not in result["clipboardText"] or "sectionDescriptionField" not in result["clipboardText"]:
        problems.append(f"expected the copied call to reflect the actual current mapping (all 15 fields), got {result['clipboardText']!r}")
    # The deterministic auto-derived fallback chain for this exact fixture (capability
    # id mapped to "budget-cap", Application Capability left unmapped so it cascades
    # the capability's own name) would be precisely "budget-cap-budgeting-budget-
    # record" -- checking against this EXACT string (not just a length/shape guess)
    # is what actually distinguishes "(generate unique)" firing from silently falling
    # back to auto-derivation, since a UUID and a slugified-name chain can both be
    # long strings.
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", result["entityId"] or ""):
        problems.append(f"expected '(generate unique)' to produce a genuine UUID, got {result['entityId']!r}")
    if result["entityId"] == "budget-cap-budgeting-budget-record":
        problems.append("expected '(generate unique)' to NOT silently fall back to the deterministic auto-derived id chain")
    if result["orgUnitDescription"] != "Corporate-wide functions":
        problems.append(f"expected the generated BusinessOrganizationUnit part's own description to come from the mapped Section Description, got {result['orgUnitDescription']!r}")
    if result["orgUnitXIds"] != "corp":
        problems.append(f"expected the generated BusinessOrganizationUnit part's own xIds to come from the mapped Section Id, got {result['orgUnitXIds']!r}")
    if not result["catalogCols"] or "sectionId" not in result["catalogCols"] or "sectionDescription" not in result["catalogCols"]:
        problems.append(f"expected the SFCE Catalog's own tableCols to include sectionId/sectionDescription, got {result['catalogCols']}")
    if problems:
        return False, "; ".join(problems)
    return True, "Load SFCCE's dialog is now a compact 6-row grid with correctly-worded (none)/(generate unique) options, right-click-copies its exact mapping call like Remap's own submit button, and the mapped Section Id/Description now surface on the generated BusinessOrganizationUnit part's own properties and in the SFCE Catalog's table columns"


CHECKS = [
    check_boots_clean,
    check_example_simulates,
    check_sim_snapshot_rejects_pre_rebrand_tag,
    check_remap_patterns,
    check_remap_layered_pattern,
    check_remap_crossing_minimization_finds_global_optimum,
    check_remap_layered_avoids_node_occlusion,
    check_custom_remap_grid_convenience_layer,
    check_custom_remap_dialog,
    check_force_directed_no_runaway_drift,
    check_force_directed_adjacent_cells,
    check_remap_clusters_decomposition,
    check_remap_clusters_grid_placement,
    check_remap_clusters_connectivity_aware_packing,
    check_remap_clusters_avoid_node_on_connector_overlap,
    check_smart_check_view,
    check_property_panel_field_split,
    check_multiselect_shows_entity_level_fields,
    check_code_summary,
    check_script_console_and_code_summary_moved_to_advanced,
    check_reset_pinned_3d_positions_moved_to_explore,
    check_toolbar_filter_groups_hidden_when_inactive,
    check_filters_panel_moved_from_toolbar,
    check_view3d_empty_click_deselects_and_shows_filters,
    check_view_display_filters_moved_to_filters_panel,
    check_filters_properties_alignment_and_row_spacing,
    check_script_console_runs_main_function,
    check_script_console_run_function_picker,
    check_batch_script_quickstart,
    check_script_console_remap_and_smart_check_bindings,
    check_script_console_reference_tab,
    check_script_console_sizing_and_copy_buttons,
    check_catalog_multi_column_sort,
    check_sfce_table_multi_column_sort,
    check_spacing_scale_uniform,
    check_routing_avoids_obstacle,
    check_archimate_import_fixture,
    check_timestamps,
    check_section_drag_title_overlap,
    check_section_drag_no_stacking,
    check_section_drag_grows_full_section,
    check_connector_popover_matches_panel,
    check_instructions_tab_on_startup,
    check_import_logs_to_message_log,
    check_mutation_toasts_log_to_message_log,
    check_keyboard_focus_visible,
    check_section_rowcount_realigns_nodes,
    check_toolbox_drag_to_canvas,
    check_new_content_sized_and_non_overlapping,
    check_smart_check_view_default_levels_unlimited,
    check_smart_check_view_dialog_derive_checkbox_wiring,
    check_smart_check_view_copy_call_on_right_click,
    check_force_directed_options,
    check_sfce_import_and_generate,
    check_generate_industry_no_collapse_keeps_functions_separate,
    check_enterprise_template_is_short_default,
    check_generate_industry_selection_cap,
    check_modal_no_close_on_outside_click,
    check_stream_filter_select_all_exclude_all,
    check_section_filter,
    check_types_filter_keeps_connectors_visible,
    check_export_svg_includes_sections,
    check_catalog_row_copy_includes_all_part_fields,
    check_generate_industry_place_on_view_defaults_unchecked,
    check_dropdown_scrollable,
    check_sfce_catalog_page,
    check_sfce_catalog_section_description_fallback,
    check_boot_loader_wires_section_id_and_order,
    check_routing_style_per_connector_type,
    check_auto_complete_streams_ui,
    check_streams_field_editable,
    check_pinned_field_dblclick_not_stolen_by_pin_icon,
    check_local_secrets_settings_split,
    check_batch_script_code_persists_with_local_settings,
    check_common_script_callable_from_part_script,
    check_smart_stream_preset_local_persistence,
    check_smart_stream_preset_dialog_save_and_load,
    check_instructions_closed_persists_across_reload,
    check_load_sfcce,
    check_load_sfcce_shared_functions_only,
    check_load_sfcce_shared_section_selector,
    check_load_sfcce_id_and_description_mapping,
    check_load_sfcce_dialog_ux_and_generate_unique_id,
    check_stream_template_shared_default,
    check_remap_options_persist_across_views,
    check_remap_edge_assignment_and_layout_optimization,
    check_remap_edge_assignment_numbered_slots_and_blanks,
    check_remap_edge_assignment_dialog_numbered_ui,
    check_remap_preset_dialog_and_local_persistence,
    check_remap_view_remembers_own_settings,
    check_remap_selected_only,
    check_spacing_command_selected_nodes_only,
    check_remap_selected_only_anchors_at_original_position,
    check_spacing_axis_toggle,
    check_remap_copy_call_on_right_click,
    check_generate_stream_prepopulates_from_existing,
    check_node_size_multiplier,
    check_smart_check_node,
    check_view3d_boots,
    check_view3d_layers_and_filters,
    check_view3d_stream_lane_alignment,
    check_view3d_connectors_and_clustering,
    check_view3d_layer_order_template_selector,
    check_view3d_all_template_covers_all_elements,
    check_view3d_focus_and_zoom_jump,
    check_sfce_array_field_survives_deeper_nesting,
    check_view3d_sim_overlay,
    check_view3d_dispose_cancels_current_animation_frame,
    check_view3d_real_click_shows_panel_and_no_recenter,
    check_view3d_node_context_menu,
    check_view3d_view_scope_filter,
    check_view3d_connector_type_toolbar_filter,
    check_view3d_connector_direction_markers,
    check_view3d_right_click_drag_pins_node,
    check_view3d_reset_pinned_positions,
    check_view3d_highlight_type_picker,
    check_view3d_disposed_on_full_document_load,
    check_export_svg_respects_connector_type_checkboxes,
    check_export_svg_respects_connector_routing,
    check_export_svg_respects_content_checkboxes,
    check_export_view3d_as_image,
    check_view3d_section_boundaries,
    check_generate_industry_propagates_section_to_whole_chain,
    check_business_organization_unit_element_and_generation,
    check_level_down_single_creates_new_part,
    check_level_down_downstream_external_placed_near_anchor,
    check_level_down_creates_composition_link,
    check_level_down_reuses_existing_decomposition_across_viewmembers,
    check_data_modeling_attributes_and_data_connector,
    check_data_modeling_crowfoot_rendering,
    check_data_modeling_menu_and_ddl_import_export,
    check_data_modeling_node_attributes_and_manual_connector_creation,
    check_data_entity_details_sizing_fits_attribute_count,
    check_textarea_height_persisted_per_field,
    check_redraw_dialog_show_all_text,
    check_data_modeling_attribute_editing_and_auto_fk,
    check_data_modeling_autofill,
    check_auto_detect_connectors_detection_and_creation,
    check_auto_detect_connectors_dialog,
    check_level_up_creates_data_data_entity,
    check_level_it_replaces_across_template_gap,
    check_level_it_context_menu_and_toolbar_wiring,
    check_smart_check_composition_top_down,
    check_smart_check_composition_bottom_up,
    check_smart_check_node_composition_redirect,
    check_smart_check_sync_with_inventory_checkbox,
    check_prompt_sync_inventory_connector,
    check_property_panel_relationship_edit_triggers_sync_prompt,
    check_delete_offers_inventory_cleanup,
    check_add_existing_prefiltered_by_section,
    check_insert_smart_stream_traversal,
    check_insert_smart_stream_dialog,
    check_insert_smart_stream_derived_connections,
    check_smart_check_view_derive_connectors,
    check_derived_connector_isDerived_flag_and_include_option,
    check_smart_check_view_dialog_include_derived_checkbox_wiring,
    check_derived_connector_relationship_fallback,
    check_smart_check_model_detection_and_fix_precedence,
    check_smart_check_model_dialog,
]


def main():
    server = subprocess.Popen(
        ["python3", "-m", "http.server", str(PORT)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    results = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for check in CHECKS:
                page = browser.new_page()
                name = check.__name__
                try:
                    page.goto(f"http://localhost:{PORT}/index.html")
                    page.wait_for_timeout(800)
                    passed, detail = check(page)
                except Exception as e:
                    passed, detail = False, f"threw: {e}"
                results.append((name, passed, detail))
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)

    print()
    width = max(len(name) for name, _, _ in results)
    failed_count = 0
    for name, passed, detail in results:
        status = "PASS" if passed else "FAIL"
        if not passed:
            failed_count += 1
        print(f"[{status}] {name.ljust(width)}  {detail}")
    print()
    print(f"{len(results) - failed_count}/{len(results)} passed")
    sys.exit(1 if failed_count else 0)


if __name__ == "__main__":
    main()
