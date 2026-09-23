import { createViewTools } from './view-tools.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Octree } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const FT = 0.3048;
const HEIGHT = 6 * FT;
const EYE = (5 + 2 / 12) * FT;
const RADIUS = (11 / 12) * FT;
const testing = new URLSearchParams(location.search).get('test') === '1';
const viewRenderEnabled = window.DREAM_HOME_VIEW_RENDER_ENABLED !== false;
if (!viewRenderEnabled) document.body.classList.add('view-render-disabled');
const hasTouchHardware = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
const mobileLike = hasTouchHardware || Math.min(innerWidth, innerHeight) <= 600;
const GAMEPAD_DEADZONE = 0.16;
const GAMEPAD_LOOK_SPEED = 2.6;
const GAMEPAD_DOUBLE_TAP_MS = 280;
const RUN_DOUBLE_TAP_MS = 320;
const GAMEPAD_TAP_MS = 220;

const canvas = document.querySelector('#world');
const menu = document.querySelector('#menu');
const hud = document.querySelector('#hud');
const status = document.querySelector('#status');
const STARTING_PLACE = 'living';

// preserveDrawingBuffer is intentionally omitted. Keeping the drawing buffer
// around costs extra GPU/framebuffer memory and is not needed for gameplay.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: !mobileLike,
  powerPreference: mobileLike ? 'low-power' : 'high-performance',
});

renderer.setPixelRatio(Math.min(devicePixelRatio, mobileLike ? 1 : 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = !mobileLike;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.localClippingEnabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#bfd4dc');
scene.fog = new THREE.Fog('#bfd4dc', 75, 170);

// Lightweight first-person practice projectiles. They do not add geometry to
// the collision model, but they do use the same active Octree maps as the
// character so bullets and energy balls can ricochet around the house.
const projectileRoot = new THREE.Group();
projectileRoot.name = 'walkthrough projectiles';
scene.add(projectileRoot);
const projectileGeometry = {
  bullet: new THREE.SphereGeometry(0.045, 8, 6),
  fireball: new THREE.SphereGeometry(0.08, 10, 8),
};
const projectileGlowGeometry = new THREE.SphereGeometry(0.13, 12, 8);
const projectileMaterial = {
  bullet: new THREE.MeshBasicMaterial({ color: 0x27342c }),
  fireball: new THREE.MeshBasicMaterial({ color: 0xffcf76 }),
};
const projectileGlowMaterial = new THREE.MeshBasicMaterial({
  color: 0xff6a1a,
  transparent: true,
  opacity: 0.08,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
});
const projectileSpecs = {
  bullet: {
    speed: 42,
    radius: 0.045,
    maxAge: 1.3,
    maxDistance: 54,
    maxBounces: 4,
    restitution: 0.72,
    tangentDamping: 0.96,
    gravity: 0,
    minSpeed: 2.5,
  },
  fireball: {
    speed: 18,
    radius: 0.08,
    maxAge: 3.2,
    maxDistance: 58,
    maxBounces: 6,
    restitution: 0.48,
    tangentDamping: 0.90,
    gravity: -3.1,
    minSpeed: 1.2,
  },
};
const PROJECTILE_LIMIT = 64;
const PROJECTILE_SWEEP_LIMIT = 5;
const PROJECTILE_COLLISION_EPSILON = 0.006;
const projectileDirection = new THREE.Vector3();
const projectileNormal = new THREE.Vector3();
const projectileNormalPart = new THREE.Vector3();
const projectileTangentPart = new THREE.Vector3();
const projectiles = [];
const projectileShots = { bullets: 0, fireballs: 0 };
let projectilesEnabled = true;
let bulletCooldown = 0;
let fireballCooldown = 0;

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.04, 220);
camera.rotation.order = 'YXZ';

if (!mobileLike) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new RoomEnvironment();
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  scene.environmentIntensity = 0.32;
  env.dispose();
  pmrem.dispose();
} else {
  // Keep mobile startup within a smaller GPU budget. The hemisphere and sun
  // lights below provide a readable fallback without a PMREM environment.
  scene.environment = null;
  scene.environmentIntensity = 0;
}

const hemisphere = new THREE.HemisphereLight(0xe4f0ff, 0xa09b7f, mobileLike ? 2.5 : 2.1);
scene.add(hemisphere);

const sun = new THREE.DirectionalLight(0xfff0d3, mobileLike ? 2.6 : 3.2);
sun.position.set(-14, 30, 12);
sun.castShadow = !mobileLike;
if (!mobileLike) sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, {
  left: -21,
  right: 21,
  top: 21,
  bottom: -21,
  near: 0.1,
  far: 80,
});
sun.shadow.normalBias = 0.028;
sun.shadow.bias = -0.00008;
scene.add(sun);

// Gentle interior fill approximates bounced light that the real-time renderer does not calculate.
for (let i = 0; i < (mobileLike ? 2 : 6); i++) {
  const a = i * Math.PI / 3;
  const l = new THREE.PointLight(0xffefd8, 30, 14, 2);
  l.position.set(9 * Math.cos(a), 3, 9 * Math.sin(a));
  scene.add(l);
}

const world = new Octree();
world.maxLevel = 12;
const systemEnabled = {ring_awning:true, door_canopies:false};
const INTERIOR_COLLISION_GROUPS = new Set(['03', '12', '13']);
const BARE_SHELL_GROUPS = new Set(['03', '06', '12', '13']);
const optionalWorldKeys = [...new Set([
  ...Object.keys(systemEnabled),
  'interior', 'furniture', 'roof', 'interior_roof',
])];
const optionalWorlds = Object.fromEntries(optionalWorldKeys.map(key=>{
  const tree=new Octree();tree.maxLevel=12;return [key,tree];
}));
const collisionForests = { base: world, ...optionalWorlds };
const COLLISION_CHUNK_TRIANGLES = 5000;
const COLLISION_MAP_LABELS = {
  base: 'floor & shell',
  interior: 'room partitions',
  furniture: 'furniture & equipment',
  roof: 'simplified outer roof',
  interior_roof: 'interior ceilings',
  ring_awning: 'ring awning',
  door_canopies: 'door canopies',
};
const pendingCollisionTrees = Object.fromEntries(
  Object.keys(collisionForests).map(key => {
    const tree = new Octree(); tree.maxLevel = 12; return [key, tree];
  }),
);
const pendingCollisionCounts = Object.fromEntries(
  Object.keys(collisionForests).map(key => [key, 0]),
);
const collisionChunksIndexedByMap = Object.fromEntries(
  Object.keys(collisionForests).map(key => [key, 0]),
);
const collisionCounts = {
  base:0,
  interior:0,
  furniture:0,
  roof:0,
  interior_roof:0,
  ring_awning:0,
  door_canopies:0,
};
const collisionWorldBuilt = Object.fromEntries(
  ['base', ...optionalWorldKeys].map(key => [key, false]),
);
let activeCollisionWorlds = [world];
let bareShell = false;
let furnitureVisible = true;
let roofCutaway = false;
let cutawayDropThrough = false;

const ROOF_CUTAWAY_HEIGHT = (7 + 11 / 12) * FT;
const ROOF_COLLISION_AZIMUTH_SEGMENTS = 120;
const ROOF_COLLISION_PROFILE_SEGMENTS = 24;
const MOBILE_SHELL_AZIMUTH_SEGMENTS = 64;
const MOBILE_SHELL_PROFILE_SEGMENTS = 10;
const MOBILE_FLOOR_SEGMENTS = 96;
const MOBILE_PARTITION_TRIANGLE_STRIDE = 8;
const roofCutawayPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), ROOF_CUTAWAY_HEIGHT);
let collisionProfile = mobileLike ? 'mobile shell + sampled partitions' : 'full authored collision maps';

function refreshActiveCollisionWorlds() {
  const collisionWorlds = [world];
  if (!roofCutaway && collisionWorldBuilt.roof) collisionWorlds.push(optionalWorlds.roof);
  if (!bareShell) {
    if (collisionWorldBuilt.interior) collisionWorlds.push(optionalWorlds.interior);
    if (!roofCutaway && collisionWorldBuilt.interior_roof) collisionWorlds.push(optionalWorlds.interior_roof);
    if (furnitureVisible && collisionWorldBuilt.furniture) collisionWorlds.push(optionalWorlds.furniture);
  }
  collisionWorlds.push(
    ...Object.entries(systemEnabled)
      .filter(([key, enabled]) => enabled && collisionWorldBuilt[key])
      .map(([key]) => optionalWorlds[key]),
  );
  // Creative flight through the cutaway must be able to cross the removed
  // roof. Normal walking and ordinary flight keep the existing collision map.
  activeCollisionWorlds = roofCutaway && (flying || cutawayDropThrough) ? [] : collisionWorlds;
}

function setShadeSystem(key, visible) {
  if (!(key in systemEnabled)) return;
  systemEnabled[key]=visible;
  model?.traverse(o=>{if(o.userData.system_option===key)o.visible=visible;});
  refreshActiveCollisionWorlds();
}

function applyInteriorVisibility() {
  model?.traverse(object => {
    const group = object.userData.group;
    if (BARE_SHELL_GROUPS.has(group) && group !== '06') object.visible = !bareShell;
    if (group === '06') object.visible = !bareShell && furnitureVisible;
  });
}

function setBareShell(enabled) {
  bareShell = Boolean(enabled);
  applyInteriorVisibility();
  refreshActiveCollisionWorlds();
  render();
}

function setFurnitureVisibility(visible) {
  furnitureVisible = Boolean(visible);
  applyInteriorVisibility();
  refreshActiveCollisionWorlds();
  render();
}

function prepareRoofCutawayMaterials(root) {
  roofCutawayMaterials = [];
  root.traverse(object => {
    // Group 07 contains the garden planting, including all tree foliage and
    // trunks. Keep it un-clipped so trees remain visible from above.
    if (!object.isMesh || object.userData.group === '07' || !object.material) return;
    const source = Array.isArray(object.material) ? object.material : [object.material];
    const clipped = source.map(material => {
      const clone = material.clone();
      clone.clippingPlanes = [];
      clone.clipShadows = true;
      roofCutawayMaterials.push(clone);
      return clone;
    });
    object.material = Array.isArray(object.material) ? clipped : clipped[0];
  });
}

function setRoofCutaway(enabled) {
  roofCutaway = Boolean(enabled);
  cutawayDropThrough = roofCutaway && !flying
    && capsule.start.y - RADIUS > ROOF_CUTAWAY_HEIGHT;
  renderer.localClippingEnabled = roofCutaway;
  for (const material of roofCutawayMaterials) {
    material.clippingPlanes = roofCutaway ? [roofCutawayPlane] : [];
  }
  refreshActiveCollisionWorlds();
  render();
}

function setFlying(enabled) {
  const wasFlying = flying;
  flying = Boolean(enabled);
  if (flying) cutawayDropThrough = false;
  else if (roofCutaway && wasFlying && capsule.start.y - RADIUS > ROOF_CUTAWAY_HEIGHT) {
    // Let a creative-flight descent pass the clipped roof edge before
    // restoring ordinary wall/floor collisions below the opening.
    cutawayDropThrough = true;
  }
  refreshActiveCollisionWorlds();
}

document.querySelector('#roof-cutaway')?.addEventListener('change', event => {
  setRoofCutaway(event.target.checked);
});

const capsule = new Capsule(
  new THREE.Vector3(),
  new THREE.Vector3(),
  RADIUS,
);
const velocity = new THREE.Vector3();
const keys = new Set();
let testGamepad = null;
let activeGamepad = null;
let activeGamepadIdentity = '';
let lastGamepadJumpTime = -Infinity;
let gamepadCircleDownAt = -Infinity;
let gamepadInfo = {
  connected: false,
  id: '',
  index: null,
  mapping: '',
  axes: [0, 0, 0, 0],
  triggers: [0, 0],
};

let ready = false;
let mode = 'loading';
let grounded = false;
let jumpQueued = false;
let flying = false;
let runningToggled = false;
let gamepadRunHeld = false;
let lastForwardTap = -Infinity;
let lastGamepadForwardTap = -Infinity;
let gamepadForwardHeld = false;
const touchInput = { forward: 0, strafe: 0, jumpHeld: false, jumpPressed: false, descendHeld: false };
let touchMovePointerId = null;
let touchLookPointerId = null;
let touchJumpPointerId = null;
let touchDescendPointerId = null;
let lastTouchLookX = 0;
let lastTouchLookY = 0;
let lastTouchJumpTime = -Infinity;
let lastSpaceTap = -Infinity;
const DOUBLE_TAP_MS = 280;
let dragging = false;
let dragFallback = false;
let lastTime = performance.now();
let yaw = 0;
let pitch = 0;
let model;
let roofCutawayMaterials = [];
let viewTools;
let triangleCount = 0;
let totalCollisionTriangles = 0;
let sourceCollisionTriangles = 0;
let collisionChunksIndexed = 0;
let collisionProgressHideTimer = null;
let lastHit = null;
let recording = false;
let recordingSamples = [];
let recordingDuration = 0;
let recordingAccumulator = 0;
let lastSavedPath = null;
let renderViewActive = false;
let renderViewWasPlaying = false;
let renderViewJob = null;
let renderViewPollTimer = null;
let hudToastTimer = null;
const PATH_SAMPLE_INTERVAL = 0.1;
const PATH_STORAGE_KEY = 'dream-home.walkthrough-path.v1';
const VIEW_STATE_FIELDS = [
  ['labels', 'labels'],
  ['id-labels', 'ids'],
  ['area-labels', 'areas'],
  ['square-grid', 'square_grid'],
  ['radial-grid', 'radial_grid'],
  ['height-grid', 'height_grid'],
  ['wall-lengths', 'wall_lengths'],
  ['door-canopies', 'door_canopies'],
  ['ring-awning', 'ring_awning'],
  ['roof-cutaway', 'roof_cutaway'],
  ['bare-shell', 'bare_shell'],
  ['furniture-toggle', 'furniture_visible'],
  ['projectiles-toggle', 'projectiles_enabled'],
];

function captureViewState() {
  const state = {};
  for (const [id, key] of VIEW_STATE_FIELDS) {
    state[key] = Boolean(document.querySelector(`#${id}`)?.checked);
  }
  state.time_of_day = Number(document.querySelector('#time-of-day')?.value ?? 15);
  state.exterior_finish = document.querySelector('#exterior-finish')?.value || 'plain';
  state.roof_cutaway_height_feet = ROOF_CUTAWAY_HEIGHT / FT;
  return state;
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function showHudToast(message) {
  const toast = document.querySelector('#capture-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(hudToastTimer);
  hudToastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function downloadCanvasScreenshot(blob) {
  if (!blob) {
    showHudToast('Screenshot could not be read from the canvas.');
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `dream-home-screenshot-${timestampForFile()}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showHudToast('Walkthrough screenshot saved.');
}

function captureBrowserScreenshot() {
  if (!ready) return;
  // Render immediately before reading the canvas. This keeps the shortcut
  // useful even when the animation loop is between frames.
  renderer.render(scene, camera);
  if (canvas.toBlob) {
    canvas.toBlob(downloadCanvasScreenshot, 'image/png');
  } else {
    try {
      const data = canvas.toDataURL('image/png');
      const response = fetch(data).then(result => result.blob());
      response.then(downloadCanvasScreenshot).catch(() => showHudToast('Screenshot could not be read from the canvas.'));
    } catch {
      showHudToast('Screenshot could not be read from the canvas.');
    }
  }
}

function currentViewRenderRequest() {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  return {
    schema: 'dream-home-view-render/v1',
    camera_position_ft: [
      +(camera.position.x / FT).toFixed(5),
      +(camera.position.y / FT).toFixed(5),
      +(-camera.position.z / FT).toFixed(5),
    ],
    camera_forward: [
      +forward.x.toFixed(6),
      +forward.y.toFixed(6),
      +(-forward.z).toFixed(6),
    ],
    field_of_view_degrees: camera.fov,
    viewport_aspect_ratio: innerWidth / Math.max(1, innerHeight),
    view_state: captureViewState(),
    width: 640,
    height: Math.max(320, Math.min(640, Math.round(640 * innerHeight / Math.max(1, innerWidth) / 2) * 2)),
  };
}

function setRenderViewStatus(message, readyState = false) {
  const status = document.querySelector('#render-view-status');
  if (status) status.textContent = message;
  const image = document.querySelector('#render-view-image');
  if (image && !readyState) image.hidden = true;
  const download = document.querySelector('#render-view-download');
  if (download && !readyState) download.hidden = true;
}

function requestPointerCapture() {
  try {
    canvas.requestPointerLock()?.catch(() => {
      dragFallback = true;
      document.querySelector('#hint').textContent = 'Hold mouse to look · Esc releases mouse';
    });
  } catch {
    dragFallback = true;
    document.querySelector('#hint').textContent = 'Hold mouse to look · Esc releases mouse';
  }
}

function closeRenderedView(resumeWalking = renderViewWasPlaying) {
  if (!renderViewActive) return;
  renderViewActive = false;
  renderViewJob = null;
  clearTimeout(renderViewPollTimer);
  renderViewPollTimer = null;
  document.body.classList.remove('render-view-open');
  const overlay = document.querySelector('#render-view-overlay');
  if (overlay) overlay.hidden = true;
  if (ready) {
    mode = 'playing';
    menu.hidden = true;
    hud.hidden = false;
    document.body.classList.add('playing');
    document.body.classList.remove('hud-options-open');
    lastTime = performance.now();
    canvas.focus();
    if (resumeWalking) requestPointerCapture();
    else dragFallback = true;
  }
  render();
}

async function pollRenderedView() {
  if (!renderViewActive || !renderViewJob) return;
  try {
    const response = await fetch(`${renderViewJob.status_url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`status HTTP ${response.status}`);
    const status = await response.json();
    if (status.state === 'complete') {
      const image = document.querySelector('#render-view-image');
      const download = document.querySelector('#render-view-download');
      if (image) {
        image.src = `${status.image_url}?t=${Date.now()}`;
        image.hidden = false;
      }
      if (download) {
        download.href = status.download_url;
        download.download = `dream-home-rendered-view-${timestampForFile()}.png`;
        download.hidden = false;
      }
      setRenderViewStatus(`Rendered with Eevee in ${Number(status.render_seconds || 0).toFixed(1)} seconds.`, true);
      return;
    }
    if (status.state === 'error') {
      setRenderViewStatus(`Render failed: ${status.message || 'unknown Blender error'}`);
      return;
    }
    setRenderViewStatus(status.message || 'Blender is rendering this view…');
    renderViewPollTimer = setTimeout(pollRenderedView, 700);
  } catch (error) {
    setRenderViewStatus(`Waiting for the local render worker… ${error.message}`);
    renderViewPollTimer = setTimeout(pollRenderedView, 1200);
  }
}

async function requestRenderedView() {
  if (!viewRenderEnabled || !ready || renderViewActive) return;
  renderViewActive = true;
  renderViewWasPlaying = mode === 'playing';
  document.body.classList.add('render-view-open');
  document.body.classList.remove('hud-options-open');
  const overlay = document.querySelector('#render-view-overlay');
  if (overlay) overlay.hidden = false;
  const image = document.querySelector('#render-view-image');
  if (image) { image.hidden = true; image.removeAttribute('src'); }
  const download = document.querySelector('#render-view-download');
  if (download) download.hidden = true;
  setRenderViewStatus('Starting the local Eevee render…');
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  render();
  try {
    const response = await fetch('/render-view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentViewRenderRequest()),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    renderViewJob = result;
    setRenderViewStatus('Blender is rendering this view…');
    pollRenderedView();
  } catch (error) {
    setRenderViewStatus(`Could not start the render: ${error.message}`);
  }
}

const spawns = {
  hall: [23, 110, 80],
  // Place the default character inside the living-room arc, facing inward
  // toward the garden hallway rather than in the east entry wedge.
  living: [34, 345, 345],
  kitchen: [40, 196, 184],
  game: [30,45,45],
  garden: [17, 90, 15],
  master: [30, 99, 99],
  bedroom: [37.5, 261, 261],
  outside: [53, 0, 180],
};

function setLoadStatus(message) {
  status.textContent = message;
  const loadingStatus = document.querySelector('#loading-status');
  if (loadingStatus) loadingStatus.textContent = message;
  console.info(`[Dream Home] ${message}`);
}

function updateCollisionProgress(processed, total, phase, complete = false) {
  const panel = document.querySelector('#collision-progress');
  const label = document.querySelector('#collision-progress-label');
  const bar = document.querySelector('#collision-progress-bar');
  if (!panel || !label || !bar || total <= 0) {
    if (panel) panel.hidden = true;
    return;
  }

  clearTimeout(collisionProgressHideTimer);
  const count = Math.min(processed, total);
  const percent = complete ? 100 : Math.min(99.9, count / total * 100);
  bar.value = percent;
  label.textContent = complete
    ? `Collision maps ready · ${total.toLocaleString()} triangles (${sourceCollisionTriangles.toLocaleString()} source)`
    : `${phase} · ${collisionChunksIndexed} batches · ${count.toLocaleString()} / ${total.toLocaleString()} (${percent.toFixed(1)}%)`;
  bar.setAttribute('aria-valuetext', complete
    ? `${total.toLocaleString()} collision triangles indexed from ${sourceCollisionTriangles.toLocaleString()} source triangles`
    : `${phase}; ${count.toLocaleString()} of ${total.toLocaleString()} triangles indexed; ${percent.toFixed(1)} percent`);
  panel.hidden = false;
  if (complete) {
    collisionProgressHideTimer = setTimeout(() => { panel.hidden = true; }, 2400);
  }
}

function applyGamepadDeadzone(value) {
  const magnitude = Math.abs(value);
  if (magnitude <= GAMEPAD_DEADZONE) return 0;
  const remapped = (magnitude - GAMEPAD_DEADZONE) / (1 - GAMEPAD_DEADZONE);
  return Math.sign(value) * Math.min(1, remapped);
}

function gamepadLabel(gamepad) {
  if (!gamepad) return 'Controller not detected';
  const id = (gamepad.id || 'Game controller').replace(/\s+/g, ' ').trim();
  return id.length > 36 ? `${id.slice(0, 35)}…` : id;
}

function touchControlsActive() {
  return hasTouchHardware && ready && mode === 'playing' && !gamepadInfo.connected;
}

function clearTouchInput() {
  touchInput.forward = 0;
  touchInput.strafe = 0;
  touchInput.jumpHeld = false;
  touchInput.jumpPressed = false;
  touchInput.descendHeld = false;
  touchMovePointerId = null;
  touchLookPointerId = null;
  touchJumpPointerId = null;
  touchDescendPointerId = null;
  const nub = document.querySelector('#touch-move-nub');
  if (nub) nub.style.transform = 'translate(-50%, -50%)';
}

function updateTouchActionButtons() {
  const jump = document.querySelector('#touch-jump');
  const descend = document.querySelector('#touch-descend');
  const run = document.querySelector('#touch-run');
  const record = document.querySelector('#touch-record');
  if (jump) {
    jump.textContent = flying ? 'UP' : 'JUMP';
    jump.setAttribute('aria-label', flying ? 'Ascend while flying' : 'Jump; double-tap to toggle flight');
  }
  if (descend) descend.hidden = !flying;
  if (run) {
    run.textContent = runningToggled ? 'RUN' : 'WALK';
    run.setAttribute('aria-label', `Toggle run; currently ${runningToggled ? 'running' : 'walking'}`);
  }
  if (record) {
    record.textContent = recording ? 'STOP' : 'REC';
    record.classList.toggle('recording', recording);
    record.setAttribute('aria-label', recording ? 'Stop and save path recording' : 'Start path recording');
    record.setAttribute('aria-pressed', String(recording));
  }
}

function updateTouchControlsVisibility() {
  const active = touchControlsActive();
  const controls = document.querySelector('#touch-controls');
  if (controls) controls.hidden = !active;
  document.body.classList.toggle('touch-walkthrough', active);
  if (!active) clearTouchInput();
  updateTouchActionButtons();
  const controllerStatus = document.querySelector('#gamepad-menu-status');
  if (controllerStatus && !gamepadInfo.connected) {
    controllerStatus.textContent = hasTouchHardware
      ? 'Controller not detected · touch controls active'
      : 'Controller not detected';
  }
}

function setGamepadInfo(gamepad) {
  const nextIdentity = gamepad
    ? `${gamepad.index ?? 0}:${gamepad.id || 'Game controller'}`
    : '';
  if (nextIdentity === activeGamepadIdentity && !!gamepad === !!activeGamepad) return;
  activeGamepad = gamepad || null;
  activeGamepadIdentity = nextIdentity;
  gamepadInfo = gamepad
    ? {
      connected: true,
      id: gamepad.id || 'Game controller',
      index: gamepad.index ?? 0,
      mapping: gamepad.mapping || '',
      axes: Array.from(gamepad.axes || []).slice(0, 4).map(value => +Number(value || 0).toFixed(3)),
      triggers: [
        +Number(gamepad.buttons?.[6]?.value || 0).toFixed(3),
        +Number(gamepad.buttons?.[7]?.value || 0).toFixed(3),
      ],
    }
    : { connected: false, id: '', index: null, mapping: '', axes: [0, 0, 0, 0], triggers: [0, 0] };
  const text = gamepad
    ? `${gamepadLabel(gamepad)} · sticks move/look · Options HUD · Create screenshot`
    : 'Controller not detected';
  for (const id of ['gamepad-status', 'gamepad-menu-status']) {
    const element = document.querySelector(`#${id}`);
    if (!element) continue;
    element.textContent = text;
    element.hidden = !gamepad && id === 'gamepad-status';
  }
  updateTouchControlsVisibility();
  render();
}

function findGamepad() {
  if (testGamepad) return testGamepad;
  if (!navigator.getGamepads) return null;
  const pads = Array.from(navigator.getGamepads() || []).filter(Boolean);
  if (activeGamepad && pads[activeGamepad.index]?.connected) return pads[activeGamepad.index];
  return pads.find(pad => pad.connected) || null;
}

function pollGamepad() {
  const gamepad = findGamepad();
  setGamepadInfo(gamepad);
  if (!gamepad) {
    return {
      forward: 0,
      strafe: 0,
      lookX: 0,
      lookY: 0,
      jumpHeld: false,
      jumpPressed: false,
      runHeld: false,
      runTogglePressed: false,
      descendHeld: false,
      circlePressed: false,
      circleReleased: false,
      bareShellPressed: false,
      furniturePressed: false,
      hudPressed: false,
      dpadUpPressed: false,
      dpadDownPressed: false,
      dpadLeftPressed: false,
      dpadRightPressed: false,
      bulletHeld: false,
      bulletPressed: false,
      fireballHeld: false,
      fireballPressed: false,
      screenshotPressed: false,
    };
  }

  const axes = gamepad.axes || [];
  const leftX = applyGamepadDeadzone(Number(axes[0] || 0));
  const leftY = applyGamepadDeadzone(Number(axes[1] || 0));
  const rightX = applyGamepadDeadzone(Number(axes[2] || 0));
  const rightY = applyGamepadDeadzone(Number(axes[3] || 0));
  const pressed = index => !!gamepad.buttons?.[index]?.pressed;
  const jumpHeld = pressed(0); // Cross on a standard DualSense mapping.
  const circleHeld = pressed(1); // Circle descends while flying; a tap cuts the roof away.
  const squareHeld = pressed(2); // Square toggles the bare-shell study.
  const triangleHeld = pressed(3); // Triangle toggles furniture/equipment.
  const l1Held = pressed(4); // Front auxiliary button above the left trigger.
  const r1Held = pressed(5); // Front auxiliary button above the right trigger.
  const triggerValue = index => Math.max(
    Number(gamepad.buttons?.[index]?.value || 0),
    gamepad.buttons?.[index]?.pressed ? 1 : 0,
  );
  const bulletValue = triggerValue(6);
  const fireballValue = triggerValue(7);
  const bulletHeld = bulletValue > 0.35;
  const fireballHeld = fireballValue > 0.35;
  const screenshotHeld = pressed(8); // Create/share button.
  const hudHeld = pressed(9); // Options/menu button.
  const runHeld = pressed(10); // L3.
  const previous = pollGamepad.previousButtons || [];
  const currentButtons = Array.from({ length: Math.max(16, gamepad.buttons?.length || 0) }, (_, index) => pressed(index));
  pollGamepad.previousButtons = currentButtons;
  gamepadInfo.axes = [leftX, leftY, rightX, rightY].map(value => +value.toFixed(3));
  gamepadInfo.triggers = [+bulletValue.toFixed(3), +fireballValue.toFixed(3)];
  return {
    forward: -leftY,
    strafe: leftX,
    lookX: rightX,
    lookY: rightY,
    jumpHeld,
    jumpPressed: jumpHeld && !previous[0],
    runHeld,
    runTogglePressed: l1Held && !previous[4],
    descendHeld: circleHeld,
    circlePressed: circleHeld && !previous[1],
    circleReleased: !circleHeld && !!previous[1],
    bareShellPressed: squareHeld && !previous[2],
    furniturePressed: triangleHeld && !previous[3],
    hudPressed: (r1Held && !previous[5]) || (hudHeld && !previous[9]),
    dpadUpPressed: pressed(12) && !previous[12],
    dpadDownPressed: pressed(13) && !previous[13],
    dpadLeftPressed: pressed(14) && !previous[14],
    dpadRightPressed: pressed(15) && !previous[15],
    bulletHeld,
    bulletPressed: bulletHeld && !previous[6],
    fireballHeld,
    fireballPressed: fireballHeld && !previous[7],
    screenshotPressed: screenshotHeld && !previous[8],
  };
}

window.addEventListener('gamepadconnected', event => setGamepadInfo(event.gamepad));
window.addEventListener('gamepaddisconnected', event => {
  if (!activeGamepad || activeGamepad.index === event.gamepad.index) {
    pollGamepad.previousButtons = [];
    gamepadForwardHeld = false;
    lastGamepadForwardTap = -Infinity;
    gamepadCircleDownAt = -Infinity;
    setGamepadInfo(null);
  }
});

function nextFrame() {
  // A background tab may suspend animation frames; loading must still progress.
  return new Promise(resolve => {
    let frame;
    const timer=setTimeout(()=>{cancelAnimationFrame(frame);resolve();},100);
    frame=requestAnimationFrame(()=>{clearTimeout(timer);resolve();});
  });
}

function point(r, a, y = 0) {
  a = THREE.MathUtils.degToRad(a);
  return new THREE.Vector3(
    r * FT * Math.cos(a),
    y,
    -r * FT * Math.sin(a),
  );
}

function place(name) {
  const [r, a, look] = spawns[name] || spawns.hall;
  const p = point(r, a, 0.08);

  capsule.start.copy(p).y += RADIUS;
  capsule.end.copy(p).y += HEIGHT - RADIUS;
  velocity.set(0, 0, 0);
  grounded = false;
  flying = false;
  cutawayDropThrough = false;
  runningToggled = false;
  gamepadRunHeld = false;
  lastForwardTap = -Infinity;
  lastGamepadForwardTap = -Infinity;
  gamepadForwardHeld = false;
  gamepadCircleDownAt = -Infinity;
  refreshActiveCollisionWorlds();
  lastSpaceTap = -Infinity;
  jumpQueued = false;
  keys.clear();
  pollGamepad.previousButtons = [];
  lastGamepadJumpTime = -Infinity;
  bulletCooldown = 0;
  fireballCooldown = 0;
  while (projectiles.length) removeProjectile(projectiles[0]);

  let target;
  if (name === 'hall') target = point(r, look, EYE);
  else if (name === 'living') target = point(r - 8, look, EYE);
  else if (name === 'outside') target = point(40, 0, EYE);
  else target = point(r + 4, look, EYE);

  const d = target.sub(p);
  yaw = Math.atan2(-d.x, -d.z);
  pitch = 0;
  syncCamera();
}

function syncCamera() {
  camera.position.copy(capsule.start);
  camera.position.y += EYE - RADIUS;
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}

function removeProjectile(mesh) {
  const index = projectiles.indexOf(mesh);
  if (index >= 0) projectiles.splice(index, 1);
  projectileRoot.remove(mesh);
}

function setProjectilesEnabled(enabled) {
  projectilesEnabled = Boolean(enabled);
  bulletCooldown = 0;
  fireballCooldown = 0;
  if (!projectilesEnabled) {
    while (projectiles.length) removeProjectile(projectiles[0]);
  }
  render();
}

function fireProjectile(kind) {
  if (!projectilesEnabled || !ready || mode !== 'playing') return;
  const spec = projectileSpecs[kind];
  const mesh = new THREE.Mesh(projectileGeometry[kind], projectileMaterial[kind]);
  if (kind === 'fireball') {
    const glow = new THREE.Mesh(projectileGlowGeometry, projectileGlowMaterial);
    glow.name = 'energy ball glow';
    mesh.add(glow);
    mesh.userData.glow = glow;
  }
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction).normalize();
  mesh.position.copy(camera.position).addScaledVector(direction, 0.55);
  mesh.userData.velocity = direction.multiplyScalar(spec.speed);
  mesh.userData.age = 0;
  mesh.userData.distance = 0;
  mesh.userData.bounces = 0;
  mesh.userData.radius = spec.radius;
  mesh.userData.kind = kind;
  projectileRoot.add(mesh);
  projectiles.push(mesh);
  projectileShots[kind === 'bullet' ? 'bullets' : 'fireballs'] += 1;
  while (projectiles.length > PROJECTILE_LIMIT) removeProjectile(projectiles[0]);
}

function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const mesh = projectiles[i];
    const data = mesh.userData;
    const spec = projectileSpecs[data.kind];
    if (!spec) {
      removeProjectile(mesh);
      continue;
    }

    data.age += dt;
    if (data.glow) {
      // A small pulse reads as an energy glow without allocating a light per
      // projectile (which would become expensive when the trigger is held).
      const pulse = 1 + Math.sin(data.age * 18) * 0.10;
      data.glow.scale.setScalar(pulse);
    }
    if (data.age >= spec.maxAge) {
      removeProjectile(mesh);
      continue;
    }

    if (spec.gravity) data.velocity.y += spec.gravity * dt;
    let remaining = dt;
    let alive = true;
    let sweeps = 0;
    while (alive && remaining > 1e-5 && sweeps < PROJECTILE_SWEEP_LIMIT) {
      const speed = data.velocity.length();
      if (speed <= spec.minSpeed) {
        removeProjectile(mesh);
        alive = false;
        break;
      }

      const travel = speed * remaining;
      projectileDirection.copy(data.velocity).multiplyScalar(1 / speed);
      const ray = new THREE.Ray(mesh.position, projectileDirection);
      let nearest = null;
      for (const tree of activeCollisionWorlds) {
        const collision = tree.rayIntersect(ray);
        if (!collision || collision.distance > travel + spec.radius + PROJECTILE_COLLISION_EPSILON) continue;
        if (!nearest || collision.distance < nearest.distance) nearest = collision;
      }

      if (!nearest) {
        mesh.position.addScaledVector(projectileDirection, travel);
        data.distance += travel;
        remaining = 0;
        break;
      }

      // Move the projectile's center to the point where its small sphere first
      // touches the triangle, rather than letting the mesh visibly penetrate it.
      const advance = Math.max(0, Math.min(travel, nearest.distance - spec.radius));
      mesh.position.addScaledVector(projectileDirection, advance);
      data.distance += advance;

      if (nearest.triangle?.getNormal) nearest.triangle.getNormal(projectileNormal);
      else projectileNormal.copy(projectileDirection).negate();
      if (projectileNormal.lengthSq() < 1e-8) projectileNormal.copy(projectileDirection).negate();
      else projectileNormal.normalize();
      // Choose the normal pointing away from the incoming travel direction so
      // the epsilon separation is outside the surface. Reflection itself is
      // invariant under flipping the normal.
      if (projectileNormal.dot(projectileDirection) > 0) projectileNormal.negate();
      mesh.position.addScaledVector(projectileNormal, PROJECTILE_COLLISION_EPSILON);

      data.bounces += 1;
      if (data.bounces > spec.maxBounces) {
        removeProjectile(mesh);
        alive = false;
        break;
      }

      // Preserve some tangent motion while reducing the normal component. This
      // gives bullets a sharper ricochet and makes fireballs settle sooner.
      const normalSpeed = data.velocity.dot(projectileNormal);
      projectileNormalPart.copy(projectileNormal).multiplyScalar(normalSpeed);
      projectileTangentPart.copy(data.velocity).sub(projectileNormalPart).multiplyScalar(spec.tangentDamping);
      data.velocity.copy(projectileTangentPart).addScaledVector(projectileNormal, -normalSpeed * spec.restitution);

      if (data.velocity.length() <= spec.minSpeed) {
        removeProjectile(mesh);
        alive = false;
        break;
      }

      // Avoid repeatedly resolving the same coplanar triangle if the sphere
      // started exactly on its surface.
      const consumed = advance / speed;
      remaining -= Math.max(consumed, 0.0001);
      sweeps += 1;
    }

    if (alive && data.distance >= spec.maxDistance) {
      removeProjectile(mesh);
    }
  }
}

function handleProjectileInput(gamepad, dt) {
  bulletCooldown = Math.max(0, bulletCooldown - dt);
  fireballCooldown = Math.max(0, fireballCooldown - dt);
  if ((gamepad.bulletPressed || gamepad.bulletHeld) && bulletCooldown <= 0) {
    fireProjectile('bullet');
    bulletCooldown = 0.12;
  }
  if ((gamepad.fireballPressed || gamepad.fireballHeld) && fireballCooldown <= 0) {
    fireProjectile('fireball');
    fireballCooldown = 0.28;
  }
}

function currentPathSample(timeSeconds) {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  return {
    t_seconds: +timeSeconds.toFixed(3),
    feet_position_ft: [
      +(capsule.start.x / FT).toFixed(4),
      +((capsule.start.y - RADIUS) / FT).toFixed(4),
      +(-capsule.start.z / FT).toFixed(4),
    ],
    camera: {
      yaw_radians: +yaw.toFixed(6),
      pitch_radians: +pitch.toFixed(6),
      // This is in the same +X east, +Y up, +Z north convention as the path position.
      forward: [+forward.x.toFixed(6), +forward.y.toFixed(6), +(-forward.z).toFixed(6)],
    },
    flying,
  };
}

function updateRecordingUI(message = null) {
  const badge = document.querySelector('#recording-badge');
  const count = document.querySelector('#recording-count');
  const panel = document.querySelector('#recording-panel-status');
  if (badge) badge.hidden = !recording;
  if (count) count.textContent = `${recordingSamples.length} samples`;
  if (panel) {
    panel.textContent = message || (recording
      ? `Recording path · ${recordingSamples.length} samples · R stops and saves it.`
      : lastSavedPath ? `Saved ${lastSavedPath.samples} samples. R starts a new path.`
        : 'R starts a new path recording; R stops and saves it.');
  }
}

function startRecording() {
  if (!ready || recording) return;
  recording = true;
  recordingSamples = [];
  recordingDuration = 0;
  recordingAccumulator = 0;
  recordingSamples.push(currentPathSample(0));
  updateRecordingUI();
  render();
}

function stopRecording() {
  if (!recording) return lastSavedPath;
  recording = false;
  recordingSamples.push(currentPathSample(recordingDuration));
  const payload = {
    schema: 'dream-home-walkthrough-path/v1',
    model: 'Dream Home v07',
    recorded_at: new Date().toISOString(),
    units: 'feet',
    coordinate_system: '+X east, +Y up, +Z north; courtyard center is origin',
    character: {
      height_feet: 6,
      eye_height_feet: EYE / FT,
      field_of_view_degrees: camera.fov,
      walking_speed_mps: 3.5,
      running_speed_mps: 7,
    },
    // Preserve every HUD control alongside the path so a renderer can
    // reproduce the state in which the owner recorded the walkthrough.
    view_state: captureViewState(),
    sample_interval_seconds: PATH_SAMPLE_INTERVAL,
    duration_seconds: +recordingDuration.toFixed(3),
    samples: recordingSamples,
  };
  const serialized = JSON.stringify(payload, null, 2);
  try { localStorage.setItem(PATH_STORAGE_KEY, serialized); } catch (error) { console.warn('[Dream Home] Could not cache path:', error); }
  const stamp = payload.recorded_at.replace(/[:.]/g, '-');
  try {
    const blob = new Blob([serialized], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dream-home-walkthrough-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (error) { console.warn('[Dream Home] Could not download path:', error); }
  lastSavedPath = { samples: recordingSamples.length, duration_seconds: payload.duration_seconds, recorded_at: payload.recorded_at };
  updateRecordingUI(`Saved ${recordingSamples.length} samples (${payload.duration_seconds.toFixed(1)} seconds). R starts a new path.`);
  render();
  return payload;
}

function advanceRecording(dt) {
  if (!recording) return;
  recordingAccumulator += dt;
  while (recordingAccumulator >= PATH_SAMPLE_INTERVAL) {
    recordingAccumulator -= PATH_SAMPLE_INTERVAL;
    recordingDuration += PATH_SAMPLE_INTERVAL;
    recordingSamples.push(currentPathSample(recordingDuration));
  }
  updateRecordingUI();
}

function toggleHudOptions() {
  if (!ready) return;
  document.body.classList.toggle('hud-options-open');
  render();
}

const keyboardMap = document.querySelector('.keyboard-map');
if (keyboardMap && !keyboardMap.textContent.includes('Create')) {
  keyboardMap.insertAdjacentHTML('beforeend', viewRenderEnabled
    ? '<span>Create / C screenshot&nbsp;&nbsp; V Eevee view render</span>'
    : '<span>Create / C screenshot</span>');
}

const keyboardCheckboxes = {
  Digit1: 'labels', Digit2: 'id-labels', Digit3: 'area-labels',
  Digit4: 'square-grid', Digit5: 'radial-grid', Digit6: 'height-grid',
  Digit7: 'wall-lengths', Digit8: 'door-canopies', Digit9: 'ring-awning',
  Digit0: 'roof-cutaway',
  KeyB: 'bare-shell', KeyM: 'furniture-toggle',
  KeyP: 'projectiles-toggle',
};

const GRID_PRESETS = [
  { label: 'Off', values: { 'square-grid': false, 'radial-grid': false } },
  { label: 'Square grid', values: { 'square-grid': true, 'radial-grid': false } },
  { label: 'Square + radial grids', values: { 'square-grid': true, 'radial-grid': true } },
  { label: 'Radial grid', values: { 'square-grid': false, 'radial-grid': true } },
];
const LABEL_PRESETS = [
  { label: 'No labels', values: { labels: false, 'id-labels': false, 'area-labels': false, 'wall-lengths': false } },
  { label: 'Room names', values: { labels: true, 'id-labels': false, 'area-labels': false, 'wall-lengths': false } },
  { label: 'Names + IDs', values: { labels: true, 'id-labels': true, 'area-labels': false, 'wall-lengths': false } },
  { label: 'Names + IDs + areas', values: { labels: true, 'id-labels': true, 'area-labels': true, 'wall-lengths': false } },
  { label: 'All room information', values: { labels: true, 'id-labels': true, 'area-labels': true, 'wall-lengths': true } },
  { label: 'Names + areas', values: { labels: true, 'id-labels': false, 'area-labels': true, 'wall-lengths': false } },
];

function toggleCheckbox(id) {
  const input = document.querySelector(`#${id}`);
  if (!input || input.disabled) return;
  input.click();
}

function cycleCheckboxPreset(presets, direction, groupName) {
  const ids = Object.keys(presets[0].values);
  const current = Object.fromEntries(ids.map(id => [id, Boolean(document.querySelector(`#${id}`)?.checked)]));
  let currentIndex = 0;
  let closestDistance = Infinity;
  presets.forEach((preset, index) => {
    const distance = ids.reduce((total, id) => total + Number(preset.values[id] !== current[id]), 0);
    if (distance < closestDistance) {
      currentIndex = index;
      closestDistance = distance;
    }
  });

  const nextIndex = (currentIndex + direction + presets.length) % presets.length;
  const next = presets[nextIndex];
  for (const id of ids) {
    const input = document.querySelector(`#${id}`);
    if (input && input.checked !== next.values[id]) input.click();
  }
  showHudToast(`${groupName}: ${next.label}`);
}

function nudgeTime(amount) {
  const input = document.querySelector('#time-of-day');
  if (!input) return;
  input.value = String(THREE.MathUtils.clamp(Number(input.value) + amount, 0, 24));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function roomName() {
  const reference = viewTools?.currentRoom(capsule.start.x, capsule.start.z);
  if (reference && !['R27', 'R28'].includes(reference.id)) return reference.name;
  const x = capsule.start.x / FT;
  const y = -capsule.start.z / FT;
  const r = Math.hypot(x, y);
  const a = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

  if (r < 14) return 'Courtyard garden';
  if (r < 20) return 'Garden walkway';
  if (r > 50) return 'Outside walkway';
  if (r < 26) return 'Garden hallway';
  if (a >= 72 && a < 90) return r < 38 ? 'Master closet' : 'Master bathroom';
  if (a >= 90 && a < 108) return 'J + F · master bedroom';
  if (a >= 54 && a < 72) return 'Jason’s office';
  if (a >= 108 && a < 126) return 'Fang’s office';
  if (a >= 126 && a < 144) return 'Storage / stairs';
  if (a >= 144 && a < 162) return r < 38 ? 'West utility room' : 'Storage';
  if (a >= 18 && a < 36) return r < 38 ? 'East utility room' : 'Laundry';
  if (a >= 36 && a < 54) return r < 38 ? 'Flex space' : 'Study';

  if (a >= 234 && a < 306) {
    const n = Math.floor((a - 234) / 18) + 1;
    return r < 35 ? `Bedroom ${n} · entry / closet` : `Bedroom ${n}`;
  }

  if (((a >= 216 && a < 234) || (a >= 306 && a < 324)) && r < 38) {
    return 'Shared bathroom';
  }

  if (a >= 162 && a < 234) {
    return a > 210 ? 'Dining room' : a < 183 ? 'West entry' : 'Kitchen';
  }

  return a < 12 || a > 355
    ? 'East entry'
    : a > 306 && a < 326
      ? 'TV area'
      : 'Living room';
}

document.querySelector('#labels').addEventListener('change', e => {
  if (model) {
    model.traverse(o => {
      if (o.userData.group === '10') o.visible = e.target.checked;
    });
  }
  render();
});

document.querySelector('#bare-shell').addEventListener('change', event => {
  setBareShell(event.target.checked);
});

document.querySelector('#furniture-toggle').addEventListener('change', event => {
  setFurnitureVisibility(event.target.checked);
});

document.querySelector('#projectiles-toggle').addEventListener('change', event => {
  setProjectilesEnabled(event.target.checked);
});

document.querySelector('#render-view-btn').addEventListener('click', requestRenderedView);
document.querySelector('#render-view-close').addEventListener('click', () => closeRenderedView(true));

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    dragFallback = false;
    document.querySelector('#hint').textContent = `H / Options · C screenshot${viewRenderEnabled ? ' · V render' : ''}`;
  } else if (mode === 'playing' && !renderViewActive) {
    dragFallback = true;
    document.querySelector('#hint').textContent = 'Hold mouse to look · Esc releases mouse';
  }
});

document.addEventListener('mousemove', e => {
  if (mode !== 'playing' || !(document.pointerLockElement === canvas || dragging)) return;

  yaw -= e.movementX * 0.0022;
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.0022, -1.48, 1.48);
  syncCamera();
});

document.addEventListener('mouseup', () => dragging = false);

canvas.tabIndex = 0;
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousedown', () => {
  if (dragFallback && mode === 'playing') {
    dragging = true;
    requestPointerCapture();
  }
});

const touchMovePad = document.querySelector('#touch-move-pad');
const touchMoveNub = document.querySelector('#touch-move-nub');

function updateTouchMove(event) {
  if (!touchMovePad || event.pointerId !== touchMovePointerId || !touchControlsActive()) return;
  const bounds = touchMovePad.getBoundingClientRect();
  const radius = bounds.width * 0.31;
  let dx = event.clientX - (bounds.left + bounds.width / 2);
  let dy = event.clientY - (bounds.top + bounds.height / 2);
  const distance = Math.hypot(dx, dy);
  if (distance > radius) {
    dx *= radius / distance;
    dy *= radius / distance;
  }
  const remap = value => Math.abs(value) <= 0.12
    ? 0
    : Math.sign(value) * (Math.abs(value) - 0.12) / 0.88;
  touchInput.strafe = remap(dx / radius);
  touchInput.forward = remap(-dy / radius);
  if (touchMoveNub) touchMoveNub.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}

touchMovePad?.addEventListener('pointerdown', event => {
  if (!touchControlsActive()) return;
  event.preventDefault();
  touchMovePointerId = event.pointerId;
  try { touchMovePad.setPointerCapture(event.pointerId); } catch {}
  updateTouchMove(event);
});

canvas.addEventListener('pointerdown', event => {
  if (!touchControlsActive() || event.clientX < innerWidth * 0.42) return;
  event.preventDefault();
  touchLookPointerId = event.pointerId;
  lastTouchLookX = event.clientX;
  lastTouchLookY = event.clientY;
  try { canvas.setPointerCapture(event.pointerId); } catch {}
});

document.addEventListener('pointermove', event => {
  if (event.pointerId === touchMovePointerId) {
    event.preventDefault();
    updateTouchMove(event);
  }
  if (event.pointerId === touchLookPointerId && touchControlsActive()) {
    const dx = event.clientX - lastTouchLookX;
    const dy = event.clientY - lastTouchLookY;
    lastTouchLookX = event.clientX;
    lastTouchLookY = event.clientY;
    yaw -= dx * 0.0032;
    pitch = THREE.MathUtils.clamp(pitch - dy * 0.0032, -1.48, 1.48);
    syncCamera();
  }
});

function releaseTouchPointer(event) {
  if (event.pointerId === touchMovePointerId) {
    touchMovePointerId = null;
    touchInput.forward = 0;
    touchInput.strafe = 0;
    if (touchMoveNub) touchMoveNub.style.transform = 'translate(-50%, -50%)';
  }
  if (event.pointerId === touchLookPointerId) touchLookPointerId = null;
  if (event.pointerId === touchJumpPointerId) {
    touchJumpPointerId = null;
    touchInput.jumpHeld = false;
  }
  if (event.pointerId === touchDescendPointerId) {
    touchDescendPointerId = null;
    touchInput.descendHeld = false;
  }
}
document.addEventListener('pointerup', releaseTouchPointer);
document.addEventListener('pointercancel', releaseTouchPointer);

document.querySelector('#touch-jump')?.addEventListener('pointerdown', event => {
  if (!touchControlsActive()) return;
  event.preventDefault();
  touchJumpPointerId = event.pointerId;
  touchInput.jumpHeld = true;
  touchInput.jumpPressed = true;
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
});

document.querySelector('#touch-descend')?.addEventListener('pointerdown', event => {
  if (!touchControlsActive() || !flying) return;
  event.preventDefault();
  touchDescendPointerId = event.pointerId;
  touchInput.descendHeld = true;
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
});

document.querySelector('#touch-run')?.addEventListener('click', () => {
  if (!touchControlsActive()) return;
  runningToggled = !runningToggled;
  updateMovementBadge();
  updateTouchActionButtons();
});

document.querySelector('#touch-hud')?.addEventListener('click', () => {
  if (touchControlsActive()) toggleHudOptions();
});

document.querySelector('#touch-record')?.addEventListener('click', () => {
  if (!touchControlsActive()) return;
  if (recording) stopRecording();
  else startRecording();
  updateTouchActionButtons();
});

const movement = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowLeft',
  'ArrowDown',
  'ArrowRight',
  'Space',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
]);

document.addEventListener('keydown', e => {
  if (e.code === 'Escape') {
    if (renderViewActive) closeRenderedView(true);
    else if (document.pointerLockElement === canvas) document.exitPointerLock();
    return;
  }

  if (!ready) return;

  if (e.code === 'KeyC' && !e.repeat) {
    e.preventDefault();
    captureBrowserScreenshot();
    return;
  }

  if (e.code === 'KeyV' && !e.repeat) {
    e.preventDefault();
    if (viewRenderEnabled) requestRenderedView();
    return;
  }

  if (renderViewActive && movement.has(e.code)) {
    e.preventDefault();
    closeRenderedView(true);
    keys.add(e.code);
    return;
  }

  if (e.code === 'KeyH' && !e.repeat) {
    e.preventDefault();
    toggleHudOptions();
    return;
  }

  if (e.code === 'KeyR' && !e.repeat) {
    e.preventDefault();
    if (recording) stopRecording();
    else startRecording();
    return;
  }

  if (keyboardCheckboxes[e.code] && !e.repeat) {
    e.preventDefault();
    toggleCheckbox(keyboardCheckboxes[e.code]);
    return;
  }

  if (e.code === 'BracketLeft' && !e.repeat) {
    e.preventDefault();
    nudgeTime(-0.25);
    return;
  }

  if (e.code === 'BracketRight' && !e.repeat) {
    e.preventDefault();
    nudgeTime(0.25);
    return;
  }

  if (renderViewActive) return;
  if (mode !== 'playing') return;
  if (movement.has(e.code)) e.preventDefault();

  if ((e.code === 'KeyW' || e.code === 'ArrowUp') && !e.repeat) {
    if (e.timeStamp - lastForwardTap <= RUN_DOUBLE_TAP_MS) {
      runningToggled = !runningToggled;
      lastForwardTap = -Infinity;
    } else {
      lastForwardTap = e.timeStamp;
    }
  }

  if (e.code === 'KeyF' && !e.repeat) {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  if (e.code === 'Space' && !e.repeat) {
    if (e.timeStamp - lastSpaceTap <= DOUBLE_TAP_MS) {
      setFlying(!flying);
      grounded = false;
      velocity.y = 0;
      jumpQueued = false;
      lastSpaceTap = -Infinity; // A third tap is the start of a new pair.
    } else {
      lastSpaceTap = e.timeStamp;
      if (!flying) jumpQueued = true;
    }
  }
  keys.add(e.code);
});

document.addEventListener('keyup', e => keys.delete(e.code));
function clearTransientInput() {
  keys.clear();
  dragging = false;
  clearTouchInput();
}
window.addEventListener('blur', clearTransientInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTransientInput();
});

function step(dt) {
  if (!ready) return;
  const gamepad = pollGamepad();
  if (gamepad.screenshotPressed) captureBrowserScreenshot();
  if (gamepad.hudPressed && !renderViewActive) toggleHudOptions();
  if (renderViewActive) {
    const moving = Math.abs(gamepad.forward) > 0.25
      || Math.abs(gamepad.strafe) > 0.25
      || Math.abs(gamepad.lookX) > 0.25
      || Math.abs(gamepad.lookY) > 0.25
      || gamepad.jumpHeld;
    if (moving) closeRenderedView(true);
    return;
  }
  if (mode !== 'playing') return;

  gamepadRunHeld = gamepad.runHeld;
  handleProjectileInput(gamepad, dt);
  if (gamepad.runTogglePressed) runningToggled = !runningToggled;
  if (touchInput.jumpPressed) {
    const now = performance.now();
    if (now - lastTouchJumpTime <= DOUBLE_TAP_MS) {
      setFlying(!flying);
      grounded = false;
      velocity.y = 0;
      jumpQueued = false;
      lastTouchJumpTime = -Infinity;
    } else {
      lastTouchJumpTime = now;
      if (!flying) jumpQueued = true;
    }
    touchInput.jumpPressed = false;
  }
  const gamepadForwardPressed = gamepad.forward > 0.75 && !gamepadForwardHeld;
  if (gamepadForwardPressed) {
    const now = performance.now();
    if (now - lastGamepadForwardTap <= RUN_DOUBLE_TAP_MS) {
      runningToggled = !runningToggled;
      lastGamepadForwardTap = -Infinity;
    } else {
      lastGamepadForwardTap = now;
    }
  }
  gamepadForwardHeld = gamepad.forward > 0.25;
  if (gamepad.bareShellPressed) toggleCheckbox('bare-shell');
  if (gamepad.furniturePressed) toggleCheckbox('furniture-toggle');
  if (gamepad.dpadUpPressed) cycleCheckboxPreset(GRID_PRESETS, 1, 'Grid');
  if (gamepad.dpadDownPressed) cycleCheckboxPreset(GRID_PRESETS, -1, 'Grid');
  if (gamepad.dpadLeftPressed) cycleCheckboxPreset(LABEL_PRESETS, -1, 'Labels');
  if (gamepad.dpadRightPressed) cycleCheckboxPreset(LABEL_PRESETS, 1, 'Labels');
  if (gamepad.circlePressed) gamepadCircleDownAt = performance.now();
  if (gamepad.circleReleased) {
    const heldFor = performance.now() - gamepadCircleDownAt;
    if (heldFor >= 0 && heldFor <= GAMEPAD_TAP_MS) toggleCheckbox('roof-cutaway');
    gamepadCircleDownAt = -Infinity;
  }

  yaw -= gamepad.lookX * GAMEPAD_LOOK_SPEED * dt;
  pitch = THREE.MathUtils.clamp(pitch - gamepad.lookY * GAMEPAD_LOOK_SPEED * dt, -1.48, 1.48);

  let f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0)
    - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  let r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0)
    - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const touchActive = touchControlsActive();
  f = THREE.MathUtils.clamp(f + gamepad.forward + (touchActive ? touchInput.forward : 0), -1, 1);
  r = THREE.MathUtils.clamp(r + gamepad.strafe + (touchActive ? touchInput.strafe : 0), -1, 1);

  const len = Math.hypot(f, r) || 1;
  f /= len;
  r /= len;

  const speed = runningToggled || keys.has('ShiftLeft') || keys.has('ShiftRight') || gamepadRunHeld ? 7 : 3.5;
  const vx = (-Math.sin(yaw) * f + Math.cos(yaw) * r) * speed;
  const vz = (-Math.cos(yaw) * f - Math.sin(yaw) * r) * speed;

  velocity.x = THREE.MathUtils.damp(velocity.x, vx, grounded ? 18 : 5, dt);
  velocity.z = THREE.MathUtils.damp(velocity.z, vz, grounded ? 18 : 5, dt);

  if (gamepad.jumpPressed) {
    const now = performance.now();
    if (now - lastGamepadJumpTime <= GAMEPAD_DOUBLE_TAP_MS) {
      setFlying(!flying);
      grounded = false;
      velocity.y = 0;
      jumpQueued = false;
      lastGamepadJumpTime = -Infinity;
    } else {
      lastGamepadJumpTime = now;
      if (!flying) jumpQueued = true;
    }
  }

  if (jumpQueued) {
    if (grounded) velocity.y = 3.1;
    jumpQueued = false;
  }

  if (flying) {
    const up = keys.has('Space') || gamepad.jumpHeld || (touchActive && touchInput.jumpHeld) ? 1 : 0;
    const down = keys.has('ControlLeft') || keys.has('ControlRight') || gamepad.descendHeld
      || (touchActive && touchInput.descendHeld) ? 1 : 0;
    velocity.y = (up - down) * 3.5;
  } else {
    velocity.y -= 9.81 * dt;
  }
  capsule.translate(velocity.clone().multiplyScalar(dt));
  if (cutawayDropThrough && capsule.start.y - RADIUS <= ROOF_CUTAWAY_HEIGHT - HEIGHT) {
    cutawayDropThrough = false;
    refreshActiveCollisionWorlds();
  }
  grounded = false;
  lastHit = null;

  // Several small substeps plus iterative separation keep corners and the curved roof solid.
  for (let i = 0; i < 4; i++) {
    let hit = null;
    for (const tree of activeCollisionWorlds) {
      const candidate=tree.capsuleIntersect(capsule);
      if(candidate && (!hit || candidate.depth>hit.depth))hit=candidate;
    }
    if (!hit || hit.depth < 1e-7) break;

    capsule.translate(hit.normal.clone().multiplyScalar(hit.depth + 1e-6));
    lastHit = hit.normal.toArray();

    if (hit.normal.y > 0.55) {
      grounded = true;
      if (velocity.y < 0) velocity.y = 0;
    }

    const inward = velocity.dot(hit.normal);
    if (inward < 0) velocity.addScaledVector(hit.normal, -inward);
  }

  const radius = Math.hypot(capsule.start.x, capsule.start.z);
  if (!flying && (capsule.start.y < -5 || Math.max(Math.abs(capsule.start.x),Math.abs(capsule.start.z)) > Math.sqrt(43560)/2*FT + .5)) place(STARTING_PLACE);

  syncCamera();
  updateProjectiles(dt);
  advanceRecording(dt);
  document.querySelector('#hint').textContent = flying
    ? `Flying · Space ↑ · Ctrl/Circle ↓ · C screenshot${viewRenderEnabled ? ' · V render' : ''}`
    : dragFallback ? 'Mouse look · double-W to run · H/Options HUD · C screenshot'
      : `Double-W to run · H/Options HUD · C screenshot${viewRenderEnabled ? ' · V render' : ''}`;
}

function updateMovementBadge() {
  const badge = document.querySelector('#movement-mode');
  if (!badge) return;
  const running = runningToggled || gamepadRunHeld || keys.has('ShiftLeft') || keys.has('ShiftRight');
  badge.textContent = running ? 'RUN' : 'WALK';
  badge.classList.toggle('running', running);
  badge.setAttribute('aria-label', running ? 'Running' : 'Walking');
}

function render() {
  updateMovementBadge();
  updateTouchActionButtons();
  const current = viewTools?.currentRoom(capsule.start.x, capsule.start.z);
  document.querySelector('#room').textContent = (viewTools?.state.ids && current ? current.id + ' · ' : '') + roomName();

  renderer.render(scene, camera);
}

function animate(now) {
  requestAnimationFrame(animate);

  if (mode !== 'playing') setGamepadInfo(findGamepad());

  const elapsed = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (!testing) {
    const n = Math.max(1, Math.ceil(elapsed / (1 / 120)));
    for (let i = 0; i < n; i++) step(elapsed / n);
  }

  render();
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  render();
}
window.addEventListener('resize', resize);

window.advanceTime = ms => {
  const n = Math.max(1, Math.ceil(ms / (1000 / 120)));
  for (let i = 0; i < n; i++) step(ms / 1000 / n);
  render();
};

function activeCollisionTriangleCount() {
  if (roofCutaway && flying) return 0;
  let count = collisionWorldBuilt.base ? collisionCounts.base : 0;
  if (!roofCutaway && collisionWorldBuilt.roof) count += collisionCounts.roof;
  if (!bareShell) {
    if (collisionWorldBuilt.interior) count += collisionCounts.interior;
    if (!roofCutaway && collisionWorldBuilt.interior_roof) count += collisionCounts.interior_roof;
    if (furnitureVisible && collisionWorldBuilt.furniture) count += collisionCounts.furniture;
  }
  for (const key of Object.keys(systemEnabled)) {
    if (systemEnabled[key] && collisionWorldBuilt[key]) count += collisionCounts[key];
  }
  return count;
}

window.render_game_to_text = () => JSON.stringify({
  mode,
  ready,
  render_quality: mobileLike ? 'mobile' : 'desktop',
  room: ready ? roomName() : null,
  character: {
    height_feet: 6,
    eye_height_feet: EYE / FT,
    field_of_view_degrees: camera.fov,
    walking_speed_mps: 3.5,
    running_speed_mps: 7,
    running_toggled: runningToggled,
    flying,
    width_inches: 22,
    feet_meters: [
      capsule.start.x,
      capsule.start.y - RADIUS,
      capsule.start.z,
    ].map(v => +v.toFixed(4)),
    velocity_mps: velocity.toArray().map(v => +v.toFixed(3)),
    grounded,
    yaw: +yaw.toFixed(4),
    pitch: +pitch.toFixed(4),
  },
  gamepad: {
    connected: gamepadInfo.connected,
    id: gamepadInfo.id,
    index: gamepadInfo.index,
    mapping: gamepadInfo.mapping,
    axes: gamepadInfo.axes,
    triggers: gamepadInfo.triggers,
  },
  touch_controls: {
    supported: hasTouchHardware,
    active: touchControlsActive(),
    movement: [touchInput.strafe, touchInput.forward].map(value => +value.toFixed(3)),
    looking: touchLookPointerId !== null,
  },
  coordinate_system: 'Meters: +X east, +Y up, -Z north; courtyard center is origin',
  mouse_locked: document.pointerLockElement === canvas,
  hud_options_open: document.body.classList.contains('hud-options-open'),
  path_recording: {
    active: recording,
    sample_count: recordingSamples.length,
    duration_seconds: +recordingDuration.toFixed(3),
    sample_interval_seconds: PATH_SAMPLE_INTERVAL,
    storage_key: PATH_STORAGE_KEY,
    last_saved: lastSavedPath,
  },
  labels: document.querySelector('#labels').checked,
  view: viewTools ? { ...viewTools.state, projectiles_enabled: projectilesEnabled } : viewTools?.state,
  projectiles_enabled: projectilesEnabled,
  running_toggled: runningToggled,
  run_mode: (runningToggled || gamepadRunHeld || keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 'run' : 'walk',
  projectiles: {
    active: projectiles.length,
    bullets_fired: projectileShots.bullets,
    fireballs_fired: projectileShots.fireballs,
    active_bounces: projectiles.reduce((total, mesh) => total + (mesh.userData.bounces || 0), 0),
    active_details: testing ? projectiles.slice(0, 12).map(mesh => ({
      kind: mesh.userData.kind,
      age_seconds: +Number(mesh.userData.age || 0).toFixed(3),
      bounces: mesh.userData.bounces || 0,
      glowing: Boolean(mesh.userData.glow),
      position_meters: mesh.position.toArray().map(value => +value.toFixed(3)),
      speed_mps: +mesh.userData.velocity.length().toFixed(3),
    })) : undefined,
  },
  render_view: {
    active: renderViewActive,
    job_id: renderViewJob?.job_id || null,
  },
  roof_cutaway: roofCutaway,
  roof_cutaway_height_feet: ROOF_CUTAWAY_HEIGHT / FT,
  roof_cutaway_drop_through: cutawayDropThrough,
  bare_shell: bareShell,
  furniture_visible: furnitureVisible,
  interior_mode: {
    bare_shell: bareShell,
    furniture_visible: furnitureVisible,
  },
  reference_counts: viewTools?.counts,
  room_id: viewTools?.currentRoom(capsule.start.x, capsule.start.z)?.id || null,
  visible_exterior_finishes: model ? (() => {const names=[];model.traverse(o=>{if(o.userData.group==='15' && o.visible) names.push(o.userData.finish_option);});return names;})() : [],
  lighting: {mode:'global walkthrough lighting',ambient_enabled:true,environment_lighting:true,fixture_only_blender:true},
  renderer_memory: renderer.info.memory,
  collision_triangles: totalCollisionTriangles,
  collision_profile: collisionProfile,
  collision_source_triangles: sourceCollisionTriangles,
  collision_triangles_saved: Math.max(0, sourceCollisionTriangles - totalCollisionTriangles),
  collision_reduction_percent: sourceCollisionTriangles > 0
    ? +Math.max(0, (sourceCollisionTriangles - totalCollisionTriangles) / sourceCollisionTriangles * 100).toFixed(1) : 0,
  collision_triangles_built: triangleCount,
  collision_batches_built: collisionChunksIndexed,
  collision_batches_by_map: collisionChunksIndexedByMap,
  collision_progress_percent: totalCollisionTriangles > 0
    ? +Math.min(100, triangleCount / totalCollisionTriangles * 100).toFixed(1) : 0,
  collision_triangles_by_system: collisionCounts,
  collision_maps_ready: Object.fromEntries(Object.entries(collisionWorldBuilt)),
  active_collision_triangles: activeCollisionTriangleCount(),
  shade_systems: Object.fromEntries(Object.keys(systemEnabled).map(key=>{
    let visible=0,total=0;model?.traverse(o=>{if(o.isMesh&&o.userData.system_option===key){total++;if(o.visible)visible++;}});
    return [key,{enabled:systemEnabled[key],visible_batches:visible,total_batches:total}];
  })),
  last_collision_normal: lastHit,
  fullscreen: !!document.fullscreenElement,
});

if (testing) {
  window.testWalkthrough = {
    place: (x, y, z, heading = 0) => {
      capsule.start.set(x, y + RADIUS, z);
      capsule.end.set(x, y + HEIGHT - RADIUS, z);
      velocity.set(0, 0, 0);
      yaw = heading;
      pitch = 0;
      grounded = false;
      flying = false;
      cutawayDropThrough = false;
      refreshActiveCollisionWorlds();
      lastSpaceTap = -Infinity;
      keys.clear();
      jumpQueued = false;
      syncCamera();
      render();
    },
    look: (a, b = 0) => {
      yaw = a;
      pitch = b;
      syncCamera();
      render();
    },
    startRecording,
    stopRecording,
    toggleHudOptions,
    toggleCheckbox,
    getRecordedPath: () => recordingSamples.slice(),
    setGamepad: state => {
      testGamepad = state;
      if (!state) {
        pollGamepad.previousButtons = [];
        gamepadForwardHeld = false;
        lastGamepadForwardTap = -Infinity;
        gamepadCircleDownAt = -Infinity;
      }
      setGamepadInfo(state);
    },
    spawn: place,
    fireProjectile: kind => {
      fireProjectile(kind);
      render();
    },
    clearProjectiles: () => {
      while (projectiles.length) removeProjectile(projectiles[0]);
      render();
    },
    ray: (origin, direction) => {
      const ray=new THREE.Ray(new THREE.Vector3(...origin),new THREE.Vector3(...direction).normalize());
      let hit=null;
      for(const tree of activeCollisionWorlds){const candidate=tree.rayIntersect(ray);if(candidate&&(!hit||candidate.distance<hit.distance))hit=candidate;}
      return hit ? {distance:hit.distance,position:hit.position.toArray()} : null;
    },
  };
}

/*
 * Build collision directly from the original indexed/non-indexed mesh data.
 *
 * The previous version cloned every collision mesh, converted it to non-indexed
 * geometry, copied all coordinates into a normal JavaScript Array, duplicated
 * every triangle with reversed winding, then copied the data again into a new
 * Float32Array before Octree.fromGraphNode() created its own triangle objects.
 * That caused a very large transient memory spike.
 *
 * This version reads source positions directly into the Octree. Floors, lower
 * shell walls, partitions, furniture and room ceilings retain their authored
 * collision triangles; the dense upper outer shell is replaced by a low-polygon
 * torus-profile proxy. No full-resolution cloned meshes or giant coordinate
 * arrays are created.
 */
function geometryTriangleCount(geometry) {
  const index = geometry.index;
  const position = geometry.getAttribute('position');
  return Math.floor((index ? index.count : position?.count || 0) / 3);
}

function worldYAt(position, matrix, index) {
  const e = matrix.elements;
  return e[1] * position.getX(index)
    + e[5] * position.getY(index)
    + e[9] * position.getZ(index)
    + e[13];
}

function countLowerShellTriangles(mesh) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const vertexCount = index ? index.count : position.count;
  let count = 0;
  const vertexIndex = i => index ? index.getX(i) : i;

  for (let i = 0; i < vertexCount; i += 3) {
    const a = vertexIndex(i);
    const b = vertexIndex(i + 1);
    const c = vertexIndex(i + 2);
    if (Math.max(
      worldYAt(position, mesh.matrixWorld, a),
      worldYAt(position, mesh.matrixWorld, b),
      worldYAt(position, mesh.matrixWorld, c),
    ) < ROOF_CUTAWAY_HEIGHT) count++;
  }
  return count;
}

function createTorusCollisionProxy(firstProfileAngle, lastProfileAngle, azimuthSegments, profileSegments) {
  const majorRadius = 35 * FT;
  const minorRadius = 15 * FT;
  const profileVertices = profileSegments + 1;
  const positions = [];
  const indices = [];

  for (let azimuth = 0; azimuth < azimuthSegments; azimuth++) {
    const phi = azimuth / azimuthSegments * Math.PI * 2;
    for (let profile = 0; profile <= profileSegments; profile++) {
      const theta = firstProfileAngle
        + (lastProfileAngle - firstProfileAngle) * profile / profileSegments;
      const radialDistance = majorRadius + minorRadius * Math.cos(theta);
      positions.push(
        radialDistance * Math.cos(phi),
        minorRadius * Math.sin(theta),
        -radialDistance * Math.sin(phi),
      );
    }
  }

  for (let azimuth = 0; azimuth < azimuthSegments; azimuth++) {
    const nextAzimuth = (azimuth + 1) % azimuthSegments;
    for (let profile = 0; profile < profileSegments; profile++) {
      const a = azimuth * profileVertices + profile;
      const b = nextAzimuth * profileVertices + profile;
      const c = nextAzimuth * profileVertices + profile + 1;
      const d = azimuth * profileVertices + profile + 1;
      // Downward-facing normals let rays and the capsule collide from inside.
      indices.push(a, c, b, a, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const proxy = new THREE.Mesh(geometry);
  proxy.userData.collision = true;
  proxy.userData.group = '04';
  proxy.userData.collisionProxy = true;
  proxy.updateMatrixWorld(true);
  return proxy;
}

function createSimplifiedRoofCollisionProxy() {
  // The roof section is the 20–50 ft upper half of a 15 ft-radius torus.
  // This parametric collider preserves that profile at 3° around the house
  // and 24 bands across the arch while replacing the exported high-detail
  // shell tessellation with a compact, collision-only surface.
  const minorRadius = 15 * FT;
  const firstProfileAngle = Math.asin(ROOF_CUTAWAY_HEIGHT / minorRadius);
  const lastProfileAngle = Math.PI - firstProfileAngle;
  return createTorusCollisionProxy(
    firstProfileAngle,
    lastProfileAngle,
    ROOF_COLLISION_AZIMUTH_SEGMENTS,
    ROOF_COLLISION_PROFILE_SEGMENTS,
  );
}

function createMobileFloorCollisionProxy() {
  const radius = 52 * FT;
  const positions = [0, 0, 0];
  const indices = [];
  for (let segment = 0; segment <= MOBILE_FLOOR_SEGMENTS; segment++) {
    const phi = segment / MOBILE_FLOOR_SEGMENTS * Math.PI * 2;
    positions.push(radius * Math.cos(phi), 0, -radius * Math.sin(phi));
  }
  for (let segment = 0; segment < MOBILE_FLOOR_SEGMENTS; segment++) {
    indices.push(0, segment + 1, segment + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const proxy = new THREE.Mesh(geometry);
  proxy.userData.collisionProxy = true;
  proxy.updateMatrixWorld(true);
  return proxy;
}

function addMeshTrianglesToCollisionTree(tree, mesh, triangleFilter = () => true) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  if (!position) return 0;
  const matrixWorld = mesh.matrixWorld;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let count = 0;
  const triangleTotal = Math.floor((index ? index.count : position.count) / 3);
  for (let triangleIndex = 0; triangleIndex < triangleTotal; triangleIndex++) {
    if (!triangleFilter(triangleIndex)) continue;
    const offset = triangleIndex * 3;
    const ia = index ? index.getX(offset) : offset;
    const ib = index ? index.getX(offset + 1) : offset + 1;
    const ic = index ? index.getX(offset + 2) : offset + 2;
    a.fromBufferAttribute(position, ia).applyMatrix4(matrixWorld);
    b.fromBufferAttribute(position, ib).applyMatrix4(matrixWorld);
    c.fromBufferAttribute(position, ic).applyMatrix4(matrixWorld);
    tree.addTriangle(new THREE.Triangle(a.clone(), b.clone(), c.clone()));
    count++;
  }
  return count;
}

async function buildMobileCollisionWorld(root) {
  // A real iPad can terminate the WebKit tab while the full authored forest
  // is being assembled, even though desktop and WebKit emulation survive it.
  // Use a compact analytic shell/floor plus a sparse sample of the important
  // interior partition groups. This keeps the game walkable without creating
  // tens of thousands of transient Triangle/Vector3 objects on mobile.
  collisionProfile = 'mobile shell + sampled partitions';
  for (const key of Object.keys(collisionForests)) {
    collisionForests[key].subTrees.length = 0;
    collisionForests[key].triangles.length = 0;
    pendingCollisionTrees[key] = new Octree();
    pendingCollisionTrees[key].maxLevel = 12;
    pendingCollisionCounts[key] = 0;
    collisionChunksIndexedByMap[key] = 0;
    collisionCounts[key] = 0;
    collisionWorldBuilt[key] = false;
  }
  triangleCount = 0;
  collisionChunksIndexed = 0;
  sourceCollisionTriangles = 0;
  totalCollisionTriangles = 0;
  setLoadStatus('Preparing the lightweight mobile collision map…');
  updateCollisionProgress(0, 1, 'Preparing mobile collision map');
  await nextFrame();

  const floor = createMobileFloorCollisionProxy();
  const shell = createTorusCollisionProxy(
    0,
    Math.PI,
    MOBILE_SHELL_AZIMUTH_SEGMENTS,
    MOBILE_SHELL_PROFILE_SEGMENTS,
  );
  const floorCount = addMeshTrianglesToCollisionTree(world, floor);
  const shellCount = addMeshTrianglesToCollisionTree(world, shell);
  floor.geometry.dispose();
  shell.geometry.dispose();

  root.updateMatrixWorld(true);
  let partitionCount = 0;
  root.traverse(mesh => {
    if (!mesh.isMesh || !mesh.userData.collision) return;
    if (!INTERIOR_COLLISION_GROUPS.has(mesh.userData.group)) return;
    const stride = mesh.userData.group === '03' ? MOBILE_PARTITION_TRIANGLE_STRIDE : 1;
    partitionCount += addMeshTrianglesToCollisionTree(
      world,
      mesh,
      triangleIndex => triangleIndex % stride === 0,
    );
  });

  world.build();
  const count = floorCount + shellCount + partitionCount;
  totalCollisionTriangles = count;
  sourceCollisionTriangles = count;
  triangleCount = count;
  collisionCounts.base = count;
  collisionWorldBuilt.base = count > 0;
  collisionChunksIndexed = 1;
  collisionChunksIndexedByMap.base = 1;
  refreshActiveCollisionWorlds();
  collisionProfile = `mobile shell + sampled partitions (${count.toLocaleString()} triangles)`;
  updateCollisionProgress(count, count, 'Mobile collision map ready', true);
  setLoadStatus(`Mobile collision map ready · ${count.toLocaleString()} triangles.`);
  await nextFrame();

  return async function buildDeferredMobileCollisionWorlds() {
    setLoadStatus(`Walkthrough ready · mobile collision map active (${count.toLocaleString()} triangles).`);
    render();
  };
}

async function buildCollisionOctree(root) {
  if (mobileLike) return buildMobileCollisionWorld(root);
  const collisionMeshes = [];
  let outputTriangleCount = 0;
  sourceCollisionTriangles = 0;
  let hasOuterShell = false;

  root.updateMatrixWorld(true);

  root.traverse(o => {
    if (!o.isMesh || !o.userData.collision || !o.geometry) return;

    const position = o.geometry.getAttribute('position');
    if (!position) return;

    const count = geometryTriangleCount(o.geometry);

    collisionMeshes.push(o);
    sourceCollisionTriangles += count;
    if (o.userData.group === '04') {
      hasOuterShell = true;
      outputTriangleCount += countLowerShellTriangles(o);
    } else {
      outputTriangleCount += count;
    }
  });

  if (hasOuterShell) {
    const roofProxy = createSimplifiedRoofCollisionProxy();
    collisionMeshes.push(roofProxy);
    outputTriangleCount += geometryTriangleCount(roofProxy.geometry);
  }

  totalCollisionTriangles = Math.floor(outputTriangleCount);
  sourceCollisionTriangles = Math.floor(sourceCollisionTriangles);
  triangleCount = 0;
  collisionChunksIndexed = 0;
  for (const key of Object.keys(collisionForests)) {
    collisionForests[key].subTrees.length = 0;
    collisionForests[key].triangles.length = 0;
    pendingCollisionTrees[key] = new Octree();
    pendingCollisionTrees[key].maxLevel = 12;
    pendingCollisionCounts[key] = 0;
    collisionChunksIndexedByMap[key] = 0;
  }
  updateCollisionProgress(0, totalCollisionTriangles, 'Preparing collision triangles');

  setLoadStatus(
    totalCollisionTriangles > 0
      ? `Preparing the essential floor and room-wall collisions…`
      : 'No collision meshes were found in the model.',
  );
  await nextFrame();

  // Index collision geometry in small chunks. A single Octree.build() over the
  // whole shell can monopolize the browser long enough to make the progress bar
  // appear stuck. Each chunk remains a normal Three.js Octree; the map root is
  // a lightweight forest of those indexed chunks, so collision queries and the
  // existing map toggles stay the same.
  const YIELD_EVERY = COLLISION_CHUNK_TRIANGLES;

  async function flushCollisionChunks(phase) {
    let flushed = false;
    for (const key of Object.keys(pendingCollisionTrees)) {
      const count = pendingCollisionCounts[key];
      if (!count) continue;

      const label = COLLISION_MAP_LABELS[key] || key.replaceAll('_', ' ');
      const nextBatch = collisionChunksIndexedByMap[key] + 1;
      updateCollisionProgress(triangleCount, totalCollisionTriangles,
        `${phase} · indexing ${label} batch ${nextBatch}`);

      const chunk = pendingCollisionTrees[key];
      chunk.build();
      collisionForests[key].subTrees.push(chunk);
      triangleCount += count;
      collisionChunksIndexed++;
      collisionChunksIndexedByMap[key] = nextBatch;
      pendingCollisionTrees[key] = new Octree();
      pendingCollisionTrees[key].maxLevel = 12;
      pendingCollisionCounts[key] = 0;
      updateCollisionProgress(triangleCount, totalCollisionTriangles,
        `${phase} · indexed ${label} batch ${nextBatch}`);
      flushed = true;
    }

    if (flushed) await nextFrame();
    return flushed;
  }

  async function collectPhase(phase) {
    let visited = 0;
    let nextYield = YIELD_EVERY;
    const phaseLabel = phase === 'essential' ? 'Floor & room walls' : 'Roof, furniture & shade';

    async function reportChunk() {
      const flushed = await flushCollisionChunks(phaseLabel);
      if (!flushed) {
        updateCollisionProgress(triangleCount, totalCollisionTriangles,
          `Scanning ${phaseLabel.toLowerCase()} · ${visited.toLocaleString()} source triangles checked`);
        await nextFrame();
      }
    }

    for (const mesh of collisionMeshes) {
      const group = mesh.userData.group;
      if (group === '04' && !mesh.userData.collisionProxy && phase === 'secondary') continue;
      if (mesh.userData.collisionProxy && phase === 'essential') continue;
      const system = mesh.userData.system_option;
      const collisionKey = system
        || (group === '06' ? 'furniture'
          : INTERIOR_COLLISION_GROUPS.has(group) ? 'interior' : 'base');
      const splitByHeight = !system && (group === '04' || group === '13');
      const ordinaryCoreMesh = collisionKey === 'base' || collisionKey === 'interior';
      if (phase === 'essential' && !ordinaryCoreMesh && !splitByHeight) continue;
      if (phase === 'secondary' && ordinaryCoreMesh && !splitByHeight) continue;

      const geometry = mesh.geometry;
      const position = geometry.getAttribute('position');
      const index = geometry.index;
      const matrixWorld = mesh.matrixWorld;
      // These exported ground sheets face down. Collision is one-sided, so
      // orient each existing triangle upward instead of duplicating its faces.
      const groundSheet = group === '01'
        || (group === '07' && mesh.material?.name === 'Meadow green');

      const addTriangle = (ia, ib, ic) => {
        visited++;
        if (group === '04' && !mesh.userData.collisionProxy && Math.max(
          worldYAt(position, matrixWorld, ia),
          worldYAt(position, matrixWorld, ib),
          worldYAt(position, matrixWorld, ic),
        ) >= ROOF_CUTAWAY_HEIGHT) return;

        const a = new THREE.Vector3().fromBufferAttribute(position, ia).applyMatrix4(matrixWorld);
        const b = new THREE.Vector3().fromBufferAttribute(position, ib).applyMatrix4(matrixWorld);
        const c = new THREE.Vector3().fromBufferAttribute(position, ic).applyMatrix4(matrixWorld);

        // Keep the upper shell and room roofs in removable maps for the
        // cutaway. Triangles crossing the cut plane stay in the removable map.
        const maxY = Math.max(a.y, b.y, c.y);
        const targetKey = mesh.userData.collisionProxy ? 'roof'
          : splitByHeight && maxY >= ROOF_CUTAWAY_HEIGHT
            ? group === '04' ? 'roof' : 'interior_roof'
            : collisionKey;
        const isEssential = targetKey === 'base' || targetKey === 'interior';
        if ((phase === 'essential') !== isEssential) return;

        const targetCountKey = collisionForests[targetKey] ? targetKey : 'base';
        const normalY = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
        pendingCollisionTrees[targetCountKey].addTriangle(groundSheet && normalY < 0
          ? new THREE.Triangle(a, c, b)
          : new THREE.Triangle(a, b, c));
        pendingCollisionCounts[targetCountKey]++;
        collisionCounts[targetCountKey]++;
      };

      const vertexCount = index ? index.count : position.count;
      for (let i = 0; i < vertexCount; i += 3) {
        addTriangle(
          index ? index.getX(i) : i,
          index ? index.getX(i + 1) : i + 1,
          index ? index.getX(i + 2) : i + 2,
        );
        if (visited >= nextYield) {
          await reportChunk();
          nextYield += YIELD_EVERY;
        }
      }
    }

    await flushCollisionChunks(phaseLabel);
  }

  await collectPhase('essential');
  const coreTriangleCount = collisionCounts.base + collisionCounts.interior;
  setLoadStatus(`Essential floor and wall collisions indexed (${coreTriangleCount.toLocaleString()} triangles).`);
  collisionWorldBuilt.base = collisionCounts.base > 0;
  collisionWorldBuilt.interior = collisionCounts.interior > 0;
  refreshActiveCollisionWorlds();
  updateCollisionProgress(triangleCount, totalCollisionTriangles, 'Essential floor & room walls ready');
  await nextFrame();

  // Finish extracting and indexing optional collision geometry once the player
  // is moving. Each indexed chunk is already in its map forest; maps are
  // enabled as a unit after all of their chunks are complete.
  return async function buildDeferredCollisionWorlds() {
    await collectPhase('secondary');
    const deferredKeys = Object.keys(optionalWorlds)
      .filter(key => key !== 'interior' && collisionCounts[key] > 0);
    for (let index = 0; index < deferredKeys.length; index++) {
      const key = deferredKeys[index];
      collisionWorldBuilt[key] = true;
      setLoadStatus(`Walkthrough ready · collision map ${index + 1}/${deferredKeys.length}: ${COLLISION_MAP_LABELS[key] || key.replaceAll('_', ' ')}.`);
      updateCollisionProgress(triangleCount, totalCollisionTriangles,
        `Ready · ${COLLISION_MAP_LABELS[key] || key.replaceAll('_', ' ')}`);
      refreshActiveCollisionWorlds();
      await nextFrame();
    }
    setLoadStatus(`Walkthrough ready · all ${totalCollisionTriangles.toLocaleString()} collision triangles are active.`);
    updateCollisionProgress(totalCollisionTriangles, totalCollisionTriangles, 'Collision maps ready', true);
    render();
  };
}

place(STARTING_PLACE);
render();
requestAnimationFrame(animate);

try {
  setLoadStatus('Loading Blender model…');

  const gltf = await new GLTFLoader().loadAsync(
    './assets/dream-home.glb',
    event => {
      if (event.total > 0) {
        const pct = Math.min(100, Math.round(event.loaded / event.total * 100));
        status.textContent = `Loading Blender model… ${pct}%`;
      } else if (event.loaded > 0) {
        status.textContent = `Loading Blender model… ${(event.loaded / 1024 / 1024).toFixed(1)} MB`;
      }
    },
  );

  model = gltf.scene;
  model.updateMatrixWorld(true);

  setLoadStatus('3D model loaded. Preparing materials…');

  model.traverse(o => {
    if (!o.isMesh) return;

    const materials = Array.isArray(o.material) ? o.material : [o.material];

    for (const m of materials) {
      if (!m) continue;

      m.side = o.userData.group === '15' ? THREE.FrontSide : THREE.DoubleSide;

      if ((m.name || '').toLowerCase().includes('glass')) {
        m.transmission = 0;
        m.transparent = true;
        m.opacity = 0.17;
        m.depthWrite = false;
        m.roughness = 0.18;
      }

      m.envMapIntensity = 0.35;
    }

    if (o.userData.group === '15') o.visible = false;
    if (o.userData.system_option) o.visible=!!systemEnabled[o.userData.system_option];
    o.castShadow = !mobileLike && o.userData.group !== '15' && !materials.some(m => m?.transparent) && o.userData.group !== '10';
    o.receiveShadow = !mobileLike;
  });

  // Add and render the visible house before the collision build. This gives the
  // browser a chance to paint a useful frame instead of showing a blank loader.
  scene.add(model);
  applyInteriorVisibility();
  prepareRoofCutawayMaterials(model);
  render();
  await nextFrame();

  const buildDeferredCollisionWorlds = await buildCollisionOctree(model);

  viewTools = await createViewTools(scene, sun, hemisphere, render, model, setShadeSystem);
  document.querySelector('#view-controls').hidden = false;
  ready = true;
  setGamepadInfo(findGamepad());
  // Loading is the only gate. Once the collision map and view tools are ready,
  // begin in the living room immediately; the controls remain open as a
  // translucent HUD, but keyboard/controller movement is already live.
  mode = 'playing';
  menu.hidden = true;
  hud.hidden = false;
  document.body.classList.add('playing', 'hud-options-open');
  updateTouchControlsVisibility();
  // Pointer lock requires a user gesture. Until the user clicks the canvas,
  // allow the existing drag-to-look fallback while keyboard/controller input
  // remains fully active.
  dragFallback = true;
  document.querySelector('#hint').textContent = 'Click-drag to look · Esc releases mouse';
  place(STARTING_PLACE);
  // There is no start or resume button: loading starts play automatically,
  // and Escape releases pointer capture without stopping the walkthrough.

  status.textContent = totalCollisionTriangles > 0
    ? 'Ready · walking starts now; roof, furniture and shade collisions are finishing in the background.'
    : 'Ready, but no collision meshes were found. Movement will not collide with the house.';

  console.info(`[Dream Home] Ready with ${(collisionCounts.base + collisionCounts.interior).toLocaleString()} essential collision triangles; secondary maps are building in the background.`);
  render();
  buildDeferredCollisionWorlds().catch(error => {
    console.error('[Dream Home] Optional collision map preparation failed:', error);
    status.textContent = 'Walkthrough is ready; some optional collision maps could not be prepared.';
  });
} catch (error) {
  mode = 'error';
  console.error('[Dream Home] Loading failed:', error);
  status.textContent = 'The house could not load. Check the JavaScript console for the specific error.';
}
