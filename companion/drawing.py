"""Vector drawing from prepared IFC meshes; all geometry is in project metres.

NumPy bounds temporary triangle arrays; Shapely joins section linework and
constructs even/odd hatch areas; ezdxf writes actual CAD entities.
Projection intentionally retains lines hidden behind other objects.
"""
from pathlib import Path
import math
import numpy as np
import shapely
from shapely.geometry import LineString, MultiLineString, Polygon
import ezdxf

CHUNK = 100_000


def canonical(guid):
    import ifcopenshell.guid
    value = str(guid)
    if len(value) == 22:
        try: return ifcopenshell.guid.expand(value).lower()
        except ValueError: pass
    return value.replace('-', '').replace('{', '').replace('}', '').lower()


def basis(point, normal, mirror=False):
    p, n = np.asarray(point, dtype=float), np.asarray(normal, dtype=float)
    if p.shape != (3,) or n.shape != (3,) or not np.isfinite([p, n]).all() or np.linalg.norm(n) < 1e-9:
        raise ValueError("Plano de corte invalido")
    n = n / np.linalg.norm(n)
    if abs(n[2]) > .9:
        up = n if n[2] >= 0 else -n
        u = np.array([1., 0, 0]) - up * up[0]
        u /= np.linalg.norm(u)
        v = np.cross(up, u)
    else:
        u = np.cross(n, [0, 0, 1.]); u /= np.linalg.norm(u)
        v = np.cross(u, n)
    return p, n, np.array([-u if mirror else u, v])


def intersect(vertices, faces, p, n, uv):
    """Intersect in bounded chunks. Coplanar triangles contribute no fill edges."""
    parts = []
    for start in range(0, len(faces), CHUNK):
        tri = vertices[faces[start:start+CHUNK]]
        d = (tri - p) @ n
        mask = (d.min(axis=1) <= 0) & (d.max(axis=1) >= 0)
        tri, d = tri[mask], d[mask]
        if not len(tri): continue
        points = np.zeros((len(tri), 2, 3))
        counts = np.zeros(len(tri), dtype=np.int8)
        for a, b in ((0, 1), (1, 2), (2, 0)):
            crossing = (d[:, a] > 0) != (d[:, b] > 0)
            ids = np.flatnonzero(crossing)
            t = d[ids, a] / (d[ids, a] - d[ids, b])
            points[ids, counts[ids]] = tri[ids, a] + (tri[ids, b] - tri[ids, a]) * t[:, None]
            counts[ids] += 1
        seg = points[counts == 2] @ uv.T
        seg = seg[np.linalg.norm(seg[:, 1] - seg[:, 0], axis=1) > 1e-8]
        if len(seg): parts.append(seg)
    return np.concatenate(parts) if parts else np.empty((0, 2, 2))


def prepare_edges(vertices, faces, cache_path):
    """Cache sharp/boundary edges and adjacent normals once, independently of view."""
    if cache_path.exists():
        with np.load(cache_path) as data:
            return data['edges'], data['normal_a'], data['normal_b'], data['boundary']
    # Explicit IFC faces may repeat the same coordinate under different IDs.
    # Weld only for adjacency; section intersections retain original precision.
    _, first, inverse = np.unique(np.round(vertices/.00001).astype(np.int64), axis=0,
                                  return_index=True, return_inverse=True)
    welded_faces = inverse[faces].astype(np.uint32)
    normals = np.empty((len(faces), 3))
    valid = np.zeros(len(faces),dtype=bool)
    for start in range(0, len(faces), CHUNK):
        t = vertices[faces[start:start+CHUNK]]
        normal = np.cross(t[:, 1]-t[:, 0], t[:, 2]-t[:, 0])
        length = np.linalg.norm(normal, axis=1)
        valid[start:start+len(t)] = length > 1e-15
        normals[start:start+len(t)] = normal / np.maximum(length[:, None], 1e-30)
    valid &= (welded_faces[:,0]!=welded_faces[:,1]) & (welded_faces[:,1]!=welded_faces[:,2]) & (welded_faces[:,0]!=welded_faces[:,2])
    normals = normals[valid]
    welded_faces = welded_faces[valid]
    if not len(welded_faces):
        return np.empty((0,2),dtype=np.int64),np.empty((0,3)),np.empty((0,3)),np.empty(0,dtype=bool)
    edges = np.concatenate((welded_faces[:, [0, 1]], welded_faces[:, [1, 2]], welded_faces[:, [2, 0]]))
    edges.sort(axis=1)
    owners = np.tile(np.arange(len(welded_faces), dtype=np.int32), 3)
    order = np.lexsort((edges[:, 1], edges[:, 0]))
    edges, owners = edges[order], owners[order]
    starts = np.r_[0, np.flatnonzero(np.any(edges[1:] != edges[:-1], axis=1))+1]
    counts = np.diff(np.r_[starts, len(edges)])
    a = normals[owners[starts]]
    b = normals[owners[starts + np.minimum(counts-1, 1)]]
    boundary = counts != 2
    # Keep smooth pairs too: these may be silhouettes in a later drawing.
    result = (first[edges[starts]], a, b, boundary)
    temp = cache_path.with_suffix('.tmp.npz')
    np.savez(temp, edges=result[0], normal_a=a, normal_b=b, boundary=boundary)
    temp.replace(cache_path)
    return result


def projection(vertices, faces, p, n, uv, depth, direction, edge_path):
    if depth <= 0: return np.empty((0, 2, 2))
    edges, a, b, boundary = prepare_edges(vertices, faces, edge_path)
    alignment = np.abs(np.einsum('ij,ij->i', a, b))
    coplanar = alignment > 1-1e-8
    sharp = alignment < math.cos(math.radians(1))
    silhouette = ((a @ n) > 1e-7) != ((b @ n) > 1e-7)
    chosen = edges[boundary | (~coplanar & (sharp | silhouette))]
    parts = []
    for start in range(0, len(chosen), CHUNK):
        ends = vertices[chosen[start:start+CHUNK]].copy()
        d = direction * ((ends-p) @ n)
        valid = (d.max(axis=1) >= -1e-7) & (d.min(axis=1) <= depth+1e-7)
        ends, d = ends[valid], d[valid]
        for side, limit in ((0, 0.), (1, depth)):
            outside = d < limit if side == 0 else d > limit
            for i, j in ((0, 1), (1, 0)):
                ids = np.flatnonzero(outside[:, i] & ~outside[:, j])
                t = (limit-d[ids, i])/(d[ids, j]-d[ids, i])
                ends[ids, i] += (ends[ids, j]-ends[ids, i])*t[:, None]
                d[ids, i] = limit
        seg = ends @ uv.T
        seg = seg[np.linalg.norm(seg[:, 1]-seg[:, 0], axis=1) > 1e-8]
        if len(seg): parts.append(seg)
    # Slab-boundary contours are necessary even where no original edge crosses it.
    parts.extend([intersect(vertices, faces, p, n, uv),
                  intersect(vertices, faces, p+n*direction*depth, n, uv)])
    return np.concatenate(parts) if parts else np.empty((0, 2, 2))


def joined(segments):
    if not len(segments): return []
    rounded = np.round(segments / .00001) * .00001
    geom = shapely.line_merge(shapely.unary_union(shapely.multilinestrings(shapely.linestrings(rounded))))
    return [geom] if geom.geom_type == 'LineString' else list(geom.geoms)


def draw_model(document, manifest, directory, drawing, transform, progress=print):
    p, n, uv = basis(drawing['point'], drawing['normal'], drawing.get('mirror', False))
    depth = float(drawing.get('depth', 0)); direction = drawing.get('direction', -1)
    if not math.isfinite(depth) or depth < 0 or direction not in (-1, 1):
        raise ValueError('Profundidade ou sentido invalido')
    scale = 1000 if drawing.get('units', 'mm') == 'mm' else 1
    matrix = np.asarray(transform, dtype=float)
    r, shift = matrix[:3, :3], matrix[:3, 3]
    # Transform plane/basis rather than copying a multimillion-vertex world mesh.
    ip = np.linalg.solve(r, p-shift)
    inn = r.T @ n; factor = np.linalg.norm(inn); inn /= factor
    iuv = uv @ r
    origin2d = uv @ shift
    selected = drawing.get('selectedGuids')
    selected = None if selected is None else {canonical(g) for g in selected}
    space = document.modelspace()
    stats = dict(elements=0, section=0, view=0, polylines=0)
    hatch_by_guid = {}
    elements,sections,views=set(),set(),set()
    for index, mesh in enumerate(manifest['meshes']):
        if selected is not None and canonical(mesh['guid']) not in selected: continue
        progress(f"Geometria {index+1}/{len(manifest['meshes'])}: {mesh['type']}")
        vertices = np.load(Path(directory)/mesh['vertices'], mmap_mode='r')
        faces = np.load(Path(directory)/mesh['faces'], mmap_mode='r')
        lo, hi = np.array(mesh['min']), np.array(mesh['max'])
        near = np.where(inn >= 0, lo, hi) @ inn - ip @ inn
        far = np.where(inn >= 0, hi, lo) @ inn - ip @ inn
        section = intersect(vertices, faces, ip, inn, iuv) if near <= 0 <= far else np.empty((0,2,2))
        section += origin2d
        inview = depth > 0 and (near*direction if direction>0 else -far) <= depth/factor and (far*direction if direction>0 else -near) >= 0
        view = projection(vertices, faces, ip, inn, iuv, depth/factor, direction,
                          Path(directory)/f'edges-{index}-v3.npz') if inview else np.empty((0,2,2))
        view += origin2d
        if len(section) or len(view): elements.add(mesh['guid'])
        if len(section): sections.add(mesh['guid'])
        if len(view): views.add(mesh['guid'])
        for suffix, segments in (('',section),('_VISTA',view)):
            layer = mesh['type'].upper()+suffix
            if layer not in document.layers: document.layers.new(layer, dxfattribs={'color':8 if suffix else 7})
            lines = joined(segments)
            for line in lines:
                simple = line.simplify(.00001)
                coords = np.asarray(simple.coords)*scale
                if len(coords) >= 2:
                    space.add_lwpolyline(coords, close=simple.is_ring, dxfattribs={'layer':layer})
                    stats['polylines'] += 1
            if not suffix and drawing.get('hatching'):
                hatch_by_guid.setdefault(mesh['guid'], []).append([line for line in lines if line.is_ring])
    if drawing.get('hatching'):
        if 'HACHURA' not in document.layers: document.layers.new('HACHURA', dxfattribs={'color':8})
        for groups in hatch_by_guid.values():
            areas = []
            for rings in groups:
                part = Polygon()
                for ring in rings:
                    polygon = shapely.make_valid(Polygon(ring))
                    part = part.symmetric_difference(polygon)
                areas.append(part)
            area = shapely.unary_union(areas)
            polygons = [area] if area.geom_type == 'Polygon' else getattr(area, 'geoms', [])
            for polygon in polygons:
                if polygon.geom_type != 'Polygon' or polygon.area < 1e-10: continue
                h = space.add_hatch(dxfattribs={'layer':'HACHURA'})
                h.set_pattern_fill('ANSI31', scale=.1*scale)
                h.paths.add_polyline_path(np.asarray(polygon.exterior.coords)*scale, is_closed=True, flags=1)
                for hole in polygon.interiors:
                    h.paths.add_polyline_path(np.asarray(hole.coords)*scale, is_closed=True, flags=0)
    if drawing.get('grid'):
        if manifest.get('gridErrors'):
            raise ValueError('Eixos nao suportados: '+ '; '.join(manifest['gridErrors']))
        if 'EIXOS' not in document.layers: document.layers.new('EIXOS', dxfattribs={'color':2})
        for grid in manifest.get('grids', []):
            if selected is not None and canonical(grid['guid']) not in selected: continue
            points = (np.asarray(grid['points']) @ r.T + shift) @ uv.T * scale
            if len(points) >= 2 and np.linalg.norm(points[-1]-points[0]) > 1e-6:
                space.add_lwpolyline(points, dxfattribs={'layer':'EIXOS'})
                if grid.get('name'):
                    space.add_text(grid['name'], dxfattribs={'height':.15*scale,'layer':'EIXOS','insert':points[-1]})
    stats.update(elements=len(elements),section=len(sections),view=len(views))
    return stats


def new_document(units='mm'):
    doc = ezdxf.new('R2010')
    doc.units = 4 if units == 'mm' else 6
    return doc
