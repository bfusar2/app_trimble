// Geometria pura: corte de triângulos por um plano e montagem de polilinhas 2D.
// Sem dependência do Trimble nem do web-ifc, para poder testar isoladamente.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Cria o plano de corte e a base 2D (u, v) usada para "desenhar" o corte.
 * - Plano horizontal (planta): u = X, v = Y, mantendo as coordenadas do projeto.
 * - Plano vertical/inclinado (corte/elevação): v aponta para cima (Z).
 */
export function makeSectionPlane(point, normal, { mirror = false } = {}) {
  const n = norm(normal);
  let u, v;
  if (Math.abs(n[2]) > 0.9) {
    u = [1, 0, 0];
    v = [0, 1, 0];
  } else {
    u = norm(cross(n, [0, 0, 1]));
    v = norm(cross(u, n));
  }
  if (mirror) u = u.map((x) => -x);
  return { point, normal: n, u, v };
}

/**
 * Corta uma malha (vértices já em coordenadas do mundo) pelo plano.
 * positions: Float64Array [x,y,z, x,y,z, ...]; indices: triângulos.
 * Adiciona segmentos 2D [u1, v1, u2, v2] (mesma unidade de entrada × scale) em `out`.
 */
export function sliceMesh(positions, indices, plane, scale, out) {
  const { point: p, normal: n, u, v } = plane;
  const nv = positions.length / 3;
  const d = new Float64Array(nv);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < nv; i++) {
    let di =
      (positions[3 * i] - p[0]) * n[0] +
      (positions[3 * i + 1] - p[1]) * n[1] +
      (positions[3 * i + 2] - p[2]) * n[2];
    if (di === 0) di = 1e-12; // vértice exatamente no plano: empurra para um lado
    d[i] = di;
    if (di < min) min = di;
    if (di > max) max = di;
  }
  if (min > 0 || max < 0) return 0; // malha inteira de um lado só

  let count = 0;
  const pts = [];
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
    const da = d[ia], db = d[ib], dc = d[ic];
    if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) continue;

    pts.length = 0;
    edge(ia, ib, da, db);
    edge(ib, ic, db, dc);
    edge(ic, ia, dc, da);
    if (pts.length === 4) {
      out.push(pts[0] * scale, pts[1] * scale, pts[2] * scale, pts[3] * scale);
      count++;
    }
  }
  return count;

  function edge(i, j, di, dj) {
    if ((di > 0) === (dj > 0)) return;
    const k = di / (di - dj);
    const x = positions[3 * i] + (positions[3 * j] - positions[3 * i]) * k;
    const y = positions[3 * i + 1] + (positions[3 * j + 1] - positions[3 * i + 1]) * k;
    const z = positions[3 * i + 2] + (positions[3 * j + 2] - positions[3 * i + 2]) * k;
    pts.push(x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]);
  }
}

/**
 * Junta segmentos soltos em polilinhas, remove duplicados e pontos colineares.
 * segs: [u1,v1,u2,v2, ...]; tol: tolerância de solda (mesma unidade).
 * Retorna [{ points: [[x,y],...], closed }].
 */
export function chainSegments(segs, tol = 0.01) {
  const key = (x, y) => `${Math.round(x / tol)},${Math.round(y / tol)}`;
  const nodes = new Map(); // key -> { x, y, edges: Set<edgeId> }
  const edges = []; // [keyA, keyB]
  const seen = new Set();

  const node = (x, y) => {
    const k = key(x, y);
    if (!nodes.has(k)) nodes.set(k, { x, y, edges: [] });
    return k;
  };

  for (let i = 0; i < segs.length; i += 4) {
    const a = node(segs[i], segs[i + 1]);
    const b = node(segs[i + 2], segs[i + 3]);
    if (a === b) continue; // segmento degenerado
    const ek = a < b ? a + "|" + b : b + "|" + a;
    if (seen.has(ek)) continue; // duplicado (aresta compartilhada)
    seen.add(ek);
    const id = edges.length;
    edges.push([a, b]);
    nodes.get(a).edges.push(id);
    nodes.get(b).edges.push(id);
  }

  const used = new Uint8Array(edges.length);
  const nextEdge = (k) => nodes.get(k).edges.find((e) => !used[e]);
  const lines = [];

  // Começa pelas pontas soltas (grau ímpar) para formar linhas abertas inteiras;
  // depois o que sobrar são laços fechados.
  const starts = [...nodes.keys()].filter((k) => nodes.get(k).edges.length % 2 === 1);
  const walk = (start) => {
    const path = [start];
    let cur = start;
    for (let e = nextEdge(cur); e !== undefined; e = nextEdge(cur)) {
      used[e] = 1;
      const [a, b] = edges[e];
      cur = a === cur ? b : a;
      path.push(cur);
    }
    return path;
  };

  for (const s of starts) while (nextEdge(s) !== undefined) lines.push(walk(s));
  for (let e = 0; e < edges.length; e++) if (!used[e]) lines.push(walk(edges[e][0]));

  return lines.map((path) => {
    const closed = path.length > 2 && path[0] === path[path.length - 1];
    let pts = path.map((k) => [nodes.get(k).x, nodes.get(k).y]);
    if (closed) pts.pop();
    pts = removeCollinear(pts, closed, tol);
    return { points: pts, closed };
  });
}

function removeCollinear(pts, closed, tol) {
  if (pts.length < 3) return pts;
  const res = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) {
      res.push(pts[i]);
      continue;
    }
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    if (Math.abs(area) / len > tol) res.push(b); // mantém só se não for colinear
  }
  return res;
}
