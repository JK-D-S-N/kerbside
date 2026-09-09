/**
 * The 3D corridor. A stylised 400 m section of the Upper Newtownards Road,
 * built to the real cross-section: two lanes each way, kerbside bus lane,
 * footways, and the terraced/commercial frontage the road actually has.
 *
 * The carriageway is hand-built to the real cross-section. The frontage is not:
 * it is the actual OSM building footprints for this section, extruded to
 * surveyed heights where OSM has them and to storey counts where it does not.
 * See scripts/extract_frontage.py.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FRONTAGE, STREETS, TREES, AVENUE } from './frontage.js';
import { addContext } from './context-render.js';

export const LANE_W = 3.2;
export const ROAD_LEN = 800;
export const HALF = ROAD_LEN / 2;
export const KERB_X = 6.4;         // carriageway edge
export const FOOTWAY_X = 10.0;     // back of footway

/** The Stormont estate gates, from the Prince of Wales Avenue junction. */
export const GATES_Z = (() => {
  let best = null;
  for (const run of AVENUE) {
    for (const [x, z] of run) {
      if (Math.abs(x) < 60 && (best === null || Math.abs(x) < Math.abs(best[0]))) best = [x, z];
    }
  }
  return best ? best[1] : 331;
})();

/** Lane centre lines. Nearside is the kerbside lane in each direction. */
export const LANES = [
  { id: 'in-near', dir: -1, x: -4.8, nearside: true, direction: 'inbound' },
  { id: 'in-off', dir: -1, x: -1.6, nearside: false, direction: 'inbound' },
  { id: 'out-off', dir: 1, x: 1.6, nearside: false, direction: 'outbound' },
  { id: 'out-near', dir: 1, x: 4.8, nearside: true, direction: 'outbound' },
];

/** Deterministic RNG so the streetscape is identical on every reload. */
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Signalised junctions along the drawn length, as world z.
 *
 * These are the real ones: every side street that meets the corridor inside
 * the section, plus the Stormont gates. One signal in the middle of an 800 m
 * arterial was the reason the picture never looked like the road, because it
 * is the stopping that makes the queue, not the volume.
 */
export const JUNCTION_Z = (() => {
  const zs = STREETS.map((st) => st.z);
  zs.push(GATES_Z);
  return zs
    .filter((z) => Math.abs(z) < HALF - 30)
    .sort((a, b) => a - b)
    // Merge junctions closer than 40 m; they operate as one stop line.
    .filter((z, i, all) => i === 0 || z - all[i - 1] > 40);
})();

/**
 * Side-street cross-section. The corridor's own section, narrowed.
 *
 * All three are assumptions. OSM tags no width, lane count or kerb radius on
 * these arms, and 6 m of carriageway with a tight radius is what a Belfast
 * residential T-junction is built to.
 */
export const SIDE_W = 6.0;
const SIDE_FOOT = 1.8;
const KERB_R = 4.5;

/** Half the gap a mouth opens in the corridor kerb and footway. */
export const MOUTH_HALF = SIDE_W / 2 + KERB_R;

/**
 * A side street's centreline from the corridor kerb outwards.
 *
 * Two corrections to the raw OSM line. The extractor already shifts each
 * street so its junction sits on x = 0, because the drawn corridor is straight
 * and the real one curves away from it by up to 30 m. Here the first few
 * metres are also squared up to the corridor, which is how a mouth is actually
 * built, and it keeps the mouth centred on the same z the simulation stops
 * traffic at. Taking the first OSM segment literally skews these arms by
 * twenty degrees, and that is node placement, not the road.
 */
const MOUTH_DEPTH = KERB_R + 2;

function streetLeg(st) {
  const s = st.side;
  const leg = [[s * KERB_X, st.z], [s * (KERB_X + MOUTH_DEPTH), st.z]];
  for (const [x, z] of st.centre || []) {
    if (s * x > KERB_X + MOUTH_DEPTH + 3) leg.push([x, z]);
  }
  return leg;
}

/**
 * The junctions actually drawn. Same source as JUNCTION_Z above, so a mouth
 * and the stop line the simulation queues traffic at cannot drift apart.
 */
export const JUNCTIONS = STREETS
  .map((st) => ({ ...st, leg: streetLeg(st) }))
  .filter((j) => j.leg.length >= 2 && Math.abs(j.z) < HALF - MOUTH_HALF - 4);

/**
 * The Prince of Wales Avenue centreline, gates first, for as far up the hill
 * as this scene is responsible for.
 *
 * OSM splits the named way, so the run with the longest reach is the one worth
 * drawing. It is cut at AVENUE_DRAWN because everything past that belongs to
 * the wider-area geography, and two drives on the same ground is worse than
 * one short one.
 */
export const AVENUE_DRAWN = 190;

export function avenueLine() {
  const reach = (run) => (run.length
    ? Math.max(...run.map((q) => q[0])) - Math.min(...run.map((q) => q[0])) : -1);
  let best = [];
  for (const run of AVENUE) if (reach(run) > reach(best)) best = run;
  if (best.length < 2) return [];

  const line = best[0][0] > best[best.length - 1][0] ? best.slice().reverse() : best.slice();
  const out = [[FOOTWAY_X, GATES_Z]];
  let walked = 0;
  for (const [x, z] of line) {
    if (x < FOOTWAY_X) continue;
    const prev = out[out.length - 1];
    walked += Math.hypot(x - prev[0], z - prev[1]);
    out.push([x, z]);
    if (walked > AVENUE_DRAWN) break;
  }
  return out;
}

/** z spans of one side's kerb and footway left over once the mouths are cut. */
export function kerbSpans(side) {
  const gaps = JUNCTIONS.filter((j) => j.side === side)
    .map((j) => [j.z - MOUTH_HALF, j.z + MOUTH_HALF])
    .sort((a, b) => a[0] - b[0]);
  const spans = [];
  let z = -HALF;
  for (const [a, b] of gaps) {
    if (a > z) spans.push([z, a]);
    z = Math.max(z, b);
  }
  if (z < HALF) spans.push([z, HALF]);
  return spans;
}

/** Kept for the single-stop-line callers; the first junction each way. */
export const SIGNAL_Z = { inbound: -HALF + 70, outbound: HALF - 70 };

/** Glider halts, as world z, one each way. */
export const HALT_Z = { inbound: -HALF + 150, outbound: HALF - 150 };

/**
 * Surface colours per theme. Only the large surfaces are themed; street
 * furniture keeps one set, because a lamp column is dark in both worlds.
 */
const PALETTE = {
  ground:   { dark: 0x141821, light: 0xe3e7ec },
  road:     { dark: 0x2a2f3a, light: 0xc8ccd3 },
  footway:  { dark: 0x3a4150, light: 0xdfe3e9 },
  kerb:     { dark: 0x525b6c, light: 0xeef1f5 },
  marking:  { dark: 0x8b93a7, light: 0xfbfcfe },
  b0:       { dark: 0x39414f, light: 0xf3f5f8 },
  b1:       { dark: 0x454d5d, light: 0xfbfcfd },
  b2:       { dark: 0x2f3744, light: 0xeaedf2 },
  b3:       { dark: 0x515a6c, light: 0xffffff },
  b4:       { dark: 0x3d4553, light: 0xf0f2f6 },
};

export function buildScene(renderer) {
  const scene = new THREE.Scene();

  // Materials that follow the theme, tagged as they are made.
  const themed = [];
  const skin = (role, mat) => {
    mat.color.setHex(PALETTE[role].dark);
    themed.push({ role, mat });
    return mat;
  };

  const group = new THREE.Group();
  scene.add(group);

  // ---- Ground -------------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    skin('ground', new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }))
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.receiveShadow = true;
  group.add(ground);

  // ---- Carriageway --------------------------------------------------------
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(KERB_X * 2, ROAD_LEN),
    skin('road', new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.02 }))
  );
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  group.add(road);

  // ---- Footways -----------------------------------------------------------
  // Broken at every junction mouth. A side road that runs into an unbroken
  // footway is the reason a set of lights on this corridor read as arbitrary.
  const footMat = skin('footway', new THREE.MeshStandardMaterial({ roughness: 0.95 }));
  const footW = FOOTWAY_X - KERB_X;
  for (const side of [-1, 1]) {
    for (const [z0, z1] of kerbSpans(side)) {
      if (z1 - z0 < 0.2) continue;
      const foot = new THREE.Mesh(new THREE.BoxGeometry(footW, 0.14, z1 - z0), footMat);
      foot.position.set(side * (KERB_X + footW / 2), 0.07, (z0 + z1) / 2);
      foot.receiveShadow = true;
      group.add(foot);
    }
  }

  // ---- Lane markings ------------------------------------------------------
  const markMat = skin('marking', new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 }));
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
  const kerbMat = skin('kerb', new THREE.MeshStandardMaterial({ roughness: 0.9 }));
  for (const side of [-1, 1]) {
    for (const [z0, z1] of kerbSpans(side)) {
      if (z1 - z0 < 0.2) continue;
      const k = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.16, z1 - z0), kerbMat);
      k.position.set(side * KERB_X, 0.08, (z0 + z1) / 2);
      group.add(k);
    }
  }

  // ---- Side roads ---------------------------------------------------------
  // Real OSM centrelines, drawn to the corridor's own cross-section but
  // narrower. All three arms are on the south side and all three are priority
  // T-junctions, so there is nothing opposite them and nothing is invented to
  // make the picture symmetrical.
  const roadMat = road.material;

  /**
   * A flat fan in a junction's local frame: u out from the corridor
   * centreline, v along the road from the junction. The corner aprons and the
   * footway that wraps them are both fans, so they share one tessellation.
   */
  function junctionFan(side, jz, hub, rim, y) {
    const pos = [];
    const push = (q) => pos.push(side * q[0], y, jz + q[1]);
    for (let i = 0; i < rim.length - 1; i++) {
      push(hub); push(rim[i]); push(rim[i + 1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    // Flat and face up. Computing them would flip half the fans, because the
    // winding depends on which side of the road the junction is on.
    g.setAttribute('normal', new THREE.Float32BufferAttribute(
      pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    return g;
  }

  /**
   * Carriageway, kerbs and footway laid along a polyline.
   *
   * The default height sits the surface under the corridor's own overlays.
   * Segments overrun each other at bends, so the first one reaches back into
   * the carriageway, and at the same height it would fight the bus lane strip.
   */
  function ribbon(line, width, foot, target, y = 0.004) {
    for (let i = 0; i < line.length - 1; i++) {
      const [x0, z0] = line[i];
      const [x1, z1] = line[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.3) continue;
      const yaw = Math.atan2(x1 - x0, z1 - z0);
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      // Segments overrun each other by a carriageway width, or every bend
      // opens a wedge of bare ground between two rectangles.
      const carr = new THREE.Mesh(new THREE.BoxGeometry(width, 0.02, len + width), roadMat);
      carr.position.set(mx, y, mz);
      carr.rotation.y = yaw;
      carr.receiveShadow = true;
      target.add(carr);
      if (!foot) continue;

      const px = Math.cos(yaw);
      const pz = -Math.sin(yaw);
      for (const sgn of [-1, 1]) {
        const kd = sgn * (width / 2 + 0.12);
        const k = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.16, len + 0.3), kerbMat);
        k.position.set(mx + px * kd, 0.08, mz + pz * kd);
        k.rotation.y = yaw;
        target.add(k);

        const fd = sgn * (width / 2 + 0.25 + foot / 2);
        const f = new THREE.Mesh(new THREE.BoxGeometry(foot, 0.14, len + foot), footMat);
        f.position.set(mx + px * fd, 0.07, mz + pz * fd);
        f.rotation.y = yaw;
        f.receiveShadow = true;
        target.add(f);
      }
    }
  }

  const sideRoads = new THREE.Group();
  group.add(sideRoads);
  const ARC_STEPS = 8;

  for (const j of JUNCTIONS) {
    ribbon(j.leg, SIDE_W, SIDE_FOOT, sideRoads);

    for (const c of [-1, 1]) {
      // The fillet is the square corner between the two kerb lines with the
      // radius taken out of it, so the arc bulges into the footway and the
      // road takes the rest.
      const rim = [];
      const band = [];
      for (let k = 0; k <= ARC_STEPS; k++) {
        const a = (k / ARC_STEPS) * (Math.PI / 2);
        const cu = Math.cos(a);
        const su = Math.sin(a);
        rim.push([KERB_X + KERB_R * (1 - cu), c * (MOUTH_HALF - KERB_R * su)]);
        const r = KERB_R - 0.25;
        band.push([KERB_X + KERB_R - r * cu, c * (MOUTH_HALF - r * su)]);
      }
      const apron = new THREE.Mesh(
        junctionFan(j.side, j.z, [KERB_X, c * SIDE_W / 2], rim, 0.008), roadMat
      );
      apron.receiveShadow = true;
      sideRoads.add(apron);

      // The footway wraps the radius rather than stopping dead at it.
      const wrap = new THREE.Mesh(
        junctionFan(j.side, j.z, [KERB_X + KERB_R, c * MOUTH_HALF], band, 0.14), footMat
      );
      wrap.receiveShadow = true;
      sideRoads.add(wrap);

      // Kerb stones round the radius, which is what makes it read as a corner
      // rather than as a hole in the footway. Each one lies along the tangent,
      // so the yaw has to come off the arc, not off the sweep angle.
      const stoneLen = (KERB_R * Math.PI) / (2 * ARC_STEPS) + 0.1;
      for (let k = 0; k < ARC_STEPS; k++) {
        const a = ((k + 0.5) / ARC_STEPS) * (Math.PI / 2);
        const stone = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.16, stoneLen), kerbMat);
        stone.position.set(
          j.side * (KERB_X + KERB_R * (1 - Math.cos(a))),
          0.08,
          j.z + c * (MOUTH_HALF - KERB_R * Math.sin(a))
        );
        stone.rotation.y = Math.atan2(j.side * Math.sin(a), -c * Math.cos(a));
        sideRoads.add(stone);
      }
    }

    // Give way, not a stop line. These arms are priority-controlled: two rows
    // of transverse dashes across the side road, which is what is painted
    // there. The corridor's own signals are drawn separately.
    for (const row of [1.1, 1.75]) {
      for (let n = -2; n <= 2; n++) {
        const gw = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.6), markMat);
        gw.rotation.x = -Math.PI / 2;
        gw.position.set(j.side * (KERB_X + row), 0.018, j.z + n * 0.9);
        sideRoads.add(gw);
      }
    }
  }

  // ---- Frontage -----------------------------------------------------------
  // Real footprints from OSM. Everything is merged down to one mesh per
  // material so 359 buildings cost five draw calls rather than 359.
  const rand = mulberry32(20260910);
  const buildingMats = ['b0', 'b1', 'b2', 'b3', 'b4'].map(
    (role) => skin(role, new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 }))
  );
  const buckets = buildingMats.map(() => []);
  const litQuads = [];
  const darkQuads = [];

  for (const b of FRONTAGE) {
    // ExtrudeGeometry works in the XY plane and extrudes along +Z, so feed it
    // (x, -z) and lay it down: the footprint lands back on the ground plane
    // with the extrusion running up in y.
    const shape = new THREE.Shape(b.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: b.height, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();
    buckets[b.id % buckets.length].push(geo);

    // Windows go on the wall nearest the carriageway, which is the frontage
    // anyone in the scene can actually see.
    let edge = null;
    for (let i = 0; i < b.ring.length; i++) {
      const p = b.ring[i];
      const q = b.ring[(i + 1) % b.ring.length];
      const mx = (p[0] + q[0]) / 2;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 3) continue;
      if (!edge || Math.abs(mx) < Math.abs(edge.mx)) {
        edge = { p, q, mx, mz: (p[1] + q[1]) / 2, len };
      }
    }
    if (!edge) continue;

    const rows = Math.max(1, Math.min(4, Math.floor(b.height / 3)));
    const angle = Math.atan2(edge.q[0] - edge.p[0], edge.q[1] - edge.p[1]);
    for (let r = 0; r < rows; r++) {
      const quad = new THREE.PlaneGeometry(edge.len * 0.7, 1.1);
      quad.rotateY(angle + Math.PI / 2);
      quad.translate(
        edge.mx - Math.sign(edge.mx) * 0.06,
        1.9 + r * 3,
        edge.mz
      );
      (rand() < 0.62 ? litQuads : darkQuads).push(quad);
    }
  }

  // Outlines. Hidden in dark mode, where solid massing reads better; the whole
  // point of the light mode is the line-work, so they carry it there.
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1d2430, transparent: true, opacity: 0 });
  const outlines = [];
  // Everything that grows out of the ground on load lives in one group, so the
  // entry animation is a single scale rather than 900 tweens.
  const frontage = new THREE.Group();
  group.add(frontage);

  buckets.forEach((geos, i) => {
    if (!geos.length) return;
    const merged = mergeGeometries(geos);
    const mesh = new THREE.Mesh(merged, buildingMats[i]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    frontage.add(mesh);

    const line = new THREE.LineSegments(new THREE.EdgesGeometry(merged, 22), edgeMat);
    frontage.add(line);
    outlines.push(line);

    geos.forEach((g) => g.dispose());
  });

  // Two merged window meshes rather than 900 loose ones. applyTimeOfDay still
  // sees an array of things with a `lit` flag and an opacity to drive.
  const windows = [];
  for (const [quads, lit] of [[litQuads, true], [darkQuads, false]]) {
    if (!quads.length) continue;
    const mesh = new THREE.Mesh(
      mergeGeometries(quads),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    mesh.userData.lit = lit;
    frontage.add(mesh);
    windows.push(mesh);
    quads.forEach((q) => q.dispose());
  }

  // ---- Stormont ----------------------------------------------------------
  // The gates are the one thing on this road that tells a Belfast audience
  // exactly where they are standing. Piers, the gate leaves, and the avenue
  // running away up the hill to Parliament Buildings.
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6a7180, roughness: 0.92 });
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.5, metalness: 0.6 });
  const gateGroup = new THREE.Group();

  if (Math.abs(GATES_Z) < HALF) {
    const side = 1;   // the estate is the north side of the road
    for (const off of [-9, -3.2, 3.2, 9]) {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(1.5, off === -9 || off === 9 ? 6.2 : 5.2, 1.5), stoneMat);
      pier.position.set(side * (FOOTWAY_X + 2.2), (off === -9 || off === 9 ? 6.2 : 5.2) / 2, GATES_Z + off);
      pier.castShadow = true;
      gateGroup.add(pier);
    }
    // Gate leaves between the inner piers.
    for (const off of [-1.6, 1.6]) {
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.6, 3.1), ironMat);
      leaf.position.set(side * (FOOTWAY_X + 2.2), 1.9, GATES_Z + off);
      gateGroup.add(leaf);
    }
    // The avenue, on its real centreline rather than a fixed strip. It is what
    // leads the eye to Parliament Buildings at the top, so where it points
    // matters: it does not run square to the road, it swings north.
    const drive = avenueLine();
    if (drive.length >= 2) ribbon(drive, 13, 0, gateGroup, 0.03);

    // Its lime avenue, which is what you actually see from the road. Only the
    // first stretch; past that they are a smudge and cost 200 draw calls.
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a3128, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f4a2c, roughness: 1 });
    let walked = 0;
    for (let i = 0; i < drive.length - 1 && walked < AVENUE_DRAWN; i++) {
      const [x0, z0] = drive[i];
      const [x1, z1] = drive[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.5) continue;
      const ux = (x1 - x0) / len;
      const uz = (z1 - z0) / len;
      for (let d = 13 - (walked % 13); d < len && walked + d < AVENUE_DRAWN; d += 13) {
        for (const w of [-9.5, 9.5]) {
          const tx = x0 + ux * d + uz * w;
          const tz = z0 + uz * d - ux * w;
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 4.4, 6), trunkMat);
          trunk.position.set(tx, 2.2, tz);
          gateGroup.add(trunk);
          const crown = new THREE.Mesh(new THREE.SphereGeometry(3.1, 8, 6), leafMat);
          crown.position.set(tx, 6.1, tz);
          crown.castShadow = true;
          gateGroup.add(crown);
        }
      }
      walked += len;
    }
  }
  group.add(gateGroup);

  // ---- Street names -------------------------------------------------------
  // Laid flat on the ground at the junction, the way a map prints them. A
  // local reads one of these faster than any coordinate.
  const streetLabels = [];
  for (const st of STREETS) {
    const pad = 24;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = '600 46px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif';
    const text = st.name.toUpperCase();
    const spacing = 3;
    ctx.font = font;
    ctx.letterSpacing = `${spacing}px`;
    // Measure with the tracking applied, or the last glyph runs off the canvas.
    const w = Math.ceil(ctx.measureText(text).width) + spacing * text.length + pad * 2;
    canvas.width = w;
    canvas.height = 96;

    const c2 = canvas.getContext('2d');
    c2.font = font;
    c2.letterSpacing = `${spacing}px`;
    c2.textBaseline = 'middle';
    c2.fillStyle = '#0f1620';
    c2.fillText(text, pad, 52);

    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const scale = 0.062;
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(canvas.width * scale, canvas.height * scale),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false })
    );
    label.rotation.x = -Math.PI / 2;
    // Sit it just off the carriageway on the side the street joins, reading
    // along the road so it never fights the corridor.
    label.position.set(st.side * (FOOTWAY_X + 6.5), 0.06, st.z);
    label.rotation.z = Math.PI / 2;
    group.add(label);
    streetLabels.push(label);
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
  const signalHeads = { inbound: [], outbound: [] };
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

  // The wider geography, so the corridor sits somewhere recognisable rather
  // than in a void 95 m from the kerb. See src/context-render.js.
  const context = addContext(group, { skin, renderer });

  return {
    scene, group, context, sun, hemi, ambient,
    busLanes, cycleLanes, windows, lampHeads, signals, halts,
    themed, theme: 'dark', outlines, edgeMat, streetLabels, frontage,
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
  { h: 0, sky: 0x121a2b, sunCol: 0x4a5a80, sunI: 0.08, elev: -8, azi: 200, lamp: 1.0 },
  { h: 5, sky: 0x2b3a63, sunCol: 0x8a7fa8, sunI: 0.25, elev: -1, azi: 68, lamp: 1.0 },
  { h: 7, sky: 0x8a9bc4, sunCol: 0xffb083, sunI: 1.5, elev: 12, azi: 84, lamp: 0.35 },
  { h: 9, sky: 0xbcd0ee, sunCol: 0xffe0bd, sunI: 2.5, elev: 32, azi: 112, lamp: 0 },
  { h: 13, sky: 0xd2e2f6, sunCol: 0xfff6ea, sunI: 3.0, elev: 52, azi: 180, lamp: 0 },
  { h: 17, sky: 0xc6d8f0, sunCol: 0xffe6c4, sunI: 2.2, elev: 27, azi: 248, lamp: 0 },
  { h: 19, sky: 0x9a8fb0, sunCol: 0xff9a5e, sunI: 0.9, elev: 7, azi: 276, lamp: 0.5 },
  { h: 21, sky: 0x323f61, sunCol: 0x5a6690, sunI: 0.22, elev: -5, azi: 292, lamp: 1.0 },
  { h: 24, sky: 0x121a2b, sunCol: 0x4a5a80, sunI: 0.08, elev: -8, azi: 200, lamp: 1.0 },
];

/**
 * Swap the large surfaces between themes. The sky still comes from the hour,
 * but in light mode it is floored so a night scene stays readable on a
 * projector instead of going to black.
 */
export function setSceneTheme(world, mode) {
  world.theme = mode === 'light' ? 'light' : 'dark';
  for (const { role, mat } of world.themed) mat.color.setHex(PALETTE[role][world.theme]);

  // Light mode is the line-work drawing: pale flat massing, dark outlines,
  // street names on the deck. Dark mode is solid massing and no outlines.
  const light = world.theme === 'light';
  world.edgeMat.opacity = light ? 0.9 : 0;
  for (const l of world.outlines) l.visible = light;
  for (const l of world.streetLabels) {
    l.material.opacity = (light ? 0.85 : 0.32) * (world.labelReveal ?? 1);
  }
  world.context?.setTheme(world.theme);
}

export function applyTimeOfDay(world, hourFloat, renderer) {
  const h = ((hourFloat % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const t = (h - a.h) / (b.h - a.h);

  let sky = mixHex(a.sky, b.sky, t);
  let fogCol = sky;
  if (world.theme === 'light') {
    // Lift the night end towards paper without flattening midday. The fog is
    // held back from the sky colour and pushed out, or a pale sky bleaches the
    // corridor away to nothing.
    sky = sky.clone().lerp(new THREE.Color(0xe8eef7), 0.55);
    fogCol = sky.clone().lerp(new THREE.Color(0x9aa6b8), 0.45);
  }
  const sunCol = mixHex(a.sunCol, b.sunCol, t);
  const sunI = a.sunI + (b.sunI - a.sunI) * t;
  const elev = a.elev + (b.elev - a.elev) * t;
  const azi = a.azi + (b.azi - a.azi) * t;
  const lamp = a.lamp + (b.lamp - a.lamp) * t;

  world.scene.background = sky;
  world.scene.fog.color = fogCol;
  world.scene.fog.near = world.theme === 'light' ? 420 : 260;
  world.scene.fog.far = world.theme === 'light' ? 2200 : 1700;
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
  const lift = world.theme === 'light' ? 1.35 : 1;
  world.hemi.intensity = (0.32 + sunI * 0.34) * lift;
  world.ambient.intensity = (0.22 + sunI * 0.14) * lift;

  for (const w of world.windows) {
    w.material.opacity = w.userData.lit ? lamp * 0.85 : lamp * 0.06;
  }
  for (const l of world.lampHeads) l.material.opacity = lamp;

  return { lamp, sky };
}
