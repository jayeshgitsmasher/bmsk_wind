// Colour-scale helpers. Stops are [value, [r, g, b, alpha?]] with alpha 0–255.

export function colorAt(stops, value) {
  const rgba = (c) => (c.length === 4 ? c : [...c, 255]);
  if (value <= stops[0][0]) return rgba(stops[0][1]);
  for (let k = 1; k < stops.length; k++) {
    const [v1, c1] = stops[k];
    if (value <= v1) {
      const [v0, c0] = stops[k - 1];
      const a = rgba(c0);
      const b = rgba(c1);
      const f = (value - v0) / (v1 - v0);
      return [0, 1, 2, 3].map((n) => Math.round(a[n] + (b[n] - a[n]) * f));
    }
  }
  return rgba(stops[stops.length - 1][1]);
}

const LUT_SIZE = 1024;
const luts = new Map();

// Precomputed RGBA lookup so the heatmap does not interpolate stops per pixel.
export function lutFor(def) {
  if (luts.has(def.id)) return luts.get(def.id);
  const stops = def.stops;
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  const rgba = new Uint8Array(LUT_SIZE * 4);
  for (let k = 0; k < LUT_SIZE; k++) {
    rgba.set(colorAt(stops, min + ((max - min) * k) / (LUT_SIZE - 1)), k * 4);
  }
  const lut = { min, max, size: LUT_SIZE, rgba };
  luts.set(def.id, lut);
  return lut;
}

// CSS gradient for the scale between `from` and `to` (defaults: the whole scale).
// Transparent ends are shown against a dark background so they stay readable.
export function gradientCss(stops, from, to) {
  const min = from ?? stops[0][0];
  const max = to ?? stops[stops.length - 1][0];
  const values = [min, ...stops.map(([v]) => v).filter((v) => v > min && v < max), max];
  const parts = values.map((v) => {
    const [r, g, b, a] = colorAt(stops, v);
    return `rgba(${r},${g},${b},${(a / 255).toFixed(2)}) ${(((v - min) / (max - min)) * 100).toFixed(1)}%`;
  });
  return `linear-gradient(to right, ${parts.join(', ')})`;
}
