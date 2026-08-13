// sfce.js — Load SFCE: import an arbitrary JSON file as an alternate industry
// collection (Section/Function/Capability/Entity) for use by Advanced > Generate
// Industry. Pure logic only, no DOM — the modal wizard in main.js drives this.
//
// Output shape (stored into store.industryData[industryName]) extends the existing
// fce-generalnodes.json tree by one field: each Function-level node now carries a
// nodeSection. That's the "addition of a 'section' identifier" this feature adds to
// the pre-existing Function -> Capability -> Entity shape:
//   [{ nodeElementType:'BusinessFunction', nodeName, nodeId, nodeDescription, nodeSection,
//      nodeChildren:[{ nodeElementType:'BusinessCapability', nodeName, nodeId, nodeDescription,
//        nodeChildren:[{ nodeElementType:'DataDataEntity', nodeName, nodeId, nodeDescription }] }] }]
// generateIndustry itself isn't changed by this file to place nodes per-section — that's
// a separate placement-algorithm concern. This produces and stores the section-tagged
// data; it doesn't touch the canvas (no viewMembers, no new view), matching the request.

/**
 * Flattens an industry tree (either from Load SFCE, with nodeSection on each Function,
 * or the original fce-generalnodes.json shape, which has no section concept at all —
 * both are supported, section just comes back blank for the latter) into flat rows for
 * a catalog-style table: one row per Function/Capability/Entity combination, with id
 * and description at every level. A capability with no entity children (see
 * generateIndustry's own entity-fallback for why that's a real, valid case) still
 * produces one row, with the entity columns left blank rather than being dropped.
 */
export function flattenIndustryTree(tree) {
  const rows = [];
  for (const func of tree || []) {
    if (!ciEqLocal(func.nodeElementType, 'BusinessFunction')) continue;
    const caps = func.nodeChildren || [];
    if (caps.length === 0) {
      rows.push(makeRow(func, null, null));
      continue;
    }
    for (const cap of caps) {
      const entities = (cap.nodeChildren || []).filter((e) => ciEqLocal(e.nodeElementType, 'DataDataEntity'));
      if (entities.length === 0) {
        rows.push(makeRow(func, cap, null));
      } else {
        for (const ent of entities) rows.push(makeRow(func, cap, ent));
      }
    }
  }
  return rows;
}
function ciEqLocal(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}
function makeRow(func, cap, ent) {
  return {
    id: `${func.nodeId || ''}|${cap?.nodeId || ''}|${ent?.nodeId || ''}`,
    section: func.nodeSection || '',
    functionId: func.nodeId || '', functionName: func.nodeName || '', functionDescription: func.nodeDescription || '',
    capabilityId: cap?.nodeId || '', capabilityName: cap?.nodeName || '', capabilityDescription: cap?.nodeDescription || '',
    entityId: ent?.nodeId || '', entityName: ent?.nodeName || '', entityDescription: ent?.nodeDescription || '',
  };
}

/**
 * Turns arbitrary JSON into a flat list of "records" (plain objects) plus the set of
 * field names available across them, for the wizard's selectors to offer.
 *
 * Handles one level of "wrapped nested records" — the shape capabilities.json actually
 * has: a top-level array where each item carries a nested array-of-objects field (here,
 * "capabilities"). When that pattern is detected, each nested item becomes its own
 * record, with the outer item's OWN scalar fields (here, "domain") merged in as
 * additional selectable fields — so "domain" and "name"/"description"/"ministries" are
 * all available on the same flattened record, exactly matching how the wizard's
 * Section/Function/Capability/Entity selectors need to read them.
 *
 * Falls back to: top-level array of objects used directly; or, if the JSON is a single
 * wrapping object, the first array-of-objects property found on it; or a lone object
 * treated as one record. This isn't a fully general recursive flattener — it's scoped
 * to the "list of groups, each with a nested list of items" shape that's the common
 * real-world case (and is exactly capabilities.json's shape), rather than trying to
 * handle arbitrary nesting depth speculatively.
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

  // detect a nested array-of-objects field present on the first object we find (checked
  // across a few items in case the very first one happens to have an empty/missing one)
  let nestedKey = null;
  for (const item of baseArray.slice(0, 10)) {
    if (!isObj(item)) continue;
    for (const [k, v] of Object.entries(item)) {
      if (Array.isArray(v) && v.length > 0 && isObj(v[0])) { nestedKey = k; break; }
    }
    if (nestedKey) break;
  }

  const records = [];
  if (nestedKey) {
    for (const outer of baseArray) {
      if (!isObj(outer)) continue;
      const outerScalars = {};
      for (const [k, v] of Object.entries(outer)) {
        if (k === nestedKey) continue;
        if (!Array.isArray(v) && !isObj(v)) outerScalars[k] = v; // only carry forward scalars, not other nested structures
      }
      const inner = Array.isArray(outer[nestedKey]) ? outer[nestedKey] : [];
      for (const item of inner) {
        if (isObj(item)) records.push({ ...outerScalars, ...item });
      }
      if (inner.length === 0 && Object.keys(outerScalars).length > 0) records.push(outerScalars); // outer-only row, nothing nested to flatten
    }
  } else {
    for (const item of baseArray) if (isObj(item)) records.push(item);
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
 * Turns raw records into (section, function, capability, entity, description) rows —
 * one row per record per split section (a capability whose section field has multiple
 * values still becomes multiple rows here, each with its own section — that part is
 * unchanged). Missing values are kept as '(unspecified)' rather than dropping the
 * record (a missing Entity is the one exception: it's left as null so no entity child
 * gets created for that row, since an entity genuinely might not exist in the source
 * data at all — see the module doc).
 *
 * Note there's no "shared" flag on a row here — "Shared" describes a FUNCTION that
 * ends up needing to exist in more than one distinct section (because different
 * capabilities under it landed in different single sections), not a capability whose
 * own section field had multiple values. See detectSharedFunctions below.
 */
export function buildRowsFromRecords(records, mapping) {
  const { sectionField, functionField, capabilityField, entityField, descriptionField } = mapping;
  const rows = [];
  let missingFunction = 0, missingCapability = 0, missingEntity = 0, missingDescription = 0;
  for (const record of records) {
    const sections = readSectionValues(record, sectionField);
    const functionName = readScalar(record, functionField, '(unspecified)');
    const capabilityName = readScalar(record, capabilityField, '(unspecified)');
    const description = readScalar(record, descriptionField, '');
    const entityName = entityField ? readScalar(record, entityField, null) : null;
    if (functionName === '(unspecified)') missingFunction += 1;
    if (capabilityName === '(unspecified)') missingCapability += 1;
    if (entityField && !entityName) missingEntity += 1;
    if (!description) missingDescription += 1;
    for (const section of sections) {
      rows.push({ section, functionName, capabilityName, entityName, description });
    }
  }
  return { rows, missingFunction, missingCapability, missingEntity, missingDescription };
}

/**
 * Finds Functions that end up needing to exist in more than one distinct Section —
 * e.g. from the real capabilities.json data, "Analytics, Reporting & Business
 * Intelligence" has some capabilities placed under Section "Agriculture" and others
 * under "Central Government", so that Function name appears in both. Returns:
 *   - sectionsByFunction: Map<functionName, string[]> — every distinct section that
 *     function name's rows use, in first-seen row order (needed by
 *     resolveSharedFunctions below to decide which section is "first").
 *   - sharedFunctionNames: Set<functionName> — the subset with more than one section.
 */
export function detectSharedFunctions(rows) {
  const sectionsByFunction = new Map();
  for (const row of rows) {
    let list = sectionsByFunction.get(row.functionName);
    if (!list) { list = []; sectionsByFunction.set(row.functionName, list); }
    if (!list.includes(row.section)) list.push(row.section);
  }
  const sharedFunctionNames = new Set();
  for (const [name, sections] of sectionsByFunction) {
    if (sections.length > 1) sharedFunctionNames.add(name);
  }
  return { sectionsByFunction, sharedFunctionNames };
}

/**
 * Applies the user's decision about the Functions detectSharedFunctions found.
 *
 * collapseToShared=true: every row whose function name is shared gets its section
 * forced to the literal 'Shared' — so, following the example above, every "Analytics,
 * Reporting & Business Intelligence" row (regardless of which section it originally
 * came from) ends up in one combined Function under section "Shared", with all of its
 * capabilities together. (No explicit de-duplication needed here beyond that — rows
 * that become identical on section+function+capability+entity after this rewrite are
 * naturally merged by buildIndustryTree's own merge-to-uniqueness step.)
 *
 * collapseToShared=false: rows keep their original individual sections, but a shared
 * function name gets a numbered suffix in every section after its first (by first-seen
 * row order): the section that saw this function name first keeps the plain name; the
 * second section's copy becomes "Name1"; the third "Name2"; and so on — matching the
 * exact naming convention described in the request (no parentheses, no space).
 */
export function resolveSharedFunctions(rows, sectionsByFunction, sharedFunctionNames, collapseToShared) {
  if (sharedFunctionNames.size === 0) return rows;
  if (collapseToShared) {
    return rows.map((row) => (sharedFunctionNames.has(row.functionName) ? { ...row, section: 'Shared' } : row));
  }
  return rows.map((row) => {
    if (!sharedFunctionNames.has(row.functionName)) return row;
    const sections = sectionsByFunction.get(row.functionName);
    const rank = sections.indexOf(row.section); // 0 = first-seen section for this function name
    if (rank <= 0) return row;
    return { ...row, functionName: `${row.functionName}${rank}` };
  });
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * Builds the final Function -> Capability -> Entity tree (with nodeSection on each
 * Function) from resolved rows, merging to uniqueness on (section, function,
 * capability, entity) as rows are folded in — a true duplicate on all four contributes
 * nothing new; a repeat of the same function+section adds another capability under the
 * existing Function node rather than a new one; etc. Also returns the statistics the
 * caller writes to the Message Log: the ordered unique section list (first-seen order,
 * which the caller needs to reuse elsewhere per the request) and subtotals.
 */
export function buildIndustryTree(rows) {
  const functionsByKey = new Map(); // `${section}|${functionName}` -> function node
  const capsByKey = new Map(); // `${functionKey}|${capabilityName}` -> capability node
  const entitiesByKey = new Set(); // `${capKey}|${entityName}` — true-duplicate guard
  const sectionOrder = [];
  const sectionSeen = new Set();
  const functionNamesUsedInSection = new Map(); // section -> Set(function display names already used) for the "increment as needed" safety net

  let functionCount = 0, capabilityCount = 0, entityCount = 0, mergedDuplicates = 0;

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

    if (row.entityName) {
      const entKey = `${capKey}|${row.entityName}`;
      if (entitiesByKey.has(entKey)) { mergedDuplicates += 1; continue; }
      entitiesByKey.add(entKey);
      capNode.nodeChildren.push({
        nodeElementType: 'DataDataEntity',
        nodeName: row.entityName,
        nodeId: `${capNode.nodeId}-${slugify(row.entityName)}`,
        nodeDescription: '',
      });
      entityCount += 1;
    }
  }

  const tree = [...functionsByKey.values()];
  return {
    tree,
    stats: { sectionOrder, functionCount, capabilityCount, entityCount, mergedDuplicates },
  };
}
