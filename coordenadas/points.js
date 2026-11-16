// Lógica pura dos pontos (sem Trimble): nomes, ponto médio e CSV de ida e volta.
// Coordenadas sempre em metros.

export const FORMATS = {
  br: { sep: ";", dec: ",", bom: true, label: "Excel pt-BR (; e vírgula decimal)" },
  intl: { sep: ",", dec: ".", bom: false, label: "CAD / topografia (, e ponto decimal)" },
};

/** Próximo número livre na sequência P1, P2… (nomes fora desse padrão são ignorados). */
export function nextPointNumber(names) {
  let max = 0;
  for (const name of names) {
    const match = /^P(\d+)$/i.exec(String(name ?? "").trim());
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Interseção da linha a–b com a linha c–d (linhas infinitas).
 * - 3D: devolve o meio do menor segmento entre as linhas; `gap` é a distância entre elas
 *   (0 quando se cruzam de fato).
 * - Em planta (plan = true): cruza as linhas em XY; Z é a média das duas linhas naquele
 *   ponto e `gap` é a diferença de Z entre elas.
 * `inside` diz se o ponto cai dentro dos dois segmentos (senão está no prolongamento).
 */
export function lineIntersection(a, b, c, d, { plan = false } = {}) {
  const d1 = [b.x - a.x, b.y - a.y, plan ? 0 : b.z - a.z];
  const d2 = [d.x - c.x, d.y - c.y, plan ? 0 : d.z - c.z];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const A = dot(d1, d1), C = dot(d2, d2), B = dot(d1, d2);
  if (A < 1e-12 || C < 1e-12) {
    throw new Error(plan ? "Uma das linhas é vertical (os 2 pontos têm o mesmo X e Y): não há cruzamento em planta."
      : "Uma das linhas tem os 2 pontos no mesmo lugar.");
  }
  const den = A * C - B * B; // = |d1|²|d2|² sen²(ângulo)
  if (den / (A * C) < 1e-8) throw new Error("As linhas são paralelas: não há interseção.");
  const r = [a.x - c.x, a.y - c.y, plan ? 0 : a.z - c.z];
  const D = dot(d1, r), E = dot(d2, r);
  const s = (B * E - C * D) / den, t = (A * E - B * D) / den;
  const p1 = { x: a.x + s * (b.x - a.x), y: a.y + s * (b.y - a.y), z: a.z + s * (b.z - a.z) };
  const p2 = { x: c.x + t * (d.x - c.x), y: c.y + t * (d.y - c.y), z: c.z + t * (d.z - c.z) };
  const inside = s >= -1e-9 && s <= 1 + 1e-9 && t >= -1e-9 && t <= 1 + 1e-9;
  return { ...midpoint(p1, p2), gap: plan ? Math.abs(p1.z - p2.z) : distance(p1, p2), inside, s, t };
}

/** Número em texto com casas fixas, sem separador de milhar. */
export function formatNumber(value, decimals = 3, dec = ".") {
  return Number(value).toFixed(decimals).replace(".", dec);
}

/**
 * Lê números escritos à brasileira ou internacional: "734810,41", "734810.41",
 * "734.810,41" e "734,810.41". Devolve NaN quando não é número.
 */
export function parseNumber(text) {
  let s = String(text ?? "").trim().replace(/\s+/g, "");
  if (!s) return NaN;
  const comma = s.lastIndexOf(","), dot = s.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    // O separador que aparece por último é o decimal; o outro é de milhar.
    s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (comma >= 0) {
    if (s.indexOf(",") !== comma) return NaN; // "1,234,567" sem decimal: ambíguo
    s = s.replace(",", ".");
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}

function csvField(value, sep) {
  const s = String(value ?? "");
  return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Monta o CSV na ordem recebida: Ponto, coordenadas (m) e Descrição.
 * coords: "model" → X, Y, Z do Trimble; "global" → E, N, Cota (p.g); "both" → as duas.
 */
export function buildCsv(points, { format = "br", decimals = 3, header = true, coords = "model" } = {}) {
  const f = FORMATS[format] || FORMATS.br;
  const model = coords !== "global", global = coords !== "model";
  if (global && points.some(p => !p.g)) throw new Error("Coordenadas globais indisponíveis: configure a conversão.");
  const titles = [...(model ? ["X (m)", "Y (m)", "Z (m)"] : []), ...(global ? ["E (m)", "N (m)", "Cota (m)"] : [])];
  const rows = header ? [["Ponto", ...titles, "Descrição"]] : [];
  for (const p of points) {
    const values = [...(model ? [p.x, p.y, p.z] : []), ...(global ? [p.g.x, p.g.y, p.g.z] : [])];
    rows.push([p.name, ...values.map(v => formatNumber(v, decimals, f.dec)), p.desc || ""]);
  }
  const body = rows.map(row => row.map(v => csvField(v, f.sep)).join(f.sep)).join("\r\n") + "\r\n";
  return (f.bom ? "﻿" : "") + body;
}

/** Divide uma linha de CSV respeitando aspas. */
export function splitCsvLine(line, sep) {
  const out = [];
  let cell = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell.trim()) { quoted = true; cell = ""; }
    else if (ch === sep) { out.push(cell.trim()); cell = ""; }
    else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

const splitWith = (line, sep) => (sep === " " ? line.trim().split(/\s+/) : splitCsvLine(line, sep));

// Escolhe o separador que mais produz linhas com 3 números (X, Y, Z): uma descrição
// com ";" num CSV de vírgulas não engana a detecção. Empate: ; > tabulação > , > espaço.
function detectSeparator(lines) {
  let best = ",", bestScore = -1;
  for (const sep of [";", "\t", ",", " "]) {
    const score = lines.slice(0, 20)
      .filter(line => splitWith(line, sep).filter(cell => Number.isFinite(parseNumber(cell))).length >= 3).length;
    if (score > bestScore) { best = sep; bestScore = score; }
  }
  return best;
}

const ALIASES = {
  name: ["ponto", "pto", "nome", "name", "point", "id", "p", "pt", "numero", "num"],
  x: ["x", "e", "este", "leste", "easting", "coordx", "coordenadax"],
  y: ["y", "n", "norte", "northing", "coordy", "coordenaday"],
  z: ["z", "cota", "elev", "elevacao", "elevation", "h", "altitude", "alt", "coordz", "coordenadaz"],
  desc: ["descricao", "desc", "description", "obs", "observacao", "codigo", "code", "descr"],
};

const normalizeHeader = s => String(s ?? "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, "").replace(/[^a-z]/g, "");

// Segundo conjunto de colunas (E, N, Cota) num arquivo que já tem X, Y, Z: coordenadas globais.
const GLOBAL_ALIASES = {
  e: ["e", "este", "leste", "easting"],
  n: ["n", "norte", "northing"],
  h: ["cota", "elev", "elevacao", "elevation", "h", "altitude", "alt"],
};

function headerMap(cells) {
  const map = {};
  const keys = cells.map(normalizeHeader);
  keys.forEach((key, i) => {
    for (const [field, names] of Object.entries(ALIASES)) {
      if (map[field] === undefined && names.includes(key)) { map[field] = i; break; }
    }
  });
  if (map.x === undefined || map.y === undefined || map.z === undefined) return null;
  const used = new Set(Object.values(map));
  const global = {};
  keys.forEach((key, i) => {
    if (used.has(i)) return;
    for (const [field, names] of Object.entries(GLOBAL_ALIASES)) {
      if (global[field] === undefined && names.includes(key)) { global[field] = i; break; }
    }
  });
  if (global.e !== undefined && global.n !== undefined && global.h !== undefined) map.global = global;
  return map;
}

/**
 * Lê um CSV de pontos. Aceita cabeçalho (Ponto, X/E, Y/N, Z/Cota, Descrição em qualquer ordem)
 * ou, sem cabeçalho, as colunas Ponto, X, Y, Z, Descrição; ou só X, Y, Z.
 * Com X, Y, Z e também E, N, Cota no cabeçalho, o 2º conjunto vem em `g` (coordenadas globais).
 * Devolve { points: [{ name, x, y, z, desc, g? }], skipped: [{ line, text, reason }] }.
 */
export function parseCsv(text) {
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r\n|\r|\n/)
    .map((raw, i) => ({ raw, line: i + 1 }))
    .filter(item => item.raw.trim());
  const points = [], skipped = [];
  if (!lines.length) return { points, skipped };
  const sep = detectSeparator(lines.map(item => item.raw));
  const split = raw => splitWith(raw, sep);

  let map = null, start = 0;
  const first = split(lines[0].raw);
  const named = headerMap(first);
  if (named) { map = named; start = 1; }

  for (const { raw, line } of lines.slice(start)) {
    const cells = split(raw);
    let layout = map;
    if (!layout) {
      // Sem cabeçalho: "X;Y;Z[;Desc]" quando a 1ª coluna é número, senão "Ponto;X;Y;Z[;Desc]".
      const numericFirst = cells.length >= 3 && [0, 1, 2].every(i => Number.isFinite(parseNumber(cells[i])));
      // Com 4 números seguidos, o 1º é o número do ponto (Ponto;X;Y;Z).
      layout = numericFirst && !Number.isFinite(parseNumber(cells[3]))
        ? { x: 0, y: 1, z: 2, desc: 3 }
        : { name: 0, x: 1, y: 2, z: 3, desc: 4 };
    }
    const x = parseNumber(cells[layout.x]), y = parseNumber(cells[layout.y]), z = parseNumber(cells[layout.z]);
    if (![x, y, z].every(Number.isFinite)) {
      // Uma 1ª linha não numérica sem nomes conhecidos é tratada como cabeçalho.
      if (!(line === lines[0].line && !map)) skipped.push({ line, text: raw, reason: "X, Y ou Z não é número" });
      continue;
    }
    const name = layout.name !== undefined ? (cells[layout.name] || "").trim() : "";
    const desc = layout.desc !== undefined ? (cells[layout.desc] || "").trim() : "";
    const point = { name: name || null, x, y, z, desc };
    if (layout.global) {
      const g = { x: parseNumber(cells[layout.global.e]), y: parseNumber(cells[layout.global.n]), z: parseNumber(cells[layout.global.h]) };
      if ([g.x, g.y, g.z].every(Number.isFinite)) point.g = g;
    }
    points.push(point);
  }
  return { points, skipped };
}

/** Nome de arquivo com data e hora local: coordenadas_20261116_1830.csv */
export function csvFileName(date = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `coordenadas_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.csv`;
}
