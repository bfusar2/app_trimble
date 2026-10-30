// Vista ortogonal dentro de uma faixa de profundidade, em metros.
// Extrai arestas, silhuetas e contornos nos limites; não remove linhas ocultas
// por outras faces/objetos. Diagonais entre triângulos coplanares são omitidas.

const EPS = 1e-7;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((x, k) => x - b[k]);
const at = (a, b, t) => a.map((x, k) => x + (b[k] - x) * t);
const pointKey = (p) => p.map((x) => Math.round(x / EPS)).join(",");

/**
 * Faixa: 0 <= direction * dot(p - plane.point, plane.normal) <= depth.
 * depth: metros; direction: -1 ou 1; scale: 1000 para DXF em mm, 1 para m.
 * Acrescenta [u1,v1,u2,v2,...] em out e retorna o número de segmentos.
 * Profundidade zero não acrescenta vista: o corte original permanece separado.
 */
export function projectMeshDepth(positions, indices, plane, { depth = 0, direction = -1, scale = 1000 } = {}, out = []) {
  if (!Number.isFinite(depth) || depth < 0) throw new Error("Profundidade deve ser um número maior ou igual a zero.");
  if (direction !== -1 && direction !== 1) throw new Error("Sentido da profundidade inválido.");
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Escala da vista inválida.");
  for (const key of ["point", "normal", "u", "v"])
    if (!plane?.[key] || plane[key].length !== 3 || !plane[key].every(Number.isFinite))
      throw new Error("Plano da vista inválido.");
  if (Math.abs(Math.hypot(...plane.normal) - 1) > 1e-6) throw new Error("Normal da vista deve ser unitária.");
  if (!depth) return 0;
  if (positions.length % 3 || indices.length % 3) throw new Error("Malha da vista inválida.");

  // Solda vértices geométricos, inclusive os duplicados por face no web-ifc.
  const vertices = [], vertexIds = [], welded = new Map();
  let minD = Infinity, maxD = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const p = [positions[i], positions[i + 1], positions[i + 2]];
    if (!p.every(Number.isFinite)) throw new Error("Malha da vista contém coordenadas inválidas.");
    const key = pointKey(p);
    if (!welded.has(key)) {
      const d = direction * dot(sub(p, plane.point), plane.normal);
      welded.set(key, vertices.length);
      vertices.push({ p, d });
      minD = Math.min(minD, d); maxD = Math.max(maxD, d);
    }
    vertexIds.push(welded.get(key));
  }
  if (minD > depth + EPS || maxD < -EPS) return 0;

  const edges = new Map(), triangles = [];
  for (let i = 0; i < indices.length; i += 3) {
    const raw = [indices[i], indices[i + 1], indices[i + 2]];
    if (raw.some((id) => !Number.isInteger(id) || id < 0 || id >= vertexIds.length)) throw new Error("Índice da malha inválido.");
    const ids = raw.map((id) => vertexIds[id]);
    if (new Set(ids).size < 3) continue;
    const [a, b, c] = ids.map((id) => vertices[id].p);
    const ab = sub(b, a), ac = sub(c, a);
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const len = Math.hypot(...n);
    if (len < EPS * EPS) continue;
    const normal = n.map((x) => x / len);
    triangles.push(ids);
    for (const [x, y] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]]) {
      const key = x < y ? `${x},${y}` : `${y},${x}`;
      if (!edges.has(key)) edges.set(key, { a: x, b: y, normals: [] });
      edges.get(key).normals.push(normal);
    }
  }

  const seen = new Set(), projected = [];
  const emit = (a, b) => {
    // Coordenadas absolutas mantêm o mesmo referencial do corte em section.js.
    const pa = [dot(a, plane.u), dot(a, plane.v)];
    const pb = [dot(b, plane.u), dot(b, plane.v)];
    if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) <= EPS) return;
    const ka = pointKey(pa), kb = pointKey(pb);
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seen.has(key)) return;
    seen.add(key);
    projected.push([pa, pb]);
  };
  const clipEdge = (a, b) => {
    let t0 = 0, t1 = 1;
    const dd = b.d - a.d;
    if (Math.abs(dd) <= EPS) {
      if (a.d < -EPS || a.d > depth + EPS) return;
    } else {
      const ta = -a.d / dd, tb = (depth - a.d) / dd;
      t0 = Math.max(0, Math.min(ta, tb));
      t1 = Math.min(1, Math.max(ta, tb));
      if (t1 < t0) return;
    }
    emit(at(a.p, b.p, t0), at(a.p, b.p, t1));
  };
  // Preserva vincos arquitetônicos suaves (por exemplo, cumeeiras baixas).
  const creaseCos = Math.cos(Math.PI / 180);
  for (const edge of edges.values()) {
    let feature = edge.normals.length === 1;
    for (let i = 0; !feature && i < edge.normals.length; i++)
      for (let j = i + 1; !feature && j < edge.normals.length; j++) {
        const a = edge.normals[i], b = edge.normals[j];
        const alignment = Math.abs(dot(a, b));
        // Coplanares nunca geram diagonal, mesmo com winding invertido.
        if (alignment > 1 - 1e-8) continue;
        const fa = dot(a, plane.normal), fb = dot(b, plane.normal);
        feature = alignment < creaseCos || fa * fb <= 0;
      }
    if (feature) clipEdge(vertices[edge.a], vertices[edge.b]);
  }

  // Fecha os contornos de entrada/fundo mesmo quando um triângulo atravessa
  // toda a faixa sem ter nenhum vértice dentro dela.
  for (const ids of triangles) {
    const tri = ids.map((id) => vertices[id]);
    for (const boundary of [0, depth]) {
      const ds = tri.map((v) => v.d - boundary);
      if (ds.every((d) => Math.abs(d) <= EPS)) continue;
      if (ds.every((d) => d > EPS) || ds.every((d) => d < -EPS)) continue;
      const points = new Map();
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        if (Math.abs(ds[i]) <= EPS) points.set(pointKey(tri[i].p), tri[i].p);
        if ((ds[i] < -EPS && ds[j] > EPS) || (ds[i] > EPS && ds[j] < -EPS)) {
          const p = at(tri[i].p, tri[j].p, ds[i] / (ds[i] - ds[j]));
          points.set(pointKey(p), p);
        }
      }
      const ps = [...points.values()];
      if (ps.length >= 2) emit(ps[0], ps[1]);
    }
  }
  // As duas bordas da faixa podem projetar a mesma linha com subdivisões
  // diferentes. Une intervalos colineares para não duplicar esses contornos.
  const lines = new Map();
  for (const [a, b] of projected) {
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    let ux = dx / length, uy = dy / length;
    if (ux < -EPS || (Math.abs(ux) <= EPS && uy < 0)) { ux = -ux; uy = -uy; }
    const c = -uy * a[0] + ux * a[1];
    const key = `${Math.round(ux / 1e-6)},${Math.round(uy / 1e-6)},${Math.round(c / 1e-6)}`;
    if (!lines.has(key)) lines.set(key, []);
    const bucket = lines.get(key);
    let line = bucket.find((l) => [a, b].every((p) => Math.abs(-l.uy * (p[0] - l.a[0]) + l.ux * (p[1] - l.a[1])) <= EPS));
    if (!line) { line = { a, ux, uy, intervals: [] }; bucket.push(line); }
    const ts = [a, b].map((p) => (p[0] - line.a[0]) * line.ux + (p[1] - line.a[1]) * line.uy);
    line.intervals.push([Math.min(...ts), Math.max(...ts)]);
  }
  let count = 0;
  for (const bucket of lines.values()) for (const line of bucket) {
    const intervals = line.intervals.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const interval of intervals) {
      const prev = merged[merged.length - 1];
      if (prev && interval[0] <= prev[1] + EPS) prev[1] = Math.max(prev[1], interval[1]);
      else merged.push([...interval]);
    }
    for (const [a, b] of merged) {
      out.push((line.a[0] + line.ux * a) * scale, (line.a[1] + line.uy * a) * scale,
        (line.a[0] + line.ux * b) * scale, (line.a[1] + line.uy * b) * scale);
      count++;
    }
  }
  return count;
}
