"""End-to-end IFC -> DXF/partial report/cache integration checks."""
from pathlib import Path
import copy
import json
import sys
import tempfile
import unittest

import ezdxf
import ifcopenshell
import ifcopenshell.guid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'companion'))
from runner import run
from geometry import prepare


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='native-runner-',dir=ROOT/'.ifc-check-v8')
        self.folder=Path(self.temp.name)
        self.fixture=ROOT/'test'/'teste.ifc'
        self.cache=self.folder/'cache'
        self.job={'schema':'corte-dxf-job','version':1,
                  'drawing':{'point':[0,0,1.5],'normal':[0,0,1],'depth':2,
                             'direction':-1,'units':'mm','grid':False,'hatching':True},
                  'models':[{'id':'good','name':'teste.ifc'}]}

    def tearDown(self):
        self.temp.cleanup()

    def generate(self,job=None,paths=None,confirmed=True,name='drawing.dxf'):
        return run(job or self.job, paths or {'good':str(self.fixture)},
                   self.folder/name,self.cache,confirmed_ifc=confirmed,progress=lambda _:None)

    def test_real_ifc_output_audit_and_cache_reuse(self):
        output,report=self.generate()
        doc=ezdxf.readfile(output)
        self.assertTrue(len(doc.modelspace()))
        self.assertEqual(len(doc.audit().errors),0)
        self.assertEqual(doc.units,4)
        self.assertEqual(len(report['models']),1)
        self.assertFalse(report['models'][0]['cacheHit'])
        second,report2=self.generate(name='second.dxf')
        self.assertTrue(report2['models'][0]['cacheHit'])
        self.assertEqual(report2['models'][0]['sha256'],report['models'][0]['sha256'])
        self.assertEqual(len(ezdxf.readfile(second).modelspace()),len(doc.modelspace()))

    def test_bad_middle_file_yields_good_partial(self):
        bad=self.folder/'bad.ifc';bad.write_text('not an IFC',encoding='utf-8')
        job=copy.deepcopy(self.job)
        job['models']=[{'id':'good','name':'good-one.ifc'}, {'id':'bad','name':'broken.ifc'}, {'id':'third','name':'good-two.ifc'}]
        output,report=self.generate(job,{'good':str(self.fixture),'bad':str(bad),'third':str(self.fixture)})
        self.assertTrue(output.stem.endswith('_parcial'))
        self.assertEqual(len(report['models']),2,report)
        self.assertEqual([x['model'] for x in report['omitted']],['broken.ifc'])
        self.assertEqual(len(ezdxf.readfile(output).audit().errors),0)
        self.assertEqual(json.loads(output.with_suffix('.relatorio.json').read_text(encoding='utf-8'))['omitted'],report['omitted'])

    def test_empty_selection_refuses_empty_dxf(self):
        job=copy.deepcopy(self.job);job['models'][0]['selectedGuids']=[]
        with self.assertRaisesRegex(RuntimeError,'Nenhuma linha'):
            self.generate(job)
        self.assertFalse((self.folder/'drawing.dxf').exists())

    def test_unverified_alignment_refuses_output(self):
        with self.assertRaisesRegex(RuntimeError,'Nenhum IFC processado'):
            self.generate(confirmed=False)
        report=json.loads((self.folder/'drawing_parcial.relatorio.json').read_text(encoding='utf-8'))
        self.assertIn('Alinhamento nao verificavel',report['omitted'][0]['reason'])
        self.assertFalse((self.folder/'drawing_parcial.dxf').exists())

    def test_verified_alignment_uses_millimetre_viewer_boxes(self):
        manifest=prepare(self.fixture,self.cache)
        job=copy.deepcopy(self.job)
        job['models'][0]['referenceObjects']=[{'guid':m['guid'],'boundingBox':{'min':[1000*x for x in m['min']],'max':[1000*x for x in m['max']]}} for m in manifest['meshes']]
        output,report=self.generate(job,confirmed=False)
        self.assertEqual(len(report['omitted']),0)
        self.assertGreater(len(ezdxf.readfile(output).modelspace()),0)

    def test_actual_ifc_grid_survives_export(self):
        model=ifcopenshell.open(str(self.fixture))
        def axis(name,coordinates):
            points=[model.create_entity('IfcCartesianPoint',Coordinates=tuple(map(float,p))) for p in coordinates]
            curve=model.create_entity('IfcPolyline',Points=points)
            return model.create_entity('IfcGridAxis',AxisTag=name,AxisCurve=curve,SameSense=True)
        model.create_entity('IfcGrid',GlobalId=ifcopenshell.guid.new(),Name='Test grid',UAxes=[axis('A',[(0,0,0),(10,0,0)])],VAxes=[axis('1',[(0,0,0),(0,10,0)])])
        source=self.folder/'grid.ifc';model.write(str(source))
        job=copy.deepcopy(self.job);job['drawing']['grid']=True
        output,_=self.generate(job,{'good':str(source)})
        doc=ezdxf.readfile(output)
        grid=[x for x in doc.modelspace() if x.dxf.layer=='EIXOS']
        self.assertGreaterEqual(len(grid),4)
        self.assertEqual({x.dxf.text for x in grid if x.dxftype()=='TEXT'},{'A','1'})
        self.assertEqual(len(doc.audit().errors),0)
        # A dedicated axis-only IFC is also a valid drawing source.
        for product in model.by_type('IfcProduct'):
            if not product.is_a('IfcGrid'):
                product.Representation=None
        model.write(str(self.folder/'grid-only.ifc'))
        output,_=self.generate(job,{'good':str(self.folder/'grid-only.ifc')},name='only-grid.dxf')
        doc=ezdxf.readfile(output)
        self.assertEqual({x.dxf.layer for x in doc.modelspace()},{'EIXOS'})


if __name__=='__main__':unittest.main()
