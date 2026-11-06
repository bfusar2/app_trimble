import pathlib
import tempfile
import unittest

import ifcopenshell
import numpy as np

from faceted import FacetIndex, PointStore, UnsupportedFaceted, prepare_faceted, triangulate_loops


class FacetedTests(unittest.TestCase):
    def test_explicit_repair_adds_intersection_and_reports(self):
        base=np.array([[0,0,0],[2,2,0],[0,2,0],[2,0,0]],dtype=float)
        points=PointStore(base)
        diagnostics={}
        triangles=triangulate_loops(points,[np.arange(4)],repair=True,diagnostics=diagnostics)
        self.assertTrue(diagnostics['repaired'])
        self.assertTrue(points.extra)
        self.assertTrue(any(np.allclose(p,[1,1,0]) for p in points.extra))
        xyz=points[triangles]
        area=np.linalg.norm(np.cross(xyz[:,1]-xyz[:,0],xyz[:,2]-xyz[:,0]),axis=1).sum()/2
        self.assertAlmostEqual(area,2)

    def test_micron_tolerance_retains_original_coordinates(self):
        base=np.array([[0,0,0],[.02,0,0],[.02,.02,3e-8],[0,.02,0]],dtype=float)
        triangles=triangulate_loops(base,[np.arange(4)],tolerance=1e-6)
        self.assertEqual(len(triangles),2)
        self.assertEqual(base[triangles].max(axis=(0,1))[2],3e-8)

    def basic_faceted_model(self):
        f=ifcopenshell.file(schema='IFC4')
        def point(x,y,z=0):return f.create_entity('IfcCartesianPoint',(float(x),float(y),float(z)))
        origin=f.create_entity('IfcAxis2Placement3D',point(0,0,0),None,None)
        context=f.create_entity('IfcGeometricRepresentationContext',None,'Model',3,1e-5,origin,None)
        units=f.create_entity('IfcUnitAssignment',[f.create_entity('IfcSIUnit',None,'LENGTHUNIT','MILLI','METRE')])
        f.create_entity('IfcProject',ifcopenshell.guid.new(),None,'Test',None,None,None,None,[context],units)
        loop=f.create_entity('IfcPolyLoop',[point(0,0),point(1000,0),point(1000,1000),point(0,1000)])
        face=f.create_entity('IfcFace',[f.create_entity('IfcFaceOuterBound',loop,False)])
        cfs=f.create_entity('IfcConnectedFaceSet',[face])
        body=f.create_entity('IfcFaceBasedSurfaceModel',[cfs])
        rep=f.create_entity('IfcShapeRepresentation',context,'Body','SurfaceModel',[body])
        shape=f.create_entity('IfcProductDefinitionShape',None,None,[rep])
        product=f.create_entity('IfcBuildingElementProxy',ifcopenshell.guid.new(),None,'Proxy',None,None,None,shape,None,None)
        return f,product,rep,point

    def test_nested_placement_mapped_rotation_scale_and_orientation(self):
        f,product,source_rep,point=self.basic_faceted_model()
        x=f.create_entity('IfcDirection',(0.,1.,0.))
        y=f.create_entity('IfcDirection',(-1.,0.,0.))
        z=f.create_entity('IfcDirection',(0.,0.,1.))
        map_origin=f.create_entity('IfcAxis2Placement3D',point(100,0),None,None)
        mapping=f.create_entity('IfcRepresentationMap',map_origin,source_rep)
        target=f.create_entity('IfcCartesianTransformationOperator3D',x,y,point(500,1000,2000),2.,z)
        mapped=f.create_entity('IfcMappedItem',mapping,target)
        rep=f.create_entity('IfcShapeRepresentation',source_rep.ContextOfItems,'Body','MappedRepresentation',[mapped])
        product.Representation=f.create_entity('IfcProductDefinitionShape',None,None,[rep])
        parent=f.create_entity('IfcLocalPlacement',None,f.create_entity('IfcAxis2Placement3D',point(1000,0,0),z,x))
        product.ObjectPlacement=f.create_entity('IfcLocalPlacement',parent,f.create_entity('IfcAxis2Placement3D',point(1000,2000,3000),None,None))
        cache=pathlib.Path(__file__).resolve().parents[1]/'.ifc-check-v8'
        with tempfile.TemporaryDirectory(dir=cache) as temp:
            root=pathlib.Path(temp);path=root/'mapped.ifc';f.write(str(path))
            output=prepare_faceted(path,root,model=f)
            self.assertEqual(len(output),1)
            import ifcopenshell.geom
            import ifcopenshell.util.shape
            settings=ifcopenshell.geom.settings();settings.set('use-world-coords',True)
            shape=ifcopenshell.geom.create_shape(settings,product)
            native=ifcopenshell.util.shape.get_vertices(shape.geometry)
            np.testing.assert_allclose(output[0]['min'],native.min(axis=0))
            np.testing.assert_allclose(output[0]['max'],native.max(axis=0))
            np.testing.assert_allclose(output[0]['min'],[-4.2,-.5,5])
            np.testing.assert_allclose(output[0]['max'],[-2.2,1.5,5])
            verts=np.load(root/output[0]['vertices']);faces=np.load(root/output[0]['faces'])
            tri=verts[faces]
            normals=np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0])
            self.assertTrue((normals[:,2]<0).all())
            self.assertAlmostEqual(np.linalg.norm(normals,axis=1).sum()/2,4)

    def test_relational_opening_refuses_before_partial_files(self):
        f,product,rep,point=self.basic_faceted_model()
        opening=f.create_entity('IfcOpeningElement',GlobalId=ifcopenshell.guid.new(),Name='Opening')
        f.create_entity('IfcRelVoidsElement',GlobalId=ifcopenshell.guid.new(),RelatingBuildingElement=product,RelatedOpeningElement=opening)
        cache=pathlib.Path(__file__).resolve().parents[1]/'.ifc-check-v8'
        with tempfile.TemporaryDirectory(dir=cache) as temp:
            root=pathlib.Path(temp);path=root/'opening.ifc';f.write(str(path))
            with self.assertRaisesRegex(UnsupportedFaceted,'aberturas relacionais'):
                prepare_faceted(path,root,model=f)
            self.assertEqual([x.name for x in root.iterdir()],['opening.ifc'])

    def test_invalid_faces_fail(self):
        bowtie=np.array([[0,0,0],[1,1,0],[0,1,0],[1,0,0]],dtype=float)
        with self.assertRaises(ValueError): triangulate_loops(bowtie,[np.arange(4)])
        warped=np.array([[0,0,0],[1,0,0],[1,1,.1],[0,1,0]],dtype=float)
        with self.assertRaises(ValueError): triangulate_loops(warped,[np.arange(4)])

    def test_hole_and_concave_preserve_area(self):
        points = np.array([[0,0,0],[4,0,0],[4,3,0],[0,3,0],[1,1,0],[2,1,0],[2,2,0],[1,2,0]], dtype=float)
        tris = triangulate_loops(points, [np.array([0,1,2,3]), np.array([4,5,6,7])])
        coords = points[tris]
        area = np.linalg.norm(np.cross(coords[:,1]-coords[:,0],coords[:,2]-coords[:,0]),axis=1).sum()/2
        self.assertAlmostEqual(area, 11)
        center = coords.mean(axis=1)
        self.assertFalse(((center[:,0]>1)&(center[:,0]<2)&(center[:,1]>1)&(center[:,1]<2)).any())
        concave = np.array([[0,0,0],[2,0,0],[2,1,0],[1,1,0],[1,2,0],[0,2,0]],dtype=float)
        t = triangulate_loops(concave,[np.arange(6)])
        xyz = concave[t]
        self.assertAlmostEqual(np.linalg.norm(np.cross(xyz[:,1]-xyz[:,0],xyz[:,2]-xyz[:,0]),axis=1).sum()/2,3)

    def test_complete_ifc_hole_placement_mm(self):
        f=ifcopenshell.file(schema='IFC4')
        def point(x,y,z=0): return f.create_entity('IfcCartesianPoint',(float(x),float(y),float(z)))
        axis=f.create_entity('IfcAxis2Placement3D',point(1000,2000,3000),None,None)
        placement=f.create_entity('IfcLocalPlacement',None,axis)
        context=f.create_entity('IfcGeometricRepresentationContext',None,'Model',3,1e-5,f.create_entity('IfcAxis2Placement3D',point(0,0,0),None,None),None)
        unit=f.create_entity('IfcSIUnit',None,'LENGTHUNIT','MILLI','METRE')
        units=f.create_entity('IfcUnitAssignment',[unit])
        f.create_entity('IfcProject',ifcopenshell.guid.new(),None,'Test',None,None,None,None,[context],units)
        outer=f.create_entity('IfcPolyLoop',[point(0,0),point(4000,0),point(4000,3000),point(0,3000)])
        inner=f.create_entity('IfcPolyLoop',[point(1000,1000),point(2000,1000),point(2000,2000),point(1000,2000)])
        face=f.create_entity('IfcFace',[f.create_entity('IfcFaceOuterBound',outer,True),f.create_entity('IfcFaceBound',inner,True)])
        cfs=f.create_entity('IfcConnectedFaceSet',[face])
        body=f.create_entity('IfcFaceBasedSurfaceModel',[cfs])
        rep=f.create_entity('IfcShapeRepresentation',context,'Body','SurfaceModel',[body])
        shape=f.create_entity('IfcProductDefinitionShape',None,None,[rep])
        product=f.create_entity('IfcBuildingElementProxy',ifcopenshell.guid.new(),None,'Proxy',None,None,placement,shape,None,None)
        cache=pathlib.Path(__file__).resolve().parents[1]/'.ifc-check-v8'
        with tempfile.TemporaryDirectory(dir=cache) as temp:
            root=pathlib.Path(temp)
            path=root/'test.ifc'; path.write_text(f.to_string(),encoding='utf-8')
            output=prepare_faceted(path,root,model=f)
            self.assertEqual(len(output),1)
            mesh=output[0]
            self.assertEqual(mesh['sourceFaceCount'],1)
            self.assertEqual(mesh['min'],[1,2,3]); self.assertEqual(mesh['max'],[5,5,3])
            points=np.load(root/mesh['vertices']); triangles=np.load(root/mesh['faces'])
            coords=points[triangles]
            area=np.linalg.norm(np.cross(coords[:,1]-coords[:,0],coords[:,2]-coords[:,0]),axis=1).sum()/2
            self.assertAlmostEqual(area,11)
            self.assertFalse((root/'.facet-index').exists())


if __name__=='__main__': unittest.main()
