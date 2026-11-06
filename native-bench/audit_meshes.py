"""Independent cached-array integrity audit; no source model is published."""
from pathlib import Path
import json
import numpy as np

root=Path(__file__).resolve().parents[1]/'.ifc-check-v8'
manifest=json.loads((root/'production-metadata.json').read_text(encoding='utf-8'))
folder=Path(manifest['cachePath'])
total=0
for mesh in manifest['meshes']:
    vertices=np.load(folder/mesh['vertices'],mmap_mode='r')
    faces=np.load(folder/mesh['faces'],mmap_mode='r')
    assert np.isfinite(vertices).all()
    assert faces.min()>=0 and faces.max()<len(vertices)
    assert len(faces)==mesh['triangleCount']
    assert mesh['sourceFaceCount']==mesh['expectedFaceCount']
    np.testing.assert_allclose(vertices.min(axis=0),mesh['min'])
    np.testing.assert_allclose(vertices.max(axis=0),mesh['max'])
    total+=len(faces)
result={'validMeshes':len(manifest['meshes']),'validTriangles':total,'sourceFaces':sum(m['sourceFaceCount'] for m in manifest['meshes'])}
(root/'production-array-audit.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result))
