// Catalogue of map layers. Values stay in the API's base units; `kind` picks
// the display units, `stops` the colour scale ([value, [r, g, b, alpha?]]).
//
//   src         'forecast' (Open-Meteo weather) or 'air' (Open-Meteo / CAMS air quality)
//   var         Open-Meteo hourly variable
//   levelVar    optional (level) => variable at that altitude, or null for surface only
//   stretch     contrast enhancement allowed (not for layers whose zero is transparent)
//   vivid       part of the scale that a stretched range is mapped onto
//   accumulate  show the running total from now instead of hourly values
//   contour     isoline interval in base units

export const UNITS = {
  speed: [
    { id: 'kt', f: (v) => v * 1.94384 },
    { id: 'm/s', f: (v) => v },
    { id: 'km/h', f: (v) => v * 3.6 },
    { id: 'mph', f: (v) => v * 2.23694 },
  ],
  temp: [
    { id: '°C', f: (v) => v },
    { id: '°F', f: (v) => (v * 9) / 5 + 32 },
  ],
  precip: [
    { id: 'mm', f: (v) => v },
    { id: 'in', f: (v) => v / 25.4, dp: 2 },
  ],
  rate: [
    { id: 'mm/h', f: (v) => v, dp: 1 },
    { id: 'in/h', f: (v) => v / 25.4, dp: 2 },
  ],
  percent: [{ id: '%', f: (v) => v }],
  pressure: [
    { id: 'hPa', f: (v) => v },
    { id: 'inHg', f: (v) => v * 0.02953, dp: 2 },
    { id: 'mmHg', f: (v) => v * 0.750062 },
  ],
  distance: [
    { id: 'km', f: (v) => v / 1000, dp: 1 },
    { id: 'mi', f: (v) => v / 1609.34, dp: 1 },
  ],
  height: [
    { id: 'm', f: (v) => v },
    { id: 'ft', f: (v) => v * 3.28084 },
  ],
  depth: [
    { id: 'cm', f: (v) => v * 100 },
    { id: 'in', f: (v) => v * 39.37, dp: 1 },
  ],
  cape: [{ id: 'J/kg', f: (v) => v }],
  index: [{ id: '', f: (v) => v, dp: 1 }],
  aqi: [{ id: 'US AQI', f: (v) => v }],
  radiation: [{ id: 'W/m²', f: (v) => v }],
  moisture: [{ id: '%', f: (v) => v * 100 }],
  conc: [{ id: 'µg/m³', f: (v) => v }],
  aod: [{ id: '', f: (v) => v, dp: 2 }],
};

const TEMP = [
  [-40, [230, 220, 255]],
  [-30, [160, 110, 210]],
  [-20, [90, 80, 190]],
  [-10, [50, 120, 210]],
  [0, [70, 180, 220]],
  [8, [80, 190, 150]],
  [15, [140, 200, 80]],
  [22, [235, 210, 70]],
  [28, [240, 150, 50]],
  [34, [220, 70, 50]],
  [42, [140, 20, 40]],
];

const WIND = [
  [0, [37, 74, 143]],
  [2, [42, 118, 176]],
  [4, [38, 160, 170]],
  [6, [52, 170, 110]],
  [8, [120, 190, 70]],
  [11, [225, 205, 60]],
  [14, [240, 150, 45]],
  [18, [220, 80, 50]],
  [24, [180, 40, 90]],
  [32, [130, 40, 150]],
  [45, [190, 140, 220]],
  [65, [240, 230, 250]],
];

const CLOUDS = [
  [0, [0, 0, 0, 0]],
  [10, [200, 210, 220, 30]],
  [40, [215, 220, 230, 110]],
  [70, [230, 235, 240, 175]],
  [100, [250, 250, 255, 225]],
];

// Good -> hazardous, shared by the air-quality layers with their own breakpoints.
const AQ_COLORS = [
  [60, 170, 90],
  [140, 200, 70],
  [240, 220, 60],
  [240, 140, 40],
  [220, 40, 40],
  [140, 50, 150],
  [90, 10, 30],
];
const aq = (...breaks) => breaks.map((v, i) => [v, AQ_COLORS[i]]);

const isPressureLevel = (lvl) => lvl.id.endsWith('h');

export const GROUPS = ['Wind', 'Rain & storms', 'Temperature', 'Clouds & visibility', 'Pressure', 'Sun', 'Land', 'Air quality'];

export const OVERLAYS = [
  // Wind is special: computed from speed + direction at the selected level.
  { id: 'wind', label: 'Wind', group: 'Wind', src: 'forecast', kind: 'speed', stops: WIND, stretch: true, vivid: [0, 24] },
  { id: 'gust', label: 'Wind gusts', group: 'Wind', src: 'forecast', var: 'wind_gusts_10m', kind: 'speed', stops: WIND, stretch: true, vivid: [0, 32] },

  {
    id: 'rain',
    label: 'Rain, thunder',
    group: 'Rain & storms',
    src: 'forecast',
    var: 'precipitation',
    kind: 'rate',
    stops: [
      [0, [0, 0, 0, 0]],
      [0.1, [100, 150, 230, 110]],
      [0.5, [70, 130, 230, 200]],
      [1, [40, 170, 200, 230]],
      [2, [60, 190, 90, 240]],
      [4, [230, 220, 60, 250]],
      [8, [240, 140, 40]],
      [15, [220, 50, 50]],
      [30, [190, 40, 160]],
      [50, [240, 200, 255]],
    ],
  },
  {
    id: 'rainaccu',
    label: 'Rain accumulation',
    group: 'Rain & storms',
    src: 'forecast',
    var: 'precipitation',
    kind: 'precip',
    accumulate: true,
    stops: [
      [0, [0, 0, 0, 0]],
      [1, [120, 170, 230, 140]],
      [5, [60, 140, 220, 210]],
      [10, [40, 180, 190, 230]],
      [25, [70, 190, 80, 240]],
      [50, [230, 220, 60, 250]],
      [100, [240, 140, 40]],
      [200, [220, 50, 50]],
      [400, [180, 40, 160]],
      [800, [240, 200, 255]],
    ],
  },
  {
    id: 'rainprob',
    label: 'Rain probability',
    group: 'Rain & storms',
    src: 'forecast',
    var: 'precipitation_probability',
    kind: 'percent',
    stops: [
      [0, [0, 0, 0, 0]],
      [10, [80, 120, 200, 60]],
      [30, [70, 140, 220, 160]],
      [50, [50, 170, 200, 210]],
      [70, [60, 190, 100, 230]],
      [90, [230, 210, 60, 245]],
      [100, [240, 140, 40]],
    ],
  },
  {
    id: 'cape',
    label: 'CAPE (thunderstorm energy)',
    group: 'Rain & storms',
    src: 'forecast',
    var: 'cape',
    kind: 'cape',
    stops: [
      [0, [0, 0, 0, 0]],
      [100, [90, 150, 200, 90]],
      [500, [80, 180, 120, 180]],
      [1000, [220, 210, 60, 220]],
      [2000, [240, 140, 40, 240]],
      [3000, [220, 50, 50, 250]],
      [4500, [190, 40, 160]],
      [6000, [240, 200, 255]],
    ],
  },
  {
    id: 'snow',
    label: 'Snow depth',
    group: 'Rain & storms',
    src: 'forecast',
    var: 'snow_depth',
    kind: 'depth',
    stops: [
      [0, [0, 0, 0, 0]],
      [0.01, [200, 220, 255, 120]],
      [0.1, [150, 190, 250, 200]],
      [0.5, [100, 140, 240]],
      [1, [150, 90, 220]],
      [3, [240, 220, 255]],
    ],
  },

  {
    id: 'temp',
    label: 'Temperature',
    group: 'Temperature',
    src: 'forecast',
    var: 'temperature_2m',
    levelVar: (lvl) => `temperature_${lvl.temp}`,
    kind: 'temp',
    stops: TEMP,
    stretch: true,
    vivid: [-20, 42],
  },
  { id: 'feel', label: 'Feels like', group: 'Temperature', src: 'forecast', var: 'apparent_temperature', kind: 'temp', stops: TEMP, stretch: true, vivid: [-20, 42] },
  {
    id: 'dewpoint',
    label: 'Dew point',
    group: 'Temperature',
    src: 'forecast',
    var: 'dew_point_2m',
    levelVar: (lvl) => (isPressureLevel(lvl) ? `dew_point_${lvl.wind}` : null),
    kind: 'temp',
    stops: TEMP,
    stretch: true,
    vivid: [-20, 42],
  },
  {
    id: 'rh',
    label: 'Humidity',
    group: 'Temperature',
    src: 'forecast',
    var: 'relative_humidity_2m',
    levelVar: (lvl) => (isPressureLevel(lvl) ? `relative_humidity_${lvl.wind}` : null),
    kind: 'percent',
    stretch: true,
    stops: [
      [0, [170, 110, 50]],
      [30, [210, 170, 90]],
      [50, [190, 200, 110]],
      [70, [80, 180, 140]],
      [85, [50, 140, 200]],
      [100, [40, 70, 170]],
    ],
  },

  {
    id: 'clouds',
    label: 'Clouds',
    group: 'Clouds & visibility',
    src: 'forecast',
    var: 'cloud_cover',
    levelVar: (lvl) => (isPressureLevel(lvl) ? `cloud_cover_${lvl.wind}` : null),
    kind: 'percent',
    stops: CLOUDS,
  },
  { id: 'lclouds', label: 'Low clouds', group: 'Clouds & visibility', src: 'forecast', var: 'cloud_cover_low', kind: 'percent', stops: CLOUDS },
  { id: 'mclouds', label: 'Medium clouds', group: 'Clouds & visibility', src: 'forecast', var: 'cloud_cover_mid', kind: 'percent', stops: CLOUDS },
  { id: 'hclouds', label: 'High clouds', group: 'Clouds & visibility', src: 'forecast', var: 'cloud_cover_high', kind: 'percent', stops: CLOUDS },
  {
    id: 'visibility',
    label: 'Visibility / fog',
    group: 'Clouds & visibility',
    src: 'forecast',
    var: 'visibility',
    kind: 'distance',
    stops: [
      [0, [235, 235, 245, 240]],
      [1000, [200, 200, 215, 220]],
      [3000, [160, 170, 190, 190]],
      [8000, [100, 130, 170, 150]],
      [15000, [60, 90, 140, 110]],
      [30000, [30, 50, 90, 60]],
    ],
  },

  {
    id: 'pressure',
    label: 'Pressure (isobars)',
    group: 'Pressure',
    src: 'forecast',
    var: 'pressure_msl',
    kind: 'pressure',
    stretch: true,
    contour: 2,
    stops: [
      [990, [130, 40, 150]],
      [1000, [60, 90, 200]],
      [1006, [60, 160, 200]],
      [1012, [90, 190, 120]],
      [1018, [230, 210, 80]],
      [1025, [240, 140, 50]],
      [1035, [210, 60, 60]],
    ],
  },
  {
    id: 'freezing',
    label: 'Freezing altitude',
    group: 'Pressure',
    src: 'forecast',
    var: 'freezing_level_height',
    kind: 'height',
    stretch: true,
    stops: [
      [0, [230, 230, 255]],
      [1000, [150, 120, 220]],
      [2500, [70, 110, 210]],
      [4000, [60, 180, 190]],
      [5000, [110, 200, 100]],
      [6000, [240, 200, 70]],
    ],
  },

  {
    id: 'uv',
    label: 'UV index',
    group: 'Sun',
    src: 'forecast',
    var: 'uv_index',
    kind: 'index',
    stops: [
      [0, [0, 0, 0, 0]],
      [1, [80, 180, 90, 140]],
      [3, [200, 210, 60, 210]],
      [6, [240, 140, 40, 230]],
      [8, [220, 50, 50, 240]],
      [11, [160, 60, 200, 250]],
      [14, [230, 190, 255]],
    ],
  },
  {
    id: 'solar',
    label: 'Solar radiation',
    group: 'Sun',
    src: 'forecast',
    var: 'shortwave_radiation',
    kind: 'radiation',
    stops: [
      [0, [0, 0, 0, 0]],
      [100, [120, 80, 40, 100]],
      [300, [200, 120, 40, 170]],
      [600, [240, 180, 50, 220]],
      [900, [255, 230, 120, 240]],
      [1100, [255, 250, 220]],
    ],
  },

  { id: 'soiltemp', label: 'Soil temperature', group: 'Land', src: 'forecast', var: 'soil_temperature_0cm', kind: 'temp', stops: TEMP, stretch: true, vivid: [-20, 42] },
  {
    id: 'soilmoist',
    label: 'Soil moisture',
    group: 'Land',
    src: 'forecast',
    var: 'soil_moisture_0_to_1cm',
    kind: 'moisture',
    stretch: true,
    stops: [
      [0, [150, 90, 40]],
      [0.1, [200, 160, 80]],
      [0.2, [180, 200, 110]],
      [0.3, [80, 180, 140]],
      [0.4, [50, 130, 200]],
      [0.5, [40, 60, 160]],
    ],
  },
  {
    id: 'et0',
    label: 'Evapotranspiration',
    group: 'Land',
    src: 'forecast',
    var: 'et0_fao_evapotranspiration',
    kind: 'rate',
    stops: [
      [0, [40, 60, 120, 40]],
      [0.1, [60, 140, 170, 160]],
      [0.3, [90, 190, 110, 210]],
      [0.5, [230, 210, 60, 230]],
      [0.8, [240, 140, 40]],
      [1.2, [220, 50, 50]],
    ],
  },

  { id: 'aqi', label: 'Air quality index', group: 'Air quality', src: 'air', var: 'us_aqi', kind: 'aqi', stops: aq(0, 50, 100, 150, 200, 300, 500) },
  { id: 'pm2p5', label: 'PM2.5', group: 'Air quality', src: 'air', var: 'pm2_5', kind: 'conc', stops: aq(0, 12, 35, 55, 150, 250, 500) },
  { id: 'pm10', label: 'PM10', group: 'Air quality', src: 'air', var: 'pm10', kind: 'conc', stops: aq(0, 54, 154, 254, 354, 424, 600) },
  { id: 'no2', label: 'NO₂', group: 'Air quality', src: 'air', var: 'nitrogen_dioxide', kind: 'conc', stops: aq(0, 40, 90, 120, 230, 340, 500) },
  { id: 'o3', label: 'Ozone (O₃)', group: 'Air quality', src: 'air', var: 'ozone', kind: 'conc', stops: aq(0, 50, 100, 130, 240, 380, 500) },
  { id: 'co', label: 'Carbon monoxide', group: 'Air quality', src: 'air', var: 'carbon_monoxide', kind: 'conc', stops: aq(0, 1000, 2000, 4000, 10000, 20000, 40000) },
  { id: 'so2', label: 'SO₂', group: 'Air quality', src: 'air', var: 'sulphur_dioxide', kind: 'conc', stops: aq(0, 20, 80, 250, 350, 500, 750) },
  {
    id: 'dust',
    label: 'Dust',
    group: 'Air quality',
    src: 'air',
    var: 'dust',
    kind: 'conc',
    stops: [
      [0, [0, 0, 0, 0]],
      [10, [220, 190, 120, 80]],
      [50, [210, 160, 80, 170]],
      [150, [190, 120, 50, 220]],
      [500, [150, 80, 30, 240]],
      [1500, [100, 40, 20]],
    ],
  },
  { id: 'aod', label: 'Aerosol optical depth', group: 'Air quality', src: 'air', var: 'aerosol_optical_depth', kind: 'aod', stops: aq(0, 0.1, 0.3, 0.6, 1, 2, 4) },
];

export function findOverlay(id) {
  if (!id) return null;
  const key = id.toLowerCase();
  return OVERLAYS.find((o) => o.id === key) || null;
}

// Open-Meteo variable for an overlay at a level (wind is handled separately).
export function overlayVar(def, level) {
  return (def.levelVar && def.levelVar(level)) || def.var;
}

export function usesLevel(def, level) {
  return def.id === 'wind' || Boolean(def.levelVar && def.levelVar(level));
}

export function formatValue(v, unit) {
  if (v == null || Number.isNaN(v)) return '–';
  const x = unit.f(v);
  const dp = unit.dp ?? (Math.abs(x) < 10 && x % 1 !== 0 ? 1 : 0);
  return `${x.toFixed(dp)}${unit.id ? ` ${unit.id}` : ''}`;
}
