// view3d.js — the 3D View tab: a rotatable/zoomable WebGL scene over the SAME parts and
// connectors data every other view reads (never viewMembers or views — this is a
// data-level visualization, not another placement of the 2D canvas's own nodes).
//
// Stage 0 (current): plumbing only — persistent per-tab renderer/scene/camera/controls,
// a placeholder cube, proof the vendored Three.js loads and renders. Later stages layer
// in: real part/connector data (grouped by element group, then type, ordered by a
// stream template's value[] — InstancedMesh from the start, since this needs to handle
// thousands of parts and retrofitting instancing after building one-mesh-per-part would
// mean redoing the renderer), section/stream clustering, a master cube order for
// elements outside any template's value[], zoom-to-2D-detail (jumps to the matching
// canvas tab past a threshold, not a seamless morph — see this feature's own design
// notes), and a live simulation-value overlay (current tick only, no history scrubbing).
//
// Deliberately the ONLY module that imports the vendored Three.js/OrbitControls — every
// other module stays free of a 3D dependency, and canvas.js only ever reaches this file
// via a lazy dynamic import() (see renderView3DPage there), so the ~800KB vendored
// library never loads unless someone actually opens the 3D tab.
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

// tab.id -> { renderer, scene, camera, controls, container, resizeObserver, animId }
const instances = new Map();

function themeBackgroundColor() {
  // Reads the app's own CSS custom property so the 3D scene's background matches
  // light/dark mode instead of hardcoding one — same source of truth the rest of the UI
  // already uses. Falls back to a neutral grey if the variable somehow isn't set yet.
  const raw = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  return raw || '#e8e8e8';
}

function createInstance(app, tab, container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(themeBackgroundColor());

  const width = container.clientWidth || 1, height = container.clientHeight || 1;
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 5000);
  camera.position.set(6, 6, 10);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);

  // Stage 0 placeholder — proves the vendored library loads and renders correctly.
  // Removed the moment Stage 1 populates the scene from real part/connector data.
  const placeholder = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0x3b5bfd }),
  );
  scene.add(placeholder);

  let animId = null;
  const animate = () => {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  const resizeObserver = new ResizeObserver(() => {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(container);

  return { renderer, scene, camera, controls, container, resizeObserver, animId, placeholder };
}

function disposeInstance(inst) {
  if (inst.animId != null) cancelAnimationFrame(inst.animId);
  inst.resizeObserver.disconnect();
  inst.controls.dispose();
  inst.scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of materials) m.dispose();
    }
  });
  inst.renderer.dispose();
  if (inst.renderer.domElement.parentNode) inst.renderer.domElement.parentNode.removeChild(inst.renderer.domElement);
}

/**
 * Entry point canvas.js calls on every render() while a 3D tab is active. Creates the
 * persistent renderer/scene/camera/controls the FIRST time this tab is seen, then only
 * re-syncs scene data on every subsequent call — never tears down and rebuilds the WebGL
 * context on every store change the way the 2D canvas page rebuilds its DOM, since that
 * would both be wasteful and would reset the camera/rotation the person is mid-interacting
 * with.
 */
function renderView3D(app, tab, container) {
  let inst = instances.get(tab.id);
  if (!inst) {
    inst = createInstance(app, tab, container);
    instances.set(tab.id, inst);
  }
  // Stage 0 has no real data to sync yet; later stages update instanced mesh
  // transforms/colors here from store.doc.parts/connectors.
}

/** Called from App.closeTab (main.js, via canvas.js's disposeView3DTab) so a closed 3D
 * tab's WebGL context/animation loop are torn down instead of leaking — browsers cap the
 * number of live WebGL contexts a page can hold. */
function disposeView3D(tabId) {
  const inst = instances.get(tabId);
  if (!inst) return;
  disposeInstance(inst);
  instances.delete(tabId);
}

export { renderView3D, disposeView3D };
