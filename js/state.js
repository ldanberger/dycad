// state.js — central store for DyCAD.

/** Store.batchScriptCode's out-of-the-box default — the Script Console's Run button
 * calls whatever top-level `main()` this text defines (see App.promptScriptConsole,
 * main.js), which can in turn call any number of other functions defined alongside it.
 * This one gives a working starting point: main() calling five starter batch scripts
 * in sequence — BatchScript_QuickStart(), which builds a basic Business Functions
 * organization view from the built-in default industry data end to end (ending with
 * the 3D View); BatchScript_InsertSmartStreamExample(), which traces a Smart Stream
 * from data QuickStart itself just generated; BatchScript_SmartCheckViewExample(),
 * which runs Smart Check View on that same view with "Missing connectors" and
 * "Derive hidden connections" checked; BatchScript_RemapExample(), which remaps that
 * same Smart Stream view with both layout-optimization checkboxes; then, last,
 * BatchScript_InsertSmartStreamExample2() — an otherwise-identical second Insert Smart
 * Stream call with a broader showTypes list, but building its own SEPARATE "Smart
 * Stream Example 2" view rather than topping up the first one — after which main()
 * logs a reminder (with the exact settings) for a person to run Smart Check View and
 * Remap on that new view interactively, rather than auto-running them itself. Naming
 * convention for future additions: `BatchScript_<Name>`, so main() can pick and choose
 * which one(s) to run without renaming anything.
 *
 * `dataAutoFill()` (below, after the BatchScript_* functions) is a different
 * kind of entry point: it's invoked directly by the Data Modeling > Autofill menu item
 * (App.promptAutofill, main.js) by name, NOT through main() — main() unconditionally
 * chaining it would break on a fresh document with no Data Entity Details tables yet.
 * It's still edited/persisted exactly like everything else here (Script Console,
 * store.batchScriptCode, Local Settings).
 *
 * `CommonScript_Example()` (below, after dataAutoFill) is a THIRD kind of entry point,
 * reported directly: "Create a common script in script console example that can be
 * called from any part script." Every function/const defined ANYWHERE in this text is
 * automatically in scope inside every PART's own script too (a Part's Script property
 * field, run once per simulation tick) — runTick (simulation.js) prepends this whole
 * text ahead of a part's script before compiling it, so CommonScript_Example is
 * callable BY NAME from any part's own script, using that script's own `ctx`. Naming
 * convention for future additions meant to be called this way: `CommonScript_<Name>`.
 * `CommonScript_DebugOutLog()` (below, right after `CustomRemap_Example`) is a second
 * example of this same kind, reported directly: meant to be called from (or copied
 * into) any part's script — dumps `ctx.inputs` verbatim as one compact-JSON line to the
 * new Debug Log tab (`ctx.logDebug`, see the three-tab Log area below), bracketed by
 * '-i--'/'-e--' marker lines. `CommonScript_GenericPartActions(ctx, opts)` (below,
 * right after `CommonScript_DebugOutLog`, placed last — replaces the old
 * per-relationship-only `CommonScript_Sim`, direct follow-up: "move the generic
 * scripts from each part to one script ... with parameters as needed ... make
 * simulation available by default for all files") is a third example of this same
 * kind, and also the new OUT-OF-THE-BOX DEFAULT for every Part's own `script` field
 * (see Store.createPart/migrateDoc below) — a single generic request/response
 * dispatcher driven entirely by `ctx.part.type` (an INITIATOR that originates a fresh
 * request every tick, a RESPONDER that terminates a request with a reply instead of
 * relaying it, or — the default — a PASSTHROUGH that relays both directions) and each
 * connector's own `relationship` (which action label a RESPONDER's reply gets), using
 * only `connectorType: 'c'` connectors and `ctx.part.rawLabel` as every packet's
 * subject. Every new Part ships with `scriptEnabled: false` and `script: 'return
 * CommonScript_GenericPartActions(ctx);'` — simulation-ready the moment a person
 * flips Script Enabled on, with `opts` (an optional second argument: `initiatorTypes`/
 * `responderTypes`/`relationshipActions`) letting a script override just the
 * classification without forking the whole function, and a person's own bespoke
 * script remains a straight overwrite of that one-line default, same as always.
 *
 * `CustomRemap_Example()` (below, after CommonScript_Example) is a FOURTH kind of
 * entry point, reported directly: "is it possible to build a small framework for user
 * designed remap logic, something that can be loaded in and stored in user local
 * settings perhaps." Picked interactively from the Remap dialog's Pattern dropdown
 * ("custom" reveals a second dropdown listing every `CustomRemap_<Name>` function
 * found here) — `applyRemapLayout` (commands.js) extracts and calls the chosen one by
 * name, passing a `ctx` with the view's current parts/connectors, node size, and a
 * grid-coordinate convenience layer (`ctx.gridToXY`/`setRowGap`/`setColGap`) as an
 * alternative to hand-computed canvas pixels. Naming convention for future additions
 * meant to be selectable this way: `CustomRemap_<Name>`. */
const DEFAULT_BATCH_SCRIPT_CODE = `// main() is what the Script Console's Run button actually calls. Define whatever
// batch scripts you like below, and have main() call whichever one(s) you want to run.
async function main() {
  await BatchScript_QuickStart();
  // Runs after BatchScript_QuickStart's own 3D View step above.
  await BatchScript_InsertSmartStreamExample();
  await BatchScript_SmartCheckViewExample();
  await BatchScript_RemapExample();
  await BatchScript_InsertSmartStreamExample2();
  messageLog('################################# example 2 created, now run smart check view (missing connectors; derive connectors) and ############## remap (enterprise; layered; minimum crossings; minimum connector length; connectorOrder, streamOrder, streamName, entityType, nodeLevel, elementGroup) #################################');
  return;
}

// A starter batch script: builds a basic Business Functions organization view from the
// built-in default industry data, ready to look at with one click.
async function BatchScript_QuickStart() {
  // Generate Industry (Advanced menu), the built-in default industry data -- parts/
  // connectors only, not placed on any view (Populate From Template below does the
  // placing).
  await generateIndustry(app, null, false);

  // New view: "Business Functions", type "Business Function Organization".
  const view = store.addView('Business Functions', 'org');
  const tab = app.createCanvasTab(view);
  app.switchToTab(tab.id);

  // Populate From Template, default "Enterprise Functions".
  populateFromTemplate(app, tab, 'Enterprise Functions');

  // Mainstream Operational Functions section defaults to 2 rows -- 1 is enough here.
  const mof = (view.sections || []).find((s) => s.sectionId === 'mof');
  if (mof) mof.rowCount = 1;

  // Zoom out a bit so the whole thing is visible at a glance.
  tab.viewport.zoom = 0.6;

  remap(app, tab, { pattern: 'default' });

  app.recordAndRender();

  // Show it in 3D too.
  app.openOrSwitch3DView();

  messageLog('Done');
}

// Example: Insert Smart Stream called directly with explicit options (same shape the
// dialog builds from the user's picks -- see promptInsertSmartStream in main.js).
// Called by main() above, after BatchScript_QuickStart. Depends on a Business Function
// named "Production", which BatchScript_QuickStart's default industry data creates
// (adjust the label/types below to match your own model if you remove that call).
// BatchScript_InsertSmartStreamExample2 below is an otherwise-identical second pass
// with a broader showTypes list, run by main() at the very end -- on its OWN separate
// "Smart Stream Example 2" view, not this one.
async function BatchScript_InsertSmartStreamExample() {
  let tab = store.activeTab();
  if (!tab || tab.type !== 'canvas' || store.findView(tab.viewId)?.viewType !== 'ff') {
    const view = store.addView('Smart Stream Example', 'ff');
    tab = app.createCanvasTab(view);
    app.switchToTab(tab.id);
  }

  const start = findParts({ type: 'BusinessFunction', model: store.defaultModel }).find((p) => p.label === 'Production');
  if (!start) { log('No Business Function named "Production" found in model "' + store.defaultModel + '".'); return; }

  // connectorType 's' (Stream), not 'c' (Connector) -- 'c' also carries every generated
  // stream's parallel "companion"/inventory relationship AND the section-reification
  // BusinessOrganizationUnit -> BusinessFunction Assignment edges (see commands.js's
  // createStream), and since the default industry data now genuinely tags every
  // function with a real Section, walking 'c' from Production fans out through its
  // shared OrgUnit into every OTHER function in the same Section too -- 's' is the
  // network createStream itself builds one stream at a time, so it stays scoped to
  // Production's own chain, matching this example's actual intent.
  insertSmartStream(app, tab, {
    connectorType: 's',
    startPartIds: [start.id],
    direction: 'both',
    endType: 'DataDataEntity',
    levels: null,
    showTypes: ['ApplicationCapability', 'BusinessFunction', 'BusinessProcess', 'BusinessCapability', 'DataDataEntity', 'GeneralActor', 'TechnologyLogicalComponent'],
  });

  app.recordAndRender();
  messageLog('Insert Smart Stream example done');
}

// Example: a second Insert Smart Stream call, run by main() LAST -- after
// BatchScript_RemapExample has already finished laying out the first "Smart Stream
// Example" view. Otherwise identical to BatchScript_InsertSmartStreamExample above
// (same start part, same options) except for a broader showTypes list, but always
// builds its own SEPARATE "Smart Stream Example 2" view rather than topping up the
// first one -- unconditional, unlike BatchScript_InsertSmartStreamExample's own
// reuse-if-already-on-a-freeform-view check, since this one is never meant to land on
// whatever view happens to already be active. main() logs a reminder afterward and
// returns without auto-running Smart Check View/Remap on this new view -- left for a
// person to run interactively (see main()'s own message for the exact settings).
async function BatchScript_InsertSmartStreamExample2() {
  let tab = store.activeTab();
  const view = store.addView('Smart Stream Example 2', 'ff');
  tab = app.createCanvasTab(view);
  app.switchToTab(tab.id);

  const start = findParts({ type: 'BusinessFunction', model: store.defaultModel }).find((p) => p.label === 'Production');
  if (!start) { log('No Business Function named "Production" found in model "' + store.defaultModel + '".'); return; }

  insertSmartStream(app, tab, {
    connectorType: 's',
    startPartIds: [start.id],
    direction: 'both',
    endType: 'DataDataEntity',
    levels: null,
    showTypes: ['GeneralActor', 'BusinessService', 'BusinessCapability', 'BusinessProcess', 'ApplicationService', 'ApplicationCapability', 'ApplicationProcess', 'ApplicationLogicalComponent', 'ApplicationPhysicalComponent', 'DataDataEntity', 'BusinessFunction', 'ApplicationApplication'],
  });

  app.recordAndRender();
  messageLog('Insert Smart Stream example 2 done');
}

// Example: Smart Check View called directly with explicit options (same shape the
// dialog builds from the user's picks -- see promptSmartCheckView in main.js). Called
// by main() above, after BatchScript_InsertSmartStreamExample -- runs on the same
// "Smart Stream Example" view that script just built (reusing its active tab, same
// pattern BatchScript_RemapExample below uses), checking "Missing connectors" (any
// connector already in the model between two nodes already on this view, not yet
// placed here) and "Derive hidden connections" (bridges two on-view nodes only linked
// through a chain of off-view parts, creating both a Connector and a Stream version --
// see smartCheckView's deriveConnectors option, commands.js).
async function BatchScript_SmartCheckViewExample() {
  const view = store.findView('Smart Stream Example');
  if (!view) { log('No "Smart Stream Example" view found -- run BatchScript_InsertSmartStreamExample first.'); return; }
  let tab = store.activeTab();
  if (!tab || tab.viewId !== view.id) {
    tab = app.createCanvasTab(view);
    app.switchToTab(tab.id);
  }

  smartCheckView(app, tab, { missingConnectors: true, deriveConnectors: true });

  app.recordAndRender();
  messageLog('Smart Check View example done');
}

// Example: Remap called directly with explicit options (same shape the dialog builds
// from the user's picks -- see promptRemap in main.js). Called by main() above, after
// BatchScript_InsertSmartStreamExample -- runs on the same "Smart Stream Example" view
// that script just built, so it has the Business Function/Business Process/Data
// Entity/General Actor content these particular options are meant to show off. Uses
// the 'layered' pattern (rows by hierarchical graph depth, not element-group/stream)
// with both Minimize Crossings and Minimize Connector Length enabled -- see the
// comment inside the function for exactly what that produces here.
async function BatchScript_RemapExample() {
  const view = store.findView('Smart Stream Example');
  if (!view) { log('No "Smart Stream Example" view found -- run BatchScript_InsertSmartStreamExample first.'); return; }
  // Reuse the current tab if it's already showing this view (the common case right
  // after BatchScript_InsertSmartStreamExample, which leaves it active) instead of
  // opening a redundant second tab on the same view.
  let tab = store.activeTab();
  if (!tab || tab.viewId !== view.id) {
    tab = app.createCanvasTab(view);
    app.switchToTab(tab.id);
  }

  // 'layered' rows nodes by hierarchical graph depth (BFS/longest-path from whatever
  // has no incoming edges) instead of element-group/stream membership -- Production
  // (no incoming edges) and both General Actor "Consumer" parts (also no incoming
  // edges, since Consumer->Capability points AWAY from them) land on row 0 together
  // automatically, with Business Process/Application Capability/Data Entity each
  // getting their own row below in turn -- no Edge Assignment needed at all for this
  // one; Minimize Crossings/Minimize Connector Length still handle the horizontal
  // alignment (each Capability centers under its own Process, Production centers
  // between its two Processes, the shared Production Schedule centers between its two
  // connected Capabilities).
  remap(app, tab, {
    templateName: 'Enterprise',
    pattern: 'layered',
    minimizeCrossings: true,
    minimizeConnectorLength: true,
    sortKeys: ['connectionOrder', 'streamOrder', 'streamName', 'entityType', 'nodeLabel', 'elementGroup'],
  });

  messageLog('Remap example done');
}

// Data Modeling > Autofill (menu command — NOT called from main() above, since it
// depends on the CURRENT view already having Data Entity Details tables on it, which
// won't be true for a fresh document). Scaffolds Id/Name/Description attributes onto
// any Data Entity Details table on the current view that doesn't have attributes yet
// (a table that already has ANY attributes is left completely untouched — never
// merged with or topped up), then wires up From/To Attribute + cardinality on any 'd'
// connector on the view whose From Attribute isn't set yet: From becomes the source
// table's own primary key, To becomes a same-named attribute on the target table
// (reusing one that's already there instead of duplicating it), cardinality defaults
// to One (from) / One or Many (to). See App.promptAutofill (main.js), which extracts
// and calls this specific function by name — same store.batchScriptCode mechanism as
// main() itself, just a different named entry point, so editing this function here
// changes what the Data Modeling > Autofill menu item does.
function dataAutoFill() {
  const tab = store.activeTab();
  if (!tab || tab.type !== 'canvas') throw new Error('Open a canvas view with Data Entity Details tables first.');

  const vms = store.viewMembersForView(tab.viewId).filter((v) => v.objectType === 'part');
  const parts = vms.map((v) => store.findPart(v.objectId)).filter((p) => p && p.type === 'DataEntityDetails');
  if (parts.length === 0) throw new Error('This view has no Data Entity Details tables to autofill.');

  let tablesScaffolded = 0;
  for (const part of parts) {
    if ((part.attributes || []).length > 0) continue;
    part.attributes = [
      { id: crypto.randomUUID(), name: part.label + 'Id', dataType: 'numeric', nullable: false, isPrimaryKey: true },
      { id: crypto.randomUUID(), name: part.label + 'Name', dataType: 'string', nullable: true, isPrimaryKey: false },
      { id: crypto.randomUUID(), name: part.label + 'Description', dataType: 'string', nullable: true, isPrimaryKey: false },
    ];
    tablesScaffolded += 1;
  }

  const partIdSet = new Set(parts.map((p) => p.id));
  const conns = store.doc.connectors.filter((c) => c.connectorType === 'd' && partIdSet.has(c.from) && partIdSet.has(c.to));
  let connectorsWired = 0, connectorsSkippedNoPk = 0;
  for (const conn of conns) {
    if (conn.fromAttribute) continue; // already set -- don't override
    const fromPart = store.findPart(conn.from);
    const toPart = store.findPart(conn.to);
    const pkAttr = (fromPart.attributes || []).find((a) => a.isPrimaryKey);
    if (!pkAttr) { connectorsSkippedNoPk += 1; continue; } // nothing to point the FK at yet
    let fkAttr = (toPart.attributes || []).find((a) => (a.name || '').toLowerCase() === pkAttr.name.toLowerCase());
    if (!fkAttr) {
      fkAttr = { id: crypto.randomUUID(), name: pkAttr.name, dataType: 'numeric', nullable: true, isPrimaryKey: false };
      toPart.attributes = [...(toPart.attributes || []), fkAttr];
    }
    conn.fromAttribute = pkAttr.id;
    conn.toAttribute = fkAttr.id;
    conn.fromCardinality = 'one';
    conn.toCardinality = 'oneOrMany';
    connectorsWired += 1;
  }

  app.recordAndRender();
  const skipSuffix = connectorsSkippedNoPk > 0 ? (', ' + connectorsSkippedNoPk + ' connector(s) skipped (source table has no primary key yet)') : '';
  return 'Autofill: ' + tablesScaffolded + ' table(s) scaffolded, ' + connectorsWired + ' connector(s) wired' + skipSuffix + '.';
}

// Common script: a THIRD kind of entry point (alongside main()'s own BatchScript_*
// chain above and dataAutoFill above) — NOT called from main(), and not extracted by
// name from any menu item either. Instead, every function/const defined anywhere in
// this text is automatically in scope inside every PART's own script (the Script
// field on a Part, run once per simulation tick — see simulation.js's own
// script-contract comment for the full ctx shape) — runTick (simulation.js) compiles
// each part's script as new Function('ctx', store.batchScriptCode + newline +
// part.script), so this whole file is effectively prepended ahead of every part
// script before it runs, making CommonScript_Example (and anything else defined
// alongside it here) directly callable BY NAME from any part's own script, using the
// exact same ctx that script's own body already receives. Naming convention for
// future additions meant to be called this way, from a part script rather than from
// main() or a menu item: CommonScript_<Name>, kept visually distinct from
// BatchScript_<Name> (main()) and dataAutoFill (Data Modeling > Autofill).
//
// A part's own script can use this like:
//   CommonScript_Example(ctx);
//   return { value: ctx.inputs[0]?.value };
function CommonScript_Example(ctx) {
  ctx.log('called by ' + ctx.part.type + ' ' + ctx.part.label + ' ' + ctx.part.model);
}

// Custom remap: a FOURTH kind of entry point, reported directly: "is it possible to
// build a small framework for user designed remap logic, something that can be loaded
// in and stored in user local settings perhaps." Not called from main(), not
// extracted by name from a menu item, and not called from a part script either --
// instead it's picked interactively from the Remap dialog's Pattern dropdown ("custom"
// reveals a second dropdown listing every CustomRemap_<Name> function found here) on
// whichever view Remap is run against. See applyRemapLayout's own doc comment
// (commands.js) for the full ctx contract this receives -- parts/connectors already on
// the view, nodeSize, spacingScale, and a grid-coordinate convenience layer
// (ctx.gridToXY/setRowGap/setColGap) as an alternative to hand-computed canvas pixels,
// direct follow-up: "can there be an option to use grid coordinates based on rows and
// columns and spacers between, as an alternate to the x,y canvas coordinates?" Naming
// convention for future additions meant to be selectable this way: CustomRemap_<Name>.
//
// This one groups parts onto one row PER ELEMENT TYPE (alphabetically), columns within
// each row sorted by label -- using grid coordinates directly (no pixel math at all),
// plus a little extra breathing room below the first row via setRowGap, to demonstrate
// both parts of the convenience layer.
function CustomRemap_Example(ctx) {
  const byType = new Map();
  for (const p of ctx.parts) {
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type).push(p);
  }
  const types = [...byType.keys()].sort();
  const positions = [];
  types.forEach((type, row) => {
    const rowParts = byType.get(type).sort((a, b) => a.label.localeCompare(b.label));
    rowParts.forEach((p, col) => positions.push({ vmId: p.vmId, row, col }));
  });
  if (types.length > 1) ctx.setRowGap(0, 30); // extra space below the first row
  return positions;
}

// CommonScript_DebugOutLog(ctx): a second CommonScript_<Name> example, meant to be
// called from (or copied into) any part's script -- reported directly, replacing the
// earlier looping/pretty-printed version with a simpler single-block dump: logs
// ctx.inputs verbatim (compact JSON, one line) to the Debug Log tab, bracketed by
// '-i--'/'-e--' marker lines so repeated calls across ticks stay visually separable.
// Doesn't return anything or touch value/state itself, so a plain top-level statement
// like CommonScript_DebugOutLog(ctx); is enough alongside whatever else the calling
// script already does with ctx.inputs.
function CommonScript_DebugOutLog(ctx) {
  ctx.logDebug('-i--');
  ctx.logDebug(JSON.stringify(ctx.inputs));
  ctx.logDebug('-e--');
  return;
}

// Common script: THE shipped default for every Part's own 'script' field (see
// Store.createPart/migrateDoc, below in this file) -- direct follow-up: "move the
// generic scripts from each part to one script replacing CommonScript_Sim with
// parameters as needed. This will reduce file size and simplify maintenance, and make
// simulation available by default for all files. By default each part should now have
// the script disabled and script field populated with the call to the generic
// script, leaving user able to override with their own script as desired." Fully
// replaces the old CommonScript_Sim (which only ever classified connectors by
// relationship into a placeholder value array) with a genuinely generic
// request/response dispatcher: behavior is driven purely by ctx.part.type -- an
// INITIATOR (default: BusinessActor/BusinessRole/GeneralActor/
// BusinessOrganizationUnit) autonomously originates a fresh request every tick and
// logs whatever reply eventually comes back; a RESPONDER (default:
// DataDataEntity/DataObject/DataEntityDetails/DataLogicalComponent/
// DataPhysicalComponent/BusinessObject/BusinessCapability/Contract/Product) terminates
// a forward request with a generic reply instead of relaying it further; everything
// else is a generic PASSTHROUGH that relays a fresh request downstream and any reply
// back upstream -- never a hardcoded part id/label (ctx.part.rawLabel is always the
// packet's subject) or a per-part special case. 'opts' (all optional) lets a calling
// script override just the classification without forking this whole function:
// { initiatorTypes, responderTypes, relationshipActions }, each replacing (not
// merging with) its own built-in default list/map below. Only connectorType 'c'
// connectors carry this traffic -- 's' (Stream) edges are the separate tagging layer
// and are ignored here. 'relationshipActions' is where each connector TYPE drives its
// own action label on a RESPONDER's reply (e.g. an 'Access' connector -> "retrieved a
// record for", a 'Composition' connector -> "reported inventory status for") -- see
// simulation.js's own script-contract comment for what each returned field does.
// Placed LAST among the CommonScript_<Name> examples, after CommonScript_DebugOutLog
// above, as the more complete one.
function CommonScript_GenericPartActions(ctx, opts) {
  opts = opts || {};
  const INITIATOR_TYPES = opts.initiatorTypes || ['BusinessActor', 'BusinessRole', 'GeneralActor', 'BusinessOrganizationUnit'];
  const RESPONDER_TYPES = opts.responderTypes || ['DataDataEntity', 'DataObject', 'DataEntityDetails', 'DataLogicalComponent', 'DataPhysicalComponent', 'BusinessObject', 'BusinessCapability', 'Contract', 'Product'];
  const RELATIONSHIP_ACTIONS = opts.relationshipActions || {
    access: 'retrieved a record for', triggering: 'executed and acknowledged',
    serving: 'served a result for', assignment: 'processed on behalf of',
    flow: 'processed a data flow for', association: 'shared a reference for',
    realization: 'realized an output for', composition: 'reported inventory status for',
    aggregation: 'reported aggregated status for',
  };

  const me = ctx.part.type;
  const subject = ctx.part.rawLabel || ctx.part.label;
  const seen = ctx.state.seen || {};           // fromPartId -> last request id already handled
  const seenReply = ctx.state.seenReply || {}; // fromPartId -> last reply id already relayed/logged

  const inC = ctx.inputs.filter((i) => i.connector.connectorType === 'c');
  const outC = ctx.outputs.filter((o) => o.connector.connectorType === 'c');
  const repliesC = ctx.responses.filter((r) => r.connector.connectorType === 'c');

  // ---------------------------------------------------------------- RESPONDER
  if (RESPONDER_TYPES.includes(me)) {
    const fresh = inC.find((i) => i.value && i.value.requestId !== undefined && seen[i.fromPartId] !== i.value.requestId);
    if (!fresh) return { value: ctx.state.lastReply || null, state: ctx.state };

    const action = RELATIONSHIP_ACTIONS[String(fresh.connector.relationship).toLowerCase()] || 'responded to';
    const reply = {
      requestId: fresh.value.requestId,
      subject: fresh.value.subject,
      answeredBy: subject,
      action,
      path: [...(fresh.value.path || []), subject],
      data: subject + ': ' + action + ' request #' + fresh.value.requestId + ' from "' + fresh.value.subject + '"',
    };
    ctx.logActivity(me + ' "' + subject + '" ' + action + ' request #' + reply.requestId + ' (via ' + fresh.connector.relationship + ') from "' + fresh.fromLabel + '"');
    return {
      value: reply,
      state: { ...ctx.state, seen: { ...seen, [fresh.fromPartId]: fresh.value.requestId }, lastReply: reply },
      response: reply,
      leftBadge: { text: 'answered #' + reply.requestId, color: '#2f8f4e' },
    };
  }

  // ---------------------------------------------------------------- INITIATOR
  if (INITIATOR_TYPES.includes(me)) {
    const nextSeenReply = { ...seenReply };
    for (const r of repliesC) {
      if (nextSeenReply[r.fromPartId] === r.value.requestId) continue;
      ctx.log(me + ' "' + subject + '" received reply to request #' + r.value.requestId + ' from "' + r.fromLabel + '": ' + r.value.data);
      nextSeenReply[r.fromPartId] = r.value.requestId;
    }
    if (outC.length === 0) return { value: null, state: { ...ctx.state, seenReply: nextSeenReply } };

    const requestId = ctx.tick;
    const request = { requestId, subject, path: [subject] };
    ctx.log(me + ' "' + subject + '" issuing request #' + requestId + ' to ' + outC.length + ' connector(s)');
    return { value: request, state: { ...ctx.state, seenReply: nextSeenReply }, leftBadge: { text: 'req #' + requestId, color: '#c9862f' } };
  }

  // ---------------------------------------------------------------- PASSTHROUGH
  let value = ctx.state.lastForwarded || null;
  let nextSeen = seen;
  const freshIn = inC.find((i) => i.value && i.value.requestId !== undefined && seen[i.fromPartId] !== i.value.requestId);
  if (freshIn) {
    value = { ...freshIn.value, path: [...(freshIn.value.path || []), subject] };
    nextSeen = { ...seen, [freshIn.fromPartId]: freshIn.value.requestId };
    ctx.logDebug(me + ' "' + subject + '" relaying request #' + value.requestId + ' forward from "' + freshIn.fromLabel + '" (via ' + freshIn.connector.relationship + ')');
  }

  let response;
  let nextSeenReply = seenReply;
  const freshReply = repliesC.find((r) => r.value && r.value.requestId !== undefined && seenReply[r.fromPartId] !== r.value.requestId);
  if (freshReply) {
    response = { ...freshReply.value, path: [...(freshReply.value.path || []), subject] };
    nextSeenReply = { ...seenReply, [freshReply.fromPartId]: freshReply.value.requestId };
    ctx.logDebug(me + ' "' + subject + '" relaying reply #' + response.requestId + ' back via "' + freshReply.fromLabel + '"');
  }

  return {
    value,
    state: { ...ctx.state, seen: nextSeen, seenReply: nextSeenReply, lastForwarded: value },
    response,
    leftBadge: value ? { text: '#' + value.requestId, color: '#3a6fbf' } : undefined,
  };
}
`;

/** The out-of-the-box default for every new Part's own `script` field (Store.createPart
 * below, migrateDoc's backfill for a raw/foreign doc with no `script` key at all, and
 * archimate.js's own part construction) — a single source of truth for the literal
 * call text, so it's never hand-retyped (and risks drifting) at each of those sites.
 * Also used by promptCodeSummary (main.js) to tell "no CUSTOM code to review here" (a
 * blank script, or this exact unmodified default) apart from a part someone actually
 * wrote/edited a script for — the shipped dispatcher is already-reviewed, known code,
 * not something Code Summary's security-review purpose needs to surface again. */
const DEFAULT_PART_SCRIPT = 'return CommonScript_GenericPartActions(ctx);';

/** Store.smartStreamPresets' out-of-the-box default — named, reusable Insert Smart
 * Stream dialog settings (main.js's promptInsertSmartStream), saved/loaded via that
 * dialog's own Preset row. Same Local Settings persistence story as
 * DEFAULT_BATCH_SCRIPT_CODE above (cached to localStorage, bundled into File > Save/
 * Load Local Settings, both handled in main.js) — deliberately never touches this.doc,
 * so presets are a personal toolkit that survives across different documents/models,
 * not something that round-trips through Save/Load JSON. Starting element is
 * remembered by TYPE + part LABEL(s), not raw part id(s) — ids are only ever valid
 * within the specific document they were created in, while a label is far more likely
 * to still resolve to a real part next time the preset is applied, possibly against a
 * regenerated or entirely different document. This one entry mirrors
 * BatchScript_InsertSmartStreamExample above exactly, so the same trace is available
 * both as a runnable script and as a ready-made dialog preset out of the box. */
const DEFAULT_SMART_STREAM_PRESETS = [
  {
    name: 'StreamSet1',
    connectorType: 'c',
    startType: 'BusinessFunction',
    startInstanceLabels: ['Production'],
    direction: 'both',
    endType: 'DataDataEntity',
    levels: null,
    showTypes: ['ApplicationCapability', 'BusinessFunction', 'BusinessProcess', 'BusinessCapability', 'DataDataEntity', 'GeneralActor', 'TechnologyLogicalComponent'],
  },
];

/** Store.remapPresets' out-of-the-box default — named, reusable Remap dialog settings
 * (main.js's promptRemap), saved/loaded via that dialog's own Preset row. Same Local
 * Settings persistence story as DEFAULT_SMART_STREAM_PRESETS above (cached to
 * localStorage, bundled into File > Save/Load Local Settings, both handled in main.js)
 * — deliberately never touches this.doc. Two presets shipped, reported directly (the
 * exact fields the dialog's own Save As button writes, main.js's `#rm-preset-save`
 * handler): {name, templateName, pattern, sortKeys, limitColumnsToView, filteredOnly,
 * selectedOnly, forcePreferRight, forceGroupRows, edgeAssignment: {[elementType]:
 * 'top'|'bottom'|'left'|'right'+1-5}, edgeBlanks: {[edge]: [1-5, ...]}, minimizeCrossings,
 * minimizeConnectorLength, alignBySection, customFunctionName}. edgeAssignment/
 * minimizeCrossings/minimizeConnectorLength/edgeBlanks only affect the 'default'/'none'
 * patterns (see commands.js's applyRemapLayout) — force-directed and section-based
 * views ignore them entirely, same as sortKeys already does today. "FocusedStreamDefault"
 * deliberately omits `alignBySection` (not a mistake — an absent field on Load defaults
 * to checked/true, the same "older preset, same default everywhere else" convention
 * check_remap_align_by_section_dialog_wiring already covers); every OTHER preset a
 * person saves lands in this same array via the dialog's Save As button. */
const DEFAULT_REMAP_PRESETS = [
  {
    name: 'FocusedStreamDefault',
    templateName: 'Enterprise',
    pattern: 'layered',
    sortKeys: ['streamName', 'connectionOrder', 'entityType', 'nodeLabel', 'streamOrder', 'elementGroup'],
    limitColumnsToView: false,
    filteredOnly: false,
    selectedOnly: false,
    forcePreferRight: false,
    forceGroupRows: false,
    edgeAssignment: {
      ApplicationApplication: 'right1',
      BusinessCapability: 'left3',
      BusinessFunction: 'top1',
      BusinessProcess: 'top2',
      BusinessService: 'left2',
      DataDataEntity: 'bottom1',
      GeneralActor: 'left1',
    },
    edgeBlanks: { top: [3], right: [2] },
    minimizeCrossings: false,
    minimizeConnectorLength: false,
    customFunctionName: 'CustomRemap_Example',
  },
  {
    name: 'BUtoData',
    templateName: 'Enterprise',
    pattern: 'layered',
    sortKeys: ['streamName', 'connectionOrder', 'entityType', 'nodeLabel', 'streamOrder', 'elementGroup'],
    limitColumnsToView: false,
    filteredOnly: false,
    selectedOnly: false,
    forcePreferRight: false,
    forceGroupRows: false,
    edgeAssignment: {
      ApplicationApplication: 'right1',
      BusinessCapability: 'left3',
      BusinessFunction: 'top2',
      BusinessOrganizationUnit: 'top1',
      BusinessProcess: 'top3',
      BusinessService: 'left2',
      DataDataEntity: 'bottom1',
      GeneralActor: 'left1',
    },
    edgeBlanks: { top: [4], bottom: [1], right: [2] },
    minimizeCrossings: false,
    minimizeConnectorLength: false,
    alignBySection: true,
    customFunctionName: 'CustomRemap_Example',
  },
];

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Formats a timestamp as "yyyymmdd_hhmmss" (local time) — used for Part/Connector
 * createdAt/updatedAt. Defaults to right now. */
function nowStamp(date = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p2(date.getMonth() + 1)}${p2(date.getDate())}_${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`;
}

function ciEq(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

/** The four "UI dashboard element" types (public/custom.json's "UI" elementGroup) —
 * inert Parts (no script/simulation of their own) that mirror or feed another part's
 * `ctx.ui.*` values each tick, for building simple sim-driven dashboards. Shared
 * across render.js (property panel field filtering, badge-always-visible rendering),
 * simulation.js (ctx.ui wiring), and every place that scans "every element type" and
 * needs to explicitly exclude these (stream templates, industry generation, Level
 * Up/Down) so a widget never accidentally participates in real architecture flows. */
const UI_DASHBOARD_TYPES = ['UITextInput', 'UITextOutput', 'UINumericInput', 'UINumericOutput'];
function isUIDashboardType(type) { return UI_DASHBOARD_TYPES.some((t) => ciEq(t, type)); }

// The base node box size (matches canvas.js's getNodeSize fallback and NODE_HALF_W/H)
// BEFORE nodeSizeMultiplier is applied. Kept here, not exported, since only
// defaultNodeSize below and Store's own view-creation code need it.
const BASE_NODE_WIDTH = 130, BASE_NODE_HEIGHT = 46;

/** Scales the base node box size by a multiplier, rounding to whole pixels — used
 * whenever a new view's nodeWidth/nodeHeight is set (Store constructor, addView,
 * migrateDoc's fallback for an older file with no nodeWidth/nodeHeight of its own). */
function defaultNodeSize(multiplier) {
  return { nodeWidth: Math.round(BASE_NODE_WIDTH * multiplier), nodeHeight: Math.round(BASE_NODE_HEIGHT * multiplier) };
}

class Store {
  /** nodeSizeMultiplier: scales the default node box size new views are created with
   * (see defaultNodeSize above) — a plain constructor param, not read from localStorage
   * here, so this class stays usable headless under plain Node (see DESIGN_DOCUMENT.md /
   * CLAUDE.md's testing section); main.js reads the cached user preference (Local
   * Settings) and passes it in at construction time instead. Defaults to 1.2 (the new
   * out-of-the-box default node size, 1.2x the original 130x46 — nodes generated at the
   * old size were cramped and often clipped their own label text). */
  constructor(settings, industryTree, nodeSizeMultiplier = 1.2) {
    this.nodeSizeMultiplier = nodeSizeMultiplier;
    this.settings = settings;   // custom.json contents
    this.mergedRelationshipPairs = []; // set by main.js after data load

    // ---- persisted model doc (round-trips via Save/Load JSON, shape ~ onestream.json) ----
    this.doc = {
      version: '0.2',
      readme: { note: '' },
      defaultModel: 'Reference',
      currentView: 'home',
      // Industry reference data for "Generate Industry" — a single Section/Function/
      // Capability/Application Capability/Entity tree (industryTree, boot-seeded from
      // public/capabilities-general-SFCCE.json via data.js's own Load-SFCCE pipeline
      // run) plus which streamTemplate (custom.json) generateIndustry (commands.js)
      // should walk it with (industryTemplateName). Only ONE industry dataset ever
      // exists at a time — File > Load SFCCE CLEARS and REPLACES both fields rather
      // than adding a new named entry (main.js's finishSFCCEImport), warning first if
      // industryTree is already non-empty. Persisted (round-trips through Save/Load
      // JSON, unlike the old memory-only industryData/industryTemplates maps this
      // replaced) so a person's Load SFCCE import survives a save/reload.
      industryTree: industryTree || [],
      industryTemplateName: 'SFCCE',
      models: [{ modelName: 'Reference' }, { modelName: 'As-is' }, { modelName: 'To-be' }, { modelName: 'Gap' }],
      views: [
        { id: 'home', viewName: 'home', viewType: 'ff', chkShowConnectorType: true, chkShowStreamType: false, chkShowDataType: true, chkShowOnlyDerived: false, chkShowKeys: false, chkShowElementTypes: true, chkShowDescription: true, chkShowAttributes: true, chkShowOnPageCatalogs: false, chkShowSimValues: false, chkShowScriptBadge: false, chkShowAllText: false, routingStyle: 'default', routingStyleStream: 'default', margin: 50, sections: [], ...defaultNodeSize(nodeSizeMultiplier), remapSortKeys: null, remapLastOptions: null, spacingScale: 1, spacingAxis: 'both' },
      ],
      parts: [],
      connectors: [],
      viewMembers: [],
      settingsUser: { relationshipPairs: [] },
    };

    // ---- non-persisted UI/session state ----
    this.tabs = [];        // { id, title, type: 'canvas'|'pdf'|'text'|'table', viewId, history:{past,present,future}, viewport, selection:Set }
    this.activeTabId = null;
    this.closedTabs = [];  // stack of closed tab descriptors, for restore
    this.activeLibraries = new Set(['TOGAF', 'BPMN', 'ArchiMate', 'Other']);
    // Node Scripting / Simulation runtime state — deliberately kept OUTSIDE this.doc so
    // it never round-trips through Save/Load JSON (toJSON()/loadFromJSON() only touch
    // this.doc). Saved/restored separately via its own snapshot file (simulation.js).
    // Scoped by MODEL NAME (not view/tab) — a Part has one simulated value/state shared
    // across every view that displays it; multiple models can run independently and
    // concurrently.
    // simRuntime: modelName -> { tick, values: Map<partId, {value, state, lastError, lastTick}> }
    this.simRuntime = new Map();
    // simLog: modelName -> [{ tick, partId, label, type: 'value'|'error', message, ts }], capped per model.
    this.simLog = new Map();
    // simRunning: modelName -> { timerId } — presence of an entry means that model has an
    // active continuous run. Independent of any tab, so Stop can always find and kill a
    // run regardless of whether its originating tab/view is still open.
    this.simRunning = new Map();
    // Which model the Simulation toolbar (Step/Run/Stop/Reset + its model selector)
    // currently targets — entirely independent of this.doc.defaultModel (defaultModel is
    // used only when creating new nodes). Initialized to defaultModel at boot purely as a
    // starting point; not persisted, not restored across Save/Load or a page refresh.
    this.simSelectedModel = this.doc.defaultModel;
    // Global message console (left-panel Log area, 3 tabs — Step 43): scripts can write
    // arbitrary messages here via ctx.log(...)/ctx.logActivity(...)/ctx.logDebug(...)
    // during a tick, or via the Script Console's own messageLog(...)/activityLog(...)/
    // debugLog(...) bindings, independent of any one view — a running session console
    // rather than a per-view record. Three SEPARATE arrays, one per tab, each capped at
    // 500 entries independently (simulation.js's pushMessageLog/pushActivityLog/
    // pushDebugLog): messageLog for brief, at-a-glance messages (the original, oldest
    // tab); activityLog for more detailed blow-by-blow narration; debugLog for deep,
    // verbose dumps (e.g. full pretty-printed values) too noisy for the other two.
    this.messageLog = [];
    this.activityLog = [];
    this.debugLog = [];
    // Local Secrets (File > Load Local Secrets): a flat key/value object read from a
    // user-loaded JSON file, for secrets (API keys etc.) that must never end up in a
    // save file AND must never be cached to localStorage (unlike Local Settings below) —
    // exposed to scripts as ctx.secrets. Memory-only by design — does NOT survive a page
    // refresh (must be re-loaded each session, deliberately, so a secret never lingers
    // anywhere on disk this app controls); does survive closing/reopening DyCAD's own
    // tabs/views, since it's unrelated to tab lifecycle.
    this.localSecrets = {};
    // Cap on doc.parts.length + doc.connectors.length that ctx.createPart/
    // ctx.createConnector (simulation.js) will allow before refusing further creation —
    // the one guardrail against a buggy/runaway script (especially under continuous Run)
    // unboundedly growing the document. Part of Local Settings (File > Load/Save Local
    // Settings) — unlike Local Secrets above, this one IS cached to localStorage by
    // main.js's bootstrap/load-handler code (kept out of this Node-testable class itself,
    // same reason theme/pinned-fields localStorage access lives in render.js/main.js, not
    // here), so it survives a refresh without re-loading the file. Default here is just
    // the fresh-session fallback before any cached or loaded value is applied.
    this.maxScriptEntities = 5000;
    // The Script Console's (Advanced menu) persistent script text — same Local
    // Settings persistence story as maxScriptEntities above (cached to localStorage,
    // bundled into File > Save/Load Local Settings, both handled in main.js). Unlike
    // a Part's own per-tick simulation script, this isn't tied to any one document and
    // survives across Save/Load JSON entirely — it's a personal toolkit of on-demand
    // batch operations, not part of the model itself. Defaults to a ready-to-run
    // starter script (DEFAULT_BATCH_SCRIPT_CODE, above) rather than blank.
    this.batchScriptCode = DEFAULT_BATCH_SCRIPT_CODE;
    // Named Insert Smart Stream dialog presets (main.js's promptInsertSmartStream) —
    // same Local Settings persistence story as batchScriptCode just above (cached to
    // localStorage, bundled into File > Save/Load Local Settings, both handled in
    // main.js). Never touches this.doc, so presets are a personal toolkit that
    // survives across different documents/models, not something that round-trips
    // through Save/Load JSON. Defaults to one ready-made preset (DEFAULT_SMART_STREAM_
    // PRESETS, above) mirroring BatchScript_InsertSmartStreamExample.
    this.smartStreamPresets = DEFAULT_SMART_STREAM_PRESETS;
    // Named Remap dialog presets (main.js's promptRemap) — same Local Settings
    // persistence story as smartStreamPresets just above. Never touches this.doc.
    this.remapPresets = DEFAULT_REMAP_PRESETS;
    // Filename of the last file that fully replaced store.doc (Save/Load JSON's own
    // "Load JSON" button, File > Load, File > Load Example) — NOT set by Import Data,
    // which merges additively into whatever's already loaded rather than replacing it.
    // Non-persisted, shown in the header, exposed to scripts as ctx.loadedFileName.
    this.loadedFileName = null;
    // Unsaved-changes tracking for the File menu's Load/Load Example prompts: set true
    // by any recordHistory() call (i.e. any model edit), cleared by Save/Load JSON and
    // Load Example.
    this.dirty = false;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  // ===================== MODELS =====================
  get defaultModel() { return this.doc.defaultModel; }
  set defaultModel(v) { this.doc.defaultModel = v; }

  addModel(name) {
    if (this.doc.models.some((m) => ciEq(m.modelName, name))) return false;
    this.doc.models.push({ modelName: name });
    return true;
  }
  removeModel(name) {
    if (this.doc.models.length <= 1) return false;
    this.doc.models = this.doc.models.filter((m) => !ciEq(m.modelName, name));
    if (ciEq(this.doc.defaultModel, name)) this.doc.defaultModel = this.doc.models[0].modelName;
    return true;
  }

  // ===================== VIEWS =====================
  get currentView() { return this.doc.currentView; }
  set currentView(v) { this.doc.currentView = v; }

  findView(id) { return this.doc.views.find((v) => ciEq(v.id, id)); }

  addView(viewName, viewType = 'ff') {
    const id = viewName;
    if (this.findView(id)) return this.findView(id);
    const view = { id, viewName, viewType, chkShowConnectorType: true, chkShowStreamType: false, chkShowDataType: true, chkShowOnlyDerived: false, chkShowKeys: false, chkShowElementTypes: true, chkShowDescription: true, chkShowAttributes: true, chkShowOnPageCatalogs: false, chkShowSimValues: false, chkShowScriptBadge: false, chkShowAllText: false, routingStyle: 'default', routingStyleStream: 'default', margin: 50, sections: [], ...defaultNodeSize(this.nodeSizeMultiplier), remapSortKeys: null, remapLastOptions: null, spacingScale: 1, spacingAxis: 'both' };
    this.doc.views.push(view);
    this.ensureViewSections(view);
    return view;
  }

  /** Seed view.sections from the global settings.sections template for its viewType, if not already seeded. */
  ensureViewSections(view) {
    if (!view || ciEq(view.viewType, 'ff') || !view.viewType) return;
    if (view.sections && view.sections.length > 0) return;
    const globalSections = (this.settings.sections || []).filter((s) => ciEq(s.viewType, view.viewType));
    if (globalSections.length === 0) return;
    view.sections = globalSections
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((s) => ({ ...s, id: newId() }));
  }
  removeView(id) {
    this.doc.views = this.doc.views.filter((v) => !ciEq(v.id, id));
    this.doc.viewMembers = this.doc.viewMembers.filter((vm) => !ciEq(vm.view, id));
  }

  /**
   * Rename a view's id/viewName (they're kept identical throughout this app) and
   * cascade the change to every viewMember.view, every viewMember.linkedViewName,
   * every open/closed tab's viewId, and currentView that referenced the old id.
   * Returns the final id actually used (deduplicated with a numeric suffix on conflict).
   */
  renameView(oldId, desiredNewId) {
    const view = this.findView(oldId);
    if (!view || ciEq(oldId, desiredNewId)) return oldId;
    let newId2 = desiredNewId;
    let n = 1;
    while (this.findView(newId2) && !ciEq(newId2, oldId)) { newId2 = `${desiredNewId} ${n}`; n += 1; }
    view.id = newId2;
    view.viewName = newId2;
    for (const vm of this.doc.viewMembers) {
      if (ciEq(vm.view, oldId)) vm.view = newId2;
      if (vm.linkedViewName && ciEq(vm.linkedViewName, oldId)) vm.linkedViewName = newId2;
    }
    for (const tab of this.tabs) { if (tab.type === 'canvas' && ciEq(tab.viewId, oldId)) { tab.viewId = newId2; tab.title = newId2; } }
    for (const tab of this.closedTabs) { if (tab.type === 'canvas' && ciEq(tab.viewId, oldId)) { tab.viewId = newId2; tab.title = newId2; } }
    if (ciEq(this.currentView, oldId)) this.currentView = newId2;
    return newId2;
  }

  // ===================== USER-REMEMBERED CONNECTOR DEFAULTS =====================
  /** The relationship name the user last explicitly chose for this (typeA,typeB) pair, if any. */
  getDefaultRelationship(typeA, typeB) {
    const list = this.doc.settingsUser?.relationshipPairs || [];
    const found = list.find((p) => ciEq(p.typeA, typeA) && ciEq(p.typeB, typeB));
    return found ? found.relationship : null;
  }
  /** Remember the user's explicit relationship choice for this (typeA,typeB) pair going forward. */
  setDefaultRelationship(typeA, typeB, relationship) {
    if (!this.doc.settingsUser) this.doc.settingsUser = { relationshipPairs: [] };
    const list = this.doc.settingsUser.relationshipPairs;
    const found = list.find((p) => ciEq(p.typeA, typeA) && ciEq(p.typeB, typeB));
    if (found) found.relationship = relationship;
    else list.push({ typeA, typeB, relationship });
  }

  // ===================== PARTS / CONNECTORS =====================
  findPart(id) { return this.doc.parts.find((p) => ciEq(p.id, id)); }
  findConnector(id) { return this.doc.connectors.find((c) => ciEq(c.id, id)); }
  /** Look up a connector by the unique (from,to,model,connectorType) combination, for
   * duplicate detection when creating a new connector. */
  findExistingConnector(from, to, model, connectorType) {
    return this.doc.connectors.find((c) => ciEq(c.from, from) && ciEq(c.to, to) && ciEq(c.model, model) && ciEq(c.connectorType, connectorType));
  }

  // pin3D: null (auto-layout, the default) or a real {x,y,z} world position — set by
  // right-click-dragging a node in the 3D View (view3d.js). A pinned part skips
  // computeStreamLanes/layoutTypeIntoLanes' grid entirely and renders at exactly this
  // position instead; Advanced > Reset Pinned 3D Positions clears every part's pin3D
  // back to null at once. Persisted (part of the document), so a pin survives Save/Load.
  // script default: "make simulation available by default for all files" -- every new
  // Part ships wired to call the shipped generic dispatcher (DEFAULT_PART_SCRIPT ->
  // CommonScript_GenericPartActions, DEFAULT_BATCH_SCRIPT_CODE above) rather than an
  // empty string, with scriptEnabled still defaulting to false so nothing actually
  // runs until a person opts in. A caller that wants a truly blank/disabled script
  // (e.g. a table part like DataEntityDetails, or copying an existing part's own
  // script verbatim) still passes `script` explicitly, same as before.
  createPart({ type, label, rawLabel, model, streams = [], note = '', order = 0, other = {}, xIds = '', description = '', script = DEFAULT_PART_SCRIPT, scriptEnabled = false, section = '', pin3D = null, attributes = [], uiTargetPartId = '', uiInputValue = null }) {
    const stamp = nowStamp();
    // uiTargetPartId/uiInputValue: UI dashboard elements only (isUIDashboardType,
    // above) — which OTHER part this widget mirrors/feeds, and (Input types) the
    // value a person types here, fed to that target's script via ctx.ui next tick
    // (simulation.js). Present on every Part, same as pin3D/attributes are, even
    // though only 4 types ever actually use them — never read/written for anything
    // else.
    // rawLabel: the label BEFORE any element-type prefix/suffix decoration
    // (commands.js's joinLabel) is applied -- e.g. label "Manage Billing" / rawLabel
    // "Billing" for an ApplicationCapability (prefix "Manage"). A caller that actually
    // computed a decorated label (createStream's main loop, createPassiveNode,
    // autoCompleteStreams -- all commands.js) passes the true pre-decoration name
    // through explicitly; every other caller (manual part creation, ctx.createPart,
    // ArchiMate import, ...) has no decoration concept at all, so omitting rawLabel
    // here falls back to label itself, same as before this field existed.
    const part = { id: newId(), type, label: label ?? '', rawLabel: (rawLabel ?? label) ?? '', model, streams, note, order, other, xIds, description, script, scriptEnabled: !!scriptEnabled, section, pin3D, attributes, uiTargetPartId, uiInputValue, createdAt: stamp, updatedAt: stamp };
    this.doc.parts.push(part);
    return part;
  }

  /** Marks a part as freshly modified — sets updatedAt to right now. Called from every
   * property-panel setter that actually mutates a part's own fields (not viewMember
   * fields, which have no createdAt/updatedAt of their own), so the timestamp reflects
   * genuine edits to the part itself, regardless of which view/panel made them. */
  touchPart(part) { if (part) part.updatedAt = nowStamp(); }
  /** Same as touchPart, for connectors. */
  touchConnector(conn) { if (conn) conn.updatedAt = nowStamp(); }

  createConnector({ from, to, model, connectorType = 'c', relationship = '', streams = [], note = '', mirrorOf = null, fromAttribute = '', toAttribute = '', fromCardinality = '', toCardinality = '', isDerived = false }) {
    const styleFields = connectorStyleFields(relationship, this.settings);
    const stamp = nowStamp();
    const connector = {
      id: newId(), from, to, model, streams, note, mirrorOf,
      connectorType,
      fromAttribute, toAttribute, fromCardinality, toCardinality,
      isDerived,
      ...styleFields,
      createdAt: stamp, updatedAt: stamp,
    };
    this.doc.connectors.push(connector);
    return connector;
  }

  /** Updates an EXISTING connector's from/to/relationship/connectorType/streams and
   * restyles it (stroke/dash/fill/line-ends) in place, using the same
   * settings.relationshipStyles lookup createConnector uses — for keeping a
   * derived/mirrored connector (see commands.js's Composition-awareness in Smart Check
   * View/Node) in sync after whatever it was cloned from changes. Caller is responsible
   * for touchConnector() and any viewMember placement. */
  restyleConnector(conn, { from, to, model, connectorType = 'c', relationship = '', streams }) {
    const styleFields = connectorStyleFields(relationship, this.settings);
    conn.from = from; conn.to = to; conn.model = model; conn.connectorType = connectorType;
    if (streams) conn.streams = streams;
    Object.assign(conn, styleFields);
  }

  deletePart(id) { this.doc.parts = this.doc.parts.filter((p) => !ciEq(p.id, id)); }
  deleteConnector(id) { this.doc.connectors = this.doc.connectors.filter((c) => !ciEq(c.id, id)); }
  /** Delete a connector and every viewMember (in any view) that displays it. */
  deleteConnectorAndMembers(id) {
    this.deleteConnector(id);
    this.doc.viewMembers = this.doc.viewMembers.filter((vm) => !(vm.objectType === 'connector' && ciEq(vm.objectId, id)));
  }
  /** Delete a view outright: removes any remaining viewMembers still pointing at it
   * (callers that already relocated them, e.g. a linked-view merge, pass an empty set
   * here), plus any open/closed tab showing it, so nothing dangles. */
  deleteView(id) {
    this.doc.views = this.doc.views.filter((v) => !ciEq(v.id, id));
    this.doc.viewMembers = this.doc.viewMembers.filter((vm) => !ciEq(vm.view, id));
    this.tabs = this.tabs.filter((t) => !(t.type === 'canvas' && ciEq(t.viewId, id)));
    this.closedTabs = this.closedTabs.filter((t) => !(t.type === 'canvas' && ciEq(t.viewId, id)));
  }

  // ===================== VIEW MEMBERS (nodes) =====================
  viewMembersForView(viewId) {
    return this.doc.viewMembers.filter((vm) => ciEq(vm.view, viewId));
  }

  /**
   * Given a desired top-left position, find the nearest position (same spot if already
   * free) whose node-sized bounding box doesn't overlap any existing node in the view.
   * Uses the view's current node size (defaults to 130x46 if not provided/redrawn).
   * Searches outward on a grid matching the node size + a small margin.
   *
   * `lookupCache` (optional, shape: { partVmsByView: Map<viewId, vm[]> } — see
   * createBulkLookupCache in commands.js) skips the O(current-viewMembers-count)
   * viewMembersForView() scan below in favor of an O(1) lookup into an already-indexed,
   * incrementally-maintained array. Without it (the default, for the many one-off
   * interactive callers of this method — dragging a single node, etc.), a single scan is
   * cheap and not worth the caller having to build/thread a cache for. WITH it, this
   * turns what was a confirmed real bottleneck for generateIndustry (this function is
   * called once per passive-node placement, once per stream job — re-scanning the WHOLE,
   * still-growing viewMembers array from scratch every single time, genuinely O(n²) —
   * into O(1) amortized per call. Found via a CPU profile after the earlier
   * createBulkLookupCache fix (which covers createStream's find-or-reuse lookups, not
   * this positioning call) turned out NOT to be the dominant cost it was assumed to be.
   */
  findNonOverlappingPosition(viewId, desiredX, desiredY, excludeVmId, nodeW = 130, nodeH = 46, spacingScale = 1, lookupCache = null) {
    const MARGIN = 8 * (spacingScale || 1);
    const stepX = nodeW + MARGIN, stepY = nodeH + MARGIN;
    let existing;
    if (lookupCache) {
      const cached = lookupCache.partVmsByView.get(viewId) || [];
      existing = excludeVmId ? cached.filter((vm) => vm.id !== excludeVmId) : cached;
    } else {
      existing = this.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part' && vm.id !== excludeVmId);
    }
    const overlaps = (x, y) => existing.some((vm) => Math.abs(vm.x - x) < nodeW + MARGIN / 2 && Math.abs(vm.y - y) < nodeH + MARGIN / 2);

    if (!overlaps(desiredX, desiredY)) return { x: desiredX, y: desiredY };
    for (let ring = 1; ring <= 60; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // ring boundary only
          const x = desiredX + dx * stepX, y = desiredY + dy * stepY;
          if (!overlaps(x, y)) return { x, y };
        }
      }
    }
    return { x: desiredX, y: desiredY }; // give up, better than nothing
  }

  /**
   * Change a view's spacingScale. Freeform views: bakes a one-time position transform,
   * scaling every node's position relative to the view's content centroid by the ratio
   * between the old and new scale (not a live per-render effect — subsequent drags,
   * Remap, etc. all just work with the already-transformed positions). Section-based
   * views: positions are computed from row/col via the grid math, which already reads
   * spacingScale live, so no position rewrite is needed here.
   */
  applySpacingScale(viewId, newScale) {
    const view = this.findView(viewId);
    if (!view) return;
    const oldScale = view.spacingScale || 1;
    const clamped = Math.max(0.25, Math.min(4, newScale || 1));
    if (ciEq(view.viewType, 'ff') && oldScale !== clamped) {
      const partVms = this.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part');
      if (partVms.length > 0) {
        const cx = partVms.reduce((s, vm) => s + vm.x, 0) / partVms.length;
        const cy = partVms.reduce((s, vm) => s + vm.y, 0) / partVms.length;
        const ratio = clamped / oldScale;
        // Compute the scaled positions FIRST, allowing negative values — clamping each
        // node individually to >=0 right here was a real bug: nodes near the left/top
        // edge would get clamped back to exactly 0 while everything else kept scaling
        // outward around the centroid, which visibly compressed the gap to their
        // nearest neighbor and made edge nodes look like they weren't moving at all.
        const scaled = partVms.map((vm) => ({
          vm,
          x: Math.round(cx + (vm.x - cx) * ratio),
          y: Math.round(cy + (vm.y - cy) * ratio),
        }));
        // THEN, if scaling pushed anything negative, shift the WHOLE layout by the same
        // amount so the minimum lands back at (0-ish). A uniform translation preserves
        // every pair's relative spacing exactly, unlike clamping each node on its own.
        const minX = Math.min(...scaled.map((p) => p.x));
        const minY = Math.min(...scaled.map((p) => p.y));
        const shiftX = minX < 0 ? -minX : 0;
        const shiftY = minY < 0 ? -minY : 0;
        for (const { vm, x, y } of scaled) {
          vm.x = x + shiftX;
          vm.y = y + shiftY;
        }
      }
    }
    view.spacingScale = clamped;
  }

  /** The "Spacing" command's selection-scoped counterpart, reported directly: "if
   * multiple nodes selected, apply 'Spacing' command increase or decrease only to
   * selected nodes and update their x,y without changing view spacing value." Scales
   * just the given viewMembers' own x/y relative to THEIR OWN centroid (not the whole
   * view's) by a plain ratio (>1 spreads apart, <1 draws together) — and, unlike
   * applySpacingScale, never touches view.spacingScale at all, since this is a one-off
   * nudge to a specific selection, not a change to the view's persisted layout
   * setting. There's no persisted "current selection scale" to compute a ratio-
   * between-old-and-new from the way the whole-view case has view.spacingScale to
   * read back, so each call is a flat multiplicative step applied directly to the
   * CURRENT positions — repeated +/- clicks compound naturally, same as any other
   * stepper control. Same negative-position guard as applySpacingScale: computes
   * every scaled position first, then shifts the whole affected group by one uniform
   * amount if anything went negative, rather than clamping each node individually
   * (which would visibly compress the gap to whichever node happens to sit nearest
   * the edge). No-op with fewer than 2 real part viewMembers among vmIds — nothing
   * meaningful to scale "around" with just one (or zero).
   *
   * axis ('both'|'horizontal'|'vertical'), reported directly as a follow-up: "Update
   * spacing for vertical, horizontal, or both, when used with selected nodes."
   * 'horizontal' scales only x (y untouched), 'vertical' only y — implemented as
   * simply substituting 1 (no-op ratio) for the OTHER axis rather than a separate code
   * path, so the negative-position guard below still runs identically regardless of
   * which axis (or both) actually moved. */
  applySpacingRatioToVms(vmIds, ratio, axis = 'both') {
    const vms = vmIds.map((id) => this.findViewMember(id)).filter((vm) => vm && vm.objectType === 'part');
    if (vms.length < 2) return;
    const cx = vms.reduce((s, vm) => s + vm.x, 0) / vms.length;
    const cy = vms.reduce((s, vm) => s + vm.y, 0) / vms.length;
    const ratioX = axis === 'vertical' ? 1 : ratio;
    const ratioY = axis === 'horizontal' ? 1 : ratio;
    const scaled = vms.map((vm) => ({
      vm,
      x: Math.round(cx + (vm.x - cx) * ratioX),
      y: Math.round(cy + (vm.y - cy) * ratioY),
    }));
    const minX = Math.min(...scaled.map((p) => p.x));
    const minY = Math.min(...scaled.map((p) => p.y));
    const shiftX = minX < 0 ? -minX : 0;
    const shiftY = minY < 0 ? -minY : 0;
    for (const { vm, x, y } of scaled) {
      vm.x = x + shiftX;
      vm.y = y + shiftY;
    }
  }

  normalizeViewCoordinates(viewId) {
    const partVms = this.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part');
    if (partVms.length === 0) return;
    const minX = Math.min(...partVms.map((vm) => vm.x));
    const minY = Math.min(...partVms.map((vm) => vm.y));
    const shiftX = minX < 0 ? -minX : 0;
    const shiftY = minY < 0 ? -minY : 0;
    if (shiftX !== 0 || shiftY !== 0) {
      for (const vm of partVms) {
        vm.x += shiftX;
        vm.y += shiftY;
      }
    }
  }

  createViewMember({ view, objectType, objectId, x = 0, y = 0, fillColor = '#cccccc', fontColor = '', fontSize = '', borderColor = '', order = 0, note = '', linkedViewName = '', isExternal = false, sectionId = '', fromVmId, toVmId }) {
    const vm = { id: newId(), view, objectType, objectId, x, y, fillColor, fontColor, fontSize, borderColor, order, note, linkedViewName, isExternal: !!isExternal, sectionId };
    if (objectType === 'connector') { vm.fromVmId = fromVmId; vm.toVmId = toVmId; vm.x = null; vm.y = null; }
    this.doc.viewMembers.push(vm);
    return vm;
  }

  // Deleting a node deletes only the viewMember, never the underlying Part/Connector.
  deleteViewMember(id) {
    this.doc.viewMembers = this.doc.viewMembers.filter((vm) => !ciEq(vm.id, id));
  }
  findViewMember(id) { return this.doc.viewMembers.find((vm) => ciEq(vm.id, id)); }

  // ===================== TABS / PAGES =====================
  createTab({ type = 'canvas', title, viewId } = {}) {
    const tab = {
      id: newId(),
      type,
      title: title || viewId || 'Untitled',
      viewId: type === 'canvas' ? viewId : null,
      history: { past: [], present: this.snapshot(), future: [] },
      viewport: { x: 0, y: 0, zoom: 1 },
      selection: new Set(),
      // null = no filter configured yet (show everything) — distinct from an explicit
      // empty array [], which (via either filter menu's "Select All / Exclude All" top
      // row) means "show nothing". Both filters share this same convention.
      activeStreams: null,
      activeElementTypes: null,
      // Same null-vs-[] convention as the two above — filters on Part.section (a plain
      // string field, distinct from selectedSectionId below, which is the 2D Section-view
      // header-click selection, an unrelated concept). A part with no section is offered
      // as its own selectable "(no section)" option, not silently unfilterable.
      activeSections: null,
      // "Connector levels" (numeric, null = unlimited/"All") — only takes effect while
      // a stream or type filter is actively narrowing the view; controls how many hops
      // of connector+node expansion to reveal beyond the directly-matching nodes.
      // Defaults to 0 (no expansion) so introducing this control doesn't silently
      // change the existing filter behavior for anyone already using it.
      connectorLevels: 0,
      selectedSectionId: null,
      // 3D-tab-only: same null-vs-[] convention as activeStreams/activeElementTypes/
      // activeSections above — null = both 'c' (Connectors) and 's' (Streams) shown, the
      // default; an explicit array narrows to just those connectorType code(s). Set via
      // the toolbar's Connector Type filter (main.js), the same dropdown-menu pattern as
      // the other three filters — a 3D tab isn't backed by a view, so this can't live on
      // view.chkShowConnectorType/chkShowStreamType the way the 2D canvas's own
      // equivalent does; this is the 3D-only, tab-scoped counterpart instead.
      activeConnectorTypes: null,
      // 3D-tab-only: a separate, orthogonal on/off toggle from activeConnectorTypes
      // above — a derived connector can be EITHER connectorType, so this isn't a value
      // to add to that list, it's its own boolean gate. Default false (show
      // everything, no behavior change for anyone not using it). Set via the same
      // Connector Type filter dropdown (main.js), as an extra checkbox alongside the
      // 'c'/'s'/'d' list. The 2D canvas's own counterpart is view.chkShowOnlyDerived.
      showOnlyDerivedConnectors: false,
      // 3D-tab-only: which element type(s) get a highlight overlay (a bright wireframe
      // box around every matching instance) — a plain array, default [] (nothing
      // highlighted), NOT the null-vs-[] convention the filters above use, since there's
      // no "highlight everything" default worth having. Purely a visual call-out, not a
      // filter — highlighted AND non-highlighted parts stay equally visible/interactive.
      // Set via the toolbar's Highlight picker (main.js), same dropdown-menu pattern as
      // Type/Connector Type.
      highlightedTypes: [],
      // 3D-tab-only: null (default — the whole document's parts/connectors, today's
      // out-of-the-box behavior, unchanged) or a specific View id — narrows the 3D
      // scene down to exactly what that view actually has placed (its own part AND
      // connector viewMembers), the same content you'd see looking at that view in 2D.
      // Set via the toolbar's View Scope picker (main.js). Distinct from "Current
      // View" (the canvas view SWITCHER, a navigation control) — this is a 3D-only
      // DATA filter, doesn't change what tab you're on.
      view3DScopeViewId: null,
    };
    this.tabs.push(tab);
    return tab;
  }

  findTabByView(viewId) { return this.tabs.find((t) => t.type === 'canvas' && ciEq(t.viewId, viewId)); }
  activeTab() { return this.tabs.find((t) => t.id === this.activeTabId); }

  closeTab(tabId) {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const [tab] = this.tabs.splice(idx, 1);
    this.closedTabs.push(tab);
    if (this.closedTabs.length > 20) this.closedTabs.shift();
    if (this.activeTabId === tabId) {
      const fallback = this.tabs[idx] || this.tabs[idx - 1] || this.tabs[0];
      this.activeTabId = fallback ? fallback.id : null;
      if (fallback && fallback.type === 'canvas') this.currentView = fallback.viewId;
      else this.currentView = null;
    }
  }

  restoreTab(tabId) {
    const idx = this.closedTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return null;
    const [tab] = this.closedTabs.splice(idx, 1);
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    return tab;
  }

  // ===================== HISTORY (undo/redo) — full-doc snapshots per tab =====================
  snapshot() {
    return JSON.parse(JSON.stringify({ parts: this.doc.parts, connectors: this.doc.connectors, viewMembers: this.doc.viewMembers, views: this.doc.views }));
  }
  restoreSnapshot(snap) {
    this.doc.parts = snap.parts;
    this.doc.connectors = snap.connectors;
    this.doc.viewMembers = snap.viewMembers;
    this.doc.views = snap.views;
  }

  recordHistory(tab) {
    if (!tab) return;
    this.dirty = true;
    tab.history.past.push(tab.history.present);
    if (tab.history.past.length > 100) tab.history.past.shift();
    tab.history.present = this.snapshot();
    tab.history.future = [];
  }

  undo(tab) {
    if (!tab || tab.history.past.length === 0) return false;
    tab.history.future.unshift(tab.history.present);
    tab.history.present = tab.history.past.pop();
    this.restoreSnapshot(JSON.parse(JSON.stringify(tab.history.present)));
    return true;
  }

  redo(tab) {
    if (!tab || tab.history.future.length === 0) return false;
    tab.history.past.push(tab.history.present);
    tab.history.present = tab.history.future.shift();
    this.restoreSnapshot(JSON.parse(JSON.stringify(tab.history.present)));
    return true;
  }

  // ===================== SAVE / LOAD =====================
  toJSON() {
    return JSON.parse(JSON.stringify(this.doc));
  }

  loadFromJSON(obj) {
    const migrated = migrateDoc(obj, this.nodeSizeMultiplier);
    this.doc = migrated;
    // A freshly loaded model's parts/connectors are unrelated to whatever was simulated
    // before — stop any active runs and clear all runtime state, rather than risk stale
    // entries pointing at ids that no longer exist (or, worse, silently matching
    // different parts that happen to reuse the same id in the new file).
    for (const entry of this.simRunning.values()) {
      if (entry.timerId) clearTimeout(entry.timerId);
    }
    this.simRunning.clear();
    this.simRuntime.clear();
    this.simLog.clear();
    this.simSelectedModel = this.doc.defaultModel;
  }
}

/** Migrate an older/foreign save file: fill in missing fields with documented defaults.
 * nodeSizeMultiplier defaults to the same 1.2 the Store constructor does, so a direct/
 * standalone call (as tests make) behaves identically to before this param existed;
 * Store's own loadFromJSON passes its live this.nodeSizeMultiplier instead. */
function migrateDoc(obj, nodeSizeMultiplier = 1.2) {
  const doc = {
    version: obj.version || '0.2',
    readme: obj.readme || { note: '' },
    defaultModel: obj.defaultModel || (obj.models?.[0]?.modelName ?? 'Reference'),
    currentView: obj.currentView || 'home',
    // A save file predating this field (or the old memory-only industryData/
    // industryTemplates maps) has nothing to migrate from — falls back to an empty
    // industry dataset, same as if no Load SFCCE had ever run, per this session's "no
    // prior users, no backwards-compat needed" convention.
    industryTree: obj.industryTree ?? [],
    industryTemplateName: obj.industryTemplateName || 'SFCCE',
    models: obj.models && obj.models.length ? obj.models : [{ modelName: 'Reference' }],
    views: obj.views && obj.views.length ? obj.views.map((v) => ({ ...v, viewType: v.viewType || 'ff', sections: v.sections ?? [], nodeWidth: v.nodeWidth ?? defaultNodeSize(nodeSizeMultiplier).nodeWidth, nodeHeight: v.nodeHeight ?? defaultNodeSize(nodeSizeMultiplier).nodeHeight, remapSortKeys: v.remapSortKeys ?? null, remapLastOptions: v.remapLastOptions ?? null, chkShowConnectorType: v.chkShowConnectorType ?? (v.chkShowConnectors ?? true), chkShowStreamType: v.chkShowStreamType ?? (v.chkShowConnectors ?? true), chkShowDataType: v.chkShowDataType ?? true, chkShowOnlyDerived: v.chkShowOnlyDerived ?? false, chkShowDescription: v.chkShowDescription ?? true, chkShowAttributes: v.chkShowAttributes ?? true, chkShowSimValues: v.chkShowSimValues ?? false, chkShowScriptBadge: v.chkShowScriptBadge ?? false, chkShowAllText: v.chkShowAllText ?? false, routingStyle: v.routingStyle ?? 'default', routingStyleStream: v.routingStyleStream ?? 'default', spacingScale: v.spacingScale ?? 1, spacingAxis: v.spacingAxis ?? 'both' })) : [{ id: 'home', viewName: 'home', viewType: 'ff', chkShowConnectorType: true, chkShowStreamType: false, chkShowDataType: true, chkShowOnlyDerived: false, chkShowKeys: false, chkShowElementTypes: true, chkShowDescription: true, chkShowAttributes: true, chkShowOnPageCatalogs: false, chkShowSimValues: false, chkShowScriptBadge: false, chkShowAllText: false, routingStyle: 'default', routingStyleStream: 'default', margin: 50, sections: [], ...defaultNodeSize(nodeSizeMultiplier), remapSortKeys: null, remapLastOptions: null, spacingScale: 1, spacingAxis: 'both' }],
    parts: (obj.parts || []).map((p) => ({
      id: p.id, type: p.type, label: p.label ?? p.id, rawLabel: p.rawLabel ?? p.label ?? p.id,
      model: p.model ?? (obj.defaultModel || 'Reference'),
      streams: p.streams ?? [],
      note: p.note ?? '',
      order: p.order ?? 0,
      other: p.other ?? {},
      xIds: p.xIds ?? '',
      description: p.description ?? '',
      // Only backfills when the field is genuinely absent (a script explicitly saved
      // as '' -- every bundled example's non-scripted parts included -- is left
      // alone) -- same "available by default for all files" default as
      // Store.createPart above, for a raw/foreign document that never had a script
      // field at all.
      script: p.script ?? DEFAULT_PART_SCRIPT,
      scriptEnabled: p.scriptEnabled === true || p.scriptEnabled === 'true',
      section: p.section ?? '',
      pin3D: p.pin3D ?? null,
      attributes: p.attributes ?? [],
      uiTargetPartId: p.uiTargetPartId ?? '',
      uiInputValue: p.uiInputValue ?? null,
      createdAt: p.createdAt ?? '', updatedAt: p.updatedAt ?? '',
    })),
    connectors: (obj.connectors || []).map((c) => ({
      id: c.id, from: c.from, to: c.to,
      model: c.model ?? (obj.defaultModel || 'Reference'),
      streams: c.streams ?? [],
      fromLineEndSettings: c.fromLineEndSettings ?? { path: '', stroke: 'black', strokeNormal: 'black', strokeWidth: 2, strokeWidthNormal: 2, fill: 'red' },
      toLineEndSettings: c.toLineEndSettings ?? { path: '', stroke: 'black', strokeNormal: 'black', strokeWidth: 2, strokeWidthNormal: 2, fill: 'black' },
      note: c.note ?? '',
      connectorType: c.connectorType ?? 'c',
      relationship: c.relationship ?? '',
      stroke: c.stroke ?? '#333', strokeWidth: c.strokeWidth ?? 2,
      strokeNormal: c.strokeNormal ?? c.stroke ?? '#333', strokeWidthNormal: c.strokeWidthNormal ?? c.strokeWidth ?? 2,
      dash: c.dash ?? [], fill: c.fill ?? '#333',
      mirrorOf: c.mirrorOf ?? null,
      fromAttribute: c.fromAttribute ?? '', toAttribute: c.toAttribute ?? '',
      fromCardinality: c.fromCardinality ?? '', toCardinality: c.toCardinality ?? '',
      createdAt: c.createdAt ?? '', updatedAt: c.updatedAt ?? '',
    })),
    viewMembers: (obj.viewMembers || []).map((vm) => ({
      id: vm.id, view: vm.view ?? (obj.currentView || 'home'),
      objectType: vm.objectType, objectId: vm.objectId,
      x: vm.x ?? 0, y: vm.y ?? 0,
      fillColor: vm.fillColor ?? '#cccccc',
      fontColor: vm.fontColor ?? '',
      fontSize: vm.fontSize ?? '',
      borderColor: vm.borderColor ?? '',
      order: vm.order ?? 0,
      note: vm.note ?? '',
      linkedViewName: vm.linkedViewName ?? '',
      isExternal: vm.isExternal === true || vm.isExternal === 'true',
      sectionId: vm.sectionId ?? '',
      fromVmId: vm.fromVmId, toVmId: vm.toVmId,
    })),
    settingsUser: obj.settingsUser ?? { relationshipPairs: [] },
  };
  return doc;
}

function relationCodeFor(relationshipTypeOrCode, settings) {
  const rel = (settings.relations || []).find((r) => ciEq(r.name, relationshipTypeOrCode) || ciEq(r.key, relationshipTypeOrCode));
  return rel ? rel.key : relationshipTypeOrCode;
}

/** The relationship/line-style fields a Connector derives from settings.relationshipStyles
 * — shared by createConnector and restyleConnector so both compute them identically. */
function connectorStyleFields(relationship, settings) {
  const style = (settings.relationshipStyles || []).find((s) => ciEq(s.code, relationCodeFor(relationship, settings)));
  const lineEnds = settings.lineEnds || {};
  const fromLE = lineEnds[style?.fromLineEndSettingType] || { path: '', stroke: 'black', strokeNormal: 'black', strokeWidth: 2, strokeWidthNormal: 2, fill: 'red' };
  const toLE = lineEnds[style?.toLineEndSettingType] || { path: '', stroke: 'black', strokeNormal: 'black', strokeWidth: 2, strokeWidthNormal: 2, fill: 'black' };
  return {
    relationship: style?.type || relationship,
    fromLineEndSettings: { ...fromLE },
    toLineEndSettings: { ...toLE },
    stroke: style?.stroke || '#333', strokeWidth: style?.strokeWidth ?? 2,
    strokeNormal: style?.stroke || '#333', strokeWidthNormal: style?.strokeWidth ?? 2,
    dash: style?.dash || [], fill: style?.fill || '#333',
  };
}

export { Store, newId, ciEq, migrateDoc, relationCodeFor, nowStamp, UI_DASHBOARD_TYPES, isUIDashboardType, DEFAULT_PART_SCRIPT };
