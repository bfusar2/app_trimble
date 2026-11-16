// Visualizador simulado para o modo local (index.html aberto fora do Trimble Connect).
// Imita a parte da Workspace API usada pelo app: marcações de ponto e de texto (em mm),
// troca de ferramenta e os eventos correspondentes.

export function createMockApi(onEvent) {
  const markups = new Map();
  let nextId = 1;
  let tool = "reset";
  const emit = (event, data) => setTimeout(() => onEvent(event, { data }), 0);
  const copy = value => JSON.parse(JSON.stringify(value));
  const ofType = type => [...markups.values()].filter(m => m.type === type).map(m => copy(m.markup));

  function upsert(type, list) {
    return list.map(item => {
      const id = item.id != null && markups.get(item.id)?.type === type ? item.id : nextId++;
      const action = markups.has(id) ? "updated" : "added";
      const markup = { ...copy(item), id };
      markups.set(id, { type, markup });
      emit("viewer.onMarkupChanged", { action, markupType: type, markup: copy(markup) });
      return copy(markup);
    });
  }

  const api = {
    project: { getCurrentProject: async () => ({ id: "local", name: "Modo local", location: "local", crs: { name: "SIRGAS 2000 / UTM 23S (simulado)" } }) },
    viewer: {
      async activateTool(name) {
        const old = tool;
        tool = name;
        emit("viewer.onToolChanged", { old, new: name });
      },
    },
    markup: {
      getSinglePointMarkups: async () => ofType("pointMarkup"),
      addSinglePointMarkups: async list => upsert("pointMarkup", list),
      getTextMarkups: async () => ofType("textMarkup"),
      addTextMarkup: async list => upsert("textMarkup", list),
      async removeMarkups(ids) {
        for (const id of ids ?? [...markups.keys()]) {
          const entry = markups.get(id);
          if (!entry) continue;
          markups.delete(id);
          emit("viewer.onMarkupChanged", { action: "removed", markupType: entry.type, markup: copy(entry.markup) });
        }
      },
    },
    /** Simula um clique do usuário com a ferramenta de ponto ativa (coordenadas em metros). */
    simulatePick(x, y, z) {
      if (tool !== "pointMarkup") return false;
      upsert("pointMarkup", [{ start: { positionX: x * 1000, positionY: y * 1000, positionZ: z * 1000 } }]);
      return true;
    },
    /** Remove uma marcação como se o usuário a apagasse no visualizador. */
    simulateDelete(id) { return api.markup.removeMarkups([id]); },
    dump: () => copy([...markups.values()]),
  };
  return api;
}
