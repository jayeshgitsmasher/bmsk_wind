// Weather and air-quality data from Open-Meteo (free, no key, CC BY 4.0),
// requested through the local caching proxy in server.js.
//
// The map is sampled on a lattice snapped to fixed degree spacings, and each
// (variable, point) series is cached individually so panning or switching
// layers only fetches what is new.

const PROXY = { forecast: 'api/forecast', air: 'api/air' };
const DIRECT = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  air: 'https://air-quality-api.open-meteo.com/v1/air-quality',
};
// The caching proxy only exists behind server.js, which marks the page it serves.
// Elsewhere (e.g. VS Code Live Server) requests go straight to Open-Meteo.
let useProxy = document.querySelector('meta[name="zephyr-proxy"]')?.content === 'on';
const SOURCE_DAYS = { forecast: 16, air: 7 };
const CHUNK = 100;
const MAX_AGE = 60 * 60 * 1000;
const SPACINGS = [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 16, 20];

export const MODELS = [
  { id: 'best_match', label: 'Best match (16 days)' },
  { id: 'ecmwf_ifs025', label: 'ECMWF IFS (15 days)' },
  { id: 'gfs_seamless', label: 'GFS / NOAA (16 days)' },
  { id: 'icon_seamless', label: 'ICON / DWD (7.5 days)' },
  { id: 'gem_seamless', label: 'GEM / Canada (10 days)' },
  { id: 'jma_seamless', label: 'JMA / Japan (11 days)' },
];

export const LEVELS = [
  { id: 'surface', label: 'Surface', short: 'SFC', wind: '10m', temp: '2m' },
  { id: '80m', label: '80 m', short: '80m', wind: '80m', temp: '80m' },
  { id: '120m', label: '120 m', short: '120m', wind: '120m', temp: '120m' },
  { id: '180m', label: '180 m', short: '180m', wind: '180m', temp: '180m' },
  { id: '850h', label: '850 hPa · 1.5 km', short: '1.5km', wind: '850hPa', temp: '850hPa' },
  { id: '700h', label: '700 hPa · 3 km', short: '3km', wind: '700hPa', temp: '700hPa' },
  { id: '500h', label: '500 hPa · 5.5 km', short: '5.5km', wind: '500hPa', temp: '500hPa' },
  { id: '300h', label: '300 hPa · 9 km', short: '9km', wind: '300hPa', temp: '300hPa' },
  { id: '250h', label: '250 hPa · 10 km', short: '10km', wind: '250hPa', temp: '250hPa' },
];

const ALIASES = { '10m': 'surface', sfc: 'surface', '100m': '80m', '150m': '120m', '200m': '180m' };

export function findLevel(id) {
  if (!id) return null;
  const key = ALIASES[id.toLowerCase()] || id.toLowerCase();
  return LEVELS.find((l) => l.id === key) || null;
}

export function windVars(level) {
  return [`wind_speed_${level.wind}`, `wind_direction_${level.wind}`];
}

const cache = new Map();

const normLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
const modelFor = (src, model) => (src === 'air' ? 'cams' : model);
const seriesKey = (src, model, name, lat, lon) => `${src}|${modelFor(src, model)}|${name}|${lat.toFixed(2)}|${normLon(lon).toFixed(2)}`;

function lattice(bounds, fixedStep) {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = Math.max(bounds.getSouth(), -85);
  const north = Math.min(bounds.getNorth(), 85);
  // Every lattice point counts as one Open-Meteo API call, so keep the grid coarse.
  const span = Math.max((east - west) / 12, (north - south) / 8);
  const step = fixedStep || (SPACINGS.find((s) => s >= span) ?? SPACINGS[SPACINGS.length - 1]);
  const i0 = Math.floor(west / step) - 1;
  const i1 = Math.ceil(east / step) + 1;
  const j0 = Math.max(Math.floor(south / step) - 1, Math.ceil(-89 / step));
  const j1 = Math.min(Math.ceil(north / step) + 1, Math.floor(89 / step));
  return { step, i0, j0, cols: i1 - i0 + 1, rows: j1 - j0 + 1 };
}

async function request(src, params, signal) {
  const query = new URLSearchParams(params);
  let res = useProxy ? await fetch(`${PROXY[src]}?${query}`, { signal }) : null;
  if (!res || res.status === 404) {
    useProxy = false;
    res = await fetch(`${DIRECT[src]}?${query}`, { signal });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error('Open-Meteo free rate limit reached — wait a minute, then pan to retry');
    throw new Error(body.reason || `Open-Meteo HTTP ${res.status}`);
  }
  return res.json();
}

function baseParams(src, model) {
  const p = { forecast_days: SOURCE_DAYS[src], timezone: 'GMT', cell_selection: 'nearest' };
  if (src === 'forecast') {
    p.wind_speed_unit = 'ms';
    p.models = model;
  }
  return p;
}

async function fetchChunk(src, model, names, points, signal) {
  let data = await request(
    src,
    {
      ...baseParams(src, model),
      latitude: points.map((p) => p.lat.toFixed(2)).join(','),
      longitude: points.map((p) => p.lon.toFixed(2)).join(','),
      hourly: names.join(','),
    },
    signal,
  );
  if (!Array.isArray(data)) data = [data];
  const fetched = Date.now();
  data.forEach((d, n) => {
    const times = d.hourly.time.map((t) => Date.parse(`${t}Z`));
    for (const name of names) {
      cache.set(seriesKey(src, model, name, points[n].lat, points[n].lon), { fetched, times, values: d.hourly[name] });
    }
  });
}

/**
 * Fetches `vars` ([{ src, name }]) on a lattice covering `bounds`.
 * Returns { lon0, lat0, step, cols, rows, fields: { [name]: { times, data: Float32Array[] } } }.
 */
export async function fetchGrid(bounds, { model, vars }, signal, step) {
  const lat = lattice(bounds, step);
  const now = Date.now();
  const points = [];
  for (let j = 0; j < lat.rows; j++) {
    for (let i = 0; i < lat.cols; i++) points.push({ lat: (lat.j0 + j) * lat.step, lon: (lat.i0 + i) * lat.step });
  }
  const fresh = (src, name, p) => {
    const hit = cache.get(seriesKey(src, model, name, p.lat, p.lon));
    return hit && now - hit.fetched < MAX_AGE;
  };

  const jobs = [];
  for (const src of new Set(vars.map((v) => v.src))) {
    const names = vars.filter((v) => v.src === src).map((v) => v.name);
    const seen = new Set();
    const missing = points.filter((p) => {
      const k = `${p.lat.toFixed(2)}|${normLon(p.lon).toFixed(2)}`;
      if (seen.has(k) || names.every((n) => fresh(src, n, p))) return false;
      seen.add(k);
      return true;
    });
    for (let k = 0; k < missing.length; k += CHUNK) {
      const chunk = missing.slice(k, k + CHUNK).map((p) => ({ lat: p.lat, lon: normLon(p.lon) }));
      jobs.push(fetchChunk(src, model, names, chunk, signal));
    }
  }
  await Promise.all(jobs);

  const fields = {};
  for (const v of vars) fields[v.name] = assemble(v.src, model, v.name, points);
  return { lon0: lat.i0 * lat.step, lat0: lat.j0 * lat.step, step: lat.step, cols: lat.cols, rows: lat.rows, fields };
}

// Per-hour arrays (row-major, south to north), trimmed to the last hour with any data.
function assemble(src, model, name, points) {
  const series = points.map((p) => cache.get(seriesKey(src, model, name, p.lat, p.lon)));
  const ref = series.find(Boolean);
  if (!ref) return null;
  let last = -1;
  const data = ref.times.map((_, t) => {
    const arr = new Float32Array(points.length).fill(NaN);
    series.forEach((s, idx) => {
      const v = s?.values[t];
      if (v != null) {
        arr[idx] = v;
        last = t;
      }
    });
    return arr;
  });
  if (last < 0) return null;
  return { times: ref.times.slice(0, last + 1), data: data.slice(0, last + 1) };
}

// Wind as u/v components from speed + meteorological direction fields.
export function windField(speed, dir) {
  if (!speed || !dir) return null;
  const n = Math.min(speed.times.length, dir.times.length);
  const u = [];
  const v = [];
  for (let t = 0; t < n; t++) {
    const s = speed.data[t];
    const d = dir.data[t];
    const ut = new Float32Array(s.length);
    const vt = new Float32Array(s.length);
    for (let k = 0; k < s.length; k++) {
      const rad = (d[k] * Math.PI) / 180;
      ut[k] = -s[k] * Math.sin(rad);
      vt[k] = -s[k] * Math.cos(rad);
    }
    u.push(ut);
    v.push(vt);
  }
  return { times: speed.times.slice(0, n), u, v };
}

// Running total from the first hour at or after `fromMs` (earlier hours are 0).
export function accumulateField(field, fromMs) {
  const start = Math.max(0, Math.ceil((fromMs - field.times[0]) / 3600000));
  const sum = new Float32Array(field.data[0].length);
  const data = field.data.map((arr, t) => {
    if (t >= start) {
      for (let k = 0; k < arr.length; k++) if (!Number.isNaN(arr[k])) sum[k] += arr[k];
    }
    return Float32Array.from(sum);
  });
  return { times: field.times, data };
}

/** Full point forecast: every forecast variable in `names`, plus air quality. */
export async function fetchPoint(lat, lon, model, names, airNames) {
  const loc = { latitude: lat.toFixed(3), longitude: normLon(lon).toFixed(3) };
  const [wx, air] = await Promise.allSettled([
    request('forecast', { ...baseParams('forecast', model), ...loc, hourly: names.join(',') }),
    request('air', { ...baseParams('air', model), ...loc, hourly: airNames.join(',') }),
  ]);
  if (wx.status === 'rejected') throw wx.reason;
  const d = wx.value;
  const toTimes = (h) => h.time.map((t) => Date.parse(`${t}Z`));
  const a = air.status === 'fulfilled' ? (Array.isArray(air.value) ? air.value[0] : air.value) : null;
  return {
    lat: d.latitude,
    lon: d.longitude,
    elevation: d.elevation,
    times: toTimes(d.hourly),
    series: d.hourly,
    airTimes: a ? toTimes(a.hourly) : null,
    air: a ? a.hourly : null,
  };
}
