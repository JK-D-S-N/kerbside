import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ASSUMPTIONS, CALIBRATION, generalTrafficLanes, busLaneOperating,
  websterUniformDelay, carJourneyTimeMin, freeFlowJourneyMin, busJourneyTimeMin,
  busFreeFlowJourneyMin, carEmissionsPerKm, evaluateHour, runDay, solveBreakEven,
} from '../src/model.js';
import { COUNTS } from '../src/counts.js';
import { DEFAULT_CONFIG } from '../src/scenarios.js';
import { JUNCTIONS, JUNCTION_Z, MOUTH_HALF, HALF, ROAD_LEN, KERB_X } from '../src/scene.js';
import { STOP_LINES } from '../src/vehicles.js';

const A = DEFAULT_ASSUMPTIONS;

const baseCfg = {
  totalLanes: 2,
  busLaneOn: true,
  busLaneStart: 7,
  busLaneEnd: 19,
  busLanePeakOnly: false,
  peakWindows: [[7, 10], [16, 19]],
  bikeLaneOn: false,
  busServiceOn: true,
  busesPerHour: 10,
  busLoad: 40,
  demandMultiplier: 1,
};

const counts = {
  inbound: COUNTS.inbound.weekday.total,
  outbound: COUNTS.outbound.weekday.total,
};

test('counts data is 24 hourly values and matches the published AADT', () => {
  assert.equal(counts.inbound.length, 24);
  assert.equal(counts.outbound.length, 24);
  // DfI 2023 summary: CP921 13,380 rounded, CP918 13,350 rounded (7-day AADT).
  // These are the weekday averages, which run slightly higher.
  const inSum = counts.inbound.reduce((a, b) => a + b, 0);
  const outSum = counts.outbound.reduce((a, b) => a + b, 0);
  assert.ok(inSum > 13000 && inSum < 15000, `inbound day total ${inSum}`);
  assert.ok(outSum > 13000 && outSum < 15000, `outbound day total ${outSum}`);
});

test('the bus lane signature is present in the raw nearside lane counts', () => {
  // Nearside lane use should collapse during 07:00-19:00 and recover at 19:00.
  const near = COUNTS.inbound.weekday.nearside;
  assert.ok(near[8] < near[6] / 2, `08:00 ${near[8]} vs 06:00 ${near[6]}`);
  assert.ok(near[19] > near[18] * 3, `19:00 ${near[19]} vs 18:00 ${near[18]}`);
});

test('lane reallocation always leaves one general traffic lane', () => {
  assert.deepEqual(generalTrafficLanes(2, false, false), { lanes: 2, clamped: false });
  assert.deepEqual(generalTrafficLanes(2, true, false), { lanes: 1, clamped: false });
  assert.deepEqual(generalTrafficLanes(2, true, true), { lanes: 1, clamped: true });
  assert.deepEqual(generalTrafficLanes(3, true, true), { lanes: 1, clamped: false });
});

test('bus lane hours and peak-only windows', () => {
  const c = { ...baseCfg };
  assert.equal(busLaneOperating(6, c), false);
  assert.equal(busLaneOperating(7, c), true);
  assert.equal(busLaneOperating(18, c), true);
  assert.equal(busLaneOperating(19, c), false);
  const p = { ...baseCfg, busLanePeakOnly: true };
  assert.equal(busLaneOperating(8, p), true);
  assert.equal(busLaneOperating(12, p), false);
  assert.equal(busLaneOperating(17, p), true);
  const off = { ...baseCfg, busLaneOn: false };
  assert.equal(busLaneOperating(8, off), false);
});

test('modelled single-lane capacity reproduces the observed peak flow', () => {
  const capacity = 1 * A.saturationFlow * A.greenFraction;
  assert.ok(Math.abs(capacity - CALIBRATION.modelledLaneCapacity) < 1e-6,
    `capacity ${capacity}`);
  const observed = CALIBRATION.observedPeakLaneFlow;
  assert.ok(Math.abs(capacity - observed) / observed < 0.05,
    `capacity ${capacity} vs observed ${observed}`);
  // And the published figure is the one we actually shipped in counts.js.
  assert.equal(COUNTS.inbound.weekday.offside[7], observed);
});

test('journey time is monotonically increasing in demand and continuous at x = 1', () => {
  let prev = 0;
  for (let x = 0; x <= 2; x += 0.05) {
    const t = carJourneyTimeMin(x, A);
    assert.ok(t >= prev - 1e-9, `not monotonic at x=${x.toFixed(2)}`);
    prev = t;
  }
  const below = carJourneyTimeMin(0.999999, A);
  const above = carJourneyTimeMin(1.000001, A);
  assert.ok(Math.abs(below - above) < 0.01, `discontinuity: ${below} vs ${above}`);
});

test('free-flow journey time is the 30 mph run with no delay', () => {
  const t = freeFlowJourneyMin(A);
  assert.ok(Math.abs(t - 2.0) < 0.01, `expected 2.0 min, got ${t}`);
  // At zero demand, the only extra is signal delay.
  assert.ok(carJourneyTimeMin(0, A) > t);
});

test('websterUniformDelay stays finite as x approaches and exceeds 1', () => {
  assert.ok(Number.isFinite(websterUniformDelay(1, A)));
  assert.ok(Number.isFinite(websterUniformDelay(1.8, A)));
  assert.ok(websterUniformDelay(0.9, A) > websterUniformDelay(0.1, A));
});

test('a bus lane makes the bus faster and a busy road makes it slower', () => {
  const withLane = busJourneyTimeMin(1.1, true, A);
  const without = busJourneyTimeMin(1.1, false, A);
  assert.ok(withLane < without, `${withLane} should beat ${without}`);
});

test('bus dwell time is not counted as congestion delay', () => {
  // A bus running on a completely empty road still stops at halts. That is the
  // mode's own free-flow time, not delay caused by traffic.
  const emptyRoad = evaluateHour(0, { ...baseCfg, busLoad: 50 }, A, true);
  assert.ok(emptyRoad.busDelayMin < 0.5,
    `bus on an empty road should have almost no delay, got ${emptyRoad.busDelayMin}`);
  assert.ok(busFreeFlowJourneyMin(A) > freeFlowJourneyMin(A));
});

test('emissions rise as speed falls', () => {
  assert.ok(carEmissionsPerKm(10, A) > carEmissionsPerKm(30, A));
  assert.ok(carEmissionsPerKm(30, A) > carEmissionsPerKm(50, A));
  // Calibration point: 170 g/km at 50 kph.
  assert.ok(Math.abs(carEmissionsPerKm(50, A) - 170) < 1);
});

test('removing the bus lane doubles capacity and cuts the v/c ratio', () => {
  const peak = counts.inbound[7];
  const withLane = evaluateHour(peak, baseCfg, A, true);
  const withoutLane = evaluateHour(peak, baseCfg, A, false);
  assert.equal(withLane.lanes, 1);
  assert.equal(withoutLane.lanes, 2);
  assert.ok(withoutLane.vcRatio < withLane.vcRatio);
  assert.ok(withoutLane.carMin < withLane.carMin);
});

test('an empty bus lane is worse for everyone than no bus lane', () => {
  const empty = { ...baseCfg, busLoad: 0 };
  const scheme = runDay(counts, empty, A);
  const none = runDay(counts, { ...empty, busLaneOn: false }, A);
  assert.ok(scheme.totals.personHoursDelay > none.totals.personHoursDelay,
    'an empty bus lane should cost person-hours, not save them');
});

test('a full, frequent PEAK-ONLY bus lane beats no bus lane on person-delay', () => {
  // Once loading follows the day, an all-day lane on this corridor cannot pay
  // for itself: it holds a lane open through hours when the buses are nearly
  // empty. A peak-only lane keeps the benefit and drops the cost.
  const full = { ...baseCfg, busesPerHour: 12, busLoad: 95 };
  const none = runDay(counts, { ...full, busLaneOn: false }, A);

  const peakOnly = runDay(counts, { ...full, busLanePeakOnly: true }, A);
  assert.ok(peakOnly.totals.personHoursDelay < none.totals.personHoursDelay,
    `peak-only ${peakOnly.totals.personHoursDelay} should beat ${none.totals.personHoursDelay}`);

  const allDay = runDay(counts, full, A);
  assert.ok(allDay.totals.personHoursDelay > none.totals.personHoursDelay,
    'at a realistic peak load the all-day lane should lose, and be seen to lose');
});

test('break-even returns a load between empty and full, and it is the crossing point', () => {
  // Solved against the peak-only scheme, because the all-day break-even sits
  // within a passenger or two of the vehicle capacity, where the clamp on
  // busPassengersPerBus flattens the curve and there is no crossing to find.
  const scheme = { ...baseCfg, busLanePeakOnly: true };
  const comparison = { ...baseCfg, busLaneOn: false };
  const r = solveBreakEven(counts, scheme, comparison, A);
  assert.ok(!r.impossible, 'a full bus should be able to pay for a peak-only lane');
  assert.ok(r.load > 0 && r.load < A.busCapacity, `break-even load ${r.load}`);

  const net = (load) =>
    runDay(counts, { ...scheme, busLoad: load }, A).totals.personHoursDelay -
    runDay(counts, { ...comparison, busLoad: load }, A).totals.personHoursDelay;
  assert.ok(net(r.load - 3) > 0, 'just below break-even the scheme should still lose');
  assert.ok(net(r.load + 3) < 0, 'just above break-even the scheme should win');
});

test('bus loading follows the day, and the peak is the number the user sets', () => {
  const cfg = { ...baseCfg, busesPerHour: 12, busLoad: 100 };
  const day = runDay(counts, cfg, A);

  const perBus = day.hours.map(
    (h) => h.inbound.busPassengers / Math.max(1, h.inbound.busesPerHour)
  );
  const busiest = Math.max(...perBus);
  const quietest = Math.min(...perBus);

  assert.ok(busiest <= 100.001, `no hour should exceed the set peak, got ${busiest}`);
  assert.ok(busiest > 90, `the peak hour should be close to the set peak, got ${busiest}`);
  assert.ok(quietest < 10, `the small hours should be nearly empty, got ${quietest}`);
});

test('a peak-only lane breaks even at a lower load than an all-day lane', () => {
  const comparison = { ...baseCfg, busLaneOn: false };
  const allDay = solveBreakEven(counts, { ...baseCfg, busesPerHour: 12 }, comparison, A);
  const peak = solveBreakEven(
    counts, { ...baseCfg, busesPerHour: 12, busLanePeakOnly: true }, comparison, A
  );
  // On this corridor an all-day lane is often unpayable at any loading, which
  // is a stronger version of the same claim rather than a different one.
  assert.ok(peak.load !== null, 'a peak-only lane should have a reachable break-even');
  assert.ok(allDay.impossible || peak.load < allDay.load,
    `peak-only ${peak.load} should break even below all-day ${allDay.load}`);
});

test('break-even never exceeds the vehicle capacity of the bus', () => {
  const comparison = { ...baseCfg, busLaneOn: false };
  const r = solveBreakEven(counts, { ...baseCfg, busesPerHour: 4 }, comparison, A);
  if (r.load !== null) assert.ok(r.load <= A.busCapacity);
});

test('peak-only operation costs less delay than all-day operation', () => {
  const allDay = runDay(counts, baseCfg, A);
  const peakOnly = runDay(counts, { ...baseCfg, busLanePeakOnly: true }, A);
  assert.ok(peakOnly.totals.personHoursDelay < allDay.totals.personHoursDelay);
});

test('a day run produces 24 hours and finite totals', () => {
  const r = runDay(counts, baseCfg, A);
  assert.equal(r.hours.length, 24);
  for (const k of ['personHoursDelay', 'peopleMoved', 'co2Kg']) {
    assert.ok(Number.isFinite(r.totals[k]), `${k} not finite`);
    assert.ok(r.totals[k] > 0, `${k} should be positive`);
  }
});

test('demand multiplier moves delay in the right direction', () => {
  const quiet = runDay(counts, { ...baseCfg, demandMultiplier: 0.7 }, A);
  const busy = runDay(counts, { ...baseCfg, demandMultiplier: 1.3 }, A);
  assert.ok(busy.totals.personHoursDelay > quiet.totals.personHoursDelay);
});

// ---------------------------------------------------------------------------
// Geometry. The picture only corroborates the numbers if the junction a driver
// can see is the junction the simulation stops them at, so this is checked
// arithmetically rather than by looking at it.

test('every drawn junction is one the simulation stops traffic at', () => {
  assert.ok(JUNCTIONS.length >= 3, `${JUNCTIONS.length} junctions drawn`);
  for (const j of JUNCTIONS) {
    assert.ok(JUNCTION_Z.some((z) => Math.abs(z - j.z) < 1e-9),
      `${j.name} at z=${j.z} is not in JUNCTION_Z`);
  }
});

test('the junction mouth is centred on the stop line, not near it', () => {
  const zOf = {
    inbound: (s) => HALF - s,
    outbound: (s) => s - HALF,
  };
  for (const j of JUNCTIONS) {
    // The leg leaves the corridor at the kerb, square to it, on the mouth axis.
    assert.equal(j.leg[0][1], j.z, `${j.name} mouth starts off its own stop line`);
    assert.equal(Math.abs(j.leg[0][0]), KERB_X, `${j.name} leg does not start at the kerb`);

    for (const dir of ['inbound', 'outbound']) {
      const lines = STOP_LINES[dir].map(zOf[dir]);
      const hit = lines.find((z) => Math.abs(z - j.z) < 1e-9);
      assert.ok(hit !== undefined, `${j.name}: no ${dir} stop line at z=${j.z}`);
      assert.ok(Math.abs(hit - j.z) < MOUTH_HALF,
        `${j.name}: ${dir} stop line outside the mouth`);
    }
  }
});

test('stop lines only exist where a junction is drawn or the gates are', () => {
  const drawn = new Set(JUNCTIONS.map((j) => j.z));
  for (const s of STOP_LINES.inbound) {
    const z = HALF - s;
    assert.ok(drawn.has(z) || JUNCTION_Z.some((q) => Math.abs(q - z) < 1e-9),
      `inbound stop at z=${z} belongs to nothing`);
  }
  assert.ok(STOP_LINES.inbound.every((s) => s > 20 && s < ROAD_LEN - 20));
});

// ---------------------------------------------------------------------------
// Cycles and motorcycles in the bus lane. Both are legal in one in Northern
// Ireland, and a bus stuck behind a cycle has to use the general lane to get
// past, which is a cost of the bus lane that the analytic model does not see.

test('cycles and motorcycles run in the bus lane, and only there', async () => {
  const THREE = await import('three');
  const { TrafficSim } = await import('../src/vehicles.js');
  const sim = new TrafficSim(new THREE.Group());
  sim.configure({
    busLaneActive: true, bikeLaneOn: false, cycleTimeSec: 90, greenFraction: 0.55,
    freeFlowMs: 13.3, busesPerHour: 10, demand: { inbound: 1100, outbound: 1100 },
    resetDensity: true,
  });

  const bikeLanes = new Set();
  let cycles = 0;
  let motos = 0;
  for (const lane of sim.lanes) {
    for (const v of lane.vehicles) {
      if (v.type !== 'cycle' && v.type !== 'moto') continue;
      bikeLanes.add(lane.id);
      if (v.type === 'cycle') cycles++; else motos++;
    }
  }
  assert.ok(cycles > 0, 'no cycles on the road');
  assert.ok(motos > 0, 'no motorcycles on the road');
  for (const id of bikeLanes) {
    assert.ok(sim.lanes.find((l) => l.id === id).nearside, `${id} is not the bus lane`);
  }
});

test('a cycle is slow, a motorcycle is not, and that is the whole mechanism', async () => {
  const THREE = await import('three');
  const { TrafficSim } = await import('../src/vehicles.js');
  const sim = new TrafficSim(new THREE.Group());
  sim.freeFlowMs = 13.3;
  assert.ok(sim.desiredSpeed('cycle') >= 6 && sim.desiredSpeed('cycle') <= 8,
    `cycle wants ${sim.desiredSpeed('cycle')} m/s`);
  assert.ok(sim.desiredSpeed('moto') >= sim.desiredSpeed('bus'),
    'a motorcycle should not be holding a bus up');
  assert.ok(sim.desiredSpeed('bus') > sim.desiredSpeed('cycle') + 1.5,
    'a bus has no reason to overtake');
});

test('a bus pulls out into the general lane to pass a cycle', async () => {
  const THREE = await import('three');
  const { TrafficSim } = await import('../src/vehicles.js');
  const sim = new TrafficSim(new THREE.Group());
  // Roughly the 08:00 corridor: one general lane each way, signals platooning
  // it, and a bus every three minutes. The simulation is seeded, so this runs
  // the same way every time.
  sim.configure({
    busLaneActive: true, bikeLaneOn: false, cycleTimeSec: 90, greenFraction: 0.55,
    freeFlowMs: 13.3, busesPerHour: 20, demand: { inbound: 750, outbound: 750 },
    resetDensity: true,
  });

  let overtakes = 0;
  let maxOffset = 0;
  let heldUp = 0;
  const seen = new Set();
  for (let i = 0; i < 30000; i++) {
    sim.step(0.05);
    for (const lane of sim.lanes) {
      for (const v of lane.vehicles) {
        if (v.type !== 'bus') continue;
        maxOffset = Math.max(maxOffset, Math.abs(v.off || 0));
        if (Math.abs(v.off || 0) > 1) heldUp++;
        if (v.overtaking && !seen.has(v)) { seen.add(v); overtakes++; }
      }
    }
  }
  assert.ok(overtakes > 0, 'no bus ever pulled out for a cycle');
  assert.ok(maxOffset > 3, `bus only moved ${maxOffset.toFixed(2)} m sideways`);
  assert.ok(heldUp > 0, 'no time spent obstructing the general lane');
});

test('no cycles are put in the nearside lane when the bus lane is off', async () => {
  const THREE = await import('three');
  const { TrafficSim } = await import('../src/vehicles.js');
  const sim = new TrafficSim(new THREE.Group());
  sim.configure({
    busLaneActive: false, bikeLaneOn: false, cycleTimeSec: 90, greenFraction: 0.55,
    freeFlowMs: 13.3, busesPerHour: 10, demand: { inbound: 1100, outbound: 1100 },
    resetDensity: true,
  });
  for (let i = 0; i < 600; i++) sim.step(0.1);
  const bikes = sim.lanes.flatMap((l) => l.vehicles)
    .filter((v) => v.type === 'cycle' || v.type === 'moto');
  assert.equal(bikes.length, 0, `${bikes.length} bikes with the bus lane off`);
});

// ---------------------------------------------------------------------------
// Turning movements. Nothing used to leave the corridor and nothing used to
// join it, which took out the largest single cause of delay on a road like
// this: the car in the offside lane waiting to turn right with the lane
// behind it going nowhere. The shares are assumptions, so what is checked
// here is the mechanism and the arithmetic, not the levels.

/** A busy hour, one general lane each way, turning on. */
async function turningSim(over = {}) {
  const THREE = await import('three');
  const { TrafficSim } = await import('../src/vehicles.js');
  const sim = new TrafficSim(new THREE.Group());
  sim.configure({
    busLaneActive: true, bikeLaneOn: false, cycleTimeSec: 90, greenFraction: 0.55,
    freeFlowMs: 13.3, busesPerHour: 10, demand: { inbound: 750, outbound: 740 },
    leftTurnShare: 0.05, rightTurnShare: 0.03, resetDensity: true, ...over,
  });
  return sim;
}

function run(sim, seconds, dt = 0.05) {
  for (let i = 0; i < seconds / dt; i++) sim.step(dt);
}

test('turn points sit exactly on stop lines, inside the drawn mouths', async () => {
  const sim = await turningSim();
  assert.ok(sim.arms.length >= 3, `${sim.arms.length} side-road arms`);
  for (const direction of ['inbound', 'outbound']) {
    for (const pt of sim.turnPoints[direction]) {
      // The turn happens at the junction the simulation already stops traffic
      // at. If these ever drift apart, cars turn into the kerb.
      assert.ok(STOP_LINES[direction].some((s) => Math.abs(s - pt.s) < 1e-6),
        `${pt.arm.name} ${direction} turn at s=${pt.s} is not a stop line`);
      assert.equal(STOP_LINES[direction][pt.idx], pt.s,
        `${pt.arm.name} ${direction} reads the wrong signal`);
      const drawn = JUNCTIONS.find((j) => Math.abs(j.z - pt.arm.z) < 1e-9);
      assert.ok(drawn, `${pt.arm.name} turns into a street that is not drawn`);
      assert.ok(Math.abs(drawn.z - pt.arm.z) < MOUTH_HALF);
    }
  }
});

test('turning does not disturb the stop lines themselves', async () => {
  const before = JSON.stringify(STOP_LINES);
  const sim = await turningSim();
  run(sim, 400);
  assert.equal(JSON.stringify(STOP_LINES), before, 'STOP_LINES was mutated');
});

test('every vehicle that turns off comes back out of the side road', async () => {
  // The mainline reconciliation. The two DfI count points either end of the
  // section report the same flow, so the side roads must give back what they
  // take or the modelled flow decays along the corridor and stops matching.
  const inArms = () => sim.arms.reduce(
    (n, a) => n + a.queue.length + a.owed.inbound + a.owed.outbound, 0
  );

  const sim = await turningSim();
  run(sim, 600);
  sim.resetStats();
  // The warm-up leaves vehicles part way through an arm. They turned off
  // before the counters were reset, so they are not in `off`, and measuring
  // the change in what the arms hold is what makes this balance.
  const heldAtStart = inArms();
  run(sim, 3600);
  const s = sim.stats;
  const off = s.turnsOffLeft + s.turnsOffRight;
  const on = s.mergesInbound + s.mergesOutbound;
  const held = inArms() - heldAtStart;
  assert.ok(off > 50, `only ${off} turns off in a simulated hour`);
  assert.equal(off, on + held,
    `${off} off, ${on} on, arms went from ${heldAtStart} to ${inArms()}`);
});

test('turning is deterministic, like everything else in here', async () => {
  const a = await turningSim();
  const b = await turningSim();
  run(a, 1200);
  run(b, 1200);
  assert.deepEqual(a.stats, b.stats);
});

test('a right turner waits for a gap and holds up the lane behind it', async () => {
  const sim = await turningSim();
  run(sim, 600);
  sim.resetStats();
  run(sim, 3600);
  assert.ok(sim.stats.turnsOffRight > 10, `${sim.stats.turnsOffRight} right turns an hour`);
  assert.ok(sim.stats.rightWaitSeconds > 30,
    `right turners lost only ${sim.stats.rightWaitSeconds.toFixed(0)} s of green`);
  assert.ok(sim.stats.blockedSeconds > sim.stats.rightWaitSeconds,
    'a blocked lane should cost more vehicle-seconds than the turner itself');
});

test('right turns are made from the offside lane and lefts from the kerb side', async () => {
  const sim = await turningSim();
  // With the bus lane operating there is one general lane each way, so the
  // left turn is made across the bus lane.
  assert.equal(sim.turnLaneFor('inbound', -1).id, 'in-off');
  assert.equal(sim.turnLaneFor('outbound', -1).id, 'out-off');
  // Switch the bus lane off and the nearside lane comes back for the left.
  sim.configure({
    busLaneActive: false, bikeLaneOn: false, cycleTimeSec: 90, greenFraction: 0.55,
    freeFlowMs: 13.3, busesPerHour: 10, demand: { inbound: 750, outbound: 740 },
    leftTurnShare: 0.05, rightTurnShare: 0.03, resetDensity: true,
  });
  assert.equal(sim.turnLaneFor('inbound', -1).id, 'in-near');
  assert.equal(sim.turnLaneFor('outbound', -1).id, 'out-off');
  // An outbound right turn crosses both inbound lanes and nothing else.
  const crossed = sim.crossedLanes(sim.turnLaneFor('outbound', -1), -1).map((l) => l.id);
  assert.deepEqual(crossed.sort(), ['in-near', 'in-off']);
});

test('a merging vehicle never joins an operating bus lane', async () => {
  const sim = await turningSim();
  run(sim, 2400);
  const busLane = sim.lanes.find((l) => l.id === 'in-near');
  assert.ok(sim.stats.mergesInbound > 0, 'nothing ever merged inbound');
  assert.equal(busLane.vehicles.filter((v) => v.type === 'car').length, 0,
    'a car was put in the bus lane');
});

test('side-road queues stay on the side road', async () => {
  const sim = await turningSim();
  run(sim, 2400);
  for (const arm of sim.arms) {
    for (const car of arm.queue) {
      assert.ok(car.d >= 0 && car.d <= arm.path.len,
        `${arm.name}: a car at ${car.d.toFixed(1)} m is off the end of the street`);
    }
  }
});

test('no turning share means the corridor behaves exactly as it did', async () => {
  const sim = await turningSim({ leftTurnShare: 0, rightTurnShare: 0 });
  run(sim, 1800);
  assert.equal(sim.stats.turnsOffLeft + sim.stats.turnsOffRight, 0);
  assert.equal(sim.stats.mergesInbound + sim.stats.mergesOutbound, 0);
  assert.equal(sim.arms.reduce((n, a) => n + a.queue.length, 0), 0);
});

// ---------------------------------------------------------------------------
// Steady state. This is the check that was missed, so it is the one that gets
// a test: a throughput that is steady but below demand is not a steady state,
// it is a queue growing at a constant rate, and it looks fine for the first
// few minutes of a demo and then seizes.

/** The simulation configured exactly the way the page configures it. */
async function pageSim(hour, over = {}) {
  const THREE = await import('three');
  const { TrafficSim } = await import('../src/vehicles.js');
  const a = { ...DEFAULT_ASSUMPTIONS, ...over };
  const cfg = { ...DEFAULT_CONFIG };
  const active = busLaneOperating(hour, cfg);
  const inbound = evaluateHour(COUNTS.inbound.weekday.total[hour], cfg, a, active);
  const outbound = evaluateHour(COUNTS.outbound.weekday.total[hour], cfg, a, active);
  const sim = new TrafficSim(new THREE.Group());
  sim.configure({
    busLaneActive: active, bikeLaneOn: cfg.bikeLaneOn, cycleTimeSec: a.cycleTimeSec,
    greenFraction: a.greenFraction, freeFlowMs: a.freeFlowSpeedKph / 3.6,
    busesPerHour: cfg.busServiceOn ? cfg.busesPerHour : 0,
    demand: { inbound: inbound.carDemand, outbound: outbound.carDemand },
    leftTurnShare: a.leftTurnShare, rightTurnShare: a.rightTurnShare, resetDensity: true,
  });
  return sim;
}

/** What the HUD reads: motor vehicles on the corridor, and their mean speed. */
function corridorLoad(sim) {
  let n = 0;
  let sum = 0;
  for (const lane of sim.lanes) {
    for (const v of lane.vehicles) {
      if (v.type === 'cycle' || v.type === 'moto') continue;
      n++; sum += v.v;
    }
  }
  return { n, mph: n ? (sum / n) * 3.6 / 1.609344 : 0 };
}

/** Mean load over the first and last thirds of a run, one sample a minute. */
function loadTrend(sim, minutes, dt = 0.05) {
  const rows = [];
  for (let m = 0; m < minutes; m++) {
    for (let i = 0; i < 60 / dt; i++) sim.step(dt);
    rows.push(corridorLoad(sim));
  }
  const third = Math.floor(minutes / 3);
  const mean = (r, k) => r.reduce((s, x) => s + x[k], 0) / r.length;
  return {
    early: { n: mean(rows.slice(0, third), 'n'), mph: mean(rows.slice(0, third), 'mph') },
    late: { n: mean(rows.slice(-third), 'n'), mph: mean(rows.slice(-third), 'mph') },
  };
}

for (const hour of [7, 8, 17]) {
  test(`the corridor reaches a steady state at ${String(hour).padStart(2, '0')}:00`, async () => {
    const sim = await pageSim(hour);
    const t = loadTrend(sim, 60);
    // Allowing a quarter more vehicles late than early is generous. A corridor
    // that is filling up doubles inside an hour, which is what this catches.
    assert.ok(t.late.n < t.early.n * 1.25,
      `${hour}:00 still filling: ${t.early.n.toFixed(1)} veh early, ${t.late.n.toFixed(1)} late`);
    assert.ok(t.late.mph > t.early.mph * 0.75,
      `${hour}:00 still slowing: ${t.early.mph.toFixed(1)} mph early, ${t.late.mph.toFixed(1)} late`);
    // And it must be moving, not crawling. The analytic model says roughly
    // 17 mph at these hours; a corridor at walking pace is not corroborating
    // anything, it is contradicting it.
    assert.ok(t.late.mph > 10, `${hour}:00 settles at ${t.late.mph.toFixed(1)} mph`);
  });
}

test('the default right-turn share is one the running lane can absorb', async () => {
  // 0.03 was tried and does not recover at the 17:00 outbound peak. If anyone
  // raises the default again, this is the test that should stop them.
  const stable = await pageSim(17);
  const s = loadTrend(stable, 45);
  assert.ok(s.late.n < s.early.n * 1.25,
    `default share runs away: ${s.early.n.toFixed(1)} -> ${s.late.n.toFixed(1)} veh`);

  const pushed = await pageSim(17, { rightTurnShare: 0.05 });
  const p = loadTrend(pushed, 45);
  // Pushing the slider must visibly cost something, or the assumption is not
  // doing any work and there is no point exposing it.
  assert.ok(p.late.n > s.late.n * 1.15,
    `raising the right-turn share changed nothing: ${s.late.n.toFixed(1)} vs ${p.late.n.toFixed(1)}`);
});
