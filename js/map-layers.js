// Reference layers from BMSK's ArcGIS server (the same services the official
// Bihar dashboard uses): weather stations, rain gauges, highways, roads, rivers.
// Each layer is fetched as GeoJSON the first time it is switched on, then kept.

import { esc } from './forecast.js';

const ARCGIS = 'https://mausamsewa.bihar.gov.in/server/rest/services';
// Server-side page size limit (maxRecordCount).
const PAGE = 2000;

const STATION_FIELDS = 'TYPE_OF_ST,DISTRICT,BLOCK,RAINFALL,TEMPERATURE,HUMIDITY,WIND_SPEED,WIND_DIRECTION,RECORDED_TIME';

// id = the checkbox id in index.html.
const DEFS = [
  {
    id: 'lyr-aws',
    url: `${ARCGIS}/Bihar_Dashboard_Layer_Hindi/MapServer/0`,
    where: "TYPE_OF_ST='AWS'",
    fields: STATION_FIELDS,
    pane: 'stations',
    point: { radius: 3.4, color: '#0b0e13', weight: 1, fillColor: '#f0b429', fillOpacity: 1 },
  },
  {
    id: 'lyr-arg',
    url: `${ARCGIS}/Bihar_Dashboard_Layer_Hindi/MapServer/0`,
    where: "TYPE_OF_ST='ARG'",
    fields: STATION_FIELDS,
    pane: 'stations',
    point: { radius: 2.4, color: '#0b0e13', weight: 0.6, fillColor: '#7cc4ff', fillOpacity: 0.9 },
  },
  {
    id: 'lyr-nh',
    url: `${ARCGIS}/BiharAddOns/MapServer/3`,
    pane: 'refLines',
    style: { color: '#ff9f43', weight: 2.2, opacity: 0.95, dashArray: '6 4' },
  },
  {
    id: 'lyr-roads',
    url: `${ARCGIS}/BiharAddOns/MapServer/4`,
    pane: 'refLines',
    style: { color: '#d4c9b4', weight: 1, opacity: 0.6 },
  },
  {
    id: 'lyr-rivers',
    url: `${ARCGIS}/BiharAddOns/MapServer/5`,
    pane: 'rivers',
    // Rivers are polygons; ~4 MB at full detail, ~0.3 MB simplified to ~200 m.
    simplify: 0.002,
    style: { stroke: false, fillColor: '#2bb3ff', fillOpacity: 0.55 },
  },
];

async function fetchAll(def) {
  const features = [];
  for (let offset = 0; ; offset += PAGE) {
    const q = new URLSearchParams({
      where: def.where || '1=1',
      outFields: def.fields || '',
      outSR: '4326',
      geometryPrecision: '4',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
      f: 'geojson',
    });
    if (def.simplify) q.set('maxAllowableOffset', String(def.simplify));
    const res = await fetch(`${def.url}/query?${q}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const page = await res.json();
    if (page.error) throw new Error(page.error.message || 'query failed');
    features.push(...page.features);
    const more = page.exceededTransferLimit || page.properties?.exceededTransferLimit;
    if (!more || !page.features.length) break;
  }
  return { type: 'FeatureCollection', features };
}

const fmt = (v, unit, dp = 1) => (v == null ? null : `${Number(v).toFixed(dp)}${unit}`);

function stationTip(p) {
  const kind = p.TYPE_OF_ST === 'AWS' ? 'Weather station' : 'Rain gauge';
  const rows = [
    ['Rain', fmt(p.RAINFALL, ' mm')],
    p.TYPE_OF_ST === 'AWS' && ['Temp', fmt(p.TEMPERATURE, ' °C')],
    p.TYPE_OF_ST === 'AWS' && ['Humidity', fmt(p.HUMIDITY, '%', 0)],
    p.TYPE_OF_ST === 'AWS' && ['Wind', p.WIND_SPEED == null ? null : `${fmt(p.WIND_SPEED, ' m/s')} from ${Math.round(p.WIND_DIRECTION)}°`],
  ].filter((r) => r && r[1] != null);
  // The server stores IST wall-clock time as if it were UTC, so format it as UTC.
  const when = p.RECORDED_TIME
    ? new Date(p.RECORDED_TIME).toLocaleString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : '';
  return `<b>${esc(p.BLOCK || '')}</b><div class="tip-sub">${kind} · ${esc(p.DISTRICT || '')} district</div>${rows
    .map(([k, v]) => `<div class="tip-val">${k}: ${esc(v)}</div>`)
    .join('')}${when ? `<div class="tip-sub">Recorded ${esc(when)} IST</div>` : rows.length ? '' : '<div class="tip-sub">No recent reading</div>'}`;
}

function build(def, geojson) {
  if (def.point) {
    return L.geoJSON(geojson, {
      pane: def.pane,
      pointToLayer: (f, latlng) => L.circleMarker(latlng, { ...def.point, pane: def.pane }),
      onEachFeature: (f, lyr) => lyr.bindTooltip(stationTip(f.properties), { className: 'block-tip', direction: 'top', offset: [0, -4] }),
    });
  }
  return L.geoJSON(geojson, { pane: def.pane, interactive: false, style: def.style });
}

// onError(message) reports a failed load; the checkbox is unticked again.
export function initMapLayers(map, onError) {
  map.createPane('rivers').style.zIndex = 390;
  map.createPane('refLines').style.zIndex = 410;
  // Above the block outlines. The pane itself lets the mouse through, so block
  // hover still works between stations; only the circles catch events.
  const stations = map.createPane('stations');
  stations.style.zIndex = 465;
  stations.style.pointerEvents = 'none';

  const loaded = new Map();
  for (const def of DEFS) {
    const box = document.getElementById(def.id);
    const row = box.closest('.layer-item');
    box.addEventListener('change', async () => {
      if (!box.checked) {
        loaded.get(def.id)?.then((l) => l?.remove());
        return;
      }
      if (!loaded.has(def.id)) {
        row.classList.add('loading');
        loaded.set(
          def.id,
          fetchAll(def)
            .then((gj) => build(def, gj))
            .catch((err) => {
              loaded.delete(def.id);
              box.checked = false;
              onError(`Could not load ${row.textContent.trim().toLowerCase()} from BMSK (${err.message})`);
              return null;
            })
            .finally(() => row.classList.remove('loading')),
        );
      }
      const lyr = await loaded.get(def.id);
      // The box may have been unticked while the layer was loading.
      if (lyr && box.checked) lyr.addTo(map);
    });
  }
}
