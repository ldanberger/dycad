import { ciEq } from './state.js';

// ===================== NODE SCRIPTING / SIMULATION =====================
// Tick-based simulation engine, scoped to a MODEL (not a view). Every scripted Part in a
// model runs once per tick against a fully COMMITTED snapshot of last tick's outputs —
// new outputs are computed into a separate map and only swapped in once every part for
// this tick has run, so evaluation order within a tick never affects the result (same
// "synchronous update" model as a cellular automaton / spreadsheet recalculation pass).
// This is what lets simulations contain feedback loops/cycles without special-casing
// them.
//
// The graph is built directly from Part/Connector records belonging to one model — NOT
// from any view's viewMembers. A Part has exactly one simulated value/state at a time,
// shared across every view that happens to display it. Multiple models can be
// stepped/run independently and concurrently; nothing about execution depends on any
// tab/view being open.
//
// Runtime state (store.simRuntime, store.simLog, store.simRunning) intentionally lives
// OUTSIDE store.doc — see state.js's constructor comment — so it never touches Save/Load
// JSON. It has its own separate snapshot file format instead (see saveSimSnapshot/
// loadSimSnapshot below).
//
// Script contract: a Part's `script` field is the BODY of a function, invoked as
// `new Function('ctx', part.script)`, where:
//   ctx = { part, inputs, responses, state, tick, log, secrets, setState, loadedFileName, findParts, currentView, defaultModel }
//     - part: the Part record itself (id, type, label, ...)
//     - inputs: one entry per incoming connector (within this part's model) this tick —
//         { fromPartId, fromLabel, connector: { relationship, streams }, value }
//       `value` is undefined for any edge whose source hasn't produced a value yet
//       (always true on tick 0, since nothing has run).
//     - responses (Step 34): one entry per OUTGOING connector of this part whose target
//       had a pending response last tick —
//         { fromPartId, fromLabel, connector: { relationship, streams }, value }
//       fromPartId/fromLabel identify the RESPONDER (the connector's target), mirroring
//       how inputs[i].fromPartId/fromLabel identify the forward sender — a script never
//       has to hardcode which neighbor it's talking to. See `response` below for how
//       these get produced.
//     - state: whatever this node's own script returned as `state` last tick ({} on
//       tick 0, or after Reset) — merged with any pending ctx.setState(...) patch from a
//       previous tick's async callback (see setState below) before the script runs.
//     - tick: the current tick number (0-based).
//     - log(message): appends a timestamped line to the global Message Log panel
//       (left sidebar, below Position) — independent of the per-node/per-tick
//       Simulation Log, for whatever free-form narration a script author wants. Safe to
//       call any number of times per tick; capped at 500 total entries.
//     - secrets: read-only mirror of store.localSettings (File > Load Local Settings) —
//       for API keys etc. that should never end up in a save file. e.g.
//       ctx.secrets.OPENAI_API_KEY.
//     - setState(patch): for ASYNC work (e.g. a fetch(...) whose response arrives after
//       this tick's synchronous script call has already returned). Does NOT apply
//       immediately — merges `patch` into a per-part pending-update queue that gets
//       applied to that part's state at the START of the next tick, before any script
//       runs that tick. This preserves the "every tick's outputs commit together, once"
//       guarantee — an async write landing mid-tick, at an arbitrary moment, would break
//       it. Errors thrown inside a script's own .then()/.catch() chain are NOT caught by
//       the per-tick try/catch below (that only wraps the synchronous script call) — a
//       script must report its own async failures via log(...)/setState(...).
//     - loadedFileName (Step 34): the filename of the last file that fully replaced the
//       model (Load JSON / File > Load / File > Load Example) — null if nothing's been
//       loaded that way yet this session. Not set by Import Data, which merges rather
//       than replaces.
//     - findParts({ type, model }): read-only lookup across the WHOLE document (not just
//       this part's own model/graph) — returns every Part matching the given type and/or
//       model (both optional; omit either to not filter on it), case-insensitive, same
//       as every other type/model comparison in this codebase (ciEq). e.g.
//       ctx.findParts({ type: 'BusinessCapability', model: ctx.part.model }) to list every
//       capability in this part's own model. Returns the LIVE Part objects, not clones —
//       treat the result as read-only; mutating fields directly bypasses the tick-commit
//       model this whole engine is built on (see the top-of-file comment) and isn't part
//       of the supported contract. This formalizes what was previously only reachable
//       through the undocumented `window.dycadApp` global.
//     - currentView: store.currentView at the moment this tick started — the view id
//       currently shown in the main view selector. Read-only snapshot, same rationale as
//       loadedFileName above.
//     - defaultModel: store.defaultModel at the moment this tick started — the model new
//       parts/connectors get created into by default. Not necessarily the same as
//       ctx.part.model (a part can live in any model) or the model this simulation run is
//       currently scoped to (store.simSelectedModel, not exposed here — a script only
//       ever sees its own part's model via ctx.part.model).
//   Must return { value, state, response, badge } — response and badge are both
//   optional (see below), or the
//   whole call may throw — caught per-node, see below.
//
// response (Step 34): a SINGLE value (not a queue/history — only ever one pending
// response per part at a time) broadcast, one tick later, to every node with an outgoing
// connector INTO this part (i.e., this part's own ctx.inputs sources this tick) — every
// connector supports this backward channel, both 'c' and 's' types, always available;
// nothing flows unless a script actually returns one. Needs no separate clear-after-
// delivery step: a part's `response` is recomputed fresh from its script's return every
// tick, same as value/state, so it naturally disappears from the runtime the tick after
// it's set unless the script explicitly returns a new one.
//
// badge (script-controlled, freeform): a script may return `badge: { text, color }` to
// drive a SECOND, independent badge on the node (bottom-right, right-aligned — separate
// from the auto-computed value badge at bottom-left) — full script control over both
// text and color (any CSS color value), gated by its own view toggle
// (chkShowScriptBadge), distinct from chkShowSimValues. Computed fresh from the script's
// return every tick, same as value/state/response — NOT carried over automatically; a
// script that wants its badge to keep showing simply returns the same `badge` again
// (the script already runs every tick regardless, so this is no extra burden), and a
// script that omits `badge` this tick has no badge shown this tick.
//
// Nodes with no script (or scriptEnabled === false) pass their single input through
// unchanged if they have exactly one incoming connector, otherwise sit idle (retain
// whatever value they last held, emitting nothing new). They never produce a response.
//
// A thrown script error is caught per-node: the node keeps its LAST GOOD value/state
// (never propagates undefined downstream from a broken node), the error is recorded on
// that tick's runtime entry (surfaced as the node badge's error state) and appended to
// the simulation log; every other part in the model still runs normally that tick.
//
// Each runtime entry also carries `changed` (Step 33): true when this tick's value
// differs from last tick's (never true on tick 0, since there's no previous value yet).
// Drives a distinct badge visual state in canvas.js, separate from the error state —
// useful for spotting at a glance when a node (e.g. one polling an external API) just
// received new data.

const pendingStateUpdates = new Map(); // partId -> patch object, applied at the start of the next tick that part runs in

function ensureRuntime(store, modelName) {
  if (!store.simRuntime.has(modelName)) store.simRuntime.set(modelName, { tick: 0, values: new Map() });
  if (!store.simLog.has(modelName)) store.simLog.set(modelName, []);
  return store.simRuntime.get(modelName);
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Appends a message to the global Message Log (left panel), capped at 500 entries.
 * Exposed to scripts as ctx.log(...) — see runTick below. */
function pushMessageLog(store, message) {
  store.messageLog.push({ ts: Date.now(), message: String(message) });
  if (store.messageLog.length > 500) store.messageLog.splice(0, store.messageLog.length - 500);
}

/** Exposed to scripts as ctx.findParts({ type, model }) — see the script-contract comment
 * at the top of this file. Both filters optional; case-insensitive, matching every other
 * type/model comparison in this codebase. */
function findPartsForScript(store, query) {
  const { type, model } = query || {};
  return store.doc.parts.filter((p) => (!type || ciEq(p.type, type)) && (!model || ciEq(p.model, model)));
}

/** modelName -> { parts, incoming: Map<partId, [{fromPartId, connector}]>,
 * outgoing: Map<partId, [{toPartId, connector}]> } for the CURRENT graph of that model —
 * every connector belonging to that model (both 'c' and 's' types) counts as a
 * simulation edge, per the agreed scope. No viewMember indirection at all — this reads
 * store.doc.parts/connectors directly. `outgoing` (Step 34) is used to compute each
 * part's ctx.responses, mirroring how `incoming` is used for ctx.inputs. */
function buildIncomingMap(store, modelName) {
  const parts = store.doc.parts.filter((p) => p.model === modelName);
  const conns = store.doc.connectors.filter((c) => c.model === modelName);
  const incoming = new Map();
  const outgoing = new Map();
  for (const p of parts) { incoming.set(p.id, []); outgoing.set(p.id, []); }
  for (const c of conns) {
    if (incoming.has(c.to)) incoming.get(c.to).push({ fromPartId: c.from, connector: c });
    if (outgoing.has(c.from)) outgoing.get(c.from).push({ toPartId: c.to, connector: c });
  }
  return { parts, incoming, outgoing };
}

/** Runs exactly one tick for the given model. Pure runtime-state mutation — does not
 * touch store.doc, does not call app.recordAndRender() (callers re-render via app.render()
 * only, so ticking never pollutes undo/redo history). */
function runTick(app, modelName) {
  const { store } = app;
  if (!modelName) return;
  const runtime = ensureRuntime(store, modelName);
  const log = store.simLog.get(modelName);
  const { parts, incoming, outgoing } = buildIncomingMap(store, modelName);

  const nextValues = new Map();
  for (const part of parts) {
    const inputs = (incoming.get(part.id) || []).map((e) => {
      const fromPart = store.findPart(e.fromPartId);
      const prevEntry = runtime.values.get(e.fromPartId);
      return {
        fromPartId: fromPart ? fromPart.id : null,
        fromLabel: fromPart ? fromPart.label : '',
        connector: { relationship: e.connector.relationship, streams: e.connector.streams || [] },
        value: prevEntry ? prevEntry.value : undefined,
      };
    });

    // Step 34: responses — walk THIS part's own OUTGOING connectors and read each
    // target's last-committed `response`, same "read from last tick's snapshot" rule as
    // inputs above. Only included when the target actually had one pending.
    const responses = (outgoing.get(part.id) || [])
      .map((e) => {
        const toPart = store.findPart(e.toPartId);
        const prevEntry = runtime.values.get(e.toPartId);
        if (!prevEntry || prevEntry.response === undefined || prevEntry.response === null) return null;
        return {
          fromPartId: toPart ? toPart.id : null,
          fromLabel: toPart ? toPart.label : '',
          connector: { relationship: e.connector.relationship, streams: e.connector.streams || [] },
          value: prevEntry.response,
        };
      })
      .filter((r) => r !== null);

    const prevSelf = runtime.values.get(part.id);
    let prevState = prevSelf?.state || {};
    // apply any pending async ctx.setState(...) patch from a previous tick's callback,
    // BEFORE this tick's script call — this is the "next tick" landing point promised
    // to setState() callers.
    if (pendingStateUpdates.has(part.id)) {
      prevState = { ...prevState, ...pendingStateUpdates.get(part.id) };
      pendingStateUpdates.delete(part.id);
    }

    let resultValue = prevSelf?.value;
    let resultState = prevState;
    let resultResponse = null; // Step 34: fresh every tick, never carried over — only set if the script returns one THIS tick
    let resultBadge = null; // script-controlled badge: same "fresh every tick" rule as response
    let lastError = null;

    if (part.scriptEnabled && part.script) {
      try {
        const fn = new Function('ctx', part.script);
        const out = fn({
          part, inputs, responses, state: prevState, tick: runtime.tick,
          log: (message) => pushMessageLog(store, `[${part.label}] ${message}`),
          secrets: { ...(store.localSettings || {}) },
          setState: (patch) => {
            const existing = pendingStateUpdates.get(part.id) || {};
            pendingStateUpdates.set(part.id, { ...existing, ...(patch || {}) });
          },
          loadedFileName: store.loadedFileName || null,
          findParts: (query) => findPartsForScript(store, query),
          currentView: store.currentView,
          defaultModel: store.defaultModel,
        }) || {};
        resultValue = out.value;
        resultState = out.state || {};
        if ('response' in out) resultResponse = out.response;
        if (out.badge && typeof out.badge === 'object') {
          resultBadge = { text: String(out.badge.text ?? ''), color: String(out.badge.color || '#666666') };
        }
        log.push({ tick: runtime.tick, partId: part.id, label: part.label, type: 'value', message: safeStringify(resultValue), ts: Date.now() });
      } catch (err) {
        lastError = (err && err.message) ? err.message : String(err);
        log.push({ tick: runtime.tick, partId: part.id, label: part.label, type: 'error', message: lastError, ts: Date.now() });
      }
    } else if (inputs.length === 1) {
      resultValue = inputs[0].value; // pass-through default for unscripted single-input nodes
    }
    // else: idle — resultValue stays at prevSelf?.value (or undefined pre-tick-0)

    // Step 33: track whether this part's value actually changed since last tick — only
    // meaningful once there IS a previous tick (never flags "changed" on tick 0), used to
    // drive a distinct badge visual state (canvas.js) separate from the error state.
    const changed = prevSelf !== undefined && resultValue !== prevSelf.value;

    nextValues.set(part.id, { value: resultValue, state: resultState, lastError, lastTick: runtime.tick, changed, response: resultResponse, badge: resultBadge });
  }

  runtime.values = nextValues; // commit all outputs together, only once every part has run
  runtime.tick += 1;
  if (log.length > 500) log.splice(0, log.length - 500); // cap log growth for long runs
}

/** Shared tick-loop step, used by both startContinuousRun and continueContinuousRun so
 * the timer-chaining logic only exists in one place. Reads intervalMs/paused fresh from
 * the entry each call rather than closing over them, so a pause mid-flight (which clears
 * timerId but leaves the entry in place) is picked up correctly whenever the loop is
 * later resumed. */
function tickLoop(app, modelName) {
  const { store } = app;
  const entry = store.simRunning.get(modelName);
  if (!entry || entry.paused) return; // stopped or paused mid-flight
  runTick(app, modelName);
  app.render();
  entry.timerId = setTimeout(() => tickLoop(app, modelName), entry.intervalMs);
}

function stepSimulation(app, modelName) {
  if (!modelName) return;
  runTick(app, modelName);
  app.render();
}

function startContinuousRun(app, modelName, intervalMs = 500) {
  const { store } = app;
  if (!modelName || store.simRunning.has(modelName)) return;
  store.simRunning.set(modelName, { timerId: null, intervalMs, paused: false });
  tickLoop(app, modelName);
  app.toast(`Simulation running for "${modelName}" (every ${intervalMs}ms) — Stop Simulation to halt.`);
}

/** Step 38: pause an in-progress run without ending it — the entry stays in
 * store.simRunning (so Run's "active" indicator keeps showing, and Stop/Reset still see
 * it as a live session) but its timer stops firing. Step Simulation already works
 * regardless of running/paused state, so the user can step manually while paused. */
function pauseContinuousRun(app, modelName) {
  const { store } = app;
  const entry = modelName && store.simRunning.get(modelName);
  if (!entry || entry.paused) return;
  if (entry.timerId) clearTimeout(entry.timerId);
  entry.timerId = null;
  entry.paused = true;
  app.toast(`Simulation paused for "${modelName}".`);
  app.render();
}

/** Resumes a paused run at its original interval — no re-prompting, no restart. */
function continueContinuousRun(app, modelName) {
  const { store } = app;
  const entry = modelName && store.simRunning.get(modelName);
  if (!entry || !entry.paused) return;
  entry.paused = false;
  tickLoop(app, modelName);
  app.toast(`Simulation continuing for "${modelName}".`);
}

function stopContinuousRun(app, modelName) {
  const { store } = app;
  if (!modelName) return;
  const entry = store.simRunning.get(modelName);
  if (!entry) return;
  if (entry.timerId) clearTimeout(entry.timerId);
  store.simRunning.delete(modelName);
  app.toast(`Simulation stopped for "${modelName}".`);
  app.render();
}

function resetSimulation(app, modelName) {
  if (!modelName) return;
  const { store } = app;
  stopContinuousRun(app, modelName);
  store.simRuntime.delete(modelName);
  store.simLog.delete(modelName);
  app.render();
  app.toast(`Simulation reset for "${modelName}".`);
}

// ===================== SNAPSHOT SAVE / LOAD =====================
// Separate file from Save/Load JSON's onestream.json format — this captures a point-in-
// time simulation run (tick count, every part's current value/state, and the log) for
// one model, so it can be archived or resumed later, without conflating runtime state
// with model data.
function saveSimSnapshot(app, modelName) {
  const { store } = app;
  if (!modelName) return;
  const runtime = store.simRuntime.get(modelName);
  if (!runtime || runtime.values.size === 0) {
    app.toast('Nothing to save — step or run the simulation first.', true);
    return;
  }
  const values = {};
  for (const [partId, entry] of runtime.values) {
    values[partId] = { value: entry.value, state: entry.state, lastError: entry.lastError || null };
  }
  const snapshot = {
    kind: 'dycad-sim-snapshot', version: 2,
    tick: runtime.tick, timestamp: new Date().toISOString(),
    model: modelName,
    values, log: store.simLog.get(modelName) || [],
  };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dycad-sim-${modelName}-tick${runtime.tick}.json`;
  a.click();
  URL.revokeObjectURL(url);
  app.toast('Simulation snapshot saved.');
}

async function loadSimSnapshot(app, modelName, file) {
  const { store } = app;
  if (!modelName) return;
  try {
    const text = await file.text();
    const snap = JSON.parse(text);
    // Accepts the pre-rebrand 'flowrun-sim-snapshot' kind too, so snapshots saved
    // before the DyCAD rename still load correctly rather than being rejected outright.
    if (snap.kind !== 'dycad-sim-snapshot' && snap.kind !== 'flowrun-sim-snapshot') { app.toast('Not a simulation snapshot file.', true); return; }
    if (snap.model && snap.model !== modelName) {
      const proceed = await app.confirmModal(`This snapshot was recorded for model "${snap.model}", but "${modelName}" is currently selected. Load it into "${modelName}" anyway?`);
      if (!proceed) return;
    }
    const values = new Map();
    let missing = 0;
    for (const [partId, entry] of Object.entries(snap.values || {})) {
      if (!store.findPart(partId)) { missing += 1; continue; } // part no longer exists — skip, don't crash
      values.set(partId, { value: entry.value, state: entry.state || {}, lastError: entry.lastError || null, lastTick: snap.tick || 0 });
    }
    store.simRuntime.set(modelName, { tick: snap.tick || 0, values });
    store.simLog.set(modelName, Array.isArray(snap.log) ? snap.log : []);
    app.render();
    app.toast(`Simulation snapshot loaded${missing ? ` (${missing} part${missing === 1 ? '' : 's'} no longer exist, skipped)` : ''}.`);
  } catch (err) {
    app.toast(`Snapshot load failed: ${err.message}`, true);
  }
}

export { runTick, stepSimulation, startContinuousRun, pauseContinuousRun, continueContinuousRun, stopContinuousRun, resetSimulation, saveSimSnapshot, loadSimSnapshot, pushMessageLog };
