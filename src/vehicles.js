/**
 * Vehicle microsimulation.
 *
 * The analytic model in model.js produces the numbers. This produces the
 * picture, and it is driven by the *same* inputs: the same hourly demand, the
 * same number of general-traffic lanes, the same signal cycle and green split.
 * So the queues you see form for the reasons the model says they form, rather
 * than being animated to match.
 *
 * Car following is the Intelligent Driver Model (Treiber, Hennecke & Helbing,
 * 2000). Signals are a fixed-time cycle; a red is treated as a stationary
 * leader on the stop line.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LANES, ROAD_LEN, HALF, JUNCTION_Z } from './scene.js';

const MAX_CARS = 460;
const MAX_BUSES = 16;

// IDM parameters, in metres and seconds.
const IDM = {
  a: 1.5,      // maximum acceleration
  b: 2.2,      // comfortable deceleration
  s0: 2.4,     // minimum bumper-to-bumper gap
  T: 1.25,     // desired time headway
  delta: 4,
};

/**
 * Stop lines, as distance from lane entry, one per signalised junction.
 *
 * A single stop line on 800 m of arterial was why the road never looked like
 * the road: it is the stopping that makes the queue, not the volume. These are
 * the real junctions from JUNCTION_Z, so a car crossing the section meets
 * every set of lights it actually meets.
 */
const STOP_LINES = {
  inbound: JUNCTION_Z.map((z) => HALF - z).filter((s) => s > 20 && s < ROAD_LEN - 20)
    .sort((a, b) => a - b),
  outbound: JUNCTION_Z.map((z) => z + HALF).filter((s) => s > 20 && s < ROAD_LEN - 20)
    .sort((a, b) => a - b),
};
const HALT_S = 250;              // distance from lane entry to the Glider halt
const CAR_LEN = 4.3;
const BUS_LEN = 18;              // Van Hool Exqui.City, 18 m articulated

/** Speed to colour: green running, amber slowing, red stopped. */
const C_FLOW = new THREE.Color(0x1baf7a);
const C_SLOW = new THREE.Color(0xeda100);
const C_STOP = new THREE.Color(0xd03b3b);
const _c = new THREE.Color();

function speedColour(ratio) {
  if (ratio > 0.55) return _c.copy(C_SLOW).lerp(C_FLOW, Math.min(1, (ratio - 0.55) / 0.45));
  return _c.copy(C_STOP).lerp(C_SLOW, Math.max(0, ratio / 0.55));
}

/** A low-poly car: body plus cabin, merged into one geometry. */
function carGeometry() {
  const body = new THREE.BoxGeometry(1.78, 0.72, CAR_LEN);
  body.translate(0, 0.46, 0);
  const cabin = new THREE.BoxGeometry(1.62, 0.62, 2.2);
  cabin.translate(0, 1.1, -0.15);
  return mergeGeometries([body, cabin], false);
}

/** A Glider: two rigid sections and a concertina, merged. */
function busGeometry() {
  const front = new THREE.BoxGeometry(2.5, 2.9, 10.4);
  front.translate(0, 1.75, 3.6);
  const rear = new THREE.BoxGeometry(2.5, 2.9, 6.4);
  rear.translate(0, 1.75, -4.4);
  const joint = new THREE.BoxGeometry(2.2, 2.6, 1.4);
  joint.translate(0, 1.75, -0.9);
  return mergeGeometries([front, rear, joint], false);
}

/** World z for a distance s along a lane. */
function laneZ(lane, s) {
  return lane.dir === 1 ? -HALF + s : HALF - s;
}

export class TrafficSim {
  constructor(group) {
    this.lanes = LANES.map((l) => ({ ...l, vehicles: [], spawnAccumulator: 0, gapSinceSpawn: 999 }));
    this.time = 0;
    this.busLaneActive = true;
    this.cycleTimeSec = 90;
    this.greenFraction = 0.55;
    this.freeFlowMs = 48 / 3.6;
    this.demand = { inbound: 0, outbound: 0 };
    this.busesPerHour = 10;
    this.busDwellSec = 14;
    this.generalLaneIds = new Set();

    // ---- Instanced cars ---------------------------------------------------
    const carGeo = carGeometry();
    this.carMesh = new THREE.InstancedMesh(
      carGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.25 }),
      MAX_CARS
    );
    this.carMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.carMesh.setColorAt(0, new THREE.Color(0xffffff));
    this.carMesh.castShadow = true;
    this.carMesh.frustumCulled = false;
    this.carMesh.count = 0;
    group.add(this.carMesh);

    // Rear lamps, so queues read as a river of red at night.
    const lampGeo = new THREE.PlaneGeometry(1.5, 0.24);
    this.lampMesh = new THREE.InstancedMesh(
      lampGeo,
      new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
      MAX_CARS
    );
    this.lampMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lampMesh.frustumCulled = false;
    this.lampMesh.count = 0;
    group.add(this.lampMesh);

    // ---- Buses ------------------------------------------------------------
    const busGeo = busGeometry();
    this.busMesh = new THREE.InstancedMesh(
      busGeo,
      new THREE.MeshStandardMaterial({ color: 0xd95926, roughness: 0.4, metalness: 0.2 }),
      MAX_BUSES
    );
    this.busMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.busMesh.castShadow = true;
    this.busMesh.frustumCulled = false;
    this.busMesh.count = 0;
    group.add(this.busMesh);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  /**
   * Signal state for one junction on a direction: true when green.
   *
   * Junctions are offset progressively rather than run in lockstep. Perfect
   * co-ordination would clear the road in one wave and hide the queueing;
   * offsetting them is both more honest and what produces the platoons you
   * actually sit in.
   */
  isGreen(direction, junction = 0) {
    const dirOffset = direction === 'inbound' ? 0 : this.cycleTimeSec * 0.5;
    const stagger = junction * this.cycleTimeSec * 0.28;
    const phase = (((this.time + dirOffset + stagger) % this.cycleTimeSec) + this.cycleTimeSec)
      % this.cycleTimeSec / this.cycleTimeSec;
    return phase < this.greenFraction;
  }

  /** The next red stop line ahead of s, or null if the road ahead is clear. */
  nextRedStop(direction, s) {
    const lines = STOP_LINES[direction] || [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] > s && !this.isGreen(direction, i)) return lines[i];
    }
    return null;
  }

  /**
   * Reconfigure from the model. Called whenever the scenario or hour changes.
   * @param {object} o
   * @param {boolean} o.busLaneActive
   * @param {boolean} o.bikeLaneOn
   * @param {{inbound:number,outbound:number}} o.demand  cars per hour, per direction
   */
  configure(o) {
    const { resetDensity = false, ...rest } = o;
    Object.assign(this, rest);

    // Which lanes general traffic may use. Nearside is lost to the bus lane
    // when it is operating; the offside is lost to a protected cycle lane.
    this.generalLaneIds = new Set();
    for (const lane of this.lanes) {
      const lostToBus = lane.nearside && o.busLaneActive;
      const lostToBike = !lane.nearside && o.bikeLaneOn;
      if (!lostToBus && !lostToBike) this.generalLaneIds.add(lane.id);
    }
    // Always leave one general lane per direction, matching the model's clamp.
    for (const direction of ['inbound', 'outbound']) {
      const any = this.lanes.some((l) => l.direction === direction && this.generalLaneIds.has(l.id));
      if (!any) {
        const fallback = this.lanes.find((l) => l.direction === direction && !l.nearside);
        if (fallback) this.generalLaneIds.add(fallback.id);
      }
    }

    const key = [...this.generalLaneIds].sort().join(',') + '|' + this.busLaneActive;
    if (resetDensity || key !== this._layoutKey || !this._seeded) {
      this._layoutKey = key;
      this._seeded = true;
      this.prefill();
    }
  }

  /**
   * Populate every lane at the density the current demand implies, so the
   * road is already busy when the scenario or the hour changes rather than
   * taking a simulated half-hour to fill up.
   */
  prefill() {
    for (const lane of this.lanes) {
      lane.vehicles.length = 0;
      lane.spawnAccumulator = 0;
      lane.busAccumulator = 0;

      const generalInDir = this.lanes.filter(
        (l) => l.direction === lane.direction && this.generalLaneIds.has(l.id)
      ).length;

      if (this.generalLaneIds.has(lane.id)) {
        const q = this.demand[lane.direction] / Math.max(1, generalInDir); // veh/hr
        if (q > 0) {
          const v = this.freeFlowMs * 0.85;
          const spacing = Math.max(CAR_LEN + IDM.s0 + 1.5, (v * 3600) / q);
          for (let s = spacing * Math.random(); s < ROAD_LEN; s += spacing * (0.7 + Math.random() * 0.6)) {
            lane.vehicles.push({
              s, v: v * (0.85 + Math.random() * 0.25), type: 'car', len: CAR_LEN,
              tint: 0.7 + Math.random() * 0.6,
            });
          }
        }
      }

      const carriesBuses = this.busLaneActive
        ? lane.nearside
        : lane.nearside && this.generalLaneIds.has(lane.id);
      if (carriesBuses && this.busesPerHour > 0) {
        const spacing = Math.max(BUS_LEN + 20, (this.freeFlowMs * 3600) / this.busesPerHour);
        for (let s = spacing * Math.random(); s < ROAD_LEN; s += spacing) {
          lane.vehicles.push({
            s, v: this.freeFlowMs * 0.8, type: 'bus', len: BUS_LEN,
            dwellLeft: 0, dwelt: s > HALT_S, tint: 1,
          });
        }
      }

      // Index 0 must be the vehicle furthest along the lane.
      lane.vehicles.sort((a, b) => b.s - a.s);
    }
  }

  totalVehicles() {
    return this.lanes.reduce((n, l) => n + l.vehicles.length, 0);
  }

  /** Poisson-ish arrivals for each general lane, plus scheduled buses. */
  spawn(dt) {
    for (const lane of this.lanes) {
      const isGeneral = this.generalLaneIds.has(lane.id);
      const generalInDir = this.lanes.filter(
        (l) => l.direction === lane.direction && this.generalLaneIds.has(l.id)
      ).length;

      // Cars.
      if (isGeneral && this.totalVehicles() < MAX_CARS - MAX_BUSES) {
        const perLaneHourly = this.demand[lane.direction] / Math.max(1, generalInDir);
        lane.spawnAccumulator += (perLaneHourly / 3600) * dt;
        if (lane.spawnAccumulator >= 1) {
          lane.spawnAccumulator -= 1;
          this.tryInsert(lane, { type: 'car', len: CAR_LEN });
        }
      }

      // Buses run in the bus lane when it is operating, otherwise in the
      // nearside general lane alongside everything else.
      const busLane = this.busLaneActive
        ? lane.nearside
        : lane.nearside && this.generalLaneIds.has(lane.id);
      if (busLane) {
        lane.busAccumulator = (lane.busAccumulator || 0) + (this.busesPerHour / 3600) * dt;
        if (lane.busAccumulator >= 1) {
          lane.busAccumulator -= 1;
          this.tryInsert(lane, { type: 'bus', len: BUS_LEN, dwellLeft: 0, dwelt: false });
        }
      }
    }
  }

  tryInsert(lane, spec) {
    const last = lane.vehicles[lane.vehicles.length - 1];
    const needed = spec.len + IDM.s0 + 2;
    if (last && last.s < needed) return; // no room at the entry
    lane.vehicles.push({
      s: 0,
      v: this.freeFlowMs * (0.75 + Math.random() * 0.2),
      tint: 0.7 + Math.random() * 0.6,
      ...spec,
    });
  }

  step(dt) {
    this.time += dt;
    this.spawn(dt);

    for (const lane of this.lanes) {
      const green = this.isGreen(lane.direction);
      const v0 = this.freeFlowMs * (lane.nearside && this.busLaneActive ? 1.0 : 1.0);

      for (let i = lane.vehicles.length - 1; i >= 0; i--) {
        const veh = lane.vehicles[i];
        const leader = lane.vehicles[i - 1]; // lower index is further along

        // Distance to whatever constrains this vehicle.
        let gap = Infinity;
        let dv = 0;

        if (leader) {
          gap = leader.s - veh.s - leader.len;
          dv = veh.v - leader.v;
        }

        // A red signal is a stationary obstacle on its stop line.
        const stop = this.nextRedStop(lane.direction, veh.s);
        if (stop !== null) {
          const gSig = stop - veh.s - 0.5;
          if (gSig < gap) { gap = gSig; dv = veh.v; }
        }

        // A bus dwelling at the halt is stationary.
        if (veh.type === 'bus' && !veh.dwelt && veh.s < HALT_S) {
          const gHalt = HALT_S - veh.s;
          if (gHalt < gap) { gap = gHalt; dv = veh.v; }
        }

        gap = Math.max(0.4, gap);

        const sStar =
          IDM.s0 + Math.max(0, veh.v * IDM.T + (veh.v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
        const accel =
          IDM.a * (1 - Math.pow(veh.v / v0, IDM.delta) - Math.pow(sStar / gap, 2));

        veh.v = Math.max(0, veh.v + THREE.MathUtils.clamp(accel, -8, IDM.a) * dt);

        // Dwell at the halt.
        if (veh.type === 'bus' && !veh.dwelt && veh.s >= HALT_S - 1.2) {
          veh.dwellLeft = veh.dwellLeft || this.busDwellSec;
          veh.v = 0;
          veh.dwellLeft -= dt;
          if (veh.dwellLeft <= 0) veh.dwelt = true;
        }

        veh.s += veh.v * dt;

        if (veh.s > ROAD_LEN) lane.vehicles.splice(i, 1);
      }
    }
  }

  /** Push simulation state into the instanced meshes. */
  render(nightFactor) {
    let ci = 0;
    let bi = 0;
    let li = 0;
    let stopped = 0;
    let total = 0;
    let speedSum = 0;

    for (const lane of this.lanes) {
      const yaw = lane.dir === 1 ? 0 : Math.PI;
      this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

      for (const veh of lane.vehicles) {
        const z = laneZ(lane, veh.s);
        const ratio = veh.v / this.freeFlowMs;
        total++;
        speedSum += veh.v;
        if (veh.v < 1.2) stopped++;

        if (veh.type === 'bus') {
          if (bi >= MAX_BUSES) continue;
          this._v.set(lane.x, 0, z);
          this._m.compose(this._v, this._q, this._s);
          this.busMesh.setMatrixAt(bi, this._m);
          bi++;
        } else {
          if (ci >= MAX_CARS) continue;
          this._v.set(lane.x, 0, z);
          this._m.compose(this._v, this._q, this._s);
          this.carMesh.setMatrixAt(ci, this._m);
          const col = speedColour(ratio).clone().multiplyScalar(veh.tint);
          this.carMesh.setColorAt(ci, col);
          ci++;

          // Rear lamp, brighter when braking or stationary.
          if (li < MAX_CARS) {
            const rearZ = z - lane.dir * (CAR_LEN / 2 + 0.02);
            this._v.set(lane.x, 0.55, rearZ);
            const scale = 0.35 + (1 - Math.min(1, ratio)) * 0.9;
            this._s.set(scale, scale, scale);
            this._m.compose(this._v, this._q, this._s);
            this.lampMesh.setMatrixAt(li, this._m);
            this._s.set(1, 1, 1);
            li++;
          }
        }
      }
    }

    this.carMesh.count = ci;
    this.busMesh.count = bi;
    this.lampMesh.count = li;
    this.carMesh.instanceMatrix.needsUpdate = true;
    this.busMesh.instanceMatrix.needsUpdate = true;
    this.lampMesh.instanceMatrix.needsUpdate = true;
    if (this.carMesh.instanceColor) this.carMesh.instanceColor.needsUpdate = true;
    this.lampMesh.material.opacity = 0.35 + nightFactor * 0.6;

    return {
      onRoad: total,
      stopped,
      avgSpeedKph: total ? (speedSum / total) * 3.6 : 0,
    };
  }
}
