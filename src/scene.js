/**
 * The 3D corridor. A stylised 400 m section of the Upper Newtownards Road,
 * built to the real cross-section: two lanes each way, kerbside bus lane,
 * footways, and the terraced/commercial frontage the road actually has.
 *
 * Geometry is hand-built, not surveyed. A published map tile or OSM extract
 * cannot be fetched from this page, and eyeballed geometry is honest about
 * what it is.
 */
import * as THREE from 'three';

export const LANE_W = 3.2;
export const ROAD_LEN = 400;
export const HALF = ROAD_LEN / 2;
export const KERB_X = 6.4;         // carriageway edge
export const FOOTWAY_X = 10.0;     // back of footway

/** Lane centre lines. Nearside is the kerbside lane in each direction. */
export const LANES = [
  { id: 'in-near', dir: -1, x: -4.8, nearside: true, direction: 'inbound' },
  { id: 'in-off', dir: -1, x: -1.6, nearside: false, direction: 'inbound' },
  { id: 'out-off', dir: 1, x: 1.6, nearside: false, direction: 'outbound' },
  { id: 'out-near', dir: 1, x: 4.8, nearside: true, direction: 'outbound' },
];

/** Deterministic RNG so the streetscape is identical on every reload. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where a signal sits along each direction, as world z. */
export const SIGNAL_Z = { inbound: -HALF + 70, outbound: HALF - 70 };

/** Glider halts, as world z, one each way. */
export const HALT_Z = { inbound: -HALF + 150, outbound: HALF - 150 };

export function buildScene(renderer) {
  const scene = new THREE.Scene();

  const group = new THREE.Group();
  scene.add(group);

  // ---- Ground -------------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshStandardMaterial({ color: 0x141821, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.receiveShadow = true;
  group.add(ground);

  // ---- Carriageway --------------------------------------------------------
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(KERB_X * 2, ROAD_LEN),
    new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.9, metalness: 0.02 })
  );
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  group.add(road);

  // ---- Footways -----------------------------------------------------------
  const footMat = new THREE.MeshStandardMaterial({ color: 0x3a4150, roughness: 0.95 });
  for (const side of [-1, 1]) {
    const w = FOOTWAY_X - KERB_X;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, ROAD_LEN), footMat);
    foot.position.set(side * (KERB_X + w / 2), 0.07, 0);
    foot.receiveShadow = true;
    group.add(foot);
  }

  // ---- Lane markings ------------------------------------------------------
  const markMat = new THREE.MeshBasicMaterial({ color: 0x8b93a7, transparent: true, opacity: 0.5 });
  // Centre line, solid.
  const centre = new THREE.Mesh(new THREE.PlaneGeometry(0.3, ROAD_LEN), markMat);
  centre.rotation.x = -Math.PI / 2;
  centre.position.y = 0.012;
  group.add(centre);
  // Lane dividers, dashed, between the two lanes of each direction.
  const dash = new THREE.PlaneGeometry(0.16, 3.2);
  for (const x of [-3.2, 3.2]) {
    for (let z = -HALF + 3; z < HALF; z += 8) {
      const m = new THREE.Mesh(dash, markMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.012, z);
      group.add(m);
    }
  }

  // ---- Bus lane overlay (toggled by the model) ----------------------------
  const busLaneMat = new THREE.MeshBasicMaterial({
    color: 0xd95926, transparent: true, opacity: 0, depthWrite: false,
  });
  const busLanes = [];
  for (const lane of LANES.filter((l) => l.nearside)) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W - 0.2, ROAD_LEN), busLaneMat.clone());
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(lane.x, 0.016, 0);
    group.add(strip);
    busLanes.push(strip);
  }

  // ---- Cycle lane overlay (toggled) --------------------------------------
  const cycleLanes = [];
  for (const lane of LANES.filter((l) => !l.nearside)) {
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(LANE_W - 0.2, ROAD_LEN),
      new THREE.MeshBasicMaterial({ color: 0x1baf7a, transparent: true, opacity: 0, depthWrite: false })
    );
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(lane.x, 0.016, 0);
    group.add(strip);
    cycleLanes.push(strip);
  }

  // ---- Kerbs --------------------------------------------------------------
  const kerbMat = new THREE.MeshStandardMaterial({ color: 0x525b6c, roughness: 0.9 });
  for (const side of [-1, 1]) {
    const k = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.16, ROAD_LEN), kerbMat);
    k.position.set(side * KERB_X, 0.08, 0);
    group.add(k);
  }

  // ---- Frontage -----------------------------------------------------------
  const rand = mulberry32(20260910);
  const buildingMats = [0x39414f, 0x454d5d, 0x2f3744, 0x515a6c, 0x3d4553].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0.05 })
  );
  const windowMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0 });
  const windows = [];

  for (const side of [-1, 1]) {
    let z = -HALF;
    while (z < HALF) {
      const depth = 10 + rand() * 16;
      const width = 7 + rand() * 12;
      const height = 5.5 + rand() * 5;
      const gap = rand() < 0.14 ? 6 + rand() * 10 : 0.6; // side streets and entries

      const b = new THREE.Mesh(
        new THREE.BoxGeometry(depth, height, width),
        buildingMats[(rand() * buildingMats.length) | 0]
      );
      b.position.set(side * (FOOTWAY_X + depth / 2), height / 2, z + width / 2);
      b.castShadow = true;
      b.receiveShadow = true;
      group.add(b);

      // A strip of windows facing the road, lit after dark.
      const rows = Math.max(1, Math.floor(height / 3));
      for (let r = 0; r < rows; r++) {
        const w = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.72, 1.1), windowMat.clone());
        w.position.set(
          side * (FOOTWAY_X + 0.02),
          1.9 + r * 3,
          z + width / 2
        );
        w.rotation.y = side * Math.PI / 2 * -1;
        w.userData.lit = rand() < 0.62;
        group.add(w);
        windows.push(w);
      }
      z += width + gap;
    }
  }

  // ---- Street lighting ----------------------------------------------------
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x3a4150, roughness: 0.6, metalness: 0.4 });
  const lampHeadMat = new THREE.MeshBasicMaterial({ color: 0xffce8a, transparent: true, opacity: 0 });
  const lampHeads = [];
  for (const side of [-1, 1]) {
    for (let z = -HALF + 20; z < HALF; z += 34) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 8, 6), lampMat);
      post.position.set(side * (KERB_X + 0.9), 4, z);
      group.add(post);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.12), lampMat);
      arm.position.set(side * (KERB_X + 0.2), 7.9, z);
      group.add(arm);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), lampHeadMat.clone());
      head.position.set(side * (KERB_X - 0.5), 7.8, z);
      group.add(head);
      lampHeads.push(head);
    }
  }

  // ---- Glider halts -------------------------------------------------------
  const halts = [];
  for (const [direction, z] of Object.entries(HALT_Z)) {
    const side = direction === 'inbound' ? -1 : 1;
    const shelter = new THREE.Group();
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.16, 11),
      new THREE.MeshStandardMaterial({ color: 0x2b313e, roughness: 0.6, metalness: 0.3 })
    );
    roof.position.set(0, 3.1, 0);
    shelter.add(roof);
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 2.4, 11),
      new THREE.MeshStandardMaterial({
        color: 0x6d7c96, roughness: 0.15, metalness: 0.1,
        transparent: true, opacity: 0.28,
      })
    );
    glass.position.set(side * 1.2, 1.7, 0);
    shelter.add(glass);
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.06, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xd95926 })
    );
    strip.position.set(0, 3.24, -4.8);
    shelter.add(strip);
    shelter.position.set(side * (KERB_X + 1.8), 0.14, z);
    group.add(shelter);
    halts.push(shelter);
  }

  // ---- Signal heads -------------------------------------------------------
  const signals = {};
  for (const [direction, z] of Object.entries(SIGNAL_Z)) {
    const side = direction === 'inbound' ? -1 : 1;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 3.4, 6),
      new THREE.MeshStandardMaterial({ color: 0x2c313c, roughness: 0.7 })
    );
    pole.position.set(side * (KERB_X + 0.5), 1.7, z);
    group.add(pole);

    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 1.0, 0.34),
      new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.8 })
    );
    box.position.set(side * (KERB_X + 0.5), 3.7, z);
    group.add(box);

    const red = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xd03b3b })
    );
    red.position.set(side * (KERB_X + 0.5) - side * 0.2, 4.05, z);
    const green = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x0ca30c })
    );
    green.position.set(side * (KERB_X + 0.5) - side * 0.2, 3.35, z);
    group.add(red, green);

    // Stop line.
    const stop = new THREE.Mesh(
      new THREE.PlaneGeometry(LANE_W * 2, 0.4),
      new THREE.MeshBasicMaterial({ color: 0xb8c0d0, transparent: true, opacity: 0.55 })
    );
    stop.rotation.x = -Math.PI / 2;
    stop.position.set(side * 3.2, 0.014, z);
    group.add(stop);

    signals[direction] = { red, green };
  }

  // ---- Lighting -----------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xbcd0ee, 0x1a1e28, 0.8);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(60, 90, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const d = 190;
  sun.shadow.camera.left = -d;
  sun.shadow.camera.right = d;
  sun.shadow.camera.top = d;
  sun.shadow.camera.bottom = -d;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0006;
  scene.add(sun);
  const ambient = new THREE.AmbientLight(0xffffff, 0.18);
  scene.add(ambient);

  scene.fog = new THREE.Fog(0x0b0e14, 150, 720);

  return {
    scene, group, sun, hemi, ambient,
    busLanes, cycleLanes, windows, lampHeads, signals, halts,
  };
}

/** Linear interpolation between two hex colours. */
function mixHex(a, b, t) {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return ca.lerp(cb, t);
}

/**
 * Time-of-day keyframes: sky/fog colour, sun colour, sun intensity, sun
 * elevation and azimuth, and how lit the artificial lighting is.
 */
const KEYS = [
  { h: 0, sky: 0x090d16, sunCol: 0x4a5a80, sunI: 0.08, elev: -8, azi: 200, lamp: 1.0 },
  { h: 5, sky: 0x18213a, sunCol: 0x8a7fa8, sunI: 0.25, elev: -1, azi: 68, lamp: 1.0 },
  { h: 7, sky: 0x4a5570, sunCol: 0xffb083, sunI: 1.5, elev: 12, azi: 84, lamp: 0.35 },
  { h: 9, sky: 0x7d95b8, sunCol: 0xffe0bd, sunI: 2.5, elev: 32, azi: 112, lamp: 0 },
  { h: 13, sky: 0x93aecb, sunCol: 0xfff6ea, sunI: 3.0, elev: 52, azi: 180, lamp: 0 },
  { h: 17, sky: 0x87a0c0, sunCol: 0xffe6c4, sunI: 2.2, elev: 27, azi: 248, lamp: 0 },
  { h: 19, sky: 0x5a5f7d, sunCol: 0xff9a5e, sunI: 0.9, elev: 7, azi: 276, lamp: 0.5 },
  { h: 21, sky: 0x1b2338, sunCol: 0x5a6690, sunI: 0.22, elev: -5, azi: 292, lamp: 1.0 },
  { h: 24, sky: 0x090d16, sunCol: 0x4a5a80, sunI: 0.08, elev: -8, azi: 200, lamp: 1.0 },
];

export function applyTimeOfDay(world, hourFloat, renderer) {
  const h = ((hourFloat % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const t = (h - a.h) / (b.h - a.h);

  const sky = mixHex(a.sky, b.sky, t);
  const sunCol = mixHex(a.sunCol, b.sunCol, t);
  const sunI = a.sunI + (b.sunI - a.sunI) * t;
  const elev = a.elev + (b.elev - a.elev) * t;
  const azi = a.azi + (b.azi - a.azi) * t;
  const lamp = a.lamp + (b.lamp - a.lamp) * t;

  world.scene.background = sky;
  world.scene.fog.color = sky;
  renderer.setClearColor(sky, 1);

  world.sun.color = sunCol;
  world.sun.intensity = sunI;
  const er = THREE.MathUtils.degToRad(elev);
  const ar = THREE.MathUtils.degToRad(azi);
  const R = 180;
  world.sun.position.set(
    R * Math.cos(er) * Math.sin(ar),
    Math.max(4, R * Math.sin(er)),
    R * Math.cos(er) * Math.cos(ar)
  );
  world.hemi.intensity = 0.32 + sunI * 0.34;
  world.ambient.intensity = 0.22 + sunI * 0.14;

  for (const w of world.windows) {
    w.material.opacity = w.userData.lit ? lamp * 0.85 : lamp * 0.06;
  }
  for (const l of world.lampHeads) l.material.opacity = lamp;

  return { lamp, sky };
}
