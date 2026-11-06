# Third-party software

Corte DXF Local uses the following unmodified libraries. Their authors retain
their copyrights. Full license texts shipped by the installed distributions
are copied to `licenses/` and may also be present under `_internal/*.dist-info/`.

| Library | Version | License | Upstream/source |
|---|---|---|---|
| IfcOpenShell | 0.9.0.post1 | LGPL-3.0-or-later | https://github.com/IfcOpenShell/IfcOpenShell |
| NumPy | 2.5.2 | BSD-3-Clause and bundled component licenses | https://github.com/numpy/numpy |
| Shapely | 2.2.0 | BSD-3-Clause; bundled GEOS license included | https://github.com/shapely/shapely |
| ezdxf | 1.4.5 | MIT | https://github.com/mozman/ezdxf |
| Python | Build-dependent; see runtime license | Python Software Foundation license | https://www.python.org/downloads/source/ |

IfcOpenShell is dynamically loaded from the `_internal/ifcopenshell` directory.
The LGPL and GPL license texts accompanying it are in `licenses/`. Application
Python source and the build script are included in `source/`; the public source
repository is https://github.com/bfusar2/app_trimble/tree/main/companion.
The application source can be run with a compatible modified library or rebuilt
using `requirements.txt` and `build.ps1`. Keep compatible native DLL dependencies
together when replacing a library. Modification/reverse engineering necessary
to debug such library modifications is not restricted by this distribution.

PyInstaller is the build tool, not the IFC processing engine:
https://github.com/pyinstaller/pyinstaller (GPL with bootloader exception).

No Trimble SDK or proprietary model files are bundled. Trimble Connect is an
external service. This application is independent of Trimble.
