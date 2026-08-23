// ===================== FORCE-DIRECTED LAYOUT (Remap "force" pattern) =====================
// Fruchterman-Reingold style force-directed placement: every node repels every other
// node (avoiding overlap/crowding), while nodes joined by a connector attract each other
// (pulling tightly-connected clusters close together and reducing total edge length),
// iterated with a cooling schedule so movement settles rather than oscillating forever.
// This is the standard, well-known algorithm for this class of problem — not a custom
// heuristic — trading the predictable rows/columns of the other Remap patterns for a
// layout shaped by the graph's own connectivity.
//
// Classic Fruchterman-Reingold treats nodes as dimensionless points, which can still
// leave real (rectangularly-sized) nodes overlapping at equilibrium for densely
// connected clusters — a final pairwise de-overlap pass cleans up any residual overlap
// the force simulation alone didn't fully resolve.

function hypot(dx, dy) { return Math.sqrt(dx * dx + dy * dy) || 0.01; }

/**
 * nodes: [{id, x, y, w, h}] — x/y are current top-left (used as the simulation's
 * starting point, so a re-remap of an already-reasonable layout tends to settle
 * similarly rather than jumping unpredictably); w/h are the node's own box size.
 * edges: [{from, to}] referencing node ids — connectors already filtered to only those
 * with both endpoints among `nodes` (the caller's job, same as every other Remap
 * pattern already respects "only remap filtered nodes").
 * Returns Map<id, {x, y}> of new top-left positions, normalized to start at a small
 * positive margin (matching the other patterns' own baseX/rowBaseY convention).
 */
function computeForceDirectedPositions(nodes, edges, options = {}) {
  const { iterations = 300, idealDistanceScale = 2.2, gravityStrength = 0.5 } = options;
  if (nodes.length === 0) return new Map();
  if (nodes.length === 1) return new Map([[nodes[0].id, { x: nodes[0].x, y: nodes[0].y }]]);

  const n = nodes.length;
  const avgSize = nodes.reduce((s, nd) => s + Math.max(nd.w, nd.h), 0) / n;
  const k = avgSize * idealDistanceScale; // "ideal" rest distance the simulation converges toward

  // work in CENTER coordinates internally — forces act on centers, not corners
  const cx = nodes.map((nd) => nd.x + nd.w / 2);
  const cy = nodes.map((nd) => nd.y + nd.h / 2);
  const idxOf = new Map(nodes.map((nd, i) => [nd.id, i]));

  const adjacency = nodes.map(() => new Set());
  for (const e of edges) {
    const i = idxOf.get(e.from), j = idxOf.get(e.to);
    if (i == null || j == null || i === j) continue;
    adjacency[i].add(j);
    adjacency[j].add(i);
  }

  let temperature = k * 2; // max displacement allowed per step, decaying over the run
  const coolingFactor = Math.pow(0.01, 1 / iterations); // smooth decay to ~1% of initial by the final iteration

  const dispX = new Array(n), dispY = new Array(n);
  for (let iter = 0; iter < iterations; iter++) {
    dispX.fill(0); dispY.fill(0);

    // repulsion: every pair pushes apart, strength inversely proportional to distance
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = cx[i] - cx[j], dy = cy[i] - cy[j];
        const dist = hypot(dx, dy);
        const force = (k * k) / dist;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        dispX[i] += fx; dispY[i] += fy;
        dispX[j] -= fx; dispY[j] -= fy;
      }
    }

    // attraction: connected pairs pull together, strength proportional to distance
    // (spring-like — the farther apart, the harder they're pulled back toward k)
    for (let i = 0; i < n; i++) {
      for (const j of adjacency[i]) {
        if (j <= i) continue; // each edge counted once
        const dx = cx[i] - cx[j], dy = cy[i] - cy[j];
        const dist = hypot(dx, dy);
        const force = (dist * dist) / k;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        dispX[i] -= fx; dispY[i] -= fy;
        dispX[j] += fx; dispY[j] += fy;
      }
    }

    // gravity: a mild pull toward the CURRENT centroid of the whole system, strength
    // growing linearly with distance from it. Repulsion between nodes never fully
    // reaches zero, only weakens — without something counteracting it, disconnected
    // components (e.g. two separate connected pairs with no edge between them) drift
    // apart without bound over enough iterations, since nothing is ever pulling them
    // back together. Gravity provides that counteracting pull, growing exactly where
    // repulsion is weakest (far apart), so a genuine equilibrium exists regardless of
    // how many disconnected pieces the graph has.
    //
    // gravityStrength=0.5 was picked empirically, not guessed: swept 0.03 through 2.0
    // against two competing test cases — a worst-case sparse graph (two isolated
    // connected pairs, nothing linking them) and a clustering-quality graph (two fully-
    // connected triangles, nothing linking them). Weaker values left the sparse case
    // drifting thousands of pixels apart (confirmed via a real bug report); stronger
    // values (>~0.7) started measurably distorting the WITHIN-pair spacing itself, and
    // past ~1.5 the dynamics got non-monotonic (gravity fighting local forces closely
    // enough to stop cleanly converging). At 0.5, the sparse case's between-pair
    // distance drops to roughly 3x its within-pair distance (proportionate, not
    // runaway), while the clustering test still shows connected clusters ending up
    // ~3.5x closer than unconnected ones — clearly, visibly working, just no longer at
    // the more dramatic ~20x separation seen with gravity off entirely.
    let centroidX = 0, centroidY = 0;
    for (let i = 0; i < n; i++) { centroidX += cx[i]; centroidY += cy[i]; }
    centroidX /= n; centroidY /= n;
    for (let i = 0; i < n; i++) {
      dispX[i] -= (cx[i] - centroidX) * gravityStrength;
      dispY[i] -= (cy[i] - centroidY) * gravityStrength;
    }

    // apply displacement, capped by the current temperature so no single step is wild
    for (let i = 0; i < n; i++) {
      const len = hypot(dispX[i], dispY[i]);
      const capped = Math.min(len, temperature);
      cx[i] += (dispX[i] / len) * capped;
      cy[i] += (dispY[i] / len) * capped;
    }
    temperature *= coolingFactor;
  }

  resolveResidualOverlaps(nodes, cx, cy);

  // back to top-left, normalized to a small positive margin
  let minX = Infinity, minY = Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, cx[i] - nodes[i].w / 2);
    minY = Math.min(minY, cy[i] - nodes[i].h / 2);
  }
  const marginX = 60, marginY = 40;
  const result = new Map();
  for (let i = 0; i < n; i++) {
    result.set(nodes[i].id, {
      x: cx[i] - nodes[i].w / 2 - minX + marginX,
      y: cy[i] - nodes[i].h / 2 - minY + marginY,
    });
  }
  return result;
}

/** Mutates cx/cy in place, nudging apart any pair of node rectangles that still overlap
 * after the main simulation — classic Fruchterman-Reingold treats nodes as dimensionless
 * points, so real (sized) rectangles can still end up overlapping at equilibrium for
 * tightly clustered subgraphs. Pushes along whichever axis has the smaller overlap
 * (cheaper separation), capped at a modest iteration count since this is a cleanup pass,
 * not the main layout driver. */
function resolveResidualOverlaps(nodes, cx, cy, maxPasses = 40) {
  const n = nodes.length;
  for (let pass = 0; pass < maxPasses; pass++) {
    let anyOverlap = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ax = cx[i] - nodes[i].w / 2, ay = cy[i] - nodes[i].h / 2;
        const bx = cx[j] - nodes[j].w / 2, by = cy[j] - nodes[j].h / 2;
        const overlapX = Math.min(ax + nodes[i].w, bx + nodes[j].w) - Math.max(ax, bx);
        const overlapY = Math.min(ay + nodes[i].h, by + nodes[j].h) - Math.max(ay, by);
        if (overlapX > 0 && overlapY > 0) {
          anyOverlap = true;
          if (overlapX < overlapY) {
            const push = overlapX / 2 + 2;
            if (cx[i] < cx[j]) { cx[i] -= push; cx[j] += push; } else { cx[i] += push; cx[j] -= push; }
          } else {
            const push = overlapY / 2 + 2;
            if (cy[i] < cy[j]) { cy[i] -= push; cy[j] += push; } else { cy[i] += push; cy[j] -= push; }
          }
        }
      }
    }
    if (!anyOverlap) break;
  }
}

export { computeForceDirectedPositions };

// ===================== CLUSTER-AWARE GRID PACKING =====================
// The fix for a real bug report (round 2): even with gravity, a continuous force
// simulation across the WHOLE graph left genuinely disconnected components at an
// unpredictable, sometimes off-screen-scale distance apart — gravity only dampened the
// drift, it didn't bound it. And even switching to independent per-component force
// simulation (round 1 of the fix) still wasn't tight enough within a single connected
// pair, since a continuous physics equilibrium doesn't necessarily correspond to exactly
// one grid cell of separation once rounded. This layer replaces the continuous-physics
// approach entirely for cluster-internal layout: each connected component is placed via
// direct BFS adjacent-cell placement (computeAdjacentGridLayout, below) — no physics, no
// snapping afterward, guaranteed spanning-tree adjacency by construction — then the
// components are packed into adjacent, guaranteed-non-overlapping grid regions,
// shelf-style (left to right, filling a row, wrapping to a new row once too wide).

/** Union-Find over `edges` restricted to `nodeIds` — returns an array of node-id arrays,
 * one per connected component. An isolated node (no edges to any other node in the set)
 * forms its own single-node component. */
function findConnectedComponents(nodeIds, edges) {
  const parent = new Map(nodeIds.map((id) => [id, id]));
  function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
  for (const e of edges) {
    if (parent.has(e.from) && parent.has(e.to)) union(e.from, e.to);
  }
  const groups = new Map();
  for (const id of nodeIds) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return [...groups.values()];
}

/** Shared cell-occupancy/placement bookkeeping used by BOTH computeAdjacentGridLayout
 * (below) and computeHubClusterLayout (further below) — factored out because both need
 * the IDENTICAL "place near this cell, searching the 8 immediate neighbors then
 * expanding rings outward if all 8 are taken" mechanic; keeping one copy means the two
 * layouts can never silently drift apart in how they pack a crowded hub's neighbors.
 * preferRightPlacement: tries East first (then a right-biased ring of neighbors)
 * instead of North first, so a newly-placed node lands to the RIGHT of its anchor
 * whenever that cell is free, rather than above/below it. */
function makeRingPlacer(preferRightPlacement) {
  const grid = new Map();
  const occupied = new Set();
  const cellKey = (c, r) => `${c},${r}`;
  const EIGHT_NEIGHBORS = preferRightPlacement
    ? [[1, 0], [1, -1], [1, 1], [0, -1], [0, 1], [-1, 0], [-1, -1], [-1, 1]] // E,NE,SE,N,S,W,NW,SW — East tried first
    : [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]; // N,NE,E,SE,S,SW,W,NW — original order

  function place(id, col, row) { grid.set(id, { col, row }); occupied.add(cellKey(col, row)); }

  function placeNear(id, nearCol, nearRow) {
    for (const [dc, dr] of EIGHT_NEIGHBORS) {
      const c = nearCol + dc, r = nearRow + dr;
      if (!occupied.has(cellKey(c, r))) { place(id, c, r); return; }
    }
    // all 8 immediate neighbors already taken (a hub with more than 8 connections, or a
    // crowded region) — expand outward in rings for the nearest free cell instead
    for (let radius = 2; radius < 200; radius++) {
      for (let dc = -radius; dc <= radius; dc++) {
        for (let dr = -radius; dr <= radius; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
          const c = nearCol + dc, r = nearRow + dr;
          if (!occupied.has(cellKey(c, r))) { place(id, c, r); return; }
        }
      }
    }
  }

  /** row is fixed by the caller (e.g. BFS depth — a "group" = one hop further from the
   * root), so siblings discovered via different parents at the same depth still land on
   * the same row instead of scattering — only column is searched. */
  function placeAtRow(id, row, nearCol) {
    if (!occupied.has(cellKey(nearCol, row))) { place(id, nearCol, row); return; }
    for (let dist = 1; dist < 1000; dist++) {
      for (const c of [nearCol + dist, nearCol - dist]) {
        if (!occupied.has(cellKey(c, row))) { place(id, c, row); return; }
      }
    }
  }

  return { grid, place, placeNear, placeAtRow };
}

/** Bounds of every {col,row} in `grid` — the shape packClustersOnGrid expects
 * alongside each cluster's own grid: { minCol, maxCol, minRow, maxRow }. */
function gridBounds(grid) {
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (const { col, row } of grid.values()) {
    minCol = Math.min(minCol, col); maxCol = Math.max(maxCol, col);
    minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row);
  }
  return { minCol, maxCol, minRow, maxRow };
}

/**
 * Direct discrete grid placement via BFS — guarantees any edge that's part of the BFS
 * spanning tree (the edge that first discovers a node) places its two endpoints in truly
 * ADJACENT cells (one of the 8 immediate neighbors: N/NE/E/SE/S/SW/W/NW), not just
 * "close" after some continuous simulation settles. Starts from the highest-degree node
 * (a natural hub gets central placement) and expands outward, placing each newly
 * discovered neighbor in the nearest free cell touching its parent.
 *
 * Honest limitation, inherent to ANY 2D grid embedding, not an implementation gap: a
 * "back edge" — a connection that ISN'T part of the spanning tree, e.g. the third edge
 * of a fully-connected triangle, where two of the three edges already used up the
 * tree-parent's adjacent slots — can't always land its endpoints in adjacent cells
 * either. No 2D grid can guarantee every edge of an arbitrary graph is between
 * neighboring cells (a 5-node complete graph, for instance, provably cannot be drawn
 * that way at all) — tree edges get the guarantee; cycles get the closest achievable
 * placement given what's already been placed.
 *
 * Two independent options change the placement strategy:
 *   - preferRightPlacement: see makeRingPlacer, above.
 *   - onlyNewRowForNewGroup: instead of the free-form 8-neighbor search, a node's row
 *     is determined purely by its BFS depth (root = row 0, its direct neighbors = row
 *     1, their neighbors = row 2, ...) — so nodes only move to a new row when they're
 *     actually a new "hop" further from the root, not just because the immediately
 *     adjacent cells happened to be taken. Column position within that row is still
 *     found by searching outward from the parent's column for the nearest free slot.
 *     This produces a level-by-level tree layout rather than a free-form cluster shape.
 *
 * nodeIds: array of ids. edges: [{from,to}], already restricted to this one connected
 * component. Returns { grid: Map<id,{col,row}>, minCol, maxCol, minRow, maxRow }.
 */
function computeAdjacentGridLayout(nodeIds, edges, options = {}) {
  const { preferRightPlacement = false, onlyNewRowForNewGroup = false } = options;
  const adjacency = new Map(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (!adjacency.has(e.from) || !adjacency.has(e.to) || e.from === e.to) continue;
    adjacency.get(e.from).push(e.to);
    adjacency.get(e.to).push(e.from);
  }

  let root = nodeIds[0], maxDegree = -1;
  for (const id of nodeIds) {
    const deg = adjacency.get(id).length;
    if (deg > maxDegree) { maxDegree = deg; root = id; }
  }

  const { grid, place, placeNear, placeAtRow } = makeRingPlacer(preferRightPlacement);
  place(root, 0, 0);
  const visited = new Set([root]);
  const queue = [{ id: root, depth: 0 }];
  while (queue.length) {
    const { id: cur, depth } = queue.shift();
    const curPos = grid.get(cur);
    for (const neighbor of adjacency.get(cur)) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      if (onlyNewRowForNewGroup) placeAtRow(neighbor, depth + 1, curPos.col);
      else placeNear(neighbor, curPos.col, curPos.row);
      queue.push({ id: neighbor, depth: depth + 1 });
    }
  }

  return { grid, ...gridBounds(grid) };
}

/** Shelf-packs clusters (each already snapped to its own local grid) into ONE combined
 * grid where no two clusters' cells ever overlap — filling a "shelf" left to right up
 * to maxShelfWidthCells, then wrapping to a new shelf below. Returns Map<id, {col,row}>
 * — the FINAL absolute grid position for every node across every cluster.
 *
 * Packing ORDER, reported directly as a follow-up to Remap's "clusters" pattern
 * ("is it possible to ... avoid placing nodes directly on unrelated connectors after
 * 'centralize in clusters' is applied?"): the largest cluster goes first (a reasonable
 * default with no other signal to go on), then greedily, whichever NOT-YET-PLACED
 * cluster shares the most cross-cluster edges (`edges` — e.g. "clusters"' own bridge
 * edges, see computeHubClusterDecomposition) with whatever's ALREADY placed goes next,
 * tie-broken by area — so two clusters connected to each other end up shelf-adjacent
 * (or close to it) instead of scattered by size alone, which is what was making a
 * bridge edge likely to stretch diagonally across unrelated territory in the first
 * place. `edges` is optional and, for 'force' (whole connected COMPONENTS as clusters
 * — no edge ever crosses between two components, by definition), always contributes
 * zero cross-cluster weight, so passing it there is a harmless no-op: packing falls
 * straight back to the original pure-area order, unchanged from before this feature. */
function packClustersOnGrid(clusters, maxShelfWidthCells, edges = []) {
  const areaOf = (c) => (c.maxCol - c.minCol + 1) * (c.maxRow - c.minRow + 1);

  const clusterOfNode = new Map();
  clusters.forEach((c, i) => { for (const id of c.grid.keys()) clusterOfNode.set(id, i); });
  const bridgeWeight = clusters.map(() => new Map());
  for (const e of edges) {
    const ci = clusterOfNode.get(e.from), cj = clusterOfNode.get(e.to);
    if (ci == null || cj == null || ci === cj) continue; // same-cluster edge -- not a bridge
    bridgeWeight[ci].set(cj, (bridgeWeight[ci].get(cj) || 0) + 1);
    bridgeWeight[cj].set(ci, (bridgeWeight[cj].get(ci) || 0) + 1);
  }

  const remaining = new Set(clusters.map((_, i) => i));
  const order = [];
  while (remaining.size) {
    let pick = null, bestWeight = 0, bestArea = -1;
    for (const i of remaining) {
      let w = 0;
      for (const j of order) w += bridgeWeight[i].get(j) || 0;
      const a = areaOf(clusters[i]);
      if (w > bestWeight || (w === bestWeight && w > 0 && a > bestArea)) { pick = i; bestWeight = w; bestArea = a; }
    }
    if (pick === null) {
      // nothing already placed shares a bridge edge with anything still remaining (the
      // very first pick, or the start of a new, unconnected group of clusters) -- fall
      // back to largest-remaining, the same tie-break the original area-only order used.
      let fallbackArea = -1;
      for (const i of remaining) { const a = areaOf(clusters[i]); if (a > fallbackArea) { fallbackArea = a; pick = i; } }
    }
    order.push(pick);
    remaining.delete(pick);
  }
  const sorted = order.map((i) => clusters[i]);

  const final = new Map();
  let shelfCol = 0, shelfRow = 0, shelfHeight = 0;
  for (const cluster of sorted) {
    const w = cluster.maxCol - cluster.minCol + 1;
    const h = cluster.maxRow - cluster.minRow + 1;
    if (shelfCol > 0 && shelfCol + w > maxShelfWidthCells) {
      shelfCol = 0;
      shelfRow += shelfHeight + 1; // +1 cell gap between shelves
      shelfHeight = 0;
    }
    const originCol = shelfCol - cluster.minCol;
    const originRow = shelfRow - cluster.minRow;
    for (const [id, pos] of cluster.grid) {
      final.set(id, { col: pos.col + originCol, row: pos.row + originRow });
    }
    shelfCol += w + 1; // +1 cell gap between clusters on the same shelf
    shelfHeight = Math.max(shelfHeight, h);
  }
  return final;
}

/**
 * Full pipeline for Remap's "force" pattern: partition into connected components, lay
 * out each one independently via direct BFS adjacent-cell placement (guaranteeing
 * spanning-tree edges land in truly neighboring grid cells — no continuous simulation,
 * no snapping afterward, and no cross-component interaction at all, since disconnected
 * components have no reason to affect each other's placement), then pack the components
 * into adjacent non-overlapping grid regions.
 * nodes: [{id, x, y, w, h}], edges: [{from, to}].
 * Returns Map<id, {x, y}> — final pixel top-left positions, normalized to a small
 * positive margin.
 */
function computeClusteredGridLayout(nodes, edges, options = {}) {
  const { stepX, stepY, maxShelfWidthCells = 12, marginX = 60, marginY = 40 } = options;
  const nodeIds = nodes.map((nd) => nd.id);
  const components = findConnectedComponents(nodeIds, edges);

  const clusters = [];
  for (const comp of components) {
    const compSet = new Set(comp);
    const compEdges = edges.filter((e) => compSet.has(e.from) && compSet.has(e.to));
    clusters.push(computeAdjacentGridLayout(comp, compEdges, options));
  }

  const finalGrid = packClustersOnGrid(clusters, maxShelfWidthCells, edges);
  const result = new Map();
  for (const id of nodeIds) {
    const g = finalGrid.get(id);
    result.set(id, { x: marginX + g.col * stepX, y: marginY + g.row * stepY });
  }
  return result;
}

// ===================== HUB-AND-SPOKE CLUSTERING (Remap "clusters" pattern) =====================
// Reported directly: "need a better remap for erd that puts popular nodes central to
// single children around them, repeat this pattern in clusters. perhaps a 'centralize
// in clusters' option that could work on any view." computeAdjacentGridLayout (above)
// already centers the single highest-degree node of an ENTIRE connected component — a
// real ERD schema is often one giant connected component (everything FKs to everything
// transitively), so that gives exactly one hub for the whole diagram. This decomposes
// one component into SEVERAL hub-and-leaves stars instead, then tiles them together the
// same way computeClusteredGridLayout tiles separate connected components (reusing
// packClustersOnGrid unchanged — a hub-cluster here and a connected-component cluster
// there are the same shape as far as shelf-packing cares).

/** Greedy hub/ring decomposition, pure graph logic (no coordinates) — exported
 * separately from the pixel-producing pipeline below so it's directly unit-testable.
 * nodeIds: array of ids. edges: [{from,to}] (already restricted to whatever scope the
 * caller wants laid out — a whole view's worth, same as every other Remap pattern).
 * Returns [{ hub: id, ring: [id, ...] }, ...] — every node in nodeIds appears in
 * EXACTLY one cluster, either as its hub or a ring member.
 *
 * Algorithm: a node's "primary hub" is whichever of its neighbors has strictly higher
 * degree than the node's own (ties among equally-connected neighbors broken by nodeIds'
 * own order, for determinism) — a node with no such neighbor (it's a local degree
 * maximum, or isolated) has no primary hub and must become a hub itself. Every node
 * with degree >= 2 is a hub CANDIDATE; processed highest-degree-first, a candidate
 * becomes a real hub unless it was already claimed as some earlier (bigger-or-equal
 * degree) hub's ring member, and then absorbs every still-unclaimed node whose primary
 * hub it is. This directly implements "popular nodes central, single children around
 * them" for true leaves (degree 1, whose only neighbor IS their primary hub by
 * construction) while ALSO pulling in a lower-degree non-leaf if most of ITS
 * connections point at one clearly-more-connected hub (a node with a strictly-higher-
 * degree primary hub joins that hub's ring rather than becoming its own hub, even if
 * its own degree is 2+) — degree-2 nodes that straddle two hubs of equal standing (no
 * neighbor outranks the other) become their own hub instead of arbitrarily picking a
 * side. Any node still unclaimed after that pass (an isolated node, or an isolated
 * pair/chain where no node ever reaches degree 2) becomes its own small hub, absorbing
 * whatever of ITS neighbors are still unclaimed too — so every node ends up placed. */
function computeHubClusterDecomposition(nodeIds, edges) {
  const adjacency = new Map(nodeIds.map((id) => [id, new Set()]));
  for (const e of edges) {
    if (!adjacency.has(e.from) || !adjacency.has(e.to) || e.from === e.to) continue;
    adjacency.get(e.from).add(e.to);
    adjacency.get(e.to).add(e.from);
  }
  const degree = new Map(nodeIds.map((id) => [id, adjacency.get(id).size]));
  const nodeIndex = new Map(nodeIds.map((id, i) => [id, i]));

  const primaryHub = new Map();
  for (const id of nodeIds) {
    const ownDegree = degree.get(id);
    let best = null;
    for (const nb of adjacency.get(id)) {
      const d = degree.get(nb);
      if (d <= ownDegree) continue; // only a STRICTLY more-connected neighbor counts as "this node's hub"
      if (best === null || d > degree.get(best) || (d === degree.get(best) && nodeIndex.get(nb) < nodeIndex.get(best))) best = nb;
    }
    primaryHub.set(id, best);
  }

  const unassigned = new Set(nodeIds);
  const clusters = [];
  const hubCandidates = nodeIds
    .filter((id) => degree.get(id) >= 2)
    .sort((a, b) => degree.get(b) - degree.get(a) || nodeIndex.get(a) - nodeIndex.get(b));

  for (const hub of hubCandidates) {
    if (!unassigned.has(hub)) continue; // already absorbed into an earlier, more-connected hub's ring
    unassigned.delete(hub);
    const ring = [];
    for (const id of nodeIds) {
      if (unassigned.has(id) && primaryHub.get(id) === hub) { ring.push(id); unassigned.delete(id); }
    }
    clusters.push({ hub, ring });
  }

  // leftovers: isolated nodes, or isolated pairs/chains where no node ever reached
  // degree 2 (so neither side was ever a hub candidate above) — each remaining node
  // becomes its own hub, absorbing whatever of its own neighbors are still unclaimed.
  for (const id of nodeIds) {
    if (!unassigned.has(id)) continue;
    unassigned.delete(id);
    const ring = [];
    for (const nb of adjacency.get(id)) {
      if (unassigned.has(nb)) { ring.push(nb); unassigned.delete(nb); }
    }
    clusters.push({ hub: id, ring });
  }

  return clusters;
}

/**
 * Full pipeline for Remap's "clusters" pattern (mirrors computeClusteredGridLayout's
 * shape exactly, just with computeHubClusterDecomposition + a one-level ring placement
 * standing in for findConnectedComponents + computeAdjacentGridLayout): decompose the
 * whole graph into hub-and-ring stars, place each star's ring in the 8 cells around its
 * hub (expanding outward past 8, same as computeAdjacentGridLayout's own crowded-hub
 * fallback), shelf-pack the stars together (packClustersOnGrid, now itself connectivity-
 * aware — see its own doc comment — so bridge-connected clusters land shelf-close
 * instead of scattered by size alone), then run avoidNodeOnConnectorOverlap (below) to
 * relocate any ring member a bridge edge still ends up cutting straight through. A ring
 * member's OTHER edges (to a different hub than this one, if it has any — a node
 * absorbed here can still have further connections elsewhere) and any hub-to-hub edge
 * become cross-cluster "bridge" edges that, like a back edge in computeAdjacentGridLayout,
 * aren't GUARANTEED adjacent cells — the same inherent 2D-embedding limitation, just
 * reached by a different route; the two passes above reduce how often it's visually a
 * problem, they don't (and can't, in general) eliminate it.
 * nodes: [{id, x, y, w, h}], edges: [{from, to}].
 * Returns Map<id, {x, y}> — final pixel top-left positions, normalized to a small
 * positive margin.
 */
function computeHubClusterGridLayout(nodes, edges, options = {}) {
  const { stepX, stepY, maxShelfWidthCells = 12, marginX = 60, marginY = 40, preferRightPlacement = false } = options;
  const nodeIds = nodes.map((nd) => nd.id);
  const decomposition = computeHubClusterDecomposition(nodeIds, edges);

  const clusters = decomposition.map(({ hub, ring }) => {
    const { grid, place, placeNear } = makeRingPlacer(preferRightPlacement);
    place(hub, 0, 0);
    for (const id of ring) placeNear(id, 0, 0);
    return { grid, ...gridBounds(grid) };
  });

  const finalGrid = packClustersOnGrid(clusters, maxShelfWidthCells, edges);

  const nodeSizes = new Map(nodes.map((nd) => [nd.id, { w: nd.w, h: nd.h }]));
  const ringMemberToHub = new Map();
  for (const { hub, ring } of decomposition) for (const id of ring) ringMemberToHub.set(id, hub);
  avoidNodeOnConnectorOverlap(finalGrid, nodeSizes, ringMemberToHub, edges, stepX, stepY);

  const result = new Map();
  for (const id of nodeIds) {
    const g = finalGrid.get(id);
    result.set(id, { x: marginX + g.col * stepX, y: marginY + g.row * stepY });
  }
  return result;
}

// ===================== NODE-ON-CONNECTOR OVERLAP AVOIDANCE (Remap "clusters" pattern) ====
// Follow-up reported directly: "is it possible to add the existing 'minimize connector
// crossing' or something similar, to avoid placing nodes directly on unrelated
// connectors after 'centralize in clusters' is applied?" The existing minimizeCrossings/
// minimizeConnectorLength options (commands.js) are Sugiyama row-reordering passes with
// no meaning on a 2D grid-packed cluster layout, so this is a genuinely different kind
// of pass, specific to 'clusters': a bridge edge (the only kind of edge in this pattern
// long/diagonal enough to reach past its own two endpoints at all — every within-cluster
// ring edge spans exactly one grid cell, too short to touch a third node) can end up
// drawn straight across a completely unrelated ring member once clusters are shelf-
// packed near each other. packClustersOnGrid's own connectivity-aware ordering (above)
// already reduces how often this happens; this pass catches what's left.

/** Cross product of 2D vectors (ax,ay) and (bx,by) — sign indicates turn direction,
 * used by segmentsIntersect below. */
function cross2D(ax, ay, bx, by) { return ax * by - ay * bx; }

/** True if segment (ax1,ay1)-(ax2,ay2) properly crosses segment (bx1,by1)-(bx2,by2).
 * Collinear/touching-endpoint cases deliberately return false — this is a "does a
 * connector visually cut through a node" heuristic, not exact computational geometry;
 * a hairline touch at an endpoint isn't the defect being avoided. */
function segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
  const d1 = cross2D(bx2 - bx1, by2 - by1, ax1 - bx1, ay1 - by1);
  const d2 = cross2D(bx2 - bx1, by2 - by1, ax2 - bx1, ay2 - by1);
  const d3 = cross2D(ax2 - ax1, ay2 - ay1, bx1 - ax1, by1 - ay1);
  const d4 = cross2D(ax2 - ax1, ay2 - ay1, bx2 - ax1, by2 - ay1);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True if segment (x1,y1)-(x2,y2) passes through rectangle (rx,ry,rw,rh) — either
 * endpoint lands inside it, or the segment crosses one of its 4 edges. */
function segmentIntersectsRect(x1, y1, x2, y2, rx, ry, rw, rh) {
  if (x1 >= rx && x1 <= rx + rw && y1 >= ry && y1 <= ry + rh) return true;
  if (x2 >= rx && x2 <= rx + rw && y2 >= ry && y2 <= ry + rh) return true;
  const corners = [[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]];
  for (let i = 0; i < 4; i++) {
    const [cx1, cy1] = corners[i], [cx2, cy2] = corners[(i + 1) % 4];
    if (segmentsIntersect(x1, y1, x2, y2, cx1, cy1, cx2, cy2)) return true;
  }
  return false;
}

const EIGHT_NEIGHBOR_OFFSETS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/** Best-effort cleanup pass, mutating `finalGrid` in place: relocates a node found
 * sitting in the straight-line path of a connector it isn't even an endpoint of.
 *
 * Deliberately conservative about WHAT it's allowed to move, so it can never undo any
 * of computeHubClusterGridLayout's own placement guarantees: only a RING MEMBER (never
 * a hub — moving a hub would cascade and disturb its entire ring) is ever eligible, and
 * only to a still-free cell among its OWN hub's 8 immediate neighbor cells (never
 * farther) — so a relocated node is always exactly as hub-adjacent afterward as before,
 * just possibly a different one of the (up to) 8 equally-valid slots around its hub. A
 * bystander with no free alternative slot, or a HUB itself sitting in an unrelated
 * edge's path, is left exactly where it was — a heuristic best-effort pass, not a
 * guaranteed-collision-free solver, the same honest-limitation category as `'force'`'s
 * own unplaceable cycle edges.
 *
 * finalGrid: Map<id,{col,row}>. nodeSizes: Map<id,{w,h}>. ringMemberToHub: Map<id,
 * hubId> (every ring member's own hub id — hubs and any unclaimed node are absent, so
 * they're never touched). edges: [{from,to}]. stepX/stepY: pixel cell size. Runs up to
 * `maxPasses` full scans, since relocating one node can occasionally free up (or
 * create) a different collision elsewhere; stops as soon as a scan moves nothing. */
function avoidNodeOnConnectorOverlap(finalGrid, nodeSizes, ringMemberToHub, edges, stepX, stepY, maxPasses = 3) {
  const cellKey = (c, r) => `${c},${r}`;
  const PAD = 6; // small slack so a near-miss still counts as a visual overlap worth avoiding
  const rectOf = (id) => {
    const g = finalGrid.get(id), size = nodeSizes.get(id);
    if (!g || !size) return null;
    return { x: g.col * stepX, y: g.row * stepY, w: size.w, h: size.h };
  };
  const centerOf = (id) => { const r = rectOf(id); return r && { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };

  for (let pass = 0; pass < maxPasses; pass++) {
    let movedAny = false;
    const occupied = new Set([...finalGrid.values()].map((p) => cellKey(p.col, p.row)));

    for (const e of edges) {
      if (e.from === e.to) continue;
      const a = centerOf(e.from), b = centerOf(e.to);
      if (!a || !b) continue;

      for (const [id] of finalGrid) {
        if (id === e.from || id === e.to) continue;
        const hubId = ringMemberToHub.get(id);
        if (!hubId) continue; // only ring members are ever eligible to move -- never a hub
        const rect = rectOf(id);
        if (!rect || !segmentIntersectsRect(a.x, a.y, b.x, b.y, rect.x - PAD, rect.y - PAD, rect.w + 2 * PAD, rect.h + 2 * PAD)) continue;

        const hubPos = finalGrid.get(hubId);
        const curPos = finalGrid.get(id);
        if (!hubPos || !curPos) continue;
        occupied.delete(cellKey(curPos.col, curPos.row)); // this node's own current cell is free to reclaim
        const size = nodeSizes.get(id);
        let relocated = false;
        for (const [dc, dr] of EIGHT_NEIGHBOR_OFFSETS) {
          const c = hubPos.col + dc, r = hubPos.row + dr;
          if (occupied.has(cellKey(c, r))) continue;
          const candX = c * stepX, candY = r * stepY;
          if (segmentIntersectsRect(a.x, a.y, b.x, b.y, candX - PAD, candY - PAD, size.w + 2 * PAD, size.h + 2 * PAD)) continue;
          finalGrid.set(id, { col: c, row: r });
          occupied.add(cellKey(c, r));
          relocated = true; movedAny = true;
          break;
        }
        if (!relocated) occupied.add(cellKey(curPos.col, curPos.row)); // no safe alternative found -- leave it where it was
      }
    }
    if (!movedAny) break;
  }
}

export { findConnectedComponents, computeClusteredGridLayout, computeHubClusterDecomposition, computeHubClusterGridLayout, avoidNodeOnConnectorOverlap };
