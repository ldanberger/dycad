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
      const topLabels = [...document.querySelectorAll('#properties-body > div:first-child label[data-field]')].map(l => l.dataset.field);
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
      const mapping = { sectionField: 'ministries', functionField: 'domain', capabilityField: 'name', entityField: null, descriptionField: 'description' };
      const parsed = sfce.buildRowsFromRecords(records, mapping);
      const { sectionsByFunction, sharedFunctionNames } = sfce.detectSharedFunctions(parsed.rows);
      const resolved = sfce.resolveSharedFunctions(parsed.rows, sectionsByFunction, sharedFunctionNames, true);
      const { tree, stats } = sfce.buildIndustryTree(resolved);
      store.industryData['sfce-fixture'] = tree;

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
        fieldsHasMinistries: fields.includes('ministries'),
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
      const mapping = { sectionField: 'ministries', functionField: 'domain', capabilityField: 'name', entityField: null, descriptionField: 'description' };
      const { rows } = sfce.buildRowsFromRecords(records, mapping);
      const { sectionsByFunction, sharedFunctionNames } = sfce.detectSharedFunctions(rows);
      const resolved = sfce.resolveSharedFunctions(rows, sectionsByFunction, sharedFunctionNames, false);
      const { tree } = sfce.buildIndustryTree(resolved);
      store.industryData['sfce-nocollapse-fixture'] = tree;

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
    """Regression guard: dialogs (tested here via Load SFCE, but the fix applies to all
    of them — every modal in the app shares the same overlay pattern) should only close
    via their own Cancel/Close controls, not a click anywhere outside the box."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const homeTab = store.tabs.find(t => t.type === 'canvas');
      app.switchToTab(homeTab.id);
      const out = {};
      app.promptLoadSFCE();
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
    """Regression guard: Advanced > SFCE Catalog should open a read-only table of the
    Section/Function/Capability/Entity hierarchy, with id and description at every
    level, working for the built-in "general" data (no section concept) as well as a
    Load SFCE import."""
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
    expectedCols = ["section", "functionId", "functionName", "functionDescription", "capabilityId", "capabilityName", "capabilityDescription", "entityId", "entityName", "entityDescription"]
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
