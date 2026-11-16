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

/** Monta o CSV: Ponto, X, Y, Z (m) e Descrição, na ordem recebida. */
export function buildCsv(points, { format = "br", decimals = 3, header = true } = {}) {
  const f = FORMATS[format] || FORMATS.br;
  const rows = header ? [["Ponto", "X (m)", "Y (m)", "Z (m)", "Descrição"]] : [];
  for (const p of points) {
    rows.push([p.name, ...[p.x, p.y, p.z].map(v => formatNumber(v, decimals, f.dec)), p.desc || ""]);
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

function headerMap(cells) {
  const map = {};
  cells.forEach((cell, i) => {
    const key = normalizeHeader(cell);
    for (const [field, names] of Object.entries(ALIASES)) {
      if (map[field] === undefined && names.includes(key)) { map[field] = i; break; }
    }
  });
  return map.x !== undefined && map.y !== undefined && map.z !== undefined ? map : null;
}

/**
 * Lê um CSV de pontos. Aceita cabeçalho (Ponto, X/E, Y/N, Z/Cota, Descrição em qualquer ordem)
 * ou, sem cabeçalho, as colunas Ponto, X, Y, Z, Descrição; ou só X, Y, Z.
 * Devolve { points: [{ name, x, y, z, desc }], skipped: [{ line, text, reason }] }.
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
    points.push({ name: name || null, x, y, z, desc });
  }
  return { points, skipped };
}

/** Nome de arquivo com data e hora local: coordenadas_20261116_1830.csv */
export function csvFileName(date = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `coordenadas_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.csv`;
}
