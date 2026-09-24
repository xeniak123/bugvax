// The hero: a live "SEM field". Antibodies drift in a grayscale specimen; release a bug and the
// nearest antibodies swim to it, latch on with their arms, and neutralize it. Colour is false
// colour, as in real micrographs: gold marks bound antibodies, magenta marks a live bug.
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

THREE.ColorManagement.enabled = false; // colours below are final sRGB values, like the CSS

const FIELD = new THREE.Color(0x0b0e11);
const GOLD = new THREE.Color(0xf0b541);
const MAGENTA = new THREE.Color(0xe5487e);
const UP = new THREE.Vector3(0, 1, 0);
const BASE_Z = 13;

const vertexShader = /* glsl */ `
  attribute float aTint;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vColor;
  varying float vTint;
  void main() {
    mat4 world = modelMatrix * instanceMatrix;
    vec4 mv = viewMatrix * world * vec4(position, 1.0);
    vNormal = normalize(mat3(viewMatrix) * mat3(world) * normal);
    vView = mv.xyz;
    #ifdef USE_INSTANCING_COLOR
      vColor = instanceColor;
    #else
      vColor = vec3(1.0);
    #endif
    vTint = aTint;
    gl_Position = projectionMatrix * mv;
  }
`;

// Secondary-electron look: dark faces, bright edges (edge effect), fine detector noise, depth fog.
const fragmentShader = /* glsl */ `
  uniform vec3 uField;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vColor;
  varying float vTint;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(-vView);
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    float rim = pow(1.0 - ndv, 2.3);
    float key = clamp(dot(n, normalize(vec3(-0.45, 0.8, 0.5))), 0.0, 1.0);
    float sem = 0.09 + 0.3 * key + 1.0 * rim;
    float grain = (hash(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.07;
    vec3 gray = vec3(sem) * vec3(0.92, 0.95, 1.0);
    vec3 tinted = vColor * (0.22 + 1.02 * sem);
    vec3 col = mix(gray, tinted, vTint) + grain;
    float fog = smoothstep(uFogNear, uFogFar, -vView.z);
    gl_FragColor = vec4(mix(col, uField, fog), 1.0);
  }
`;

function antibodyGeometry() {
  const r = 0.13;
  const parts = [];
  const stem = new THREE.CapsuleGeometry(r * 1.08, 0.62, 6, 14);
  stem.translate(0, -0.55, 0);
  parts.push(stem);
  for (const side of [-1, 1]) {
    const arm = new THREE.CapsuleGeometry(r, 0.56, 6, 14);
    arm.translate(0, 0.44, 0);
    arm.rotateZ(side * 0.7);
    parts.push(arm);
  }
  parts.push(new THREE.SphereGeometry(r * 1.4, 18, 14));
  for (const p of parts) p.deleteAttribute("uv");
  return mergeGeometries(parts, false);
}

function fibonacciSphere(n) {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    out.push(new THREE.Vector3(Math.cos(golden * i) * rad, y, Math.sin(golden * i) * rad));
  }
  return out;
}

function virusGeometry() {
  let core = new THREE.IcosahedronGeometry(0.62, 5);
  core.deleteAttribute("normal");
  core.deleteAttribute("uv");
  core = mergeVertices(core);
  const pos = core.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const bump = Math.sin(v.x * 11.3) * Math.sin(v.y * 9.7) * Math.sin(v.z * 10.1);
    v.multiplyScalar(1 + bump * 0.035);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  core.computeVertexNormals();
  const parts = [core];
  for (const dir of fibonacciSphere(38)) {
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    const stalk = new THREE.CylinderGeometry(0.03, 0.045, 0.24, 7);
    stalk.translate(0, 0.72, 0);
    const knob = new THREE.SphereGeometry(0.07, 10, 8);
    knob.scale(1.15, 0.7, 1.15);
    knob.translate(0, 0.86, 0);
    for (const g of [stalk, knob]) {
      g.deleteAttribute("uv");
      g.applyQuaternion(q);
      parts.push(g);
    }
  }
  return mergeGeometries(parts, false);
}

function makeMaterial(uniforms) {
  return new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ reduced: boolean, onNeutralize: (count: number) => void }} opts
 */
export function initHero(canvas, opts) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(FIELD, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));

  const small = window.matchMedia("(max-width: 700px)").matches;
  const COUNT = small ? 38 : 68;
  const BINDERS = small ? 5 : 7;
  const MAX_BUGS = 5;
  const SIZE = small ? 0.72 : 1; // antibody size on phones
  const BUG_R = small ? 0.72 : 0.9; // distance from a bug's centre to where arms latch on
  const BUG_SIZE = small ? 0.8 : 1;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
  camera.position.set(0, 0, BASE_Z);

  const uniforms = {
    uField: { value: new THREE.Vector3(FIELD.r, FIELD.g, FIELD.b) },
    uFogNear: { value: BASE_Z + 1 },
    uFogFar: { value: BASE_Z + 11 },
    uTime: { value: 0 },
  };

  // Antibodies
  const abGeo = antibodyGeometry();
  const abTint = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1);
  abGeo.setAttribute("aTint", abTint);
  const antibodies = new THREE.InstancedMesh(abGeo, makeMaterial(uniforms), COUNT);
  antibodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  antibodies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);
  for (let i = 0; i < COUNT; i++) antibodies.setColorAt(i, GOLD);
  antibodies.frustumCulled = false;
  scene.add(antibodies);

  // Bugs
  const bugGeo = virusGeometry();
  const bugTint = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BUGS), 1);
  bugGeo.setAttribute("aTint", bugTint);
  const bugMesh = new THREE.InstancedMesh(bugGeo, makeMaterial(uniforms), MAX_BUGS);
  bugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bugMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BUGS * 3), 3);
  for (let i = 0; i < MAX_BUGS; i++) bugMesh.setColorAt(i, MAGENTA);
  bugMesh.frustumCulled = false;
  scene.add(bugMesh);

  // View size at z = 0, used for bounds and spawning.
  let viewW = 10;
  let viewH = 6;
  function measure() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    viewH = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * BASE_Z;
    viewW = viewH * camera.aspect;
  }
  measure();

  const rand = (a, b) => a + Math.random() * (b - a);
  const ab = [];
  for (let i = 0; i < COUNT; i++) {
    ab.push({
      pos: new THREE.Vector3(rand(-0.62, 0.62) * viewW, rand(-0.6, 0.6) * viewH, rand(-9, 1.4)),
      vel: new THREE.Vector3(rand(-0.1, 0.1), rand(-0.1, 0.1), 0),
      quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28))),
      spin: new THREE.Vector3(rand(-0.25, 0.25), rand(-0.25, 0.25), rand(-0.25, 0.25)),
      scale: rand(0.72, 1.22) * SIZE,
      tint: 0,
      bug: null,
      slot: null,
    });
  }

  const bugs = [];
  let neutralized = 0;
  const pointer = { active: false, world: new THREE.Vector3() };
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();
  const tmpS = new THREE.Vector3();
  const spinQ = new THREE.Quaternion();
  const spinE = new THREE.Euler();
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  function worldFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, hit) ? hit : null;
  }

  function spawn(at) {
    if (bugs.filter((b) => b.state !== "gone").length >= MAX_BUGS) return false;
    const slotIndex = bugs.findIndex((b) => b.state === "gone");
    const bug = {
      index: slotIndex >= 0 ? slotIndex : bugs.length,
      pos: at.clone(),
      scale: 0,
      tint: 1,
      age: 0,
      state: "live",
      dying: 0,
      binders: [],
    };
    if (slotIndex >= 0) bugs[slotIndex] = bug;
    else bugs.push(bug);

    // The nearest free antibodies respond; each takes the binding slot closest to its approach.
    // Slots ring the bug in the image plane, so the bound antibodies read like the micrograph.
    const free = ab.filter((a) => !a.bug).sort((a, b) => a.pos.distanceToSquared(at) - b.pos.distanceToSquared(at));
    const ring = BINDERS + 3;
    const turn = rand(0, Math.PI * 2);
    const slots = Array.from({ length: ring }, (_, k) => {
      const angle = turn + (k / ring) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(angle), Math.sin(angle), rand(-0.28, 0.28)).normalize();
    });
    for (const a of free.slice(0, BINDERS)) {
      const from = tmpV.copy(a.pos).sub(at).normalize();
      let best = 0;
      let bestDot = -Infinity;
      slots.forEach((s, i) => {
        const d = s.dot(from);
        if (d > bestDot) {
          bestDot = d;
          best = i;
        }
      });
      a.slot = slots.splice(best, 1)[0];
      a.bug = bug;
      bug.binders.push(a);
    }
    return true;
  }

  function release(bug) {
    for (const a of bug.binders) {
      a.vel.copy(a.pos).sub(bug.pos).normalize().multiplyScalar(0.9);
      a.bug = null;
      a.slot = null;
    }
    bug.binders = [];
  }

  let time = 0;
  let lastInteraction = -10;
  let nextAuto = 2.2;
  let zoom = 0;

  function step(dt) {
    time += dt;
    uniforms.uTime.value = time;

    // Camera: scroll zooms the microscope in.
    const z = BASE_Z - zoom * 5.8;
    camera.position.z += (z - camera.position.z) * (1 - Math.exp(-dt * 8));
    uniforms.uFogNear.value = camera.position.z + 1;
    uniforms.uFogFar.value = camera.position.z + 11;

    // Ambient demonstration when nobody is playing with the field.
    // It lands away from the headline: to the right on wide screens, above it on tall ones.
    if (!opts.reduced && time > nextAuto && time - lastInteraction > 6) {
      nextAuto = time + rand(7, 10);
      const portrait = viewW < viewH;
      spawn(
        portrait
          ? new THREE.Vector3(rand(-0.22, 0.22) * viewW, rand(0.2, 0.33) * viewH, 0)
          : new THREE.Vector3(rand(0.12, 0.36) * viewW, rand(-0.12, 0.28) * viewH, 0),
      );
    }

    for (const bug of bugs) {
      if (bug.state === "gone") continue;
      bug.age += dt;
      if (bug.state === "live") {
        bug.scale += (1 - bug.scale) * (1 - Math.exp(-dt * 7));
        const attached = bug.binders.filter((a) => a.slot && a.pos.distanceTo(tmpV.copy(bug.pos).addScaledVector(a.slot, BUG_R + 0.62 * a.scale)) < 0.35).length;
        if (!opts.reduced && bug.age > 1.3 && (attached >= Math.ceil(bug.binders.length * 0.6) || bug.age > 2.6)) {
          bug.state = "dying";
          bug.dying = 0;
          neutralized += 1;
          opts.onNeutralize(neutralized);
        }
      } else if (bug.state === "dying") {
        bug.dying += dt;
        bug.tint = Math.max(0, 1 - bug.dying / 0.5);
        if (bug.dying > 0.75) {
          const k = Math.min(1, (bug.dying - 0.75) / 0.6);
          bug.scale = 1 - k * k * (3 - 2 * k);
          if (bug.binders.length) release(bug);
        }
        if (bug.dying > 1.4) bug.state = "gone";
      }
    }

    const halfW = viewW * 0.66;
    const halfH = viewH * 0.64;
    for (let i = 0; i < COUNT; i++) {
      const a = ab[i];
      if (a.bug) {
        const target = tmpV.copy(a.bug.pos).addScaledVector(a.slot, BUG_R + 0.62 * a.scale);
        a.pos.lerp(target, 1 - Math.exp(-dt * 4.5));
        const toBug = tmpS.copy(a.bug.pos).sub(a.pos).normalize();
        tmpQ.setFromUnitVectors(UP, toBug);
        a.quat.slerp(tmpQ, 1 - Math.exp(-dt * 5));
        a.tint += (1 - a.tint) * (1 - Math.exp(-dt * 5));
      } else if (!opts.reduced) {
        const p = a.pos;
        const fx = Math.sin(p.y * 0.42 + time * 0.21) + 0.6 * Math.sin(p.z * 0.7 + time * 0.13);
        const fy = Math.sin(p.z * 0.5 + time * 0.17) + 0.6 * Math.cos(p.x * 0.33 - time * 0.11);
        const fz = 0.45 * Math.sin(p.x * 0.4 + time * 0.19);
        a.vel.x += fx * 0.1 * dt;
        a.vel.y += fy * 0.1 * dt;
        a.vel.z += fz * 0.1 * dt;
        if (pointer.active) {
          const d = tmpS.copy(pointer.world).sub(p);
          const dist = d.length();
          if (dist < 3.4 && dist > 0.001) a.vel.addScaledVector(d, (0.18 * (1 - dist / 3.4) * dt) / dist);
        }
        a.vel.multiplyScalar(Math.exp(-dt * 0.8));
        p.addScaledVector(a.vel, dt);
        if (p.x > halfW) p.x = -halfW;
        if (p.x < -halfW) p.x = halfW;
        if (p.y > halfH) p.y = -halfH;
        if (p.y < -halfH) p.y = halfH;
        if (p.z > 2.6) a.vel.z -= 0.4 * dt;
        if (p.z < -8) a.vel.z += 0.4 * dt;
        spinE.set(a.spin.x * dt, a.spin.y * dt, a.spin.z * dt);
        a.quat.multiply(spinQ.setFromEuler(spinE));
        a.tint = Math.max(0, a.tint - dt * 0.28);
      }
      tmpM.compose(a.pos, a.quat, tmpS.setScalar(a.scale));
      antibodies.setMatrixAt(i, tmpM);
      abTint.setX(i, a.tint);
    }
    antibodies.instanceMatrix.needsUpdate = true;
    abTint.needsUpdate = true;

    for (let i = 0; i < MAX_BUGS; i++) {
      const bug = bugs[i];
      if (!bug || bug.state === "gone") {
        tmpM.makeScale(0, 0, 0);
        bugMesh.setMatrixAt(i, tmpM);
        continue;
      }
      tmpQ.setFromEuler(spinE.set(bug.age * 0.25, bug.age * 0.4, 0));
      tmpM.compose(bug.pos, tmpQ, tmpS.setScalar(Math.max(bug.scale, 0.0001) * 1.05 * BUG_SIZE));
      bugMesh.setMatrixAt(i, tmpM);
      bugTint.setX(i, bug.tint);
    }
    bugMesh.instanceMatrix.needsUpdate = true;
    bugTint.needsUpdate = true;

    renderer.render(scene, camera);
  }

  // Interaction: click or tap releases a bug where you point.
  canvas.addEventListener("click", (e) => {
    const at = worldFromEvent(e);
    if (!at) return;
    lastInteraction = time;
    if (spawn(at) && opts.reduced) settle();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const at = worldFromEvent(e);
    if (!at) return;
    pointer.active = true;
    pointer.world.copy(at);
  });
  canvas.addEventListener("pointerleave", () => {
    pointer.active = false;
  });

  let running = false;
  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    step(dt);
  }
  function start() {
    if (running || opts.reduced) return;
    running = true;
    last = performance.now();
    renderer.setAnimationLoop(frame);
  }
  function stop() {
    running = false;
    renderer.setAnimationLoop(null);
  }

  // When the field changes size (window resize, a pane opening), spread the specimen to fill it
  // instead of leaving everything where the old bounds were.
  new ResizeObserver(() => {
    const [oldW, oldH] = [viewW, viewH];
    measure();
    if (oldW > 0 && oldH > 0 && (Math.abs(viewW / oldW - 1) > 0.02 || Math.abs(viewH / oldH - 1) > 0.02)) {
      for (const a of ab) {
        a.pos.x *= viewW / oldW;
        a.pos.y *= viewH / oldH;
      }
      for (const bug of bugs) {
        bug.pos.x *= viewW / oldW;
        bug.pos.y *= viewH / oldH;
      }
    }
    if (!running) step(0);
  }).observe(canvas);

  const visible = { view: true, page: !document.hidden };
  const sync = () => (visible.view && visible.page ? start() : stop());
  new IntersectionObserver(([entry]) => {
    visible.view = entry.isIntersecting;
    sync();
  }).observe(canvas);
  document.addEventListener("visibilitychange", () => {
    visible.page = !document.hidden;
    sync();
  });

  // Reduced motion: no drift and no animation, just the settled result, like a still micrograph.
  function settle() {
    for (let k = 0; k < 90; k++) step(1 / 30);
  }

  if (opts.reduced) {
    spawn(viewW < viewH ? new THREE.Vector3(0, viewH * 0.27, 0) : new THREE.Vector3(viewW * 0.24, viewH * 0.08, 0));
    settle();
  } else {
    start();
  }

  return {
    /** 0..1 as the hero scrolls away: the microscope zooms in. */
    setZoom(p) {
      zoom = p;
      if (!running) step(0);
    },
    magnification() {
      return 1200 * Math.pow(BASE_Z / camera.position.z, 3);
    },
  };
}
