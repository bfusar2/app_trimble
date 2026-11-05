// Leitura de IFC no navegador com web-ifc (WASM) e corte da geometria por plano.
// Coordenadas devolvidas pelo web-ifc: metros, eixo Y para cima.
// Aqui tudo é convertido para o padrão IFC/Trimble: metros, eixo Z para cima.

const V = new URL(import.meta.url).search;
const [{ sliceMesh, chainSegments }, { canonGuid }, { projectMeshDepth }, { hatch, gridLines }] = await Promise.all([
  import(`./section.js${V}`), import(`./guid.js${V}`), import(`./depth.js${V}`), import(`./drawing.js${V}`),
]);

const WEB_IFC_VERSION = "0.0.66";
const WEB_IFC_URL = `https://cdn.jsdelivr.net/npm/web-ifc@${WEB_IFC_VERSION}/`;

// Elementos que não devem aparecer no corte
const SKIP_TYPES = new Set(["IFCSPACE", "IFCOPENINGELEMENT", "IFCOPENINGSTANDARDCASE", "IFCANNOTATION", "IFCVIRTUALELEMENT"]);

/** Abre um IFC (ArrayBuffer). Retorna um "modelo" para usar nas outras funções. */
export async function openIfc(buffer) {
  // Cada modelo tem seu próprio heap WASM. Dispose libera também a memória
  // reservada pelo leitor, que CloseModel sozinho mantém para o próximo arquivo.
  const WebIFC = await import(`${WEB_IFC_URL}web-ifc-api.js`);
  const api = new WebIFC.IfcAPI();
  let modelID;
  try {
    api.SetWasmPath(WEB_IFC_URL, true);
    await api.Init(undefined, true);
    modelID = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: false });
    if (!Number.isInteger(modelID) || modelID < 0) throw new Error("O leitor não conseguiu abrir este IFC.");
    // Alguns arquivos inválidos recebem um modelID válido, mas nenhum projeto.
    const projects = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName("IFCPROJECT"));
    try {
      if (!projects.size()) throw new Error("IFC inválido ou ilegível: nenhum IfcProject encontrado.");
    } finally {
      projects.delete?.();
    }
  } catch (err) {
    dispose();
    throw err;
  }
  const typeNames = new Map();
  let closed = false;
  let products;

  // A instância pode estar abortada; a limpeza não deve esconder o erro original.
  function dispose() {
    try { api.Dispose(); } catch {}
  }

  const typeOf = (expressID) => {
    const code = api.GetLineType(modelID, expressID);
    if (!typeNames.has(code)) {
      const name = api.GetNameFromTypeCode(code) || String(code);
      typeNames.set(code, name.toUpperCase());
    }
    return typeNames.get(code);
  };

  return {
    api,
    modelID,
    typeOf,
    guidOf: (expressID) => api.GetLine(modelID, expressID)?.GlobalId?.value,
    productIds: () => {
      if (!products) {
        const ids = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName("IFCPRODUCT"), true);
        try {
          products = Array.from({ length: ids.size() }, (_, i) => ids.get(i));
        } finally {
          ids.delete?.();
        }
      }
      return products;
    },
    close: () => {
      if (closed) return;
      closed = true;
      try { api.CloseModel(modelID); } catch {}
      dispose();
    },
  };
}

/** Percorre todas as malhas do modelo já em coordenadas do mundo (m, Z para cima). */
function forEachMesh(model, fn, expressIDs = null) {
  const { api, modelID } = model;
  const callback = (mesh) => {
    const type = model.typeOf(mesh.expressID);
    if (SKIP_TYPES.has(type)) return;
    const pgs = mesh.geometries;
    for (let i = 0; i < pgs.size(); i++) {
      const pg = pgs.get(i);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      try {
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const index = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        const positions = toWorld(verts, pg.flatTransformation);
        fn({ expressID: mesh.expressID, type, positions, index });
      } finally {
        geom.delete?.();
      }
    }
  };
  if (expressIDs) {
    if (expressIDs.length) api.StreamMeshes(modelID, expressIDs, callback);
  } else api.StreamAllMeshes(modelID, callback);
}

// verts: [x,y,z,nx,ny,nz,...] locais; m: matriz 4x4 column-major (saída Y-up).
// Resultado: Float64Array [x,y,z,...] em metros, Z para cima.
function toWorld(verts, m) {
  const n = verts.length / 6;
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = verts[6 * i], y = verts[6 * i + 1], z = verts[6 * i + 2];
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    // Y-up (web-ifc) -> Z-up (IFC):  (x, y, z) -> (x, -z, y)
    out[3 * i] = wx;
    out[3 * i + 1] = -wz;
    out[3 * i + 2] = wy;
  }
  return out;
}

/**
 * Caixas envolventes (m, Z para cima) de até `limit` elementos, com o GUID IFC.
 * Usado para alinhar o IFC com as coordenadas do Visualizador 3D.
 */
export function sampleBoxes(model, limit = 40) {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const boxes = new Map(); // expressID -> {min,max}
  const candidates = model.productIds();
  const guids = new Map();
  // Não triangula candidatos sem representação própria para obter amostras.
  // Cada chamada recebe um único ID: uma falha WASM identifica a peça exata.
  for (const id of candidates) {
    if (boxes.size >= limit) break;
    const context = { expressID: id, type: null, guid: null };
    try {
      const code = model.api.GetLineType(model.modelID, id);
      context.type = model.typeOf(id);
      if (!model.api.IsIfcElement(code) || SKIP_TYPES.has(context.type)) continue;
      const line = model.api.GetLine(model.modelID, id);
      context.guid = line?.GlobalId?.value || null;
      if (!context.guid || !line?.Representation?.value) continue;
      guids.set(id, context.guid);
      forEachMesh(model, ({ expressID, positions }) => {
        if (!positions.length) return;
        if (!boxes.has(expressID)) {
          boxes.set(expressID, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
        }
        const b = boxes.get(expressID);
        for (let i = 0; i < positions.length; i += 3)
          for (let a = 0; a < 3; a++) {
            const v = positions[i + a];
            if (v < b.min[a]) b.min[a] = v;
            if (v > b.max[a]) b.max[a] = v;
          }
      }, [id]);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      error.ifcContext = context;
      throw error;
    }
  }
  return [...boxes].map(([expressID, b]) => ({ guid: guids.get(expressID), ...b }));
}

/**
 * Corta o modelo pelo plano (já no espaço do IFC: metros, Z para cima).
 * Retorna segmentos do plano e da vista em profundidade, separados por tipo IFC.
 * depth em metros; direction = -1 ou 1 indica o lado da normal do plano.
 * filterGuids: Set opcional de GUIDs na forma canônica (canonGuid) — corta só esses elementos.
 */
export function cutModel(model, plane, { scale = 1000, filterGuids = null, depth = 0, direction = -1, grid = false, hatching = false } = {}) {
  if (!Number.isFinite(depth) || depth < 0) throw new Error("Informe uma profundidade válida, maior ou igual a zero.");
  if (direction !== -1 && direction !== 1) throw new Error("Sentido da profundidade inválido.");
  const result = new Map();
  const views = new Map(), pieces = new Map();
  const elements = new Set(), sectionElements = new Set(), viewElements = new Set();
  const selected = filterGuids ? model.productIds().filter(id => filterGuids.has(canonGuid(model.guidOf(id)))) : null;
  forEachMesh(model, ({ expressID, type, positions, index }) => {
    // Rejeita a malha fora da faixa antes de soldar vértices e criar as
    // estruturas de arestas da projeção, que são a parte mais custosa da vista.
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const distance = (positions[i] - plane.point[0]) * plane.normal[0] +
        (positions[i + 1] - plane.point[1]) * plane.normal[1] +
        (positions[i + 2] - plane.point[2]) * plane.normal[2];
      if (!Number.isFinite(distance)) throw new Error("Malha do IFC contém coordenadas inválidas.");
      min = Math.min(min, distance);
      max = Math.max(max, distance);
    }
    const crossesSection = min <= 0 && max >= 0;
    const near = direction === 1 ? min : -max;
    const far = direction === 1 ? max : -min;
    const inView = depth > 0 && near <= depth + 1e-7 && far >= -1e-7;
    if (!crossesSection && !inView) return;
    if (!result.has(type)) result.set(type, []);
    const start = result.get(type).length;
    if (crossesSection && sliceMesh(positions, index, plane, scale, result.get(type)) > 0) {
      elements.add(expressID);
      sectionElements.add(expressID);
      if (hatching) {
        if (!pieces.has(expressID)) pieces.set(expressID, []);
        for (let i=start; i<result.get(type).length; i++) pieces.get(expressID).push(result.get(type)[i]);
      }
    }
    if (inView) {
      if (!views.has(type)) views.set(type, []);
      if (projectMeshDepth(positions, index, plane, { depth, direction, scale }, views.get(type)) > 0) {
        elements.add(expressID);
        viewElements.add(expressID);
      }
    }
  }, selected);
  for (const [k, v] of result) if (!v.length) result.delete(k);
  for (const [k, v] of views) if (!v.length) views.delete(k);
  return {
    gridLines: grid ? gridLines(model, plane, scale, filterGuids && (id => filterGuids.has(canonGuid(model.guidOf(id))))) : [],
    hatchLines: [...pieces.values()].flatMap(segs => hatch(chainSegments(segs, .0005*scale), .1*scale)),
    segmentsByType: result, viewSegmentsByType: views, elementCount: elements.size,
    sectionElementCount: sectionElements.size, viewElementCount: viewElements.size,
  };
}
