// Extensão "Corte DXF" para o Visualizador 3D do Trimble Connect for Browser.
// Fluxo: lê o plano da tesoura -> baixa o IFC do modelo -> alinha coordenadas
//        -> corta a geometria -> monta polilinhas -> baixa o .dxf.
// Aberto fora do Trimble Connect, funciona em "modo local": IFC do computador + plano manual.

// A versão vem do index.html (app.js?v=N) e é repassada a todos os módulos,
// para que cada publicação nova não seja servida do cache do navegador.
const V = new URL(import.meta.url).search;
const [
  { createIfcSession },
  { createModelSource, assertIfcSize },
  { makeSectionPlane },
  { buildDxfBlob },
  { fitAlignment },
  { expandIfcGuid, canonGuid },
  { buildTrimbleJob },
] = await Promise.all([
  import(`./ifc-client.js${V}`),
  import(`./model-source.js${V}`),
  import(`./section.js${V}`),
  import(`./dxf.js${V}`),
  import(`./align.js${V}`),
  import(`./guid.js${V}`),
  import(`./trimble-job.js${V}`),
]);

// Erro médio máximo aceito no alinhamento (m). Acima disso o corte não é exportado.
const MAX_ALIGN_ERROR_M = 0.1;

const $ = (id) => document.getElementById(id);
const EMBEDDED = window.parent !== window;

let API = null;
let accessToken = null;
let tokenWaiters = [];
let project = null;
let planes = [];
let models = [];
let generation = null;
let downloadUrl = null;
let logDownloadUrl = null;
const modelChoices = new Map();
const source = createModelSource({
  getLoadedModel: id => API.viewer.getLoadedModel(id),
  getMetadata: getModelMetadata,
  download: downloadModel,
  onStatus: (origin, model) => {
    const action = { cache: "Reutilizando IFC em cache", trimble: "Consultando IFC carregado no Trimble", download: "Baixando IFC" }[origin];
    progress(`${action}: ${model.name}…`);
  },
});

// ---------------- utilidades ----------------

function log(msg, data) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}` + (data !== undefined ? " " + JSON.stringify(data) : "");
  $("log").textContent = (line + "\n" + $("log").textContent).slice(0, 60000);
  console.log("[CorteDXF]", msg, data ?? "");
}

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = "badge " + kind;
}

function progress(text) {
  $("progress").textContent = text;
  log(text);
}

const nextFrame = () => new Promise((r) => setTimeout(r, 30)); // deixa a tela atualizar
const vec = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);

// ---------------- conexão ----------------

async function init() {
  $("version").textContent = V ? V.replace("?v=", "v") : "";
  log(`Versão ${V || "(sem número)"}`);
  $("btn-refresh").onclick = refresh;
  $("btn-generate").onclick = () => generate().catch(onError);
  $("btn-export-local").onclick = () => exportLocalJob().catch(onError);
  $("btn-export-local-warning").onclick = () => exportLocalJob().catch(onError);
  $("file").onchange = renderModels;
  $("btn-cancel").onclick = () => {
    generation?.controller.abort();
    generation?.session?.close(new DOMException("Geração cancelada.", "AbortError"));
  };
  $("btn-clear-cache").onclick = () => { source.clear(); progress("Cache de IFCs limpo."); };
  $("btn-models-all").onclick = () => selectModels(true);
  $("btn-models-none").onclick = () => selectModels(false);
  $("btn-download-log").onclick = () => {
    if (logDownloadUrl) URL.revokeObjectURL(logDownloadUrl);
    const text = `Corte DXF ${V}\n${new Date().toISOString()}\n\n${$("log").textContent}`;
    logDownloadUrl = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = logDownloadUrl;
    link.download = "corte-dxf-log.txt";
    link.click();
  };

  if (!EMBEDDED) {
    setStatus("Modo local", "warn");
    $("manual-plane").hidden = false;
    $("btn-refresh").hidden = true;
    $("local-processing").hidden = true;
    $("planes").innerHTML = '<p class="hint">Fora do Trimble Connect: informe o plano abaixo.</p>';
    renderModels();
    return;
  }

  try {
    API = await window.TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000);
    setStatus("Conectado", "ok");
  } catch (err) {
    setStatus("Não conectou", "error");
    log("Erro ao conectar", String(err));
    return;
  }

  try {
    project = await API.project.getCurrentProject();
    log("Projeto", { name: project.name, location: project.location });
  } catch (err) {
    log("Erro em getCurrentProject", String(err));
  }
  await refresh();
}

function onEvent(event, args) {
  if (event === "extension.accessToken") onToken(args?.data);
  else if (event === "viewer.onModelStateChanged") refresh();
  else if (event === "viewer.onSectionPlanesChanged") refresh();
}

async function refresh() {
  if (!API) return;
  if (generation) { generation.refreshPending = true; return; }
  let nextPlanes = [], nextModels = [];
  try {
    nextPlanes = (await API.viewer.getSectionPlanes()) || [];
  } catch (err) {
    log("Erro em getSectionPlanes", String(err));
  }
  try {
    nextModels = (await API.viewer.getModels("loaded")) || [];
  } catch (err) {
    log("Erro em getModels", String(err));
  }
  if (generation) { generation.refreshPending = true; return; }
  planes = nextPlanes;
  models = nextModels;
  source.prune(models, project?.id);
  renderPlanes();
  renderModels();
}

// ---------------- telas ----------------

function describePlane(p) {
  const d = [p.directionX, p.directionY, p.directionZ].map((x) => +(x ?? 0).toFixed(2));
  const pos = [p.positionX, p.positionY, p.positionZ].map((x) => Math.round(x ?? 0));
  const kind = Math.abs(d[2]) > 0.9 ? "Planta (horizontal)" : Math.abs(d[2]) < 0.1 ? "Corte (vertical)" : "Inclinado";
  return `${kind} — ponto [${pos.join(", ")}] mm, normal [${d.join(", ")}]`;
}

function renderPlanes() {
  const selected = document.querySelector('input[name="plane"]:checked')?.dataset.planeId;
  const selectedExists = planes.some((plane, i) => String(plane.id ?? i) === selected);
  const box = $("planes");
  if (!planes.length) {
    box.innerHTML =
      '<p class="hint">Nenhum plano de corte. Use a <strong>tesoura</strong> do visualizador ' +
      "(Plano de corte) e clique em <em>Atualizar planos</em>.</p>";
    return;
  }
  box.innerHTML = "";
  planes.forEach((p, i) => {
    const label = document.createElement("label");
    label.className = "check";
    label.innerHTML = `<input type="radio" name="plane" value="${i}" ${i === planes.length - 1 ? "checked" : ""}/> `;
    const input = label.querySelector("input");
    input.dataset.planeId = String(p.id ?? i);
    input.checked = selectedExists ? String(p.id ?? i) === selected : i === planes.length - 1;
    label.append(describePlane(p));
    box.append(label);
  });
}

function renderModels() {
  const box = $("models");
  const file = $("file").files?.[0];
  box.innerHTML = "";

  if (file) {
    box.innerHTML = `<p>Usando arquivo local: <strong></strong></p>`;
    box.querySelector("strong").textContent = file.name;
    if (EMBEDDED && models.length) {
      box.innerHTML += '<p class="hint">Ele será alinhado com o 1º modelo marcado abaixo.</p>';
    } else return;
  }

  if (!EMBEDDED) {
    box.innerHTML = '<p class="hint">Escolha um arquivo .ifc.</p>';
    return;
  }
  if (!models.length) {
    box.innerHTML += '<p class="hint">Nenhum modelo carregado no visualizador.</p>';
    return;
  }
  models.forEach((m, i) => {
    const isIfc = /\.ifc$/i.test(m.name || "");
    const label = document.createElement("label");
    label.className = "check" + (isIfc ? "" : " disabled");
    label.innerHTML = `<input type="checkbox" value="${i}" ${isIfc ? "checked" : "disabled"}/> `;
    const input = label.querySelector("input");
    input.checked = isIfc && (modelChoices.get(m.id) ?? true);
    input.onchange = () => modelChoices.set(m.id, input.checked);
    label.append(m.name || m.id);
    if (!isIfc) label.title = "Só IFC é suportado. Exporte o modelo como IFC e envie ao projeto.";
    box.append(label);
  });
}

function selectModels(checked) {
  for (const model of models) if (/\.ifc$/i.test(model.name || "")) modelChoices.set(model.id, checked);
  renderModels();
}

// ---------------- token e download ----------------

// Um token de verdade é uma string longa; "pending", "denied" etc. são só status.
const isToken = (v) => typeof v === "string" && v.length > 30 && !/\s/.test(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function onToken(value) {
  if (value === "denied") {
    tokenWaiters.forEach((w) => w.reject(new Error("Permissão de token negada.")));
    tokenWaiters = [];
  } else if (isToken(value)) {
    accessToken = value;
    tokenWaiters.forEach((w) => w.resolve(value));
    tokenWaiters = [];
  }
}

async function getToken(force = false, signal) {
  signal?.throwIfAborted();
  if (accessToken && !force) return accessToken;
  accessToken = null;
  for (let i = 0; i < 3; i++) {
    const r = await API.extension.requestPermission("accesstoken");
    signal?.throwIfAborted();
    if (isToken(r)) return (accessToken = r);
    if (r === "denied") throw new Error("Permissão de token negada.");
    if (r === "pending") break;
    log("Status inesperado do token", r);
    await sleep(500);
    signal?.throwIfAborted();
  }
  progress("Autorize o acesso na janela do Trimble Connect…");
  return new Promise((resolve, reject) => {
    const waiter = { resolve: value => finish(null, value), reject: err => finish(err) };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("Tempo esgotado esperando autorização.")), 120000);
    function finish(error, value) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      tokenWaiters = tokenWaiters.filter(item => item !== waiter);
      if (error) reject(error);
      else resolve(value);
    }
    tokenWaiters.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

const REGION_HOSTS = {
  northamerica: "https://app.connect.trimble.com/tc/api/2.0/",
  europe: "https://app21.connect.trimble.com/tc/api/2.0/",
  asia: "https://app31.connect.trimble.com/tc/api/2.0/",
  australia: "https://app32.connect.trimble.com/tc/api/2.0/",
};

function apiBase() {
  const loc = String(project?.location || "northAmerica").toLowerCase();
  return REGION_HOSTS[loc] || REGION_HOSTS.northamerica;
}

// Chamada autenticada; se vier 401 (token vencido/inválido), pede um token novo e repete uma vez.
async function authedFetch(url, signal) {
  let res = await fetch(url, { signal, headers: { Authorization: `Bearer ${await getToken(false, signal)}` } });
  if (res.status === 401) {
    log("401 — pedindo novo token");
    res = await fetch(url, { signal, headers: { Authorization: `Bearer ${await getToken(true, signal)}` } });
  }
  return res;
}

async function downloadModel(model, signal) {
  const base = apiBase();
  const v = model.versionId ? `?versionId=${encodeURIComponent(model.versionId)}` : "";
  const candidates = [`${base}files/fs/${model.id}/downloadurl${v}`, `${base}files/${model.id}/downloadurl${v}`];

  let url = null;
  for (const c of candidates) {
    try {
      const res = await authedFetch(c, signal);
      if (!res.ok) {
        log(`downloadurl ${res.status}`, c);
        continue;
      }
      const body = await res.json();
      url = body.url || body.downloadUrl;
      if (url) break;
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      log("Erro em downloadurl", String(err));
    }
  }
  if (!url) throw new Error("Não consegui o link de download do modelo. Use 'Carregar IFC do computador'.");

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Falha no download do IFC (${res.status}). Use 'Carregar IFC do computador'.`);
  try { assertIfcSize(Number(res.headers.get("Content-Length"))); }
  catch (error) { await res.body?.cancel(); throw error; }
  return res.arrayBuffer();
}

async function getModelMetadata(model, signal) {
  const version = model.versionId ? `?versionId=${encodeURIComponent(model.versionId)}` : "";
  const response = await authedFetch(`${apiBase()}files/${encodeURIComponent(model.id)}${version}`, signal);
  if (!response.ok) throw new Error(`Metadados do IFC indisponíveis (${response.status}).`);
  return response.json();
}

// ---------------- alinhamento IFC <-> visualizador ----------------

/**
 * Compara caixas envolventes dos mesmos objetos no IFC (m) e no visualizador
 * para descobrir escala e deslocamento: viewer = s * ifc + t.
 */
async function calibrate(modelId, ifcModel, signal) {
  const samples = await ifcModel.sampleBoxes(40);
  signal?.throwIfAborted();
  if (!samples.length) throw new Error("sem amostras");

  // A documentação pede o GUID descompactado; o compactado fica como reserva.
  const formats = [
    ["descompactado", (g) => expandIfcGuid(g) || g],
    ["descompactado maiúsculo", (g) => (expandIfcGuid(g) || g).toUpperCase()],
    ["compactado", (g) => g],
  ];
  let runtimeIds = [];
  let hits = -1;
  for (const [name, fmt] of formats) {
    let r = [];
    try {
      r = (await API.viewer.convertToObjectRuntimeIds(modelId, samples.map((s) => fmt(s.guid)))) || [];
      signal?.throwIfAborted();
    } catch (err) {
      signal?.throwIfAborted();
      log(`convertToObjectRuntimeIds (${name}) falhou`, String(err));
    }
    const h = r.filter((x) => x != null).length;
    log(`GUIDs ${name}: ${h}/${samples.length} encontrados`);
    if (h > hits) [runtimeIds, hits] = [r, h];
    if (h === samples.length) break;
  }
  const byRuntime = new Map();
  runtimeIds.forEach((rid, i) => rid != null && byRuntime.set(rid, samples[i]));
  if (!byRuntime.size) throw new Error("GUIDs do IFC não encontrados no visualizador");

  const vboxes = await API.viewer.getObjectBoundingBoxes(modelId, [...byRuntime.keys()]);
  signal?.throwIfAborted();
  const pairs = [];
  for (const vb of vboxes || []) {
    const s = byRuntime.get(vb.id);
    const box = vb.boundingBox;
    if (!s || !box?.min || !box?.max) continue;
    pairs.push({ ifc: { min: s.min, max: s.max }, v: { min: vec(box.min), max: vec(box.max) } });
  }
  if (!pairs.length) throw new Error("caixas do visualizador indisponíveis");

  return fitAlignment(pairs); // escala (potência de 10), rotação em Z e deslocamento
}

/** Converte o plano da tesoura (mm, coordenadas do visualizador) para o espaço do IFC (m). */
function planeToIfc(plane, calib) {
  const pmm = [plane.positionX, plane.positionY, plane.positionZ];
  const normal = [plane.directionX, plane.directionY, plane.directionZ];
  if (!calib) return { point: pmm.map((x) => x / 1000), normal };
  const inViewerUnits = pmm.map((x) => (x * calib.s) / 1000); // mm -> unidade das caixas do visualizador
  return { point: calib.toIfcPoint(inViewerUnits), normal: calib.toIfcDir(normal) };
}

// ---------------- gerar ----------------

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function exportLocalJob() {
  if (generation) return;
  if (!API) throw new Error("Conecte ao Trimble antes de exportar a configuração.");
  const plane = planes[Number(document.querySelector('input[name="plane"]:checked')?.value)];
  if (!plane) throw new Error("Escolha o plano da tesoura.");
  const checked = [...document.querySelectorAll('#models input[type="checkbox"]:checked')].map(c => models[Number(c.value)]);
  const options = {
    depth: Number($("opt-depth").value), direction: $("opt-depth-reverse").checked ? 1 : -1,
    units: $("opt-units").value, mirror: $("opt-mirror").checked,
    grid: $("opt-grid").checked, hatching: $("opt-hatch").checked,
    onlySelected: $("opt-selected").checked,
  };
  if (!$("opt-depth").value.trim()) throw new Error("Informe a profundidade em metros.");
  const run = { controller: new AbortController(), session: null, refreshPending: false };
  generation = run;
  const controls = [...document.querySelectorAll("main input, main select, main button")];
  const disabled = controls.map(c => c.disabled);
  controls.forEach(c => { c.disabled = true; });
  $("btn-cancel").hidden = false; $("btn-cancel").disabled = false;
  try {
    progress("Consultando referências de alinhamento para o processamento local…");
    const job = await buildTrimbleJob({ project: { ...project, region: project?.location }, plane, options, models: checked, api: API, signal: run.controller.signal });
    run.controller.signal.throwIfAborted();
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    offerDownload(new Blob([JSON.stringify(job, null, 2)], { type: "application/json" }), "corte-trimble.json");
    for (const warning of job.warnings) log("Processamento local", warning);
    progress(`Configuração exportada: ${job.models.length} modelo(s). Abra no Corte DXF Local e escolha os IFCs da mesma revisão.` +
      (job.warnings.length ? " Há referências a conferir; veja o Log." : ""));
  } catch (error) {
    if (run.controller.signal.aborted) progress("Exportação cancelada.");
    else throw error;
  } finally {
    controls.forEach((c, i) => { c.disabled = disabled[i]; });
    $("btn-cancel").hidden = true; generation = null;
    if (run.refreshPending) refresh();
  }
}

async function generate() {
  if (generation) return;
  const run = { controller: new AbortController(), session: null, refreshPending: false };
  generation = run;
  const signal = run.controller.signal;
  const controls = [...document.querySelectorAll("main input, main select, main button")];
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  $("btn-cancel").hidden = false;
  $("btn-cancel").disabled = false;
  $("download").innerHTML = "";
  $("skipped-files").replaceChildren();
  $("warnings").hidden = true;
  $("local-hint").hidden = true;
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  let currentFile = "", stage = "opções";
  try {
    const opts = {
      onlySelected: $("opt-selected").checked, mirror: $("opt-mirror").checked,
      units: $("opt-units").value, depth: Number($("opt-depth").value),
      direction: $("opt-depth-reverse").checked ? 1 : -1,
      grid: $("opt-grid").checked, hatching: $("opt-hatch").checked,
    };
    if (!$("opt-depth").value.trim() || !Number.isFinite(opts.depth) || opts.depth < 0) {
      throw new Error("Informe uma profundidade em metros, maior ou igual a zero.");
    }
    log("Profundidade da vista", { metros: opts.depth, sentido: opts.direction });
    const scale = opts.units === "m" ? 1 : 1000;
    const file = $("file").files?.[0];
    let tcPlane = null;
    if (EMBEDDED) {
      const i = Number(document.querySelector('input[name="plane"]:checked')?.value);
      tcPlane = planes[i];
      if (!tcPlane) throw new Error("Crie um plano de corte com a tesoura e clique em Atualizar planos.");
    }
    const manualPlane = {
      point: ["px", "py", "pz"].map(id => Number($(id).value) / 1000),
      normal: ["nx", "ny", "nz"].map(id => Number($(id).value)),
    };
    const initialPlane = EMBEDDED ? planeToIfc(tcPlane, null) : manualPlane;
    makeSectionPlane(initialPlane.point, initialPlane.normal);
    const checked = [...document.querySelectorAll('#models input[type="checkbox"]:checked')].map(c => models[Number(c.value)]);
    const jobs = file
      ? [{ label: file.name, modelId: checked[0]?.id, getBuffer: async () => {
          assertIfcSize(file.size);
          return { buffer: await file.arrayBuffer(), source: "local" };
        } }]
      : checked.map(m => ({ label: m.name, modelId: m.id, getBuffer: () => source.get(m, project?.id, { signal }) }));
    if (!jobs.length) throw new Error(EMBEDDED ? "Marque ao menos um modelo IFC." : "Escolha um arquivo .ifc.");

    // Resolva a seleção antes de baixar: modelos sem objetos selecionados são dispensados.
    if (EMBEDDED && opts.onlySelected) {
      stage = "seleção de objetos";
      const selection = await withAbort(API.viewer.getSelection(), signal);
      for (let i = jobs.length - 1; i >= 0; i--) {
        const job = jobs[i];
        const entry = selection?.find(item => item.modelId === job.modelId);
        if (!entry?.objectRuntimeIds?.length) { jobs.splice(i, 1); continue; }
        currentFile = job.label;
        try {
          const ids = await withAbort(API.viewer.convertToObjectIds(job.modelId, entry.objectRuntimeIds), signal);
          job.filterGuids = new Set((ids || []).map(canonGuid).filter(Boolean));
          if (!job.filterGuids.size) throw new Error("Não consegui identificar os objetos selecionados neste modelo.");
        } catch (error) {
          if (signal.aborted) throw error;
          job.selectionError = error;
        }
      }
      if (!jobs.length) throw new Error("Nenhum objeto selecionado nos modelos IFC marcados.");
    }
    log("Lote", { arquivos: jobs.length });
    const layers = new Map();
    const skipped = [];
    let completed = 0;
    let total = 0, sectionTotal = 0, viewTotal = 0, unverified = false;
    for (const [index, job] of jobs.entries()) {
      signal.throwIfAborted();
      currentFile = job.label;
      stage = job.selectionError ? "seleção de objetos" : "obtenção do IFC";
      let result;
      try {
        if (job.selectionError) throw job.selectionError;
        progress(`[${index + 1}/${jobs.length}] Obtendo ${job.label}…`);
        let { buffer, source: origin } = await withAbort(job.getBuffer(), signal);
        signal.throwIfAborted();
        log("Origem do IFC", { arquivo: job.label, origem: origin, MB: +(buffer.byteLength / 1e6).toFixed(1) });
        stage = "leitura do IFC";
        progress(`[${index + 1}/${jobs.length}] Lendo ${job.label} (${(buffer.byteLength / 1e6).toFixed(1)} MB)…`);
        run.session = createIfcSession();
        await run.session.open(buffer);
        buffer = null; // o ArrayBuffer foi transferido para o worker
        stage = "alinhamento";
        let planeIfc = manualPlane;
        if (EMBEDDED) {
          let calib = null;
          if (job.modelId) {
            try {
              calib = await withAbort(calibrate(job.modelId, run.session, signal), signal);
              log("Alinhamento", { escala: calib.s, rotacaoGraus: +calib.thetaDeg.toFixed(3),
                erroMedio_m: +calib.residual.toFixed(3), objetosUsados: `${calib.n}/${calib.total}` });
            } catch (err) {
              if (signal.aborted || err.readerFailure) throw err;
              unverified = true;
              log("Sem alinhamento automático, usando coordenadas do IFC", String(err));
            }
            if (calib && calib.residual > MAX_ALIGN_ERROR_M) {
              throw new Error(`Alinhamento não confiável (erro médio de ${(calib.residual * 100).toFixed(0)} cm). Confira as coordenadas no Log.`);
            }
          }
          planeIfc = planeToIfc(tcPlane, calib);
        }
        signal.throwIfAborted();
        stage = "corte e projeção";
        progress(`[${index + 1}/${jobs.length}] Gerando corte de ${job.label}…`);
        const plane = makeSectionPlane(planeIfc.point, planeIfc.normal, { mirror: opts.mirror });
        result = await run.session.cut(plane, { ...opts, scale, filterGuids: job.filterGuids || null });
      } catch (err) {
        if (signal.aborted) throw err;
        const reason = /aborted|memory|out of bounds|unreachable|WebAssembly/i.test(err?.message || "")
          ? "IFC muito pesado ou incompatível com o leitor." : (err?.message || String(err));
        skipped.push(job.label);
        const item = document.createElement("li");
        item.textContent = `${job.label} — ${reason}`;
        $("skipped-files").append(item);
        $("warnings").hidden = false;
        // Arquivo acima do limite do navegador: leva direto ao processamento local.
        if (err?.code === "IFC_TOO_LARGE" || reason === "IFC muito pesado ou incompatível com o leitor.") {
          $("local-hint").hidden = false;
          $("local-processing").open = true;
        } else $("log-box").open = true;
        log("IFC ignorado", { arquivo: job.label, etapa: stage, motivo: reason,
          mensagem: err?.message || String(err), elemento: err.ifcContext, stack: err.stack });
        continue;
      } finally {
        run.session?.close();
        run.session = null;
      }
      // Só incorpora um modelo depois que todo o trabalho do leitor terminou.
      stage = "agregação do desenho";
      for (const [name, lines] of result.layers) {
        if (!layers.has(name)) layers.set(name, []);
        const target = layers.get(name);
        for (const line of lines) target.push(line);
        log(`Camada ${name}: ${lines.length} linhas`);
      }
      total += result.elementCount;
      sectionTotal += result.sectionElementCount;
      viewTotal += result.viewElementCount;
      completed++;
    }
    currentFile = "";
    stage = "gravação do DXF";
    if (!completed) throw new Error("Nenhum IFC pôde ser processado. Confira os arquivos ignorados abaixo.");
    if (!total && !layers.has("EIXOS")) {
      throw new Error(opts.depth > 0
        ? "Nenhum contorno encontrado nessa profundidade. Aumente a distância ou inverta o sentido da profundidade."
        : "O plano não cortou nenhum elemento. Confira a posição da tesoura.");
    }
    progress("Montando DXF…");
    await nextFrame();
    signal.throwIfAborted();
    const layerCount = layers.size;
    const dxf = buildDxfBlob(layers, { units: opts.units });
    layers.clear();
    const name = `corte_${skipped.length ? 'parcial_' : ''}${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.dxf`;
    offerDownload(dxf, name);
    progress(`Pronto: ${completed} arquivo(s), ${total} elemento(s), ${sectionTotal} no plano, ${viewTotal} em vista, ${layerCount} camada(s).` +
      (skipped.length ? ` DXF parcial: ${skipped.length} IFC(s) ignorado(s), listados abaixo.` : "") +
      (unverified ? " Atenção: alinhamento não verificado, confira as coordenadas no CAD." : ""));
  } catch (err) {
    if (signal.aborted) { progress("Geração cancelada."); return; }
    const detail = err?.message || String(err);
    log("Detalhes da falha", { arquivo: currentFile, etapa: stage, mensagem: detail,
      elemento: err.ifcContext, stack: err.stack });
    const explanation = /aborted|memory|out of bounds|unreachable/i.test(detail)
      ? "O leitor IFC foi interrompido. Pode ser limite de memória ou uma geometria incompatível. Tente este arquivo isoladamente."
      : detail;
    const element = err.ifcContext
      ? ` Elemento #${err.ifcContext.expressID}${err.ifcContext.type ? ' (' + err.ifcContext.type + ')' : ''}.` : "";
    throw new Error(`${currentFile ? 'Arquivo “' + currentFile + '” — ' : ''}${stage}: ${explanation}${element} Use “Baixar Log” para obter os detalhes completos.`);
  } finally {
    run.session?.close();
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    $("btn-cancel").hidden = true;
    generation = null;
    if (run.refreshPending) refresh();
  }
}

function offerDownload(text, name) {
  downloadUrl = URL.createObjectURL(text);
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = name;
  a.textContent = `Baixar ${name}`;
  a.className = "download";
  $("download").innerHTML = "";
  $("download").append(a);
  a.click();
}

function onError(err) {
  progress("Erro: " + (err?.message || err));
  $("log-box").open = true;
  console.error(err);
}

init();
