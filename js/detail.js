// Point-forecast panel shown under the timeline (Windy-style): a table with a
// column every 3 hours grouped by day, one tab per parameter group, plus a
// meteogram tab.

import { colorAt } from './colors.js';
import { findOverlay } from './params.js';
import { compass } from './field.js';
import { esc, renderChart } from './forecast.js';

export const TABS = [
  { id: 'basic', label: 'Basic' },
  { id: 'wind', label: 'Wind' },
  { id: 'rain', label: 'Rain & clouds' },
  { id: 'sun', label: 'Sun & land' },
  { id: 'air', label: 'Air quality' },
  { id: 'meteogram', label: 'Meteogram' },
];

// Point variables the panel needs on top of the layer variables.
export const DETAIL_VARS = [
  'weather_code',
  'is_day',
  'wind_speed_80m',
  'wind_speed_120m',
  'wind_speed_180m',
  'wind_speed_850hPa',
  'wind_direction_850hPa',
];

const STEP = 3; // hours per column

// label, overlay (colour scale + unit kind), variable; `sum` adds up the 3 hours of a column.
const row = (label, overlayId, name, opts = {}) => {
  const def = findOverlay(overlayId);
  return { label, def, name: name ?? def.var, kind: opts.kind ?? def.kind, ...opts };
};
const ICONS = { type: 'icon', label: '' };
const arrow = (label, name) => ({ type: 'arrow', label, name });

const TAB_ROWS = {
  basic: [
    ICONS,
    row('Temperature', 'temp'),
    row('Feels like', 'feel'),
    row('Rain', 'rain', 'precipitation', { sum: true, kind: 'precip' }),
    row('Wind', 'wind', 'wind_speed_10m'),
    row('Wind gusts', 'gust'),
    arrow('Wind dir.', 'wind_direction_10m'),
  ],
  wind: [
    row('Wind 10 m', 'wind', 'wind_speed_10m'),
    row('Gusts', 'gust'),
    arrow('Dir. 10 m', 'wind_direction_10m'),
    row('Wind 80 m', 'wind', 'wind_speed_80m'),
    row('Wind 120 m', 'wind', 'wind_speed_120m'),
    row('Wind 180 m', 'wind', 'wind_speed_180m'),
    row('Wind 1.5 km', 'wind', 'wind_speed_850hPa'),
    arrow('Dir. 1.5 km', 'wind_direction_850hPa'),
    row('Pressure', 'pressure'),
  ],
  rain: [
    ICONS,
    row('Rain', 'rain', 'precipitation', { sum: true, kind: 'precip' }),
    row('Rain probability', 'rainprob'),
    row('CAPE (storms)', 'cape'),
    row('Clouds', 'clouds'),
    row('Low clouds', 'lclouds'),
    row('Medium clouds', 'mclouds'),
    row('High clouds', 'hclouds'),
    row('Visibility', 'visibility'),
    row('Humidity', 'rh'),
    row('Dew point', 'dewpoint'),
  ],
  sun: [
    ICONS,
    row('UV index', 'uv'),
    row('Solar radiation', 'solar'),
    row('Soil temperature', 'soiltemp'),
    row('Soil moisture', 'soilmoist'),
    row('Evapotranspiration', 'et0', null, { sum: true, kind: 'precip' }),
    row('Freezing altitude', 'freezing'),
  ],
  air: [
    row('Air quality index', 'aqi'),
    row('PM2.5', 'pm2p5'),
    row('PM10', 'pm10'),
    row('NO₂', 'no2'),
    row('Ozone (O₃)', 'o3'),
    row('Carbon monoxide', 'co'),
    row('SO₂', 'so2'),
    row('Dust', 'dust'),
    row('Aerosol optical depth', 'aod'),
  ],
};

// ---- Weather icons (WMO weather codes) ----

const SUN = '<circle cx="12" cy="12" r="4.5" fill="#ffd34d"/><g stroke="#ffd34d" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></g>';
const MOON = '<path d="M15.5 3.5a8.5 8.5 0 1 0 5 13.6A7 7 0 0 1 15.5 3.5z" fill="#c9d4ff"/>';
const CLOUD = (fill = '#cfd6e0', dy = 0) =>
  `<path transform="translate(0 ${dy})" d="M7 18h10.5a3.5 3.5 0 0 0 .3-7A5 5 0 0 0 8.2 9.6 4.2 4.2 0 0 0 7 18z" fill="${fill}"/>`;
const small = (svg) => `<g transform="translate(-3 -4) scale(0.7)">${svg}</g>`;
const DROPS = '<g stroke="#5aa9ff" stroke-width="1.8" stroke-linecap="round"><path d="M9 19.5l-1 2.5M13 19.5l-1 2.5M17 19.5l-1 2.5"/></g>';
const BOLT = '<path d="M13 15l-3 4.5h2.5L11 23l4.5-5.5H13l1.5-2.5z" fill="#ffd34d"/>';
const FLAKES = '<g fill="#fff"><circle cx="9" cy="21" r="1.2"/><circle cx="13" cy="22" r="1.2"/><circle cx="17" cy="21" r="1.2"/></g>';
const FOG = '<g stroke="#cfd6e0" stroke-width="1.8" stroke-linecap="round"><path d="M4 9h16M6 13h12M4 17h16"/></g>';

export function weatherIcon(code, isDay) {
  const sky = isDay ? SUN : MOON;
  let body;
  if (code == null) return '';
  if (code === 0) body = sky;
  else if (code <= 2) body = small(sky) + CLOUD('#cfd6e0', 1);
  else if (code === 3) body = CLOUD('#aab3c0', -2);
  else if (code === 45 || code === 48) body = FOG;
  else if (code >= 95) body = CLOUD('#8a93a3', -4) + BOLT;
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) body = CLOUD('#cfd6e0', -4) + FLAKES;
  else body = CLOUD('#9aa4b2', -4) + DROPS; // drizzle, rain, showers
  return `<svg viewBox="0 0 24 24" class="dt-icon">${body}</svg>`;
}

// ---- Table ----

function seriesOf(f, r) {
  const air = r.def?.src === 'air';
  return { times: air ? f.airTimes : f.times, arr: air ? f.air?.[r.name] : f.series[r.name] };
}

function valueAt(f, r, t) {
  const { times, arr } = seriesOf(f, r);
  if (!times || !arr) return null;
  const i = Math.round((t - times[0]) / 3600000);
  if (i < 0 || i >= arr.length) return null;
  if (!r.sum) return arr[i];
  let sum = 0;
  let any = false;
  for (let k = i; k < i + STEP && k < arr.length; k++) {
    if (arr[k] != null) {
      sum += arr[k];
      any = true;
    }
  }
  return any ? sum : null;
}

function fmt(v, unit) {
  const x = unit.f(v);
  const dp = unit.dp ?? (Math.abs(x) < 10 && Math.abs(x % 1) > 0.05 ? 1 : 0);
  return x.toFixed(dp);
}

// Index of the column containing `time`, or -1.
export function columnFor(cols, time) {
  return cols.findIndex((t) => time >= t && time < t + STEP * 3600000);
}

export function detailColumns(f) {
  return f.times.filter((_, i) => i % STEP === 0);
}

function renderTable(f, tab, { unitFor, time }) {
  const cols = detailColumns(f);
  const rows = TAB_ROWS[tab];
  const sel = columnFor(cols, time);
  const now = columnFor(cols, Date.now());
  const isDay = f.series.is_day;
  const cls = (k) =>
    [k === sel ? 'sel' : '', k === now ? 'now' : '', isDay && isDay[k * STEP] === 0 ? 'night' : ''].filter(Boolean).join(' ');

  // Day header: one cell spanning that day's columns.
  let days = '';
  let span = 0;
  cols.forEach((t, k) => {
    span++;
    const next = cols[k + 1];
    if (next === undefined || new Date(next).toDateString() !== new Date(t).toDateString()) {
      const label = new Date(t).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
      days += `<th class="dt-day" colspan="${span}">${esc(label)}</th>`;
      span = 0;
    }
  });
  const hours = cols
    .map((t, k) => {
      const d = new Date(t);
      const h = d.getHours() % 12 || 12;
      const m = d.getMinutes() ? `:${String(d.getMinutes()).padStart(2, '0')}` : '';
      return `<th class="${cls(k)}" data-c="${k}" data-t="${t}">${h}${m}<small>${d.getHours() < 12 ? 'AM' : 'PM'}</small></th>`;
    })
    .join('');

  const body = rows
    .map((r) => {
      let label = r.label;
      let cells;
      if (r.type === 'icon') {
        cells = cols.map((t, k) => `<td class="${cls(k)}" data-c="${k}" data-t="${t}">${weatherIcon(f.series.weather_code?.[k * STEP], isDay?.[k * STEP] !== 0)}</td>`);
      } else if (r.type === 'arrow') {
        const arr = f.series[r.name];
        cells = cols.map((t, k) => {
          const d = arr?.[k * STEP];
          // The arrow points where the wind blows TO (bearing + 180°).
          const inner =
            d == null
              ? ''
              : `<svg viewBox="0 0 16 16" class="dt-arrow" style="transform:rotate(${d + 180}deg)"><title>from ${compass(d)}</title><path d="M8 1.5l4.5 11L8 10l-4.5 2.5z"/></svg>`;
          return `<td class="${cls(k)}" data-c="${k}" data-t="${t}">${inner}</td>`;
        });
      } else {
        const unit = unitFor(r.kind);
        if (unit.id) label += ` <span class="dt-unit">${esc(unit.id)}</span>`;
        cells = cols.map((t, k) => {
          const v = valueAt(f, r, t);
          if (v == null) return `<td class="${cls(k)} empty" data-c="${k}" data-t="${t}">–</td>`;
          const [cr, cg, cb, ca] = colorAt(r.def.stops, v);
          const bg = ca > 8 ? ` style="background:rgba(${cr},${cg},${cb},${((ca / 255) * 0.62).toFixed(2)})"` : '';
          return `<td class="${cls(k)}" data-c="${k}" data-t="${t}"${bg}>${fmt(v, unit)}</td>`;
        });
      }
      return `<tr><th class="dt-label">${r.label ? label : ''}</th>${cells.join('')}</tr>`;
    })
    .join('');

  const note =
    tab === 'air' && f.airTimes
      ? `<div class="dt-note">Air-quality forecast (CAMS) runs until ${esc(new Date(f.airTimes[f.airTimes.length - 1]).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}.</div>`
      : '';

  return `<div class="dt-scroll"><table class="dt-table">
      <thead><tr><th class="dt-label"></th>${days}</tr><tr><th class="dt-label">Hours</th>${hours}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>${note}`;
}

/** Panel HTML. ctx: { tab, place, model, level, def, time, unitFor, nameFor, chartWidth } */
export function renderDetail(f, ctx) {
  const tabs = TABS.map((t) => `<button data-tab="${t.id}" class="${t.id === ctx.tab ? 'active' : ''}">${esc(t.label)}</button>`).join('');
  const body =
    ctx.tab === 'meteogram'
      ? `<div class="dt-chart">${renderChart(f, { ...ctx, width: ctx.chartWidth, height: 200 })}</div>`
      : renderTable(f, ctx.tab, ctx);
  return `
    <div class="dt-head">
      <div class="dt-title">
        <b>${esc(ctx.place)}</b>
        <span>${f.lat.toFixed(2)}°, ${f.lon.toFixed(2)}° · ${Math.round(f.elevation)} m · ${esc(ctx.model)}</span>
      </div>
      <div class="dt-tabs">${tabs}</div>
      <button class="dt-close" data-close aria-label="Close forecast">✕</button>
    </div>
    <div class="dt-body">${body}</div>`;
}

/** Moves the selected-time highlight without re-rendering the table. */
export function markTime(root, f, time) {
  root.querySelectorAll('.sel').forEach((el) => el.classList.remove('sel'));
  const k = columnFor(detailColumns(f), time);
  if (k >= 0) root.querySelectorAll(`[data-c="${k}"]`).forEach((el) => el.classList.add('sel'));
}
