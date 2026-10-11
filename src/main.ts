import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SpatialUI } from './SpatialUI.js';
import type { SpatialAction } from './SpatialUI.js';

/* ============================================================================
 * Quest 3 WebXR GLB Viewer — app entry point
 *
 * Dual UI:
 *  - Pre-VR: 2D DOM overlay (model grid, lighting, preload, Enter VR / MR)
 *  - In-headset: 3D spatial HUD (SpatialUI.ts) — world-locked, zero drift
 *
 * Interaction model:
 *  - trigger (select) on HUD button  -> spatial action
 *  - trigger (select) on model        -> 1-hand grab (6DoF, world re-locked
 *                                         on release via scene.attach)
 *  - both triggers on same model     -> 2-hand pinch scale (0.05x–5.0x)
 *                                         + Y-axis rotation + midpoint move
 *  - squeeze (grip)                  -> re-show HUD if hidden
 * ========================================================================== */

interface ModelDef {
  id: string;
  name: string;
  url: string;
  hint: string;
}

/** Remote samples work out-of-the-box; drop your own .glb into
 *  public/models/ and add `{ id, name, url: '/models/xxx.glb' }` entries. */
const MODELS: ModelDef[] = [
  {
    id: 'duck',
    name: 'Rubber Duck',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Duck/glTF-Binary/Duck.glb',
    hint: 'tiny · fast'
  },
  {
    id: 'avocado',
    name: 'Avocado',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Avocado/glTF-Binary/Avocado.glb',
    hint: 'pbr · small'
  },
  {
    id: 'boombox',
    name: 'Boom Box',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/BoomBox/glTF-Binary/BoomBox.glb',
    hint: 'mid · detailed'
  },
  {
    id: 'helmet',
    name: 'Damaged Helmet',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb',
    hint: 'hero · pbr'
  },
  {
    id: 'autumn-house',
    name: 'Autumn House',
    url: '/models/autumn_house.glb',
    hint: 'local · propio'
  },
  {
    id: 'van',
    name: 'Van',
    url: '/models/Van_v02.glb',
    hint: 'local · propio'
  },
  {
    id: 'pump',
    name: 'Centrifugal Water Pump',
    url: '/models/centrifugal_water_pump.glb',
    hint: 'local · propio'
  }
];

const MIN_SCALE = 0.05;
const MAX_SCALE = 5.0;
const MODEL_HOME = new THREE.Vector3(0, 0, -0.7);

const LIGHT_PRESETS = [
  { name: 'Studio', dir: 2.2, hemi: 0.9, exposure: 1.0, env: 'room' },
  { name: 'Warm', dir: 2.6, hemi: 0.6, exposure: 1.1, env: 'sunset' },
  { name: 'Night', dir: 0.7, hemi: 0.25, exposure: 0.85, env: 'night' },
  { name: 'Bright', dir: 3.2, hemi: 1.4, exposure: 1.15, env: 'room' }
] as const;

// ---------------------------------------------------------------- DOM helpers

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in index.html`);
  return node as T;
}

let toastTimer = 0;
function toast(msg: string): void {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
}

function setLoading(show: boolean, label = 'Loading model…', progress = 0): void {
  el('loading-overlay').classList.toggle('show', show);
  el('loading-label').textContent = label;
  (el('loading-bar-fill') as HTMLElement).style.width = `${Math.round(progress * 100)}%`;
  el('loading-percent').textContent = `${Math.round(progress * 100)}%`;
}

// ---------------------------------------------------------------- Renderer / scene

const container = el('scene-container');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0b0e14');

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 2.1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, -0.4);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.3;
controls.maxDistance = 8;
controls.update();

// Image-based lighting so PBR GLBs look right with no HDR file shipped.
const pmrem = new THREE.PMREMGenerator(renderer);
let roomEnvRT: THREE.WebGLRenderTarget | null = null;
function applyEnvironmentPreset(preset: string): void {
  if (roomEnvRT) {
    roomEnvRT.dispose();
    roomEnvRT = null;
  }
  if (preset === 'none') {
    scene.environment = null;
    return;
  }
  const envScene = new RoomEnvironment();
  roomEnvRT = pmrem.fromScene(envScene, 0.04);
  scene.environment = roomEnvRT.texture;
}
applyEnvironmentPreset('room');

// Lights
const hemi = new THREE.HemisphereLight(0xdfeaff, 0x1a2030, 0.9);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(2.5, 4, 1.5);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 12;
key.shadow.camera.left = -3;
key.shadow.camera.right = 3;
key.shadow.camera.top = 3;
key.shadow.camera.bottom = -3;
key.shadow.bias = -0.0004;
scene.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
rim.position.set(-2.5, 2.5, -2);
scene.add(rim);

// Floor: shadow catcher + optional dev grid
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(6, 48),
  new THREE.ShadowMaterial({ opacity: 0.35 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(10, 20, 0x5b8cff, 0x26314a);
grid.position.y = 0.001;
grid.visible = false;
scene.add(grid);

// Pedestal target ring under the model (comfort cue, world-locked)
const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.32, 0.36, 48),
  new THREE.MeshBasicMaterial({ color: 0x5b8cff, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
);
ring.rotation.x = -Math.PI / 2;
ring.position.set(MODEL_HOME.x, 0.002, MODEL_HOME.z);
scene.add(ring);

// ---------------------------------------------------------------- Loaders (Draco + progress)

const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(draco);

const cache = new Map<string, GLTF>();
let activeModel: THREE.Group | null = null;
let activeIndex = 0;
let baseScale = 1;
let userScale = 1; // normalized multiplier, clamped MIN_SCALE..MAX_SCALE
let homeRotationY = 0;

/** Normalize a loaded scene: center XZ, rest base on floor, fit ~1 m. */
function normalizeModel(root: THREE.Group): void {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  baseScale = THREE.MathUtils.clamp(1 / maxDim, 0.05, 10);
  root.scale.setScalar(baseScale);
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const m = o as THREE.Mesh;
      m.castShadow = true;
      m.receiveShadow = false;
    }
  });
}

function applyUserScale(): void {
  if (!activeModel) return;
  activeModel.scale.setScalar(baseScale * userScale);
  hud.setScale(userScale);
}

function loadModel(def: ModelDef, onProgress: (p: number) => void): Promise<GLTF> {
  const cached = cache.get(def.id);
  if (cached) {
    onProgress(1);
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      def.url,
      (gltf) => {
        cache.set(def.id, gltf);
        onProgress(1);
        resolve(gltf);
      },
      (xhr) => {
        if (xhr.total > 0) onProgress(xhr.loaded / xhr.total);
        else onProgress(0.5); // unknown length: indeterminate halfway
      },
      (err) => reject(err)
    );
  });
}

async function showModel(index: number): Promise<void> {
  const total = MODELS.length;
  activeIndex = ((index % total) + total) % total;
  const def = MODELS[activeIndex];
  refreshModelGrid();
  hud.setModel(def.name, activeIndex, total);

  const label = `Loading ${def.name}…`;
  setLoading(true, label, 0);
  hud.setLoadProgress(0, def.name);
  try {
    const gltf = await loadModel(def, (p) => {
      setLoading(true, label, p);
      hud.setLoadProgress(p, def.name);
    });
    if (activeModel) {
      scene.remove(activeModel);
      activeModel = null;
    }
    // End any in-flight grab before swapping.
    grabs.length = 0;
    dualInit = null;

    activeModel = gltf.scene;
    normalizeModel(activeModel);
    userScale = 1;
    homeRotationY = activeModel.rotation.y;
    activeModel.position.add(MODEL_HOME);
    scene.add(activeModel);
    applyUserScale();
    setCacheStatus();
    toast(`Showing: ${def.name}`);
  } catch (err) {
    console.error(err);
    toast(`Could not load "${def.name}". Check URL / place file in public/models.`);
  } finally {
    setLoading(false);
    hud.setLoadProgress(-1, '');
  }
}

function resetTransforms(): void {
  if (!activeModel) return;
  // If grabbed, drop back to world first so reset is exact.
  if (grabs.length > 0) {
    scene.attach(activeModel);
    grabs.length = 0;
    dualInit = null;
  }
  activeModel.position.copy(MODEL_HOME);
  activeModel.rotation.set(0, homeRotationY, 0);
  userScale = 1;
  applyUserScale();
  toast('Transform reset (world-locked)');
}

// ---------------------------------------------------------------- Spatial HUD

let currentSessionMode: 'immersive-vr' | 'immersive-ar' | null = null;
let pendingMode: 'immersive-vr' | 'immersive-ar' | null = null;

const hud = new SpatialUI({ onAction: handleSpatialAction });
scene.add(hud.group);
hud.setModel(MODELS[0].name, 0, MODELS.length);
hud.setScale(1);
hud.setLight(LIGHT_PRESETS[0].name);

function handleSpatialAction(action: SpatialAction): void {
  switch (action) {
    case 'prev':
      void showModel(activeIndex - 1);
      break;
    case 'next':
      void showModel(activeIndex + 1);
      break;
    case 'reset':
      resetTransforms();
      break;
    case 'light':
      cycleLightPreset();
      break;
    case 'passthrough':
      void togglePassthrough();
      break;
    case 'recenter':
      hud.placeInFrontOf(camera);
      toast('HUD recentered');
      break;
    case 'follow':
      hud.setFollow(!hud.follow);
      toast(hud.follow ? 'HUD follow: on' : 'HUD follow: off (world-locked)');
      break;
    case 'dismiss':
      hud.setVisible(false);
      toast('HUD hidden — squeeze grip to bring it back');
      break;
  }
}

let lightPresetIndex = 0;
function cycleLightPreset(): void {
  lightPresetIndex = (lightPresetIndex + 1) % LIGHT_PRESETS.length;
  const p = LIGHT_PRESETS[lightPresetIndex];
  key.intensity = p.dir;
  hemi.intensity = p.hemi;
  renderer.toneMappingExposure = p.exposure;
  applyEnvironmentPreset(p.env);
  hud.setLight(p.name);
  syncEnvInputs(p);
}

// ---------------------------------------------------------------- Controllers, rays, grabs

const raycaster = new THREE.Raycaster();
const tmpMatrix = new THREE.Matrix4();

interface ControllerRig {
  ctrl: THREE.Group;
  index: number;
  ray: THREE.Line;
  cursor: THREE.Mesh;
}

function makeLaser(color: number): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -4)]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
  return new THREE.Line(geo, mat);
}

function makeRig(index: number): ControllerRig {
  const ctrl = renderer.xr.getController(index);
  const ray = makeLaser(index === 0 ? 0x5b8cff : 0x22d3ee);
  ctrl.add(ray);
  const cursor = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  cursor.position.set(0, 0, -0.05);
  cursor.visible = false;
  ctrl.add(cursor);
  scene.add(ctrl);

  ctrl.addEventListener('connected', () => {
    ray.visible = true;
  });
  ctrl.addEventListener('disconnected', () => {
    endGrab(ctrl);
  });
  ctrl.addEventListener('selectstart', () => onSelectStart(ctrl, index));
  ctrl.addEventListener('selectend', () => onSelectEnd(ctrl));
  ctrl.addEventListener('squeezestart', () => {
    if (!hud.visible && renderer.xr.isPresenting) {
      hud.setVisible(true);
      hud.placeInFrontOf(camera);
    }
  });
  return { ctrl, index, ray, cursor };
}

const rigs: ControllerRig[] = [makeRig(0), makeRig(1)];

/** Active grabs: which controllers currently hold the model. */
const grabs: Array<{ ctrl: THREE.Group; index: number }> = [];
let dualInit: {
  dist: number;
  angle: number;
  scale: number;
  rotY: number;
  mid: THREE.Vector3;
  pos: THREE.Vector3;
} | null = null;

function castFrom(ctrl: THREE.Group): void {
  tmpMatrix.identity().extractRotation(ctrl.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMatrix);
}

function pickHUD(ctrl: THREE.Group): SpatialAction | null {
  if (!hud.visible) return null;
  castFrom(ctrl);
  const hits = raycaster.intersectObjects(hud.interactive, false);
  if (hits.length === 0) return null;
  return hud.actionFor(hits[0].object);
}

function pickModel(ctrl: THREE.Group): boolean {
  if (!activeModel) return false;
  castFrom(ctrl);
  const hits = raycaster.intersectObject(activeModel, true);
  return hits.length > 0;
}

function controllerPos(ctrl: THREE.Group, out: THREE.Vector3): THREE.Vector3 {
  return out.setFromMatrixPosition(ctrl.matrixWorld);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

function onSelectStart(ctrl: THREE.Group, index: number): void {
  // 1) HUD buttons take priority
  const action = pickHUD(ctrl);
  if (action) {
    hud.emit(action);
    return;
  }
  // 2) Otherwise try to grab the model
  if (!activeModel || !pickModel(ctrl)) return;
  if (grabs.some((g) => g.ctrl === ctrl)) return;
  grabs.push({ ctrl, index });

  if (grabs.length === 1) {
    dualInit = null;
    ctrl.attach(activeModel); // preserved world transform; re-locked on release
  } else if (grabs.length === 2) {
    // Switch to explicit two-hand math (model lives in world = zero drift)
    scene.attach(activeModel);
    controllerPos(grabs[0].ctrl, _a);
    controllerPos(grabs[1].ctrl, _b);
    const dist = _a.distanceTo(_b);
    const angle = Math.atan2(_b.z - _a.z, _b.x - _a.x);
    dualInit = {
      dist: Math.max(dist, 1e-4),
      angle,
      scale: userScale,
      rotY: activeModel.rotation.y,
      mid: _a.clone().add(_b).multiplyScalar(0.5),
      pos: activeModel.position.clone()
    };
  }
}

function onSelectEnd(ctrl: THREE.Group): void {
  endGrab(ctrl);
}

function endGrab(ctrl: THREE.Group): void {
  const i = grabs.findIndex((g) => g.ctrl === ctrl);
  if (i === -1) return;
  grabs.splice(i, 1);
  if (!activeModel) {
    dualInit = null;
    return;
  }
  if (grabs.length === 1) {
    // Back to single-hand grab on the remaining controller
    dualInit = null;
    grabs[0].ctrl.attach(activeModel);
  } else {
    // Fully released -> world-lock: freeze exact world transform in scene
    dualInit = null;
    scene.attach(activeModel);
  }
}

function updateTwoHand(): void {
  if (grabs.length !== 2 || !dualInit || !activeModel) return;
  controllerPos(grabs[0].ctrl, _a);
  controllerPos(grabs[1].ctrl, _b);
  const dist = Math.max(_a.distanceTo(_b), 1e-4);
  const angle = Math.atan2(_b.z - _a.z, _b.x - _a.x);
  const mid = _a.clone().add(_b).multiplyScalar(0.5);

  userScale = THREE.MathUtils.clamp(dualInit.scale * (dist / dualInit.dist), MIN_SCALE, MAX_SCALE);
  activeModel.scale.setScalar(baseScale * userScale);
  hud.setScale(userScale);

  let dAngle = angle - dualInit.angle;
  while (dAngle > Math.PI) dAngle -= Math.PI * 2;
  while (dAngle < -Math.PI) dAngle += Math.PI * 2;
  activeModel.rotation.y = dualInit.rotY + dAngle;

  activeModel.position.copy(dualInit.pos).add(mid.clone().sub(dualInit.mid));
}

/** Hover feedback each frame: HUD highlight + model emissive + cursor. */
function updateHover(): void {
  if (!renderer.xr.isPresenting) {
    hud.setHover(null);
    return;
  }
  let hudHit: THREE.Object3D | null = null;
  let modelHit = false;
  for (const rig of rigs) {
    if (hud.visible) {
      castFrom(rig.ctrl);
      const hits = raycaster.intersectObjects(hud.interactive, false);
      if (hits.length > 0) {
        hudHit = hits[0].object;
        rig.cursor.visible = true;
        (rig.cursor.material as THREE.MeshBasicMaterial).color.set(0x22d3ee);
        continue;
      }
    }
    if (activeModel) {
      castFrom(rig.ctrl);
      const hits = raycaster.intersectObject(activeModel, true);
      if (hits.length > 0) {
        modelHit = true;
        rig.cursor.visible = true;
        (rig.cursor.material as THREE.MeshBasicMaterial).color.set(0x34d399);
        continue;
      }
    }
    rig.cursor.visible = false;
  }
  hud.setHover(hudHit);
  setModelHighlight(modelHit);
}

let highlightOn = false;
function setModelHighlight(on: boolean): void {
  if (!activeModel || on === highlightOn) return;
  highlightOn = on;
  activeModel.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if ('emissive' in std && std.emissive) {
        if (on) {
          if (std.userData._e === undefined) std.userData._e = std.emissive.getHex();
          std.emissive.setHex(0x1a3a5c);
        } else if (std.userData._e !== undefined) {
          std.emissive.setHex(std.userData._e as number);
        }
      }
    }
  });
}

/** Right-thumbstick Y-rotation while single-grabbing (convenience). */
function updateThumbstickRotate(): void {
  if (grabs.length !== 1 || !activeModel) return;
  const session = renderer.xr.getSession();
  if (!session) return;
  try {
    for (const src of session.inputSources) {
      const gp = src.gamepad as Gamepad | undefined;
      if (!gp || gp.axes.length < 3) continue;
      const x = gp.axes[2];
      if (Math.abs(x) > 0.25) {
        activeModel.rotation.y += x * 0.03;
      }
    }
  } catch {
    /* gamepad optional — ignore */
  }
}

// ---------------------------------------------------------------- XR sessions (VR + Passthrough MR)

async function startSession(mode: 'immersive-vr' | 'immersive-ar'): Promise<void> {
  if (!('xr' in navigator) || !navigator.xr) {
    toast('WebXR not available — use Meta Quest Browser over HTTPS.');
    return;
  }
  try {
    const session = await navigator.xr.requestSession(mode, {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers']
    });
    pendingMode = null;
    await renderer.xr.setSession(session);
  } catch (err) {
    console.error(err);
    toast(mode === 'immersive-ar' ? 'MR session rejected — try Enter VR.' : 'VR session rejected — did you tap from inside Quest Browser?');
  }
}

async function togglePassthrough(): Promise<void> {
  const next = currentSessionMode === 'immersive-ar' ? 'immersive-vr' : 'immersive-ar';
  const session = renderer.xr.getSession();
  if (session) {
    // Seamless-ish switch: end now, start the other mode on session end.
    pendingMode = next;
    try {
      await session.end();
    } catch (err) {
      console.error(err);
      pendingMode = null;
    }
  } else {
    await startSession(next);
  }
}

renderer.xr.addEventListener('sessionstart', () => {
  document.body.classList.add('presenting');
  controls.enabled = false;
  const session = renderer.xr.getSession();
  const mode = (session ? 'immersive-ar' : 'immersive-vr') as string;
  // Detect AR via enabledFeatures / environmentBlendMode when available
  const s = session as unknown as { environmentBlendMode?: string } | null;
  currentSessionMode =
    s && (s.environmentBlendMode === 'additive' || s.environmentBlendMode === 'alpha-blend')
      ? 'immersive-ar'
      : mode === 'immersive-ar'
        ? 'immersive-ar'
        : 'immersive-vr';
  // MR => transparent backdrop so passthrough shows through
  if (currentSessionMode === 'immersive-ar') {
    scene.background = null;
    floor.visible = false;
  }
  hud.setVisible(true);
  hud.placeInFrontOf(camera);
  toast(currentSessionMode === 'immersive-ar' ? 'Passthrough MR active' : 'Immersive VR active');
});

renderer.xr.addEventListener('sessionend', () => {
  document.body.classList.remove('presenting');
  controls.enabled = true;
  currentSessionMode = null;
  hud.setVisible(false);
  grabs.length = 0;
  dualInit = null;
  restoreBackdrop();
  if (pendingMode) {
    const next = pendingMode;
    pendingMode = null;
    void startSession(next);
  }
});

async function refreshXRSupport(): Promise<void> {
  const vrBtn = el<HTMLButtonElement>('enter-vr');
  const arBtn = el<HTMLButtonElement>('enter-ar');
  const status = el('xr-status');
  if (!('xr' in navigator) || !navigator.xr) {
    status.textContent = 'WebXR unavailable (needs HTTPS + Quest Browser). Desktop preview still works.';
    status.className = 'warn';
    return;
  }
  try {
    const [vr, ar] = await Promise.all([
      navigator.xr.isSessionSupported('immersive-vr'),
      navigator.xr.isSessionSupported('immersive-ar')
    ]);
    vrBtn.disabled = !vr;
    arBtn.disabled = !ar;
    if (vr && ar) {
      status.textContent = 'Ready: immersive-vr + passthrough MR supported.';
      status.className = 'ok';
    } else if (vr) {
      status.textContent = 'Ready: immersive-vr supported (MR not advertised).';
      status.className = 'ok';
    } else if (ar) {
      status.textContent = 'Only immersive-ar advertised on this browser.';
      status.className = 'warn';
    } else {
      status.textContent = 'No immersive session support detected.';
      status.className = 'warn';
    }
  } catch {
    status.textContent = 'Could not query XR support.';
    status.className = 'warn';
  }
}

// ---------------------------------------------------------------- 2D DOM overlay wiring

function refreshModelGrid(): void {
  const gridEl = el('model-grid');
  gridEl.innerHTML = '';
  MODELS.forEach((def, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'model-card' + (i === activeIndex ? ' active' : '');
    const cached = cache.has(def.id) ? ' ● cached' : '';
    b.innerHTML = `<strong>${def.name}</strong><small>${def.hint}${cached}</small>`;
    b.addEventListener('click', () => {
      void showModel(i);
    });
    gridEl.appendChild(b);
  });
}

function setCacheStatus(): void {
  el('caching-status').textContent = `Cache: ${cache.size}/${MODELS.length} models decoded.`;
}

function syncEnvInputs(p?: { dir: number; hemi: number; exposure: number }): void {
  if (!p) return;
  el<HTMLInputElement>('dir-intensity').value = String(p.dir);
  el<HTMLInputElement>('hemi-intensity').value = String(p.hemi);
  el<HTMLInputElement>('exposure').value = String(p.exposure);
  el('dir-val').textContent = p.dir.toFixed(1);
  el('hemi-val').textContent = p.hemi.toFixed(1);
  el('exposure-val').textContent = p.exposure.toFixed(2);
}

function restoreBackdrop(): void {
  const mode = el<HTMLSelectElement>('bg-mode').value;
  if (mode === 'transparent') scene.background = null;
  else scene.background = new THREE.Color('#0b0e14');
}

function wireUI(): void {
  el<HTMLButtonElement>('enter-vr').addEventListener('click', () => void startSession('immersive-vr'));
  el<HTMLButtonElement>('enter-ar').addEventListener('click', () => void startSession('immersive-ar'));

  el<HTMLButtonElement>('preload-all').addEventListener('click', async () => {
    const btn = el<HTMLButtonElement>('preload-all');
    btn.disabled = true;
    for (let i = 0; i < MODELS.length; i++) {
      const def = MODELS[i];
      if (cache.has(def.id)) continue;
      const label = `Precaching ${i + 1}/${MODELS.length}: ${def.name}`;
      setLoading(true, label, i / MODELS.length);
      hud.setLoadProgress(i / MODELS.length, `Precache ${def.name}`);
      try {
        await loadModel(def, (p) => {
          const overall = (i + p) / MODELS.length;
          setLoading(true, label, overall);
          hud.setLoadProgress(overall, `Precache ${def.name}`);
        });
      } catch (err) {
        console.warn(`Precache skipped for ${def.name}`, err);
      }
      refreshModelGrid();
      setCacheStatus();
    }
    setLoading(false);
    hud.setLoadProgress(-1, '');
    btn.disabled = false;
    toast('Precache pass finished');
  });

  el<HTMLInputElement>('file-input').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const def: ModelDef = {
      id: `upload-${Date.now()}`,
      name: file.name.replace(/\.(glb|gltf)$/i, ''),
      url,
      hint: 'uploaded · local blob'
    };
    MODELS.push(def);
    refreshModelGrid();
    void showModel(MODELS.length - 1);
    input.value = '';
  });

  el<HTMLSelectElement>('env-preset').addEventListener('change', (e) => {
    applyEnvironmentPreset((e.target as HTMLSelectElement).value);
  });
  el<HTMLInputElement>('exposure').addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    renderer.toneMappingExposure = v;
    el('exposure-val').textContent = v.toFixed(2);
  });
  el<HTMLInputElement>('dir-intensity').addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    key.intensity = v;
    el('dir-val').textContent = v.toFixed(1);
  });
  el<HTMLInputElement>('hemi-intensity').addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    hemi.intensity = v;
    el('hemi-val').textContent = v.toFixed(1);
  });
  el<HTMLSelectElement>('bg-mode').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    grid.visible = v === 'grid';
    floor.visible = v !== 'transparent';
    restoreBackdrop();
  });
  el<HTMLInputElement>('toggle-shadow').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    renderer.shadowMap.enabled = on;
    key.castShadow = on;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const m = mesh.material as THREE.Material | undefined;
        if (m) m.needsUpdate = true;
      }
    });
  });
  el<HTMLInputElement>('toggle-turntable').addEventListener('change', (e) => {
    turntable = (e.target as HTMLInputElement).checked;
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// ---------------------------------------------------------------- Main loop

let turntable = false;
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!renderer.xr.isPresenting) {
    controls.update();
    if (turntable && activeModel && grabs.length === 0) {
      activeModel.rotation.y += dt * 0.4;
    }
  }
  updateTwoHand();
  updateThumbstickRotate();
  updateHover();
  hud.update(dt, camera);
  ring.rotation.z += dt * 0.3;
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- Boot

wireUI();
refreshModelGrid();
setCacheStatus();
void refreshXRSupport();
void showModel(0);
