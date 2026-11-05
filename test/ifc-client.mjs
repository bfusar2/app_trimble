import assert from "node:assert/strict";
import { createIfcSession } from "../ifc-client.js";

let worker;
globalThis.Worker = class {
  constructor(url, options) {
    assert.equal(options.type, "module");
    assert.equal(url.pathname.endsWith("/ifc-worker.js"), true);
    this.terminations = 0;
    worker = this;
  }
  postMessage(message) { this.message = message; }
  terminate() { this.terminations++; }
};

const session = createIfcSession();
const pending = session.sampleBoxes(40);
const context = { expressID: 17451367, type: "IFCBUILDINGELEMENTPROXY", guid: "test" };
worker.onmessage({ data: { id: worker.message.id,
  error: { message: "Aborted()", stack: "reader stack", ifcContext: context },
} });
await assert.rejects(pending, error => {
  assert.equal(error.readerFailure, true);
  assert.equal(error.message, "Aborted()");
  assert.equal(error.stack, "reader stack");
  assert.deepEqual(error.ifcContext, context);
  return true;
});
console.log("OK Falha do worker preserva o elemento IFC, a mensagem e o stack");

const cancelled = session.cut({}, {});
session.close(new DOMException("Cancelado", "AbortError"));
await assert.rejects(cancelled, { name: "AbortError" });
session.close();
assert.equal(worker.terminations, 1);
await assert.rejects(session.sampleBoxes(1), /encerrado/);
console.log("OK Encerrar o worker rejeita operações pendentes e fecha uma única vez");
