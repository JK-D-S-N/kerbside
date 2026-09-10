/** Scenario presets, the default configuration, and the source list. */
import { DEFAULT_ASSUMPTIONS } from './model.js';

export const DEFAULT_CONFIG = {
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

/**
 * The comparison case. Every headline number in the UI is a difference
 * between the scenario and this.
 */
export const COMPARISON = { ...DEFAULT_CONFIG, busLaneOn: false };

export const PRESETS = [
  {
    id: 'as-built',
    name: 'As built',
    detail: 'Bus lane 07:00 to 19:00, Monday to Saturday. What is on the ground today.',
    config: {
      busLaneOn: true, busLanePeakOnly: false, busLaneStart: 7, busLaneEnd: 19,
      bikeLaneOn: false, busesPerHour: 10, busLoad: 40,
    },
  },
  {
    id: 'peak-only',
    name: 'Peak only',
    detail: 'Bus lane 07:00 to 10:00 and 16:00 to 19:00. Two lanes for general traffic the rest of the day.',
    config: {
      busLaneOn: true, busLanePeakOnly: true,
      bikeLaneOn: false, busesPerHour: 10, busLoad: 40,
    },
  },
  {
    id: 'no-lane',
    name: 'No bus lane',
    detail: 'Two general traffic lanes all day. Buses run in traffic and lose patronage.',
    config: {
      busLaneOn: false, busLanePeakOnly: false,
      bikeLaneOn: false, busesPerHour: 10, busLoad: 40,
    },
  },
  {
    // The break-even solver says an all-day lane cannot pay for itself at ten
    // buses an hour, at any load. This preset is the answer to "then what
    // would?", so it sets the service level rather than asserting the number.
    id: 'what-it-takes',
    name: 'What it would take',
    detail: 'Bus lane 07:00 to 19:00, a Glider every three to four minutes at peak, 85 aboard at the busiest hour. Roughly the point where the lane stops costing time.',
    config: {
      busLaneOn: true, busLanePeakOnly: false, busLaneStart: 7, busLaneEnd: 19,
      bikeLaneOn: false, busesPerHour: 18, busLoad: 85,
    },
  },
];

/** Everything the tool asserts, and where it came from. */
export const SOURCES = [
  {
    claim: 'Hourly traffic volumes, both directions, by lane, 2023 weekday average.',
    detail:
      'DfI count point 921 (inbound, Stormont entrance) and 918 (outbound, opposite Summerhill Avenue). ' +
      'Weekday average of hourly flows for the full year 2023.',
    source: 'Northern Ireland Traffic Count Data 2023, Department for Infrastructure',
    url: 'https://www.opendatani.gov.uk/dataset/northern-ireland-traffic-count-data',
  },
  {
    claim: 'Bus lane operates 07:00 to 19:00, Monday to Saturday.',
    detail:
      'Announced 12 January 2017, effective Monday 23 January 2017. It replaced a 24-hour bus lane, ' +
      'so the 2017 change gave general traffic more access to the nearside lane, not less. ' +
      'Buses, cycles, motorcycles and public hire taxis may use it during operating hours.',
    source: 'DfI news release, "Hazzard announces bus lane changes"',
    url: 'https://www.infrastructure-ni.gov.uk/news/hazzard-announces-bus-lane-changes-24-hour-12-hour',
  },
  {
    claim: 'Glider vehicle capacity of 105 passengers.',
    detail:
      '18 metre Van Hool Exqui.City diesel-electric hybrid articulated vehicles, 105 passengers ' +
      'including 63 standing. G1 runs Dundonald park and ride to the city centre and on to west Belfast, ' +
      'every 7 to 9 minutes, tightening to 4 to 6 minutes at peak.',
    source: 'Translink / DfI Belfast Rapid Transit, and routeone',
    url: 'https://www.infrastructure-ni.gov.uk/articles/belfast-rapid-transit-glider-background',
  },
  {
    claim: 'Saturation flow of 1,800 pcu per hour per lane.',
    detail:
      'Standard urban design value, used here as an editable default rather than a measured local figure. ' +
      'No published saturation flow survey for this corridor was found.',
    source: 'Conventional UK highway design value',
    url: null,
  },
  {
    claim: 'Car CO2 of 170 g/km at 31 mph, rising as speed falls.',
    detail:
      'The level is set to the UK average car figure; the shape of the speed curve is COPERT-like and ' +
      'illustrative. Both the level and the curve coefficients are editable.',
    source: 'Illustrative, calibrated to the UK average car emission factor',
    url: null,
  },
];

/** Things the model deliberately does not do. Shown in the UI, not buried. */
export const LIMITATIONS = [
  'One corridor in isolation. Traffic that reroutes onto side streets to avoid this road is not modelled, and on this corridor that is a real effect.',
  'No published journey time data exists for this link, so the delay curve is calibrated against throughput only. It reproduces the observed peak flow; it has not been checked against observed travel times.',
  'Demand is fixed at the observed 2023 profile and scaled by a multiplier. There is no elasticity: the model does not let people give up a trip because it got slower.',
  'Bus patronage responds to the bus lane through one editable assumption, not a demand model.',
  'Buses per hour and passengers per bus are both set at the peak, and the day is shaped from published Glider headways and a commuter loading curve. Neither is a timetable or a patronage survey.',
  'No turning count is published for Rosepark, Rosemount Avenue or Summerhill Avenue. The turning shares are assumptions. What the counts do fix is the net: the two count points either end of the section report the same flow to within a quarter of one per cent, so the side roads are modelled as giving back exactly what they take.',
  'Turning is in the simulation, not in the analytic model. The delay a right turner causes is visible in the picture and is not in the headline numbers.',
  'Vehicle emissions are modelled from average link speed. Real stop-start emissions depend on the number of stops, not just the mean.',
];

export const ASSUMPTION_FIELDS = [
  { key: 'saturationFlow', label: 'Saturation flow', unit: 'pcu/hr/lane', min: 1200, max: 2200, step: 25 },
  { key: 'greenFraction', label: 'Effective green', unit: 'of cycle', min: 0.3, max: 0.85, step: 0.01 },
  { key: 'junctionsOnLink', label: 'Signalised junctions', unit: 'on the link', min: 1, max: 10, step: 1 },
  { key: 'cycleTimeSec', label: 'Signal cycle', unit: 'sec', min: 45, max: 140, step: 5 },
  { key: 'linkLengthKm', label: 'Link length', unit: 'km', min: 0.5, max: 4, step: 0.1 },
  // NI roads are signed in mph. `scale` converts the displayed value to the
  // model unit (kph), so the model keeps one internal unit throughout.
  { key: 'freeFlowSpeedKph', label: 'Free-flow speed', unit: 'mph', min: 15, max: 40, step: 1, scale: 1.609344 },
  { key: 'carOccupancy', label: 'Car occupancy', unit: 'people/car', min: 1, max: 2.5, step: 0.05 },
  { key: 'busDwellMinutes', label: 'Bus dwell on link', unit: 'min', min: 0, max: 5, step: 0.1 },
  { key: 'carAbstractionRate', label: 'Bus riders who would drive', unit: 'share', min: 0, max: 1, step: 0.05 },
  { key: 'ridershipLossWithoutLane', label: 'Patronage lost with no lane', unit: 'share', min: 0, max: 0.8, step: 0.05 },
  { key: 'busEmissionsPerKm', label: 'Bus CO2', unit: 'g/km', min: 0, max: 2000, step: 50 },
  // Turning movements. No published turning count exists for these junctions,
  // so these two are the most assumed numbers in the tool and belong in front
  // of the user rather than in the source.
  { key: 'leftTurnShare', label: 'Left turns off, per junction', unit: 'share', min: 0, max: 0.15, step: 0.01 },
  { key: 'rightTurnShare', label: 'Right turns off, per junction', unit: 'share', min: 0, max: 0.15, step: 0.01 },
];

export { DEFAULT_ASSUMPTIONS };
