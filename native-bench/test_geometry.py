import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from companion.geometry import prepare

FIXTURE = pathlib.Path(__file__).resolve().parents[1] / "test" / "teste.ifc"
TEMP_ROOT = pathlib.Path(__file__).resolve().parents[1] / ".ifc-check-v8"


class GeometryTests(unittest.TestCase):
    def test_cache_and_meshes(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            first = prepare(FIXTURE, folder)
            self.assertFalse(first["cacheHit"])
            self.assertEqual(len(first["meshes"]), 4)
            bounds = []
            for mesh in first["meshes"]:
                vertices = np.load(pathlib.Path(first["cachePath"]) / mesh["vertices"], mmap_mode="r")
                faces = np.load(pathlib.Path(first["cachePath"]) / mesh["faces"], mmap_mode="r")
                self.assertEqual(vertices.dtype, np.float64)
                self.assertEqual(faces.dtype, np.int32)
                self.assertEqual(vertices.shape[1], 3)
                self.assertEqual(faces.shape[1], 3)
                self.assertLess(faces.max(), len(vertices))
                np.testing.assert_allclose(vertices.min(axis=0), mesh["min"])
                bounds.append(vertices.max(axis=0))
                del vertices, faces
            self.assertLess(np.max(bounds), 100)  # fixture is metres, not mm
            with patch("companion.geometry.ifcopenshell.open", side_effect=AssertionError("cache must avoid reader")):
                second = prepare(FIXTURE, folder)
            self.assertTrue(second["cacheHit"])

    def test_geometry_failure_never_commits_partial_manifest(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            with patch("companion.geometry.ifcopenshell.geom.create_shape", side_effect=ValueError("fault")):
                with self.assertRaisesRegex(RuntimeError,"Falha na geometria"):
                    prepare(FIXTURE, folder)
            self.assertEqual(list(pathlib.Path(folder).iterdir()), [])

    def test_error_log_cannot_silently_omit_geometry(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            with patch("companion.geometry.ifcopenshell.get_log", return_value="[Error] Failed to process shape"):
                with self.assertRaisesRegex(RuntimeError,"perda de geometria"):
                    prepare(FIXTURE, folder)
            self.assertEqual(list(pathlib.Path(folder).iterdir()), [])

    def test_source_revision_gets_new_cache(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as folder:
            root = pathlib.Path(folder)
            source = root / "source.ifc"
            source.write_bytes(FIXTURE.read_bytes())
            first = prepare(source, root / "cache")
            source.write_bytes(source.read_bytes().replace(b"IFCPROJECT",b"IFCPROJECT",1)+b"\n")
            second = prepare(source, root / "cache")
            self.assertNotEqual(first["source"]["sha256"], second["source"]["sha256"])
            self.assertFalse(second["cacheHit"])


if __name__ == "__main__":
    unittest.main()
