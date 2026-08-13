// rules.js — connector validity: settings.relations -> settings.relationshipPairs (merged with relationships.xml)
import { ciEq } from './state.js';

/**
 * Look up the merged relationshipPairs list for a fromType->toType pair (case-insensitive).
 * Returns the relations string (letters), or '' if no rule is defined for that direction.
 */
function relationsFor(store, fromType, toType) {
  const pair = store.mergedRelationshipPairs.find((p) => ciEq(p.typeA, fromType) && ciEq(p.typeB, toType));
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
  const pair = store.mergedRelationshipPairs.find((p) => ciEq(p.typeA, fromType) && ciEq(p.typeB, toType));
  return pair ? pair.default : null;
}

/** Get an element definition by type (case-insensitive), falling back to the 'Unknown' element. */
function elementByType(store, type) {
  const list = store.settings.elements || [];
  return list.find((e) => ciEq(e.type, type)) || list.find((e) => ciEq(e.type, 'Unknown'));
}

export { relationsFor, validRelationOptions, isRelationValid, elementByType, defaultRelationKeyFor };
