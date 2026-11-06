"""Independent source membership audit; never loads IFC via a geometry reader."""
import json,pathlib,re,time
import numpy as np
here=pathlib.Path(__file__).resolve().parent
source=here.parents[1]/'.ifc-check-v8/model-r3.ifc'
start=time.monotonic()
capacity=17451376
present=np.zeros(capacity,dtype=np.bool_)
references=np.zeros(capacity,dtype=np.uint16)
sets={}
with source.open('rb') as stream:
    for line in stream:
        if b'=IFCFACE(' in line:
            eid=int(line[1:line.index(b'=')]);present[eid]=True
        elif b'=IFCCONNECTEDFACESET(' in line:
            eid=int(line[1:line.index(b'=')])
            ids=np.fromiter((int(m[1]) for m in re.finditer(rb'#(\d+)',line[line.index(b'=')+1:])),dtype=np.int64)
            np.add.at(references,ids,1)
            sets[eid]=len(ids)
unused=np.flatnonzero(present&(references==0))
report={'elapsedSeconds':time.monotonic()-start,'faceCount':int(present.sum()),'faceSetCount':len(sets),'faceReferences':int(references.sum()),'unreferencedFaces':int(len(unused)),'unreferencedFirst':unused[:10].tolist(),'unreferencedLast':unused[-10:].tolist(),'multiplyReferencedFaces':int((present&(references>1)).sum()),'referencesToNonFaces':int(((~present)&(references>0)).sum()),'sets':sets}
(here/'source-audit.results.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!='sets'}))
assert report['faceCount']==3613306 and report['faceSetCount']==89
assert report['multiplyReferencedFaces']==0 and report['referencesToNonFaces']==0
