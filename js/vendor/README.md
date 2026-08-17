# Vendored libraries

DyCAD is vanilla JS with no npm/build step (see the repo root `CLAUDE.md`). The 3D view
is the one exception that needs a real rendering library — rather than a CDN `<script>`
tag (a live runtime dependency: breaks offline, breaks if the CDN changes/goes down),
the files are downloaded once and committed here, imported the same way every other
DyCAD module is (`import * as THREE from './vendor/three.module.js'`).

## Files

- `three.module.js` / `three.core.min.js` — [Three.js](https://threejs.org) r185
  (npm `three@0.185.1`), MIT licensed. Fetched from unpkg's `build/three.module.min.js`
  and `build/three.core.min.js` — the minified single-module build split across two
  files (that split is upstream's own build output, not something done here). Unmodified
  apart from the download itself.
- `OrbitControls.js` — Three.js's own `examples/jsm/controls/OrbitControls.js`, same
  version/license. One line changed: its `from 'three'` bare-specifier import was
  rewritten to `from './three.module.js'`, since there's no bundler here to resolve a
  bare specifier — everything else is untouched.

## Updating

Bump the version number in the three commands below, re-run them, and re-apply the same
one-line import fix to `OrbitControls.js` (`from 'three'` -> `from './three.module.js'`):

```
curl -sL -o three.module.js   "https://unpkg.com/three@<version>/build/three.module.min.js"
curl -sL -o three.core.min.js "https://unpkg.com/three@<version>/build/three.core.min.js"
curl -sL -o OrbitControls.js  "https://unpkg.com/three@<version>/examples/jsm/controls/OrbitControls.js"
```

Sanity-check the result before committing:

```
node --input-type=module -e "
import * as THREE from './three.module.js';
import { OrbitControls } from './OrbitControls.js';
console.log(THREE.REVISION, typeof THREE.InstancedMesh, typeof OrbitControls);
"
```
