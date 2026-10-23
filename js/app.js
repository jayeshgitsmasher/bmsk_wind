import { LEVELS, MODELS, findLevel, fetchGrid, fetchPoint, windVars, windField, accumulateField } from './data.js';
import { windFrom, compass } from './field.js';
import { UNITS, GROUPS, OVERLAYS, findOverlay, overlayVar, usesLevel, formatValue } from './params.js';
import { gradientCss } from './colors.js';
import { WeatherLayer } from './weather-layer.js';
import { esc } from './forecast.js';
import { renderDetail, markTime, DETAIL_VARS } from './detail.js';
import { readUsage, onUsage, pruneOldDates, clearAll } from './store.js';

const MODES = [
  { id: 'bihar', label: 'Bihar' },
  { id: 'world', label: 'Whole map' },
];

// Extent of the Bihar block shapefile (WGS84).
const BIHAR_BOUNDS = L.latLngBounds([24.2589, 83.3244], [27.5216, 88.3005]);
// Bihar mode samples a fixed lattice over the state: finer than the viewport
// lattice, and cached once for every pan and zoom.
const BIHAR_STEP = 0.35;

const $ = (id) => document.getElementById(id);

// ---- State, read from URLs like ?wind,100m,bihar,ecmwf_ifs025,24.328,82.234,6 (any token order) ----

function parseState() {
  const state = { overlay: OVERLAYS[0], level: LEVELS[0], mode: 'bihar', model: MODELS[0].id, view: null };
  const raw = decodeURIComponent(location.search.slice(1) || location.hash.slice(1));
  const nums = [];
  for (const tok of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const lvl = findLevel(tok);
    const ov = findOverlay(tok);
    if (lvl) state.level = lvl;
    else if (ov) state.overlay = ov;
    else if (MODES.some((m) => m.id === tok)) state.mode = tok;
    else if (MODELS.some((m) => m.id === tok)) state.model = tok;
    else if (!Number.isNaN(Number(tok))) nums.push(Number(tok));
  }
  if (nums.length >= 2) state.view = { lat: nums[0], lon: nums[1], zoom: nums.length >= 3 ? Math.round(nums[2]) : 7 };
  return state;
}

const state = parseState();
state.time = Date.now();
state.units = {};
state.hoverBlock = null;
state.dataEnd = null;

function writeState() {
  const c = map.getCenter();
  const q = `?${state.overlay.id},${state.level.id},${state.mode},${state.model},${c.lat.toFixed(3)},${c.lng.toFixed(3)},${map.getZoom()}`;
  history.replaceState(null, '', q);
}

function unitFor(kind) {
  const list = UNITS[kind];
  return list[(state.units[kind] || 0) % list.length];
}

// ---- Map ----

const map = L.map('map', {
  zoomControl: false,
  minZoom: 3,
  maxZoom: 12,
  zoomSnap: 0.25,
  worldCopyJump: true,
  maxBounds: [
    [-85, -720],
    [85, 720],
  ],
});
if (state.view) map.setView([state.view.lat, state.view.lon], state.view.zoom);
else map.fitBounds(BIHAR_BOUNDS, { padding: [30, 30] });

map.attributionControl.setPrefix(
  '<a href="https://leafletjs.com">Leaflet</a> · Weather <a href="https://open-meteo.com">Open-Meteo</a>, air quality CAMS (CC BY 4.0)',
);

map.createPane('weather').style.zIndex = 350;
map.createPane('mask').style.zIndex = 380;
map.createPane('boundaries').style.zIndex = 420;
map.createPane('labels').style.zIndex = 450;
map.createPane('districtLabels').style.zIndex = 460;
map.createPane('pin').style.zIndex = 470;

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
L.tileLayer(`${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
  maxNativeZoom: 16,
  attribution: 'Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
}).addTo(map);
L.tileLayer(`${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
  maxNativeZoom: 16,
  pane: 'labels',
}).addTo(map);

const layer = new WeatherLayer();
layer.setTime(state.time);
layer.addTo(map);
layer.on('range', renderLegend);
layer.setFormat((v) => {
  const u = unitFor(state.overlay.kind);
  return u.f(v).toFixed(u.dp ?? 0);
});

// ---- Navigation: zoom in / zoom out / home ----

const ICONS = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/></svg>',
};

function goHome() {
  map.flyToBounds(BIHAR_BOUNDS, { padding: [30, 30], duration: 0.8 });
}

const NavControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const bar = L.DomUtil.create('div', 'nav-bar panel');
    const add = (title, icon, fn) => {
      const b = L.DomUtil.create('button', 'nav-btn', bar);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = icon;
      L.DomEvent.on(b, 'click', (e) => {
        L.DomEvent.stop(e);
        fn();
      });
    };
    add('Zoom in', ICONS.plus, () => map.zoomIn());
    add('Zoom out', ICONS.minus, () => map.zoomOut());
    add('Home: back to Bihar', ICONS.home, goHome);
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.disableScrollPropagation(bar);
    return bar;
  },
});
new NavControl().addTo(map);

// ---- Bihar boundaries (converted from the block / district shapefiles) ----

const boundaries = { blocks: null, districts: null, outline: null, ring: null, mask: null, labels: L.layerGroup() };

const BLOCK_STYLE = { color: '#ffffff', weight: 0.6, opacity: 0.3, fillColor: '#ffffff', fillOpacity: 0 };
const BLOCK_HOVER = { color: '#f0b429', weight: 2.2, opacity: 1, fillOpacity: 0.1 };

// "Wind 4 kt NE" / "Rain 0.4 mm/h · wind 4 kt NE" at a point, or ''.
function describe(latlng) {
  const v = layer.valueAt(latlng);
  if (!v) return '';
  const def = state.overlay;
  const wind = Number.isNaN(v.u) ? '' : `${formatValue(Math.hypot(v.u, v.v), unitFor('speed'))} ${compass(windFrom(v.u, v.v))}`;
  if (def.id === 'wind') return wind ? `Wind ${wind}` : '';
  const main = `${def.label} ${formatValue(v.value, unitFor(def.kind))}`;
  return wind ? `${main} · wind ${wind}` : main;
}

let hovered = null;

function unhover(lyr) {
  boundaries.blocks.resetStyle(lyr);
  lyr.closeTooltip();
  if (hovered === lyr) {
    hovered = null;
    state.hoverBlock = null;
  }
}

// latlng is null for the initial tooltip, before the mouse has moved over the block.
function blockTip(p, latlng) {
  const values = latlng ? describe(latlng) : '';
  return `<b>${esc(p.Block)}</b><div class="tip-sub">${esc(p.District)} district · ${esc(p.Zone)}</div>${
    values ? `<div class="tip-val">${esc(values)}</div>` : ''
  }`;
}

async function loadBoundaries() {
  const [blocks, districts, outline] = await Promise.all(
    ['blocks', 'districts', 'outline'].map((n) => fetch(`data/bihar-${n}.geojson`).then((r) => r.json())),
  );

  boundaries.blocks = L.geoJSON(blocks, {
    pane: 'boundaries',
    style: BLOCK_STYLE,
    onEachFeature(feature, lyr) {
      // Start with the block name so the tooltip is never an empty bubble.
      lyr.bindTooltip(blockTip(feature.properties, null), { sticky: true, className: 'block-tip', direction: 'top', offset: [0, -8] });
      lyr.on({
        mouseover(e) {
          // bringToFront can swallow the previous block's mouseout, so clear it here.
          if (hovered && hovered !== e.target) unhover(hovered);
          hovered = e.target;
          state.hoverBlock = feature.properties;
          e.target.setStyle(BLOCK_HOVER);
          e.target.bringToFront();
        },
        mousemove(e) {
          e.target.setTooltipContent(blockTip(feature.properties, e.latlng));
        },
        mouseout(e) {
          unhover(e.target);
        },
      });
    },
  });

  boundaries.districts = L.geoJSON(districts, {
    pane: 'boundaries',
    interactive: false,
    style: { color: '#ffffff', weight: 1.4, opacity: 0.7, fill: false },
  });
  for (const f of districts.features) {
    const p = f.properties;
    L.marker([p.Y, p.X], {
      pane: 'districtLabels',
      interactive: false,
      icon: L.divIcon({ className: 'district-label', html: esc(p.DIST_NAME.replace(/\s*\(.*\)/, '')), iconSize: null }),
    }).addTo(boundaries.labels);
  }

  // The longest outline line is Bihar's outer border; the rest are slivers.
  const lines = outline.features[0].geometry.coordinates;
  boundaries.ring = lines.reduce((a, b) => (b.length > a.length ? b : a));
  const ringLatLng = boundaries.ring.map(([lon, lat]) => [lat, lon]);
  boundaries.outline = L.layerGroup([
    L.polyline(ringLatLng, { pane: 'boundaries', interactive: false, color: '#000', weight: 7, opacity: 0.35 }),
    L.polyline(ringLatLng, { pane: 'boundaries', interactive: false, color: '#ffe08a', weight: 2.6, opacity: 1 }),
  ]);
  // Dims everything outside Bihar in Bihar mode.
  boundaries.mask = L.polygon(
    [
      [
        [-85, -540],
        [-85, 540],
        [85, 540],
        [85, -540],
      ],
      ringLatLng,
    ],
    { pane: 'mask', interactive: false, stroke: false, fillColor: '#05070b', fillOpacity: 0.6 },
  );

  boundaries.districts.addTo(map);
  boundaries.outline.addTo(map);
  updateBoundaryDetail();
  applyMode();
}

// Block lines and district names are clutter when zoomed out, so they need zoom >= 7.
function updateBoundaryDetail() {
  if (!boundaries.blocks) return;
  const zoomed = map.getZoom() >= 7;
  for (const [lyr, on] of [
    [boundaries.blocks, zoomed && $('blocks').checked],
    [boundaries.labels, zoomed && $('district-names').checked],
  ]) {
    if (on && !map.hasLayer(lyr)) lyr.addTo(map);
    if (!on) lyr.remove();
  }
}

map.on('zoomend', updateBoundaryDetail);

// ---- Data loading ----

// Requests are never aborted (a call that was paid for is cached instead);
// reqId only discards results of superseded loads.
let reqId = 0;
let loadedOnce = false;

function status(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('show', Boolean(msg));
  el.classList.toggle('error', isError);
}

const modelLabel = () => MODELS.find((m) => m.id === state.model).label.replace(/\s*\(.*\)/, '');

async function load() {
  const id = ++reqId;
  const def = state.overlay;
  const [speedVar, dirVar] = windVars(state.level);
  const scalarVar = def.id === 'wind' ? null : overlayVar(def, state.level);
  const vars = [
    { src: 'forecast', name: speedVar },
    { src: 'forecast', name: dirVar },
  ];
  if (scalarVar) vars.push({ src: def.src, name: scalarVar });
  status(`Loading ${def.label.toLowerCase()}…`);
  try {
    const request = { model: state.model, vars };
    const g =
      state.mode === 'bihar'
        ? await fetchGrid(BIHAR_BOUNDS.pad(0.04), request, BIHAR_STEP)
        : await fetchGrid(map.getBounds(), request);
    if (id !== reqId) return;
    const wind = windField(g.fields[speedVar], g.fields[dirVar]);
    let scalar = scalarVar ? g.fields[scalarVar] : null;
    if (scalar && def.accumulate) scalar = accumulateField(scalar, Date.now());
    layer.setData(g, wind, scalar, def);

    // The timeline spans the longest series; note where a shorter layer ends.
    const spans = [wind?.times, scalar?.times].filter(Boolean);
    const times = spans.reduce((a, b) => (b[b.length - 1] > a[a.length - 1] ? b : a), spans[0]);
    state.dataEnd = scalar && times && scalar.times[scalar.times.length - 1] < times[times.length - 1] ? scalar.times[scalar.times.length - 1] : null;
    if (times) setupTimeline(times, !loadedOnce);
    loadedOnce = true;
    renderLegend();
    if (scalarVar && !scalar) status(`${def.label} is not provided by ${modelLabel()} — try another model`, true);
    else if (!wind) status(`No wind data from ${modelLabel()} at this altitude`, true);
    else status('');
  } catch (err) {
    if (id === reqId) status(err.message, true);
  }
}

let moveTimer = 0;
map.on('moveend', () => {
  writeState();
  clearTimeout(moveTimer);
  moveTimer = setTimeout(load, 250);
});

// ---- Bihar / whole-map mode ----

function applyMode() {
  const bihar = state.mode === 'bihar';
  layer.setClip(bihar && boundaries.ring ? boundaries.ring : null);
  if (boundaries.mask) {
    if (bihar) boundaries.mask.addTo(map);
    else boundaries.mask.remove();
  }
}

function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  applyMode();
  renderControls();
  if (mode === 'bihar') goHome();
  else map.flyTo(BIHAR_BOUNDS.getCenter(), 5, { duration: 0.8 });
  // flyTo ends in moveend, which reloads the grid for the new mode.
}

// ---- Layer menu / level / model / view controls ----

function renderControls() {
  $('modes').innerHTML = MODES.map(
    (m) => `<button data-mode="${m.id}" class="${m.id === state.mode ? 'active' : ''}">${m.label}</button>`,
  ).join('');
  $('model').innerHTML = MODELS.map(
    (m) => `<option value="${m.id}"${m.id === state.model ? ' selected' : ''}>${esc(m.label)}</option>`,
  ).join('');
  $('overlays').innerHTML = GROUPS.map(
    (g) => `<div class="ov-group"><div class="ov-title">${esc(g)}</div>${OVERLAYS.filter((o) => o.group === g)
      .map((o) => `<button data-overlay="${o.id}" class="${o === state.overlay ? 'active' : ''}">${esc(o.label)}</button>`)
      .join('')}</div>`,
  ).join('');
  $('levels').innerHTML = [...LEVELS]
    .reverse()
    .map(
      (l) =>
        `<button data-level="${l.id}" title="${l.label}" class="${l.id === state.level.id ? 'active' : ''}${
          usesLevel(state.overlay, l) ? '' : ' wind-only'
        }">${l.short}</button>`,
    )
    .join('');
  $('levels').title = state.overlay.levelVar || state.overlay.id === 'wind' ? 'Altitude' : `${state.overlay.label} is surface-only; altitude changes the wind particles`;
}

$('modes').addEventListener('click', (e) => {
  const id = e.target.dataset?.mode;
  if (id) setMode(id);
});

$('overlays').addEventListener('click', (e) => {
  const def = findOverlay(e.target.dataset?.overlay);
  if (!def || def === state.overlay) return;
  state.overlay = def;
  renderControls();
  renderLegend();
  writeState();
  load();
  refreshDetail(); // the meteogram plots the active layer
  document.body.classList.remove('menu-open');
});

$('levels').addEventListener('click', (e) => {
  const lvl = findLevel(e.target.dataset?.level);
  if (!lvl || lvl === state.level) return;
  state.level = lvl;
  renderControls();
  writeState();
  load();
  refreshDetail();
});

$('model').addEventListener('change', (e) => {
  state.model = e.target.value;
  writeState();
  load();
  refreshDetail();
});

$('menu-toggle').addEventListener('click', () => document.body.classList.toggle('menu-open'));
$('particles').addEventListener('change', (e) => layer.setParticles(e.target.checked));
$('enhance').addEventListener('change', (e) => layer.setEnhance(e.target.checked));
$('blocks').addEventListener('change', updateBoundaryDetail);
$('district-names').addEventListener('change', updateBoundaryDetail);

// ---- Legend (click to cycle units) ----

function renderLegend() {
  const def = state.overlay;
  const unit = unitFor(def.kind);
  const range = layer.getRange();
  const stops = def.stops;
  const fmt = (v, span) => {
    const x = unit.f(v);
    return x.toFixed(unit.dp ?? (span < 8 ? 1 : 0));
  };
  let ticks;
  let gradient;
  let note = '';
  if (range) {
    // Contrast stretch: the vivid part of the palette spans lo..hi of the loaded data.
    const span = unit.f(range.hi) - unit.f(range.lo);
    ticks = [0, 0.25, 0.5, 0.75, 1]
      .map((f) => `<span style="left:${f * 100}%">${fmt(range.lo + (range.hi - range.lo) * f, span)}</span>`)
      .join('');
    gradient = gradientCss(stops, ...(def.vivid || [stops[0][0], stops[stops.length - 1][0]]));
    note = ' · enhanced';
  } else {
    const min = stops[0][0];
    const max = stops[stops.length - 1][0];
    const every = Math.ceil(stops.length / 6);
    ticks = stops
      .filter((_, i) => i % every === 0 || i === stops.length - 1)
      .map(([v]) => `<span style="left:${((v - min) / (max - min)) * 100}%">${fmt(v, unit.f(max) - unit.f(min))}</span>`)
      .join('');
    gradient = gradientCss(stops);
  }
  if (state.dataEnd) note += ` · data until ${new Date(state.dataEnd).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}`;
  $('legend').innerHTML = `<div class="legend-unit"><b>${esc(def.label)}</b> ${esc(unit.id)}${esc(note)}</div>
    <div class="legend-bar" style="background-image:${gradient}"></div>
    <div class="legend-ticks">${ticks}</div>`;
}

$('legend').addEventListener('click', () => {
  const kind = state.overlay.kind;
  state.units[kind] = (state.units[kind] || 0) + 1;
  renderLegend();
  layer.redraw(); // isoline labels use the new unit
  renderDetailPanel();
});

// ---- Timeline ----

const slider = $('time');
let playTimer = 0;

function fmtTime(ms) {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const THUMB = 18; // px, matches --thumb in style.css

// Horizontal centre of the slider thumb for a fraction 0..1 of the range, as CSS.
const thumbCss = (frac) => `calc(${THUMB / 2}px + ${frac} * (100% - ${THUMB}px))`;

// Keeps the time bubble centred over the thumb, clamped inside the track; the
// bubble's arrow shifts by the clamped amount so it still points at the thumb.
function placeBubble() {
  const bubble = $('time-label');
  const min = Number(slider.min);
  const max = Number(slider.max);
  const frac = max > min ? (Number(slider.value) - min) / (max - min) : 0;
  const width = slider.clientWidth;
  const x = THUMB / 2 + frac * (width - THUMB);
  const half = bubble.offsetWidth / 2;
  const left = Math.max(half, Math.min(width - half, x));
  bubble.style.left = `${left}px`;
  bubble.style.setProperty('--arrow', `${x - left}px`);
  slider.style.setProperty('--fill', `${(x / width) * 100}%`);
}

function setTime(ms) {
  state.time = ms;
  slider.value = ms;
  $('time-label').textContent = fmtTime(ms);
  placeBubble();
  layer.setTime(ms);
  syncDetailTime();
}

window.addEventListener('resize', placeBubble);

function setupTimeline(times, first) {
  const start = times[0];
  const end = times[times.length - 1];
  slider.min = start;
  slider.max = end;
  slider.step = 15 * 60000;
  setTime(Math.max(start, Math.min(end, first ? Date.now() : state.time)));
  const days = (end - start) / 86400000;
  const every = Math.max(1, Math.ceil((days * 56) / Math.max(slider.clientWidth, 200)));
  let html = '';
  let n = 0;
  for (const t of times) {
    const d = new Date(t);
    if (d.getHours() !== 12 || n++ % every) continue;
    html += `<span style="left:${thumbCss((t - start) / (end - start))}">${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</span>`;
  }
  $('days').innerHTML = html;
}

slider.addEventListener('input', () => setTime(Number(slider.value)));

$('play').addEventListener('click', () => {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = 0;
    $('play').textContent = '▶';
    return;
  }
  $('play').textContent = '❚❚';
  playTimer = setInterval(() => {
    const next = state.time + 30 * 60000;
    setTime(next > Number(slider.max) ? Number(slider.min) : next);
  }, 100);
});

// ---- Hover readout ----

map.on('mousemove', (e) => {
  const text = describe(e.latlng);
  const place = state.hoverBlock ? `${state.hoverBlock.Block}, ${state.hoverBlock.District}  ·  ` : '';
  $('readout').textContent = text ? `${text}  ·  ${place}${e.latlng.lat.toFixed(2)}, ${e.latlng.lng.toFixed(2)}` : '';
});
map.on('mouseout', () => ($('readout').textContent = ''));

// ---- Point forecast panel under the timeline (click anywhere on the map) ----

const detailEl = $('detail');
const pin = L.circleMarker([0, 0], { pane: 'pin', radius: 7, color: '#fff', weight: 2.5, fillColor: '#f0b429', fillOpacity: 1, interactive: false });
let detail = null; // { f, latlng, place, tab, req }
let detailReq = 0;
const nameFor = (def) => overlayVar(def, state.level);

function setDetailOpen(open) {
  if (document.body.classList.contains('detail-open') === open) return;
  document.body.classList.toggle('detail-open', open);
  map.invalidateSize();
  placeBubble();
}

function renderDetailPanel(scroll = false) {
  if (!detail?.f) return;
  detailEl.innerHTML = renderDetail(detail.f, {
    tab: detail.tab,
    place: detail.place,
    model: modelLabel(),
    level: state.level,
    def: state.overlay,
    time: state.time,
    unitFor,
    nameFor,
    chartWidth: Math.max(320, detailEl.clientWidth - 48),
  });
  const sel = detailEl.querySelector('.dt-table .sel');
  const box = detailEl.querySelector('.dt-scroll');
  if (scroll && sel && box) box.scrollLeft = sel.offsetLeft - box.clientWidth / 3;
}

async function openDetail(latlng, place) {
  const id = ++detailReq;
  detail = { f: null, latlng, place, tab: detail?.tab || 'basic' };
  pin.setLatLng(latlng).addTo(map);
  detailEl.innerHTML = `<div class="dt-msg">Loading forecast for ${esc(place)}…</div>`;
  setDetailOpen(true);
  const names = new Set(['wind_speed_10m', 'wind_direction_10m', ...windVars(state.level), ...DETAIL_VARS]);
  for (const o of OVERLAYS) if (o.src === 'forecast' && o.var) names.add(o.var);
  names.add(nameFor(findOverlay('temp')));
  if (state.overlay.src === 'forecast' && state.overlay.var) names.add(nameFor(state.overlay));
  const airNames = OVERLAYS.filter((o) => o.src === 'air').map((o) => o.var);
  try {
    const f = await fetchPoint(latlng.lat, latlng.lng, state.model, [...names], airNames);
    if (id !== detailReq || !detail) return;
    detail.f = f;
    renderDetailPanel(true);
  } catch (err) {
    if (id === detailReq) detailEl.innerHTML = `<div class="dt-msg error">${esc(err.message)}</div>`;
  }
}

function closeDetail() {
  detail = null;
  detailReq++;
  pin.remove();
  setDetailOpen(false);
}

// Reloads the open panel, e.g. after the model or altitude changed.
function refreshDetail() {
  if (detail) openDetail(detail.latlng, detail.place);
}

// Keeps the panel's highlighted column (or meteogram marker) on the map time.
function syncDetailTime() {
  if (!detail?.f) return;
  if (detail.tab === 'meteogram') renderDetailPanel();
  else markTime(detailEl, detail.f, state.time);
}

detailEl.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (tab && detail) {
    detail.tab = tab;
    renderDetailPanel(true);
    return;
  }
  if (e.target.closest('[data-close]')) {
    closeDetail();
    return;
  }
  // Clicking a column moves the map to that time.
  const t = e.target.closest('[data-t]')?.dataset.t;
  if (t) setTime(Number(t));
});

map.on('click', (e) => {
  const b = state.hoverBlock;
  const place = b ? `${b.Block} · ${b.District}` : `${e.latlng.lat.toFixed(2)}°, ${e.latlng.lng.toFixed(2)}°`;
  openDetail(e.latlng, place);
});

// ---- API usage (estimated Open-Meteo calls today; free tier ≈ 10,000/day) ----

function renderUsage(u = readUsage()) {
  const loads = u.fetched + u.cached;
  const share = loads ? Math.round((u.cached / loads) * 100) : 0;
  $('usage-text').textContent = `≈ ${Math.round(u.calls).toLocaleString()} API calls today · ${share}% loaded from cache`;
}

onUsage(renderUsage);
$('clear-cache').addEventListener('click', async () => {
  if (!confirm('Delete all cached forecasts? The next views will spend API calls again.')) return;
  await clearAll();
  location.reload();
});

renderControls();
renderLegend();
renderUsage();
writeState();
pruneOldDates().finally(load);
loadBoundaries().catch((err) => status(`Could not load Bihar boundaries: ${err.message}`, true));
