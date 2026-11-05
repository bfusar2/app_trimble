import assert from "node:assert/strict";
import { buildDxf, buildDxfBlob } from "../dxf.js";

const layers = new Map([
  ["EIXOS", [
    { points: [[0,0],[25000,0]] },
    { points: [[0,0]], text: "Eixo Á\nN1", height: 250 },
  ]],
  ["IFCWALL", [{ points: [[0,0],[100,0],[100,100],[0,100]], closed: true }]],
  ["IFCSLAB_VISTA", [{ points: [[0,0],[1000,0],[1000,2000]] }]],
  ["HACHURA", Array.from({ length: 30000 }, (_, i) => ({ points: [[i*.1,0],[i*.1+100,100]] }))],
]);

for (const units of ["mm", "m"]) {
  const text = buildDxf(layers, { units });
  const blob = buildDxfBlob(layers, { units });
  assert.equal(blob.type, "application/dxf");
  assert.equal(blob.size, Buffer.byteLength(text));
  assert.equal(await blob.text(), text);
  assert.ok(text.includes("\r\nTEXT\r\n") && text.includes("\r\nHACHURA\r\n"));
  assert.ok(text.length > 1024*1024, "O teste deve atravessar vários blocos");
  console.log(`OK DXF em ${units}: ${blob.size} bytes idênticos com texto, polilinhas e 30000 traços`);
}

assert.equal(await buildDxfBlob(new Map()).text(), buildDxf(new Map()));
console.log("OK DXF vazio preserva cabeçalho e término");
