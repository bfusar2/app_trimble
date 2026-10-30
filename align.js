// Alinha o espaço do IFC (metros, Z para cima) com o espaço do Visualizador 3D.
//
// Modelo:  viewer = R(theta) * (s * ifc) + t
//   s     : só potência de 10 (1 = visualizador em metros, 1000 = milímetros).
//           NÃO é estimado de forma contínua: as caixas do visualizador têm folga
//           e um erro de poucos % vira quilômetros em coordenadas UTM.
//   theta : rotação em torno de Z (modelo georreferenciado/girado)
//   t     : deslocamento

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const center = (b) => [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
const diag = (b) => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);

/**
 * pairs: [{ ifc: {min,max}, v: {min,max} }] — mesmo objeto nos dois espaços.
 * Retorna { s, theta, t, n, residual, toIfcPoint, toIfcDir, ifcBounds }.
 * residual: erro mediano de posição, em metros.
 */
export function fitAlignment(pairs) {
  if (!pairs.length) throw new Error("sem pares");

  // 1) Unidade: potência de 10 mais próxima da razão das diagonais.
  const ratio = median(pairs.map((p) => diag(p.v) / (diag(p.ifc) || 1)));
  const exp = Math.log10(ratio);
  // Razão longe de qualquer potência de 10 (ex.: 30x) = unidade desconhecida ou pares errados.
  if (!Number.isFinite(exp) || Math.abs(exp - Math.round(exp)) > 0.15)
    throw new Error(`escala incoerente (razão ${ratio})`);
  const s = Math.pow(10, Math.round(exp));

  const A = pairs.map((p) => center(p.ifc).map((x) => x * s));
  const B = pairs.map((p) => center(p.v));

  // 2) Rotação em Z + deslocamento, ajustando só os centros (a folga das caixas é simétrica).
  let keep = pairs.map(() => true);
  let theta = 0;
  let t = [0, 0, 0];
  let errs = [];

  const fit = (useRotation) => {
    const idx = keep.flatMap((k, i) => (k ? [i] : []));
    const mean = (arr, k) => idx.reduce((sum, i) => sum + arr[i][k], 0) / idx.length;
    const ax = mean(A, 0), ay = mean(A, 1), bx = mean(B, 0), by = mean(B, 1);
    theta = 0;
    if (useRotation && idx.length >= 2) {
      let dot = 0, crs = 0;
      for (const i of idx) {
        const px = A[i][0] - ax, py = A[i][1] - ay, qx = B[i][0] - bx, qy = B[i][1] - by;
        dot += px * qx + py * qy;
        crs += px * qy - py * qx;
      }
      theta = Math.atan2(crs, dot);
    }
    const c = Math.cos(theta), sn = Math.sin(theta);
    t = [bx - (c * ax - sn * ay), by - (sn * ax + c * ay), median(idx.map((i) => B[i][2] - A[i][2]))];
    const rot = (a) => [c * a[0] - sn * a[1] + t[0], sn * a[0] + c * a[1] + t[1], a[2] + t[2]];
    errs = A.map((a, i) => Math.hypot(...rot(a).map((v, k) => v - B[i][k])));
  };

  for (let iter = 0; iter < 3; iter++) {
    fit(true);
    const thr = Math.max(3 * median(errs), 0.05 * s);
    keep = errs.map((e) => e <= thr);
  }
  fit(true);

  // Rotação muito pequena é ruído: usa só deslocamento.
  if (Math.abs(theta) < (0.3 * Math.PI) / 180) fit(false);

  const used = keep.filter(Boolean).length;
  if (used < 3) throw new Error(`poucos objetos coerentes (${used}/${pairs.length})`);
  if (![theta, ...t].every(Number.isFinite)) throw new Error("parâmetros inválidos");

  const c = Math.cos(theta), sn = Math.sin(theta);
  const ifcBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const p of pairs)
    for (let k = 0; k < 3; k++) {
      ifcBounds.min[k] = Math.min(ifcBounds.min[k], p.ifc.min[k]);
      ifcBounds.max[k] = Math.max(ifcBounds.max[k], p.ifc.max[k]);
    }

  return {
    s,
    theta,
    thetaDeg: (theta * 180) / Math.PI,
    t,
    n: keep.filter(Boolean).length,
    total: pairs.length,
    residual: median(errs) / s,
    ifcBounds,
    // ponto no visualizador (mesma unidade das caixas) -> IFC (m)
    toIfcPoint: (p) => {
      const x = p[0] - t[0], y = p[1] - t[1], z = p[2] - t[2];
      return [(c * x + sn * y) / s, (-sn * x + c * y) / s, z / s];
    },
    // direção no visualizador -> IFC (só rotação)
    toIfcDir: (d) => [c * d[0] + sn * d[1], -sn * d[0] + c * d[1], d[2]],
  };
}
