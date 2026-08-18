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
import os
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
      for (const pattern of ['default', 'none', 'force']) {
        results[pattern] = !!commands.applyRemapLayout(app, view.id, { pattern });
      }
      return results;
    }
    """)
    failed = [p for p, ok in result.items() if not ok]
    if failed:
        return False, f"patterns failed: {failed}"
    return True, "default/none/force Remap patterns all completed"


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
      const industryKeys = Object.keys(store.industryData || {});
      if (industryKeys.length > 0) {
        await commands.generateIndustry(app, industryKeys[0], () => {});
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
      app.runCommand('redraw');
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
      store.industryData['sfce-fixture'] = tree;
      // Registering 'SFCCE' here is what File > Load SFCCE's own wizard always does
      // (finishSFCCEImport) — required now that buildIndustryTree always produces a
      // 4-level tree (Application Capability cascades from Capability when unmapped, same as
      // here): without it generateIndustry defaults to 'Enterprise', which has no
      // Application Capability concept and would reject every Application Capability-typed child as an
      // invalid entity, producing zero jobs.
      store.industryTemplates['sfce-fixture'] = 'SFCCE';

      const view = store.addView('SFCERegr_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      const before = store.doc.parts.length;
      let threw = null;
      try { await commands.generateIndustry(app, 'sfce-fixture', () => {}); } catch (e) { threw = e.message; }
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
      store.industryData['sfce-nocollapse-fixture'] = tree;
      store.industryTemplates['sfce-nocollapse-fixture'] = 'SFCCE'; // see check_sfce_import_and_generate's own comment on this line

      const view = store.addView('SFCENoCollapse_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      await commands.generateIndustry(app, 'sfce-nocollapse-fixture', () => {});

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
      store.industryData['regrSelectionCap150'] = tree;

      const view = store.addView('RegrSelCap_' + Date.now());
      view.viewType = 'ff';
      const tab = app.createCanvasTab(view);
      app.switchToTab(tab.id);
      await commands.generateIndustry(app, 'regrSelectionCap150', () => {});
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
    """Regression guard: Catalogs > SFCE should open a read-only table of the
    Section/Function/Capability/Application Capability/Entity hierarchy, with id and description
    at every level, working for the built-in "general" data (a genuine 3-level tree, no
    Application Capability concept, blank Application Capability columns) as well as a Load SFCCE
    import."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      app.promptSfceCatalog();
      await new Promise(r => setTimeout(r, 50));
      const catalogTab = store.tabs.find(t => t.sfceIndustryKey === 'general');
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
    expectedCols = ["section", "functionId", "functionName", "functionDescription", "capabilityId", "capabilityName", "capabilityDescription", "applicationCapabilityId", "applicationCapabilityName", "applicationCapabilityDescription", "entityId", "entityName", "entityDescription"]
    if not result["tabCreated"] or result["rowCount"] == 0:
        return False, f"catalog tab wasn't created or has no rows: {result}"
    if result["cols"] != expectedCols:
        return False, f"unexpected columns: {result['cols']}"
    if not result["tableRendered"] or result["headerCount"] != len(expectedCols):
        return False, f"table didn't render correctly: {result}"
    return True, f"SFCE Catalog opened with {result['rowCount']} rows and all {len(expectedCols)} id/description columns"


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
    """Regression guard: Remap's own options (pattern, limit-columns, filtered-only, the
    two force-directed sub-options, and sort priority order) should be remembered as
    user-level defaults across ALL views, not just the specific view they were set on —
    so even a brand-new view's Remap dialog starts from them, surviving a page reload.
    Distinct from (and lower-priority than) view.remapSortKeys, which remembers a
    specific view's own last-used order and still wins once that view has its own
    history — this only checks the fallback a fresh view gets."""
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
    if not result2["forcePreferRight"]: problems.append("'Prefer placing connected nodes to the right' should default checked")
    if not result2["forceGroupRows"]: problems.append("'Only start a new row when a node is a new hop away' should default checked")
    if result2["firstKey"] != result["reorderedFirstKey"]: problems.append(f"sort priority order should default to the previously-reordered order (first key {result['reorderedFirstKey']!r}), got {result2['firstKey']!r}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result2})"
    return True, "Remap's options (pattern, checkboxes, sort order) persisted as user-level defaults onto a brand-new view, surviving a reload"


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

      // clear stream filter, apply type filter instead
      tab.activeStreams = [];
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


def check_view3d_cube_order_fallback(page):
    """Regression guard for 3D View Stage 3: custom.json's cubeOrder now decides fallback
    layer order (both group and type) for any element type the active stream template's
    value[] doesn't mention — instead of falling back to elementGroups' own declaration
    order, which isn't itself a meaningful/deliberate sequence (just JSON authoring
    order). Uses the built-in 'Test' template (value: BusinessService, BusinessCapability,
    BusinessProcess, thingamajack, DataDataEntity — covering the Business/Unknown/Data
    groups, nothing else) so General and Application are BOTH left for the fallback to
    order — the one case where the old elementGroups-order fallback and the new cubeOrder
    fallback actually disagree (old: Application before General; new, matching
    cubeOrder's own General-before-Application sequence: General before Application),
    rather than a case where they'd coincidentally agree either way."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      localStorage.setItem('dycad-local-settings-cache', JSON.stringify({ streamTemplate: 'Test' }));

      store.createPart({ type: 'GeneralActor', label: 'GA', model: store.defaultModel, streams: [] });
      store.createPart({ type: 'ApplicationComponent', label: 'AC', model: store.defaultModel, streams: [] });

      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 200));
      return view3d.getDebugSceneInfo(tab.id);
    }
    """)
    ga = result["types"].get("GeneralActor")
    ac = result["types"].get("ApplicationComponent")
    if not ga or not ac:
        return False, f"expected both GeneralActor and ApplicationComponent to have their own layer, got {result}"
    if not (ga["z"] < ac["z"]):
        return False, f"expected General's layer (z={ga['z']}) before Application's (z={ac['z']}) — cubeOrder's own group sequence puts General first; the old elementGroups-declaration-order fallback would have put Application first instead, got: {result}"
    return True, "with a template (Test) that leaves both General and Application unordered, the fallback used custom.json's cubeOrder sequence (General before Application) rather than elementGroups' own declaration order (which disagrees)"


def check_view3d_focus_and_zoom_jump(page):
    """Regression guard for 3D View Stage 4 (zoom-to-2D-detail): focusing a part (driven
    here via view3d.js's debugFocusPart, since real mouse/wheel events are unreliable
    against a headless WebGL canvas — see that function's own comment) sets focusedPartId
    and shows the wireframe highlight marker; zooming in past ZOOM_JUMP_DISTANCE while
    focused (driven via debugSetCameraDistance, which repositions the camera and dispatches
    the same 'change' event a real zoom would) switches to the matching 2D view and selects
    the right viewMember there — exactly once per crossing, checked directly via
    jumpedForPartId rather than only by side effect, so a regression that re-fires every
    frame while still inside the threshold would be caught even though it'd look
    superficially the same (still ends up on the right view); zooming back out past the
    threshold re-arms it so zooming back in jumps again; and a focused part with no view
    placement anywhere toasts to the Message Log instead of jumping or throwing."""
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

      const focusOk = view3d.debugFocusPart(tab3d.id, placed.id);
      const afterFocus = view3d.getDebugSceneInfo(tab3d.id);

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

      // a focused part with NO view placement should toast, not navigate or throw
      app.switchToTab(tab3d.id);
      const beforeLogLen = store.messageLog.length;
      view3d.debugFocusPart(tab3d.id, orphan.id);
      view3d.debugSetCameraDistance(tab3d.id, 0.5);
      await new Promise(r => setTimeout(r, 100));
      const at3 = store.activeTab();
      const orphanResult = {
        activeTabType: at3 ? at3.type : null,
        logGrew: store.messageLog.length > beforeLogLen,
        lastLogMsg: store.messageLog.length ? store.messageLog[store.messageLog.length - 1].message : '',
      };

      app.openOrSwitchView = origOpenOrSwitchView;
      return { focusOk, afterFocus, afterJump, jumpedForBefore, jumpedForAfterRepeat, switchCallsAfterFirstJump, switchCallsAfterRepeat, rearmed, secondJump, orphanResult, vmId: vm.id, viewId: view.id, partId: placed.id, orphanId: orphan.id };
    }
    """)
    problems = []
    partId = result["partId"]
    if not result["focusOk"]:
        problems.append("debugFocusPart returned false for a part actually present in the scene")
    af = result["afterFocus"]
    if af["focusedPartId"] != partId or not af["focusMarkerVisible"]:
        problems.append(f"expected focusPart to set focusedPartId and show the highlight marker, got {af}")
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
    if not orp["logGrew"] or "isn't placed on any view yet" not in orp["lastLogMsg"]:
        problems.append(f"a focused part with no view placement should toast (logged to the Message Log) instead of silently doing nothing or throwing, got {orp}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "click-to-focus sets state and shows the marker, zooming past the threshold jumps to the matching 2D view and selects the right node exactly once per crossing, zooming back out re-arms it so zooming back in jumps again, and an unplaced part toasts instead of jumping or throwing"


def check_load_sfcce(page):
    """Regression guard for File > Load SFCCE — the unified Section/Function/Capability/
    Application Capability/Entity import that replaced separate Load SFCE and Load Capability Map
    features. Uses a small, deliberate 2-level-nested fixture (one domain, one business
    capability, one application capability that itself lists 2 ministries) designed so
    ALL THREE independently-resolvable sharing levels (Domain, Business Capability,
    Application Capability) fire simultaneously from one row — this specifically guards a
    real bug found while building this: capability-level sharing detection was
    structurally unable to fire once domain-level resolution had already consumed the
    section diversity (fixed via frozen originalFunctionName/originalCapabilityName/
    originalApplicationCapabilityName/originalSection fields, immune to resolution order — see
    sfce.js's detectSharedLevel). Also exercises flattenJsonRecords' full-dot-path field
    naming (both nesting levels have their own "name"/"description" fields, which must
    surface as distinct businessCapabilities.name / businessCapabilities.applicationCapabilities.name
    rather than clobbering each other), the cascade-when-unmapped design (Entity isn't
    mapped here, so it inherits the Application Capability's own name — producing a real
    DataDataEntity part one level deeper, not an absent one), confirms Generate Industry
    produces a real ApplicationCapability-typed part via the 'SFCCE' stream template
    (through store.industryTemplates, not always 'Enterprise'), and confirms SFCCE's
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
      document.getElementById('sfcce-industry-name').value = 'RegrSFCCE';
      document.querySelector('.modal-box .submit').click();
      await new Promise(r => setTimeout(r, 80));

      const step3Title = document.querySelector('.modal-box h3')?.textContent || '';
      document.getElementById('sfcce-shared-yes')?.click(); // Domain: collapse
      await new Promise(r => setTimeout(r, 80));

      const step4Title = document.querySelector('.modal-box h3')?.textContent || '';
      document.getElementById('sfcce-shared-yes')?.click(); // Business Capability: collapse
      await new Promise(r => setTimeout(r, 80));

      const step5Title = document.querySelector('.modal-box h3')?.textContent || '';
      document.getElementById('sfcce-shared-yes')?.click(); // Application Capability: collapse
      await new Promise(r => setTimeout(r, 100));

      const tree = store.industryData['RegrSFCCE'];
      const templateName = store.industryTemplates['RegrSFCCE'];

      const commands = await import('./js/commands.js');
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      store.currentView = homeTab.viewId;
      await commands.generateIndustry(app, 'RegrSFCCE', null, false);

      const funcParts = store.doc.parts.filter(p => p.type === 'BusinessFunction');
      const capParts = store.doc.parts.filter(p => p.type === 'BusinessCapability');
      const appCapParts = store.doc.parts.filter(p => p.type === 'ApplicationCapability');
      const dataEntityParts = store.doc.parts.filter(p => p.type === 'DataDataEntity');
      const businessProcessParts = store.doc.parts.filter(p => p.type === 'BusinessProcess');
      const appApplicationParts = store.doc.parts.filter(p => p.type === 'ApplicationApplication');
      const appPhysicalComponentParts = store.doc.parts.filter(p => p.type === 'ApplicationPhysicalComponent');

      return {{
        step2Title, step3Title, step4Title, step5Title,
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
    if result['step3Title'] != 'Shared Domains found':
        return False, f"expected the Domain-sharing question to appear: {result}"
    if result['step4Title'] != 'Shared Business Capabilities found':
        return False, f"expected the Business-Capability-sharing question to appear too — this is the ordering bug this check guards against: {result}"
    if result['step5Title'] != 'Shared Application Capabilities found':
        return False, f"expected the Application-Capability-sharing question to appear too (the app capability itself lists 2 ministries directly): {result}"
    if result['templateName'] != 'SFCCE':
        return False, f"expected store.industryTemplates to register the 'SFCCE' template: {result}"
    if result['funcCount'] != 1 or result['capCount'] != 1 or result['appCapCount'] != 1:
        return False, f"expected exactly 1 part at each of Function/Capability/ApplicationCapability (all 3 levels collapsed to 'Shared'): {result}"
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
    return True, "Load SFCCE's unified wizard correctly resolves all three independent sharing levels, and Generate Industry produces a real ApplicationCapability-typed part via the 'SFCCE' template"


CHECKS = [
    check_boots_clean,
    check_example_simulates,
    check_remap_patterns,
    check_force_directed_no_runaway_drift,
    check_force_directed_adjacent_cells,
    check_smart_check_view,
    check_property_panel_field_split,
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
    check_section_rowcount_realigns_nodes,
    check_new_content_sized_and_non_overlapping,
    check_smart_check_view_default_levels_unlimited,
    check_force_directed_options,
    check_sfce_import_and_generate,
    check_generate_industry_no_collapse_keeps_functions_separate,
    check_enterprise_template_is_short_default,
    check_generate_industry_selection_cap,
    check_modal_no_close_on_outside_click,
    check_dropdown_scrollable,
    check_sfce_catalog_page,
    check_routing_style_per_connector_type,
    check_auto_complete_streams_ui,
    check_streams_field_editable,
    check_pinned_field_dblclick_not_stolen_by_pin_icon,
    check_local_secrets_settings_split,
    check_instructions_closed_persists_across_reload,
    check_load_sfcce,
    check_stream_template_shared_default,
    check_remap_options_persist_across_views,
    check_generate_stream_prepopulates_from_existing,
    check_node_size_multiplier,
    check_smart_check_node,
    check_view3d_boots,
    check_view3d_layers_and_filters,
    check_view3d_connectors_and_clustering,
    check_view3d_cube_order_fallback,
    check_view3d_focus_and_zoom_jump,
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
