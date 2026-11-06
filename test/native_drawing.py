"""Independent geometry expectations for the native drawing engine.

Run: python test/native_drawing.py. No project IFCs are required.
"""
import sys
from pathlib import Path
import tempfile
import unittest
import math
import numpy as np
import ezdxf
import shapely
from shapely.geometry import MultiLineString, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'companion'))
from companion.drawing import basis, intersect, projection, draw_model, new_document
from runner import alignment


VERTS = np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0],
                  [0,0,1],[1,0,1],[1,1,1],[0,1,1]], dtype=float)
FACES = np.array([[0,2,1],[0,3,2],[4,5,6],[4,6,7],
                  [0,1,5],[0,5,4],[1,2,6],[1,6,5],
                  [2,3,7],[2,7,6],[3,0,4],[3,4,7]], dtype=np.int32)


def mesh(directory, vertices=VERTS, faces=FACES, name="cube", guid="guid"):
    np.save(directory/f'{name}-v.npy', vertices)
    np.save(directory/f'{name}-f.npy', faces)
    return dict(vertices=f'{name}-v.npy', faces=f'{name}-f.npy',
                min=vertices.min(axis=0).tolist(), max=vertices.max(axis=0).tolist(),
                guid=guid, type='IFCWALL')


def linework(doc, layer):
    return [np.array(entity.get_points('xy')) for entity in doc.modelspace().query('LWPOLYLINE')
            if entity.dxf.layer == layer]


def total_length(lines):
    return sum(np.linalg.norm(np.diff(line, axis=0), axis=1).sum() for line in lines)


class DrawingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='native-drawing-', dir=Path(__file__).resolve().parent)
        self.directory = Path(self.temp.name)
        self.manifest = {'meshes': [mesh(self.directory)]}
        self.drawing = dict(point=[0,0,.5], normal=[0,0,1], depth=0,
                            direction=-1, units='m', hatching=False)

    def tearDown(self):
        self.temp.cleanup()

    def draw(self, drawing=None, transform=None, manifest=None):
        params = drawing or self.drawing
        doc = new_document(params.get('units', 'm'))
        stats = draw_model(doc, manifest or self.manifest, self.directory, params,
                           np.eye(4) if transform is None else transform, progress=lambda _: None)
        return doc, stats

    def test_section_square_and_zero_depth(self):
        doc, stats = self.draw()
        lines = linework(doc, 'IFCWALL')
        self.assertAlmostEqual(total_length(lines), 4)
        self.assertEqual(stats['section'], 1)
        self.assertEqual(stats['view'], 0)
        self.assertEqual(len(linework(doc, 'IFCWALL_VISTA')), 0)
        np.testing.assert_allclose(np.vstack(lines).min(axis=0), [0,0])
        np.testing.assert_allclose(np.vstack(lines).max(axis=0), [1,1])

    def test_units_and_roundtrip_audit(self):
        metres, _ = self.draw()
        millimetres, _ = self.draw({**self.drawing, 'units':'mm'})
        self.assertAlmostEqual(total_length(linework(millimetres, 'IFCWALL')),
                               1000*total_length(linework(metres, 'IFCWALL')))
        self.assertEqual(millimetres.units, 4)
        self.assertEqual(metres.units, 6)
        path = self.directory/'roundtrip.dxf'
        millimetres.saveas(path)
        loaded = ezdxf.readfile(path)
        self.assertEqual(len(loaded.audit().errors), 0)
        self.assertAlmostEqual(total_length(linework(loaded, 'IFCWALL')), 4000)

    def test_common_basis_rotation_translation(self):
        angle = math.radians(37)
        matrix = np.array([[math.cos(angle),-math.sin(angle),0,150],
                           [math.sin(angle),math.cos(angle),0,-80],
                           [0,0,1,12],[0,0,0,1]])
        doc, _ = self.draw({**self.drawing, 'point':[150,-80,12.5]}, matrix)
        actual = MultiLineString(linework(doc, 'IFCWALL'))
        expected = np.column_stack([VERTS[:4,:2], np.zeros(4), np.ones(4)]) @ matrix.T
        perimeter = np.vstack([expected[:,:2],expected[0,:2]])
        self.assertLess(actual.hausdorff_distance(shapely.LineString(perimeter)), 2e-5)

    def test_reverse_depth_and_objects_outside_slab(self):
        # Plane above cube: only looking down reaches it, and only if depth is sufficient.
        down, stats = self.draw({**self.drawing, 'point':[0,0,2], 'depth':1.5, 'direction':-1})
        self.assertGreater(len(linework(down, 'IFCWALL_VISTA')), 0)
        self.assertEqual(stats['section'], 0)
        for direction, depth in [(1, 3),(-1,.5)]:
            doc, stats = self.draw({**self.drawing, 'point':[0,0,2], 'depth':depth, 'direction':direction})
            self.assertEqual(stats['view'], 0)
            self.assertEqual(len(doc.modelspace()), 0)

    def test_oblique_intersection_vertices_are_on_plane(self):
        p,n,uv = basis([.5,.5,.5],[1,1,1])
        segments = intersect(VERTS,FACES,p,n,uv)
        # Cube centre diagonal cut is a regular hexagon, side sqrt(1/2).
        geometry = shapely.unary_union(MultiLineString(list(segments)))
        self.assertAlmostEqual(geometry.length, 6*math.sqrt(.5), places=7)

    def test_hatching_preserves_holes_within_one_mesh(self):
        inner = VERTS*np.array([.5,.5,1])+np.array([.25,.25,0])
        hollow = mesh(self.directory, np.vstack([VERTS,inner]), np.vstack([FACES,FACES+len(VERTS)]), name='hollow')
        manifest = {'meshes':[hollow]}
        doc, _ = self.draw({**self.drawing, 'hatching':True}, manifest=manifest)
        hatches = list(doc.modelspace().query('HATCH'))
        self.assertEqual(len(hatches), 1)
        self.assertEqual(len(hatches[0].paths), 2)
        areas = sorted(abs(Polygon(path.vertices).area) for path in hatches[0].paths)
        np.testing.assert_allclose(areas,[.25,1])

    def test_overlapping_meshes_of_same_product_union_hatch(self):
        overlapping = mesh(self.directory, VERTS+np.array([.5,0,0]), name='overlap')
        manifest = {'meshes':[self.manifest['meshes'][0],overlapping]}
        doc, _ = self.draw({**self.drawing,'hatching':True},manifest=manifest)
        areas = []
        for hatch in doc.modelspace().query('HATCH'):
            outer, *holes = hatch.paths
            areas.append(Polygon(outer.vertices,[hole.vertices for hole in holes]).area)
        self.assertAlmostEqual(sum(areas),1.5)

    def test_coplanar_reversed_winding_excludes_diagonal(self):
        vertices = np.array([[0,0,.5],[1,0,.5],[1,1,.5],[0,1,.5]])
        faces = np.array([[0,1,2],[0,3,2]],dtype=np.int32)
        p,n,uv = basis([0,0,0],[0,0,1])
        segments = projection(vertices,faces,p,n,uv,1,1,self.directory/'coplanar.npz')
        self.assertAlmostEqual(shapely.unary_union(MultiLineString(list(segments))).length, 4)

    def test_invalid_plane_and_depth(self):
        with self.assertRaises(ValueError): basis([0,0,0],[0,0,0])
        with self.assertRaises(ValueError): self.draw({**self.drawing,'depth':-1})

    def test_alignment_rotation_translation_m_and_mm(self):
        for angle_degrees in [37,45,90]:
            theta = math.radians(angle_degrees)
            rotation = np.array([[math.cos(theta),-math.sin(theta),0],
                                 [math.sin(theta),math.cos(theta),0],[0,0,1]])
            shift = np.array([150.,-80.,12.])
            for units in [1,1000]:
                meshes, refs = [], []
                for i, offset in enumerate([[0,0,0],[10,0,0],[0,20,0],[10,20,4]]):
                    # Thin plates maximize AABB inflation when rotated 45 degrees.
                    vertices = VERTS*np.array([1,1,.01])+offset
                    projected = (vertices@rotation.T+shift)*units
                    guid = f'guid-{i}'
                    meshes.append(dict(guid=guid,min=vertices.min(axis=0),max=vertices.max(axis=0)))
                    refs.append(dict(guid=guid,boundingBox=dict(min=projected.min(axis=0).tolist(),max=projected.max(axis=0).tolist())))
                actual = alignment({'meshes':meshes},{'referenceObjects':refs})
                np.testing.assert_allclose(actual[:3,:3],rotation,atol=1e-10)
                np.testing.assert_allclose(actual[:3,3],shift,atol=1e-10)

    def test_alignment_single_proxy_requires_confirmation(self):
        item = {'referenceObjects':[dict(guid='guid',boundingBox=dict(min=[0,0,0],max=[1,1,1]))]}
        with self.assertRaisesRegex(ValueError,'menos de tres'):
            alignment(self.manifest,item)
        np.testing.assert_array_equal(alignment(self.manifest,item,confirmed_ifc=True),np.eye(4))

    def test_alignment_collinear_vertical_references_rejected(self):
        meshes = [dict(guid=f'g{i}',min=[0,0,i],max=[1,1,i+1]) for i in range(3)]
        refs = [dict(guid=m['guid'],boundingBox=dict(min=m['min'],max=m['max'])) for m in meshes]
        with self.assertRaisesRegex(ValueError,'separacao horizontal'):
            alignment({'meshes':meshes},{'referenceObjects':refs})


if __name__ == '__main__':
    unittest.main(verbosity=2)
