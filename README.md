# DyCAD (formerly FlowRun)

A single-page workflow designer and simulator canvas for enterprise architects. Pure vanilla
JS/HTML/CSS — no backend, no build step, no npm packages. Open `index.html` in a browser
served from this folder (a local static server is fine; `file://` will block the
`fetch()` calls to `public/*.json` and `public/relationships.xml` due to browser CORS
rules on local files).

To run:

```
cd dycad
python3 -m http.server 8080
# open http://localhost:8080
```

## Structure

```
index.html          3-column layout shell
css/styles.css       light/dark theme via CSS variables
js/data.js            startup fetches + relationships.xml parsing + relationshipPairs merge
js/state.js           Store: models/parts/connectors/views/viewMembers, tabs, undo/redo,
                        id generation, createdAt/updatedAt timestamps, save/load migration
js/rules.js            connector validity lookups (merged relationshipPairs)
js/render.js            header/toolbox/properties rendering, schema-driven show-fields
                        panels (settings.showFields), catalog row panels, Root Properties
js/canvas.js            interactive canvas: nodes, edges, drag/connect/lasso, catalog table
                        pages, connector routing dispatch, marker/arrowhead defs
js/commands.js         Duplicate Stream, Split Node, Level Up/Down, Generate (createStream),
                        Remap, Merge, Smart Check View, Generate Industry/Inventory View
js/layout.js            force-directed placement + connected-component grid packing
                        (Remap's "force" pattern)
js/routing.js           obstacle-avoiding connector routing (direct + Manhattan styles),
                        visibility-graph pathfinding
js/sections.js          section/grid-based view layout (fixed-cell placement, as opposed
                        to js/layout.js's force-directed freeform placement)
js/simulation.js        node-scripting tick engine, Message Log
js/archimate.js         ArchiMate 3.0 Exchange Format import — parts/connectors/views,
                        junction flattening, nested-shape Composition/Aggregation detection
js/main.js               app controller, event wiring, save/load, modals
public/                 copies of the source data files, fetched at runtime
tests/                  lightweight Playwright-based regression suite — see tests/README.md
```

## Known limitations

A few permanent, deliberate tradeoffs — not bugs to keep re-investigating:

- **Force-directed layout (Remap's "force" pattern) can't guarantee every edge lands in
  an adjacent grid cell.** Spanning-tree edges do, by construction. A "back edge" — e.g.
  the third edge of a fully-connected triangle, where the first two already used up the
  shared node's adjacent slots — gets the closest achievable placement instead. No 2D
  grid embedding can do better for an arbitrary graph; a 5-node complete graph provably
  can't be drawn with every edge between neighboring cells at all.
- **Obstacle-avoiding connector routing (Direct/Manhattan) only considers obstacles
  local to each connector's own region**, not the whole diagram, for performance reasons
  on large views. A connector will route around nodes near its path but won't discover a
  detour around something far away that happens to be relevant only because of how a
  third connector crosses it.
- **ArchiMate import's nested-shape detection only covers Composition/Aggregation.**
  These are the two relationship types ArchiMate tooling conventionally represents via
  visual nesting; other relationship types drawn without an explicit `<connection>`
  element (unusual, and not a standard convention) won't be picked up by this specific
  detection.
- **Smart Check View's two checks are intentionally independent.** With only "missing
  connectors and nodes" checked, a pair that was already both-present and disconnected
  before the command ran stays disconnected — fixing that is specifically "missing
  connectors"'s job. Most users will want both checked together.

## Design decisions on underspecified areas

The instructions document has more implicit logic in the sample data (`onestream.json`)
than in its own prose, and a few things are referenced without a full spec. Where I had
to make a call, here's what I did and why — flag any of these if they don't match intent:

- **Generate / createStream**: I reverse-engineered the exact labeling and passive-node
  logic against `onestream.json`'s `home` view, which is consistent with the Enterprise
  stream template's `value`/`passive` arrays and matches node-for-node (same relationship
  names, same connectorType `s`). The `Data` template's `capabilityNameBegin`/
  `entityNameBegin` intentionally reference element types that don't exist
  (`BusinessServicetbd`, `TechnologyLogicalComponenttbd`) — Generate correctly aborts
  with an error for that template rather than proceeding, per spec.
- **Undo/redo snapshots**: the spec says "each tab owns nodes/edges/viewport/history,"
  but nodes/edges are really just viewMembers referencing globally-shared Parts/Connectors
  across views. I snapshot the full doc (`parts`, `connectors`, `viewMembers`, `views`)
  per recorded action, keyed per tab. This is safer than a partial snapshot (it can't
  desync from cross-view references) at the cost of slightly larger snapshots.
- **Level Down "preserve id so edges resolve"**: taken literally, this would require two
  viewMembers sharing one `id` across two views, which breaks id-based lookup. I copy the
  neighbor into the new view with a *new* viewMember id but the *same* `objectId` (the
  underlying Part), marked `isExternal: true` — functionally equivalent (same node,
  recognizable as external) without ambiguous ids.
- **Level Up linkedViewName direction**: the new "Unknown" node's `linkedViewName` points
  back down to the view you leveled up *from*, mirroring how Level Down's placeholder
  node links down into its new sub-view. Double-clicking either navigates to the
  more-detailed view.
- **"Merge" command**: mentioned once in the instructions but never specified (also
  flagged in the earlier audit of this project). Not implemented — no behavior to infer.
- **connectorType 's' vs 'c'**: `s` (stream) is used exactly where specified (Generate,
  Duplicate Stream); everything drawn by hand via the connect-handle uses `c`.
- **Relationship validation**: `relationships.xml` (full ArchiMate 3.2 matrix) is merged
  with `custom.json`'s `relationshipPairs` — union of relation letters per `A→B` pair,
  A→B never inferred to also allow B→A. This is what lets the proprietary types
  (`GeneralActor`, `Tester`, `Multi`, etc., absent from the ArchiMate standard) get valid
  connections, since those rules only exist in `custom.json`.
- **View toggles**: `chkShowElementTypes` and `chkShowConnectors` have visible effects
  (type label, edge visibility). `chkShowKeys` shows the part id under the label.
  `chkShowOnPageCatalogs` is stored/persisted but has no rendering behavior yet — the
  spec doesn't describe what an "on-page catalog" should look like.
