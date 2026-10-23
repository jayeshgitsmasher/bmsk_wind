# Zephyr — Windy-style weather map, focused on Bihar

A Windy-like map built entirely on free, open forecast data: 31 layers, 6 global
forecast models, a 16-day hourly timeline, animated wind particles, Bihar block and
district boundaries. No Windy code, endpoints or assets are used.

```
npm start        # http://localhost:5173/
```

## Layers

| Group | Layers |
| --- | --- |
| Wind | Wind (9 altitudes, surface to 10 km), wind gusts |
| Rain & storms | Rain/thunder rate, rain accumulation (from now), rain probability, CAPE, snow depth |
| Temperature | Temperature (by altitude), feels like, dew point, humidity |
| Clouds & visibility | Total / low / medium / high clouds, visibility & fog |
| Pressure | Sea-level pressure with labelled isobars, freezing altitude |
| Sun | UV index, solar radiation |
| Land | Soil temperature, soil moisture, evapotranspiration |
| Air quality | US AQI, PM2.5, PM10, NO₂, O₃, CO, SO₂, dust, aerosol optical depth |

Clicking anywhere gives a 16-day chart plus every parameter at the selected time.

## Forecast range by model

| Model | Days |
| --- | --- |
| Best match (Open-Meteo picks the best model per location) | 16 |
| ECMWF IFS 0.25° | 15 |
| GFS (NOAA) | 16 |
| GEM (Canada) | 10 |
| JMA (Japan) | 11 |
| ICON (DWD) | 7.5 |
| Air quality (CAMS) | ~4.5 |

Not every model provides every variable (e.g. ECMWF has no visibility or UV index);
the app says so when a layer is missing for the chosen model.

## Views and URL

- **Bihar mode** (default): weather clipped to the state, outside dimmed, fixed 0.35° grid.
  **Whole map** shows weather everywhere. **Home** (under + / −) flies back to Bihar.
- **Enhance contrast** stretches the colour scale over the loaded data's 2nd–98th percentile.
- URL: `?<layer>,<level>,<mode>,<model>,<lat>,<lon>,<zoom>`, tokens in any order, e.g.
  `?pm2p5,surface,bihar` or `?pressure,surface,world,ecmwf_ifs025,24,84,5`.

## Data and limits

Weather: [Open-Meteo](https://open-meteo.com) (CC BY 4.0), air quality: Copernicus CAMS via
Open-Meteo. The free tier is non-commercial, ~600 calls/minute and 10,000/day, and every grid
point counts as a call (one Bihar layer ≈ 325 calls with the 16-day forecast).

### API call budget: each unique request at most once per day

| Layer | Where | Key | Kept until |
| --- | --- | --- | --- |
| Memory | browser tab | date, source, model, variable, point | page closes |
| IndexedDB (`js/store.js`) | browser, any server incl. Live Server | same | the date changes (pruned on next start) |
| In-flight dedupe | browser tab | same | the request finishes |
| `server.js` proxy (`npm start` only) | `.cache/<date>-<hash>.json` | date + full request URL | the date changes |

- Only missing series are requested: switching to a new layer fetches just that variable; wind
  already loaded today is reused.
- Requests are never cancelled when you switch layers quickly, so a call that was paid for is kept.
- Point forecasts are snapped to a 0.05° (~5 km) grid, so nearby clicks share one cached response.
- The side panel shows an estimate of today's Open-Meteo calls and the share served from cache.
  **Clear cache** deletes the browser cache (forecasts are then fetched again).

Caching by date means a forecast loaded in the morning is reused for the rest of that day,
even though the models publish new runs every few hours.

## Boundary data

`data/bihar-*.geojson` were generated from `bihar_block_shapefile.zip` (BLOCK.shp, DISTRICT_BOUNDARY.shp):

```
node tools/shp2geojson.js BLOCK.shp data/bihar-blocks.geojson 0.0012
node tools/shp2geojson.js DISTRICT_BOUNDARY.shp data/bihar-districts.geojson 0.001 --outline data/bihar-outline.geojson
```

| File | Role |
| --- | --- |
| `js/params.js` | Layer catalogue: variables, colour scales, units |
| `js/data.js` | Open-Meteo fetching, models, altitude levels, per-series cache |
| `js/field.js` | Bilinear space + linear time interpolation, wind direction helpers |
| `js/weather-layer.js` | Leaflet layer: heatmap, clipping, contrast stretch, isolines, particles |
| `js/colors.js` | Colour lookup tables and legend gradients |
| `js/forecast.js` | Click-for-forecast popup |
| `js/app.js` | Map, Bihar boundaries, menus, timeline, URL state |
| `server.js` | Static server + caching API proxy |
| `tools/shp2geojson.js` | Shapefile → GeoJSON converter |
