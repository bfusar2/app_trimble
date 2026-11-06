import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as FRAGS from '@thatopen/fragments';
import * as OBC from '@thatopen/components';
import * as WEBIFC from 'web-ifc';

const source = path.resolve(process.argv[2] || '../../test/teste.ifc');
const dest = path.resolve(process.argv[3] || 'fixture.frag');
const importer = new FRAGS.IfcImporter();
importer.wasm = { path: path.resolve('node_modules/web-ifc') + path.sep, absolute: true };
importer.parseOnce = true;
importer.distanceThreshold = null;
importer.webIfcSettings.COORDINATE_TO_ORIGIN = false;
const start = performance.now();
const input = fs.openSync(source, 'r');
let reads = 0, readBytes = 0;
try {
  const exported = await importer.process({
    readFromCallback: true,
    readCallback(offset, size) {
      const data = new Uint8Array(size);
      const n = fs.readSync(input, data, 0, size, offset);
      reads++; readBytes += n;
      return data.subarray(0, n);
    },
    raw: false,
    progressCallback(progress, data) { console.log(JSON.stringify({ progress, data, rssMiB: process.memoryUsage().rss / 1048576 })); }
  });
  fs.writeFileSync(dest, exported);
  const report = {
    source: path.basename(source), inputBytes: fs.statSync(source).size,
    outputBytes: exported.byteLength, convertMs: performance.now() - start,
    reads, readBytes, memory: process.memoryUsage(),
    exports: { IfcImporter: !!FRAGS.IfcImporter, IfcSplitter: !!FRAGS.IfcSplitter, GeometryEngine: !!FRAGS.GeometryEngine, DxfExporter: !!OBC.DxfExporter },
  };
  console.log(JSON.stringify(report));
  fs.writeFileSync(dest.replace(/\.frag$/, '') + '.results.json', JSON.stringify(report, null, 2));
} finally { fs.closeSync(input); }
