import json,pathlib,re,sys
import numpy as np
here=pathlib.Path(__file__).resolve().parent
root=here.parents[1]
sys.path.insert(0,str(root/'companion'))
from faceted import FacetIndex,triangulate_loops
import shapely
source=root/'.ifc-check-v8/model-r3.ifc'
folder=pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else next((root/'.ifc-check-v8/production-cache').glob('.preparing-*/.facet-index'))
index=FacetIndex.__new__(FacetIndex);index.path=source;index.folder=folder
for key,name in [('offsets','offsets.npy'),('lengths','lengths.npy'),('points','points.npy'),('is_point','is-point.npy')]: setattr(index,key,np.load(folder/name,mmap_mode='r'))
index.stream=source.open('rb')
with source.open('rb') as stream:
 for line in stream:
  if line.startswith(b'#16965522='):
   allids=np.fromiter((int(m[1]) for m in re.finditer(rb'#(\d+)',line[line.index(b'=')+1:])),dtype=np.int64);break
errors=[]; checked=0
for position in range(2900000,min(3000000,len(allids))):
 eid=int(allids[position])
 if not index.lengths[eid]:
  print(json.dumps({'notYetIndexed':eid,'position':position}));break
 rings=index.face_loops(eid)
 try: triangulate_loops(index.points,rings)
 except Exception as error:
  coords=[np.asarray(index.points[ring]) for ring in rings]
  shifted=coords[0]-coords[0][0];normal=np.sum(np.cross(shifted,np.roll(shifted,-1,axis=0)),axis=0);axis=int(np.argmax(np.abs(normal)));keep=[i for i in range(3) if i!=axis]
  polygon=shapely.Polygon(coords[0][:,keep],[c[:,keep] for c in coords[1:]])
  item={'faceID':eid,'position':position,'error':str(error),'validity':shapely.is_valid_reason(polygon),'ringIDs':[ring.tolist() for ring in rings],'coords':[c.tolist() for c in coords],'fixedType':shapely.make_valid(polygon).geom_type}
  errors.append(item);print(json.dumps({k:v for k,v in item.items() if k not in ['coords','ringIDs']}))
  if len(errors)>=20:break
 checked+=1
(here/'debug-faces.results.json').write_text(json.dumps({'checked':checked,'errors':errors},indent=2))
