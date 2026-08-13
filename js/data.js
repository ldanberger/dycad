// data.js — startup data loads: fce-generalnodes.json, custom.json, relationships.xml
// All three run in parallel, non-blocking. Failure -> alert with retry/abort (abort ends program).

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
 * Returns { fce, settings, relationshipsXmlPairs, mergedRelationshipPairs } or throws on abort.
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

  const [fce, settings, relXmlText] = await Promise.all([
    loadWithRetry('fce-generalnodes.json', () => fetchJson('public/fce-generalnodes.json')),
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

  return { fce, settings, relationshipsXmlPairs: xmlPairs, mergedRelationshipPairs };
}

export { loadAllData, parseRelationshipsXml, mergeRelationshipPairs };
