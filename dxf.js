// Gerador DXF (formato R12, ASCII) — abre em AutoCAD, BricsCAD, ZWCAD, LibreCAD, QCAD etc.
// No AutoCAD: abrir o .dxf e "Salvar como" .dwg.

// Cores ACI por tipo de elemento; o resto recebe cores de uma lista fixa.
const KNOWN_COLORS = {
  IFCWALL: 1, IFCWALLSTANDARDCASE: 1, IFCCURTAINWALL: 1,
  IFCSLAB: 3, IFCROOF: 3,
  IFCCOLUMN: 5, IFCBEAM: 6, IFCMEMBER: 6, IFCPLATE: 6,
  IFCFOOTING: 8, IFCPILE: 8,
  IFCDOOR: 2, IFCWINDOW: 4,
  IFCSTAIR: 30, IFCSTAIRFLIGHT: 30, IFCRAILING: 40,
};
const FALLBACK = [10, 50, 90, 130, 170, 210, 250, 20, 60, 100, 140, 180, 220];

const safeLayer = (name) => String(name).replace(/[<>/\\":;?*|=,]/g, "_").slice(0, 255) || "0";

/**
 * layers: Map<nomeCamada, [{ points: [[x,y],...], closed }]>
 * units: "mm" | "m"
 */
export function buildDxf(layers, { units = "mm" } = {}) {
  const out = [];
  const g = (code, value) => out.push(String(code), String(value));
  const num = (x) => (Math.round(x * 1e4) / 1e4).toString();

  // Extensão do desenho (ajuda o CAD a dar zoom no lugar certo)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const lines of layers.values())
    for (const l of lines)
      for (const [x, y] of l.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
  if (!isFinite(minX)) minX = minY = maxX = maxY = 0;

  // HEADER
  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$ACADVER"); g(1, "AC1009");
  g(9, "$INSUNITS"); g(70, units === "m" ? 6 : 4);
  g(9, "$EXTMIN"); g(10, num(minX)); g(20, num(minY)); g(30, 0);
  g(9, "$EXTMAX"); g(10, num(maxX)); g(20, num(maxY)); g(30, 0);
  g(0, "ENDSEC");

  // TABLES (camadas)
  const names = [...layers.keys()].map(safeLayer);
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LTYPE"); g(70, 1);
  g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, 0); g(3, "Solid line"); g(72, 65); g(73, 0); g(40, 0);
  g(0, "ENDTAB");
  g(0, "TABLE"); g(2, "LAYER"); g(70, names.length + 1);
  const layerDef = (name, color) => {
    g(0, "LAYER"); g(2, name); g(70, 0); g(62, color); g(6, "CONTINUOUS");
  };
  layerDef("0", 7);
  names.forEach((name, i) => {
    const base = name.toUpperCase();
    layerDef(name, KNOWN_COLORS[base] ?? FALLBACK[i % FALLBACK.length]);
  });
  g(0, "ENDTAB");
  g(0, "ENDSEC");

  // ENTITIES
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const [rawName, lines] of layers) {
    const layer = safeLayer(rawName);
    for (const { points, closed } of lines) {
      if (points.length < 2) continue;
      if (points.length === 2 && !closed) {
        g(0, "LINE"); g(8, layer);
        g(10, num(points[0][0])); g(20, num(points[0][1])); g(30, 0);
        g(11, num(points[1][0])); g(21, num(points[1][1])); g(31, 0);
        continue;
      }
      g(0, "POLYLINE"); g(8, layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, closed ? 1 : 0);
      for (const [x, y] of points) {
        g(0, "VERTEX"); g(8, layer); g(10, num(x)); g(20, num(y)); g(30, 0);
      }
      g(0, "SEQEND"); g(8, layer);
    }
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return out.join("\r\n") + "\r\n";
}
