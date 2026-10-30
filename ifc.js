// Leitura de IFC no navegador com web-ifc (WASM) e corte da geometria por plano.
// Coordenadas devolvidas pelo web-ifc: metros, eixo Y para cima.
// Aqui tudo é convertido para o padrão IFC/Trimble: metros, eixo Z para cima.

import { sliceMesh } from "./section.js";

const WEB_IFC_VERSION = "0.0.66";
const WEB_IFC_URL = `https://cdn.jsdelivr.net/npm/web-ifc@${WEB_IFC_VERSION}/`;

// Elementos que não devem aparecer no corte
const SKIP_TYPES = new Set(["IFCSPACE", "IFCOPENINGELEMENT", "IFCANNOTATION", "IFCVIRTUALELEMENT"]);

let apiPromise = null;

async function getApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const WebIFC = await import(`${WEB_IFC_URL}web-ifc-api.js`);
      const api = new WebIFC.IfcAPI();
      api.SetWasmPath(WEB_IFC_URL, true);
      await api.Init(undefined, true); // força single-thread (não exige cross-origin isolation)
      return api;
    })();
  }
  return apiPromise;
}

/** Abre um IFC (ArrayBuffer). Retorna um "modelo" para usar nas outras funções. */
export async function openIfc(buffer) {
  const api = await getApi();
  const modelID = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: false });
  const typeNames = new Map();

  const typeOf = (expressID) => {
    const code = api.GetLineType(modelID, expressID);
    if (!typeNames.has(code)) {
      let name = String(code);
      try {
        name = api.GetNameFromTypeCode(code) || name;
      } catch {}
      typeNames.set(code, name.toUpperCase());
    }
    return typeNames.get(code);
  };

  return {
    api,
    modelID,
    typeOf,
    guidOf: (expressID) => {
      try {
        return api.GetLine(modelID, expressID)?.GlobalId?.value;
      } catch {
        return undefined;
      }
    },
    close: () => api.CloseModel(modelID),
  };
}

/** Percorre todas as malhas do modelo já em coordenadas do mundo (m, Z para cima). */
function forEachMesh(model, fn) {
  const { api, modelID } = model;
  api.StreamAllMeshes(modelID, (mesh) => {
    const type = model.typeOf(mesh.expressID);
    if (SKIP_TYPES.has(type)) return;
    const pgs = mesh.geometries;
    for (let i = 0; i < pgs.size(); i++) {
      const pg = pgs.get(i);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const index = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const positions = toWorld(verts, pg.flatTransformation);
      fn({ expressID: mesh.expressID, type, positions, index });
      if (typeof geom.delete === "function") geom.delete();
    }
  });
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
  const boxes = new Map(); // expressID -> {min,max}
  forEachMesh(model, ({ expressID, positions }) => {
    if (!boxes.has(expressID)) {
      if (boxes.size >= limit) return;
      boxes.set(expressID, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    }
    const b = boxes.get(expressID);
    for (let i = 0; i < positions.length; i += 3)
      for (let a = 0; a < 3; a++) {
        const v = positions[i + a];
        if (v < b.min[a]) b.min[a] = v;
        if (v > b.max[a]) b.max[a] = v;
      }
  });
  return [...boxes].map(([expressID, b]) => ({ guid: model.guidOf(expressID), ...b })).filter((b) => b.guid);
}

/**
 * Corta o modelo pelo plano (já no espaço do IFC: metros, Z para cima).
 * Retorna Map<tipoIfc, segmentos 2D [u1,v1,u2,v2,...]> em (metros × scale).
 * filterGuids: Set opcional — corta só esses elementos.
 */
export function cutModel(model, plane, { scale = 1000, filterGuids = null } = {}) {
  const result = new Map();
  let elements = new Set();
  forEachMesh(model, ({ expressID, type, positions, index }) => {
    if (filterGuids && !filterGuids.has(model.guidOf(expressID))) return;
    if (!result.has(type)) result.set(type, []);
    if (sliceMesh(positions, index, plane, scale, result.get(type)) > 0) elements.add(expressID);
  });
  for (const [k, v] of result) if (!v.length) result.delete(k);
  return { segmentsByType: result, elementCount: elements.size };
}
