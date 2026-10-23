// Meteogram for a point forecast: wind (and gusts) plus the active layer over
// the whole forecast, with direction arrows. Used by the detail panel.

import { OVERLAYS } from './params.js';

const PAD = { l: 30, r: 34, t: 10, b: 18 };

export const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function path(times, values, x, y) {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v == null || Number.isNaN(v)) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

// Hourly series of an overlay at the point, in base units, with its own time axis.
export function seriesFor(f, def, name, now = Date.now()) {
  const air = def.src === 'air';
  const times = air ? f.airTimes : f.times;
  const raw = air ? f.air?.[name] : f.series[name];
  if (!times || !raw) return null;
  if (!def.accumulate) return { times, values: raw };
  const start = Math.max(0, Math.ceil((now - times[0]) / 3600000));
  let sum = 0;
  return { times, values: raw.map((v, i) => (i < start ? 0 : (sum += v ?? 0))) };
}

export function renderChart(f, { def, level, time, unitFor, nameFor, width = 330, height = 130 }) {
  const W = width;
  const H = height;
  const now = Date.now();
  const t0 = f.times[0];
  const t1 = f.times[f.times.length - 1];
  const x = (ms) => PAD.l + ((ms - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const windUnit = unitFor('speed');

  const speed = f.series[`wind_speed_${level.wind}`] || f.series.wind_speed_10m;
  const dir = f.series[`wind_direction_${level.wind}`] || f.series.wind_direction_10m;
  const gust = level.id === 'surface' ? f.series.wind_gusts_10m : null;
  const wVals = [...speed, ...(gust || [])].filter((v) => v != null).map(windUnit.f);
  const wMax = Math.max(1, ...wVals) * 1.1;
  const yW = (v) => H - PAD.b - (windUnit.f(v) / wMax) * (H - PAD.t - PAD.b);

  // Second series: the active layer, or temperature when the layer is wind.
  const second = def.id === 'wind' ? OVERLAYS.find((o) => o.id === 'temp') : def;
  const sec = seriesFor(f, second, nameFor(second), now);
  const secUnit = unitFor(second.kind);
  let secPath = '';
  let secAxis = '';
  if (sec) {
    const vals = sec.values.filter((v) => v != null).map(secUnit.f);
    if (vals.length) {
      let lo = Math.min(...vals);
      let hi = Math.max(...vals);
      if (hi - lo < 1e-6) hi = lo + 1;
      const pad = (hi - lo) * 0.08;
      lo -= pad;
      hi += pad;
      const yS = (v) => H - PAD.b - ((secUnit.f(v) - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
      secPath = `<path d="${path(sec.times, sec.values, x, yS)}" class="pf-temp"/>`;
      const fmt = (v) => (Math.abs(hi - lo) < 10 ? v.toFixed(1) : Math.round(v));
      secAxis = `<text x="${W - 2}" y="${PAD.t + 8}" text-anchor="end" class="pf-axis pf-axis-temp">${fmt(hi)}</text>
        <text x="${W - 2}" y="${H - PAD.b}" text-anchor="end" class="pf-axis pf-axis-temp">${fmt(lo)}</text>`;
    }
  }

  const days = (t1 - t0) / 86400000;
  const every = Math.max(1, Math.ceil((days * 52) / W));
  let grid = '';
  let dayN = 0;
  f.times.forEach((t) => {
    const d = new Date(t);
    if (d.getHours() !== 0) return;
    grid += `<line x1="${x(t)}" x2="${x(t)}" y1="${PAD.t}" y2="${H - PAD.b}" class="pf-day"/>`;
    if (dayN++ % every === 0) {
      grid += `<text x="${x(t) + 2}" y="${H - 5}" class="pf-axis">${esc(d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }))}</text>`;
    }
  });
  const marker = (ms, cls) => (ms >= t0 && ms <= t1 ? `<line x1="${x(ms)}" x2="${x(ms)}" y1="${PAD.t}" y2="${H - PAD.b}" class="${cls}"/>` : '');

  const area = `${path(f.times, speed, x, yW)}L${x(t1)},${H - PAD.b}L${x(t0)},${H - PAD.b}Z`;
  let arrows = '';
  const arrowStep = Math.max(3, Math.ceil((f.times.length * 14) / W));
  for (let i = 0; i < f.times.length; i += arrowStep) {
    if (dir[i] == null) continue;
    // Arrow points where the wind is blowing TO.
    arrows += `<g transform="translate(${x(f.times[i])},9) rotate(${dir[i] + 180})"><path d="M0,-6 L3.5,3 L0,1 L-3.5,3Z" class="pf-arrow"/></g>`;
  }

  return `
    <svg viewBox="0 0 ${W} 18" class="pf-arrows" preserveAspectRatio="none">${arrows}</svg>
    <svg viewBox="0 0 ${W} ${H}" class="pf-chart">
      ${grid}
      <path d="${area}" class="pf-wind-area"/>
      <path d="${path(f.times, speed, x, yW)}" class="pf-wind"/>
      ${gust ? `<path d="${path(f.times, gust, x, yW)}" class="pf-gust"/>` : ''}
      ${secPath}
      ${marker(now, 'pf-now')}
      ${marker(time, 'pf-sel')}
      <text x="2" y="${PAD.t + 8}" class="pf-axis pf-axis-wind">${Math.round(wMax)}</text>
      <text x="2" y="${H - PAD.b}" class="pf-axis pf-axis-wind">0</text>
      ${secAxis}
    </svg>
    <div class="pf-key">
      <span class="k-wind">Wind at ${esc(level.label)} (${esc(windUnit.id)})</span>
      ${gust ? '<span class="k-gust">Gusts</span>' : ''}
      <span class="k-temp">${esc(second.label)}${secUnit.id ? ` (${esc(secUnit.id)})` : ''}</span>
    </div>`;
}
