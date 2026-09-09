import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ASSUMPTIONS, CALIBRATION, generalTrafficLanes, busLaneOperating,
  websterUniformDelay, carJourneyTimeMin, freeFlowJourneyMin, busJourneyTimeMin,
  busFreeFlowJourneyMin, carEmissionsPerKm, evaluateHour, runDay, solveBreakEven,
} from '../src/model.js';
import { COUNTS } from '../src/counts.js';
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
