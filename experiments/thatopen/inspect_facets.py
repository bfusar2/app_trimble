import collections,json,re,time
from pathlib import Path
p=Path(__file__).resolve().parents[2]/'.ifc-check-v8/model-r3.ifc'
counts=collections.Counter(); examples={}; sizes=collections.Counter(); samples=[]; maximum=(0,None)
start=time.monotonic()
with p.open('rb') as stream:
 for line in stream:
  m=re.match(rb'#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(',line)
  if not m: continue
  eid=int(m[1]); kind=m[2].decode(); counts[kind]+=1; sizes[kind]+=len(line)
  if len(line)>maximum[0]: maximum=(len(line),eid,kind)
  if kind not in examples: examples[kind]=line[:200].decode(errors='replace')
  if kind in ('IFCFACE','IFCPOLYLOOP','IFCFACEOUTERBOUND','IFCFACEBOUND') and len(samples)<100: samples.append(line[:300].decode())
report={'seconds':time.monotonic()-start,'counts':counts,'sizes':sizes,'examples':examples,'sampleFaces':samples,'maximum':maximum}
Path(__file__).with_name('facets.results.json').write_text(json.dumps(report,indent=2))
print(json.dumps({'seconds':report['seconds'],'counts':counts,'examples':examples,'maximum':maximum}))
