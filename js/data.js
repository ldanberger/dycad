// data.js — startup data loads: capabilities-general-SFCCE.json, custom.json,
// relationships.xml. All three run in parallel, non-blocking. Failure -> alert with
// retry/abort (abort ends program).

import { flattenJsonRecords, buildRowsFromRecords, buildIndustryTree } from './sfce.js';

/** Field mapping for the built-in default industry dataset
 * (public/capabilities-general-SFCCE.json), in the same shape a real File > Load SFCCE
 * upload of this exact file would use -- run through the identical pipeline
 * (flattenJsonRecords -> buildRowsFromRecords -> buildIndustryTree) rather than assigning
 * a hand-built tree directly, so the built-in default and any user-imported dataset are
 * produced by exactly one code path (per the direct request: "Now load the
 * capabilities-general-SFCCE.json file automatically, replacing the load and all logic
 * for loading fce-generalnodes.json"). No id fields mapped -- every level gets
 * buildIndustryTree's own deterministic, slugified-name-derived id, same as any other
 * unmapped-id Load SFCCE import. sectionId/sectionOrder ARE mapped -- the file's own
 * per-function `sectionId`/`order` fields (matching custom.json's org-viewType
 * sections) ride through to each Function node's nodeSectionId/nodeSectionOrder. */
const GENERAL_SFCCE_MAPPING = {
  sectionField: 'section', sectionIdField: 'sectionId', sectionOrderField: 'order',
  functionField: 'function', functionDescriptionField: 'functionDescription',
  capabilityField: 'capabilities.name', capabilityDescriptionField: 'capabilities.description',
  applicationCapabilityField: 'capabilities.applicationCapability',
  entityField: 'capabilities.entities.name', entityDescriptionField: 'capabilities.entities.description',
};

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/**
 * Parse relationships.xml (ArchiMate 3.2 concept matrix) into a flat array of
 * { typeA, typeB, relations } pairs, matching the shape of custom.json's relationshipPairs.
 */
function parseRelationshipsXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('relationships.xml is not well-formed XML');

  const pairs = [];
  const sources = doc.getElementsByTagName('source');
  for (const src of sources) {
    const typeA = src.getAttribute('concept');
    const targets = src.getElementsByTagName('target');
    for (const tgt of targets) {
      const typeB = tgt.getAttribute('concept');
      const relations = tgt.getAttribute('relations') || '';
      pairs.push({ typeA, typeB, relations });
    }
  }
  return pairs;
}

/**
 * Merge custom.json's relationshipPairs with the ArchiMate 3.2 matrix parsed from relationships.xml.
 * Where a typeA→typeB pair exists in both (case-insensitive), union the relation-letter sets.
 * A→B is never used to infer B→A.
 */
function mergeRelationshipPairs(customPairs, xmlPairs) {
  const key = (a, b) => `${String(a).toLowerCase()}→${String(b).toLowerCase()}`;
  const map = new Map(); // key -> { typeA, typeB, relSet: Set, default }

  const ingest = (list) => {
    for (const p of list) {
      if (!p.typeA || !p.typeB) continue;
      const k = key(p.typeA, p.typeB);
      let entry = map.get(k);
      if (!entry) {
        entry = { typeA: p.typeA, typeB: p.typeB, relSet: new Set(), default: null };
        map.set(k, entry);
      }
      for (const ch of String(p.relations || '')) entry.relSet.add(ch);
      if (p.default) entry.default = p.default; // custom.json's explicit default wins if present
    }
  };

  // xml first (broad ArchiMate standard), then custom.json overlays/extends it
  ingest(xmlPairs);
  ingest(customPairs);

  return [...map.values()].map((e) => ({
    typeA: e.typeA,
    typeB: e.typeB,
    relations: [...e.relSet].join(''),
    default: e.default || [...e.relSet][0] || null, // no default specified -> first allowed relation
  }));
}

/**
 * Loads all three startup resources in parallel. Each is independently retryable.
 * onRetryPrompt(label, error) must return a Promise<'retry'|'abort'>.
 * Returns { industryTree, settings, relationshipsXmlPairs, mergedRelationshipPairs } or
 * throws on abort. industryTree is the built-in default industry dataset, already run
 * through the Load SFCCE pipeline (see GENERAL_SFCCE_MAPPING above) -- a genuine 4-level
 * Section/Function/Capability/Application Capability/Entity tree, the same shape any
 * Load SFCCE import produces.
 */
async function loadAllData({ onRetryPrompt }) {
  async function loadWithRetry(label, loaderFn) {
    while (true) {
      try {
        return await loaderFn();
      } catch (err) {
        const choice = await onRetryPrompt(label, err);
        if (choice === 'retry') continue;
        throw new Error('ABORT');
      }
    }
  }

  const [rawIndustry, settings, relXmlText] = await Promise.all([
    loadWithRetry('capabilities-general-SFCCE.json', () => fetchJson('public/capabilities-general-SFCCE.json')),
    loadWithRetry('custom.json', () => fetchJson('public/custom.json')),
    loadWithRetry('relationships.xml', () => fetchText('public/relationships.xml')),
  ]);

  let xmlPairs = [];
  try {
    xmlPairs = parseRelationshipsXml(relXmlText);
  } catch (err) {
    const choice = await onRetryPrompt('relationships.xml (parse)', err);
    if (choice !== 'retry') throw new Error('ABORT');
    xmlPairs = parseRelationshipsXml(await fetchText('public/relationships.xml'));
  }

  const mergedRelationshipPairs = mergeRelationshipPairs(settings.relationshipPairs || [], xmlPairs);

  const { records } = flattenJsonRecords(rawIndustry);
  const { rows } = buildRowsFromRecords(records, GENERAL_SFCCE_MAPPING);
  const { tree: industryTree } = buildIndustryTree(rows);

  return { industryTree, settings, relationshipsXmlPairs: xmlPairs, mergedRelationshipPairs };
}

export { loadAllData, parseRelationshipsXml, mergeRelationshipPairs };
