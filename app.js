// Extensão "Corte DXF" para o Visualizador 3D do Trimble Connect for Browser.
// Fluxo: lê o plano da tesoura -> baixa o IFC do modelo -> alinha coordenadas
//        -> corta a geometria -> monta polilinhas -> baixa o .dxf.
// Aberto fora do Trimble Connect, funciona em "modo local": IFC do computador + plano manual.

import { openIfc, sampleBoxes, cutModel } from "./ifc.js";
import { makeSectionPlane, chainSegments } from "./section.js";
import { buildDxf } from "./dxf.js";

const $ = (id) => document.getElementById(id);
const EMBEDDED = window.parent !== window;

let API = null;
let accessToken = null;
let tokenWaiters = [];
let project = null;
let planes = [];
let models = [];

// ---------------- utilidades ----------------

function log(msg, data) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}` + (data !== undefined ? " " + JSON.stringify(data) : "");
  $("log").textContent = line + "\n" + $("log").textContent;
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
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const vec = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);

// ---------------- conexão ----------------

async function init() {
  $("btn-refresh").onclick = refresh;
  $("btn-generate").onclick = () => generate().catch(onError);
  $("file").onchange = renderModels;

  if (!EMBEDDED) {
    setStatus("Modo local", "warn");
    $("manual-plane").hidden = false;
    $("btn-refresh").hidden = true;
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
  try {
    planes = (await API.viewer.getSectionPlanes()) || [];
  } catch (err) {
    planes = [];
    log("Erro em getSectionPlanes", String(err));
  }
  try {
    models = (await API.viewer.getModels("loaded")) || [];
  } catch (err) {
    models = [];
    log("Erro em getModels", String(err));
  }
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
    label.append(m.name || m.id);
    if (!isIfc) label.title = "Só IFC é suportado. Exporte o modelo como IFC e envie ao projeto.";
    box.append(label);
  });
}

// ---------------- token e download ----------------

function onToken(value) {
  if (!value || value === "pending") return;
  if (value === "denied") {
    tokenWaiters.forEach((w) => w.reject(new Error("Permissão de token negada.")));
  } else {
    accessToken = value;
    tokenWaiters.forEach((w) => w.resolve(value));
  }
  tokenWaiters = [];
}

async function getToken() {
  if (accessToken) return accessToken;
  const r = await API.extension.requestPermission("accesstoken");
  if (r && r !== "pending" && r !== "denied") return (accessToken = r);
  if (r === "denied") throw new Error("Permissão de token negada.");
  progress("Autorize o acesso na janela do Trimble Connect…");
  return new Promise((resolve, reject) => {
    tokenWaiters.push({ resolve, reject });
    setTimeout(() => reject(new Error("Tempo esgotado esperando autorização.")), 120000);
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

async function downloadModel(model) {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };
  const base = apiBase();
  const v = model.versionId ? `?versionId=${encodeURIComponent(model.versionId)}` : "";
  const candidates = [`${base}files/fs/${model.id}/downloadurl${v}`, `${base}files/${model.id}/downloadurl${v}`];

  let url = null;
  for (const c of candidates) {
    try {
      const res = await fetch(c, { headers });
      if (!res.ok) {
        log(`downloadurl ${res.status}`, c);
        continue;
      }
      const body = await res.json();
      url = body.url || body.downloadUrl;
      if (url) break;
    } catch (err) {
      log("Erro em downloadurl", String(err));
    }
  }
  if (!url) throw new Error("Não consegui o link de download do modelo. Use 'Carregar IFC do computador'.");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha no download do IFC (${res.status}). Use 'Carregar IFC do computador'.`);
  return res.arrayBuffer();
}

// ---------------- alinhamento IFC <-> visualizador ----------------

/**
 * Compara caixas envolventes dos mesmos objetos no IFC (m) e no visualizador
 * para descobrir escala e deslocamento: viewer = s * ifc + t.
 */
async function calibrate(modelId, ifcModel) {
  const samples = sampleBoxes(ifcModel, 40);
  if (!samples.length) throw new Error("sem amostras");

  const runtimeIds = await API.viewer.convertToObjectRuntimeIds(modelId, samples.map((s) => s.guid));
  const byRuntime = new Map();
  runtimeIds.forEach((rid, i) => rid != null && byRuntime.set(rid, samples[i]));
  if (!byRuntime.size) throw new Error("GUIDs do IFC não encontrados no visualizador");

  const vboxes = await API.viewer.getObjectBoundingBoxes(modelId, [...byRuntime.keys()]);
  const pairs = [];
  for (const vb of vboxes || []) {
    const s = byRuntime.get(vb.id);
    const box = vb.boundingBox;
    if (!s || !box?.min || !box?.max) continue;
    pairs.push({ ifc: s, vmin: vec(box.min), vmax: vec(box.max) });
  }
  if (!pairs.length) throw new Error("caixas do visualizador indisponíveis");

  const diag = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  let s = median(pairs.map((p) => diag(p.vmin, p.vmax) / (diag(p.ifc.min, p.ifc.max) || 1)));
  const pow = Math.pow(10, Math.round(Math.log10(s)));
  if (Math.abs(s / pow - 1) < 0.02) s = pow; // encaixa em 1, 1000, 0.001…

  const center = (a, b, k) => (a[k] + b[k]) / 2;
  const t = [0, 1, 2].map((k) => median(pairs.map((p) => center(p.vmin, p.vmax, k) - s * center(p.ifc.min, p.ifc.max, k))));
  const residual = median(pairs.map((p) => Math.abs(p.vmin[0] - (s * p.ifc.min[0] + t[0])) / s)); // em metros

  return { s, t, n: pairs.length, residual };
}

/** Converte o plano da tesoura (mm, coordenadas do visualizador) para o espaço do IFC (m). */
function planeToIfc(plane, calib) {
  const pmm = [plane.positionX, plane.positionY, plane.positionZ];
  const normal = [plane.directionX, plane.directionY, plane.directionZ];
  if (!calib) return { point: pmm.map((x) => x / 1000), normal };
  const pb = pmm.map((x) => x * (calib.s / 1000)); // mm -> unidade das caixas do visualizador
  return { point: pb.map((x, k) => (x - calib.t[k]) / calib.s), normal };
}

async function selectedGuids(modelId) {
  const sel = (await API.viewer.getSelection()) || [];
  const entry = sel.find((s) => s.modelId === modelId);
  if (!entry?.objectRuntimeIds?.length) return new Set();
  return new Set(await API.viewer.convertToObjectIds(modelId, entry.objectRuntimeIds));
}

// ---------------- gerar ----------------

async function generate() {
  $("btn-generate").disabled = true;
  $("download").innerHTML = "";
  try {
    const opts = {
      onlySelected: $("opt-selected").checked,
      mirror: $("opt-mirror").checked,
      units: $("opt-units").value,
    };
    const scale = opts.units === "m" ? 1 : 1000;
    const file = $("file").files?.[0];

    // Plano escolhido
    let tcPlane = null;
    if (EMBEDDED) {
      const i = Number(document.querySelector('input[name="plane"]:checked')?.value);
      tcPlane = planes[i];
      if (!tcPlane) throw new Error("Crie um plano de corte com a tesoura e clique em Atualizar planos.");
    }

    // Lista de trabalhos: { label, getBuffer, modelId }
    const checked = [...document.querySelectorAll('#models input[type="checkbox"]:checked')].map((c) => models[Number(c.value)]);
    const jobs = [];
    if (file) jobs.push({ label: file.name, getBuffer: () => file.arrayBuffer(), modelId: checked[0]?.id });
    else for (const m of checked) jobs.push({ label: m.name, getBuffer: () => downloadModel(m), modelId: m.id });
    if (!jobs.length) throw new Error(EMBEDDED ? "Marque ao menos um modelo IFC." : "Escolha um arquivo .ifc.");

    const layers = new Map();
    let total = 0;

    for (const job of jobs) {
      progress(`Baixando ${job.label}…`);
      await nextFrame();
      const buffer = await job.getBuffer();

      progress(`Lendo ${job.label} (${(buffer.byteLength / 1e6).toFixed(1)} MB)…`);
      await nextFrame();
      const model = await openIfc(buffer);

      try {
        let planeIfc;
        if (EMBEDDED) {
          let calib = null;
          if (job.modelId) {
            try {
              calib = await calibrate(job.modelId, model);
              log("Alinhamento", calib);
              if (calib.residual > 0.05) log("Atenção: alinhamento impreciso (modelo girado/deslocado?)");
            } catch (err) {
              log("Sem alinhamento automático, usando coordenadas do IFC", String(err));
            }
          }
          planeIfc = planeToIfc(tcPlane, calib);
        } else {
          planeIfc = {
            point: ["px", "py", "pz"].map((id) => Number($(id).value) / 1000),
            normal: ["nx", "ny", "nz"].map((id) => Number($(id).value)),
          };
        }

        const filterGuids = EMBEDDED && opts.onlySelected && job.modelId ? await selectedGuids(job.modelId) : null;
        if (filterGuids && !filterGuids.size) throw new Error("Nenhum objeto selecionado neste modelo.");

        progress(`Cortando ${job.label}…`);
        await nextFrame();
        const plane = makeSectionPlane(planeIfc.point, planeIfc.normal, { mirror: opts.mirror });
        const { segmentsByType, elementCount } = cutModel(model, plane, { scale, filterGuids });
        total += elementCount;

        for (const [type, segs] of segmentsByType) {
          const lines = chainSegments(segs, scale === 1000 ? 0.5 : 0.0005);
          layers.set(type, (layers.get(type) || []).concat(lines));
        }
      } finally {
        model.close();
      }
    }

    if (!total) throw new Error("O plano não cortou nenhum elemento. Confira a posição da tesoura.");

    const dxf = buildDxf(layers, { units: opts.units });
    const name = `corte_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.dxf`;
    offerDownload(dxf, name);
    progress(`Pronto: ${total} elemento(s) cortado(s), ${layers.size} camada(s).`);
  } finally {
    $("btn-generate").disabled = false;
  }
}

function offerDownload(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/dxf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.textContent = `Baixar ${name}`;
  a.className = "download";
  $("download").innerHTML = "";
  $("download").append(a);
  a.click();
}

function onError(err) {
  progress("Erro: " + (err?.message || err));
  console.error(err);
}

init();
