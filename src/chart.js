/**
 * 24-hour delay profile: scenario against the comparison case.
 *
 * Two series on a dark surface, drawn as thin lines with direct labels, a
 * crosshair and a tooltip. Palette validated for the dark surface
 * (#16181d): blue #3987e5 and orange #d95926, adjacent-pair CVD dE 26.8,
 * normal-vision dE 31.8, both clear of the floors.
 */

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

const PAD = { top: 18, right: 58, bottom: 26, left: 42 };

export class DelayChart {
  constructor(root, tooltip) {
    this.root = root;
    this.tooltip = tooltip;
    this.svg = el('svg', { class: 'chart-svg', preserveAspectRatio: 'none' });
    this.root.appendChild(this.svg);
    this.data = null;
    this.hoverHour = null;
    this.onHover = null;

    this.svg.addEventListener('pointermove', (e) => this.handleMove(e));
    this.svg.addEventListener('pointerleave', () => this.clearHover());
  }

  /**
   * @param {number[]} scenario  person-hours of delay by hour
   * @param {number[]} comparison
   * @param {boolean[]} laneActive  whether the bus lane operates in that hour
   * @param {number} currentHour
   */
  update(scenario, comparison, laneActive, currentHour) {
    this.data = { scenario, comparison, laneActive, currentHour };
    this.draw();
  }

  size() {
    const r = this.root.getBoundingClientRect();
    return { w: Math.max(280, r.width), h: Math.max(150, r.height) };
  }

  draw() {
    if (!this.data) return;
    const { scenario, comparison, laneActive, currentHour } = this.data;
    const { w, h } = this.size();
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.setAttribute('width', w);
    this.svg.setAttribute('height', h);
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

    const plotW = w - PAD.left - PAD.right;
    const plotH = h - PAD.top - PAD.bottom;
    const rawMax = Math.max(1, ...scenario, ...comparison) * 1.12;
    const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
    const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= rawMax / 4) * mag;
    const maxY = step * 4;

    const X = (hr) => PAD.left + (hr / 23) * plotW;
    const Y = (v) => PAD.top + plotH - (v / maxY) * plotH;

    // Bus lane operating hours, as a recessive band behind everything.
    let bandStart = null;
    for (let i = 0; i <= 24; i++) {
      const on = i < 24 && laneActive[i];
      if (on && bandStart === null) bandStart = i;
      if (!on && bandStart !== null) {
        this.svg.appendChild(el('rect', {
          x: X(bandStart), y: PAD.top,
          width: Math.max(1, X(i - 1) - X(bandStart)), height: plotH,
          fill: 'rgba(217, 89, 38, 0.10)',
        }));
        bandStart = null;
      }
    }

    // Gridlines and y labels.
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (maxY / ticks) * i;
      const y = Y(v);
      this.svg.appendChild(el('line', {
        x1: PAD.left, x2: PAD.left + plotW, y1: y, y2: y,
        stroke: 'rgba(255,255,255,0.07)', 'stroke-width': 1,
      }));
      const t = el('text', {
        x: PAD.left - 8, y: y + 3.5, 'text-anchor': 'end', class: 'chart-axis',
      });
      t.textContent = v >= 100 ? Math.round(v) : v.toFixed(0);
      this.svg.appendChild(t);
    }

    // x labels every four hours.
    for (let hr = 0; hr <= 23; hr += 4) {
      const t = el('text', {
        x: X(hr), y: h - 8, 'text-anchor': 'middle', class: 'chart-axis',
      });
      t.textContent = String(hr).padStart(2, '0');
      this.svg.appendChild(t);
    }

    const path = (vals) =>
      vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');

    this.svg.appendChild(el('path', {
      d: path(comparison), fill: 'none', stroke: '#3987e5',
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    this.svg.appendChild(el('path', {
      d: path(scenario), fill: 'none', stroke: '#d95926',
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    // Direct labels at the right-hand end, so identity is never colour alone.
    const lastS = scenario[23];
    const lastC = comparison[23];
    const apart = Math.abs(Y(lastS) - Y(lastC)) < 12;
    const labS = el('text', {
      x: PAD.left + plotW + 6, y: Y(lastS) + (apart && lastS < lastC ? -4 : 3.5), class: 'chart-label',
    });
    labS.textContent = 'Scenario';
    labS.setAttribute('fill', '#d95926');
    const labC = el('text', {
      x: PAD.left + plotW + 6, y: Y(lastC) + (apart && lastC <= lastS ? 10 : 3.5), class: 'chart-label',
    });
    labC.textContent = 'Baseline';
    labC.setAttribute('fill', '#3987e5');
    this.svg.appendChild(labS);
    this.svg.appendChild(labC);

    // The hour currently shown in 3D.
    if (currentHour != null) {
      this.svg.appendChild(el('line', {
        x1: X(currentHour), x2: X(currentHour), y1: PAD.top, y2: PAD.top + plotH,
        stroke: 'rgba(255,255,255,0.30)', 'stroke-width': 1, 'stroke-dasharray': '3 3',
      }));
    }

    // Crosshair on hover.
    if (this.hoverHour != null) {
      const hr = this.hoverHour;
      this.svg.appendChild(el('line', {
        x1: X(hr), x2: X(hr), y1: PAD.top, y2: PAD.top + plotH,
        stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 1,
      }));
      for (const [vals, colour] of [[comparison, '#3987e5'], [scenario, '#d95926']]) {
        this.svg.appendChild(el('circle', {
          cx: X(hr), cy: Y(vals[hr]), r: 4.5, fill: colour,
          stroke: '#16181d', 'stroke-width': 2,
        }));
      }
    }

    this._X = X;
    this._plot = { plotW, plotH };
  }

  handleMove(e) {
    if (!this.data) return;
    const rect = this.svg.getBoundingClientRect();
    const { w } = this.size();
    const x = ((e.clientX - rect.left) / rect.width) * w;
    const plotW = w - PAD.left - PAD.right;
    const hr = Math.round(((x - PAD.left) / plotW) * 23);
    if (hr < 0 || hr > 23) return this.clearHover();
    if (hr !== this.hoverHour) {
      this.hoverHour = hr;
      this.draw();
    }
    this.showTooltip(e, hr);
    if (this.onHover) this.onHover(hr);
  }

  showTooltip(e, hr) {
    const { scenario, comparison, laneActive } = this.data;
    const diff = scenario[hr] - comparison[hr];
    const sign = diff >= 0 ? '+' : '';
    this.tooltip.innerHTML = `
      <div class="tt-hour">${String(hr).padStart(2, '0')}:00${laneActive[hr] ? ' <span class="tt-flag">bus lane on</span>' : ''}</div>
      <div class="tt-row"><span class="tt-dot" style="background:#d95926"></span>Scenario<b>${scenario[hr].toFixed(1)}</b></div>
      <div class="tt-row"><span class="tt-dot" style="background:#3987e5"></span>Baseline<b>${comparison[hr].toFixed(1)}</b></div>
      <div class="tt-diff ${diff > 0 ? 'worse' : diff < 0 ? 'better' : ''}">${sign}${diff.toFixed(1)} person-hours</div>`;
    this.tooltip.hidden = false;
    const host = this.root.getBoundingClientRect();
    const tw = this.tooltip.offsetWidth;
    let left = e.clientX - host.left + 12;
    if (left + tw > host.width) left = e.clientX - host.left - tw - 12;
    this.tooltip.style.left = `${Math.max(0, left)}px`;
    this.tooltip.style.top = `${Math.max(0, e.clientY - host.top - 10)}px`;
  }

  clearHover() {
    if (this.hoverHour !== null) {
      this.hoverHour = null;
      this.draw();
    }
    this.tooltip.hidden = true;
  }
}

/** The table view. Identity never depends on colour alone. */
export function renderTable(tbody, scenario, comparison, laneActive) {
  tbody.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const tr = document.createElement('tr');
    const diff = scenario[h] - comparison[h];
    tr.innerHTML = `
      <td>${String(h).padStart(2, '0')}:00</td>
      <td>${laneActive[h] ? 'Yes' : 'No'}</td>
      <td class="num">${scenario[h].toFixed(1)}</td>
      <td class="num">${comparison[h].toFixed(1)}</td>
      <td class="num ${diff > 0.05 ? 'worse' : diff < -0.05 ? 'better' : ''}">${diff >= 0 ? '+' : ''}${diff.toFixed(1)}</td>`;
    tbody.appendChild(tr);
  }
}
