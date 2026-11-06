# That Open benchmark (2026-11-05)

Isolated evaluation; production app is unchanged. No model is uploaded anywhere.

## Reproduce

Node 24.22.1. Install dependencies using the lockfile, then:

```powershell
node probe.mjs
node reload.mjs
python monitor.py
```

Versions tested: `@thatopen/fragments`, `@thatopen/components` and
`@thatopen/components-front` 3.6.0; `web-ifc` 0.0.78; Three.js 0.187.0.
Generated model files, dependency stores, logs and results are ignored.

## Results

| Input / stage | Result |
|---|---|
| Existing `test/teste.ifc` (2,267 bytes) | Conversion succeeded in 79.7 ms; output 1,627 bytes |
| Prepared `.frag` reload | 48-73 ms in separate Node process |
| Horizontal section at IFC Z=1.5 m | 76 vertices / 38 segments; 96 fill indices |
| Official `DxfManager` export | 6,327 bytes, 38 LINE entities, about 1.5 ms |
| Actual R3 IFC (1,113,119,703 bytes) | Conversion failed with `WebAssembly.Exception`; no fragment file produced |
| Heavy run duration / peak working set | 14.06 s / 3,626,631,168 bytes (3.38 GiB) |

The heavy process was independently monitored every 100 ms, with an 8 GiB
working-set budget and 180 s timeout. It failed itself before either limit.
The last progress event was geometry processing, `IFCPROJECT`, one entity.
These are measurements on this computer; the tiny fixture is not a performance
prediction for normal production files.

## Validation

The IFC importer is configured with `parseOnce=true`, `distanceThreshold=null`,
`COORDINATE_TO_ORIGIN=false` and a file read callback, avoiding a full source
ArrayBuffer in JS. The callback has valid offset/length semantics and returns
only the bytes actually read. The current Fragments importer still calls
web-ifc; streamed input does not bypass the geometry engine.

`reload.mjs` loads the prepared file with `SingleThreadedFragmentsModel`, awaits
`ready`, computes sections with `getSection`, feeds resulting line segments to
`TechnicalDrawing`, and exports using the official `DxfManager`.

Assertions verify nonempty even section vertices, buffer bounds, all points on
the requested plane, two 5 m walls with 0.2 m thickness, the approximately 0.3 m
faceted column, one DXF LINE per section segment, metre INSUNITS=6 and EOF.
The slab is below the section plane and contributes no cut line.
Fragments uses Y-up coordinates, so IFC Z maps to model Y; DXF mapping uses the
drawing XZ plane and the exporter convention. These probe timings include no
network or visible renderer.

## Integration conclusions

- Fragments preparation/reload is functional for the small fixture and suitable
  for evaluating reuse by Trimble file revision. It does not fix the heavy R3.
- `IfcSplitter` groups whole building elements with their dependencies. R3 is
  dominated by a single huge proxy; generic element grouping cannot split that
  geometry into smaller chunks.
- `GeometryEngine` also uses web-ifc; it is not a native alternative kernel.
- `EdgeProjector` offers visible/hidden line projection and near/far planes,
  but requires a That Open `World` with renderer for visibility culling.
  Integrating it adds a separate processing scene; it cannot directly consume
  Trimble's internal renderer/geometry.
- Fragments 3.6.0 `SectionHelper.getSection` allocates a fixed 600,000-float
  buffer (200,000 vertices, approximately 100,000 segments). `SectionGenerator`
  writes with `setXYZ` and increments an index without a capacity guard.
  A large cut therefore needs batching, a patched dynamic buffer, or a separate
  slicer. The probe asserts capacity explicitly; production must not silently
  accept truncated output.
- Do not replace the currently working production path solely on the strength
  of the library name. Native/streamed geometry processing still needs a
  separate proven solution for this particular source.

## Explicit planar-facet fallback investigation

`companion/faceted.py` is a separate native fallback, not part of That Open.
It avoids converting a massive face set into an OpenCASCADE/WebAssembly solid.
The source remains unchanged. A disk-backed index supplies point coordinates
and face/loop records, and explicit polygons are triangulated directly. Holes
use Shapely constrained Delaunay triangulation. New intersection vertices are
stored explicitly when an invalid polygon needs `make_valid`; repaired face
counts and examples are included in each mesh report.

An independent source audit (`audit-source-faces.py`) found 3,613,306 IFCFACE
records, but **3,532,354** faces are referenced by the 89 connected face sets.
The other 80,952 face records are unreferenced (IDs 16,965,635..17,451,341).
No face is referenced twice or through an invalid face ID. The largest set
contains 3,451,402 faces. Coverage must compare the referenced set, not every
orphan record in the source.

An initial strict fallback run reached approximately 2.945 million faces before
rejecting an invalid face: #14,030,746 has a six-vertex outer ring and six-vertex
hole that cross. Nearby faces have tiny floating point deviations from their
planes. The first full diagnostic took 384.59 s with a 5.57 GiB peak working
set and correctly committed no partial geometry cache.

The revised implementation uses a physical planarity tolerance of 1 micron,
preserves original vertex coordinates, and repairs invalid planar regions with
explicit metadata. Twenty problematic source faces were independently tested:
all triangulated, 16 required a reported repair; the maximum deviation from a
plane was 3.66e-8 m (about 37 nanometres). Seven unit/integration tests cover
holes, concavity, mm-to-m conversion, nested/mapped transforms (compared with
the native engine), opening rejection, a repaired crossing with a new vertex,
and retaining tiny original coordinate deviations.

The full production run with these revised checks is recorded separately by
`native-bench/production.py`; isolated sample success alone is not proof of
complete source coverage. A developer checkpoint can avoid repeating indexing
while testing: `FacetIndex.open_existing` verifies the IFC SHA256 and every
index array SHA256 from the trusted `source.json` before reuse.

Full revised production preparation **succeeded**, and the independent
`audit-prepared.py` passed: all 89 referenced face sets, all 3,532,354 source
face references, 6,251,871 vertices and 6,706,783 triangles. Every array has
finite coordinates, valid indices and bounds matching its manifest. There are
32 explicitly reported polygon repairs; maximum plane deviation is
2.9594e-7 m (0.296 micron). SHA256 matches the original source. Preparation with
the verified checkpoint took 194.34 s (including IFC metadata parsing); this is
not a fresh preparation timing or a drawing timing.

The audit also identifies 7,268 zero-area triangulation fragments from collinear
subdivisions. These do not remove surface area, but edge adjacency generation
should exclude them so zero normals cannot add projection noise. The source
face coverage remains complete; this is distinct from omitting a source face.

Official source/API references:

- https://github.com/ThatOpen/engine_fragment
- https://github.com/ThatOpen/engine_components
- https://docs.thatopen.com/Tutorials/Fragments/
