// Mantém apenas os bytes do IFC em cache. A geometria e a memória WASM são
// liberadas pelo leitor após cada modelo, independentemente deste cache.
export function createModelSource({ getLoadedModel, download, onStatus = () => {}, maxBytes = 64 * 1024 * 1024, loadedModelTimeoutMs = 5000 }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Limite de cache inválido.");
  if (!Number.isSafeInteger(loadedModelTimeoutMs) || loadedModelTimeoutMs <= 0) throw new Error("Tempo de espera do host inválido.");
  const cache = new Map();
  let totalBytes = 0;

  function keyOf(model, projectId) {
    if (!projectId || !model.id || !model.versionId) return null;
    return JSON.stringify([String(projectId), String(model.id), String(model.versionId)]);
  }

  function remove(key) {
    totalBytes -= cache.get(key).size;
    cache.delete(key);
  }

  function remember(key, blob) {
    if (!key || blob.size > maxBytes || maxBytes === 0) return;
    if (cache.has(key)) remove(key);
    while (totalBytes + blob.size > maxBytes) remove(cache.keys().next().value);
    cache.set(key, blob);
    totalBytes += blob.size;
  }

  return {
    async get(model, projectId, { signal } = {}) {
      signal?.throwIfAborted();
      const key = keyOf(model, projectId);
      if (key && cache.has(key)) {
        const blob = cache.get(key);
        cache.delete(key);
        cache.set(key, blob);
        onStatus("cache", model);
        const buffer = await waitFor(blob.arrayBuffer(), signal);
        return { buffer, source: "cache" };
      }

      if (getLoadedModel) {
        onStatus("trimble", model);
        let blob = null;
        try {
          const loaded = await waitFor(getLoadedModel(model.id), signal, loadedModelTimeoutMs);
          const sameId = loaded?.id == null || String(loaded.id) === String(model.id);
          const sameVersion = !model.versionId || loaded?.versionId == null ||
            String(loaded.versionId) === String(model.versionId);
          if (sameId && sameVersion) blob = await waitFor(originalIfc(loaded?.blob), signal);
        } catch {
          signal?.throwIfAborted();
          // O host pode não fornecer o conteúdo carregado. Usa o IFC original
          // pela API de arquivos quando o blob está ausente ou indisponível.
        }
        if (blob) {
          const buffer = await waitFor(blob.arrayBuffer(), signal);
          remember(key, blob);
          return { buffer, source: "trimble" };
        }
      }

      onStatus("download", model);
      signal?.throwIfAborted();
      const buffer = await waitFor(download(model, signal), signal);
      const header = buffer instanceof ArrayBuffer ? new Blob([new Uint8Array(buffer, 0, Math.min(256, buffer.byteLength))]) : null;
      if (!header || !await waitFor(isIfc(header), signal)) {
        throw new Error(`O conteúdo recebido de "${model.name || model.id}" não é um IFC STEP válido. Confira o arquivo e tente novamente.`);
      }
      // Arquivos maiores que o orçamento não ganham uma segunda cópia em Blob.
      if (key && maxBytes > 0 && buffer.byteLength <= maxBytes) remember(key, new Blob([buffer]));
      return { buffer, source: "download" };
    },

    clear() {
      cache.clear();
      totalBytes = 0;
    },

    prune(models, projectId) {
      const current = new Set(models.map(model => keyOf(model, projectId)).filter(Boolean));
      for (const key of cache.keys()) if (!current.has(key)) remove(key);
    },
  };
}

// O RPC do host não aceita AbortSignal. Interrompe a espera e ignora a resposta
// tardia, sem manter o arquivo no cache nem iniciar um download após cancelar.
function waitFor(promise, signal, timeoutMs = 0) {
  if (!signal && !timeoutMs) return promise;
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs) timer = setTimeout(() => {
      cleanup();
      reject(new Error("Tempo esgotado consultando o IFC carregado no Trimble."));
    }, timeoutMs);
    Promise.resolve(promise).then(value => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else resolve(value);
    }, error => {
      cleanup();
      reject(error);
    });
    if (signal?.aborted) abort();
  });
}

async function originalIfc(content) {
  let blob;
  if (typeof content === "string") {
    // O Workspace API também pode devolver base64. URLs, data URLs e texto
    // simples não são tratados como links e não provocam requisições adicionais.
    const binary = atob(content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    blob = new Blob([bytes]);
  } else if (Object.prototype.toString.call(content) === "[object Blob]" &&
    typeof content.arrayBuffer === "function" && typeof content.slice === "function" &&
    Number.isSafeInteger(content.size) && content.size >= 0) blob = content;
  else return null;
  return await isIfc(blob) ? blob : null;
}

async function isIfc(blob) {
  const header = await blob.slice(0, 256).text();
  return /^\s*ISO-10303-21\s*;/i.test(header);
}
