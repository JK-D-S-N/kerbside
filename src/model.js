/**
 * Kerbside corridor model.
 *
 * A deterministic link-and-junction model for one direction of a single
 * urban corridor, evaluated hour by hour. Every coefficient is exposed in
 * `DEFAULT_ASSUMPTIONS` and editable in the UI, because the point of the tool
 * is to argue about the coefficients, not to hide them.
 *
 * Method, in order:
 *   1. Capacity  = general-traffic lanes x saturation flow x effective green.
 *   2. Demand    = observed hourly count x demand multiplier, minus any trips
 *                  abstracted to the bus.
 *   3. Delay     = Webster uniform signal delay + BPR link delay, with a
 *                  deterministic queueing term once demand exceeds capacity.
 *   4. Outcome   = person-hours of delay and kg CO2, for cars and bus together.
 *
 * Nothing here is calibrated against observed journey times, because DfI does
 * not publish them for this corridor. It is calibrated against observed
 * *throughput*: see CALIBRATION below.
 */

/** Free-flow, signal and emissions coefficients. All editable in the UI. */
export const DEFAULT_ASSUMPTIONS = {
  // Link geometry
  linkLengthKm: 1.6,        // Stormont gates to Holywood Arches, approx
  freeFlowSpeedKph: 48,     // 30 mph limit, free-flow running speed

  // Junction
  saturationFlow: 1800,     // pcu/hr/lane, standard urban value
  greenFraction: 0.55,      // proportion of cycle time green to this approach
  cycleTimeSec: 90,         // signal cycle at the controlling junction
  junctionsOnLink: 5,       // signalised junctions and crossings on the modelled link

  // Link delay (BPR)
  bprAlpha: 0.15,
  bprBeta: 4,

  // Occupancy
  carOccupancy: 1.2,        // people per car, urban commuting
  busCapacity: 105,         // Glider Van Hool Exqui.City, 105 incl. 63 standing

  // Bus operation
  busDwellMinutes: 1.8,     // total dwell across halts on the link
  busPriorityFactor: 0.5,   // share of signal delay a bus still incurs in a bus lane

  // Emissions, COPERT-shaped speed curve E(v) = a/v + b + c*v in g CO2/km
  emissionsA: 1600,
  emissionsB: 115.5,        // calibrated so E(50 kph) = 170 g/km
  emissionsC: 0.45,
  busEmissionsPerKm: 1100,  // g CO2/km, 18m diesel-electric hybrid articulated

  // Behaviour
  carAbstractionRate: 0.40, // share of bus passengers who would otherwise drive
  ridershipLossWithoutLane: 0.25, // bus patronage lost if the bus lane is removed

  // Turning movements at Rosepark, Rosemount Avenue and Summerhill Avenue.
  //
  // Not used by anything below. Nothing in the analytic model turns: these
  // drive the microsimulation only, and they are here because this is where
  // the tool keeps the coefficients you are allowed to argue with.
  //
  // Both are ASSUMPTIONS. DfI count points 918 and 921 are mainline counts
  // and publish no turning breakdown, and no turning survey exists for these
  // junctions. What the two counts do constrain is the net: 13,380 AADT at
  // one end of the section and 13,350 at the other means whatever leaves the
  // corridor is matched by what joins it. The simulation is built to that,
  // generating each side road's outflow at the same rate as its inflow, so
  // mainline flow past any point still reconciles with the counts.
  //
  // The right share is 0.02 rather than the 0.03 first tried, and that is a
  // finding, not a tuning. Measured over two simulated hours at 17:00, the
  // busiest outbound hour, 0.03 grows the outbound running lane without
  // bound: 27 vehicles to 44, mean speed 16 mph down to 11, still climbing.
  // 0.02 holds flat. One running lane cannot carry three per cent of 798
  // veh/hr turning right across oncoming traffic with no right-turn pocket.
  // The slider goes to 0.15, so push it and watch the corridor tip over.
  leftTurnShare: 0.05,      // share of a direction's flow turning left off, per junction
  rightTurnShare: 0.02,     // and turning right off, which is what the lane cannot absorb
};

/**
 * CALIBRATION NOTE
 *
 * With the defaults above, capacity in a single general-traffic lane is
 *   1 x 1800 x 0.55 = 990 veh/hr.
 *
 * The observed 2023 flow in the single general-traffic (offside) lane inbound
 * at the 07:00 peak, DfI count point 921, is 978 veh/hr. The corridor is
 * therefore running at roughly 99% of modelled capacity in the morning peak,
 * which is what the model should say for a link that is visibly queueing.
 *
 * This is corroboration, not proof: a count cannot exceed capacity by
 * definition, so a peak count close to capacity is consistent with the model
 * but does not independently verify it. The honest reading is that 990 is a
 * plausible capacity and the peak is at or above it.
 */
export const CALIBRATION = {
  modelledLaneCapacity: 990,
  observedPeakLaneFlow: 978,
  observedPeakHour: 7,
  observedAt: 'DfI count point 921, inbound, offside lane, 2023 weekday average',
};

/** Clamp helper. */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Lanes available to general traffic in one direction.
 * At least one lane is always retained: a corridor with no general-traffic
 * lane is a pedestrianisation scheme, not a reallocation, and this model
 * does not cover it.
 */
export function generalTrafficLanes(totalLanes, busLaneActive, bikeLaneActive) {
  const taken = (busLaneActive ? 1 : 0) + (bikeLaneActive ? 1 : 0);
  const lanes = totalLanes - taken;
  return { lanes: Math.max(1, lanes), clamped: lanes < 1 };
}

/** Is the bus lane operating at this hour, given its start and end? */
export function busLaneOperating(hour, { busLaneOn, busLaneStart, busLaneEnd, busLanePeakOnly, peakWindows }) {
  if (!busLaneOn) return false;
  if (busLanePeakOnly) {
    return peakWindows.some(([a, b]) => hour >= a && hour < b);
  }
  return hour >= busLaneStart && hour < busLaneEnd;
}

/**
 * Webster uniform delay across every signalised junction on the link, in
 * seconds per vehicle.
 *
 * A single junction badly under-states this corridor. Between the Stormont
 * gates and the Holywood Arches a vehicle meets roughly five signalised
 * junctions and crossings, so the uniform term is applied per junction.
 */
export function websterUniformDelay(x, { cycleTimeSec, greenFraction, junctionsOnLink = 1 }) {
  const g = greenFraction;
  const xx = clamp(x, 0, 0.95); // the uniform term is undefined as x -> 1
  const perJunction = (0.5 * cycleTimeSec * Math.pow(1 - g, 2)) / (1 - xx * g);
  return perJunction * junctionsOnLink;
}

/**
 * Car journey time across the link, in minutes.
 * BPR below capacity; a deterministic oversaturation queue above it. The two
 * branches meet continuously at x = 1.
 */
export function carJourneyTimeMin(x, a) {
  const freeFlowMin = (a.linkLengthKm / a.freeFlowSpeedKph) * 60;
  const signalMin = websterUniformDelay(x, a) / 60;

  let runningMin;
  if (x <= 1) {
    runningMin = freeFlowMin * (1 + a.bprAlpha * Math.pow(x, a.bprBeta));
  } else {
    // Average delay to a vehicle arriving during one hour of oversaturation
    // with an initially empty queue is (x - 1) * T / 2, T = 60 min.
    runningMin = freeFlowMin * (1 + a.bprAlpha) + (x - 1) * 30;
  }
  return runningMin + signalMin;
}

/** Free-flow reference journey time, minutes. Delay is measured against this. */
export function freeFlowJourneyMin(a) {
  return (a.linkLengthKm / a.freeFlowSpeedKph) * 60;
}

/**
 * Free-flow reference for a bus, minutes.
 *
 * Dwell at halts is inherent to the mode, not congestion, so it belongs in the
 * bus's own free-flow reference. Measuring bus delay against the *car*
 * free-flow time would book every second of dwell as delay and would make any
 * bus scheme look worse the more passengers it carried.
 */
export function busFreeFlowJourneyMin(a) {
  return freeFlowJourneyMin(a) + a.busDwellMinutes;
}

/** Bus journey time across the link, in minutes. */
export function busJourneyTimeMin(x, busLaneActive, a) {
  const freeFlowMin = freeFlowJourneyMin(a);
  const signalMin = websterUniformDelay(x, a) / 60;
  if (busLaneActive) {
    // Runs clear of the queue; still meets the signal, but with priority.
    return freeFlowMin + signalMin * a.busPriorityFactor + a.busDwellMinutes;
  }
  return carJourneyTimeMin(x, a) + a.busDwellMinutes;
}

/** CO2 for a car, g/km, as a function of average journey speed in kph. */
export function carEmissionsPerKm(speedKph, a) {
  const v = Math.max(4, speedKph); // the curve is meaningless below walking pace
  return a.emissionsA / v + a.emissionsB + a.emissionsC * v;
}

/**
 * Evaluate one hour, one direction.
 *
 * @param {number} observedVeh  observed vehicles/hr in this direction
 * @param {object} cfg          scenario configuration
 * @param {object} a            assumptions
 * @param {boolean} busLaneActive whether the bus lane operates this hour
 */
/**
 * How full a bus is, hour by hour, as a share of its busiest hour.
 *
 * Buses are not equally loaded all day: the corridor's own traffic counts show
 * a sharp commuter double-peak, and bus ridership on a radial route follows it
 * more steeply than car traffic does, because the off-peak trips people still
 * make are the ones they make by car. Modelling one flat load all day flatters
 * an all-day bus lane and penalises a peak-only one, which is precisely the
 * comparison this tool exists to make.
 *
 * The shape is derived from the corridor's own hourly count profile, sharpened
 * at the peaks. It is a shape, not a survey: see WHAT THIS DOES NOT MODEL.
 */
export const BUS_LOAD_PROFILE = [
  0.05, 0.03, 0.02, 0.02, 0.06, 0.22, 0.55, 0.92, 1.00, 0.66,
  0.40, 0.35, 0.38, 0.40, 0.42, 0.58, 0.86, 0.95, 0.70, 0.44,
  0.30, 0.22, 0.14, 0.08,
];

/**
 * @param {number} hour  clock hour, so bus loading can follow the day
 */
export function evaluateHour(observedVeh, cfg, a, busLaneActive, hour = null) {
  const { lanes, clamped } = generalTrafficLanes(cfg.totalLanes, busLaneActive, cfg.bikeLaneOn);
  const capacity = lanes * a.saturationFlow * a.greenFraction;

  // Bus service. Ridership is assumed to fall when the lane is taken away.
  const busesPerHour = cfg.busServiceOn ? cfg.busesPerHour : 0;
  const loadFactor = busLaneActive ? 1 : 1 - a.ridershipLossWithoutLane;
  // cfg.busLoad is the load at the busiest hour. Every other hour is a share
  // of it. A caller with no hour (a single-hour probe) gets the peak.
  const shape = hour === null ? 1 : BUS_LOAD_PROFILE[((hour % 24) + 24) % 24];
  const busPassengersPerBus = Math.min(a.busCapacity, cfg.busLoad * shape * loadFactor);
  const busPassengers = busesPerHour * busPassengersPerBus;

  // Trips abstracted from cars by the bus service.
  const carsRemoved = (busPassengers * a.carAbstractionRate) / a.carOccupancy;

  const demandTotal = observedVeh * cfg.demandMultiplier;
  const carDemand = Math.max(0, demandTotal - carsRemoved);

  const x = carDemand / capacity;

  const freeFlowMin = freeFlowJourneyMin(a);
  const carMin = carJourneyTimeMin(x, a);
  const busMin = busJourneyTimeMin(x, busLaneActive, a);

  const carDelayMin = Math.max(0, carMin - freeFlowMin);
  const busDelayMin = Math.max(0, busMin - busFreeFlowJourneyMin(a));

  const carPeople = carDemand * a.carOccupancy;
  const peopleMoved = carPeople + busPassengers;

  const personHoursDelay =
    (carPeople * carDelayMin) / 60 + (busPassengers * busDelayMin) / 60;

  const avgSpeed = a.linkLengthKm / (carMin / 60);
  const carCo2Kg = (carDemand * a.linkLengthKm * carEmissionsPerKm(avgSpeed, a)) / 1000;
  const busCo2Kg = (busesPerHour * a.linkLengthKm * a.busEmissionsPerKm) / 1000;

  return {
    busLaneActive,
    lanes,
    lanesClamped: clamped,
    capacity,
    demandTotal,
    carDemand,
    carsRemoved,
    busesPerHour,
    busPassengers,
    busPassengersPerBus,
    vcRatio: x,
    throughput: Math.min(carDemand, capacity),
    unservedQueue: Math.max(0, carDemand - capacity),
    carMin,
    busMin,
    carDelayMin,
    busDelayMin,
    avgSpeed,
    peopleMoved,
    personHoursDelay,
    co2Kg: carCo2Kg + busCo2Kg,
    carCo2Kg,
    busCo2Kg,
  };
}

/**
 * Run a full day, both directions.
 *
 * @param {object} counts  { inbound: number[24], outbound: number[24] }
 */
export function runDay(counts, cfg, a) {
  const hours = [];
  const totals = {
    personHoursDelay: 0,
    peopleMoved: 0,
    co2Kg: 0,
    carDemand: 0,
    busPassengers: 0,
    hoursOverCapacity: 0,
  };

  for (let h = 0; h < 24; h++) {
    const active = busLaneOperating(h, cfg);
    const inbound = evaluateHour(counts.inbound[h], cfg, a, active, h);
    const outbound = evaluateHour(counts.outbound[h], cfg, a, active, h);

    const combined = {
      hour: h,
      busLaneActive: active,
      inbound,
      outbound,
      personHoursDelay: inbound.personHoursDelay + outbound.personHoursDelay,
      peopleMoved: inbound.peopleMoved + outbound.peopleMoved,
      co2Kg: inbound.co2Kg + outbound.co2Kg,
      worstVc: Math.max(inbound.vcRatio, outbound.vcRatio),
    };
    hours.push(combined);

    totals.personHoursDelay += combined.personHoursDelay;
    totals.peopleMoved += combined.peopleMoved;
    totals.co2Kg += combined.co2Kg;
    totals.carDemand += inbound.carDemand + outbound.carDemand;
    totals.busPassengers += inbound.busPassengers + outbound.busPassengers;
    if (combined.worstVc > 1) totals.hoursOverCapacity += 1;
  }

  return { hours, totals };
}

/**
 * Break-even search: with everything else held constant, how many passengers
 * per bus does the scheme need before it produces less total person-delay
 * than the comparison case?
 *
 * Returns null when the scheme wins at zero passengers (it is better on
 * delay regardless) or cannot win at a full bus.
 */
export function solveBreakEven(counts, schemeCfg, comparisonCfg, a) {
  // The load has to move on both sides of the comparison. Holding the
  // comparison's ridership fixed while varying the scheme's would answer a
  // different question, and a meaningless one.
  const scheme = (load) =>
    runDay(counts, { ...schemeCfg, busLoad: load }, a).totals.personHoursDelay;
  const comparison = (load) =>
    runDay(counts, { ...comparisonCfg, busLoad: load }, a).totals.personHoursDelay;
  const net = (load) => scheme(load) - comparison(load);

  const atZero = net(0);
  const atFull = net(a.busCapacity);

  if (atZero <= 0) {
    return { load: 0, alreadyWinning: true, impossible: false, atZero, atFull };
  }
  if (atFull > 0) {
    return { load: null, alreadyWinning: false, impossible: true, atZero, atFull };
  }

  let lo = 0;
  let hi = a.busCapacity;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (net(mid) > 0) lo = mid;
    else hi = mid;
  }
  return {
    load: hi,
    alreadyWinning: false,
    impossible: false,
    atZero,
    atFull,
    passengersPerHour: hi * (schemeCfg.busServiceOn ? schemeCfg.busesPerHour : 0),
  };
}

/** Difference between two day runs, scheme minus comparison. */
export function compareDays(scheme, comparison) {
  return {
    personHoursDelay: scheme.totals.personHoursDelay - comparison.totals.personHoursDelay,
    peopleMoved: scheme.totals.peopleMoved - comparison.totals.peopleMoved,
    co2Kg: scheme.totals.co2Kg - comparison.totals.co2Kg,
  };
}
