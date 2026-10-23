// Dependency-free Polygon shapefile (.shp + .dbf, WGS84) -> simplified GeoJSON.
//
//   node tools/shp2geojson.js <input.shp> <output.geojson> [tolerance-deg] [--outline <outline.geojson>]
//
// --outline also writes the outer boundary of all polygons (edges not shared
// by two polygons), which needs the source to share vertices along borders.

const fs = require('fs');

const args = process.argv.slice(2);
const outlineIdx = args.indexOf('--outline');
const outlinePath = outlineIdx >= 0 ? args.splice(outlineIdx, 2)[1] : null;
const [input, output, tolArg] = args;
if (!input || !output) {
  console.error('usage: node tools/shp2geojson.js <input.shp> <output.geojson> [tolerance] [--outline <file>]');
  process.exit(1);
}
const TOL = Number(tolArg) || 0.0008;

function readDbf(path) {
  const b = fs.readFileSync(path);
  const count = b.readUInt32LE(4);
  const headerLen = b.readUInt16LE(8);
  const recordLen = b.readUInt16LE(10);
  const fields = [];
  for (let o = 32; b[o] !== 0x0d; o += 32) {
    fields.push({ name: b.toString('latin1', o, o + 11).replace(/\0.*$/, ''), type: String.fromCharCode(b[o + 11]), len: b[o + 16] });
  }
  const rows = [];
  for (let r = 0; r < count; r++) {
    let o = headerLen + r * recordLen + 1;
    const row = {};
    for (const f of fields) {
      const raw = b.toString('utf8', o, o + f.len).replace(/\s+/g, ' ').trim();
      o += f.len;
      row[f.name] = f.type === 'N' || f.type === 'F' ? (raw === '' ? null : Number(raw)) : raw;
    }
    rows.push(row);
  }
  return rows;
}

function readShp(path) {
  const b = fs.readFileSync(path);
  const shapes = [];
  let o = 100;
  while (o < b.length) {
    const len = b.readInt32BE(o + 4) * 2;
    const c = o + 8;
    const type = b.readInt32LE(c);
    if (type === 5 || type === 15 || type === 25) {
      const numParts = b.readInt32LE(c + 36);
      const numPoints = b.readInt32LE(c + 40);
      const parts = [];
      for (let p = 0; p < numParts; p++) parts.push(b.readInt32LE(c + 44 + p * 4));
      const pts = c + 44 + numParts * 4;
      const rings = parts.map((start, p) => {
        const end = p + 1 < numParts ? parts[p + 1] : numPoints;
        const ring = [];
        for (let k = start; k < end; k++) ring.push([b.readDoubleLE(pts + k * 16), b.readDoubleLE(pts + k * 16 + 8)]);
        return ring;
      });
      shapes.push(rings);
    } else {
      shapes.push(null);
    }
    o = c + len;
  }
  return shapes;
}

function simplify(points, tol) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, z] = stack.pop();
    const [ax, ay] = points[a];
    const [zx, zy] = points[z];
    const dx = zx - ax;
    const dy = zy - ay;
    const norm = Math.hypot(dx, dy) || 1e-12;
    let max = 0;
    let idx = -1;
    for (let k = a + 1; k < z; k++) {
      const d = Math.abs(dy * points[k][0] - dx * points[k][1] + zx * ay - zy * ax) / norm;
      if (d > max) {
        max = d;
        idx = k;
      }
    }
    if (max > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, z]);
    }
  }
  return points.filter((_, k) => keep[k]);
}

const round = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
const signedArea = (r) => r.reduce((s, p, k) => s + (r[(k + 1) % r.length][0] - p[0]) * (r[(k + 1) % r.length][1] + p[1]), 0);

// A closed ring starts and ends on the same point, so split it at the vertex
// farthest from the start before simplifying each half.
function simplifyClosed(ring) {
  let far = 0;
  let max = -1;
  ring.forEach((p, k) => {
    const d = Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]);
    if (d > max) {
      max = d;
      far = k;
    }
  });
  return [...simplify(ring.slice(0, far + 1), TOL).slice(0, -1), ...simplify(ring.slice(far), TOL)].map(round);
}

function cleanRing(ring) {
  const s = simplifyClosed(ring);
  return s.length >= 4 ? s : null;
}

// Shapefile outer rings are clockwise; counter-clockwise rings are holes of the preceding outer ring.
function toGeometry(rings) {
  const polys = [];
  for (const raw of rings) {
    const ring = cleanRing(raw);
    if (!ring) continue;
    if (signedArea(raw) >= 0 || !polys.length) polys.push([ring.reverse()]);
    else polys[polys.length - 1].push(ring.reverse());
  }
  if (!polys.length) return null;
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

function outline(shapes) {
  const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const counts = new Map();
  const segs = [];
  for (const rings of shapes) {
    if (!rings) continue;
    for (const ring of rings) {
      for (let k = 0; k + 1 < ring.length; k++) {
        const a = key(ring[k]);
        const z = key(ring[k + 1]);
        if (a === z) continue;
        const id = a < z ? `${a}|${z}` : `${z}|${a}`;
        counts.set(id, (counts.get(id) || 0) + 1);
        segs.push([id, ring[k], ring[k + 1], a, z]);
      }
    }
  }
  const outer = segs.filter(([id]) => counts.get(id) === 1);
  const byStart = new Map();
  for (const s of outer) {
    if (!byStart.has(s[3])) byStart.set(s[3], []);
    byStart.get(s[3]).push(s);
  }
  const used = new Set();
  const lines = [];
  for (const s of outer) {
    if (used.has(s)) continue;
    used.add(s);
    const line = [s[1], s[2]];
    let tail = s[4];
    for (;;) {
      const next = (byStart.get(tail) || []).find((n) => !used.has(n));
      if (!next) break;
      used.add(next);
      line.push(next[2]);
      tail = next[4];
    }
    const closed = key(line[0]) === key(line[line.length - 1]);
    lines.push(closed ? simplifyClosed(line) : simplify(line, TOL).map(round));
  }
  return { shared: segs.length - outer.length, outer: outer.length, lines };
}

const shapes = readShp(input);
const rows = readDbf(input.replace(/\.shp$/i, '.dbf'));
const features = shapes
  .map((rings, k) => (rings ? { type: 'Feature', properties: rows[k], geometry: toGeometry(rings) } : null))
  .filter((f) => f && f.geometry);
fs.writeFileSync(output, JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`${output}: ${features.length} features, ${(fs.statSync(output).size / 1024).toFixed(0)} KB`);

if (outlinePath) {
  const o = outline(shapes);
  const geo = { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: o.lines } };
  fs.writeFileSync(outlinePath, JSON.stringify({ type: 'FeatureCollection', features: [geo] }));
  console.log(`${outlinePath}: ${o.lines.length} lines (${o.outer} outer / ${o.shared} shared segments)`);
}
