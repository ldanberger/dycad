// rules.js — connector validity: settings.relations -> settings.relationshipPairs (merged with relationships.xml)
import { ciEq } from './state.js';

/** Looks up one entry in store.mergedRelationshipPairs by (typeA, typeB), case-insensitive
 * — a Map lookup, not the linear .find() every caller used to do directly. Worth indexing:
 * relationships.xml alone merges in ~3800 pairs, and this gets called on every single
 * connector a bulk-generation loop creates (Generate Industry, Split Node, ...), so a plain
 * .find() over a list that size, repeated thousands of times, was a real, measured cost
 * (confirmed via CPU profile) despite mergedRelationshipPairs itself never growing with the
 * document. The index is built lazily on first use per array instance and rebuilt if
 * store.mergedRelationshipPairs is ever reassigned to a new array (checked by reference —
 * it's set once at boot and never mutated in place, so this only ever rebuilds once). */
function findRelationshipPair(store, typeA, typeB) {
  if (store._relPairIndexSource !== store.mergedRelationshipPairs) {
    const idx = new Map();
    for (const p of store.mergedRelationshipPairs) {
      idx.set(`${String(p.typeA).toLowerCase()}|${String(p.typeB).toLowerCase()}`, p);
    }
    store._relPairIndex = idx;
    store._relPairIndexSource = store.mergedRelationshipPairs;
  }
  return store._relPairIndex.get(`${String(typeA).toLowerCase()}|${String(typeB).toLowerCase()}`) || null;
}

/**
 * Look up the merged relationshipPairs list for a fromType->toType pair (case-insensitive).
 * Returns the relations string (letters), or '' if no rule is defined for that direction.
 */
function relationsFor(store, fromType, toType) {
  const pair = findRelationshipPair(store, fromType, toType);
  return pair ? pair.relations : '';
}

/** Returns an array of { key, name } relation options valid for fromType -> toType. */
function validRelationOptions(store, fromType, toType) {
  const letters = relationsFor(store, fromType, toType);
  const relations = store.settings.relations || [];
  return [...letters].map((ch) => relations.find((r) => r.key === ch)).filter(Boolean);
}

/** Is a connector of the given relation-key allowed between the two element types? */
function isRelationValid(store, fromType, toType, relationKey) {
  const letters = relationsFor(store, fromType, toType);
  return letters.includes(relationKey);
}

/** The data-defined default relation key (settings.relationshipPairs[].default, merged
 * with relationships.xml — falls back to the first allowed relation letter if the pair
 * never specified an explicit default) for a fromType->toType pair, or null if the pair
 * has no rule at all. */
function defaultRelationKeyFor(store, fromType, toType) {
  const pair = findRelationshipPair(store, fromType, toType);
  return pair ? pair.default : null;
}

/** Get an element definition by type (case-insensitive), falling back to the 'Unknown' element. */
function elementByType(store, type) {
  const list = store.settings.elements || [];
  return list.find((e) => ciEq(e.type, type)) || list.find((e) => ciEq(e.type, 'Unknown'));
}

export { relationsFor, validRelationOptions, isRelationValid, elementByType, defaultRelationKeyFor, findRelationshipPair };
