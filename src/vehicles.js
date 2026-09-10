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
import { LANES, LANE_W, ROAD_LEN, HALF, KERB_X, SIGNAL_Z, JUNCTIONS, mulberry32 } from './scene.js';

// Raised from 460 to carry the side-road queues as well as the corridor. A
// side road that cannot get out is the point, so it must not be the thing
// that runs out of instances.
const MAX_CARS = 540;
const MAX_INDICATORS = 128;
const MAX_BUSES = 16;
const MAX_BIKES = 120;

/**
 * IDM parameters, in metres and seconds.
 *
 * Acceleration was 1.5 m/s2, which is gentle for a car pulling away from a
 * stop line and it had a consequence. Startup was so slow that a saturated
 * green discharged at about 1,240 pcu/hr/lane against the 1,800 the analytic
 * model assumes, so the microsimulation's capacity was a third below the
 * model's and the corridor filled up at hours the model says it copes with.
 * At 2.0, a normal comfortable urban figure, the two halves agree: 08:00
 * carries 750 veh/hr inbound against a demand of 749, 17:00 carries 812
 * outbound against 798.
 */
const IDM = {
  a: 2.0,      // maximum acceleration
  b: 2.2,      // comfortable deceleration
  s0: 2.4,     // minimum bumper-to-bumper gap
  T: 1.25,     // desired time headway
  delta: 4,
};

/**
 * Stop lines, as distance from lane entry, one per signalised approach.
 *
 * These come from SIGNAL_Z, which is the OSM traffic_signals nodes, and NOT
 * from the junction list. On this section the two are nothing like the same.
 * Every junction inside the drawn 800 m is priority-controlled, and deriving
 * the stop lines from them stopped corridor traffic at three residential
 * T-junctions that have give way painted across their mouths. The picture
 * showed the marking and the simulation drove through it, which is the one
 * disagreement between the two halves nobody local would miss.
 *
 * What is left is the two real installations: the Stormont Estate accesses
 * around z = -47 and the pedestrian crossing around z = +77. Both are still
 * inside the section and near the middle of it, so the queueing they cause is
 * still the queueing you watch form. It is simply now caused by the signals
 * the road has rather than by three it does not.
 */
export const STOP_LINES = {
  inbound: SIGNAL_Z.inbound.map((z) => HALF - z).filter((s) => s > 20 && s < ROAD_LEN - 20)
    .sort((a, b) => a - b),
  outbound: SIGNAL_Z.outbound.map((z) => z + HALF).filter((s) => s > 20 && s < ROAD_LEN - 20)
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

/**
 * TURNING MOVEMENTS.
 *
 * Every vehicle used to run the full 800 m, which is not what the road does.
 * Cars leave it at Rosepark, Rosemount Avenue and Summerhill Avenue, and cars
 * come out of all three, and the car sitting in the offside lane waiting for
 * a gap to turn right is one of the larger sources of delay on an urban
 * arterial. None of that was in the picture.
 *
 * THE RATES ARE ASSUMPTIONS, AND THEY ARE NOT IN THE DATA.
 *
 * DfI count points 918 and 921 are mainline motor-vehicle counts. They count
 * what passes the point. They do not break out turning movements, and no
 * turning count is published for these three junctions, so the shares below
 * are chosen, not measured.
 *
 * What the counts DO constrain is the net. CP921 (inbound, at the Stormont
 * entrance) and CP918 (outbound, opposite Summerhill Avenue) sit at opposite
 * ends of the modelled section and report 2023 AADTs of roughly 13,380 and
 * 13,350. Those are the same number to within a quarter of one per cent. So
 * whatever leaves the corridor between the two points is matched, near enough
 * exactly, by what joins it. The counts say nothing about how much turns; they
 * say the exchange is balanced. This model is built on that: the rate at which
 * vehicles are generated out of each side road equals the rate at which
 * vehicles turn into it, per direction, per junction. Mainline flow past every
 * point therefore stays at the demand the analytic model was given, and the
 * picture still reconciles with the counts.
 *
 * The levels: 5% of the direction's flow leaving at each junction for the
 * easy left, 2% for the right. Three junctions, so about 15% of inbound flow
 * exchanges across the section and about 6% of outbound. At the 08:00 flow of
 * roughly 750 veh/hr that is around 37 vehicles an hour into each street,
 * well under one a minute, and it is the right order of magnitude for a
 * residential street of this size: these arms serve tens of houses, not
 * hundreds, and residential streets generate tens of trips in a peak hour,
 * not hundreds.
 *
 * The right share is lower for two reasons. Turning right across a queueing
 * arterial is a movement drivers avoid, re-routing to a junction where they
 * can turn left instead. And measurement: at 3% the single outbound running
 * lane does not recover. See the note on rightTurnShare in model.js. Both are
 * editable in the UI, and pushing the right one is the quickest way to show
 * what a right-turn pocket would be worth.
 */
const TURN_SIDE_STREETS = JUNCTIONS.filter((j) => j.leg && j.leg.length >= 2);

/**
 * Critical gaps, in seconds. Also assumptions.
 *
 * Conventional UK priority-junction practice puts the critical gap somewhere
 * around four seconds for a left turn out of a minor arm and six to seven for
 * a movement that has to cross the major road. No gap-acceptance survey exists
 * for these junctions, so these are the conventional values, not local ones.
 */
const CRIT_MERGE_LEFT = 4.0;     // out of the side road, joining the near stream
const CRIT_MERGE_RIGHT = 6.0;    // out of the side road, crossing to the far stream
const CRIT_TURN_LEFT = 2.5;      // off the corridor, crossing an operating bus lane
const CRIT_TURN_RIGHT = 5.0;     // off the corridor, across oncoming traffic

/**
 * How the gap a driver will accept shrinks while he waits.
 *
 * Those figures are for free-flowing opposing traffic. Held to them under
 * congestion a right turner never goes at all, because the gap he is waiting
 * for does not exist on a corridor running near capacity, and he blocks the
 * only running lane for the whole peak. That is not what the road does. The
 * longer a driver sits there the smaller the gap he takes, and the oncoming
 * driver in a queue waves him across. Same mechanism as the bus running out
 * of patience behind a cyclist, and for the same reason: holding out for the
 * ideal gap produces a picture the road does not produce.
 */
const GAP_PATIENCE = 0.35;       // seconds off the critical gap per second held
const CRIT_FLOOR = 2.0;          // and the smallest gap anyone will take

/** The gap this driver will accept, given how long he has been waiting. */
function acceptedGap(base, heldFor) {
  return Math.max(CRIT_FLOOR, base - (heldFor || 0) * GAP_PATIENCE);
}

/**
 * Half the length of carriageway a crossing vehicle occupies, in metres, and
 * the speed below which a corridor vehicle is treated as not arriving.
 *
 * Stationary traffic outside that band does not block a turn. That is a
 * deliberate assumption and it matters: the Highway Code asks drivers in
 * slow-moving traffic to leave side road entrances clear, and without it a
 * queueing corridor would seal every side road shut for the whole peak, which
 * is not what the road does. Moving traffic blocks on time-to-arrival, which
 * is the mechanism that makes a green platoon the thing you wait for.
 */
const CONFLICT_HALF = 2.5;
const MERGE_CLEAR_HALF = 6.0;    // room wanted either side, in the lane being joined
const CREEP_MS = 1.0;

/**
 * The keep-clear box at each side road mouth.
 *
 * Without this nothing ever gets out, and that is not a tuning problem, it is
 * a missing behaviour. In slow-moving traffic a driver holds back rather than
 * stopping across a side road, which is what the Highway Code asks for and
 * what this road does. Modelled here rather than papered over in the gap
 * tests, because it is the mechanism: the mouth is kept clear, so there is
 * something to turn into, and the box is visible in the queue as a gap.
 *
 * It only bites when the traffic ahead is stopped or crawling. A moving
 * platoon crossing a mouth is nobody's problem.
 */
const MOUTH_KEEP_BACK = 4.0;     // held this far short of the junction
const MOUTH_KEEP_FWD = 12.0;     // and this much of the far side left free
const MOUTH_KEEP_SLOW = 3.0;     // leader speed below which a driver holds back
const MOUTH_KEEP_RANGE = 45;     // how far out the rule is considered

const DECIDE_AHEAD = 70;         // where a driver commits to the turn
const COMMIT_AHEAD = 32;         // where the gap search starts
const TURN_SPEED = 4.0;          // approach speed of a turning vehicle, m/s
const TURN_SWEEP_MS = 3.6;       // how fast it crosses out of the lane
const TURN_CLEAR_X = 1.6;        // metres past the kerb line before it is gone
const TURN_SWEEP_FROM = 12;      // distance short of the stop line the swing starts

const MERGE_STOP = 7.0;          // give-way line, metres out from the corridor kerb
const MERGE_SLOT = CAR_LEN + 2.6;
const MERGE_QUEUE_MAX = 12;
const MERGE_CREEP_MS = 7.0;      // how fast a side-road car closes on the queue
const MERGE_ENTRY_MS = 3.0;      // speed it joins the corridor at
const MERGE_ENTRY_AHEAD = 5.5;   // it ends up this far downstream of the mouth

/** Vehicles that may wait off the top of the section to get in. */
const ENTRY_QUEUE_MAX = 25;

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

/**
 * A side street's centreline as a measured path, distance zero at the
 * corridor kerb and running outwards.
 *
 * The same polyline the street is drawn from, so a car queueing to get out is
 * on the road you can see rather than on the pavement beside it. These arms
 * bend hard within thirty metres of the corridor, so a straight queue would
 * be through the front gardens.
 */
function legPath(leg) {
  const cum = [0];
  for (let i = 1; i < leg.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(leg[i][0] - leg[i - 1][0], leg[i][1] - leg[i - 1][1]));
  }
  return { pts: leg, cum, len: cum[cum.length - 1] };
}

/** Position and outward unit heading at distance d along a leg. */
function legPoint(path, d) {
  const { pts, cum } = path;
  const t = Math.min(Math.max(d, 0), cum[cum.length - 1]);
  let i = 1;
  while (i < cum.length - 1 && cum[i] < t) i++;
  const span = Math.max(1e-6, cum[i] - cum[i - 1]);
  const f = (t - cum[i - 1]) / span;
  const ax = pts[i - 1][0], az = pts[i - 1][1];
  const bx = pts[i][0], bz = pts[i][1];
  const hx = (bx - ax) / span;
  const hz = (bz - az) / span;
  return { x: ax + (bx - ax) * f, z: az + (bz - az) * f, hx, hz };
}

/**
 * A direction indicator: a small amber block at a vehicle corner.
 *
 * Colour is already carrying speed on the cars, green through amber to red,
 * so a turning vehicle cannot be signalled by recolouring it. A separate
 * blinking lamp reads from the demo camera and cannot be confused with the
 * congestion ramp, and it is what the real thing does.
 */
function indicatorGeometry() {
  return new THREE.BoxGeometry(0.46, 0.3, 0.46);
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

    // Turning shares, per junction, per direction. See the note above the
    // constants: assumptions, editable, and balanced so the mainline flow
    // still reconciles with the counts.
    this.leftTurnShare = 0.05;
    this.rightTurnShare = 0.03;

    // One give-way arm per side street, with its own FIFO queue. Both the
    // left-out and the right-out share it, because they share the road: a car
    // at the front waiting to turn right holds up the car behind it that only
    // wanted to turn left, which is exactly what these junctions do.
    this.arms = TURN_SIDE_STREETS.map((st) => ({
      name: st.name,
      z: st.z,
      side: st.side,
      path: legPath(st.leg),
      queue: [],
      // What the arm owes the corridor back. See stepArms.
      owed: { inbound: 0, outbound: 0 },
    }));
    this.turnPoints = { inbound: [], outbound: [] };
    this.resetStats();

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

    // ---- Turn indicators ---------------------------------------------------
    this.indicatorMesh = new THREE.InstancedMesh(
      indicatorGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xffae00 }),
      MAX_INDICATORS
    );
    this.indicatorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.indicatorMesh.frustumCulled = false;
    this.indicatorMesh.count = 0;
    group.add(this.indicatorMesh);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  /**
   * Signal state for one junction on a direction: true when green.
   *
   * Junctions are offset by the time it takes to drive to them from the
   * section entry, so a platoon released at one stop line reaches the next
   * one as it turns green. That is what a co-ordinated urban arterial does,
   * and on this corridor it is not cosmetic.
   *
   * It replaced a flat stagger of 0.28 of a cycle between adjacent stop
   * lines, which back when there were four of them left closely spaced pairs
   * discharging into a box that was already full: throughput fell to 560
   * veh/hr against a demand of 749 and the corridor filled until it stopped.
   * The two installations left are 124 m apart, far enough that the stagger
   * matters less, but progression is still what a co-ordinated arterial does
   * and it is still the honest default.
   *
   * The two directions still run on independent phases at the same junction,
   * which a real controller would not do, so both get a clean wave. On a real
   * two-way street only one direction can.
   */
  isGreen(direction, junction = 0) {
    const dirOffset = direction === 'inbound' ? 0 : this.cycleTimeSec * 0.5;
    const lines = STOP_LINES[direction] || [];
    const stagger = -(lines[junction] || 0) / Math.max(1, this.freeFlowMs);
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

  /** Counters for the turning behaviour, so it can be measured not eyeballed. */
  resetStats() {
    this.stats = {
      simSeconds: 0,
      turnsOffLeft: 0,
      turnsOffRight: 0,
      mergesInbound: 0,
      mergesOutbound: 0,
      rightWaitSeconds: 0,    // time right-turners spend held for a gap
      blockedSeconds: 0,      // vehicle-seconds of traffic stopped behind one
      mergeWaitSeconds: 0,    // time side-road vehicles spend at the give-way line
    };
  }

  /** Everything above, per simulated hour. */
  turnRates() {
    const h = Math.max(1e-9, this.stats.simSeconds) / 3600;
    const out = { simHours: this.stats.simSeconds / 3600 };
    for (const [k, v] of Object.entries(this.stats)) {
      if (k !== 'simSeconds') out[k] = v / h;
    }
    // Gauges, not rates: what is sitting on the side roads right now.
    out.queued = this.arms.reduce((n, a) => n + a.queue.length, 0);
    out.owed = this.arms.reduce(
      (n, a) => n + a.owed.inbound + a.owed.outbound, 0
    );
    return out;
  }

  /** Distance from lane entry at which a direction meets world z. */
  junctionS(direction, z) {
    return direction === 'inbound' ? HALF - z : z + HALF;
  }

  /**
   * The lane a driver turning towards `side` turns from: the general lane
   * furthest over that way.
   *
   * With the bus lane operating there is one general lane each way, so an
   * inbound left turn is made across the bus lane and an outbound right turn
   * from the lane next to the centre line. Both are what happens on the
   * ground, and neither needed a special case.
   */
  turnLaneFor(direction, side) {
    let best = null;
    for (const l of this.lanes) {
      if (l.direction !== direction || !this.generalLaneIds.has(l.id)) continue;
      if (!best || side * l.x > side * best.x) best = l;
    }
    return best;
  }

  /** Lanes lying between a lane and the kerb on `side`, which must be crossed. */
  crossedLanes(from, side) {
    return this.lanes.filter((l) => side * l.x > side * from.x);
  }

  /**
   * Where turns happen, per direction, in the order a driver meets them.
   *
   * Only the three side streets. Prince of Wales Avenue is on the far side of
   * the road, does not connect to the A20 in OSM at all, and the estate
   * traffic is not counted anywhere, so inventing a turning flow for it would
   * be inventing a number twice over.
   */
  buildTurnPoints() {
    for (const direction of ['inbound', 'outbound']) {
      const lines = STOP_LINES[direction] || [];
      this.turnPoints[direction] = this.arms.map((arm) => {
        const s = this.junctionS(direction, arm.z);
        // Index into this direction's stop lines when the junction happens to
        // be signalised, so a turning vehicle reads the same signal as
        // everything else in its lane. All three of these are priority
        // junctions, so it is null, and a driver turning at one is looking for
        // a gap rather than waiting for a green. Falling back to index 0 held
        // every turner at a red belonging to a signal somewhere else entirely.
        const found = lines.findIndex((v) => Math.abs(v - s) < 1e-6);
        const idx = found < 0 ? null : found;
        return {
          arm,
          s,
          idx,
          side: arm.side,
          // Inbound meets these streets on its nearside, outbound has to cross
          // the oncoming traffic to reach them. That asymmetry is the whole
          // reason the two directions behave differently here.
          kind: direction === 'inbound' ? 'left' : 'right',
        };
      }).sort((a, b) => a.s - b.s);
    }
  }

  /**
   * Is the crossing clear enough to go?
   *
   * A vehicle blocks if it is standing in the way, or if it is moving and
   * will reach the conflict point inside the critical gap. Nothing else does,
   * for the reason given at CONFLICT_HALF.
   */
  clearToCross(lanes, z, criticalGap, targetLane = null) {
    for (const lane of lanes) {
      const target = lane === targetLane;
      // A vehicle joining a lane ends up a little downstream of the mouth,
      // which is where it actually comes to rest, and the space it needs is
      // measured from there rather than from the centre of the junction.
      const sJ = this.junctionS(lane.direction, z) + (target ? MERGE_ENTRY_AHEAD : 0);
      const half = target ? MERGE_CLEAR_HALF : CONFLICT_HALF;
      for (const v of lane.vehicles) {
        // A vehicle already swinging out of the lane is no longer in it.
        if (Math.abs(v.off || 0) > 1.5) continue;
        const d = sJ - v.s;
        if (d > -(half + v.len) && d < half) return false;
        if (d <= 0 || v.v <= CREEP_MS) continue;
        // Traffic with a red between it and the conflict point is not
        // arriving, whatever speed it is doing. This is the interaction the
        // signals have with the side roads: the red that holds the corridor
        // is the window everything waiting to cross it gets, and without
        // this the arms never discharge at all.
        const red = this.nextRedStop(lane.direction, v.s);
        if (red !== null && red <= sJ + 0.5) continue;
        if (d / v.v < criticalGap) return false;
      }
    }
    return true;
  }

  /**
   * Roll for a turn at each junction the vehicle reaches, once per junction.
   *
   * The hazard is applied at the junction rather than drawn once at spawn,
   * and that is not a detail. Applied at the junction, the share that turns
   * off is a share of the flow actually arriving there, which is the same
   * flow the side road is putting back. Drawn once at spawn, the flow would
   * decay along the corridor and stop matching the count.
   *
   * Only the designated turn lane rolls, so the rate is multiplied by the
   * number of general lanes in the direction: a driver intending to turn
   * positions himself in the right lane long before the junction, and this
   * keeps the direction total at the assumed share either way.
   */
  decideTurn(lane, veh, direction) {
    const points = this.turnPoints[direction];
    if (!points.length) return;
    if (veh.tp === undefined) veh.tp = 0;

    while (veh.tp < points.length) {
      const pt = points[veh.tp];
      if (veh.s > pt.s - DECIDE_AHEAD) {
        veh.tp++;
        // Already past it, or in the wrong lane for the movement: no roll, so
        // no rand() is consumed and the sequence stays reproducible either way.
        if (veh.s > pt.s - 2) continue;
        if (veh.type !== 'car') continue;
        const turnLane = this.turnLaneFor(direction, pt.side);
        if (turnLane !== lane) continue;
        const lanesInDir = this.lanes.filter(
          (l) => l.direction === direction && this.generalLaneIds.has(l.id)
        ).length;
        const share = pt.kind === 'left' ? this.leftTurnShare : this.rightTurnShare;
        const p = Math.min(0.5, share * Math.max(1, lanesInDir));
        if (this.rand() < p) {
          veh.turn = { pt, lane, go: false, target: pt.side * (KERB_X + TURN_CLEAR_X) - lane.x };
          return;
        }
        continue;
      }
      return;
    }
  }

  /**
   * Look for the gap, and swing out once it is found.
   *
   * A right turner sits on the stop line in the offside lane with the light
   * green and nothing it can do about it, and everything behind it sits there
   * too. That is the cost this exists to show. A left turner only has the bus
   * lane to cross, so it mostly rolls through, but if a Glider is coming it
   * stops dead in the running lane and the effect is the same.
   */
  updateTurn(lane, veh, dt) {
    const t = veh.turn;
    if (!t) return;
    const direction = lane.direction;

    if (!t.go) {
      // A priority junction has no signal to wait for, so the only thing
      // between the driver and the turn is the gap.
      const green = t.pt.idx === null ? true : this.isGreen(direction, t.pt.idx);
      const near = veh.s > t.pt.s - COMMIT_AHEAD;
      // Only time spent stopped counts as waiting. Rolling up to the line is
      // not patience running out.
      if (near && veh.v < 1.2) t.heldFor = (t.heldFor || 0) + dt;
      if (near && green) {
        const crossed = this.crossedLanes(lane, t.pt.side);
        const base = t.pt.kind === 'right' ? CRIT_TURN_RIGHT : CRIT_TURN_LEFT;
        const crit = acceptedGap(base, t.heldFor);
        if (crossed.length === 0 || this.clearToCross(crossed, t.pt.arm.z, crit)) t.go = true;
      }
      // Only green time counts at a signal. Sitting at a red is signal delay,
      // which the analytic model already has, and folding it in here would
      // double-count it and overstate what the turn costs. At a priority
      // junction there is no red, so every second of it is the turn's own
      // cost and all of it counts.
      t.holding = !t.go && green && veh.v < 0.6 && veh.s > t.pt.s - 6;
      if (t.holding && t.pt.kind === 'right') this.stats.rightWaitSeconds += dt;
    }

    if (t.go && veh.s > t.pt.s - TURN_SWEEP_FROM) {
      const step = TURN_SWEEP_MS * dt;
      const now = veh.off || 0;
      veh.off = now + THREE.MathUtils.clamp(t.target - now, -step, step);
    }
  }

  /**
   * Side-road arrivals, the queue, and getting out.
   *
   * The generation rate is the turn-in rate at the same junction, per
   * direction, which is what keeps the mainline flow matching the counts.
   * Whether they actually get out is another matter, and under a queueing
   * peak they do not, which is the honest answer and the one a local
   * recognises.
   */
  stepArms(dt) {
    for (const arm of this.arms) {
      // Arrivals. Every vehicle that turned into this arm comes back out of
      // it, in the direction it was lost from: a left turn in becomes a left
      // turn out, a right turn in becomes a right turn out. That is what
      // holds the mainline flow to the demand the analytic model was given,
      // and therefore to the counts, rather than letting it decay along the
      // corridor. Generating the arm's outflow independently would have made
      // the reconciliation approximate; this makes it exact.
      for (const join of ['inbound', 'outbound']) {
        while (arm.owed[join] >= 1 && arm.queue.length < MERGE_QUEUE_MAX) {
          arm.owed[join] -= 1;
          const tail = arm.queue.length
            ? arm.queue[arm.queue.length - 1].d
            : MERGE_STOP;
          arm.queue.push({
            join,
            // Arrives from up the street rather than materialising on the
            // give-way line, so the queue is something you watch form.
            d: Math.min(arm.path.len, Math.max(tail + MERGE_SLOT, MERGE_STOP + 34)),
            v: MERGE_CREEP_MS,
            tint: 0.7 + this.rand() * 0.6,
          });
        }
      }

      // Close up on the give-way line.
      for (let k = 0; k < arm.queue.length; k++) {
        const want = MERGE_STOP + k * MERGE_SLOT;
        const car = arm.queue[k];
        const move = Math.min(car.d - want, MERGE_CREEP_MS * dt);
        car.d -= Math.max(0, move);
        car.v = Math.max(0, move) / Math.max(1e-6, dt);
      }

      // Only the vehicle on the line can go, and only when it has its gap.
      const head = arm.queue[0];
      if (!head || head.d > MERGE_STOP + 0.4) continue;
      this.stats.mergeWaitSeconds += dt;

      head.heldFor = (head.heldFor || 0) + dt;

      const target = this.turnLaneFor(head.join, arm.side);
      if (!target) continue;
      const lanes = [...this.crossedLanes(target, arm.side), target];
      const base = head.join === 'inbound' ? CRIT_MERGE_LEFT : CRIT_MERGE_RIGHT;
      if (!this.clearToCross(lanes, arm.z, acceptedGap(base, head.heldFor), target)) continue;

      const sJ = this.junctionS(head.join, arm.z) + MERGE_ENTRY_AHEAD;
      target.vehicles.push({
        s: sJ,
        v: MERGE_ENTRY_MS,
        type: 'car',
        len: CAR_LEN,
        tint: head.tint,
        // It joins the corridor mid-section, so it must only be offered the
        // junctions still ahead of it.
        tp: this.turnPoints[head.join].filter((pt) => pt.s <= sJ + 2).length,
      });
      target.vehicles.sort((a, b) => b.s - a.s);
      arm.queue.shift();
      if (head.join === 'inbound') this.stats.mergesInbound += 1;
      else this.stats.mergesOutbound += 1;
    }
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

    // Which lane a turn is made from depends on which lanes general traffic
    // has, so this has to follow the reallocation above, not precede it.
    this.buildTurnPoints();

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
    for (const arm of this.arms) {
      arm.queue.length = 0;
      arm.owed.inbound = 0;
      arm.owed.outbound = 0;
    }

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
      //
      // Demand that cannot be got in waits at the entry rather than being
      // thrown away. A red at either installation can back the queue out of
      // the modelled length, and discarding those arrivals cost the inbound
      // direction a fifth of its demand and made the simulation quietly
      // disagree with the count it was given. On the real road that queue
      // simply stands further up the hill.
      if (isGeneral && motors < MAX_CARS - MAX_BUSES) {
        const perLaneHourly = this.demand[lane.direction] / Math.max(1, generalInDir);
        lane.spawnAccumulator += (perLaneHourly / 3600) * dt;
        if (lane.spawnAccumulator >= 1) {
          if (this.tryInsert(lane, { type: 'car', len: CAR_LEN })) lane.spawnAccumulator -= 1;
          // Bounded, so a scenario that is genuinely over capacity shows as a
          // jam rather than as an ever-growing invisible queue off-stage.
          else lane.spawnAccumulator = Math.min(lane.spawnAccumulator, ENTRY_QUEUE_MAX);
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
    if (last && last.s < needed) return false; // no room at the entry
    lane.vehicles.push({
      s: 0,
      v: this.desiredSpeed(spec.type) * (0.75 + this.rand() * 0.2),
      tint: 0.7 + this.rand() * 0.6,
      ...spec,
    });
    return true;
  }

  step(dt) {
    this.time += dt;
    this.stats.simSeconds += dt;
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
        if (veh.type === 'car' && this.generalLaneIds.has(lane.id) && !veh.turn) {
          this.decideTurn(lane, veh, lane.direction);
        }
        if (veh.turn) this.updateTurn(lane, veh, dt);
        // A driver about to turn has already slowed, and the queue behind him
        // has already had to. Dropping the desired speed is what puts that in
        // the car-following model rather than beside it.
        const v0 = veh.turn && veh.s > veh.turn.pt.s - COMMIT_AHEAD
          ? TURN_SPEED
          : this.desiredSpeed(veh.type);
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

        // Keep the side road mouth clear. See MOUTH_KEEP_BACK.
        const mouth = this.turnPoints[lane.direction]
          .find((pt) => pt.s - MOUTH_KEEP_BACK > veh.s);
        if (mouth && leader && leader.v < MOUTH_KEEP_SLOW
            && veh.s > mouth.s - MOUTH_KEEP_BACK - MOUTH_KEEP_RANGE
            && leader.s - leader.len < mouth.s + MOUTH_KEEP_FWD + IDM.s0) {
          const gMouth = mouth.s - MOUTH_KEEP_BACK - veh.s;
          if (gMouth < gap) { gap = gMouth; dv = veh.v; }
        }

        // A red signal is a stationary obstacle on its stop line.
        const stop = this.nextRedStop(lane.direction, veh.s);
        if (stop !== null) {
          const gSig = stop - veh.s - 0.5;
          if (gSig < gap) { gap = gSig; dv = veh.v; }
        }

        // Waiting for a gap to turn is a stop on the stop line, and because
        // the vehicle stays in the lane it is a stationary leader for
        // everything behind it. No parallel system: the block falls out of
        // the car-following model that was already there.
        if (veh.turn && !veh.turn.go) {
          const gTurn = veh.turn.pt.s - veh.s - 0.5;
          if (gTurn < gap) { gap = gTurn; dv = veh.v; }
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

        // Gone off the far end, or gone into the side street.
        if (veh.turn && veh.turn.go
            && Math.abs(veh.off || 0) > Math.abs(veh.turn.target) - 1.0) {
          lane.vehicles.splice(i, 1);
          veh.turn.pt.arm.owed[lane.direction] += 1;
          if (veh.turn.pt.kind === 'right') this.stats.turnsOffRight += 1;
          else this.stats.turnsOffLeft += 1;
        } else if (veh.s > ROAD_LEN) {
          lane.vehicles.splice(i, 1);
        }
      }

      // What the waiting costs the traffic behind. Counted here, per lane,
      // because it is the number the whole feature is for.
      for (let i = 0; i < lane.vehicles.length; i++) {
        const t = lane.vehicles[i].turn;
        if (!t || t.go || !t.holding) continue;
        for (let j = i + 1; j < lane.vehicles.length; j++) {
          const back = lane.vehicles[j];
          if (lane.vehicles[i].s - back.s > 90) break;
          if (back.v < 1.2) this.stats.blockedSeconds += dt;
        }
      }

      // Overtaking reorders the lane, so the leader chain has to be rebuilt or
      // the bus spends the rest of its run braking for something behind it.
      lane.vehicles.sort((a, b) => b.s - a.s);
    }

    // Side roads last, so anything they inject meets a settled corridor and
    // is car-following from its first step rather than its second.
    this.stepArms(dt);
  }

  /** Two amber blocks on the turning side, front and rear. */
  drawIndicators(ii, x, z, side, dir) {
    if (ii >= MAX_INDICATORS - 1) return ii;
    for (const f of [1, -1]) {
      this._v.set(x + side * 0.85, 0.62, z + dir * f * 1.6);
      this._m.compose(this._v, this._q, this._s);
      this.indicatorMesh.setMatrixAt(ii++, this._m);
    }
    return ii;
  }

  /** Push simulation state into the instanced meshes. */
  render(nightFactor) {
    let ci = 0;
    let bi = 0;
    let li = 0;
    let yi = 0;
    let mi = 0;
    let ii = 0;
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
          // Cars carry a lateral offset now, because a turning car swings out
          // of its lane before it leaves the corridor.
          const x = lane.x + (veh.off || 0);
          this._v.set(x, 0, z);
          this._m.compose(this._v, this._q, this._s);
          this.carMesh.setMatrixAt(ci, this._m);
          const col = speedColour(ratio).clone().multiplyScalar(veh.tint);
          this.carMesh.setColorAt(ci, col);
          ci++;

          if (veh.turn) ii = this.drawIndicators(ii, x, z, veh.turn.pt.side, lane.dir);

          // Rear lamp, brighter when braking or stationary.
          if (li < MAX_CARS) {
            const rearZ = z - lane.dir * (CAR_LEN / 2 + 0.02);
            this._v.set(x, 0.55, rearZ);
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

    // ---- Side-road queues --------------------------------------------------
    // Drawn but kept out of the corridor statistics. A car stationary at a
    // give-way line is not corridor congestion, and averaging it in would
    // report the road as slower than it is running. Same call as the bikes.
    for (const arm of this.arms) {
      for (const car of arm.queue) {
        if (ci >= MAX_CARS) break;
        const p = legPoint(arm.path, car.d);
        const hx = -p.hx;
        const hz = -p.hz;
        // Keep left, which on an arm this narrow is the difference between a
        // queue and a jumble.
        const lx = hz;
        const lz = -hx;
        const x = p.x + lx * 1.5;
        const z = p.z + lz * 1.5;
        this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(hx, hz));
        this._v.set(x, 0, z);
        this._m.compose(this._v, this._q, this._s);
        this.carMesh.setMatrixAt(ci, this._m);
        this.carMesh.setColorAt(ci, speedColour(car.v / this.freeFlowMs).clone()
          .multiplyScalar(car.tint));
        ci++;

        // Indicating which way it is trying to go, which is the difference
        // between the car that will be gone in a second and the one that will
        // still be sitting there when the lights change again.
        if (ii < MAX_INDICATORS - 1) {
          const turn = car.join === 'inbound' ? [-lx, -lz] : [lx, lz];
          for (const f of [1, -1]) {
            this._v.set(
              x + turn[0] * 0.85 + hx * f * 1.6, 0.62,
              z + turn[1] * 0.85 + hz * f * 1.6
            );
            this._m.compose(this._v, this._q, this._s);
            this.indicatorMesh.setMatrixAt(ii++, this._m);
          }
        }
      }
    }

    // Blink at about ninety flashes a minute, off the simulation clock so it
    // stays deterministic and stays in step with everything else.
    if (Math.floor(this.time * 3) % 2 !== 0) ii = 0;

    this.indicatorMesh.count = ii;
    this.indicatorMesh.instanceMatrix.needsUpdate = true;
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
