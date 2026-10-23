// Bilinear (space) + linear (time) interpolation over grids from data.js.

const cell = { k00: 0, k10: 0, k01: 0, k11: 0, dx: 0, dy: 0 };

function locate(g, lat, lon) {
  const fx = (lon - g.lon0) / g.step;
  const fy = (lat - g.lat0) / g.step;
  if (fx < 0 || fy < 0 || fx > g.cols - 1 || fy > g.rows - 1) return false;
  const i = Math.min(Math.floor(fx), g.cols - 2);
  const j = Math.min(Math.floor(fy), g.rows - 2);
  cell.dx = fx - i;
  cell.dy = fy - j;
  cell.k00 = j * g.cols + i;
  cell.k10 = cell.k00 + 1;
  cell.k01 = cell.k00 + g.cols;
  cell.k11 = cell.k01 + 1;
  return true;
}

function bilerp(a) {
  const { k00, k10, k01, k11, dx, dy } = cell;
  return (a[k00] * (1 - dx) + a[k10] * dx) * (1 - dy) + (a[k01] * (1 - dx) + a[k11] * dx) * dy;
}

// Fractional hour index into `times`, or -1 outside the series.
export function timeIndex(times, ms) {
  const idx = (ms - times[0]) / 3600000;
  return idx < 0 || idx > times.length - 1 ? -1 : idx;
}

function lerpTime(arrays, t) {
  const t0 = Math.floor(t);
  const t1 = Math.min(t0 + 1, arrays.length - 1);
  const dt = t - t0;
  return bilerp(arrays[t0]) * (1 - dt) + bilerp(arrays[t1]) * dt;
}

/** Scalar field ({ times, data }) at a point and time; NaN where there is no data. */
export function sampleField(g, field, ms, lat, lon) {
  if (!field) return NaN;
  const t = timeIndex(field.times, ms);
  if (t < 0 || !locate(g, lat, lon)) return NaN;
  return lerpTime(field.data, t);
}

/** Wind ({ times, u, v }) at a point and time into out[0..1]; false where there is no data. */
export function sampleWind(g, wind, ms, lat, lon, out) {
  if (!wind) return false;
  const t = timeIndex(wind.times, ms);
  if (t < 0 || !locate(g, lat, lon)) return false;
  out[0] = lerpTime(wind.u, t);
  out[1] = lerpTime(wind.v, t);
  return !Number.isNaN(out[0]) && !Number.isNaN(out[1]);
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// Meteorological direction (where the wind blows FROM), in degrees.
export function windFrom(u, v) {
  return ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
}

export function compass(deg) {
  return COMPASS[Math.round(deg / 22.5) % 16];
}
