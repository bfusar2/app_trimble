import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { SingleThreadedFragmentsModel } from '@thatopen/fragments';
import * as OBC from '@thatopen/components';
import { Plane, Vector3, LineSegments, BufferGeometry, BufferAttribute, LineBasicMaterial } from 'three';

const bytes = fs.readFileSync(process.argv[2] || 'fixture.frag');
const start = performance.now();
const model = new SingleThreadedFragmentsModel('fixture', bytes);
await model.ready;
const reloadMs = performance.now() - start;
const plane = new Plane(new Vector3(0, 1, 0), -1.5);
const bounds = {};
for (const id of [36, 49, 66]) {
  const s = model.getSection(plane, [id]);
  const points = s.buffer.slice(0, s.index * 3);
  const x = [], z = [];
  for (let i = 0; i < points.length; i += 3) { x.push(points[i]); z.push(points[i + 2]); }
  bounds[id] = { x: [Math.min(...x), Math.max(...x)], z: [Math.min(...z), Math.max(...z)] };
}
assert(Math.abs(bounds[36].x[1] - bounds[36].x[0] - 5) < .00001, '5m wall length');
assert(Math.abs(bounds[36].z[1] - bounds[36].z[0] - .2) < .00001, '0.2m wall thickness');
assert(Math.abs(bounds[49].z[1] - bounds[49].z[0] - 5) < .00001, 'second wall length');
assert(Math.abs(bounds[49].x[1] - bounds[49].x[0] - .2) < .00001, 'second wall thickness');
assert(bounds[66].x[1] - bounds[66].x[0] > .29 && bounds[66].x[1] - bounds[66].x[0] < .301, '0.3m faceted column diameter');
const sectionStart = performance.now();
const section = model.getSection(plane);
const sectionMs = performance.now() - sectionStart;
assert(section.index > 0 && section.index % 2 === 0);
assert(section.index * 3 <= section.buffer.length, 'section exceeded library buffer capacity');
for (let i = 1; i < section.index * 3; i += 3) assert(Math.abs(section.buffer[i] - 1.5) < 1e-5);
const components = new OBC.Components();
const drawing = new OBC.TechnicalDrawing(components);
const positions = section.buffer.slice(0, section.index * 3);
for (let i = 1; i < positions.length; i += 3) positions[i] = 0;
const geometry = new BufferGeometry();
geometry.setAttribute('position', new BufferAttribute(positions, 3));
drawing.three.add(new LineSegments(geometry, new LineBasicMaterial({ color: 0x333333 })));
const dxfStart = performance.now();
const dxf = components.get(OBC.DxfManager).exporter.export([{ drawing, viewports: [{}] }]);
fs.writeFileSync('fixture-section.dxf', dxf);
const report = { reloadMs, sectionMs, dxfMs: performance.now() - dxfStart, ids: model.getLocalIds(), bounds, vertexCount: section.index, fillIndexCount: section.fillsIndices.length, sectionFloatCapacity: section.buffer.length, dxfBytes: Buffer.byteLength(dxf), dxfLineEntities: (dxf.match(/\r?\nLINE\r?\n/g) || []).length };
assert.equal(report.dxfLineEntities, section.index / 2);
assert(dxf.trimEnd().endsWith('EOF'));
assert(/\$INSUNITS\s+70\s+6\s/.test(dxf), 'DXF declares metres');
console.log(JSON.stringify(report));
fs.writeFileSync('reload.results.json', JSON.stringify(report, null, 2));
model.dispose();
