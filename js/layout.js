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
 *   - preferRightPlacement: tries East first (then a right-biased ring of neighbors)
 *     instead of North first, so a newly-discovered node lands to the RIGHT of its
 *     parent whenever that cell is free, rather than above/below it.
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

  const grid = new Map();
  const occupied = new Set();
  const cellKey = (c, r) => `${c},${r}`;
  const EIGHT_NEIGHBORS = preferRightPlacement
    ? [[1, 0], [1, -1], [1, 1], [0, -1], [0, 1], [-1, 0], [-1, -1], [-1, 1]] // E,NE,SE,N,S,W,NW,SW — East tried first
    : [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]; // N,NE,E,SE,S,SW,W,NW — original order

  function placeNear(id, nearCol, nearRow) {
    for (const [dc, dr] of EIGHT_NEIGHBORS) {
      const c = nearCol + dc, r = nearRow + dr;
      if (!occupied.has(cellKey(c, r))) { grid.set(id, { col: c, row: r }); occupied.add(cellKey(c, r)); return; }
    }
    // all 8 immediate neighbors already taken (a hub with more than 8 connections, or a
    // crowded region) — expand outward in rings for the nearest free cell instead
    for (let radius = 2; radius < 200; radius++) {
      for (let dc = -radius; dc <= radius; dc++) {
        for (let dr = -radius; dr <= radius; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
          const c = nearCol + dc, r = nearRow + dr;
          if (!occupied.has(cellKey(c, r))) { grid.set(id, { col: c, row: r }); occupied.add(cellKey(c, r)); return; }
        }
      }
    }
  }

  /** onlyNewRowForNewGroup mode: row is fixed by BFS depth (a "group" = one hop further
   * from the root), so siblings discovered via different parents at the same depth
   * still land on the same row instead of scattering — only column is searched. */
  function placeAtRow(id, row, nearCol) {
    if (!occupied.has(cellKey(nearCol, row))) { grid.set(id, { col: nearCol, row }); occupied.add(cellKey(nearCol, row)); return; }
    for (let dist = 1; dist < 1000; dist++) {
      for (const c of [nearCol + dist, nearCol - dist]) {
        if (!occupied.has(cellKey(c, row))) { grid.set(id, { col: c, row }); occupied.add(cellKey(c, row)); return; }
      }
    }
  }

  grid.set(root, { col: 0, row: 0 });
  occupied.add(cellKey(0, 0));
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

  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (const { col, row } of grid.values()) {
    minCol = Math.min(minCol, col); maxCol = Math.max(maxCol, col);
    minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row);
  }
  return { grid, minCol, maxCol, minRow, maxRow };
}

/** Shelf-packs clusters (each already snapped to its own local grid) into ONE combined
 * grid where no two clusters' cells ever overlap — largest cluster first, filling a
 * "shelf" left to right up to maxShelfWidthCells, then wrapping to a new shelf below.
 * Returns Map<id, {col,row}> — the FINAL absolute grid position for every node across
 * every cluster. */
function packClustersOnGrid(clusters, maxShelfWidthCells) {
  const sorted = [...clusters].sort((a, b) => {
    const areaA = (a.maxCol - a.minCol + 1) * (a.maxRow - a.minRow + 1);
    const areaB = (b.maxCol - b.minCol + 1) * (b.maxRow - b.minRow + 1);
    return areaB - areaA;
  });

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

  const finalGrid = packClustersOnGrid(clusters, maxShelfWidthCells);
  const result = new Map();
  for (const id of nodeIds) {
    const g = finalGrid.get(id);
    result.set(id, { x: marginX + g.col * stepX, y: marginY + g.row * stepY });
  }
  return result;
}

export { findConnectedComponents, computeClusteredGridLayout };
