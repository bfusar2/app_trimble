"""Bounded native reader benchmark. Outputs stay in ignored .ifc-check-v8."""
import argparse
import ctypes
import json
import pathlib
import subprocess
import sys
import time
from ctypes import wintypes

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / ".ifc-check-v8"

def worker(args):
    import ifcopenshell
    import ifcopenshell.geom
    import ifcopenshell.util.shape
    import numpy as np
    start = time.perf_counter()
    def report(stage, **kw):
        print(json.dumps(dict(stage=stage, elapsed_s=round(time.perf_counter()-start,3), **kw)), flush=True)
    report("start", version=ifcopenshell.version, size=pathlib.Path(args.path).stat().st_size)
    model = ifcopenshell.open(args.path)
    ifcopenshell.ifcopenshell_wrapper.set_log_format_json()
    products = [model.by_id(args.element)] if args.element else [p for p in model.by_type("IfcProduct") if getattr(p,"Representation",None)]
    report("opened", products=len(products))
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    settings.set("mesher-linear-deflection", 0.001)
    for product in products:
        report("geometry_start", express_id=product.id(), type=product.is_a())
        shape = ifcopenshell.geom.create_shape(settings, product, geometry_library=args.kernel)
        log_text=ifcopenshell.get_log()
        (OUT / "native-ifcopenshell-log.txt").write_text(log_text,encoding="utf-8")
        report("engine_log",chars=len(log_text),preview=log_text[:3000])
        geometry = getattr(shape,"geometry",shape)
        verts = ifcopenshell.util.shape.get_vertices(geometry)
        faces = ifcopenshell.util.shape.get_faces(geometry)
        report("geometry_ready", express_id=product.id(), vertices=len(verts), triangles=len(faces), bounds=[verts.min(axis=0).tolist(),verts.max(axis=0).tolist()])
        np.save(OUT / ("native-vertices-%s.npy" % product.id()), verts)
        np.save(OUT / ("native-faces-%s.npy" % product.id()), faces)
        report("geometry_saved", express_id=product.id())
    report("complete")

class ProcessMemory(ctypes.Structure):
    _fields_ = [("cb",wintypes.DWORD),("PageFaultCount",wintypes.DWORD)] + [(x,ctypes.c_size_t) for x in ["PeakWorkingSetSize","WorkingSetSize","QuotaPeakPagedPoolUsage","QuotaPagedPoolUsage","QuotaPeakNonPagedPoolUsage","QuotaNonPagedPoolUsage","PagefileUsage","PeakPagefileUsage","PrivateUsage"]]

def monitor(args):
    OUT.mkdir(exist_ok=True)
    start=time.perf_counter()
    max_rss=0
    reason=None
    with (OUT / "native-benchmark.jsonl").open("w",encoding="utf-8") as log:
        p=subprocess.Popen([sys.executable,__file__,args.path,"--worker","--kernel",args.kernel,"--element",str(args.element or 0)],stdout=log,stderr=subprocess.STDOUT)
        kernel=ctypes.windll.kernel32
        kernel.OpenProcess.restype=wintypes.HANDLE
        handle=kernel.OpenProcess(0x0410,False,p.pid)
        try:
            while p.poll() is None:
                mem=ProcessMemory();mem.cb=ctypes.sizeof(mem)
                ctypes.windll.psapi.GetProcessMemoryInfo(handle,ctypes.byref(mem),mem.cb)
                max_rss=max(max_rss,mem.WorkingSetSize)
                if mem.WorkingSetSize > args.max_gib*2**30:
                    reason="memory_limit";p.kill();break
                if time.perf_counter()-start>args.timeout:
                    reason="timeout";p.kill();break
                time.sleep(.5)
            p.wait()
        finally:
            kernel.CloseHandle(handle)
    result=dict(exit_code=p.returncode, reason=reason, elapsed_s=round(time.perf_counter()-start,3), peak_rss_gib=round(max_rss/2**30,3))
    (OUT / "native-monitor.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
    print(json.dumps(result))

if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--worker",action="store_true")
    parser.add_argument("--max-gib",type=float,default=8)
    parser.add_argument("--timeout",type=float,default=300)
    parser.add_argument("--kernel",default="opencascade")
    parser.add_argument("--element",type=int,default=0)
    args=parser.parse_args()
    worker(args) if args.worker else monitor(args)
