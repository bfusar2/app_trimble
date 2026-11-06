import json,pathlib,sys,time
here=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(here.parents[1]/'companion'))
from faceted import prepare_faceted
source=here.parents[1]/'.ifc-check-v8/model-r3.ifc'
out=here.parents[1]/'.ifc-check-v8/facets-heavy'
out.mkdir(exist_ok=True)
start=time.monotonic()
meshes=prepare_faceted(source,out,lambda message:print(round(time.monotonic()-start,1),message,flush=True))
report={'elapsedSeconds':time.monotonic()-start,'sourceFaces':sum(m['sourceFaceCount'] for m in meshes),'triangleCount':sum(m['triangleCount'] for m in meshes),'vertexCount':sum(m['vertexCount'] for m in meshes),'meshCount':len(meshes),'meshes':meshes}
(here/'facet-heavy.results.json').write_text(json.dumps(report,indent=2))
(out/'mesh-report.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!='meshes'}))
