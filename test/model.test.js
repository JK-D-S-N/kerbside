import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ASSUMPTIONS, CALIBRATION, generalTrafficLanes, busLaneOperating,
  websterUniformDelay, carJourneyTimeMin, freeFlowJourneyMin, busJourneyTimeMin,
  busFreeFlowJourneyMin, carEmissionsPerKm, evaluateHour, runDay, solveBreakEven,
} from '../src/model.js';
import { COUNTS } from '../src/counts.js';

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

test('a full, frequent bus lane beats no bus lane on person-delay', () => {
  const full = { ...baseCfg, busesPerHour: 12, busLoad: 95 };
  const scheme = runDay(counts, full, A);
  const none = runDay(counts, { ...full, busLaneOn: false }, A);
  assert.ok(scheme.totals.personHoursDelay < none.totals.personHoursDelay,
    `scheme ${scheme.totals.personHoursDelay} should beat ${none.totals.personHoursDelay}`);
});

test('break-even returns a load between empty and full, and it is the crossing point', () => {
  const comparison = { ...baseCfg, busLaneOn: false };
  const r = solveBreakEven(counts, baseCfg, comparison, A);
  assert.ok(!r.impossible, 'a full bus should be able to pay for the lane');
  assert.ok(r.load > 0 && r.load < A.busCapacity, `break-even load ${r.load}`);

  const net = (load) =>
    runDay(counts, { ...baseCfg, busLoad: load }, A).totals.personHoursDelay -
    runDay(counts, { ...comparison, busLoad: load }, A).totals.personHoursDelay;
  assert.ok(net(r.load - 3) > 0, 'just below break-even the scheme should still lose');
  assert.ok(net(r.load + 3) < 0, 'just above break-even the scheme should win');
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
