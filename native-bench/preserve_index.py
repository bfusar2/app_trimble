"""Preserve the fully populated immutable index before a diagnostic can fail."""
from pathlib import Path
import shutil
import time

root=Path(__file__).resolve().parents[1]/'.ifc-check-v8'
target=root/'facet-index-cache'
start=time.monotonic()
while time.monotonic()-start<600:
    progress=(root/'production-progress.jsonl').read_text(encoding='utf-8')
    raw_files=list((root/'production-cache').glob('.preparing-*/*-triangles.raw'))
    if raw_files or 'Faces explicitas #' in progress:
        choices=list((root/'production-cache').glob('.preparing-*/.facet-index'))
        if len(choices)!=1:
            raise RuntimeError('Expected exactly one preparation index: '+repr(choices))
        if target.exists():
            raise RuntimeError('Preserved index already exists; refuse overwrite')
        shutil.copytree(choices[0],target)
        print('Preserved complete IFC index: '+str(target),flush=True)
        break
    if (root/'production-monitor.json').exists():
        raise RuntimeError('Production finished before checkpoint')
    time.sleep(.1)
else:raise RuntimeError('Timed out waiting for populated IFC index')
