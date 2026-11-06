"""Run the unmodified production preparer against the real local heavy IFC."""
import json
from pathlib import Path
import subprocess
import sys
import time
import ctypes
from ctypes import wintypes

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
OUT=ROOT/'.ifc-check-v8'
NAME='production-fresh' if '--fresh' in sys.argv else 'production'

if '--worker' in sys.argv:
    from companion.geometry import prepare
    started=time.perf_counter()
    def progress(message):
        print(json.dumps({'elapsed':round(time.perf_counter()-started,3),'message':message}),flush=True)
    existing_index=OUT/'facet-index-cache' if '--index' in sys.argv else None
    manifest=prepare(OUT/'model-r3.ifc',OUT/(NAME+'-cache'),progress,existing_index=existing_index)
    (OUT/(NAME+'-metadata.json')).write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    print(json.dumps({'complete':True,'elapsed':time.perf_counter()-started,'cachePath':manifest['cachePath'],'meshes':len(manifest['meshes']),'faces':sum(x.get('sourceFaceCount',0) for x in manifest['meshes']),'triangles':sum(x['triangleCount'] for x in manifest['meshes'])}),flush=True)
else:
    from benchmark import ProcessMemory
    start=time.perf_counter();peak=0;reason=None
    with (OUT/(NAME+'-progress.jsonl')).open('w',encoding='utf-8') as log:
        flags=(['--index'] if '--index' in sys.argv else [])+(['--fresh'] if '--fresh' in sys.argv else [])
        p=subprocess.Popen([sys.executable,__file__,'--worker']+flags,stdout=log,stderr=subprocess.STDOUT)
        kernel=ctypes.windll.kernel32;kernel.OpenProcess.restype=wintypes.HANDLE
        handle=kernel.OpenProcess(0x0410,False,p.pid)
        try:
            while p.poll() is None:
                mem=ProcessMemory();mem.cb=ctypes.sizeof(mem)
                ctypes.windll.psapi.GetProcessMemoryInfo(handle,ctypes.byref(mem),mem.cb)
                peak=max(peak,mem.WorkingSetSize)
                if mem.WorkingSetSize>24*2**30:reason='memory_limit';p.kill();break
                if time.perf_counter()-start>1200:reason='timeout';p.kill();break
                time.sleep(.5)
            p.wait()
        finally:kernel.CloseHandle(handle)
    result={'exit_code':p.returncode,'reason':reason,'elapsedSeconds':round(time.perf_counter()-start,3),'peakRssGiB':round(peak/2**30,3)}
    (OUT/(NAME+'-monitor.json')).write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))
