// Leaflet layer that draws a colour overlay (any scalar field) plus animated
// wind particles. Both canvases live in a map pane, so they pan with the map
// for free; on moveend they are re-anchored to the viewport and rebuilt.
//
// Optional clip: a polygon ring ([lon, lat] pairs) outside of which nothing is drawn.
// Optional contrast stretch: the colour scale is spread over the 2nd–98th
// percentile of the loaded data, so small variations stand out.
// Overlays with a `contour` interval also get labelled isolines.

import { sampleField, sampleWind } from './field.js';
import { lutFor } from './colors.js';

const STEP = 4; // screen pixels per field cell
const FADE = 'rgba(0, 0, 0, 0.95)';
const MAX_AGE = 120;
const TARGET_PX = 2.2; // average particle speed in pixels per frame, whatever the wind
const HEAT_ALPHA = 0.85;
const LABEL_SPACING = 260; // px between isoline labels of the same value
// Faster particles are drawn brighter and thicker so gusty bands stand out.
const BUCKETS = [
  { alpha: 0.3, width: 1 },
  { alpha: 0.55, width: 1.3 },
  { alpha: 0.8, width: 1.7 },
  { alpha: 1, width: 2.2 },
];

function stats(values) {
  values.sort((a, b) => a - b);
  const at = (p) => values[Math.min(values.length - 1, Math.floor(p * values.length))];
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return { lo: at(0.02), hi: at(0.98), mean };
}

// Ray-casting point-in-polygon test; ring is [lon, lat] pairs.
function inside(ring, lon, lat) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// Every few hours of a field, flattened, without NaNs; only cells in `keep` when given.
function collect(arrays, keep, map = (a, k) => a[k]) {
  const out = [];
  const tStep = Math.max(1, Math.floor(arrays.length / 40));
  for (let t = 0; t < arrays.length; t += tStep) {
    for (let k = 0; k < arrays[t].length; k++) {
      if (keep && !keep[k]) continue;
      const v = map(arrays[t], k, t);
      if (!Number.isNaN(v)) out.push(v);
    }
  }
  return out;
}

export const WeatherLayer = L.Layer.extend({
  initialize() {
    this._grid = null;
    this._wind = null;
    this._scalar = null;
    this._def = null;
    this._format = (v) => String(Math.round(v));
    this._time = Date.now();
    this._particlesOn = true;
    this._enhance = true;
    this._clip = null;
    this._particles = [];
    this._raf = 0;
    this._pending = 0;
    this._tick = this._tick.bind(this);
  },

  onAdd(map) {
    const pane = map.getPane('weather');
    this._heat = L.DomUtil.create('canvas', 'wx-canvas', pane);
    this._flow = L.DomUtil.create('canvas', 'wx-canvas', pane);
    this._off = document.createElement('canvas');
    this._maskCanvas = document.createElement('canvas');
    map.on('zoomstart', this._hide, this);
    map.on('moveend resize', this._reset, this);
    this._reset();
  },

  onRemove(map) {
    this._stop();
    map.off('zoomstart', this._hide, this);
    map.off('moveend resize', this._reset, this);
    this._heat.remove();
    this._flow.remove();
  },

  /** grid: lattice geometry; wind: { times, u, v } | null; scalar: { times, data } | null (null = wind speed). */
  setData(grid, wind, scalar, def) {
    this._grid = grid;
    this._wind = wind;
    this._scalar = scalar;
    this._def = def;
    this._computeStats();
    this._schedule();
  },

  // Formats isoline labels (base units -> display string).
  setFormat(fn) {
    this._format = fn;
    this._schedule();
  },

  setTime(ms) {
    this._time = ms;
    this._schedule();
  },

  redraw() {
    this._schedule();
  },

  setEnhance(on) {
    this._enhance = on;
    this._computeStats();
    this._schedule();
  },

  setClip(ring) {
    this._clip = ring;
    this._mask = null;
    this._particles = [];
    this._computeStats();
    this._schedule();
  },

  setParticles(on) {
    this._particlesOn = on;
    if (!on) {
      this._stop();
      this._flow.getContext('2d').clearRect(0, 0, this._flow.width, this._flow.height);
    } else {
      this._start();
    }
  },

  // Colour-scale range in base units when contrast is stretched, else null.
  getRange() {
    return this._range;
  },

  /** { u, v, value } at a lat/lng for the current time (NaN where missing), or null outside the grid. */
  valueAt(latlng) {
    if (!this._grid) return null;
    const out = [NaN, NaN];
    const hasWind = sampleWind(this._grid, this._wind, this._time, latlng.lat, latlng.lng, out);
    const value = this._scalarAt(latlng.lat, latlng.lng, hasWind ? out : null);
    if (!hasWind && Number.isNaN(value)) return null;
    return { u: out[0], v: out[1], value };
  },

  _scalarAt(lat, lng, wind) {
    if (this._scalar) return sampleField(this._grid, this._scalar, this._time, lat, lng);
    return wind ? Math.hypot(wind[0], wind[1]) : NaN;
  },

  // Grid points inside the clip polygon, or null without a clip. The grid
  // extends a cell beyond the clip, and those hidden points (e.g. Himalayan
  // peaks next to Bihar) must not skew the colour range.
  _gridKeep() {
    const g = this._grid;
    if (!this._clip || !g) return null;
    const keep = new Uint8Array(g.cols * g.rows);
    for (let j = 0; j < g.rows; j++) {
      for (let i = 0; i < g.cols; i++) keep[j * g.cols + i] = inside(this._clip, g.lon0 + i * g.step, g.lat0 + j * g.step) ? 1 : 0;
    }
    return keep.some(Boolean) ? keep : null;
  },

  // Percentiles over every hour of the loaded data, so colours keep their
  // meaning while the timeline plays.
  _computeStats() {
    this._range = null;
    this._windStats = null;
    if (!this._grid) return;
    const keep = this._gridKeep();
    if (this._wind) {
      const winds = collect(this._wind.u, keep, (u, k, t) => Math.hypot(u[k], this._wind.v[t][k]));
      if (winds.length) this._windStats = stats(winds);
    }
    const def = this._def;
    if (this._enhance && def?.stretch) {
      const values = this._scalar ? collect(this._scalar.data, keep) : null;
      const src = values ? (values.length ? stats(values) : null) : this._windStats;
      if (src) {
        let { lo, hi } = src;
        const full = def.stops[def.stops.length - 1][0] - def.stops[0][0];
        const span = full * 0.05;
        if (hi - lo < span) {
          const mid = (hi + lo) / 2;
          lo = mid - span / 2;
          hi = mid + span / 2;
        }
        if (def.kind === 'speed' || def.kind === 'percent') lo = Math.max(0, lo);
        this._range = { lo, hi };
      }
    }
    this.fire('range', { range: this._range });
  },

  _hide() {
    this._stop();
    this._heat.style.visibility = 'hidden';
    this._flow.style.visibility = 'hidden';
  },

  _reset() {
    const map = this._map;
    const size = map.getSize();
    const pos = map.containerPointToLayerPoint([0, 0]);
    for (const c of [this._heat, this._flow]) {
      c.width = size.x;
      c.height = size.y;
      L.DomUtil.setPosition(c, pos);
      c.style.visibility = '';
    }
    this._coords = null;
    this._mask = null;
    this._particles = [];
    this._rebuild();
  },

  _schedule() {
    if (this._pending) return;
    this._pending = requestAnimationFrame(() => {
      this._pending = 0;
      this._rebuild();
    });
  },

  _rebuild() {
    if (!this._map || !this._grid || !this._def) return;
    this._buildField();
    this._drawHeat();
    if (this._def.contour) this._drawContours();
    if (this._particlesOn) this._start();
  },

  // Lat/lng of every field cell; only changes when the view does.
  _buildCoords(fw, fh) {
    const lat = new Float32Array(fw * fh);
    const lng = new Float32Array(fw * fh);
    for (let j = 0; j < fh; j++) {
      for (let i = 0; i < fw; i++) {
        const ll = this._map.containerPointToLatLng([i * STEP, j * STEP]);
        lat[j * fw + i] = ll.lat;
        lng[j * fw + i] = ll.lng;
      }
    }
    this._coords = { fw, fh, lat, lng };
  },

  _buildMask(fw, fh) {
    const c = this._maskCanvas;
    c.width = fw;
    c.height = fh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.beginPath();
    this._clip.forEach(([lon, lat], n) => {
      const p = this._map.latLngToContainerPoint([lat, lon]);
      if (n) ctx.lineTo(p.x / STEP, p.y / STEP);
      else ctx.moveTo(p.x / STEP, p.y / STEP);
    });
    ctx.closePath();
    ctx.fill();
    const alpha = ctx.getImageData(0, 0, fw, fh).data;
    const mask = new Uint8Array(fw * fh);
    for (let k = 0; k < mask.length; k++) mask[k] = alpha[k * 4 + 3] > 0 ? 1 : 0;
    this._mask = mask;
  },

  _buildField() {
    const W = this._heat.width;
    const H = this._heat.height;
    const fw = Math.ceil(W / STEP) + 2;
    const fh = Math.ceil(H / STEP) + 2;
    if (!this._coords || this._coords.fw !== fw || this._coords.fh !== fh) this._buildCoords(fw, fh);
    if (this._clip && !this._mask) this._buildMask(fw, fh);
    const mask = this._clip ? this._mask : null;
    const { lat, lng } = this._coords;
    const n = fw * fh;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const s = new Float32Array(n);
    const out = [0, 0];
    for (let k = 0; k < n; k++) {
      if (mask && !mask[k]) {
        u[k] = v[k] = s[k] = NaN;
        continue;
      }
      const hasWind = sampleWind(this._grid, this._wind, this._time, lat[k], lng[k], out);
      u[k] = hasWind ? out[0] : NaN;
      v[k] = hasWind ? out[1] : NaN;
      s[k] = this._scalarAt(lat[k], lng[k], hasWind ? out : null);
    }
    this._field = { fw, fh, u, v, s, mask };
  },

  _drawHeat() {
    const { fw, fh, s } = this._field;
    const def = this._def;
    const lut = lutFor(def);
    const toLut = (lut.size - 1) / (lut.max - lut.min);
    // Data value -> LUT index; with a stretched range, lo..hi spans the vivid colours.
    let base = lut.min;
    let scale = toLut;
    let offset = 0;
    if (this._range) {
      const [vLo, vHi] = def.vivid || [lut.min, lut.max];
      base = this._range.lo;
      scale = ((vHi - vLo) / (this._range.hi - this._range.lo)) * toLut;
      offset = (vLo - lut.min) * toLut;
    }
    const off = this._off;
    off.width = fw;
    off.height = fh;
    const octx = off.getContext('2d');
    const img = octx.createImageData(fw, fh);
    const px = img.data;
    for (let k = 0; k < s.length; k++) {
      const val = s[k];
      if (Number.isNaN(val)) continue;
      const idx = Math.max(0, Math.min(lut.size - 1, Math.round(offset + (val - base) * scale))) * 4;
      px[k * 4] = lut.rgba[idx];
      px[k * 4 + 1] = lut.rgba[idx + 1];
      px[k * 4 + 2] = lut.rgba[idx + 2];
      px[k * 4 + 3] = lut.rgba[idx + 3] * HEAT_ALPHA;
    }
    octx.putImageData(img, 0, 0);
    const ctx = this._heat.getContext('2d');
    ctx.clearRect(0, 0, this._heat.width, this._heat.height);
    ctx.imageSmoothingEnabled = true;
    // Texel centres sit at multiples of STEP, so shift by half a cell.
    ctx.drawImage(off, -STEP / 2, -STEP / 2, fw * STEP, fh * STEP);
  },

  // Marching squares over the screen field, with a few labels per isoline value.
  _drawContours() {
    const { fw, fh, s } = this._field;
    const interval = this._def.contour;
    const path = new Path2D();
    const labels = new Map();
    const pts = [];
    for (let j = 0; j < fh - 1; j++) {
      for (let i = 0; i < fw - 1; i++) {
        const k = j * fw + i;
        const a = s[k];
        const b = s[k + 1];
        const c = s[k + fw + 1];
        const d = s[k + fw];
        if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) continue;
        const lo = Math.min(a, b, c, d);
        const hi = Math.max(a, b, c, d);
        for (let lvl = Math.ceil(lo / interval) * interval; lvl <= hi; lvl += interval) {
          pts.length = 0;
          if (a < lvl !== b < lvl) pts.push(i + (lvl - a) / (b - a), j);
          if (b < lvl !== c < lvl) pts.push(i + 1, j + (lvl - b) / (c - b));
          if (d < lvl !== c < lvl) pts.push(i + (lvl - d) / (c - d), j + 1);
          if (a < lvl !== d < lvl) pts.push(i, j + (lvl - a) / (d - a));
          for (let p = 0; p + 3 < pts.length; p += 4) {
            const x0 = pts[p] * STEP;
            const y0 = pts[p + 1] * STEP;
            const x1 = pts[p + 2] * STEP;
            const y1 = pts[p + 3] * STEP;
            path.moveTo(x0, y0);
            path.lineTo(x1, y1);
            const placed = labels.get(lvl) || [];
            const mx = (x0 + x1) / 2;
            const my = (y0 + y1) / 2;
            if (placed.every(([x, y]) => Math.hypot(x - mx, y - my) > LABEL_SPACING)) {
              placed.push([mx, my]);
              labels.set(lvl, placed);
            }
          }
        }
      }
    }
    const ctx = this._heat.getContext('2d');
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke(path);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillStyle = '#fff';
    for (const [lvl, spots] of labels) {
      const text = this._format(lvl);
      for (const [x, y] of spots) {
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      }
    }
  },

  _flowAt(x, y, out) {
    const f = this._field;
    const fx = x / STEP;
    const fy = y / STEP;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= f.fw - 1 || j >= f.fh - 1) return false;
    const dx = fx - i;
    const dy = fy - j;
    const k00 = j * f.fw + i;
    const k10 = k00 + 1;
    const k01 = k00 + f.fw;
    const k11 = k01 + 1;
    out[0] = (f.u[k00] * (1 - dx) + f.u[k10] * dx) * (1 - dy) + (f.u[k01] * (1 - dx) + f.u[k11] * dx) * dy;
    out[1] = (f.v[k00] * (1 - dx) + f.v[k10] * dx) * (1 - dy) + (f.v[k01] * (1 - dx) + f.v[k11] * dx) * dy;
    return !Number.isNaN(out[0]) && !Number.isNaN(out[1]);
  },

  // Random position, preferring cells inside the clip so particles are not wasted.
  _spawn(p) {
    const W = this._flow.width;
    const H = this._flow.height;
    const f = this._field;
    for (let tries = 0; tries < 20; tries++) {
      p.x = Math.random() * W;
      p.y = Math.random() * H;
      if (!f.mask || f.mask[Math.floor(p.y / STEP) * f.fw + Math.floor(p.x / STEP)]) break;
    }
    p.age = Math.floor(Math.random() * MAX_AGE);
    return p;
  },

  _start() {
    if (!this._field || !this._wind) return;
    const W = this._flow.width;
    const H = this._flow.height;
    let area = W * H;
    if (this._field.mask) area *= this._field.mask.reduce((a, b) => a + b, 0) / this._field.mask.length;
    const count = Math.min(9000, Math.max(300, Math.round(area / 140)));
    while (this._particles.length < count) this._particles.push(this._spawn({}));
    this._particles.length = count;
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  },

  _stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  },

  _tick() {
    this._raf = requestAnimationFrame(this._tick);
    const ctx = this._flow.getContext('2d');
    const W = this._flow.width;
    const H = this._flow.height;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = FADE;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    const wind = this._windStats || { lo: 0, hi: 10, mean: 5 };
    const k = Math.max(0.08, Math.min(1.2, TARGET_PX / Math.max(wind.mean, 0.5)));
    const spread = Math.max(wind.hi - wind.lo, 0.5);
    const paths = BUCKETS.map(() => new Path2D());
    const vel = [0, 0];
    for (const p of this._particles) {
      if (++p.age > MAX_AGE || !this._flowAt(p.x, p.y, vel)) {
        this._spawn(p);
        p.age = 0;
        continue;
      }
      const speed = Math.hypot(vel[0], vel[1]);
      const b = Math.max(0, Math.min(BUCKETS.length - 1, Math.floor(((speed - wind.lo) / spread) * BUCKETS.length)));
      const nx = p.x + vel[0] * k;
      const ny = p.y - vel[1] * k;
      paths[b].moveTo(p.x, p.y);
      paths[b].lineTo(nx, ny);
      p.x = nx;
      p.y = ny;
    }
    ctx.lineCap = 'round';
    BUCKETS.forEach((bucket, n) => {
      ctx.strokeStyle = `rgba(255, 255, 255, ${bucket.alpha})`;
      ctx.lineWidth = bucket.width;
      ctx.stroke(paths[n]);
    });
  },
});
