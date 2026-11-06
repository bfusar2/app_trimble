import json, pathlib, subprocess, sys, time
import ctypes
from ctypes import wintypes

class Counters(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD), ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t), ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t), ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t), ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]

def rss(proc):
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    if not ctypes.windll.psapi.GetProcessMemoryInfo(wintypes.HANDLE(int(proc._handle)), ctypes.byref(counters), counters.cb):
        return 0
    return counters.WorkingSetSize

here = pathlib.Path(__file__).resolve().parent
started = time.monotonic()
facet = len(sys.argv) > 1
log_path = here / ('facet-heavy.results.log' if facet else 'heavy.results.log')
with log_path.open('w', encoding='utf-8') as log:
    command = sys.argv[1:] if facet else ['node', '--max-old-space-size=6144', 'probe.mjs', '../../.ifc-check-v8/model-r3.ifc', 'heavy.frag']
    proc = subprocess.Popen(command, cwd=here, stdout=log, stderr=subprocess.STDOUT)
    peak = 0
    reason = None
    while proc.poll() is None:
        try:
            usage = rss(proc)
            peak = max(peak, usage)
            if usage > (18 if facet else 8) * 1024**3:
                reason = 'RSS exceeded safety budget'
            if time.monotonic() - started > (1200 if facet else 180):
                reason = 'timeout'
            if reason:
                proc.terminate()
                break
        except ProcessLookupError:
            break
        time.sleep(.1)
    proc.wait()
report = {'exitCode': proc.returncode, 'elapsedSeconds': time.monotonic() - started, 'peakRssBytes': peak, 'stoppedReason': reason}
(here / ('facet-heavy-monitor.results.json' if facet else 'heavy-monitor.results.json')).write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
print(log_path.read_text(encoding='utf-8')[-6000:])
