from pathlib import Path
from collections import Counter
counts = Counter()
samples = {}
with Path('.ifc-check-v8/model-r3.ifc').open('rb') as source:
    for line in source:
        if b'=IFC' in line:
            kind = line.split(b'=',1)[1].split(b'(',1)[0]
            counts[kind] += 1
            if kind not in samples:
                samples[kind] = line[:180].decode('ascii','replace')
print(counts.most_common(15))
print('\n'.join(samples[t] for t in [b'IFCCARTESIANPOINT',b'IFCPOLYLOOP',b'IFCFACEOUTERBOUND',b'IFCFACE',b'IFCCONNECTEDFACESET',b'IFCFACEBASEDSURFACEMODEL',b'IFCMAPPEDITEM',b'IFCSHAPEREPRESENTATION'] if t in samples))
