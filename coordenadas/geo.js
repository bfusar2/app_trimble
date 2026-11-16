// Conversão de coordenadas locais (do modelo) para globais (UTM), sem dependência do Trimble.
//
// Transformação de similaridade em planta (Helmert 2D) e deslocamento em Z:
//   E = a·x − b·y + tx      a = escala·cos(θ)
//   N = b·x + a·y + ty      b = escala·sen(θ)
//   Cota = z + dz           θ: rotação anti-horária do eixo X local até o eixo E

const deg = rad => (rad * 180) / Math.PI;

function finish({ a, b, tx, ty, dz }, extra = {}) {
  return { a, b, tx, ty, dz, scale: Math.hypot(a, b), rotationDeg: deg(Math.atan2(b, a)), ...extra };
}

/** Pelo ponto base: local (x0, y0, z0) corresponde ao global (E0, N0, H0), girado e escalado. */
export function fromBasePoint({ x0 = 0, y0 = 0, z0 = 0, E0, N0, H0, rotationDeg = 0, scale = 1 }) {
  const values = [x0, y0, z0, E0, N0, H0, rotationDeg, scale];
  if (!values.every(Number.isFinite)) throw new Error("Preencha o ponto base local e global, a rotação e a escala.");
  if (scale <= 0) throw new Error("A escala precisa ser maior que zero.");
  const th = (rotationDeg * Math.PI) / 180;
  const a = scale * Math.cos(th), b = scale * Math.sin(th);
  return finish({ a, b, tx: E0 - (a * x0 - b * y0), ty: N0 - (b * x0 + a * y0), dz: H0 - z0 }, { method: "base" });
}

/**
 * Pelos pontos de controle: [{ name, x, y, z, E, N, H }] (H pode faltar: NaN).
 * Ajuste por mínimos quadrados; com freeScale = false a escala fica em 1 (só rotação e deslocamento).
 * Devolve também os resíduos de cada ponto e o erro médio quadrático em planta.
 */
export function fitControlPoints(pairs, { freeScale = false } = {}) {
  const valid = pairs.filter(p => [p.x, p.y, p.z, p.E, p.N].every(Number.isFinite));
  if (valid.length < 2) throw new Error("Informe ao menos 2 pontos de controle com E e N.");
  const n = valid.length;
  const xc = valid.reduce((s, p) => s + p.x, 0) / n, yc = valid.reduce((s, p) => s + p.y, 0) / n;
  const Ec = valid.reduce((s, p) => s + p.E, 0) / n, Nc = valid.reduce((s, p) => s + p.N, 0) / n;
  let sxx = 0, sdot = 0, scross = 0;
  for (const p of valid) {
    const x = p.x - xc, y = p.y - yc, E = p.E - Ec, N = p.N - Nc;
    sxx += x * x + y * y;
    sdot += x * E + y * N;
    scross += x * N - y * E;
  }
  if (sxx < 1) throw new Error("Os pontos de controle estão muito próximos: use pontos a mais de 1 m entre si.");
  let a, b;
  if (freeScale) { a = sdot / sxx; b = scross / sxx; }
  else { const th = Math.atan2(scross, sdot); a = Math.cos(th); b = Math.sin(th); }
  const tx = Ec - (a * xc - b * yc), ty = Nc - (b * xc + a * yc);
  const withHeight = valid.filter(p => Number.isFinite(p.H));
  const dz = withHeight.length ? withHeight.reduce((s, p) => s + (p.H - p.z), 0) / withHeight.length : 0;
  const t = { a, b, tx, ty, dz };
  const residuals = valid.map(p => {
    const g = toGlobal(t, p);
    const dE = p.E - g.x, dN = p.N - g.y;
    return { name: p.name, dE, dN, plan: Math.hypot(dE, dN), dH: Number.isFinite(p.H) ? p.H - g.z : NaN };
  });
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r.plan * r.plan, 0) / n);
  return finish(t, { method: "control", residuals, rms, count: n, heightFromControl: withHeight.length > 0 });
}

/** Local (modelo) → global. */
export function toGlobal(t, p) {
  return { x: t.a * p.x - t.b * p.y + t.tx, y: t.b * p.x + t.a * p.y + t.ty, z: p.z + t.dz };
}

/** Global → local (modelo): para marcar no Trimble uma coordenada UTM. */
export function toLocal(t, g) {
  const det = t.a * t.a + t.b * t.b;
  const x = g.x - t.tx, y = g.y - t.ty;
  return { x: (t.a * x + t.b * y) / det, y: (-t.b * x + t.a * y) / det, z: g.z - t.dz };
}

/**
 * Indica se o ponto já parece estar em UTM (E de 100 a 900 km, N acima de 100 km).
 * Modelos em coordenadas locais costumam ficar perto da origem.
 */
export const looksGlobal = p => Math.abs(p.x) >= 100000 && Math.abs(p.x) <= 900000 && Math.abs(p.y) >= 100000;
