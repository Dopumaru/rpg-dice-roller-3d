import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// ─── Referências DOM ───────────────────────────────────────────────────────
const themeToggle     = document.querySelector('[data-theme-toggle]');
const root            = document.documentElement;
const notationInput   = document.getElementById('dice-notation');
const lastRoll        = document.getElementById('last-roll');
const lastTotal       = document.getElementById('last-total');
const diceButtons     = document.querySelectorAll('.dice-button');
const rollSelected    = document.getElementById('roll-selected');
const rollNotation    = document.getElementById('roll-notation');
const engineStatus    = document.getElementById('engine-status');
const canvas          = document.getElementById('dice-canvas');

// ─── Estado global ─────────────────────────────────────────────────────────
const S = {
  selectedDice : 'd20',
  theme        : 'dark',
  renderer     : null,
  scene        : null,
  camera       : null,
  dice         : [],
  world        : null,
  isRolling    : false,
};

const SIDES_MAP = { d4:4, d6:6, d8:8, d10:10, d12:12, d20:20 };

// ─── Tema ───────────────────────────────────────────────────────────────────
function setTheme(t) {
  S.theme = t;
  root.setAttribute('data-theme', t);
  if (S.scene) S.scene.background = new THREE.Color(t === 'dark' ? 0x0b0d1a : 0xf3efe8);
}

// ─── Parser de notação RPG ──────────────────────────────────────────────────
function parseNotation(raw) {
  const m = raw.trim().toLowerCase().match(/^(\d*)d(\d+)([+-]\d+)?$/);
  if (!m) return null;
  return { count: Number(m[1] || 1), sides: Number(m[2]), modifier: Number(m[3] || 0) };
}
function rollDie(sides) { return Math.floor(Math.random() * sides) + 1; }

function runNotation(expr) {
  const p = parseNotation(expr);
  if (!p) {
    lastRoll.textContent     = 'Expressão inválida';
    lastTotal.textContent    = 'Use algo como 2d6+3';
    engineStatus.textContent = 'Aguardando expressão válida';
    return;
  }
  const rolls = Array.from({ length: p.count }, () => rollDie(p.sides));
  const total = rolls.reduce((s, v) => s + v, 0) + p.modifier;
  lastRoll.textContent     = `${p.count}d${p.sides}: ${rolls.join(', ')}`;
  lastTotal.textContent    = `Total: ${total}${p.modifier ? ` (${p.modifier > 0 ? '+' : ''}${p.modifier})` : ''}`;
  engineStatus.textContent = `Rolagem interpretada · d${p.sides}`;
  throwDice(p.count, p.sides);
}

// ─── Seleção de dado ────────────────────────────────────────────────────────
function selectDie(die) {
  S.selectedDice = die;
  diceButtons.forEach(btn => {
    const active = btn.dataset.dice === die;
    btn.setAttribute('aria-pressed', String(active));
    btn.style.borderColor = active ? 'rgba(209,181,116,.45)' : 'var(--color-border)';
    btn.style.boxShadow   = active ? '0 0 0 1px rgba(123,145,201,.18),0 0 24px rgba(123,145,201,.18)' : 'none';
  });
}

// ─── Geometria por tipo de dado ─────────────────────────────────────────────
function geomFor(sides) {
  if (sides ===  4) return new THREE.TetrahedronGeometry(0.95);
  if (sides ===  6) return new THREE.BoxGeometry(1.2, 1.2, 1.2);
  if (sides ===  8) return new THREE.OctahedronGeometry(0.95);
  if (sides === 10) return new THREE.CylinderGeometry(0.7, 0.7, 1.15, 10);
  if (sides === 12) return new THREE.DodecahedronGeometry(0.88);
  return new THREE.IcosahedronGeometry(0.95);
}

function makeMaterial() {
  return new THREE.MeshStandardMaterial({
    color            : S.theme === 'dark' ? 0xd7c08a : 0x7f6832,
    roughness        : 0.32,
    metalness        : 0.16,
    emissive         : S.theme === 'dark' ? 0x18213a : 0x000000,
    emissiveIntensity: 0.55,
  });
}

// ─── Mundo físico ───────────────────────────────────────────────────────────
function buildWorld() {
  S.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -24, 0), allowSleep: true });
  S.world.solver.iterations = 16;

  const floor = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  floor.position.set(0, -1.1, 0);
  S.world.addBody(floor);

  const wall = (x, z, ry) => {
    const b = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(8, 3, 0.18)) });
    b.position.set(x, 0, z);
    b.quaternion.setFromEuler(0, ry, 0);
    S.world.addBody(b);
  };
  wall(0, -5.2, 0);
  wall(0,  5.2, 0);
  wall(-5.2, 0, Math.PI / 2);
  wall( 5.2, 0, Math.PI / 2);
}

// ─── Spawn e lançamento ─────────────────────────────────────────────────────
function clearDice() {
  S.dice.forEach(({ mesh, body }) => {
    S.scene.remove(mesh);
    S.world.removeBody(body);
    mesh.geometry.dispose();
    mesh.material.dispose();
  });
  S.dice = [];
}

function spawnDice(count, sides) {
  clearDice();
  const spread = Math.max(1.4, Math.min(3.6, count * 0.8));
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(geomFor(sides), makeMaterial());
    const shape = sides === 6
      ? new CANNON.Box(new CANNON.Vec3(0.6, 0.6, 0.6))
      : new CANNON.Sphere(0.65);
    const body = new CANNON.Body({ mass: 1, shape, linearDamping: 0.28, angularDamping: 0.3, allowSleep: true });
    body.position.set(
      (Math.random() - 0.5) * spread,
      4 + i * 0.7,
      (Math.random() - 0.5) * spread,
    );
    body.quaternion.setFromEuler(
      Math.random() * Math.PI,
      Math.random() * Math.PI,
      Math.random() * Math.PI,
    );
    mesh.position.copy(body.position);
    mesh.quaternion.copy(body.quaternion);
    S.scene.add(mesh);
    S.world.addBody(body);
    S.dice.push({ mesh, body, sides });
  }
}

function throwDice(count, sides) {
  if (!S.world) return;
  S.isRolling = true;
  engineStatus.textContent = 'Rolando…';
  spawnDice(count, sides);
  S.dice.forEach(({ body }) => {
    const f = 5 + Math.random() * 5;
    body.wakeUp();
    body.applyImpulse(
      new CANNON.Vec3((Math.random() - 0.5) * f, f, (Math.random() - 0.5) * f),
      body.position,
    );
    body.angularVelocity.set(
      (Math.random() - 0.5) * 24,
      (Math.random() - 0.5) * 24,
      (Math.random() - 0.5) * 24,
    );
  });
}

// ─── Detecção de face superior (d6) ─────────────────────────────────────────
const D6_FACES = [
  { axis: new THREE.Vector3( 0,  1,  0), value: 1 },
  { axis: new THREE.Vector3( 0, -1,  0), value: 6 },
  { axis: new THREE.Vector3( 1,  0,  0), value: 2 },
  { axis: new THREE.Vector3(-1,  0,  0), value: 5 },
  { axis: new THREE.Vector3( 0,  0,  1), value: 3 },
  { axis: new THREE.Vector3( 0,  0, -1), value: 4 },
];
function detectFaceD6(mesh) {
  const up = new THREE.Vector3(0, 1, 0);
  let best = -Infinity, face = 0;
  D6_FACES.forEach(({ axis, value }) => {
    const dot = axis.clone().applyQuaternion(mesh.quaternion).dot(up);
    if (dot > best) { best = dot; face = value; }
  });
  return face;
}

// ─── Cena Three.js ──────────────────────────────────────────────────────────
function initScene() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d1a);

  const camera = new THREE.PerspectiveCamera(40, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
  camera.position.set(0, 7.5, 10);
  camera.lookAt(0, -0.5, 0);

  scene.add(new THREE.AmbientLight(0xb4c3ff, 1.7));
  const key = new THREE.DirectionalLight(0x9db5ff, 2.8);
  key.position.set(6, 10, 5);
  scene.add(key);
  const warm = new THREE.PointLight(0xd1b574, 28, 32, 2);
  warm.position.set(-5, 4, 2);
  scene.add(warm);

  const floorMesh = new THREE.Mesh(
    new THREE.CircleGeometry(5.2, 80),
    new THREE.MeshStandardMaterial({ color: 0x161a2c, roughness: 1 }),
  );
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = -1.1;
  scene.add(floorMesh);

  S.renderer = renderer;
  S.scene    = scene;
  S.camera   = camera;

  buildWorld();
  animate();
}

// ─── Loop de animação ───────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  if (S.world) S.world.fixedStep();
  S.dice.forEach(({ mesh, body }) => {
    mesh.position.copy(body.position);
    mesh.quaternion.copy(body.quaternion);
  });
  if (S.isRolling && S.dice.length > 0) {
    const allSleeping = S.dice.every(({ body }) => body.sleepState === CANNON.Body.SLEEPING);
    if (allSleeping) {
      S.isRolling = false;
      const d6 = S.dice.find(d => d.sides === 6);
      engineStatus.textContent = d6
        ? `Dado parou · d6 face: ${detectFaceD6(d6.mesh)}`
        : 'Dado parou · resultado calculado';
    }
  }
  S.renderer.render(S.scene, S.camera);
}

// ─── Resize ─────────────────────────────────────────────────────────────────
function resizeScene() {
  if (!S.renderer || !S.camera) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  S.renderer.setSize(w, h, false);
  S.camera.aspect = w / h;
  S.camera.updateProjectionMatrix();
}

// ─── Eventos ─────────────────────────────────────────────────────────────────
diceButtons.forEach(btn =>
  btn.addEventListener('click', () => {
    selectDie(btn.dataset.dice);
    notationInput.value = `1${btn.dataset.dice}`;
    throwDice(1, SIDES_MAP[btn.dataset.dice]);
  })
);
rollSelected.addEventListener('click', () => runNotation(`1${S.selectedDice}`));
rollNotation.addEventListener('click', () => runNotation(notationInput.value));
themeToggle.addEventListener('click', () => setTheme(S.theme === 'dark' ? 'light' : 'dark'));
window.addEventListener('resize', resizeScene);

// ─── Init ────────────────────────────────────────────────────────────────────
selectDie(S.selectedDice);
setTheme(S.theme);
initScene();