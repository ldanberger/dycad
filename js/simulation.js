import { ciEq, isUIDashboardType } from './state.js';
import { isSectionViewType, createSectionPlacer } from './sections.js';

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
// `new Function('ctx', store.batchScriptCode + '\n' + part.script)` (runTick, below) —
// reported directly: "Create a common script in script console example that can be
// called from any part script." Prepending store.batchScriptCode (the Script Console's
// own editable text, state.js's DEFAULT_BATCH_SCRIPT_CODE by default) means every
// function/const it defines is in scope for every part script too, so a part's own
// script can call any of them by name using its own `ctx` — see
// CommonScript_Example(ctx) (state.js), a ready-made example that logs "called by
// <type> <label> <model>" via ctx.log/ctx.part. batchScriptCode's OTHER top-level
// functions (main, BatchScript_*, dataAutoFill) reference free variables (app, store,
// ...) that aren't in scope here — calling one of THOSE from a part script would throw
// (caught by the same per-part try/catch below, same as any other script error); they
// simply sit defined-but-unused otherwise, same as in the Script Console's own
// execution. `ctx` below is the ONLY parameter a part script itself receives:
//   ctx = { part, inputs, outputs, responses, state, tick, log, logActivity, logDebug, secrets, setState, loadedFileName, findParts, currentView, defaultModel, createPart, createConnector, createNode, createNodeConnector }
//     - part: the Part record itself (id, type, label, ...)
//     - inputs: one entry per incoming connector (within this part's model) this tick —
//         { fromPartId, fromLabel, fromPartType, connector: { relationship, streams, connectorType }, value, lastGoodValue, changed }
//       `value` is the SOURCE part's raw result from ITS most recent tick — undefined
//       whenever that source produced nothing this round (no script ran, an unscripted
//       idle node, a script that omitted `value`, or a thrown error — see "value never
//       auto-holds" below, no way to tell these apart from here, and no need to: fixing
//       the sender is the sender's job, not the receiver's). `lastGoodValue` is the
//       source's own last-known-good reading — sticks at whatever it was through any
//       gap, so a script that wants the old "just keep computing with the freshest real
//       number" behavior reads THIS instead of `value`; a script that wants to notice and
//       react to a gap reads `value` and checks it for undefined. `changed` is true when
//       `lastGoodValue` just changed (deep-compared, so an object/array with the same
//       content twice in a row does NOT read as changed) — never true on tick 0.
//     - outputs (Step 42): one entry per OUTGOING connector of this part (within this
//       part's model) —
//         { toPartId, toLabel, toPartType, connector: { relationship, streams, connectorType } }
//       Purely structural, unlike inputs/responses — a script hasn't returned its own
//       `value` yet when ctx is built, and that single value gets broadcast identically
//       to every outgoing connector regardless, so there's no per-connector value to
//       expose here. Lets a script enumerate who/what it's wired to (e.g. to log every
//       connected part's type and each connector's type) without hardcoding neighbor ids.
//     - responses (Step 34): one entry per OUTGOING connector of this part whose target
//       had a pending response last tick —
//         { fromPartId, fromLabel, connector: { relationship, streams, connectorType }, value, changed }
//       fromPartId/fromLabel identify the RESPONDER (the connector's target), mirroring
//       how inputs[i].fromPartId/fromLabel identify the forward sender — a script never
//       has to hardcode which neighbor it's talking to. Unlike inputs, every entry here
//       already IS a real delivery (see `response` below — gaps are filtered out before
//       this array is built), so there's no separate lastGoodValue to expose; `changed`
//       (deep-compared) is true when this delivery's payload differs from the RESPONDER's
//       previous real delivery, skipping over any null gaps in between.
//     - state: whatever this node's own script returned as `state` last tick ({} on
//       tick 0, or after Reset) — merged with any pending ctx.setState(...) patch from a
//       previous tick's async callback (see setState below) before the script runs.
//     - tick: the current tick number (0-based).
//     - log(message): appends a timestamped line to the global Message Log tab (left
//       sidebar, below Position) — independent of the per-node/per-tick Simulation Log,
//       for whatever free-form narration a script author wants. Safe to call any number
//       of times per tick; capped at 500 total entries.
//     - logActivity(message)/logDebug(message) (Step 43): same shape/behavior as log()
//       above, writing to the sibling "Activity" and "Debug" tabs instead — three
//       independently-capped (500 each) logs in the same left-panel area, for brief
//       (Message) vs. more detailed (Activity) vs. deep/verbose (Debug) output. See
//       CommonScript_DebugOutLog(ctx) (state.js) for a shipped example that uses
//       logDebug specifically.
//     - secrets: read-only mirror of store.localSecrets (File > Load Local Secrets) —
//       for API keys etc. that should never end up in a save file, and deliberately never
//       cached to localStorage either — must be re-loaded each session. e.g.
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
//     - createPart({ type, label, model, streams, note, order, other, xIds, description,
//       script, scriptEnabled, section }): creates and returns a brand-new Part — same
//       fields/defaults as Store.createPart (state.js). `model` defaults to ctx.part.model
//       if omitted, so a script that doesn't care creates alongside itself; pass a
//       DIFFERENT model string to create cross-model (the new part just needs no
//       placement anywhere — it isn't added to any view/viewMember, same as any
//       programmatically-created Part). UNLIKE findParts, this mutates the shared
//       document — but safely with respect to THIS tick's determinism: runTick snapshots
//       parts/incoming/outgoing once at tick start, so a part created mid-tick can't
//       retroactively change this tick's own evaluation order; it simply starts
//       participating from the NEXT tick onward, same "one tick later" rule `response`
//       already follows. Throws if `type` is missing, or if store.maxScriptEntities would
//       be exceeded (doc.parts.length + doc.connectors.length combined, default 5000,
//       user-configurable via File > Load Local Settings) — a script that creates
//       something every tick with no guard will hit this fast under continuous Run, by
//       design; guard with ctx.state (see the example script below) if that's not wanted.
//     - createConnector({ from, to, model, connectorType, relationship, streams, note }):
//       creates and returns a brand-new Connector between two EXISTING part ids (from a
//       prior createPart call, or ctx.findParts, or hand-known ids) — same
//       fields/defaults as Store.createConnector. `model` defaults to ctx.part.model if
//       omitted. Throws if `from`/`to` don't resolve to real parts, or the
//       maxScriptEntities cap is hit. Same "takes effect next tick, not this one" rule as
//       createPart.
//     - createNode({ objectId, view, x, y, fillColor, note, order }): places an EXISTING
//       Part (from a prior createPart call, ctx.findParts, or a hand-known id) onto a
//       view as a visible node — a Part on its own (as createPart makes it) has no
//       viewMember and so never appears on any canvas until something places it, same as
//       any programmatically-created Part elsewhere in the app. `view` defaults to
//       ctx.currentView if omitted; throws if neither resolves to a real view (e.g. no
//       view is open and none was passed). Find-or-create: if the part already has a
//       node on that view, returns the EXISTING viewMember unchanged rather than adding a
//       duplicate — safe to call every tick with the same (objectId, view) pair. `x`/`y`
//       are a DESIRED position only (default 0,0) — actually placed via the same
//       overlap-avoiding search every other placement path in this app uses, so it won't
//       land exactly there if something's already occupying that spot; ignored entirely
//       on a section-based view, which places into its own grid instead (matching
//       Generate Stream's own section-view placement). Does NOT create connector edges —
//       use createConnector for the underlying relationship and createNodeConnector to
//       show it on a view. No entity-count cap of its own (unlike createPart/
//       createConnector) — find-or-create already makes repeated calls for the same
//       part/view a no-op, and the worst case (placing many distinct pre-existing parts
//       in one pass) is bounded by how many parts already exist, not runaway per-tick
//       growth.
//     - createNodeConnector({ objectId, view, note, order }): places an EXISTING
//       Connector (from a prior createConnector call, or a hand-known id) onto a view as
//       a visible edge between its two endpoint parts' CURRENT nodes on that view — a
//       Connector on its own (as createConnector makes it) has no viewMember and so never
//       draws a line on any canvas until something places it. `view` defaults to
//       ctx.currentView if omitted, same rule as createNode. Both endpoint parts MUST
//       already have a node on that view (place them first with createNode) — throws
//       naming whichever endpoint ("from", "to", or both) is missing one, rather than
//       silently skipping or drawing a misleading edge to the wrong place; this mirrors
//       Auto-Complete Streams' own fix (a connector should only ever exist between
//       positions that genuinely both resolved, never bridged/guessed). Find-or-create:
//       returns the EXISTING edge unchanged if this connector already has one on this
//       view, same as createNode.
//     - ui: { UITextInput, UITextOutput, UINumericInput, UINumericOutput } — the "UI
//       dashboard elements" feature (a new element group for simple sim-driven
//       dashboards; see isUIDashboardType, state.js). UITextInput/UINumericInput are
//       plain objects to READ, keyed by each bound widget's own current LABEL (a
//       UITextInput/UINumericInput Part whose own `uiTargetPartId` field points at
//       THIS part) — the value is whatever's currently in that widget's own "Value"
//       property field, e.g. `ctx.ui.UINumericInput['Discount %']`. UITextOutput/
//       UINumericOutput are plain objects to WRITE INTO (mutating one, e.g.
//       `ctx.ui.UINumericOutput['Total Cost'] = 108;` — NOT reassigning a bare
//       variable, which a script's own local reassignment could never make visible
//       back to the engine) — every UITextOutput/UINumericOutput widget whose own
//       `uiTargetPartId` points at THIS part, keyed the same way by that WIDGET's own
//       label, picks up whatever this script wrote under its label this tick, shown
//       as that widget's own value badge (canvas.js) — not carried over: a label this
//       script doesn't address this tick reads as `null` on its widget next tick,
//       same "fresh every tick" rule `response`/`badge` already follow. Binding is a
//       plain document field (uiTargetPartId), not a connector — deliberately, so a
//       widget can bind across models (see Model Copy's own design comment,
//       commands.js, for why that's a supported scenario) without needing a real edge
//       in the graph at all. A binding with no matching widget just does nothing
//       (silent, both directions); a widget bound to a part whose script never runs
//       (unscripted, disabled, or simply never addresses that label) reads/shows null.
//   Must return { value, state, response, leftBadge, rightBadge } — response,
//   leftBadge, and rightBadge are all optional (see below), or the
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
// leftBadge / rightBadge (script-controlled, freeform — renamed/added, Step 41): a
// script may return `rightBadge: { text, color }` to drive a SECOND, independent badge
// on the node (bottom-right, right-aligned) — full script control over both text and
// any CSS color, gated by its own view toggle (chkShowScriptBadge), distinct from
// chkShowSimValues. `rightBadge` is the exact same field previously called `badge`
// (renamed for symmetry with the new `leftBadge`); nothing else about it changed.
// `leftBadge: { text, color }` is its new sibling for the bottom-left badge — the SAME
// slot the auto-computed value badge already occupies (chkShowSimValues), not a third
// badge position. When a script returns `leftBadge` this tick, its `text` (and
// `color`, if given) is shown there INSTEAD of the auto-formatted `value` — useful once
// `value` itself is a rich object that doesn't make a good short badge string on its
// own. Omitting `leftBadge` falls straight back to the existing auto-computed display
// (`formatSimValue(value)`), so this is purely additive — no existing script needs to
// change. Both badges are computed fresh from the script's return every tick, same as
// value/state/response — NOT carried over automatically; a script that wants either to
// keep showing simply returns the same object again (the script already runs every
// tick regardless, so this is no extra burden), and a script that omits one this tick
// has nothing script-driven shown for it this tick (rightBadge shows nothing at all;
// leftBadge falls back to the value display, as above).
//
// value never auto-holds (Step 35): a node's raw `value` this tick is undefined unless
// something actually produced one THIS tick — a script that returned `value` (or
// returned nothing = script omitted it = undefined), or an unscripted node with exactly
// one incoming connector passing that connector's own (possibly-also-undefined) value
// straight through. Nodes with no script and not exactly one incoming connector sit
// idle: undefined every tick, nothing to pass through. This applies uniformly to a
// thrown script error too — errors are NOT hidden from downstream: the node's `value`
// this tick is undefined, same as any other gap, its badge shows "ERR" (the visible
// fault signal, at the source), and the error is recorded on that tick's runtime entry
// and appended to the simulation log; every other part in the model still runs normally
// that tick. `state` is unaffected either way — it only ever changes when a script
// explicitly returns a new one.
//
// This is deliberate: the engine no longer decides on a script's behalf whether a gap
// should be papered over. Every runtime entry ALSO carries `lastGoodValue` — the last
// value that was actually defined, held across any number of gap ticks — so a consuming
// script can still get the old "keep computing with whatever's freshest" behavior by
// reading `lastGoodValue` instead of `value`, entirely at its own discretion (see
// ctx.inputs[i], above). The node's own badge (canvas.js) shows raw `value` — it blanks
// the instant a tick returns nothing, same transparency as everywhere else — UNLESS the
// script also returned `leftBadge` this tick, which takes over the display entirely
// (see leftBadge/rightBadge, above). Only the "ERR" overlay (drawn from `lastError`)
// always wins regardless of either — a broken node is worth flagging differently from
// one that's simply idle or between real readings, and `leftBadge` is never set on an
// error tick anyway (the script threw before its return value was ever read).
//
// Each runtime entry also carries `changed` (Step 33, revised under Step 35): true when
// `lastGoodValue` just changed from what it was — a DEEP comparison, so an object/array
// with identical content on consecutive real deliveries does not read as changed — never
// true on tick 0. Responses get the analogous `lastGoodResponse`/internal comparison,
// which is what backs `ctx.responses[i].changed` above. Drives a distinct badge visual
// state in canvas.js, separate from the error state — useful for spotting at a glance
// when a node (e.g. one polling an external API) just received new data.

const pendingStateUpdates = new Map(); // partId -> patch object, applied at the start of the next tick that part runs in

function ensureRuntime(store, modelName) {
  if (!store.simRuntime.has(modelName)) store.simRuntime.set(modelName, { tick: 0, values: new Map() });
  if (!store.simLog.has(modelName)) store.simLog.set(modelName, []);
  return store.simRuntime.get(modelName);
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Deep, order-sensitive-for-arrays equality used for Step 35's changed-flag
 * comparisons — a fast reference check first, then a recursive structural compare for
 * objects/arrays so a script returning a fresh object/array with identical content each
 * tick doesn't read as "changed" every time. Primitives fall through to the initial ===
 * (so NaN !== NaN here, same as everywhere else in JS — not worth special-casing). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/** Shared by pushMessageLog/pushActivityLog/pushDebugLog below (Step 43) — appends to
 * whichever of the left panel's three log tabs `arrayName` names, capped at 500 entries
 * each, independently. */
function pushLog(store, arrayName, message) {
  const arr = store[arrayName];
  arr.push({ ts: Date.now(), message: String(message) });
  if (arr.length > 500) arr.splice(0, arr.length - 500);
}

/** Appends a message to the global Message Log (left panel, "Message" tab) — for brief,
 * at-a-glance messages. Exposed to scripts as ctx.log(...) — see runTick below. */
function pushMessageLog(store, message) {
  pushLog(store, 'messageLog', message);
}

/** Appends to the Activity Log (left panel, "Activity" tab, Step 43) — for more detailed
 * blow-by-blow narration than the Message Log. Exposed to scripts as
 * ctx.logActivity(...) — see runTick below. */
function pushActivityLog(store, message) {
  pushLog(store, 'activityLog', message);
}

/** Appends to the Debug Log (left panel, "Debug" tab, Step 43) — for deep, verbose dumps
 * too noisy for the other two tabs (e.g. CommonScript_DebugOutLog's full pretty-printed
 * per-input values). Exposed to scripts as ctx.logDebug(...) — see runTick below. */
function pushDebugLog(store, message) {
  pushLog(store, 'debugLog', message);
}

/** Exposed to scripts as ctx.findParts({ type, model }) — see the script-contract comment
 * at the top of this file. Both filters optional; case-insensitive, matching every other
 * type/model comparison in this codebase. */
function findPartsForScript(store, query) {
  const { type, model } = query || {};
  return store.doc.parts.filter((p) => (!type || ciEq(p.type, type)) && (!model || ciEq(p.model, model)));
}

/** Exposed to scripts as ctx.ui.UITextInput/ctx.ui.UINumericInput (read) and
 * ctx.ui.UITextOutput/ctx.ui.UINumericOutput (write) — see runTick's own ctx.ui
 * comment, below, for the full design. Builds the READ side: every UI widget of
 * `type` bound to `targetPartId` (its own uiTargetPartId field — NOT a connector,
 * deliberately, see commands.js's copyModel comment for why cross-model binding is a
 * supported scenario this can't route through the connector graph), keyed by the
 * widget's own current label so multiple bound widgets of the same type never
 * collide into one scalar. A widget's "value" is just a plain, always-current
 * document field (part.uiInputValue) — not simulation-computed, so no per-model
 * runtime lookup is needed here at all, unlike the write side below. */
function collectUIInputs(store, targetPartId, type) {
  const obj = {};
  for (const p of store.doc.parts) {
    if (ciEq(p.type, type) && p.uiTargetPartId === targetPartId) obj[p.label] = p.uiInputValue ?? null;
  }
  return obj;
}

/** Builds the WRITE side: queues one pending runtime-entry write per UI Output widget
 * (of `type`) bound to `sourcePartId`, keyed by the widget's own label against
 * whatever the script wrote into `writtenObj` this tick — a widget the script didn't
 * address this tick gets `undefined` (Step 34's response/badge already establish
 * this "fresh every tick, not carried over automatically" rule; this follows the
 * same one — reported directly as "it stays as null or similar," and `undefined` is
 * the "or similar" that makes canvas.js's own formatSimValue render it as the same
 * "—" placeholder an entirely absent entry already gets, e.g. after a thrown script
 * error — one consistent "nothing to show" visual regardless of which of the two
 * caused it). Still queued (never skipped) even when unaddressed, unlike the error
 * path below, which skips queueing entirely — this one distinction matters for a
 * bound widget living in a DIFFERENT model than sourcePartId's own: without an
 * explicit write every successful tick, a stale value from some earlier tick would
 * sit untouched in that other model's own runtime map (which THIS tick never
 * otherwise touches), silently breaking "not carried over" for exactly the
 * cross-model case this feature is built to support. Queued rather than written
 * directly into runtime.values/nextValues, since that bound widget can be in a
 * DIFFERENT model than sourcePartId's own (deliberately supported) — writing there
 * immediately would either leak into the CURRENT model's own mid-tick "last
 * committed snapshot" (which every other part's ctx.inputs this same tick reads
 * from — the single-commit-per-tick guarantee this whole engine is built on) or,
 * for a same-model widget, race the loop that's still processing other parts.
 * runTick applies every queued write once, after its own model's commit. */
function queueUIOutputWrites(store, sourcePartId, type, writtenObj, queue) {
  for (const p of store.doc.parts) {
    if (!ciEq(p.type, type) || p.uiTargetPartId !== sourcePartId) continue;
    const value = Object.prototype.hasOwnProperty.call(writtenObj, p.label) ? writtenObj[p.label] : undefined;
    queue.push({ widgetId: p.id, widgetModel: p.model, value });
  }
}

/** Shared guard for ctx.createPart/ctx.createConnector — see the script-contract comment
 * at the top of this file for the reasoning. Throws (caught by the same per-node
 * try/catch that already handles any other script error) rather than silently no-op'ing,
 * so hitting the cap is as visible as any other script failure. */
function assertUnderScriptEntityCap(store, whichFn) {
  const cap = store.maxScriptEntities;
  const count = store.doc.parts.length + store.doc.connectors.length;
  if (count >= cap) {
    throw new Error(`${whichFn}: at the parts+connectors cap (${cap}, doc currently has ${count}) — refusing to create more. Raise maxScriptEntities via File > Load Local Settings if this is intentional.`);
  }
}

function createPartForScript(store, part, spec) {
  assertUnderScriptEntityCap(store, 'ctx.createPart');
  if (!spec || !spec.type) throw new Error('ctx.createPart: "type" is required.');
  return store.createPart({
    type: spec.type, label: spec.label, model: spec.model || part.model,
    streams: spec.streams, note: spec.note, order: spec.order, other: spec.other,
    xIds: spec.xIds, description: spec.description, script: spec.script,
    scriptEnabled: spec.scriptEnabled, section: spec.section,
  });
}

function createConnectorForScript(store, part, spec) {
  assertUnderScriptEntityCap(store, 'ctx.createConnector');
  if (!spec || !spec.from || !store.findPart(spec.from)) throw new Error(`ctx.createConnector: no part found for "from" id "${spec?.from}".`);
  if (!spec.to || !store.findPart(spec.to)) throw new Error(`ctx.createConnector: no part found for "to" id "${spec.to}".`);
  return store.createConnector({
    from: spec.from, to: spec.to, model: spec.model || part.model,
    connectorType: spec.connectorType, relationship: spec.relationship,
    streams: spec.streams, note: spec.note,
  });
}

/** Exposed to scripts as ctx.createNode(spec) — see the script-contract comment at the
 * top of this file. `currentView` is store.currentView at tick start, threaded through
 * the same way `part` is for createPart/createConnector's own default-model behavior. */
function createNodeForScript(store, currentView, spec) {
  if (!spec || !spec.objectId) throw new Error('ctx.createNode: "objectId" is required (the id of an existing Part to place).');
  const target = store.findPart(spec.objectId);
  if (!target) throw new Error(`ctx.createNode: no Part found for "objectId" "${spec.objectId}" — only Parts can be placed via ctx.createNode.`);
  const viewId = spec.view || currentView;
  if (!viewId) throw new Error('ctx.createNode: no "view" given and no view is currently open — pass "view" explicitly.');
  const view = store.findView(viewId);
  if (!view) throw new Error(`ctx.createNode: view "${viewId}" not found.`);

  const existing = store.viewMembersForView(view.id).find((v) => v.objectType === 'part' && v.objectId === target.id);
  if (existing) return existing; // already placed here -> reuse, same rule createStream's own node placement follows

  let pos;
  if (isSectionViewType(view.viewType)) {
    store.ensureViewSections(view);
    pos = createSectionPlacer(store, view)(target.type);
  } else {
    const nodeW = view.nodeWidth || 130, nodeH = view.nodeHeight || 46;
    const free = store.findNonOverlappingPosition(view.id, spec.x ?? 0, spec.y ?? 0, undefined, nodeW, nodeH, view.spacingScale || 1);
    pos = { x: free.x, y: free.y, sectionId: '' };
  }
  return store.createViewMember({
    view: view.id, objectType: 'part', objectId: target.id,
    x: pos.x, y: pos.y, sectionId: pos.sectionId || '',
    fillColor: spec.fillColor, note: spec.note, order: spec.order,
  });
}

/** Exposed to scripts as ctx.createNodeConnector(spec) — see the script-contract comment
 * at the top of this file. Same `currentView` threading as createNodeForScript. */
function createNodeConnectorForScript(store, currentView, spec) {
  if (!spec || !spec.objectId) throw new Error('ctx.createNodeConnector: "objectId" is required (the id of an existing Connector to place).');
  const conn = store.findConnector(spec.objectId);
  if (!conn) throw new Error(`ctx.createNodeConnector: no Connector found for "objectId" "${spec.objectId}" — only Connectors can be placed via ctx.createNodeConnector.`);
  const viewId = spec.view || currentView;
  if (!viewId) throw new Error('ctx.createNodeConnector: no "view" given and no view is currently open — pass "view" explicitly.');
  const view = store.findView(viewId);
  if (!view) throw new Error(`ctx.createNodeConnector: view "${viewId}" not found.`);

  const existing = store.viewMembersForView(view.id).find((v) => v.objectType === 'connector' && v.objectId === conn.id);
  if (existing) return existing; // already placed here -> reuse, same find-or-create rule as createNode

  const partVms = store.viewMembersForView(view.id).filter((v) => v.objectType === 'part');
  const fromVm = partVms.find((v) => v.objectId === conn.from);
  const toVm = partVms.find((v) => v.objectId === conn.to);
  if (!fromVm || !toVm) {
    const both = !fromVm && !toVm;
    const which = both ? '"from" and "to" parts have' : `"${!fromVm ? 'from' : 'to'}" part has`;
    throw new Error(`ctx.createNodeConnector: the connector's ${which} no node on view "${view.id}" yet — place it first with ctx.createNode before adding this edge.`);
  }
  return store.createViewMember({
    view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: fromVm.id, toVmId: toVm.id,
    note: spec.note, order: spec.order,
  });
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
  const { parts: allParts, incoming, outgoing } = buildIncomingMap(store, modelName);
  // UI dashboard widgets (see isUIDashboardType, state.js) never compute their own
  // value the way an ordinary part does -- an Output widget's value is purely a SIDE
  // EFFECT of whatever OTHER part it's bound to writes via ctx.ui this tick (queued
  // below, applied once at the very end); an Input widget has no runtime entry at
  // all, just a plain document field. Excluded from the driving loop entirely so
  // neither type gets a spurious "idle/pass-through" entry from the generic
  // unscripted-part path below.
  const parts = allParts.filter((p) => !isUIDashboardType(p.type));

  const nextValues = new Map();
  const pendingUIWrites = []; // queued by queueUIOutputWrites, applied once after this model's own commit below
  for (const part of parts) {
    const inputs = (incoming.get(part.id) || []).map((e) => {
      const fromPart = store.findPart(e.fromPartId);
      const prevEntry = runtime.values.get(e.fromPartId);
      return {
        fromPartId: fromPart ? fromPart.id : null,
        fromLabel: fromPart ? fromPart.label : '',
        fromPartType: fromPart ? fromPart.type : '',
        connector: { relationship: e.connector.relationship, streams: e.connector.streams || [], connectorType: e.connector.connectorType },
        value: prevEntry ? prevEntry.value : undefined,
        lastGoodValue: prevEntry ? prevEntry.lastGoodValue : undefined,
        changed: prevEntry ? !!prevEntry.changed : false,
      };
    });

    // ctx.outputs: one entry per OUTGOING connector of this part (within this part's
    // model), purely structural -- unlike inputs/responses, there's no per-connector
    // value to expose here (a script hasn't returned its own `value` yet when ctx is
    // built, and that single value is broadcast identically to every outgoing
    // connector regardless -- see the top-of-file script-contract comment). Lets a
    // script enumerate who/what it's wired to without hardcoding neighbor ids, e.g.
    // to log each connector's type and the target part's type.
    const outputs = (outgoing.get(part.id) || []).map((e) => {
      const toPart = store.findPart(e.toPartId);
      return {
        toPartId: toPart ? toPart.id : null,
        toLabel: toPart ? toPart.label : '',
        toPartType: toPart ? toPart.type : '',
        connector: { relationship: e.connector.relationship, streams: e.connector.streams || [], connectorType: e.connector.connectorType },
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
          connector: { relationship: e.connector.relationship, streams: e.connector.streams || [], connectorType: e.connector.connectorType },
          value: prevEntry.response,
          changed: !!prevEntry.responseChanged,
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

    let resultValue; // Step 35: no auto-carry — undefined unless something sets it below
    let resultState = prevState;
    let resultResponse = null; // Step 34: fresh every tick, never carried over — only set if the script returns one THIS tick
    let resultLeftBadge = null; // script-controlled: same "fresh every tick" rule as response
    let resultRightBadge = null; // (Step 41) formerly `badge` — renamed for symmetry with leftBadge
    let lastError = null;

    if (part.scriptEnabled && part.script) {
      // ctx.ui: reported directly (a new "UI" element group for simple sim-driven
      // dashboards) — UITextInput/UINumericInput values, keyed by each bound widget's
      // own label (collectUIInputs), and two plain objects a script WRITES INTO for
      // UITextOutput/UINumericOutput (mutating an object is the only way a script's
      // local assignment can be observed after the call returns — a reassigned bare
      // variable/parameter can't be, which is why this isn't `let UINumericOutput = ...`
      // in scope the way an early proposal put it). Built fresh every tick, even for a
      // script that never references ctx.ui at all — cheap (a handful of doc.parts
      // scans, same cost class as buildIncomingMap's own filters) and keeps this
      // uniform rather than conditional on whether any widget happens to be bound.
      const uiTextOut = {};
      const uiNumericOut = {};
      const ctxUi = {
        UITextInput: collectUIInputs(store, part.id, 'UITextInput'),
        UINumericInput: collectUIInputs(store, part.id, 'UINumericInput'),
        UITextOutput: uiTextOut,
        UINumericOutput: uiNumericOut,
      };
      try {
        // Prepend the Script Console's own text (store.batchScriptCode) so every
        // function/const it defines -- CommonScript_Example, and anything else a
        // person adds alongside it -- is directly callable by name from this part's
        // own script below, using the exact same `ctx` this call already builds. See
        // this file's own top-of-file script-contract comment for the full rationale.
        const fn = new Function('ctx', `${store.batchScriptCode || ''}\n${part.script}`);
        const out = fn({
          part, inputs, outputs, responses, state: prevState, tick: runtime.tick,
          log: (message) => pushMessageLog(store, `[${part.label}] ${message}`),
          logActivity: (message) => pushActivityLog(store, `[${part.label}] ${message}`),
          logDebug: (message) => pushDebugLog(store, `[${part.label}] ${message}`),
          secrets: { ...(store.localSecrets || {}) },
          setState: (patch) => {
            const existing = pendingStateUpdates.get(part.id) || {};
            pendingStateUpdates.set(part.id, { ...existing, ...(patch || {}) });
          },
          loadedFileName: store.loadedFileName || null,
          findParts: (query) => findPartsForScript(store, query),
          currentView: store.currentView,
          defaultModel: store.defaultModel,
          createPart: (spec) => createPartForScript(store, part, spec),
          createConnector: (spec) => createConnectorForScript(store, part, spec),
          createNode: (spec) => createNodeForScript(store, store.currentView, spec),
          createNodeConnector: (spec) => createNodeConnectorForScript(store, store.currentView, spec),
          ui: ctxUi,
        }) || {};
        resultValue = out.value;
        resultState = out.state || {};
        if ('response' in out) resultResponse = out.response;
        if (out.leftBadge && typeof out.leftBadge === 'object') {
          resultLeftBadge = { text: String(out.leftBadge.text ?? ''), color: String(out.leftBadge.color || '#666666') };
        }
        if (out.rightBadge && typeof out.rightBadge === 'object') {
          resultRightBadge = { text: String(out.rightBadge.text ?? ''), color: String(out.rightBadge.color || '#666666') };
        }
        log.push({ tick: runtime.tick, partId: part.id, label: part.label, type: 'value', message: safeStringify(resultValue), ts: Date.now() });
        // Queued, not written directly — see queueUIOutputWrites' own comment for why
        // (a bound widget can be in a different model than `part`). Only queued on the
        // SUCCESS path — a thrown script error means NO write is queued at all for any
        // widget bound to `part` this tick, so it reads exactly like any other tick
        // where its label just wasn't addressed (the "—" not-set placeholder,
        // canvas.js). Widget entries never get a lastGoodValue of their own (unlike a
        // real Part's runtime entry, Step 35) — nothing reads a widget via ctx.inputs,
        // so there's no downstream to protect by tracking a fallback nobody can reach;
        // the erroring target part's OWN badge already shows "ERR" as the visible
        // signal something's wrong.
        queueUIOutputWrites(store, part.id, 'UITextOutput', uiTextOut, pendingUIWrites);
        queueUIOutputWrites(store, part.id, 'UINumericOutput', uiNumericOut, pendingUIWrites);
      } catch (err) {
        lastError = (err && err.message) ? err.message : String(err);
        log.push({ tick: runtime.tick, partId: part.id, label: part.label, type: 'error', message: lastError, ts: Date.now() });
      }
    } else if (inputs.length === 1) {
      resultValue = inputs[0].value; // pass-through default for unscripted single-input nodes
    }
    // else: idle — resultValue stays undefined this tick (Step 35: no auto-carry)

    // Step 35: lastGoodValue/lastGoodResponse persist across any number of gap ticks
    // (undefined value, thrown error, idle) — a script that wants the old "keep
    // computing with whatever's freshest" behavior reads THESE via ctx.inputs[i]/its own
    // fallback logic, instead of the engine silently choosing for it. `changed` (Step 33)
    // is now computed against this lastGood lineage (deep-compared), not the raw
    // per-tick value, so it fires exactly when real content changes and never flickers
    // on a gap tick.
    const hasNewValue = resultValue !== undefined && resultValue !== null;
    const lastGoodValue = hasNewValue ? resultValue : prevSelf?.lastGoodValue;
    const changed = prevSelf !== undefined && !deepEqual(lastGoodValue, prevSelf.lastGoodValue);

    const hasNewResponse = resultResponse !== undefined && resultResponse !== null;
    const lastGoodResponse = hasNewResponse ? resultResponse : prevSelf?.lastGoodResponse;
    const responseChanged = prevSelf !== undefined && !deepEqual(lastGoodResponse, prevSelf.lastGoodResponse);

    nextValues.set(part.id, {
      value: resultValue, lastGoodValue, state: resultState, lastError, lastTick: runtime.tick,
      changed, response: resultResponse, lastGoodResponse, responseChanged,
      leftBadge: resultLeftBadge, rightBadge: resultRightBadge,
    });
  }

  runtime.values = nextValues; // commit all outputs together, only once every part has run
  runtime.tick += 1;
  if (log.length > 500) log.splice(0, log.length - 500); // cap log growth for long runs

  // Apply every queued UI Output widget write now that THIS model's own commit is
  // done — a widget bound to a part in this SAME model lands in the runtime.values
  // map we just committed above (ensureRuntime returns that exact object); a widget
  // bound to a part in a DIFFERENT model (a deliberately supported cross-model
  // dashboard scenario) lands in that other model's own runtime instead, which this
  // tick never touched otherwise. Either way this happens strictly after the commit,
  // so it can never leak into another part's own ctx.inputs snapshot this same tick.
  for (const w of pendingUIWrites) {
    const widgetRuntime = ensureRuntime(store, w.widgetModel);
    const prevWidgetEntry = widgetRuntime.values.get(w.widgetId);
    widgetRuntime.values.set(w.widgetId, {
      value: w.value, state: {}, lastError: null, lastTick: runtime.tick - 1,
      changed: prevWidgetEntry !== undefined && w.value !== prevWidgetEntry.value,
      response: null, leftBadge: null, rightBadge: null,
    });
  }
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
    values[partId] = {
      value: entry.value, lastGoodValue: entry.lastGoodValue, state: entry.state,
      lastError: entry.lastError || null, lastGoodResponse: entry.lastGoodResponse,
    };
  }
  const snapshot = {
    kind: 'dycad-sim-snapshot', version: 3,
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
    if (snap.kind !== 'dycad-sim-snapshot') { app.toast('Not a simulation snapshot file.', true); return; }
    if (snap.model && snap.model !== modelName) {
      const proceed = await app.confirmModal(`This snapshot was recorded for model "${snap.model}", but "${modelName}" is currently selected. Load it into "${modelName}" anyway?`);
      if (!proceed) return;
    }
    const values = new Map();
    let missing = 0;
    for (const [partId, entry] of Object.entries(snap.values || {})) {
      if (!store.findPart(partId)) { missing += 1; continue; } // part no longer exists — skip, don't crash
      values.set(partId, {
        value: entry.value, lastGoodValue: entry.lastGoodValue, state: entry.state || {},
        lastError: entry.lastError || null, lastGoodResponse: entry.lastGoodResponse, lastTick: snap.tick || 0,
      });
    }
    store.simRuntime.set(modelName, { tick: snap.tick || 0, values });
    store.simLog.set(modelName, Array.isArray(snap.log) ? snap.log : []);
    app.render();
    app.toast(`Simulation snapshot loaded${missing ? ` (${missing} part${missing === 1 ? '' : 's'} no longer exist, skipped)` : ''}.`);
  } catch (err) {
    app.toast(`Snapshot load failed: ${err.message}`, true);
  }
}

export { runTick, stepSimulation, startContinuousRun, pauseContinuousRun, continueContinuousRun, stopContinuousRun, resetSimulation, saveSimSnapshot, loadSimSnapshot, pushMessageLog, pushActivityLog, pushDebugLog };
