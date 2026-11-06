"""Independent mmap audit of production geometry against source CFS membership."""
import hashlib,json,pathlib,sys,time
import numpy as np

here=pathlib.Path(__file__).resolve().parent
root=here.parents[1]
meta=pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else root/'.ifc-check-v8/production-metadata.json'
manifest=json.loads(meta.read_text(encoding='utf-8'))
folder=pathlib.Path(manifest['cachePath'])
source=json.loads((here/'source-audit.results.json').read_text())
expected={int(key):value for key,value in source['sets'].items()}
start=time.monotonic();actual={};triangles=0;vertices=0;zero_area=0;repairs=0;max_deviation=0.;details=[]
for mesh in manifest['meshes']:
    eid=mesh['faceSetID']
    assert eid not in actual,'duplicate emitted source face set'
    actual[eid]=mesh['sourceFaceCount']
    assert mesh['sourceFaceCount']==mesh['expectedFaceCount']==expected[eid]
    xyz=np.load(folder/mesh['vertices'],mmap_mode='r');faces=np.load(folder/mesh['faces'],mmap_mode='r')
    assert xyz.ndim==2 and xyz.shape[1]==3 and faces.ndim==2 and faces.shape[1]==3
    assert len(xyz)==mesh['vertexCount'] and len(faces)==mesh['triangleCount']
    lo=np.full(3,np.inf);hi=np.full(3,-np.inf)
    for offset in range(0,len(xyz),100000):
        chunk=xyz[offset:offset+100000]
        assert np.isfinite(chunk).all(),'invalid coordinates'
        lo=np.minimum(lo,chunk.min(axis=0));hi=np.maximum(hi,chunk.max(axis=0))
    assert np.allclose(lo,mesh['min'],rtol=0,atol=1e-10)
    assert np.allclose(hi,mesh['max'],rtol=0,atol=1e-10)
    for offset in range(0,len(faces),100000):
        chunk=faces[offset:offset+100000]
        assert chunk.min()>=0 and chunk.max()<len(xyz),'face references invalid vertex'
        tri=xyz[chunk]
        area=np.linalg.norm(np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]),axis=1)/2
        zero_area+=int((area<1e-20).sum())
    details.append({'faceSetID':eid,'vertices':len(xyz),'triangles':len(faces),'sourceFaceCount':mesh['sourceFaceCount'],'repairedFaces':mesh.get('repairedFaceCount',0)})
    vertices+=len(xyz);triangles+=len(faces);repairs+=mesh.get('repairedFaceCount',0)
    max_deviation=max(max_deviation,mesh.get('maxPlanarityDeviationM',0))
assert actual==expected,'emitted face set coverage differs from independent source audit'
assert len(actual)==89 and sum(actual.values())==3532354
assert {mesh['expressID'] for mesh in manifest['meshes']}=={17451367}
report={'elapsedSeconds':time.monotonic()-start,'meshCount':len(actual),'sourceFaceCount':sum(actual.values()),'vertexCount':vertices,'triangleCount':triangles,'zeroAreaOutputTriangles':zero_area,'repairedFaceCount':repairs,'maxPlanarityDeviationM':max_deviation,'sourceSha256':manifest['source']['sha256'],'details':details}
(here/'prepared-audit.results.json').write_text(json.dumps(report,indent=2))
print(json.dumps({key:value for key,value in report.items() if key!='details'}))
