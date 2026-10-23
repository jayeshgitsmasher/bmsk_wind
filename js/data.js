// Weather and air-quality data from Open-Meteo (free, no key, CC BY 4.0).
//
// The free tier has a daily call limit, so every unique request is made at
// most once per day. Each (date, source, model, variable, point) series is
// looked up in this order before anything goes to the network:
//   1. memory  2. IndexedDB (store.js, survives reloads)  3. a request already in flight
// Network requests are never cancelled, so a call that was paid for is always kept.
//
// The map is sampled on a lattice snapped to fixed degree spacings, so the
// same points recur across pans, zooms and layers.

import { today, getMany, putMany, addUsage, callWeight } from './store.js';

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
const SPACINGS = [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 16, 20];
// Point forecasts are snapped to this grid (~5 km) so nearby clicks share a cached response.
const POINT_SNAP = 0.05;

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

// key -> { key, date, t0, values: Float32Array } (same shape as the IndexedDB records)
const memory = new Map();
// key -> promise that settles when the request carrying that series finishes
const inflight = new Map();

const normLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
const modelFor = (src, model) => (src === 'air' ? 'cams' : model);
const seriesKey = (date, src, model, name, lat, lon) =>
  `${date}|${src}|${modelFor(src, model)}|${name}|${lat.toFixed(2)}|${normLon(lon).toFixed(2)}`;

const timesCache = new Map();
// Hourly timestamps from t0; shared between series with the same span.
function timesFor(t0, n) {
  const k = `${t0}|${n}`;
  let t = timesCache.get(k);
  if (!t) {
    t = Array.from({ length: n }, (_, i) => t0 + i * 3600000);
    timesCache.set(k, t);
  }
  return t;
}

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

// Returns { data, billed }; billed is false when server.js answered from its own cache.
async function request(src, params) {
  const query = new URLSearchParams(params);
  let res = useProxy ? await fetch(`${PROXY[src]}?${query}`) : null;
  if (!res || res.status === 404) {
    useProxy = false;
    res = await fetch(`${DIRECT[src]}?${query}`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error('Open-Meteo free rate limit reached — wait a minute, then pan to retry');
    throw new Error(body.reason || `Open-Meteo HTTP ${res.status}`);
  }
  return { data: await res.json(), billed: res.headers.get('X-Cache') !== 'hit' };
}

function baseParams(src, model) {
  const p = { forecast_days: SOURCE_DAYS[src], timezone: 'GMT', cell_selection: 'nearest' };
  if (src === 'forecast') {
    p.wind_speed_unit = 'ms';
    p.models = model;
  }
  return p;
}

const toValues = (arr) => Float32Array.from(arr, (v) => (v == null ? NaN : v));

// One network request for `names` at `points`; results go to memory and IndexedDB.
function fetchChunk(date, src, model, names, points) {
  const keys = points.flatMap((p) => names.map((n) => seriesKey(date, src, model, n, p.lat, p.lon)));
  const job = (async () => {
    let { data, billed } = await request(src, {
      ...baseParams(src, model),
      latitude: points.map((p) => p.lat.toFixed(2)).join(','),
      longitude: points.map((p) => p.lon.toFixed(2)).join(','),
      hourly: names.join(','),
    });
    if (!Array.isArray(data)) data = [data];
    if (billed) addUsage({ calls: callWeight(points.length, names.length, SOURCE_DAYS[src]), fetched: keys.length });
    else addUsage({ cached: keys.length });
    const records = [];
    data.forEach((d, n) => {
      const t0 = Date.parse(`${d.hourly.time[0]}Z`);
      for (const name of names) {
        const key = seriesKey(date, src, model, name, points[n].lat, points[n].lon);
        const rec = { key, date, t0, values: toValues(d.hourly[name] || []) };
        memory.set(key, rec);
        records.push(rec);
      }
    });
    await putMany('series', records);
  })().finally(() => keys.forEach((k) => inflight.delete(k)));
  for (const k of keys) inflight.set(k, job);
  return job;
}

/**
 * Loads `vars` ([{ src, name }]) on a lattice covering `bounds`, fetching only
 * series not already cached today. Returns
 * { lon0, lat0, step, cols, rows, fields: { [name]: { times, data: Float32Array[] } } }.
 */
export async function fetchGrid(bounds, { model, vars }, step) {
  const date = today();
  const lat = lattice(bounds, step);
  const points = [];
  for (let j = 0; j < lat.rows; j++) {
    for (let i = 0; i < lat.cols; i++) points.push({ lat: (lat.j0 + j) * lat.step, lon: (lat.i0 + i) * lat.step });
  }

  // series key -> { src, name, point } for everything not in memory
  const wanted = new Map();
  for (const v of vars) {
    for (const p of points) {
      const key = seriesKey(date, v.src, model, v.name, p.lat, p.lon);
      if (!memory.has(key) && !wanted.has(key)) wanted.set(key, { src: v.src, name: v.name, p });
    }
  }

  const stored = await getMany('series', [...wanted.keys()]);
  for (const [key, rec] of stored) {
    memory.set(key, rec);
    wanted.delete(key);
  }
  if (stored.size) addUsage({ cached: stored.size });

  const waits = new Set();
  for (const key of [...wanted.keys()]) {
    if (inflight.has(key)) {
      waits.add(inflight.get(key));
      wanted.delete(key);
    }
  }

  // Group the remaining points by source and by exactly which variables they miss,
  // so no request carries a series that is already cached.
  const groups = new Map();
  for (const { src, name, p } of wanted.values()) {
    const pk = `${p.lat.toFixed(2)}|${normLon(p.lon).toFixed(2)}`;
    const id = `${src}|${pk}`;
    if (!groups.has(id)) groups.set(id, { src, point: { lat: p.lat, lon: normLon(p.lon) }, names: new Set() });
    groups.get(id).names.add(name);
  }
  const batches = new Map();
  for (const { src, point, names } of groups.values()) {
    const sorted = [...names].sort();
    const id = `${src}|${sorted.join(',')}`;
    if (!batches.has(id)) batches.set(id, { src, names: sorted, points: [] });
    batches.get(id).points.push(point);
  }
  const jobs = [...waits];
  for (const { src, names, points: pts } of batches.values()) {
    for (let k = 0; k < pts.length; k += CHUNK) jobs.push(fetchChunk(date, src, model, names, pts.slice(k, k + CHUNK)));
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.find((r) => r.status === 'rejected');

  const fields = {};
  for (const v of vars) fields[v.name] = assemble(date, v.src, model, v.name, points);
  if (failed && !Object.values(fields).some(Boolean)) throw failed.reason;
  return { lon0: lat.i0 * lat.step, lat0: lat.j0 * lat.step, step: lat.step, cols: lat.cols, rows: lat.rows, fields };
}

// Per-hour arrays (row-major, south to north), trimmed to the last hour with any data.
function assemble(date, src, model, name, points) {
  const series = points.map((p) => memory.get(seriesKey(date, src, model, name, p.lat, p.lon)));
  const ref = series.find((s) => s && s.values.length);
  if (!ref) return null;
  const n = ref.values.length;
  let last = -1;
  const data = [];
  for (let t = 0; t < n; t++) {
    const arr = new Float32Array(points.length).fill(NaN);
    series.forEach((s, idx) => {
      // Series fetched in different requests share the same hourly start on a given date.
      const v = s ? s.values[t + Math.round((ref.t0 - s.t0) / 3600000)] : NaN;
      if (v !== undefined && !Number.isNaN(v)) {
        arr[idx] = v;
        last = t;
      }
    });
    data.push(arr);
  }
  if (last < 0) return null;
  return { times: timesFor(ref.t0, last + 1), data: data.slice(0, last + 1) };
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

const pointMemory = new Map();

// One point request, cached per date + snapped location + variable set.
async function cachedPoint(src, model, lat, lon, names) {
  const date = today();
  const key = `${date}|${src}|${modelFor(src, model)}|${lat.toFixed(2)}|${lon.toFixed(2)}|${[...names].sort().join(',')}`;
  if (pointMemory.has(key)) return pointMemory.get(key);
  const job = (async () => {
    const stored = (await getMany('points', [key])).get(key);
    if (stored) {
      addUsage({ cached: 1 });
      return stored.data;
    }
    const { data, billed } = await request(src, {
      ...baseParams(src, model),
      latitude: lat.toFixed(3),
      longitude: lon.toFixed(3),
      hourly: names.join(','),
    });
    addUsage(billed ? { calls: callWeight(1, names.length, SOURCE_DAYS[src]), fetched: 1 } : { cached: 1 });
    await putMany('points', [{ key, date, data }]);
    return data;
  })();
  pointMemory.set(key, job);
  job.catch(() => pointMemory.delete(key)); // failed requests may be retried
  return job;
}

/** Full point forecast: every forecast variable in `names`, plus air quality. */
export async function fetchPoint(lat, lon, model, names, airNames) {
  const sLat = Math.round(lat / POINT_SNAP) * POINT_SNAP;
  const sLon = Math.round(normLon(lon) / POINT_SNAP) * POINT_SNAP;
  const [wx, air] = await Promise.allSettled([
    cachedPoint('forecast', model, sLat, sLon, names),
    cachedPoint('air', model, sLat, sLon, airNames),
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
