"""Measure the early strict planarity failure using a preserved read-only index."""
from pathlib import Path
import json
import sys
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'companion'))
from faceted import FacetIndex, _refs

folder=ROOT/'.ifc-check-v8/facet-index-cache'
index=FacetIndex.__new__(FacetIndex);index.path=ROOT/'.ifc-check-v8/model-r3.ifc';index.folder=folder
for key,name in [('offsets','offsets.npy'),('lengths','lengths.npy'),('points','points.npy'),('is_point','is-point.npy')]:setattr(index,key,np.load(folder/name,mmap_mode='r'))
index.stream=index.path.open('rb')
failures=[];maximum=0.;checked=0
try:
    for face_id in _refs(index.read(16965522)):
        rings=index.face_loops(face_id)
        xyz=index.points[rings[0]];shift=xyz-xyz[0]
        n=np.sum(np.cross(shift,np.roll(shift,-1,axis=0)),axis=0);length=np.linalg.norm(n)
        if length<1e-15:continue
        residual=max(np.abs((index.points[ring]-xyz[0])@(n/length)).max(initial=0) for ring in rings)
        maximum=max(maximum,float(residual))
        tolerance=max(1e-7,np.ptp(xyz,axis=0).max()*1e-7)
        if residual>tolerance:
            failures.append({'faceID':face_id,'index':checked,'residualRaw':float(residual),'oldToleranceRaw':float(tolerance),'vertexCounts':[len(r) for r in rings]})
        checked+=1
        if checked>=100000:break
    result={'checked':checked,'maximumResidualRaw':maximum,'failureCount':len(failures),'firstFailures':failures[:10]}
    (ROOT/'.ifc-check-v8/planarity-summary.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))
finally:index.close()
