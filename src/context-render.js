/**
 * The wider geography around the modelled section.
 *
 * src/scene.js draws 800 m of carriageway and the frontage 95 m either side of
 * it. Past that the world stops, which is why the view kept failing the only
 * question that matters to someone who drives this road: where am I. This adds
 * back what a local actually navigates by. The Stormont gates and the avenue
 * running up to Parliament Buildings, the estate and its parkland, Campbell
 * College, the churches, Castlehill Road and the Knock dual carriageway at
 * their real junctions, and enough further-back massing that the townscape
 * fades out instead of ending at a line.
 *
 * All of it is OpenStreetMap, extracted by scripts/extract_context.py into
 * src/context.js in the same frame as src/frontage.js.
 *
 * This module deliberately does not import scene.js. scene.js will import it,
 * and a cycle between the two would leave whichever loaded second holding
 * undefined constants. The few numbers it needs from over there are declared
 * below with the values they have to match.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CONTEXT_ROADS, CONTEXT_JUNCTIONS, CONTEXT_MASSING, CONTEXT_LANDMARKS,
  CONTEXT_SPIRES, CONTEXT_LABELS, CONTEXT_GREEN, CONTEXT_AVENUE,
  CONTEXT_TERRAIN,
} from './context.js';

// Must match scene.js. FOOTWAY_X is the back of the footway, which is where a
// label can sit without landing on the carriageway.
const FOOTWAY_X = 10.0;
const SECTION_HALF = 400.0;
// Carriageway, kerbs, both footways and the street-name labels, with a margin.
// No flat context surface is allowed inside this box at all. Depth bias was
// tried first and it is the wrong tool: polygon offset scales with the depth
// slope, so at the grazing angle the working camera sits at, a near-horizontal
// polygon gets thrown tens of metres forward and buries the carriageway.
const CORRIDOR_CUT = 20.0;

// scene.js lays its flat ground at y = -0.06. The context ground goes just
// under it so the two never fight for the same depth, and so the seam at the
// edge of that square is a step of a couple of centimetres rather than a wall.
const GROUND_Y = -0.3;
// Flat surfaces ride this far above the context ground. The camera near plane
// is 0.5 m and the far plane 1600 m, which leaves about 0.3 m of depth
// resolution at the far edge, so the clearance has to be bigger than that or
// the parkland and the ground trade places in the distance. It is only safe to
// lift them this far because they are cut out of the corridor box first.
const GRASS_LIFT = 0.55;
const RIBBON_LIFT = 0.70;

/**
 * The four regions outside the corridor box, each convex, together covering
 * everything the box does not. Half-planes are [a, b, c], keeping a*x + b*z + c >= 0.
 */
const OUTSIDE = [
  [[-1, 0, -CORRIDOR_CUT]],
  [[1, 0, -CORRIDOR_CUT]],
  [[1, 0, CORRIDOR_CUT], [-1, 0, CORRIDOR_CUT], [0, -1, -SECTION_HALF]],
  [[1, 0, CORRIDOR_CUT], [-1, 0, CORRIDOR_CUT], [0, 1, -SECTION_HALF]],
];

/**
 * Parkland has no role in scene.js's PALETTE, so these are carried here.
 * Muted rather than literal: a saturated green would shout louder than the
 * corridor in dark mode and break the line-work in light mode.
 */
const CONTEXT_PALETTE = {
  grass: { dark: 0x1d2c22, light: 0xd0dfc7 },
  wood:  { dark: 0x16221b, light: 0xbdd0b7 },
  water: { dark: 0x1b2c3a, light: 0xcedae6 },
  spire: { dark: 0x565f70, light: 0xdfe3ea },
};

/**
 * Add the context to an existing scene group.
 *
 * @param {THREE.Group} group  the scene group everything else is parented to
 * @param {object} [opts]
 * @param {(role: string, mat: THREE.Material) => THREE.Material} [opts.skin]
 *        scene.js's material tagger. Pass it and the ground, roads, massing
 *        and landmarks follow the existing theme swap with no extra wiring.
 * @param {THREE.WebGLRenderer} [opts.renderer]  for label texture anisotropy
 * @param {number} [opts.range]      metres of context to draw, default 1500
 * @param {number} [opts.labelRank]  1 for the headline names only, 2 for all
 * @param {boolean} [opts.terrain]   draw real ground heights outside the
 *                                   modelled section, default true
 * @param {number} [opts.labelScale] multiplier on label size, default 1
 * @param {number} [opts.labelFacing] 1 or -1. Ground labels read along the
 *                                   corridor, so they read backwards from one
 *                                   end of it. Flip this if the app's default
 *                                   camera is at the wrong end.
 * @returns {{group: THREE.Group, layers: object, labels: THREE.Mesh[],
 *            setTheme: (mode: string) => void, dispose: () => void}}
 */
export function addContext(group, opts = {}) {
  const {
    skin = (role, mat) => mat,
    renderer = null,
    range = 1500,
    labelRank = 2,
    terrain = true,
    labelFacing = 1,
    labelScale = 1,
  } = opts;

  const root = new THREE.Group();
  root.name = 'context';
  group.add(root);

  const themed = [];                 // our own materials, for setTheme below
  const own = (role, mat) => { themed.push({ role, mat }); return mat; };
  const disposables = [];
  const sample = terrainSampler();

  // ---- Ground -------------------------------------------------------------
  // A real DEM outside the modelled section, faded to flat under it by the
  // extractor. Stormont being 60 m up a hill is most of why the gates read as
  // the gates, and a flat plane throws that away.
  const groundMat = skin('ground', new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }));
  const groundMesh = new THREE.Mesh(terrainGeometry(sample, terrain), groundMat);
  groundMesh.position.y = GROUND_Y;
  groundMesh.receiveShadow = true;
  root.add(groundMesh);

  // ---- Parkland -----------------------------------------------------------
  const greenBuckets = { grass: [], wood: [], water: [] };
  for (const g of CONTEXT_GREEN) {
    if (!withinRange(g.ring, range)) continue;
    const geo = surface(polygonTriangles(g.ring), sample, GRASS_LIFT);
    if (geo) greenBuckets[g.kind].push(geo);
  }
  const layers = {};
  for (const kind of Object.keys(greenBuckets)) {
    const geos = greenBuckets[kind];
    if (!geos.length) continue;
    const mat = own(kind, new THREE.MeshStandardMaterial({
      roughness: 1, metalness: 0, side: THREE.DoubleSide,
    }));
    mat.color.setHex(CONTEXT_PALETTE[kind].dark);
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.receiveShadow = true;
    root.add(mesh);
    layers[kind] = mesh;
    geos.forEach((q) => q.dispose());
  }

  // ---- Roads --------------------------------------------------------------
  // Every named road out here as a flat ribbon at its surveyed width. The
  // junctions are the point: "is Castlehill Road near here" has an answer now.
  const ribbons = [];
  for (const r of [...CONTEXT_ROADS, ...CONTEXT_AVENUE.map(toAvenue)]) {
    if (!withinRange(r.path, range)) continue;
    // The A20 runs straight through the middle of the model, so the corridor
    // is cut out of every ribbon rather than trusted to sit under the
    // carriageway.
    const geo = surface(ribbonTriangles(r.path, r.w), sample, RIBBON_LIFT);
    if (geo) ribbons.push(geo);
  }
  if (ribbons.length) {
    const mesh = new THREE.Mesh(
      mergeGeometries(ribbons),
      skin('road', new THREE.MeshStandardMaterial({
        roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
      }))
    );
    mesh.receiveShadow = true;
    root.add(mesh);
    layers.roads = mesh;
    ribbons.forEach((g) => g.dispose());
  }

  // ---- Distant massing ----------------------------------------------------
  // One oriented box per building, all merged. Two and a half thousand of them
  // is one draw call, which is the only reason it is affordable to have the
  // townscape carry on to the horizon.
  const boxes = [];
  for (const [x, z, w, d, rot, h, base] of CONTEXT_MASSING) {
    if (Math.hypot(x, z) > range) continue;
    const geo = new THREE.BoxGeometry(w, h, d);
    // The extractor's rotation is the box's long axis measured in the (x, z)
    // plane. rotateY turns local +x towards -z, hence the sign.
    geo.rotateY(-rot);
    geo.translate(x, GROUND_Y + base + h / 2, z);
    boxes.push(geo);
  }
  if (boxes.length) {
    const mesh = new THREE.Mesh(
      mergeGeometries(boxes),
      skin('b2', new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 }))
    );
    mesh.castShadow = false;      // 2,700 shadow casters at 1 km buys nothing
    mesh.receiveShadow = true;
    root.add(mesh);
    layers.massing = mesh;
    boxes.forEach((g) => g.dispose());
  }

  // ---- Landmark buildings -------------------------------------------------
  // Kept at full outline, because their shape is part of how you recognise
  // them. Parliament Buildings at the head of the avenue is the whole point.
  const solids = [];
  for (const b of CONTEXT_LANDMARKS) {
    if (!withinRange(b.ring, range)) continue;
    // ExtrudeGeometry works in XY and extrudes along +Z, so feed it (x, -z)
    // and lay it down. Same trick as the frontage in scene.js.
    const shape = new THREE.Shape(b.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: b.h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, GROUND_Y + b.b, 0);
    geo.computeVertexNormals();
    solids.push(geo);
  }
  if (solids.length) {
    const mesh = new THREE.Mesh(
      mergeGeometries(solids),
      skin('b3', new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }))
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    layers.landmarks = mesh;
    solids.forEach((g) => g.dispose());
  }

  // ---- Church spires ------------------------------------------------------
  // A marker at the church, not a surveyed structure. See the extractor.
  const cones = [];
  for (const s of CONTEXT_SPIRES) {
    if (Math.hypot(s.x, s.z) > range) continue;
    const geo = new THREE.ConeGeometry(2.6, s.h, 6);
    geo.translate(s.x, GROUND_Y + s.b + s.h / 2, s.z);
    cones.push(geo);
  }
  if (cones.length) {
    const mat = own('spire', new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }));
    mat.color.setHex(CONTEXT_PALETTE.spire.dark);
    const mesh = new THREE.Mesh(mergeGeometries(cones), mat);
    mesh.castShadow = true;
    root.add(mesh);
    layers.spires = mesh;
    cones.forEach((g) => g.dispose());
  }

  // ---- Names --------------------------------------------------------------
  // Laid flat and running along the corridor, the way scene.js prints the
  // street names and the way a map prints anything. Held deliberately below
  // the weight of those: scene.js uses 0.062 on the same 46px canvas, and the
  // context is background to the corridor, not competition for it.
  const labels = [];
  const place = (mesh, x, y, z) => {
    mesh.position.set(x, GROUND_Y + y + 0.8, z);
    root.add(mesh);
    labels.push(mesh);
    disposables.push(mesh);
  };
  for (const l of CONTEXT_LABELS) {
    if (l.rank > labelRank || Math.hypot(l.x, l.z) > range * 1.35) continue;
    // Nothing of ours goes over the modelled carriageway, labels included.
    if (Math.abs(l.x) < CORRIDOR_CUT + 12 && Math.abs(l.z) < SECTION_HALF) continue;
    place(groundLabel(shorten(l.name), (l.rank === 1 ? 0.055 : 0.042) * labelScale,
                      70 * labelScale, renderer, labelFacing), l.x, l.y, l.z);
  }
  for (const j of CONTEXT_JUNCTIONS) {
    if (j.rank > labelRank || Math.abs(j.z) > range) continue;
    if (Math.abs(j.z) < SECTION_HALF) continue;   // scene.js owns those
    const side = j.x < 0 ? -1 : 1;
    place(groundLabel(withRef(j), (j.rank === 1 ? 0.05 : 0.04) * labelScale,
                      55 * labelScale, renderer, labelFacing),
          side * (FOOTWAY_X + 13), 0, j.z);
  }

  const handle = {
    group: root,
    layers,
    labels,
    setTheme(mode) {
      const key = mode === 'light' ? 'light' : 'dark';
      for (const { role, mat } of themed) mat.color.setHex(CONTEXT_PALETTE[role][key]);
    },
    dispose() {
      root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const m of disposables) m.material.map?.dispose();
      group.remove(root);
    },
  };
  return handle;
}

/**
 * Optional. scene.js's setSceneTheme already recolours everything passed
 * through `skin`; this catches the parkland and the spires, which have no
 * role in that palette.
 */
export function setContextTheme(context, mode) {
  context?.setTheme(mode);
}


// ---- Helpers --------------------------------------------------------------

/** Bilinear lookup into the DEM grid in context.js. Flat if it is missing. */
function terrainSampler() {
  const { h, n, step, half } = CONTEXT_TERRAIN;
  if (!h) return () => 0;
  return (x, z) => {
    const fi = Math.min(n - 1.001, Math.max(0, (x + half) / step));
    const fj = Math.min(n - 1.001, Math.max(0, (z + half) / step));
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const tu = fi - i;
    const tv = fj - j;
    const a = h[j * n + i];
    const b = h[j * n + i + 1];
    const c = h[(j + 1) * n + i];
    const d = h[(j + 1) * n + i + 1];
    return (a * (1 - tu) + b * tu) * (1 - tv) + (c * (1 - tu) + d * tu) * tv;
  };
}

/** The ground itself, as a grid over the DEM. */
function terrainGeometry(sample, useTerrain) {
  const { n, step, half } = CONTEXT_TERRAIN;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + i * step;
      const z = -half + j * step;
      const k = (j * n + i) * 3;
      pos[k] = x;
      pos[k + 1] = useTerrain ? sample(x, z) : 0;
      pos[k + 2] = z;
    }
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** True if any part of a ring or path is close enough to bother drawing. */
function withinRange(pts, range) {
  for (const [x, z] of pts) if (Math.hypot(x, z) <= range) return true;
  return false;
}

/**
 * A polygon reduced to flat triangles in the (x, z) plane.
 *
 * Shape triangulation gives the fewest triangles that fill the ring, which for
 * the Stormont estate is a handful spanning a kilometre. Sampling ground height
 * only at their corners turns a hill into a tilted lid and buries everything
 * standing on it, Parliament Buildings included, so the fan is bisected down to
 * something near the DEM spacing first.
 */
function polygonTriangles(ring) {
  if (ring.length < 3) return [];
  const shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, z)));
  let flat;
  try {
    flat = new THREE.ShapeGeometry(shape);
  } catch {
    return [];                        // self-intersecting rings do exist in OSM
  }
  const src = flat.attributes.position;
  const index = flat.getIndex();
  if (!src.count || !index) { flat.dispose(); return []; }

  const pts = [];
  for (let i = 0; i < src.count; i++) pts.push([src.getX(i), src.getY(i)]);
  let tris = Array.from(index.array);
  flat.dispose();

  // Longest-edge bisection. Midpoints are shared through the cache, so a split
  // seen from both sides of an edge lands on the same vertex.
  const MAX = 70;
  const MAX_TRIS = 24000;
  const mid = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let m = mid.get(key);
    if (m === undefined) {
      m = pts.length;
      pts.push([(pts[a][0] + pts[b][0]) / 2, (pts[a][1] + pts[b][1]) / 2]);
      mid.set(key, m);
    }
    return m;
  };
  for (let pass = 0; pass < 8 && tris.length / 3 < MAX_TRIS; pass++) {
    const next = [];
    let split = false;
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
      const e = [[a, b, c], [b, c, a], [c, a, b]]
        .map(([q, r, t]) => ({ q, r, t, d: Math.hypot(pts[q][0] - pts[r][0], pts[q][1] - pts[r][1]) }))
        .sort((u, v) => v.d - u.d)[0];
      if (e.d <= MAX) { next.push(a, b, c); continue; }
      const m = midpoint(e.q, e.r);
      next.push(e.q, m, e.t, m, e.r, e.t);
      split = true;
    }
    tris = next;
    if (!split) break;
  }

  const out = [];
  for (let i = 0; i < tris.length; i += 3) {
    out.push([pts[tris[i]], pts[tris[i + 1]], pts[tris[i + 2]]]);
  }
  return out;
}


/** A road as a ribbon of the given width, as flat triangles in (x, z). */
function ribbonTriangles(path, width) {
  if (path.length < 2) return [];
  const hw = width / 2;
  const edge = [];
  for (let i = 0; i < path.length; i++) {
    const [x, z] = path[i];
    const p = path[Math.max(0, i - 1)];
    const q = path[Math.min(path.length - 1, i + 1)];
    let dx = q[0] - p[0];
    let dz = q[1] - p[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    edge.push([[x - dz * hw, z + dx * hw], [x + dz * hw, z - dx * hw]]);
  }
  const out = [];
  for (let i = 1; i < edge.length; i++) {
    const [al, ar] = edge[i - 1];
    const [bl, br] = edge[i];
    out.push([al, bl, ar], [ar, bl, br]);
  }
  return out;
}


/** Clip a convex polygon to a half-plane a*x + b*z + c >= 0. */
function halfPlane(poly, [a, b, c]) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = a * p[0] + b * p[1] + c;
    const dq = a * q[0] + b * q[1] + c;
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}


/**
 * Cut the modelled corridor out of a set of flat triangles.
 *
 * The guarantee this buys is the one that matters: no context surface is ever
 * drawn over the carriageway, so no camera angle and no depth precision can put
 * one there. Whole triangles clear of the box skip the work.
 */
function clipCorridor(tris) {
  const out = [];
  for (const t of tris) {
    const xs = [t[0][0], t[1][0], t[2][0]];
    const zs = [t[0][1], t[1][1], t[2][1]];
    if (Math.min(...xs) >= CORRIDOR_CUT || Math.max(...xs) <= -CORRIDOR_CUT
        || Math.min(...zs) >= SECTION_HALF || Math.max(...zs) <= -SECTION_HALF) {
      out.push(t);
      continue;
    }
    for (const region of OUTSIDE) {
      let poly = t;
      for (const plane of region) {
        poly = halfPlane(poly, plane);
        if (poly.length < 3) break;
      }
      for (let i = 2; i < poly.length; i++) out.push([poly[0], poly[i - 1], poly[i]]);
    }
  }
  return out;
}


/**
 * Flat triangles, clipped clear of the corridor and draped over the terrain.
 *
 * Normals are forced straight up rather than computed, so winding never decides
 * whether a piece of ground is lit from underneath.
 */
function surface(tris, sample, lift) {
  const kept = clipCorridor(tris);
  if (!kept.length) return null;
  const pos = new Float32Array(kept.length * 9);
  const nrm = new Float32Array(kept.length * 9);
  let k = 0;
  for (const t of kept) {
    // Wind anticlockwise seen from above, so the front face is the top one.
    const cross = (t[1][1] - t[0][1]) * (t[2][0] - t[0][0])
                - (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]);
    const v = cross >= 0 ? t : [t[0], t[2], t[1]];
    for (const [x, z] of v) {
      pos[k] = x;
      pos[k + 1] = GROUND_Y + sample(x, z) + lift;
      pos[k + 2] = z;
      nrm[k + 1] = 1;
      k += 3;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return geo;
}


/** Prince of Wales Avenue comes across as bare runs, so give it a width. */
function toAvenue(path) {
  return { path, w: 13.0 };
}

/**
 * OSM names things the way a letterhead does. "Department of Agriculture,
 * Environment and Rural Affairs" is nine times the length of "Rosepark", and
 * on the deck at a readable glyph size that is 300 m of text. The part before
 * the comma is what anyone would say out loud anyway.
 */
function shorten(name) {
  if (name.length <= 28) return name;
  const cut = name.indexOf(',');
  return cut >= 8 ? name.slice(0, cut) : name;
}


/** "Castlehill Road", or "Knock Road A55" where OSM has the number. */
function withRef(j) {
  return j.ref ? `${j.name}  ${j.ref}` : j.name;
}

/**
 * A name on a canvas, laid flat on the deck.
 *
 * The glyph is dark and it is stroked with a pale halo first, so one texture
 * reads against the dark ground and against the light one. That is cheaper
 * than two textures and it means the labels need no theme wiring at all.
 */
function groundLabel(text, scale, maxWidth, renderer, facing = 1) {
  const pad = 30;
  const spacing = 3;
  const font = '600 46px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif';
  const canvas = document.createElement('canvas');
  const probe = canvas.getContext('2d');
  const upper = text.toUpperCase();
  probe.font = font;
  probe.letterSpacing = `${spacing}px`;
  // Measure with the tracking applied, or the last glyph runs off the canvas.
  canvas.width = Math.ceil(probe.measureText(upper).width) + spacing * upper.length + pad * 2;
  canvas.height = 96;

  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.letterSpacing = `${spacing}px`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(240, 244, 250, 0.75)';
  ctx.strokeText(upper, pad, 52);
  ctx.fillStyle = '#0f1620';
  ctx.fillText(upper, pad, 52);

  const tex = new THREE.CanvasTexture(canvas);
  if (renderer) tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  // A long name would otherwise stretch hundreds of metres across the scene.
  // "Department of Agriculture, Environment and Rural Affairs" is a real OSM
  // name and it is nine times the length of "Rosepark".
  const s = Math.min(scale, maxWidth / canvas.width);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(canvas.width * s, canvas.height * s),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.62, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = facing * Math.PI / 2;   // along the corridor, as scene.js does
  mesh.renderOrder = 2;
  return mesh;
}
