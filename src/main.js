import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { buildScene, applyTimeOfDay } from './scene.js';
import { TrafficSim } from './vehicles.js';
import { COUNTS } from './counts.js';
import {
  DEFAULT_ASSUMPTIONS, runDay, solveBreakEven, busLaneOperating, evaluateHour,
} from './model.js';
import {
  DEFAULT_CONFIG, PRESETS, SOURCES, LIMITATIONS, ASSUMPTION_FIELDS,
} from './scenarios.js';
import { DelayChart, renderTable } from './chart.js';

/** Sim runs faster than real time so a signal cycle is watchable. */
const SIM_SPEED = 3;

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) =>
  Number(n).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  config: { ...DEFAULT_CONFIG },
  assumptions: { ...DEFAULT_ASSUMPTIONS },
  hour: 8,
  playing: false,
  preset: 'as-built',
  results: null,
};

const counts = {
  inbound: COUNTS.inbound.weekday.total,
  outbound: COUNTS.outbound.weekday.total,
};

/** The do-nothing case: no reallocation of any kind, everything else equal. */
const comparisonConfig = () => ({ ...state.config, busLaneOn: false, bikeLaneOn: false });

// ---------------------------------------------------------------------------
// Three.js
// ---------------------------------------------------------------------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.5, 1600);
camera.position.set(62, 78, 84);

const world = buildScene(renderer);
const sim = new TrafficSim(world.group);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 0, -8);
controls.maxPolarAngle = 1.25;
controls.minDistance = 22;
controls.maxDistance = 340;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.18;
controls.update();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(world.scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight), 0.62, 0.7, 0.82
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.resolution.set(w, h);
  chart.draw();
}
window.addEventListener('resize', onResize);

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------
const chart = new DelayChart($('chartWrap'), $('chartTooltip'));
chart.onHover = () => {};

// ---------------------------------------------------------------------------
// Compute and paint
// ---------------------------------------------------------------------------
function recompute() {
  const cfg = state.config;
  const a = state.assumptions;
  const cmpCfg = comparisonConfig();

  const scheme = runDay(counts, cfg, a);
  const baseline = runDay(counts, cmpCfg, a);
  const breakEven = solveBreakEven(counts, cfg, cmpCfg, a);

  state.results = { scheme, baseline, breakEven };

  paintKpis(scheme, baseline);
  paintVerdict(breakEven, scheme, baseline);
  paintChart(scheme, baseline);
  paintTime();
  syncSim();
}

function paintKpis(scheme, baseline) {
  const h = state.hour;
  const hourScheme = scheme.hours[h];
  const hourBase = baseline.hours[h];
  const worstDir = hourScheme.inbound.carMin >= hourScheme.outbound.carMin ? 'inbound' : 'outbound';
  const carNow = hourScheme[worstDir].carMin;
  const carBase = hourBase[worstDir].carMin;

  const cards = [
    {
      label: 'People moved',
      sub: 'per day, both ways',
      value: fmt(scheme.totals.peopleMoved),
      unit: '',
      delta: scheme.totals.peopleMoved - baseline.totals.peopleMoved,
      deltaFmt: (d) => `${d >= 0 ? '+' : ''}${fmt(d)}`,
      betterIsUp: true,
    },
    {
      label: `Car journey, ${String(h).padStart(2, '0')}:00`,
      sub: `${worstDir}, ${state.assumptions.linkLengthKm} km`,
      value: fmt(carNow, 1),
      unit: 'min',
      delta: carNow - carBase,
      deltaFmt: (d) => `${d >= 0 ? '+' : ''}${fmt(d, 1)} min`,
      betterIsUp: false,
    },
    {
      label: 'Delay',
      sub: 'person-hours per day',
      value: fmt(scheme.totals.personHoursDelay),
      unit: 'hr',
      delta: scheme.totals.personHoursDelay - baseline.totals.personHoursDelay,
      deltaFmt: (d) => `${d >= 0 ? '+' : ''}${fmt(d)} hr`,
      betterIsUp: false,
    },
    {
      label: 'CO₂',
      sub: 'kg per day',
      value: fmt(scheme.totals.co2Kg),
      unit: 'kg',
      delta: scheme.totals.co2Kg - baseline.totals.co2Kg,
      deltaFmt: (d) => `${d >= 0 ? '+' : ''}${fmt(d)} kg`,
      betterIsUp: false,
    },
  ];

  $('kpis').innerHTML = cards
    .map((c) => {
      const flat = Math.abs(c.delta) < (c.betterIsUp ? 1 : 0.05);
      const good = c.betterIsUp ? c.delta > 0 : c.delta < 0;
      const cls = flat ? 'flat' : good ? 'better' : 'worse';
      const arrow = flat ? '' : good ? '▼ ' : '▲ ';
      const arrowShown = flat ? '' : (c.betterIsUp ? (c.delta > 0 ? '▲ ' : '▼ ') : arrow);
      return `<div class="kpi">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value}${c.unit ? ` <span class="unit">${c.unit}</span>` : ''}</div>
        <div class="kpi-delta ${cls}">${arrowShown}${flat ? 'no change' : c.deltaFmt(c.delta)}<span style="color:var(--ink-3);font-weight:400"> vs baseline</span></div>
      </div>`;
    })
    .join('');
}

function paintVerdict(be, scheme, baseline) {
  const card = $('verdict');
  const figure = $('verdictFigure');
  const body = $('verdictBody');
  const cfg = state.config;
  const cap = state.assumptions.busCapacity;
  card.classList.remove('is-winning', 'is-impossible');

  const delayDelta = scheme.totals.personHoursDelay - baseline.totals.personHoursDelay;
  const peopleDelta = scheme.totals.peopleMoved - baseline.totals.peopleMoved;

  if (!cfg.busLaneOn) {
    figure.innerHTML = 'No lane';
    body.innerHTML =
      'This is the do-nothing case. Turn the bus lane on to see what it costs and what it buys.';
    return;
  }

  if (be.impossible) {
    card.classList.add('is-impossible');
    figure.innerHTML = 'Never';
    body.innerHTML =
      `Even at a full ${cap}-passenger Glider on every service, this lane costs more person-time than it saves. ` +
      `At these settings the bus is not carrying enough people to be worth a lane.`;
    return;
  }

  if (be.alreadyWinning) {
    card.classList.add('is-winning');
    figure.innerHTML = 'Already worth it';
    body.innerHTML =
      `The scheme beats doing nothing on total person-delay at any load, and moves ` +
      `<b>${fmt(peopleDelta)}</b> more people a day.`;
    return;
  }

  const perHour = be.load * (cfg.busServiceOn ? cfg.busesPerHour : 0);
  const pct = Math.round((be.load / cap) * 100);
  const current = cfg.busLoad;
  const verdictWord = current >= be.load ? 'clears' : 'misses';

  figure.innerHTML = `${fmt(be.load, 0)} <span class="unit">passengers per bus</span>`;
  body.innerHTML =
    `That is <b>${pct}%</b> of a ${cap}-seat Glider, or <b>${fmt(perHour)}</b> people an hour each way, ` +
    `before this lane saves more person-time than it costs. ` +
    `You are modelling <b>${current}</b>, which ${verdictWord} it` +
    (current >= be.load
      ? `, saving <b>${fmt(Math.abs(delayDelta))}</b> person-hours a day.`
      : ` by <b>${fmt(be.load - current, 0)}</b>. As modelled the lane costs <b>${fmt(delayDelta)}</b> person-hours a day and moves <b>${fmt(peopleDelta)}</b> more people.`);
}

function paintChart(scheme, baseline) {
  const s = scheme.hours.map((h) => h.personHoursDelay);
  const b = baseline.hours.map((h) => h.personHoursDelay);
  const active = scheme.hours.map((h) => h.busLaneActive);
  chart.update(s, b, active, state.hour);
  renderTable($('tableBody'), s, b, active);
}

function paintTime() {
  const h = state.hour;
  $('hourLabel').textContent = `${String(h).padStart(2, '0')}:00`;
  const on = busLaneOperating(h, state.config);
  const el = $('laneState');
  el.textContent = on ? 'bus lane on' : 'bus lane off';
  el.classList.toggle('on', on);
  $('hour').value = h;

  // Operating-hours band under the scrubber.
  const ticks = $('timeTicks');
  ticks.innerHTML = '';
  for (const hr of [0, 6, 12, 18, 23]) {
    const s = document.createElement('span');
    s.textContent = String(hr).padStart(2, '0');
    s.style.left = `${(hr / 23) * 100}%`;
    ticks.appendChild(s);
  }
  let start = null;
  for (let i = 0; i <= 24; i++) {
    const active = i < 24 && busLaneOperating(i, state.config);
    if (active && start === null) start = i;
    if (!active && start !== null) {
      const band = document.createElement('div');
      band.className = 'band';
      band.style.left = `${(start / 23) * 100}%`;
      band.style.width = `${((i - start) / 23) * 100}%`;
      ticks.appendChild(band);
      start = null;
    }
  }
}

/** Push the current hour's modelled state into the 3D simulation. */
let lastSimKey = null;
function syncSim() {
  const cfg = state.config;
  const a = state.assumptions;
  const h = state.hour;
  const active = busLaneOperating(h, cfg);

  // Reseed the road when the hour or the layout changes. Continuous drags of
  // other sliders let the simulation converge instead of jumping.
  const simKey = `${h}|${active}|${cfg.bikeLaneOn}|${cfg.totalLanes}|${cfg.busServiceOn}`;
  const resetDensity = simKey !== lastSimKey;
  lastSimKey = simKey;

  const inbound = evaluateHour(counts.inbound[h], cfg, a, active);
  const outbound = evaluateHour(counts.outbound[h], cfg, a, active);

  sim.configure({
    busLaneActive: active,
    bikeLaneOn: cfg.bikeLaneOn,
    cycleTimeSec: a.cycleTimeSec,
    greenFraction: a.greenFraction,
    freeFlowMs: a.freeFlowSpeedKph / 3.6,
    busesPerHour: cfg.busServiceOn ? cfg.busesPerHour : 0,
    demand: { inbound: inbound.carDemand, outbound: outbound.carDemand },
    resetDensity,
  });

  for (const strip of world.busLanes) strip.material.opacity = active ? 0.2 : 0;
  for (const strip of world.cycleLanes) strip.material.opacity = cfg.bikeLaneOn ? 0.17 : 0;

  $('laneWarn').hidden = !(inbound.lanesClamped || outbound.lanesClamped);

  state.hourDetail = { inbound, outbound, active };
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function buildPresets() {
  const wrap = $('presets');
  wrap.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset' + (p.id === state.preset ? ' active' : '');
    b.textContent = p.name;
    b.addEventListener('click', () => {
      state.preset = p.id;
      Object.assign(state.config, p.config);
      syncControlsFromState();
      buildPresets();
      $('presetDetail').textContent = p.detail;
      recompute();
    });
    wrap.appendChild(b);
  }
  const active = PRESETS.find((p) => p.id === state.preset);
  $('presetDetail').textContent = active ? active.detail : '';
}

/** Mark the preset as custom once the user diverges from it. */
function clearPreset() {
  if (state.preset === null) return;
  const p = PRESETS.find((x) => x.id === state.preset);
  if (!p) return;
  const matches = Object.entries(p.config).every(([k, v]) => {
    const cur = state.config[k];
    return Array.isArray(v) ? JSON.stringify(cur) === JSON.stringify(v) : cur === v;
  });
  if (!matches) {
    state.preset = null;
    buildPresets();
    $('presetDetail').textContent = 'Custom scenario.';
  }
}

function syncControlsFromState() {
  const c = state.config;
  $('busLaneOn').checked = c.busLaneOn;
  $('busLanePeakOnly').checked = c.busLanePeakOnly;
  $('bikeLaneOn').checked = c.bikeLaneOn;
  $('busServiceOn').checked = c.busServiceOn;
  $('busLaneStart').value = c.busLaneStart;
  $('busLaneEnd').value = c.busLaneEnd;
  $('totalLanes').value = c.totalLanes;
  $('demandMultiplier').value = c.demandMultiplier;
  $('busesPerHour').value = c.busesPerHour;
  $('busLoad').value = c.busLoad;
  syncOutputs();
}

function syncOutputs() {
  const c = state.config;
  $('busLaneStartOut').textContent = `${String(c.busLaneStart).padStart(2, '0')}:00`;
  $('busLaneEndOut').textContent = `${String(c.busLaneEnd).padStart(2, '0')}:00`;
  $('totalLanesOut').textContent = c.totalLanes;
  $('demandOut').textContent = `${Math.round(c.demandMultiplier * 100)}%`;
  $('busesOut').textContent = c.busesPerHour;
  $('loadOut').textContent = c.busLoad;
  const cap = state.assumptions.busCapacity;
  const pct = Math.round((c.busLoad / cap) * 100);
  $('capacityFill').style.width = `${pct}%`;
  $('capacityHint').textContent =
    `${pct}% of a ${cap}-seat Glider. ${fmt(c.busLoad * c.busesPerHour)} passengers an hour each way.`;
  $('laneHours').classList.toggle('disabled', c.busLanePeakOnly || !c.busLaneOn);
}

function bindToggle(id, key) {
  $(id).addEventListener('change', (e) => {
    state.config[key] = e.target.checked;
    clearPreset();
    syncOutputs();
    recompute();
  });
}

function bindRange(id, key, transform = Number) {
  $(id).addEventListener('input', (e) => {
    state.config[key] = transform(e.target.value);
    // Keep the operating window coherent.
    if (key === 'busLaneStart' && state.config.busLaneStart >= state.config.busLaneEnd) {
      state.config.busLaneEnd = Math.min(24, state.config.busLaneStart + 1);
      $('busLaneEnd').value = state.config.busLaneEnd;
    }
    if (key === 'busLaneEnd' && state.config.busLaneEnd <= state.config.busLaneStart) {
      state.config.busLaneStart = Math.max(0, state.config.busLaneEnd - 1);
      $('busLaneStart').value = state.config.busLaneStart;
    }
    clearPreset();
    syncOutputs();
    recompute();
  });
}

bindToggle('busLaneOn', 'busLaneOn');
bindToggle('busLanePeakOnly', 'busLanePeakOnly');
bindToggle('bikeLaneOn', 'bikeLaneOn');
bindToggle('busServiceOn', 'busServiceOn');
bindRange('busLaneStart', 'busLaneStart');
bindRange('busLaneEnd', 'busLaneEnd');
bindRange('totalLanes', 'totalLanes');
bindRange('demandMultiplier', 'demandMultiplier');
bindRange('busesPerHour', 'busesPerHour');
bindRange('busLoad', 'busLoad');

$('hour').addEventListener('input', (e) => {
  state.hour = Number(e.target.value);
  stopPlaying();
  recompute();
});

// ---- Assumptions ----------------------------------------------------------
function buildAssumptions() {
  const wrap = $('assumptions');
  wrap.innerHTML = '';
  for (const f of ASSUMPTION_FIELDS) {
    const row = document.createElement('div');
    row.className = 'assume-row';
    // A field may be shown in a different unit from the one the model uses.
    // `scale` is the display-to-model factor; min/max/step are in display units.
    const scale = f.scale || 1;
    const shown = state.assumptions[f.key] / scale;
    const dp = f.step < 1 ? 2 : 0;
    row.innerHTML = `
      <label for="a_${f.key}">${f.label}
        <output id="o_${f.key}">${fmt(shown, dp)}<span class="u">${f.unit}</span></output>
      </label>
      <input type="range" id="a_${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${shown.toFixed(dp)}" />`;
    wrap.appendChild(row);
    row.querySelector('input').addEventListener('input', (e) => {
      const display = Number(e.target.value);
      state.assumptions[f.key] = display * scale;
      $(`o_${f.key}`).innerHTML = `${fmt(display, dp)}<span class="u">${f.unit}</span>`;
      row.classList.toggle('changed', Math.abs(state.assumptions[f.key] - DEFAULT_ASSUMPTIONS[f.key]) > 1e-9);
      recompute();
    });
  }
}
$('resetAssumptions').addEventListener('click', () => {
  state.assumptions = { ...DEFAULT_ASSUMPTIONS };
  buildAssumptions();
  syncOutputs();
  recompute();
});

// ---- Sources and limitations ---------------------------------------------
$('sources').innerHTML = SOURCES.map(
  (s) => `<div class="source-item">
    <span class="claim">${s.claim}</span>
    <span class="detail">${s.detail}</span>
    ${s.url ? `<a href="${s.url}" target="_blank" rel="noopener">${s.source}</a>` : `<span class="cite">${s.source}</span>`}
  </div>`
).join('');
$('limitations').innerHTML = LIMITATIONS.map((l) => `<li>${l}</li>`).join('');

// ---- Finding panel --------------------------------------------------------
$('findingToggle').addEventListener('click', () => {
  const open = !$('finding').hidden;
  $('finding').hidden = open;
  $('findingToggle').setAttribute('aria-expanded', String(!open));
  $('findingToggle').hidden = !open;
});
$('findingClose').addEventListener('click', () => {
  $('finding').hidden = true;
  $('findingToggle').hidden = false;
  $('findingToggle').setAttribute('aria-expanded', 'false');
});

// ---- Table toggle ---------------------------------------------------------
$('tableBtn').addEventListener('click', () => {
  const showing = $('tableWrap').hidden;
  $('tableWrap').hidden = !showing;
  $('chartWrap').hidden = showing;
  $('tableBtn').setAttribute('aria-pressed', String(showing));
  if (!showing) chart.draw();
});

// ---- Play -----------------------------------------------------------------
let playTimer = null;
function startPlaying() {
  if (playTimer) return;
  state.playing = true;
  $('playBtn').classList.add('playing');
  playTimer = setInterval(() => {
    state.hour = (state.hour + 1) % 24;
    recompute();
  }, 1700);
}
function stopPlaying() {
  state.playing = false;
  $('playBtn').classList.remove('playing');
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
}
$('playBtn').addEventListener('click', () => (state.playing ? stopPlaying() : startPlaying()));

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let nightFactor = 0;
let frames = 0;
let fpsAccum = 0;
let fps = 0;

function animate() {
  requestAnimationFrame(animate);
  const raw = clock.getDelta();
  const dt = Math.min(0.05, raw);

  sim.step(dt * SIM_SPEED);
  const simStats = sim.render(nightFactor);

  const tod = applyTimeOfDay(world, state.hour, renderer);
  nightFactor = tod.lamp;

  // Signal heads follow the same cycle the model uses.
  for (const dir of ['inbound', 'outbound']) {
    const green = sim.isGreen(dir);
    const s = world.signals[dir];
    s.red.material.color.setHex(green ? 0x3a1414 : 0xd03b3b);
    s.green.material.color.setHex(green ? 0x0ca30c : 0x0e2a0e);
  }

  controls.update();
  composer.render();

  fpsAccum += raw;
  frames++;
  if (fpsAccum > 0.5) {
    fps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
    paintHud(simStats);
  }
}

function paintHud(stats) {
  const d = state.hourDetail;
  if (!d) return;
  const vc = Math.max(d.inbound.vcRatio, d.outbound.vcRatio);
  $('hud').innerHTML =
    `<b>${stats.onRoad}</b> vehicles on the section` +
    `<span class="sepdot">·</span><b>${fmt(stats.avgSpeedKph / 1.609344)}</b> mph simulated` +
    `<span class="sepdot">·</span>v/c <b>${vc.toFixed(2)}</b>` +
    `<span class="sepdot">·</span>${SIM_SPEED}× speed` +
    `<span class="sepdot">·</span>${fps} fps`;
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
buildPresets();
buildAssumptions();
syncControlsFromState();
recompute();
animate();

requestAnimationFrame(() => {
  setTimeout(() => {
    $('loading').classList.add('gone');
    setTimeout(() => ($('loading').style.display = 'none'), 600);
  }, 350);
});
