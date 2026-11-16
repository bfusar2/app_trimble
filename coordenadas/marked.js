// Pontos marcados no Visualizador 3D (marcações de ponto do Trimble, em mm), usados pelo
// Coordenadas CSV e pelo Corte DXF. Os nomes dados no Coordenadas CSV ficam na sessão do
// navegador (mesma origem e mesma aba) e são reaproveitados pelo Corte DXF.

const V = new URL(import.meta.url).search;
const { nextPointNumber, distance, formatNumber } = await import(`./points.js${V}`);

export const MM = 1000; // a API de marcações usa mm; os pontos ficam em metros
export const SAME_POINT_M = 0.002; // posições a menos de 2 mm são o mesmo ponto

/** Chave da sessão: [{ id, name, desc, x, y, z, … }] por projeto. */
export const sessionKey = projectId => `coordcsv:${projectId || "sem-projeto"}`;

export function loadSavedPoints(projectId) {
  try {
    const list = JSON.parse(sessionStorage.getItem(sessionKey(projectId)) || "[]");
    return new Map(list.map(item => [item.id, item]));
  } catch { return new Map(); }
}

const byId = (a, b) => (a.id > b.id) - (a.id < b.id);

/**
 * Lê as marcações de ponto na ordem de criação, em metros. Usa o nome e a descrição do
 * Coordenadas CSV quando a mesma marcação (id e posição) foi nomeada nesta aba; as demais
 * recebem P1, P2… continuando a sequência, como no app.
 */
export async function readMarkedPoints(api, projectId) {
  const list = (await api.markup.getSinglePointMarkups()) || [];
  const saved = loadSavedPoints(projectId);
  const points = [];
  for (const m of list.filter(item => item?.id != null && item.start).sort(byId)) {
    const p = { id: m.id, x: m.start.positionX / MM, y: m.start.positionY / MM, z: m.start.positionZ / MM, name: null, desc: "" };
    if (![p.x, p.y, p.z].every(Number.isFinite)) continue;
    const meta = saved.get(m.id);
    if (meta && distance(meta, p) <= SAME_POINT_M) Object.assign(p, { name: meta.name || null, desc: meta.desc || "" });
    points.push(p);
  }
  let n = nextPointNumber(points.map(p => p.name));
  for (const p of points) if (!p.name) p.name = `P${n++}`;
  return points;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Desenho dos pontos para o DXF, no mesmo sistema 2D do corte:
 * - PONTOS: POINT (para o encaixe "nó" do CAD), círculo com X e o nome (com a descrição);
 * - PONTOS_COORD: as coordenadas do Trimble (m), para poder desligar no CAD.
 * toIfc: ponto do visualizador (m) -> espaço do corte (IFC, m). plane: base { u, v } do corte.
 * size: raio da marca em metros (o texto do nome tem o dobro).
 */
export function markedPointLayers(points, { plane, toIfc = p => p, scale = 1000, size = 0.1 }) {
  const marks = [], coords = [];
  const r = size * scale, a = r / Math.SQRT2;
  const f = v => formatNumber(v, 3, ",");
  for (const p of points) {
    const w = toIfc([p.x, p.y, p.z]);
    const x = dot(w, plane.u) * scale, y = dot(w, plane.v) * scale;
    marks.push(
      { points: [[x, y]], point: true },
      { points: [[x, y]], circle: r },
      { points: [[x - a, y - a], [x + a, y + a]] },
      { points: [[x - a, y + a], [x + a, y - a]] },
      { points: [[x + 1.2 * r, y + 0.4 * r]], text: p.desc ? `${p.name} - ${p.desc}` : p.name, height: 2 * r },
    );
    coords.push({ points: [[x + 1.2 * r, y - 1.6 * r]], text: `X ${f(p.x)}  Y ${f(p.y)}  Z ${f(p.z)}`, height: 1.2 * r });
  }
  return new Map([["PONTOS", marks], ["PONTOS_COORD", coords]]);
}
