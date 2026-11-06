"""Bounded-memory reader for explicit IFC planar faces.

The IFC entity graph is used only for shallow representation/placement metadata.
Millions of coordinates, faces and loops are read directly from disk; no
OpenCASCADE or WebAssembly solid conversion is involved. Unsupported topology
raises before a completed cache can be committed.
"""
from __future__ import annotations

import pathlib
import re
import time
import hashlib
import json

import numpy as np

RECORD = re.compile(rb"^\s*#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(")
REF = re.compile(rb"#(\d+)")


class UnsupportedFaceted(ValueError):
    pass


class PointStore:
    """Original mmap coordinates plus explicit intersections introduced by repair."""
    def __init__(self, base):
        self.base = base
        self.extra = []
        self.lookup = {}

    def add(self, xyz):
        key = tuple(float(v) for v in xyz)
        if key not in self.lookup:
            self.lookup[key] = len(self.base)+len(self.extra)
            self.extra.append(key)
        return self.lookup[key]

    def __getitem__(self, ids):
        ids = np.asarray(ids)
        if not ids.size or ids.max() < len(self.base):
            return self.base[ids]
        output = np.empty((*ids.shape, 3), dtype=np.float64)
        old = ids < len(self.base)
        output[old] = self.base[ids[old]]
        output[~old] = np.asarray(self.extra)[ids[~old]-len(self.base)]
        return output

    def flush(self): self.base.flush()

    @property
    def _mmap(self): return self.base._mmap


def _records(path):
    """Yield physical STEP records, allowing a record to span lines.

    Our faceted fallback deliberately rejects multiple statements per physical
    line, rather than indexing an ambiguous/truncated statement.
    """
    with open(path, "rb") as stream:
        while True:
            offset = stream.tell()
            line = stream.readline()
            if not line:
                return
            match = RECORD.match(line)
            if not match:
                continue
            while not line.rstrip().endswith(b";"):
                extra = stream.readline()
                if not extra:
                    raise ValueError("Registro IFC incompleto #%s" % match[1].decode())
                line += extra
            # Data strings may contain semicolons; only reject a clear second id.
            if re.search(rb";\s*#\d+\s*=", line):
                raise ValueError("Leitor facetado requer um registro STEP por linha")
            yield offset, int(match[1]), match[2], line


def _refs(record):
    # Skip the statement's own ID.
    pos = record.index(b"=") + 1
    return (int(m[1]) for m in REF.finditer(record, pos))


class FacetIndex:
    """On-disk arrays indexed by EXPRESS id. Call close before deleting folder."""
    def __init__(self, path, folder, progress=lambda message: None):
        self.path = pathlib.Path(path)
        self.folder = pathlib.Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        progress("Indexando faces explicitas do IFC...")
        maximum = 0
        counts = {}
        for number, (_, eid, kind, _) in enumerate(_records(self.path), 1):
            maximum = max(maximum, eid)
            name = kind.decode()
            counts[name] = counts.get(name, 0) + 1
            if number % 2000000 == 0:
                progress("Indexando IFC: %s registros..." % number)
        self.counts = counts
        self.offsets = np.lib.format.open_memmap(self.folder / "offsets.npy", mode="w+", dtype=np.uint64, shape=(maximum+1,))
        self.lengths = np.lib.format.open_memmap(self.folder / "lengths.npy", mode="w+", dtype=np.uint32, shape=(maximum+1,))
        self.points = np.lib.format.open_memmap(self.folder / "points.npy", mode="w+", dtype=np.float64, shape=(maximum+1, 3))
        self.is_point = np.lib.format.open_memmap(self.folder / "is-point.npy", mode="w+", dtype=np.bool_, shape=(maximum+1,))
        progress("Lendo coordenadas e offsets sem converter solidos...")
        for number, (offset, eid, kind, record) in enumerate(_records(self.path), 1):
            if len(record) >= 2**32:
                raise ValueError("Registro IFC maior que 4 GiB")
            if self.lengths[eid]:
                raise ValueError("EXPRESS id duplicado #%s" % eid)
            self.offsets[eid] = offset
            self.lengths[eid] = len(record)
            if kind == b"IFCCARTESIANPOINT":
                data = record[record.index(b"((")+2:record.rindex(b"))")]
                values = np.fromstring(data.decode("ascii"), sep=",")
                if len(values) not in (2, 3) or not np.isfinite(values).all():
                    raise ValueError("Coordenada IFC invalida #%s" % eid)
                self.points[eid, :len(values)] = values
                self.is_point[eid] = True
            if number % 1000000 == 0:
                progress("Coordenadas e offsets: %s/%s registros..." % (number, sum(counts.values())))
        self.stream = self.path.open("rb")
        self.points = PointStore(self.points)

    @classmethod
    def open_existing(cls, path, folder):
        """Developer checkpoint reuse; verifies source and all index file hashes."""
        folder = pathlib.Path(folder)
        metadata = json.loads((folder/"source.json").read_text())
        def sha(filename):
            digest = hashlib.sha256()
            with open(filename,"rb") as stream:
                for chunk in iter(lambda:stream.read(8*1024*1024),b""):digest.update(chunk)
            return digest.hexdigest()
        if metadata["sourceSha256"] != sha(path):
            raise ValueError("Checkpoint pertence a outro IFC")
        obj = cls.__new__(cls)
        obj.path, obj.folder = pathlib.Path(path), folder
        for key, name in (("offsets","offsets.npy"),("lengths","lengths.npy"),("points","points.npy"),("is_point","is-point.npy")):
            if metadata["files"][name] != sha(folder/name):
                raise ValueError("Checkpoint de indice alterado: " + name)
            setattr(obj,key,np.load(folder/name,mmap_mode="r"))
        if not (len(obj.offsets)==len(obj.lengths)==len(obj.points)==len(obj.is_point)):
            raise ValueError("Dimensoes do checkpoint invalidas")
        obj.points = PointStore(obj.points)
        obj.stream = obj.path.open("rb")
        return obj

    def read(self, eid, expected=None):
        if eid <= 0 or eid >= len(self.lengths) or not self.lengths[eid]:
            raise ValueError("Referencia IFC ausente #%s" % eid)
        self.stream.seek(int(self.offsets[eid]))
        record = self.stream.read(int(self.lengths[eid]))
        if expected and RECORD.match(record)[2] not in expected:
            raise ValueError("Tipo de geometria nao suportado #%s" % eid)
        return record

    def close(self):
        if hasattr(self, "stream"):
            self.stream.close()
        for key in ("offsets", "lengths", "points", "is_point"):
            value = getattr(self, key, None)
            if value is not None:
                value.flush()
                value._mmap.close()

    def face_loops(self, face_id):
        face = self.read(face_id, {b"IFCFACE"})
        result = []
        for bound_id in _refs(face):
            bound = self.read(bound_id, {b"IFCFACEOUTERBOUND", b"IFCFACEBOUND"})
            loop_id = next(_refs(bound))
            loop = self.read(loop_id, {b"IFCPOLYLOOP"})
            ids = np.fromiter(_refs(loop), dtype=np.int64)
            if len(ids) < 3 or not self.is_point[ids].all():
                raise ValueError("Loop IFC invalido #%s" % loop_id)
            if ids[0] == ids[-1]:
                ids = ids[:-1]
            if b".F." in bound:
                ids = ids[::-1]
            result.append((b"IFCFACEOUTERBOUND" in bound, ids))
        if not result or sum(outer for outer, _ in result) != 1:
            raise ValueError("Face sem um unico contorno externo #%s" % face_id)
        result.sort(key=lambda item: not item[0])
        return [ids for _, ids in result]


def triangulate_loops(points, rings, *, repair=False, tolerance=1e-5, diagnostics=None):
    """Return triangle point IDs, retaining inner holes and rejecting bad faces."""
    outer = rings[0]
    coords = np.asarray(points[outer])
    if len(rings) == 1 and len(outer) == 3:
        # Three points are always planar. Avoid general polygon machinery for
        # the common triangular facet while still detecting zero-area input.
        a = coords[1]-coords[0]
        b = coords[2]-coords[0]
        nx = a[1]*b[2]-a[2]*b[1]
        ny = a[2]*b[0]-a[0]*b[2]
        nz = a[0]*b[1]-a[1]*b[0]
        if nx*nx+ny*ny+nz*nz < 1e-30:
            return np.empty((0, 3), dtype=np.int64)
        return np.array([outer])
    shifted = coords - coords[0]
    normal = np.sum(np.cross(shifted, np.roll(shifted, -1, axis=0)), axis=0)
    magnitude = np.linalg.norm(normal)
    if magnitude < 1e-15:
        # A bow-tie can have zero signed area without being collinear.
        base = shifted[np.argmax(np.linalg.norm(shifted, axis=1))]
        normals = np.cross(shifted, base)
        sizes = np.linalg.norm(normals, axis=1)
        if sizes.max(initial=0) > 1e-10:
            if not repair: raise ValueError("Face IFC auto-intersectante com area assinada nula")
            normal = normals[np.argmax(sizes)]
            magnitude = np.linalg.norm(normal)
        else:
            return np.empty((0, 3), dtype=np.int64)
    max_deviation = 0.
    for ring in rings:
        distances = np.abs((np.asarray(points[ring])-coords[0]) @ (normal/magnitude))
        max_deviation = max(max_deviation, distances.max(initial=0))
        if distances.max(initial=0) > tolerance:
            raise ValueError("Face IFC nao planar; triangulacao direta seria ambigua")
    if diagnostics is not None:
        diagnostics["maxPlanarityDeviation"] = float(max_deviation)
    axis = int(np.argmax(np.abs(normal)))
    keep = [i for i in range(3) if i != axis]
    projected = coords[:, keep]
    if len(rings) == 1:
        if len(outer) == 3:
            return np.array([outer])
        vectors = np.roll(projected, -1, axis=0) - projected
        following = np.roll(vectors, -1, axis=0)
        cross = vectors[:, 0]*following[:, 1] - vectors[:, 1]*following[:, 0]
        if len(outer) == 4 and (np.all(cross >= -1e-10) or np.all(cross <= 1e-10)):
            return np.column_stack((np.repeat(outer[0], len(outer)-2), outer[1:-1], outer[2:]))
    import shapely
    if not hasattr(shapely, "constrained_delaunay_triangles"):
        raise RuntimeError("Faces com furos requerem Shapely >= 2.1")
    planar = [np.asarray(points[ring])[:, keep] for ring in rings]
    polygon = shapely.Polygon(planar[0], planar[1:])
    if not polygon.is_valid:
        if not repair:
            raise ValueError("Face IFC invalida ou auto-intersectante")
        reason = shapely.is_valid_reason(polygon)
        polygon = shapely.make_valid(polygon)
        if diagnostics is not None:
            diagnostics.update(repaired=True, reason=reason)
    if diagnostics is not None:
        diagnostics["maxPlanarityDeviation"] = float(max_deviation)
    triangles = shapely.constrained_delaunay_triangles(polygon)
    lookup = {}
    for ring, xy in zip(rings, planar):
        for eid, coordinate in zip(ring, xy):
            lookup[tuple(coordinate)] = int(eid)
    result = []
    for triangle in triangles.geoms:
        ids = []
        for xy in list(triangle.exterior.coords)[:3]:
            key = tuple(xy)
            if key not in lookup:
                if not hasattr(points,"add"):
                    raise ValueError("Reparo requer coordenadas de intersecao adicionais")
                xyz = coords[0].copy()
                xyz[keep] = xy
                xyz[axis] = coords[0,axis] - np.dot(normal[keep],np.asarray(xy)-coords[0,keep])/normal[axis]
                lookup[key] = points.add(xyz)
            ids.append(lookup[key])
        result.append(ids)
    if not result:
        raise ValueError("Reparo nao produziu nenhuma superficie de area positiva")
    if abs(sum(t.area for t in triangles.geoms) - polygon.area) > max(1e-8, polygon.area*1e-8):
        raise ValueError("Triangulacao nao preservou a area da face IFC")
    result = np.asarray(result, dtype=np.int64)
    # GEOS uses its own winding; retain the source outer-loop face normal.
    area_sign = np.sum(projected[:, 0]*np.roll(projected[:, 1], -1)-projected[:, 1]*np.roll(projected[:, 0], -1))
    first_xy = np.asarray(points[result[0]])[:, keep]
    a, b = first_xy[1]-first_xy[0], first_xy[2]-first_xy[0]
    tri_sign = a[0]*b[1]-a[1]*b[0]
    if area_sign*tri_sign < 0:
        result = result[:, ::-1]
    return result


def representation_sets(product):
    """Yield (connected-face-set id, local-to-world SI matrix), fail if mixed."""
    import ifcopenshell.util.placement
    import ifcopenshell.util.unit
    factor = ifcopenshell.util.unit.calculate_unit_scale(product.file)
    world = ifcopenshell.util.placement.get_local_placement(product.ObjectPlacement)
    seen = set()

    def walk(item, matrix):
        kind = item.is_a()
        if kind == "IfcMappedItem":
            transform = ifcopenshell.util.placement.get_mappeditem_transformation(item)
            for child in item.MappingSource.MappedRepresentation.Items:
                yield from walk(child, matrix @ transform)
        elif kind in ("IfcFaceBasedSurfaceModel", "IfcShellBasedSurfaceModel"):
            sets = item.FbsmFaces if kind == "IfcFaceBasedSurfaceModel" else item.SbsmBoundary
            for faceset in sets:
                yield faceset.id(), matrix
        elif kind == "IfcFacetedBrep":
            if getattr(item, "Voids", None):
                raise ValueError("Brep com vazios requer leitor nativo de solidos")
            yield item.Outer.id(), matrix
        else:
            raise ValueError("Representacao nao e puramente facetada: " + kind)

    for rep in product.Representation.Representations:
        if rep.RepresentationIdentifier not in ("Body", "Facetation"):
            continue
        for item in rep.Items:
            for eid, matrix in walk(item, world):
                key = (eid, matrix.tobytes())
                if key in seen:
                    continue
                seen.add(key)
                si = matrix.copy()
                si[:3, :] *= factor
                yield eid, si


def extract_product_facets(index, product, folder, progress=lambda message: None):
    """Extract every source face, fail explicitly on unsupported/invalid data.

    Return mesh entries in geometry.py manifest format. Each connected face set
    remains its own mesh; all share the original product GUID for selection.
    """
    folder = pathlib.Path(folder)
    meshes = []
    for sequence, (set_id, matrix) in enumerate(representation_sets(product)):
        cfs = index.read(set_id, {b"IFCCONNECTEDFACESET", b"IFCCLOSEDSHELL", b"IFCOPENSHELL"})
        expected_faces = sum(1 for _ in _refs(cfs))
        raw = folder / ("%s-%s-triangles.raw" % (product.id(), set_id))
        count = 0
        degenerate = 0
        repaired = 0
        repair_examples = []
        maximum_deviation = 0.
        scale = float(np.linalg.norm(matrix[:3,:3],ord=2))
        started = time.monotonic()
        with raw.open("wb") as target:
            for face_id in _refs(cfs):
                rings = index.face_loops(face_id)
                diagnostics = {}
                try:
                    triangles = triangulate_loops(index.points, rings, repair=True, tolerance=1e-6/scale, diagnostics=diagnostics)
                except Exception as error:
                    raise ValueError("Face IFC #%s: %s" % (face_id,error)) from error
                if diagnostics.get("repaired"):
                    repaired += 1
                    if len(repair_examples)<10:repair_examples.append({"faceID":face_id,"reason":diagnostics["reason"]})
                maximum_deviation=max(maximum_deviation,diagnostics.get("maxPlanarityDeviation",0)*scale)
                if not len(triangles):
                    degenerate += 1
                target.write(triangles.tobytes())
                count += 1
                if count % 100000 == 0:
                    progress("Faces explicitas #%s: %s (%ss)" % (set_id, count, round(time.monotonic()-started)))
        if not raw.stat().st_size:
            raw.unlink()
            raise ValueError("Conjunto de faces vazio #%s" % set_id)
        original = np.memmap(raw, mode="r", dtype=np.int64).reshape((-1, 3))
        unique = np.unique(original)
        coords = index.points[unique]
        vertices = coords @ matrix[:3, :3].T + matrix[:3, 3]
        faces = np.searchsorted(unique, original).astype(np.uint32)
        vf = "%s-%s-vertices.npy" % (product.id(), sequence)
        ff = "%s-%s-faces.npy" % (product.id(), sequence)
        np.save(folder/vf, vertices, allow_pickle=False)
        np.save(folder/ff, faces, allow_pickle=False)
        if count != expected_faces:
            raise ValueError("Contagem de faces incompleta #%s" % set_id)
        mesh = {"vertices": vf, "faces": ff, "type": product.is_a().upper(), "guid": product.GlobalId, "expressID": product.id(), "min": vertices.min(axis=0).tolist(), "max": vertices.max(axis=0).tolist(), "vertexCount": len(vertices), "triangleCount": len(faces), "sourceFaceCount": count, "expectedFaceCount": expected_faces, "degenerateFaceCount": degenerate, "repairedFaceCount": repaired,"repairExamples":repair_examples,"maxPlanarityDeviationM":maximum_deviation,"faceSetID": set_id}
        meshes.append(mesh)
        del faces, vertices, coords, unique
        original._mmap.close()
        del original
        raw.unlink()
    if not meshes:
        raise ValueError("Produto sem representacao facetada Body")
    return meshes


def prepare_faceted(ifc_path, output_dir, progress=lambda message: None, model=None, existing_index=None):
    """Return meshes for an entirely explicit-facet model, or raise unsupported.

    Caller owns the atomic output directory. All represented products are
    preflighted before index/mesh writing; partial success must never be used.
    An existing IfcOpenShell model may be supplied to avoid parsing it twice.
    """
    import ifcopenshell
    if model is None:
        progress("Lendo estrutura IFC para faces explicitas...")
        model = ifcopenshell.open(str(ifc_path))
    skip = {"IfcSpace", "IfcOpeningElement", "IfcOpeningStandardCase", "IfcAnnotation", "IfcVirtualElement", "IfcGrid"}
    products = [p for p in model.by_type("IfcProduct") if p.is_a() not in skip and getattr(p, "Representation", None)]
    try:
        if not products:
            raise ValueError("Nenhum produto com corpo facetado")
        for product in products:
            if getattr(product, "HasOpenings", None):
                raise ValueError("Produto com aberturas relacionais requer leitor de solidos")
            if not list(representation_sets(product)):
                raise ValueError("Produto sem corpo facetado")
    except ValueError as error:
        raise UnsupportedFaceted(str(error)) from error
    index_dir = pathlib.Path(output_dir) / ".facet-index"
    index = FacetIndex.open_existing(ifc_path,existing_index) if existing_index else FacetIndex(ifc_path, index_dir, progress)
    try:
        meshes = []
        for product in products:
            meshes.extend(extract_product_facets(index, product, output_dir, progress))
        return meshes
    finally:
        index.close()
        # Index only helps preparation; final cached geometry is self-contained.
        import shutil
        if not existing_index: shutil.rmtree(index_dir)
