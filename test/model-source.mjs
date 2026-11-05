import assert from "node:assert/strict";
import vm from "node:vm";
import { createModelSource } from "../model-source.js";

const ifc = label => new TextEncoder().encode(`ISO-10303-21;\nHEADER;\n${label}\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;`).buffer;
const model = (id = "a", versionId = "v1") => ({ id, versionId, name: id + ".ifc" });
let checks = 0;
async function test(name, fn) {
  await fn();
  checks++;
  console.log("OK", name);
}

await test("Usa IFC original do host e reutiliza bytes sem outro download", async () => {
  let hostCalls = 0;
  const sources = [];
  const source = createModelSource({
    getLoadedModel: async () => { hostCalls++; return { id: "a", versionId: "v1", blob: new Blob([ifc("host")]) }; },
    download: async () => { throw new Error("download inesperado"); },
    onStatus: status => sources.push(status),
  });
  const first = await source.get(model(), "project");
  const second = await source.get(model(), "project");
  assert.equal(first.source, "trimble");
  assert.equal(second.source, "cache");
  assert.equal(hostCalls, 1);
  assert.deepEqual(sources, ["trimble", "cache"]);
  new Uint8Array(first.buffer)[0] = 0;
  assert.equal(new Uint8Array(second.buffer)[0], 73);
});

await test("Aceita IFC base64 devolvido pelo host", async () => {
  const source = createModelSource({
    getLoadedModel: async () => ({ blob: Buffer.from(ifc("base64")).toString("base64") }),
    download: async () => { throw new Error("download inesperado"); },
  });
  assert.equal((await source.get(model(), "project")).source, "trimble");
});

for (const [name, loaded] of [
  ["sem blob", {}],
  ["TRB convertido", { blob: new Blob(["TrimBIM binary geometry"]) }],
  ["URL", { blob: "https://example.com/model.ifc" }],
  ["ZIP", { blob: new Blob([new Uint8Array([80,75,3,4])]) }],
  ["outro modelo", { id: "other", blob: new Blob([ifc("wrong")]) }],
  ["outra revisão", { versionId: "v0", blob: new Blob([ifc("wrong")]) }],
]) {
  await test("Fallback para download quando host retorna " + name, async () => {
    let downloads = 0;
    const source = createModelSource({
      getLoadedModel: async () => loaded,
      download: async () => { downloads++; return ifc("download"); },
    });
    assert.equal((await source.get(model(), "project")).source, "download");
    assert.equal(downloads, 1);
    assert.equal((await source.get(model(), "project")).source, "cache");
  });
}

await test("Falha da API do host permite baixar o original", async () => {
  const source = createModelSource({
    getLoadedModel: async () => { throw new Error("not supported"); },
    download: async () => ifc("download"),
  });
  assert.equal((await source.get(model(), "project")).source, "download");
});

await test("Cache distingue projetos e revisões", async () => {
  let downloads = 0;
  const source = createModelSource({ download: async () => { downloads++; return ifc("download"); } });
  await source.get(model(), "project1");
  await source.get(model(), "project2");
  await source.get(model("a", "v2"), "project1");
  assert.equal(downloads, 3);
});

await test("Sem revisão ou projeto os bytes não são mantidos em cache", async () => {
  let downloads = 0;
  const source = createModelSource({ download: async () => { downloads++; return ifc("download"); } });
  await source.get({ id: "a" }, "project"); await source.get({ id: "a" }, "project");
  await source.get(model(), undefined); await source.get(model(), undefined);
  assert.equal(downloads, 4);
});

await test("Limite de bytes remove o menos usado e rejeita arquivo grande", async () => {
  const buffer = ifc("download");
  let downloads = 0;
  const source = createModelSource({ maxBytes: buffer.byteLength * 2, download: async () => { downloads++; return buffer.slice(0); } });
  await source.get(model("a"), "project"); await source.get(model("b"), "project");
  assert.equal((await source.get(model("a"), "project")).source, "cache");
  await source.get(model("c"), "project");
  assert.equal((await source.get(model("b"), "project")).source, "download");
  assert.equal(downloads, 4);
  const small = createModelSource({ maxBytes: 1, download: async () => buffer.slice(0) });
  await small.get(model(), "project");
  assert.equal((await small.get(model(), "project")).source, "download");
});

await test("prune remove modelos e revisões que saíram da lista", async () => {
  const source = createModelSource({ download: async () => ifc("download") });
  await source.get(model("a"), "project"); await source.get(model("b"), "project");
  source.prune([model("a")], "project");
  assert.equal((await source.get(model("a"), "project")).source, "cache");
  assert.equal((await source.get(model("b"), "project")).source, "download");
  source.prune([model("a", "v2")], "project");
  assert.equal((await source.get(model("a"), "project")).source, "download");
  source.clear();
  assert.equal((await source.get(model("a"), "project")).source, "download");
});

await test("Download inválido não é cacheado e uma nova tentativa funciona", async () => {
  let calls = 0;
  const source = createModelSource({ download: async () => ++calls === 1 ? new TextEncoder().encode("<html>Forbidden</html>").buffer : ifc("valid") });
  await assert.rejects(source.get(model(), "project"), /não é um IFC STEP válido/);
  assert.equal((await source.get(model(), "project")).source, "download");
});

await test("Cache zero é permitido e limites inválidos são rejeitados", async () => {
  const source = createModelSource({ maxBytes: 0, download: async () => ifc("download") });
  await source.get(model(), "project");
  assert.equal((await source.get(model(), "project")).source, "download");
  assert.throws(() => createModelSource({ maxBytes: -1 }), /inválido/);
});

await test("Cancelar RPC do host interrompe a espera sem baixar ou preencher cache", async () => {
  let complete, downloads = 0, hostCalls = 0;
  const source = createModelSource({
    getLoadedModel: () => { hostCalls++; return new Promise(resolve => { complete = resolve; }); },
    download: async () => { downloads++; return ifc("download"); },
  });
  const controller = new AbortController();
  const pending = source.get(model(), "project", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  complete({ blob: new Blob([ifc("late")]) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(downloads, 0);
  const nextController = new AbortController();
  const next = source.get(model(), "project", { signal: nextController.signal });
  assert.equal(hostCalls, 2);
  nextController.abort();
  await assert.rejects(next, { name: "AbortError" });
});

await test("Cancelar antes da leitura e durante download não mantém bytes em cache", async () => {
  let complete, downloads = 0;
  const source = createModelSource({ download: (model, signal) => {
    assert.ok(signal);
    downloads++;
    return new Promise(resolve => { complete = resolve; });
  } });
  const before = new AbortController(); before.abort();
  await assert.rejects(source.get(model(), "project", { signal: before.signal }), { name: "AbortError" });
  assert.equal(downloads, 0);
  const during = new AbortController();
  const pending = source.get(model(), "project", { signal: during.signal });
  during.abort();
  await assert.rejects(pending, { name: "AbortError" });
  complete(ifc("late"));
  await new Promise(resolve => setTimeout(resolve, 0));
  const next = new AbortController();
  const retry = source.get(model(), "project", { signal: next.signal });
  assert.equal(downloads, 2);
  next.abort();
  await assert.rejects(retry, { name: "AbortError" });
});

await test("Transferir buffer ao worker mantém o Blob cacheado intacto", async () => {
  const source = createModelSource({ download: async () => ifc("download") });
  const first = await source.get(model(), "project");
  structuredClone(first.buffer, { transfer: [first.buffer] });
  assert.equal(first.buffer.byteLength, 0);
  const second = await source.get(model(), "project");
  assert.equal(second.source, "cache");
  assert.equal(new Uint8Array(second.buffer)[0], 73);
});

await test("Aceita Blob do contexto do host com outro construtor", async () => {
  const foreign = vm.runInNewContext(`new (class Blob {
    get [Symbol.toStringTag]() { return 'Blob'; }
    get size() { return wrapped.size; }
    slice(...args) { return wrapped.slice(...args); }
    arrayBuffer() { return wrapped.arrayBuffer(); }
  })()`, { wrapped: new Blob([ifc("foreign")]) });
  assert.equal(foreign instanceof Blob, false);
  const source = createModelSource({
    getLoadedModel: async () => ({ blob: foreign }),
    download: async () => { throw new Error("download inesperado"); },
  });
  assert.equal((await source.get(model(), "project")).source, "trimble");
  assert.equal((await source.get(model(), "project")).source, "cache");
});

await test("RPC sem resposta usa download após prazo e ignora IFC tardio", async () => {
  let complete;
  const source = createModelSource({
    loadedModelTimeoutMs: 10,
    getLoadedModel: () => new Promise(resolve => { complete = resolve; }),
    download: async () => ifc("download"),
  });
  const first = await source.get(model(), "project");
  assert.equal(first.source, "download");
  complete({ blob: new Blob([ifc("late")]) });
  await new Promise(resolve => setTimeout(resolve, 0));
  const cached = await source.get(model(), "project");
  assert.equal(cached.source, "cache");
  assert.equal(new TextDecoder().decode(cached.buffer), new TextDecoder().decode(first.buffer));
});

console.log(checks + " verificações passaram.");
