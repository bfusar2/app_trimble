const V = new URL(import.meta.url).search;
const dependencies = Promise.all([
  import(`./ifc.js${V}`), import(`./section.js${V}`),
]);
let model;

self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    const [{ openIfc, sampleBoxes, cutModel }, { chainSegments }] = await dependencies;
    let result;
    if (method === "open") {
      model = await openIfc(args[0]);
      result = true;
    } else if (method === "sampleBoxes") {
      result = sampleBoxes(model, args[0]);
    } else if (method === "cut") {
      const [plane, options] = args;
      const cut = cutModel(model, plane, options);
      const layers = new Map();
      const tolerance = .0005 * options.scale;
      for (const [type, segments] of cut.segmentsByType) layers.set(type, chainSegments(segments, tolerance));
      for (const [type, segments] of cut.viewSegmentsByType) layers.set(`${type}_VISTA`, chainSegments(segments, tolerance));
      if (cut.gridLines.length) layers.set("EIXOS", cut.gridLines);
      if (cut.hatchLines.length) layers.set("HACHURA", cut.hatchLines);
      result = {
        layers, elementCount: cut.elementCount,
        sectionElementCount: cut.sectionElementCount, viewElementCount: cut.viewElementCount,
      };
    } else throw new Error("Operação IFC desconhecida.");
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: {
      message: error.message || String(error), stack: error.stack, ifcContext: error.ifcContext,
    } });
  }
};
