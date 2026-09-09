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
import { LANES, LANE_W, ROAD_LEN, HALF, JUNCTION_Z, mulberry32 } from './scene.js';

const MAX_CARS = 460;
const MAX_BUSES = 16;
const MAX_BIKES = 120;

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
export const STOP_LINES = {
  inbound: JUNCTION_Z.map((z) => HALF - z).filter((s) => s > 20 && s < ROAD_LEN - 20)
    .sort((a, b) => a - b),
  outbound: JUNCTION_Z.map((z) => z + HALF).filter((s) => s > 20 && s < ROAD_LEN - 20)
    .sort((a, b) => a - b),
};
const HALT_S = 250;              // distance from lane entry to the Glider halt
const CAR_LEN = 4.3;
const BUS_LEN = 18;              // Van Hool Exqui.City, 18 m articulated
const CYCLE_LEN = 1.8;
const MOTO_LEN = 2.1;

/**
 * Pedal cycles and motorcycles are legal in a Northern Ireland bus lane, and
 * on this road that is not a detail. A cycle doing 7 m/s in front of a Glider
 * doing 13 is an obstruction the bus has to leave the lane to get past, and
 * while it is out it is in the way of the traffic the bus lane was supposed to
 * be keeping moving. Nothing in the model saw that.
 *
 * The rates are assumptions. Count points 918 and 921 are motor vehicle counts
 * and break out neither class, and there is no published cycle count on this
 * section. They are set to what they need to show: cycles common enough to
 * obstruct a bus a few times an hour, and motorcycles present but almost never
 * an obstruction, because they are quicker than the bus. The motorcycle rate
 * is at the top of the plausible range so the class is visible in the picture,
 * which costs nothing, because a motorcycle never makes a bus pull out.
 */
const CYCLES_PER_HOUR = 55;      // per direction, at the weekday peak
const MOTOS_PER_HOUR = 24;       // about 2% of the peak motor flow
const CYCLE_MS = 7.0;            // ~25 km/h, a commuting pace
const MOTO_FACTOR = 1.06;        // a shade above the general traffic speed

/** How close a bus gets to a cycle before it pulls out, and the gap it needs. */
const OVERTAKE_TRIGGER = 26;
const OVERTAKE_LEAD = 42;        // clear road wanted ahead in the general lane
const OVERTAKE_MIN_LEAD = 7;     // what a driver will settle for once fed up
const OVERTAKE_TAIL = 8;         // and behind, so it does not cut anyone up
const PATIENCE_MS = 3;           // metres of lead given up per second held
const LATERAL_MS = 1.6;          // how fast it moves across

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

/**
 * A pedal cycle: frame, wheels and an upright rider.
 *
 * Read at a glance is the whole job here. It is a third the width of a car and
 * the rider stands well above a car roof, so the shape carries even when the
 * colour does not.
 */
function cycleGeometry() {
  const frame = new THREE.BoxGeometry(0.16, 0.34, 1.5);
  frame.translate(0, 0.62, 0);
  const wheels = [0.62, -0.62].map((z) => {
    const w = new THREE.CylinderGeometry(0.34, 0.34, 0.06, 10);
    w.rotateZ(Math.PI / 2);
    w.translate(0, 0.34, z);
    return w;
  });
  const torso = new THREE.BoxGeometry(0.44, 0.7, 0.34);
  torso.translate(0, 1.28, -0.12);
  const head = new THREE.BoxGeometry(0.3, 0.3, 0.3);
  head.translate(0, 1.75, 0.02);
  return mergeGeometries([frame, ...wheels, torso, head], false);
}

/** A motorcycle: lower, longer, and with a rider tucked in. */
function motoGeometry() {
  const body = new THREE.BoxGeometry(0.42, 0.44, MOTO_LEN);
  body.translate(0, 0.62, 0);
  const wheels = [0.82, -0.82].map((z) => {
    const w = new THREE.CylinderGeometry(0.32, 0.32, 0.14, 10);
    w.rotateZ(Math.PI / 2);
    w.translate(0, 0.32, z);
    return w;
  });
  const rider = new THREE.BoxGeometry(0.5, 0.72, 0.5);
  rider.translate(0, 1.24, -0.24);
  const screen = new THREE.BoxGeometry(0.44, 0.36, 0.1);
  screen.translate(0, 1.16, 0.86);
  return mergeGeometries([body, ...wheels, rider, screen], false);
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
    // Seeded, and every draw in here comes off it. The same hour and scenario
    // put the same cycle in front of the same bus on every reload, which they
    // did not before: a picture that changes when you press reload cannot
    // corroborate anything.
    this.rand = mulberry32(0x4b455242);
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

    // ---- Cycles and motorcycles -------------------------------------------
    // Both are legal in the bus lane and both are drawn to be told apart at a
    // glance: cyan for the cycle, violet for the motorcycle. Neither colour is
    // on the cars' green-amber-red speed ramp or near the Glider's orange, so
    // nothing here can be misread as a congestion signal.
    this.cycleMesh = new THREE.InstancedMesh(
      cycleGeometry(),
      new THREE.MeshStandardMaterial({ color: 0x2ad4ff, roughness: 0.5, metalness: 0.1 }),
      MAX_BIKES
    );
    this.motoMesh = new THREE.InstancedMesh(
      motoGeometry(),
      new THREE.MeshStandardMaterial({ color: 0x9b5cff, roughness: 0.45, metalness: 0.25 }),
      MAX_BIKES
    );
    for (const m of [this.cycleMesh, this.motoMesh]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      group.add(m);
    }

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
          for (let s = spacing * this.rand(); s < ROAD_LEN; s += spacing * (0.7 + this.rand() * 0.6)) {
            lane.vehicles.push({
              s, v: v * (0.85 + this.rand() * 0.25), type: 'car', len: CAR_LEN,
              tint: 0.7 + this.rand() * 0.6,
            });
          }
        }
      }

      const carriesBuses = this.busLaneActive
        ? lane.nearside
        : lane.nearside && this.generalLaneIds.has(lane.id);
      if (carriesBuses && this.busesPerHour > 0) {
        const spacing = Math.max(BUS_LEN + 20, (this.freeFlowMs * 3600) / this.busesPerHour);
        for (let s = spacing * this.rand(); s < ROAD_LEN; s += spacing) {
          lane.vehicles.push({
            s, v: this.freeFlowMs * 0.8, type: 'bus', len: BUS_LEN,
            dwellLeft: 0, dwelt: s > HALT_S, tint: 1,
          });
        }
      }

      // Cycles and motorcycles are legal in the bus lane, so they are in it.
      if (this.busLaneActive && lane.nearside) {
        for (const type of ['cycle', 'moto']) {
          const perHour = this.bikeFlow(lane.direction, type);
          if (perHour <= 0) continue;
          const v = this.desiredSpeed(type);
          const len = type === 'cycle' ? CYCLE_LEN : MOTO_LEN;
          const spacing = Math.max(len + 14, (v * 3600) / perHour);
          for (let s = spacing * this.rand(); s < ROAD_LEN; s += spacing) {
            lane.vehicles.push({ s, v, type, len, tint: 1 });
          }
        }
      }

      // Index 0 must be the vehicle furthest along the lane.
      lane.vehicles.sort((a, b) => b.s - a.s);
    }
  }

  totalVehicles() {
    return this.lanes.reduce((n, l) => n + l.vehicles.length, 0);
  }

  /** Desired speed by type, in m/s. A cycle's is nothing like a car's. */
  desiredSpeed(type) {
    if (type === 'cycle') return CYCLE_MS;
    if (type === 'moto') return this.freeFlowMs * MOTO_FACTOR;
    return this.freeFlowMs;
  }

  /**
   * Cycle and motorcycle flow for one direction, per hour.
   *
   * Scaled off the car demand for the hour rather than held flat, because the
   * road is not full of commuting cyclists at three in the morning. The 1,100
   * is the rough weekday peak hourly flow at these count points, so the base
   * rates above read as peak-hour figures.
   */
  bikeFlow(direction, type) {
    const base = type === 'cycle' ? CYCLES_PER_HOUR : MOTOS_PER_HOUR;
    return base * Math.min(1.2, (this.demand[direction] || 0) / 1100);
  }

  /** The general lane a bus from this lane pulls out into, or null. */
  overtakeLane(lane) {
    return this.lanes.find((l) => l.direction === lane.direction && !l.nearside) || null;
  }

  /** Nothing in the general lane alongside, so there is room to pull out. */
  laneClear(lane, s, lead) {
    for (const v of lane.vehicles) {
      if (v.s > s - OVERTAKE_TAIL - v.len && v.s < s + lead) return false;
    }
    return true;
  }

  /** A cycle the bus is still alongside, or about to be. */
  cycleNear(lane, veh) {
    for (const v of lane.vehicles) {
      if (v.type !== 'cycle') continue;
      if (v.s > veh.s - BUS_LEN - 4 && v.s < veh.s + OVERTAKE_TRIGGER) return true;
    }
    return false;
  }

  /**
   * Decide whether a bus is out in the general lane, and move it across.
   *
   * A Glider runs at 13 m/s and a commuting cyclist at 7. A 3.2 m lane has no
   * room to pass inside it, so the bus takes the general lane, and for as long
   * as it is out there the traffic behind it is the bus lane's cost to general
   * traffic. The analytic model does not have this either, so treat what the
   * picture shows here as the microsimulation's own point.
   */
  updateOvertake(lane, veh, i, dt) {
    const target = this.busLaneActive && lane.nearside ? this.overtakeLane(lane) : null;

    if (!veh.overtaking) {
      const ahead = lane.vehicles[i - 1];
      const held = target && ahead && ahead.type === 'cycle'
        && ahead.s - veh.s - ahead.len < OVERTAKE_TRIGGER
        // Against the speed it wants, not the speed it is doing. By the time a
        // bus has closed on a cycle the car-following model has already pulled
        // it down to the cycle's pace, so comparing current speeds says the
        // bus is happy where it is and it never pulls out.
        && this.desiredSpeed('bus') > ahead.v + 1.5
        // Not on the run in to the halt. It would only have to come back.
        && (veh.dwelt || veh.s < HALT_S - 30);
      // A driver held behind a cyclist takes a smaller gap the longer he sits
      // there. Signals platoon the general lane down to gaps of about 25 m, so
      // holding out for the gap he would ideally like means the bus never gets
      // out at all, which is the opposite of what this road does. At the far
      // end of his patience he takes a gap that makes the car behind brake,
      // and that braking is the cost this whole thing exists to show.
      veh.heldFor = held ? (veh.heldFor || 0) + dt : 0;
      const lead = Math.max(OVERTAKE_MIN_LEAD, OVERTAKE_LEAD - veh.heldFor * PATIENCE_MS);
      if (held && this.laneClear(target, veh.s, lead)) veh.overtaking = true;
    } else if (!target || !this.cycleNear(lane, veh)) {
      veh.overtaking = false;
    }

    const want = veh.overtaking ? -Math.sign(lane.x) * LANE_W : 0;
    const now = veh.off || 0;
    veh.off = now + THREE.MathUtils.clamp(want - now, -LATERAL_MS * dt, LATERAL_MS * dt);
  }

  /** Poisson-ish arrivals for each general lane, plus scheduled buses. */
  spawn(dt) {
    // Bikes have their own budget. Counting them against the car cap would let
    // a busy bus lane quietly starve the general lanes of traffic.
    let bikes = 0;
    let motors = 0;
    for (const lane of this.lanes) {
      for (const v of lane.vehicles) {
        if (v.type === 'cycle' || v.type === 'moto') bikes++;
        else motors++;
      }
    }

    for (const lane of this.lanes) {
      const isGeneral = this.generalLaneIds.has(lane.id);
      const generalInDir = this.lanes.filter(
        (l) => l.direction === lane.direction && this.generalLaneIds.has(l.id)
      ).length;

      // Cars.
      if (isGeneral && motors < MAX_CARS - MAX_BUSES) {
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

      // Cycles and motorcycles, but only into an operating bus lane. With the
      // lane switched off they are mixed in with general traffic, where they
      // hold nobody up in particular and are not the question being asked.
      if (this.busLaneActive && lane.nearside && bikes < MAX_BIKES) {
        for (const type of ['cycle', 'moto']) {
          const key = `${type}Accumulator`;
          lane[key] = (lane[key] || 0) + (this.bikeFlow(lane.direction, type) / 3600) * dt;
          if (lane[key] >= 1) {
            lane[key] -= 1;
            this.tryInsert(lane, {
              type, len: type === 'cycle' ? CYCLE_LEN : MOTO_LEN,
            });
          }
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
      v: this.desiredSpeed(spec.type) * (0.75 + this.rand() * 0.2),
      tint: 0.7 + this.rand() * 0.6,
      ...spec,
    });
  }

  step(dt) {
    this.time += dt;
    this.spawn(dt);

    // Buses that have pulled out are obstacles in the general lane, and that
    // is the whole point of modelling this. The cycle does not slow general
    // traffic. The bus getting past it does.
    const intruders = new Map();
    for (const lane of this.lanes) {
      if (!lane.nearside) continue;
      const target = this.overtakeLane(lane);
      if (!target) continue;
      for (const veh of lane.vehicles) {
        if (veh.type !== 'bus' || Math.abs(veh.off || 0) < 1) continue;
        if (!intruders.has(target.id)) intruders.set(target.id, []);
        intruders.get(target.id).push(veh);
      }
    }

    for (const lane of this.lanes) {
      const foreign = intruders.get(lane.id);

      for (let i = lane.vehicles.length - 1; i >= 0; i--) {
        const veh = lane.vehicles[i];
        const v0 = this.desiredSpeed(veh.type);
        if (veh.type === 'bus') this.updateOvertake(lane, veh, i, dt);

        // Distance to whatever constrains this vehicle.
        let gap = Infinity;
        let dv = 0;

        // The nearest thing ahead that is still in this lane. A bus out in the
        // next lane stops being a leader, and stops having one.
        let leader = null;
        for (let j = i - 1; j >= 0; j--) {
          const cand = lane.vehicles[j];
          if (Math.abs(cand.off || 0) > 1.5) continue;
          if (veh.overtaking && cand.type === 'cycle') continue;
          leader = cand;
          break;
        }
        if (leader) {
          gap = leader.s - veh.s - leader.len;
          dv = veh.v - leader.v;
        }

        // A bus out of its lane follows the general traffic it has joined.
        if (veh.overtaking) {
          const target = this.overtakeLane(lane);
          for (const other of (target ? target.vehicles : [])) {
            const g = other.s - veh.s - other.len;
            if (g > -0.5 && g < gap) { gap = g; dv = veh.v - other.v; }
          }
        }

        // And general traffic has to see it, which is the cost.
        if (foreign) {
          for (const bus of foreign) {
            const g = bus.s - veh.s - BUS_LEN;
            if (g > -0.5 && g < gap) { gap = g; dv = veh.v - bus.v; }
          }
        }

        // A red signal is a stationary obstacle on its stop line.
        const stop = this.nextRedStop(lane.direction, veh.s);
        if (stop !== null) {
          const gSig = stop - veh.s - 0.5;
          if (gSig < gap) { gap = gSig; dv = veh.v; }
        }

        // A bus dwelling at the halt is stationary. It does not dwell while it
        // is out in the general lane; it is not at the kerb.
        if (veh.type === 'bus' && !veh.dwelt && !veh.overtaking && veh.s < HALT_S) {
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
        //
        // The trigger has to allow for the minimum gap. Treating the halt as a
        // stationary obstacle parks the bus one s0 short of the mark and the
        // car-following model will not close that last 2.4 m, so a trigger on
        // the mark itself never fires and the bus sits there for good. That
        // deadlock was in here before cycles were; cycles queueing behind the
        // frozen bus are what made it obvious.
        if (veh.type === 'bus' && !veh.dwelt && !veh.overtaking
            && veh.s >= HALT_S - IDM.s0 - 1.2) {
          veh.dwellLeft = veh.dwellLeft || this.busDwellSec;
          veh.v = 0;
          veh.dwellLeft -= dt;
          if (veh.dwellLeft <= 0) veh.dwelt = true;
        }

        veh.s += veh.v * dt;

        if (veh.s > ROAD_LEN) lane.vehicles.splice(i, 1);
      }

      // Overtaking reorders the lane, so the leader chain has to be rebuilt or
      // the bus spends the rest of its run braking for something behind it.
      lane.vehicles.sort((a, b) => b.s - a.s);
    }
  }

  /** Push simulation state into the instanced meshes. */
  render(nightFactor) {
    let ci = 0;
    let bi = 0;
    let li = 0;
    let yi = 0;
    let mi = 0;
    let stopped = 0;
    let total = 0;
    let speedSum = 0;

    for (const lane of this.lanes) {
      const yaw = lane.dir === 1 ? 0 : Math.PI;
      this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

      for (const veh of lane.vehicles) {
        const z = laneZ(lane, veh.s);
        const ratio = veh.v / this.freeFlowMs;
        // Bikes stay out of the traffic statistics. A cyclist at 25 km/h is
        // not congestion, and averaging one in would report the corridor as
        // slower than it is running.
        if (veh.type !== 'cycle' && veh.type !== 'moto') {
          total++;
          speedSum += veh.v;
          if (veh.v < 1.2) stopped++;
        }

        if (veh.type === 'cycle' || veh.type === 'moto') {
          const cycle = veh.type === 'cycle';
          if (cycle ? yi >= MAX_BIKES : mi >= MAX_BIKES) continue;
          // Nearer the kerb than the lane centre, which is where they ride and
          // why a bus cannot squeeze past inside the lane.
          this._v.set(lane.x + Math.sign(lane.x) * 0.75, 0, z);
          this._m.compose(this._v, this._q, this._s);
          if (cycle) this.cycleMesh.setMatrixAt(yi++, this._m);
          else this.motoMesh.setMatrixAt(mi++, this._m);
          continue;
        }

        if (veh.type === 'bus') {
          if (bi >= MAX_BUSES) continue;
          this._v.set(lane.x + (veh.off || 0), 0, z);
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
    this.cycleMesh.count = yi;
    this.motoMesh.count = mi;
    this.carMesh.instanceMatrix.needsUpdate = true;
    this.busMesh.instanceMatrix.needsUpdate = true;
    this.lampMesh.instanceMatrix.needsUpdate = true;
    this.cycleMesh.instanceMatrix.needsUpdate = true;
    this.motoMesh.instanceMatrix.needsUpdate = true;
    if (this.carMesh.instanceColor) this.carMesh.instanceColor.needsUpdate = true;
    this.lampMesh.material.opacity = 0.35 + nightFactor * 0.6;

    return {
      onRoad: total,
      stopped,
      avgSpeedKph: total ? (speedSum / total) * 3.6 : 0,
    };
  }
}
