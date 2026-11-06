"""Prepare IFC geometry once, with an atomic on-disk cache in SI metres.

Requires IfcOpenShell and NumPy. No model content leaves the machine.
Consumers can mmap vertices/faces from the paths relative to ``cachePath``.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import time
import uuid

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.placement
import ifcopenshell.util.shape
import ifcopenshell.util.unit
import numpy as np

SCHEMA = 1
KERNEL = "hybrid-cgal-simple-opencascade"
ENGINE = "ifcopenshell-%s/%s/faceted-v2" % (ifcopenshell.version, KERNEL)
SKIP = {"IfcSpace", "IfcOpeningElement", "IfcOpeningStandardCase", "IfcAnnotation", "IfcVirtualElement", "IfcGrid"}


def _digest(path, progress):
    progress("Verificando a revisao do IFC local...")
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def _grids(model):
    """Straight/polyline grids, retaining per-grid errors for explicit UI handling."""
    factor = ifcopenshell.util.unit.calculate_unit_scale(model)
    output = []
    errors = []
    for grid in model.by_type("IfcGrid"):
        placement = ifcopenshell.util.placement.get_local_placement(grid.ObjectPlacement)
        for axis in [*(grid.UAxes or ()), *(grid.VAxes or ()), *(getattr(grid, "WAxes", None) or ())]:
            curve = axis.AxisCurve
            lines = []
            if curve.is_a("IfcPolyline"):
                lines = [[list(p.Coordinates) for p in curve.Points]]
            elif curve.is_a("IfcIndexedPolyCurve"):
                coords = list(curve.Points.CoordList)
                if not curve.Segments:
                    lines = [coords]
                else:
                    for segment in curve.Segments:
                        if not segment.is_a("IfcLineIndex"):
                            errors.append("Eixo %s: segmento curvo nao suportado" % (axis.AxisTag or axis.id()))
                            continue
                        lines.append([coords[i-1] for i in segment.wrappedValue])
            else:
                errors.append("Eixo %s: curva %s nao suportada" % (axis.AxisTag or axis.id(), curve.is_a()))
                continue
            for line in lines:
                pts = np.array([list(p) + [0.] * (3-len(p)) + [1.] for p in line], dtype=np.float64)
                world = (pts @ placement.T)[:, :3] * factor
                output.append({"name": axis.AxisTag or "", "points": world.tolist(), "guid": grid.GlobalId})
    return output, errors


def _read_cache(folder, digest):
    try:
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        if manifest["schema"] != SCHEMA or manifest["source"]["sha256"] != digest:
            return None
        if manifest["engine"] != ENGINE:
            return None
        if not all((folder / mesh[key]).is_file() for mesh in manifest["meshes"] for key in ("vertices", "faces")):
            return None
        manifest["cachePath"] = str(folder)
        manifest["cacheHit"] = True
        return manifest
    except (OSError, ValueError, KeyError, TypeError):
        return None


def prepare(ifc_path, cache_dir, progress=lambda message: None, existing_index=None):
    """Return manifest with all represented products or raise on geometry loss.

    SHA256 is verified each run so replacing an IFC with another at the same
    pathname can never silently reuse an old mesh. A manifest is committed only
    after every product succeeds. A failed product invalidates that preparation.
    """
    start = time.perf_counter()
    path = pathlib.Path(ifc_path).resolve(strict=True)
    before = path.stat()
    digest = _digest(path, progress)
    after_hash = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after_hash.st_size, after_hash.st_mtime_ns):
        raise RuntimeError("O IFC mudou durante a verificacao. Tente novamente.")
    root = pathlib.Path(cache_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    engine = ENGINE
    # Engine version in key lets valid old caches coexist with a new installation.
    engine_key = hashlib.sha256(engine.encode()).hexdigest()[:12]
    folder = root / (digest + "-" + engine_key)
    cached = _read_cache(folder, digest)
    if cached:
        progress("Geometria reutilizada do cache local.")
        return cached
    temporary = root / (".preparing-" + uuid.uuid4().hex)
    temporary.mkdir()
    try:
        progress("Lendo IFC com IfcOpenShell...")
        model = ifcopenshell.open(str(path))
        settings = ifcopenshell.geom.settings()
        settings.set("use-world-coords", True)
        settings.set("mesher-linear-deflection", .001)
        products = [p for p in model.by_type("IfcProduct") if p.is_a() not in SKIP and getattr(p, "Representation", None)]
        meshes = []
        try:
            from .faceted import prepare_faceted, UnsupportedFaceted
        except ImportError:
            from faceted import prepare_faceted, UnsupportedFaceted
        try:
            meshes = prepare_faceted(path, temporary, progress, model=model, existing_index=existing_index)
            products = []  # Every product was validated before facet extraction.
        except UnsupportedFaceted:
            progress("Modelo parametrico: preparando com o motor geometrico IFC...")
        for index, product in enumerate(products):
            progress("Preparando geometria %s/%s: %s #%s" % (index+1, len(products), product.is_a(), product.id()))
            try:
                ifcopenshell.get_log()  # discard earlier parse/other-product messages
                shape = ifcopenshell.geom.create_shape(settings, product, geometry_library=KERNEL)
                # A successful return can still contain only part of a product.
                # IfcOpenShell records failed subshapes in its log, not always as
                # Python exceptions; never silently cache an incomplete drawing.
                engine_log = ifcopenshell.get_log()
                if "[Error]" in engine_log or '"level":"Error"' in engine_log or '"level": "Error"' in engine_log:
                    raise RuntimeError("O leitor informou perda de geometria: " + engine_log[:1500])
                verts = ifcopenshell.util.shape.get_vertices(shape.geometry)
                faces = ifcopenshell.util.shape.get_faces(shape.geometry)
                if not len(verts) or not len(faces):
                    raise RuntimeError("Geometria vazia")
                if not np.isfinite(verts).all():
                    raise RuntimeError("Coordenadas invalidas")
                vertex_file = "%s-vertices.npy" % product.id()
                face_file = "%s-faces.npy" % product.id()
                np.save(temporary / vertex_file, verts, allow_pickle=False)
                np.save(temporary / face_file, faces, allow_pickle=False)
                meshes.append({"vertices": vertex_file, "faces": face_file, "type": product.is_a().upper(), "guid": product.GlobalId, "expressID": product.id(), "min": verts.min(axis=0).tolist(), "max": verts.max(axis=0).tolist(), "vertexCount": len(verts), "triangleCount": len(faces)})
                del verts, faces, shape
            except Exception as error:
                raise RuntimeError("Falha na geometria %s #%s (%s): %s" % (product.is_a(), product.id(), product.GlobalId, error)) from error
        grids, grid_errors = _grids(model)
        if not meshes and not grids:
            raise RuntimeError("Nenhum produto IFC com geometria ou eixos para desenhar.")
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise RuntimeError("O IFC mudou durante a preparacao. Tente novamente.")
        manifest = {"schema": SCHEMA, "engine": engine, "source": {"sha256": digest, "size": before.st_size, "name": path.name}, "meshes": meshes, "grids": grids, "gridErrors": grid_errors, "elapsedSeconds": round(time.perf_counter()-start, 3)}
        (temporary / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        if folder.exists():
            # Another successful preparation may have committed while we worked.
            cached = _read_cache(folder, digest)
            if cached:
                return cached
            raise RuntimeError("Cache incompleto existente; remova a pasta %s e tente novamente." % folder)
        os.replace(temporary, folder)
        manifest["cachePath"] = str(folder)
        manifest["cacheHit"] = False
        progress("Geometria preparada e salva para os proximos cortes.")
        return manifest
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
