// Extensão "Coordenadas CSV" para o Visualizador 3D do Trimble Connect for Browser.
// Os pontos são as marcações de ponto do próprio Trimble (Medir → Ponto, ou o botão
// "Marcar pontos no modelo" daqui). O app numera P1, P2…, cria pontos médios, exporta CSV
// e importa CSV de volta como marcações no modelo.
// Aberto fora do Trimble Connect, usa um visualizador simulado (modo local).

const V = new URL(import.meta.url).search;
const { buildCsv, parseCsv, parseNumber, midpoint, distance, nextPointNumber, csvFileName } =
  await import(`./points.js${V}`);

const $ = id => document.getElementById(id);
const EMBEDDED = window.parent !== window;
const MM = 1000; // a API de marcações usa mm; o app trabalha em metros
const SAME_POINT_M = 0.002; // posições a menos de 2 mm são o mesmo ponto
const POLL_MS = 3000;
const LABEL_OFFSET_MM = { x: 300, y: 300, z: 700 }; // nome um pouco acima e ao lado do ponto
const COLORS = {
  médio: { r: 230, g: 120, b: 0, a: 255 },
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
    }));
  } catch { /* navegador sem armazenamento: segue com o padrão */ }
}

const sessionKey = () => `coordcsv:${project?.id || "sem-projeto"}`;

// Guarda nomes e descrições para reabrir o painel sem perder a numeração.
function saveSession() {
  try {
    sessionStorage.setItem(sessionKey(), JSON.stringify([...points.values()].map(p => ({
      id: p.id, name: p.name, desc: p.desc, origin: p.origin, sources: p.sources, autoDesc: p.autoDesc,
      x: p.x, y: p.y, z: p.z, labelId: p.labelId, labelText: p.labelText,
    }))));
  } catch { /* sem armazenamento */ }
}

function loadSession() {
  try {
    const list = JSON.parse(sessionStorage.getItem(sessionKey()) || "[]");
    return new Map(list.map(item => [item.id, item]));
  } catch { return new Map(); }
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

function refreshAutoDescriptions() {
  for (const p of points.values()) {
    if (!p.autoDesc || !p.sources) continue;
    const [a, b] = p.sources.map(id => points.get(id));
    if (a && b) { p.desc = midDesc(a, b); continue; }
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

function exportCsv() {
  const list = [...points.values()];
  if (!list.length) throw new Error("Nenhum ponto para exportar. Marque pontos no modelo primeiro.");
  const names = list.map(p => p.name);
  const repeated = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
  const csv = buildCsv(list, { format: $("opt-format").value, header: $("opt-header").checked });
  const name = csvFileName();
  offerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), name);
  progress(`${name}: ${list.length} ponto(s).` + (repeated.length ? ` Atenção: nomes repetidos (${repeated.join(", ")}).` : ""));
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
  const items = assignNames(rows.map(r => ({ ...r, origin: "importado", autoDesc: false })));
  await addPoints(items, COLORS.importado);
  progress(`${file.name}: ${items.length} ponto(s) marcados no modelo` +
    (skipped.length ? `, ${skipped.length} linha(s) ignorada(s) (veja o Log).` : "."));
}

async function addManualPoint() {
  const [x, y, z] = ["m-x", "m-y", "m-z"].map(id => parseNumber($(id).value));
  if (![x, y, z].every(Number.isFinite)) throw new Error("Informe X, Y e Z em metros (vírgula ou ponto decimal).");
  const [item] = assignNames([{ x, y, z, name: $("m-name").value.trim() || null, desc: "", origin: "manual", autoDesc: false }]);
  await addPoints([item], COLORS.manual);
  ["m-name", "m-x", "m-y", "m-z"].forEach(id => { $(id).value = ""; });
  progress(`${item.name} marcado no modelo.`);
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
  $("btn-capture").textContent = capturing ? "Parar de marcar pontos" : "Marcar pontos no modelo";
  $("btn-capture").classList.toggle("active", capturing);
  $("simulate").hidden = EMBEDDED || !capturing;
  $("btn-export").textContent = points.size ? `Exportar CSV (${points.size} ponto${points.size > 1 ? "s" : ""})` : "Exportar CSV";
  $("count").textContent = points.size ? `(${points.size})` : "";
  $("empty").hidden = points.size > 0;
  for (const id of ["btn-renumber", "btn-clear", "btn-export"]) $(id).disabled = !points.size;

  const signature = JSON.stringify([...points.values()].map(p => [p.id, p.name, p.desc, p.x, p.y, p.z, p.origin, checked.has(p.id)]));
  if (!force && signature === shownSignature) return;
  shownSignature = signature;

  // Mantém o foco de quem está digitando quando uma leitura nova redesenha a lista.
  const active = document.activeElement;
  const focus = active?.closest?.("li.pt") && { id: active.closest("li.pt").dataset.id, cls: active.className, pos: active.selectionStart };

  const list = $("point-list");
  list.replaceChildren(...[...points.values()].map(p => {
    const li = document.createElement("li");
    li.className = "pt";
    li.dataset.id = String(p.id);
    li.innerHTML = `
      <input type="checkbox" class="pt-check" aria-label="Usar no ponto médio" />
      <input class="pt-name" aria-label="Nome do ponto" spellcheck="false" />
      <span class="pt-origin"></span>
      <button class="pt-del" title="Apagar este ponto do modelo" aria-label="Apagar ponto">✕</button>
      <div class="pt-xyz"><span>X <b></b></span><span>Y <b></b></span><span>Z <b></b></span></div>
      <input class="pt-desc" placeholder="Descrição (opcional)" aria-label="Descrição" />`;
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
  labelsOn = $("opt-labels").checked;

  $("btn-capture").onclick = () => enqueue(toggleCapture);
  $("btn-mid").onclick = () => enqueue(addMidpoint);
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
  restored = loadSession();
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
