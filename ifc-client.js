// Um worker por IFC mantém o painel responsivo e libera toda a memória WASM ao terminar.
export function createIfcSession() {
  const url = new URL("./ifc-worker.js", import.meta.url);
  url.search = new URL(import.meta.url).search;
  const worker = new Worker(url, { type: "module" });
  const pending = new Map();
  let nextId = 0;
  let closed = false;

  function close(reason = new Error("Leitor IFC encerrado.")) {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const task of pending.values()) task.reject(reason);
    pending.clear();
  }

  worker.onmessage = ({ data }) => {
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) {
      const error = new Error(data.error.message);
      error.stack = data.error.stack;
      error.readerFailure = true;
      task.reject(error);
    } else task.resolve(data.result);
  };
  worker.onerror = event => {
    event.preventDefault();
    const error = new Error(event.message || "O leitor IFC foi interrompido pelo navegador.");
    error.readerFailure = true;
    close(error);
  };
  worker.onmessageerror = () => close(new Error("Não foi possível receber os dados do leitor IFC."));

  function call(method, args, transfer = []) {
    if (closed) return Promise.reject(new Error("Leitor IFC encerrado."));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, method, args }, transfer); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }

  return {
    open: buffer => call("open", [buffer], [buffer]),
    sampleBoxes: limit => call("sampleBoxes", [limit]),
    cut: (plane, options) => call("cut", [plane, options]),
    close,
  };
}
