// Exporta somente configuração e referências; nunca inclui IFC, URLs ou tokens.
import { makeSectionPlane } from "./section.js";
import { canonGuid } from "./guid.js";

const REFERENCE_LIMIT = 40;
const TIMEOUT_MS = 15000;
const string = value => value == null ? "" : String(value);
const vector = value => {
  const result = Array.isArray(value) ? [...value] : [value?.x, value?.y, value?.z];
  return result.length === 3 && result.every(Number.isFinite) ? result : null;
};
const box = value => {
  const min = vector(value?.min), max = vector(value?.max);
  return min && max && min.every((v, i) => v <= max[i]) ? { min, max } : null;
};

function query(operation, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => finish(reject, signal.reason || new DOMException("Cancelado", "AbortError"));
    const timer = setTimeout(() => finish(reject, new Error("Tempo de consulta excedido.")), TIMEOUT_MS);
    function finish(callback, value) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    }
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); })
      .then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function placementOf(value) {
  if (!value) return undefined;
  const result = {};
  for (const key of ["position", "axis", "refDirection"]) {
    const v = vector(value[key]);
    if (v) result[key] = v;
  }
  if (Number.isFinite(value.scale) && value.scale > 0) result.scale = value.scale;
  return Object.keys(result).length ? result : undefined;
}

/** Plane uses Workspace SectionPlane millimetres. Drawing vectors are project metres.
 * Reference boxes retain raw Workspace API units; helper must infer/validate units.
 * placement is metadata only and must not be accepted as a verified IFC transform.
 */
export async function buildTrimbleJob({ project, plane, options = {}, models, api, signal }) {
  const point = plane?.point || [plane?.positionX, plane?.positionY, plane?.positionZ];
  const normal = plane?.normal || [plane?.directionX, plane?.directionY, plane?.directionZ];
  const basis = makeSectionPlane(point.map(v => v / 1000), normal, { mirror: !!options.mirror });
  const depth = Number(options.depth ?? 0);
  if (!Number.isFinite(depth) || depth < 0) throw new Error("Profundidade inválida.");
  const direction = options.direction ?? -1;
  if (![1, -1].includes(direction)) throw new Error("Sentido da profundidade inválido.");
  const units = options.units ?? "mm";
  if (!["m", "mm"].includes(units)) throw new Error("Unidade DXF inválida.");
  if (!models?.length || models.some(m => !m?.id)) throw new Error("Escolha ao menos um modelo identificado.");
  const viewer = api?.viewer || api;
  if (!viewer) throw new Error("API do visualizador indisponível.");
  const warnings = [];
  let selection;
  if (options.onlySelected) selection = await query(() => viewer.getSelection(), signal);
  const output = [];
  for (const model of models) {
    signal?.throwIfAborted();
    const item = {
      id: string(model.id), name: string(model.name), versionId: string(model.versionId),
      referenceBoxUnits: "viewer-api", referenceObjects: [],
    };
    const placement = placementOf(model.placement);
    if (placement) item.placement = placement;
    if (!item.versionId) warnings.push({ modelId: item.id, code: "MISSING_REVISION", message: "Revisão desconhecida: confirme a versão do IFC local." });
    if (options.onlySelected) {
      const ids = selection?.find(entry => entry.modelId === model.id)?.objectRuntimeIds || [];
      if (!ids.length) continue;
      // Selection failure is fatal: never silently export all objects instead.
      const guids = await query(() => viewer.convertToObjectIds(model.id, ids), signal);
      if (guids?.length !== ids.length || guids.some(g => !g || !canonGuid(g))) throw new Error(`Seleção não identificada no modelo ${item.name}.`);
      item.selectedGuids = [...new Set(guids.map(canonGuid))];
    }
    try {
      const groups = await query(() => viewer.getObjects({ modelObjectIds: [{ modelId: model.id }] }), signal);
      const objects = groups?.find(group => group.modelId === model.id)?.objects || [];
      const ids = [...new Set(objects.map(object => object.id).filter(Number.isInteger))];
      // Distribui as amostras pela lista, em vez de concentrar nos primeiros objetos.
      const sampled = ids.length <= REFERENCE_LIMIT ? ids : Array.from({ length: REFERENCE_LIMIT }, (_, i) => ids[Math.floor(i * (ids.length - 1) / (REFERENCE_LIMIT - 1))]);
      if (sampled.length) {
        const guids = await query(() => viewer.convertToObjectIds(model.id, sampled), signal);
        const boxes = await query(() => viewer.getObjectBoundingBoxes(model.id, sampled), signal);
        const byId = new Map((boxes || []).map(value => [value.id, box(value.boundingBox)]));
        for (let i = 0; i < sampled.length; i++) {
          const boundingBox = byId.get(sampled[i]), guid = guids?.[i];
          if (boundingBox && guid && canonGuid(guid)) item.referenceObjects.push({ guid: canonGuid(guid), boundingBox });
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push({ modelId: item.id, code: "REFERENCE_QUERY_FAILED", message: "Não foi possível consultar as referências de alinhamento deste modelo." });
    }
    if (item.referenceObjects.length < 3) warnings.push({ modelId: item.id, code: "INSUFFICIENT_REFERENCES", message: "Menos de três referências: o auxiliar deve exigir alinhamento confirmado antes de gerar o desenho." });
    output.push(item);
  }
  signal?.throwIfAborted();
  if (!output.length) throw new Error("Nenhum objeto selecionado nos modelos marcados.");
  return {
    schema: "corte-dxf-job", version: 1,
    project: { id: string(project?.id), name: string(project?.name), region: string(project?.region) },
    drawing: { ...basis, depth, direction, units, mirror: !!options.mirror, grid: !!options.grid, hatching: !!options.hatching },
    alignmentPolicy: "require-verified", models: output, warnings,
  };
}
