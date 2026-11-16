// Extensão "Coordenadas CSV" para o Visualizador 3D do Trimble Connect for Browser.
// Os pontos são as marcações de ponto do próprio Trimble (Medir → Ponto, ou o botão
// "Marcar pontos no modelo" daqui). O app numera P1, P2…, cria pontos médios e interseções
// de linhas, converte coordenadas locais em globais, exporta CSV e importa CSV de volta como
// marcações no modelo.
// Aberto fora do Trimble Connect, usa um visualizador simulado (modo local).

const V = new URL(import.meta.url).search;
const [
  { buildCsv, parseCsv, parseNumber, midpoint, distance, lineIntersection, nextPointNumber, csvFileName },
  { MM, SAME_POINT_M, sessionKey: keyFor, loadSavedPoints },
  { fromBasePoint, fitControlPoints, toGlobal, toLocal, looksGlobal },
] = await Promise.all([import(`./points.js${V}`), import(`./marked.js${V}`), import(`./geo.js${V}`)]);

const $ = id => document.getElementById(id);
const EMBEDDED = window.parent !== window;
const POLL_MS = 3000;
const LABEL_OFFSET_MM = { x: 300, y: 300, z: 700 }; // nome um pouco acima e ao lado do ponto
const COLORS = {
  médio: { r: 230, g: 120, b: 0, a: 255 },
  interseção: { r: 120, g: 60, b: 200, a: 255 },
  importado: { r: 30, g: 138, b: 68, a: 255 },
  manual: { r: 30, g: 138, b: 68, a: 255 },
  nome: { r: 0, g: 99, b: 163, a: 255 },
};

let API = null;
let project = null;
let capturing = false;
let labelsOn = true;
let labelsBroken = false;
const points = new Map(); // id da marcação no Trimble -> { id, name, desc, x, y, z, origin, … }
const pending = []; // pontos que o app criou e ainda não apareceram na leitura (casados pela posição)
let restored = new Map(); // dados salvos na sessão do navegador, usados só na 1ª leitura
const checked = new Set();
let queue = Promise.resolve();
let syncTimer = null;
let shownSignature = "";
let downloadUrl = null;
let logDownloadUrl = null;
let clearTimer = null;
// Conversão local -> global, guardada por projeto neste navegador.
const GEO_DEFAULT = () => ({
  method: "control", on: true, freeScale: false, control: [],
  base: { x0: "0", y0: "0", z0: "0", E0: "", N0: "", H0: "", rot: "0", scale: "1" },
});
let geo = GEO_DEFAULT();
let transform = null; // parâmetros calculados ({ a, b, tx, ty, dz, … }) ou null
let geoAutoOpened = false;
let geoRowsSignature = "";

// ---------------- utilidades ----------------

function log(msg, data) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}` + (data !== undefined ? " " + JSON.stringify(data) : "");
  $("log").textContent = (line + "\n" + $("log").textContent).slice(0, 60000);
  console.log("[CoordenadasCSV]", msg, data ?? "");
}

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = "badge " + kind;
}

function progress(text) {
  $("progress").textContent = text;
  log(text);
}

function onError(err) {
  progress("Erro: " + (err?.message || err));
  console.error(err);
}

const fmt = v => v.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3, useGrouping: false });
const fmtDist = d => d.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m";
const toMm = (p, offset = { x: 0, y: 0, z: 0 }) =>
  ({ positionX: p.x * MM + offset.x, positionY: p.y * MM + offset.y, positionZ: p.z * MM + offset.z });

/** Executa uma tarefa por vez: leituras e alterações nunca se cruzam. */
function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(onError);
  return run;
}

function requestSync(delay = 150) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => enqueue(() => sync()), delay);
}

// ---------------- preferências e sessão ----------------

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem("coordcsv:prefs") || "{}"); } catch { return {}; }
}

function savePrefs() {
  try {
    localStorage.setItem("coordcsv:prefs", JSON.stringify({
      format: $("opt-format").value, header: $("opt-header").checked, labels: $("opt-labels").checked,
      plan: $("opt-plan").checked, coords: $("opt-coords").value, input: $("opt-input").value,
    }));
  } catch { /* navegador sem armazenamento: segue com o padrão */ }
}

const sessionKey = () => keyFor(project?.id);

// Guarda nomes e descrições para reabrir o painel sem perder a numeração.
// O Corte DXF lê estes dados (coordenadas/marked.js) para usar os mesmos nomes.
function saveSession() {
  try {
    sessionStorage.setItem(sessionKey(), JSON.stringify([...points.values()].map(p => ({
      id: p.id, name: p.name, desc: p.desc, origin: p.origin, sources: p.sources, autoDesc: p.autoDesc, plan: p.plan,
      x: p.x, y: p.y, z: p.z, labelId: p.labelId, labelText: p.labelText,
    }))));
  } catch { /* sem armazenamento */ }
}

function takeRestored(id, pos) {
  const meta = restored.get(id);
  if (!meta || distance(meta, pos) > SAME_POINT_M) return null; // outro ponto com o mesmo id
  restored.delete(id);
  const { x, y, z, ...rest } = meta;
  return rest;
}

function takePending(pos) {
  const now = Date.now();
  for (let i = pending.length - 1; i >= 0; i--) if (now - pending[i].at > 30000) pending.splice(i, 1);
  const index = pending.findIndex(item => distance(item, pos) <= SAME_POINT_M);
  if (index < 0) return null;
  const [{ x, y, z, at, ...meta }] = pending.splice(index, 1);
  return meta;
}

// ---------------- leitura dos pontos do Trimble ----------------

const allNames = () => [...points.values(), ...pending].map(p => p.name);

/** Dá P1, P2… aos itens sem nome, continuando a sequência atual. */
function assignNames(items) {
  let n = nextPointNumber(allNames().concat(items.map(item => item.name)));
  return items.map(item => (item.name ? item : { ...item, name: `P${n++}` }));
}

const midDesc = (a, b) => `Médio de ${a.name} e ${b.name}`;
const interDesc = (a, b, c, d, plan) => `Interseção de ${a.name}–${b.name} e ${c.name}–${d.name}${plan ? " (em planta)" : ""}`;

function refreshAutoDescriptions() {
  for (const p of points.values()) {
    if (!p.autoDesc || !p.sources) continue;
    const src = p.sources.map(id => points.get(id));
    if (src.every(Boolean)) {
      p.desc = p.origin === "interseção" ? interDesc(...src, p.plan) : midDesc(...src);
      continue;
    }
    // Origem apagada: o texto fica congelado, senão uma renumeração o faria apontar para outro ponto.
    p.autoDesc = false;
    p.desc += " (origem apagada)";
  }
}

async function sync({ labels = true } = {}) {
  if (!API) return;
  const list = (await API.markup.getSinglePointMarkups()) || [];
  const seen = new Set();
  const sorted = list.filter(m => m?.id != null && m.start)
    .sort((a, b) => (a.id > b.id) - (a.id < b.id)); // ordem de criação
  for (const m of sorted) {
    const pos = { x: m.start.positionX / MM, y: m.start.positionY / MM, z: m.start.positionZ / MM };
    if (![pos.x, pos.y, pos.z].every(Number.isFinite)) continue;
    seen.add(m.id);
    const known = points.get(m.id);
    if (known) { Object.assign(known, pos); continue; }
    const meta = takePending(pos) || takeRestored(m.id, pos) || {};
    const p = { id: m.id, origin: "modelo", desc: "", autoDesc: false, labelId: null, labelText: null, ...meta, ...pos };
    if (!p.name) [p.name] = assignNames([{ name: null }]).map(item => item.name);
    points.set(m.id, p);
    log(`Ponto ${p.name}`, { id: m.id, origem: p.origin, mm: [m.start.positionX, m.start.positionY, m.start.positionZ] });
  }
  const stale = [];
  for (const [id, p] of points) {
    if (seen.has(id)) continue;
    if (p.labelId != null) stale.push({ id: p.labelId, text: p.labelText });
    points.delete(id);
    checked.delete(id);
  }
  refreshAutoDescriptions();
  if (labels) {
    await removeLabels(stale);
    await updateLabels();
  }
  render();
  saveSession();
}

// ---------------- nomes no modelo (marcações de texto) ----------------

const labelKey = p => `${p.name}|${p.x.toFixed(4)}|${p.y.toFixed(4)}|${p.z.toFixed(4)}`;

/** Apaga só marcações de texto que ainda existem e têm o texto que o app colocou. */
async function removeLabels(labels) {
  if (!labels.length) return;
  let existing = null;
  try { existing = await API.markup.getTextMarkups(); } catch { /* segue sem conferir */ }
  const ids = labels
    .filter(l => !existing || existing.some(m => m.id === l.id && (m.text == null || m.text === l.text)))
    .map(l => l.id);
  if (!ids.length) return;
  try { await API.markup.removeMarkups(ids); }
  catch (err) { log("Não consegui apagar nomes do modelo", String(err)); }
}

async function updateLabels() {
  if (labelsBroken || !API.markup.addTextMarkup) return;
  if (!labelsOn) {
    const old = [...points.values()].filter(p => p.labelId != null).map(p => ({ id: p.labelId, text: p.labelText }));
    for (const p of points.values()) Object.assign(p, { labelId: null, labelText: null, labelKey: null });
    await removeLabels(old);
    return;
  }
  const todo = [...points.values()].filter(p => p.labelKey !== labelKey(p));
  if (!todo.length) return;
  try {
    const result = await API.markup.addTextMarkup(todo.map(p => ({
      ...(p.labelId != null ? { id: p.labelId } : {}),
      color: COLORS.nome, text: p.name, start: toMm(p), end: toMm(p, LABEL_OFFSET_MM),
    })));
    let missing = false;
    todo.forEach((p, i) => {
      const id = result?.[i]?.id;
      if (id != null) p.labelId = id; else missing = true;
      p.labelText = p.name;
      p.labelKey = labelKey(p);
    });
    if (missing) await matchLabelIds(todo);
  } catch (err) {
    labelsBroken = true;
    $("opt-labels").disabled = true;
    log("Não consegui mostrar os nomes no modelo", String(err));
  }
}

// Se o Trimble não devolver os ids, procura os textos recém-criados pela posição.
async function matchLabelIds(list) {
  const texts = (await API.markup.getTextMarkups()) || [];
  const owned = new Set([...points.values()].map(p => p.labelId).filter(id => id != null));
  for (const p of list) {
    if (p.labelId != null) continue;
    const start = toMm(p);
    const hit = texts.find(m => !owned.has(m.id) && m.text === p.name && m.start &&
      Math.hypot(m.start.positionX - start.positionX, m.start.positionY - start.positionY, m.start.positionZ - start.positionZ) < 2);
    if (hit) { p.labelId = hit.id; owned.add(hit.id); }
  }
}

/** Na reabertura do painel, só reaproveita nomes que ainda estão no modelo com o mesmo texto. */
async function adoptRestoredLabels() {
  let texts = [];
  try { texts = (await API.markup.getTextMarkups()) || []; } catch { /* sem conferência, recria */ }
  const byId = new Map(texts.map(m => [m.id, m]));
  for (const p of points.values()) {
    if (p.labelId != null && byId.get(p.labelId)?.text !== p.labelText) p.labelId = null;
  }
  const stale = [...restored.values()].filter(m => m.labelId != null && byId.get(m.labelId)?.text === m.labelText)
    .map(m => ({ id: m.labelId, text: m.labelText }));
  restored.clear();
  if (stale.length) {
    try { await API.markup.removeMarkups(stale.map(l => l.id)); } catch (err) { log("Nomes antigos não apagados", String(err)); }
  }
}

// ---------------- ações ----------------

async function addPoints(items, color) {
  const at = Date.now();
  const batch = items.map(item => ({ ...item, at }));
  pending.push(...batch);
  try {
    const result = await API.markup.addSinglePointMarkups(items.map(item => ({ color, start: toMm(item) })));
    log("Marcações de ponto criadas", { pedidas: items.length, devolvidas: result?.length ?? 0 });
  } catch (err) {
    for (const item of batch) { const i = pending.indexOf(item); if (i >= 0) pending.splice(i, 1); }
    throw err;
  }
  await sync();
}

async function toggleCapture() {
  if (capturing) {
    await API.viewer.activateTool("reset");
    capturing = false;
  } else {
    const instruction = { title: "Marcar pontos", text: "Clique nos pontos do modelo. Cada ponto entra na lista do app." };
    try { await API.viewer.activateTool("pointMarkup", { instruction }); }
    catch (err) { log("Ferramenta com instrução falhou, tentando sem", String(err)); await API.viewer.activateTool("pointMarkup"); }
    capturing = true;
    progress("Clique nos pontos do modelo. Use as opções de encaixe do Trimble para pegar vértices e arestas.");
  }
  render(true);
}

function midpointPair() {
  const ids = [...points.keys()];
  const marked = ids.filter(id => checked.has(id));
  if (marked.length === 2) return marked;
  if (!marked.length && ids.length >= 2) return ids.slice(-2);
  return null;
}

async function addMidpoint() {
  const pair = midpointPair();
  if (!pair) throw new Error(checked.size > 2 ? "Marque só 2 pontos para o ponto médio." : "Marque 2 pontos, ou nenhum para usar os 2 últimos.");
  const [a, b] = pair.map(id => points.get(id));
  const [item] = assignNames([{ ...midpoint(a, b), name: null, origin: "médio", sources: [a.id, b.id], autoDesc: true, desc: midDesc(a, b) }]);
  checked.clear();
  await addPoints([item], COLORS.médio);
  progress(`${item.name} criado no meio de ${a.name} e ${b.name} (distância entre eles: ${fmtDist(distance(a, b))}).`);
}

// Linhas da interseção, na ordem em que os pontos foram marcados: assim dá para cruzar
// diagonais (P1–P3 com P2–P4). Sem nenhum marcado, usa os 4 últimos da lista.
function intersectionPoints() {
  const marked = [...checked].filter(id => points.has(id));
  if (marked.length === 4) return marked;
  const ids = [...points.keys()];
  if (!marked.length && ids.length >= 4) return ids.slice(-4);
  return null;
}

async function addIntersection() {
  const ids = intersectionPoints();
  if (!ids) throw new Error(checked.size ? "Marque 4 pontos: os 2 primeiros formam a 1ª linha e os 2 seguintes a 2ª." : "Marque 4 pontos, ou nenhum para usar os 4 últimos.");
  const [a, b, c, d] = ids.map(id => points.get(id));
  const plan = $("opt-plan").checked;
  const hit = lineIntersection(a, b, c, d, { plan });
  const [item] = assignNames([{ x: hit.x, y: hit.y, z: hit.z, name: null, origin: "interseção", sources: ids, plan, autoDesc: true }]);
  item.desc = interDesc(a, b, c, d, plan);
  checked.clear();
  await addPoints([item], COLORS.interseção);
  const lines = `${a.name}–${b.name} e ${c.name}–${d.name}`;
  const detail = plan
    ? ` Diferença de Z entre as linhas no cruzamento: ${fmtDist(hit.gap)} (o ponto fica na média).`
    : hit.gap < 0.0005 ? " As linhas se cruzam."
    : ` As linhas não se cruzam: passam a ${fmtDist(hit.gap)} uma da outra; o ponto fica no meio dessa distância.`;
  progress(`${item.name} criado na interseção de ${lines}.${detail}` + (hit.inside ? "" : " O cruzamento fica no prolongamento das linhas."));
}

// Renumera só os nomes da sequência P1, P2…; nomes próprios (ex.: importados) ficam.
async function renumber() {
  let n = 1;
  for (const p of points.values()) if (/^P\d+$/i.test(p.name || "") || !p.name) p.name = `P${n++}`;
  refreshAutoDescriptions();
  await updateLabels();
  render(true);
  saveSession();
  progress(`Pontos renumerados de P1 a P${n - 1}.`);
}

async function deletePoint(id) {
  await API.markup.removeMarkups([id]);
  await sync();
}

function clearAll() {
  const button = $("btn-clear");
  if (!points.size) return;
  if (!clearTimer) {
    button.textContent = `Confirmar: apagar ${points.size} ponto(s) do modelo`;
    button.classList.add("armed");
    clearTimer = setTimeout(disarmClear, 4000);
    return;
  }
  disarmClear();
  enqueue(async () => {
    const count = points.size;
    await API.markup.removeMarkups([...points.keys()]);
    await sync();
    progress(`${count} ponto(s) apagado(s) do modelo.`);
  });
}

function disarmClear() {
  clearTimeout(clearTimer);
  clearTimer = null;
  $("btn-clear").textContent = "Apagar todos";
  $("btn-clear").classList.remove("armed");
}

const geoActive = () => !!transform && geo.on;
const exportCoords = () => (geoActive() ? $("opt-coords").value : "model");
const inputIsGlobal = () => geoActive() && $("opt-input").value === "global";

function exportCsv() {
  const list = [...points.values()].map(p => ({ ...p, g: geoActive() ? toGlobal(transform, p) : null }));
  if (!list.length) throw new Error("Nenhum ponto para exportar. Marque pontos no modelo primeiro.");
  const names = list.map(p => p.name);
  const repeated = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
  const coords = exportCoords();
  const csv = buildCsv(list, { format: $("opt-format").value, header: $("opt-header").checked, coords });
  const name = csvFileName();
  offerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), name);
  const kind = { model: "coordenadas do modelo", global: "coordenadas globais", both: "coordenadas do modelo e globais" }[coords];
  progress(`${name}: ${list.length} ponto(s), ${kind}.` + (repeated.length ? ` Atenção: nomes repetidos (${repeated.join(", ")}).` : ""));
}

async function readText(file) {
  const buffer = await file.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { return new TextDecoder("windows-1252").decode(buffer); } // CSV salvo pelo Excel em ANSI
}

async function importCsv(file) {
  const { points: rows, skipped } = parseCsv(await readText(file));
  for (const s of skipped) log(`Linha ${s.line} ignorada: ${s.reason}`, s.text);
  if (!rows.length) throw new Error("Nenhum ponto válido no arquivo. Use as colunas Ponto, X, Y, Z (em metros).");
  // Arquivo com as duas coordenadas (exportado daqui): usa as do modelo, sem conversão.
  // Só com uma, a escolha "globais" converte E, N, Cota para o sistema do modelo.
  const global = inputIsGlobal();
  let converted = 0;
  const items = assignNames(rows.map(({ g, ...r }) => {
    const local = !g && global ? toLocal(transform, r) : r;
    if (local !== r) converted++;
    return { ...r, ...local, origin: "importado", autoDesc: false };
  }));
  const far = global ? items.filter(p => looksGlobal(p)).length : 0;
  await addPoints(items, COLORS.importado);
  progress(`${file.name}: ${items.length} ponto(s) marcados no modelo` +
    (converted ? `, ${converted} convertido(s) de coordenadas globais` : "") +
    (skipped.length ? `, ${skipped.length} linha(s) ignorada(s) (veja o Log).` : ".") +
    (far ? " Atenção: depois da conversão, alguns pontos continuam com cara de UTM; confira se o arquivo não estava em coordenadas do modelo." : ""));
}

async function addManualPoint() {
  const values = ["m-x", "m-y", "m-z"].map(id => parseNumber($(id).value));
  if (!values.every(Number.isFinite)) throw new Error("Informe as 3 coordenadas em metros (vírgula ou ponto decimal).");
  const typed = { x: values[0], y: values[1], z: values[2] };
  const global = inputIsGlobal();
  const local = global ? toLocal(transform, typed) : typed;
  const [item] = assignNames([{ ...local, name: $("m-name").value.trim() || null, desc: "", origin: "manual", autoDesc: false }]);
  await addPoints([item], COLORS.manual);
  ["m-name", "m-x", "m-y", "m-z"].forEach(id => { $(id).value = ""; });
  progress(`${item.name} marcado no modelo` + (global ? ` (X ${fmt(local.x)}, Y ${fmt(local.y)}, Z ${fmt(local.z)} no modelo).` : "."));
}

// ---------------- coordenadas globais ----------------

const geoKey = () => `coordcsv:geo:${project?.id || "sem-projeto"}`;

function loadGeo() {
  try {
    const saved = JSON.parse(localStorage.getItem(geoKey()) || "null");
    if (!saved) return GEO_DEFAULT();
    const base = GEO_DEFAULT();
    return { ...base, ...saved, base: { ...base.base, ...saved.base }, control: Array.isArray(saved.control) ? saved.control : [] };
  } catch { return GEO_DEFAULT(); }
}

function saveGeo() {
  try { localStorage.setItem(geoKey(), JSON.stringify(geo)); } catch { /* sem armazenamento */ }
}

const BASE_FIELDS = { x0: "gb-x0", y0: "gb-y0", z0: "gb-z0", E0: "gb-E0", N0: "gb-N0", H0: "gb-H0", rot: "gb-rot", scale: "gb-scale" };

function computeTransform() {
  const result = $("geo-result");
  transform = null;
  result.className = "hint";
  try {
    if (geo.method === "base") {
      const v = Object.fromEntries(Object.keys(BASE_FIELDS).map(k => [k, parseNumber(geo.base[k])]));
      if (![v.E0, v.N0].every(Number.isFinite)) { result.textContent = "Digite E e N globais do ponto base."; return; }
      if (!Number.isFinite(v.H0)) v.H0 = Number.isFinite(v.z0) ? v.z0 : 0; // sem cota: Z do modelo
      transform = fromBasePoint({ x0: v.x0, y0: v.y0, z0: v.z0, E0: v.E0, N0: v.N0, H0: v.H0, rotationDeg: v.rot, scale: v.scale });
    } else {
      const pairs = geo.control.filter(r => r.x != null).map(r => ({
        name: r.name, x: r.x, y: r.y, z: r.z, E: parseNumber(r.E), N: parseNumber(r.N), H: parseNumber(r.H),
      }));
      if (pairs.filter(p => Number.isFinite(p.E) && Number.isFinite(p.N)).length < 2) {
        result.textContent = "Adicione ao menos 2 pontos de controle com E e N.";
        return;
      }
      transform = fitControlPoints(pairs, { freeScale: geo.freeScale });
    }
  } catch (err) {
    result.textContent = err.message;
    result.className = "hint error";
    return;
  }
  const t = transform;
  const parts = [`Rotação ${t.rotationDeg.toLocaleString("pt-BR", { maximumFractionDigits: 4 })}°`,
    `escala ${t.scale.toLocaleString("pt-BR", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}${t.method === "control" && !geo.freeScale ? " (fixa)" : ""}`];
  if (t.method === "control") {
    parts.push(`erro médio em planta ${fmtDist(t.rms)}`);
    if (t.count === 2 && geo.freeScale) parts.push("com 2 pontos e escala calculada não há conferência: use 3 ou mais");
    if (!t.heightFromControl) parts.push("sem cota nos pontos de controle: Cota = Z do modelo");
  }
  const sample = [...points.values()][0];
  if (sample) {
    const g = toGlobal(t, sample);
    parts.push(`${sample.name} → E ${fmt(g.x)}, N ${fmt(g.y)}, Cota ${fmt(g.z)}`);
  }
  const worst = t.residuals ? Math.max(...t.residuals.map(r => r.plan)) : 0;
  result.textContent = parts.join(" · ") + "." + (worst > 0.05 ? " Resíduo acima de 5 cm: confira os pontos de controle." : "");
  result.className = worst > 0.05 ? "hint error" : "hint ok";
}

function geoChanged({ rows = false } = {}) {
  computeTransform();
  saveGeo();
  if (rows) renderGeoRows(); // ação pontual (escolher ponto, remover linha): redesenha mesmo com foco
  else updateGeoRowInfo();
  render(true);
}

/** Linhas dos pontos de controle: ponto da lista + E, N, Cota digitados. */
function renderGeoRows() {
  const list = [...points.values()];
  geoRowsSignature = JSON.stringify([geo.control.length, list.map(p => [p.id, p.name])]);
  $("geo-rows").replaceChildren(...geo.control.map((row, index) => {
    const div = document.createElement("div");
    div.className = "geo-row";
    div.innerHTML = `
      <select aria-label="Ponto da lista"></select>
      <input data-k="E" inputmode="decimal" aria-label="E global" />
      <input data-k="N" inputmode="decimal" aria-label="N global" />
      <input data-k="H" inputmode="decimal" aria-label="Cota global" placeholder="opcional" />
      <button class="pt-del" title="Remover ponto de controle" aria-label="Remover ponto de controle">✕</button>
      <div class="geo-local"></div>`;
    const select = div.querySelector("select");
    const options = [new Option("Escolha…", "")];
    // Só é o mesmo ponto se o id existir e a posição bater (ids podem se repetir em outra sessão).
    const same = row.pointId != null && points.get(row.pointId);
    const current = !!same && row.x != null && distance(same, row) <= SAME_POINT_M;
    for (const p of list) options.push(new Option(p.name, String(p.id), false, current && p.id === row.pointId));
    if (!current && row.x != null) options.push(new Option(`${row.name} (guardado)`, "saved", false, true));
    select.replaceChildren(...options);
    select.onchange = () => {
      const p = points.get(Number(select.value)) || points.get(select.value);
      if (p) Object.assign(row, { pointId: p.id, name: p.name, x: p.x, y: p.y, z: p.z });
      else if (select.value === "") Object.assign(row, { pointId: null, name: "", x: null, y: null, z: null });
      geoChanged({ rows: true });
    };
    for (const input of div.querySelectorAll("input")) {
      input.value = row[input.dataset.k] ?? "";
      input.oninput = () => { row[input.dataset.k] = input.value; geoChanged(); };
    }
    div.querySelector("button").onclick = () => { geo.control.splice(index, 1); geoChanged({ rows: true }); };
    return div;
  }));
  updateGeoRowInfo();
}

/** Texto de cada linha de controle (coordenada no modelo e resíduo), sem recriar os campos. */
function updateGeoRowInfo() {
  [...$("geo-rows").children].forEach((div, index) => {
    const row = geo.control[index];
    const info = div.querySelector(".geo-local");
    if (!row || !info) return;
    const residual = transform?.residuals?.find(r => r.name === row.name);
    info.textContent = row.x == null ? "Escolha um ponto da lista." :
      `${row.name} no modelo: X ${fmt(row.x)}  Y ${fmt(row.y)}  Z ${fmt(row.z)}` + (residual ? ` · resíduo ${fmtDist(residual.plan)}` : "");
    info.classList.toggle("bad", residual?.plan > 0.05);
  });
}

function renderGeo() {
  const list = [...points.values()];
  const local = list.filter(p => !looksGlobal(p));
  const crs = project?.crs?.name ? ` Sistema do projeto no Trimble: ${project.crs.name}.` : "";
  $("geo-detect").textContent = !list.length ? "Marque pontos para verificar se o modelo está em coordenadas locais." + crs
    : local.length ? `Os pontos parecem estar em coordenadas locais (ex.: ${local[0].name}: X ${fmt(local[0].x)}, Y ${fmt(local[0].y)}). Informe abaixo como converter para coordenadas globais (UTM).` + crs
    : "Os pontos já parecem estar em coordenadas globais (UTM): a conversão normalmente não é necessária." + crs;
  const badge = $("geo-badge");
  badge.textContent = geoActive() ? "ativa" : local.length ? "coordenadas locais" : "";
  badge.className = "geo-badge " + (geoActive() ? "on" : local.length ? "local" : "");
  if (!geoAutoOpened && local.length && !transform) { $("geo").open = true; geoAutoOpened = true; }
  $("geo-control").hidden = geo.method !== "control";
  $("geo-base").hidden = geo.method !== "base";
  $("coords-choice").hidden = !geoActive();
  $("input-choice").hidden = !geoActive();
  $("export-geo-hint").hidden = geoActive() || !local.length;
  const coords = exportCoords();
  $("columns-hint").textContent = `Colunas: Ponto, ${{ model: "X, Y, Z", global: "E, N, Cota", both: "X, Y, Z (modelo), E, N, Cota (globais)" }[coords]} em metros (3 casas) e Descrição.`;
  const g = inputIsGlobal();
  $("m-x-label").textContent = g ? "E (m)" : "X (m)";
  $("m-y-label").textContent = g ? "N (m)" : "Y (m)";
  $("m-z-label").textContent = g ? "Cota (m)" : "Z (m)";
  const typing = $("geo-rows").contains(document.activeElement);
  const signature = JSON.stringify([geo.control.length, list.map(p => [p.id, p.name])]);
  if (!typing && signature !== geoRowsSignature) renderGeoRows();
  else updateGeoRowInfo();
}

function offerDownload(blob, name) {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = name;
  a.textContent = `Baixar ${name}`;
  a.className = "download";
  $("download").replaceChildren(a);
  a.click();
}

// ---------------- tela ----------------

function render(force = false) {
  const pair = midpointPair();
  const midButton = $("btn-mid");
  midButton.disabled = !pair;
  midButton.textContent = pair ? `Ponto médio de ${pair.map(id => points.get(id).name).join(" e ")}` : "Ponto médio";
  const four = intersectionPoints();
  const names = four?.map(id => points.get(id).name);
  $("btn-inter").disabled = !four;
  $("btn-inter").textContent = four ? `Interseção ${names[0]}–${names[1]} × ${names[2]}–${names[3]}` : "Interseção";
  $("btn-capture").textContent = capturing ? "Parar de marcar pontos" : "Marcar pontos no modelo";
  $("btn-capture").classList.toggle("active", capturing);
  $("simulate").hidden = EMBEDDED || !capturing;
  $("btn-export").textContent = points.size ? `Exportar CSV (${points.size} ponto${points.size > 1 ? "s" : ""})` : "Exportar CSV";
  $("count").textContent = points.size ? `(${points.size})` : "";
  $("empty").hidden = points.size > 0;
  for (const id of ["btn-renumber", "btn-clear", "btn-export"]) $(id).disabled = !points.size;

  const t = geoActive() ? [transform.a, transform.b, transform.tx, transform.ty, transform.dz] : null;
  const signature = JSON.stringify([t, [...points.values()].map(p => [p.id, p.name, p.desc, p.x, p.y, p.z, p.origin, checked.has(p.id)])]);
  if (!force && signature === shownSignature) { renderGeo(); return; }
  computeTransform(); // os parâmetros não mudam; atualiza o exemplo do resultado com a lista nova
  shownSignature = signature;
  renderGeo();

  // Mantém o foco de quem está digitando quando uma leitura nova redesenha a lista.
  const active = document.activeElement;
  const focus = active?.closest?.("li.pt") && { id: active.closest("li.pt").dataset.id, cls: active.className, pos: active.selectionStart };

  const list = $("point-list");
  list.replaceChildren(...[...points.values()].map(p => {
    const li = document.createElement("li");
    li.className = "pt";
    li.dataset.id = String(p.id);
    li.innerHTML = `
      <input type="checkbox" class="pt-check" aria-label="Usar no ponto médio ou na interseção" />
      <input class="pt-name" aria-label="Nome do ponto" spellcheck="false" />
      <span class="pt-origin"></span>
      <button class="pt-del" title="Apagar este ponto do modelo" aria-label="Apagar ponto">✕</button>
      <div class="pt-xyz"><span>X <b></b></span><span>Y <b></b></span><span>Z <b></b></span></div>
      <input class="pt-desc" placeholder="Descrição (opcional)" aria-label="Descrição" />`;
    if (geoActive()) {
      const g = toGlobal(transform, p);
      const line = document.createElement("div");
      line.className = "pt-geo";
      line.title = "Coordenadas globais (convertidas)";
      for (const [label, value] of [["E", g.x], ["N", g.y], ["Cota", g.z]]) {
        const span = document.createElement("span");
        const b = document.createElement("b");
        b.textContent = fmt(value);
        span.append(`${label} `, b);
        line.append(span);
      }
      li.querySelector(".pt-xyz").after(line);
    }
    const check = li.querySelector(".pt-check");
    check.checked = checked.has(p.id);
    check.onchange = () => { check.checked ? checked.add(p.id) : checked.delete(p.id); render(); };
    const name = li.querySelector(".pt-name");
    name.value = p.name;
    name.oninput = () => { p.name = name.value.trim(); };
    name.onchange = () => enqueue(async () => {
      if (!p.name) p.name = assignNames([{ name: null }])[0].name;
      refreshAutoDescriptions(); await updateLabels(); render(true); saveSession();
    });
    const desc = li.querySelector(".pt-desc");
    desc.value = p.desc || "";
    desc.oninput = () => { p.desc = desc.value; p.autoDesc = false; };
    desc.onchange = () => saveSession();
    const origin = li.querySelector(".pt-origin");
    origin.textContent = p.origin === "modelo" ? "" : p.origin;
    origin.dataset.origin = p.origin;
    li.querySelector(".pt-del").onclick = () => enqueue(() => deletePoint(p.id));
    li.querySelectorAll(".pt-xyz b").forEach((b, i) => { b.textContent = fmt([p.x, p.y, p.z][i]); });
    return li;
  }));

  if (focus) {
    const target = list.querySelector(`li.pt[data-id="${CSS.escape(focus.id)}"] .${focus.cls.split(" ")[0]}`);
    if (target) { target.focus(); try { target.setSelectionRange(focus.pos, focus.pos); } catch { /* checkbox */ } }
  }
}

// ---------------- conexão ----------------

function onEvent(event, args) {
  const data = args?.data;
  if (event === "viewer.onMarkupChanged") {
    if (data?.markupType !== "textMarkup") requestSync();
  } else if (event === "viewer.onToolChanged") {
    capturing = data?.new === "pointMarkup";
    render(true);
  } else if (event === "viewer.onModelReset") {
    requestSync();
  }
}

async function init() {
  $("version").textContent = V ? V.replace("?v=", "v") : "";
  log(`Versão ${V || "(sem número)"}`);
  const prefs = loadPrefs();
  if (prefs.format) $("opt-format").value = prefs.format;
  if (prefs.header === false) $("opt-header").checked = false;
  if (prefs.labels === false) $("opt-labels").checked = false;
  if (prefs.plan) $("opt-plan").checked = true;
  if (prefs.coords) $("opt-coords").value = prefs.coords;
  if (prefs.input) $("opt-input").value = prefs.input;
  labelsOn = $("opt-labels").checked;

  $("btn-capture").onclick = () => enqueue(toggleCapture);
  $("btn-mid").onclick = () => enqueue(addMidpoint);
  $("btn-inter").onclick = () => enqueue(addIntersection);
  for (const id of ["opt-plan", "opt-coords", "opt-input"]) $(id).onchange = () => { savePrefs(); render(); };
  $("geo-method").onchange = () => { geo.method = $("geo-method").value; geoChanged({ rows: true }); };
  $("geo-scale").onchange = () => { geo.freeScale = $("geo-scale").checked; geoChanged({ rows: true }); };
  $("geo-on").onchange = () => { geo.on = $("geo-on").checked; geoChanged(); };
  $("geo-add").onclick = () => {
    // Já sugere o próximo ponto da lista que ainda não é ponto de controle.
    const used = new Set(geo.control.map(r => r.pointId));
    const p = [...points.values()].find(item => !used.has(item.id));
    geo.control.push(p ? { pointId: p.id, name: p.name, x: p.x, y: p.y, z: p.z, E: "", N: "", H: "" }
      : { pointId: null, name: "", x: null, y: null, z: null, E: "", N: "", H: "" });
    geoChanged({ rows: true });
    $("geo-rows").lastElementChild?.querySelector('input[data-k="E"]')?.focus();
  };
  for (const [key, id] of Object.entries(BASE_FIELDS)) $(id).oninput = () => { geo.base[key] = $(id).value; geoChanged(); };
  $("btn-renumber").onclick = () => enqueue(renumber);
  $("btn-refresh").onclick = () => enqueue(async () => { await sync(); progress(`${points.size} ponto(s) no modelo.`); });
  $("btn-clear").onclick = clearAll;
  $("btn-export").onclick = () => { try { exportCsv(); } catch (err) { onError(err); } };
  $("file").onchange = () => {
    const file = $("file").files?.[0];
    if (file) enqueue(() => importCsv(file)).finally(() => { $("file").value = ""; });
  };
  $("btn-manual").onclick = () => enqueue(addManualPoint);
  $("opt-format").onchange = savePrefs;
  $("opt-header").onchange = savePrefs;
  $("opt-labels").onchange = () => { labelsOn = $("opt-labels").checked; savePrefs(); enqueue(async () => { await updateLabels(); saveSession(); }); };
  $("btn-download-log").onclick = () => {
    if (logDownloadUrl) URL.revokeObjectURL(logDownloadUrl);
    const text = `Coordenadas CSV ${V}\n${new Date().toISOString()}\n\n${$("log").textContent}`;
    logDownloadUrl = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = logDownloadUrl;
    link.download = "coordenadas-csv-log.txt";
    link.click();
  };
  render(true);

  if (EMBEDDED) {
    try {
      API = await window.TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000);
      setStatus("Conectado", "ok");
    } catch (err) {
      setStatus("Não conectou", "error");
      log("Erro ao conectar", String(err));
      return;
    }
  } else {
    const { createMockApi } = await import(`./mock-viewer.js${V}`);
    API = createMockApi(onEvent);
    window.coordMock = API; // para testes no console
    setStatus("Modo local", "warn");
    $("local-note").hidden = false;
    $("btn-simulate").onclick = () => {
      const jitter = () => Math.round(Math.random() * 20000) / 1000;
      API.simulatePick(734800 + jitter(), 7527190 + jitter(), 440 + jitter() / 4);
    };
  }

  try {
    project = await API.project.getCurrentProject();
    log("Projeto", { name: project?.name });
  } catch (err) {
    log("Erro em getCurrentProject", String(err));
  }
  if (!API.markup?.getSinglePointMarkups) {
    setStatus("Sem suporte", "error");
    progress("Erro: esta versão do Trimble Connect não oferece as marcações de ponto pela API.");
    return;
  }
  geo = loadGeo();
  $("geo-method").value = geo.method;
  $("geo-scale").checked = !!geo.freeScale;
  $("geo-on").checked = geo.on !== false;
  for (const [key, id] of Object.entries(BASE_FIELDS)) $(id).value = geo.base[key] ?? "";
  computeTransform();
  if (geo.control.length || geo.method === "base") log("Conversão para coordenadas globais carregada", { metodo: geo.method, pontosDeControle: geo.control.length });
  restored = loadSavedPoints(project?.id);
  await enqueue(async () => {
    await sync({ labels: false });
    await adoptRestoredLabels();
    await updateLabels();
    render(true);
    saveSession();
  });
  if (points.size) progress(`${points.size} ponto(s) encontrados no modelo.`);
  // Os eventos já avisam de pontos novos; a leitura periódica cobre ferramentas que não avisam.
  setInterval(() => { if (document.visibilityState === "visible") requestSync(0); }, POLL_MS);
}

init().catch(onError);
