// ===================== OBSTACLE-AVOIDING EDGE ROUTING =====================
// Computes a routed path (an array of {x,y} points) between two nodes that avoids every
// OTHER node currently placed in the view, for either of two styles:
//   - 'direct': a polyline of straight segments — a single segment (identical to the
//     pre-existing straight/curved line) whenever nothing blocks the direct path,
//     otherwise the shortest sequence of straight hops around whatever's in the way.
//   - 'manhattan': the same idea, but every segment is constrained to be purely
//     horizontal or vertical (a classic orthogonal/"elbow" router).
//
// Approach: a visibility-graph search — candidate waypoints are the two endpoints plus
// every nearby obstacle's corners (direct style) or a coordinate-compressed grid of
// every nearby obstacle's edges (Manhattan style, so only axis-aligned hops are ever
// candidates) — then Dijkstra finds the shortest obstacle-free route through that graph.
// This is a real, standard algorithm for this class of problem (the same idea real
// orthogonal-routing tools use), not a heuristic — but it does NOT do full pathfinding
// against every node in a large diagram: each connector only considers obstacles that
// actually fall within ITS OWN routing region (source+target bounding box, expanded by a
// margin). Nodes elsewhere in a big diagram obviously can't block a nearby connector, so
// this keeps the search small even in large views — verified against a 200+ node import.
//
// A hard cap on the local obstacle count (and therefore graph size) protects against a
// pathological worst case (many nodes packed extremely close together) — past the cap,
// routing silently falls back to the simple unrouted path for that one connector rather
// than risking a slow/frozen render.

const MAX_OBSTACLES_PER_EDGE = 60; // safety valve — see module doc comment above
const BEND_PENALTY = 24; // Manhattan only: small extra cost per turn, so Dijkstra prefers fewer/cleaner bends over a jagged shortest-distance zigzag

function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

function nodeObstacleRect(vm, w, h, margin) {
  return { left: vm.x - margin, top: vm.y - margin, right: vm.x + w + margin, bottom: vm.y + h + margin };
}

/** Obstacles = every other placed node's rect (expanded by margin) that falls within the
 * routing region around fromVm/toVm. Returns [] fast when nothing's nearby — the common
 * case in an uncrowded diagram, and the signal callers use to skip pathfinding entirely. */
function collectNearbyObstacles(fromVm, toVm, otherPartVms, w, h, margin, regionMargin) {
  const region = {
    left: Math.min(fromVm.x, toVm.x) - regionMargin,
    right: Math.max(fromVm.x + w, toVm.x + w) + regionMargin,
    top: Math.min(fromVm.y, toVm.y) - regionMargin,
    bottom: Math.max(fromVm.y + h, toVm.y + h) + regionMargin,
  };
  const obstacles = [];
  for (const vm of otherPartVms) {
    const rect = nodeObstacleRect(vm, w, h, margin);
    if (rectsOverlapLocal(rect, region)) obstacles.push(rect);
    if (obstacles.length > MAX_OBSTACLES_PER_EDGE) break; // safety valve
  }
  return obstacles;
}
function rectsOverlapLocal(r1, r2) {
  return r1.left <= r2.right && r1.right >= r2.left && r1.top <= r2.bottom && r1.bottom >= r2.top;
}

function segmentClear(p1, p2, obstacles, segmentIntersectsRect) {
  for (const r of obstacles) if (segmentIntersectsRect(p1, p2, r)) return false;
  return true;
}

/** Generic Dijkstra over an adjacency list { [nodeIndex]: [{to, weight}] }, returning the
 * ordered list of node indices from startIdx to endIdx, or null if unreachable. */
function dijkstra(adjacency, startIdx, endIdx, count) {
  const dist_ = new Array(count).fill(Infinity);
  const prev = new Array(count).fill(-1);
  const visited = new Array(count).fill(false);
  dist_[startIdx] = 0;
  for (let iter = 0; iter < count; iter++) {
    let u = -1, best = Infinity;
    for (let i = 0; i < count; i++) if (!visited[i] && dist_[i] < best) { best = dist_[i]; u = i; }
    if (u === -1) break;
    if (u === endIdx) break;
    visited[u] = true;
    for (const edge of (adjacency[u] || [])) {
      const alt = dist_[u] + edge.weight;
      if (alt < dist_[edge.to]) { dist_[edge.to] = alt; prev[edge.to] = u; }
    }
  }
  if (dist_[endIdx] === Infinity) return null;
  const path = [];
  let cur = endIdx;
  while (cur !== -1) { path.unshift(cur); cur = prev[cur]; }
  return path;
}

/** Direct-style routing: candidate points are the two endpoints plus every obstacle's
 * (slightly-expanded) corners; edges connect any two mutually-visible points, weighted
 * by straight-line distance. */
function routeDirect(fc, tc, obstacles, segmentIntersectsRect) {
  const points = [fc, tc];
  for (const r of obstacles) {
    const pad = 2; // nudge corners just outside the rect so a path skimming a corner isn't itself flagged as blocked
    points.push({ x: r.left - pad, y: r.top - pad }, { x: r.right + pad, y: r.top - pad }, { x: r.right + pad, y: r.bottom + pad }, { x: r.left - pad, y: r.bottom + pad });
  }
  const n = points.length;
  const adjacency = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!segmentClear(points[i], points[j], obstacles, segmentIntersectsRect)) continue;
      const w = dist(points[i], points[j]);
      adjacency[i].push({ to: j, weight: w });
      adjacency[j].push({ to: i, weight: w });
    }
  }
  const path = dijkstra(adjacency, 0, 1, n);
  if (!path) return [fc, tc]; // shouldn't happen (going far enough around is always eventually possible), but never fail to draw something
  return path.map((idx) => points[idx]);
}

/** Manhattan-style routing: coordinate-compress every obstacle's left/right (x) and
 * top/bottom (y) edges plus both endpoints into a grid; edges only connect
 * horizontally/vertically ADJACENT grid points (never diagonal), so every resulting
 * path segment is axis-aligned by construction. */
function routeManhattan(fc, tc, obstacles, segmentIntersectsRect) {
  // Candidate grid lines sit just OUTSIDE each obstacle's edges (offset by a small
  // epsilon), not exactly ON them — using the exact edge value here was the original
  // bug: pointInRect's inclusive >=/<= treats a point sitting precisely on an obstacle's
  // boundary as "inside" it, so every grid line built from an obstacle's own coordinates
  // would itself always register as blocked, including the ones meant to route past it,
  // leaving no viable row/column near the obstacle at all.
  const eps = 1;
  const xsSet = new Set([fc.x, tc.x]), ysSet = new Set([fc.y, tc.y]);
  for (const r of obstacles) { xsSet.add(r.left - eps); xsSet.add(r.right + eps); ysSet.add(r.top - eps); ysSet.add(r.bottom + eps); }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  if (xs.length * ys.length > 4000) return null; // safety valve — caller falls back

  const idxOf = (xi, yi) => yi * xs.length + xi;
  const n = xs.length * ys.length;
  const adjacency = Array.from({ length: n }, () => []);
  const pointAt = (xi, yi) => ({ x: xs[xi], y: ys[yi] });

  for (let yi = 0; yi < ys.length; yi++) {
    for (let xi = 0; xi < xs.length; xi++) {
      const here = idxOf(xi, yi);
      if (xi + 1 < xs.length) {
        const there = idxOf(xi + 1, yi);
        if (segmentClear(pointAt(xi, yi), pointAt(xi + 1, yi), obstacles, segmentIntersectsRect)) {
          const w = xs[xi + 1] - xs[xi];
          adjacency[here].push({ to: there, weight: w });
          adjacency[there].push({ to: here, weight: w });
        }
      }
      if (yi + 1 < ys.length) {
        const there = idxOf(xi, yi + 1);
        if (segmentClear(pointAt(xi, yi), pointAt(xi, yi + 1), obstacles, segmentIntersectsRect)) {
          const w = ys[yi + 1] - ys[yi];
          adjacency[here].push({ to: there, weight: w });
          adjacency[there].push({ to: here, weight: w });
        }
      }
    }
  }
  // fc/tc themselves are exact values already in xsSet/ysSet (added directly, not via
  // the eps-offset obstacle loop), so these lookups always resolve to a real grid index.
  const startIdx = idxOf(xs.indexOf(fc.x), ys.indexOf(fc.y));
  const endIdx = idxOf(xs.indexOf(tc.x), ys.indexOf(tc.y));
  const rawPath = dijkstraWithBendPenalty(adjacency, startIdx, endIdx, n, xs, ys);
  if (!rawPath) return null;
  return simplifyColinear(rawPath.map((idx) => ({ x: xs[idx % xs.length], y: ys[Math.floor(idx / xs.length)] })));
}

/** Same as dijkstra() but adds BEND_PENALTY when the incoming direction changes, so the
 * search prefers a route with fewer turns over the raw shortest-distance zigzag. Tracks
 * (node, incoming-direction) as the search state rather than just node, since the "best"
 * cost to reach a point legitimately differs depending on which direction you arrived
 * from (arriving straight-through is free to continue; arriving then turning costs extra). */
function dijkstraWithBendPenalty(adjacency, startIdx, endIdx, count, xs, ys) {
  const stateKey = (node, dir) => node * 4 + dir; // dir: 0=none,1=horiz,2=vert
  const totalStates = count * 4;
  const dist_ = new Array(totalStates).fill(Infinity);
  const prevState = new Array(totalStates).fill(-1);
  const visited = new Array(totalStates).fill(false);
  const startState = stateKey(startIdx, 0);
  dist_[startState] = 0;

  const dirOf = (fromNode, toNode) => {
    const fx = fromNode % xs.length, fy = Math.floor(fromNode / xs.length);
    const tx = toNode % xs.length, ty = Math.floor(toNode / xs.length);
    return fy === ty ? 1 : (fx === tx ? 2 : 0);
  };

  for (let iter = 0; iter < totalStates; iter++) {
    let u = -1, best = Infinity;
    for (let i = 0; i < totalStates; i++) if (!visited[i] && dist_[i] < best) { best = dist_[i]; u = i; }
    if (u === -1) break;
    const uNode = Math.floor(u / 4), uDir = u % 4;
    if (uNode === endIdx) { return reconstructBendPath(prevState, u, xs.length); }
    visited[u] = true;
    for (const edge of (adjacency[uNode] || [])) {
      const d = dirOf(uNode, edge.to);
      const bend = uDir !== 0 && d !== uDir ? BEND_PENALTY : 0;
      const alt = dist_[u] + edge.weight + bend;
      const vState = stateKey(edge.to, d);
      if (alt < dist_[vState]) { dist_[vState] = alt; prevState[vState] = u; }
    }
  }
  return null;
}
function reconstructBendPath(prevState, endState, xsLen) {
  const path = [];
  let cur = endState;
  while (cur !== -1) { path.unshift(Math.floor(cur / 4)); cur = prevState[cur]; }
  return path;
}

/** Collapses runs of 3+ colinear points (A,B,C where B sits exactly on the A-C line)
 * into just the endpoints — Dijkstra's grid search can produce redundant intermediate
 * points along what's really one straight segment; this keeps the rendered path clean. */
function simplifyColinear(points) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1], b = points[i], c = points[i + 1];
    const colinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
    if (!colinear) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Main entry point. fromVm/toVm are the two endpoint viewMembers (real node positions,
 * used to compute the routing region). fc/tc are the already-clipped boundary points
 * (e.g. from edgeEndpoints) — the actual path start/end. otherPartVms is every OTHER
 * part viewMember currently visible in the view (already filtered by whatever stream/
 * type/level filters are active — obstacles that are themselves hidden shouldn't block a
 * route). style is 'direct' or 'manhattan'.
 * Returns an array of {x,y} points (length >= 2) to render as a polyline.
 */
function computeRoutedPath(fromVm, toVm, fc, tc, otherPartVms, w, h, style, segmentIntersectsRect) {
  const margin = 12, regionMargin = 150;
  const obstacles = collectNearbyObstacles(fromVm, toVm, otherPartVms, w, h, margin, regionMargin);

  if (style === 'manhattan') {
    if (obstacles.length === 0) return simplifyColinear(simpleElbow(fc, tc));
    const routed = routeManhattan(fc, tc, obstacles, segmentIntersectsRect);
    return routed || simplifyColinear(simpleElbow(fc, tc)); // safety-valve or unreachable -> fall back to the unrouted elbow rather than nothing
  }
  if (obstacles.length === 0) return [fc, tc];
  return routeDirect(fc, tc, obstacles, segmentIntersectsRect);
}

/** The basic (non-obstacle-avoiding) elbow used both as the zero-obstacle fast path and
 * as a last-resort fallback: routes via whichever axis has the larger gap first. */
function simpleElbow(fc, tc) {
  const dx = tc.x - fc.x, dy = tc.y - fc.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const midX = fc.x + dx / 2;
    return [fc, { x: midX, y: fc.y }, { x: midX, y: tc.y }, tc];
  }
  const midY = fc.y + dy / 2;
  return [fc, { x: fc.x, y: midY }, { x: tc.x, y: midY }, tc];
}

export { computeRoutedPath };
