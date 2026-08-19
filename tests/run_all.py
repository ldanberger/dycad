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
      const box = document.querySelector('.modal-box.modal-box-textedit');
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


def check_batch_script_quickstart(page):
    """Regression guard/new-feature check for the built-in BatchScript_QuickStart script
    (store.batchScriptCode's out-of-the-box default, DEFAULT_BATCH_SCRIPT_CODE in
    state.js) — verifies it actually performs every step described when main() (which
    calls it) is run via the real Script Console UI: (1) Generate Industry with the
    default "general" industry, not placed on any view; (2) a new View "Business
    Functions" of type "org" (Business Function Organization); (3) Populate From
    Template using "Enterprise Functions" inside that view; (4) the "mof" (Mainstream
    Operational Functions) section's rowCount changed from its default of 2 down to 1;
    (5) the view's own tab zoomed to 60%; (6) "Done" written to the persistent Message
    Log (not just the Script Console's own output area)."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      app.promptScriptConsole();
      await new Promise(r => setTimeout(r, 60));
      // Each check runs on its own fresh page (see run_all.py's main()), so
      // store.batchScriptCode is still the real, unmodified default here.
      const box = document.querySelector('.modal-box.modal-box-textedit');

      box.querySelector('.run').click();
      await new Promise(r => setTimeout(r, 2000));
      box.querySelector('.cancel').click();
      await new Promise(r => setTimeout(r, 60));

      const view = store.findView('Business Functions');
      const mof = view ? (view.sections || []).find(s => s.sectionId === 'mof') : null;
      const tab = store.tabs.find(t => t.viewId === view?.id);
      const genActor = store.doc.parts.find(p => p.type === 'BusinessCapability');

      return {
        viewCreated: !!view,
        viewType: view ? view.viewType : null,
        partsPlaced: view ? store.viewMembersForView(view.id).filter(v => v.objectType === 'part').length : 0,
        mofRowCount: mof ? mof.rowCount : null,
        zoom: tab ? tab.viewport.zoom : null,
        industryGenerated: !!genActor,
        messageLogHasDone: store.messageLog.some(e => JSON.stringify(e).includes('Done')),
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
    if not result["industryGenerated"]:
        problems.append("expected Generate Industry (default 'general') to have actually run, producing at least one BusinessCapability part")
    if not result["messageLogHasDone"]:
        problems.append("expected 'Done' written to the persistent Message Log")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, "BatchScript_QuickStart (run via main(), the real Script Console UI) generates the default industry, builds a Business Functions org view from the Enterprise Functions template, adjusts the mof section's row count, zooms to 60%, and logs 'Done'"


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
      store.industryData['CopyCheckIndustry'] = [];
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


def check_cubeorder_covers_all_elements(page):
    """Regression guard for a real near-miss: cubeOrder (see check_view3d_cube_order_fallback
    above) is documented as "a hand-authored master list covering every element type" —
    but it's a second, hand-maintained list that has to be kept in sync with
    settings.elements by hand every time a new element type is added, with nothing
    enforcing that today. Caught while adding BusinessEvent: the new element worked fine
    in the Toolbox and on canvas immediately, but would have silently fallen through to
    resolveLayerOrder's defensive tkDisplayOrder/alphabetical fallback in the 3D View
    (rather than its deliberate, intended position) if cubeOrder hadn't ALSO been
    updated — an easy thing to forget since nothing else surfaces the omission. Checks
    both directions: every element type appears in cubeOrder exactly once, and every
    cubeOrder entry has a matching element."""
    result = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const elTypes = (store.settings.elements || []).map(e => e.type);
      const cube = store.settings.cubeOrder || [];
      const elSet = new Set(elTypes);
      const cubeSet = new Set(cube);
      const missingFromCube = elTypes.filter(t => !cubeSet.has(t));
      const orphanedInCube = cube.filter(t => !elSet.has(t));
      const dupesInCube = cube.filter((t, i) => cube.indexOf(t) !== i);
      return { elementCount: elTypes.length, cubeCount: cube.length, missingFromCube, orphanedInCube, dupesInCube };
    }
    """)
    problems = []
    if result["missingFromCube"]:
        problems.append(f"element type(s) missing from cubeOrder: {result['missingFromCube']}")
    if result["orphanedInCube"]:
        problems.append(f"cubeOrder entries with no matching element: {result['orphanedInCube']}")
    if result["dupesInCube"]:
        problems.append(f"duplicate entries in cubeOrder: {result['dupesInCube']}")
    if problems:
        return False, "; ".join(problems) + f" (full: {result})"
    return True, f"cubeOrder stays in exact 1:1 correspondence with settings.elements ({result['elementCount']} types, no gaps/orphans/duplicates)"


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


def check_view3d_node_context_menu(page):
    """Regression guard for the 3D node right-click context menu (Filter to Streams +
    Connector Type quick filter — 3D draws connectorType 'c' Connectors and 's' Streams
    together with no distinction by default, unlike the 2D canvas's per-view checkboxes).
    Uses genuine page.mouse.click(..., button='right') events, positioned via
    debugGetScreenPosition, against a fixture with a distinguishable 'c' and 's'
    connector from the same source part, so switching the Connector Type filter produces
    a directly observable, different connectorCount — not just a changed field value."""
    setup = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      const a = store.createPart({ type: 'GeneralActor', label: 'CtxSource', model: store.defaultModel, streams: ['S1', 'S2'] });
      // b/c also carry S1 so the earlier "Filter to Streams: S1, S2" step (tested first,
      // in the same flow) doesn't hide them and, with them, their connectors — that would
      // confound the later connector-type-filter assertions with an unrelated cause.
      const b = store.createPart({ type: 'BusinessCapability', label: 'CtxRel', model: store.defaultModel, streams: ['S1'] });
      const c = store.createPart({ type: 'ApplicationComponent', label: 'CtxStream', model: store.defaultModel, streams: ['S1'] });
      store.createConnector({ from: a.id, to: b.id, model: store.defaultModel, connectorType: 'c', relationship: 'Association', streams: [] });
      store.createConnector({ from: a.id, to: c.id, model: store.defaultModel, connectorType: 's', relationship: 'Association', streams: ['S1'] });
      app.openOrSwitch3DView();
      const tab = store.tabs.find(t => t.type === '3d');
      await new Promise(r => setTimeout(r, 250));
      const pos = view3d.debugGetScreenPosition(tab.id, a.id);
      const initialConnectorCount = view3d.getDebugSceneInfo(tab.id).connectorCount;
      return { pos, initialConnectorCount };
    }
    """)
    if not setup["pos"]:
        return False, f"debugGetScreenPosition couldn't find the source part on screen: {setup}"
    if setup["initialConnectorCount"] != 2:
        return False, f"expected 2 connectors initially (1 'c' + 1 's'), got {setup['initialConnectorCount']}"

    x, y = setup["pos"]["x"], setup["pos"]["y"]
    page.mouse.click(x, y, button="right")
    page.wait_for_timeout(200)
    menu1 = js(page, "async () => [...document.querySelectorAll('.view3d-context-menu .v3d-ctx-item')].map(e => e.textContent.trim())")

    js(page, "async () => { [...document.querySelectorAll('.view3d-context-menu .v3d-ctx-item')].find(el => el.textContent.includes('Filter to Streams'))?.click(); }")
    page.wait_for_timeout(150)
    afterStreamFilter = js(page, "async () => window.dycadApp.store.tabs.find(t => t.type === '3d').activeStreams")

    page.mouse.click(x, y, button="right")
    page.wait_for_timeout(200)
    afterConnectorsOnly = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      [...document.querySelectorAll('.view3d-context-menu .v3d-ctx-item')].find(el => el.textContent.trim().endsWith('Connectors'))?.click();
      await new Promise(r => setTimeout(r, 150));
      const tab = store.tabs.find(t => t.type === '3d');
      return { connectorTypeFilter: tab.connectorTypeFilter, connectorCount: view3d.getDebugSceneInfo(tab.id).connectorCount };
    }
    """)

    page.mouse.click(x, y, button="right")
    page.wait_for_timeout(200)
    afterStreamsOnly = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      [...document.querySelectorAll('.view3d-context-menu .v3d-ctx-item')].find(el => { const t = el.textContent.trim(); return t.endsWith('Streams') && !t.includes('Filter'); })?.click();
      await new Promise(r => setTimeout(r, 150));
      const tab = store.tabs.find(t => t.type === '3d');
      return { connectorTypeFilter: tab.connectorTypeFilter, connectorCount: view3d.getDebugSceneInfo(tab.id).connectorCount };
    }
    """)

    page.mouse.click(x, y, button="right")
    page.wait_for_timeout(200)
    afterAll = js(page, """
    async () => {
      const app = window.dycadApp, store = app.store;
      const view3d = await import('./js/view3d.js');
      [...document.querySelectorAll('.view3d-context-menu .v3d-ctx-item')].find(el => el.textContent.trim().endsWith('All'))?.click();
      await new Promise(r => setTimeout(r, 150));
      const tab = store.tabs.find(t => t.type === '3d');
      return { connectorTypeFilter: tab.connectorTypeFilter, connectorCount: view3d.getDebugSceneInfo(tab.id).connectorCount };
    }
    """)

    problems = []
    if not any("Filter to Streams" in t for t in menu1):
        problems.append(f"expected the right-click menu to offer a 'Filter to Streams' item, got {menu1}")
    if not any(t.endswith("Connectors") for t in menu1):
        problems.append(f"expected a 'Connectors' connector-type option, got {menu1}")
    if not any(t.endswith("Streams") and "Filter" not in t for t in menu1):
        problems.append(f"expected a 'Streams' connector-type option, got {menu1}")
    if afterStreamFilter != ["S1", "S2"]:
        problems.append(f"expected clicking 'Filter to Streams' to set tab.activeStreams to the part's own streams ['S1','S2'], got {afterStreamFilter}")
    if afterConnectorsOnly["connectorTypeFilter"] != "c" or afterConnectorsOnly["connectorCount"] != 1:
        problems.append(f"expected picking 'Connectors' to filter to connectorType 'c' only (1 connector), got {afterConnectorsOnly}")
    if afterStreamsOnly["connectorTypeFilter"] != "s" or afterStreamsOnly["connectorCount"] != 1:
        problems.append(f"expected picking 'Streams' to filter to connectorType 's' only (1 connector), got {afterStreamsOnly}")
    if afterAll["connectorTypeFilter"] is not None or afterAll["connectorCount"] != 2:
        problems.append(f"expected picking 'All' to clear the connector-type filter (both connectors visible again), got {afterAll}")
    if problems:
        return False, "; ".join(problems) + f" (menu1: {menu1})"
    return True, "the 3D node right-click context menu offers a working Filter-to-Streams quick filter and a working Connector Type filter (All/Connectors/Streams), driven via genuine right-click mouse events"


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
      store.industryData['SectionPropagationTest'] = tree;
      store.industryTemplates['SectionPropagationTest'] = 'SFCCE';
      await commands.generateIndustry(app, 'SectionPropagationTest', null, false);

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
    check_multiselect_shows_entity_level_fields,
    check_code_summary,
    check_script_console_and_code_summary_moved_to_advanced,
    check_script_console_runs_main_function,
    check_batch_script_quickstart,
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
    check_stream_filter_select_all_exclude_all,
    check_section_filter,
    check_export_svg_includes_sections,
    check_catalog_row_copy_includes_all_part_fields,
    check_generate_industry_place_on_view_defaults_unchecked,
    check_dropdown_scrollable,
    check_sfce_catalog_page,
    check_routing_style_per_connector_type,
    check_auto_complete_streams_ui,
    check_streams_field_editable,
    check_pinned_field_dblclick_not_stolen_by_pin_icon,
    check_local_secrets_settings_split,
    check_batch_script_code_persists_with_local_settings,
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
    check_cubeorder_covers_all_elements,
    check_view3d_focus_and_zoom_jump,
    check_sfce_array_field_survives_deeper_nesting,
    check_view3d_sim_overlay,
    check_view3d_dispose_cancels_current_animation_frame,
    check_view3d_real_click_shows_panel_and_no_recenter,
    check_view3d_node_context_menu,
    check_view3d_disposed_on_full_document_load,
    check_view3d_section_boundaries,
    check_generate_industry_propagates_section_to_whole_chain,
    check_level_down_single_creates_new_part,
    check_level_down_downstream_external_placed_near_anchor,
    check_level_down_creates_composition_link,
    check_smart_check_composition_top_down,
    check_smart_check_composition_bottom_up,
    check_smart_check_node_composition_redirect,
    check_smart_check_sync_with_inventory_checkbox,
    check_prompt_sync_inventory_connector,
    check_property_panel_relationship_edit_triggers_sync_prompt,
    check_delete_offers_inventory_cleanup,
    check_add_existing_prefiltered_by_section,
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
