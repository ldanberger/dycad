// commands.js — Duplicate Stream, Split Node, Level Up, Level Down, Generate (createStream)
import { ciEq } from './state.js';
import { elementByType, findRelationshipPair } from './rules.js';
import { isSectionViewType, createSectionPlacer, computeSectionLayout, isTypeAllowedInSection, findFreeCellInSection, duplicateSectionDefinition, BASE_X, BASE_Y, SECTION_GAP, NODE_INSET_X, NODE_INSET_Y } from './sections.js';
import { redrawNodeSizes, redrawAndResolveLayout, getNodeSize } from './canvas.js';
import { computeClusteredGridLayout } from './layout.js';
import { pushMessageLog } from './simulation.js';

function elementGroupFill(store, type) {
  const el = elementByType(store, type);
  const group = (store.settings.elementGroups || []).find((g) => ciEq(g.group, el?.group));
  return group?.fill || '#cccccc';
}

// ===================== GENERATE / createStream =====================
// This function is deliberately generic (templateName, streamName, functionName, capabilityName,
// entityName, modelName, viewName) so it can be reused later with different parameters.
// Only the toolbox "Generate" button hard-codes defaultModel/currentView.
/**
 * Builds an in-memory index of the store's parts/viewMembers/connectors for bulk
 * operations (generateIndustry) that call createStream many times into the same,
 * growing view. Without this, every createStream call's several find-or-reuse lookups
 * are full scans of store.doc.parts/viewMembers/connectors — fine for a single call,
 * but those arrays grow with every call in a bulk loop, turning n calls into O(n²)
 * total work (confirmed as the actual cause of Generate Industry becoming unresponsive
 * on a large imported dataset). Passed as an optional last argument to createStream,
 * createPassiveNode, and findOrCreateStreamConnector below; every one of them falls
 * back to the original direct-array-scan behavior when it's not provided, so existing
 * single-call callers (the manual Generate Stream command, levelDown, etc.) are
 * completely unaffected — this is purely opt-in.
 */
function createBulkLookupCache(store) {
  const cache = {
    partsByKey: new Map(),         // `${label}|${type}|${model}`.toLowerCase() -> part
    partsByXid: new Map(),         // `${xIds}|${model}`.toLowerCase() -> part
    partsById: new Map(),          // id -> part
    vmsByPartView: new Map(),      // `${partId}|${viewId}` -> viewMember
    // viewId -> array of every part-viewMember in that view — lets
    // Store.findNonOverlappingPosition skip re-scanning the whole (possibly huge,
    // still-growing) doc.viewMembers array on every single call; see that method's own
    // comment for why this mattered. Kept correct incrementally by cacheRegisterVm below,
    // same as every other map here.
    partVmsByView: new Map(),
    connsByFromToModel: new Map(), // `${fromId}|${toId}|${model}`.toLowerCase() -> connector (connectorType 's' only)
    connVmsByConnView: new Map(),  // `${connId}|${viewId}` -> viewMember
  };
  for (const p of store.doc.parts) cacheRegisterPart(cache, p);
  for (const c of store.doc.connectors) if (ciEq(c.connectorType, 's')) cacheRegisterStreamConn(cache, c);
  for (const vm of store.doc.viewMembers) {
    if (vm.objectType === 'part') cacheRegisterVm(cache, vm);
    else if (vm.objectType === 'connector') cacheRegisterConnVm(cache, vm);
  }
  return cache;
}
function cacheRegisterPart(cache, part) {
  cache.partsByKey.set(`${part.label}|${part.type}|${part.model}`.toLowerCase(), part);
  if (part.xIds) cache.partsByXid.set(`${part.xIds}|${part.model}`.toLowerCase(), part);
  cache.partsById.set(part.id, part);
}
function cacheRegisterVm(cache, vm) {
  cache.vmsByPartView.set(`${vm.objectId}|${vm.view}`, vm);
  if (!cache.partVmsByView.has(vm.view)) cache.partVmsByView.set(vm.view, []);
  cache.partVmsByView.get(vm.view).push(vm);
}
function cacheRegisterStreamConn(cache, conn) {
  cache.connsByFromToModel.set(`${conn.from}|${conn.to}|${conn.model}`.toLowerCase(), conn);
}
function cacheRegisterConnVm(cache, vm) {
  cache.connVmsByConnView.set(`${vm.objectId}|${vm.view}`, vm);
}

function createStream(app, {
  templateName, streamName, functionName, capabilityName, entityName, modelName, viewName, anchorX, anchorY,
  functionDescription = '', functionxIds = '', functionSection = '',
  capabilityDescription = '', capabilityxIds = '',
  applicationCapabilityName, applicationCapabilityDescription = '', applicationCapabilityxIds = '',
  entityDescription = '', entityxIds = '',
  silent = false, lookupCache = null, placeInView = true,
}) {
  const { store } = app;
  const template = (store.settings.streamTemplates || []).find((t) => ciEq(t.name, templateName));
  if (!template) { app.toast(`Stream template "${templateName}" not found.`, true); return null; }

  // Validate capabilityNameBegin / applicationCapabilityNameBegin / entityNameBegin resolve to
  // real element types before doing anything. applicationCapabilityNameBegin is optional — only
  // the 'SFCCE' template (and anything else that opts in) declares it; every other
  // existing template has no such field, so capBeginEl/appCapBeginEl checks below are
  // skipped entirely for them, matching their unchanged pre-existing behavior.
  const capBeginEl = elementLookupExact(store, template.capabilityNameBegin);
  const appCapBeginEl = elementLookupExact(store, template.applicationCapabilityNameBegin);
  const entBeginEl = elementLookupExact(store, template.entityNameBegin);
  if (template.capabilityNameBegin && !capBeginEl) {
    app.toast(`Template "${templateName}": capabilityNameBegin "${template.capabilityNameBegin}" is not a known element type. Aborted.`, true);
    return null;
  }
  if (template.applicationCapabilityNameBegin && !appCapBeginEl) {
    app.toast(`Template "${templateName}": applicationCapabilityNameBegin "${template.applicationCapabilityNameBegin}" is not a known element type. Aborted.`, true);
    return null;
  }
  if (template.entityNameBegin && !entBeginEl) {
    app.toast(`Template "${templateName}": entityNameBegin "${template.entityNameBegin}" is not a known element type. Aborted.`, true);
    return null;
  }

  // placeInView=false (Generate Industry's "Place on current view" checkbox, unchecked):
  // build the underlying Parts/Connectors only — no view, no tab, no viewMembers, no
  // positions computed at all. Skips essentially every cost a large bulk run pays for
  // placement (findNonOverlappingPosition, redrawNodeSizes/resolveOverlapsForView after
  // the loop, every createViewMember call) — for reviewing/staging a large dataset before
  // selectively bringing chosen parts into a view via Add Existing, not dumping tens of
  // thousands of nodes onto one canvas view none of which is usable at that size anyway.
  const view = placeInView ? (store.findView(viewName) || store.addView(viewName)) : null;
  const tab = placeInView ? (store.findTabByView(view.id) || app.openOrSwitchView(view.id, { silent: true })) : null;
  if (placeInView) view.chkShowStreamType = true; // otherwise the stream connectors this command creates would be invisible

  const capBeginIdx = template.value.findIndex((v) => ciEq(v, template.capabilityNameBegin));
  const appCapBeginIdx = template.value.findIndex((v) => ciEq(v, template.applicationCapabilityNameBegin));
  const entBeginIdx = template.value.findIndex((v) => ciEq(v, template.entityNameBegin));

  // Default anchor (no explicit right-click position): stack below whatever's already
  // in this view instead of always resetting to a fixed spot, which was causing repeated
  // Generate calls to land exactly on top of each other. None of this matters at all
  // without a view.
  let baseX = 0, baseY = 0, stepX = 0, stepY = 0, genSpacing = 1;
  if (placeInView) {
    let defaultBaseX = 60, defaultBaseY = 60;
    if (anchorX == null || anchorY == null) {
      const existingPartVms = store.viewMembersForView(view.id).filter((vm) => vm.objectType === 'part');
      if (existingPartVms.length > 0) {
        const { h: existingNodeH } = getNodeSize(view);
        const maxBottom = Math.max(...existingPartVms.map((vm) => (vm.y ?? 0) + existingNodeH));
        defaultBaseY = maxBottom + 60;
      }
    }
    genSpacing = view.spacingScale || 1;
    const { w: genNodeW, h: genNodeH } = getNodeSize(view);
    baseX = anchorX ?? defaultBaseX; baseY = anchorY ?? defaultBaseY; stepX = genNodeW + 40 * genSpacing; stepY = genNodeH + 44 * genSpacing;
  }
  const createdVms = [];
  // Tracked directly as VMs are actually created below, rather than diffing
  // viewMembersForView(view.id) before/after — that diff needed two full scans of the
  // view's accumulated viewMembers, which is fine for a single call but turns a bulk
  // caller that invokes createStream many times into a view (generateIndustry) into
  // O(n²) work as the view grows. Same output, no scan needed either way.
  const newlyCreatedVmIds = [];
  const placer = (placeInView && isSectionViewType(view.viewType)) ? (store.ensureViewSections(view), createSectionPlacer(store, view)) : null;
  let step = 0;

  for (let i = 0; i < template.value.length; i++) {
    const rawType = template.value[i];
    let el = elementByType(store, rawType); // falls back to 'Unknown' internally
    if (!ciEq(el?.type, rawType) && !elementLookupExact(store, rawType)) {
      // requested type truly doesn't exist -> Unknown, per spec
      el = elementByType(store, 'Unknown');
    }
    const resolvedType = el?.type || 'Unknown';

    let label;
    let category;
    if (ciEq(resolvedType, 'businessFunction')) {
      label = joinLabel(el, functionName); category = 'function';
    } else if (entBeginIdx >= 0 && i >= entBeginIdx) {
      label = joinLabel(el, entityName); category = 'entity';
    } else if (appCapBeginIdx >= 0 && i >= appCapBeginIdx) {
      label = joinLabel(el, applicationCapabilityName); category = 'applicationCapability';
    } else if (capBeginIdx >= 0 && i >= capBeginIdx) {
      label = joinLabel(el, capabilityName); category = 'capability';
    } else {
      label = functionName; category = 'function';
    }
    // xId-based reuse only applies to the position whose type is the PRECISE semantic
    // match for its category — the broad index range (capBeginIdx..entBeginIdx, etc.)
    // spans many different supporting element types (GeneralActor, ApplicationService,
    // TechnologyProcess, ...); only the one literally typed BusinessCapability/
    // DataDataEntity represents "the" capability/entity and should be find-or-reused.
    // Everything else in that range is a fresh per-stream supporting node, as before.
    // applicationCapability's canonical type is 'ApplicationCapability', matching the same
    // hardcoded-canonical-type convention as the other three categories rather than
    // reading it dynamically off the template.
    const isPreciseCategoryMatch =
      (category === 'function' && ciEq(resolvedType, 'BusinessFunction')) ||
      (category === 'capability' && ciEq(resolvedType, 'BusinessCapability')) ||
      (category === 'applicationCapability' && ciEq(resolvedType, 'ApplicationCapability')) ||
      (category === 'entity' && ciEq(resolvedType, 'DataDataEntity'));
    const catDescription = isPreciseCategoryMatch
      ? (category === 'function' ? functionDescription : category === 'capability' ? capabilityDescription : category === 'applicationCapability' ? applicationCapabilityDescription : entityDescription)
      : '';
    const catXId = isPreciseCategoryMatch
      ? (category === 'function' ? functionxIds : category === 'capability' ? capabilityxIds : category === 'applicationCapability' ? applicationCapabilityxIds : entityxIds)
      : '';
    // The Section identifier itself only ever lives on the FUNCTION level in the source
    // data (see js/sfce.js's module doc: Section groups Functions, not Capabilities or
    // Entities) — but every part this one createStream call creates (capability,
    // application capability, entity, and every supporting node in between) belongs to
    // that same function's own stream, so all of them inherit its section too. This is
    // what makes filtering the 3D View (or the 2D canvas) to one section show the WHOLE
    // related chain, not just the top-level function node — the original narrower
    // behavior (function-only) meant a Section filter hid everything downstream of it.
    // Only applied when actually CREATING a part, never when reusing an existing one
    // (below) — a shared part (e.g. a capability referenced by streams from two
    // different sections) keeps whatever section it was first created with, rather than
    // silently flipping to whichever stream happens to run last.
    const catSection = functionSection;

    step += 1;
    const isUnknownFallback = ciEq(resolvedType, 'Unknown') && !ciEq(rawType, 'Unknown');
    const noteText = isUnknownFallback ? `g${step} (unknown type: ${rawType})` : `g${step}`;

    // find-or-create the Part: reuse an existing one with a matching xIds + model, if
    // given (precise category positions). Otherwise (Step 33, fixed post-Step-37 bug
    // report) reuse by LABEL + TYPE + MODEL — the type check matters because many
    // template chain positions render to the SAME label text (e.g. GeneralCapability/
    // ApplicationCapability/TechnologyCapability all have blank prefix/suffix, so they
    // all render as bare capabilityName) despite being genuinely different layers of the
    // chain; matching on label alone collapsed them onto one shared part, and since the
    // chain connects strictly by array position, that produced both-direction connector
    // pairs between the same two parts (a regression of the exact over-broad-reuse
    // failure mode a much earlier fix — see the Step 15 history — was built to prevent).
    // Reusing never changes the existing part's own type/label.
    const existingPart = catXId
      ? (lookupCache ? lookupCache.partsByXid.get(`${catXId}|${modelName}`.toLowerCase()) : store.doc.parts.find((p) => p.xIds && ciEq(p.xIds, catXId) && ciEq(p.model, modelName)))
      : (lookupCache ? lookupCache.partsByKey.get(`${label}|${resolvedType}|${modelName}`.toLowerCase()) : store.doc.parts.find((p) => ciEq(p.label, label) && ciEq(p.type, resolvedType) && ciEq(p.model, modelName)));
    let part;
    if (existingPart) {
      part = existingPart;
      if (!(part.streams || []).includes(streamName)) part.streams = [...(part.streams || []), streamName];
    } else {
      part = store.createPart({
        type: resolvedType, label, model: modelName, streams: [streamName],
        note: noteText, order: 0, other: { src: rawType },
        description: catDescription, xIds: catXId, section: catSection,
      });
      if (lookupCache) cacheRegisterPart(lookupCache, part);
    }

    // find-or-create the ViewMember: reuse one already in this exact view for the reused
    // part, if any — otherwise this would create a duplicate node for the same entity.
    // No view at all -> no viewMember, period; vm stays null throughout.
    let vm = null;
    if (placeInView) {
      vm = existingPart
        ? (lookupCache ? lookupCache.vmsByPartView.get(`${part.id}|${view.id}`) : store.doc.viewMembers.find((v) => v.objectType === 'part' && ciEq(v.objectId, part.id) && ciEq(v.view, view.id)))
        : null;
      if (!vm) {
        const pos = placer ? placer(resolvedType) : { x: baseX + i * stepX, y: baseY, sectionId: '' };
        vm = store.createViewMember({
          view: view.id, objectType: 'part', objectId: part.id,
          x: pos.x, y: pos.y, sectionId: pos.sectionId, fillColor: elementGroupFill(store, resolvedType), note: noteText,
        });
        newlyCreatedVmIds.push(vm.id);
        if (lookupCache) cacheRegisterVm(lookupCache, vm);
      }
    }
    createdVms.push({ vm, part });

    if (i > 0) {
      const prev = createdVms[i - 1];
      // Compare Part identity, not vm identity (vm is null without a view) — equivalent
      // either way, since a viewMember only ever gets reused when it's the same part.
      if (prev.part.id !== part.id) {
        findOrCreateStreamConnector(store, view, prev.part, part, prev.vm, vm, modelName, streamName, 'Stream', undefined, lookupCache, placeInView);
      }
    }
  }

  // passive: create/find node of `from` type and `to` type (within this stream's newly created set), connect them
  let passiveRow = 0;
  const passivePos = (col) => {
    const desired = { x: baseX + col * stepX, y: baseY + stepY * (passiveRow), sectionId: '' };
    const { w: freeNodeW, h: freeNodeH } = getNodeSize(view);
    const free = store.findNonOverlappingPosition(view.id, desired.x, desired.y, undefined, freeNodeW, freeNodeH, view.spacingScale || 1, lookupCache);
    return { x: free.x, y: free.y, sectionId: '' };
  };
  const expectedPassiveLabel = (type) => {
    const el = elementByType(store, type);
    const resolvedType = el?.type || 'Unknown';
    return ciEq(resolvedType, 'businessFunction') ? joinLabel(el, functionName) : joinLabel(el, capabilityName || entityName || type);
  };
  for (const p of template.passive || []) {
    passiveRow += 1;
    const fromMatch = createdVms.find((c) => ciEq(c.part.type, p.from)) || findExistingStreamNode(store, view?.id, streamName, p.from, expectedPassiveLabel(p.from), modelName, lookupCache, placeInView);
    const toMatch = createdVms.find((c) => ciEq(c.part.type, p.to)) || findExistingStreamNode(store, view?.id, streamName, p.to, expectedPassiveLabel(p.to), modelName, lookupCache, placeInView);

    let fromEntry = fromMatch, toEntry = toMatch;
    if (!fromEntry && !toEntry) {
      fromEntry = createPassiveNode(app, view?.id, p.from, streamName, modelName, functionName, capabilityName, entityName, placer ? placer(p.from) : (placeInView ? passivePos(0) : null), `p${passiveRow}a`, functionDescription, functionxIds, lookupCache, functionSection, placeInView);
      toEntry = createPassiveNode(app, view?.id, p.to, streamName, modelName, functionName, capabilityName, entityName, placer ? placer(p.to) : (placeInView ? passivePos(1) : null), `p${passiveRow}b`, functionDescription, functionxIds, lookupCache, functionSection, placeInView);
      createdVms.push(fromEntry, toEntry);
    } else if (!fromEntry) {
      fromEntry = createPassiveNode(app, view?.id, p.from, streamName, modelName, functionName, capabilityName, entityName, placer ? placer(p.from) : (placeInView ? passivePos(0) : null), `p${passiveRow}a`, functionDescription, functionxIds, lookupCache, functionSection, placeInView);
      createdVms.push(fromEntry);
    } else if (!toEntry) {
      toEntry = createPassiveNode(app, view?.id, p.to, streamName, modelName, functionName, capabilityName, entityName, placer ? placer(p.to) : (placeInView ? passivePos(1) : null), `p${passiveRow}b`, functionDescription, functionxIds, lookupCache, functionSection, placeInView);
      createdVms.push(toEntry);
    }
    for (const entry of [fromEntry, toEntry]) if (entry.wasNew) newlyCreatedVmIds.push(entry.vm.id);

    const conn = findOrCreateStreamConnector(store, view, fromEntry.part, toEntry.part, fromEntry.vm, toEntry.vm, modelName, streamName, 'Passive', `p${passiveRow}c`, lookupCache, placeInView);
  }

  if (placeInView) {
    const newVmIds = newlyCreatedVmIds;
    const genTab = store.findTabByView(view.id);
    if (genTab) { genTab.selection.clear(); for (const id of newVmIds) genTab.selection.add(id); }
  }

  if (!silent) {
    app.recordAndRender();
    app.toast(`Generated stream "${streamName}" from template "${templateName}".`);
  }
  return { view, createdVms };
}

// ===================== AUTO-COMPLETE STREAMS IN MODEL =====================
// Smart Check's other mode: rather than filling gaps between a view and its underlying
// model, this fills gaps between a stream's ACTUAL parts/placement and what generating it
// with the given template would have produced. Deliberately uses the stream's own NAME as
// the bare name for every category (function/capability/entity) — a stream tag on a part
// is independent of whatever name was originally typed into Generate Stream's Function/
// Capability/Entity Name fields (confirmed: those are free-form, unrelated to the stream
// name field), and a Part only stores its FINAL prefixed/suffixed label, not that
// original bare name — so there's no reliable way to recover "the" name a partially-built
// stream was meant to use. Using the stream name itself matches how Generate Industry
// already works today (there, entityName IS streamName, always), and needs no inference.

/** For one (streamName, template) pair, enumerates every position the template's main
 * chain + passive list would produce (same category/label logic as createStream itself),
 * de-duplicated by (type, label) since more than one position can coincide, and reports
 * whether the Part and a this-view ViewMember already exist for each — read-only, creates
 * nothing. `origins` records which template slot(s) map to each row, kept only for
 * potential debugging; not used by the UI. */
function analyzeStreamCompleteness(store, template, streamName, modelName, viewId) {
  const capBeginIdx = template.value.findIndex((v) => ciEq(v, template.capabilityNameBegin));
  const entBeginIdx = template.value.findIndex((v) => ciEq(v, template.entityNameBegin));

  const slots = []; // { resolvedType, label, origin }
  for (let i = 0; i < template.value.length; i++) {
    const rawType = template.value[i];
    let el = elementByType(store, rawType);
    if (!ciEq(el?.type, rawType) && !elementLookupExact(store, rawType)) el = elementByType(store, 'Unknown');
    const resolvedType = el?.type || 'Unknown';
    // category doesn't affect the label here (name is always streamName regardless of
    // function/capability/entity), only which real createStream run would use which name
    // — kept out of this dry-run since it's a non-issue under the "name = streamName"
    // rule, but the prefix/suffix (via joinLabel) still varies per resolvedType.
    slots.push({ resolvedType, label: joinLabel(el, streamName), origin: { kind: 'chain', index: i } });
  }
  for (let p = 0; p < (template.passive || []).length; p++) {
    const pair = template.passive[p];
    for (const side of ['from', 'to']) {
      const type = pair[side];
      const el = elementByType(store, type);
      const resolvedType = el?.type || 'Unknown';
      slots.push({ resolvedType, label: joinLabel(el, streamName), origin: { kind: 'passive', index: p, side } });
    }
  }

  const rowByKey = new Map();
  for (const slot of slots) {
    const key = `${slot.resolvedType}|${slot.label}`.toLowerCase();
    let row = rowByKey.get(key);
    if (!row) {
      // Same reuse rule createStream itself uses for the main chain/passive nodes: match
      // by label+type+model, independent of that part's OWN current streams tags (a part
      // already shared by another stream is still the right part to reuse/complete here).
      const part = store.doc.parts.find((p) => ciEq(p.label, slot.label) && ciEq(p.type, slot.resolvedType) && ciEq(p.model, modelName));
      const vm = part ? store.doc.viewMembers.find((v) => v.objectType === 'part' && ciEq(v.objectId, part.id) && ciEq(v.view, viewId)) : null;
      row = {
        streamName, type: slot.resolvedType, label: slot.label,
        partExists: !!part, viewExists: !!vm, partId: part ? part.id : null,
        origins: [],
      };
      rowByKey.set(key, row);
    }
    row.origins.push(slot.origin);
  }
  return [...rowByKey.values()];
}

/** Every stream name tagged on any part in `modelName`, each analyzed against `template`
 * — returns only rows with something missing (part and/or this-view placement), sorted
 * (stream, type, label) as the review dialog wants. Fully-complete positions (part AND
 * view both already present) are omitted; there's nothing to check for those. */
function scanStreamsForAutoComplete(store, templateName, modelName, viewId) {
  const template = (store.settings.streamTemplates || []).find((t) => ciEq(t.name, templateName));
  if (!template) return [];
  const streamNames = new Set();
  for (const p of store.doc.parts) {
    if (!ciEq(p.model, modelName)) continue;
    for (const s of p.streams || []) streamNames.add(s);
  }
  const rows = [];
  for (const streamName of streamNames) {
    for (const row of analyzeStreamCompleteness(store, template, streamName, modelName, viewId)) {
      if (!row.partExists || !row.viewExists) rows.push(row);
    }
  }
  rows.sort((a, b) => a.streamName.localeCompare(b.streamName) || a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
  return rows;
}

/**
 * Creation half of Auto-Complete Streams in Model. `decisions` is a Map keyed by
 * `${type}|${label}`.toLowerCase() (matching analyzeStreamCompleteness's row identity)
 * to `{ createPart, createView }`, reflecting the review dialog's checkboxes — a
 * position with no entry (row was already complete, so the dialog never showed it) is
 * still looked up and reused normally, just never created.
 *
 * Walks template.value[] then template.passive[], exactly like createStream, resolving
 * each position by the same label+type+model reuse rule (bare name = streamName for
 * every category, per the design note above analyzeStreamCompleteness). Unlike
 * createStream, a position can come back with no part at all (existing part absent AND
 * its row's createPart left unchecked) — a connector is only ever created between two
 * positions that are BOTH resolved AND immediately adjacent in the template; a skipped
 * position breaks the chain there rather than being bridged over, since the relationship
 * pair a connector represents is only meaningful between the template's own designated
 * adjacent types, not between whatever two parts happen to exist on either side of a
 * gap. A resolved position that has a part but no view placement (row's createView left
 * unchecked, or existing part never placed in this view) still participates in connector
 * creation at the model level, just without a viewMember edge for it in this view —
 * matches createStream's own placeInView=false connector semantics (see
 * findOrCreateStreamConnector).
 */
function autoCompleteStreams(app, template, streamName, modelName, viewId, decisions, lookupCache = null, silent = false) {
  const { store } = app;
  const view = store.findView(viewId);
  if (!view) { if (!silent) app.toast('Auto-Complete Streams: view not found.', true); return null; }
  store.ensureViewSections(view);
  const placer = isSectionViewType(view.viewType) ? createSectionPlacer(store, view) : null;

  const { w: nodeW, h: nodeH } = getNodeSize(view);
  const existingPartVms = store.viewMembersForView(view.id).filter((vm) => vm.objectType === 'part');
  const baseY = existingPartVms.length > 0 ? Math.max(...existingPartVms.map((vm) => (vm.y ?? 0) + nodeH)) + 60 : 60;
  const baseX = 60, stepX = nodeW + 40 * (view.spacingScale || 1);
  let col = 0;
  const nextPos = () => {
    const desired = { x: baseX + (col++) * stepX, y: baseY };
    return store.findNonOverlappingPosition(view.id, desired.x, desired.y, undefined, nodeW, nodeH, view.spacingScale || 1, lookupCache);
  };

  const newVmIds = [];
  let newPartsCount = 0;
  const resolve = (rawType) => {
    // Must match analyzeStreamCompleteness's type-resolution fallback exactly, or the
    // resolvedType computed here can diverge from the row identity the decisions Map
    // was keyed by, silently dropping the user's checkbox choice for that position.
    let el = elementByType(store, rawType);
    if (!ciEq(el?.type, rawType) && !elementLookupExact(store, rawType)) el = elementByType(store, 'Unknown');
    const resolvedType = el?.type || 'Unknown';
    const label = joinLabel(el, streamName);
    const decision = decisions.get(`${resolvedType}|${label}`.toLowerCase()) || { createPart: false, createView: false };

    let part = lookupCache
      ? lookupCache.partsByKey.get(`${label}|${resolvedType}|${modelName}`.toLowerCase())
      : store.doc.parts.find((p) => ciEq(p.label, label) && ciEq(p.type, resolvedType) && ciEq(p.model, modelName));
    if (!part) {
      if (!decision.createPart) return null;
      part = store.createPart({ type: resolvedType, label, model: modelName, streams: [streamName], note: 'ac', other: { src: rawType } });
      if (lookupCache) cacheRegisterPart(lookupCache, part);
      newPartsCount += 1;
    } else if (!(part.streams || []).includes(streamName)) {
      part.streams = [...(part.streams || []), streamName];
    }

    let vm = lookupCache
      ? lookupCache.vmsByPartView.get(`${part.id}|${view.id}`)
      : store.doc.viewMembers.find((v) => v.objectType === 'part' && ciEq(v.objectId, part.id) && ciEq(v.view, view.id));
    if (!vm && decision.createView) {
      const pos = placer ? placer(resolvedType) : nextPos();
      vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x: pos.x, y: pos.y, sectionId: pos.sectionId || '', fillColor: elementGroupFill(store, resolvedType), note: 'ac' });
      if (lookupCache) cacheRegisterVm(lookupCache, vm);
      newVmIds.push(vm.id);
    }
    return { part, vm };
  };

  let prev = null; // immediately-preceding position's resolved entry, or null if that position was skipped — never reaches further back than one position, so a gap breaks the chain instead of being bridged over
  for (const rawType of template.value) {
    const entry = resolve(rawType);
    if (prev && entry && prev.part.id !== entry.part.id) {
      findOrCreateStreamConnector(store, view, prev.part, entry.part, prev.vm, entry.vm, modelName, streamName, 'Stream', undefined, lookupCache, !!(prev.vm && entry.vm));
    }
    prev = entry;
  }

  for (const p of template.passive || []) {
    const fromEntry = resolve(p.from);
    const toEntry = resolve(p.to);
    if (!fromEntry || !toEntry) continue;
    findOrCreateStreamConnector(store, view, fromEntry.part, toEntry.part, fromEntry.vm, toEntry.vm, modelName, streamName, 'Passive', undefined, lookupCache, !!(fromEntry.vm && toEntry.vm));
  }

  const tab = store.findTabByView(view.id);
  if (tab && newVmIds.length) { tab.selection.clear(); for (const id of newVmIds) tab.selection.add(id); }

  if (!silent) {
    app.recordAndRender();
    app.toast(`Auto-completed stream "${streamName}".`);
  }
  return { view, newVmIds, newPartsCount };
}

/**
 * Whenever a connectorType 's' (stream) connector is created, also create a companion
 * connectorType 'c' (connector) between the same parts, using relationshipPairs.default
 * (mapped to its relations.name) as the relationship. Carries the same streams/model so
 * the pair travels together (e.g. through Duplicate Stream). Creates the companion's
 * viewMember alongside the stream connector's, in the same view with the same endpoints.
 */
function createCompanionConnector(store, streamConn, viewId, fromVmId, toVmId, lookupCache = null, placeInView = true) {
  const fromPart = lookupCache ? lookupCache.partsById.get(streamConn.from) : store.findPart(streamConn.from);
  const toPart = lookupCache ? lookupCache.partsById.get(streamConn.to) : store.findPart(streamConn.to);
  if (!fromPart || !toPart) return null;
  const pair = findRelationshipPair(store, fromPart.type, toPart.type);
  const defaultKey = pair?.default;
  const relation = defaultKey ? (store.settings.relations || []).find((r) => r.key === defaultKey) : null;
  const companion = store.createConnector({
    from: streamConn.from, to: streamConn.to, model: streamConn.model,
    connectorType: 'c', relationship: relation?.name || 'Association', streams: [...(streamConn.streams || [])],
  });
  if (placeInView) store.createViewMember({ view: viewId, objectType: 'connector', objectId: companion.id, fromVmId, toVmId });
  return companion;
}

function elementLookupExact(store, type) {
  if (!type) return null;
  return (store.settings.elements || []).find((e) => ciEq(e.type, type)) || null;
}

/**
 * Step 33: find-or-reuse an 's' (stream) connector between two parts in this MODEL
 * (regardless of which view created it), adding streamName to its streams if reused,
 * rather than creating a fresh parallel connector every time a stream/industry/template
 * generation touches the same two parts again. Creates the viewMember (+ companion 'c'
 * connector) for THIS view if one doesn't already exist there.
 */
function findOrCreateStreamConnector(store, view, fromPart, toPart, fromVm, toVm, modelName, streamName, relationship, note, lookupCache = null, placeInView = true) {
  let conn = lookupCache
    ? lookupCache.connsByFromToModel.get(`${fromPart.id}|${toPart.id}|${modelName}`.toLowerCase())
    : store.doc.connectors.find((c) => ciEq(c.from, fromPart.id) && ciEq(c.to, toPart.id) && ciEq(c.model, modelName) && ciEq(c.connectorType, 's'));
  let isNewConn = false;
  if (conn) {
    if (!(conn.streams || []).includes(streamName)) conn.streams = [...(conn.streams || []), streamName];
  } else {
    conn = store.createConnector({ from: fromPart.id, to: toPart.id, model: modelName, connectorType: 's', relationship, streams: [streamName] });
    if (note !== undefined) conn.note = note;
    if (lookupCache) cacheRegisterStreamConn(lookupCache, conn);
    isNewConn = true;
  }

  if (!placeInView) {
    // No view -> no per-view connVm concept at all, so "companion once per (streamConn,
    // view)" (below) has no meaning here; the natural equivalent without a view is
    // "companion once per stream connector", i.e. only when conn itself is newly created.
    if (isNewConn) createCompanionConnector(store, conn, null, null, null, lookupCache, false);
    return conn;
  }

  let connVm = lookupCache
    ? lookupCache.connVmsByConnView.get(`${conn.id}|${view.id}`)
    : store.doc.viewMembers.find((v) => v.objectType === 'connector' && ciEq(v.objectId, conn.id) && ciEq(v.view, view.id));
  if (!connVm) {
    connVm = store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: fromVm.id, toVmId: toVm.id });
    createCompanionConnector(store, conn, view.id, fromVm.id, toVm.id, lookupCache, true);
    if (lookupCache) cacheRegisterConnVm(lookupCache, connVm);
  }
  return conn;
}

function joinLabel(el, name) {
  return [el?.prefix, name, el?.suffix].filter((s) => s && String(s).trim().length).join(' ').trim() || name;
}

/** Reverses joinLabel for one specific element type's CURRENT prefix/suffix — used only
 * by deriveStreamNames below to recover a raw name from an already-generated label. Not
 * a general-purpose inverse: a label whose raw name was left blank (so the label is just
 * the bare prefix/suffix) can't be told apart from a raw name that happens to equal the
 * prefix/suffix text — an acceptable, rare imperfection for a "prepopulate a dialog
 * field, still editable" convenience, not data used for anything authoritative. */
function unjoinLabel(el, label) {
  const prefix = (el?.prefix || '').trim();
  const suffix = (el?.suffix || '').trim();
  let name = String(label ?? '');
  if (prefix && name.startsWith(`${prefix} `)) name = name.slice(prefix.length + 1);
  if (suffix && name.endsWith(` ${suffix}`)) name = name.slice(0, name.length - suffix.length - 1);
  return name;
}

/**
 * Best-effort reconstruction of the raw function/capability/applicationCapability/entity names
 * that produced an existing stream's parts — for the Generate Stream dialog's "pick an
 * existing stream to prepopulate the rest of the fields from" flow. Reads only the 4
 * canonical "precise category match" types createStream itself singles out
 * (BusinessFunction/BusinessCapability/ApplicationCapability/DataDataEntity — see
 * createStream's own isPreciseCategoryMatch comment), since those converge on the exact
 * same joinLabel(el, rawName) shape regardless of which stream template originally
 * generated them — this works without needing to know (or guess) that template. A type
 * with no part tagged in this stream comes back null (e.g. every stream lacks a
 * Application Capability unless it was generated via a template with applicationCapabilityNameBegin),
 * letting the caller leave that dialog field's own default untouched rather than
 * blanking it.
 */
function deriveStreamNames(store, streamName) {
  const findByType = (type) => store.doc.parts.find((p) => ciEq(p.type, type) && (p.streams || []).includes(streamName));
  const extract = (type) => {
    const part = findByType(type);
    return part ? unjoinLabel(elementByType(store, type), part.label) : null;
  };
  return {
    functionName: extract('BusinessFunction'),
    capabilityName: extract('BusinessCapability'),
    applicationCapabilityName: extract('ApplicationCapability'),
    entityName: extract('DataDataEntity'),
    hasApplicationCapability: !!findByType('ApplicationCapability'),
  };
}
/**
 * expectedLabel guards against a real bug: matching on type+streamName alone isn't
 * enough to identify "this stream's own" passive node. Two different createStream
 * calls (e.g. two separate generateIndustry jobs) can legitimately share the same
 * streamName — most likely today when a capability has no distinct entity and its own
 * name is reused as the stream name (see generateIndustry's entity-fallback) — and
 * without the label check, the second call would incorrectly find and reuse the FIRST
 * call's passive node (e.g. its BusinessFunction) even though it belongs to a
 * genuinely different function/capability, silently merging two things that should
 * have stayed separate.
 */
function findExistingStreamNode(store, viewId, streamName, type, expectedLabel, modelName, lookupCache = null, placeInView = true) {
  // O(1) via the same partsByKey index createStream's main loop already uses — label+
  // type+model is how a part's identity is determined throughout this file, so this
  // is exactly the right key, and avoids the alternative of scanning every same-type
  // part in the view (which, for a type reused across many capabilities — e.g.
  // ApplicationFunction/TechnologyFunction, one per capability rather than one per
  // function — could mean scanning thousands of entries on every single call).
  let part = lookupCache
    ? lookupCache.partsByKey.get(`${expectedLabel}|${type}|${modelName}`.toLowerCase())
    : store.doc.parts.find((p) => ciEq(p.label, expectedLabel) && ciEq(p.type, type) && ciEq(p.model, modelName));
  if (!part || !(part.streams || []).includes(streamName)) return null;
  // Without a view there's no per-view viewMember to require — the part matching by
  // identity+stream membership above is already the whole answer in that mode.
  if (!placeInView) return { vm: null, part };
  const vm = lookupCache
    ? lookupCache.vmsByPartView.get(`${part.id}|${viewId}`)
    : store.doc.viewMembers.find((v) => v.objectType === 'part' && ciEq(v.objectId, part.id) && ciEq(v.view, viewId));
  return vm ? { vm, part } : null;
}
function createPassiveNode(app, viewId, type, streamName, modelName, functionName, capabilityName, entityName, pos, note, functionDescription, functionxIds, lookupCache = null, functionSection = '', placeInView = true) {
  const { store } = app;
  let el = elementByType(store, type);
  const resolvedType = el?.type || 'Unknown';
  const isUnknownFallback = ciEq(resolvedType, 'Unknown') && !ciEq(type, 'Unknown');
  const fullNote = isUnknownFallback ? `${note} (unknown type: ${type})` : note;
  const label = ciEq(resolvedType, 'businessFunction') ? joinLabel(el, functionName) : joinLabel(el, capabilityName || entityName || type);
  const isFunctionType = ciEq(resolvedType, 'businessFunction');
  const isFunctionWithXId = isFunctionType && functionxIds;

  let existingPart = isFunctionWithXId
    ? (lookupCache ? lookupCache.partsByXid.get(`${functionxIds}|${modelName}`.toLowerCase()) : store.doc.parts.find((p) => p.xIds && ciEq(p.xIds, functionxIds) && ciEq(p.model, modelName)))
    : null;
  // Type check added alongside label — see the matching note at the main value[] loop's
  // find-or-create above for why (different element types rendering to the same label
  // text must not collapse onto one shared part).
  if (!existingPart) {
    existingPart = lookupCache
      ? lookupCache.partsByKey.get(`${label}|${resolvedType}|${modelName}`.toLowerCase())
      : store.doc.parts.find((p) => ciEq(p.label, label) && ciEq(p.type, resolvedType) && ciEq(p.model, modelName));
  }
  let part;
  if (existingPart) {
    part = existingPart;
    if (!(part.streams || []).includes(streamName)) part.streams = [...(part.streams || []), streamName];
  } else {
    part = store.createPart({
      type: resolvedType, label, model: modelName, streams: [streamName], note: fullNote, other: { src: type },
      description: isFunctionWithXId ? functionDescription : undefined, xIds: isFunctionWithXId ? functionxIds : undefined,
      // Every passive node belongs to this same function's own stream (see the matching
      // comment at the main value[] loop's catSection above) — not just the function-type
      // one — so a Section filter shows the whole related chain, not only its top.
      section: functionSection,
    });
    if (lookupCache) cacheRegisterPart(lookupCache, part);
  }

  let vm = null;
  let wasNew = false;
  if (placeInView) {
    vm = existingPart
      ? (lookupCache ? lookupCache.vmsByPartView.get(`${part.id}|${viewId}`) : store.doc.viewMembers.find((v) => v.objectType === 'part' && ciEq(v.objectId, part.id) && ciEq(v.view, viewId)))
      : null;
    if (!vm) {
      vm = store.createViewMember({ view: viewId, objectType: 'part', objectId: part.id, x: pos.x, y: pos.y, sectionId: pos.sectionId || '', fillColor: elementGroupFill(store, resolvedType), note: fullNote });
      wasNew = true;
      if (lookupCache) cacheRegisterVm(lookupCache, vm);
    }
  }
  return { vm, part, wasNew };
}

// ===================== DUPLICATE STREAM =====================
function duplicateStream(app, tab, vmId, newStreamName) {
  const { store } = app;
  const vm = store.findViewMember(vmId);
  const part = vm && store.findPart(vm.objectId);
  if (!part || !(part.streams || []).length) return;
  const originalStream = part.streams[0];
  const vmIdsBefore = new Set(store.viewMembersForView(vm.view).map((v) => v.id));

  const partsInStream = store.doc.parts.filter((p) => (p.streams || []).includes(originalStream));
  const connsInStream = store.doc.connectors.filter((c) => (c.streams || []).includes(originalStream));
  const partIdSet = new Set(partsInStream.map((p) => p.id));

  const partIdMap = new Map(); // old part id -> new part
  const vmIdMap = new Map();   // old vm id -> new vm

  for (const p of partsInStream) {
    const newPart = store.createPart({ type: p.type, label: p.label, model: p.model, streams: [newStreamName], note: p.note, order: p.order, other: p.other });
    partIdMap.set(p.id, newPart);
  }

  // duplicate view members (nodes) for every viewMember referencing a part in the stream, in this view
  const vmsInView = store.viewMembersForView(vm.view);
  for (const ovm of vmsInView) {
    if (ovm.objectType !== 'part') continue;
    if (!partIdSet.has(ovm.objectId)) continue;
    const newPart = partIdMap.get(ovm.objectId);
    const nvm = store.createViewMember({
      view: ovm.view, objectType: 'part', objectId: newPart.id,
      x: ovm.x + 60, y: ovm.y + 60, fillColor: ovm.fillColor, order: ovm.order,
      note: ovm.note, linkedViewName: '', isExternal: ovm.isExternal,
    });
    vmIdMap.set(ovm.id, nvm);
  }

  // duplicate connectors: if both endpoints were in-stream, use new part ids; else keep original id
  for (const c of connsInStream) {
    const fromInStream = partIdSet.has(c.from);
    const toInStream = partIdSet.has(c.to);
    const newFrom = fromInStream ? partIdMap.get(c.from).id : c.from;
    const newTo = toInStream ? partIdMap.get(c.to).id : c.to;
    const newConn = store.createConnector({ from: newFrom, to: newTo, model: c.model, connectorType: 's', relationship: c.relationship, streams: [newStreamName] });

    // find the connector's viewMember(s) in this view to duplicate as edges, remapping endpoints
    const cvms = vmsInView.filter((x) => x.objectType === 'connector' && x.objectId === c.id);
    for (const cvm of cvms) {
      const newFromVm = fromInStream ? vmIdMap.get(cvm.fromVmId)?.id : cvm.fromVmId;
      const newToVm = toInStream ? vmIdMap.get(cvm.toVmId)?.id : cvm.toVmId;
      if (!newFromVm || !newToVm) continue;
      store.createViewMember({ view: cvm.view, objectType: 'connector', objectId: newConn.id, fromVmId: newFromVm, toVmId: newToVm });
    }
  }

  const newVmIds = store.viewMembersForView(vm.view).filter((v) => !vmIdsBefore.has(v.id)).map((v) => v.id);
  tab.selection.clear();
  for (const id of newVmIds) tab.selection.add(id);

  app.recordAndRender();
  app.toast(`Duplicated stream "${originalStream}" as "${newStreamName}".`);
}

function nextStreamName(originalName) {
  const m = String(originalName).match(/^(.*?)(\d+)$/);
  if (m) return `${m[1]}${Number(m[2]) + 1}`;
  return `${originalName} 2`;
}

// ===================== SPLIT NODE =====================
function splitNode(app, tab, vmId) {
  const { store } = app;
  const vm = store.findViewMember(vmId);
  const part = vm && store.findPart(vm.objectId);
  if (!part) return;

  const newPart = store.createPart({ type: part.type, label: `${part.label} (split)`, model: part.model, streams: [...(part.streams || [])], note: part.note, order: part.order, other: part.other });
  const newVm = store.createViewMember({ view: vm.view, objectType: 'part', objectId: newPart.id, x: vm.x + 140, y: vm.y + 60, fillColor: vm.fillColor, order: vm.order });

  const vmsInView = store.viewMembersForView(vm.view);

  // incoming edges (connector.to === part.id): duplicate pointing to both original and split node
  const incoming = store.doc.connectors.filter((c) => ciEq(c.to, part.id));
  for (const c of incoming) {
    const newConn = store.createConnector({ from: c.from, to: newPart.id, model: c.model, connectorType: c.connectorType, relationship: c.relationship, streams: [...(c.streams || [])] });
    const cvms = vmsInView.filter((x) => x.objectType === 'connector' && x.objectId === c.id && x.toVmId === vm.id);
    for (const cvm of cvms) {
      store.createViewMember({ view: cvm.view, objectType: 'connector', objectId: newConn.id, fromVmId: cvm.fromVmId, toVmId: newVm.id });
    }
  }

  // outgoing edges (connector.from === part.id): duplicate pointing from both original and split node
  const outgoing = store.doc.connectors.filter((c) => ciEq(c.from, part.id));
  for (const c of outgoing) {
    const newConn = store.createConnector({ from: newPart.id, to: c.to, model: c.model, connectorType: c.connectorType, relationship: c.relationship, streams: [...(c.streams || [])] });
    const cvms = vmsInView.filter((x) => x.objectType === 'connector' && x.objectId === c.id && x.fromVmId === vm.id);
    for (const cvm of cvms) {
      store.createViewMember({ view: cvm.view, objectType: 'connector', objectId: newConn.id, fromVmId: newVm.id, toVmId: cvm.toVmId });
    }
  }

  app.recordAndRender();
  app.toast(`Split node "${part.label}".`);
}

// ===================== LEVEL UP =====================
/**
 * View-level (not node-specific): creates a new parent view containing a single
 * "created node" placeholder representing the ENTIRE view being leveled up (linked back
 * down to it, same drill-down mechanism as before — just keyed to the view rather than
 * one node's identity/label), PLUS an isExternal copy of every node ALREADY MARKED
 * isExternal in the original view (Step 28 fix — these already represent boundary/
 * context nodes pointing outside the view, so they're what should carry up; the view's
 * own regular content nodes should NOT be duplicated), each wired to the created node
 * with a new connector so the parent view shows the leveled-up view's own external
 * context. The leveled-up view itself is untouched.
 */
function levelUp(app, tab, newViewName) {
  const { store } = app;
  const currentView = store.findView(tab.viewId);
  if (!currentView) return;

  const view = store.addView(newViewName);
  const newTab = app.createCanvasTab(view);

  const newPart = store.createPart({ type: 'Unknown', label: currentView.viewName, model: store.defaultModel, streams: [], note: '', order: 0, other: {} });
  const createdVm = store.createViewMember({
    view: view.id, objectType: 'part', objectId: newPart.id,
    x: 200, y: 150, fillColor: elementGroupFill(store, 'Unknown'),
    linkedViewName: currentView.id, // links back down to the view we leveled up from
  });

  const partVms = store.viewMembersForView(currentView.id).filter((vm) => vm.objectType === 'part' && vm.isExternal);
  let i = 0;
  for (const vm of partVms) {
    const part = store.findPart(vm.objectId);
    if (!part) continue;
    i += 1;
    const copyVm = store.createViewMember({
      view: view.id, objectType: 'part', objectId: part.id,
      x: 900, y: 60 + i * 90, fillColor: vm.fillColor, isExternal: true,
    });
    const pair = findRelationshipPair(store, part.type, newPart.type);
    const defaultKey = pair?.default;
    const relation = defaultKey ? (store.settings.relations || []).find((r) => r.key === defaultKey) : null;
    const conn = store.createConnector({ from: part.id, to: newPart.id, model: store.defaultModel, connectorType: 'c', relationship: relation?.name || 'Association', streams: [] });
    store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: copyVm.id, toVmId: createdVm.id });
  }

  app.recordAndRender();
  app.switchToTab(newTab.id);
  app.toast(`Created view "${newViewName}" (Level Up) with ${partVms.length} node${partVms.length === 1 ? '' : 's'} carried up.`);
}

// ===================== LEVEL DOWN =====================
/**
 * Single-node variant used by double-click when a node has no linkedViewName yet:
 * creates a new (blank) view and links the node to it, without altering the node itself
 * (unlike the multi-select Level Down, which replaces the moved selection with an
 * 'Unknown' placeholder — here the original node's type/identity must stay untouched).
 */
function levelDownSingle(app, tab, vmId) {
  const { store } = app;
  const vm = store.findViewMember(vmId);
  const part = vm && store.findPart(vm.objectId);
  if (!part) return;

  let newViewName = part.label || 'New View';
  if (store.findView(newViewName)) {
    let n = 1;
    while (store.findView(`${newViewName} ${n}`)) n++;
    newViewName = `${newViewName} ${n}`;
  }
  const view = store.addView(newViewName);
  const newTab = app.createCanvasTab(view);
  vm.linkedViewName = view.id;

  // Place a copy of the double-clicked node itself as the anchor of the new view — the
  // ORIGINAL vm is untouched (it stays put in the old view; unlike multi-node Level
  // Down, this node's own identity/type never changes), but the crossing-connector
  // recreation below needs something on this side to attach to inside the new view.
  const selfVm = store.createViewMember({
    view: view.id, objectType: 'part', objectId: part.id,
    x: 200, y: 150, fillColor: vm.fillColor,
  });

  // Crossing connectors: with a single node "selected", exactly-one-endpoint-selected
  // means any connector touching this node but not a self-loop on it. For each one,
  // create an isExternal copy of the OTHER-side neighbor in the new view (deduplicated
  // — multiple crossing edges to the same neighbor share one copy), positioned at a
  // fixed x (900 if this node was the from side, 20 if the to side) stacked vertically,
  // then recreate the connector inside the new view pointing at that external copy.
  // Same approach as a portion of multi-node Level Down (step 3).
  const vmsInOldView = store.viewMembersForView(tab.viewId);
  const connVmsInOldView = vmsInOldView.filter((v) => v.objectType === 'connector');
  const crossingConnVms = connVmsInOldView.filter((cv) => (cv.fromVmId === vm.id) !== (cv.toVmId === vm.id));

  const neighborCopyByOldVmId = new Map(); // old neighbor vmId -> new external copy vm (in new view)
  let offsetI = 0;
  for (const cv of crossingConnVms) {
    const movedEndIsFrom = cv.fromVmId === vm.id;
    const neighborVmId = movedEndIsFrom ? cv.toVmId : cv.fromVmId;
    const neighborVm = store.findViewMember(neighborVmId);
    if (!neighborVm) continue;
    let copy = neighborCopyByOldVmId.get(neighborVmId);
    if (!copy) {
      offsetI += 1;
      copy = store.createViewMember({
        view: view.id, objectType: 'part', objectId: neighborVm.objectId,
        x: movedEndIsFrom ? 900 : 20, y: 60 + offsetI * 90,
        fillColor: neighborVm.fillColor, isExternal: true,
      });
      neighborCopyByOldVmId.set(neighborVmId, copy);
    }
    const conn = store.findConnector(cv.objectId);
    if (conn) {
      store.createViewMember({
        view: view.id, objectType: 'connector', objectId: conn.id,
        fromVmId: movedEndIsFrom ? selfVm.id : copy.id,
        toVmId: movedEndIsFrom ? copy.id : selfVm.id,
      });
    }
  }

  // The new view's node may not fit the default node size — resize before rendering
  // rather than requiring a manual Redraw/Remap on the new view (the same "newly-placed
  // content might not fit the current size" reasoning as generateIndustry/
  // populateFromTemplate above).
  redrawAndResolveLayout(app, { viewId: view.id, selection: new Set() });
  app.recordAndRender();
  app.switchToTab(newTab.id);
  app.toast(`Linked "${part.label}" to new view "${newViewName}".`);
}

function levelDown(app, tab, selectedVmIds) {
  const { store } = app;
  const selectedVms = selectedVmIds.map((id) => store.findViewMember(id)).filter((vm) => vm && vm.objectType === 'part');
  if (selectedVms.length < 2) return;

  const primary = selectedVms[0];
  const primaryPart = store.findPart(primary.objectId);
  let newViewName = primaryPart ? primaryPart.label : 'Level Down';
  if (store.findView(newViewName)) {
    let n = 1;
    while (store.findView(`Level Down ${n}`)) n++;
    newViewName = `Level Down ${n}`;
  }
  const view = store.addView(newViewName);
  const newTab = app.createCanvasTab(view);

  const selectedIdSet = new Set(selectedVms.map((v) => v.id));
  const vmsInOldView = store.viewMembersForView(tab.viewId);
  const connVmsInOldView = vmsInOldView.filter((v) => v.objectType === 'connector');

  // centroid of moved nodes (for placeholder position)
  const cx = Math.round(selectedVms.reduce((s, v) => s + v.x, 0) / selectedVms.length);
  const cy = Math.round(selectedVms.reduce((s, v) => s + v.y, 0) / selectedVms.length);

  // 2. move selected nodes + fully-internal edges into new view
  for (const v of selectedVms) v.view = view.id;
  const internalConnVms = connVmsInOldView.filter((cv) => selectedIdSet.has(cv.fromVmId) && selectedIdSet.has(cv.toVmId));
  for (const cv of internalConnVms) cv.view = view.id;

  // 3. crossing edges: exactly one endpoint in selection
  const crossingConnVms = connVmsInOldView.filter((cv) => selectedIdSet.has(cv.fromVmId) !== selectedIdSet.has(cv.toVmId));
  const neighborCopyByOldVmId = new Map(); // old neighbor vmId -> new external copy vm (in new view)
  let offsetI = 0;
  for (const cv of crossingConnVms) {
    const movedEndIsFrom = selectedIdSet.has(cv.fromVmId);
    const neighborVmId = movedEndIsFrom ? cv.toVmId : cv.fromVmId;
    const neighborVm = store.findViewMember(neighborVmId);
    if (!neighborVm) continue;
    let copy = neighborCopyByOldVmId.get(neighborVmId);
    if (!copy) {
      offsetI += 1;
      copy = store.createViewMember({
        view: view.id, objectType: 'part', objectId: neighborVm.objectId,
        x: movedEndIsFrom ? 900 : 20, y: 60 + offsetI * 90,
        fillColor: neighborVm.fillColor, isExternal: true,
      });
      neighborCopyByOldVmId.set(neighborVmId, copy);
    }
    // recreate the crossing edge inside the new tab, pointing to the external copy
    const conn = store.findConnector(cv.objectId);
    if (conn) {
      const movedVmId = movedEndIsFrom ? cv.fromVmId : cv.toVmId;
      store.createViewMember({
        view: view.id, objectType: 'connector', objectId: conn.id,
        fromVmId: movedEndIsFrom ? movedVmId : copy.id,
        toVmId: movedEndIsFrom ? copy.id : movedVmId,
      });
    }
  }

  // 4. placeholder node in old view, replacing the selection
  const unknownEl = elementByType(store, 'Unknown');
  const placeholderPart = store.createPart({ type: 'Unknown', label: newViewName, model: primaryPart?.model || store.defaultModel, streams: [], note: '', order: 0, other: {} });
  const placeholderVm = store.createViewMember({
    view: tab.viewId, objectType: 'part', objectId: placeholderPart.id,
    x: cx, y: cy, fillColor: elementGroupFill(store, 'Unknown'), linkedViewName: view.id,
  });

  // 5. rewire original crossing edges (still in old view) to connect neighbor <-> placeholder; dedupe truly-parallel edges
  const seenPairs = new Set();
  for (const cv of crossingConnVms) {
    const movedEndIsFrom = selectedIdSet.has(cv.fromVmId);
    const neighborVmId = movedEndIsFrom ? cv.toVmId : cv.fromVmId;
    const conn = store.findConnector(cv.objectId);
    // include connector type+relationship in the key: two DIFFERENT connectors (e.g. a
    // stream connector and its dual-created 'c' companion) crossing between the same
    // neighbor/placeholder pair are not duplicates of each other and must both survive —
    // only truly-redundant same-type/relationship parallel edges should be merged.
    const pairKey = `${movedEndIsFrom ? neighborVmId + '>' + 'PH' : 'PH' + '>' + neighborVmId}|${conn?.connectorType}|${conn?.relationship}`;
    if (seenPairs.has(pairKey)) {
      store.deleteViewMember(cv.id); // drop parallel duplicate, keep first
      continue;
    }
    seenPairs.add(pairKey);
    if (movedEndIsFrom) { cv.fromVmId = placeholderVm.id; }
    else { cv.toVmId = placeholderVm.id; }
  }

  applyRemapLayout(app, view.id);

  app.recordAndRender();
  app.switchToTab(newTab.id);
  app.toast(`Level Down → "${newViewName}".`);
}

// ===================== COPY / PASTE =====================
/** Copy the selected nodes (and any connectors wholly between them) to an in-memory clipboard. */
function copyNodes(app, tab) {
  const { store } = app;
  const nodeVmIds = [...tab.selection].filter((id) => {
    const vm = store.findViewMember(id);
    return vm && vm.objectType === 'part';
  });
  if (nodeVmIds.length === 0) { app.toast('Select one or more nodes to copy.', true); return; }
  app.clipboard = { sourceViewId: tab.viewId, nodeVmIds };
  app.toast(`Copied ${nodeVmIds.length} node${nodeVmIds.length === 1 ? '' : 's'}.`);
}

/** Paste the clipboard into the current tab's view. mode: 'new' (fresh parts+connectors) or 'existing' (reuse). */
function pasteNodes(app, tab, mode, anchorPos) {
  const { store } = app;
  const clip = app.clipboard;
  if (!clip || !clip.nodeVmIds.length) { app.toast('Nothing to paste.', true); return; }

  const sourceVms = clip.nodeVmIds.map((id) => store.findViewMember(id)).filter(Boolean);
  if (sourceVms.length === 0) { app.toast('Copied nodes no longer exist.', true); return; }
  const sourceIdSet = new Set(sourceVms.map((v) => v.id));

  // connectors wholly between the copied nodes, in the source view
  const sourceConnVms = store.viewMembersForView(clip.sourceViewId).filter(
    (cv) => cv.objectType === 'connector' && sourceIdSet.has(cv.fromVmId) && sourceIdSet.has(cv.toVmId)
  );

  let dx, dy;
  if (anchorPos) {
    const minX = Math.min(...sourceVms.map((v) => v.x));
    const minY = Math.min(...sourceVms.map((v) => v.y));
    dx = anchorPos.x - minX; dy = anchorPos.y - minY;
  } else {
    dx = 40; dy = 40;
  }
  const vmIdMap = new Map(); // old node vm id -> new node vm
  const newVmIds = [];

  for (const ovm of sourceVms) {
    const part = store.findPart(ovm.objectId);
    if (!part) continue;
    let targetPartId = part.id;
    if (mode === 'new') {
      const newPart = store.createPart({
        type: part.type, label: part.label, model: part.model, streams: [...(part.streams || [])],
        note: part.note, order: part.order, other: part.other,
        script: part.script, scriptEnabled: part.scriptEnabled,
      });
      targetPartId = newPart.id;
    }
    const nvm = store.createViewMember({
      view: tab.viewId, objectType: 'part', objectId: targetPartId,
      x: ovm.x + dx, y: ovm.y + dy, fillColor: ovm.fillColor, order: ovm.order, note: ovm.note,
    });
    vmIdMap.set(ovm.id, nvm);
    newVmIds.push(nvm.id);
  }

  for (const cvm of sourceConnVms) {
    const conn = store.findConnector(cvm.objectId);
    if (!conn) continue;
    const newFromVm = vmIdMap.get(cvm.fromVmId);
    const newToVm = vmIdMap.get(cvm.toVmId);
    if (!newFromVm || !newToVm) continue;
    let targetConnId = conn.id;
    if (mode === 'new') {
      const fromPartId = newFromVm.objectId, toPartId = newToVm.objectId;
      const newConn = store.createConnector({ from: fromPartId, to: toPartId, model: conn.model, connectorType: conn.connectorType, relationship: conn.relationship, streams: [...(conn.streams || [])] });
      targetConnId = newConn.id;
    }
    const ncvm = store.createViewMember({ view: tab.viewId, objectType: 'connector', objectId: targetConnId, fromVmId: newFromVm.id, toVmId: newToVm.id });
    newVmIds.push(ncvm.id);
  }

  tab.selection.clear();
  for (const id of newVmIds) tab.selection.add(id);

  app.recordAndRender();
  app.toast(`Pasted ${sourceVms.length} node${sourceVms.length === 1 ? '' : 's'} (${mode === 'new' ? 'new parts' : 'existing parts'}).`);
}

// ===================== REMAP =====================
/**
 * Reorganizes the current view: Passive "from" nodes -> top row, Passive "to" nodes ->
 * last column, remaining nodes ordered by their position in the related streamTemplate's
 * value[] array (template chosen by view.viewType matching template.viewtypes, falling
 * back to 'Enterprise', then the first available template).
 */
function estimateMaxCols(stepX = 170, baseX = 60, zoom = 1) {
  const container = document.getElementById('pages-container');
  const width = container ? container.clientWidth : 900;
  return Math.max(3, Math.floor((width / (zoom || 1) - baseX) / stepX));
}

/**
 * Core layout used by both the "Remap" command and Level Down's new view:
 * Passive "from" nodes -> top row; Passive "to" nodes -> the MaxCols-th column;
 * remaining nodes ordered by the related streamTemplate's value[] position, wrapping
 * to a new row at MaxCols columns OR whenever the element.group changes.
 */
const REMAP_SORT_KEYS = ['streamName', 'connectionOrder', 'streamOrder', 'entityType', 'elementGroup', 'nodeLabel'];
const REMAP_SORT_LABELS = { streamName: 'Stream name', connectionOrder: 'Connection order', streamOrder: 'Stream order', entityType: 'Entity type', elementGroup: 'Element group', nodeLabel: 'Node label' };
// Default priority when the user hasn't chosen (or this view has no remembered) order.
// 4 of the 5 available keys — streamOrder is available to pick manually but not defaulted.
const DEFAULT_REMAP_SORT_KEYS = ['streamName', 'connectionOrder', 'entityType', 'nodeLabel'];

/**
 * For each part present in a view, resolves which of its (possibly several) stream tags
 * is actually relevant to THIS view — the one shared by the most other parts here —
 * rather than blindly using streams[0]. A node created under one stream and later reused
 * (via the xIds find-or-create logic) by a different stream carries multiple stream tags
 * in creation order, and streams[0] can easily be a stream that has nothing to do with
 * the view currently being laid out (e.g. a shared capability node whose FIRST stream
 * tag came from a different entity's stream entirely, in a view built by filtering for
 * one SPECIFIC stream via Add Existing). Falls back to streams[0] when there's no
 * meaningful popularity signal (0 or 1 stream tags).
 */
function resolveViewRelevantStreams(store, viewId) {
  const partVms = store.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part');
  const parts = partVms.map((vm) => store.findPart(vm.objectId)).filter(Boolean);

  const streamPopularity = new Map(); // streamName -> count of distinct parts in this view carrying it
  for (const part of parts) {
    for (const s of new Set(part.streams || [])) {
      streamPopularity.set(s, (streamPopularity.get(s) || 0) + 1);
    }
  }

  const resolved = new Map(); // partId -> resolved stream name
  for (const part of parts) {
    const streams = part.streams || [];
    if (streams.length <= 1) { resolved.set(part.id, streams[0] || ''); continue; }
    let best = streams[0], bestCount = streamPopularity.get(streams[0]) || 0;
    for (const s of streams) {
      const c = streamPopularity.get(s) || 0;
      if (c > bestCount) { best = s; bestCount = c; }
    }
    resolved.set(part.id, best);
  }
  return resolved;
}

/**
 * Per-stream BFS connection order: for each stream present in the view, walk outward
 * from that stream's passive-from part(s) — or, absent any, its lowest-id part as a
 * deterministic stand-in for "first main-chain node" — following only that stream's own
 * connectors. Returns Map<partId, order>. A part in multiple streams gets its order from
 * its view-relevant stream (see resolveViewRelevantStreams), not necessarily streams[0].
 * Parts a stream's connectors never reach are left out of the map entirely (callers
 * should treat a missing entry as "tied with every other unreached part," falling
 * through to the next sort key).
 */
function computeConnectionOrder(store, viewId, viewRelevantStreams) {
  const partVms = store.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part');
  const connVms = store.viewMembersForView(viewId).filter((vm) => vm.objectType === 'connector');
  const parts = partVms.map((vm) => store.findPart(vm.objectId)).filter(Boolean);

  const streamToPartIds = new Map(); // streamName -> Set(partId), keyed by each part's view-relevant stream
  for (const part of parts) {
    const relevantStream = viewRelevantStreams?.get(part.id) ?? (part.streams || [])[0];
    if (!relevantStream) continue;
    if (!streamToPartIds.has(relevantStream)) streamToPartIds.set(relevantStream, new Set());
    streamToPartIds.get(relevantStream).add(part.id);
  }

  const orderMap = new Map();
  for (const [streamName, partIdSet] of streamToPartIds) {
    const adj = new Map(); // partId -> [neighbor partIds], via this stream's own connectors only
    const passiveFromIds = new Set();
    for (const cv of connVms) {
      const conn = store.findConnector(cv.objectId);
      if (!conn || !(conn.streams || []).includes(streamName)) continue;
      if (!partIdSet.has(conn.from) || !partIdSet.has(conn.to)) continue;
      if (!adj.has(conn.from)) adj.set(conn.from, []);
      if (!adj.has(conn.to)) adj.set(conn.to, []);
      adj.get(conn.from).push(conn.to);
      adj.get(conn.to).push(conn.from);
      if (ciEq(conn.relationship, 'Passive')) passiveFromIds.add(conn.from);
    }

    const sortedIds = [...partIdSet].sort();
    let seeds = sortedIds.filter((id) => passiveFromIds.has(id));
    if (seeds.length === 0 && sortedIds.length > 0) seeds = [sortedIds[0]];

    const visited = new Set(seeds);
    const queue = [...seeds];
    let order = 0;
    while (queue.length) {
      const id = queue.shift();
      orderMap.set(id, order++);
      for (const n of adj.get(id) || []) {
        if (!visited.has(n)) { visited.add(n); queue.push(n); }
      }
    }
    // unreached parts in this stream (disconnected components) are left OUT of orderMap
    // on purpose, so they tie with each other and fall through to the next sort key.
  }
  return orderMap;
}

function remapSortValue(store, template, part, key, connectionOrderMap, viewRelevantStreams) {
  if (key === 'streamName') return viewRelevantStreams?.get(part.id) ?? ((part.streams && part.streams[0]) || '');
  if (key === 'connectionOrder') return connectionOrderMap?.get(part.id) ?? Infinity;
  if (key === 'streamOrder') {
    const idx = (template.value || []).findIndex((v) => ciEq(v, part.type));
    return idx === -1 ? (template.value || []).length : idx;
  }
  if (key === 'entityType') return part.type || '';
  if (key === 'elementGroup') return elementByType(store, part.type)?.group || '';
  if (key === 'nodeLabel') return part.label || '';
  return '';
}

// ===================== GENERATE INDUSTRY =====================
/**
 * For each Entity (nodeElementType 'DataDataEntity') in the named industry's reference
 * tree, calls createStream with the Enterprise template, using that entity's name as
 * the stream name and passing its function/capability/entity name+description+xIds up
 * the chain — so repeated entities under the same function/capability naturally reuse
 * those nodes via the xIds find-or-create logic in createStream, rather than each
 * stream duplicating its own copy of the shared function/capability nodes.
 *
 * Step 29 fix: createStream's own xIds+model reuse only ever covered the function/
 * capability/entity ANCHOR parts themselves (by design — the ~16 "supporting" positions
 * along the template chain intentionally get a fresh node every stream, since the same
 * entity can legitimately sit under two different capabilities and each occurrence needs
 * its own distinct supporting chain; broadening that reuse once already caused a real
 * bug where genuinely different supporting nodes got collapsed together). Re-running
 * Generate Industry a second time for the same industry, though, has no such legitimate
 * case to protect — it's the exact same (function, capability, entity) triple — yet it
 * was still generating a whole fresh duplicate supporting chain for every one of them.
 * Fixed by recording each successfully-generated (function, capability) pair against its
 * entity anchor part; a later run recognizes the pair as already generated and skips
 * re-creating that triple's chain entirely, reusing what's already there. Keying on the
 * (function, capability) pair rather than the entity alone keeps the legitimate same-
 * entity-different-capability case fully intact — only an EXACT repeat triple is skipped.
 */
/**
 * "Smart Check View" (Advanced menu): scans the current view's already-placed nodes
 * against the underlying model and repairs two kinds of gaps.
 *   - missingConnectors: for every pair of parts BOTH already on this view, if the model
 *     has a connector between them that has no matching connector-viewMember here, adds
 *     it. Pure "connect what's already visible" — never adds a new node.
 *   - missingConnectorsAndNodes: for every connector where exactly ONE endpoint is on
 *     this view, pulls in the missing part (as a new viewMember, placed near its
 *     already-present counterpart) AND the connector itself. `levels` controls how many
 *     hops of this to do — after pulling in a node at hop 1, hop 2 checks ITS
 *     connections for more missing neighbors, and so on; null/undefined means keep
 *     expanding until nothing new is found (same convention as the view's own
 *     connector-levels display filter). Runs independently of missingConnectors — if
 *     only this box is checked, pairs that are BOTH already on the view but
 *     disconnected are left alone, since fixing that is specifically the other box's
 *     job; in practice most users will want both.
 * Both checks operate on the view's full placed content, not whatever the Stream/Types
 * display filter currently hides — Smart Check repairs the model-vs-view relationship
 * itself, not just what's currently visible.
 * Returns { connectorsAdded, nodesAdded }.
 */
function smartCheckView(app, tab, options = {}) {
  const { missingConnectors = true, missingConnectorsAndNodes = false, levels = null } = options;
  const { store } = app;
  const viewId = tab.viewId;
  const view = store.findView(viewId);
  if (!view) return null;

  let connectorsAdded = 0, nodesAdded = 0;
  const log = (msg) => pushMessageLog(store, `[Smart Check View: ${view.viewName}] ${msg}`);
  const describePart = (id) => { const p = store.findPart(id); return p ? `"${p.label}" (${p.type})` : id; };
  const SMART_CHECK_NOTE = 'Smart Check created.';
  const appendNote = (obj, text) => { obj.note = obj.note ? `${obj.note}\n${text}` : text; };

  const vms = store.viewMembersForView(viewId);
  const partVms = vms.filter((vm) => vm.objectType === 'part');
  const connVms = vms.filter((vm) => vm.objectType === 'connector');
  const partIdToVmId = new Map(partVms.map((vm) => [vm.objectId, vm.id]));
  const placedConnectorIds = new Set(connVms.map((vm) => vm.objectId));

  if (missingConnectors) {
    const onViewPartIds = new Set(partIdToVmId.keys());
    for (const conn of store.doc.connectors) {
      if (placedConnectorIds.has(conn.id)) continue;
      if (!onViewPartIds.has(conn.from) || !onViewPartIds.has(conn.to)) continue;
      store.createViewMember({
        view: viewId, objectType: 'connector', objectId: conn.id,
        fromVmId: partIdToVmId.get(conn.from), toVmId: partIdToVmId.get(conn.to),
      });
      appendNote(conn, SMART_CHECK_NOTE);
      store.touchConnector(conn);
      placedConnectorIds.add(conn.id);
      connectorsAdded += 1;
      log(`Added missing connector: ${describePart(conn.from)} -> ${describePart(conn.to)} (${conn.relationship || conn.connectorType}).`);
    }
  }

  if (missingConnectorsAndNodes) {
    const typeToFill = new Map();
    for (const def of store.settings.elements || []) {
      const fill = (store.settings.elementGroups || []).find((g) => ciEq(g.group, def.group))?.fill;
      typeToFill.set(def.type, fill || '#cccccc');
    }
    let autoPlacedCount = 0;
    const placeNearAnchor = (part, anchorVmId) => {
      const anchor = store.findViewMember(anchorVmId);
      const fillColor = typeToFill.get(part.type) || '#cccccc';
      autoPlacedCount += 1;
      const vm = store.createViewMember({
        view: viewId, objectType: 'part', objectId: part.id,
        x: (anchor ? anchor.x : 60) + 200, y: (anchor ? anchor.y : 40) + (autoPlacedCount * 70),
        fillColor,
      });
      partIdToVmId.set(part.id, vm.id);
      nodesAdded += 1;
      const anchorPart = anchor ? store.findPart(anchor.objectId) : null;
      log(`Added missing node: ${describePart(part.id)}, pulled in near ${anchorPart ? `"${anchorPart.label}" (${anchorPart.type})` : 'an existing node'}.`);
      return vm.id;
    };

    let frontier = new Set(partIdToVmId.keys());
    let hop = 0;
    while (frontier.size > 0 && (levels == null || hop < levels)) {
      // Phase 1: find every connector with exactly one end already on-view, where that
      // present end is part of THIS hop's expansion front — collect first, mutate after,
      // so discovery for this hop is based on a consistent snapshot rather than being
      // order-dependent on which connector happens to get processed first.
      const toAdd = [];
      for (const conn of store.doc.connectors) {
        const fromOnView = partIdToVmId.has(conn.from), toOnView = partIdToVmId.has(conn.to);
        if (fromOnView === toOnView) continue; // both or neither present — not this hop's concern
        const presentId = fromOnView ? conn.from : conn.to;
        if (!frontier.has(presentId)) continue;
        const missingId = fromOnView ? conn.to : conn.from;
        const missingPart = store.findPart(missingId);
        if (!missingPart) continue;
        toAdd.push({ missingPart, anchorPartId: presentId });
      }
      if (toAdd.length === 0) break;

      const nextFrontier = new Set();
      for (const { missingPart, anchorPartId } of toAdd) {
        if (partIdToVmId.has(missingPart.id)) continue; // already placed earlier in this same hop (e.g. two different connectors both lead to the same missing node)
        placeNearAnchor(missingPart, partIdToVmId.get(anchorPartId));
        nextFrontier.add(missingPart.id);
      }

      // Phase 2: now that this hop's nodes are all placed, add every connector that
      // touches at least one of THIS hop's newly-added nodes and whose other end is also
      // now on-view (an original node, or another node also added this same hop) —
      // scoped to this hop's new arrivals specifically, not every now-both-present pair
      // in general, so this stays checkbox 2's own concern and never bleeds into
      // checkbox 1's territory (a pair that was ALREADY both-present before this command
      // ran is left alone unless missingConnectors is also checked).
      for (const conn of store.doc.connectors) {
        if (placedConnectorIds.has(conn.id)) continue;
        if (!partIdToVmId.has(conn.from) || !partIdToVmId.has(conn.to)) continue;
        if (!nextFrontier.has(conn.from) && !nextFrontier.has(conn.to)) continue;
        store.createViewMember({
          view: viewId, objectType: 'connector', objectId: conn.id,
          fromVmId: partIdToVmId.get(conn.from), toVmId: partIdToVmId.get(conn.to),
        });
        appendNote(conn, SMART_CHECK_NOTE);
        store.touchConnector(conn);
        placedConnectorIds.add(conn.id);
        connectorsAdded += 1;
        log(`Added missing connector: ${describePart(conn.from)} -> ${describePart(conn.to)} (${conn.relationship || conn.connectorType}).`);
      }

      frontier = nextFrontier;
      hop += 1;
    }
  }

  if (connectorsAdded === 0 && nodesAdded === 0) log('No missing connectors or nodes found.');
  else log(`Done: ${connectorsAdded} connector${connectorsAdded === 1 ? '' : 's'} added, ${nodesAdded} node${nodesAdded === 1 ? '' : 's'} added.`);

  return { connectorsAdded, nodesAdded };
}

/**
 * Smart Check Node (Advanced menu, and right-click on a single node): the single-node
 * analog of smartCheckView above — repairs gaps reachable from ONE specific part instead
 * of everything already on the view. Reuses smartCheckView's exact "missing connectors" /
 * "missing connectors and nodes, N hops" mechanics (same checkbox meanings, same
 * placeNearAnchor/log/note pattern), with two filters neither of those needs at
 * whole-view scope:
 *   - direction (upstream: follow connectors INTO an already-present node, tracing what
 *     feeds it; downstream: follow connectors OUT of an already-present node, tracing
 *     what it feeds). smartCheckView treats a connector's two ends symmetrically since
 *     it isn't walking outward from one specific point.
 *   - streams: when byStream is true, only connectors carrying at least one of `streams`
 *     qualify. `streams` is FIXED for the whole run — the caller derives it once, from
 *     the ORIGINAL selected node's own streams, at dialog-submit time. It is NEVER
 *     recomputed from a newly-discovered node's own streams, so pulling in a node that
 *     happens to also carry other stream tags does not silently widen the search to
 *     those streams too.
 * The BFS seeds its frontier with JUST {partId}, not every part already on the view (the
 * key structural difference from smartCheckView) — but "on-view" membership (used to
 * decide whether an end already has a place, same check smartCheckView makes) still
 * looks at the WHOLE view, since a connector to some unrelated already-placed node is
 * still legitimately "already present"; only the EXPANSION FRONTIER is scoped to this
 * one node's own reachable neighborhood.
 *
 * Direction filtering applies to: checkbox 1 (relative to the seed node itself — an
 * unambiguous "does this run FROM or INTO the seed" question) and BFS phase 1 (relative
 * to whichever frontier member is the connector's already-present end). It deliberately
 * does NOT apply to the BFS's phase 2 (backfilling connectors between nodes that are now
 * BOTH mutually visible after this hop's additions) — phase 2 isn't "walking" in a
 * direction from the seed, it's tidying up edges between two nodes that both just became
 * visible, neither of which is uniquely "the reference point" a direction could be
 * relative to. Stream filtering DOES still apply to phase 2, same as everywhere else.
 */
function smartCheckNode(app, tab, partId, options = {}) {
  const { missingConnectors = true, missingConnectorsAndNodes = false, levels = null, upstream = true, downstream = true, byStream = false, streams = [] } = options;
  const { store } = app;
  const viewId = tab.viewId;
  const view = store.findView(viewId);
  if (!view) return null;
  const seedPart = store.findPart(partId);
  if (!seedPart) return null;

  let connectorsAdded = 0, nodesAdded = 0;
  const log = (msg) => pushMessageLog(store, `[Smart Check Node: ${seedPart.label}] ${msg}`);
  const describePart = (id) => { const p = store.findPart(id); return p ? `"${p.label}" (${p.type})` : id; };
  const SMART_CHECK_NOTE = 'Smart Check created.';
  const appendNote = (obj, text) => { obj.note = obj.note ? `${obj.note}\n${text}` : text; };

  const vms = store.viewMembersForView(viewId);
  const partVms = vms.filter((vm) => vm.objectType === 'part');
  const connVms = vms.filter((vm) => vm.objectType === 'connector');
  const partIdToVmId = new Map(partVms.map((vm) => [vm.objectId, vm.id]));
  const placedConnectorIds = new Set(connVms.map((vm) => vm.objectId));
  if (!partIdToVmId.has(partId)) return null; // selected node isn't actually placed on this view

  const passesStream = (conn) => !byStream || (conn.streams || []).some((s) => streams.includes(s));
  const passesDirection = (edgeIsDownstream) => (edgeIsDownstream ? downstream : upstream);

  if (missingConnectors) {
    for (const conn of store.doc.connectors) {
      if (placedConnectorIds.has(conn.id)) continue;
      if (conn.from !== partId && conn.to !== partId) continue;
      const otherId = conn.from === partId ? conn.to : conn.from;
      if (!partIdToVmId.has(otherId)) continue;
      const edgeIsDownstream = conn.from === partId; // seed is the source -> this edge runs downstream of the seed
      if (!passesDirection(edgeIsDownstream)) continue;
      if (!passesStream(conn)) continue;
      store.createViewMember({
        view: viewId, objectType: 'connector', objectId: conn.id,
        fromVmId: partIdToVmId.get(conn.from), toVmId: partIdToVmId.get(conn.to),
      });
      appendNote(conn, SMART_CHECK_NOTE);
      store.touchConnector(conn);
      placedConnectorIds.add(conn.id);
      connectorsAdded += 1;
      log(`Added missing connector: ${describePart(conn.from)} -> ${describePart(conn.to)} (${conn.relationship || conn.connectorType}).`);
    }
  }

  if (missingConnectorsAndNodes) {
    const typeToFill = new Map();
    for (const def of store.settings.elements || []) {
      const fill = (store.settings.elementGroups || []).find((g) => ciEq(g.group, def.group))?.fill;
      typeToFill.set(def.type, fill || '#cccccc');
    }
    let autoPlacedCount = 0;
    const placeNearAnchor = (part, anchorVmId) => {
      const anchor = store.findViewMember(anchorVmId);
      const fillColor = typeToFill.get(part.type) || '#cccccc';
      autoPlacedCount += 1;
      const vm = store.createViewMember({
        view: viewId, objectType: 'part', objectId: part.id,
        x: (anchor ? anchor.x : 60) + 200, y: (anchor ? anchor.y : 40) + (autoPlacedCount * 70),
        fillColor,
      });
      partIdToVmId.set(part.id, vm.id);
      nodesAdded += 1;
      const anchorPart = anchor ? store.findPart(anchor.objectId) : null;
      log(`Added missing node: ${describePart(part.id)}, pulled in near ${anchorPart ? `"${anchorPart.label}" (${anchorPart.type})` : 'an existing node'}.`);
      return vm.id;
    };

    let frontier = new Set([partId]);
    let hop = 0;
    while (frontier.size > 0 && (levels == null || hop < levels)) {
      const toAdd = [];
      for (const conn of store.doc.connectors) {
        const fromOnView = partIdToVmId.has(conn.from), toOnView = partIdToVmId.has(conn.to);
        if (fromOnView === toOnView) continue; // both or neither present — not this hop's concern
        const presentId = fromOnView ? conn.from : conn.to;
        if (!frontier.has(presentId)) continue;
        const edgeIsDownstream = fromOnView; // present end is the source -> edge runs downstream of it
        if (!passesDirection(edgeIsDownstream)) continue;
        if (!passesStream(conn)) continue;
        const missingId = fromOnView ? conn.to : conn.from;
        const missingPart = store.findPart(missingId);
        if (!missingPart) continue;
        toAdd.push({ missingPart, anchorPartId: presentId });
      }
      if (toAdd.length === 0) break;

      const nextFrontier = new Set();
      for (const { missingPart, anchorPartId } of toAdd) {
        if (partIdToVmId.has(missingPart.id)) continue; // already placed earlier in this same hop
        placeNearAnchor(missingPart, partIdToVmId.get(anchorPartId));
        nextFrontier.add(missingPart.id);
      }

      // phase 2: connect up anything now mutually visible that touches this hop's new
      // arrivals — stream-filtered, deliberately NOT direction-filtered (see this
      // function's own doc comment for why).
      for (const conn of store.doc.connectors) {
        if (placedConnectorIds.has(conn.id)) continue;
        if (!partIdToVmId.has(conn.from) || !partIdToVmId.has(conn.to)) continue;
        if (!nextFrontier.has(conn.from) && !nextFrontier.has(conn.to)) continue;
        if (!passesStream(conn)) continue;
        store.createViewMember({
          view: viewId, objectType: 'connector', objectId: conn.id,
          fromVmId: partIdToVmId.get(conn.from), toVmId: partIdToVmId.get(conn.to),
        });
        appendNote(conn, SMART_CHECK_NOTE);
        store.touchConnector(conn);
        placedConnectorIds.add(conn.id);
        connectorsAdded += 1;
        log(`Added missing connector: ${describePart(conn.from)} -> ${describePart(conn.to)} (${conn.relationship || conn.connectorType}).`);
      }

      frontier = nextFrontier;
      hop += 1;
    }
  }

  if (connectorsAdded === 0 && nodesAdded === 0) log('No missing connectors or nodes found.');
  else log(`Done: ${connectorsAdded} connector${connectorsAdded === 1 ? '' : 's'} added, ${nodesAdded} node${nodesAdded === 1 ? '' : 's'} added.`);

  return { connectorsAdded, nodesAdded };
}

/**
 * Async and chunked, not just for correctness at scale (see createBulkLookupCache's
 * doc comment for the O(n²) fix) but because even with that fixed, a genuinely large
 * imported dataset is a lot of individual createStream calls run back to back — each
 * one cheap, but thousands of them add up to real wall-clock time, and running it all
 * in one synchronous block would freeze the tab for that entire duration with no way
 * for the browser to repaint or the person to tell it's still working. Yields control
 * (via a zero-delay setTimeout, letting the browser get a paint/input turn) every
 * PROGRESS_CHUNK_SIZE capabilities, calling onProgress(done, total) at each yield so a
 * caller can show real progress instead of a frozen page.
 */
const GENERATE_INDUSTRY_CHUNK_SIZE = 40;
async function generateIndustry(app, industryKey, onProgress, placeInView = true) {
  const { store } = app;
  const data = store.industryData?.[industryKey];
  if (!data) { app.toast(`Industry data "${industryKey}" not found.`, true); return; }
  // See store.industryTemplates' own comment (state.js) — defaults to 'Enterprise' for
  // every existing dataset (the general one, and anything from a pre-SFCCE Load SFCE);
  // only File > Load SFCCE's data registers a different template here.
  const templateName = store.industryTemplates?.[industryKey] || 'Enterprise';
  const genTemplate = (store.settings.streamTemplates || []).find((t) => ciEq(t.name, templateName));
  // Whether this run's tree has a genuine 4th (Application Capability) level — driven by the
  // TEMPLATE, not by inspecting the tree data itself, so the built-in 'general' dataset
  // (always 3-level, walked via the unchanged branch below) is never at risk of
  // misinterpreting one of its own entity-level nodes as an application capability.
  const hasApplicationCapability = !!(genTemplate && genTemplate.applicationCapabilityNameBegin);

  // Built once, up front — see createBulkLookupCache's own doc comment for why. Without
  // this, generateIndustry on a large dataset (confirmed as the actual cause of a real
  // "site becomes unresponsive" report) was O(n²): every createStream call, and the
  // per-entity idempotency check below, did a full scan of store.doc.parts — which
  // itself grows by several entries on every single one of those calls.
  const lookupCache = createBulkLookupCache(store);
  const findEntityPart = (entityxIds) => entityxIds ? lookupCache.partsByXid.get(`${entityxIds}|${store.defaultModel}`.toLowerCase()) : null;

  // placeInView=false ("Place on current view" unchecked in the Generate Industry
  // prompt): build Parts/Connectors only, skip every view/position concern below —
  // there's no anchor to walk, no view to resize/resolve-overlaps for afterward, and
  // createStream itself (given placeInView=false) never touches a view or viewMember at
  // all. This is what makes a large dataset dramatically cheaper to generate: everything
  // that scales with view SIZE (positioning, redrawNodeSizes, resolveOverlapsForView)
  // simply doesn't run. Review what's generated via Catalogs > Parts (with its own
  // search/filter) or Add Existing into a view afterward, selectively.
  let nextAnchorY = 60, anchorStepY = 0;
  if (placeInView) {
    // Explicit, locally-incremented anchor instead of leaving it to createStream's own
    // default-position logic, which (with no anchor given) scans the view's accumulated
    // viewMembers on every call to find "the bottom" — again fine once, expensive
    // repeated hundreds of times into the same growing view.
    const view = store.findView(store.currentView) || store.addView(store.currentView);
    const { h: genNodeH } = getNodeSize(view);
    const existingPartVms = store.viewMembersForView(view.id).filter((vm) => vm.objectType === 'part');
    nextAnchorY = existingPartVms.length > 0 ? Math.max(...existingPartVms.map((vm) => (vm.y ?? 0) + genNodeH)) + 60 : 60;
    // A single row isn't enough space per job — a template's passive entries place
    // additional nodes on rows BELOW the main chain's row (passiveRow 1, 2, 3, ...), so
    // without accounting for that, the next job's row started overlapping the previous
    // job's passive-node rows (confirmed: real duplicate-position collisions in testing).
    // Reserving (1 + passive.length) rows per job is the same worst-case space
    // createStream's own passivePos() layout can actually use. Keyed off the ACTUAL
    // template this run uses, not always 'Enterprise' — SFCCE has no passive entries at
    // all, so its jobs pack far tighter than Enterprise's would.
    const rowsPerJob = 1 + (genTemplate?.passive?.length || 0);
    anchorStepY = (genNodeH + 44 * (view.spacingScale || 1)) * rowsPerJob;
  }

  // Flattened up front so progress can be reported as a simple "done / total" — the
  // work itself is identical to walking func -> cap -> [appCap ->] entityLevelNodes
  // directly. Two walk shapes, chosen by hasApplicationCapability (computed from the TEMPLATE,
  // not the tree) rather than unconditionally trying 4 levels everywhere: the built-in
  // 'general' dataset (and any pre-SFCCE Load SFCE import) is a genuine 3-level tree —
  // walking it as if a 4th level might exist would treat its own entity-level nodes as
  // application capabilities, which is wrong and was never needed, so that path is untouched.
  const jobs = [];
  for (const func of data) {
    if (!ciEq(func.nodeElementType, 'BusinessFunction')) continue;
    for (const cap of func.nodeChildren || []) {
      if (hasApplicationCapability) {
        const appCapLevelNodes = (cap.nodeChildren && cap.nodeChildren.length > 0) ? cap.nodeChildren : [cap];
        for (const appCap of appCapLevelNodes) {
          const entityLevelNodes = (appCap !== cap && appCap.nodeChildren && appCap.nodeChildren.length > 0) ? appCap.nodeChildren : [appCap];
          for (const ent of entityLevelNodes) {
            if (ent !== appCap && ent !== cap && !ciEq(ent.nodeElementType, 'DataDataEntity')) continue;
            jobs.push({ func, cap, appCap, ent });
          }
        }
      } else {
        const entityLevelNodes = (cap.nodeChildren && cap.nodeChildren.length > 0) ? cap.nodeChildren : [cap];
        for (const ent of entityLevelNodes) {
          if (ent !== cap && !ciEq(ent.nodeElementType, 'DataDataEntity')) continue;
          jobs.push({ func, cap, appCap: null, ent });
        }
      }
    }
  }

  let entityCount = 0, skippedCount = 0;
  for (let i = 0; i < jobs.length; i++) {
    const { func, cap, appCap, ent } = jobs[i];
    const groupKey = appCap ? `${func.nodeId || ''}|${cap.nodeId || ''}|${appCap.nodeId || ''}` : `${func.nodeId || ''}|${cap.nodeId || ''}`;
    const existingEntityPart = findEntityPart(ent.nodeId);
    if (existingEntityPart && (existingEntityPart.other?.generatedFor || []).includes(groupKey)) {
      skippedCount += 1;
    } else {
      createStream(app, {
        templateName,
        streamName: ent.nodeName,
        functionName: func.nodeName, functionDescription: func.nodeDescription, functionxIds: func.nodeId, functionSection: func.nodeSection || '',
        capabilityName: cap.nodeName, capabilityDescription: cap.nodeDescription, capabilityxIds: cap.nodeId,
        applicationCapabilityName: appCap ? appCap.nodeName : undefined, applicationCapabilityDescription: appCap ? appCap.nodeDescription : undefined, applicationCapabilityxIds: appCap ? appCap.nodeId : undefined,
        entityName: ent.nodeName, entityDescription: ent.nodeDescription, entityxIds: ent.nodeId,
        modelName: store.defaultModel, viewName: store.currentView,
        anchorX: 60, anchorY: nextAnchorY,
        silent: true, lookupCache, placeInView,
      });
      nextAnchorY += anchorStepY;
      entityCount += 1;

      const generatedEntityPart = findEntityPart(ent.nodeId);
      if (generatedEntityPart) {
        const list = generatedEntityPart.other?.generatedFor || [];
        if (!list.includes(groupKey)) {
          generatedEntityPart.other = { ...(generatedEntityPart.other || {}), generatedFor: [...list, groupKey] };
        }
      }
    }

    if ((i + 1) % GENERATE_INDUSTRY_CHUNK_SIZE === 0 || i === jobs.length - 1) {
      if (onProgress) onProgress(i + 1, jobs.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (placeInView) {
    // Each createStream call above sets the tab's selection to just its own newly-added
    // nodes, so by the time the loop ends, whatever's selected is only the LAST stream's
    // handful of nodes — but for a large run that's still a misleading, small-looking
    // selection that doesn't represent the actual (possibly huge) amount of work just
    // done. Past a real size threshold, clearing it entirely is more honest than leaving
    // an arbitrary partial selection, and avoids any rendering cost from highlighting a
    // very large selection. Done before the resize/redraw step below (not after), so
    // it's unaffected by anything that step does.
    const genTabForSelection = store.findTabByView(store.currentView);
    if (genTabForSelection && entityCount > 100) genTabForSelection.selection.clear();
    // Newly-generated content may not fit whatever size this view's nodes already were —
    // resize (and nudge apart anything that now overlaps) before rendering, matching what
    // Remap already does internally, so the result looks right immediately instead of
    // requiring a manual Redraw/Remap afterward.
    if (entityCount > 0) redrawAndResolveLayout(app, { viewId: store.currentView, selection: new Set() });
  }
  app.recordAndRender();
  const placementNote = placeInView ? '' : ' — not placed on any view; see Catalogs > Parts or Add Existing';
  app.toast(`Generated ${entityCount} stream${entityCount === 1 ? '' : 's'} from industry "${industryKey}"${skippedCount ? ` (${skippedCount} already existed, skipped)` : ''}${placementNote}.`);
}

// ===================== GENERATE INVENTORY VIEW =====================
/**
 * Creates a new (blank) view named 'inventory-' + defaultModel (deduplicated with a
 * numeric suffix if that name already exists), populates it with every Part (as a
 * viewMember) and every Connector whose both endpoints are in that model, then lays it
 * out using the same logic as Remap — without prompting for sort order, using defaults.
 */
// ===================== ADD EXISTING =====================
/**
 * Adds the given existing Parts as new ViewMembers to the current view (skipping any
 * already placed there), using the same section-aware / no-overlap placement logic as
 * everywhere else. If includeConnectors is true, also adds every connectorType 'c'
 * connector (matching the current Default Model) whose both endpoints are now in the
 * view — either already there, or just added — skipping any already present.
 */
function addExistingPartsToView(app, tab, partIds, includeConnectors) {
  const { store } = app;
  const view = store.findView(tab.viewId);
  if (!view) return;
  const { w: nodeW, h: nodeH } = getNodeSize(view);
  const sectioned = isSectionViewType(view.viewType);
  const placer = sectioned ? createSectionPlacer(store, view) : null;

  const vmByPartId = new Map();
  for (const vm of store.viewMembersForView(view.id)) {
    if (vm.objectType === 'part') vmByPartId.set(vm.objectId, vm);
  }

  let addedCount = 0;
  for (const partId of partIds) {
    const part = store.findPart(partId);
    if (!part || vmByPartId.has(partId)) continue;

    let x, y, sectionId = '';
    if (placer) {
      const pos = placer(part.type);
      x = pos.x; y = pos.y; sectionId = pos.sectionId;
    } else {
      const existingPartVms = store.viewMembersForView(view.id).filter((vm) => vm.objectType === 'part');
      const maxBottom = existingPartVms.length ? Math.max(...existingPartVms.map((vm) => vm.y + nodeH)) : 0;
      const desired = { x: 60, y: maxBottom > 0 ? maxBottom + 60 : 60 };
      const free = store.findNonOverlappingPosition(view.id, desired.x, desired.y, undefined, nodeW, nodeH, view.spacingScale || 1);
      x = free.x; y = free.y;
    }

    const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x, y, sectionId, fillColor: elementGroupFill(store, part.type) });
    vmByPartId.set(part.id, vm);
    addedCount += 1;
  }

  let connCount = 0;
  if (includeConnectors) {
    const relevantPartIds = new Set(vmByPartId.keys());
    const alreadyInViewConnIds = new Set(store.viewMembersForView(view.id).filter((vm) => vm.objectType === 'connector').map((vm) => vm.objectId));
    for (const conn of store.doc.connectors) {
      if (!ciEq(conn.model, store.defaultModel)) continue; // "matching model" — scoped to the current Default Model
      if (!relevantPartIds.has(conn.from) || !relevantPartIds.has(conn.to)) continue;
      if (alreadyInViewConnIds.has(conn.id)) continue;
      const fromVm = vmByPartId.get(conn.from), toVm = vmByPartId.get(conn.to);
      if (!fromVm || !toVm) continue;
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: fromVm.id, toVmId: toVm.id });
      connCount += 1;
    }
  }

  app.recordAndRender();
  app.toast(`Added ${addedCount} part${addedCount === 1 ? '' : 's'}${includeConnectors ? ` and ${connCount} connector${connCount === 1 ? '' : 's'}` : ''}.`);
}

// ===================== POPULATE FROM TEMPLATE =====================
/**
 * For each part in a chosen custom.json `templates` entry: look for an existing Part
 * matching by (xIds, Default Model). If the current view has sections, a part only
 * qualifies at all when its type is allowed by at least one of the view's sections
 * (the template's own sectionId hints are ignored — they belong to the template's own
 * namespace, not necessarily this view's actual sections — placement instead goes
 * through the same section-aware placer used everywhere else). If a match exists,
 * reuse it (add a ViewMember only if one doesn't already exist here); otherwise create
 * a new Part + ViewMember. Freeform views skip the section-eligibility gate entirely
 * and use ordinary no-overlap placement. Finally, for each template connector, create a
 * new connectorType 'c' connector between the resolved parts, using
 * relationshipPairs.default for that type pair (not the template's own relationship
 * hint) — connectors whose endpoint part was skipped for section-eligibility are
 * skipped too.
 */
/**
 * Resolve where a template part should land in a section-based view: prefer the
 * template's own sectionId hint if it happens to name a section this view actually has
 * AND that section allows the part's type (templates authored for a given viewType, like
 * "Enterprise Functions" for 'org', use the SAME sectionId values real 'org' sections
 * use — this is meaningful data, not noise, even though some other templates' hints
 * don't correspond to anything real and must be tolerated). Falls back to the first
 * section (in order) that allows the type if the hint is absent/invalid/disallowed.
 * Returns null if no section anywhere allows this type.
 */
function placeTemplatePart(store, view, layout, tp) {
  if (tp.sectionId) {
    const hinted = layout.find((entry) => ciEq(entry.section.sectionId, tp.sectionId));
    if (hinted && isTypeAllowedInSection(hinted.section, tp.type)) {
      const cell = findFreeCellInSection(store, view.id, hinted, 0, 0);
      return { x: cell.x, y: cell.y, sectionId: hinted.section.sectionId };
    }
  }
  for (const entry of layout) {
    if (!isTypeAllowedInSection(entry.section, tp.type)) continue;
    const cell = findFreeCellInSection(store, view.id, entry, 0, 0);
    return { x: cell.x, y: cell.y, sectionId: entry.section.sectionId };
  }
  return null;
}

function populateFromTemplate(app, tab, templateName) {
  const { store } = app;
  const view = store.findView(tab.viewId);
  if (!view) return;
  const template = (store.settings.templates || []).find((t) => ciEq(t.name, templateName));
  if (!template) { app.toast(`Template "${templateName}" not found.`, true); return; }

  const sectioned = isSectionViewType(view.viewType);
  if (sectioned) store.ensureViewSections(view);
  const layout = sectioned ? computeSectionLayout(view) : null;
  const { w: nodeW, h: nodeH } = getNodeSize(view);

  const existingVmByPartId = new Map();
  for (const vm of store.viewMembersForView(view.id)) {
    if (vm.objectType === 'part') existingVmByPartId.set(vm.objectId, vm);
  }

  const freeformPlace = () => {
    const existingPartVms = store.viewMembersForView(view.id).filter((vm) => vm.objectType === 'part');
    const maxBottom = existingPartVms.length ? Math.max(...existingPartVms.map((vm) => vm.y + nodeH)) : 0;
    const desired = { x: 60, y: maxBottom > 0 ? maxBottom + 60 : 60 };
    return store.findNonOverlappingPosition(view.id, desired.x, desired.y, undefined, nodeW, nodeH, view.spacingScale || 1);
  };

  const resolved = new Map(); // template part.id -> { part, vm } | null (skipped)
  let addedCount = 0, createdCount = 0, skippedCount = 0;

  for (const tp of template.parts || []) {
    const placement = sectioned ? placeTemplatePart(store, view, layout, tp) : null;
    if (sectioned && !placement) {
      resolved.set(tp.id, null);
      skippedCount += 1;
      continue;
    }

    let matchedPart = tp.xIds ? store.doc.parts.find((p) => p.xIds && ciEq(p.xIds, tp.xIds) && ciEq(p.model, store.defaultModel)) : null;
    // Step 33: if no xIds match, also fall back to LABEL + TYPE + MODEL — reuse an
    // identically labeled AND typed part in this model rather than creating a
    // duplicate. Type check added post-Step-37: without it, different template parts
    // that happen to render the same label text could collapse onto one shared part.
    if (!matchedPart) matchedPart = store.doc.parts.find((p) => ciEq(p.label, tp.label) && ciEq(p.type, tp.type) && ciEq(p.model, store.defaultModel));

    if (matchedPart) {
      let vm = existingVmByPartId.get(matchedPart.id);
      if (!vm) {
        let x, y, sectionId = '';
        if (sectioned) { x = placement.x; y = placement.y; sectionId = placement.sectionId; }
        else { const pos = freeformPlace(); x = pos.x; y = pos.y; }
        vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: matchedPart.id, x, y, sectionId, fillColor: elementGroupFill(store, matchedPart.type) });
        existingVmByPartId.set(matchedPart.id, vm);
        addedCount += 1;
      }
      resolved.set(tp.id, { part: matchedPart, vm });
    } else {
      const newPart = store.createPart({ type: tp.type, label: tp.label, model: store.defaultModel, streams: [], note: tp.note || '', xIds: tp.xIds || '' });
      let x, y, sectionId = '';
      if (sectioned) { x = placement.x; y = placement.y; sectionId = placement.sectionId; }
      else { const pos = freeformPlace(); x = pos.x; y = pos.y; }
      const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: newPart.id, x, y, sectionId, fillColor: elementGroupFill(store, newPart.type) });
      existingVmByPartId.set(newPart.id, vm);
      resolved.set(tp.id, { part: newPart, vm });
      createdCount += 1;
    }
  }

  let connCount = 0;
  for (const tc of template.connectors || []) {
    const fromEntry = resolved.get(tc.frompartid);
    const toEntry = resolved.get(tc.topartid);
    if (!fromEntry || !toEntry) continue;
    const pair = findRelationshipPair(store, fromEntry.part.type, toEntry.part.type);
    const defaultKey = pair?.default;
    const relation = defaultKey ? (store.settings.relations || []).find((r) => r.key === defaultKey) : null;
    // Step 33: reuse an existing 'c' connector between these two parts in this model,
    // rather than creating a fresh parallel one every re-run — only the viewMember (this
    // view's placement of it) is new if the connector itself was already there.
    let conn = store.doc.connectors.find((c) => ciEq(c.from, fromEntry.part.id) && ciEq(c.to, toEntry.part.id) && ciEq(c.model, store.defaultModel) && ciEq(c.connectorType, 'c'));
    if (!conn) conn = store.createConnector({ from: fromEntry.part.id, to: toEntry.part.id, model: store.defaultModel, connectorType: 'c', relationship: relation?.name || 'Association', streams: [] });
    const connVmExists = store.doc.viewMembers.some((v) => v.objectType === 'connector' && ciEq(v.objectId, conn.id) && ciEq(v.view, view.id));
    if (!connVmExists) {
      store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: fromEntry.vm.id, toVmId: toEntry.vm.id });
      connCount += 1;
    }
  }

  // Same reasoning as generateIndustry: newly-placed template content may not fit
  // whatever size this view's nodes already were — resize before rendering rather than
  // requiring a manual Redraw/Remap afterward. Also handles section-based views'
  // grid-realignment internally (redrawNodeSizes already does this for section views).
  if (addedCount > 0 || createdCount > 0) redrawAndResolveLayout(app, { viewId: view.id, selection: new Set() });
  app.recordAndRender();
  app.toast(`Populated from "${templateName}": ${addedCount} added, ${createdCount} created, ${skippedCount} skipped, ${connCount} connector${connCount === 1 ? '' : 's'}.`);
}

function generateInventoryView(app) {
  const { store } = app;
  const model = store.defaultModel;
  const baseName = `inventory-${model}`;
  let name = baseName, n = 1;
  while (store.findView(name)) { name = `${baseName}-${n}`; n += 1; }

  const view = store.addView(name);
  const tab = app.createCanvasTab(view);

  const parts = store.doc.parts.filter((p) => ciEq(p.model, model));
  const partIds = new Set(parts.map((p) => p.id));
  const conns = store.doc.connectors.filter((c) => partIds.has(c.from) && partIds.has(c.to));

  const vmByPartId = new Map();
  for (const p of parts) {
    const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: p.id, x: 0, y: 0, fillColor: elementGroupFill(store, p.type), sectionId: '' });
    vmByPartId.set(p.id, vm);
  }
  for (const c of conns) {
    const fromVm = vmByPartId.get(c.from), toVm = vmByPartId.get(c.to);
    if (!fromVm || !toVm) continue;
    store.createViewMember({ view: view.id, objectType: 'connector', objectId: c.id, fromVmId: fromVm.id, toVmId: toVm.id });
  }

  applyRemapLayout(app, view.id); // no sortKeys passed -> defaults inside applyRemapLayout
  app.switchToTab(tab.id);
  // Same reasoning as generateIndustry's own threshold: past a real size, an inventory
  // view can easily place hundreds of nodes at once — leave nothing selected rather
  // than whatever an underlying layout step happened to select.
  if (parts.length > 100) tab.selection.clear();
  app.recordAndRender();
  app.toast(`Generated "${name}" with ${parts.length} parts, ${conns.length} connectors.`);
  return view;
}

/**
 * Section-based counterpart to the freeform layout below. Remap keeps each node in
 * whichever section it's already assigned to (set by manual placement, Populate From
 * Template, Add Existing, etc.) and only reorders/repositions nodes WITHIN that
 * section's grid — reassigning nodes to a different section here would silently
 * override deliberate placement decisions the user (or another command) already made.
 * Nodes with no sectionId, or a sectionId that no longer matches any section on this
 * view, are treated as overflow and stacked in a grid below all sections, same as
 * createSectionPlacer's overflow fallback.
 */
function applyRemapLayoutSectioned(store, view, template, keys, connectionOrderMap, viewRelevantStreams, partVms, nodeW, nodeH) {
  store.ensureViewSections(view);
  const layout = computeSectionLayout(view);
  const layoutBySectionId = new Map(layout.map((entry) => [entry.section.sectionId, entry]));

  const sortFn = (a, b) => {
    const partA = store.findPart(a.objectId), partB = store.findPart(b.objectId);
    for (const key of keys) {
      const va = remapSortValue(store, template, partA, key, connectionOrderMap, viewRelevantStreams);
      const vb = remapSortValue(store, template, partB, key, connectionOrderMap, viewRelevantStreams);
      if (va < vb) return -1;
      if (va > vb) return 1;
    }
    return 0;
  };

  const bySection = new Map(); // sectionId -> vm[]
  const overflow = [];
  for (const vm of partVms) {
    const entry = vm.sectionId ? layoutBySectionId.get(vm.sectionId) : null;
    if (entry) {
      if (!bySection.has(vm.sectionId)) bySection.set(vm.sectionId, []);
      bySection.get(vm.sectionId).push(vm);
    } else {
      overflow.push(vm);
    }
  }

  for (const entry of layout) {
    const vms = bySection.get(entry.section.sectionId) || [];
    vms.sort(sortFn);
    const colCount = Math.max(1, entry.section.columnCount || 1);
    vms.forEach((vm, i) => {
      const row = Math.floor(i / colCount), col = i % colCount;
      // Not using gridToPixel here — it clamps row/col to the section's declared
      // rowCount/columnCount, which would stack every node past capacity into the same
      // last cell instead of spilling further down when a section holds more parts than
      // it's currently sized for (same "accept the overlap" tradeoff findFreeCellInSection
      // makes, but spilling downward instead of overlapping in place).
      vm.x = entry.bodyLeft + col * entry.cellW + NODE_INSET_X;
      vm.y = entry.bodyTop + row * entry.cellH + NODE_INSET_Y;
    });
  }

  overflow.sort(sortFn);
  const spacing = view.spacingScale || 1;
  // Step 38 fix: scale the WHOLE step (node footprint + base gap) by spacing, not just
  // the additive gap alone — the old `nodeW + 40*spacing` only scaled a small constant
  // while nodeW (the dominant term) stayed fixed, so a spacingScale of 1.8 barely moved
  // the visual result at all despite the field correctly holding 1.8. This now actually
  // produces a layout that looks ~1.8x wider, matching what applySpacingScale (used when
  // the user directly cranks the Spacing field) already achieves by proportionally
  // scaling the whole existing layout — Remap's grid-based placement now agrees with it
  // instead of regressing back toward the unscaled default every time it runs.
  const stepX = (nodeW + 40) * spacing, stepY = (nodeH + 44) * spacing;
  const lastEntry = layout[layout.length - 1];
  const overflowTop = lastEntry ? lastEntry.top + lastEntry.height + SECTION_GAP : BASE_Y;
  const overflowCols = 10;
  overflow.forEach((vm, i) => {
    vm.x = BASE_X + (i % overflowCols) * stepX;
    vm.y = overflowTop + Math.floor(i / overflowCols) * stepY;
  });

  const maxCols = layout.reduce((m, entry) => Math.max(m, entry.section.columnCount || 1), overflow.length ? overflowCols : 0);
  return { view, template, maxCols };
}

function applyRemapLayout(app, viewId, options = {}) {
  const { sortKeys, templateName, pattern = 'default', limitColumnsToView = false, visiblePartVmIds = null, forcePreferRight = false, forceGroupRows = false } = options;
  const { store } = app;
  const view = store.findView(viewId);
  if (!view) return null;
  const templates = store.settings.streamTemplates || [];
  let template = templateName ? templates.find((t) => ciEq(t.name, templateName)) : null;
  if (!template) template = templates.find((t) => (t.viewtypes || []).some((vt) => ciEq(vt, view.viewType)));
  if (!template) template = templates.find((t) => ciEq(t.name, 'Enterprise'));
  if (!template) template = templates[0];
  if (!template) return null;

  // "redraw" first: determine the best node size for this view's current content,
  // then base all spacing on that instead of a fixed constant.
  redrawNodeSizes(app, { viewId, selection: new Set() });
  const { w: nodeW, h: nodeH } = getNodeSize(view);
  const keys = (sortKeys && sortKeys.length ? sortKeys : DEFAULT_REMAP_SORT_KEYS).filter((k) => REMAP_SORT_KEYS.includes(k));
  const viewRelevantStreams = resolveViewRelevantStreams(store, viewId);
  const connectionOrderMap = keys.includes('connectionOrder') ? computeConnectionOrder(store, viewId, viewRelevantStreams) : null;

  // Step 40: when visiblePartVmIds is given (the "only remap filtered nodes" checkbox),
  // any part-viewMember NOT in that set is excluded from the layout algorithm entirely —
  // it keeps its current x/y untouched and stays a normal viewMember in the document
  // (visible again the moment its filter no longer hides it), rather than being moved
  // to wherever the algorithm would otherwise have placed it.
  const partVms = store.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part' && (!visiblePartVmIds || visiblePartVmIds.has(vm.id)));
  const connVms = store.viewMembersForView(viewId).filter((vm) => vm.objectType === 'connector');

  // Section-based views (viewType !== 'ff') lay out via a fixed section grid, not the
  // freeform row/column chain below — reuse the same sort-key logic but place each node
  // within the section it's already assigned to instead of overwriting x/y with freeform
  // stacking math (which is what was throwing every node to the top-left, ignoring
  // sections entirely).
  if (isSectionViewType(view.viewType)) {
    return applyRemapLayoutSectioned(store, view, template, keys, connectionOrderMap, viewRelevantStreams, partVms, nodeW, nodeH);
  }

  if (pattern === 'force') {
    // Force-directed placement doesn't use sort keys, passive-row special-casing, or
    // column wrapping at all — it's driven entirely by which nodes are actually
    // connected to which, via connVms (already scoped to this view and, when
    // visiblePartVmIds is set, already excludes anything hidden by the current filter —
    // same as every other pattern here).
    //
    // Fix for a real bug report: laying out the WHOLE graph in one continuous force
    // simulation left genuinely disconnected components (e.g. two separate connected
    // pairs, nothing linking them) an unpredictable, sometimes far-off-canvas distance
    // apart — a plain gravity term only dampens that drift, it doesn't bound it. Instead,
    // each connected component gets its own independent force-directed layout (nothing
    // to drift apart from, since there's no cross-component interaction at all), snapped
    // to a grid (cell size = node size, same convention used everywhere else in Remap),
    // then the components are packed into adjacent, guaranteed-non-overlapping grid
    // regions — shelf-style, largest cluster first.
    const spacingForce = view.spacingScale || 1;
    const nodesForLayout = partVms.map((vm) => ({ id: vm.id, x: vm.x, y: vm.y, w: nodeW, h: nodeH }));
    const vmIdSet = new Set(partVms.map((vm) => vm.id));
    const edgesForLayout = [];
    for (const cv of connVms) {
      if (!vmIdSet.has(cv.fromVmId) || !vmIdSet.has(cv.toVmId)) continue; // connector touches a node excluded by the current filter
      edgesForLayout.push({ from: cv.fromVmId, to: cv.toVmId });
    }
    const stepXForce = (nodeW + 40) * spacingForce, stepYForce = (nodeH + 44) * spacingForce;
    const positions = computeClusteredGridLayout(nodesForLayout, edgesForLayout, {
      stepX: stepXForce, stepY: stepYForce,
      idealDistanceScale: 2.2 * spacingForce, // reuse the view's own Spacing setting to scale each cluster's own internal layout too, consistent with every other pattern
      preferRightPlacement: forcePreferRight, // place a newly-discovered connected node to the right of its parent when free, instead of the default direction
      onlyNewRowForNewGroup: forceGroupRows, // row is fixed by BFS depth (a "group" = one hop further from the root) — a node only moves to a new row when it's genuinely a new hop away, not just because a nearby cell was taken
    });
    for (const vm of partVms) {
      const p = positions.get(vm.id);
      if (p) { vm.x = p.x; vm.y = p.y; }
    }
    return { view, template, maxCols: partVms.length };
  }

  const passivePartIds = new Set();
  for (const cv of connVms) {
    const conn = store.findConnector(cv.objectId);
    if (!conn || !ciEq(conn.relationship, 'Passive')) continue;
    passivePartIds.add(conn.from);
    passivePartIds.add(conn.to);
  }
  // Only a passive element whose TYPE isn't present in the template's own value[] chain
  // gets pulled into special row-above placement — a passive element whose type IS in
  // value[] (e.g. Enterprise's BusinessProcess) is really just ordinary chain content
  // and belongs with its own element.group's row like anything else.
  const templateValueTypes = new Set((template.value || []).map((v) => String(v).toLowerCase()));
  const isSpecialPassiveType = (type) => !templateValueTypes.has(String(type).toLowerCase());

  const passiveVms = [], remainingVms = [];
  for (const vm of partVms) {
    const part = store.findPart(vm.objectId);
    if (!part) continue;
    if (passivePartIds.has(part.id) && isSpecialPassiveType(part.type)) passiveVms.push(vm);
    else remainingVms.push(vm);
  }

  const spacing = view.spacingScale || 1;
  // Step 38 fix: same "scale the whole step" correction as the sectioned-overflow branch
  // above — see its comment for the full explanation.
  const stepX = (nodeW + 40) * spacing, stepY = (nodeH + 44) * spacing, baseX = 60, rowBaseY = 40;
  const zoom = app.store.activeTab()?.viewport?.zoom || 1;
  const maxCols = limitColumnsToView ? estimateMaxCols(stepX, baseX, zoom) : Infinity;

  if (pattern === 'none') {
    // simple flat placement: sorted order (per the chosen keys), wrapping only at
    // maxCols (or one continuous row if unlimited) — no stream-boundary row breaks.
    const allSorted = [...remainingVms, ...passiveVms].sort((a, b) => {
      const partA = store.findPart(a.objectId), partB = store.findPart(b.objectId);
      for (const key of keys) {
        const va = remapSortValue(store, template, partA, key, connectionOrderMap, viewRelevantStreams);
        const vb = remapSortValue(store, template, partB, key, connectionOrderMap, viewRelevantStreams);
        if (va < vb) return -1;
        if (va > vb) return 1;
      }
      return 0;
    });
    const wrapCols = Number.isFinite(maxCols) ? maxCols : allSorted.length || 1;
    allSorted.forEach((vm, i) => {
      vm.x = baseX + (i % wrapCols) * stepX;
      vm.y = rowBaseY + Math.floor(i / wrapCols) * stepY;
    });
    return { view, template, maxCols: Number.isFinite(maxCols) ? maxCols : allSorted.length };
  }

  // 'default' pattern: group by stream name (row-per-group), and within a group start a
  // new row on every element.group change too (Step 18); ordered by streamTemplate.value
  // position, then any remaining unresolved types, then the user's chosen sort-priority
  // keys as further tie-breakers. Main content begins at the SECOND row (row index 1).
  // Special passive elements (type not in template.value) go one row above the row
  // where their OWN element.group appears within their OWN stream's block, appended
  // after whatever else already occupies that row — falling back to one row above the
  // stream's own first row if that group never appears in the stream at all.
  const defaultKeys = ['streamName', 'streamOrder', ...keys.filter((k) => k !== 'streamName' && k !== 'streamOrder')];
  remainingVms.sort((a, b) => {
    const partA = store.findPart(a.objectId), partB = store.findPart(b.objectId);
    for (const key of defaultKeys) {
      const va = remapSortValue(store, template, partA, key, connectionOrderMap, viewRelevantStreams);
      const vb = remapSortValue(store, template, partB, key, connectionOrderMap, viewRelevantStreams);
      if (va < vb) return -1;
      if (va > vb) return 1;
    }
    return 0;
  });

  let row = 1, col = 0, lastStreamName = null, lastElementGroup = null;
  const groupFirstRow = new Map();      // streamName -> first row it appears on (fallback target)
  const groupRowByStreamGroup = new Map(); // "streamName|elementGroup" -> row that group landed on
  const rowLastCol = new Map();         // row index -> last used column in that row
  for (const vm of remainingVms) {
    const part = store.findPart(vm.objectId);
    const sName = viewRelevantStreams.get(part.id) ?? ((part.streams || [])[0] || '');
    const elGroup = elementByType(store, part.type)?.group || '';
    if (lastStreamName !== null && sName !== lastStreamName) { row += 1; col = 0; }
    else if (lastElementGroup !== null && elGroup !== lastElementGroup) { row += 1; col = 0; }
    else if (Number.isFinite(maxCols) && col >= maxCols) { row += 1; col = 0; }
    if (!groupFirstRow.has(sName)) groupFirstRow.set(sName, row);
    const streamGroupKey = `${sName}|${elGroup}`;
    if (!groupRowByStreamGroup.has(streamGroupKey)) groupRowByStreamGroup.set(streamGroupKey, row);
    vm.x = baseX + col * stepX;
    vm.y = rowBaseY + row * stepY;
    rowLastCol.set(row, col);
    col += 1;
    lastStreamName = sName;
    lastElementGroup = elGroup;
  }

  for (const vm of passiveVms) {
    const part = store.findPart(vm.objectId);
    const sName = viewRelevantStreams.get(part.id) ?? ((part.streams || [])[0] || '');
    const ownElGroup = elementByType(store, part.type)?.group || '';
    const streamGroupKey = `${sName}|${ownElGroup}`;
    const groupRow = groupRowByStreamGroup.has(streamGroupKey) ? groupRowByStreamGroup.get(streamGroupKey) : (groupFirstRow.get(sName) ?? 1);
    const targetRow = groupRow - 1;
    const usedCol = rowLastCol.has(targetRow) ? rowLastCol.get(targetRow) : -1;
    const targetCol = usedCol + 1;
    vm.x = baseX + targetCol * stepX;
    vm.y = rowBaseY + targetRow * stepY;
    rowLastCol.set(targetRow, targetCol);
  }

  return { view, template, maxCols: Number.isFinite(maxCols) ? maxCols : (rowLastCol.size ? Math.max(...rowLastCol.values()) + 1 : 0) };
}

function remap(app, tab, options = {}) {
  const result = applyRemapLayout(app, tab.viewId, options);
  if (!result) { app.toast('No stream templates available to remap against.', true); return; }
  if (options.sortKeys && options.sortKeys.length) result.view.remapSortKeys = options.sortKeys;
  app.recordAndRender();
  const detail = options.pattern === 'force' ? 'force-directed placement' : `${result.maxCols} columns`;
  app.toast(`Remapped "${result.view.viewName}" using template "${result.template.name}" (${detail}).`);
}

// ===================== MERGE =====================
function mergePartsAndView(app, tab, selectedVmIds, newName) {
  const { store } = app;
  const vms = selectedVmIds.map((id) => store.findViewMember(id)).filter((vm) => vm && vm.objectType === 'part');
  if (vms.length < 2) { app.toast('Select 2 or more nodes to merge.', true); return; }

  const [firstVm, ...restVms] = vms;
  const firstPart = store.findPart(firstVm.objectId);
  const restParts = restVms.map((vm) => store.findPart(vm.objectId)).filter(Boolean);
  if (!firstPart) return;

  const restPartIds = new Set(restParts.map((p) => p.id));

  // Update name and streams
  firstPart.label = newName;
  firstPart.rawLabel = newName;
  const mergedStreams = new Set(firstPart.streams || []);
  for (const p of restParts) {
    for (const s of (p.streams || [])) mergedStreams.add(s);
  }
  firstPart.streams = [...mergedStreams];

  // Add note about merge
  const mergedIds = restParts.map((p) => p.id).join(', ');
  firstPart.note = (firstPart.note || '') + (firstPart.note ? '\n' : '') + `Merged with part(s): ${mergedIds}`;

  // Rewire all connectors globally (across all views)
  for (const conn of store.doc.connectors) {
    if (restPartIds.has(conn.from)) conn.from = firstPart.id;
    if (restPartIds.has(conn.to)) conn.to = firstPart.id;
  }

  // Rewire connector viewMembers in all views
  const restVmIds = new Set(restVms.map((vm) => vm.id));
  for (const cvm of store.doc.viewMembers) {
    if (cvm.objectType !== 'connector') continue;
    if (restVmIds.has(cvm.fromVmId)) cvm.fromVmId = firstVm.id;
    if (restVmIds.has(cvm.toVmId)) cvm.toVmId = firstVm.id;
  }

  // Remove merged-away viewMembers from all views
  for (const vm of restVms) store.deleteViewMember(vm.id);

  // De-duplicate connectors globally: same from + to + connectorType
  const seenKey = new Map();
  for (const conn of [...store.doc.connectors]) {
    const key = `${conn.from}|${conn.to}|${conn.connectorType}`;
    if (seenKey.has(key)) {
      store.deleteConnectorAndMembers(conn.id);
    } else {
      seenKey.set(key, conn.id);
    }
  }

  // Delete the merged parts
  for (const p of restParts) store.deletePart(p.id);

  tab.selection.clear();
  tab.selection.add(firstVm.id);
  app.recordAndRender();
  app.toast(`Merged ${vms.length} parts into "${newName}" across all views.`);
}

function mergeViewOnly(app, tab, selectedVmIds, newName) {
  const { store } = app;
  const vms = selectedVmIds.map((id) => store.findViewMember(id)).filter((vm) => vm && vm.objectType === 'part');
  if (vms.length < 2) { app.toast('Select 2 or more nodes to merge.', true); return; }

  const [firstVm, ...restVms] = vms;
  const firstPart = store.findPart(firstVm.objectId);
  if (!firstPart) return;

  // Update first part's name in current view only (affects the viewMember's visual representation)
  firstPart.label = newName;
  firstPart.rawLabel = newName;

  const restVmIds = new Set(restVms.map((vm) => vm.id));

  // Rewire connector viewMembers in current view only
  for (const cvm of store.viewMembersForView(tab.viewId)) {
    if (cvm.objectType !== 'connector') continue;
    if (restVmIds.has(cvm.fromVmId)) cvm.fromVmId = firstVm.id;
    if (restVmIds.has(cvm.toVmId)) cvm.toVmId = firstVm.id;
  }

  // De-duplicate connector viewMembers in this view only: same from + to + relationship
  const connVms = store.viewMembersForView(tab.viewId).filter((vm) => vm.objectType === 'connector');
  const seenKey = new Map();
  for (const cvm of [...connVms]) {
    const conn = store.findConnector(cvm.objectId);
    if (!conn) continue;
    const key = `${cvm.fromVmId}|${cvm.toVmId}|${conn.connectorType}`;
    if (seenKey.has(key)) {
      store.deleteViewMember(cvm.id);
    } else {
      seenKey.set(key, cvm.id);
    }
  }

  // Handle linked views: if only one has a linked view, set it on firstVm; if both do, merge them
  const firstLinkedViewName = firstVm.linkedViewName;
  for (const restVm of restVms) {
    if (restVm.linkedViewName && !firstLinkedViewName) {
      firstVm.linkedViewName = restVm.linkedViewName;
    } else if (restVm.linkedViewName && firstLinkedViewName && restVm.linkedViewName !== firstLinkedViewName) {
      // Merge the two linked views: move all objects from restVm's linked view to firstVm's linked view
      const restLinkedView = store.findView(restVm.linkedViewName);
      const firstLinkedView = store.findView(firstLinkedViewName);
      if (restLinkedView && firstLinkedView) {
        const restViewMembers = store.viewMembersForView(restLinkedView.id);
        for (const vm of restViewMembers) {
          vm.view = firstLinkedView.id;
        }
      }
      // Delete the merged-away linked view
      if (restLinkedView) store.deleteView(restLinkedView.id);
    }
  }

  // Remove merged-away viewMembers from this view
  for (const vm of restVms) store.deleteViewMember(vm.id);

  tab.selection.clear();
  tab.selection.add(firstVm.id);
  app.recordAndRender();
  app.toast(`Merged ${vms.length} nodes into "${newName}" in this view.`);
}

/**
 * Legacy: kept for backwards compatibility. Use mergePartsAndView or mergeViewOnly instead.
 */
function mergeNodes(app, tab, selectedVmIds, newName, mergeParts) {
  if (mergeParts) {
    mergePartsAndView(app, tab, selectedVmIds, newName);
  } else {
    mergeViewOnly(app, tab, selectedVmIds, newName);
  }
}

// ===================== DUPLICATE SECTION =====================
/**
 * Section Property Panel "Duplicate Section": inserts a copy of the section's
 * definition (row/column counts, elementTypes) immediately below it — sectionId/name
 * incremented from the original, all section order numbers adjusted — then duplicates
 * every part currently placed in the ORIGINAL section into the new one: real duplicate
 * Part records (not isExternal references — unlike Level Up/Down's neighbor copies,
 * these are genuinely new parts, matching "duplicate all section nodes/viewMembers and
 * parts"), with the label incremented the same way section names are (Step 28: "Audit"
 * -> "Audit 2"), placed via the same section-grid free-cell placement used elsewhere.
 * Any connector whose BOTH endpoints are among the duplicated nodes gets its own
 * duplicated connector (new id) wired between the two new parts.
 *
 * Step 28 fix: the free-cell placement above landed nodes correctly on their own, but
 * the view's OTHER sections could still be sized/positioned for the view's node count
 * as of before this section was duplicated — sizing/positioning drifts are exactly what
 * Remap already resolves (it starts with a redraw for current node sizes, then
 * re-lays-out every section from scratch), so run it once at the end instead of
 * re-deriving the same placement logic here.
 */
function duplicateSection(app, tab, sectionInstanceId) {
  const { store } = app;
  const view = store.findView(tab.viewId);
  if (!view) return;
  const original = (view.sections || []).find((s) => s.id === sectionInstanceId);
  if (!original) return;
  const originalSectionKey = original.sectionId;
  const originalName = original.name;

  const newSection = duplicateSectionDefinition(view, sectionInstanceId);
  if (!newSection) return;

  const layout = computeSectionLayout(view);
  const newEntry = layout.find((entry) => entry.section.id === newSection.id);

  const oldPartVms = store.viewMembersForView(view.id)
    .filter((vm) => vm.objectType === 'part' && vm.sectionId === originalSectionKey);

  const oldVmToNewVm = new Map(); // original part-vm id -> new part-vm (in the new section)
  for (const vm of oldPartVms) {
    const part = store.findPart(vm.objectId);
    if (!part) continue;
    const newPart = store.createPart({
      type: part.type, label: nextStreamName(part.label), model: part.model,
      streams: [...(part.streams || [])], note: part.note || '',
      order: part.order, other: { ...(part.other || {}) }, xIds: part.xIds || '',
    });
    let x = vm.x, y = vm.y;
    if (newEntry) {
      const cell = findFreeCellInSection(store, view.id, newEntry, 0, 0);
      x = cell.x; y = cell.y;
    }
    const newVm = store.createViewMember({
      view: view.id, objectType: 'part', objectId: newPart.id, x, y,
      sectionId: newSection.sectionId, fillColor: vm.fillColor,
    });
    oldVmToNewVm.set(vm.id, newVm);
  }

  // connectors fully internal to the duplicated set (both endpoints duplicated) get
  // duplicated too, wired between the two new parts — a new connector id each time.
  const connVmsInView = store.viewMembersForView(view.id).filter((vm) => vm.objectType === 'connector');
  const seenConnIds = new Set();
  let connDupCount = 0;
  for (const cv of connVmsInView) {
    if (seenConnIds.has(cv.objectId)) continue;
    const newFromVm = oldVmToNewVm.get(cv.fromVmId);
    const newToVm = oldVmToNewVm.get(cv.toVmId);
    if (!newFromVm || !newToVm) continue;
    const conn = store.findConnector(cv.objectId);
    if (!conn) continue;
    seenConnIds.add(cv.objectId);
    const newConn = store.createConnector({
      from: newFromVm.objectId, to: newToVm.objectId, model: conn.model,
      connectorType: conn.connectorType, relationship: conn.relationship,
      streams: [...(conn.streams || [])],
    });
    store.createViewMember({ view: view.id, objectType: 'connector', objectId: newConn.id, fromVmId: newFromVm.id, toVmId: newToVm.id });
    connDupCount += 1;
  }

  applyRemapLayout(app, view.id, {});

  tab.selectedSectionId = newSection.id;
  app.recordAndRender();
  app.toast(`Duplicated section "${originalName}" as "${newSection.name}" (${oldVmToNewVm.size} node${oldVmToNewVm.size === 1 ? '' : 's'}, ${connDupCount} connector${connDupCount === 1 ? '' : 's'}).`);
}

export { createStream, duplicateStream, nextStreamName, splitNode, levelUp, levelDown, levelDownSingle, copyNodes, pasteNodes, remap, applyRemapLayout, mergeNodes, mergePartsAndView, mergeViewOnly, REMAP_SORT_KEYS, REMAP_SORT_LABELS, DEFAULT_REMAP_SORT_KEYS, generateInventoryView, generateIndustry, addExistingPartsToView, populateFromTemplate, duplicateSection, smartCheckView, smartCheckNode, createBulkLookupCache, scanStreamsForAutoComplete, autoCompleteStreams, deriveStreamNames };
