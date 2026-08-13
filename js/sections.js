// sections.js — section-based canvas layout (non-'ff' viewTypes).
import { ciEq, newId } from './state.js';

// Reuse the same uniform node-spacing constants as Generate/Remap.
export const CELL_W = 170, CELL_H = 90;
export const HEADER_H = 34, SECTION_GAP = 24;
export const BASE_X = 60, BASE_Y = 40;
export const NODE_INSET_X = 10, NODE_INSET_Y = 12;

/** Is this viewType section-based (i.e. not free-form)? */
export function isSectionViewType(viewType) {
  return !!viewType && !ciEq(viewType, 'ff');
}

/**
 * Compute the on-canvas layout for every section in a view, stacked top-to-bottom by order.
 * Returns [{ section, left, top, width, height, headerTop, headerHeight, bodyTop, bodyLeft }]
 */
export function computeSectionLayout(view) {
  const scale = view.spacingScale || 1;
  // Cell size derives from the view's ACTUAL current node size (same +40/+44 margin
  // convention as freeform's stepX/stepY), not a fixed constant — otherwise a Redraw or
  // Remap that grows/shrinks nodeWidth/nodeHeight leaves the section grid stuck at its
  // old size, causing nodes to overflow their cells or leaving wasted empty space.
  const cellW = ((view.nodeWidth ?? 130) + 40) * scale;
  const cellH = ((view.nodeHeight ?? 46) + 44) * scale;
  const sections = [...(view.sections || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const layout = [];
  let y = BASE_Y;
  for (const section of sections) {
    const isTitleOnly = ciEq(section.sectionId, 'title');
    const width = Math.max(1, section.columnCount || 1) * cellW;
    const bodyHeight = isTitleOnly ? 0 : Math.max(1, section.rowCount || 1) * cellH;
    const entry = {
      section,
      left: BASE_X, top: y,
      width, height: HEADER_H + bodyHeight,
      headerTop: y, headerHeight: HEADER_H,
      bodyTop: y + HEADER_H, bodyLeft: BASE_X, bodyHeight,
      cellW, cellH,
    };
    layout.push(entry);
    y += entry.height + SECTION_GAP;
  }
  return layout;
}

/** Element-type filter: ['*'] = allow all, [] = allow none, else whitelist. */
export function isTypeAllowedInSection(section, elementType) {
  const types = section.elementTypes || [];
  if (types.includes('*')) return true;
  if (types.length === 0) return false;
  return types.some((t) => ciEq(t, elementType));
}

/** Convert a section-relative (row, col) to canvas pixel coordinates (node top-left). */
export function gridToPixel(layoutEntry, row, col) {
  const r = Math.max(0, Math.min(row, (layoutEntry.section.rowCount || 1) - 1));
  const c = Math.max(0, Math.min(col, (layoutEntry.section.columnCount || 1) - 1));
  return {
    x: layoutEntry.bodyLeft + c * layoutEntry.cellW + NODE_INSET_X,
    y: layoutEntry.bodyTop + r * layoutEntry.cellH + NODE_INSET_Y,
  };
}

/**
 * Given a raw canvas pixel point, find which section it falls nearest to and the
 * nearest row/col within it. Always resolves to some section if the view has any.
 * Returns { layoutEntry, row, col, x, y } or null if the view has no sections.
 */
export function pixelToNearestGrid(view, px, py) {
  const layout = computeSectionLayout(view);
  if (layout.length === 0) return null;

  // find a section whose body bounds contain the point; else the vertically-nearest one.
  // Uses entry.bodyHeight (title-only sections correctly get 0 here, matching how
  // computeSectionLayout actually stacks them) rather than recomputing from
  // section.rowCount directly — that mismatch was a real bug: a title section's hit-test
  // zone was extending a full rowCount*cellH below its header even though it has no
  // visual body at all, silently swallowing drops into the TOP of whichever section
  // immediately follows it and rejecting them (title's elementTypes is always []).
  let best = null, bestDist = Infinity;
  for (const entry of layout) {
    const withinX = px >= entry.bodyLeft && px <= entry.bodyLeft + entry.width;
    const bodyBottom = entry.bodyTop + entry.bodyHeight;
    const withinY = entry.bodyHeight > 0 && py >= entry.bodyTop && py <= bodyBottom;
    if (withinX && withinY) { best = entry; bestDist = 0; break; }
    // distance to this section's bounding box (clamped) — for title-only sections
    // (bodyHeight 0), this correctly collapses to distance-from-the-header-line rather
    // than a phantom body area.
    const cx = Math.max(entry.bodyLeft, Math.min(px, entry.bodyLeft + entry.width));
    const cy = Math.max(entry.bodyTop, Math.min(py, bodyBottom));
    const dist = (px - cx) ** 2 + (py - cy) ** 2;
    if (dist < bestDist) { bestDist = dist; best = entry; }
  }
  if (!best) return null;

  const col = Math.round((px - best.bodyLeft - NODE_INSET_X) / best.cellW);
  const row = Math.round((py - best.bodyTop - NODE_INSET_Y) / best.cellH);
  const { x, y } = gridToPixel(best, row, col);
  return { layoutEntry: best, row, col, x, y };
}

/**
 * Returns a place(elementType) function that fills a section-based view's sections in
 * order, respecting elementTypes and each section's row/column capacity, wrapping to the
 * next matching section when one fills up, and falling back to an overflow area below
 * all sections if nothing matches or everything is full. Used by Generate/Duplicate
 * Stream so newly-created nodes land inside the section grid instead of a flat chain.
 */
export function createSectionPlacer(store, view) {
  const layout = computeSectionLayout(view);
  const scale = view.spacingScale || 1;
  const cellW = ((view.nodeWidth ?? 130) + 40) * scale;
  const cellH = ((view.nodeHeight ?? 46) + 44) * scale;
  const existing = store.viewMembersForView(view.id).filter((vm) => vm.objectType === 'part');

  const cursors = new Map(); // section.id -> { row, col }
  for (const entry of layout) {
    const colCount = Math.max(1, entry.section.columnCount || 1);
    const count = existing.filter((vm) => vm.sectionId === entry.section.sectionId).length;
    cursors.set(entry.section.id, { row: Math.floor(count / colCount), col: count % colCount });
  }

  let overflowIndex = existing.filter((vm) => !vm.sectionId).length;
  const last = layout[layout.length - 1];
  const overflowY = last ? last.top + last.height + SECTION_GAP : BASE_Y;

  return function place(elementType) {
    for (const entry of layout) {
      if (!isTypeAllowedInSection(entry.section, elementType)) continue;
      const rowCount = Math.max(1, entry.section.rowCount || 1);
      const colCount = Math.max(1, entry.section.columnCount || 1);
      const cur = cursors.get(entry.section.id);
      if (cur.row >= rowCount) continue; // this section is full, try the next matching one
      const { x, y } = gridToPixel(entry, cur.row, cur.col);
      cur.col += 1;
      if (cur.col >= colCount) { cur.col = 0; cur.row += 1; }
      return { x, y, sectionId: entry.section.sectionId };
    }
    // nothing matched (or everything full): overflow area below all sections
    const x = BASE_X + (overflowIndex % 10) * cellW;
    const y = overflowY + Math.floor(overflowIndex / 10) * cellH;
    overflowIndex += 1;
    return { x, y, sectionId: '' };
  };
}

/**
 * Union of allowed element types across all of a view's sections, for filtering the
 * toolkit. Returns null for 'ff' views (no restriction) or if any section allows '*'.
 * Otherwise returns a Set of allowed type strings (lowercased for case-insensitive use).
 */
export function getAllowedTypesForView(view) {
  if (!isSectionViewType(view.viewType)) return null;
  const sections = view.sections || [];
  if (sections.length === 0) return null;
  const allowed = new Set();
  for (const section of sections) {
    const types = section.elementTypes || [];
    if (types.includes('*')) return null; // at least one section allows everything
    for (const t of types) allowed.add(String(t).toLowerCase());
  }
  return allowed;
}

/**
 * Given a starting row/col within a section, scan forward (row-major) for the nearest
 * unoccupied cell. Falls back to the originally requested cell if the section is full.
 */
export function findFreeCellInSection(store, viewId, layoutEntry, startRow, startCol) {
  const rowCount = Math.max(1, layoutEntry.section.rowCount || 1);
  const colCount = Math.max(1, layoutEntry.section.columnCount || 1);
  const existing = store.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part');
  const occupied = (x, y) => existing.some((vm) => vm.x === x && vm.y === y);
  for (let r = startRow; r < rowCount; r++) {
    for (let c = r === startRow ? startCol : 0; c < colCount; c++) {
      const { x, y } = gridToPixel(layoutEntry, r, c);
      if (!occupied(x, y)) return { x, y };
    }
  }
  return gridToPixel(layoutEntry, startRow, startCol); // section full — accept the overlap
}

/**
 * Same free-cell search as findFreeCellInSection, but for drag-and-drop specifically,
 * where silently placing a dropped node ON TOP of an existing one (hiding it behind
 * the dropped one) is a much worse outcome than growing the section by a row. Searches
 * forward from (startRow, startCol) first, then any earlier rows (in case a node was
 * deleted from one, leaving a gap), and only if the ENTIRE section is genuinely full
 * does it grow layoutEntry.section.rowCount by 1 and place the node in the new row's
 * first cell — mutates the section object directly (the same reference stored in
 * view.sections, since computeSectionLayout wraps rather than clones), so the growth
 * persists on the view. `excludeVmId` is normally the id of the node being dropped,
 * so it never counts as its own occupant when it's dropped back near where it started.
 */
export function findFreeCellOrGrowSection(store, viewId, layoutEntry, startRow, startCol, excludeVmId) {
  const rowCount = Math.max(1, layoutEntry.section.rowCount || 1);
  const colCount = Math.max(1, layoutEntry.section.columnCount || 1);
  const existing = store.viewMembersForView(viewId).filter((vm) => vm.objectType === 'part' && vm.id !== excludeVmId);
  const occupied = (x, y) => existing.some((vm) => vm.x === x && vm.y === y);
  for (let r = startRow; r < rowCount; r++) {
    for (let c = r === startRow ? startCol : 0; c < colCount; c++) {
      const { x, y } = gridToPixel(layoutEntry, r, c);
      if (!occupied(x, y)) return { x, y };
    }
  }
  for (let r = 0; r < startRow; r++) {
    for (let c = 0; c < colCount; c++) {
      const { x, y } = gridToPixel(layoutEntry, r, c);
      if (!occupied(x, y)) return { x, y };
    }
  }
  layoutEntry.section.rowCount = rowCount + 1;
  return gridToPixel(layoutEntry, rowCount, 0);
}

/**
 * After a section-based view's spacingScale changes, existing nodes' stored pixel
 * positions no longer align with the new (scaled) grid lines — only col-0/row-0 nodes
 * happen to stay put. Re-derive each node's row/col using the OLD scale, then its pixel
 * position using the NEW scale.
 */
/**
 * After a section-based view's spacingScale and/or nodeWidth/nodeHeight changes,
 * existing nodes' stored pixel positions no longer align with the new (rescaled) grid
 * lines. Re-derive each node's row/col using the OLD layout, then its pixel position
 * using the NEW (already-updated-on-view) layout. `oldSnapshot` should contain
 * whichever of `spacingScale`/`nodeWidth`/`nodeHeight` changed, at their PRE-change
 * values — any field omitted falls back to the view's current (post-change) value,
 * i.e. "this dimension didn't change."
 */
/**
 * Recomputes every node's pixel position after something about the section layout
 * changed, so nodes stay visually aligned with their section's boundaries instead of
 * silently drifting out of them. `oldSnapshot` describes what the layout looked like
 * BEFORE the change: either view-level overrides (spacingScale, nodeWidth, nodeHeight —
 * the original use case, spread directly onto a temporary view), or `{ sections: [...] }`
 * to replace view.sections wholesale — for when a single section's own rowCount/
 * columnCount changed rather than a view-wide setting (the caller constructs this by
 * cloning view.sections with just that one section's old values restored).
 */
export function rescaleSectionPositions(store, view, oldSnapshot) {
  const oldViewForLayout = oldSnapshot.sections ? { ...view, sections: oldSnapshot.sections } : { ...view, ...oldSnapshot };
  const oldLayout = computeSectionLayout(oldViewForLayout);
  const newLayout = computeSectionLayout(view);
  const vms = store.viewMembersForView(view.id).filter((vm) => vm.objectType === 'part' && vm.sectionId);
  for (const vm of vms) {
    const oldEntry = oldLayout.find((e) => e.section.sectionId === vm.sectionId);
    const newEntry = newLayout.find((e) => e.section.sectionId === vm.sectionId);
    if (!oldEntry || !newEntry) continue;
    const col = Math.round((vm.x - oldEntry.bodyLeft - NODE_INSET_X) / oldEntry.cellW);
    const row = Math.round((vm.y - oldEntry.bodyTop - NODE_INSET_Y) / oldEntry.cellH);
    const { x, y } = gridToPixel(newEntry, row, col);
    vm.x = x; vm.y = y;
  }
}

/** Insert a new blank section immediately after the given section instance (by its instance id). */
export function insertSectionAfter(view, afterSectionInstanceId) {
  const list = view.sections || (view.sections = []);
  const idx = list.findIndex((s) => s.id === afterSectionInstanceId);
  const insertAt = idx === -1 ? list.length : idx + 1;
  const afterOrder = idx === -1 ? (list.length ? list[list.length - 1].order : -1) : list[idx].order;
  const newSection = {
    id: newId(), sectionId: `section-${Date.now().toString().slice(-5)}`,
    viewType: view.viewType, order: afterOrder + 1,
    name: 'New Section', rowCount: 2, columnCount: 5, elementTypes: ['*'],
  };
  list.splice(insertAt, 0, newSection);
  // renumber order sequentially to keep things simple/consistent
  list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  list.forEach((s, i) => { s.order = i; });
  return newSection;
}

/**
 * Given a base string, append or increment a trailing number ("esf" -> "esf2",
 * "esf2" -> "esf3"). Used for deriving a duplicated section's sectionId/name from the
 * original. `withSpace` inserts a space before a freshly-appended "2" (for
 * human-readable names like "Enterprise Functions" -> "Enterprise Functions 2");
 * sectionIds (short codes with no spaces) pass `withSpace: false`.
 */
function nextIncrementedToken(base, withSpace) {
  const s = String(base ?? '');
  const m = s.match(/^(.*?)(\d+)$/);
  if (m) return `${m[1]}${Number(m[2]) + 1}`;
  return withSpace ? `${s} 2` : `${s}2`;
}

/**
 * Duplicate a section's DEFINITION (row/column counts, elementTypes, viewType) as a new
 * section instance immediately below the original, with sectionId/name incremented from
 * the original, and every section's order renumbered — same insert-and-renumber
 * mechanics as insertSectionAfter. Does NOT duplicate any nodes/parts/connectors placed
 * in the section; that's the caller's job (commands.js:duplicateSection), since this
 * module doesn't know about parts/connectors. Returns the new section instance, or null
 * if the given instance id doesn't match any section on this view.
 */
export function duplicateSectionDefinition(view, sectionInstanceId) {
  const list = view.sections || (view.sections = []);
  const idx = list.findIndex((s) => s.id === sectionInstanceId);
  if (idx === -1) return null;
  const original = list[idx];

  const existingSectionIds = new Set(list.map((s) => s.sectionId));
  let newSectionId = nextIncrementedToken(original.sectionId, false);
  while (existingSectionIds.has(newSectionId)) newSectionId = nextIncrementedToken(newSectionId, false);
  const newName = nextIncrementedToken(original.name, true);

  const newSection = {
    ...original,
    id: newId(),
    sectionId: newSectionId,
    name: newName,
    order: original.order + 1,
    elementTypes: [...(original.elementTypes || [])],
  };
  list.splice(idx + 1, 0, newSection);
  list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  list.forEach((s, i) => { s.order = i; });
  return newSection;
}

/** Remove a section instance and any viewMembers (nodes) placed in it, but not the underlying parts. */
export function removeSectionAndMembers(store, view, sectionInstanceId) {
  const list = view.sections || [];
  const idx = list.findIndex((s) => s.id === sectionInstanceId);
  if (idx === -1) return;
  const [removed] = list.splice(idx, 1);
  list.forEach((s, i) => { s.order = i; });
  store.doc.viewMembers = store.doc.viewMembers.filter(
    (vm) => !(ciEq(vm.view, view.id) && vm.sectionId === removed.sectionId)
  );
}
