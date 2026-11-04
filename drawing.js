// Traços a 45 graus. A regra par/ímpar conserva os vazios da mesma peça.
export function hatch(lines, step) {
  const edges = [];
  let low = Infinity, high = -Infinity;
  for (const {points, closed} of lines) {
    if (!closed) continue;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const ha = a[1] - a[0], hb = b[1] - b[0];
      if (ha === hb) continue;
      edges.push({a,b,ha,hb});
      low = Math.min(low, ha, hb);
      high = Math.max(high, ha, hb);
    }
  }
  const result = [], pitch = step * Math.SQRT2;
  for (let k = Math.ceil(low / pitch); k * pitch < high; k++) {
    const h = k * pitch, xs = [];
    for (const {a,b,ha,hb} of edges) {
      if ((ha <= h) === (hb <= h)) continue;
      xs.push(a[0] + (b[0] - a[0]) * (h - ha) / (hb - ha));
    }
    xs.sort((a,b) => a-b);
    for (let i = 1; i < xs.length; i += 2) {
      const x = xs[i-1], y = xs[i];
      if (y-x > 1e-7) result.push({points:[[x,x+h],[y,y+h]]});
    }
  }
  return result;
}

const dot = (a,b) => a.reduce((sum,v,i) => sum + v*b[i],0);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit = a => a.map(v => v/Math.hypot(...a));
const values = a => a.map(v => Number(v.value ?? v));
const xyz = a => [a[0],a[1],a[2] ?? 0];

// IfcGridAxis tem curva própria e não precisa gerar uma malha triangulada.
export function gridLines(model, plane, scale, filter) {
  const {api,modelID} = model;
  const read = ref => ref && api.GetLine(modelID,ref.value);
  const ids = name => api.GetLineIDsWithType(modelID,api.GetTypeCodeFromName(name));
  const grids = ids("IFCGRID"), lines = [];
  if (!grids.size()) return lines;
  const project = read({value:ids("IFCPROJECT").get(0)});
  const units = read(project.UnitsInContext).Units.map(read);
  const length = units.find(u => u.UnitType?.value === "LENGTHUNIT");
  const factors = {MILLI:.001,CENTI:.01,DECI:.1,KILO:1000};
  const factor = length?.Name?.value === "METRE" ? (length.Prefix ? factors[length.Prefix.value] : 1) : null;
  if (!factor) throw new Error("Unidade dos eixos IFC não suportada. Desmarque a exportação de eixos para continuar.");
  for (let i=0;i<grids.size();i++) {
    const grid = read({value:grids.get(i)});
    if (filter && !filter(grid.expressID)) continue;
    const frames = [];
    for (let p = read(grid.ObjectPlacement); p; p = read(p.PlacementRelTo)) {
      const f = read(p.RelativePlacement);
      const origin = xyz(values(read(f.Location).Coordinates));
      const z = unit(f.Axis ? xyz(values(read(f.Axis).DirectionRatios)) : [0,0,1]);
      const ref = f.RefDirection ? xyz(values(read(f.RefDirection).DirectionRatios)) : [1,0,0];
      const y = unit(cross(z,ref)), x = cross(y,z);
      frames.push({origin,x,y,z});
    }
    function projectPoint(coords) {
      let p = xyz(coords);
      for (const {origin,x,y,z} of frames)
        p = origin.map((v,j) => v+x[j]*p[0]+y[j]*p[1]+z[j]*p[2]);
      return [dot(p,plane.u)*scale*factor,dot(p,plane.v)*scale*factor];
    }
    for (const axisRef of [...grid.UAxes,...grid.VAxes,...(grid.WAxes || [])]) {
      const axis = read(axisRef), curve = read(axis.AxisCurve);
      const parts = [];
      if (Array.isArray(curve.Points)) parts.push(curve.Points.map(p => values(read(p).Coordinates)));
      else if (curve.Points) {
        const coords = read(curve.Points)?.CoordList?.map(values);
        if (coords && !curve.Segments?.length) parts.push(coords);
        else if (coords) for (const s of curve.Segments)
          // web-ifc devolve IfcLineIndex sem label; type identifica o token STEP.
          if (s.constructor?.name === "IfcLineIndex" && Array.isArray(s.value)) parts.push(values(s.value).map(j => coords[j-1]));
      }
      for (const part of parts) {
        if (part.length < 2) continue;
        const points = part.map(projectPoint);
        const [x,y] = points[0];
        if (points.every(p => Math.hypot(p[0]-x,p[1]-y) < .0005*scale)) {
          lines.push({points:[[x,y-.25*scale],[x,y+.25*scale]]});
        } else lines.push({points});
        if (axis.AxisTag?.value) lines.push({points:[points[0]],text:axis.AxisTag.value,height:.25*scale});
      }
    }
  }
  return lines;
}
