# Native geometry benchmark

These scripts test a local IFC without uploading it. Source models and generated
geometry belong under the ignored `.ifc-check-v8/` directory and must not be
published. The reader benchmark has a process watchdog (working set and timeout).

Test environment: Python 3.14 x64; IfcOpenShell 0.9.0.post1; Windows; 127 GiB RAM.

## Measured heavy source

- IFC2X3: 1,113,119,703 bytes, 17.45 million STEP records.
- One represented IfcBuildingElementProxy, 89 connected face sets.
- 3,613,306 IfcFace records; largest set: 3,451,402 faces.

| Reader/kernel | Outcome | Wall time | Peak working set |
|---|---|---:|---:|
| IfcOpenShell / OpenCASCADE | Stopped at configured memory cap | 63.52 s | 8.045 GiB |
| IfcOpenShell / cgal-simple | Returned geometry, completeness **unverified** | 139.108 s | 16.559 GiB |
| IfcOpenShell / hybrid-cgal-simple-opencascade | Stopped at configured timeout | 301.168 s | 17.294 GiB |
| Native faceted provider v2, verified source index reused | Complete geometry preparation | 195.15 s | 5.572 GiB |
| Native faceted provider v2, fresh preparation | Complete geometry preparation | 349.279 s | 5.533 GiB |
| Native faceted provider v2, existing geometry cache | Reused geometry, no native parse | 0.547 s | not monitored |

The cgal-simple return contains only 80,952 triangles and 39,196 vertices. This
must not be treated as successful source-complete conversion solely because the
API did not raise: an IFC reader may log and omit failed subshapes. A source-
faceted path is being tested separately; the hybrid kernel did not finish within
the five-minute benchmark limit.

The production faceted provider covered all **89 referenced face sets** and
**3,532,354 / 3,532,354 referenced source faces**, yielding **6,706,783 triangles**.
The source also contains unreferenced face records, which are not model bodies.
It repaired 32 self-intersecting/invalid polygon faces explicitly, reported zero
degenerate source faces and measured a maximum plane deviation of 0.296 micrometre
(below the 1 micrometre tolerance). Geometry repair is reported, never hidden.

`production.py --index` included source hashing, a full native IFC parse and
SHA256 verification of the reused source index. This is not the first-run timing:
the separate `production.py --fresh` run built its own index from scratch in
349.279 seconds. All **178 generated array files** matched the indexed proof
byte for byte by SHA256. The next preparation reused that geometry cache in
0.547 seconds (this timing excludes drawing/DXF generation).
`audit_meshes.py` independently checked all 89 cached mesh arrays for finite
coordinates, valid triangle indices, exact counts and matching bounds.

## Running

```powershell
python native-bench/benchmark.py .ifc-check-v8/model-r3.ifc --max-gib 24 --timeout 300 --kernel hybrid-cgal-simple-opencascade
python native-bench/test_geometry.py
```

The first command writes JSON stage logs and `.npy` geometry under the ignored
directory. The tests check cache reuse, revision invalidation, metre coordinates,
valid triangle indices, and refusal to commit a cache after geometry failure.
