// sfce.js — Load SFCCE: import an arbitrary JSON file as an alternate industry
// collection (Section / Function / Capability / Application Capability / Entity) for use by
// Advanced > Generate Industry. Pure logic only, no DOM — the modal wizard in main.js
// drives this. Originally two separate features (Load SFCE: Section/Function/Capability/
// Entity, and a later Load Capability Map: Section/Function/Business Capability/
// Application Capability), combined into one because they were almost the same wizard
// with one extra level — see buildRowsFromRecords' own comment for how the extra level
// is made optional via cascade rather than requiring two different code paths.
//
// Output shape (stored into store.doc.industryTree — only one industry dataset ever
// exists at a time; Load SFCCE replaces it) is a 4-level tree —
// BusinessFunction (carrying nodeSection, and optionally nodeSectionId/
// nodeSectionDescription/nodeSectionOrder — Section has no tree node of its own, so
// its id/description/order ride along on whichever Function(s) fall under it) ->
// BusinessCapability -> ApplicationCapability -> DataDataEntity:
//   [{ nodeElementType:'BusinessFunction', nodeName, nodeId, nodeDescription, nodeSection,
//      nodeSectionId, nodeSectionDescription, nodeSectionOrder,
//      nodeChildren:[{ nodeElementType:'BusinessCapability', nodeName, nodeId, nodeDescription,
//        nodeChildren:[{ nodeElementType:'ApplicationCapability', nodeName, nodeId, nodeDescription,
//          nodeChildren:[{ nodeElementType:'DataDataEntity', nodeName, nodeId, nodeDescription }] }] }] }]
// Every nodeId is auto-derived (a chained slugify of section/function/capability/.../
// name) UNLESS the wizard's mapping supplies an explicit id field for that level, in
// which case the mapped value is used as-is — this is what lets Load SFCCE-imported
// data get real, stable identity (and therefore xIds-based find-or-reuse in
// generateIndustry/createStream, commands.js) instead of a derived-from-name one.
// generateIndustry (commands.js) walks this via the 'SFCCE' stream template
// (custom.json) — registered in store.doc.industryTemplateName (state.js). The built-in
// default dataset (public/capabilities-general-SFCCE.json, boot-loaded through this
// exact same pipeline by data.js) is ALSO a genuine 4-level tree and also registers
// 'SFCCE' — there is no separate 3-level "general" dataset anymore. generateIndustry
// itself isn't changed by this file to place nodes per-section — that's a separate
// placement-algorithm concern. This produces and stores the section-tagged data; it
// doesn't touch the canvas (no viewMembers, no new view).

/**
 * Flattens an industry tree into flat rows for a catalog-style table: one row per
 * Function/Capability/Application Capability/Entity combination, with id and description at
 * every level. Handles TWO tree shapes transparently, detected structurally per
 * Capability (not assumed globally, so a tree could in principle mix both) — every tree
 * buildIndustryTree itself produces (including the built-in default dataset, now
 * boot-loaded through this same pipeline) is always the 4-level shape below, but a
 * Load SFCCE upload that leaves Application Capability entirely unmapped still produces
 * the simpler 3-level shape (see buildRowsFromRecords' own cascade comment), so this
 * stays tolerant of both rather than assuming every tree is 4-level:
 *   - 4-level (the common case): a Capability's children are ApplicationCapability
 *     nodes, each with its own Entity children.
 *   - 3-level (an Application-Capability-less Load SFCCE import): a Capability's
 *     children ARE the Entity nodes directly, no Application Capability layer at all — those
 *     rows come back with the Application Capability columns blank, not fabricated.
 * A Capability/Application Capability with no further children still produces one row, with
 * the deeper columns left blank rather than being dropped (see generateIndustry's own
 * "no children -> treat this node as its own next level" fallback for why that's a
 * real, valid case, not just an import artifact).
 */
export function flattenIndustryTree(tree) {
  const rows = [];
  for (const func of tree || []) {
    if (!ciEqLocal(func.nodeElementType, 'BusinessFunction')) continue;
    const caps = func.nodeChildren || [];
    if (caps.length === 0) { rows.push(makeRow(func, null, null, null)); continue; }
    for (const cap of caps) {
      const children = cap.nodeChildren || [];
      const appCaps = children.filter((c) => ciEqLocal(c.nodeElementType, 'ApplicationCapability'));
      if (appCaps.length > 0) {
        for (const appCap of appCaps) {
          const entities = (appCap.nodeChildren || []).filter((e) => ciEqLocal(e.nodeElementType, 'DataDataEntity'));
          if (entities.length === 0) rows.push(makeRow(func, cap, appCap, null));
          else for (const ent of entities) rows.push(makeRow(func, cap, appCap, ent));
        }
      } else {
        // 3-level shape: this Capability's own children are Entities directly.
        const entities = children.filter((e) => ciEqLocal(e.nodeElementType, 'DataDataEntity'));
        if (entities.length === 0) rows.push(makeRow(func, cap, null, null));
        else for (const ent of entities) rows.push(makeRow(func, cap, null, ent));
      }
    }
  }
  return rows;
}
function ciEqLocal(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}
function makeRow(func, cap, appCap, ent) {
  return {
    id: `${func.nodeId || ''}|${cap?.nodeId || ''}|${appCap?.nodeId || ''}|${ent?.nodeId || ''}`,
    section: func.nodeSection || '', sectionId: func.nodeSectionId || '', sectionDescription: func.nodeSectionDescription || '', sectionOrder: func.nodeSectionOrder || '',
    functionId: func.nodeId || '', functionName: func.nodeName || '', functionDescription: func.nodeDescription || '',
    capabilityId: cap?.nodeId || '', capabilityName: cap?.nodeName || '', capabilityDescription: cap?.nodeDescription || '',
    applicationCapabilityId: appCap?.nodeId || '', applicationCapabilityName: appCap?.nodeName || '', applicationCapabilityDescription: appCap?.nodeDescription || '',
    entityId: ent?.nodeId || '', entityName: ent?.nodeName || '', entityDescription: ent?.nodeDescription || '',
  };
}

/**
 * Turns arbitrary JSON into a flat list of "records" (plain objects) plus the set of
 * field names available across them, for the wizard's selectors to offer.
 *
 * Handles arbitrarily-nested "wrapped nested records" — e.g. a merged capabilities
 * file's actual shape: a top-level array where each item carries a nested array-of-
 * objects field ("businessCapabilities"), each of THOSE carrying its own nested
 * array-of-objects field ("applicationCapabilities") — two levels deep, needed once
 * SFCCE's Application Capability level meant a single "group with a nested list" unwrap (the
 * original Load SFCE's only case) was no longer enough. Repeatedly unwraps one more
 * level of nested array-of-objects at a time (detected fresh on the CURRENT records
 * after each pass) until none remain, merging each outer item's own scalar fields
 * forward into every record it expands into — so e.g. "domain" ends up available on
 * every doubly-nested Application Capability record, however many levels down.
 *
 * EVERY field belonging to a nested array item is renamed to its full dot-path —
 * `${nestedKey}.${field}`, and again for each further level (e.g. a doubly-nested
 * Application Capability's own "name" becomes "businessCapabilities.applicationCapabilities.
 * name", not just "applicationCapabilities.name") — showing "the full length attribute
 * name with all its parent fields," not just renamed on collision. A field never inside
 * any nested array (e.g. the outermost "domain") stays bare throughout, since there's
 * nothing to disambiguate it from. This makes every field's origin unambiguous at a
 * glance when a source has more than one "name"/"description"-style field at different
 * nesting depths — the exact scenario a merged capabilities file has (both a Business
 * Capability and each of its own Application Capabilities carry their own "name").
 *
 * Falls back to: top-level array of objects used directly (no nesting to unwrap at all,
 * so every field stays bare); or, if the JSON is a single wrapping object, the first
 * array-of-objects property found on it; or a lone object treated as one record.
 */
export function flattenJsonRecords(data) {
  let baseArray = null;
  if (Array.isArray(data)) {
    baseArray = data;
  } else if (data && typeof data === 'object') {
    const arrayProp = Object.entries(data).find(([, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null);
    baseArray = arrayProp ? arrayProp[1] : [data];
  }
  if (!Array.isArray(baseArray)) return { records: [], fields: [] };

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  let records = baseArray.filter(isObj);

  // Safety cap (not a realistic depth for actual data) guards against runaway looping on
  // pathological input rather than genuinely needing 10 levels. Each pass's nestedKey is
  // itself already a full dot-path once depth > 0 (a prior pass renamed it), so prefixing
  // with `${nestedKey}.${k}` naturally accumulates the WHOLE ancestor chain, not just the
  // immediate parent.
  for (let depth = 0; depth < 10; depth++) {
    let nestedKey = null;
    for (const item of records.slice(0, 10)) {
      for (const [k, v] of Object.entries(item)) {
        if (Array.isArray(v) && v.length > 0 && isObj(v[0])) { nestedKey = k; break; }
      }
      if (nestedKey) break;
    }
    if (!nestedKey) break;

    const next = [];
    for (const outer of records) {
      const outerRest = {};
      for (const [k, v] of Object.entries(outer)) {
        if (k === nestedKey) continue;
        // Carry forward scalars AND arrays of primitives (e.g. a "sections"/"ministries"
        // multi-value field sitting alongside a deeper nested array like "entities") —
        // only an array-of-OBJECTS is excluded, since that's a further nesting level this
        // same loop will unwrap on its own next pass, and a plain nested object is
        // excluded as genuinely unflattened structure. A field's own array-of-primitives
        // value would otherwise be silently dropped here on every pass past the one that
        // introduced it, even though nothing about it needs unwrapping.
        const isArrayOfObjects = Array.isArray(v) && v.length > 0 && isObj(v[0]);
        if (!isArrayOfObjects && !isObj(v)) outerRest[k] = v;
      }
      const inner = Array.isArray(outer[nestedKey]) ? outer[nestedKey] : [];
      for (const item of inner) {
        if (!isObj(item)) continue;
        const merged = { ...outerRest };
        for (const [k, v] of Object.entries(item)) merged[`${nestedKey}.${k}`] = v;
        next.push(merged);
      }
      if (inner.length === 0 && Object.keys(outerRest).length > 0) next.push(outerRest); // outer-only row, nothing nested to flatten
    }
    records = next;
  }

  const fieldSet = new Set();
  for (const r of records) for (const k of Object.keys(r)) fieldSet.add(k);
  return { records, fields: [...fieldSet] };
}

/** Reads a field's value for one record, returning a list of section-value strings —
 * handles the field being a comma-separated string, an array, a single scalar, or
 * missing/empty (returns ['(unspecified)'] for missing, never an empty list, so a
 * record with no section value still becomes exactly one row rather than being lost). */
function readSectionValues(record, field) {
  if (!field) return ['(unspecified)'];
  const raw = record[field];
  if (raw === undefined || raw === null || raw === '') return ['(unspecified)'];
  if (Array.isArray(raw)) {
    const vals = raw.map((v) => String(v).trim()).filter(Boolean);
    return vals.length ? vals : ['(unspecified)'];
  }
  const vals = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return vals.length ? vals : ['(unspecified)'];
}

function readScalar(record, field, fallback) {
  if (!field) return fallback;
  const v = record[field];
  if (v === undefined || v === null || v === '') return fallback;
  if (Array.isArray(v)) return v.filter(Boolean).join(', ') || fallback; // best-effort: a selected scalar field that's actually an array
  return String(v);
}

/** Sentinel value for the wizard's Id mapping selects (main.js's promptSFCCEMapping) —
 * picking it means "don't read an id from the file at all, mint a fresh one," as
 * opposed to leaving the select blank (which means "no id mapped, fall back to
 * buildIndustryTree's own auto-derived slugified-name chain" — a DETERMINISTIC id,
 * not a random one). Exported so main.js can compare a select's value against this
 * exact string when building the mapping object; not itself a real field name any
 * uploaded file could plausibly contain. */
export const GENERATE_UNIQUE_ID = '__generate_unique__';

/** Resolves one row's mapped id value: the `GENERATE_UNIQUE_ID` sentinel mints a fresh
 * random id (via the real global crypto.randomUUID(), same mechanism newId() in
 * state.js itself uses) instead of reading anything from the record; any other field
 * value reads through readScalar exactly like every other mapped field. */
function resolveMappedId(record, field) {
  if (field === GENERATE_UNIQUE_ID) return crypto.randomUUID();
  return readScalar(record, field, null);
}

/**
 * Turns raw records into (section, function, capability, applicationCapability, entity,
 * description, applicationCapabilityDescription, entityDescription) rows — one row per record
 * per split section (a record whose section field has multiple values still becomes
 * multiple rows here, each with its own section).
 *
 * CASCADE: capability/applicationCapability/entity are each OPTIONAL in `mapping` (pass '' /
 * null / omit to mean "no field for this level"). Whenever a level has no mapped field,
 * OR the mapped field is empty for a given record, that level's value becomes a COPY of
 * the level immediately above it (function -> capability -> applicationCapability -> entity) —
 * this is what lets one wizard serve both old-style 3-level data (no distinct Sub-
 * Capability concept — its value just inherits the Capability's own name) and 4-level
 * data with every level distinct, without two different code paths. Function itself has
 * no cascade source (nothing above it) and keeps the '(unspecified)' fallback instead.
 * Descriptions are NOT cascaded — an inherited level has no description of its own
 * rather than a copy of its parent's, since duplicating description TEXT (unlike a
 * name, which is what makes the level exist and connect at all) has no benefit.
 *
 * Section/Function Description, and an explicit Id for every level (Section/Function/
 * Capability/Application Capability/Entity), are all OPTIONAL in `mapping` too, same
 * "absent/blank -> null" convention as the description fields above — an explicit id
 * gives buildIndustryTree a STABLE identity to use for that node (surfacing later as
 * xIds-based find-or-reuse in generateIndustry/createStream, commands.js) instead of
 * its own auto-derived slugified-name chain. IDs deliberately do NOT cascade the way
 * names do — inheriting a DIFFERENT level's id would wrongly conflate two distinct
 * identities, so a level with no mapped/blank id field just falls back to
 * buildIndustryTree's existing auto-derivation, same as if this feature didn't exist.
 * Section itself has no dedicated tree node (it's a plain string tag on each Function
 * node, see the module comment above) — its id/description/order are carried on the
 * row and attached to whichever Function node(s) end up under that section instead
 * (see buildIndustryTree's nodeSectionId/nodeSectionDescription/nodeSectionOrder).
 * `sectionOrderField` (also OPTIONAL) is a plain read-through value like
 * sectionDescriptionField — not an id, so no cascade/GENERATE_UNIQUE_ID semantics.
 *
 * An id field's mapped value can also be the `GENERATE_UNIQUE_ID` sentinel (below) —
 * "mint a genuinely fresh, random id" rather than "read this field" or "leave it
 * unmapped" — resolved once per resulting ROW (not once per input record), since a
 * Section field that splits one record into several rows produces that many
 * genuinely distinct nodes once sections diverge.
 *
 * Every row also carries originalFunctionName/originalCapabilityName/
 * originalApplicationCapabilityName/originalSection — frozen at build time, never touched by
 * resolveSharedFunctions/resolveSharedCapabilities/resolveSharedApplicationCapabilities below —
 * see detectSharedLevel's own comment for why that stability matters.
 */
export function buildRowsFromRecords(records, mapping) {
  const {
    sectionField, sectionDescriptionField, sectionIdField, sectionOrderField,
    functionField, functionDescriptionField, functionIdField,
    capabilityField, capabilityDescriptionField, capabilityIdField,
    applicationCapabilityField, applicationCapabilityDescriptionField, applicationCapabilityIdField,
    entityField, entityDescriptionField, entityIdField,
  } = mapping;
  const rows = [];
  let missingFunction = 0, missingCapability = 0, missingApplicationCapability = 0, missingEntity = 0, missingDescription = 0;
  for (const record of records) {
    const sections = readSectionValues(record, sectionField);
    const sectionDescription = readScalar(record, sectionDescriptionField, '');
    // Not an id (no cascade/GENERATE_UNIQUE_ID semantics), just a plain read-through
    // value like sectionDescription -- a section's display/generation order, read once
    // per record (not per resulting row) since it describes the section as a whole,
    // same as sectionDescription.
    const sectionOrder = readScalar(record, sectionOrderField, '');
    const functionName = readScalar(record, functionField, '(unspecified)');
    if (functionName === '(unspecified)') missingFunction += 1;
    const functionDescription = readScalar(record, functionDescriptionField, '');

    const rawCapability = readScalar(record, capabilityField, null);
    const capabilityName = rawCapability ?? functionName; // cascade: capability <- function
    if (rawCapability == null) missingCapability += 1;
    const description = readScalar(record, capabilityDescriptionField, '');
    if (!description) missingDescription += 1;

    const rawApplicationCapability = readScalar(record, applicationCapabilityField, null);
    const applicationCapabilityName = rawApplicationCapability ?? capabilityName; // cascade: applicationCapability <- capability
    if (rawApplicationCapability == null) missingApplicationCapability += 1;
    const applicationCapabilityDescription = readScalar(record, applicationCapabilityDescriptionField, '');

    const rawEntity = readScalar(record, entityField, null);
    const entityName = rawEntity ?? applicationCapabilityName; // cascade: entity <- applicationCapability
    if (rawEntity == null) missingEntity += 1;
    const entityDescription = readScalar(record, entityDescriptionField, '');

    // Ids are resolved per RESULTING ROW, not once per record — a record whose Section
    // field splits into several rows (see readSectionValues above) genuinely produces
    // several distinct nodes once sections differ, so "(generate unique)" must hand
    // each of those its own fresh id rather than one shared across all of them. A real
    // mapped field, by contrast, reads identically regardless of loop position.
    for (const section of sections) {
      const sectionId = resolveMappedId(record, sectionIdField);
      const functionId = resolveMappedId(record, functionIdField);
      const capabilityId = resolveMappedId(record, capabilityIdField);
      const applicationCapabilityId = resolveMappedId(record, applicationCapabilityIdField);
      const entityId = resolveMappedId(record, entityIdField);
      rows.push({
        section, originalSection: section, sectionDescription, sectionId, sectionOrder,
        functionName, originalFunctionName: functionName, functionDescription, functionId,
        capabilityName, originalCapabilityName: capabilityName,
        description, capabilityId,
        applicationCapabilityName, originalApplicationCapabilityName: applicationCapabilityName,
        applicationCapabilityDescription, applicationCapabilityId,
        entityName, entityDescription, entityId,
      });
    }
  }
  return { rows, missingFunction, missingCapability, missingApplicationCapability, missingEntity, missingDescription };
}

/**
 * Finds identities that end up needing to exist in more than one distinct Section —
 * generic core shared by the three exported detect/resolve pairs below (Function,
 * Capability, Application Capability each independently need this: a real merged capabilities
 * dataset showed ~93% of business capabilities span multiple sections through their own
 * application capabilities alone, so this is the common case here, not a rare edge case).
 * `identityKeyFn(row)` returns a STABLE identity for the level being checked, scoped to
 * its own ancestors (e.g. a Capability's identity includes its Function, so two
 * different Functions coincidentally sharing a Capability name aren't conflated) — reads
 * row.originalSection (frozen, never mutated by resolveSharedLevel) rather than the live
 * row.section, so all three levels' detection AND resolution give the identical answer
 * regardless of what order they run in or what the other levels' choices were. Without
 * that stability, whichever resolution ran second would rank against whatever section
 * value the first one already rewrote (e.g. to 'Shared'), silently losing its own
 * numbered-suffix distinctions for any row more than one level touched.
 */
function detectSharedLevel(rows, identityKeyFn) {
  const sectionsByIdentity = new Map();
  for (const row of rows) {
    const key = identityKeyFn(row);
    let list = sectionsByIdentity.get(key);
    if (!list) { list = []; sectionsByIdentity.set(key, list); }
    if (!list.includes(row.originalSection)) list.push(row.originalSection);
  }
  const sharedIdentities = new Set();
  for (const [key, sections] of sectionsByIdentity) if (sections.length > 1) sharedIdentities.add(key);
  return { sectionsByIdentity, sharedIdentities };
}

/**
 * Applies the user's decision about the identities detectSharedLevel found.
 *
 * collapseToShared=true: every row whose identity is shared gets its section forced to
 * the literal 'Shared' — so e.g. every row of a Function/Capability/Application Capability that
 * spans several sections (regardless of which section it originally came from) ends up
 * combined under section "Shared". (No explicit de-duplication needed beyond that — rows
 * that become identical after this rewrite are naturally merged by buildIndustryTree's
 * own merge-to-uniqueness step.)
 *
 * collapseToShared=false: rows keep their original individual sections, but a shared
 * identity gets a numbered suffix on `levelField` in every section after its first (by
 * first-seen row order, ranked against originalSection so this is independent of
 * whatever the OTHER levels' own resolution already did to the live section value): the
 * section that saw this identity first keeps the plain name; the second section's copy
 * becomes "Name1"; the third "Name2"; and so on.
 */
function resolveSharedLevel(rows, sectionsByIdentity, sharedIdentities, identityKeyFn, levelField, collapseToShared) {
  if (sharedIdentities.size === 0) return rows;
  if (collapseToShared) {
    return rows.map((row) => (sharedIdentities.has(identityKeyFn(row)) ? { ...row, section: 'Shared' } : row));
  }
  return rows.map((row) => {
    const key = identityKeyFn(row);
    if (!sharedIdentities.has(key)) return row;
    const sections = sectionsByIdentity.get(key);
    const rank = sections.indexOf(row.originalSection); // 0 = first-seen section for this identity
    if (rank <= 0) return row;
    return { ...row, [levelField]: `${row[levelField]}${rank}` };
  });
}

/** Function-level sharing — e.g. "Transportation & Roads" appearing under both
 * "Environment" and "Justice" sections. Independent of the Capability/Application Capability
 * checks below (see detectSharedLevel's own comment for why they can run in any order). */
export function detectSharedFunctions(rows) {
  const { sectionsByIdentity, sharedIdentities } = detectSharedLevel(rows, (row) => row.originalFunctionName);
  return { sectionsByFunction: sectionsByIdentity, sharedFunctionNames: sharedIdentities };
}
export function resolveSharedFunctions(rows, sectionsByFunction, sharedFunctionNames, collapseToShared) {
  return resolveSharedLevel(rows, sectionsByFunction, sharedFunctionNames, (row) => row.originalFunctionName, 'functionName', collapseToShared);
}

/** Capability-level sharing, scoped within its own Function so two different Functions
 * coincidentally sharing a Capability name aren't conflated. Independent of the
 * Function/Application Capability checks. */
export function detectSharedCapabilities(rows) {
  const { sectionsByIdentity, sharedIdentities } = detectSharedLevel(rows, (row) => `${row.originalFunctionName}|${row.originalCapabilityName}`);
  return { sectionsByCapability: sectionsByIdentity, sharedCapabilityKeys: sharedIdentities };
}
export function resolveSharedCapabilities(rows, sectionsByCapability, sharedCapabilityKeys, collapseToShared) {
  return resolveSharedLevel(rows, sectionsByCapability, sharedCapabilityKeys, (row) => `${row.originalFunctionName}|${row.originalCapabilityName}`, 'capabilityName', collapseToShared);
}

/** Application Capability-level sharing, scoped within its own (Function, Capability) pair.
 * Independent of the Function/Capability checks. */
export function detectSharedApplicationCapabilities(rows) {
  const { sectionsByIdentity, sharedIdentities } = detectSharedLevel(rows, (row) => `${row.originalFunctionName}|${row.originalCapabilityName}|${row.originalApplicationCapabilityName}`);
  return { sectionsByApplicationCapability: sectionsByIdentity, sharedApplicationCapabilityKeys: sharedIdentities };
}
export function resolveSharedApplicationCapabilities(rows, sectionsByApplicationCapability, sharedApplicationCapabilityKeys, collapseToShared) {
  return resolveSharedLevel(rows, sectionsByApplicationCapability, sharedApplicationCapabilityKeys, (row) => `${row.originalFunctionName}|${row.originalCapabilityName}|${row.originalApplicationCapabilityName}`, 'applicationCapabilityName', collapseToShared);
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * Builds the final Function -> Capability -> Application Capability -> Entity tree (with
 * nodeSection on each Function) from resolved rows, merging to uniqueness on (section,
 * function, capability, applicationCapability, entity) as rows are folded in. Always 4 levels
 * deep — applicationCapabilityName is never empty by the time rows reach here (buildRowsFromRecords'
 * cascade guarantees it), so there's no "skip this level" branch to speak of, unlike
 * entity (still conditionally created — see below). Also returns the statistics the
 * caller writes to the Message Log: the ordered unique section list (first-seen order)
 * and subtotals.
 */
export function buildIndustryTree(rows) {
  const functionsByKey = new Map(); // `${section}|${functionName}` -> function node
  const capsByKey = new Map(); // `${functionKey}|${capabilityName}` -> capability node
  const appCapsByKey = new Map(); // `${capKey}|${applicationCapabilityName}` -> application capability node
  const entitiesByKey = new Set(); // `${appCapKey}|${entityName}` — true-duplicate guard
  const sectionOrder = [];
  const sectionSeen = new Set();
  const functionNamesUsedInSection = new Map(); // section -> Set(function display names already used) for the "increment as needed" safety net

  let functionCount = 0, capabilityCount = 0, applicationCapabilityCount = 0, entityCount = 0, mergedDuplicates = 0;

  for (const row of rows) {
    if (!sectionSeen.has(row.section)) { sectionSeen.add(row.section); sectionOrder.push(row.section); }

    const funcKey = `${row.section}|${row.functionName}`;
    let funcNode = functionsByKey.get(funcKey);
    if (!funcNode) {
      let displayName = row.functionName;
      const usedInSection = functionNamesUsedInSection.get(row.section) || new Set();
      if (usedInSection.has(displayName)) {
        let n = 2;
        while (usedInSection.has(`${displayName} (${n})`)) n += 1;
        displayName = `${displayName} (${n})`;
      }
      usedInSection.add(displayName);
      functionNamesUsedInSection.set(row.section, usedInSection);
      funcNode = {
        nodeElementType: 'BusinessFunction',
        nodeName: displayName,
        nodeId: row.functionId || `${slugify(row.section)}-${slugify(displayName)}`,
        nodeDescription: row.functionDescription || '',
        nodeSection: row.section,
        nodeSectionId: row.sectionId || null,
        nodeSectionDescription: row.sectionDescription || '',
        nodeSectionOrder: row.sectionOrder || null,
        nodeChildren: [],
      };
      functionsByKey.set(funcKey, funcNode);
      functionCount += 1;
    } else {
      if (!funcNode.nodeDescription && row.functionDescription) funcNode.nodeDescription = row.functionDescription;
      if (!funcNode.nodeSectionId && row.sectionId) funcNode.nodeSectionId = row.sectionId;
      if (!funcNode.nodeSectionDescription && row.sectionDescription) funcNode.nodeSectionDescription = row.sectionDescription;
      if (!funcNode.nodeSectionOrder && row.sectionOrder) funcNode.nodeSectionOrder = row.sectionOrder;
    }

    const capKey = `${funcKey}|${row.capabilityName}`;
    let capNode = capsByKey.get(capKey);
    if (!capNode) {
      capNode = {
        nodeElementType: 'BusinessCapability',
        nodeName: row.capabilityName,
        nodeId: row.capabilityId || `${funcNode.nodeId}-${slugify(row.capabilityName)}`,
        nodeDescription: row.description || '',
        nodeChildren: [],
      };
      capsByKey.set(capKey, capNode);
      funcNode.nodeChildren.push(capNode);
      capabilityCount += 1;
    } else if (!capNode.nodeDescription && row.description) {
      capNode.nodeDescription = row.description; // fill in from a later row if the first one that created this capability had none
    }

    const appCapKey = `${capKey}|${row.applicationCapabilityName}`;
    let appCapNode = appCapsByKey.get(appCapKey);
    if (!appCapNode) {
      appCapNode = {
        nodeElementType: 'ApplicationCapability',
        nodeName: row.applicationCapabilityName,
        nodeId: row.applicationCapabilityId || `${capNode.nodeId}-${slugify(row.applicationCapabilityName)}`,
        nodeDescription: row.applicationCapabilityDescription || '',
        nodeChildren: [],
      };
      appCapsByKey.set(appCapKey, appCapNode);
      capNode.nodeChildren.push(appCapNode);
      applicationCapabilityCount += 1;
    } else if (!appCapNode.nodeDescription && row.applicationCapabilityDescription) {
      appCapNode.nodeDescription = row.applicationCapabilityDescription;
    }

    if (row.entityName) {
      const entKey = `${appCapKey}|${row.entityName}`;
      if (entitiesByKey.has(entKey)) { mergedDuplicates += 1; continue; }
      entitiesByKey.add(entKey);
      appCapNode.nodeChildren.push({
        nodeElementType: 'DataDataEntity',
        nodeName: row.entityName,
        nodeId: row.entityId || `${appCapNode.nodeId}-${slugify(row.entityName)}`,
        nodeDescription: row.entityDescription || '',
      });
      entityCount += 1;
    }
  }

  const tree = [...functionsByKey.values()];
  return {
    tree,
    stats: { sectionOrder, functionCount, capabilityCount, applicationCapabilityCount, entityCount, mergedDuplicates },
  };
}
