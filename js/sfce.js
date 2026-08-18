// sfce.js — Load SFCCE: import an arbitrary JSON file as an alternate industry
// collection (Section / Function / Capability / Application Capability / Entity) for use by
// Advanced > Generate Industry. Pure logic only, no DOM — the modal wizard in main.js
// drives this. Originally two separate features (Load SFCE: Section/Function/Capability/
// Entity, and a later Load Capability Map: Section/Function/Business Capability/
// Application Capability), combined into one because they were almost the same wizard
// with one extra level — see buildRowsFromRecords' own comment for how the extra level
// is made optional via cascade rather than requiring two different code paths.
//
// Output shape (stored into store.industryData[industryName]) is a 4-level tree —
// BusinessFunction (carrying nodeSection) -> BusinessCapability -> ApplicationCapability
// -> DataDataEntity:
//   [{ nodeElementType:'BusinessFunction', nodeName, nodeId, nodeDescription, nodeSection,
//      nodeChildren:[{ nodeElementType:'BusinessCapability', nodeName, nodeId, nodeDescription,
//        nodeChildren:[{ nodeElementType:'ApplicationCapability', nodeName, nodeId, nodeDescription,
//          nodeChildren:[{ nodeElementType:'DataDataEntity', nodeName, nodeId, nodeDescription }] }] }] }]
// generateIndustry (commands.js) walks this via the 'SFCCE' stream template
// (custom.json) — registered per industryData key in store.industryTemplates (state.js)
// so the built-in 'general' dataset (a genuine 3-level tree, unrelated to this wizard)
// keeps using 'Enterprise' and is completely unaffected by anything in this file.
// generateIndustry itself isn't changed by this file to place nodes per-section — that's
// a separate placement-algorithm concern. This produces and stores the section-tagged
// data; it doesn't touch the canvas (no viewMembers, no new view).

/**
 * Flattens an industry tree into flat rows for a catalog-style table: one row per
 * Function/Capability/Application Capability/Entity combination, with id and description at
 * every level. Handles TWO tree shapes transparently, detected structurally per
 * Capability (not assumed globally, so a tree could in principle mix both — though in
 * practice only the built-in 'general' dataset is ever the 3-level shape):
 *   - 4-level (from this file's own buildIndustryTree): a Capability's children are
 *     ApplicationCapability nodes, each with its own Entity children.
 *   - 3-level (fce-generalnodes.json, predating this file entirely): a Capability's
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
    section: func.nodeSection || '',
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
 * Every row also carries originalFunctionName/originalCapabilityName/
 * originalApplicationCapabilityName/originalSection — frozen at build time, never touched by
 * resolveSharedFunctions/resolveSharedCapabilities/resolveSharedApplicationCapabilities below —
 * see detectSharedLevel's own comment for why that stability matters.
 */
export function buildRowsFromRecords(records, mapping) {
  const {
    sectionField, functionField,
    capabilityField, capabilityDescriptionField,
    applicationCapabilityField, applicationCapabilityDescriptionField,
    entityField, entityDescriptionField,
  } = mapping;
  const rows = [];
  let missingFunction = 0, missingCapability = 0, missingApplicationCapability = 0, missingEntity = 0, missingDescription = 0;
  for (const record of records) {
    const sections = readSectionValues(record, sectionField);
    const functionName = readScalar(record, functionField, '(unspecified)');
    if (functionName === '(unspecified)') missingFunction += 1;

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

    for (const section of sections) {
      rows.push({
        section, originalSection: section,
        functionName, originalFunctionName: functionName,
        capabilityName, originalCapabilityName: capabilityName,
        description,
        applicationCapabilityName, originalApplicationCapabilityName: applicationCapabilityName,
        applicationCapabilityDescription,
        entityName, entityDescription,
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
        nodeId: `${slugify(row.section)}-${slugify(displayName)}`,
        nodeDescription: '',
        nodeSection: row.section,
        nodeChildren: [],
      };
      functionsByKey.set(funcKey, funcNode);
      functionCount += 1;
    }

    const capKey = `${funcKey}|${row.capabilityName}`;
    let capNode = capsByKey.get(capKey);
    if (!capNode) {
      capNode = {
        nodeElementType: 'BusinessCapability',
        nodeName: row.capabilityName,
        nodeId: `${funcNode.nodeId}-${slugify(row.capabilityName)}`,
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
        nodeId: `${capNode.nodeId}-${slugify(row.applicationCapabilityName)}`,
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
        nodeId: `${appCapNode.nodeId}-${slugify(row.entityName)}`,
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
