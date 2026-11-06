param(
    [string]$Python = "python",
    [switch]$Zip
)
$ErrorActionPreference = "Stop"
$companionRoot = $PSScriptRoot
$deps = Join-Path $companionRoot ".build-deps"
$build = Join-Path $companionRoot "build"
$dist = Join-Path $companionRoot "dist"
$pipTemp = Join-Path $build "pip-temp"
New-Item -ItemType Directory -Force -Path $pipTemp | Out-Null
$previousTemp, $previousTmp, $previousPythonPath = $env:TEMP, $env:TMP, $env:PYTHONPATH
try {
    $env:TEMP = $pipTemp
    $env:TMP = $pipTemp
    # Build tools stay inside the checkout; application dependencies use requirements.txt.
    if (-not (Test-Path (Join-Path $deps 'pyinstaller-6.22.3.dist-info'))) {
        & $Python -m pip install --no-cache-dir --target $deps "pyinstaller==6.22.3"
        if ($LASTEXITCODE -ne 0) { throw "Falha ao preparar o empacotador." }
    }
    $env:PYTHONPATH = $deps
    & $Python -m PyInstaller --noconfirm --windowed --onedir --name CorteDXFLocal `
        --distpath $dist --workpath (Join-Path $build "pyinstaller") --specpath $build `
        --paths $companionRoot --hidden-import runner --hidden-import geometry --hidden-import drawing --hidden-import faceted `
        --collect-all ifcopenshell --collect-all shapely --copy-metadata ezdxf --copy-metadata numpy `
        --exclude-module matplotlib --exclude-module scipy --exclude-module pandas `
        --exclude-module torch --exclude-module cv2 --exclude-module PySide6 `
        --exclude-module PyQt6 --exclude-module PyQt5 --exclude-module IPython `
        --exclude-module pytest (Join-Path $companionRoot "helper.py")
    if ($LASTEXITCODE -ne 0) { throw "Falha ao gerar o aplicativo Windows." }
    $bundle = Join-Path $dist "CorteDXFLocal"
    @'
from pathlib import Path
from importlib.metadata import distribution
import shutil, sys
source, bundle = map(Path, sys.argv[1:])
for name in ('README.md', 'THIRD_PARTY_NOTICES.md'):
    shutil.copy2(source/name, bundle/name)
licenses = bundle/'licenses'; licenses.mkdir(exist_ok=True)
for item in (source/'licenses').iterdir():
    if item.is_file(): shutil.copy2(item, licenses/item.name)
for name in ('numpy', 'shapely', 'ezdxf', 'ifcopenshell'):
    package = distribution(name)
    for entry in package.files or []:
        if 'license' not in str(entry).lower() and 'copying' not in str(entry).lower(): continue
        original = Path(package.locate_file(entry))
        if not original.is_file(): continue
        relative = Path(str(entry))
        if '..' in relative.parts: continue
        target = licenses/name/relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target)
python_license = Path(sys.base_prefix)/'LICENSE.txt'
if python_license.is_file(): shutil.copy2(python_license, licenses/'PYTHON-LICENSE.txt')
application = bundle/'source'; application.mkdir(exist_ok=True)
for item in source.glob('*.py'): shutil.copy2(item, application/item.name)
for name in ('build.ps1', 'requirements.txt', 'README.md', 'THIRD_PARTY_NOTICES.md'):
    shutil.copy2(source/name, application/name)
shutil.copytree(source/'licenses', application/'licenses', dirs_exist_ok=True)
'@ | & $Python - $companionRoot $bundle
    if ($LASTEXITCODE -ne 0) { throw "Falha ao incluir fontes e licencas." }
    if ($Zip) {
        $zipPath = Join-Path $dist "CorteDXFLocal-Windows-x64.zip"
        Compress-Archive -LiteralPath (Join-Path $dist "CorteDXFLocal") -DestinationPath $zipPath -Force
        Write-Output $zipPath
    }
    Write-Output (Join-Path $dist "CorteDXFLocal\CorteDXFLocal.exe")
} finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    $env:PYTHONPATH = $previousPythonPath
}
