import assert from "node:assert/strict";
import { buildTrimbleJob } from "../trimble-job.js";

const model = { id: "model", name: "Arquivo.ifc", versionId: "r1", accessToken: "SECRET", url: "SECRET", placement: { position: { x: 1, y: 2, z: 3 }, axis: [0, 0, 1], secret: "SECRET" } };
const request = { project: { id: "project", name: "Projeto", region: "northAmerica", token: "SECRET" },
  plane: { positionX: 1000, positionY: 2000, positionZ: 3000, directionX: 0, directionY: 0, directionZ: 2 },
  options: { depth: 5, direction: -1, units: "mm", mirror: true, grid: true, hatching: true }, models: [model] };
let boxCalls = 0;
const api = {
  getObjects: async selector => {
    assert.deepEqual(selector, { modelObjectIds: [{ modelId: "model" }] });
    return [{ modelId: "other", objects: [{ id: -1 }] }, { modelId: "model", objects: Array.from({ length: 100 }, (_, id) => ({ id })) }];
  },
  convertToObjectIds: async (_, ids) => ids.map(id => `guid-${id}`),
  getObjectBoundingBoxes: async (_, ids) => {
    boxCalls++;
    assert.equal(ids.length, 40); assert.equal(ids[0], 0); assert.equal(ids.at(-1), 99);
    return ids.map(id => ({ id, boundingBox: { min: { x: id, y: 0, z: 0 }, max: { x: id + 1, y: 1, z: 1 } } }));
  },
};
const job = await buildTrimbleJob({ ...request, api: { viewer: api } });
assert.equal(job.schema, "corte-dxf-job"); assert.equal(job.version, 1);
assert.deepEqual(job.drawing.point, [1, 2, 3]); assert.deepEqual(job.drawing.normal, [0, 0, 1]);
assert.deepEqual(job.drawing.u, [-1, 0, 0]); assert.deepEqual(job.models[0].placement.position, [1, 2, 3]);
assert.equal(job.models[0].referenceObjects.length, 40); assert.equal(job.models[0].referenceBoxUnits, "viewer-api");
assert.equal(boxCalls, 1); assert.deepEqual(job.warnings, []); assert.equal(JSON.stringify(job).includes("SECRET"), false);
console.log("OK: plano, referências limitadas e distribuídas, metadados sem segredos");

const failed = await buildTrimbleJob({ ...request, api: { ...api, getObjects: async () => { throw Error("SECRET"); } } });
assert.deepEqual(failed.warnings.map(w => w.code), ["REFERENCE_QUERY_FAILED", "INSUFFICIENT_REFERENCES"]);
assert.equal(JSON.stringify(failed).includes("SECRET"), false);
console.log("OK: falha de referências gera avisos explícitos sem incluir detalhes privados");

const selected = await buildTrimbleJob({ ...request, options: { ...request.options, onlySelected: true }, models: [model, { id: "unused" }],
  api: { ...api, getSelection: async () => [{ modelId: "model", objectRuntimeIds: [7] }] } });
assert.equal(selected.models.length, 1); assert.deepEqual(selected.models[0].selectedGuids, ["guid-7"]);
await assert.rejects(buildTrimbleJob({ ...request, options: { onlySelected: true }, api: { ...api, getSelection: async () => [{ modelId: "model", objectRuntimeIds: [1] }], convertToObjectIds: async () => [] } }), /Seleção/);
console.log("OK: seleção preservada, modelos sem seleção excluídos, seleção inválida interrompe");

const controller = new AbortController();
const pending = buildTrimbleJob({ ...request, signal: controller.signal, api: { ...api, getObjects: () => new Promise(() => {}) } });
controller.abort(new DOMException("Cancelado", "AbortError"));
await assert.rejects(pending, { name: "AbortError" });
await assert.rejects(buildTrimbleJob({ ...request, api, options: { depth: -1 } }), /Profundidade/);
await assert.rejects(buildTrimbleJob({ ...request, api, plane: { ...request.plane, directionZ: 0 } }), /normal/);
console.log("OK: cancelamento e validação de plano/opções");
