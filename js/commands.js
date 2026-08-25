// commands.js — Duplicate Stream, Split Node, Level Up, Level Down, Generate (createStream)
import { ciEq, newId, relationCodeFor } from './state.js';
import { elementByType, findRelationshipPair, isRelationValid } from './rules.js';
import { isSectionViewType, createSectionPlacer, computeSectionLayout, isTypeAllowedInSection, findFreeCellInSection, findFreeCellOrGrowSection, duplicateSectionDefinition, BASE_X, BASE_Y, SECTION_GAP, NODE_INSET_X, NODE_INSET_Y } from './sections.js';
import { redrawNodeSizes, redrawAndResolveLayout, getNodeSize } from './canvas.js';
import { computeClusteredGridLayout, computeHubClusterGridLayout } from './layout.js';
import { pushMessageLog } from './simulation.js';
import { parseDDL, generateDDL } from './ddl.js';

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
    plainConnsByFromTo: new Map(), // `${fromId}|${toId}|${model}`.toLowerCase() -> connector (connectorType 'c' only) -- Organization Unit assignment wiring
    connVmsByConnView: new Map(),  // `${connId}|${viewId}` -> viewMember
  };
  for (const p of store.doc.parts) cacheRegisterPart(cache, p);
  for (const c of store.doc.connectors) {
    if (ciEq(c.connectorType, 's')) cacheRegisterStreamConn(cache, c);
    else if (ciEq(c.connectorType, 'c')) cacheRegisterPlainConn(cache, c);
  }
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
function cacheRegisterPlainConn(cache, conn) {
  cache.plainConnsByFromTo.set(`${conn.from}|${conn.to}|${conn.model}`.toLowerCase(), conn);
}
function cacheRegisterConnVm(cache, vm) {
  cache.connVmsByConnView.set(`${vm.objectId}|${vm.view}`, vm);
}

function createStream(app, {
  templateName, streamName, functionName, capabilityName, entityName, modelName, viewName, anchorX, anchorY,
  functionDescription = '', functionxIds = '', functionSection = '',
  sectionId = '', sectionDescription = '',
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
  // Captured for the Organization Unit wiring below — the ONE canonical BusinessFunction
  // part/vm this stream's chain creates or reuses, not every "function-category"
  // supporting node the loop below also walks through.
  let functionPart = null, functionVm = null;

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
    if (category === 'function' && isPreciseCategoryMatch) { functionPart = part; functionVm = vm; }

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
    // BusinessOrganizationUnit is handled entirely by the dedicated section-reification
    // block below (labeled by the function's actual Section value, Assignment-connected,
    // shared across every function in that section) — every shipped template's own
    // passive[] array also lists {from:'BusinessOrganizationUnit', to:'BusinessFunction'}
    // (added so the 3D View's own "is this type in this Layer Order template" scan, which
    // reads value[]+passive[], keeps OrgUnit parts visible there), so without this guard
    // the generic mechanism below would ALSO create a second, wrongly-labeled (by
    // capability/entity name instead of section) OrgUnit per stream, connected via a
    // generic Stream/Passive connector instead of Assignment, duplicating that block's
    // own work. Confirmed as a real, not just theoretical, bug: surfaced the first time
    // generateIndustry actually ran a section-tagged dataset (the built-in default, once
    // it became a genuine 4-level SFCCE tree) through a template with this passive entry.
    if (ciEq(p.from, 'BusinessOrganizationUnit') || ciEq(p.to, 'BusinessOrganizationUnit')) continue;
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
    // Some templates (e.g. 'SFCCE') carry BusinessFunction only as a passive node, not
    // in the main value[] chain at all — capture it here too, same as the main loop
    // above, so the Organization Unit wiring below finds it regardless of which shape
    // this particular template uses.
    for (const entry of [fromEntry, toEntry]) if (!functionPart && ciEq(entry.part.type, 'BusinessFunction')) { functionPart = entry.part; functionVm = entry.vm; }

    const conn = findOrCreateStreamConnector(store, view, fromEntry.part, toEntry.part, fromEntry.vm, toEntry.vm, modelName, streamName, 'Passive', `p${passiveRow}c`, lookupCache, placeInView);
  }

  // Reify the function's own "section" as an actual Business Organization Unit part
  // (aka OrgUnit) instead of leaving it as only a plain string tag on the function part
  // -- reported directly: "When we import or generate involving sections, these will
  // now be business organization units... when loading SFCCE for example, now generate
  // a orgunit part." One OrgUnit part per unique section VALUE per model, reused across
  // every function that shares it (never duplicated) — same find-or-create-by-(label,
  // type, model) convention the rest of this function already uses for capability/
  // entity reuse, just keyed on the section string as the label. Assignment-connected
  // to the function it's responsible for: the standard ArchiMate "active structure
  // element assigned to a behavior element" relationship, matching how a Business
  // Actor/Role would ordinarily relate to a Business Function it performs. Runs after
  // BOTH the main chain loop and the passive loop above, since the function node can
  // come from either one depending on the template's own shape.
  if (functionSection && functionPart) {
    const orgUnitKey = `${functionSection}|BusinessOrganizationUnit|${modelName}`.toLowerCase();
    let orgUnitPart = lookupCache
      ? lookupCache.partsByKey.get(orgUnitKey)
      : store.doc.parts.find((p) => ciEq(p.label, functionSection) && ciEq(p.type, 'BusinessOrganizationUnit') && ciEq(p.model, modelName));
    if (!orgUnitPart) {
      orgUnitPart = store.createPart({ type: 'BusinessOrganizationUnit', label: functionSection, model: modelName, streams: [], note: 'org unit', order: 0, other: {}, section: functionSection, description: sectionDescription, xIds: sectionId });
      if (lookupCache) cacheRegisterPart(lookupCache, orgUnitPart);
    }

    let orgUnitVm = null;
    if (placeInView) {
      orgUnitVm = lookupCache
        ? lookupCache.vmsByPartView.get(`${orgUnitPart.id}|${view.id}`)
        : store.doc.viewMembers.find((v) => v.objectType === 'part' && ciEq(v.objectId, orgUnitPart.id) && ciEq(v.view, view.id));
      if (!orgUnitVm) {
        const desired = { x: (functionVm?.x ?? baseX), y: (functionVm?.y ?? baseY) - stepY };
        const { w: orgUnitNodeW, h: orgUnitNodeH } = getNodeSize(view);
        const free = placer ? placer('BusinessOrganizationUnit') : store.findNonOverlappingPosition(view.id, desired.x, desired.y, undefined, orgUnitNodeW, orgUnitNodeH, genSpacing, lookupCache);
        orgUnitVm = store.createViewMember({
          view: view.id, objectType: 'part', objectId: orgUnitPart.id,
          x: free.x, y: free.y, sectionId: free.sectionId || '', fillColor: elementGroupFill(store, 'BusinessOrganizationUnit'),
        });
        newlyCreatedVmIds.push(orgUnitVm.id);
        if (lookupCache) cacheRegisterVm(lookupCache, orgUnitVm);
      }
    }

    const orgUnitConnKey = `${orgUnitPart.id}|${functionPart.id}|${modelName}`.toLowerCase();
    let orgUnitConn = lookupCache
      ? lookupCache.plainConnsByFromTo.get(orgUnitConnKey)
      : store.findExistingConnector(orgUnitPart.id, functionPart.id, modelName, 'c');
    if (!orgUnitConn) {
      const assignRel = (store.settings.relations || []).find((r) => r.key === 'i'); // Assignment
      orgUnitConn = store.createConnector({ from: orgUnitPart.id, to: functionPart.id, model: modelName, connectorType: 'c', relationship: assignRel?.name || 'Assignment' });
      if (lookupCache) cacheRegisterPlainConn(lookupCache, orgUnitConn);
    }

    if (placeInView) {
      const orgUnitConnVm = lookupCache
        ? lookupCache.connVmsByConnView.get(`${orgUnitConn.id}|${view.id}`)
        : store.doc.viewMembers.find((v) => v.objectType === 'connector' && ciEq(v.objectId, orgUnitConn.id) && ciEq(v.view, view.id));
      if (!orgUnitConnVm) {
        const connVm = store.createViewMember({ view: view.id, objectType: 'connector', objectId: orgUnitConn.id, fromVmId: orgUnitVm.id, toVmId: functionVm.id });
        if (lookupCache) cacheRegisterConnVm(lookupCache, connVm);
      }
    }
  }

  if (placeInView) {
    const newVmIds = newlyCreatedVmIds;
    const genTab = store.findTabByView(view.id);
    if (genTab) { genTab.selection.clear(); for (const id of newVmIds) genTab.selection.add(id); }
  }

  if (!silent) {
    app.recordAndRender();
    app.toast(`Generated stream "${streamName}" from template "${templateName}".`, false, true);
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
  app.toast(`Duplicated stream "${originalStream}" as "${newStreamName}".`, false, true);
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
  app.toast(`Created view "${newViewName}" (Level Up) with ${partVms.length} node${partVms.length === 1 ? '' : 's'} carried up.`, false, true);
}

/** Data Modeling: Level Up on a single selected DataEntityDetails node is the exact
 * reverse of Level Down on a DataDataEntity (levelDownSingle's DataDataEntity ->
 * DataEntityDetails special case, above) -- reported directly: "when a single
 * dataentitydetail is selected and user selects 'level-up' command, create (if
 * doesn't already exist, otherwise just open) a new datadataentity part/node of the
 * same label name with link/connector result as when done in reverse where user
 * selected datadataentity and did level-down." Dispatched from runCommand (main.js)
 * INSTEAD of the generic levelUp above, only when exactly one DataEntityDetails part
 * is selected -- every other selection (none, multiple, or a different type) still
 * gets the ordinary "prompt for a new view name" Level Up unchanged.
 *
 * "Doesn't already exist" is checked via findCompositionParentConn -- the SAME
 * Composition-lookup levelDownSingle's own Part-level reuse guard uses, just walked
 * in the other direction (this part is the "to"/child side; its parent, if any, is
 * conn.from). If found, this just opens/selects wherever that parent Part happens to
 * be placed (its first ViewMember) instead of creating a duplicate -- a DataDataEntity
 * can be placed on more than one view (ordinary usage, e.g. shared across Streams),
 * so "first placement found" is a reasonable, deterministic choice, not a guarantee
 * of uniqueness.
 *
 * If no parent exists yet, creates one: a new DataDataEntity part with the SAME label,
 * a fresh dedicated view (same "New View"/dedup-suffix naming levelDownSingle uses),
 * and the identical link shape levelDownSingle produces in the other direction -- an
 * unplaced Composition connector (from: new parent, to: this DataEntityDetails part)
 * plus the parent's own new ViewMember's linkedViewName pointing DOWN at the CURRENT
 * view (the one this DataEntityDetails node already lives on) -- so double-clicking
 * the new parent node navigates straight back down to this exact Entity Details view,
 * exactly mirroring how the parent's own vm.linkedViewName works after a normal Level
 * Down. */
function levelUpEntityDetails(app, tab, vmId) {
  const { store } = app;
  const vm = store.findViewMember(vmId);
  const part = vm && store.findPart(vm.objectId);
  if (!part) return;

  const parentConn = findCompositionParentConn(store, part.id);
  if (parentConn) {
    const parentVm = store.doc.viewMembers.find((v) => v.objectType === 'part' && ciEq(v.objectId, parentConn.from));
    if (parentVm) {
      const parentPart = store.findPart(parentConn.from);
      const parentView = store.findView(parentVm.view);
      const parentTab = app.createCanvasTab(parentView);
      app.switchToTab(parentTab.id);
      parentTab.selection = new Set([parentVm.id]);
      app.recordAndRender();
      app.toast(`Opened existing Data Entity "${parentPart.label}".`);
      return;
    }
    // Composition connector exists but its parent Part has no placement anywhere --
    // not reachable via any normal flow (the parent was necessarily placed somewhere
    // to have been decomposed from in the first place), but fall through rather than
    // silently doing nothing if it ever happens.
  }

  const parentPart = parentConn
    ? store.findPart(parentConn.from)
    : store.createPart({ type: 'DataDataEntity', label: part.label, model: part.model, streams: [...(part.streams || [])], note: part.note, order: part.order, other: part.other });
  if (!parentConn) {
    store.createConnector({ from: parentPart.id, to: part.id, model: part.model, connectorType: 'c', relationship: 'Composition' });
  }

  let newViewName = parentPart.label || 'New View';
  if (store.findView(newViewName)) {
    let n = 1;
    while (store.findView(`${newViewName} ${n}`)) n++;
    newViewName = `${newViewName} ${n}`;
  }
  const view = store.addView(newViewName);
  const newTab = app.createCanvasTab(view);
  const parentVm = store.createViewMember({
    view: view.id, objectType: 'part', objectId: parentPart.id,
    x: 200, y: 150, fillColor: elementGroupFill(store, 'DataDataEntity'),
    linkedViewName: tab.viewId, // links back down to this Entity Details view
  });

  app.recordAndRender();
  app.switchToTab(newTab.id);
  app.toast(`Created Data Entity "${parentPart.label}" (Level Up), linked to "${part.label}".`, false, true);
}

// ===================== LEVEL DOWN =====================
/**
 * Single-node variant used by double-click when a node has no linkedViewName yet:
 * creates a new (blank) view, links the ORIGINAL node down to it (linkedViewName), and
 * populates the new view with a genuinely NEW Part representing this node's own
 * decomposition — same type/label/model/streams/note/order/other as the original
 * (copied once, as a starting point), but a distinct identity, exactly the same
 * new-Part-not-a-shared-reference approach Split Node already uses. This used to place a
 * second viewMember of the SAME part (only a new placement, not a new Part) as the new
 * view's anchor — meaning editing/renaming/retyping the decomposition's own anchor node
 * silently edited the summary-level node too, since they were the identical Part
 * underneath; reported directly from using it ("it should create a new process part").
 * The original node's own viewMember (up at the parent level) is untouched either way —
 * its type/identity never changes, only linkedViewName gets set.
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

  // A new, distinct Part for the new view's own anchor — NOT the same part.id as the
  // node being leveled down from (see this function's own doc comment for why). Keeps
  // the original's label unchanged (unlike Split Node's "(split)" suffix) since the new
  // view is already named after it and conceptually still represents "this node, one
  // level of detail down" — not a sibling needing visual disambiguation.
  //
  // Data Modeling special case: decomposing a DataDataEntity should produce a
  // DataEntityDetails anchor (the type that actually carries an attribute list),
  // not another DataDataEntity — reported directly: "double click on datadataentity
  // or menu data Modeling -> add edit entity details creates a new datadataentity,
  // should be a dataentitydetail element for the details." Every OTHER element type
  // still copies the parent's own type exactly, as before.
  const childType = ciEq(part.type, 'DataDataEntity') ? 'DataEntityDetails' : part.type;
  const newPart = store.createPart({ type: childType, label: part.label, model: part.model, streams: [...(part.streams || [])], note: part.note, order: part.order, other: part.other });
  const selfVm = store.createViewMember({
    view: view.id, objectType: 'part', objectId: newPart.id,
    x: 200, y: 150, fillColor: vm.fillColor,
  });

  // Structural whole/part link, parent -> new child anchor, not placed on any view
  // (there's no view showing both levels at once). This is what lets Smart Check
  // View/Node recognize afterward that this decomposition already represents `part` —
  // so a connector added to `part` at the parent level later doesn't get treated as
  // "pull the whole parent process in again" down here, and a connector added to
  // newPart down here that reaches genuinely outside this decomposition gets mirrored
  // back up to `part`. See smartCheckView/smartCheckNode.
  store.createConnector({ from: part.id, to: newPart.id, model: part.model, connectorType: 'c', relationship: 'Composition' });

  // Crossing connectors: with a single node "selected", exactly-one-endpoint-selected
  // means any connector touching this node but not a self-loop on it. For each one,
  // create an isExternal copy of the OTHER-side neighbor in the new view (deduplicated
  // — multiple crossing edges to the same neighbor share one copy), positioned at a
  // fixed x (one node width right of the anchor if this node was the from side, so a
  // downstream "to" neighbor sits just past it rather than off in empty space; 20 if
  // the to side, i.e. an upstream "from" neighbor, which already reads fine close to
  // the left edge) stacked vertically, then create a NEW connector (same model/
  // connectorType/relationship/streams as the original, as a template — see Split
  // Node's identical pattern) between the external copy and newPart, since a
  // Connector's own from/to are part ids: reusing the ORIGINAL connector's identity
  // here would leave it pointing at the OLD part even though this view visually shows
  // it attached to the NEW one, a real from/to mismatch.
  const vmsInOldView = store.viewMembersForView(tab.viewId);
  const connVmsInOldView = vmsInOldView.filter((v) => v.objectType === 'connector');
  const crossingConnVms = connVmsInOldView.filter((cv) => (cv.fromVmId === vm.id) !== (cv.toVmId === vm.id));
  const { w: nodeW } = getNodeSize(view);

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
        x: movedEndIsFrom ? selfVm.x + nodeW : 20, y: 60 + offsetI * 90,
        fillColor: neighborVm.fillColor, isExternal: true,
      });
      neighborCopyByOldVmId.set(neighborVmId, copy);
    }
    const conn = store.findConnector(cv.objectId);
    if (conn) {
      // mirrorOf links this crossing connector back to the original it was copied
      // from, so Smart Check View/Node's composition-awareness (see
      // syncMirroredConnector in the Smart Check section below) can find this exact
      // pair again later: creating a new part-level connection at either level (Smart
      // Check's own "Missing connectors and nodes"/"Sync existing connectors with
      // inventory") or editing either connector's relationship/streams (the "update
      // the related inventory connector too?" prompt) can find its counterpart
      // through this link. Without it, the two connectors would be completely
      // unrelated objects as far as any of that is concerned. Reported directly:
      // "connector_p2 never changes... when will it change?"
      const newConn = store.createConnector({
        from: movedEndIsFrom ? newPart.id : neighborVm.objectId,
        to: movedEndIsFrom ? neighborVm.objectId : newPart.id,
        model: conn.model, connectorType: conn.connectorType, relationship: conn.relationship, streams: [...(conn.streams || [])],
        mirrorOf: conn.id,
      });
      store.createViewMember({
        view: view.id, objectType: 'connector', objectId: newConn.id,
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
/** Composition connector where `partId` is the "to" (composed/child) side, if any —
 * e.g. the one levelDownSingle creates from a parent part to its new decomposition
 * anchor. Shared by smartCheckView/smartCheckNode's composition-awareness below. */
function findCompositionParentConn(store, partId) {
  return store.doc.connectors.find((c) => ciEq(c.relationship, 'Composition') && ciEq(c.to, partId));
}

/** Composition connector where `partId` is the "from" (composing/parent) side, if
 * any -- the reverse of findCompositionParentConn above. Guards against creating a
 * SECOND decomposition of the same Part: `vm.linkedViewName` (openOrCreateLinkedView,
 * main.js) lives on the ViewMember, not the Part, so the same Part appearing as a
 * DIFFERENT ViewMember on another view has its own, independent linkedViewName --
 * double-clicking that other instance would otherwise create an entirely separate
 * child Part/view/Composition link for the SAME parent Part. */
function findCompositionChildConn(store, partId) {
  return store.doc.connectors.find((c) => ciEq(c.relationship, 'Composition') && ciEq(c.from, partId));
}

/** The View a Part's EXISTING Composition child (if any) is actually placed on --
 * resolves findCompositionChildConn's target part id to the one view it lives in, so
 * callers can reuse/switch to it instead of running Level Down again. */
function findCompositionChildView(store, partId) {
  const conn = findCompositionChildConn(store, partId);
  if (!conn) return null;
  const childVm = store.doc.viewMembers.find((v) => v.objectType === 'part' && ciEq(v.objectId, conn.to));
  return childVm ? store.findView(childVm.view) : null;
}

/**
 * Finds the existing counterpart of `conn` in a Composition-crossing connector pair,
 * regardless of which side the `mirrorOf` link happens to be recorded on — a pair can
 * be established from either direction's own code path (levelDownSingle's initial
 * crossing connectors, pullInCompositionParentConnections creating a child-side mirror
 * for a brand-new parent connection, or mirrorCompositionChildConnectorsUp creating a
 * parent-side mirror for a brand-new child connection), so lookup has to work both
 * ways to always find the SAME pair no matter which one is asking. */
function findCrossingCounterpart(store, conn) {
  return store.doc.connectors.find((c) => (c.mirrorOf && ciEq(c.mirrorOf, conn.id)) || (conn.mirrorOf && ciEq(conn.mirrorOf, c.id)));
}

/**
 * Finds-or-creates the mirror of `sourceConn` (see findCrossingCounterpart — lookup is
 * bidirectional, NOT by matching current from/to/connectorType, specifically so a
 * mirror can still be found after either side's own endpoint changes; a from/to lookup
 * would simply fail to find the old one and create a second, stale-orphan connector
 * instead).
 *
 * Only ENDPOINTS (sourceConn's own from/to, substituted onto the mirror) are kept in
 * sync automatically here — that's structural discovery (the parent's connection now
 * points somewhere new), the same territory as the rest of this composition-awareness
 * section. relationship/connectorType/streams are deliberately NOT auto-synced here
 * anymore: an earlier version tried "whichever side was edited more recently wins,"
 * but that's surprising (a Smart Check run can silently rewrite either side with no
 * warning) and depends on precise edit-recency tracking that's easy to get subtly
 * wrong. Keeping an existing pair's relationship/type/streams in sync is now always
 * EXPLICIT: either right at edit time (see App.promptSyncInventoryConnector, main.js —
 * "update the inventory connector too?") or via Smart Check's own opt-in "Sync existing
 * connectors with inventory" checkbox (syncViewConnectorsWithInventory below, one
 * direction only: inventory -> view). Reported directly: "if I add a dataentity and
 * connect it to the process, the new part does not show up in the lower level" [why
 * this function exists at all] and "connector_p2 never changes... when will it
 * change?" [why the answer is now "when you say so," not "silently, eventually"].
 *
 * Returns { mirror, isNew, changed } — changed is true if a pre-existing mirror's own
 * endpoint needed correcting. Deliberately never DELETES a mirror whose counterpart has
 * been removed entirely or rewired to no longer qualify (e.g. bottom-up: a connection
 * retargeted from an external part onto a sibling) — Smart Check stays
 * additive/corrective, not destructive, consistent with the rest of this file. */
function syncMirroredConnector(store, sourceConn, mirroredFrom, mirroredTo) {
  let mirror = findCrossingCounterpart(store, sourceConn);
  if (!mirror) {
    mirror = store.createConnector({ from: mirroredFrom, to: mirroredTo, model: sourceConn.model, connectorType: sourceConn.connectorType, relationship: sourceConn.relationship, streams: [...(sourceConn.streams || [])], mirrorOf: sourceConn.id });
    return { mirror, isNew: true, changed: true };
  }

  const changed = !ciEq(mirror.from, mirroredFrom) || !ciEq(mirror.to, mirroredTo);
  if (changed) {
    mirror.from = mirroredFrom;
    mirror.to = mirroredTo;
    store.touchConnector(mirror);
  }
  return { mirror, isNew: false, changed };
}

/**
 * Top-down half of Smart Check's composition-awareness. Called while a BFS is about to
 * treat `missingPart` as a brand-new node to pull onto the view, discovered via `conn`
 * which touches `presentPartId` (already on view). If something already on this view is
 * `missingPart`'s own Composition child, this view already represents `missingPart`'s
 * decomposition — pulling `missingPart` itself in as a plain new node would be a
 * redundant, wrong-level duplicate of the process/thing this view is already "inside"
 * (reported directly: "smart check view brings in the part process, which we don't
 * want as we're in that process"). In that case, redirect: ensure a connector from
 * presentPartId to that Composition child exists (mirroring conn's own
 * relationship/connectorType/streams, creating + placing it if needed, or resyncing it
 * if it already exists but has drifted) instead, and return the count of NEWLY PLACED
 * or UPDATED connector viewMembers so the caller can fold it into its own stats.
 * Returns null if `missingPart` has no Composition child already on this view — caller
 * proceeds with its normal pull-in.
 */
function redirectViaCompositionChild(store, view, conn, missingPart, partIdToVmId, placedConnectorIds, log, describePart) {
  let childPartId = null;
  for (const pid of partIdToVmId.keys()) {
    const pc = findCompositionParentConn(store, pid);
    if (pc && ciEq(pc.from, missingPart.id)) { childPartId = pid; break; }
  }
  if (!childPartId) return null;

  const mirroredFrom = conn.from === missingPart.id ? childPartId : conn.from;
  const mirroredTo = conn.to === missingPart.id ? childPartId : conn.to;
  // `conn` is itself the Composition connector that makes childPartId missingPart's
  // child (the on-view end IS childPartId, discovered via this very link) — the
  // substitution above collapses to a self-loop. Suppress the pull-in (still correct:
  // missingPart shouldn't be added) without fabricating a connector to nowhere.
  if (ciEq(mirroredFrom, mirroredTo)) return { added: 0, updated: 0 };

  return placeOrRepairMirror(store, view, conn, mirroredFrom, mirroredTo, partIdToVmId, placedConnectorIds, log, describePart,
    `${describePart(missingPart.id)} is already represented on this view by ${describePart(childPartId)}`);
}

/** Shared placement step for the top-down direction: sync `sourceConn`'s mirror (via
 * syncMirroredConnector), then ensure it's placed on `view` pointing at the CURRENT
 * mirroredFrom/mirroredTo viewMembers — repairing an existing placement's fromVmId/
 * toVmId if the source's other endpoint has moved since the mirror was placed. Returns
 * { added, updated }. */
function placeOrRepairMirror(store, view, sourceConn, mirroredFrom, mirroredTo, partIdToVmId, placedConnectorIds, log, describePart, contextMsg) {
  const SMART_CHECK_NOTE = 'Smart Check created.';
  const { mirror, isNew, changed } = syncMirroredConnector(store, sourceConn, mirroredFrom, mirroredTo);
  const targetFromVmId = partIdToVmId.get(mirroredFrom), targetToVmId = partIdToVmId.get(mirroredTo);
  let updated = 0;

  if (!placedConnectorIds.has(mirror.id)) {
    mirror.note = mirror.note ? `${mirror.note}\n${SMART_CHECK_NOTE} (composition-redirected.)` : `${SMART_CHECK_NOTE} (composition-redirected.)`;
    store.createViewMember({ view: view.id, objectType: 'connector', objectId: mirror.id, fromVmId: targetFromVmId, toVmId: targetToVmId });
    store.touchConnector(mirror);
    placedConnectorIds.add(mirror.id);
    log(`Composition redirect: ${contextMsg} — connected ${describePart(mirroredFrom)} -> ${describePart(mirroredTo)} (${mirror.relationship || mirror.connectorType}) instead of adding a duplicate node.`);
    return { added: 1, updated };
  }

  const placedVm = store.viewMembersForView(view.id).find((v) => v.objectType === 'connector' && v.objectId === mirror.id);
  const endpointDrifted = placedVm && (placedVm.fromVmId !== targetFromVmId || placedVm.toVmId !== targetToVmId);
  if (endpointDrifted) { placedVm.fromVmId = targetFromVmId; placedVm.toVmId = targetToVmId; }
  if (changed || endpointDrifted) {
    if (isNew === false) {
      mirror.note = mirror.note ? `${mirror.note}\n${SMART_CHECK_NOTE} (composition-resynced.)` : `${SMART_CHECK_NOTE} (composition-resynced.)`;
    }
    log(`Composition redirect: resynced the mirrored connector for ${contextMsg} to ${describePart(mirroredFrom)} -> ${describePart(mirroredTo)} (${mirror.relationship || mirror.connectorType}).`);
    updated += 1;
  }
  return { added: 0, updated };
}

/**
 * Bottom-up half of Smart Check's composition-awareness. For every part already on
 * this view that is itself a Composition child (composed under some higher-level
 * parent, e.g. a level-down anchor), mirrors any of ITS OWN connectors that reach
 * genuinely outside this decomposition as a doc-level connector on the PARENT too, so a
 * later Smart Check run on the parent's own view can surface it there. A connector to a
 * SIBLING — something else already composed under the very same parent — is purely
 * internal to this decomposition and is deliberately left alone (per the user's own
 * stated rule: only propagate connections to parts that don't share the same parent).
 * Doesn't place anything on any view (the parent view isn't the one being checked here)
 * — just ensures the connector object exists at the doc level and stays in sync
 * (relationship/connectorType/streams/endpoint) with whatever it mirrors. Returns
 * { added, updated }, kept separate from the view's own connectorsAdded since nothing
 * was added to THIS view.
 */
function mirrorCompositionChildConnectorsUp(store, onViewPartIds, log, describePart) {
  let added = 0, updated = 0;
  for (const childPartId of onViewPartIds) {
    const parentConn = findCompositionParentConn(store, childPartId);
    if (!parentConn) continue;
    const parentId = parentConn.from;
    for (const conn of [...store.doc.connectors]) {
      if (ciEq(conn.id, parentConn.id)) continue;
      if (ciEq(conn.relationship, 'Composition')) continue;
      if (conn.mirrorOf) continue; // don't re-mirror something that's already a mirror
      if (conn.from !== childPartId && conn.to !== childPartId) continue;
      const otherId = conn.from === childPartId ? conn.to : conn.from;
      if (ciEq(otherId, parentId)) continue; // points straight back at its own parent already
      const otherParentConn = findCompositionParentConn(store, otherId);
      if (otherParentConn && ciEq(otherParentConn.from, parentId)) continue; // sibling under the same parent — internal, no mirror needed
      const mirroredFrom = conn.from === childPartId ? parentId : conn.from;
      const mirroredTo = conn.to === childPartId ? parentId : conn.to;
      const { mirror, isNew, changed } = syncMirroredConnector(store, conn, mirroredFrom, mirroredTo);
      const NOTE = isNew ? 'Smart Check created (mirrored to parent via Composition link.)' : 'Smart Check updated (mirrored to parent via Composition link.)';
      if (isNew) {
        mirror.note = NOTE;
        added += 1;
        log(`Composition mirror: ${describePart(childPartId)}'s connection to ${describePart(otherId)} also mirrored up to its parent ${describePart(parentId)} (${mirror.relationship || mirror.connectorType}).`);
      } else if (changed) {
        mirror.note = mirror.note ? `${mirror.note}\n${NOTE}` : NOTE;
        updated += 1;
        log(`Composition mirror: resynced ${describePart(parentId)}'s mirrored connection to ${describePart(otherId)} (now ${mirror.relationship || mirror.connectorType}).`);
      }
    }
  }
  return { added, updated };
}

/**
 * Proactive top-down half of Smart Check's composition-awareness, run once per check
 * (not per BFS hop). redirectViaCompositionChild above only catches a parent's
 * connection when the classic BFS independently rediscovers it via some OTHER shared,
 * already-on-view neighbor (e.g. an external copy of 'in' still touching the original
 * parent-level connector) — a brand new connector added at the parent level AFTER
 * level-down, to a part with no other path onto this view, is otherwise completely
 * unreachable by connectivity walk, since the parent itself is deliberately never
 * placed here. This function closes that gap directly: for every part already on this
 * view that is a Composition child, it scans its PARENT's own connectors (not this
 * view's connectivity) and mirrors each one onto the child anchor instead — creating,
 * placing, or resyncing (relationship/connectorType/streams/endpoint) a connector to
 * the other end, pulling that other end in as an external node first if it isn't on
 * view yet and allowNodePull is set. Reported directly: "if I add a dataentity and
 * connect it to the process, the new part does not show up in the lower level as an
 * external part" — and later: "smart check does not update the connector type, end
 * points etc. if external->child connector is different than external->parent".
 */
function pullInCompositionParentConnections(store, view, partIdToVmId, placedConnectorIds, allowNodePull, log, describePart) {
  let connectorsAdded = 0, nodesAdded = 0, connectorsUpdated = 0;
  const typeToFill = new Map();
  for (const def of store.settings.elements || []) {
    const fill = (store.settings.elementGroups || []).find((g) => ciEq(g.group, def.group))?.fill;
    typeToFill.set(def.type, fill || '#cccccc');
  }
  let autoPlacedCount = 0;
  const compChildren = [...partIdToVmId.keys()].filter((pid) => !!findCompositionParentConn(store, pid));
  for (const childId of compChildren) {
    const parentConn = findCompositionParentConn(store, childId);
    const parentId = parentConn.from;
    const childVm = store.findViewMember(partIdToVmId.get(childId));
    for (const conn of [...store.doc.connectors]) {
      if (ciEq(conn.id, parentConn.id)) continue;
      if (conn.mirrorOf) continue; // don't re-mirror something that's already a mirror
      if (conn.from !== parentId && conn.to !== parentId) continue;
      const otherId = conn.from === parentId ? conn.to : conn.from;
      if (ciEq(otherId, childId)) continue;
      let otherOnView = partIdToVmId.has(otherId);
      if (!otherOnView) {
        if (!allowNodePull) continue;
        const otherPart = store.findPart(otherId);
        if (!otherPart) continue;
        autoPlacedCount += 1;
        const fillColor = typeToFill.get(otherPart.type) || '#cccccc';
        const newVm = store.createViewMember({
          view: view.id, objectType: 'part', objectId: otherPart.id,
          x: (childVm ? childVm.x : 60) + 200, y: (childVm ? childVm.y : 40) + (autoPlacedCount * 70),
          fillColor, isExternal: true,
        });
        partIdToVmId.set(otherId, newVm.id);
        otherOnView = true;
        nodesAdded += 1;
        log(`Added missing node: ${describePart(otherId)}, pulled in via its connection to ${describePart(parentId)} (composed here as ${describePart(childId)}).`);
      }
      const mirroredFrom = conn.from === parentId ? childId : conn.from;
      const mirroredTo = conn.to === parentId ? childId : conn.to;
      const result = placeOrRepairMirror(store, view, conn, mirroredFrom, mirroredTo, partIdToVmId, placedConnectorIds, log, describePart,
        `${describePart(parentId)}'s connection to ${describePart(otherId)}, mirrored onto its decomposition anchor ${describePart(childId)}`);
      connectorsAdded += result.added;
      connectorsUpdated += result.updated;
    }
  }
  return { connectorsAdded, nodesAdded, connectorsUpdated };
}

/**
 * "Sync existing connectors with inventory" — Smart Check View/Node's own opt-in
 * checkbox, unchecked by default. Deliberately NOT automatic (unlike the
 * discovery/placement functions above): for each connector already placed on this view
 * (View: every one; Node: only those touching the seed part), if it has a related
 * part-to-part "inventory" counterpart across a Composition boundary (see
 * findCrossingCounterpart — covers both Level Down's own original crossing connectors
 * and ones Smart Check itself created) whose relationship/connectorType/streams
 * differ, pulls those fields from the counterpart into THIS view's own connector.
 * One direction only — the inventory connector wins, since this is the explicit
 * "make my view match the model" action; the opposite direction (pushing a view edit
 * up to the inventory connector) is App.promptSyncInventoryConnector's job, prompted
 * right at edit time instead. Endpoints are never touched here — a view connector's
 * own from/to are its own placement's business, not something this checkbox second-
 * guesses. Reported directly: "changing the node to node connector type does not
 * change the related part to part connector type... let's change approach." Returns
 * the count synced.
 */
function syncViewConnectorsWithInventory(store, connIds, log, describePart) {
  let synced = 0;
  for (const connId of connIds) {
    const conn = store.findConnector(connId);
    if (!conn) continue;
    const counterpart = findCrossingCounterpart(store, conn);
    if (!counterpart) continue;
    const drifted = !ciEq(conn.relationship, counterpart.relationship) || !ciEq(conn.connectorType, counterpart.connectorType)
      || JSON.stringify(conn.streams || []) !== JSON.stringify(counterpart.streams || []);
    if (!drifted) continue;
    store.restyleConnector(conn, { from: conn.from, to: conn.to, model: conn.model, connectorType: counterpart.connectorType, relationship: counterpart.relationship, streams: [...(counterpart.streams || [])] });
    store.touchConnector(conn);
    synced += 1;
    log(`Synced with inventory: ${describePart(conn.from)} -> ${describePart(conn.to)} updated to match its inventory connector (now ${conn.relationship || conn.connectorType}).`);
  }
  return synced;
}

/**
 * Discovery half of "derived" connectors, shared between insertSmartStream's own
 * derived-connector trace (below, unchanged scope-wise) and Smart Check View's
 * "Derive hidden connections" checkbox: finds every pair of PRESENT parts (in
 * `presentPartIdSet`) linked only through a run of one or more NOT-present parts,
 * walking exactly one connectorType's own graph (call once per type) up to `levels`
 * hops (null = unlimited). Directional (follows `c.from -> c.to` only, matching the
 * underlying connectors' own direction), and doesn't filter by model — matching every
 * other Smart Check View helper above, none of which filter by model either (a
 * connector's endpoints already pin it to a model via their own `.model`). Returns a
 * Map "from|to" -> { from, to, relationship, viaTypes } — relationship is copied from
 * the FIRST real hop out of `from` (same "topmost parent" styling convention used
 * elsewhere), viaTypes lists which hidden element type(s) it passes through. A pair
 * already linked by a DIRECT connector of this same connectorType (placed on this view
 * or not — either way a real one already exists) is excluded.
 */
function findDerivedPairsForType(store, connectorType, presentPartIdSet, levels) {
  const connsByPart = new Map();
  for (const c of store.doc.connectors) {
    if (!ciEq(c.connectorType, connectorType)) continue;
    if (!connsByPart.has(c.from)) connsByPart.set(c.from, []);
    connsByPart.get(c.from).push(c);
  }
  const existingDirectPairs = new Set(
    store.doc.connectors
      .filter((c) => ciEq(c.connectorType, connectorType) && presentPartIdSet.has(c.from) && presentPartIdSet.has(c.to))
      .map((c) => `${c.from}|${c.to}`)
  );
  const derivedPairs = new Map();
  for (const survivorId of presentPartIdSet) {
    const visited = new Set([survivorId]);
    let frontier = [{ partId: survivorId, firstHopRelationship: null, viaTypes: [], hop: 0 }];
    while (frontier.length > 0) {
      const next = [];
      for (const { partId: cur, firstHopRelationship, viaTypes, hop } of frontier) {
        if (levels != null && hop >= levels) continue;
        for (const c of connsByPart.get(cur) || []) {
          if (visited.has(c.to)) continue;
          visited.add(c.to);
          const hopRelationship = firstHopRelationship ?? c.relationship;
          if (presentPartIdSet.has(c.to)) {
            if (c.to !== survivorId) {
              const key = `${survivorId}|${c.to}`;
              if (!existingDirectPairs.has(key) && !derivedPairs.has(key)) {
                derivedPairs.set(key, { from: survivorId, to: c.to, relationship: hopRelationship, viaTypes });
              }
            }
          } else {
            const viaPart = store.findPart(c.to);
            if (!viaPart) continue;
            const viaTitle = elementByType(store, viaPart.type)?.title || viaPart.type;
            next.push({ partId: c.to, firstHopRelationship: hopRelationship, viaTypes: [...viaTypes, viaTitle], hop: hop + 1 });
          }
        }
      }
      frontier = next;
    }
  }
  return derivedPairs;
}

/**
 * Creation half of "derived" connectors — reported directly: "when creating derived
 * connectors, create both 's' and 'c' versions." Materializes each pair from
 * findDerivedPairsForType (or insertSmartStream's own inline discovery, below) as BOTH
 * a 'c' Connector and an 's' Connector, regardless of which connectorType's graph the
 * pair was actually discovered through — a derived/implied relationship is a
 * structural fact worth showing under either lens. Model is taken from the pair's own
 * `from` part (matches the convention that a connector's model matches its
 * endpoints'). Skips whichever type(s) already exist for that exact from/to/model, so
 * this stays idempotent no matter how many times it runs (including once per
 * connectorType's own discovery pass, which can rediscover the same pair from the
 * other side). `log`/`describePart` are optional — smartCheckView's own Message Log
 * closures when called from there, omitted when called from insertSmartStream (which
 * has its own single summary toast instead). Returns the newly created connectors.
 *
 * The traced `relationship` (the FIRST real hop's own relationship name, e.g.
 * "Composition" from a 'c'-type chain or the literal "Stream" from an 's'-type one —
 * see findOrCreateStreamConnector's own convention) is used as-is for the 's' version,
 * matching how every genuine 's' connector already gets `relationship: 'Stream'`
 * (Duplicate Stream, populateFromTemplate, ...). Reported directly: "when a derived
 * connector is created, if a default relationship or valid relationship is not
 * available, use 'o' Association not the current 's' Stream for relationship for
 * connectors of type 'c'." The traced value can be flatly wrong for a 'c' connector
 * (a hidden chain discovered by walking 's' edges hands back the literal word
 * "Stream", which isn't a real 'c'-type relation at all) — so the 'c' version instead
 * keeps the traced relationship only if it's genuinely VALID for this specific
 * fromType->toType pair (isRelationValid, rules.js — same validity rules the property
 * panel's own relationship dropdown enforces), else falls back to that pair's own
 * data-defined default relation, else 'Association' (key 'o') — the exact same
 * "default, else Association" fallback createCompanionConnector already uses (above).
 */
function createDerivedConnectorPairs(store, derivedPairs, log, describePart) {
  const created = [];
  for (const { from, to, relationship, viaTypes } of derivedPairs.values()) {
    const fromPart = store.findPart(from);
    const modelName = fromPart?.model;
    if (!modelName) continue;
    const toPart = store.findPart(to);
    const viaText = [...new Set(viaTypes)].join(', ');
    const note = `Derived — implied via ${viaText} (not shown)`;
    for (const connectorType of ['c', 's']) {
      const exists = store.doc.connectors.some((c) => c.from === from && c.to === to && ciEq(c.connectorType, connectorType) && ciEq(c.model, modelName));
      if (exists) continue;
      let connRelationship = relationship;
      if (connectorType === 'c') {
        const relationKey = relationCodeFor(relationship, store.settings);
        if (!isRelationValid(store, fromPart?.type, toPart?.type, relationKey)) {
          const pair = findRelationshipPair(store, fromPart?.type, toPart?.type);
          const defaultRel = pair?.default ? (store.settings.relations || []).find((r) => r.key === pair.default) : null;
          connRelationship = defaultRel?.name || 'Association';
        }
      }
      const conn = store.createConnector({ from, to, model: modelName, connectorType, relationship: connRelationship, note });
      created.push(conn);
      if (log) log(`Derived connector: ${describePart(from)} -> ${describePart(to)} (${connectorType === 'c' ? 'Connector' : 'Stream'}), implied via ${viaText}.`);
    }
  }
  return created;
}

// ===================== SMART CHECK MODEL =====================
/**
 * Advanced menu > Smart Check Model: the whole-document counterpart to Smart Check
 * View/Node above — those two repair gaps within ONE view's own placed content; this
 * one scans the entire model (every part/connector, regardless of which views, if any,
 * show them) for three kinds of data-hygiene issue, matching the same preview-then-
 * confirm shape Data Modeling > Auto-Detect Connectors already established
 * (detectConnectorCandidates/createDetectedConnectors below) — pure detection here,
 * with no store mutation, so it's safe to call on every "Check" click; a separate
 * applySmartCheckModelFixes (below) only touches the store once a person has reviewed
 * and confirmed which specific rows to act on.
 *
 * - `disconnectedParts`: parts with NO connector of any type at all (not scoped to a
 *   view — a part could be off every view and still not count here if it has a real
 *   connector; conversely a part placed on a view could still be disconnected if it has
 *   no connector). Fix = delete from the model (and any viewMember placements, since
 *   Store.deletePart itself doesn't cascade — see main.js's own deleteSelection for the
 *   same non-cascading convention elsewhere).
 * - `disconnectedConnectors`: connectors whose `from` and/or `to` no longer resolves to
 *   a real part (store.findPart returns nothing) — a genuinely invalid/orphaned record,
 *   e.g. left behind by a part deleted through some path that didn't clean up its
 *   connectors. Fix = delete via store.deleteConnectorAndMembers, which already cascades
 *   to every viewMember showing it.
 * - `duplicateGroups`: 2+ parts sharing the exact same type + model + label — grouped
 *   by that triple, ordered by store.doc.parts' own array order (creation order), the
 *   FIRST part in each group is `keep`, the rest are `duplicateIds`. Fix = merge (see
 *   mergeDuplicateParts below) — reassigns every connector/viewMember pointing at a
 *   duplicate onto the kept part, then deletes the duplicates.
 *
 * `options`: `{ disconnectedParts, disconnectedConnectors, duplicateParts }` (all
 * booleans, default false) — only the requested categories are computed, so an
 * unchecked category's array is always empty rather than omitted (keeps the caller's
 * shape stable regardless of which checkboxes were on).
 */
function smartCheckModel(store, options = {}) {
  const result = { disconnectedParts: [], disconnectedConnectors: [], duplicateGroups: [] };

  if (options.disconnectedParts) {
    const connectedIds = new Set();
    for (const c of store.doc.connectors) {
      connectedIds.add(String(c.from ?? '').toLowerCase());
      connectedIds.add(String(c.to ?? '').toLowerCase());
    }
    result.disconnectedParts = store.doc.parts
      .filter((p) => !connectedIds.has(String(p.id).toLowerCase()))
      .map((p) => ({ id: p.id, label: p.label, type: p.type, model: p.model }));
  }

  if (options.disconnectedConnectors) {
    result.disconnectedConnectors = store.doc.connectors
      .filter((c) => !store.findPart(c.from) || !store.findPart(c.to))
      .map((c) => ({
        id: c.id,
        fromLabel: store.findPart(c.from)?.label ?? '(missing part)',
        toLabel: store.findPart(c.to)?.label ?? '(missing part)',
        relationship: c.relationship || c.connectorType,
      }));
  }

  if (options.duplicateParts) {
    const groups = new Map();
    for (const p of store.doc.parts) {
      const key = `${p.type}|${p.model}|${p.label}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const parts of groups.values()) {
      if (parts.length < 2) continue;
      const [keep, ...dups] = parts;
      result.duplicateGroups.push({
        keepId: keep.id, keepLabel: keep.label, type: keep.type, model: keep.model,
        duplicateIds: dups.map((p) => p.id), count: parts.length,
      });
    }
  }

  return result;
}

/** Merges `duplicatePartIds` into `keepPartId`, model-wide: reassigns every connector's
 * from/to, then every 'part' viewMember's objectId (de-duplicating per-view where the
 * kept part and a duplicate turn out to already share a view — keeps the earliest
 * viewMember there as the survivor, repointing any 'connector' viewMember's own
 * fromVmId/toVmId that referenced the one being removed), then de-duplicates any
 * connectors this reassignment made identical (same from+to+connectorType, via
 * deleteConnectorAndMembers so its own viewMembers go too, on every view at once), then
 * finally deletes the duplicate parts themselves. Same rewire/dedupe shape
 * mergePartsAndView (above) already uses for a view-selection-driven merge, but keyed
 * directly by part id instead, since Smart Check Model's duplicates were found
 * model-wide and may not be selected — or even placed — on any one view together. */
function mergeDuplicateParts(store, keepPartId, duplicatePartIds) {
  const keepPart = store.findPart(keepPartId);
  if (!keepPart) return;
  const dupIds = duplicatePartIds.filter((id) => id !== keepPartId);
  const dupIdSet = new Set(dupIds);
  if (dupIdSet.size === 0) return;

  for (const conn of store.doc.connectors) {
    if (dupIdSet.has(conn.from)) conn.from = keepPartId;
    if (dupIdSet.has(conn.to)) conn.to = keepPartId;
  }

  const affectedViewIds = new Set(
    store.doc.viewMembers
      .filter((vm) => vm.objectType === 'part' && (dupIdSet.has(vm.objectId) || vm.objectId === keepPartId))
      .map((vm) => vm.view)
  );
  for (const viewId of affectedViewIds) {
    const partVmsHere = store.doc.viewMembers.filter((vm) => vm.view === viewId && vm.objectType === 'part' && (dupIdSet.has(vm.objectId) || vm.objectId === keepPartId));
    if (partVmsHere.length === 0) continue;
    const [survivor, ...extras] = partVmsHere;
    survivor.objectId = keepPartId;
    for (const extra of extras) {
      for (const cvm of store.doc.viewMembers) {
        if (cvm.view !== viewId || cvm.objectType !== 'connector') continue;
        if (cvm.fromVmId === extra.id) cvm.fromVmId = survivor.id;
        if (cvm.toVmId === extra.id) cvm.toVmId = survivor.id;
      }
      store.deleteViewMember(extra.id);
    }
  }

  const seenKey = new Map();
  for (const conn of [...store.doc.connectors]) {
    const key = `${conn.from}|${conn.to}|${conn.connectorType}`;
    if (seenKey.has(key)) {
      store.deleteConnectorAndMembers(conn.id);
    } else {
      seenKey.set(key, conn.id);
    }
  }

  const mergedStreams = new Set(keepPart.streams || []);
  for (const id of dupIdSet) {
    const p = store.findPart(id);
    if (p) for (const s of (p.streams || [])) mergedStreams.add(s);
  }
  keepPart.streams = [...mergedStreams];
  keepPart.note = (keepPart.note || '') + (keepPart.note ? '\n' : '') + `Merged with duplicate part(s): ${[...dupIdSet].join(', ')}`;

  for (const id of dupIdSet) store.deletePart(id);
}

/** Applies a CONFIRMED subset of smartCheckModel's own findings (the caller has already
 * filtered this down to whatever a person checked in the preview list) — mirrors
 * createDetectedConnectors' own "detect now, apply later, only on what's confirmed"
 * split above. `fixes`: `{ deletePartIds: [...], deleteConnectorIds: [...],
 * mergeGroups: [{ keepId, duplicateIds }, ...] }` — any field may be omitted/empty.
 * Returns a summary `{ partsDeleted, connectorsDeleted, groupsMerged, partsMergedAway }`
 * for the caller's own toast.
 *
 * `deletePartIds` and `mergeGroups` are both computed from the SAME pre-fix snapshot
 * (smartCheckModel's own detection pass), so a part that's disconnected (no connectors
 * yet) AND also a member of a duplicate group — the keep part or one of the copies —
 * can legitimately appear in both lists at once (checked in both preview rows). Merge
 * always wins for that part: it's excluded from deletePartIds below rather than deleted
 * first, since deleting the keep part out from under its own merge would silently no-op
 * the merge (mergeDuplicateParts bails if the keep part is already gone), and deleting
 * a copy first would leave its connectors/streams never carried over to the survivor. */
function applySmartCheckModelFixes(app, fixes) {
  const { store } = app;
  let partsDeleted = 0, connectorsDeleted = 0, groupsMerged = 0, partsMergedAway = 0;

  const mergedPartIds = new Set();
  for (const group of fixes.mergeGroups || []) {
    mergedPartIds.add(group.keepId);
    for (const id of group.duplicateIds || []) mergedPartIds.add(id);
  }

  for (const partId of fixes.deletePartIds || []) {
    if (mergedPartIds.has(partId)) continue;
    if (!store.findPart(partId)) continue;
    store.doc.viewMembers = store.doc.viewMembers.filter((vm) => !(vm.objectType === 'part' && ciEq(vm.objectId, partId)));
    store.deletePart(partId);
    partsDeleted += 1;
  }

  for (const connId of fixes.deleteConnectorIds || []) {
    if (!store.findConnector(connId)) continue;
    store.deleteConnectorAndMembers(connId);
    connectorsDeleted += 1;
  }

  for (const group of fixes.mergeGroups || []) {
    if (!group.duplicateIds || group.duplicateIds.length === 0) continue;
    mergeDuplicateParts(store, group.keepId, group.duplicateIds);
    groupsMerged += 1;
    partsMergedAway += group.duplicateIds.length;
  }

  return { partsDeleted, connectorsDeleted, groupsMerged, partsMergedAway };
}

function smartCheckView(app, tab, options = {}) {
  const { missingConnectors = true, missingConnectorsAndNodes = false, levels = null, syncWithInventory = false, deriveConnectors = false } = options;
  const { store } = app;
  const viewId = tab.viewId;
  const view = store.findView(viewId);
  if (!view) return null;

  let connectorsAdded = 0, nodesAdded = 0, parentConnectorsAdded = 0, connectorsUpdated = 0;
  const log = (msg) => pushMessageLog(store, `[Smart Check View: ${view.viewName}] ${msg}`);
  const describePart = (id) => { const p = store.findPart(id); return p ? `"${p.label}" (${p.type})` : id; };
  const SMART_CHECK_NOTE = 'Smart Check created.';
  const appendNote = (obj, text) => { obj.note = obj.note ? `${obj.note}\n${text}` : text; };

  const vms = store.viewMembersForView(viewId);
  const partVms = vms.filter((vm) => vm.objectType === 'part');
  const connVms = vms.filter((vm) => vm.objectType === 'connector');
  const partIdToVmId = new Map(partVms.map((vm) => [vm.objectId, vm.id]));
  const placedConnectorIds = new Set(connVms.map((vm) => vm.objectId));

  if (missingConnectors || missingConnectorsAndNodes) {
    const pulled = pullInCompositionParentConnections(store, view, partIdToVmId, placedConnectorIds, missingConnectorsAndNodes, log, describePart);
    connectorsAdded += pulled.connectorsAdded;
    nodesAdded += pulled.nodesAdded;
    connectorsUpdated += pulled.connectorsUpdated;
  }

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
        const redirected = redirectViaCompositionChild(store, view, conn, missingPart, partIdToVmId, placedConnectorIds, log, describePart);
        if (redirected != null) { connectorsAdded += redirected.added; connectorsUpdated += redirected.updated; continue; }
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

  let parentConnectorsUpdated = 0;
  if (missingConnectors) {
    const mirroredUp = mirrorCompositionChildConnectorsUp(store, partIdToVmId.keys(), log, describePart);
    parentConnectorsAdded += mirroredUp.added;
    parentConnectorsUpdated += mirroredUp.updated;
  }

  // "Derive hidden connections" — direct follow-up to Insert Smart Stream's own
  // derived-connector concept: "Add creation of derived (same logic) to a new checkbox
  // in 'Smart Check View' command." Where insertSmartStream derives across parts it
  // just traced-and-filtered-out (showTypes), here "hidden" simply means "not placed
  // on this view" — for every pair of parts already on this view that are ONLY linked
  // through a run of one or more off-view parts, add a real Connector directly between
  // them (both a 'c' and an 's' version — createDerivedConnectorPairs, above),
  // documenting which type(s) it passes through. Walked separately per connectorType
  // (each type's own graph implies its own notion of "connected"), up to `levels` hops
  // — same field the missing-connectors-and-nodes checkbox above already uses, so the
  // dialog doesn't need a second hop-count input. Runs LAST, after every other
  // checkbox's own additions, so a node that missingConnectorsAndNodes just pulled in
  // this same run is no longer "hidden" and won't spuriously get bridged.
  let derivedConnectorsAdded = 0;
  if (deriveConnectors) {
    const presentPartIdSet = new Set(partIdToVmId.keys());
    for (const connectorType of ['c', 's']) {
      const pairs = findDerivedPairsForType(store, connectorType, presentPartIdSet, levels);
      const createdConns = createDerivedConnectorPairs(store, pairs, log, describePart);
      for (const conn of createdConns) {
        store.createViewMember({
          view: viewId, objectType: 'connector', objectId: conn.id,
          fromVmId: partIdToVmId.get(conn.from), toVmId: partIdToVmId.get(conn.to),
        });
        placedConnectorIds.add(conn.id);
        derivedConnectorsAdded += 1;
      }
    }
    connectorsAdded += derivedConnectorsAdded;
  }

  let inventorySynced = 0;
  if (syncWithInventory) {
    inventorySynced = syncViewConnectorsWithInventory(store, placedConnectorIds, log, describePart);
  }

  const totalUpdated = connectorsUpdated + parentConnectorsUpdated + inventorySynced;
  if (connectorsAdded === 0 && nodesAdded === 0 && parentConnectorsAdded === 0 && totalUpdated === 0) log('No missing connectors or nodes found.');
  else log(`Done: ${connectorsAdded} connector${connectorsAdded === 1 ? '' : 's'} added${derivedConnectorsAdded ? ` (${derivedConnectorsAdded} derived)` : ''}, ${nodesAdded} node${nodesAdded === 1 ? '' : 's'} added${parentConnectorsAdded ? `, ${parentConnectorsAdded} mirrored up to a parent view` : ''}${totalUpdated ? `, ${totalUpdated} resynced` : ''}.`);

  return { connectorsAdded, nodesAdded, parentConnectorsAdded, connectorsUpdated: totalUpdated, derivedConnectorsAdded };
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
 *
 * Also shares smartCheckView's Composition-awareness (pullInCompositionParentConnections
 * / redirectViaCompositionChild / mirrorCompositionChildConnectorsUp, above) unmodified,
 * including its choice to run unfiltered by direction/stream — it's syncing THIS
 * decomposition against its own parent, not walking outward from the seed.
 */
function smartCheckNode(app, tab, partId, options = {}) {
  const { missingConnectors = true, missingConnectorsAndNodes = false, levels = null, upstream = true, downstream = true, byStream = false, streams = [], syncWithInventory = false } = options;
  const { store } = app;
  const viewId = tab.viewId;
  const view = store.findView(viewId);
  if (!view) return null;
  const seedPart = store.findPart(partId);
  if (!seedPart) return null;

  let connectorsAdded = 0, nodesAdded = 0, parentConnectorsAdded = 0, connectorsUpdated = 0;
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

  // Composition-awareness runs unconditionally, not direction/stream-filtered like the
  // rest of this function — it's a structural sync (this part's own decomposition
  // staying consistent with its parent), not a "walk outward from the seed" step.
  if (missingConnectors || missingConnectorsAndNodes) {
    const pulled = pullInCompositionParentConnections(store, view, partIdToVmId, placedConnectorIds, missingConnectorsAndNodes, log, describePart);
    connectorsAdded += pulled.connectorsAdded;
    nodesAdded += pulled.nodesAdded;
    connectorsUpdated += pulled.connectorsUpdated;
  }

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
        const redirected = redirectViaCompositionChild(store, view, conn, missingPart, partIdToVmId, placedConnectorIds, log, describePart);
        if (redirected != null) { connectorsAdded += redirected.added; connectorsUpdated += redirected.updated; continue; }
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

  let parentConnectorsUpdated = 0;
  if (missingConnectors) {
    const mirroredUp = mirrorCompositionChildConnectorsUp(store, partIdToVmId.keys(), log, describePart);
    parentConnectorsAdded += mirroredUp.added;
    parentConnectorsUpdated += mirroredUp.updated;
  }

  let inventorySynced = 0;
  if (syncWithInventory) {
    // Scoped to THIS node's own connectors (not every placed connector on the view,
    // unlike Smart Check View's equivalent step) — matches Node's existing "on-view
    // membership looks at the whole view, but the operation itself is scoped to one
    // node" convention (see this function's own doc comment above).
    const ownConnIds = [...placedConnectorIds].filter((id) => { const c = store.findConnector(id); return c && (ciEq(c.from, partId) || ciEq(c.to, partId)); });
    inventorySynced = syncViewConnectorsWithInventory(store, ownConnIds, log, describePart);
  }

  const totalUpdated = connectorsUpdated + parentConnectorsUpdated + inventorySynced;
  if (connectorsAdded === 0 && nodesAdded === 0 && parentConnectorsAdded === 0 && totalUpdated === 0) log('No missing connectors or nodes found.');
  else log(`Done: ${connectorsAdded} connector${connectorsAdded === 1 ? '' : 's'} added, ${nodesAdded} node${nodesAdded === 1 ? '' : 's'} added${parentConnectorsAdded ? `, ${parentConnectorsAdded} mirrored up to a parent view` : ''}${totalUpdated ? `, ${totalUpdated} resynced` : ''}.`);

  return { connectorsAdded, nodesAdded, parentConnectorsAdded, connectorsUpdated: totalUpdated };
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
async function generateIndustry(app, onProgress, placeInView = true) {
  const { store } = app;
  const data = store.doc.industryTree;
  if (!data || !data.length) { app.toast('No industry data loaded — use File > Load SFCCE.', true); return; }
  // See store.doc.industryTemplateName's own comment (state.js) — 'SFCCE' by default
  // (the built-in dataset, and any Load SFCCE import, are both genuine 4-level trees).
  const templateName = store.doc.industryTemplateName || 'Enterprise';
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
        sectionId: func.nodeSectionId || '', sectionDescription: func.nodeSectionDescription || '',
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
  app.toast(`Generated ${entityCount} stream${entityCount === 1 ? '' : 's'} from the loaded industry data${skippedCount ? ` (${skippedCount} already existed, skipped)` : ''}${placementNote}.`, false, true);
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
function addExistingPartsToView(app, tab, partIds, includeConnectors, targetSectionInstanceId = '') {
  const { store } = app;
  const view = store.findView(tab.viewId);
  if (!view) return;
  const { w: nodeW, h: nodeH } = getNodeSize(view);
  const sectioned = isSectionViewType(view.viewType);
  const placer = sectioned ? createSectionPlacer(store, view) : null;
  // If the caller resolved a SPECIFIC section (right-clicked inside one, or it was
  // already selected) — see promptAddExisting, main.js — every part goes there
  // directly instead of createSectionPlacer's generic "first section anywhere in the
  // view whose elementTypes allows this type" rule, which had no way to know the user
  // was pointing at a particular section at all. Reported directly: "add existing
  // ignores mouse location or selected section, always adds to first section." Falls
  // back to the generic placer for any part whose type the target section doesn't
  // actually allow (shouldn't normally happen — the dialog's own list is pre-filtered
  // to valid types — but stays correct if it ever does).
  const targetLayoutEntry = (sectioned && targetSectionInstanceId) ? computeSectionLayout(view).find((entry) => entry.section.id === targetSectionInstanceId) : null;

  const vmByPartId = new Map();
  for (const vm of store.viewMembersForView(view.id)) {
    if (vm.objectType === 'part') vmByPartId.set(vm.objectId, vm);
  }

  let addedCount = 0;
  for (const partId of partIds) {
    const part = store.findPart(partId);
    if (!part || vmByPartId.has(partId)) continue;

    let x, y, sectionId = '';
    if (targetLayoutEntry && isTypeAllowedInSection(targetLayoutEntry.section, part.type)) {
      const free = findFreeCellOrGrowSection(store, view.id, targetLayoutEntry, 0, 0, null);
      x = free.x; y = free.y; sectionId = targetLayoutEntry.section.sectionId;
    } else if (placer) {
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
  app.toast(`Added ${addedCount} part${addedCount === 1 ? '' : 's'}${includeConnectors ? ` and ${connCount} connector${connCount === 1 ? '' : 's'}` : ''}.`, false, true);
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
  app.toast(`Populated from "${templateName}": ${addedCount} added, ${createdCount} created, ${skippedCount} skipped, ${connCount} connector${connCount === 1 ? '' : 's'}.`, false, true);
}

/** "Insert Smart Stream" (freeform views only) — traces a chain of EXISTING parts and
 * connectors starting from every part of `startType`, expanding hop-by-hop through
 * connectors of ONE chosen connectorType, in the chosen direction(s), for up to
 * `levels` hops (null = unlimited) — the same BFS-expansion shape smartCheckNode's own
 * missingConnectorsAndNodes already uses, just seeded by an element TYPE instead of one
 * specific part, and independent of what's already on the view rather than growing
 * outward from it. A part matching `endType` (if given) still gets collected, but
 * doesn't itself expand any further — the natural "stop at the destination" boundary
 * the dialog's "ending element" field describes; other branches that haven't reached it
 * yet keep expanding until they do (or the level budget runs out). The final
 * `showTypes` checklist then prunes the traced set down to just the types actually
 * wanted on screen; a connector only places if BOTH its ends survived that pruning
 * (same "both ends visible" convention used everywhere else in this app a connector's
 * display depends on its parts'). Reported directly: "Add ability in freeform view to
 * insert a smartStream... starting element... upstream/downstream or both... ending
 * element... children levels... selector checklist of element types to show... Use
 * connector line and line end settings of top most parents if possible" — satisfied
 * for free here since every placed connector is a REAL, pre-existing Connector with
 * its own real relationship; 2D rendering already looks up line/lineEnd style live
 * from that relationship (canvas.js), so nothing new needs synthesizing.
 * Placed left-to-right by hop distance from the nearest seed (column) then discovery
 * order within that hop (row) — a reasonable starting layout, not a substitute for
 * Remap if the result needs cleaning up afterward. Parts/connectors already on the
 * view keep their existing position/aren't duplicated. Uses createBulkLookupCache for
 * findNonOverlappingPosition's own view-scoped lookups (this can place hundreds of
 * nodes in one call — see CLAUDE.md's bulk-operation guidance) and a bespoke adjacency
 * index (built once, not part of that cache — it's shaped for stream GENERATION's
 * find-or-create needs, not traversal) for the hop-expansion itself. */
function insertSmartStream(app, tab, options) {
  const { connectorType, startPartIds, direction, endType, levels, showTypes } = options;
  const { store } = app;
  const view = store.findView(tab.viewId);
  if (!view) return;
  if (isSectionViewType(view.viewType)) {
    app.toast(`Insert Smart Stream only applies to freeform views — this view is section-based ("${view.viewType}").`, true);
    return;
  }

  const modelName = store.defaultModel;
  const seeds = (startPartIds || []).map((id) => store.findPart(id)).filter(Boolean);
  if (seeds.length === 0) {
    app.toast('No starting elements selected.', true);
    return;
  }

  const downstream = direction === 'downstream' || direction === 'both';
  const upstream = direction === 'upstream' || direction === 'both';

  // Adjacency index: partId -> connectors (of the chosen connectorType+model) touching
  // it — built once, so the hop-expansion loop below never rescans the whole
  // store.doc.connectors array per part (the naive-per-call-scan CLAUDE.md's bulk-
  // operation guidance warns about).
  const connsByPart = new Map();
  for (const c of store.doc.connectors) {
    if (!ciEq(c.connectorType, connectorType) || !ciEq(c.model, modelName)) continue;
    if (!connsByPart.has(c.from)) connsByPart.set(c.from, []);
    connsByPart.get(c.from).push(c);
    if (!connsByPart.has(c.to)) connsByPart.set(c.to, []);
    connsByPart.get(c.to).push(c);
  }

  const collectedPartIds = new Set(seeds.map((p) => p.id));
  const collectedConnIds = new Set();
  let frontier = new Set(seeds.map((p) => p.id));
  let hop = 0;
  while (frontier.size > 0 && (levels == null || hop < levels)) {
    const nextFrontier = new Set();
    for (const presentId of frontier) {
      for (const c of connsByPart.get(presentId) || []) {
        const otherId = c.from === presentId ? c.to : c.from;
        const edgeIsDownstream = c.from === presentId;
        if (!(edgeIsDownstream ? downstream : upstream)) continue;
        collectedConnIds.add(c.id);
        if (!collectedPartIds.has(otherId)) {
          collectedPartIds.add(otherId);
          nextFrontier.add(otherId);
        }
      }
    }
    // A part matching endType is still collected above, but doesn't propagate any
    // further — it's the chain's own natural destination, not a hard stop for
    // branches that haven't reached it yet.
    if (endType) {
      for (const id of [...nextFrontier]) {
        const part = store.findPart(id);
        if (part && ciEq(part.type, endType)) nextFrontier.delete(id);
      }
    }
    frontier = nextFrontier;
    hop += 1;
  }

  const finalPartIdSet = new Set(
    [...collectedPartIds].filter((id) => {
      const part = store.findPart(id);
      return part && showTypes.some((t) => ciEq(t, part.type));
    })
  );
  if (finalPartIdSet.size === 0) {
    app.toast('No parts matched — check the Element Types to Show checklist.', true);
    return;
  }
  const finalConnIds = [...collectedConnIds].filter((id) => {
    const conn = store.findConnector(id);
    return conn && finalPartIdSet.has(conn.from) && finalPartIdSet.has(conn.to);
  });

  // Derived connections: when a run of one or more excluded-type parts sits between
  // two surviving parts (e.g. Business Function -> [hidden Business Process] ->
  // Application Capability), create a genuine new Connector linking the surviving
  // endpoints directly, instead of just silently dropping the relationship. Persisted
  // as a real Connector (not a view-only decoration) so it reuses every bit of existing
  // rendering/export/inventory machinery — the note field documents which hidden
  // type(s) it passes through, and it's styled after the FIRST real hop's relationship
  // (the same "topmost parent" styling convention the rest of this command already
  // follows). Naturally idempotent on re-run: once created, it's a normal
  // directly-discoverable edge the next time connsByPart is built, so this loop finds
  // it already satisfied and skips it via existingPairs. Discovery here stays scoped
  // to THIS trace's own already-collected neighborhood (collectedPartIds) — unlike
  // Smart Check View's own "Derive hidden connections" checkbox (findDerivedPairsForType,
  // above), which has no such pre-collected neighborhood to bound it and uses `levels`
  // instead.
  const existingPairs = new Set(finalConnIds.map((id) => { const c = store.findConnector(id); return `${c.from}|${c.to}`; }));
  const derivedPairs = new Map(); // "from|to" -> { from, to, relationship, viaTypes: string[] }
  for (const survivorId of finalPartIdSet) {
    const visited = new Set([survivorId]);
    let frontier = [{ partId: survivorId, firstHopRelationship: null, viaTypes: [] }];
    while (frontier.length > 0) {
      const next = [];
      for (const { partId: cur, firstHopRelationship, viaTypes } of frontier) {
        for (const c of connsByPart.get(cur) || []) {
          if (c.from !== cur || !collectedPartIds.has(c.to) || visited.has(c.to)) continue;
          visited.add(c.to);
          const hopRelationship = firstHopRelationship ?? c.relationship;
          if (finalPartIdSet.has(c.to)) {
            if (c.to !== survivorId) {
              const key = `${survivorId}|${c.to}`;
              if (!existingPairs.has(key) && !derivedPairs.has(key)) {
                derivedPairs.set(key, { from: survivorId, to: c.to, relationship: hopRelationship, viaTypes });
              }
            }
          } else {
            const viaPart = store.findPart(c.to);
            const viaTitle = elementByType(store, viaPart.type)?.title || viaPart.type;
            next.push({ partId: c.to, firstHopRelationship: hopRelationship, viaTypes: [...viaTypes, viaTitle] });
          }
        }
      }
      frontier = next;
    }
  }
  // Reported directly: "when creating derived connectors, create both 's' and 'c'
  // versions" — createDerivedConnectorPairs (above, shared with Smart Check View)
  // always creates both; only the ONE matching this trace's own connectorType gets
  // placed as a viewMember on the view actually being built here (the other type still
  // exists in the model, just not shown on this particular connectorType-scoped view).
  const createdDerived = createDerivedConnectorPairs(store, derivedPairs);
  for (const conn of createdDerived) {
    if (!ciEq(conn.connectorType, connectorType)) continue;
    finalConnIds.push(conn.id);
    // Register in connsByPart too so the placement hop-distance BFS just below can
    // walk this brand-new edge like any other — it was built before this connector existed.
    if (!connsByPart.has(conn.from)) connsByPart.set(conn.from, []);
    connsByPart.get(conn.from).push(conn);
    if (!connsByPart.has(conn.to)) connsByPart.set(conn.to, []);
    connsByPart.get(conn.to).push(conn);
  }

  // Hop distance from the nearest seed, for left-to-right placement below — a simple
  // second BFS over the already-final (pruned) part set, since collectedPartIds' own
  // discovery order doesn't survive the showTypes filter above.
  const hopOf = new Map(seeds.filter((p) => finalPartIdSet.has(p.id)).map((p) => [p.id, 0]));
  let placeFrontier = new Set(hopOf.keys());
  let placeHop = 0;
  while (placeFrontier.size > 0) {
    placeHop += 1;
    const next = new Set();
    for (const presentId of placeFrontier) {
      for (const c of connsByPart.get(presentId) || []) {
        if (!finalConnIds.includes(c.id)) continue;
        const otherId = c.from === presentId ? c.to : c.from;
        if (finalPartIdSet.has(otherId) && !hopOf.has(otherId)) { hopOf.set(otherId, placeHop); next.add(otherId); }
      }
    }
    placeFrontier = next;
  }

  const lookupCache = createBulkLookupCache(store);
  const { w: nodeW, h: nodeH } = getNodeSize(view);
  const spacing = view.spacingScale || 1;
  const stepX = (nodeW + 60) * spacing, stepY = (nodeH + 30) * spacing;
  const existingPartVms = store.viewMembersForView(view.id).filter((vm) => vm.objectType === 'part');
  const baseX = existingPartVms.length ? Math.max(...existingPartVms.map((vm) => vm.x)) + stepX : 60;
  const baseY = 60;
  const rowByHop = new Map(); // hop level -> next free row index, for stacking siblings

  let addedParts = 0, addedConns = 0;
  for (const partId of finalPartIdSet) {
    if (lookupCache.vmsByPartView.has(`${partId}|${view.id}`)) continue; // already placed on this view
    const part = lookupCache.partsById.get(partId);
    if (!part) continue;
    const h = hopOf.get(partId) ?? 0;
    const row = rowByHop.get(h) || 0;
    rowByHop.set(h, row + 1);
    const desired = { x: baseX + h * stepX, y: baseY + row * stepY };
    const pos = store.findNonOverlappingPosition(view.id, desired.x, desired.y, undefined, nodeW, nodeH, spacing, lookupCache);
    const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: partId, x: pos.x, y: pos.y, fillColor: elementGroupFill(store, part.type) });
    cacheRegisterVm(lookupCache, vm);
    addedParts += 1;
  }

  for (const connId of finalConnIds) {
    if (lookupCache.connVmsByConnView.has(`${connId}|${view.id}`)) continue; // already placed on this view
    const conn = store.findConnector(connId);
    const fromVm = lookupCache.vmsByPartView.get(`${conn.from}|${view.id}`);
    const toVm = lookupCache.vmsByPartView.get(`${conn.to}|${view.id}`);
    if (!fromVm || !toVm) continue; // shouldn't happen — both ends were just placed or already there
    const connVm = store.createViewMember({ view: view.id, objectType: 'connector', objectId: connId, fromVmId: fromVm.id, toVmId: toVm.id });
    cacheRegisterConnVm(lookupCache, connVm);
    addedConns += 1;
  }

  if (addedParts === 0 && addedConns === 0) {
    app.toast('Smart Stream: everything traced was already on this view.');
    return;
  }
  redrawAndResolveLayout(app, { viewId: view.id, selection: new Set() });
  app.recordAndRender();
  const derivedSuffix = derivedPairs.size > 0 ? ` (${derivedPairs.size} derived)` : '';
  app.toast(`Inserted Smart Stream: ${addedParts} part${addedParts === 1 ? '' : 's'}, ${addedConns} connector${addedConns === 1 ? '' : 's'}${derivedSuffix}.`, false, true);
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
  app.toast(`Generated "${name}" with ${parts.length} parts, ${conns.length} connectors.`, false, true);
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

/** Builds a bidirectional vmId -> [neighbor vmIds] adjacency map from a view's
 * connector viewMembers — shared by minimizeRowCrossings, minimizeConnectorLengthPass,
 * and the Edge Assignment length-alignment pass in applyRemapLayout below, so the same
 * map-building logic isn't repeated three times. */
function buildNeighborMap(connVms) {
  const neighborsOf = new Map();
  for (const cv of connVms) {
    if (!neighborsOf.has(cv.fromVmId)) neighborsOf.set(cv.fromVmId, []);
    neighborsOf.get(cv.fromVmId).push(cv.toVmId);
    if (!neighborsOf.has(cv.toVmId)) neighborsOf.set(cv.toVmId, []);
    neighborsOf.get(cv.toVmId).push(cv.fromVmId);
  }
  return neighborsOf;
}

/** Given DESIRED (barycenter) target positions for an ORDERED sequence of items,
 * returns resolved positions that preserve that order with at least `step` between
 * consecutive items — a forward minimum-spacing sweep and a backward one, averaged (so
 * the sequence doesn't just drift toward whichever swept last), then one more forward
 * cleanup pass since averaging can reintroduce a tiny violation. Shared by
 * minimizeConnectorLengthPass (a grid row) and the Edge Assignment length-alignment
 * pass in applyRemapLayout below (a single edge band) — same 1D constraint problem
 * either way, just along a different axis. */
function resolveSpacedPositions(desired, step) {
  const forward = [...desired];
  for (let i = 1; i < forward.length; i++) forward[i] = Math.max(forward[i], forward[i - 1] + step);
  const backward = [...desired];
  for (let i = backward.length - 2; i >= 0; i--) backward[i] = Math.min(backward[i], backward[i + 1] - step);
  const resolved = forward.map((f, i) => (f + backward[i]) / 2);
  for (let i = 1; i < resolved.length; i++) resolved[i] = Math.max(resolved[i], resolved[i - 1] + step);
  return resolved;
}

/** Barycenter-heuristic edge-crossing reduction (Sugiyama-style layered graph
 * drawing), used by applyRemapLayout's 'default'/'none'/'layered' patterns when
 * options.minimizeCrossings is set. Reorders nodes WITHIN each already-assigned row —
 * their row/y position, hence which stream/element-group row they landed on, is left
 * completely untouched — by repeatedly sorting each row by the average column position
 * of its neighbors in the row above (a downward pass) or below (an upward pass),
 * alternating a few times to let the ordering converge. A standard, bounded
 * approximation to the NP-hard general crossing-minimization problem, not an exact
 * solver.
 *
 * Barycenter averaging alone reliably found via real-data testing: it can converge to
 * an order that's close but not locally optimal, and gets stuck there — reported
 * directly: a row with one high-fan-out node (connects to BOTH halves of the row
 * below) next to two low-fan-out siblings (each connects to only one half) settled
 * with the high-fan-out node at an END of the row instead of centered between its two
 * targets, even with Minimize Crossings on, because simple positional averaging
 * doesn't force it there — swapping it one position over would strictly reduce
 * crossings, but averaging-then-sort never considers that specific swap in isolation.
 * `transposeRow` below is the standard second half of this algorithm (Gansner et al.,
 * "A Technique for Drawing Directed Graphs", 1993 — the same two-phase structure
 * Graphviz's `dot` uses): after barycenter converges, repeatedly scan each row for an
 * ADJACENT pair whose swap would strictly reduce crossings against the row(s)
 * immediately above/below, and perform it, until a full sweep finds no more
 * improvements. Swapping two strictly adjacent items never changes either one's
 * left/right relation to any THIRD item in the row, so the crossing-count delta from a
 * candidate swap depends only on that pair's own edges — cheap to evaluate directly
 * (no need to recompute the whole row's crossing count) and, unlike barycenter
 * averaging, it only ever acts on a swap already proven to help, so it can't undo
 * barycenter's progress or oscillate.
 *
 * Transpose alone, run once after barycenter fully converges, still wasn't enough on
 * further real-data testing: two ADJACENT rows can each look locally fine against the
 * OTHER row's current (not-yet-ideal) order, while the pair jointly sits in a
 * non-global optimum neither row's own local swap-check can see its way out of —
 * exactly dot's own documented rationale for interleaving the two phases repeatedly
 * rather than running each once. Each iteration below now does a full barycenter
 * sweep AND a full transpose sweep together, and the actual total crossing count
 * (summed over every adjacent row pair, real pairwise edge-crossing count — not a
 * proxy) is checked after every iteration; the best-scoring full layout seen across
 * ALL iterations is what's kept at the end, not just whatever the last iteration
 * happened to land on, since neither phase is monotonic once more than two rows are
 * involved (an iteration can genuinely score worse than an earlier one before a later
 * one recovers).
 *
 * rowGroups: array of vm[] arrays, outer array already in top-to-bottom row order,
 * each inner array in some starting left-to-right column order — mutated in place, and
 * vm.x is rewritten to match the final column order. */
function minimizeRowCrossings(rowGroups, connVms, stepX, baseX, iterations = 8) {
  if (rowGroups.length < 2) return;
  const neighborsOf = buildNeighborMap(connVms);
  const rowMembership = rowGroups.map((row) => new Set(row.map((vm) => vm.id)));
  const rowIndexOf = new Map();
  rowGroups.forEach((row, i) => row.forEach((vm) => rowIndexOf.set(vm.id, i)));
  const intraRowConns = connVms.filter((cv) => cv.fromVmId !== cv.toVmId && rowIndexOf.get(cv.fromVmId) === rowIndexOf.get(cv.toVmId));
  const targetsIn = (colOf, vmId, neighborRowIds) =>
    (neighborsOf.get(vmId) || []).filter((nid) => neighborRowIds.has(nid)).map((nid) => colOf.get(nid));

  // A swap's LENGTH delta (positive = swapping a/b shortens their own edges): for
  // every edge of a or b (inter-row via aboveIds/belowIds, OR same-row via this row's
  // own membership, excluding a's edge to b itself -- their mutual distance is 1
  // either way), compare |old position - target| to |new position - target|.
  const lengthDeltaOf = (colOf, a, b, idx, aboveIds, belowIds, ownRowIds) => {
    let delta = 0;
    for (const neighborRowIds of [aboveIds, belowIds]) {
      if (!neighborRowIds) continue;
      for (const p of targetsIn(colOf, a.id, neighborRowIds)) delta += Math.abs(idx - p) - Math.abs(idx + 1 - p);
      for (const p of targetsIn(colOf, b.id, neighborRowIds)) delta += Math.abs(idx + 1 - p) - Math.abs(idx - p);
    }
    for (const p of targetsIn(colOf, a.id, ownRowIds)) { if (p !== idx && p !== idx + 1) delta += Math.abs(idx - p) - Math.abs(idx + 1 - p); }
    for (const p of targetsIn(colOf, b.id, ownRowIds)) { if (p !== idx && p !== idx + 1) delta += Math.abs(idx + 1 - p) - Math.abs(idx - p); }
    return delta;
  };

  const transposeAll = (rows, colOf) => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const aboveIds = i > 0 ? rowMembership[i - 1] : null;
      const belowIds = i < rows.length - 1 ? rowMembership[i + 1] : null;
      const ownRowIds = rowMembership[i];
      let improved = true, guard = 0;
      while (improved && guard < row.length * 4) {
        improved = false;
        guard += 1;
        for (let idx = 0; idx < row.length - 1; idx++) {
          const a = row[idx], b = row[idx + 1];
          let crossDelta = 0; // positive = swapping a/b strictly reduces crossings
          for (const neighborRowIds of [aboveIds, belowIds]) {
            if (!neighborRowIds) continue;
            const ta = targetsIn(colOf, a.id, neighborRowIds), tb = targetsIn(colOf, b.id, neighborRowIds);
            for (const pa of ta) for (const pb of tb) {
              if (pa > pb) crossDelta += 1; // currently crossing (a left of b, but a's target right of b's) -- swap removes it
              else if (pa < pb) crossDelta -= 1; // currently non-crossing -- swap would introduce it
            }
          }
          // Swap on a strict crossing improvement, same as before -- but ALSO on a
          // crossing-NEUTRAL swap that strictly shortens a/b's own edges (inter-row OR
          // same-row). Without this second case, two orderings that tie on crossings
          // (0 crossings either way) but differ in length can never be locally
          // improved upon: the transpose only ever accepted a strict crossing
          // reduction, so a same-row-connected pair could stay needlessly stretched
          // apart even though moving them adjacent is free (crossing-wise) and
          // strictly shorter -- reported directly, this is exactly what left Business
          // Capability/Business Process "grouped" instead of interleaved.
          const shouldSwap = crossDelta > 0 || (crossDelta === 0 && lengthDeltaOf(colOf, a, b, idx, aboveIds, belowIds, ownRowIds) > 0);
          if (shouldSwap) {
            row[idx] = b; row[idx + 1] = a;
            colOf.set(a.id, idx + 1); colOf.set(b.id, idx);
            improved = true;
          }
        }
      }
    }
  };

  // Real total crossing count (every adjacent row pair, every pair of edges between
  // them), PLUS total column-distance (a straightness proxy, INTER-row AND intra-row
  // both) as a tie-break -- used only to pick the best iteration, not as a per-swap
  // heuristic (that's transposeAll's cheaper local delta above). Multiple orderings
  // can tie on raw crossing count (0 crossings is 0 crossings, however the nodes are
  // otherwise arranged) — reported directly: a high-fan-out node (connects to BOTH
  // halves of the row below) ending up at one END of its row instead of centered
  // between its own two targets, even though BOTH arrangements are equally
  // crossing-free. Straightness/length is what actually distinguishes them (centering
  // the node makes its own two edges shorter and more symmetric), so it's the natural
  // tie-break — the same principle minimizeConnectorLengthPass already applies, just
  // used here to choose BETWEEN equally-valid orderings instead of refining
  // coordinates within a fixed one. Intra-row length (both ends of an edge in the SAME
  // row — routine for the 'layered' pattern, whose whole point is putting two directly
  // connected types on one row when they're equidistant from a root) matters just as
  // much as inter-row length: an ordering that shortens every inter-row edge to zero by
  // grouping same-type nodes together can still be the WRONG choice if it makes those
  // same nodes' real same-row connector stretch across unrelated nodes in between —
  // found via real-data testing, where scoring inter-row length alone picked exactly
  // that "grouped" ordering over the shorter-OVERALL "interleaved" one.
  const scoreOf = (rows, colOf) => {
    let crossings = 0, length = 0;
    for (let i = 0; i < rows.length - 1; i++) {
      const topIds = rowMembership[i], botIds = rowMembership[i + 1];
      const pairs = [];
      for (const cv of connVms) {
        if (topIds.has(cv.fromVmId) && botIds.has(cv.toVmId)) pairs.push([colOf.get(cv.fromVmId), colOf.get(cv.toVmId)]);
        else if (topIds.has(cv.toVmId) && botIds.has(cv.fromVmId)) pairs.push([colOf.get(cv.toVmId), colOf.get(cv.fromVmId)]);
      }
      for (const [t, b] of pairs) length += Math.abs(t - b);
      for (let a = 0; a < pairs.length; a++) {
        for (let b = a + 1; b < pairs.length; b++) {
          const [t1, b1] = pairs[a], [t2, b2] = pairs[b];
          if ((t1 - t2) * (b1 - b2) < 0) crossings += 1;
        }
      }
    }
    for (const cv of intraRowConns) length += Math.abs(colOf.get(cv.fromVmId) - colOf.get(cv.toVmId));
    return { crossings, length };
  };
  const isBetter = (a, b) => a.crossings < b.crossings || (a.crossings === b.crossings && a.length < b.length);

  // Runs the full barycenter+transpose search from a given starting row order,
  // alternating sweep direction each pass -- `startDownward` picks which direction
  // goes FIRST, since that decides which row gets pulled toward its neighbor before
  // the reverse pass pulls back, changing which local optimum the search converges to
  // (barycenter+transpose is not guaranteed to find the global optimum, only to
  // improve on its starting point). Returns the best-scoring {rows, score} seen
  // across every iteration of this particular run, not just its last one.
  const runSearch = (initialRows, startDownward) => {
    const rows = initialRows.map((row) => row.slice());
    const colOf = new Map();
    rows.forEach((row) => row.forEach((vm, idx) => colOf.set(vm.id, idx)));
    let best = rows.map((row) => row.slice());
    let bestScore = scoreOf(rows, colOf);
    for (let pass = 0; pass < iterations; pass++) {
      const downward = startDownward ? pass % 2 === 0 : pass % 2 === 1;
      const rowOrder = downward ? rows.map((_, i) => i) : rows.map((_, i) => i).reverse();
      for (const i of rowOrder) {
        const neighborRowIdx = downward ? i - 1 : i + 1;
        if (neighborRowIdx < 0 || neighborRowIdx >= rows.length) continue;
        const neighborRowIds = rowMembership[neighborRowIdx];
        const barycenterOf = (vm) => {
          const cols = targetsIn(colOf, vm.id, neighborRowIds);
          return cols.length ? cols.reduce((s, c) => s + c, 0) / cols.length : colOf.get(vm.id);
        };
        rows[i] = rows[i]
          .map((vm) => ({ vm, b: barycenterOf(vm) }))
          .sort((a, b) => a.b - b.b)
          .map((e) => e.vm);
        rows[i].forEach((vm, idx) => colOf.set(vm.id, idx));
      }
      transposeAll(rows, colOf);
      const score = scoreOf(rows, colOf);
      if (isBetter(score, bestScore)) {
        bestScore = score;
        best = rows.map((row) => row.slice());
      }
    }
    return { rows: best, score: bestScore };
  };

  // Two starts (downward-first and upward-first) from the SAME given initial order --
  // a cheap, deterministic diversification, not a random restart. Real-data testing
  // found this genuinely necessary: with one specific real sort-key order, the
  // downward-first search always converged to a different, equally crossing-free but
  // longer/less-straight arrangement (a high-fan-out node left at one end of its row
  // instead of centered between its own two targets) -- more iterations of the SAME
  // starting direction never escaped it, since transpose only ever accepts a strictly
  // crossing-reducing swap, and this specific improvement was length-only, not
  // crossing-only. Starting upward instead changes which row gets pulled toward its
  // neighbor first, reaching the better arrangement directly.
  let result = runSearch(rowGroups, true);
  const upResult = runSearch(rowGroups, false);
  if (isBetter(upResult.score, result.score)) result = upResult;

  for (let i = 0; i < rowGroups.length; i++) rowGroups[i] = result.rows[i];
  rowGroups.forEach((row) => row.forEach((vm, idx) => { vm.x = baseX + idx * stepX; }));
}

/** Continuous horizontal-position refinement — the classic Sugiyama "coordinate
 * assignment" phase, complementing minimizeRowCrossings' "ordering" phase above (runs
 * after it, if both are enabled, so it refines coordinates within whatever column
 * order crossing minimization already settled on). Used by applyRemapLayout's
 * 'default'/'none' patterns when options.minimizeConnectorLength is set. Each row's
 * nodes stay on their already-assigned row (y untouched) and keep their existing
 * left-to-right ORDER — only x shifts, toward the average x of each node's connected
 * neighbors (any row, not just the one above/below), so connected chains straighten
 * and pull closer together instead of sitting at fixed, evenly-spaced grid slots; a
 * node with no neighbors, or whose neighbors are already directly above/below it,
 * doesn't move. Each pass resolves a row's desired (barycenter) positions two ways —
 * a left-to-right sweep enforcing a minimum stepX gap, and a right-to-left sweep doing
 * the same in reverse — then averages the two so the row doesn't just drift in
 * whichever sweep direction ran last; a final left-to-right cleanup pass guarantees no
 * overlap even after averaging. A bounded, iterative heuristic (not an exact solver),
 * same spirit as minimizeRowCrossings. rowGroups: array of vm[] arrays already in
 * top-to-bottom row order, each inner array in the LEFT-TO-RIGHT order to preserve —
 * mutated in place, vm.x rewritten to the final compacted position. */
function minimizeConnectorLengthPass(rowGroups, connVms, stepX, baseX, iterations = 4) {
  if (rowGroups.length === 0) return;
  const neighborsOf = buildNeighborMap(connVms);
  const xOf = new Map();
  rowGroups.forEach((row) => row.forEach((vm, idx) => xOf.set(vm.id, baseX + idx * stepX)));

  const resolveRow = (row) => {
    const desired = row.map((vm) => {
      const xs = (neighborsOf.get(vm.id) || []).map((nid) => xOf.get(nid)).filter((x) => x !== undefined);
      return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : xOf.get(vm.id);
    });
    const resolved = resolveSpacedPositions(desired, stepX);
    row.forEach((vm, i) => xOf.set(vm.id, resolved[i]));
  };

  for (let pass = 0; pass < iterations; pass++) {
    const order = pass % 2 === 0 ? rowGroups : [...rowGroups].reverse();
    order.forEach((row) => resolveRow(row));
  }

  // Normalize so the leftmost node sits at baseX — repeated barycenter passes can
  // otherwise drift the whole block rightward (or leftward) with nothing to anchor it.
  const allX = [...xOf.values()];
  if (allX.length) {
    const shift = baseX - Math.min(...allX);
    rowGroups.forEach((row) => row.forEach((vm) => { vm.x = xOf.get(vm.id) + shift; }));
  }
}

/** Computes a hierarchical "layer" (row) for every node from directed graph structure
 * alone — the layer-assignment phase of Sugiyama-style layered graph drawing, used by
 * applyRemapLayout's 'layered' pattern. Column position within a layer, and any
 * crossing/length optimization, are left entirely to the SAME existing machinery every
 * other pattern already shares (minimizeRowCrossings/minimizeConnectorLengthPass) —
 * this only decides which row a node belongs on.
 *
 * Multi-source BFS, shortest-hop-distance-from-any-root — NOT longest-path/topological
 * layering. A node's layer is the FEWEST hops from any root (a node with no incoming
 * edges) that a real edge justifies, computed by expanding every root's frontier one
 * hop at a time and recording each node's layer the first (shortest) time it's reached.
 * This was deliberately chosen over longest-path layering after testing against a real
 * report: given Function -> Process directly (1 hop) AND Function -> [Actor ->]
 * Capability -> Process (a longer indirect route through a sibling type), longest-path
 * layering would push Process one row below Capability (obeying the longer chain as a
 * hard constraint), splitting two types the user wanted on the SAME row. Shortest-path
 * layering instead lets Process sit at the row its nearest real dependency (Function)
 * justifies, landing it alongside Capability — matching the requested layout without
 * hardcoding either type's row.
 * Also naturally robust to DyCAD's dual-connector convention (relationshipPairs.default
 * creates BOTH directions between certain adjacent stream elements, a genuine 2-node
 * cycle): once a node is reached at its shortest distance, BFS never revisits it, so a
 * later, longer edge back into it is simply a no-op — no separate cycle-breaking pass
 * (feedback-arc-set removal, DFS ordering, etc.) is needed at all. */
function computeLayerAssignment(vms, connVms) {
  const idSet = new Set(vms.map((vm) => vm.id));
  const outAdj = new Map(), inDegree = new Map();
  for (const vm of vms) { outAdj.set(vm.id, []); inDegree.set(vm.id, 0); }
  for (const cv of connVms) {
    if (!idSet.has(cv.fromVmId) || !idSet.has(cv.toVmId) || cv.fromVmId === cv.toVmId) continue;
    outAdj.get(cv.fromVmId).push(cv.toVmId);
    inDegree.set(cv.toVmId, inDegree.get(cv.toVmId) + 1);
  }

  const layer = new Map();
  let frontier = vms.filter((vm) => inDegree.get(vm.id) === 0).map((vm) => vm.id);
  for (const id of frontier) layer.set(id, 0);
  let depth = 0;
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const to of outAdj.get(id)) {
        if (!layer.has(to)) { layer.set(to, depth + 1); next.push(to); }
      }
    }
    frontier = next;
    depth += 1;
  }
  // A node no root can reach at all (every inbound edge comes from within an isolated
  // cycle with no outside entry point) never enters the BFS above — same defensive
  // fallback as before, just for a different edge case.
  for (const vm of vms) if (!layer.has(vm.id)) layer.set(vm.id, 0);
  return layer;
}

/** Reported directly: "remap selected places nodes over top existing. Can the
 * results be placed starting in selected x,y?" Whenever a remap is restricted to a
 * subset (visiblePartVmIds set — via "Only remap filtered nodes" or "Only remap
 * selected nodes and their connectors"), every pattern below computes fresh positions
 * from the view's own fixed origin (baseX/rowBaseY for default/none/layered,
 * marginX/marginY for force/clusters) — appropriate for a WHOLE-view remap, but for a
 * restricted subset that just lands the result on top of wherever OTHER, un-remapped
 * nodes already sit near that same origin. Mutates `vms` in place, translating the
 * whole group by ONE uniform offset (never per-node — that would distort the
 * relative layout the pattern just computed) so its own new top-left corner lands
 * exactly where the group's OWN top-left corner was before this remap ran, instead
 * of at the view's default origin. No-op if nothing moved (shiftX/shiftY both 0). */
function shiftToOriginalPosition(vms, originalPositions) {
  if (!originalPositions || vms.length === 0) return;
  const oldMinX = Math.min(...vms.map((vm) => originalPositions.get(vm.id)?.x ?? vm.x));
  const oldMinY = Math.min(...vms.map((vm) => originalPositions.get(vm.id)?.y ?? vm.y));
  const newMinX = Math.min(...vms.map((vm) => vm.x));
  const newMinY = Math.min(...vms.map((vm) => vm.y));
  const shiftX = oldMinX - newMinX, shiftY = oldMinY - newMinY;
  if (!shiftX && !shiftY) return;
  for (const vm of vms) { vm.x += shiftX; vm.y += shiftY; }
}

function applyRemapLayout(app, viewId, options = {}) {
  const { sortKeys, templateName, pattern = 'default', limitColumnsToView = false, visiblePartVmIds = null, forcePreferRight = false, forceGroupRows = false, edgeAssignment = null, minimizeCrossings = false, minimizeConnectorLength = false } = options;
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
  // Snapshot BEFORE any pattern below mutates x/y — see shiftToOriginalPosition's own
  // doc comment. Only taken when this remap is actually restricted to a subset (a
  // whole-view remap keeps its existing "start at the view's own fixed origin"
  // behavior, unchanged).
  const originalPartPositions = visiblePartVmIds ? new Map(partVms.map((vm) => [vm.id, { x: vm.x, y: vm.y }])) : null;

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
    shiftToOriginalPosition(partVms, originalPartPositions);
    return { view, template, maxCols: partVms.length };
  }

  if (pattern === 'clusters') {
    // "Centralize in Clusters", reported directly: "need a better remap for erd that
    // puts popular nodes central to single children around them, repeat this pattern
    // in clusters." Like 'force' above, driven entirely by connectivity (no sort keys,
    // column wrapping, or Edge Assignment) — but where 'force' centers the single
    // highest-degree node of each whole connected COMPONENT, this decomposes each
    // component into several hub-and-leaves stars (layout.js's
    // computeHubClusterDecomposition) and tiles those stars together instead, since a
    // real ERD schema is often one giant connected component end to end.
    const spacingClusters = view.spacingScale || 1;
    const nodesForLayout = partVms.map((vm) => ({ id: vm.id, x: vm.x, y: vm.y, w: nodeW, h: nodeH }));
    const vmIdSet = new Set(partVms.map((vm) => vm.id));
    const edgesForLayout = [];
    for (const cv of connVms) {
      if (!vmIdSet.has(cv.fromVmId) || !vmIdSet.has(cv.toVmId)) continue; // connector touches a node excluded by the current filter
      edgesForLayout.push({ from: cv.fromVmId, to: cv.toVmId });
    }
    const stepXClusters = (nodeW + 40) * spacingClusters, stepYClusters = (nodeH + 44) * spacingClusters;
    const positions = computeHubClusterGridLayout(nodesForLayout, edgesForLayout, {
      stepX: stepXClusters, stepY: stepYClusters,
      preferRightPlacement: forcePreferRight, // reuses 'force''s own option: place a ring member to the right of its hub when free, instead of the default direction
    });
    for (const vm of partVms) {
      const p = positions.get(vm.id);
      if (p) { vm.x = p.x; vm.y = p.y; }
    }
    shiftToOriginalPosition(partVms, originalPartPositions);
    return { view, template, maxCols: partVms.length };
  }

  // Edge Assignment (default/none patterns only — force/clusters above already
  // returned, and
  // section-based views returned even earlier via applyRemapLayoutSectioned): a part
  // whose TYPE has an entry in edgeAssignment is pulled OUT of the normal stream/
  // element-group grid entirely and placed instead in a single row/column band along
  // that edge of the layout (see the post-processing below), ordered by the same
  // sort-priority keys as everything else. Everything else (no entry, or edgeAssignment
  // not passed at all) goes through the existing grid logic completely unchanged.
  const edgeBuckets = { top: [], bottom: [], left: [], right: [] };
  let middlePartVms = partVms;
  if (edgeAssignment) {
    middlePartVms = [];
    for (const vm of partVms) {
      const part = store.findPart(vm.objectId);
      const dir = part && edgeAssignment[part.type];
      if (dir && edgeBuckets[dir]) edgeBuckets[dir].push(vm);
      else middlePartVms.push(vm);
    }
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
  for (const vm of middlePartVms) {
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

  let resultMaxCols;
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
    resultMaxCols = Number.isFinite(maxCols) ? maxCols : allSorted.length;
  } else if (pattern === 'layered') {
    // Hierarchical layering by graph structure (BFS/longest-path depth from whatever
    // has no incoming edges — see computeLayerAssignment above), NOT element-group or
    // stream membership: a genuinely different row-assignment rule than 'default'/
    // 'none', for cases where the architectural layer you want (e.g. a Business
    // Function above its own Processes, above their own Application Capabilities,
    // above their own Data Entities) actually follows the connector graph rather than
    // custom.json's elementGroup — which often puts a Function and its Processes in
    // the SAME group, merging them into one row under 'default'. No column-wrapping
    // (maxCols/"Limit columns to view" doesn't apply here — the dialog hides it for
    // this pattern) and no passive-row special-casing (that convention is specific to
    // 'default's stream/group semantics); every part in the middle set, passive or
    // not, is placed purely by its own layer.
    const layeredVms = [...remainingVms, ...passiveVms];
    const layeredIdSet = new Set(layeredVms.map((vm) => vm.id));
    const layerEdges = connVms.filter((cv) => layeredIdSet.has(cv.fromVmId) && layeredIdSet.has(cv.toVmId));
    const layerOf = computeLayerAssignment(layeredVms, layerEdges);
    const byLayer = new Map();
    for (const vm of layeredVms) {
      const l = layerOf.get(vm.id) ?? 0;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l).push(vm);
    }
    let maxColsSeen = 0;
    for (const l of [...byLayer.keys()].sort((a, b) => a - b)) {
      const rowVms = byLayer.get(l).sort((a, b) => {
        const partA = store.findPart(a.objectId), partB = store.findPart(b.objectId);
        for (const key of keys) {
          const va = remapSortValue(store, template, partA, key, connectionOrderMap, viewRelevantStreams);
          const vb = remapSortValue(store, template, partB, key, connectionOrderMap, viewRelevantStreams);
          if (va < vb) return -1;
          if (va > vb) return 1;
        }
        return 0;
      });
      rowVms.forEach((vm, col) => { vm.x = baseX + col * stepX; vm.y = rowBaseY + l * stepY; });
      maxColsSeen = Math.max(maxColsSeen, rowVms.length);
    }
    resultMaxCols = maxColsSeen;
  } else {
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

  resultMaxCols = Number.isFinite(maxCols) ? maxCols : (rowLastCol.size ? Math.max(...rowLastCol.values()) + 1 : 0);
  }

  const allMiddleVms = [...remainingVms, ...passiveVms];

  // Crossing minimization and connector-length minimization (both opt-in, both only
  // ever touch middle-grid rows/columns, never the edge bands below): the classic
  // Sugiyama two-phase pipeline — minimizeRowCrossings settles column ORDER first,
  // then minimizeConnectorLength refines exact x POSITIONS within whatever order is
  // now in place (crossing-minimized if that ran, otherwise the existing sort-key
  // order). Share the same row grouping between both so the second phase sees the
  // first's actual result rather than rebuilding from scratch.
  if ((minimizeCrossings || minimizeConnectorLength) && allMiddleVms.length > 0) {
    const rowsMap = new Map();
    for (const vm of allMiddleVms) {
      if (!rowsMap.has(vm.y)) rowsMap.set(vm.y, []);
      rowsMap.get(vm.y).push(vm);
    }
    const rowGroups = [...rowsMap.entries()].sort((a, b) => a[0] - b[0]).map(([, vms]) => vms.sort((a, b) => a.x - b.x));
    if (minimizeCrossings) minimizeRowCrossings(rowGroups, connVms, stepX, baseX);
    if (minimizeConnectorLength) minimizeConnectorLengthPass(rowGroups, connVms, stepX, baseX);
  }

  // Edge Assignment placement: shift the middle grid over to make room for a left/top
  // band (if either has any members), then lay each band out as a single row/column
  // along its own edge of the whole layout — ordered by the same sort-priority keys as
  // everything else by default (reusing remapSortValue so "ordered by connector
  // order/natural flow" works here too), UNLESS minimizeCrossings is also on, in which
  // case each band's order is instead a barycenter reordering against the middle
  // grid's own final positions (see orderBand below) — the sortKeys order becomes just
  // the tie-break for members with no middle-grid connection to align to.
  const hasTop = edgeBuckets.top.length > 0, hasBottom = edgeBuckets.bottom.length > 0;
  const hasLeft = edgeBuckets.left.length > 0, hasRight = edgeBuckets.right.length > 0;
  if (hasTop || hasBottom || hasLeft || hasRight) {
    const shiftX = hasLeft ? stepX : 0, shiftY = hasTop ? stepY : 0;
    if (shiftX || shiftY) {
      for (const vm of allMiddleVms) { vm.x += shiftX; vm.y += shiftY; }
    }
    const xs = allMiddleVms.map((vm) => vm.x), ys = allMiddleVms.map((vm) => vm.y);
    const middleMinX = xs.length ? Math.min(...xs) : baseX + shiftX;
    const middleMaxX = xs.length ? Math.max(...xs) : baseX + shiftX;
    const middleMinY = ys.length ? Math.min(...ys) : rowBaseY + shiftY;
    const middleMaxY = ys.length ? Math.max(...ys) : rowBaseY + shiftY;

    const orderByKeys = (vms) => [...vms].sort((a, b) => {
      const partA = store.findPart(a.objectId), partB = store.findPart(b.objectId);
      for (const key of keys) {
        const va = remapSortValue(store, template, partA, key, connectionOrderMap, viewRelevantStreams);
        const vb = remapSortValue(store, template, partB, key, connectionOrderMap, viewRelevantStreams);
        if (va < vb) return -1;
        if (va > vb) return 1;
      }
      return 0;
    });

    const bandNeighborsOf = buildNeighborMap(connVms);
    const middlePosOf = new Map();
    for (const vm of allMiddleVms) middlePosOf.set(vm.id, { x: vm.x, y: vm.y });

    // Barycenter reordering against the (already-final) middle grid — same idea as
    // minimizeRowCrossings, but a band isn't a "row with neighbor rows above/below": its
    // one and only neighbor to align against is the middle grid itself. A member with
    // no middle-grid connection at all (only connects to other band members, or
    // nothing) has no preference, so it falls back to (and ties break by) the plain
    // sortKeys order — never reordered relative to other such members.
    const orderBand = (vms, axis) => {
      const baseOrder = orderByKeys(vms);
      if (!minimizeCrossings || baseOrder.length === 0) return baseOrder;
      const indexOf = new Map(baseOrder.map((vm, i) => [vm.id, i]));
      const barycenterOf = (vm) => {
        const vals = (bandNeighborsOf.get(vm.id) || []).map((nid) => middlePosOf.get(nid)?.[axis]).filter((v) => v !== undefined);
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      };
      return baseOrder
        .map((vm) => ({ vm, b: barycenterOf(vm) }))
        .sort((a, b) => {
          if (a.b === null && b.b === null) return indexOf.get(a.vm.id) - indexOf.get(b.vm.id);
          if (a.b === null) return 1;
          if (b.b === null) return -1;
          return a.b - b.b;
        })
        .map((e) => e.vm);
    };

    const orderedTop = orderBand(edgeBuckets.top, 'x');
    const orderedBottom = orderBand(edgeBuckets.bottom, 'x');
    const orderedLeft = orderBand(edgeBuckets.left, 'y');
    const orderedRight = orderBand(edgeBuckets.right, 'y');

    orderedTop.forEach((vm, i) => { vm.x = middleMinX + i * stepX; vm.y = rowBaseY; });
    orderedBottom.forEach((vm, i) => { vm.x = middleMinX + i * stepX; vm.y = middleMaxY + stepY; });
    orderedLeft.forEach((vm, i) => { vm.x = baseX; vm.y = middleMinY + i * stepY; });
    orderedRight.forEach((vm, i) => { vm.x = middleMaxX + stepX; vm.y = middleMinY + i * stepY; });

    // Minimize Connector Length also aligns each band's CROSS axis (x for top/bottom,
    // y for left/right) toward whatever its members are actually connected to — the
    // placement above only fixes each band's ORDER at evenly-spaced slots; without
    // this, a part pinned to an edge never benefits from length minimization at all,
    // even though the middle grid it's connected to just did. Same
    // resolveSpacedPositions machinery as minimizeConnectorLengthPass, applied to one
    // band (a single "row") at a time — keeps the band's own order (whichever ordering
    // above produced) and minimum spacing, reads neighbor positions from the middle
    // grid's now-FINAL coordinates (and whichever other bands were already aligned this
    // call), never the reverse, so the middle grid itself is never perturbed by where a
    // band ends up.
    if (minimizeConnectorLength) {
      const posOf = new Map(middlePosOf);
      const alignBand = (bandVmsOrdered, axis, step) => {
        if (bandVmsOrdered.length === 0) return;
        const desired = bandVmsOrdered.map((vm) => {
          const vals = (bandNeighborsOf.get(vm.id) || []).map((nid) => posOf.get(nid)?.[axis]).filter((v) => v !== undefined);
          return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : vm[axis];
        });
        const resolved = resolveSpacedPositions(desired, step);
        bandVmsOrdered.forEach((vm, i) => { vm[axis] = resolved[i]; posOf.set(vm.id, { x: vm.x, y: vm.y }); });
      };
      alignBand(orderedTop, 'x', stepX);
      alignBand(orderedBottom, 'x', stepX);
      alignBand(orderedLeft, 'y', stepY);
      alignBand(orderedRight, 'y', stepY);
    }
  }

  shiftToOriginalPosition(partVms, originalPartPositions);
  return { view, template, maxCols: resultMaxCols };
}

function remap(app, tab, options = {}) {
  const result = applyRemapLayout(app, tab.viewId, options);
  if (!result) { app.toast('No stream templates available to remap against.', true); return; }
  if (options.sortKeys && options.sortKeys.length) result.view.remapSortKeys = options.sortKeys;
  // Remembers every OTHER dialog field too (sortKeys stays in its own remapSortKeys
  // field above, unchanged) so reopening Remap on THIS SPECIFIC view starts from what
  // was last used here, not just the cross-view defaults (getCachedRemapOptions,
  // main.js) — same "this view's own history wins" precedent remapSortKeys already
  // set. Only recorded on success (mirrors remapSortKeys, set after the same guard).
  result.view.remapLastOptions = {
    templateName: options.templateName || result.template.name,
    pattern: options.pattern || 'default',
    limitColumnsToView: !!options.limitColumnsToView,
    filteredOnly: !!options.filteredOnly,
    selectedOnly: !!options.selectedOnly,
    forcePreferRight: !!options.forcePreferRight,
    forceGroupRows: !!options.forceGroupRows,
    edgeAssignment: options.edgeAssignment || {},
    minimizeCrossings: !!options.minimizeCrossings,
    minimizeConnectorLength: !!options.minimizeConnectorLength,
  };
  app.recordAndRender();
  const detail = options.pattern === 'force' ? 'force-directed placement' : `${result.maxCols} columns`;
  app.toast(`Remapped "${result.view.viewName}" using template "${result.template.name}" (${detail}).`, false, true);
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
  app.toast(`Merged ${vms.length} parts into "${newName}" across all views.`, false, true);
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
  app.toast(`Merged ${vms.length} nodes into "${newName}" in this view.`, false, true);
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
  app.toast(`Duplicated section "${originalName}" as "${newSection.name}" (${oldVmToNewVm.size} node${oldVmToNewVm.size === 1 ? '' : 's'}, ${connDupCount} connector${connDupCount === 1 ? '' : 's'}).`, false, true);
}

// ===================== DATA MODELING: DDL IMPORT/EXPORT =====================
/** Data Modeling > Import DDL...: parses DDL text (ddl.js's parseDDL — a deliberately
 * scoped CREATE TABLE subset, not a general SQL grammar) and creates one
 * 'DataEntityDetails' Part per table (attributes built directly from the parsed
 * columns, each getting a real id so 'd' connectors can reference them), placed in a
 * simple grid on a new freeform view, with a 'd' connector for every FOREIGN KEY
 * (fromCardinality 'many'/toCardinality 'one' by default — the ordinary FK-references-
 * PK shape; a person can change either end afterward via the property panel).
 * Deliberately does NOT create a parent DataDataEntity/Composition link for each
 * table — that's what "Add/Edit Entity Details" (below) is for, decomposing an
 * EXISTING business-level Data Entity that was already part of a Stream/Capability Map;
 * a bulk DDL import is introducing brand-new schema structure with no such parent to
 * attach to, so it stays a plain, freestanding set of DataEntityDetails tables. Throws
 * (propagated to the caller, e.g. the menu's own try/catch) if parseDDL itself throws —
 * nothing partial gets created. */
function importDDL(app, ddlText) {
  const { store } = app;
  const { tables, foreignKeys } = parseDDL(ddlText);
  const model = store.defaultModel;

  let viewName = 'DDL Import', n = 1;
  while (store.findView(viewName)) { viewName = `DDL Import ${n}`; n += 1; }
  const view = store.addView(viewName, 'ff');
  const tab = app.createCanvasTab(view);
  app.switchToTab(tab.id);

  const { w: nodeW, h: nodeH } = getNodeSize(view);
  const stepX = nodeW + 80, stepY = nodeH + 60;
  const perRow = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
  const lookupCache = createBulkLookupCache(store);
  const partByTableName = new Map();

  tables.forEach((table, i) => {
    const part = store.createPart({
      type: 'DataEntityDetails', label: table.name, model, streams: [],
      attributes: table.columns.map((c) => ({ id: newId(), name: c.name, dataType: c.dataType, nullable: c.nullable, isPrimaryKey: c.isPrimaryKey })),
    });
    cacheRegisterPart(lookupCache, part);
    partByTableName.set(table.name.toLowerCase(), part);
    const col = i % perRow, row = Math.floor(i / perRow);
    const vm = store.createViewMember({ view: view.id, objectType: 'part', objectId: part.id, x: 60 + col * stepX, y: 60 + row * stepY, fillColor: elementGroupFill(store, 'DataEntityDetails') });
    cacheRegisterVm(lookupCache, vm);
  });

  let fkCount = 0, fkSkipped = 0;
  for (const fk of foreignKeys) {
    const fromPart = partByTableName.get(fk.fromTable.toLowerCase());
    const toPart = partByTableName.get(fk.toTable.toLowerCase());
    const fromAttr = fromPart?.attributes.find((a) => ciEq(a.name, fk.fromColumn));
    const toAttr = toPart?.attributes.find((a) => ciEq(a.name, fk.toColumn));
    if (!fromPart || !toPart || !fromAttr || !toAttr) { fkSkipped += 1; continue; } // REFERENCES a table/column parseDDL didn't find a definition for -- skipped, not fabricated
    const conn = store.createConnector({
      from: fromPart.id, to: toPart.id, model, connectorType: 'd', relationship: 'Association',
      fromAttribute: fromAttr.id, toAttribute: toAttr.id, fromCardinality: 'many', toCardinality: 'one',
    });
    const fromVm = lookupCache.vmsByPartView.get(`${fromPart.id}|${view.id}`);
    const toVm = lookupCache.vmsByPartView.get(`${toPart.id}|${view.id}`);
    store.createViewMember({ view: view.id, objectType: 'connector', objectId: conn.id, fromVmId: fromVm.id, toVmId: toVm.id });
    fkCount += 1;
  }

  redrawAndResolveLayout(app, { viewId: view.id, selection: new Set() });
  app.recordAndRender();
  const skippedSuffix = fkSkipped > 0 ? ` (${fkSkipped} FOREIGN KEY reference${fkSkipped === 1 ? '' : 's'} skipped — table/column not found)` : '';
  app.toast(`Imported ${tables.length} table${tables.length === 1 ? '' : 's'}, ${fkCount} foreign key${fkCount === 1 ? '' : 's'}${skippedSuffix} onto "${viewName}".`, false, true);
}

/** Data Modeling > Export DDL: the reverse of importDDL, scoped to whatever
 * 'DataEntityDetails' parts + 'd' connectors are actually PLACED on the given view
 * (matching Insert Smart Stream's own "acts on one view" scoping) -- not the whole
 * model, so exporting reflects exactly the diagram a person is looking at. Returns the
 * generated DDL text directly (the caller decides how to show it — the Data Modeling
 * menu uses the existing promptTextEdit readonly-viewer, same one Code Summary uses).
 * Throws if there are no DataEntityDetails parts on the view at all, since generating
 * an empty DDL file silently isn't useful — matches parseDDL's own "no CREATE TABLE
 * statements found" complaint, for a consistent error experience on both sides. */
function exportDDL(app, viewId) {
  const { store } = app;
  const vms = store.viewMembersForView(viewId);
  const partVmIds = new Set(vms.filter((v) => v.objectType === 'part').map((v) => v.objectId));
  const parts = [...partVmIds].map((id) => store.findPart(id)).filter((p) => p && ciEq(p.type, 'DataEntityDetails'));
  if (parts.length === 0) throw new Error('This view has no Data Entity Details tables to export.');
  const partIdSet = new Set(parts.map((p) => p.id));
  const conns = store.doc.connectors.filter((c) => c.connectorType === 'd' && partIdSet.has(c.from) && partIdSet.has(c.to));
  return generateDDL(parts, conns);
}

/** Case/punctuation-insensitive identifier normalization ("Customer Id", "customer_id",
 * "CustomerID" all collapse to "customerid") — used only by the field-name heuristic
 * below, where a person's own naming convention shouldn't defeat an otherwise-obvious
 * match. */
function normalizeIdent(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Data Modeling > Auto-Detect Connectors: finds candidate 'd' connectors across every
 * 'DataEntityDetails' part in the WHOLE document (not scoped to one view — the tables
 * involved may not even be placed together on any view yet), combining two independent
 * detection mechanisms into one merged, de-duplicated list for the caller to preview
 * and let a person confirm before anything is actually created:
 *
 *   Part A (explicit): if ddlText is given, ddl.js's parseDDL — the exact same
 *   FOREIGN KEY ... REFERENCES parsing importDDL itself uses when creating brand-new
 *   tables — is matched here against EXISTING DataEntityDetails tables/attributes
 *   already in the document, by name. A reference to a table/column that isn't found
 *   among existing tables is simply not proposed (skipped, not fabricated — same
 *   principle as importDDL's own fkSkipped count).
 *
 *   Part B (heuristic): every (primary-key attribute, non-primary-key attribute) pair
 *   across two DIFFERENT tables whose names match — either exactly (case/punctuation-
 *   insensitive) or the non-PK name matches the PK table's own label concatenated with
 *   the PK's own name (the common "<Table>Id" convention, e.g. Customer's PK "Id"
 *   matching Order's "CustomerId") — is a candidate "this is probably a foreign key"
 *   match. This is a heuristic guess, not a certainty — false positives (an unrelated
 *   "Id"-named column, a coincidental name collision) are expected and are exactly what
 *   the caller's confirm step is for.
 *
 * Both mechanisms use the same fromAttribute/toAttribute convention importDDL itself
 * produces (fromAttribute = the FK/child/"many" side, toAttribute = the referenced/PK
 * /"one" side, fromCardinality:'many'/toCardinality:'one') so a confirmed candidate is
 * indistinguishable from one DDL import would have created directly. A pair already
 * linked by an existing 'd' connector between those exact two attributes (in either
 * direction) is never proposed again, and a pair matched by both mechanisms is only
 * listed once (Part A's match wins, since it's the explicit, non-heuristic one).
 * Pure logic, no DOM, no store mutation — safe to call on every keystroke/click of a
 * "Detect" button. */
function detectConnectorCandidates(store, ddlText) {
  const tables = store.doc.parts.filter((p) => ciEq(p.type, 'DataEntityDetails'));

  const existingPairs = new Set();
  for (const c of store.doc.connectors) {
    if (!ciEq(c.connectorType, 'd') || !c.fromAttribute || !c.toAttribute) continue;
    existingPairs.add(`${c.fromAttribute}|${c.toAttribute}`);
    existingPairs.add(`${c.toAttribute}|${c.fromAttribute}`);
  }

  const candidates = [];
  const proposedPairs = new Set();
  const addCandidate = (fromPart, fromAttr, toPart, toAttr, source) => {
    const key = `${fromAttr.id}|${toAttr.id}`;
    if (existingPairs.has(key) || proposedPairs.has(key) || proposedPairs.has(`${toAttr.id}|${fromAttr.id}`)) return;
    proposedPairs.add(key);
    candidates.push({
      fromPartId: fromPart.id, fromAttributeId: fromAttr.id, fromTableLabel: fromPart.label, fromAttrName: fromAttr.name,
      toPartId: toPart.id, toAttributeId: toAttr.id, toTableLabel: toPart.label, toAttrName: toAttr.name,
      fromCardinality: 'many', toCardinality: 'one', source,
    });
  };

  if (ddlText && ddlText.trim()) {
    const { foreignKeys } = parseDDL(ddlText); // throws on unparseable text -- propagated to the caller
    const byName = new Map(tables.map((t) => [t.label.toLowerCase(), t]));
    for (const fk of foreignKeys) {
      const fromPart = byName.get(fk.fromTable.toLowerCase());
      const toPart = byName.get(fk.toTable.toLowerCase());
      const fromAttr = fromPart?.attributes?.find((a) => ciEq(a.name, fk.fromColumn));
      const toAttr = toPart?.attributes?.find((a) => ciEq(a.name, fk.toColumn));
      if (!fromPart || !toPart || !fromAttr || !toAttr) continue; // not found among existing tables -- skipped, not fabricated
      addCandidate(fromPart, fromAttr, toPart, toAttr, 'DDL REFERENCES');
    }
  }

  for (const pkTable of tables) {
    for (const pkAttr of pkTable.attributes || []) {
      if (!pkAttr.isPrimaryKey) continue;
      const exactTarget = normalizeIdent(pkAttr.name);
      const prefixedTarget = normalizeIdent(`${pkTable.label}${pkAttr.name}`);
      for (const otherTable of tables) {
        if (otherTable.id === pkTable.id) continue;
        for (const candAttr of otherTable.attributes || []) {
          if (candAttr.isPrimaryKey) continue;
          const n = normalizeIdent(candAttr.name);
          if (n === exactTarget || n === prefixedTarget) addCandidate(otherTable, candAttr, pkTable, pkAttr, 'Name match');
        }
      }
    }
  }

  candidates.sort((a, b) =>
    (a.source === b.source ? 0 : a.source === 'DDL REFERENCES' ? -1 : 1) ||
    a.fromTableLabel.localeCompare(b.fromTableLabel) || a.fromAttrName.localeCompare(b.fromAttrName));
  return candidates;
}

/** Creates a real 'd' connector for each CONFIRMED candidate (detectConnectorCandidates'
 * own shape — the caller has already filtered this down to whatever a person checked in
 * the preview list) and places a connector viewMember in every view where both endpoint
 * parts already have a part viewMember — the same "both endpoints already on this view"
 * placement rule smartCheckView's own missingConnectors uses (js/commands.js above),
 * just applied across every view in the document at once since detection itself isn't
 * scoped to one view. A pair with no shared view yet still gets its connector created at
 * the document level (mirrors Level Up/Down's own "unplaced Composition connector"
 * precedent, DESIGN_DOCUMENT.md §7a) — it becomes visible once both tables are eventually
 * placed together on some view, including automatically the next time Smart Check View
 * runs there. Returns { created, placements, unplaced } — `placements` is the total
 * count of connector viewMembers created (a pair sharing MORE than one view gets more
 * than one placement per connector, so this can exceed `created`); `unplaced` is the
 * number of newly-created connectors that got zero placements anywhere. */
function createDetectedConnectors(app, candidates) {
  const { store } = app;
  const vmsByPart = new Map(); // partId -> Map<viewId, vmId>
  for (const vm of store.doc.viewMembers) {
    if (vm.objectType !== 'part') continue;
    if (!vmsByPart.has(vm.objectId)) vmsByPart.set(vm.objectId, new Map());
    vmsByPart.get(vm.objectId).set(vm.view, vm.id);
  }

  let created = 0, placements = 0, unplaced = 0;
  for (const cand of candidates) {
    const conn = store.createConnector({
      from: cand.fromPartId, to: cand.toPartId, model: store.defaultModel, connectorType: 'd', relationship: 'Association',
      fromAttribute: cand.fromAttributeId, toAttribute: cand.toAttributeId,
      fromCardinality: cand.fromCardinality, toCardinality: cand.toCardinality,
    });
    created += 1;
    const fromViews = vmsByPart.get(cand.fromPartId) || new Map();
    const toViews = vmsByPart.get(cand.toPartId) || new Map();
    let placedSomewhere = false;
    for (const [viewId, fromVmId] of fromViews) {
      const toVmId = toViews.get(viewId);
      if (!toVmId) continue;
      store.createViewMember({ view: viewId, objectType: 'connector', objectId: conn.id, fromVmId, toVmId });
      placements += 1;
      placedSomewhere = true;
    }
    if (!placedSomewhere) unplaced += 1;
  }
  return { created, placements, unplaced };
}

export { createStream, duplicateStream, nextStreamName, splitNode, levelUp, levelUpEntityDetails, levelDown, levelDownSingle, copyNodes, pasteNodes, remap, applyRemapLayout, mergeNodes, mergePartsAndView, mergeViewOnly, REMAP_SORT_KEYS, REMAP_SORT_LABELS, DEFAULT_REMAP_SORT_KEYS, generateInventoryView, generateIndustry, addExistingPartsToView, populateFromTemplate, insertSmartStream, duplicateSection, smartCheckModel, applySmartCheckModelFixes, smartCheckView, smartCheckNode, createBulkLookupCache, scanStreamsForAutoComplete, autoCompleteStreams, deriveStreamNames, findCrossingCounterpart, findCompositionChildView, importDDL, exportDDL, detectConnectorCandidates, createDetectedConnectors };
